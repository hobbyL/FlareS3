import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readComponent = (filename) =>
  readFileSync(
    new URL(
      `../../../../frontend/src/components/mount/${filename}`,
      import.meta.url,
    ),
    "utf8",
  );

const deleteModalSource = readComponent("MountDeleteConfirmModal.vue");
const folderModalSource = readComponent("MountFolderModal.vue");
const uploadProgressModalSource = readComponent("MountUploadProgressModal.vue");

test("Mount action modals keep parent-owned visibility and submit actions", () => {
  assert.match(
    deleteModalSource,
    /@update:show="emit\('update:show', \$event\)"/,
    "delete modal should return visibility changes to Mount.vue",
  );
  assert.match(
    deleteModalSource,
    /emit\('cancel'\)/,
    "delete cancel should stay parent-owned",
  );
  assert.match(
    deleteModalSource,
    /emit\('confirm'\)/,
    "delete confirm should stay parent-owned",
  );

  assert.match(
    folderModalSource,
    /@update:model-value="emit\('update:folderName', \$event\)"/,
    "folder name should be returned to Mount.vue",
  );
  assert.match(
    folderModalSource,
    /emit\('create'\)/,
    "folder creation should stay parent-owned",
  );
});

test("Mount upload progress modal stays locked while uploading", () => {
  assert.match(
    uploadProgressModalSource,
    /:closable="!uploading"/,
    "upload progress modal should not be closable during active upload",
  );
  assert.match(
    uploadProgressModalSource,
    /v-if="!uploading"[\s\S]*emit\('update:show', false\)/,
    "close button should only be available after upload finishes",
  );
});
