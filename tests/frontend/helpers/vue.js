import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// vue 只安装在 frontend/node_modules 下，测试文件位于 tests/ 之内，
// Node 的裸模块解析不会走到那里。composable 仅用到 ref/computed（响应式原语），
// 以 frontend/package.json 为锚点解析 @vue/reactivity 的 CJS 构建，
// 与 helpers/pinia.js 同一手法。
const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRequire = createRequire(
  pathToFileURL(path.join(here, "..", "..", "..", "frontend", "package.json")),
);

const reactivity = await import(
  pathToFileURL(
    frontendRequire.resolve("@vue/reactivity/dist/reactivity.cjs.js"),
  ).href
);

export const ref = reactivity.ref;
export const computed = reactivity.computed;
export const reactive = reactivity.reactive;
