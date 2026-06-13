const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

function clearModule(relativePath) {
  delete require.cache[compiledPath(relativePath)];
}

function loadModule(relativePath) {
  const target = compiledPath(relativePath);
  delete require.cache[target];
  return require(target);
}

function loadWorkerEntrypoint() {
  clearModule("index.js");
  return loadModule("index.js").default;
}

test("worker applies strict CSP for HTML and emits HSTS on secure requests", async () => {
  const worker = loadWorkerEntrypoint();
  const response = await worker.fetch(
    new Request("https://example.com/", {
      method: "GET",
      headers: {
        Accept: "text/html",
      },
    }),
    {
      FLARES3_DEBUG_HEADERS: "1",
      ASSETS: {
        fetch: async () =>
          new Response("<!doctype html><html><body>ok</body></html>", {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
            },
          }),
      },
    },
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("Strict-Transport-Security"),
    "max-age=31536000; includeSubDomains",
  );

  const csp = response.headers.get("Content-Security-Policy") || "";
  assert.match(csp, /script-src 'self'/);
  assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"));

  assert.match(response.headers.get("Server-Timing") || "", /assets;dur=/);
  assert.match(response.headers.get("Server-Timing") || "", /total;dur=/);
  assert.match(response.headers.get("X-Flares3-Timing") || "", /assets=.*ms/);
});

test("worker exposes health endpoint without DB dependencies and skips HSTS on insecure requests", async () => {
  const worker = loadWorkerEntrypoint();
  const response = await worker.fetch(
    new Request("http://example.com/health"),
    { FLARES3_DEBUG_HEADERS: "1" },
    {},
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Strict-Transport-Security"), null);
  assert.equal(body.status, "ok");
  assert.equal(typeof body.timestamp, "string");
  assert.match(response.headers.get("Server-Timing") || "", /health;dur=/);
  assert.match(response.headers.get("Server-Timing") || "", /total;dur=/);
});

test("worker hides timing and isolate diagnostics by default", async () => {
  const worker = loadWorkerEntrypoint();
  const response = await worker.fetch(
    new Request("http://example.com/health"),
    {},
    {},
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Server-Timing"), null);
  assert.equal(response.headers.get("X-Flares3-Timing"), null);
  assert.equal(response.headers.get("X-Flares3-Isolate-Request"), null);
  assert.equal(response.headers.get("X-Flares3-Isolate-Cold"), null);
});

test("worker exposes isolate diagnostics in response headers when debug headers are enabled", async () => {
  const worker = loadWorkerEntrypoint();
  const first = await worker.fetch(
    new Request("http://example.com/health"),
    { FLARES3_DEBUG_HEADERS: "1" },
    {},
  );
  const second = await worker.fetch(
    new Request("http://example.com/health"),
    { FLARES3_DEBUG_HEADERS: "1" },
    {},
  );

  assert.equal(first.headers.get("X-Flares3-Isolate-Request"), "1");
  assert.equal(first.headers.get("X-Flares3-Isolate-Cold"), "1");
  assert.match(first.headers.get("X-Flares3-Isolate-Age") || "", /^\d+\.\dms$/);
  assert.match(
    first.headers.get("X-Flares3-Isolate-Idle") || "",
    /^\d+\.\dms$/,
  );

  assert.equal(second.headers.get("X-Flares3-Isolate-Request"), "2");
  assert.equal(second.headers.get("X-Flares3-Isolate-Cold"), "0");
});

test("worker rejects cross-origin unsafe backend requests before D1 access", async () => {
  const worker = loadWorkerEntrypoint();
  const response = await worker.fetch(
    new Request("https://example.com/api/auth/logout", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
      },
    }),
    {
      DB: {
        prepare() {
          throw new Error(
            "cross-origin request should be rejected before D1 access",
          );
        },
      },
    },
    {},
  );
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.deepEqual(payload, { error: "跨源请求被拒绝" });
});

test("worker allows same-origin unsafe backend requests through origin guard", async () => {
  const worker = loadWorkerEntrypoint();
  const response = await worker.fetch(
    new Request("https://example.com/api/auth/logout", {
      method: "POST",
      headers: {
        Origin: "https://example.com",
        "Sec-Fetch-Site": "same-origin",
      },
    }),
    {
      DB: {
        prepare() {
          throw new Error("logout without a session should not touch D1");
        },
      },
    },
    {},
  );

  assert.equal(response.status, 200);
});

test("worker allows loopback dev proxy unsafe backend requests with different ports", async () => {
  const worker = loadWorkerEntrypoint();
  const response = await worker.fetch(
    new Request("http://127.0.0.1:18787/api/auth/logout", {
      method: "POST",
      headers: {
        Origin: "http://localhost:18786",
        "Sec-Fetch-Site": "same-origin",
      },
    }),
    {
      DB: {
        prepare() {
          throw new Error("logout without a session should not touch D1");
        },
      },
    },
    {},
  );

  assert.equal(response.status, 200);
});

test("worker still rejects same-site browser metadata on loopback unsafe requests", async () => {
  const worker = loadWorkerEntrypoint();
  const response = await worker.fetch(
    new Request("http://127.0.0.1:18787/api/auth/logout", {
      method: "POST",
      headers: {
        Origin: "http://localhost:18786",
        "Sec-Fetch-Site": "same-site",
      },
    }),
    {
      DB: {
        prepare() {
          throw new Error(
            "same-site request should be rejected before D1 access",
          );
        },
      },
    },
    {},
  );
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.deepEqual(payload, { error: "跨源请求被拒绝" });
});

test("worker allows non-browser unsafe API clients without origin metadata", async () => {
  const worker = loadWorkerEntrypoint();
  const response = await worker.fetch(
    new Request("https://example.com/api/auth/logout", {
      method: "POST",
    }),
    {
      DB: {
        prepare() {
          throw new Error("logout without a session should not touch D1");
        },
      },
    },
    {},
  );

  assert.equal(response.status, 200);
});
