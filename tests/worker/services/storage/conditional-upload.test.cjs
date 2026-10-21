const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");
const { WebDAVProvider } = require(
  path.join(root, "services/storage/webdav-provider.js"),
);
const { KoofrProvider } = require(
  path.join(root, "services/storage/koofr-provider.js"),
);

for (const Provider of [WebDAVProvider, KoofrProvider]) {
  test(`${Provider.name} conditional create uses PUT and rejects existing objects`, async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response("", { status: 412 });
    };
    try {
      const provider = new Provider({
        endpoint: "https://example.com/dav",
        username: "dummy",
        password: "dummy",
      });
      await assert.rejects(
        provider.upload("a.txt", new ArrayBuffer(1), "text/plain", 1, {
          ifNoneMatch: "*",
        }),
        (error) =>
          error.code === "TargetExists" && error.httpStatusCode === 409,
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].init.method, "PUT");
      assert.equal(
        new Headers(calls[0].init.headers).get("If-None-Match"),
        "*",
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
}

test("WebDAV existence only treats 404 as missing and preserves upstream failures", async () => {
  const original = global.fetch;
  try {
    const provider = new WebDAVProvider({
      endpoint: "https://example.com/dav",
      username: "dummy",
      password: "dummy",
    });
    for (const status of [401, 403, 500, 503]) {
      global.fetch = async () => new Response("", { status });
      await assert.rejects(
        () => provider.checkExists("demo"),
        (error) => error.code === "ExistenceCheckFailed",
      );
    }
    global.fetch = async () => new Response("", { status: 404 });
    assert.equal(await provider.checkExists("demo"), false);
  } finally {
    global.fetch = original;
  }
});
