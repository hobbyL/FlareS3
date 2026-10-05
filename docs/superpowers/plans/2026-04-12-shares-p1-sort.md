# Shares Sort Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `/shares` 增加最小排序能力，让站长可以直接按最近更新、即将过期、最晚过期查看分享列表。

**Architecture:** 复用 `/files` 已有的 `sort_key -> sort_by/sort_order` 模式，在前端由 `buildSharesQueryParams` 统一拆解排序参数；后端在 `worker/src/services/shares.ts` 的聚合数组上做白名单排序，避免引入新的 SQL 排序抽象。排序字段只开放 `updated_at` 与 `expires_at`，并对 `expires_at = null` 统一尾排。

**Tech Stack:** Vue 3 + Vite、Vue I18n、Cloudflare Workers、D1、Node test

---

## 范围约束

- 只做排序下拉，不做表头点击排序
- 只开放 `updated_at` / `expires_at`
- 不做排序偏好记忆
- 不做 git commit / branch / push / reset（遵循当前用户要求）

## 文件结构与职责

### 后端

- Modify: `worker/src/routes/shares.ts`
  - 解析 `sort_by` / `sort_order`
- Modify: `worker/src/services/shares.ts`
  - 新增排序字段归一化与比较逻辑
- Modify: `worker/tests/shares-route.test.cjs`
  - 覆盖过期排序与空过期时间尾排规则

### 前端

- Modify: `frontend/src/utils/shares.js`
  - 统一处理 `sort_key` 的默认值、拆解和回退
- Modify: `frontend/src/views/Shares.vue`
  - 增加排序下拉并接入筛选状态
- Modify: `frontend/tests/shares-utils.test.js`
  - 锁定排序参数构造行为
- Modify: `frontend/src/locales/zh-CN/pages/shares.js`
  - 新增中文排序文案
- Modify: `frontend/src/locales/en-US/pages/shares.js`
  - 新增英文排序文案

## 验证命令

- `cd "worker" && npm run test:build && WORKER_TEST_OUTDIR="$PWD/.test-dist" node --test "tests/shares-route.test.cjs"`
- `npm --prefix "worker" run typecheck`
- `npm --prefix "worker" run lint`
- `node --test "frontend/tests/shares-utils.test.js"`
- `npm --prefix "frontend" run lint`
- `npm --prefix "frontend" run build`

---

### Task 1: 先锁定 worker 排序合同

**Files:**
- Modify: `worker/tests/shares-route.test.cjs`
- Reference: `worker/src/routes/shares.ts`
- Reference: `worker/src/services/shares.ts`

- [ ] **Step 1: 写失败测试，覆盖即将过期排序**

新增一个 `GET /api/shares?sort_by=expires_at&sort_order=asc` 场景，至少包含：

- 一条最早过期记录
- 一条较晚过期记录
- 一条 `expires_at = null` 记录

断言顺序为：

- 最早过期在前
- 较晚过期在后
- `expires_at = null` 最后

- [ ] **Step 2: 写失败测试，覆盖最晚过期排序**

新增一个 `GET /api/shares?sort_by=expires_at&sort_order=desc` 场景，断言：

- 最晚过期在前
- 较早过期在后
- `expires_at = null` 仍最后

- [ ] **Step 3: 运行最小 worker 测试并确认红灯**

Run:

```bash
cd "worker" && npm run test:build && WORKER_TEST_OUTDIR="$PWD/.test-dist" node --test "tests/shares-route.test.cjs"
```

Expected:

- 新增排序相关断言失败
- 失败原因是 `/shares` 仍固定按 `updated_at DESC` 排序

### Task 2: 实现 worker 排序能力

**Files:**
- Modify: `worker/src/routes/shares.ts`
- Modify: `worker/src/services/shares.ts`
- Test: `worker/tests/shares-route.test.cjs`

- [ ] **Step 1: 扩展 route query 类型**

在 `ShareListQuery` 和 `parseFilters` 中新增：

- `sort_by`
- `sort_order`

要求：

- `trim`
- 保持空值兼容

- [ ] **Step 2: 扩展 service filters 类型**

让 `ShareListFilters` 能接收：

- `sort_by`
- `sort_order`

- [ ] **Step 3: 新增最小排序白名单与归一化**

在 `worker/src/services/shares.ts` 中实现：

- 允许字段：`updated_at`、`expires_at`
- 允许方向：`asc`、`desc`
- 无效值回退到 `updated_at/desc`

- [ ] **Step 4: 实现分享项比较函数**

实现最小比较逻辑：

- `updated_at`：常规时间比较
- `expires_at`：
  - `null` 始终排最后
  - `asc` 为越早越前
  - `desc` 为越晚越前
- 同值时回退 `updated_at DESC`

- [ ] **Step 5: 把排序接入现有过滤链**

在 `expires range` 过滤后，替换当前固定 `.sort((left, right) => ...)`。

- [ ] **Step 6: 运行 worker 测试确认绿灯**

Run:

```bash
cd "worker" && npm run test:build && WORKER_TEST_OUTDIR="$PWD/.test-dist" node --test "tests/shares-route.test.cjs"
```

Expected:

- `shares-route.test.cjs` 通过

- [ ] **Step 7: 运行 worker 类型与 lint**

Run:

```bash
npm --prefix "worker" run typecheck
npm --prefix "worker" run lint
```

Expected:

- 均通过

### Task 3: 先锁定前端排序参数构造

**Files:**
- Modify: `frontend/tests/shares-utils.test.js`
- Reference: `frontend/src/utils/shares.js`
- Reference: `frontend/src/views/Files.vue`

- [ ] **Step 1: 写失败测试，覆盖合法 sort_key**

新增断言：

- `updated_at__desc` -> `sort_by=updated_at` + `sort_order=desc`
- `expires_at__asc` -> `sort_by=expires_at` + `sort_order=asc`

- [ ] **Step 2: 写失败测试，覆盖非法 sort_key 回退**

新增断言：

- 非法 `sort_key` 自动回退到 `updated_at/desc`

- [ ] **Step 3: 运行前端最小测试并确认红灯**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js"
```

Expected:

- 新增排序参数相关断言失败

### Task 4: 实现前端排序下拉与参数构造

**Files:**
- Modify: `frontend/src/utils/shares.js`
- Modify: `frontend/src/views/Shares.vue`
- Modify: `frontend/src/locales/zh-CN/pages/shares.js`
- Modify: `frontend/src/locales/en-US/pages/shares.js`
- Test: `frontend/tests/shares-utils.test.js`

- [ ] **Step 1: 在 `shares.js` 中实现 sort_key 归一化与参数拆解**

要求：

- 默认 `updated_at__desc`
- 白名单仅：
  - `updated_at__desc`
  - `expires_at__asc`
  - `expires_at__desc`

- [ ] **Step 2: 在 `Shares.vue` 增加排序筛选状态与下拉**

新增：

- `filters.sort_key`
- `sortOptions`
- 排序 `Select`

- [ ] **Step 3: 保持搜索/刷新行为一致**

排序不自动触发请求，继续由“搜索”按钮应用。

- [ ] **Step 4: 补齐中英文文案**

新增：

- `shares.filters.sort`
- `shares.filters.sortUpdatedDesc`
- `shares.filters.sortExpiresAsc`
- `shares.filters.sortExpiresDesc`

- [ ] **Step 5: 运行前端最小测试确认绿灯**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js"
```

Expected:

- `shares-utils.test.js` 通过

- [ ] **Step 6: 运行前端 lint 与 build**

Run:

```bash
npm --prefix "frontend" run lint
npm --prefix "frontend" run build
```

Expected:

- 均通过

### Task 5: 全量验证

**Files:**
- Reference: `worker/tests/shares-route.test.cjs`
- Reference: `frontend/tests/shares-utils.test.js`

- [ ] **Step 1: 重新运行本轮全部验证命令**

Run:

```bash
cd "worker" && npm run test:build && WORKER_TEST_OUTDIR="$PWD/.test-dist" node --test "tests/shares-route.test.cjs"
npm --prefix "worker" run typecheck
npm --prefix "worker" run lint
node --test "frontend/tests/shares-utils.test.js"
npm --prefix "frontend" run lint
npm --prefix "frontend" run build
```

Expected:

- 所有命令通过

- [ ] **Step 2: 对照验收标准核对**

核对项：

- `/shares` 可选三种排序
- 默认仍为最近更新
- 过期排序时 `expires_at = null` 统一尾排
- 排序可与现有筛选组合
- 现有搜索、确认、批量关闭、过期范围筛选不回归
