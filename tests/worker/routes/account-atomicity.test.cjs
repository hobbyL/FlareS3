const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createSqliteDb } = require("../helpers/sqlite-db.cjs");
const root =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");
const users = require(path.join(root, "routes/users.js"));
const auth = require(path.join(root, "routes/auth.js"));
const passwords = require(path.join(root, "services/password.js"));
const oneTime = require(path.join(root, "routes/textOneTimeShares.js"));

function setup() {
  const state = createSqliteDb();
  const insert = state.sqlite
    .prepare(`INSERT INTO users(id,username,password_hash,role,status,quota_bytes,created_at,updated_at)
    VALUES(?,?,? ,?,'active',1000,'2026-01-01','2026-01-01')`);
  for (const [id, role] of [
    ["a", "admin"],
    ["b", "admin"],
    ["u", "user"],
  ])
    insert.run(id, id, "original-hash", role);
  state.sqlite
    .exec(`INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at)
    VALUES('su','u','hu','9999-01-01','2026-01-01'),('su2','u','hu2','9999-01-01','2026-01-01'),
      ('sa','a','ha','9999-01-01','2026-01-01'),('sb','b','hb','9999-01-01','2026-01-01');
    INSERT INTO api_tokens(id,user_id,name,token_hash,created_at)
    VALUES('pu','u','first','pu','2026-01-01'),('pa','a','foreign','pa','2026-01-01');`);
  return state;
}
function request(body, actor = "a") {
  return Object.assign(
    new Request("https://example.com/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    {
      user: {
        id: actor,
        role: actor === "u" ? "user" : "admin",
        status: "active",
        quota_bytes: 1000,
      },
      authKind: "session",
      sessionId: `s${actor}`,
    },
  );
}

test("a deleted user cannot be enabled while resource cleanup is pending", async () => {
  const { db, sqlite } = setup();
  sqlite.exec("UPDATE users SET status = 'deleted' WHERE id = 'u'");
  assert.equal(
    (await users.updateUser(request({ status: "active" }), { DB: db }, "u"))
      .status,
    409,
  );
  assert.equal(
    sqlite.prepare("SELECT status FROM users WHERE id='u'").get().status,
    "deleted",
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n,
    0,
  );
  sqlite.close();
});

for (const failure of ["session", "audit"]) {
  test(`password reset rolls back password and sessions when ${failure} write fails`, async () => {
    const { db, sqlite } = setup();
    sqlite.exec(
      failure === "session"
        ? `CREATE TRIGGER fail_revoke BEFORE UPDATE OF revoked_at ON sessions BEGIN SELECT RAISE(ABORT,'injected_failure'); END;`
        : `CREATE TRIGGER fail_revoke BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'injected_failure'); END;`,
    );
    assert.equal(
      (
        await users.resetPassword(
          request({ password: "new-password-456" }),
          { DB: db },
          "u",
        )
      ).status,
      500,
    );
    assert.equal(
      sqlite.prepare("SELECT password_hash FROM users WHERE id='u'").get()
        .password_hash,
      "original-hash",
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM sessions WHERE user_id='u' AND revoked_at IS NULL",
        )
        .get().n,
      2,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n,
      0,
    );
    sqlite.exec("DROP TRIGGER fail_revoke");
    assert.equal(
      (
        await users.resetPassword(
          request({ password: "new-password-456" }),
          { DB: db },
          "u",
        )
      ).status,
      200,
    );
    assert.equal(
      passwords.verifyPassword(
        "new-password-456",
        sqlite.prepare("SELECT password_hash FROM users WHERE id='u'").get()
          .password_hash,
      ),
      true,
    );
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM sessions WHERE user_id='u' AND revoked_at IS NULL",
        )
        .get().n,
      0,
    );
    sqlite.close();
  });
}
test("role change rolls back when session revocation fails", async () => {
  const { db, sqlite } = setup();
  sqlite.exec(
    `CREATE TRIGGER fail_revoke BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'injected_failure'); END;`,
  );
  assert.equal(
    (await users.updateUser(request({ role: "admin" }), { DB: db }, "u"))
      .status,
    500,
  );
  assert.equal(
    sqlite.prepare("SELECT role FROM users WHERE id='u'").get().role,
    "user",
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n,
    0,
  );
  sqlite.close();
});
for (const body of [{ status: "disabled" }, { role: "user" }]) {
  test(`simultaneous admin ${Object.keys(body)[0]} changes preserve one active administrator`, async () => {
    const { db, sqlite } = setup();
    const batch = db.batch.bind(db);
    let arrivals = 0,
      release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let writes = Promise.resolve();
    db.batch = async (statements) => {
      if (++arrivals === 2) release();
      await gate;
      const operation = writes.then(() => batch(statements));
      writes = operation.catch(() => {});
      return operation;
    };
    const responses = await Promise.all([
      users.updateUser(request(body, "a"), { DB: db }, "b"),
      users.updateUser(request(body, "b"), { DB: db }, "a"),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
    assert.equal(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'",
        )
        .get().n,
      1,
    );
    assert.equal(
      sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n,
      1,
    );
    const survivor = sqlite
      .prepare("SELECT id FROM users WHERE role='admin' AND status='active'")
      .get().id;
    assert.equal(
      sqlite
        .prepare("SELECT revoked_at FROM sessions WHERE user_id=?")
        .get(survivor).revoked_at,
      null,
    );
    sqlite.close();
  });
}
test("revoke all credentials includes current session, isolates owner, and is idempotent", async () => {
  const { db, sqlite } = setup();
  const first = await auth.revokeAllCredentials(request(undefined, "u"), {
    DB: db,
  });
  assert.deepEqual(await first.json(), {
    success: true,
    sessions_revoked: 2,
    tokens_revoked: 1,
    propagation_seconds: 5,
  });
  assert.equal(
    sqlite.prepare("SELECT revoked_at FROM sessions WHERE id='sa'").get()
      .revoked_at,
    null,
  );
  assert.equal(
    sqlite.prepare("SELECT revoked_at FROM api_tokens WHERE id='pa'").get()
      .revoked_at,
    null,
  );
  const repeat = await auth.revokeAllCredentials(request(undefined, "u"), {
    DB: db,
  });
  assert.equal((await repeat.json()).sessions_revoked, 0);
  assert.equal(
    (
      await auth.revokeAllCredentials(
        Object.assign(request(undefined, "u"), { authKind: "pat" }),
        { DB: db },
      )
    ).status,
    403,
  );
  sqlite.close();
});
test("revoke all credentials rolls back sessions if token update fails", async () => {
  const { db, sqlite } = setup();
  sqlite.exec(
    `CREATE TRIGGER fail_token BEFORE UPDATE ON api_tokens BEGIN SELECT RAISE(ABORT,'injected_failure'); END;`,
  );
  await assert.rejects(
    () => auth.revokeAllCredentials(request(undefined, "u"), { DB: db }),
    /injected_failure/,
  );
  assert.equal(
    sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE user_id='u' AND revoked_at IS NULL",
      )
      .get().n,
    2,
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs").get().n,
    0,
  );
  sqlite.close();
});

test("a previously valid PAT fails authentication immediately after revoke-all", async () => {
  const { db, sqlite } = setup();
  const { hashToken } = require(path.join(root, "utils/token.js"));
  const { validateApiToken } = require(
    path.join(root, "services/apiTokens.js"),
  );
  const token = `fla_${"a".repeat(64)}`;
  sqlite
    .prepare("UPDATE api_tokens SET token_hash=? WHERE id='pu'")
    .run(await hashToken(token));
  assert.ok(await validateApiToken({ DB: db }, token));
  await auth.revokeAllCredentials(request(undefined, "u"), { DB: db });
  assert.equal(await validateApiToken({ DB: db }, token), null);
  sqlite.close();
});
test("old one-time POST snapshot cannot consume regenerated share code", async () => {
  const { db, sqlite } = setup();
  sqlite.exec(`INSERT INTO texts(id,owner_id,title,content,created_at,updated_at) VALUES('t','u','note','ONE_TIME_SECRET','2026-01-01','2026-01-01');
    INSERT INTO text_one_time_shares(id,text_id,owner_id,share_code,expires_at,created_at,updated_at) VALUES('ot','t','u','OldCode001','9999-01-01','2026-01-01','2026-01-01');`);
  const prepare = db.prepare.bind(db);
  let intercepted = false,
    newCode;
  db.prepare = (sql) => {
    const stmt = prepare(sql);
    if (!sql.includes("FROM text_one_time_shares s")) return stmt;
    return {
      ...stmt,
      bind(...args) {
        const bound = stmt.bind(...args);
        return {
          ...bound,
          async first() {
            const old = await bound.first();
            if (!intercepted) {
              intercepted = true;
              const regenerated = await oneTime.createTextOneTimeShare(
                request(undefined, "u"),
                { DB: db },
                "t",
              );
              assert.equal(regenerated.status, 200);
              newCode = (await regenerated.json()).share.share_code;
            }
            return old;
          },
        };
      },
    };
  };
  const view = (code) =>
    oneTime.tryViewTextOneTimeShare(
      new Request(`https://example.com/s/${code}`, { method: "POST" }),
      { DB: db },
      code,
    );
  const old = await view("OldCode001");
  assert.equal(old.status, 410);
  assert.doesNotMatch(await old.text(), /ONE_TIME_SECRET/);
  assert.equal(
    sqlite
      .prepare("SELECT consumed_at FROM text_one_time_shares WHERE id='ot'")
      .get().consumed_at,
    null,
  );
  const current = await view(newCode);
  assert.equal(current.status, 200);
  assert.match(await current.text(), /ONE_TIME_SECRET/);
  assert.equal((await view(newCode)).status, 410);
  sqlite.close();
});
