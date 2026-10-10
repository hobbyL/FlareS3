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

function loadDirModules() {
  for (const p of ["routes/files.js", "routes/fileListing.js"]) {
    delete require.cache[compiledPath(p)];
  }
  const fileListing = loadModule("routes/fileListing.js");
  const files = loadModule("routes/files.js");
  return { files, fileListing };
}

// 扩展版 fake-D1：在 move 测试 mock 基础上补 .all()（listFileDirs 与删除前的
// 真空扫描都走 all）。handler 以正则匹配、非消耗式（同一 SQL 可被多次命中）。
function createDirDb({ allHandlers = [], runHandlers = [] } = {}) {
  const state = { alls: [], runs: [], batches: [] };
  const resolve = (list, sql, args, kind) => {
    const handler = list.find((h) => h.match.test(sql));
    if (!handler) throw new Error(`unexpected ${kind} SQL: ${sql}`);
    return typeof handler.value === "function"
      ? handler.value(args, sql, state)
      : handler.value;
  };
  const bound = (sql, args) => ({
    __sql: sql,
    __args: args,
    async first() {
      throw new Error(`unexpected first SQL: ${sql}`);
    },
    async all() {
      state.alls.push({ sql, args });
      return resolve(allHandlers, sql, args, "all");
    },
    async run() {
      state.runs.push({ sql, args });
      return resolve(runHandlers, sql, args, "run");
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

const ADMIN = { id: "user-1", role: "admin", username: "alice" };

function dirRequest(method, body, user) {
  const request = new Request("https://example.com/api/files/dirs", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (user !== null) request.user = user || ADMIN;
  return request;
}

function filesScanHandler(results) {
  return {
    match: /SELECT r2_key, config_id FROM files WHERE owner_id = \?/,
    value: { results },
  };
}

test("createFileDir requires authentication", async () => {
  const { files } = loadDirModules();
  const res = await files.createFileDir(
    dirRequest("POST", { dir: "docs" }, null),
    {
      DB: {},
    },
  );
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "未授权" });
});

test("createFileDir rejects traversal segments (400)", async () => {
  const { files } = loadDirModules();
  const res = await files.createFileDir(dirRequest("POST", { dir: "../etc" }), {
    DB: {},
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /\. 或 \.\./);
});

test("createFileDir rejects empty/root dir (400)", async () => {
  const { files } = loadDirModules();
  const res = await files.createFileDir(dirRequest("POST", { dir: "" }), {
    DB: {},
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "目录不能为空" });
});

test("createFileDir registers dir in one guarded batch (INSERT OR IGNORE + audit)", async () => {
  const { files } = loadDirModules();
  const { db, state } = createDirDb({
    runHandlers: [
      {
        match: /INSERT OR IGNORE INTO file_dirs/,
        value: { meta: { changes: 1 } },
      },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });
  const res = await files.createFileDir(
    dirRequest("POST", { dir: "docs/2024" }),
    {
      DB: db,
    },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, dir: "docs/2024" });
  assert.equal(state.batches.length, 1);
  const [insert, audit] = state.batches[0];
  assert.match(insert.sql, /INSERT OR IGNORE INTO file_dirs/);
  assert.equal(insert.args[1], "user-1");
  assert.equal(insert.args[2], "docs/2024");
  assert.match(audit.sql, /INSERT INTO audit_logs/);
  assert.equal(audit.args[2], "FILE_DIR_CREATE");
  assert.equal(audit.args[3], "file_dir");
  assert.equal(audit.args[4], "docs/2024");
  assert.deepEqual(JSON.parse(audit.args[7]), { dir: "docs/2024" });
});

test("createFileDir stays successful when the row already exists (idempotent)", async () => {
  const { files } = loadDirModules();
  const { db, state } = createDirDb({
    runHandlers: [
      {
        match: /INSERT OR IGNORE INTO file_dirs/,
        value: { meta: { changes: 0 } },
      },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });
  const res = await files.createFileDir(dirRequest("POST", { dir: "docs" }), {
    DB: db,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, dir: "docs" });
  assert.equal(state.batches.length, 1);
});

test("deleteFileDir requires authentication", async () => {
  const { files } = loadDirModules();
  const res = await files.deleteFileDir(
    dirRequest("DELETE", { dir: "docs" }, null),
    {
      DB: {},
    },
  );
  assert.equal(res.status, 401);
});

test("deleteFileDir rejects empty/root dir (400)", async () => {
  const { files } = loadDirModules();
  const res = await files.deleteFileDir(dirRequest("DELETE", { dir: "" }), {
    DB: {},
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "目录不能为空" });
});

test("deleteFileDir returns 409 when the directory still holds files", async () => {
  const { files } = loadDirModules();
  const { db, state } = createDirDb({
    allHandlers: [
      filesScanHandler([
        { r2_key: "storage/config-1/docs/2024/a.bin", config_id: "config-1" },
      ]),
    ],
  });
  const res = await files.deleteFileDir(
    dirRequest("DELETE", { dir: "docs/2024" }),
    {
      DB: db,
    },
  );
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "目录非空" });
  assert.equal(state.batches.length, 0);
});

test("deleteFileDir treats descendant files as non-empty (409)", async () => {
  const { files } = loadDirModules();
  const { db, state } = createDirDb({
    allHandlers: [
      filesScanHandler([
        {
          r2_key: "storage/config-1/docs/2024/sub/a.bin",
          config_id: "config-1",
        },
      ]),
    ],
  });
  const res = await files.deleteFileDir(
    dirRequest("DELETE", { dir: "docs/2024" }),
    {
      DB: db,
    },
  );
  assert.equal(res.status, 409);
  assert.equal(state.batches.length, 0);
});

test("deleteFileDir removes the registration in one guarded batch (DELETE + audit)", async () => {
  const { files } = loadDirModules();
  const { db, state } = createDirDb({
    allHandlers: [
      filesScanHandler([
        { r2_key: "storage/config-1/other/x.bin", config_id: "config-1" },
      ]),
    ],
    runHandlers: [
      {
        match: /DELETE FROM file_dirs WHERE owner_id = \? AND dir = \?/,
        value: { meta: { changes: 1 } },
      },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });
  const res = await files.deleteFileDir(
    dirRequest("DELETE", { dir: "docs/2024" }),
    {
      DB: db,
    },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, dir: "docs/2024" });
  assert.equal(state.batches.length, 1);
  const [del, audit] = state.batches[0];
  assert.match(
    del.sql,
    /DELETE FROM file_dirs WHERE owner_id = \? AND dir = \?/,
  );
  assert.deepEqual(del.args, ["user-1", "docs/2024"]);
  assert.equal(audit.args[2], "FILE_DIR_DELETE");
  assert.equal(audit.args[4], "docs/2024");
});

test("deleteFileDir returns 404 when no registration row matches", async () => {
  const { files } = loadDirModules();
  const { db, state } = createDirDb({
    allHandlers: [filesScanHandler([])],
    runHandlers: [
      {
        match: /DELETE FROM file_dirs WHERE owner_id = \? AND dir = \?/,
        value: { meta: { changes: 0 } },
      },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });
  const res = await files.deleteFileDir(
    dirRequest("DELETE", { dir: "ghost" }),
    { DB: db },
  );
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "目录不存在" });
  assert.equal(state.batches.length, 1);
});

test("listFileDirs folds empty file_dirs rows (and ancestors) into the result", async () => {
  const { fileListing } = loadDirModules();
  const { db } = createDirDb({
    allHandlers: [
      {
        match: /SELECT f\.r2_key, f\.config_id FROM files f/,
        value: { results: [] },
      },
      {
        match: /SELECT dir FROM file_dirs/,
        value: { results: [{ dir: "docs/2024" }] },
      },
    ],
  });
  const request = new Request("https://example.com/api/files/dirs");
  request.user = ADMIN;
  const res = await fileListing.listFileDirs(request, { DB: db });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).dirs, ["docs", "docs/2024"]);
});

test("listFileDirs merges derived file dirs with empty-dir registrations", async () => {
  const { fileListing } = loadDirModules();
  const { db } = createDirDb({
    allHandlers: [
      {
        match: /SELECT f\.r2_key, f\.config_id FROM files f/,
        value: {
          results: [
            { r2_key: "storage/config-1/photos/a.bin", config_id: "config-1" },
          ],
        },
      },
      {
        match: /SELECT dir FROM file_dirs/,
        value: { results: [{ dir: "docs" }] },
      },
    ],
  });
  const request = new Request("https://example.com/api/files/dirs");
  request.user = ADMIN;
  const res = await fileListing.listFileDirs(request, { DB: db });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).dirs, ["docs", "photos"]);
});
