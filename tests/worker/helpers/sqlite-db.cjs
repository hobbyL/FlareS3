const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function createSqliteDb({ throughMigration = "9999" } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDir = path.join(__dirname, "../../../worker/migrations");
  for (const name of fs
    .readdirSync(migrationDir)
    .filter(
      (name) => name.endsWith(".sql") && name.slice(0, 4) <= throughMigration,
    )
    .sort()) {
    sqlite.exec(fs.readFileSync(path.join(migrationDir, name), "utf8"));
  }
  function statement(sql, args = []) {
    return {
      bind(...values) {
        return statement(sql, values);
      },
      async first(column) {
        const row = sqlite.prepare(sql).get(...args);
        return row ? (column ? row[column] : row) : null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...args), success: true };
      },
      async run() {
        const result = sqlite.prepare(sql).run(...args);
        return {
          success: true,
          meta: { changes: Number(result.changes) },
          results: [],
        };
      },
    };
  }
  const db = {
    prepare: statement,
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const stmt of statements) results.push(await stmt.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, sqlite };
}

module.exports = { createSqliteDb };
