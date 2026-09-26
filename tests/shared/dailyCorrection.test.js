'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractUsageFromTokscale } = require('../../src/shared/usage');
const { parseGraphResult } = require('../../src/shared/history');
const { openDb } = require('../../src/shared/persistence/db');
const {
  buildDailyCorrection,
  correctHistoryGraph,
  correctSummaryPeriods
} = require('../../src/shared/dailyUsage/correction');

const TODAY = '2026-09-26';

function tokscalePeriod(entries) {
  return extractUsageFromTokscale({ entries });
}

// One split model row, in usage_daily's shape (output includes reasoning).
function splitRow(tokens, { cost = 0, input = 0, cacheRead = 0, cacheWrite = 0, output = 0, reasoning = 0, messages = 1 } = {}) {
  return { tokens, cost, input, cacheRead, cacheWrite, output, reasoning, messages };
}

function splitSession(client, sessionId, models) {
  return { client, sessionId, firstAt: '2026-09-26T01:00:00.000Z', lastAt: '2026-09-26T02:00:00.000Z', projectPath: '', models: new Map(Object.entries(models)) };
}

function correctionFor(periodSessions, covered) {
  return {
    todayKey: TODAY,
    covered: new Set(covered),
    periods: { today: new Map(), month: new Map(periodSessions.map((s) => [`${s.client}:${s.sessionId}`, s])), allTime: new Map() },
    days: new Map(),
    uncoveredDays: new Map()
  };
}

const AGGREGATES = ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'clients', 'clientCacheReads',
  'clientCacheWrites', 'clientOutputs', 'models', 'modelCacheReads', 'modelCacheWrites', 'modelOutputs', 'clientModels'];

test('a session whose day split equals tokscale leaves every aggregate unchanged', () => {
  const entries = [
    { client: 'codex', sessionId: 'rollout-a', model: 'gpt-5.5', input: 100, cacheRead: 900, cacheWrite: 0, output: 40, reasoning: 10, cost: 1.5, messageCount: 3 },
    { client: 'cursor', sessionId: 'cur-1', model: 'auto', input: 7, cacheRead: 0, cacheWrite: 0, output: 3, cost: 0.02 }
  ];
  const summary = { updatedAt: '2026-09-26T03:00:00.000Z', month: tokscalePeriod(entries) };
  const before = JSON.parse(JSON.stringify(summary.month));
  summary.month.sessions['codex:rollout-a'].title = 'Refactor';
  const split = splitSession('codex', 'rollout-a', { 'gpt-5.5': splitRow(1050, { cost: 1.5, input: 100, cacheRead: 900, output: 50, reasoning: 10, messages: 3 }) });
  correctSummaryPeriods(summary, correctionFor([split], ['codex:rollout-a']));
  for (const field of AGGREGATES) assert.deepEqual(summary.month[field], before[field], field);
  assert.ok(Math.abs(summary.month.costUsd - before.costUsd) < 1e-9);
  const session = summary.month.sessions['codex:rollout-a'];
  assert.equal(session.totalTokens, 1050);
  assert.equal(session.title, 'Refactor', 'live metadata is kept');
  assert.equal(session.daySplit, true);
  assert.equal(session.archived, undefined);
});

test('an over-counted session is replaced, other clients are untouched, backup-only sessions are added', () => {
  const entries = [
    // tokscale counted a replayed fork history: 2000 tokens, $3.
    { client: 'codex', sessionId: 'rollout-fork', model: 'gpt-5.5', input: 200, cacheRead: 1700, cacheWrite: 0, output: 90, reasoning: 10, cost: 3 },
    { client: 'cursor', sessionId: 'cur-1', model: 'auto', input: 7, cacheRead: 0, cacheWrite: 0, output: 3, cost: 0.02 },
    // Covered, but none of its usage falls in the period.
    { client: 'claude', sessionId: 'claude-old', model: 'claude-opus-5', input: 5, cacheRead: 40, cacheWrite: 0, output: 5, cost: 0.1 }
  ];
  const summary = { updatedAt: '2026-09-26T03:00:00.000Z', month: tokscalePeriod(entries) };
  const splits = [
    splitSession('codex', 'rollout-fork', { 'gpt-5.5': splitRow(300, { cost: 0.45, input: 50, cacheRead: 230, output: 20, reasoning: 5 }) }),
    splitSession('claude', 'kept-in-backup', { 'claude-opus-5': splitRow(80, { cost: 0.2, input: 10, cacheRead: 60, output: 10 }) })
  ];
  correctSummaryPeriods(summary, correctionFor(splits, ['codex:rollout-fork', 'claude:claude-old', 'claude:kept-in-backup']));
  const month = summary.month;
  assert.equal(month.clients.codex, 300);
  assert.equal(month.clients.cursor, 10);
  assert.equal(month.clients.claude, 80);
  assert.equal(month.totalTokens, 300 + 10 + 80);
  assert.ok(Math.abs(month.costUsd - (0.45 + 0.02 + 0.2)) < 1e-9);
  assert.equal(month.models['gpt-5.5'], 300);
  assert.equal(month.modelCacheReads['gpt-5.5'], 230);
  assert.equal(month.clientModels.codex['gpt-5.5'], 300);
  assert.equal(month.sessions['claude:claude-old'], undefined, 'no usage in the period: removed');
  assert.equal(month.sessions['claude:kept-in-backup'].archived, true);
  assert.equal(month.sessions['cursor:cur-1'].totalTokens, 10);
});

test('a multi-model session keeps exact totals when its components are re-split', () => {
  const entries = [
    { client: 'claude', sessionId: 'c1', model: 'claude-opus-5', input: 10, cacheRead: 500, cacheWrite: 50, output: 20, cost: 0.7 },
    { client: 'claude', sessionId: 'c1', model: 'claude-haiku-4-5', input: 5, cacheRead: 100, cacheWrite: 0, output: 5, cost: 0.1 }
  ];
  const summary = { updatedAt: '2026-09-26T03:00:00.000Z', month: tokscalePeriod(entries) };
  const split = splitSession('claude', 'c1', {
    'claude-opus-5': splitRow(580, { cost: 0.7, input: 10, cacheRead: 500, cacheWrite: 50, output: 20 }),
    'claude-haiku-4-5': splitRow(110, { cost: 0.1, input: 5, cacheRead: 100, output: 5 })
  });
  correctSummaryPeriods(summary, correctionFor([split], ['claude:c1']));
  assert.equal(summary.month.totalTokens, 690);
  assert.deepEqual(summary.month.models, { 'claude-opus-5': 580, 'claude-haiku-4-5': 110 });
  assert.equal(summary.month.cacheReadTokens, 600);
  assert.ok(Math.abs(summary.month.costUsd - 0.8) < 1e-9);
});

test('a summary from another local day is not corrected', () => {
  const summary = { updatedAt: '2026-09-25T23:00:00', month: tokscalePeriod([{ client: 'codex', sessionId: 's', model: 'm', input: 10, output: 1, cost: 1 }]) };
  const split = splitSession('codex', 's', { m: splitRow(1, { input: 1 }) });
  correctSummaryPeriods(summary, correctionFor([split], ['codex:s']));
  assert.equal(summary.month.totalTokens, 11);
});

function graphEntry(client, modelId, tokens, cost) {
  return { client, modelId, tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost, messages: 1 };
}

test('history: whole covered cells are replaced, uncovered ones are reported, backup-only days are added', () => {
  const graph = {
    contributions: [
      { date: '2026-09-20', clients: [graphEntry('claude', 'claude-opus-5', 1000, 1), graphEntry('grok', 'grok-4.6', 2000, 4), graphEntry('cursor', 'auto', 50, 0.1)], tokenComponentSummary: { stale: true } },
      { date: '2026-09-21', clients: [graphEntry('codex', 'gpt-5.5', 500, 2)] },
      { date: '2026-09-23', clients: [graphEntry('grok', 'grok-4.6', 300, 1)] }
    ]
  };
  const days = new Map([
    ['2026-09-20', new Map([
      ['claude', new Map([['claude-opus-5', splitRow(1000, { cost: 1, input: 1000 })]])],
      ['grok', new Map([['grok-4.6', splitRow(1000, { cost: 0.5, input: 900, output: 100, reasoning: 30 })]])]
    ])],
    ['2026-09-21', new Map([['codex', new Map([['gpt-5.5', splitRow(400, { cost: 1.6, input: 400 })]])]])],
    ['2026-09-22', new Map([['claude', new Map([['claude-opus-5', splitRow(70, { cost: 0.07, input: 70 })]])]])]
  ]);
  const correction = {
    todayKey: TODAY,
    covered: new Set(),
    periods: {},
    days,
    uncoveredDays: new Map([['codex', new Set(['2026-09-21'])]])
  };
  const { graph: corrected, uncorrected } = correctHistoryGraph(graph, correction);
  const parsed = parseGraphResult(corrected).contributions;
  const byDate = Object.fromEntries(parsed.map((row) => [row.date, row]));
  assert.equal(byDate['2026-09-20'].perClient.grok.tokens, 1000);
  assert.equal(byDate['2026-09-20'].perClient.cursor.tokens, 50);
  assert.equal(byDate['2026-09-20'].tokens, 1000 + 1000 + 50);
  assert.equal(corrected.contributions[0].tokenComponentSummary, undefined);
  assert.equal(byDate['2026-09-21'].perClient.codex.tokens, 500, 'uncovered cell keeps its value');
  assert.equal(byDate['2026-09-22'].perClient.claude.tokens, 70, 'backup-only day added');
  assert.equal(byDate['2026-09-23'].perClient.grok.tokens, 300, 'no day split behind the value: kept');
  assert.deepEqual(uncorrected, { '2026-09-21': ['codex'], '2026-09-23': ['grok'] });
  assert.equal(graph.contributions[0].clients.length, 3, 'the input graph is not mutated');
});

test('history: codex reasoning is emitted apart from output so tokscale totals add up', () => {
  const graph = { contributions: [{ date: '2026-09-20', clients: [graphEntry('codex', 'gpt-5.5', 999, 9)] }] };
  const correction = {
    todayKey: TODAY, covered: new Set(), periods: {}, uncoveredDays: new Map(),
    days: new Map([['2026-09-20', new Map([['codex', new Map([['gpt-5.5', splitRow(1050, { cost: 1.5, input: 100, cacheRead: 900, output: 50, reasoning: 10 })]])]])]])
  };
  const parsed = parseGraphResult(correctHistoryGraph(graph, correction).graph).contributions[0];
  assert.equal(parsed.perClient.codex.tokens, 1050);
  assert.equal(parsed.perClient.codex.outputTokens, 50);
});

test('buildDailyCorrection: coverage follows the audit trail and the per-client policy', () => {
  const db = openDb(':memory:');
  try {
    const insertDaily = db.prepare(`
      INSERT INTO usage_daily (client, source_key, session_id, model, day, input_tokens, total_tokens, message_count, first_at, last_at)
      VALUES (?, ?, ?, 'm', ?, ?, ?, 1, ?, ?)
    `);
    const insertRecord = db.prepare(`
      INSERT INTO usage_records (client, session_id, model, total_tokens, cost_usd, started_at, last_used_at, ingested_at)
      VALUES (?, ?, 'm', ?, 1, ?, ?, '2026-09-01 00:00:00')
    `);
    const at = (day, hour) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).toISOString();
    // Claude split missing a part of what tokscale saw: not covered.
    insertDaily.run('claude', 's1', 'claude-partial', '2026-09-20', 50, 50, at('2026-09-20', 10), at('2026-09-20', 11));
    insertRecord.run('claude', 'claude-partial', 100, at('2026-09-20', 10), at('2026-09-20', 11));
    // Codex split lower than tokscale (a replayed fork): covered.
    insertDaily.run('codex', 's2', 'rollout-fork', '2026-09-26', 30, 30, at('2026-09-26', 9), at('2026-09-26', 10));
    insertRecord.run('codex', 'rollout-fork', 90, at('2026-09-26', 9), at('2026-09-26', 10));
    // Only in a backup: covered.
    insertDaily.run('claude', 's3', 'backup-only', '2026-09-10', 40, 40, at('2026-09-10', 9), at('2026-09-10', 10));
    // Deleted before splitting, active 09-18..09-19: those days are uncovered.
    insertRecord.run('grok', 'gone', 500, at('2026-09-18', 9), at('2026-09-19', 9));
    // The history folds antigravity-cli into antigravity: its days stay uncovered there.
    insertRecord.run('antigravity-cli', 'cli-1', 70, at('2026-09-13', 9), at('2026-09-14', 9));
    // A parsed rollout that only replays its ancestors: covered, with no usage.
    db.prepare(`INSERT INTO daily_sources (source_key, client, path, parser_version) VALUES ('codex:rollout-replay.jsonl', 'codex', 'x', 3)`).run();
    insertRecord.run('codex', 'rollout-replay', 7000, at('2026-09-25', 9), at('2026-09-25', 10));

    const correction = buildDailyCorrection(db, { todayKey: TODAY, allTimeSince: '2024-01-01' });
    assert.equal(correction.covered.has('claude:claude-partial'), false);
    assert.equal(correction.covered.has('codex:rollout-fork'), true);
    assert.equal(correction.covered.has('claude:backup-only'), true);
    assert.deepEqual([...correction.uncoveredDays.get('grok')], ['2026-09-18', '2026-09-19']);
    assert.deepEqual([...correction.uncoveredDays.get('claude')], ['2026-09-20']);
    assert.deepEqual([...correction.periods.today.keys()], ['codex:rollout-fork']);
    assert.deepEqual([...correction.periods.allTime.keys()].sort(), ['claude:backup-only', 'codex:rollout-fork']);
    assert.equal(correction.uncoveredDays.has('codex'), false, 'every known codex session is covered');
    assert.equal(correction.covered.has('codex:rollout-replay'), true);
    assert.equal(correction.periods.allTime.has('codex:rollout-replay'), false, 'no usage of its own');
    assert.deepEqual([...correction.uncoveredDays.get('antigravity')], ['2026-09-13', '2026-09-14']);
  } finally { db.close(); }
});
