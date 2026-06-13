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

function loadWorkerEntrypoint() {
  clearModule("index.js");
  return require(compiledPath("index.js")).default;
}

function createDb() {
  const state = {
    runs: [],
  };

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
          async run() {
            state.runs.push({ sql, args: [] });
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };
}

test("worker.scheduled records job_runs for each cleanup task", async () => {
  mockModule("jobs/cleanupExpired.js", {
    cleanupExpired: async () => ({
      jobName: "cleanupExpired",
      status: "success",
      processed: 2,
      succeeded: 2,
      failed: 0,
      startedAt: "2026-04-11T00:00:00.000Z",
      finishedAt: "2026-04-11T00:00:01.000Z",
      durationMs: 1000,
      details: { deletedFiles: 2 },
    }),
  });
  mockModule("jobs/cleanupDeleteQueue.js", {
    cleanupDeleteQueue: async () => ({
      jobName: "cleanupDeleteQueue",
      status: "success",
      processed: 1,
      succeeded: 1,
      failed: 0,
      startedAt: "2026-04-11T00:00:02.000Z",
      finishedAt: "2026-04-11T00:00:03.000Z",
      durationMs: 1000,
      details: { dequeuedFiles: 1 },
    }),
  });
  mockModule("jobs/cleanupRetention.js", {
    cleanupRetention: async () => ({
      jobName: "cleanupRetention",
      status: "success",
      processed: 9,
      succeeded: 9,
      failed: 0,
      startedAt: "2026-04-11T00:00:04.000Z",
      finishedAt: "2026-04-11T00:00:05.000Z",
      durationMs: 1000,
      details: { sessions: 3, rateLimits: 4, auditLogs: 2 },
    }),
  });

  const worker = loadWorkerEntrypoint();
  const { db, state } = createDb();

  try {
    await worker.scheduled({}, { DB: db }, {});

    const inserts = state.runs.filter((entry) =>
      String(entry.sql).includes("INSERT INTO job_runs"),
    );
    const updates = state.runs.filter((entry) =>
      /UPDATE job_runs[\s\S]*SET status = \?/.test(String(entry.sql)),
    );

    assert.equal(inserts.length, 3);
    assert.equal(updates.length, 3);
    assert.deepEqual(
      inserts.map((entry) => entry.args[1]),
      ["cleanupExpired", "cleanupDeleteQueue", "cleanupRetention"],
    );
    assert.deepEqual(
      updates.map((entry) => entry.args[0]),
      ["success", "success", "success"],
    );

    const summaries = updates.map((entry) => JSON.parse(entry.args[3]));
    assert.deepEqual(summaries, [
      { deletedFiles: 2 },
      { dequeuedFiles: 1 },
      { sessions: 3, rateLimits: 4, auditLogs: 2 },
    ]);
  } finally {
    clearModule("jobs/cleanupExpired.js");
    clearModule("jobs/cleanupDeleteQueue.js");
    clearModule("jobs/cleanupRetention.js");
    clearModule("index.js");
  }
});
