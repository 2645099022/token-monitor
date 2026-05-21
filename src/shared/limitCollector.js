'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_LIMITS_REFRESH_MS, normalizeLimitProvider, normalizeLimitsSummary } = require('./limits');

const LIMIT_PROVIDER_IDS = ['claude', 'codex'];
const LIMIT_REFRESH_VALUES = new Set([60_000, 120_000, 300_000, 900_000, 1_800_000]);
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_SESSION_WINDOW_MINUTES = 5 * 60;
const CLAUDE_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

function nowIso(nowMs) {
  return new Date(nowMs).toISOString();
}

function parseBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function parseLimitProviders(value) {
  const source = value === undefined || value === null ? 'claude,codex' : value;
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

function codexAuthPath(env = process.env) {
  const base = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(base, 'auth.json');
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

function planLabelFromParts(...parts) {
  const text = parts.map((part) => String(part || '')).find(Boolean) || '';
  const raw = text.toLowerCase().replace(/^(claude|chatgpt|openai)[\s_-]+/, '').replace(/[_-]+/g, ' ').trim();
  if (!raw || raw.includes('@')) return '';
  const aliases = {
    free: 'Free',
    plus: 'Plus',
    pro: 'Pro',
    max: 'Max',
    team: 'Team',
    teams: 'Team',
    enterprise: 'Enterprise'
  };
  if (aliases[raw]) return aliases[raw];
  return raw.split(/\s+/).slice(0, 3).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function extractClaudeOauth(credentials) {
  return credentials?.claudeAiOauth || credentials?.oauth || credentials || null;
}

async function readClaudeCredentials(deps = {}) {
  const env = deps.env || process.env;
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      accessToken: String(env.CLAUDE_CODE_OAUTH_TOKEN),
      identity: 'env:CLAUDE_CODE_OAUTH_TOKEN'
    };
  }

  const filePath = deps.claudeCredentialPath || claudeCredentialPath(env);
  try {
    const oauth = extractClaudeOauth(await readJsonFile(filePath, deps));
    if (oauth?.accessToken) {
      return {
        accessToken: String(oauth.accessToken),
        identity: `path:${env.CLAUDE_CONFIG_DIR ? 'CLAUDE_CONFIG_DIR/.credentials.json' : '~/.claude/.credentials.json'}:${oauth.subscriptionType || ''}:${oauth.rateLimitTier || ''}`,
        accountLabel: planLabelFromParts(oauth.subscriptionType, oauth.rateLimitTier)
      };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (process.platform === 'darwin' && deps.readMacKeychain !== false) {
    const text = await readMacKeychainSecret('Claude Code-credentials', deps).catch(() => '');
    if (text) {
      const oauth = extractClaudeOauth(JSON.parse(text));
      if (oauth?.accessToken) {
        return {
          accessToken: String(oauth.accessToken),
          identity: `keychain:Claude Code-credentials:${oauth.subscriptionType || ''}:${oauth.rateLimitTier || ''}`,
          accountLabel: planLabelFromParts(oauth.subscriptionType, oauth.rateLimitTier)
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

async function fetchClaudeLimits(options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  try {
    const credentials = await readClaudeCredentials(deps);
    const usage = await fetchJson(CLAUDE_USAGE_URL, {
      accept: 'application/json',
      authorization: `Bearer ${credentials.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20'
    }, deps);
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
sent_usage = False
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
        if not sent_usage and now - start > 5:
            os.write(master, b"/usage\\r")
            sent_usage = True
        if sent_usage and now - last_enter > 0.8:
            os.write(master, b"\\r")
            last_enter = now
        if sent_usage and "currentsession" in scan and re.search(r"currentsession.*?[0-9]{1,3}(?:\\.[0-9]+)?%", scan):
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

async function runClaudeUsageCli(deps = {}) {
  if (deps.runClaudeUsageCli) return deps.runClaudeUsageCli();
  if ((deps.platform || process.platform) === 'win32') {
    throw errorWithStatus('unavailable', 'Claude CLI PTY fallback is not available on Windows yet');
  }
  const env = deps.env || process.env;
  const command = claudeCommandCandidates(env)[0];
  const probeDir = deps.claudeProbeDir || path.join(os.tmpdir(), 'token-monitor-claude-probe');
  fs.mkdirSync(probeDir, { recursive: true });
  const runEnv = {
    ...env,
    TOKEN_MONITOR_CLAUDE_COMMAND_PATH: command,
    TOKEN_MONITOR_CLAUDE_PROBE_DIR: probeDir,
    TOKEN_MONITOR_CLAUDE_CLI_TIMEOUT: String(deps.claudeCliTimeoutSeconds || 35)
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
  return planLabelFromParts(
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
  const hints = [];
  if (platform === 'win32') {
    if (env.APPDATA) hints.push(path.join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) hints.push(path.join(env.LOCALAPPDATA, 'pnpm'));
    if (env.USERPROFILE) hints.push(path.join(env.USERPROFILE, '.bun', 'bin'));
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
  return candidates.filter((candidate) => {
    if (!path.isAbsolute(candidate)) return true;
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
  const command = deps.codexCommand || existingCodexCommandCandidates(codexCommandCandidates(env, platform), deps)[0];
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
  return existingCodexCommandCandidates(codexCommandCandidates(env, platform), deps);
}

function codexCommandCandidates(env = process.env, platform = process.platform) {
  if (env.TOKEN_MONITOR_CODEX_COMMAND) return [env.TOKEN_MONITOR_CODEX_COMMAND];
  const candidates = [];
  if (platform === 'darwin') {
    candidates.push('/Applications/Codex.app/Contents/Resources/codex');
  } else if (platform === 'win32') {
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Codex', 'resources', 'codex.exe'));
    if (env.PROGRAMFILES) candidates.push(path.join(env.PROGRAMFILES, 'Codex', 'resources', 'codex.exe'));
    if (env['PROGRAMFILES(X86)']) candidates.push(path.join(env['PROGRAMFILES(X86)'], 'Codex', 'resources', 'codex.exe'));
    if (env.APPDATA) candidates.push(path.join(env.APPDATA, 'npm', 'codex.cmd'));
    candidates.push('codex.cmd', 'codex.exe');
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Codex', 'Codex.exe'));
  }
  candidates.push('codex');
  return uniqueStrings(candidates);
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
      clientInfo: { name: 'token-monitor', title: 'Token Monitor', version: '0.1.0' }
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
    return { account, rateLimits, rateLimitsByLimitId };
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
    source: 'rpc'
  });
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

module.exports = {
  collectLimitsOnce,
  codexCommandCandidates,
  createLimitsCollector,
  fetchClaudeLimits,
  fetchCodexLimits,
  mapClaudeCliUsageToProvider,
  mapClaudeUsageToProvider,
  mapCodexRateLimitsToProvider,
  parseClaudeCliUsageText,
  parseBoolean,
  parseLimitProviders,
  normalizeLimitsRefreshMs
};
