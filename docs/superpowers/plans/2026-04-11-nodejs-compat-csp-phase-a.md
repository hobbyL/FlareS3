# Node.js Compat And CSP Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成一轮最小安全加固，移除前端首屏内联主题脚本、迁移 Worker Node.js 兼容配置，并补上结构化运维日志与回归保护。

**Architecture:** 保持现有前后端行为不变，只做最小可验证变更。前端把主题引导逻辑迁到静态外链脚本以配合严格 `script-src 'self'`；Worker 在入口层补统一 JSON 日志，并把 wrangler 配置迁到 Cloudflare 推荐的 `compatibility_flags = ["nodejs_compat"]`。

**Tech Stack:** Vue 3 + Vite, Cloudflare Workers, Wrangler, Node test

---

### Task 1: 给主题引导外链化写失败测试

**Files:**
- Modify: `package.json`
- Create: `frontend/tests/theme-bootstrap.test.js`
- Modify: `frontend/index.html`

- [ ] **Step 1: Write the failing test**

覆盖：
- `frontend/index.html` 不再包含主题初始化内联脚本
- HTML 改为加载外链 `theme-bootstrap.js`

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test frontend/tests/theme-bootstrap.test.js`
Expected: FAIL，因为当前 HTML 仍有内联主题脚本

### Task 2: 给 Worker 结构化日志写失败测试

**Files:**
- Create: `worker/tests/operability-logs.test.cjs`
- Modify: `worker/src/index.ts`

- [ ] **Step 1: Write the failing test**

覆盖：
- 路由抛出异常时输出结构化错误日志
- `scheduled` 清理完成后输出结构化摘要日志

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix worker run test:build && WORKER_TEST_OUTDIR=$PWD/worker/.test-dist node --test "worker/tests/operability-logs.test.cjs"`
Expected: FAIL，因为当前仅有非结构化 `console.error`

### Task 3: 给 wrangler 兼容配置写回归测试

**Files:**
- Create: `worker/tests/wrangler-config.test.cjs`
- Modify: `worker/wrangler.toml`
- Modify: `worker/wrangler.full.toml`

- [ ] **Step 1: Write the failing test**

覆盖：
- 不再使用 `node_compat = true`
- 使用 `compatibility_flags = ["nodejs_compat"]`
- `compatibility_date` 至少提升到 `2024-09-23`

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test worker/tests/wrangler-config.test.cjs`
Expected: FAIL，因为当前配置仍是 `node_compat = true`

### Task 4: 以最小实现让测试转绿

**Files:**
- Create: `frontend/public/theme-bootstrap.js`
- Modify: `frontend/index.html`
- Modify: `worker/src/index.ts`
- Modify: `worker/wrangler.toml`
- Modify: `worker/wrangler.full.toml`

- [ ] **Step 1: Add minimal implementation**

要求：
- 保持主题 key、默认 UI 主题和主题推导逻辑不变
- Worker 日志统一为最小 JSON 结构
- wrangler 配置按官方推荐迁移

- [ ] **Step 2: Run focused tests**

Run:
- `node --test frontend/tests/theme-bootstrap.test.js`
- `npm --prefix worker run test:build && WORKER_TEST_OUTDIR=$PWD/worker/.test-dist node --test "worker/tests/operability-logs.test.cjs"`
- `node --test worker/tests/wrangler-config.test.cjs`

Expected: PASS

### Task 5: 全量验证

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Run repo verification**

Run:
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test`
- `npm --prefix worker exec wrangler deploy --dry-run`
- `npm --prefix worker exec wrangler deploy --config wrangler.full.toml --dry-run`

Expected:
- 所有命令退出码为 `0`
- 无新增安全/部署阻塞项
