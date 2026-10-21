import test from "node:test";
import assert from "node:assert/strict";
import { useUploadQueue } from "../../../frontend/src/composables/useUploadQueue.js";
import { createUploadTaskRunner } from "../../../frontend/src/services/uploadTaskRunner.js";
import {
  buildUploadScope,
  generateScopedFileId,
  getUploadProgress,
  saveUploadProgress,
} from "../../../frontend/src/utils/uploadResume.js";
import { useUploadResumeEntries } from "../../../frontend/src/composables/useUploadResumeEntries.js";
const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: (key) => values.delete(key),
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const file = {
  name: "demo",
  size: 10,
  type: "text/plain",
  configType: "webdav",
  rawFile: { name: "demo", size: 10, lastModified: 1 },
};

test("server upload cancellation aborts network and suppresses success notification", async () => {
  let resolveUpload,
    signal,
    notify = 0;
  const runner = createUploadTaskRunner({
    t: (key) => key,
    onUploaded: () => {
      notify++;
    },
    api: {
      serverUpload: (options) => {
        signal = options.signal;
        return new Promise((resolve) => {
          resolveUpload = resolve;
        });
      },
    },
  });
  const queue = useUploadQueue({ runTask: runner });
  queue.enqueueFiles([file]);
  await tick();
  queue.cancelItem(queue.items.value[0].id);
  assert.equal(signal.aborted, true);
  resolveUpload({ filename: "old" });
  await queue.whenIdle();
  assert.equal(notify, 0);
  assert.equal(queue.items.value[0].status, "cancelled");
});
test("immediate retry waits for old cleanup and ignores late progress and result", async () => {
  const runs = [];
  const queue = useUploadQueue({
    concurrency: 2,
    runTask: (_item, control) =>
      new Promise((resolve) => runs.push({ control, resolve })),
  });
  queue.enqueueFiles([file]);
  await tick();
  const item = queue.items.value[0];
  queue.cancelItem(item.id);
  queue.retryItem(item.id);
  await tick();
  assert.equal(runs.length, 1);
  runs[0].control.updateItem({ progress: 99 });
  assert.equal(item.progress, 0);
  runs[0].resolve({ filename: "stale" });
  await tick();
  assert.equal(runs.length, 2);
  assert.equal(item.status, "uploading");
  runs[0].control.updateItem({ progress: 99 });
  assert.equal(item.progress, 0);
  assert.equal(runs[1].control.isCancelled(), false);
  runs[1].resolve({ filename: "current" });
  await queue.whenIdle();
  assert.equal(item.status, "success");
  assert.equal(item.result.filename, "current");
});
test("resume records are isolated by account, config, directory and access settings", () => {
  values.clear();
  const settings = {
    configId: "c",
    dir: "docs",
    expiresIn: 7,
    requireLogin: true,
  };
  const scope = buildUploadScope("alice", settings);
  const id = generateScopedFileId(file.rawFile, scope);
  saveUploadProgress(id, {
    ownerId: "alice",
    scope,
    settings,
    fingerprint: "demo_10_1",
    serverFileId: "f",
    uploadId: "mp",
    filename: "demo",
    size: 10,
    partSize: 10,
    totalParts: 1,
  });
  for (const [owner, changed] of [
    ["bob", settings],
    ["alice", { ...settings, configId: "d" }],
    ["alice", { ...settings, dir: "other" }],
    ["alice", { ...settings, requireLogin: false }],
    ["alice", { ...settings, expiresIn: 0 }],
  ]) {
    assert.equal(
      getUploadProgress(
        generateScopedFileId(file.rawFile, buildUploadScope(owner, changed)),
      ),
      undefined,
    );
  }
  let owner = "alice";
  const entries = useUploadResumeEntries({
    api: {},
    t: (key) => key,
    message: {},
    getOwnerId: () => owner,
  });
  entries.refreshResumeEntries();
  assert.equal(entries.resumeEntries.value.length, 1);
  owner = "bob";
  entries.refreshResumeEntries();
  assert.equal(entries.resumeEntries.value.length, 0);
});
test("account change during server request suppresses stale completion", async () => {
  let owner = "alice",
    release,
    notify = 0;
  const queue = useUploadQueue({
    runTask: createUploadTaskRunner({
      api: {
        serverUpload: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
      t: (key) => key,
      getOwnerId: () => owner,
      onUploaded: () => {
        notify++;
      },
    }),
  });
  queue.enqueueFiles([file]);
  await tick();
  owner = "bob";
  release({ filename: "old" });
  await queue.whenIdle();
  assert.equal(notify, 0);
  assert.equal(queue.items.value[0].status, "cancelled");
});
