# /shares P1 排序能力设计

**目标**

在不扩大 `/shares` 当前范围的前提下，为分享中心补齐最小可用的排序能力，优先解决站长“找到最先需要处理的分享”这一核心效率问题。

第一版排序聚焦三种顺序：

- 最近更新
- 即将过期优先
- 最晚过期优先

这样可以和现有的关键词、owner、类型、状态、过期时间范围筛选组合使用，形成更完整的治理闭环。

## 本轮确认范围

**包含：**

- `/shares` 顶部筛选区新增排序下拉
- 前端请求新增：
  - `sort_by`
  - `sort_order`
- 后端 `GET /api/shares` 支持最小排序白名单
- 过期时间排序时，`expires_at` 为空的记录统一排最后
- 前后端补充最小回归测试

**不包含：**

- 表头点击排序
- 多字段组合排序
- 排序偏好持久化
- “已过期优先”单独预设
- 更多字段排序（如访问量、owner、名称）
- 通用 `Table` 组件升级

## 方案对比

### 方案 A：单独加“即将过期优先”开关

**优点：**

- UI 最小

**缺点：**

- 扩展性差
- 与项目中已有 `/files` 排序模式不一致

### 方案 B：增加排序下拉（推荐）

候选项：

- 最近更新
- 即将过期
- 最晚过期

**优点：**

- 与 `/files` 的 `sort_key -> sort_by/sort_order` 模式一致
- 改动小，语义清晰
- 后续可平滑扩展更多排序项

**缺点：**

- 比单一 toggle 多一个筛选控件

### 方案 C：支持表头点击排序

**优点：**

- 交互直观

**缺点：**

- 需要改 `Table` 组件或表头交互协议
- 明显超出本轮最小范围

**结论：采用方案 B。**

## 详细设计

### 1. 前端交互

在 `frontend/src/views/Shares.vue` 顶部筛选区新增一个 `Select` 排序下拉。

排序项：

- `updated_at__desc`：最近更新
- `expires_at__asc`：即将过期
- `expires_at__desc`：最晚过期

默认值：

- `updated_at__desc`

本轮保持现有搜索节奏：

- 用户调整排序后，仍通过点击“搜索”按钮触发请求
- “刷新”沿用当前排序重新加载
- 不新增排序变更自动请求，避免页面行为突然变化

### 2. 前端参数构造

延续 `/files` 的轻量模式，在 `frontend/src/utils/shares.js` 中把：

- `filters.sort_key`

转换为：

- `sort_by`
- `sort_order`

规则：

- 空值时默认 `updated_at__desc`
- 如果 `sort_key` 不合法，则退回默认值
- 继续与现有 `q/type/status/owner_id/expires_from/expires_to` 一起输出

### 3. 后端接口扩展

扩展 `GET /api/shares`，在 `worker/src/routes/shares.ts` 中解析：

- `sort_by`
- `sort_order`

允许值白名单：

- `sort_by`
  - `updated_at`
  - `expires_at`
- `sort_order`
  - `asc`
  - `desc`

无效值回退到：

- `updated_at`
- `desc`

### 4. 排序语义

#### 4.1 最近更新

- `updated_at DESC`

这保持当前行为，避免对已有使用习惯造成破坏。

#### 4.2 即将过期优先

- `expires_at ASC`

但要特殊处理 `expires_at = null`：

- 所有无过期时间的分享统一排在最后

原因：

- 站长做过期治理时，最关心的是“有明确截止时间且快到期”的记录
- 若无过期时间记录混在前面，会干扰排序价值

#### 4.3 最晚过期优先

- `expires_at DESC`

同样要求：

- `expires_at = null` 统一排在最后

### 5. 后端实现位置

当前 `/shares` 是先聚合三类记录，再在内存中过滤和分页，因此本轮排序继续在 `worker/src/services/shares.ts` 中完成即可，不需要下沉到复杂 SQL 排序拼装。

建议在 service 中新增最小排序辅助函数：

- 归一化排序字段
- 比较两个分享项
- 对 `expires_at = null` 做统一尾部排序

并保持现有处理链顺序：

1. 权限过滤
2. owner
3. q
4. type
5. status
6. expires range
7. sort
8. page/limit

### 6. 稳定性与兜底

为了避免排序结果不稳定，建议：

- 主排序字段相等时，退回 `updated_at DESC`

这样能让：

- 相同过期时间的记录顺序更稳定
- `expires_at = null` 的记录也有确定顺序

### 7. 文案与国际化

新增 `/shares` 中英文文案：

- `shares.filters.sort`
- `shares.filters.sortUpdatedDesc`
- `shares.filters.sortExpiresAsc`
- `shares.filters.sortExpiresDesc`

本轮不新增 tooltip，不解释更复杂的排序规则，保持最小可理解。

### 8. 测试策略

#### 后端

在 `worker/tests/shares-route.test.cjs` 中增加：

- `sort_by=expires_at&sort_order=asc` 时，最早到期的记录排前
- `expires_at = null` 在过期排序时始终排最后
- `sort_by=expires_at&sort_order=desc` 时，最晚到期的记录排前

#### 前端

在 `frontend/tests/shares-utils.test.js` 中增加：

- `buildSharesQueryParams` 能从 `sort_key` 生成 `sort_by/sort_order`
- 非法 `sort_key` 回退到 `updated_at/desc`

页面层继续通过：

- `lint`
- `build`

验证不回归。

## 风险与控制

### 风险 1：过期排序时无过期时间记录插入中间，影响治理效率

**控制：** 明确 `expires_at = null` 在过期排序中统一排最后。

### 风险 2：排序值不受控，导致后端行为不可预期

**控制：** 前后端都做最小白名单和默认值回退。

### 风险 3：排序能力过度扩展

**控制：** 第一版只开放 `updated_at` 和 `expires_at` 两个字段。

## 验收标准

- `/shares` 可选择“最近更新 / 即将过期 / 最晚过期”三种排序
- 默认仍为最近更新
- 过期排序时 `expires_at` 为空的记录统一排最后
- 排序能与现有筛选条件组合使用
- 现有搜索、确认、批量关闭、过期时间范围筛选能力不回归
