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

function loadWorkerEntrypoint() {
  clearModule("index.js");
  clearModule("services/dbSchema.js");
  clearModule("services/adminOverview.js");
  clearModule("routes/adminOverview.js");
  clearModule("routes/adminJobRuns.js");
  clearModule("services/jobRuns.js");
  return require(compiledPath("index.js")).default;
}

function createAuthedRequest(url, role = "admin") {
  const request = new Request(url, { method: "GET" });
  request.user = {
    id: role === "admin" ? "admin-1" : "user-1",
    username: role,
    role,
    status: "active",
    quota_bytes: 1024,
  };
  return request;
}

function createDb({ firstHandlers = [], allHandlers = [], runHandlers = [] }) {
  function consume(list, sql, args, kind) {
    const index = list.findIndex((handler) => handler.match.test(sql));
    if (index === -1) {
      if (
        kind === "run" &&
        (/INSERT INTO rate_limits/.test(sql) ||
          /^(CREATE|ALTER TABLE)/.test(sql.trim()))
      ) {
        return { meta: { changes: 1 } };
      }
      throw new Error(
        `unexpected ${kind} SQL: ${sql} / ${JSON.stringify(args)}`,
      );
    }
    const [handler] = list.splice(index, 1);
    return typeof handler.value === "function"
      ? handler.value(args, sql)
      : handler.value;
  }

  return {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first(columnName) {
                const value = consume(firstHandlers, sql, args, "first");
                if (
                  columnName &&
                  value &&
                  typeof value === "object" &&
                  columnName in value
                ) {
                  return value[columnName];
                }
                return value;
              },
              async all() {
                return consume(allHandlers, sql, args, "all");
              },
              async run() {
                return consume(runHandlers, sql, args, "run");
              },
            };
          },
          async first(columnName) {
            const value = consume(firstHandlers, sql, [], "first");
            if (
              columnName &&
              value &&
              typeof value === "object" &&
              columnName in value
            ) {
              return value[columnName];
            }
            return value;
          },
          async all() {
            return consume(allHandlers, sql, [], "all");
          },
          async run() {
            return consume(runHandlers, sql, [], "run");
          },
        };
      },
    },
  };
}

test("admin overview endpoints require admin permission", async () => {
  const worker = loadWorkerEntrypoint();
  const env = createDb({
    firstHandlers: [
      {
        match: /SELECT blocked_until FROM rate_limits WHERE ip = \?/,
        value: null,
      },
      { match: /SELECT id FROM users LIMIT 1/, value: "user-1" },
    ],
  });

  const response = await worker.fetch(
    createAuthedRequest("https://example.com/api/admin/overview", "user"),
    env,
    {},
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "无权限" });
});

test("admin overview returns metrics, setup state and risks", async () => {
  const worker = loadWorkerEntrypoint();
  const env = createDb({
    firstHandlers: [
      {
        match: /SELECT blocked_until FROM rate_limits WHERE ip = \?/,
        value: null,
      },
      { match: /SELECT id FROM users LIMIT 1/, value: "user-1" },
      { match: /SELECT COUNT\(\*\) AS total FROM users$/, value: { total: 5 } },
      {
        match: /SELECT COUNT\(\*\) AS total FROM users WHERE status = 'active'/,
        value: { total: 4 },
      },
      {
        match:
          /SELECT COUNT\(\*\) AS total FROM users WHERE status = 'disabled'/,
        value: { total: 1 },
      },
      {
        match:
          /SELECT COUNT\(\*\) AS totalFiles, COALESCE\(SUM\(size\), 0\) AS usedSpace FROM files WHERE upload_status = 'completed' AND deleted_at IS NULL/,
        value: { totalFiles: 12, usedSpace: 2048 },
      },
      {
        match:
          /SELECT COUNT\(\*\) AS count FROM files WHERE upload_status IN \('pending','uploading','completed'\) AND deleted_at IS NULL AND expires_at < \?/,
        value: { count: 3 },
      },
      {
        match:
          /SELECT COUNT\(\*\) AS totalTexts,[\s\S]*AS textsUpdated7d,[\s\S]*AS textsUpdated8To30d,[\s\S]*AS textsStaleOver30d[\s\S]*FROM texts[\s\S]*deleted_at IS NULL/,
        value: {
          totalTexts: 268,
          textsUpdated7d: 31,
          textsUpdated8To30d: 94,
          textsStaleOver30d: 143,
        },
      },
      {
        match:
          /SELECT COALESCE\(SUM\(CASE WHEN expires_at IS NULL OR expires_at > \? THEN CASE WHEN max_views > 0 AND views >= max_views THEN 0 ELSE 1 END ELSE 0 END\), 0\) AS activeShares,[\s\S]*AS expiredShares,[\s\S]*AS exhaustedShares[\s\S]*FROM \([\s\S]*FROM file_shares s[\s\S]*INNER JOIN files f ON f\.id = s\.file_id[\s\S]*UNION ALL[\s\S]*FROM text_shares s[\s\S]*INNER JOIN texts t ON t\.id = s\.text_id[\s\S]*\) shares/,
        value: {
          activeShares: 84,
          expiredShares: 11,
          exhaustedShares: 9,
        },
      },
      {
        match:
          /SELECT COALESCE\(SUM\(CASE WHEN consumed_at IS NULL AND expires_at > \? THEN 1 ELSE 0 END\), 0\) AS activeShares,[\s\S]*AS expiredShares,[\s\S]*AS consumedShares[\s\S]*FROM text_one_time_shares s[\s\S]*INNER JOIN texts t ON t\.id = s\.text_id[\s\S]*t\.deleted_at IS NULL/,
        value: {
          activeShares: 6,
          expiredShares: 3,
          consumedShares: 8,
        },
      },
      {
        match:
          /SELECT COUNT\(\*\) AS count FROM delete_queue WHERE processed_at IS NULL/,
        value: { count: 2 },
      },
      {
        match: /SELECT COUNT\(\*\) AS count FROM r2_configs/,
        value: { count: 1 },
      },
      { match: /SELECT value FROM system_config WHERE key = \?/, value: null },
      {
        match:
          /SELECT job_name, status, finished_at, error_message FROM job_runs WHERE status IN \('failed','partial'\) ORDER BY created_at DESC LIMIT 1/,
        value: {
          job_name: "cleanupDeleteQueue",
          status: "failed",
          finished_at: "2026-04-11T00:00:00.000Z",
          error_message: "boom",
        },
      },
    ],
  });

  const response = await worker.fetch(
    createAuthedRequest("https://example.com/api/admin/overview"),
    env,
    {},
  );
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.metrics.totalUsers, 5);
  assert.equal(body.metrics.activeUsers, 4);
  assert.equal(body.metrics.disabledUsers, 1);
  assert.equal(body.metrics.totalFiles, 12);
  assert.equal(body.metrics.usedSpace, 2048);
  assert.equal(body.metrics.expiringThisWeek, 3);
  assert.equal(body.metrics.pendingDeleteQueue, 2);
  assert.equal(body.metrics.totalTexts, 268);
  assert.equal(body.metrics.textsUpdated7d, 31);
  assert.equal(body.metrics.textsUpdated8To30d, 94);
  assert.equal(body.metrics.textsStaleOver30d, 143);
  assert.equal(body.metrics.activeShares, 90);
  assert.equal(body.metrics.expiredShares, 14);
  assert.equal(body.metrics.exhaustedShares, 9);
  assert.equal(body.metrics.consumedShares, 8);
  assert.equal(body.setup.configCount, 1);
  assert.equal(body.setup.defaultConfigId, null);
  assert.equal(body.setup.hasUploadConfig, true);
  assert.deepEqual(
    body.risks.map((item) => item.code),
    ["missing_default_upload_config", "scheduled_job_failed"],
  );
});

test("admin overview requires migrated job_runs table", async () => {
  const worker = loadWorkerEntrypoint();
  const env = createDb({
    firstHandlers: [
      {
        match: /SELECT blocked_until FROM rate_limits WHERE ip = \?/,
        value: null,
      },
      { match: /SELECT id FROM users LIMIT 1/, value: "user-1" },
      { match: /SELECT COUNT\(\*\) AS total FROM users$/, value: { total: 1 } },
      {
        match: /SELECT COUNT\(\*\) AS total FROM users WHERE status = 'active'/,
        value: { total: 1 },
      },
      {
        match:
          /SELECT COUNT\(\*\) AS total FROM users WHERE status = 'disabled'/,
        value: { total: 0 },
      },
      {
        match:
          /SELECT COUNT\(\*\) AS totalFiles, COALESCE\(SUM\(size\), 0\) AS usedSpace FROM files WHERE upload_status = 'completed' AND deleted_at IS NULL/,
        value: { totalFiles: 0, usedSpace: 0 },
      },
      {
        match:
          /SELECT COUNT\(\*\) AS count FROM files WHERE upload_status IN \('pending','uploading','completed'\) AND deleted_at IS NULL AND expires_at < \?/,
        value: { count: 0 },
      },
      {
        match:
          /SELECT COUNT\(\*\) AS totalTexts,[\s\S]*AS textsUpdated7d,[\s\S]*AS textsUpdated8To30d,[\s\S]*AS textsStaleOver30d[\s\S]*FROM texts[\s\S]*deleted_at IS NULL/,
        value: {
          totalTexts: 0,
          textsUpdated7d: 0,
          textsUpdated8To30d: 0,
          textsStaleOver30d: 0,
        },
      },
      {
        match:
          /SELECT COALESCE\(SUM\(CASE WHEN expires_at IS NULL OR expires_at > \? THEN CASE WHEN max_views > 0 AND views >= max_views THEN 0 ELSE 1 END ELSE 0 END\), 0\) AS activeShares,[\s\S]*AS expiredShares,[\s\S]*AS exhaustedShares[\s\S]*FROM \([\s\S]*FROM file_shares s[\s\S]*INNER JOIN files f ON f\.id = s\.file_id[\s\S]*UNION ALL[\s\S]*FROM text_shares s[\s\S]*INNER JOIN texts t ON t\.id = s\.text_id[\s\S]*\) shares/,
        value: {
          activeShares: 0,
          expiredShares: 0,
          exhaustedShares: 0,
        },
      },
      {
        match:
          /SELECT COALESCE\(SUM\(CASE WHEN consumed_at IS NULL AND expires_at > \? THEN 1 ELSE 0 END\), 0\) AS activeShares,[\s\S]*AS expiredShares,[\s\S]*AS consumedShares[\s\S]*FROM text_one_time_shares s[\s\S]*INNER JOIN texts t ON t\.id = s\.text_id[\s\S]*t\.deleted_at IS NULL/,
        value: {
          activeShares: 0,
          expiredShares: 0,
          consumedShares: 0,
        },
      },
      {
        match:
          /SELECT COUNT\(\*\) AS count FROM delete_queue WHERE processed_at IS NULL/,
        value: { count: 0 },
      },
      {
        match: /SELECT COUNT\(\*\) AS count FROM r2_configs/,
        value: { count: 0 },
      },
      { match: /SELECT value FROM system_config WHERE key = \?/, value: null },
      {
        match:
          /SELECT job_name, status, finished_at, error_message FROM job_runs WHERE status IN \('failed','partial'\) ORDER BY created_at DESC LIMIT 1/,
        value: () => {
          throw new Error("D1_ERROR: no such table: job_runs: SQLITE_ERROR");
        },
      },
    ],
  });

  const response = await worker.fetch(
    createAuthedRequest("https://example.com/api/admin/overview"),
    env,
    {},
  );

  assert.equal(response.status, 500);
  assert.equal(await response.text(), "Internal Server Error");
});

test("admin job-runs endpoint returns parsed summaries", async () => {
  const worker = loadWorkerEntrypoint();
  const env = createDb({
    firstHandlers: [
      {
        match: /SELECT blocked_until FROM rate_limits WHERE ip = \?/,
        value: null,
      },
      { match: /SELECT id FROM users LIMIT 1/, value: "user-1" },
      {
        match: /SELECT COUNT\(\*\) AS total FROM job_runs/,
        value: { total: 2 },
      },
    ],
    allHandlers: [
      {
        match:
          /SELECT id, job_name, status, started_at, finished_at, duration_ms, summary_json, error_message, created_at[\s\S]*FROM job_runs[\s\S]*ORDER BY created_at DESC[\s\S]*LIMIT \? OFFSET \?/,
        value: {
          results: [
            {
              id: "run-2",
              job_name: "cleanupDeleteQueue",
              status: "failed",
              started_at: "2026-04-11T00:00:00.000Z",
              finished_at: "2026-04-11T00:00:01.000Z",
              duration_ms: 1000,
              summary_json: '{"failed":1}',
              error_message: "boom",
              created_at: "2026-04-11T00:00:01.000Z",
            },
            {
              id: "run-1",
              job_name: "cleanupExpired",
              status: "success",
              started_at: "2026-04-10T00:00:00.000Z",
              finished_at: "2026-04-10T00:00:01.000Z",
              duration_ms: 1000,
              summary_json: '{"deletedFiles":2}',
              error_message: null,
              created_at: "2026-04-10T00:00:01.000Z",
            },
          ],
        },
      },
    ],
  });

  const response = await worker.fetch(
    createAuthedRequest("https://example.com/api/admin/job-runs"),
    env,
    {},
  );
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.total, 2);
  assert.equal(body.items.length, 2);
  assert.deepEqual(body.items[0].summary, { failed: 1 });
  assert.deepEqual(body.items[1].summary, { deletedFiles: 2 });
});
