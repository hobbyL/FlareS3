# Shares Expiring Governance Preset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `/shares` 增加“即将过期治理”快捷预设，帮助用户优先处理最早到期的有效分享。

**Architecture:** 仅做前端增强，在 `frontend/src/utils/shares.js` 中新增纯函数生成“即将过期治理”预设后的 filters，在 `frontend/src/views/Shares.vue` 增加快捷按钮并复用现有 `loadShares` 链路。继续保持 KISS/YAGNI：不改 worker，不新增新的筛选协议，不引入固定未来天数窗口。

**Tech Stack:** Vue 3 + Vite、Vue I18n、Node test

---

## 范围约束

- 只做一个快捷按钮：`即将过期治理`
- 不改 worker / route / service
- 不做固定未来 N 天窗口
- 不做排序记忆
- 不做自动勾选、自动批量关闭
- 不做 git commit / branch / push / reset

## 文件结构与职责

- Modify: `frontend/src/utils/shares.js`
  - 新增即将过期治理预设纯函数
- Modify: `frontend/tests/shares-utils.test.js`
  - 锁定即将过期治理预设行为
- Modify: `frontend/src/views/Shares.vue`
  - 新增快捷治理按钮与触发逻辑
- Modify: `frontend/src/locales/zh-CN/pages/shares.js`
  - 新增中文按钮文案
- Modify: `frontend/src/locales/en-US/pages/shares.js`
  - 新增英文按钮文案

## 验证命令

- `node --test "frontend/tests/shares-utils.test.js"`
- `npm --prefix "frontend" run lint`
- `npm --prefix "frontend" run build`

---

### Task 1: 先锁定即将过期治理预设的纯函数行为

**Files:**
- Modify: `frontend/tests/shares-utils.test.js`
- Reference: `frontend/src/utils/shares.js`

- [ ] **Step 1: 写失败测试，覆盖即将过期治理预设**

新增断言：

- 保留 `q`
- 保留 `type`
- 保留 `owner_id`
- 把 `status` 强制改成 `active`
- 把 `sort_key` 强制改成 `expires_at__asc`
- 清空 `expires_from_date`
- 清空 `expires_to_date`

- [ ] **Step 2: 运行最小前端测试并确认红灯**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js"
```

Expected:

- 新增断言失败
- 失败原因是工具函数尚不存在

### Task 2: 实现即将过期治理预设纯函数

**Files:**
- Modify: `frontend/src/utils/shares.js`
- Test: `frontend/tests/shares-utils.test.js`

- [ ] **Step 1: 新增最小纯函数**

建议新增：

- `buildExpiringGovernanceFilters(filters = {})`

函数行为：

- 保留 `q/type/owner_id`
- 覆盖 `status/sort_key`
- 清空过期范围
- 不引入 Vue 依赖

- [ ] **Step 2: 运行最小前端测试确认绿灯**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js"
```

Expected:

- `shares-utils.test.js` 通过

### Task 3: 接入 `/shares` 页面快捷治理按钮

**Files:**
- Modify: `frontend/src/views/Shares.vue`
- Modify: `frontend/src/locales/zh-CN/pages/shares.js`
- Modify: `frontend/src/locales/en-US/pages/shares.js`
- Reference: `frontend/src/utils/shares.js`

- [ ] **Step 1: 在 `Shares.vue` 中接入工具函数**

导入：

- `buildExpiringGovernanceFilters`

- [ ] **Step 2: 新增快捷治理按钮**

在“已过期治理”旁边增加：

- `shares.actions.focusExpiring`

点击行为：

- 若当前正在加载或批量关闭，直接返回
- 应用治理预设
- `page = 1`
- 走现有 `loadShares`

- [ ] **Step 3: 新增按钮 active 状态**

当 filters 满足以下条件时高亮：

- `status = active`
- `sort_key = expires_at__asc`
- `expires_from_date / expires_to_date` 为空

- [ ] **Step 4: 补齐中英文文案**

新增：

- `shares.actions.focusExpiring`

### Task 4: 增量验证

**Files:**
- Verify only

- [ ] **Step 1: 运行前端最小测试**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js"
```

Expected:

- 通过

- [ ] **Step 2: 运行前端 lint 与 build**

Run:

```bash
npm --prefix "frontend" run lint
npm --prefix "frontend" run build
```

Expected:

- 均通过

- [ ] **Step 3: 对照验收标准核对**

核对项：

- 顶部存在“即将过期治理”按钮
- 点击后立即刷新列表
- `status=active`
- `sort_key=expires_at__asc`
- 过期范围被清空
- `q/type/owner_id` 保留
