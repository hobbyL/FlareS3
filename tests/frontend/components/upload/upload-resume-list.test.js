import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readComponent = (filename) =>
  readFileSync(
    new URL(
      `../../../../frontend/src/components/upload/${filename}`,
      import.meta.url,
    ),
    "utf8",
  );

const listSource = readComponent("UploadResumeList.vue");
const discardModalSource = readComponent("UploadResumeDiscardModal.vue");
const panelSource = readComponent("UploadPanel.vue");

test("续传列表是纯展示组件：不碰 api、不碰 localStorage", () => {
  for (const [name, source] of [
    ["UploadResumeList.vue", listSource],
    ["UploadResumeDiscardModal.vue", discardModalSource],
  ]) {
    assert.doesNotMatch(
      source,
      /from '(\.\.\/)+services\/api'/,
      `${name} 不应直接引入 api 服务`,
    );
    assert.doesNotMatch(
      source,
      /localStorage/,
      `${name} 不应直接读写 localStorage`,
    );
    assert.doesNotMatch(
      source,
      /uploadResume/,
      `${name} 不应直接依赖 uploadResume 工具`,
    );
  }
});

test("续传列表把动作全部 emit 给父组件，payload 为 fileId", () => {
  assert.match(
    listSource,
    /const emit = defineEmits\(\['resume', 'discard'\]\)/,
    "列表应声明 resume / discard 两个事件",
  );
  assert.match(
    listSource,
    /@click="emit\('resume', item\.fileId\)"/,
    "继续上传应把 fileId 回抛父组件",
  );
  assert.match(
    listSource,
    /@click="emit\('discard', item\.fileId\)"/,
    "放弃应把 fileId 回抛父组件",
  );
});

test("续传列表展示文件名、大小、分片进度与最后上传时间", () => {
  assert.match(listSource, /item\.filename/);
  assert.match(listSource, /formatBytes\(item\.size\)/);
  assert.match(listSource, /upload\.resume\.partsProgress/);
  assert.match(listSource, /formatDateTime\(item\.lastUploadAt\)/);
  assert.match(
    listSource,
    /:percentage="resolvePercentage\(item\)"/,
    "进度百分比应来自 uploadedParts / totalParts 的本地估算",
  );
  assert.match(
    listSource,
    /formatBytes: \{ type: Function, required: true \}/,
    "格式化函数应由父组件注入",
  );
});

test("续传列表动作按钮具备无障碍名称", () => {
  const ariaLabels = listSource.match(/:aria-label="[^"]+"/g) || [];
  assert.equal(ariaLabels.length, 2, "继续上传与放弃按钮都应带 aria-label");
  for (const label of ariaLabels) {
    assert.match(
      label,
      /item\.filename/,
      "无障碍名称应包含文件名以区分同屏的多条记录",
    );
  }
});

test("放弃确认弹窗保持父组件持有可见性与提交动作", () => {
  assert.match(
    discardModalSource,
    /@update:show="emit\('update:show', \$event\)"/,
    "弹窗可见性变更应回抛给 UploadPanel",
  );
  assert.match(discardModalSource, /emit\('cancel'\)/);
  assert.match(discardModalSource, /emit\('confirm'\)/);
  assert.match(
    discardModalSource,
    /:loading="discarding"/,
    "确认按钮应在放弃进行中显示 loading 以防重复提交",
  );
});

test("UploadPanel 承接续传副作用：composable + 隐藏 input + 条件渲染", () => {
  assert.match(
    panelSource,
    /useUploadResumeEntries\(\{ api, t, message \}\)/,
    "副作用应集中在 UploadPanel 注入的 composable 里",
  );
  assert.match(
    panelSource,
    /<UploadResumeList[\s\S]*v-if="visibleResumeEntries\.length > 0"/,
    "无有效记录时整块不渲染",
  );
  assert.match(
    panelSource,
    /<UploadResumeDiscardModal[\s\S]*v-if="discardTarget"/,
    "确认弹窗应按目标存在与否惰性渲染",
  );
  assert.match(
    panelSource,
    /ref="resumeInputRef"[\s\S]*hidden/,
    "续传需要隐藏 file input 让用户重新选择同一文件",
  );
  assert.match(
    panelSource,
    /event\.target\.value = ''/,
    "change 后必须复位 input，否则连续选同一文件不再触发事件",
  );
  assert.match(
    panelSource,
    /upload\.resume\.fileMismatch/,
    "文件不匹配时应给出错误提示",
  );
});

test("UploadPanel 按 activeItemId 刷新续传列表，而不是按条目终态", () => {
  assert.match(
    panelSource,
    /watch\(uploadQueue\.activeItemId, \(\) => \{\s*refreshResumeEntries\(\)/,
    "activeItemId 在队列 finally 里复位，严格晚于 deleteUploadProgress",
  );
  // cancelItem 同步把状态改成 cancelled，此时 runner 还没删 localStorage 记录，
  // 按状态刷新会把已放弃的记录重新读回列表（R4 僵尸条目）
  assert.doesNotMatch(
    panelSource,
    /watch\(settledQueueCount/,
    "不得按条目终态数量刷新：该时点早于进度记录删除",
  );
});
