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

function createDb({ countTable, listTable }) {
  const state = { firsts: [], alls: [] };

  function createBoundStatement(sql, args) {
    return {
      async first() {
        state.firsts.push({ sql, args });
        if (/SELECT COUNT\(\*\) AS total/.test(sql)) {
          return 0;
        }
        throw new Error(`unexpected first SQL: ${sql}`);
      },
      async all() {
        state.alls.push({ sql, args });
        if (new RegExp(`FROM ${listTable}`).test(sql)) {
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
 * 从列表查询（LIMIT ? OFFSET ?）中提取绑定的分页参数。
 * NaN 绑进 SQL 会触发 D1 SQLITE_MISMATCH 导致路由 500，
 * 守卫生效时应绑定数字 fallback（page=abc → 1/20）。
 */
function extractPaginationBindings(state, listSqlPattern) {
  const listQueries = state.alls.filter((entry) =>
    listSqlPattern.test(entry.sql),
  );
  assert.ok(listQueries.length >= 1, "应执行列表查询");
  const args = listQueries[0].args;
  const limit = args[args.length - 2];
  const offset = args[args.length - 1];
  return { limit, offset };
}

test("listUsers falls back to numeric pagination on NaN input", async () => {
  const { listUsers } = loadModule("routes/users.js");
  const { state, db } = createDb({
    countTable: "users",
    listTable: "users",
  });

  const response = await listUsers(
    createGetRequest("https://example.com/api/users?page=abc&limit=abc"),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.page, 1);
  assert.equal(payload.limit, 20);

  const { limit, offset } = extractPaginationBindings(state, /FROM users/);
  assert.equal(limit, 20);
  assert.equal(offset, 0);
  assert.ok(Number.isFinite(limit), "limit 不得为 NaN");
  assert.ok(Number.isFinite(offset), "offset 不得为 NaN");
});

test("listFiles clamps extreme page input instead of NaN bindings", async () => {
  const { listFiles } = loadModule("routes/fileListing.js");
  const { state, db } = createDb({
    countTable: "files",
    listTable: "files f",
  });

  const response = await listFiles(
    createGetRequest("https://example.com/api/files?page=1e15&limit=101"),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  // 超界 → clamp：page 上限 1e9，limit 上限 100
  assert.equal(payload.page, 1_000_000_000);
  assert.equal(payload.limit, 100);

  const { limit, offset } = extractPaginationBindings(state, /FROM files f/);
  assert.equal(limit, 100);
  // offset = (1e9 - 1) * 100 = 99999999900，仍在安全整数范围内
  assert.equal(offset, 99_999_999_900);
  assert.ok(Number.isFinite(offset), "offset 不得为 NaN 或溢出");
});

test("listTexts falls back to numeric pagination on NaN input", async () => {
  const { listTexts } = loadModule("routes/texts.js");
  const { state, db } = createDb({
    countTable: "texts",
    listTable: "texts t",
  });

  const response = await listTexts(
    createGetRequest("https://example.com/api/texts?page=abc&limit=abc"),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.page, 1);
  assert.equal(payload.limit, 20);

  const { limit, offset } = extractPaginationBindings(state, /FROM texts t/);
  assert.equal(limit, 20);
  assert.equal(offset, 0);
});

test("listAudit falls back to numeric pagination on NaN input", async () => {
  const { listAudit } = loadModule("routes/audit.js");
  const { state, db } = createDb({
    countTable: "audit_logs",
    listTable: "audit_logs a",
  });

  const response = await listAudit(
    createGetRequest("https://example.com/api/audit?page=abc&limit=abc"),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.page, 1);
  assert.equal(payload.limit, 20);

  const { limit, offset } = extractPaginationBindings(
    state,
    /FROM audit_logs a/,
  );
  assert.equal(limit, 20);
  assert.equal(offset, 0);
});

test("listTrashFiles floors non-integer pagination input", async () => {
  const { listTrashFiles } = loadModule("routes/fileListing.js");
  const { state, db } = createDb({
    countTable: "files",
    listTable: "files f",
  });

  const response = await listTrashFiles(
    createGetRequest("https://example.com/api/files/trash?page=2.7&limit=50.9"),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  // 非整数 → floor
  assert.equal(payload.page, 2);
  assert.equal(payload.limit, 50);

  const { limit, offset } = extractPaginationBindings(state, /FROM files f/);
  assert.equal(limit, 50);
  assert.equal(offset, 50);
});

test("normalizePageParam / normalizeLimitParam share the shares.ts semantics", async () => {
  const { normalizePageParam, normalizeLimitParam, MAX_PAGE_VALUE } =
    loadModule("utils/pagination.js");

  // NaN → fallback
  assert.equal(normalizePageParam("abc"), 1);
  assert.equal(normalizePageParam(null), 1);
  assert.equal(normalizeLimitParam("abc"), 20);
  // 超界 → clamp
  assert.equal(normalizePageParam("1e15"), MAX_PAGE_VALUE);
  assert.equal(normalizeLimitParam("101"), 100);
  // 下界 clamp 到 1
  assert.equal(normalizePageParam("0"), 1);
  assert.equal(normalizePageParam("-5"), 1);
  assert.equal(normalizeLimitParam("0"), 1);
  // 非整数 → floor
  assert.equal(normalizePageParam("2.7"), 2);
  assert.equal(normalizeLimitParam("50.9"), 50);
  // 正常值直通
  assert.equal(normalizePageParam("3"), 3);
  assert.equal(normalizeLimitParam("30"), 30);
});
