const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
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

function withMockedFetch(handler) {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(calls.length, url, init);
  };
  return {
    calls,
    restore() {
      global.fetch = originalFetch;
    },
  };
}

function createKoofrProvider() {
  const { refreshUpstreamTimeoutConfig } = loadModule(
    "config/upstreamTimeout.js",
  );
  refreshUpstreamTimeoutConfig({});
  const { KoofrProvider } = loadModule("services/storage/koofr-provider.js");
  return new KoofrProvider({
    endpoint: "https://app.koofr.net/dav/Koofr",
    username: "alice@example.com",
    password: "secret",
    mountId: "m1",
  });
}

test("KoofrProvider.download 代理 WebDAV GET 流式下载，不创建永久分享链接", async () => {
  const provider = createKoofrProvider();

  const mock = withMockedFetch(
    () =>
      new Response("file-body-stream", {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": "16",
        },
      }),
  );
  let result;
  try {
    result = await provider.download("docs/readme.md", "readme.md", 3600);
  } finally {
    mock.restore();
  }

  // 下载结果必须是流式代理响应（kind: proxy），不得是 redirect 分享链接
  assert.equal(result.kind, "proxy");
  assert.equal(result.response.status, 200);
  assert.match(
    result.response.headers.get("Content-Disposition") || "",
    /^attachment; filename="readme\.md"$/,
  );

  // 唯一一次上游请求必须是 WebDAV GET 代理下载：
  // 不得出现 REST token 认证或 POST /shares 分享链接创建
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].init.method, "GET");
  assert.equal(
    mock.calls[0].url,
    "https://app.koofr.net/dav/Koofr/docs/readme.md",
  );
  for (const call of mock.calls) {
    assert.ok(!call.url.includes("/shares"), "不得创建 Koofr 分享链接");
    assert.ok(!call.url.endsWith("/token"), "下载不得触发 REST token 认证");
  }
});

test("KoofrProvider 源码不再包含 createShareLink 分享链接实现", () => {
  const repoRoot = path.join(process.cwd(), "..");
  const source = fs.readFileSync(
    path.join(
      repoRoot,
      "worker",
      "src",
      "services",
      "storage",
      "koofr-provider.ts",
    ),
    "utf8",
  );
  assert.ok(
    !source.includes("createShareLink"),
    "createShareLink 死代码必须清除（永久分享链接绕过分享生命周期模型）",
  );
});
