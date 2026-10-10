import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const uploadPanelSource = read(
  "../../../../frontend/src/components/upload/UploadPanel.vue",
);
const uploadModalSource = read(
  "../../../../frontend/src/components/files/FileUploadModal.vue",
);
const filesViewSource = read("../../../../frontend/src/views/Files.vue");

test("UploadPanel 接收 initialDir 并用它初始化 uploadDir（可改可清空）", () => {
  assert.match(uploadPanelSource, /initialDir:\s*{/);
  // uploadDir 以 props.initialDir 作为初值
  assert.match(
    uploadPanelSource,
    /const uploadDir = ref\(String\(props\.initialDir \|\| ''\)\)/,
  );
  // 仍是普通 ref 绑定输入框，用户可编辑/清空
  assert.match(uploadPanelSource, /v-model="uploadDir"/);
});

test("FileUploadModal 声明 initialDir 并透传给 UploadPanel", () => {
  assert.match(uploadModalSource, /initialDir:\s*{/);
  assert.match(uploadModalSource, /:initial-dir="initialDir"/);
});

test("Files 页面把当前目录 filters.dir 传给上传弹窗", () => {
  assert.match(filesViewSource, /:initial-dir="filters\.dir"/);
});
