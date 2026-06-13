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

function createAuthedJsonRequest(url, body) {
  const request = new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  request.user = {
    id: "admin-1",
    username: "admin",
    role: "admin",
    status: "active",
    quota_bytes: 1024,
  };
  return request;
}

function createGetRequest(url) {
  return new Request(url, { method: "GET" });
}

function createDb({ firstHandlers = [], allHandlers = [], runHandlers = [] }) {
  const state = {
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
      async first() {
        return consume(firstHandlers, sql, args, "first");
      },
      async all() {
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
          async first() {
            return consume(firstHandlers, sql, [], "first");
          },
          async all() {
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

test("updateUser rejects deleted status and forces dedicated delete flow", async () => {
  const { updateUser } = loadModule("routes/users.js");
  const { db } = createDb({
    firstHandlers: [
      {
        match: /SELECT role, status FROM users WHERE id = \? LIMIT 1/,
        value: { role: "user", status: "active" },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE sessions SET revoked_at = \? WHERE user_id = \? AND revoked_at IS NULL/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /UPDATE users SET/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /INSERT INTO audit_logs/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await updateUser(
    createAuthedJsonRequest("https://example.com/api/users/user-1", {
      status: "deleted",
    }),
    { DB: db },
    "user-1",
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "请使用专用删除接口删除用户",
  });
});

test("deleteUser deactivates texts and deletes public share records", async () => {
  const { deleteUser } = loadModule("routes/users.js");
  const { db, state } = createDb({
    firstHandlers: [
      {
        match: /SELECT role FROM users WHERE id = \? LIMIT 1/,
        value: { role: "user" },
      },
    ],
    allHandlers: [
      {
        match:
          /SELECT id, r2_key FROM files WHERE owner_id = \? AND deleted_at IS NULL/,
        value: { results: [] },
      },
    ],
    runHandlers: [
      {
        match: /UPDATE users SET status = \?, updated_at = \? WHERE id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /UPDATE sessions SET revoked_at = \? WHERE user_id = \? AND revoked_at IS NULL/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /INSERT INTO audit_logs/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /UPDATE texts SET deleted_at = \?, updated_at = \? WHERE owner_id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /DELETE FROM text_shares WHERE owner_id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /DELETE FROM text_one_time_shares WHERE owner_id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /DELETE FROM file_shares WHERE owner_id = \?/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await deleteUser(
    createAuthedJsonRequest("https://example.com/api/users/user-1/delete", {}),
    { DB: db },
    "user-1",
  );

  assert.equal(response.status, 200);
  assert.equal(state.batches.length, 1);
  assert.ok(
    state.runs.some((entry) =>
      /UPDATE texts SET deleted_at = \?, updated_at = \? WHERE owner_id = \?/.test(
        entry.sql,
      ),
    ),
  );
  assert.ok(
    state.runs.some((entry) =>
      /DELETE FROM text_shares WHERE owner_id = \?/.test(entry.sql),
    ),
  );
  assert.ok(
    state.runs.some((entry) =>
      /DELETE FROM text_one_time_shares WHERE owner_id = \?/.test(entry.sql),
    ),
  );
  assert.ok(
    state.runs.some((entry) =>
      /DELETE FROM file_shares WHERE owner_id = \?/.test(entry.sql),
    ),
  );
});

test("deleteUser releases active upload reservations for queued files immediately", async () => {
  const { deleteUser } = loadModule("routes/users.js");
  const { db, state } = createDb({
    firstHandlers: [
      {
        match: /SELECT role FROM users WHERE id = \? LIMIT 1/,
        value: { role: "user" },
      },
    ],
    allHandlers: [
      {
        match:
          /SELECT id, r2_key FROM files WHERE owner_id = \? AND deleted_at IS NULL/,
        value: {
          results: [
            { id: "file-pending-1", r2_key: "flares3/cfg-1/pending-1.bin" },
            { id: "file-pending-2", r2_key: "flares3/cfg-1/pending-2.bin" },
          ],
        },
      },
    ],
    runHandlers: [
      {
        match: /UPDATE users SET status = \?, updated_at = \? WHERE id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /UPDATE sessions SET revoked_at = \? WHERE user_id = \? AND revoked_at IS NULL/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /UPDATE texts SET deleted_at = \?, updated_at = \? WHERE owner_id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /DELETE FROM text_shares WHERE owner_id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /DELETE FROM text_one_time_shares WHERE owner_id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /DELETE FROM file_shares WHERE owner_id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /UPDATE files SET upload_status = 'deleted', deleted_at = \?, multipart_upload_id = NULL WHERE owner_id = \? AND deleted_at IS NULL/,
        value: { meta: { changes: 2 } },
      },
      {
        match:
          /UPDATE upload_reservations SET status = \?, updated_at = \? WHERE file_id = \? AND status = 'active'/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /INSERT INTO delete_queue \(id, file_id, r2_key, created_at\)[\s\S]*WHERE NOT EXISTS \([\s\S]*SELECT 1 FROM delete_queue WHERE file_id = \? AND processed_at IS NULL[\s\S]*\)/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /INSERT INTO audit_logs/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /UPDATE upload_reservations SET status = \?, updated_at = \? WHERE file_id = \? AND status = 'active'/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /INSERT INTO delete_queue \(id, file_id, r2_key, created_at\)[\s\S]*WHERE NOT EXISTS \([\s\S]*SELECT 1 FROM delete_queue WHERE file_id = \? AND processed_at IS NULL[\s\S]*\)/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await deleteUser(
    createAuthedJsonRequest("https://example.com/api/users/user-1/delete", {}),
    { DB: db },
    "user-1",
  );

  assert.equal(response.status, 200);
  assert.equal(state.batches.length, 1);
  const reservationRuns = state.runs.filter((entry) =>
    /UPDATE upload_reservations SET status = \?, updated_at = \? WHERE file_id = \? AND status = 'active'/.test(
      entry.sql,
    ),
  );
  assert.equal(reservationRuns.length, 2);
  assert.deepEqual(
    reservationRuns.map((entry) => entry.args[2]),
    ["file-pending-1", "file-pending-2"],
  );
});

test("permanentlyDeleteFile avoids duplicate delete_queue records on retry", async () => {
  const { permanentlyDeleteFile } = loadModule("routes/files.js");
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /SELECT id, owner_id, r2_key, upload_status, deleted_at, config_id FROM files WHERE id = \? LIMIT 1/,
        value: {
          id: "file-1",
          owner_id: "user-2",
          r2_key: "flares3/cfg-1/demo.bin",
          upload_status: "deleted",
          deleted_at: "2026-04-01T00:00:00.000Z",
        },
      },
    ],
    runHandlers: [
      {
        match:
          /INSERT INTO delete_queue \(id, file_id, r2_key, created_at\)[\s\S]*WHERE NOT EXISTS \([\s\S]*SELECT 1 FROM delete_queue WHERE file_id = \? AND processed_at IS NULL[\s\S]*\)/,
        value: { meta: { changes: 0 } },
      },
      {
        match: /INSERT INTO audit_logs/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await permanentlyDeleteFile(
    createAuthedJsonRequest(
      "https://example.com/api/files/file-1/permanent-delete",
      {},
    ),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, queued: false });
  assert.equal(state.batches.length, 1);
  assert.equal(state.batches[0].length, 2);
  assert.equal(
    state.runs.filter((entry) =>
      /INSERT INTO delete_queue \(id, file_id, r2_key, created_at\)/.test(
        entry.sql,
      ),
    ).length,
    1,
  );
});

test("viewTextShare blocks access when owner is not active", async () => {
  const { viewTextShare } = loadModule("routes/textShares.js");
  const { db } = createDb({
    firstHandlers: [
      {
        match:
          /FROM text_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          id: "share-1",
          text_id: "text-1",
          share_code: "share-1",
          password_hash: null,
          expires_at: null,
          max_views: 0,
          views: 0,
          text_title: "Secret",
          text_content: "hidden",
          text_deleted_at: null,
          owner_status: "disabled",
        },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE text_shares[\s\S]*SET views = views \+ 1, updated_at = \?/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await viewTextShare(
    createGetRequest("https://example.com/t/share-1"),
    { DB: db },
    "share-1",
  );
  const body = await response.text();

  assert.equal(response.status, 404);
  assert.match(body, /内容不存在/);
});

test("tryViewTextOneTimeShare blocks access when owner is deleted", async () => {
  const { tryViewTextOneTimeShare } = loadModule("routes/textOneTimeShares.js");
  const { db } = createDb({
    firstHandlers: [
      {
        match:
          /FROM text_one_time_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          id: "share-1",
          text_id: "text-1",
          share_code: "share-1",
          expires_at: "9999-12-31T23:59:59.999Z",
          consumed_at: null,
          text_title: "Secret",
          text_content: "hidden",
          text_deleted_at: null,
          owner_status: "deleted",
        },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE text_one_time_shares[\s\S]*SET consumed_at = \?, updated_at = \?/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await tryViewTextOneTimeShare(
    createGetRequest("https://example.com/s/share-1"),
    { DB: db },
    "share-1",
  );
  const body = await response.text();

  assert.equal(response.status, 404);
  assert.match(body, /内容不存在/);
});

test("viewFileShare blocks access when owner is not active", async () => {
  const { viewFileShare } = loadModule("routes/fileShares.js");
  const { db } = createDb({
    firstHandlers: [
      {
        match:
          /FROM file_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          share_id: "share-1",
          file_id: "file-1",
          share_code: "share-1",
          password_hash: null,
          share_expires_at: null,
          max_views: 0,
          views: 0,
          filename: "demo.txt",
          r2_key: "flares3/config/demo.txt",
          file_expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          deleted_at: null,
          owner_status: "disabled",
        },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE file_shares[\s\S]*SET views = views \+ 1, updated_at = \?/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const response = await viewFileShare(
    createGetRequest("https://example.com/f/share-1"),
    { DB: db },
    "share-1",
  );
  const body = await response.text();

  assert.equal(response.status, 404);
  assert.match(body, /文件不存在/);
});

test("shortlink blocks direct file redirect when owner is deleted", async () => {
  const { shortlink } = loadModule("routes/shortlink.js");
  const { db } = createDb({
    firstHandlers: [
      {
        match: /FROM files f[\s\S]*WHERE f\.short_code = \?[\s\S]*LIMIT 1/,
        value: { id: "file-1", require_login: 0, owner_status: "deleted" },
      },
    ],
  });

  const response = await shortlink(
    createGetRequest("https://example.com/s/abc123"),
    { DB: db },
    "abc123",
  );

  assert.equal(response.status, 404);
});
