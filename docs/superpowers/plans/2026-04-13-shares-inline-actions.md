# Shares Inline Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 调整分享页链接列与操作列布局，使链接按钮图标化且两列都保持单行显示。

**Architecture:** 保持现有 `Shares.vue` 列定义不变，仅收敛单元格渲染和 CSS 约束；通过本地化文案精简操作按钮长度；用前端源码级静态测试锁定布局与文案约束，避免 UI 回退。

**Tech Stack:** Vue 3、node:test、vue-i18n、现有 UI Button/Tooltip 组件

---

### Task 1: 为分享页单行布局补充失败测试

**Files:**
- Modify: `frontend/tests/list-table-ellipsis.test.js`
- Test: `frontend/tests/list-table-ellipsis.test.js`

- [ ] **Step 1: Write the failing test**

补充断言，要求：
- `Shares.vue` 的链接列按钮使用 `aria-label` 且仅渲染图标。
- `share-link-cell` 为单行布局。
- `share-link-buttons` 与 `action-buttons` 使用 `flex-wrap: nowrap`。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test frontend/tests/list-table-ellipsis.test.js`
Expected: FAIL，提示分享页源码未满足单行/图标约束。

- [ ] **Step 3: Write minimal implementation**

在 `frontend/src/views/Shares.vue` 中调整链接列渲染和样式，在语言包中精简操作文案。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test frontend/tests/list-table-ellipsis.test.js`
Expected: PASS

### Task 2: 运行回归验证

**Files:**
- Modify: `frontend/src/views/Shares.vue`
- Modify: `frontend/src/locales/zh-CN/pages/shares.js`
- Modify: `frontend/src/locales/en-US/pages/shares.js`

- [ ] **Step 1: Run focused frontend tests**

Run: `node --test frontend/tests/list-table-ellipsis.test.js frontend/tests/shares-utils.test.js`
Expected: PASS

- [ ] **Step 2: Run repo-level test entry if needed**

Run: `npm test`
Expected: PASS；若 worker 侧已有不相关失败，则至少确认前端新增断言通过并如实报告。
