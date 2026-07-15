import { ref, onUnmounted } from 'vue';
import {
  estimateVirtualSpeedFromPower,
  estimateVirtualCadenceFromPower,
} from '@littlecycling/shared';
import { useGameStore } from '@/stores/gameStore';
import { useSensorStore } from '@/stores/sensorStore';
import { useGameStateStore } from '@/stores/gameStateStore';

interface GameLoopDeps {
  ballTick: (dtMs: number) => void;
  updateBallVisual: () => void;
  updateCamera: () => void;
}

export interface TimeSeriesSample {
  t: number; // elapsed seconds
  hr: number;
  speed: number;
  cadence: number;
  power: number;
}

/** Interval between time-series samples (ms) */
const SAMPLE_INTERVAL = 1000;

/**
 * Render cadence while paused. The world still has to move behind the
 * translucent overlays (see `frame`), but nobody is racing — and every one of
 * those frames drags the full post-processing chain through the GPU at display
 * rate. 15fps keeps the scene alive for a quarter of the cost.
 */
const PAUSED_FRAME_MS = 1000 / 15;

/**
 * Render loop: rAF (or ~10fps setTimeout when the tab is hidden) driving the
 * server-frame interpolation + renderer updates, plus DISPLAY-ONLY sampling
 * (live max/min chips, the pinned HUD chart's time series, FPS counter).
 *
 * Ride statistics are NOT computed here (P7): everything that persists —
 * averages, maxima, zone sustain, coins, laps — is accumulated by the server
 * simulation and returned by /api/live/stop. Per-frame sampling was the bug
 * this migration killed (background tabs sample 6× less than foreground),
 * so nothing sampled in this loop may ever be saved.
 */
export function useGameLoop(deps: GameLoopDeps) {
  const gameStore = useGameStore();
  const sensorStore = useSensorStore();
  const gameStateStore = useGameStateStore();

  const elapsedMs = ref(0);
  const isRunning = ref(false);

  // Time-series data for pinned charts (display-only). Sampled on a REAL-TIME
  // cadence (perf clock), not the game clock — so the live chart fills steadily
  // even when elapsedMs advances irregularly (replay seeks, jumpy anchors).
  const timeSeries = ref<TimeSeriesSample[]>([]);
  let lastSampleAtPerf = 0;

  // FPS counter (updated ~1/sec)
  const fps = ref(0);
  const fpsMax = ref(0);
  const fpsMin = ref<number | null>(null);
  let fpsFrames = 0;
  let fpsLastTime = 0;

  // Live max/min refs exposed to HUD. MIN stays null until we see a sample > 0
  // (so a disconnected sensor reading 0 doesn't lock MIN to 0).
  const hrMax = ref(0);
  const hrMin = ref<number | null>(null);
  const speedMax = ref(0);
  const speedMin = ref<number | null>(null);
  const cadenceMax = ref(0);
  const cadenceMin = ref<number | null>(null);
  const powerMax = ref(0);
  const powerMin = ref<number | null>(null);

  let rafId: number | null = null;
  let stId: ReturnType<typeof setTimeout> | null = null;
  let lastTime = 0;
  let tabHidden = false;
  let lastPausedRenderAt = 0;

  // Authoritative elapsed time. Mirrors the server's wall-clock `elapsed`
  // (delivered on every sensor frame), interpolated with performance.now()
  // between frames so the timer ticks smoothly at display rate. This is the
  // SAME clock the server writes to the ride record, so the on-screen timer
  // equals the saved durationMs — and it's immune to rAF throttling, GPU
  // stutter, PiP, and backgrounding (which previously deflated a 56-min ride
  // to 25 min). Falls back to a local wall-clock when no recording is active
  // (free-roam / recording unavailable).
  function computeElapsedMs(nowPerf: number): number {
    const anchor = sensorStore.serverElapsedMs;
    if (anchor != null) {
      return anchor + (nowPerf - sensorStore.serverElapsedPerfNow);
    }
    return gameStore.startedAt > 0 ? Date.now() - gameStore.startedAt : elapsedMs.value;
  }

  function frame(now: number) {
    if (!isRunning.value) return;

    if (gameStore.isPaused) {
      // Physics freezes with the server sim while paused, but RENDERING must
      // keep going: the start/pause overlays are translucent, and without
      // per-frame renders they'd sit on whatever half-initialized frame the
      // canvas last drew (post-FX garbage on first mount). It does NOT have to
      // keep going at display rate though — the whole paused frame (clock,
      // interpolation, render) runs behind the PAUSED_FRAME_MS gate; on the
      // skipped rAF ticks there is nothing to recompute, since the paused
      // server stops advancing cumulativeDistance and interpolation would just
      // re-sample the same spot. The clock keeps running (方案甲: paused time
      // is not deducted, matching the record) — 15 updates/sec reads smooth.
      if (now - lastPausedRenderAt >= PAUSED_FRAME_MS) {
        lastPausedRenderAt = now;
        elapsedMs.value = computeElapsedMs(now);
        const dt = lastTime === 0 ? 16 : Math.min(now - lastTime, 100);
        lastTime = now;
        deps.ballTick(dt);
        if (!tabHidden) {
          deps.updateBallVisual();
          deps.updateCamera();
        }
      }
      // Keep the FPS window pinned to "now" while paused, so the first rollover
      // after resume counts a fresh second — not a partial frame count spread
      // over the whole pause span, which would lock fpsMin to a bogus low.
      fpsFrames = 0;
      fpsLastTime = now;
      scheduleNext();
      return;
    }
    // Un-paused: let the next pause render immediately rather than waiting out
    // a stale throttle window.
    lastPausedRenderAt = 0;

    // dt drives interpolation stepping only — timekeeping doesn't depend on it.
    const dt = lastTime === 0 ? 16 : Math.min(now - lastTime, 100);
    lastTime = now;

    elapsedMs.value = computeElapsedMs(now);

    // FPS tracking
    fpsFrames++;
    if (now - fpsLastTime >= 1000) {
      fps.value = fpsFrames;
      fpsFrames = 0;
      fpsLastTime = now;
      if (fps.value > fpsMax.value) fpsMax.value = fps.value;
      // Skip first ~2s so a partially-counted opening second doesn't lock MIN low.
      if (elapsedMs.value >= 2000) {
        if (fpsMin.value == null || fps.value < fpsMin.value) fpsMin.value = fps.value;
      }
    }

    // Server-frame interpolation (always runs)
    deps.ballTick(dt);

    // Visual updates only when tab is visible (skip in background to save CPU)
    if (!tabHidden) {
      deps.updateBallVisual();
      deps.updateCamera();
    }

    // Display-only sampling: live max/min chips + pinned-chart series. Never
    // persisted — the server summary is the record of truth.
    const hr = sensorStore.hr?.heartRate ?? 0;
    // Power: real meter first; otherwise the server's trainer-curve estimate
    // (game_state.powerW) so speed-only rigs still get a live power series.
    const power = sensorStore.pwr?.power ?? gameStateStore.powerW;
    // Speed: real wheel-speed sensor wins; otherwise derive from power so
    // power-only setups still show a non-zero speed.
    const speed = sensorStore.sc?.speed
      ?? (sensorStore.pwr ? estimateVirtualSpeedFromPower(power) : 0);
    // Cadence: real sensor wins; otherwise derive from power.
    const cadence = sensorStore.sc?.cadence
      ?? (sensorStore.pwr ? estimateVirtualCadenceFromPower(power) : 0);

    if (hr > hrMax.value) hrMax.value = hr;
    if (hr > 0 && (hrMin.value == null || hr < hrMin.value)) hrMin.value = hr;

    if (speed > speedMax.value) speedMax.value = speed;
    if (speed > 0 && (speedMin.value == null || speed < speedMin.value)) speedMin.value = speed;

    if (power > powerMax.value) powerMax.value = power;
    if (power > 0 && (powerMin.value == null || power < powerMin.value)) powerMin.value = power;

    if (cadence > 0) {
      if (cadence > cadenceMax.value) cadenceMax.value = cadence;
      if (cadenceMin.value == null || cadence < cadenceMin.value) cadenceMin.value = cadence;
    }

    // Time-series sampling (~1 sample per real second). Gated on the perf clock
    // `now` (not elapsedMs) so the chart accrues points steadily regardless of
    // how the game clock is advancing. The stored `t` is still game-elapsed
    // seconds, which equals real seconds during a live ride.
    if (now - lastSampleAtPerf >= SAMPLE_INTERVAL) {
      lastSampleAtPerf = now;
      timeSeries.value.push({
        t: Math.round(elapsedMs.value / 1000),
        hr,
        speed,
        cadence,
        power,
      });
    }

    // Check time limit
    if (elapsedMs.value >= gameStore.targetDurationMs) {
      stop();
      gameStore.endGame();
      return;
    }

    scheduleNext();
  }

  /** Schedule next frame via rAF (visible) or setTimeout (hidden) */
  function scheduleNext() {
    if (!isRunning.value) return;
    if (tabHidden) {
      stId = setTimeout(() => frame(performance.now()), 100); // ~10fps background
    } else {
      rafId = requestAnimationFrame(frame);
    }
  }

  function onVisibilityChange() {
    if (!isRunning.value) return;
    tabHidden = document.hidden;
    if (tabHidden) {
      // Tab hidden: cancel rAF, setTimeout takes over via scheduleNext
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      lastTime = 0; // reset to avoid large dt jump
      scheduleNext();
    } else {
      // Tab visible: cancel setTimeout, rAF takes over via scheduleNext
      if (stId !== null) {
        clearTimeout(stId);
        stId = null;
      }
      lastTime = 0;
      scheduleNext();
    }
  }

  function start() {
    if (isRunning.value) return;
    isRunning.value = true;
    lastTime = 0;
    lastSampleAtPerf = 0;
    lastPausedRenderAt = 0;
    elapsedMs.value = 0;
    fpsFrames = 0;
    fpsLastTime = 0;
    fps.value = 0;
    fpsMax.value = 0;
    fpsMin.value = null;
    hrMax.value = 0;     hrMin.value = null;
    speedMax.value = 0;  speedMin.value = null;
    cadenceMax.value = 0; cadenceMin.value = null;
    powerMax.value = 0;  powerMin.value = null;
    timeSeries.value = [];

    tabHidden = document.hidden;
    document.addEventListener('visibilitychange', onVisibilityChange);
    scheduleNext();
  }

  function stop() {
    isRunning.value = false;

    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (stId !== null) {
      clearTimeout(stId);
      stId = null;
    }
  }

  onUnmounted(() => {
    stop();
  });

  return {
    elapsedMs, isRunning, timeSeries,
    fps, fpsMax, fpsMin,
    hrMax, hrMin,
    speedMax, speedMin,
    cadenceMax, cadenceMin,
    powerMax, powerMin,
    start, stop,
  };
}
