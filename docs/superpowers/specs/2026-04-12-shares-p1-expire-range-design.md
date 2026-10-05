# /shares P1 过期时间范围筛选设计

**目标**

在不扩大 `/shares` 当前范围的前提下，为分享中心补齐站长视角最有价值的一项时间维度筛选能力：**按过期时间范围筛选分享**。

这样管理员和普通用户都可以更快定位：

- 即将过期的分享
- 某一时间段内到期的分享
- 已过期但仍留存于列表中的分享

## 本轮确认范围

**包含：**

- `/shares` 顶部筛选区新增“过期时间范围”控件
- 前端请求新增：
  - `expires_from`
  - `expires_to`
- 后端 `GET /api/shares` 支持按 `expires_at` 做时间范围过滤
- 前后端补充最小回归测试

**不包含：**

- 创建时间范围筛选
- 更新时间范围筛选
- 多组时间筛选并存
- 近 7 天 / 近 30 天等快捷预设
- 排序规则重构
- 高级筛选折叠面板

## 方案对比

### 方案 A：按过期时间范围筛选（推荐）

**优点：**

- 最贴合分享管理语义
- 对站长排查“快过期 / 已过期”记录最直接
- 复用项目内现成 `DateRangePicker` 模式即可落地

**缺点：**

- 仅覆盖一种时间维度，通用性不如“更新时间”

### 方案 B：按更新时间范围筛选

**优点：**

- 通用性更强

**缺点：**

- 对 `/shares` 的业务语义不如“过期时间”直接
- 站长筛“到期治理”时心智成本更高

### 方案 C：一次补齐创建 / 更新 / 过期三套时间筛选

**优点：**

- 理论上功能最全

**缺点：**

- 范围明显膨胀
- 筛选区复杂度上升
- 测试与交互成本不成比例

**结论：采用方案 A。**

## 详细设计

### 1. 前端筛选区

在 `frontend/src/views/Shares.vue` 现有筛选区中新增一个 `DateRangePicker`：

- 字段语义：`过期时间范围`
- 放置位置：`status` 后、owner 相关筛选前
- 仍沿用当前交互：
  - 点击“搜索”触发请求
  - 点击“刷新”保持当前筛选并重新加载
  - 切页、改 page size、搜索、刷新时仍清空当前页选择

前端本地筛选状态新增：

- `expires_from_date`
- `expires_to_date`

### 2. 前端参数构造规则

延续 `Users.vue` / `Files.vue` 的日期范围模式，但把转换逻辑收口到 `frontend/src/utils/shares.js` 中，保持 `Shares.vue` 只负责页面编排。

请求参数定义：

- `expires_from`
- `expires_to`

转换规则：

- 日期控件值仍使用 `YYYY-MM-DD`
- `expires_from` 转为所选开始日期的本地 `00:00:00` 对应 ISO
- `expires_to` 转为结束日期次日 `00:00:00` 对应 ISO
- 使用**左闭右开**区间：`expires_at >= expires_from && expires_at < expires_to`
- 仅选择一天时，自动补齐为该自然日区间
- 若开始日期晚于结束日期，前端自动交换

### 3. 后端接口扩展

扩展现有 `GET /api/shares`，在 `worker/src/routes/shares.ts` 的参数解析中新增：

- `expires_from`
- `expires_to`

`route` 仍只负责：

- 解析 query string
- 归一化参数
- 透传给 `listShareItems`

不新增新路由，不新增独立 service，不改变现有鉴权方式。

### 4. 后端过滤语义

在 `worker/src/services/shares.ts` 聚合出统一分享模型后，新增过期时间范围过滤。

过滤规则：

- 仅当传入 `expires_from` 或 `expires_to` 时启用该过滤
- `item.expires_at` 为空时：
  - 在**未启用**时间范围筛选时，仍正常显示
  - 在**启用**时间范围筛选时，视为**不匹配**
- 当同时存在 `expires_from`、`expires_to` 时：
  - `expires_at >= expires_from`
  - `expires_at < expires_to`
- 仅存在 `expires_from` 时：
  - `expires_at >= expires_from`
- 仅存在 `expires_to` 时：
  - `expires_at < expires_to`

推荐保持当前整体过滤顺序：

1. 权限过滤
2. `owner_id`（仅管理员）
3. `q`
4. `type`
5. `status`
6. `expires range`
7. `updated_at DESC`
8. `page/limit`

### 5. 空态与筛选激活判断

`Shares.vue` 中 `hasActiveFilters` 需要把过期时间范围纳入判断。

这样当用户设置了时间范围但没有结果时，仍显示“当前筛选条件下没有匹配结果”，而不是“暂无分享”。

### 6. 文案与国际化

需要补充 `/shares` 中英文文案：

- `shares.filters.expiresAt`

本轮不新增额外说明文案，不扩展 tooltip，保持最小实现。

### 7. 代码职责边界

#### 前端

- `Shares.vue`
  - 新增筛选 UI
  - 维护筛选状态
  - 继续调用 `buildSharesQueryParams`
- `shares.js`
  - 负责日期范围到接口参数的纯转换
  - 保持可测试，避免日期拼装散落在页面里

#### 后端

- `routes/shares.ts`
  - 解析 `expires_from` / `expires_to`
- `services/shares.ts`
  - 负责时间范围匹配逻辑

### 8. 测试策略

#### 后端

在 `worker/tests/shares-route.test.cjs` 增加场景：

- `expires_from + expires_to` 能过滤出命中区间的记录
- 单独 `expires_from` 能过滤出“到期时间晚于等于开始时间”的记录
- 启用时间范围筛选时，`expires_at = null` 的记录不会命中

#### 前端

在 `frontend/tests/shares-utils.test.js` 增加场景：

- `buildSharesQueryParams` 能生成 `expires_from / expires_to`
- 单日选择自动补齐完整自然日区间
- 开始日期晚于结束日期时会自动交换
- 非管理员下仍不会透传 `owner_id`

页面层继续通过：

- `lint`
- `build`

验证集成不回归。

## 风险与控制

### 风险 1：日期边界含义不一致

**控制：** 明确沿用项目现有模式，统一使用“开始日 00:00:00 + 结束日次日 00:00:00”的左闭右开区间。

### 风险 2：无过期时间的记录混入筛选结果

**控制：** 时间范围筛选启用时，`expires_at` 为空的记录直接排除。

### 风险 3：页面逻辑继续膨胀

**控制：** 日期参数转换下沉到 `frontend/src/utils/shares.js`，避免把日期处理代码继续堆进 `Shares.vue`。

## 验收标准

- `/shares` 可按过期时间范围筛选分享
- 单日范围、反向范围都能得到稳定结果
- 管理员 owner / 关键词 / 类型 / 状态筛选与时间范围可组合使用
- 启用时间范围筛选时，无过期时间的记录不会误命中
- 现有搜索、确认、批量关闭等能力不回归
