const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

const rateLimitConfig = require(
  path.join(COMPILED_ROOT, "config/rateLimit.js"),
);

const {
  getRateLimitConfig,
  DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MS,
  DEFAULT_LOGIN_RATE_LIMIT_MAX,
  DEFAULT_LOGIN_MAX_FAILED_ATTEMPTS,
  DEFAULT_LOGIN_BLOCK_DURATION_MS,
  DEFAULT_SHARE_MAX_FAILED_ATTEMPTS,
  DEFAULT_SHARE_BLOCK_DURATION_MS,
  DEFAULT_PUBLIC_RATE_LIMIT_WINDOW_MS,
  DEFAULT_PUBLIC_RATE_LIMIT_MAX,
  SHARE_SCOPE_PREFIX,
  PUBLIC_RATE_LIMIT_PREFIX,
} = rateLimitConfig;

const DEFAULTS = {
  loginWindowMs: DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MS,
  loginMax: DEFAULT_LOGIN_RATE_LIMIT_MAX,
  loginMaxFailedAttempts: DEFAULT_LOGIN_MAX_FAILED_ATTEMPTS,
  loginBlockDurationMs: DEFAULT_LOGIN_BLOCK_DURATION_MS,
  shareMaxFailedAttempts: DEFAULT_SHARE_MAX_FAILED_ATTEMPTS,
  shareBlockDurationMs: DEFAULT_SHARE_BLOCK_DURATION_MS,
  publicWindowMs: DEFAULT_PUBLIC_RATE_LIMIT_WINDOW_MS,
  publicMax: DEFAULT_PUBLIC_RATE_LIMIT_MAX,
};

test("getRateLimitConfig 在未配置任何环境变量时返回默认值", () => {
  assert.deepEqual(getRateLimitConfig({}), DEFAULTS);
});

test("默认值与整改前硬编码的阈值保持一致", () => {
  assert.deepEqual(DEFAULTS, {
    loginWindowMs: 60 * 1000,
    loginMax: 300,
    loginMaxFailedAttempts: 10,
    loginBlockDurationMs: 5 * 60 * 1000,
    shareMaxFailedAttempts: 5,
    shareBlockDurationMs: 10 * 60 * 1000,
    publicWindowMs: 60 * 1000,
    publicMax: 120,
  });
});

test("每个字段都能被对应的环境变量单独覆盖", () => {
  const cases = [
    ["RATE_LIMIT_WINDOW_MS", "30000", "loginWindowMs", 30000],
    ["RATE_LIMIT_MAX", "50", "loginMax", 50],
    ["RATE_LIMIT_MAX_FAILED_ATTEMPTS", "3", "loginMaxFailedAttempts", 3],
    ["RATE_LIMIT_BLOCK_DURATION_MS", "900000", "loginBlockDurationMs", 900000],
    ["SHARE_RATE_LIMIT_MAX_FAILED_ATTEMPTS", "2", "shareMaxFailedAttempts", 2],
    [
      "SHARE_RATE_LIMIT_BLOCK_DURATION_MS",
      "60000",
      "shareBlockDurationMs",
      60000,
    ],
    ["PUBLIC_RATE_LIMIT_WINDOW_MS", "10000", "publicWindowMs", 10000],
    ["PUBLIC_RATE_LIMIT_MAX", "20", "publicMax", 20],
  ];

  for (const [envKey, envValue, field, expected] of cases) {
    const config = getRateLimitConfig({ [envKey]: envValue });
    assert.equal(config[field], expected, `${envKey} 应覆盖 ${field}`);

    const untouched = { ...DEFAULTS };
    delete untouched[field];
    for (const [key, value] of Object.entries(untouched)) {
      assert.equal(config[key], value, `${envKey} 不应影响 ${key}`);
    }
  }
});

test("非法取值回退到默认值，限流不会被意外关闭", () => {
  const invalid = [
    "0",
    "-1",
    "abc",
    "",
    " ",
    "NaN",
    "Infinity",
    "-Infinity",
    undefined,
    null,
  ];

  for (const value of invalid) {
    const config = getRateLimitConfig({
      RATE_LIMIT_MAX: value,
      PUBLIC_RATE_LIMIT_MAX: value,
      SHARE_RATE_LIMIT_MAX_FAILED_ATTEMPTS: value,
    });
    assert.equal(
      config.loginMax,
      DEFAULT_LOGIN_RATE_LIMIT_MAX,
      `RATE_LIMIT_MAX=${String(value)} 应回退默认值`,
    );
    assert.equal(config.publicMax, DEFAULT_PUBLIC_RATE_LIMIT_MAX);
    assert.equal(
      config.shareMaxFailedAttempts,
      DEFAULT_SHARE_MAX_FAILED_ATTEMPTS,
    );
  }
});

test("小数取值向下取整为正整数", () => {
  const config = getRateLimitConfig({
    RATE_LIMIT_MAX: "10.9",
    PUBLIC_RATE_LIMIT_WINDOW_MS: "1500.75",
  });
  assert.equal(config.loginMax, 10);
  assert.equal(config.publicWindowMs, 1500);
});

test("所有返回字段均为正整数", () => {
  const config = getRateLimitConfig({});
  for (const [key, value] of Object.entries(config)) {
    assert.equal(
      Number.isInteger(value) && value > 0,
      true,
      `${key} 必须是正整数，实际为 ${value}`,
    );
  }
});

test("限流 key 前缀保持稳定，避免与真实 IP 记录冲突", () => {
  assert.equal(SHARE_SCOPE_PREFIX, "share:");
  assert.equal(PUBLIC_RATE_LIMIT_PREFIX, "public:");
  assert.notEqual(SHARE_SCOPE_PREFIX, PUBLIC_RATE_LIMIT_PREFIX);
});

test("rateLimit 中间件不再硬编码阈值常量", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/middleware/rateLimit.ts"),
    "utf8",
  );

  assert.match(source, /from '\.\.\/config\/rateLimit'/);
  assert.doesNotMatch(
    source,
    /^const (RATE_LIMIT|PUBLIC_RATE_LIMIT|SHARE_|MAX_FAILED|BLOCK_DURATION)/m,
    "限流阈值必须来自 config/rateLimit.ts，不得在中间件内重新硬编码",
  );
});
