import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFileSelectedIdSet,
  collectSelectedFiles,
  toFileSelectionKey,
  updateFileSelection,
} from "../../../frontend/src/utils/files.js";

test("toFileSelectionKey returns trimmed id or empty string", () => {
  assert.equal(toFileSelectionKey({ id: " abc " }), "abc");
  assert.equal(toFileSelectionKey({ id: 123 }), "123");
  assert.equal(toFileSelectionKey({}), "");
  assert.equal(toFileSelectionKey(null), "");
  assert.equal(toFileSelectionKey(undefined), "");
});

test("buildFileSelectedIdSet dedupes and drops empty entries", () => {
  const set = buildFileSelectedIdSet([
    "a",
    "a",
    "",
    "  ",
    "b",
    null,
    undefined,
  ]);
  assert.deepEqual([...set].sort(), ["a", "b"]);
});

test("collectSelectedFiles returns only on-page rows that are selected", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(
    collectSelectedFiles(items, ["a", "c", "ghost"]).map((item) => item.id),
    ["a", "c"],
  );
  assert.deepEqual(collectSelectedFiles(items, []), []);
  assert.deepEqual(collectSelectedFiles([], ["a"]), []);
});

test("updateFileSelection adds and removes immutably, ignoring empty ids", () => {
  const start = ["a"];
  const added = updateFileSelection(start, "b", true);
  assert.deepEqual(added.sort(), ["a", "b"]);
  assert.notEqual(added, start);

  const removed = updateFileSelection(["a", "b"], "a", false);
  assert.deepEqual(removed, ["b"]);

  // 空 id 原样返回
  const unchanged = updateFileSelection(["a"], "  ", true);
  assert.deepEqual(unchanged, ["a"]);
});
