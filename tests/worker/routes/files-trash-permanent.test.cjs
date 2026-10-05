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

const TRASH_PAGE_SIZE = 100;

function createLifecycleDb({ allHandlers = [], runHandlers = [] }) {
  const state = { alls: [], runs: [], batches: [] };

  function consume(list, sql, args, kind) {
    const handler = list.find((entry) => entry.match.test(sql));
    if (!handler) {
      throw new Error(
        `unexpected ${kind} SQL: ${sql} / ${JSON.stringify(args)}`,
      );
    }
    // 标记 persistent 的 handler 按 SQL 形态匹配、可重复服务（如逐文件落库语句）；
    // 未标记的保持一次性消耗语义
    if (!handler.persistent) {
      list.splice(list.indexOf(handler), 1);
    }
    return typeof handler.value === "function"
      ? handler.value(args, sql, state)
      : handler.value;
  }

  function createBoundStatement(sql, args) {
    return {
      __sql: sql,
      __args: args,
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
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        // 模拟 D1 batch 原子性：任一语句失败即整批抛错、不留下提交记录
        state.batches.push(
          statements.map((statement) => ({
            sql: statement.__sql,
            args: statement.__args || [],
          })),
        );
        return results;
      },
    },
  };
}

function createAuthedDeleteRequest(url) {
  return Object.assign(new Request(url, { method: "DELETE" }), {
    user: { id: "user-1", role: "admin", username: "alice" },
  });
}

function trashRow(id) {
  return {
    id,
    owner_id: "user-1",
    r2_key: `storage/webdav-1/${id}.bin`,
    upload_status: "deleted",
    deleted_at: "2026-10-01T00:00:00.000Z",
    config_id: "webdav-1",
  };
}

function loadFilesRouteModules() {
  clearModule("routes/files.js");
  clearModule("services/storage/factory.js");
  const storageFactory = loadModule("services/storage/factory.js");
  const files = loadModule("routes/files.js");
  return { storageFactory, files };
}

// 逐文件落库语句按 SQL 形态匹配即可，需跨文件反复服务
const TRASH_RUN_HANDLERS = [
  {
    persistent: true,
    match:
      /UPDATE upload_reservations SET status = \?, updated_at = \? WHERE file_id = \? AND status = 'active'/,
    value: { meta: { changes: 0 } },
  },
  {
    persistent: true,
    match: /DELETE FROM file_shares WHERE file_id = \?/,
    value: { meta: { changes: 0 } },
  },
  {
    persistent: true,
    match: /DELETE FROM files WHERE id = \?/,
    value: { meta: { changes: 1 } },
  },
  {
    persistent: true,
    match: /INSERT INTO audit_logs/,
    value: { meta: { changes: 1 } },
  },
];

function trashSelectHandler(pagesByCursor) {
  return {
    persistent: true,
    match:
      /SELECT id, owner_id, r2_key, upload_status, deleted_at, config_id\s+FROM files\s+WHERE owner_id = \? AND upload_status = 'deleted' AND deleted_at IS NOT NULL\s+AND id > \?\s+ORDER BY id ASC\s+LIMIT \?/,
    value: (args) => {
      const cursor = args[1];
      return pagesByCursor[cursor] ?? { results: [] };
    },
  };
}

test("permanentlyDeleteTrashFiles pages through trash rows with an id cursor", async () => {
  const { storageFactory, files } = loadFilesRouteModules();
  const providerDeletes = [];
  storageFactory.createProvider = async (_env, configId) => {
    assert.equal(configId, "webdav-1");
    return {
      async delete(key) {
        providerDeletes.push(key);
      },
    };
  };

  const firstPage = Array.from({ length: TRASH_PAGE_SIZE }, (_, i) =>
    trashRow(`f${String(i).padStart(3, "0")}`),
  );
  const secondPage = [trashRow("f100")];
  const { db, state } = createLifecycleDb({
    allHandlers: [
      trashSelectHandler({
        "": { results: firstPage },
        f099: { results: secondPage },
      }),
    ],
    runHandlers: TRASH_RUN_HANDLERS,
  });

  const response = await files.permanentlyDeleteTrashFiles(
    createAuthedDeleteRequest("https://example.com/api/files/trash/permanent"),
    { DB: db },
  );

  assert.equal(response.status, 200);
  // 101 行 = 100（满页续翻）+ 1（不足一页收尾）
  assert.deepEqual(await response.json(), {
    success: true,
    deleted: 101,
    queued: 0,
    total: 101,
  });
  assert.equal(providerDeletes.length, 101);

  // SELECT 恰好两次：第二页以最后处理到的 id 为游标，且带 LIMIT
  assert.equal(state.alls.length, 2);
  assert.deepEqual(state.alls[0].args, ["user-1", "", TRASH_PAGE_SIZE]);
  assert.deepEqual(state.alls[1].args, ["user-1", "f099", TRASH_PAGE_SIZE]);
  assert.match(state.alls[0].sql, /AND id > \?/);
  assert.match(state.alls[0].sql, /ORDER BY id ASC/);
});

test("permanentlyDeleteTrashFiles stops paging when the first page is short", async () => {
  const { storageFactory, files } = loadFilesRouteModules();
  storageFactory.createProvider = async () => ({ async delete() {} });

  const { db, state } = createLifecycleDb({
    allHandlers: [trashSelectHandler({ "": { results: [trashRow("solo")] } })],
    runHandlers: TRASH_RUN_HANDLERS,
  });

  const response = await files.permanentlyDeleteTrashFiles(
    createAuthedDeleteRequest("https://example.com/api/files/trash/permanent"),
    { DB: db },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    deleted: 1,
    queued: 0,
    total: 1,
  });
  assert.equal(state.alls.length, 1, "不足一页时不得再发空查询");
});

test("permanentlyDeleteTrashFiles keeps already-processed rows committed when a later row fails", async () => {
  const { storageFactory, files } = loadFilesRouteModules();
  storageFactory.createProvider = async () => ({ async delete() {} });

  let filesDeleteCount = 0;
  const runHandlers = [
    {
      persistent: true,
      match:
        /UPDATE upload_reservations SET status = \?, updated_at = \? WHERE file_id = \? AND status = 'active'/,
      value: { meta: { changes: 0 } },
    },
    {
      persistent: true,
      match: /DELETE FROM file_shares WHERE file_id = \?/,
      value: { meta: { changes: 0 } },
    },
    {
      persistent: true,
      match: /DELETE FROM files WHERE id = \?/,
      value: () => {
        filesDeleteCount += 1;
        // 第 2 个文件的落库失败：此前文件的 batch 已提交，后续留给下次调用
        if (filesDeleteCount === 2) throw new Error("d1 boom");
        return { meta: { changes: 1 } };
      },
    },
    {
      persistent: true,
      match: /INSERT INTO audit_logs/,
      value: { meta: { changes: 1 } },
    },
  ];

  const { db, state } = createLifecycleDb({
    allHandlers: [
      trashSelectHandler({
        "": { results: [trashRow("a"), trashRow("b"), trashRow("c")] },
      }),
    ],
    runHandlers,
  });

  await assert.rejects(
    files.permanentlyDeleteTrashFiles(
      createAuthedDeleteRequest(
        "https://example.com/api/files/trash/permanent",
      ),
      { DB: db },
    ),
    /d1 boom/,
  );

  // 部分成功可重试续跑：第一个文件已完成落库，第三个未处理
  const deletedIds = state.batches
    .map((statements) =>
      statements.find((s) => /DELETE FROM files/.test(s.sql)),
    )
    .filter(Boolean)
    .map((statement) => statement.args[0]);
  assert.deepEqual(deletedIds, ["a"]);
});
