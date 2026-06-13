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

function createAuthedRequest(url, { method = "GET", user } = {}) {
  const request = new Request(url, { method });
  request.user = user || {
    id: "user-1",
    username: "alice",
    role: "user",
    status: "active",
    quota_bytes: 1024,
  };
  return request;
}

function createDb({ firstHandlers = [], allHandlers = [], runHandlers = [] }) {
  const state = {
    runs: [],
    alls: [],
  };

  function consume(list, sql, args, kind) {
    const index = list.findIndex((handler) => handler.match.test(sql));
    if (index === -1) {
      if (
        kind === "run" &&
        /^(CREATE|ALTER TABLE|CREATE INDEX)/i.test(sql.trim())
      ) {
        return { meta: { changes: 0 } };
      }
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
              async all() {
                state.alls.push({ sql, args });
                return consume(allHandlers, sql, args, "all");
              },
              async run() {
                state.runs.push({ sql, args });
                return consume(runHandlers, sql, args, "run");
              },
            };
          },
          async first() {
            return consume(firstHandlers, sql, [], "first");
          },
          async all() {
            state.alls.push({ sql, args: [] });
            return consume(allHandlers, sql, [], "all");
          },
          async run() {
            state.runs.push({ sql, args: [] });
            return consume(runHandlers, sql, [], "run");
          },
        };
      },
    },
  };
}

test("listShares limits records to current user for non-admin requests", async () => {
  const { listShares } = loadModule("routes/shares.js");
  const { db } = createDb({
    allHandlers: [
      {
        match: /FROM file_shares/i,
        value: {
          results: [
            {
              file_id: "file-1",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "file-code-1",
              password_hash: null,
              expires_at: "9999-12-31T23:59:59.999Z",
              max_views: 0,
              views: 2,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T10:00:00.000Z",
              filename: "alpha.txt",
              file_deleted_at: null,
              owner_status: "active",
            },
            {
              file_id: "file-2",
              owner_id: "user-2",
              owner_username: "bob",
              share_code: "file-code-2",
              password_hash: "hashed",
              expires_at: "9999-12-31T23:59:59.999Z",
              max_views: 0,
              views: 1,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T09:00:00.000Z",
              filename: "beta.txt",
              file_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
      {
        match: /FROM text_shares/i,
        value: {
          results: [
            {
              text_id: "text-1",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "text-code-1",
              password_hash: null,
              expires_at: "9999-12-31T23:59:59.999Z",
              max_views: 3,
              views: 1,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T11:00:00.000Z",
              text_title: "Doc A",
              text_deleted_at: null,
              owner_status: "active",
            },
            {
              text_id: "text-2",
              owner_id: "user-2",
              owner_username: "bob",
              share_code: "text-code-2",
              password_hash: null,
              expires_at: "9999-12-31T23:59:59.999Z",
              max_views: 0,
              views: 0,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T08:00:00.000Z",
              text_title: "Doc B",
              text_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
      {
        match: /FROM text_one_time_shares/i,
        value: {
          results: [
            {
              text_id: "text-ot-1",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "ot-code-1",
              expires_at: "9999-12-31T23:59:59.999Z",
              consumed_at: null,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T12:00:00.000Z",
              text_title: "One Time A",
              text_deleted_at: null,
              owner_status: "active",
            },
            {
              text_id: "text-ot-2",
              owner_id: "user-2",
              owner_username: "bob",
              share_code: "ot-code-2",
              expires_at: "9999-12-31T23:59:59.999Z",
              consumed_at: null,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T07:00:00.000Z",
              text_title: "One Time B",
              text_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
    ],
  });

  const response = await listShares(
    createAuthedRequest("https://example.com/api/shares"),
    { DB: db },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.total, 3);
  assert.equal(body.items.length, 3);
  assert.equal(
    body.items.every((item) => item.owner_id === "user-1"),
    true,
  );
  assert.deepEqual(
    body.items.map((item) => item.type),
    ["text_one_time", "text", "file"],
  );
  assert.equal(body.items[0].share_url, "/s/ot-code-1");
  assert.equal(body.items[1].share_url, "/t/text-code-1");
  assert.equal(body.items[2].share_url, "/f/file-code-1");
  assert.match(
    response.headers.get("X-Flares3-Route-Timing") || "",
    /shareFileRows=\d+\.\dms/,
  );
  assert.match(
    response.headers.get("Server-Timing") || "",
    /shareFilterSort;dur=\d+\.\d/,
  );
});

test("listShares applies admin owner, type and status filters", async () => {
  const { listShares } = loadModule("routes/shares.js");
  const { db } = createDb({
    allHandlers: [
      {
        match: /FROM file_shares/i,
        value: {
          results: [
            {
              file_id: "file-1",
              owner_id: "user-2",
              owner_username: "bob",
              share_code: "file-code-1",
              password_hash: null,
              expires_at: "9999-12-31T23:59:59.999Z",
              max_views: 0,
              views: 0,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T10:00:00.000Z",
              filename: "alpha.txt",
              file_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
      {
        match: /FROM text_shares/i,
        value: {
          results: [
            {
              text_id: "text-1",
              owner_id: "user-2",
              owner_username: "bob",
              share_code: "text-code-1",
              password_hash: null,
              expires_at: "2000-01-01T00:00:00.000Z",
              max_views: 0,
              views: 0,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T11:00:00.000Z",
              text_title: "Doc A",
              text_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
      {
        match: /FROM text_one_time_shares/i,
        value: {
          results: [
            {
              text_id: "text-ot-1",
              owner_id: "user-2",
              owner_username: "bob",
              share_code: "ot-code-1",
              expires_at: "9999-12-31T23:59:59.999Z",
              consumed_at: "2026-04-12T09:00:00.000Z",
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T12:00:00.000Z",
              text_title: "One Time A",
              text_deleted_at: null,
              owner_status: "active",
            },
            {
              text_id: "text-ot-2",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "ot-code-2",
              expires_at: "9999-12-31T23:59:59.999Z",
              consumed_at: null,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T13:00:00.000Z",
              text_title: "One Time B",
              text_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
    ],
  });

  const request = createAuthedRequest(
    "https://example.com/api/shares?owner_id=user-2&type=text_one_time&status=consumed",
    {
      user: {
        id: "admin-1",
        username: "admin",
        role: "admin",
        status: "active",
        quota_bytes: 1024,
      },
    },
  );

  const response = await listShares(request, { DB: db });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.total, 1);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].type, "text_one_time");
  assert.equal(body.items[0].owner_id, "user-2");
  assert.equal(body.items[0].status, "consumed");
  assert.equal(body.items[0].share_url, "/s/ot-code-1");
});

test("listShares applies q search for non-admin resource names and share codes without leaking other users records", async () => {
  const { listShares } = loadModule("routes/shares.js");

  const createSearchDb = () =>
    createDb({
      allHandlers: [
        {
          match: /FROM file_shares/i,
          value: {
            results: [
              {
                file_id: "file-1",
                owner_id: "user-1",
                owner_username: "alice",
                share_code: "file-code-1",
                password_hash: null,
                expires_at: "9999-12-31T23:59:59.999Z",
                max_views: 0,
                views: 2,
                created_at: "2026-04-10T00:00:00.000Z",
                updated_at: "2026-04-12T10:00:00.000Z",
                filename: "alpha.txt",
                file_deleted_at: null,
                owner_status: "active",
              },
              {
                file_id: "file-2",
                owner_id: "user-2",
                owner_username: "bob",
                share_code: "alpha-leak",
                password_hash: null,
                expires_at: "9999-12-31T23:59:59.999Z",
                max_views: 0,
                views: 1,
                created_at: "2026-04-10T00:00:00.000Z",
                updated_at: "2026-04-12T09:00:00.000Z",
                filename: "alpha-secret.txt",
                file_deleted_at: null,
                owner_status: "active",
              },
            ],
          },
        },
        {
          match: /FROM text_shares/i,
          value: {
            results: [
              {
                text_id: "text-1",
                owner_id: "user-1",
                owner_username: "alice",
                share_code: "notes-code-1",
                password_hash: null,
                expires_at: "9999-12-31T23:59:59.999Z",
                max_views: 0,
                views: 0,
                created_at: "2026-04-10T00:00:00.000Z",
                updated_at: "2026-04-12T08:00:00.000Z",
                text_title: "Release Notes",
                text_deleted_at: null,
                owner_status: "active",
              },
            ],
          },
        },
        {
          match: /FROM text_one_time_shares/i,
          value: {
            results: [
              {
                text_id: "text-ot-1",
                owner_id: "user-1",
                owner_username: "alice",
                share_code: "one-time-code-1",
                expires_at: "9999-12-31T23:59:59.999Z",
                consumed_at: null,
                created_at: "2026-04-10T00:00:00.000Z",
                updated_at: "2026-04-12T07:00:00.000Z",
                text_title: "Onboarding",
                text_deleted_at: null,
                owner_status: "active",
              },
            ],
          },
        },
      ],
    });

  const { db: dbByName } = createSearchDb();
  const byNameResponse = await listShares(
    createAuthedRequest("https://example.com/api/shares?q=alpha"),
    { DB: dbByName },
  );
  const byNameBody = await byNameResponse.json();

  assert.equal(byNameResponse.status, 200);
  assert.equal(byNameBody.total, 1);
  assert.deepEqual(
    byNameBody.items.map((item) => item.resource_id),
    ["file-1"],
  );

  const { db: dbByCode } = createSearchDb();
  const byCodeResponse = await listShares(
    createAuthedRequest("https://example.com/api/shares?q=file-code-1"),
    { DB: dbByCode },
  );
  const byCodeBody = await byCodeResponse.json();

  assert.equal(byCodeResponse.status, 200);
  assert.equal(byCodeBody.total, 1);
  assert.deepEqual(
    byCodeBody.items.map((item) => item.share_code),
    ["file-code-1"],
  );
  assert.equal(
    byCodeBody.items.every((item) => item.owner_id === "user-1"),
    true,
  );
});

test("listShares lets admin search owner metadata and combine q with existing filters", async () => {
  const { listShares } = loadModule("routes/shares.js");

  const createAdminSearchDb = () =>
    createDb({
      allHandlers: [
        {
          match: /FROM file_shares/i,
          value: {
            results: [
              {
                file_id: "file-1",
                owner_id: "user-2",
                owner_username: "bob",
                share_code: "file-code-1",
                password_hash: null,
                expires_at: "9999-12-31T23:59:59.999Z",
                max_views: 0,
                views: 0,
                created_at: "2026-04-10T00:00:00.000Z",
                updated_at: "2026-04-12T10:00:00.000Z",
                filename: "alpha.txt",
                file_deleted_at: null,
                owner_status: "active",
              },
              {
                file_id: "file-2",
                owner_id: "user-3",
                owner_username: "carol",
                share_code: "file-code-2",
                password_hash: null,
                expires_at: "9999-12-31T23:59:59.999Z",
                max_views: 0,
                views: 0,
                created_at: "2026-04-10T00:00:00.000Z",
                updated_at: "2026-04-12T09:00:00.000Z",
                filename: "beta.txt",
                file_deleted_at: null,
                owner_status: "active",
              },
            ],
          },
        },
        {
          match: /FROM text_shares/i,
          value: {
            results: [
              {
                text_id: "text-1",
                owner_id: "user-2",
                owner_username: "bob",
                share_code: "text-code-1",
                password_hash: null,
                expires_at: "9999-12-31T23:59:59.999Z",
                max_views: 0,
                views: 0,
                created_at: "2026-04-10T00:00:00.000Z",
                updated_at: "2026-04-12T11:00:00.000Z",
                text_title: "Doc A",
                text_deleted_at: null,
                owner_status: "active",
              },
            ],
          },
        },
        {
          match: /FROM text_one_time_shares/i,
          value: {
            results: [
              {
                text_id: "text-ot-1",
                owner_id: "user-2",
                owner_username: "bob",
                share_code: "ot-code-1",
                expires_at: "9999-12-31T23:59:59.999Z",
                consumed_at: "2026-04-12T09:00:00.000Z",
                created_at: "2026-04-10T00:00:00.000Z",
                updated_at: "2026-04-12T12:00:00.000Z",
                text_title: "One Time A",
                text_deleted_at: null,
                owner_status: "active",
              },
              {
                text_id: "text-ot-2",
                owner_id: "user-1",
                owner_username: "alice",
                share_code: "ot-code-2",
                expires_at: "9999-12-31T23:59:59.999Z",
                consumed_at: null,
                created_at: "2026-04-10T00:00:00.000Z",
                updated_at: "2026-04-12T13:00:00.000Z",
                text_title: "One Time B",
                text_deleted_at: null,
                owner_status: "active",
              },
            ],
          },
        },
      ],
    });

  const adminUser = {
    id: "admin-1",
    username: "admin",
    role: "admin",
    status: "active",
    quota_bytes: 1024,
  };

  const { db: dbByUsername } = createAdminSearchDb();
  const byUsernameResponse = await listShares(
    createAuthedRequest("https://example.com/api/shares?q=bob", {
      user: adminUser,
    }),
    { DB: dbByUsername },
  );
  const byUsernameBody = await byUsernameResponse.json();

  assert.equal(byUsernameResponse.status, 200);
  assert.equal(byUsernameBody.total, 3);
  assert.equal(
    byUsernameBody.items.every((item) => item.owner_username === "bob"),
    true,
  );

  const { db: dbByOwnerId } = createAdminSearchDb();
  const byOwnerIdResponse = await listShares(
    createAuthedRequest(
      "https://example.com/api/shares?q=user-2&type=text_one_time&status=consumed",
      { user: adminUser },
    ),
    { DB: dbByOwnerId },
  );
  const byOwnerIdBody = await byOwnerIdResponse.json();

  assert.equal(byOwnerIdResponse.status, 200);
  assert.equal(byOwnerIdBody.total, 1);
  assert.deepEqual(
    byOwnerIdBody.items.map((item) => ({
      owner_id: item.owner_id,
      type: item.type,
      status: item.status,
    })),
    [{ owner_id: "user-2", type: "text_one_time", status: "consumed" }],
  );
});

test("listShares filters by expires range and excludes records without expires_at when range is active", async () => {
  const { listShares } = loadModule("routes/shares.js");
  const { db } = createDb({
    allHandlers: [
      {
        match: /FROM file_shares/i,
        value: {
          results: [
            {
              file_id: "file-1",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "file-code-1",
              password_hash: null,
              expires_at: "2026-04-15T03:00:00.000Z",
              max_views: 0,
              views: 0,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T10:00:00.000Z",
              filename: "alpha.txt",
              file_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
      {
        match: /FROM text_shares/i,
        value: {
          results: [
            {
              text_id: "text-1",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "text-code-1",
              password_hash: null,
              expires_at: "2026-04-20T03:00:00.000Z",
              max_views: 0,
              views: 0,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T11:00:00.000Z",
              text_title: "Doc A",
              text_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
      {
        match: /FROM text_one_time_shares/i,
        value: {
          results: [
            {
              text_id: "text-ot-1",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "ot-code-1",
              expires_at: null,
              consumed_at: null,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T12:00:00.000Z",
              text_title: "One Time A",
              text_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
    ],
  });

  const response = await listShares(
    createAuthedRequest(
      "https://example.com/api/shares?expires_from=2026-04-15T00:00:00.000Z&expires_to=2026-04-16T00:00:00.000Z",
    ),
    { DB: db },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.total, 1);
  assert.deepEqual(
    body.items.map((item) => item.resource_id),
    ["file-1"],
  );
  assert.equal(body.items[0].expires_at, "2026-04-15T03:00:00.000Z");
});

test("listShares supports expires_from-only filtering", async () => {
  const { listShares } = loadModule("routes/shares.js");
  const { db } = createDb({
    allHandlers: [
      {
        match: /FROM file_shares/i,
        value: {
          results: [
            {
              file_id: "file-1",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "file-code-1",
              password_hash: null,
              expires_at: "2026-04-14T23:59:59.999Z",
              max_views: 0,
              views: 0,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T09:00:00.000Z",
              filename: "early.txt",
              file_deleted_at: null,
              owner_status: "active",
            },
            {
              file_id: "file-2",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "file-code-2",
              password_hash: null,
              expires_at: "2026-04-15T00:00:00.000Z",
              max_views: 0,
              views: 0,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T10:00:00.000Z",
              filename: "boundary.txt",
              file_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
      {
        match: /FROM text_shares/i,
        value: {
          results: [
            {
              text_id: "text-1",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "text-code-1",
              password_hash: null,
              expires_at: "2026-04-16T08:00:00.000Z",
              max_views: 0,
              views: 0,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T11:00:00.000Z",
              text_title: "Doc A",
              text_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
      {
        match: /FROM text_one_time_shares/i,
        value: {
          results: [
            {
              text_id: "text-ot-1",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "ot-code-1",
              expires_at: "2026-04-17T08:00:00.000Z",
              consumed_at: null,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T12:00:00.000Z",
              text_title: "One Time A",
              text_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
    ],
  });

  const response = await listShares(
    createAuthedRequest(
      "https://example.com/api/shares?expires_from=2026-04-15T00:00:00.000Z",
    ),
    { DB: db },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.total, 3);
  assert.deepEqual(
    body.items.map((item) => item.resource_id),
    ["text-ot-1", "text-1", "file-2"],
  );
});

test("listShares sorts by expires_at ascending and keeps null expires_at records at the end", async () => {
  const { listShares } = loadModule("routes/shares.js");
  const { db } = createDb({
    allHandlers: [
      {
        match: /FROM file_shares/i,
        value: {
          results: [
            {
              file_id: "file-1",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "file-code-1",
              password_hash: null,
              expires_at: "2026-04-20T08:00:00.000Z",
              max_views: 0,
              views: 0,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T12:00:00.000Z",
              filename: "Late File",
              file_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
      {
        match: /FROM text_shares/i,
        value: {
          results: [
            {
              text_id: "text-1",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "text-code-1",
              password_hash: null,
              expires_at: null,
              max_views: 0,
              views: 0,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T13:00:00.000Z",
              text_title: "No Expire Doc",
              text_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
      {
        match: /FROM text_one_time_shares/i,
        value: {
          results: [
            {
              text_id: "text-ot-1",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "ot-code-1",
              expires_at: "2026-04-15T08:00:00.000Z",
              consumed_at: null,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T11:00:00.000Z",
              text_title: "Soon Expire",
              text_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
    ],
  });

  const response = await listShares(
    createAuthedRequest(
      "https://example.com/api/shares?sort_by=expires_at&sort_order=asc",
    ),
    { DB: db },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.items.map((item) => ({
      resource_id: item.resource_id,
      expires_at: item.expires_at,
    })),
    [
      { resource_id: "text-ot-1", expires_at: "2026-04-15T08:00:00.000Z" },
      { resource_id: "file-1", expires_at: "2026-04-20T08:00:00.000Z" },
      { resource_id: "text-1", expires_at: null },
    ],
  );
});

test("listShares sorts by expires_at descending and still keeps null expires_at records at the end", async () => {
  const { listShares } = loadModule("routes/shares.js");
  const { db } = createDb({
    allHandlers: [
      {
        match: /FROM file_shares/i,
        value: {
          results: [
            {
              file_id: "file-1",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "file-code-1",
              password_hash: null,
              expires_at: "2026-04-18T08:00:00.000Z",
              max_views: 0,
              views: 0,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T13:00:00.000Z",
              filename: "Early File",
              file_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
      {
        match: /FROM text_shares/i,
        value: {
          results: [
            {
              text_id: "text-1",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "text-code-1",
              password_hash: null,
              expires_at: "2026-04-25T08:00:00.000Z",
              max_views: 0,
              views: 0,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T11:00:00.000Z",
              text_title: "Late Doc",
              text_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
      {
        match: /FROM text_one_time_shares/i,
        value: {
          results: [
            {
              text_id: "text-ot-1",
              owner_id: "user-1",
              owner_username: "alice",
              share_code: "ot-code-1",
              expires_at: null,
              consumed_at: null,
              created_at: "2026-04-10T00:00:00.000Z",
              updated_at: "2026-04-12T14:00:00.000Z",
              text_title: "No Expire One Time",
              text_deleted_at: null,
              owner_status: "active",
            },
          ],
        },
      },
    ],
  });

  const response = await listShares(
    createAuthedRequest(
      "https://example.com/api/shares?sort_by=expires_at&sort_order=desc",
    ),
    { DB: db },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.items.map((item) => ({
      resource_id: item.resource_id,
      expires_at: item.expires_at,
    })),
    [
      { resource_id: "text-1", expires_at: "2026-04-25T08:00:00.000Z" },
      { resource_id: "file-1", expires_at: "2026-04-18T08:00:00.000Z" },
      { resource_id: "text-ot-1", expires_at: null },
    ],
  );
});

test("deleteTextOneTimeShare lets admin delete an existing one-time share", async () => {
  const { deleteTextOneTimeShare } = loadModule("routes/textOneTimeShares.js");
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /SELECT id, owner_id, title FROM texts WHERE id = \? AND deleted_at IS NULL LIMIT 1/,
        value: { id: "text-1", owner_id: "user-2", title: "Secret" },
      },
      {
        match: /SELECT id FROM text_one_time_shares WHERE text_id = \? LIMIT 1/,
        value: { id: "share-1" },
      },
    ],
    runHandlers: [
      {
        match: /DELETE FROM text_one_time_shares WHERE id = \?/,
        value: { meta: { changes: 1 } },
      },
    ],
  });

  const request = createAuthedRequest(
    "https://example.com/api/texts/text-1/one-time-share",
    {
      method: "DELETE",
      user: {
        id: "admin-1",
        username: "admin",
        role: "admin",
        status: "active",
        quota_bytes: 1024,
      },
    },
  );

  const response = await deleteTextOneTimeShare(request, { DB: db }, "text-1");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { success: true, deleted: true });
  assert.equal(
    state.runs.some((entry) =>
      /DELETE FROM text_one_time_shares WHERE id = \?/.test(entry.sql),
    ),
    true,
  );
});

test("deleteTextOneTimeShare returns idempotent success when share record is absent", async () => {
  const { deleteTextOneTimeShare } = loadModule("routes/textOneTimeShares.js");
  const { db, state } = createDb({
    firstHandlers: [
      {
        match:
          /SELECT id, owner_id, title FROM texts WHERE id = \? AND deleted_at IS NULL LIMIT 1/,
        value: { id: "text-1", owner_id: "user-1", title: "Secret" },
      },
      {
        match: /SELECT id FROM text_one_time_shares WHERE text_id = \? LIMIT 1/,
        value: null,
      },
    ],
  });

  const response = await deleteTextOneTimeShare(
    createAuthedRequest("https://example.com/api/texts/text-1/one-time-share", {
      method: "DELETE",
    }),
    { DB: db },
    "text-1",
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { success: true, deleted: false });
  assert.equal(
    state.runs.some((entry) =>
      /DELETE FROM text_one_time_shares WHERE id = \?/.test(entry.sql),
    ),
    false,
  );
});
