# 发布与回滚手册

## 默认发布基线

默认发布链路是 `.github/workflows/deploy-worker-only.yml`，工作流名为 `Deploy Worker Only`。

这条链路会在 `push` 到 `main` 时自动触发，同时保留 `workflow_dispatch` 作为手动重跑入口。当前流程是单 job 直接部署，顺序如下：

1. 安装 `worker/` 与 `frontend/` 依赖
2. 强制执行 `npm run verify:release`；失败则停止发布
3. 从 `worker/wrangler.full.toml` 读取 Worker 名称与 D1 数据库名，生成临时 `worker/wrangler.full.ci.toml`
4. 自动确保目标 D1 存在，并向临时配置注入真实 `database_id`
5. 校验目标 Worker 已配置 `R2_MASTER_KEY` 与 `AUTH_TOKEN_SECRET`
6. 执行 `node ./scripts/reconcile-legacy-d1-columns.mjs --config wrangler.full.ci.toml --database DB --remote`，然后执行 `wrangler --config wrangler.full.ci.toml d1 migrations apply DB --remote`
7. 执行 `wrangler --config wrangler.full.ci.toml deploy` 部署 full-stack worker

`deploy.yml` 仍然只是 `Pages + Worker` 拆分部署的手动备用链路，不再作为默认生产发布基线。

## 建议性预检

建议在推送或手动触发之前，先在仓库根目录执行：

```bash
npm run verify:release
```

这条命令会串行执行：

1. `npm run audit:prod`
2. `npm run lint`
3. `npm run format:check`
4. `npm run typecheck`
5. `npm run test`
6. `npm run build`
7. `npm run dry-run:worker`

如只想检查 `wrangler` 发布链路，可单独执行：

```bash
npm run dry-run:worker
```

注意：

- `verify:release` 是推荐本地预检，也是 `deploy-worker-only.yml` 的发布前硬门禁
- 不要在仓库根目录直接执行裸 `wrangler deploy --dry-run`
- 在当前 monorepo 下，Wrangler v4 会把根目录误判成静态站初始化场景
- 应通过 `worker/package.json` 中的 dry-run 脚本执行，本仓库已固定：
  - `WRANGLER_LOG_PATH=.wrangler/logs`
  - `WRANGLER_SEND_METRICS=false`
  - standalone dry-run 显式使用 `--config wrangler.toml`
  - full-stack dry-run 显式使用 `--config wrangler.full.toml`

## GitHub Secrets 与云端前置项

GitHub 仓库至少要提供：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

> 获取方式：`CLOUDFLARE_API_TOKEN` 在 Cloudflare Dashboard -> My Profile -> API Tokens 创建；`CLOUDFLARE_ACCOUNT_ID` 可在 Cloudflare Dashboard 任意页面的 Account 信息处查看。
> 默认全栈发布链路直接读取 `worker/wrangler.full.toml` 中的 Worker 名称与 D1 数据库名，不需要额外配置 GitHub Environment variables。

Cloudflare 侧必须提前为目标 Worker 准备：

- `R2_MASTER_KEY`
- `AUTH_TOKEN_SECRET`
- 其他业务所需变量 / Secrets

注意：

- workflow 会按 `worker/wrangler.full.toml` 中的 `database_name` 自动创建缺失的 D1 数据库，并把真实 `database_id` 注入临时 `worker/wrangler.full.ci.toml`
- workflow 不会自动创建 `R2_MASTER_KEY` 或 `AUTH_TOKEN_SECRET`
- 若目标 Worker 还不存在，先在 Cloudflare 中完成首次 secret provisioning，再触发发布

## 发布步骤

### 自动触发发布

1. 确认待发布提交已经在 `main`
2. 建议先在本地执行 `npm run verify:release`
3. 推送到 `main`
4. 等待 GitHub Actions 中的 `Deploy Worker Only` 单个 `deploy` job 完成；job 会先强制通过同一 release gate

### 手动重跑同一版发布

1. 打开 GitHub Actions
2. 运行 `Deploy Worker Only`
3. 选择 `main` 对应的目标提交
4. 等待单个 `deploy` job 完成

## Day5 联合放行演练

### 本地预检

1. 建议在仓库根目录执行 `npm run verify:release`
2. 这一步用于尽早发现依赖、类型、测试、构建和 dry-run 问题；deploy workflow 会再次强制执行

### 真实发布演练

1. 推送当前 `main`，或手动触发 `Deploy Worker Only`
2. 确认 deploy job 内的 `Release verification gate` 通过
3. deploy job 通过后，至少回归以下链路各 1 次：
   - 登录
   - 上传
   - 分享访问
   - 删除
   - 定时清理或手工触发清理验证
4. 若仍保留 `Manual Split Pages + Worker Deploy` 作为备用链路，需额外确认其 workflow 仍可按预期运行

### Go / No-Go 判定

- `Go`：
  - `Release verification gate` 通过
  - `Deploy Worker Only` job 通过
  - 联调链路无阻断缺陷
- `No-Go`：
  - `Release verification gate` 失败
  - `Deploy Worker Only` job 失败
  - 联调未覆盖登录、上传、分享、删除、清理任一关键链路
  - 缺少 Cloudflare / GitHub Secrets 权限，无法完成真实发布

### 记录产物

每次 Day5 演练都应产出一份 go/no-go 记录，至少包含：

- 日期
- commit SHA
- 本地预检结果
- deploy job 结果
- 联调链路覆盖情况
- 当前结论与阻塞项

仓库内可直接复用 `.trellis/tasks/04-27-project-readiness-audit/day5-go-no-go.md` 作为首份记录。

## 回滚步骤

### 回滚代码版本

1. 在 GitHub 上定位上一个已知可用的 `main` commit SHA
2. 通过正常代码流程把 `main` 回退到该版本
3. 推送回退后的 `main`，或在回退后的 `main` 上手动运行 `Deploy Worker Only`
4. 发布完成后，回归登录、上传、分享、删除、清理等关键链路

### 数据与配置注意事项

- 这条链路只保证代码与静态资源可回滚，不自动回滚 D1 migration
- 若某次发布已经执行了破坏性 migration，需要按对应 SQL 预案单独处理
- `R2_MASTER_KEY` 不要在回滚时切换，否则历史密文无法解密
- `AUTH_TOKEN_SECRET` 不要在普通回滚中切换，否则已签发的登录 Cookie / Bearer token 会立即失效

## 非默认链路

`Manual Split Pages + Worker Deploy` 只用于以下场景：

- 临时保留 `Pages + Worker` 拆分拓扑
- 默认 `Worker Only` 全栈链路不可用时的人工作业备用方案

除非明确要维护拆分部署，否则不要把它当成默认生产通道继续演进。
