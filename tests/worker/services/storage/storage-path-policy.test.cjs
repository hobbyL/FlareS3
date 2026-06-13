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

test("normalizeRemotePath stores root and relative remote directories in canonical form", () => {
  const { normalizeRemotePath } = loadModule("services/storage/pathPolicy.js");

  assert.deepEqual(normalizeRemotePath(""), { ok: true, remotePath: "/" });
  assert.deepEqual(normalizeRemotePath("/"), { ok: true, remotePath: "/" });
  assert.deepEqual(normalizeRemotePath("docs"), {
    ok: true,
    remotePath: "/docs",
  });
  assert.deepEqual(normalizeRemotePath("/docs/team/"), {
    ok: true,
    remotePath: "/docs/team",
  });
});

test("normalizeRemotePath rejects traversal and ambiguous remote directories", () => {
  const { normalizeRemotePath } = loadModule("services/storage/pathPolicy.js");

  const blocked = [
    "../secret",
    "docs/../secret",
    "docs//team",
    "docs\\team",
    "docs\u0000team",
  ];
  for (const value of blocked) {
    const result = normalizeRemotePath(value);
    assert.equal(result.ok, false, value);
  }
});
