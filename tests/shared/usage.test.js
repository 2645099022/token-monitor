'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { aggregateDevices, extractUsageFromTokscale, mergeDeviceRecord } = require('../../src/shared/usage');

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

test('mergeDeviceRecord preserves usage for clients omitted by the active tracked-client list', () => {
  const existing = {
    deviceId: 'macbook',
    trackedClients: ['codex', 'hermes'],
    updatedAt: '2026-05-30T12:00:00.000Z',
    today: {
      totalTokens: 150,
      costUsd: 1.5,
      clients: { hermes: 100, codex: 50 },
      clientCosts: { hermes: 1.25, codex: 0.25 },
      models: { 'claude-3-5-sonnet': 100, 'gpt-5': 50 },
      modelCosts: { 'claude-3-5-sonnet': 1.25, 'gpt-5': 0.25 },
      clientModels: { hermes: { 'claude-3-5-sonnet': 100 }, codex: { 'gpt-5': 50 } },
      clientModelCosts: { hermes: { 'claude-3-5-sonnet': 1.25 }, codex: { 'gpt-5': 0.25 } },
      sessions: {
        'hermes:h1': {
          client: 'hermes',
          sessionId: 'h1',
          totalTokens: 100,
          costUsd: 1.25,
          messageCount: 4,
          models: { 'claude-3-5-sonnet': 100 },
          modelCosts: { 'claude-3-5-sonnet': 1.25 }
        },
        'codex:c1': {
          client: 'codex',
          sessionId: 'c1',
          totalTokens: 50,
          costUsd: 0.25,
          messageCount: 2,
          models: { 'gpt-5': 50 },
          modelCosts: { 'gpt-5': 0.25 }
        }
      }
    }
  };
  const incoming = {
    deviceId: 'macbook',
    trackedClients: ['codex'],
    updatedAt: '2026-05-30T12:01:00.000Z',
    today: {
      totalTokens: 75,
      costUsd: 0.5,
      clients: { codex: 75 },
      clientCosts: { codex: 0.5 },
      models: { 'gpt-5': 75 },
      modelCosts: { 'gpt-5': 0.5 },
      clientModels: { codex: { 'gpt-5': 75 } },
      clientModelCosts: { codex: { 'gpt-5': 0.5 } }
    }
  };

  const merged = mergeDeviceRecord(existing, incoming);
  assert.equal(merged.trackedClients.join(','), 'codex');
  assert.equal(merged.periods.today.totalTokens, 175);
  assert.equal(merged.periods.today.clients.codex, 75);
  assert.equal(merged.periods.today.clients.hermes, 100);
  assert.equal(merged.periods.today.models['gpt-5'], 75);
  assert.equal(merged.periods.today.models['claude-3-5-sonnet'], 100);
  assert.equal(merged.periods.today.clientModels.hermes['claude-3-5-sonnet'], 100);
  assert.equal(merged.periods.today.sessions['hermes:h1'].totalTokens, 100);
  assert.equal(merged.periods.today.sessions['codex:c1'], undefined);
});

test('mergeDeviceRecord preserves omitted-client day and month usage only inside matching calendar periods', () => {
  const existing = {
    deviceId: 'macbook',
    trackedClients: ['codex', 'hermes'],
    updatedAt: '2026-05-30T12:00:00.000Z',
    today: {
      totalTokens: 150,
      costUsd: 1.5,
      clients: { hermes: 100, codex: 50 },
      clientCosts: { hermes: 1.25, codex: 0.25 },
      models: { 'claude-3-5-sonnet': 100, 'gpt-5': 50 },
      modelCosts: { 'claude-3-5-sonnet': 1.25, 'gpt-5': 0.25 },
      clientModels: { hermes: { 'claude-3-5-sonnet': 100 }, codex: { 'gpt-5': 50 } },
      clientModelCosts: { hermes: { 'claude-3-5-sonnet': 1.25 }, codex: { 'gpt-5': 0.25 } }
    },
    month: {
      totalTokens: 450,
      costUsd: 4.5,
      clients: { hermes: 300, codex: 150 },
      clientCosts: { hermes: 3.75, codex: 0.75 },
      models: { 'claude-3-5-sonnet': 300, 'gpt-5': 150 },
      modelCosts: { 'claude-3-5-sonnet': 3.75, 'gpt-5': 0.75 },
      clientModels: { hermes: { 'claude-3-5-sonnet': 300 }, codex: { 'gpt-5': 150 } },
      clientModelCosts: { hermes: { 'claude-3-5-sonnet': 3.75 }, codex: { 'gpt-5': 0.75 } }
    },
    allTime: {
      totalTokens: 1200,
      costUsd: 12,
      clients: { hermes: 900, codex: 300 },
      clientCosts: { hermes: 11.25, codex: 0.75 },
      models: { 'claude-3-5-sonnet': 900, 'gpt-5': 300 },
      modelCosts: { 'claude-3-5-sonnet': 11.25, 'gpt-5': 0.75 },
      clientModels: { hermes: { 'claude-3-5-sonnet': 900 }, codex: { 'gpt-5': 300 } },
      clientModelCosts: { hermes: { 'claude-3-5-sonnet': 11.25 }, codex: { 'gpt-5': 0.75 } }
    }
  };
  const incoming = {
    deviceId: 'macbook',
    trackedClients: ['codex'],
    updatedAt: '2026-05-31T00:01:00.000Z',
    today: {
      totalTokens: 75,
      costUsd: 0.5,
      clients: { codex: 75 },
      clientCosts: { codex: 0.5 },
      models: { 'gpt-5': 75 },
      modelCosts: { 'gpt-5': 0.5 },
      clientModels: { codex: { 'gpt-5': 75 } },
      clientModelCosts: { codex: { 'gpt-5': 0.5 } }
    },
    month: {
      totalTokens: 175,
      costUsd: 0.75,
      clients: { codex: 175 },
      clientCosts: { codex: 0.75 },
      models: { 'gpt-5': 175 },
      modelCosts: { 'gpt-5': 0.75 },
      clientModels: { codex: { 'gpt-5': 175 } },
      clientModelCosts: { codex: { 'gpt-5': 0.75 } }
    },
    allTime: {
      totalTokens: 350,
      costUsd: 1,
      clients: { codex: 350 },
      clientCosts: { codex: 1 },
      models: { 'gpt-5': 350 },
      modelCosts: { 'gpt-5': 1 },
      clientModels: { codex: { 'gpt-5': 350 } },
      clientModelCosts: { codex: { 'gpt-5': 1 } }
    }
  };

  const nextDay = mergeDeviceRecord(existing, incoming);
  assert.equal(nextDay.periods.today.clients.hermes, undefined);
  assert.equal(nextDay.periods.today.models['claude-3-5-sonnet'], undefined);
  assert.equal(nextDay.periods.month.clients.hermes, 300);
  assert.equal(nextDay.periods.month.models['claude-3-5-sonnet'], 300);
  assert.equal(nextDay.periods.allTime.clients.hermes, 900);
  assert.equal(nextDay.periods.allTime.models['claude-3-5-sonnet'], 900);

  const nextMonth = mergeDeviceRecord(existing, {
    ...incoming,
    updatedAt: '2026-06-01T00:01:00.000Z',
    month: incoming.today
  });
  assert.equal(nextMonth.periods.today.clients.hermes, undefined);
  assert.equal(nextMonth.periods.month.clients.hermes, undefined);
  assert.equal(nextMonth.periods.month.models['claude-3-5-sonnet'], undefined);
  assert.equal(nextMonth.periods.allTime.clients.hermes, 900);
});

test('extractUsageFromTokscale normalizes Antigravity client names', () => {
  const period = extractUsageFromTokscale([
    { client: 'Google Antigravity', model: 'gemini-3-pro', totalTokens: 42, costUsd: 0.125 }
  ]);

  assert.equal(period.clients.antigravity, 42);
  assert.equal(period.clientCosts.antigravity, 0.125);
});

test('extractUsageFromTokscale keeps model usage grouped by client', () => {
  const period = extractUsageFromTokscale([
    { client: 'Hermes', model: 'claude-3-5-sonnet', totalTokens: 100, costUsd: 1.25 },
    { client: 'Codex', model: 'gpt-5', totalTokens: 50, costUsd: 0.25 }
  ]);

  assert.equal(period.models['claude-3-5-sonnet'], 100);
  assert.equal(period.clientModels.hermes['claude-3-5-sonnet'], 100);
  assert.equal(period.clientModelCosts.hermes['claude-3-5-sonnet'], 1.25);
  assert.equal(period.clientModels.codex['gpt-5'], 50);
});

test('extractUsageFromTokscale keeps session usage grouped by client and model', () => {
  const period = extractUsageFromTokscale({
    groupBy: 'client,session,model',
    entries: [
      {
        client: 'Codex',
        sessionId: 'rollout-1',
        model: 'gpt-5',
        provider: 'openai',
        input: 10,
        output: 5,
        cacheRead: 100,
        reasoning: 2,
        messageCount: 3,
        cost: 0.25,
        timestamp: '2026-05-30T04:00:00.000Z'
      },
      {
        client: 'Codex',
        sessionId: 'rollout-1',
        model: 'gpt-4o',
        provider: 'openai',
        input: 2,
        output: 3,
        messageCount: 1,
        cost: 0.05
      },
      {
        client: 'Cursor',
        sessionId: 'cursor-active',
        model: 'auto',
        provider: 'cursor',
        input: 1,
        output: 2,
        cost: 0.01
      }
    ]
  });

  const codex = period.sessions['codex:rollout-1'];
  assert.equal(codex.totalTokens, 122);
  assert.equal(codex.costUsd, 0.3);
  assert.equal(codex.messageCount, 4);
  assert.equal(codex.inputTokens, 12);
  assert.equal(codex.outputTokens, 8);
  assert.equal(codex.cacheReadTokens, 100);
  assert.equal(codex.reasoningTokens, 2);
  assert.equal(codex.lastUsedAt, '2026-05-30T04:00:00.000Z');
  assert.equal(codex.models['gpt-5'], 117);
  assert.equal(codex.models['gpt-4o'], 5);
  assert.equal(codex.providers.openai, 122);
  assert.equal(period.sessions['cursor:cursor-active'].models['cursor-auto'], 3);
});

test('aggregateDevices combines session usage across devices', () => {
  const aggregate = aggregateDevices([
    {
      deviceId: 'one',
      receivedAt: '2026-05-30T00:00:00.000Z',
      today: {
        totalTokens: 10,
        costUsd: 0.1,
        clients: { codex: 10 },
        clientCosts: { codex: 0.1 },
        sessions: {
          'codex:s1': {
            client: 'codex',
            sessionId: 's1',
            totalTokens: 10,
            costUsd: 0.1,
            messageCount: 1,
            inputTokens: 4,
            outputTokens: 6,
            models: { 'gpt-5': 10 },
            modelCosts: { 'gpt-5': 0.1 }
          }
        }
      }
    },
    {
      deviceId: 'two',
      receivedAt: '2026-05-30T00:00:00.000Z',
      today: {
        totalTokens: 5,
        costUsd: 0.2,
        clients: { codex: 5 },
        clientCosts: { codex: 0.2 },
        sessions: {
          'codex:s1': {
            client: 'codex',
            sessionId: 's1',
            totalTokens: 5,
            costUsd: 0.2,
            messageCount: 2,
            inputTokens: 2,
            outputTokens: 3,
            models: { 'gpt-5': 5 },
            modelCosts: { 'gpt-5': 0.2 }
          }
        }
      }
    }
  ], 0, Date.parse('2026-05-30T00:01:00.000Z'));

  const session = aggregate.periods.today.sessions['codex:s1'];
  assert.equal(session.totalTokens, 15);
  assert.equal(session.costUsd, 0.3);
  assert.equal(session.messageCount, 3);
  assert.equal(session.inputTokens, 6);
  assert.equal(session.outputTokens, 9);
  assert.equal(session.models['gpt-5'], 15);
  assert.equal(session.modelCosts['gpt-5'], 0.3);
});
