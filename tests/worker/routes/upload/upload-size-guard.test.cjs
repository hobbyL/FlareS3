const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || "/tmp/flares3-worker-tests";

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

function tryRequire(relativePath) {
  try {
    return require(compiledPath(relativePath));
  } catch {
    return {};
  }
}

function clearCompiledModule(relativePath) {
  const target = compiledPath(relativePath);
  delete require.cache[target];
}

function createAuthedRequest(url, body) {
  const request = new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  request.user = {
    id: "user-1",
    username: "user-1",
    role: "user",
    status: "active",
    quota_bytes: 1024,
  };
  return request;
}

function createDb(fileRow) {
  const state = {
    completedUpdates: 0,
    deletedUpdates: 0,
    completedUpdateArgs: [],
    reservationUpdates: 0,
    reservationUpdateArgs: [],
    auditEntries: [],
  };

  const db = {
    prepare(sql) {
      const runDirect = async () => {
        if (/^(CREATE|ALTER TABLE)/.test(sql.trim())) {
          return { meta: { changes: 0 } };
        }
        throw new Error(`unexpected direct run SQL: ${sql}`);
      };
      return {
        bind(...args) {
          return {
            __sql: sql,
            __args: args,
            async first() {
              if (sql.includes("FROM files WHERE id = ?")) {
                return fileRow;
              }
              throw new Error(
                `unexpected first SQL: ${sql} / ${JSON.stringify(args)}`,
              );
            },
            async all() {
              if (sql.includes("PRAGMA table_info(files)")) {
                return {
                  results: [{ name: "multipart_upload_id" }],
                };
              }
              throw new Error(
                `unexpected all SQL: ${sql} / ${JSON.stringify(args)}`,
              );
            },
            async run() {
              if (sql.includes("SET upload_status = 'deleted'")) {
                state.deletedUpdates += 1;
                return { meta: { changes: 1 } };
              }
              if (sql.includes("INSERT INTO audit_logs")) {
                state.auditEntries.push(args);
                return { meta: { changes: 1 } };
              }
              if (
                sql.includes("UPDATE files SET size = ?, upload_status = ?")
              ) {
                state.completedUpdates += 1;
                state.completedUpdateArgs.push(args);
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE files SET upload_status = ?")) {
                state.completedUpdates += 1;
                state.completedUpdateArgs.push(args);
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE upload_reservations SET status = ?")) {
                state.reservationUpdates += 1;
                state.reservationUpdateArgs.push(args);
                return { meta: { changes: 1 } };
              }
              throw new Error(
                `unexpected run SQL: ${sql} / ${JSON.stringify(args)}`,
              );
            },
          };
        },
        async all() {
          if (sql.includes("PRAGMA table_info(files)")) {
            return {
              results: [{ name: "multipart_upload_id" }],
            };
          }
          throw new Error(`unexpected direct all SQL: ${sql}`);
        },
        run: runDirect,
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
  };

  return { db, state };
}

function loadUploadModules() {
  clearCompiledModule("routes/upload/index.js");
  clearCompiledModule("routes/upload/presign.js");
  clearCompiledModule("routes/upload/multipart.js");
  clearCompiledModule("routes/upload/helpers.js");
  clearCompiledModule("services/r2.js");
  clearCompiledModule("services/dbSchema.js");

  const r2 = require(compiledPath("services/r2.js"));
  const upload = require(compiledPath("routes/upload/index.js"));
  return { r2, upload };
}

test("normalizeDeclaredFileSize rejects non-positive or non-integer values", () => {
  const validation = tryRequire("services/uploadValidation.js");

  assert.equal(typeof validation.normalizeDeclaredFileSize, "function");
  assert.equal(validation.normalizeDeclaredFileSize(1), 1);
  assert.equal(validation.normalizeDeclaredFileSize("20"), 20);
  assert.equal(validation.normalizeDeclaredFileSize(0), null);
  assert.equal(validation.normalizeDeclaredFileSize(-1), null);
  assert.equal(validation.normalizeDeclaredFileSize(1.5), null);
  assert.equal(validation.normalizeDeclaredFileSize("abc"), null);
});

test("multipart part validation rejects fractional and out-of-range parts", () => {
  const validation = tryRequire("services/uploadValidation.js");

  assert.equal(validation.MAX_S3_MULTIPART_PARTS, 10000);
  assert.equal(
    validation.calculateMultipartTotalParts(21 * 1024 * 1024, 20 * 1024 * 1024),
    2,
  );
  assert.equal(
    validation.calculateMultipartTotalParts(0, 20 * 1024 * 1024),
    null,
  );
  assert.equal(validation.normalizeMultipartPartNumber(1, 2), 1);
  assert.equal(validation.normalizeMultipartPartNumber("2", 2), 2);
  assert.equal(validation.normalizeMultipartPartNumber(1.5, 2), null);
  assert.equal(validation.normalizeMultipartPartNumber(0, 2), null);
  assert.equal(validation.normalizeMultipartPartNumber(3, 2), null);
  assert.equal(validation.normalizeMultipartPartNumber(10001, 10001), null);
});

test("validateUploadedObjectSize detects mismatched object size", () => {
  const validation = tryRequire("services/uploadValidation.js");

  assert.equal(typeof validation.validateUploadedObjectSize, "function");
  assert.deepEqual(validation.validateUploadedObjectSize(128, 128), {
    ok: true,
  });
  assert.deepEqual(validation.validateUploadedObjectSize(128, 256), {
    ok: false,
    reason: "SIZE_MISMATCH",
  });
  assert.deepEqual(validation.validateUploadedObjectSize(128, -1), {
    ok: false,
    reason: "INVALID_ACTUAL_SIZE",
  });
});

test("confirmUpload rejects mismatched uploaded object size", async () => {
  const fileRow = {
    id: "file-1",
    owner_id: "user-1",
    filename: "demo.bin",
    r2_key: "flares3/config/demo.bin",
    expires_at: "9999-12-31T23:59:59.999Z",
    short_code: "abc123",
    require_login: 1,
    size: 128,
  };
  const { db, state } = createDb(fileRow);
  const { r2, upload } = loadUploadModules();

  let deleteCalls = 0;
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.getObjectSize = async () => 256;
  r2.deleteObject = async () => {
    deleteCalls += 1;
  };

  const response = await upload.confirmUpload(
    createAuthedRequest("https://example.com/api/upload/confirm", {
      file_id: "file-1",
    }),
    { DB: db },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_OBJECT_SIZE_MISMATCH",
      message: "上传对象大小与声明大小不一致",
    },
  });
  assert.equal(state.completedUpdates, 0);
  assert.equal(state.deletedUpdates, 1);
  assert.equal(state.reservationUpdates, 1);
  assert.equal(deleteCalls, 1);
  assert.equal(state.auditEntries.length, 1);
  assert.equal(state.auditEntries[0][2], "UPLOAD_SIZE_MISMATCH");
});

test("completeMultipart rejects mismatched uploaded object size", async () => {
  const fileRow = {
    id: "file-1",
    owner_id: "user-1",
    filename: "demo.bin",
    r2_key: "flares3/config/demo.bin",
    expires_at: "9999-12-31T23:59:59.999Z",
    short_code: "abc123",
    require_login: 1,
    upload_status: "uploading",
    multipart_upload_id: "upload-1",
    size: 128,
  };
  const { db, state } = createDb(fileRow);
  const { r2, upload } = loadUploadModules();

  let deleteCalls = 0;
  let completeCalls = 0;
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.completeMultipartUpload = async () => {
    completeCalls += 1;
  };
  r2.getObjectSize = async () => 256;
  r2.deleteObject = async () => {
    deleteCalls += 1;
  };

  const response = await upload.completeMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/complete", {
      file_id: "file-1",
      upload_id: "upload-1",
      parts: [{ part_number: 1, etag: "etag-1" }],
    }),
    { DB: db },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_OBJECT_SIZE_MISMATCH",
      message: "上传对象大小与声明大小不一致",
    },
  });
  assert.equal(completeCalls, 1);
  assert.equal(state.completedUpdates, 0);
  assert.equal(state.deletedUpdates, 1);
  assert.equal(state.reservationUpdates, 1);
  assert.equal(deleteCalls, 1);
  assert.equal(state.auditEntries.length, 1);
  assert.equal(state.auditEntries[0][2], "UPLOAD_SIZE_MISMATCH");
});

test("completeMultipart rejects invalid client part lists before completing upstream upload", async () => {
  const fileRow = {
    id: "file-1",
    owner_id: "user-1",
    filename: "demo.bin",
    r2_key: "flares3/config/demo.bin",
    expires_at: "9999-12-31T23:59:59.999Z",
    short_code: "abc123",
    require_login: 1,
    upload_status: "uploading",
    multipart_upload_id: "upload-1",
    size: 128,
  };
  const { db, state } = createDb(fileRow);
  const { r2, upload } = loadUploadModules();

  let completeCalls = 0;
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.completeMultipartUpload = async () => {
    completeCalls += 1;
  };

  const response = await upload.completeMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/complete", {
      file_id: "file-1",
      upload_id: "upload-1",
      parts: [{ part_number: 1.5, etag: "etag-1" }],
    }),
    { DB: db },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_MULTIPART_PART_NUMBER_INVALID",
      message: "part_number 无效",
    },
  });
  assert.equal(completeCalls, 0);
  assert.equal(state.completedUpdates, 0);
  assert.equal(state.deletedUpdates, 0);
  assert.equal(state.reservationUpdates, 0);
});

test("confirmUpload persists actual object size on success", async () => {
  const fileRow = {
    id: "file-1",
    owner_id: "user-1",
    filename: "demo.bin",
    r2_key: "flares3/config/demo.bin",
    expires_at: "9999-12-31T23:59:59.999Z",
    short_code: "abc123",
    require_login: 1,
    size: 128,
  };
  const { db, state } = createDb(fileRow);
  const { r2, upload } = loadUploadModules();

  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.getObjectSize = async () => 128;

  const response = await upload.confirmUpload(
    createAuthedRequest("https://example.com/api/upload/confirm", {
      file_id: "file-1",
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  assert.equal(state.deletedUpdates, 0);
  assert.equal(state.completedUpdates, 1);
  assert.equal(state.reservationUpdates, 1);
  assert.deepEqual(state.completedUpdateArgs[0], [128, "completed", "file-1"]);
});

test("completeMultipart persists actual object size on success", async () => {
  const fileRow = {
    id: "file-1",
    owner_id: "user-1",
    filename: "demo.bin",
    r2_key: "flares3/config/demo.bin",
    expires_at: "9999-12-31T23:59:59.999Z",
    short_code: "abc123",
    require_login: 1,
    upload_status: "uploading",
    multipart_upload_id: "upload-1",
    size: 128,
  };
  const { db, state } = createDb(fileRow);
  const { r2, upload } = loadUploadModules();

  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.completeMultipartUpload = async () => {};
  r2.getObjectSize = async () => 128;

  const response = await upload.completeMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/complete", {
      file_id: "file-1",
      upload_id: "upload-1",
      parts: [{ part_number: 1, etag: "etag-1" }],
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  assert.equal(state.deletedUpdates, 0);
  assert.equal(state.completedUpdates, 1);
  assert.equal(state.reservationUpdates, 1);
  assert.deepEqual(state.completedUpdateArgs[0], [128, "completed", "file-1"]);
});
