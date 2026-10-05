# 用户资源生命周期修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复用户禁用/删除后资源与公开访问状态不一致的问题，并补齐回归测试。

**Architecture:** 以 `users.ts` 为资源生命周期入口，删除语义只保留一个入口；公开访问链路在查询阶段补充 owner 状态校验。保持现有 Worker 路由和 D1/R2 职责边界，不引入新的服务层。

**Tech Stack:** Cloudflare Workers, TypeScript, D1, Node test

---

### Task 1: 修复 worker 测试执行链路

**Files:**
- Modify: `worker/package.json`
- Modify: `package.json`
- Modify: `worker/tests/upload-size-guard.test.cjs`

- [ ] **Step 1: 写出能暴露现有测试链路缺陷的执行命令**

Run: `rm -rf /tmp/flares3-worker-tests && npm --prefix worker exec -- tsc -p worker/tsconfig.test.json --outDir /tmp/flares3-worker-tests && WORKER_TEST_OUTDIR=/tmp/flares3-worker-tests node --test worker/tests/upload-size-guard.test.cjs`
Expected: FAIL，报 `Cannot find module '@aws-sdk/client-s3'`

- [ ] **Step 2: 用最小改动修复测试运行装配**

为 worker 增加稳定的测试脚本，让编译产物能正确解析 `worker/node_modules`。

- [ ] **Step 3: 重新运行 worker 测试**

Run: `npm --prefix worker run test`
Expected: PASS

### Task 2: 为用户删除/禁用生命周期写失败测试

**Files:**
- Create: `worker/tests/user-resource-lifecycle.test.cjs`

- [ ] **Step 1: 写失败测试**

覆盖：
- `updateUser` 拒绝 `status=deleted`
- `deleteUser` 会下线 texts / text_shares / text_one_time_shares / file_shares
- 公开访问查询在 owner 非 `active` 时失效

- [ ] **Step 2: 运行新测试确认失败**

Run: `npm --prefix worker run test -- worker/tests/user-resource-lifecycle.test.cjs`
Expected: FAIL，原因是现有实现允许 `status=deleted` 或公开分享仍可访问

### Task 3: 实现删除语义统一

**Files:**
- Modify: `worker/src/routes/users.ts`

- [ ] **Step 1: 最小实现**

在 `updateUser` 中拒绝 `status=deleted`，并把用户关联资源下线逻辑收敛为私有 helper 供 `deleteUser` 调用。

- [ ] **Step 2: 运行定向测试**

Run: `npm --prefix worker run test -- worker/tests/user-resource-lifecycle.test.cjs`
Expected: 相关断言转绿，其余仍可能失败

### Task 4: 实现公开访问 owner 状态校验

**Files:**
- Modify: `worker/src/routes/textShares.ts`
- Modify: `worker/src/routes/textOneTimeShares.ts`
- Modify: `worker/src/routes/fileShares.ts`
- Modify: `worker/src/routes/shortlink.ts`

- [ ] **Step 1: 最小实现**

在公开查询 SQL 中联表 users 或补查 owner 状态，owner 非 `active` 时返回不可用。

- [ ] **Step 2: 运行定向测试**

Run: `npm --prefix worker run test -- worker/tests/user-resource-lifecycle.test.cjs`
Expected: PASS

### Task 5: 回归验证

**Files:**
- Modify: `worker/package.json`
- Modify: `package.json`

- [ ] **Step 1: 跑 worker 全量测试**

Run: `npm --prefix worker run test`
Expected: PASS

- [ ] **Step 2: 跑仓库基础校验**

Run: `npm run lint`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: 如有格式问题，修复并复验**

Run: `npm run format:check`
Expected: PASS
