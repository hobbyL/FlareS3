# 仪表盘文档与分享监控设计

**目标**

在现有仪表盘的轻量结构上，把“文档”和“分享”纳入同一套管理视角，但保持页面克制，不把 Dashboard 扩展成重运营大屏。

本轮目标不是单纯增加数字，而是让页面形成清晰分工：

- 顶部概览看规模
- `Insights` 看结构和风险

**已确认结论**

1. 文档与分享一起进入仪表盘。
2. 页面布局采用“顶部看规模，`Insights` 看风险”的混合方案。
3. 图形方案采用“方案 2”的变体：
   - 文档使用轻量更新结构图
   - 分享使用柱状图，不使用环形图
4. 保持当前项目主题的克制风格，不引入大面积彩色图块或独立大图表区。

相关概念稿：

- 总体布局参考 [`2026-04-14-dashboard-doc-share-layout-options.svg`](/Users/mhp/Documents/workspace/wj/github/flares3/docs/superpowers/mockups/2026-04-14-dashboard-doc-share-layout-options.svg)
- 图表表达总览 [`2026-04-14-dashboard-doc-share-chart-options.svg`](/Users/mhp/Documents/workspace/wj/github/flares3/docs/superpowers/mockups/2026-04-14-dashboard-doc-share-chart-options.svg)
- 最终选定方向 [`2026-04-14-dashboard-doc-share-chart-option-2.svg`](/Users/mhp/Documents/workspace/wj/github/flares3/docs/superpowers/mockups/2026-04-14-dashboard-doc-share-chart-option-2.svg)

**范围**

- 扩展 [`worker/src/services/adminOverview.ts`](/Users/mhp/Documents/workspace/wj/github/flares3/worker/src/services/adminOverview.ts) 的聚合结果，把文档和分享监控指标并入同一份仪表盘快照。
- 扩展 [`frontend/src/views/Dashboard.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/views/Dashboard.vue) 的默认数据结构，接住新增指标。
- 扩展 [`frontend/src/utils/adminDashboard.js`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/utils/adminDashboard.js) 的展示模型，统一生成顶部概览和 `Insights` 所需数据。
- 调整 [`frontend/src/components/dashboard/OverviewCards.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/components/dashboard/OverviewCards.vue) 与 [`frontend/src/components/dashboard/DashboardInsights.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/components/dashboard/DashboardInsights.vue) 的展示内容。
- 补充仪表盘相关文案与前端测试。

**非目标**

- 不新增独立的文档分析页或分享分析页。
- 不增加时间序列趋势图、折线图、面积图。
- 不引入图表库。
- 不增加点击下钻、筛选联动、tooltip 解释层。
- 不复用 `/shares` 列表接口做前端二次统计。
- 不在本轮引入“更多文档指标”“更多分享 KPI”的扩张式设计。

**当前上下文**

1. [`frontend/src/views/Dashboard.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/views/Dashboard.vue) 当前只消费一次 `api.getAdminOverview()` 返回的快照数据，不存在第二套仪表盘请求。
2. [`frontend/src/utils/adminDashboard.js`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/utils/adminDashboard.js) 已负责：
   - 顶部 `OverviewCards` 的数字卡模型
   - `DashboardInsights` 的用户状态与运行健康模型
3. [`worker/src/services/adminOverview.ts`](/Users/mhp/Documents/workspace/wj/github/flares3/worker/src/services/adminOverview.ts) 当前只返回用户、文件、存储和上传配置相关指标，还没有文档和分享聚合。
4. 文档数据来源于 [`dbSchema.ts`](/Users/mhp/Documents/workspace/wj/github/flares3/worker/src/services/dbSchema.ts#L30) 中的 `texts` 表，具备 `updated_at`、`deleted_at`，适合做“新近更新 / 较久未更新”的轻量结构表达。
5. 分享状态语义已经在 [`shares.ts`](/Users/mhp/Documents/workspace/wj/github/flares3/worker/src/services/shares.ts#L178) 和 [`shares.ts`](/Users/mhp/Documents/workspace/wj/github/flares3/worker/src/services/shares.ts#L190) 中形成现成规则：
   - 普通分享：`active / expired / exhausted`
   - 一次性分享：`active / expired / consumed`

**方案取舍**

### 方案 A：只加数字，不加图

优点：

- 实现最省
- 对现有布局影响最小

缺点：

- 文档和分享只是“被并入”，没有被真正区分表达
- Dashboard 的结构层次提升有限

### 方案 B：文档和分享都做轻图表

优点：

- 可以同时表达“规模”和“结构”
- 文档与分享不再只是新加两条数字
- 最符合“顶部看规模，Insights 看风险”的页面分工

缺点：

- 需要严格控制图形尺寸和视觉噪声

### 方案 C：只给分享做图，文档保留数字

优点：

- 风险较低

缺点：

- 文档仍然缺少结构层表达
- 两块内容的完成度不一致

**结论：采用方案 B，但将分享图由环形图改为柱状图。**

原因：

- 分享状态是离散状态对比，柱状图比环形图更直观，也更符合当前项目克制风格。
- 文档更适合展示“更新新鲜度分布”，适合保留轻量结构条。
- 两者都进入 `Insights`，但图形语义不同，不会显得机械重复。

**详细设计**

1. **顶部概览：看规模**

顶部概览继续复用 [`OverviewCards.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/components/dashboard/OverviewCards.vue) 的双指标卡模式，不单独新增新的图形区。

本轮新增一个概览卡，建议语义为“文档与分享”，包含两个指标：

- `totalTexts`：文档总数
- `activeShares`：活跃分享

这样做的原因：

- 复用现有卡片模型，改动最小
- 只把真正有“规模感”的指标放在顶部
- 避免把顶部卡片扩成 6 到 8 个分散小块

本轮不把以下指标放到顶部：

- `expiredShares`
- `exhaustedShares`
- `consumedShares`
- 文档更新桶数据

这些都属于结构或风险信息，应留在 `Insights`。

2. **文档指标设计**

文档部分只统计未删除记录：

- `totalTexts`：`deleted_at IS NULL`
- `textsUpdated7d`：最近 7 天更新
- `textsUpdated8To30d`：8 到 30 天内更新
- `textsStaleOver30d`：30 天以上未更新

文档图形表达：

- 不做折线趋势
- 不做环图
- 采用轻量分段条或横向结构条
- 同时展示三个桶的数值，避免用户只能看颜色

文档图的目标不是说明“走势”，而是说明“当前内容新鲜度结构”。

3. **分享指标设计**

分享指标以分享中心现有状态语义为准，聚合范围覆盖当前系统内的全部分享类型：

- 文件分享
- 文档分享
- 一次性文档分享

状态口径保持与分享中心一致：

- `active`
- `expired`
- `exhausted`
- `consumed`

本轮新增的核心指标：

- `activeShares`
- `expiredShares`
- `exhaustedShares`
- `consumedShares`

分享图形表达：

- 采用紧凑柱状图
- 只做状态量级对比
- 柱下保留简写状态标签
- 右侧或下方保留具体数值

不使用环图的原因：

- 分享状态是分类比较，不是占比讲述的最佳场景
- 柱状图更容易看出 `active` 与其他状态的量级差
- 在窄面板里也更利于排布

4. **Insights 布局**

[`DashboardInsights.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/components/dashboard/DashboardInsights.vue) 继续保留当前双列结构：

- 左侧主卡：用户状态
- 右侧辅卡：运行健康扩展区

右侧区块在现有基础上扩展为四个紧凑模块：

- 上传配置健康
- 文件预警
- 分享状态
- 文档更新结构

布局原则：

- 不拆成新的第三列
- 不把文档和分享移到左侧主视觉区
- 继续保持“左侧主视觉，右侧辅助面板”的秩序

这样可以让新增指标自然并入当前页面，不破坏已完成的 `Insights` 视觉体系。

5. **后端聚合策略**

后端只扩展 [`adminOverview.ts`](/Users/mhp/Documents/workspace/wj/github/flares3/worker/src/services/adminOverview.ts)，不新增新接口。

实现原则：

- 使用数据库聚合 SQL，避免把分享列表拉到内存再统计
- 口径尽量复用分享中心已有状态判断规则
- 指标都归入同一个 `metrics` 对象，延续现有前端消费方式

建议实现方式：

- 文档：使用一条聚合 SQL 完成 `totalTexts` 和三个更新时间桶统计
- 分享：使用聚合 SQL 分别统计普通分享与一次性分享，再在服务层合并
- 统计分享时需排除已删除资源，保持与实际可管理对象一致

状态优先级必须保持一致：

- 普通分享先判断 `expired`，再判断 `exhausted`
- 一次性分享先判断 `consumed`，再判断 `expired`

6. **前端模型边界**

[`Dashboard.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/views/Dashboard.vue) 只负责：

- 扩展默认 `metrics` 字段
- 保持单次请求与统一 loading

[`adminDashboard.js`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/utils/adminDashboard.js) 负责：

- 新增顶部概览卡模型
- 新增分享状态展示模型
- 新增文档更新结构模型
- 保持所有派生逻辑集中，不把计算散落到组件模板

[`DashboardInsights.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/components/dashboard/DashboardInsights.vue) 负责：

- 渲染分享柱状图
- 渲染文档更新结构条
- 保持现有用户状态主卡不变

7. **文案与命名**

需要补充仪表盘中英文文案，至少包括：

- 顶部卡标题
- 文档总数
- 活跃分享
- 分享状态
- 文档更新
- 最近 7 天
- 8 至 30 天
- 30 天以上未更新
- 已过期 / 已耗尽 / 已消费

文案风格保持当前 Dashboard 的后台表达，不做营销式语言。

8. **响应式要求**

- 宽屏下保持当前双列 `Insights`
- 中窄屏下右侧面板可自然变高，但不产生横向挤压错位
- 小屏下继续折叠为单列
- 新增图形必须在窄宽度下仍能看清标签和数字

9. **测试策略**

前端测试继续以现有仪表盘测试为主，至少覆盖：

- [`dashboard-helpers.test.js`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/tests/dashboard-helpers.test.js)
  - 新增文档桶分组
  - 新增分享状态模型
- [`dashboard-insights.test.js`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/tests/dashboard-insights.test.js)
  - 渲染分享状态区
  - 渲染文档更新区
- [`dashboard-layout.test.js`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/tests/dashboard-layout.test.js)
  - 新增模块后双列与单列结构仍成立

后端当前没有现成的 `adminOverview` 测试基线，本轮实现时应优先补一个最小聚合测试，至少锁定：

- 文档更新时间桶统计正确
- 普通分享与一次性分享状态聚合正确
- 已删除资源不会被统计进分享结果

**验收标准**

- 仪表盘顶部能看到文档与分享规模指标，但不会显得拥挤。
- `Insights` 中能看到分享状态柱状图和文档更新结构图。
- 分享图不使用环形图。
- 文档与分享新增内容不破坏当前用户状态主视觉。
- 所有新增指标都来自同一个 `/api/admin/overview` 快照，不新增二次请求。
- 页面仍保持当前项目的克制主题，不出现信息图式膨胀。
