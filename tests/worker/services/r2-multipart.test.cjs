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

function buildListPartsXml({ parts, truncated, nextMarker }) {
  return (
    "<ListPartsResult>" +
    parts
      .map(
        (part) =>
          `<Part><PartNumber>${part}</PartNumber><ETag>&quot;etag-${part}&quot;</ETag></Part>`,
      )
      .join("") +
    `<IsTruncated>${truncated ? "true" : "false"}</IsTruncated>` +
    (nextMarker !== undefined
      ? `<NextPartNumberMarker>${nextMarker}</NextPartNumberMarker>`
      : "") +
    "</ListPartsResult>"
  );
}

function mockFetchSignedWithPages(pages) {
  const signed = loadModule("services/r2SignedRequests.js");
  const calls = [];
  signed.fetchSigned = async (_client, command, init) => {
    const index = calls.length;
    calls.push({ command, init, input: command.input });
    const body =
      typeof pages[index] === "function" ? pages[index](index) : pages[index];
    return new Response(body, { status: 200 });
  };
  return { signed, calls };
}

const CONFIG = {
  endpoint: "https://example.com",
  accessKeyId: "ak",
  secretAccessKey: "sk",
  bucketName: "bucket",
};

test("listParts aggregates all pages following NextPartNumberMarker", async () => {
  const { calls } = mockFetchSignedWithPages([
    buildListPartsXml({ parts: [1, 2], truncated: true, nextMarker: 2 }),
    buildListPartsXml({ parts: [3], truncated: false }),
  ]);
  const multipart = loadModule("services/r2Multipart.js");

  const parts = await multipart.listParts(
    CONFIG,
    "flares3/config-1/a.bin",
    "upload-1",
  );

  // 跨页聚合：3 片全部返回，不能只给第一页
  assert.equal(parts.length, 3);
  assert.deepEqual(
    parts.map((part) => part.PartNumber),
    [1, 2, 3],
  );
  assert.equal(parts[0].ETag, '"etag-1"');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].input.PartNumberMarker, undefined);
  assert.equal(calls[1].input.PartNumberMarker, "2");
  assert.equal(calls[1].input.UploadId, "upload-1");
});

test("listParts rejects truncated responses without NextPartNumberMarker", async () => {
  mockFetchSignedWithPages([
    buildListPartsXml({ parts: [1], truncated: true, nextMarker: undefined }),
  ]);
  const multipart = loadModule("services/r2Multipart.js");

  await assert.rejects(
    multipart.listParts(CONFIG, "k", "upload-1"),
    /分页标记无效/,
  );
});

test("listParts rejects a marker that stops advancing", async () => {
  mockFetchSignedWithPages([
    buildListPartsXml({ parts: [1, 2], truncated: true, nextMarker: 2 }),
    buildListPartsXml({ parts: [3], truncated: true, nextMarker: 2 }),
  ]);
  const multipart = loadModule("services/r2Multipart.js");

  await assert.rejects(
    multipart.listParts(CONFIG, "k", "upload-1"),
    /分页标记未推进/,
  );
});

test("listParts caps pagination at the page limit instead of looping forever", async () => {
  // 每页都声称截断且 marker 持续推进：必须触达页数上限后抛错
  mockFetchSignedWithPages(
    Array.from({ length: 100 }, (_, i) =>
      buildListPartsXml({ parts: [i + 1], truncated: true, nextMarker: i + 1 }),
    ),
  );
  const multipart = loadModule("services/r2Multipart.js");

  await assert.rejects(
    multipart.listParts(CONFIG, "k", "upload-1"),
    /分页超过 \d+ 页上限/,
  );
});
