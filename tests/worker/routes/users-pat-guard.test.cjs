const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");
const users = require(path.join(root, "routes/users.js"));
for (const method of ["createUser", "updateUser", "resetPassword"]) {
  test(`${method} rejects admin PAT before reading the body or database`, async () => {
    const request = Object.assign(
      new Request("https://example.com/api/users", {
        method: "POST",
        body: "invalid",
      }),
      {
        user: { id: "u", role: "admin" },
        authKind: "pat",
      },
    );
    const response = await users[method](
      request,
      {
        DB: {
          prepare() {
            throw new Error("must not read DB");
          },
        },
      },
      "u",
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "此操作需会话登录，不支持 API Token",
    });
  });
}
