/**
 * Unit tests for workout segment building, in particular the repeat option.
 *
 * Runs against the built output (dist/) with Node's built-in test runner —
 * no test framework dependency. Run via `npm test -w packages/shared`
 * (builds first).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKOUT_PROFILES,
  WORKOUT_PROFILES_MAP,
  buildWorkoutSegments,
  totalWorkoutDuration,
  workoutRoundCount,
} from '../dist/workouts.js';

const MIN = 60_000;
const ftp = WORKOUT_PROFILES_MAP['ftp-test'];
const tabata = WORKOUT_PROFILES_MAP['tabata'];

test('every profile declares a native duration', () => {
  for (const p of WORKOUT_PROFILES) {
    assert.ok(
      typeof p.nativeDurationMs === 'number' && p.nativeDurationMs > 0,
      `${p.id} is missing nativeDurationMs — without it the repeat option has no round length to scale to`,
    );
  }
});

test('percentages sum to 1, so a round fills exactly its duration', () => {
  for (const p of WORKOUT_PROFILES) {
    const sum = p.templates.reduce((a, t) => a + t.durationPct, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${p.id} templates sum to ${sum}`);
  }
});

test('native durations make the descriptions true', () => {
  // "FTP Test (20min)" — the test block is 45% of the native length.
  const block = ftp.templates.find((t) => t.name === 'FTP Test');
  assert.ok(Math.abs(block.durationPct * ftp.nativeDurationMs - 20 * MIN) < 90_000);

  // "8 × 20s at 170% FTP / 10s rest"
  const sprint = tabata.templates.find((t) => t.name === 'Sprint 1');
  const rest = tabata.templates.find((t) => t.name === 'Rest');
  assert.ok(Math.abs(sprint.durationPct * tabata.nativeDurationMs - 20_000) < 1_000);
  assert.ok(Math.abs(rest.durationPct * tabata.nativeDurationMs - 10_000) < 1_000);
});

test('without repeat the profile stretches to fill the ride (unchanged behaviour)', () => {
  const segs = buildWorkoutSegments(ftp, 90 * MIN);
  assert.equal(segs.length, ftp.templates.length);
  assert.ok(Math.abs(totalWorkoutDuration(segs) - 90 * MIN) < 1000);
  // Stretched, so no round labels.
  assert.ok(!segs[0].name.includes('/'));
});

test('repeat runs whole rounds at the native length and fills the ride', () => {
  const total = 90 * MIN; // two full 45-min rounds exactly
  const segs = buildWorkoutSegments(ftp, total, { repeat: true });
  assert.equal(workoutRoundCount(ftp, total, true), 2);
  assert.equal(segs.length, ftp.templates.length * 2);
  assert.ok(Math.abs(totalWorkoutDuration(segs) - total) < 1000);

  // The interval keeps its designed length instead of being stretched.
  const block = segs.find((s) => s.name.startsWith('FTP Test'));
  assert.ok(Math.abs(block.durationMs - 20 * MIN) < 90_000);
  assert.ok(block.name.includes('(1/2)'));
});

test('a partial final round is clipped to land exactly on the target', () => {
  const total = 60 * MIN; // 45-min round + a 15-min tail
  const segs = buildWorkoutSegments(ftp, total, { repeat: true });
  assert.ok(Math.abs(totalWorkoutDuration(segs) - total) < 1000,
    'repeated workouts must not overrun the ride duration');
  assert.ok(segs.length > ftp.templates.length, 'the tail round should contribute segments');
});

test('repeat is a no-op when the ride is not longer than one round', () => {
  const short = buildWorkoutSegments(ftp, 20 * MIN, { repeat: true });
  const stretched = buildWorkoutSegments(ftp, 20 * MIN);
  assert.deepEqual(short, stretched);
  assert.equal(workoutRoundCount(ftp, 20 * MIN, true), 1);
});

test('no sliver segments survive the clip', () => {
  // Pick a total that lands a hair past a round boundary.
  const total = tabata.nativeDurationMs * 3 + 1_000;
  const segs = buildWorkoutSegments(tabata, total, { repeat: true });
  for (const s of segs) {
    assert.ok(s.durationMs >= 5_000, `segment "${s.name}" is ${s.durationMs}ms`);
  }
});
