import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFolderEntryDir,
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

test("buildFolderEntryDir derives per-file dir from webkitRelativePath", () => {
  // 普通相对路径：取除末段文件名外的目录部分
  assert.equal(buildFolderEntryDir("a/b/c.txt", ""), "a/b");
  assert.equal(buildFolderEntryDir("a/f1.bin", ""), "a");

  // 已有面板 dir：relativeDir 拼在面板 dir 之后
  assert.equal(buildFolderEntryDir("a/b/c.txt", "backup/"), "backup/a/b");
  assert.equal(buildFolderEntryDir("a/f1", "backup"), "backup/a");

  // 无目录段（普通多选，relativePath 为空或仅文件名）→ 回退面板 dir
  assert.equal(buildFolderEntryDir("", "backup/"), "backup");
  assert.equal(buildFolderEntryDir("file.txt", "backup"), "backup");

  // 面板 dir 与相对路径均为空 → undefined（与队列字段「无前缀」语义一致）
  assert.equal(buildFolderEntryDir("", ""), undefined);
  assert.equal(buildFolderEntryDir("file.txt", ""), undefined);

  // 无扩展名文件、反斜杠分隔、冗余斜杠归一化
  assert.equal(buildFolderEntryDir("a\\b\\README", ""), "a/b");
  assert.equal(buildFolderEntryDir("a//b//c.txt", "//backup//"), "backup/a/b");

  // 非法输入兜底：不抛错
  assert.equal(buildFolderEntryDir(null, null), undefined);
  assert.equal(buildFolderEntryDir(undefined, undefined), undefined);
});
