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

const ADMIN_ACTOR = {
  id: "admin-1",
  username: "admin",
  role: "admin",
  status: "active",
  quota_bytes: 1024,
};

function createPatchRequest(url, body, actor = ADMIN_ACTOR) {
  const request = new Request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (actor) {
    request.user = actor;
  }
  return request;
}

function createDb({ firstHandlers = [], runHandlers = [] }) {
  const state = { runs: [] };

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
              __sql: sql,
              __args: args,
              async first() {
                return consume(firstHandlers, sql, args, "first");
              },
              async all() {
                throw new Error(`unexpected all SQL: ${sql}`);
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

test("updateUser 拒绝 admin 修改自己的 role（400 且不触 D1）", async () => {
  const { updateUser } = loadModule("routes/users.js");

  const response = await updateUser(
    createPatchRequest("https://example.com/api/users/admin-1", {
      role: "user",
    }),
    {
      DB: {
        prepare() {
          throw new Error("self role change should not touch D1");
        },
      },
    },
    "admin-1",
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "不能修改自己的角色或状态",
  });
});

test("updateUser 拒绝 admin 修改自己的 status（400 且不触 D1）", async () => {
  const { updateUser } = loadModule("routes/users.js");

  const response = await updateUser(
    createPatchRequest("https://example.com/api/users/admin-1", {
      status: "disabled",
    }),
    {
      DB: {
        prepare() {
          throw new Error("self status change should not touch D1");
        },
      },
    },
    "admin-1",
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "不能修改自己的角色或状态",
  });
});

test("updateUser 允许 admin 仅修改自己的 quota", async () => {
  const { updateUser } = loadModule("routes/users.js");
  const { db, state } = createDb({
    firstHandlers: [
      {
        match: /SELECT role, status FROM users WHERE id = \? LIMIT 1/,
        value: { role: "admin", status: "active" },
      },
    ],
    runHandlers: [
      { match: /UPDATE users SET /, value: { meta: { changes: 1 } } },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await updateUser(
    createPatchRequest("https://example.com/api/users/admin-1", {
      quota_bytes: 2048,
    }),
    { DB: db },
    "admin-1",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  const update = state.runs.find((entry) =>
    /UPDATE users SET /.test(entry.sql),
  );
  assert.ok(update, "应执行用户更新");
  assert.match(update.sql, /quota_bytes = \?/);
  assert.ok(
    !/role = \?|status = \?/.test(update.sql),
    "quota 自改不得触及 role/status",
  );
});

test("updateUser 修改他人的 role/status 维持现状（不受自我保护影响）", async () => {
  const { updateUser } = loadModule("routes/users.js");
  const { db, state } = createDb({
    firstHandlers: [
      {
        match: /SELECT role, status FROM users WHERE id = \? LIMIT 1/,
        value: { role: "user", status: "active" },
      },
    ],
    runHandlers: [
      { match: /UPDATE users SET /, value: { meta: { changes: 1 } } },
      {
        match: /UPDATE sessions SET revoked_at/,
        value: { meta: { changes: 1 } },
      },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await updateUser(
    createPatchRequest("https://example.com/api/users/user-1", {
      role: "user",
      status: "disabled",
    }),
    { DB: db },
    "user-1",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  assert.ok(
    state.runs.some((entry) => /UPDATE users SET /.test(entry.sql)),
    "应执行目标用户更新",
  );
});
