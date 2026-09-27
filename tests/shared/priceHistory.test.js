'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb } = require('../../src/shared/persistence/db');
const { refreshPricing } = require('../../src/shared/dailyUsage/pricing');
const { sessionUsageInRange, dailyTotals } = require('../../src/shared/dailyUsage/query');
const {
  createPriceBook, loadPriceConfig, normalizePriceConfig, pendingPriceNotices, recordCatalogPrice, resolvePriceNotice,
  withFallbackAliases
} = require('../../src/shared/dailyUsage/priceHistory');

const M = 1e-6;

function rates(input, output, cacheRead = null) {
  return { input: input * M, output: output * M, cache_read: cacheRead == null ? null : cacheRead * M, cache_write: null };
}

function versions(db, model) {
  return db.prepare(`SELECT effective_from, status, notice, change_pct FROM price_versions WHERE model = ? ORDER BY effective_from`).all(model);
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test('catalog prices: a version is written only on change, and large changes wait for review', () => {
  const db = openDb(':memory:');
  try {
    assert.equal(recordCatalogPrice(db, 'm', rates(4, 20), { day: '2026-09-01' }).notice, null);
    assert.equal(recordCatalogPrice(db, 'm', rates(4, 20), { day: '2026-09-02' }), null);
    // 10% is below the 20% default: recorded silently.
    assert.equal(recordCatalogPrice(db, 'm', rates(4.4, 22), { day: '2026-09-03' }).notice, null);
    const big = recordCatalogPrice(db, 'm', rates(4.4, 33), { day: '2026-09-04' });
    assert.equal(big.notice, 'pending');
    close(big.changePct, 50);
    assert.deepEqual(versions(db, 'm').map((v) => [v.effective_from, v.notice]), [
      ['2026-09-01', null], ['2026-09-03', null], ['2026-09-04', 'pending']
    ]);
    // A threshold of exactly the change still alerts.
    assert.equal(recordCatalogPrice(db, 'n', rates(2.5, 15), { day: '2026-07-01' }).notice, null);
    assert.equal(recordCatalogPrice(db, 'n', rates(2, 12), { day: '2026-07-30', alertPercent: 20 }).notice, 'pending');
  } finally { db.close(); }
});

test('catalog prices: a voided glitch is neither re-alerted nor recorded when the price returns', () => {
  const db = openDb(':memory:');
  try {
    recordCatalogPrice(db, 'm', rates(4, 20), { day: '2026-09-01' });
    recordCatalogPrice(db, 'm', rates(2, 10), { day: '2026-09-05' });
    assert.deepEqual(resolvePriceNotice(db, { model: 'm', effectiveFrom: '2026-09-05', action: 'void' }), { ok: true });
    assert.equal(recordCatalogPrice(db, 'm', rates(2, 10), { day: '2026-09-06' }), null);
    assert.equal(recordCatalogPrice(db, 'm', rates(4, 20), { day: '2026-09-07' }), null);
    assert.deepEqual(pendingPriceNotices(db), []);
    const book = createPriceBook(db);
    close(book.on('m', '2026-09-05').input, 4 * M);
  } finally { db.close(); }
});

test('price book: each day uses the latest version starting on or before it', () => {
  const db = openDb(':memory:');
  try {
    db.prepare(`INSERT INTO model_pricing (model, input, output, status) VALUES ('m', ?, ?, 'ok')`).run(5 * M, 30 * M);
    recordCatalogPrice(db, 'm', rates(4, 20), { day: '2026-08-10' });
    recordCatalogPrice(db, 'm', rates(5, 30), { day: '2026-11-22' });
    const book = createPriceBook(db);
    // Before every version: the earliest one.
    close(book.on('m', '2026-01-01').output, 20 * M);
    close(book.on('m', '2026-11-21').output, 20 * M);
    close(book.on('m', '2026-11-22').output, 30 * M);
    close(book.current('m').output, 30 * M);
    assert.equal(book.on('unpriced', '2026-09-01'), null);
  } finally { db.close(); }
});

test('price book: announcements and user versions, with missing rates scaled from the catalog', () => {
  const db = openDb(':memory:');
  try {
    db.prepare(`INSERT INTO model_pricing (model, input, output, cache_read, input_272k, status) VALUES ('gpt-5.6-sol', ?, ?, ?, ?, 'ok')`)
      .run(4 * M, 20 * M, 0.4 * M, 8 * M);
    recordCatalogPrice(db, 'gpt-5.6-sol', { ...rates(4, 20, 0.4), input_272k: 8 * M }, { day: '2026-09-27' });
    const config = normalizePriceConfig({
      versions: [
        { model: 'gpt-5.6-sol', from: '2026-11-21', input: 5, output: 30 },
        { model: 'bad', from: 'soon', input: 1 },
        { model: 'empty', from: '2026-01-01' }
      ]
    });
    assert.equal(config.versions.length, 1);
    const book = createPriceBook(db, config);
    // Announced launch price, then the promotional price.
    close(book.on('gpt-5.6-sol', '2026-07-20').output, 30 * M);
    close(book.on('gpt-5.6-sol', '2026-07-20').input_272k, 10 * M);
    close(book.on('gpt-5.6-sol', '2026-08-21').output, 20 * M);
    close(book.on('gpt-5.6-sol', '2026-10-01').output, 20 * M);
    // The user version leaves cache read out: scaled by its input ratio.
    const later = book.on('gpt-5.6-sol', '2026-12-01');
    close(later.output, 30 * M);
    close(later.cache_read, 0.5 * M);
    close(later.input_272k, 10 * M);
  } finally { db.close(); }
});

test('price book: aliases bill at the target model, and backfill replaces all earlier history', () => {
  const db = openDb(':memory:');
  try {
    db.prepare(`INSERT INTO model_pricing (model, input, output, status) VALUES ('gpt-6-astra', ?, ?, 'ok')`).run(10 * M, 50 * M);
    recordCatalogPrice(db, 'gpt-6-astra', rates(10, 50), { day: '2026-09-01' });
    recordCatalogPrice(db, 'gpt-6-astra', rates(8, 40), { day: '2026-10-01' });
    const book = createPriceBook(db, normalizePriceConfig({ aliases: { 'zpt-6': 'gpt-6-astra' } }));
    assert.equal(book.key('zpt-6'), 'gpt-6-astra');
    close(book.on('zpt-6', '2026-09-05').output, 50 * M);

    assert.deepEqual(resolvePriceNotice(db, { model: 'gpt-6-astra', effectiveFrom: '2026-10-01', action: 'backfill' }), { ok: true });
    close(createPriceBook(db).on('gpt-6-astra', '2026-09-05').output, 40 * M);
  } finally { db.close(); }
});

test('price book: Settings aliases price only a model without a price of its own', () => {
  const db = openDb(':memory:');
  try {
    db.prepare(`INSERT INTO model_pricing (model, input, output, status) VALUES ('gpt-6-astra', ?, ?, 'ok')`).run(10 * M, 50 * M);
    db.prepare(`INSERT INTO model_pricing (model, input, output, status) VALUES ('grok-4.5', ?, ?, 'ok')`).run(2 * M, 6 * M);
    db.prepare(`INSERT INTO model_pricing (model, input, output, status) VALUES ('grok-4.5-build-free', 0, 0, 'ok')`).run();
    db.prepare(`INSERT INTO model_pricing (model, status) VALUES ('zpt-6', 'missing')`).run();
    const config = withFallbackAliases(normalizePriceConfig({}), {
      'ZPT_6': 'gpt-6-astra',
      'grok-4.5-build-free': 'grok-4.5'
    });
    const book = createPriceBook(db, config);
    // Matched the way Settings aliases match: case and '_' do not matter.
    assert.equal(book.key('zpt-6'), 'gpt-6-astra');
    close(book.on('zpt-6', '2026-09-05').output, 50 * M);
    // Has its own (free) price: only merged for display.
    assert.equal(book.key('grok-4.5-build-free'), 'grok-4.5-build-free');
    assert.equal(book.on('grok-4.5-build-free', '2026-09-05').output, 0);
    // A price-history.json alias applies regardless.
    const forced = withFallbackAliases(normalizePriceConfig({ aliases: { 'grok-4.5-build-free': 'grok-4.5' } }), {});
    assert.equal(createPriceBook(db, forced).key('grok-4.5-build-free'), 'grok-4.5');
  } finally { db.close(); }
});

test('refreshPricing: a Settings alias target is priced alongside the model itself', () => {
  const db = openDb(':memory:');
  try {
    db.prepare(`INSERT INTO usage_daily (client, source_key, session_id, model, day, input_tokens) VALUES ('codex', 's', 'x', 'zpt-6', '2026-09-05', 1)`).run();
    const asked = [];
    refreshPricing(db, { bin: 'unused' }, {
      lookup: (model) => { asked.push(model); return model === 'gpt-6-astra' ? { ...rates(10, 50), matched_key: model, source: 'LiteLLM' } : null; },
      readCatalog: () => null,
      priceConfig: withFallbackAliases(normalizePriceConfig({}), { 'zpt-6': 'gpt-6-astra' })
    });
    assert.deepEqual(asked.sort(), ['gpt-6-astra', 'zpt-6']);
  } finally { db.close(); }
});

test('custom pricing: the base price of every day, without a notice, until it is removed', () => {
  const db = openDb(':memory:');
  try {
    const custom = (input, output) => ({ ...rates(input, output), source: 'Custom' });
    recordCatalogPrice(db, 'gpt-5.6-sol', rates(4, 20, 0.4), { day: '2026-09-27' });
    const config = normalizePriceConfig({ versions: [{ model: 'gpt-5.6-sol', from: '2026-12-01', input: 6, output: 36 }] });

    // A 3x custom price: no notice, and it replaces the catalog and the
    // announced prices on every day, while the user version keeps its dates.
    assert.deepEqual(recordCatalogPrice(db, 'gpt-5.6-sol', custom(12, 60), { day: '2026-09-28' }), { model: 'gpt-5.6-sol', changePct: null, notice: null });
    assert.equal(recordCatalogPrice(db, 'gpt-5.6-sol', custom(12, 60), { day: '2026-09-29' }), null);
    assert.deepEqual(pendingPriceNotices(db), []);
    let book = createPriceBook(db, config);
    close(book.on('gpt-5.6-sol', '2026-07-20').output, 60 * M);
    close(book.on('gpt-5.6-sol', '2026-10-01').output, 60 * M);
    close(book.on('gpt-5.6-sol', '2026-12-02').output, 36 * M);

    // Override removed, catalog unchanged: the earlier timeline is back.
    assert.equal(recordCatalogPrice(db, 'gpt-5.6-sol', { ...rates(4, 20, 0.4), source: 'LiteLLM' }, { day: '2026-09-30' }), null);
    book = createPriceBook(db, config);
    close(book.on('gpt-5.6-sol', '2026-07-20').output, 30 * M);
    close(book.on('gpt-5.6-sol', '2026-10-01').output, 20 * M);
    assert.deepEqual(versions(db, 'gpt-5.6-sol').map((v) => [v.effective_from, v.status]), [
      ['2026-09-27', 'active'], ['2026-09-28', 'void']
    ]);
  } finally { db.close(); }
});

test('priceConfigTemplate: help and examples are ignored when read', () => {
  const { priceConfigTemplate } = require('../../src/shared/dailyUsage/priceHistory');
  const json = JSON.parse(priceConfigTemplate(['line one', 'line two']));
  assert.deepEqual(json._help, ['line one', 'line two']);
  assert.equal(json._example.versions.length, 2);
  assert.deepEqual(normalizePriceConfig(json), { aliases: {}, versions: [] });
  // The example versions are themselves valid entries once copied over.
  assert.equal(normalizePriceConfig({ versions: json._example.versions }).versions.length, 2);
});

test('notices: a change can be moved back to its real start, but not past the previous version', () => {
  const db = openDb(':memory:');
  try {
    recordCatalogPrice(db, 'm', rates(4, 20), { day: '2026-08-10' });
    recordCatalogPrice(db, 'm', rates(5, 30), { day: '2026-11-23' });
    const [notice] = pendingPriceNotices(db);
    assert.equal(notice.earliestFrom, '2026-08-11');
    assert.deepEqual(notice.before, { input: 4, output: 20, cacheRead: null, cacheWrite: null });
    assert.deepEqual(notice.after, { input: 5, output: 30, cacheRead: null, cacheWrite: null });

    const redate = (date) => resolvePriceNotice(db, { model: 'm', effectiveFrom: '2026-11-23', action: 'redate', date });
    assert.equal(redate('2026-08-10').reason, 'invalid-date');
    assert.equal(redate('2026-11-24').reason, 'invalid-date');
    assert.deepEqual(redate('2026-11-21'), { ok: true });
    assert.deepEqual(versions(db, 'm').map((v) => [v.effective_from, v.notice]), [['2026-08-10', null], ['2026-11-21', 'resolved']]);
    assert.deepEqual(pendingPriceNotices(db), []);
    assert.equal(resolvePriceNotice(db, { model: 'm', effectiveFrom: '2026-11-23', action: 'confirm' }).reason, 'not-found');
  } finally { db.close(); }
});

test('query: a tokscale-anchored session follows the dated prices of its days', () => {
  const db = openDb(':memory:');
  try {
    const insertDaily = db.prepare(`
      INSERT INTO usage_daily (client, source_key, session_id, model, day, input_tokens, total_tokens)
      VALUES ('codex', 's', ?, 'm', ?, ?, ?)
    `);
    insertDaily.run('a', '2026-08-20', 1000, 1000);
    insertDaily.run('a', '2026-08-21', 1000, 1000);
    db.prepare(`INSERT INTO model_pricing (model, input, output, status) VALUES ('m', ?, ?, 'ok')`).run(4 * M, 20 * M);
    // tokscale bills everything at today's price, 10% above the plain price.
    db.prepare(`INSERT INTO usage_records (client, session_id, model, total_tokens, cost_usd) VALUES ('codex', 'a', 'm', 2000, ?)`).run(2000 * 4 * M * 1.1);

    const byDay = () => Object.fromEntries(dailyTotals(db).map((row) => [row.day, row.cost_usd]));
    close(byDay()['2026-08-20'], 1000 * 4 * M * 1.1);
    close(sessionUsageInRange(db)[0].cost_usd, 2000 * 4 * M * 1.1);

    const config = normalizePriceConfig({ versions: [
      { model: 'm', from: '2026-01-01', input: 5, output: 30 },
      { model: 'm', from: '2026-08-21', input: 4, output: 20 }
    ] });
    const days = Object.fromEntries(dailyTotals(db, {}, { priceConfig: config }).map((row) => [row.day, row.cost_usd]));
    close(days['2026-08-20'], 1000 * 5 * M * 1.1);
    close(days['2026-08-21'], 1000 * 4 * M * 1.1);
    const [session] = sessionUsageInRange(db, {}, { priceConfig: config });
    close(session.cost_usd, 1000 * 5 * M * 1.1 + 1000 * 4 * M * 1.1);
    assert.equal(session.cost_source, 'tokscale');
    assert.equal(session.days, 2);
  } finally { db.close(); }
});

test('refreshPricing: looks prices up under alias targets and records versions', () => {
  const db = openDb(':memory:');
  try {
    db.prepare(`INSERT INTO usage_daily (client, source_key, session_id, model, day, input_tokens) VALUES ('codex', 's', 'x', 'zpt-6', '2026-09-05', 1)`).run();
    const asked = [];
    const now = new Date(2026, 8, 27, 12).getTime();
    const run = (price, at) => refreshPricing(db, { bin: 'unused' }, {
      lookup: (model) => { asked.push(model); return { ...price, matched_key: model, source: 'LiteLLM' }; },
      readCatalog: () => null,
      priceConfig: normalizePriceConfig({ aliases: { 'zpt-6': 'gpt-6-astra' } }),
      now: at
    });
    assert.deepEqual(run(rates(10, 50), now), { fetched: 1, missing: 0, changed: 1, notices: 0 });
    assert.deepEqual(asked, ['gpt-6-astra']);
    // Within the day: not looked up again.
    assert.equal(run(rates(10, 50), now + 60 * 60 * 1000).fetched, 0);
    assert.deepEqual(run(rates(5, 25), now + 24 * 60 * 60 * 1000), { fetched: 1, missing: 0, changed: 1, notices: 1 });
    assert.deepEqual(versions(db, 'gpt-6-astra').map((v) => v.effective_from), ['2026-09-27', '2026-09-28']);
  } finally { db.close(); }
});

test('loadPriceConfig: reads the file, re-reads it on change, and survives a broken file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'price-config-'));
  const file = path.join(dir, 'price-history.json');
  assert.deepEqual(loadPriceConfig(file).aliases, {});
  fs.writeFileSync(file, `${String.fromCharCode(0xfeff)}{"aliases":{"zpt-6":"gpt-6-astra","same":"same"}}`);
  assert.deepEqual(loadPriceConfig(file).aliases, { 'zpt-6': 'gpt-6-astra' });
  fs.writeFileSync(file, '{ broken');
  const broken = loadPriceConfig(file);
  assert.deepEqual(broken.aliases, {});
  assert.ok(broken.error);
});
