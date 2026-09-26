'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { claudeSessionRoots } = require('./providers/claude/paths');

function isSafeSessionId(sessionId) {
  const id = String(sessionId || '');
  if (!id || id === '.' || id === '..') return false;
  if (id.includes('\0')) return false;
  // A single path segment only — separators would let path.join walk out.
  if (/[\\/]/.test(id)) return false;
  return path.basename(id) === id;
}

function isPathInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function sessionIdCandidates(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return [];
  const out = [id];
  const slash = id.split(/[/\\]/).pop();
  if (slash && slash !== id) out.push(slash);
  const parts = id.split('__');
  if (parts.length >= 2) out.push(parts[parts.length - 1]);
  return [...new Set(out.filter(Boolean))];
}

function findSessionFiles(root, sessionIds) {
  const wanted = new Set();
  const wantedToOriginal = new Map();
  for (const raw of sessionIds) {
    // Candidates are derived segments of the raw id; only single-segment ones
    // may be matched against file names.
    for (const id of sessionIdCandidates(raw)) {
      if (!isSafeSessionId(id)) continue;
      wanted.add(`${id}.jsonl`);
      if (!wantedToOriginal.has(id)) wantedToOriginal.set(id, String(raw));
    }
  }
  const found = new Map();
  if (wanted.size === 0) return found;

  function walk(dir) {
    if (found.size >= wanted.size) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (found.size >= wanted.size) return;
      const nextPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(nextPath);
      } else if (entry.isFile() && wanted.has(entry.name)) {
        const stem = entry.name.slice(0, -'.jsonl'.length);
        found.set(stem, nextPath);
        const original = wantedToOriginal.get(stem);
        if (original && original !== stem) found.set(original, nextPath);
      }
    }
  }

  walk(root);
  return found;
}

function codexHomeDir(home, options = {}) {
  const env = options.env || process.env;
  const configured = options.useEnvRoots !== false ? String(env.CODEX_HOME || '').trim() : '';
  return configured ? path.resolve(configured) : path.join(home, '.codex');
}

function codexSessionFile(home, sessionId, options = {}) {
  if (!isSafeSessionId(sessionId)) return '';
  const match = String(sessionId).match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (!match) return '';
  const codexHome = options.codexHome || codexHomeDir(home, options);
  const sessionsRoot = path.join(codexHome, 'sessions');
  const filePath = path.join(sessionsRoot, match[1], match[2], match[3], `${sessionId}.jsonl`);
  if (!isPathInside(sessionsRoot, filePath)) return '';
  try { return fs.statSync(filePath).isFile() ? filePath : ''; } catch (_) { return ''; }
}

function grokSessionFile(home, sessionId) {
  const wanted = new Set(sessionIdCandidates(sessionId));
  if (wanted.size === 0) return '';
  const root = path.join(home, '.grok', 'sessions');
  const preferred = ['events.jsonl', 'updates.jsonl', 'chat_history.jsonl'];

  function fileInDir(dir) {
    for (const name of preferred) {
      const candidate = path.join(dir, name);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch (_) { /* keep looking */ }
    }
    return '';
  }

  function walk(dir, depth) {
    if (depth > 8) return '';
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return ''; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const next = path.join(dir, entry.name);
      if (wanted.has(entry.name)) {
        const hit = fileInDir(next);
        if (hit) return hit;
      }
      const nested = walk(next, depth + 1);
      if (nested) return nested;
    }
    return '';
  }

  return walk(root, 0);
}

function resolveSessionFile(client, sessionId, home, options = {}) {
  const id = String(sessionId || '');
  if (!sessionIdCandidates(id).some(isSafeSessionId)) return '';
  if (client === 'claude') {
    const { projects, transcripts } = claudeSessionRoots({
      homeDir: home,
      env: options.env,
      useEnvRoots: options.useEnvRoots
    });
    const projectFile = findSessionFiles(projects, [id]).get(id);
    if (projectFile) return projectFile;
    return findSessionFiles(transcripts, [id]).get(id) || '';
  }
  if (client === 'codex') {
    const codexHome = options.codexHome || codexHomeDir(home, options);
    const direct = codexSessionFile(home, id, { codexHome });
    if (direct) return direct;
    return findSessionFiles(path.join(codexHome, 'sessions'), [id]).get(id) || '';
  }
  if (client === 'grok') return grokSessionFile(home, id);
  return '';
}

module.exports = { findSessionFiles, codexSessionFile, grokSessionFile, resolveSessionFile, sessionIdCandidates, isSafeSessionId };
