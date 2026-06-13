import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSource = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const directShowModalSources = [
  "../../../../frontend/src/components/texts/TextFormModal.vue",
  "../../../../frontend/src/components/texts/TextViewModal.vue",
  "../../../../frontend/src/components/texts/TextShareModal.vue",
  "../../../../frontend/src/components/texts/TextQrModal.vue",
  "../../../../frontend/src/components/files/FileShareModal.vue",
  "../../../../frontend/src/components/users/UserEditModal.vue",
  "../../../../frontend/src/components/setup/R2ConfigModal.vue",
  "../../../../frontend/src/components/setup/StorageConfigModal.vue",
];

const arrayShowModalSources = [
  "../../../../frontend/src/components/files/FileInfoModal.vue",
  "../../../../frontend/src/components/mount/MountedObjectPreviewModal.vue",
];

test("v-if 懒加载弹窗必须在首次 show=true 挂载时初始化数据", () => {
  for (const sourcePath of directShowModalSources) {
    const source = readSource(sourcePath);

    assert.match(
      source,
      /watch\(\s*\(\)\s*=>\s*props\.show[\s\S]*\{\s*immediate:\s*true\s*\}/,
      `${sourcePath} 的 props.show watcher 需要 immediate: true，否则 v-if 首次挂载时不会加载已有数据`,
    );
  }

  for (const sourcePath of arrayShowModalSources) {
    const source = readSource(sourcePath);

    assert.match(
      source,
      /watch\(\s*\[\s*\(\)\s*=>\s*props\.show[\s\S]*\{\s*immediate:\s*true\s*\}/,
      `${sourcePath} 的 props.show 数组 watcher 需要 immediate: true，否则 v-if 首次挂载时不会加载预览数据`,
    );
  }
});
