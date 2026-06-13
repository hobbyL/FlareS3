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

function createRequest(url, method = "GET") {
  return new Request(url, { method });
}

function createPasswordPostRequest(url, contentLength) {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": String(contentLength),
      "CF-Connecting-IP": "203.0.113.50",
    },
    body: "password=test",
  });
}

function createAuthedJsonRequest(url, payload, user) {
  const request = new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  request.user = user || {
    id: "user-1",
    username: "alice",
    role: "user",
    status: "active",
    quota_bytes: 1024,
  };
  return request;
}

function createDb({ firstHandlers = [], runHandlers = [] }) {
  const state = {
    runs: [],
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

  return {
    state,
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                return consume(firstHandlers, sql, args, "first");
              },
              async run() {
                state.runs.push({ sql, args });
                return consume(runHandlers, sql, args, "run");
              },
            };
          },
          async run() {
            state.runs.push({ sql, args: [] });
            return consume(runHandlers, sql, [], "run");
          },
        };
      },
    },
  };
}

function loadFileShareModules() {
  clearModule("routes/fileShares.js");
  clearModule("services/fileShareDownload.js");
  clearModule("services/r2.js");
  clearModule("services/storage/factory.js");

  const r2 = loadModule("services/r2.js");
  const storageFactory = loadModule("services/storage/factory.js");
  const fileShares = loadModule("routes/fileShares.js");
  return { r2, storageFactory, fileShares };
}

function loadTextShareModule() {
  clearModule("routes/textShares.js");
  return loadModule("routes/textShares.js");
}

function loadTextOneTimeShareModule() {
  clearModule("routes/textOneTimeShares.js");
  clearModule("routes/textShares.js");
  return loadModule("routes/textOneTimeShares.js");
}

test("viewFileShare proxies shared file download instead of redirecting to presigned url", async () => {
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
          share_expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 1,
          views: 0,
          filename: "demo.txt",
          r2_key: "flares3/config/demo.txt",
          file_expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          deleted_at: null,
          owner_status: "active",
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
  const { r2, fileShares } = loadFileShareModules();

  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.generateDownloadUrl = async () => "https://download.example.com/file-1";

  const originalFetch = global.fetch;
  let fetchedUrl = "";
  global.fetch = async (url) => {
    fetchedUrl = String(url);
    return new Response("shared payload", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="demo.txt"',
      },
    });
  };

  try {
    const response = await fileShares.viewFileShare(
      createRequest("https://example.com/f/share-1", "POST"),
      { DB: db },
      "share-1",
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Location"), null);
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="demo.txt"',
    );
    assert.equal(await response.text(), "shared payload");
    assert.equal(fetchedUrl, "https://download.example.com/file-1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("viewFileShare proxies explicit provider redirect downloads for shared files", async () => {
  const { db } = createDb({
    firstHandlers: [
      {
        match:
          /FROM file_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          share_id: "share-provider",
          file_id: "file-provider",
          share_code: "share-provider",
          password_hash: null,
          share_expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 1,
          views: 0,
          filename: "stored-provider.txt",
          r2_key: "storage/webdav-1/stored-provider.txt",
          config_id: "webdav-1",
          file_expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          deleted_at: null,
          owner_status: "active",
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
  const { r2, storageFactory, fileShares } = loadFileShareModules();

  let r2Resolved = false;
  r2.resolveR2ConfigForKey = async () => {
    r2Resolved = true;
    return null;
  };
  storageFactory.createProvider = async (_env, configId) => {
    assert.equal(configId, "webdav-1");
    return {
      async download(key, filename) {
        assert.equal(key, "storage/webdav-1/stored-provider.txt");
        assert.equal(filename, "stored-provider.txt");
        return {
          kind: "redirect",
          url: "https://provider.example/download-token",
        };
      },
    };
  };

  const originalFetch = global.fetch;
  let fetchedUrl = "";
  global.fetch = async (url) => {
    fetchedUrl = String(url);
    return new Response("provider payload", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="upstream.txt"',
        "Set-Cookie": "session=attacker; Path=/",
      },
    });
  };

  try {
    const response = await fileShares.viewFileShare(
      createRequest("https://example.com/f/share-provider", "POST"),
      { DB: db },
      "share-provider",
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Location"), null);
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="stored-provider.txt"',
    );
    assert.equal(await response.text(), "provider payload");
    assert.equal(fetchedUrl, "https://provider.example/download-token");
    assert.equal(r2Resolved, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("viewFileShare truncates oversized upstream download error body", async () => {
  const { MAX_UPSTREAM_ERROR_TEXT_BYTES } = loadModule(
    "services/upstreamResponsePolicy.js",
  );
  const { db } = createDb({
    firstHandlers: [
      {
        match:
          /FROM file_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          share_id: "share-large-error",
          file_id: "file-large-error",
          share_code: "share-large-error",
          password_hash: null,
          share_expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 1,
          views: 0,
          filename: "broken.txt",
          r2_key: "flares3/config/broken.txt",
          file_expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          deleted_at: null,
          owner_status: "active",
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
  const { r2, fileShares } = loadFileShareModules();

  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.generateDownloadUrl = async () => "https://download.example.com/broken";

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response("x".repeat(MAX_UPSTREAM_ERROR_TEXT_BYTES + 8192), {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    });

  try {
    const response = await fileShares.viewFileShare(
      createRequest("https://example.com/f/share-large-error", "POST"),
      { DB: db },
      "share-large-error",
    );
    const body = await response.text();

    assert.equal(response.status, 502);
    assert.match(body, /x{128}/);
    assert.doesNotMatch(
      body,
      new RegExp(`x{${MAX_UPSTREAM_ERROR_TEXT_BYTES + 1}}`),
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("viewFileShare uses stored filename for proxied download disposition", async () => {
  const { db } = createDb({
    firstHandlers: [
      {
        match:
          /FROM file_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          share_id: "share-disposition",
          file_id: "file-disposition",
          share_code: "share-disposition",
          password_hash: null,
          share_expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 1,
          views: 0,
          filename: "stored.txt",
          r2_key: "flares3/config/stored.txt",
          file_expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          deleted_at: null,
          owner_status: "active",
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
  const { r2, fileShares } = loadFileShareModules();

  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.generateDownloadUrl = async () => "https://download.example.com/stored";

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response("shared payload", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="upstream-override.txt"',
        "Content-Length": "not-a-number",
      },
    });

  try {
    const response = await fileShares.viewFileShare(
      createRequest("https://example.com/f/share-disposition", "POST"),
      { DB: db },
      "share-disposition",
    );

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="stored.txt"',
    );
    assert.equal(response.headers.get("Content-Length"), null);
    assert.equal(await response.text(), "shared payload");
  } finally {
    global.fetch = originalFetch;
  }
});

test("viewFileShare GET renders confirmation page and does not consume no-password share", async () => {
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /FROM file_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          share_id: "share-2",
          file_id: "file-2",
          share_code: "share-2",
          password_hash: null,
          share_expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 1,
          views: 0,
          filename: "guide.txt",
          r2_key: "flares3/config/guide.txt",
          file_expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          deleted_at: null,
          owner_status: "active",
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
  const { r2, fileShares } = loadFileShareModules();

  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.generateDownloadUrl = async () => "https://download.example.com/file-2";

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response("shared payload", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });

  try {
    const response = await fileShares.viewFileShare(
      createRequest("https://example.com/f/share-2", "GET"),
      { DB: db },
      "share-2",
    );

    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /下载文件/);
    assert.equal(
      state.runs.some((entry) =>
        /UPDATE file_shares[\s\S]*SET views = views \+ 1, updated_at = \?/.test(
          entry.sql,
        ),
      ),
      false,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("viewTextShare GET renders confirmation page and does not consume no-password share", async () => {
  const { viewTextShare } = loadTextShareModule();
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /FROM text_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          id: "share-3",
          text_id: "text-1",
          share_code: "share-3",
          password_hash: null,
          expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 1,
          views: 0,
          text_title: "Secret",
          text_content: "hidden",
          text_deleted_at: null,
          owner_status: "active",
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
    createRequest("https://example.com/t/share-3", "GET"),
    { DB: db },
    "share-3",
  );

  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /查看内容/);
  assert.equal(
    state.runs.some((entry) =>
      /UPDATE text_shares[\s\S]*SET views = views \+ 1, updated_at = \?/.test(
        entry.sql,
      ),
    ),
    false,
  );
});

test("viewTextShare rejects oversized password form before consuming share", async () => {
  const { MAX_SHARE_PASSWORD_FORM_BYTES } = loadModule(
    "services/requestBodyPolicy.js",
  );
  const { viewTextShare } = loadTextShareModule();
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /FROM text_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          id: "share-password-1",
          text_id: "text-password-1",
          share_code: "share-password-1",
          password_hash: "$2a$10$placeholder",
          expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 1,
          views: 0,
          text_title: "Secret",
          text_content: "hidden",
          text_deleted_at: null,
          owner_status: "active",
        },
      },
      {
        match: /SELECT blocked_until FROM rate_limits WHERE ip = \?/,
        value: null,
      },
    ],
  });

  const response = await viewTextShare(
    createPasswordPostRequest(
      "https://example.com/t/share-password-1",
      MAX_SHARE_PASSWORD_FORM_BYTES + 1,
    ),
    { DB: db },
    "share-password-1",
  );
  const payload = await response.json();

  assert.equal(response.status, 413);
  assert.match(payload.error, /分享口令表单大小超过限制/);
  assert.equal(
    state.runs.some((entry) =>
      /UPDATE text_shares[\s\S]*SET views = views \+ 1, updated_at = \?/.test(
        entry.sql,
      ),
    ),
    false,
  );
});

test("viewFileShare consumes no-password share only after confirmation post and blocks repeated post", async () => {
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /FROM file_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          share_id: "share-4",
          file_id: "file-4",
          share_code: "share-4",
          password_hash: null,
          share_expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 1,
          views: 0,
          filename: "report.txt",
          r2_key: "flares3/config/report.txt",
          file_expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          deleted_at: null,
          owner_status: "active",
        },
      },
      {
        match:
          /FROM file_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          share_id: "share-4",
          file_id: "file-4",
          share_code: "share-4",
          password_hash: null,
          share_expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 1,
          views: 0,
          filename: "report.txt",
          r2_key: "flares3/config/report.txt",
          file_expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          deleted_at: null,
          owner_status: "active",
        },
      },
      {
        match:
          /FROM file_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          share_id: "share-4",
          file_id: "file-4",
          share_code: "share-4",
          password_hash: null,
          share_expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 1,
          views: 1,
          filename: "report.txt",
          r2_key: "flares3/config/report.txt",
          file_expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          deleted_at: null,
          owner_status: "active",
        },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE file_shares[\s\S]*SET views = views \+ 1, updated_at = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /UPDATE file_shares[\s\S]*SET views = views \+ 1, updated_at = \?/,
        value: { meta: { changes: 0 } },
      },
    ],
  });
  const { r2, fileShares } = loadFileShareModules();

  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.generateDownloadUrl = async () => "https://download.example.com/file-4";

  const originalFetch = global.fetch;
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    return new Response("downloaded report", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="report.txt"',
      },
    });
  };

  try {
    const getResponse = await fileShares.viewFileShare(
      createRequest("https://example.com/f/share-4", "GET"),
      { DB: db },
      "share-4",
    );
    const getBody = await getResponse.text();

    assert.equal(getResponse.status, 200);
    assert.match(getBody, /开始下载文件/);
    assert.equal(
      state.runs.some((entry) =>
        /UPDATE file_shares[\s\S]*SET views = views \+ 1, updated_at = \?/.test(
          entry.sql,
        ),
      ),
      false,
    );

    const firstPostResponse = await fileShares.viewFileShare(
      createRequest("https://example.com/f/share-4", "POST"),
      { DB: db },
      "share-4",
    );

    assert.equal(firstPostResponse.status, 200);
    assert.equal(
      firstPostResponse.headers.get("Content-Disposition"),
      'attachment; filename="report.txt"',
    );
    assert.equal(await firstPostResponse.text(), "downloaded report");
    assert.equal(fetchCount, 1);
    assert.equal(
      state.runs.filter((entry) =>
        /UPDATE file_shares[\s\S]*SET views = views \+ 1, updated_at = \?/.test(
          entry.sql,
        ),
      ).length,
      1,
    );

    const secondPostResponse = await fileShares.viewFileShare(
      createRequest("https://example.com/f/share-4", "POST"),
      { DB: db },
      "share-4",
    );
    const secondPostBody = await secondPostResponse.text();

    assert.equal(secondPostResponse.status, 410);
    assert.match(secondPostBody, /访问次数已用尽/);
    assert.equal(fetchCount, 1);
    assert.equal(
      state.runs.filter((entry) =>
        /UPDATE file_shares[\s\S]*SET views = views \+ 1, updated_at = \?/.test(
          entry.sql,
        ),
      ).length,
      1,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("viewFileShare rejects oversized password form before consuming share", async () => {
  const { MAX_SHARE_PASSWORD_FORM_BYTES } = loadModule(
    "services/requestBodyPolicy.js",
  );
  const { fileShares } = loadFileShareModules();
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /FROM file_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          share_id: "file-share-password-1",
          file_id: "file-password-1",
          share_code: "file-share-password-1",
          password_hash: "$2a$10$placeholder",
          share_expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 1,
          views: 0,
          filename: "private.txt",
          r2_key: "flares3/config/private.txt",
          file_expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          deleted_at: null,
          owner_status: "active",
        },
      },
      {
        match: /SELECT blocked_until FROM rate_limits WHERE ip = \?/,
        value: null,
      },
    ],
  });

  const response = await fileShares.viewFileShare(
    createPasswordPostRequest(
      "https://example.com/f/file-share-password-1",
      MAX_SHARE_PASSWORD_FORM_BYTES + 1,
    ),
    { DB: db },
    "file-share-password-1",
  );
  const payload = await response.json();

  assert.equal(response.status, 413);
  assert.match(payload.error, /分享口令表单大小超过限制/);
  assert.equal(
    state.runs.some((entry) =>
      /UPDATE file_shares[\s\S]*SET views = views \+ 1, updated_at = \?/.test(
        entry.sql,
      ),
    ),
    false,
  );
});

test("upsertFileShare rejects share creation for incomplete files", async () => {
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /SELECT id, owner_id, filename(?:, upload_status, expires_at)? FROM files WHERE id = \? AND upload_status != \? LIMIT 1/,
        value: {
          id: "file-pending-1",
          owner_id: "user-1",
          filename: "draft.txt",
          upload_status: "pending",
          expires_at: "9999-12-31T23:59:59.999Z",
        },
      },
      {
        match:
          /SELECT id, owner_id, share_code, password_hash, views FROM file_shares WHERE file_id = \? LIMIT 1/,
        value: null,
      },
      {
        match:
          /SELECT id, file_id, owner_id, share_code, password_hash, expires_in, expires_at, max_views, views, created_at, updated_at[\s\S]*FROM file_shares[\s\S]*WHERE file_id = \?[\s\S]*LIMIT 1/,
        value: {
          id: "share-pending-1",
          file_id: "file-pending-1",
          owner_id: "user-1",
          share_code: "pending01",
          password_hash: null,
          expires_in: 0,
          expires_at: null,
          max_views: 1,
          views: 0,
          created_at: "2026-04-21T00:00:00.000Z",
          updated_at: "2026-04-21T00:00:00.000Z",
        },
      },
    ],
    runHandlers: [
      {
        match: /INSERT INTO file_shares/,
        value: { meta: { changes: 1 } },
      },
    ],
  });
  const { fileShares } = loadFileShareModules();

  const response = await fileShares.upsertFileShare(
    createAuthedJsonRequest(
      "https://example.com/api/files/file-pending-1/share",
      {
        max_views: 1,
        expires_at: null,
      },
    ),
    { DB: db },
    "file-pending-1",
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "文件未完成上传",
  });
  assert.equal(
    state.runs.some((entry) =>
      /INSERT INTO file_shares|UPDATE file_shares/.test(entry.sql),
    ),
    false,
  );
});

test("upsertFileShare rejects share creation for expired files", async () => {
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /SELECT id, owner_id, filename(?:, upload_status, expires_at)? FROM files WHERE id = \? AND upload_status != \? LIMIT 1/,
        value: {
          id: "file-expired-1",
          owner_id: "user-1",
          filename: "expired.txt",
          upload_status: "completed",
          expires_at: "2020-01-01T00:00:00.000Z",
        },
      },
      {
        match:
          /SELECT id, owner_id, share_code, password_hash, views FROM file_shares WHERE file_id = \? LIMIT 1/,
        value: null,
      },
      {
        match:
          /SELECT id, file_id, owner_id, share_code, password_hash, expires_in, expires_at, max_views, views, created_at, updated_at[\s\S]*FROM file_shares[\s\S]*WHERE file_id = \?[\s\S]*LIMIT 1/,
        value: {
          id: "share-expired-1",
          file_id: "file-expired-1",
          owner_id: "user-1",
          share_code: "expired01",
          password_hash: null,
          expires_in: 0,
          expires_at: null,
          max_views: 1,
          views: 0,
          created_at: "2026-04-21T00:00:00.000Z",
          updated_at: "2026-04-21T00:00:00.000Z",
        },
      },
    ],
    runHandlers: [
      {
        match: /INSERT INTO file_shares/,
        value: { meta: { changes: 1 } },
      },
    ],
  });
  const { fileShares } = loadFileShareModules();

  const response = await fileShares.upsertFileShare(
    createAuthedJsonRequest(
      "https://example.com/api/files/file-expired-1/share",
      {
        max_views: 1,
        expires_at: null,
      },
    ),
    { DB: db },
    "file-expired-1",
  );

  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), {
    error: "文件已过期",
  });
  assert.equal(
    state.runs.some((entry) =>
      /INSERT INTO file_shares|UPDATE file_shares/.test(entry.sql),
    ),
    false,
  );
});

test("viewTextShare consumes no-password share only after confirmation post and blocks repeated post", async () => {
  const { viewTextShare } = loadTextShareModule();
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /FROM text_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          id: "share-5",
          text_id: "text-5",
          share_code: "share-5",
          password_hash: null,
          expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 1,
          views: 0,
          text_title: "Runbook",
          text_content: "classified",
          text_deleted_at: null,
          owner_status: "active",
        },
      },
      {
        match:
          /FROM text_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          id: "share-5",
          text_id: "text-5",
          share_code: "share-5",
          password_hash: null,
          expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 1,
          views: 0,
          text_title: "Runbook",
          text_content: "classified",
          text_deleted_at: null,
          owner_status: "active",
        },
      },
      {
        match:
          /FROM text_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          id: "share-5",
          text_id: "text-5",
          share_code: "share-5",
          password_hash: null,
          expires_at: "9999-12-31T23:59:59.999Z",
          max_views: 1,
          views: 1,
          text_title: "Runbook",
          text_content: "classified",
          text_deleted_at: null,
          owner_status: "active",
        },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE text_shares[\s\S]*SET views = views \+ 1, updated_at = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /UPDATE text_shares[\s\S]*SET views = views \+ 1, updated_at = \?/,
        value: { meta: { changes: 0 } },
      },
    ],
  });

  const getResponse = await viewTextShare(
    createRequest("https://example.com/t/share-5", "GET"),
    { DB: db },
    "share-5",
  );
  const getBody = await getResponse.text();

  assert.equal(getResponse.status, 200);
  assert.match(getBody, /点击下方按钮查看内容/);
  assert.equal(
    state.runs.some((entry) =>
      /UPDATE text_shares[\s\S]*SET views = views \+ 1, updated_at = \?/.test(
        entry.sql,
      ),
    ),
    false,
  );

  const firstPostResponse = await viewTextShare(
    createRequest("https://example.com/t/share-5", "POST"),
    { DB: db },
    "share-5",
  );
  const firstPostBody = await firstPostResponse.text();

  assert.equal(firstPostResponse.status, 200);
  assert.match(firstPostBody, /classified/);
  assert.equal(
    state.runs.filter((entry) =>
      /UPDATE text_shares[\s\S]*SET views = views \+ 1, updated_at = \?/.test(
        entry.sql,
      ),
    ).length,
    1,
  );

  const secondPostResponse = await viewTextShare(
    createRequest("https://example.com/t/share-5", "POST"),
    { DB: db },
    "share-5",
  );
  const secondPostBody = await secondPostResponse.text();

  assert.equal(secondPostResponse.status, 410);
  assert.match(secondPostBody, /访问次数已用尽/);
  assert.equal(
    state.runs.filter((entry) =>
      /UPDATE text_shares[\s\S]*SET views = views \+ 1, updated_at = \?/.test(
        entry.sql,
      ),
    ).length,
    1,
  );
});

test("tryViewTextOneTimeShare GET renders confirmation page without consuming link", async () => {
  const { tryViewTextOneTimeShare } = loadTextOneTimeShareModule();
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /FROM text_one_time_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          id: "one-time-1",
          text_id: "text-one-time-1",
          share_code: "one-time-code-1",
          expires_at: "9999-12-31T23:59:59.999Z",
          consumed_at: null,
          text_title: "One Time Runbook",
          text_content: "single use secret",
          text_deleted_at: null,
          owner_status: "active",
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
    createRequest("https://example.com/s/one-time-code-1", "GET"),
    { DB: db },
    "one-time-code-1",
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /点击下方按钮查看内容/);
  assert.doesNotMatch(body, /single use secret/);
  assert.equal(
    state.runs.some((entry) =>
      /UPDATE text_one_time_shares[\s\S]*SET consumed_at = \?, updated_at = \?/.test(
        entry.sql,
      ),
    ),
    false,
  );
});

test("tryViewTextOneTimeShare consumes link only on POST and blocks repeated consume", async () => {
  const { tryViewTextOneTimeShare } = loadTextOneTimeShareModule();
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /FROM text_one_time_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          id: "one-time-2",
          text_id: "text-one-time-2",
          share_code: "one-time-code-2",
          expires_at: "9999-12-31T23:59:59.999Z",
          consumed_at: null,
          text_title: "One Time Checklist",
          text_content: "consume once payload",
          text_deleted_at: null,
          owner_status: "active",
        },
      },
      {
        match:
          /FROM text_one_time_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/,
        value: {
          id: "one-time-2",
          text_id: "text-one-time-2",
          share_code: "one-time-code-2",
          expires_at: "9999-12-31T23:59:59.999Z",
          consumed_at: null,
          text_title: "One Time Checklist",
          text_content: "consume once payload",
          text_deleted_at: null,
          owner_status: "active",
        },
      },
    ],
    runHandlers: [
      {
        match:
          /UPDATE text_one_time_shares[\s\S]*SET consumed_at = \?, updated_at = \?/,
        value: { meta: { changes: 1 } },
      },
      {
        match:
          /UPDATE text_one_time_shares[\s\S]*SET consumed_at = \?, updated_at = \?/,
        value: { meta: { changes: 0 } },
      },
    ],
  });

  const firstPost = await tryViewTextOneTimeShare(
    createRequest("https://example.com/s/one-time-code-2", "POST"),
    { DB: db },
    "one-time-code-2",
  );
  const firstBody = await firstPost.text();

  assert.equal(firstPost.status, 200);
  assert.match(firstBody, /consume once payload/);
  assert.equal(
    state.runs.filter((entry) =>
      /UPDATE text_one_time_shares[\s\S]*SET consumed_at = \?, updated_at = \?/.test(
        entry.sql,
      ),
    ).length,
    1,
  );

  const secondPost = await tryViewTextOneTimeShare(
    createRequest("https://example.com/s/one-time-code-2", "POST"),
    { DB: db },
    "one-time-code-2",
  );
  const secondBody = await secondPost.text();

  assert.equal(secondPost.status, 410);
  assert.match(secondBody, /链接已失效/);
  assert.equal(
    state.runs.filter((entry) =>
      /UPDATE text_one_time_shares[\s\S]*SET consumed_at = \?, updated_at = \?/.test(
        entry.sql,
      ),
    ).length,
    2,
  );
});
