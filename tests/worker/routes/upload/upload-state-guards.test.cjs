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
  clearCompiledModule("routes/upload/helpers.js");
  clearCompiledModule("services/r2.js");
  clearCompiledModule("services/uploadErrors.js");

  const r2 = require(compiledPath("services/r2.js"));
  const upload = require(compiledPath("routes/upload/index.js"));
  return { r2, upload };
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

function createDb({ firstHandlers = [], runHandlers = [] } = {}) {
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
            async first() {
              return consume(firstHandlers, sql, args, "first");
            },
            async all() {
              throw new Error(`unexpected all SQL: ${sql}`);
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

const CONFIRM_FILE_SELECT =
  /SELECT id, owner_id, filename, r2_key, expires_at, short_code, require_login, size, upload_status, deleted_at FROM files WHERE id = \? LIMIT 1/;
const COMPLETE_FILE_SELECT =
  /SELECT id, owner_id, filename, r2_key, expires_at, short_code, require_login, upload_status, multipart_upload_id, size FROM files WHERE id = \?/;
const STATUS_SELECT = /SELECT upload_status FROM files WHERE id = \?/;
const COMPLETED_UPDATE =
  /UPDATE files SET size = \?, upload_status = 'completed'/;
const RESERVATION_UPDATE = /UPDATE upload_reservations SET status = \?/;

function confirmFileRow(overrides = {}) {
  return {
    id: "file-1",
    owner_id: "user-1",
    filename: "demo.bin",
    r2_key: "flares3/config/demo.bin",
    expires_at: "9999-12-31T23:59:59.999Z",
    short_code: "abc123",
    require_login: 1,
    size: 128,
    upload_status: "pending",
    deleted_at: null,
    ...overrides,
  };
}

function multipartFileRow(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function noSuchUploadError() {
  const error = new Error("The specified upload does not exist");
  error.name = "NoSuchUpload";
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

test("confirmUpload rejects files already moved to trash", async () => {
  const { r2, upload } = loadUploadModules();
  let headCalls = 0;
  r2.resolveR2ConfigForKey = async () => {
    throw new Error("deleted files must fail before storage lookup");
  };
  r2.getObjectSize = async () => {
    headCalls += 1;
    return 128;
  };

  const response = await upload.confirmUpload(
    createAuthedRequest("https://example.com/api/upload/confirm", {
      file_id: "file-1",
    }),
    {
      DB: createDb({
        firstHandlers: [
          {
            match: CONFIRM_FILE_SELECT,
            value: confirmFileRow({
              upload_status: "deleted",
              deleted_at: "2026-10-05T00:00:00.000Z",
            }),
          },
        ],
      }),
    },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_CONFIRM_NOT_PENDING",
      message: "文件不在待确认状态，无法完成确认",
    },
  });
  assert.equal(headCalls, 0);
});

test("confirmUpload rejects expired files", async () => {
  const { r2, upload } = loadUploadModules();
  r2.resolveR2ConfigForKey = async () => {
    throw new Error("expired files must fail before storage lookup");
  };

  const response = await upload.confirmUpload(
    createAuthedRequest("https://example.com/api/upload/confirm", {
      file_id: "file-1",
    }),
    {
      DB: createDb({
        firstHandlers: [
          {
            match: CONFIRM_FILE_SELECT,
            value: confirmFileRow({ expires_at: "2020-01-01T00:00:00.000Z" }),
          },
        ],
      }),
    },
  );

  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_FILE_EXPIRED",
      message: "文件已过期",
    },
  });
});

test("confirmUpload rejects files not in pending state", async () => {
  const { r2, upload } = loadUploadModules();
  let headCalls = 0;
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.getObjectSize = async () => {
    headCalls += 1;
    return 128;
  };

  const response = await upload.confirmUpload(
    createAuthedRequest("https://example.com/api/upload/confirm", {
      file_id: "file-1",
    }),
    {
      DB: createDb({
        firstHandlers: [
          {
            match: CONFIRM_FILE_SELECT,
            value: confirmFileRow({ upload_status: "completed" }),
          },
        ],
      }),
    },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_CONFIRM_NOT_PENDING",
      message: "文件不在待确认状态，无法完成确认",
    },
  });
  assert.equal(headCalls, 0);
});

test("confirmUpload returns conflict when guarded update races to zero changes", async () => {
  const { r2, upload } = loadUploadModules();
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.getObjectSize = async () => 128;

  const response = await upload.confirmUpload(
    createAuthedRequest("https://example.com/api/upload/confirm", {
      file_id: "file-1",
    }),
    {
      DB: createDb({
        firstHandlers: [
          { match: CONFIRM_FILE_SELECT, value: confirmFileRow() },
        ],
        runHandlers: [
          { match: COMPLETED_UPDATE, value: { meta: { changes: 0 } } },
          { match: RESERVATION_UPDATE, value: { meta: { changes: 0 } } },
        ],
      }),
    },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_CONFIRM_NOT_PENDING",
      message: "文件不在待确认状态，无法完成确认",
    },
  });
});

test("completeMultipart returns idempotent success for concurrent duplicate completion", async () => {
  const { r2, upload } = loadUploadModules();
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.completeMultipartUpload = async () => {
    throw noSuchUploadError();
  };
  let headCalls = 0;
  r2.getObjectSize = async () => {
    headCalls += 1;
    return 100;
  };

  const completedUpdates = [];
  const response = await upload.completeMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/complete", {
      file_id: "file-1",
      upload_id: "upload-1",
      parts: [{ part_number: 1, etag: "etag-1" }],
    }),
    {
      DB: createDb({
        firstHandlers: [
          { match: COMPLETE_FILE_SELECT, value: multipartFileRow() },
          // 并发竞态：首个请求已完成落库，后到请求收到 NoSuchUpload
          { match: STATUS_SELECT, value: { upload_status: "completed" } },
        ],
        runHandlers: [
          {
            match: COMPLETED_UPDATE,
            value: (_args, sql) => {
              completedUpdates.push(sql);
              return { meta: { changes: 0 } };
            },
          },
          { match: RESERVATION_UPDATE, value: { meta: { changes: 0 } } },
        ],
      }),
    },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.file_id, "file-1");
  assert.equal(payload.download_url, "/api/files/file-1/download");
  assert.equal(payload.r2_config_id, "config-1");
  // 已完成记录不再重复推进，守卫 UPDATE 命中 0 行仍返回幂等成功
  assert.equal(completedUpdates.length, 1);
  assert.match(completedUpdates[0], /AND upload_status = 'uploading'/);
});

test("completeMultipart recovers crash residue when R2 merged but DB write failed", async () => {
  const { r2, upload } = loadUploadModules();
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.completeMultipartUpload = async () => {
    throw noSuchUploadError();
  };
  let headCalls = 0;
  r2.getObjectSize = async () => {
    headCalls += 1;
    return 100;
  };

  const completedUpdates = [];
  const response = await upload.completeMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/complete", {
      file_id: "file-1",
      upload_id: "upload-1",
      parts: [{ part_number: 1, etag: "etag-1" }],
    }),
    {
      DB: createDb({
        firstHandlers: [
          { match: COMPLETE_FILE_SELECT, value: multipartFileRow() },
          // 崩溃残留：R2 已合并，DB 仍停留 uploading
          { match: STATUS_SELECT, value: { upload_status: "uploading" } },
        ],
        runHandlers: [
          {
            match: COMPLETED_UPDATE,
            value: (args, sql) => {
              completedUpdates.push({ args, sql });
              return { meta: { changes: 1 } };
            },
          },
          { match: RESERVATION_UPDATE, value: { meta: { changes: 1 } } },
        ],
      }),
    },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.file_id, "file-1");
  assert.equal(payload.r2_config_id, "config-1");
  // 恢复探测 HEAD 一次 + 大小校验 HEAD 一次，随后补状态推进并消费预约
  assert.equal(headCalls, 2);
  assert.equal(completedUpdates.length, 1);
  assert.deepEqual(completedUpdates[0].args, [100, "file-1"]);
  assert.match(completedUpdates[0].sql, /AND upload_status = 'uploading'/);
});

test("completeMultipart keeps original error when NoSuchUpload object is missing", async () => {
  const { r2, upload } = loadUploadModules();
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.completeMultipartUpload = async () => {
    throw noSuchUploadError();
  };
  r2.getObjectSize = async () => null;

  const response = await upload.completeMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/complete", {
      file_id: "file-1",
      upload_id: "upload-1",
      parts: [{ part_number: 1, etag: "etag-1" }],
    }),
    {
      DB: createDb({
        firstHandlers: [
          { match: COMPLETE_FILE_SELECT, value: multipartFileRow() },
          { match: STATUS_SELECT, value: { upload_status: "uploading" } },
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

test("completeMultipart keeps upstream InvalidPart error without recovery", async () => {
  const { r2, upload } = loadUploadModules();
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.completeMultipartUpload = async () => {
    const error = new Error(
      "One or more of the specified parts could not be found",
    );
    error.name = "InvalidPart";
    error.$metadata = { httpStatusCode: 400 };
    throw error;
  };
  let headCalls = 0;
  r2.getObjectSize = async () => {
    headCalls += 1;
    return 100;
  };

  const response = await upload.completeMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/complete", {
      file_id: "file-1",
      upload_id: "upload-1",
      parts: [{ part_number: 1, etag: "etag-1" }],
    }),
    {
      // 仅提供首次读取 handler：若恢复路径发起二次读库会直接抛错并改变错误码
      DB: createDb({
        firstHandlers: [
          { match: COMPLETE_FILE_SELECT, value: multipartFileRow() },
        ],
      }),
    },
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_STORAGE_REQUEST_FAILED",
      message: "One or more of the specified parts could not be found",
      details: {
        upstreamCode: "InvalidPart",
        upstreamStatus: 400,
      },
    },
  });
  assert.equal(headCalls, 0);
});
