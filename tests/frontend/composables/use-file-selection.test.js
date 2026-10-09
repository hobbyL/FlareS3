import test from "node:test";
import assert from "node:assert/strict";
// vue 只装在 frontend/node_modules，经 helpers 显式解析（见 helpers/vue.js 注释）
import { ref } from "../helpers/vue.js";

import { useFileSelection } from "../../../frontend/src/composables/useFileSelection.js";

const rows = (ids) => ids.map((id) => ({ id }));

test("useFileSelection toggles rows and reports counts", () => {
  const items = ref(rows(["a", "b", "c"]));
  const sel = useFileSelection(items);

  assert.equal(sel.selectedFilesCount.value, 0);
  assert.equal(sel.allRowsSelected.value, false);

  sel.toggleRowSelection("a", true);
  sel.toggleRowSelection("b", true);
  assert.equal(sel.selectedFilesCount.value, 2);
  assert.ok(sel.selectedIdSet.value.has("a"));
  assert.equal(sel.selectAllIndeterminate.value, true);

  sel.toggleRowSelection("a", false);
  assert.equal(sel.selectedFilesCount.value, 1);
});

test("useFileSelection select-all and clear operate on current page rows", () => {
  const items = ref(rows(["a", "b", "c"]));
  const sel = useFileSelection(items);

  sel.toggleSelectAll(true);
  assert.equal(sel.selectedFilesCount.value, 3);
  assert.equal(sel.allRowsSelected.value, true);
  assert.equal(sel.selectAllIndeterminate.value, false);

  sel.toggleSelectAll(false);
  assert.equal(sel.selectedFilesCount.value, 0);

  sel.toggleRowSelection("a", true);
  sel.clearSelection();
  assert.equal(sel.selectedFilesCount.value, 0);
});

test("useFileSelection ignores empty ids and drops stale selections from collectSelectedFiles", () => {
  const items = ref(rows(["a", "b"]));
  const sel = useFileSelection(items);

  // 空 rowId 不写入
  sel.toggleRowSelection("", true);
  sel.toggleRowSelection("   ", true);
  assert.equal(sel.selectedFilesCount.value, 0);

  // 选中后页面行变化（翻页）：collectSelectedFiles 只返回仍在页上的行
  sel.toggleRowSelection("a", true);
  sel.toggleRowSelection("b", true);
  items.value = rows(["b", "c"]);
  assert.deepEqual(
    sel.selectedFiles.value.map((item) => item.id),
    ["b"],
  );
  // pageRowIds 跟随当前页
  assert.deepEqual(sel.pageRowIds.value, ["b", "c"]);
});

test("useFileSelection pageRowIds filters rows without ids", () => {
  const items = ref([{ id: "a" }, { id: "" }, { foo: 1 }, { id: "b" }]);
  const sel = useFileSelection(items);
  assert.deepEqual(sel.pageRowIds.value, ["a", "b"]);
});
