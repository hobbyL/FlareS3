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

// uploadTaskRunner 经 uploadResume 在函数内部读取 localStorage，导入前装好替身。
const storage = createMemoryStorage();
globalThis.localStorage = storage;

const { createUploadTaskRunner } =
  await import("../../../frontend/src/services/uploadTaskRunner.js");
const { generateFileId, getUploadProgress, saveUploadProgress } =
  await import("../../../frontend/src/utils/uploadResume.js");
const { useUploadQueue } =
  await import("../../../frontend/src/composables/useUploadQueue.js");

const PART_SIZE = 50 * 1024 * 1024;
const FILE_SIZE = 120 * 1024 * 1024; // 超过 100MB 分片阈值，走 uploadLargeFile

const t = (key) => key;

function reset() {
  storage.clear();
}

function createRawFile(overrides = {}) {
  return {
    name: "movie.mp4",
    size: FILE_SIZE,
    lastModified: 1_700_000_000_000,
    type: "application/octet-stream",
    slice: (start, end) => ({ start, end, size: end - start }),
    ...overrides,
  };
}

function createTaskFile(rawFile) {
  return {
    rawFile,
    name: rawFile.name,
    type: rawFile.type,
    size: rawFile.size,
    expiresIn: 7,
    requireLogin: true,
    configId: "cfg-1",
    configType: "r2",
  };
}

function runTask(api, rawFile, control) {
  const runner = createUploadTaskRunner({ api, t, onUploaded: () => {} });
  return runner(
    { file: createTaskFile(rawFile) },
    {
      updateItem: () => {},
      setCancel: (handler) => {
        control.cancelHandler = handler;
      },
      isCancelled: () => control.cancelled,
    },
  );
}

test("取消续传中的任务后删除 localStorage 进度记录", async () => {
  reset();
  const rawFile = createRawFile();
  const fileId = generateFileId(rawFile);
  saveUploadProgress(fileId, {
    serverFileId: "server-resume",
    uploadId: "upload-resume",
    filename: rawFile.name,
    size: rawFile.size,
    partSize: PART_SIZE,
    totalParts: 3,
    uploadedParts: [1],
  });

  const control = { cancelled: false, cancelHandler: null };
  const calls = { abort: [], init: 0 };

  const api = {
    getMultipartUploadedParts: async () => ({
      parts: [{ PartNumber: 1, ETag: '"etag-1"' }],
    }),
    initMultipartUpload: async () => {
      calls.init += 1;
      return {};
    },
    getMultipartUploadURL: async () => {
      // 模拟用户在分片预签名往返期间点了取消
      control.cancelled = true;
      control.cancelHandler?.();
      return { upload_url: "https://example.com/part" };
    },
    uploadToR2: async () => ({ headers: { etag: '"etag-2"' } }),
    completeMultipartUpload: async () => {
      throw new Error("取消后不应继续 complete");
    },
    abortMultipartUpload: async (payload) => {
      calls.abort.push(payload);
    },
  };

  await assert.rejects(runTask(api, rawFile, control), /UPLOAD_CANCELLED/);

  assert.equal(
    getUploadProgress(fileId),
    undefined,
    "取消 = 放弃：续传任务的本地进度记录必须被删除",
  );
  assert.deepEqual(
    calls.abort,
    [{ file_id: "server-resume" }],
    "服务端 abort 由 cancelTask 负责，catch 块不应重复调用",
  );
  assert.equal(calls.init, 0, "命中续传时不应回落到新上传");
});

test("续传失败（非取消）时保留进度记录供下次继续", async () => {
  reset();
  const rawFile = createRawFile({ name: "archive.zip" });
  const fileId = generateFileId(rawFile);
  saveUploadProgress(fileId, {
    serverFileId: "server-keep",
    uploadId: "upload-keep",
    filename: rawFile.name,
    size: rawFile.size,
    partSize: PART_SIZE,
    totalParts: 2,
    uploadedParts: [1, 2],
  });

  const control = { cancelled: false, cancelHandler: null };
  const calls = { abort: [] };

  const api = {
    getMultipartUploadedParts: async () => ({
      parts: [
        { PartNumber: 1, ETag: '"etag-1"' },
        { PartNumber: 2, ETag: '"etag-2"' },
      ],
    }),
    initMultipartUpload: async () => ({}),
    getMultipartUploadURL: async () => {
      throw new Error("全部分片已完成，不应再预签名");
    },
    uploadToR2: async () => ({ headers: { etag: '"etag-x"' } }),
    completeMultipartUpload: async () => {
      throw new Error("complete boom");
    },
    abortMultipartUpload: async (payload) => {
      calls.abort.push(payload);
    },
  };

  await assert.rejects(runTask(api, rawFile, control), /complete boom/);

  assert.equal(
    getUploadProgress(fileId)?.uploadId,
    "upload-keep",
    "续传失败不等于放弃，进度记录应保留",
  );
  assert.deepEqual(calls.abort, [], "续传失败不应 abort 服务端分片上传");
});

test("取消新上传任务同样删除进度记录且只 abort 一次", async () => {
  reset();
  const rawFile = createRawFile({ name: "fresh.bin" });
  const fileId = generateFileId(rawFile);

  const control = { cancelled: false, cancelHandler: null };
  const calls = { abort: [] };

  const api = {
    getMultipartUploadedParts: async () => {
      throw new Error("无本地进度时不应查询服务端分片");
    },
    initMultipartUpload: async () => ({
      file_id: "server-fresh",
      upload_id: "upload-fresh",
      part_size: PART_SIZE,
      total_parts: 3,
    }),
    getMultipartUploadURL: async () => {
      control.cancelled = true;
      control.cancelHandler?.();
      return { upload_url: "https://example.com/part" };
    },
    uploadToR2: async () => ({ headers: { etag: '"etag-1"' } }),
    completeMultipartUpload: async () => {
      throw new Error("取消后不应继续 complete");
    },
    abortMultipartUpload: async (payload) => {
      calls.abort.push(payload);
    },
  };

  await assert.rejects(runTask(api, rawFile, control), /UPLOAD_CANCELLED/);

  assert.equal(getUploadProgress(fileId), undefined);
  assert.deepEqual(calls.abort, [{ file_id: "server-fresh" }]);
});

test("取消落在 init 往返窗口内时补偿 abort，不留无人回收的分片上传", async () => {
  reset();
  const rawFile = createRawFile({ name: "early-cancel.bin" });
  const fileId = generateFileId(rawFile);

  const control = { cancelled: false, cancelHandler: null };
  const calls = { abort: [] };

  const api = {
    getMultipartUploadedParts: async () => {
      throw new Error("无本地进度时不应查询服务端分片");
    },
    initMultipartUpload: async () => {
      // 模拟用户在 init 往返期间就点了取消：此时 activeMultipart 尚未赋值，
      // cancelTask 会 early return 不发 abort
      control.cancelled = true;
      control.cancelHandler?.();
      return {
        file_id: "server-early",
        upload_id: "upload-early",
        part_size: PART_SIZE,
        total_parts: 3,
      };
    },
    getMultipartUploadURL: async () => {
      throw new Error("取消后不应继续预签名");
    },
    uploadToR2: async () => ({ headers: { etag: '"etag-1"' } }),
    completeMultipartUpload: async () => {
      throw new Error("取消后不应继续 complete");
    },
    abortMultipartUpload: async (payload) => {
      calls.abort.push(payload);
    },
  };

  await assert.rejects(runTask(api, rawFile, control), /UPLOAD_CANCELLED/);

  assert.equal(getUploadProgress(fileId), undefined);
  assert.deepEqual(
    calls.abort,
    [{ file_id: "server-early" }],
    "cancelTask 未发 abort 时 catch 块必须补偿一次，且只补偿一次",
  );
});

test("cancelTask 的 abort 仍在飞行中时 catch 块不补偿，abort 恰好一次", async () => {
  reset();
  const rawFile = createRawFile({ name: "slow-abort.bin" });
  const fileId = generateFileId(rawFile);
  saveUploadProgress(fileId, {
    serverFileId: "server-slow",
    uploadId: "upload-slow",
    filename: rawFile.name,
    size: rawFile.size,
    partSize: PART_SIZE,
    totalParts: 3,
    uploadedParts: [1],
  });

  const control = { cancelled: false, cancelHandler: null };
  const calls = { abort: [] };

  const api = {
    getMultipartUploadedParts: async () => ({
      parts: [{ PartNumber: 1, ETag: '"etag-1"' }],
    }),
    initMultipartUpload: async () => ({}),
    getMultipartUploadURL: async () => {
      control.cancelled = true;
      control.cancelHandler?.();
      return { upload_url: "https://example.com/part" };
    },
    uploadToR2: async () => ({ headers: { etag: '"etag-2"' } }),
    completeMultipartUpload: async () => {
      throw new Error("取消后不应继续 complete");
    },
    // abort 故意慢：cancelTask 发出请求后仍在飞行时 catch 块就已经在跑。
    // abortIssued 必须在 await 之前置位，否则此处会被补偿成第二次 abort。
    abortMultipartUpload: (payload) => {
      calls.abort.push(payload);
      return new Promise((resolve) => setTimeout(resolve, 10));
    },
  };

  await assert.rejects(runTask(api, rawFile, control), /UPLOAD_CANCELLED/);

  assert.deepEqual(
    calls.abort,
    [{ file_id: "server-slow" }],
    "abort 请求一旦发出就算已处理，catch 块不应在其未完成时再发一次",
  );
  assert.equal(getUploadProgress(fileId), undefined);

  // 等 cancelTask 挂着的 abort 落地，避免把未完成的工作留给下一个用例
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.abort.length, 1, "abort 最终总数仍为一次");
});

test("新上传失败（非取消）仍按既有行为 abort 并删除进度记录", async () => {
  reset();
  const rawFile = createRawFile({ name: "broken.bin" });
  const fileId = generateFileId(rawFile);

  const control = { cancelled: false, cancelHandler: null };
  const calls = { abort: [] };

  const api = {
    getMultipartUploadedParts: async () => {
      throw new Error("无本地进度时不应查询服务端分片");
    },
    initMultipartUpload: async () => ({
      file_id: "server-broken",
      upload_id: "upload-broken",
      part_size: FILE_SIZE,
      total_parts: 1,
    }),
    getMultipartUploadURL: async () => ({
      upload_url: "https://example.com/part",
    }),
    uploadToR2: async () => ({ headers: { etag: '"etag-1"' } }),
    completeMultipartUpload: async () => {
      throw new Error("complete boom");
    },
    abortMultipartUpload: async (payload) => {
      calls.abort.push(payload);
    },
  };

  await assert.rejects(runTask(api, rawFile, control), /complete boom/);

  assert.equal(getUploadProgress(fileId), undefined);
  assert.deepEqual(calls.abort, [{ file_id: "server-broken" }]);
});

// UploadPanel 用这个时序差来选刷新触发源：按条目状态刷新会读到删除前的快照，
// 把已放弃的记录重新显示成僵尸条目；按 activeItemId 刷新才读到删除后的状态。
test("cancelItem 同步置 cancelled 时记录尚未删除，activeItemId 复位后才删除", async () => {
  reset();
  const rawFile = createRawFile({ name: "zombie.bin" });
  const fileId = generateFileId(rawFile);
  saveUploadProgress(fileId, {
    serverFileId: "server-zombie",
    uploadId: "upload-zombie",
    filename: rawFile.name,
    size: rawFile.size,
    partSize: PART_SIZE,
    totalParts: 3,
    uploadedParts: [1],
  });

  let releaseInFlight = null;
  const api = {
    getMultipartUploadedParts: async () => ({
      parts: [{ PartNumber: 1, ETag: '"etag-1"' }],
    }),
    initMultipartUpload: async () => ({}),
    getMultipartUploadURL: async () => ({
      upload_url: "https://example.com/part",
    }),
    // 真实的在飞分片请求：直到 AbortController 触发才 reject
    uploadToR2: (_url, _chunk, _onProgress, { signal } = {}) =>
      new Promise((_resolve, reject) => {
        releaseInFlight = reject;
        signal?.addEventListener("abort", () => {
          const error = new Error("canceled");
          error.code = "ERR_CANCELED";
          reject(error);
        });
      }),
    completeMultipartUpload: async () => {
      throw new Error("取消后不应继续 complete");
    },
    abortMultipartUpload: () =>
      new Promise((resolve) => setTimeout(resolve, 5)),
  };

  const queue = useUploadQueue({
    runTask: createUploadTaskRunner({ api, t, onUploaded: () => {} }),
  });
  queue.enqueueFiles([createTaskFile(rawFile)]);

  for (let i = 0; i < 40 && !releaseInFlight; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(releaseInFlight, "任务应已进入分片在飞状态");

  const itemId = queue.items.value[0].id;
  assert.equal(queue.activeItemId.value, itemId);

  queue.cancelItem(itemId);

  assert.equal(
    queue.items.value[0].status,
    "cancelled",
    "cancelItem 同步改状态",
  );
  assert.ok(
    getUploadProgress(fileId),
    "状态已是 cancelled，但 runner 的 catch 还没删记录——按状态刷新会读到僵尸条目",
  );
  assert.equal(
    queue.activeItemId.value,
    itemId,
    "activeItemId 此刻尚未复位，正好把刷新挡在删除之后",
  );

  await queue.whenIdle();

  assert.equal(queue.activeItemId.value, "", "activeItemId 在终态后复位");
  assert.equal(
    getUploadProgress(fileId),
    undefined,
    "activeItemId 复位时记录必须已删除，刷新才拿不到僵尸条目",
  );
});
