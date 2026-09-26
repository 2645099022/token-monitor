'use strict';

// Per-token prices for day-split cost.
//
// Cost is computed at query time from token buckets x unit price, so a price
// change (including a custom override) applies to all history without a
// re-import. Base rates come from `tokscale pricing <model> --json`, the same
// lookup tokscale uses (custom overrides, LiteLLM, OpenRouter, models.dev);
// the long-context tier rates of the matched row are read from tokscale's
// local catalog cache, since the command reports base rates only. Prices are
// cached in model_pricing. A client-reported cost (Grok) is used as is.
//
// costOf mirrors tokscale's compute_cost: a missing rate costs 0, and within a
// request the part of a bucket above a tier threshold is billed at that tier's
// rate. Provider-scoped row selection and request-wide tariffs are not
// reproduced; query.js anchors known sessions to tokscale's own cost instead.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { tokscaleConfigDir } = require('../tokscaleConfig');
const { TIER_BUCKETS } = require('./store');

const PRICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MISSING_RETRY_MS = 24 * 60 * 60 * 1000;

const CATALOG_FILES = {
  LiteLLM: 'pricing-litellm.json',
  OpenRouter: 'pricing-openrouter.json',
  'Models.dev': 'pricing-models-dev.json'
};
// Catalog field of each tier column, e.g. input_200k -> input_cost_per_token_above_200k_tokens.
const CATALOG_TIER_FIELD = {
  input: (k) => `input_cost_per_token_above_${k}k_tokens`,
  output: (k) => `output_cost_per_token_above_${k}k_tokens`,
  cache_read: (k) => `cache_read_input_token_cost_above_${k}k_tokens`,
  cache_write: (k) => `cache_creation_input_token_cost_above_${k}k_tokens`
};

function validRate(value) {
  const n = Number(value);
  return value != null && Number.isFinite(n) && n >= 0 ? n : null;
}

function parsePricingOutput(stdout) {
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');
  if (start < 0) return null;
  let json;
  try { json = JSON.parse(text.slice(start)); } catch (_) { return null; }
  const p = json?.pricing;
  const input = validRate(p?.inputCostPerToken);
  const output = validRate(p?.outputCostPerToken);
  if (input == null && output == null) return null;
  return {
    input,
    output,
    cache_read: validRate(p.cacheReadInputTokenCost),
    cache_write: validRate(p.cacheCreationInputTokenCost),
    matched_key: json.matchedKey || null,
    source: json.source || null
  };
}

function createCatalogReader(catalogDir) {
  const loaded = new Map();
  return (source, key) => {
    const file = CATALOG_FILES[source];
    if (!file || !key) return null;
    if (!loaded.has(file)) {
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(catalogDir, file), 'utf8')).data || null; } catch (_) { data = null; }
      loaded.set(file, data);
    }
    return loaded.get(file)?.[key] || null;
  };
}

function tierRates(entry) {
  const rates = {};
  for (const { bucket, thresholds } of TIER_BUCKETS) {
    for (const k of thresholds) rates[`${bucket}_${k}k`] = validRate(entry?.[CATALOG_TIER_FIELD[bucket](k)]);
  }
  return rates;
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
  const readCatalog = options.readCatalog
    || createCatalogReader(options.catalogDir || path.join(tokscaleConfigDir({ env: command.env || process.env }), 'cache'));
  const tierColumns = Object.keys(tierRates(null));
  const columns = ['input', 'output', 'cache_read', 'cache_write', 'matched_key', 'source', ...tierColumns];
  const upsert = db.prepare(`
    INSERT INTO model_pricing (model, ${columns.join(', ')}, status, fetched_at)
    VALUES (@model, ${columns.map((c) => `@${c}`).join(', ')}, @status, datetime('now'))
    ON CONFLICT(model) DO UPDATE SET
      ${[...columns, 'status', 'fetched_at'].map((c) => `${c} = excluded.${c}`).join(', ')}
  `);
  const empty = Object.fromEntries(columns.map((c) => [c, null]));
  let fetched = 0;
  let missing = 0;
  for (const model of modelsNeedingPrice(db, options.now)) {
    const price = lookup(model);
    if (price) {
      upsert.run({ ...empty, model, ...price, ...tierRates(readCatalog(price.source, price.matched_key)), status: 'ok' });
      fetched += 1;
    } else {
      upsert.run({ ...empty, model, status: 'missing' });
      missing += 1;
    }
  }
  return { fetched, missing };
}

function priceTable(db) {
  return new Map(db.prepare(`SELECT * FROM model_pricing WHERE status = 'ok'`).all().map((row) => [row.model, row]));
}

const BASE_RATE = { input: 'input', output: 'output', cache_read: 'cache_read', cache_write: 'cache_write' };
const ROW_TOKENS = { input: 'input_tokens', output: 'output_tokens', cache_read: 'cache_read', cache_write: 'cache_write' };

// Progressive walk over the tiers a row's excess columns recorded:
// base x all tokens + (tier - previous rate) x tokens above each threshold.
function bucketCost(row, price, { bucket, thresholds }) {
  const base = validRate(price[BASE_RATE[bucket]]) ?? 0;
  let cost = (row[ROW_TOKENS[bucket]] || 0) * base;
  let previous = base;
  for (const k of thresholds) {
    const rate = validRate(price[`${bucket}_${k}k`]);
    if (rate == null) continue;
    cost += (rate - previous) * (row[`x_${bucket}_${k}k`] || 0);
    previous = rate;
  }
  return cost;
}

// USD for one aggregated usage row, or null when the model has no price.
function costOf(row, prices) {
  if (row.official_cost_usd != null) return row.official_cost_usd;
  const price = prices.get(row.model);
  if (!price) return null;
  return TIER_BUCKETS.reduce((sum, bucket) => sum + bucketCost(row, price, bucket), 0);
}

module.exports = { costOf, lookupPrice, modelsNeedingPrice, parsePricingOutput, priceTable, refreshPricing, tierRates };
