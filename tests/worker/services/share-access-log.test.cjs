const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function loadModule(relativePath) {
  const target = path.join(COMPILED_ROOT, relativePath);
  delete require.cache[target];
  return require(target);
}

function createDb({
  runHandlers = [],
  firstHandlers = [],
  allHandlers = [],
} = {}) {
  const state = { runs: [], firsts: [], alls: [] };

  function consume(list, sql, args) {
    const index = list.findIndex((handler) => handler.match.test(sql));
    if (index === -1) {
      throw new Error(`unexpected SQL: ${sql} / ${JSON.stringify(args)}`);
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
              __sql: sql,
              __args: args,
              async run() {
                state.runs.push({ sql, args });
                return consume(runHandlers, sql, args);
              },
              async first() {
                state.firsts.push({ sql, args });
                return consume(firstHandlers, sql, args);
              },
              async all() {
                state.alls.push({ sql, args });
                return consume(allHandlers, sql, args);
              },
            };
          },
        };
      },
      async batch(statements) {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        return results;
      },
    },
  };
}

test("recordShareAccess inserts one row via withD1Retry with the full payload", async () => {
  const { recordShareAccess } = loadModule("services/shareAccessLog.js");
  const { db, state } = createDb({
    runHandlers: [
      {
        match: /INSERT INTO share_access_logs/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  await recordShareAccess(
    { DB: db },
    {
      share_type: "folder",
      share_id: "share-1",
      ip: "203.0.113.7",
      user_agent: "node-test",
      path: "docs/readme.md",
      result: "ok",
    },
  );

  assert.equal(state.runs.length, 1);
  assert.match(state.runs[0].sql, /INSERT INTO share_access_logs/);
  assert.equal(state.runs[0].args[0], "folder");
  assert.equal(state.runs[0].args[1], "share-1");
  assert.equal(state.runs[0].args[2], "203.0.113.7");
  assert.equal(state.runs[0].args[3], "node-test");
  assert.equal(state.runs[0].args[4], "docs/readme.md");
  assert.equal(state.runs[0].args[5], "ok");
  assert.equal(typeof state.runs[0].args[6], "string");
});

test("recordShareAccess never throws on write failure and logs a warning", async () => {
  const { recordShareAccess } = loadModule("services/shareAccessLog.js");
  const { db } = createDb({
    // 无 run handler：consume 直接 throw，模拟 D1 抖动 / 表缺失
    runHandlers: [],
  });

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    await recordShareAccess(
      { DB: db },
      { share_type: "file", share_id: "share-2", result: "ok" },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  const log = JSON.parse(warnings[0][0]);
  assert.equal(log.level, "warn");
  assert.equal(log.event, "share.access.log.failed");
  assert.equal(log.shareType, "file");
  assert.equal(log.shareId, "share-2");
});

test("recordShareAccess skips empty share ids without touching the database", async () => {
  const { recordShareAccess } = loadModule("services/shareAccessLog.js");
  const { db, state } = createDb({ runHandlers: [] });

  await recordShareAccess(
    { DB: db },
    { share_type: "file", share_id: "", result: "not_found" },
  );

  assert.equal(state.runs.length, 0);
});

test("listShareAccessLogs paginates newest-first and returns the total", async () => {
  const { listShareAccessLogs } = loadModule("services/shareAccessLog.js");
  const rows = [
    {
      id: 21,
      ip: "198.51.100.2",
      user_agent: "ua-b",
      path: "a/",
      result: "ok",
      created_at: "2026-10-07T01:00:00.000Z",
    },
    {
      id: 20,
      ip: "198.51.100.1",
      user_agent: "ua-a",
      path: null,
      result: "rejected_password",
      created_at: "2026-10-07T00:00:00.000Z",
    },
  ];
  const { db, state } = createDb({
    allHandlers: [
      {
        match:
          /SELECT id, ip, user_agent, path, result, created_at\s+FROM share_access_logs/,
        value: { results: rows },
      },
    ],
    firstHandlers: [
      {
        match: /SELECT COUNT\(\*\) AS total\s+FROM share_access_logs/,
        value: { total: 41 },
      },
    ],
  });

  const page = await listShareAccessLogs(db, {
    share_type: "folder",
    share_id: "share-1",
    page: 2,
    limit: 20,
  });

  assert.deepEqual(page.items, rows);
  assert.equal(page.total, 41);

  const listAll = state.alls[0];
  assert.match(listAll.sql, /ORDER BY id DESC/);
  assert.deepEqual(listAll.args, ["folder", "share-1", 20, 20]);
  assert.deepEqual(state.firsts[0].args, ["folder", "share-1"]);
});

test("listShareAccessLogs tolerates empty D1 results", async () => {
  const { listShareAccessLogs } = loadModule("services/shareAccessLog.js");
  const { db } = createDb({
    allHandlers: [
      {
        match:
          /SELECT id, ip, user_agent, path, result, created_at\s+FROM share_access_logs/,
        value: { results: [] },
      },
    ],
    firstHandlers: [
      {
        match: /SELECT COUNT\(\*\) AS total\s+FROM share_access_logs/,
        value: null,
      },
    ],
  });

  const page = await listShareAccessLogs(db, {
    share_type: "text",
    share_id: "share-3",
    page: 1,
    limit: 20,
  });

  assert.deepEqual(page.items, []);
  assert.equal(page.total, 0);
});

// ---------------------------------------------------------------------------
// 三类型记录点：file / text 公开分享 POST 在消费、密码验证失败、耗尽时落日志。
// share_id 口径与 /api/shares 列表的 resource_id 一致（file → file_id，text → text_id）。
// ---------------------------------------------------------------------------

const AUTH_SECRET = "share-access-log-test-secret";

function createPostRequest(url, fields = {}) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    params.set(name, value);
  }
  const body = params.toString();
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": String(Buffer.byteLength(body)),
      "CF-Connecting-IP": "203.0.113.90",
      "User-Agent": "access-log-test",
    },
    body,
  });
}

function folderMissHandler() {
  return {
    match: /FROM folder_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
    value: null,
  };
}

function fileShareRow(overrides = {}) {
  return {
    share_id: "file-share-1",
    file_id: "file-1",
    share_code: "filecode00001",
    password_hash: null,
    share_expires_at: null,
    max_views: 0,
    views: 0,
    filename: "report.txt",
    r2_key: "shared/report.txt",
    file_expires_at: "9999-12-31T23:59:59.999Z",
    upload_status: "completed",
    deleted_at: null,
    config_id: "r2-main",
    owner_status: "active",
    ...overrides,
  };
}

function fileResolveHandler(row) {
  return {
    match: /FROM file_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
    value: row,
  };
}

function textShareRow(overrides = {}) {
  return {
    id: "text-share-1",
    text_id: "text-1",
    share_code: "textcode0001",
    password_hash: null,
    expires_at: null,
    max_views: 0,
    views: 0,
    text_title: "会议纪要",
    text_content: "hello access log",
    text_deleted_at: null,
    owner_status: "active",
    ...overrides,
  };
}

function textResolveHandler(row) {
  return {
    match: /FROM text_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
    value: row,
  };
}

function findAccessLogInsert(state) {
  return state.runs.find((entry) =>
    /INSERT INTO share_access_logs/.test(entry.sql),
  );
}

test("file share POST download logs ok with the file id as share id", async () => {
  const factory = loadModule("services/storage/factory.js");
  factory.createProvider = async () => ({
    async download(key, filename, expiresInSeconds) {
      assert.equal(key, "shared/report.txt");
      assert.equal(filename, "report.txt");
      assert.ok(expiresInSeconds > 0);
      return {
        kind: "proxy",
        response: new Response("report-body", { status: 200 }),
      };
    },
  });
  const { viewFileShare } = loadModule("routes/fileShares.js");

  const { db, state } = createDb({
    firstHandlers: [folderMissHandler(), fileResolveHandler(fileShareRow())],
    runHandlers: [
      {
        match: /UPDATE file_shares[\s\S]*SET views = views \+ 1/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /INSERT INTO share_access_logs/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await viewFileShare(
    createPostRequest("https://example.com/f/filecode00001"),
    { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
    "filecode00001",
  );

  assert.equal(response.status, 200);
  const accessLog = findAccessLogInsert(state);
  assert.ok(accessLog, "应记录 ok 访问日志");
  assert.equal(accessLog.args[0], "file");
  assert.equal(accessLog.args[1], "file-1");
  assert.equal(accessLog.args[2], "203.0.113.90");
  assert.equal(accessLog.args[3], "access-log-test");
  assert.equal(accessLog.args[5], "ok");
});

test("file share POST wrong password logs rejected_password", async () => {
  const { hashPassword } = loadModule("services/password.js");
  const { viewFileShare } = loadModule("routes/fileShares.js");

  const { db, state } = createDb({
    firstHandlers: [
      folderMissHandler(),
      fileResolveHandler(
        fileShareRow({ password_hash: hashPassword("secret123") }),
      ),
      {
        match: /SELECT blocked_until FROM rate_limits WHERE ip = \?/,
        value: null,
      },
      {
        match: /SELECT blocked_until FROM rate_limits WHERE ip = \?/,
        value: null,
      },
      {
        match: /SELECT blocked_until FROM rate_limits WHERE ip = \?/,
        value: null,
      },
      {
        match: /SELECT blocked_until FROM rate_limits WHERE ip = \?/,
        value: null,
      },
    ],
    runHandlers: [
      { match: /INSERT INTO rate_limits/, value: { meta: { changes: 1 } } },
      { match: /INSERT INTO rate_limits/, value: { meta: { changes: 1 } } },
      {
        match: /INSERT INTO share_access_logs/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await viewFileShare(
    createPostRequest("https://example.com/f/filecode00001", {
      password: "wrong-pass",
    }),
    { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
    "filecode00001",
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /口令不正确/);
  const accessLog = findAccessLogInsert(state);
  assert.ok(accessLog, "应记录 rejected_password 访问日志");
  assert.equal(accessLog.args[0], "file");
  assert.equal(accessLog.args[1], "file-1");
  assert.equal(accessLog.args[5], "rejected_password");
});

test("text share POST view logs ok with the text id as share id", async () => {
  const { viewTextShare } = loadModule("routes/textShares.js");

  const { db, state } = createDb({
    firstHandlers: [textResolveHandler(textShareRow({ views: 3 }))],
    runHandlers: [
      {
        match: /UPDATE text_shares[\s\S]*SET views = views \+ 1/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /INSERT INTO share_access_logs/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await viewTextShare(
    createPostRequest("https://example.com/t/textcode0001"),
    { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
    "textcode0001",
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /hello access log/);
  const accessLog = findAccessLogInsert(state);
  assert.ok(accessLog, "应记录 ok 访问日志");
  assert.equal(accessLog.args[0], "text");
  assert.equal(accessLog.args[1], "text-1");
  assert.equal(accessLog.args[5], "ok");
});

test("text share POST with exhausted views logs exhausted", async () => {
  const { viewTextShare } = loadModule("routes/textShares.js");

  const { db, state } = createDb({
    firstHandlers: [
      textResolveHandler(textShareRow({ max_views: 1, views: 1 })),
    ],
    runHandlers: [
      {
        match: /INSERT INTO share_access_logs/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await viewTextShare(
    createPostRequest("https://example.com/t/textcode0001"),
    { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
    "textcode0001",
  );

  assert.equal(response.status, 410);
  const accessLog = findAccessLogInsert(state);
  assert.ok(accessLog, "应记录 exhausted 访问日志");
  assert.equal(accessLog.args[0], "text");
  assert.equal(accessLog.args[1], "text-1");
  assert.equal(accessLog.args[5], "exhausted");
});

test("share GET rendering does not write access logs", async () => {
  const { viewTextShare } = loadModule("routes/textShares.js");

  const { db, state } = createDb({
    firstHandlers: [textResolveHandler(textShareRow())],
    runHandlers: [],
  });

  const response = await viewTextShare(
    new Request("https://example.com/t/textcode0001", { method: "GET" }),
    { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
    "textcode0001",
  );

  assert.equal(response.status, 200);
  assert.equal(findAccessLogInsert(state), undefined);
});
