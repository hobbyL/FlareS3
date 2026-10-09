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
      async first() {
        state.firsts.push({ sql, args });
        if (/SELECT COUNT\(\*\) AS total FROM files/.test(sql)) return 0;
        throw new Error(`unexpected first SQL: ${sql}`);
      },
      async all() {
        state.alls.push({ sql, args });
        if (/FROM files f/.test(sql)) return { results: [] };
        throw new Error(`unexpected all SQL: ${sql}`);
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

test("listFiles dir 过滤：config_id 锚定 + 深度守卫 + ESCAPE", async () => {
  const { listFiles } = loadModule("routes/fileListing.js");
  const { state, db } = createDb();

  const response = await listFiles(
    createGetRequest("https://example.com/api/files?dir=a/b"),
    { DB: db },
  );
  assert.equal(response.status, 200);

  const sql = [...state.firsts, ...state.alls].map((q) => q.sql).join("\n");
  // 两种前缀的 include LIKE 与深度守卫 NOT LIKE，均声明 ESCAPE '\'
  assert.match(
    sql,
    /f\.r2_key LIKE 'flares3\/' \|\|.*\|\| '\/' \|\| \? \|\| '\/%' ESCAPE '\\'/,
  );
  assert.match(
    sql,
    /f\.r2_key LIKE 'storage\/' \|\|.*\|\| '\/' \|\| \? \|\| '\/%' ESCAPE '\\'/,
  );
  assert.match(sql, /f\.r2_key NOT LIKE 'flares3\/'.*'\/%\/%' ESCAPE '\\'/);
  assert.match(sql, /f\.r2_key NOT LIKE 'storage\/'.*'\/%\/%' ESCAPE '\\'/);
  // config_id 字面锚定 + 转义链
  assert.match(sql, /REPLACE\(REPLACE\(REPLACE\(REPLACE\(f\.config_id/);
  assert.match(sql, /f\.config_id IS NOT NULL/);

  // 4 个绑定均为 escapeLike('a/b')（'/' 不转义）
  const countArgs = state.firsts[0].args;
  assert.deepEqual(countArgs.slice(0, 4), ["a/b", "a/b", "a/b", "a/b"]);
});

test("listFiles dir 过滤：%/_ 注入安全（字面转义）", async () => {
  const { listFiles } = loadModule("routes/fileListing.js");
  const { state, db } = createDb();

  await listFiles(
    createGetRequest("https://example.com/api/files?dir=a%25/b_c"),
    { DB: db },
  );
  // escapeLike('a%/b_c') → 'a\%/b\_c'
  const countArgs = state.firsts[0].args;
  assert.deepEqual(countArgs.slice(0, 4), [
    "a\\%/b\\_c",
    "a\\%/b\\_c",
    "a\\%/b\\_c",
    "a\\%/b\\_c",
  ]);
});

test("listFiles 无 dir 参数时不追加目录过滤（向后兼容）", async () => {
  const { listFiles } = loadModule("routes/fileListing.js");
  const { state, db } = createDb();

  await listFiles(createGetRequest("https://example.com/api/files"), {
    DB: db,
  });
  const sql = [...state.firsts, ...state.alls].map((q) => q.sql).join("\n");
  assert.ok(!/r2_key LIKE/.test(sql), "无 dir 时不应出现目录 LIKE 子句");
  // COUNT 无目录绑定（admin 无 owner → 空参数）
  assert.deepEqual(state.firsts[0].args, []);
});

test("listFiles dir 穿越段被拒（等价无过滤）", async () => {
  const { listFiles } = loadModule("routes/fileListing.js");
  const { state, db } = createDb();

  await listFiles(
    createGetRequest(
      "https://example.com/api/files?dir=" + encodeURIComponent("../etc"),
    ),
    { DB: db },
  );
  const sql = [...state.firsts, ...state.alls].map((q) => q.sql).join("\n");
  assert.ok(!/r2_key LIKE/.test(sql), "穿越段应被 normalizeDirParam 拒绝");
});
