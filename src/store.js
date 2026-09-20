
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const applied = new Set(
    database.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version)
  );
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const version = path.basename(file, ".sql");
    if (applied.has(version)) continue;
    database.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
}

function openDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  runMigrations(database);
  return database;
}

module.exports = { openDatabase, runMigrations };
