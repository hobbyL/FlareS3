const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function setup({
  occupied = false,
  conflict = false,
  completeChanges = 1,
  database,
} = {}) {
  for (const name of [
    "routes/upload/server",
    "routes/upload/helpers",
    "services/storage/factory",
    "services/uploadConfigPolicy",
  ]) {
    delete require.cache[path.join(root, `${name}.js`)];
  }
  const helpers = require(path.join(root, "routes/upload/helpers.js"));
  const policy = require(path.join(root, "services/uploadConfigPolicy.js"));
  const factory = require(path.join(root, "services/storage/factory.js"));
  const { StorageError } = require(
    path.join(root, "services/storage/types.js"),
  );
  const calls = { inserted: [], uploaded: [], deleted: [], sql: [] };
  policy.resolveServerUploadConfigForUser = async () => ({ type: "webdav" });
  helpers.createPendingUploadFileRecord = async (_env, owner, file) => {
    calls.inserted.push(file);
    if (database) {
      await database
        .prepare(
          "INSERT INTO files(id,owner_id,filename,r2_key,size,content_type,expires_in,created_at,expires_at,upload_status,config_id,short_code,require_login,upload_updated_at) VALUES(?,?,?,?,7,'text/plain',0,?,?,'pending','dav',?,0,?)",
        )
        .bind(
          file.id,
          owner,
          file.filename,
          file.r2Key,
          new Date().toISOString(),
          file.expiresAt.toISOString(),
          file.shortCode,
          new Date().toISOString(),
        )
        .run();
      await database
        .prepare(
          "INSERT INTO upload_reservations(file_id,user_id,r2_config_id,reserved_bytes,status,created_at,updated_at) VALUES(?,'admin','dav',7,'active','2026-10-20','2026-10-20')",
        )
        .bind(file.id)
        .run();
    }
  };
  helpers.markFileUploadDeleted = async () => {
    calls.sql.push("mark-deleted");
  };
  factory.createProvider = async () => ({
    createFolder: async () => {},
    upload: async (key, _body, _type, _size, options) => {
      calls.uploaded.push({ key, options });
      if (conflict) throw new StorageError("exists", "TargetExists", 409);
    },
    delete: async (key) => {
      calls.deleted.push(key);
    },
  });
  function statement(sql) {
    return {
      bind() {
        return this;
      },
      async first() {
        return occupied ? "existing" : null;
      },
      async run() {
        calls.sql.push(sql);
        return {
          meta: {
            changes: sql.startsWith(
              "UPDATE files SET upload_status = 'completed'",
            )
              ? completeChanges
              : 1,
          },
        };
      },
    };
  }
  const db = {
    prepare: statement,
    async batch(ss) {
      const result = [];
      for (const s of ss) result.push(await s.run());
      return result;
    },
  };
  const form = new FormData();
  form.set("config_id", "dav");
  form.set("filename", "demo.txt");
  form.set("file", new File(["payload"], "demo.txt"));
  const request = new Request("https://example.com/api/upload/server", {
    method: "POST",
    body: form,
    headers: { "Content-Length": "500" },
  });
  request.user = { id: "admin", role: "admin", quota_bytes: 1000 };
  return {
    calls,
    run: () =>
      require(path.join(root, "routes/upload/server.js")).serverUpload(
        request,
        { DB: database || db },
      ),
  };
}

test("all occupied candidates return 409 without remote writes or compensation", async () => {
  const { calls, run } = setup({ occupied: true });
  assert.equal((await run()).status, 409);
  assert.deepEqual(calls.inserted, []);
  assert.deepEqual(calls.uploaded, []);
  assert.deepEqual(calls.deleted, []);
});

function sqliteSetup() {
  const { createSqliteDb } = require("../../helpers/sqlite-db.cjs");
  const state = createSqliteDb();
  state.sqlite.exec(
    "INSERT INTO users(id,username,password_hash,role,status,quota_bytes,created_at,updated_at) VALUES('admin','admin','hash','admin','active',1000,'2026-01-01','2026-01-01')",
  );
  state.sqlite.exec(
    "INSERT INTO r2_configs(id,name,endpoint,bucket_name,access_key_id_enc,secret_access_key_enc,quota_bytes,created_at,updated_at) VALUES('dav','test','https://example.com','bucket','ak','sk',1000,'2026-01-01','2026-01-01')",
  );
  return state;
}

test("failed completion retains the real key for retry when remote delete fails", async () => {
  const { db, sqlite } = sqliteSetup();
  const batch = db.batch;
  let batches = 0;
  db.batch = async (statements) => {
    if (++batches === 2) throw new Error("completion transaction failed");
    return batch(statements);
  };
  const { calls, run } = setup({ database: db });
  const response = await run();
  assert.equal(response.status, 502);
  assert.ok(calls.inserted.length, JSON.stringify(await response.json()));
  const row = sqlite.prepare("SELECT * FROM files").get();
  assert.equal(row.r2_key, calls.uploaded[0].key);
  assert.equal(row.upload_status, "deleted");
  assert.equal(
    sqlite.prepare("SELECT r2_key FROM delete_queue").get().r2_key,
    row.r2_key,
  );
  assert.equal(
    sqlite.prepare("SELECT status FROM upload_reservations").get().status,
    "released",
  );
  const factory = require(path.join(root, "services/storage/factory.js"));
  let failures = true;
  factory.createProvider = async () => ({
    delete: async (key) => {
      assert.equal(key, row.r2_key);
      if (failures) throw new Error("upstream unavailable");
    },
  });
  delete require.cache[path.join(root, "jobs/cleanupDeleteQueue.js")];
  const { cleanupDeleteQueue } = require(
    path.join(root, "jobs/cleanupDeleteQueue.js"),
  );
  assert.equal((await cleanupDeleteQueue({ DB: db })).failed, 1);
  assert.ok(sqlite.prepare("SELECT id FROM files").get());
  assert.equal(
    sqlite.prepare("SELECT processed_at FROM delete_queue").get().processed_at,
    null,
  );
  failures = false;
  sqlite.exec(
    "UPDATE delete_queue SET next_attempt_at = '2000-01-01'; UPDATE files SET deletion_lease_until = '2000-01-01'",
  );
  assert.equal((await cleanupDeleteQueue({ DB: db })).succeeded, 1);
  assert.equal(sqlite.prepare("SELECT id FROM files").get(), undefined);
  sqlite.close();
});

test("a completion timeout after commit preserves the completed object", async () => {
  const { db, sqlite } = sqliteSetup();
  const batch = db.batch;
  let batches = 0;
  db.batch = async (statements) => {
    const result = await batch(statements);
    if (++batches === 2) throw new Error("response timeout after commit");
    return result;
  };
  const { calls, run } = setup({ database: db });
  const response = await run();
  assert.equal(
    response.status,
    200,
    JSON.stringify(await response.clone().json()),
  );
  assert.equal(
    sqlite.prepare("SELECT upload_status FROM files").get().upload_status,
    "completed",
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM delete_queue").get().n,
    0,
  );
  assert.deepEqual(calls.deleted, []);
  sqlite.close();
});

test("remote collision discards pending row without deleting the existing object", async () => {
  const { calls, run } = setup({ conflict: true });
  assert.equal((await run()).status, 409);
  assert.deepEqual(calls.uploaded[0].options, { ifNoneMatch: "*" });
  assert.notEqual(calls.inserted[0].r2Key, calls.uploaded[0].key);
  assert.match(calls.inserted[0].r2Key, /\/\.pending\//);
  assert.deepEqual(calls.deleted, []);
  assert.ok(calls.sql.some((sql) => sql.startsWith("DELETE FROM files")));
  assert.ok(!calls.sql.includes("mark-deleted"));
});

test("completion conflict durably queues the successfully created object", async () => {
  const { calls, run } = setup({ completeChanges: 0 });
  assert.equal((await run()).status, 502);
  assert.deepEqual(calls.deleted, []);
  assert.ok(
    calls.sql.some((sql) => sql.startsWith("UPDATE files SET r2_key = ?")),
  );
  assert.ok(
    calls.sql.some((sql) =>
      sql.startsWith("UPDATE delete_queue SET r2_key = ?"),
    ),
  );
  assert.ok(
    calls.sql.some((sql) => sql.startsWith("INSERT INTO delete_queue")),
  );
});
