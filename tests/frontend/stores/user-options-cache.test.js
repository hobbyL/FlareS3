import test from "node:test";
import assert from "node:assert/strict";

import { useFreshPinia } from "../helpers/pinia.js";

const api = (await import("../../../frontend/src/services/api.js")).default;
const { useUserOptionsStore } =
  await import("../../../frontend/src/stores/userOptions.js");

const realGetUsers = api.getUsers;
const realNow = Date.now;

const USERS = [
  { id: "u1", username: "alice", status: "active" },
  { id: "u2", username: "bob", status: "deleted" },
  { id: "u3", username: "carol" },
];

function setup() {
  useFreshPinia();
  Date.now = realNow;
  api.getUsers = realGetUsers;
  const store = useUserOptionsStore();
  store.invalidate();
  return store;
}

function stubUsers(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  api.getUsers = async (params) => {
    calls.push(params);
    const next = queue ? queue.shift() : responses;
    if (next instanceof Error) throw next;
    return next;
  };
  return calls;
}

test("fetchActiveUsers 过滤掉已删除用户", async () => {
  const store = setup();
  const calls = stubUsers({ users: USERS });

  const users = await store.fetchActiveUsers();

  assert.deepEqual(calls[0], { page: 1, limit: 100 });
  assert.deepEqual(
    users.map((user) => user.id),
    ["u1", "u3"],
    "status 为 deleted 的用户不应出现在候选列表",
  );
  assert.ok(store.loadedAt > 0);
  assert.equal(store.loading, false);
});

test("响应缺少 users 字段时降级为空数组", async () => {
  const store = setup();
  stubUsers({});
  assert.deepEqual(await store.fetchActiveUsers(), []);
});

test("5 分钟内命中缓存，过期后重新拉取", async () => {
  const store = setup();
  const calls = stubUsers([{ users: USERS }, { users: USERS }]);

  let clock = 3_000_000;
  Date.now = () => clock;

  await store.fetchActiveUsers();
  clock += 5 * 60 * 1000 - 1;
  await store.fetchActiveUsers();
  assert.equal(calls.length, 1, "未到 5 分钟应命中缓存");

  clock += 2;
  await store.fetchActiveUsers();
  assert.equal(calls.length, 2);
});

test("force 与自定义 ttlMs 可绕过缓存", async () => {
  const store = setup();
  const calls = stubUsers([
    { users: USERS },
    { users: USERS },
    { users: USERS },
  ]);

  let clock = 4_000_000;
  Date.now = () => clock;

  await store.fetchActiveUsers();
  await store.fetchActiveUsers({ force: true });
  assert.equal(calls.length, 2);

  clock += 1_000;
  await store.fetchActiveUsers({ ttlMs: 500 });
  assert.equal(calls.length, 3);
});

test("force 在非强制请求在途时另起新请求，作废的旧响应不覆盖强制结果", async () => {
  const store = setup();
  const resolvers = [];
  let calls = 0;
  api.getUsers = () =>
    new Promise((resolve) => {
      resolvers.push(resolve);
      calls += 1;
    });

  const first = store.fetchActiveUsers(); // 非强制，在途
  const second = store.fetchActiveUsers({ force: true }); // 强制：不得复用在途请求
  assert.equal(calls, 2, "force 不应复用在途的非强制请求");

  resolvers[1]({ users: [{ id: "forced", status: "active" }] });
  await second;
  assert.deepEqual(
    store.users.map((user) => user.id),
    ["forced"],
  );

  resolvers[0]({ users: [{ id: "stale", status: "active" }] });
  await first;
  assert.deepEqual(
    store.users.map((user) => user.id),
    ["forced"],
    "作废的在途响应不得回写强制刷新结果",
  );
});

test("并发调用共享同一次请求", async () => {
  const store = setup();
  let resolveUsers;
  let calls = 0;
  api.getUsers = () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveUsers = resolve;
    });
  };

  const pending = [store.fetchActiveUsers(), store.fetchActiveUsers()];
  assert.equal(calls, 1);
  assert.equal(store.loading, true);

  resolveUsers({ users: USERS });
  const [a, b] = await Promise.all(pending);

  assert.deepEqual(a, b);
  assert.equal(store.loading, false);
});

test("invalidate 清空缓存并使在途响应失效", async () => {
  const store = setup();
  let resolveUsers;
  api.getUsers = () =>
    new Promise((resolve) => {
      resolveUsers = resolve;
    });

  const pending = store.fetchActiveUsers();
  store.invalidate();
  resolveUsers({ users: USERS });
  await pending;

  assert.deepEqual(store.users, []);
  assert.equal(store.loadedAt, 0);
  assert.equal(store.loading, false);
  assert.equal(store.isFresh(), false);
});

test("用户超过一页时循环翻页聚合全量用户", async () => {
  const store = setup();
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    id: `u${i + 1}`,
    status: "active",
  }));
  const page2 = [{ id: "tail", status: "active" }];
  const calls = stubUsers([
    { users: page1, total: 101, page: 1, limit: 100 },
    { users: page2, total: 101, page: 2, limit: 100 },
  ]);

  const users = await store.fetchActiveUsers();

  assert.deepEqual(
    calls,
    [
      { page: 1, limit: 100 },
      { page: 2, limit: 100 },
    ],
    "第一页拉满且未达 total 时应继续翻页",
  );
  assert.equal(users.length, 101, "两页用户应聚合为一份完整列表");
  assert.deepEqual(users[100], { id: "tail", status: "active" });
});

test("翻页达到安全上限（5 页 / 500 人）后停止并输出告警", async () => {
  const store = setup();
  const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: `u${i + 1}` }));
  const responses = Array.from({ length: 6 }, () => ({
    users: fullPage.slice(),
    total: 1000,
  }));
  const calls = stubUsers(responses);

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (message) => warnings.push(message);

  try {
    const users = await store.fetchActiveUsers();

    assert.equal(calls.length, 5, "最多拉 5 页（500 人）即停止");
    assert.equal(users.length, 500);
    assert.equal(warnings.length, 1, "达上限应输出一次告警");
    assert.match(warnings[0], /userOptions/);
  } finally {
    console.warn = realWarn;
  }
});

test("total 缺失时以本页不足一页作为翻页终止条件", async () => {
  const store = setup();
  const calls = stubUsers([{ users: USERS }]);

  const users = await store.fetchActiveUsers();

  assert.equal(calls.length, 1, "响应无 total 时不应盲目继续翻页");
  assert.equal(users.length, 2, "deleted 用户仍应被过滤");
});
