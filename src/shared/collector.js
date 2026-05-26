'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chokidar = require('chokidar');
const semver = require('semver');
const { readJson, sharedDataDir } = require('./config');
const { tokscalePackageNameForPlatform, tokscalePlatformKey } = require('./tokscalePlatform');
const { extractUsageFromTokscale } = require('./usage');
const { collectLimitsOnce, createLimitsCollector } = require('./limitCollector');
const cursorAuth = require('./cursorAuth');

function toUnpackedPath(p) {
  // electron-builder asarUnpack stores real files at .../app.asar.unpacked/...
  // require.resolve() returns the .../app.asar/... path, which spawn() can't read.
  const asarSeg = `${path.sep}app.asar${path.sep}`;
  return p && p.includes(asarSeg) ? p.replace(asarSeg, `${path.sep}app.asar.unpacked${path.sep}`) : p;
}

const TOKSCALE_BIN_JS = toUnpackedPath(require.resolve('tokscale/bin.js'));

function tokscaleBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'tokscale.exe' : 'tokscale';
}

function bundledPackageCandidates() {
  const primary = tokscalePackageNameForPlatform();
  if (primary) return [primary];
  if (process.platform === 'linux') {
    if (process.arch === 'arm64') return ['@tokscale/cli-linux-arm64-gnu', '@tokscale/cli-linux-arm64-musl'];
    if (process.arch === 'x64') return ['@tokscale/cli-linux-x64-gnu', '@tokscale/cli-linux-x64-musl'];
  }
  return [];
}

function locateBundledBinary() {
  const binaryName = process.platform === 'win32' ? 'tokscale.exe' : 'tokscale';
  for (const pkg of bundledPackageCandidates()) {
    try {
      const pkgPath = require.resolve(`${pkg}/package.json`);
      const binPath = toUnpackedPath(path.join(path.dirname(pkgPath), 'bin', binaryName));
      const pkgJson = readJson(pkgPath, {});
      if (fs.existsSync(binPath)) {
        return { source: 'bundled', path: binPath, version: String(pkgJson.version || '0.0.0'), packageName: pkg };
      }
    } catch (_) {}
  }
  return null;
}

function readDownloadedPointer() {
  const currentPath = path.join(sharedDataDir(), 'tokscale', 'current.json');
  const current = readJson(currentPath, null);
  if (!current || typeof current !== 'object') return null;
  if (current.platform && current.platform !== tokscalePlatformKey()) return null;
  if (!semver.valid(current.version)) return null;
  if (typeof current.path !== 'string' || !path.isAbsolute(current.path)) return null;
  try {
    const stat = fs.statSync(current.path);
    if (!stat.isFile()) return null;
    if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) return null;
  } catch (_) {
    return null;
  }
  return {
    source: 'downloaded',
    path: current.path,
    version: current.version,
    installedAt: current.installedAt || '',
    integrity: current.integrity || ''
  };
}

function decideResolver({ downloaded, bundled, shim }) {
  if (downloaded && !bundled) return downloaded;
  if (downloaded && bundled && semver.valid(downloaded.version) && semver.valid(bundled.version) && semver.gt(downloaded.version, bundled.version)) {
    return downloaded;
  }
  return bundled || shim || null;
}

function resolvePlatformBinary() {
  const bundled = locateBundledBinary();
  const downloaded = readDownloadedPointer();
  const shim = { source: 'shim', path: TOKSCALE_BIN_JS, version: null };
  return decideResolver({ downloaded, bundled, shim });
}

function tokscaleCommand() {
  const resolved = resolvePlatformBinary();
  const useDirect = Boolean(resolved && resolved.source !== 'shim');
  if (useDirect) return { bin: resolved.path, prefixArgs: [], env: process.env };
  return { bin: process.execPath, prefixArgs: [TOKSCALE_BIN_JS], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
}

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('tokscale produced empty stdout');
  try { return JSON.parse(text); } catch (_) {
    const starts = [text.indexOf('{'), text.indexOf('[')].filter((value) => value >= 0).sort((a, b) => a - b);
    for (const start of starts) {
      try { return JSON.parse(text.slice(start)); } catch (_inner) {}
    }
  }
  throw new Error(`Could not parse tokscale JSON output: ${text.slice(0, 300)}`);
}

function runTokscale({ clients, flags, commandTimeoutMs }) {
  const userArgs = ['--json', '--client', clients, '--group-by', 'client,model', ...flags];
  const { bin, prefixArgs, env } = tokscaleCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...prefixArgs, ...userArgs], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`tokscale timed out after ${commandTimeoutMs}ms`)); }, commandTimeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`tokscale exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
      try { resolve(parseJsonOutput(stdout)); } catch (error) { reject(error); }
    });
  });
}

async function maybeSyncCursor(clientsCsv, logger) {
  const enabled = new Set(String(clientsCsv || '').split(',').map((v) => v.trim().toLowerCase()));
  if (!enabled.has('cursor')) return;
  if (!cursorAuth.readActiveAccount()) return;
  try {
    await cursorAuth.runCursorSync();
  } catch (err) {
    if (typeof logger === 'function') logger(`cursor sync failed: ${err.message}`);
  }
}

async function collectUsageOnce(options) {
  const { clients, allTimeSince, commandTimeoutMs, deviceId, agentVersion = '0.1.0' } = options;
  await maybeSyncCursor(clients, options.logger);
  const todayJson = await runTokscale({ clients, flags: ['--today'], commandTimeoutMs });
  const monthJson = await runTokscale({ clients, flags: ['--month'], commandTimeoutMs });
  const allTimeJson = await runTokscale({ clients, flags: ['--since', allTimeSince], commandTimeoutMs });
  const summary = {
    deviceId,
    hostname: os.hostname(),
    platform: `${process.platform}-${process.arch}`,
    updatedAt: new Date().toISOString(),
    agentVersion,
    today: extractUsageFromTokscale(todayJson),
    month: extractUsageFromTokscale(monthJson),
    allTime: extractUsageFromTokscale(allTimeJson)
  };
  if (options.limitsEnabled !== false) {
    summary.limits = options.limitsCollector
      ? await options.limitsCollector.snapshot()
      : await collectLimitsOnce(options);
  }
  return summary;
}

function watchPathsForClients(clientsCsv) {
  const home = os.homedir();
  const enabled = new Set(String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const candidates = [];
  if (enabled.has('claude')) {
    candidates.push(path.join(home, '.claude', 'projects'));
    candidates.push(path.join(home, '.claude', 'transcripts'));
  }
  if (enabled.has('codex')) {
    candidates.push(path.join(home, '.codex', 'sessions'));
  }
  if (enabled.has('hermes')) {
    candidates.push(process.env.HERMES_HOME || path.join(home, '.hermes'));
  }
  if (enabled.has('opencode')) {
    candidates.push(path.join(home, '.local', 'share', 'opencode'));
  }
  if (enabled.has('openclaw')) {
    candidates.push(path.join(home, '.openclaw', 'agents'));
  }
  if (enabled.has('cursor')) {
    candidates.push(path.join(home, '.config', 'tokscale', 'cursor-cache'));
  }
  return candidates.filter((candidate) => { try { return fs.statSync(candidate).isDirectory(); } catch (_) { return false; } });
}

function startCollector(options) {
  const {
    clients, allTimeSince, commandTimeoutMs, deviceId, agentVersion,
    intervalMs, watchEnabled, watchDebounceMs, limitsEnabled,
    onUpdate, onError, logger
  } = options;
  const log = logger || (() => {});
  const limitsCollector = limitsEnabled !== false ? createLimitsCollector(options) : null;
  let tickInFlight = false;
  let tickPending = false;
  let debounceTimer = null;
  let intervalTimer = null;
  let stopped = false;
  const watchers = [];

  async function performTick(reason) {
    try {
      const summary = await collectUsageOnce({
        ...options,
        clients,
        allTimeSince,
        commandTimeoutMs,
        deviceId,
        agentVersion,
        limitsCollector
      });
      if (stopped) return;
      onUpdate?.(summary, reason);
    } catch (error) {
      if (stopped) return;
      if (onError) onError(error, reason); else log(`collector tick failed (${reason}): ${error.message}`);
    }
  }

  async function runTick(reason) {
    if (tickInFlight) { tickPending = true; return; }
    tickInFlight = true;
    await performTick(reason);
    tickInFlight = false;
    if (tickPending && !stopped) {
      tickPending = false;
      setImmediate(() => runTick('coalesced'));
    }
  }

  function scheduleTick(reason) {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debounceTimer = null; runTick(reason); }, watchDebounceMs);
  }

  function setupWatchers() {
    if (!watchEnabled) return;
    const dirs = watchPathsForClients(clients);
    if (dirs.length === 0) {
      log('No watchable client data directories found; relying on fallback interval only.');
      return;
    }
    try {
      const watcher = chokidar.watch(dirs, {
        ignoreInitial: true,
        persistent: true,
        usePolling: true,
        interval: 2000,
        binaryInterval: 5000,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 }
      });
      watcher.on('all', (event, filePath) => scheduleTick(`watch:${event}:${path.basename(filePath || '')}`));
      watcher.on('error', (error) => log(`chokidar error: ${error.message}`));
      watchers.push(watcher);
      for (const dir of dirs) log(`Watching ${dir} (polling 2s)`);
    } catch (error) {
      log(`Cannot watch ${dirs.join(', ')}: ${error.message}`);
    }
  }

  function loop() {
    if (stopped) return;
    runTick('interval').finally(() => {
      if (stopped) return;
      intervalTimer = setTimeout(loop, intervalMs);
    });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (intervalTimer) { clearTimeout(intervalTimer); intervalTimer = null; }
    for (const watcher of watchers) {
      try { watcher.close(); } catch (_) {}
    }
    watchers.length = 0;
  }

  setupWatchers();
  loop();

  return { stop, tick: (reason = 'manual') => runTick(reason) };
}

module.exports = {
  collectUsageOnce,
  decideResolver,
  locateBundledBinary,
  readDownloadedPointer,
  resolvePlatformBinary,
  startCollector,
  tokscaleCommand,
  watchPathsForClients
};
