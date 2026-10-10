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

const ADMIN_USER = {
  id: "admin-1",
  username: "admin",
  role: "admin",
  status: "active",
};

const NORMAL_USER = {
  id: "user-7",
  username: "alice",
  role: "user",
  status: "active",
};

function createGetRequest(url, user = ADMIN_USER) {
  const request = new Request(url, { method: "GET" });
  if (user) request.user = user;
  return request;
}

/**
 * 可配置 mock D1：按 SQL 片段路由 .all() 返回值，并记录每条查询的 sql/args，
 * 供 escapeLike / scope / LIMIT 断言。search 路由只用 .all()。
 */
function createDb(overrides = {}) {
  const results = {
    files: [],
    texts: [],
    fileShares: [],
    textShares: [],
    oneTimeShares: [],
    folderShares: [],
    ...overrides,
  };
  const state = { prepared: [], alls: [] };

  function resolveAll(sql) {
    if (/FROM files f/.test(sql)) return { results: results.files };
    if (/FROM texts t/.test(sql)) return { results: results.texts };
    if (/FROM file_shares s/.test(sql)) return { results: results.fileShares };
    if (/FROM text_shares s/.test(sql)) return { results: results.textShares };
    if (/FROM text_one_time_shares s/.test(sql))
      return { results: results.oneTimeShares };
    if (/FROM folder_shares s/.test(sql))
      return { results: results.folderShares };
    throw new Error(`unexpected all SQL: ${sql}`);
  }

  function createBoundStatement(sql, args) {
    return {
      __sql: sql,
      __args: args,
      async all() {
        state.alls.push({ sql, args });
        return resolveAll(sql);
      },
      async first() {
        throw new Error(`unexpected first SQL: ${sql}`);
      },
      async run() {
        throw new Error(`unexpected run SQL: ${sql}`);
      },
    };
  }

  return {
    state,
    db: {
      prepare(sql) {
        state.prepared.push(sql);
        return {
          bind(...args) {
            return createBoundStatement(sql, args);
          },
          async all() {
            return createBoundStatement(sql, []).all();
          },
          async first() {
            return createBoundStatement(sql, []).first();
          },
        };
      },
    },
  };
}

function findQuery(state, matcher) {
  return state.alls.find((entry) => matcher.test(entry.sql));
}

test("空 q（trim 后为空）返回三组空数组且不查库", async () => {
  const { globalSearch } = loadModule("routes/search.js");
  const { state, db } = createDb();

  for (const url of [
    "https://example.com/api/search",
    "https://example.com/api/search?q=",
    "https://example.com/api/search?q=%20%20",
  ]) {
    const response = await globalSearch(createGetRequest(url), { DB: db });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, { files: [], texts: [], shares: [] });
  }

  assert.equal(state.prepared.length, 0, "空 q 不得触发任何 DB 查询");
});

test("未授权请求返回 401", async () => {
  const { globalSearch } = loadModule("routes/search.js");
  const { db } = createDb();
  const response = await globalSearch(
    createGetRequest("https://example.com/api/search?q=x", null),
    { DB: db },
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "未授权" });
});

test("三源聚合：files / texts / shares 各返回命中并裁剪为精简字段", async () => {
  const { globalSearch } = loadModule("routes/search.js");
  const { db } = createDb({
    files: [
      {
        id: "f1",
        filename: "report.pdf",
        r2_key: "flares3/cfg/report.pdf",
        size: 1024,
        created_at: "2026-10-01T00:00:00.000Z",
        config_id: "cfg",
      },
    ],
    texts: [
      {
        id: "t1",
        title: "report 周报",
        content_preview: "report 内容片段",
        updated_at: "2026-10-02T00:00:00.000Z",
      },
    ],
    fileShares: [
      {
        file_id: "f1",
        owner_id: "admin-1",
        share_code: "abc123",
        password_hash: "",
        expires_at: null,
        max_views: 0,
        views: 0,
        created_at: "2026-10-03T00:00:00.000Z",
        updated_at: "2026-10-03T00:00:00.000Z",
        filename: "report.pdf",
        file_deleted_at: null,
        owner_username: "admin",
        owner_status: "active",
      },
    ],
  });

  const response = await globalSearch(
    createGetRequest("https://example.com/api/search?q=report"),
    { DB: db },
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.files.length, 1);
  assert.equal(body.files[0].filename, "report.pdf");
  assert.equal(body.files[0].r2_key, "flares3/cfg/report.pdf");

  assert.equal(body.texts.length, 1);
  assert.equal(body.texts[0].title, "report 周报");
  assert.equal(body.texts[0].content_preview, "report 内容片段");

  assert.equal(body.shares.length, 1);
  assert.deepEqual(body.shares[0], {
    type: "file",
    resource_id: "f1",
    resource_name: "report.pdf",
    share_code: "abc123",
    share_url: "/f/abc123",
    created_at: "2026-10-03T00:00:00.000Z",
  });
});

test("files / texts 的 LIKE 通配经 escapeLike 转义", async () => {
  const { globalSearch } = loadModule("routes/search.js");
  const { state, db } = createDb();

  await globalSearch(
    createGetRequest("https://example.com/api/search?q=100%25_x"),
    { DB: db },
  );

  const expected = "%100\\%\\_x%";
  const filesQuery = findQuery(state, /FROM files f/);
  const textsQuery = findQuery(state, /FROM texts t/);

  assert.match(
    filesQuery.sql,
    /f\.filename LIKE \? ESCAPE '\\'/,
    "files LIKE 必须声明 ESCAPE",
  );
  // admin：参数为 [like, LIMIT]
  assert.equal(filesQuery.args[0], expected);

  assert.match(
    textsQuery.sql,
    /t\.title LIKE \? ESCAPE '\\' OR t\.content LIKE \? ESCAPE '\\'/,
    "texts 标题/内容 LIKE 均须声明 ESCAPE",
  );
  assert.equal(textsQuery.args[0], expected);
  assert.equal(textsQuery.args[1], expected);
});

test("scope 隔离：非 admin 文件/文档查询强制 owner_id = 自己", async () => {
  const { globalSearch } = loadModule("routes/search.js");
  const { state, db } = createDb();

  await globalSearch(
    createGetRequest("https://example.com/api/search?q=report", NORMAL_USER),
    { DB: db },
  );

  const filesQuery = findQuery(state, /FROM files f/);
  const textsQuery = findQuery(state, /FROM texts t/);

  assert.match(filesQuery.sql, /f\.owner_id = \?/, "非 admin 文件须限本人");
  assert.equal(filesQuery.args[0], NORMAL_USER.id);
  assert.match(textsQuery.sql, /t\.owner_id = \?/, "非 admin 文档须限本人");
  assert.equal(textsQuery.args[0], NORMAL_USER.id);
});

test("scope：admin 不追加 owner 过滤（全局搜索）", async () => {
  const { globalSearch } = loadModule("routes/search.js");
  const { state, db } = createDb();

  await globalSearch(
    createGetRequest("https://example.com/api/search?q=report", ADMIN_USER),
    { DB: db },
  );

  const filesQuery = findQuery(state, /FROM files f/);
  const textsQuery = findQuery(state, /FROM texts t/);

  assert.ok(
    !/f\.owner_id = \?/.test(filesQuery.sql),
    "admin 文件搜索不应限 owner",
  );
  assert.ok(
    !/t\.owner_id = \?/.test(textsQuery.sql),
    "admin 文档搜索不应限 owner",
  );
});

test("top 10 截断：各源 LIMIT 10；shares 内存裁剪至 10", async () => {
  const { globalSearch } = loadModule("routes/search.js");

  const manyShares = Array.from({ length: 15 }, (_, i) => ({
    file_id: `f${i}`,
    owner_id: "admin-1",
    share_code: `report-code-${i}`,
    password_hash: "",
    expires_at: null,
    max_views: 0,
    views: 0,
    created_at: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    updated_at: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    filename: `report-${i}.pdf`,
    file_deleted_at: null,
    owner_username: "admin",
    owner_status: "active",
  }));

  const { state, db } = createDb({ fileShares: manyShares });

  const response = await globalSearch(
    createGetRequest("https://example.com/api/search?q=report"),
    { DB: db },
  );
  const body = await response.json();

  const filesQuery = findQuery(state, /FROM files f/);
  const textsQuery = findQuery(state, /FROM texts t/);
  assert.match(filesQuery.sql, /LIMIT \?/);
  assert.equal(filesQuery.args[filesQuery.args.length - 1], 10);
  assert.match(textsQuery.sql, /LIMIT \?/);
  assert.equal(textsQuery.args[textsQuery.args.length - 1], 10);

  assert.equal(body.shares.length, 10, "shares 命中应裁剪到 top 10");
});
