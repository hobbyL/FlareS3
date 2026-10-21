const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");
const { mapUnexpectedUploadError, uploadErrorResponse } = require(
  path.join(root, "services/uploadErrors.js"),
);

test("upload error bodies never expose upstream diagnostic messages or malformed codes", async () => {
  const privatePath = "INTERNAL-UPSTREAM-PATH:/private/bucket/object";
  const error = Object.assign(new Error(privatePath), {
    name: privatePath,
    $metadata: { httpStatusCode: 403 },
  });
  const response = uploadErrorResponse(
    mapUnexpectedUploadError(error, {
      code: "UPLOAD_SERVER_FAILED",
      message: "服务端上传失败",
    }),
  );
  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.error.message, "存储服务请求失败，请稍后重试");
  assert.equal(payload.error.details.upstreamStatus, 403);
  assert.ok(!JSON.stringify(payload).includes(privatePath));
});
