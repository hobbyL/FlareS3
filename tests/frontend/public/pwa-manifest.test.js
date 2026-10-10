import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const INDEX_HTML_URL = new URL("../../../frontend/index.html", import.meta.url);
const MANIFEST_URL = new URL(
  "../../../frontend/public/manifest.webmanifest",
  import.meta.url,
);
const LOGO_URL = new URL("../../../frontend/public/logo.png", import.meta.url);

test("manifest.webmanifest exists and is valid JSON with install essentials", () => {
  assert.ok(
    fs.existsSync(MANIFEST_URL),
    "expected frontend/public/manifest.webmanifest to exist",
  );

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_URL, "utf8"));
  assert.equal(manifest.name, "FlareS3");
  assert.equal(manifest.short_name, "FlareS3");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  // theme-color 取默认主题主色（motherduck 品牌黄）
  assert.equal(manifest.theme_color, "#ffde00");
  assert.match(manifest.background_color, /^#[0-9a-fA-F]{6}$/);

  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  const sizes = new Set(manifest.icons.map((icon) => icon.sizes));
  assert.ok(sizes.has("192x192"), "需声明 192x192 图标用于安装");
  assert.ok(sizes.has("512x512"), "需声明 512x512 图标用于安装");
  for (const icon of manifest.icons) {
    assert.equal(icon.type, "image/png");
    assert.equal(icon.src, "/logo.png");
  }

  assert.ok(fs.existsSync(LOGO_URL), "manifest 复用 /logo.png 必须存在");
});

test("index.html links the manifest and declares theme-color (no Service Worker)", () => {
  const html = fs.readFileSync(INDEX_HTML_URL, "utf8");

  assert.match(
    html,
    /<link\s+rel="manifest"\s+href="\/manifest\.webmanifest">/,
  );
  assert.match(html, /<meta\s+name="theme-color"\s+content="#ffde00">/);
  // 本项不做 Service Worker：确保没有悄悄引入注册代码
  assert.doesNotMatch(html, /serviceWorker/i);
});
