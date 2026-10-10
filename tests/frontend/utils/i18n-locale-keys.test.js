import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// locale 的 index.js 可被 node ESM 加载（import 已带显式 .js 后缀），
// 但为定位缺失键所属模块，这里仍按 index.js 的组装顺序逐叶子模块加载对比；
// 叶子模块均为纯数据，可在 node 下运行
const ROOT_MODULES = [
  "common",
  "errors",
  "sidebar",
  "components",
  "upload",
  "search",
];
const PAGE_MODULES = [
  "auth",
  "audit",
  "users",
  "files",
  "setup",
  "dashboard",
  "texts",
  "mount",
  "shares",
  "more",
];

async function loadLocaleModules(base) {
  const root = new URL(
    `../../../frontend/src/locales/${base}/`,
    import.meta.url,
  );
  const loaded = {};
  for (const name of [
    ...ROOT_MODULES,
    ...PAGE_MODULES.map((page) => `pages/${page}`),
  ]) {
    loaded[name] = (await import(new URL(`${name}.js`, root).href)).default;
  }
  return loaded;
}

const zhModules = await loadLocaleModules("zh-CN");
const enModules = await loadLocaleModules("en-US");

const readSource = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

/** 递归展平嵌套 locale 对象为点分键路径 */
function flattenKeys(messages, prefix = "") {
  const keys = [];
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") {
      keys.push(...flattenKeys(value, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

test("zh-CN 与 en-US 每个模块的 locale 键完全对齐", () => {
  for (const name of Object.keys(zhModules)) {
    const zhKeys = flattenKeys(zhModules[name]);
    const enKeys = flattenKeys(enModules[name]);

    assert.deepEqual(
      zhKeys,
      enKeys,
      `模块 ${name} 两侧键集合必须一致（无缺失、无多余）`,
    );
  }
});

test("errors 模块已接入两个语言的 index 组装", () => {
  for (const base of ["zh-CN", "en-US"]) {
    const source = readSource(`../../../frontend/src/locales/${base}/index.js`);
    assert.match(
      source,
      /import errors from '\.\/errors(?:\.js)?'/,
      `${base}/index.js 应引入 errors 模块`,
    );
    assert.match(
      source,
      /\.\.\.errors,/,
      `${base}/index.js 组装时应展开 errors 模块`,
    );
  }
});

test("errors 命名空间在两侧均提供全部兜底文案键", () => {
  const expectedKeys = [
    "forbidden",
    "rateLimited",
    "server",
    "network",
    "requestFailed",
    "appError",
    "operationFailed",
    "uploadConfigUnavailable",
    "uploadConfigLoading",
  ].sort();

  assert.deepEqual(
    Object.keys(zhModules.errors.errors || {}).sort(),
    expectedKeys,
    "zh-CN errors 命名空间键应齐全",
  );
  assert.deepEqual(
    Object.keys(enModules.errors.errors || {}).sort(),
    expectedKeys,
    "en-US errors 命名空间键应齐全",
  );

  for (const key of expectedKeys) {
    assert.ok(
      typeof zhModules.errors.errors[key] === "string" &&
        zhModules.errors.errors[key].length > 0,
      `zh-CN errors.${key} 应为非空字符串`,
    );
    assert.ok(
      typeof enModules.errors.errors[key] === "string" &&
        enModules.errors.errors[key].length > 0,
      `en-US errors.${key} 应为非空字符串`,
    );
  }
});

test("apiError 兜底文案引用 errors 命名空间 i18n 键", () => {
  const source = readSource("../../../frontend/src/utils/apiError.js");

  for (const key of [
    "forbidden",
    "rateLimited",
    "server",
    "network",
    "requestFailed",
  ]) {
    assert.match(
      source,
      new RegExp(`errors\\.${key}`),
      `apiError 应通过 i18n 键 errors.${key} 取兜底文案`,
    );
  }

  // 硬编码中文兜底不应再以字符串字面量形式出现（注释里的说明文字不算）
  assert.doesNotMatch(
    source,
    /'权限不足|'请求过于频繁|'服务器错误|'网络连接失败|'请求失败，请检查输入/,
    "兜底文案应全部走 i18n，不应残留硬编码中文字面量",
  );
});

test("main.js 全局错误处理文案走 errors 命名空间", () => {
  const source = readSource("../../../frontend/src/main.js");

  assert.match(
    source,
    /errors\.appError/,
    "errorHandler 应使用 errors.appError",
  );
  assert.match(
    source,
    /errors\.operationFailed/,
    "unhandledrejection 应使用 errors.operationFailed",
  );
  assert.doesNotMatch(source, /应用出现错误|操作失败，请稍后重试/);
});

test("useUploadConfigOptions 文案走 errors 命名空间而非 locale 判断", () => {
  const source = readSource(
    "../../../frontend/src/composables/useUploadConfigOptions.js",
  );

  assert.match(
    source,
    /errors\.uploadConfigUnavailable/,
    "无可用配置提示应使用 errors.uploadConfigUnavailable",
  );
  assert.match(
    source,
    /errors\.uploadConfigLoading/,
    "配置加载中提示应使用 errors.uploadConfigLoading",
  );
  assert.doesNotMatch(
    source,
    /startsWith\("zh"\)|startsWith\('zh'\)/,
    "不应再用 locale.startsWith('zh') 三元硬编码双语",
  );
});
