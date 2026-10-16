const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function loadModule(relativePath) {
  const target = path.join(COMPILED_ROOT, relativePath);
  delete require.cache[target];
  return require(target);
}

function createDb({ firstHandlers = [], runHandlers = [] } = {}) {
  const state = { runs: [] };

  function consume(list, sql, args, kind) {
    const index = list.findIndex((handler) => handler.match.test(sql));
    if (index === -1) {
      throw new Error(
        `unexpected ${kind} SQL: ${sql} / ${JSON.stringify(args)}`,
      );
    }
    const [handler] = list.splice(index, 1);
    return typeof handler.value === "function"
      ? handler.value(args, sql, state)
      : handler.value;
  }

  return {
    state,
    db: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                return consume(firstHandlers, sql, args, "first");
              },
              async run() {
                state.runs.push({ sql, args });
                return consume(runHandlers, sql, args, "run");
              },
            };
          },
        };
      },
    },
  };
}

function createRequest(url, payload) {
  const request = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  request.user = {
    id: "user-1",
    username: "alice",
    role: "user",
    status: "active",
    quota_bytes: 1024,
  };
  return request;
}

function fileRow() {
  return {
    id: "file-1",
    owner_id: "user-1",
    filename: "demo.txt",
    upload_status: "completed",
    expires_at: "9999-12-31T23:59:59.999Z",
  };
}

function textRow() {
  return {
    id: "text-1",
    owner_id: "user-1",
    title: "Demo",
  };
}

test("upsertFileShare rejects string regenerate without reading or updating the share", async () => {
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /SELECT id, owner_id, filename, upload_status, expires_at FROM files WHERE id = \? AND upload_status != \? LIMIT 1/,
        value: fileRow(),
      },
    ],
  });
  const { upsertFileShare } = loadModule("routes/fileShares.js");

  const response = await upsertFileShare(
    createRequest("https://example.com/api/files/file-1/share", {
      regenerate: "false",
      max_views: 1,
    }),
    { DB: db },
    "file-1",
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "regenerate 无效" });
  assert.equal(state.runs.length, 0);
});

test("upsertTextShare rejects string regenerate without reading or updating the share", async () => {
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /SELECT id, owner_id, title FROM texts WHERE id = \? AND deleted_at IS NULL LIMIT 1/,
        value: textRow(),
      },
    ],
  });
  const { upsertTextShare } = loadModule("routes/textShares.js");

  const response = await upsertTextShare(
    createRequest("https://example.com/api/texts/text-1/share", {
      regenerate: "false",
      max_views: 1,
    }),
    { DB: db },
    "text-1",
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "regenerate 无效" });
  assert.equal(state.runs.length, 0);
});
