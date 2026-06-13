import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../frontend/src/components/shares/SharesHeaderToolbar.vue",
    import.meta.url,
  ),
  "utf8",
);

test("SharesHeaderToolbar 将筛选字段更新转发给页面层", () => {
  for (const key of [
    "q",
    "type",
    "status",
    "sort_key",
    "expires_from_date",
    "expires_to_date",
    "owner_id",
  ]) {
    assert.match(
      source,
      new RegExp(`updateFilter\\('${key}', \\$event\\)`),
      `${key} 应通过 update-filter 事件交回 Shares.vue`,
    );
  }

  assert.match(source, /'update-filter'/, "组件应声明 update-filter 事件");
  assert.match(
    source,
    /'update-owner-search-query'/,
    "owner 搜索输入应通过独立事件交回 Shares.vue",
  );
});

test("SharesHeaderToolbar 保留移动端 768px 断点布局", () => {
  assert.match(
    source,
    /@media \(max-width:\s*768px\)/,
    "工具栏移动端断点应与应用 shell 保持一致",
  );
  assert.match(
    source,
    /\.filter-row[\s\S]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/,
    "分享筛选行移动端应保留四列网格布局",
  );
  assert.match(
    source,
    /\.filter-row:not\(\.has-owner-filter\) \.filter-item\.query[\s\S]*grid-column:\s*1 \/ -1;/,
    "无 owner 筛选时查询输入应继续占满首行",
  );
});
