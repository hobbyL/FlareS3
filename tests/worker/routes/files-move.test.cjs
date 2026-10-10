const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");
const compiledPath = (p) => path.join(COMPILED_ROOT, p);
const loadModule = (p) => {
  const t = compiledPath(p);
  delete require.cache[t];
  return require(t);
};
const clearModule = (p) => {
  delete require.cache[compiledPath(p)];
};

function createLifecycleDb({ firstHandlers = [], runHandlers = [] }) {
  const state = { firsts: [], runs: [], batches: [] };
  const consume = (list, sql, args, kind) => {
    const index = list.findIndex((h) => h.match.test(sql));
    if (index === -1)
      throw new Error(
        `unexpected ${kind} SQL: ${sql} / ${JSON.stringify(args)}`,
      );
    const [handler] = list.splice(index, 1);
    return typeof handler.value === "function"
      ? handler.value(args, sql, state)
      : handler.value;
  };
  const bound = (sql, args) => ({
    __sql: sql,
    __args: args,
    async first(col) {
      state.firsts.push({ sql, args, col });
      const v = consume(firstHandlers, sql, args, "first");
      return col && v && typeof v === "object" && col in v ? v[col] : v;
    },
    async all() {
      throw new Error(`unexpected all SQL: ${sql}`);
    },
    async run() {
      state.runs.push({ sql, args });
      return consume(runHandlers, sql, args, "run");
    },
  });
  return {
    state,
    db: {
      prepare: (sql) => ({ bind: (...args) => bound(sql, args) }),
      async batch(statements) {
        state.batches.push(
          statements.map((s) => ({ sql: s.__sql, args: s.__args || [] })),
        );
        const results = [];
        for (const s of statements) results.push(await s.run());
        return results;
      },
    },
  };
}

function createMoveRequest(body, user) {
  const request = new Request("https://example.com/api/files/file-1/move", {
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
    r2_key: "storage/config-1/docs/demo.bin",
    size: 2048,
    upload_status: "completed",
    deleted_at: null,
    config_id: "config-1",
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

function occupancyHandler(value) {
  return {
    match: /SELECT id FROM files WHERE r2_key = \? AND id != \? LIMIT 1/,
    value,
  };
}

// consume 会 splice 消耗 handler，跨测试必须各自取新副本
function moveBatchRunHandlers() {
  return [
    {
      match:
        /UPDATE files SET r2_key = \? WHERE id = \? AND upload_status = 'completed' AND deleted_at IS NULL/,
      value: { meta: { changes: 1 } },
    },
    { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
  ];
}

test("moveFile requires authentication", async () => {
  const { files } = loadFilesRouteModules();
  const request = new Request("https://example.com/api/files/file-1/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir: "images" }),
  });
  const response = await files.moveFile(request, { DB: {} }, "file-1");
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "未授权" });
});

test("moveFile rejects traversal in the target directory (400)", async () => {
  const { files } = loadFilesRouteModules();
  const response = await files.moveFile(
    createMoveRequest({ dir: "../etc" }),
    { DB: {} },
    "file-1",
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /\. 或 \.\./);
});

test("moveFile returns 404 when the file does not exist", async () => {
  const { files } = loadFilesRouteModules();
  const { db } = createLifecycleDb({ firstHandlers: [firstHandlerFor(null)] });
  const response = await files.moveFile(
    createMoveRequest({ dir: "images" }),
    { DB: db },
    "file-1",
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "文件不存在" });
});

test("moveFile returns 403 for non-owner non-admin users", async () => {
  const { files } = loadFilesRouteModules();
  const { db, state } = createLifecycleDb({
    firstHandlers: [firstHandlerFor(completedFileRow({ owner_id: "owner-9" }))],
  });
  const response = await files.moveFile(
    createMoveRequest(
      { dir: "images" },
      { id: "user-2", role: "user", username: "mallory" },
    ),
    { DB: db },
    "file-1",
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "无权限" });
  assert.equal(state.batches.length, 0);
});

test("moveFile rejects files that are not completed uploads (409)", async () => {
  const { files } = loadFilesRouteModules();
  const { db, state } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(completedFileRow({ upload_status: "pending" })),
    ],
  });
  const response = await files.moveFile(
    createMoveRequest({ dir: "images" }),
    { DB: db },
    "file-1",
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "仅完成上传的文件可移动" });
  assert.equal(state.batches.length, 0);
});

test("moveFile rejects legacy/unknown key structures (409)", async () => {
  const { files } = loadFilesRouteModules();
  const { db, state } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(
        completedFileRow({ r2_key: "uploads/legacy.bin", config_id: null }),
      ),
    ],
  });
  const response = await files.moveFile(
    createMoveRequest({ dir: "images" }),
    { DB: db },
    "file-1",
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "该文件的存储结构不支持移动到目录",
  });
  assert.equal(state.batches.length, 0);
});

test("moveFile rejects moving into the same directory (400)", async () => {
  const { files } = loadFilesRouteModules();
  const { db, state } = createLifecycleDb({
    firstHandlers: [firstHandlerFor(completedFileRow())],
  });
  const response = await files.moveFile(
    createMoveRequest({ dir: "docs" }),
    { DB: db },
    "file-1",
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "目标目录与当前目录相同" });
  assert.equal(state.batches.length, 0);
});

test("moveFile returns 409 when another D1 record already holds the key", async () => {
  const { files } = loadFilesRouteModules();
  const { db, state } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(completedFileRow()),
      occupancyHandler("file-2"),
    ],
  });
  const response = await files.moveFile(
    createMoveRequest({ dir: "images" }),
    { DB: db },
    "file-1",
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "同名文件已存在" });
  assert.equal(state.batches.length, 0);
});

test("moveFile returns 409 when the remote destination key is occupied", async () => {
  const { storageFactory, files } = loadFilesRouteModules();
  const provider = {
    moveCalls: [],
    async checkExists() {
      return true;
    },
    async move(sourceKey, destKey, options) {
      this.moveCalls.push({ sourceKey, destKey, options });
    },
  };
  storageFactory.createProvider = async () => provider;
  const { db, state } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(completedFileRow()),
      occupancyHandler(null),
    ],
  });
  const response = await files.moveFile(
    createMoveRequest({ dir: "images" }),
    { DB: db },
    "file-1",
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "同名文件已存在" });
  assert.equal(provider.moveCalls.length, 0, "远端占用时不得 move");
  assert.equal(state.batches.length, 0);
});

test("moveFile moves the object and updates D1 in one guarded batch", async () => {
  const { storageFactory, files } = loadFilesRouteModules();
  const provider = {
    moveCalls: [],
    async checkExists() {
      return false;
    },
    async move(sourceKey, destKey, options) {
      this.moveCalls.push({ sourceKey, destKey, options });
    },
  };
  storageFactory.createProvider = async () => provider;
  const { db, state } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(completedFileRow()),
      occupancyHandler(null),
    ],
    runHandlers: moveBatchRunHandlers(),
  });
  const response = await files.moveFile(
    createMoveRequest({ dir: "images" }),
    { DB: db },
    "file-1",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    r2_key: "storage/config-1/images/demo.bin",
    dir: "images",
  });
  assert.deepEqual(provider.moveCalls, [
    {
      sourceKey: "storage/config-1/docs/demo.bin",
      destKey: "storage/config-1/images/demo.bin",
      options: { size: 2048 },
    },
  ]);
  assert.equal(state.batches.length, 1);
  const [update, audit] = state.batches[0];
  assert.match(update.sql, /UPDATE files SET r2_key = \?/);
  assert.doesNotMatch(update.sql, /filename/);
  assert.match(
    update.sql,
    /AND upload_status = 'completed' AND deleted_at IS NULL/,
  );
  assert.deepEqual(update.args, ["storage/config-1/images/demo.bin", "file-1"]);
  assert.match(audit.sql, /INSERT INTO audit_logs/);
  assert.equal(audit.args[2], "FILE_MOVE");
  assert.equal(audit.args[3], "file");
  assert.equal(audit.args[4], "file-1");
  assert.deepEqual(JSON.parse(audit.args[7]), {
    oldKey: "storage/config-1/docs/demo.bin",
    newKey: "storage/config-1/images/demo.bin",
    oldDir: "docs",
    newDir: "images",
  });
});

test("moveFile moving to root clears the directory segment", async () => {
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
          config_id: null,
        }),
      ),
      occupancyHandler(null),
    ],
    runHandlers: moveBatchRunHandlers(),
  });
  const response = await files.moveFile(
    createMoveRequest({ dir: "" }),
    { DB: db },
    "file-1",
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.r2_key, "flares3/config-1/demo.bin");
  assert.equal(payload.dir, "");
  assert.equal(state.batches[0][0].args[0], "flares3/config-1/demo.bin");
});

test("moveFile no longer rejects >5GiB objects: provider.move success proceeds to the guarded update", async () => {
  const { storageFactory, files } = loadFilesRouteModules();
  let moveCalled = false;
  // provider.move 内部回退多段拷贝后成功（>5GiB 不再被 413 短路）
  storageFactory.createProvider = async () => ({
    async checkExists() {
      return false;
    },
    async move() {
      moveCalled = true;
    },
  });
  const { db, state } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(completedFileRow({ size: 6 * 1024 * 1024 * 1024 })),
      occupancyHandler(null),
    ],
    runHandlers: moveBatchRunHandlers(),
  });
  const response = await files.moveFile(
    createMoveRequest({ dir: "images" }),
    { DB: db },
    "file-1",
  );
  assert.equal(moveCalled, true);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.r2_key, "storage/config-1/images/demo.bin");
  assert.equal(payload.dir, "images");
  assert.equal(state.batches.length, 1);
});

test("moveFile returns 503 when the storage config cannot be resolved", async () => {
  const { r2, files } = loadFilesRouteModules();
  r2.resolveR2ConfigForKey = async () => null;
  const { db } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(
        completedFileRow({
          r2_key: "flares3/config-1/docs/demo.bin",
          config_id: null,
        }),
      ),
      occupancyHandler(null),
    ],
  });
  const response = await files.moveFile(
    createMoveRequest({ dir: "images" }),
    { DB: db },
    "file-1",
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "存储配置未找到" });
});

test("moveFile returns 409 when the guarded update misses concurrently", async () => {
  const { storageFactory, files } = loadFilesRouteModules();
  storageFactory.createProvider = async () => ({
    async checkExists() {
      return false;
    },
    async move() {},
  });
  const { db, state } = createLifecycleDb({
    firstHandlers: [
      firstHandlerFor(completedFileRow()),
      occupancyHandler(null),
    ],
    runHandlers: [
      {
        match:
          /UPDATE files SET r2_key = \? WHERE id = \? AND upload_status = 'completed' AND deleted_at IS NULL/,
        value: { meta: { changes: 0 } },
      },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  let response;
  try {
    response = await files.moveFile(
      createMoveRequest({ dir: "images" }),
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
  assert.equal(state.batches.length, 1);
});
