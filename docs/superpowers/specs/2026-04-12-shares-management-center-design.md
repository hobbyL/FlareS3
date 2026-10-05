# /shares 独立分享管理中心设计

**目标**

补齐当前项目缺失的“统一分享管理入口”，让站长与普通用户都能在 `/shares` 中集中查看和管理分享，而不是分别回到文件页、文档页和二维码弹窗里处理。

**确认语义**

- 第一版覆盖三类分享：
  - 文件分享 `file_shares`
  - 文档分享 `text_shares`
  - 一次性文档分享 `text_one_time_shares`
- 普通用户只能查看和管理自己的分享；管理员可查看全站分享，并按用户筛选。
- `/shares` 是侧边栏一级导航，采用单一统一列表，不做主 Tab 分页。
- 第一版只展示“已经存在的分享记录”；未创建分享的文件/文档不进入该页面。
- 第一版只做基础操作：
  - 复制链接
  - 打开链接
  - 关闭分享
  - 编辑配置时复用现有分享弹窗
- 筛选范围控制为：
  - 类型
  - 状态
  - 管理员额外支持所属用户筛选
- 不做历史记录。
- 普通文件分享 / 文档分享关闭后沿用现状，物理删除记录并从列表消失。
- 一次性文档分享沿用现状，只保留每篇文档的一条当前记录，通过 `expires_at` / `consumed_at` 判断状态。

## 范围

- 新增统一分享列表页 `/shares`
- 新增统一分享列表后端接口
- 为一次性文档分享补齐“关闭当前分享”能力
- 复用现有文件分享、文档分享、一键分享生成能力与弹窗
- 补充前后端回归测试

## 不在本轮范围

- 分享历史记录
- 批量关闭、批量复制等批量操作
- 关键词搜索、时间范围筛选
- 在 `/shares` 中直接展示未分享资源
- 重写 `FileShareModal` / `TextShareModal` / `TextQrModal`
- 新增分享统计看板或运营报表

## 方案对比

### 方案 A：前端从现有资源列表接口自行拼装分享信息

优点：

- 后端改动少

缺点：

- 文件/文档列表会产生额外 N+1 分享请求
- 一次性分享当前没有独立列表接口，前端无法自然拼装
- 权限、状态和分页难统一

### 方案 B：新增后端聚合接口，前端消费统一分享模型

优点：

- 权限、状态和分页都在后端统一收口
- 前端只维护一个列表模型，结构清晰
- 可以最大化复用现有分享弹窗与操作接口

缺点：

- 需要补一层聚合查询与少量状态映射
- 需要为一次性分享增加删除接口

### 方案 C：三个独立页面分别管理三类分享

优点：

- 初看实现直接

缺点：

- 不是独立管理中心
- 筛选、状态、权限、空态实现重复
- 后续扩展成本更高

**结论：采用方案 B。**

## 详细设计

### 1. 页面与导航

新增前端路由 `/shares`，挂入侧边栏一级导航，权限要求为 `requiresAuth: true`。

导航策略：

- 普通用户可见并可进入
- 管理员同样可见
- 不新增管理员专属导航分支，避免破坏当前“共享功能对全体登录用户开放”的产品语义

### 2. 统一列表模型

后端返回统一记录结构，前端不再感知底层三张表的差异。建议统一字段：

- `type`：`file` / `text` / `text_one_time`
- `resource_id`
- `resource_name`
- `owner_id`
- `owner_username`
- `share_code`
- `share_url`
- `status`
- `views`
- `max_views`
- `has_password`
- `expires_at`
- `consumed_at`
- `created_at`
- `updated_at`

其中：

- 文件分享和普通文档分享的 `views / max_views / has_password` 可直接映射现有字段
- 一次性分享没有访问次数和密码能力，这些字段返回空值或约定默认值

### 3. 状态模型

前端显示状态统一为：

- `active`：当前可访问
- `expired`：已过期
- `exhausted`：访问次数已耗尽，仅普通分享存在
- `consumed`：一次性链接已消费

状态推导规则：

- 文件分享 / 文档分享
  - `expires_at <= now` -> `expired`
  - `max_views > 0 && views >= max_views` -> `exhausted`
  - 其他 -> `active`
- 一次性文档分享
  - `consumed_at IS NOT NULL` -> `consumed`
  - `expires_at <= now` -> `expired`
  - 其他 -> `active`

说明：

- 普通分享“已关闭”不建状态，因为当前接口删除后记录不存在
- `/shares` 第一版中的“看全部状态”语义，落地为：展示所有仍然存在的分享记录，包括有效、过期、耗尽、已消费

### 4. 后端接口设计

#### 4.1 新增统一列表接口

新增 `GET /api/shares`。

建议参数：

- `page`
- `limit`
- `type`
- `status`
- `owner_id`（仅管理员可用）

建议返回：

- `items`
- `page`
- `limit`
- `total`

实现策略：

- 分别从 `file_shares`、`text_shares`、`text_one_time_shares` 查询
- 关联 `files` / `texts` / `users`
- 过滤已删除文件、已删除文本、非 active owner 导致的无效展示噪音
- 在服务层完成统一映射与状态计算
- 再按筛选条件过滤并分页

第一版不追求复杂 SQL 抽象，保持 KISS：

- 可以在一个专用 route/service 中分别查询后合并
- 不为此引入新的通用 ORM 或过度抽象层

#### 4.2 新增一次性分享关闭接口

新增 `DELETE /api/texts/:id/one-time-share`。

语义：

- 删除当前文档的一次性分享记录
- 删除成功后，该分享从 `/shares` 列表消失
- 若记录不存在，返回幂等成功

这样 `/shares` 中三类分享都具备“关闭分享”闭环。

#### 4.3 复用现有接口

继续复用：

- `GET/POST/DELETE /api/files/:id/share`
- `GET/POST/DELETE /api/texts/:id/share`
- `POST /api/texts/:id/one-time-share`

这样可以避免在 `/shares` 第一版重复实现编辑逻辑。

### 5. 前端页面设计

新增 `Shares.vue`，结构分为两块：

1. 顶部轻量筛选区
2. 下方统一表格

建议表格列：

- 类型
- 名称
- 链接
- 状态
- 访问情况
- 过期时间
- 口令
- 所属用户（仅管理员）
- 更新时间
- 操作

操作策略：

- 文件分享
  - 复制链接
  - 打开链接
  - 编辑：复用 `FileShareModal`
  - 关闭：复用 `deleteFileShare`
- 文档分享
  - 复制链接
  - 打开链接
  - 编辑：复用 `TextShareModal`
  - 关闭：复用 `deleteTextShare`
- 一次性文档分享
  - 复制链接
  - 打开链接（仅 `active` 时）
  - 重新生成：复用 `createTextOneTimeShare`
  - 关闭：调用新增 `DELETE /api/texts/:id/one-time-share`

### 6. 复用与职责边界

保持现有职责边界，避免重写：

- `FileShareModal` 继续负责文件分享配置编辑
- `TextShareModal` 继续负责文档分享配置编辑
- `TextQrModal` 继续作为原文档页中的二维码展示入口
- `/shares` 页面只承担“集中展示 + 跳转/触发既有能力”

如需在 `/shares` 中展示一次性分享的当前链接，不直接复用 `TextQrModal` 作为主交互，因为它的现有行为是“打开即生成二维码”，更适合文档页场景；`/shares` 应直接以列表操作为主。

### 7. 空态与错误处理

页面空态区分：

- 当前用户没有任何分享记录
- 当前筛选条件下没有匹配结果

错误处理原则：

- 列表加载失败：展示统一错误提示并允许重试
- 单条操作失败：toast 提示，不破坏列表整体状态
- 对已失效的一次性链接执行“打开”时，前端可禁用按钮或在后端失败后提示

### 8. 权限与守卫

权限规则与当前项目保持一致：

- 路由级别：登录用户均可访问 `/shares`
- 数据级别：
  - 普通用户只能查询/操作自己的分享
  - 管理员可查询全部，并允许 `owner_id` 筛选
- 后端必须作为最终权限边界，前端仅做展示控制

## 影响文件

前端预计涉及：

- `frontend/src/router/index.js`
- `frontend/src/components/layout/BrutalSidebar.vue`
- `frontend/src/views/Shares.vue`
- `frontend/src/services/api.js`
- `frontend/src/locales/zh-CN/*`
- `frontend/src/locales/en-US/*`
- 可能新增少量分享状态/链接格式化 helper

后端预计涉及：

- `worker/src/index.ts`
- `worker/src/routes/textOneTimeShares.ts`
- `worker/src/routes/*` 或新增 `worker/src/routes/shares.ts`
- 可能新增一个分享聚合 service / helper

测试预计涉及：

- `worker/tests/*`
- `frontend/tests/*`

## 测试策略

优先按现有项目节奏补自动化回归：

### 后端

- 普通用户仅能拿到自己的分享
- 管理员可拿到全站分享并按 `owner_id` 过滤
- `type/status` 筛选正确
- 文件分享 / 文档分享状态映射正确
- 一次性分享 `active/expired/consumed` 状态映射正确
- `DELETE /api/texts/:id/one-time-share` 幂等可用

### 前端

- `/shares` 路由可访问，侧边栏导航可见
- 普通用户与管理员列展示不同
- 筛选器驱动列表正确刷新
- 不同类型记录的操作按钮行为正确
- 复用弹窗能正确打开并回写列表

### 联调

- 管理员与普通用户各自登录验证
- 三类分享都能从 `/shares` 完成复制、打开、关闭闭环
- 一次性分享重新生成后旧链接失效、新链接生效

## 风险

- 统一列表聚合如果全部在应用层合并，分页语义需要谨慎处理，避免先分页后合并造成结果失真。
- 一次性分享当前只有“生成”接口，没有独立查询接口；若前端交互设计失控，容易把 `/shares` 做成临时再生成入口而不是管理入口。
- 分享状态展示需要与现有弹窗和公开访问页语义保持一致，避免“列表显示可用但打开后失败”的认知偏差。
