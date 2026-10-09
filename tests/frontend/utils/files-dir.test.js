import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFilesQueryParams,
  buildDirBreadcrumb,
  collectChildDirs,
  getParentDir,
  normalizeDir,
} from "../../../frontend/src/utils/files.js";

test("buildFilesQueryParams 活动模式透传 dir，trash 模式忽略", () => {
  const active = buildFilesQueryParams(
    { dir: "a/b", filename: "x" },
    { mode: "normal", isAdmin: false },
  );
  assert.equal(active.dir, "a/b");
  assert.equal(active.filename, "x");

  // 回收站不按目录浏览 → 不透传 dir
  const trash = buildFilesQueryParams({ dir: "a/b" }, { mode: "trash" });
  assert.equal(trash.dir, undefined);

  // 空 dir 不出现在参数中
  const root = buildFilesQueryParams({ dir: "" }, { mode: "normal" });
  assert.equal(root.dir, undefined);
});

test("normalizeDir 归一斜杠并去首尾", () => {
  assert.equal(normalizeDir("/a/b/"), "a/b");
  assert.equal(normalizeDir("a\\b"), "a/b");
  assert.equal(normalizeDir("a//b"), "a/b");
  assert.equal(normalizeDir(""), "");
  assert.equal(normalizeDir(null), "");
});

test("buildDirBreadcrumb 产生累积前缀", () => {
  assert.deepEqual(buildDirBreadcrumb("a/b/c"), [
    { label: "a", prefix: "a" },
    { label: "b", prefix: "a/b" },
    { label: "c", prefix: "a/b/c" },
  ]);
  assert.deepEqual(buildDirBreadcrumb(""), []);
});

test("getParentDir 返回父路径，根无父", () => {
  assert.equal(getParentDir("a/b/c"), "a/b");
  assert.equal(getParentDir("a"), "");
  assert.equal(getParentDir(""), "");
});

test("collectChildDirs 取当前目录的直接子目录（去重升序）", () => {
  const allDirs = ["a", "a/b", "a/c", "a/b/d", "x"];
  // 根：顶层单段目录
  assert.deepEqual(collectChildDirs("", allDirs), [
    { label: "a", prefix: "a" },
    { label: "x", prefix: "x" },
  ]);
  // 'a' 的直接子目录：a/b, a/c（不含 a/b/d）
  assert.deepEqual(collectChildDirs("a", allDirs), [
    { label: "b", prefix: "a/b" },
    { label: "c", prefix: "a/c" },
  ]);
  // 'a/b' 的直接子目录：a/b/d
  assert.deepEqual(collectChildDirs("a/b", allDirs), [
    { label: "d", prefix: "a/b/d" },
  ]);
  // 叶子目录无子目录
  assert.deepEqual(collectChildDirs("x", allDirs), []);
});
