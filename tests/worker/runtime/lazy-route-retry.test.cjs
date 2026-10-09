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

test("lazyRoute 一次 import 失败后清空缓存，下次请求重试成功", async () => {
  const { lazyRoute } = loadModule("router.js");

  let loadCount = 0;
  const route = lazyRoute(
    () => {
      loadCount += 1;
      // 首次模拟瞬时 dynamic import 失败（如边缘网络抖动），下次成功
      return loadCount === 1
        ? Promise.reject(new Error("transient import failure"))
        : Promise.resolve({ marker: "loaded" });
    },
    (mod, _request, env) => new Response(`ok:${mod.marker}:${env.v}`),
  );

  // 第一次请求：加载失败向上抛出（生产中由 index.ts 的 route 兜底为 500）
  await assert.rejects(
    () => route(new Request("https://example.com/api/setup"), { v: 1 }),
    /transient import failure/,
  );

  // 第二次请求：rejected promise 未被永久缓存，重新加载并成功
  const response = await route(new Request("https://example.com/api/setup"), {
    v: 2,
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok:loaded:2");
  assert.equal(loadCount, 2, "失败后应重新触发 import");
});

test("lazyRoute 连续失败仍可自愈，不会缓存 rejected promise", async () => {
  const { lazyRoute } = loadModule("router.js");

  let loadCount = 0;
  const route = lazyRoute(
    () => {
      loadCount += 1;
      return loadCount <= 2
        ? Promise.reject(new Error(`failure ${loadCount}`))
        : Promise.resolve({ marker: "recovered" });
    },
    (mod) => new Response(mod.marker),
  );

  await assert.rejects(
    () => route(new Request("https://example.com/"), {}),
    /failure 1/,
  );
  await assert.rejects(
    () => route(new Request("https://example.com/"), {}),
    /failure 2/,
  );
  const response = await route(new Request("https://example.com/"), {});
  assert.equal(await response.text(), "recovered");
  assert.equal(loadCount, 3);
});

test("lazyRoute 成功后缓存模块，后续请求不重复 import", async () => {
  const { lazyRoute } = loadModule("router.js");

  let loadCount = 0;
  const route = lazyRoute(
    () => {
      loadCount += 1;
      return Promise.resolve({ marker: "cached" });
    },
    (mod) => new Response(mod.marker),
  );

  const first = await route(new Request("https://example.com/"), {});
  const second = await route(new Request("https://example.com/"), {});

  assert.equal(await first.text(), "cached");
  assert.equal(await second.text(), "cached");
  assert.equal(loadCount, 1, "成功路径应缓存模块不重复 import");
});
