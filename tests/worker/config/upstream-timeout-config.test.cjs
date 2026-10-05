const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

function loadModule(relativePath) {
  const target = compiledPath(relativePath);
  delete require.cache[target];
  return require(target);
}

test("parseUpstreamTimeoutConfig falls back to defaults without overrides", () => {
  const config = loadModule("config/upstreamTimeout.js");

  assert.deepEqual(config.parseUpstreamTimeoutConfig({}), {
    fetchTimeoutMs: config.DEFAULT_UPSTREAM_FETCH_TIMEOUT_MS,
    readonlyRetries: config.DEFAULT_UPSTREAM_READONLY_RETRIES,
  });
  // 默认值与设计基线一致：30s 超时 / 只读重试 1 次
  assert.equal(config.DEFAULT_UPSTREAM_FETCH_TIMEOUT_MS, 30_000);
  assert.equal(config.DEFAULT_UPSTREAM_READONLY_RETRIES, 1);
});

test("parseUpstreamTimeoutConfig applies positive overrides per field", () => {
  const config = loadModule("config/upstreamTimeout.js");

  assert.deepEqual(
    config.parseUpstreamTimeoutConfig({
      UPSTREAM_FETCH_TIMEOUT_MS: "5000",
      UPSTREAM_FETCH_READONLY_RETRIES: "3",
    }),
    { fetchTimeoutMs: 5000, readonlyRetries: 3 },
  );
  // 字段间互不影响
  assert.deepEqual(
    config.parseUpstreamTimeoutConfig({ UPSTREAM_FETCH_TIMEOUT_MS: "5000" }),
    {
      fetchTimeoutMs: 5000,
      readonlyRetries: config.DEFAULT_UPSTREAM_READONLY_RETRIES,
    },
  );
});

test("parseUpstreamTimeoutConfig rejects invalid values back to defaults and floors decimals", () => {
  const config = loadModule("config/upstreamTimeout.js");

  for (const value of [undefined, "", "0", "-1", "abc"]) {
    assert.deepEqual(
      config.parseUpstreamTimeoutConfig({ UPSTREAM_FETCH_TIMEOUT_MS: value }),
      {
        fetchTimeoutMs: config.DEFAULT_UPSTREAM_FETCH_TIMEOUT_MS,
        readonlyRetries: config.DEFAULT_UPSTREAM_READONLY_RETRIES,
      },
      `UPSTREAM_FETCH_TIMEOUT_MS=${value} 应回退默认值`,
    );
    assert.deepEqual(
      config.parseUpstreamTimeoutConfig({
        UPSTREAM_FETCH_READONLY_RETRIES: value,
      }),
      {
        fetchTimeoutMs: config.DEFAULT_UPSTREAM_FETCH_TIMEOUT_MS,
        readonlyRetries: config.DEFAULT_UPSTREAM_READONLY_RETRIES,
      },
      `UPSTREAM_FETCH_READONLY_RETRIES=${value} 应回退默认值`,
    );
  }

  // 小数向下取整（与 rateLimit 同一约定）
  assert.deepEqual(
    config.parseUpstreamTimeoutConfig({
      UPSTREAM_FETCH_TIMEOUT_MS: "10.9",
      UPSTREAM_FETCH_READONLY_RETRIES: "2.9",
    }),
    { fetchTimeoutMs: 10, readonlyRetries: 2 },
  );
});

test("refreshUpstreamTimeoutConfig seeds the isolate cache read by service layers", () => {
  const config = loadModule("config/upstreamTimeout.js");

  // 恢复默认，避免同文件内前序状态影响
  config.refreshUpstreamTimeoutConfig({});
  assert.deepEqual(config.getUpstreamTimeoutConfig(), {
    fetchTimeoutMs: config.DEFAULT_UPSTREAM_FETCH_TIMEOUT_MS,
    readonlyRetries: config.DEFAULT_UPSTREAM_READONLY_RETRIES,
  });

  const refreshed = config.refreshUpstreamTimeoutConfig({
    UPSTREAM_FETCH_TIMEOUT_MS: "2500",
    UPSTREAM_FETCH_READONLY_RETRIES: "2",
  });
  assert.deepEqual(refreshed, { fetchTimeoutMs: 2500, readonlyRetries: 2 });
  assert.deepEqual(config.getUpstreamTimeoutConfig(), refreshed);
});
