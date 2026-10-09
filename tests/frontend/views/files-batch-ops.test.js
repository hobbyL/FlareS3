import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const filesViewSource = read("../../../frontend/src/views/Files.vue");
const columnsSource = read(
  "../../../frontend/src/components/files/fileTableColumns.js",
);
const cardSource = read(
  "../../../frontend/src/components/files/FilesCardView.vue",
);
const barSource = read(
  "../../../frontend/src/components/files/FilesBatchActionBar.vue",
);
const apiSource = read("../../../frontend/src/services/api.js");

test("fileTableColumns gates a selection column behind selectionEnabled", () => {
  assert.match(columnsSource, /selectionEnabled = false/);
  assert.match(columnsSource, /if \(selectionEnabled\) \{/);
  assert.match(columnsSource, /key: 'select'/);
  // 选择列用 unshift 置于首位
  assert.match(columnsSource, /columns\.unshift\(/);
  assert.match(columnsSource, /onToggleSelectAll\(Boolean/);
  assert.match(columnsSource, /onToggleRowSelection\(id, Boolean/);
});

test("Files.vue wires useFileSelection and clears selection on page / filter / mode changes", () => {
  assert.match(filesViewSource, /useFileSelection\(filesRef\)/);
  // 批量条挂载 + 事件接线
  assert.match(filesViewSource, /<FilesBatchActionBar/);
  assert.match(filesViewSource, /:count="selectedFilesCount"/);
  // 清空时机：翻页 / 改页大小 / 切模式 / 搜索
  const changePageBlock = filesViewSource.slice(
    filesViewSource.indexOf("const changePage ="),
    filesViewSource.indexOf("const loadMore ="),
  );
  assert.match(changePageBlock, /clearSelection\(\)/);
  const setModeBlock = filesViewSource.slice(
    filesViewSource.indexOf("const setFilesMode ="),
    filesViewSource.indexOf("const handleUploaded ="),
  );
  assert.match(setModeBlock, /clearSelection\(\)/);
  assert.match(filesViewSource, /const handleSearch[\s\S]*?clearSelection\(\)/);
});

test("Files.vue batch handlers route to the three batch api methods", () => {
  assert.match(filesViewSource, /api\.batchDeleteFiles\(ids\)/);
  assert.match(filesViewSource, /api\.batchRestoreFiles\(ids\)/);
  assert.match(filesViewSource, /api\.batchPermanentDeleteFiles\(ids\)/);
  // 永久删除走危险确认弹窗，恢复直接执行
  assert.match(filesViewSource, /openBatchModal\('permanent-delete'\)/);
  assert.match(filesViewSource, /@restore="handleBatchRestore"/);
  // skipped 用 reasons 机器码翻译
  assert.match(filesViewSource, /files\.batch\.reasons\.\$\{item\.reason\}/);
});

test("FilesCardView exposes selection checkbox behind selectionEnabled", () => {
  assert.match(cardSource, /selectionEnabled: \{/);
  assert.match(cardSource, /selectedIdSet: \{/);
  assert.match(cardSource, /emit\('toggle-selection'/);
  assert.match(cardSource, /is-selected/);
});

test("FilesBatchActionBar only renders when count > 0 and emits the batch events", () => {
  assert.match(barSource, /v-if="count > 0"/);
  for (const event of ["delete", "restore", "permanent-delete", "clear"]) {
    assert.match(barSource, new RegExp(`emit\\('${event}'\\)`));
  }
});

test("api layer exposes the three batch endpoints", () => {
  assert.match(
    apiSource,
    /batchDeleteFiles\(ids = \[\]\) \{\s*return api\.post\('\/files\/batch-delete', \{ ids \}\)/,
  );
  assert.match(
    apiSource,
    /batchRestoreFiles\(ids = \[\]\) \{\s*return api\.post\('\/files\/trash\/batch-restore', \{ ids \}\)/,
  );
  assert.match(
    apiSource,
    /batchPermanentDeleteFiles\(ids = \[\]\) \{\s*return api\.post\('\/files\/trash\/batch-permanent-delete', \{ ids \}\)/,
  );
});

test("files batch i18n keys stay in sync across zh-CN / en-US", () => {
  const zh = read("../../../frontend/src/locales/zh-CN/pages/files.js");
  const en = read("../../../frontend/src/locales/en-US/pages/files.js");
  for (const key of [
    "selected",
    "clear",
    "delete",
    "restore",
    "permanentDelete",
    "deleteTitle",
    "restoreTitle",
    "permanentDeleteTitle",
    "confirmDelete",
    "confirmRestore",
    "confirmPermanentDelete",
    "deleteSuccess",
    "restoreSuccess",
    "permanentDeleteSuccess",
    "partial",
    "failed",
  ]) {
    assert.match(zh, new RegExp(`${key}:`), `zh-CN 缺少 files.batch.${key}`);
    assert.match(en, new RegExp(`${key}:`), `en-US 缺少 files.batch.${key}`);
  }
  for (const reason of [
    "not_found",
    "forbidden",
    "already_trashed",
    "not_in_trash",
    "expired",
    "object_missing",
    "config_missing",
    "check_failed",
  ]) {
    assert.match(
      zh,
      new RegExp(`${reason}:`),
      `zh-CN 缺少 files.batch.reasons.${reason}`,
    );
    assert.match(
      en,
      new RegExp(`${reason}:`),
      `en-US 缺少 files.batch.reasons.${reason}`,
    );
  }
});
