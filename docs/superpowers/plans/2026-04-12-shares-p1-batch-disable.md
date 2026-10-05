# Shares P1 Batch Disable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `/shares` 增加当前页多选与批量关闭能力，降低站长和普通用户处理多条分享记录时的重复操作成本。

**Architecture:** 前端直接在 `Shares.vue` 复用 `Audit.vue` 的“表头/行 checkbox + 顶部批量按钮 + 确认弹窗”模式，不改通用 `Table`。批量关闭继续复用现有单条分享关闭接口，采用 `Promise.allSettled` 汇总成功/失败结果，并在完成后刷新列表、清空选择。

**Tech Stack:** Vue 3 + Vite、Vue I18n、Axios、Node test

---

## 范围确认

**本轮包含：**

- `/shares` 当前页行选择
- 表头当前页全选 / 取消全选
- 顶部“批量关闭（N）”按钮
- 批量关闭二次确认
- 批量关闭成功 / 部分成功 / 失败提示
- 最小必要的前端单测与构建验证

**本轮明确不做：**

- 跨页选择
- 全站全选
- 批量复制链接
- 批量重生成一次性分享
- 新增后端批量关闭接口
- 改造通用 `frontend/src/components/ui/table/Table.vue`
- git commit / branch / reset / push（按当前用户要求，计划与执行均不包含）

## 文件结构与职责

### 修改前端文件

- `frontend/src/views/Shares.vue`：增加选择状态、checkbox 列、批量关闭按钮、批量确认与执行逻辑。
- `frontend/src/utils/shares.js`：补充批量关闭所需的纯函数，保持 `Shares.vue` 逻辑聚焦。
- `frontend/tests/shares-utils.test.js`：覆盖新增纯函数。
- `frontend/src/locales/zh-CN/pages/shares.js`：补中文文案。
- `frontend/src/locales/en-US/pages/shares.js`：补英文文案。

### 参考文件

- `frontend/src/views/Audit.vue`：当前页 checkbox 选择与批量删除模式。
- `frontend/src/components/ui/table/Table.vue`：确认本轮不修改通用表格能力。

## 现有模式复用约束

- 选择交互对齐 `Audit.vue`：
  - `selectedIds`
  - `pageRowIds`
  - `allRowsSelected`
  - `selectAllIndeterminate`
- 确认弹窗继续复用 `Shares.vue` 已有 `Modal`
- 批量关闭只复用现有接口：
  - `api.deleteFileShare`
  - `api.deleteTextShare`
  - `api.deleteTextOneTimeShare`
- 不引入新的 composable、store、通用表格抽象

## 验证命令

- `node --test "frontend/tests/shares-utils.test.js"`
- `npm --prefix "frontend" run lint`
- `npm --prefix "frontend" run build`

## 推荐执行顺序

1. 先补纯函数测试
2. 实现 `shares.js` 纯函数
3. 改 `Shares.vue` 接入 checkbox 与批量关闭
4. 补国际化文案
5. 运行前端验证

---

### Task 1: 锁定批量关闭纯函数合同

**Files:**
- Modify: `frontend/tests/shares-utils.test.js`
- Reference: `frontend/src/utils/shares.js`
- Reference: `frontend/src/views/Shares.vue`

- [ ] **Step 1: 为行选择 key 写失败测试**

在 `frontend/tests/shares-utils.test.js` 增加最小场景：

- `file + resource_id` 能生成稳定 key
- `text_one_time + resource_id` 也能生成稳定 key
- 空类型或空资源 id 返回空字符串

- [ ] **Step 2: 为批量关闭可执行记录过滤写失败测试**

增加场景：

- 只返回当前 `selectedIds` 命中的记录
- 自动忽略 key 无效或记录不完整的项
- 保持返回顺序与当前页记录顺序一致

- [ ] **Step 3: 为批量关闭结果摘要写失败测试**

增加场景：

- 全部成功
- 部分成功
- 全部失败

断言返回的摘要元信息能驱动消息提示。

- [ ] **Step 4: 运行最小前端测试并确认当前失败**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js"
```

Expected:

- 新增批量关闭相关测试失败
- 失败原因是 `shares.js` 还未导出对应纯函数

### Task 2: 实现 `/shares` 批量关闭纯函数

**Files:**
- Modify: `frontend/src/utils/shares.js`
- Test: `frontend/tests/shares-utils.test.js`

- [ ] **Step 1: 增加行选择 key helper**

在 `frontend/src/utils/shares.js` 中新增最小纯函数，例如：

- `toShareSelectionKey(record)`

约束：

- 基于 `type + resource_id`
- 输出稳定字符串
- 缺少必要字段时返回空字符串

- [ ] **Step 2: 增加批量关闭记录筛选 helper**

新增最小纯函数，例如：

- `collectSelectedShares(items, selectedIds)`

约束：

- 只返回被选中的当前页记录
- 自动跳过无效记录
- 不做额外排序

- [ ] **Step 3: 增加批量结果摘要 helper**

新增最小纯函数，例如：

- `getBatchDisableFeedbackMeta({ total, successCount, failedCount })`

返回：

- 文案 key
- 插值参数

这样 `Shares.vue` 只负责 message 展示，不堆积条件分支。

- [ ] **Step 4: 运行测试确认通过**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js"
```

Expected:

- 新增纯函数测试通过
- 既有 `shares.js` 测试不回归

### Task 3: 在 `Shares.vue` 接入当前页选择模型

**Files:**
- Modify: `frontend/src/views/Shares.vue`
- Reference: `frontend/src/views/Audit.vue`
- Reference: `frontend/src/utils/shares.js`

- [ ] **Step 1: 增加选择状态**

在 `Shares.vue` 中加入：

- `selectedIds`
- `pageRowIds`
- `selectedIdSet`
- `allRowsSelected`
- `someRowsSelected`
- `selectAllIndeterminate`

并接入新纯函数生成行选择 key。

- [ ] **Step 2: 增加选择切换函数**

实现最小交互函数：

- `toggleSelectAll`
- `toggleRowSelection`
- `clearSelection`

约束：

- 仅维护当前页选择
- 翻页、搜索、刷新、改 page size 时都调用 `clearSelection`

- [ ] **Step 3: 在表格列最左侧增加 checkbox 列**

按 `Audit.vue` 模式在 `columns` 最前面插入选择列：

- 表头 checkbox 支持全选与 indeterminate
- 行 checkbox 支持单条勾选

约束：

- loading 或批量提交中禁用 checkbox
- 不影响现有 owner 列插入逻辑

### Task 4: 接入顶部批量关闭与统一确认弹窗

**Files:**
- Modify: `frontend/src/views/Shares.vue`
- Modify: `frontend/src/locales/zh-CN/pages/shares.js`
- Modify: `frontend/src/locales/en-US/pages/shares.js`
- Reference: `frontend/src/utils/shares.js`

- [ ] **Step 1: 在顶部筛选区增加批量关闭按钮**

新增：

- 危险态按钮
- 文案包含当前选择数量

约束：

- `selectedIds.length === 0` 时禁用
- `loading` 或批量提交中禁用

- [ ] **Step 2: 扩展确认动作元信息**

把现有确认动作从：

- 单条关闭
- 单条重生成

扩展为：

- 批量关闭

建议继续沿用 `pendingConfirmAction`，只扩展 `kind` 与元信息计算，不新增第二个 modal 状态。

- [ ] **Step 3: 接入批量关闭确认文案**

为批量关闭补充：

- 标题
- 正文
- 按钮文案

正文至少包含：

- 选中数量
- “关闭后链接不可访问”提示

- [ ] **Step 4: 实现批量关闭执行函数**

在 `Shares.vue` 中新增最小执行函数，例如：

- `performBatchDisableShares`

实现要求：

- 使用 `collectSelectedShares(items.value, selectedIds.value)` 获取目标记录
- 用 `Promise.allSettled` 执行现有单条关闭接口
- 统计 `successCount / failedCount`
- 按摘要 helper 输出 message
- 完成后关闭弹窗、清空选择、刷新列表

- [ ] **Step 5: 在提交中禁用行级和批量操作**

约束：

- 批量提交中，checkbox 禁用
- 行级“关闭分享 / 重生成 / 编辑”禁用
- 顶部批量关闭按钮 loading

### Task 5: 补齐国际化与页面细节

**Files:**
- Modify: `frontend/src/locales/zh-CN/pages/shares.js`
- Modify: `frontend/src/locales/en-US/pages/shares.js`
- Modify: `frontend/src/views/Shares.vue`

- [ ] **Step 1: 补批量关闭文案**

在中英文语言包中加入：

- `shares.actions.disableSelected`
- `shares.confirm.batchDisableTitle`
- `shares.confirm.batchDisableMessage`
- `shares.messages.batchDisableSuccess`
- `shares.messages.batchDisablePartial`
- `shares.messages.batchDisableFailed`

- [ ] **Step 2: 调整页面空态与交互细节**

检查：

- 无数据时不显示异常选择态
- 选择列宽度合理
- 顶部按钮在换行布局下不挤压输入框

必要时只做最小样式补充。

### Task 6: 全量验证

**Files:**
- Verify only

- [ ] **Step 1: 运行前端单测**

Run:

```bash
node --test "frontend/tests/shares-utils.test.js"
```

Expected:

- 所有 `shares-utils` 测试通过

- [ ] **Step 2: 运行前端 lint**

Run:

```bash
npm --prefix "frontend" run lint
```

Expected:

- 无 lint 错误

- [ ] **Step 3: 运行前端 build**

Run:

```bash
npm --prefix "frontend" run build
```

Expected:

- 构建通过
- `/shares` 页面相关改动无编译错误
