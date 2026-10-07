const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const workerRoot = process.cwd();
const repoRoot = path.join(workerRoot, "..");

function walkFiles(dir, matcher, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, matcher, results);
      continue;
    }
    if (matcher(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

test("D1 schema authority moved to migrations directory", () => {
  assert.ok(
    fs.existsSync(
      path.join(workerRoot, "migrations", "0001_initial_schema.sql"),
    ),
  );
  assert.ok(
    fs.existsSync(
      path.join(workerRoot, "scripts", "reconcile-legacy-d1-columns.mjs"),
    ),
  );
  assert.ok(!fs.existsSync(path.join(workerRoot, "src", "db", "schema.sql")));
  assert.ok(
    !fs.existsSync(path.join(workerRoot, "src", "services", "dbSchema.ts")),
  );
});

test("runtime worker source no longer imports dbSchema helper", () => {
  const sourceFiles = walkFiles(path.join(workerRoot, "src"), (file) =>
    file.endsWith(".ts"),
  );
  for (const file of sourceFiles) {
    const content = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(content, /dbSchema/);
  }
});

test("docs and workflows reference migrations instead of schema.sql execute", () => {
  for (const file of [
    path.join(repoRoot, "README.md"),
    path.join(repoRoot, ".github", "workflows", "deploy.yml"),
    path.join(repoRoot, ".github", "workflows", "deploy-worker-only.yml"),
  ]) {
    const content = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(content, /schema\.sql/);
    assert.match(content, /d1 migrations apply/);
  }
});

test("list query composite indexes are managed by migrations", () => {
  const migration = fs.readFileSync(
    path.join(workerRoot, "migrations", "0005_list_query_indexes.sql"),
    "utf8",
  );

  for (const indexName of [
    "idx_files_owner_status_deleted_created",
    "idx_texts_owner_deleted_updated",
    "idx_users_created_at",
    "idx_audit_actor_action_created",
  ]) {
    assert.match(
      migration,
      new RegExp(`CREATE INDEX IF NOT EXISTS ${indexName}\\b`),
    );
  }
});

test("relationship integrity guards are managed by migrations", () => {
  const migration = fs.readFileSync(
    path.join(
      workerRoot,
      "migrations",
      "0006_relationship_integrity_guards.sql",
    ),
    "utf8",
  );

  for (const triggerName of [
    "trg_sessions_user_exists_insert",
    "trg_files_owner_exists_insert",
    "trg_files_config_exists_insert",
    "trg_texts_owner_exists_insert",
    "trg_file_shares_file_owner_insert",
    "trg_text_shares_text_owner_insert",
    "trg_text_one_time_shares_text_owner_insert",
    "trg_delete_queue_file_exists_insert",
    "trg_upload_reservations_user_config_insert",
    "trg_audit_actor_exists_insert",
  ]) {
    assert.match(
      migration,
      new RegExp(`CREATE TRIGGER IF NOT EXISTS ${triggerName}\\b`),
    );
  }

  assert.match(migration, /SELECT RAISE\(ABORT,/);
  assert.match(migration, /r2_configs/);
  assert.match(migration, /webdav_configs/);
});

test("folder shares and share access logs are managed by migrations", () => {
  const migration = fs.readFileSync(
    path.join(workerRoot, "migrations", "0007_folder_shares.sql"),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS folder_shares \(/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS share_access_logs \(/);

  for (const indexName of [
    "idx_folder_shares_scope",
    "idx_folder_shares_share_code",
    "idx_folder_shares_owner_id",
    "idx_share_access_logs_share",
  ]) {
    assert.match(
      migration,
      new RegExp(`CREATE (UNIQUE )?INDEX IF NOT EXISTS ${indexName}\\b`),
    );
  }

  // scope 唯一：同一 config 的同一 prefix 只允许一条 folder 分享
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_folder_shares_scope ON folder_shares\(config_id, prefix\)/,
  );

  for (const triggerName of [
    "trg_folder_shares_owner_exists_insert",
    "trg_folder_shares_owner_exists_update",
  ]) {
    assert.match(
      migration,
      new RegExp(`CREATE TRIGGER IF NOT EXISTS ${triggerName}\\b`),
    );
  }

  // 访问明细查询索引必须覆盖 (share_type, share_id) 前缀并按 id 倒序
  assert.match(
    migration,
    /CREATE INDEX IF NOT EXISTS idx_share_access_logs_share ON share_access_logs\(share_type, share_id, id DESC\)/,
  );
});
