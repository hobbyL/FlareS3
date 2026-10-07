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

function createAuthedMoveRequest(body) {
  const request = new Request("https://example.com/api/mount/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  request.user = {
    id: "admin-1",
    username: "root",
    role: "admin",
    status: "active",
    quota_bytes: 1024,
  };
  return request;
}

// 不清缓存地取 types.js：routes 模块捕获的 StorageError 类必须与这里是同一实例，
// 否则 instanceof 判定失败
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

function createRecordingProvider({ exists = false, moveError = null } = {}) {
  const provider = {
    checkExistsCalls: [],
    moveCalls: [],
    async checkExists(key) {
      provider.checkExistsCalls.push(key);
      return exists;
    },
    async move(sourceKey, destKey, options) {
      provider.moveCalls.push({ sourceKey, destKey, options });
      if (moveError) throw moveError;
    },
  };
  return provider;
}

test("moveMountedObject requires authentication", async () => {
  const { mount } = loadMountRouteModules();
  const request = new Request("https://example.com/api/mount/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config_id: "config-1",
      key: "a.txt",
      new_name: "b.txt",
    }),
  });

  const response = await mount.moveMountedObject(request, { DB: {} });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "未授权" });
});

test("moveMountedObject rejects traversal keys before loading provider", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  let providerLoaded = false;
  storageFactory.createProvider = async () => {
    providerLoaded = true;
    return null;
  };

  const response = await mount.moveMountedObject(
    createAuthedMoveRequest({
      config_id: "config-1",
      key: "../secret.txt",
      new_name: "b.txt",
    }),
    { DB: {} },
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.match(payload.error, /\. 或 \.\./);
  assert.equal(providerLoaded, false);
});

test("moveMountedObject rejects folder keys (trailing slash) before loading provider", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  let providerLoaded = false;
  storageFactory.createProvider = async () => {
    providerLoaded = true;
    return null;
  };

  const response = await mount.moveMountedObject(
    createAuthedMoveRequest({
      config_id: "config-1",
      key: "docs/",
      new_name: "b.txt",
    }),
    { DB: {} },
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.match(payload.error, /不能以 \/ 结尾|路径不能以 \/ 结尾/);
  assert.equal(providerLoaded, false);
});

test("moveMountedObject rejects empty and absolute keys before loading provider", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  let providerLoaded = false;
  storageFactory.createProvider = async () => {
    providerLoaded = true;
    return null;
  };

  const empty = await mount.moveMountedObject(
    createAuthedMoveRequest({
      config_id: "config-1",
      key: " ",
      new_name: "b.txt",
    }),
    { DB: {} },
  );
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).error, /缺少 key/);

  const absolute = await mount.moveMountedObject(
    createAuthedMoveRequest({
      config_id: "config-1",
      key: "/rooted/a.txt",
      new_name: "b.txt",
    }),
    { DB: {} },
  );
  assert.equal(absolute.status, 400);
  assert.match((await absolute.json()).error, /不能以 \/ 开头/);

  assert.equal(providerLoaded, false);
});

test("moveMountedObject rejects invalid to_dir before loading provider", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  let providerLoaded = false;
  storageFactory.createProvider = async () => {
    providerLoaded = true;
    return null;
  };

  const response = await mount.moveMountedObject(
    createAuthedMoveRequest({
      config_id: "config-1",
      key: "docs/a.txt",
      to_dir: "../escape",
      new_name: "b.txt",
    }),
    { DB: {} },
  );

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /\. 或 \.\./);
  assert.equal(providerLoaded, false);
});

test("moveMountedObject rejects invalid new_name before loading provider", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  let providerLoaded = false;
  storageFactory.createProvider = async () => {
    providerLoaded = true;
    return null;
  };

  const response = await mount.moveMountedObject(
    createAuthedMoveRequest({
      config_id: "config-1",
      key: "docs/a.txt",
      new_name: "sub/b.txt",
    }),
    { DB: {} },
  );

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /路径分隔符/);
  assert.equal(providerLoaded, false);
});

test("moveMountedObject rejects identical source and destination", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const provider = createRecordingProvider();
  storageFactory.createProvider = async () => provider;

  const response = await mount.moveMountedObject(
    createAuthedMoveRequest({
      config_id: "config-1",
      key: "docs/a.txt",
      to_dir: "docs",
      new_name: "a.txt",
    }),
    { DB: {} },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "目标与源相同" });
  assert.equal(provider.moveCalls.length, 0);
});

test("moveMountedObject returns 409 when the destination exists without moving", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const provider = createRecordingProvider({ exists: true });
  storageFactory.createProvider = async () => provider;

  const response = await mount.moveMountedObject(
    createAuthedMoveRequest({
      config_id: "config-1",
      key: "docs/a.txt",
      to_dir: "archive/",
      new_name: "b.txt",
    }),
    { DB: {} },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "目标文件已存在" });
  assert.deepEqual(provider.checkExistsCalls, ["archive/b.txt"]);
  assert.equal(provider.moveCalls.length, 0);
});

test("moveMountedObject returns 404 when the provider config is missing", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  storageFactory.createProvider = async () => null;

  const response = await mount.moveMountedObject(
    createAuthedMoveRequest({
      config_id: "missing",
      key: "docs/a.txt",
      new_name: "b.txt",
    }),
    { DB: {} },
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "配置不存在或不可用" });
});

test("moveMountedObject moves the object and audits MOUNT_OBJECT_MOVE", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const provider = createRecordingProvider();
  storageFactory.createProvider = async () => provider;
  const { db, state } = createDb({
    runHandlers: [
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await mount.moveMountedObject(
    createAuthedMoveRequest({
      config_id: "config-1",
      key: "docs/a.txt",
      to_dir: "archive/backup",
      new_name: "renamed.bin",
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    key: "archive/backup/renamed.bin",
  });
  assert.deepEqual(provider.checkExistsCalls, ["archive/backup/renamed.bin"]);
  assert.deepEqual(provider.moveCalls, [
    {
      sourceKey: "docs/a.txt",
      destKey: "archive/backup/renamed.bin",
      options: undefined,
    },
  ]);

  assert.equal(state.runs.length, 1);
  const [audit] = state.runs;
  assert.match(audit.sql, /INSERT INTO audit_logs/);
  assert.equal(audit.args[1], "admin-1");
  assert.equal(audit.args[2], "MOUNT_OBJECT_MOVE");
  assert.equal(audit.args[3], "mount_object");
  assert.equal(audit.args[4], "archive/backup/renamed.bin");
  assert.deepEqual(JSON.parse(audit.args[7]), {
    configId: "config-1",
    fromKey: "docs/a.txt",
    toKey: "archive/backup/renamed.bin",
  });
});

test("moveMountedObject moves to mount root when to_dir is empty", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const provider = createRecordingProvider();
  storageFactory.createProvider = async () => provider;
  const { db } = createDb({
    runHandlers: [
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await mount.moveMountedObject(
    createAuthedMoveRequest({
      config_id: "config-1",
      key: "docs/a.txt",
      new_name: "rooted.txt",
    }),
    { DB: db },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, key: "rooted.txt" });
  assert.deepEqual(provider.moveCalls, [
    { sourceKey: "docs/a.txt", destKey: "rooted.txt", options: undefined },
  ]);
});

test("moveMountedObject maps missing source objects to 404", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const provider = createRecordingProvider({
    moveError: createStorageError("对象不存在", "NotFound", 404),
  });
  storageFactory.createProvider = async () => provider;
  const { db, state } = createDb({
    runHandlers: [
      { match: /INSERT INTO audit_logs/, value: { meta: { changes: 1 } } },
    ],
  });

  const response = await mount.moveMountedObject(
    createAuthedMoveRequest({
      config_id: "config-1",
      key: "docs/missing.txt",
      new_name: "b.txt",
    }),
    { DB: db },
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "对象不存在" });
  assert.equal(state.runs.length, 0, "失败时不得写审计");
});

test("moveMountedObject maps provider conflict errors to 409", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const provider = createRecordingProvider({
    moveError: createStorageError("目标文件已存在", "Conflict", 409),
  });
  storageFactory.createProvider = async () => provider;

  const response = await mount.moveMountedObject(
    createAuthedMoveRequest({
      config_id: "config-1",
      key: "docs/a.txt",
      new_name: "b.txt",
    }),
    { DB: {} },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "目标文件已存在" });
});

test("moveMountedObject maps oversized objects to 413", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const provider = createRecordingProvider({
    moveError: createStorageError(
      "文件过大，超过 R2 复制上限（5GiB），请删除后重新上传到目标名称",
      "EntityTooLarge",
      413,
    ),
  });
  storageFactory.createProvider = async () => provider;

  const response = await mount.moveMountedObject(
    createAuthedMoveRequest({
      config_id: "config-1",
      key: "docs/huge.bin",
      new_name: "b.bin",
    }),
    { DB: {} },
  );

  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /5GiB/);
});

test("moveMountedObject maps generic provider failures to formatted 502", async () => {
  const { storageFactory, mount } = loadMountRouteModules();
  const provider = createRecordingProvider({
    moveError: new Error("upstream boom"),
  });
  storageFactory.createProvider = async () => provider;
  const originalError = console.error;
  console.error = () => {};
  let response;
  try {
    response = await mount.moveMountedObject(
      createAuthedMoveRequest({
        config_id: "config-1",
        key: "docs/a.txt",
        new_name: "b.txt",
      }),
      { DB: {} },
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /移动对象失败/);
});
