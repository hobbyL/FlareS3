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

const CONFIG = {
  endpoint: "https://example.com",
  accessKeyId: "ak",
  secretAccessKey: "sk",
  bucketName: "bucket",
};

function buildListXml(keys) {
  return (
    "<ListBucketResult>" +
    `<KeyCount>${keys.length}</KeyCount>` +
    keys
      .map(
        (key) =>
          `<Contents><Key>${key}</Key><Size>10</Size><ETag>&quot;e&quot;</ETag></Contents>`,
      )
      .join("") +
    "<IsTruncated>false</IsTruncated>" +
    "</ListBucketResult>"
  );
}

function encodeKeyForXml(key) {
  return key
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * mock fetchSigned：GET 返回对象列表 XML，POST 返回批量删除结果 XML。
 * 捕获每次调用的 command / init 供断言。
 */
function mockFetchSigned({ listKeys, deleteResults }) {
  const signed = loadModule("services/r2SignedRequests.js");
  const getCalls = [];
  const postCalls = [];
  signed.fetchSigned = async (_client, command, init) => {
    const method = String(init.method || "GET").toUpperCase();
    if (method === "GET") {
      getCalls.push({ command, init });
      return new Response(buildListXml(listKeys), { status: 200 });
    }
    const index = postCalls.length;
    postCalls.push({ command, init, input: command.input });
    const body =
      typeof deleteResults[index] === "function"
        ? deleteResults[index](index)
        : deleteResults[index];
    return new Response(body, { status: 200 });
  };
  return { getCalls, postCalls };
}

test("deleteObjectsByPrefix batches keys into DeleteObjects requests of at most 1000", async () => {
  // 1005 个 key：应拆为 1000 + 5 两批，而不是逐 key 删除
  const keys = Array.from({ length: 1005 }, (_, i) => `dir/file-${i}.bin`);
  // 列表 XML 中的 key 经过实体转义，收集时解码回字面量
  keys[0] = 'a&b<c>"d".txt';
  const encodedKeys = keys.map(encodeKeyForXml);

  const { postCalls, getCalls } = mockFetchSigned({
    listKeys: encodedKeys,
    deleteResults: [
      "<DeleteResult></DeleteResult>",
      "<DeleteResult></DeleteResult>",
    ],
  });
  const r2objects = loadModule("services/r2Objects.js");

  const result = await r2objects.deleteObjectsByPrefix(CONFIG, "dir/");

  assert.deepEqual(result, { deleted_count: 1005 });
  assert.equal(getCalls.length, 1, "前缀列表单页即可返回全部 key");
  assert.equal(postCalls.length, 2, "1005 个 key 必须分为两批");

  const [first, second] = postCalls;
  assert.match(first.init.method, /POST/i);
  assert.equal((first.init.body.match(/<Object>/g) || []).length, 1000);
  assert.equal((second.init.body.match(/<Object>/g) || []).length, 5);

  // 请求体结构：Quiet 模式 + key 实体转义（与解析方向对称）
  assert.ok(first.init.body.includes("<Quiet>true</Quiet>"));
  assert.ok(
    first.init.body.includes(
      `<Object><Key>a&amp;b&lt;c&gt;&quot;d&quot;.txt</Key></Object>`,
    ),
  );
  assert.equal(first.init.headers["Content-Type"], "application/xml");

  // command 输入也携带同批 key（供 SDK 序列化签名）
  assert.equal(first.input.Delete.Objects.length, 1000);
  assert.equal(first.input.Delete.Objects[0].Key, 'a&b<c>"d".txt');
  assert.equal(first.input.Bucket, "bucket");

  // Node 无 MD5 摘要时降级省略 Content-MD5；若运行时支持则必须是合法 base64
  const md5 = first.init.headers["Content-MD5"];
  if (md5 !== undefined) {
    assert.match(md5, /^[A-Za-z0-9+/]+={0,2}$/);
  }
});

test("deleteObjectsByPrefix surfaces quiet-mode failures with decoded keys", async () => {
  const { postCalls } = mockFetchSigned({
    listKeys: ["dir/ok.txt", "dir/bad&amp;name.txt"],
    deleteResults: [
      "<DeleteResult>" +
        "<Error><Key>dir/bad&amp;name.txt</Key><Code>AccessDenied</Code><Message>denied</Message></Error>" +
        "</DeleteResult>",
    ],
  });
  const r2objects = loadModule("services/r2Objects.js");

  await assert.rejects(
    r2objects.deleteObjectsByPrefix(CONFIG, "dir/"),
    (error) => {
      assert.equal(error.name, "S3DeleteObjectsPartialFailure");
      assert.equal(error.failures.length, 1);
      assert.equal(error.failures[0].key, "dir/bad&name.txt");
      assert.equal(error.failures[0].code, "AccessDenied");
      assert.match(error.message, /部分失败/);
      assert.equal(postCalls.length, 1);
      return true;
    },
  );
});

test("deleteObjectsByPrefix maps non-OK batch responses to S3 errors", async () => {
  const signed = loadModule("services/r2SignedRequests.js");
  signed.fetchSigned = async (_client, _command, init) => {
    if (String(init.method).toUpperCase() === "GET") {
      return new Response(buildListXml(["dir/a.txt"]), { status: 200 });
    }
    return new Response(
      "<Error><Code>AccessDenied</Code><Message>denied</Message></Error>",
      { status: 403 },
    );
  };
  const r2objects = loadModule("services/r2Objects.js");

  await assert.rejects(
    r2objects.deleteObjectsByPrefix(CONFIG, "dir/"),
    (error) => {
      assert.equal(error.name, "AccessDenied");
      assert.equal(error.$metadata.httpStatusCode, 403);
      return true;
    },
  );
});
