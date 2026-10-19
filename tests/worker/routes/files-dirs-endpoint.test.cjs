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

const USER = {
  id: "user-1",
  username: "u1",
  role: "user",
  status: "active",
  quota_bytes: 1024,
};
const ADMIN_USER = { ...USER, id: "admin-1", username: "admin", role: "admin" };

function createGetRequest(url, user = USER) {
  const request = new Request(url, { method: "GET" });
  request.user = user;
  return request;
}

/**
 * 可配置 mock D1：按 SQL 片段路由 .all() / .first() 返回值，并记录每次调用的
 * sql/args。listFileDirs 除两张来源表的聚合扫描外，还会各发一次「+1 行」
 * 截断探测（.first()），未注册的 SQL 直接抛错以防漏断言。
 */
function createDb(rows, options = {}) {
  const state = { alls: [], firsts: [] };
  const truncationRows = options.truncationRows || {};
  let sourceScan = 0;

  function resolveAll(sql) {
    if (/FROM (files f|file_dirs)/.test(sql)) {
      // 依次对应两段来源扫描：files、file_dirs
      const key = sourceScan++ === 0 ? "files" : "fileDirs";
      return { results: rows[key] ?? [] };
    }
    throw new Error(`unexpected all SQL: ${sql}`);
  }

  // 探测 SQL 形如 `... LIMIT 1 OFFSET ?`，OFFSET 即来源扫描上限。
  // `.first('hit')` 返回的是列值本身（与生产口径一致），不是行对象。
  function resolveFirst(sql) {
    if (/FROM files f/.test(sql)) return truncationRows.files ?? 0;
    if (/FROM file_dirs/.test(sql)) return truncationRows.fileDirs ?? 0;
    throw new Error(`unexpected first SQL: ${sql}`);
  }

  return {
    state,
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async all() {
                state.alls.push({ sql, args });
                return resolveAll(sql);
              },
              async first(column) {
                state.firsts.push({ sql, args, column });
                return resolveFirst(sql, args);
              },
            };
          },
        };
      },
    },
  };
}

test("listFileDirs 聚合去重并包含祖先；flares3 扁平与 storage 嵌套口径一致", async () => {
  const { listFileDirs } = loadModule("routes/fileListing.js");
  const { state, db } = createDb({
    files: [
      { r2_key: "storage/cfg1/a/b/x.pdf", config_id: "cfg1" },
      { r2_key: "storage/cfg1/a/c.pdf", config_id: "cfg1" },
      { r2_key: "flares3/cfg2/flat.pdf", config_id: "cfg2" }, // 扁平 → 不产生目录
      { r2_key: "uploads/legacy.pdf", config_id: null }, // legacy → 根
    ],
    fileDirs: [],
  });

  const response = await listFileDirs(
    createGetRequest("https://example.com/api/files/dirs"),
    { DB: db },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  // a/b/x → a, a/b ； a/c → a ；扁平/legacy 无目录
  assert.deepEqual(body.dirs, ["a", "a/b"]);
  assert.equal(body.truncated, false, "未触达扫描上限时不得误报截断");
  assert.equal(state.alls.length, 2, "files 与 file_dirs 各一次聚合扫描");
});

test("listFileDirs 普通用户强制 owner 边界", async () => {
  const { listFileDirs } = loadModule("routes/fileListing.js");
  const { state, db } = createDb({ files: [], fileDirs: [] });

  await listFileDirs(
    createGetRequest("https://example.com/api/files/dirs?owner_id=other"),
    {
      DB: db,
    },
  );
  const q = state.alls[0];
  assert.match(q.sql, /f\.owner_id = \?/);
  assert.equal(q.args[0], "user-1", "普通用户忽略 owner_id，强制自身");
});

test("listFileDirs admin 可按 owner_id 维度", async () => {
  const { listFileDirs } = loadModule("routes/fileListing.js");
  const { state, db } = createDb({ files: [], fileDirs: [] });

  await listFileDirs(
    createGetRequest(
      "https://example.com/api/files/dirs?owner_id=target",
      ADMIN_USER,
    ),
    { DB: db },
  );
  const q = state.alls[0];
  assert.equal(q.args[0], "target");
});

test("listFileDirs 空集返回 { dirs: [] }，未授权 401", async () => {
  const { listFileDirs } = loadModule("routes/fileListing.js");
  const { db } = createDb({ files: [], fileDirs: [] });
  const ok = await listFileDirs(
    createGetRequest("https://example.com/api/files/dirs"),
    {
      DB: db,
    },
  );
  const okBody = await ok.json();
  assert.deepEqual(okBody.dirs, []);
  assert.equal(okBody.truncated, false);

  const noUser = new Request("https://example.com/api/files/dirs", {
    method: "GET",
  });
  const unauth = await listFileDirs(noUser, { DB: db });
  assert.equal(unauth.status, 401);
});

test("listFileDirs 显式上报扫描截断，而不是静默返回不完整目录集", async () => {
  const { listFileDirs } = loadModule("routes/fileListing.js");
  const { state, db } = createDb(
    {
      files: [{ r2_key: "storage/cfg1/a/x.pdf", config_id: "cfg1" }],
      fileDirs: [],
    },
    // files 来源探测命中第 5001 行 → 扫描被截断
    { truncationRows: { files: 1, fileDirs: 0 } },
  );

  const response = await listFileDirs(
    createGetRequest("https://example.com/api/files/dirs"),
    { DB: db },
  );
  const body = await response.json();
  assert.equal(body.truncated, true);
  assert.deepEqual(body.dirs, ["a"]);

  // 探测必须与聚合扫描同口径：同 WHERE / owner 过滤，只换 LIMIT/OFFSET
  const [filesProbe, dirsProbe] = state.firsts;
  assert.match(
    filesProbe.sql,
    /^SELECT 1 AS hit FROM files f WHERE .*f\.owner_id = \?/,
  );
  assert.match(filesProbe.sql, /LIMIT \? OFFSET \?$/);
  assert.equal(filesProbe.args[filesProbe.args.length - 1], 5000);
  assert.equal(filesProbe.column, "hit");
  assert.match(
    dirsProbe.sql,
    /^SELECT 1 AS hit FROM file_dirs WHERE owner_id = \?/,
  );
  assert.equal(dirsProbe.args[dirsProbe.args.length - 1], 5000);
});

test("listFileDirs 探测失败不阻断目录列表（降级为未截断）", async () => {
  const { listFileDirs } = loadModule("routes/fileListing.js");
  // 探测查询抛错：主流程已成功的目录集必须原样返回
  const db = {
    prepare(sql) {
      if (/SELECT 1 AS hit/.test(sql)) throw new Error("probe unavailable");
      return {
        bind() {
          return {
            async all() {
              return {
                results: [
                  { r2_key: "storage/cfg1/a/x.pdf", config_id: "cfg1" },
                ],
              };
            },
          };
        },
      };
    },
  };

  const response = await listFileDirs(
    createGetRequest("https://example.com/api/files/dirs"),
    { DB: db },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.dirs, ["a"]);
  assert.equal(body.truncated, false);
});
