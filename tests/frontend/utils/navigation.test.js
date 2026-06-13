import test from "node:test";
import assert from "node:assert/strict";

import { buildSidebarMenuItems } from "../../../frontend/src/utils/navigation.js";

const t = (key) => key;

test("buildSidebarMenuItems keeps dashboard at the top for admins", () => {
  assert.deepEqual(
    buildSidebarMenuItems({ isAdmin: true, t }).map((item) => item.path),
    [
      "/dashboard",
      "/",
      "/texts",
      "/shares",
      "/mount",
      "/users",
      "/audit",
      "/setup",
    ],
  );
});

test("buildSidebarMenuItems keeps regular user navigation unchanged", () => {
  assert.deepEqual(
    buildSidebarMenuItems({ isAdmin: false, t }).map((item) => item.path),
    ["/", "/texts", "/shares"],
  );
});
