'use strict';

// Corrects a collector summary with usage counted from transcripts.
//
// tokscale over-counts some sessions of the day-split clients (a Grok session
// read from both updates.jsonl and the unified log; a Codex fork of a fork that
// replays its ancestors' history). usage_daily counts each event once, so
// wherever it holds a session it is the better source:
//
// Periods (today / month / allTime): a session usage_daily covers is taken out
//   of the period, with every aggregate it contributed to, and put back with
//   its day-split usage inside the period's dates. Sessions only usage_daily
//   knows (kept in a transcript backup) are added as archived. Sessions without
//   day-split rows keep tokscale's numbers.
// History (per day): the history has no per-session grain, so a (day, client)
//   cell is replaced as a whole, and only when every session of that client
//   the audit trail (usage_records) saw active on that day is covered and the
//   day split has usage there. Other cells keep tokscale + archive values and
//   are reported as uncorrected. A session deleted before the audit trail ever
//   saw it is invisible to this rule; transcript backups start after the audit
//   trail, so a day holding such a session has no day split to replace it with.
//
// The snapshot-split client (antigravity-cli) is left alone: its day split
// starts at its first snapshot, so it never covers a whole session.

const { normalizeModelNameForClient } = require('../usage');
const { hasDisjointReasoning, normalizeTokscaleClientName } = require('../history');
const { localDayKey, SNAPSHOT_SOURCE } = require('./store');
const { dailyTotals, sessionUsageInRange } = require('./query');

const CORRECTED_CLIENTS = new Set(['claude', 'codex', 'grok', 'antigravity']);
// tokscale is not known to over-count these; a day split that comes out lower
// means transcript parts are missing, so tokscale is kept for that session.
const SPLIT_MUST_COVER_TOTAL = new Set(['claude', 'antigravity']);
const COVER_TOLERANCE = 0.99;
const PERIOD_NAMES = ['today', 'month', 'allTime'];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sessionKey(client, sessionId) {
  return `${client}:${sessionId}`;
}

// The collector's model name for a day-split row; a row without one is
// 'unknown', as in tokscale's graph, so model maps still add up to the total.
function modelName(row) {
  return normalizeModelNameForClient(row.model, row.client) || row.model || 'unknown';
}

function dayOf(iso) {
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? localDayKey(ms) : '';
}

function addDays(dayKey, delta) {
  const date = new Date(`${dayKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Building the correction from the database

function splitLifetimes(db) {
  const lifetimes = new Map();
  for (const row of db.prepare(`
    SELECT client, session_id, SUM(total_tokens) AS tokens
    FROM usage_daily WHERE source_key != ? GROUP BY client, session_id
  `).all(SNAPSHOT_SOURCE)) {
    if (CORRECTED_CLIENTS.has(row.client)) lifetimes.set(sessionKey(row.client, row.session_id), num(row.tokens));
  }
  return lifetimes;
}

// Clients the collector and the history fold into a corrected client
// (history.js TOKSCALE_CLIENT_ALIASES). Their usage shares that client's
// history cells but never has day-split rows there, so their days stay
// uncovered for it.
const FOLDED_INTO = new Map([['antigravity-cli', 'antigravity']]);

function recordSessions(db) {
  const sessions = new Map();
  for (const row of db.prepare(`
    SELECT client, session_id, SUM(total_tokens) AS tokens, MIN(started_at) AS started_at,
      MAX(last_used_at) AS last_used_at
    FROM usage_records GROUP BY client, session_id
  `).all()) {
    if (CORRECTED_CLIENTS.has(row.client)) {
      sessions.set(sessionKey(row.client, row.session_id), row);
    } else if (FOLDED_INTO.has(row.client)) {
      const client = FOLDED_INTO.get(row.client);
      sessions.set(sessionKey(`${row.client}>${client}`, row.session_id), { ...row, client, folded: true });
    }
  }
  return sessions;
}

// Codex sessions whose rollout was parsed. A fork that only replays its
// ancestors' history owns no event and so has no day-split row, yet its
// transcript proves its own usage is zero.
function parsedCodexSessions(db) {
  return new Set(db.prepare(`SELECT source_key FROM daily_sources WHERE client = 'codex'`).all()
    .map((row) => sessionKey('codex', row.source_key.slice('codex:'.length).replace(/\.jsonl$/, ''))));
}

// Per-model rows of one session inside a range, with model names normalized
// the way the collector names them.
function periodSessions(db, range, covered) {
  const sessions = new Map();
  for (const row of sessionUsageInRange(db, range)) {
    if (!CORRECTED_CLIENTS.has(row.client)) continue;
    const key = sessionKey(row.client, row.session_id);
    if (!covered.has(key)) continue;
    let session = sessions.get(key);
    if (!session) {
      session = { client: row.client, sessionId: row.session_id, firstAt: '', lastAt: '', projectPath: '', models: new Map() };
      sessions.set(key, session);
    }
    const model = modelName(row);
    const entry = session.models.get(model) || { tokens: 0, cost: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, messages: 0 };
    entry.tokens += num(row.total_tokens);
    entry.cost += num(row.cost_usd);
    entry.input += num(row.input_tokens);
    entry.cacheRead += num(row.cache_read);
    entry.cacheWrite += num(row.cache_write);
    entry.output += num(row.output_tokens);
    entry.reasoning += num(row.reasoning_tokens);
    entry.messages += num(row.message_count);
    session.models.set(model, entry);
    if (row.first_at && (!session.firstAt || row.first_at < session.firstAt)) session.firstAt = row.first_at;
    if (row.last_at && row.last_at > session.lastAt) session.lastAt = row.last_at;
    if (row.project_path) session.projectPath = row.project_path;
  }
  for (const [key, session] of sessions) {
    if ([...session.models.values()].every((entry) => entry.tokens <= 0)) sessions.delete(key);
  }
  return sessions;
}

function dayCells(db) {
  const days = new Map();
  for (const row of dailyTotals(db)) {
    if (!CORRECTED_CLIENTS.has(row.client)) continue;
    if (!days.has(row.day)) days.set(row.day, new Map());
    const clients = days.get(row.day);
    if (!clients.has(row.client)) clients.set(row.client, new Map());
    const models = clients.get(row.client);
    const model = modelName(row);
    const entry = models.get(model) || { tokens: 0, cost: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, messages: 0 };
    entry.tokens += num(row.total_tokens);
    entry.cost += num(row.cost_usd);
    entry.input += num(row.input_tokens);
    entry.cacheRead += num(row.cache_read);
    entry.cacheWrite += num(row.cache_write);
    entry.output += num(row.output_tokens);
    entry.reasoning += num(row.reasoning_tokens);
    entry.messages += num(row.message_count);
    models.set(model, entry);
  }
  return days;
}

function buildDailyCorrection(db, options = {}) {
  const todayKey = options.todayKey || localDayKey(Date.now());
  const allTimeSince = /^\d{4}-\d{2}-\d{2}$/.test(options.allTimeSince || '') ? options.allTimeSince : '';
  const lifetimes = splitLifetimes(db);
  const records = recordSessions(db);

  const covered = new Set();
  for (const [key, tokens] of lifetimes) {
    const record = records.get(key);
    const client = key.slice(0, key.indexOf(':'));
    if (record && SPLIT_MUST_COVER_TOTAL.has(client) && tokens < num(record.tokens) * COVER_TOLERANCE) continue;
    covered.add(key);
  }
  for (const key of parsedCodexSessions(db)) {
    if (records.has(key)) covered.add(key);
  }

  // Days on which some session of a client is known but not covered.
  const uncoveredDays = new Map();
  for (const [key, record] of records) {
    const client = record.client;
    if (!record.folded && covered.has(key)) continue;
    const first = dayOf(record.started_at) || dayOf(record.last_used_at);
    const last = dayOf(record.last_used_at) || first;
    if (!first) continue;
    if (!uncoveredDays.has(client)) uncoveredDays.set(client, new Set());
    const set = uncoveredDays.get(client);
    for (let day = first, guard = 0; day <= last && guard < 400; day = addDays(day, 1), guard += 1) set.add(day);
  }

  const ranges = {
    today: { start: todayKey, end: todayKey },
    month: { start: `${todayKey.slice(0, 8)}01`, end: todayKey },
    allTime: { start: allTimeSince || undefined, end: todayKey }
  };
  const periods = {};
  for (const name of PERIOD_NAMES) periods[name] = periodSessions(db, ranges[name], covered);

  return { todayKey, covered, periods, days: dayCells(db), uncoveredDays };
}

// ---------------------------------------------------------------------------
// Periods

function add(map, key, value) {
  if (!key || !value) return;
  map[key] = num(map[key]) + value;
}

function subtract(map, key, value) {
  if (!key || !value || !(key in map)) return;
  const next = num(map[key]) - value;
  if (next > 1e-6) map[key] = next;
  else delete map[key];
}

function nested(map, outer) {
  if (!map[outer]) map[outer] = {};
  return map[outer];
}

function subtractNested(map, outer, key, value) {
  if (!map[outer]) return;
  subtract(map[outer], key, value);
  if (Object.keys(map[outer]).length === 0) delete map[outer];
}

function clampField(period, field, delta) {
  period[field] = Math.max(0, num(period[field]) + delta);
}

// Removes one session's contribution, mirroring how it was added: a live row
// (addUsageRowToPeriod) leaves input implicit; an archived session
// (addArchivedSession) counts input as unclassified. Per-model components of a
// multi-model live session are not kept per session, so they are taken out in
// proportion to each model's tokens.
function removeSession(period, session) {
  const client = session.client;
  const tokens = Math.max(0, Math.round(num(session.totalTokens)));
  const cost = num(session.costUsd);
  const cacheRead = Math.max(0, Math.round(num(session.cacheReadTokens)));
  const cacheWrite = Math.max(0, Math.round(num(session.cacheWriteTokens)));
  const output = Math.max(0, Math.round(num(session.outputTokens)));
  const archived = session.archived === true;

  clampField(period, 'totalTokens', -tokens);
  clampField(period, 'costUsd', -cost);
  clampField(period, 'cacheReadTokens', -cacheRead);
  clampField(period, 'cacheWriteTokens', -cacheWrite);
  clampField(period, 'outputTokens', -output);
  subtract(period.clients, client, tokens);
  subtract(period.clientCosts, client, cost);
  subtract(period.clientCacheReads, client, cacheRead);
  subtract(period.clientCacheWrites, client, cacheWrite);
  subtract(period.clientOutputs, client, output);
  if (archived) {
    const unclassified = Math.max(0, tokens - cacheRead - cacheWrite - output);
    clampField(period, 'unclassifiedTokens', -unclassified);
    subtract(period.clientUnclassifiedTokens, client, unclassified);
  }

  const models = Object.entries(session.models || {})
    .map(([model, value]) => [model, Math.max(0, Math.round(num(value)))])
    .filter(([, value]) => value > 0);
  const modelTotal = models.reduce((sum, [, value]) => sum + value, 0);
  for (const [model, value] of models) {
    subtract(period.models, model, value);
    subtractNested(period.clientModels, client, model, value);
    if (archived && models.length > 1) {
      subtract(period.modelUnclassifiedTokens, model, value);
      continue;
    }
    const share = modelTotal > 0 ? value / modelTotal : 0;
    const cr = Math.min(value, Math.round(cacheRead * share));
    const cw = Math.min(value - cr, Math.round(cacheWrite * share));
    const ou = Math.min(value - cr - cw, Math.round(output * share));
    subtract(period.modelCacheReads, model, cr);
    subtract(period.modelCacheWrites, model, cw);
    subtract(period.modelOutputs, model, ou);
    if (archived) subtract(period.modelUnclassifiedTokens, model, Math.max(0, value - cr - cw - ou));
  }
  for (const [model, value] of Object.entries(session.modelCosts || {})) {
    subtract(period.modelCosts, model, num(value));
    subtractNested(period.clientModelCosts, session.client, model, num(value));
  }
}

// Adds a day-split session the way the collector adds a usage row per model.
function addSplitSession(period, split, previous) {
  const client = split.client;
  const session = {
    ...(previous || {}),
    client,
    sessionId: split.sessionId,
    totalTokens: 0,
    costUsd: 0,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    models: {},
    modelCosts: {},
    providers: previous?.providers || {},
    startedAt: previous?.startedAt || split.firstAt || '',
    lastUsedAt: previous?.lastUsedAt || split.lastAt || '',
    daySplit: true
  };
  if (!previous) session.archived = true;
  for (const [model, entry] of split.models) {
    const tokens = Math.max(0, Math.round(entry.tokens));
    if (tokens <= 0) continue;
    const cost = num(entry.cost);
    period.totalTokens = num(period.totalTokens) + tokens;
    period.costUsd = num(period.costUsd) + cost;
    period.cacheReadTokens = num(period.cacheReadTokens) + entry.cacheRead;
    period.cacheWriteTokens = num(period.cacheWriteTokens) + entry.cacheWrite;
    period.outputTokens = num(period.outputTokens) + entry.output;
    add(period.clients, client, tokens);
    add(period.clientCosts, client, cost);
    add(period.clientCacheReads, client, entry.cacheRead);
    add(period.clientCacheWrites, client, entry.cacheWrite);
    add(period.clientOutputs, client, entry.output);
    if (model) {
      add(period.models, model, tokens);
      add(period.modelCosts, model, cost);
      add(period.modelCacheReads, model, entry.cacheRead);
      add(period.modelCacheWrites, model, entry.cacheWrite);
      add(period.modelOutputs, model, entry.output);
      add(nested(period.clientModels, client), model, tokens);
      add(nested(period.clientModelCosts, client), model, cost);
      add(session.models, model, tokens);
      add(session.modelCosts, model, cost);
    }
    session.totalTokens += tokens;
    session.costUsd += cost;
    session.messageCount += Math.round(entry.messages);
    session.inputTokens += entry.input;
    session.outputTokens += entry.output;
    session.cacheReadTokens += entry.cacheRead;
    session.cacheWriteTokens += entry.cacheWrite;
    session.reasoningTokens += entry.reasoning;
  }
  if (session.totalTokens > 0) period.sessions[sessionKey(client, split.sessionId)] = session;
}

function correctPeriod(period, splitSessions, covered) {
  if (!period || typeof period !== 'object' || !period.sessions) return 0;
  for (const field of ['clients', 'clientCosts', 'clientCacheReads', 'clientCacheWrites', 'clientOutputs',
    'clientUnclassifiedTokens', 'models', 'modelCosts', 'modelCacheReads', 'modelCacheWrites', 'modelOutputs',
    'modelUnclassifiedTokens', 'clientModels', 'clientModelCosts']) {
    if (!period[field] || typeof period[field] !== 'object') period[field] = {};
  }
  const previous = new Map();
  for (const [key, session] of Object.entries(period.sessions)) {
    if (!CORRECTED_CLIENTS.has(session?.client) || !covered.has(key)) continue;
    removeSession(period, session);
    delete period.sessions[key];
    previous.set(key, session);
  }
  let replaced = 0;
  for (const [key, split] of splitSessions) {
    if (period.sessions[key]) continue;
    addSplitSession(period, split, previous.get(key));
    replaced += 1;
  }
  return replaced;
}

// Applies the correction to today / month / allTime of a summary (or of its
// `periods` container). A summary from another local day than the correction
// is left as is, so a day rollover never mixes two days.
function correctSummaryPeriods(summary, correction, options = {}) {
  if (!summary || !correction) return summary;
  const container = summary.periods && typeof summary.periods === 'object' ? summary.periods : summary;
  const summaryDay = options.todayKey || localDayKey(Date.parse(summary.updatedAt || '') || Date.now());
  if (summaryDay !== correction.todayKey) return summary;
  for (const name of PERIOD_NAMES) {
    if (container[name]) correctPeriod(container[name], correction.periods[name] || new Map(), correction.covered);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// History

function graphEntry(client, model, entry) {
  const disjoint = hasDisjointReasoning(client);
  const output = Math.max(0, Math.round(entry.output));
  const reasoning = Math.max(0, Math.round(entry.reasoning));
  return {
    client,
    modelId: model || 'unknown',
    tokens: {
      input: Math.max(0, Math.round(entry.input)),
      output: disjoint ? Math.max(0, output - reasoning) : output,
      cacheRead: Math.max(0, Math.round(entry.cacheRead)),
      cacheWrite: Math.max(0, Math.round(entry.cacheWrite)),
      reasoning: disjoint ? Math.min(output, reasoning) : 0
    },
    cost: num(entry.cost),
    messages: Math.round(entry.messages)
  };
}

function cellCovered(correction, day, client) {
  return !correction.uncoveredDays.get(client)?.has(day);
}

// Rewrites a raw tokscale graph ({ contributions: [{ date, clients: [...] }] })
// before it is normalized. Returns the graph and the uncorrected cells:
// { 'YYYY-MM-DD': [client, ...] } for days whose value for a client could not
// be verified against transcripts.
function correctHistoryGraph(graph, correction) {
  const uncorrected = {};
  if (!graph || !correction || !Array.isArray(graph.contributions)) return { graph, uncorrected };
  const markUncorrected = (day, client) => {
    if (!uncorrected[day]) uncorrected[day] = [];
    if (!uncorrected[day].includes(client)) uncorrected[day].push(client);
  };
  const byDate = new Map();
  const contributions = graph.contributions.map((row) => {
    const date = String(row?.date || '').slice(0, 10);
    const copy = { ...row, clients: Array.isArray(row?.clients) ? [...row.clients] : [] };
    if (date) byDate.set(date, copy);
    return copy;
  });

  const replaceCell = (row, client, models) => {
    row.clients = row.clients.filter((entry) => (normalizeTokscaleClientName(entry?.client) || entry?.client) !== client);
    for (const [model, entry] of models) {
      if (entry.tokens > 0) row.clients.push(graphEntry(client, model, entry));
    }
    delete row.tokenComponentSummary;
  };

  for (const row of contributions) {
    const date = String(row.date || '').slice(0, 10);
    if (!date) continue;
    const present = new Set(row.clients.map((entry) => normalizeTokscaleClientName(entry?.client) || entry?.client));
    for (const client of CORRECTED_CLIENTS) {
      const split = correction.days.get(date)?.get(client);
      const hasGraph = present.has(client);
      if (!split && !hasGraph) continue;
      // A graph value with no day-split usage behind it cannot be explained
      // by the transcripts: it may be a replay, or a session never seen.
      if (!cellCovered(correction, date, client) || !split) {
        if (hasGraph) markUncorrected(date, client);
        continue;
      }
      replaceCell(row, client, split);
    }
  }

  // Days only the day split knows (sessions kept in a transcript backup).
  for (const [date, clients] of correction.days) {
    if (byDate.has(date) || date > correction.todayKey) continue;
    const row = { date, clients: [] };
    for (const [client, models] of clients) {
      if (cellCovered(correction, date, client)) replaceCell(row, client, models);
    }
    if (row.clients.length > 0) contributions.push(row);
  }
  contributions.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  return { graph: { ...graph, contributions }, uncorrected };
}

module.exports = {
  CORRECTED_CLIENTS,
  buildDailyCorrection,
  correctHistoryGraph,
  correctSummaryPeriods
};
