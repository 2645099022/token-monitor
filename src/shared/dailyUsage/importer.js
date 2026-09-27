'use strict';

// Incremental import of transcripts into usage_daily.
//
// A source is re-parsed only when its chosen copy, size, or mtime changed, or
// when PARSER_VERSION moves (which rebuilds everything, because the parse
// rules changed). Rows of a source whose transcript disappeared are kept: the
// table is also the history of deleted sessions.
//
// Replayed events (Codex resume/fork, Claude copies) are owned by the first
// source that claims them. Changed sources are therefore written in order of
// their earliest event, so an original transcript claims its events before a
// later file that replays them.

const { PARSERS } = require('./parsers');
const { discoverSources } = require('./sources');
const { createDailyStore } = require('./store');

// Bump when a parser's counting rule changes; forces a full rebuild.
const PARSER_VERSION = 4;

function sourceChanged(source, registered) {
  if (!registered) return true;
  return registered.parser_version !== PARSER_VERSION
    || registered.path !== source.path
    || Number(registered.size) !== Number(source.size)
    || Number(registered.mtime_ms) !== Number(source.mtimeMs);
}

async function importDailyUsage(db, roots, options = {}) {
  const store = createDailyStore(db);
  const log = options.log || (() => {});
  let registered = store.registeredSources();
  const staleVersion = [...registered.values()].some((row) => row.parser_version !== PARSER_VERSION);
  if (staleVersion) {
    store.resetDerived();
    registered = new Map();
    log(`[daily-usage] parser version ${PARSER_VERSION}: rebuilding`);
  }

  const sources = discoverSources(roots);
  const changed = [...sources.values()].filter((source) => sourceChanged(source, registered.get(source.sourceKey)));

  const parsed = [];
  let failed = 0;
  for (const source of changed) {
    try {
      const result = await PARSERS[source.client](source.path);
      const firstTs = result.events.reduce((min, event) => Math.min(min, event.ts), Infinity);
      parsed.push({ source, result, firstTs });
    } catch (error) {
      failed += 1;
      log(`[daily-usage] parse failed ${source.sourceKey}: ${error.message}`);
    }
  }
  parsed.sort((a, b) => a.firstTs - b.firstTs || a.source.sourceKey.localeCompare(b.source.sourceKey));

  let events = 0;
  for (const { source, result } of parsed) {
    events += store.replaceSource(source, result, PARSER_VERSION);
  }
  return { discovered: sources.size, parsed: parsed.length, failed, events, rebuilt: staleVersion };
}

module.exports = { PARSER_VERSION, importDailyUsage };
