#!/usr/bin/env node
'use strict';

// Minimal CLI to verify the persistence layer end-to-end.
//
// Usage:
//   node scripts/usage-history.js live   # call real collector + write to DB
//   node scripts/usage-history.js mock   # synthetic rows → DB
//   node scripts/usage-history.js query  # show rows currently in the DB
//   node scripts/usage-history.js reset  # delete the local DB
//
// Defaults to ~/.token-monitor/usage-history.db. Override with TM_USAGE_DB.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { openDb, defaultDbPath } = require('../src/shared/persistence/db');
const { createWriter } = require('../src/shared/persistence/recordWriter');
const { setPersistenceWriter, extractUsageFromTokscale } = require('../src/shared/usage');

function resolveDbPath() {
  const override = process.env.TM_USAGE_DB;
  if (override) return override;
  return path.join(os.homedir(), '.token-monitor', 'usage-history.db');
}

function banner(label) {
  console.log('\n=== ' + label + ' ===');
}

async function runLive(dbPath) {
  banner('live mode');
  // Live mode calls the real collector. We import dynamically so the rest of
  // the script stays usable when tokscale is not installed / no sessions exist.
  let collectUsageOnce;
  try {
    ({ collectUsageOnce } = require('../src/shared/collector'));
  } catch (err) {
    console.error('Could not load collector:', err.message);
    process.exit(2);
  }

  const db = openDb(dbPath);
  const writer = createWriter(db);
  setPersistenceWriter(writer);

  try {
    const summary = await collectUsageOnce({
      clients: 'claude,codex,opencode,cursor,hermes',
      commandTimeoutMs: 60_000
    });
    console.log('collector completed. period tokens:', {
      today: summary.today.totalTokens,
      month: summary.month.totalTokens,
      allTime: summary.allTime.totalTokens
    });
  } catch (err) {
    console.error('collectUsageOnce failed:', err.message);
    console.error('(tokscale may have no sessions to scan, or the binary may not be installed)');
  } finally {
    setPersistenceWriter(null);
  }

  const count = db.prepare('SELECT COUNT(*) AS n FROM usage_records').get().n;
  console.log('rows in DB:', count);
  console.log('DB path:', dbPath);
  writer.close();
}

function runMock(dbPath) {
  banner('mock mode');
  const db = openDb(dbPath);
  const writer = createWriter(db);
  setPersistenceWriter(writer);
  try {
    const fixtures = [
      { client: 'Claude', sessionId: 'mock-1', model: 'claude-opus-4-6', totalTokens: 1234, costUsd: 0.42, startedAt: '2026-07-01T10:00:00Z' },
      { client: 'Codex', sessionId: 'mock-2', model: 'gpt-4o', totalTokens: 800, costUsd: 0.05, startedAt: '2026-07-01T11:00:00Z' },
      { client: 'Cursor', sessionId: 'mock-3', model: 'cursor-auto', totalTokens: 250, costUsd: 0.01, startedAt: '2026-07-01T12:00:00Z' }
    ];
    extractUsageFromTokscale(fixtures);
    console.log('inserted fixtures. row count:', writer.count());
  } finally {
    setPersistenceWriter(null);
    writer.close();
  }
}

function runQuery(dbPath) {
  banner('query mode');
  if (!fs.existsSync(dbPath)) {
    console.error('DB does not exist:', dbPath);
    console.error('Run `node scripts/usage-history.js mock` first.');
    process.exit(1);
  }
  const db = openDb(dbPath);
  const rows = db.prepare(`
    SELECT client, session_id, model, total_tokens, cost_usd, started_at, last_used_at, ingested_at
    FROM usage_records
    ORDER BY ingested_at DESC
    LIMIT 20
  `).all();
  console.log('DB:', dbPath);
  console.log('total rows:', db.prepare('SELECT COUNT(*) AS n FROM usage_records').get().n);
  console.log('last 20:');
  for (const r of rows) {
    console.log(`  [${r.ingested_at}] ${r.client}/${r.session_id}  ${r.model || '-'}  tokens=${r.total_tokens}  cost=$${r.cost_usd}`);
  }
  console.log('\nby client:');
  const byClient = db.prepare(`
    SELECT client, COUNT(*) AS n, SUM(total_tokens) AS tokens, ROUND(SUM(cost_usd), 4) AS cost
    FROM usage_records
    GROUP BY client
    ORDER BY tokens DESC
  `).all();
  for (const r of byClient) {
    console.log(`  ${r.client.padEnd(12)}  rows=${r.n}  tokens=${r.tokens}  cost=$${r.cost}`);
  }
  db.close();
}

function runReset(dbPath) {
  banner('reset mode');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log('deleted:', p);
    }
  }
  if (!fs.existsSync(dbPath)) console.log('DB now absent at:', dbPath);
}

const mode = (process.argv[2] || 'help').toLowerCase();
const dbPath = resolveDbPath();

switch (mode) {
  case 'live':
    runLive(dbPath).catch((err) => { console.error(err); process.exit(1); });
    break;
  case 'mock':
    runMock(dbPath);
    break;
  case 'query':
    runQuery(dbPath);
    break;
  case 'reset':
    runReset(dbPath);
    break;
  default:
    console.log('usage-history.js — verify the persistence layer');
    console.log('  node scripts/usage-history.js live   # run real collector');
    console.log('  node scripts/usage-history.js mock   # insert fixtures');
    console.log('  node scripts/usage-history.js query  # show recent rows + by-client rollup');
    console.log('  node scripts/usage-history.js reset  # delete local DB');
    console.log('default DB path:', defaultDbPath('agent'));
    console.log('override with TM_USAGE_DB=<path>');
    break;
}