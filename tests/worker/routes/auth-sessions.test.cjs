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

function createLifecycleDb({
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
      async first(columnName) {
        state.firsts.push({ sql, args, columnName });
        const value = consume(firstHandlers, sql, args, "first");
        if (
          columnName &&
          value &&
          typeof value === "object" &&
          columnName in value
        ) {
          return value[columnName];
        }
        return value;
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

const USER = { id: "user-1", role: "user", username: "alice" };

function authedRequest(url, { method = "GET", sessionId } = {}) {
  return Object.assign(new Request(url, { method }), {
    user: USER,
    sessionId: sessionId || "session-current",
  });
}

function loadAuthRoute() {
  return loadModule("routes/auth.js");
}

test("listSessions returns own active sessions with is_current and no token_hash", async () => {
  const auth = loadAuthRoute();
  const { db, state } = createLifecycleDb({
    allHandlers: [
      {
        match:
          /SELECT id, ip, user_agent, created_at, expires_at\s+FROM sessions/,
        value: {
          results: [
            {
              id: "session-current",
              ip: "203.0.113.10",
              user_agent: "Mozilla/5.0",
              created_at: "2026-10-09T01:00:00.000Z",
              expires_at: "2026-10-09T09:00:00.000Z",
            },
            {
              id: "session-other",
              ip: "198.51.100.7",
              user_agent: "curl/8.0",
              created_at: "2026-10-09T00:00:00.000Z",
              expires_at: "2026-10-09T08:00:00.000Z",
            },
          ],
        },
      },
    ],
  });

  const response = await auth.listSessions(
    authedRequest("https://example.com/api/auth/sessions"),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.sessions.length, 2);
  assert.equal(payload.sessions[0].is_current, 1);
  assert.equal(payload.sessions[1].is_current, 0);
  assert.ok(!("token_hash" in payload.sessions[0]), "不得泄露 token_hash");

  const listSql = state.alls[0].sql;
  assert.ok(!/token_hash/.test(listSql), "SELECT 列清单不得包含 token_hash");
  assert.match(listSql, /user_id = \?/);
  assert.match(listSql, /revoked_at IS NULL/);
  assert.match(listSql, /expires_at > \?/);
  assert.equal(state.alls[0].args[0], "user-1");
  assert.equal(state.alls[0].args[2], 50, "LIMIT 上限 50 生效");
});

test("revokeSession guards ownership then batches UPDATE with audit", async () => {
  const auth = loadAuthRoute();
  const { db, state } = createLifecycleDb({
    firstHandlers: [
      {
        match:
          /SELECT id FROM sessions WHERE id = \? AND user_id = \? AND revoked_at IS NULL LIMIT 1/,
        value: { id: "session-victim" },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE sessions SET revoked_at = \? WHERE id = \? AND user_id = \?/,
        value: { meta: { changes: 1 } },
      },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await auth.revokeSession(
    authedRequest("https://example.com/api/auth/sessions/session-victim", {
      method: "DELETE",
    }),
    { DB: db },
    "session-victim",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  // 守卫查询必须带 user_id 条件（防越权）
  assert.deepEqual(state.firsts[0].args, ["session-victim", "user-1"]);
  // 状态切换与审计同 batch：UPDATE 在前、audit 在后
  assert.equal(state.batches.length, 1);
  assert.match(state.batches[0][0].sql, /^UPDATE sessions SET revoked_at/);
  assert.match(state.batches[0][0].sql, /AND user_id = \?/);
  assert.deepEqual(state.batches[0][0].args[1], "session-victim");
  assert.deepEqual(state.batches[0][0].args[2], "user-1");
  assert.match(state.batches[0][1].sql, /INSERT INTO audit_logs/);
});

test("revokeSession returns 404 uniformly for missing / foreign / revoked sessions", async () => {
  const auth = loadAuthRoute();
  // 不存在、他人会话、已撤销三种情况守卫均不命中 → 同文案 404（不泄露区分）
  for (const value of [null, null, null]) {
    const { db } = createLifecycleDb({
      firstHandlers: [
        {
          match:
            /SELECT id FROM sessions WHERE id = \? AND user_id = \? AND revoked_at IS NULL LIMIT 1/,
          value,
        },
      ],
    });

    const response = await auth.revokeSession(
      authedRequest("https://example.com/api/auth/sessions/session-x", {
        method: "DELETE",
      }),
      { DB: db },
      "session-x",
    );

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "会话不存在" });
  }
});

test("revokeOtherSessions excludes current session and invalidates each revoked id", async () => {
  const auth = loadAuthRoute();
  const { db, state } = createLifecycleDb({
    allHandlers: [
      {
        match:
          /SELECT id FROM sessions\s+WHERE user_id = \? AND revoked_at IS NULL AND id != \?/,
        value: { results: [{ id: "session-a" }, { id: "session-b" }] },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE sessions SET revoked_at = \?\s+WHERE user_id = \? AND id IN \(/,
        value: { meta: { changes: 2 } },
      },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await auth.revokeOtherSessions(
    authedRequest("https://example.com/api/auth/sessions/revoke-others", {
      method: "POST",
      sessionId: "session-current",
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.revoked, 2);

  // 分页 SELECT：排除当前会话 + LIMIT 上限
  assert.deepEqual(state.alls[0].args[0], "user-1");
  assert.deepEqual(state.alls[0].args[1], "session-current");
  assert.equal(state.alls[0].args[2], 50);
  // UPDATE：id IN 仅含被撤会话，当前会话不在集合内
  assert.match(state.batches[0][0].sql, /id IN \(\?,\?\)/);
  assert.deepEqual(state.batches[0][0].args.slice(2), [
    "session-a",
    "session-b",
  ]);
  // 该轮审计与 UPDATE 同 batch（d1-write-consistency）
  assert.equal(state.batches.length, 1);
  assert.match(state.batches[0][1].sql, /INSERT INTO audit_logs/);
});

test("revokeOtherSessions with no other sessions returns revoked 0 without audit", async () => {
  const auth = loadAuthRoute();
  const { db, state } = createLifecycleDb({
    allHandlers: [
      {
        match:
          /SELECT id FROM sessions\s+WHERE user_id = \? AND revoked_at IS NULL AND id != \?/,
        value: { results: [] },
      },
    ],
  });

  const response = await auth.revokeOtherSessions(
    authedRequest("https://example.com/api/auth/sessions/revoke-others", {
      method: "POST",
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, revoked: 0 });
  // 空集早退：无状态变化不写 audit
  assert.equal(state.batches.length, 0);
  assert.ok(
    !state.runs.some((entry) => /INSERT INTO audit_logs/.test(entry.sql)),
  );
});

test("revokeOtherSessions without a resolvable current session returns 400", async () => {
  const auth = loadAuthRoute();
  const { db, state } = createLifecycleDb({});

  const response = await auth.revokeOtherSessions(
    Object.assign(
      new Request("https://example.com/api/auth/sessions/revoke-others", {
        method: "POST",
      }),
      {
        user: USER,
        sessionId: undefined,
      },
    ),
    { DB: db },
  );

  assert.equal(response.status, 400);
  assert.equal(state.alls.length, 0, "防御分支不得触达 D1");
});
