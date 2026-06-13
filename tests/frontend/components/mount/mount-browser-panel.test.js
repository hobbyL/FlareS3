import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../frontend/src/components/mount/MountBrowserPanel.vue",
    import.meta.url,
  ),
  "utf8",
);

test("MountBrowserPanel forwards browser navigation and object actions to Mount.vue", () => {
  for (const eventName of [
    "go-root",
    "go-up",
    "navigate",
    "update:page",
    "update:page-size",
    "open-folder",
    "preview",
    "download",
    "delete",
    "load-more",
  ]) {
    assert.match(
      source,
      new RegExp(`'${eventName}'`),
      `${eventName} should be declared`,
    );
  }

  assert.match(
    source,
    /@navigate="emit\('navigate', \$event\)"/,
    "path toolbar navigation should be returned to Mount.vue",
  );
  assert.match(
    source,
    /@update:page="emit\('update:page', \$event\)"/,
    "table pagination page changes should be returned to Mount.vue",
  );
  assert.match(
    source,
    /@open-folder="emit\('open-folder', \$event\)"/,
    "card folder opens should be returned to Mount.vue",
  );
});

test("MountBrowserPanel owns browser layout and lazy card rendering", () => {
  assert.match(
    source,
    /const MountCardView = defineAsyncComponent/,
    "card view should stay lazy-loaded behind the browser panel",
  );
  assert.match(
    source,
    /@media \(max-width:\s*768px\)/,
    "browser panel mobile breakpoint should match the app shell",
  );
  assert.match(
    source,
    /\.mount-browser-panel[\s\S]*flex-direction:\s*column/,
    "card browser panel layout should stay in the extracted component",
  );
});
