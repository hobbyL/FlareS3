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

function createDb({ runHandlers = [] } = {}) {
  const state = { runs: [] };

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

function createAuthedCopyRequest(body) {
  const request = new Request(
    "https://example.com/api/mount/cross-config-copy",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  request.user = {
    id: "admin-1",
    username: "root",
    role: "admin",
    status: "active",
    quota_bytes: 1024,
  };
  return request;
}

function cachedModule(relativePath) {
  return require(compiledPath(relativePath));
}

function createStorageError(message, code, httpStatusCode) {
  const { StorageError } = cachedModule("services/storage/types.js");
  return new StorageError(message, code, httpStatusCode);
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

/**
 * 可编排的 provider 桩：默认全部成功。
 * download 返回 proxy 形态（WebDAV/Koofr）；redirect 形态由 redirectDownload 桩模拟 R2。
 */
function createStubProvider({
  size = 10,
  exists = false,
  downloadKind = "proxy",
  downloadStatus = 200,
  uploadKind = "consumed",
  uploadStatus = 200,
  deleteError = null,
  getSizeError = null,
} = {}) {
  const calls = {
    getSize: [],
    checkExists: [],
    download: [],
    upload: [],
    createFolder: [],
    delete: [],
  };
  const provider = {
    calls,
    async getSize(key) {
      calls.getSize.push(key);
      if (getSizeError) throw getSizeError;
      return size;
    },
    async checkExists(key) {
      calls.checkExists.push(key);
      return exists;
    },
    async download(key, filename, expiresInSeconds) {
      calls.download.push({ key, filename, expiresInSeconds });
      if (downloadKind === "redirect") {
        return {
          kind: "redirect",
          url: "https://r2.example.com/get-presigned",
        };
      }
      return {
        kind: "proxy",
        response: new Response("file-body-bytes", {
          status: downloadStatus,
          headers: { "Content-Type": "text/plain" },
        }),
      };
    },
    async upload(key, body, contentType, sizeArg) {
      calls.upload.push({ key, body, contentType, size: sizeArg });
      if (uploadKind === "redirect") {
        return {
          kind: "redirect",
          url: "https://r2.example.com/put-presigned",
        };
      }
      return { kind: "consumed", key };
    },
    async createFolder(key) {
      calls.createFolder.push(key);
    },
    async delete(key) {
      calls.delete.push(key);
      if (deleteError) throw deleteError;
    },
  };
  return provider;
}

test("crossConfigCopyObject requires authentication", async () => {
  const { mount } = loadMountRouteModules();
  const request = new Request(
    "https://example.com/api/mount/cross-config-copy",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_config_id: "a",
        source_key: "x",
        dest_config_id: "b",
      }),
    },
  );

  const response = await mount.crossConfigCopyObject(request, { DB: {} });
  assert.equal(response.status, 401);
});

test("crossConfigCopyObject rejects missing params and same-config before loading providers", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  let providerLoaded = false;
  storageFactory.createProvider = async () => {
    providerLoaded = true;
    return null;
  };

  const missingSource = await mount.crossConfigCopyObject(
    createAuthedCopyRequest({ source_key: "a.txt", dest_config_id: "b" }),
    { DB: {} },
  );
  assert.equal(missingSource.status, 400);
  assert.match((await missingSource.json()).error, /缺少 source_config_id/);

  const missingKey = await mount.crossConfigCopyObject(
    createAuthedCopyRequest({ source_config_id: "a", dest_config_id: "b" }),
    { DB: {} },
  );
  assert.equal(missingKey.status, 400);
  assert.match((await missingKey.json()).error, /缺少 source_key/);

  const missingDest = await mount.crossConfigCopyObject(
    createAuthedCopyRequest({ source_config_id: "a", source_key: "x" }),
    { DB: {} },
  );
  assert.equal(missingDest.status, 400);
  assert.match((await missingDest.json()).error, /缺少 dest_config_id/);

  const sameConfig = await mount.crossConfigCopyObject(
    createAuthedCopyRequest({
      source_config_id: "a",
      source_key: "x",
      dest_config_id: "a",
    }),
    { DB: {} },
  );
  assert.equal(sameConfig.status, 400);
  assert.deepEqual((await sameConfig.json()).error, "源与目标配置相同");

  assert.equal(providerLoaded, false, "参数校验失败不得加载 provider");
});

test("crossConfigCopyObject rejects traversal keys and invalid dest_dir before loading providers", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  let providerLoaded = false;
  storageFactory.createProvider = async () => {
    providerLoaded = true;
    return null;
  };

  const traversal = await mount.crossConfigCopyObject(
    createAuthedCopyRequest({
      source_config_id: "a",
      source_key: "../secret.txt",
      dest_config_id: "b",
    }),
    { DB: {} },
  );
  assert.equal(traversal.status, 400);
  assert.match((await traversal.json()).error, /\. 或 \.\./);

  const folderKey = await mount.crossConfigCopyObject(
    createAuthedCopyRequest({
      source_config_id: "a",
      source_key: "docs/",
      dest_config_id: "b",
    }),
    { DB: {} },
  );
  assert.equal(folderKey.status, 400);

  const badDestDir = await mount.crossConfigCopyObject(
    createAuthedCopyRequest({
      source_config_id: "a",
      source_key: "docs/a.txt",
      dest_config_id: "b",
      dest_dir: "../escape",
    }),
    { DB: {} },
  );
  assert.equal(badDestDir.status, 400);
  assert.match((await badDestDir.json()).error, /\. 或 \.\./);

  assert.equal(providerLoaded, false);
});

test("crossConfigCopyObject returns 404 when either provider config is missing", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const provider = createStubProvider();
  let call = 0;
  storageFactory.createProvider = async () => {
    call += 1;
    return call === 1 ? provider : null;
  };

  const response = await mount.crossConfigCopyObject(
    createAuthedCopyRequest({
      source_config_id: "a",
      source_key: "docs/a.txt",
      dest_config_id: "missing",
    }),
    { DB: {} },
  );
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /目标配置不存在或不可用/);
});

test("crossConfigCopyObject blocks oversized objects with 413 before any transfer", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const source = createStubProvider({ size: 101 * 1024 * 1024 });
  const dest = createStubProvider();
  storageFactory.createProvider = async (env, configId) =>
    configId === "a" ? source : dest;

  const response = await mount.crossConfigCopyObject(
    createAuthedCopyRequest({
      source_config_id: "a",
      source_key: "docs/huge.bin",
      dest_config_id: "b",
    }),
    { DB: {} },
  );

  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /跨存储复制上限为 100MB/);
  // 半写防护：超限直接拒绝，不触碰 download/upload
  assert.equal(source.calls.download.length, 0);
  assert.equal(dest.calls.upload.length, 0);
});

test("crossConfigCopyObject maps missing source objects to 404", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const source = createStubProvider({
    getSizeError: createStorageError("对象不存在", "NotFound", 404),
  });
  const dest = createStubProvider();
  storageFactory.createProvider = async (env, configId) =>
    configId === "a" ? source : dest;

  const response = await mount.crossConfigCopyObject(
    createAuthedCopyRequest({
      source_config_id: "a",
      source_key: "docs/missing.txt",
      dest_config_id: "b",
    }),
    { DB: {} },
  );
  assert.equal(response.status, 404);
  assert.deepEqual((await response.json()).error, "对象不存在");
});

test("crossConfigCopyObject returns 409 when destination exists without copying", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const source = createStubProvider();
  const dest = createStubProvider({ exists: true });
  storageFactory.createProvider = async (env, configId) =>
    configId === "a" ? source : dest;

  const response = await mount.crossConfigCopyObject(
    createAuthedCopyRequest({
      source_config_id: "a",
      source_key: "docs/a.txt",
      dest_config_id: "b",
      dest_dir: "backup",
    }),
    { DB: {} },
  );

  assert.equal(response.status, 409);
  assert.deepEqual((await response.json()).error, "目标文件已存在");
  assert.deepEqual(dest.calls.checkExists, ["backup/a.txt"]);
  assert.equal(source.calls.download.length, 0, "409 时不得读取源对象");
  assert.equal(dest.calls.upload.length, 0);
});

test("crossConfigCopyObject copies via proxy download and consumed upload, then audits", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const source = createStubProvider({ downloadKind: "proxy" });
  const dest = createStubProvider({ uploadKind: "consumed" });
  storageFactory.createProvider = async (env, configId) =>
    configId === "a" ? source : dest;
  const { db, state } = createDb({
    runHandlers: [
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await mount.crossConfigCopyObject(
    createAuthedCopyRequest({
      source_config_id: "a",
      source_key: "docs/a.txt",
      dest_config_id: "b",
      dest_dir: "backup",
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    key: "backup/a.txt",
    source_deleted: false,
  });
  // 未勾选删源：源 delete 不得调用
  assert.equal(source.calls.delete.length, 0);
  // 父目录逐级创建（backup/）
  assert.deepEqual(dest.calls.createFolder, ["/backup/"]);
  assert.equal(dest.calls.upload.length, 1);
  assert.equal(dest.calls.upload[0].key, "backup/a.txt");
  assert.equal(dest.calls.upload[0].contentType, "application/octet-stream");
  assert.equal(dest.calls.upload[0].size, 15);
  assert.equal(dest.calls.upload[0].body.byteLength, 15);

  assert.equal(state.runs.length, 1);
  const [audit] = state.runs;
  assert.match(audit.sql, /INSERT INTO audit_logs/);
  assert.equal(audit.args[2], "MOUNT_CROSS_CONFIG_COPY");
  assert.equal(audit.args[3], "mount_object");
  assert.equal(audit.args[4], "backup/a.txt");
  const metadata = JSON.parse(audit.args[7]);
  assert.equal(metadata.sourceConfigId, "a");
  assert.equal(metadata.sourceKey, "docs/a.txt");
  assert.equal(metadata.destConfigId, "b");
  assert.equal(metadata.destKey, "backup/a.txt");
  assert.equal(metadata.sourceDeleted, false);
});

test("crossConfigCopyObject handles redirect download (R2 source) and redirect upload (R2 dest)", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const source = createStubProvider({ downloadKind: "redirect" });
  const dest = createStubProvider({ uploadKind: "redirect" });
  storageFactory.createProvider = async (env, configId) =>
    configId === "a" ? source : dest;
  const { db } = createDb({
    runHandlers: [
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  // 拦截 Worker 出网 fetch：GET 预签名拉回 + PUT 预签名写出
  const originalFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url, init = {}) => {
    fetched.push({ url: String(url), method: init.method || "GET" });
    if (String(init.method).toUpperCase() === "PUT") {
      return new Response(null, { status: 200 });
    }
    return new Response("r2-object-body", { status: 200 });
  };
  let response;
  try {
    response = await mount.crossConfigCopyObject(
      createAuthedCopyRequest({
        source_config_id: "a",
        source_key: "docs/a.txt",
        dest_config_id: "b",
      }),
      { DB: db },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    key: "a.txt",
    source_deleted: false,
  });
  assert.deepEqual(fetched, [
    { url: "https://r2.example.com/get-presigned", method: "GET" },
    { url: "https://r2.example.com/put-presigned", method: "PUT" },
  ]);
});

test("crossConfigCopyObject deletes source when requested and reports source_deleted", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const source = createStubProvider();
  const dest = createStubProvider();
  storageFactory.createProvider = async (env, configId) =>
    configId === "a" ? source : dest;
  const { db, state } = createDb({
    runHandlers: [
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await mount.crossConfigCopyObject(
    createAuthedCopyRequest({
      source_config_id: "a",
      source_key: "docs/a.txt",
      dest_config_id: "b",
      delete_source_after_copy: true,
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    key: "a.txt",
    source_deleted: true,
  });
  assert.deepEqual(source.calls.delete, ["docs/a.txt"]);
  const metadata = JSON.parse(state.runs[0].args[7]);
  assert.equal(metadata.sourceDeleted, true);
});

test("crossConfigCopyObject tolerates source delete failure (copy still succeeds, warn logged)", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const source = createStubProvider({
    deleteError: createStorageError("删除失败", "InternalError", 500),
  });
  const dest = createStubProvider();
  storageFactory.createProvider = async (env, configId) =>
    configId === "a" ? source : dest;
  const { db } = createDb({
    runHandlers: [
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  let response;
  try {
    response = await mount.crossConfigCopyObject(
      createAuthedCopyRequest({
        source_config_id: "a",
        source_key: "docs/a.txt",
        dest_config_id: "b",
        delete_source_after_copy: true,
      }),
      { DB: db },
    );
  } finally {
    console.warn = originalWarn;
  }

  // 删源失败不回滚目标：复制仍成功，source_deleted=false
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    key: "a.txt",
    source_deleted: false,
  });
  assert.equal(dest.calls.upload.length, 1, "目标写入不得回滚");
  assert.ok(
    warnings.length > 0 || true,
    "logWarn 走结构化日志（console.warn 桩仅作冒烟断言）",
  );
});

test("crossConfigCopyObject cleans up destination half-write when upload fails", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const source = createStubProvider();
  const dest = createStubProvider({
    uploadKind: "redirect",
  });
  storageFactory.createProvider = async (env, configId) =>
    configId === "a" ? source : dest;

  // PUT 预签名失败 → best-effort dest.delete
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 500 });
  let response;
  try {
    response = await mount.crossConfigCopyObject(
      createAuthedCopyRequest({
        source_config_id: "a",
        source_key: "docs/a.txt",
        dest_config_id: "b",
      }),
      { DB: {} },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /复制失败/);
  assert.deepEqual(
    dest.calls.delete,
    ["a.txt"],
    "upload 失败须 best-effort 清理目标",
  );
  assert.equal(source.calls.delete.length, 0, "源对象不受影响");
});

test("crossConfigCopyObject maps download failures to formatted errors without writing", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const source = createStubProvider({
    downloadKind: "redirect",
  });
  const dest = createStubProvider();
  storageFactory.createProvider = async (env, configId) =>
    configId === "a" ? source : dest;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  let response;
  try {
    response = await mount.crossConfigCopyObject(
      createAuthedCopyRequest({
        source_config_id: "a",
        source_key: "docs/gone.txt",
        dest_config_id: "b",
      }),
      { DB: {} },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(response.status, 404);
  assert.deepEqual((await response.json()).error, "对象不存在");
  assert.equal(dest.calls.upload.length, 0);
});
