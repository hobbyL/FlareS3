# Shares P1 Filter Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `/shares` 增加筛选条件记忆，让页面刷新或重新进入后能恢复最近一次使用的业务筛选状态。

**Architecture:** 仅在前端实现：在 `shares.js` 中集中默认筛选值与持久化恢复纯函数，在 `Shares.vue` 中按项目既有 `localStorage + onMounted + watch` 模式完成读取、恢复与写回。整个实现保持 KISS/YAGNI，不引入后端偏好存储，不记忆 UI 临时状态。

**Tech Stack:** Vue 3 + Vite、Node test、ES modules、localStorage

---

## 范围确认

**本轮包含：**

- `/shares` 筛选条件持久化与恢复
- `shares.js` 中新增最小纯函数与默认筛选结构
- `frontend/tests/shares-utils.test.js` 回归测试
- 前端 lint / build 验证

**本轮明确不做：**

- 后端改动
- 分页记忆
- `ownerSearchQuery` 记忆
- 选中态 / 弹窗态记忆
- git commit / branch / reset / push

## 文件结构与职责

- Modify: `frontend/src/utils/shares.js`
  - 统一默认筛选值
  - 提供持久化输出与恢复纯函数
- Modify: `frontend/tests/shares-utils.test.js`
  - 补充持久化纯函数的红绿测试
- Modify: `frontend/src/views/Shares.vue`
  - 接入 `localStorage` 恢复与自动写回

## 验证命令

- `node --test "frontend/tests/shares-utils.test.js"`
- `npm --prefix "frontend" run lint`
- `npm --prefix "frontend" run build`
- `cd "worker" && npm run test:build && WORKER_TEST_OUTDIR="$PWD/.test-dist" node --test "tests/shares-route.test.cjs"`
- `npm --prefix "worker" run typecheck`
- `npm --prefix "worker" run lint`

---

### Task 1: 锁定持久化纯函数合同

**Files:**
- Modify: `frontend/tests/shares-utils.test.js`
- Reference: `frontend/src/utils/shares.js`

- [ ] **Step 1: 先写失败测试，约束持久化白名单字段**

新增测试，确认持久化结果仅包含：

- `q`
- `type`
- `status`
- `sort_key`
- `expires_from_date`
- `expires_to_date`
- `owner_id`

并确认不会保留：

- `ownerSearchQuery`
- `selectedIds`
- `showConfirmModal`

- [ ] **Step 2: 先写失败测试，约束恢复与兜底规则**

新增测试覆盖：

- 空值 / 非对象回退默认筛选
- 缺失字段自动补默认值
- 非法 `sort_key` 回退 `updated_at__desc`

- [ ] **Step 3: 运行测试并确认先失败**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js"
```

Expected:

- 新增持久化相关断言失败
- 失败原因是纯函数尚未实现

### Task 2: 实现持久化纯函数

**Files:**
- Modify: `frontend/src/utils/shares.js`
- Test: `frontend/tests/shares-utils.test.js`

- [ ] **Step 1: 抽出默认筛选结构**

新增一个统一默认值来源，供：

- 页面初始化
- 持久化恢复
- 未来 reset 场景

共同复用。

- [ ] **Step 2: 实现最小恢复与持久化 helper**

建议最少包含：

- `createDefaultShareFilters()`
- `toPersistedShareFilters()`
- `restorePersistedShareFilters()`

要求：

- 仅处理纯数据
- 不依赖 `window`
- `sort_key` 非法回退默认值

- [ ] **Step 3: 再跑单测确认转绿**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js"
```

Expected:

- 新增测试通过
- 原有 shares utils 测试不回归

### Task 3: 在 `Shares.vue` 接入读取与写回

**Files:**
- Modify: `frontend/src/views/Shares.vue`
- Reference: `frontend/src/views/Files.vue`

- [ ] **Step 1: 页面初始化改为使用统一默认筛选结构**

避免组件内再维护一份手写默认值。

- [ ] **Step 2: 在 onMounted 初始加载前恢复筛选**

读取 `localStorage`：

- 若存在且可解析，恢复
- 否则回退默认筛选

再继续执行已有：

- `loadOwnerOptions()`
- `loadShares()`

- [ ] **Step 3: 监听 filters 深度变化并写回**

要求：

- 仅在浏览器环境下执行
- 仅写入白名单业务筛选字段
- 不改变现有“筛选变化不自动请求”的交互约束

### Task 4: 做增量与回归验证

**Files:**
- Reference only

- [ ] **Step 1: 跑前端单测**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js"
```

- [ ] **Step 2: 跑前端 lint**

Run:

```bash
npm --prefix "frontend" run lint
```

- [ ] **Step 3: 跑前端 build**

Run:

```bash
npm --prefix "frontend" run build
```

- [ ] **Step 4: 补跑 shares 相关 worker 回归**

Run:

```bash
cd "worker" && npm run test:build && WORKER_TEST_OUTDIR="$PWD/.test-dist" node --test "tests/shares-route.test.cjs"
npm --prefix "worker" run typecheck
npm --prefix "worker" run lint
```

Expected:

- 前端与 shares 相关后端验证均通过
- 本轮纯前端改动不引入 worker 回归
