const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");
const signed = require(path.join(root, "services/r2SignedRequests.js"));
const objects = require(path.join(root, "services/r2Objects.js"));
const config = {
  endpoint: "https://example.com",
  accessKeyId: "ak",
  secretAccessKey: "sk",
  bucketName: "bucket",
};
test("publication COPY includes R2 destination create-only and source version conditions", async () => {
  signed.fetchSigned = async (_client, command, init) => {
    assert.equal(command.input.Key, "final");
    assert.deepEqual(init.headers, {
      "x-amz-copy-source": "/bucket/temp%20file",
      "x-amz-copy-source-if-match": '"version"',
      "cf-copy-destination-if-none-match": "*",
    });
    return new Response(
      "<CopyObjectResult><ETag>version</ETag></CopyObjectResult>",
    );
  };
  await objects.copyObject(config, "temp file", "final", {
    sourceEtag: '"version"',
    createOnly: true,
  });
});
