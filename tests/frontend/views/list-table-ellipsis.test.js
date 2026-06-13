import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSource = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const getColumnBlock = (source, key) => {
  const keyPattern = `key: '${key}'`;
  const keyIndex = source.indexOf(keyPattern);
  assert.notEqual(keyIndex, -1, `未找到列定义: ${key}`);

  const objectStart = source.lastIndexOf("{", keyIndex);
  assert.notEqual(objectStart, -1, `未找到列起始位置: ${key}`);

  let depth = 0;
  let inString = false;
  let quote = "";

  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index];
    const prevChar = source[index - 1];

    if (inString) {
      if (char === quote && prevChar !== "\\") {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(objectStart, index + 1);
      }
    }
  }

  assert.fail(`未找到列结束位置: ${key}`);
};

const assertColumns = ({ file, ellipsisTrue = [], ellipsisFalse = [] }) => {
  const source = readSource(file);

  for (const key of ellipsisTrue) {
    assert.match(
      getColumnBlock(source, key),
      /ellipsis:\s*true/,
      `${file} 的 ${key} 列应启用 ellipsis`,
    );
  }

  for (const key of ellipsisFalse) {
    assert.match(
      getColumnBlock(source, key),
      /ellipsis:\s*false/,
      `${file} 的 ${key} 列应保留 ellipsis: false`,
    );
  }
};

test("文本列表页为纯文本列显式启用 ellipsis", () => {
  assertColumns({
    file: "../../../frontend/src/views/Texts.vue",
    ellipsisTrue: [
      "title",
      "content_preview",
      "content_length",
      "updated_at",
      "owner",
    ],
    ellipsisFalse: ["actions"],
  });

  assertColumns({
    file: "../../../frontend/src/views/Users.vue",
    ellipsisTrue: ["username", "role", "quota_bytes"],
    ellipsisFalse: ["status", "actions"],
  });

  assertColumns({
    file: "../../../frontend/src/views/Audit.vue",
    ellipsisTrue: ["created_at", "actor", "ip", "user_agent"],
    ellipsisFalse: ["select", "action", "actions"],
  });
});

test("分享与挂载列表为可截断文本列启用 ellipsis", () => {
  assertColumns({
    file: "../../../frontend/src/components/shares/shareTableColumns.js",
    ellipsisTrue: [
      "name",
      "visits",
      "expiresAt",
      "password",
      "updatedAt",
      "owner",
    ],
    ellipsisFalse: ["select", "type", "link", "status", "actions"],
  });

  assertColumns({
    file: "../../../frontend/src/components/mount/mountTableColumns.js",
    ellipsisTrue: ["name", "size", "last_modified"],
    ellipsisFalse: ["actions"],
  });
});

test("复合文本列使用内部样式保证省略号生效", () => {
  const sharesSource = readSource(
    "../../../frontend/src/components/shares/SharesListPanel.vue",
  );
  assert.match(
    sharesSource,
    /share-link-path[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/,
    "Shares 链接文本应使用单行省略号样式",
  );

  const mountTableViewSource = readSource(
    "../../../frontend/src/components/mount/MountTableView.vue",
  );
  assert.match(
    mountTableViewSource,
    /mount-name-text[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/,
    "Mount 名称文本应使用单行省略号样式",
  );
});

test("分享页链接列与操作列保持单行按钮布局", () => {
  const sharesSource = readSource(
    "../../../frontend/src/components/shares/SharesListPanel.vue",
  );
  const sharesColumnsSource = readSource(
    "../../../frontend/src/components/shares/shareTableColumns.js",
  );
  const linkColumn = getColumnBlock(sharesColumnsSource, "link");
  const zhSource = readSource(
    "../../../frontend/src/locales/zh-CN/pages/shares.js",
  );
  const enSource = readSource(
    "../../../frontend/src/locales/en-US/pages/shares.js",
  );

  assert.match(
    linkColumn,
    /width:\s*220/,
    "Shares 链接列宽度应收窄，避免右侧出现过多空白",
  );
  assert.match(linkColumn, /align:\s*'center'/, "Shares 链接列应整体居中对齐");

  assert.match(
    sharesSource,
    /:deep\(\.share-link-cell\)\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*center;[^}]*align-items:\s*center;[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*\}/,
    "Shares 链接列容器应在单元格内整体居中",
  );
  assert.match(
    sharesSource,
    /:deep\(\.share-link-buttons\),[\s\S]*:deep\(\.action-buttons\)\s*\{[^}]*flex-wrap:\s*nowrap;/,
    "Shares 链接列按钮区应禁止换行",
  );
  assert.match(
    sharesSource,
    /:deep\(\.share-link-buttons\),[\s\S]*:deep\(\.action-buttons\)\s*\{[^}]*flex-wrap:\s*nowrap;/,
    "Shares 操作列按钮区应禁止换行",
  );
  assert.match(
    sharesSource,
    /:deep\(\.share-link-text\)\s*\{[^}]*flex:\s*0 1 auto;[^}]*max-width:\s*calc\(100%\s*-\s*88px\);[^}]*\}/,
    "Shares 链接文本区域应只占用必要宽度，并为按钮预留固定空间",
  );
  assert.match(
    sharesColumnsSource,
    /['"]aria-label['"]:\s*translate\('shares\.actions\.copyLink'\)/,
    "Shares 复制链接按钮应保留可访问名称",
  );
  assert.match(
    sharesColumnsSource,
    /['"]aria-label['"]:\s*translate\('shares\.actions\.openLink'\)/,
    "Shares 打开链接按钮应保留可访问名称",
  );
  assert.match(
    sharesColumnsSource,
    /\(\)\s*=>\s*h\(Copy,\s*\{\s*size:\s*16\s*\}\)/,
    "Shares 复制链接按钮应只渲染图标",
  );
  assert.match(
    sharesColumnsSource,
    /\(\)\s*=>\s*h\(ExternalLink,\s*\{\s*size:\s*16\s*\}\)/,
    "Shares 打开链接按钮应只渲染图标",
  );
  assert.match(
    zhSource,
    /disable:\s*'禁用'/,
    "中文操作列关闭文案应精简为“禁用”",
  );
  assert.match(
    zhSource,
    /regenerate:\s*'重置'/,
    "中文操作列重生成文案应精简为“重置”",
  );
  assert.match(
    enSource,
    /disable:\s*'Disable'/,
    "英文操作列关闭文案应同步精简",
  );
  assert.match(
    enSource,
    /regenerate:\s*'Reset'/,
    "英文操作列重生成文案应同步精简",
  );
});

test("TableCellText 为表格文本节点内建单行省略号样式，避免被直接裁切", () => {
  const source = readSource(
    "../../../frontend/src/components/ui/table/TableCellText.vue",
  );

  assert.match(
    source,
    /table-cell-text/,
    "TableCellText 应提供稳定的基础样式类名",
  );
  assert.match(
    source,
    /\.table-cell-text[\s\S]*display:\s*block;[\s\S]*max-width:\s*100%;[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/,
    "TableCellText 根文本节点应内建单行省略号样式",
  );
});

test("共享表格为普通文本节点补齐完整省略号样式链路", () => {
  const shadcnSource = readSource(
    "../../../frontend/src/components/ui/table/ShadcnTable.vue",
  );
  const brutalSource = readSource(
    "../../../frontend/src/components/ui/table/BrutalTable.vue",
  );

  assert.match(
    shadcnSource,
    /\.cell-ellipsis > span[\s\S]*display:\s*block;[\s\S]*max-width:\s*100%;[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/,
    "ShadcnTable 的普通文本节点应内建完整单行省略号样式",
  );
  assert.match(
    brutalSource,
    /\.cell-ellipsis > span[\s\S]*display:\s*block;[\s\S]*max-width:\s*100%;[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/,
    "BrutalTable 的普通文本节点应内建完整单行省略号样式",
  );
});

test("共享表格为 tooltip trigger 补齐完整省略号样式链路", () => {
  const shadcnSource = readSource(
    "../../../frontend/src/components/ui/table/ShadcnTable.vue",
  );
  const brutalSource = readSource(
    "../../../frontend/src/components/ui/table/BrutalTable.vue",
  );

  assert.match(
    shadcnSource,
    /\.cell-ellipsis :deep\(\.tooltip-trigger\),[\s\S]*\.cell-ellipsis :deep\(\.brutal-tooltip-trigger\)[\s\S]*display:\s*block;[\s\S]*width:\s*100%;[\s\S]*max-width:\s*100%;[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/,
    "ShadcnTable 的 tooltip trigger 应具备完整单行省略号链路",
  );
  assert.match(
    brutalSource,
    /\.cell-ellipsis :deep\(\.brutal-tooltip-trigger\),[\s\S]*\.cell-ellipsis :deep\(\.tooltip-trigger\)[\s\S]*display:\s*block;[\s\S]*width:\s*100%;[\s\S]*max-width:\s*100%;[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/,
    "BrutalTable 的 tooltip trigger 应具备完整单行省略号链路",
  );
});
