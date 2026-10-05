const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

const { validateEnv, validateEnvOrWarn, EnvValidationError } = require(
  path.join(COMPILED_ROOT, "config/envValidation.js"),
);

const VALID_SECRET = "a".repeat(32);
// 32 字节 base64，长度 44
const VALID_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

function validEnv(overrides = {}) {
  return {
    DB: {},
    AUTH_TOKEN_SECRET: VALID_SECRET,
    R2_MASTER_KEY: VALID_MASTER_KEY,
    ...overrides,
  };
}

function captureError(fn) {
  const original = console.error;
  const entries = [];
  console.error = (...args) => entries.push(args);
  try {
    return { result: fn(), entries };
  } finally {
    console.error = original;
  }
}

test("完整合法配置通过校验", () => {
  assert.doesNotThrow(() => validateEnv(validEnv()));
});

test("缺少 DB 绑定时报错", () => {
  assert.throws(() => validateEnv(validEnv({ DB: undefined })), /DB/);
  assert.throws(() => validateEnv(validEnv({ DB: null })), /必填字段缺失/);
  assert.throws(
    () => validateEnv(validEnv({ DB: "not-a-binding" })),
    /DB 绑定缺失或无效/,
  );
});

test("AUTH_TOKEN_SECRET 必须是长度不少于 32 的非空字符串", () => {
  assert.throws(
    () => validateEnv(validEnv({ AUTH_TOKEN_SECRET: undefined })),
    /AUTH_TOKEN_SECRET/,
  );
  assert.throws(
    () => validateEnv(validEnv({ AUTH_TOKEN_SECRET: "   " })),
    /必须是非空字符串/,
  );
  assert.throws(
    () => validateEnv(validEnv({ AUTH_TOKEN_SECRET: "a".repeat(31) })),
    /长度至少为 32 字符（当前: 31）/,
  );
  assert.doesNotThrow(() =>
    validateEnv(validEnv({ AUTH_TOKEN_SECRET: "a".repeat(32) })),
  );
});

test("R2_MASTER_KEY 必须是 32 字节 base64", () => {
  assert.throws(
    () => validateEnv(validEnv({ R2_MASTER_KEY: undefined })),
    /R2_MASTER_KEY/,
  );
  assert.throws(
    () => validateEnv(validEnv({ R2_MASTER_KEY: "short" })),
    /预期长度: 44/,
  );
  assert.throws(
    () => validateEnv(validEnv({ R2_MASTER_KEY: "!".repeat(44) })),
    /不是有效的 base64 编码|解码后应为 32 字节/,
  );
  assert.doesNotThrow(() =>
    validateEnv(validEnv({ R2_MASTER_KEY: VALID_MASTER_KEY })),
  );
});

test("可选的容量配置为空时跳过校验，非正数时报错", () => {
  for (const value of [undefined, null, ""]) {
    assert.doesNotThrow(() =>
      validateEnv(validEnv({ MAX_FILE_SIZE: value, TOTAL_STORAGE: value })),
    );
  }

  assert.throws(
    () => validateEnv(validEnv({ MAX_FILE_SIZE: "0" })),
    /MAX_FILE_SIZE 必须是正数/,
  );
  assert.throws(
    () => validateEnv(validEnv({ TOTAL_STORAGE: "abc" })),
    /TOTAL_STORAGE 必须是正数/,
  );
});

test("限流阈值环境变量为空时跳过，非正数时逐项报错", () => {
  const fields = [
    "RATE_LIMIT_WINDOW_MS",
    "RATE_LIMIT_MAX",
    "RATE_LIMIT_MAX_FAILED_ATTEMPTS",
    "RATE_LIMIT_BLOCK_DURATION_MS",
    "SHARE_RATE_LIMIT_MAX_FAILED_ATTEMPTS",
    "SHARE_RATE_LIMIT_BLOCK_DURATION_MS",
    "PUBLIC_RATE_LIMIT_WINDOW_MS",
    "PUBLIC_RATE_LIMIT_MAX",
  ];

  for (const field of fields) {
    assert.doesNotThrow(
      () => validateEnv(validEnv({ [field]: "" })),
      `${field} 为空串时应跳过校验`,
    );
    assert.doesNotThrow(
      () => validateEnv(validEnv({ [field]: "120" })),
      `${field} 为正数时应通过`,
    );
    assert.throws(
      () => validateEnv(validEnv({ [field]: "-1" })),
      new RegExp(`${field} 必须是正数`),
      `${field} 为负数时应报错`,
    );
    assert.throws(
      () => validateEnv(validEnv({ [field]: "oops" })),
      new RegExp(`${field} 必须是正数`),
    );
  }
});

test("上游 fetch 超时环境变量为空时跳过，非正数时逐项报错", () => {
  const fields = [
    "UPSTREAM_FETCH_TIMEOUT_MS",
    "UPSTREAM_FETCH_READONLY_RETRIES",
  ];

  for (const field of fields) {
    for (const value of [undefined, null, ""]) {
      assert.doesNotThrow(
        () => validateEnv(validEnv({ [field]: value })),
        `${field} 未配置时应跳过校验`,
      );
    }
    assert.doesNotThrow(() => validateEnv(validEnv({ [field]: "30000" })));
    assert.throws(
      () => validateEnv(validEnv({ [field]: "0" })),
      new RegExp(`${field} 必须是正数`),
    );
    assert.throws(
      () => validateEnv(validEnv({ [field]: "nope" })),
      new RegExp(`${field} 必须是正数`),
    );
  }
});

test("多个字段同时出错时一次性汇总全部原因", () => {
  let message = "";
  try {
    validateEnv({
      DB: undefined,
      AUTH_TOKEN_SECRET: "too-short",
      R2_MASTER_KEY: "bad",
      MAX_FILE_SIZE: "-5",
    });
  } catch (error) {
    message = error.message;
  }

  assert.match(message, /环境变量验证失败:/);
  assert.match(message, /- DB:/);
  assert.match(message, /- AUTH_TOKEN_SECRET:/);
  assert.match(message, /- R2_MASTER_KEY:/);
  assert.match(message, /- MAX_FILE_SIZE:/);
  assert.equal(message.split("\n").length, 5, "标题行 + 4 条原因");
});

test("EnvValidationError 携带字段与原因", () => {
  const error = new EnvValidationError("AUTH_TOKEN_SECRET", "太短了");
  assert.equal(error.name, "EnvValidationError");
  assert.equal(error.field, "AUTH_TOKEN_SECRET");
  assert.equal(error.reason, "太短了");
  assert.match(error.message, /环境变量验证失败: AUTH_TOKEN_SECRET - 太短了/);
});

test("validateEnvOrWarn 合法时返回 true 且不写日志", () => {
  const { result, entries } = captureError(() => validateEnvOrWarn(validEnv()));
  assert.equal(result, true);
  assert.equal(entries.length, 0);
});

test("validateEnvOrWarn 非法时返回 false 并输出结构化 env.validation.failed 日志而不抛出", () => {
  const { result, entries } = captureError(() =>
    validateEnvOrWarn({ DB: undefined }),
  );

  assert.equal(result, false, "校验失败不得中断 Worker 启动");
  assert.equal(entries.length, 1);
  // 收口为 logStructured 后输出单行 JSON，按结构化字段断言
  const log = JSON.parse(entries[0][0]);
  assert.equal(log.level, "error");
  assert.equal(log.event, "env.validation.failed");
  assert.match(String(log.message), /环境变量验证失败/);
});
