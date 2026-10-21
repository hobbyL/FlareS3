const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createSqliteDb } = require("../helpers/sqlite-db.cjs");
const root =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");
const deletion = require(path.join(root, "services/fileDeletion.js"));
const queue = require(path.join(root, "jobs/cleanupDeleteQueue.js"));
const files = require(path.join(root, "routes/files.js"));
const r2 = require(path.join(root, "services/r2.js"));

function setup() {
  const { db, sqlite } = createSqliteDb();
  sqlite.exec(`
    INSERT INTO users(id,username,password_hash,role,status,quota_bytes,created_at,updated_at)
    VALUES('u','alice','hash','admin','active',1000,'2026-01-01','2026-01-01');
    INSERT INTO files(id,owner_id,filename,r2_key,size,content_type,expires_in,created_at,expires_at,upload_status,deleted_at)
    VALUES('f','u','demo','flares3/c/demo',10,'text/plain',0,'2026-01-01','9999-01-01','deleted','2026-01-02');
    INSERT INTO delete_queue(id,file_id,r2_key,created_at) VALUES('q','f','flares3/c/demo','2026-01-02');
    INSERT INTO file_shares(id,file_id,owner_id,share_code,created_at,updated_at)
    VALUES('s','f','u','share','2026-01-01','2026-01-01');
  `);
  r2.resolveR2ConfigForKey = async () => ({ id: "c", config: {} });
  r2.checkObjectExists = async () => true;
  return { db, sqlite };
}
function restore(db) {
  const request = Object.assign(
    new Request("https://example.com/api/files/f/restore", { method: "POST" }),
    {
      user: { id: "u", role: "admin", username: "alice" },
    },
  );
  return files.restoreFile(request, { DB: db }, "f");
}

test("restoring after the queue snapshot prevents any physical delete", async () => {
  const { db, sqlite } = setup();
  const prepare = db.prepare;
  let restoreResponse;
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    if (!sql.includes("FROM delete_queue dq")) return stmt;
    const originalBind = stmt.bind;
    stmt.bind = (...args) => {
      const bound = originalBind(...args);
      const all = bound.all;
      bound.all = async () => {
        const snapshot = await all();
        restoreResponse = await restore(db);
        return snapshot;
      };
      return bound;
    };
    return stmt;
  };
  let deletes = 0;
  r2.deleteObject = async () => {
    deletes += 1;
  };
  await queue.cleanupDeleteQueue({ DB: db });
  assert.equal(restoreResponse.status, 200);
  assert.equal(deletes, 0);
  assert.equal(
    sqlite.prepare("SELECT upload_status FROM files WHERE id = 'f'").get()
      .upload_status,
    "completed",
  );
  assert.ok(
    sqlite.prepare("SELECT processed_at FROM delete_queue WHERE id = 'q'").get()
      .processed_at,
  );
  sqlite.close();
});

test("physical deletion claim blocks restore even after its lease expires", async () => {
  const { db, sqlite } = setup();
  assert.ok(await deletion.claimFileDeletion(db, "f", "flares3/c/demo", "q"));
  sqlite.exec(
    "UPDATE files SET deletion_lease_until = '2000-01-01' WHERE id = 'f'",
  );
  const response = await restore(db);
  assert.equal(response.status, 409);
  assert.equal(
    sqlite.prepare("SELECT processed_at FROM delete_queue WHERE id = 'q'").get()
      .processed_at,
    null,
  );
  sqlite.close();
});

test("expired executor cannot clear records after another executor takes over", async () => {
  const { db, sqlite } = setup();
  const oldToken = await deletion.claimFileDeletion(db, "f", "flares3/c/demo");
  sqlite.exec(
    "UPDATE files SET deletion_lease_until = '2000-01-01' WHERE id = 'f'",
  );
  const newToken = await deletion.claimFileDeletion(db, "f", "flares3/c/demo");
  assert.notEqual(oldToken, newToken);
  const oldResult = await db.batch(
    deletion.prepareClaimedFileCleanup(
      db,
      "f",
      oldToken,
      new Date().toISOString(),
    ),
  );
  assert.equal(oldResult[2].meta.changes, 0);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM file_shares").get().n,
    1,
  );
  const result = await db.batch(
    deletion.prepareClaimedFileCleanup(
      db,
      "f",
      newToken,
      new Date().toISOString(),
    ),
  );
  assert.equal(result[2].meta.changes, 1);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM file_shares").get().n,
    0,
  );
  sqlite.close();
});

test("physical cleanup waits until issued upload credentials expire", async () => {
  const { db, sqlite } = setup();
  sqlite
    .prepare(
      "UPDATE files SET upload_key = 'flares3/c/.uploads/f', upload_updated_at = ? WHERE id = 'f'",
    )
    .run(new Date().toISOString());
  assert.equal(
    await deletion.claimFileDeletion(db, "f", "flares3/c/demo", "q"),
    null,
  );
  assert.equal(
    sqlite.prepare("SELECT deletion_token FROM files WHERE id = 'f'").get()
      .deletion_token,
    null,
  );
  sqlite
    .prepare("UPDATE files SET upload_updated_at = ? WHERE id = 'f'")
    .run(new Date(Date.now() - 66 * 60 * 1000).toISOString());
  assert.ok(await deletion.claimFileDeletion(db, "f", "flares3/c/demo", "q"));
  sqlite.close();
});
