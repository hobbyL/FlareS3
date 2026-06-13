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

test("readBoundedResponseText rejects oversized upstream metadata responses", async () => {
  const { UpstreamResponseBodyLimitError, readBoundedResponseText } =
    loadModule("services/upstreamResponsePolicy.js");

  await assert.rejects(
    () => readBoundedResponseText(new Response("abcdef"), 5, "测试响应"),
    (error) =>
      error instanceof UpstreamResponseBodyLimitError &&
      /测试响应大小超过限制/.test(error.message),
  );
});

test("readBoundedResponseText truncates oversized upstream error responses when requested", async () => {
  const { readBoundedResponseText } = loadModule(
    "services/upstreamResponsePolicy.js",
  );

  const text = await readBoundedResponseText(
    new Response("abcdef"),
    5,
    "错误响应",
    {
      truncate: true,
    },
  );

  assert.equal(text, "abcde");
});

test("readBoundedResponseJson uses the same upstream size guard", async () => {
  const { UpstreamResponseBodyLimitError, readBoundedResponseJson } =
    loadModule("services/upstreamResponsePolicy.js");

  await assert.rejects(
    () => readBoundedResponseJson(new Response('{"ok":true}'), 5, "JSON 响应"),
    (error) =>
      error instanceof UpstreamResponseBodyLimitError &&
      /JSON 响应大小超过限制/.test(error.message),
  );
});
