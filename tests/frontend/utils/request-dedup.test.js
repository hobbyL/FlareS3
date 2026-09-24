import test from "node:test";
import assert from "node:assert/strict";

import {
  dedupRequest,
  clearPendingRequests,
  getPendingRequestsCount,
} from "../../../frontend/src/utils/requestDedup.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("dedupRequest 并发调用只触发一次底层请求", async () => {
  clearPendingRequests();
  let calls = 0;
  const gate = deferred();
  const wrapped = dedupRequest(() => {
    calls += 1;
    return gate.promise;
  }, "auth-status");

  const first = wrapped();
  const second = wrapped();
  const third = wrapped();

  assert.equal(calls, 1, "并发期间底层函数只应被调用一次");
  assert.equal(getPendingRequestsCount(), 1);

  gate.resolve({ authenticated: true });
  const results = await Promise.all([first, second, third]);

  assert.deepEqual(results, [
    { authenticated: true },
    { authenticated: true },
    { authenticated: true },
  ]);
  assert.equal(getPendingRequestsCount(), 0, "结算后应清空在途记录");
});

test("dedupRequest 在请求结算后不再复用旧 Promise", async () => {
  clearPendingRequests();
  let calls = 0;
  const wrapped = dedupRequest(async () => {
    calls += 1;
    return calls;
  }, "storage-configs");

  assert.equal(await wrapped(), 1);
  assert.equal(await wrapped(), 2, "上一次已结算，应重新发起请求");
  assert.equal(calls, 2);
});

test("dedupRequest 支持函数式 key，参数不同不会互相复用", async () => {
  clearPendingRequests();
  const seen = [];
  const gate = deferred();
  const wrapped = dedupRequest(
    (id) => {
      seen.push(id);
      return gate.promise;
    },
    (id) => `config:${id}`,
  );

  const a1 = wrapped("a");
  const a2 = wrapped("a");
  const b1 = wrapped("b");

  assert.deepEqual(seen, ["a", "b"], "不同 key 应各自发起请求");
  assert.equal(getPendingRequestsCount(), 2);

  gate.resolve("done");
  await Promise.all([a1, a2, b1]);
  assert.equal(getPendingRequestsCount(), 0);
});

test("dedupRequest 未提供 key 时按函数名与参数生成默认 key", async () => {
  clearPendingRequests();
  let calls = 0;
  const gate = deferred();
  async function loadFiles(page) {
    calls += 1;
    void page;
    return gate.promise;
  }
  const wrapped = dedupRequest(loadFiles);

  const p1 = wrapped(1);
  const p2 = wrapped(1);
  const p3 = wrapped(2);

  assert.equal(calls, 2, "参数不同应视为不同请求");
  gate.resolve([]);
  await Promise.all([p1, p2, p3]);
});

test("dedupRequest 失败时所有等待方都收到同一错误且清理在途记录", async () => {
  clearPendingRequests();
  const gate = deferred();
  const wrapped = dedupRequest(() => gate.promise, "will-fail");

  const failure = new Error("network down");
  const first = wrapped();
  const second = wrapped();
  gate.reject(failure);

  await assert.rejects(first, /network down/);
  await assert.rejects(second, /network down/);
  assert.equal(getPendingRequestsCount(), 0, "失败后也必须释放在途记录");
});

test("clearPendingRequests 可以强制放行后续请求", async () => {
  clearPendingRequests();
  let calls = 0;
  const gate = deferred();
  const wrapped = dedupRequest(() => {
    calls += 1;
    return gate.promise;
  }, "manual");

  const first = wrapped();
  assert.equal(getPendingRequestsCount(), 1);

  clearPendingRequests();
  assert.equal(getPendingRequestsCount(), 0);

  const second = wrapped();
  assert.equal(calls, 2, "清空后应重新发起请求");

  gate.resolve("ok");
  await Promise.all([first, second]);
});
