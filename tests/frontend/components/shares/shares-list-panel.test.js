import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../frontend/src/components/shares/SharesListPanel.vue",
    import.meta.url,
  ),
  "utf8",
);

test("SharesListPanel forwards table, card, and pagination events to Shares.vue", () => {
  for (const eventName of [
    "update:page",
    "update:page-size",
    "copy-link",
    "open-link",
    "edit",
    "disable",
    "regenerate",
    "toggle-select",
  ]) {
    assert.match(
      source,
      new RegExp(`'${eventName}'`),
      `${eventName} should be declared`,
    );
  }

  assert.match(
    source,
    /@toggle-select="\(\s*rowId,\s*checked\s*\) => emit\('toggle-select', rowId, checked\)"/,
    "mobile card row selection should keep both selection arguments",
  );
  assert.match(
    source,
    /@update:page="emit\('update:page', \$event\)"/,
    "pagination page changes should be returned to Shares.vue",
  );
  assert.match(
    source,
    /@update:page-size="emit\('update:page-size', \$event\)"/,
    "pagination page-size changes should be returned to Shares.vue",
  );
});

test("SharesListPanel owns share table layout styles after extraction", () => {
  assert.match(
    source,
    /:deep\(\.shares-table \.brutal-table\)[\s\S]*table-layout:\s*fixed/,
    "desktop share table fixed layout should stay with the list panel",
  );
  assert.match(
    source,
    /@media \(max-width:\s*768px\)/,
    "list panel mobile breakpoint should match the app shell",
  );
  assert.match(
    source,
    /const SharesCardView = defineAsyncComponent/,
    "mobile card view should remain lazy-loaded",
  );
});
