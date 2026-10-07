import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSource = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("api.js exposes renameFile posting new_name to the file rename endpoint", () => {
  const source = readSource("../../../frontend/src/services/api.js");
  assert.match(source, /renameFile\(fileId, payload\)/);
  assert.match(source, /api\.post\(`\/files\/\$\{fileId\}\/rename`, payload\)/);
});

test("file table columns only enable rename for completed uploads", () => {
  const source = readSource(
    "../../../frontend/src/components/files/fileTableColumns.js",
  );
  assert.match(source, /onRenameFile/);
  assert.match(source, /row\.upload_status !== 'completed'/);
  assert.match(source, /files\.rename\.action/);
});

test("files card view emits rename with the row payload", () => {
  const source = readSource(
    "../../../frontend/src/components/files/FilesCardView.vue",
  );
  assert.match(source, /emit\('rename',\s*row\)/);
  assert.match(source, /row\.upload_status !== 'completed'/);
});

test("Files.vue guards the rename entry and refreshes after rename", () => {
  const source = readSource("../../../frontend/src/views/Files.vue");
  assert.match(source, /FileRenameModal/);
  assert.match(
    source,
    /row\.upload_status === 'completed' && !isFileDeleted\(row\)/,
  );
  assert.match(source, /api\.renameFile\(fileId,\s*\{ new_name: newName \}\)/);
  assert.match(source, /files\.messages\.renameSuccess/);
  assert.match(source, /files\.messages\.renameFailed/);
});

test("FileRenameModal submits only non-empty trimmed names", () => {
  const source = readSource(
    "../../../frontend/src/components/files/FileRenameModal.vue",
  );
  assert.match(source, /files\.rename\.title/);
  assert.match(source, /emit\('confirm'\)/);
  assert.match(source, /!\String\(filename \|\| ''\)\.trim\(\)/);
});
