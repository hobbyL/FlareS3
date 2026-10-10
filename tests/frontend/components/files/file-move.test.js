import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractFileDir } from "../../../../frontend/src/utils/files.js";

const read = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const moveModalSource = read(
  "../../../../frontend/src/components/files/FileMoveModal.vue",
);
const filesViewSource = read("../../../../frontend/src/views/Files.vue");
const apiSource = read("../../../../frontend/src/services/api.js");
const columnsSource = read(
  "../../../../frontend/src/components/files/fileTableColumns.js",
);
const cardViewSource = read(
  "../../../../frontend/src/components/files/FilesCardView.vue",
);

test("extractFileDir 与后端 r2_key 目录口径一致", () => {
  assert.equal(extractFileDir("storage/cfg/docs/a.bin"), "docs");
  assert.equal(extractFileDir("flares3/cfg/a/b/c.png"), "a/b");
  // 根（无目录段）
  assert.equal(extractFileDir("flares3/cfg/a.png"), "");
  // legacy / 未知前缀 → 根
  assert.equal(extractFileDir("uploads/legacy.bin"), "");
  assert.equal(extractFileDir(""), "");
});

test("FileMoveModal 复用 MountMoveTree + collectChildDirs，确认时抛出归一后的 toDir", () => {
  assert.match(
    moveModalSource,
    /import MountMoveTree from '\.\.\/mount\/MountMoveTree\.vue'/,
  );
  assert.match(moveModalSource, /collectChildDirs/);
  // targetDir 单一真源 + 可手动输入
  assert.match(moveModalSource, /const targetDir = ref\(''\)/);
  assert.match(
    moveModalSource,
    /emit\('confirm', \{ toDir: normalizedTarget\.value \}\)/,
  );
  // 目标与当前目录相同时禁用提交
  assert.match(moveModalSource, /isSameTarget/);
});

test("api 暴露 moveFile，POST 到 /files/:id/move", () => {
  assert.match(apiSource, /moveFile\(fileId, dir\)/);
  assert.match(
    apiSource,
    /api\.post\(`\/files\/\$\{fileId\}\/move`, \{ dir: dir \|\| '' \}\)/,
  );
});

test("Files 页面挂载 FileMoveModal 并透传当前文件目录与目录集合", () => {
  assert.match(filesViewSource, /:source-dir="movingDir"/);
  assert.match(filesViewSource, /:dirs="fileDirs"/);
  assert.match(filesViewSource, /@confirm="handleMoveConfirm"/);
  // 当前文件目录来自自身 r2_key
  assert.match(filesViewSource, /extractFileDir\(row\.r2_key\)/);
  assert.match(filesViewSource, /api\.moveFile\(fileId, targetDir\)/);
});

test("表格与卡片视图都暴露移动入口", () => {
  assert.match(columnsSource, /onMoveFile/);
  assert.match(columnsSource, /FolderInput/);
  assert.match(cardViewSource, /@click\.stop="emit\('move', row\)"/);
});
