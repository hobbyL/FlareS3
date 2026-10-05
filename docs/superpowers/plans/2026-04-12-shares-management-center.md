# Shares Management Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为登录用户新增 `/shares` 独立分享管理中心，统一管理文件分享、文档分享和一次性文档分享。

**Architecture:** 后端新增一个轻量聚合列表接口，把 `file_shares`、`text_shares`、`text_one_time_shares` 映射为统一记录模型；前端新增 `Shares.vue` 作为统一列表页，复用现有分享弹窗与生成接口完成编辑、关闭、重新生成等操作。整体遵循 KISS/YAGNI：不引入历史记录、不重写现有弹窗、不做批量操作。

**Tech Stack:** Vue 3 + Vite、Vue Router、Vue I18n、Axios、Cloudflare Workers、D1、Node test

---

## 范围确认

**本轮包含：**

- 新增 `/shares` 路由与侧边栏一级导航
- 普通用户查看自己的分享；管理员查看全站分享并按所属用户筛选
- 聚合展示三类分享：
  - `file_shares`
  - `text_shares`
  - `text_one_time_shares`
- 支持基础操作：
  - 复制链接
  - 打开链接
  - 关闭分享
  - 编辑普通分享配置（复用现有 `FileShareModal` / `TextShareModal`）
  - 重新生成一次性文档分享
- 支持最小筛选：
  - 类型
  - 状态
  - 管理员额外支持所属用户
- 补齐后端与前端最小自动化回归

**本轮明确不做：**

- 分享历史记录
- 关键词搜索、时间范围筛选
- 批量操作
- 未分享文件/文档的统一展示
- 重写 `FileShareModal`、`TextShareModal`、`TextQrModal`
- git commit / branch / reset / push（按当前用户要求，计划与执行均不包含）

## 文件结构与职责

### 新增后端文件

- `worker/src/routes/shares.ts`：提供 `GET /api/shares`，解析筛选参数并返回统一列表结果。
- `worker/src/services/shares.ts`：聚合三类分享记录、统一状态映射、排序、分页与权限过滤。
- `worker/tests/shares-route.test.cjs`：覆盖统一列表接口、权限边界、筛选行为与一次性分享关闭接口。

### 修改后端文件

- `worker/src/index.ts`：注册 `/api/shares` 与 `DELETE /api/texts/:id/one-time-share`。
- `worker/src/routes/textOneTimeShares.ts`：抽出文本授权逻辑，新增删除一次性分享接口并保持现有生成逻辑不回归。

### 新增前端文件

- `frontend/src/views/Shares.vue`：`/shares` 页面容器，负责筛选、列表渲染、操作联动与刷新。
- `frontend/src/utils/shares.js`：统一处理分享类型/状态显示、访问次数文本、按钮可用性等纯函数。
- `frontend/tests/shares-utils.test.js`：覆盖 `shares.js` 的状态与展示逻辑。
- `frontend/src/locales/zh-CN/pages/shares.js`：中文文案。
- `frontend/src/locales/en-US/pages/shares.js`：英文文案。

### 修改前端文件

- `frontend/src/router/index.js`：新增 `/shares` 路由。
- `frontend/src/components/layout/BrutalSidebar.vue`：新增分享中心导航项。
- `frontend/src/services/api.js`：新增 `listShares`、`deleteTextOneTimeShare`。
- `frontend/src/locales/zh-CN/common.js`
- `frontend/src/locales/en-US/common.js`
- `frontend/src/locales/zh-CN/index.js`
- `frontend/src/locales/en-US/index.js`

## 现有模式复用约束

- 页面骨架复用 `frontend/src/views/Users.vue` 的 `AppLayout + header + filter-row + Card + Table + Pagination` 模式。
- 状态标签复用 `Tag` 用法，参考 `Users.vue` 的 `columns.status.render`。
- 操作列复用 `Button + lucide icon + action-buttons` 模式，参考 `Users.vue` 与 `Files.vue`。
- 编辑普通分享配置时直接复用：
  - `frontend/src/components/files/FileShareModal.vue`
  - `frontend/src/components/texts/TextShareModal.vue`
- 一次性分享继续复用 `api.createTextOneTimeShare`，但 `/shares` 主交互不复用 `TextQrModal.vue`。

## 验证命令

- `cd "worker" && npm run test:build && WORKER_TEST_OUTDIR="$PWD/.test-dist" node --test "tests/shares-route.test.cjs" "tests/share-access-guard.test.cjs" "tests/user-resource-lifecycle.test.cjs"`
- `npm --prefix "worker" run typecheck`
- `npm --prefix "worker" run lint`
- `npm --prefix "worker" run test`
- `node --test "frontend/tests/shares-utils.test.js" "frontend/tests/user-management.test.js"`
- `npm --prefix "frontend" run lint`
- `npm --prefix "frontend" run build`

## 推荐执行顺序

1. 先补后端回归测试，锁定聚合列表与一次性分享关闭行为
2. 实现后端聚合 service / route 与 delete one-time-share
3. 补前端纯函数测试和工具函数
4. 接入前端 API、路由、导航与文案
5. 实现 `Shares.vue` 列表、筛选与操作联动
6. 做全量验证与联调

---

### Task 1: 锁定后端接口合同与权限边界

**Files:**
- Create: `worker/tests/shares-route.test.cjs`
- Reference: `worker/tests/share-access-guard.test.cjs`
- Reference: `worker/tests/user-resource-lifecycle.test.cjs`

- [ ] **Step 1: 写统一分享列表接口的失败测试**

在 `worker/tests/shares-route.test.cjs` 中新增最小测试夹具，沿用现有 `createDb` / `compiledPath` / `loadModule` 模式，先定义这些场景：

- 普通用户请求 `/api/shares` 时只能拿到自己的记录
- 管理员请求 `/api/shares?owner_id=user-2` 时只拿到指定用户记录
- `type=file|text|text_one_time` 筛选生效
- `status=active|expired|exhausted|consumed` 筛选生效

- [ ] **Step 2: 写一次性分享关闭接口的失败测试**

继续在 `worker/tests/shares-route.test.cjs` 中补两个场景：

- owner 或 admin 调用 `DELETE /api/texts/:id/one-time-share` 删除成功
- 记录不存在时返回幂等成功 `{ success: true, deleted: false }`

- [ ] **Step 3: 跑最小后端测试并确认当前失败**

Run:

```bash
cd "worker" && npm run test:build && WORKER_TEST_OUTDIR="$PWD/.test-dist" node --test "tests/shares-route.test.cjs"
```

Expected:

- `shares-route.test.cjs` 失败
- 失败原因是缺少 `routes/shares.ts` 或缺少 `deleteTextOneTimeShare`

### Task 2: 实现后端聚合 service、列表 route 与一次性分享关闭

**Files:**
- Create: `worker/src/services/shares.ts`
- Create: `worker/src/routes/shares.ts`
- Modify: `worker/src/routes/textOneTimeShares.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/tests/shares-route.test.cjs`

- [ ] **Step 1: 在 `textOneTimeShares.ts` 抽出授权 helper**

把当前 `createTextOneTimeShare` 中的“读取文本 + 校验 owner/admin 权限”逻辑提取成文件内私有 helper，供创建和删除共用，避免重复 SQL 与分支。

- [ ] **Step 2: 新增 `deleteTextOneTimeShare`**

在 `worker/src/routes/textOneTimeShares.ts` 中新增：

- `deleteTextOneTimeShare(request, env, textId)`

行为要求：

- 文本不存在 -> `404`
- 非 owner 且非 admin -> `403`
- 存在记录时执行 `DELETE FROM text_one_time_shares WHERE text_id = ?`
- 不存在记录时返回幂等成功

- [ ] **Step 3: 实现统一分享聚合 service**

在 `worker/src/services/shares.ts` 中实现最小必要能力：

- `listShares(request, env)` 或等价聚合函数
- 分别查询：
  - `file_shares` + `files` + `users`
  - `text_shares` + `texts` + `users`
  - `text_one_time_shares` + `texts` + `users`
- 过滤：
  - 已删除文件
  - 已删除文本
  - 非 active owner 导致的无效记录
- 统一映射字段：
  - `type`
  - `resource_id`
  - `resource_name`
  - `owner_id`
  - `owner_username`
  - `share_code`
  - `share_url`
  - `status`
  - `views`
  - `max_views`
  - `has_password`
  - `expires_at`
  - `consumed_at`
  - `created_at`
  - `updated_at`

- [ ] **Step 4: 在 service 内实现状态推导与筛选**

状态规则严格对齐设计：

- 文件/文档分享：
  - `expires_at <= now` -> `expired`
  - `max_views > 0 && views >= max_views` -> `exhausted`
  - 其他 -> `active`
- 一次性分享：
  - `consumed_at != null` -> `consumed`
  - `expires_at <= now` -> `expired`
  - 其他 -> `active`

筛选顺序：

1. 权限过滤
2. `owner_id`（仅管理员）
3. `type`
4. `status`
5. 按 `updated_at DESC` 排序
6. 应用 `page/limit`

- [ ] **Step 5: 新增 `GET /api/shares` route 并注册到 `index.ts`**

在 `worker/src/routes/shares.ts` 中解析参数并调用 service；在 `worker/src/index.ts` 注册：

- `GET /api/shares`
- `DELETE /api/texts/:id/one-time-share`

保持现有 `withAuth` 鉴权方式，不新增新的 auth middleware。

- [ ] **Step 6: 运行后端回归**

Run:

```bash
cd "worker" && npm run test:build && WORKER_TEST_OUTDIR="$PWD/.test-dist" node --test "tests/shares-route.test.cjs" "tests/share-access-guard.test.cjs" "tests/user-resource-lifecycle.test.cjs"
```

Expected:

- 新增列表与删除接口测试通过
- 既有分享访问与用户资源生命周期测试不回归

### Task 3: 提炼前端纯函数并先写测试

**Files:**
- Create: `frontend/src/utils/shares.js`
- Create: `frontend/tests/shares-utils.test.js`
- Reference: `frontend/tests/user-management.test.js`

- [ ] **Step 1: 写 `shares.js` 的失败测试**

在 `frontend/tests/shares-utils.test.js` 中覆盖纯函数，建议至少包括：

- `toShareStatusVariant('active'|'expired'|'exhausted'|'consumed')`
- `canOpenShare(record)`：一次性分享非 `active` 时返回 `false`
- `formatShareVisits(record, t)`：普通分享显示 `views/max_views`，一次性分享显示 `-`
- `hasEditableConfig(record)`：仅 `file` / `text` 为 `true`

- [ ] **Step 2: 跑前端最小测试并确认当前失败**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js"
```

Expected:

- 失败，原因是 `frontend/src/utils/shares.js` 尚不存在

- [ ] **Step 3: 实现 `frontend/src/utils/shares.js`**

保持纯函数、无 Vue 依赖，建议导出：

- `toShareTypeLabelKey`
- `toShareStatusLabelKey`
- `toShareStatusVariant`
- `formatShareVisits`
- `hasEditableConfig`
- `canOpenShare`

- [ ] **Step 4: 运行前端纯函数测试**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js" "frontend/tests/user-management.test.js"
```

Expected:

- 新增 shares utils 测试通过
- 既有 user-management 工具测试不回归

### Task 4: 接入前端 API、路由、导航与文案

**Files:**
- Modify: `frontend/src/services/api.js`
- Modify: `frontend/src/router/index.js`
- Modify: `frontend/src/components/layout/BrutalSidebar.vue`
- Modify: `frontend/src/locales/zh-CN/common.js`
- Modify: `frontend/src/locales/en-US/common.js`
- Modify: `frontend/src/locales/zh-CN/index.js`
- Modify: `frontend/src/locales/en-US/index.js`
- Create: `frontend/src/locales/zh-CN/pages/shares.js`
- Create: `frontend/src/locales/en-US/pages/shares.js`

- [ ] **Step 1: 在 `api.js` 新增分享中心接口**

新增：

- `listShares(params = {})`
- `deleteTextOneTimeShare(textId)`

继续复用已有：

- `getFileShare`
- `upsertFileShare`
- `deleteFileShare`
- `getTextShare`
- `upsertTextShare`
- `deleteTextShare`
- `createTextOneTimeShare`

- [ ] **Step 2: 新增路由 `/shares`**

在 `frontend/src/router/index.js` 中增加：

- `path: '/shares'`
- `name: 'Shares'`
- `component: () => import('../views/Shares.vue')`
- `meta: { requiresAuth: true }`

- [ ] **Step 3: 在侧边栏加入一级导航**

在 `BrutalSidebar.vue` 中把导航顺序调整为：

- `/`
- `/texts`
- `/shares`
- 其后保留管理员导航

不要改变现有管理员页面的可见性逻辑。

- [ ] **Step 4: 新增并接入 i18n 文案**

在 `common.js` 中新增：

- `nav.shares`

在 `pages/shares.js` 中新增页面文案分组，至少包括：

- 标题/副标题
- 类型筛选
- 状态筛选
- 所属用户筛选
- 列标题
- 状态文案
- 类型文案
- 操作文案
- 空态与错误提示

- [ ] **Step 5: 跑静态检查前置验证**

Run:

```bash
npm --prefix "frontend" run lint
```

Expected:

- 路由、文案、API 方法新增后仍通过 lint
- 此时即使 `Shares.vue` 未完成，也不应出现 import 路径或未使用变量错误

### Task 5: 实现 `Shares.vue` 统一列表页

**Files:**
- Create: `frontend/src/views/Shares.vue`
- Modify: `frontend/src/services/api.js`
- Reference: `frontend/src/views/Users.vue`
- Reference: `frontend/src/components/files/FileShareModal.vue`
- Reference: `frontend/src/components/texts/TextShareModal.vue`
- Reference: `frontend/src/utils/shares.js`

- [ ] **Step 1: 搭页面骨架**

基于 `Users.vue` 复用以下结构：

- `AppLayout`
- 页面 header（标题 + 副标题）
- `filter-row`
- `Card`
- `Table`
- `Pagination`

状态管理最小化为：

- `items`
- `loading`
- `pagination`
- `filters`
- `activeAction`
- 当前打开中的分享对象

- [ ] **Step 2: 接入列表加载与筛选**

实现：

- `loadShares`
- `buildQueryParams`
- `handleSearch`
- `handleRefresh`
- `changePage`
- `changePageSize`

筛选字段仅保留：

- `type`
- `status`
- `owner_id`（仅管理员可见）

不要在第一版加入关键词搜索或日期范围。

- [ ] **Step 3: 定义统一表格列**

建议列：

- 类型
- 名称
- 链接
- 状态
- 访问情况
- 过期时间
- 口令
- 所属用户（管理员）
- 更新时间
- 操作

渲染细节：

- 状态列使用 `Tag`
- 链接列提供复制按钮与打开按钮
- 一次性分享的访问情况显示 `-`
- 一次性分享的口令状态显示 `-`

- [ ] **Step 4: 接入操作列逻辑**

实现三类记录差异化操作：

- `file`
  - 编辑 -> 打开 `FileShareModal`
  - 关闭 -> `api.deleteFileShare`
- `text`
  - 编辑 -> 打开 `TextShareModal`
  - 关闭 -> `api.deleteTextShare`
- `text_one_time`
  - 重新生成 -> `api.createTextOneTimeShare`
  - 关闭 -> `api.deleteTextOneTimeShare`

通用操作：

- 复制链接
- 打开链接（`canOpenShare(record)` 为 `true` 才允许）

- [ ] **Step 5: 复用弹窗并处理回写刷新**

在 `Shares.vue` 中挂载：

- `FileShareModal`
- `TextShareModal`

要求：

- 打开对应弹窗时传入正确的 `file-id` / `text-id`
- 弹窗关闭后刷新列表
- 删除或重新生成后刷新当前页
- 重新生成一次性分享成功后立即复制新链接并提示成功

- [ ] **Step 6: 补空态与错误态**

至少区分：

- 无任何分享记录
- 当前筛选条件无结果
- 列表加载失败

保持现有 `useMessage` 提示风格，不新增复杂错误面板组件。

- [ ] **Step 7: 运行前端验证**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js" "frontend/tests/user-management.test.js"
npm --prefix "frontend" run lint
npm --prefix "frontend" run build
```

Expected:

- 工具测试通过
- `Shares.vue` lint 通过
- Vite build 成功

### Task 6: 全量回归与联调验收

**Files:**
- Verify only

- [ ] **Step 1: 跑后端全量验证**

Run:

```bash
npm --prefix "worker" run typecheck
npm --prefix "worker" run lint
npm --prefix "worker" run test
```

Expected:

- worker 类型检查、lint、单测全部通过

- [ ] **Step 2: 跑前端全量验证**

Run:

```bash
node --test "frontend/tests/*.test.js"
npm --prefix "frontend" run lint
npm --prefix "frontend" run build
```

Expected:

- 前端现有 node:test 全部通过
- lint / build 通过

- [ ] **Step 3: 做手工联调清单**

使用管理员与普通用户分别验证：

- 普通用户打开 `/shares` 仅看到自己的分享
- 管理员可看到全站分享，且 `owner_id` 筛选有效
- 文件分享可复制、打开、编辑、关闭
- 文档分享可复制、打开、编辑、关闭
- 一次性分享可复制、打开（active）、重新生成、关闭
- 过期 / 已消费记录状态显示正确
- 关闭后的普通分享从列表消失
- 关闭后重新生成的一次性分享使用新链接，旧链接失效

- [ ] **Step 4: 记录验收结果**

在执行阶段输出：

- 实际运行的验证命令
- 通过/失败结果
- 若有已知残留问题，明确记录在 handoff 中，不要口头省略

---

## 执行提示

- 先做后端，再做前端，避免前端在接口未定时反复改模型。
- `worker/src/services/shares.ts` 保持为本轮唯一的聚合中心，避免在 route 中散落三套查询。
- `frontend/src/views/Shares.vue` 第一版不拆子组件；若文件超过现有页面可维护范围，再在执行阶段局部拆分。
- 一次性分享的“重新生成”是管理动作，不需要在 `/shares` 里再次展示二维码。
