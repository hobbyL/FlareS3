const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

// 以编译产物位置为基准解析依赖：SDK 安装在 worker/node_modules 下，
// 从 tests/ 目录直接 require 无法命中
const requireFromWorker = createRequire(
  compiledPath("services/r2SignedRequests.js"),
);

function loadModule(relativePath) {
  const target = compiledPath(relativePath);
  delete require.cache[target];
  return require(target);
}

function timeoutError() {
  const error = new Error("The operation was aborted due to timeout");
  error.name = "TimeoutError";
  return error;
}

function withMockedFetch(handler) {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(calls.length, url, init);
  };
  return {
    calls,
    restore() {
      global.fetch = originalFetch;
    },
  };
}

test("WebDAV provider upstream fetches carry an AbortSignal timeout", async () => {
  const { refreshUpstreamTimeoutConfig } = loadModule(
    "config/upstreamTimeout.js",
  );
  refreshUpstreamTimeoutConfig({});
  const { WebDAVProvider } = loadModule("services/storage/webdav-provider.js");
  const provider = new WebDAVProvider({
    endpoint: "https://dav.example.com/base",
    username: "alice",
    password: "secret",
  });

  const mock = withMockedFetch(
    () =>
      new Response("", {
        status: 200,
        headers: { "Content-Length": "42" },
      }),
  );
  try {
    const size = await provider.getSize("demo.txt");
    assert.equal(size, 42);
  } finally {
    mock.restore();
  }

  assert.equal(mock.calls.length, 1);
  assert.ok(
    mock.calls[0].init.signal instanceof AbortSignal,
    "上游 fetch 必须带 AbortSignal 超时",
  );
});

test("readonly WebDAV requests retry once on timeout and then succeed", async () => {
  const { refreshUpstreamTimeoutConfig } = loadModule(
    "config/upstreamTimeout.js",
  );
  refreshUpstreamTimeoutConfig({});
  const { WebDAVProvider } = loadModule("services/storage/webdav-provider.js");
  const provider = new WebDAVProvider({
    endpoint: "https://dav.example.com/base",
    username: "alice",
    password: "secret",
  });

  // 第 1 次 HEAD 超时，第 2 次成功（默认只读重试 1 次）
  const mock = withMockedFetch((attempt) => {
    if (attempt === 1) throw timeoutError();
    return new Response("", {
      status: 200,
      headers: { "Content-Length": "7" },
    });
  });
  try {
    const size = await provider.getSize("demo.txt");
    assert.equal(size, 7);
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.length, 2);
});

test("write WebDAV requests never retry on timeout", async () => {
  const { refreshUpstreamTimeoutConfig } = loadModule(
    "config/upstreamTimeout.js",
  );
  refreshUpstreamTimeoutConfig({});
  const { WebDAVProvider } = loadModule("services/storage/webdav-provider.js");
  const provider = new WebDAVProvider({
    endpoint: "https://dav.example.com/base",
    username: "alice",
    password: "secret",
  });

  const mock = withMockedFetch(() => {
    throw timeoutError();
  });
  try {
    // 超时错误被包装为 StorageError 后原样抛出（不重试）
    await assert.rejects(provider.delete("demo.txt"), /aborted due to timeout/);
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.length, 1, "DELETE 属写操作，超时不得重试");
});

test("Koofr REST/WebDAV fetches all go through the timeout helper", async () => {
  const { refreshUpstreamTimeoutConfig } = loadModule(
    "config/upstreamTimeout.js",
  );
  refreshUpstreamTimeoutConfig({});
  const { KoofrProvider } = loadModule("services/storage/koofr-provider.js");
  const provider = new KoofrProvider({
    endpoint: "https://app.koofr.net/dav/Koofr",
    username: "alice@example.com",
    password: "secret",
    mountId: "m1",
  });

  const propfindXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/Koofr/</d:href>' +
    "<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>" +
    "</d:response></d:multistatus>";

  const mock = withMockedFetch((_attempt, url) => {
    const target = String(url);
    if (target.endsWith("/token")) {
      return new Response(JSON.stringify({ token: "tok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (target.endsWith("/api/v2/mounts")) {
      return new Response(
        JSON.stringify({
          mounts: [{ id: "m1", name: "main", isPrimary: true }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // WebDAV 根探测（PROPFIND）
    return new Response(propfindXml, { status: 207 });
  });
  try {
    await provider.testConnection();
  } finally {
    mock.restore();
  }

  // PROPFIND 根 + POST /token + GET /mounts：全部经 fetchWithUpstreamTimeout
  assert.equal(mock.calls.length, 3);
  for (const call of mock.calls) {
    assert.ok(
      call.init.signal instanceof AbortSignal,
      `Koofr fetch 必须带超时信号：${call.url}`,
    );
  }
});

test("fetchSigned retries readonly S3 commands once on timeout and re-signs per attempt", async () => {
  const { refreshUpstreamTimeoutConfig } = loadModule(
    "config/upstreamTimeout.js",
  );
  refreshUpstreamTimeoutConfig({ UPSTREAM_FETCH_READONLY_RETRIES: "1" });
  const { HeadObjectCommand } = requireFromWorker("@aws-sdk/client-s3");
  const { createS3Client, fetchSigned } = loadModule(
    "services/r2SignedRequests.js",
  );

  const client = createS3Client({
    endpoint: "https://r2.example.com",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    bucketName: "bucket",
  });

  // 第 1 次 HEAD 超时，第 2 次成功；fetchSigned 内部每次尝试都重新生成签名 URL
  const mock = withMockedFetch((attempt) => {
    if (attempt === 1) throw timeoutError();
    return new Response(null, { status: 200 });
  });
  try {
    const response = await fetchSigned(
      client,
      new HeadObjectCommand({ Bucket: "bucket", Key: "demo.txt" }),
      { method: "HEAD", expiresInSeconds: 60 },
    );
    assert.equal(response.status, 200);
  } finally {
    mock.restore();
  }

  assert.equal(mock.calls.length, 2);
  for (const call of mock.calls) {
    assert.ok(call.init.signal instanceof AbortSignal);
  }
});

test("fetchSigned does not retry write S3 commands on timeout", async () => {
  const { refreshUpstreamTimeoutConfig } = loadModule(
    "config/upstreamTimeout.js",
  );
  refreshUpstreamTimeoutConfig({});
  const { DeleteObjectCommand } = requireFromWorker("@aws-sdk/client-s3");
  const { createS3Client, fetchSigned } = loadModule(
    "services/r2SignedRequests.js",
  );

  const client = createS3Client({
    endpoint: "https://r2.example.com",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    bucketName: "bucket",
  });

  const mock = withMockedFetch(() => {
    throw timeoutError();
  });
  try {
    await assert.rejects(
      fetchSigned(
        client,
        new DeleteObjectCommand({ Bucket: "bucket", Key: "demo.txt" }),
        { method: "DELETE", expiresInSeconds: 60 },
      ),
      (error) => error.name === "TimeoutError",
    );
  } finally {
    mock.restore();
  }
  assert.equal(mock.calls.length, 1, "DELETE 属写操作，超时不得重试");
});

test("fetchSigned readonly retries are not multiplied across retry layers", async () => {
  const { refreshUpstreamTimeoutConfig } = loadModule(
    "config/upstreamTimeout.js",
  );
  // 只读重试 1 次：全超时场景总尝试次数必须是 1+1=2，
  // 而不是外层重试 × 内层重试相乘的 (1+1)^2=4 次
  refreshUpstreamTimeoutConfig({ UPSTREAM_FETCH_READONLY_RETRIES: "1" });
  const { HeadObjectCommand } = requireFromWorker("@aws-sdk/client-s3");
  const { createS3Client, fetchSigned } = loadModule(
    "services/r2SignedRequests.js",
  );

  const client = createS3Client({
    endpoint: "https://r2.example.com",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    bucketName: "bucket",
  });

  const mock = withMockedFetch(() => {
    throw timeoutError();
  });
  try {
    await assert.rejects(
      fetchSigned(
        client,
        new HeadObjectCommand({ Bucket: "bucket", Key: "demo.txt" }),
        { method: "HEAD", expiresInSeconds: 60 },
      ),
      (error) => error.name === "TimeoutError",
    );
  } finally {
    mock.restore();
  }
  assert.equal(
    mock.calls.length,
    2,
    "只读命令（retries=1）全超时时总尝试次数应为 2，不得出现两层重试相乘",
  );
});
