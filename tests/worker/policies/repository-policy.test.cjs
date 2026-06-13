const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(process.cwd(), "..");

test(".gitignore does not hide tests, docs, or project guidance assets", () => {
  const gitignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");

  for (const forbiddenPattern of [
    /^docs\/$/m,
    /^\*test\*$/m,
    /^\.trellis\/$/m,
    /^\.agents\/$/m,
  ]) {
    assert.doesNotMatch(gitignore, forbiddenPattern);
  }

  assert.match(gitignore, /^node_modules\/$/m);
  assert.match(gitignore, /^frontend\/dist\/$/m);
  assert.match(gitignore, /^worker\/\.wrangler\/$/m);
  assert.match(gitignore, /^\.dev\.vars\*$/m);
});

test("root tests package directories only contain architecture subdirectories", () => {
  for (const testPackage of ["frontend", "worker"]) {
    const packageTestRoot = path.join(repoRoot, "tests", testPackage);
    const rootFiles = fs
      .readdirSync(packageTestRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);

    assert.deepEqual(
      rootFiles,
      [],
      `tests/${testPackage} should group tests by architecture subdirectory`,
    );
  }
});
