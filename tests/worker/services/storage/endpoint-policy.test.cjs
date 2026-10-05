const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relativePath) {
  return path.join(COMPILED_ROOT, relativePath);
}

test("validateExternalEndpoint accepts normalized public HTTPS endpoints only", () => {
  const { validateExternalEndpoint } = require(
    compiledPath("services/endpointPolicy.js"),
  );

  assert.deepEqual(validateExternalEndpoint("https://storage.example.com/"), {
    ok: true,
    url: "https://storage.example.com",
  });
  assert.deepEqual(validateExternalEndpoint("http://storage.example.com"), {
    ok: false,
    message: "endpoint 必须使用 https",
  });
});

test("validateExternalEndpoint rejects non-decimal IPv4 notation that maps to private addresses", () => {
  const { validateExternalEndpoint } = require(
    compiledPath("services/endpointPolicy.js"),
  );
  // 十进制整数 / 十六进制 / 八进制等 IPv4 变体必须先归一化再进黑名单
  const blockedVariants = [
    "https://2130706433", // 127.0.0.1
    "https://0x7f000001", // 127.0.0.1（十六进制整数）
    "https://0x7f.0.0.1", // 十六进制分段
    "https://0177.0.0.1", // 八进制分段
    "https://017700000001", // 八进制整数 → 127.0.0.1
    "https://167772161", // 10.0.0.1（十进制整数）
  ];

  for (const endpoint of blockedVariants) {
    const result = validateExternalEndpoint(endpoint);
    assert.equal(result.ok, false, endpoint);
    if (!result.ok) {
      assert.match(result.message, /不能指向本机、内网或保留地址/);
    }
  }

  // 合法公网 IPv4 不受归一化影响
  assert.deepEqual(validateExternalEndpoint("https://8.8.8.8/"), {
    ok: true,
    url: "https://8.8.8.8",
  });
  assert.deepEqual(validateExternalEndpoint("https://1.1.1.1"), {
    ok: true,
    url: "https://1.1.1.1",
  });
});

test("validateExternalEndpoint rejects local, private and reserved address endpoints", () => {
  const { validateExternalEndpoint } = require(
    compiledPath("services/endpointPolicy.js"),
  );
  const blocked = [
    "https://localhost",
    "https://api.internal",
    "https://192.168.1.10",
    "https://10.0.0.10",
    "https://172.16.0.10",
    "https://169.254.169.254",
    "https://100.64.0.1",
    "https://198.18.0.1",
    "https://203.0.113.10",
    "https://[::1]",
    "https://[fd00::1]",
    "https://[fe80::1]",
    "https://[ff02::1]",
    "https://[2001:db8::1]",
    "https://[::ffff:127.0.0.1]",
    "https://[::ffff:10.0.0.1]",
    "https://[::ffff:7f00:1]",
    "https://[::ffff:a00:1]",
  ];

  for (const endpoint of blocked) {
    assert.deepEqual(
      validateExternalEndpoint(endpoint),
      {
        ok: false,
        message: "endpoint 不能指向本机、内网或保留地址",
      },
      endpoint,
    );
  }
});
