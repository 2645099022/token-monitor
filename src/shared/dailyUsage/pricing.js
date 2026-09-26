'use strict';

// Per-token prices for day-split cost.
//
// Cost is computed at query time as tokens x unit price, so a price change
// (including a custom override) applies to all history without a re-import.
// Prices come from `tokscale pricing <model> --json`, the same lookup tokscale
// uses for its own cost (custom overrides, LiteLLM, OpenRouter, models.dev),
// and are cached in model_pricing. A client-reported cost (Grok) is used as is.
// Long-context tiers are not modelled: the base rate is applied to every
// request.

const { spawnSync } = require('node:child_process');

const PRICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MISSING_RETRY_MS = 24 * 60 * 60 * 1000;

function parsePricingOutput(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  let json;
  try { json = JSON.parse(text.slice(start)); } catch (_) { return null; }
  const p = json?.pricing;
  const input = Number(p?.inputCostPerToken);
  const output = Number(p?.outputCostPerToken);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  const optional = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  return {
    input: Number.isFinite(input) ? input : null,
    output: Number.isFinite(output) ? output : null,
    cache_read: optional(p.cacheReadInputTokenCost),
    cache_write: optional(p.cacheCreationInputTokenCost),
    matched_key: json.matchedKey || null,
    source: json.source || null
  };
}

function lookupPrice(model, command, spawn = spawnSync) {
  const result = spawn(command.bin, [...(command.prefixArgs || []), 'pricing', model, '--json', '--no-spinner'], {
    env: command.env,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) return null;
  return parsePricingOutput(result.stdout);
}

function modelsNeedingPrice(db, now = Date.now()) {
  const known = new Map(db.prepare('SELECT model, status, fetched_at FROM model_pricing').all()
    .map((row) => [row.model, row]));
  const models = db.prepare(`
    SELECT DISTINCT model FROM usage_daily
    WHERE official_cost_usd IS NULL AND model != ''
  `).all().map((row) => row.model);
  return models.filter((model) => {
    const row = known.get(model);
    if (!row) return true;
    const age = now - Date.parse(`${row.fetched_at}Z`);
    return row.status === 'ok' ? age > PRICE_MAX_AGE_MS : age > MISSING_RETRY_MS;
  });
}

function refreshPricing(db, command, options = {}) {
  if (!command?.bin) return { fetched: 0, missing: 0 };
  const lookup = options.lookup || ((model) => lookupPrice(model, command));
  const upsert = db.prepare(`
    INSERT INTO model_pricing (model, input, output, cache_read, cache_write, matched_key, source, status, fetched_at)
    VALUES (@model, @input, @output, @cache_read, @cache_write, @matched_key, @source, @status, datetime('now'))
    ON CONFLICT(model) DO UPDATE SET
      input = excluded.input, output = excluded.output,
      cache_read = excluded.cache_read, cache_write = excluded.cache_write,
      matched_key = excluded.matched_key, source = excluded.source,
      status = excluded.status, fetched_at = excluded.fetched_at
  `);
  let fetched = 0;
  let missing = 0;
  for (const model of modelsNeedingPrice(db, options.now)) {
    const price = lookup(model);
    if (price) {
      upsert.run({ model, ...price, status: 'ok' });
      fetched += 1;
    } else {
      upsert.run({ model, input: null, output: null, cache_read: null, cache_write: null, matched_key: null, source: null, status: 'missing' });
      missing += 1;
    }
  }
  return { fetched, missing };
}

function priceTable(db) {
  return new Map(db.prepare(`SELECT * FROM model_pricing WHERE status = 'ok'`).all().map((row) => [row.model, row]));
}

// USD for one aggregated usage row, or null when the model has no price.
function costOf(row, prices) {
  if (row.official_cost_usd != null) return row.official_cost_usd;
  const price = prices.get(row.model);
  if (!price) return null;
  const input = price.input ?? 0;
  return (row.input_tokens || 0) * input
    + (row.cache_read || 0) * (price.cache_read ?? input)
    + (row.cache_write || 0) * (price.cache_write ?? input)
    + (row.output_tokens || 0) * (price.output ?? 0);
}

module.exports = { costOf, lookupPrice, modelsNeedingPrice, parsePricingOutput, priceTable, refreshPricing };
