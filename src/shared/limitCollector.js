'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appVersion } = require('./appVersion');
const { DEFAULT_LIMITS_REFRESH_MS, normalizeLimitProvider, normalizeLimitsSummary } = require('./limits');
const cursorAuth = require('./cursorAuth');
const cursorProbe = require('./cursorProbe');
const antigravityProbe = require('./antigravityProbe');
const opencodeLimits = require('./opencodeLimits');
const opencodeWeb = require('./opencodeWeb');

const LIMIT_PROVIDER_IDS = ['claude', 'codex', 'cursor', 'antigravity', 'opencode'];
const LIMIT_REFRESH_VALUES = new Set([60_000, 120_000, 300_000, 900_000, 1_800_000]);
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const CLAUDE_SESSION_WINDOW_MINUTES = 5 * 60;
const CLAUDE_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const TOKEN_MONITOR_USER_AGENT = `token-monitor/${appVersion()} (+https://github.com/Javis603/token-monitor)`;

function nowIso(nowMs) {
  return new Date(nowMs).toISOString();
}

function parseBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function parseLimitProviders(value) {
  const isEmpty = value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0);
  const source = isEmpty ? 'claude,codex,cursor,antigravity,opencode' : value;
  const raw = Array.isArray(source) ? source : String(source).split(',');
  const seen = new Set();
  const providers = [];
  for (const item of raw) {
    const provider = String(item || '').trim().toLowerCase();
    if (!LIMIT_PROVIDER_IDS.includes(provider) || seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }
  return providers;
}

function normalizeLimitsRefreshMs(value) {
  const parsed = Number(value);
  if (LIMIT_REFRESH_VALUES.has(parsed)) return parsed;
  return DEFAULT_LIMITS_REFRESH_MS;
}

function hashKey(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(String(part || '')).update('\0');
  return `sha256:${hash.digest('hex')}`;
}

function errorWithStatus(status, message) {
  const error = new Error(message || status);
  error.status = status;
  return error;
}

function shouldTryClaudeCliFallback(error) {
  return ['sourceRateLimited', 'unavailable', 'error'].includes(error?.status);
}

async function readJsonFile(filePath, deps) {
  const readFile = deps.readFile || fs.promises.readFile;
  const text = await readFile(filePath, 'utf8');
  return JSON.parse(text);
}

function claudeCredentialPath(env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, '.credentials.json');
}

function normalizeExpiresAt(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 20_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function listWslDistros(deps = {}) {
  const readdirSync = deps.readdirSync || fs.readdirSync;
  try {
    return readdirSync('\\\\wsl$').filter((name) => name && !name.startsWith('.') && !name.includes('$'));
  } catch (_) {
    return [];
  }
}

function wslClaudeCredentialPaths(deps = {}) {
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const paths = [];
  for (const distro of listWslDistros(deps)) {
    const homeDir = `\\\\wsl$\\${distro}\\home`;
    let users;
    try { users = readdirSync(homeDir); } catch (_) { continue; }
    for (const user of users) {
      paths.push(`\\\\wsl$\\${distro}\\home\\${user}\\.claude\\.credentials.json`);
    }
  }
  return paths;
}

async function rankClaudeCredentialFiles(deps = {}) {
  const env = deps.env || process.env;
  const statFn = deps.stat || fs.promises.stat;
  const platform = deps.platform || process.platform;
  const candidates = [];
  const nativePath = deps.claudeCredentialPath || claudeCredentialPath(env);
  candidates.push({
    path: nativePath,
    identityLabel: env.CLAUDE_CONFIG_DIR ? 'CLAUDE_CONFIG_DIR/.credentials.json' : '~/.claude/.credentials.json'
  });
  if (platform === 'win32' && !env.CLAUDE_CONFIG_DIR) {
    for (const wslPath of wslClaudeCredentialPaths(deps)) {
      candidates.push({
        path: wslPath,
        identityLabel: `wsl:${wslPath.slice(7).replace(/\\\.claude\\\.credentials\.json$/, '')}`
      });
    }
  }
  const stamped = [];
  for (const candidate of candidates) {
    try {
      const stats = await statFn(candidate.path);
      stamped.push({ ...candidate, mtimeMs: stats.mtimeMs });
    } catch (_) {}
  }
  return stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function codexAuthPath(env = process.env) {
  const base = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(base, 'auth.json');
}

function envValue(env = {}, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function pathApiForPlatform(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function displayPlanWord(word) {
  const raw = String(word || '');
  const lower = raw.toLowerCase();
  if (['ai', 'api', 'cbp', 'gpt', 'k12'].includes(lower)) return lower.toUpperCase();
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function cleanPlanText(text, prefixes = ['claude', 'chatgpt', 'openai']) {
  const raw = String(text || '').trim();
  if (!raw || raw.includes('@')) return '';
  const prefixPattern = prefixes.length > 0 ? new RegExp(`^(?:${prefixes.join('|')})[\\s_-]+`, 'i') : null;
  let clean = raw;
  while (prefixPattern && prefixPattern.test(clean)) clean = clean.replace(prefixPattern, '');
  return clean
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function displayPlanText(raw, maxWords = 3) {
  const words = String(raw || '').split(/\s+/).filter(Boolean);
  const visible = Number.isFinite(maxWords) ? words.slice(0, maxWords) : words;
  return visible.map(displayPlanWord).join(' ');
}

function planLabelFromParts(...parts) {
  const text = parts.map((part) => String(part || '')).find(Boolean) || '';
  const raw = cleanPlanText(text);
  if (!raw || raw.includes('@')) return '';
  const aliases = {
    free: 'Free',
    plus: 'Plus',
    pro: 'Pro',
    max: 'Max',
    team: 'Team',
    teams: 'Team',
    enterprise: 'Enterprise',
    ultra: 'Ultra'
  };
  if (aliases[raw]) return aliases[raw];
  return displayPlanText(raw);
}

function claudeRateLimitTierLabel(rateLimitTier) {
  const raw = cleanPlanText(rateLimitTier, []);
  if (!raw) return '';
  const words = raw.split(/\s+/).filter((word) => !['default', 'claude', 'ai'].includes(word));
  if (words.length === 0) return '';
  return planLabelFromParts(words.join(' '));
}

function claudePlanLabelFromParts(subscriptionType, rateLimitTier) {
  const subscriptionLabel = planLabelFromParts(subscriptionType);
  const tierLabel = claudeRateLimitTierLabel(rateLimitTier);
  if (subscriptionLabel === 'Max' && /^Max\s+(?:5x|20x)$/i.test(tierLabel)) return tierLabel;
  return subscriptionLabel || tierLabel;
}

function codexPlanLabelFromParts(...parts) {
  const text = parts.map((part) => String(part || '').trim()).find(Boolean) || '';
  if (!text || text.includes('@')) return '';
  const exact = {
    pro: 'Pro 20x',
    prolite: 'Pro 5x',
    pro_lite: 'Pro 5x',
    'pro-lite': 'Pro 5x',
    'pro lite': 'Pro 5x'
  };
  const raw = text.toLowerCase();
  if (exact[raw]) return exact[raw];
  const cleaned = cleanPlanText(text, ['codex', 'chatgpt', 'openai']);
  if (!cleaned) return '';
  if (exact[cleaned]) return exact[cleaned];
  const aliases = {
    free: 'Free',
    plus: 'Plus',
    max: 'Max',
    team: 'Team',
    teams: 'Team',
    enterprise: 'Enterprise',
    'enterprise cbp usage based': 'Enterprise',
    'self serve business usage based': 'Business'
  };
  if (aliases[cleaned]) return aliases[cleaned];
  return displayPlanText(cleaned, Infinity);
}

function antigravityPlanLabelFromParts(...parts) {
  const text = parts.map((part) => String(part || '').trim()).find(Boolean) || '';
  const raw = cleanPlanText(text, ['google', 'ai']);
  if (!raw) return '';
  return planLabelFromParts(raw);
}

function extractClaudeOauth(credentials) {
  return credentials?.claudeAiOauth || credentials?.oauth || credentials || null;
}

async function readClaudeCredentials(deps = {}) {
  const env = deps.env || process.env;
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      source: 'env',
      accessToken: String(env.CLAUDE_CODE_OAUTH_TOKEN),
      refreshToken: null,
      expiresAt: null,
      identity: 'env:CLAUDE_CODE_OAUTH_TOKEN',
      accountLabel: ''
    };
  }

  for (const candidate of await rankClaudeCredentialFiles(deps)) {
    try {
      const raw = await readJsonFile(candidate.path, deps);
      const fileShape = raw && typeof raw === 'object' && raw.claudeAiOauth ? 'claudeAiOauth' : 'root';
      const oauth = extractClaudeOauth(raw);
      if (oauth?.accessToken) {
        return {
          source: 'file',
          filePath: candidate.path,
          fileShape,
          accessToken: String(oauth.accessToken),
          refreshToken: oauth.refreshToken ? String(oauth.refreshToken) : null,
          expiresAt: normalizeExpiresAt(oauth.expiresAt),
          identity: `path:${candidate.identityLabel}:${oauth.subscriptionType || ''}:${oauth.rateLimitTier || ''}`,
          accountLabel: claudePlanLabelFromParts(oauth.subscriptionType, oauth.rateLimitTier)
        };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') continue;
    }
  }

  if ((deps.platform || process.platform) === 'darwin' && deps.readMacKeychain !== false) {
    const text = await readMacKeychainSecret('Claude Code-credentials', deps).catch(() => '');
    if (text) {
      const oauth = extractClaudeOauth(JSON.parse(text));
      if (oauth?.accessToken) {
        return {
          source: 'keychain',
          accessToken: String(oauth.accessToken),
          refreshToken: oauth.refreshToken ? String(oauth.refreshToken) : null,
          expiresAt: normalizeExpiresAt(oauth.expiresAt),
          identity: `keychain:Claude Code-credentials:${oauth.subscriptionType || ''}:${oauth.rateLimitTier || ''}`,
          accountLabel: claudePlanLabelFromParts(oauth.subscriptionType, oauth.rateLimitTier)
        };
      }
    }
  }

  throw errorWithStatus('notConfigured', 'Claude credentials not found');
}

function readMacKeychainSecret(service, deps = {}) {
  const spawnFn = deps.spawn || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnFn('security', ['find-generic-password', '-s', service, '-w'], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('macOS keychain lookup timed out'));
    }, 5000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `security exited ${code}`));
      else resolve(stdout.trim());
    });
  });
}

function runProcessText(command, args = [], options = {}) {
  const spawnFn = options.spawn || spawn;
  const timeoutMs = Number(options.timeoutMs || 30000);
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      reject(errorWithStatus('unavailable', `${command} timed out`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout);
      else reject(errorWithStatus('unavailable', stderr.trim() || `${command} exited ${code}`));
    });
  });
}

async function fetchJson(url, headers, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchFn(url, { headers, ...(controller ? { signal: controller.signal } : {}) });
    if (!response.ok) {
      const status = response.status === 401 ? 'unauthorized' : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw errorWithStatus(status, `${url} returned ${response.status}`);
    }
    return response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw errorWithStatus('unavailable', `${url} timed out`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mapClaudeUsageToProvider(usage, meta = {}) {
  const windows = [];
  if (usage?.five_hour) {
    windows.push({
      kind: 'session',
      usedPercent: usage.five_hour.utilization,
      resetsAt: usage.five_hour.resets_at
    });
  }
  if (usage?.seven_day) {
    windows.push({
      kind: 'weekly',
      usedPercent: usage.seven_day.utilization,
      resetsAt: usage.seven_day.resets_at
    });
  }
  return normalizeLimitProvider({
    provider: 'claude',
    accountKey: meta.accountKey || '',
    accountLabel: meta.accountLabel || '',
    source: meta.source || 'oauth',
    status: 'ok',
    updatedAt: meta.updatedAt,
    windows
  });
}

async function refreshClaudeAccessToken(refreshToken, deps = {}) {
  if (!refreshToken) throw errorWithStatus('unauthorized', 'No refresh token available');
  const fetchFn = deps.fetch || fetch;
  const url = deps.claudeTokenUrl || CLAUDE_OAUTH_TOKEN_URL;
  const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID
  });
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': TOKEN_MONITOR_USER_AGENT
      },
      body: body.toString(),
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) {
      const status = response.status === 400 || response.status === 401 ? 'unauthorized'
        : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      throw errorWithStatus(status, `oauth/token returned ${response.status}`);
    }
    const json = await response.json();
    const nowMs = (deps.now || Date.now)();
    const lifetimeSec = Math.max(60, Number(json.expires_in) || 3600);
    return {
      accessToken: String(json.access_token),
      refreshToken: json.refresh_token ? String(json.refresh_token) : refreshToken,
      expiresAt: nowMs + lifetimeSec * 1000
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw errorWithStatus('unavailable', 'oauth/token timed out');
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeClaudeCredentials(filePath, fileShape, updated, deps = {}) {
  const readFile = deps.readFile || fs.promises.readFile;
  const writeFile = deps.writeFile || fs.promises.writeFile;
  const rename = deps.rename || fs.promises.rename;
  let existing;
  try {
    existing = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (_) { return false; }
  if (!existing || typeof existing !== 'object') return false;
  if (fileShape === 'claudeAiOauth') {
    existing.claudeAiOauth = { ...(existing.claudeAiOauth || {}), ...updated };
  } else {
    Object.assign(existing, updated);
  }
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
    await rename(tmpPath, filePath);
    return true;
  } catch (_) {
    try { await (deps.unlink || fs.promises.unlink)(tmpPath); } catch (__) {}
    return false;
  }
}

async function persistClaudeRefresh(credentials, refreshed, deps = {}) {
  if (credentials.source !== 'file' || !credentials.filePath) return;
  await writeClaudeCredentials(credentials.filePath, credentials.fileShape, refreshed, deps).catch(() => {});
}

function callClaudeUsage(accessToken, deps = {}) {
  return fetchJson(CLAUDE_USAGE_URL, {
    accept: 'application/json',
    authorization: `Bearer ${accessToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'user-agent': TOKEN_MONITOR_USER_AGENT
  }, deps);
}

async function delegatedClaudeRefresh(currentCredentials, deps = {}) {
  // Spawn `claude /status` in a PTY and let Claude Code itself refresh the token.
  // Matches CodexBar's strategy — Claude Code is a native Anthropic application,
  // so OAuth credential use stays within sanctioned channels. Best-effort: if the
  // probe fails we still re-read in case Claude Code touched the credentials.
  await touchClaudeAuthPath(deps).catch(() => null);
  const fresh = await readClaudeCredentials(deps);
  if (!fresh.accessToken || fresh.accessToken === currentCredentials.accessToken) {
    throw errorWithStatus('unauthorized', 'Claude Code did not refresh the OAuth token');
  }
  return fresh;
}

async function refreshClaudeCredentials(currentCredentials, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === 'darwin') return delegatedClaudeRefresh(currentCredentials, deps);
  if (!currentCredentials.refreshToken) {
    throw errorWithStatus('unauthorized', 'No refresh token available');
  }
  const refreshed = await refreshClaudeAccessToken(currentCredentials.refreshToken, deps);
  await persistClaudeRefresh(currentCredentials, refreshed, deps);
  return { ...currentCredentials, ...refreshed };
}

async function fetchClaudeLimits(options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const platform = deps.platform || process.platform;
  try {
    let credentials = await readClaudeCredentials(deps);

    // Proactive refresh only on non-darwin: mac uses delegated (spawning Claude Code)
    // which is expensive; CodexBar's design likewise refreshes reactively, not on expiry.
    if (platform !== 'darwin' && credentials.refreshToken && credentials.expiresAt
      && credentials.expiresAt - nowMs < CLAUDE_REFRESH_LEEWAY_MS) {
      try {
        credentials = await refreshClaudeCredentials(credentials, deps);
      } catch (_) { /* fall through; reactive retry below may still succeed */ }
    }

    let usage;
    try {
      usage = await callClaudeUsage(credentials.accessToken, deps);
    } catch (error) {
      if (error?.status !== 'unauthorized') throw error;
      credentials = await refreshClaudeCredentials(credentials, deps);
      usage = await callClaudeUsage(credentials.accessToken, deps);
    }

    return mapClaudeUsageToProvider(usage, {
      accountKey: hashKey('claude', credentials.identity),
      accountLabel: credentials.accountLabel,
      updatedAt: nowIso(nowMs),
      source: 'oauth'
    });
  } catch (error) {
    if (!shouldTryClaudeCliFallback(error)) throw error;
    try {
      const text = await runClaudeUsageCli(deps);
      return mapClaudeCliUsageToProvider(text, {
        updatedAt: nowIso(nowMs),
        now: new Date(nowMs)
      });
    } catch (_) {
      throw error;
    }
  }
}

function stripAnsiCodes(text) {
  return String(text || '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[78=>][^\x1b]*/g, '');
}

function normalizeForLabelSearch(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9%]+/g, '');
}

function linePercentLeft(line) {
  const match = String(line || '').match(/([0-9]{1,3}(?:\.[0-9]+)?)\s*%/i);
  if (!match) return null;
  const number = Math.max(0, Math.min(100, Number(match[1])));
  const lower = String(line || '').toLowerCase();
  if (lower.includes('used') || lower.includes('spent') || lower.includes('consumed')) return 100 - number;
  if (lower.includes('left') || lower.includes('remaining') || lower.includes('available')) return number;
  return null;
}

function extractClaudePercent(lines, label) {
  const normalizedLabel = normalizeForLabelSearch(label);
  const normalizedLines = lines.map(normalizeForLabelSearch);
  for (let i = 0; i < normalizedLines.length; i += 1) {
    if (!normalizedLines[i].includes(normalizedLabel)) continue;
    for (const line of lines.slice(i, i + 12)) {
      const percentLeft = linePercentLeft(line);
      if (percentLeft !== null && Number.isFinite(percentLeft)) return Math.round(percentLeft);
    }
  }
  return null;
}

function cleanClaudeResetLine(line) {
  const match = String(line || '').match(/resets[^\r\n]*/i);
  if (!match) return '';
  return match[0].replace(/[)\s]+$/g, '').trim();
}

function extractClaudeReset(lines, label) {
  const normalizedLabel = normalizeForLabelSearch(label);
  const normalizedLines = lines.map(normalizeForLabelSearch);
  for (let i = 0; i < normalizedLines.length; i += 1) {
    if (!normalizedLines[i].includes(normalizedLabel)) continue;
    for (const line of lines.slice(i, i + 14)) {
      const normalized = normalizeForLabelSearch(line);
      if (normalized.startsWith('current') && !normalized.includes(normalizedLabel)) break;
      const reset = cleanClaudeResetLine(line);
      if (reset) return reset;
    }
  }
  return '';
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11
};

function parseClock(hourText, minuteText, meridiem) {
  let hour = Number(hourText);
  const minute = minuteText === undefined || minuteText === '' ? 0 : Number(minuteText);
  const suffix = String(meridiem || '').toLowerCase();
  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

function parseClaudeResetDate(text, now = new Date()) {
  let raw = String(text || '').trim();
  if (!raw) return null;
  raw = raw.replace(/^resets?:?\s*/i, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\bat\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;

  const timeOnly = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (timeOnly) {
    const { hour, minute } = parseClock(timeOnly[1], timeOnly[2], timeOnly[3]);
    const date = new Date(now);
    date.setHours(hour, minute, 0, 0);
    if (date <= now) date.setDate(date.getDate() + 1);
    return date.toISOString();
  }

  const monthDate = raw.match(/^([a-z]{3,4})\s+(\d{1,2})(?:,?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (monthDate) {
    const month = MONTHS[monthDate[1].toLowerCase()];
    if (month === undefined) return null;
    const date = new Date(now);
    date.setMonth(month, Number(monthDate[2]));
    if (monthDate[3]) {
      const { hour, minute } = parseClock(monthDate[3], monthDate[4], monthDate[5]);
      date.setHours(hour, minute, 0, 0);
    } else {
      date.setHours(0, 0, 0, 0);
    }
    if (date <= now) date.setFullYear(date.getFullYear() + 1);
    return date.toISOString();
  }
  return null;
}

function parseClaudeCliUsageText(text, now = new Date()) {
  const clean = stripAnsiCodes(text);
  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const sessionPercentLeft = extractClaudePercent(lines, 'Current session');
  const weeklyPercentLeft = extractClaudePercent(lines, 'Current week');
  const primaryResetDescription = extractClaudeReset(lines, 'Current session');
  const secondaryResetDescription = extractClaudeReset(lines, 'Current week');
  const accountEmail = (clean.match(/(?:Account|Email):\s*([^\s@]+@[^\s@]+)/i) || [])[1] || '';
  const accountOrganization = ((clean.match(/(?:Org|Organization):\s*(.+)/i) || [])[1] || '').trim();
  const accountLabel = planLabelFromParts((clean.match(/(?:Plan|Subscription):\s*([A-Za-z][A-Za-z0-9 _-]{0,30})/i) || [])[1] || '');
  if (sessionPercentLeft === null) throw errorWithStatus('unavailable', 'Claude CLI usage missing current session');
  return {
    sessionPercentLeft,
    weeklyPercentLeft,
    primaryResetDescription,
    secondaryResetDescription,
    primaryResetsAt: parseClaudeResetDate(primaryResetDescription, now),
    secondaryResetsAt: parseClaudeResetDate(secondaryResetDescription, now),
    accountLabel,
    accountKey: [accountEmail, accountOrganization].filter(Boolean).join('|') || 'claude-cli'
  };
}

function cliWindow(kind, percentLeft, resetDescription, resetsAt, windowMinutes) {
  if (percentLeft === null || percentLeft === undefined) return null;
  return {
    kind,
    usedPercent: Math.max(0, Math.min(100, 100 - Number(percentLeft))),
    resetsAt,
    resetDescription,
    windowMinutes
  };
}

function mapClaudeCliUsageToProvider(text, meta = {}) {
  const parsed = parseClaudeCliUsageText(text, meta.now || new Date());
  const windows = [
    cliWindow('session', parsed.sessionPercentLeft, parsed.primaryResetDescription, parsed.primaryResetsAt, CLAUDE_SESSION_WINDOW_MINUTES),
    cliWindow('weekly', parsed.weeklyPercentLeft, parsed.secondaryResetDescription, parsed.secondaryResetsAt, CLAUDE_WEEKLY_WINDOW_MINUTES)
  ].filter(Boolean);
  return normalizeLimitProvider({
    provider: 'claude',
    accountKey: hashKey('claude-cli', parsed.accountKey),
    accountLabel: parsed.accountLabel,
    source: 'cli',
    status: 'ok',
    updatedAt: meta.updatedAt,
    windows
  });
}

function claudeCommandCandidates(env = process.env) {
  if (env.TOKEN_MONITOR_CLAUDE_COMMAND) return [env.TOKEN_MONITOR_CLAUDE_COMMAND];
  return ['claude'];
}

function claudePtyPythonScript() {
  return `
import fcntl, os, pty, re, select, signal, subprocess, sys, time
cmd = os.environ.get("TOKEN_MONITOR_CLAUDE_COMMAND_PATH", "claude")
cwd = os.environ.get("TOKEN_MONITOR_CLAUDE_PROBE_DIR") or os.getcwd()
timeout = float(os.environ.get("TOKEN_MONITOR_CLAUDE_CLI_TIMEOUT", "35"))
slash_command = os.environ.get("TOKEN_MONITOR_CLAUDE_SLASH_COMMAND", "/usage")
exit_marker = os.environ.get("TOKEN_MONITOR_CLAUDE_EXIT_MARKER_REGEX", "currentsession.*?[0-9]{1,3}(?:\\\\.[0-9]+)?%")
exit_pattern = re.compile(exit_marker) if exit_marker else None
os.makedirs(os.path.join(cwd, ".claude"), exist_ok=True)
settings_path = os.path.join(cwd, ".claude", "settings.local.json")
if not os.path.exists(settings_path):
    open(settings_path, "w").write('{"disableDeepLinkRegistration":"disable"}\\n')
master, slave = pty.openpty()
proc = subprocess.Popen([cmd, "--allowed-tools", ""], stdin=slave, stdout=slave, stderr=slave, cwd=cwd, close_fds=True, start_new_session=True)
os.close(slave)
fcntl.fcntl(master, fcntl.F_SETFL, os.O_NONBLOCK)
ansi = re.compile(rb"\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b[()][A-Za-z0-9]|\\x1b[78=>][^\\x1b]*")
def compact(data):
    text = ansi.sub(b"", data).decode("utf-8", "ignore").lower()
    return re.sub(r"[^a-z0-9%]+", "", text)
buf = b""
start = time.time()
last_enter = 0
sent_cmd = False
slash_bytes = (slash_command + "\\r").encode("utf-8")
try:
    while time.time() - start < timeout:
        readable, _, _ = select.select([master], [], [], 0.08)
        if readable:
            try:
                chunk = os.read(master, 8192)
                if chunk:
                    buf += chunk
            except BlockingIOError:
                pass
        scan = compact(buf[-20000:])
        now = time.time()
        if now - last_enter > 0.8 and any(token in scan for token in [
            "quicksafetycheck", "yesitrustthisfolder", "pressentertocontinue",
            "readytocodehere", "showplanusage", "showplan"
        ]):
            os.write(master, b"\\r")
            last_enter = now
        if not sent_cmd and now - start > 5:
            os.write(master, slash_bytes)
            sent_cmd = True
        if sent_cmd and now - last_enter > 0.8:
            os.write(master, b"\\r")
            last_enter = now
        if sent_cmd and exit_pattern is not None and exit_pattern.search(scan):
            time.sleep(2)
            break
    sys.stdout.buffer.write(buf)
finally:
    try:
        os.write(master, b"/exit\\r")
    except Exception:
        pass
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except Exception:
        pass
`.trim();
}

async function runClaudePtyProbe(slashCommand, exitMarkerRegex, deps = {}) {
  if ((deps.platform || process.platform) === 'win32') {
    throw errorWithStatus('unavailable', 'Claude CLI PTY probe is not available on Windows yet');
  }
  const env = deps.env || process.env;
  const command = claudeCommandCandidates(env)[0];
  const probeDir = deps.claudeProbeDir || path.join(os.tmpdir(), 'token-monitor-claude-probe');
  fs.mkdirSync(probeDir, { recursive: true });
  const runEnv = {
    ...env,
    TOKEN_MONITOR_CLAUDE_COMMAND_PATH: command,
    TOKEN_MONITOR_CLAUDE_PROBE_DIR: probeDir,
    TOKEN_MONITOR_CLAUDE_CLI_TIMEOUT: String(deps.claudeCliTimeoutSeconds || 35),
    TOKEN_MONITOR_CLAUDE_SLASH_COMMAND: slashCommand,
    TOKEN_MONITOR_CLAUDE_EXIT_MARKER_REGEX: exitMarkerRegex || ''
  };
  const pythonCandidates = deps.pythonCommand ? [deps.pythonCommand] : ['python3', 'python'];
  let lastError = null;
  for (const python of pythonCandidates) {
    try {
      return await runProcessText(python, ['-c', claudePtyPythonScript()], {
        ...deps,
        env: runEnv,
        cwd: probeDir,
        timeoutMs: Number(deps.claudeCliTimeoutMs || 45000)
      });
    } catch (error) {
      lastError = error;
      if (error.code && error.code !== 'ENOENT') break;
    }
  }
  throw lastError || errorWithStatus('unavailable', 'Python PTY runner unavailable');
}

async function runClaudeUsageCli(deps = {}) {
  if (deps.runClaudeUsageCli) return deps.runClaudeUsageCli();
  return runClaudePtyProbe('/usage', 'currentsession.*?[0-9]{1,3}(?:\\.[0-9]+)?%', deps);
}

async function touchClaudeAuthPath(deps = {}) {
  if (deps.touchClaudeAuthPath) return deps.touchClaudeAuthPath();
  // Spawn `claude /status` in PTY to let Claude Code itself perform an auth check
  // and refresh the OAuth token if needed. We don't parse output — the side-effect
  // (mutated credentials file / Keychain entry) is the signal. Permissive exit
  // marker matches common /status output tokens so we exit promptly on success.
  return runClaudePtyProbe('/status', '(?:loggedin|subscription|account|model|version|email|organization)', {
    ...deps,
    claudeCliTimeoutSeconds: deps.claudeStatusTimeoutSeconds || 20,
    claudeCliTimeoutMs: deps.claudeStatusTimeoutMs || 25000
  });
}

function codexWindowKind(name, window) {
  const mins = Number(window?.windowDurationMins || window?.window_duration_mins || 0);
  if (mins >= 7 * 24 * 60) return 'weekly';
  if (String(name).toLowerCase() === 'secondary') return 'weekly';
  return 'session';
}

function codexRateLimitSnapshot(payload = {}) {
  const rateLimitsById = payload.rateLimitsByLimitId || payload.rate_limits_by_limit_id || {};
  return rateLimitsById.codex || payload.rateLimits || payload.rate_limits || {};
}

function codexAccountLabel(payload = {}) {
  const snapshot = codexRateLimitSnapshot(payload);
  const account = payload.account || {};
  return codexPlanLabelFromParts(
    snapshot.planType,
    snapshot.plan_type,
    account.planType,
    account.plan_type,
    account.loginMethod,
    account.login_method,
    account.plan,
    account.subscription?.planType,
    account.subscription?.plan_type,
    account.subscription?.plan
  );
}

function mapCodexRateLimitsToProvider(payload, meta = {}) {
  const rateLimits = codexRateLimitSnapshot(payload);
  const windows = [];
  for (const key of ['primary', 'secondary']) {
    const window = rateLimits[key];
    if (!window) continue;
    windows.push({
      kind: codexWindowKind(key, window),
      usedPercent: window.usedPercent ?? window.used_percent,
      resetsAt: window.resetsAt ?? window.resets_at,
      windowMinutes: window.windowDurationMins ?? window.window_duration_mins
    });
  }
  return normalizeLimitProvider({
    provider: 'codex',
    accountKey: meta.accountKey || '',
    accountLabel: meta.accountLabel || codexAccountLabel(payload),
    source: meta.source || 'rpc',
    sourceDetail: meta.sourceDetail || payload.sourceDetail,
    status: rateLimits.rateLimitReachedType ? 'rateLimited' : 'ok',
    updatedAt: meta.updatedAt,
    windows
  });
}

async function readCodexAuthIdentity(deps = {}) {
  const env = deps.env || process.env;
  const filePath = deps.codexAuthPath || codexAuthPath(env);
  try {
    const auth = await readJsonFile(filePath, deps);
    const account = auth?.tokens?.id_token || auth?.id_token || auth?.account || auth?.chatgpt || auth;
    return { filePath, auth, account };
  } catch (error) {
    if (error.code === 'ENOENT') throw errorWithStatus('notConfigured', 'Codex auth.json not found');
    throw error;
  }
}

function pathDelimiterForPlatform(platform = process.platform) {
  return platform === 'win32' ? ';' : ':';
}

function withCodexPathHints(env = process.env, platform = process.platform) {
  const delimiter = pathDelimiterForPlatform(platform);
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const currentPath = env[pathKey] || '';
  const pathApi = pathApiForPlatform(platform);
  const hints = [];
  if (platform === 'win32') {
    const appData = envValue(env, 'APPDATA');
    const localAppData = envValue(env, 'LOCALAPPDATA');
    const userProfile = envValue(env, 'USERPROFILE');
    if (appData) hints.push(pathApi.join(appData, 'npm'));
    if (localAppData) {
      hints.push(
        pathApi.join(localAppData, 'pnpm'),
        pathApi.join(localAppData, 'Microsoft', 'WindowsApps')
      );
    }
    if (userProfile) hints.push(pathApi.join(userProfile, '.bun', 'bin'));
  } else {
    hints.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
    if (env.HOME) {
      hints.push(
        path.join(env.HOME, '.npm-global', 'bin'),
        path.join(env.HOME, '.bun', 'bin'),
        path.join(env.HOME, '.local', 'bin')
      );
    }
  }
  return {
    ...env,
    [pathKey]: uniqueStrings([...hints, ...currentPath.split(delimiter)]).join(delimiter)
  };
}

function existingCodexCommandCandidates(candidates, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const pathApi = pathApiForPlatform(deps.platform || process.platform);
  return candidates.filter((candidate) => {
    if (!pathApi.isAbsolute(candidate)) return true;
    return existsSync(candidate);
  });
}

function codexSpawnSpec(command, platform = process.platform) {
  const args = ['-s', 'read-only', '-a', 'untrusted', 'app-server'];
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) {
    return { command, args };
  }
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', [quoteWindowsCmdArg(command), ...args.map(quoteWindowsCmdArg)].join(' ')]
  };
}

function quoteWindowsCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=\\-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function spawnCodexAppServer(deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const command = deps.codexCommand || existingCodexCommandCandidates(codexCommandCandidates(env, platform, deps), deps)[0];
  if (!command) throw errorWithStatus('notConfigured', 'Codex CLI not found');
  const spec = codexSpawnSpec(command, platform);
  return spawnFn(spec.command, spec.args, {
    windowsHide: true,
    env: withCodexPathHints(env, platform)
  });
}

function codexRpcCommandCandidates(deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  if (deps.codexCommand) return [deps.codexCommand];
  return existingCodexCommandCandidates(codexCommandCandidates(env, platform, deps), deps);
}

function windowsCodexBinCandidates(binDir, deps = {}) {
  const pathApi = pathApiForPlatform('win32');
  const candidates = [pathApi.join(binDir, 'codex.exe')];
  const readdirSync = deps.readdirSync || fs.readdirSync;
  let entries = [];
  try {
    entries = readdirSync(binDir, { withFileTypes: true });
  } catch (_) {
    return candidates;
  }
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof entry?.isDirectory === 'function' && !entry.isDirectory()) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(name || '')) continue;
    candidates.push(pathApi.join(binDir, name, 'codex.exe'));
  }
  return candidates;
}

function windowsCodexPackageVersion(name) {
  const match = /^OpenAI\.Codex_(\d+(?:\.\d+)*)_/.exec(String(name || ''));
  if (!match) return [];
  return match[1].split('.').map((part) => Number(part) || 0);
}

function compareWindowsCodexPackages(a, b) {
  const aName = typeof a === 'string' ? a : a?.name;
  const bName = typeof b === 'string' ? b : b?.name;
  const aVersion = windowsCodexPackageVersion(aName);
  const bVersion = windowsCodexPackageVersion(bName);
  const length = Math.max(aVersion.length, bVersion.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (bVersion[i] || 0) - (aVersion[i] || 0);
    if (diff) return diff;
  }
  return String(aName || '').localeCompare(String(bName || ''));
}

function windowsCodexStoreCandidates(env = process.env, deps = {}) {
  const pathApi = pathApiForPlatform('win32');
  const candidates = [];
  const localAppData = envValue(env, 'LOCALAPPDATA');
  if (localAppData) {
    candidates.push(...windowsCodexBinCandidates(pathApi.join(localAppData, 'OpenAI', 'Codex', 'bin'), deps));
    const packagesDir = pathApi.join(localAppData, 'Packages');
    let packageEntries = [];
    try {
      packageEntries = (deps.readdirSync || fs.readdirSync)(packagesDir, { withFileTypes: true });
    } catch (_) {}
    for (const entry of packageEntries.sort(compareWindowsCodexPackages)) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (typeof entry?.isDirectory === 'function' && !entry.isDirectory()) continue;
      if (!/^OpenAI\.Codex_[^\\/:*?"<>|]+$/.test(name || '')) continue;
      candidates.push(...windowsCodexBinCandidates(
        pathApi.join(packagesDir, name, 'LocalCache', 'Local', 'OpenAI', 'Codex', 'bin'),
        deps
      ));
    }
    const aliasDir = pathApi.join(localAppData, 'Microsoft', 'WindowsApps');
    candidates.push(pathApi.join(aliasDir, 'codex.exe'), pathApi.join(aliasDir, 'Codex.exe'));
  }

  const readdirSync = deps.readdirSync || fs.readdirSync;
  for (const root of uniqueStrings([
    envValue(env, 'PROGRAMFILES'),
    envValue(env, 'ProgramW6432')
  ])) {
    const appxDir = pathApi.join(root, 'WindowsApps');
    let entries = [];
    try {
      entries = readdirSync(appxDir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries.sort(compareWindowsCodexPackages)) {
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (typeof entry?.isDirectory === 'function' && !entry.isDirectory()) continue;
      if (!/^OpenAI\.Codex_[^\\/:*?"<>|]+$/.test(name || '')) continue;
      candidates.push(
        pathApi.join(appxDir, name, 'app', 'resources', 'codex.exe'),
        pathApi.join(appxDir, name, 'app', 'Codex.exe')
      );
    }
  }
  return candidates;
}

function codexCommandCandidates(env = process.env, platform = process.platform, deps = {}) {
  if (env.TOKEN_MONITOR_CODEX_COMMAND) return [env.TOKEN_MONITOR_CODEX_COMMAND];
  const pathApi = pathApiForPlatform(platform);
  const candidates = [];
  if (platform === 'darwin') {
    candidates.push('/Applications/Codex.app/Contents/Resources/codex');
  } else if (platform === 'win32') {
    const localAppData = envValue(env, 'LOCALAPPDATA');
    const programFiles = envValue(env, 'PROGRAMFILES');
    const programFilesX86 = envValue(env, 'PROGRAMFILES(X86)');
    const appData = envValue(env, 'APPDATA');
    if (localAppData) candidates.push(pathApi.join(localAppData, 'Programs', 'Codex', 'resources', 'codex.exe'));
    if (programFiles) candidates.push(pathApi.join(programFiles, 'Codex', 'resources', 'codex.exe'));
    if (programFilesX86) candidates.push(pathApi.join(programFilesX86, 'Codex', 'resources', 'codex.exe'));
    candidates.push(...windowsCodexStoreCandidates(env, deps));
    if (appData) candidates.push(pathApi.join(appData, 'npm', 'codex.cmd'));
    candidates.push('codex.cmd', 'codex.exe');
    if (localAppData) candidates.push(pathApi.join(localAppData, 'Programs', 'Codex', 'Codex.exe'));
  }
  candidates.push('codex');
  return uniqueStrings(candidates);
}

function codexCommandSourceDetail(command, platform = process.platform) {
  const raw = String(command || '').trim();
  if (!raw) return 'unknown';
  const normalized = raw.replace(/\\/g, '/').toLowerCase();

  if (normalized.includes('/codex.app/')) return 'app';
  if (platform === 'win32') {
    if (
      normalized.includes('/programs/codex/') ||
      normalized.includes('/openai/codex/bin/') ||
      normalized.includes('/packages/openai.codex_') ||
      normalized.includes('/windowsapps/openai.codex_') ||
      normalized.includes('/microsoft/windowsapps/')
    ) {
      return 'app';
    }
    if (
      normalized === 'codex' ||
      normalized === 'codex.cmd' ||
      normalized === 'codex.exe' ||
      normalized.includes('/npm/codex.cmd') ||
      normalized.includes('/node_modules/@openai/codex/') ||
      normalized.includes('/.bun/bin/codex.exe')
    ) {
      return 'cli';
    }
  }
  if (/(^|\/)codex(\.cmd|\.exe)?$/.test(normalized)) return 'cli';
  return 'unknown';
}

function createJsonRpcClient(child, timeoutMs) {
  let nextId = 1;
  let buffer = '';
  let closed = false;
  const pending = new Map();

  function rejectAll(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  function handleMessage(message) {
    if (!message || message.id === undefined || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
    else resolve(message.result);
  }

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try { handleMessage(JSON.parse(line)); } catch (_) {}
    }
  });
  child.on('error', (error) => {
    closed = true;
    rejectAll(error);
  });
  child.on('close', (code) => {
    closed = true;
    rejectAll(new Error(`codex app-server exited ${code}`));
  });

  function send(method, params) {
    if (closed) return Promise.reject(new Error('codex app-server is closed'));
    const id = nextId++;
    const message = params === undefined ? { method, id } : { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  function notify(method, params) {
    if (!closed) child.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
  }

  return { send, notify, rejectAll };
}

function shouldTryNextCodexCommand(error) {
  if (error?.code === 'ENOENT') return true;
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('app-server exited') ||
    message.includes('initialize timed out') ||
    message.includes('enoent') ||
    message.includes('not recognized') ||
    message.includes('not found')
  );
}

async function readCodexRpcWithCommand(command, deps = {}) {
  const timeoutMs = Number(deps.codexRpcTimeoutMs || 12000);
  const child = spawnCodexAppServer({ ...deps, codexCommand: command });
  const rpc = createJsonRpcClient(child, timeoutMs);
  try {
    await rpc.send('initialize', {
      clientInfo: { name: 'token-monitor', title: 'Token Monitor', version: appVersion() }
    });
    rpc.notify('initialized', {});
    const rateLimitResult = await rpc.send('account/rateLimits/read');
    const accountResult = await rpc.send('account/read').catch(() => null);
    const account = accountResult?.account || null;
    const rateLimitsByLimitId = rateLimitResult?.rateLimitsByLimitId || rateLimitResult?.rate_limits_by_limit_id || {};
    const rateLimits = rateLimitResult?.rateLimits || rateLimitResult?.rate_limits || rateLimitsByLimitId.codex || {};
    if (!account && !rateLimits?.primary && !rateLimits?.secondary) {
      throw errorWithStatus('notConfigured', 'Codex account not configured');
    }
    return {
      account,
      rateLimits,
      rateLimitsByLimitId,
      sourceDetail: codexCommandSourceDetail(command, deps.platform || process.platform)
    };
  } finally {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
}

async function readCodexRpc(deps = {}) {
  const commands = codexRpcCommandCandidates(deps);
  if (commands.length === 0) throw errorWithStatus('notConfigured', 'Codex CLI not found');
  let lastError = null;
  for (const command of commands) {
    try {
      return await readCodexRpcWithCommand(command, deps);
    } catch (error) {
      lastError = error;
      if (deps.codexCommand || !shouldTryNextCodexCommand(error)) throw error;
    }
  }
  throw lastError || errorWithStatus('notConfigured', 'Codex CLI not found');
}

async function fetchCodexLimits(options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const payload = await readCodexRpc(deps);
  const identity = payload.account?.email || `${payload.account?.type || 'account'}:${payload.account?.planType || ''}:${deps.codexAuthPath || codexAuthPath(deps.env || process.env)}`;
  return mapCodexRateLimitsToProvider(payload, {
    accountKey: hashKey('codex', identity),
    accountLabel: codexAccountLabel(payload),
    updatedAt: nowIso(nowMs),
    source: 'rpc',
    sourceDetail: payload.sourceDetail
  });
}

async function fetchAntigravityLimits(options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const updatedAt = nowIso(nowMs);
  const probeFn = deps.antigravityProbe || antigravityProbe.probe;
  try {
    const snapshot = await probeFn(deps);
    const accountLabel = snapshot.accountPlan ? antigravityPlanLabelFromParts(snapshot.accountPlan) : '';
    const accountKeySeed = snapshot.accountEmail || snapshot.accountPlan || 'default';
    const windows = (snapshot.pools || []).map((pool) => ({
      kind: 'weekly',
      label: pool.name,
      usedPercent: Math.max(0, Math.min(100, (1 - pool.remainingFraction) * 100)),
      resetsAt: pool.resetTime || null,
      windowMinutes: null
    }));
    return normalizeLimitProvider({
      provider: 'antigravity',
      accountKey: hashKey('antigravity', accountKeySeed),
      accountLabel,
      source: 'rpc',
      status: 'ok',
      updatedAt,
      windows
    });
  } catch (err) {
    return normalizeLimitProvider({
      provider: 'antigravity',
      accountKey: '',
      accountLabel: '',
      source: 'rpc',
      status: providerStatusFromError(err),
      updatedAt,
      windows: []
    });
  }
}

async function fetchOpenCodeLimits(options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const updatedAt = nowIso(nowMs);
  const collectGo = deps.opencodeCollectGo || ((d) => opencodeLimits.collectGo(d));
  const fetchGoWeb = deps.opencodeFetchGoWeb || ((cookie, d) => opencodeWeb.fetchGoWeb(cookie, d));
  const fetchZen = deps.opencodeFetchZen || ((cookie, d) => opencodeWeb.fetchZen(cookie, d));

  const windows = [];
  let status = 'notConfigured';
  let source = 'local';
  let accountLabel = '';
  let accountKey = '';
  let balanceUsd = null;

  const goLocal = collectGo({ env: deps.env || process.env, now: () => nowMs });

  const cookie = options.opencodeCookie;
  let goWeb = null;
  let zen = null;
  if (cookie) {
    goWeb = await fetchGoWeb(cookie, { now: () => nowMs });
    // Reuse the workspace goWeb already resolved so Zen doesn't resolve it twice.
    zen = await fetchZen(cookie, { now: () => nowMs, workspaceId: (goWeb && goWeb.workspaceId) || '' });
  }

  // Go usage windows: web (real %) preferred, local estimate fallback. Source is
  // chosen wholesale — never mix web + local — so all Go windows agree.
  if (goWeb && goWeb.status === 'ok' && goWeb.windows.length > 0) {
    windows.push(...goWeb.windows);
    status = 'ok'; source = 'web'; accountLabel = 'Go';
    accountKey = hashKey('opencode', `go:${goWeb.workspaceId || ''}`);
  } else if (goLocal.status === 'ok') {
    windows.push(...goLocal.windows);
    status = 'ok'; accountLabel = 'Go';
    accountKey = hashKey('opencode', goLocal.identity || 'go');
  } else if (goLocal.status === 'unavailable') {
    status = 'unavailable';
  }

  // Zen: prepaid balance always; its session/weekly fill any kinds Go lacked.
  if (zen && zen.status === 'ok') {
    windows.push(...zen.windows);
    status = 'ok'; source = 'web';
    if (typeof zen.balanceUsd === 'number' && Number.isFinite(zen.balanceUsd)) balanceUsd = zen.balanceUsd;
    if (!accountLabel) accountLabel = 'Zen';
    if (!accountKey) accountKey = hashKey('opencode', `zen:${zen.workspaceId || ''}`);
  } else if (status !== 'ok') {
    // No usable data anywhere — surface the most informative web failure.
    const webFail = ['unauthorized', 'sourceRateLimited', 'unavailable'];
    const surfaced = (goWeb && webFail.includes(goWeb.status) && goWeb.status)
      || (zen && webFail.includes(zen.status) && zen.status);
    if (surfaced) { status = surfaced; source = 'web'; }
  }

  return normalizeLimitProvider({ provider: 'opencode', accountKey, accountLabel, source, status, updatedAt, windows, balanceUsd });
}

function providerStatusFromError(error) {
  if (['disabled', 'notConfigured', 'unauthorized', 'rateLimited', 'sourceRateLimited', 'unavailable', 'error'].includes(error?.status)) return error.status;
  if (error?.code === 'ENOENT') return 'notConfigured';
  return 'unavailable';
}

function statusProvider(provider, status, updatedAt) {
  return normalizeLimitProvider({ provider, status, updatedAt, windows: [] });
}

async function collectLimitsOnce(options = {}, deps = {}) {
  const enabled = parseBoolean(options.limitsEnabled ?? options.enabled, true);
  const refreshMs = normalizeLimitsRefreshMs(options.limitsRefreshMs ?? options.refreshMs);
  const nowMs = (deps.now || Date.now)();
  if (!enabled) return normalizeLimitsSummary({ updatedAt: nowIso(nowMs), refreshMs, providers: [] });

  const fetchers = {
    claude: (providerOptions) => fetchClaudeLimits(providerOptions, deps),
    codex: (providerOptions) => fetchCodexLimits(providerOptions, deps),
    cursor: (providerOptions) => fetchCursorLimits(providerOptions, deps),
    antigravity: (providerOptions) => fetchAntigravityLimits(providerOptions, deps),
    opencode: (providerOptions) => fetchOpenCodeLimits(providerOptions, deps),
    ...(deps.providerFetchers || {})
  };
  const providers = [];
  for (const provider of parseLimitProviders(options.limitProviders ?? options.providers)) {
    try {
      providers.push(await fetchers[provider](options));
    } catch (error) {
      providers.push(statusProvider(provider, providerStatusFromError(error), nowIso(nowMs)));
    }
  }
  return normalizeLimitsSummary({ updatedAt: nowIso(nowMs), refreshMs, providers });
}

function createLimitsCollector(options = {}, deps = {}) {
  const refreshMs = normalizeLimitsRefreshMs(options.limitsRefreshMs ?? options.refreshMs);
  let cached = null;
  let cachedAt = 0;
  let inFlight = null;

  async function snapshot(force = false) {
    const current = (deps.now || Date.now)();
    if (!force && cached && current - cachedAt < refreshMs) return cached;
    if (inFlight) return inFlight;
    inFlight = collectLimitsOnce({ ...options, limitsRefreshMs: refreshMs }, deps)
      .then((summary) => {
        cached = summary;
        cachedAt = current;
        return summary;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  return { snapshot };
}

function hashCursorAccountKey(account) {
  const seed = account.userId || account.id || 'cursor';
  return hashKey('cursor', seed);
}

function formatCursorMembership(type) {
  if (!type || typeof type !== 'string') return '';
  const raw = type.trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'pro+' || raw === 'pro_plus') return 'Pro+';
  return displayPlanText(cleanPlanText(raw, []), Infinity);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function percentFromUsedLimit(used, limit) {
  const safeUsed = finiteNumber(used);
  const safeLimit = finiteNumber(limit);
  if (safeUsed === null || safeLimit === null || safeLimit <= 0) return null;
  return Math.max(0, Math.min(100, (safeUsed / safeLimit) * 100));
}

function cursorResetIso(usage) {
  if (!usage.billingCycleEnd) return null;
  const date = new Date(usage.billingCycleEnd);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cursorBillingWindow(label, fields = {}) {
  return {
    kind: 'billing',
    label,
    ...fields
  };
}

async function fetchCursorLimits(options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const updatedAt = new Date(nowMs).toISOString();
  const readActiveAccount = deps.readActiveAccount || cursorAuth.readActiveAccount;
  const probe = deps.probe || cursorProbe.probe;

  const account = readActiveAccount();
  if (!account) {
    return {
      provider: 'cursor',
      accountKey: '',
      accountLabel: '',
      status: 'notConfigured',
      source: 'web',
      updatedAt,
      windows: []
    };
  }

  const result = await probe(account.sessionToken);
  if (!result.ok) {
    const kind = result.error?.kind === 'unauthorized' ? 'unauthorized' : 'unavailable';
    return {
      provider: 'cursor',
      accountKey: hashCursorAccountKey(account),
      accountLabel: account.label || '',
      status: kind,
      source: 'web',
      updatedAt,
      windows: []
    };
  }

  const { usage } = result;
  const resetsAt = cursorResetIso(usage);
  const hasRequestUsage = finiteNumber(usage.requestsUsed) !== null
    && finiteNumber(usage.requestsLimit) !== null
    && usage.requestsLimit > 0;
  const totalPercent = hasRequestUsage
    ? percentFromUsedLimit(usage.requestsUsed, usage.requestsLimit)
    : usage.planPercent;
  const windows = [
    cursorBillingWindow('Total', {
      usedPercent: totalPercent,
      used: hasRequestUsage ? usage.requestsUsed : usage.planUsedUsd,
      limit: hasRequestUsage ? usage.requestsLimit : usage.planLimitUsd,
      remaining: hasRequestUsage
        ? Math.max(0, usage.requestsLimit - usage.requestsUsed)
        : usage.planRemainingUsd,
      resetsAt,
      windowMinutes: null,
      resetDescription: usage.membershipType ? `Cursor ${usage.membershipType}` : ''
    })
  ];

  if (finiteNumber(usage.autoPercent) !== null) {
    windows.push(cursorBillingWindow('Auto', {
      usedPercent: usage.autoPercent,
      resetsAt,
      windowMinutes: null
    }));
  }

  if (finiteNumber(usage.apiPercent) !== null) {
    windows.push(cursorBillingWindow('API', {
      usedPercent: usage.apiPercent,
      resetsAt,
      windowMinutes: null
    }));
  }

  if (usage.hasOnDemandUsage || finiteNumber(usage.onDemandLimitUsd) !== null || (finiteNumber(usage.onDemandUsedUsd) !== null && usage.onDemandUsedUsd > 0)) {
    const remaining = finiteNumber(usage.onDemandRemainingUsd)
      ?? (finiteNumber(usage.onDemandLimitUsd) !== null
        ? Math.max(0, usage.onDemandLimitUsd - (finiteNumber(usage.onDemandUsedUsd) || 0))
        : null);
    windows.push(cursorBillingWindow('Credits', {
      usedPercent: finiteNumber(usage.onDemandPercent) ?? percentFromUsedLimit(usage.onDemandUsedUsd, usage.onDemandLimitUsd),
      used: usage.onDemandUsedUsd,
      limit: usage.onDemandLimitUsd,
      remaining,
      resetsAt: null,
      windowMinutes: null,
      resetDescription: '',
      showMeter: false
    }));
  }

  if (usage.hasTeamOnDemandUsage || finiteNumber(usage.teamOnDemandLimitUsd) !== null || (finiteNumber(usage.teamOnDemandUsedUsd) !== null && usage.teamOnDemandUsedUsd > 0)) {
    const remaining = finiteNumber(usage.teamOnDemandRemainingUsd)
      ?? (finiteNumber(usage.teamOnDemandLimitUsd) !== null
        ? Math.max(0, usage.teamOnDemandLimitUsd - (finiteNumber(usage.teamOnDemandUsedUsd) || 0))
        : null);
    windows.push(cursorBillingWindow('Team credits', {
      usedPercent: finiteNumber(usage.teamOnDemandPercent) ?? percentFromUsedLimit(usage.teamOnDemandUsedUsd, usage.teamOnDemandLimitUsd),
      used: usage.teamOnDemandUsedUsd,
      limit: usage.teamOnDemandLimitUsd,
      remaining,
      resetsAt: null,
      windowMinutes: null,
      resetDescription: '',
      showMeter: false
    }));
  }

  if (usage.hasTeamPooledUsage || finiteNumber(usage.teamPooledLimitUsd) !== null || (finiteNumber(usage.teamPooledUsedUsd) !== null && usage.teamPooledUsedUsd > 0)) {
    const remaining = finiteNumber(usage.teamPooledRemainingUsd)
      ?? (finiteNumber(usage.teamPooledLimitUsd) !== null
        ? Math.max(0, usage.teamPooledLimitUsd - (finiteNumber(usage.teamPooledUsedUsd) || 0))
        : null);
    windows.push(cursorBillingWindow('Team pool', {
      usedPercent: finiteNumber(usage.teamPooledPercent) ?? percentFromUsedLimit(usage.teamPooledUsedUsd, usage.teamPooledLimitUsd),
      used: usage.teamPooledUsedUsd,
      limit: usage.teamPooledLimitUsd,
      remaining,
      resetsAt,
      windowMinutes: null,
      resetDescription: 'Shared team usage pool.'
    }));
  }

  return {
    provider: 'cursor',
    accountKey: hashCursorAccountKey(account),
    accountLabel: formatCursorMembership(usage.membershipType) || account.label || '',
    status: 'ok',
    source: 'web',
    updatedAt,
    windows
  };
}

module.exports = {
  collectLimitsOnce,
  codexCommandCandidates,
  codexCommandSourceDetail,
  createLimitsCollector,
  fetchAntigravityLimits,
  fetchOpenCodeLimits,
  fetchClaudeLimits,
  fetchCodexLimits,
  fetchCursorLimits,
  mapClaudeCliUsageToProvider,
  mapClaudeUsageToProvider,
  mapCodexRateLimitsToProvider,
  parseClaudeCliUsageText,
  parseBoolean,
  parseLimitProviders,
  normalizeLimitsRefreshMs,
  refreshClaudeAccessToken,
  refreshClaudeCredentials,
  delegatedClaudeRefresh,
  touchClaudeAuthPath,
  rankClaudeCredentialFiles,
  wslClaudeCredentialPaths
};
