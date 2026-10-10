import test from "node:test";
import assert from "node:assert/strict";

import { useUploadQueue } from "../../../frontend/src/composables/useUploadQueue.js";

function createFile(name, size = 128, type = "application/octet-stream") {
  return { name, size, type };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("useUploadQueue runs tasks sequentially and stores latest success result", async () => {
  const execution = [];
  const queue = useUploadQueue({
    runTask: async (item, { updateItem }) => {
      execution.push(item.file.name);
      updateItem({
        progress: 100,
        uploadedBytes: item.file.size,
      });
      return {
        filename: item.file.name,
        shortUrl: `/s/${item.file.name}`,
      };
    },
  });

  queue.enqueueFiles([createFile("a.bin", 100), createFile("b.bin", 200)]);
  await queue.whenIdle();

  assert.deepEqual(execution, ["a.bin", "b.bin"]);
  assert.deepEqual(
    queue.items.value.map((item) => ({
      name: item.file.name,
      status: item.status,
    })),
    [
      { name: "a.bin", status: "success" },
      { name: "b.bin", status: "success" },
    ],
  );
  assert.equal(queue.latestSuccessItem.value?.file.name, "b.bin");
  assert.equal(queue.latestSuccessItem.value?.result?.shortUrl, "/s/b.bin");
});

test("useUploadQueue cancels only the active item and keeps queued items running", async () => {
  let currentReject = null;
  const execution = [];
  const queue = useUploadQueue({
    runTask: async (item, { setCancel }) => {
      execution.push(item.file.name);

      if (item.file.name === "first.bin") {
        await new Promise((resolve, reject) => {
          currentReject = reject;
          setCancel(() => {
            reject(new Error("UPLOAD_CANCELLED"));
          });
        });
        return { filename: item.file.name };
      }

      return { filename: item.file.name };
    },
  });

  queue.enqueueFiles([createFile("first.bin"), createFile("second.bin")]);

  await Promise.resolve();
  const [firstItem] = queue.items.value;
  queue.cancelItem(firstItem.id);
  currentReject?.(new Error("UPLOAD_CANCELLED"));

  await queue.whenIdle();

  assert.deepEqual(execution, ["first.bin", "second.bin"]);
  assert.deepEqual(
    queue.items.value.map((item) => ({
      name: item.file.name,
      status: item.status,
    })),
    [
      { name: "first.bin", status: "cancelled" },
      { name: "second.bin", status: "success" },
    ],
  );
});

test("useUploadQueue caps simultaneous tasks at the configured concurrency", async () => {
  const resolvers = [];
  let activeCount = 0;
  let maxActive = 0;
  const queue = useUploadQueue({
    concurrency: 2,
    runTask: (item) =>
      new Promise((resolve) => {
        activeCount += 1;
        maxActive = Math.max(maxActive, activeCount);
        resolvers.push(() => {
          activeCount -= 1;
          resolve({ filename: item.file.name });
        });
      }),
  });

  queue.enqueueFiles([
    createFile("a.bin"),
    createFile("b.bin"),
    createFile("c.bin"),
    createFile("d.bin"),
  ]);
  await tick();

  assert.equal(resolvers.length, 2, "只有并发上限数量的任务同时在跑");
  assert.equal(maxActive, 2);
  assert.deepEqual(
    queue.items.value.map((item) => item.status),
    ["uploading", "uploading", "queued", "queued"],
  );

  // 逐个放行，验证空槽补位且并发始终不超上限
  while (resolvers.length) {
    const next = resolvers.shift();
    next();
    await tick();
  }
  await queue.whenIdle();

  assert.equal(maxActive, 2, "整个过程并发不超过 2");
  assert.ok(queue.items.value.every((item) => item.status === "success"));
});

test("useUploadQueue does not start tasks while paused and resumes afterwards", async () => {
  const executed = [];
  const queue = useUploadQueue({
    concurrency: 2,
    runTask: async (item) => {
      executed.push(item.file.name);
      return { filename: item.file.name };
    },
  });

  queue.pause();
  queue.enqueueFiles([createFile("a.bin"), createFile("b.bin")]);
  await tick();

  assert.deepEqual(executed, [], "暂停时不启动任何任务");
  assert.deepEqual(
    queue.items.value.map((item) => item.status),
    ["queued", "queued"],
  );
  assert.equal(queue.paused.value, true);

  queue.resume();
  await queue.whenIdle();

  assert.deepEqual([...executed].sort(), ["a.bin", "b.bin"]);
  assert.equal(queue.paused.value, false);
  assert.ok(queue.items.value.every((item) => item.status === "success"));
});

test("useUploadQueue suspends an in-flight task at the chunk boundary when paused", async () => {
  const steps = [];
  let releasePart1 = null;
  const queue = useUploadQueue({
    concurrency: 1,
    runTask: async (item, { waitWhilePaused }) => {
      steps.push("part1-start");
      await new Promise((resolve) => {
        releasePart1 = resolve;
      });
      steps.push("part1-done");
      // 分片边界：暂停时在此挂起，不中止已发出的分片
      await waitWhilePaused();
      steps.push("part2-start");
      return { filename: item.file.name };
    },
  });

  queue.enqueueFiles([createFile("big.bin")]);
  await tick();
  assert.deepEqual(steps, ["part1-start"]);

  // part1 在飞时请求暂停
  queue.pause();
  // 放行 part1：当前分片应跑完，但不得进入 part2
  releasePart1();
  await tick();

  assert.deepEqual(
    steps,
    ["part1-start", "part1-done"],
    "当前分片跑完后在分片边界挂起，不进入下一分片",
  );
  assert.equal(queue.items.value[0].status, "uploading");

  queue.resume();
  await queue.whenIdle();

  assert.deepEqual(steps, ["part1-start", "part1-done", "part2-start"]);
  assert.equal(queue.items.value[0].status, "success");
});
