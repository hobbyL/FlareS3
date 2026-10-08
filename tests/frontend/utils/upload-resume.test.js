import test from "node:test";
import assert from "node:assert/strict";

const STORAGE_KEY = "flares3_upload_progress";
const MAX_AGE = 24 * 60 * 60 * 1000;

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

// uploadResume.js 在函数内部读取 localStorage / console，这里在导入前装好替身。
const storage = createMemoryStorage();
globalThis.localStorage = storage;

const {
  generateFileId,
  getUploadProgress,
  saveUploadProgress,
  updateUploadedParts,
  deleteUploadProgress,
  cleanExpiredProgress,
  initUploadResume,
  listUploadProgress,
} = await import("../../../frontend/src/utils/uploadResume.js");

const realNow = Date.now;

function reset() {
  storage.clear();
  Date.now = realNow;
}

function freezeNow(value) {
  Date.now = () => value;
}

function readRaw() {
  const raw = storage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : {};
}

function withSilencedWarn(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

function countWrites(fn) {
  const original = storage.setItem;
  let writes = 0;
  storage.setItem = (key, value) => {
    writes += 1;
    original.call(storage, key, value);
  };
  try {
    return { result: fn(), writes };
  } finally {
    storage.setItem = original;
  }
}

function writeRaw(records) {
  storage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function validRecord(overrides = {}) {
  return {
    serverFileId: "server-1",
    uploadId: "upload-1",
    filename: "movie.mp4",
    size: 1024,
    partSize: 256,
    totalParts: 4,
    uploadedParts: [1, 2],
    lastUploadAt: 1_000_000,
    ...overrides,
  };
}

test("generateFileId 由文件名、大小与修改时间组合而成", () => {
  reset();
  const id = generateFileId({
    name: "report.pdf",
    size: 2048,
    lastModified: 1700000000000,
  });
  assert.equal(id, "report.pdf_2048_1700000000000");

  // 同名但大小不同必须得到不同标识，避免误判为同一次上传
  const other = generateFileId({
    name: "report.pdf",
    size: 4096,
    lastModified: 1700000000000,
  });
  assert.notEqual(id, other);
});

test("saveUploadProgress / getUploadProgress 往返读写并写入 lastUploadAt", () => {
  reset();
  freezeNow(1_000_000);

  saveUploadProgress("file-1", { uploadId: "u1", uploadedParts: [1, 2] });

  const progress = getUploadProgress("file-1");
  assert.deepEqual(progress, {
    uploadId: "u1",
    uploadedParts: [1, 2],
    lastUploadAt: 1_000_000,
  });
  assert.deepEqual(Object.keys(readRaw()), ["file-1"]);
});

test("getUploadProgress 对超过 24 小时的记录返回 null 并顺带删除", () => {
  reset();
  freezeNow(1_000_000);
  saveUploadProgress("stale", { uploadId: "u-stale" });

  freezeNow(1_000_000 + MAX_AGE + 1);
  assert.equal(getUploadProgress("stale"), null);
  assert.deepEqual(readRaw(), {}, "过期记录应被清除");
});

test("getUploadProgress 在恰好未超期时仍返回记录", () => {
  reset();
  freezeNow(1_000_000);
  saveUploadProgress("fresh", { uploadId: "u-fresh" });

  freezeNow(1_000_000 + MAX_AGE);
  assert.equal(getUploadProgress("fresh")?.uploadId, "u-fresh");
});

test("updateUploadedParts 追加分片且不产生重复", () => {
  reset();
  freezeNow(2_000_000);
  saveUploadProgress("file-2", { uploadId: "u2" });

  updateUploadedParts("file-2", 1);
  updateUploadedParts("file-2", 2);
  updateUploadedParts("file-2", 1);

  assert.deepEqual(getUploadProgress("file-2").uploadedParts, [1, 2]);
});

test("updateUploadedParts 对不存在的记录是安全的空操作", () => {
  reset();
  updateUploadedParts("missing", 3);
  assert.deepEqual(readRaw(), {});
});

test("deleteUploadProgress 只移除目标记录", () => {
  reset();
  freezeNow(3_000_000);
  saveUploadProgress("keep", { uploadId: "k" });
  saveUploadProgress("drop", { uploadId: "d" });

  deleteUploadProgress("drop");

  assert.deepEqual(Object.keys(readRaw()), ["keep"]);
});

test("cleanExpiredProgress 只清理过期项并保留有效项", () => {
  reset();
  freezeNow(10_000_000);
  saveUploadProgress("old", { uploadId: "old" });

  freezeNow(10_000_000 + MAX_AGE + 5_000);
  saveUploadProgress("new", { uploadId: "new" });

  cleanExpiredProgress();

  assert.deepEqual(Object.keys(readRaw()), ["new"]);
});

test("cleanExpiredProgress 无过期项时不重写存储", () => {
  reset();
  freezeNow(20_000_000);
  saveUploadProgress("a", { uploadId: "a" });
  const before = storage.getItem(STORAGE_KEY);

  cleanExpiredProgress();

  assert.equal(storage.getItem(STORAGE_KEY), before);
});

test("initUploadResume 启动时清理过期进度", () => {
  reset();
  freezeNow(30_000_000);
  saveUploadProgress("expired", { uploadId: "e" });

  freezeNow(30_000_000 + MAX_AGE + 1);
  initUploadResume();

  assert.deepEqual(readRaw(), {});
});

test("存储内容损坏时降级为空进度并告警，而不是抛错", () => {
  reset();
  storage.setItem(STORAGE_KEY, "{not-json");

  const { result, warnings } = withSilencedWarn(() =>
    getUploadProgress("anything"),
  );

  assert.equal(result, undefined);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /Failed to load upload progress/);
});

test("listUploadProgress 合法记录字段齐备且按 lastUploadAt 倒序", () => {
  reset();
  freezeNow(1_000_000);
  writeRaw({
    older: validRecord({ serverFileId: "s-old", lastUploadAt: 900_000 }),
    newer: validRecord({ serverFileId: "s-new", lastUploadAt: 999_000 }),
  });

  const entries = listUploadProgress();

  assert.deepEqual(
    entries.map((entry) => entry.fileId),
    ["newer", "older"],
    "最近上传的记录应排在前面",
  );
  assert.deepEqual(entries[0], {
    fileId: "newer",
    serverFileId: "s-new",
    uploadId: "upload-1",
    filename: "movie.mp4",
    size: 1024,
    partSize: 256,
    totalParts: 4,
    uploadedParts: [1, 2],
    lastUploadAt: 999_000,
  });
});

test("listUploadProgress 过滤结构非法记录并从存储中清除", () => {
  reset();
  freezeNow(1_000_000);
  writeRaw({
    ok: validRecord(),
    "missing-server-id": validRecord({ serverFileId: "" }),
    "missing-upload-id": validRecord({ uploadId: undefined }),
    "missing-filename": validRecord({ filename: "" }),
    "bad-size": validRecord({ size: 0 }),
    "bad-total-parts": validRecord({ totalParts: "4" }),
    "bad-last-upload-at": validRecord({ lastUploadAt: undefined }),
    "not-an-object": "nope",
  });

  const entries = listUploadProgress();

  assert.deepEqual(
    entries.map((entry) => entry.fileId),
    ["ok"],
  );
  assert.deepEqual(
    Object.keys(readRaw()),
    ["ok"],
    "非法记录应同时从 localStorage 中剔除",
  );
});

test("listUploadProgress 过滤超过 24 小时的记录并清除", () => {
  reset();
  const now = MAX_AGE * 3;
  freezeNow(now);
  writeRaw({
    fresh: validRecord({ lastUploadAt: now - 1_000 }),
    stale: validRecord({ lastUploadAt: now - MAX_AGE - 1 }),
    boundary: validRecord({ lastUploadAt: now - MAX_AGE }),
  });

  const entries = listUploadProgress();

  assert.deepEqual(
    entries.map((entry) => entry.fileId),
    ["fresh", "boundary"],
    "恰好等于 MAX_AGE 的记录沿用既有口径仍然有效",
  );
  assert.deepEqual(Object.keys(readRaw()).sort(), ["boundary", "fresh"]);
});

test("listUploadProgress 兼容老记录：uploadedParts 缺失归一为 []，partSize 非法归一为 0", () => {
  reset();
  freezeNow(1_000_000);
  writeRaw({
    legacy: validRecord({ uploadedParts: undefined, partSize: 0 }),
  });

  const [entry] = listUploadProgress();

  assert.deepEqual(entry.uploadedParts, []);
  assert.equal(entry.partSize, 0);
  assert.deepEqual(
    Object.keys(readRaw()),
    ["legacy"],
    "老记录可展示，不应被当成非法记录清除",
  );
});

test("listUploadProgress 无变更时不重写存储", () => {
  reset();
  freezeNow(1_000_000);
  writeRaw({ a: validRecord(), b: validRecord({ lastUploadAt: 999_000 }) });

  const { result, writes } = countWrites(() => listUploadProgress());

  assert.equal(result.length, 2);
  assert.equal(writes, 0, "全部有效时不应回写 localStorage");
});

test("listUploadProgress 清理多条非法记录只写一次存储", () => {
  reset();
  freezeNow(1_000_000);
  writeRaw({
    bad1: validRecord({ uploadId: "" }),
    bad2: validRecord({ size: -1 }),
    ok: validRecord(),
  });

  const { writes } = countWrites(() => listUploadProgress());

  assert.equal(writes, 1, "整轮清理只应写一次 localStorage");
});

test("listUploadProgress 在存储损坏时降级为空数组", () => {
  reset();
  storage.setItem(STORAGE_KEY, "{not-json");

  const { result } = withSilencedWarn(() => listUploadProgress());

  assert.deepEqual(result, []);
});

test("localStorage 写入失败时不会中断上传流程", () => {
  reset();
  const failing = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  globalThis.localStorage = failing;

  try {
    const { warnings } = withSilencedWarn(() => {
      saveUploadProgress("file-3", { uploadId: "u3" });
      return null;
    });
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /Failed to save upload progress/);
  } finally {
    globalThis.localStorage = storage;
    reset();
  }
});
