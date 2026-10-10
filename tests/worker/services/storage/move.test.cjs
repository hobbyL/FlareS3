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

function clearModule(relativePath) {
  delete require.cache[compiledPath(relativePath)];
}

function withMockedFetch(fetchImpl, run) {
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      global.fetch = originalFetch;
    });
}

function loadR2ProviderModules() {
  clearModule("services/r2.js");
  clearModule("services/storage/r2-provider.js");
  const r2 = loadModule("services/r2.js");
  const providerModule = loadModule("services/storage/r2-provider.js");
  return { r2, providerModule };
}

// ── WebDAVProvider.move ──

test("WebDAVProvider.move issues MOVE with encoded Destination and Overwrite:F", async () => {
  const { WebDAVProvider } = loadModule("services/storage/webdav-provider.js");
  const provider = new WebDAVProvider({
    endpoint: "https://dav.example.com/base",
    username: "alice",
    password: "secret",
    remotePath: "/docs team",
  });

  const calls = [];
  await withMockedFetch(
    async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response("", { status: 201 });
    },
    () => provider.move("a b/report?#.txt", "arch/ive/rename#2.txt"),
  );

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(init.method, "MOVE");
  // 源 URL：remotePath + 源 key 逐段编码
  assert.equal(
    url,
    "https://dav.example.com/base/docs%20team/a%20b/report%3F%23.txt",
  );
  // Destination：完整绝对 URL，同样逐段编码
  assert.equal(
    init.headers.get("Destination"),
    "https://dav.example.com/base/docs%20team/arch/ive/rename%232.txt",
  );
  assert.equal(init.headers.get("Overwrite"), "F");
});

test("WebDAVProvider.move accepts 204 success without throwing", async () => {
  const { WebDAVProvider } = loadModule("services/storage/webdav-provider.js");
  const provider = new WebDAVProvider({
    endpoint: "https://dav.example.com/dav",
    username: "alice",
    password: "secret",
  });

  await withMockedFetch(
    async () => new Response(null, { status: 204 }),
    () => provider.move("demo.txt", "archive/demo.txt"),
  );
});

test("WebDAVProvider.move maps 404 to NotFound StorageError", async () => {
  const { WebDAVProvider } = loadModule("services/storage/webdav-provider.js");
  const provider = new WebDAVProvider({
    endpoint: "https://dav.example.com/dav",
    username: "alice",
    password: "secret",
  });

  await assert.rejects(
    () =>
      withMockedFetch(
        async () => new Response("", { status: 404 }),
        () => provider.move("missing.txt", "archive/missing.txt"),
      ),
    (error) => {
      assert.equal(error.name, "StorageError");
      assert.equal(error.code, "NotFound");
      assert.equal(error.httpStatusCode, 404);
      return true;
    },
  );
});

test("WebDAVProvider.move maps 412/409 destination conflicts to Conflict", async () => {
  const { WebDAVProvider } = loadModule("services/storage/webdav-provider.js");
  const provider = new WebDAVProvider({
    endpoint: "https://dav.example.com/dav",
    username: "alice",
    password: "secret",
  });

  for (const status of [412, 409]) {
    await assert.rejects(
      () =>
        withMockedFetch(
          async () => new Response("", { status }),
          () => provider.move("demo.txt", "target/exists.txt"),
        ),
      (error) => {
        assert.equal(error.name, "StorageError");
        assert.equal(error.code, "Conflict");
        assert.equal(error.httpStatusCode, 409);
        return true;
      },
    );
  }
});

test("KoofrProvider inherits WebDAV MOVE-based move", async () => {
  const { KoofrProvider } = loadModule("services/storage/koofr-provider.js");
  const provider = new KoofrProvider({
    endpoint: "https://app.koofr.net/dav/Koofr",
    username: "alice@example.com",
    password: "secret",
  });

  const calls = [];
  await withMockedFetch(
    async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    },
    () => provider.move("demo.txt", "archive/demo.txt"),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "MOVE");
  assert.equal(
    calls[0].init.headers.get("Destination"),
    "https://app.koofr.net/dav/Koofr/archive/demo.txt",
  );
});

// ── R2Provider.move ──

test("R2Provider.move copies to dest then deletes source", async () => {
  const { r2, providerModule } = loadR2ProviderModules();
  const config = {
    endpoint: "https://example.com",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    bucketName: "bucket",
  };

  const copyCalls = [];
  const deleteCalls = [];
  r2.copyObject = async (receivedConfig, sourceKey, destKey) => {
    copyCalls.push({ receivedConfig, sourceKey, destKey });
  };
  r2.deleteObject = async (receivedConfig, key) => {
    deleteCalls.push({ receivedConfig, key });
  };

  await providerModule.R2Provider.prototype.move.call(
    { config },
    "storage/c1/demo.txt",
    "storage/c1/archive/demo.txt",
    { size: 1024 },
  );

  assert.deepEqual(copyCalls, [
    {
      receivedConfig: config,
      sourceKey: "storage/c1/demo.txt",
      destKey: "storage/c1/archive/demo.txt",
    },
  ]);
  assert.deepEqual(deleteCalls, [
    { receivedConfig: config, key: "storage/c1/demo.txt" },
  ]);
});

test("R2Provider.move surfaces copy failures without deleting the source", async () => {
  const { r2, providerModule } = loadR2ProviderModules();
  const config = {
    endpoint: "e",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    bucketName: "b",
  };

  let deleteCalled = false;
  r2.copyObject = async () => {
    const error = new Error("copy boom");
    error.name = "EntityTooLarge";
    error.$metadata = { httpStatusCode: 400 };
    throw error;
  };
  // size 未知 + EntityTooLarge 回退路径需要补齐 totalSize；HEAD 返回 null（对象已不存在）
  // 时无法多段拷贝，必须原样上抛原始错误而不是误删源对象。
  r2.getObjectSize = async () => null;
  r2.deleteObject = async () => {
    deleteCalled = true;
  };

  await assert.rejects(
    () =>
      providerModule.R2Provider.prototype.move.call(
        { config },
        "a.txt",
        "b.txt",
      ),
    (error) => {
      assert.equal(error.name, "StorageError");
      assert.equal(error.code, "EntityTooLarge");
      return true;
    },
  );
  assert.equal(deleteCalled, false);
});

test("R2Provider.move tolerates source delete failures after a successful copy", async () => {
  const { r2, providerModule } = loadR2ProviderModules();
  const config = {
    endpoint: "e",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    bucketName: "b",
  };

  r2.copyObject = async () => {};
  r2.deleteObject = async () => {
    const error = new Error("delete boom");
    error.name = "InternalError";
    error.$metadata = { httpStatusCode: 500 };
    throw error;
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    await providerModule.R2Provider.prototype.move.call(
      { config },
      "a.txt",
      "b.txt",
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  // logWarn 管线输出单行 JSON：事件名 + key 上下文
  assert.match(warnings[0], /storage\.r2\.moveDeleteSourceFailed/);
  assert.match(warnings[0], /"sourceKey":"a\.txt"/);
});

test("R2Provider.move treats missing source after copy as success", async () => {
  const { r2, providerModule } = loadR2ProviderModules();
  const config = {
    endpoint: "e",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    bucketName: "b",
  };

  r2.copyObject = async () => {};
  r2.deleteObject = async () => {
    const error = new Error("missing");
    error.name = "NoSuchKey";
    error.$metadata = { httpStatusCode: 404 };
    throw error;
  };

  const originalWarn = console.warn;
  console.warn = () => {
    throw new Error("404 delete should not warn");
  };
  try {
    await providerModule.R2Provider.prototype.move.call(
      { config },
      "a.txt",
      "b.txt",
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("R2Provider.move routes >5GiB objects through multipart copy then deletes source", async () => {
  const { r2, providerModule } = loadR2ProviderModules();
  const config = {
    endpoint: "e",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    bucketName: "b",
  };

  const multipartCalls = [];
  const deleteCalls = [];
  let singleCopyCalled = false;
  r2.copyObject = async () => {
    singleCopyCalled = true;
  };
  r2.multipartCopyObject = async (receivedConfig, sourceKey, destKey, size) => {
    multipartCalls.push({ receivedConfig, sourceKey, destKey, size });
  };
  r2.deleteObject = async (_config, key) => {
    deleteCalls.push(key);
  };

  const size = 5 * 1024 * 1024 * 1024 + 1; // 恰好越过 5GiB 上限
  await providerModule.R2Provider.prototype.move.call(
    { config },
    "huge.bin",
    "renamed.bin",
    { size },
  );

  // >5GiB 走多段拷贝、不走单次 CopyObject；拷贝后照常删除源（move=copy+delete）
  assert.equal(singleCopyCalled, false);
  assert.deepEqual(multipartCalls, [
    {
      receivedConfig: config,
      sourceKey: "huge.bin",
      destKey: "renamed.bin",
      size,
    },
  ]);
  assert.deepEqual(deleteCalls, ["huge.bin"]);
});

test("R2Provider.move keeps the single CopyObject path for sizes at or below 5GiB", async () => {
  const { r2, providerModule } = loadR2ProviderModules();
  const config = {
    endpoint: "e",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    bucketName: "b",
  };

  let multipartCalled = false;
  const copyCalls = [];
  r2.copyObject = async (_config, sourceKey, destKey) => {
    copyCalls.push({ sourceKey, destKey });
  };
  r2.multipartCopyObject = async () => {
    multipartCalled = true;
  };
  r2.deleteObject = async () => {};

  await providerModule.R2Provider.prototype.move.call(
    { config },
    "exact.bin",
    "renamed.bin",
    { size: 5 * 1024 * 1024 * 1024 }, // 恰好 5GiB：仍走单次 CopyObject
  );

  assert.equal(multipartCalled, false);
  assert.deepEqual(copyCalls, [
    { sourceKey: "exact.bin", destKey: "renamed.bin" },
  ]);
});

test("R2Provider.move falls back to multipart when single copy reports EntityTooLarge", async () => {
  const { r2, providerModule } = loadR2ProviderModules();
  const config = {
    endpoint: "e",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    bucketName: "b",
  };

  const multipartCalls = [];
  r2.copyObject = async () => {
    const error = new Error("too large for single copy");
    error.name = "EntityTooLarge";
    error.$metadata = { httpStatusCode: 400 };
    throw error;
  };
  // size 未知：HEAD 补齐 totalSize 后回退多段拷贝
  r2.getObjectSize = async () => 7 * 1024 * 1024 * 1024;
  r2.multipartCopyObject = async (_config, sourceKey, destKey, size) => {
    multipartCalls.push({ sourceKey, destKey, size });
  };
  r2.deleteObject = async () => {};

  await providerModule.R2Provider.prototype.move.call(
    { config },
    "a.bin",
    "b.bin",
  );

  assert.deepEqual(multipartCalls, [
    { sourceKey: "a.bin", destKey: "b.bin", size: 7 * 1024 * 1024 * 1024 },
  ]);
});

// ── r2Objects.copyObject ──

function mockCopyFetchSigned(responses) {
  const signed = loadModule("services/r2SignedRequests.js");
  const calls = [];
  signed.fetchSigned = async (_client, command, init) => {
    calls.push({ command, init });
    const next = responses[calls.length - 1];
    return typeof next === "function" ? next() : next;
  };
  return { calls };
}

test("copyObject signs a PUT on the dest key with x-amz-copy-source", async () => {
  const { calls } = mockCopyFetchSigned([
    () =>
      new Response(
        "<CopyObjectResult><ETag>&quot;abc&quot;</ETag></CopyObjectResult>",
        { status: 200 },
      ),
  ]);
  const r2objects = loadModule("services/r2Objects.js");
  const config = {
    endpoint: "https://example.com",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    bucketName: "bucket",
  };

  await r2objects.copyObject(config, "a b/report?#.txt", "arch/copy.bin");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(
    calls[0].init.headers["x-amz-copy-source"],
    "/bucket/a%20b/report%3F%23.txt",
  );
  assert.equal(calls[0].command.input.Bucket, "bucket");
  assert.equal(calls[0].command.input.Key, "arch/copy.bin");
});

test("copyObject rejects 200 responses carrying an S3 Error body", async () => {
  mockCopyFetchSigned([
    () =>
      new Response(
        "<Error><Code>InvalidRequest</Code><Message>bad</Message></Error>",
        {
          status: 200,
        },
      ),
  ]);
  const r2objects = loadModule("services/r2Objects.js");

  await assert.rejects(
    () =>
      r2objects.copyObject(
        {
          endpoint: "e",
          accessKeyId: "ak",
          secretAccessKey: "sk",
          bucketName: "b",
        },
        "a.txt",
        "b.txt",
      ),
    (error) => {
      assert.equal(error.name, "InvalidRequest");
      assert.equal(error.$metadata.httpStatusCode, 200);
      return true;
    },
  );
});

test("copyObject maps non-200 upstream failures", async () => {
  mockCopyFetchSigned([
    () =>
      new Response(
        "<Error><Code>AccessDenied</Code><Message>denied</Message></Error>",
        { status: 403 },
      ),
  ]);
  const r2objects = loadModule("services/r2Objects.js");

  await assert.rejects(
    () =>
      r2objects.copyObject(
        {
          endpoint: "e",
          accessKeyId: "ak",
          secretAccessKey: "sk",
          bucketName: "b",
        },
        "a.txt",
        "b.txt",
      ),
    (error) => {
      assert.equal(error.name, "AccessDenied");
      assert.equal(error.$metadata.httpStatusCode, 403);
      return true;
    },
  );
});
