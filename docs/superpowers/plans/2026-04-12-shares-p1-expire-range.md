# Shares Expire Range Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `/shares` 增加过期时间范围筛选，帮助站长和普通用户快速定位某时间段内到期的分享。

**Architecture:** 复用现有 `DateRangePicker` 交互模式，在前端通过 `buildSharesQueryParams` 统一把日期范围转换成 `expires_from / expires_to`；后端扩展 `GET /api/shares` 参数解析，并在聚合后的分享列表上追加 `expires_at` 过滤。保持 KISS/YAGNI：只做过期时间，不引入更多时间维度，不改排序系统，不新增高级筛选面板。

**Tech Stack:** Vue 3 + Vite、Vue I18n、Cloudflare Workers、D1、Node test

---

## 范围约束

- 只做过期时间范围筛选
- 不做创建时间 / 更新时间范围
- 不做快捷预设
- 不做 git commit / branch / push / reset（遵循当前用户要求）

## 文件结构与职责

### 后端

- Modify: `worker/src/routes/shares.ts`
  - 解析 `expires_from` / `expires_to`
- Modify: `worker/src/services/shares.ts`
  - 新增时间范围匹配逻辑
- Modify: `worker/tests/shares-route.test.cjs`
  - 覆盖时间范围过滤回归

### 前端

- Modify: `frontend/src/views/Shares.vue`
  - 接入 `DateRangePicker`
  - 扩展筛选状态与 active filter 判断
- Modify: `frontend/src/utils/shares.js`
  - 在 `buildSharesQueryParams` 中统一处理日期范围转换
- Modify: `frontend/tests/shares-utils.test.js`
  - 锁定日期范围参数构造行为
- Modify: `frontend/src/locales/zh-CN/pages/shares.js`
  - 新增中文筛选文案
- Modify: `frontend/src/locales/en-US/pages/shares.js`
  - 新增英文筛选文案

## 验证命令

- `cd "worker" && npm run test:build && WORKER_TEST_OUTDIR="$PWD/.test-dist" node --test "tests/shares-route.test.cjs"`
- `npm --prefix "worker" run typecheck`
- `npm --prefix "worker" run lint`
- `node --test "frontend/tests/shares-utils.test.js"`
- `npm --prefix "frontend" run lint`
- `npm --prefix "frontend" run build`

---

### Task 1: 先锁定后端时间范围过滤合同

**Files:**
- Modify: `worker/tests/shares-route.test.cjs`
- Reference: `worker/src/routes/shares.ts`
- Reference: `worker/src/services/shares.ts`

- [ ] **Step 1: 增加失败测试，覆盖完整时间区间过滤**

补一个 `GET /api/shares?expires_from=...&expires_to=...` 场景，构造至少 3 条记录：

- 一条 `expires_at` 在区间内，应命中
- 一条 `expires_at` 在区间外，不命中
- 一条 `expires_at = null`，启用时间筛选时不命中

断言返回 `total`、`items.length`、命中记录 `resource_id`。

- [ ] **Step 2: 增加失败测试，覆盖单边界过滤**

补一个只传 `expires_from` 的场景，断言：

- `expires_at >= expires_from` 的记录命中
- 更早到期的记录不命中

- [ ] **Step 3: 运行最小 worker 测试并确认红灯**

Run:

```bash
cd "worker" && npm run test:build && WORKER_TEST_OUTDIR="$PWD/.test-dist" node --test "tests/shares-route.test.cjs"
```

Expected:

- 新增时间范围相关断言失败
- 失败原因是 route/service 还未支持 `expires_from` / `expires_to`

### Task 2: 实现 worker 的过期时间范围筛选

**Files:**
- Modify: `worker/src/routes/shares.ts`
- Modify: `worker/src/services/shares.ts`
- Test: `worker/tests/shares-route.test.cjs`

- [ ] **Step 1: 扩展 route query 类型与解析**

在 `ShareListQuery` 与 `parseFilters` 中新增：

- `expires_from`
- `expires_to`

要求：

- 统一 `trim`
- 保持空字符串兼容

- [ ] **Step 2: 在 service filters 类型中补齐字段**

扩展 `ShareListFilters`，让 service 能拿到：

- `expires_from`
- `expires_to`

- [ ] **Step 3: 新增纯辅助函数处理时间匹配**

在 `worker/src/services/shares.ts` 中新增最小 helper，例如：

- 解析 ISO -> timestamp
- 判断单条分享是否命中过期时间范围

语义固定为：

- `expires_at` 为空且启用时间筛选 -> `false`
- 同时有起止 -> `>= from && < to`
- 仅有起始 -> `>= from`
- 仅有结束 -> `< to`

- [ ] **Step 4: 把时间范围过滤接入现有过滤链**

保持现有过滤顺序，仅在 `status` 过滤后追加 `expires range`。

- [ ] **Step 5: 运行 worker 测试确认绿灯**

Run:

```bash
cd "worker" && npm run test:build && WORKER_TEST_OUTDIR="$PWD/.test-dist" node --test "tests/shares-route.test.cjs"
```

Expected:

- `shares-route.test.cjs` 通过

- [ ] **Step 6: 运行 worker 类型与 lint 校验**

Run:

```bash
npm --prefix "worker" run typecheck
npm --prefix "worker" run lint
```

Expected:

- 均通过

### Task 3: 先锁定前端日期参数转换行为

**Files:**
- Modify: `frontend/tests/shares-utils.test.js`
- Reference: `frontend/src/utils/shares.js`
- Reference: `frontend/src/views/Users.vue`

- [ ] **Step 1: 为 `buildSharesQueryParams` 增加失败测试**

新增至少 3 组断言：

- 完整区间：生成 `expires_from / expires_to`
- 单日选择：自动补齐同一天完整自然日
- 反向日期：自动交换开始/结束

- [ ] **Step 2: 运行前端最小测试并确认红灯**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js"
```

Expected:

- 新增日期范围相关断言失败

### Task 4: 实现前端筛选 UI 与参数构造

**Files:**
- Modify: `frontend/src/utils/shares.js`
- Modify: `frontend/src/views/Shares.vue`
- Modify: `frontend/src/locales/zh-CN/pages/shares.js`
- Modify: `frontend/src/locales/en-US/pages/shares.js`
- Test: `frontend/tests/shares-utils.test.js`

- [ ] **Step 1: 在 `shares.js` 中实现日期范围参数拼装**

把日期转换逻辑集中在 `buildSharesQueryParams`，避免在 `Shares.vue` 里重复拼日期。

- [ ] **Step 2: 在 `Shares.vue` 接入 `DateRangePicker`**

新增：

- `DateRangePicker` import
- `filters.expires_from_date`
- `filters.expires_to_date`

并把控件接入筛选区。

- [ ] **Step 3: 更新 active filter 判断**

让 `hasActiveFilters` 在存在过期时间范围时返回 `true`。

- [ ] **Step 4: 补齐中英文文案**

新增：

- `shares.filters.expiresAt`

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

### Task 5: 全量回归核对

**Files:**
- Reference: `worker/tests/shares-route.test.cjs`
- Reference: `frontend/tests/shares-utils.test.js`

- [ ] **Step 1: 重新运行本次功能涉及的全部验证命令**

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

- [ ] **Step 2: 对照验收标准逐项核对**

核对项：

- `/shares` 可按过期时间范围筛选
- 单日与反向日期都能得到稳定结果
- owner / q / type / status 可组合使用
- 启用时间范围筛选时 `expires_at` 为空的记录不误命中
- 现有搜索、确认、批量关闭能力不回归
