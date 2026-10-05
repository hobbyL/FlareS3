# Dashboard Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为仪表盘补充轻量图表与运行健康区，在不增加后端接口和图表依赖的前提下，让页面信息密度更平衡。

**Architecture:** 保持 `Dashboard.vue` 的单请求数据流不变，在 `OverviewCards` 下新增一个 `DashboardInsights` 组件承载图形化展示；将所有用户状态、配置健康和文件预警的派生逻辑统一收敛到 `adminDashboard.js`，组件只消费格式化后的展示模型；沿用现有 `node:test + 源码断言` 测试模式，不引入新的组件测试框架。

**Tech Stack:** Vue 3、SVG、node:test、vue-i18n、现有 Card/Tag/Button 组件

---

**Planned Files**

- Create: `frontend/src/components/dashboard/DashboardInsights.vue`
  责任：渲染用户状态环图、上传配置健康状态条、文件预警指标块，并处理移动端折叠布局。
- Modify: `frontend/src/views/Dashboard.vue`
  责任：引入并挂载 `DashboardInsights`，复用现有 `overview.metrics`、`overview.setup` 和 `loading`。
- Modify: `frontend/src/utils/adminDashboard.js`
  责任：新增 insights 展示模型 helper，统一计算 `otherUsers`、环图分段、配置健康状态和文件预警展示数据。
- Modify: `frontend/src/locales/zh-CN/pages/dashboard.js`
  责任：补充 insights 区标题、图例、状态文案和空态文案。
- Modify: `frontend/src/locales/en-US/pages/dashboard.js`
  责任：补充英文对应文案。
- Modify: `frontend/tests/dashboard-helpers.test.js`
  责任：锁定 helper 的派生口径和空态规则。
- Modify: `frontend/tests/dashboard-layout.test.js`
  责任：锁定 `Dashboard.vue` 已接入 insights 区且保持当前精简布局约束。
- Create: `frontend/tests/dashboard-insights.test.js`
  责任：对 `DashboardInsights.vue` 做源码级结构与样式断言，锁定两栏布局、环图和运行健康区域。

**Constraints**

- 不新增后端接口，不改 `worker/src/services/adminOverview.ts`。
- 不引入新的图表库，只用 SVG 和 CSS。
- 不恢复风险面板和任务面板。
- 按仓库协作约束，本计划不包含 `git commit` 步骤。

### Task 1: 锁定 insights helper 的数据口径

**Files:**
- Modify: `frontend/tests/dashboard-helpers.test.js`
- Test: `frontend/tests/dashboard-helpers.test.js`

- [ ] **Step 1: Write the failing helper tests**

在 `dashboard-helpers.test.js` 中新增断言，覆盖：
- `buildDashboardInsightsModel` 或等价 helper 能返回 `userStatus`、`configHealth`、`fileAlerts` 三段展示模型。
- `otherUsers = max(totalUsers - activeUsers - disabledUsers, 0)`，不会出现负数。
- `totalUsers = 0` 时返回空态环图模型，不输出误导性分段比例。
- 配置健康状态按优先级输出 `missing -> pendingDefault -> ready`。
- 文件预警仅保留 `expiringThisWeek`、`pendingDeleteQueue` 两个独立指标，不混算占比。

- [ ] **Step 2: Run the helper test to verify it fails**

Run: `node --test frontend/tests/dashboard-helpers.test.js`
Expected: FAIL，提示 `adminDashboard.js` 尚未导出或实现 insights helper。

- [ ] **Step 3: Implement the minimal helper logic**

在 `frontend/src/utils/adminDashboard.js` 中：
- 新增数值归一化和分段计算复用逻辑，避免把业务计算散落到组件模板。
- 导出 insights helper，最少包含：
  - 用户状态分布模型
  - 上传配置健康模型
  - 文件预警模型
- 沿用现有 `loading` 占位值处理方式，保证 0 数据和 loading 行为一致。

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `node --test frontend/tests/dashboard-helpers.test.js`
Expected: PASS

### Task 2: 锁定页面接入点与 insights 结构约束

**Files:**
- Modify: `frontend/tests/dashboard-layout.test.js`
- Create: `frontend/tests/dashboard-insights.test.js`
- Test: `frontend/tests/dashboard-layout.test.js`
- Test: `frontend/tests/dashboard-insights.test.js`

- [ ] **Step 1: Write the failing layout/source tests**

在 `dashboard-layout.test.js` 中补充断言，要求：
- `Dashboard.vue` 引入并渲染 `DashboardInsights`。
- `Dashboard.vue` 继续只发起 `getAdminOverview()`，不新增第二个请求入口。
- 现有“只保留概览卡片、不恢复风险和任务面板”的约束仍成立。

新建 `dashboard-insights.test.js`，做源码级断言，至少覆盖：
- 组件使用 `Card` 承载两个区块。
- 外层网格为桌面双列、移动端单列。
- 存在 SVG 环图结构。
- 存在上传配置健康区和文件预警区的容器类名。
- 图例和指标块均展示文本，不依赖纯颜色表达。

- [ ] **Step 2: Run the layout/source tests to verify they fail**

Run: `node --test frontend/tests/dashboard-layout.test.js frontend/tests/dashboard-insights.test.js`
Expected: FAIL，提示 `DashboardInsights.vue` 尚不存在，且 `Dashboard.vue` 尚未接入新组件。

- [ ] **Step 3: Implement the minimal view/component skeleton**

实现最小可渲染骨架：
- 新建 `frontend/src/components/dashboard/DashboardInsights.vue`
- 在 `frontend/src/views/Dashboard.vue` 中引入并传入 `metrics`、`setup`、`loading`
- 先搭出结构类名、两栏布局、SVG 容器和运行健康分区，使源码级测试先通过

- [ ] **Step 4: Run the layout/source tests to verify they pass**

Run: `node --test frontend/tests/dashboard-layout.test.js frontend/tests/dashboard-insights.test.js`
Expected: PASS

### Task 3: 完成 insights 展示细节与本地化文案

**Files:**
- Modify: `frontend/src/components/dashboard/DashboardInsights.vue`
- Modify: `frontend/src/utils/adminDashboard.js`
- Modify: `frontend/src/locales/zh-CN/pages/dashboard.js`
- Modify: `frontend/src/locales/en-US/pages/dashboard.js`
- Test: `frontend/tests/dashboard-helpers.test.js`
- Test: `frontend/tests/dashboard-insights.test.js`

- [ ] **Step 1: Fill in the rendering details**

在 `DashboardInsights.vue` 中完成：
- 用户状态环图的圆环路径、中心主值、图例和空态分支
- 上传配置健康状态条、状态标签和配置数量展示
- 文件预警两个指标块及其状态色层级
- 移动端折叠样式，避免右侧模块在窄屏下拥挤

- [ ] **Step 2: Add the localized strings**

在中英文 `dashboard.js` 中新增最小必要文案，至少包括：
- insights 区块标题
- 用户状态分布标题、总数、启用、禁用、其他、空态
- 上传配置健康标题、三种状态文案
- 文件预警标题、两项指标标签

- [ ] **Step 3: Run focused dashboard tests**

Run: `node --test frontend/tests/dashboard-helpers.test.js frontend/tests/dashboard-layout.test.js frontend/tests/dashboard-insights.test.js`
Expected: PASS

### Task 4: 做前端回归验证

**Files:**
- Modify: `frontend/src/components/dashboard/DashboardInsights.vue`
- Modify: `frontend/src/views/Dashboard.vue`
- Modify: `frontend/src/utils/adminDashboard.js`
- Modify: `frontend/src/locales/zh-CN/pages/dashboard.js`
- Modify: `frontend/src/locales/en-US/pages/dashboard.js`

- [ ] **Step 1: Run the frontend test suite**

Run: `node --test frontend/tests/*.test.js`
Expected: PASS

- [ ] **Step 2: Run the frontend build**

Run: `npm run build`
Expected: PASS，前端可正常构建，无新增语法或导出错误。

- [ ] **Step 3: Do a final visual sanity pass in code**

人工检查以下点：
- `Dashboard.vue` 仍然保持单请求和精简主体结构
- insights 区不会把页面重新拉回多面板堆叠
- 环图、状态条和指标块都保留数字与文案，不只靠颜色
- 移动端样式断点与现有 `OverviewCards` 节奏一致
