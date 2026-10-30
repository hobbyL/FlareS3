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

// 任何触达存储凭据 / endpoint 的端点都必须在读取 D1 之前拒绝 PAT。
function createRejectingDb() {
  const reject = () => {
    throw new Error(
      "storage credentials endpoint must reject PAT before touching D1",
    );
  };
  return { prepare: reject, batch: reject };
}

const PAT_ADMIN = {
  id: "admin-1",
  username: "root",
  role: "admin",
  status: "active",
  quota_bytes: 1024,
};

const FORBIDDEN_BODY = { error: "此操作需会话登录，不支持 API Token" };

function patRequest(url, { method = "GET" } = {}) {
  return Object.assign(new Request(url, { method }), {
    user: PAT_ADMIN,
    authKind: "pat",
  });
}

function assertForbidden(response, label) {
  assert.equal(response.status, 403, `${label} 应返回 403`);
  return response.json().then((body) => {
    assert.deepEqual(body, FORBIDDEN_BODY, `${label} 的拒绝文案应保持一致`);
  });
}

const SENSITIVE_ENDPOINTS = [
  ["routes/storageConfigs.js", "getConfigSecrets", "GET", "cfg-1"],
  ["routes/storageConfigs.js", "revealConfigSecrets", "GET", "cfg-1"],
  ["routes/r2Configs.js", "createConfig", "POST", undefined],
  ["routes/r2Configs.js", "updateConfig", "PATCH", "cfg-1"],
  ["routes/r2Configs.js", "deleteConfig", "DELETE", "cfg-1"],
  ["routes/r2Configs.js", "setDefault", "POST", undefined],
  ["routes/r2Configs.js", "setLegacyFiles", "POST", undefined],
  ["routes/r2Configs.js", "testById", "POST", "cfg-1"],
  ["routes/webdavConfigs.js", "createConfig", "POST", undefined],
  ["routes/webdavConfigs.js", "updateConfig", "PATCH", "cfg-1"],
  ["routes/webdavConfigs.js", "deleteConfig", "DELETE", "cfg-1"],
  ["routes/webdavConfigs.js", "testById", "POST", "cfg-1"],
  ["routes/setup.js", "saveConfig", "POST", undefined],
  ["routes/setup.js", "testConfig", "POST", undefined],
];

for (const [modulePath, handlerName, method, id] of SENSITIVE_ENDPOINTS) {
  test(`${handlerName} 以 PAT 访问返回 403 且不触达 D1`, async () => {
    const module = loadModule(modulePath);
    const handler = module[handlerName];
    assert.equal(
      typeof handler,
      "function",
      `${modulePath} 应导出 ${handlerName}`,
    );

    const response = await handler(
      patRequest(`https://example.com/api/${handlerName}`, { method }),
      { DB: createRejectingDb(), R2_MASTER_KEY: "" },
      ...(id === undefined ? [] : [id]),
    );

    await assertForbidden(response, handlerName);
  });
}

test("存储凭据端点对会话登录（非 PAT）仍然放行到业务逻辑", async () => {
  const { getConfigSecrets } = loadModule("routes/storageConfigs.js");
  let touched = false;
  const db = {
    // loadR2ConfigById 内部 try/catch 会吞掉这里的异常并返回 null，
    // 端点据此返回 404 —— 这恰好证明请求已经越过 PAT 守卫、进入了业务逻辑。
    prepare() {
      touched = true;
      throw new Error("reached business logic");
    },
    batch() {
      touched = true;
      throw new Error("reached business logic");
    },
  };
  // 带上 type=r2，否则会在参数校验处短路返回 400，触达不到 DB。
  const sessionRequest = Object.assign(
    new Request(
      "https://example.com/api/storage/configs/cfg-1/secrets?type=r2",
      { method: "GET" },
    ),
    { user: PAT_ADMIN, authKind: "session" },
  );

  const response = await getConfigSecrets(
    sessionRequest,
    // 提供 R2_MASTER_KEY，否则 loadR2ConfigById 会在解密前直接返回 null，
    // 根本不会触达 DB，`touched` 就无法证明守卫已放行。
    { DB: db, R2_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
    "cfg-1",
  );

  assert.equal(
    touched,
    true,
    "会话登录必须能进入业务逻辑，不能被 PAT 守卫误伤",
  );
  // 关键断言：走的不是 403（PAT 拒绝），而是进入了业务逻辑后的失败
  // （mock DB 抛错 → loadR2ConfigById 的 catch 分支返回 500 / 或未命中返回 404）。
  assert.notEqual(response.status, 403, "会话登录不应被 PAT 守卫拦下");
});
