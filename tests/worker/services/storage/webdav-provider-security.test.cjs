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

test("WebDAVProvider download drops untrusted upstream response headers", async () => {
  const { WebDAVProvider } = loadModule("services/storage/webdav-provider.js");
  const provider = new WebDAVProvider({
    endpoint: "https://dav.example.com/files",
    username: "alice",
    password: "secret",
  });

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response("payload", {
      status: 200,
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": "7",
        "Content-Disposition": 'attachment; filename="upstream.txt"',
        "Set-Cookie": "session=attacker; Path=/",
        Location: "https://attacker.example/next",
        "Content-Security-Policy": "default-src *",
        "X-Frame-Options": "ALLOWALL",
      },
    });

  try {
    const result = await provider.download(
      "reports/private.txt",
      "private.txt",
      3600,
    );
    assert.equal(result.kind, "proxy");

    const response = result.response;
    assert.equal(await response.text(), "payload");
    assert.equal(response.headers.get("Content-Type"), "text/plain");
    assert.equal(response.headers.get("Content-Length"), "7");
    assert.equal(
      response.headers.get("Content-Disposition"),
      'attachment; filename="private.txt"',
    );
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(response.headers.get("Location"), null);
    assert.equal(response.headers.get("Content-Security-Policy"), null);
    assert.equal(response.headers.get("X-Frame-Options"), null);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  } finally {
    global.fetch = originalFetch;
  }
});

test("WebDAVProvider encodes remote path and object key segments in request URLs", async () => {
  const { WebDAVProvider } = loadModule("services/storage/webdav-provider.js");
  const provider = new WebDAVProvider({
    endpoint: "https://dav.example.com/base",
    username: "alice",
    password: "secret",
    remotePath: "/docs team",
  });

  const urls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    urls.push(String(url));
    return new Response("payload", { status: 200 });
  };

  try {
    const result = await provider.download(
      "a b/report?#.txt",
      "report.txt",
      3600,
    );
    assert.equal(result.kind, "proxy");
    assert.deepEqual(urls, [
      "https://dav.example.com/base/docs%20team/a%20b/report%3F%23.txt",
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("WebDAVProvider list strips configured remote path from returned keys", async () => {
  const { WebDAVProvider } = loadModule("services/storage/webdav-provider.js");
  const provider = new WebDAVProvider({
    endpoint: "https://dav.example.com/dav",
    username: "alice",
    password: "secret",
    remotePath: "/docs team",
  });

  const urls = [];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/docs%20team/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection /></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/docs%20team/folder%3F/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection /></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/docs%20team/file%23name.txt</D:href>
    <D:propstat><D:prop><D:resourcetype /><D:getcontentlength>42</D:getcontentlength></D:prop></D:propstat>
  </D:response>
</D:multistatus>`;

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    urls.push(String(url));
    return new Response(xml, {
      status: 207,
      headers: { "Content-Type": "application/xml" },
    });
  };

  try {
    const result = await provider.list({ prefix: "", delimiter: "/" });
    assert.deepEqual(urls, ["https://dav.example.com/dav/docs%20team"]);
    assert.deepEqual(result.common_prefixes, ["folder?/"]);
    assert.deepEqual(result.contents, [{ key: "file#name.txt", size: 42 }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("WebDAVProvider checks configured remote path without duplicating it", async () => {
  const { WebDAVProvider } = loadModule("services/storage/webdav-provider.js");
  const provider = new WebDAVProvider({
    endpoint: "https://dav.example.com/base",
    username: "alice",
    password: "secret",
    remotePath: "/docs",
  });

  const urls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    urls.push(String(url));
    return new Response("", { status: 207 });
  };

  try {
    await provider.testConnection();
    assert.deepEqual(urls, [
      "https://dav.example.com/base/",
      "https://dav.example.com/base/docs",
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("WebDAVProvider rejects unsafe configured remote paths", () => {
  const { WebDAVProvider } = loadModule("services/storage/webdav-provider.js");

  assert.throws(
    () =>
      new WebDAVProvider({
        endpoint: "https://dav.example.com/base",
        username: "alice",
        password: "secret",
        remotePath: "../secret",
      }),
    /远程目录不能包含/,
  );
});
