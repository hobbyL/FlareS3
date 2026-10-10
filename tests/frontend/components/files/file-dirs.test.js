import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const filesViewSource = read("../../../../frontend/src/views/Files.vue");
const apiSource = read("../../../../frontend/src/services/api.js");
const zhSource = read("../../../../frontend/src/locales/zh-CN/pages/files.js");
const enSource = read("../../../../frontend/src/locales/en-US/pages/files.js");

test("api 暴露 createFileDir / deleteFileDir，命中 /files/dirs", () => {
  assert.match(apiSource, /createFileDir\(dir\)/);
  assert.match(
    apiSource,
    /api\.post\('\/files\/dirs', \{ dir: dir \|\| '' \}\)/,
  );
  assert.match(apiSource, /deleteFileDir\(dir\)/);
  // DELETE 需用 axios 的 data 选项承载请求体
  assert.match(
    apiSource,
    /api\.delete\('\/files\/dirs', \{ data: \{ dir: dir \|\| '' \} \}\)/,
  );
});

test("Files 页提供新建文件夹入口并调用 createFileDir", () => {
  assert.match(filesViewSource, /@click="openNewFolderModal"/);
  assert.match(filesViewSource, /t\('files\.newFolder'\)/);
  assert.match(filesViewSource, /:title="t\('files\.newFolderTitle'\)"/);
  // 在当前目录下创建（完整路径交后端归一化）
  assert.match(
    filesViewSource,
    /const fullDir = filters\.value\.dir \? `\$\{filters\.value\.dir\}\/\$\{name\}` : name/,
  );
  assert.match(filesViewSource, /api\.createFileDir\(fullDir\)/);
});

test("Files 页仅在当前目录真空时提供删除空目录入口", () => {
  assert.match(filesViewSource, /canDeleteCurrentDir/);
  // 真空判定：非回收站 + 非根 + 无文件 + 无子目录
  assert.match(filesViewSource, /Number\(filesStore\.total \|\| 0\) === 0/);
  assert.match(filesViewSource, /currentChildDirs\.value\.length === 0/);
  assert.match(filesViewSource, /api\.deleteFileDir\(dir\)/);
  // 409 展示后端文案，缺省时回落本地化
  assert.match(filesViewSource, /files\.messages\.dirNotEmpty/);
});

test("loadFileDirs 正确解包拦截器已剥离的响应体", () => {
  // 拦截器返回 response.data，故此处不得再次解构 .data
  assert.match(
    filesViewSource,
    /const data = await api\.getFileDirs\(params\)/,
  );
  assert.doesNotMatch(
    filesViewSource,
    /const \{ data \} = await api\.getFileDirs\(params\)/,
  );
});

test("新建/删除空目录的中英文案齐备且键对齐", () => {
  for (const source of [zhSource, enSource]) {
    for (const key of [
      "newFolder:",
      "newFolderTitle:",
      "newFolderLabel:",
      "newFolderPlaceholder:",
      "newFolderHint:",
      "newFolderHintRoot:",
      "deleteDir:",
      "deleteDirTitle:",
      "deleteDirConfirm:",
      "folderCreated:",
      "folderCreateFailed:",
      "dirNotEmpty:",
      "deleteDirSuccess:",
      "deleteDirFailed:",
    ]) {
      assert.match(source, new RegExp(key.replace(":", "\\s*:")));
    }
  }
});
