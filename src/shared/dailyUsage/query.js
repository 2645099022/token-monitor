'use strict';

// Range queries over usage_daily. Days are local YYYY-MM-DD keys; both bounds
// are inclusive and optional.
//
// Cost of a row, in order of precedence:
//   official  the client reported the billed amount (Grok)
//   tokscale  the session is in usage_records with the same token total: its
//             tokscale cost is spread over the days by each day's price-based
//             weight, so session totals equal the rest of the app while the
//             day split follows where the usage happened
//   price     tokens x unit price (sessions tokscale never saw)
// null means no price is known.

const { costOf, priceTable } = require('./pricing');
const { TIER_EXCESS_COLUMNS } = require('./store');

// A session anchors to tokscale only when both count the same usage.
const ANCHOR_TOKEN_TOLERANCE = 0.01;

function groupKey(row) {
  return `${row.client}\u0000${row.session_id}\u0000${row.model || ''}`;
}

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
  SUM(message_count) AS message_count,
  ${TIER_EXCESS_COLUMNS.map((column) => `SUM(${column}) AS ${column}`).join(',\n  ')}
`;

// Per (client, session, model): how to turn a row into its share of the
// session's tokscale cost.
function tokscaleAnchors(db, prices) {
  const tokscale = new Map(db.prepare(`
    SELECT client, session_id, IFNULL(model, '') AS model, SUM(cost_usd) AS cost, SUM(total_tokens) AS tokens
    FROM usage_records
    GROUP BY client, session_id, IFNULL(model, '')
  `).all().map((row) => [groupKey(row), row]));
  const lifetime = db.prepare(`
    SELECT client, session_id, model, ${SUMS}
    FROM usage_daily
    GROUP BY client, session_id, model
  `).all();
  const anchors = new Map();
  for (const row of lifetime) {
    if (row.official_cost_usd != null) continue;
    const reference = tokscale.get(groupKey(row));
    if (!reference || !(reference.cost > 0) || !(reference.tokens > 0)) continue;
    if (Math.abs(row.total_tokens / reference.tokens - 1) > ANCHOR_TOKEN_TOLERANCE) continue;
    const weight = costOf(row, prices);
    anchors.set(groupKey(row), weight > 0
      ? { perWeight: reference.cost / weight }
      : { perToken: reference.cost / row.total_tokens });
  }
  return anchors;
}

function pricedRow(row, prices, anchors) {
  if (row.official_cost_usd != null) return { ...row, cost_usd: row.official_cost_usd, cost_source: 'official' };
  const anchor = anchors.get(groupKey(row));
  const weight = costOf(row, prices);
  if (anchor) {
    const cost = anchor.perWeight != null ? weight * anchor.perWeight : (row.total_tokens || 0) * anchor.perToken;
    return { ...row, cost_usd: cost, cost_source: 'tokscale' };
  }
  return { ...row, cost_usd: weight, cost_source: weight == null ? null : 'price' };
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
  const prices = priceTable(db);
  const anchors = tokscaleAnchors(db, prices);
  return rows.map((row) => pricedRow(row, prices, anchors));
}

const TOTAL_FIELDS = ['input_tokens', 'cache_read', 'cache_write', 'output_tokens', 'reasoning_tokens', 'total_tokens', 'message_count'];

// One row per (day, client, model) — the per-day totals of the range. Cost is
// priced per session first, since each session carries its own anchor.
function dailyTotals(db, range = {}) {
  const { sql, params } = rangeClause(range);
  const rows = db.prepare(`
    SELECT day, client, session_id, model, ${SUMS}
    FROM usage_daily ${sql}
    GROUP BY day, client, session_id, model
  `).all(...params);
  const prices = priceTable(db);
  const anchors = tokscaleAnchors(db, prices);
  const totals = new Map();
  for (const row of rows.map((r) => pricedRow(r, prices, anchors))) {
    const key = `${row.day}\u0000${row.client}\u0000${row.model}`;
    let total = totals.get(key);
    if (!total) {
      total = { day: row.day, client: row.client, model: row.model, cost_usd: null, unpriced_tokens: 0 };
      for (const field of TOTAL_FIELDS) total[field] = 0;
      totals.set(key, total);
    }
    for (const field of TOTAL_FIELDS) total[field] += row[field] || 0;
    if (row.cost_usd == null) total.unpriced_tokens += row.total_tokens || 0;
    else total.cost_usd = (total.cost_usd || 0) + row.cost_usd;
  }
  return [...totals.values()].sort((a, b) =>
    a.day.localeCompare(b.day) || a.client.localeCompare(b.client) || a.model.localeCompare(b.model));
}

module.exports = { dailyTotals, sessionUsageInRange };
