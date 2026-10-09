const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

const { buildR2Key, extractR2ConfigIdFromKey, sanitizeFilename } = require(
  path.join(COMPILED_ROOT, "services/r2Keys.js"),
);

test("buildR2Key 逐段保留目录（与 storage 中转口径一致）", () => {
  assert.equal(buildR2Key("cfg", "a/b/file.txt"), "flares3/cfg/a/b/file.txt");
  assert.equal(buildR2Key("cfg", "file.txt"), "flares3/cfg/file.txt");
  // 多级目录
  assert.equal(
    buildR2Key("cfg", "x/y/z/deep.bin"),
    "flares3/cfg/x/y/z/deep.bin",
  );
});

test("buildR2Key 清洗目录段：控制字符/`..`/`.`/空段剔除，反斜杠归一", () => {
  // 反斜杠 → 正斜杠（Windows 形态相对路径）
  assert.equal(buildR2Key("cfg", "a\\b\\c.txt"), "flares3/cfg/a/b/c.txt");
  // 穿越段剔除，不抛错
  assert.equal(buildR2Key("cfg", "../a/./b.txt"), "flares3/cfg/a/b.txt");
  // 控制字符段清洗；空段折叠
  assert.equal(buildR2Key("cfg", "a//b/\u0001c.txt"), "flares3/cfg/a/b/c.txt");
  // 全空兜底 file（与现状一致）
  assert.equal(buildR2Key("cfg", ""), "flares3/cfg/file");
  assert.equal(buildR2Key("cfg", null), "flares3/cfg/file");
  assert.equal(buildR2Key("cfg", "///"), "flares3/cfg/file");
  // configId 含 / → _（既有映射保持）
  assert.equal(buildR2Key("a/b", "f.txt"), "flares3/a_b/f.txt");
});

test("buildR2Key 与 extractR2ConfigIdFromKey / extractDirFromR2Key 口径闭环", () => {
  const { extractDirFromR2Key } = require(
    path.join(COMPILED_ROOT, "utils/r2Dir.js"),
  );
  const key = buildR2Key("cfg-1", "photos/2026/img.png");
  assert.equal(key, "flares3/cfg-1/photos/2026/img.png");
  // configId 提取不回归
  assert.equal(extractR2ConfigIdFromKey(key), "cfg-1");
  // 目录视图口径：flares3 带目录形态自动归入目录（前向兼容已生效）
  assert.equal(extractDirFromR2Key(key, "cfg-1"), "photos/2026");
  // 扁平（存量）形态仍在根
  assert.equal(
    extractDirFromR2Key(buildR2Key("cfg-1", "flat.pdf"), "cfg-1"),
    "",
  );
});

test("sanitizeFilename 单文件名行为不回归（仍取末段）", () => {
  // 重命名/下载头等单文件名场景：含路径输入时只取末段（现状锁定）
  assert.equal(sanitizeFilename("a/b/file.txt"), "file.txt");
  assert.equal(sanitizeFilename("file.txt"), "file.txt");
  assert.equal(sanitizeFilename(""), "file");
  assert.equal(sanitizeFilename(null), "file");
  // 控制字符 → '/' 折叠后取末段
  assert.equal(sanitizeFilename("a\u0001b/c.txt"), "c.txt");
});
