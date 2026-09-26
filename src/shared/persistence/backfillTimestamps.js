'use strict';

// One-shot / migrate helper: fill NULL usage_records timestamps from transcripts,
// jsonl-manager archives, or time encoded in the session id. Does not invent
// times from ingested_at.

const os = require('node:os');
const { loadJsonlManagerArchives, resolveSessionTimestampMap } = require('../sessionTimestamps');

function backfillMissingTimestamps(db, options = {}) {
  const home = options.homeDir || options.home || os.homedir();
  const rows = db.prepare(`
    SELECT DISTINCT client, session_id
    FROM usage_records
    WHERE IFNULL(started_at, '') = ''
       OR IFNULL(last_used_at, '') = ''
  `).all();
  if (rows.length === 0) return { scanned: 0, updated: 0, unresolved: 0 };

  const archives = options.archives || loadJsonlManagerArchives(home);
  const stampsByKey = resolveSessionTimestampMap(rows, { homeDir: home, archives });
  const update = db.prepare(`
    UPDATE usage_records
    SET started_at = CASE
          WHEN IFNULL(started_at, '') = '' THEN @started_at
          ELSE started_at
        END,
        last_used_at = CASE
          WHEN IFNULL(last_used_at, '') = '' THEN @last_used_at
          WHEN @last_used_at != '' AND @last_used_at > last_used_at THEN @last_used_at
          ELSE last_used_at
        END
    WHERE client = @client
      AND session_id = @session_id
      AND (
        IFNULL(started_at, '') = ''
        OR IFNULL(last_used_at, '') = ''
        OR (@last_used_at != '' AND @last_used_at > IFNULL(last_used_at, ''))
      )
  `);

  let updated = 0;
  let unresolved = 0;
  const apply = db.transaction((items) => {
    for (const row of items) {
      const stamps = stampsByKey.get(`${row.client}:${row.session_id}`) || {};
      if (!stamps.startedAt && !stamps.lastUsedAt) {
        unresolved += 1;
        continue;
      }
      const info = update.run({
        client: row.client,
        session_id: row.session_id,
        started_at: stamps.startedAt || null,
        last_used_at: stamps.lastUsedAt || stamps.startedAt || null
      });
      if (info.changes > 0) updated += info.changes;
    }
  });
  apply(rows);
  return { scanned: rows.length, updated, unresolved };
}

module.exports = { backfillMissingTimestamps };
