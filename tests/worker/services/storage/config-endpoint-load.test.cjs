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

function createDb(row) {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return row;
            },
          };
        },
      };
    },
  };
}

test("loadR2ConfigById refuses invalid persisted endpoints before decrypting", async () => {
  const { loadR2ConfigById } = loadModule("services/r2ConfigRegistry.js");
  const config = await loadR2ConfigById(
    {
      R2_MASTER_KEY: "test-master-key",
      DB: createDb({
        endpoint: "https://127.0.0.1",
        bucket_name: "bucket",
        access_key_id_enc: "not-used",
        secret_access_key_enc: "not-used",
      }),
    },
    "config-1",
  );

  assert.equal(config, null);
});

test("loadWebDAVConfigById refuses invalid persisted WebDAV and Koofr endpoints", async () => {
  const { loadWebDAVConfigById } = loadModule(
    "services/storage/webdav-config.js",
  );
  const env = { R2_MASTER_KEY: "test-master-key" };

  const webdav = await loadWebDAVConfigById(
    { ...env, DB: createDb({ type: "webdav", endpoint: "https://10.0.0.8" }) },
    "config-1",
  );
  const koofr = await loadWebDAVConfigById(
    {
      ...env,
      DB: createDb({
        type: "koofr",
        endpoint: "https://storage.example.com",
      }),
    },
    "config-2",
  );

  assert.equal(webdav, null);
  assert.equal(koofr, null);
});
