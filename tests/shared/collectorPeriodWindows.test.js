'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { computePeriodWindows } = require('../../src/shared/collector');

// endsAt is computed in the device's local time and serialized to UTC, so the
// hub can expire a stale today/month snapshot with a plain nowMs < endsAt check.
// Assertions read back the local components so they hold regardless of the test
// runner's timezone.
test('computePeriodWindows returns next local midnight and next month start', () => {
  const now = new Date(2026, 5, 27, 14, 30, 0); // local 2026-06-27 14:30
  const windows = computePeriodWindows(now);

  assert.equal(windows.today.key, '2026-06-27');
  assert.equal(windows.month.key, '2026-06');

  const todayEnd = new Date(windows.today.endsAt);
  assert.equal(todayEnd.getFullYear(), 2026);
  assert.equal(todayEnd.getMonth(), 5); // still June (boundary is June 28 00:00 local)
  assert.equal(todayEnd.getDate(), 28);
  assert.equal(todayEnd.getHours(), 0);
  assert.equal(todayEnd.getMinutes(), 0);

  const monthEnd = new Date(windows.month.endsAt);
  assert.equal(monthEnd.getMonth(), 6); // July
  assert.equal(monthEnd.getDate(), 1);
  assert.equal(monthEnd.getHours(), 0);
});

test('computePeriodWindows wraps the month boundary at year end', () => {
  const windows = computePeriodWindows(new Date(2026, 11, 31, 23, 0, 0)); // local 2026-12-31 23:00
  assert.equal(windows.today.key, '2026-12-31');
  assert.equal(windows.month.key, '2026-12');

  const todayEnd = new Date(windows.today.endsAt);
  assert.equal(todayEnd.getFullYear(), 2027);
  assert.equal(todayEnd.getMonth(), 0); // January
  assert.equal(todayEnd.getDate(), 1);

  const monthEnd = new Date(windows.month.endsAt);
  assert.equal(monthEnd.getFullYear(), 2027);
  assert.equal(monthEnd.getMonth(), 0);
  assert.equal(monthEnd.getDate(), 1);
});
