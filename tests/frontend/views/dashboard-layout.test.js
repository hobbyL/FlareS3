import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSource = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("仪表盘页面不向 AppLayout 传固定宽度上限", () => {
  const source = readSource("../../../frontend/src/views/Dashboard.vue");

  assert.doesNotMatch(
    source,
    /<AppLayout\s+max-width=/,
    "Dashboard 不应继续向 AppLayout 传 max-width，避免侧边栏收起后保留右侧空白",
  );
});

test("仪表盘页面只保留概览卡片，不再渲染风险与任务面板", () => {
  const source = readSource("../../../frontend/src/views/Dashboard.vue");
  const overviewRequests = source.match(/getAdminOverview\(/g) || [];

  assert.doesNotMatch(
    source,
    /<section class="dashboard-panels">/,
    "Dashboard 不应继续渲染底部面板容器",
  );
  assert.doesNotMatch(
    source,
    /RiskAlertsPanel|JobRunsPanel/,
    "Dashboard 不应继续引入风险面板和任务面板",
  );
  assert.doesNotMatch(
    source,
    /getAdminJobRuns|jobRunsTotal|const jobRuns = ref\(/,
    "Dashboard 不应继续请求和维护任务执行列表数据",
  );
  assert.equal(
    overviewRequests.length,
    1,
    "Dashboard 应继续只使用一次 getAdminOverview 作为唯一数据入口",
  );
});

test("仪表盘页面在概览卡片下方接入 insights 区", () => {
  const source = readSource("../../../frontend/src/views/Dashboard.vue");

  assert.match(
    source,
    /import DashboardInsights from '\.\.\/components\/dashboard\/DashboardInsights\.vue'/,
    "Dashboard 应引入新的 DashboardInsights 组件",
  );
  assert.match(
    source,
    /<DashboardInsights\s+:metrics="overview\.metrics"\s+:setup="overview\.setup"\s*\/>/,
    "Dashboard 应在 OverviewCards 下方复用同一份 overview 数据渲染 insights 区",
  );
});

test("仪表盘副标题不再描述已移除的风险与任务面板", () => {
  const zhSource = readSource(
    "../../../frontend/src/locales/zh-CN/pages/dashboard.js",
  );
  const enSource = readSource(
    "../../../frontend/src/locales/en-US/pages/dashboard.js",
  );

  assert.doesNotMatch(
    zhSource,
    /定时任务执行结果/,
    "中文副标题不应继续提及已移除的定时任务结果",
  );
  assert.doesNotMatch(
    enSource,
    /scheduled job results/i,
    "英文副标题不应继续提及已移除的 scheduled job results",
  );
});
