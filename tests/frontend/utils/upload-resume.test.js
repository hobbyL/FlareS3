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
