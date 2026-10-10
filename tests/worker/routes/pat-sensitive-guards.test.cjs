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

// 任何敏感端点以 PAT 访问都必须在触达 D1 之前被 403 拦下。
function createRejectingDb() {
  return {
    prepare() {
      throw new Error("sensitive endpoint must reject PAT before touching D1");
    },
    batch() {
      throw new Error("sensitive endpoint must reject PAT before touching D1");
    },
  };
}

const PAT_USER = {
  id: "user-1",
  username: "alice",
  role: "user",
  status: "active",
  quota_bytes: 1024,
};

function patRequest(url, { method = "POST" } = {}) {
  return Object.assign(new Request(url, { method }), {
    user: PAT_USER,
    authKind: "pat",
  });
}

const FORBIDDEN_BODY = { error: "此操作需会话登录，不支持 API Token" };

test("changePassword 以 PAT 访问返回 403 且不触达 D1", async () => {
  const { changePassword } = loadModule("routes/auth.js");
  const response = await changePassword(
    patRequest("https://example.com/api/auth/change-password"),
    { DB: createRejectingDb() },
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), FORBIDDEN_BODY);
});

test("listSessions 以 PAT 访问返回 403 且不触达 D1", async () => {
  const { listSessions } = loadModule("routes/auth.js");
  const response = await listSessions(
    patRequest("https://example.com/api/auth/sessions", { method: "GET" }),
    { DB: createRejectingDb() },
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), FORBIDDEN_BODY);
});

test("revokeSession 以 PAT 访问返回 403 且不触达 D1", async () => {
  const { revokeSession } = loadModule("routes/auth.js");
  const response = await revokeSession(
    patRequest("https://example.com/api/auth/sessions/sess-x", {
      method: "DELETE",
    }),
    { DB: createRejectingDb() },
    "sess-x",
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), FORBIDDEN_BODY);
});

test("revokeOtherSessions 以 PAT 访问返回 403 且不触达 D1", async () => {
  const { revokeOtherSessions } = loadModule("routes/auth.js");
  const response = await revokeOtherSessions(
    patRequest("https://example.com/api/auth/sessions/revoke-others"),
    { DB: createRejectingDb() },
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), FORBIDDEN_BODY);
});
