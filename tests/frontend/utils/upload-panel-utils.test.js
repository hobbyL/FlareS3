import test from "node:test";
import assert from "node:assert/strict";

import {
  createCancelledError,
  formatBytes,
  isCancelledError,
  resolveDownloadUrl,
  resolveShortUrl,
} from "../../../frontend/src/utils/uploadPanel.js";

test("upload panel URL helpers only expose safe download and short URLs", () => {
  assert.equal(
    resolveDownloadUrl("/api/files/file-1/download"),
    "/api/files/file-1/download",
  );
  assert.equal(
    resolveDownloadUrl("https://cdn.example.com/file.bin"),
    "https://cdn.example.com/file.bin",
  );
  assert.equal(
    resolveDownloadUrl(
      "http://cdn.example.com/file.bin",
      "/api/files/file-1/download",
    ),
    "/api/files/file-1/download",
  );
  assert.equal(
    resolveDownloadUrl(
      "//evil.example.com/file.bin",
      "/api/files/file-1/download",
    ),
    "/api/files/file-1/download",
  );
  assert.equal(resolveShortUrl("/s/abc123"), "/s/abc123");
  assert.equal(resolveShortUrl("https://example.com/s/abc123"), "");
});

test("upload panel utility helpers format bytes and classify cancellations", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.00 KB");
  assert.equal(isCancelledError(createCancelledError()), true);
  assert.equal(isCancelledError({ code: "ERR_CANCELED" }), true);
  assert.equal(isCancelledError(new Error("other")), false);
});
