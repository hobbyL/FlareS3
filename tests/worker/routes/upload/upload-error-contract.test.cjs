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

  const quota = require(compiledPath("services/quota.js"));
  const r2 = require(compiledPath("services/r2.js"));
  const storageFactory = require(compiledPath("services/storage/factory.js"));
  const uploadConfigPolicy = require(
    compiledPath("services/uploadConfigPolicy.js"),
  );
  const upload = require(compiledPath("routes/upload/index.js"));

  return { quota, r2, storageFactory, uploadConfigPolicy, upload };
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
    quota_bytes: 1024 * 1024 * 1024,
  };
  return request;
}

function createAuthedServerUploadRequest({
  role = "user",
  configId = "webdav-1",
  contentLength = "512",
} = {}) {
  const form = new FormData();
  form.set("config_id", configId);
  form.set("filename", "demo.txt");
  form.set("expires_in", "7");
  form.set("require_login", "true");
  form.set("file", new File(["hello"], "demo.txt", { type: "text/plain" }));

  const init = {
    method: "POST",
    body: form,
  };
  if (contentLength !== null) {
    init.headers = { "Content-Length": contentLength };
  }

  const request = new Request("https://example.com/api/upload/server", init);
  request.user = {
    id: `${role}-1`,
    username: `${role}-1`,
    role,
    status: "active",
    quota_bytes: 1024 * 1024 * 1024,
  };
  return request;
}

function createDb({
  firstHandlers = [],
  allHandlers = [],
  runHandlers = [],
} = {}) {
  function consume(list, sql, args, kind) {
    const index = list.findIndex((handler) => handler.match.test(sql));
    if (index === -1) {
      throw new Error(
        `unexpected ${kind} SQL: ${sql} / ${JSON.stringify(args)}`,
      );
    }
    const [handler] = list.splice(index, 1);
    return typeof handler.value === "function"
      ? handler.value(args, sql)
      : handler.value;
  }

  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            __sql: sql,
            __args: args,
            async first(columnName) {
              const value = consume(firstHandlers, sql, args, "first");
              if (
                columnName &&
                value &&
                typeof value === "object" &&
                columnName in value
              ) {
                return value[columnName];
              }
              return value;
            },
            async all() {
              return consume(allHandlers, sql, args, "all");
            },
            async run() {
              return consume(runHandlers, sql, args, "run");
            },
          };
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
}

function createDbWithoutDefaultUploadConfig() {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (/SELECT value FROM system_config WHERE key = \?/.test(sql)) {
                return null;
              }
              throw new Error(`unexpected first SQL: ${sql}`);
            },
          };
        },
      };
    },
  };
}

function createDbForUploadLifecycle() {
  const state = {
    reservationInsertCount: 0,
    reservationReleaseCount: 0,
    deletedUpdates: 0,
    fileInsertCount: 0,
  };

  const db = {
    prepare(sql) {
      const directRun = async () => {
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
              if (
                sql.includes(
                  "SELECT quota_bytes FROM r2_configs WHERE id = ? LIMIT 1",
                )
              ) {
                return 1024 * 1024;
              }
              if (
                sql.includes(
                  "SELECT COALESCE(SUM(size), 0) AS completedUsed FROM files WHERE owner_id = ? AND upload_status = 'completed' AND deleted_at IS NULL AND expires_at > ?",
                )
              ) {
                return 0;
              }
              if (
                sql.includes(
                  "SELECT COALESCE(SUM(reserved_bytes), 0) AS reservedUsed FROM upload_reservations WHERE user_id = ? AND status = 'active'",
                )
              ) {
                return 0;
              }
              if (
                sql.includes(
                  "SELECT COALESCE(SUM(size), 0) AS completedUsed",
                ) &&
                sql.includes("config_id = ?")
              ) {
                return 0;
              }
              if (
                sql.includes(
                  "SELECT COALESCE(SUM(reserved_bytes), 0) AS reservedUsed FROM upload_reservations WHERE r2_config_id = ? AND status = 'active'",
                )
              ) {
                return 0;
              }
              if (
                sql.includes("SELECT id FROM files WHERE r2_key = ? LIMIT 1")
              ) {
                return null;
              }
              throw new Error(
                `unexpected first SQL: ${sql} / ${JSON.stringify(args)}`,
              );
            },
            async all() {
              throw new Error(
                `unexpected all SQL: ${sql} / ${JSON.stringify(args)}`,
              );
            },
            async run() {
              if (sql.includes("INSERT INTO upload_reservations")) {
                state.reservationInsertCount += 1;
                return { meta: { changes: 1 } };
              }
              if (sql.includes("INSERT INTO files ")) {
                state.fileInsertCount += 1;
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE files SET upload_status = 'deleted'")) {
                state.deletedUpdates += 1;
                return { meta: { changes: 1 } };
              }
              if (
                sql.includes(
                  "UPDATE files SET upload_status = 'completed', size = ?",
                )
              ) {
                return { meta: { changes: 1 } };
              }
              if (sql.includes("UPDATE upload_reservations SET status = ?")) {
                state.reservationReleaseCount += 1;
                return { meta: { changes: 1 } };
              }
              if (sql.includes("INSERT INTO audit_logs")) {
                return { meta: { changes: 1 } };
              }
              if (
                sql.includes(
                  "UPDATE files SET upload_status = ?, multipart_upload_id = ? WHERE id = ?",
                )
              ) {
                return { meta: { changes: 1 } };
              }
              throw new Error(
                `unexpected run SQL: ${sql} / ${JSON.stringify(args)}`,
              );
            },
          };
        },
        async run() {
          return directRun();
        },
        async all() {
          throw new Error(`unexpected direct all SQL: ${sql}`);
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

test("presignUpload returns structured file-too-large error", async () => {
  const { upload } = loadUploadModules();

  const response = await upload.presignUpload(
    createAuthedRequest("https://example.com/api/upload/presign", {
      filename: "demo.bin",
      size: 11,
      expires_in: 7,
    }),
    {
      DB: createDb(),
      MAX_FILE_SIZE: "10",
    },
  );

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_FILE_TOO_LARGE",
      message: "文件大小超过限制",
      details: {
        declaredSize: 11,
        maxFileSize: 10,
      },
    },
  });
});

test("presignUpload returns structured oversized JSON body error", async () => {
  const { upload } = loadUploadModules();
  const { MAX_JSON_REQUEST_BODY_BYTES } = require(
    compiledPath("services/requestBodyPolicy.js"),
  );

  const request = createAuthedRequest(
    "https://example.com/api/upload/presign",
    {
      filename: "demo.bin",
      size: 10,
      expires_in: 7,
    },
  );
  request.headers.set(
    "Content-Length",
    String(MAX_JSON_REQUEST_BODY_BYTES + 1),
  );

  const response = await upload.presignUpload(request, {
    DB: createDb(),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_REQUEST_BODY_INVALID",
      message: "JSON 请求体大小超过限制",
    },
  });
});

test("presignUpload returns structured config-unavailable error", async () => {
  const { quota, uploadConfigPolicy, upload } = loadUploadModules();

  quota.getUserUsedSpace = async () => 0;
  uploadConfigPolicy.resolveUploadConfigForUser = async () => null;

  const response = await upload.presignUpload(
    createAuthedRequest("https://example.com/api/upload/presign", {
      filename: "demo.bin",
      size: 100,
      expires_in: 7,
    }),
    {
      DB: createDb(),
    },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_CONFIG_UNAVAILABLE",
      message: "R2 未配置",
    },
  });
});

test("serverUpload rejects ordinary users targeting admin-managed WebDAV configs", async () => {
  const { upload } = loadUploadModules();

  const response = await upload.serverUpload(
    createAuthedServerUploadRequest(),
    {
      DB: createDbWithoutDefaultUploadConfig(),
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_CONFIG_FORBIDDEN",
      message: "无权使用指定上传配置",
    },
  });
});

test("serverUpload rejects multipart requests without Content-Length before policy lookup", async () => {
  const { uploadConfigPolicy, upload } = loadUploadModules();
  let policyCalled = false;
  uploadConfigPolicy.resolveServerUploadConfigForUser = async () => {
    policyCalled = true;
    return { type: "webdav" };
  };

  const response = await upload.serverUpload(
    createAuthedServerUploadRequest({ role: "admin", contentLength: null }),
    { DB: createDbWithoutDefaultUploadConfig() },
  );
  const payload = await response.json();

  assert.equal(response.status, 411);
  assert.match(payload.error, /缺少 Content-Length/);
  assert.equal(policyCalled, false);
});

test("serverUpload allows admins targeting WebDAV configs after policy resolution", async () => {
  const { storageFactory, uploadConfigPolicy, upload } = loadUploadModules();
  const { db, state } = createDbForUploadLifecycle();
  let uploaded;

  uploadConfigPolicy.resolveServerUploadConfigForUser = async (
    _env,
    user,
    requestedId,
  ) => {
    assert.equal(user.role, "admin");
    assert.equal(requestedId, "webdav-1");
    return { type: "webdav" };
  };
  storageFactory.createProvider = async (_env, configId) => {
    assert.equal(configId, "webdav-1");
    return {
      async createFolder() {},
      async upload(key, body, contentType, size) {
        uploaded = { key, byteLength: body.byteLength, contentType, size };
      },
    };
  };

  const response = await upload.serverUpload(
    createAuthedServerUploadRequest({ role: "admin", configId: "webdav-1" }),
    { DB: db },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.r2_config_id, "webdav-1");
  assert.equal(payload.filename, "demo.txt");
  assert.equal(payload.short_url.startsWith("/s/"), true);
  assert.equal(payload.short_url.slice("/s/".length).length, 12);
  assert.equal(uploaded.key, "storage/webdav-1/demo.txt");
  assert.equal(uploaded.byteLength, 5);
  assert.equal(uploaded.contentType, "text/plain");
  assert.equal(uploaded.size, 5);
  assert.equal(state.reservationInsertCount, 1);
  assert.equal(state.fileInsertCount, 1);
});

test("presignMultipart returns structured upload_id mismatch error", async () => {
  const { upload } = loadUploadModules();

  const response = await upload.presignMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/presign", {
      file_id: "file-1",
      upload_id: "upload-2",
      part_number: 1,
    }),
    {
      DB: createDb({
        firstHandlers: [
          {
            match:
              /SELECT id, owner_id, r2_key, expires_at, upload_status, multipart_upload_id, size FROM files WHERE id = \?/,
            value: {
              id: "file-1",
              owner_id: "user-1",
              r2_key: "flares3/config/demo.bin",
              expires_at: "9999-12-31T23:59:59.999Z",
              upload_status: "uploading",
              multipart_upload_id: "upload-1",
              size: 128,
            },
          },
        ],
      }),
    },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_MULTIPART_UPLOAD_ID_MISMATCH",
      message: "upload_id 不匹配",
    },
  });
});

test("presignMultipart rejects part numbers beyond declared file size", async () => {
  const { r2, upload } = loadUploadModules();
  r2.resolveR2ConfigForKey = async () => {
    throw new Error(
      "invalid part_number should fail before resolving storage config",
    );
  };

  const response = await upload.presignMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/presign", {
      file_id: "file-1",
      upload_id: "upload-1",
      part_number: 2,
    }),
    {
      DB: createDb({
        firstHandlers: [
          {
            match:
              /SELECT id, owner_id, r2_key, expires_at, upload_status, multipart_upload_id, size FROM files WHERE id = \?/,
            value: {
              id: "file-1",
              owner_id: "user-1",
              r2_key: "flares3/config/demo.bin",
              expires_at: "9999-12-31T23:59:59.999Z",
              upload_status: "uploading",
              multipart_upload_id: "upload-1",
              size: 128,
            },
          },
        ],
      }),
    },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_MULTIPART_PART_NUMBER_INVALID",
      message: "part_number 无效",
    },
  });
});

test("completeMultipart maps upstream storage errors into structured upload contract", async () => {
  const { r2, upload } = loadUploadModules();
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.completeMultipartUpload = async () => {
    const error = new Error("The specified upload does not exist");
    error.name = "NoSuchUpload";
    error.$metadata = { httpStatusCode: 404 };
    throw error;
  };

  const response = await upload.completeMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/complete", {
      file_id: "file-1",
      upload_id: "upload-1",
      parts: [{ part_number: 1, etag: "etag-1" }],
    }),
    {
      DB: createDb({
        firstHandlers: [
          {
            match:
              /SELECT id, owner_id, filename, r2_key, expires_at, short_code, require_login, upload_status, multipart_upload_id, size FROM files WHERE id = \?/,
            value: {
              id: "file-1",
              owner_id: "user-1",
              filename: "demo.bin",
              r2_key: "flares3/config/demo.bin",
              expires_at: "9999-12-31T23:59:59.999Z",
              short_code: "abc123",
              require_login: 1,
              upload_status: "uploading",
              multipart_upload_id: "upload-1",
              size: 100,
            },
          },
        ],
      }),
    },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_MULTIPART_SESSION_MISSING",
      message: "分片上传会话不存在或已失效，请重新上传",
    },
  });
});

test("presignUpload releases reservation when upload URL generation fails", async () => {
  const { r2, uploadConfigPolicy, upload } = loadUploadModules();
  const { db, state } = createDbForUploadLifecycle();

  uploadConfigPolicy.resolveUploadConfigForUser = async () => ({
    id: "config-1",
    config: { endpoint: "https://example.com", bucketName: "bucket" },
  });
  r2.generateUploadUrl = async () => {
    const error = new Error("upstream down");
    error.name = "UpstreamError";
    throw error;
  };

  const response = await upload.presignUpload(
    createAuthedRequest("https://example.com/api/upload/presign", {
      filename: "demo.bin",
      size: 100,
      expires_in: 7,
      config_id: "config-1",
    }),
    { DB: db },
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_STORAGE_REQUEST_FAILED",
      message: "upstream down",
      details: {
        upstreamCode: "UpstreamError",
      },
    },
  });
  assert.equal(state.reservationInsertCount, 1);
  assert.equal(state.fileInsertCount, 1);
  assert.equal(state.deletedUpdates, 1);
  assert.equal(state.reservationReleaseCount, 1);
});

test("initMultipart releases reservation when multipart initialization fails", async () => {
  const { r2, uploadConfigPolicy, upload } = loadUploadModules();
  const { db, state } = createDbForUploadLifecycle();

  uploadConfigPolicy.resolveUploadConfigForUser = async () => ({
    id: "config-1",
    config: { endpoint: "https://example.com", bucketName: "bucket" },
  });
  r2.initiateMultipartUpload = async () => {
    const error = new Error("upstream down");
    error.name = "UpstreamError";
    throw error;
  };

  const response = await upload.initMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/init", {
      filename: "demo.bin",
      size: 100,
      expires_in: 7,
      config_id: "config-1",
    }),
    { DB: db },
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_STORAGE_REQUEST_FAILED",
      message: "upstream down",
      details: {
        upstreamCode: "UpstreamError",
      },
    },
  });
  assert.equal(state.reservationInsertCount, 1);
  assert.equal(state.fileInsertCount, 1);
  assert.equal(state.deletedUpdates, 1);
  assert.equal(state.reservationReleaseCount, 1);
});
