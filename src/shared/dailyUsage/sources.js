'use strict';

// Discovers the transcript sources of each day-split client.
//
// A source is a logical transcript (one file, or one Grok session directory)
// identified by a stable `sourceKey`. The same logical source can exist under
// several roots — the client's live directory and any append-only archive of
// it — and the largest copy wins, since transcripts only ever grow.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { claudeSessionRoots } = require('../providers/claude/paths');
const { tokscaleConfigDir } = require('../tokscaleConfig');

const DAY_SPLIT_CLIENTS = ['claude', 'codex', 'grok', 'antigravity'];

function statOrNull(filePath) {
  try { return fs.statSync(filePath); } catch (_) { return null; }
}

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}

function walkFiles(root, accept, out = [], rel = '') {
  for (const entry of listDir(path.join(root, rel))) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'memory') continue;
      walkFiles(root, accept, out, childRel);
    } else if (entry.isFile() && accept(entry.name, childRel)) {
      out.push(childRel);
    }
  }
  return out;
}

// Candidates: Map(sourceKey -> [{ path, size, mtimeMs }]).
function addCandidate(candidates, sourceKey, filePath, stat) {
  if (!stat) return;
  if (!candidates.has(sourceKey)) candidates.set(sourceKey, []);
  candidates.get(sourceKey).push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
}

function claudeCandidates(roots, candidates) {
  for (const root of roots) {
    const files = walkFiles(root.path, (name) => name.endsWith('.jsonl'));
    for (const rel of files) {
      const filePath = path.join(root.path, rel);
      addCandidate(candidates, `claude:${root.label}/${rel}`, filePath, statOrNull(filePath));
    }
  }
}

// Rollout file names are unique and survive a move into archived_sessions.
function codexCandidates(roots, candidates) {
  for (const root of roots) {
    const files = walkFiles(root.path, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'));
    for (const rel of files) {
      const filePath = path.join(root.path, rel);
      addCandidate(candidates, `codex:${path.basename(rel)}`, filePath, statOrNull(filePath));
    }
  }
}

function grokCandidates(roots, candidates) {
  for (const root of roots) {
    for (const project of listDir(root.path)) {
      if (!project.isDirectory()) continue;
      for (const session of listDir(path.join(root.path, project.name))) {
        if (!session.isDirectory()) continue;
        const dir = path.join(root.path, project.name, session.name);
        const usage = statOrNull(path.join(dir, 'usage.json'));
        const updates = statOrNull(path.join(dir, 'updates.jsonl'));
        if (!usage && !updates) continue;
        const size = (usage?.size || 0) + (updates?.size || 0);
        const mtimeMs = Math.max(usage?.mtimeMs || 0, updates?.mtimeMs || 0);
        addCandidate(candidates, `grok:${project.name}/${session.name}`, dir, { size, mtimeMs });
      }
    }
  }
}

function antigravityCandidates(roots, candidates) {
  for (const root of roots) {
    for (const entry of listDir(root.path)) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(root.path, entry.name);
      addCandidate(candidates, `antigravity:${entry.name}`, filePath, statOrNull(filePath));
    }
  }
}

const COLLECTORS = {
  claude: claudeCandidates,
  codex: codexCandidates,
  grok: grokCandidates,
  antigravity: antigravityCandidates
};

// Default live roots plus configured archives (settings.dailyUsageArchiveRoots:
// { claude: [dir], grok: [dir], ... }). Archive roots mirror the live layout.
function defaultSourceRoots(options = {}) {
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const archives = options.archiveRoots || {};
  const { projects, transcripts } = claudeSessionRoots({ homeDir: home, env });
  const codexHome = String(env.CODEX_HOME || '').trim() || path.join(home, '.codex');
  const archiveList = (client, label) => (Array.isArray(archives[client]) ? archives[client] : [])
    .filter((dir) => typeof dir === 'string' && dir.trim())
    .map((dir) => ({ label, path: dir.trim() }));
  return {
    claude: [
      { label: 'projects', path: projects },
      ...archiveList('claude', 'projects'),
      { label: 'transcripts', path: transcripts }
    ],
    codex: [
      { label: 'sessions', path: path.join(codexHome, 'sessions') },
      { label: 'sessions', path: path.join(codexHome, 'archived_sessions') },
      ...archiveList('codex', 'sessions')
    ],
    grok: [
      { label: 'sessions', path: path.join(home, '.grok', 'sessions') },
      ...archiveList('grok', 'sessions')
    ],
    antigravity: [
      { label: 'cache', path: path.join(tokscaleConfigDir({ env, homeDir: home }), 'antigravity-cache', 'sessions') }
    ]
  };
}

function discoverSources(roots) {
  const sources = new Map();
  for (const client of DAY_SPLIT_CLIENTS) {
    const candidates = new Map();
    COLLECTORS[client](roots[client] || [], candidates);
    for (const [sourceKey, list] of candidates) {
      const best = list.slice().sort((a, b) => b.size - a.size || b.mtimeMs - a.mtimeMs)[0];
      sources.set(sourceKey, { sourceKey, client, path: best.path, size: best.size, mtimeMs: best.mtimeMs });
    }
  }
  return sources;
}

module.exports = { DAY_SPLIT_CLIENTS, defaultSourceRoots, discoverSources };
