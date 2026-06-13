const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

test("renderFileMessagePage escapes dynamic title and message", async () => {
  const { renderFileMessagePage } = require(
    compiledPath("routes/fileSharePages.js"),
  );

  const response = renderFileMessagePage(
    "<Share>",
    "<script>alert(1)</script>",
    418,
  );
  const body = await response.text();

  assert.equal(response.status, 418);
  assert.equal(
    response.headers.get("Content-Type"),
    "text/html; charset=utf-8",
  );
  assert.match(body, /&lt;Share&gt;/);
  assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(body, /<script>alert\(1\)<\/script>/);
});

test("renderFilePasswordForm renders error state without exposing raw html", async () => {
  const { renderFilePasswordForm } = require(
    compiledPath("routes/fileSharePages.js"),
  );

  const response = renderFilePasswordForm({
    title: "secret.txt",
    meta: "已访问 1/3",
    error: "口令 <错误>",
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /该文件需要访问口令/);
  assert.match(body, /下载文件/);
  assert.match(body, /口令 &lt;错误&gt;/);
  assert.doesNotMatch(body, /口令 <错误>/);
});

test("renderFileConfirmPage renders download confirmation form", async () => {
  const { renderFileConfirmPage } = require(
    compiledPath("routes/fileSharePages.js"),
  );

  const response = renderFileConfirmPage({
    title: "report.pdf",
    meta: "已访问 0 · 过期时间 2026-04-15 16:30",
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /点击下方按钮开始下载文件/);
  assert.match(body, /<form method="post">/);
  assert.match(body, /下载文件/);
});
