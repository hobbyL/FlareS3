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
 * mock D1：按 SQL 片段路由 .first()/.run()，并记录命中的 SQL，
 * 供「PAT 不查 sessions 表」等断言。未匹配的 SQL 抛错以暴露越权查询。
 */
function createDb({ firstHandlers = [], runHandlers = [] }) {
  const state = { firsts: [], runs: [] };

  function consume(list, sql, args, kind) {
    const index = list.findIndex((handler) => handler.match.test(sql));
    if (index === -1) {
      throw new Error(`unexpected ${kind} SQL: ${sql}`);
    }
    const [handler] = list.splice(index, 1);
    return typeof handler.value === "function"
      ? handler.value(args)
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
                state.firsts.push({ sql, args });
                return consume(firstHandlers, sql, args, "first");
              },
              async run() {
                state.runs.push({ sql, args });
                return consume(runHandlers, sql, args, "run");
              },
            };
          },
        };
      },
    },
  };
}

function bearer(token) {
  return new Request("https://example.com/api/files", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// 每个用例用唯一 PAT，规避 authSession 的 token_hash 会话缓存串扰。
let seq = 0;
function uniqueToken(prefix) {
  seq += 1;
  return `${prefix}${seq}${"a".repeat(63)}`;
}

const PAT_ROW = {
  token_id: "tok-1",
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  user_id: "user-1",
  username: "alice",
  role: "user",
  status: "active",
  quota_bytes: 2048,
};

test("有效 PAT：装载 user 并标记 authKind='pat'，不设 sessionId，且不查 sessions 表", async () => {
  const { authSessionMiddleware } = loadModule("middleware/authSession.js");
  const { db, state } = createDb({
    firstHandlers: [{ match: /FROM api_tokens t/, value: { ...PAT_ROW } }],
    runHandlers: [{ match: /UPDATE api_tokens SET last_used_at/, value: {} }],
  });

  const request = bearer(uniqueToken("fla_"));
  const result = await authSessionMiddleware(request, { DB: db });

  assert.equal(result, undefined, "命中应放行（返回 undefined）");
  assert.ok(request.user, "应装载 user → 业务端点可用");
  assert.equal(request.user.id, "user-1");
  assert.equal(request.authKind, "pat");
  assert.equal(request.sessionId, undefined, "PAT 不属于任何会话");
  assert.ok(
    !state.firsts.some((entry) => /FROM sessions/.test(entry.sql)),
    "PAT 分支置于 opaque 查询之前，不得查 sessions 表",
  );
});

test("已吊销 PAT：不装载用户（withAuth 将判 401）", async () => {
  const { authSessionMiddleware } = loadModule("middleware/authSession.js");
  const { db } = createDb({
    firstHandlers: [
      {
        match: /FROM api_tokens t/,
        value: { ...PAT_ROW, revoked_at: "2026-01-01T00:00:00.000Z" },
      },
    ],
  });

  const request = bearer(uniqueToken("fla_"));
  await authSessionMiddleware(request, { DB: db });
  assert.equal(request.user, undefined);
  assert.equal(request.authKind, undefined);
});

test("已过期 PAT：不装载用户", async () => {
  const { authSessionMiddleware } = loadModule("middleware/authSession.js");
  const { db } = createDb({
    firstHandlers: [
      {
        match: /FROM api_tokens t/,
        value: { ...PAT_ROW, expires_at: "2000-01-01T00:00:00.000Z" },
      },
    ],
  });

  const request = bearer(uniqueToken("fla_"));
  await authSessionMiddleware(request, { DB: db });
  assert.equal(request.user, undefined);
});

test("关联用户停用的 PAT：不装载用户", async () => {
  const { authSessionMiddleware } = loadModule("middleware/authSession.js");
  const { db } = createDb({
    firstHandlers: [
      { match: /FROM api_tokens t/, value: { ...PAT_ROW, status: "disabled" } },
    ],
  });

  const request = bearer(uniqueToken("fla_"));
  await authSessionMiddleware(request, { DB: db });
  assert.equal(request.user, undefined);
});

test("未知 PAT：不装载用户，且 PAT 分支命中后不回落 sessions 查询", async () => {
  const { authSessionMiddleware } = loadModule("middleware/authSession.js");
  const { db, state } = createDb({
    firstHandlers: [{ match: /FROM api_tokens t/, value: null }],
  });

  const request = bearer(uniqueToken("fla_"));
  await authSessionMiddleware(request, { DB: db });
  assert.equal(request.user, undefined);
  assert.ok(
    !state.firsts.some((entry) => /FROM sessions/.test(entry.sql)),
    "fla_ 前缀即使未命中也不应再查 sessions",
  );
});

test("零回归：非 PAT 的 opaque session 令牌仍走 sessions 查询并标记 authKind='session'", async () => {
  const { authSessionMiddleware } = loadModule("middleware/authSession.js");
  const { db, state } = createDb({
    firstHandlers: [
      {
        match: /FROM sessions s/,
        value: {
          session_id: "sess-1",
          expires_at: "2099-01-01T00:00:00.000Z",
          revoked_at: null,
          user_id: "user-9",
          username: "bob",
          role: "user",
          status: "active",
          quota_bytes: 4096,
        },
      },
    ],
  });

  const request = bearer(uniqueToken("opaque-"));
  const result = await authSessionMiddleware(request, { DB: db });

  assert.equal(result, undefined);
  assert.ok(request.user);
  assert.equal(request.user.id, "user-9");
  assert.equal(request.sessionId, "sess-1");
  assert.equal(request.authKind, "session");
  assert.ok(
    !state.firsts.some((entry) => /FROM api_tokens/.test(entry.sql)),
    "非 fla_ 令牌不应查 api_tokens 表",
  );
});
