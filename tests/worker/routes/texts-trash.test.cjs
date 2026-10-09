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

function clearModule(relativePath) {
  delete require.cache[compiledPath(relativePath)];
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

function authedRequest(url, { method = "GET", user } = {}) {
  return Object.assign(new Request(url, { method }), {
    user: user || { id: "user-1", role: "user", username: "alice" },
  });
}

function loadTextsRoute() {
  clearModule("routes/texts.js");
  return loadModule("routes/texts.js");
}

const TRASH_FIRST = {
  match:
    /SELECT id, owner_id FROM texts WHERE id = \? AND deleted_at IS NOT NULL LIMIT 1/,
  value: { id: "text-1", owner_id: "user-1" },
};

const PERMANENT_BATCH_RUN_HANDLERS = [
  {
    match: /DELETE FROM text_shares WHERE text_id = \?/,
    value: { meta: { changes: 1 } },
  },
  {
    match: /DELETE FROM text_one_time_shares WHERE text_id = \?/,
    value: { meta: { changes: 0 } },
  },
  { match: /DELETE FROM texts WHERE id = \?/, value: { meta: { changes: 1 } } },
  { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
];

test("restoreText clears deleted_at and writes TEXT_RESTORE audit", async () => {
  const texts = loadTextsRoute();
  const { db, state } = createLifecycleDb({
    firstHandlers: [TRASH_FIRST],
    runHandlers: [
      {
        match: /UPDATE texts SET deleted_at = NULL/,
        value: { meta: { changes: 1 } },
      },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await texts.restoreText(
    authedRequest("https://example.com/api/texts/text-1/restore", {
      method: "POST",
    }),
    { DB: db },
    "text-1",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  const restoreRun = state.runs.find((entry) =>
    /UPDATE texts SET deleted_at = NULL/.test(entry.sql),
  );
  assert.ok(restoreRun, "恢复语句应执行");
  assert.deepEqual(restoreRun.args, [restoreRun.args[0], "text-1"]);
  const auditRun = state.runs.find((entry) =>
    /INSERT INTO audit_logs/.test(entry.sql),
  );
  assert.ok(auditRun, "TEXT_RESTORE 审计应落库");
});

test("restoreText returns 400 when the text is not in trash", async () => {
  const texts = loadTextsRoute();
  const { db } = createLifecycleDb({
    firstHandlers: [
      {
        match:
          /SELECT id, owner_id FROM texts WHERE id = \? AND deleted_at IS NOT NULL LIMIT 1/,
        value: null,
      },
    ],
  });

  const response = await texts.restoreText(
    authedRequest("https://example.com/api/texts/text-1/restore", {
      method: "POST",
    }),
    { DB: db },
    "text-1",
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "文本不存在" });
});

test("restoreText returns 403 for another owner's text", async () => {
  const texts = loadTextsRoute();
  const { db } = createLifecycleDb({
    firstHandlers: [
      {
        match:
          /SELECT id, owner_id FROM texts WHERE id = \? AND deleted_at IS NOT NULL LIMIT 1/,
        value: { id: "text-1", owner_id: "someone-else" },
      },
    ],
  });

  const response = await texts.restoreText(
    authedRequest("https://example.com/api/texts/text-1/restore", {
      method: "POST",
    }),
    { DB: db },
    "text-1",
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "无权限" });
});

test("permanentlyDeleteText cascades shares in one batch with audit", async () => {
  const texts = loadTextsRoute();
  const { db, state } = createLifecycleDb({
    firstHandlers: [TRASH_FIRST],
    runHandlers: PERMANENT_BATCH_RUN_HANDLERS,
  });

  const response = await texts.permanentlyDeleteText(
    authedRequest("https://example.com/api/texts/text-1/permanent", {
      method: "DELETE",
    }),
    { DB: db },
    "text-1",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  // 单 batch 内语句顺序：text_shares → text_one_time_shares → texts → audit
  assert.equal(state.batches.length, 1);
  assert.deepEqual(
    state.batches[0].map((statement) => statement.sql).slice(0, 3),
    [
      "DELETE FROM text_shares WHERE text_id = ?",
      "DELETE FROM text_one_time_shares WHERE text_id = ?",
      "DELETE FROM texts WHERE id = ?",
    ],
  );
  assert.match(state.batches[0][3].sql, /INSERT INTO audit_logs/);
  assert.deepEqual(state.batches[0][0].args, ["text-1"]);
});

test("permanentlyDeleteTrashTexts paginates with cursor and reports deleted count", async () => {
  const texts = loadTextsRoute();
  // 单轮返回 2 行（< 批量上限 100）→ 处理完即退出循环
  const { db, state } = createLifecycleDb({
    allHandlers: [
      {
        match:
          /SELECT id FROM texts\s+WHERE owner_id = \? AND deleted_at IS NOT NULL AND id > \?/,
        value: { results: [{ id: "text-a" }, { id: "text-b" }] },
      },
    ],
    // 两个文本各消耗一组 handler（consume 是 splice 消费式）
    runHandlers: [
      {
        match: /DELETE FROM text_shares WHERE text_id = \?/,
        value: { meta: { changes: 0 } },
      },
      {
        match: /DELETE FROM text_one_time_shares WHERE text_id = \?/,
        value: { meta: { changes: 0 } },
      },
      {
        match: /DELETE FROM texts WHERE id = \?/,
        value: { meta: { changes: 1 } },
      },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
      {
        match: /DELETE FROM text_shares WHERE text_id = \?/,
        value: { meta: { changes: 0 } },
      },
      {
        match: /DELETE FROM text_one_time_shares WHERE text_id = \?/,
        value: { meta: { changes: 0 } },
      },
      {
        match: /DELETE FROM texts WHERE id = \?/,
        value: { meta: { changes: 1 } },
      },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
      // 清空完成后的 TEXT_TRASH_CLEAR 汇总审计（logAudit 单语句 run）
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await texts.permanentlyDeleteTrashTexts(
    authedRequest("https://example.com/api/texts/trash/permanent", {
      method: "DELETE",
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.deleted, 2);
  // 每个文本一个 batch，共 2 个
  assert.equal(state.batches.length, 2);
  // 批量未满即退出：仅一次分页 SELECT，游标起点为空串
  assert.equal(state.alls.length, 1);
  assert.deepEqual(state.alls[0].args[1], "");
});

test("listTrashTexts enforces owner scope for regular users", async () => {
  const texts = loadTextsRoute();
  const { db, state } = createLifecycleDb({
    allHandlers: [
      {
        match: /SELECT COUNT\(\*\) AS total FROM texts t/,
        value: { results: [{ total: 1 }] },
      },
      {
        match: /FROM texts t\s+LEFT JOIN users u/,
        value: { results: [{ id: "text-1", title: "已删除" }] },
      },
    ],
    firstHandlers: [
      {
        match: /SELECT COUNT\(\*\) AS total FROM texts t/,
        value: 1,
      },
    ],
  });

  const response = await texts.listTrashTexts(
    authedRequest("https://example.com/api/texts/trash?page=1&limit=20"),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.total, 1);
  // 非管理员强制 owner 过滤
  const countSql = state.alls[0].sql;
  assert.match(countSql, /t\.owner_id = \?/);
  assert.match(countSql, /t\.deleted_at IS NOT NULL/);
});

test("listTrashTexts rejects prototype-chain sort_by values and falls back to deleted_at", async () => {
  const texts = loadTextsRoute();
  // consume 消费式：COUNT 走 first、列表走 all，各按 3 轮请求提供
  const rowsAll = {
    match: /FROM texts t\s+LEFT JOIN users u/,
    value: { results: [] },
  };
  const countFirst = {
    match: /SELECT COUNT\(\*\) AS total FROM texts t/,
    value: 0,
  };
  const { db, state } = createLifecycleDb({
    allHandlers: [rowsAll, rowsAll, rowsAll],
    firstHandlers: [countFirst, countFirst, countFirst],
  });

  // constructor / __proto__ 命中 Object.prototype 时真值检查会放行 → SQL 注入构造函数源码
  for (const malicious of ["constructor", "__proto__", "toString"]) {
    const response = await texts.listTrashTexts(
      authedRequest(
        `https://example.com/api/texts/trash?page=1&limit=20&sort_by=${encodeURIComponent(malicious)}`,
      ),
      { DB: db },
    );

    assert.equal(response.status, 200);
  }
  const rowsSql = state.alls.map((entry) => entry.sql).join("\n");
  assert.match(rowsSql, /ORDER BY t\.deleted_at DESC/);
  assert.ok(!rowsSql.includes("[native code]"), "原型链属性不得注入 SQL");
});
