'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const { defaultDeviceId, loadDotEnv, pidFilePath } = require('../shared/config');
const { startCollector } = require('../shared/collector');
const { normalizeLimitsRefreshMs, parseBoolean, parseLimitProviders } = require('../shared/limitCollector');
const { aggregateDevices } = require('../shared/usage');
const { startDiscordRpc, stopDiscordRpc, updateDiscordRpc } = require('./discordRpc');

loadDotEnv();

const APP_NAME = 'Token Monitor';
const APP_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');

const DEFAULT_WINDOW = { width: 360, height: 500 };
const WINDOW_LIMITS = { minWidth: 240, minHeight: 140, maxWidth: 1200, maxHeight: 1400 };
const ZOOM_LIMITS = { min: 0.7, max: 1.6, step: 0.1 };

let mainWindow = null;
let settingsPath = null;
let settings = null;

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.javis.tokenmonitor');

function defaultSettings() {
  return {
    hubUrl: process.env.TOKEN_MONITOR_HUB_URL || '',
    secret: process.env.TOKEN_MONITOR_SECRET || '',
    alwaysOnTop: process.env.TOKEN_MONITOR_ALWAYS_ON_TOP !== '0',
    refreshMs: Number(process.env.TOKEN_MONITOR_WIDGET_REFRESH_MS || 15000),
    glassOpacity: 68,
    glassBlur: 32,
    systemGlass: true,
    showLiveDot: true,
    showToolIcons: true,
    discordRpcEnabled: false,
    deviceId: process.env.TOKEN_MONITOR_DEVICE_ID || defaultDeviceId(),
    lastPostedDeviceId: '',
    clients: process.env.TOKEN_MONITOR_CLIENTS || 'claude,codex,hermes,opencode,openclaw,cursor',
    allTimeSince: process.env.TOKEN_MONITOR_ALL_TIME_SINCE || '2024-01-01',
    limitsEnabled: parseBoolean(process.env.TOKEN_MONITOR_LIMITS_ENABLED, true),
    limitProviders: parseLimitProviders(process.env.TOKEN_MONITOR_LIMIT_PROVIDERS).join(','),
    limitsRefreshMs: normalizeLimitsRefreshMs(process.env.TOKEN_MONITOR_LIMITS_REFRESH_MS),
    showLimitSource: parseBoolean(process.env.TOKEN_MONITOR_SHOW_LIMIT_SOURCE, false),
    windowBounds: null,
    zoomFactor: 1
  };
}

function clampZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, Number(n.toFixed(2))));
}

function isBoundsOnScreen(bounds) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return false;
  try {
    const display = screen.getDisplayMatching({
      x: bounds.x, y: bounds.y, width: bounds.width || 1, height: bounds.height || 1
    });
    const wa = display.workArea;
    return bounds.x + bounds.width > wa.x &&
      bounds.x < wa.x + wa.width &&
      bounds.y + bounds.height > wa.y &&
      bounds.y < wa.y + wa.height;
  } catch (_) { return false; }
}

function restoredBounds() {
  const saved = settings?.windowBounds;
  if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') return null;
  const width = Math.min(WINDOW_LIMITS.maxWidth, Math.max(WINDOW_LIMITS.minWidth, saved.width));
  const height = Math.min(WINDOW_LIMITS.maxHeight, Math.max(WINDOW_LIMITS.minHeight, saved.height));
  if (!isBoundsOnScreen({ ...saved, width, height })) return { width, height };
  return { x: saved.x, y: saved.y, width, height };
}

let persistBoundsTimer = null;
function persistBoundsSoon() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
  if (persistBoundsTimer) clearTimeout(persistBoundsTimer);
  persistBoundsTimer = setTimeout(() => {
    persistBoundsTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const next = mainWindow.getBounds();
    const prev = settings.windowBounds || {};
    if (prev.x === next.x && prev.y === next.y && prev.width === next.width && prev.height === next.height) return;
    settings.windowBounds = next;
    saveSettings();
  }, 400);
}

function applyZoomFactor() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.setZoomFactor(clampZoom(settings.zoomFactor));
}

function setZoomFactor(value) {
  const next = clampZoom(value);
  if (next === clampZoom(settings.zoomFactor)) return;
  settings.zoomFactor = next;
  saveSettings();
  applyZoomFactor();
}

function adjustZoom(delta) {
  setZoomFactor(clampZoom(settings.zoomFactor) + delta);
}

function readSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    const defaults = defaultSettings();
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!saved.secret && defaults.secret) delete saved.secret;
    return { ...defaults, ...saved };
  }
  catch (_error) { return defaultSettings(); }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function applyWindowSettings() {
  if (mainWindow) mainWindow.setAlwaysOnTop(Boolean(settings.alwaysOnTop), 'floating');
}

function nativeBlurEnabled(source = settings) {
  return source?.systemGlass !== false;
}

function keepNativeBlurActive() {
  if (!mainWindow) return;
  if (!nativeBlurEnabled()) return;
  if (process.platform === 'darwin' && typeof mainWindow.setVisualEffectState === 'function') {
    mainWindow.setVisualEffectState('active');
  }
}

function applyNativeMaterial(source = settings) {
  if (!mainWindow) return;
  const enabled = nativeBlurEnabled(source);
  if (process.platform === 'darwin' && typeof mainWindow.setVibrancy === 'function') {
    mainWindow.setVibrancy(enabled ? 'hud' : null);
    if (typeof mainWindow.setVisualEffectState === 'function') {
      mainWindow.setVisualEffectState(enabled ? 'active' : 'inactive');
    }
  }
  // Windows: backgroundMaterial is locked in at window creation. setBackgroundMaterial('none')
  // does not restore layered-window transparency once DWM SystemBackdrop has been engaged,
  // so toggling is handled by rebuildWindow() instead.
}

let mode = 'idle';
let localCollectorHandle = null;
let localDevice = null;
let localStats = null;
let sseAbortController = null;
let sseRetryTimer = null;
let streamConnected = false;
let syncCollectorHandle = null;
const AGENT_PID_PATH = pidFilePath();

function isExternalAgentActive() {
  try {
    const raw = fs.readFileSync(AGENT_PID_PATH, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (!pid || pid === process.pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (_) { return false; }
}

async function deleteDeviceFromHub(deviceId) {
  const base = String(settings.hubUrl).replace(/\/$/, '');
  const response = await fetch(`${base}/api/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
    headers: settings.secret ? { authorization: `Bearer ${settings.secret}` } : {}
  });
  if (!response.ok && response.status !== 404) throw new Error(`DELETE ${response.status}`);
}

async function postToHub(summary) {
  const stale = settings.lastPostedDeviceId;
  if (stale && stale !== summary.deviceId) {
    try { await deleteDeviceFromHub(stale); }
    catch (error) { console.log(`[sync] cleanup of old deviceId ${stale} failed: ${error.message}`); }
  }
  const url = `${String(settings.hubUrl).replace(/\/$/, '')}/api/ingest`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(settings.secret ? { authorization: `Bearer ${settings.secret}` } : {}) },
    body: JSON.stringify(summary)
  });
  if (!response.ok) throw new Error(`Hub ${response.status}: ${(await response.text()).slice(0, 200)}`);
  if (settings.lastPostedDeviceId !== summary.deviceId) {
    settings.lastPostedDeviceId = summary.deviceId;
    saveSettings();
  }
  return response.json();
}

function stopSyncCollector() {
  if (syncCollectorHandle) { try { syncCollectorHandle.stop(); } catch (_) {} }
  syncCollectorHandle = null;
}

function startSyncCollector() {
  stopSyncCollector();
  if (!isHubConfigured()) return;
  syncCollectorHandle = startCollector({
    clients: settings.clients || 'claude,codex,hermes,opencode,openclaw,cursor',
    allTimeSince: settings.allTimeSince || '2024-01-01',
    commandTimeoutMs: 120 * 1000,
    deviceId: settings.deviceId || defaultDeviceId(),
    agentVersion: '0.1.0-widget',
    intervalMs: 5 * 60 * 1000,
    watchEnabled: true,
    watchDebounceMs: 1500,
    limitsEnabled: settings.limitsEnabled !== false,
    limitProviders: settings.limitProviders ?? 'claude,codex',
    limitsRefreshMs: normalizeLimitsRefreshMs(settings.limitsRefreshMs),
    onUpdate: (summary) => {
      if (isExternalAgentActive()) return;
      postToHub(summary).catch((error) => console.log(`[sync-collector] post failed: ${error.message}`));
    },
    onError: (error, reason) => console.log(`[sync-collector] ${reason}: ${error.message}`),
    logger: (msg) => console.log(`[sync-collector] ${msg}`)
  });
}

function isHubConfigured() {
  return Boolean(settings?.hubUrl && String(settings.hubUrl).trim());
}

function sendPush(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('stats:push', payload); } catch (_) {}
  }
}

function sendStatus(connected, extra) {
  streamConnected = Boolean(connected);
  sendPush({ event: 'status', data: { connected: streamConnected, mode, ...(extra || {}) } });
}

function stopLocalCollector() {
  if (localCollectorHandle) { try { localCollectorHandle.stop(); } catch (_) {} }
  localCollectorHandle = null;
  localDevice = null;
  localStats = null;
}

function startLocalCollector() {
  stopLocalCollector();
  mode = 'local';
  sendStatus(false, { reason: 'collecting' });
  localCollectorHandle = startCollector({
    clients: settings.clients || 'claude,codex,hermes,opencode,openclaw,cursor',
    allTimeSince: settings.allTimeSince || '2024-01-01',
    commandTimeoutMs: 120 * 1000,
    deviceId: settings.deviceId || defaultDeviceId(),
    agentVersion: '0.1.0',
    intervalMs: 5 * 60 * 1000,
    watchEnabled: true,
    watchDebounceMs: 1500,
    limitsEnabled: settings.limitsEnabled !== false,
    limitProviders: settings.limitProviders ?? 'claude,codex',
    limitsRefreshMs: normalizeLimitsRefreshMs(settings.limitsRefreshMs),
    onUpdate: (summary, reason) => {
      localDevice = { ...summary, receivedAt: new Date().toISOString() };
      localStats = aggregateDevices([localDevice], 0);
      updateDiscordRpc(localStats);
      sendPush({ event: 'stats', data: { type: 'stats', reason, stats: localStats, at: new Date().toISOString() } });
      sendStatus(true, { reason });
    },
    onError: (error, reason) => {
      sendStatus(false, { reason: `${reason}:${error.message}` });
    },
    logger: (msg) => console.log(`[collector] ${msg}`)
  });
}

function scheduleStreamRetry(delayMs = 3000) {
  if (sseRetryTimer) return;
  sseRetryTimer = setTimeout(() => { sseRetryTimer = null; startStatsStream(); }, delayMs);
}

function stopStatsStream() {
  if (sseAbortController) { try { sseAbortController.abort(); } catch (_) {} }
  sseAbortController = null;
  if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
}

function parseSseChunk(chunk) {
  let event = 'message';
  const dataLines = [];
  for (const line of chunk.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try { return { event, data: JSON.parse(dataLines.join('\n')) }; } catch (_) { return null; }
}

async function startStatsStream() {
  stopStatsStream();
  if (!isHubConfigured()) return;
  mode = 'sync';
  const url = `${String(settings.hubUrl).replace(/\/$/, '')}/api/stats/stream`;
  const controller = new AbortController();
  sseAbortController = controller;
  try {
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream', ...(settings.secret ? { authorization: `Bearer ${settings.secret}` } : {}) },
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      sendStatus(false, { code: response.status });
      scheduleStreamRetry();
      return;
    }
    sendStatus(true);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseSseChunk(chunk);
        if (parsed) {
          if (parsed.event === 'stats' && parsed.data?.stats) updateDiscordRpc(parsed.data.stats);
          sendPush(parsed);
        }
      }
    }
    sendStatus(false, { reason: 'eof' });
    scheduleStreamRetry();
  } catch (error) {
    if (controller.signal.aborted) return;
    sendStatus(false, { reason: error.message });
    scheduleStreamRetry();
  }
}

function startMode() {
  if (isHubConfigured()) {
    stopLocalCollector();
    startStatsStream();
    startSyncCollector();
  } else {
    stopStatsStream();
    stopSyncCollector();
    startLocalCollector();
  }
}

function stopAll() {
  stopLocalCollector();
  stopStatsStream();
  stopSyncCollector();
  stopDiscordRpc();
}

async function fetchStats() {
  if (mode === 'local') {
    if (localStats) return localStats;
    return aggregateDevices(localDevice ? [localDevice] : [], 0);
  }
  const url = `${String(settings.hubUrl || '').replace(/\/$/, '')}/api/stats`;
  const response = await fetch(url, { headers: settings.secret ? { authorization: `Bearer ${settings.secret}` } : {} });
  if (!response.ok) throw new Error(`Hub ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

function createWindow(boundsOverride) {
  if (!settings) settings = readSettings();
  const glass = nativeBlurEnabled();
  const bounds = boundsOverride || restoredBounds() || DEFAULT_WINDOW;
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(typeof bounds.x === 'number' ? { x: bounds.x, y: bounds.y } : {}),
    ...WINDOW_LIMITS,
    frame: false,
    transparent: true,
    resizable: true,
    show: false,
    backgroundColor: '#00000000',
    icon: APP_ICON_PATH,
    ...(process.platform === 'darwin' && glass ? { vibrancy: 'hud', visualEffectState: 'active' } : {}),
    ...(process.platform === 'win32' && glass ? { backgroundMaterial: 'acrylic' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: clampZoom(settings.zoomFactor)
    }
  });
  applyWindowSettings();
  applyNativeMaterial();
  keepNativeBlurActive();
  mainWindow.on('focus', keepNativeBlurActive);
  mainWindow.on('blur', keepNativeBlurActive);
  mainWindow.on('resized', persistBoundsSoon);
  mainWindow.on('moved', persistBoundsSoon);
  mainWindow.webContents.on('before-input-event', handleZoomShortcut);
  mainWindow.webContents.on('did-finish-load', applyZoomFactor);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

function handleZoomShortcut(event, input) {
  if (input.type !== 'keyDown') return;
  if (!(input.control || input.meta)) return;
  const key = input.key;
  if (key === '=' || key === '+') { event.preventDefault(); adjustZoom(ZOOM_LIMITS.step); }
  else if (key === '-' || key === '_') { event.preventDefault(); adjustZoom(-ZOOM_LIMITS.step); }
  else if (key === '0') { event.preventDefault(); setZoomFactor(1); }
}

function rebuildWindow() {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const wasFocused = mainWindow.isFocused();
  const old = mainWindow;
  old.removeAllListeners('close');
  // Build the new window first so total window count never drops to 0
  // (otherwise window-all-closed fires and quits the app on Windows).
  createWindow(bounds);
  mainWindow.once('ready-to-show', () => {
    if (!old.isDestroyed()) old.destroy();
    if (wasFocused && !mainWindow.isDestroyed()) mainWindow.focus();
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(APP_ICON_PATH);
  createWindow();
  startMode();
  if (settings.discordRpcEnabled) startDiscordRpc();
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:update', (_event, patch) => {
    const previousSystemGlass = settings.systemGlass;
    const previousHubUrl = settings.hubUrl;
    const previousSecret = settings.secret;
    const previousDeviceId = settings.deviceId;
    const previousClients = settings.clients;
    const previousLimitsEnabled = settings.limitsEnabled;
    const previousLimitProviders = settings.limitProviders;
    const previousLimitsRefreshMs = settings.limitsRefreshMs;
    const previousDiscordRpcEnabled = settings.discordRpcEnabled;
    settings = {
      ...settings,
      ...patch,
      deviceId: (patch.deviceId !== undefined ? String(patch.deviceId).trim() : settings.deviceId) || defaultDeviceId(),
      refreshMs: Math.max(5000, Number(patch.refreshMs ?? settings.refreshMs ?? 15000)),
      glassOpacity: Math.max(0, Math.min(100, Number(patch.glassOpacity ?? settings.glassOpacity ?? 68))),
      glassBlur: Math.max(0, Math.min(100, Number(patch.glassBlur ?? settings.glassBlur ?? 32))),
      systemGlass: patch.systemGlass ?? settings.systemGlass ?? true,
      showLiveDot: patch.showLiveDot ?? settings.showLiveDot ?? true,
      showToolIcons: patch.showToolIcons ?? settings.showToolIcons ?? true,
      discordRpcEnabled: patch.discordRpcEnabled ?? settings.discordRpcEnabled ?? false,
      limitsEnabled: parseBoolean(patch.limitsEnabled ?? settings.limitsEnabled, true),
      limitProviders: patch.limitProviders !== undefined ? parseLimitProviders(patch.limitProviders).join(',') : settings.limitProviders,
      limitsRefreshMs: normalizeLimitsRefreshMs(patch.limitsRefreshMs ?? settings.limitsRefreshMs),
      showLimitSource: parseBoolean(patch.showLimitSource ?? settings.showLimitSource, false),
      zoomFactor: clampZoom(patch.zoomFactor ?? settings.zoomFactor)
    };
    saveSettings();
    if (patch.zoomFactor !== undefined) applyZoomFactor();
    if (settings.discordRpcEnabled && !previousDiscordRpcEnabled) startDiscordRpc();
    else if (!settings.discordRpcEnabled && previousDiscordRpcEnabled) stopDiscordRpc();
    applyWindowSettings();
    if (process.platform === 'win32' && previousSystemGlass !== settings.systemGlass) {
      rebuildWindow();
    } else {
      applyNativeMaterial();
    }
    if (
      settings.hubUrl !== previousHubUrl ||
      settings.secret !== previousSecret ||
      settings.deviceId !== previousDeviceId ||
      settings.clients !== previousClients ||
      settings.limitsEnabled !== previousLimitsEnabled ||
      settings.limitProviders !== previousLimitProviders ||
      settings.limitsRefreshMs !== previousLimitsRefreshMs
    ) {
      startMode();
    }
    return settings;
  });
  ipcMain.handle('appearance:preview', (_event, patch) => {
    applyNativeMaterial({ ...settings, ...patch });
    if (patch && patch.zoomFactor !== undefined && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setZoomFactor(clampZoom(patch.zoomFactor));
    }
    return true;
  });
  ipcMain.handle('stats:get', () => fetchStats());
  ipcMain.handle('stream:status', () => ({ connected: streamConnected, mode }));
  ipcMain.handle('app:openUserData', () => shell.openPath(app.getPath('userData')));
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:close', () => mainWindow?.close());
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', stopAll);
