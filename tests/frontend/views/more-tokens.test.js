import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readSource = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const moreSource = readSource("../../../frontend/src/views/More.vue");
const apiSource = readSource("../../../frontend/src/services/api.js");
const zhSource = readSource(
  "../../../frontend/src/locales/zh-CN/pages/more.js",
);
const enSource = readSource(
  "../../../frontend/src/locales/en-US/pages/more.js",
);

test("More 页 API Token 卡片：创建表单（名称 + 可选有效期 + 创建按钮）与挂载拉取", () => {
  // 卡片标题走 i18n
  assert.match(moreSource, /more\.tokens\.sectionTitle/);

  // 创建表单：名称输入 + 数字有效期输入 + 创建按钮
  assert.match(moreSource, /v-model="tokenForm\.name"/);
  assert.match(moreSource, /v-model="tokenForm\.expiresIn"/);
  assert.match(moreSource, /more\.tokens\.namePlaceholder/);
  assert.match(moreSource, /more\.tokens\.expiresPlaceholder/);
  assert.match(moreSource, /@submit\.prevent="handleCreateToken"/);

  // 挂载即拉取令牌列表
  assert.match(
    moreSource,
    /onMounted\(\(\) => \{[\s\S]*?loadTokens\(\)[\s\S]*?\}\)/,
  );
  assert.match(moreSource, /tokens\.value = result\.tokens \|\| \[\]/);
});

test("More 页令牌列表：加载 / 失败可重试 / 空态，派生 status 标签与条件吊销按钮", () => {
  assert.match(moreSource, /v-if="tokensLoading"/);
  assert.match(
    moreSource,
    /v-else-if="tokensError"[\s\S]*?@click="loadTokens"/,
    "失败态应提供重试入口",
  );
  assert.match(
    moreSource,
    /v-else-if="!tokens\.length"[\s\S]*?more\.tokens\.empty/,
  );

  // status 文案走 i18n，标签类型由映射派生
  assert.match(
    moreSource,
    /tokenStatusTypeMap = \{ active: 'success', expired: 'warning', revoked: 'default' \}/,
  );
  assert.match(moreSource, /t\(`more\.tokens\.status\.\$\{item\.status\}`\)/);

  // 仅未吊销（canRevoke）渲染吊销按钮
  assert.match(moreSource, /canRevoke: item\.status !== 'revoked'/);
  assert.match(
    moreSource,
    /v-if="item\.canRevoke"[\s\S]*?@click="openRevokeToken\(item\.id\)"/,
  );
});

test("More 页创建令牌：校验名称 → 可选 expires_in → 弹窗一次性展示明文", () => {
  // 名称必填校验（不过不发请求）
  assert.match(moreSource, /more\.tokens\.nameRequired/);
  assert.match(
    moreSource,
    /if \(creatingToken\.value\) return/,
    "提交进行中必须早退防重复提交",
  );

  // 仅当有效期为正数时才带 expires_in
  assert.match(
    moreSource,
    /if \(Number\.isFinite\(rawExpires\) && rawExpires > 0\) \{\s*payload\.expires_in = Math\.floor\(rawExpires\)/,
  );

  // 成功后把一次性明文塞进弹窗，并刷新列表
  assert.match(
    moreSource,
    /createdTokenPlaintext\.value = result\.token \|\| ''/,
  );
  assert.match(moreSource, /createdTokenVisible\.value = true/);
  assert.match(moreSource, /await loadTokens\(\)/);
});

test("More 页明文弹窗：只读展示 + 复制，关闭即清空明文（不驻留内存）", () => {
  assert.match(moreSource, /more\.tokens\.createdTitle/);
  assert.match(moreSource, /more\.tokens\.createdHint/);
  // 复制走剪贴板
  assert.match(moreSource, /navigator\.clipboard\?\.writeText\(value\)/);
  assert.match(moreSource, /more\.tokens\.copied/);
  assert.match(moreSource, /more\.tokens\.copyFailed/);
  // 关闭时清空明文引用
  assert.match(
    moreSource,
    /closeCreatedToken = \(\) => \{\s*createdTokenVisible\.value = false\s*createdTokenPlaintext\.value = ''/,
    "关闭弹窗必须清空明文，避免长驻内存",
  );
});

test("More 页吊销令牌：二次确认弹窗 + 确认后调用 revokeToken 并刷新", () => {
  assert.match(moreSource, /more\.tokens\.revokeTitle/);
  assert.match(moreSource, /more\.tokens\.confirmRevoke/);
  assert.match(moreSource, /await api\.revokeToken\(tokenId\)/);
  assert.match(moreSource, /more\.tokens\.revokeSuccess/);
});

test("前端 API 层提供 token 自管理三端点封装（拦截器已返回 data，不二次解构）", () => {
  assert.match(apiSource, /listTokens\(\) \{\s*return api\.get\('\/tokens'\)/);
  assert.match(
    apiSource,
    /createToken\(payload\) \{\s*return api\.post\('\/tokens', payload\)/,
  );
  assert.match(
    apiSource,
    /revokeToken\(tokenId\) \{\s*return api\.delete\(`\/tokens\/\$\{tokenId\}`\)/,
  );
});

test("More 页 token i18n key 在 zh-CN / en-US 双语对齐", () => {
  const leafKeys = [
    "sectionTitle",
    "description",
    "namePlaceholder",
    "expiresPlaceholder",
    "create",
    "empty",
    "loadFailed",
    "createdTitle",
    "createdHint",
    "copy",
    "copied",
    "copyFailed",
    "close",
    "revoke",
    "revokeTitle",
    "confirmRevoke",
    "createSuccess",
    "createFailed",
    "revokeSuccess",
    "revokeFailed",
    "nameRequired",
    "createdAt",
    "lastUsedAt",
    "lastUsedNever",
    "expiresAt",
    "neverExpires",
    // status 子命名空间叶子
    "active",
    "expired",
    "revoked",
  ];

  for (const key of leafKeys) {
    assert.match(
      zhSource,
      new RegExp(`${key}:`),
      `zh-CN 缺少 more.tokens.${key}`,
    );
    assert.match(
      enSource,
      new RegExp(`${key}:`),
      `en-US 缺少 more.tokens.${key}`,
    );
  }
});
