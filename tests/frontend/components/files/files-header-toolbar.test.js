import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../frontend/src/components/files/FilesHeaderToolbar.vue",
    import.meta.url,
  ),
  "utf8",
);

test("FilesHeaderToolbar 将筛选字段更新转发给页面层", () => {
  for (const key of [
    "filename",
    "created_from_date",
    "created_to_date",
    "owner_id",
    "upload_status",
    "sort_key",
  ]) {
    assert.match(
      source,
      new RegExp(`updateFilter\\('${key}', \\$event\\)`),
      `${key} 应通过 update-filter 事件交回 Files.vue`,
    );
  }

  assert.match(source, /'update-filter'/, "组件应声明 update-filter 事件");
});

test("FilesHeaderToolbar 保留移动端 768px 断点布局", () => {
  assert.match(
    source,
    /@media \(max-width:\s*768px\)/,
    "工具栏移动端断点应与应用 shell 保持一致",
  );
  assert.match(
    source,
    /\.filter-row\.main[\s\S]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
    "主筛选行移动端应保留三列网格布局",
  );
});
