import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../frontend/src/components/mount/MountCrossCopyModal.vue",
    import.meta.url,
  ),
  "utf8",
);

test("MountCrossCopyModal props 与确认载荷契约", () => {
  assert.match(source, /sourceConfigId:\s*\{/);
  assert.match(source, /configOptions:\s*\{/);
  // emit 契约：confirm 载荷含三字段
  assert.match(
    source,
    /emit\('confirm', \{\s*destConfigId: destConfigId\.value\.trim\(\)/,
  );
  assert.match(source, /destDir: destDir\.value\.trim\(\)/);
  assert.match(source, /deleteSourceAfterCopy: deleteSource\.value/);
  assert.match(source, /defineEmits\(\['update:show', 'cancel', 'confirm'\]\)/);
});

test("MountCrossCopyModal 删源开关默认关（纯复制语义）", () => {
  assert.match(source, /const deleteSource = ref\(false\)/);
  // 打开弹窗重置为默认关
  assert.match(source, /deleteSource\.value = false/);
});

test("MountCrossCopyModal 目标配置下拉排除源配置", () => {
  assert.match(
    source,
    /\.filter\(\(option\) => option\.value !== props\.sourceConfigId\)/,
  );
});

test("MountCrossCopyModal 展示 100MB 中转上限提示", () => {
  assert.match(source, /t\('mount\.crossCopy\.sizeHint'\)/);
});
