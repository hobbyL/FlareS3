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

// 不清缓存地取 types.js：routes 模块捕获的 StorageError 类必须与这里是同一实例，
// 否则 instanceof 判定失败
function cachedModule(relativePath) {
  return require(compiledPath(relativePath));
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

function createRenameRequest(body, user) {
  const request = new Request("https://example.com/api/files/file-1/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  request.user = user || { id: "user-1", role: "admin", username: "alice" };
  return request;
}

function completedFileRow(overrides = {}) {
  return {
    id: "file-1",
    owner_id: "user-1",
    filename: "demo.bin",
    r2_key: "flares3/config-1/demo.bin",
    size: 2048,
    upload_status: "completed",
    deleted_at: null,
    config_id: null,
    ...overrides,
  };
}

function loadFilesRouteModules() {
  clearModule("routes/files.js");
  clearModule("services/r2.js");
  clearModule("services/storage/r2-provider.js");
  clearModule("services/storage/factory.js");

  const r2 = loadModule("services/r2.js");
  const storageFactory = loadModule("services/storage/factory.js");
  const files = loadModule("routes/files.js");
  return { r2, storageFactory, files };
}

function firstHandlerFor(file) {
  return {
    match:
      /SELECT id, owner_id, filename, r2_key, size, upload_status, deleted_at, config_id FROM files WHERE id = \? LIMIT 1/,
    value: file,
  };
}

// consume 会 splice 消耗 handler，跨测试必须各自取新副本
function renameBatchRunHandlers() {
  return [
    {
      match:
        /UPDATE files SET filename = \?, r2_key = \? WHERE id = \? AND upload_status = 'completed' AND deleted_at IS NULL/,
      value: { meta: { changes: 1 } },
    },
    { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
  ];
}

test("renameFile requires authentication", async () => {
  const { files } = loadFilesRouteModules();
  const request = new Request("https://example.com/api/files/file-1/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_name: "b.txt" }),
  });

  const response = await files.renameFile(request, { DB: {} }, "file-1");

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "未授权" });
});

test("renameFile returns 404 when the file does not exist", async () => {
  const { files } = loadFilesRouteModules();
  const { db } = createLifecycleDb({
    firstHandlers: [firstHandlerFor(null)],
  });

  const response = await files.renameFile(
    createRenameRequest({ new_name: "renamed.bin" }),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "文件不存在" });
});

test("renameFile returns 403 for non-owner non-admin users", async () => {
  const { files } = loadFilesRouteModules();
  const { db, state } = createLifecycleDb({
    firstHandlers: [firstHandlerFor(completedFileRow({ owner_id: "owner-9" }))],
  });

  const response = await files.renameFile(
    createRenameRequest(
      { new_name: "renamed.bin" },
      { id: "user-2", role: "user", username: "mallory" },
    ),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "无权限" });
  assert.equal(state.batches.length, 0);
});

test("renameFile rejects files that are not completed uploads", async () => {
  const { files } = loadFilesRouteModules();
  const { db, state } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(completedFileRow({ upload_status: "pending" })),
    ],
  });

  const response = await files.renameFile(
    createRenameRequest({ new_name: "renamed.bin" }),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "仅完成上传的文件可重命名",
  });
  assert.equal(state.batches.length, 0);
});

test("renameFile rejects invalid filenames and no-op renames", async () => {
  const { files } = loadFilesRouteModules();

  const invalid = await files.renameFile(
    createRenameRequest({ new_name: "sub/renamed.bin" }),
    {
      DB: createLifecycleDb({
        firstHandlers: [firstHandlerFor(completedFileRow())],
      }).db,
    },
    "file-1",
  );
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /路径分隔符/);

  const noop = await files.renameFile(
    createRenameRequest({ new_name: "demo.bin" }),
    {
      DB: createLifecycleDb({
        firstHandlers: [firstHandlerFor(completedFileRow())],
      }).db,
    },
    "file-1",
  );
  assert.equal(noop.status, 400);
  assert.deepEqual(await noop.json(), { error: "新文件名与原文件名相同" });
});

test("renameFile returns 409 when another D1 record already holds the key", async () => {
  const { files } = loadFilesRouteModules();
  const { db, state } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(completedFileRow()),
      {
        match: /SELECT id FROM files WHERE r2_key = \? AND id != \? LIMIT 1/,
        value: "file-2",
      },
    ],
  });

  const response = await files.renameFile(
    createRenameRequest({ new_name: "renamed.bin" }),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "同名文件已存在" });
  assert.equal(state.batches.length, 0);
});

test("renameFile returns 409 when the remote object key is occupied", async () => {
  const { storageFactory, files } = loadFilesRouteModules();
  const provider = {
    async checkExists() {
      return true;
    },
    moveCalls: [],
    async move(sourceKey, destKey, options) {
      this.moveCalls.push({ sourceKey, destKey, options });
    },
  };
  storageFactory.createProvider = async () => provider;
  const { db, state } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(
        completedFileRow({
          r2_key: "storage/config-1/docs/demo.bin",
          config_id: "config-1",
        }),
      ),
      {
        match: /SELECT id FROM files WHERE r2_key = \? AND id != \? LIMIT 1/,
        value: null,
      },
    ],
  });

  const response = await files.renameFile(
    createRenameRequest({ new_name: "renamed.bin" }),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "同名文件已存在" });
  assert.equal(provider.moveCalls.length, 0, "远端占用时不得 move");
  assert.equal(state.batches.length, 0);
});

test("renameFile moves the legacy R2 object and updates D1 in one guarded batch", async () => {
  const { r2, files } = loadFilesRouteModules();
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  const existsKeys = [];
  r2.checkObjectExists = async (_config, key) => {
    existsKeys.push(key);
    return false;
  };
  const copyCalls = [];
  const deleteCalls = [];
  r2.copyObject = async (_config, sourceKey, destKey) => {
    copyCalls.push({ sourceKey, destKey });
  };
  r2.deleteObject = async (_config, key) => {
    deleteCalls.push(key);
  };

  const { db, state } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(
        completedFileRow({
          r2_key: "flares3/config-1/demo.bin",
          filename: "demo.bin",
        }),
      ),
      {
        match: /SELECT id FROM files WHERE r2_key = \? AND id != \? LIMIT 1/,
        value: null,
      },
    ],
    runHandlers: renameBatchRunHandlers(),
  });

  const response = await files.renameFile(
    createRenameRequest({ new_name: "renamed.bin" }),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    filename: "renamed.bin",
    r2_key: "flares3/config-1/renamed.bin",
  });
  assert.deepEqual(existsKeys, ["flares3/config-1/renamed.bin"]);
  assert.deepEqual(copyCalls, [
    {
      sourceKey: "flares3/config-1/demo.bin",
      destKey: "flares3/config-1/renamed.bin",
    },
  ]);
  assert.deepEqual(deleteCalls, ["flares3/config-1/demo.bin"]);

  // 单 batch：守卫 UPDATE + FILE_RENAME 审计
  assert.equal(state.batches.length, 1);
  const [update, audit] = state.batches[0];
  assert.match(update.sql, /UPDATE files SET filename = \?, r2_key = \?/);
  assert.match(
    update.sql,
    /AND upload_status = 'completed' AND deleted_at IS NULL/,
  );
  assert.deepEqual(update.args, [
    "renamed.bin",
    "flares3/config-1/renamed.bin",
    "file-1",
  ]);
  assert.match(audit.sql, /INSERT INTO audit_logs/);
  assert.equal(audit.args[1], "user-1");
  assert.equal(audit.args[2], "FILE_RENAME");
  assert.equal(audit.args[3], "file");
  assert.equal(audit.args[4], "file-1");
  assert.deepEqual(JSON.parse(audit.args[7]), {
    oldKey: "flares3/config-1/demo.bin",
    newKey: "flares3/config-1/renamed.bin",
    oldFilename: "demo.bin",
    newFilename: "renamed.bin",
  });
});

test("renameFile keeps the directory prefix when renaming nested objects", async () => {
  const { r2, files } = loadFilesRouteModules();
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.checkObjectExists = async () => false;
  r2.copyObject = async () => {};
  r2.deleteObject = async () => {};

  const { db, state } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(
        completedFileRow({
          r2_key: "flares3/config-1/docs/deep/demo.bin",
          filename: "demo.bin",
        }),
      ),
      {
        match: /SELECT id FROM files WHERE r2_key = \? AND id != \? LIMIT 1/,
        value: null,
      },
    ],
    runHandlers: renameBatchRunHandlers(),
  });

  const response = await files.renameFile(
    createRenameRequest({ new_name: "renamed.bin" }),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.r2_key, "flares3/config-1/docs/deep/renamed.bin");
  assert.equal(
    state.batches[0][0].args[1],
    "flares3/config-1/docs/deep/renamed.bin",
  );
});

test("renameFile returns 409 when the guarded update misses concurrently", async () => {
  const { r2, files } = loadFilesRouteModules();
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.checkObjectExists = async () => false;
  r2.copyObject = async () => {};
  r2.deleteObject = async () => {};

  const { db, state } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(completedFileRow()),
      {
        match: /SELECT id FROM files WHERE r2_key = \? AND id != \? LIMIT 1/,
        value: null,
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE files SET filename = \?, r2_key = \? WHERE id = \? AND upload_status = 'completed' AND deleted_at IS NULL/,
        value: { meta: { changes: 0 } },
      },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const originalWarn = console.warn;
  console.warn = () => {};
  let response;
  try {
    response = await files.renameFile(
      createRenameRequest({ new_name: "renamed.bin" }),
      { DB: db },
      "file-1",
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "文件状态已变化，请刷新后重试",
  });
  assert.equal(
    state.batches.length,
    1,
    "守卫未命中时 batch 仍执行（审计已随 batch 写入）",
  );
});

test("renameFile maps EntityTooLarge provider errors to 413", async () => {
  const { storageFactory, files } = loadFilesRouteModules();
  const { StorageError } = cachedModule("services/storage/types.js");
  storageFactory.createProvider = async () => ({
    async checkExists() {
      return false;
    },
    async move() {
      throw new StorageError(
        "文件过大，超过 R2 复制上限（5GiB），请删除后重新上传到目标名称",
        "EntityTooLarge",
        413,
      );
    },
  });
  const { db, state } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(
        completedFileRow({
          r2_key: "storage/config-1/docs/huge.bin",
          size: 6 * 1024 * 1024 * 1024,
          config_id: "config-1",
        }),
      ),
      {
        match: /SELECT id FROM files WHERE r2_key = \? AND id != \? LIMIT 1/,
        value: null,
      },
    ],
  });

  const response = await files.renameFile(
    createRenameRequest({ new_name: "renamed.bin" }),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /5GiB/);
  assert.equal(state.batches.length, 0);
});

test("renameFile maps missing remote objects to 409", async () => {
  const { storageFactory, files } = loadFilesRouteModules();
  const { StorageError } = cachedModule("services/storage/types.js");
  storageFactory.createProvider = async () => ({
    async checkExists() {
      return false;
    },
    async move() {
      throw new StorageError("对象不存在", "NotFound", 404);
    },
  });
  const { db, state } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(
        completedFileRow({
          r2_key: "storage/config-1/docs/ghost.bin",
          config_id: "config-1",
        }),
      ),
      {
        match: /SELECT id FROM files WHERE r2_key = \? AND id != \? LIMIT 1/,
        value: null,
      },
    ],
  });

  const response = await files.renameFile(
    createRenameRequest({ new_name: "renamed.bin" }),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "文件对象不存在，无法重命名",
  });
  assert.equal(state.batches.length, 0);
});

test("renameFile returns 503 when the storage config cannot be resolved", async () => {
  const { r2, files } = loadFilesRouteModules();
  r2.resolveR2ConfigForKey = async () => null;
  const { db } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(completedFileRow()),
      {
        match: /SELECT id FROM files WHERE r2_key = \? AND id != \? LIMIT 1/,
        value: null,
      },
    ],
  });

  const response = await files.renameFile(
    createRenameRequest({ new_name: "renamed.bin" }),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "存储配置未找到" });
});
