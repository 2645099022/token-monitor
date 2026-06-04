'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { collectLimitsOnce } = require('../../src/shared/limitCollector');

test('collectLimitsOnce includes opencode provider from injected Go data', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const fakeGo = {
    status: 'ok',
    identity: 'opencode-go:/tmp/opencode.db',
    windows: [{ kind: 'session', used: 3, limit: 12, usedPercent: 25, resetsAt: new Date(now).toISOString(), windowMinutes: 300 }]
  };
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true },
    { now: () => now, opencodeCollectGo: () => fakeGo }
  );
  const provider = summary.providers.find((p) => p.provider === 'opencode');
  assert.ok(provider, 'opencode provider present');
  assert.strictEqual(provider.status, 'ok');
  assert.strictEqual(provider.source, 'local');
  assert.strictEqual(provider.windows[0].kind, 'session');
});

test('collectLimitsOnce marks opencode notConfigured when no Go usage', async () => {
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true },
    { now: () => Date.now(), opencodeCollectGo: () => ({ status: 'notConfigured', windows: [] }) }
  );
  const provider = summary.providers.find((p) => p.provider === 'opencode');
  assert.ok(provider);
  assert.strictEqual(provider.status, 'notConfigured');
});

test('fetchOpenCodeLimits merges Go(local) windows with Zen(web) balance', async () => {
  const now = Date.UTC(2026, 5, 4, 12, 0, 0);
  const fakeGo = { status: 'ok', identity: 'go:/x', windows: [{ kind: 'session', used: 1, limit: 12, usedPercent: 8.3, resetsAt: new Date(now).toISOString(), windowMinutes: 300 }] };
  const fakeZen = { status: 'ok', workspaceId: 'wrk_1', windows: [{ kind: 'weekly', used: null, limit: null, usedPercent: 20, resetsAt: new Date(now).toISOString(), windowMinutes: 10080 }], balanceUsd: 5 };
  const summary = await collectLimitsOnce(
    { limitProviders: 'opencode', limitsEnabled: true, opencodeCookie: 'sess=1' },
    { now: () => now, opencodeCollectGo: () => fakeGo, opencodeFetchZen: async () => fakeZen }
  );
  const p = summary.providers.find((x) => x.provider === 'opencode');
  assert.strictEqual(p.status, 'ok');
  assert.ok(p.windows.some((w) => w.kind === 'session'));  // from Go
  assert.ok(p.windows.some((w) => w.kind === 'weekly'));   // from Zen
});
