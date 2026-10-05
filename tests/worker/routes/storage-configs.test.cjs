const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");
const TEST_MASTER_KEY = Buffer.alloc(32).toString("base64");

// 与 worker/src/routes/storageConfigs.ts 中 SECRETS_REVEAL_RATE_LIMIT_MAX 保持一致
const SECRETS_REVEAL_RATE_LIMIT_MAX = 10;

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

function createDb() {
  const firstResults = [0];
  return {
    prepare(sql) {
      return {
        sql,
        bind() {
          return this;
        },
        async all() {
          if (/SUBSTR\(r2_key, 9\)/.test(sql)) {
            return {
              results: [
                { config_id: "r2-1", used_space: 123 },
                { config_id: "webdav-1", used_space: 256 },
              ],
            };
          }
          if (/FROM upload_reservations/.test(sql)) {
            return { results: [] };
          }
          throw new Error(`unexpected all SQL: ${sql}`);
        },
        async first() {
          if (!firstResults.length) {
            throw new Error(`unexpected first SQL: ${sql}`);
          }
          return firstResults.shift();
        },
      };
    },
  };
}

function loadStorageConfigsRoute() {
  clearModule("routes/storageConfigs.js");
  clearModule("services/r2.js");
  clearModule("services/storage/webdav-config.js");

  const r2 = loadModule("services/r2.js");
  const webdavConfig = loadModule("services/storage/webdav-config.js");

  r2.listR2ConfigSummaries = async () => ({
    default_config_id: "r2-1",
    legacy_files_config_id: null,
    configs: [
      {
        id: "r2-1",
        name: "Primary R2",
        source: "db",
        endpoint: "https://r2.example.com",
        bucketName: "bucket-a",
        quotaBytes: 1024,
      },
    ],
  });
  r2.loadR2ConfigById = async (_env, id) => {
    if (id !== "r2-1") return null;
    return {
      id: "r2-1",
      source: "db",
      config: {
        endpoint: "https://r2.example.com",
        bucketName: "bucket-a",
        accessKeyId: "access-1",
        secretAccessKey: "secret-1",
      },
    };
  };
  webdavConfig.listWebDAVConfigs = async () => [
    {
      id: "webdav-1",
      name: "Docs",
      type: "webdav",
      endpoint: "https://dav.example.com",
      mount_id: null,
      remote_path: "/docs",
      username: "should-not-leak",
      password: "should-not-leak",
      quotaBytes: 2048,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  webdavConfig.loadWebDAVConfigById = async (_env, id) => {
    if (id !== "webdav-1") return null;
    return {
      id: "webdav-1",
      type: "webdav",
      config: {
        endpoint: "https://dav.example.com",
        username: "dav-user",
        password: "dav-password",
        remotePath: "/docs",
      },
    };
  };

  return loadModule("routes/storageConfigs.js");
}

test("listAllConfigs omits decrypted storage credentials from config list responses", async () => {
  const { listAllConfigs } = loadStorageConfigsRoute();
  const response = await listAllConfigs(
    new Request("https://example.com/api/storage/configs"),
    {
      DB: createDb(),
      TOTAL_STORAGE: "4096",
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.default_config_id, "r2-1");
  assert.equal(payload.configs.length, 2);
  assert.match(
    response.headers.get("X-Flares3-Route-Timing") || "",
    /completedUsageRows=\d+\.\dms/,
  );

  const r2Config = payload.configs.find((config) => config.id === "r2-1");
  assert.equal(r2Config.endpoint, "https://r2.example.com");
  assert.equal(r2Config.bucket_name, "bucket-a");
  assert.equal(Object.hasOwn(r2Config, "access_key_id"), false);
  assert.equal(Object.hasOwn(r2Config, "secret_access_key"), false);

  const webdavConfig = payload.configs.find(
    (config) => config.id === "webdav-1",
  );
  assert.equal(webdavConfig.endpoint, "https://dav.example.com");
  assert.equal(webdavConfig.remote_path, "/docs");
  assert.equal(webdavConfig.usedSpace, 256);
  assert.equal(webdavConfig.usagePercent, 12.5);
  assert.equal(Object.hasOwn(webdavConfig, "username"), false);
  assert.equal(Object.hasOwn(webdavConfig, "password"), false);
});

test("getConfigSecrets returns masked metadata without plaintext credentials", async () => {
  const { getConfigSecrets } = loadStorageConfigsRoute();
  const response = await getConfigSecrets(
    new Request("https://example.com/api/storage/configs/r2-1/secrets?type=r2"),
    { DB: createDb() },
    "r2-1",
  );
  const payload = await response.json();
  const raw = JSON.stringify(payload);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(payload.type, "r2");
  assert.equal(payload.endpoint, "https://r2.example.com");
  assert.equal(payload.bucket_name, "bucket-a");
  assert.equal(payload.access_key_id_masked, "acce****");
  assert.equal(payload.secret_configured, true);
  assert.doesNotMatch(raw, /access-1|secret-1/, "脱敏响应不得包含明文 R2 凭据");
  assert.equal(Object.hasOwn(payload, "access_key_id"), false);
  assert.equal(Object.hasOwn(payload, "secret_access_key"), false);
});

test("getConfigSecrets returns masked WebDAV metadata without plaintext password", async () => {
  const { getConfigSecrets } = loadStorageConfigsRoute();
  const response = await getConfigSecrets(
    new Request(
      "https://example.com/api/storage/configs/webdav-1/secrets?type=webdav",
    ),
    { DB: createDb() },
    "webdav-1",
  );
  const payload = await response.json();
  const raw = JSON.stringify(payload);

  assert.equal(response.status, 200);
  assert.equal(payload.type, "webdav");
  assert.equal(payload.endpoint, "https://dav.example.com");
  assert.equal(payload.remote_path, "/docs");
  assert.equal(payload.username, "dav-user");
  assert.equal(payload.password_configured, true);
  assert.doesNotMatch(raw, /dav-password/, "脱敏响应不得包含明文密码");
  assert.equal(Object.hasOwn(payload, "password"), false);
});

/**
 * 模拟滑动窗口计数语义：对 INSERT INTO rate_limits ... ON CONFLICT 语句，
 * 按真实窗口逻辑返回 meta.changes（超限时为 0，allowScopedRequest 据此拒绝）。
 */
function createRateLimitDb() {
  const counters = new Map();
  const runs = [];

  return {
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async all() {
                throw new Error(`unexpected all SQL: ${sql}`);
              },
              async first() {
                throw new Error(`unexpected first SQL: ${sql}`);
              },
              async run() {
                runs.push({ sql, args });
                if (
                  !sql.includes("INSERT INTO rate_limits (ip, request_count")
                ) {
                  return { error: null, meta: { changes: 1 } };
                }
                // bind 顺序与 allowScopedRequest 一致：
                // key, nowIso, nowSeconds, windowMs, ..., maxRequests
                const key = args[0];
                const nowSeconds = Number(args[2]);
                const windowMs = Number(args[3]);
                const maxRequests = Number(args[10]);
                const row = counters.get(key);
                if (!row || (nowSeconds - row.startSeconds) * 1000 > windowMs) {
                  counters.set(key, {
                    count: 1,
                    startSeconds: nowSeconds,
                  });
                  return { error: null, meta: { changes: 1 } };
                }
                if (row.count < maxRequests) {
                  row.count += 1;
                  return { error: null, meta: { changes: 1 } };
                }
                return { error: null, meta: { changes: 0 } };
              },
            };
          },
          async all() {
            throw new Error(`unexpected all SQL: ${sql}`);
          },
          async first() {
            throw new Error(`unexpected first SQL: ${sql}`);
          },
          async run() {
            throw new Error(`unexpected run SQL: ${sql}`);
          },
        };
      },
    },
    runs,
  };
}

test("revealConfigSecrets returns plaintext R2 credentials and writes audit log", async () => {
  const { revealConfigSecrets } = loadStorageConfigsRoute();
  const { db, runs } = createRateLimitDb();
  const request = new Request(
    "https://example.com/api/storage/configs/r2-1/secrets/reveal?type=r2",
  );
  request.user = { id: "admin-1", role: "admin" };

  const response = await revealConfigSecrets(request, { DB: db }, "r2-1");
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.access_key_id, "access-1");
  assert.equal(payload.secret_access_key, "secret-1");

  const rateLimitRun = runs.find((run) =>
    /INSERT INTO rate_limits \(ip, request_count, window_start\)/.test(run.sql),
  );
  assert.ok(rateLimitRun, "reveal 必须先过 per-configId 限流计数");
  assert.equal(rateLimitRun.args[0], "secrets-reveal:r2-1");

  const auditRun = runs.find((run) => /INSERT INTO audit_logs/.test(run.sql));
  assert.ok(auditRun, "reveal 成功后必须写审计日志");
  assert.equal(auditRun.args[2], "storage_config_secrets_reveal");
  assert.equal(auditRun.args[4], "r2-1");
});

test("revealConfigSecrets blocks requests once the per-config rate limit is exhausted", async () => {
  const { revealConfigSecrets } = loadStorageConfigsRoute();
  const { db, runs } = createRateLimitDb();

  // 首次调用放行（meta.changes = 1）
  const firstRequest = new Request(
    "https://example.com/api/storage/configs/r2-1/secrets/reveal?type=r2",
  );
  firstRequest.user = { id: "admin-1", role: "admin" };
  const first = await revealConfigSecrets(firstRequest, { DB: db }, "r2-1");
  assert.equal(first.status, 200);

  // 耗尽剩余额度后，下一次调用应返回 429 且不触发审计
  for (let i = 0; i < SECRETS_REVEAL_RATE_LIMIT_MAX - 1; i += 1) {
    const request = new Request(
      "https://example.com/api/storage/configs/r2-1/secrets/reveal?type=r2",
    );
    request.user = { id: "admin-1", role: "admin" };
    const response = await revealConfigSecrets(request, { DB: db }, "r2-1");
    assert.equal(response.status, 200);
  }

  const blockedRequest = new Request(
    "https://example.com/api/storage/configs/r2-1/secrets/reveal?type=r2",
  );
  blockedRequest.user = { id: "admin-1", role: "admin" };
  const blocked = await revealConfigSecrets(blockedRequest, { DB: db }, "r2-1");
  const payload = await blocked.json();

  assert.equal(blocked.status, 429);
  assert.deepEqual(payload, { error: "操作过于频繁，请稍后再试" });

  const auditRuns = runs.filter((run) =>
    /INSERT INTO audit_logs/.test(run.sql),
  );
  assert.equal(
    auditRuns.length,
    SECRETS_REVEAL_RATE_LIMIT_MAX,
    "被限流的请求不写审计",
  );
});

test("revealConfigSecrets rejects invalid type and missing config", async () => {
  const { revealConfigSecrets } = loadStorageConfigsRoute();
  const { db } = createRateLimitDb();

  const invalidTypeRequest = new Request(
    "https://example.com/api/storage/configs/r2-1/secrets/reveal?type=ftp",
  );
  invalidTypeRequest.user = { id: "admin-1", role: "admin" };
  const invalidType = await revealConfigSecrets(
    invalidTypeRequest,
    { DB: db },
    "r2-1",
  );
  assert.equal(invalidType.status, 400);

  const missingRequest = new Request(
    "https://example.com/api/storage/configs/missing/secrets/reveal?type=webdav",
  );
  missingRequest.user = { id: "admin-1", role: "admin" };
  const missing = await revealConfigSecrets(
    missingRequest,
    { DB: db },
    "missing",
  );
  assert.equal(missing.status, 404);
});

test("legacy WebDAV config list omits decrypted credentials", async () => {
  clearModule("routes/webdavConfigs.js");
  clearModule("services/storage/webdav-config.js");

  const webdavConfig = loadModule("services/storage/webdav-config.js");
  webdavConfig.listWebDAVConfigs = async () => [
    {
      id: "webdav-1",
      name: "Docs",
      type: "webdav",
      endpoint: "https://dav.example.com",
      mount_id: null,
      remote_path: "/docs",
      username: "should-not-leak",
      password: "should-not-leak",
      quotaBytes: 2048,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  const { listConfigs } = loadModule("routes/webdavConfigs.js");
  const response = await listConfigs(
    new Request("https://example.com/api/webdav/configs"),
    {
      DB: createDb(),
      R2_MASTER_KEY: TEST_MASTER_KEY,
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.configs.length, 1);
  assert.equal(payload.configs[0].endpoint, "https://dav.example.com");
  assert.equal(Object.hasOwn(payload.configs[0], "username"), false);
  assert.equal(Object.hasOwn(payload.configs[0], "password"), false);
});
