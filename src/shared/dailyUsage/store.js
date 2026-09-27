'use strict';

// Storage for the day-split usage table.
//
// usage_daily is derived data: it can be rebuilt from transcripts at any time
// and is kept apart from usage_records (the tokscale audit trail), whose grain
// is one cumulative row per session instance.
//
// Rows are keyed by (client, source_key, session_id, model, day). source_key
// is the logical transcript a row came from, or SNAPSHOT_SOURCE for clients
// without parseable transcripts, whose days come from daily cumulative
// snapshots of their tokscale totals.

const SNAPSHOT_SOURCE = 'snapshot';
// Clients whose day split comes from snapshots of their cumulative totals.
const SNAPSHOT_CLIENTS = new Set(['antigravity-cli']);

// Long-context tiers, as tokscale's compute_cost bills them: within one
// request, the part of a bucket above a threshold is charged that tier's rate
// (a progressive walk). The per-request excess over each threshold is summed
// per row, so the walk can be priced at query time from aggregated rows.
// Request-wide tariffs (xAI 200k and OpenAI 272k with a direct provider) are
// not modelled; they only apply to provider-hinted direct rows.
const TIER_BUCKETS = [
  { bucket: 'input', event: 'input', thresholds: [128, 200, 256, 272] },
  { bucket: 'output', event: 'output', thresholds: [128, 200, 256, 272] },
  { bucket: 'cache_read', event: 'cacheRead', thresholds: [200, 272] },
  { bucket: 'cache_write', event: 'cacheWrite', thresholds: [200] }
];
const TIER_EXCESS_COLUMNS = TIER_BUCKETS.flatMap(({ bucket, thresholds }) =>
  thresholds.map((k) => `x_${bucket}_${k}k`));
const PRICING_TIER_COLUMNS = TIER_BUCKETS.flatMap(({ bucket, thresholds }) =>
  thresholds.map((k) => `${bucket}_${k}k`));

function addMissingColumns(db, table, columns, type) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  for (const column of columns) {
    if (!existing.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

// Idempotent: creates the tables and adds columns introduced after v5.
function createDailySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_daily (
      client            TEXT    NOT NULL,
      source_key        TEXT    NOT NULL,
      session_id        TEXT    NOT NULL,
      model             TEXT    NOT NULL DEFAULT '',
      day               TEXT    NOT NULL,
      input_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read        INTEGER NOT NULL DEFAULT 0,
      cache_write       INTEGER NOT NULL DEFAULT 0,
      output_tokens     INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
      total_tokens      INTEGER NOT NULL DEFAULT 0,
      official_cost_usd REAL,
      message_count     INTEGER NOT NULL DEFAULT 0,
      first_at          TEXT,
      last_at           TEXT,
      project_path      TEXT,
      PRIMARY KEY (client, source_key, session_id, model, day)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_day ON usage_daily(day);
    CREATE INDEX IF NOT EXISTS idx_daily_session ON usage_daily(client, session_id);

    CREATE TABLE IF NOT EXISTS daily_sources (
      source_key     TEXT PRIMARY KEY,
      client         TEXT NOT NULL,
      path           TEXT NOT NULL,
      size           INTEGER,
      mtime_ms       REAL,
      parser_version INTEGER NOT NULL,
      event_count    INTEGER NOT NULL DEFAULT 0,
      parsed_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_event_owner (
      client     TEXT NOT NULL,
      event_key  TEXT NOT NULL,
      source_key TEXT NOT NULL,
      PRIMARY KEY (client, event_key)
    );

    CREATE TABLE IF NOT EXISTS daily_snapshots (
      client        TEXT    NOT NULL,
      session_id    TEXT    NOT NULL,
      model         TEXT    NOT NULL DEFAULT '',
      day           TEXT    NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_read    INTEGER NOT NULL DEFAULT 0,
      cache_write   INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens  INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (client, session_id, model, day)
    );

    CREATE TABLE IF NOT EXISTS model_pricing (
      model       TEXT PRIMARY KEY,
      input       REAL,
      output      REAL,
      cache_read  REAL,
      cache_write REAL,
      matched_key TEXT,
      source      TEXT,
      status      TEXT NOT NULL,
      fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Catalog prices as observed day by day: a row is written only when a
    -- model's price differs from its previous observation (see priceHistory.js).
    CREATE TABLE IF NOT EXISTS price_versions (
      model          TEXT    NOT NULL,
      effective_from TEXT    NOT NULL,
      input          REAL,
      output         REAL,
      cache_read     REAL,
      cache_write    REAL,
      matched_key    TEXT,
      source         TEXT,
      observed_on    TEXT    NOT NULL,
      change_pct     REAL,
      status         TEXT    NOT NULL DEFAULT 'active',
      notice         TEXT,
      backfill       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (model, effective_from)
    );
  `);
  addMissingColumns(db, 'usage_daily', TIER_EXCESS_COLUMNS, 'INTEGER NOT NULL DEFAULT 0');
  addMissingColumns(db, 'model_pricing', PRICING_TIER_COLUMNS, 'REAL');
  addMissingColumns(db, 'price_versions', PRICING_TIER_COLUMNS, 'REAL');
}

function localDayKey(ms) {
  const date = new Date(ms);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Folds normalized events into one row per (session, model, local day).
function aggregateDaily(events) {
  const rows = new Map();
  for (const event of events) {
    const day = localDayKey(event.ts);
    const key = `${event.sessionId}\u0000${event.model}\u0000${day}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        session_id: event.sessionId,
        model: event.model || '',
        day,
        input_tokens: 0,
        cache_read: 0,
        cache_write: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
        official_cost_usd: null,
        message_count: 0,
        first_ms: event.ts,
        last_ms: event.ts
      };
      for (const column of TIER_EXCESS_COLUMNS) row[column] = 0;
      rows.set(key, row);
    }
    for (const { bucket, event: field, thresholds } of TIER_BUCKETS) {
      for (const k of thresholds) {
        const excess = event[field] - k * 1000;
        if (excess > 0) row[`x_${bucket}_${k}k`] += excess;
      }
    }
    row.input_tokens += event.input;
    row.cache_read += event.cacheRead;
    row.cache_write += event.cacheWrite;
    row.output_tokens += event.output;
    row.reasoning_tokens += event.reasoning;
    row.total_tokens += event.total;
    if (event.officialCost != null) row.official_cost_usd = (row.official_cost_usd || 0) + event.officialCost;
    row.message_count += 1;
    row.first_ms = Math.min(row.first_ms, event.ts);
    row.last_ms = Math.max(row.last_ms, event.ts);
  }
  return [...rows.values()].map(({ first_ms, last_ms, ...row }) => ({
    ...row,
    first_at: new Date(first_ms).toISOString(),
    last_at: new Date(last_ms).toISOString()
  }));
}

const ROW_VALUE_COLUMNS = [
  'input_tokens', 'cache_read', 'cache_write', 'output_tokens', 'reasoning_tokens', 'total_tokens',
  'official_cost_usd', 'message_count', 'first_at', 'last_at', 'project_path',
  ...TIER_EXCESS_COLUMNS
];

function createDailyStore(db) {
  const statements = {
    deleteSourceRows: db.prepare('DELETE FROM usage_daily WHERE source_key = ?'),
    insertRow: db.prepare(`
      INSERT INTO usage_daily (client, source_key, session_id, model, day, ${ROW_VALUE_COLUMNS.join(', ')})
      VALUES (@client, @source_key, @session_id, @model, @day, ${ROW_VALUE_COLUMNS.map((c) => `@${c}`).join(', ')})
      ON CONFLICT(client, source_key, session_id, model, day) DO UPDATE SET
        ${ROW_VALUE_COLUMNS.map((c) => `${c} = excluded.${c}`).join(',\n        ')}
    `),
    getOwner: db.prepare('SELECT source_key FROM daily_event_owner WHERE client = ? AND event_key = ?'),
    claimOwner: db.prepare('INSERT OR IGNORE INTO daily_event_owner (client, event_key, source_key) VALUES (?, ?, ?)'),
    getSources: db.prepare('SELECT source_key, client, path, size, mtime_ms, parser_version FROM daily_sources'),
    upsertSource: db.prepare(`
      INSERT INTO daily_sources (source_key, client, path, size, mtime_ms, parser_version, event_count, parsed_at)
      VALUES (@source_key, @client, @path, @size, @mtime_ms, @parser_version, @event_count, datetime('now'))
      ON CONFLICT(source_key) DO UPDATE SET
        client = excluded.client,
        path = excluded.path,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        parser_version = excluded.parser_version,
        event_count = excluded.event_count,
        parsed_at = excluded.parsed_at
    `)
  };

  // Keeps an event only when this source owns its key (first claim wins).
  function ownedEvents(client, sourceKey, events) {
    const kept = [];
    for (const event of events) {
      if (!event.key) { kept.push(event); continue; }
      const owner = statements.getOwner.get(client, event.key);
      if (!owner) {
        statements.claimOwner.run(client, event.key, sourceKey);
        kept.push(event);
      } else if (owner.source_key === sourceKey) {
        kept.push(event);
      }
    }
    return kept;
  }

  const replaceSource = db.transaction((source, parsed, parserVersion) => {
    statements.deleteSourceRows.run(source.sourceKey);
    const events = ownedEvents(source.client, source.sourceKey, parsed.events);
    for (const row of aggregateDaily(events)) {
      statements.insertRow.run({
        ...row,
        client: source.client,
        source_key: source.sourceKey,
        project_path: parsed.projectPath || null
      });
    }
    statements.upsertSource.run({
      source_key: source.sourceKey,
      client: source.client,
      path: source.path,
      size: source.size,
      mtime_ms: source.mtimeMs,
      parser_version: parserVersion,
      event_count: events.length
    });
    return events.length;
  });

  const resetDerived = db.transaction(() => {
    db.prepare('DELETE FROM usage_daily WHERE source_key != ?').run(SNAPSHOT_SOURCE);
    db.prepare('DELETE FROM daily_event_owner').run();
    db.prepare('DELETE FROM daily_sources').run();
  });

  return {
    registeredSources() {
      return new Map(statements.getSources.all().map((row) => [row.source_key, row]));
    },
    replaceSource,
    resetDerived
  };
}

// Records today's cumulative totals of a snapshot-split session and derives
// today's usage from the previous snapshot. A session first seen after the
// day it started has no baseline for its earlier usage; that part stays
// unsplit (visible as lifetime total minus the split days).
function recordDailySnapshot(db, record, now = Date.now()) {
  if (!SNAPSHOT_CLIENTS.has(record.client)) return;
  const day = localDayKey(now);
  const model = record.model || '';
  const total = Math.max(0, record.total_tokens || 0);
  const cacheRead = Math.max(0, record.cache_read || 0);
  const cacheWrite = Math.max(0, record.cache_write || 0);
  const output = Math.max(0, record.output_tokens || 0);
  const current = {
    input_tokens: Math.max(0, total - cacheRead - cacheWrite - output),
    cache_read: cacheRead,
    cache_write: cacheWrite,
    output_tokens: output,
    total_tokens: total,
    message_count: Math.max(0, record.message_count || 0)
  };
  db.prepare(`
    INSERT INTO daily_snapshots (client, session_id, model, day, input_tokens, cache_read, cache_write, output_tokens, total_tokens, message_count)
    VALUES (@client, @session_id, @model, @day, @input_tokens, @cache_read, @cache_write, @output_tokens, @total_tokens, @message_count)
    ON CONFLICT(client, session_id, model, day) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      cache_read = excluded.cache_read,
      cache_write = excluded.cache_write,
      output_tokens = excluded.output_tokens,
      total_tokens = excluded.total_tokens,
      message_count = excluded.message_count
  `).run({ client: record.client, session_id: record.session_id, model, day, ...current });

  const previous = db.prepare(`
    SELECT * FROM daily_snapshots
    WHERE client = ? AND session_id = ? AND model = ? AND day < ?
    ORDER BY day DESC LIMIT 1
  `).get(record.client, record.session_id, model, day);
  const startedToday = record.started_at && localDayKey(Date.parse(record.started_at)) === day;
  if (!previous && !startedToday) return;
  const base = previous || { input_tokens: 0, cache_read: 0, cache_write: 0, output_tokens: 0, total_tokens: 0, message_count: 0 };
  const delta = (field) => Math.max(0, current[field] - base[field]);
  db.prepare(`
    INSERT INTO usage_daily (
      client, source_key, session_id, model, day,
      input_tokens, cache_read, cache_write, output_tokens, total_tokens, message_count, last_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client, source_key, session_id, model, day) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      cache_read = excluded.cache_read,
      cache_write = excluded.cache_write,
      output_tokens = excluded.output_tokens,
      total_tokens = excluded.total_tokens,
      message_count = excluded.message_count,
      last_at = excluded.last_at
  `).run(
    record.client, SNAPSHOT_SOURCE, record.session_id, model, day,
    delta('input_tokens'), delta('cache_read'), delta('cache_write'), delta('output_tokens'),
    delta('total_tokens'), delta('message_count'), record.last_used_at || new Date(now).toISOString()
  );
}

module.exports = {
  PRICING_TIER_COLUMNS,
  TIER_BUCKETS,
  TIER_EXCESS_COLUMNS,
  SNAPSHOT_CLIENTS,
  SNAPSHOT_SOURCE,
  aggregateDaily,
  createDailySchema,
  createDailyStore,
  localDayKey,
  recordDailySnapshot
};
