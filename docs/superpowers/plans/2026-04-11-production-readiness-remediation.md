# Production Readiness Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate current deployment blockers and raise the project to a defensible production-readiness baseline for Cloudflare Pages/Workers.

**Architecture:** Keep the existing Cloudflare Pages + Worker / Worker-only split, but harden the release chain in three layers: dependency hygiene, deployment invariants, and runtime operability. The plan avoids broad refactors and targets only the code, workflow, and operational gaps already evidenced by the audit.

**Tech Stack:** Vue 3 + Vite frontend, Cloudflare Workers, D1, R2, GitHub Actions, npm audit, Wrangler

---

## File Map

**Existing files to modify**
- `frontend/package.json`
- `frontend/package-lock.json`
- `worker/package.json`
- `worker/package-lock.json`
- `worker/src/index.ts`
- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yml`
- `.github/workflows/deploy-worker-only.yml`
- `README.md`
- `worker/src/jobs/cleanupExpired.ts`
- `worker/src/jobs/cleanupDeleteQueue.ts`
- `worker/src/index.ts`
- `worker/src/db/schema.sql`

**Likely new files**
- `worker/tests/security-headers.test.cjs`
- `worker/tests/retention-jobs.test.cjs`
- `worker/src/jobs/cleanupRetention.ts`

### Task 1: Clear Frontend Dependency Blockers

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Verify callers: `frontend/src/components/texts/TextViewModal.vue`
- Verify callers: `frontend/src/components/files/FileInfoModal.vue`
- Verify callers: `frontend/src/components/mount/MountedObjectPreviewModal.vue`

- [ ] **Step 1: Record the current production audit baseline**

Run: `npm --prefix frontend audit --omit=dev --audit-level=high`
Expected: current `critical/high` findings are reproduced before edits.

- [ ] **Step 2: Upgrade vulnerable direct dependencies to non-vulnerable versions**

Targets:
- `axios`
- `dompurify`
- `markdown-it`

Constraint:
- Do not introduce new libraries.
- Keep the existing Markdown rendering flow and sanitizer API shape.

- [ ] **Step 3: Refresh the lockfile**

Run: `npm install --prefix frontend`
Expected: `frontend/package-lock.json` updates to the new resolved graph.

- [ ] **Step 4: Re-run frontend safety and build verification**

Run:
- `npm --prefix frontend audit --omit=dev --audit-level=high`
- `npm --prefix frontend run lint`
- `npm --prefix frontend run build`
- `node --test frontend/tests/auth-redirect.test.js`

Expected:
- audit exits `0`
- lint/build/tests pass

- [ ] **Step 5: Smoke-check the three Markdown preview call sites**

Verify:
- `v-html` still receives sanitized HTML only
- no new runtime API mismatch from dependency upgrades

### Task 2: Clear Worker Dependency Blockers

**Files:**
- Modify: `worker/package.json`
- Modify: `worker/package-lock.json`

- [ ] **Step 1: Record the current worker production audit baseline**

Run: `npm --prefix worker audit --omit=dev --audit-level=high`
Expected: reproduce the `fast-xml-parser` / AWS SDK chain finding.

- [ ] **Step 2: Upgrade the AWS SDK dependency chain and remove stale overrides if no longer needed**

Targets:
- `@aws-sdk/client-s3`
- `@aws-sdk/s3-request-presigner`
- `fast-xml-parser` override handling

Constraint:
- Prefer upstream-safe resolution over pinning another vulnerable override.

- [ ] **Step 3: Refresh the worker lockfile**

Run: `npm install --prefix worker`
Expected: `worker/package-lock.json` resolves to a non-vulnerable tree.

- [ ] **Step 4: Re-run worker verification**

Run:
- `npm --prefix worker audit --omit=dev --audit-level=high`
- `npm --prefix worker run test`
- `npm --prefix worker run lint`
- `npm --prefix worker run typecheck`

Expected:
- audit exits `0`
- tests/lint/typecheck pass

### Task 3: Fix the `R2_MASTER_KEY` Deployment Invariant

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `.github/workflows/deploy-worker-only.yml`
- Modify: `README.md`

- [ ] **Step 1: Change deployment behavior from “missing key => generate” to “missing key => fail”**

Required behavior:
- If `R2_MASTER_KEY` is absent, the workflow must stop with a clear error.
- The workflow must not generate or rotate the key implicitly.

- [ ] **Step 2: Update deployment messaging**

Document:
- `R2_MASTER_KEY` must be provisioned before first deploy
- the value must remain stable across redeploys
- recovery path if the key is missing in a new environment

- [ ] **Step 3: Verify workflow syntax**

Run:
- inspect the changed YAML carefully
- if available locally, dry-run the deploy path with existing `wrangler deploy --dry-run`

Expected:
- no auto-generation branch remains
- docs and workflow behavior match

### Task 4: Close CI Gate Gaps

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Optional modify: `frontend/package.json`

- [ ] **Step 1: Add frontend production audit to CI**

Required command:
- `npm --prefix frontend audit --omit=dev --audit-level=high`

- [ ] **Step 2: Align root scripts with actual repo quality gates**

Required changes:
- keep existing worker typecheck
- add a frontend check if there is a real typecheck path
- if no frontend typecheck exists, do not fake one; document that limitation and gate with audit/lint/build/test instead

- [ ] **Step 3: Add deployment-shape verification**

Preferred checks:
- existing frontend build
- existing worker typecheck/test
- optional worker dry-run if it can run reliably in CI without secret leakage

- [ ] **Step 4: Re-verify root commands**

Run:
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `npm run test`

Expected:
- root-level quality signals reflect the real monorepo state

### Task 5: Harden Security Headers

**Files:**
- Modify: `worker/src/index.ts`
- Test: `worker/tests/security-headers.test.cjs`

- [ ] **Step 1: Add or extend tests for security headers**

Cover:
- `Content-Security-Policy`
- `Strict-Transport-Security`
- existing `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`

- [ ] **Step 2: Tighten CSP without breaking the frontend**

Target outcome:
- remove `unsafe-inline` where technically possible
- if full removal is not yet feasible, minimize the exception and document the exact blocker

- [ ] **Step 3: Add HSTS for HTTPS traffic**

Constraint:
- set only when the request is effectively HTTPS
- do not emit misleading HSTS headers on insecure local development traffic

- [ ] **Step 4: Run focused verification**

Run:
- `npm --prefix worker run test`

Expected:
- new header assertions pass
- no regression in frontend asset delivery

### Task 6: Add Basic Production Operability

**Files:**
- Modify: `worker/src/index.ts`
- Modify: `worker/src/db/schema.sql`
- Create: `worker/src/jobs/cleanupRetention.ts`
- Modify: `worker/src/jobs/cleanupExpired.ts` if shared helpers are needed
- Modify: `worker/src/jobs/cleanupDeleteQueue.ts` if shared helpers are needed
- Test: `worker/tests/retention-jobs.test.cjs`

- [ ] **Step 1: Add a minimal health endpoint**

Target:
- lightweight route such as `/health` or `/api/health`
- return simple JSON including service status and timestamp
- avoid exposing secrets or internal topology

- [ ] **Step 2: Add retention cleanup for operational tables**

Scope:
- expired or revoked `sessions`
- stale `rate_limits`
- aged `audit_logs` according to a conservative retention window

- [ ] **Step 3: Wire the retention job into the scheduled handler**

Constraint:
- keep scheduled work bounded
- avoid large-table destructive scans; prefer indexed predicates and batching

- [ ] **Step 4: Add tests for health and retention behavior**

Cover:
- health endpoint returns `200`
- cleanup removes only stale rows
- active sessions and recent audit data are preserved

- [ ] **Step 5: Run worker verification**

Run:
- `npm --prefix worker run test`
- `npm --prefix worker run typecheck`

Expected:
- operability additions are covered by tests and do not break routing

## Release Exit Criteria

- [ ] `frontend` production audit has no `high` or `critical`
- [ ] `worker` production audit has no `high` or `critical`
- [ ] deploy workflows fail fast when `R2_MASTER_KEY` is absent
- [ ] CI blocks both frontend and worker dependency regressions
- [ ] security headers meet the agreed baseline
- [ ] health endpoint and retention cleanup exist
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run test`
- [ ] `npx wrangler deploy --dry-run`
- [ ] `npx wrangler deploy --config wrangler.full.toml --dry-run`

## Notes

- This plan intentionally avoids feature work and broad refactors.
- Do not rotate `R2_MASTER_KEY` as part of remediation.
- Do not commit or deploy automatically unless explicitly requested by the user.
