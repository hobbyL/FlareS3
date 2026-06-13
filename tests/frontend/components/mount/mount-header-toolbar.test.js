import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../frontend/src/components/mount/MountHeaderToolbar.vue",
    import.meta.url,
  ),
  "utf8",
);

test("MountHeaderToolbar forwards page-owned state changes and actions", () => {
  for (const eventName of [
    "update:selectedConfigId",
    "update:prefixInput",
    "apply-prefix",
    "refresh",
    "upload-file-change",
    "show-new-folder",
    "set-view-mode",
  ]) {
    assert.match(
      source,
      new RegExp(`'${eventName}'`),
      `${eventName} should be declared`,
    );
  }

  assert.match(
    source,
    /@update:model-value="emitSelectedConfigId"/,
    "config selection should be returned to Mount.vue",
  );
  assert.match(
    source,
    /@update:model-value="emitPrefixInput"/,
    "prefix input should be returned to Mount.vue",
  );
  assert.match(
    source,
    /@change="emit\('upload-file-change', \$event\)"/,
    "file input changes should be returned to Mount.vue",
  );
});

test("MountHeaderToolbar keeps upload input reset and responsive layout behavior", () => {
  assert.match(
    source,
    /input\.value = ''[\s\S]*input\.click\(\)/,
    "upload file input should be reset before opening the file picker",
  );
  assert.match(
    source,
    /@media \(max-width:\s*768px\)/,
    "toolbar mobile breakpoint should match the app shell",
  );
  assert.match(
    source,
    /\.filter-row[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    "mount toolbar should preserve the two-column mobile action grid",
  );
});
