# 用户资源生命周期修复设计

**目标**

修复用户禁用/删除后的资源生命周期问题，保证公开访问路径与用户状态一致，避免删除流程产生孤儿资源或未下线分享。

**范围**

- 统一 `updateUser(status=deleted)` 与 `deleteUser` 的语义，避免出现“用户已删除但资源未处理”的分叉路径。
- 在公开访问路径上校验 owner 用户状态，禁用或删除用户后公开分享立即失效。
- 删除用户时同步下线文本相关公开资源，并保证文件删除队列写入的幂等性与一致性更强。
- 为上述行为补充回归测试。

**不在本轮范围**

- R2 配置 `quota_bytes` 的强约束。
- CI 工作流接入与测试运行基建重构。

## 方案

### 1. 统一删除语义

`updateUser` 不再接受 `status=deleted`。删除用户只能走 `deleteUser`，由它负责：

- 标记用户为 `deleted`
- 撤销会话
- 标记用户文件为删除态并写入 `delete_queue`
- 下线该用户的文本、文本分享、一次性分享、文件分享

这样避免两个入口维护不同的副作用链路。

### 2. 公开访问校验 owner 状态

在以下公开访问链路增加 owner 状态约束：

- 文本分享
- 一次性文本分享
- 文件分享
- 文件短链 `/s/:code`

当 owner 不是 `active` 时，一律返回资源不可用，而不是继续暴露内容或跳转下载。

### 3. 删除用户的关联资源处理

删除用户时补充处理：

- `texts.deleted_at = now`
- 删除 `text_shares`
- 删除 `text_one_time_shares`
- 删除 `file_shares`

文件本体仍通过现有 `delete_queue` 异步清理 R2，对象删除逻辑不扩张职责。

### 4. 一致性策略

不引入额外抽象层，保持 KISS：

- 将“下线用户资源”收敛到 `users.ts` 内部私有 helper
- 对 `delete_queue` 插入改为“先查重后插入”或 `INSERT OR IGNORE` 风格的幂等写法
- 保持现有 Cron 清理职责不变

## 影响文件

- `worker/src/routes/users.ts`
- `worker/src/routes/textShares.ts`
- `worker/src/routes/textOneTimeShares.ts`
- `worker/src/routes/fileShares.ts`
- `worker/src/routes/shortlink.ts`
- `worker/tests/*`

## 测试策略

- 先写 worker 行为测试，再改实现。
- 覆盖：
  - `updateUser` 拒绝 `deleted`
  - `deleteUser` 会下线文本与分享
  - disabled/deleted owner 下，文本分享、一次性分享、文件分享、短链访问失败

## 风险

- 现有 worker 测试运行链路不完整，可能需要先修测试装配。
- 公开分享错误文案可能需要与现有前端/后端提示保持一致。
