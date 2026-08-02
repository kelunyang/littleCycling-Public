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
  let lastPublishMs = 0;

  // Wind evolves slowly (Open-Meteo refreshes every 15 min; our sin-wave
  // fluctuation is gentle), so there's no visual/audio benefit to publishing a
  // fresh sample 60×/s. Integrate every frame for identical physics, but only
  // publish (and thus wake GameView's watch + audio) ~10×/s.
  const PUBLISH_INTERVAL_MS = 100;

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

    // Integrate every frame (identical physics), publish ~10×/s.
    //
    // `PUBLISH_INTERVAL_MS` and `lastPublishMs` were declared above with the
    // comment explaining exactly this, and then never referenced — the throttle
    // was written and not wired, so every frame wrote `wind.value` and woke
    // GameView's watcher and the audio graph 60×/s for a quantity that changes
    // on a 15-minute weather refresh.
    //
    // It matters more than it looks. The first real GPU measurement (8700G,
    // high tier, 1720k triangles at 2115×1148) puts the GPU at 8.17 ms of a
    // 16.7 ms frame, while `corr(avgFrameMs, avgOutsideMs) = 0.998` — the frame
    // time IS the non-render main-thread time. This is one of the things in it.
    if (now - lastPublishMs >= PUBLISH_INTERVAL_MS) {
      lastPublishMs = now;
      wind.value = {
        speedKmh: speed,
        baseSpeedKmh: base,
        directionDeg: ((dir % 360) + 360) % 360,
        gustFactor: gust,
      };
    }

    raf = requestAnimationFrame(loop);
  }

  function start() {
    if (raf) return;
    prevMs = 0;
    // Publish on the first frame after a start, not 100 ms into the ride.
    lastPublishMs = 0;
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
