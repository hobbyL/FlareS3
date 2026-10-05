# Security Hardening Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以保守升级方式修复高风险依赖，并为上传链路引入可平滑迁移的配额预留机制，解决并发超配额问题。

**Architecture:** 本阶段分两条线并行收口：依赖线优先升级运行时直接依赖，再顺手处理无痛开发依赖；配额线通过 `users.reserved_quota_bytes` 与文件级 `quota_reserved` 标记实现“预留-释放-完成”闭环，并补全过期/取消/删除/用户删除等释放路径。对旧数据采用平滑迁移，避免历史 `pending/uploading` 脱离计费。

**Tech Stack:** Cloudflare Workers、TypeScript、D1、Vue 3、Vite、Axios、DOMPurify、Markdown-It、AWS SDK

---

## 文件结构与职责

**新增文件**
- `worker/src/services/quotaReservation.ts`：封装配额预留、释放、迁移回填与当前有效占用计算。

**修改文件**
- `worker/package.json`：保守升级运行时与可无痛开发依赖。
- `frontend/package.json`：保守升级运行时与可无痛开发依赖。
- `worker/package-lock.json`、`frontend/package-lock.json`：锁文件更新。
- `worker/src/db/schema.sql`：补充 `users.reserved_quota_bytes`、`files.quota_reserved`（必要时加 `reservation_expires_at`）。
- `worker/src/services/dbSchema.ts`：补充对应 ensure/migration 逻辑。
- `worker/src/services/quota.ts`：收敛为已完成占用统计，避免混淆 reserved。
- `worker/src/routes/upload.ts`：接入配额预留/释放逻辑。
- `worker/src/routes/files.ts`：针对未完成上传删除时释放预留。
- `worker/src/routes/users.ts`：删除用户时处理仍持有预留的未完成文件。
- `worker/src/jobs/cleanupExpired.ts`：清理过期或 stale 上传时释放预留。
- `worker/src/jobs/cleanupDeleteQueue.ts`：删除队列最终删除文件前，确保预留已正确释放或不重复释放。
- 视依赖升级结果，可能少量修改前端 Markdown/构建相关文件以适配保守升级后的 API 差异。

**验证命令**
- `npm audit --audit-level=moderate`
- `npm --prefix worker run typecheck`
- `npm --prefix worker run lint`
- `npm --prefix frontend run lint`
- `npm --prefix frontend run build`

> 注：按用户明确要求，本计划不包含 git commit / branch / worktree / subagent review 步骤。

---

### Task 1: 基线审计与保守依赖升级

**Files:**
- Modify: `worker/package.json`
- Modify: `frontend/package.json`
- Modify: `worker/package-lock.json`
- Modify: `frontend/package-lock.json`

- [ ] **Step 1: 记录当前 audit 基线**

Run:
```bash
npm audit --audit-level=moderate --prefix worker
npm audit --audit-level=moderate --prefix frontend
```

Expected:
- 获取当前 worker/frontend 告警清单，区分运行时与开发依赖。

- [ ] **Step 2: 升级前端运行时直接依赖**

目标优先级：
- `axios`
- `dompurify`
- `markdown-it`

保守原则：
- 优先升级到最小安全版本
- 不主动跨大版本，除非验证发现无额外适配成本

- [ ] **Step 3: 升级 worker 运行时直接依赖**

目标优先级：
- `@aws-sdk/*`

可选顺带处理：
- `wrangler` 等开发依赖，仅在无需明显适配时进行

- [ ] **Step 4: 更新 lock 文件并修复最小兼容性问题**

如果保守升级引入小范围 API/构建差异：
- 仅修最小兼容层
- 不做计划外重构

- [ ] **Step 5: 运行依赖升级验证**

Run:
```bash
npm audit --audit-level=moderate --prefix worker
npm audit --audit-level=moderate --prefix frontend
npm --prefix worker run typecheck
npm --prefix worker run lint
npm --prefix frontend run lint
npm --prefix frontend run build
```

Expected:
- 运行时高风险告警下降
- lint / typecheck / build 通过

---

### Task 2: 为 users/files 增加预留配额字段与迁移能力

**Files:**
- Modify: `worker/src/db/schema.sql`
- Modify: `worker/src/services/dbSchema.ts`
- Create: `worker/src/services/quotaReservation.ts`
- Modify: `worker/src/services/quota.ts`

- [ ] **Step 1: 扩展 schema**

在 schema 中补充最小字段：
- `users.reserved_quota_bytes INTEGER NOT NULL DEFAULT 0`
- `files.quota_reserved INTEGER NOT NULL DEFAULT 0`

若实施时确认需要独立 stale 过期字段，则增加：
- `files.reservation_expires_at DATETIME`

- [ ] **Step 2: 补充 ensure/migration 逻辑**

在 `dbSchema.ts` 中添加对应列的 ensure：
- 用户保留字段 ensure
- 文件预留标记 ensure
- 若用到 stale 过期字段，也加 ensure

要求：
- 兼容已有表
- 幂等执行

- [ ] **Step 3: 定义 quotaReservation 服务接口**

在 `worker/src/services/quotaReservation.ts` 中定义最小接口：
- `reserveQuotaForUpload(...)`
- `releaseReservedQuotaForFile(...)`
- `markQuotaReservedOnFile(...)` / `clearQuotaReservedOnFile(...)`（若需要）
- `getEffectiveUsedSpace(...)`
- `backfillLegacyReservedQuota(...)`（如采用回填方案）

目标：
- 把预留/释放/回填逻辑集中，不散落到路由和任务里

- [ ] **Step 4: 明确原子边界**

实现中必须保证：
- 配额判断基于 DB 当前值
- 不依赖登录态缓存的 `user.quota_bytes`
- 至少在 D1 当前能力边界内，把并发冲突控制收口到 reserved 更新流程

- [ ] **Step 5: 收敛 quota.ts 语义**

`quota.ts` 只保留“已完成占用”或清晰命名的统计函数，避免继续把 `pending/uploading` 与 reserved 混在一起。

- [ ] **Step 6: 运行后端静态验证**

Run:
```bash
npm --prefix worker run typecheck
npm --prefix worker run lint
```

Expected:
- 新增服务与 migration 逻辑可通过静态检查

---

### Task 3: 接入上传链路的预留 / 释放 / 完成闭环

**Files:**
- Modify: `worker/src/routes/upload.ts`
- Modify: `worker/src/services/quotaReservation.ts`

- [ ] **Step 1: 小文件预签名时先预留**

在 `presignUpload` 中改为：
1. 校验体积
2. 走 quotaReservation 预留
3. 预留成功后创建 `pending` 文件记录，并将 `quota_reserved = 1`
4. 若建记录失败，立即回滚释放

- [ ] **Step 2: 分片初始化时先预留**

在 `initMultipart` 中复用同一预留逻辑：
- 预留成功后建记录
- 初始化 multipart
- 任一步失败都要补偿释放

- [ ] **Step 3: 确认成功时释放预留**

在 `confirmUpload` / `completeMultipart` 成功路径：
- 状态改成 `completed`
- 清理 `multipart_upload_id`（如适用）
- 释放该文件持有的 reserved
- 把 `quota_reserved` 置回 `0`

- [ ] **Step 4: 取消上传时释放预留**

在 `abortMultipart` 中：
- 无论直接删除还是排入删除队列
- 只要文件仍持有预留，就释放一次
- 必须保持幂等，重复调用不重复扣减

- [ ] **Step 5: 统一服务错误语义**

区分：
- 业务配额不足 -> `413`
- 存储/数据库异常 -> `500/503`

不要把服务异常伪装成配额问题。

- [ ] **Step 6: 运行后端静态验证**

Run:
```bash
npm --prefix worker run typecheck
npm --prefix worker run lint
```

Expected:
- 上传链路可通过静态检查

---

### Task 4: 补齐释放路径矩阵

**Files:**
- Modify: `worker/src/routes/files.ts`
- Modify: `worker/src/routes/users.ts`
- Modify: `worker/src/jobs/cleanupExpired.ts`
- Modify: `worker/src/jobs/cleanupDeleteQueue.ts`
- Modify: `worker/src/services/quotaReservation.ts`

- [ ] **Step 1: deleteFile 路径补偿**

若删除目标是仍未完成且持有预留的文件：
- 标记删除时释放预留
- 保持幂等

- [ ] **Step 2: deleteUser 路径补偿**

删除用户时：
- 除现有文件删除/入队逻辑外
- 需要处理该用户名下仍持有预留的未完成文件
- 避免用户被删后 reserved 长期残留

- [ ] **Step 3: cleanupExpired 释放预留**

对过期且仍持有预留的 `pending/uploading` 文件：
- 删除对象/中止上传后
- 同步释放预留

- [ ] **Step 4: cleanupDeleteQueue 最终兜底**

最终从 `files` 表删除前：
- 确认不会遗漏预留释放
- 若按设计应在更早路径释放，则此处只做幂等兜底，不重复扣减

- [ ] **Step 5: stale 上传回收**

根据设计确定：
- 使用 `reservation_expires_at` 或 `created_at/updated_at` timeout
- 在清理任务中识别长期未完成上传并释放 reserved

- [ ] **Step 6: 运行后端静态验证**

Run:
```bash
npm --prefix worker run typecheck
npm --prefix worker run lint
```

Expected:
- 释放路径补齐后仍通过静态检查

---

### Task 5: 平滑迁移与最终验证

**Files:**
- Modify: `worker/src/services/quotaReservation.ts`
- Modify: any touched files as needed

- [ ] **Step 1: 落地迁移方案**

在回填方案与过渡兼容方案中选一种并真正落地。

推荐：
- 回填存量 `pending/uploading` 为 reserved
- 同时标记 `quota_reserved = 1`

- [ ] **Step 2: 验证并发与幂等语义**

至少手工/脚本验证：
- 两个并发上传竞争同一剩余额度，只能成功一个预留
- 取消上传后额度恢复
- 长时间未完成上传被清理后额度恢复
- 重复释放路径不会导致 reserved 变负或重复扣减

- [ ] **Step 3: 跑全量静态验证**

Run:
```bash
npm audit --audit-level=moderate --prefix worker
npm audit --audit-level=moderate --prefix frontend
npm --prefix worker run typecheck
npm --prefix worker run lint
npm --prefix frontend run lint
npm --prefix frontend run build
```

Expected:
- 本阶段目标范围内的告警下降
- 构建与静态检查通过

- [ ] **Step 4: 汇总变更与剩余风险**

输出时需明确：
- 哪些依赖告警已处理
- 哪些因“保守升级”故意暂缓
- 配额预留模型的已覆盖路径
- 仍需后续观察的风险点

---

## 实施顺序建议

1. 先完成 Task 1，锁定依赖基线与可升级范围。
2. 再完成 Task 2，建立 schema 与 quotaReservation 基础设施。
3. 接着完成 Task 3，把上传主链路接起来。
4. 再完成 Task 4，补齐释放路径矩阵。
5. 最后用 Task 5 做迁移、验证和收尾。

## 非目标（再次确认）
- 不清空所有 dev-only audit 告警
- 不做整套上传状态机重构
- 不引入独立 quota ledger
- 不主动执行 git 提交/分支/worktree
