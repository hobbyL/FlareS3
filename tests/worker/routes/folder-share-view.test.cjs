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

const AUTH_SECRET = "folder-share-view-test-secret";

function folderShareRow(overrides = {}) {
  return {
    id: "folder-share-1",
    config_id: "r2-main",
    prefix: "docs/",
    share_code: "folder0000001",
    password_hash: null,
    expires_at: null,
    max_views: 0,
    views: 2,
    owner_status: "active",
    ...overrides,
  };
}

function createDb({
  firstHandlers = [],
  allHandlers = [],
  runHandlers = [],
} = {}) {
  const state = { runs: [], alls: [], batches: [] };

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
  }

  return {
    state,
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            return createBoundStatement(sql, args);
          },
          async first() {
            return consume(firstHandlers, sql, [], "first");
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

function folderResolveHandler(row) {
  return {
    match: /FROM folder_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
    value: row,
  };
}

function createGetRequest(url, { cookie } = {}) {
  const init = { method: "GET" };
  if (cookie) {
    init.headers = { Cookie: cookie };
  }
  return new Request(url, init);
}

function createFormPostRequest(url, fields) {
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
      "CF-Connecting-IP": "203.0.113.60",
    },
    body,
  });
}

function loadFileSharesWithProvider(provider) {
  clearModule("services/storage/factory.js");
  clearModule("routes/folderShareView.js");
  clearModule("routes/fileShares.js");
  const factory = loadModule("services/storage/factory.js");
  factory.createProvider = async () => provider;
  return loadModule("routes/fileShares.js");
}

const LIST_PROVIDER = {
  async list(params) {
    assert.equal(params.prefix, "docs/");
    assert.equal(params.delimiter, "/");
    return {
      is_truncated: false,
      key_count: 2,
      common_prefixes: ["docs/sub/"],
      contents: [
        {
          key: "docs/readme.md",
          size: 12,
          last_modified: "2026-10-01T00:00:00.000Z",
        },
      ],
    };
  },
};

test("folder share GET renders the directory list with relative path links", async () => {
  const { viewFileShare } = loadFileSharesWithProvider(LIST_PROVIDER);
  const { db } = createDb({
    firstHandlers: [folderResolveHandler(folderShareRow())],
  });

  const response = await viewFileShare(
    createGetRequest("https://example.com/f/folder0000001"),
    { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
    "folder0000001",
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /readme\.md/);
  assert.match(html, /sub\//);
  // 下载表单 hidden path 必须是剥离分享 prefix 后的相对路径
  assert.match(html, /name="path" value="readme\.md"/);
  // 子目录导航链接带相对 path
  assert.match(html, /path=sub%2F/);
  assert.match(html, /已访问 2/);
});

test("folder share GET renders an empty state for empty directories", async () => {
  const { viewFileShare } = loadFileSharesWithProvider({
    async list() {
      return {
        is_truncated: false,
        key_count: 0,
        common_prefixes: [],
        contents: [],
      };
    },
  });
  const { db } = createDb({
    firstHandlers: [folderResolveHandler(folderShareRow())],
  });

  const response = await viewFileShare(
    createGetRequest("https://example.com/f/folder0000001"),
    { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
    "folder0000001",
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /该目录为空/);
});

test("folder share GET shows the password form when password is set and cookie missing", async () => {
  const { hashPassword } = loadModule("services/password.js");
  const { viewFileShare } = loadFileSharesWithProvider(LIST_PROVIDER);
  const { db } = createDb({
    firstHandlers: [
      folderResolveHandler(
        folderShareRow({ password_hash: hashPassword("secret123") }),
      ),
    ],
  });

  const response = await viewFileShare(
    createGetRequest("https://example.com/f/folder0000001?path=sub%2F"),
    { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
    "folder0000001",
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /该目录需要访问口令/);
  assert.match(html, /name="password"/);
  // 列表不应被渲染
  assert.doesNotMatch(html, /readme\.md/);
});

test("folder share GET bypasses the password form with a valid signed cookie", async () => {
  const { signShareCookie, buildShareCookieName } = loadModule(
    "services/shareCookie.js",
  );
  const { hashPassword } = loadModule("services/password.js");
  const env = { DB: null, AUTH_TOKEN_SECRET: AUTH_SECRET };
  const cookieValue = await signShareCookie(env, "folder0000001");

  const { viewFileShare } = loadFileSharesWithProvider(LIST_PROVIDER);
  const { db } = createDb({
    firstHandlers: [
      folderResolveHandler(
        folderShareRow({ password_hash: hashPassword("secret123") }),
      ),
    ],
  });

  const response = await viewFileShare(
    createGetRequest("https://example.com/f/folder0000001", {
      cookie: `${buildShareCookieName("folder0000001")}=${cookieValue}`,
    }),
    { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
    "folder0000001",
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /readme\.md/);
});

test("folder share GET rejects escaping path parameters with 400", async () => {
  const { viewFileShare } = loadFileSharesWithProvider(LIST_PROVIDER);
  const { db } = createDb({
    firstHandlers: [folderResolveHandler(folderShareRow())],
  });

  const response = await viewFileShare(
    createGetRequest("https://example.com/f/folder0000001?path=..%2Fsecret"),
    { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
    "folder0000001",
  );

  assert.equal(response.status, 400);
  assert.match(await response.text(), /路径不能包含 \. 或 \.\./);
});

test("folder share POST downloads the file, consumes a view and logs ok", async () => {
  const { viewFileShare } = loadFileSharesWithProvider({
    async download(key, filename, expiresInSeconds) {
      assert.equal(key, "docs/readme.md");
      assert.equal(filename, "readme.md");
      assert.ok(expiresInSeconds > 0);
      return {
        kind: "redirect",
        url: "https://upstream.example.com/readme.md",
      };
    },
  });

  const originalFetch = globalThis.fetch;
  let fetchedUrl = "";
  globalThis.fetch = async (url) => {
    fetchedUrl = String(url);
    return new Response("file-body", {
      status: 200,
      headers: {
        "Content-Type": "text/markdown",
        "Content-Disposition": 'inline; filename="evil.txt"',
        "X-Untrusted": "drop-me",
        "Content-Length": "9",
      },
    });
  };

  try {
    const { db, state } = createDb({
      firstHandlers: [folderResolveHandler(folderShareRow())],
      runHandlers: [
        {
          match: /UPDATE folder_shares[\s\S]*SET views = views \+ 1/,
          value: { meta: { changes: 1 } },
        },
        {
          match: /INSERT INTO share_access_logs/,
          value: { meta: { changes: 1 } },
        },
      ],
    });

    const response = await viewFileShare(
      createFormPostRequest("https://example.com/f/folder0000001", {
        path: "readme.md",
      }),
      { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
      "folder0000001",
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "file-body");
    assert.equal(fetchedUrl, "https://upstream.example.com/readme.md");
    // 下载响应经白名单收口：Content-Disposition 强制 attachment + 安全文件名
    assert.match(
      response.headers.get("Content-Disposition") || "",
      /^attachment; filename="readme\.md"$/,
    );
    assert.equal(response.headers.get("X-Untrusted"), null);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");

    const accessLog = state.runs.find((entry) =>
      /INSERT INTO share_access_logs/.test(entry.sql),
    );
    assert.ok(accessLog, "应记录访问日志");
    assert.equal(accessLog.args[0], "folder");
    assert.equal(accessLog.args[1], "folder-share-1");
    assert.equal(accessLog.args[4], "readme.md");
    assert.equal(accessLog.args[5], "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("folder share POST password validation issues the cookie and redirects back", async () => {
  const { hashPassword } = loadModule("services/password.js");
  const { viewFileShare } = loadFileSharesWithProvider(LIST_PROVIDER);
  const { db, state } = createDb({
    firstHandlers: [
      folderResolveHandler(
        folderShareRow({ password_hash: hashPassword("secret123") }),
      ),
      // isSharePasswordBlocked 依次查 IP 维度与分享码维度两个 key
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
      // clearSharePasswordFailedAttempts 经 batch 清两个维度的失败计数
      {
        match:
          /UPDATE rate_limits SET failed_attempts = 0, blocked_until = NULL/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /UPDATE rate_limits SET failed_attempts = 0, blocked_until = NULL/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await viewFileShare(
    createFormPostRequest("https://example.com/f/folder0000001", {
      password: "secret123",
    }),
    { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
    "folder0000001",
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/f/folder0000001");
  const setCookie = response.headers.get("Set-Cookie") || "";
  assert.match(setCookie, /^fs_folder0000001=\d+\.[A-Za-z0-9_-]+/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\/f\/folder0000001/);
  assert.match(setCookie, /Max-Age=\d+/);
  // 纯验证不消费访问次数
  assert.equal(
    state.runs.some((entry) => /UPDATE folder_shares/.test(entry.sql)),
    false,
  );
});

test("folder share POST wrong password logs rejected_password and rerenders the form", async () => {
  const { hashPassword } = loadModule("services/password.js");
  const { viewFileShare } = loadFileSharesWithProvider(LIST_PROVIDER);
  const { db, state } = createDb({
    firstHandlers: [
      folderResolveHandler(
        folderShareRow({ password_hash: hashPassword("secret123") }),
      ),
      // 验证前后各调用一次 isSharePasswordBlocked，每次查两个维度的 key
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
      // recordSharePasswordFailedAttempt 经 batch 写入两个维度
      { match: /INSERT INTO rate_limits/, value: { meta: { changes: 1 } } },
      { match: /INSERT INTO rate_limits/, value: { meta: { changes: 1 } } },
      {
        match: /INSERT INTO share_access_logs/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await viewFileShare(
    createFormPostRequest("https://example.com/f/folder0000001", {
      password: "wrong-pass",
    }),
    { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
    "folder0000001",
  );

  assert.equal(response.status, 200);
  assert.match(await response.text(), /口令不正确/);

  const accessLog = state.runs.find((entry) =>
    /INSERT INTO share_access_logs/.test(entry.sql),
  );
  assert.ok(accessLog, "应记录访问日志");
  assert.equal(accessLog.args[5], "rejected_password");
});

test("folder share POST with exhausted views returns 410 and logs exhausted", async () => {
  const { viewFileShare } = loadFileSharesWithProvider(LIST_PROVIDER);
  const { db, state } = createDb({
    firstHandlers: [
      folderResolveHandler(folderShareRow({ max_views: 2, views: 2 })),
    ],
    runHandlers: [
      {
        match: /INSERT INTO share_access_logs/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await viewFileShare(
    createFormPostRequest("https://example.com/f/folder0000001", {
      path: "readme.md",
    }),
    { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
    "folder0000001",
  );

  assert.equal(response.status, 410);
  assert.match(await response.text(), /访问次数已用尽/);
  const accessLog = state.runs.find((entry) =>
    /INSERT INTO share_access_logs/.test(entry.sql),
  );
  assert.ok(accessLog);
  assert.equal(accessLog.args[5], "exhausted");
});

test("folder share miss falls through to the untouched file share flow", async () => {
  const { viewFileShare } = loadFileSharesWithProvider(LIST_PROVIDER);
  const { db, state } = createDb({
    firstHandlers: [
      folderResolveHandler(null),
      {
        match:
          /FROM file_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          share_id: "file-share-9",
          file_id: "file-9",
          share_code: "filecode00009",
          password_hash: null,
          share_expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 0,
          views: 1,
          filename: "report.txt",
          r2_key: "flares3/config/report.txt",
          file_expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          deleted_at: null,
          owner_status: "active",
        },
      },
    ],
  });

  const response = await viewFileShare(
    createGetRequest("https://example.com/f/filecode00009"),
    { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
    "filecode00009",
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /report\.txt/);
  assert.match(html, /下载文件/);
  assert.equal(
    state.runs.some((entry) => /UPDATE folder_shares/.test(entry.sql)),
    false,
  );
});

test("folder share resolution failure degrades to the file flow without 5xx", async () => {
  const { viewFileShare } = loadFileSharesWithProvider(LIST_PROVIDER);
  // 无 folder handler：resolve 查询抛错（模拟表缺失），旁路应降级而非 500
  const { db } = createDb({
    firstHandlers: [
      {
        match:
          /FROM file_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          share_id: "file-share-10",
          file_id: "file-10",
          share_code: "filecode00010",
          password_hash: null,
          share_expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 0,
          views: 0,
          filename: "notes.txt",
          r2_key: "flares3/config/notes.txt",
          file_expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          deleted_at: null,
          owner_status: "active",
        },
      },
    ],
  });

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  let response;
  try {
    response = await viewFileShare(
      createGetRequest("https://example.com/f/filecode00010"),
      { DB: db, AUTH_TOKEN_SECRET: AUTH_SECRET },
      "filecode00010",
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(response.status, 200);
  assert.match(await response.text(), /notes\.txt/);
  assert.ok(
    warnings.some((args) =>
      String(args[0]).includes("share.folder.resolve.failed"),
    ),
    "降级时应输出结构化告警",
  );
});
