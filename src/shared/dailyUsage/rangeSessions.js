'use strict';

// Sessions of a date range, shaped like a period's `sessions` map so the
// renderer's Sessions and Projects views can list them unchanged.
//
// sessions  day-split usage inside the range. Each carries its lifetime total
//           (rangeLifetimeTokens) so a session that also ran outside the range
//           reads "in range X / all Y", and the sources of its cost.
// unsplit   sessions active in the range with no day-split rows (their
//           transcripts were gone before splitting, or the client is not
//           split). Their totals are lifetime values, so they are kept out of
//           `sessions` and never summed into range or project totals.

const { SNAPSHOT_CLIENTS, localDayKey } = require('./store');
const { sessionUsageInRange } = require('./query');
const { projectIdentity } = require('../sessionMetadata');

function sessionKey(client, sessionId) {
  return `${client}:${sessionId}`;
}

function earlier(a, b) { return !a ? b : !b ? a : (a <= b ? a : b); }
function later(a, b) { return !a ? b : !b ? a : (a >= b ? a : b); }

function dayOf(iso) {
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? localDayKey(ms) : '';
}

function lifetimeTokens(db) {
  const daily = new Map();
  for (const row of db.prepare(`
    SELECT client, session_id, SUM(total_tokens) AS tokens FROM usage_daily GROUP BY client, session_id
  `).all()) daily.set(sessionKey(row.client, row.session_id), row.tokens || 0);
  return daily;
}

function recordTotals(db) {
  const totals = new Map();
  for (const row of db.prepare(`
    SELECT client, session_id, model, total_tokens, cost_usd, message_count, started_at, last_used_at
    FROM usage_records
  `).all()) {
    const key = sessionKey(row.client, row.session_id);
    let entry = totals.get(key);
    if (!entry) {
      entry = { client: row.client, sessionId: row.session_id, tokens: 0, cost: 0, messages: 0, models: {}, startedAt: '', lastUsedAt: '' };
      totals.set(key, entry);
    }
    entry.tokens += row.total_tokens || 0;
    entry.cost += row.cost_usd || 0;
    entry.messages += row.message_count || 0;
    if (row.model) entry.models[row.model] = (entry.models[row.model] || 0) + (row.total_tokens || 0);
    entry.startedAt = earlier(entry.startedAt, row.started_at || '');
    entry.lastUsedAt = later(entry.lastUsedAt, row.last_used_at || '');
  }
  return totals;
}

function rangeSessions(db, range = {}) {
  const sessions = {};
  for (const row of sessionUsageInRange(db, range)) {
    const key = sessionKey(row.client, row.session_id);
    let session = sessions[key];
    if (!session) {
      session = {
        client: row.client,
        sessionId: row.session_id,
        totalTokens: 0,
        costUsd: 0,
        unpricedTokens: 0,
        costSources: [],
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        messageCount: 0,
        models: {},
        startedAt: '',
        lastUsedAt: '',
        rangeDays: 0,
        ...projectIdentity(row.project_path || '')
      };
      sessions[key] = session;
    }
    session.totalTokens += row.total_tokens || 0;
    session.inputTokens += row.input_tokens || 0;
    session.cacheReadTokens += row.cache_read || 0;
    session.cacheWriteTokens += row.cache_write || 0;
    session.outputTokens += row.output_tokens || 0;
    session.messageCount += row.message_count || 0;
    if (row.model) session.models[row.model] = (session.models[row.model] || 0) + (row.total_tokens || 0);
    if (row.cost_usd == null) session.unpricedTokens += row.total_tokens || 0;
    else session.costUsd += row.cost_usd;
    if (row.cost_source && !session.costSources.includes(row.cost_source)) session.costSources.push(row.cost_source);
    session.startedAt = earlier(session.startedAt, row.first_at || '');
    session.lastUsedAt = later(session.lastUsedAt, row.last_at || '');
    session.rangeDays = Math.max(session.rangeDays, row.days || 0);
  }

  const lifetime = lifetimeTokens(db);
  const records = recordTotals(db);
  for (const [key, session] of Object.entries(sessions)) {
    let total = lifetime.get(key) || session.totalTokens;
    // Snapshot clients split only from their first snapshot on; the audit
    // trail still knows the usage before it.
    if (SNAPSHOT_CLIENTS.has(session.client)) total = Math.max(total, records.get(key)?.tokens || 0);
    session.rangeLifetimeTokens = total;
  }

  const unsplit = {};
  for (const [key, entry] of records) {
    if (lifetime.has(key) || !(entry.tokens > 0)) continue;
    const firstDay = dayOf(entry.startedAt) || dayOf(entry.lastUsedAt);
    const lastDay = dayOf(entry.lastUsedAt) || firstDay;
    if (!firstDay) continue;
    if (range.end && firstDay > range.end) continue;
    if (range.start && lastDay < range.start) continue;
    unsplit[key] = {
      client: entry.client,
      sessionId: entry.sessionId,
      totalTokens: entry.tokens,
      costUsd: entry.cost,
      messageCount: entry.messages,
      models: entry.models,
      startedAt: entry.startedAt,
      lastUsedAt: entry.lastUsedAt,
      unsplit: true
    };
  }
  return { range, sessions, unsplit };
}

module.exports = { rangeSessions };
