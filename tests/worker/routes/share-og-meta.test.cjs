const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const COMPILED_ROOT =
  process.env.WORKER_TEST_OUTDIR || path.join(process.cwd(), ".test-dist");

function loadSharePage() {
  const target = path.join(COMPILED_ROOT, "routes/sharePage.js");
  delete require.cache[target];
  return require(target);
}

test("buildOgMeta injects og:type/title/description + twitter:card and omits og:url when absent", () => {
  const { buildOgMeta } = loadSharePage();
  const html = buildOgMeta({
    title: "标题",
    description: "描述",
    type: "website",
  });
  assert.match(html, /<meta property="og:type" content="website" \/>/);
  assert.match(html, /<meta property="og:title" content="标题" \/>/);
  assert.match(html, /<meta property="og:description" content="描述" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary" \/>/);
  assert.doesNotMatch(html, /og:url/);
});

test("buildOgMeta returns empty string when og metadata is absent", () => {
  const { buildOgMeta } = loadSharePage();
  assert.equal(buildOgMeta(), "");
  assert.equal(buildOgMeta(undefined), "");
});

test("buildOgMeta escapes untrusted title/description/url into attribute context", () => {
  const { buildOgMeta } = loadSharePage();
  const html = buildOgMeta({
    title: 'a"<b>&',
    description: "<script>alert(1)</script>",
    type: "article",
    url: 'https://h/t/c?"x"=<y>',
  });
  // 属性值必须转义，不得出现裸 < > " 破坏标签/属性
  assert.match(html, /content="a&quot;&lt;b&gt;&amp;"/);
  assert.match(html, /content="&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(
    html,
    /og:url" content="https:\/\/h\/t\/c\?&quot;x&quot;=&lt;y&gt;"/,
  );
});

test("buildOgMeta collapses whitespace and truncates overlong values to ~200 chars", () => {
  const { buildOgMeta } = loadSharePage();
  const collapsed = buildOgMeta({
    title: "  hello\n\tworld  ",
    description: "x",
    type: "website",
  });
  assert.match(collapsed, /content="hello world"/);

  const long = buildOgMeta({
    title: "a".repeat(300),
    description: "y",
    type: "website",
  });
  // 截断为前 199 字符 + 省略号，绝不原样带出 300 字符
  assert.match(long, new RegExp(`content="${"a".repeat(199)}…"`));
  assert.doesNotMatch(long, new RegExp("a".repeat(201)));
});

test("buildOgMeta maps unknown type to website and keeps article when requested", () => {
  const { buildOgMeta } = loadSharePage();
  const article = buildOgMeta({
    title: "t",
    description: "d",
    type: "article",
  });
  assert.match(article, /og:type" content="article"/);
  const fallback = buildOgMeta({ title: "t", description: "d", type: "weird" });
  assert.match(fallback, /og:type" content="website"/);
});

test("resolveShareOgUrl derives origin+pathname from the request, dropping query/hash", () => {
  const { resolveShareOgUrl } = loadSharePage();
  assert.equal(
    resolveShareOgUrl("https://example.com/t/abc?pwd=secret#frag"),
    "https://example.com/t/abc",
  );
  // 不硬编码域名：自定义 host+port 原样取用
  assert.equal(
    resolveShareOgUrl("https://custom.host:8443/f/code"),
    "https://custom.host:8443/f/code",
  );
  assert.equal(resolveShareOgUrl("not a url"), undefined);
});

test("password-protected shares surface the desensitized description, never the secret body", () => {
  const { buildOgMeta, PASSWORD_PROTECTED_SHARE_DESCRIPTION } = loadSharePage();
  assert.equal(PASSWORD_PROTECTED_SHARE_DESCRIPTION, "受口令保护的分享");
  const html = buildOgMeta({
    title: "受保护的分享",
    description: PASSWORD_PROTECTED_SHARE_DESCRIPTION,
    type: "article",
  });
  assert.match(html, /og:description" content="受口令保护的分享"/);
  assert.doesNotMatch(html, /super-secret-plaintext/);
});

test("buildPage splices the og block right after <title> and omits it without og", () => {
  const { buildPage } = loadSharePage();
  const withOg = buildPage({
    title: "标题",
    body: "<p>body</p>",
    og: {
      title: "OT",
      description: "OD",
      type: "article",
      url: "https://h/t/c",
    },
  });
  assert.match(
    withOg,
    /<title>标题<\/title>\n  <meta property="og:type" content="article" \/>/,
  );
  assert.match(withOg, /og:url" content="https:\/\/h\/t\/c"/);

  const withoutOg = buildPage({ title: "标题", body: "<p>body</p>" });
  assert.match(withoutOg, /<title>标题<\/title>/);
  assert.doesNotMatch(withoutOg, /og:type/);
});
