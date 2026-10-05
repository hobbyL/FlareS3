# R2 配置配额硬约束设计

**目标**

让 `r2_configs.quota_bytes` 从展示字段变成真实的上传准入约束。任一上传请求在选定存储配置上的占用达到上限后，应被后端拒绝。

**确认语义**

- 计入占用的文件状态：`pending`、`uploading`、`completed`
- 不计入占用的记录：`deleted_at IS NOT NULL` 或 `expires_at <= now`
- 配额释放时机：文件删除、文件过期、上传记录被标记删除后自动释放

## 范围

- 在直传预签名和分片初始化阶段执行配置配额校验
- 统计口径与管理页显示保持一致，但扩展到 `pending/uploading/completed`
- 补充 worker 回归测试

## 不在本轮范围

- 前端上传面板展示剩余容量
- 强事务级别的并发锁定
- 在 `confirmUpload` / `completeMultipart` 阶段二次拒绝已预留的上传

## 方案对比

### 方案 A：仅在上传入口做预检查

优点：
- 改动最小
- 能覆盖绝大多数场景

缺点：
- 校验逻辑容易散落在 `upload.ts`
- 可复用性差

### 方案 B：抽出配置配额服务，在上传入口统一校验

优点：
- 单一职责，统计与校验逻辑集中
- 直传和分片共用
- 便于测试与后续扩展

缺点：
- 仍不能完全避免并发竞争导致的短暂超额

### 方案 C：引入保留额度表

优点：
- 并发语义最完整

缺点：
- 需要 schema 变更和更多清理逻辑
- 超出当前最小修复范围

**结论：采用方案 B。**

## 详细设计

### 1. 新增配置配额服务

新增一个小型 service，职责只有两个：

- 根据配置 ID 统计当前占用：
  - `upload_status IN ('pending','uploading','completed')`
  - `deleted_at IS NULL`
  - `expires_at > now`
- 读取该配置的 `quota_bytes`

然后提供一个统一校验函数：

- 输入：`env.DB`、配置 ID、本次声明大小
- 输出：通过 / 抛出明确的业务错误

### 2. 上传入口接入

在以下入口接入统一校验：

- `presignUpload`
- `initMultipart`

顺序为：

1. 解析请求和用户配额
2. 解析最终可用的 `loaded.id`
3. 校验配置配额
4. 创建 `files` 记录

这样能保证配置选择策略与配额策略使用的是同一个最终配置 ID。

### 3. 错误语义

配置配额不足时返回 `413`，但文案与用户配额分开：

- 用户配额：`超出配额`
- 配置配额：`所选存储配置空间不足`

### 4. 与现有展示的一致性

管理页 [r2Configs.ts](/Users/mhp/Documents/workspace/wj/github/flares3/worker/src/routes/r2Configs.ts) 当前只统计 `completed`。本轮一并把展示口径修正到 `pending/uploading/completed`，避免“管理页看起来没满，但上传被拒绝”的认知冲突。

## 影响文件

- `worker/src/routes/upload.ts`
- `worker/src/routes/r2Configs.ts`
- `worker/src/services/*` 新增一个配置配额 helper
- `worker/tests/*`

## 测试策略

- 先写 worker 失败测试，再改实现
- 覆盖：
  - 直传配置配额不足被拒绝
  - 分片初始化配置配额不足被拒绝
  - `pending/uploading/completed` 都计入占用
  - `deleted/expired` 不计入占用
  - 管理页配置占用统计口径同步变化
