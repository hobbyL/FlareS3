const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function compiledPath(relative) {
  return path.join(COMPILED_ROOT, relative);
}

/**
 * 安全收紧回归测试（10-05-p2p3-security 阶段一）：
 * - P3-2 updateUser 枚举白名单
 * - P3-6 getClientIp 仅信任 CF-Connecting-IP（此处复跑一次与 rate-limit-middleware 互补的契约）
 * - P2-1/P3-1 登录计时拉平：用户不存在路径也执行等价成本哈希
 */
const { updateUser } = require(compiledPath("routes/users.js"));
const { getClientIp } = require(compiledPath("middleware/rateLimit.js"));

function makeJsonRequest(url, body, headers = {}) {
  return new Request(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("updateUser 拒绝非法 status 枚举值", async () => {
  const response = await updateUser(
    makeJsonRequest("https://example.com/api/users/u1", { status: "Active" }),
    {
      DB: {
        prepare() {
          throw new Error("invalid enum should not touch D1");
        },
      },
    },
    "u1",
  );
  assert.equal(response.status, 400);
  assert.match(
    (await response.json()).error,
    /status 必须为 active 或 disabled/,
  );
});

test("updateUser 拒绝非法 role 枚举值", async () => {
  const response = await updateUser(
    makeJsonRequest("https://example.com/api/users/u1", { role: "superadmin" }),
    {
      DB: {
        prepare() {
          throw new Error("invalid enum should not touch D1");
        },
      },
    },
    "u1",
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /role 必须为 admin 或 user/);
});

test("updateUser 接受合法枚举值组合", async () => {
  const response = await updateUser(
    makeJsonRequest("https://example.com/api/users/u1", {
      status: "disabled",
      role: "user",
    }),
    {
      DB: {
        prepare(sql) {
          if (sql.includes("SELECT role, status FROM users")) {
            return {
              bind() {
                return {
                  async first() {
                    return { role: "user", status: "active" };
                  },
                };
              },
            };
          }
          if (sql.includes("SELECT COUNT")) {
            return {
              bind() {
                return {
                  async first() {
                    return { total: 2 };
                  },
                };
              },
            };
          }
          if (sql.startsWith("UPDATE users")) {
            return {
              bind() {
                return {
                  async run() {
                    return { meta: { changes: 1 } };
                  },
                };
              },
            };
          }
          // status 变更后撤销该用户会话
          if (sql.startsWith("UPDATE sessions")) {
            return {
              bind() {
                return {
                  async run() {
                    return { meta: { changes: 1 } };
                  },
                };
              },
            };
          }
          // updateUser 尾部会写审计日志（INSERT INTO audit_logs 或经 batch）
          if (sql.includes("INSERT INTO audit_logs")) {
            return {
              bind() {
                return {
                  async run() {
                    return { meta: { changes: 1 } };
                  },
                };
              },
            };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
        // isLastActiveAdmin 之外可能出现 batch(audit + update) 组合
        async batch(statements) {
          return Promise.all(statements.map((statement) => statement.run()));
        },
      },
    },
    "u1",
  );
  assert.equal(response.status, 200);
});

test("getClientIp 的 XFF 不再作为回退来源", () => {
  const request = new Request("https://example.com/", {
    headers: { "X-Forwarded-For": "6.6.6.6, 7.7.7.7" },
  });
  assert.equal(getClientIp(request), "unknown");
  assert.equal(
    getClientIp(
      new Request("https://example.com/", {
        headers: { "CF-Connecting-IP": "203.0.113.5" },
      }),
    ),
    "203.0.113.5",
  );
});
