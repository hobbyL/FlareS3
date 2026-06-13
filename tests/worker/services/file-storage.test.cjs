const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

test("file storage helpers distinguish legacy R2 keys from explicit provider configs", () => {
  const { getExplicitProviderConfigId, getFileStorageConfigId } = require(
    compiledPath("services/fileStorage.js"),
  );

  assert.equal(
    getExplicitProviderConfigId({
      r2_key: "storage/webdav-1/docs/report.txt",
      config_id: "webdav-1",
    }),
    "webdav-1",
  );
  assert.equal(
    getExplicitProviderConfigId({
      r2_key: "flares3/r2-1/docs/report.txt",
      config_id: "r2-1",
    }),
    null,
  );
  assert.equal(
    getFileStorageConfigId({
      r2_key: "flares3/r2-1/docs/report.txt",
      config_id: "ignored",
    }),
    "r2-1",
  );
  assert.equal(
    getFileStorageConfigId({
      r2_key: "storage/webdav-1/docs/report.txt",
      config_id: "webdav-1",
    }),
    "webdav-1",
  );
});
