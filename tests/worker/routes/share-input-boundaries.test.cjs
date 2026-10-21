const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createSqliteDb } = require("../helpers/sqlite-db.cjs");
const root =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");
const { upsertFileShare } = require(path.join(root, "routes/fileShares.js"));
const { upsertTextShare } = require(path.join(root, "routes/textShares.js"));
const { createFolderShare } = require(
  path.join(root, "routes/folderShares.js"),
);
const { deleteConfig } = require(path.join(root, "routes/r2Configs.js"));
function setup() {
  const state = createSqliteDb();
  state.sqlite
    .exec(`INSERT INTO users(id,username,password_hash,role,status,quota_bytes,created_at,updated_at) VALUES('u','alice','hash','admin','active',1000,'2026-01-01','2026-01-01');
    INSERT INTO files(id,owner_id,filename,r2_key,size,content_type,expires_in,created_at,expires_at,upload_status) VALUES('f','u','demo','flares3/c/demo',10,'text/plain',0,'2026-01-01','9999-01-01','completed');
    INSERT INTO texts(id,owner_id,title,content,created_at,updated_at) VALUES('t','u','note','content','2026-01-01','2026-01-01');
    INSERT INTO r2_configs(id,name,endpoint,bucket_name,access_key_id_enc,secret_access_key_enc,created_at,updated_at) VALUES('c','config','https://example.com','bucket','ak','sk','2026-01-01','2026-01-01');`);
  return state;
}
function request(body) {
  return Object.assign(
    new Request("https://example.com/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { user: { id: "u", role: "admin", status: "active" } },
  );
}
for (const value of [0.5, -1, Number.MAX_SAFE_INTEGER + 1, "1", true]) {
  test(`all share types reject unsafe max_views ${JSON.stringify(value)} without creating shares`, async () => {
    const { db, sqlite } = setup();
    assert.equal(
      (await upsertFileShare(request({ max_views: value }), { DB: db }, "f"))
        .status,
      400,
    );
    assert.equal(
      (await upsertTextShare(request({ max_views: value }), { DB: db }, "t"))
        .status,
      400,
    );
    assert.equal(
      (
        await createFolderShare(
          request({ config_id: "c", prefix: "docs", max_views: value }),
          { DB: db },
        )
      ).status,
      400,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM file_shares").get().n,
      0,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM text_shares").get().n,
      0,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM folder_shares").get().n,
      0,
    );
    sqlite.close();
  });
}
test("share passwords reject multibyte values above bcrypt limit", async () => {
  const { db, sqlite } = setup();
  const password = "密".repeat(25);
  assert.equal(
    (await upsertFileShare(request({ password }), { DB: db }, "f")).status,
    400,
  );
  assert.equal(
    (await upsertTextShare(request({ password }), { DB: db }, "t")).status,
    400,
  );
  assert.equal(
    (
      await createFolderShare(
        request({ config_id: "c", prefix: "docs", password }),
        { DB: db },
      )
    ).status,
    400,
  );
  sqlite.close();
});
test("processed deletion history no longer prevents removing an unused R2 config", async () => {
  const { db, sqlite } = setup();
  sqlite.exec(
    "INSERT INTO delete_queue(id,file_id,r2_key,created_at,processed_at) VALUES('q','f','flares3/c/demo','2026-01-01','2026-01-02'); DELETE FROM files WHERE id='f'",
  );
  assert.equal((await deleteConfig(request({}), { DB: db }, "c")).status, 200);
  assert.equal(
    sqlite.prepare("SELECT id FROM r2_configs WHERE id='c'").get(),
    undefined,
  );
  sqlite.close();
});
