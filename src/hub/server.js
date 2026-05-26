'use strict';

const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const { aggregateDevices, mergeDeviceRecord } = require('../shared/usage');
const { isAuthorized, readJsonBody, sendJson, sendText } = require('../shared/http');
const { loadDotEnv, parseArgs, projectRoot, readJson, writeJsonAtomic } = require('../shared/config');

function createHub({
  port = 17321,
  host = '0.0.0.0',
  secret = '',
  staleAfterMs = 10 * 60 * 1000,
  dataFile = path.join(projectRoot(), 'data', 'devices.json'),
  logger = console
} = {}) {
  const store = readJson(dataFile, { version: 1, devices: {} }) || { version: 1, devices: {} };
  if (!store.devices || typeof store.devices !== 'object') store.devices = {};

  function persist() {
    store.version = 1;
    store.savedAt = new Date().toISOString();
    writeJsonAtomic(dataFile, store);
  }

  function getStats() {
    return aggregateDevices(Object.values(store.devices), staleAfterMs);
  }

  const sseClients = new Set();

  function sseFormat(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function broadcastStats(reason = 'update') {
    if (sseClients.size === 0) return;
    const payload = sseFormat('stats', { type: 'stats', reason, stats: getStats(), at: new Date().toISOString() });
    for (const res of sseClients) {
      try { res.write(payload); } catch (_) { sseClients.delete(res); }
    }
  }

  async function handleRequest(req, res) {
    if (req.method === 'OPTIONS') return sendText(res, 204, '');
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        role: 'hub',
        version: store.version || 1,
        deviceCount: Object.keys(store.devices).length,
        secretRequired: Boolean(secret),
        now: new Date().toISOString()
      });
    }

    if (!isAuthorized(req, secret)) return sendJson(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && url.pathname === '/api/stats') return sendJson(res, 200, getStats());
    if (req.method === 'GET' && url.pathname === '/api/devices') return sendJson(res, 200, { devices: Object.values(store.devices) });

    if (req.method === 'GET' && url.pathname === '/api/stats/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write(sseFormat('snapshot', { type: 'stats', reason: 'snapshot', stats: getStats(), at: new Date().toISOString() }));
      sseClients.add(res);
      const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) {} }, 30000);
      const cleanup = () => { clearInterval(heartbeat); sseClients.delete(res); };
      req.on('close', cleanup);
      req.on('error', cleanup);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ingest') {
      try {
        const payload = await readJsonBody(req);
        if (!payload.deviceId && !payload.id) return sendJson(res, 400, { error: 'deviceId_required' });
        const deviceId = String(payload.deviceId || payload.id);
        const record = mergeDeviceRecord(store.devices[deviceId], { ...payload, receivedAt: new Date().toISOString() });
        store.devices[record.deviceId] = record;
        persist();
        broadcastStats('ingest');
        return sendJson(res, 200, { ok: true, deviceId: record.deviceId, stats: getStats() });
      } catch (error) {
        return sendJson(res, 400, { error: 'bad_request', message: error.message });
      }
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/devices/')) {
      const deviceId = decodeURIComponent(url.pathname.slice('/api/devices/'.length));
      delete store.devices[deviceId];
      persist();
      broadcastStats('delete');
      return sendJson(res, 200, { ok: true, deviceId });
    }

    return sendJson(res, 404, { error: 'not_found' });
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      (logger.error || console.error)(error);
      sendJson(res, 500, { error: 'internal_error', message: error.message });
    });
  });

  function start() {
    return new Promise((resolve, reject) => {
      const onError = (err) => { server.off('listening', onListening); reject(err); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  function stop() {
    return new Promise((resolve) => {
      for (const res of sseClients) { try { res.end(); } catch (_) {} }
      sseClients.clear();
      server.close(() => resolve());
    });
  }

  return { start, stop, server, getStats };
}

if (require.main === module) {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port || process.env.TOKEN_MONITOR_PORT || 17321);
  const host = String(args.host || process.env.TOKEN_MONITOR_HOST || '0.0.0.0');
  const secret = String(args.secret || process.env.TOKEN_MONITOR_SECRET || '').trim();
  const staleAfterMs = Number(args.staleAfterMs || process.env.TOKEN_MONITOR_STALE_AFTER_MS || 10 * 60 * 1000);
  const dataFile = String(args.dataFile || process.env.TOKEN_MONITOR_DATA_FILE || path.join(projectRoot(), 'data', 'devices.json'));

  const hub = createHub({ port, host, secret, staleAfterMs, dataFile });
  hub.start().then(() => {
    console.log(`Token Monitor hub listening on http://${host}:${port}`);
    console.log(`Data file: ${dataFile}`);
    if (!secret) console.warn('Warning: TOKEN_MONITOR_SECRET is not set. The hub API accepts unauthenticated requests.');
  }).catch((err) => {
    console.error(`Hub failed to start: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { createHub };
