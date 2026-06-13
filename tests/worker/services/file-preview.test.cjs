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

test("formatUpstreamFetchError compacts and truncates unsafe upstream errors", () => {
  const { formatUpstreamFetchError } = require(
    compiledPath("services/filePreview.js"),
  );

  assert.equal(
    formatUpstreamFetchError(new Error("fetch\nfailed\tbadly")),
    "fetch failed badly",
  );
  assert.equal(formatUpstreamFetchError(""), "upstream_fetch_failed");
  assert.equal(formatUpstreamFetchError("x".repeat(250)).length, 200);
});
