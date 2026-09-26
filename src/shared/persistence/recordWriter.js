'use strict';

// Translates a raw tokscale row (the same shape that flows through
// extractUsageFromTokscale) into a usage_records row and writes it.
//
// The function is deliberately tolerant: any single malformed row should
// not abort the whole collection. Errors are logged and counted; the
// collector continues with the rest of the rows.

const os = require('node:os');
const { resolveSessionTimestampMap } = require('../sessionTimestamps');
const { tokenValueForClient } = require('../usage');
const { recordDailySnapshot } = require('../dailyUsage/store');

const SESSION_ID_KEYS = ['sessionId', 'session_id', 'session', 'conversationId', 'conversation_id', 'threadId', 'thread_id'];
const MODEL_KEYS = ['model', 'modelName', 'model_name', 'modelId', 'model_id'];
const PROVIDER_KEYS = ['provider', 'providerName', 'provider_name'];
const CLIENT_KEYS = ['client', 'clients', 'source', 'platform', 'agent', 'tool', 'name'];

const STARTED_AT_KEYS = ['startedAt', 'started_at', 'firstUsedAt', 'first_used_at', 'startTime', 'start_time'];
const LAST_USED_AT_KEYS = ['lastUsedAt', 'last_used_at', 'lastTime', 'last_time', 'updatedAt', 'updated_at', 'timestamp', 'date', 'ts'];

const CACHE_READ_KEYS = ['cacheRead', 'cacheReadTokens', 'cache_read_tokens', 'cachedTokens', 'cached_tokens', 'cacheReadInputTokens', 'cache_read_input_tokens'];
const CACHE_WRITE_KEYS = ['cacheWrite', 'cacheWriteTokens', 'cache_write_tokens', 'cacheCreationInputTokens', 'cache_creation_input_tokens'];
const OUTPUT_KEYS = ['output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'totalOutput'];
const COST_KEYS = ['costUsd', 'cost_usd', 'costUSD', 'cost', 'totalCost', 'total_cost'];
const MESSAGE_COUNT_KEYS = ['messageCount', 'message_count', 'messages', 'totalMessages', 'total_messages'];

function firstString(obj, keys) {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function firstNumber(obj, keys) {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

function detectClient(row) {
  const raw = firstString(row, CLIENT_KEYS);
  if (!raw) return null;
  // Match the same case-folding used elsewhere in usage.js.
  return String(raw).toLowerCase().replace(/\s+/g, '-');
}

function detectSessionId(row) {
  return firstString(row, SESSION_ID_KEYS);
}

function detectModel(row) {
  return firstString(row, MODEL_KEYS);
}

function detectProvider(row) {
  return firstString(row, PROVIDER_KEYS);
}

function detectTimestamp(row, keys) {
  return firstString(row, keys);
}

// Claude Code can reuse a deleted session UUID via a stale lastSessionId.
// Treat that as a new instance when the incoming start is after the stored
// session had already ended. Small start-time jitter is the same instance.
const INSTANCE_SLACK_MS = 2 * 60 * 1000;

function parseTs(value) {
  if (!value) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

function modelKey(model) {
  return model == null ? '' : String(model);
}

function isSameSessionInstance(existing, incoming, slackMs = INSTANCE_SLACK_MS) {
  const incomingStart = parseTs(incoming?.started_at);
  if (!Number.isFinite(incomingStart)) return true;
  const existingStart = parseTs(existing?.started_at);
  const existingLast = parseTs(existing?.last_used_at);
  if (!Number.isFinite(existingStart) && !Number.isFinite(existingLast)) return true;
  // Different sources report different starts for one conversation (first
  // transcript line vs first usage message), so any start inside the stored
  // lifetime is the same instance. Only a start after it ended is a reuse.
  const existingEnd = Math.max(
    Number.isFinite(existingStart) ? existingStart : -Infinity,
    Number.isFinite(existingLast) ? existingLast : -Infinity
  );
  return incomingStart <= existingEnd + slackMs;
}

function laterTimestamp(left, right) {
  const a = parseTs(left);
  const b = parseTs(right);
  if (!Number.isFinite(a)) return right || left || null;
  if (!Number.isFinite(b)) return left || null;
  return b > a ? right : left;
}

function pickExistingInstance(existingRows, incoming) {
  if (!existingRows.length) return null;
  if (!incoming.started_at) {
    return existingRows.slice().sort((left, right) => {
      const lastDiff = (parseTs(right.last_used_at) || parseTs(right.started_at) || right.id)
        - (parseTs(left.last_used_at) || parseTs(left.started_at) || left.id);
      return lastDiff !== 0 ? lastDiff : right.id - left.id;
    })[0];
  }
  return existingRows.find((row) => isSameSessionInstance(row, incoming)) || null;
}

function rowToRecord(row, fallbackClient, fallbackSessionId) {
  const client = detectClient(row) || fallbackClient;
  const sessionId = detectSessionId(row) || fallbackSessionId;
  if (!client || !sessionId) return null;
  const model = detectModel(row);
  const provider = detectProvider(row);
  // Tokscale rows carry components only; derive the total the same way the
  // live usage view does (including per-client reasoning handling).
  const totalTokens = Math.max(0, Math.round(tokenValueForClient(row, client)));
  const cacheRead = Math.max(0, Math.round(firstNumber(row, CACHE_READ_KEYS)));
  const cacheWrite = Math.max(0, Math.round(firstNumber(row, CACHE_WRITE_KEYS)));
  const output = Math.max(0, Math.round(firstNumber(row, OUTPUT_KEYS)));
  const costUsd = Math.max(0, firstNumber(row, COST_KEYS));
  const messageCountRaw = firstNumber(row, MESSAGE_COUNT_KEYS);
  const messageCount = messageCountRaw > 0 ? Math.round(messageCountRaw) : null;
  const startedAt = detectTimestamp(row, STARTED_AT_KEYS);
  const lastUsedAt = detectTimestamp(row, LAST_USED_AT_KEYS);
  return {
    client,
    session_id: sessionId,
    model,
    provider,
    total_tokens: totalTokens,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    output_tokens: output,
    cost_usd: costUsd,
    message_count: messageCount,
    started_at: startedAt,
    last_used_at: lastUsedAt,
    source_payload: JSON.stringify(row)
  };
}

function createWriter(db, { logger = null, homeDir = null, resolveTimestampsMap = resolveSessionTimestampMap } = {}) {
  // Instance = (client, session_id, model, started_at). Creation time does not
  // change for a conversation; a reused Claude UUID after lastSessionId recycle
  // has a new started_at and becomes a new row. Rescans of the same instance
  // update in place and never overwrite started_at.
  const selectInstances = db.prepare(`
    SELECT id, started_at, last_used_at
    FROM usage_records
    WHERE client = ? AND session_id = ? AND IFNULL(model, '') = ?
    ORDER BY id
  `);
  const insertStmt = db.prepare(`
    INSERT INTO usage_records (
      client, session_id, model, provider,
      total_tokens, cache_read, cache_write, output_tokens,
      cost_usd, message_count, started_at, last_used_at, source_payload
    ) VALUES (
      @client, @session_id, @model, @provider,
      @total_tokens, @cache_read, @cache_write, @output_tokens,
      @cost_usd, @message_count, @started_at, @last_used_at, @source_payload
    )
  `);
  const updateStmt = db.prepare(`
    UPDATE usage_records SET
      provider        = @provider,
      total_tokens    = @total_tokens,
      cache_read      = @cache_read,
      cache_write     = @cache_write,
      output_tokens   = @output_tokens,
      cost_usd        = @cost_usd,
      message_count   = @message_count,
      started_at      = CASE
        WHEN IFNULL(started_at, '') != '' THEN started_at
        ELSE @started_at
      END,
      last_used_at    = @last_used_at,
      ingested_at     = datetime('now'),
      scan_count      = scan_count + 1,
      source_payload  = @source_payload
    WHERE id = @id
  `);
  const upsertMany = db.transaction((records) => {
    let touched = 0;
    let created = 0;
    for (const rec of records) {
      const existing = selectInstances.all(rec.client, rec.session_id, modelKey(rec.model));
      const match = pickExistingInstance(existing, rec);
      if (match) {
        updateStmt.run({
          ...rec,
          id: match.id,
          last_used_at: laterTimestamp(match.last_used_at, rec.last_used_at)
        });
      } else {
        insertStmt.run(rec);
        created += 1;
      }
      recordDailySnapshot(db, { ...rec, started_at: match?.started_at || rec.started_at });
      touched += 1;
    }
    return { touched, created, updated: touched - created };
  });
  return {
    ingestRows(rows, fallback = {}) {
      const records = [];
      let skipped = 0;
      const pending = [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') { skipped++; continue; }
        const rec = rowToRecord(row, fallback.client, fallback.sessionId);
        if (!rec) { skipped++; continue; }
        records.push(rec);
        if (!rec.started_at || !rec.last_used_at) pending.push(rec);
      }
      if (pending.length > 0) {
        const stamps = resolveTimestampsMap(pending, { homeDir: homeDir || os.homedir() });
        for (const rec of pending) {
          const found = stamps.get(`${rec.client}:${rec.session_id}`) || {};
          if (!rec.started_at) rec.started_at = found.startedAt || null;
          if (!rec.last_used_at) rec.last_used_at = found.lastUsedAt || rec.started_at || null;
        }
      }
      let touched = 0, created = 0, updated = 0;
      try {
        if (records.length > 0) {
          ({ touched, created, updated } = upsertMany(records));
        }
      } catch (err) {
        if (logger && typeof logger.error === 'function') {
          logger.error('persistence ingestRows failed', err);
        }
      }
      return { touched, created, updated, skipped, scanned: rows.length };
    },
    count() {
      return db.prepare('SELECT COUNT(*) AS n FROM usage_records').get().n;
    },
    close() { db.close(); }
  };
}

module.exports = {
  createWriter,
  rowToRecord,
  isSameSessionInstance,
  pickExistingInstance,
  INSTANCE_SLACK_MS
};
