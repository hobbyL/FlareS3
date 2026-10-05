# Dashboard 文档与分享监控 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把文档与分享监控接入现有仪表盘，在顶部概览展示规模，在 `Insights` 展示分享状态柱状图和文档更新结构图。

**Architecture:** 保持 `/api/admin/overview` 作为唯一数据入口，在 `worker/src/services/adminOverview.ts` 增补聚合指标，再由 `frontend/src/utils/adminDashboard.js` 统一派生顶部概览与 `Insights` 视图模型。`Dashboard.vue` 只扩展默认字段，展示仍由 `OverviewCards.vue` 和 `DashboardInsights.vue` 消费同一份 `overview` 数据。

**Tech Stack:** Cloudflare Worker + D1、Vue 3、Node 内置 `node:test`

---

### Task 1: 后端 overview 聚合扩展

**Files:**
- Modify: `worker/src/services/adminOverview.ts`
- Test: `worker/tests/admin-overview.test.cjs`

- [ ] **Step 1: 先写失败测试**

在 `worker/tests/admin-overview.test.cjs` 里扩展 `admin overview returns metrics, setup state and risks`，新增断言：

- `totalTexts`
- `textsUpdated7d`
- `textsUpdated8To30d`
- `textsStaleOver30d`
- `activeShares`
- `expiredShares`
- `exhaustedShares`
- `consumedShares`

同时补对应 SQL handler，先不改生产代码。

- [ ] **Step 2: 运行单测确认失败**

Run: `npm --prefix worker run test -- admin-overview.test.cjs`

Expected: 断言失败，提示 overview metrics 中缺少新增字段，或出现未匹配 SQL。

- [ ] **Step 3: 写最小实现**

在 `worker/src/services/adminOverview.ts` 中：

- 扩展 `metrics` 返回类型
- 新增文档聚合 SQL
- 新增分享聚合 SQL
- 把结果并入 `metrics`

实现约束：

- 文档只统计 `deleted_at IS NULL`
- 分享需排除已删除文件和已删除文档
- 普通分享先 `expired` 再 `exhausted`
- 一次性分享先 `consumed` 再 `expired`

- [ ] **Step 4: 重新运行单测确认通过**

Run: `npm --prefix worker run test -- admin-overview.test.cjs`

Expected: PASS

### Task 2: 前端 helper 模型扩展

**Files:**
- Modify: `frontend/src/utils/adminDashboard.js`
- Modify: `frontend/src/views/Dashboard.vue`
- Modify: `frontend/src/locales/zh-CN/pages/dashboard.js`
- Modify: `frontend/src/locales/en-US/pages/dashboard.js`
- Test: `frontend/tests/dashboard-helpers.test.js`

- [ ] **Step 1: 先写失败测试**

在 `frontend/tests/dashboard-helpers.test.js` 中扩展：

- `buildOverviewCardsModel` 断言新增“文档与分享”概览卡
- `buildDashboardInsightsModel` 断言新增 `shareStatus` 与 `textFreshness`

- [ ] **Step 2: 运行前端 helper 测试确认失败**

Run: `node --test frontend/tests/dashboard-helpers.test.js`

Expected: FAIL，提示缺少新的卡片或 insights 模型字段。

- [ ] **Step 3: 写最小实现**

在 `frontend/src/utils/adminDashboard.js` 中：

- 追加概览卡模型
- 追加分享状态柱状图数据模型
- 追加文档更新结构数据模型

在 `frontend/src/views/Dashboard.vue` 中：

- 扩展 `defaultOverview().metrics`

在中英文文案中补齐新增标题和标签。

- [ ] **Step 4: 重新运行 helper 测试确认通过**

Run: `node --test frontend/tests/dashboard-helpers.test.js`

Expected: PASS

### Task 3: Insights 组件渲染扩展

**Files:**
- Modify: `frontend/src/components/dashboard/DashboardInsights.vue`
- Test: `frontend/tests/dashboard-insights.test.js`
- Test: `frontend/tests/dashboard-layout.test.js`

- [ ] **Step 1: 先写失败测试**

在 `frontend/tests/dashboard-insights.test.js` 中新增断言：

- 存在分享状态区容器
- 存在分享柱状图结构
- 存在文档更新区容器
- 存在文档结构条

如布局有新容器命名，再同步补 `frontend/tests/dashboard-layout.test.js` 的必要结构断言。

- [ ] **Step 2: 运行组件测试确认失败**

Run: `node --test frontend/tests/dashboard-insights.test.js frontend/tests/dashboard-layout.test.js`

Expected: FAIL，提示缺少新增 DOM 结构或类名。

- [ ] **Step 3: 写最小实现**

在 `frontend/src/components/dashboard/DashboardInsights.vue` 中：

- 在右侧健康面板内追加分享状态模块
- 使用紧凑柱状图表达 `active / expired / exhausted / consumed`
- 追加文档更新结构模块
- 保持现有用户主卡和整体克制视觉风格不变

- [ ] **Step 4: 重新运行组件测试确认通过**

Run: `node --test frontend/tests/dashboard-insights.test.js frontend/tests/dashboard-layout.test.js`

Expected: PASS

### Task 4: 全量回归

**Files:**
- Verify only

- [ ] **Step 1: 运行 worker 全量测试**

Run: `npm --prefix worker run test`

Expected: PASS

- [ ] **Step 2: 运行前端 dashboard 测试**

Run: `node --test frontend/tests/*.test.js`

Expected: PASS

- [ ] **Step 3: 运行构建**

Run: `npm run build`

Expected: PASS
