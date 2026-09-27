'use strict';

// Dated model prices for the day split.
//
// A day is billed at the price in effect on that day. Price versions come
// from three places; on the same start date the later one in this list wins:
//   catalog       price_versions: tokscale's catalog price, written each day
//                 it differs from the model's previous observation
//   announcement  ANNOUNCED_PRICES: published price changes that predate the
//                 catalog observations
//   user          price-history.json next to the database, edited by hand
// The version in effect on a day is the latest one starting on or before it;
// a day before every version uses the earliest one. A version marked backfill
// is the base price of every day: it replaces the earlier catalog and
// announced versions (a price that was wrong rather than changed), while
// user versions still apply from their own dates.
//
// A catalog price from tokscale's custom pricing (Settings > Custom model
// pricing, source "Custom") is such a base price: tokscale bills it on all
// history, so it is recorded as backfill and never raises a notice. When the
// override is removed its versions are voided, which restores the catalog
// timeline it had replaced.
//
// price-history.json:
//   {
//     "aliases":  { "some-model": "gpt-6-astra" },
//     "versions": [ { "model": "gpt-6-astra", "from": "2026-10-01",
//                     "input": 8, "output": 40, "cacheRead": 0.8 } ]
//   }
// Rates in the file and in ANNOUNCED_PRICES are USD per 1M tokens; the
// database stores USD per token. A rate a manual version leaves out is scaled
// from the current catalog price: missing base rates by the input ratio, tier
// rates by their bucket's ratio.
//
// Price aliases bill a model at another model's prices:
//   aliases          from price-history.json, always applied
//   fallbackAliases  the model aliases entered in Settings (a display
//                    merge), applied only to a model with no price of its
//                    own, since merged rows need not share a price. Aliases
//                    inferred by automatic grouping never price anything.

const fs = require('node:fs');
const { PRICING_TIER_COLUMNS, TIER_BUCKETS } = require('./store');

const PER_MILLION = 1e6;
const BASE_BUCKETS = ['input', 'output', 'cache_read', 'cache_write'];
const RATE_COLUMNS = [...BASE_BUCKETS, ...PRICING_TIER_COLUMNS];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_ALERT_PERCENT = 20;
const RANK = { catalog: 0, announcement: 1, user: 2 };
const EMPTY_CONFIG = Object.freeze({ aliases: Object.freeze({}), versions: Object.freeze([]) });

// Published API price changes; a model's first entry is its launch price.
// OpenAI 2026-07-30: Terra -20% and Luna -80%, permanent.
// OpenAI 2026-08-21: Sol promotional price, at least through 2026-11-21.
const ANNOUNCED_PRICES = [
  { model: 'gpt-5.6-sol', from: '2026-07-09', input: 5, cacheRead: 0.5, output: 30 },
  { model: 'gpt-5.6-sol', from: '2026-08-21', input: 4, cacheRead: 0.4, output: 20 },
  { model: 'gpt-5.6-terra', from: '2026-07-09', input: 2.5, cacheRead: 0.25, output: 15 },
  { model: 'gpt-5.6-terra', from: '2026-07-30', input: 2, cacheRead: 0.2, output: 12 },
  { model: 'gpt-5.6-luna', from: '2026-07-09', input: 1, cacheRead: 0.1, output: 6 },
  { model: 'gpt-5.6-luna', from: '2026-07-30', input: 0.2, cacheRead: 0.02, output: 1.2 }
];

function camelCase(column) {
  return column.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function perToken(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n / PER_MILLION : null;
}

// A version given in USD per 1M tokens, or null when it is unusable.
function manualVersion(entry, rank) {
  const model = typeof entry?.model === 'string' ? entry.model.trim() : '';
  if (!model || !DAY_RE.test(entry.from || '')) return null;
  const rates = {};
  for (const column of RATE_COLUMNS) rates[column] = perToken(entry[column] ?? entry[camelCase(column)]);
  if (BASE_BUCKETS.every((bucket) => rates[bucket] == null)) return null;
  return { model, from: entry.from, rank, backfill: entry.backfill === true, rates, partial: true };
}

const ANNOUNCED_VERSIONS = ANNOUNCED_PRICES.map((entry) => manualVersion(entry, RANK.announcement));

function normalizePriceConfig(json) {
  const aliases = {};
  for (const [from, to] of Object.entries(json?.aliases || {})) {
    const source = String(from).trim();
    const target = typeof to === 'string' ? to.trim() : '';
    if (source && target && source !== target) aliases[source] = target;
  }
  const versions = (Array.isArray(json?.versions) ? json.versions : [])
    .map((entry) => manualVersion(entry, RANK.user))
    .filter(Boolean);
  return { aliases, versions };
}

// The model-name key Settings aliases match on (renderer/modelAliases.js):
// case, '.', '_' and spaces do not tell two names apart.
function aliasMatchKey(model) {
  return String(model || '').trim().toLowerCase()
    .replace(/[._\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// A price config with the Settings model aliases added as fallbacks.
function withFallbackAliases(config, displayAliases) {
  const fallbackAliases = {};
  for (const [alias, canonical] of Object.entries(displayAliases || {})) {
    const key = aliasMatchKey(alias);
    const target = typeof canonical === 'string' ? canonical.trim() : '';
    if (key && target && key !== aliasMatchKey(target)) fallbackAliases[key] = target;
  }
  return { ...(config || EMPTY_CONFIG), fallbackAliases };
}

// The model whose price a model is billed at. hasOwnPrice(model) tells
// whether the model can be priced under its own name.
function priceKeyResolver(config, hasOwnPrice) {
  const aliases = config?.aliases || {};
  const fallback = config?.fallbackAliases || {};
  return (model) => {
    if (aliases[model]) return aliases[model];
    const target = fallback[aliasMatchKey(model)];
    return target && !hasOwnPrice(model) ? target : model;
  };
}

const configCache = new Map();
// Windows editors may save the file with a byte order mark.
const BOM = String.fromCharCode(0xfeff);

// price-history.json, re-read only when it changes. A missing file is an
// empty config; an unreadable one is empty too and carries the error.
function loadPriceConfig(filePath) {
  if (!filePath) return EMPTY_CONFIG;
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return EMPTY_CONFIG; }
  const cached = configCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
  let value;
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    value = normalizePriceConfig(JSON.parse(text.startsWith(BOM) ? text.slice(1) : text));
  } catch (error) {
    value = { ...EMPTY_CONFIG, error: error.message };
  }
  configCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

function pickRates(row) {
  const rates = {};
  for (const column of RATE_COLUMNS) rates[column] = row?.[column] ?? null;
  return rates;
}

function ratio(value, base) {
  return value != null && base > 0 ? value / base : null;
}

function completeRates(rates, reference) {
  if (!reference) return rates;
  const out = { ...rates };
  const inputRatio = ratio(out.input, reference.input);
  for (const bucket of BASE_BUCKETS) {
    if (out[bucket] == null && reference[bucket] != null && inputRatio != null) out[bucket] = reference[bucket] * inputRatio;
  }
  for (const { bucket, thresholds } of TIER_BUCKETS) {
    const bucketRatio = ratio(out[bucket], reference[bucket]);
    for (const k of thresholds) {
      const column = `${bucket}_${k}k`;
      if (out[column] == null && bucketRatio != null && reference[column] != null) out[column] = reference[column] * bucketRatio;
    }
  }
  return out;
}

function pushTo(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

// Prices by model and day. key() maps a model to the model it is priced as;
// current() is the catalog price tokscale bills today, on() the price in
// effect on a day. Both return rate rows (USD per token) or null.
function createPriceBook(db, config = EMPTY_CONFIG) {
  const current = new Map(db.prepare(`SELECT * FROM model_pricing WHERE status = 'ok'`).all()
    .map((row) => [row.model, row]));
  const catalog = new Map();
  for (const row of db.prepare(`SELECT * FROM price_versions WHERE status = 'active'`).all()) {
    pushTo(catalog, row.model, { from: row.effective_from, rank: RANK.catalog, backfill: row.backfill === 1, rates: pickRates(row) });
  }
  const manual = new Map();
  for (const version of [...ANNOUNCED_VERSIONS, ...(config?.versions || [])]) pushTo(manual, version.model, version);

  const key = priceKeyResolver(config, (model) => current.has(model) || catalog.has(model) || manual.has(model));
  const timelines = new Map();
  function timeline(priceKey) {
    if (timelines.has(priceKey)) return timelines.get(priceKey);
    const observed = catalog.get(priceKey) || [];
    const reference = current.get(priceKey) || observed.reduce((latest, v) => (!latest || v.from > latest.from ? v : latest), null)?.rates || null;
    const list = [
      ...observed,
      ...(manual.get(priceKey) || []).map((version) => ({ ...version, rates: completeRates(version.rates, reference) }))
    ].sort((a, b) => a.from.localeCompare(b.from) || a.rank - b.rank);
    let base = -1;
    list.forEach((version, index) => { if (version.backfill) base = index; });
    const result = base < 0 ? list : [
      { ...list[base], from: '' },
      ...list.filter((version, index) => index > base || (index < base && version.rank === RANK.user))
    ].sort((a, b) => a.from.localeCompare(b.from) || a.rank - b.rank);
    timelines.set(priceKey, result);
    return result;
  }

  return {
    key,
    current(model) {
      return current.get(key(model)) || null;
    },
    on(model, day) {
      const list = timeline(key(model));
      if (list.length === 0 || !day) return current.get(key(model)) || null;
      let chosen = list[0];
      for (const version of list) {
        if (version.from > day) break;
        chosen = version;
      }
      return chosen.rates;
    }
  };
}

function closeRate(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) <= 1e-15 + Math.abs(b) * 1e-9;
}

function sameRates(a, b) {
  return RATE_COLUMNS.every((column) => closeRate(a?.[column] ?? null, b?.[column] ?? null));
}

// Largest relative change of a base rate, in percent; a rate that appears or
// disappears counts as 100.
function changePercent(previous, next) {
  let max = 0;
  for (const bucket of BASE_BUCKETS) {
    const a = previous?.[bucket];
    const b = next?.[bucket];
    if (a > 0 && b > 0) max = Math.max(max, Math.abs(b / a - 1) * 100);
    else if ((a > 0) !== (b > 0)) max = Math.max(max, 100);
  }
  return max;
}

const CUSTOM_SOURCE_SQL = `LOWER(IFNULL(source, '')) = 'custom'`;

function isCustomSource(source) {
  return String(source || '').toLowerCase() === 'custom';
}

function latestVersion(db, model, { activeOnly = false, custom = false } = {}) {
  return db.prepare(`
    SELECT * FROM price_versions
    WHERE model = ? ${activeOnly ? `AND status = 'active'` : ''} AND ${custom ? '' : 'NOT '}${CUSTOM_SOURCE_SQL}
    ORDER BY observed_on DESC, effective_from DESC LIMIT 1
  `).get(model);
}

function writeVersion(db, row) {
  db.prepare(`
    INSERT INTO price_versions (model, effective_from, observed_on, matched_key, source, change_pct, notice, backfill, ${RATE_COLUMNS.join(', ')})
    VALUES (@model, @effective_from, @observed_on, @matched_key, @source, @change_pct, @notice, @backfill, ${RATE_COLUMNS.map((c) => `@${c}`).join(', ')})
    ON CONFLICT(model, effective_from) DO UPDATE SET
      ${[...RATE_COLUMNS, 'matched_key', 'source', 'observed_on', 'change_pct', 'backfill'].map((c) => `${c} = excluded.${c}`).join(', ')},
      status = 'active',
      notice = CASE WHEN excluded.notice = 'pending' OR price_versions.notice = 'pending' THEN 'pending' ELSE price_versions.notice END
  `).run(row);
}

// Records today's catalog price of a model when it differs from the previous
// observation. A change of at least alertPercent is flagged for review, since
// a catalog can lag the real change or carry a transient error. Custom
// pricing is handled apart: see the note at the top.
function recordCatalogPrice(db, model, price, { day, alertPercent = DEFAULT_ALERT_PERCENT } = {}) {
  if (!model || !DAY_RE.test(day || '')) return null;
  const custom = isCustomSource(price.source);
  const row = {
    model,
    effective_from: day,
    observed_on: day,
    matched_key: price.matched_key ?? null,
    source: price.source ?? null,
    change_pct: null,
    notice: null,
    backfill: custom ? 1 : 0
  };
  for (const column of RATE_COLUMNS) row[column] = price[column] ?? null;

  if (custom) {
    const override = latestVersion(db, model, { activeOnly: true, custom: true });
    if (override && sameRates(override, price)) return null;
    writeVersion(db, row);
    return { model, changePct: null, notice: null };
  }

  // The override is gone: drop it and fall back to the catalog timeline.
  db.prepare(`UPDATE price_versions SET status = 'void' WHERE model = ? AND status = 'active' AND ${CUSTOM_SOURCE_SQL}`).run(model);
  const latest = latestVersion(db, model);
  if (latest && sameRates(latest, price)) return null;
  const active = latestVersion(db, model, { activeOnly: true });
  // Back to the price in effect before a version the user voided.
  if (active && latest.status !== 'active' && sameRates(active, price)) return null;
  const previous = active || latest;
  row.change_pct = previous ? changePercent(previous, price) : null;
  row.notice = row.change_pct != null && row.change_pct >= Number(alertPercent) - 1e-9 ? 'pending' : null;
  writeVersion(db, row);
  return { model, changePct: row.change_pct, notice: row.notice };
}

// A new price-history.json: the help lines and an example (keys starting
// with '_' are not read) above empty aliases and versions.
function priceConfigTemplate(helpLines = []) {
  return `${JSON.stringify({
    _help: helpLines,
    _example: {
      aliases: { 'proxy-model-name': 'gpt-6-astra' },
      versions: [
        { model: 'gpt-5.6-sol', from: '2026-11-22', input: 5, output: 30, cacheRead: 0.5 },
        { model: 'some-model', from: '2026-09-01', input: 1, output: 4, backfill: true }
      ]
    },
    aliases: {},
    versions: []
  }, null, 2)}\n`;
}

function perMillionRates(row) {
  if (!row) return null;
  const rate = (value) => (value == null ? null : Math.round(value * PER_MILLION * 1e6) / 1e6);
  return { input: rate(row.input), output: rate(row.output), cacheRead: rate(row.cache_read), cacheWrite: rate(row.cache_write) };
}

function previousActiveVersion(db, model, effectiveFrom) {
  return db.prepare(`
    SELECT * FROM price_versions
    WHERE model = ? AND status = 'active' AND effective_from < ?
    ORDER BY effective_from DESC LIMIT 1
  `).get(model, effectiveFrom);
}

// Catalog price changes waiting for review, oldest first. earliestFrom is the
// first date the change may be moved back to: the day after the version
// before it.
function pendingPriceNotices(db) {
  return db.prepare(`SELECT * FROM price_versions WHERE notice = 'pending' ORDER BY observed_on, model`).all().map((row) => {
    const previous = previousActiveVersion(db, row.model, row.effective_from);
    return {
      model: row.model,
      effectiveFrom: row.effective_from,
      observedOn: row.observed_on,
      changePct: row.change_pct,
      earliestFrom: previous ? addDays(previous.effective_from, 1) : '',
      before: perMillionRates(previous),
      after: perMillionRates(row)
    };
  });
}

function addDays(day, count) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

// Settles a flagged change:
//   confirm   keep it from the day it was observed
//   redate    it took effect on `date` (after the previous version, not after
//             the observation)
//   void      the catalog was wrong; keep billing the previous price
//   backfill  the previous price was wrong; bill all history at this one
function resolvePriceNotice(db, { model, effectiveFrom, action, date } = {}) {
  const row = db.prepare(`SELECT * FROM price_versions WHERE model = ? AND effective_from = ?`).get(model, effectiveFrom);
  if (!row) return { ok: false, reason: 'not-found' };
  const settle = (sql, ...params) => db.prepare(`UPDATE price_versions SET ${sql}, notice = 'resolved' WHERE model = ? AND effective_from = ?`)
    .run(...params, model, effectiveFrom);
  if (action === 'confirm') settle(`status = 'active'`);
  else if (action === 'void') settle(`status = 'void'`);
  else if (action === 'backfill') settle(`status = 'active', backfill = 1`);
  else if (action === 'redate') {
    const previous = previousActiveVersion(db, model, effectiveFrom);
    if (!DAY_RE.test(date || '') || date > row.observed_on || (previous && date <= previous.effective_from)) {
      return { ok: false, reason: 'invalid-date' };
    }
    db.transaction(() => {
      if (date !== effectiveFrom) {
        // Only a voided version can sit between the previous one and this.
        db.prepare(`DELETE FROM price_versions WHERE model = ? AND effective_from = ? AND status = 'void'`).run(model, date);
        db.prepare(`UPDATE price_versions SET effective_from = ? WHERE model = ? AND effective_from = ?`).run(date, model, effectiveFrom);
      }
      db.prepare(`UPDATE price_versions SET status = 'active', notice = 'resolved' WHERE model = ? AND effective_from = ?`).run(model, date);
    })();
  } else {
    return { ok: false, reason: 'invalid-action' };
  }
  return { ok: true };
}

module.exports = {
  ANNOUNCED_PRICES,
  DEFAULT_ALERT_PERCENT,
  EMPTY_CONFIG,
  RATE_COLUMNS,
  aliasMatchKey,
  changePercent,
  createPriceBook,
  loadPriceConfig,
  normalizePriceConfig,
  pendingPriceNotices,
  priceConfigTemplate,
  priceKeyResolver,
  recordCatalogPrice,
  resolvePriceNotice,
  withFallbackAliases
};
