import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../frontend/src/components/files/FileInfoModal.vue",
    import.meta.url,
  ),
  "utf8",
);

test("FileInfoModal previewKind 判定覆盖 video 与 audio 类型", () => {
  assert.match(
    source,
    /contentType\.startsWith\('video\/'\)/,
    "previewKind 应支持 video/* MIME 通道",
  );
  assert.match(
    source,
    /contentType\.startsWith\('audio\/'\)/,
    "previewKind 应支持 audio/* MIME 通道",
  );
  assert.match(
    source,
    /\['mp4', 'm4v', 'webm', 'ogg', 'ogv', 'mov', 'mkv'\]\.includes\(extension\)/,
    "video 扩展名白名单应与 worker resolvePreviewMode 口径一致",
  );
  assert.match(
    source,
    /\['mp3', 'm4a', 'wav', 'flac', 'aac', 'opus'\]\.includes\(extension\)/,
    "audio 扩展名白名单应与 worker resolvePreviewMode 口径一致",
  );
});

test("FileInfoModal 渲染 video 与 audio 原生媒体控件", () => {
  assert.match(source, /previewKind === 'video'/, "模板应包含 video 渲染分支");
  assert.match(
    source,
    /<video[\s\S]*controls[\s\S]*preload="metadata"/,
    "video 分支应带 controls 与 metadata 预载",
  );
  assert.match(source, /previewKind === 'audio'/, "模板应包含 audio 渲染分支");
  assert.match(
    source,
    /<audio[\s\S]*controls[\s\S]*preload="metadata"/,
    "audio 分支应带 controls 与 metadata 预载",
  );
});
