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

const USER = {
  id: "user-1",
  username: "alice",
  role: "user",
  status: "active",
  quota_bytes: 1024,
};

const ADMIN = {
  id: "admin-1",
  username: "root",
  role: "admin",
  status: "active",
  quota_bytes: 1024,
};

function createAuthedRequest(url, { method = "GET", user, body } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const request = new Request(url, init);
  request.user = user === null ? undefined : user || USER;
  return request;
}

function createDb({
  firstHandlers = [],
  allHandlers = [],
  runHandlers = [],
} = {}) {
  const state = { runs: [], alls: [] };

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

  return {
    state,
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
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
          },
        };
      },
    },
  };
}

function mockProviderFactoryWithValue(value) {
  clearModule("services/storage/factory.js");
  clearModule("routes/folderShares.js");
  const factory = loadModule("services/storage/factory.js");
  factory.createProvider = async () => value;
  return loadModule("routes/folderShares.js");
}

function freshFolderShareRoutes() {
  clearModule("services/storage/factory.js");
  clearModule("routes/folderShares.js");
  return loadModule("routes/folderShares.js");
}

test("createFolderShare normalizes prefix, creates the row and audits FOLDER_SHARE_CREATE", async () => {
  const folderShareRoutes = mockProviderFactoryWithValue({
    list: async () => ({}),
  });
  const { db, state } = createDb({
    firstHandlers: [
      // scope 查重：无既有分享
      {
        match: /FROM folder_shares\s+WHERE config_id = \? AND prefix = \?/i,
        value: null,
      },
      // 三表短码查重
      {
        match: /SELECT 1 AS hit FROM file_shares WHERE share_code = \?/i,
        value: null,
      },
      {
        match: /SELECT 1 AS hit FROM text_shares WHERE share_code = \?/i,
        value: null,
      },
      {
        match: /SELECT 1 AS hit FROM folder_shares WHERE share_code = \?/i,
        value: null,
      },
    ],
    runHandlers: [
      { match: /INSERT INTO folder_shares/, value: { meta: { changes: 1 } } },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await folderShareRoutes.createFolderShare(
    createAuthedRequest("https://example.com/api/mount/folder-share", {
      method: "POST",
      body: {
        config_id: "r2-main",
        prefix: "docs",
        password: "secret123",
        max_views: 10,
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.share.share_code);
  assert.equal(payload.share.share_code.length, 12);
  assert.equal(payload.share.prefix, "docs/");
  assert.equal(payload.share.share_url, `/f/${payload.share.share_code}`);
  assert.equal(payload.share.has_password, true);
  assert.equal(payload.share.max_views, 10);
  assert.equal(payload.share.views, 0);
  assert.equal("password_hash" in payload.share, false);

  const insert = state.runs.find((entry) =>
    /INSERT INTO folder_shares/.test(entry.sql),
  );
  assert.ok(insert, "应写入 folder_shares");
  assert.equal(insert.args[1], "r2-main");
  assert.equal(insert.args[2], "docs/");
  assert.equal(insert.args[3], "user-1");
  assert.equal(typeof insert.args[4], "string");
  // expires_in：距 2099 年的剩余秒数，必须为正
  assert.ok(Number.isFinite(insert.args[6]) && insert.args[6] > 0);
  assert.equal(insert.args[7], "2099-01-01T00:00:00.000Z");
  assert.equal(insert.args[8], 10);

  const audit = state.runs.find((entry) =>
    /INSERT INTO audit_logs/.test(entry.sql),
  );
  assert.ok(audit, "应写审计日志");
  assert.equal(audit.args[2], "FOLDER_SHARE_CREATE");
  assert.equal(audit.args[3], "folder_share");
});

test("createFolderShare accepts an empty prefix (root scope) and zero options", async () => {
  const folderShareRoutes = mockProviderFactoryWithValue({});
  const { db } = createDb({
    firstHandlers: [
      {
        match: /FROM folder_shares\s+WHERE config_id = \? AND prefix = \?/i,
        value: null,
      },
      {
        match: /SELECT 1 AS hit FROM file_shares WHERE share_code = \?/i,
        value: null,
      },
      {
        match: /SELECT 1 AS hit FROM text_shares WHERE share_code = \?/i,
        value: null,
      },
      {
        match: /SELECT 1 AS hit FROM folder_shares WHERE share_code = \?/i,
        value: null,
      },
    ],
    runHandlers: [
      { match: /INSERT INTO folder_shares/, value: { meta: { changes: 1 } } },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await folderShareRoutes.createFolderShare(
    createAuthedRequest("https://example.com/api/mount/folder-share", {
      method: "POST",
      body: { config_id: "r2-main", prefix: "" },
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.share.prefix, "");
  assert.equal(payload.share.has_password, false);
});

test("createFolderShare rejects invalid input with 400/401/404/409", async () => {
  // 未认证
  const folderShareRoutes = freshFolderShareRoutes();
  const unauthed = await folderShareRoutes.createFolderShare(
    createAuthedRequest("https://example.com/api/mount/folder-share", {
      method: "POST",
      user: null,
      body: { config_id: "r2-main", prefix: "" },
    }),
    { DB: createDb().db },
  );
  assert.equal(unauthed.status, 401);

  // prefix 越界
  const escaping = await folderShareRoutes.createFolderShare(
    createAuthedRequest("https://example.com/api/mount/folder-share", {
      method: "POST",
      body: { config_id: "r2-main", prefix: "../etc" },
    }),
    { DB: createDb().db },
  );
  assert.equal(escaping.status, 400);

  // 缺 config_id
  const missingConfig = await folderShareRoutes.createFolderShare(
    createAuthedRequest("https://example.com/api/mount/folder-share", {
      method: "POST",
      body: { prefix: "" },
    }),
    { DB: createDb().db },
  );
  assert.equal(missingConfig.status, 400);

  // max_views 无效
  const badViews = await folderShareRoutes.createFolderShare(
    createAuthedRequest("https://example.com/api/mount/folder-share", {
      method: "POST",
      body: { config_id: "r2-main", prefix: "", max_views: -3 },
    }),
    { DB: createDb().db },
  );
  assert.equal(badViews.status, 400);

  // expires_at 已过期
  const pastExpiry = await folderShareRoutes.createFolderShare(
    createAuthedRequest("https://example.com/api/mount/folder-share", {
      method: "POST",
      body: {
        config_id: "r2-main",
        prefix: "",
        expires_at: "2000-01-01T00:00:00.000Z",
      },
    }),
    { DB: createDb().db },
  );
  assert.equal(pastExpiry.status, 400);

  // 存储配置不存在
  const noProviderRoutes = mockProviderFactoryWithValue(null);
  const noProvider = await noProviderRoutes.createFolderShare(
    createAuthedRequest("https://example.com/api/mount/folder-share", {
      method: "POST",
      body: { config_id: "missing", prefix: "" },
    }),
    { DB: createDb().db },
  );
  assert.equal(noProvider.status, 404);

  // 同 scope 已存在活跃分享
  const conflictedRoutes = mockProviderFactoryWithValue({});
  const conflict = await conflictedRoutes.createFolderShare(
    createAuthedRequest("https://example.com/api/mount/folder-share", {
      method: "POST",
      body: { config_id: "r2-main", prefix: "docs/" },
    }),
    {
      DB: createDb({
        firstHandlers: [
          {
            match: /FROM folder_shares\s+WHERE config_id = \? AND prefix = \?/i,
            value: { id: "existing-share", owner_id: "user-1" },
          },
        ],
      }).db,
    },
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "该目录已存在分享");
});

test("getFolderShare returns the active share by scope and enforces ownership", async () => {
  const folderShareRoutes = freshFolderShareRoutes();
  const shareRow = {
    id: "share-1",
    config_id: "r2-main",
    prefix: "docs/",
    owner_id: "user-1",
    share_code: "code00000001",
    password_hash: null,
    expires_in: 0,
    expires_at: null,
    max_views: 0,
    views: 3,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  };

  const { db } = createDb({
    firstHandlers: [
      {
        match: /FROM folder_shares\s+WHERE config_id = \? AND prefix = \?/i,
        value: shareRow,
      },
    ],
  });
  const shareRowDb = () =>
    createDb({
      firstHandlers: [
        {
          match: /FROM folder_shares\s+WHERE config_id = \? AND prefix = \?/i,
          value: shareRow,
        },
      ],
    }).db;

  const ok = await folderShareRoutes.getFolderShare(
    createAuthedRequest(
      "https://example.com/api/mount/folder-share?config_id=r2-main&prefix=docs%2F",
    ),
    { DB: db },
  );
  assert.equal(ok.status, 200);
  const payload = await ok.json();
  assert.equal(payload.share.id, "share-1");
  assert.equal(payload.share.share_url, "/f/code00000001");

  const forbidden = await folderShareRoutes.getFolderShare(
    createAuthedRequest(
      "https://example.com/api/mount/folder-share?config_id=r2-main&prefix=docs%2F",
      {
        user: { ...USER, id: "user-2" },
      },
    ),
    { DB: shareRowDb() },
  );
  assert.equal(forbidden.status, 403);

  const missing = await folderShareRoutes.getFolderShare(
    createAuthedRequest(
      "https://example.com/api/mount/folder-share?config_id=r2-main&prefix=",
    ),
    {
      DB: createDb({
        firstHandlers: [
          {
            match: /FROM folder_shares\s+WHERE config_id = \? AND prefix = \?/i,
            value: null,
          },
        ],
      }).db,
    },
  );
  assert.equal(missing.status, 200);
  assert.equal((await missing.json()).share, null);
});

test("deleteFolderShare removes by share_code or scope and audits FOLDER_SHARE_DELETE", async () => {
  const folderShareRoutes = freshFolderShareRoutes();
  const { db, state } = createDb({
    firstHandlers: [
      {
        match: /FROM folder_shares\s+WHERE share_code = \? LIMIT 1/i,
        value: {
          id: "share-1",
          config_id: "r2-main",
          prefix: "docs/",
          owner_id: "user-1",
          share_code: "code00000001",
          password_hash: null,
          expires_in: 0,
          expires_at: null,
          max_views: 0,
          views: 3,
          created_at: "2026-10-01T00:00:00.000Z",
          updated_at: "2026-10-01T00:00:00.000Z",
        },
      },
    ],
    runHandlers: [
      { match: /DELETE FROM folder_shares/, value: { meta: { changes: 1 } } },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await folderShareRoutes.deleteFolderShare(
    createAuthedRequest("https://example.com/api/mount/folder-share", {
      method: "DELETE",
      body: { share_code: "code00000001" },
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, deleted: true });

  const deleteRun = state.runs.find((entry) =>
    /DELETE FROM folder_shares/.test(entry.sql),
  );
  assert.ok(deleteRun);
  assert.equal(deleteRun.args[0], "share-1");
  const audit = state.runs.find((entry) =>
    /INSERT INTO audit_logs/.test(entry.sql),
  );
  assert.equal(audit.args[2], "FOLDER_SHARE_DELETE");
});

test("deleteFolderShare enforces ownership and tolerates missing shares", async () => {
  const folderShareRoutes = freshFolderShareRoutes();

  const forbidden = await folderShareRoutes.deleteFolderShare(
    createAuthedRequest("https://example.com/api/mount/folder-share", {
      method: "DELETE",
      user: { ...USER, id: "user-2" },
      body: { share_code: "code00000001" },
    }),
    {
      DB: createDb({
        firstHandlers: [
          {
            match: /FROM folder_shares\s+WHERE share_code = \? LIMIT 1/i,
            value: {
              id: "share-1",
              config_id: "r2-main",
              prefix: "docs/",
              owner_id: "user-1",
              share_code: "code00000001",
              password_hash: null,
              expires_in: 0,
              expires_at: null,
              max_views: 0,
              views: 0,
              created_at: "2026-10-01T00:00:00.000Z",
              updated_at: "2026-10-01T00:00:00.000Z",
            },
          },
        ],
      }).db,
    },
  );
  assert.equal(forbidden.status, 403);

  const adminOk = await folderShareRoutes.deleteFolderShare(
    createAuthedRequest("https://example.com/api/mount/folder-share", {
      method: "DELETE",
      user: ADMIN,
      body: { config_id: "r2-main", prefix: "docs" },
    }),
    {
      DB: createDb({
        firstHandlers: [
          {
            match: /FROM folder_shares\s+WHERE config_id = \? AND prefix = \?/i,
            value: {
              id: "share-1",
              config_id: "r2-main",
              prefix: "docs/",
              owner_id: "user-1",
              share_code: "code00000001",
              password_hash: null,
              expires_in: 0,
              expires_at: null,
              max_views: 0,
              views: 0,
              created_at: "2026-10-01T00:00:00.000Z",
              updated_at: "2026-10-01T00:00:00.000Z",
            },
          },
        ],
        runHandlers: [
          {
            match: /DELETE FROM folder_shares/,
            value: { meta: { changes: 1 } },
          },
          { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
        ],
      }).db,
    },
  );
  assert.equal(adminOk.status, 200);

  const missing = await folderShareRoutes.deleteFolderShare(
    createAuthedRequest("https://example.com/api/mount/folder-share", {
      method: "DELETE",
      body: { share_code: "unknown0000" },
    }),
    {
      DB: createDb({
        firstHandlers: [
          {
            match: /FROM folder_shares\s+WHERE share_code = \? LIMIT 1/i,
            value: null,
          },
        ],
      }).db,
    },
  );
  assert.equal(missing.status, 200);
  assert.deepEqual(await missing.json(), { success: true, deleted: false });
});

test("listShareAccesses validates type/owner and paginates newest-first", async () => {
  const { listShareAccesses } = loadModule("routes/shares.js");

  const invalidType = await listShareAccesses(
    createAuthedRequest(
      "https://example.com/api/shares/text_one_time/t1/accesses",
    ),
    { DB: createDb().db },
    "text_one_time",
    "t1",
  );
  assert.equal(invalidType.status, 400);

  const rows = [
    {
      id: 21,
      ip: "203.0.113.7",
      user_agent: "ua",
      path: "docs/readme.md",
      result: "ok",
      created_at: "2026-10-07T01:00:00.000Z",
    },
  ];
  const { db, state } = createDb({
    firstHandlers: [
      {
        match: /SELECT owner_id FROM folder_shares WHERE id = \?/i,
        value: { owner_id: "user-1" },
      },
      {
        match: /SELECT COUNT\(\*\) AS total\s+FROM share_access_logs/i,
        value: { total: 25 },
      },
    ],
    allHandlers: [
      {
        match:
          /SELECT id, ip, user_agent, path, result, created_at\s+FROM share_access_logs/i,
        value: { results: rows },
      },
    ],
  });

  const ok = await listShareAccesses(
    createAuthedRequest(
      "https://example.com/api/shares/folder/share-1/accesses?page=2",
    ),
    { DB: db },
    "folder",
    "share-1",
  );
  assert.equal(ok.status, 200);
  const payload = await ok.json();
  assert.deepEqual(payload.items, rows);
  assert.equal(payload.total, 25);
  assert.equal(payload.page, 2);
  assert.equal(payload.limit, 20);
  assert.deepEqual(state.alls[0].args, ["folder", "share-1", 20, 20]);

  const forbidden = await listShareAccesses(
    createAuthedRequest(
      "https://example.com/api/shares/folder/share-1/accesses",
      {
        user: { ...USER, id: "user-2" },
      },
    ),
    {
      DB: createDb({
        firstHandlers: [
          {
            match: /SELECT owner_id FROM folder_shares WHERE id = \?/i,
            value: { owner_id: "user-1" },
          },
        ],
      }).db,
    },
    "folder",
    "share-1",
  );
  assert.equal(forbidden.status, 403);

  const missing = await listShareAccesses(
    createAuthedRequest("https://example.com/api/shares/file/nope/accesses"),
    {
      DB: createDb({
        firstHandlers: [
          {
            match: /SELECT owner_id FROM file_shares WHERE file_id = \?/i,
            value: null,
          },
        ],
      }).db,
    },
    "file",
    "nope",
  );
  assert.equal(missing.status, 404);
});
