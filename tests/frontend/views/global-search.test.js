import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSource = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const apiSource = readSource("../../../frontend/src/services/api.js");
const globalSearchSource = readSource(
  "../../../frontend/src/components/layout/GlobalSearch.vue",
);
const sidebarSource = readSource(
  "../../../frontend/src/components/layout/BrutalSidebar.vue",
);
const mobileTabbarSource = readSource(
  "../../../frontend/src/components/layout/MobileTabbar.vue",
);
const moreSource = readSource("../../../frontend/src/views/More.vue");
const filesSource = readSource("../../../frontend/src/views/Files.vue");
const textsSource = readSource("../../../frontend/src/views/Texts.vue");
const sharesSource = readSource("../../../frontend/src/views/Shares.vue");
const zhSearch = readSource("../../../frontend/src/locales/zh-CN/search.js");
const enSearch = readSource("../../../frontend/src/locales/en-US/search.js");
const zhIndex = readSource("../../../frontend/src/locales/zh-CN/index.js");
const enIndex = readSource("../../../frontend/src/locales/en-US/index.js");

test("前端 API 层提供 search 封装（单参 q，调用方不得二次解构 data）", () => {
  assert.match(
    apiSource,
    /search\(q\) \{\s*return api\.get\('\/search', \{ params: \{ q \} \}\)/,
    "api.search 应以 { params: { q } } 调用 GET /search",
  );
});

test("GlobalSearch：Modal + 防抖输入 + 三源分组，且不二次解构 data", () => {
  // 复用主题分发的 Modal / Input，数据走 api.search
  assert.match(
    globalSearchSource,
    /import Modal from '\.\.\/ui\/modal\/Modal\.vue'/,
  );
  assert.match(
    globalSearchSource,
    /import Input from '\.\.\/ui\/input\/Input\.vue'/,
  );
  assert.match(
    globalSearchSource,
    /import api from '\.\.\/\.\.\/services\/api\.js'/,
  );

  // 拦截器已返回 data，组件直接取 result.files/texts/shares
  assert.match(
    globalSearchSource,
    /const result = await api\.search\(/,
    "应通过 const result = await api.search(...) 获取结果",
  );
  assert.doesNotMatch(
    globalSearchSource,
    /const \{ data \} = await api\.search/,
    "拦截器已返回 data，禁止再次解构 const { data }",
  );
  // __REST__
  // 三源分组标题
  assert.match(globalSearchSource, /search\.groups\.files/);
  assert.match(globalSearchSource, /search\.groups\.texts/);
  assert.match(globalSearchSource, /search\.groups\.shares/);

  // 输入防抖：setTimeout 触发搜索 + 变更时 clearTimeout 取消上一次
  assert.match(
    globalSearchSource,
    /setTimeout\(\(\) => runSearch\(term\), DEBOUNCE_MS\)/,
  );
  assert.match(globalSearchSource, /clearTimeout\(debounceTimer\)/);

  // 空输入立即复位到提示态（不打后端）
  assert.match(globalSearchSource, /if \(!term\) \{/);
});

test("GlobalSearch：丢弃过期在途响应（requestSeq 守卫）", () => {
  assert.match(globalSearchSource, /let requestSeq = 0/);
  assert.match(globalSearchSource, /const seq = \+\+requestSeq/);
  assert.match(
    globalSearchSource,
    /if \(seq !== requestSeq\) return/,
    "关键词变化 / 弹窗关闭后，过期响应必须被丢弃",
  );
});

test("GlobalSearch：点击结果跳转对应页并带入搜索词 q", () => {
  // 复用各页 route.query.q：跳转时携带 { q: term }
  assert.match(
    globalSearchSource,
    /router\.push\(\{ path, query: term \? \{ q: term \} : \{\} \}\)/,
    "跳转应把搜索词写入 query.q（空词则不带）",
  );
  assert.match(globalSearchSource, /const goToFiles = \(\) => goTo\('\/'\)/);
  assert.match(
    globalSearchSource,
    /const goToTexts = \(\) => goTo\('\/texts'\)/,
  );
  assert.match(
    globalSearchSource,
    /const goToShares = \(\) => goTo\('\/shares'\)/,
  );
});

test("桌面侧栏与移动端（MobileTabbar + More）均挂载 GlobalSearch 搜索入口", () => {
  // 桌面：侧栏导航内置搜索触发
  assert.match(
    sidebarSource,
    /import GlobalSearch from '\.\/GlobalSearch\.vue'/,
  );
  assert.match(sidebarSource, /<GlobalSearch>/);

  // 移动端真实「更多」入口是 MobileTabbar 底部 sheet（侧栏在移动端 display:none）
  assert.match(
    mobileTabbarSource,
    /import GlobalSearch from '\.\/GlobalSearch\.vue'/,
  );
  // 弹窗挂在根节点并通过 ref.open() 触发，sheet 关闭不会连带卸载弹窗
  assert.match(mobileTabbarSource, /ref="globalSearchRef"/);
  assert.match(
    mobileTabbarSource,
    /const handleOpenSearch = \(\) => \{\s*closeMoreSheet\(\)\s*globalSearchRef\.value\?\.open\(\)/,
    "点击搜索应先收起 sheet 再打开搜索弹窗",
  );
  assert.match(mobileTabbarSource, /@click="handleOpenSearch"/);

  // More 设置页同样提供搜索入口
  assert.match(
    moreSource,
    /import GlobalSearch from '\.\.\/components\/layout\/GlobalSearch\.vue'/,
  );
  assert.match(moreSource, /<GlobalSearch>/);
});

test("Files / Texts / Shares 从 route.query.q 带入筛选词并监听变化重载", () => {
  for (const source of [filesSource, textsSource, sharesSource]) {
    assert.match(source, /import \{ useRoute \} from 'vue-router'/);
    assert.match(source, /const route = useRoute\(\)/);
    // 监听 query.q 变化驱动重载（已在该页时再次搜索）
    assert.match(source, /\(\) => route\.query\.q/);
  }

  // 各页把搜索词映射到自身筛选字段
  assert.match(filesSource, /filters\.value\.filename = term/);
  assert.match(textsSource, /filters\.value\.q = term/);
  assert.match(sharesSource, /filters\.value\.q = term/);

  // Shares 必须在 restoreFilters 之后再套用 query.q，避免被存储态覆盖
  const restoreIdx = sharesSource.indexOf("restoreFilters()");
  const applyIdx = sharesSource.indexOf("applySearchFromRoute()");
  assert.ok(
    restoreIdx !== -1 && applyIdx !== -1 && restoreIdx < applyIdx,
    "Shares 应先 restoreFilters() 再 applySearchFromRoute()",
  );
});

test("search 命名空间文案 zh/en 对齐且已接入 index 组装", () => {
  for (const key of [
    "entry",
    "title",
    "placeholder",
    "empty",
    "hint",
    "loading",
  ]) {
    assert.match(zhSearch, new RegExp(`${key}:`), `zh-CN 缺少 search.${key}`);
    assert.match(enSearch, new RegExp(`${key}:`), `en-US 缺少 search.${key}`);
  }
  for (const group of ["files", "texts", "shares"]) {
    assert.match(
      zhSearch,
      new RegExp(`${group}:`),
      `zh-CN 缺少 search.groups.${group}`,
    );
    assert.match(
      enSearch,
      new RegExp(`${group}:`),
      `en-US 缺少 search.groups.${group}`,
    );
  }

  for (const indexSource of [zhIndex, enIndex]) {
    assert.match(indexSource, /import search from '\.\/search(?:\.js)?'/);
    assert.match(indexSource, /\.\.\.search,/);
  }
});
