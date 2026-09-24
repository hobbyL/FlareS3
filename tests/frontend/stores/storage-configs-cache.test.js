import test from "node:test";
import assert from "node:assert/strict";

import { useFreshPinia } from "../helpers/pinia.js";

const api = (await import("../../../frontend/src/services/api.js")).default;
const { useStorageConfigsStore } =
  await import("../../../frontend/src/stores/storageConfigs.js");

const realGetStorageConfigs = api.getStorageConfigs;
const realNow = Date.now;

const RESPONSE = {
  configs: [
    { id: "c1", name: "主存储", type: "r2" },
    { id: "c2", name: "备份", type: "webdav" },
  ],
  default_config_id: "c1",
  legacy_files_config_id: "c2",
};

function setup() {
  useFreshPinia();
  Date.now = realNow;
  api.getStorageConfigs = realGetStorageConfigs;
  const store = useStorageConfigsStore();
  store.invalidate();
  return store;
}

function stubConfigs(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  api.getStorageConfigs = async () => {
    calls.push(true);
    const next = queue ? queue.shift() : responses;
    if (next instanceof Error) throw next;
    return next;
  };
  return calls;
}

test("fetchConfigs 首次调用拉取并规范化响应", async () => {
  const store = setup();
  const calls = stubConfigs(RESPONSE);

  const result = await store.fetchConfigs();

  assert.equal(calls.length, 1);
  assert.deepEqual(result, RESPONSE);
  assert.equal(store.defaultConfigId, "c1");
  assert.equal(store.legacyFilesConfigId, "c2");
  assert.equal(store.configs.length, 2);
  assert.ok(store.loadedAt > 0);
  assert.equal(store.loading, false);
});

test("5 分钟内重复调用命中缓存", async () => {
  const store = setup();
  const calls = stubConfigs(RESPONSE);

  await store.fetchConfigs();
  const cached = await store.fetchConfigs();

  assert.equal(calls.length, 1, "缓存期内不应重复请求 /storage/configs");
  assert.deepEqual(cached.configs, RESPONSE.configs);
});

test("缓存过期后重新拉取", async () => {
  const store = setup();
  const calls = stubConfigs([RESPONSE, RESPONSE]);

  let clock = 1_000_000;
  Date.now = () => clock;

  await store.fetchConfigs();
  clock += 5 * 60 * 1000 - 1;
  await store.fetchConfigs();
  assert.equal(calls.length, 1);

  clock += 2;
  await store.fetchConfigs();
  assert.equal(calls.length, 2);
});

test("force 与自定义 ttlMs 可跳过缓存", async () => {
  const store = setup();
  const calls = stubConfigs([RESPONSE, RESPONSE, RESPONSE]);

  let clock = 2_000_000;
  Date.now = () => clock;

  await store.fetchConfigs();
  await store.fetchConfigs({ force: true });
  assert.equal(calls.length, 2);

  clock += 1_000;
  await store.fetchConfigs({ ttlMs: 500 });
  assert.equal(calls.length, 3);
});

test("force 在非强制请求在途时另起新请求，作废的旧响应不覆盖强制结果", async () => {
  const store = setup();
  const resolvers = [];
  let calls = 0;
  api.getStorageConfigs = () =>
    new Promise((resolve) => {
      resolvers.push(resolve);
      calls += 1;
    });

  const first = store.fetchConfigs(); // 非强制，在途
  const second = store.fetchConfigs({ force: true }); // 强制：不得复用在途请求
  assert.equal(calls, 2, "force 不应复用在途的非强制请求");

  // 强制请求先返回新数据
  resolvers[1]({ ...RESPONSE, default_config_id: "forced" });
  await second;
  assert.equal(store.defaultConfigId, "forced");

  // 被顶替的在途请求后到，不得回写覆盖强制刷新的结果
  resolvers[0](RESPONSE);
  await first;
  assert.equal(
    store.defaultConfigId,
    "forced",
    "作废的在途响应不得回写强制刷新结果",
  );
});

test("并发调用共享同一次请求", async () => {
  const store = setup();
  let resolveConfigs;
  let calls = 0;
  api.getStorageConfigs = () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveConfigs = resolve;
    });
  };

  const pending = [store.fetchConfigs(), store.fetchConfigs()];
  assert.equal(calls, 1);
  assert.equal(store.loading, true);

  resolveConfigs(RESPONSE);
  const [a, b] = await Promise.all(pending);

  assert.deepEqual(a, b);
  assert.equal(store.loading, false);
});

test("响应缺字段时降级为安全默认值", async () => {
  const store = setup();
  stubConfigs({});

  const result = await store.fetchConfigs();

  assert.deepEqual(result, {
    configs: [],
    default_config_id: null,
    legacy_files_config_id: null,
  });
});

test("请求失败时错误向上抛出且不写入缓存", async () => {
  const store = setup();
  const calls = stubConfigs([new Error("boom"), RESPONSE]);

  await assert.rejects(store.fetchConfigs(), /boom/);
  assert.equal(store.loadedAt, 0);
  assert.equal(store.loading, false);
  assert.equal(store.isFresh(), false);

  await store.fetchConfigs();
  assert.equal(calls.length, 2, "失败后应允许重试");
});

test("invalidate 清空缓存并使在途响应失效", async () => {
  const store = setup();
  let resolveConfigs;
  api.getStorageConfigs = () =>
    new Promise((resolve) => {
      resolveConfigs = resolve;
    });

  const pending = store.fetchConfigs();
  store.invalidate();
  resolveConfigs(RESPONSE);
  await pending;

  assert.deepEqual(store.configs, []);
  assert.equal(store.defaultConfigId, null);
  assert.equal(store.loadedAt, 0);
  assert.equal(store.isFresh(), false);
});

test("result getter 与 api 原始响应结构保持一致", async () => {
  const store = setup();
  stubConfigs(RESPONSE);

  await store.fetchConfigs();

  assert.deepEqual(Object.keys(store.result).sort(), [
    "configs",
    "default_config_id",
    "legacy_files_config_id",
  ]);
});
