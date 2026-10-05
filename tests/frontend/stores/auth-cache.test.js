import test from "node:test";
import assert from "node:assert/strict";

import { useFreshPinia } from "../helpers/pinia.js";

const api = (await import("../../../frontend/src/services/api.js")).default;
const { useAuthStore } = await import("../../../frontend/src/stores/auth.js");
const { useUserOptionsStore } =
  await import("../../../frontend/src/stores/userOptions.js");
const { useStorageConfigsStore } =
  await import("../../../frontend/src/stores/storageConfigs.js");

const realGetAuthStatus = api.getAuthStatus;
const realLogin = api.login;
const realLogout = api.logout;
const realNow = Date.now;

function setup() {
  useFreshPinia();
  Date.now = realNow;
  api.getAuthStatus = realGetAuthStatus;
  api.login = realLogin;
  api.logout = realLogout;
  const store = useAuthStore();
  // 模块级的在途请求/缓存代次是跨实例共享的，逐用例重置
  store.invalidate();
  return store;
}

function stubAuthStatus(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  api.getAuthStatus = async () => {
    calls.push(Date.now());
    const next = queue ? queue.shift() : responses;
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  return calls;
}

const AUTHENTICATED = {
  authenticated: true,
  user: { id: "u1", role: "admin" },
};

test("checkAuth 首次调用请求接口并写入缓存时间", async () => {
  const store = setup();
  const calls = stubAuthStatus(AUTHENTICATED);

  assert.equal(await store.checkAuth(), true);

  assert.equal(calls.length, 1);
  assert.equal(store.isAuthenticated, true);
  assert.deepEqual(store.user, { id: "u1", role: "admin" });
  assert.ok(store.checkedAt > 0);
  assert.equal(store.isAdmin, true);
});

test("已登录结果在 5 分钟内命中缓存，不再打接口", async () => {
  const store = setup();
  const calls = stubAuthStatus(AUTHENTICATED);

  await store.checkAuth();
  await store.checkAuth();
  await store.checkAuth();

  assert.equal(calls.length, 1, "缓存期内应只请求一次");
  assert.equal(store.isFresh(), true);
});

test("缓存过期后重新校验登录态", async () => {
  const store = setup();
  const calls = stubAuthStatus(AUTHENTICATED);

  let clock = 1_000_000;
  Date.now = () => clock;

  await store.checkAuth();
  assert.equal(calls.length, 1);

  clock += 5 * 60 * 1000 - 1;
  await store.checkAuth();
  assert.equal(calls.length, 1, "刚好未到 5 分钟仍走缓存");

  clock += 2;
  await store.checkAuth();
  assert.equal(calls.length, 2, "超过 5 分钟必须重新校验");
});

test("force 选项跳过缓存", async () => {
  const store = setup();
  const calls = stubAuthStatus(AUTHENTICATED);

  await store.checkAuth();
  await store.checkAuth({ force: true });

  assert.equal(calls.length, 2);
});

test("自定义 ttlMs 生效", async () => {
  const store = setup();
  const calls = stubAuthStatus(AUTHENTICATED);

  let clock = 2_000_000;
  Date.now = () => clock;

  await store.checkAuth();
  clock += 1_000;
  await store.checkAuth({ ttlMs: 500 });

  assert.equal(calls.length, 2, "自定义 TTL 更短时应重新校验");
});

test("force 在非强制校验在途时另起新请求，作废的旧响应不覆盖强制结果", async () => {
  const store = setup();
  const resolvers = [];
  let calls = 0;
  api.getAuthStatus = () =>
    new Promise((resolve) => {
      resolvers.push(resolve);
      calls += 1;
    });

  const first = store.checkAuth(); // 非强制，在途
  const second = store.checkAuth({ force: true }); // 强制：不得复用在途请求
  assert.equal(calls, 2, "force 不应复用在途的非强制校验");

  resolvers[1]({ authenticated: true, user: { id: "forced", role: "admin" } });
  await second;
  assert.deepEqual(store.user, { id: "forced", role: "admin" });

  resolvers[0]({ authenticated: true, user: { id: "stale", role: "user" } });
  await first;
  assert.deepEqual(
    store.user,
    { id: "forced", role: "admin" },
    "作废的在途响应不得回写强制校验结果",
  );
});

test("并发 checkAuth 共享同一次请求", async () => {
  const store = setup();
  let resolveStatus;
  let calls = 0;
  api.getAuthStatus = () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveStatus = resolve;
    });
  };

  const pending = [store.checkAuth(), store.checkAuth(), store.checkAuth()];
  assert.equal(calls, 1, "在途期间不应重复发起请求");

  resolveStatus(AUTHENTICATED);
  assert.deepEqual(await Promise.all(pending), [true, true, true]);
});

test("未登录结果不写入缓存，下一次仍会重新校验", async () => {
  const store = setup();
  const calls = stubAuthStatus([
    { authenticated: false },
    { authenticated: false },
  ]);

  assert.equal(await store.checkAuth(), false);
  assert.equal(store.checkedAt, 0, "未登录状态不应被缓存");
  assert.equal(store.isFresh(), false);

  assert.equal(await store.checkAuth(), false);
  assert.equal(calls.length, 2);
});

test("接口异常时降级为登出且不缓存", async () => {
  const store = setup();
  const calls = stubAuthStatus([new Error("offline"), AUTHENTICATED]);

  assert.equal(await store.checkAuth(), false);
  assert.equal(store.isAuthenticated, false);
  assert.equal(store.user, null);
  assert.equal(store.checkedAt, 0);

  assert.equal(await store.checkAuth(), true, "恢复后应能重新校验成功");
  assert.equal(calls.length, 2);
});

test("checkAuth 网络失败（无响应的 axios 错误）保留本地认证态", async () => {
  const store = setup();
  stubAuthStatus(AUTHENTICATED);
  await store.checkAuth();
  assert.equal(store.isAuthenticated, true);

  // 模拟 axios 网络错误：isAxiosError 标记 + 无 response
  const networkError = new Error("Network Error");
  networkError.isAxiosError = true;
  stubAuthStatus([networkError]);

  assert.equal(
    await store.checkAuth({ force: true }),
    true,
    "网络失败应沿用本地认证态返回 true（守卫照常放行）",
  );
  assert.equal(store.isAuthenticated, true, "网络失败不应登出");
  assert.deepEqual(store.user, { id: "u1", role: "admin" });
});

test("checkAuth 收到带响应的 401 错误仍按确认未登录登出", async () => {
  const store = setup();
  stubAuthStatus(AUTHENTICATED);
  await store.checkAuth();

  const httpError = new Error("Request failed with status code 401");
  httpError.isAxiosError = true;
  httpError.response = { status: 401, data: {} };
  stubAuthStatus([httpError]);

  assert.equal(await store.checkAuth({ force: true }), false);
  assert.equal(store.isAuthenticated, false, "有响应的失败仍应登出");
  assert.equal(store.user, null);
});

test("logout 与 login 成功均连带失效存储配置缓存", async () => {
  const store = setup();
  stubAuthStatus(AUTHENTICATED);
  api.logout = async () => ({ success: true });

  await store.checkAuth();
  const storageConfigs = useStorageConfigsStore();
  storageConfigs.configs = [{ id: "c1", name: "配置" }];
  storageConfigs.loadedAt = Date.now();

  await store.logout();
  assert.deepEqual(storageConfigs.configs, [], "登出应清空存储配置缓存");
  assert.equal(storageConfigs.loadedAt, 0);

  // login 成功路径同样失效（切换账号后不得残留上一账号的配置列表）
  storageConfigs.configs = [{ id: "c2", name: "另一账号配置" }];
  storageConfigs.loadedAt = Date.now();
  api.login = async () => ({
    success: true,
    user: { id: "u2", role: "user" },
  });

  await store.login("bob", "pw");
  assert.deepEqual(storageConfigs.configs, [], "登录成功应清空存储配置缓存");
  assert.equal(storageConfigs.loadedAt, 0);
});

test("login 成功后直接写入缓存，无需额外请求 /auth/status", async () => {
  const store = setup();
  const calls = stubAuthStatus(AUTHENTICATED);
  api.login = async () => ({
    success: true,
    user: { id: "u2", role: "user" },
  });

  assert.deepEqual(await store.login("alice", "pw"), { success: true });
  assert.equal(store.isAuthenticated, true);
  assert.ok(store.checkedAt > 0);

  assert.equal(await store.checkAuth(), true);
  assert.equal(calls.length, 0, "登录已带回用户信息，不应再打状态接口");
});

test("login 失败不建立缓存", async () => {
  const store = setup();
  api.login = async () => ({
    success: false,
    message: "密码错误",
    code: "INVALID_CREDENTIALS",
  });

  assert.deepEqual(await store.login("alice", "bad"), {
    success: false,
    message: "密码错误",
    code: "INVALID_CREDENTIALS",
  });
  assert.equal(store.isAuthenticated, false);
  assert.equal(store.checkedAt, 0);
});

test("logout 清空缓存并连带失效用户选项缓存", async () => {
  const store = setup();
  stubAuthStatus(AUTHENTICATED);
  api.logout = async () => ({ success: true });

  await store.checkAuth();
  const userOptions = useUserOptionsStore();
  userOptions.users = [{ id: "u1" }];
  userOptions.loadedAt = Date.now();

  await store.logout();

  assert.equal(store.isAuthenticated, false);
  assert.equal(store.user, null);
  assert.equal(store.checkedAt, 0);
  assert.equal(store.isFresh(), false);
  assert.deepEqual(userOptions.users, []);
  assert.equal(userOptions.loadedAt, 0);
});

test("invalidate 使在途请求的结果失效", async () => {
  const store = setup();
  let resolveStatus;
  api.getAuthStatus = () =>
    new Promise((resolve) => {
      resolveStatus = resolve;
    });

  const pending = store.checkAuth();
  store.invalidate();
  resolveStatus(AUTHENTICATED);

  await pending;
  assert.equal(
    store.isAuthenticated,
    false,
    "invalidate 之后返回的旧响应不得回写状态",
  );
  assert.equal(store.checkedAt, 0);
});
