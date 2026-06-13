import test from "node:test";
import assert from "node:assert/strict";

import { useUploadQueue } from "../../../frontend/src/composables/useUploadQueue.js";

function createFile(name, size = 128, type = "application/octet-stream") {
  return { name, size, type };
}

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
