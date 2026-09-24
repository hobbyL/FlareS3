import test from "node:test";
import assert from "node:assert/strict";

import { useFreshPinia } from "../helpers/pinia.js";

const { useMountConfigs } =
  await import("../../../frontend/src/composables/useMountConfigs.js");
const { useStorageConfigsStore } =
  await import("../../../frontend/src/stores/storageConfigs.js");
const api = (await import("../../../frontend/src/services/api.js")).default;

const realGetStorageConfigs = api.getStorageConfigs;

const t = (key) => key;

function createMessage() {
  const errors = [];
  return { errors, error: (text) => errors.push(text) };
}

/** 记录 fetchConfigs 调用参数的 store 替身 */
function createStoreStub(result) {
  const calls = [];
  return {
    calls,
    async fetchConfigs(options) {
      calls.push(options);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const RESULT = {
  configs: [
    { id: "r2-1", name: "主存储", type: "r2", bucket_name: "flares3" },
    {
      id: "dav-1",
      name: "备份",
      type: "webdav",
      endpoint: "https://dav.example",
    },
    { id: "koofr-1", name: "Koofr", type: "koofr", remote_path: "/backup" },
  ],
  default_config_id: "dav-1",
};

test("loadConfigs 通过 storageConfigs store 读取配置并带上 configType", async () => {
  const message = createMessage();
  const store = createStoreStub(RESULT);
  const { loadConfigs, configs, configsLoading, selectedConfigId } =
    useMountConfigs({ t, message, store });

  assert.equal(configsLoading.value, false);
  await loadConfigs();

  assert.deepEqual(store.calls, [{ force: false }], "默认应复用 5 分钟缓存");
  assert.deepEqual(
    configs.value.map((row) => row.configType),
    ["r2", "webdav", "koofr"],
  );
  assert.equal(selectedConfigId.value, "dav-1", "应采用后端返回的默认配置");
  assert.equal(configsLoading.value, false);
  assert.deepEqual(message.errors, []);
});

test("force 选项透传给 store 以跳过缓存", async () => {
  const store = createStoreStub(RESULT);
  const { loadConfigs } = useMountConfigs({
    t,
    message: createMessage(),
    store,
  });

  await loadConfigs({ force: true });
  assert.deepEqual(store.calls, [{ force: true }]);
});

test("已有选中项时不被后端默认值覆盖", async () => {
  const store = createStoreStub(RESULT);
  const { loadConfigs, selectedConfigId } = useMountConfigs({
    t,
    message: createMessage(),
    store,
  });

  selectedConfigId.value = "r2-1";
  await loadConfigs();

  assert.equal(selectedConfigId.value, "r2-1");
});

test("没有默认配置时回退到第一条配置", async () => {
  const store = createStoreStub({
    configs: RESULT.configs,
    default_config_id: "  ",
  });
  const { loadConfigs, selectedConfigId } = useMountConfigs({
    t,
    message: createMessage(),
    store,
  });

  await loadConfigs();
  assert.equal(selectedConfigId.value, "r2-1");
});

test("配置为空时选中项保持为空且不报错", async () => {
  const store = createStoreStub({ configs: [], default_config_id: null });
  const message = createMessage();
  const { loadConfigs, selectedConfigId, configOptions } = useMountConfigs({
    t,
    message,
    store,
  });

  await loadConfigs();
  assert.equal(selectedConfigId.value, "");
  assert.deepEqual(configOptions.value, []);
  assert.deepEqual(message.errors, []);
});

test("configOptions 按类型渲染可读标签", async () => {
  const store = createStoreStub({
    configs: [
      ...RESULT.configs,
      { id: "koofr-2", name: "Koofr 根目录", type: "koofr", remote_path: "/" },
    ],
    default_config_id: null,
  });
  const { loadConfigs, configOptions } = useMountConfigs({
    t,
    message: createMessage(),
    store,
  });

  await loadConfigs();

  assert.deepEqual(configOptions.value, [
    { label: "主存储 (R2: flares3)", value: "r2-1" },
    { label: "备份 (WebDAV: https://dav.example)", value: "dav-1" },
    { label: "Koofr (Koofr: /backup)", value: "koofr-1" },
    { label: "Koofr 根目录 (Koofr: Koofr)", value: "koofr-2" },
  ]);
});

test("加载失败时提示错误并复位 loading", async () => {
  const error = new Error("boom");
  error.response = { data: { error: "存储服务不可用" } };
  const store = createStoreStub(error);
  const message = createMessage();
  const { loadConfigs, configsLoading, configs } = useMountConfigs({
    t,
    message,
    store,
  });

  await loadConfigs();

  assert.deepEqual(message.errors, ["存储服务不可用"]);
  assert.equal(configsLoading.value, false);
  assert.deepEqual(configs.value, []);
});

test("后端未返回具体原因时回退到 i18n 文案", async () => {
  const store = createStoreStub(new Error("network down"));
  const message = createMessage();
  const { loadConfigs } = useMountConfigs({ t, message, store });

  await loadConfigs();
  assert.deepEqual(message.errors, ["mount.messages.loadConfigsFailed"]);
});

test("未显式注入 store 时回落到全局 storageConfigs store", async () => {
  useFreshPinia();
  api.getStorageConfigs = async () => RESULT;
  try {
    useStorageConfigsStore().invalidate();
    const { loadConfigs, configs } = useMountConfigs({
      t,
      message: createMessage(),
    });

    await loadConfigs();

    assert.equal(configs.value.length, 3);
    assert.equal(useStorageConfigsStore().defaultConfigId, "dav-1");
  } finally {
    api.getStorageConfigs = realGetStorageConfigs;
  }
});
