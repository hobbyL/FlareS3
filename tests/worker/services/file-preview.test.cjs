const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

test("file preview helpers normalize content type and filename extension", () => {
  const { getFilenameExtension, normalizeContentType } = require(
    compiledPath("services/filePreview.js"),
  );

  assert.equal(
    normalizeContentType(" Text/Markdown; charset=utf-8 "),
    "text/markdown",
  );
  assert.equal(normalizeContentType(null), "");
  assert.equal(getFilenameExtension("archive.tar.gz"), "gz");
  assert.equal(getFilenameExtension(".env"), "");
  assert.equal(getFilenameExtension("README"), "");
});

test("file preview helpers classify archive and supported preview modes", () => {
  const { isArchiveFile, resolvePreviewMode } = require(
    compiledPath("services/filePreview.js"),
  );

  assert.equal(isArchiveFile("application/zip", ""), true);
  assert.equal(isArchiveFile("", "7z"), true);
  assert.equal(isArchiveFile("text/plain", "txt"), false);
  assert.deepEqual(resolvePreviewMode("application/pdf", ""), {
    kind: "redirect",
    responseContentType: "application/pdf",
  });
  assert.deepEqual(resolvePreviewMode("", "png"), {
    kind: "redirect",
    responseContentType: "image/png",
  });
  assert.deepEqual(resolvePreviewMode("text/x-markdown", ""), {
    kind: "proxy",
    responseContentType: "text/markdown; charset=utf-8",
  });
  assert.deepEqual(resolvePreviewMode("", "json"), {
    kind: "proxy",
    responseContentType: "text/plain; charset=utf-8",
  });
  assert.equal(resolvePreviewMode("", "exe"), null);
});

test("file preview helpers classify video and audio preview modes", () => {
  const { resolvePreviewMode } = require(
    compiledPath("services/filePreview.js"),
  );

  // MIME 通道优先，透传原始 content type（调用方 files.ts 已先经
  // normalizeContentType 去掉 charset 参数；此处直接传带参 MIME 验证
  // 白名单匹配仍生效，透传值保持原样——与 image/* 分支行为一致）
  assert.deepEqual(resolvePreviewMode("video/mp4", ""), {
    kind: "redirect",
    responseContentType: "video/mp4",
  });
  assert.deepEqual(resolvePreviewMode("audio/mpeg", ""), {
    kind: "redirect",
    responseContentType: "audio/mpeg",
  });
  // 扩展名通道回退到标准 MIME
  assert.deepEqual(resolvePreviewMode("", "mp4"), {
    kind: "redirect",
    responseContentType: "video/mp4",
  });
  assert.deepEqual(resolvePreviewMode("", "webm"), {
    kind: "redirect",
    responseContentType: "video/webm",
  });
  assert.deepEqual(resolvePreviewMode("", "mkv"), {
    kind: "redirect",
    responseContentType: "video/x-matroska",
  });
  assert.deepEqual(resolvePreviewMode("", "mp3"), {
    kind: "redirect",
    responseContentType: "audio/mpeg",
  });
  assert.deepEqual(resolvePreviewMode("", "flac"), {
    kind: "redirect",
    responseContentType: "audio/flac",
  });
  // ogg 扩展名按视频口径（与 mount 路由 resolvePreviewModeByExtension 一致）
  assert.deepEqual(resolvePreviewMode("", "ogg"), {
    kind: "redirect",
    responseContentType: "video/ogg",
  });
  // 非媒体白名单扩展名仍不支持
  assert.equal(resolvePreviewMode("", "avi"), null);
  assert.equal(resolvePreviewMode("", "wma"), null);
  // 原型链属性名不得被白名单真值检查误命中（无原型字典防御）
  assert.equal(resolvePreviewMode("", "constructor"), null);
  assert.equal(resolvePreviewMode("", "toString"), null);
});

test("formatUpstreamFetchError returns generic message and never leaks upstream details", () => {
  const { formatUpstreamFetchError } = require(
    compiledPath("services/filePreview.js"),
  );

  // 对外只回固定文案，原始消息（含 endpoint/内部细节）不允许进响应体
  assert.equal(
    formatUpstreamFetchError(
      new Error("https://secret-endpoint.example/ webdav 401"),
    ),
    "上游存储服务暂时不可用",
  );
  assert.equal(formatUpstreamFetchError(""), "上游存储服务暂时不可用");
  assert.equal(
    formatUpstreamFetchError(new Error("x".repeat(250))),
    "上游存储服务暂时不可用",
  );
});
