'use strict';

// Per-client transcript parsers for the day-split usage table.
//
// Every parser returns { events, projectPath } where each event is one billed
// unit (a model response, a turn, or a token_count delta) normalized to a
// common token shape:
//   input       uncached input
//   cacheRead   cached input read
//   cacheWrite  cache creation
//   output      output including any reasoning the client bills as output
//   reasoning   informational; already contained in `output`
//   total       input + cacheRead + cacheWrite + output
// `key` (optional) identifies an event that may be replayed into other files;
// the importer keeps only the first source that claims it. `officialCost` is
// set only when the client itself reports the billed USD amount.
//
// The rules below reproduce tokscale's per-session totals; see
// tests/shared/dailyUsage.test.js for the fixtures of each client format.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function shape({ input = 0, cacheRead = 0, cacheWrite = 0, output = 0, reasoning = 0, total = null }) {
  const event = {
    input: Math.max(0, Math.round(input)),
    cacheRead: Math.max(0, Math.round(cacheRead)),
    cacheWrite: Math.max(0, Math.round(cacheWrite)),
    output: Math.max(0, Math.round(output)),
    reasoning: Math.max(0, Math.round(reasoning))
  };
  event.total = total == null
    ? event.input + event.cacheRead + event.cacheWrite + event.output
    : Math.max(0, Math.round(total));
  return event;
}

async function* jsonLines(filePath, mustInclude) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (mustInclude && !line.includes(mustInclude)) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (obj && typeof obj === 'object') yield obj;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

// Claude Code writes one assistant message several times while streaming;
// only the largest usage of a message id + request id is final.
async function parseClaudeFile(filePath) {
  const byKey = new Map();
  const unkeyed = [];
  let projectPath = '';
  for await (const obj of jsonLines(filePath)) {
    if (!projectPath && typeof obj.cwd === 'string') projectPath = obj.cwd;
    const usage = obj.message?.usage;
    if (obj.type !== 'assistant' || !usage || !obj.sessionId) continue;
    const ts = Date.parse(obj.timestamp);
    if (!Number.isFinite(ts)) continue;
    const event = {
      sessionId: String(obj.sessionId),
      model: String(obj.message.model || ''),
      ts,
      ...shape({
        input: num(usage.input_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens),
        output: num(usage.output_tokens)
      })
    };
    const id = `${obj.message.id || ''}:${obj.requestId || ''}`;
    if (id === ':') { unkeyed.push({ ...event, key: null }); continue; }
    event.key = id;
    const prev = byKey.get(id);
    if (!prev || event.total > prev.total) byKey.set(id, event);
  }
  return { events: [...byKey.values(), ...unkeyed], projectPath };
}

// Codex rollouts carry cumulative token_count events. A resumed or forked
// rollout replays earlier events verbatim, so an event is identified by its
// (total, last) usage pair and counted once across all files. Events that do
// not move the running total are rate-limit refreshes, not new usage.
async function parseCodexFile(filePath) {
  const sessionId = path.basename(filePath, '.jsonl');
  const events = [];
  let projectPath = '';
  let model = '';
  let previousTotal = null;
  for await (const obj of jsonLines(filePath)) {
    const payload = obj.payload || {};
    if (obj.type === 'session_meta') {
      if (!projectPath && typeof payload.cwd === 'string') projectPath = payload.cwd;
      continue;
    }
    if (obj.type === 'turn_context') {
      if (payload.model) model = String(payload.model);
      continue;
    }
    if (obj.type !== 'event_msg' || payload.type !== 'token_count' || !payload.info) continue;
    const totalUsage = payload.info.total_token_usage;
    const last = payload.info.last_token_usage;
    if (!totalUsage || !last) continue;
    const runningTotal = num(totalUsage.total_tokens);
    if (runningTotal === previousTotal) continue;
    previousTotal = runningTotal;
    const ts = Date.parse(obj.timestamp);
    if (!Number.isFinite(ts)) continue;
    const cached = num(last.cached_input_tokens);
    const inputAll = num(last.input_tokens);
    const outputAll = num(last.output_tokens);
    events.push({
      sessionId,
      model,
      ts,
      key: crypto.createHash('sha1').update(JSON.stringify([totalUsage, last])).digest('hex'),
      ...shape({
        input: inputAll - cached,
        cacheRead: cached,
        output: outputAll,
        reasoning: num(last.reasoning_output_tokens),
        total: num(last.total_tokens) || inputAll + outputAll
      })
    });
  }
  return { events, projectPath };
}

function grokUsageEvents(sessionId, ts, usage) {
  const perModel = usage.modelUsage && typeof usage.modelUsage === 'object' && Object.keys(usage.modelUsage).length
    ? Object.entries(usage.modelUsage)
    : [[usage.primaryModelId || usage.model || '', usage]];
  return perModel.map(([model, u]) => {
    const cacheRead = num(u.cachedReadTokens);
    const cacheWrite = num(u.cacheCreationTokens);
    const inputAll = num(u.inputTokens);
    const ticks = Number(u.costUsdTicks);
    return {
      sessionId,
      model: String(model || ''),
      ts,
      key: null,
      // xAI reports cost in ticks of 1e-10 USD.
      officialCost: Number.isFinite(ticks) ? ticks / 1e10 : null,
      ...shape({
        input: inputAll - cacheRead - cacheWrite,
        cacheRead,
        cacheWrite,
        output: num(u.outputTokens),
        reasoning: num(u.reasoningTokens),
        total: num(u.totalTokens) || inputAll + num(u.outputTokens)
      })
    };
  });
}

function grokProjectPath(sessionDir) {
  const encoded = path.basename(path.dirname(sessionDir));
  try { return decodeURIComponent(encoded); } catch (_) { return ''; }
}

// Grok Build records every turn in updates.jsonl as a turn_completed update
// carrying that turn's usage and billed cost. usage.json holds the same turns,
// but only from the release that introduced it, so a session that spans the
// upgrade lists fewer turns there; it is read only when updates.jsonl is gone.
// ~/.grok/logs/unified.jsonl repeats the same work per inference and is not
// read. eventId is reused across turns, so a line is a duplicate only when its
// event, time and total all repeat.
async function parseGrokSession(sessionDir) {
  const sessionIdFromDir = path.basename(sessionDir);
  const projectPath = grokProjectPath(sessionDir);
  const updatesPath = path.join(sessionDir, 'updates.jsonl');
  if (fs.existsSync(updatesPath)) {
    const events = [];
    const seen = new Set();
    for await (const obj of jsonLines(updatesPath, 'turn_completed')) {
      const update = obj.params?.update;
      if (update?.sessionUpdate !== 'turn_completed' || !update.usage) continue;
      const seconds = Number(obj.timestamp);
      const ts = Number.isFinite(seconds) ? (seconds > 1e12 ? seconds : seconds * 1000) : NaN;
      if (!Number.isFinite(ts)) continue;
      const eventId = obj._meta?.eventId || obj.params?._meta?.eventId || '';
      const lineKey = `${eventId}|${ts}|${update.usage.totalTokens}`;
      if (seen.has(lineKey)) continue;
      seen.add(lineKey);
      events.push(...grokUsageEvents(String(obj.params.sessionId || sessionIdFromDir), ts, update.usage));
    }
    return { events, projectPath };
  }
  const usagePath = path.join(sessionDir, 'usage.json');
  const events = [];
  let ledger;
  try { ledger = JSON.parse(fs.readFileSync(usagePath, 'utf8')); } catch (_) { ledger = null; }
  if (ledger && Array.isArray(ledger.turns)) {
    const sessionId = String(ledger.sessionId || sessionIdFromDir);
    for (const turn of ledger.turns) {
      const ts = Date.parse(turn.endedAt);
      if (!Number.isFinite(ts)) continue;
      events.push(...grokUsageEvents(sessionId, ts, turn));
    }
  }
  return { events, projectPath };
}

// tokscale's Antigravity cache: one usage line per model response. Reasoning
// is already part of output there.
async function parseAntigravityFile(filePath) {
  const seen = new Set();
  const events = [];
  for await (const obj of jsonLines(filePath, '"usage"')) {
    if (obj.type !== 'usage' || !obj.sessionId) continue;
    if (obj.responseId) {
      if (seen.has(obj.responseId)) continue;
      seen.add(obj.responseId);
    }
    const ts = Number(obj.timestamp);
    if (!Number.isFinite(ts)) continue;
    events.push({
      sessionId: String(obj.sessionId),
      model: String(obj.modelId || ''),
      ts,
      key: null,
      ...shape({
        input: num(obj.input),
        cacheRead: num(obj.cacheRead),
        cacheWrite: num(obj.cacheWrite),
        output: num(obj.output),
        reasoning: num(obj.reasoning)
      })
    });
  }
  return { events, projectPath: '' };
}

const PARSERS = {
  claude: parseClaudeFile,
  codex: parseCodexFile,
  grok: parseGrokSession,
  antigravity: parseAntigravityFile
};

module.exports = {
  PARSERS,
  parseAntigravityFile,
  parseClaudeFile,
  parseCodexFile,
  parseGrokSession
};
