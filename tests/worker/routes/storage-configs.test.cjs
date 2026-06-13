const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");
const TEST_MASTER_KEY = Buffer.alloc(32).toString("base64");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

function clearModule(relativePath) {
  delete require.cache[compiledPath(relativePath)];
}

function loadModule(relativePath) {
  const target = compiledPath(relativePath);
  delete require.cache[target];
  return require(target);
}

function createDb() {
  const firstResults = [0];
  return {
    prepare(sql) {
      return {
        sql,
        bind() {
          return this;
        },
        async all() {
          if (/SUBSTR\(r2_key, 9\)/.test(sql)) {
            return {
              results: [
                { config_id: "r2-1", used_space: 123 },
                { config_id: "webdav-1", used_space: 256 },
              ],
            };
          }
          if (/FROM upload_reservations/.test(sql)) {
            return { results: [] };
          }
          throw new Error(`unexpected all SQL: ${sql}`);
        },
        async first() {
          if (!firstResults.length) {
            throw new Error(`unexpected first SQL: ${sql}`);
          }
          return firstResults.shift();
        },
      };
    },
  };
}

function loadStorageConfigsRoute() {
  clearModule("routes/storageConfigs.js");
  clearModule("services/r2.js");
  clearModule("services/storage/webdav-config.js");

  const r2 = loadModule("services/r2.js");
  const webdavConfig = loadModule("services/storage/webdav-config.js");

  r2.listR2ConfigSummaries = async () => ({
    default_config_id: "r2-1",
    legacy_files_config_id: null,
    configs: [
      {
        id: "r2-1",
        name: "Primary R2",
        source: "db",
        endpoint: "https://r2.example.com",
        bucketName: "bucket-a",
        quotaBytes: 1024,
      },
    ],
  });
  r2.loadR2ConfigById = async (_env, id) => {
    if (id !== "r2-1") return null;
    return {
      id: "r2-1",
      source: "db",
      config: {
        endpoint: "https://r2.example.com",
        bucketName: "bucket-a",
        accessKeyId: "access-1",
        secretAccessKey: "secret-1",
      },
    };
  };
  webdavConfig.listWebDAVConfigs = async () => [
    {
      id: "webdav-1",
      name: "Docs",
      type: "webdav",
      endpoint: "https://dav.example.com",
      mount_id: null,
      remote_path: "/docs",
      username: "should-not-leak",
      password: "should-not-leak",
      quotaBytes: 2048,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  webdavConfig.loadWebDAVConfigById = async (_env, id) => {
    if (id !== "webdav-1") return null;
    return {
      id: "webdav-1",
      type: "webdav",
      config: {
        endpoint: "https://dav.example.com",
        username: "dav-user",
        password: "dav-password",
        remotePath: "/docs",
      },
    };
  };

  return loadModule("routes/storageConfigs.js");
}

test("listAllConfigs omits decrypted storage credentials from config list responses", async () => {
  const { listAllConfigs } = loadStorageConfigsRoute();
  const response = await listAllConfigs(
    new Request("https://example.com/api/storage/configs"),
    {
      DB: createDb(),
      TOTAL_STORAGE: "4096",
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.default_config_id, "r2-1");
  assert.equal(payload.configs.length, 2);
  assert.match(
    response.headers.get("X-Flares3-Route-Timing") || "",
    /completedUsageRows=\d+\.\dms/,
  );

  const r2Config = payload.configs.find((config) => config.id === "r2-1");
  assert.equal(r2Config.endpoint, "https://r2.example.com");
  assert.equal(r2Config.bucket_name, "bucket-a");
  assert.equal(Object.hasOwn(r2Config, "access_key_id"), false);
  assert.equal(Object.hasOwn(r2Config, "secret_access_key"), false);

  const webdavConfig = payload.configs.find(
    (config) => config.id === "webdav-1",
  );
  assert.equal(webdavConfig.endpoint, "https://dav.example.com");
  assert.equal(webdavConfig.remote_path, "/docs");
  assert.equal(webdavConfig.usedSpace, 256);
  assert.equal(webdavConfig.usagePercent, 12.5);
  assert.equal(Object.hasOwn(webdavConfig, "username"), false);
  assert.equal(Object.hasOwn(webdavConfig, "password"), false);
});

test("getConfigSecrets reveals saved R2 credentials for edit forms", async () => {
  const { getConfigSecrets } = loadStorageConfigsRoute();
  const response = await getConfigSecrets(
    new Request("https://example.com/api/storage/configs/r2-1/secrets?type=r2"),
    { DB: createDb() },
    "r2-1",
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(payload.type, "r2");
  assert.equal(payload.endpoint, "https://r2.example.com");
  assert.equal(payload.bucket_name, "bucket-a");
  assert.equal(payload.access_key_id, "access-1");
  assert.equal(payload.secret_access_key, "secret-1");
  assert.equal(Object.hasOwn(payload, "access_key_id_enc"), false);
  assert.equal(Object.hasOwn(payload, "secret_access_key_enc"), false);
});

test("getConfigSecrets reveals saved WebDAV credentials for edit forms", async () => {
  const { getConfigSecrets } = loadStorageConfigsRoute();
  const response = await getConfigSecrets(
    new Request(
      "https://example.com/api/storage/configs/webdav-1/secrets?type=webdav",
    ),
    { DB: createDb() },
    "webdav-1",
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(payload.type, "webdav");
  assert.equal(payload.endpoint, "https://dav.example.com");
  assert.equal(payload.remote_path, "/docs");
  assert.equal(payload.username, "dav-user");
  assert.equal(payload.password, "dav-password");
  assert.equal(Object.hasOwn(payload, "username_enc"), false);
  assert.equal(Object.hasOwn(payload, "password_enc"), false);
});

test("legacy WebDAV config list omits decrypted credentials", async () => {
  clearModule("routes/webdavConfigs.js");
  clearModule("services/storage/webdav-config.js");

  const webdavConfig = loadModule("services/storage/webdav-config.js");
  webdavConfig.listWebDAVConfigs = async () => [
    {
      id: "webdav-1",
      name: "Docs",
      type: "webdav",
      endpoint: "https://dav.example.com",
      mount_id: null,
      remote_path: "/docs",
      username: "should-not-leak",
      password: "should-not-leak",
      quotaBytes: 2048,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  const { listConfigs } = loadModule("routes/webdavConfigs.js");
  const response = await listConfigs(
    new Request("https://example.com/api/webdav/configs"),
    {
      DB: createDb(),
      R2_MASTER_KEY: TEST_MASTER_KEY,
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.configs.length, 1);
  assert.equal(payload.configs[0].endpoint, "https://dav.example.com");
  assert.equal(Object.hasOwn(payload.configs[0], "username"), false);
  assert.equal(Object.hasOwn(payload.configs[0], "password"), false);
});
