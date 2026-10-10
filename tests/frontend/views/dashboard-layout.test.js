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

test("仪表盘页面桌面端接入任务面板并支持手动运行，移动端隐藏，不渲染风险面板", () => {
  const source = readSource("../../../frontend/src/views/Dashboard.vue");
  const overviewRequests = source.match(/getAdminOverview\(/g) || [];

  assert.doesNotMatch(
    source,
    /<section class="dashboard-panels">/,
    "Dashboard 不应继续渲染底部面板容器",
  );
  assert.doesNotMatch(
    source,
    /RiskAlertsPanel/,
    "Dashboard 不应继续引入风险面板",
  );
  assert.match(
    source,
    /import JobRunsPanel from '\.\.\/components\/dashboard\/JobRunsPanel\.vue'/,
    "Dashboard 应重新引入任务执行面板",
  );
  assert.match(
    source,
    /<JobRunsPanel\s+v-if="!isMobile"/,
    "Dashboard 的任务执行面板应仅在桌面端渲染（移动端保持精简）",
  );
  assert.match(
    source,
    /import \{ useIsMobile \} from '\.\.\/composables\/useViewport\.js'/,
    "Dashboard 应使用 useIsMobile 判定视口以门控任务面板",
  );
  assert.match(
    source,
    /getAdminJobRuns/,
    "Dashboard 应请求任务执行列表以驱动面板",
  );
  assert.match(source, /runAdminJob/, "Dashboard 应提供手动触发任务的能力");
  assert.equal(
    overviewRequests.length,
    1,
    "Dashboard 应继续只使用一次 getAdminOverview 作为概览数据入口",
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
