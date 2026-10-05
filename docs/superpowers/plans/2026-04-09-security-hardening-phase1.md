# Security Hardening Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复第一批高优先级安全问题：收紧普通用户对 R2 配置的上传授权边界，并修复文本/文件分享 `max_views` 的并发绕过。

**Architecture:** 本阶段只动最小必要面。R2 上传授权通过一个后端统一策略函数收口，确保 `/api/r2/options` 与上传接口使用同一套规则；分享访问次数通过原子 SQL 消费，避免“先检查、后递增”的竞态。前端只做兼容性适配，不引入新功能。

**Tech Stack:** Cloudflare Workers、TypeScript、D1、Vue 3、Pinia、Axios

---

## 文件结构与职责

**新增文件**
- `worker/src/services/uploadConfigPolicy.ts`：统一定义“谁能看到哪些上传配置、谁能使用哪些上传配置”的策略函数。
- `worker/src/services/shareViewGuard.ts`：封装文本分享/文件分享的原子视图消费逻辑，返回可继续访问或已耗尽的结果。

**修改文件**
- `worker/src/routes/r2Configs.ts`：调用上传配置策略，仅返回当前用户可见的上传配置。
- `worker/src/routes/upload.ts`：调用上传配置策略，禁止普通用户使用未授权 `config_id`。
- `worker/src/routes/fileShares.ts`：改为原子消费文件分享次数。
- `worker/src/routes/textShares.ts`：改为原子消费文本分享次数。
- `frontend/src/components/upload/UploadPanel.vue`：兼容普通用户只能看到默认配置或有限配置的返回结果。
- `worker/package.json`：如果决定补自动化测试，则增加最小测试脚本/依赖；若保持现状则不修改。

**验证命令**
- `npm --prefix worker run typecheck`
- `npm --prefix worker run lint`
- `npm --prefix frontend run build`
- 手工验证：管理员与普通用户分别访问 `/api/r2/options`、上传文件、访问受限分享链接

> 注：根据仓库内 AGENTS/项目约束，本计划**不包含 git commit / branch / reset** 等步骤。

---

### Task 1: 提炼上传配置授权策略

**Files:**
- Create: `worker/src/services/uploadConfigPolicy.ts`
- Modify: `worker/src/routes/r2Configs.ts`
- Modify: `worker/src/routes/upload.ts`

- [ ] **Step 1: 写出策略边界**

在 `worker/src/services/uploadConfigPolicy.ts` 中定义最小策略接口：
- `listUploadConfigOptionsForUser(env, user)`
- `resolveUploadConfigForUser(env, user, requestedId)`

规则固定为：
- 管理员：可看到并使用全部可用 R2 配置。
- 普通用户：
  - 只返回默认上传配置（若无默认，则回退到当前可加载的 fallback 配置）。
  - 即使请求里传了其他 `config_id`，也必须被忽略或拒绝。

- [ ] **Step 2: 在 `/api/r2/options` 使用统一策略**

修改 `worker/src/routes/r2Configs.ts` 中 `listOptions`：
- 从请求里读取当前登录用户。
- 调用 `listUploadConfigOptionsForUser`。
- 对普通用户只返回可上传的最小配置集合；不要泄露全部配置清单。

预期行为：
- 管理员仍看到全部 options。
- 普通用户只看到 1 个默认可上传配置，或空集合 + 明确错误信息。

- [ ] **Step 3: 在上传接口强制执行同一策略**

修改 `worker/src/routes/upload.ts`：
- `presignUpload`
- `initMultipart`

都不要再直接使用：
- `requestedId ? loadR2ConfigById(...) : loadR2Config(...)`

改为统一调用 `resolveUploadConfigForUser(env, user, requestedId)`。

预期行为：
- 普通用户伪造 `config_id` 不能切换到管理员配置。
- 管理员保留原能力。

- [ ] **Step 4: 错误语义最小化**

对于普通用户传入非法/越权 `config_id`，统一返回：
- `403`：请求了当前用户无权使用的配置；或
- 服务端直接忽略非法 `config_id`，回落到默认配置。

推荐：**显式返回 403**，更利于审计与问题发现。

- [ ] **Step 5: 运行后端静态验证**

Run:
```bash
npm --prefix worker run typecheck
npm --prefix worker run lint
```

Expected:
- `typecheck` 通过
- `lint` 通过

---

### Task 2: 适配前端上传面板的最小配置返回

**Files:**
- Modify: `frontend/src/components/upload/UploadPanel.vue`

- [ ] **Step 1: 兼容“只有一个可选配置”或“没有配置”的情况**

修改 `UploadPanel.vue` 的 `onMounted` 初始化逻辑：
- 若返回 0 个可选配置，上传按钮应禁用并给出明确提示。
- 若返回 1 个可选配置，默认选中，不要求用户理解多配置概念。
- 不依赖前端做权限控制；前端仅展示服务端过滤后的结果。

- [ ] **Step 2: 保持请求结构兼容**

上传请求仍可带 `config_id`，但其值必须来自后端返回的 options；前端不再假设管理员/普通用户拿到的是同一份列表。

- [ ] **Step 3: 运行前端构建验证**

Run:
```bash
npm --prefix frontend run build
```

Expected:
- `vite build` 成功
- 上传面板无模板/响应式报错

---

### Task 3: 提炼分享次数原子消费守卫

**Files:**
- Create: `worker/src/services/shareViewGuard.ts`
- Modify: `worker/src/routes/fileShares.ts`
- Modify: `worker/src/routes/textShares.ts`

- [ ] **Step 1: 定义统一原子消费接口**

在 `worker/src/services/shareViewGuard.ts` 中提供两个最小函数：
- `consumeFileShareViewIfAllowed(db, shareId)`
- `consumeTextShareViewIfAllowed(db, shareId)`

内部使用单条 SQL：
```sql
UPDATE ...
SET views = views + 1, updated_at = ?
WHERE id = ? AND (max_views = 0 OR views < max_views)
```

返回：
- `consumed: true`：本次成功占用一次访问次数
- `consumed: false`：次数已耗尽或记录异常

- [ ] **Step 2: 文件分享改为“先原子消费，再跳转下载”**

修改 `worker/src/routes/fileShares.ts`：
- 删除当前单独的 `incrementFileShareViews` 调用路径。
- 在 `GET/POST` 成功访问分支中改为：
  1. 原子消费一次访问
  2. 若失败，返回 `410 可访问次数已用尽`
  3. 若成功，再生成预签名下载链接并重定向

注意：
- 对有密码和无密码两条路径都要统一使用原子消费。
- 不要改变现有密码校验、过期时间判断、页面渲染行为。

- [ ] **Step 3: 文本分享改为“先原子消费，再渲染内容”**

修改 `worker/src/routes/textShares.ts`：
- 删除当前单独的 `incrementShareViews` 成功路径。
- 在 GET/POST 成功查看分支中改为先调用原子消费。
- 若消费失败，返回现有风格的 `410` 页面。

- [ ] **Step 4: 保持展示元信息可接受的最终一致性**

当前页面顶部的 `已访问 x/y` 元信息来自前置查询；改成原子消费后，这个数字在当前响应内可能比数据库实际值少 1。

本阶段采用 **KISS** 方案：
- 允许展示元信息轻微滞后 1 次，不额外回查。
- 只确保授权边界和访问上限语义正确。

如果后续需要“页面内数字也绝对准确”，再单独做二期优化。

- [ ] **Step 5: 运行后端静态验证**

Run:
```bash
npm --prefix worker run typecheck
npm --prefix worker run lint
```

Expected:
- `typecheck` 通过
- `lint` 通过

---

### Task 4: 人工安全回归

**Files:**
- No code changes required; operate against local dev environment

- [ ] **Step 1: 普通用户 R2 配置授权验证**

检查点：
- 普通用户请求 `/api/r2/options` 只返回受限配置。
- 普通用户上传时抓包篡改 `config_id` 为其他有效配置 ID，应返回 `403` 或被服务端安全回退。
- 管理员上传时可继续选择全部配置。

- [ ] **Step 2: 文件分享 `max_views=1` 并发验证**

手工或脚本并发请求同一个 `/f/:code`：
- 预期只有 1 个请求成功拿到下载跳转
- 其余请求返回 `410`

- [ ] **Step 3: 文本分享 `max_views=1` 并发验证**

并发请求同一个 `/t/:code`：
- 预期只有 1 个请求成功看到内容
- 其余请求返回 `410`

- [ ] **Step 4: 回归现有基础能力**

确认未回归：
- 普通登录/登出
- 管理员查看配置、上传文件
- 文件分享密码校验
- 文本分享密码校验
- 一次性文本分享仍可正常消费

---

## 实施顺序建议

1. 先做 `Task 1`，把服务端授权边界收紧。
2. 再做 `Task 2`，让前端适配新的最小返回模型。
3. 再做 `Task 3`，修复分享并发绕过。
4. 最后执行 `Task 4` 人工安全回归。

## 非目标（本阶段不做）

- 不在本阶段处理依赖升级（`axios` / `dompurify` / `wrangler` 等），这属于下一独立批次。
- 不在本阶段实现上传配额原子保留。
- 不在本阶段引入完整自动化测试框架；若实现中发现缺少最小验证能力，再单独补一个轻量测试计划。
