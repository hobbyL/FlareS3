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
  clearModule("scheduled.js");
  return require(compiledPath("index.js")).default;
}

function createDb() {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async first(columnName) {
              if (
                /SELECT blocked_until FROM rate_limits WHERE ip = \?/.test(sql)
              ) {
                return null;
              }
              if (
                /SELECT id FROM users LIMIT 1/.test(sql) &&
                columnName === "id"
              ) {
                return "user-1";
              }
              throw new Error(`unexpected first SQL: ${sql}`);
            },
            async run() {
              if (/INSERT INTO rate_limits/.test(sql)) {
                return { meta: { changes: 1 } };
              }
              if (
                /^(CREATE|UPDATE job_runs|INSERT INTO job_runs)/.test(
                  sql.trim(),
                )
              ) {
                return { meta: { changes: 1 } };
              }
              throw new Error(`unexpected run SQL: ${sql}`);
            },
          };
        },
        async run() {
          if (
            /^(CREATE|UPDATE job_runs|INSERT INTO job_runs)/.test(sql.trim())
          ) {
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected run SQL: ${sql}`);
        },
      };
    },
  };
}

function parseStructuredLogEntry(calls, eventName) {
  for (const args of calls) {
    for (const arg of args) {
      if (typeof arg !== "string") {
        continue;
      }

      try {
        const parsed = JSON.parse(arg);
        if (parsed?.event === eventName) {
          return parsed;
        }
      } catch {
        // ignore non-JSON logs
      }
    }
  }

  return null;
}

test("worker emits structured request error logs for 5xx responses", async () => {
  const worker = loadWorkerEntrypoint();
  const originalConsoleError = console.error;
  const errorCalls = [];
  console.error = (...args) => {
    errorCalls.push(args);
  };

  try {
    const response = await worker.fetch(
      new Request("https://example.com/api/auth/login", {
        method: "POST",
      }),
      { DB: createDb() },
      {},
    );

    assert.equal(response.status, 500);

    const log = parseStructuredLogEntry(errorCalls, "request.error");
    assert.ok(log, "expected a structured request.error log entry");
    assert.equal(log.method, "POST");
    assert.equal(log.path, "/api/auth/login");
    assert.equal(log.status, 500);
    assert.equal(typeof log.requestId, "string");
  } finally {
    console.error = originalConsoleError;
  }
});

test("worker emits structured scheduled cleanup summary logs", async () => {
  mockModule("jobs/cleanupExpired.js", {
    cleanupExpired: async () => ({ deletedFiles: 2 }),
  });
  mockModule("jobs/cleanupDeleteQueue.js", {
    cleanupDeleteQueue: async () => ({ dequeuedFiles: 1 }),
  });
  mockModule("jobs/cleanupRetention.js", {
    cleanupRetention: async () => ({
      sessions: 3,
      rateLimits: 4,
      auditLogs: 5,
    }),
  });

  const worker = loadWorkerEntrypoint();
  const originalConsoleInfo = console.info;
  const infoCalls = [];
  console.info = (...args) => {
    infoCalls.push(args);
  };

  try {
    await worker.scheduled({}, { DB: createDb() }, {});

    const log = parseStructuredLogEntry(
      infoCalls,
      "scheduled.cleanup.completed",
    );
    assert.ok(
      log,
      "expected a structured scheduled.cleanup.completed log entry",
    );
    assert.deepEqual(log.cleanupExpired, { deletedFiles: 2 });
    assert.deepEqual(log.cleanupDeleteQueue, { dequeuedFiles: 1 });
    assert.deepEqual(log.cleanupRetention, {
      sessions: 3,
      rateLimits: 4,
      auditLogs: 5,
    });
  } finally {
    console.info = originalConsoleInfo;
    clearModule("jobs/cleanupExpired.js");
    clearModule("jobs/cleanupDeleteQueue.js");
    clearModule("jobs/cleanupRetention.js");
    clearModule("index.js");
    clearModule("scheduled.js");
  }
});
