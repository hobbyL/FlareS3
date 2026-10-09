const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MIN_COMPATIBILITY_DATE = "2026-06-11";
const REPO_ROOT = path.join(process.cwd(), "..");

for (const filename of ["wrangler.toml", "wrangler.full.toml"]) {
  test(`${filename} uses compatibility_flags nodejs_compat instead of deprecated node_compat`, () => {
    const content = fs.readFileSync(path.join(process.cwd(), filename), "utf8");
    const compatibilityDate = content.match(
      /compatibility_date\s*=\s*"([^"]+)"/,
    )?.[1];

    assert.ok(
      compatibilityDate,
      "expected compatibility_date to be configured",
    );
    assert.ok(
      compatibilityDate >= MIN_COMPATIBILITY_DATE,
      `expected compatibility_date >= ${MIN_COMPATIBILITY_DATE}, got ${compatibilityDate}`,
    );
    assert.match(
      content,
      /^\s*compatibility_flags\s*=\s*\[\s*"nodejs_compat"\s*\]/m,
    );
    assert.doesNotMatch(content, /^\s*node_compat\s*=\s*true\s*$/m);
  });

  test(`${filename} configures D1 migrations_dir`, () => {
    const content = fs.readFileSync(path.join(process.cwd(), filename), "utf8");
    assert.match(content, /^\s*migrations_dir\s*=\s*"migrations"\s*$/m);
  });

  test(`${filename} enables smart placement`, () => {
    const content = fs.readFileSync(path.join(process.cwd(), filename), "utf8");
    assert.match(content, /^\s*\[placement\]\s*\n\s*mode\s*=\s*"smart"\s*$/m);
  });

  test(`${filename} enables Worker observability`, () => {
    const content = fs.readFileSync(path.join(process.cwd(), filename), "utf8");
    assert.match(
      content,
      /^\s*\[observability\]\s*\n\s*enabled\s*=\s*true\s*$/m,
    );
  });

  test(`${filename} documents upstream fetch timeout vars with defaults as comments`, () => {
    const content = fs.readFileSync(path.join(process.cwd(), filename), "utf8");
    assert.match(content, /^#\s*UPSTREAM_FETCH_TIMEOUT_MS\s*=\s*"30000"/m);
    assert.match(content, /^#\s*UPSTREAM_FETCH_READONLY_RETRIES\s*=\s*"1"/m);
  });
}

test("wrangler.full.toml configures SPA fallback so client routes survive refresh", () => {
  const content = fs.readFileSync(
    path.join(process.cwd(), "wrangler.full.toml"),
    "utf8",
  );

  const assetsBlock = content.match(
    /^\s*\[assets\]\s*\n((?:[^\[]|\[(?!\s*\n))*?)(?=^\s*\[|\Z)/m,
  )?.[1];

  assert.ok(assetsBlock, "expected [assets] block in wrangler.full.toml");
  assert.match(
    assetsBlock,
    /^\s*not_found_handling\s*=\s*"single-page-application"\s*$/m,
    "SPA fallback not_found_handling is required: without it Workers Assets " +
      "answers HTML navigations like /setup with 307 → / and refresh boots the app at the files page",
  );
});

test("root package deploy and preview scripts target the worker package configs", () => {
  const rootPackageJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );

  assert.equal(
    rootPackageJson.scripts.deploy,
    "npm --prefix worker run deploy:full",
  );
  assert.equal(rootPackageJson.scripts.preview, "npm --prefix worker run dev");
  assert.doesNotMatch(rootPackageJson.scripts.deploy, /^wrangler deploy$/);
  assert.doesNotMatch(rootPackageJson.scripts.preview, /^wrangler dev$/);
});

test("worker package deploy scripts pin explicit Wrangler config files", () => {
  const workerPackageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  );

  assert.equal(
    workerPackageJson.scripts.deploy,
    "wrangler deploy --config wrangler.toml",
  );
  assert.match(
    workerPackageJson.scripts["deploy:dry-run"],
    /wrangler deploy --config wrangler\.toml --dry-run/,
  );
  assert.match(
    workerPackageJson.scripts["deploy:full"],
    /wrangler deploy --config wrangler\.full\.toml/,
  );
  assert.match(
    workerPackageJson.scripts["deploy:full:dry-run"],
    /wrangler deploy --config wrangler\.full\.toml --dry-run/,
  );
  assert.doesNotMatch(
    workerPackageJson.scripts["deploy:dry-run"],
    /wrangler deploy --dry-run$/,
  );
});
