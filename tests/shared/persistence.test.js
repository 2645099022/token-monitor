'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { openDb, defaultDbPath, runtimeNativeBindingPath, SCHEMA_VERSION, backfillMissingTimestamps } = require('../../src/shared/persistence/db');
const { createWriter, rowToRecord, isSameSessionInstance } = require('../../src/shared/persistence/recordWriter');
const { setPersistenceWriter } = require('../../src/shared/usage');
const usage = require('../../src/shared/usage');
const { extractUsageFromTokscale } = usage;

function tmpDbPath() {
  return path.join(os.tmpdir(), `tm-persist-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

test('openDb selects a native binding for the current Node ABI', () => {
  const binding = runtimeNativeBindingPath();
  assert.match(binding || '', new RegExp(`node-${process.versions.modules.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`));
  assert.ok(fs.existsSync(binding), `native binding should exist at ${binding}`);
});

test('openDb: in-memory schema bootstraps and is queryable', () => {
  const db = openDb(':memory:');
  const version = db.prepare(`SELECT value FROM schema_meta WHERE key='version'`).get();
  assert.equal(Number(version.value), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 4);
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map(r => r.name);
  assert.ok(tables.includes('usage_records'), 'usage_records table should exist');
  assert.ok(tables.includes('schema_meta'), 'schema_meta table should exist');
  db.close();
});

test('openDb: file-backed DB persists across reopen', () => {
  const file = tmpDbPath();
  try {
    const db1 = openDb(file);
    db1.prepare(`INSERT INTO usage_records (client, session_id, total_tokens) VALUES ('claude', 'abc', 100)`).run();
    db1.close();

    const db2 = openDb(file);
    const row = db2.prepare(`SELECT total_tokens FROM usage_records WHERE client='claude' AND session_id='abc'`).get();
    assert.equal(row.total_tokens, 100);
    db2.close();
  } finally {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { fs.unlinkSync(file + suffix); } catch (_) {}
    }
  }
});

test('rowToRecord: extracts all known field shapes', () => {
  const row = {
    client: 'Claude',
    sessionId: 'sess-1',
    model: 'claude-opus-4-6',
    provider: 'anthropic',
    totalTokens: 1234,
    cacheReadTokens: 100,
    cacheWriteTokens: 50,
    outputTokens: 800,
    costUsd: 0.42,
    messageCount: 7,
    startedAt: '2026-07-01T10:00:00Z',
    lastUsedAt: '2026-07-01T10:05:00Z'
  };
  const rec = rowToRecord(row, null, null);
  assert.equal(rec.client, 'claude');
  assert.equal(rec.session_id, 'sess-1');
  assert.equal(rec.model, 'claude-opus-4-6');
  assert.equal(rec.total_tokens, 1234);
  assert.equal(rec.cache_read, 100);
  assert.equal(rec.cache_write, 50);
  assert.equal(rec.output_tokens, 800);
  assert.equal(rec.cost_usd, 0.42);
  assert.equal(rec.message_count, 7);
  assert.equal(rec.started_at, '2026-07-01T10:00:00Z');
});

test('rowToRecord: returns null when neither row nor fallback has client+session', () => {
  assert.equal(rowToRecord({ totalTokens: 1 }, null, null), null);
  assert.equal(rowToRecord({ client: 'claude' }, null, null), null);
  assert.equal(rowToRecord({ sessionId: 'x' }, null, null), null);
});

test('createWriter: ingests rows and counts new vs updated', () => {
  const db = openDb(':memory:');
  const writer = createWriter(db);
  const row = { client: 'codex', sessionId: 's1', model: 'gpt-4', totalTokens: 50 };
  const r1 = writer.ingestRows([row]);
  assert.equal(r1.touched, 1);
  assert.equal(writer.count(), 1);
  // Re-ingesting with a NEW value updates the existing row in place.
  const row2 = { client: 'codex', sessionId: 's1', model: 'gpt-4', totalTokens: 99, costUsd: 0.5 };
  const r2 = writer.ingestRows([row2]);
  assert.equal(r2.touched, 1);
  assert.equal(writer.count(), 1, 'should still be 1 row after re-scan');
  // Verify the row was updated, not just ignored.
  const stored = db.prepare(`SELECT total_tokens, cost_usd FROM usage_records WHERE session_id = 's1'`).get();
  assert.equal(stored.total_tokens, 99, 'token total must reflect the latest scan');
  assert.equal(stored.cost_usd, 0.5, 'cost must reflect the latest scan');
  writer.close();
});

test('createWriter: skips rows without client+sessionId, counts them as skipped', () => {
  const db = openDb(':memory:');
  const writer = createWriter(db);
  const r = writer.ingestRows([
    { totalTokens: 10 },
    { client: 'claude' },
    { sessionId: 'x' },
    { client: 'claude', sessionId: 's1', totalTokens: 5 }
  ]);
  assert.equal(r.touched, 1);
  assert.equal(r.skipped, 3);
  assert.equal(writer.count(), 1);
  writer.close();
});

test('integration: extractUsageFromTokscale persists rows when writer is set', () => {
  const db = openDb(':memory:');
  const writer = createWriter(db);
  setPersistenceWriter(writer);
  try {
    // Shape mirrors what tokscale emits: flat row objects with client + sessionId + model + totalTokens
    // (matches the existing tests/shared/usage.test.js fixtures).
    const tokscaleJson = [
      {
        client: 'Claude',
        sessionId: 'sess-a',
        model: 'claude-opus-4-6',
        totalTokens: 1000,
        costUsd: 0.3,
        startedAt: '2026-07-01T09:00:00Z',
        lastUsedAt: '2026-07-01T09:30:00Z'
      }
    ];
    const period = usage.extractUsageFromTokscale(tokscaleJson);
    // The original aggregation result is unchanged.
    assert.equal(period.totalTokens, 1000);
    assert.equal(period.clients.claude, 1000);
    // The DB also got the row.
    const stored = db.prepare(`SELECT * FROM usage_records WHERE session_id = 'sess-a'`).all();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].total_tokens, 1000);
    assert.equal(stored[0].client, 'claude');
    assert.equal(stored[0].started_at, '2026-07-01T09:00:00Z');
  } finally {
    setPersistenceWriter(null);
    writer.close();
  }
});

test('integration: original code path is unchanged when no writer is set', () => {
  setPersistenceWriter(null);
  const tokscaleJson = [
    { client: 'Codex', sessionId: 'sess-b', model: 'gpt-4', totalTokens: 500 }
  ];
  const period = usage.extractUsageFromTokscale(tokscaleJson);
  assert.equal(period.totalTokens, 500);
  assert.equal(period.clients.codex, 500);
});

test('integration: deleting the source session does not destroy the audit trail', () => {
  // This is the whole point: persist, then "forget" the source, query the DB.
  const db = openDb(':memory:');
  const writer = createWriter(db);
  setPersistenceWriter(writer);
  try {
    const tokscaleJson = [
      {
        client: 'Claude',
        sessionId: 'sess-c',
        model: 'claude-opus-4-6',
        totalTokens: 2000,
        costUsd: 0.6,
        startedAt: '2026-07-01T08:00:00Z'
      }
    ];
    usage.extractUsageFromTokscale(tokscaleJson);
    // Pretend the user deleted the session file. The collector no longer
    // returns anything for it, but the DB still has the row.
    const empty = usage.extractUsageFromTokscale([]);
    assert.equal(empty.totalTokens, 0);
    const rows = db.prepare(`SELECT * FROM usage_records WHERE session_id = 'sess-c'`).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total_tokens, 2000);
    assert.equal(rows[0].cost_usd, 0.6);
  } finally {
    setPersistenceWriter(null);
    writer.close();
  }
});

test('defaultDbPath: returns a path under the user home directory', () => {
  const p = defaultDbPath('agent');
  assert.ok(p.includes('.token-monitor'), 'should live under .token-monitor');
  assert.ok(p.endsWith('usage-history.db'), 'should be named usage-history.db');
});

test('lifecycle: delete session → restore → continue writing → re-sync preserves latest tokens', () => {
  // The bug this guards against: with INSERT-OR-IGNORE, a session that was
  // deleted, restored with the same startedAt, and then had more tokens
  // written to it would have its newer total IGNORED — DB stuck at the old
  // value while UI shows the new one. UPSERT fixes this.
  const db = openDb(':memory:');
  const writer = createWriter(db);
  setPersistenceWriter(writer);
  const SESSION = 'c922c570-20a8-4931-89ab-22b8c0396bbc';
  const baseRow = (overrides) => ({
    client: 'Claude',
    sessionId: SESSION,
    model: 'claude-opus-4-6',
    startedAt: '2026-07-01T08:00:00Z',
    totalTokens: 1000,
    costUsd: 0.10,
    messageCount: 5,
    lastUsedAt: '2026-07-01T08:30:00Z',
    ...overrides
  });
  try {
    // Phase 1: original session.
    extractUsageFromTokscale([baseRow()]);
    let row = db.prepare(`SELECT total_tokens, message_count, scan_count FROM usage_records WHERE session_id = ?`).get(SESSION);
    assert.equal(row.total_tokens, 1000);
    assert.equal(row.message_count, 5);
    assert.equal(row.scan_count, 1);

    // Phase 2: user deletes source session. Empty scan — DB still has phase-1 row.
    const empty = extractUsageFromTokscale([]);
    assert.equal(empty.totalTokens, 0, 'UI is empty while session is deleted');
    row = db.prepare(`SELECT total_tokens FROM usage_records WHERE session_id = ?`).get(SESSION);
    assert.equal(row.total_tokens, 1000, 'DB keeps phase-1 record');

    // Phase 3: user restores session (file is back, same startedAt). Scan again.
    extractUsageFromTokscale([baseRow()]);
    row = db.prepare(`SELECT total_tokens, scan_count FROM usage_records WHERE session_id = ?`).get(SESSION);
    assert.equal(row.total_tokens, 1000);
    assert.equal(row.scan_count, 2, 'scan_count incremented');
    assert.equal(writer.count(), 1, 'still exactly one row for this session');

    // Phase 4: user keeps writing in the restored session. New tokens, new messages.
    extractUsageFromTokscale([baseRow({ totalTokens: 1500, costUsd: 0.15, messageCount: 8, lastUsedAt: '2026-07-01T09:00:00Z' })]);
    row = db.prepare(`SELECT total_tokens, message_count, scan_count, last_used_at FROM usage_records WHERE session_id = ?`).get(SESSION);
    assert.equal(row.total_tokens, 1500, 'latest token total persisted (was the bug)');
    assert.equal(row.message_count, 8);
    assert.equal(row.last_used_at, '2026-07-01T09:00:00Z');
    assert.equal(row.scan_count, 3);

    // Phase 5: user keeps writing again. The cumulative total grows.
    extractUsageFromTokscale([baseRow({ totalTokens: 2200, costUsd: 0.22, messageCount: 12, lastUsedAt: '2026-07-01T09:30:00Z' })]);
    row = db.prepare(`SELECT total_tokens, scan_count FROM usage_records WHERE session_id = ?`).get(SESSION);
    assert.equal(row.total_tokens, 2200);
    assert.equal(row.scan_count, 4);
    assert.equal(writer.count(), 1, 'always exactly one row, never duplicated');
  } finally {
    setPersistenceWriter(null);
    writer.close();
  }
});

test('lifecycle: two different sessions in the same batch stay separate', () => {
  const db = openDb(':memory:');
  const writer = createWriter(db);
  setPersistenceWriter(writer);
  try {
    extractUsageFromTokscale([
      { client: 'Claude', sessionId: 'sess-A', model: 'claude-opus-4-6', totalTokens: 100, startedAt: '2026-07-01T08:00:00Z' },
      { client: 'Codex',  sessionId: 'sess-B', model: 'gpt-4o',          totalTokens: 200, startedAt: '2026-07-01T08:00:00Z' }
    ]);
    assert.equal(writer.count(), 2);
    // Rescan A; B should be untouched.
    extractUsageFromTokscale([
      { client: 'Claude', sessionId: 'sess-A', model: 'claude-opus-4-6', totalTokens: 150, startedAt: '2026-07-01T08:00:00Z' }
    ]);
    const a = db.prepare(`SELECT total_tokens FROM usage_records WHERE session_id = 'sess-A'`).get();
    const b = db.prepare(`SELECT total_tokens FROM usage_records WHERE session_id = 'sess-B'`).get();
    assert.equal(a.total_tokens, 150);
    assert.equal(b.total_tokens, 200, 'B unchanged when A is rescanned');
  } finally {
    setPersistenceWriter(null);
    writer.close();
  }
});

test('createWriter: a reused session id with a new creation time inserts a second row', () => {
  const db = openDb(':memory:');
  const writer = createWriter(db, { resolveTimestampsMap: () => new Map() });
  writer.ingestRows([
    {
      client: 'claude',
      sessionId: 's-reuse',
      model: 'opus',
      totalTokens: 1000,
      startedAt: '2026-08-01T00:00:00.000Z',
      lastUsedAt: '2026-08-01T03:00:00.000Z'
    }
  ]);
  writer.ingestRows([
    {
      client: 'claude',
      sessionId: 's-reuse',
      model: 'opus',
      totalTokens: 20,
      startedAt: '2026-08-14T10:00:00.000Z',
      lastUsedAt: '2026-08-14T10:05:00.000Z'
    }
  ]);
  const rows = db.prepare(`SELECT total_tokens, started_at FROM usage_records WHERE session_id = 's-reuse' ORDER BY started_at`).all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].total_tokens, 1000);
  assert.equal(rows[0].started_at, '2026-08-01T00:00:00.000Z');
  assert.equal(rows[1].total_tokens, 20);
  assert.equal(rows[1].started_at, '2026-08-14T10:00:00.000Z');
  writer.close();
});

test('createWriter: tiny started_at jitter on the same creation stays one row', () => {
  const db = openDb(':memory:');
  const writer = createWriter(db, { resolveTimestampsMap: () => new Map() });
  writer.ingestRows([
    { client: 'claude', sessionId: 's-jitter', model: 'opus', totalTokens: 10, startedAt: '2026-08-01T00:00:00.000Z', lastUsedAt: '2026-08-01T00:10:00.000Z' }
  ]);
  writer.ingestRows([
    { client: 'claude', sessionId: 's-jitter', model: 'opus', totalTokens: 20, startedAt: '2026-08-01T00:00:30.000Z', lastUsedAt: '2026-08-01T00:20:00.000Z' }
  ]);
  const rows = db.prepare(`SELECT total_tokens, started_at FROM usage_records WHERE session_id = 's-jitter'`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total_tokens, 20);
  assert.equal(rows[0].started_at, '2026-08-01T00:00:00.000Z', 'original creation time is kept');
  writer.close();
});

test('createWriter: a later scan without timestamps keeps the stored times', () => {
  const db = openDb(':memory:');
  const writer = createWriter(db, { resolveTimestampsMap: () => new Map() });
  writer.ingestRows([
    { client: 'claude', sessionId: 's-keep', model: 'opus', totalTokens: 10, startedAt: '2026-08-01T00:00:00.000Z', lastUsedAt: '2026-08-01T01:00:00.000Z' }
  ]);
  writer.ingestRows([
    { client: 'claude', sessionId: 's-keep', model: 'opus', totalTokens: 11 }
  ]);
  const row = db.prepare(`SELECT total_tokens, started_at, last_used_at FROM usage_records WHERE session_id = 's-keep'`).get();
  assert.equal(row.total_tokens, 11);
  assert.equal(row.started_at, '2026-08-01T00:00:00.000Z');
  assert.equal(row.last_used_at, '2026-08-01T01:00:00.000Z');
  writer.close();
});

test('backfillMissingTimestamps fills from a local transcript and ignores ingest time', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-backfill-'));
  const db = openDb(':memory:');
  try {
    const dir = path.join(home, '.claude', 'projects', '-app');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'sess-backfill.jsonl'),
      `${JSON.stringify({ timestamp: '2026-08-09T01:00:00.000Z' })}\n${JSON.stringify({ timestamp: '2026-08-09T02:00:00.000Z' })}\n`
    );
    db.prepare(`
      INSERT INTO usage_records (client, session_id, model, total_tokens, ingested_at)
      VALUES ('claude', 'sess-backfill', 'claude-opus-5', 1, '2026-08-14 10:00:00')
    `).run();
    const result = backfillMissingTimestamps(db, { homeDir: home, archives: new Map() });
    assert.ok(result.updated >= 1);
    const row = db.prepare(`SELECT started_at, last_used_at FROM usage_records WHERE session_id = 'sess-backfill'`).get();
    assert.equal(row.started_at, '2026-08-09T01:00:00.000Z');
    assert.equal(row.last_used_at, '2026-08-09T02:00:00.000Z');
    assert.notEqual(row.started_at.startsWith('2026-08-14'), true);
  } finally {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isSameSessionInstance: a start inside the stored lifetime is the same instance', () => {
  const existing = { started_at: '2026-08-01T00:00:00.000Z', last_used_at: '2026-08-01T03:00:00.000Z' };
  assert.equal(isSameSessionInstance(existing, { started_at: '2026-08-01T00:00:20.000Z' }), true);
  // First usage message several minutes after the first transcript line.
  assert.equal(isSameSessionInstance(existing, { started_at: '2026-08-01T00:07:00.000Z' }), true);
  assert.equal(isSameSessionInstance(existing, { started_at: '2026-08-01T04:00:00.000Z' }), false);
  assert.equal(isSameSessionInstance(existing, { started_at: null }), true);
  assert.equal(isSameSessionInstance({ started_at: null }, { started_at: '2026-08-01T00:00:00.000Z' }), true);
});

test('rowToRecord: derives total_tokens from tokscale components', () => {
  const claude = rowToRecord({
    client: 'claude', sessionId: 'c1', model: 'claude-opus-5',
    input: 732, output: 237701, cacheRead: 79600038, cacheWrite: 549752, reasoning: 0
  }, null, null);
  assert.equal(claude.total_tokens, 732 + 237701 + 79600038 + 549752);
  // Codex reports reasoning separately from output; it is part of the total.
  const codex = rowToRecord({
    client: 'codex', sessionId: 'x1', model: 'gpt-5',
    input: 96655, output: 4312, cacheRead: 502016, cacheWrite: 0, reasoning: 3386
  }, null, null);
  assert.equal(codex.total_tokens, 606369);
});

test('createWriter: a shifted start for the same conversation does not fork a row', () => {
  const db = openDb(':memory:');
  const writer = createWriter(db);
  const base = { client: 'claude', sessionId: 'shift-1', model: 'claude-opus-5', input: 1, output: 10 };
  writer.ingestRows([{ ...base, startedAt: '2026-09-21T02:44:14.678Z', lastUsedAt: '2026-09-21T08:45:24.875Z' }]);
  writer.ingestRows([{ ...base, output: 20, startedAt: '2026-09-21T02:46:22.279Z', lastUsedAt: '2026-09-21T08:46:00.000Z' }]);
  const rows = db.prepare(`SELECT total_tokens, started_at FROM usage_records WHERE session_id = 'shift-1'`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total_tokens, 21);
  assert.equal(rows[0].started_at, '2026-09-21T02:44:14.678Z');
  writer.close();
});

test('v4 repair merges overlapping instances and recomputes zero totals', () => {
  const file = tmpDbPath();
  try {
    const db = openDb(file);
    db.prepare(`DELETE FROM schema_meta`).run();
    db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('version', '3')`).run();
    const insert = db.prepare(`
      INSERT INTO usage_records (client, session_id, model, total_tokens, started_at, last_used_at, ingested_at, scan_count, source_payload)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
    `);
    const payload = JSON.stringify({ client: 'claude', sessionId: 'dup', model: 'm', input: 5, output: 7, cacheRead: 100, cacheWrite: 3 });
    insert.run('claude', 'dup', 'm', '2026-09-21T02:44:14.678Z', '2026-09-21T08:45:24.875Z', '2026-09-21 09:00:00', 69, payload);
    insert.run('claude', 'dup', 'm', '2026-09-21T02:46:22.279Z', '2026-09-21T08:45:05.658Z', '2026-09-26 10:00:00', 2, payload);
    // A genuinely reused id: starts after the first instance ended.
    insert.run('claude', 'dup', 'm', '2026-09-22T10:00:00.000Z', '2026-09-22T11:00:00.000Z', '2026-09-22 12:00:00', 4, payload);
    db.close();

    const reopened = openDb(file);
    const rows = reopened.prepare(`
      SELECT started_at, last_used_at, total_tokens, scan_count FROM usage_records WHERE session_id = 'dup' ORDER BY started_at
    `).all();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      started_at: '2026-09-21T02:44:14.678Z',
      last_used_at: '2026-09-21T08:45:24.875Z',
      total_tokens: 115,
      scan_count: 71
    });
    assert.equal(rows[1].started_at, '2026-09-22T10:00:00.000Z');
    assert.equal(rows[1].total_tokens, 115);
    reopened.close();
  } finally {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { fs.unlinkSync(file + suffix); } catch (_) {}
    }
  }
});
