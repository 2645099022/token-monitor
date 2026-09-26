'use strict';

// Worker-thread entry: imports transcripts into usage_daily and refreshes
// model prices without blocking the Electron main process. It opens its own
// connection; WAL plus busy_timeout lets it coexist with the main writer.

const { parentPort, workerData } = require('node:worker_threads');
const { openDb } = require('../persistence/db');
const { importDailyUsage } = require('./importer');
const { refreshPricing } = require('./pricing');

(async () => {
  let db;
  const logs = [];
  try {
    db = openDb(workerData.dbPath);
    const imported = await importDailyUsage(db, workerData.roots, { log: (line) => logs.push(line) });
    const pricing = refreshPricing(db, workerData.tokscaleCommand);
    parentPort.postMessage({ ok: true, imported, pricing, logs });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: { message: error?.message, stack: error?.stack }, logs });
  } finally {
    try { db?.close(); } catch (_) { /* already closed */ }
  }
})();
