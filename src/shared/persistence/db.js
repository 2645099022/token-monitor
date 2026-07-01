'use strict';

// SQLite-backed persistence for token-monitor usage records.
//
// Why: v0.18's collector only ever reads from local session files via
// tokscale. Delete the session file → its history disappears from the UI.
// This module stores a row-level copy of every usage record token-monitor
// sees, so deleting the source session does not destroy the audit trail.
//
// Design choices:
// - better-sqlite3 (synchronous API) so the writer can be called from the
//   existing sync `for (const row of rows)` loop inside extractUsageFromTokscale
//   without restructuring the rest of usage.js.
// - Default location is `<userDataDir>/usage-history.db` for the Electron app,
//   and `<homedir>/.token-monitor/usage-history.db` for the headless agent.
//   Callers can pass any path (tests use `:memory:`).
// - All writes go through `recordWriter.ingestRows`, which batches inserts
//   in a single transaction. The `db.js` module only owns connection +
//   schema; the writer owns the row-to-INSERT mapping.

const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 1;

function defaultDbPath(app = 'agent') {
  // app: 'electron' | 'agent' | 'hub' — controls where the file lives.
  // Centralizing the rule here keeps tests easy (callers always pass :memory:).
  const home = os.homedir();
  if (app === 'electron') {
    // Electron's main process sets `app.getPath('userData')` and passes it in
    // via `options.dbPath`. We only fall back to ~/.token-monitor when the
    // Electron main has not initialized (e.g. running CLI tools).
    return path.join(home, '.token-monitor', 'usage-history.db');
  }
  return path.join(home, '.token-monitor', 'usage-history.db');
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function openDb(filePath) {
  if (filePath !== ':memory:') ensureDir(filePath);
  const db = new Database(filePath);
  // WAL = better crash safety + concurrent reads while the writer is in a tx.
  if (filePath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  // Single-version schema for now. The version table is here so future
  // migrations have somewhere to read/write from without re-inventing it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const current = db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get();
  if (!current) {
    db.prepare(`INSERT INTO schema_meta (key, value) VALUES (?, ?)`).run('version', String(SCHEMA_VERSION));
  }
  if (!current || Number(current.value) < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_records (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        client          TEXT    NOT NULL,
        session_id      TEXT    NOT NULL,
        model           TEXT,
        provider        TEXT,
        total_tokens    INTEGER NOT NULL DEFAULT 0,
        cache_read      INTEGER NOT NULL DEFAULT 0,
        cache_write     INTEGER NOT NULL DEFAULT 0,
        output_tokens   INTEGER NOT NULL DEFAULT 0,
        cost_usd        REAL    NOT NULL DEFAULT 0,
        message_count   INTEGER,
        started_at      TEXT,
        last_used_at    TEXT,
        ingested_at     TEXT    NOT NULL DEFAULT (datetime('now')),
        scan_count      INTEGER NOT NULL DEFAULT 1,
        source_payload  TEXT
      );
    `);
    // Dedup strategy: ONE ROW PER (client, session_id, model, started_at).
    // When tokscale re-scans the same session, the writer UPSERTs in place:
    // latest cumulative values win, scan_count increments, ingested_at updates.
    // This means deleting the source session file freezes the row at its last
    // seen snapshot — UI shows the final state, DB keeps the audit trail.
    // COALESCE handles NULL started_at so they participate in dedup.
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_dedup
        ON usage_records(client, session_id, model, COALESCE(started_at, ''));
      CREATE INDEX IF NOT EXISTS idx_usage_client_session
        ON usage_records(client, session_id);
      CREATE INDEX IF NOT EXISTS idx_usage_last_used
        ON usage_records(last_used_at);
    `);
  }
}

module.exports = { openDb, defaultDbPath, SCHEMA_VERSION };
