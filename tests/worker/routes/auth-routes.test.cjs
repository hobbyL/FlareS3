const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

function clearModule(relativePath) {
  delete require.cache[compiledPath(relativePath)];
}

function loadModule(relativePath) {
  const target = compiledPath(relativePath);
  delete require.cache[target];
  return require(target);
}

function loadWorkerEntrypoint() {
  clearModule("index.js");
  return loadModule("index.js").default;
}

function loadRateLimitModule() {
  clearModule("middleware/rateLimit.js");
  return loadModule("middleware/rateLimit.js");
}

function loadAuthSessionModule() {
  clearModule("middleware/authSession.js");
  clearModule("services/authToken.js");
  return loadModule("middleware/authSession.js");
}

function loadAuthTokenModule() {
  clearModule("services/authToken.js");
  return loadModule("services/authToken.js");
}

function createDb({ firstHandlers = [], runHandlers = [] }) {
  const state = {
    runs: [],
  };

  function consume(list, sql, args, kind) {
    const index = list.findIndex((handler) => handler.match.test(sql));
    if (index === -1) {
      throw new Error(
        `unexpected ${kind} SQL: ${sql} / ${JSON.stringify(args)}`,
      );
    }
    const [handler] = list.splice(index, 1);
    return typeof handler.value === "function"
      ? handler.value(args, sql, state)
      : handler.value;
  }

  return {
    state,
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                return consume(firstHandlers, sql, args, "first");
              },
              async run() {
                state.runs.push({ sql, args });
                return consume(runHandlers, sql, args, "run");
              },
            };
          },
          async first() {
            return consume(firstHandlers, sql, [], "first");
          },
          async run() {
            state.runs.push({ sql, args: [] });
            return consume(runHandlers, sql, [], "run");
          },
        };
      },
    },
  };
}

test("rateLimitMiddleware skips D1-backed counters for ordinary API requests", async () => {
  const { rateLimitMiddleware } = loadRateLimitModule();
  const response = await rateLimitMiddleware(
    new Request("https://example.com/api/files"),
    {
      DB: {
        prepare() {
          throw new Error(
            "ordinary API requests should not touch D1 rate limits",
          );
        },
      },
    },
  );

  assert.equal(response, undefined);
});

test("rateLimitMiddleware keeps persistent D1 protection for login requests", async () => {
  const { db, state } = createDb({
    firstHandlers: [
      {
        match: /SELECT blocked_until FROM rate_limits WHERE ip = \?/,
        value: null,
      },
    ],
    runHandlers: [
      {
        match: /INSERT INTO rate_limits \(ip, request_count, window_start\)/,
        value: { meta: { changes: 1 } },
      },
    ],
  });
  const { rateLimitMiddleware } = loadRateLimitModule();

  const response = await rateLimitMiddleware(
    new Request("https://example.com/api/auth/login", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.10",
      },
    }),
    { DB: db },
  );

  assert.equal(response, undefined);
  assert.equal(state.runs.length, 1);
  assert.match(
    state.runs[0].sql,
    /INSERT INTO rate_limits \(ip, request_count, window_start\)/,
  );
});

test("rateLimitMiddleware applies scoped D1 protection to public download routes", async () => {
  const { db, state } = createDb({
    runHandlers: [
      {
        match: /INSERT INTO rate_limits \(ip, request_count, window_start\)/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /INSERT INTO rate_limits \(ip, request_count, window_start\)/,
        value: { meta: { changes: 1 } },
      },
    ],
  });
  const { rateLimitMiddleware } = loadRateLimitModule();

  const response = await rateLimitMiddleware(
    new Request("https://example.com/api/files/file-1/download", {
      method: "GET",
      headers: {
        "CF-Connecting-IP": "203.0.113.10",
      },
    }),
    { DB: db },
  );

  assert.equal(response, undefined);
  assert.equal(state.runs.length, 2);
  assert.equal(state.runs[0].args[0], "public:203.0.113.10");
  assert.equal(
    state.runs[1].args[0],
    "public:203.0.113.10:/api/files/file-1/download",
  );
});

test("rateLimitMiddleware blocks public share routes when the scoped counter is exhausted", async () => {
  const { db } = createDb({
    runHandlers: [
      {
        match: /INSERT INTO rate_limits \(ip, request_count, window_start\)/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /INSERT INTO rate_limits \(ip, request_count, window_start\)/,
        value: { meta: { changes: 0 } },
      },
    ],
  });
  const { rateLimitMiddleware } = loadRateLimitModule();

  const response = await rateLimitMiddleware(
    new Request("https://example.com/f/share-code", {
      method: "GET",
      headers: {
        "CF-Connecting-IP": "203.0.113.11",
      },
    }),
    { DB: db },
  );
  const payload = await response.json();

  assert.equal(response.status, 429);
  assert.deepEqual(payload, { error: "请求频率超限" });
});

test("rateLimitMiddleware blocks public share enumeration when the global counter is exhausted", async () => {
  const { db, state } = createDb({
    runHandlers: [
      {
        match: /INSERT INTO rate_limits \(ip, request_count, window_start\)/,
        value: { meta: { changes: 0 } },
      },
    ],
  });
  const { rateLimitMiddleware } = loadRateLimitModule();

  const response = await rateLimitMiddleware(
    new Request("https://example.com/f/another-share-code", {
      method: "GET",
      headers: {
        "CF-Connecting-IP": "203.0.113.12",
      },
    }),
    { DB: db },
  );
  const payload = await response.json();

  assert.equal(response.status, 429);
  assert.deepEqual(payload, { error: "请求频率超限" });
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].args[0], "public:203.0.113.12");
});

test("login rejects oversized JSON body before touching D1", async () => {
  const { login } = loadModule("routes/auth.js");
  const { MAX_JSON_REQUEST_BODY_BYTES } = loadModule(
    "services/requestBodyPolicy.js",
  );

  const response = await login(
    new Request("https://example.com/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(MAX_JSON_REQUEST_BODY_BYTES + 1),
      },
      body: "{}",
    }),
    {
      DB: {
        prepare() {
          throw new Error("oversized login body should not touch D1");
        },
      },
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 413);
  assert.match(payload.error, /JSON 请求体大小超过限制/);
});

test("login requires AUTH_TOKEN_SECRET before touching D1", async () => {
  const { login } = loadModule("routes/auth.js");

  const response = await login(
    new Request("https://example.com/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "42",
      },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    }),
    {
      R2_MASTER_KEY: "legacy-r2-master-key",
      DB: {
        prepare() {
          throw new Error(
            "missing AUTH_TOKEN_SECRET should fail before touching D1",
          );
        },
      },
    },
  );
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.deepEqual(payload, { error: "缺少 AUTH_TOKEN_SECRET" });
});

test("auth token signing secret does not fall back to R2_MASTER_KEY", async () => {
  const { createSignedAuthToken, getAuthTokenSecret } = loadAuthTokenModule();
  const env = { R2_MASTER_KEY: "legacy-r2-master-key" };

  assert.equal(getAuthTokenSecret(env), "");
  assert.equal(
    await createSignedAuthToken(env, {
      sessionId: "session-1",
      user: {
        id: "user-1",
        username: "alice",
        role: "admin",
        status: "active",
        quota_bytes: 1024,
      },
      issuedAtMs: Date.now(),
      expiresAtSeconds: Math.floor(Date.now() / 1000) + 60,
    }),
    null,
  );
});

test("authSessionMiddleware coalesces concurrent session lookups and caches the result briefly", async () => {
  const { authSessionMiddleware } = loadAuthSessionModule();
  let resolveLookup;
  const lookupGate = new Promise((resolve) => {
    resolveLookup = resolve;
  });
  let lookupCount = 0;
  const env = {
    DB: {
      prepare(sql) {
        assert.match(sql, /FROM sessions s/);
        return {
          bind() {
            return {
              async first() {
                lookupCount += 1;
                await lookupGate;
                return {
                  session_id: "session-1",
                  expires_at: new Date(Date.now() + 60_000).toISOString(),
                  revoked_at: null,
                  user_id: "user-1",
                  username: "alice",
                  role: "admin",
                  status: "active",
                  quota_bytes: 1024,
                };
              },
            };
          },
        };
      },
    },
  };
  const firstRequest = new Request("https://example.com/api/files", {
    headers: { Cookie: "flares3_session=session-token" },
  });
  const secondRequest = new Request("https://example.com/api/texts", {
    headers: { Cookie: "flares3_session=session-token" },
  });

  const firstAuth = authSessionMiddleware(firstRequest, env);
  const secondAuth = authSessionMiddleware(secondRequest, env);
  for (let attempt = 0; attempt < 20 && lookupCount === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(lookupCount, 1);

  resolveLookup();
  await Promise.all([firstAuth, secondAuth]);
  assert.equal(firstRequest.user.id, "user-1");
  assert.equal(secondRequest.user.id, "user-1");

  const cachedRequest = new Request("https://example.com/api/shares", {
    headers: { Cookie: "flares3_session=session-token" },
  });
  await authSessionMiddleware(cachedRequest, {
    DB: {
      prepare() {
        throw new Error("cached session should not touch D1");
      },
    },
  });
  assert.equal(cachedRequest.user.id, "user-1");
  assert.equal(lookupCount, 1);
});

test("authSessionMiddleware accepts signed auth tokens after persistent session validation", async () => {
  const { createSignedAuthToken } = loadAuthTokenModule();
  const { authSessionMiddleware } = loadAuthSessionModule();
  const env = { AUTH_TOKEN_SECRET: "test-auth-secret" };
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const token = await createSignedAuthToken(env, {
    sessionId: "session-1",
    user: {
      id: "user-1",
      username: "alice",
      role: "admin",
      status: "active",
      quota_bytes: 1024,
    },
    issuedAtMs: Date.now(),
    expiresAtSeconds: Math.floor(Date.now() / 1000) + 60,
  });
  const request = new Request("https://example.com/api/files", {
    headers: { Cookie: `flares3_session=${token}` },
  });

  await authSessionMiddleware(request, {
    ...env,
    DB: createDb({
      firstHandlers: [
        {
          match: /FROM sessions s/,
          value: {
            session_id: "session-1",
            expires_at: expiresAt,
            revoked_at: null,
            user_id: "user-1",
            username: "alice",
            role: "admin",
            status: "active",
            quota_bytes: 2048,
          },
        },
      ],
    }).db,
  });

  assert.equal(request.user.id, "user-1");
  assert.equal(request.user.role, "admin");
  assert.equal(request.user.quota_bytes, 2048);
  assert.equal(request.sessionId, "session-1");
});

test("authSessionMiddleware rejects signed auth tokens when the persistent session is revoked", async () => {
  const { createSignedAuthToken } = loadAuthTokenModule();
  const { authSessionMiddleware } = loadAuthSessionModule();
  const env = { AUTH_TOKEN_SECRET: "test-auth-secret" };
  const token = await createSignedAuthToken(env, {
    sessionId: "session-1",
    user: {
      id: "user-1",
      username: "alice",
      role: "admin",
      status: "active",
      quota_bytes: 1024,
    },
    issuedAtMs: Date.now(),
    expiresAtSeconds: Math.floor(Date.now() / 1000) + 60,
  });
  const request = new Request("https://example.com/api/files", {
    headers: { Cookie: `flares3_session=${token}` },
  });

  await authSessionMiddleware(request, {
    ...env,
    DB: createDb({
      firstHandlers: [
        {
          match: /FROM sessions s/,
          value: {
            session_id: "session-1",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            revoked_at: new Date().toISOString(),
            user_id: "user-1",
            username: "alice",
            role: "admin",
            status: "active",
            quota_bytes: 1024,
          },
        },
      ],
    }).db,
  });

  assert.equal(request.user, undefined);
});

test("authSessionMiddleware rejects signed auth tokens when the user is disabled", async () => {
  const { createSignedAuthToken } = loadAuthTokenModule();
  const { authSessionMiddleware } = loadAuthSessionModule();
  const env = { AUTH_TOKEN_SECRET: "test-auth-secret" };
  const token = await createSignedAuthToken(env, {
    sessionId: "session-1",
    user: {
      id: "user-1",
      username: "alice",
      role: "admin",
      status: "active",
      quota_bytes: 1024,
    },
    issuedAtMs: Date.now(),
    expiresAtSeconds: Math.floor(Date.now() / 1000) + 60,
  });
  const request = new Request("https://example.com/api/files", {
    headers: { Cookie: `flares3_session=${token}` },
  });

  await authSessionMiddleware(request, {
    ...env,
    DB: createDb({
      firstHandlers: [
        {
          match: /FROM sessions s/,
          value: {
            session_id: "session-1",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            revoked_at: null,
            user_id: "user-1",
            username: "alice",
            role: "admin",
            status: "disabled",
            quota_bytes: 1024,
          },
        },
      ],
    }).db,
  });

  assert.equal(request.user, undefined);
});

test("authSessionMiddleware rejects tampered signed tokens without D1 fallback", async () => {
  const { createSignedAuthToken } = loadAuthTokenModule();
  const { authSessionMiddleware } = loadAuthSessionModule();
  const env = { AUTH_TOKEN_SECRET: "test-auth-secret" };
  const token = await createSignedAuthToken(env, {
    sessionId: "session-1",
    user: {
      id: "user-1",
      username: "alice",
      role: "admin",
      status: "active",
      quota_bytes: 1024,
    },
    issuedAtMs: Date.now(),
    expiresAtSeconds: Math.floor(Date.now() / 1000) + 60,
  });
  const request = new Request("https://example.com/api/files", {
    headers: { Cookie: `flares3_session=${token}x` },
  });

  await authSessionMiddleware(request, {
    ...env,
    DB: {
      prepare() {
        throw new Error("tampered signed auth token should not touch D1");
      },
    },
  });

  assert.equal(request.user, undefined);
});

test("invalidateAuthToken rejects a previously valid signed token in the same isolate", async () => {
  const { createSignedAuthToken } = loadAuthTokenModule();
  const { authSessionMiddleware, invalidateAuthToken } =
    loadAuthSessionModule();
  const env = {
    AUTH_TOKEN_SECRET: "test-auth-secret",
    DB: {
      prepare() {
        throw new Error("signed auth token should not touch D1");
      },
    },
  };
  const token = await createSignedAuthToken(env, {
    sessionId: "session-1",
    user: {
      id: "user-1",
      username: "alice",
      role: "admin",
      status: "active",
      quota_bytes: 1024,
    },
    issuedAtMs: Date.now() - 100,
    expiresAtSeconds: Math.floor(Date.now() / 1000) + 60,
  });
  await invalidateAuthToken(env, token);

  const request = new Request("https://example.com/api/files", {
    headers: { Cookie: `flares3_session=${token}` },
  });
  await authSessionMiddleware(request, env);

  assert.equal(request.user, undefined);
});

test("worker logout clears cookie even when request is unauthenticated", async () => {
  const { db } = createDb({
    firstHandlers: [
      {
        match: /SELECT blocked_until FROM rate_limits WHERE ip = \?/,
        value: null,
      },
      {
        match: /SELECT id FROM users LIMIT 1/,
        value: "user-1",
      },
    ],
    runHandlers: [
      {
        match: /INSERT INTO rate_limits \(ip, request_count, window_start\)/,
        value: { meta: { changes: 1 } },
      },
    ],
  });
  const worker = loadWorkerEntrypoint();

  const response = await worker.fetch(
    new Request("https://example.com/api/auth/logout", {
      method: "POST",
    }),
    { DB: db },
    {},
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  const setCookie = response.headers.get("Set-Cookie") || "";
  assert.match(setCookie, /flares3_session=/);
  assert.match(setCookie, /Max-Age=0/);
  assert.match(setCookie, /HttpOnly/);
});
