# FlareS3 P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐管理员仪表盘、任务可观测性、用户管理闭环和多文件上传队列能力，让项目具备基本可运营后台能力。

**Architecture:** 后端以“定时任务结果落库 + 管理员聚合接口 + 上传错误合同统一”为核心，前端以“新增仪表盘 + 增强用户页 + 上传队列化”为核心。尽量复用现有路由和数据结构，只拆分本轮会继续膨胀的文件，避免过度重构；`/api/stats` 继续服务现有用户视角统计，管理员首页走新的专用聚合接口。

**Tech Stack:** Vue 3 + Vite、Cloudflare Workers、D1、R2、Axios、itty-router、Node test

---

## 范围确认

**本轮 P0 包含：**
- 管理员仪表盘页面与导航入口
- 定时任务运行结果落库、可查询、可展示
- 用户管理页补齐编辑闭环（角色 / 状态 / 配额）
- 上传接口错误合同统一，前端可稳定展示错误
- 多文件上传队列、串行上传、单项取消、失败可见
- Setup 页状态可见性补丁
- 最小必要后端测试与回归验证

**本轮 P0 明确不做：**
- `/account` 用户自助中心
- `/shares` 独立分享管理中心
- 复杂 R2 策略与迁移工具
- 前端自动化测试体系重建
- 登录后默认跳转策略大改

## 文件结构与职责

### 新增前端文件

- `frontend/src/views/Dashboard.vue`：管理员仪表盘容器，负责拉取 overview / job runs 数据并组织子组件。
- `frontend/src/components/dashboard/OverviewCards.vue`：展示系统概览卡片（用户数、文件数、用量、到期风险等）。
- `frontend/src/components/dashboard/JobRunsPanel.vue`：展示最近定时任务执行结果、耗时、失败摘要。
- `frontend/src/components/dashboard/RiskAlertsPanel.vue`：展示高风险告警，如默认配置缺失、上传配置不可用、任务失败、空间紧张。
- `frontend/src/components/users/UserEditModal.vue`：从 `Users.vue` 中拆出用户编辑表单，统一处理角色 / 状态 / 配额编辑。
- `frontend/src/composables/useUploadQueue.js`：管理上传队列状态、串行执行、取消、重试入口、结果汇总。
- `frontend/src/components/upload/UploadQueueList.vue`：渲染上传队列列表。
- `frontend/src/components/upload/UploadQueueItem.vue`：渲染单个上传任务项（进度、状态、错误、操作）。
- `frontend/src/locales/zh-CN/pages/dashboard.js`、`frontend/src/locales/en-US/pages/dashboard.js`：仪表盘文案。

### 新增后端文件

- `worker/src/services/jobRuns.ts`：封装任务运行记录的创建、更新、查询。
- `worker/src/services/adminOverview.ts`：聚合管理员首页所需统计与风险数据。
- `worker/src/services/uploadErrors.ts`：统一上传链路错误映射与响应合同。
- `worker/src/routes/adminOverview.ts`：`GET /api/admin/overview` 管理员聚合接口。
- `worker/src/routes/adminJobRuns.ts`：`GET /api/admin/job-runs` 管理员任务记录列表接口。
- `worker/tests/admin-overview.test.cjs`：管理员 overview / job-runs 接口回归。
- `worker/tests/upload-error-contract.test.cjs`：上传错误合同回归。

### 重点修改文件

- `frontend/src/router/index.js`
- `frontend/src/components/layout/BrutalSidebar.vue`
- `frontend/src/services/api.js`
- `frontend/src/views/Users.vue`
- `frontend/src/components/upload/UploadPanel.vue`
- `frontend/src/components/ui/upload/BrutalUpload.vue`
- `frontend/src/components/ui/upload/Upload.vue`
- `frontend/src/views/Setup.vue`
- `frontend/src/locales/zh-CN/index.js`
- `frontend/src/locales/en-US/index.js`
- `frontend/src/locales/zh-CN/sidebar.js`
- `frontend/src/locales/en-US/sidebar.js`
- `frontend/src/locales/zh-CN/upload.js`
- `frontend/src/locales/en-US/upload.js`
- `frontend/src/locales/zh-CN/pages/users.js`
- `frontend/src/locales/en-US/pages/users.js`
- `frontend/src/locales/zh-CN/pages/setup.js`
- `frontend/src/locales/en-US/pages/setup.js`
- `worker/src/index.ts`
- `worker/src/routes/upload.ts`
- `worker/src/routes/users.ts`
- `worker/src/jobs/cleanupExpired.ts`
- `worker/src/jobs/cleanupDeleteQueue.ts`
- `worker/src/jobs/cleanupRetention.ts`
- `worker/src/services/dbSchema.ts`
- `worker/src/db/schema.sql`

## 验证命令

- `npm --prefix "worker" run typecheck`
- `npm --prefix "worker" run lint`
- `npm --prefix "worker" run test`
- `npm --prefix "frontend" run lint`
- `npm --prefix "frontend" run build`
- `node --test "frontend/tests/*.test.js"`
- `cd "worker" && npx wrangler d1 execute "DB" --local --file="src/db/schema.sql"`

> 注：按当前用户要求，本计划不包含 git commit / branch / reset / push 步骤。

## 推荐执行顺序

1. 数据库与任务记录基础
2. cleanup job 返回结构统一
3. scheduled 接入任务落库
4. 管理员 overview / job-runs 后端接口
5. 管理员 Dashboard 前端页面
6. 用户管理闭环增强
7. 上传错误合同统一
8. 上传队列状态管理
9. 上传入口改为多文件
10. 上传队列 UI 接入
11. Setup 页状态补丁
12. 测试与回归

---

### Task 1: 数据库与任务记录基础

**Files:**
- Modify: `worker/src/db/schema.sql`
- Modify: `worker/src/services/dbSchema.ts`

- [ ] **Step 1: 定义 `job_runs` 表**

新增最小必要字段：
- `id`
- `job_name`
- `status`（建议限定为 `success` / `partial` / `failed`）
- `started_at`
- `finished_at`
- `duration_ms`
- `summary_json`
- `error_message`
- `created_at`

补充索引：
- `idx_job_runs_job_name`
- `idx_job_runs_created_at`
- `idx_job_runs_status`

- [ ] **Step 2: 在 `dbSchema` 提供 ensure helper**

新增 `ensureJobRunsTable`（或同等命名）：
- 保证老本地库在未重新执行完整 schema 时，也能在运行期创建新表
- 不做额外抽象层，不预埋未来无明确需求的字段

- [ ] **Step 3: 验证本地 schema 可执行**

Run:
```bash
cd "worker" && npx wrangler d1 execute "DB" --local --file="src/db/schema.sql"
```

Expected:
- 本地 D1 初始化成功
- `job_runs` 表与索引创建成功

### Task 2: 统一 cleanup job 返回结构

**Files:**
- Modify: `worker/src/jobs/cleanupExpired.ts`
- Modify: `worker/src/jobs/cleanupDeleteQueue.ts`
- Modify: `worker/src/jobs/cleanupRetention.ts`

- [ ] **Step 1: 为三个 cleanup job 设计统一返回合同**

统一返回结构建议：
- `jobName`
- `status`
- `processed`
- `succeeded`
- `failed`
- `startedAt`
- `finishedAt`
- `durationMs`
- `details`

要求：
- `cleanupExpired` 不再返回 `void`
- `cleanupDeleteQueue` 不再返回 `void`
- `cleanupRetention` 从现有计数字段包装成同一结构

- [ ] **Step 2: 保留现有业务语义，仅提升可观测性**

约束：
- 不改变“到期清理 / 删除队列 / 保留期清理”的核心业务判断
- 单条失败记录在结果中累计，不要只 `console.error` 后丢失上下文
- 避免把所有 job 逻辑揉进 `index.ts`

- [ ] **Step 3: 补上结果细节边界**

`details` 至少能支撑管理员查看：
- 删除了多少文件
- 跳过多少条
- 失败多少条
- retention 删除了多少 session / rate_limit / audit

### Task 3: scheduled 接入任务落库

**Files:**
- Create: `worker/src/services/jobRuns.ts`
- Modify: `worker/src/index.ts`
- Modify: `worker/src/services/dbSchema.ts`

- [ ] **Step 1: 实现任务运行记录 service**

在 `worker/src/services/jobRuns.ts` 中提供最小能力：
- `startJobRun`
- `finishJobRun`
- `listJobRuns`
- 必要时提供 `runTrackedJob` 包装器

要求：
- 接口聚焦定时任务落库，不做通用任务框架
- `summary_json` 只存可序列化摘要，不存大对象

- [ ] **Step 2: scheduled handler 顺序接入落库**

修改 `worker/src/index.ts` 中 `handleScheduled`：
- 在每个 cleanup job 执行前写入开始记录
- 成功后更新为 `success` / `partial`
- 失败后更新为 `failed`
- 聚合日志继续输出结构化摘要

- [ ] **Step 3: 保持故障可见**

约束：
- 即使单个 job 失败，也要先把失败记录落库
- 最终仍保留 worker 平台可观察到的失败信号（日志或抛错语义）

### Task 4: 管理员首页后端聚合

**Files:**
- Create: `worker/src/services/adminOverview.ts`
- Create: `worker/src/routes/adminOverview.ts`
- Create: `worker/src/routes/adminJobRuns.ts`
- Create: `worker/tests/admin-overview.test.cjs`
- Modify: `worker/src/index.ts`
- Modify: `frontend/src/services/api.js`

- [ ] **Step 1: 定义 overview 接口返回结构**

新增管理员专用接口：
- `GET /api/admin/overview`
- `GET /api/admin/job-runs`

`overview` 至少包含：
- 用户总数 / 活跃用户数 / 禁用用户数
- 文件总数 / 已用空间
- 即将到期文件数
- 删除队列待处理数
- 当前默认上传配置状态
- 最近失败 job 摘要

- [ ] **Step 2: 在 service 层聚合 SQL**

要求：
- 聚合逻辑收口在 `adminOverview.ts`
- 路由层只做鉴权与参数解析
- 不复用现有 `/api/stats` 响应结构，避免继续把用户视角与管理员视角绑死

- [ ] **Step 3: 补最小后端回归测试**

测试至少覆盖：
- 非管理员访问返回 403
- overview 返回关键字段
- job-runs 能按时间倒序返回最近记录

Run:
```bash
npm --prefix "worker" run test:build && WORKER_TEST_OUTDIR=$PWD/worker/.test-dist node --test "worker/tests/admin-overview.test.cjs"
```

Expected:
- PASS

### Task 5: 管理员首页前端页面

**Files:**
- Create: `frontend/src/views/Dashboard.vue`
- Create: `frontend/src/components/dashboard/OverviewCards.vue`
- Create: `frontend/src/components/dashboard/JobRunsPanel.vue`
- Create: `frontend/src/components/dashboard/RiskAlertsPanel.vue`
- Create: `frontend/src/locales/zh-CN/pages/dashboard.js`
- Create: `frontend/src/locales/en-US/pages/dashboard.js`
- Modify: `frontend/src/router/index.js`
- Modify: `frontend/src/components/layout/BrutalSidebar.vue`
- Modify: `frontend/src/services/api.js`
- Modify: `frontend/src/locales/zh-CN/index.js`
- Modify: `frontend/src/locales/en-US/index.js`
- Modify: `frontend/src/locales/zh-CN/sidebar.js`
- Modify: `frontend/src/locales/en-US/sidebar.js`

- [ ] **Step 1: 新增管理员 dashboard 路由**

建议：
- 新增 `/dashboard`
- 仅管理员可访问
- 暂不改普通用户默认首页

- [ ] **Step 2: 拆分仪表盘组件**

页面结构：
- `OverviewCards`：概览卡片
- `JobRunsPanel`：最近任务执行结果
- `RiskAlertsPanel`：高优先级风险提示

要求：
- 组件按单一职责拆分
- 页面只负责数据获取、刷新、错误态、加载态

- [ ] **Step 3: 接入 sidebar 导航与文案**

修改侧边栏：
- 管理员显示 “Dashboard” 导航
- 位置放在管理类入口最前，避免与普通文件页混淆

- [ ] **Step 4: 手工验证管理员首页**

验证：
- 管理员可见 dashboard
- 普通用户访问 `/dashboard` 被重定向或拦截
- 页面能展示 overview、job runs、风险提醒三块区域

### Task 6: 用户管理闭环增强

**Files:**
- Create: `frontend/src/components/users/UserEditModal.vue`
- Modify: `frontend/src/views/Users.vue`
- Modify: `frontend/src/services/api.js`
- Modify: `frontend/src/locales/zh-CN/pages/users.js`
- Modify: `frontend/src/locales/en-US/pages/users.js`
- Verify: `worker/src/routes/users.ts`

- [ ] **Step 1: 把编辑能力从列表页中拆出来**

新增 `UserEditModal.vue`，承接：
- 角色编辑
- 状态编辑
- 配额编辑

保留现有：
- 创建用户
- 重置密码
- 删除 / 禁用确认

- [ ] **Step 2: Users 页面补齐“编辑”入口与回填**

要求：
- 列表操作区明确区分“编辑 / 重置密码 / 禁用 / 删除”
- 编辑表单打开时回填当前角色、状态、配额
- 提交后刷新列表并给出成功/失败反馈

- [ ] **Step 3: 前后端字段对齐**

校对 `Users.vue` 与 `worker/src/routes/users.ts`：
- 角色：`admin` / `user`
- 状态：`active` / `disabled`
- 配额：以 `quota_bytes` 为准，前端做 GB <-> bytes 转换

### Task 7: 上传错误合同统一

**Files:**
- Create: `worker/src/services/uploadErrors.ts`
- Create: `worker/tests/upload-error-contract.test.cjs`
- Modify: `worker/src/routes/upload.ts`
- Modify: `frontend/src/components/upload/UploadPanel.vue`
- Modify: `frontend/src/locales/zh-CN/upload.js`
- Modify: `frontend/src/locales/en-US/upload.js`

- [ ] **Step 1: 梳理上传入口现有错误分支**

覆盖入口：
- `presignUpload`
- `initMultipart`
- `presignMultipart`
- `completeMultipart`
- `abortMultipart`

统一输出：
- `error.code`
- `error.message`
- 必要时附带 `details`

- [ ] **Step 2: 提取统一错误映射 service**

在 `uploadErrors.ts` 中统一处理：
- 文件过大
- 配额不足
- 上传配置不可用
- multipart 分片缺失
- S3 / R2 异常转用户可读错误

- [ ] **Step 3: 前端按稳定合同展示错误**

要求：
- `UploadPanel.vue` 优先使用后端返回的 `error.message`
- 仅在无明确 message 时回退本地默认文案
- 保留取消上传与失败状态区分

- [ ] **Step 4: 增加上传错误合同回归测试**

Run:
```bash
npm --prefix "worker" run test:build && WORKER_TEST_OUTDIR=$PWD/worker/.test-dist node --test "worker/tests/upload-error-contract.test.cjs"
```

Expected:
- PASS

### Task 8: 上传队列状态管理

**Files:**
- Create: `frontend/src/composables/useUploadQueue.js`
- Modify: `frontend/src/components/upload/UploadPanel.vue`

- [ ] **Step 1: 设计队列数据结构**

单个任务建议包含：
- `id`
- `file`
- `status`
- `progress`
- `uploadedBytes`
- `totalBytes`
- `speed`
- `remainingTime`
- `result`
- `error`
- `cancel`

状态最少包含：
- `queued`
- `uploading`
- `success`
- `error`
- `cancelled`

- [ ] **Step 2: 把单文件上传流程封装为队列执行器**

要求：
- 先只实现串行上传，避免并发把 UI 和错误处理复杂化
- 复用现有 presign / multipart / confirm 逻辑
- 不把业务请求直接散落在多个组件内

- [ ] **Step 3: 保证取消行为只影响当前任务**

要求：
- 当前上传项可取消
- 后续排队项仍保留
- 组件卸载时统一清理 in-flight controller

### Task 9: 上传入口改为多文件

**Files:**
- Modify: `frontend/src/components/ui/upload/BrutalUpload.vue`
- Modify: `frontend/src/components/ui/upload/Upload.vue`
- Modify: `frontend/src/components/upload/UploadPanel.vue`
- Modify: `frontend/src/locales/zh-CN/upload.js`
- Modify: `frontend/src/locales/en-US/upload.js`

- [ ] **Step 1: 上传控件支持 `multiple`**

要求：
- input 增加 `multiple`
- 拖拽时接收 `FileList`
- `file-selected` / `before-upload` 事件改为批量文件语义

- [ ] **Step 2: 保持旧调用点最小改造**

要求：
- `UploadPanel.vue` 成为唯一主要适配点
- 不为本轮引入额外上传组件层级

- [ ] **Step 3: 更新文案**

把当前“支持单个文件上传”调整为多文件队列化表述，并新增：
- 队列中
- 上传成功
- 上传失败
- 已取消
- 重试（如本轮决定提供）

### Task 10: 上传队列 UI

**Files:**
- Create: `frontend/src/components/upload/UploadQueueList.vue`
- Create: `frontend/src/components/upload/UploadQueueItem.vue`
- Modify: `frontend/src/components/upload/UploadPanel.vue`

- [ ] **Step 1: 渲染队列列表**

列表最少展示：
- 文件名
- 当前状态
- 进度条
- 错误摘要
- 当前项可取消

- [ ] **Step 2: 保留最近一次成功结果的分享入口**

要求：
- 不必给每个成功项都展开完整分享区块
- 但至少要让最新成功上传仍可复制短链 / 直链
- 避免把原有成功态大块 UI 完全删掉导致可用性倒退

- [ ] **Step 3: 增加队列完成后的清理策略**

约束：
- 不自动清掉失败项
- 成功项可保留到用户手动关闭或页面刷新
- 避免队列状态丢失后用户不知道哪些文件已成功

### Task 11: Setup 页状态补丁

**Files:**
- Modify: `frontend/src/views/Setup.vue`
- Modify: `frontend/src/locales/zh-CN/pages/setup.js`
- Modify: `frontend/src/locales/en-US/pages/setup.js`
- Verify: `frontend/src/services/api.js`

- [ ] **Step 1: 明确默认配置 / 可上传状态**

补强 Setup 页信息展示：
- 当前默认配置是否存在
- 是否存在可用于上传的配置
- 可选地展示 legacy files config 是否缺失

- [ ] **Step 2: 补齐空态与风险提示**

要求：
- 配置列表为空时已有空态继续保留
- 当存在配置但没有默认配置时，给出明显提示
- 当配置测试失败或全部不可用时，提示管理员尽快处理

- [ ] **Step 3: 保持本页职责单一**

约束：
- 只补状态可见性，不把 dashboard 逻辑塞进 Setup
- 不在本轮扩展复杂的 R2 运维能力

### Task 12: 测试与回归

**Files:**
- Verify: `worker/tests/admin-overview.test.cjs`
- Verify: `worker/tests/upload-error-contract.test.cjs`
- Verify existing: `worker/tests/operability-logs.test.cjs`
- Verify existing: `worker/tests/retention-jobs.test.cjs`
- Verify existing: `worker/tests/r2-config-quota.test.cjs`
- Verify existing: `worker/tests/user-resource-lifecycle.test.cjs`
- Verify existing: `frontend/tests/auth-redirect.test.js`
- Verify existing: `frontend/tests/theme-bootstrap.test.js`

- [ ] **Step 1: 跑 worker 全量检查**

Run:
```bash
npm --prefix "worker" run typecheck
npm --prefix "worker" run lint
npm --prefix "worker" run test
```

Expected:
- 全部 PASS

- [ ] **Step 2: 跑 frontend 构建检查**

Run:
```bash
npm --prefix "frontend" run lint
npm --prefix "frontend" run build
node --test "frontend/tests/*.test.js"
```

Expected:
- lint / build / tests 全部 PASS

- [ ] **Step 3: 手工回归关键路径**

手工验证清单：
- 管理员可见 dashboard、users、setup
- 普通用户不可访问 dashboard / users / setup
- 用户编辑角色 / 状态 / 配额可成功保存
- 多文件选择后进入上传队列
- 单个失败文件不会阻塞后续队列项展示结果
- 上传配置不可用时前端提示明确
- Setup 页可看见默认配置缺失或配置异常提示

## 评审重点

评审此计划时请优先看：
- `job_runs` 表结构是否够用但不过度设计
- 管理员 dashboard 是否与 `/setup`、`/users` 职责边界清晰
- 上传队列是否坚持“串行 + 可见 + 可取消”的最小闭环
- 用户管理增强是否只补闭环、没有把页面继续做成巨型组件
- 本轮测试范围是否足够覆盖高风险改动点

## 执行备注

- 本计划默认以最小必要改动推进，优先补齐可运营闭环，不做审美级重构。
- 如执行中发现 `worker/src/services/dbSchema.ts` 已存在更合适的 migration helper，应复用既有模式，不要平行造新轮子。
- 如 dashboard 指标与 `/api/stats` 出现语义冲突，优先保证管理员接口稳定，不要强行兼容旧字段命名。
