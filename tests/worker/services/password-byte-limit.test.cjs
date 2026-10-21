const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");
const { hashPassword, verifyPassword, isPasswordWithinByteLimit } = require(
  path.join(root, "services/password.js"),
);
test("password byte limit accepts 72 UTF-8 bytes and rejects truncating suffixes", () => {
  for (const password of ["a".repeat(72), "密".repeat(24), "😀".repeat(18)]) {
    assert.equal(isPasswordWithinByteLimit(password), true);
    const hash = hashPassword(password);
    assert.equal(verifyPassword(password, hash), true);
    assert.equal(isPasswordWithinByteLimit(`${password}x`), false);
    assert.throws(() => hashPassword(`${password}x`), /72/);
  }
  assert.equal(isPasswordWithinByteLimit(12345678), false);
});
