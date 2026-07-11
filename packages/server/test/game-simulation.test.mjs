/**
 * Deterministic tests for GameSimulation — the server-authoritative core.
 *
 * Drives the fixed step manually via an injected clock (no real timers), so
 * distance/pause/auto-start/lap/staleness/ended logic is verified without
 * booting the server (which needs the ANT+ native stack). Runs against the
 * built dist with Node's test runner.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameSimulation } from '../dist/lib/game-simulation.js';

// A short straight route so laps happen after a few ticks.
// Two points ~0.001° lat apart ≈ 111 m.
const ROUTE = [
  { lat: 25.000, lon: 121.5, ele: 0 },
  { lat: 25.001, lon: 121.5, ele: 0 },
];

const CONFIG = {
  ftp: 200, hrMax: 190, trainerModel: 'generic-fluid',
  freeRoam: false, targetDurationMs: 30 * 60 * 1000,
  randomEventsEnabled: true, selectedWorkoutId: 'none',
};

/** Build a sim with a controllable clock + snapshot. Returns helpers. */
function makeSim(overrides = {}) {
  const START = 1_000_000;
  const clock = { t: START };
  const snap = { value: {} };
  const dataAt = { t: START }; // last sensor frame time
  const frames = [];
  const relay = { broadcast: (m) => frames.push(m) };

  const wind = { value: overrides.wind ?? { baseSpeedKmh: 0, directionDeg: 0 } };
  const sim = new GameSimulation({
    routePoints: ROUTE,
    config: { ...CONFIG, ...(overrides.config ?? {}) },
    relay,
    getSnapshot: () => snap.value,
    getLastDataAt: () => dataAt.t,
    recordingStartTime: START,
    now: () => clock.t,
    getWind: () => wind.value,
  });

  // Initialize lastTickAt = START the way production start() does, then clear
  // the real interval so the test drives steps manually.
  sim.start();
  sim.stop();

  // Advance the clock by dtMs and run one fixed step. Keeps the sensor fresh
  // unless `stale` is set.
  function step(dtMs, { stale = false } = {}) {
    clock.t += dtMs;
    if (!stale) dataAt.t = clock.t;
    sim.tickOnce();
  }

  return { sim, clock, snap, dataAt, frames, step, START };
}

test('starts paused; auto-starts on first pedal stroke', () => {
  const { sim, snap, step } = makeSim();
  assert.equal(sim.state.paused, true, 'begins paused (start prompt)');

  // No signal yet → stays paused.
  snap.value = { power: 0, cadence: 0, hr: 120 };
  step(1000);
  assert.equal(sim.state.paused, true);
  assert.equal(sim.state.cumulativeDistance, 0);

  // First non-zero power → auto-start, and it integrates this same tick.
  snap.value = { power: 200, hr: 140 };
  step(1000);
  assert.equal(sim.state.paused, false, 'auto-started');
  assert.ok(sim.state.cumulativeDistance > 0, 'moved after auto-start');
});

test('distance advances at ~virtual speed while unpaused', () => {
  const { sim, snap, step } = makeSim();
  snap.value = { power: 200, hr: 140 };
  step(1000); // auto-start + 1s
  // 200W ≈ 21.21 km/h ≈ 5.89 m/s → ~5.89 m in 1s.
  for (let i = 0; i < 9; i++) step(1000); // 10s total riding
  const d = sim.state.cumulativeDistance;
  // ~58.9 m expected; allow generous slack for the exact power curve.
  assert.ok(d > 45 && d < 75, `~59m after 10s, got ${d.toFixed(1)}`);
});

test('pause freezes distance; clock keeps running (方案甲)', () => {
  const { sim, snap, step, frames } = makeSim();
  snap.value = { power: 200, hr: 140 };
  step(1000); // auto-start
  for (let i = 0; i < 4; i++) step(1000);
  const dBefore = sim.state.cumulativeDistance;

  sim.setPaused(true);
  const elapsedBefore = frames[frames.length - 1].elapsed;
  for (let i = 0; i < 5; i++) step(1000); // 5s paused
  const dAfter = sim.state.cumulativeDistance;
  const elapsedAfter = frames[frames.length - 1].elapsed;

  assert.equal(dAfter, dBefore, 'distance frozen during pause');
  assert.ok(elapsedAfter - elapsedBefore >= 4900, 'clock advanced ~5s during pause');

  // Resume → moves again.
  sim.setPaused(false);
  step(1000);
  assert.ok(sim.state.cumulativeDistance > dAfter, 'moves after resume');
});

test('laps derive from monotonic cumulativeDistance', () => {
  const { sim, snap, step } = makeSim();
  snap.value = { power: 300, hr: 150 };
  step(1000); // auto-start
  // Route is ~111 m; ride ~60s to cross it at least once.
  for (let i = 0; i < 60; i++) step(1000);
  assert.ok(sim.state.laps >= 1, `completed >=1 lap, got ${sim.state.laps}`);
  // distanceTraveled is the wrapped remainder, always < one lap length.
  assert.ok(sim.state.distanceTraveled < sim.state.cumulativeDistance);
  assert.ok(
    sim.state.distanceTraveled >= 0 && sim.state.distanceTraveled < 200,
    `wrapped distance in [0, lapLen), got ${sim.state.distanceTraveled.toFixed(1)}`,
  );
});

test('stale sensor → speed drops to zero (no ghost coasting)', () => {
  const { sim, snap, step } = makeSim();
  snap.value = { power: 200, hr: 140 };
  step(1000); // auto-start, fresh
  for (let i = 0; i < 3; i++) step(1000);
  const dBefore = sim.state.cumulativeDistance;
  assert.ok(dBefore > 0);

  // Sensor goes silent past the 5s staleness window (single 6s gap): the
  // snapshot still holds old power, but staleness must zero the speed so the
  // ball stops immediately — no distance added this tick.
  step(6000, { stale: true });
  assert.equal(sim.state.speedKmh, 0, 'speed zeroed once stale');
  assert.equal(sim.state.cumulativeDistance, dBefore, 'no distance added while stale');

  // Fresh data resumes movement.
  snap.value = { power: 200, hr: 140 };
  step(1000);
  assert.ok(sim.state.cumulativeDistance > dBefore, 'moves again once fresh');
});

test('ended freezes the sim when target duration is reached', () => {
  const { sim, snap, step } = makeSim({ config: { targetDurationMs: 3000 } });
  snap.value = { power: 200, hr: 140 };
  step(1000); // t=1s, auto-start
  step(1000); // t=2s
  assert.equal(sim.state.ended, false);
  const dBefore = sim.state.cumulativeDistance;
  step(1500); // t=3.5s → past target
  assert.equal(sim.state.ended, true, 'ended once past targetDurationMs');
  const dAtEnd = sim.state.cumulativeDistance;
  step(1000);
  assert.equal(sim.state.cumulativeDistance, dAtEnd, 'no further movement after ended');
  assert.ok(dAtEnd >= dBefore);
});

test('addCoins accumulates the authoritative coin total', () => {
  const { sim, frames, snap, step } = makeSim();
  snap.value = { power: 200, hr: 140 };
  step(1000);
  sim.addCoins(5);
  sim.addCoins(3);
  step(1000);
  assert.equal(sim.state.coinsTotal, 8);
  assert.equal(frames[frames.length - 1].coinsTotal, 8, 'total is broadcast');
});

// ── Coins (P5): spawn / span collision / cleanup / delta+reconcile ──

/** hr 130 @ hrMax 190 ≈ 68% → Z2 (spacing 100m, coinsPerTick 1). */
const Z2_SNAP = { power: 200, hr: 130 };

/** Drain every coins field from the captured frames. */
function coinOps(frames) {
  return frames.filter((f) => f.coins).map((f) => f.coins);
}

test('coins spawn on the zone cadence with unique monotonic ids', () => {
  const { snap, step, frames } = makeSim();
  snap.value = Z2_SNAP;
  step(1000); // auto-start
  for (let i = 0; i < 6; i++) step(1000); // cross the 5s combo/spawn cadence

  const spawned = coinOps(frames).flatMap((c) => c.spawned);
  assert.ok(spawned.length > 0, 'Z2 rider gets coins spawned');

  const ids = spawned.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'ids unique');
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], 'ids monotonic');

  // DTOs carry render-ready positions on the route.
  for (const c of spawned) {
    assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lon));
    assert.ok(c.routeDistanceM >= 0);
  }
});

test('riding through coins collects them: coinsTotal grows, collected deltas emitted', () => {
  const { sim, snap, step, frames } = makeSim();
  snap.value = Z2_SNAP;
  step(1000);
  for (let i = 0; i < 6; i++) step(1000); // spawn wave ahead (window +20..+200)
  // Ride far enough to sweep the spawn window (route wraps, ~5.9 m/s).
  for (let i = 0; i < 40; i++) step(1000);

  const collected = coinOps(frames).flatMap((c) => c.collected);
  assert.ok(collected.length > 0, 'some coins collected while riding through');
  const expected = collected.reduce((s, c) => s + c.combo, 0);
  assert.equal(sim.state.coinsTotal, expected, 'coinsTotal equals sum of collected combos');
});

test('a giant tick cannot tunnel past coins (span-based collision)', () => {
  const { sim, snap, step } = makeSim();
  snap.value = { power: 300, hr: 130 }; // Z2 → spacing 100m → coins at cum 100, 200, …
  step(1000); // auto-start (first spawn wave fires at the 5s cadence)

  // Ride to just short of the coin at cum=100, staying outside the ±5m
  // collect threshold (loop exits at cum ∈ [85, ~93)).
  let guard = 0;
  while (sim.state.cumulativeDistance < 85 && guard++ < 60) step(1000);
  const before = sim.state.coinsTotal;
  assert.equal(before, 0, 'coin at cum=100 not collected during approach');

  // One 5s tick (~37m at 300W) jumps clean over the coin's ±5m window.
  // Per-tick proximity would tunnel; the swept span must collect it.
  step(5000);
  assert.ok(sim.state.cumulativeDistance > 105, 'tick jumped past the coin');
  assert.ok(sim.state.coinsTotal > before, 'coin inside the swept span was collected');
});

test('reconcile: periodic full set + immediate on request', () => {
  const { sim, snap, step, frames } = makeSim();
  snap.value = Z2_SNAP;
  step(1000);
  for (let i = 0; i < 6; i++) step(1000);

  const withReconcile = coinOps(frames).filter((c) => c.reconcile);
  assert.ok(withReconcile.length > 0, 'periodic reconcile within a few seconds');
  const last = withReconcile[withReconcile.length - 1];
  assert.equal(last.reconcile.length, sim.state.activeCoinCount, 'reconcile carries the full active set');

  // On-demand: a fresh WS client asks and the next frame reconciles.
  frames.length = 0;
  sim.requestReconcile();
  step(50);
  assert.ok(frames[0].coins?.reconcile, 'requestReconcile → next frame has full set');
});

test('paused sim still reconciles (reconnect while paused converges)', () => {
  const { sim, snap, step, frames } = makeSim();
  snap.value = Z2_SNAP;
  step(1000);
  for (let i = 0; i < 6; i++) step(1000); // spawn some coins
  sim.setPaused(true);
  frames.length = 0;
  sim.requestReconcile();
  step(50);
  assert.ok(frames[0].coins?.reconcile, 'reconcile delivered while paused');
});

// ── Random events (P6): state machine, on-target, coins, pause-freeze ──

/** Run `fn` with Math.random pinned to `v` (deterministic event pick). */
function withRandom(v, fn) {
  const orig = Math.random;
  Math.random = () => v;
  try { return fn(); } finally { Math.random = orig; }
}

/**
 * Drive the sim to just after the 3-min initial delay. HR is kept in Z1 (no
 * coin spawns) so coin collisions don't pollute coinsTotal assertions.
 * cadence lets cadence-target events sit on-target. Returns the last event
 * DTO seen.
 */
// 2s ticks: at/below the on-target accumulator's 2000ms anti-jump cap, so
// on-target time is credited in full (production 50ms ticks never hit it).
const EVENT_TICK = 2000;

function runToEvent(h, cadence) {
  // 0.23 → weighted pick lands on flat-tire (cadence target 90) at t≈181s.
  h.snap.value = { power: 200, hr: 100, cadence };
  let guard = 0;
  while (h.sim.state.eventState !== 'active' && guard++ < 150) h.step(EVENT_TICK);
  return h.frames.map((f) => f.event).filter(Boolean).at(-1) ?? null;
}

/** Step until the event state leaves `active` (or a guard trips). */
function runToResult(h) {
  let guard = 0;
  while (h.sim.state.eventState === 'active' && guard++ < 40) h.step(EVENT_TICK);
}

test('event fires after the initial delay and reports a well-formed DTO', () => {
  withRandom(0.23, () => {
    const h = makeSim({ config: { targetDurationMs: 60 * 60 * 1000 } });
    const ev = runToEvent(h, 90);
    assert.ok(ev, 'an event DTO appears past the 3-min delay');
    assert.equal(ev.id, 'flat-tire', 'deterministic pick = flat-tire');
    assert.equal(ev.state, 'active');
    assert.equal(ev.durationMs, 40_000);
    assert.ok(ev.targetWatts > 0);
    assert.equal(h.sim.state.eventState, 'active');
  });
});

test('on-target cadence → success awards coinReward; then result → cooldown', () => {
  withRandom(0.23, () => {
    const h = makeSim({ config: { targetDurationMs: 60 * 60 * 1000 } });
    runToEvent(h, 90); // cadence exactly on flat-tire's target (90)

    // Ride out the 40s event (Z1 = no coin spawns, so coinsTotal only moves
    // on the event reward).
    runToResult(h);
    assert.equal(h.sim.state.eventState, 'result', 'event resolved');
    assert.equal(h.sim.state.eventSuccess, true, 'stayed on target → success');
    assert.equal(h.sim.state.coinsTotal, 20, 'success awarded flat-tire coinReward (20)');

    const resultDto = h.frames.map((f) => f.event).filter(Boolean).at(-1);
    assert.equal(resultDto.state, 'result');
    assert.equal(resultDto.success, true);

    // After the 3s result display, transitions to cooldown and clears.
    let guard = 0;
    while (h.sim.state.eventState === 'result' && guard++ < 5) h.step(5000);
    assert.equal(h.sim.state.eventState, 'cooldown');
    assert.equal(h.sim.state.activeEventId, null);
  });
});

test('off-target → failure awards no coins', () => {
  withRandom(0.23, () => {
    const h = makeSim({ config: { targetDurationMs: 60 * 60 * 1000 } });
    runToEvent(h, 40); // cadence 40, far from flat-tire target 90 → off-target
    runToResult(h);
    assert.equal(h.sim.state.eventState, 'result');
    assert.equal(h.sim.state.eventSuccess, false, 'never on target → failure');
    assert.equal(h.sim.state.coinsTotal, 0, 'failure awards nothing');
  });
});

test('pause freezes the event clock (no timing during pause)', () => {
  withRandom(0.23, () => {
    const h = makeSim({ config: { targetDurationMs: 60 * 60 * 1000 } });
    runToEvent(h, 90);
    assert.equal(h.sim.state.eventState, 'active');
    const gtBefore = h.sim.state.gameTimeMs;

    h.sim.setPaused(true);
    for (let i = 0; i < 4; i++) h.step(5000); // 20s of wall time, paused
    assert.equal(h.sim.state.gameTimeMs, gtBefore, 'game time frozen while paused');
    assert.equal(h.sim.state.eventState, 'active', 'event did not advance/resolve during pause');

    h.sim.setPaused(false);
    runToResult(h);
    assert.equal(h.sim.state.eventState, 'result', 'resumes and resolves after unpause');
  });
});

test('wind-coin-storm spawns a coin burst on start', () => {
  // wind ≥ threshold makes wind-coin-storm eligible; 0.999 roll lands on the
  // last eligible event (wind-coin-storm sits at the tail of the catalog).
  withRandom(0.999, () => {
    const h = makeSim({
      config: { targetDurationMs: 60 * 60 * 1000 },
      wind: { baseSpeedKmh: 40, directionDeg: 90 },
    });
    h.snap.value = { power: 200, hr: 100, cadence: 90 };
    let guard = 0;
    while (h.sim.state.eventState !== 'active' && guard++ < 60) h.step(5000);
    const ev = h.frames.map((f) => f.event).filter(Boolean).at(-1);
    assert.ok(ev, 'a wind-gated event fired');
    assert.equal(ev.id, 'wind-coin-storm');
    assert.ok(h.sim.state.activeCoinCount >= 10, 'burst coins spawned (≥10)');
  });
});

test('wind gate: wind-coin-storm never eligible when calm', () => {
  // Same 0.999 roll but calm wind → wind-coin-storm filtered out, a different
  // event is chosen; the storm must never appear.
  withRandom(0.999, () => {
    const h = makeSim({
      config: { targetDurationMs: 60 * 60 * 1000 },
      wind: { baseSpeedKmh: 0, directionDeg: 0 },
    });
    h.snap.value = { power: 200, hr: 100, cadence: 90 };
    for (let i = 0; i < 45; i++) h.step(5000); // past the 180s initial delay
    const ids = h.frames.map((f) => f.event?.id).filter(Boolean);
    assert.ok(ids.length > 0, 'some event fired');
    assert.ok(!ids.includes('wind-coin-storm'), 'no wind-coin-storm without wind');
  });
});

// ── Power events judge real watts (deliberate fix over the old client,
// which fed virtual speed km/h in as "currentPower") ──

test('power event judges real watts: riding at target watts → success', () => {
  // Roll 0.1 → weighted pick lands on headwind (power-only, 110% FTP).
  withRandom(0.1, () => {
    const h = makeSim({ config: { targetDurationMs: 60 * 60 * 1000 } });
    // ftp 200 → headwind target = 220W ±10%. Riding at exactly 220W gives a
    // virtual speed of ~22 km/h, so the OLD speed-vs-watts comparison would
    // sit hopelessly off target here — success proves the check reads watts.
    h.snap.value = { power: 220, hr: 100, cadence: 80 };
    let guard = 0;
    while (h.sim.state.eventState !== 'active' && guard++ < 150) h.step(EVENT_TICK);
    assert.equal(h.sim.state.activeEventId, 'headwind', 'deterministic pick = headwind');
    runToResult(h);
    assert.equal(h.sim.state.eventSuccess, true, 'watts on target → success');
    assert.equal(h.sim.state.coinsTotal, 30, 'headwind coinReward (30) awarded');
  });
});

test('power event: watts far from target → failure', () => {
  withRandom(0.1, () => {
    const h = makeSim({ config: { targetDurationMs: 60 * 60 * 1000 } });
    h.snap.value = { power: 150, hr: 100, cadence: 80 }; // 150W vs 220±22 window
    let guard = 0;
    while (h.sim.state.eventState !== 'active' && guard++ < 150) h.step(EVENT_TICK);
    assert.equal(h.sim.state.activeEventId, 'headwind');
    runToResult(h);
    assert.equal(h.sim.state.eventSuccess, false, 'off-target watts → failure');
    assert.equal(h.sim.state.coinsTotal, 0);
  });
});

// ── Ride summary (P7): server-authoritative, dt-weighted stats ──

test('summary: dt-weighted averages and maxima from active riding', () => {
  const { sim, snap, step } = makeSim();
  snap.value = { power: 200, hr: 140, cadence: 80 };
  for (let i = 0; i < 10; i++) step(1000);
  const s = sim.summary;
  assert.equal(s.avgPowerW, 200);
  assert.equal(s.maxPowerW, 200);
  assert.equal(s.avgHr, 140);
  assert.equal(s.maxHr, 140);
  assert.equal(s.avgCadence, 80);
  assert.ok(s.avgSpeed > 15 && s.avgSpeed < 30, `virtual-speed average, got ${s.avgSpeed}`);
  assert.ok(Math.abs(s.maxSpeed - s.avgSpeed) < 1e-6, 'constant power → constant speed');
  assert.equal(s.zoneSustainPct, 100, 'hr 140/190 ≈ 74% = Z3 for the whole ride');
});

test('summary: paused time never dilutes averages (方案甲)', () => {
  const { sim, snap, step } = makeSim();
  snap.value = { power: 200, hr: 140, cadence: 80 };
  for (let i = 0; i < 5; i++) step(1000);
  sim.setPaused(true);
  for (let i = 0; i < 10; i++) step(1000); // 10s of paused wall time
  sim.setPaused(false);
  for (let i = 0; i < 5; i++) step(1000);
  const s = sim.summary;
  assert.equal(s.avgPowerW, 200, 'pause excluded from the power average');
  assert.equal(s.avgHr, 140);
  assert.equal(s.zoneSustainPct, 100);
});

test('summary: hr-less and cadence-less time excluded from those averages only', () => {
  const { sim, snap, step } = makeSim();
  snap.value = { power: 200, hr: 0, cadence: 0 };
  for (let i = 0; i < 5; i++) step(1000); // riding, no hr/cadence signal
  snap.value = { power: 200, hr: 140, cadence: 80 };
  for (let i = 0; i < 5; i++) step(1000);
  const s = sim.summary;
  assert.equal(s.avgHr, 140, 'hr=0 time excluded from avgHr');
  assert.equal(s.avgCadence, 80, 'cadence=0 time excluded from avgCadence');
  assert.equal(s.zoneSustainPct, 100, 'sustain is a share of hr>0 time only');
  assert.equal(s.avgPowerW, 200, 'power average spans ALL active time');
});

test('summary: totals stay consistent with the authoritative sim state', () => {
  const { sim, snap, step } = makeSim();
  snap.value = { power: 300, hr: 130, cadence: 90 }; // Z2 → coins spawn+collect
  for (let i = 0; i < 60; i++) step(1000);
  const s = sim.summary;
  assert.ok(s.totalLaps >= 1, 'rode at least one lap');
  assert.equal(s.totalLaps, sim.state.laps);
  assert.equal(s.totalCoins, sim.state.coinsTotal);
  assert.ok(s.totalCoins > 0, 'Z2 riding collected coins');
  assert.equal(s.gameDistanceM, sim.state.cumulativeDistance,
    'game distance IS the monotonic accumulator (laps derive from it)');
});

test('broadcasts a well-formed game_state frame every tick', () => {
  const { snap, step, frames } = makeSim();
  snap.value = { power: 200, hr: 140 };
  step(1000);
  const f = frames[frames.length - 1];
  assert.equal(f.type, 'game_state');
  for (const k of ['tsEpoch', 'elapsed', 'paused', 'ended', 'position',
    'cumulativeDistance', 'distanceTraveled', 'laps', 'speedKmh',
    'steeringAngle', 'zone', 'combo', 'coinsTotal']) {
    assert.ok(k in f, `frame has ${k}`);
  }
  assert.ok('lat' in f.position && 'bearing' in f.position);
});

test('explicit pause takes over: auto-start disabled once a client controls pause', () => {
  const { sim, snap, step } = makeSim();

  // Client mounts GameView at the start prompt and mirrors its pause.
  sim.setPaused(true);

  // Sensor already streaming (--replay/--mock/trainer spinning) — without
  // the clientControlled gate this auto-started the sim and the ball rode
  // off while the client camera was still frozen at the start line.
  snap.value = { power: 200, hr: 140, cadence: 90 };
  step(1000);
  step(1000);
  assert.equal(sim.state.paused, true, 'stays paused despite pedal signal');
  assert.equal(sim.state.cumulativeDistance, 0, 'ball has not moved');

  // Explicit resume (client auto-start POSTs /api/live/resume) still works.
  sim.setPaused(false);
  step(1000);
  assert.equal(sim.state.paused, false);
  assert.ok(sim.state.cumulativeDistance > 0, 'moves after explicit resume');
});
