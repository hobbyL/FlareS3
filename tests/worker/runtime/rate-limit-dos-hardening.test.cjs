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

/**
 * 记录所有写入，并按「key」维度模拟计数器，用来断言不同维度各用哪套阈值。
 * 只实现被测代码真正发出的 SQL 形态（INSERT ... ON CONFLICT / UPDATE）。
 */
function createRecordingDb() {
  const runs = [];
  return {
    runs,
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async run() {
                runs.push({ sql, args });
                return { success: true, meta: { changes: 1 } };
              },
              async first() {
                return null;
              },
            };
          },
        };
      },
      async batch(statements) {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      },
    },
  };
}

test("用户名维度登录失败使用独立的、更宽松的阈值与更短封禁", async () => {
  const { recordFailedAttemptForUsername } = loadModule(
    "middleware/rateLimit.js",
  );
  const { getRateLimitConfig } = loadModule("config/rateLimit.js");

  const { db, runs } = createRecordingDb();
  const env = { DB: db };
  const config = getRateLimitConfig(env);

  await recordFailedAttemptForUsername(env, "alice");

  assert.equal(runs.length, 1, "用户名维度只应写一条计数");
  const [record] = runs;
  // bind 参数顺序：(key, 阈值, blockedUntil)
  assert.equal(record.args[1], config.loginUsernameMaxFailedAttempts);
  assert.equal(record.args[1], 50, "默认全局阈值应为 50 次");
  // 全局维度阈值必须显著高于 IP 维度，否则匿名 DoS 依然成立
  assert.ok(
    config.loginUsernameMaxFailedAttempts > config.loginMaxFailedAttempts,
    "用户名维度阈值必须高于 IP 维度",
  );
  assert.ok(
    config.loginUsernameBlockDurationMs < config.loginBlockDurationMs,
    "用户名维度封禁时长必须短于 IP 维度",
  );
});

test("匿名攻击者无法用 5 次错误口令锁死他人账号", async () => {
  const { recordFailedAttemptForUsername } = loadModule(
    "middleware/rateLimit.js",
  );
  const { getRateLimitConfig } = loadModule("config/rateLimit.js");

  const { db, runs } = createRecordingDb();
  const env = { DB: db };
  const config = getRateLimitConfig(env);

  // 模拟匿名攻击者对同一用户名发起 5 次失败（上轮报告中的 DoS 手法）
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await recordFailedAttemptForUsername(env, "victim");
  }

  const threshold = runs[0].args[1];
  assert.ok(
    threshold > 5,
    `5 次失败不应达到用户名维度封禁阈值（实际阈值 ${threshold}）`,
  );
});

test("分享码维度使用独立的、更宽松的阈值与更短封禁", async () => {
  const { recordSharePasswordFailedAttempt } = loadModule(
    "middleware/rateLimit.js",
  );
  const { getRateLimitConfig } = loadModule("config/rateLimit.js");

  const { db, runs } = createRecordingDb();
  const env = { DB: db };
  const config = getRateLimitConfig(env);

  await recordSharePasswordFailedAttempt(env, "sharecode1", "203.0.113.9");

  assert.equal(runs.length, 2, "应同时写 IP 维度与分享码维度两条计数");
  const [ipRecord, codeRecord] = runs;

  // IP 维度沿用原有严格阈值
  assert.equal(ipRecord.args[1], config.shareMaxFailedAttempts);
  assert.equal(ipRecord.args[1], 5);

  // 分享码维度用更宽松阈值 + 更短封禁
  assert.equal(codeRecord.args[1], config.shareCodeMaxFailedAttempts);
  assert.equal(codeRecord.args[1], 30);
  assert.ok(
    config.shareCodeMaxFailedAttempts > config.shareMaxFailedAttempts,
    "分享码维度阈值必须高于 IP 维度",
  );
  assert.ok(
    config.shareCodeBlockDurationMs < config.shareBlockDurationMs,
    "分享码维度封禁时长必须短于 IP 维度",
  );

  // 两个维度必须落在不同的 rate_limits key 上，否则会互相污染
  assert.notEqual(ipRecord.args[0], codeRecord.args[0]);
});

test("匿名攻击者无法用 5 次错误口令锁死他人分享", async () => {
  const { recordSharePasswordFailedAttempt } = loadModule(
    "middleware/rateLimit.js",
  );
  const { getRateLimitConfig } = loadModule("config/rateLimit.js");

  const { db, runs } = createRecordingDb();
  const env = { DB: db };
  const config = getRateLimitConfig(env);
  assert.ok(config.shareCodeMaxFailedAttempts > 5);

  // 模拟 5 次错误口令（每个请求来自不同 IP，绕开 IP 维度）
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await recordSharePasswordFailedAttempt(
      env,
      "publicshare",
      `198.51.100.${attempt + 1}`,
    );
  }

  const codeThresholds = runs
    .filter((record) => String(record.args[0]).startsWith("share-pass:"))
    .map((record) => record.args[1]);
  assert.equal(codeThresholds.length, 5);
  for (const threshold of codeThresholds) {
    assert.ok(threshold > 5, "5 次失败不应达到分享码维度封禁阈值");
  }
});

test("登录成功后清零 IP 与用户名两个维度的失败计数", async () => {
  const { clearLoginFailedAttempts } = loadModule("middleware/rateLimit.js");

  const { db, runs } = createRecordingDb();
  await clearLoginFailedAttempts({ DB: db }, "203.0.113.7", "alice");

  assert.equal(runs.length, 1, "清零应为单条 UPDATE ... IN (?, ?)");
  const [record] = runs;
  assert.match(record.sql, /UPDATE\s+rate_limits/i);
  assert.match(record.sql, /failed_attempts\s*=\s*0/i);
  assert.match(record.sql, /blocked_until\s*=\s*NULL/i);

  // 必须同时覆盖裸 IP 与用户名摘要 key
  assert.equal(record.args.length, 2);
  assert.equal(record.args[0], "203.0.113.7");
  assert.match(String(record.args[1]), /^login-user:[0-9a-f]{16}$/);
});

test("登录成功路径确实调用了失败计数清零", () => {
  const fs = require("node:fs");
  // 与既有 config 测试同口径：npm test 从 worker/ 运行，故源码在 src/ 下；
  // 若从仓库根运行则回退到 worker/src/，两种方式都能定位。
  const candidates = [
    path.join(process.cwd(), "src/routes/auth.ts"),
    path.join(process.cwd(), "worker/src/routes/auth.ts"),
  ];
  const sourcePath = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(sourcePath, `未找到 auth.ts，尝试过：${candidates.join(", ")}`);
  const source = fs.readFileSync(sourcePath, "utf8");

  assert.match(
    source,
    /clearLoginFailedAttempts/,
    "login 成功分支必须清零失败计数，否则计数会跨会话累积",
  );
  // 必须位于 LOGIN_SUCCESS 审计之后，即真正的「登录成功」分支
  const successIndex = source.indexOf("'LOGIN_SUCCESS'");
  const clearIndex = source.indexOf("clearLoginFailedAttempts(env, ip");
  assert.ok(successIndex > 0 && clearIndex > successIndex);
});
