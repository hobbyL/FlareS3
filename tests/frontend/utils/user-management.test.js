import test from "node:test";
import assert from "node:assert/strict";

import {
  buildUserEditPayload,
  createUserEditForm,
  quotaBytesToGigabytesInput,
  quotaGigabytesToBytes,
} from "../../../frontend/src/utils/userManagement.js";

test("quotaGigabytesToBytes validates user input", () => {
  assert.equal(quotaGigabytesToBytes("10"), 10 * 1024 * 1024 * 1024);
  assert.equal(quotaGigabytesToBytes("1.5"), 1610612736);
  assert.equal(quotaGigabytesToBytes("0"), null);
  assert.equal(quotaGigabytesToBytes("abc"), null);
});

test("createUserEditForm normalizes row data for modal usage", () => {
  assert.deepEqual(
    createUserEditForm({
      username: "alice",
      role: "admin",
      status: "disabled",
      quota_bytes: 5 * 1024 * 1024 * 1024,
    }),
    {
      username: "alice",
      role: "admin",
      status: "disabled",
      quota_gb: "5",
    },
  );

  assert.equal(quotaBytesToGigabytesInput(undefined), "10");
});

test("buildUserEditPayload only submits changed editable fields", () => {
  const initialUser = {
    role: "user",
    status: "active",
    quota_bytes: 10 * 1024 * 1024 * 1024,
  };

  assert.deepEqual(
    buildUserEditPayload(initialUser, {
      role: "admin",
      status: "active",
      quota_gb: "10",
    }),
    { role: "admin" },
  );

  assert.deepEqual(
    buildUserEditPayload(initialUser, {
      role: "user",
      status: "disabled",
      quota_gb: "12",
    }),
    {
      status: "disabled",
      quota_bytes: 12 * 1024 * 1024 * 1024,
    },
  );

  assert.deepEqual(
    buildUserEditPayload(initialUser, {
      role: "user",
      status: "active",
      quota_gb: "bad-input",
    }),
    { quota_bytes: null },
  );
});
