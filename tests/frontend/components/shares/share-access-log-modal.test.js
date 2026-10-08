import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../frontend/src/components/shares/ShareAccessLogModal.vue",
    import.meta.url,
  ),
  "utf8",
);

test("ShareAccessLogModal 按 shareType/shareId 分页拉取访问记录", () => {
  assert.match(
    source,
    /api\.getShareAccesses\(shareType, shareId, \{ page: page\.value \}\)/,
    "加载访问记录应调用 api.getShareAccesses 并携带页码",
  );
  assert.match(
    source,
    /watch\(\s*\(\)\s*=>\s*props\.show[\s\S]*\{\s*immediate:\s*true\s*\}/,
    "props.show watcher 需要 immediate: true，否则 v-if 首次挂载不会加载访问记录",
  );
  assert.match(
    source,
    /watch\(\s*\(\)\s*=>\s*\[props\.shareType,\s*props\.shareId\]/,
    "shareType 或 shareId 变化时应重置页码并重新加载",
  );
  assert.match(
    source,
    /:show-page-size="false"/,
    "分页器应隐藏每页数量选择（limit 固定）",
  );
  assert.match(source, /page\.value = 1/, "重新打开或切换分享时应重置回第一页");
});

test("ShareAccessLogModal 结果列与五列结构对齐服务端契约", () => {
  for (const columnKey of ["time", "ip", "userAgent", "result", "path"]) {
    assert.match(
      source,
      new RegExp(`shares\\.access\\.columns\\.${columnKey}`),
      `缺少表头 i18n 键 shares.access.columns.${columnKey}`,
    );
  }

  for (const resultKey of [
    "ok",
    "rejectedPassword",
    "expired",
    "exhausted",
    "notFound",
    "unknown",
  ]) {
    assert.match(
      source,
      new RegExp(`shares\\.access\\.results\\.${resultKey}`),
      `缺少结果 i18n 键 shares.access.results.${resultKey}`,
    );
  }

  assert.match(
    source,
    /if \(normalized === 'ok'\) return 'success'/,
    "ok 结果应映射 success 样式",
  );
  assert.match(
    source,
    /if \(normalized === 'rejected_password'\) return 'warning'/,
    "口令错误结果应映射 warning 样式",
  );
  assert.match(
    source,
    /if \(normalized === 'exhausted'\) return 'danger'/,
    "次数耗尽结果应映射 danger 样式",
  );
});

test("ShareAccessLogModal 文案走 i18n 且错误提示交给拦截器", () => {
  for (const key of ["title", "loading", "empty"]) {
    assert.match(
      source,
      new RegExp(`shares\\.access\\.${key}`),
      `缺少 i18n 键 shares.access.${key} 的引用`,
    );
  }
  assert.doesNotMatch(
    source,
    /message\.error\(/,
    "加载失败不应在组件内弹 toast（api 拦截器已统一提示，避免双 toast）",
  );
  assert.match(source, /items\.value = \[\]/, "关闭弹窗时应清空已加载的记录");
  assert.doesNotMatch(
    source,
    /template\s+#footer/,
    "右上角与遮罩均可关闭，无需底部关闭按钮",
  );
});
