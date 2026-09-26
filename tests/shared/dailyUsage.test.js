'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb } = require('../../src/shared/persistence/db');
const { createWriter } = require('../../src/shared/persistence/recordWriter');
const { parseClaudeFile, parseCodexFile, parseGrokSession, parseAntigravityFile } = require('../../src/shared/dailyUsage/parsers');
const { discoverSources } = require('../../src/shared/dailyUsage/sources');
const { importDailyUsage } = require('../../src/shared/dailyUsage/importer');
const { localDayKey, recordDailySnapshot } = require('../../src/shared/dailyUsage/store');
const { costOf, parsePricingOutput, refreshPricing, priceTable } = require('../../src/shared/dailyUsage/pricing');
const { sessionUsageInRange, dailyTotals } = require('../../src/shared/dailyUsage/query');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-daily-'));
}

function writeLines(filePath, objects) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${objects.map((o) => JSON.stringify(o)).join('\n')}\n`);
}

// Local-time instants on two consecutive days, independent of the test TZ.
const DAY1 = new Date(2026, 8, 20, 23, 50).getTime();
const DAY2 = new Date(2026, 8, 21, 0, 10).getTime();

function claudeLine(id, ts, usage, extra = {}) {
  return {
    type: 'assistant',
    sessionId: 'sess-a',
    cwd: 'E:\\work',
    timestamp: new Date(ts).toISOString(),
    requestId: `req-${id}`,
    message: { id: `msg-${id}`, model: 'claude-opus-5', usage },
    ...extra
  };
}

test('claude: keeps the final usage of a streamed message and splits by local day', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'sess-a.jsonl');
    writeLines(file, [
      claudeLine(1, DAY1, { input_tokens: 10, output_tokens: 0 }),
      claudeLine(1, DAY1, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
      claudeLine(2, DAY2, { input_tokens: 1, output_tokens: 2 })
    ]);
    const { events, projectPath } = await parseClaudeFile(file);
    assert.equal(projectPath, 'E:\\work');
    assert.equal(events.length, 2);
    const first = events.find((e) => e.key === 'msg-1:req-1');
    assert.deepEqual(
      [first.input, first.cacheRead, first.cacheWrite, first.output, first.total],
      [10, 100, 20, 5, 135]
    );
    assert.notEqual(localDayKey(events[0].ts), localDayKey(events[1].ts));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function codexTokenCount(ts, total, last) {
  return {
    timestamp: new Date(ts).toISOString(),
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } }
  };
}

function usageObj(input, cached, output, reasoning) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output
  };
}

test('codex: normalizes cached input, skips unchanged totals, and keys replayable events', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'rollout-2026-09-20T23-00-00-aaa.jsonl');
    const t1 = usageObj(1000, 600, 50, 20);
    writeLines(file, [
      { type: 'session_meta', payload: { cwd: '/repo' } },
      { type: 'turn_context', payload: { model: 'gpt-5.5' } },
      codexTokenCount(DAY1, t1, t1),
      codexTokenCount(DAY1, t1, t1),
      codexTokenCount(DAY2, usageObj(1500, 900, 80, 30), usageObj(500, 300, 30, 10))
    ]);
    const { events, projectPath } = await parseCodexFile(file);
    assert.equal(projectPath, '/repo');
    assert.equal(events.length, 2, 'a token_count that does not move the total is not usage');
    const [e1] = events;
    assert.equal(e1.sessionId, 'rollout-2026-09-20T23-00-00-aaa');
    assert.equal(e1.model, 'gpt-5.5');
    assert.deepEqual([e1.input, e1.cacheRead, e1.output, e1.reasoning, e1.total], [400, 600, 50, 20, 1050]);
    assert.match(e1.key, /^[0-9a-f]{40}$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function grokTurn(endedAt, model, input, cached, output, ticks) {
  const usage = { inputTokens: input, cachedReadTokens: cached, cacheCreationTokens: 0, outputTokens: output, reasoningTokens: 3, totalTokens: input + output, costUsdTicks: ticks };
  return { endedAt: new Date(endedAt).toISOString(), ...usage, modelUsage: { [model]: usage } };
}

function grokUpdate(sessionId, eventId, ts, turn) {
  return {
    timestamp: Math.floor(ts / 1000),
    params: { sessionId, update: { sessionUpdate: 'turn_completed', usage: turn }, _meta: { eventId } }
  };
}

test('grok: every turn comes from updates.jsonl, even when the ledger starts later', async () => {
  const dir = tmpDir();
  try {
    const sessionDir = path.join(dir, encodeURIComponent('E:\\spman\\grok'), '01a0-sess');
    fs.mkdirSync(sessionDir, { recursive: true });
    // The ledger only covers turns after the release that introduced it.
    fs.writeFileSync(path.join(sessionDir, 'usage.json'), JSON.stringify({
      sessionId: '01a0-sess',
      turns: [grokTurn(DAY2, 'grok-4.6-build', 500, 400, 5, 1e10)]
    }));
    writeLines(path.join(sessionDir, 'updates.jsonl'), [
      grokUpdate('01a0-sess', 'e1', DAY1, grokTurn(DAY1, 'grok-4.6-build', 1000, 800, 10, 2e10)),
      grokUpdate('01a0-sess', 'e2', DAY2, grokTurn(DAY2, 'grok-4.6-build', 500, 400, 5, 1e10))
    ]);
    const { events, projectPath } = await parseGrokSession(sessionDir);
    assert.equal(projectPath, 'E:\\spman\\grok');
    assert.equal(events.length, 2);
    assert.deepEqual([events[0].input, events[0].cacheRead, events[0].output, events[0].total], [200, 800, 10, 1010]);
    // xAI reports cost in ticks of 1e-10 USD.
    assert.equal(events[0].officialCost, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('grok: a reused eventId is a new turn; only an exact repeat is dropped', async () => {
  const dir = tmpDir();
  try {
    const sessionDir = path.join(dir, 'proj', 'sess-u');
    const turn = (ts) => grokTurn(ts, 'grok-4.5', 100, 0, 1, 1e9);
    writeLines(path.join(sessionDir, 'updates.jsonl'), [
      grokUpdate('sess-u', 'a', DAY1, turn(DAY1)),
      grokUpdate('sess-u', 'a', DAY1, turn(DAY1)),
      grokUpdate('sess-u', 'a', DAY2, turn(DAY2))
    ]);
    const { events } = await parseGrokSession(sessionDir);
    assert.equal(events.length, 2);
    assert.equal(events[0].officialCost, 0.1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('grok: the usage.json ledger is read when updates.jsonl is gone', async () => {
  const dir = tmpDir();
  try {
    const sessionDir = path.join(dir, 'proj', 'sess-l');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'usage.json'), JSON.stringify({
      sessionId: 'sess-l',
      turns: [grokTurn(DAY1, 'grok-4.5', 100, 0, 1, 1e9), grokTurn(DAY2, 'grok-4.5', 100, 0, 1, 1e9)]
    }));
    const { events } = await parseGrokSession(sessionDir);
    assert.equal(events.length, 2);
    assert.equal(events[1].sessionId, 'sess-l');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('antigravity: dedupes responses and keeps reasoning inside output', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'ag.jsonl');
    const usage = (responseId, ts) => ({ type: 'usage', sessionId: 'ag-1', modelId: 'gemini-3.7', responseId, timestamp: ts, input: 100, output: 20, reasoning: 15, cacheRead: 50, cacheWrite: 0 });
    writeLines(file, [{ type: 'session_meta', sessionId: 'ag-1' }, usage('r1', DAY1), usage('r1', DAY1), usage('r2', DAY2)]);
    const { events } = await parseAntigravityFile(file);
    assert.equal(events.length, 2);
    assert.equal(events[0].total, 170);
    assert.equal(events[0].reasoning, 15);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sources: the larger copy of a transcript wins across live and archive roots', () => {
  const live = tmpDir();
  const archive = tmpDir();
  try {
    writeLines(path.join(live, 'proj', 'sess-a.jsonl'), [{ a: 1 }]);
    writeLines(path.join(archive, 'proj', 'sess-a.jsonl'), [{ a: 1 }, { b: 2 }]);
    writeLines(path.join(archive, 'proj', 'sess-gone.jsonl'), [{ a: 1 }]);
    const sources = discoverSources({ claude: [{ label: 'projects', path: live }, { label: 'projects', path: archive }] });
    assert.equal(sources.size, 2);
    assert.equal(sources.get('claude:projects/proj/sess-a.jsonl').path, path.join(archive, 'proj', 'sess-a.jsonl'));
    assert.ok(sources.has('claude:projects/proj/sess-gone.jsonl'), 'archived-only transcripts are still imported');
  } finally {
    fs.rmSync(live, { recursive: true, force: true });
    fs.rmSync(archive, { recursive: true, force: true });
  }
});

test('importer: splits by day, counts replayed events once, and only re-parses changed sources', async () => {
  const home = tmpDir();
  const db = openDb(':memory:');
  try {
    const codexRoot = path.join(home, 'sessions');
    const t1 = usageObj(1000, 600, 50, 20);
    const t2 = usageObj(1500, 900, 80, 30);
    const original = [
      { type: 'turn_context', payload: { model: 'gpt-5.5' } },
      codexTokenCount(DAY1, t1, t1),
      codexTokenCount(DAY2, t2, usageObj(500, 300, 30, 10))
    ];
    writeLines(path.join(codexRoot, 'rollout-2026-09-20T23-00-00-aaa.jsonl'), original);
    // A fork replays the parent's events with fresh timestamps, then adds its own.
    writeLines(path.join(codexRoot, 'rollout-2026-09-21T00-20-00-bbb.jsonl'), [
      { type: 'turn_context', payload: { model: 'gpt-5.5' } },
      codexTokenCount(DAY2 + 60000, t1, t1),
      codexTokenCount(DAY2 + 60000, t2, usageObj(500, 300, 30, 10)),
      codexTokenCount(DAY2 + 120000, usageObj(1600, 900, 90, 30), usageObj(100, 0, 10, 0))
    ]);
    const roots = { codex: [{ label: 'sessions', path: codexRoot }] };

    const first = await importDailyUsage(db, roots);
    assert.deepEqual([first.discovered, first.parsed, first.failed], [2, 2, 0]);
    const sessions = sessionUsageInRange(db);
    const parent = sessions.find((row) => row.session_id.endsWith('aaa'));
    const fork = sessions.find((row) => row.session_id.endsWith('bbb'));
    assert.equal(parent.total_tokens, 1580);
    assert.equal(parent.days, 2);
    assert.equal(fork.total_tokens, 110, 'replayed parent events belong to the parent only');

    const day2 = dailyTotals(db, { start: localDayKey(DAY2), end: localDayKey(DAY2) });
    assert.equal(day2.reduce((sum, row) => sum + row.total_tokens, 0), 530 + 110);

    const second = await importDailyUsage(db, roots);
    assert.equal(second.parsed, 0, 'unchanged transcripts are not re-parsed');

    fs.appendFileSync(path.join(codexRoot, 'rollout-2026-09-21T00-20-00-bbb.jsonl'),
      `${JSON.stringify(codexTokenCount(DAY2 + 180000, usageObj(1700, 900, 100, 30), usageObj(100, 0, 10, 0)))}\n`);
    const third = await importDailyUsage(db, roots);
    assert.equal(third.parsed, 1);
    assert.equal(sessionUsageInRange(db).find((row) => row.session_id.endsWith('bbb')).total_tokens, 220);
  } finally {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('snapshot clients: split days come from cumulative deltas; earlier usage stays unsplit', () => {
  const db = openDb(':memory:');
  try {
    const record = (total, startedAt) => ({
      client: 'antigravity-cli', session_id: 'cli-1', model: 'gemini', total_tokens: total,
      cache_read: 0, cache_write: 0, output_tokens: 0, message_count: 1, started_at: startedAt
    });
    const started = new Date(2026, 8, 1, 10).toISOString();
    recordDailySnapshot(db, record(1000, started), DAY1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get().n, 0, 'no baseline for a session first seen after it started');
    recordDailySnapshot(db, record(1300, started), DAY2);
    const rows = db.prepare('SELECT day, total_tokens FROM usage_daily').all();
    assert.deepEqual(rows, [{ day: localDayKey(DAY2), total_tokens: 300 }]);

    // A session that starts on the day it is first seen is split from zero.
    recordDailySnapshot(db, { ...record(50, new Date(DAY2).toISOString()), session_id: 'cli-2' }, DAY2);
    assert.equal(db.prepare(`SELECT total_tokens FROM usage_daily WHERE session_id = 'cli-2'`).get().total_tokens, 50);
  } finally { db.close(); }
});

test('recordWriter: antigravity-cli rows feed daily snapshots', () => {
  const db = openDb(':memory:');
  try {
    const writer = createWriter(db);
    writer.ingestRows([{ client: 'antigravity-cli', sessionId: 'cli-3', model: 'gemini', input: 10, output: 5, startedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() }]);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM daily_snapshots WHERE session_id = 'cli-3'`).get().n, 1);
    assert.equal(db.prepare(`SELECT total_tokens FROM usage_daily WHERE session_id = 'cli-3'`).get().total_tokens, 15);
  } finally { db.close(); }
});

test('query: tokscale session cost is spread over days by price weight', () => {
  const db = openDb(':memory:');
  try {
    const insertDaily = db.prepare(`
      INSERT INTO usage_daily (client, source_key, session_id, model, day, input_tokens, total_tokens, official_cost_usd)
      VALUES (?, 's', ?, ?, ?, ?, ?, ?)
    `);
    insertDaily.run('claude', 'anchored', 'm', '2026-09-20', 100, 100, null);
    insertDaily.run('claude', 'anchored', 'm', '2026-09-21', 300, 300, null);
    insertDaily.run('claude', 'drifted', 'm', '2026-09-21', 100, 100, null);
    insertDaily.run('grok', 'official', 'g', '2026-09-21', 100, 100, 0.25);
    db.prepare(`INSERT INTO model_pricing (model, input, output, status) VALUES ('m', 0.01, 0.02, 'ok')`).run();
    const insertRecord = db.prepare(`INSERT INTO usage_records (client, session_id, model, total_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)`);
    insertRecord.run('claude', 'anchored', 'm', 400, 10);
    // tokscale counted a different amount of usage: no anchor.
    insertRecord.run('claude', 'drifted', 'm', 150, 99);
    insertRecord.run('grok', 'official', 'g', 200, 7);

    const byDay = Object.fromEntries(dailyTotals(db, { start: '2026-09-20', end: '2026-09-20' })
      .map((row) => [row.model, row.cost_usd]));
    assert.equal(byDay.m, 2.5);
    const sessions = Object.fromEntries(sessionUsageInRange(db).map((row) => [row.session_id, row]));
    assert.equal(sessions.anchored.cost_usd, 10);
    assert.equal(sessions.anchored.cost_source, 'tokscale');
    assert.equal(sessions.drifted.cost_usd, 1);
    assert.equal(sessions.drifted.cost_source, 'price');
    assert.equal(sessions.official.cost_usd, 0.25);
    assert.equal(sessions.official.cost_source, 'official');
  } finally { db.close(); }
});

test('rangeSessions: range usage with lifetime share, project, and unsplit sessions kept apart', () => {
  const { rangeSessions } = require('../../src/shared/dailyUsage/rangeSessions');
  const db = openDb(':memory:');
  try {
    const insertDaily = db.prepare(`
      INSERT INTO usage_daily (client, source_key, session_id, model, day, input_tokens, total_tokens, message_count, first_at, last_at, project_path)
      VALUES (?, 's', ?, 'm', ?, ?, ?, 1, ?, ?, ?)
    `);
    insertDaily.run('claude', 'A', '2026-09-20', 100, 100, '2026-09-20T10:00:00.000Z', '2026-09-20T11:00:00.000Z', '/work/repo');
    insertDaily.run('claude', 'A', '2026-09-21', 300, 300, '2026-09-21T09:00:00.000Z', '2026-09-21T10:00:00.000Z', '/work/repo');
    insertDaily.run('claude', 'B', '2026-09-25', 50, 50, '2026-09-25T09:00:00.000Z', '2026-09-25T10:00:00.000Z', null);
    const insertRecord = db.prepare(`INSERT INTO usage_records (client, session_id, model, total_tokens, cost_usd, started_at, last_used_at) VALUES (?, ?, 'm', ?, ?, ?, ?)`);
    insertRecord.run('claude', 'A', 400, 4, '2026-09-20T10:00:00.000Z', '2026-09-21T10:00:00.000Z');
    // No transcript left: active across the range, listed as unsplit.
    insertRecord.run('claude', 'C', 999, 9, new Date(2026, 8, 19, 12).toISOString(), new Date(2026, 8, 22, 12).toISOString());
    // Outside the range.
    insertRecord.run('cursor', 'D', 10, 1, new Date(2026, 8, 1, 12).toISOString(), new Date(2026, 8, 1, 13).toISOString());

    const result = rangeSessions(db, { start: '2026-09-21', end: '2026-09-21' });
    assert.deepEqual(Object.keys(result.sessions), ['claude:A']);
    const a = result.sessions['claude:A'];
    assert.equal(a.totalTokens, 300);
    assert.equal(a.rangeLifetimeTokens, 400);
    assert.equal(a.projectLabel, 'repo');
    assert.ok(a.projectId);
    assert.deepEqual(a.models, { m: 300 });
    assert.deepEqual(Object.keys(result.unsplit), ['claude:C']);
    assert.equal(result.unsplit['claude:C'].unsplit, true);
    assert.equal(result.unsplit['claude:C'].totalTokens, 999);
  } finally { db.close(); }
});

test('pricing: parses tokscale output and prices tokens, preferring an official cost', () => {
  const price = parsePricingOutput(`spinner\n${JSON.stringify({
    matchedKey: 'claude-opus-5', source: 'LiteLLM',
    pricing: { inputCostPerToken: 5e-6, outputCostPerToken: 25e-6, cacheReadInputTokenCost: 5e-7, cacheCreationInputTokenCost: 6.25e-6 }
  })}`);
  assert.equal(price.cache_write, 6.25e-6);
  const db = openDb(':memory:');
  try {
    db.prepare(`INSERT INTO usage_daily (client, source_key, session_id, model, day, input_tokens) VALUES ('claude', 's', 'x', 'claude-opus-5', '2026-09-20', 1)`).run();
    db.prepare(`INSERT INTO usage_daily (client, source_key, session_id, model, day, input_tokens) VALUES ('claude', 's', 'y', 'unknown-model', '2026-09-20', 1)`).run();
    const result = refreshPricing(db, { bin: 'unused' }, {
      lookup: (model) => (model === 'claude-opus-5' ? price : null),
      readCatalog: () => null
    });
    assert.deepEqual(result, { fetched: 1, missing: 1 });
    const prices = priceTable(db);
    const cost = costOf({ model: 'claude-opus-5', input_tokens: 1000, cache_read: 10000, cache_write: 100, output_tokens: 200 }, prices);
    assert.ok(Math.abs(cost - (1000 * 5e-6 + 10000 * 5e-7 + 100 * 6.25e-6 + 200 * 25e-6)) < 1e-12);
    assert.equal(costOf({ model: 'unknown-model', input_tokens: 5 }, prices), null);
    assert.equal(costOf({ model: 'grok', official_cost_usd: 1.5 }, prices), 1.5);
  } finally { db.close(); }
});

test('pricing: long-context tiers bill only the part of a request above the threshold', () => {
  const { aggregateDaily } = require('../../src/shared/dailyUsage/store');
  // One request with 300k uncached input and 10k output; one small request.
  const [row] = aggregateDaily([
    { sessionId: 's', model: 'gpt', ts: DAY1, input: 300000, cacheRead: 0, cacheWrite: 0, output: 10000, reasoning: 0, total: 310000 },
    { sessionId: 's', model: 'gpt', ts: DAY1, input: 1000, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0, total: 1010 }
  ]);
  assert.equal(row.x_input_128k, 172000);
  assert.equal(row.x_input_272k, 28000);
  assert.equal(row.x_output_128k, 0);

  const db = openDb(':memory:');
  try {
    db.prepare(`INSERT INTO usage_daily (client, source_key, session_id, model, day, input_tokens) VALUES ('codex', 's', 's', 'gpt', '2026-09-20', 1)`).run();
    refreshPricing(db, { bin: 'unused' }, {
      lookup: () => ({ input: 4e-6, output: 2e-5, cache_read: 4e-7, cache_write: null, matched_key: 'gpt', source: 'LiteLLM' }),
      readCatalog: () => ({ input_cost_per_token_above_272k_tokens: 8e-6, output_cost_per_token_above_272k_tokens: 3e-5 })
    });
    const cost = costOf({ model: 'gpt', input_tokens: row.input_tokens, output_tokens: row.output_tokens, ...row }, priceTable(db));
    const expected = 301000 * 4e-6 + 28000 * (8e-6 - 4e-6) + 10010 * 2e-5;
    assert.ok(Math.abs(cost - expected) < 1e-12);
  } finally { db.close(); }
});
