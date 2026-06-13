import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getMountedPreviewKind,
  shouldProbeMountedPreviewAvailability,
} from "../../../../frontend/src/utils/mountPreview.js";
import {
  hasPipeTable,
  isLikelyMarkdown,
  renderMarkdown,
} from "../../../../frontend/src/utils/markdown.js";

const source = readFileSync(
  new URL(
    "../../../../frontend/src/components/mount/MountedObjectPreviewModal.vue",
    import.meta.url,
  ),
  "utf8",
);

const markdownTableExample = `### 5.1 初始化与构建

| 命令                         | 作用                                                         | 什么时候用                       |
| ---------------------------- | ------------------------------------------------------------ | -------------------------------- |
| \`/impeccable init\`           | 初始化项目设计上下文，生成 \`PRODUCT.md\`、\`DESIGN.md\` 和 live 配置 | 第一次在项目里使用 Impeccable    |
| \`/impeccable document\`       | 从现有代码中提取设计系统                                     | 老项目接入 Impeccable            |
| \`/impeccable shape <目标>\`   | 只做 UX/UI 方案规划，不直接写代码                            | 想先确认页面怎么设计             |
| \`/impeccable craft <目标>\`   | 先设计方案，再实现完整页面或功能                             | 新页面、新组件、新交互           |
| \`/impeccable extract <目标>\` | 把已有样式、token、组件沉淀成设计系统                        | 项目 UI 已经有重复模式，想规范化 |

示例：`;

test("getMountedPreviewKind 识别挂载对象支持的预览类型", () => {
  assert.equal(getMountedPreviewKind("cover.png"), "image");
  assert.equal(getMountedPreviewKind("manual.pdf"), "pdf");
  assert.equal(getMountedPreviewKind("notes.md"), "markdown");
  assert.equal(getMountedPreviewKind("server.log"), "text");
  assert.equal(getMountedPreviewKind("archive.zip"), null);
});

test("shouldProbeMountedPreviewAvailability 仅对媒体预览做可用性探测", () => {
  assert.equal(shouldProbeMountedPreviewAvailability("image"), true);
  assert.equal(shouldProbeMountedPreviewAvailability("pdf"), true);
  assert.equal(shouldProbeMountedPreviewAvailability("markdown"), false);
  assert.equal(shouldProbeMountedPreviewAvailability("text"), false);
  assert.equal(shouldProbeMountedPreviewAvailability(null), false);
});

test("MountedObjectPreviewModal 在渲染图片或 PDF 前先探测预览是否可用", () => {
  assert.match(
    source,
    /import[\s\S]*shouldProbeMountedPreviewAvailability[\s\S]*from '\.\.\/\.\.\/utils\/mountPreview\.js'/,
    "预览弹窗应复用 mountPreview util，避免媒体类型判断和探测策略分散维护",
  );
  assert.match(
    source,
    /const shouldProbe = shouldProbeMountedPreviewAvailability\(kind\)/,
    "预览弹窗应在 watch 中区分媒体探测与文本拉取流程",
  );
  assert.match(
    source,
    /Range:\s*`bytes=0-\$\{MAX_MEDIA_PREVIEW_PROBE_BYTES - 1\}`/,
    "图片和 PDF 预览应先用小范围 Range 请求确认对象可访问，避免直接渲染空白 iframe 或 broken image",
  );
});

test("MountedObjectPreviewModal 为媒体预览提供统一的加载与错误占位", () => {
  assert.match(
    source,
    /v-if="loading" class="preview-pane preview-placeholder"/,
    "图片和 PDF 预览加载期间应显示占位，而不是直接渲染空白容器",
  );
  assert.match(
    source,
    /v-else-if="error" class="preview-pane preview-placeholder"/,
    "图片和 PDF 预览失败时应显示明确错误，而不是只剩 broken image 或空白 iframe",
  );
});

test("共享 Markdown 渲染器将 pipe table 渲染为 table HTML", () => {
  const html = renderMarkdown(markdownTableExample);

  assert.match(html, /<div class="markdown-table-scroll"><table>/);
  assert.match(html, /<thead>/);
  assert.match(html, /<tbody>/);
  assert.match(html, /<code>\/impeccable init<\/code>/);
  assert.match(html, /<code>PRODUCT\.md<\/code>/);
});

test("共享 Markdown 识别器支持独立 pipe table", () => {
  const standaloneTable = `| 命令 | 作用 |
| --- | --- |
| init | 初始化 |`;

  assert.equal(hasPipeTable(standaloneTable), true);
  assert.equal(isLikelyMarkdown(standaloneTable), true);
});

test("fenced code block 内的 pipe table 不作为表格证据", () => {
  const fencedTable = `\`\`\`md
| 命令 | 作用 |
| --- | --- |
| init | 初始化 |
\`\`\``;

  assert.equal(hasPipeTable(fencedTable), false);
  assert.equal(isLikelyMarkdown(fencedTable), true);
});
