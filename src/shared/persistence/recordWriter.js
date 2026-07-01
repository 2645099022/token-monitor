'use strict';

// Translates a raw tokscale row (the same shape that flows through
// extractUsageFromTokscale) into a usage_records row and writes it.
//
// The function is deliberately tolerant: any single malformed row should
// not abort the whole collection. Errors are logged and counted; the
// collector continues with the rest of the rows.

const SESSION_ID_KEYS = ['sessionId', 'session_id', 'session', 'conversationId', 'conversation_id', 'threadId', 'thread_id'];
const MODEL_KEYS = ['model', 'modelName', 'model_name', 'modelId', 'model_id'];
const PROVIDER_KEYS = ['provider', 'providerName', 'provider_name'];
const CLIENT_KEYS = ['client', 'clients', 'source', 'platform', 'agent', 'tool', 'name'];

const STARTED_AT_KEYS = ['startedAt', 'started_at', 'firstUsedAt', 'first_used_at', 'startTime', 'start_time'];
const LAST_USED_AT_KEYS = ['lastUsedAt', 'last_used_at', 'lastTime', 'last_time', 'updatedAt', 'updated_at', 'timestamp', 'date', 'ts'];

const TOKEN_KEYS = ['totalTokens', 'total_tokens', 'totalTokenCount', 'total_token_count', 'tokens', 'tokenCount', 'token_count'];
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

function rowToRecord(row, fallbackClient, fallbackSessionId) {
  const client = detectClient(row) || fallbackClient;
  const sessionId = detectSessionId(row) || fallbackSessionId;
  if (!client || !sessionId) return null;
  const model = detectModel(row);
  const provider = detectProvider(row);
  const totalTokens = Math.max(0, Math.round(firstNumber(row, TOKEN_KEYS)));
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

function createWriter(db, { logger = null } = {}) {
  // UPSERT: same (client, session_id, model, COALESCE(started_at,'')) overwrites
  // the existing row. The latest cumulative values win, scan_count increments,
  // ingested_at updates. This is what makes "delete source session → DB still
  // has the latest snapshot" actually work.
  const upsertStmt = db.prepare(`
    INSERT INTO usage_records (
      client, session_id, model, provider,
      total_tokens, cache_read, cache_write, output_tokens,
      cost_usd, message_count, started_at, last_used_at, source_payload
    ) VALUES (
      @client, @session_id, @model, @provider,
      @total_tokens, @cache_read, @cache_write, @output_tokens,
      @cost_usd, @message_count, @started_at, @last_used_at, @source_payload
    )
    ON CONFLICT(client, session_id, model, COALESCE(started_at, ''))
    DO UPDATE SET
      provider        = excluded.provider,
      total_tokens    = excluded.total_tokens,
      cache_read      = excluded.cache_read,
      cache_write     = excluded.cache_write,
      output_tokens   = excluded.output_tokens,
      cost_usd        = excluded.cost_usd,
      message_count   = excluded.message_count,
      last_used_at    = excluded.last_used_at,
      ingested_at     = datetime('now'),
      scan_count      = scan_count + 1,
      source_payload  = excluded.source_payload
  `);
  const upsertMany = db.transaction((records) => {
    let touched = 0;
    let created = 0;
    for (const r of records) {
      const info = upsertStmt.run(r);
      touched++;
      if (info.changes === 1) created++;
      // info.changes = 1 on INSERT, 2 on UPDATE (per better-sqlite3 docs)
    }
    return { touched, created, updated: touched - created };
  });
  return {
    ingestRows(rows, fallback = {}) {
      const records = [];
      let skipped = 0;
      for (const row of rows) {
        if (!row || typeof row !== 'object') { skipped++; continue; }
        const rec = rowToRecord(row, fallback.client, fallback.sessionId);
        if (!rec) { skipped++; continue; }
        records.push(rec);
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

module.exports = { createWriter, rowToRecord };
