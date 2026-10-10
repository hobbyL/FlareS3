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

function mockModule(relativePath, exports) {
  const target = compiledPath(relativePath);
  delete require.cache[target];
  require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    exports,
  };
}

function loadAdminJobs() {
  clearModule("routes/adminJobs.js");
  return require(compiledPath("routes/adminJobs.js"));
}

function createRecordingDb() {
  const state = { runs: [] };
  return {
    state,
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async run() {
                state.runs.push({ sql, args });
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };
}

function createAdminRequest() {
  return {
    user: { id: "admin-1", username: "admin", role: "admin" },
    headers: {
      get(name) {
        if (name === "CF-Connecting-IP") return "1.2.3.4";
        if (name === "User-Agent") return "vitest";
        return null;
      },
    },
  };
}

const JOB_MODULES = [
  "jobs/cleanupExpired.js",
  "jobs/cleanupDeleteQueue.js",
  "jobs/cleanupRetention.js",
];

function clearJobMocks() {
  JOB_MODULES.forEach(clearModule);
  clearModule("routes/adminJobs.js");
}

test("runAdminJob only whitelists the three cleanup jobs", () => {
  clearJobMocks();
  const { ADMIN_JOB_NAMES } = loadAdminJobs();
  assert.deepEqual(ADMIN_JOB_NAMES, [
    "cleanupExpired",
    "cleanupDeleteQueue",
    "cleanupRetention",
  ]);
  clearJobMocks();
});

test("runAdminJob rejects unknown job name with 400 and never touches job_runs", async () => {
  clearJobMocks();
  const { runAdminJob } = loadAdminJobs();
  const { db, state } = createRecordingDb();

  const response = await runAdminJob(
    createAdminRequest(),
    { DB: db },
    "rm -rf",
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "未知的任务名称" });
  assert.equal(state.runs.length, 0, "未知任务名不得写入任何 job_runs");
  clearJobMocks();
});

test("runAdminJob runs whitelisted job, records job_runs + audit, tags manual trigger", async () => {
  clearJobMocks();
  mockModule("jobs/cleanupRetention.js", {
    cleanupRetention: async () => ({
      jobName: "cleanupRetention",
      status: "success",
      processed: 5,
      succeeded: 5,
      failed: 0,
      startedAt: "2026-10-09T00:00:00.000Z",
      finishedAt: "2026-10-09T00:00:00.500Z",
      durationMs: 500,
      details: { textsTrash: 2, filesTrash: 3 },
    }),
  });
  const { runAdminJob } = loadAdminJobs();
  const { db, state } = createRecordingDb();

  const response = await runAdminJob(
    createAdminRequest(),
    { DB: db },
    "cleanupRetention",
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.job_name, "cleanupRetention");
  assert.equal(body.status, "success");
  assert.equal(body.processed, 5);
  assert.equal(body.details.trigger, "manual");
  assert.equal(body.details.filesTrash, 3);

  const insert = state.runs.find((entry) =>
    /INSERT INTO job_runs/.test(entry.sql),
  );
  assert.ok(insert, "必须 startJobRun 留痕");
  assert.equal(insert.args[1], "cleanupRetention");
  assert.equal(insert.args[2], "running");

  const update = state.runs.find((entry) =>
    /UPDATE job_runs[\s\S]*SET status = \?/.test(entry.sql),
  );
  assert.ok(update, "必须 finishJobRun 留痕");
  assert.equal(update.args[0], "success");
  assert.deepEqual(JSON.parse(update.args[3]), {
    textsTrash: 2,
    filesTrash: 3,
    trigger: "manual",
  });

  const audit = state.runs.find((entry) =>
    /INSERT INTO audit_logs/.test(entry.sql),
  );
  assert.ok(audit, "必须登记审计日志");
  assert.equal(audit.args[1], "admin-1");
  assert.equal(audit.args[2], "ADMIN_JOB_RUN");
  assert.equal(audit.args[3], "job");
  assert.equal(audit.args[4], "cleanupRetention");
  clearJobMocks();
});

test("runAdminJob returns 500 but still records job_runs when the job throws", async () => {
  clearJobMocks();
  mockModule("jobs/cleanupExpired.js", {
    cleanupExpired: async () => {
      throw new Error("boom");
    },
  });
  const { runAdminJob } = loadAdminJobs();
  const { db, state } = createRecordingDb();

  const response = await runAdminJob(
    createAdminRequest(),
    { DB: db },
    "cleanupExpired",
  );

  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.status, "failed");
  assert.ok(body.error, "失败响应应带 error 字段");
  assert.equal(body.details.trigger, "manual");

  const update = state.runs.find((entry) =>
    /UPDATE job_runs[\s\S]*SET status = \?/.test(entry.sql),
  );
  assert.ok(update, "失败也必须 finishJobRun 留痕");
  assert.equal(update.args[0], "failed");

  const audit = state.runs.find((entry) =>
    /INSERT INTO audit_logs/.test(entry.sql),
  );
  assert.ok(audit, "失败也应登记审计日志");
  clearJobMocks();
});

// ── 全链路：验证 roleGuard 与路由注册 ──

function loadWorkerEntrypoint() {
  clearModule("index.js");
  clearModule("router.js");
  clearModule("routes/adminJobs.js");
  return require(compiledPath("index.js")).default;
}

function createAuthedRequest(url, role = "admin") {
  const request = new Request(url, { method: "POST" });
  request.user = {
    id: role === "admin" ? "admin-1" : "user-1",
    username: role,
    role,
    status: "active",
    quota_bytes: 1024,
  };
  return request;
}

function createGuardDb() {
  function consume(list, sql, args, kind) {
    const index = list.findIndex((handler) => handler.match.test(sql));
    if (index === -1) {
      if (kind === "run" && /INSERT INTO rate_limits/.test(sql)) {
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
  const firstHandlers = [
    {
      match: /SELECT blocked_until FROM rate_limits WHERE ip = \?/,
      value: null,
    },
    { match: /SELECT id FROM users LIMIT 1/, value: "user-1" },
  ];
  return {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first(col) {
                const value = consume(firstHandlers, sql, args, "first");
                return col && value && typeof value === "object" && col in value
                  ? value[col]
                  : value;
              },
              async run() {
                return consume([], sql, args, "run");
              },
            };
          },
          async first(col) {
            const value = consume(firstHandlers, sql, [], "first");
            return col && value && typeof value === "object" && col in value
              ? value[col]
              : value;
          },
          async run() {
            return consume([], sql, [], "run");
          },
        };
      },
    },
  };
}

test("POST /api/admin/jobs/:name/run rejects non-admin with 403", async () => {
  clearJobMocks();
  const worker = loadWorkerEntrypoint();
  const env = createGuardDb();

  const response = await worker.fetch(
    createAuthedRequest(
      "https://example.com/api/admin/jobs/cleanupRetention/run",
      "user",
    ),
    env,
    {},
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "无权限" });
  clearModule("index.js");
  clearModule("router.js");
});

test("POST /api/admin/jobs/:name/run returns 400 for unknown job via full router", async () => {
  clearJobMocks();
  const worker = loadWorkerEntrypoint();
  const env = createGuardDb();

  const response = await worker.fetch(
    createAuthedRequest("https://example.com/api/admin/jobs/dropTables/run"),
    env,
    {},
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "未知的任务名称" });
  clearModule("index.js");
  clearModule("router.js");
});
