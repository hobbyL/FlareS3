# Dashboard Insights Style Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变仪表盘数据结构、接口和交互行为的前提下，精修 `DashboardInsights` 的视觉层级，使其更克制、更成熟，并与当前项目主题保持一致。

**Architecture:** 保持现有 `Dashboard.vue -> OverviewCards + DashboardInsights` 的结构和 `getAdminOverview()` 单请求数据流不变；改动集中在 `DashboardInsights.vue` 的模板分区与样式系统，必要时只对 `Dashboard.vue` 做小幅间距微调；继续使用现有 `node:test` 源码级断言锁定结构与响应式约束，不引入新的测试框架或视觉依赖。

**Tech Stack:** Vue 3、CSS、SVG、node:test、vue-i18n、现有 Card 组件

---

**Planned Files**

- Modify: `frontend/src/components/dashboard/DashboardInsights.vue`
  责任：完成“更克制”的视觉精修，包括标题层级、环图权重、图例对齐、右侧运行健康统一分区、状态轨道和紧凑指标块样式。
- Modify: `frontend/src/views/Dashboard.vue`
  责任：仅在需要时微调 `OverviewCards` 与 `DashboardInsights` 的垂直节奏，避免页面上下区块黏连或空隙失衡。
- Modify: `frontend/tests/dashboard-insights.test.js`
  责任：把当前“基础存在性断言”升级为“结构与样式约束断言”，锁定新的分区类名、双列比例和响应式行为。
- Modify: `frontend/tests/dashboard-layout.test.js`
  责任：在不改变业务约束的前提下，补充页面节奏与接入点的安全断言，防止精修时误改整体布局。

**Constraints**

- 不改 `frontend/src/utils/adminDashboard.js` 的数据派生逻辑。
- 不改中英文文案，只做结构与样式精修。
- 不新增组件文件，不拆分子组件。
- 不新增交互行为，不引入 tooltip、跳转或下钻。
- 按当前会话约束执行，不使用子代理，不使用 worktree，不包含 `git commit` 步骤。

### Task 1: 先锁定视觉结构断言

**Files:**
- Modify: `frontend/tests/dashboard-insights.test.js`
- Modify: `frontend/tests/dashboard-layout.test.js`
- Test: `frontend/tests/dashboard-insights.test.js`
- Test: `frontend/tests/dashboard-layout.test.js`

- [ ] **Step 1: 为新的视觉分区写失败测试**

在 `frontend/tests/dashboard-insights.test.js` 中新增源码级断言，覆盖：

- `DashboardInsights.vue` 的左卡存在更完整的头部层级容器，而不是只有单独一行标题。
- 右卡中“上传配置”和“文件预警”存在统一的内部区块容器，避免继续以两个松散模块堆叠。
- 文件预警项采用统一行块结构，右侧数字与左侧标签保持同一层级。
- 桌面端双列比例仍保持“左主右辅”，但右侧最小宽度不应过宽。
- 移动端仍折叠为单列。

在 `frontend/tests/dashboard-layout.test.js` 中补充断言，要求：

- `Dashboard.vue` 继续在 `OverviewCards` 下方渲染 `DashboardInsights`。
- `dashboard-page` 继续使用列布局和统一 `gap`，避免样式精修时意外引入额外布局容器。

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test frontend/tests/dashboard-layout.test.js frontend/tests/dashboard-insights.test.js`
Expected: FAIL，提示当前 `DashboardInsights.vue` 尚未具备新的结构类名或布局约束。

- [ ] **Step 3: 最小化调整测试命名与断言范围**

确保断言只锁定真正需要长期稳定的结构：

- 外层网格
- 左右主辅卡
- 右卡内部分区
- 移动端单列回退

不要把过于具体的像素值或临时装饰类写死到测试里。

- [ ] **Step 4: 再次运行结构测试**

Run: `node --test frontend/tests/dashboard-layout.test.js frontend/tests/dashboard-insights.test.js`
Expected: 仍然 FAIL，但失败点应只剩模板和样式实现，说明测试边界收敛正确。

### Task 2: 重做 DashboardInsights 模板分区

**Files:**
- Modify: `frontend/src/components/dashboard/DashboardInsights.vue`
- Test: `frontend/tests/dashboard-insights.test.js`

- [ ] **Step 1: 调整左卡头部与内容骨架**

在 `DashboardInsights.vue` 中重组左卡模板：

- 为标题区增加更稳定的头部包裹层，允许后续通过副标题、小标签或间距建立层级。
- 保持环图、中心值、图例的数据渲染逻辑不变。
- 图例项保留“左标签 + 右数值”的结构，不改变字段来源。

- [ ] **Step 2: 调整右卡为统一面板结构**

在 `DashboardInsights.vue` 中重组右卡模板：

- 为右卡增加统一的内部主容器。
- 将“上传配置健康”和“文件预警”包裹进两个浅层分区容器。
- 保持 `config-health` 和 `file-alerts` 的语义结构可识别，避免测试和可读性回退。

- [ ] **Step 3: 运行结构测试验证模板通过**

Run: `node --test frontend/tests/dashboard-insights.test.js`
Expected: PASS

### Task 3: 完成克制风格的样式精修

**Files:**
- Modify: `frontend/src/components/dashboard/DashboardInsights.vue`
- Modify: `frontend/src/views/Dashboard.vue`
- Test: `frontend/tests/dashboard-insights.test.js`
- Test: `frontend/tests/dashboard-layout.test.js`

- [ ] **Step 1: 精修左侧用户状态卡样式**

在 `DashboardInsights.vue` 的 `<style scoped>` 中：

- 收窄环图线宽，降低当前“偏粗”的重量感。
- 强化中心主数字，弱化总量标签与空态说明。
- 统一图例项的上下间距、左右对齐和分隔节奏。
- 将主色收敛为深墨色系，保留低饱和绿色作为正向状态，其他状态退回灰阶。

- [ ] **Step 2: 精修右侧运行健康卡样式**

在 `DashboardInsights.vue` 的 `<style scoped>` 中：

- 为右卡内部两个分区加入轻背景、细边框或弱分隔线，形成统一面板感。
- 将步骤条调整为更细、更短的状态轨道。
- 将状态标签弱化为更轻的胶囊徽标，不让其抢过主信息。
- 把两个文件预警项统一成紧凑、等尺寸、低噪声的信息块。

- [ ] **Step 3: 调整整块区域的节奏与响应式**

在 `DashboardInsights.vue` 和必要时 `Dashboard.vue` 中：

- 缩小右列最小宽度，减少大屏下的右侧空白。
- 微调双列 `gap`、卡片内边距和区块间距，使 `8 / 12 / 16` 节奏更稳定。
- 保持 `@media (max-width: 720px)` 下单列回退，必要时补充中间宽度下的栅格优化，避免右列发虚。

- [ ] **Step 4: 运行聚焦测试**

Run: `node --test frontend/tests/dashboard-layout.test.js frontend/tests/dashboard-insights.test.js`
Expected: PASS

### Task 4: 做完整回归验证

**Files:**
- Modify: `frontend/src/components/dashboard/DashboardInsights.vue`
- Modify: `frontend/src/views/Dashboard.vue`
- Modify: `frontend/tests/dashboard-insights.test.js`
- Modify: `frontend/tests/dashboard-layout.test.js`

- [ ] **Step 1: 运行仪表盘相关测试**

Run: `node --test frontend/tests/dashboard-helpers.test.js frontend/tests/dashboard-layout.test.js frontend/tests/dashboard-insights.test.js`
Expected: PASS

- [ ] **Step 2: 运行前端完整测试集**

Run: `node --test frontend/tests/*.test.js`
Expected: PASS

- [ ] **Step 3: 运行前端构建**

Run: `npm run build`
Expected: PASS，且无新增样式语法或模板编译错误。

- [ ] **Step 4: 做最终代码级人工检查**

确认以下点：

- `Dashboard.vue` 仍只使用一次 `getAdminOverview()`。
- `DashboardInsights.vue` 未引入新的业务计算或交互行为。
- 右侧卡片视觉更整合，但没有堆出额外的复杂层级。
- 移动端单列逻辑未被破坏。
- 整体风格与当前项目主题一致，没有出现展示型大屏风格偏移。
