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

function createChangePasswordDb({ firstHandlers = [], runHandlers = [] }) {
  const state = { firsts: [], runs: [], batches: [] };

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
      throw new Error("change-password should not touch D1 for this case");
    },
  };
}

function createChangePasswordRequest(body, { user } = {}) {
  const request = new Request("https://example.com/api/auth/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (user) {
    return Object.assign(request, { user });
  }
  return request;
}

const authedUser = {
  id: "user-1",
  role: "user",
  username: "alice",
  status: "active",
  quota_bytes: 1024,
};

const CURRENT_PASSWORD = "current-password-123";
const NEW_PASSWORD = "new-password-456";

function loadChangePassword() {
  const { changePassword } = loadModule("routes/auth.js");
  return changePassword;
}

test("change-password 成功：hash 更新与 sessions 删除进同一 batch", async () => {
  const { hashPassword, verifyPassword } = loadModule("services/password.js");
  const changePassword = loadChangePassword();

  const { db, state } = createChangePasswordDb({
    firstHandlers: [
      {
        match: /SELECT id, password_hash FROM users WHERE id = \? LIMIT 1/,
        value: { id: "user-1", password_hash: hashPassword(CURRENT_PASSWORD) },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE users SET password_hash = \?, updated_at = \? WHERE id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /DELETE FROM sessions WHERE user_id = \?/,
        value: { meta: { changes: 3 } },
      },
      {
        match: /INSERT INTO audit_logs/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await changePassword(
    createChangePasswordRequest(
      { current_password: CURRENT_PASSWORD, new_password: NEW_PASSWORD },
      { user: authedUser },
    ),
    { DB: db },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true });

  assert.equal(state.batches.length, 1, "写路径必须只执行一次 batch");
  const statements = state.batches[0];
  assert.equal(
    statements.length,
    3,
    "batch 必须恰好包含三条语句（密码更新、会话删除、审计）",
  );

  assert.match(
    statements[0].sql,
    /UPDATE users SET password_hash = \?, updated_at = \? WHERE id = \?/,
  );
  assert.equal(
    verifyPassword(NEW_PASSWORD, statements[0].args[0]),
    true,
    "写入的必须是新密码的 bcrypt 哈希",
  );
  assert.equal(statements[0].args[2], "user-1");
  assert.ok(
    !Number.isNaN(Date.parse(statements[0].args[1])),
    "updated_at 应为可解析的 ISO 时间",
  );

  assert.match(statements[1].sql, /DELETE FROM sessions WHERE user_id = \?/);
  assert.equal(statements[1].args[0], "user-1");

  assert.match(
    statements[2].sql,
    /INSERT INTO audit_logs/,
    "改密审计必须与状态切换进同一 batch",
  );
  assert.equal(statements[2].args[1], "user-1", "audit actor 应为当前用户");
  assert.equal(statements[2].args[2], "USER_CHANGE_PASSWORD");
  assert.equal(statements[2].args[4], "user-1", "audit target 应为当前用户");
});

test("change-password 未认证返回 401 且不触达 D1", async () => {
  const changePassword = loadChangePassword();

  const response = await changePassword(
    createChangePasswordRequest({
      current_password: CURRENT_PASSWORD,
      new_password: NEW_PASSWORD,
    }),
    { DB: createRejectingDb() },
  );
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(payload, { error: "未授权" });
});

test("change-password 当前密码不正确返回 400 且不执行写 batch", async () => {
  const { hashPassword } = loadModule("services/password.js");
  const changePassword = loadChangePassword();

  const { db, state } = createChangePasswordDb({
    firstHandlers: [
      {
        match: /SELECT id, password_hash FROM users WHERE id = \? LIMIT 1/,
        value: { id: "user-1", password_hash: hashPassword(CURRENT_PASSWORD) },
      },
    ],
    runHandlers: [
      {
        match: /UPDATE users SET password_hash/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /DELETE FROM sessions WHERE user_id = \?/,
        value: { meta: { changes: 0 } },
      },
    ],
  });

  const response = await changePassword(
    createChangePasswordRequest(
      { current_password: "totally-wrong-pass", new_password: NEW_PASSWORD },
      { user: authedUser },
    ),
    { DB: db },
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, { error: "当前密码不正确" });
  assert.equal(state.batches.length, 0, "密码校验失败不得执行写 batch");
});

test("change-password 新密码不足 8 位返回 400 且不触达 D1", async () => {
  const changePassword = loadChangePassword();

  const response = await changePassword(
    createChangePasswordRequest(
      { current_password: CURRENT_PASSWORD, new_password: "short" },
      { user: authedUser },
    ),
    { DB: createRejectingDb() },
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, { error: "新密码至少 8 位" });
});

test("change-password 新旧密码相同返回 400 且不触达 D1", async () => {
  const changePassword = loadChangePassword();

  const response = await changePassword(
    createChangePasswordRequest(
      { current_password: CURRENT_PASSWORD, new_password: CURRENT_PASSWORD },
      { user: authedUser },
    ),
    { DB: createRejectingDb() },
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, { error: "新密码不能与当前密码相同" });
});

test("change-password 缺少字段返回 400 且不触达 D1", async () => {
  const changePassword = loadChangePassword();

  const response = await changePassword(
    createChangePasswordRequest(
      { current_password: CURRENT_PASSWORD },
      {
        user: authedUser,
      },
    ),
    { DB: createRejectingDb() },
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(payload, { error: "请填写当前密码和新密码" });
});
