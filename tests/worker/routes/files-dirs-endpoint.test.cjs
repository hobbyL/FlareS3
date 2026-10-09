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

function createDb(rows) {
  const state = { alls: [] };
  return {
    state,
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async all() {
                state.alls.push({ sql, args });
                return { results: rows };
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
  const { db } = createDb([
    { r2_key: "storage/cfg1/a/b/x.pdf", config_id: "cfg1" },
    { r2_key: "storage/cfg1/a/c.pdf", config_id: "cfg1" },
    { r2_key: "flares3/cfg2/flat.pdf", config_id: "cfg2" }, // 扁平 → 不产生目录
    { r2_key: "uploads/legacy.pdf", config_id: null }, // legacy → 根
  ]);

  const response = await listFileDirs(
    createGetRequest("https://example.com/api/files/dirs"),
    { DB: db },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  // a/b/x → a, a/b ； a/c → a ；扁平/legacy 无目录
  assert.deepEqual(body.dirs, ["a", "a/b"]);
});

test("listFileDirs 普通用户强制 owner 边界", async () => {
  const { listFileDirs } = loadModule("routes/fileListing.js");
  const { state, db } = createDb([]);

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
  const { state, db } = createDb([]);

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
  const { db } = createDb([]);
  const ok = await listFileDirs(
    createGetRequest("https://example.com/api/files/dirs"),
    {
      DB: db,
    },
  );
  assert.deepEqual((await ok.json()).dirs, []);

  const noUser = new Request("https://example.com/api/files/dirs", {
    method: "GET",
  });
  const unauth = await listFileDirs(noUser, { DB: db });
  assert.equal(unauth.status, 401);
});
