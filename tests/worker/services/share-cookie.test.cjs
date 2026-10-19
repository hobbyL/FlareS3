const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function loadModule(relativePath) {
  const target = path.join(COMPILED_ROOT, relativePath);
  delete require.cache[target];
  return require(target);
}

const SECRET = "test-share-cookie-secret";

test("signShareCookie issues a verifiable credential bound to the share code", async () => {
  const cookie = loadModule("services/shareCookie.js");
  const env = { AUTH_TOKEN_SECRET: SECRET };

  const value = await cookie.signShareCookie(env, "abc123");
  assert.ok(value, "secret 已配置时应签出凭证");
  assert.match(value, /^\d+\.[A-Za-z0-9_-]+$/);

  assert.equal(await cookie.verifyShareCookie(env, "abc123", value), true);
  // 凭证与 code 绑定：换一个 code 不能通过验签
  assert.equal(await cookie.verifyShareCookie(env, "other-code", value), false);
});

test("signShareCookie caps the credential lifetime at 24h and the share expiry", async () => {
  const cookie = loadModule("services/shareCookie.js");
  const env = { AUTH_TOKEN_SECRET: SECRET };
  const nowSeconds = Math.floor(Date.now() / 1000);

  const longLived = await cookie.signShareCookie(env, "abc123");
  const longExpiry = Number(longLived.split(".")[0]);
  assert.ok(
    longExpiry > nowSeconds &&
      longExpiry <= nowSeconds + cookie.SHARE_COOKIE_MAX_AGE_SECONDS,
    "无分享过期时有效期封顶 24h",
  );

  // 分享 1 小时后过期：凭证有效期必须压缩到分享过期之内
  const shareExpiresAtMs = Date.now() + 60 * 60 * 1000;
  const shortLived = await cookie.signShareCookie(
    env,
    "abc123",
    shareExpiresAtMs,
  );
  const shortExpiry = Number(shortLived.split(".")[0]);
  assert.ok(
    shortExpiry > nowSeconds && shortExpiry <= nowSeconds + 60 * 60,
    "有效期不超过分享过期剩余时间",
  );
});

test("signShareCookie refuses to issue a credential for an expired share", async () => {
  const cookie = loadModule("services/shareCookie.js");
  const env = { AUTH_TOKEN_SECRET: SECRET };

  // 分享已过期：不得兜底签出短有效期的 cookie（判定已过期的分享
  // 不应因为「剩余秒数取整为 0」而在 cookie 通道上被重新放行）
  assert.equal(
    await cookie.signShareCookie(env, "abc123", Date.now() - 1_000),
    null,
    "expires_at 已过去时不得签发凭证",
  );
  assert.equal(
    await cookie.signShareCookie(env, "abc123", Date.now() - 60 * 60 * 1000),
    null,
    "过期较久的分享同样不得签发凭证",
  );
  // 剩余不足 1 秒（取整为 0）同样视为已过期
  assert.equal(
    await cookie.signShareCookie(env, "abc123", Date.now() + 100),
    null,
    "剩余不足一秒时不得签发 1 秒凭证",
  );
});

test("verifyShareCookie rejects expired, tampered and malformed credentials", async () => {
  const cookie = loadModule("services/shareCookie.js");
  const env = { AUTH_TOKEN_SECRET: SECRET };

  const value = await cookie.signShareCookie(env, "abc123");
  const [expiryPart, signaturePart] = value.split(".");

  // 过期凭证：手工构造已过期的 expiry（验签在过期检查处即失败）
  const expired = `${Math.floor(Date.now() / 1000) - 10}.${signaturePart}`;
  assert.equal(await cookie.verifyShareCookie(env, "abc123", expired), false);

  // 篡改签名
  const tampered = `${expiryPart}.${signaturePart.slice(0, -2)}xy`;
  assert.equal(await cookie.verifyShareCookie(env, "abc123", tampered), false);

  // 格式非法：无分隔点 / expiry 非数字
  assert.equal(
    await cookie.verifyShareCookie(env, "abc123", "nonsense"),
    false,
  );
  assert.equal(await cookie.verifyShareCookie(env, "abc123", "abc.def"), false);
  assert.equal(await cookie.verifyShareCookie(env, "abc123", ".def"), false);
  assert.equal(await cookie.verifyShareCookie(env, "abc123", "123."), false);

  // 空值
  assert.equal(await cookie.verifyShareCookie(env, "abc123", null), false);
  assert.equal(await cookie.verifyShareCookie(env, "abc123", undefined), false);
  assert.equal(await cookie.verifyShareCookie(env, "abc123", ""), false);
});

test("signShareCookie degrades to null without a secret or code", async () => {
  const cookie = loadModule("services/shareCookie.js");

  assert.equal(
    await cookie.signShareCookie({ AUTH_TOKEN_SECRET: "" }, "abc123"),
    null,
  );
  assert.equal(
    await cookie.signShareCookie({ AUTH_TOKEN_SECRET: SECRET }, "  "),
    null,
  );
  // secret 未配置时验签也一律失败（不误放行）
  assert.equal(
    await cookie.verifyShareCookie(
      { AUTH_TOKEN_SECRET: "" },
      "abc123",
      "123.abc",
    ),
    false,
  );
});

test("buildShareCookieName prefixes the share code with fs_", () => {
  const cookie = loadModule("services/shareCookie.js");
  assert.equal(cookie.buildShareCookieName("abc123"), "fs_abc123");
});
