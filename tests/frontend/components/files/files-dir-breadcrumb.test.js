import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../frontend/src/components/files/FilesDirBreadcrumb.vue",
    import.meta.url,
  ),
  "utf8",
);

test("FilesDirBreadcrumb 从纯函数派生面包屑与子目录", () => {
  // 复用 utils/files 的纯函数（可单测），而非在组件内重复逻辑
  assert.match(
    source,
    /import \{ buildDirBreadcrumb, collectChildDirs \} from '\.\.\/\.\.\/utils\/files\.js'/,
  );
  assert.match(
    source,
    /breadcrumbItems = computed\(\(\) => buildDirBreadcrumb\(props\.dir\)\)/,
  );
  assert.match(
    source,
    /childFolders = computed\(\(\) => collectChildDirs\(props\.dir, props\.dirs\)\)/,
  );
});

test("FilesDirBreadcrumb 导航为父层拥有（emit 契约）", () => {
  assert.match(source, /defineEmits\(\['go-root', 'go-up', 'navigate'\]\)/);
  assert.match(source, /emit\('go-root'\)/);
  assert.match(source, /emit\('go-up'\)/);
  assert.match(source, /emit\('navigate', item\.prefix\)/);
  assert.match(source, /emit\('navigate', folder\.prefix\)/);
});

test("FilesDirBreadcrumb 根目录与上一级按钮在根时禁用", () => {
  assert.match(source, /:disabled="loading \|\| !dir"/);
});
