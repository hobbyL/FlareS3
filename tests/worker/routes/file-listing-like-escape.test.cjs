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
  quota_bytes: 1024,
};

function createGetRequest(url) {
  const request = new Request(url, { method: "GET" });
  request.user = ADMIN_USER;
  return request;
}

function createDb() {
  const state = { firsts: [], alls: [] };

  function createBoundStatement(sql, args) {
    return {
      __sql: sql,
      __args: args,
      async first() {
        state.firsts.push({ sql, args });
        if (/SELECT COUNT\(\*\) AS total FROM files/.test(sql)) {
          return 0;
        }
        throw new Error(`unexpected first SQL: ${sql}`);
      },
      async all() {
        state.alls.push({ sql, args });
        if (/FROM files f/.test(sql)) {
          return { results: [] };
        }
        throw new Error(`unexpected all SQL: ${sql}`);
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
        return {
          bind(...args) {
            return createBoundStatement(sql, args);
          },
          async first() {
            return createBoundStatement(sql, []).first();
          },
          async all() {
            return createBoundStatement(sql, []).all();
          },
        };
      },
    },
  };
}

/**
 * listFiles / listTrashFiles 的 filename 搜索必须经 escapeLike 转义
 * （对齐 users.ts / texts.ts 的 `ESCAPE '\'` 惯例），
 * 防止 `%` 全量匹配造成性能放大与语义混乱。
 */
function assertLikeEscaped(state, expectedParam) {
  // COUNT 与列表查询都应携带 ESCAPE 子句与转义后的参数
  const queries = [...state.firsts, ...state.alls];
  assert.ok(queries.length >= 2, "应执行 COUNT 与列表两个查询");
  for (const query of queries) {
    assert.match(
      query.sql,
      /f\.filename LIKE \? ESCAPE '\\'/,
      "LIKE 子句必须声明 ESCAPE",
    );
  }
  for (const query of queries) {
    assert.equal(query.args[0], expectedParam);
  }
}

test("listFiles escapes LIKE wildcards in filename search", async () => {
  const { listFiles } = loadModule("routes/fileListing.js");
  const { state, db } = createDb();

  const response = await listFiles(
    createGetRequest("https://example.com/api/files?filename=100%25"),
    { DB: db },
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).total, 0);
  assertLikeEscaped(state, "%100\\%%");
});

test("listFiles escapes underscore wildcards in filename search", async () => {
  const { listFiles } = loadModule("routes/fileListing.js");
  const { state, db } = createDb();

  await listFiles(
    createGetRequest("https://example.com/api/files?filename=a_b"),
    {
      DB: db,
    },
  );

  assertLikeEscaped(state, "%a\\_b%");
});

test("listTrashFiles escapes LIKE wildcards in filename search", async () => {
  const { listTrashFiles } = loadModule("routes/fileListing.js");
  const { state, db } = createDb();

  const response = await listTrashFiles(
    createGetRequest("https://example.com/api/files/trash?filename=50%25_off"),
    { DB: db },
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).total, 0);
  assertLikeEscaped(state, "%50\\%\\_off%");
});

test("listFiles rejects prototype-chain sort_by values and falls back to created_at", async () => {
  const { listFiles } = loadModule("routes/fileListing.js");
  const { state, db } = createDb();

  // constructor / __proto__ 命中 Object.prototype 时真值检查会放行 → SQL 注入构造函数源码
  for (const malicious of ["constructor", "__proto__", "toString"]) {
    const response = await listFiles(
      createGetRequest(
        `https://example.com/api/files?filename=&sort_by=${encodeURIComponent(malicious)}`,
      ),
      { DB: db },
    );
    assert.equal(response.status, 200);
  }
  const rowsSql = state.alls.map((entry) => entry.sql).join("\n");
  assert.match(rowsSql, /ORDER BY f\.created_at DESC/);
  assert.ok(!rowsSql.includes("[native code]"), "原型链属性不得注入 SQL");
});

test("listTrashFiles rejects prototype-chain sort_by values and falls back to deleted_at", async () => {
  const { listTrashFiles } = loadModule("routes/fileListing.js");
  const { state, db } = createDb();

  for (const malicious of ["constructor", "__proto__", "toString"]) {
    const response = await listTrashFiles(
      createGetRequest(
        `https://example.com/api/files/trash?filename=&sort_by=${encodeURIComponent(malicious)}`,
      ),
      { DB: db },
    );
    assert.equal(response.status, 200);
  }
  const rowsSql = state.alls.map((entry) => entry.sql).join("\n");
  assert.match(rowsSql, /ORDER BY f\.deleted_at DESC/);
  assert.ok(!rowsSql.includes("[native code]"), "原型链属性不得注入 SQL");
});
