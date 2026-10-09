const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

function clearModule(relativePath) {
  delete require.cache[compiledPath(relativePath)];
}

function loadModule(relativePath) {
  const target = compiledPath(relativePath);
  delete require.cache[target];
  return require(target);
}

function loadWorkerEntrypoint() {
  clearModule("index.js");
  return loadModule("index.js").default;
}

/**
 * 内存版公开限流 + health 探测 fake DB。
 *
 * 模拟 allowScopedRequest 的滑动窗口语义：
 * key 不存在或窗口过期 → 计数重置为 1（changes=1 放行）；
 * 窗口内未超限 → 计数 +1（changes=1 放行）；已超限 → changes=0 拒绝。
 * 阈值（maxRequests）与窗口长度均由 SQL 绑定参数驱动，与生产路径一致。
 */
function createHealthDb({ windowMs = 60000 } = {}) {
  const windows = new Map();
  const state = { healthChecks: 0, rateLimitKeys: [] };

  function statementFor(sql, args) {
    return {
      async first() {
        if (/^SELECT 1$/.test(sql.trim())) {
          state.healthChecks += 1;
          return {};
        }
        throw new Error(`unexpected first SQL: ${sql}`);
      },
      async all() {
        throw new Error(`unexpected all SQL: ${sql}`);
      },
      async run() {
        if (/INSERT INTO rate_limits/.test(sql)) {
          const key = args[0];
          const maxRequests = args[args.length - 1];
          state.rateLimitKeys.push(key);
          const now = Date.now();
          const current = windows.get(key);
          const expired =
            !current || now - current.windowStart > Number(windowMs);
          if (expired) {
            windows.set(key, { count: 1, windowStart: now });
            return { meta: { changes: 1 } };
          }
          if (current.count < Number(maxRequests)) {
            current.count += 1;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        throw new Error(`unexpected run SQL: ${sql}`);
      },
    };
  }

  return {
    state,
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            return statementFor(sql, args);
          },
          ...statementFor(sql, []),
        };
      },
    },
  };
}

test("health 探针过限流后保持原有 200 JSON 语义", async () => {
  const worker = loadWorkerEntrypoint();
  const { db, state } = createHealthDb();

  const response = await worker.fetch(
    new Request("https://example.com/health"),
    {
      FLARES3_DEBUG_HEADERS: "1",
      DB: db,
    },
    {},
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  assert.deepEqual(body.checks, { db: "ok" });
  assert.equal(typeof body.timestamp, "string");
  // Server-Timing 观测链路保持工作：health 步骤仍在计时
  assert.match(response.headers.get("Server-Timing") || "", /health;dur=/);
  assert.match(response.headers.get("Server-Timing") || "", /total;dur=/);
  // 先计入公开限流桶，再执行 D1 探测
  assert.ok(
    state.rateLimitKeys.some((key) => key.startsWith("public:")),
    "health 应计入 public:<ip> 全局限流桶",
  );
  assert.equal(state.healthChecks, 1);
});

test("health D1 探测失败时仍返回 503 与 db_error 标记", async () => {
  const worker = loadWorkerEntrypoint();
  const { db } = createHealthDb();
  const originalPrepare = db.prepare.bind(db);
  // 限流计数正常放行，仅让 SELECT 1 探测失败（模拟 D1 故障）
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (/^SELECT 1$/.test(sql.trim())) {
      return {
        ...statement,
        bind() {
          return {
            ...statement,
            async first() {
              throw new Error("simulated d1 outage");
            },
          };
        },
        async first() {
          throw new Error("simulated d1 outage");
        },
      };
    }
    return statement;
  };

  const response = await worker.fetch(
    new Request("https://example.com/health"),
    {
      DB: db,
    },
    {},
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.status, "degraded");
  assert.equal(body.db_error, true);
});

test("高频 health 请求触发公开限流 429 且不再执行 D1 探测", async () => {
  const worker = loadWorkerEntrypoint();
  const { db, state } = createHealthDb();

  const first = await worker.fetch(
    new Request("https://example.com/health"),
    {
      DB: db,
      // 阈值经 getRateLimitConfig 从 env 读取，走真实配置链路
      PUBLIC_RATE_LIMIT_MAX: "1",
    },
    {},
  );
  assert.equal(first.status, 200);

  const second = await worker.fetch(
    new Request("https://example.com/health"),
    {
      DB: db,
      PUBLIC_RATE_LIMIT_MAX: "1",
    },
    {},
  );
  const payload = await second.json();

  // 读放大防护的直接证据：超限请求在触达 D1 探测前被限流拒绝
  assert.equal(second.status, 429);
  assert.equal(payload.error, "请求频率超限");
  assert.equal(state.healthChecks, 1, "被限流的请求不得执行 SELECT 1");
});

test("origin 校验对 health 同样生效（跨源 unsafe 请求 403）", async () => {
  const worker = loadWorkerEntrypoint();
  const response = await worker.fetch(
    new Request("https://example.com/health", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
      },
    }),
    {
      DB: {
        prepare() {
          throw new Error("cross-origin health probe should not touch D1");
        },
      },
    },
    {},
  );
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.deepEqual(payload, { error: "跨源请求被拒绝" });
});

test("/api/health 与 /health 行为一致，同样受公开限流约束", async () => {
  const worker = loadWorkerEntrypoint();
  const { db, state } = createHealthDb();

  const first = await worker.fetch(
    new Request("https://example.com/api/health"),
    { DB: db, PUBLIC_RATE_LIMIT_MAX: "1" },
    {},
  );
  assert.equal(first.status, 200);
  assert.equal((await first.json()).status, "ok");

  const second = await worker.fetch(
    new Request("https://example.com/api/health"),
    { DB: db, PUBLIC_RATE_LIMIT_MAX: "1" },
    {},
  );
  assert.equal(second.status, 429);
  assert.equal(state.healthChecks, 1);
});
