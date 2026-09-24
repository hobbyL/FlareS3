const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

const { logRequestOutcome, logRequestStart } = require(
  path.join(COMPILED_ROOT, "utils/log.js"),
);

function fakeRequest({
  method = "GET",
  url = "https://example.com/api/files",
  requestId = "req-1",
  userId,
  ip,
  userAgent,
} = {}) {
  const headers = new Map();
  if (ip) headers.set("CF-Connecting-IP", ip);
  if (userAgent) headers.set("User-Agent", userAgent);
  const req = {
    method,
    url,
    requestId,
    headers: { get: (key) => (headers.has(key) ? headers.get(key) : null) },
  };
  if (userId) req.user = { id: userId };
  return req;
}

const LEVELS = ["debug", "info", "warn", "error"];

// __APPEND_HELPERS__

/** 捕获四个 console 级别的输出，返回按级别解析后的结构化日志条目。 */
function captureLogs(run) {
  const originals = {};
  const entries = { debug: [], info: [], warn: [], error: [] };
  for (const level of LEVELS) {
    originals[level] = console[level];
    console[level] = (...args) => {
      for (const arg of args) {
        if (typeof arg !== "string") continue;
        try {
          entries[level].push(JSON.parse(arg));
        } catch {
          // ignore non-JSON logs
        }
      }
    };
  }
  try {
    run();
  } finally {
    for (const level of LEVELS) {
      console[level] = originals[level];
    }
  }
  return entries;
}

function totalCount(entries) {
  return LEVELS.reduce((sum, level) => sum + entries[level].length, 0);
}

// __APPEND_TESTS_1__

test("5xx 始终记录 request.error（不依赖访问日志开关），并携带 requestId/userId/action", () => {
  const entries = captureLogs(() => {
    logRequestOutcome(
      fakeRequest({
        method: "post",
        url: "https://e.com/api/x",
        requestId: "r5",
        userId: "u9",
      }),
      { status: 500 },
      { error: new Error("boom"), durationMs: 12.7 },
    );
  });

  assert.equal(entries.error.length, 1);
  assert.equal(totalCount(entries), 1, "5xx 只应产生一条 error 日志");
  const log = entries.error[0];
  assert.equal(log.event, "request.error");
  assert.equal(log.method, "POST");
  assert.equal(log.path, "/api/x");
  assert.equal(log.action, "POST /api/x");
  assert.equal(log.status, 500);
  assert.equal(log.requestId, "r5");
  assert.equal(log.userId, "u9");
  assert.equal(log.durationMs, 13, "durationMs 应四舍五入为整数");
  assert.match(log.error, /boom/);
});

test("5xx 无异常对象时仍记录 request.error，且省略 error/stack/userId", () => {
  const entries = captureLogs(() => {
    logRequestOutcome(fakeRequest({ requestId: "r0" }), { status: 503 });
  });

  assert.equal(entries.error.length, 1);
  const log = entries.error[0];
  assert.equal(log.event, "request.error");
  assert.equal(log.status, 503);
  assert.equal(log.requestId, "r0");
  assert.ok(!("error" in log), "无异常时不应出现 error 字段");
  assert.ok(!("stack" in log), "无异常时不应出现 stack 字段");
  assert.ok(!("userId" in log), "无用户时应省略 userId");
  assert.ok(!("durationMs" in log), "未提供 durationMs 时应省略");
});

// __APPEND_TESTS_2__

test("4xx 在未开启访问日志时保持静默", () => {
  const entries = captureLogs(() => {
    logRequestOutcome(fakeRequest(), { status: 404 });
  });
  assert.equal(totalCount(entries), 0);
});

test("4xx 在开启访问日志时记录 request.client_error（warn）", () => {
  const entries = captureLogs(() => {
    logRequestOutcome(
      fakeRequest({ method: "delete", url: "https://e.com/api/files/1" }),
      { status: 403 },
      { accessLog: true, durationMs: 4 },
    );
  });

  assert.equal(entries.warn.length, 1);
  assert.equal(totalCount(entries), 1);
  const log = entries.warn[0];
  assert.equal(log.event, "request.client_error");
  assert.equal(log.method, "DELETE");
  assert.equal(log.action, "DELETE /api/files/1");
  assert.equal(log.status, 403);
});

// __APPEND_TESTS_3__

test("2xx 在未开启访问日志时保持静默", () => {
  const entries = captureLogs(() => {
    logRequestOutcome(fakeRequest(), { status: 200 }, { durationMs: 3 });
  });
  assert.equal(totalCount(entries), 0);
});

test("2xx 在开启访问日志时记录 request.access（info），含 ip/userAgent", () => {
  const entries = captureLogs(() => {
    logRequestOutcome(
      fakeRequest({ ip: "1.2.3.4", userAgent: "curl/8", userId: "u1" }),
      { status: 200 },
      { accessLog: true, durationMs: 8.4 },
    );
  });

  assert.equal(entries.info.length, 1);
  const log = entries.info[0];
  assert.equal(log.event, "request.access");
  assert.equal(log.status, 200);
  assert.equal(log.ip, "1.2.3.4");
  assert.equal(log.userAgent, "curl/8");
  assert.equal(log.userId, "u1");
  assert.equal(log.durationMs, 8);
});

test("logRequestStart 输出 request.start（debug）并带 action", () => {
  const entries = captureLogs(() => {
    logRequestStart(
      fakeRequest({
        method: "get",
        url: "https://e.com/api/z",
        requestId: "rs",
      }),
    );
  });

  assert.equal(entries.debug.length, 1);
  const log = entries.debug[0];
  assert.equal(log.event, "request.start");
  assert.equal(log.action, "GET /api/z");
  assert.equal(log.requestId, "rs");
});

test("缺失 requestId 时该字段回退为 null", () => {
  const req = fakeRequest();
  delete req.requestId;
  const entries = captureLogs(() => {
    logRequestOutcome(req, { status: 500 });
  });
  assert.equal(entries.error[0].requestId, null);
});
