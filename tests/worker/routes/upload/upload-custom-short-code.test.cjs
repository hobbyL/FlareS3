const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

function clearCompiledModule(relativePath) {
  delete require.cache[compiledPath(relativePath)];
}

function loadUploadModules() {
  clearCompiledModule("routes/upload/index.js");
  clearCompiledModule("routes/upload/presign.js");
  clearCompiledModule("routes/upload/multipart.js");
  clearCompiledModule("routes/upload/server.js");
  clearCompiledModule("routes/upload/helpers.js");
  clearCompiledModule("services/quota.js");
  clearCompiledModule("services/r2.js");
  clearCompiledModule("services/storage/factory.js");
  clearCompiledModule("services/uploadConfigPolicy.js");
  clearCompiledModule("services/uploadErrors.js");

  const helpers = require(compiledPath("routes/upload/helpers.js"));
  const r2 = require(compiledPath("services/r2.js"));
  const uploadConfigPolicy = require(
    compiledPath("services/uploadConfigPolicy.js"),
  );
  const storageFactory = require(compiledPath("services/storage/factory.js"));
  const upload = require(compiledPath("routes/upload/index.js"));

  return { helpers, r2, uploadConfigPolicy, storageFactory, upload };
}

function createAuthedRequest(url, body) {
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  request.user = {
    id: "user-1",
    username: "user-1",
    role: "user",
    status: "active",
    quota_bytes: 1024 * 1024 * 1024,
  };
  return request;
}

/**
 * Lifecycle DB mock with configurable short-code occupancy and INSERT capture.
 * `shortCodeTaken` controls the three-table UNION probe used by isShortCodeTaken.
 */
function createPresignDb({ shortCodeTaken = false } = {}) {
  const state = {
    insertedShortCodes: [],
    fileInsertCount: 0,
    unionProbeArgs: null,
  };

  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            __sql: sql,
            __args: args,
            async first(columnName) {
              if (
                /SELECT 1 AS taken FROM files WHERE short_code = \?/.test(sql)
              ) {
                state.unionProbeArgs = args;
                return shortCodeTaken ? { taken: 1 } : null;
              }
              if (
                sql.includes(
                  "SELECT quota_bytes FROM r2_configs WHERE id = ? LIMIT 1",
                )
              ) {
                return columnName ? 1024 * 1024 : { quota_bytes: 1024 * 1024 };
              }
              if (
                sql.includes("SELECT COALESCE(SUM(size), 0) AS completedUsed")
              ) {
                return columnName ? 0 : { completedUsed: 0 };
              }
              if (
                sql.includes(
                  "SELECT COALESCE(SUM(reserved_bytes), 0) AS reservedUsed",
                )
              ) {
                return columnName ? 0 : { reservedUsed: 0 };
              }
              if (
                sql.includes("SELECT id FROM files WHERE r2_key = ? LIMIT 1")
              ) {
                return null;
              }
              throw new Error(`unexpected first SQL: ${sql}`);
            },
            async run() {
              if (sql.includes("INSERT INTO upload_reservations")) {
                return { meta: { changes: 1 } };
              }
              if (sql.includes("INSERT INTO files ")) {
                state.fileInsertCount += 1;
                // short_code is the 10th positional bind (0-indexed 9)
                state.insertedShortCodes.push(args[9]);
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE files SET upload_status = 'deleted'")) {
                return { meta: { changes: 1 } };
              }
              // multipart init: 落库后写入 multipart_upload_id 并置 uploading
              if (
                sql.includes("UPDATE files SET upload_status = ?") &&
                sql.includes("multipart_upload_id = ?")
              ) {
                return { meta: { changes: 1 } };
              }
              // server 代理上传收口：pending -> completed（状态守卫命中 1 行）
              if (
                sql.includes("UPDATE files SET upload_status = 'completed'")
              ) {
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE upload_reservations SET status = ?")) {
                return { meta: { changes: 1 } };
              }
              if (sql.includes("INSERT INTO audit_logs")) {
                return { meta: { changes: 1 } };
              }
              throw new Error(`unexpected run SQL: ${sql}`);
            },
          };
        },
        async run() {
          return { meta: { changes: 0 } };
        },
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

function stubPresignSuccess(r2, uploadConfigPolicy) {
  uploadConfigPolicy.resolveUploadConfigForUser = async () => ({
    id: "config-1",
    config: { endpoint: "https://example.com", bucketName: "bucket" },
  });
  r2.generateUploadUrl = async () => "https://example.com/upload";
}

test("normalizeCustomShortCode treats blank/absent input as random fallback", () => {
  const { helpers } = loadUploadModules();
  for (const value of [undefined, null, "", "   "]) {
    assert.deepEqual(helpers.normalizeCustomShortCode(value), {
      kind: "absent",
    });
  }
});

test("normalizeCustomShortCode rejects out-of-range length and illegal chars", () => {
  const { helpers } = loadUploadModules();

  assert.equal(helpers.normalizeCustomShortCode("abc").kind, "invalid"); // too short
  assert.equal(
    helpers.normalizeCustomShortCode("a".repeat(33)).kind,
    "invalid",
  ); // too long
  assert.equal(helpers.normalizeCustomShortCode("bad code").kind, "invalid"); // space
  assert.equal(helpers.normalizeCustomShortCode("bad/code").kind, "invalid"); // slash
  assert.equal(helpers.normalizeCustomShortCode("中文短码").kind, "invalid"); // non-ascii
});

test("normalizeCustomShortCode accepts allowed charset and trims", () => {
  const { helpers } = loadUploadModules();

  assert.deepEqual(helpers.normalizeCustomShortCode("My_Code-1"), {
    kind: "ok",
    code: "My_Code-1",
  });
  assert.deepEqual(helpers.normalizeCustomShortCode("  vanity42  "), {
    kind: "ok",
    code: "vanity42",
  });
});

test("isShortCodeTaken probes files + text_shares + text_one_time_shares with the code bound thrice", async () => {
  const { helpers } = loadUploadModules();
  const { db, state } = createPresignDb({ shortCodeTaken: false });

  const taken = await helpers.isShortCodeTaken({ DB: db }, "vanity42");

  assert.equal(taken, false);
  assert.ok(state.unionProbeArgs, "union probe should run");
  assert.deepEqual(state.unionProbeArgs, ["vanity42", "vanity42", "vanity42"]);

  const { db: db2 } = createPresignDb({ shortCodeTaken: true });
  assert.equal(await helpers.isShortCodeTaken({ DB: db2 }, "vanity42"), true);
});

test("presignUpload rejects illegal custom short codes with 400 before touching storage", async () => {
  const { r2, upload } = loadUploadModules();
  r2.generateUploadUrl = async () => {
    throw new Error("must not reach storage for an invalid custom code");
  };
  const { db, state } = createPresignDb();

  const response = await upload.presignUpload(
    createAuthedRequest("https://example.com/api/upload/presign", {
      filename: "demo.bin",
      size: 100,
      expires_in: 7,
      config_id: "config-1",
      custom_short_code: "no",
    }),
    { DB: db },
  );

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.code, "UPLOAD_CUSTOM_SHORT_CODE_INVALID");
  assert.equal(state.fileInsertCount, 0);
});

test("presignUpload rejects an already-taken custom short code with 409 and no insert", async () => {
  const { r2, uploadConfigPolicy, upload } = loadUploadModules();
  stubPresignSuccess(r2, uploadConfigPolicy);
  const { db, state } = createPresignDb({ shortCodeTaken: true });

  const response = await upload.presignUpload(
    createAuthedRequest("https://example.com/api/upload/presign", {
      filename: "demo.bin",
      size: 100,
      expires_in: 7,
      config_id: "config-1",
      custom_short_code: "vanity42",
    }),
    { DB: db },
  );

  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.error.code, "UPLOAD_CUSTOM_SHORT_CODE_CONFLICT");
  assert.equal(state.fileInsertCount, 0);
});

test("presignUpload persists a free custom short code and surfaces it as the short link", async () => {
  const { r2, uploadConfigPolicy, upload } = loadUploadModules();
  stubPresignSuccess(r2, uploadConfigPolicy);
  const { db, state } = createPresignDb({ shortCodeTaken: false });

  const response = await upload.presignUpload(
    createAuthedRequest("https://example.com/api/upload/presign", {
      filename: "demo.bin",
      size: 100,
      expires_in: 7,
      config_id: "config-1",
      custom_short_code: "vanity42",
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.short_url, "/s/vanity42");
  assert.deepEqual(state.insertedShortCodes, ["vanity42"]);
});

test("presignUpload keeps random short-code behaviour unchanged when none is provided", async () => {
  const { r2, uploadConfigPolicy, upload } = loadUploadModules();
  stubPresignSuccess(r2, uploadConfigPolicy);
  const { db, state } = createPresignDb({ shortCodeTaken: false });

  const response = await upload.presignUpload(
    createAuthedRequest("https://example.com/api/upload/presign", {
      filename: "demo.bin",
      size: 100,
      expires_in: 7,
      config_id: "config-1",
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.short_url.startsWith("/s/"), true);
  // random file short codes are fixed-length (12) and never equal the vanity path
  assert.equal(payload.short_url.slice("/s/".length).length, 12);
  assert.equal(state.insertedShortCodes.length, 1);
  assert.equal(state.insertedShortCodes[0].length, 12);
  // no custom code → the three-table probe must be skipped entirely
  assert.equal(state.unionProbeArgs, null);
});

// ---------------------------------------------------------------------------
// multipart init 路径：自定义短码的校验 / 跨三表占用 / 落库与 presign 完全一致。
// multipart init 响应体不含 short_url，故以 state.insertedShortCodes 断言落库短码。
// ---------------------------------------------------------------------------

function stubMultipartSuccess(r2, uploadConfigPolicy) {
  uploadConfigPolicy.resolveUploadConfigForUser = async () => ({
    id: "config-1",
    config: { endpoint: "https://example.com", bucketName: "bucket" },
  });
  r2.initiateMultipartUpload = async () => "upload-id-123";
}

test("initMultipart rejects illegal custom short codes with 400 before touching storage", async () => {
  const { r2, upload } = loadUploadModules();
  r2.initiateMultipartUpload = async () => {
    throw new Error("must not reach storage for an invalid custom code");
  };
  const { db, state } = createPresignDb();

  const response = await upload.initMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/init", {
      filename: "demo.bin",
      size: 100,
      expires_in: 7,
      config_id: "config-1",
      custom_short_code: "no",
    }),
    { DB: db },
  );

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.code, "UPLOAD_CUSTOM_SHORT_CODE_INVALID");
  assert.equal(state.fileInsertCount, 0);
});

test("initMultipart rejects an already-taken custom short code with 409 and no insert", async () => {
  const { r2, uploadConfigPolicy, upload } = loadUploadModules();
  stubMultipartSuccess(r2, uploadConfigPolicy);
  const { db, state } = createPresignDb({ shortCodeTaken: true });

  const response = await upload.initMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/init", {
      filename: "demo.bin",
      size: 100,
      expires_in: 7,
      config_id: "config-1",
      custom_short_code: "vanity42",
    }),
    { DB: db },
  );

  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.error.code, "UPLOAD_CUSTOM_SHORT_CODE_CONFLICT");
  assert.equal(state.fileInsertCount, 0);
});

test("initMultipart persists a free custom short code into the files row", async () => {
  const { r2, uploadConfigPolicy, upload } = loadUploadModules();
  stubMultipartSuccess(r2, uploadConfigPolicy);
  const { db, state } = createPresignDb({ shortCodeTaken: false });

  const response = await upload.initMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/init", {
      filename: "demo.bin",
      size: 100,
      expires_in: 7,
      config_id: "config-1",
      custom_short_code: "vanity42",
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.upload_id, "upload-id-123");
  assert.deepEqual(state.insertedShortCodes, ["vanity42"]);
});
test("initMultipart keeps random short-code behaviour unchanged when none is provided", async () => {
  const { r2, uploadConfigPolicy, upload } = loadUploadModules();
  stubMultipartSuccess(r2, uploadConfigPolicy);
  const { db, state } = createPresignDb({ shortCodeTaken: false });

  const response = await upload.initMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/init", {
      filename: "demo.bin",
      size: 100,
      expires_in: 7,
      config_id: "config-1",
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  assert.equal(state.insertedShortCodes.length, 1);
  assert.equal(state.insertedShortCodes[0].length, 12);
  // 无自定义码 → 三表占用预检必须整体跳过
  assert.equal(state.unionProbeArgs, null);
});

// ---------------------------------------------------------------------------
// server 代理上传路径：以手工构造的 multipart/form-data（含显式 Content-Length）
// 驱动 request.formData()，验证自定义短码 400 / 409 / 落库 / 随机回退与其余两路一致。
// ---------------------------------------------------------------------------

function stubServerSuccess(uploadConfigPolicy, storageFactory) {
  // 非 R2 配置才允许服务端中转；createProvider 返回最小 provider 桩
  uploadConfigPolicy.resolveServerUploadConfigForUser = async () => ({
    type: "webdav",
  });
  storageFactory.createProvider = async () => ({
    async createFolder() {},
    async upload() {},
    async delete() {},
  });
}

function createServerUploadRequest(url, fields, file) {
  const boundary = "----flares3customcode";
  const segments = [];
  for (const [name, value] of Object.entries(fields)) {
    segments.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  }
  segments.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n${file.content}\r\n`,
  );
  segments.push(`--${boundary}--\r\n`);
  const bodyBytes = Buffer.from(segments.join(""), "utf8");
  const request = new Request(url, {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(bodyBytes.length),
    },
    body: bodyBytes,
  });
  request.user = {
    id: "user-1",
    username: "user-1",
    role: "user",
    status: "active",
    quota_bytes: 1024 * 1024 * 1024,
  };
  return request;
}

const SERVER_FILE = {
  filename: "demo.bin",
  contentType: "application/octet-stream",
  content: "server-bytes",
};
test("serverUpload rejects illegal custom short codes with 400 before touching storage", async () => {
  const { uploadConfigPolicy, storageFactory, upload } = loadUploadModules();
  uploadConfigPolicy.resolveServerUploadConfigForUser = async () => {
    throw new Error("must not resolve config for an invalid custom code");
  };
  storageFactory.createProvider = async () => {
    throw new Error("must not reach storage for an invalid custom code");
  };
  const { db, state } = createPresignDb();

  const response = await upload.serverUpload(
    createServerUploadRequest(
      "https://example.com/api/upload/server",
      {
        config_id: "config-1",
        filename: "demo.bin",
        expires_in: "7",
        custom_short_code: "no",
      },
      SERVER_FILE,
    ),
    { DB: db },
  );

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.code, "UPLOAD_CUSTOM_SHORT_CODE_INVALID");
  assert.equal(state.fileInsertCount, 0);
});

test("serverUpload rejects an already-taken custom short code with 409 and no insert", async () => {
  const { uploadConfigPolicy, storageFactory, upload } = loadUploadModules();
  stubServerSuccess(uploadConfigPolicy, storageFactory);
  const { db, state } = createPresignDb({ shortCodeTaken: true });

  const response = await upload.serverUpload(
    createServerUploadRequest(
      "https://example.com/api/upload/server",
      {
        config_id: "config-1",
        filename: "demo.bin",
        expires_in: "7",
        custom_short_code: "vanity42",
      },
      SERVER_FILE,
    ),
    { DB: db },
  );

  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.error.code, "UPLOAD_CUSTOM_SHORT_CODE_CONFLICT");
  assert.equal(state.fileInsertCount, 0);
});
test("serverUpload persists a free custom short code and surfaces it as the short link", async () => {
  const { uploadConfigPolicy, storageFactory, upload } = loadUploadModules();
  stubServerSuccess(uploadConfigPolicy, storageFactory);
  const { db, state } = createPresignDb({ shortCodeTaken: false });

  const response = await upload.serverUpload(
    createServerUploadRequest(
      "https://example.com/api/upload/server",
      {
        config_id: "config-1",
        filename: "demo.bin",
        expires_in: "7",
        custom_short_code: "vanity42",
      },
      SERVER_FILE,
    ),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.short_url, "/s/vanity42");
  assert.deepEqual(state.insertedShortCodes, ["vanity42"]);
});

test("serverUpload keeps random short-code behaviour unchanged when none is provided", async () => {
  const { uploadConfigPolicy, storageFactory, upload } = loadUploadModules();
  stubServerSuccess(uploadConfigPolicy, storageFactory);
  const { db, state } = createPresignDb({ shortCodeTaken: false });

  const response = await upload.serverUpload(
    createServerUploadRequest(
      "https://example.com/api/upload/server",
      {
        config_id: "config-1",
        filename: "demo.bin",
        expires_in: "7",
      },
      SERVER_FILE,
    ),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.short_url.startsWith("/s/"), true);
  assert.equal(payload.short_url.slice("/s/".length).length, 12);
  assert.equal(state.insertedShortCodes.length, 1);
  assert.equal(state.insertedShortCodes[0].length, 12);
  // 无自定义码 → 三表占用预检必须整体跳过
  assert.equal(state.unionProbeArgs, null);
});
