const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createSqliteDb } = require("../helpers/sqlite-db.cjs");
const root =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");
const worker = require(path.join(root, "index.js")).default;
test("missing or short authentication secret blocks login before account initialization", async () => {
  for (const secret of [undefined, "short", " ".repeat(40)]) {
    const { db, sqlite } = createSqliteDb();
    const response = await worker.fetch(
      new Request("https://example.com/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://example.com",
        },
        body: JSON.stringify({ username: "admin", password: "pass12345" }),
      }),
      { DB: db, AUTH_TOKEN_SECRET: secret },
      { waitUntil() {} },
    );
    assert.equal(response.status, 503);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
    sqlite.close();
  }
});
test("bootstrap rejects weak or oversized passwords without creating administrator", async () => {
  for (const password of ["short", "密".repeat(25)]) {
    const { db, sqlite } = createSqliteDb();
    const target = path.join(root, "middleware/bootstrapAdmin.js");
    delete require.cache[target];
    const { bootstrapAdmin } = require(target);
    assert.equal(
      (
        await bootstrapAdmin(
          new Request("https://example.com/api/auth/login"),
          {
            DB: db,
            BOOTSTRAP_ADMIN_USER: "admin",
            BOOTSTRAP_ADMIN_PASS: password,
          },
        )
      ).status,
      500,
    );
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
    sqlite.close();
  }
});
