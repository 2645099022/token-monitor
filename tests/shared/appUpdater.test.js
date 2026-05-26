'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseTag } = require('../../src/shared/appUpdater');

test('parseTag strips a leading v from valid semver tags', () => {
  assert.equal(parseTag('v1.2.3'), '1.2.3');
  assert.equal(parseTag('V0.1.0'), '0.1.0');
});

test('parseTag accepts tags without a v prefix', () => {
  assert.equal(parseTag('1.2.3'), '1.2.3');
});

test('parseTag returns null for invalid or empty input', () => {
  assert.equal(parseTag(''), null);
  assert.equal(parseTag(null), null);
  assert.equal(parseTag(undefined), null);
  assert.equal(parseTag('release-foo'), null);
  assert.equal(parseTag('v1.2'), null);
  assert.equal(parseTag(123), null);
});

const { parseLatestReleasePayload } = require('../../src/shared/appUpdater');

test('parseLatestReleasePayload returns normalized object for valid payload', () => {
  const result = parseLatestReleasePayload({
    tag_name: 'v0.1.3',
    name: 'Token Monitor 0.1.3',
    html_url: 'https://github.com/Javis603/token-monitor/releases/tag/v0.1.3',
    published_at: '2026-05-26T12:00:00Z'
  });
  assert.deepEqual(result, {
    version: '0.1.3',
    tag: 'v0.1.3',
    name: 'Token Monitor 0.1.3',
    htmlUrl: 'https://github.com/Javis603/token-monitor/releases/tag/v0.1.3',
    publishedAt: '2026-05-26T12:00:00Z'
  });
});

test('parseLatestReleasePayload falls back to tag when name is missing', () => {
  const result = parseLatestReleasePayload({
    tag_name: 'v0.1.3',
    html_url: 'https://github.com/Javis603/token-monitor/releases/tag/v0.1.3'
  });
  assert.equal(result.name, 'v0.1.3');
  assert.equal(result.publishedAt, '');
});

test('parseLatestReleasePayload returns null for invalid or missing tag', () => {
  assert.equal(parseLatestReleasePayload({}), null);
  assert.equal(parseLatestReleasePayload({ tag_name: 'release-foo' }), null);
  assert.equal(parseLatestReleasePayload({ tag_name: '' }), null);
  assert.equal(parseLatestReleasePayload(null), null);
  assert.equal(parseLatestReleasePayload('not an object'), null);
});

test('parseLatestReleasePayload rejects payloads without an https html_url', () => {
  assert.equal(parseLatestReleasePayload({
    tag_name: 'v0.1.3',
    html_url: 'http://example.com'
  }), null);
  assert.equal(parseLatestReleasePayload({
    tag_name: 'v0.1.3'
  }), null);
});
