/**
 * Smooth client-side wind fluctuation on top of Open-Meteo base values.
 *
 * Open-Meteo refreshes only every 15 minutes and returns one number;
 * this composable layers four sin waves at different frequencies on top
 * to make wind feel alive (gusts, slow lulls, direction wobble).
 *
 * Runs on its own RAF loop so wind keeps animating even if the game
 * loop is paused — feeds renderers and audio independently.
 */

import { ref, onUnmounted, type Ref } from 'vue';
import type { WindSample } from '@littlecycling/shared';

interface Deps {
  baseSpeedKmh: Ref<number>;
  baseDirectionDeg: Ref<number>;
}

export function useWindSimulator(deps: Deps) {
  const wind = ref<WindSample>({
    speedKmh: 0,
    baseSpeedKmh: 0,
    directionDeg: 0,
    gustFactor: 1,
  });
  let elapsedSec = 0;
  let raf = 0;
  let prevMs = 0;

  function fluct(t: number): number {
    const s1 = Math.sin(t * 0.13) * 0.20;
    const s2 = Math.sin(t * 0.41 + 1.7) * 0.15;
    const s3 = Math.sin(t * 1.07 + 3.2) * 0.08;
    const s4 = Math.sin(t * 2.30 + 0.5) * 0.04;
    return 1 + s1 + s2 + s3 + s4; // ≈ 0.5 .. 1.5
  }

  function loop(now: number) {
    const dt = prevMs ? (now - prevMs) / 1000 : 0;
    prevMs = now;
    elapsedSec += dt;

    const base = deps.baseSpeedKmh.value;
    const speed = Math.max(0, base * fluct(elapsedSec));
    const dir = deps.baseDirectionDeg.value
      + Math.sin(elapsedSec * 0.07) * 8
      + Math.sin(elapsedSec * 0.6) * 2;
    const gust = base > 0 ? speed / base : 1;

    wind.value = {
      speedKmh: speed,
      baseSpeedKmh: base,
      directionDeg: ((dir % 360) + 360) % 360,
      gustFactor: gust,
    };

    raf = requestAnimationFrame(loop);
  }

  function start() {
    if (raf) return;
    prevMs = 0;
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    prevMs = 0;
  }

  onUnmounted(stop);

  return { wind, start, stop };
}
