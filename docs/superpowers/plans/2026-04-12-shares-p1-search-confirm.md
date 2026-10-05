# Shares P1 Search & Confirm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `/shares` 补齐服务端关键词搜索与关键操作二次确认，提升站长和普通用户的日常管理效率与操作安全性。

**Architecture:** 后端继续沿用现有聚合 service，在统一记录模型上增加 `q` 搜索过滤；前端在 `Shares.vue` 中补关键词输入框，并复用现有 `Modal` 模式实现关闭分享与一次性分享重生成确认。整个实现保持 KISS/YAGNI：不扩展 searchable select，不引入新的全局弹窗机制。

**Tech Stack:** Vue 3 + Vite、Vue I18n、Axios、Cloudflare Workers、D1、Node test

---

## 范围确认

**本轮包含：**

- `GET /api/shares` 新增 `q` 参数
- `/shares` 页面新增关键词搜索框
- 关闭分享前二次确认
- 一次性文档分享重新生成前二次确认
- 最小必要的后端测试与前端验证

**本轮明确不做：**

- 管理员 owner 下拉可搜索
- 批量操作
- 搜索条件记忆
- 时间范围筛选
- 新增页面级组件测试框架
- git commit / branch / reset / push（按当前用户要求，计划与执行均不包含）

## 文件结构与职责

### 修改后端文件

- `worker/src/routes/shares.ts`：为 `/api/shares` 解析新增 `q` 参数。
- `worker/src/services/shares.ts`：在聚合结果上增加关键词匹配逻辑。
- `worker/tests/shares-route.test.cjs`：补充 `q` 搜索合同测试。

### 修改前端文件

- `frontend/src/views/Shares.vue`：新增关键词输入框、请求参数透传、统一确认弹窗与确认后的操作分发。
- `frontend/src/utils/shares.js`：如有必要，抽出可测试的 query params 或确认态纯函数。
- `frontend/tests/shares-utils.test.js`：覆盖新增纯函数（若本轮有抽取）。
- `frontend/src/locales/zh-CN/pages/shares.js`：补充中文文案。
- `frontend/src/locales/en-US/pages/shares.js`：补充英文文案。

## 现有模式复用约束

- 搜索输入框模式对齐 `frontend/src/views/Texts.vue` 的 `Input + Search Button + @keyup.enter`。
- 确认弹窗模式对齐 `frontend/src/views/Files.vue` / `Texts.vue` / `Users.vue` 的页面内 `Modal`。
- 不新增全局 confirm composable。
- 不修改 `api.js` 现有 `listShares` 方法签名，只通过 `params` 扩展 `q`。

## 验证命令

- `cd "worker" && npm run test:build && WORKER_TEST_OUTDIR="$PWD/.test-dist" node --test "tests/shares-route.test.cjs"`
- `node --test "frontend/tests/shares-utils.test.js"`
- `npm --prefix "worker" run typecheck`
- `npm --prefix "worker" run lint`
- `npm --prefix "worker" run test`
- `npm --prefix "frontend" run lint`
- `npm --prefix "frontend" run build`

## 推荐执行顺序

1. 先补后端 `q` 搜索失败测试
2. 实现后端 `q` 搜索
3. 视需要补前端纯函数测试
4. 实现前端搜索框和确认弹窗
5. 做全量验证

---

### Task 1: 锁定 `/api/shares?q=...` 接口合同

**Files:**
- Modify: `worker/tests/shares-route.test.cjs`
- Reference: `worker/src/routes/shares.ts`
- Reference: `worker/src/services/shares.ts`

- [ ] **Step 1: 为普通用户关键词搜索写失败测试**

在 `worker/tests/shares-route.test.cjs` 增加场景：

- `q=alpha` 时，普通用户能命中自己的 `resource_name`
- `q=file-code-1` 时，普通用户能命中自己的 `share_code`
- 即使搜索词能命中其他用户记录，结果仍不能越权返回

- [ ] **Step 2: 为管理员关键词搜索写失败测试**

继续补场景：

- `q=bob` 时，管理员能命中 `owner_username = bob` 的记录
- `q=user-2` 时，管理员能命中 `owner_id = user-2` 的记录
- `q` 与 `type/status/owner_id` 同时出现时仍按组合条件过滤

- [ ] **Step 3: 运行最小后端测试并确认当前失败**

Run:

```bash
cd "worker" && npm run test:build && WORKER_TEST_OUTDIR="$PWD/.test-dist" node --test "tests/shares-route.test.cjs"
```

Expected:

- 新增 `q` 搜索相关断言失败
- 失败原因是当前 route/service 还未解析或应用 `q`

### Task 2: 实现后端 `q` 搜索

**Files:**
- Modify: `worker/src/routes/shares.ts`
- Modify: `worker/src/services/shares.ts`
- Test: `worker/tests/shares-route.test.cjs`

- [ ] **Step 1: 在 route 层加入 `q` 参数解析**

在 `worker/src/routes/shares.ts` 的 `ShareListQuery` 与 `parseFilters` 中加入：

- `q: string`

保持现有参数解析方式，不引入新的 helper 文件。

- [ ] **Step 2: 在 service 层实现关键词匹配 helper**

在 `worker/src/services/shares.ts` 中新增最小纯函数，例如：

- 归一化查询词
- 归一化待匹配字段
- 大小写不敏感包含匹配

约束：

- 空查询词直接视为匹配全部
- 普通用户只匹配 `resource_name / share_code`
- 管理员额外匹配 `owner_username / owner_id`

- [ ] **Step 3: 按既定顺序接入过滤**

在 `listShareItems` 中把 `q` 过滤接到：

1. 权限过滤之后
2. `type/status` 过滤之前

并保持：

- `updated_at DESC` 排序
- 原有分页逻辑不变

- [ ] **Step 4: 运行目标测试确认通过**

Run:

```bash
cd "worker" && npm run test:build && WORKER_TEST_OUTDIR="$PWD/.test-dist" node --test "tests/shares-route.test.cjs"
```

Expected:

- `q` 搜索相关测试通过
- 既有 `/api/shares` 测试不回归

### Task 3: 补前端可测试纯函数（仅在抽取时）

**Files:**
- Modify: `frontend/src/utils/shares.js`
- Modify: `frontend/tests/shares-utils.test.js`
- Reference: `frontend/src/views/Shares.vue`

- [ ] **Step 1: 判断 `Shares.vue` 中是否存在值得抽出的纯逻辑**

优先考虑：

- query params 构造
- 确认动作的元信息映射

约束：

- 只有当抽出后能明显减少组件内分支，才新增工具函数
- 不为测试而制造过度抽象

- [ ] **Step 2: 如果抽取纯函数，先写失败测试**

在 `frontend/tests/shares-utils.test.js` 增加最小场景，例如：

- `q` 会被 `trim`
- 非管理员不会输出 `owner_id`
- 管理员在 `owner_id` 有值时才输出

- [ ] **Step 3: 实现最小纯函数并让测试通过**

保持 `shares.js` 仍然只承载与 `/shares` 展示/交互相关的纯逻辑，不引入组件依赖。

- [ ] **Step 4: 若最终不抽取，明确跳过本任务**

如果评估后发现抽取只会增加间接层，则保留逻辑在 `Shares.vue`，直接进入 Task 4。

### Task 4: 实现前端搜索框与统一确认弹窗

**Files:**
- Modify: `frontend/src/views/Shares.vue`
- Modify: `frontend/src/locales/zh-CN/pages/shares.js`
- Modify: `frontend/src/locales/en-US/pages/shares.js`
- Reference: `frontend/src/views/Texts.vue`
- Reference: `frontend/src/views/Files.vue`

- [ ] **Step 1: 接入关键词输入框**

在 `Shares.vue` 中：

- 引入 `Input`
- 为 `filters` 增加 `q`
- 在筛选区新增关键词输入框
- 支持 `clearable`
- 支持 `@keyup.enter="handleSearch"`

- [ ] **Step 2: 把 `q` 接入请求参数**

修改 `buildQueryParams`（或抽出的纯函数）：

- 空白关键词不透传
- 非空时透传 `q`

保持现有：

- `type`
- `status`
- `owner_id`

逻辑不回归。

- [ ] **Step 3: 新增统一确认状态**

在 `Shares.vue` 中新增最小必要状态，例如：

- `showConfirmModal`
- `pendingConfirmAction`

要求：

- 同一个 `Modal` 复用“关闭分享”和“重新生成一次性分享”
- 按动作种类计算标题、正文、按钮文案、按钮样式

- [ ] **Step 4: 将按钮点击改为先打开确认弹窗**

调整操作列逻辑：

- “关闭分享”按钮 -> 打开确认弹窗，不直接删除
- “重新生成”按钮 -> 打开确认弹窗，不直接调用接口

保留：

- 复制链接
- 打开链接
- 编辑分享

仍然直接执行。

- [ ] **Step 5: 在确认后执行真实操作**

将当前直接执行函数重命名或拆分为：

- `performDisableShare`
- `performRegenerateOneTimeShare`

确认弹窗点击“确认”后再调用对应函数。

- [ ] **Step 6: 补齐中英文文案**

在 `frontend/src/locales/zh-CN/pages/shares.js` 与 `frontend/src/locales/en-US/pages/shares.js` 中补充：

- 搜索框 placeholder
- 关闭分享确认标题/文案
- 重新生成确认标题/文案
- 确认按钮文案

### Task 5: 全量验证

**Files:**
- Verify only

- [ ] **Step 1: 运行前端纯函数测试**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js"
```

Expected:

- 若 Task 3 有抽取，则新增测试通过
- 既有 `shares.js` 测试不回归

- [ ] **Step 2: 运行后端全量测试**

Run:

```bash
npm --prefix "worker" run typecheck
npm --prefix "worker" run lint
npm --prefix "worker" run test
```

Expected:

- 全部通过

- [ ] **Step 3: 运行前端构建验证**

Run:

```bash
npm --prefix "frontend" run lint
npm --prefix "frontend" run build
```

Expected:

- 全部通过

- [ ] **Step 4: 做最小手工联调**

验证至少覆盖：

- 普通用户按资源名/分享码搜索
- 管理员按用户名/owner_id 搜索
- 关闭分享前出现确认
- 重新生成一次性分享前出现确认
- 确认后行为正确，取消后不执行
