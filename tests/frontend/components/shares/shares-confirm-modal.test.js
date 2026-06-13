import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../frontend/src/components/shares/SharesConfirmModal.vue",
    import.meta.url,
  ),
  "utf8",
);

test("SharesConfirmModal keeps visibility and submit actions parent-owned", () => {
  for (const eventName of ["update:show", "cancel", "submit"]) {
    assert.match(
      source,
      new RegExp(`'${eventName}'`),
      `${eventName} should be declared`,
    );
  }

  assert.match(
    source,
    /@update:show="emit\('update:show', \$event\)"/,
    "modal visibility changes should be returned to Shares.vue",
  );
  assert.match(
    source,
    /@click="emit\('cancel'\)"/,
    "cancel should be handled by Shares.vue",
  );
  assert.match(
    source,
    /@click="emit\('submit'\)"/,
    "submit should be handled by Shares.vue",
  );
  assert.match(
    source,
    /:disabled="disabled"/,
    "confirm button disabled state should remain controlled by Shares.vue",
  );
});
