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

function createGetRequest(url) {
  return new Request(url, { method: "GET" });
}

function createAuthedGetRequest(url) {
  const request = createGetRequest(url);
  request.user = {
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
        };
      },
    },
  };
}

function loadFilesRouteModules() {
  clearModule("routes/files.js");
  clearModule("services/r2.js");

  const r2 = loadModule("services/r2.js");
  const files = loadModule("routes/files.js");
  return { r2, files };
}

test("downloadFile blocks direct download when owner is not active", async () => {
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /SELECT[\s\S]*FROM files(?: f)?[\s\S]*WHERE (?:f\.)?id = \?[\s\S]*LIMIT 1/,
        value: {
          id: "file-1",
          owner_id: "user-1",
          filename: "demo.txt",
          r2_key: "flares3/config/demo.txt",
          expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          require_login: 0,
          owner_status: "disabled",
        },
      },
    ],
    runHandlers: [
      {
        match: /INSERT INTO audit_logs/,
        value: { meta: { changes: 1 } },
      },
    ],
  });
  const { r2, files } = loadFilesRouteModules();

  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.generateDownloadUrl = async () => "https://download.example.com/file-1";

  const response = await files.downloadFile(
    createGetRequest("https://example.com/api/files/file-1/download"),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "文件不存在",
  });
  assert.equal(state.runs.length, 0);
});

// 修复 A：未登录访客（require_login=0）不再放行，一律 302 到登录页且不落审计日志
test("downloadFile redirects anonymous visitor to login page", async () => {
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /SELECT[\s\S]*FROM files(?: f)?[\s\S]*WHERE (?:f\.)?id = \?[\s\S]*LIMIT 1/,
        value: {
          id: "file-1",
          owner_id: "user-1",
          filename: "demo.txt",
          r2_key: "flares3/config/demo.txt",
          expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          require_login: 0,
          owner_status: "active",
        },
      },
    ],
  });
  const { files } = loadFilesRouteModules();

  const response = await files.downloadFile(
    createGetRequest("https://example.com/api/files/file-1/download"),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("Location"),
    "/login?next=%2Fapi%2Ffiles%2Ffile-1%2Fdownload",
  );
  assert.equal(state.runs.length, 0);
});

// 修复 A：已登录 owner 正常走下载（302 到预签名 URL）并记录审计日志
test("downloadFile allows logged-in owner to download directly", async () => {
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /SELECT[\s\S]*FROM files(?: f)?[\s\S]*WHERE (?:f\.)?id = \?[\s\S]*LIMIT 1/,
        value: {
          id: "file-1",
          owner_id: "user-1",
          filename: "demo.txt",
          r2_key: "flares3/config/demo.txt",
          expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          require_login: 0,
          owner_status: "active",
        },
      },
    ],
    runHandlers: [
      {
        match: /INSERT INTO audit_logs/,
        value: { meta: { changes: 1 } },
      },
    ],
  });
  const { r2, files } = loadFilesRouteModules();

  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.generateDownloadUrl = async () => "https://download.example.com/file-1";

  const response = await files.downloadFile(
    createAuthedGetRequest("https://example.com/api/files/file-1/download"),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("Location"),
    "https://download.example.com/file-1",
  );
  assert.equal(state.runs.length, 1);
  assert.match(state.runs[0].sql, /INSERT INTO audit_logs/);
});

// 修复 A：require_login=1 时已登录非 owner 访问仍 403（既有行为回归）
test("downloadFile rejects logged-in non-owner when require_login is 1", async () => {
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /SELECT[\s\S]*FROM files(?: f)?[\s\S]*WHERE (?:f\.)?id = \?[\s\S]*LIMIT 1/,
        value: {
          id: "file-1",
          owner_id: "user-1",
          filename: "demo.txt",
          r2_key: "flares3/config/demo.txt",
          expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          require_login: 1,
          owner_status: "active",
        },
      },
    ],
  });
  const { files } = loadFilesRouteModules();

  // createAuthedGetRequest 固定 user-1，这里改成 user-2 模拟非 owner
  const request = createAuthedGetRequest(
    "https://example.com/api/files/file-1/download",
  );
  request.user = { ...request.user, id: "user-2" };

  const response = await files.downloadFile(request, { DB: db }, "file-1");

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "无权限" });
  assert.equal(state.runs.length, 0);
});

// 修复 A：require_login=0 是产品开关，已登录非 owner 仍可直链下载
test("downloadFile allows logged-in non-owner when require_login is 0", async () => {
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /SELECT[\s\S]*FROM files(?: f)?[\s\S]*WHERE (?:f\.)?id = \?[\s\S]*LIMIT 1/,
        value: {
          id: "file-1",
          owner_id: "user-1",
          filename: "demo.txt",
          r2_key: "flares3/config/demo.txt",
          expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          require_login: 0,
          owner_status: "active",
        },
      },
    ],
    runHandlers: [
      {
        match: /INSERT INTO audit_logs/,
        value: { meta: { changes: 1 } },
      },
    ],
  });
  const { r2, files } = loadFilesRouteModules();

  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.generateDownloadUrl = async () => "https://download.example.com/file-1";

  const request = createAuthedGetRequest(
    "https://example.com/api/files/file-1/download",
  );
  request.user = { ...request.user, id: "user-2" };

  const response = await files.downloadFile(request, { DB: db }, "file-1");

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("Location"),
    "https://download.example.com/file-1",
  );
  assert.equal(state.runs.length, 1);
});

test("sanitizeContentDispositionFilename strips path separators, quotes and control characters", () => {
  const r2 = loadModule("services/r2.js");

  assert.equal(typeof r2.sanitizeContentDispositionFilename, "function");
  assert.equal(
    r2.sanitizeContentDispositionFilename('folder/sub\r\n"demo".txt'),
    "demo.txt",
  );
  assert.equal(r2.sanitizeContentDispositionFilename("   \u0000  "), "file");
});

test("previewFile limits proxied text preview even when upstream ignores Range", async () => {
  const { MAX_PREVIEW_RESPONSE_BYTES } = loadModule(
    "services/previewResponsePolicy.js",
  );
  const { db } = createDb({
    firstHandlers: [
      {
        match: /SELECT[\s\S]*FROM files[\s\S]*WHERE id = \?[\s\S]*LIMIT 1/,
        value: {
          id: "file-1",
          owner_id: "user-1",
          filename: "demo.txt",
          r2_key: "flares3/config/demo.txt",
          content_type: "text/plain",
          expires_at: "9999-12-31T23:59:59.999Z",
          upload_status: "completed",
          config_id: null,
        },
      },
    ],
  });
  const { r2, files } = loadFilesRouteModules();

  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.generatePreviewUrl = async () => "https://preview.example.com/demo.txt";

  const originalFetch = global.fetch;
  let requestedRange = "";
  global.fetch = async (_url, init = {}) => {
    requestedRange = String(init.headers?.Range || init.headers?.range || "");
    const payload = "x".repeat(MAX_PREVIEW_RESPONSE_BYTES + 4096);
    return new Response(payload, {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": String(payload.length),
      },
    });
  };

  try {
    const response = await files.previewFile(
      createAuthedGetRequest("https://example.com/api/files/file-1/preview"),
      { DB: db },
      "file-1",
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(body.length, MAX_PREVIEW_RESPONSE_BYTES);
    assert.equal(response.headers.get("Content-Length"), null);
    assert.equal(requestedRange, `bytes=0-${MAX_PREVIEW_RESPONSE_BYTES - 1}`);
  } finally {
    global.fetch = originalFetch;
  }
});
