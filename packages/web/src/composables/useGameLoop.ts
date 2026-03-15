import { ref, onUnmounted } from 'vue';
import { COIN_TICK_INTERVAL, getHrZone } from '@littlecycling/shared';
import { useGameStore } from '@/stores/gameStore';
import { useSensorStore } from '@/stores/sensorStore';
import { useSettingsStore } from '@/stores/settingsStore';

interface GameLoopDeps {
  ballTick: (dtMs: number) => void;
  updateBallVisual: () => void;
  updateCamera: () => void;
  coinTick: () => void;
}

export interface GameStats {
  avgHr: number;
  avgSpeed: number;
  avgPower: number;
  maxHr: number;
  maxSpeed: number;
  maxPower: number;
  avgCadence: number;
  zoneSustainPct: number; // Z2+Z3 time as percentage of total (0-100)
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

export function useGameLoop(deps: GameLoopDeps) {
  const gameStore = useGameStore();
  const sensorStore = useSensorStore();
  const settingsStore = useSettingsStore();

  const elapsedMs = ref(0);
  const isRunning = ref(false);
  const stats = ref<GameStats>({
    avgHr: 0, avgSpeed: 0, avgPower: 0,
    maxHr: 0, maxSpeed: 0, maxPower: 0,
    avgCadence: 0, zoneSustainPct: 0,
  });

  // Time-series data for pinned charts
  const timeSeries = ref<TimeSeriesSample[]>([]);
  let lastSampleMs = 0;

  // FPS counter (updated ~1/sec)
  const fps = ref(0);
  let fpsFrames = 0;
  let fpsLastTime = 0;

  let rafId: number | null = null;
  let stId: ReturnType<typeof setTimeout> | null = null;
  let coinTimerId: ReturnType<typeof setInterval> | null = null;
  let lastTime = 0;
  let tabHidden = false;

  // Running averages
  let sumHr = 0, sumSpeed = 0, sumPower = 0, sampleCount = 0;
  let maxHr = 0, maxSpeed = 0, maxPower = 0;
  let sumCadence = 0, cadenceCount = 0;
  let zoneSustainTicks = 0, hrTotalTicks = 0;

  function frame(now: number) {
    if (!isRunning.value) return;

    const dt = lastTime === 0 ? 16 : Math.min(now - lastTime, 100); // cap at 100ms
    lastTime = now;

    elapsedMs.value += dt;

    // FPS tracking
    fpsFrames++;
    if (now - fpsLastTime >= 1000) {
      fps.value = fpsFrames;
      fpsFrames = 0;
      fpsLastTime = now;
    }

    // Physics (always runs)
    deps.ballTick(dt);

    // Visual updates only when tab is visible (skip in background to save CPU)
    if (!tabHidden) {
      deps.updateBallVisual();
      deps.updateCamera();
    }

    // Stats sampling
    sampleCount++;
    const hr = sensorStore.hr?.heartRate ?? 0;
    const speed = sensorStore.sc?.speed ?? 0;
    const power = sensorStore.pwr?.power ?? 0;

    sumHr += hr;
    sumSpeed += speed;
    sumPower += power;
    if (hr > maxHr) maxHr = hr;
    if (speed > maxSpeed) maxSpeed = speed;
    if (power > maxPower) maxPower = power;

    // Cadence accumulation
    const cadence = sensorStore.sc?.cadence ?? 0;
    if (cadence > 0) {
      sumCadence += cadence;
      cadenceCount++;
    }

    // Zone sustain tracking (Z2+Z3)
    if (hr > 0) {
      hrTotalTicks++;
      const zone = getHrZone(hr, settingsStore.config.training.hrMax);
      if (zone && (zone.zone === 2 || zone.zone === 3)) {
        zoneSustainTicks++;
      }
    }

    // Time-series sampling (~1 sample/second)
    if (elapsedMs.value - lastSampleMs >= SAMPLE_INTERVAL) {
      lastSampleMs = elapsedMs.value;
      timeSeries.value.push({
        t: Math.round(elapsedMs.value / 1000),
        hr,
        speed,
        cadence: sensorStore.sc?.cadence ?? 0,
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
    lastSampleMs = 0;
    fpsFrames = 0;
    fpsLastTime = 0;
    fps.value = 0;
    timeSeries.value = [];
    sumHr = sumSpeed = sumPower = sampleCount = 0;
    maxHr = maxSpeed = maxPower = 0;
    sumCadence = cadenceCount = 0;
    zoneSustainTicks = hrTotalTicks = 0;

    tabHidden = document.hidden;
    document.addEventListener('visibilitychange', onVisibilityChange);
    scheduleNext();
    coinTimerId = setInterval(() => deps.coinTick(), COIN_TICK_INTERVAL);
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
    if (coinTimerId !== null) {
      clearInterval(coinTimerId);
      coinTimerId = null;
    }

    // Finalize stats
    if (sampleCount > 0) {
      stats.value = {
        avgHr: Math.round(sumHr / sampleCount),
        avgSpeed: Math.round((sumSpeed / sampleCount) * 10) / 10,
        avgPower: Math.round(sumPower / sampleCount),
        maxHr,
        maxSpeed: Math.round(maxSpeed * 10) / 10,
        maxPower,
        avgCadence: cadenceCount > 0 ? Math.round(sumCadence / cadenceCount) : 0,
        zoneSustainPct: hrTotalTicks > 0
          ? Math.round((zoneSustainTicks / hrTotalTicks) * 1000) / 10
          : 0,
      };
    }
  }

  onUnmounted(() => {
    stop();
  });

  return { elapsedMs, isRunning, stats, timeSeries, fps, start, stop };
}
