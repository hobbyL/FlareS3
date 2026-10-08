import test from "node:test";
import assert from "node:assert/strict";

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
  };
}

const STORAGE_KEY = "flares3_upload_progress";
const MAX_AGE = 24 * 60 * 60 * 1000;

// composable 经 uploadResume 在函数内部读取 localStorage，导入前装好替身。
const storage = createMemoryStorage();
globalThis.localStorage = storage;

const { useUploadResumeEntries } =
  await import("../../../frontend/src/composables/useUploadResumeEntries.js");

const realNow = Date.now;
const NOW = MAX_AGE * 3;

function reset() {
  storage.clear();
  Date.now = () => NOW;
}

test.after(() => {
  Date.now = realNow;
});

function writeRaw(records) {
  storage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function readRaw() {
  const raw = storage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : {};
}

function record(overrides = {}) {
  return {
    serverFileId: "server-1",
    uploadId: "upload-1",
    filename: "movie.mp4",
    size: 1024,
    partSize: 256,
    totalParts: 4,
    uploadedParts: [1, 2],
    lastUploadAt: NOW - 1000,
    ...overrides,
  };
}

function createEntries({ abort } = {}) {
  const calls = { abort: [], success: [], error: [] };
  const api = {
    abortMultipartUpload: async (payload) => {
      calls.abort.push(payload);
      if (abort) await abort(payload);
    },
  };
  const message = {
    success: (text) => calls.success.push(text),
    error: (text) => calls.error.push(text),
  };
  return {
    calls,
    entries: useUploadResumeEntries({ api, t: (key) => key, message }),
  };
}

async function withSilencedWarn(fn) {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}

test("refreshResumeEntries 只载入校验通过的记录", () => {
  reset();
  writeRaw({
    "movie.mp4_1024_1": record(),
    broken: record({ uploadId: "" }),
    stale: record({ lastUploadAt: NOW - MAX_AGE - 1 }),
  });

  const { entries } = createEntries();
  assert.equal(entries.hasResumeEntries.value, false, "刷新前列表为空");

  entries.refreshResumeEntries();

  assert.deepEqual(
    entries.resumeEntries.value.map((entry) => entry.fileId),
    ["movie.mp4_1024_1"],
  );
  assert.equal(entries.hasResumeEntries.value, true);
});

test("matchResumeFile 在 name/size/lastModified 三要素一致时通过", () => {
  reset();
  writeRaw({ "movie.mp4_1024_1700000000000": record() });

  const { entries } = createEntries();
  entries.refreshResumeEntries();
  const [entry] = entries.resumeEntries.value;

  assert.equal(
    entries.matchResumeFile(entry, {
      name: "movie.mp4",
      size: 1024,
      lastModified: 1700000000000,
    }),
    true,
  );
});

test("matchResumeFile 任一要素不同即拒绝", () => {
  reset();
  writeRaw({ "movie.mp4_1024_1700000000000": record() });

  const { entries } = createEntries();
  entries.refreshResumeEntries();
  const [entry] = entries.resumeEntries.value;

  const mismatches = [
    { name: "other.mp4", size: 1024, lastModified: 1700000000000 },
    { name: "movie.mp4", size: 2048, lastModified: 1700000000000 },
    { name: "movie.mp4", size: 1024, lastModified: 1700000000001 },
  ];

  for (const file of mismatches) {
    assert.equal(
      entries.matchResumeFile(entry, file),
      false,
      `${JSON.stringify(file)} 不应被判定为同一文件`,
    );
  }

  assert.equal(entries.matchResumeFile(entry, null), false);
  assert.equal(entries.matchResumeFile(null, mismatches[0]), false);
});

test("requestDiscard / cancelDiscard 控制确认弹窗目标", () => {
  reset();
  writeRaw({ a_1024_1: record(), b_2048_2: record({ size: 2048 }) });

  const { entries } = createEntries();
  entries.refreshResumeEntries();

  entries.requestDiscard("b_2048_2");
  assert.equal(entries.discardTarget.value?.fileId, "b_2048_2");

  entries.cancelDiscard();
  assert.equal(entries.discardTarget.value, null);

  entries.requestDiscard("not-exist");
  assert.equal(entries.discardTarget.value, null, "未知 fileId 不应打开弹窗");
});

test("confirmDiscard 调用 abort、删除记录并刷新列表", async () => {
  reset();
  writeRaw({
    keep_1024_1: record({ serverFileId: "server-keep" }),
    drop_1024_2: record({ serverFileId: "server-drop" }),
  });

  const { entries, calls } = createEntries();
  entries.refreshResumeEntries();
  entries.requestDiscard("drop_1024_2");

  await entries.confirmDiscard();

  assert.deepEqual(calls.abort, [{ file_id: "server-drop" }]);
  assert.deepEqual(Object.keys(readRaw()), ["keep_1024_1"]);
  assert.deepEqual(
    entries.resumeEntries.value.map((entry) => entry.fileId),
    ["keep_1024_1"],
  );
  assert.equal(entries.discardTarget.value, null);
  assert.deepEqual(calls.success, ["upload.resume.discarded"]);
  assert.equal(entries.discarding.value, false);
});

test("confirmDiscard 在 abort 抛错时仍删除本地记录", async () => {
  reset();
  writeRaw({ drop_1024_2: record({ serverFileId: "server-gone" }) });

  const { entries, calls } = createEntries({
    abort: async () => {
      throw new Error("NOT_FOUND");
    },
  });
  entries.refreshResumeEntries();
  entries.requestDiscard("drop_1024_2");

  await withSilencedWarn(() => entries.confirmDiscard());

  assert.deepEqual(calls.abort, [{ file_id: "server-gone" }]);
  assert.deepEqual(readRaw(), {}, "服务端 abort 失败不应留下本地死记录");
  assert.equal(entries.resumeEntries.value.length, 0);
  assert.equal(entries.discardTarget.value, null);
  assert.equal(entries.discarding.value, false);
});

test("confirmDiscard 无目标时不发请求，置位期间屏蔽重复确认", async () => {
  reset();
  writeRaw({ drop_1024_2: record() });

  let release = null;
  const { entries, calls } = createEntries({
    abort: () => new Promise((resolve) => (release = resolve)),
  });
  entries.refreshResumeEntries();

  await entries.confirmDiscard();
  assert.deepEqual(calls.abort, [], "无目标时不应调用 abort");

  entries.requestDiscard("drop_1024_2");
  const first = entries.confirmDiscard();
  assert.equal(entries.discarding.value, true);
  await entries.confirmDiscard();
  assert.equal(calls.abort.length, 1, "置位期间的重复确认应被忽略");

  release?.();
  await first;
  assert.equal(calls.abort.length, 1);
  assert.deepEqual(readRaw(), {});
});
