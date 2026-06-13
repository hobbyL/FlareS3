const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

test("calcPresignedDownloadUrlTtlSeconds clamps download ttl to valid bounds", () => {
  const {
    MAX_PRESIGNED_DOWNLOAD_URL_TTL_SECONDS,
    calcPresignedDownloadUrlTtlSeconds,
  } = require(compiledPath("services/presignedUrlTtl.js"));
  const now = Date.parse("2026-04-15T00:00:00.000Z");

  assert.equal(
    calcPresignedDownloadUrlTtlSeconds(new Date(now + 10_000), now),
    10,
  );
  assert.equal(
    calcPresignedDownloadUrlTtlSeconds(new Date(now - 10_000), now),
    1,
  );
  assert.equal(
    calcPresignedDownloadUrlTtlSeconds(
      new Date(now + 48 * 60 * 60 * 1000),
      now,
    ),
    MAX_PRESIGNED_DOWNLOAD_URL_TTL_SECONDS,
  );
  assert.equal(
    calcPresignedDownloadUrlTtlSeconds(new Date("not-a-date"), now),
    MAX_PRESIGNED_DOWNLOAD_URL_TTL_SECONDS,
  );
});
