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

/**
 * 可配置 mock D1：按 SQL 片段路由 .first()/.all()/.run() 返回值，
 * 并记录每条查询的 sql/args，供 token_hash 命中与列裁剪断言。
 */
function createTokenDb({
  firstHandlers = [],
  runHandlers = [],
  allHandlers = [],
}) {
  const state = { firsts: [], runs: [], alls: [] };

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
    },
  };
}

function activeRow(overrides = {}) {
  return {
    token_id: "tok-1",
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    user_id: "user-1",
    username: "alice",
    role: "user",
    status: "active",
    quota_bytes: 2048,
    ...overrides,
  };
}

test("isApiToken 仅认 fla_ 前缀", () => {
  const { isApiToken } = loadModule("services/apiTokens.js");
  assert.equal(isApiToken("fla_abc"), true);
  assert.equal(isApiToken("sess_abc"), false);
  assert.equal(isApiToken(""), false);
  assert.equal(isApiToken(undefined), false);
});

test("generateApiToken：fla_ 前缀 + 64 hex 随机，且逐次唯一", () => {
  const { generateApiToken, API_TOKEN_PREFIX } = loadModule(
    "services/apiTokens.js",
  );
  const a = generateApiToken();
  const b = generateApiToken();
  assert.ok(a.startsWith(API_TOKEN_PREFIX));
  assert.match(a, /^fla_[0-9a-f]{64}$/);
  assert.notEqual(a, b, "每次生成的明文必须唯一");
});

test("resolveExpiresAt：<=0 / 非法 → null；正数 → ISO；上限 365 天截断", () => {
  const { resolveExpiresAt, MAX_API_TOKEN_EXPIRES_IN_DAYS } = loadModule(
    "services/apiTokens.js",
  );
  const now = new Date("2026-01-01T00:00:00.000Z");

  assert.equal(resolveExpiresAt(0, now), null);
  assert.equal(resolveExpiresAt(-5, now), null);
  assert.equal(resolveExpiresAt("abc", now), null);
  assert.equal(resolveExpiresAt(undefined, now), null);

  assert.equal(
    resolveExpiresAt(1, now),
    new Date("2026-01-02T00:00:00.000Z").toISOString(),
  );

  const capped = resolveExpiresAt(100000, now);
  const expected = new Date(
    now.getTime() + MAX_API_TOKEN_EXPIRES_IN_DAYS * 86400000,
  ).toISOString();
  assert.equal(capped, expected, "超过上限按 365 天封顶");
});

test("validateApiToken：命中活跃用户按 token_hash 查询并装载 user，命中后写 last_used_at", async () => {
  const { validateApiToken } = loadModule("services/apiTokens.js");
  const { hashToken } = loadModule("utils/token.js");

  const token = "fla_" + "a".repeat(64);
  const expectedHash = await hashToken(token);

  const { db, state } = createTokenDb({
    firstHandlers: [
      {
        match: /FROM api_tokens t\s+INNER JOIN users u/,
        value: activeRow({ role: "admin", quota_bytes: 4096 }),
      },
    ],
    runHandlers: [
      {
        match: /UPDATE api_tokens SET last_used_at = \? WHERE id = \?/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const result = await validateApiToken({ DB: db }, token);

  assert.ok(result, "活跃令牌应校验通过");
  assert.equal(result.tokenId, "tok-1");
  assert.deepEqual(result.user, {
    id: "user-1",
    username: "alice",
    role: "admin",
    status: "active",
    quota_bytes: 4096,
  });

  // 必须按 SHA-256 token_hash 命中，而非明文
  assert.equal(state.firsts[0].args[0], expectedHash);
  assert.notEqual(state.firsts[0].args[0], token, "绝不以明文查询");

  // last_used_at 为 null（从未使用）时命中应写入一次（节流不拦截首次）
  assert.equal(state.runs.length, 1, "首次使用应记录 last_used_at");
  assert.equal(state.runs[0].args[1], "tok-1");
  assert.ok(!Number.isNaN(Date.parse(state.runs[0].args[0])));
});

test("validateApiToken：角色继承——admin 保持，其它一律降级为 user", async () => {
  const { validateApiToken } = loadModule("services/apiTokens.js");
  const recentlyUsed = new Date().toISOString();

  for (const [dbRole, expected] of [
    ["admin", "admin"],
    ["user", "user"],
    ["weird", "user"],
  ]) {
    const { db, state } = createTokenDb({
      firstHandlers: [
        {
          match: /FROM api_tokens t/,
          value: activeRow({ role: dbRole, last_used_at: recentlyUsed }),
        },
      ],
    });
    const result = await validateApiToken({ DB: db }, "fla_role");
    assert.equal(result.user.role, expected);
    // 刚使用过（<60s）时节流跳过写入
    assert.equal(state.runs.length, 0, "节流窗口内不得写 last_used_at");
  }
});

test("validateApiToken：已吊销 → null（鉴权回退，不装载用户）", async () => {
  const { validateApiToken } = loadModule("services/apiTokens.js");
  const { db, state } = createTokenDb({
    firstHandlers: [
      {
        match: /FROM api_tokens t/,
        value: activeRow({ revoked_at: "2026-01-01T00:00:00.000Z" }),
      },
    ],
  });
  assert.equal(await validateApiToken({ DB: db }, "fla_revoked"), null);
  assert.equal(state.runs.length, 0, "吊销令牌不得写 last_used_at");
});

test("validateApiToken：已过期 → null", async () => {
  const { validateApiToken } = loadModule("services/apiTokens.js");
  const { db } = createTokenDb({
    firstHandlers: [
      {
        match: /FROM api_tokens t/,
        value: activeRow({ expires_at: "2000-01-01T00:00:00.000Z" }),
      },
    ],
  });
  assert.equal(await validateApiToken({ DB: db }, "fla_expired"), null);
});

test("validateApiToken：关联用户非 active → null（随用户停用即时失效）", async () => {
  const { validateApiToken } = loadModule("services/apiTokens.js");
  const { db } = createTokenDb({
    firstHandlers: [
      { match: /FROM api_tokens t/, value: activeRow({ status: "disabled" }) },
    ],
  });
  assert.equal(await validateApiToken({ DB: db }, "fla_disabled"), null);
});

test("validateApiToken：未命中 → null", async () => {
  const { validateApiToken } = loadModule("services/apiTokens.js");
  const { db } = createTokenDb({
    firstHandlers: [{ match: /FROM api_tokens t/, value: null }],
  });
  assert.equal(await validateApiToken({ DB: db }, "fla_missing"), null);
});

test("validateApiToken：非 fla_ 前缀直接 null，不查库", async () => {
  const { validateApiToken } = loadModule("services/apiTokens.js");
  const { db, state } = createTokenDb({});
  assert.equal(await validateApiToken({ DB: db }, "sess-abc"), null);
  assert.equal(state.firsts.length, 0, "非 PAT 不触达 api_tokens 查询");
});

test("listApiTokens：按 user_id 倒序列出并派生 status，绝不含明文 / token_hash", async () => {
  const { listApiTokens } = loadModule("services/apiTokens.js");
  const { db, state } = createTokenDb({
    allHandlers: [
      {
        match:
          /SELECT id, name, created_at, last_used_at, expires_at, revoked_at\s+FROM api_tokens/,
        value: {
          results: [
            {
              id: "a",
              name: "active-tok",
              created_at: "2026-01-03T00:00:00.000Z",
              last_used_at: null,
              expires_at: null,
              revoked_at: null,
            },
            {
              id: "b",
              name: "expired-tok",
              created_at: "2026-01-02T00:00:00.000Z",
              last_used_at: null,
              expires_at: "2000-01-01T00:00:00.000Z",
              revoked_at: null,
            },
            {
              id: "c",
              name: "revoked-tok",
              created_at: "2026-01-01T00:00:00.000Z",
              last_used_at: null,
              expires_at: null,
              revoked_at: "2026-01-05T00:00:00.000Z",
            },
          ],
        },
      },
    ],
  });

  const list = await listApiTokens({ DB: db }, "user-1");

  assert.equal(list.length, 3);
  assert.equal(list[0].status, "active");
  assert.equal(list[1].status, "expired");
  assert.equal(list[2].status, "revoked");

  for (const item of list) {
    assert.ok(!("token_hash" in item), "列表项不得泄露 token_hash");
    assert.ok(!("token" in item), "列表项不得泄露明文");
  }

  // SELECT 列清单不得含 token_hash，且必须限定 user_id
  assert.ok(!/token_hash/.test(state.alls[0].sql), "查询列不得含 token_hash");
  assert.match(state.alls[0].sql, /WHERE user_id = \?/);
  assert.equal(state.alls[0].args[0], "user-1");
});
