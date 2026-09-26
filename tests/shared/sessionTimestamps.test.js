'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  timestampFromSessionId,
  resolveSessionTimestamps,
  jsonlTimeRange
} = require('../../src/shared/sessionTimestamps');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ts-'));
}

test('timestampFromSessionId reads Codex rollout, epoch prefix, and UUIDv7', () => {
  assert.match(timestampFromSessionId('rollout-2026-05-30T11-44-50-019e76fc-0d58'), /^2026-05-30T/);
  assert.equal(timestampFromSessionId('1782888368983__E--spman-cc__abc-123'), new Date(1782888368983).toISOString());
  assert.equal(timestampFromSessionId('019fb1b6-84a1-7de3-9542-0c291ab7c4ae'), '2026-07-30T06:29:16.577Z');
  assert.equal(timestampFromSessionId('c922c570-20a8-4931-89ab-22b8c0396bbc'), '');
});

test('jsonlTimeRange reads first and last timestamps and caches by mtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-jsonl-'));
  const file = path.join(dir, 's.jsonl');
  try {
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'mode' }),
      JSON.stringify({ timestamp: '2026-08-09T00:06:43.000Z', type: 'assistant' }),
      JSON.stringify({ timestamp: '2026-08-09T18:26:09.000Z', type: 'user' })
    ].join('\n'));
    const range = jsonlTimeRange(file);
    assert.equal(range.first, '2026-08-09T00:06:43.000Z');
    assert.equal(range.last, '2026-08-09T18:26:09.000Z');
    const before = fs.statSync(file).mtimeMs;
    fs.utimesSync(file, fs.statSync(file).atime, new Date(before));
    assert.deepEqual(jsonlTimeRange(file), range);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSessionTimestamps uses transcript times and does not invent ingest times', () => {
  const home = tmpHome();
  try {
    const dir = path.join(home, '.claude', 'projects', '-app');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), `${JSON.stringify({ timestamp: '2026-08-01T10:00:00.000Z' })}\n${JSON.stringify({ timestamp: '2026-08-01T12:00:00.000Z' })}\n`);
    const stamps = resolveSessionTimestamps('claude', 'sess-1', { homeDir: home });
    assert.equal(stamps.startedAt, '2026-08-01T10:00:00.000Z');
    assert.equal(stamps.lastUsedAt, '2026-08-01T12:00:00.000Z');
    const missing = resolveSessionTimestamps('claude', 'no-such-session', { homeDir: home });
    assert.equal(missing.startedAt, '');
    assert.equal(missing.lastUsedAt, '');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
