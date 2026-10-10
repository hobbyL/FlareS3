# FlareS3

基于 Cloudflare Workers + D1 的多用户文件 / 文档托管与分享平台：支持 R2 / WebDAV / Koofr 多存储后端、直传与分片上传、短链与多种分享形态，内置用户管理、配额、回收站与审计。

## 架构

- 前端：Vue 3 + Vite（可由 Pages 或 Worker 全栈托管）
- 后端：Cloudflare Workers（同域 `/api`、`/s`、`/f`、`/t`）
- 数据库：D1
- 存储：R2（S3 兼容）/ WebDAV / Koofr，多配置可并存、按需切换，访问密钥加密存储

## 功能

- 文件：Presign 直传 / 服务端上传 / 分片上传（multipart），短链分享（可配置下载是否需登录，含分享二维码），重命名，批量操作（多选删除 / 批量恢复 / 批量永久删除），文件夹上传（保留相对路径目录结构），目录化浏览（面包屑 + 按目录过滤），回收站（软删除、恢复、永久删除、清空）
- 文档：在线创建与管理，支持口令 / 过期时间 / 访问次数限制分享；文本回收站（软删除、恢复、彻底删除、清空）；一次性分享二维码（限时、单次访问，旧码自动失效）
- 文件夹分享：按存储前缀分享目录，支持口令 / 有效期 / 访问次数
- 分享中心：统一查看和管理文件、文档与一次性分享，含访问记录
- 挂载浏览：直接浏览存储后端对象（不依赖数据库记录），支持预览（含视频 / 音频）/ 上传 / 移动 / 删除 / 跨存储复制（R2 ↔ WebDAV ↔ Koofr，可选迁移删源）
- 存储配置：多存储配置管理（R2 / WebDAV / Koofr），敏感密钥用 `R2_MASTER_KEY` 加密后写入 D1
- 用户：角色（admin / user）、启用 / 禁用、配额管理
- 仪表盘：用户 / 文件 / 分享 / 用量统计概览
- 审计日志：全量操作留痕，支持动作 / 操作者 / 时间范围筛选与批量删除
- 定时任务（每小时 Cron）：过期上传与分享清理、保留期数据清理（会话 / 限流 / 审计）、删除队列批处理
- 其他：中英双语（zh-CN / en-US）、双主题（neo-brutalism / shadcn）、会话管理、登录限流与防爆破

## 目录结构

```
./flares3
├── frontend
├── worker
├── tests
│   ├── frontend
│   └── worker
└── docs        # 本地文档工作区（不入库）
```

## 本地开发

### 0) 安装依赖（分别在子目录）

```bash
cd "~/flares3/worker"
npm install

cd "~/flares3/frontend"
npm install
```

### 1) 初始化 D1（本地模拟）

```bash
cd worker
node ./scripts/reconcile-legacy-d1-columns.mjs --database "DB" --local
npx wrangler d1 migrations apply "DB" --local
```

- `DB` 为 `worker/wrangler.toml` 中 `[[d1_databases]]` 的 `binding`。
- `worker/migrations/` 现在是唯一 schema 真相源；新环境只需要 `migrations apply` 即可初始化。
- 如果本地 D1 是 migration 正式化之前留下的旧状态，`reconcile-legacy-d1-columns.mjs` 会补齐历史缺失列；新库会自动跳过。
- 这会把本地数据库写到 `worker/.wrangler/state/v3/d1/`（Miniflare 持久化），不依赖远程 D1。
- 需要重置本地数据可删除该目录或执行 `npx wrangler d1 execute DB --local --command "DELETE FROM users;"` 等。

> 说明：WebDAV / Koofr 后端的访问配置同样在管理页 `/setup` 中通过 UI 创建/管理（写入 D1）。

### 2) 配置环境变量

- 复制 `worker/.dev.vars.example` 为 `worker/.dev.vars`
- 设置以下必需变量：
  - `BOOTSTRAP_ADMIN_USER`
  - `BOOTSTRAP_ADMIN_PASS`
  - `AUTH_TOKEN_SECRET`（认证 Cookie / Bearer token 签名密钥；必填，不要与 `R2_MASTER_KEY` 共用）
  - `R2_MASTER_KEY`（32 字节 base64，可用 `openssl rand -base64 32` 生成；需长期保持不变，用于加密/解密 UI 保存的 R2 访问密钥）

> 注意：`worker/.dev.vars` 仅用于本地 `wrangler dev`；生产环境请在 Cloudflare Dashboard 或 `wrangler secret put` 配置变量与 Secrets（不要提交/分享该文件）。  
> R2 访问配置（Endpoint / Access Key / Secret Key / Bucket）请在管理页 `/setup` 中通过 UI 创建/管理（写入 D1）。

### 3) 启动服务（分别启动）

```bash
cd "~/flares3/worker"
npm run dev

cd "~/flares3/frontend"
npm run dev
```

> 如需并发启动，可在根目录执行：`npm run dev`（依赖已在子目录安装）。
> 首次请求若用户表为空，会用 `BOOTSTRAP_ADMIN_USER/PASS` 自动创建管理员。

## 质量检查（可选）

在根目录执行（不需要在根目录安装依赖；会调用子目录脚本）：

```bash
npm run audit:prod
npm run lint
npm run typecheck
npm run test
npm run build
npm run dry-run:worker
npm run format:check

# 或者直接跑与 CI / Day5 放行一致的一键校验
npm run verify:release
```

测试源码统一放在根级 `tests/`：

- `tests/worker/**/*.test.cjs`：Worker 单测，按 `routes/`、`services/`、`jobs/`、`config/`、`migrations/`、`workflows/` 等架构目录分组；仍通过 `npm --prefix worker run test` 先编译到 `worker/.test-dist` 后运行。
- `tests/frontend/**/*.test.js`：前端纯函数 / 源码结构测试，按 `components/`、`views/`、`utils/`、`composables/`、`public/` 分组；通过根脚本 `npm run test` 运行。
- `worker/tests` 与 `frontend/tests` 不再作为测试源码目录。

`npm run verify:release` 是发布前阻塞门禁，包含 `audit:prod + lint + format:check + typecheck + test + build + worker dry-run`。

## 部署到 Cloudflare

本项目支持两种部署模式：

- **拆分部署（Pages + Worker）**：前端用 Cloudflare Pages，后端用 Cloudflare Workers（同域接管 `/api/*`、`/s/*`、`/f/*`、`/t/*`）
- **单 Worker 全栈部署（Worker Only）**：只部署一个 Worker，同域提供前端静态资源 + 后端 API（Worker 接管 `/*`）

默认命名约定：

- 拆分部署：
  - Pages 项目名：`flares3-pages`
  - Worker 名称：`flares3-worker`（见 `worker/wrangler.toml`）
- 单 Worker 全栈部署：
  - Worker 名称：`flares3-spa`（见 `worker/wrangler.full.toml`）

### 手动部署

#### A) 拆分部署（Pages + Worker）

1. 创建/绑定 D1（默认配置使用 `flares3-db`）与 R2（并在 `worker/wrangler.toml` 填写实际 `database_id`）
2. 设置 Worker 运行时变量 / Secrets（生产环境请在 Cloudflare Dashboard 或 `wrangler secret put` 配置；`.dev.vars` 仅本地开发；使用 GitHub Actions 自动创建 D1 时可忽略 `database_id` 占位符）
3. 对已有库先补齐历史缺失列，再执行 migration：
   - `node ./scripts/reconcile-legacy-d1-columns.mjs --config "wrangler.toml" --database "DB" --remote`
   - `npx wrangler --config "wrangler.toml" d1 migrations apply "DB" --remote`
4. 部署 Worker：`npm --prefix worker run deploy`（等价于 `wrangler deploy --config wrangler.toml`，部署/更新 `flares3-worker`）
5. Pages 绑定路由：`/api/*`、`/s/*`、`/f/*`、`/t/*`

#### B) 单 Worker 全栈部署（Worker Only）

1. 创建/绑定 D1（默认配置使用 `flares3-db`）与 R2（并在 `worker/wrangler.full.toml` 填写实际 `database_id`）
2. 设置 Worker 运行时变量 / Secrets（生产环境请在 Cloudflare Dashboard 或 `wrangler secret put` 配置；`.dev.vars` 仅本地开发；使用 GitHub Actions 自动创建 D1 时可忽略 `database_id` 占位符）
3. 对已有库先补齐历史缺失列，再执行 migration：
   - `node ./scripts/reconcile-legacy-d1-columns.mjs --config "wrangler.full.toml" --database "DB" --remote`
   - `npx wrangler --config "wrangler.full.toml" d1 migrations apply "DB" --remote`
4. 构建前端（生成 `frontend/dist`）：`npm --prefix frontend run build`
5. 部署 Worker（全栈）：`npm --prefix worker run deploy:full`（部署/更新 `flares3-spa`）
6. 在 Cloudflare Dashboard 绑定 Worker 路由：`/*` -> Worker（此模式不再需要 Pages 项目）

### 自动化部署（可选）

仓库内置基础 CI（见 `.github/workflows/ci.yml`）：分别在 `worker/` 与 `frontend/` 安装依赖，并执行与 Day5 放行一致的 `npm run verify:release`（`audit:prod + lint + format:check + typecheck + test + build + worker dry-run`）。

如需 CD（由 GitHub Actions 发布），当前建议按“直接主链路 + 手动备用链路”使用：

- **直接全栈发布基线**：`.github/workflows/deploy-worker-only.yml`
  - GitHub Actions 名称：`Deploy Worker Only`
  - `push` 到 `main` 自动触发，同时保留 `workflow_dispatch`
  - 单 job 直接部署，不依赖 GitHub `staging` / `production` Environments
  - 部署前强制执行 `npm run verify:release`（`audit:prod + lint + format:check + typecheck + test + build + worker dry-run`），失败则不会继续发布
  - 从 `worker/wrangler.full.toml` 读取 Worker 名称与 D1 数据库名，生成临时 `worker/wrangler.full.ci.toml` 并注入真实 `database_id`
- **拆分部署手动备用链路**：`.github/workflows/deploy.yml`
  - GitHub Actions 名称：`Manual Split Pages + Worker Deploy`
  - 只在确实需要保留 `Pages + Worker` 拆分拓扑时使用

建议在推送前于本地执行 `npm run verify:release` 作为预检；`deploy-worker-only.yml` 也会在发布前再次强制执行同一 gate。

完整运行说明见本地 `docs/release-runbook.md`（本地文档工作区，不入库）。

#### 0) Cloudflare 侧准备（一次性）

> 说明：工作流会在 CI 中自动确保：
>
> - 直接全栈发布链路会按 `worker/wrangler.full.toml` 中的 `name` / `database_name` 自动定位部署目标，确保目标 D1 数据库存在（不存在则创建），并把 `database_id` 注入到临时 `worker/wrangler.full.ci.toml`（不会把真实 ID 提交到仓库）
> - （仅拆分部署）Pages 项目 `flares3-pages` 存在（不存在则创建）
>
> ⚠️ 前提：`CLOUDFLARE_API_TOKEN` 需要具备 **Workers 部署 / Pages 部署 / D1 Edit** 权限，否则无法 list/create/execute。

1. 配置 Worker 运行时变量 / Secrets（生产环境）
   - 位置：Cloudflare Dashboard -> Workers & Pages -> Workers -> `flares3-worker`（拆分部署）/ `flares3-spa`（单 Worker 全栈） -> Settings/Variables
   - 建议配置：
     - `BOOTSTRAP_ADMIN_USER`：普通变量（非敏感）
     - `BOOTSTRAP_ADMIN_PASS`：Secret（敏感，强密码）
     - `R2_MASTER_KEY`：Secret（32 字节 base64；需要长期保持不变）。
     - `AUTH_TOKEN_SECRET`：Secret（认证签名密钥；必填，不要与 `R2_MASTER_KEY` 共用）。
     - GitHub Actions 部署流程会校验上述两个 Worker Secret 是否存在；若不存在会直接失败，不会自动生成。
     - ⚠️ 请在首次部署前手动配置该值，且一旦生成/设置后请勿随意修改，否则历史已保存的 R2 配置（存储在 D1 内的密钥密文）将无法解密。
   - ⚠️ `worker/.dev.vars` 仅用于本地 `wrangler dev`；生产环境不要提交/分享该文件。
   - R2 访问配置（Endpoint / Access Key / Secret Key / Bucket）请部署后访问 `/setup` 在 UI 中创建/管理（写入 D1）。
   - 非敏感配置（可在 `worker/wrangler.toml` 的 `[vars]` 调整）：`MAX_FILE_SIZE`、`TOTAL_STORAGE`

#### 1) GitHub 仓库配置（一次性）

位置：GitHub 仓库 -> Settings -> Secrets and variables -> Actions

- Secrets：
  - `CLOUDFLARE_API_TOKEN`（API Token 权限至少包含：Workers 部署、Pages 部署、D1 执行）
  - `CLOUDFLARE_ACCOUNT_ID`

> 获取方式：`CLOUDFLARE_API_TOKEN` 在 Cloudflare Dashboard -> My Profile -> API Tokens 创建；`CLOUDFLARE_ACCOUNT_ID` 可在 Cloudflare Dashboard 任意页面的 Account 信息处查看。
> 默认全栈发布链路直接读取 `worker/wrangler.full.toml` 中的 Worker 名称与 D1 数据库名，不需要额外配置 GitHub Environment variables。

#### 2) 触发部署

- **直接全栈发布**：推送到 `main` 会自动触发 `Deploy Worker Only`
  - 如需重跑同一版 `main`，也可以在 GitHub Actions 页面手动触发 `Deploy Worker Only`
- **拆分部署（Pages + Worker）**：在 GitHub Actions 页面手动触发 `Manual Split Pages + Worker Deploy`

#### 3) 部署流程做了什么

`deploy.yml` 会依次执行：

1. 安装依赖（`worker/`、`frontend/`）
2. 确保 D1 数据库 `flares3-db` 存在（不存在则创建），并生成临时 `worker/wrangler.ci.toml`（注入 `database_id`）
3. 确保 Pages 项目 `flares3-pages` 存在（不存在则创建；仅拆分部署需要）
4. `npm run audit:prod` / `npm run lint` / `npm run typecheck` / `npm run test` / `npm run build`
5. 补齐历史 D1 缺失列：`node ./scripts/reconcile-legacy-d1-columns.mjs --config wrangler.ci.toml --database DB --remote`
6. 应用版本化 migration：`wrangler --config wrangler.ci.toml d1 migrations apply DB --remote`
7. 部署 Worker：`wrangler --config wrangler.ci.toml deploy`
8. 部署 Pages：`wrangler pages deploy ../frontend/dist --project-name=flares3-pages --branch=$GITHUB_REF_NAME`（工作流仅在 `main` 运行）

`Deploy Worker Only` 会依次执行：

1. 安装依赖（`worker/`、`frontend/`）
2. 执行 `npm run verify:release`（包含生产依赖审计、lint、format:check、typecheck、test、build、worker dry-run；失败则停止发布）
3. 从 `worker/wrangler.full.toml` 解析 `name` / `database_name`，自动确保目标 D1 存在，并生成临时 `worker/wrangler.full.ci.toml`（注入真实 `database_id`）
4. 校验目标 Worker 已存在 `R2_MASTER_KEY` 与 `AUTH_TOKEN_SECRET`
5. 补齐历史 D1 缺失列：`node ./scripts/reconcile-legacy-d1-columns.mjs --config wrangler.full.ci.toml --database DB --remote`
6. 应用版本化 migration：`wrangler --config wrangler.full.ci.toml d1 migrations apply DB --remote`
7. 部署全栈 Worker：`wrangler --config wrangler.full.ci.toml deploy`

> 建议在推送前自行执行 `npm run verify:release`；部署 workflow 会再次执行，作为发布前阻塞步骤。

### 部署后操作

- **拆分部署（Pages + Worker）**：在 Cloudflare Dashboard 绑定 Worker 路由（指向 `flares3-worker`）：
  - `/api/*` -> `flares3-worker`
  - `/s/*` -> `flares3-worker`
  - `/f/*` -> `flares3-worker`
  - `/t/*` -> `flares3-worker`
- **单 Worker 全栈部署（Worker Only）**：绑定 Worker 路由（指向 `flares3-spa`）：
  - `/*` -> `flares3-spa`
- 登录后在 `/setup` 完成 R2 配置

### R2 CORS（必须）

前端直传依赖 R2 CORS 配置，否则上传会失败。生产环境请将 `AllowedOrigins` 收敛为你的实际域名。

示例配置：

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:18786",
      "http://127.0.0.1:18786",
      "http://localhost:18787",
      "http://127.0.0.1:18787",
      "https://*.pages.dev",
      "https://*.workers.dev"
    ],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length"],
    "MaxAgeSeconds": 3600
  }
]
```

## 说明

- 管理员账号通过 `BOOTSTRAP_ADMIN_USER/PASS` 初始化，仅在 `users` 为空时执行。
- 上传时可配置下载是否需要登录。
- 删除用户将触发文件批处理清理（Cron）。
