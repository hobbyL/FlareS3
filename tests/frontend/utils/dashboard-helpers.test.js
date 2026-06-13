import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDashboardInsightsModel,
  buildOverviewCardsModel,
  formatJobRunDuration,
  getJobRunStatusTagType,
  listJobRunSummaryEntries,
} from "../../../frontend/src/utils/adminDashboard.js";

test("getJobRunStatusTagType maps job status to tag type", () => {
  assert.equal(getJobRunStatusTagType("success"), "success");
  assert.equal(getJobRunStatusTagType("partial"), "warning");
  assert.equal(getJobRunStatusTagType("failed"), "danger");
  assert.equal(getJobRunStatusTagType("running"), "info");
  assert.equal(getJobRunStatusTagType("unknown"), "default");
});

test("formatJobRunDuration formats milliseconds into readable text", () => {
  assert.equal(formatJobRunDuration(0), "0 ms");
  assert.equal(formatJobRunDuration(999), "999 ms");
  assert.equal(formatJobRunDuration(1530), "1.5 s");
  assert.equal(formatJobRunDuration(65000), "1m 5s");
});

test("listJobRunSummaryEntries keeps meaningful summary fields only", () => {
  assert.deepEqual(
    listJobRunSummaryEntries({
      deletedFiles: 3,
      skipped: 0,
      processed: 8,
      nested: { count: 1 },
      emptyText: "",
      nothing: null,
    }),
    [
      { key: "deletedFiles", value: "3" },
      { key: "skipped", value: "0" },
      { key: "processed", value: "8" },
      { key: "nested", value: '{"count":1}' },
    ],
  );
});

test("buildOverviewCardsModel groups overview metrics into combined dashboard cards", () => {
  const t = (key, params) => {
    if (key === "dashboard.cards.uploadConfigReadyHint") {
      return `default:${params.defaultConfigId};count:${params.count}`;
    }
    return key;
  };

  const cards = buildOverviewCardsModel({
    metrics: {
      totalUsers: 9,
      activeUsers: 4,
      totalFiles: 12,
      expiringThisWeek: 3,
      totalTexts: 268,
      activeShares: 84,
      usedSpaceFormatted: "48 B",
      pendingDeleteQueue: 1,
    },
    setup: {
      configCount: 2,
      defaultConfigId: "cfg-1",
      hasUploadConfig: true,
    },
    loading: false,
    t,
  });

  assert.deepEqual(
    cards.map((card) => ({
      key: card.key,
      metrics: card.metrics?.map((metric) => ({
        key: metric.key,
        value: metric.value,
        tagLabel: metric.tagLabel,
        tagType: metric.tagType,
      })),
      value: card.value,
      hint: card.hint,
    })),
    [
      {
        key: "users",
        metrics: [
          {
            key: "totalUsers",
            value: "9",
            tagLabel: undefined,
            tagType: undefined,
          },
          {
            key: "activeUsers",
            value: "4",
            tagLabel: undefined,
            tagType: undefined,
          },
        ],
        value: undefined,
        hint: "dashboard.cards.usersHint",
      },
      {
        key: "files",
        metrics: [
          {
            key: "totalFiles",
            value: "12",
            tagLabel: undefined,
            tagType: undefined,
          },
          {
            key: "expiringThisWeek",
            value: "3",
            tagLabel: undefined,
            tagType: undefined,
          },
        ],
        value: undefined,
        hint: "dashboard.cards.filesHint",
      },
      {
        key: "docsShares",
        metrics: [
          {
            key: "totalTexts",
            value: "268",
            tagLabel: undefined,
            tagType: undefined,
          },
          {
            key: "activeShares",
            value: "84",
            tagLabel: undefined,
            tagType: undefined,
          },
        ],
        value: undefined,
        hint: "dashboard.cards.docsSharesHint",
      },
      {
        key: "storage",
        metrics: [
          {
            key: "usedSpace",
            value: "48 B",
            tagLabel: undefined,
            tagType: undefined,
          },
          {
            key: "uploadConfig",
            value: "2",
            tagLabel: undefined,
            tagType: undefined,
          },
        ],
        value: undefined,
        hint: "default:cfg-1;count:2",
      },
      {
        key: "pendingDeleteQueue",
        metrics: undefined,
        value: "1",
        hint: "dashboard.cards.pendingDeleteQueueHint",
      },
    ],
  );
});

test("buildOverviewCardsModel uses loading placeholder and upload config warning states", () => {
  const t = (key, params) => {
    if (key === "dashboard.cards.uploadConfigPendingDefaultHint") {
      return `pending:${params.count}`;
    }
    return key;
  };

  const cards = buildOverviewCardsModel({
    metrics: {
      totalUsers: 9,
      activeUsers: 4,
      totalFiles: 12,
      expiringThisWeek: 3,
      totalTexts: 268,
      activeShares: 84,
      usedSpaceFormatted: "48 B",
      pendingDeleteQueue: 1,
    },
    setup: {
      configCount: 3,
      defaultConfigId: "",
      hasUploadConfig: true,
    },
    loading: true,
    t,
  });

  const storageCard = cards.find((card) => card.key === "storage");
  assert.deepEqual(storageCard.metrics, [
    {
      key: "usedSpace",
      label: "dashboard.cards.usedSpace",
      value: "—",
    },
    {
      key: "uploadConfig",
      label: "dashboard.cards.uploadConfig",
      value: "—",
    },
  ]);
  assert.equal(storageCard.hint, "pending:3");
});

test("buildDashboardInsightsModel returns user status, config health, and file alerts sections", () => {
  const t = (key) => key;

  const insights = buildDashboardInsightsModel({
    metrics: {
      totalUsers: 10,
      activeUsers: 6,
      disabledUsers: 2,
      expiringThisWeek: 3,
      pendingDeleteQueue: 1,
      activeShares: 84,
      expiredShares: 14,
      exhaustedShares: 9,
      consumedShares: 8,
      textsUpdated7d: 31,
      textsUpdated8To30d: 94,
      textsStaleOver30d: 143,
    },
    setup: {
      configCount: 2,
      defaultConfigId: "cfg-1",
      hasUploadConfig: true,
    },
    loading: false,
    t,
  });

  assert.deepEqual(
    {
      keys: Object.keys(insights),
      userStatus: {
        totalValue: insights.userStatus.totalValue,
        empty: insights.userStatus.empty,
        segments: insights.userStatus.segments.map((segment) => ({
          key: segment.key,
          value: segment.value,
          displayValue: segment.displayValue,
        })),
      },
      configHealth: {
        statusKey: insights.configHealth.statusKey,
        value: insights.configHealth.value,
      },
      fileAlerts: insights.fileAlerts.items.map((item) => ({
        key: item.key,
        value: item.value,
        displayValue: item.displayValue,
      })),
      shareStatus: insights.shareStatus.bars.map((item) => ({
        key: item.key,
        value: item.value,
        displayValue: item.displayValue,
      })),
      textFreshness: insights.textFreshness.segments.map((item) => ({
        key: item.key,
        value: item.value,
        displayValue: item.displayValue,
      })),
    },
    {
      keys: [
        "userStatus",
        "configHealth",
        "fileAlerts",
        "shareStatus",
        "textFreshness",
      ],
      userStatus: {
        totalValue: "10",
        empty: false,
        segments: [
          { key: "activeUsers", value: 6, displayValue: "6" },
          { key: "disabledUsers", value: 2, displayValue: "2" },
          { key: "otherUsers", value: 2, displayValue: "2" },
        ],
      },
      configHealth: {
        statusKey: "ready",
        value: "2",
      },
      fileAlerts: [
        { key: "expiringThisWeek", value: 3, displayValue: "3" },
        { key: "pendingDeleteQueue", value: 1, displayValue: "1" },
      ],
      shareStatus: [
        { key: "activeShares", value: 84, displayValue: "84" },
        { key: "expiredShares", value: 14, displayValue: "14" },
        { key: "exhaustedShares", value: 9, displayValue: "9" },
        { key: "consumedShares", value: 8, displayValue: "8" },
      ],
      textFreshness: [
        { key: "textsUpdated7d", value: 31, displayValue: "31" },
        { key: "textsUpdated8To30d", value: 94, displayValue: "94" },
        { key: "textsStaleOver30d", value: 143, displayValue: "143" },
      ],
    },
  );
});

test("buildDashboardInsightsModel clamps otherUsers and exposes empty ring state", () => {
  const t = (key) => key;

  const insights = buildDashboardInsightsModel({
    metrics: {
      totalUsers: 0,
      activeUsers: 4,
      disabledUsers: 3,
      expiringThisWeek: 0,
      pendingDeleteQueue: 0,
    },
    setup: {
      configCount: 0,
      defaultConfigId: null,
      hasUploadConfig: false,
    },
    loading: false,
    t,
  });

  assert.equal(insights.userStatus.empty, true);
  assert.deepEqual(
    insights.userStatus.segments.map((segment) => ({
      key: segment.key,
      value: segment.value,
      ratio: segment.ratio,
    })),
    [
      { key: "activeUsers", value: 0, ratio: 0 },
      { key: "disabledUsers", value: 0, ratio: 0 },
      { key: "otherUsers", value: 0, ratio: 0 },
    ],
  );
  assert.equal(insights.configHealth.statusKey, "missing");
});

test("buildDashboardInsightsModel keeps upload config health priority and loading placeholders", () => {
  const t = (key) => key;

  const pendingDefault = buildDashboardInsightsModel({
    metrics: {
      totalUsers: 8,
      activeUsers: 5,
      disabledUsers: 1,
      expiringThisWeek: 7,
      pendingDeleteQueue: 2,
      activeShares: 2,
      expiredShares: 1,
      exhaustedShares: 0,
      consumedShares: 3,
      textsUpdated7d: 4,
      textsUpdated8To30d: 5,
      textsStaleOver30d: 6,
    },
    setup: {
      configCount: 3,
      defaultConfigId: "",
      hasUploadConfig: true,
    },
    loading: true,
    t,
  });

  assert.equal(pendingDefault.configHealth.statusKey, "pendingDefault");
  assert.equal(pendingDefault.configHealth.value, "—");
  assert.deepEqual(
    pendingDefault.fileAlerts.items.map((item) => item.displayValue),
    ["—", "—"],
  );
  assert.deepEqual(
    pendingDefault.shareStatus.bars.map((item) => item.displayValue),
    ["—", "—", "—", "—"],
  );
  assert.deepEqual(
    pendingDefault.textFreshness.segments.map((item) => item.displayValue),
    ["—", "—", "—"],
  );
});

test("buildDashboardInsightsModel hides zero-value text freshness segments when not loading", () => {
  const t = (key) => key;

  const insights = buildDashboardInsightsModel({
    metrics: {
      totalTexts: 28,
      textsUpdated7d: 7,
      textsUpdated8To30d: 0,
      textsStaleOver30d: 21,
    },
    setup: {},
    loading: false,
    t,
  });

  assert.deepEqual(
    insights.textFreshness.segments.map((segment) => ({
      key: segment.key,
      value: segment.value,
      displayValue: segment.displayValue,
    })),
    [
      { key: "textsUpdated7d", value: 7, displayValue: "7" },
      { key: "textsStaleOver30d", value: 21, displayValue: "21" },
    ],
  );
});

test("OverviewCards renders metrics without nested sub-card chrome", () => {
  const source = readFileSync(
    new URL(
      "../../../frontend/src/components/dashboard/OverviewCards.vue",
      import.meta.url,
    ),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /\.overview-card-metric\s*\{[\s\S]*border:/,
    "仪表盘内层指标不应再带边框样式",
  );
  assert.doesNotMatch(
    source,
    /\.overview-card-metric\s*\{[\s\S]*background:/,
    "仪表盘内层指标不应再带独立背景样式",
  );
  assert.doesNotMatch(
    source,
    /overview-card-hint/,
    "仪表盘卡片不应再渲染第三行描述文案",
  );
  assert.match(
    source,
    /<div v-else class="overview-card-metric overview-card-metric--single">\s*<div class="overview-card-metric-header">\s*<span class="overview-card-label">{{ card\.label }}<\/span>\s*<\/div>\s*<div class="overview-card-metric-value">{{ card\.value }}<\/div>\s*<\/div>/,
    "单值卡片应在同一指标块内渲染标题和值，保持与前面卡片一致的垂直节奏",
  );
  assert.doesNotMatch(
    source,
    /<div v-if="!card\.metrics\?\.length" class="overview-card-header">/,
    "单值卡片不应再通过独立 header 与 value 分层，避免额外间距",
  );
  assert.doesNotMatch(
    source,
    /\.overview-card-value\s*\{/,
    "单值卡片不应再维护独立的 value 字体样式",
  );
  assert.match(
    source,
    /\.overview-grid\s*\{[\s\S]*align-items:\s*start;/,
    "概览卡片网格不应拉伸卡片高度，应按内容高度展示",
  );
  assert.doesNotMatch(
    source,
    /\.overview-card\s*\{[\s\S]*min-height:/,
    "概览卡片不应再使用固定最小高度，避免额外底部留白",
  );
  assert.match(
    source,
    /\.overview-card-body\s*\{[\s\S]*gap:\s*10px;/,
    "概览卡片内部纵向间距应收紧",
  );
});
