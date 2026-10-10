const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

function loadModule(relativePath) {
  const target = compiledPath(relativePath);
  delete require.cache[target];
  return require(target);
}

// 按调用序返回 { body, status } 的 fetchSigned 桩；记录每次 command/init 供断言。
// 必须先加载并改写 r2SignedRequests，再加载 r2Multipart，使二者共享同一模块实例。
function mockFetchSigned(responses) {
  const signed = loadModule("services/r2SignedRequests.js");
  const calls = [];
  signed.fetchSigned = async (_client, command, init) => {
    const index = calls.length;
    calls.push({ command, init, input: command.input, method: init.method });
    const spec =
      typeof responses === "function"
        ? responses(index, command, init)
        : responses[index];
    const { body = "", status = 200 } = spec || {};
    // 204/304 等 null-body 状态不能携带 body，否则 Response 构造报错
    const nullBodyStatus = status === 204 || status === 205 || status === 304;
    return new Response(nullBodyStatus ? null : body, { status });
  };
  return { signed, calls };
}

const CONFIG = {
  endpoint: "https://example.com",
  accessKeyId: "ak",
  secretAccessKey: "sk",
  bucketName: "bucket",
};

const createBody =
  "<InitiateMultipartUploadResult><UploadId>upload-xyz</UploadId></InitiateMultipartUploadResult>";

function copyBody(partNumber) {
  return `<CopyPartResult><ETag>&quot;etag-${partNumber}&quot;</ETag><LastModified>2026-10-10T00:00:00Z</LastModified></CopyPartResult>`;
}

const completeBody =
  "<CompleteMultipartUploadResult><ETag>&quot;final&quot;</ETag></CompleteMultipartUploadResult>";

// PLACEHOLDER_TESTS

test("multipartCopyObject stitches ranges across parts then completes", async () => {
  const { calls } = mockFetchSigned([
    { body: createBody },
    { body: copyBody(1) },
    { body: copyBody(2) },
    { body: copyBody(3) },
    { body: completeBody },
  ]);
  const multipart = loadModule("services/r2Multipart.js");
  const PART = multipart.MULTIPART_COPY_PART_SIZE;
  const totalSize = PART * 2 + 123; // 3 片：两整段 + 余数段

  await multipart.multipartCopyObject(
    CONFIG,
    "dir a/sub?b/文件 x.bin",
    "arch/moved.bin",
    totalSize,
  );

  // 调用序：Create → UploadPartCopy×3 → Complete
  assert.equal(calls.length, 5);
  assert.equal(calls[0].method, "POST"); // CreateMultipartUpload
  assert.equal(calls[0].input.Key, "arch/moved.bin");

  const copies = calls.slice(1, 4);
  assert.deepEqual(
    copies.map((c) => c.method),
    ["PUT", "PUT", "PUT"],
  );
  assert.deepEqual(
    copies.map((c) => c.input.PartNumber),
    [1, 2, 3],
  );
  // CopySource：源 key 逐段 encodeURIComponent，与 copyObject 口径一致
  for (const copy of copies) {
    assert.equal(copy.input.UploadId, "upload-xyz");
    assert.equal(copy.input.Key, "arch/moved.bin");
    assert.equal(
      copy.input.CopySource,
      "/bucket/dir%20a/sub%3Fb/%E6%96%87%E4%BB%B6%20x.bin",
    );
  }
  // 范围拼接：末段取余数，字节区间不重叠且全覆盖
  assert.equal(copies[0].input.CopySourceRange, `bytes=0-${PART - 1}`);
  assert.equal(
    copies[1].input.CopySourceRange,
    `bytes=${PART}-${2 * PART - 1}`,
  );
  assert.equal(
    copies[2].input.CopySourceRange,
    `bytes=${2 * PART}-${totalSize - 1}`,
  );

  // Complete：按 CopyPartResult body 的 ETag 回填（解码 &quot;）
  const complete = calls[4];
  assert.equal(complete.method, "POST");
  assert.deepEqual(complete.input.MultipartUpload.Parts, [
    { PartNumber: 1, ETag: '"etag-1"' },
    { PartNumber: 2, ETag: '"etag-2"' },
    { PartNumber: 3, ETag: '"etag-3"' },
  ]);
});

test("multipartCopyObject uses a single part for a size within one segment", async () => {
  const { calls } = mockFetchSigned([
    { body: createBody },
    { body: copyBody(1) },
    { body: completeBody },
  ]);
  const multipart = loadModule("services/r2Multipart.js");
  const PART = multipart.MULTIPART_COPY_PART_SIZE;

  await multipart.multipartCopyObject(CONFIG, "src.bin", "dst.bin", PART);

  assert.equal(calls.length, 3);
  assert.equal(calls[1].input.PartNumber, 1);
  assert.equal(calls[1].input.CopySourceRange, `bytes=0-${PART - 1}`);
});

test("multipartCopyObject copies the one-byte remainder of the last part", async () => {
  const { calls } = mockFetchSigned([
    { body: createBody },
    { body: copyBody(1) },
    { body: copyBody(2) },
    { body: completeBody },
  ]);
  const multipart = loadModule("services/r2Multipart.js");
  const PART = multipart.MULTIPART_COPY_PART_SIZE;

  await multipart.multipartCopyObject(CONFIG, "src.bin", "dst.bin", PART + 1);

  assert.equal(calls.length, 4);
  assert.equal(calls[1].input.CopySourceRange, `bytes=0-${PART - 1}`);
  // 末段仅 1 字节：start=end=PART
  assert.equal(calls[2].input.CopySourceRange, `bytes=${PART}-${PART}`);
});

// PLACEHOLDER_ABORT

test("multipartCopyObject aborts the upload and rethrows when a part copy fails", async () => {
  const { calls } = mockFetchSigned([
    { body: createBody },
    { body: copyBody(1) },
    {
      body: "<Error><Code>InternalError</Code><Message>boom</Message></Error>",
      status: 500,
    },
    { body: "", status: 204 }, // AbortMultipartUpload
  ]);
  const multipart = loadModule("services/r2Multipart.js");
  const PART = multipart.MULTIPART_COPY_PART_SIZE;

  await assert.rejects(
    multipart.multipartCopyObject(CONFIG, "src.bin", "dst.bin", PART * 2 + 1),
    (error) => {
      // 原始分段错误上抛（非补偿错误），携带上游状态码
      assert.equal(error.name, "InternalError");
      assert.equal(error.$metadata.httpStatusCode, 500);
      return true;
    },
  );

  // 末次请求是针对 dest + uploadId 的 Abort（DELETE）补偿
  const abort = calls[calls.length - 1];
  assert.equal(abort.method, "DELETE");
  assert.equal(abort.input.Key, "dst.bin");
  assert.equal(abort.input.UploadId, "upload-xyz");
});

test("multipartCopyObject aborts when a part returns a 200 response with an Error body", async () => {
  const { calls } = mockFetchSigned([
    { body: createBody },
    {
      body: "<Error><Code>SlowDown</Code><Message>retry</Message></Error>",
      status: 200,
    },
    { body: "", status: 204 }, // Abort
  ]);
  const multipart = loadModule("services/r2Multipart.js");
  const PART = multipart.MULTIPART_COPY_PART_SIZE;

  await assert.rejects(
    multipart.multipartCopyObject(CONFIG, "src.bin", "dst.bin", PART + 1),
    (error) => {
      assert.equal(error.name, "SlowDown");
      return true;
    },
  );
  assert.equal(calls[calls.length - 1].method, "DELETE");
});

test("multipartCopyObject surfaces the original error even if the abort compensation fails", async () => {
  mockFetchSigned([
    { body: createBody },
    { body: "<Error><Code>AccessDenied</Code></Error>", status: 403 },
    { body: "<Error><Code>AbortFailed</Code></Error>", status: 500 }, // Abort 也失败
  ]);
  const multipart = loadModule("services/r2Multipart.js");
  const PART = multipart.MULTIPART_COPY_PART_SIZE;

  await assert.rejects(
    multipart.multipartCopyObject(CONFIG, "src.bin", "dst.bin", PART + 1),
    (error) => {
      // 补偿失败被吞掉，上抛的仍是原始分段错误
      assert.equal(error.name, "AccessDenied");
      assert.equal(error.$metadata.httpStatusCode, 403);
      return true;
    },
  );
});

test("multipartCopyObject rejects objects beyond the part-count cap without any request", async () => {
  const { calls } = mockFetchSigned([]);
  const multipart = loadModule("services/r2Multipart.js");
  const PART = multipart.MULTIPART_COPY_PART_SIZE;
  const tooLarge = PART * multipart.MAX_MULTIPART_COPY_PARTS + 1;

  await assert.rejects(
    multipart.multipartCopyObject(CONFIG, "src.bin", "dst.bin", tooLarge),
    (error) => {
      assert.equal(error.name, "EntityTooLarge");
      assert.equal(error.$metadata.httpStatusCode, 413);
      return true;
    },
  );
  // 超限预检在任何子请求之前完成
  assert.equal(calls.length, 0);
});

test("multipartCopyObject rejects a non-positive total size", async () => {
  mockFetchSigned([]);
  const multipart = loadModule("services/r2Multipart.js");
  await assert.rejects(
    multipart.multipartCopyObject(CONFIG, "src.bin", "dst.bin", 0),
    /invalid_total_size/,
  );
});
