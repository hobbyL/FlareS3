const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function loadModule(relativePath) {
  const target = path.join(COMPILED_ROOT, relativePath);
  delete require.cache[target];
  return require(target);
}

/**
 * 专用 DB mock：files 回收站清理每轮会跑一个含多条语句的 batch
 * （N 条入队 INSERT + 1 条 file_shares 批量 DELETE），逐一 splice 消费的
 * 通用 mock 难以覆盖多轮场景，这里用「按正则返回、不消费」的轻量 mock。
 *
 * selectRounds: 连续多次 `SELECT ... FROM files` 的返回行数组；其余
 * SELECT（texts 等）返回空，其余 run（sessions/rate_limits/audit_logs/
 * share_access_logs 的 DELETE、batch 内语句）返回 changes:0。
 */
function createFilesDb({ selectRounds = [] } = {}) {
  const state = { alls: [], runs: [], batches: [] };
  let selectCall = 0;

  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            __sql: sql,
            __args: args,
            async run() {
              state.runs.push({ sql, args });
              return { meta: { changes: 0 } };
            },
            async all() {
              state.alls.push({ sql, args });
              if (/SELECT id, r2_key FROM files/.test(sql)) {
                const rows = selectRounds[selectCall] || [];
                selectCall += 1;
                return { results: rows };
              }
              return { results: [] };
            },
          };
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
  };

  return { db, state };
}

test("cleanupRetention enqueues expired trash files and cascades file_shares in one batch", async () => {
  const retention = loadModule("jobs/cleanupRetention.js");
  const { db, state } = createFilesDb({
    selectRounds: [
      [
        { id: "file-a", r2_key: "flares3/config-1/a.bin" },
        { id: "file-b", r2_key: "flares3/config-1/b.bin" },
      ],
    ],
  });

  const now = new Date("2026-10-09T00:00:00.000Z");
  const result = await retention.cleanupRetention({ DB: db }, now);

  assert.equal(result.status, "success");
  assert.equal(result.details.filesTrash, 2);
  assert.equal(result.processed, 2);

  // 单轮内：入队 + 连带删分享必须在同一个 batch（原子边界）
  assert.equal(state.batches.length, 1);
  const batchSql = state.batches[0].map((statement) => statement.sql);
  const enqueueStatements = batchSql.filter((sql) =>
    /INSERT INTO delete_queue/.test(sql),
  );
  assert.equal(enqueueStatements.length, 2, "两行各一条幂等入队 INSERT");
  assert.ok(
    batchSql.some((sql) =>
      /DELETE FROM file_shares WHERE file_id IN \(\?,\?\)/.test(sql),
    ),
    "分享行按 IN 批量连带删除",
  );

  // 入队 INSERT 幂等守卫 + 绑定了 file_id / r2_key / createdAt=now
  const enqueue = state.batches[0].find((statement) =>
    /INSERT INTO delete_queue/.test(statement.sql),
  );
  assert.match(enqueue.sql, /WHERE NOT EXISTS/);
  assert.equal(enqueue.args[1], "file-a");
  assert.equal(enqueue.args[2], "flares3/config-1/a.bin");
  assert.equal(enqueue.args[3], now.toISOString());
  assert.equal(enqueue.args[4], "file-a");

  // file_shares 批量删除绑定了两行 id
  const shareDelete = state.batches[0].find((statement) =>
    /DELETE FROM file_shares WHERE file_id IN/.test(statement.sql),
  );
  assert.deepEqual(shareDelete.args, ["file-a", "file-b"]);

  // SELECT 阈值 = 30 天保留期，且带入队进度守卫，不直接 DELETE files 行
  const filesSelect = state.alls.find((entry) =>
    /SELECT id, r2_key FROM files/.test(entry.sql),
  );
  assert.deepEqual(filesSelect.args, [
    new Date(now.getTime() - retention.FILES_TRASH_RETENTION_MS).toISOString(),
  ]);
  assert.match(filesSelect.sql, /deleted_at IS NOT NULL AND deleted_at < \?/);
  assert.match(filesSelect.sql, /NOT EXISTS[\s\S]*delete_queue/);
  assert.ok(
    !state.runs.some((entry) => /DELETE FROM files/.test(entry.sql)),
    "retention 分支不得直接 DELETE files 行（交给 cleanupDeleteQueue）",
  );
});

test("cleanupRetention keeps recent soft-deleted files within retention window", async () => {
  const retention = loadModule("jobs/cleanupRetention.js");
  const { db, state } = createFilesDb({ selectRounds: [[]] });

  const result = await retention.cleanupRetention({ DB: db }, new Date());

  assert.equal(result.status, "success");
  assert.equal(result.details.filesTrash, 0);
  assert.equal(state.batches.length, 0, "无过期行时不产生任何 batch");
});

test("cleanupRetention caps trash files processing per cron run and logs a warning", async () => {
  const retention = loadModule("jobs/cleanupRetention.js");
  const rounds = retention.FILES_TRASH_DELETE_MAX_ROUNDS;
  const batchSize = retention.FILES_TRASH_DELETE_BATCH_SIZE;
  const fullBatch = Array.from({ length: batchSize }, (_, i) => ({
    id: `file-${i}`,
    r2_key: `flares3/config-1/${i}.bin`,
  }));
  const { db } = createFilesDb({
    selectRounds: Array.from({ length: rounds }, () => fullBatch),
  });

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  let result;
  try {
    result = await retention.cleanupRetention({ DB: db }, new Date());
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.status, "success");
  assert.equal(result.details.filesTrash, rounds * batchSize);
  const capped = warnings
    .map((entry) => {
      try {
        return JSON.parse(entry[0]);
      } catch {
        return null;
      }
    })
    .find(
      (log) => log && log.event === "job.cleanupRetention.filesTrashCapped",
    );
  assert.ok(capped, "超过单轮上限应发 filesTrashCapped 告警");
  assert.equal(capped.level, "warn");
});
