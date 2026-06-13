import test from "node:test";
import assert from "node:assert/strict";

import {
  BATCH_DISABLE_SHARE_ACTION_KEY,
  SHARE_FILTERS_STORAGE_KEY,
  buildAbsoluteShareUrl,
  createDefaultShareFilters,
  buildExpiredGovernanceFilters,
  buildExpiringGovernanceFilters,
  buildSharesQueryParams,
  buildShareSelectedIdSet,
  canOpenShare,
  collectSelectedShares,
  filterShareOwners,
  formatShareDateTime,
  formatShareVisits,
  getBatchDisableFeedbackMeta,
  getShareActionKey,
  getShareConfirmMeta,
  getSharePasswordText,
  hasActiveShareFilters,
  hasEditableConfig,
  isExpiredShareGovernanceActive,
  isExpiringShareGovernanceActive,
  isShareActionLoading,
  persistShareFiltersToStorage,
  restorePersistedShareFilters,
  restoreShareFiltersFromStorage,
  toShareSelectionKey,
  toPersistedShareFilters,
  toShareStatusLabelKey,
  toShareStatusVariant,
  toShareTypeLabelKey,
  updateShareSelection,
} from "../../../frontend/src/utils/shares.js";

function toLocalStartIso(dateValue) {
  return new Date(`${dateValue}T00:00:00`).toISOString();
}

function addOneDayIso(isoString) {
  const date = new Date(isoString);
  date.setDate(date.getDate() + 1);
  return date.toISOString();
}

test("toShareTypeLabelKey maps supported share types to i18n keys", () => {
  assert.equal(toShareTypeLabelKey("file"), "shares.types.file");
  assert.equal(toShareTypeLabelKey("text"), "shares.types.text");
  assert.equal(
    toShareTypeLabelKey("text_one_time"),
    "shares.types.textOneTime",
  );
  assert.equal(toShareTypeLabelKey("unknown"), "shares.types.unknown");
});

test("toShareStatusLabelKey maps supported share statuses to i18n keys", () => {
  assert.equal(toShareStatusLabelKey("active"), "shares.status.active");
  assert.equal(toShareStatusLabelKey("expired"), "shares.status.expired");
  assert.equal(toShareStatusLabelKey("exhausted"), "shares.status.exhausted");
  assert.equal(toShareStatusLabelKey("consumed"), "shares.status.consumed");
  assert.equal(toShareStatusLabelKey("unknown"), "shares.status.unknown");
});

test("toShareStatusVariant maps status to tag variants", () => {
  assert.equal(toShareStatusVariant("active"), "success");
  assert.equal(toShareStatusVariant("expired"), "warning");
  assert.equal(toShareStatusVariant("exhausted"), "danger");
  assert.equal(toShareStatusVariant("consumed"), "info");
  assert.equal(toShareStatusVariant("unknown"), "default");
});

test("canOpenShare only allows active share links", () => {
  assert.equal(canOpenShare({ type: "file", status: "active" }), true);
  assert.equal(canOpenShare({ type: "text", status: "expired" }), false);
  assert.equal(canOpenShare({ type: "text_one_time", status: "active" }), true);
  assert.equal(
    canOpenShare({ type: "text_one_time", status: "consumed" }),
    false,
  );
});

test("formatShareVisits formats standard and one-time share visit values", () => {
  const t = (key) => {
    if (key === "shares.visits.unlimited") return "不限";
    return key;
  };

  assert.equal(
    formatShareVisits({ type: "file", views: 3, max_views: 10 }, t),
    "3/10",
  );
  assert.equal(
    formatShareVisits({ type: "text", views: 5, max_views: 0 }, t),
    "5/不限",
  );
  assert.equal(
    formatShareVisits(
      { type: "text_one_time", views: null, max_views: null },
      t,
    ),
    "-",
  );
});

test("hasEditableConfig only returns true for standard share types", () => {
  assert.equal(hasEditableConfig({ type: "file" }), true);
  assert.equal(hasEditableConfig({ type: "text" }), true);
  assert.equal(hasEditableConfig({ type: "text_one_time" }), false);
  assert.equal(hasEditableConfig({ type: "unknown" }), false);
});

test("buildSharesQueryParams trims q and only includes owner_id for admins", () => {
  assert.deepEqual(
    buildSharesQueryParams(
      {
        q: "  alpha  ",
        type: "file",
        status: "active",
        owner_id: "user-2",
      },
      { isAdmin: false },
    ),
    {
      q: "alpha",
      type: "file",
      status: "active",
    },
  );

  assert.deepEqual(
    buildSharesQueryParams(
      {
        q: "  bob ",
        type: "",
        status: "",
        owner_id: " user-2 ",
      },
      { isAdmin: true },
    ),
    {
      q: "bob",
      owner_id: "user-2",
    },
  );
});

test("buildSharesQueryParams includes expires range params for a full date interval", () => {
  const expectedFrom = toLocalStartIso("2026-04-15");
  const expectedTo = addOneDayIso(toLocalStartIso("2026-04-16"));

  assert.deepEqual(
    buildSharesQueryParams(
      {
        q: "  alpha  ",
        type: "file",
        status: "active",
        owner_id: " user-2 ",
        expires_from_date: "2026-04-15",
        expires_to_date: "2026-04-16",
      },
      { isAdmin: true },
    ),
    {
      q: "alpha",
      type: "file",
      status: "active",
      owner_id: "user-2",
      expires_from: expectedFrom,
      expires_to: expectedTo,
    },
  );
});

test("buildSharesQueryParams expands a single expires date into one natural-day range", () => {
  const expectedFrom = toLocalStartIso("2026-04-15");
  const expectedTo = addOneDayIso(expectedFrom);

  assert.deepEqual(
    buildSharesQueryParams(
      {
        expires_from_date: "2026-04-15",
      },
      { isAdmin: false },
    ),
    {
      expires_from: expectedFrom,
      expires_to: expectedTo,
    },
  );
});

test("buildSharesQueryParams swaps reversed expires dates before building query params", () => {
  const expectedFrom = toLocalStartIso("2026-04-15");
  const expectedTo = addOneDayIso(toLocalStartIso("2026-04-18"));

  assert.deepEqual(
    buildSharesQueryParams(
      {
        expires_from_date: "2026-04-18",
        expires_to_date: "2026-04-15",
      },
      { isAdmin: false },
    ),
    {
      expires_from: expectedFrom,
      expires_to: expectedTo,
    },
  );
});

test("buildSharesQueryParams maps a valid sort_key to sort_by and sort_order params", () => {
  assert.deepEqual(
    buildSharesQueryParams(
      {
        sort_key: "expires_at__asc",
      },
      { isAdmin: false },
    ),
    {
      sort_by: "expires_at",
      sort_order: "asc",
    },
  );

  assert.deepEqual(
    buildSharesQueryParams(
      {
        sort_key: "updated_at__desc",
      },
      { isAdmin: false },
    ),
    {
      sort_by: "updated_at",
      sort_order: "desc",
    },
  );
});

test("buildSharesQueryParams falls back to updated_at desc when sort_key is invalid", () => {
  assert.deepEqual(
    buildSharesQueryParams(
      {
        sort_key: "owner_id__asc",
      },
      { isAdmin: false },
    ),
    {
      sort_by: "updated_at",
      sort_order: "desc",
    },
  );
});

test("toPersistedShareFilters only keeps business filter fields and trims text values", () => {
  assert.deepEqual(
    toPersistedShareFilters({
      q: "  alpha  ",
      type: "file",
      status: "active",
      sort_key: "expires_at__asc",
      expires_from_date: " 2026-04-15 ",
      expires_to_date: "2026-04-16 ",
      owner_id: " user-2 ",
      ownerSearchQuery: "Bob",
      selectedIds: ["file:file-1"],
      showConfirmModal: true,
    }),
    {
      q: "alpha",
      type: "file",
      status: "active",
      sort_key: "expires_at__asc",
      expires_from_date: "2026-04-15",
      expires_to_date: "2026-04-16",
      owner_id: "user-2",
    },
  );
});

test("restorePersistedShareFilters fills missing fields and falls back invalid sort_key", () => {
  assert.deepEqual(
    restorePersistedShareFilters({
      q: "  report ",
      status: "expired",
      sort_key: "owner_id__asc",
    }),
    {
      q: "report",
      type: "",
      status: "expired",
      sort_key: "updated_at__desc",
      expires_from_date: "",
      expires_to_date: "",
      owner_id: "",
    },
  );
});

test("restorePersistedShareFilters falls back to default filters for invalid payload", () => {
  assert.deepEqual(
    restorePersistedShareFilters(null),
    createDefaultShareFilters(),
  );
  assert.deepEqual(
    restorePersistedShareFilters("broken"),
    createDefaultShareFilters(),
  );
  assert.deepEqual(
    restorePersistedShareFilters(["unexpected"]),
    createDefaultShareFilters(),
  );
});

test("buildExpiredGovernanceFilters preserves scope filters and switches to expired governance preset", () => {
  assert.deepEqual(
    buildExpiredGovernanceFilters({
      q: "invoice",
      type: "file",
      owner_id: "user-2",
      status: "active",
      sort_key: "updated_at__desc",
      expires_from_date: "2026-04-15",
      expires_to_date: "2026-04-16",
    }),
    {
      q: "invoice",
      type: "file",
      owner_id: "user-2",
      status: "expired",
      sort_key: "expires_at__asc",
      expires_from_date: "",
      expires_to_date: "",
    },
  );
});

test("buildExpiringGovernanceFilters preserves scope filters and switches to expiring governance preset", () => {
  assert.deepEqual(
    buildExpiringGovernanceFilters({
      q: "notice",
      type: "text",
      owner_id: "user-3",
      status: "expired",
      sort_key: "updated_at__desc",
      expires_from_date: "2026-04-20",
      expires_to_date: "2026-04-21",
    }),
    {
      q: "notice",
      type: "text",
      owner_id: "user-3",
      status: "active",
      sort_key: "expires_at__asc",
      expires_from_date: "",
      expires_to_date: "",
    },
  );
});

test("share filter state helpers detect active and governance presets", () => {
  assert.equal(hasActiveShareFilters(createDefaultShareFilters()), false);
  assert.equal(hasActiveShareFilters({ q: " report " }), true);
  assert.equal(
    hasActiveShareFilters({ owner_id: "user-1" }, { isAdmin: false }),
    false,
  );
  assert.equal(
    hasActiveShareFilters({ owner_id: "user-1" }, { isAdmin: true }),
    true,
  );
  assert.equal(
    hasActiveShareFilters({ expires_from_date: "2026-04-15" }),
    true,
  );

  assert.equal(
    isExpiredShareGovernanceActive({
      status: "expired",
      sort_key: "expires_at__asc",
    }),
    true,
  );
  assert.equal(
    isExpiredShareGovernanceActive({
      status: "expired",
      sort_key: "expires_at__asc",
      expires_to_date: "2026-04-16",
    }),
    false,
  );
  assert.equal(
    isExpiringShareGovernanceActive({
      status: "active",
      sort_key: "expires_at__asc",
    }),
    true,
  );
});

test("getShareConfirmMeta returns correct metadata for disable and regenerate actions", () => {
  assert.deepEqual(
    getShareConfirmMeta("disable", {
      type: "file",
      resource_name: "alpha.txt",
    }),
    {
      titleKey: "shares.confirm.disableTitle",
      messageKey: "shares.confirm.disableMessage",
      confirmButtonKey: "shares.actions.disable",
      confirmButtonType: "danger",
      resourceName: "alpha.txt",
      typeLabelKey: "shares.types.file",
    },
  );

  assert.deepEqual(
    getShareConfirmMeta("regenerate", {
      type: "text_one_time",
      resource_name: "One Time A",
    }),
    {
      titleKey: "shares.confirm.regenerateTitle",
      messageKey: "shares.confirm.regenerateMessage",
      confirmButtonKey: "shares.actions.regenerate",
      confirmButtonType: "primary",
      resourceName: "One Time A",
      typeLabelKey: "shares.types.textOneTime",
    },
  );

  assert.deepEqual(
    getShareConfirmMeta("batch_disable", {
      count: 3,
    }),
    {
      titleKey: "shares.confirm.batchDisableTitle",
      messageKey: "shares.confirm.batchDisableMessage",
      confirmButtonKey: "shares.actions.disableSelected",
      confirmButtonType: "danger",
      count: 3,
      resourceName: "",
      typeLabelKey: "",
    },
  );
});

test("filterShareOwners matches username or id case-insensitively and keeps selected owner visible", () => {
  const owners = [
    { id: "user-1", username: "Alice" },
    { id: "user-2", username: "Bob" },
    { id: "user-3", username: "Carol" },
  ];

  assert.deepEqual(filterShareOwners(owners, "bo", ""), [
    { id: "user-2", username: "Bob" },
  ]);

  assert.deepEqual(filterShareOwners(owners, "USER-3", ""), [
    { id: "user-3", username: "Carol" },
  ]);

  assert.deepEqual(filterShareOwners(owners, "zz", "user-1"), [
    { id: "user-1", username: "Alice" },
  ]);
});

test("toShareSelectionKey builds a stable selection key from type and resource_id", () => {
  assert.equal(
    toShareSelectionKey({ type: "file", resource_id: "file-1" }),
    "file:file-1",
  );
  assert.equal(
    toShareSelectionKey({ type: "text_one_time", resource_id: "text-9" }),
    "text_one_time:text-9",
  );
  assert.equal(toShareSelectionKey({ type: "", resource_id: "file-1" }), "");
  assert.equal(toShareSelectionKey({ type: "file", resource_id: "" }), "");
});

test("collectSelectedShares returns selected current-page records in display order and skips invalid items", () => {
  const items = [
    { type: "file", resource_id: "file-1", resource_name: "A" },
    { type: "", resource_id: "broken-1", resource_name: "Broken" },
    { type: "text", resource_id: "text-2", resource_name: "B" },
    { type: "text_one_time", resource_id: "text-3", resource_name: "C" },
  ];

  assert.deepEqual(
    collectSelectedShares(items, ["text:text-2", "missing:404", "file:file-1"]),
    [
      { type: "file", resource_id: "file-1", resource_name: "A" },
      { type: "text", resource_id: "text-2", resource_name: "B" },
    ],
  );
});

test("share selection helpers normalize ids and toggle stable selection state", () => {
  const set = buildShareSelectedIdSet([" file:file-1 ", "", "text:text-2"]);

  assert.equal(set.has("file:file-1"), true);
  assert.equal(set.has("text:text-2"), true);
  assert.equal(set.has(""), false);
  assert.deepEqual(
    updateShareSelection([" file:file-1 "], "text:text-2", true),
    ["file:file-1", "text:text-2"],
  );
  assert.deepEqual(
    updateShareSelection(["file:file-1", "text:text-2"], "file:file-1", false),
    ["text:text-2"],
  );
  const original = ["file:file-1"];
  assert.equal(updateShareSelection(original, "", true), original);
});

test("getBatchDisableFeedbackMeta summarizes batch disable outcomes", () => {
  assert.deepEqual(
    getBatchDisableFeedbackMeta({ total: 3, successCount: 3, failedCount: 0 }),
    {
      messageKey: "shares.messages.batchDisableSuccess",
      params: { count: 3 },
    },
  );

  assert.deepEqual(
    getBatchDisableFeedbackMeta({ total: 5, successCount: 3, failedCount: 2 }),
    {
      messageKey: "shares.messages.batchDisablePartial",
      params: { successCount: 3, failedCount: 2, total: 5 },
    },
  );

  assert.deepEqual(
    getBatchDisableFeedbackMeta({ total: 4, successCount: 0, failedCount: 4 }),
    {
      messageKey: "shares.messages.batchDisableFailed",
      params: { count: 4 },
    },
  );
});

test("buildAbsoluteShareUrl keeps empty values empty and prefixes browser origin", () => {
  assert.equal(buildAbsoluteShareUrl(""), "");
  assert.equal(
    buildAbsoluteShareUrl(" /s/abc ", "https://example.com"),
    "https://example.com/s/abc",
  );
  assert.equal(buildAbsoluteShareUrl("/s/abc", ""), "/s/abc");
});

test("formatShareDateTime formats valid dates and hides invalid values", () => {
  const iso = "2026-04-15T08:30:00.000Z";
  assert.equal(formatShareDateTime("", "zh-CN"), "-");
  assert.equal(formatShareDateTime("not-a-date", "zh-CN"), "-");
  assert.equal(
    formatShareDateTime(iso, "en-US"),
    new Date(iso).toLocaleString("en-US"),
  );
});

test("getSharePasswordText hides one-time password state and translates standard shares", () => {
  const t = (key) => {
    if (key === "shares.password.set") return "已设置";
    if (key === "shares.password.unset") return "未设置";
    return key;
  };

  assert.equal(
    getSharePasswordText({ type: "text_one_time", has_password: true }, t),
    "-",
  );
  assert.equal(
    getSharePasswordText({ type: "file", has_password: true }, t),
    "已设置",
  );
  assert.equal(
    getSharePasswordText({ type: "text", has_password: false }, t),
    "未设置",
  );
});

test("share action helpers build stable loading keys", () => {
  const record = { type: "file", resource_id: " file-1 " };
  assert.equal(getShareActionKey("disable", record), "disable:file:file-1");
  assert.equal(
    getShareActionKey(BATCH_DISABLE_SHARE_ACTION_KEY, record),
    BATCH_DISABLE_SHARE_ACTION_KEY,
  );
  assert.equal(
    isShareActionLoading("disable:file:file-1", "disable", record),
    true,
  );
  assert.equal(
    isShareActionLoading("regenerate:file:file-1", "disable", record),
    false,
  );
});

test("share filter storage helpers persist sanitized filters and recover corrupted payloads", () => {
  const values = new Map();
  const removed = [];
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => {
      removed.push(key);
      values.delete(key);
    },
  };

  persistShareFiltersToStorage(
    {
      q: "  alpha  ",
      type: "file",
      status: "active",
      sort_key: "expires_at__asc",
      ownerSearchQuery: "ignored",
    },
    storage,
  );

  assert.equal(
    values.get(SHARE_FILTERS_STORAGE_KEY),
    JSON.stringify({
      q: "alpha",
      type: "file",
      status: "active",
      sort_key: "expires_at__asc",
      expires_from_date: "",
      expires_to_date: "",
      owner_id: "",
    }),
  );

  assert.deepEqual(restoreShareFiltersFromStorage(storage), {
    q: "alpha",
    type: "file",
    status: "active",
    sort_key: "expires_at__asc",
    expires_from_date: "",
    expires_to_date: "",
    owner_id: "",
  });

  values.set(SHARE_FILTERS_STORAGE_KEY, "{broken json");
  assert.deepEqual(
    restoreShareFiltersFromStorage(storage),
    createDefaultShareFilters(),
  );
  assert.deepEqual(removed, [SHARE_FILTERS_STORAGE_KEY]);
});
