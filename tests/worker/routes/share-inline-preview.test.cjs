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

// file / folder 分享视图共用 fileShares.viewFileShare 入口；清缓存后重载以便
// 对 r2 / storage factory / global.fetch 打桩，验证内联预览分流与恰好一次消费。
function loadModules() {
  clearModule("routes/fileShares.js");
  clearModule("routes/folderShareView.js");
  clearModule("routes/fileSharePages.js");
  clearModule("routes/folderSharePages.js");
  clearModule("services/fileShareDownload.js");
  clearModule("services/r2.js");
  clearModule("services/storage/factory.js");

  const r2 = loadModule("services/r2.js");
  const storageFactory = loadModule("services/storage/factory.js");
  const fileShareDownload = loadModule("services/fileShareDownload.js");
  const fileSharePages = loadModule("routes/fileSharePages.js");
  const folderSharePages = loadModule("routes/folderSharePages.js");
  const fileShares = loadModule("routes/fileShares.js");
  return {
    r2,
    storageFactory,
    fileShareDownload,
    fileSharePages,
    folderSharePages,
    fileShares,
  };
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

// folder_shares 解析返回 null → tryHandleFolderShareView 降级回 file 流程
const FOLDER_RESOLVE_MATCH =
  /FROM folder_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/;
const FILE_RESOLVE_MATCH =
  /FROM file_shares s[\s\S]*WHERE s\.share_code = \?[\s\S]*LIMIT 1/;
const FILE_CONSUME_MATCH =
  /UPDATE file_shares[\s\S]*SET views = views \+ 1, updated_at = \?/;
const FOLDER_CONSUME_MATCH =
  /UPDATE folder_shares[\s\S]*SET views = views \+ 1, updated_at = \?/;
const ACCESS_LOG_MATCH = /INSERT INTO share_access_logs/;

function folderMissHandler() {
  return { match: FOLDER_RESOLVE_MATCH, value: null };
}

function fileShareRow(overrides = {}) {
  return {
    share_id: "share-inline-1",
    file_id: "file-inline-1",
    share_code: "inlineshare01",
    password_hash: null,
    share_expires_at: "9999-12-31T23:59:59.999Z",
    max_views: 0,
    views: 0,
    filename: "pic.png",
    r2_key: "flares3/config/pic.png",
    file_expires_at: "9999-12-31T23:59:59.999Z",
    upload_status: "completed",
    deleted_at: null,
    config_id: null,
    content_type: "image/png",
    size: 1024,
    owner_status: "active",
    ...overrides,
  };
}

function fileResolveHandler(overrides) {
  return { match: FILE_RESOLVE_MATCH, value: fileShareRow(overrides) };
}

function viewConsumeHandler(match) {
  return { match, value: { meta: { changes: 1 } } };
}

// 捕获访问日志 result（args[5]）用于断言恰好记一次 ok
function accessLogHandler(sink) {
  return {
    match: ACCESS_LOG_MATCH,
    value: (args) => {
      sink.push(args[5]);
      return { meta: { changes: 1 } };
    },
  };
}

function countRuns(state, match) {
  return state.runs.filter((entry) => match.test(entry.sql)).length;
}

function stubR2(r2) {
  r2.resolveR2ConfigForKey = async () => ({ id: "config-1", config: {} });
  r2.generateDownloadUrl = async () => "https://download.example.com/inline";
}

function getRequest(url) {
  return new Request(url, { method: "GET" });
}

function postRequest(url) {
  return new Request(url, {
    method: "POST",
    headers: { "CF-Connecting-IP": "203.0.113.70" },
  });
}

test("renderFileConfirmPage shows the inline-view action only when previewable", async () => {
  const { fileSharePages } = loadModules();

  const previewable = await fileSharePages
    .renderFileConfirmPage({ title: "pic.png", meta: "", canPreview: true })
    .text();
  assert.match(previewable, /formaction="\?inline=1"/);
  assert.match(previewable, /在线查看/);
  assert.match(previewable, /点击在线查看/);

  const plain = await fileSharePages
    .renderFileConfirmPage({ title: "clip.mp4", meta: "", canPreview: false })
    .text();
  assert.doesNotMatch(plain, /\?inline=1/);
  assert.doesNotMatch(plain, /在线查看/);
});

test("renderFilePasswordForm carries the inline-view action when previewable", async () => {
  const { fileSharePages } = loadModules();
  const html = await fileSharePages
    .renderFilePasswordForm({ title: "pic.png", meta: "", canPreview: true })
    .text();
  assert.match(html, /formaction="\?inline=1"/);
  assert.match(html, /在线查看/);
  assert.match(html, /下载文件/);
});

test("renderFileImagePreviewPage embeds the data URI without a download button", async () => {
  const { fileSharePages } = loadModules();
  const response = fileSharePages.renderFileImagePreviewPage({
    title: "pic.png",
    meta: "已访问 1",
    src: "data:image/png;base64,AAAA",
    filename: '"evil".png',
  });
  const html = await response.text();
  assert.match(
    html,
    /<img class="preview-image" src="data:image\/png;base64,AAAA"/,
  );
  // 文件名在 alt 属性上下文须转义，不得破坏属性
  assert.match(html, /alt="&quot;evil&quot;\.png"/);
  // 内联结果页不得再出现下载按钮/表单（避免二次消费访问次数）
  assert.doesNotMatch(html, /<form/);
  assert.doesNotMatch(html, /下载/);
});

test("renderFileTextPreviewPage escapes content and flags truncation", async () => {
  const { fileSharePages } = loadModules();
  const html = await fileSharePages
    .renderFileTextPreviewPage({
      title: "notes.txt",
      meta: "",
      content: "<script>alert(1)</script>",
      truncated: true,
    })
    .text();
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /仅显示前 256 KB/);
  assert.doesNotMatch(html, /<form/);
});

test("encodeBase64Chunked round-trips large buffers", async () => {
  const { fileShareDownload } = loadModules();
  const bytes = new Uint8Array(0x8000 * 2 + 123);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
  const encoded = fileShareDownload.encodeBase64Chunked(bytes.buffer);
  assert.equal(encoded, Buffer.from(bytes).toString("base64"));
});

test("file share GET offers inline view for a previewable image without consuming", async () => {
  const { fileShares } = loadModules();
  const { db, state } = createDb({
    firstHandlers: [folderMissHandler(), fileResolveHandler()],
  });

  const response = await fileShares.viewFileShare(
    getRequest("https://example.com/f/inlineshare01"),
    { DB: db },
    "inlineshare01",
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /formaction="\?inline=1"/);
  assert.match(html, /在线查看/);
  // GET 只渲染确认页，绝不消费访问次数
  assert.equal(state.runs.length, 0);
});

test("file share GET hides inline view for non-previewable video", async () => {
  const { fileShares } = loadModules();
  const { db } = createDb({
    firstHandlers: [
      folderMissHandler(),
      fileResolveHandler({
        filename: "clip.mp4",
        content_type: "video/mp4",
        r2_key: "flares3/config/clip.mp4",
      }),
    ],
  });

  const response = await fileShares.viewFileShare(
    getRequest("https://example.com/f/inlineshare01"),
    { DB: db },
    "inlineshare01",
  );

  const html = await response.text();
  assert.doesNotMatch(html, /\?inline=1/);
  assert.doesNotMatch(html, /在线查看/);
});

test("file share POST ?inline=1 renders an image inline, consuming exactly one view", async () => {
  const { r2, fileShares } = loadModules();
  stubR2(r2);
  const results = [];
  const { db, state } = createDb({
    firstHandlers: [folderMissHandler(), fileResolveHandler()],
    runHandlers: [
      viewConsumeHandler(FILE_CONSUME_MATCH),
      accessLogHandler(results),
    ],
  });

  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(pngBytes, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(pngBytes.length),
      },
    });

  try {
    const response = await fileShares.viewFileShare(
      postRequest("https://example.com/f/inlineshare01?inline=1"),
      { DB: db },
      "inlineshare01",
    );

    assert.equal(response.status, 200);
    const html = await response.text();
    const expected = `data:image/png;base64,${Buffer.from(pngBytes).toString("base64")}`;
    assert.ok(
      html.includes(`src="${expected}"`),
      "应内嵌 data:image/png base64",
    );
    // 内联页无下载按钮；访问次数恰好消费一次并记一次 ok
    assert.doesNotMatch(html, /<form/);
    assert.equal(countRuns(state, FILE_CONSUME_MATCH), 1);
    assert.deepEqual(results, ["ok"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("file share POST ?inline=1 renders escaped text inline, consuming one view", async () => {
  const { r2, fileShares } = loadModules();
  stubR2(r2);
  const results = [];
  const { db, state } = createDb({
    firstHandlers: [
      folderMissHandler(),
      fileResolveHandler({
        filename: "notes.txt",
        content_type: "text/plain",
        r2_key: "flares3/config/notes.txt",
        size: 42,
      }),
    ],
    runHandlers: [
      viewConsumeHandler(FILE_CONSUME_MATCH),
      accessLogHandler(results),
    ],
  });

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response("<b>hi</b> & bye", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });

  try {
    const response = await fileShares.viewFileShare(
      postRequest("https://example.com/f/inlineshare01?inline=1"),
      { DB: db },
      "inlineshare01",
    );

    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<pre>&lt;b&gt;hi&lt;\/b&gt; &amp; bye<\/pre>/);
    assert.doesNotMatch(html, /<form/);
    assert.equal(countRuns(state, FILE_CONSUME_MATCH), 1);
    assert.deepEqual(results, ["ok"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("file share POST without inline downloads an image as an attachment", async () => {
  const { r2, fileShares } = loadModules();
  stubR2(r2);
  const results = [];
  const { db, state } = createDb({
    firstHandlers: [folderMissHandler(), fileResolveHandler()],
    runHandlers: [
      viewConsumeHandler(FILE_CONSUME_MATCH),
      accessLogHandler(results),
    ],
  });

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response("png-bytes", {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });

  try {
    const response = await fileShares.viewFileShare(
      postRequest("https://example.com/f/inlineshare01"),
      { DB: db },
      "inlineshare01",
    );

    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("Content-Disposition") || "",
      /^attachment; filename="pic\.png"$/,
    );
    assert.equal(await response.text(), "png-bytes");
    assert.equal(countRuns(state, FILE_CONSUME_MATCH), 1);
    assert.deepEqual(results, ["ok"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("file share POST ?inline=1 on a non-previewable video falls back to download", async () => {
  const { r2, fileShares } = loadModules();
  stubR2(r2);
  const results = [];
  const { db, state } = createDb({
    firstHandlers: [
      folderMissHandler(),
      fileResolveHandler({
        filename: "clip.mp4",
        content_type: "video/mp4",
        r2_key: "flares3/config/clip.mp4",
      }),
    ],
    runHandlers: [
      viewConsumeHandler(FILE_CONSUME_MATCH),
      accessLogHandler(results),
    ],
  });

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response("video-bytes", {
      status: 200,
      headers: { "Content-Type": "video/mp4" },
    });

  try {
    const response = await fileShares.viewFileShare(
      postRequest("https://example.com/f/inlineshare01?inline=1"),
      { DB: db },
      "inlineshare01",
    );

    assert.equal(response.status, 200);
    // ?inline=1 对非可预览类型无效：回退既有下载管线（附件），不新开绕过端点
    assert.match(
      response.headers.get("Content-Disposition") || "",
      /^attachment; filename="clip\.mp4"$/,
    );
    assert.equal(await response.text(), "video-bytes");
    assert.equal(countRuns(state, FILE_CONSUME_MATCH), 1);
    assert.deepEqual(results, ["ok"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("file share POST ?inline=1 on an oversize image falls back to download", async () => {
  const { r2, fileShares } = loadModules();
  stubR2(r2);
  const results = [];
  const { db } = createDb({
    firstHandlers: [
      folderMissHandler(),
      fileResolveHandler({ size: 6 * 1024 * 1024 }),
    ],
    runHandlers: [
      viewConsumeHandler(FILE_CONSUME_MATCH),
      accessLogHandler(results),
    ],
  });

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response("png-bytes", {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });

  try {
    const response = await fileShares.viewFileShare(
      postRequest("https://example.com/f/inlineshare01?inline=1"),
      { DB: db },
      "inlineshare01",
    );

    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("Content-Disposition") || "",
      /^attachment; filename="pic\.png"$/,
    );
    assert.deepEqual(results, ["ok"]);
  } finally {
    global.fetch = originalFetch;
  }
});

function folderShareRow(overrides = {}) {
  return {
    id: "folder-inline-1",
    config_id: "r2-main",
    prefix: "docs/",
    share_code: "folderinline1",
    password_hash: null,
    expires_at: null,
    max_views: 0,
    views: 0,
    owner_status: "active",
    ...overrides,
  };
}

function folderResolveHandler(overrides) {
  return { match: FOLDER_RESOLVE_MATCH, value: folderShareRow(overrides) };
}

function folderFormPost(url, fields) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) params.set(name, value);
  const body = params.toString();
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": String(Buffer.byteLength(body)),
      "CF-Connecting-IP": "203.0.113.71",
    },
    body,
  });
}

test("folder share GET offers inline view only for text subfiles", async () => {
  const { storageFactory, fileShares } = loadModules();
  storageFactory.createProvider = async () => ({
    async list() {
      return {
        is_truncated: false,
        key_count: 2,
        common_prefixes: [],
        contents: [
          { key: "docs/notes.txt", size: 10 },
          { key: "docs/photo.png", size: 10 },
        ],
      };
    },
  });
  const { db } = createDb({
    firstHandlers: [folderResolveHandler()],
  });

  const response = await fileShares.viewFileShare(
    getRequest("https://example.com/f/folderinline1"),
    { DB: db },
    "folderinline1",
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  // 文件夹内联仅限文本子文件：notes.txt 有「在线查看」，photo.png 没有
  assert.equal((html.match(/在线查看/g) || []).length, 1);
  assert.match(html, /formaction="[^"]*\?inline=1"/);
});

test("folder share POST ?inline=1 renders a text subfile inline and consumes one view", async () => {
  const { storageFactory, fileShares } = loadModules();
  storageFactory.createProvider = async () => ({
    async download(key, filename) {
      assert.equal(key, "docs/notes.txt");
      assert.equal(filename, "notes.txt");
      return {
        kind: "redirect",
        url: "https://upstream.example.com/notes.txt",
      };
    },
  });
  const results = [];
  const { db, state } = createDb({
    firstHandlers: [folderResolveHandler()],
    runHandlers: [
      viewConsumeHandler(FOLDER_CONSUME_MATCH),
      accessLogHandler(results),
    ],
  });

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response("<i>folder</i> & text", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });

  try {
    const response = await fileShares.viewFileShare(
      folderFormPost("https://example.com/f/folderinline1?inline=1", {
        path: "notes.txt",
      }),
      { DB: db, AUTH_TOKEN_SECRET: "folder-inline-secret" },
      "folderinline1",
    );

    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<pre>&lt;i&gt;folder&lt;\/i&gt; &amp; text<\/pre>/);
    assert.doesNotMatch(html, /<form/);
    assert.equal(countRuns(state, FOLDER_CONSUME_MATCH), 1);
    assert.deepEqual(results, ["ok"]);
  } finally {
    global.fetch = originalFetch;
  }
});
