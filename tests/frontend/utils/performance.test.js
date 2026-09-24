import test from "node:test";
import assert from "node:assert/strict";

// performance.js 依赖浏览器全局对象，这里在导入前装好最小替身。
const observerRegistry = [];

class FakePerformanceObserver {
  constructor(callback) {
    this.callback = callback;
  }

  observe(options) {
    observerRegistry.push({ type: options.type, callback: this.callback });
  }
}

const loadListeners = [];
let navigationEntry = null;

globalThis.window = {
  PerformanceObserver: FakePerformanceObserver,
  addEventListener(event, handler) {
    if (event === "load") loadListeners.push(handler);
  },
};
globalThis.PerformanceObserver = FakePerformanceObserver;
globalThis.document = { readyState: "complete" };
globalThis.performance = {
  getEntriesByType(type) {
    return type === "navigation" && navigationEntry ? [navigationEntry] : [];
  },
};

const {
  recordAPILatency,
  recordRouteLoadTime,
  getMetrics,
  initPerformanceMonitoring,
} = await import("../../../frontend/src/utils/performance.js");

function captureLogs(fn) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const logs = [];
  console.log = (...args) => logs.push(args);
  console.warn = (...args) => logs.push(args);
  try {
    fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  return logs;
}

/** 触发一次监控初始化，并捕获注册的 observer 与延迟汇总定时器 */
function bootMonitoring({ readyState = "complete", navigation = null } = {}) {
  observerRegistry.length = 0;
  loadListeners.length = 0;
  navigationEntry = navigation;
  globalThis.document.readyState = readyState;

  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (handler, delay) => {
    timers.push({ handler, delay });
    return 0;
  };

  const logs = captureLogs(() => initPerformanceMonitoring());

  globalThis.setTimeout = realSetTimeout;
  return { logs, timers };
}

function findObserver(type) {
  return observerRegistry.find((entry) => entry.type === type);
}

function emit(type, entries) {
  const observer = findObserver(type);
  assert.ok(observer, `expected a ${type} observer to be registered`);
  return captureLogs(() => observer.callback({ getEntries: () => entries }));
}

test("recordAPILatency 记录接口耗时并写入自定义指标", () => {
  const logs = captureLogs(() => recordAPILatency("/api/files", 123.6));

  assert.equal(getMetrics().custom.apiLatency["/api/files"], 123.6);
  assert.deepEqual(logs[0], [
    "[Performance] API Latency - /api/files:",
    124,
    "ms",
  ]);
});

test("recordRouteLoadTime 记录路由加载耗时", () => {
  captureLogs(() => recordRouteLoadTime("/files", 88.2));
  assert.equal(getMetrics().custom.routeLoadTime["/files"], 88.2);
});

test("getMetrics 始终返回全部 Web Vitals 字段", () => {
  const metrics = getMetrics();
  for (const key of ["LCP", "FID", "CLS", "FCP", "TTFB"]) {
    assert.ok(key in metrics, `缺少指标字段 ${key}`);
  }
  assert.ok("custom" in metrics);
});

test("页面已加载完成时立即注册 LCP / FID / CLS / FCP 观察器", () => {
  bootMonitoring();

  const types = observerRegistry.map((entry) => entry.type).sort();
  assert.deepEqual(types, [
    "first-input",
    "largest-contentful-paint",
    "layout-shift",
    "paint",
  ]);
});

test("页面未加载完成时推迟到 load 事件再启动监控", () => {
  bootMonitoring({ readyState: "loading" });

  assert.equal(observerRegistry.length, 0, "load 之前不应注册观察器");
  assert.equal(loadListeners.length, 1);

  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  captureLogs(() => loadListeners[0]());
  globalThis.setTimeout = realSetTimeout;

  assert.equal(observerRegistry.length, 4);
});

test("LCP 取最后一条记录并按阈值评级", () => {
  bootMonitoring();

  const logs = emit("largest-contentful-paint", [
    { renderTime: 900 },
    { renderTime: 4200 },
  ]);

  assert.equal(getMetrics().LCP, 4200);
  assert.deepEqual(logs[0], [
    "[Performance] LCP:",
    { value: 4200, rating: "poor" },
  ]);

  emit("largest-contentful-paint", [{ renderTime: 0, loadTime: 1200 }]);
  assert.equal(getMetrics().LCP, 1200, "renderTime 为 0 时回退到 loadTime");
});

test("FID 由 processingStart 与 startTime 之差得出", () => {
  bootMonitoring();

  const logs = emit("first-input", [
    { processingStart: 1050, startTime: 1000 },
  ]);

  assert.equal(getMetrics().FID, 50);
  assert.deepEqual(logs[0], [
    "[Performance] FID:",
    { value: 50, rating: "good" },
  ]);
});

test("CLS 跨批次累加，并忽略用户交互引起的位移", () => {
  bootMonitoring();

  emit("layout-shift", [
    { value: 0.05, hadRecentInput: false },
    { value: 0.5, hadRecentInput: true },
  ]);
  assert.equal(getMetrics().CLS.toFixed(2), "0.05");

  emit("layout-shift", [{ value: 0.3, hadRecentInput: false }]);
  assert.equal(getMetrics().CLS.toFixed(2), "0.35", "同一次会话内应持续累加");
});

test("FCP 只采纳 first-contentful-paint 这一条 paint 记录", () => {
  bootMonitoring();

  const logs = emit("paint", [
    { name: "first-paint", startTime: 500 },
    { name: "first-contentful-paint", startTime: 1500 },
  ]);

  assert.equal(getMetrics().FCP, 1500);
  assert.equal(logs.length, 1, "非 FCP 的 paint 记录不应上报");
});

test("存在导航记录时计算 TTFB", () => {
  const { logs } = bootMonitoring({
    navigation: { responseStart: 1300, requestStart: 1000 },
  });

  assert.equal(getMetrics().TTFB, 300);
  const ttfbLog = logs.find((entry) => entry[0] === "[Performance] TTFB:");
  assert.deepEqual(ttfbLog[1], { value: 300, rating: "good" });
});

test("缺少导航记录时跳过 TTFB 且不抛错", () => {
  const before = getMetrics().TTFB;
  const { logs } = bootMonitoring({ navigation: null });

  assert.equal(getMetrics().TTFB, before);
  assert.equal(
    logs.some((entry) => entry[0] === "[Performance] TTFB:"),
    false,
  );
});

test("启动监控时安排 5 秒后的指标汇总", () => {
  const { timers } = bootMonitoring();

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 5000);

  const logs = captureLogs(() => timers[0].handler());
  assert.equal(logs[0][0], "[Performance] Summary:");
});
