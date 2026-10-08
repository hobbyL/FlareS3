const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || "/tmp/flares3-worker-tests";

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

function loadCompiledModule(relativePath) {
  const target = compiledPath(relativePath);
  delete require.cache[target];
  return require(target);
}

test("expires_in: 0 写入永不过期哨兵值，且 isNeverExpires 认得它", () => {
  const helpers = loadCompiledModule("routes/upload/helpers.js");

  assert.equal(helpers.NEVER_EXPIRES_AT_ISO, "9999-12-31T23:59:59.999Z");
  assert.equal(
    helpers.calcExpiresAt(0).toISOString(),
    helpers.NEVER_EXPIRES_AT_ISO,
  );
  assert.equal(helpers.isNeverExpires(helpers.NEVER_EXPIRES_AT_ISO), true);
});

test("哨兵值永远不满足 cleanupExpired 的 expires_at < now 谓词", () => {
  const helpers = loadCompiledModule("routes/upload/helpers.js");

  // cleanupExpired 的扫描条件是 `WHERE expires_at < ?`，绑定值为当次运行的 now。
  // 哨兵值在任何可预见的 now 下都更大，所以 expires_in: 0 的未完成分片上传
  // 永远不会被 cron 回收——发起方必须自己在取消路径上 abort 恰好一次。
  // 参见 .trellis/spec/worker/d1-write-consistency.md 的
  // "cleanupExpired Does Not Backstop Never-Expiring Multipart Uploads"。
  const sentinel = helpers.calcExpiresAt(0).toISOString();

  for (const now of [
    new Date().toISOString(),
    "2099-12-31T23:59:59.999Z",
    "9999-12-31T23:59:59.998Z",
  ]) {
    assert.equal(
      sentinel < now,
      false,
      `哨兵值不应早于 ${now}，否则 cron 会把永不过期的文件当成过期文件回收`,
    );
  }
});

test("带真实过期时间的上传仍然落在 cron 覆盖范围内", () => {
  const helpers = loadCompiledModule("routes/upload/helpers.js");

  // -30 是 30 秒的短过期档位：它必须是真实时间戳而不是哨兵值，
  // 否则短过期残留也会逃过回收。
  const shortLived = helpers.calcExpiresAt(-30).toISOString();
  assert.notEqual(shortLived, helpers.NEVER_EXPIRES_AT_ISO);
  assert.equal(helpers.isNeverExpires(shortLived), false);

  const futureNow = new Date(Date.now() + 60 * 1000).toISOString();
  assert.equal(
    shortLived < futureNow,
    true,
    "30 秒档位在一分钟后必须满足 expires_at < now，才能被 cron 命中",
  );

  const sevenDays = helpers.calcExpiresAt(7).toISOString();
  assert.equal(helpers.isNeverExpires(sevenDays), false);
});
