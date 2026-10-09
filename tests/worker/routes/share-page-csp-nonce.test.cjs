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

function loadWorkerEntrypoint() {
  clearModule("index.js");
  return loadModule("index.js").default;
}

/**
 * 提取页面首个内联脚本的 nonce 值。
 * buildPage 渲染的 head 内联脚本必须带 nonce="..." 属性。
 */
function extractScriptNonce(html) {
  const match = html.match(/<script nonce="([^"]+)"/);
  assert.ok(match, "页面内联 <script> 必须带 nonce 属性");
  return match[1];
}

/** CSP 的 script-src 指令不得为放行内联脚本而整体放开 */
function assertScriptSrcStrict(csp) {
  assert.ok(
    !/script-src[^;]*'unsafe-inline'/.test(csp),
    "script-src 不得包含 'unsafe-inline'",
  );
}

test("buildPage embeds a fresh nonce on the inline script per render", async () => {
  const { buildPage } = loadModule("routes/sharePage.js");

  const first = buildPage({ title: "分享", body: "<p>first</p>" });
  const second = buildPage({ title: "分享", body: "<p>second</p>" });

  const firstNonce = extractScriptNonce(first);
  const secondNonce = extractScriptNonce(second);

  // nonce 每次渲染随机，两次渲染不得重复
  assert.notEqual(firstNonce, secondNonce);
  // crypto.getRandomValues 16 字节的 base64（128 位熵），无 padding 时长度 22
  assert.ok(firstNonce.length >= 22 && firstNonce.length <= 24);
  assert.match(firstNonce, /^[A-Za-z0-9+/=]+$/);
});

test("withCommonHeaders aligns CSP nonce with script tag and strips the internal header", async () => {
  const { renderFileMessagePage } = loadModule("routes/fileSharePages.js");
  const { withCommonHeaders, CSP_NONCE_HEADER } = loadModule(
    "middleware/securityHeaders.js",
  );

  const response = renderFileMessagePage("分享", "口令不正确", 200);
  // 先 clone 再读文本，避免消费原响应的 body 流导致 withCommonHeaders 重建 Response 失败
  const body = await response.clone().text();
  const scriptNonce = extractScriptNonce(body);

  // 渲染侧通过内部约定头把 nonce 传给 CSP 生成方
  assert.equal(response.headers.get(CSP_NONCE_HEADER), scriptNonce);

  const finalResponse = withCommonHeaders(
    new Request("https://example.com/f/abc123"),
    response,
  );

  const csp = finalResponse.headers.get("Content-Security-Policy") || "";
  assert.ok(
    csp.includes(`'nonce-${scriptNonce}'`),
    "CSP script-src 必须包含与脚本标签一致的 nonce",
  );
  assertScriptSrcStrict(csp);
  assert.match(csp, /script-src 'self' 'nonce-/);
  // 内部约定头不得泄漏到最终响应
  assert.equal(finalResponse.headers.get(CSP_NONCE_HEADER), null);
});

test("all share page variants keep nonce alignment between script tag and CSP", async () => {
  const { renderFilePasswordForm } = loadModule("routes/fileSharePages.js");
  const { renderContentPage } = loadModule("routes/textShares.js");
  const { renderFolderListPage } = loadModule("routes/folderSharePages.js");
  const { renderMessagePage } = loadModule("routes/textShares.js");
  const { withCommonHeaders } = loadModule("middleware/securityHeaders.js");

  const pages = [
    renderFilePasswordForm({ title: "secret.txt", meta: "已访问 1/3" }),
    renderContentPage({ title: "笔记", meta: "已访问 2", content: "hello" }),
    renderFolderListPage({
      code: "abc123",
      title: "docs",
      meta: "已访问 1",
      path: "",
      sharePrefix: "docs/",
      folders: ["docs/sub/"],
      objects: [],
    }),
    renderMessagePage("分享", "内容不可用", 410),
  ];

  for (const page of pages) {
    // clone 读取文本，保留原响应供 withCommonHeaders 重建
    const body = await page.clone().text();
    const scriptNonce = extractScriptNonce(body);
    const finalResponse = withCommonHeaders(
      new Request("https://example.com/f/abc123"),
      page,
    );
    const csp = finalResponse.headers.get("Content-Security-Policy") || "";
    assert.ok(
      csp.includes(`'nonce-${scriptNonce}'`),
      "CSP script-src 必须包含与脚本标签一致的 nonce",
    );
    assertScriptSrcStrict(csp);
  }
});

test("worker entry keeps nonce-aligned CSP and never leaks the internal header", async () => {
  const worker = loadWorkerEntrypoint();
  const { renderFileMessagePage } = loadModule("routes/fileSharePages.js");
  const { CSP_NONCE_HEADER } = loadModule("middleware/securityHeaders.js");

  // 经 ASSETS stub 返回一个真实渲染的分享页响应，验证 index.ts 全链路
  // （withCommonHeaders 在入口对 text/html 响应套 CSP 并移除约定头）
  const workerResponse = await worker.fetch(
    new Request("https://example.com/", {
      headers: { Accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => renderFileMessagePage("分享", "口令不正确", 200),
      },
    },
    {},
  );

  assert.equal(workerResponse.status, 200);
  const body = await workerResponse.text();
  const scriptNonce = extractScriptNonce(body);

  const csp = workerResponse.headers.get("Content-Security-Policy") || "";
  assert.ok(csp.includes(`'nonce-${scriptNonce}'`));
  assertScriptSrcStrict(csp);
  assert.equal(workerResponse.headers.get(CSP_NONCE_HEADER), null);
});

test("plain html responses without a nonce keep the strict script-src", async () => {
  const { withCommonHeaders } = loadModule("middleware/securityHeaders.js");

  const response = new Response("<!doctype html><html><body>ok</body></html>", {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

  const finalResponse = withCommonHeaders(
    new Request("https://example.com/"),
    response,
  );
  const csp = finalResponse.headers.get("Content-Security-Policy") || "";
  assert.match(csp, /script-src 'self'/);
  assert.ok(!csp.includes("'nonce-"));
  assertScriptSrcStrict(csp);
});
