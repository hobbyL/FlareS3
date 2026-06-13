const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

test("public file and share codes use 12 random characters", () => {
  const codePolicy = require(compiledPath("utils/codePolicy.js"));

  assert.equal(codePolicy.FILE_SHORT_CODE_LENGTH, 12);
  assert.equal(codePolicy.SHARE_SHORT_CODE_LENGTH, 12);
});
