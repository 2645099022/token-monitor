'use strict';

// Range queries over usage_daily. Days are local YYYY-MM-DD keys; both bounds
// are inclusive and optional.

const { costOf, priceTable } = require('./pricing');

function rangeClause(range = {}) {
  const where = [];
  const params = [];
  if (range.start) { where.push('day >= ?'); params.push(range.start); }
  if (range.end) { where.push('day <= ?'); params.push(range.end); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const SUMS = `
  SUM(input_tokens) AS input_tokens,
  SUM(cache_read) AS cache_read,
  SUM(cache_write) AS cache_write,
  SUM(output_tokens) AS output_tokens,
  SUM(reasoning_tokens) AS reasoning_tokens,
  SUM(total_tokens) AS total_tokens,
  SUM(official_cost_usd) AS official_cost_usd,
  SUM(message_count) AS message_count
`;

function withCost(rows, prices) {
  return rows.map((row) => ({ ...row, cost_usd: costOf(row, prices) }));
}

// One row per (client, session, model) with usage inside the range.
function sessionUsageInRange(db, range = {}) {
  const { sql, params } = rangeClause(range);
  const rows = db.prepare(`
    SELECT client, session_id, model, ${SUMS},
      COUNT(DISTINCT day) AS days,
      MIN(first_at) AS first_at,
      MAX(last_at) AS last_at,
      MAX(project_path) AS project_path
    FROM usage_daily ${sql}
    GROUP BY client, session_id, model
    ORDER BY last_at DESC
  `).all(...params);
  return withCost(rows, priceTable(db));
}

// One row per (day, client, model) — the per-day totals of the range.
function dailyTotals(db, range = {}) {
  const { sql, params } = rangeClause(range);
  const rows = db.prepare(`
    SELECT day, client, model, ${SUMS}
    FROM usage_daily ${sql}
    GROUP BY day, client, model
    ORDER BY day, client, model
  `).all(...params);
  return withCost(rows, priceTable(db));
}

module.exports = { dailyTotals, sessionUsageInRange };
