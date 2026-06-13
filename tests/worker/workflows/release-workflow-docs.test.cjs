const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..", "..", "..");

const deployWorkflowPath = path.join(
  repoRoot,
  ".github",
  "workflows",
  "deploy-worker-only.yml",
);
const readmePath = path.join(repoRoot, "README.md");
const runbookPath = path.join(repoRoot, "docs", "release-runbook.md");

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

test("deploy-worker-only workflow stays on the direct full-stack release baseline", () => {
  const workflow = readFile(deployWorkflowPath);

  assert.match(workflow, /^name:\s+Deploy Worker Only$/m);
  assert.match(workflow, /push:\s*\n\s*branches:\s*\["main"\]/m);
  assert.match(workflow, /workflow_dispatch:\s*$/m);

  assert.doesNotMatch(workflow, /Controlled Full-Stack Release/);
  assert.doesNotMatch(workflow, /\bpromote_to_production\b/);
  assert.doesNotMatch(workflow, /^\s*environment:\s+(staging|production)\s*$/m);
  assert.doesNotMatch(
    workflow,
    /\b(smoke-staging|smoke-production|deploy-staging|deploy-production)\b/,
  );
  assert.doesNotMatch(workflow, /\bSMOKE_URL\b/);
  assert.doesNotMatch(workflow, /\bWORKER_NAME\b/);
  assert.doesNotMatch(workflow, /\bD1_DATABASE_NAME\b/);
});

test("deploy-worker-only workflow keeps required full-stack deploy steps", () => {
  const workflow = readFile(deployWorkflowPath);

  assert.match(workflow, /Install worker dependencies/);
  assert.match(workflow, /Install frontend dependencies/);
  assert.match(workflow, /Release verification gate/);
  assert.match(workflow, /npm run verify:release/);
  assert.match(workflow, /wrangler\.full\.toml/);
  assert.match(workflow, /prepare-wrangler-ci-config\.sh/);
  assert.match(workflow, /wrangler\.full\.ci\.toml/);
  assert.match(workflow, /Verify R2_MASTER_KEY secret exists/);
  assert.match(workflow, /Verify AUTH_TOKEN_SECRET secret exists/);
  assert.match(workflow, /reconcile-legacy-d1-columns\.mjs/);
  assert.match(workflow, /d1 migrations apply "DB" --remote/);
  assert.match(workflow, /Deploy Worker \(full-stack\)/);
  assert.match(
    workflow,
    /npx wrangler --config "\$\{WRANGLER_CI_CONFIG\}" deploy/,
  );
});

test("README and release runbook stay aligned with the direct deploy workflow", () => {
  for (const [label, filePath] of [
    ["README", readmePath],
    ["release runbook", runbookPath],
  ]) {
    const content = readFile(filePath);

    assert.match(
      content,
      /Deploy Worker Only/,
      `${label} should mention the direct deploy workflow`,
    );
    assert.match(
      content,
      /workflow_dispatch/,
      `${label} should document the manual rerun trigger`,
    );
    assert.match(
      content,
      /wrangler\.full\.ci\.toml/,
      `${label} should mention the CI config injection path`,
    );
    assert.match(
      content,
      /verify:release/,
      `${label} should mention the release gate`,
    );
    assert.match(
      content,
      /R2_MASTER_KEY/,
      `${label} should mention the required Worker secret`,
    );
    assert.match(
      content,
      /AUTH_TOKEN_SECRET/,
      `${label} should mention the auth token signing secret`,
    );
    assert.match(
      content,
      /format:check/,
      `${label} should mention the format gate`,
    );
    assert.match(
      content,
      /d1 migrations apply/,
      `${label} should mention the migration step`,
    );

    assert.doesNotMatch(
      content,
      /Controlled Full-Stack Release/,
      `${label} should not reference the retired workflow name`,
    );
    assert.doesNotMatch(
      content,
      /\bpromote_to_production\b/,
      `${label} should not mention the retired promotion input`,
    );
    assert.doesNotMatch(
      content,
      /\bSMOKE_URL\b/,
      `${label} should not mention the retired smoke contract`,
    );
    assert.doesNotMatch(
      content,
      /\bWORKER_NAME\b/,
      `${label} should not mention the retired environment variable contract`,
    );
    assert.doesNotMatch(
      content,
      /\bD1_DATABASE_NAME\b/,
      `${label} should not mention the retired environment variable contract`,
    );
    assert.doesNotMatch(
      content,
      /Required reviewers/,
      `${label} should not describe production approval reviewers`,
    );
    assert.doesNotMatch(
      content,
      /不再是 .*硬门禁/,
      `${label} should not describe verify:release as non-blocking`,
    );
    assert.doesNotMatch(
      content,
      /不属于 deploy workflow/,
      `${label} should not describe verify:release as outside deploy`,
    );
  }
});
