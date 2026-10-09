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

test("More 页账户卡片内置修改密码表单：三个密码输入 + 前置校验 + 提交防重", () => {
  // 三个密码输入框（当前 / 新 / 确认），均为 type="password"
  const passwordInputs = moreSource.match(/type="password"/g) || [];
  assert.equal(
    passwordInputs.length,
    3,
    "修改密码区块应恰好包含三个 type=password 输入框",
  );

  // 前置校验不过不发请求：非空、≥8 位、两次一致、新旧不同
  assert.match(moreSource, /more\.password\.required/);
  assert.match(moreSource, /more\.password\.minLength/);
  assert.match(moreSource, /more\.password\.mismatch/);
  assert.match(moreSource, /more\.password\.sameAsCurrent/);
  assert.match(
    moreSource,
    /if \(changing\.value\) return/,
    "提交进行中必须早退防重复提交",
  );

  // 校验顺序：空值检查必须先于长度检查，长度检查先于一致性检查
  const requiredIndex = moreSource.indexOf("more.password.required");
  const minLengthIndex = moreSource.indexOf("more.password.minLength");
  const mismatchIndex = moreSource.indexOf("more.password.mismatch");
  assert.ok(
    requiredIndex < minLengthIndex && minLengthIndex < mismatchIndex,
    "前置校验应按 非空 → 长度 → 两次一致 的顺序排列",
  );
});

test("More 页改密成功后本端立即登出并跳转登录页", () => {
  assert.match(
    moreSource,
    /api\.changePassword\(\{\s*current_password: currentPassword,\s*new_password: newPassword,\s*\}\)/,
    "提交应携带 current_password / new_password 调用 changePassword",
  );
  assert.match(
    moreSource,
    /message\.success\(t\('more\.password\.changed'\)\)/,
    "成功后应先提示密码已修改",
  );
  assert.match(
    moreSource,
    /await authStore\.logout\(\)/,
    "服务端已删除全部会话，前端必须主动登出",
  );
  assert.match(
    moreSource,
    /await router\.push\('\/login'\)/,
    "登出后应跳转登录页",
  );
});

test("More 页存储用量卡片：挂载拉取 stats、失败占位可重试、口径标签随角色切换", () => {
  assert.match(
    moreSource,
    /onMounted\(\(\) => \{[\s\S]*?loadUsage\(\)[\s\S]*?\}\)/,
    "进入页面时应按需拉取一次用量",
  );
  assert.ok(
    !/setInterval|setTimeout/.test(moreSource),
    "用量不做轮询（onMounted 一次性拉取）",
  );
  assert.match(
    moreSource,
    /usage\.value = await api\.getStats\(\)/,
    "用量数据应来自 getStats 接口",
  );

  // 失败态：占位「-」+ 重试按钮，不阻塞页面其余区块
  assert.match(moreSource, /usageError\.value = true/);
  assert.match(
    moreSource,
    /usage \? usage\.usedSpaceFormatted : '-'/,
    "无数据时应显示占位「-」",
  );
  assert.match(
    moreSource,
    /v-if="usageError"[\s\S]*?@click="loadUsage"/,
    "失败时应提供重试入口",
  );

  // 口径标签：admin 显示全局用量，普通用户显示我的配额
  assert.match(
    moreSource,
    /authStore\.isAdmin \? t\('more\.usage\.globalScope'\) : t\('more\.usage\.userScope'\)/,
  );

  // 进度条百分比必须 clamp 到 0-100
  assert.match(
    moreSource,
    /return Math\.min\(100, value\)/,
    "usagePercent 必须 clamp 到 0-100 后再渲染进度条",
  );
});

test("前端 API 层提供 change-password 与 stats 封装", () => {
  assert.match(
    apiSource,
    /changePassword\(payload\) \{\s*return api\.post\('\/auth\/change-password', payload\)/,
  );
  assert.match(apiSource, /getStats\(\) \{\s*return api\.get\('\/stats'\)/);
});

test("修改密码与存储用量的文案键在 zh-CN / en-US 双语对齐", () => {
  for (const key of [
    "sectionTitle",
    "required",
    "currentPlaceholder",
    "newPlaceholder",
    "confirmPlaceholder",
    "submit",
    "changed",
    "minLength",
    "mismatch",
    "sameAsCurrent",
  ]) {
    assert.match(
      zhSource,
      new RegExp(`${key}:`),
      `zh-CN 缺少 more.password.${key}`,
    );
    assert.match(
      enSource,
      new RegExp(`${key}:`),
      `en-US 缺少 more.password.${key}`,
    );
  }

  for (const key of [
    "sectionTitle",
    "globalScope",
    "userScope",
    "usedSpace",
    "totalSpace",
    "fileCount",
    "retry",
  ]) {
    assert.match(
      zhSource,
      new RegExp(`${key}:`),
      `zh-CN 缺少 more.usage.${key}`,
    );
    assert.match(
      enSource,
      new RegExp(`${key}:`),
      `en-US 缺少 more.usage.${key}`,
    );
  }
});

test("More 页活跃会话卡片：当前设备标记、行内下线、下线其他设备确认流", () => {
  // 挂载即拉取会话列表
  assert.match(
    moreSource,
    /onMounted\(\(\) => \{[\s\S]*?loadSessions\(\)[\s\S]*?\}\)/,
  );
  assert.match(moreSource, /sessions\.value = result\.sessions \|\| \[\]/);

  // 当前设备用 Tag 明确标记，且当前设备行不渲染下线按钮（避免误把自己踢掉）
  assert.match(
    moreSource,
    /v-if="item\.is_current"[\s\S]*?more\.sessions\.currentTag/,
  );
  assert.match(
    moreSource,
    /v-if="!item\.is_current"[\s\S]*?@click="handleRevoke\(item\.id\)"/,
    "仅非当前设备渲染下线按钮",
  );

  // UA 经纯函数解析，未识别时回落 i18n 占位
  assert.match(moreSource, /describeUserAgent\(item\.user_agent\)/);
  assert.match(moreSource, /device \|\| t\('more\.sessions\.deviceUnknown'\)/);
  assert.match(
    moreSource,
    /browser \|\| t\('more\.sessions\.browserUnknown'\)/,
  );

  // 下线其他设备：无其他会话时禁用 + 确认弹窗 + 操作中防重
  assert.match(moreSource, /otherSessionCount = computed\(/);
  assert.match(
    moreSource,
    /:disabled="sessionActionPending \|\| !otherSessionCount"/,
  );
  assert.match(moreSource, /more\.sessions\.confirmRevokeOthers/);
  assert.match(moreSource, /if \(revokingOthers\.value\) return/);

  // 失败态不阻塞页面，提供重试入口
  assert.match(moreSource, /sessionsError\.value = true/);
  assert.match(
    moreSource,
    /v-else-if="sessionsError"[\s\S]*?@click="loadSessions"/,
  );
});

test("前端 API 层提供会话管理三端点封装", () => {
  assert.match(
    apiSource,
    /listSessions\(\) \{\s*return api\.get\('\/auth\/sessions'\)/,
  );
  assert.match(
    apiSource,
    /revokeSession\(sessionId\) \{\s*return api\.delete\(`\/auth\/sessions\/\$\{sessionId\}`\)/,
  );
  assert.match(
    apiSource,
    /revokeOtherSessions\(\) \{\s*return api\.post\('\/auth\/sessions\/revoke-others'\)/,
  );
});

test("More 页会话 i18n key zh/en 同步", () => {
  for (const key of [
    "currentTag",
    "deviceUnknown",
    "browserUnknown",
    "loginAt",
    "revoke",
    "revokeOthers",
    "revokeOthersTitle",
    "confirmRevokeOthers",
    "revokeSuccess",
    "revokeFailed",
    "revokeOthersSuccess",
    "revokeOthersFailed",
    "empty",
    "loadFailed",
  ]) {
    assert.match(
      zhSource,
      new RegExp(`${key}:`),
      `zh-CN 缺少 more.sessions.${key}`,
    );
    assert.match(
      enSource,
      new RegExp(`${key}:`),
      `en-US 缺少 more.sessions.${key}`,
    );
  }
});
