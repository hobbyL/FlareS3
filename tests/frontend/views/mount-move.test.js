import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildMountFolderNodes,
  buildMountMoveTargetKey,
  getMountObjectDirPrefix,
  isSameMountMoveTarget,
} from "../../../frontend/src/utils/mountObjects.js";

const readSource = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("getMountObjectDirPrefix returns to_dir-compatible directory prefixes", () => {
  assert.equal(getMountObjectDirPrefix("docs/team/a.txt"), "docs/team");
  assert.equal(getMountObjectDirPrefix("a.txt"), "");
  assert.equal(getMountObjectDirPrefix(""), "");
});

test("buildMountMoveTargetKey joins target dir and file name like the backend", () => {
  assert.equal(buildMountMoveTargetKey("docs", "b.txt"), "docs/b.txt");
  assert.equal(buildMountMoveTargetKey("", "b.txt"), "b.txt");
  // 尾斜杠容错
  assert.equal(buildMountMoveTargetKey("docs/", "b.txt"), "docs/b.txt");
  // 缺文件名时不得产出目标 key
  assert.equal(buildMountMoveTargetKey("docs", "  "), "");
});

test("isSameMountMoveTarget detects no-op moves", () => {
  assert.equal(isSameMountMoveTarget("docs/a.txt", "docs", "a.txt"), true);
  assert.equal(isSameMountMoveTarget("docs/a.txt", "", "a.txt"), false);
  assert.equal(isSameMountMoveTarget("docs/a.txt", "docs", "b.txt"), false);
  assert.equal(isSameMountMoveTarget("docs/a.txt", "docs", ""), false);
});

test("buildMountFolderNodes extracts folder rows for the lazy tree", () => {
  assert.deepEqual(
    buildMountFolderNodes({
      basePrefix: "docs/",
      folders: ["docs/team/", "docs/archive/"],
    }),
    [
      { kind: "folder", key: "docs/team/", name: "team" },
      { kind: "folder", key: "docs/archive/", name: "archive" },
    ],
  );

  assert.deepEqual(buildMountFolderNodes({ basePrefix: "", folders: [] }), []);
});

test("api.js exposes moveMountObject posting snake_case body to /mount/move", () => {
  const source = readSource("../../../frontend/src/services/api.js");
  assert.match(source, /moveMountObject/);
  assert.match(source, /api\.post\('\/mount\/move'/);
  assert.match(source, /to_dir: toDir/);
  assert.match(source, /new_name: newName/);
});

test("Mount.vue wires the unified move modal and refreshes after success", () => {
  const source = readSource("../../../frontend/src/views/Mount.vue");
  assert.match(source, /MountMoveModal/);
  assert.match(source, /openMoveModal\(key, 'rename'\)/);
  assert.match(source, /openMoveModal\(key, 'move'\)/);
  assert.match(source, /api\.moveMountObject\(/);
  assert.match(source, /mount\.move\.failed/);
  assert.match(source, /loadMountFolderNodes/);
  assert.match(source, /listMountedObjects\(/);
});

test("Mount move modal guards same-target submits and resets via watch(show, immediate)", () => {
  const source = readSource(
    "../../../frontend/src/components/mount/MountMoveModal.vue",
  );
  assert.match(source, /isSameMountMoveTarget/);
  assert.match(source, /watch\(/);
  assert.match(source, /immediate:\s*true/);
  assert.match(source, /emit\('confirm',\s*\{/);
  assert.match(source, /toDir:\s*selectedDir\.value/);
  assert.match(source, /newName:\s*fileName\.value\.trim\(\)/);
});

test("mount table columns and card view expose rename/move entries for objects", () => {
  const columnsSource = readSource(
    "../../../frontend/src/components/mount/mountTableColumns.js",
  );
  assert.match(columnsSource, /onRenameObject/);
  assert.match(columnsSource, /onMoveObject/);
  assert.match(columnsSource, /mount\.move\.actionRename/);
  assert.match(columnsSource, /mount\.move\.actionMove/);

  const cardSource = readSource(
    "../../../frontend/src/components/mount/MountCardView.vue",
  );
  assert.match(cardSource, /emit\('rename',\s*row\.key\)/);
  assert.match(cardSource, /emit\('move',\s*row\.key\)/);

  const panelSource = readSource(
    "../../../frontend/src/components/mount/MountBrowserPanel.vue",
  );
  assert.match(panelSource, /@rename="emit\('rename',\s*\$event\)"/);
  assert.match(panelSource, /@move="emit\('move',\s*\$event\)"/);
});
