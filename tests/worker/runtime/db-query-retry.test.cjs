const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

const {
  queryWithRetry,
  batchQueryWithRetry,
  withD1Retry,
  DatabaseTimeoutError,
} = require(path.join(COMPILED_ROOT, "utils/db.js"));

/**
 * 构造一个可编排的 D1PreparedStatement 替身。
 * behaviours 中的每一项对应一次调用：Error 实例表示抛错，函数表示自定义实现，其余作为返回值。
 */
function fakeStatement(behaviours) {
  const queue = [...behaviours];
  const calls = { first: 0, all: 0, run: 0 };

  const next = async (operation) => {
    calls[operation] += 1;
    const behaviour = queue.length > 1 ? queue.shift() : queue[0];
    if (behaviour instanceof Error) throw behaviour;
    if (typeof behaviour === "function") return behaviour();
    return behaviour;
  };

  return {
    calls,
    get total() {
      return calls.first + calls.all + calls.run;
    },
    first: () => next("first"),
    all: () => next("all"),
    run: () => next("run"),
  };
}

function retryableError(message) {
  return new Error(message);
}

test("默认以 first 操作执行并原样返回单行结果", async () => {
  const statement = fakeStatement([{ id: "f1" }]);

  const result = await queryWithRetry(statement);

  assert.deepEqual(result, { id: "f1" });
  assert.equal(statement.calls.first, 1);
  assert.equal(statement.calls.all, 0);
  assert.equal(statement.calls.run, 0);
});

test("first 查询无结果时返回 null", async () => {
  const statement = fakeStatement([null]);
  assert.equal(await queryWithRetry(statement), null);
});

test("all 操作自动解包 D1 的 { results } 结构", async () => {
  const rows = [{ id: 1 }, { id: 2 }];
  const statement = fakeStatement([{ results: rows, success: true }]);

  const result = await queryWithRetry(statement, { operation: "all" });

  assert.deepEqual(result, rows);
  assert.equal(statement.calls.all, 1);
});

test("all 操作在响应缺少 results 字段时返回原始响应", async () => {
  const statement = fakeStatement([{ success: true }]);
  assert.deepEqual(await queryWithRetry(statement, { operation: "all" }), {
    success: true,
  });
});

test("run 操作返回 D1 的 meta 信息", async () => {
  const statement = fakeStatement([{ success: true, meta: { changes: 3 } }]);

  const result = await queryWithRetry(statement, { operation: "run" });

  assert.equal(result.meta.changes, 3);
  assert.equal(statement.calls.run, 1);
});

test("不可重试的错误立即抛出，不做任何重试", async () => {
  const statement = fakeStatement([new Error("no such table: files")]);

  await assert.rejects(
    queryWithRetry(statement, { maxRetries: 2 }),
    /no such table/,
  );
  assert.equal(statement.total, 1, "业务错误不应触发重试");
});

test("可重试错误在下一次尝试成功后正常返回", async () => {
  for (const message of [
    "SQLITE_BUSY: database is busy",
    "SQLITE_LOCKED",
    "database is locked",
    "network error while querying",
    "query timeout",
  ]) {
    const statement = fakeStatement([retryableError(message), { ok: message }]);

    const result = await queryWithRetry(statement);

    assert.deepEqual(result, { ok: message }, `${message} 应被判定为可重试`);
    assert.equal(statement.total, 2);
  }
});

test("错误匹配忽略大小写", async () => {
  const statement = fakeStatement([
    retryableError("sqlite_busy"),
    { ok: true },
  ]);
  assert.deepEqual(await queryWithRetry(statement), { ok: true });
  assert.equal(statement.total, 2);
});

test("持续失败时最多重试 maxRetries 次后抛出最后一个错误", async () => {
  const statement = fakeStatement([retryableError("SQLITE_BUSY")]);

  await assert.rejects(
    queryWithRetry(statement, { maxRetries: 2 }),
    /SQLITE_BUSY/,
  );
  assert.equal(statement.total, 3, "首次 + 2 次重试");
});

test("maxRetries 为 0 时只尝试一次", async () => {
  const statement = fakeStatement([retryableError("database is locked")]);

  await assert.rejects(queryWithRetry(statement, { maxRetries: 0 }));
  assert.equal(statement.total, 1);
});

test("查询超过 timeoutMs 时抛出 DatabaseTimeoutError", async () => {
  const statement = {
    first: () => new Promise(() => {}),
  };

  await assert.rejects(
    queryWithRetry(statement, { timeoutMs: 20, maxRetries: 0 }),
    (error) => {
      assert.ok(error instanceof DatabaseTimeoutError);
      assert.equal(error.name, "DatabaseTimeoutError");
      assert.match(error.message, /Database query timeout after 20ms/);
      return true;
    },
  );
});

test("超时错误本身可重试：第二次及时返回则整体成功", async () => {
  let attempt = 0;
  const statement = {
    first: () => {
      attempt += 1;
      return attempt === 1 ? new Promise(() => {}) : Promise.resolve({ ok: 1 });
    },
  };

  const result = await queryWithRetry(statement, {
    timeoutMs: 20,
    maxRetries: 1,
  });

  assert.deepEqual(result, { ok: 1 });
  assert.equal(attempt, 2);
});

test("查询在超时窗口内完成时不会被误判超时", async () => {
  const statement = {
    first: () =>
      new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 5)),
  };

  assert.deepEqual(await queryWithRetry(statement, { timeoutMs: 500 }), {
    ok: true,
  });
});

test("batchQueryWithRetry 透传 batch 结果", async () => {
  const statements = [{ id: "s1" }, { id: "s2" }];
  let received = null;
  const db = {
    batch: async (input) => {
      received = input;
      return [{ success: true }, { success: true }];
    },
  };

  const result = await batchQueryWithRetry(db, statements);

  assert.equal(result.length, 2);
  assert.equal(received, statements);
});

test("batchQueryWithRetry 对可重试错误重试、对业务错误直接抛出", async () => {
  let retryableCalls = 0;
  const retryingDb = {
    batch: async () => {
      retryableCalls += 1;
      if (retryableCalls === 1) throw retryableError("SQLITE_BUSY");
      return ["ok"];
    },
  };
  assert.deepEqual(await batchQueryWithRetry(retryingDb, []), ["ok"]);
  assert.equal(retryableCalls, 2);

  let fatalCalls = 0;
  const failingDb = {
    batch: async () => {
      fatalCalls += 1;
      throw new Error("UNIQUE constraint failed");
    },
  };
  await assert.rejects(
    batchQueryWithRetry(failingDb, [], { maxRetries: 2 }),
    /UNIQUE constraint failed/,
  );
  assert.equal(fatalCalls, 1);
});

test("batchQueryWithRetry 达到最大重试次数后抛出", async () => {
  let calls = 0;
  const db = {
    batch: async () => {
      calls += 1;
      throw retryableError("database is locked");
    },
  };

  await assert.rejects(
    batchQueryWithRetry(db, [], { maxRetries: 1 }),
    /database is locked/,
  );
  assert.equal(calls, 2);
});

test("batchQueryWithRetry 超时同样抛出 DatabaseTimeoutError", async () => {
  const db = { batch: () => new Promise(() => {}) };

  await assert.rejects(
    batchQueryWithRetry(db, [], { timeoutMs: 20, maxRetries: 0 }),
    (error) => error instanceof DatabaseTimeoutError,
  );
});

// ── withD1Retry：保持 D1 原生语义的包装器 ──

test("withD1Retry 包装后的 first 对可重试错误退避重试后成功", async () => {
  const statement = fakeStatement([
    retryableError("SQLITE_BUSY"),
    { id: "f1" },
  ]);
  const db = { prepare: () => statement };

  const result = await withD1Retry(db)
    .prepare("SELECT id FROM files LIMIT 1")
    .first();

  assert.deepEqual(result, { id: "f1" });
  assert.equal(statement.calls.first, 2);
});

test("withD1Retry 的 all 返回完整 D1Result（不拆 results）", async () => {
  const payload = { results: [{ id: 1 }], success: true, meta: {} };
  const statement = fakeStatement([payload]);
  const db = { prepare: () => statement };

  const result = await withD1Retry(db).prepare("SELECT * FROM files").all();

  assert.deepEqual(result, payload);
  assert.equal(statement.calls.all, 1);
});

test("withD1Retry 的 run 对不可重试错误立即抛出", async () => {
  const statement = fakeStatement([new Error("UNIQUE constraint failed")]);
  const db = { prepare: () => statement };

  await assert.rejects(
    withD1Retry(db).prepare("INSERT INTO files VALUES (?)").run(),
    /UNIQUE constraint failed/,
  );
  assert.equal(statement.calls.run, 1, "业务错误不应触发重试");
});

test("withD1Retry 的 first(colName) 透传列名参数", async () => {
  const seenArgs = [];
  const statement = {
    first: async (...args) => {
      seenArgs.push(args);
      return "abc";
    },
  };
  const db = { prepare: () => statement };

  const result = await withD1Retry(db)
    .prepare("SELECT id FROM users LIMIT 1")
    .first("id");

  assert.equal(result, "abc");
  assert.deepEqual(seenArgs, [["id"]]);
});

test("withD1Retry 的 bind 链保持超时与重试保护", async () => {
  const statement = fakeStatement([
    retryableError("database is locked"),
    { success: true },
  ]);
  const db = { prepare: () => ({ bind: () => statement }) };

  const result = await withD1Retry(db)
    .prepare("UPDATE files SET deleted_at = ? WHERE id = ?")
    .bind("2026-01-01", "f1")
    .run();

  assert.equal(result.success, true);
  assert.equal(statement.calls.run, 2);
});

test("withD1Retry 查询超时抛出 DatabaseTimeoutError", async () => {
  const db = {
    prepare: () => ({
      first: () => new Promise(() => {}),
    }),
  };

  await assert.rejects(
    withD1Retry(db, { timeoutMs: 20, maxRetries: 0 })
      .prepare("SELECT 1")
      .first(),
    (error) => error instanceof DatabaseTimeoutError,
  );
});

test("withD1Retry 的 batch 解包包装语句且只加超时不重试", async () => {
  const rawStatement = { id: "raw" };
  let batchCalls = 0;
  let received = null;
  const db = {
    prepare: () => rawStatement,
    batch: async (input) => {
      batchCalls += 1;
      received = input;
      throw retryableError("SQLITE_BUSY");
    },
  };

  const wrapped = withD1Retry(db);
  const wrappedStatement = wrapped.prepare("DELETE FROM files");

  await assert.rejects(
    wrapped.batch([wrappedStatement, rawStatement]),
    /SQLITE_BUSY/,
  );
  assert.equal(batchCalls, 1, "batch 含写入语句，不应自动重试");
  assert.deepEqual(
    received,
    [rawStatement, rawStatement],
    "包装语句应还原为原生语句后执行",
  );
});
