import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFilesQueryParams,
  canManageFileShare,
  formatFileBytes,
  getFileDisplayStatus,
  getFileExpiresText,
  getFileRemainingText,
  getFileStatusState,
} from "../../../frontend/src/utils/files.js";

test("getFileStatusState distinguishes deleted, expired and active files", () => {
  const nowMs = Date.parse("2026-04-21T00:00:00.000Z");

  assert.deepEqual(
    getFileStatusState(
      {
        upload_status: "deleted",
        expires_at: "9999-12-31T23:59:59.999Z",
      },
      nowMs,
    ),
    { deleted: true, expired: false },
  );

  assert.deepEqual(
    getFileStatusState(
      {
        upload_status: "completed",
        expires_at: "2026-04-20T23:59:59.999Z",
      },
      nowMs,
    ),
    { deleted: false, expired: true },
  );

  assert.deepEqual(
    getFileStatusState(
      {
        upload_status: "completed",
        expires_at: "2026-04-21T00:00:00.001Z",
      },
      nowMs,
    ),
    { deleted: false, expired: false },
  );
});

test("canManageFileShare blocks deleted and expired files", () => {
  const nowMs = Date.parse("2026-04-21T00:00:00.000Z");

  assert.equal(
    canManageFileShare(
      {
        upload_status: "deleted",
        expires_at: "9999-12-31T23:59:59.999Z",
      },
      nowMs,
    ),
    false,
  );

  assert.equal(
    canManageFileShare(
      {
        upload_status: "completed",
        expires_at: "2026-04-20T23:59:59.999Z",
      },
      nowMs,
    ),
    false,
  );

  assert.equal(
    canManageFileShare(
      {
        upload_status: "completed",
        expires_at: "2026-04-21T00:00:00.001Z",
      },
      nowMs,
    ),
    true,
  );
});

function toLocalStartIso(dateValue) {
  return new Date(`${dateValue}T00:00:00`).toISOString();
}

function addOneDayIso(isoString) {
  const date = new Date(isoString);
  date.setDate(date.getDate() + 1);
  return date.toISOString();
}

test("buildFilesQueryParams maps active-mode filters and date ranges", () => {
  const expectedFrom = toLocalStartIso("2026-04-15");
  const expectedTo = addOneDayIso(toLocalStartIso("2026-04-16"));

  assert.deepEqual(
    buildFilesQueryParams(
      {
        filename: "  report  ",
        owner_id: "user-2",
        upload_status: "completed",
        sort_key: "size__asc",
        created_from_date: "2026-04-15",
        created_to_date: "2026-04-16",
      },
      { mode: "normal", isAdmin: true },
    ),
    {
      sort_by: "size",
      sort_order: "asc",
      filename: "report",
      owner_id: "user-2",
      upload_status: "completed",
      created_from: expectedFrom,
      created_to: expectedTo,
    },
  );
});

test("buildFilesQueryParams uses trash date keys and swaps reversed ranges", () => {
  const expectedFrom = toLocalStartIso("2026-04-15");
  const expectedTo = addOneDayIso(toLocalStartIso("2026-04-18"));

  assert.deepEqual(
    buildFilesQueryParams(
      {
        sort_key: "",
        upload_status: "completed",
        created_from_date: "2026-04-18",
        created_to_date: "2026-04-15",
      },
      { mode: "trash", isAdmin: false },
    ),
    {
      sort_by: "deleted_at",
      sort_order: "desc",
      deleted_from: expectedFrom,
      deleted_to: expectedTo,
    },
  );
});

test("file display helpers format status, expiry, remaining time and sizes", () => {
  const t = (key, params = {}) => {
    if (key === "files.status.valid") return "有效";
    if (key === "files.status.invalid") return "已删除";
    if (key === "files.status.expired") return "已过期";
    if (key === "files.expires.seconds") return `${params.value} 秒`;
    if (key === "files.expires.days") return `${params.days} 天`;
    return key;
  };
  const nowMs = Date.parse("2026-04-21T00:00:00.000Z");

  assert.deepEqual(
    getFileDisplayStatus(
      {
        upload_status: "completed",
        expires_at: "2026-04-20T23:59:59.999Z",
      },
      t,
      nowMs,
    ),
    { deleted: false, expired: true, text: "已过期", tagType: "warning" },
  );
  assert.equal(getFileExpiresText({ expires_in: -30 }, t), "30 秒");
  assert.equal(getFileExpiresText({ expires_in: 7 }, t), "7 天");
  assert.equal(getFileRemainingText({ remaining_time: "  6 天  " }), "6 天");
  assert.equal(
    getFileRemainingText({ remaining_time: "6 天" }, { isTrashMode: true }),
    "-",
  );
  assert.equal(formatFileBytes(0), "0 B");
  assert.equal(formatFileBytes(1536), "1.5 KB");
});
