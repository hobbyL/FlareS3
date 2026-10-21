const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createSqliteDb } = require("../helpers/sqlite-db.cjs");
const root =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");
const r2 = require(path.join(root, "services/r2.js"));
const { cleanupExpired } = require(path.join(root, "jobs/cleanupExpired.js"));
const { cleanupDeleteQueue } = require(
  path.join(root, "jobs/cleanupDeleteQueue.js"),
);
const { restoreFile } = require(path.join(root, "routes/files.js"));
const { markFileUploadDeleted } = require(
  path.join(root, "routes/upload/helpers.js"),
);
const reservations = require(path.join(root, "services/uploadReservations.js"));
const { cleanupRetention } = require(
  path.join(root, "jobs/cleanupRetention.js"),
);
const { initMultipart } = require(
  path.join(root, "routes/upload/multipart.js"),
);
const { completeMultipart, getMultipartParts } = require(
  path.join(root, "routes/upload/multipart.js"),
);
const policy = require(path.join(root, "services/uploadConfigPolicy.js"));
const { deleteUser } = require(path.join(root, "routes/users.js"));
const NOW = new Date("2026-10-20T12:00:00.000Z");
function setup() {
  const state = createSqliteDb();
  state.sqlite
    .exec(`INSERT INTO users(id,username,password_hash,role,status,quota_bytes,created_at,updated_at)
    VALUES('u','alice','hash','user','active',100,'2026-01-01','2026-01-01');
    INSERT INTO r2_configs(id,name,endpoint,bucket_name,access_key_id_enc,secret_access_key_enc,quota_bytes,created_at,updated_at)
    VALUES('c','config','https://example.com','bucket','ak','sk',95,'2026-01-01','2026-01-01');`);
  r2.resolveR2ConfigForKey = async () => ({ id: "c", config: {} });
  r2.checkObjectExists = async () => true;
  r2.deleteObject = async () => {};
  r2.abortMultipartUpload = async () => {};
  return state;
}
function file(sqlite, id, status, size = 10) {
  sqlite
    .prepare(
      `INSERT INTO files(id,owner_id,filename,r2_key,size,content_type,expires_in,created_at,expires_at,upload_status,config_id,deleted_at)
    VALUES(?,'u',?, ?,?,'text/plain',0,'2026-10-18','9999-01-01',?,'c',?)`,
    )
    .run(
      id,
      id,
      `flares3/c/${id}`,
      size,
      status,
      status === "deleted" ? "2026-10-19" : null,
    );
}
function reserve(sqlite, id, size = 10) {
  sqlite
    .prepare(
      `INSERT INTO upload_reservations(file_id,user_id,r2_config_id,reserved_bytes,status,created_at,updated_at)
    VALUES(?,'u','c',?,'active','2026-10-18','2026-10-18')`,
    )
    .run(id, size);
}
const request = () =>
  Object.assign(new Request("https://example.com/api"), {
    user: { id: "u", role: "user" },
  });

test("deleted-owner cleanup continues beyond already queued failed files", async () => {
  const { db, sqlite } = setup();
  sqlite.exec("UPDATE users SET status='deleted' WHERE id='u'");
  for (let i = 0; i < 100; i++) {
    const id = `blocked-${String(i).padStart(3, "0")}`;
    file(sqlite, id, "deleted", 1);
    sqlite
      .prepare(
        "INSERT INTO delete_queue(id,file_id,r2_key,created_at) VALUES(?,?,?,?)",
      )
      .run(`q-${id}`, id, `flares3/c/${id}`, "2026-01-01");
  }
  file(sqlite, "remaining", "completed", 1);
  reserve(sqlite, "remaining", 1);
  const result = await cleanupExpired({ DB: db }, NOW);
  assert.equal(result.details.deletedFiles, 1);
  assert.ok(
    sqlite
      .prepare("SELECT id FROM delete_queue WHERE file_id='remaining'")
      .get(),
  );
  assert.equal(
    sqlite
      .prepare(
        "SELECT status FROM upload_reservations WHERE file_id='remaining'",
      )
      .get().status,
    "released",
  );
  sqlite.close();
});

test("duplicate completion after the initial read skips upstream merge and succeeds", async () => {
  const { db, sqlite } = setup();
  file(sqlite, "duplicate", "uploading");
  reserve(sqlite, "duplicate");
  sqlite.exec(
    "UPDATE files SET multipart_upload_id = 'mp' WHERE id = 'duplicate'",
  );
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.startsWith("SELECT id, owner_id, filename, r2_key"))
      return statement;
    return {
      ...statement,
      bind(...args) {
        const bound = statement.bind(...args);
        return {
          ...bound,
          async first() {
            const snapshot = await bound.first();
            sqlite.exec(
              "UPDATE files SET upload_status = 'completed', multipart_upload_id = NULL WHERE id = 'duplicate'",
            );
            return snapshot;
          },
        };
      },
    };
  };
  r2.completeMultipartUpload = async () => {
    throw new Error("already completed: must not merge again");
  };
  r2.getObjectSize = async () => 10;
  const req = Object.assign(
    new Request("https://example.com/api/upload/multipart/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_id: "duplicate",
        upload_id: "mp",
        parts: [{ part_number: 1, etag: "v1" }],
      }),
    }),
    { user: { id: "u", role: "user" } },
  );
  assert.equal((await completeMultipart(req, { DB: db })).status, 200);
  assert.equal(
    sqlite
      .prepare(
        "SELECT status FROM upload_reservations WHERE file_id='duplicate'",
      )
      .get().status,
    "consumed",
  );
  sqlite.close();
});

test("listing uploaded parts renews activity and cannot renew a deleted upload", async () => {
  const { db, sqlite } = setup();
  file(sqlite, "resume", "uploading");
  sqlite.exec(
    "UPDATE files SET multipart_upload_id = 'mp' WHERE id = 'resume'",
  );
  let calls = 0;
  r2.listParts = async () => {
    calls++;
    return [];
  };
  const req = () =>
    Object.assign(
      new Request(
        "https://example.com/api/upload/multipart/parts?file_id=resume&upload_id=mp",
      ),
      { user: { id: "u" } },
    );
  assert.equal((await getMultipartParts(req(), { DB: db })).status, 200);
  assert.ok(
    sqlite
      .prepare("SELECT upload_updated_at FROM files WHERE id = 'resume'")
      .get().upload_updated_at,
  );
  sqlite.exec("UPDATE files SET deleted_at = '2026-10-20' WHERE id = 'resume'");
  assert.equal((await getMultipartParts(req(), { DB: db })).status, 409);
  assert.equal(calls, 1);
  sqlite.close();
});

test("a stale completion cannot consume a deleted file reservation", async () => {
  const { db, sqlite } = setup();
  file(sqlite, "stale", "deleted");
  reserve(sqlite, "stale");
  assert.equal(
    (await reservations.prepareConsumeUploadReservation(db, "stale").run()).meta
      .changes,
    0,
  );
  assert.equal(
    sqlite
      .prepare("SELECT status FROM upload_reservations WHERE file_id='stale'")
      .get().status,
    "active",
  );
  sqlite.close();
});

test("restore quota includes completed files and active reservations and rejects without side effects", async () => {
  const { db, sqlite } = setup();
  file(sqlite, "trash", "deleted", 60);
  file(sqlite, "used", "completed", 30);
  reserve(sqlite, "trash", 20);
  assert.equal((await restoreFile(request(), { DB: db }, "trash")).status, 409);
  assert.equal(
    sqlite
      .prepare("SELECT status FROM upload_reservations WHERE file_id='trash'")
      .get().status,
    "active",
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n,
    0,
  );
  sqlite.exec("UPDATE upload_reservations SET status='released'");
  assert.equal((await restoreFile(request(), { DB: db }, "trash")).status, 200);
  assert.equal(
    sqlite.prepare("SELECT upload_status FROM files WHERE id='trash'").get()
      .upload_status,
    "completed",
  );
  sqlite.close();
});
test("trash consumes physical config capacity and prevents new reservations and restore over capacity", async () => {
  const { db, sqlite } = setup();
  file(sqlite, "trash", "deleted", 60);
  file(sqlite, "used", "completed", 30);
  assert.equal(await reservations.getCompletedConfigUsedSpace(db, "c"), 90);
  await assert.rejects(
    () =>
      reservations.reserveUploadCapacity(
        { DB: db, TOTAL_STORAGE: "95" },
        {
          fileId: "new",
          userId: "u",
          userQuotaBytes: 1000,
          r2ConfigId: "c",
          declaredSize: 10,
        },
      ),
    (error) => error.code === "UPLOAD_CONFIG_CAPACITY_EXCEEDED",
  );
  sqlite.exec("UPDATE r2_configs SET quota_bytes=80 WHERE id='c'");
  assert.equal((await restoreFile(request(), { DB: db }, "trash")).status, 409);
  sqlite.close();
});

test("storage configuration lists display the same physical trash capacity as admission", async () => {
  const { db, sqlite } = setup();
  file(sqlite, "trash-ui", "deleted", 60);
  file(sqlite, "used-ui", "completed", 30);
  r2.listR2ConfigSummaries = async () => ({
    default_config_id: "c",
    legacy_files_config_id: null,
    configs: [
      {
        id: "c",
        name: "config",
        source: "database",
        endpoint: "https://example.com",
        bucketName: "bucket",
        quotaBytes: 95,
      },
    ],
  });
  const webdav = require(path.join(root, "services/storage/webdav-config.js"));
  webdav.listWebDAVConfigs = async () => [];
  const r2Route = require(path.join(root, "routes/r2Configs.js"));
  const storageRoute = require(path.join(root, "routes/storageConfigs.js"));
  for (const list of [r2Route.listConfigs, storageRoute.listAllConfigs]) {
    const response = await list(request(), { DB: db });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.configs[0].usedSpace, 90);
  }
  sqlite.close();
});
test("never-expiring abandoned multipart upload becomes irreversible queue work with upload ID", async () => {
  const { db, sqlite } = setup();
  file(sqlite, "old", "uploading");
  reserve(sqlite, "old");
  sqlite.exec("UPDATE files SET multipart_upload_id='mp-old' WHERE id='old'");
  const result = await cleanupExpired({ DB: db }, NOW);
  assert.equal(result.details.deletedFiles, 1);
  const row = sqlite
    .prepare(
      "SELECT upload_status,deletion_started_at,multipart_upload_id FROM files WHERE id='old'",
    )
    .get();
  assert.equal(row.upload_status, "deleted");
  assert.ok(row.deletion_started_at);
  assert.equal(row.multipart_upload_id, "mp-old");
  assert.equal(
    sqlite
      .prepare(
        "SELECT multipart_upload_id FROM delete_queue WHERE file_id='old'",
      )
      .get().multipart_upload_id,
    "mp-old",
  );
  assert.equal(
    sqlite
      .prepare("SELECT status FROM upload_reservations WHERE file_id='old'")
      .get().status,
    "released",
  );
  assert.equal((await restoreFile(request(), { DB: db }, "old")).status, 409);
  const calls = [];
  r2.abortMultipartUpload = async (_config, key, id) =>
    calls.push(["abort", key, id]);
  r2.deleteObject = async (_config, key) => calls.push(["delete", key]);
  await cleanupDeleteQueue({ DB: db });
  assert.deepEqual(calls, [
    ["abort", "flares3/c/old", "mp-old"],
    ["delete", "flares3/c/old"],
  ]);
  assert.equal(
    sqlite.prepare("SELECT id FROM files WHERE id='old'").get(),
    undefined,
  );
  sqlite.close();
});
test("activity renewed after scan preserves upload and its reservation", async () => {
  const { db, sqlite } = setup();
  file(sqlite, "renewed", "uploading");
  reserve(sqlite, "renewed");
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    if (!sql.startsWith("SELECT id, r2_key, upload_status")) return stmt;
    return {
      ...stmt,
      bind(...args) {
        const bound = stmt.bind(...args);
        return {
          ...bound,
          async all() {
            const result = await bound.all();
            sqlite.exec(
              `UPDATE files SET upload_updated_at='${NOW.toISOString()}' WHERE id='renewed'`,
            );
            return result;
          },
        };
      },
    };
  };
  const result = await cleanupExpired({ DB: db }, NOW);
  assert.equal(result.details.deletedFiles, 0);
  assert.equal(
    sqlite.prepare("SELECT upload_status FROM files WHERE id='renewed'").get()
      .upload_status,
    "uploading",
  );
  assert.equal(
    sqlite
      .prepare("SELECT status FROM upload_reservations WHERE file_id='renewed'")
      .get().status,
    "active",
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM delete_queue").get().n,
    0,
  );
  sqlite.close();
});
test("late failed upload compensation cannot release a completed upload reservation", async () => {
  const { db, sqlite } = setup();
  file(sqlite, "done", "completed");
  reserve(sqlite, "done");
  await markFileUploadDeleted({ DB: db }, "done");
  assert.equal(
    sqlite
      .prepare("SELECT status FROM upload_reservations WHERE file_id='done'")
      .get().status,
    "active",
  );
  sqlite.close();
});

test("expired scan cannot delete a file whose storage key changed after the snapshot", async () => {
  const { db, sqlite } = setup();
  file(sqlite, "moving", "completed");
  sqlite.exec("UPDATE files SET expires_at='2026-01-01' WHERE id='moving'");
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    if (!sql.startsWith("SELECT id, r2_key, upload_status")) return stmt;
    return {
      ...stmt,
      bind(...args) {
        const bound = stmt.bind(...args);
        return {
          ...bound,
          async all() {
            const result = await bound.all();
            sqlite.exec(
              "UPDATE files SET r2_key='flares3/c/new-key' WHERE id='moving'",
            );
            return result;
          },
        };
      },
    };
  };
  const result = await cleanupExpired({ DB: db }, NOW);
  assert.equal(result.details.deletedFiles, 0);
  assert.equal(
    sqlite.prepare("SELECT upload_status FROM files WHERE id='moving'").get()
      .upload_status,
    "completed",
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM delete_queue").get().n,
    0,
  );
  sqlite.close();
});

test("multipart cleanup treats missing temporary and final objects as idempotent success", async () => {
  const { db, sqlite } = setup();
  file(sqlite, "missing", "uploading");
  sqlite.exec(
    "UPDATE files SET multipart_upload_id='mp',upload_key='flares3/c/.uploads/missing',upload_status='deleted',deleted_at='2026-01-01' WHERE id='missing'",
  );
  r2.abortMultipartUpload = async () => {
    throw Object.assign(new Error("gone"), {
      name: "NoSuchUpload",
      $metadata: { httpStatusCode: 404 },
    });
  };
  r2.deleteObject = async () => {
    throw Object.assign(new Error("gone"), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
  };
  assert.equal((await cleanupDeleteQueue({ DB: db })).failed, 0);
  assert.equal(
    sqlite.prepare("SELECT id FROM files WHERE id='missing'").get(),
    undefined,
  );
  sqlite.close();
});
test("queue failures back off so the next page progresses and processed history is pruned", async () => {
  const { db, sqlite } = setup();
  for (let i = 0; i < 101; i++) {
    const id = `f${i}`;
    file(sqlite, id, "deleted");
    sqlite
      .prepare(
        "INSERT INTO delete_queue(id,file_id,r2_key,created_at) VALUES(?,?,?,?)",
      )
      .run(
        id,
        id,
        `flares3/c/${id}`,
        new Date(2026, 0, 1, 0, 0, i).toISOString(),
      );
  }
  sqlite.exec(
    "INSERT INTO delete_queue(id,file_id,r2_key,created_at,processed_at) VALUES('history','f0','flares3/c/f0','2020-01-01','2020-01-02')",
  );
  const calls = [];
  r2.deleteObject = async (_config, key) => {
    calls.push(key);
    if (key !== "flares3/c/f100") throw new Error("offline");
  };
  const first = await cleanupDeleteQueue({ DB: db });
  assert.equal(first.failed, 100);
  assert.equal(
    sqlite.prepare("SELECT id FROM delete_queue WHERE id='history'").get(),
    undefined,
  );
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM delete_queue WHERE attempts=1 AND next_attempt_at IS NOT NULL",
      )
      .get().n,
    100,
  );
  calls.length = 0;
  await cleanupDeleteQueue({ DB: db });
  assert.deepEqual(calls, ["flares3/c/f100"]);
  sqlite.close();
});
test("unclaimable old leases do not block newer deletions indefinitely", async () => {
  const { db, sqlite } = setup();
  file(sqlite, "leased", "deleted");
  file(sqlite, "ready", "deleted");
  sqlite.exec(
    "UPDATE files SET deletion_token='holder',deletion_started_at='2026-01-01',deletion_lease_until='9999-01-01' WHERE id='leased'",
  );
  sqlite.exec(
    "INSERT INTO delete_queue(id,file_id,r2_key,created_at) VALUES('ready','ready','flares3/c/ready','2026-01-02')",
  );
  await cleanupDeleteQueue({ DB: db });
  assert.ok(
    sqlite
      .prepare(
        "SELECT next_attempt_at FROM delete_queue WHERE file_id='leased'",
      )
      .get().next_attempt_at,
  );
  assert.equal(
    sqlite.prepare("SELECT id FROM files WHERE id='ready'").get(),
    undefined,
  );
  sqlite.close();
});
test("orphan multipart cleanup only aborts the upload ID and preserves a reused key", async () => {
  const { db, sqlite } = setup();
  file(sqlite, "new", "completed");
  sqlite.exec(
    "INSERT INTO delete_queue(id,file_id,r2_key,created_at,multipart_upload_id,orphan_multipart) VALUES('orphan','gone','flares3/c/new','2026-01-01','old-upload',1)",
  );
  const calls = [];
  r2.abortMultipartUpload = async (_config, key, id) => calls.push([key, id]);
  r2.deleteObject = async () =>
    assert.fail("orphan cleanup must not delete reused final key");
  await cleanupDeleteQueue({ DB: db });
  assert.deepEqual(calls, [["flares3/c/new", "old-upload"]]);
  assert.ok(sqlite.prepare("SELECT id FROM files WHERE id='new'").get());
  assert.ok(
    sqlite
      .prepare("SELECT processed_at FROM delete_queue WHERE id='orphan'")
      .get().processed_at,
  );
  sqlite.close();
});

test("legacy object keys count toward the mapped configuration quota", async () => {
  const { db, sqlite } = setup();
  file(sqlite, "trash", "deleted", 60);
  file(sqlite, "modern", "completed", 40);
  sqlite.exec(
    "UPDATE files SET config_id=NULL,r2_key='uploads/legacy.bin' WHERE id='trash'; INSERT INTO system_config(key,value,updated_at) VALUES('r2_legacy_files_config_id','c','2026-01-01')",
  );
  assert.equal(await reservations.getCompletedConfigUsedSpace(db, "c"), 100);
  assert.equal((await restoreFile(request(), { DB: db }, "trash")).status, 409);
  sqlite.close();
});
test("operation history retention preserves live credentials, reservations and running jobs", async () => {
  const { db, sqlite } = setup();
  file(sqlite, "active", "completed");
  reserve(sqlite, "active");
  sqlite.exec(`INSERT INTO upload_reservations(file_id,user_id,r2_config_id,reserved_bytes,status,created_at,updated_at) VALUES('old','u','c',10,'released','2020-01-01','2020-01-01');
    INSERT INTO job_runs(id,job_name,status,started_at,finished_at,created_at) VALUES('done','test','success','2020-01-01','2020-01-01','2020-01-01'),('running','test','running','2020-01-01',NULL,'2020-01-01');
    INSERT INTO api_tokens(id,user_id,name,token_hash,created_at,expires_at,revoked_at) VALUES('valid','u','valid','valid','2020-01-01',NULL,NULL),('revoked','u','revoked','revoked','2020-01-01',NULL,'2020-01-01'),('expired','u','expired','expired','2020-01-01','2020-01-01',NULL);`);
  const result = await cleanupRetention({ DB: db }, NOW);
  assert.equal(result.details.uploadReservations, 1);
  assert.equal(result.details.jobRuns, 1);
  assert.equal(result.details.apiTokens, 2);
  assert.ok(
    sqlite
      .prepare("SELECT file_id FROM upload_reservations WHERE file_id='active'")
      .get(),
  );
  assert.ok(sqlite.prepare("SELECT id FROM job_runs WHERE id='running'").get());
  assert.ok(sqlite.prepare("SELECT id FROM api_tokens WHERE id='valid'").get());
  sqlite.close();
});

test("late multipart init retains independent abort work after the file was already cleaned", async () => {
  const { db, sqlite } = setup();
  policy.resolveUploadConfigForUser = async () => ({ id: "c", config: {} });
  let fileId;
  r2.initiateMultipartUpload = async () => {
    fileId = sqlite
      .prepare("SELECT id FROM files WHERE upload_status='pending'")
      .get().id;
    sqlite
      .prepare(
        "UPDATE files SET upload_status='deleted',deleted_at='2026-10-20' WHERE id=?",
      )
      .run(fileId);
    await cleanupDeleteQueue({ DB: db });
    assert.equal(
      sqlite.prepare("SELECT id FROM files WHERE id=?").get(fileId),
      undefined,
    );
    return "late-upload-id";
  };
  r2.abortMultipartUpload = async () => {
    throw new Error("temporary offline");
  };
  const req = Object.assign(
    new Request("https://example.com/api/upload/multipart/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "demo",
        size: 10,
        expires_in: 0,
        config_id: "c",
      }),
    }),
    { user: { id: "u", role: "user", quota_bytes: 100 } },
  );
  assert.equal((await initMultipart(req, { DB: db })).status, 502);
  const orphan = sqlite
    .prepare(
      "SELECT multipart_upload_id,orphan_multipart FROM delete_queue WHERE file_id=? AND processed_at IS NULL",
    )
    .get(fileId);
  assert.equal(orphan.multipart_upload_id, "late-upload-id");
  assert.equal(orphan.orphan_multipart, 1);
  r2.abortMultipartUpload = async (_config, _key, id) =>
    assert.equal(id, "late-upload-id");
  await cleanupDeleteQueue({ DB: db });
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM delete_queue WHERE file_id=? AND processed_at IS NULL",
      )
      .get(fileId).n,
    0,
  );
  sqlite.close();
});
test("multipart init D1 failure persists upload ID before a failed abort compensation", async () => {
  const { db, sqlite } = setup();
  policy.resolveUploadConfigForUser = async () => ({ id: "c", config: {} });
  r2.initiateMultipartUpload = async () => "failed-init-id";
  r2.abortMultipartUpload = async () => {
    throw new Error("offline");
  };
  sqlite.exec(
    `CREATE TRIGGER fail_init BEFORE UPDATE OF upload_status ON files WHEN NEW.upload_status='uploading' BEGIN SELECT RAISE(ABORT,'injected_failure'); END;`,
  );
  const req = Object.assign(
    new Request("https://example.com/api/upload/multipart/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "demo",
        size: 10,
        expires_in: 0,
        config_id: "c",
      }),
    }),
    { user: { id: "u", role: "user", quota_bytes: 100 } },
  );
  assert.equal((await initMultipart(req, { DB: db })).status, 502);
  const row = sqlite
    .prepare("SELECT upload_status,multipart_upload_id FROM files")
    .get();
  assert.equal(row.upload_status, "deleted");
  assert.equal(row.multipart_upload_id, "failed-init-id");
  assert.ok(
    sqlite
      .prepare(
        "SELECT id FROM delete_queue WHERE multipart_upload_id='failed-init-id' AND processed_at IS NULL",
      )
      .get(),
  );
  sqlite.close();
});
test("user deletion retries converge after a middle batch failure without dropping reservations", async () => {
  const { db, sqlite } = setup();
  sqlite.exec(
    "INSERT INTO users(id,username,password_hash,role,status,quota_bytes,created_at,updated_at) VALUES('admin','admin','hash','admin','active',1000,'2026-01-01','2026-01-01')",
  );
  for (let i = 0; i < 60; i++) {
    const id = `item-${String(i).padStart(2, "0")}`;
    file(sqlite, id, "uploading");
    reserve(sqlite, id);
    sqlite
      .prepare("UPDATE files SET multipart_upload_id=? WHERE id=?")
      .run(`mp-${i}`, id);
  }
  const batch = db.batch.bind(db);
  let batches = 0;
  db.batch = async (statements) => {
    if (++batches === 3) throw new Error("middle_batch_failure");
    return batch(statements);
  };
  const req = Object.assign(
    new Request("https://example.com/api/users/u", { method: "DELETE" }),
    { user: { id: "admin", role: "admin" } },
  );
  await assert.rejects(
    () => deleteUser(req, { DB: db }, "u"),
    /middle_batch_failure/,
  );
  assert.equal(
    sqlite.prepare("SELECT status FROM users WHERE id='u'").get().status,
    "deleted",
  );
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM upload_reservations WHERE status='active'",
      )
      .get().n,
    35,
  );
  db.batch = batch;
  assert.equal((await deleteUser(req, { DB: db }, "u")).status, 200);
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM upload_reservations WHERE status='active'",
      )
      .get().n,
    0,
  );
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM delete_queue WHERE processed_at IS NULL AND orphan_multipart=0",
      )
      .get().n,
    60,
  );
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM delete_queue WHERE multipart_upload_id IS NOT NULL",
      )
      .get().n,
    60,
  );
  sqlite.close();
});
