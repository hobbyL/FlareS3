import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const filesViewSource = read("../../../frontend/src/views/Files.vue");
const apiSource = read("../../../frontend/src/services/api.js");

test("Files.vue 在非 trash 模式渲染目录面包屑并接线导航", () => {
  assert.match(filesViewSource, /import FilesDirBreadcrumb from/);
  // trash 模式隐藏目录导航
  assert.match(filesViewSource, /<FilesDirBreadcrumb\s+v-if="!isTrashMode"/);
  assert.match(filesViewSource, /@go-root="goRootDir"/);
  assert.match(filesViewSource, /@go-up="goUpDir"/);
  assert.match(filesViewSource, /@navigate="navigateDir"/);
});

test("Files.vue 目录切换保持视图/排序，仅改 dir+重置页码", () => {
  // 精确提取 navigateDir 函数体，断言其只改 dir/page，不触碰 viewMode/sort_key
  const match = filesViewSource.match(
    /const navigateDir = \(prefix\) => \{([\s\S]*?)\n\}/,
  );
  assert.ok(match, "应存在 navigateDir 函数");
  const body = match[1];
  assert.match(body, /filters\.value\.dir = next/);
  assert.match(body, /pagination\.value\.page = 1/);
  assert.ok(!/sort_key/.test(body), "目录切换不应修改排序");
  assert.ok(!/viewMode/.test(body), "目录切换不应修改视图模式");
});

test("Files.vue 切回收站清空目录过滤与目录列表", () => {
  assert.match(filesViewSource, /filters\.value\.dir = ''/);
  assert.match(filesViewSource, /fileDirs\.value = \[\]/);
});

test("Files.vue 用 getFileDirs 加载目录（活动模式）", () => {
  assert.match(filesViewSource, /const loadFileDirs = async \(\) =>/);
  assert.match(filesViewSource, /api\.getFileDirs\(/);
  // 挂载时加载
  assert.match(filesViewSource, /onMounted\(\(\) => \{[\s\S]*loadFileDirs\(\)/);
});

test("api.js 暴露 getFileDirs 且 getFiles 透传 filters", () => {
  assert.match(apiSource, /getFileDirs\(filters = \{\}\) \{/);
  assert.match(
    apiSource,
    /api\.get\('\/files\/dirs', \{ params: \{ \.\.\.\(filters \|\| \{\}\) \} \}\)/,
  );
  // getFiles 经 ...filters 透传 dir
  assert.match(
    apiSource,
    /getFiles\(page = 1, limit = 20, filters = \{\}\) \{[\s\S]*\.\.\.\(filters \|\| \{\}\)/,
  );
});
