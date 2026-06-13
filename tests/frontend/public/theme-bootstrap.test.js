import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const INDEX_HTML_URL = new URL("../../../frontend/index.html", import.meta.url);
const THEME_BOOTSTRAP_URL = new URL(
  "../../../frontend/public/theme-bootstrap.js",
  import.meta.url,
);

test("index.html loads theme bootstrap from an external script without inline bootstrap code", () => {
  const html = fs.readFileSync(INDEX_HTML_URL, "utf8");

  assert.match(html, /<script\s+src="\/theme-bootstrap\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>\s*\(\(\)\s*=>/);
  assert.doesNotMatch(html, /flares3:theme/);
  assert.ok(
    fs.existsSync(THEME_BOOTSTRAP_URL),
    "expected frontend/public/theme-bootstrap.js to exist",
  );
});
