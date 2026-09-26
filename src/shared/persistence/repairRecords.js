'use strict';

// One-shot repair for usage_records written before schema v4:
// - total_tokens was stored as 0 because tokscale rows carry only components;
//   it is recomputed from the stored source payload.
// - One conversation could be split into several rows when two sources
//   reported slightly different starts; rows of one (client, session, model)
//   whose lifetimes overlap are merged back into a single instance.

const { rowToRecord, INSTANCE_SLACK_MS } = require('./recordWriter');

function parseTs(value) {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : NaN;
}

function recomputeTotals(db) {
  const rows = db.prepare(`
    SELECT id, client, session_id, source_payload
    FROM usage_records
    WHERE source_payload IS NOT NULL
  `).all();
  const update = db.prepare('UPDATE usage_records SET total_tokens = ? WHERE id = ?');
  let changed = 0;
  for (const row of rows) {
    let payload;
    try { payload = JSON.parse(row.source_payload); } catch (_) { continue; }
    const rec = rowToRecord(payload, row.client, row.session_id);
    if (!rec) continue;
    changed += update.run(rec.total_tokens, row.id).changes;
  }
  return changed;
}

// Groups rows into instances: a row starting no later than the current
// instance's end (plus slack) belongs to it; rows without a start join the
// most recent instance.
function clusterInstances(rows, slackMs = INSTANCE_SLACK_MS) {
  const dated = rows.filter((row) => Number.isFinite(parseTs(row.started_at)))
    .sort((a, b) => parseTs(a.started_at) - parseTs(b.started_at) || a.id - b.id);
  const undated = rows.filter((row) => !Number.isFinite(parseTs(row.started_at)));
  const clusters = [];
  for (const row of dated) {
    const start = parseTs(row.started_at);
    const end = Math.max(start, parseTs(row.last_used_at) || start);
    const current = clusters[clusters.length - 1];
    if (current && start <= current.end + slackMs) {
      current.rows.push(row);
      current.end = Math.max(current.end, end);
    } else {
      clusters.push({ rows: [row], end });
    }
  }
  if (undated.length) {
    if (clusters.length) clusters[clusters.length - 1].rows.push(...undated);
    else clusters.push({ rows: undated, end: -Infinity });
  }
  return clusters.map((cluster) => cluster.rows);
}

function earliest(values) {
  return values.filter((v) => Number.isFinite(parseTs(v)))
    .sort((a, b) => parseTs(a) - parseTs(b))[0] || null;
}

function latest(values) {
  return values.filter((v) => Number.isFinite(parseTs(v)))
    .sort((a, b) => parseTs(b) - parseTs(a))[0] || null;
}

function mergeOverlappingInstances(db, slackMs = INSTANCE_SLACK_MS) {
  const groups = db.prepare(`
    SELECT client, session_id, IFNULL(model, '') AS model_key
    FROM usage_records
    GROUP BY client, session_id, IFNULL(model, '')
    HAVING COUNT(*) > 1
  `).all();
  const selectGroup = db.prepare(`
    SELECT id, started_at, last_used_at, ingested_at, scan_count
    FROM usage_records
    WHERE client = ? AND session_id = ? AND IFNULL(model, '') = ?
  `);
  const deleteRow = db.prepare('DELETE FROM usage_records WHERE id = ?');
  const updateKeeper = db.prepare(`
    UPDATE usage_records
    SET started_at = ?, last_used_at = ?, scan_count = ?
    WHERE id = ?
  `);
  let removed = 0;
  for (const group of groups) {
    const rows = selectGroup.all(group.client, group.session_id, group.model_key);
    for (const cluster of clusterInstances(rows, slackMs)) {
      if (cluster.length < 2) continue;
      // The most recently ingested row carries the latest cumulative totals.
      const keeper = cluster.slice().sort((a, b) =>
        String(b.ingested_at || '').localeCompare(String(a.ingested_at || '')) || b.id - a.id)[0];
      // Delete first: the unique index includes started_at, and the keeper
      // may take over a start value that one of the removed rows holds.
      for (const row of cluster) {
        if (row.id !== keeper.id) removed += deleteRow.run(row.id).changes;
      }
      updateKeeper.run(
        earliest(cluster.map((row) => row.started_at)),
        latest(cluster.map((row) => row.last_used_at)),
        cluster.reduce((sum, row) => sum + (row.scan_count || 0), 0),
        keeper.id
      );
    }
  }
  return removed;
}

function repairUsageRecords(db) {
  return db.transaction(() => ({
    removedDuplicates: mergeOverlappingInstances(db),
    recomputedTotals: recomputeTotals(db)
  }))();
}

module.exports = { clusterInstances, mergeOverlappingInstances, recomputeTotals, repairUsageRecords };
