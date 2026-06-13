const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

test("buildSanitizedSharedDownloadResponse preserves safe download headers", async () => {
  const { buildSanitizedSharedDownloadResponse } = require(
    compiledPath("services/fileShareDownload.js"),
  );
  const upstream = new Response("hello", {
    status: 200,
    headers: {
      "Content-Type": "text/plain",
      "Content-Length": "5",
      "Set-Cookie": "secret=1",
    },
  });

  const result = await buildSanitizedSharedDownloadResponse(
    upstream,
    'folder/sub\r\n"demo".txt',
  );

  assert.equal(result.ok, true);
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("Cache-Control"), "no-store");
  assert.equal(
    result.response.headers.get("X-Content-Type-Options"),
    "nosniff",
  );
  assert.equal(result.response.headers.get("Content-Type"), "text/plain");
  assert.equal(result.response.headers.get("Content-Length"), "5");
  assert.equal(
    result.response.headers.get("Content-Disposition"),
    'attachment; filename="demo.txt"',
  );
  assert.equal(result.response.headers.has("Set-Cookie"), false);
  assert.equal(await result.response.text(), "hello");
});

test("buildSanitizedSharedDownloadResponse returns bounded upstream error text", async () => {
  const { buildSanitizedSharedDownloadResponse } = require(
    compiledPath("services/fileShareDownload.js"),
  );
  const upstream = new Response("x".repeat(70_000), { status: 503 });

  const result = await buildSanitizedSharedDownloadResponse(
    upstream,
    "demo.txt",
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.status, 503);
  assert.equal(result.error.message.length <= 65_536, true);
});
