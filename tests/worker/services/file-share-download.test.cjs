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

function clearModule(relativePath) {
  delete require.cache[compiledPath(relativePath)];
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

// 修复 B：file 分享下载的主路径（预签名 URL 拉取）必须走 fetchWithUpstreamTimeout，
// 断言上游 fetch 收到 AbortSignal 超时信号
test("buildSharedDownloadResponse fetches presigned url with AbortSignal timeout", async () => {
  const { refreshUpstreamTimeoutConfig } = loadModule(
    "config/upstreamTimeout.js",
  );
  refreshUpstreamTimeoutConfig({});

  // 先加载 r2 并打桩，再加载 fileShareDownload，保证后者引用同一模块实例
  clearModule("services/r2.js");
  clearModule("services/fileShareDownload.js");
  const r2 = loadModule("services/r2.js");
  r2.resolveR2ConfigForKey = async () => ({
    id: "config-1",
    config: {},
  });
  r2.generateDownloadUrl = async () => "https://download.example.com/demo.txt";

  const { buildSharedDownloadResponse } = loadModule(
    "services/fileShareDownload.js",
  );

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("hello", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  };

  try {
    const result = await buildSharedDownloadResponse(
      {},
      {
        r2_key: "flares3/config/demo.txt",
        filename: "demo.txt",
        expires_at: "9999-12-31T23:59:59.999Z",
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.response.status, 200);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://download.example.com/demo.txt");
  assert.ok(
    calls[0].init.signal instanceof AbortSignal,
    "预签名 URL 拉取必须带 AbortSignal 超时",
  );
});
