import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../frontend/src/components/dashboard/JobRunsPanel.vue",
    import.meta.url,
  ),
  "utf8",
);

test("JobRunsPanel 每行提供运行按钮并向上抛出 run 事件", () => {
  assert.match(
    source,
    /import Button from '\.\.\/ui\/button\/Button\.vue'/,
    "运行按钮应复用通用 Button 组件",
  );
  assert.match(
    source,
    /const emit = defineEmits\(\[['"]run['"]\]\)/,
    "组件应声明 run 事件由父级 Dashboard 处理手动触发",
  );
  assert.match(
    source,
    /@click="emit\('run', run\.jobName\)"/,
    "运行按钮点击应抛出 run 事件并携带 jobName",
  );
});

test("JobRunsPanel 运行中状态由 runningJob prop 驱动，互斥禁用其他行", () => {
  assert.match(
    source,
    /runningJob:\s*\{\s*type:\s*String/,
    "应接收 runningJob prop 表示当前正在运行的任务名",
  );
  assert.match(
    source,
    /:loading="runningJob === run\.jobName"/,
    "当前行运行时按钮应进入 loading 态",
  );
  assert.match(
    source,
    /:disabled="Boolean\(runningJob\)"/,
    "任一任务运行中时应禁用全部运行按钮，避免并发触发",
  );
});

test("JobRunsPanel 运行按钮文案走 dashboard.jobs i18n 键", () => {
  for (const key of ["run", "running", "runAria"]) {
    assert.match(
      source,
      new RegExp(`dashboard\\.jobs\\.${key}`),
      `缺少 i18n 键 dashboard.jobs.${key} 的引用`,
    );
  }
});
