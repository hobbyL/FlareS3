import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// pinia / vue 只安装在 frontend/node_modules 下，测试文件位于 tests/ 之内，
// Node 的裸模块解析不会走到那里。这里以 frontend/package.json 为锚点显式解析。
const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRequire = createRequire(
  pathToFileURL(path.join(here, "..", "..", "..", "frontend", "package.json")),
);

const pinia = await import(
  pathToFileURL(frontendRequire.resolve("pinia/dist/pinia.mjs")).href
);

export const createPinia = pinia.createPinia;
export const setActivePinia = pinia.setActivePinia;

/** 每个用例前调用：重置为全新的 pinia 实例，避免 store 状态跨用例泄漏 */
export function useFreshPinia() {
  const instance = createPinia();
  setActivePinia(instance);
  return instance;
}
