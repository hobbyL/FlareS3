# R2 配置配额硬约束 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `r2_configs.quota_bytes` 成为真实的上传限制，并让管理页占用统计与上传口径一致。

**Architecture:** 新增一个聚焦配置配额的 service，统一负责“按配置统计占用”和“校验本次上传是否可接受”。上传入口只调用该 service，不在路由里散落 SQL；配置列表展示复用相同统计口径，保持 DRY。

**Tech Stack:** Cloudflare Workers, TypeScript, D1, Node test

---

### Task 1: 写出配置配额失败测试

**Files:**
- Create: `worker/tests/r2-config-quota.test.cjs`

- [ ] **Step 1: Write the failing test**

覆盖：
- `presignUpload` 在配置剩余空间不足时返回 `413`
- `initMultipart` 在配置剩余空间不足时返回 `413`
- 统计口径包含 `pending/uploading/completed`
- `deleted` 和已过期文件不计入
- `listConfigs` 返回的 `usedSpace` 使用同一统计口径

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix worker run test:build && WORKER_TEST_OUTDIR=$PWD/worker/.test-dist node --test "worker/tests/r2-config-quota.test.cjs"`
Expected: FAIL，因当前实现未校验配置配额且 `listConfigs` 仅统计 `completed`

### Task 2: 提取配置配额 service

**Files:**
- Create: `worker/src/services/r2ConfigQuota.ts`

- [ ] **Step 1: Write minimal implementation**

提供：
- `getR2ConfigUsedSpace`
- `assertR2ConfigHasCapacity`

统计口径：
- `upload_status IN ('pending','uploading','completed')`
- `deleted_at IS NULL`
- `expires_at > now`

- [ ] **Step 2: Run targeted test**

Run: `npm --prefix worker run test:build && WORKER_TEST_OUTDIR=$PWD/worker/.test-dist node --test "worker/tests/r2-config-quota.test.cjs"`
Expected: 仍 FAIL，但进入上传入口时已具备可调用能力

### Task 3: 上传入口接入配置配额校验

**Files:**
- Modify: `worker/src/routes/upload.ts`
- Modify: `worker/src/services/uploadConfigPolicy.ts`（仅在需要时补类型/辅助）

- [ ] **Step 1: Wire failing routes**

在 `presignUpload`、`initMultipart` 中，在解析出最终 `loaded.id` 后执行配置配额校验；配置不足返回 `413` 和明确文案。

- [ ] **Step 2: Run targeted test**

Run: `npm --prefix worker run test:build && WORKER_TEST_OUTDIR=$PWD/worker/.test-dist node --test "worker/tests/r2-config-quota.test.cjs"`
Expected: 上传相关测试 PASS，展示口径测试可能仍 FAIL

### Task 4: 管理页占用统计口径对齐

**Files:**
- Modify: `worker/src/routes/r2Configs.ts`

- [ ] **Step 1: Update aggregation SQL**

把 `usedSpace` 统计口径从仅 `completed` 改为 `pending/uploading/completed`，并排除已删除和已过期文件。

- [ ] **Step 2: Run targeted test**

Run: `npm --prefix worker run test:build && WORKER_TEST_OUTDIR=$PWD/worker/.test-dist node --test "worker/tests/r2-config-quota.test.cjs"`
Expected: PASS

### Task 5: Full verification

**Files:**
- Modify: `worker/package.json`
- Modify: `package.json`

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 2: Run lint and typecheck**

Run: `npm run lint`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run format check**

Run: `npm run format:check`
Expected: worker side clean; if root still blocked by unrelated frontend files, record explicitly
