'use strict';

// Resolve started_at / last_used_at for a usage session without inventing times.
// Prefer transcript timestamps; fall back to time encoded in the session id
// (Codex rollout-*, epoch-prefixed Claude ids, UUIDv7). Never use ingest time.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findSessionFiles, resolveSessionFile, sessionIdCandidates } = require('./sessionFiles');

const jsonlRangeCache = new Map();

function isoFromDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  const date = value instanceof Date ? value : new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function timestampFromUuidV7(id) {
  const compact = String(id || '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(compact)) return '';
  if (parseInt(compact[12], 16) !== 7) return '';
  const ms = parseInt(compact.slice(0, 12), 16);
  if (!Number.isFinite(ms) || ms < 1e12) return '';
  return isoFromDate(new Date(ms));
}

function timestampFromSessionId(id) {
  const raw = String(id || '');
  const isoMatch = raw.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (isoMatch) return isoFromDate(isoMatch[0]);
  const localMatch = raw.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})[:-](\d{2})(?:[:-](\d{2}))?/);
  if (localMatch) {
    const [, year, month, day, hour, minute, second = '0'] = localMatch;
    return isoFromDate(new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  }
  const epochMatch = raw.match(/^(\d{12,14})__/);
  if (epochMatch) return isoFromDate(Number(epochMatch[1]));
  for (const candidate of sessionIdCandidates(raw)) {
    const uuidTime = timestampFromUuidV7(candidate);
    if (uuidTime) return uuidTime;
  }
  return '';
}

function readFileSlice(filePath, start, length) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(length);
    const bytes = fs.readSync(fd, buffer, 0, length, start);
    return buffer.slice(0, bytes).toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

function timestampFromJsonValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return isoFromDate(value);
  if (typeof value === 'string' && value.trim()) return isoFromDate(value);
  return '';
}

function timestampFromJsonLine(line) {
  try {
    const obj = JSON.parse(line);
    return timestampFromJsonValue(
      obj.timestamp || obj.ts || obj.updatedAt || obj.updated_at || obj.createdAt || obj.created_at
    );
  } catch (_) {
    return '';
  }
}

function firstTimestampInText(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const timestamp = timestampFromJsonLine(trimmed);
    if (timestamp) return timestamp;
  }
  return '';
}

function lastTimestampInText(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const timestamp = timestampFromJsonLine(lines[index]);
    if (timestamp) return timestamp;
  }
  return '';
}

function jsonlTimeRange(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return { first: '', last: '' }; }
  const cacheKey = `${stat.size}:${stat.mtimeMs}`;
  const cached = jsonlRangeCache.get(filePath);
  if (cached?.key === cacheKey) return cached.value;

  const headBytes = Math.min(128 * 1024, stat.size);
  const tailBytes = Math.min(64 * 1024, stat.size);
  const first = firstTimestampInText(readFileSlice(filePath, 0, headBytes));
  const last = lastTimestampInText(readFileSlice(filePath, Math.max(0, stat.size - tailBytes), tailBytes))
    || first
    || isoFromDate(stat.mtime);
  const value = { first, last };
  jsonlRangeCache.set(filePath, { key: cacheKey, value });
  return value;
}

function lastJsonlTimestamp(filePath) {
  return jsonlTimeRange(filePath).last || '';
}

function timestampsFromFile(client, sessionId, home) {
  const filePath = resolveSessionFile(client, sessionId, home);
  if (!filePath) return { startedAt: '', lastUsedAt: '' };
  const range = jsonlTimeRange(filePath);
  const idTime = timestampFromSessionId(sessionId);
  return {
    startedAt: range.first || idTime || '',
    lastUsedAt: range.last || range.first || idTime || ''
  };
}

function emptyTimestamps() {
  return { startedAt: '', lastUsedAt: '' };
}

function pickEarlier(left, right) {
  if (!left) return right || '';
  if (!right) return left;
  return left <= right ? left : right;
}

function pickLater(left, right) {
  if (!left) return right || '';
  if (!right) return left;
  return left >= right ? left : right;
}

function mergeTimestamps(base, extra) {
  return {
    startedAt: pickEarlier(base?.startedAt, extra?.startedAt),
    lastUsedAt: pickLater(base?.lastUsedAt, extra?.lastUsedAt)
  };
}

function archiveStamps(archives, client, sessionId) {
  if (!archives) return null;
  return archives.get(`${client}:${sessionId}`)
    || archives.get(sessionId)
    || sessionIdCandidates(sessionId).reduce((found, id) => found || archives.get(id) || archives.get(`${client}:${id}`), null);
}

function combineResolved(client, sessionId, fileStamps, options = {}) {
  const idTime = timestampFromSessionId(sessionId);
  const fromId = idTime ? { startedAt: idTime, lastUsedAt: idTime } : emptyTimestamps();
  return mergeTimestamps(mergeTimestamps(fileStamps || emptyTimestamps(), archiveStamps(options.archives, client, sessionId)), fromId);
}

function resolveSessionTimestamps(client, sessionId, options = {}) {
  const home = options.homeDir || options.home || os.homedir();
  return combineResolved(client, sessionId, timestampsFromFile(client, sessionId, home), options);
}

function resolveSessionTimestampMap(refs, options = {}) {
  const home = options.homeDir || options.home || os.homedir();
  const out = new Map();
  const byClient = new Map();
  for (const ref of refs) {
    const client = String(ref?.client || '').trim();
    const sessionId = String(ref?.sessionId || ref?.session_id || '').trim();
    if (!client || !sessionId) continue;
    if (!byClient.has(client)) byClient.set(client, new Set());
    byClient.get(client).add(sessionId);
  }
  for (const [client, ids] of byClient) {
    if (client === 'claude' || client === 'codex') {
      const root = client === 'claude'
        ? path.join(home, '.claude', 'projects')
        : path.join(home, '.codex', 'sessions');
      const found = findSessionFiles(root, ids);
      if (client === 'claude') {
        const alt = findSessionFiles(path.join(home, '.claude', 'transcripts'), ids);
        for (const [id, filePath] of alt) if (!found.has(id)) found.set(id, filePath);
      }
      for (const sessionId of ids) {
        const filePath = found.get(sessionId);
        const fileStamps = filePath
          ? (() => {
            const range = jsonlTimeRange(filePath);
            const idTime = timestampFromSessionId(sessionId);
            return { startedAt: range.first || idTime || '', lastUsedAt: range.last || range.first || idTime || '' };
          })()
          : emptyTimestamps();
        out.set(`${client}:${sessionId}`, combineResolved(client, sessionId, fileStamps, options));
      }
      continue;
    }
    for (const sessionId of ids) {
      out.set(`${client}:${sessionId}`, resolveSessionTimestamps(client, sessionId, options));
    }
  }
  return out;
}

function loadJsonlManagerArchives(home = os.homedir()) {
  const archives = new Map();
  const indexPath = path.join(home, '.claude', 'projects', '.jsonl-manager-index', 'index.db');
  if (fs.existsSync(indexPath)) {
    let db;
    try {
      const Database = require('better-sqlite3');
      db = new Database(indexPath, { readonly: true, fileMustExist: true });
      const rows = db.prepare(`
        SELECT session_id, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts
        FROM seg
        WHERE session_id IS NOT NULL AND session_id != ''
        GROUP BY session_id
      `).all();
      for (const row of rows) {
        const startedAt = timestampFromJsonValue(row.first_ts);
        const lastUsedAt = timestampFromJsonValue(row.last_ts) || startedAt;
        if (!startedAt && !lastUsedAt) continue;
        const stamps = { startedAt, lastUsedAt };
        archives.set(row.session_id, stamps);
        for (const id of sessionIdCandidates(row.session_id)) archives.set(id, stamps);
      }
    } catch (_) {
      // Index may be locked or a different schema; file/id fallbacks still apply.
    } finally {
      try { db?.close(); } catch (_) { /* ignore */ }
    }
  }

  const recyclePath = path.join(home, '.claude', 'projects', '.jsonl-manager-recycle', 'sessions.json');
  if (fs.existsSync(recyclePath)) {
    try {
      const rows = JSON.parse(fs.readFileSync(recyclePath, 'utf8'));
      for (const row of (Array.isArray(rows) ? rows : [])) {
        const sid = String(row?.session_id || '').trim();
        if (!sid) continue;
        const idTime = timestampFromSessionId(row.trash_id || '') || timestampFromSessionId(sid);
        const mtime = typeof row.mtime === 'number'
          ? isoFromDate(row.mtime > 1e12 ? row.mtime : row.mtime * 1000)
          : '';
        const deletedAt = timestampFromJsonValue(row.deleted_at);
        const stamps = {
          startedAt: idTime || mtime || '',
          lastUsedAt: deletedAt || mtime || idTime || ''
        };
        if (!stamps.startedAt && !stamps.lastUsedAt) continue;
        const previous = archives.get(sid);
        const merged = mergeTimestamps(previous, stamps);
        archives.set(sid, merged);
        for (const id of sessionIdCandidates(sid)) archives.set(id, merged);
      }
    } catch (_) { /* ignore unreadable recycle meta */ }
  }
  return archives;
}

module.exports = {
  isoFromDate,
  jsonlTimeRange,
  lastJsonlTimestamp,
  loadJsonlManagerArchives,
  resolveSessionTimestamps,
  resolveSessionTimestampMap,
  timestampFromJsonLine,
  timestampFromSessionId
};
