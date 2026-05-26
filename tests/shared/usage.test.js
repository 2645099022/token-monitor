'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { mergeDeviceRecord } = require('../../src/shared/usage');

function recordWithLimits(extra = {}) {
  return {
    deviceId: 'macbook',
    hostname: 'macbook.local',
    platform: 'darwin',
    updatedAt: '2026-05-27T00:00:00.000Z',
    receivedAt: '2026-05-27T00:00:00.000Z',
    today: { totalTokens: 1, costUsd: 0, clients: { cursor: 1 }, clientCosts: {} },
    month: { totalTokens: 1, costUsd: 0, clients: {}, clientCosts: {} },
    allTime: { totalTokens: 1, costUsd: 0, clients: {}, clientCosts: {} },
    limits: {
      updatedAt: '2026-05-27T00:00:00.000Z',
      refreshMs: 300000,
      providers: [
        {
          provider: 'cursor',
          accountKey: 'sha256:cursor',
          accountLabel: 'Free',
          status: 'ok',
          source: 'web',
          updatedAt: '2026-05-27T00:00:00.000Z',
          windows: [{ kind: 'billing', label: 'Total', usedPercent: 12 }]
        }
      ]
    },
    ...extra
  };
}

test('mergeDeviceRecord preserves existing limits when incoming payload omits limits', () => {
  const existing = recordWithLimits();
  const incoming = {
    deviceId: 'macbook',
    hostname: 'macbook.local',
    platform: 'darwin',
    updatedAt: '2026-05-27T00:01:00.000Z',
    receivedAt: '2026-05-27T00:01:00.000Z',
    today: { totalTokens: 5, costUsd: 0, clients: { cursor: 5 }, clientCosts: {} }
  };

  const merged = mergeDeviceRecord(existing, incoming);
  assert.equal(merged.periods.today.totalTokens, 5);
  assert.equal(merged.limits.providers.length, 1);
  assert.equal(merged.limits.providers[0].provider, 'cursor');
  assert.equal(merged.limits.providers[0].status, 'ok');
});

test('mergeDeviceRecord allows explicit empty limits to clear stale provider state', () => {
  const existing = recordWithLimits();
  const incoming = {
    deviceId: 'macbook',
    updatedAt: '2026-05-27T00:01:00.000Z',
    receivedAt: '2026-05-27T00:01:00.000Z',
    limits: { updatedAt: '2026-05-27T00:01:00.000Z', refreshMs: 300000, providers: [] }
  };

  const merged = mergeDeviceRecord(existing, incoming);
  assert.deepEqual(merged.limits.providers, []);
});

test('mergeDeviceRecord supports limitsOnly updates without wiping usage periods', () => {
  const existing = recordWithLimits();
  const incoming = {
    deviceId: 'macbook',
    receivedAt: '2026-05-27T00:02:00.000Z',
    limitsOnly: true,
    limits: {
      updatedAt: '2026-05-27T00:02:00.000Z',
      refreshMs: 300000,
      providers: [{ provider: 'cursor', status: 'unauthorized', source: 'web', updatedAt: '2026-05-27T00:02:00.000Z', windows: [] }]
    }
  };

  const merged = mergeDeviceRecord(existing, incoming);
  assert.equal(merged.periods.today.totalTokens, 1);
  assert.equal(merged.limits.providers[0].status, 'unauthorized');
});
