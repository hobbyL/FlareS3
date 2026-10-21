const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createSqliteDb } = require("../../helpers/sqlite-db.cjs");
const root =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");
const r2 = require(path.join(root, "services/r2.js"));
const { confirmUpload } = require(path.join(root, "routes/upload/presign.js"));

function setup() {
  const { db, sqlite } = createSqliteDb();
  sqlite.exec(`
    INSERT INTO users(id,username,password_hash,role,status,quota_bytes,created_at,updated_at)
    VALUES('u','alice','hash','user','active',1000,'2026-01-01','2026-01-01');
    INSERT INTO files(id,owner_id,filename,r2_key,size,content_type,expires_in,created_at,expires_at,upload_status,upload_key)
    VALUES('f','u','demo','flares3/c/demo',10,'text/plain',0,'2026-01-01','9999-01-01','pending','flares3/c/.uploads/f');
  `);
  r2.resolveR2ConfigForKey = async () => ({ id: "c", config: {} });
  function run() {
    const request = Object.assign(
      new Request("https://example.com/api/upload/confirm", {
        method: "POST",
        body: JSON.stringify({ file_id: "f" }),
      }),
      { user: { id: "u", role: "user" } },
    );
    return confirmUpload(request, { DB: db });
  }
  return { db, sqlite, run };
}
function preconditionError() {
  return Object.assign(new Error("changed"), {
    $metadata: { httpStatusCode: 412 },
  });
}

test("source changes after HEAD cannot publish or complete the file", async () => {
  const { sqlite, run } = setup();
  r2.getObjectMetadata = async (_config, key) =>
    key.includes(".uploads") ? { size: 10, etag: '"old"' } : null;
  r2.copyObject = async (_config, source, dest, options) => {
    assert.equal(source, "flares3/c/.uploads/f");
    assert.equal(dest, "flares3/c/demo");
    assert.deepEqual(options, { sourceEtag: '"old"', createOnly: true });
    throw preconditionError();
  };
  assert.equal((await run()).status, 409);
  assert.equal(
    sqlite.prepare("SELECT upload_status FROM files WHERE id='f'").get()
      .upload_status,
    "pending",
  );
  sqlite.close();
});

test("retry cannot switch the source version after a publication attempt", async () => {
  const { sqlite, run } = setup();
  sqlite.exec(`UPDATE files SET upload_etag='"old"' WHERE id='f'`);
  r2.getObjectMetadata = async () => ({ size: 10, etag: '"new"' });
  let copies = 0;
  r2.copyObject = async () => {
    copies += 1;
  };
  assert.equal((await run()).status, 409);
  assert.equal(copies, 0);
  sqlite.close();
});

test("published object survives repeated confirmation and reusing the temporary PUT", async () => {
  const { sqlite, run } = setup();
  let version = '"v1"';
  let copies = 0;
  r2.getObjectMetadata = async () => ({ size: 10, etag: version });
  r2.copyObject = async () => {
    copies += 1;
  };
  assert.equal((await run()).status, 200);
  version = '"v2"';
  assert.equal((await run()).status, 409);
  assert.equal(copies, 1);
  assert.equal(
    sqlite.prepare("SELECT upload_etag FROM files WHERE id='f'").get()
      .upload_etag,
    '"v1"',
  );
  sqlite.close();
});

test("COPY already committed with the bound version can retry D1 completion", async () => {
  const { sqlite, run } = setup();
  sqlite.exec(`UPDATE files SET upload_etag='"v1"' WHERE id='f'`);
  r2.getObjectMetadata = async () => ({ size: 10, etag: '"v1"' });
  r2.copyObject = async () => {
    throw preconditionError();
  };
  assert.equal((await run()).status, 200);
  sqlite.close();
});
