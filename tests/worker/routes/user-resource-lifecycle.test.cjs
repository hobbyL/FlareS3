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
    const handler = list[index];
    // 一次性的 handler 用后即移除；标记 reusable 的保留（同一条 SQL 会随分片
    // 分批重复执行，如每个文件的预约释放 / 入队）
    if (!handler.reusable) list.splice(index, 1);
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

test("createUser rejects invalid or oversized usernames with 400 before D1 access", async () => {
  const { createUser } = loadModule("routes/users.js");
  const invalidUsernames = [
    "bad user!", // 非法字符（空格与感叹号）
    "用户名", // 非白名单字符集
    "../etc", // 路径片段
    "a".repeat(65), // 超长
  ];

  for (const username of invalidUsernames) {
    const response = await createUser(
      createAuthedJsonRequest("https://example.com/api/users", {
        username,
        password: "password123",
        quota_bytes: 1024,
      }),
      {
        DB: {
          prepare() {
            throw new Error("invalid username should not touch D1");
          },
        },
      },
    );

    assert.equal(response.status, 400, `用户名 "${username}" 应返回 400`);
    assert.match(
      (await response.json()).error,
      /用户名仅允许字母、数字、下划线、点、连字符，长度 1-64/,
    );
  }
});

test("createUser accepts 64-char usernames within the whitelist", async () => {
  const { createUser } = loadModule("routes/users.js");
  const username = "a".repeat(64);
  const { db, state } = createDb({
    firstHandlers: [
      { match: /SELECT id FROM users WHERE username = \?/, value: null },
    ],
    runHandlers: [
      { match: /INSERT INTO users/, value: { meta: { changes: 1 } } },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await createUser(
    createAuthedJsonRequest("https://example.com/api/users", {
      username,
      password: "password123",
      quota_bytes: 1024,
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  const insert = state.runs.find((entry) =>
    /INSERT INTO users/.test(entry.sql),
  );
  assert.ok(insert, "应执行用户插入");
  assert.equal(insert.args[1], username);
});

test("resetPassword returns 404 when the target user does not exist", async () => {
  const { resetPassword } = loadModule("routes/users.js");
  const { db, state } = createDb({
    firstHandlers: [
      { match: /SELECT id FROM users WHERE id = \? LIMIT 1/, value: null },
    ],
  });

  const response = await resetPassword(
    createAuthedJsonRequest(
      "https://example.com/api/users/missing-user/reset-password",
      { password: "newpassword123" },
    ),
    { DB: db },
    "missing-user",
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "用户不存在" });
  // 目标不存在时不得执行密码更新、会话撤销或审计写入
  assert.equal(state.runs.length, 0);
  assert.equal(state.batches.length, 0);
});

test("resetPassword updates the password and revokes sessions for an existing user", async () => {
  const { resetPassword } = loadModule("routes/users.js");
  const { db, state } = createDb({
    firstHandlers: [
      {
        match: /SELECT id FROM users WHERE id = \? LIMIT 1/,
        value: { id: "user-1" },
      },
    ],
    runHandlers: [
      {
        match: /UPDATE users SET password_hash = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /UPDATE sessions SET revoked_at = \? WHERE user_id = \?/,
        value: { meta: { changes: 1 } },
      },
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await resetPassword(
    createAuthedJsonRequest(
      "https://example.com/api/users/user-1/reset-password",
      { password: "newpassword123" },
    ),
    { DB: db },
    "user-1",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
  assert.ok(
    state.runs.some((entry) =>
      /UPDATE users SET password_hash = \?/.test(entry.sql),
    ),
  );
  assert.ok(
    state.runs.some((entry) =>
      /UPDATE sessions SET revoked_at/.test(entry.sql),
    ),
  );
});

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
          /SELECT id, r2_key FROM files WHERE owner_id = \?[\s\S]*ORDER BY id ASC LIMIT \?/,
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
      {
        match: /DELETE FROM folder_shares WHERE owner_id = \?/,
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
  // 无活跃文件：仅一个收口批次
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
  assert.ok(
    state.runs.some((entry) =>
      /DELETE FROM folder_shares WHERE owner_id = \?/.test(entry.sql),
    ),
    "删除用户必须清理 folder_shares，避免孤儿行与账号重新启用后分享复活",
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
          /SELECT id, r2_key FROM files WHERE owner_id = \?[\s\S]*ORDER BY id ASC LIMIT \?/,
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
        match: /DELETE FROM folder_shares WHERE owner_id = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /UPDATE files SET upload_status = 'deleted', deleted_at = COALESCE\(deleted_at, \?\) WHERE id = \? AND owner_id = \?/,
        reusable: true,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /UPDATE upload_reservations SET status = \?, updated_at = \? WHERE file_id = \? AND status = 'active'/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /INSERT INTO delete_queue \(id, file_id, r2_key, created_at, config_id, multipart_upload_id, upload_key\)[\s\S]*AND NOT EXISTS \([\s\S]*SELECT 1 FROM delete_queue WHERE file_id = \? AND processed_at IS NULL[\s\S]*\)/,
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
          /INSERT INTO delete_queue \(id, file_id, r2_key, created_at, config_id, multipart_upload_id, upload_key\)[\s\S]*AND NOT EXISTS \([\s\S]*SELECT 1 FROM delete_queue WHERE file_id = \? AND processed_at IS NULL[\s\S]*\)/,
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
  // 文件状态、预约释放与队列同批提交，失败时整页可重试。
  assert.equal(state.batches.length, 2);
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

test("deleteUser caps statements per batch when the owner has many files", async () => {
  const { deleteUser } = loadModule("routes/users.js");
  const fileCount = 60;
  const files = Array.from({ length: fileCount }, (_, index) => ({
    id: `file-${index}`,
    r2_key: `flares3/cfg-1/file-${index}.bin`,
  }));
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
          /SELECT id, r2_key FROM files WHERE owner_id = \?[\s\S]*ORDER BY id ASC LIMIT \?/,
        reusable: true,
        value: (args) => ({ results: files.splice(0, args[1]) }),
      },
    ],
    runHandlers: [
      {
        match: /UPDATE users SET status = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match: /UPDATE sessions SET revoked_at = \?/,
        value: { meta: { changes: 1 } },
      },
      { match: /UPDATE texts SET deleted_at/, value: { meta: { changes: 1 } } },
      { match: /DELETE FROM text_shares/, value: { meta: { changes: 1 } } },
      {
        match: /DELETE FROM text_one_time_shares/,
        value: { meta: { changes: 1 } },
      },
      { match: /DELETE FROM file_shares/, value: { meta: { changes: 1 } } },
      { match: /DELETE FROM folder_shares/, value: { meta: { changes: 1 } } },
      {
        match: /UPDATE files SET upload_status = 'deleted'/,
        reusable: true,
        value: { meta: { changes: 1 } },
      },
      {
        match: /UPDATE upload_reservations SET status = \?/,
        reusable: true,
        value: { meta: { changes: 1 } },
      },
      {
        match: /INSERT INTO delete_queue/,
        reusable: true,
        value: { meta: { changes: 1 } },
      },
      {
        match: /INSERT INTO audit_logs/,
        reusable: true,
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
  // 60 个文件必须被切成多个批次（每批 25 个文件 → 2 条语句/文件），
  // 而不是一句「文件数 × 2 + 固定语句」的超大 batch
  assert.ok(
    state.batches.length >= 4,
    `expected deleteUser to split work across batches, got ${state.batches.length}`,
  );
  // 单批语句数有界：文件批最多 25 × 2 = 50 条，加上固定语句也远低于 60×2+6
  for (const batch of state.batches) {
    assert.ok(
      batch.length <= 75,
      `batch too large: ${batch.length} statements`,
    );
  }
  // 每个文件都必须释放预约并入队删除，一个都不能漏
  const reservationRuns = state.runs.filter((entry) =>
    /UPDATE upload_reservations SET status = \?, updated_at = \? WHERE file_id = \?/.test(
      entry.sql,
    ),
  );
  const queueRuns = state.runs.filter((entry) =>
    /INSERT INTO delete_queue/.test(entry.sql),
  );
  assert.equal(reservationRuns.length, fileCount);
  assert.equal(queueRuns.length, fileCount);
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
          /INSERT INTO delete_queue \(id, file_id, r2_key, created_at, config_id, multipart_upload_id, upload_key\)[\s\S]*AND NOT EXISTS \([\s\S]*SELECT 1 FROM delete_queue WHERE file_id = \? AND processed_at IS NULL[\s\S]*\)/,
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
      /INSERT INTO delete_queue \(id, file_id, r2_key, created_at, config_id, multipart_upload_id, upload_key\)/.test(
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

test("shortlink blocks redirect for expired file", async () => {
  const { shortlink } = loadModule("routes/shortlink.js");
  const { db } = createDb({
    firstHandlers: [
      {
        match: /FROM files f[\s\S]*WHERE f\.short_code = \?[\s\S]*LIMIT 1/,
        value: {
          id: "file-1",
          require_login: 0,
          upload_status: "completed",
          deleted_at: null,
          expires_at: "2020-01-01T00:00:00.000Z",
          owner_status: "active",
        },
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

test("shortlink still redirects for never-expiring file", async () => {
  const { shortlink } = loadModule("routes/shortlink.js");
  const { db } = createDb({
    firstHandlers: [
      {
        match: /FROM files f[\s\S]*WHERE f\.short_code = \?[\s\S]*LIMIT 1/,
        value: {
          id: "file-1",
          require_login: 0,
          upload_status: "completed",
          deleted_at: null,
          expires_at: "9999-12-31T23:59:59.999Z",
          owner_status: "active",
        },
      },
    ],
  });

  const response = await shortlink(
    createGetRequest("https://example.com/s/abc123"),
    { DB: db },
    "abc123",
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/api/files/file-1/download");
});
