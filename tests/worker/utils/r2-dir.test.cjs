const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

const { extractDirFromR2Key, collectDirAncestors, normalizeDirParam } = require(
  path.join(COMPILED_ROOT, "utils/r2Dir.js"),
);

test("extractDirFromR2Key 对三种 r2_key 形态口径一致", () => {
  // R2 预签名扁平 key（dir 被 buildR2Key 剥离）→ 根
  assert.equal(extractDirFromR2Key("flares3/cfg1/a.pdf", "cfg1"), "");
  // 服务端中转嵌套 key → 保留目录
  assert.equal(extractDirFromR2Key("storage/cfg1/a/b/x.pdf", "cfg1"), "a/b");
  // 服务端中转无目录 → 根
  assert.equal(extractDirFromR2Key("storage/cfg1/x.pdf", "cfg1"), "");
  // 前向兼容：若 flares3 路径将来保留目录，同一口径归入目录
  assert.equal(extractDirFromR2Key("flares3/cfg1/a/b/x.pdf", "cfg1"), "a/b");
  // legacy / 未知前缀 → 根
  assert.equal(extractDirFromR2Key("uploads/x.pdf", null), "");
  assert.equal(extractDirFromR2Key("x.pdf", null), "");
});

test("extractDirFromR2Key 对空值与畸形输入不抛错", () => {
  assert.equal(extractDirFromR2Key("", "cfg1"), "");
  assert.equal(extractDirFromR2Key(null, null), "");
  assert.equal(extractDirFromR2Key(undefined, undefined), "");
  // 多层嵌套目录
  assert.equal(
    extractDirFromR2Key("storage/cfg1/a/b/c/d.bin", "cfg1"),
    "a/b/c",
  );
});

test("collectDirAncestors 展开自身及全部祖先", () => {
  assert.deepEqual(collectDirAncestors("a/b/c"), ["a", "a/b", "a/b/c"]);
  assert.deepEqual(collectDirAncestors("a"), ["a"]);
  assert.deepEqual(collectDirAncestors(""), []);
  assert.deepEqual(collectDirAncestors(null), []);
});

test("normalizeDirParam 归一并拒绝穿越段", () => {
  assert.equal(normalizeDirParam("a/b"), "a/b");
  assert.equal(normalizeDirParam("/a/b/"), "a/b");
  assert.equal(normalizeDirParam("a\\b"), "a/b");
  assert.equal(normalizeDirParam("a//b"), "a/b");
  // 穿越 / 当前目录段 → 拒绝（空=无过滤）
  assert.equal(normalizeDirParam("../etc"), "");
  assert.equal(normalizeDirParam("a/../b"), "");
  assert.equal(normalizeDirParam("."), "");
  assert.equal(normalizeDirParam(""), "");
  assert.equal(normalizeDirParam(null), "");
});
