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

function createLifecycleDb({
  firstHandlers = [],
  allHandlers = [],
  runHandlers = [],
}) {
  const state = { firsts: [], alls: [], runs: [], batches: [] };

  function consume(list, sql, args, kind) {
    const index = list.findIndex((handler) => handler.match.test(sql));
    if (index === -1) {
      throw new Error(
        `unexpected ${kind} SQL: ${sql} / ${JSON.stringify(args)}`,
      );
    }
    const handler = list[index];
    // 标记 persistent 的 handler 按 SQL 形态匹配、可重复服务（如逐文件 audit）；
    // 未标记的保持一次性消耗语义
    if (!handler.persistent) {
      list.splice(index, 1);
    }
    return typeof handler.value === "function"
      ? handler.value(args, sql, state)
      : handler.value;
  }

  function createBoundStatement(sql, args) {
    return {
      __sql: sql,
      __args: args,
      async first() {
        state.firsts.push({ sql, args });
        return consume(firstHandlers, sql, args, "first");
      },
      async all() {
        state.alls.push({ sql, args });
        return consume(allHandlers, sql, args, "all");
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
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        state.batches.push(
          statements.map((statement) => ({
            sql: statement.__sql,
            args: statement.__args || [],
          })),
        );
        return results;
      },
    },
  };
}

const USER = { id: "user-1", role: "user", username: "alice" };

function authedPostRequest(url, body, { user } = {}) {
  return Object.assign(
    new Request(url, { method: "POST", body: JSON.stringify(body) }),
    {
      user: user || USER,
    },
  );
}

function loadFilesRouteModules() {
  clearModule("routes/files.js");
  clearModule("services/storage/factory.js");
  clearModule("services/r2.js");
  const storageFactory = loadModule("services/storage/factory.js");
  const r2 = loadModule("services/r2.js");
  const files = loadModule("routes/files.js");
  return { storageFactory, r2, files };
}

function selectByIdsHandler(rows) {
  return {
    match: /FROM files WHERE id IN \(/,
    value: (args, sql, state) => {
      // SELECT ... WHERE id IN (?,?) → 按 args 顺序返回行
      void state;
      const ids = args;
      return {
        results: ids
          .map((id) => rows.find((row) => row.id === id))
          .filter(Boolean),
      };
    },
  };
}

// ── body 契约守卫（三端点共用）──

test("batch endpoints reject empty ids / oversized ids / invalid JSON", async () => {
  const { files } = loadFilesRouteModules();

  // 空 ids
  for (const handler of [
    files.batchDeleteFiles,
    files.batchRestoreFiles,
    files.batchPermanentDeleteFiles,
  ]) {
    const response = await handler(
      authedPostRequest("https://example.com/api/files/batch-delete", {
        ids: [],
      }),
      { DB: null },
    );
    assert.equal(response.status, 400);
  }

  // ids 全部为空白 → 去空后为空
  const whitespaceResponse = await files.batchDeleteFiles(
    authedPostRequest("https://example.com/api/files/batch-delete", {
      ids: ["  ", "", null, undefined],
    }),
    { DB: null },
  );
  assert.equal(whitespaceResponse.status, 400);
  assert.deepEqual(await whitespaceResponse.json(), { error: "ids 不能为空" });

  // 超上限（101 个）
  const ids = Array.from({ length: 101 }, (_, index) => `file-${index}`);
  const oversizeResponse = await files.batchDeleteFiles(
    authedPostRequest("https://example.com/api/files/batch-delete", { ids }),
    { DB: null },
  );
  assert.equal(oversizeResponse.status, 400);
  assert.deepEqual(await oversizeResponse.json(), {
    error: "一次最多处理 100 个文件",
  });
});

// ── batch-delete ──

test("batchDeleteFiles skips forbidden / missing / already_trashed and deletes the rest", async () => {
  const { files } = loadFilesRouteModules();
  const rows = [
    {
      id: "file-ok",
      owner_id: "user-1",
      upload_status: "completed",
      deleted_at: null,
    },
    // 他人文件：user_id 不匹配 → forbidden
    {
      id: "file-foreign",
      owner_id: "someone-else",
      upload_status: "completed",
      deleted_at: null,
    },
    // 已在回收站
    {
      id: "file-trashed",
      owner_id: "user-1",
      upload_status: "deleted",
      deleted_at: "2026-10-01T00:00:00.000Z",
    },
  ];
  const { db, state } = createLifecycleDb({
    allHandlers: [selectByIdsHandler(rows)],
    runHandlers: [
      {
        match: /UPDATE files SET upload_status = 'deleted', deleted_at = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /UPDATE upload_reservations SET status = \?/,
        value: { meta: { changes: 0 } },
      },
      {
        match: /INSERT INTO audit_logs/,
        value: { meta: { changes: 1 } },
        persistent: true,
      },
    ],
  });

  const response = await files.batchDeleteFiles(
    authedPostRequest("https://example.com/api/files/batch-delete", {
      ids: ["file-ok", "file-foreign", "file-trashed", "file-missing"],
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.deleted, 1);
  assert.deepEqual(payload.skipped, [
    { id: "file-foreign", reason: "forbidden" },
    { id: "file-trashed", reason: "already_trashed" },
    { id: "file-missing", reason: "not_found" },
  ]);

  // 通过守卫的文件走单条版同构 batch：UPDATE + release + audit 逐文件
  assert.equal(state.batches.length, 1);
  assert.match(
    state.batches[0][0].sql,
    /UPDATE files SET upload_status = 'deleted', deleted_at = \?/,
  );
  assert.match(state.batches[0][1].sql, /UPDATE upload_reservations/);
  assert.match(state.batches[0][2].sql, /INSERT INTO audit_logs/);
  assert.deepEqual(state.batches[0][0].args.slice(1), ["file-ok"]);
});

// ── batch-restore ──

test("batchRestoreFiles keeps per-file guards: expired / not_in_trash / object_missing", async () => {
  const { r2, files } = loadFilesRouteModules();
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();

  const rows = [
    // 正常 R2 路径（config_id: null → resolveR2ConfigForKey + checkObjectExists）
    {
      id: "file-ok",
      owner_id: "user-1",
      r2_key: "flares3/config-1/demo.bin",
      expires_at: future,
      upload_status: "deleted",
      deleted_at: "2026-10-01T00:00:00.000Z",
      config_id: null,
    },
    // 已过期
    {
      id: "file-expired",
      owner_id: "user-1",
      r2_key: "flares3/config-1/old.bin",
      expires_at: past,
      upload_status: "deleted",
      deleted_at: "2026-09-01T00:00:00.000Z",
      config_id: null,
    },
    // 不在回收站
    {
      id: "file-active",
      owner_id: "user-1",
      r2_key: "flares3/config-1/act.bin",
      expires_at: future,
      upload_status: "completed",
      deleted_at: null,
      config_id: null,
    },
  ];

  // R2 服务 stub（r2 模块已在 loadFilesRouteModules 内与 files 一起重载）
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  const headKeys = [];
  r2.checkObjectExists = async (_config, key) => {
    headKeys.push(key);
    // file-missing-object 的对象已缺失
    return key !== "flares3/config-1/gone.bin";
  };

  rows.push({
    id: "file-missing-object",
    owner_id: "user-1",
    r2_key: "flares3/config-1/gone.bin",
    expires_at: future,
    upload_status: "deleted",
    deleted_at: "2026-10-01T00:00:00.000Z",
    config_id: null,
  });

  const { db, state } = createLifecycleDb({
    allHandlers: [selectByIdsHandler(rows)],
    runHandlers: [
      {
        match:
          /UPDATE files SET upload_status = 'completed', deleted_at = NULL/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /UPDATE upload_reservations SET status = \?/,
        value: { meta: { changes: 0 } },
      },
      {
        match: /UPDATE delete_queue SET processed_at = \?/,
        value: { meta: { changes: 0 } },
      },
      {
        match: /INSERT INTO audit_logs/,
        value: { meta: { changes: 1 } },
        persistent: true,
      },
    ],
  });

  const response = await files.batchRestoreFiles(
    authedPostRequest("https://example.com/api/files/trash/batch-restore", {
      ids: ["file-ok", "file-expired", "file-active", "file-missing-object"],
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.restored, 1);
  assert.deepEqual(payload.skipped, [
    { id: "file-expired", reason: "expired" },
    { id: "file-active", reason: "not_in_trash" },
    { id: "file-missing-object", reason: "object_missing" },
  ]);

  // 对象校验未通过者不得触达恢复 batch
  assert.equal(state.batches.length, 1);
  // R2 路径恢复 batch 含关闭 delete_queue 语句
  assert.equal(state.batches[0].length, 4);
  assert.match(state.batches[0][2].sql, /UPDATE delete_queue SET processed_at/);
  // 仅对通过守卫者的 r2_key 发 HEAD
  assert.deepEqual(headKeys, [
    "flares3/config-1/demo.bin",
    "flares3/config-1/gone.bin",
  ]);
});

// ── batch-permanent-delete ──

test("batchPermanentDeleteFiles routes explicit provider deletes and R2 queue inserts", async () => {
  const { storageFactory, files } = loadFilesRouteModules();
  const deletedKeys = [];
  storageFactory.createProvider = async (_env, configId) => {
    assert.equal(configId, "webdav-1");
    return {
      async delete(key) {
        deletedKeys.push(key);
      },
    };
  };

  const rows = [
    // explicit-provider 直删路径
    {
      id: "file-explicit",
      owner_id: "user-1",
      r2_key: "storage/webdav-1/file-explicit.bin",
      upload_status: "deleted",
      deleted_at: "2026-10-01T00:00:00.000Z",
      config_id: "webdav-1",
    },
    // R2 delete_queue 路径
    {
      id: "file-r2",
      owner_id: "user-1",
      r2_key: "flares3/config-1/queue.bin",
      upload_status: "deleted",
      deleted_at: "2026-10-01T00:00:00.000Z",
      config_id: null,
    },
    // 他人文件 → forbidden
    {
      id: "file-foreign",
      owner_id: "someone-else",
      r2_key: "flares3/config-1/foreign.bin",
      upload_status: "deleted",
      deleted_at: "2026-10-01T00:00:00.000Z",
      config_id: null,
    },
  ];

  const { db, state } = createLifecycleDb({
    allHandlers: [selectByIdsHandler(rows)],
    runHandlers: [
      {
        match: /UPDATE upload_reservations SET status = \?/,
        value: { meta: { changes: 0 } },
      },
      {
        match: /DELETE FROM file_shares WHERE file_id = \?/,
        value: { meta: { changes: 0 } },
      },
      {
        match: /DELETE FROM files WHERE id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /INSERT INTO audit_logs/,
        value: { meta: { changes: 1 } },
        persistent: true,
      },
      {
        match: /INSERT INTO delete_queue/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await files.batchPermanentDeleteFiles(
    authedPostRequest(
      "https://example.com/api/files/trash/batch-permanent-delete",
      {
        ids: ["file-explicit", "file-r2", "file-foreign"],
      },
    ),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.deleted, 1);
  assert.equal(payload.queued, 1);
  assert.deepEqual(payload.skipped, [
    { id: "file-foreign", reason: "forbidden" },
  ]);

  // explicit 路径：provider.delete 被调用 + 直删 batch（release + shares + files + audit）
  assert.deepEqual(deletedKeys, ["storage/webdav-1/file-explicit.bin"]);
  const explicitBatch = state.batches.find((batch) =>
    batch.some((statement) =>
      /DELETE FROM files WHERE id = \?/.test(statement.sql),
    ),
  );
  assert.ok(explicitBatch, "explicit 路径应执行直删 batch");
  assert.equal(explicitBatch.length, 4);

  // R2 路径：enqueue batch（INSERT delete_queue + audit）
  const queueBatch = state.batches.find((batch) =>
    batch.some((statement) => /INSERT INTO delete_queue/.test(statement.sql)),
  );
  assert.ok(queueBatch, "R2 路径应执行 delete_queue 入队 batch");
  assert.equal(queueBatch.length, 2);
});
