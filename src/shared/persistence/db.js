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

const SCHEMA_VERSION = 8;
const { backfillMissingTimestamps } = require('./backfillTimestamps');
const { repairUsageRecords } = require('./repairRecords');
const { createDailySchema } = require('../dailyUsage/store');
const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..');
const PROJECT_ROOT = SOURCE_ROOT.endsWith(`${path.sep}app.asar`)
  ? `${SOURCE_ROOT}.unpacked`
  : SOURCE_ROOT;

function runtimeNativeBindingPath() {
  const runtime = process.versions.electron ? 'electron' : 'node';
  const abi = process.versions.modules;
  const candidate = path.join(
    PROJECT_ROOT,
    'native',
    'runtime',
    `${process.platform}-${process.arch}`,
    `${runtime}-${abi}`,
    'better_sqlite3.node'
  );
  return fs.existsSync(candidate) ? candidate : null;
}

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
  const nativeBinding = runtimeNativeBindingPath();
  const db = nativeBinding
    ? new Database(filePath, { nativeBinding })
    : new Database(filePath);
  // WAL = better crash safety + concurrent reads while the writer is in a tx.
  if (filePath !== ':memory:') db.pragma('journal_mode = WAL');
  // The day-split import worker writes through its own connection.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function schemaVersion(db) {
  const current = db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get();
  return current ? Number(current.value) : 0;
}

function setSchemaVersion(db, version) {
  db.prepare(`
    INSERT INTO schema_meta (key, value) VALUES ('version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(version));
}

function collapseDuplicateUsageRows(db) {
  // v1 unique key included started_at. Filling that column later would fork
  // a second row for the same session+model. Keep the latest cumulative row.
  const dupes = db.prepare(`
    SELECT client, session_id, IFNULL(model, '') AS model_key
    FROM usage_records
    GROUP BY client, session_id, IFNULL(model, '')
    HAVING COUNT(*) > 1
  `).all();
  const deleteStmt = db.prepare(`
    DELETE FROM usage_records
    WHERE client = ? AND session_id = ? AND IFNULL(model, '') = ? AND id != ?
  `);
  const pickStmt = db.prepare(`
    SELECT id FROM usage_records
    WHERE client = ? AND session_id = ? AND IFNULL(model, '') = ?
    ORDER BY scan_count DESC, id DESC
    LIMIT 1
  `);
  for (const row of dupes) {
    const keep = pickStmt.get(row.client, row.session_id, row.model_key);
    if (keep) deleteStmt.run(row.client, row.session_id, row.model_key, keep.id);
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const current = schemaVersion(db);
  if (current < 1) {
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
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_client_session
        ON usage_records(client, session_id);
      CREATE INDEX IF NOT EXISTS idx_usage_last_used
        ON usage_records(last_used_at);
    `);
  }
  if (current < 2) {
    // Dedup is one row per (client, session_id, model). started_at is
    // metadata, not identity — otherwise backfilling times creates duplicates.
    collapseDuplicateUsageRows(db);
    db.exec(`DROP INDEX IF EXISTS idx_usage_dedup;`);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_dedup
        ON usage_records(client, session_id, IFNULL(model, ''));
      CREATE INDEX IF NOT EXISTS idx_usage_started
        ON usage_records(started_at);
    `);
    try {
      backfillMissingTimestamps(db);
    } catch (error) {
      // Schema change must still commit; timestamps can be filled on the next open.
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(`usage timestamp backfill failed: ${error.message}`);
      }
    }
  }
  if (current < 3) {
    // started_at is the immutable creation time and part of instance identity
    // so a reused Claude UUID after lastSessionId recycle cannot overwrite
    // the deleted conversation's audit row.
    db.exec(`DROP INDEX IF EXISTS idx_usage_dedup;`);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_dedup
        ON usage_records(client, session_id, IFNULL(model, ''), COALESCE(started_at, ''));
    `);
  }
  if (current < 4) {
    // Rows written before v4 have total_tokens = 0 and may split one
    // conversation into overlapping instances; repair both in place.
    repairUsageRecords(db);
  }
  if (current < 8) {
    // Day-split usage derived from transcripts (see dailyUsage/store.js);
    // v6 adds the long-context tier columns, v7 the dated price versions,
    // v8 the 1-hour cache write column.
    // createDailySchema is idempotent.
    createDailySchema(db);
  }
  if (current !== SCHEMA_VERSION) setSchemaVersion(db, SCHEMA_VERSION);
}

module.exports = { openDb, defaultDbPath, runtimeNativeBindingPath, SCHEMA_VERSION, backfillMissingTimestamps };
