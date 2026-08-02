/**
 * Ghost trace (P8) — trace 建構(recorded/reintegrated)、查詢器、
 * 以及 GameSimulation 的 ghost 廣播整合。跑法同 game-simulation.test.mjs:
 * 先 build,對 dist 用 node --test。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGhostTrace, GhostTraceLookup } from '../dist/lib/ghost-trace.js';
import { GameSimulation } from '../dist/lib/game-simulation.js';
import { estimateVirtualSpeedFromPower } from '@littlecycling/shared';

// ── buildGhostTrace: recorded 路徑 ──

test('recorded: 1Hz 重採樣 + 線性內插 + 端點 clamp', () => {
  const { points, source } = buildGhostTrace([
    { elapsedMs: 0, distanceM: 0, powerW: 100, speedKmh: 20 },
    { elapsedMs: 2000, distanceM: 20, powerW: 100, speedKmh: 20 },
    { elapsedMs: 4000, distanceM: 60, powerW: 100, speedKmh: 20 },
  ]);
  assert.equal(source, 'recorded');
  // 網格 0,1000,2000,3000,4000
  assert.equal(points.length, 5);
  assert.equal(points[1].distM, 10);  // 0→20 的中點
  assert.equal(points[3].distM, 40);  // 20→60 的中點
  assert.equal(points[4].distM, 60);
});

test('recorded: 原始毛刺被單調化', () => {
  const { points } = buildGhostTrace([
    { elapsedMs: 0, distanceM: 0, powerW: null, speedKmh: null },
    { elapsedMs: 1000, distanceM: 30, powerW: null, speedKmh: null },
    { elapsedMs: 2000, distanceM: 28, powerW: null, speedKmh: null }, // 毛刺(倒退)
    { elapsedMs: 3000, distanceM: 45, powerW: null, speedKmh: null },
  ]);
  for (let i = 1; i < points.length; i++) {
    assert.ok(points[i].distM >= points[i - 1].distM, `monotonic at ${i}`);
  }
});

// ── buildGhostTrace: reintegrated 路徑(舊騎乘無 distance_m)──

test('reintegrated: 由 power 以同套物理積分', () => {
  const samples = [];
  for (let t = 0; t <= 60_000; t += 1000) {
    samples.push({ elapsedMs: t, distanceM: null, powerW: 100, speedKmh: 0 });
  }
  const { points, source } = buildGhostTrace(samples);
  assert.equal(source, 'reintegrated');
  const vMps = (estimateVirtualSpeedFromPower(100) * 1000) / 3600;
  const expected = vMps * 60; // 60 秒等速
  const final = points[points.length - 1].distM;
  assert.ok(Math.abs(final - expected) < expected * 0.05, `${final} ≈ ${expected}`);
});

test('reintegrated: 無 power 樣本退回積分 speed_kmh', () => {
  const samples = [];
  for (let t = 0; t <= 10_000; t += 1000) {
    samples.push({ elapsedMs: t, distanceM: null, powerW: null, speedKmh: 36 });
  }
  const { points } = buildGhostTrace(samples);
  // 36 km/h = 10 m/s × 10 s = 100 m
  const final = points[points.length - 1].distM;
  assert.ok(Math.abs(final - 100) < 5, `${final} ≈ 100`);
});

test('reintegrated: 取樣空窗被 dt 上限夾住(幽靈不瞬移)', () => {
  const { points } = buildGhostTrace([
    { elapsedMs: 0, distanceM: null, powerW: 400, speedKmh: 0 },
    { elapsedMs: 60_000, distanceM: null, powerW: 400, speedKmh: 0 }, // 60s 空窗
  ]);
  const vMps = (estimateVirtualSpeedFromPower(400) * 1000) / 3600;
  const final = points[points.length - 1].distM;
  // 空窗只積分 5s(MAX_INTEGRATE_DT_MS),不是 60s
  assert.ok(final <= vMps * 5 + 1, `${final} <= ${vMps * 5}`);
});

test('空樣本 → 空 trace', () => {
  const { points } = buildGhostTrace([]);
  assert.equal(points.length, 0);
});

// ── GhostTraceLookup ──

function rampTrace() {
  // 0..100s 等速 10 m/s → 1000 m;之後 100..130s 平坦(幽靈罰站);130..160s 再走
  const pts = [];
  for (let t = 0; t <= 100_000; t += 1000) pts.push({ tMs: t, distM: t / 100 });
  for (let t = 101_000; t <= 130_000; t += 1000) pts.push({ tMs: t, distM: 1000 });
  for (let t = 131_000; t <= 160_000; t += 1000) {
    pts.push({ tMs: t, distM: 1000 + (t - 130_000) / 100 });
  }
  return new GhostTraceLookup(pts);
}

test('distanceAt: 內插 + 兩端 clamp', () => {
  const lk = rampTrace();
  assert.equal(lk.distanceAt(-500), 0);
  assert.equal(lk.distanceAt(50_000), 500);
  assert.equal(lk.distanceAt(50_500), 505);
  assert.equal(lk.distanceAt(999_999), lk.finalDistanceM);
});

test('timeAtDistance: 平坦段取首次到達;超程 clamp 終點時刻', () => {
  const lk = rampTrace();
  assert.equal(lk.timeAtDistance(500), 50_000);
  // 1000m 在 100s 首次到達,不是罰站結束的 130s
  assert.ok(Math.abs(lk.timeAtDistance(1000) - 100_000) <= 1000);
  assert.equal(lk.timeAtDistance(99_999), lk.finalTimeMs);
});

// ── GameSimulation ghost 整合(比照 game-simulation.test.mjs 的注入時鐘模式)──

const ROUTE = [
  { lat: 25.000, lon: 121.5, ele: 0 },
  { lat: 25.001, lon: 121.5, ele: 0 },
];
const CONFIG = {
  ftp: 200, hrMax: 190, trainerModel: 'generic-fluid',
  freeRoam: false, targetDurationMs: 30 * 60 * 1000,
  randomEventsEnabled: false, selectedWorkoutId: 'none',
};

function makeSim() {
  const START = 1_000_000;
  const clock = { t: START };
  const snap = { value: {} };
  const dataAt = { t: START };
  const frames = [];
  const sim = new GameSimulation({
    routePoints: ROUTE,
    config: CONFIG,
    relay: { broadcast: (m) => frames.push(m) },
    getSnapshot: () => snap.value,
    getLastDataAt: () => dataAt.t,
    recordingStartTime: START,
    now: () => clock.t,
  });
  sim.start();
  sim.stop();
  const step = (dtMs, { stale = false } = {}) => {
    clock.t += dtMs;
    if (!stale) dataAt.t = clock.t;
    sim.tickOnce();
  };
  return { sim, snap, step, frames };
}

test('sim: 無幽靈時 game_state 不帶 ghost 區塊', () => {
  const { snap, step, frames } = makeSim();
  snap.value = { power: 150 };
  step(1000);
  assert.equal(frames[frames.length - 1].ghost, undefined);
});

test('sim: 幽靈沿 gameTimeMs 推進,玩家暫停時凍結', () => {
  const { sim, snap, step, frames } = makeSim();
  sim.setGhostTrace(rampTrace());
  snap.value = { power: 150 };
  for (let i = 0; i < 10; i++) step(1000); // 10s active
  const g1 = frames[frames.length - 1].ghost;
  assert.ok(g1, 'ghost block present');
  assert.ok(Math.abs(g1.distanceM - 100) < 15, `10s → ~100m, got ${g1.distanceM}`);

  sim.setPaused(true);
  for (let i = 0; i < 5; i++) step(1000); // 5s paused
  const g2 = frames[frames.length - 1].ghost;
  assert.equal(g2.distanceM, g1.distanceM, 'ghost frozen while paused');

  sim.setPaused(false);
  step(1000);
  const g3 = frames[frames.length - 1].ghost;
  assert.ok(g3.distanceM > g2.distanceM, 'ghost resumes with player');
});

test('sim: gapMs 正負號 — 領先為正、落後為負', () => {
  // 幽靈很慢:100s 才 10m。玩家踩 150W(虛擬速度遠快於 0.1 m/s)→ 玩家領先。
  const slow = [];
  for (let t = 0; t <= 100_000; t += 1000) slow.push({ tMs: t, distM: t / 10_000 });
  const { sim, snap, step, frames } = makeSim();
  sim.setGhostTrace(new GhostTraceLookup(slow));
  snap.value = { power: 150 };
  for (let i = 0; i < 10; i++) step(1000);
  const g = frames[frames.length - 1].ghost;
  assert.ok(g.gapMs > 0, `player ahead → positive gap, got ${g.gapMs}`);

  // 幽靈很快:1s 100m。玩家同樣踩法 → 落後。
  const fast = [];
  for (let t = 0; t <= 100_000; t += 1000) fast.push({ tMs: t, distM: t / 10 });
  const h2 = makeSim();
  h2.sim.setGhostTrace(new GhostTraceLookup(fast));
  h2.snap.value = { power: 150 };
  for (let i = 0; i < 10; i++) h2.step(1000);
  const g2 = h2.frames[h2.frames.length - 1].ghost;
  assert.ok(g2.gapMs < 0, `player behind → negative gap, got ${g2.gapMs}`);
});

test('sim: 幽靈完賽 → finished 旗標 + 距離停在終點', () => {
  const shortTrace = [];
  for (let t = 0; t <= 5000; t += 1000) shortTrace.push({ tMs: t, distM: t / 10 });
  const { sim, snap, step, frames } = makeSim();
  sim.setGhostTrace(new GhostTraceLookup(shortTrace));
  snap.value = { power: 150 };
  for (let i = 0; i < 10; i++) step(1000); // 幽靈 5s 就騎完了
  const g = frames[frames.length - 1].ghost;
  assert.equal(g.finished, true);
  assert.equal(g.distanceM, 500);
});

test('sim: 幽靈圈數由距離推導(route ~111m)', () => {
  const multi = [];
  for (let t = 0; t <= 60_000; t += 1000) multi.push({ tMs: t, distM: t / 100 }); // 60s → 600m
  const { sim, snap, step, frames } = makeSim();
  sim.setGhostTrace(new GhostTraceLookup(multi));
  snap.value = { power: 150 };
  for (let i = 0; i < 60; i++) step(1000);
  const g = frames[frames.length - 1].ghost;
  assert.ok(g.laps >= 4, `600m on ~111m route → ≥4 laps, got ${g.laps}`);
});
