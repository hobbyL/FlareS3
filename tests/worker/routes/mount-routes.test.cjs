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

function createAuthedDeleteRequest(url) {
  const request = new Request(url, { method: "DELETE" });
  request.user = {
    id: "admin-1",
    username: "root",
    role: "admin",
    status: "active",
    quota_bytes: 1024,
  };
  return request;
}

function createDb({ runHandlers = [] } = {}) {
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

function loadMountRouteModules() {
  clearModule("routes/mount.js");
  clearModule("services/r2.js");
  clearModule("services/storage/factory.js");

  const r2 = loadModule("services/r2.js");
  const storageFactory = loadModule("services/storage/factory.js");
  const mount = loadModule("routes/mount.js");
  return { r2, storageFactory, mount };
}

test("downloadMountedObject returns 404 when the mounted object does not exist", async () => {
  const { r2, mount } = loadMountRouteModules();
  r2.loadR2ConfigById = async () => ({ id: "config-1", config: {} });
  r2.checkObjectExists = async () => false;
  r2.generateDownloadUrl = async () => "https://download.example.com/object";

  const response = await mount.downloadMountedObject(
    createGetRequest(
      "https://example.com/api/mount/download?config_id=config-1&key=demo.txt",
    ),
    { DB: {} },
  );

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Location"), null);
  assert.deepEqual(await response.json(), { error: "对象不存在" });
});

test("downloadMountedObject rejects parent-directory traversal before loading provider", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  let providerLoaded = false;
  storageFactory.createProvider = async () => {
    providerLoaded = true;
    return null;
  };

  const response = await mount.downloadMountedObject(
    createGetRequest(
      "https://example.com/api/mount/download?config_id=config-1&key=../secret.txt",
    ),
    { DB: {} },
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.match(payload.error, /\. 或 \.\./);
  assert.equal(providerLoaded, false);
});

test("createMountedFolder rejects absolute paths before loading provider", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  let providerLoaded = false;
  storageFactory.createProvider = async () => {
    providerLoaded = true;
    return null;
  };
  const request = new Request("https://example.com/api/mount/folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config_id: "config-1", key: "/rooted" }),
  });
  request.user = {
    id: "admin-1",
    username: "root",
    role: "admin",
    status: "active",
    quota_bytes: 1024,
  };

  const response = await mount.createMountedFolder(request, { DB: {} });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.match(payload.error, /不能以 \/ 开头/);
  assert.equal(providerLoaded, false);
});

test("createMountedFolder rejects oversized JSON body before loading provider", async () => {
  const { MAX_JSON_REQUEST_BODY_BYTES } = loadModule(
    "services/requestBodyPolicy.js",
  );
  const { storageFactory, mount } = loadMountRouteModules();
  let providerLoaded = false;
  storageFactory.createProvider = async () => {
    providerLoaded = true;
    return null;
  };
  const request = new Request("https://example.com/api/mount/folder", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(MAX_JSON_REQUEST_BODY_BYTES + 1),
    },
    body: "{}",
  });
  request.user = {
    id: "admin-1",
    username: "root",
    role: "admin",
    status: "active",
    quota_bytes: 1024,
  };

  const response = await mount.createMountedFolder(request, { DB: {} });
  const payload = await response.json();

  assert.equal(response.status, 413);
  assert.match(payload.error, /JSON 请求体大小超过限制/);
  assert.equal(providerLoaded, false);
});

test("previewMountedObject returns 404 when the mounted object does not exist", async () => {
  const { r2, mount } = loadMountRouteModules();
  r2.loadR2ConfigById = async () => ({ id: "config-1", config: {} });
  r2.checkObjectExists = async () => false;
  r2.generatePreviewUrl = async () => "https://preview.example.com/object";

  const response = await mount.previewMountedObject(
    createGetRequest(
      "https://example.com/api/mount/preview?config_id=config-1&key=image.png",
    ),
    { DB: {} },
  );

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Location"), null);
  assert.deepEqual(await response.json(), { error: "对象不存在" });
});

test("previewMountedObject limits proxied text preview from storage providers", async () => {
  const { MAX_PREVIEW_RESPONSE_BYTES } = loadModule(
    "services/previewResponsePolicy.js",
  );
  const { storageFactory, mount } = loadMountRouteModules();
  const payload = "x".repeat(MAX_PREVIEW_RESPONSE_BYTES + 4096);

  storageFactory.createProvider = async () => ({
    async checkExists() {
      return true;
    },
    async preview() {
      return {
        kind: "proxy",
        response: new Response(payload, {
          status: 200,
          headers: {
            "Content-Type": "text/plain",
            "Content-Length": String(payload.length),
          },
        }),
      };
    },
  });

  const response = await mount.previewMountedObject(
    createGetRequest(
      "https://example.com/api/mount/preview?config_id=config-1&key=demo.txt",
    ),
    { DB: {} },
  );
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(body.length, MAX_PREVIEW_RESPONSE_BYTES);
  assert.equal(response.headers.get("Content-Length"), null);
  assert.equal(
    response.headers.get("Content-Type"),
    "text/plain; charset=utf-8",
  );
});

test("deleteMountedObject returns 404 when the mounted object does not exist", async () => {
  const { db, state } = createDb({
    runHandlers: [
      {
        match: /INSERT INTO audit_logs/,
        value: { meta: { changes: 1 } },
      },
    ],
  });
  const { r2, mount } = loadMountRouteModules();
  let deleteCalled = false;
  r2.loadR2ConfigById = async () => ({ id: "config-1", config: {} });
  r2.checkObjectExists = async () => false;
  r2.deleteObject = async () => {
    deleteCalled = true;
  };

  const response = await mount.deleteMountedObject(
    createAuthedDeleteRequest(
      "https://example.com/api/mount/object?config_id=config-1&key=missing.txt",
    ),
    { DB: db },
  );

  assert.equal(response.status, 404);
  assert.equal(deleteCalled, false);
  assert.equal(state.runs.length, 0);
  assert.deepEqual(await response.json(), { error: "对象不存在" });
});
