# 仪表盘轻量图表与运行健康区设计

**目标**

在现有仪表盘已精简为概览卡片的基础上，补充一组轻量可视化与运行健康信息，使页面信息密度更平衡，但不重新引入趋势面板、任务面板或复杂图表体系。

**范围**

- 修改 [`frontend/src/views/Dashboard.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/views/Dashboard.vue) 的页面结构，在概览卡片下方新增 `insights` 展示区。
- 新增前端仪表盘展示组件，用于承载用户状态分布和运行健康信息。
- 扩展 [`frontend/src/utils/adminDashboard.js`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/utils/adminDashboard.js) 的展示模型构建逻辑，统一计算图表与状态展示所需派生数据。
- 补充中英文文案与必要测试，锁定布局和派生口径。

**非目标**

- 不新增后端接口，不调整 [`worker/src/services/adminOverview.ts`](/Users/mhp/Documents/workspace/wj/github/flares3/worker/src/services/adminOverview.ts) 返回结构。
- 不引入新的图表库。
- 不恢复“最新执行任务”“运营风险”等已移除面板。
- 不实现任何趋势图、历史图、存储容量仪表盘。

**当前上下文**

1. [`frontend/src/views/Dashboard.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/views/Dashboard.vue) 当前仅在页面主体渲染 `OverviewCards`，由 `api.getAdminOverview()` 一次性拉取数据。
2. [`frontend/src/utils/adminDashboard.js`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/utils/adminDashboard.js) 当前只负责概览卡模型，没有图形化展示模型。
3. [`worker/src/services/adminOverview.ts`](/Users/mhp/Documents/workspace/wj/github/flares3/worker/src/services/adminOverview.ts) 当前只提供一份快照型数据：
   - 用户：`totalUsers`、`activeUsers`、`disabledUsers`
   - 文件：`totalFiles`、`expiringThisWeek`、`pendingDeleteQueue`
   - 存储：`usedSpace`、`usedSpaceFormatted`
   - 配置：`configCount`、`defaultConfigId`、`hasUploadConfig`
4. 当前数据缺少历史序列，因此不具备趋势图价值，只适合结构型和健康态表达。

**方案选择**

本次采用方案 B：在概览卡片下方新增一个两栏 `insights` 区块。

- 左侧为 `用户状态分布`，使用轻量环图表达结构占比。
- 右侧为 `运行健康`，使用状态条与紧凑指标块表达上传配置和文件预警。

选择该方案的原因：

- 能明显缓解当前仪表盘“内容过少”的观感，但不会回到多面板堆叠状态。
- 使用现有快照数据即可完成，不需要扩后端。
- 只对真正适合图形表达的指标使用图表，避免为了丰富页面而制造误导。

**设计**

1. **页面布局**

`Dashboard.vue` 保持现有标题区、刷新按钮和概览卡片不变，在 `OverviewCards` 下新增 `DashboardInsights` 区块。

桌面端布局：

- 左侧主卡：`用户状态分布`
- 右侧辅卡：`运行健康`

移动端布局：

- 两个卡片折叠为单列顺序排列

该布局遵循当前页面的简洁节奏，不新增第三行独立图块，避免信息再次发散。

2. **用户状态分布**

数据来源：

- `totalUsers`
- `activeUsers`
- `disabledUsers`

派生规则：

- `otherUsers = max(totalUsers - activeUsers - disabledUsers, 0)`

展示规则：

- 使用 SVG 环图，不引入第三方库。
- 环图中心显示 `totalUsers`。
- 图例同时展示分类名称与数量，避免仅靠颜色传达。
- 当 `totalUsers = 0` 时显示空态环图，不展示误导性的百分比。

状态分段：

- 启用用户
- 禁用用户
- 其他用户

3. **运行健康**

运行健康卡拆为两个垂直区域。

上半部分：`上传配置健康`

- 数据来源：`hasUploadConfig`、`defaultConfigId`、`configCount`
- 状态优先级：
  - 未配置：`hasUploadConfig = false`
  - 缺默认：`hasUploadConfig = true && !defaultConfigId`
  - 已就绪：`hasUploadConfig = true && !!defaultConfigId`
- 展示方式：三段状态条 + 当前状态文案 + 配置数量
- 不使用饼图、环图或仪表盘，避免对离散状态过度图表化

下半部分：`文件预警`

- 数据来源：`expiringThisWeek`、`pendingDeleteQueue`
- 展示方式：两个独立的紧凑指标块
- `expiringThisWeek` 使用预警色强调
- `pendingDeleteQueue` 使用中性或信息色，不默认定义为异常

4. **数据口径约束**

以下口径必须在实现中显式保持：

- `totalFiles` 仅统计 `upload_status = 'completed'` 且未删除文件
- `expiringThisWeek` 统计 `pending`、`uploading`、`completed` 且未删除文件

因此本次设计中：

- 不做“七日内到期占总文件比例”
- 不做“待删队列占总文件比例”
- 不做“已用空间利用率”

这些图形在当前后端口径下会造成误读。

5. **组件边界**

- [`frontend/src/components/dashboard/OverviewCards.vue`](/Users/mhp/Documents/workspace/wj/github/flares3/frontend/src/components/dashboard/OverviewCards.vue) 保持职责不变，只负责顶部概览卡。
- 新增 `DashboardInsights` 组件，负责图形化展示和运行健康布局。
- 若需要拆分，可在 `dashboard` 目录下进一步拆出：
  - 用户状态环图子组件
  - 运行健康子组件

拆分原则：

- `OverviewCards` 负责纯数字概览
- `DashboardInsights` 负责图表和状态表达
- 工具函数负责业务派生
- 组件只消费格式化后的展示模型

6. **数据流**

- 继续由 `Dashboard.vue` 统一调用 `api.getAdminOverview()`
- 所有新展示都复用同一份 `overview.metrics` 与 `overview.setup`
- 不新增独立请求，不引入第二套 loading 状态
- `adminDashboard.js` 新增 helper，一次性产出：
  - 用户状态分布模型
  - 上传配置健康模型
  - 文件预警模型

这可以避免在组件模板中散落业务计算，符合 KISS 和 DRY。

7. **异常与空态**

- `totalUsers = 0` 时环图进入空态
- `otherUsers` 必须 `clamp` 为非负数
- `configCount = 0`、`defaultConfigId = null` 时按状态优先级降级展示
- `loading` 状态沿用当前页面 loading，不做局部 skeleton 体系扩展

8. **测试策略**

新增或补充最小必要测试：

- `adminDashboard.js` helper 单测
  - 用户分段计算正确
  - `otherUsers` 非负兜底正确
  - 上传配置状态优先级正确
- 仪表盘组件测试
  - 0 数据空态
  - 上传配置三种状态
  - 移动端单列布局的基础渲染约束

不新增 e2e，用源码级或组件级测试锁定结构即可。

**影响与风险**

- 页面信息量会增加，但若样式控制不当，右侧运行健康卡可能显得偏碎，需要通过留白和层级控制平衡。
- 环图如果只展示颜色而不展示数值，信息可读性会下降，因此图例必须保留数字。
- 当前后端数据仍然是快照型，后续若要做趋势图，需要新增历史维度接口或汇总表，不能在本设计上继续堆叠趋势能力。

**后续扩展边界**

如果后续要升级为更完整的运营仪表盘，应先补以下数据能力，再考虑新增图表：

- 用户新增/活跃趋势
- 文件增长趋势
- 存储增长趋势
- 定时任务历史成功率与耗时趋势

在这些数据补齐前，本设计应保持轻量，不继续扩大图表范围。
