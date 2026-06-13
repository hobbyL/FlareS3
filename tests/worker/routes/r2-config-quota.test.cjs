const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

function loadModule(relativePath) {
  const target = compiledPath(relativePath);
  delete require.cache[target];
  return require(target);
}

function clearModule(relativePath) {
  delete require.cache[compiledPath(relativePath)];
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

function createDb({
  firstHandlers = [],
  allHandlers = [],
  runHandlers = [],
  batchHandlers = [],
}) {
  function consume(list, sql, args, kind) {
    const index = list.findIndex((handler) => handler.match.test(sql));
    if (index === -1) {
      if (kind === "run" && /^(CREATE|ALTER TABLE)/.test(sql.trim())) {
        return { meta: { changes: 0 } };
      }
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
    db: {
      prepare(sql) {
        return {
          sql,
          bind(...args) {
            return {
              sql,
              args,
              async first() {
                return consume(firstHandlers, sql, args, "first");
              },
              async all() {
                return consume(allHandlers, sql, args, "all");
              },
              async run() {
                return consume(runHandlers, sql, args, "run");
              },
            };
          },
          async first() {
            return consume(firstHandlers, sql, [], "first");
          },
          async all() {
            return consume(allHandlers, sql, [], "all");
          },
          async run() {
            return consume(runHandlers, sql, [], "run");
          },
        };
      },
      async batch(statements) {
        if (!batchHandlers.length) {
          throw new Error(
            `unexpected batch SQL: ${statements.map((statement) => statement.sql).join(" | ")}`,
          );
        }
        const handler = batchHandlers.shift();
        return typeof handler === "function" ? handler(statements) : handler;
      },
    },
  };
}

function loadUploadModules() {
  clearModule("routes/upload/index.js");
  clearModule("routes/upload/presign.js");
  clearModule("routes/upload/multipart.js");
  clearModule("routes/upload/helpers.js");
  clearModule("services/r2.js");
  clearModule("services/quota.js");
  clearModule("services/uploadConfigPolicy.js");

  const r2 = loadModule("services/r2.js");
  const quota = loadModule("services/quota.js");
  const uploadConfigPolicy = loadModule("services/uploadConfigPolicy.js");
  const upload = loadModule("routes/upload/index.js");
  return { r2, quota, uploadConfigPolicy, upload };
}

test("presignUpload rejects when selected config quota is exhausted", async () => {
  const { r2, quota, uploadConfigPolicy, upload } = loadUploadModules();
  const { db } = createDb({
    firstHandlers: [
      {
        match: /SELECT quota_bytes FROM r2_configs WHERE id = \? LIMIT 1/,
        value: 1024,
      },
      {
        match:
          /COALESCE\(SUM\(size\), 0\) AS completedUsed FROM files WHERE owner_id = \? AND upload_status = 'completed' AND deleted_at IS NULL AND expires_at > \?/,
        value: 0,
      },
      {
        match:
          /COALESCE\(SUM\(reserved_bytes\), 0\) AS reservedUsed FROM upload_reservations WHERE user_id = \? AND status = 'active'/,
        value: 0,
      },
      {
        match:
          /COALESCE\(SUM\(size\), 0\) AS completedUsed[\s\S]*config_id = \?/,
        value: 900,
      },
      {
        match:
          /COALESCE\(SUM\(reserved_bytes\), 0\) AS reservedUsed FROM upload_reservations WHERE r2_config_id = \? AND status = 'active'/,
        value: 0,
      },
      {
        match: /SELECT id FROM files WHERE r2_key = \? LIMIT 1/,
        value: null,
      },
    ],
    allHandlers: [
      {
        match: /PRAGMA table_info\(files\)/,
        value: { results: [{ name: "multipart_upload_id" }] },
      },
    ],
    runHandlers: [
      {
        match: /INSERT INTO upload_reservations/,
        value: { meta: { changes: 0 } },
      },
      {
        match: /INSERT INTO files /,
        value: { meta: { changes: 1 } },
      },
      {
        match: /INSERT INTO audit_logs/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  quota.getUserUsedSpace = async () => 0;
  uploadConfigPolicy.resolveUploadConfigForUser = async () => ({
    id: "config-1",
    config: { endpoint: "https://example.com", bucketName: "bucket" },
  });
  r2.generateUploadUrl = async () => "https://upload.example.com";

  const response = await upload.presignUpload(
    createAuthedRequest("https://example.com/api/upload/presign", {
      filename: "demo.bin",
      size: 256,
      expires_in: 7,
      config_id: "config-1",
    }),
    { DB: db },
  );

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_CONFIG_CAPACITY_EXCEEDED",
      message: "所选存储配置空间不足",
    },
  });
});

test("initMultipart rejects when selected config quota is exhausted", async () => {
  const { r2, quota, uploadConfigPolicy, upload } = loadUploadModules();
  const { db } = createDb({
    firstHandlers: [
      {
        match: /SELECT quota_bytes FROM r2_configs WHERE id = \? LIMIT 1/,
        value: 1024,
      },
      {
        match:
          /COALESCE\(SUM\(size\), 0\) AS completedUsed FROM files WHERE owner_id = \? AND upload_status = 'completed' AND deleted_at IS NULL AND expires_at > \?/,
        value: 0,
      },
      {
        match:
          /COALESCE\(SUM\(reserved_bytes\), 0\) AS reservedUsed FROM upload_reservations WHERE user_id = \? AND status = 'active'/,
        value: 0,
      },
      {
        match:
          /COALESCE\(SUM\(size\), 0\) AS completedUsed[\s\S]*config_id = \?/,
        value: 900,
      },
      {
        match:
          /COALESCE\(SUM\(reserved_bytes\), 0\) AS reservedUsed FROM upload_reservations WHERE r2_config_id = \? AND status = 'active'/,
        value: 0,
      },
      {
        match: /SELECT id FROM files WHERE r2_key = \? LIMIT 1/,
        value: null,
      },
    ],
    runHandlers: [
      {
        match: /INSERT INTO upload_reservations/,
        value: { meta: { changes: 0 } },
      },
      {
        match: /INSERT INTO files /,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /UPDATE files SET upload_status = \?, multipart_upload_id = \? WHERE id = \?/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  quota.getUserUsedSpace = async () => 0;
  uploadConfigPolicy.resolveUploadConfigForUser = async () => ({
    id: "config-1",
    config: { endpoint: "https://example.com", bucketName: "bucket" },
  });
  r2.initiateMultipartUpload = async () => "upload-1";

  const response = await upload.initMultipart(
    createAuthedRequest("https://example.com/api/upload/multipart/init", {
      filename: "demo.bin",
      size: 256,
      expires_in: 7,
      config_id: "config-1",
    }),
    { DB: db },
  );

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_CONFIG_CAPACITY_EXCEEDED",
      message: "所选存储配置空间不足",
    },
  });
});

test("presignUpload rejects when active reservation exhausts user quota", async () => {
  const { r2, uploadConfigPolicy, upload } = loadUploadModules();
  const { db } = createDb({
    firstHandlers: [
      {
        match: /SELECT quota_bytes FROM r2_configs WHERE id = \? LIMIT 1/,
        value: 4096,
      },
      {
        match:
          /COALESCE\(SUM\(size\), 0\) AS completedUsed FROM files WHERE owner_id = \? AND upload_status = 'completed' AND deleted_at IS NULL AND expires_at > \?/,
        value: 700,
      },
      {
        match:
          /COALESCE\(SUM\(reserved_bytes\), 0\) AS reservedUsed FROM upload_reservations WHERE user_id = \? AND status = 'active'/,
        value: 250,
      },
      {
        match:
          /COALESCE\(SUM\(size\), 0\) AS completedUsed[\s\S]*config_id = \?/,
        value: 0,
      },
      {
        match:
          /COALESCE\(SUM\(reserved_bytes\), 0\) AS reservedUsed FROM upload_reservations WHERE r2_config_id = \? AND status = 'active'/,
        value: 0,
      },
      {
        match: /SELECT id FROM files WHERE r2_key = \? LIMIT 1/,
        value: null,
      },
    ],
    runHandlers: [
      {
        match: /INSERT INTO upload_reservations/,
        value: { meta: { changes: 0 } },
      },
    ],
  });

  uploadConfigPolicy.resolveUploadConfigForUser = async () => ({
    id: "config-1",
    config: { endpoint: "https://example.com", bucketName: "bucket" },
  });
  r2.generateUploadUrl = async () => "https://upload.example.com";

  const request = createAuthedRequest(
    "https://example.com/api/upload/presign",
    {
      filename: "demo.bin",
      size: 100,
      expires_in: 7,
      config_id: "config-1",
    },
  );
  request.user.quota_bytes = 1000;

  const response = await upload.presignUpload(request, { DB: db });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_USER_QUOTA_EXCEEDED",
      message: "超出配额",
      details: {
        declaredSize: 100,
        quotaBytes: 1000,
        usedSpace: 950,
      },
    },
  });
});

test("presignUpload rejects when active reservation exhausts selected config quota", async () => {
  const { r2, uploadConfigPolicy, upload } = loadUploadModules();
  const { db } = createDb({
    firstHandlers: [
      {
        match: /SELECT quota_bytes FROM r2_configs WHERE id = \? LIMIT 1/,
        value: 1024,
      },
      {
        match:
          /COALESCE\(SUM\(size\), 0\) AS completedUsed FROM files WHERE owner_id = \? AND upload_status = 'completed' AND deleted_at IS NULL AND expires_at > \?/,
        value: 0,
      },
      {
        match:
          /COALESCE\(SUM\(reserved_bytes\), 0\) AS reservedUsed FROM upload_reservations WHERE user_id = \? AND status = 'active'/,
        value: 0,
      },
      {
        match:
          /COALESCE\(SUM\(size\), 0\) AS completedUsed[\s\S]*config_id = \?/,
        value: 900,
      },
      {
        match:
          /COALESCE\(SUM\(reserved_bytes\), 0\) AS reservedUsed FROM upload_reservations WHERE r2_config_id = \? AND status = 'active'/,
        value: 100,
      },
      {
        match: /SELECT id FROM files WHERE r2_key = \? LIMIT 1/,
        value: null,
      },
    ],
    runHandlers: [
      {
        match: /INSERT INTO upload_reservations/,
        value: { meta: { changes: 0 } },
      },
    ],
  });

  uploadConfigPolicy.resolveUploadConfigForUser = async () => ({
    id: "config-1",
    config: { endpoint: "https://example.com", bucketName: "bucket" },
  });
  r2.generateUploadUrl = async () => "https://upload.example.com";

  const response = await upload.presignUpload(
    createAuthedRequest("https://example.com/api/upload/presign", {
      filename: "demo.bin",
      size: 30,
      expires_in: 7,
      config_id: "config-1",
    }),
    { DB: db },
  );

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_CONFIG_CAPACITY_EXCEEDED",
      message: "所选存储配置空间不足",
    },
  });
});

test("listConfigs counts pending uploading and completed files for config usage", async () => {
  clearModule("routes/r2Configs.js");
  clearModule("services/r2.js");

  const r2 = loadModule("services/r2.js");
  const { listConfigs } = loadModule("routes/r2Configs.js");

  r2.listR2ConfigSummaries = async () => ({
    default_config_id: "config-1",
    legacy_files_config_id: null,
    configs: [
      {
        id: "config-1",
        name: "Primary",
        source: "db",
        endpoint: "https://example.com",
        bucketName: "bucket",
        quotaBytes: 1024,
        accessKeyId: "should-not-leak",
      },
    ],
  });

  const { db } = createDb({
    firstHandlers: [
      {
        match: /r2_key NOT LIKE 'flares3\/%\/%'/,
        value: 0,
      },
      {
        match: /COALESCE\(SUM\(size\), 0\) AS usedSpace[\s\S]*config_id = \?/,
        value: 700,
      },
      {
        match:
          /COALESCE\(SUM\(reserved_bytes\), 0\) AS reservedUsed FROM upload_reservations WHERE r2_config_id = \? AND status = 'active'/,
        value: 68,
      },
    ],
  });

  const response = await listConfigs(
    new Request("https://example.com/api/r2/configs"),
    { DB: db },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.configs[0].usedSpace, 768);
  assert.equal(body.configs[0].usagePercent, 75);
  assert.equal(Object.hasOwn(body.configs[0], "access_key_id"), false);
  assert.equal(Object.hasOwn(body.configs[0], "secret_access_key"), false);
});

test("deleteConfig blocks deletion when selected R2 config has active upload reservations", async () => {
  clearModule("routes/r2Configs.js");
  const { deleteConfig } = loadModule("routes/r2Configs.js");

  const { db } = createDb({
    firstHandlers: [
      {
        match: /SELECT COUNT\(\*\) AS count FROM files WHERE r2_key LIKE \?/,
        value: 0,
      },
      {
        match:
          /SELECT COUNT\(\*\) AS count FROM delete_queue WHERE r2_key LIKE \?/,
        value: 0,
      },
      {
        match:
          /SELECT COUNT\(\*\) AS count FROM upload_reservations WHERE r2_config_id = \? AND status = 'active'/,
        value: 1,
      },
    ],
    runHandlers: [
      {
        match: /DELETE FROM r2_configs WHERE id = \?/,
        value() {
          throw new Error(
            "delete should not run while active reservations exist",
          );
        },
      },
    ],
  });

  const response = await deleteConfig(
    new Request("https://example.com/api/r2/configs/config-1"),
    {
      DB: db,
    },
    "config-1",
  );
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.match(body.error, /上传预约/);
});
