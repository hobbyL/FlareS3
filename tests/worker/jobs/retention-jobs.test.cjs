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

function createDb({ runHandlers = [] }) {
  const state = {
    runs: [],
  };

  function consume(list, sql, args) {
    const index = list.findIndex((handler) => handler.match.test(sql));
    if (index === -1) {
      throw new Error(`unexpected run SQL: ${sql} / ${JSON.stringify(args)}`);
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
              async run() {
                state.runs.push({ sql, args });
                return consume(runHandlers, sql, args);
              },
            };
          },
        };
      },
    },
  };
}

function createLifecycleDb({
  firstHandlers = [],
  allHandlers = [],
  runHandlers = [],
} = {}) {
  const state = {
    firsts: [],
    alls: [],
    runs: [],
    batches: [],
  };

  function consume(list, sql, args, kind) {
    const index = list.findIndex((handler) => handler.match.test(sql));
    if (index === -1) {
      if (kind === "run" && /^(CREATE|ALTER TABLE)/.test(sql.trim())) {
        return { meta: { changes: 0 } };
      }
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
          async all() {
            state.alls.push({ sql, args: [] });
            return consume(allHandlers, sql, [], "all");
          },
          async run() {
            state.runs.push({ sql, args: [] });
            return consume(runHandlers, sql, [], "run");
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

test("cleanupRetention deletes stale sessions, rate limits and audit logs using bounded thresholds", async () => {
  const retention = loadModule("jobs/cleanupRetention.js");
  const { db, state } = createDb({
    runHandlers: [
      {
        match: /DELETE FROM sessions/,
        value: { meta: { changes: 2 } },
      },
      {
        match: /DELETE FROM rate_limits/,
        value: { meta: { changes: 3 } },
      },
      {
        match: /DELETE FROM audit_logs/,
        value: { meta: { changes: 4 } },
      },
    ],
  });

  const now = new Date("2026-04-11T00:00:00.000Z");
  const result = await retention.cleanupRetention({ DB: db }, now);

  assert.equal(result.jobName, "cleanupRetention");
  assert.equal(result.status, "success");
  assert.equal(result.processed, 9);
  assert.equal(result.succeeded, 9);
  assert.equal(result.failed, 0);
  assert.equal(typeof result.startedAt, "string");
  assert.equal(typeof result.finishedAt, "string");
  assert.equal(typeof result.durationMs, "number");
  assert.deepEqual(result.details, {
    sessions: 2,
    rateLimits: 3,
    auditLogs: 4,
  });

  const sessionRun = state.runs.find((entry) =>
    /DELETE FROM sessions/.test(entry.sql),
  );
  assert.deepEqual(sessionRun.args, [
    new Date(now.getTime() - retention.SESSION_RETENTION_MS).toISOString(),
    now.toISOString(),
  ]);

  const rateLimitRun = state.runs.find((entry) =>
    /DELETE FROM rate_limits/.test(entry.sql),
  );
  assert.deepEqual(rateLimitRun.args, [
    new Date(now.getTime() - retention.RATE_LIMIT_RETENTION_MS).toISOString(),
    now.toISOString(),
  ]);

  const auditRun = state.runs.find((entry) =>
    /DELETE FROM audit_logs/.test(entry.sql),
  );
  assert.deepEqual(auditRun.args, [
    new Date(now.getTime() - retention.AUDIT_LOG_RETENTION_MS).toISOString(),
  ]);
});

test("cleanupExpired releases active upload reservation after marking expired file deleted", async () => {
  clearModule("jobs/cleanupExpired.js");
  clearModule("services/storage/factory.js");
  const r2 = loadModule("services/r2.js");
  const cleanupExpiredModule = loadModule("jobs/cleanupExpired.js");

  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.deleteObject = async () => {};

  const { db, state } = createLifecycleDb({
    allHandlers: [
      {
        match:
          /SELECT id, r2_key, upload_status, multipart_upload_id, config_id FROM files[\s\S]*WHERE expires_at < \? AND upload_status IN \('pending','uploading','completed'\) AND deleted_at IS NULL/,
        value: {
          results: [
            {
              id: "file-1",
              r2_key: "flares3/config-1/demo.bin",
              upload_status: "pending",
              multipart_upload_id: null,
              config_id: "config-1",
            },
          ],
        },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE upload_reservations[\s\S]*SET status = 'released', updated_at = \?[\s\S]*NOT EXISTS/,
        value: { meta: { changes: 0 } },
      },
      {
        match:
          /UPDATE files SET upload_status = 'deleted', deleted_at = \?, multipart_upload_id = NULL WHERE id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /UPDATE upload_reservations SET status = \?, updated_at = \? WHERE file_id = \? AND status = 'active'/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const result = await cleanupExpiredModule.cleanupExpired({ DB: db });

  assert.equal(result.jobName, "cleanupExpired");
  assert.equal(result.status, "success");
  assert.equal(result.succeeded, 1);
  assert.equal(state.batches.length, 1);
  const releaseRun = state.runs.find((entry) =>
    /UPDATE upload_reservations SET status = \?, updated_at = \? WHERE file_id = \? AND status = 'active'/.test(
      entry.sql,
    ),
  );
  assert.deepEqual(releaseRun.args[0], "released");
  assert.deepEqual(releaseRun.args[2], "file-1");
});

test("cleanupExpired releases stale orphan upload reservations even when no file expired", async () => {
  clearModule("jobs/cleanupExpired.js");
  clearModule("services/storage/factory.js");
  const cleanupExpiredModule = loadModule("jobs/cleanupExpired.js");
  const uploadReservationsModule = loadModule("services/uploadReservations.js");
  const now = new Date("2026-06-05T12:00:00.000Z");

  const { db, state } = createLifecycleDb({
    allHandlers: [
      {
        match:
          /SELECT id, r2_key, upload_status, multipart_upload_id, config_id FROM files[\s\S]*WHERE expires_at < \? AND upload_status IN \('pending','uploading','completed'\) AND deleted_at IS NULL/,
        value: { results: [] },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE upload_reservations[\s\S]*SET status = 'released', updated_at = \?[\s\S]*NOT EXISTS/,
        value: { meta: { changes: 2 } },
      },
    ],
  });

  const result = await cleanupExpiredModule.cleanupExpired({ DB: db }, now);

  assert.equal(result.jobName, "cleanupExpired");
  assert.equal(result.status, "success");
  assert.equal(result.processed, 2);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.details.orphanReservationsReleased, 2);

  const orphanCleanupRun = state.runs.find((entry) =>
    /UPDATE upload_reservations[\s\S]*SET status = 'released', updated_at = \?[\s\S]*NOT EXISTS/.test(
      entry.sql,
    ),
  );
  assert.deepEqual(orphanCleanupRun.args, [
    "2026-06-05T12:00:00.000Z",
    new Date(
      now.getTime() -
        uploadReservationsModule.ORPHAN_UPLOAD_RESERVATION_GRACE_MS,
    ).toISOString(),
  ]);
});

test("cleanupExpired deletes expired explicit provider file before marking it deleted", async () => {
  clearModule("jobs/cleanupExpired.js");
  clearModule("services/storage/factory.js");
  const storageFactory = loadModule("services/storage/factory.js");
  const cleanupExpiredModule = loadModule("jobs/cleanupExpired.js");

  let deletedKey = "";
  storageFactory.createProvider = async (_env, configId) => {
    assert.equal(configId, "webdav-1");
    return {
      async delete(key) {
        deletedKey = key;
      },
    };
  };

  const { db, state } = createLifecycleDb({
    allHandlers: [
      {
        match:
          /SELECT id, r2_key, upload_status, multipart_upload_id, config_id FROM files[\s\S]*WHERE expires_at < \? AND upload_status IN \('pending','uploading','completed'\) AND deleted_at IS NULL/,
        value: {
          results: [
            {
              id: "file-webdav-1",
              r2_key: "storage/webdav-1/demo.bin",
              upload_status: "completed",
              multipart_upload_id: null,
              config_id: "webdav-1",
            },
          ],
        },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE upload_reservations[\s\S]*SET status = 'released', updated_at = \?[\s\S]*NOT EXISTS/,
        value: { meta: { changes: 0 } },
      },
      {
        match:
          /UPDATE files SET upload_status = 'deleted', deleted_at = \?, multipart_upload_id = NULL WHERE id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /UPDATE upload_reservations SET status = \?, updated_at = \? WHERE file_id = \? AND status = 'active'/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const result = await cleanupExpiredModule.cleanupExpired({ DB: db });

  assert.equal(result.status, "success");
  assert.equal(result.succeeded, 1);
  assert.equal(deletedKey, "storage/webdav-1/demo.bin");
  assert.equal(state.batches.length, 1);
});

test("cleanupDeleteQueue releases active upload reservation before deleting file row", async () => {
  clearModule("jobs/cleanupDeleteQueue.js");
  clearModule("services/storage/factory.js");
  const r2 = loadModule("services/r2.js");
  const cleanupDeleteQueueModule = loadModule("jobs/cleanupDeleteQueue.js");

  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.deleteObject = async () => {};

  const { db, state } = createLifecycleDb({
    allHandlers: [
      {
        match:
          /SELECT dq\.id, dq\.file_id, dq\.r2_key, f\.config_id, f\.multipart_upload_id[\s\S]*FROM delete_queue dq[\s\S]*WHERE dq\.processed_at IS NULL[\s\S]*ORDER BY dq\.created_at ASC[\s\S]*LIMIT \?/,
        value: {
          results: [
            {
              id: "queue-1",
              file_id: "file-1",
              r2_key: "flares3/config-1/demo.bin",
              config_id: "config-1",
              multipart_upload_id: null,
            },
          ],
        },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE upload_reservations SET status = \?, updated_at = \? WHERE file_id = \? AND status = 'active'/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /DELETE FROM file_shares WHERE file_id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /DELETE FROM files WHERE id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /UPDATE delete_queue SET processed_at = \? WHERE id = \?/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const result = await cleanupDeleteQueueModule.cleanupDeleteQueue({ DB: db });

  assert.equal(result.jobName, "cleanupDeleteQueue");
  assert.equal(result.status, "success");
  assert.equal(result.succeeded, 1);
  assert.equal(state.batches.length, 1);
  const releaseIndex = state.runs.findIndex((entry) =>
    /UPDATE upload_reservations SET status = \?, updated_at = \? WHERE file_id = \? AND status = 'active'/.test(
      entry.sql,
    ),
  );
  const shareDeleteIndex = state.runs.findIndex((entry) =>
    /DELETE FROM file_shares WHERE file_id = \?/.test(entry.sql),
  );
  const deleteIndex = state.runs.findIndex((entry) =>
    /DELETE FROM files WHERE id = \?/.test(entry.sql),
  );
  assert.notEqual(releaseIndex, -1);
  assert.notEqual(shareDeleteIndex, -1);
  assert.notEqual(deleteIndex, -1);
  assert.ok(releaseIndex < shareDeleteIndex);
  assert.ok(shareDeleteIndex < deleteIndex);
  assert.ok(releaseIndex < deleteIndex);
  assert.deepEqual(state.runs[releaseIndex].args[0], "released");
  assert.deepEqual(state.runs[releaseIndex].args[2], "file-1");
});

test("cleanupDeleteQueue deletes explicit provider object before clearing queue row", async () => {
  clearModule("jobs/cleanupDeleteQueue.js");
  clearModule("services/storage/factory.js");
  const storageFactory = loadModule("services/storage/factory.js");
  const cleanupDeleteQueueModule = loadModule("jobs/cleanupDeleteQueue.js");

  let deletedKey = "";
  storageFactory.createProvider = async (_env, configId) => {
    assert.equal(configId, "webdav-1");
    return {
      async delete(key) {
        deletedKey = key;
      },
    };
  };

  const { db, state } = createLifecycleDb({
    allHandlers: [
      {
        match:
          /SELECT dq\.id, dq\.file_id, dq\.r2_key, f\.config_id, f\.multipart_upload_id[\s\S]*FROM delete_queue dq[\s\S]*WHERE dq\.processed_at IS NULL[\s\S]*ORDER BY dq\.created_at ASC[\s\S]*LIMIT \?/,
        value: {
          results: [
            {
              id: "queue-webdav-1",
              file_id: "file-webdav-1",
              r2_key: "storage/webdav-1/demo.bin",
              config_id: "webdav-1",
              multipart_upload_id: null,
            },
          ],
        },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE upload_reservations SET status = \?, updated_at = \? WHERE file_id = \? AND status = 'active'/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /DELETE FROM file_shares WHERE file_id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /DELETE FROM files WHERE id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /UPDATE delete_queue SET processed_at = \? WHERE id = \?/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const result = await cleanupDeleteQueueModule.cleanupDeleteQueue({ DB: db });

  assert.equal(result.status, "success");
  assert.equal(result.succeeded, 1);
  assert.equal(deletedKey, "storage/webdav-1/demo.bin");
  assert.equal(state.batches.length, 1);
});
