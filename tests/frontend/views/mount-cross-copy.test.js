import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const mountViewSource = read("../../../frontend/src/views/Mount.vue");
const columnsSource = read(
  "../../../frontend/src/components/mount/mountTableColumns.js",
);
const apiSource = read("../../../frontend/src/services/api.js");
const zhSource = read("../../../frontend/src/locales/zh-CN/pages/mount.js");
const enSource = read("../../../frontend/src/locales/en-US/pages/mount.js");

test("mountTableColumns 仅在注入 onCrossCopyObject 时渲染跨存储复制入口", () => {
  assert.match(columnsSource, /onCrossCopyObject = undefined/);
  assert.match(columnsSource, /typeof onCrossCopyObject === 'function'/);
  assert.match(columnsSource, /mount\.crossCopy\.action/);
});

test("Mount.vue 仅多存储配置环境注入跨存储复制（configs>1）", () => {
  assert.match(
    mountViewSource,
    /configs\.value\.length > 1 \? openCrossCopyModal/,
  );
  assert.match(mountViewSource, /configs\.value\.length <= 1\) return/);
  assert.match(
    mountViewSource,
    /import\('\.\.\/components\/mount\/MountCrossCopyModal\.vue'\)/,
  );
  assert.match(
    mountViewSource,
    /<MountCrossCopyModal\s+v-if="showCrossCopyModal"/,
  );
  assert.match(mountViewSource, /@confirm="handleCrossCopyConfirm"/);
});

test("Mount.vue 成功 toast 按 source_deleted 二分", () => {
  assert.match(mountViewSource, /result\?\.source_deleted/);
  assert.match(mountViewSource, /mount\.crossCopy\.successMoved/);
  assert.match(mountViewSource, /mount\.crossCopy\.successCopied/);
  // 失败固定文案兜底
  assert.match(mountViewSource, /mount\.crossCopy\.failed/);
});

test("api.js 暴露 crossConfigCopyMountObject 并映射蛇形字段", () => {
  assert.match(apiSource, /crossConfigCopyMountObject\(\{/);
  assert.match(apiSource, /source_config_id: sourceConfigId/);
  assert.match(apiSource, /delete_source_after_copy: deleteSourceAfterCopy/);
  assert.match(apiSource, /api\.post\('\/mount\/cross-config-copy'/);
});

test("i18n：zh/en mount.crossCopy key 对齐", () => {
  const keys = [
    "action",
    "title",
    "destConfig",
    "destDir",
    "destDirPlaceholder",
    "deleteSource",
    "keepSource",
    "sizeHint",
    "successCopied",
    "successMoved",
    "failed",
  ];
  for (const key of keys) {
    assert.match(zhSource, new RegExp(`${key}:`), `zh 缺少 crossCopy.${key}`);
    assert.match(enSource, new RegExp(`${key}:`), `en 缺少 crossCopy.${key}`);
  }
});
