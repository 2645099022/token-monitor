'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const start = app.indexOf('function settledPriceNoticeGroups(');
const source = app.slice(start, app.indexOf('\nfunction settledPriceNoticeItem(', start));
const settledPriceNoticeGroups = Function(`${source}; return settledPriceNoticeGroups;`)();

// Newest day first, as the main process lists them.
const notices = [
  ...['claude-sonnet-5-5', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-terra'].map((model) => ({ model, observedOn: '2026-10-12' })),
  ...['claude-haiku-5-5', 'gemini-3.8-flash'].map((model) => ({ model, observedOn: '2026-10-08' })),
  { model: 'claude-sonnet-5', observedOn: '2026-09-28' }
];

const shape = ({ groups }) => groups.map((group) => [group.date, group.count, group.notices.map((notice) => notice.model)]);

test('settled price changes group by the day they were seen', () => {
  const result = settledPriceNoticeGroups(notices);
  assert.deepEqual(shape(result), [
    ['2026-10-12', 4, ['claude-sonnet-5-5', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-terra']],
    ['2026-10-08', 2, ['claude-haiku-5-5', 'gemini-3.8-flash']],
    ['2026-09-28', 1, ['claude-sonnet-5']]
  ]);
  assert.equal(result.matched, 7);
  assert.equal(result.hidden, 0);
});

test('a page cut keeps each day count whole and reports what is left', () => {
  const result = settledPriceNoticeGroups(notices, '', 5);
  assert.deepEqual(shape(result), [
    ['2026-10-12', 4, ['claude-sonnet-5-5', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-terra']],
    ['2026-10-08', 2, ['claude-haiku-5-5']]
  ]);
  assert.equal(result.hidden, 2);
});

test('the model filter ignores case and separators', () => {
  assert.deepEqual(shape(settledPriceNoticeGroups(notices, 'Sonnet 5.5')), [['2026-10-12', 1, ['claude-sonnet-5-5']]]);
  assert.deepEqual(shape(settledPriceNoticeGroups(notices, 'gpt6')), [
    ['2026-10-12', 3, ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-terra']]
  ]);
  const none = settledPriceNoticeGroups(notices, 'mistral');
  assert.deepEqual(none.groups, []);
  assert.equal(none.matched, 0);
});
