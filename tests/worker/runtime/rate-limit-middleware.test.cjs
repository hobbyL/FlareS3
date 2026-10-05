const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

const {
  rateLimitMiddleware,
  getClientIp,
  recordFailedAttempt,
  recordSharePasswordFailedAttempt,
  clearSharePasswordFailedAttempts,
  isSharePasswordBlocked,
} = require(path.join(COMPILED_ROOT, "middleware/rateLimit.js"));

/**
 * 内存版 rate_limits 表，覆盖中间件实际用到的三类语句：
 * 滑动窗口计数 INSERT ... ON CONFLICT、封禁查询 SELECT blocked_until、以及重置 UPDATE。
 */
function createFakeD1() {
  const rows = new Map();
  const statements = [];

  function runInsertCounter(args) {
    // bind 顺序: key, nowIso, nowSeconds, windowMs, nowIso, nowSeconds, windowMs, nowIso, nowSeconds, windowMs, maxRequests
    const [key, nowIso] = args;
    const nowSeconds = Number(args[2]);
    const windowMs = Number(args[3]);
    const maxRequests = Number(args[10]);

    const row = rows.get(key);
    if (!row || !row.window_start) {
      rows.set(key, {
        ...(row || {}),
        request_count: 1,
        window_start: nowIso,
      });
      return { error: null, meta: { changes: 1 } };
    }

    const startSeconds = Math.floor(
      new Date(row.window_start).getTime() / 1000,
    );
    if ((nowSeconds - startSeconds) * 1000 > windowMs) {
      row.request_count = 1;
      row.window_start = nowIso;
      return { error: null, meta: { changes: 1 } };
    }

    if (row.request_count < maxRequests) {
      row.request_count += 1;
      return { error: null, meta: { changes: 1 } };
    }

    // WHERE 条件不满足，D1 不会更新任何行
    return { error: null, meta: { changes: 0 } };
  }

  function runFailedAttempts(args) {
    const [key, threshold, blockedUntil] = args;
    const row = rows.get(key) || { failed_attempts: 0, blocked_until: null };
    row.failed_attempts = (row.failed_attempts || 0) + 1;
    if (row.failed_attempts >= Number(threshold)) {
      row.blocked_until = blockedUntil;
    }
    rows.set(key, row);
    return { error: null, meta: { changes: 1 } };
  }

  function runReset(args) {
    const row = rows.get(args[0]);
    if (row) {
      row.blocked_until = null;
      row.failed_attempts = 0;
    }
    return { error: null, meta: { changes: row ? 1 : 0 } };
  }

  return {
    rows,
    statements,
    seed(key, row) {
      rows.set(key, { request_count: 0, ...row });
    },
    prepare(sql) {
      statements.push(sql);
      return {
        bind(...args) {
          return {
            async first(column) {
              if (!sql.includes("SELECT blocked_until")) {
                throw new Error(`unexpected first() for: ${sql}`);
              }
              const row = rows.get(args[0]);
              if (!row) return null;
              const value = row[column || "blocked_until"];
              return value === undefined ? null : value;
            },
            async run() {
              if (sql.includes("INSERT INTO rate_limits (ip, request_count")) {
                return runInsertCounter(args);
              }
              if (
                sql.includes("INSERT INTO rate_limits (ip, failed_attempts")
              ) {
                return runFailedAttempts(args);
              }
              if (sql.startsWith("UPDATE rate_limits")) {
                return runReset(args);
              }
              throw new Error(`unexpected run() for: ${sql}`);
            },
          };
        },
      };
    },
    // withD1Retry 包装后的 batch 会解包语句并逐条执行同一套 fake 逻辑
    async batch(bindGroups) {
      return Promise.all(bindGroups.map((group) => group.run()));
    },
  };
}

function makeRequest(url, { method = "GET", headers = {} } = {}) {
  return new Request(url, { method, headers });
}

function makeEnv(db, vars = {}) {
  return { DB: db, ...vars };
}

const LOGIN_URL = "https://example.com/api/auth/login";

function captureError(fn) {
  const original = console.error;
  const entries = [];
  console.error = (...args) => entries.push(args);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.error = original;
    })
    .then((result) => ({ result, entries }));
}

test("getClientIp 仅信任 CF-Connecting-IP，伪造 X-Forwarded-For 不生效", () => {
  assert.equal(
    getClientIp(
      makeRequest("https://example.com/", {
        headers: {
          "CF-Connecting-IP": "1.1.1.1",
          "X-Forwarded-For": "2.2.2.2",
        },
      }),
    ),
    "1.1.1.1",
  );
  // XFF 首值可被客户端伪造，不再作为回退来源
  assert.equal(
    getClientIp(
      makeRequest("https://example.com/", {
        headers: { "X-Forwarded-For": " 3.3.3.3 , 4.4.4.4" },
      }),
    ),
    "unknown",
  );
  assert.equal(getClientIp(makeRequest("https://example.com/")), "unknown");
});

test("非限流路径直接放行且不触碰数据库", async () => {
  const db = createFakeD1();

  for (const [url, method] of [
    ["https://example.com/api/files", "GET"],
    ["https://example.com/api/auth/login", "GET"],
    ["https://example.com/api/auth/status", "POST"],
    ["https://example.com/api/files/abc/info", "GET"],
  ]) {
    assert.equal(
      await rateLimitMiddleware(makeRequest(url, { method }), makeEnv(db)),
      undefined,
      `${method} ${url} 不应被限流`,
    );
  }
  assert.equal(db.statements.length, 0);
});

test("登录限流阈值来自 RATE_LIMIT_MAX 环境变量", async () => {
  const db = createFakeD1();
  const env = makeEnv(db, { RATE_LIMIT_MAX: "1" });
  const request = () => makeRequest(LOGIN_URL, { method: "POST" });

  assert.equal(await rateLimitMiddleware(request(), env), undefined);

  const blocked = await rateLimitMiddleware(request(), env);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: "请求频率超限" });
});

test("登录限流使用默认阈值时短时间内的少量请求不受影响", async () => {
  const db = createFakeD1();
  const env = makeEnv(db);

  for (let i = 0; i < 10; i++) {
    assert.equal(
      await rateLimitMiddleware(
        makeRequest(LOGIN_URL, { method: "POST" }),
        env,
      ),
      undefined,
      `第 ${i + 1} 次登录请求不应被限流`,
    );
  }
  assert.equal(db.rows.get("unknown").request_count, 10);
});

test("窗口过期后计数归零重新开始", async () => {
  const db = createFakeD1();
  const env = makeEnv(db, {
    RATE_LIMIT_MAX: "1",
    RATE_LIMIT_WINDOW_MS: "1000",
  });
  const request = () => makeRequest(LOGIN_URL, { method: "POST" });

  assert.equal(await rateLimitMiddleware(request(), env), undefined);
  assert.equal((await rateLimitMiddleware(request(), env)).status, 429);

  // 把窗口起点前移到窗口之外
  db.rows.get("unknown").window_start = new Date(
    Date.now() - 10_000,
  ).toISOString();
  assert.equal(await rateLimitMiddleware(request(), env), undefined);
  assert.equal(db.rows.get("unknown").request_count, 1);
});

test("处于封禁期的 IP 收到 429 且不再计数", async () => {
  const db = createFakeD1();
  db.seed("9.9.9.9", {
    blocked_until: new Date(Date.now() + 60_000).toISOString(),
  });

  const response = await rateLimitMiddleware(
    makeRequest(LOGIN_URL, {
      method: "POST",
      headers: { "CF-Connecting-IP": "9.9.9.9" },
    }),
    makeEnv(db),
  );

  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    error: "请求过于频繁，请稍后再试",
  });
  assert.equal(
    db.rows.get("9.9.9.9").request_count,
    0,
    "封禁期内不应再累加计数",
  );
});

test("封禁到期后自动解封并清零失败次数", async () => {
  const db = createFakeD1();
  db.seed("8.8.8.8", {
    blocked_until: new Date(Date.now() - 1_000).toISOString(),
    failed_attempts: 10,
  });

  assert.equal(
    await rateLimitMiddleware(
      makeRequest(LOGIN_URL, {
        method: "POST",
        headers: { "CF-Connecting-IP": "8.8.8.8" },
      }),
      makeEnv(db),
    ),
    undefined,
  );

  const row = db.rows.get("8.8.8.8");
  assert.equal(row.blocked_until, null);
  assert.equal(row.failed_attempts, 0);
});

test("blocked_until 为非法时间时不视为封禁", async () => {
  const db = createFakeD1();
  db.seed("7.7.7.7", { blocked_until: "not-a-date" });

  assert.equal(
    await rateLimitMiddleware(
      makeRequest(LOGIN_URL, {
        method: "POST",
        headers: { "CF-Connecting-IP": "7.7.7.7" },
      }),
      makeEnv(db),
    ),
    undefined,
  );
});

test("公开入口限流阈值来自 PUBLIC_RATE_LIMIT_MAX 环境变量", async () => {
  for (const url of [
    "https://example.com/s/abc123",
    "https://example.com/t/abc123",
    "https://example.com/f/abc123",
    "https://example.com/api/files/abc123/download",
  ]) {
    const db = createFakeD1();
    const env = makeEnv(db, { PUBLIC_RATE_LIMIT_MAX: "1" });

    assert.equal(
      await rateLimitMiddleware(makeRequest(url), env),
      undefined,
      `${url} 首次访问应放行`,
    );

    const blocked = await rateLimitMiddleware(makeRequest(url), env);
    assert.equal(blocked.status, 429, `${url} 超限后应返回 429`);
    assert.deepEqual(await blocked.json(), { error: "请求频率超限" });
  }
});

test("公开入口同时维护全局 key 和按类别 key，随机路径不再单独建行", async () => {
  const db = createFakeD1();
  const env = makeEnv(db, { PUBLIC_RATE_LIMIT_MAX: "5" });

  await rateLimitMiddleware(makeRequest("https://example.com/s/aaa"), env);
  await rateLimitMiddleware(makeRequest("https://example.com/s/bbb"), env);

  assert.equal(
    db.rows.get("public:unknown").request_count,
    2,
    "全局 key 累计两次",
  );
  assert.equal(
    db.rows.get("public:unknown:s").request_count,
    2,
    "同类别共享一个计数桶",
  );
  assert.equal(
    db.rows.has("public:unknown:/s/aaa"),
    false,
    "完整 pathname 不再建行",
  );
  assert.equal(
    db.rows.has("public:unknown:/s/bbb"),
    false,
    "完整 pathname 不再建行",
  );
  assert.equal(db.rows.has("unknown"), false, "公开限流不得污染登录 IP 记录");
});

test("单条类别超限不影响该 IP 的其他类别", async () => {
  const db = createFakeD1();
  const env = makeEnv(db, {
    PUBLIC_RATE_LIMIT_MAX: "50",
  });

  // 手动把 /s/ 类别 key 顶到上限
  db.seed("public:unknown:s", {
    request_count: 50,
    window_start: new Date().toISOString(),
  });

  const blocked = await rateLimitMiddleware(
    makeRequest("https://example.com/s/hot"),
    env,
  );
  assert.equal(blocked.status, 429);

  assert.equal(
    await rateLimitMiddleware(makeRequest("https://example.com/t/cold"), env),
    undefined,
  );
});

test("数据库异常时返回 500 并记录日志，而不是把异常抛给上层", async () => {
  const db = {
    prepare() {
      throw new Error("D1_ERROR: connection lost");
    },
  };

  const { result, entries } = await captureError(() =>
    rateLimitMiddleware(
      makeRequest(LOGIN_URL, { method: "POST" }),
      makeEnv(db),
    ),
  );

  assert.equal(result.status, 500);
  assert.deepEqual(await result.json(), { error: "服务异常" });
  assert.equal(entries.length, 1);
  // 收口为 logStructured 后输出单行 JSON，按结构化字段断言
  const log = JSON.parse(entries[0][0]);
  assert.equal(log.level, "error");
  assert.equal(log.event, "rateLimit.middleware_failed");
  assert.match(String(log.error), /D1_ERROR: connection lost/);
});

test("recordFailedAttempt 按环境变量写入封禁阈值与时长", async () => {
  const db = createFakeD1();
  const env = makeEnv(db, {
    RATE_LIMIT_MAX_FAILED_ATTEMPTS: "2",
    RATE_LIMIT_BLOCK_DURATION_MS: "60000",
  });

  const before = Date.now();
  await recordFailedAttempt(env, "5.5.5.5");
  assert.equal(db.rows.get("5.5.5.5").blocked_until, null, "未达阈值不封禁");

  await recordFailedAttempt(env, "5.5.5.5");
  const row = db.rows.get("5.5.5.5");
  assert.equal(row.failed_attempts, 2);
  assert.ok(row.blocked_until, "达到阈值应写入封禁时间");

  const blockedMs = new Date(row.blocked_until).getTime() - before;
  assert.ok(
    blockedMs >= 60_000 && blockedMs < 70_000,
    `封禁时长应约为 60s，实际 ${blockedMs}ms`,
  );
});

test("分享码密码错误计数使用 share: 前缀且阈值可配置", async () => {
  const db = createFakeD1();
  const env = makeEnv(db, {
    SHARE_RATE_LIMIT_MAX_FAILED_ATTEMPTS: "2",
    SHARE_RATE_LIMIT_BLOCK_DURATION_MS: "30000",
  });

  assert.equal(await isSharePasswordBlocked(env, "code1", "6.6.6.6"), false);

  await recordSharePasswordFailedAttempt(env, "code1", "6.6.6.6");
  assert.equal(await isSharePasswordBlocked(env, "code1", "6.6.6.6"), false);

  await recordSharePasswordFailedAttempt(env, "code1", "6.6.6.6");
  assert.equal(await isSharePasswordBlocked(env, "code1", "6.6.6.6"), true);

  assert.equal(db.rows.has("share:code1:6.6.6.6"), true);
  // 分享码维度（不含 IP）同步计数，换 IP 也封禁
  assert.equal(db.rows.get("share-pass:code1").failed_attempts, 2);
  assert.equal(
    await isSharePasswordBlocked(env, "code1", "9.9.9.9"),
    true,
    "换 IP 仍被封禁",
  );
  assert.equal(
    await isSharePasswordBlocked(env, "code2", "6.6.6.6"),
    false,
    "不同分享码互不影响",
  );

  await clearSharePasswordFailedAttempts(env, "code1", "6.6.6.6");
  assert.equal(await isSharePasswordBlocked(env, "code1", "6.6.6.6"), false);
  assert.equal(db.rows.get("share:code1:6.6.6.6").failed_attempts, 0);
  assert.equal(
    db.rows.get("share-pass:code1").failed_attempts,
    0,
    "成功后清除分享码维度计数",
  );
});

test("分享码封禁到期后自动解封", async () => {
  const db = createFakeD1();
  const env = makeEnv(db);
  db.seed("share:code9:1.2.3.4", {
    failed_attempts: 5,
    blocked_until: new Date(Date.now() - 1_000).toISOString(),
  });

  assert.equal(await isSharePasswordBlocked(env, "code9", "1.2.3.4"), false);
  const row = db.rows.get("share:code9:1.2.3.4");
  assert.equal(row.blocked_until, null);
  assert.equal(row.failed_attempts, 0);
});
