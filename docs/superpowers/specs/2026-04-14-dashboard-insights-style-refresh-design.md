# 仪表盘 Insights 视觉精修设计

**目标**

在已完成轻量 `insights` 区的基础上，继续提升仪表盘的完成度与高级感，但不改变页面信息架构、不扩张功能范围、不引入新的图表体系。此次精修的核心是让页面从“功能已具备”提升到“视觉节奏成熟、层级更稳、与当前项目主题一致”。

**范围**

- 精修 [`frontend/src/components/dashboard/DashboardInsights.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/components/dashboard/DashboardInsights.vue) 的视觉层级、留白、边框、字重与局部区块组织方式。
- 必要时微调 [`frontend/src/views/Dashboard.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/views/Dashboard.vue) 的页面间距，使 `OverviewCards` 与 `DashboardInsights` 的整体节奏更协调。
- 保持现有 [`frontend/src/utils/adminDashboard.js`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/utils/adminDashboard.js) 的数据口径与派生模型不变，只消费既有展示模型。
- 补充或调整测试，锁定结构和布局边界，避免视觉优化引发布局回退。

**非目标**

- 不新增后端接口。
- 不引入图表库。
- 不新增 hover 解释层、下钻交互、额外按钮或新的操作入口。
- 不扩展新的指标模块，不恢复已移除的任务面板或风险面板。
- 不改动 `buildDashboardInsightsModel` 的业务口径。

**当前上下文**

1. 当前仪表盘已采用“两层结构”：
   - 顶部 [`OverviewCards.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/components/dashboard/OverviewCards.vue) 负责基础概览
   - 下方 [`DashboardInsights.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/components/dashboard/DashboardInsights.vue) 负责轻量图形化与运行健康
2. `DashboardInsights` 当前已包含：
   - 左侧 `用户状态` 环图与图例
   - 右侧 `运行健康` 卡，包含上传配置状态和文件预警
3. 当前版本的主要问题不是信息不足，而是视觉表达仍偏“功能完成态”：
   - 主次关系还不够稳
   - 右侧内容略显松散
   - 留白与分区节奏不统一
   - 标题、副标题、数值之间的字重关系还不够成熟
4. 用户已明确选择视觉方向 `方向 1：更克制`，原因是该方向与当前项目整体主题最一致。

**已确认的视觉方向**

本次采用“更克制”的视觉路线。

方向特征：

- 更干净
- 更少色块
- 更低饱和
- 更像成熟数据产品，而不是展示型大屏

选择该方向的原因：

- 与当前项目已建立的后台主题一致，迁移成本最低。
- 可以提升精致度，但不会破坏现有页面的工具属性。
- 视觉风险更低，不容易因局部强化而造成整体风格割裂。

本方向对应的概念稿见：

- [`docs/superpowers/mockups/2026-04-14-dashboard-insights-style-options.svg`](/Users/mhp/Documents/workspace/wj/github/flares3/docs/superpowers/mockups/2026-04-14-dashboard-insights-style-options.svg)

**设计**

1. **整体视觉基调**

`DashboardInsights` 保持当前双列信息结构，不新增图形种类，不改变模块顺序，只做视觉层级重组。

整体气质调整为：

- 依赖留白建立节奏
- 依赖边框和浅分隔建立结构
- 依赖字重和字号差异建立主次
- 不依赖高饱和彩色块营造“高级感”

页面整体应表现为“安静、克制、专业”，与当前项目主题保持连续性。

2. **布局与节奏**

桌面端仍保持左主右辅双列：

- 左侧：`用户状态`
- 右侧：`运行健康`

但主次关系会更明确：

- 左侧卡片承担主要视觉重心
- 右侧卡片提高内容密度，减少空白发虚的问题

间距节奏统一收敛到稳定的间隔体系，优先使用较规整的 `8 / 12 / 16` 级差，减少局部忽松忽紧的观感。

3. **用户状态卡**

用户状态卡继续作为主视觉区域，但视觉处理改为更稳重的表达。

改动方向：

- 标题区更精炼，避免只有一行裸标题造成顶部层级偏弱
- 环图线宽适度收窄，减轻当前偏粗重的观感
- 中心数字继续作为核心焦点，但总量标签明显弱化
- 图例区域从“普通列表”升级为对齐更稳定的指标行

图例行的目标特征：

- 左侧为圆点与名称
- 右侧为数值
- 使用更明确的对齐和细分隔来提升秩序感

颜色策略：

- 主色使用深墨色系
- 正向状态使用低饱和绿色
- 其他状态退回灰阶
- 避免强烈红绿对冲造成视觉噪声

4. **运行健康卡**

运行健康卡不改变内容结构，但改造其内部组织方式。

当前右侧信息会重构为单张统一卡片中的两个浅层分区：

- 上半部分：上传配置健康
- 下半部分：文件预警

调整目标：

- 让右侧看起来像一个完整面板，而不是两个松散模块堆叠
- 用浅底、细边框、弱分隔线建立结构
- 减少彩色大块，避免右侧比左侧更碎

上传配置区：

- 三段步骤条继续保留
- 步骤条会更细、更短、更像状态轨道
- 当前状态标签继续保留，但转为更克制的小型徽标视觉
- 配置数量和提示文案保持现有信息表达，不额外添加说明文字

文件预警区：

- 两个指标维持独立展示
- 统一做成尺寸一致的紧凑信息块
- 使用轻背景和一致节奏，而不是高对比警示块
- 预警语义保留，但不过度制造“报警面板”氛围

5. **标题与字体层级**

本次精修的重点之一是文字层级，而不是新增视觉装饰。

调整原则：

- 主标题更稳
- 数字更干净
- 副标题更弱
- 状态标签更轻

目标是让用户在不增加阅读负担的情况下，更快识别：

- 哪块是主信息
- 哪块是辅助说明
- 哪块是状态提示

6. **响应式行为**

本次不改动基础响应式策略，但会校正视觉节奏。

响应式要求：

- 宽屏下维持双列
- 中等宽度下右侧视觉占比适度收缩，减少空虚感
- 小屏下折叠为单列，阅读顺序保持先 `用户状态`、后 `运行健康`

同时需要避免这次样式调整再次触发此前出现过的“布局宽度适配不自然”问题。

7. **交互边界**

本次仅做展示优化，不新增任何交互行为。

明确保持不变：

- 环图仍为静态展示，不可点击
- 图例不增加筛选或联动
- 状态条不增加 tooltip
- 文件预警不新增跳转或下钻入口

此次目标是优化观感，不扩张功能。

8. **实现边界**

实现应尽量收敛在以下文件：

- [`frontend/src/components/dashboard/DashboardInsights.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/components/dashboard/DashboardInsights.vue)
- 必要时少量调整 [`frontend/src/views/Dashboard.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/views/Dashboard.vue)

以下内容保持不动：

- 后端接口
- 数据模型口径
- `DashboardInsights` 的核心模板结构
- 页面其他无关区域

9. **测试策略**

验证重点不是业务口径，而是结构和布局安全性。

应继续保留并执行：

- [`frontend/tests/dashboard-helpers.test.js`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/tests/dashboard-helpers.test.js)
- [`frontend/tests/dashboard-layout.test.js`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/tests/dashboard-layout.test.js)
- [`frontend/tests/dashboard-insights.test.js`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/tests/dashboard-insights.test.js)

必要时可微调测试断言，确保：

- 组件结构未被破坏
- 布局层级仍符合双列/单列预期
- 视觉优化未导致已有测试语义失效

最终验证命令：

- `node --test frontend/tests/dashboard-helpers.test.js frontend/tests/dashboard-layout.test.js frontend/tests/dashboard-insights.test.js`
- `node --test frontend/tests/*.test.js`
- `npm run build`

**验收标准**

- 页面视觉明显比当前更成熟，但不显浮夸
- 与现有项目主题保持一致，不出现风格跳脱
- 左侧主卡更有主次关系，右侧区域更整合
- 色彩使用更克制，页面噪声更少
- 现有数据展示口径、接口和交互行为保持不变
- 测试与构建继续通过

**风险与控制**

- 若边框、浅底、分隔线使用过多，页面可能变得过碎。
  - 控制方式：减少不必要的小容器，只保留真正用于建立层级的分区。
- 若颜色过于收敛，右侧信息可能失去辨识度。
  - 控制方式：通过字重、对齐和密度，而不是高饱和颜色，来保证可读性。
- 若环图存在感削弱过多，左侧主视觉会塌陷。
  - 控制方式：保留中心数字与环图结构，只降低噪声，不削弱核心识别。

**后续计划衔接**

本设计批准后，下一步只需要输出实现计划，并按计划执行视觉精修，不再进行新的功能讨论。
