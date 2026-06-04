'use strict';
const test = require('node:test');
const assert = require('node:assert');
const web = require('../../src/shared/opencodeWeb');

test('sanitizeCookieHeader strips whitespace/newlines, keeps pairs', () => {
  assert.strictEqual(web.sanitizeCookieHeader('  a=1;\n b=2 '), 'a=1; b=2');
  assert.strictEqual(web.sanitizeCookieHeader('Cookie: auth=abc; oc_locale=zht'), 'auth=abc; oc_locale=zht');
  assert.strictEqual(web.sanitizeCookieHeader(''), '');
});

test('sanitizeCookieHeader wraps a bare value as the auth cookie', () => {
  assert.strictEqual(web.sanitizeCookieHeader('Fe26.2**abc'), 'auth=Fe26.2**abc');
  assert.strictEqual(web.sanitizeCookieHeader('auth=Fe26.2**abc; oc_locale=zht'), 'auth=Fe26.2**abc; oc_locale=zht');
});

test('serverRequestUrl: GET puts id+args in query; POST keeps bare /_server', () => {
  const get = web.serverRequestUrl('SID', ['wrk_1'], 'GET');
  assert.match(get, /\/_server\?/);
  assert.match(get, /id=SID/);
  assert.match(get, /args=/);
  assert.strictEqual(web.serverRequestUrl('SID', ['wrk_1'], 'POST'), 'https://opencode.ai/_server');
});

test('parseWorkspaceIds extracts wrk_ ids from text or JSON', () => {
  assert.deepStrictEqual(web.parseWorkspaceIds('foo id:"wrk_ABC" bar'), ['wrk_ABC']);
  assert.deepStrictEqual(web.parseWorkspaceIds('{"workspaces":[{"id":"wrk_XYZ"}]}'), ['wrk_XYZ']);
  assert.deepStrictEqual(web.parseWorkspaceIds('no ids'), []);
});

test('parseSubscription maps rolling/weekly to windows', () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const json = JSON.stringify({
    rollingUsage: { usagePercent: 40, resetInSec: 3600 },
    weeklyUsage: { usagePercent: 10, resetInSec: 86400 },
    balanceUSD: 7.5
  });
  const out = web.parseSubscription(json, now);
  const session = out.windows.find((w) => w.kind === 'session');
  const weekly = out.windows.find((w) => w.kind === 'weekly');
  assert.strictEqual(session.usedPercent, 40);
  assert.strictEqual(weekly.usedPercent, 10);
  assert.strictEqual(out.balanceUsd, 7.5);
  assert.strictEqual(session.resetsAt, new Date(now + 3600 * 1000).toISOString());
});

test('parseSubscription returns empty windows on null payload', () => {
  assert.deepStrictEqual(web.parseSubscription('null', Date.now()).windows, []);
});

test('parseSubscription falls back to regex for text/javascript (unquoted keys)', () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const tjs = 'foo({rollingUsage:{usagePercent:55,resetInSec:120},weeklyUsage:{usagePercent:5,resetInSec:600},balanceUSD:3.25})';
  const out = web.parseSubscription(tjs, now);
  assert.strictEqual(out.windows.find((w) => w.kind === 'session').usedPercent, 55);
  assert.strictEqual(out.windows.find((w) => w.kind === 'weekly').usedPercent, 5);
  assert.strictEqual(out.windows.find((w) => w.kind === 'session').resetsAt, new Date(now + 120 * 1000).toISOString());
  assert.strictEqual(out.balanceUsd, 3.25);
});

test('fetchZen resolves workspace then subscription via injected transport', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const calls = [];
  const transport = async (url) => {
    calls.push(url);
    if (url.includes(web.WORKSPACES_SERVER_ID)) return { status: 200, text: async () => '{"id":"wrk_ABC"}' };
    if (url.includes(web.SUBSCRIPTION_SERVER_ID)) return { status: 200, text: async () => '{"rollingUsage":{"usagePercent":33,"resetInSec":60}}' };
    return { status: 404, text: async () => 'nope' };
  };
  const out = await web.fetchZen('sess=1', { fetch: transport, now: () => now });
  assert.strictEqual(out.status, 'ok');
  assert.strictEqual(out.windows.find((w) => w.kind === 'session').usedPercent, 33);
  assert.ok(calls.some((u) => u.includes(web.WORKSPACES_SERVER_ID)));
});

test('fetchZen returns unauthorized on 401', async () => {
  const transport = async () => ({ status: 401, text: async () => 'login' });
  const out = await web.fetchZen('sess=1', { fetch: transport, now: () => Date.now() });
  assert.strictEqual(out.status, 'unauthorized');
});

test('fetchZen skips subscription POST on explicit null payload', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  let subCalls = 0;
  const transport = async (url) => {
    if (url.includes(web.WORKSPACES_SERVER_ID)) return { status: 200, text: async () => '{"id":"wrk_ABC"}' };
    subCalls += 1;
    return { status: 200, text: async () => 'null' };
  };
  const out = await web.fetchZen('sess=1', { fetch: transport, now: () => now });
  assert.strictEqual(out.status, 'ok');
  assert.deepStrictEqual(out.windows, []);
  assert.strictEqual(subCalls, 1); // no wasted POST after an explicit null
});

test('fetchZen re-checks status on the subscription POST fallback', async () => {
  const transport = async (url, init) => {
    if (url.includes(web.WORKSPACES_SERVER_ID)) return { status: 200, text: async () => '{"id":"wrk_ABC"}' };
    if (init && init.method === 'POST') return { status: 401, text: async () => 'nope' };
    return { status: 200, text: async () => '{}' }; // empty (non-null) GET → triggers POST
  };
  const out = await web.fetchZen('sess=1', { fetch: transport, now: () => Date.now() });
  assert.strictEqual(out.status, 'unauthorized');
});

test('fetchZen maps a login page (HTTP 200) to unauthorized', async () => {
  const transport = async () => ({ status: 200, text: async () => '<html>Please Login to continue</html>' });
  const out = await web.fetchZen('sess=1', { fetch: transport, now: () => Date.now() });
  assert.strictEqual(out.status, 'unauthorized');
});
