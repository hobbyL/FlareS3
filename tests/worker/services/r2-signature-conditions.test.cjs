const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");
const { copyObject, generateUploadUrl } = require(
  path.join(root, "services/r2Objects.js"),
);
const config = {
  endpoint: "https://example.com",
  accessKeyId: "dummy",
  secretAccessKey: "dummy",
  bucketName: "bucket",
};
test("actual presigned COPY signs source version and R2 destination condition headers", async () => {
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const parsed = new URL(url);
    const signed = parsed.searchParams.get("X-Amz-SignedHeaders");
    for (const name of [
      "x-amz-copy-source",
      "x-amz-copy-source-if-match",
      "cf-copy-destination-if-none-match",
    ]) {
      assert.ok(signed.split(";").includes(name), `${name} must be signed`);
      assert.equal(parsed.searchParams.has(name), false);
    }
    assert.equal(init.headers["x-amz-copy-source-if-match"], '"v1"');
    return new Response("<CopyObjectResult/>");
  };
  try {
    await copyObject(config, "temporary", "published", {
      sourceEtag: '"v1"',
      createOnly: true,
    });
  } finally {
    global.fetch = original;
  }
});
test("direct PUT signature binds declared content length", async () => {
  const url = new URL(
    await generateUploadUrl(config, "temporary", "text/plain", 3600, 123),
  );
  assert.ok(
    url.searchParams
      .get("X-Amz-SignedHeaders")
      .split(";")
      .includes("content-length"),
  );
});

test("conditional R2 PUT signature requires the destination creation header", async () => {
  const url = new URL(
    await generateUploadUrl(config, "target", "text/plain", 3600, 123, {
      ifNoneMatch: "*",
    }),
  );
  assert.ok(
    url.searchParams
      .get("X-Amz-SignedHeaders")
      .split(";")
      .includes("if-none-match"),
  );
});
