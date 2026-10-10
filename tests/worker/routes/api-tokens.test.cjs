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

function createTokenDb({
  firstHandlers = [],
  runHandlers = [],
  allHandlers = [],
}) {
  const state = { firsts: [], runs: [], alls: [], batches: [] };

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

  function createBoundStatement(sql, args) {
    return {
      __sql: sql,
      __args: args,
      async first() {
        state.firsts.push({ sql, args });
        return consume(firstHandlers, sql, args, "first");
      },
      async all() {
        state.alls.push({ sql, args });
        return consume(allHandlers, sql, args, "all");
      },
      async run() {
        state.runs.push({ sql, args });
        return consume(runHandlers, sql, args, "run");
      },
    };
  }

  return {
    state,
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            return createBoundStatement(sql, args);
          },
        };
      },
      async batch(statements) {
        state.batches.push(
          statements.map((statement) => ({
            sql: statement.__sql,
            args: statement.__args || [],
          })),
        );
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        return results;
      },
    },
  };
}

function createRejectingDb() {
  return {
    prepare() {
      throw new Error("handler should not touch D1 for this case");
    },
  };
}

const USER = {
  id: "user-1",
  username: "alice",
  role: "user",
  status: "active",
  quota_bytes: 1024,
};

function tokenRequest(
  url,
  { method = "GET", body, user = USER, authKind } = {},
) {
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const request = new Request(url, init);
  const extra = {};
  if (user) extra.user = user;
  if (authKind) extra.authKind = authKind;
  return Object.assign(request, extra);
}

function loadTokensRoute() {
  return loadModule("routes/apiTokens.js");
}

// ── listTokens ──

test("listTokens 未认证返回 401 且不触达 D1", async () => {
  const { listTokens } = loadTokensRoute();
  const response = await listTokens(
    tokenRequest("https://example.com/api/tokens", { user: null }),
    { DB: createRejectingDb() },
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "未授权" });
});

test("listTokens 以 PAT 访问返回 403（令牌自管理需会话登录）且不触达 D1", async () => {
  const { listTokens } = loadTokensRoute();
  const response = await listTokens(
    tokenRequest("https://example.com/api/tokens", { authKind: "pat" }),
    { DB: createRejectingDb() },
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "此操作需会话登录，不支持 API Token",
  });
});

test("listTokens 返回本人令牌元数据，查询限定 user_id 且不含 token_hash", async () => {
  const { listTokens } = loadTokensRoute();
  const { db, state } = createTokenDb({
    allHandlers: [
      {
        match: /FROM api_tokens\s+WHERE user_id = \?/,
        value: {
          results: [
            {
              id: "tok-1",
              name: "CI",
              created_at: "2026-10-01T00:00:00.000Z",
              last_used_at: null,
              expires_at: null,
              revoked_at: null,
            },
          ],
        },
      },
    ],
  });

  const response = await listTokens(
    tokenRequest("https://example.com/api/tokens"),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.tokens.length, 1);
  assert.equal(payload.tokens[0].status, "active");
  assert.ok(!("token_hash" in payload.tokens[0]));
  assert.ok(!("token" in payload.tokens[0]));
  assert.equal(state.alls[0].args[0], "user-1");
});

// ── createToken ──

test("createToken 未认证返回 401；以 PAT 访问返回 403；均不触达 D1", async () => {
  const { createToken } = loadTokensRoute();

  const unauth = await createToken(
    tokenRequest("https://example.com/api/tokens", {
      method: "POST",
      user: null,
      body: { name: "x" },
    }),
    { DB: createRejectingDb() },
  );
  assert.equal(unauth.status, 401);

  const pat = await createToken(
    tokenRequest("https://example.com/api/tokens", {
      method: "POST",
      authKind: "pat",
      body: { name: "x" },
    }),
    { DB: createRejectingDb() },
  );
  assert.equal(pat.status, 403);
  assert.deepEqual(await pat.json(), {
    error: "此操作需会话登录，不支持 API Token",
  });
});

test("createToken 名称为空 / 超长返回 400 且不写 batch", async () => {
  const { createToken } = loadTokensRoute();

  const { db: emptyDb, state: emptyState } = createTokenDb({});
  const empty = await createToken(
    tokenRequest("https://example.com/api/tokens", {
      method: "POST",
      body: { name: "   " },
    }),
    { DB: emptyDb },
  );
  assert.equal(empty.status, 400);
  assert.deepEqual(await empty.json(), { error: "请填写令牌名称" });
  assert.equal(emptyState.batches.length, 0);

  const { db: longDb, state: longState } = createTokenDb({});
  const long = await createToken(
    tokenRequest("https://example.com/api/tokens", {
      method: "POST",
      body: { name: "n".repeat(101) },
    }),
    { DB: longDb },
  );
  assert.equal(long.status, 400);
  assert.equal(longState.batches.length, 0);
});

test("createToken 成功：一次性明文返回，库内只存 token_hash，插入与 TOKEN_CREATE 审计同 batch", async () => {
  const { createToken } = loadTokensRoute();
  const { hashToken } = loadModule("utils/token.js");

  const { db, state } = createTokenDb({
    runHandlers: [
      {
        match: /INSERT INTO api_tokens/,
        value: { meta: { changes: 1 } },
      },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await createToken(
    tokenRequest("https://example.com/api/tokens", {
      method: "POST",
      body: { name: "CI 部署", expires_in: 30 },
    }),
    { DB: db },
  );

  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.match(payload.token, /^fla_[0-9a-f]{64}$/, "响应须含一次性明文");
  assert.equal(payload.name, "CI 部署");
  assert.ok(payload.id);
  assert.ok(!Number.isNaN(Date.parse(payload.created_at)));
  assert.ok(
    !Number.isNaN(Date.parse(payload.expires_at)),
    "expires_in>0 应有到期",
  );

  // 单 batch：INSERT api_tokens + 审计
  assert.equal(state.batches.length, 1);
  assert.equal(state.batches[0].length, 2);

  const insert = state.batches[0][0];
  assert.match(insert.sql, /INSERT INTO api_tokens/);
  assert.equal(insert.args[1], "user-1", "owner 应为当前用户");
  assert.equal(insert.args[2], "CI 部署");
  // 第 4 个参数是 token_hash：必须等于明文的 SHA-256，且绝不等于明文本身
  const expectedHash = await hashToken(payload.token);
  assert.equal(insert.args[3], expectedHash, "库内只存 token_hash");
  assert.notEqual(insert.args[3], payload.token, "绝不落库明文");

  const audit = state.batches[0][1];
  assert.match(audit.sql, /INSERT INTO audit_logs/);
  assert.equal(audit.args[1], "user-1", "审计 actor 为当前用户");
  assert.equal(audit.args[2], "TOKEN_CREATE");
});

test("createToken 省略 expires_in 时永不过期（expires_at 入库为 null）", async () => {
  const { createToken } = loadTokensRoute();
  const { db, state } = createTokenDb({
    runHandlers: [
      { match: /INSERT INTO api_tokens/, value: { meta: { changes: 1 } } },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await createToken(
    tokenRequest("https://example.com/api/tokens", {
      method: "POST",
      body: { name: "forever" },
    }),
    { DB: db },
  );

  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.expires_at, null);
  assert.equal(state.batches[0][0].args[5], null, "expires_at 入库应为 null");
});

// ── revokeToken ──

test("revokeToken 未认证返回 401；以 PAT 访问返回 403；均不触达 D1", async () => {
  const { revokeToken } = loadTokensRoute();

  const unauth = await revokeToken(
    tokenRequest("https://example.com/api/tokens/tok-1", {
      method: "DELETE",
      user: null,
    }),
    { DB: createRejectingDb() },
    "tok-1",
  );
  assert.equal(unauth.status, 401);

  const pat = await revokeToken(
    tokenRequest("https://example.com/api/tokens/tok-1", {
      method: "DELETE",
      authKind: "pat",
    }),
    { DB: createRejectingDb() },
    "tok-1",
  );
  assert.equal(pat.status, 403);
  assert.deepEqual(await pat.json(), {
    error: "此操作需会话登录，不支持 API Token",
  });
});

test("revokeToken 不存在 / 非本人 / 已吊销统一 404 且不写 batch", async () => {
  const { revokeToken } = loadTokensRoute();
  const { db, state } = createTokenDb({
    firstHandlers: [
      {
        match:
          /SELECT id FROM api_tokens WHERE id = \? AND user_id = \? AND revoked_at IS NULL LIMIT 1/,
        value: null,
      },
    ],
  });

  const response = await revokeToken(
    tokenRequest("https://example.com/api/tokens/tok-x", { method: "DELETE" }),
    { DB: db },
    "tok-x",
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "令牌不存在" });
  // 守卫查询必须带 user_id（防越权吊销）
  assert.deepEqual(state.firsts[0].args, ["tok-x", "user-1"]);
  assert.equal(state.batches.length, 0);
});

test("revokeToken 成功：所有权守卫后，UPDATE revoked_at 与 TOKEN_REVOKE 审计同 batch", async () => {
  const { revokeToken } = loadTokensRoute();
  const { db, state } = createTokenDb({
    firstHandlers: [
      {
        match:
          /SELECT id FROM api_tokens WHERE id = \? AND user_id = \? AND revoked_at IS NULL LIMIT 1/,
        value: { id: "tok-1" },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE api_tokens SET revoked_at = \? WHERE id = \? AND user_id = \?/,
        value: { meta: { changes: 1 } },
      },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await revokeToken(
    tokenRequest("https://example.com/api/tokens/tok-1", { method: "DELETE" }),
    { DB: db },
    "tok-1",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });

  assert.equal(state.batches.length, 1);
  const [update, audit] = state.batches[0];
  assert.match(update.sql, /^UPDATE api_tokens SET revoked_at/);
  assert.match(update.sql, /AND user_id = \?/);
  assert.equal(update.args[1], "tok-1");
  assert.equal(update.args[2], "user-1");
  assert.match(audit.sql, /INSERT INTO audit_logs/);
  assert.equal(audit.args[2], "TOKEN_REVOKE");
});
