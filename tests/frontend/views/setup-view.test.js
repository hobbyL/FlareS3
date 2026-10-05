import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSource = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("管理页不再渲染顶部配置状态摘要", () => {
  const source = readSource("../../../frontend/src/views/Setup.vue");

  assert.doesNotMatch(
    source,
    /<section class="setup-status-section">/,
    "Setup 页面不应再渲染顶部状态摘要区",
  );
  assert.doesNotMatch(
    source,
    /setupStatusItems|setupStatusAlerts|buildSetupStatusModel|buildSetupStatusItems|buildSetupStatusAlerts/,
    "Setup 页面不应继续依赖顶部状态摘要的数据构建逻辑",
  );
});

test("编辑存储配置回显脱敏形态，明文密钥不再回填表单", () => {
  const setupSource = readSource("../../../frontend/src/views/Setup.vue");
  const apiSource = readSource("../../../frontend/src/services/api.js");
  const modalSource = readSource(
    "../../../frontend/src/components/setup/StorageConfigModal.vue",
  );

  assert.match(
    apiSource,
    /getStorageConfigSecrets|\/storage\/configs\/\$\{configId\}\/secrets/,
    "前端 API 层应保留单条配置密钥读取方法",
  );
  assert.match(
    apiSource,
    /revealStorageConfigSecrets|\/storage\/configs\/\$\{configId\}\/secrets\/reveal/,
    "前端 API 层应提供明文密钥 reveal 方法",
  );
  assert.match(
    setupSource,
    /getStorageConfigSecrets\(row\.id,\s*row\.configType\)/,
    "Setup 编辑流程应在打开编辑弹窗前请求配置密钥",
  );
  // 编辑表单不再回填明文密钥/密码：留空表示沿用原值
  assert.match(setupSource, /access_key_id:\s*''/);
  assert.match(setupSource, /secret_access_key:\s*''/);
  assert.match(setupSource, /password:\s*''/);
  // WebDAV 用户名非机密，仍可回显
  assert.match(setupSource, /username:\s*secrets\.username\s*\|\|\s*''/);
  // 查看明文走 reveal 端点且有二次确认
  assert.match(
    setupSource,
    /revealStorageConfigSecrets\(row\.id,\s*row\.configType\)/,
  );
  assert.match(setupSource, /revealConfirm/);
  assert.match(
    modalSource,
    /watch\(\s*\(\)\s*=>\s*props\.show[\s\S]*\{\s*immediate:\s*true\s*\}/,
    "弹窗通过 v-if 在 show=true 时挂载，必须立即用 initialValue 重置内部表单",
  );
});
