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

function clearModule(relativePath) {
  delete require.cache[compiledPath(relativePath)];
}

function createLifecycleDb({ firstHandlers = [], runHandlers = [] }) {
  const state = { firsts: [], runs: [], batches: [] };

  function consume(list, sql, args, kind) {
    const index = list.findIndex((handler) => handler.match.test(sql));
    if (index === -1) {
      throw new Error(
        `unexpected ${kind} SQL: ${sql} / ${JSON.stringify(args)}`,
      );
    }
    const [handler] = list.splice(index, 1);
    return typeof handler.value === "function"
      ? handler.value(args, sql, state)
      : handler.value;
  }

  function createBoundStatement(sql, args) {
    return {
      __sql: sql,
      __args: args,
      async first(columnName) {
        state.firsts.push({ sql, args, columnName });
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
        throw new Error(`unexpected all SQL: ${sql}`);
      },
      async run() {
        state.runs.push({ sql, args });
        return consume(runHandlers, sql, args, "run");
      },
    };
  }

  return {
    state,
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            return createBoundStatement(sql, args);
          },
        };
      },
      async batch(statements) {
        state.batches.push(
          statements.map((statement) => ({
            sql: statement.__sql,
            args: statement.__args || [],
          })),
        );
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        return results;
      },
    },
  };
}

function createAuthedPostRequest(url) {
  return Object.assign(new Request(url, { method: "POST" }), {
    user: { id: "user-1", role: "admin", username: "alice" },
  });
}

function trashFileRow(overrides = {}) {
  return {
    id: "file-1",
    owner_id: "user-1",
    r2_key: "flares3/config-1/demo.bin",
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    upload_status: "deleted",
    deleted_at: new Date(Date.now() - 60 * 1000).toISOString(),
    config_id: null,
    ...overrides,
  };
}

function loadFilesRouteModules() {
  clearModule("routes/files.js");
  clearModule("services/storage/factory.js");
  const r2 = loadModule("services/r2.js");
  const files = loadModule("routes/files.js");
  return { r2, files };
}

function firstHandlerFor(file) {
  return {
    match:
      /SELECT id, owner_id, r2_key, expires_at, upload_status, deleted_at, config_id FROM files WHERE id = \? LIMIT 1/,
    value: file,
  };
}

const RESTORE_BATCH_RUN_HANDLERS = [
  {
    match:
      /UPDATE files SET upload_status = 'completed', deleted_at = NULL, multipart_upload_id = NULL WHERE id = \?/,
    value: { meta: { changes: 1 } },
  },
  {
    match:
      /UPDATE upload_reservations SET status = \?, updated_at = \? WHERE file_id = \? AND status = 'active'/,
    value: { meta: { changes: 0 } },
  },
  {
    match:
      /UPDATE delete_queue SET processed_at = \? WHERE file_id = \? AND processed_at IS NULL/,
    value: { meta: { changes: 0 } },
  },
  { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
];

test("restoreFile rejects R2 restore when the object is missing upstream", async () => {
  const { r2, files } = loadFilesRouteModules();
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  let headCalls = 0;
  r2.checkObjectExists = async () => {
    headCalls += 1;
    return false;
  };

  const { db, state } = createLifecycleDb({
    firstHandlers: [firstHandlerFor(trashFileRow())],
    runHandlers: RESTORE_BATCH_RUN_HANDLERS,
  });

  const response = await files.restoreFile(
    createAuthedPostRequest("https://example.com/api/files/file-1/restore"),
    { DB: db },
    "file-1",
  );

  // 对象已丢：409 语义（对齐 provider 分支文案），且不得推进 DB 状态
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "文件对象不存在，无法恢复",
  });
  assert.equal(headCalls, 1);
  assert.equal(state.batches.length, 0, "对象缺失时不得执行恢复 batch");
});

test("restoreFile maps R2 HEAD failures to 502 without touching DB state", async () => {
  const { r2, files } = loadFilesRouteModules();
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.checkObjectExists = async () => {
    throw new Error("upstream boom");
  };

  const { db, state } = createLifecycleDb({
    firstHandlers: [firstHandlerFor(trashFileRow())],
    runHandlers: RESTORE_BATCH_RUN_HANDLERS,
  });
  const originalError = console.error;
  console.error = () => {};
  let response;
  try {
    response = await files.restoreFile(
      createAuthedPostRequest("https://example.com/api/files/file-1/restore"),
      { DB: db },
      "file-1",
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /文件恢复校验失败/);
  assert.equal(state.batches.length, 0, "HEAD 异常时不得执行恢复 batch");
});

test("restoreFile restores R2 files when the object still exists", async () => {
  const { r2, files } = loadFilesRouteModules();
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  const headKeys = [];
  r2.checkObjectExists = async (_config, key) => {
    headKeys.push(key);
    return true;
  };

  const { db, state } = createLifecycleDb({
    firstHandlers: [firstHandlerFor(trashFileRow())],
    runHandlers: RESTORE_BATCH_RUN_HANDLERS,
  });

  const response = await files.restoreFile(
    createAuthedPostRequest("https://example.com/api/files/file-1/restore"),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  assert.deepEqual(headKeys, ["flares3/config-1/demo.bin"]);
  assert.equal(state.batches.length, 1);
});
