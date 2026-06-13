import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../frontend/src/components/dashboard/DashboardInsights.vue",
    import.meta.url,
  ),
  "utf8",
);

test("DashboardInsights 使用两行 insights 卡片布局，避免右侧健康卡失衡拉高", () => {
  assert.match(
    source,
    /<section class="dashboard-insights-grid">/,
    "DashboardInsights 应提供独立的 insights 网格容器",
  );
  assert.match(
    source,
    /<div class="dashboard-insights-column dashboard-insights-column--primary">[\s\S]*?<Card class="dashboard-insights-card dashboard-insights-card--user-status">[\s\S]*?<Card class="dashboard-insights-card dashboard-insights-card--share-status">[\s\S]*?<\/div>/,
    "左侧主列应按纵向顺序承载用户状态和分享状态，避免用户状态卡缩小后留下底部空洞",
  );
  assert.match(
    source,
    /<div class="dashboard-insights-column dashboard-insights-column--secondary">[\s\S]*?<Card class="dashboard-insights-card dashboard-insights-card--health">[\s\S]*?<Card class="dashboard-insights-card dashboard-insights-card--text-freshness">[\s\S]*?<\/div>/,
    "右侧次列应按纵向顺序承载运行健康和文档更新，形成独立的右侧卡组",
  );
  assert.match(
    source,
    /<Card class="dashboard-insights-card dashboard-insights-card--user-status">/,
    "DashboardInsights 应渲染用户状态主卡片",
  );
  assert.match(
    source,
    /<Card class="dashboard-insights-card dashboard-insights-card--health">/,
    "DashboardInsights 应渲染运行健康辅卡片",
  );
  assert.match(
    source,
    /<Card class="dashboard-insights-card dashboard-insights-card--share-status">/,
    "DashboardInsights 应将分享状态拆成独立卡片，避免继续堆在运行健康卡里",
  );
  assert.match(
    source,
    /<Card class="dashboard-insights-card dashboard-insights-card--text-freshness">/,
    "DashboardInsights 应将文档更新拆成独立卡片，避免继续堆在运行健康卡里",
  );
  assert.match(
    source,
    /class="dashboard-insights-card-head"/,
    "每张 insights 卡片都应有更稳定的头部层级容器",
  );
  assert.match(
    source,
    /class="dashboard-insights-stack"/,
    "运行健康卡应继续使用统一的内部容器承载健康和预警模块",
  );
  assert.match(
    source,
    /class="dashboard-insights-panel dashboard-insights-panel--config"/,
    "上传配置健康区应包裹在独立的浅层分区容器中",
  );
  assert.match(
    source,
    /class="dashboard-insights-panel dashboard-insights-panel--alerts"/,
    "文件预警区应包裹在独立的浅层分区容器中",
  );
  assert.match(
    source,
    /<div class="dashboard-insights-column dashboard-insights-column--secondary">[\s\S]*?<Card class="dashboard-insights-card dashboard-insights-card--health">[\s\S]*?dashboard-insights-panel dashboard-insights-panel--config[\s\S]*?dashboard-insights-panel dashboard-insights-panel--alerts[\s\S]*?<\/Card>\s*<Card class="dashboard-insights-card dashboard-insights-card--text-freshness">/,
    "右侧列中应先渲染运行健康卡，再渲染文档更新卡，保持右列纵向结构稳定",
  );
  assert.match(
    source,
    /\.dashboard-insights-grid\s*\{[\s\S]*grid-template-columns:\s*max-content\s+minmax\(360px,\s*1fr\);[\s\S]*align-items:\s*start;/,
    "桌面端应采用左侧内容宽度、右侧弹性宽度的双列布局，避免用户状态卡收缩后继续保留空白占位",
  );
  assert.match(
    source,
    /\.dashboard-insights-column\s*\{[\s\S]*display:\s*grid;[\s\S]*gap:\s*12px;[\s\S]*align-content:\s*start;/,
    "每一列都应作为独立纵向卡组排布，避免不同行高互相牵连",
  );
  assert.match(
    source,
    /\.dashboard-insights-card\s*\{[\s\S]*height:\s*100%;/,
    "insights 卡片应补齐整行高度，保证同一行边界对齐",
  );
  assert.match(
    source,
    /\.dashboard-insights-card--user-status\s*\{[\s\S]*width:\s*fit-content;[\s\S]*max-width:\s*100%;[\s\S]*height:\s*auto;[\s\S]*justify-self:\s*start;[\s\S]*align-self:\s*start;/,
    "用户状态卡应按内容自然收缩，而不是继续占满整块网格单元",
  );
  assert.match(
    source,
    /@media \(max-width:\s*768px\)\s*\{[\s\S]*\.dashboard-insights-grid\s*\{[\s\S]*grid-template-columns:\s*1fr;[\s\S]*\}\s*[\s\S]*\.dashboard-insights-column\s*\{[\s\S]*display:\s*contents;/,
    "移动端应折叠为单列布局",
  );
});

test("DashboardInsights 包含 SVG 环图、健康分区以及独立的分享和文档图表卡", () => {
  assert.match(
    source,
    /<svg[\s\S]*class="user-status-ring-svg"/,
    "用户状态区应使用 SVG 环图",
  );
  assert.match(
    source,
    /class="user-status-legend"/,
    "用户状态区应渲染图例列表",
  );
  assert.match(
    source,
    /class="config-health"/,
    "运行健康区应包含上传配置健康模块",
  );
  assert.match(
    source,
    /class="config-health-steps"/,
    "上传配置健康模块应包含状态条容器",
  );
  assert.match(source, /class="file-alerts"/, "运行健康区应包含文件预警模块");
  assert.match(source, /class="share-status"/, "页面应包含分享状态模块");
  assert.match(
    source,
    /class="share-status-chart"/,
    "分享状态模块应包含柱状图容器",
  );
  assert.match(
    source,
    /class="share-status-bar"/,
    "分享状态模块应渲染柱状条目",
  );
  assert.doesNotMatch(
    source,
    /share-status[\s\S]*<circle/,
    "分享状态模块不应继续使用环形图结构",
  );
  assert.match(source, /class="text-freshness"/, "页面应包含文档更新模块");
  assert.match(
    source,
    /class="text-freshness-track"/,
    "文档更新模块应包含结构条轨道",
  );
  assert.match(
    source,
    /class="text-freshness-segment"/,
    "文档更新模块应渲染分段结构条",
  );
  assert.match(
    source,
    /class="file-alert-item"/,
    "文件预警模块应渲染独立指标块，不得只显示一行纯文本",
  );
  assert.match(
    source,
    /class="file-alert-item-copy"/,
    "文件预警项应使用统一的文案包裹层，避免标签和数字松散对齐",
  );
});

test("DashboardInsights 收紧用户状态图例间距，并让文档更新标题和值保持同行", () => {
  assert.match(
    source,
    /\.user-status-panel\s*\{[\s\S]*grid-template-columns:\s*minmax\(170px,\s*208px\)\s+fit-content\(220px\);[\s\S]*gap:\s*20px;[\s\S]*justify-content:\s*start;[\s\S]*align-items:\s*center;[\s\S]*width:\s*fit-content;[\s\S]*max-width:\s*100%;/,
    "用户状态内容面板应按内容宽度收口，避免在卡片内部继续占满整行",
  );
  assert.match(
    source,
    /\.user-status-ring-shell\s*\{[\s\S]*max-width:\s*208px;/,
    "用户状态环图区应保持稳定尺寸，避免在收缩卡片时继续放大占位",
  );
  assert.match(
    source,
    /\.user-status-summary\s*\{[\s\S]*display:\s*flex;[\s\S]*min-width:\s*0;[\s\S]*max-width:\s*220px;[\s\S]*align-self:\s*center;/,
    "用户状态图例区应保持紧凑宽度，避免标签和值被撑得过开",
  );
  assert.match(
    source,
    /\.user-status-legend\s*\{[\s\S]*gap:\s*8px;[\s\S]*border-top:\s*none;/,
    "用户状态图例整体应收紧，取消强制等高分布和顶部边线",
  );
  assert.match(
    source,
    /\.user-status-legend-item\s*\{[\s\S]*justify-content:\s*flex-start;[\s\S]*gap:\s*10px;[\s\S]*padding:\s*2px 0;[\s\S]*border-bottom:\s*none;/,
    "用户状态每个图例项应按内容自然排列，不应把标签和值拉到两端",
  );
  assert.match(
    source,
    /class="share-status-bar"[\s\S]*:style="\{ '--share-bar-height': getShareBarHeight\(bar\) \}"[\s\S]*class="share-status-bar-plot"[\s\S]*class="share-status-bar-value">\{\{ bar\.displayValue \}\}<\/div>[\s\S]*class="share-status-bar-shell"[\s\S]*class="share-status-bar-label">\{\{ bar\.label \}\}<\/div>/,
    "分享状态应使用固定柱高变量定位数值，保证数值始终与柱顶保持一致间距",
  );
  assert.doesNotMatch(
    source,
    /class="share-status-bar-short"|\{\{\s*bar\.shortLabel\s*\}\}/,
    "分享状态不应继续只显示一个字的短标签",
  );
  assert.match(
    source,
    /\.share-status-bar-value\s*\{[\s\S]*position:\s*absolute;[\s\S]*bottom:\s*calc\(var\(--share-bar-height\)\s*\+\s*10px\);/,
    "分享状态数值应通过绝对定位固定在柱顶上方，避免不同柱高导致远近不一",
  );
  assert.match(
    source,
    /const getTextFreshnessColumns = \(segments\) => \{[\s\S]*segment\.ratio[\s\S]*\}/,
    "文档更新应根据分段占比计算下方列宽，使标题和值对齐到对应色块中心",
  );
  assert.match(
    source,
    /class="text-freshness-list"[\s\S]*:style="\{[\s\S]*gridTemplateColumns:\s*getTextFreshnessColumns\(insights\.textFreshness\.segments\),?[\s\S]*\}"/,
    "文档更新下方说明应按分段占比动态排布，而不是简单均分列宽",
  );
  assert.match(
    source,
    /\.text-freshness-item\s*\{[\s\S]*flex-direction:\s*row;[\s\S]*align-items:\s*baseline;[\s\S]*justify-content:\s*center;[\s\S]*gap:\s*6px;/,
    "文档更新的每个说明块应在对应色块下方居中展示",
  );
});
