/**
 * gameStateStore — client-side view of the server-authoritative simulation.
 *
 * Buffers `game_state` snapshots (20Hz) and interpolates between them at
 * render rate. The render loop calls `sample()` once per frame; everything
 * else reads the reactive outputs.
 *
 * Interpolation contract (risk #1 in plan/2026-summer.md):
 * - Interpolate ONLY the monotonic `cumulativeDistance`. Never lerp the
 *   wrapped `distanceTraveled` (resets to 0 each lap → the ball would sweep
 *   backwards across the whole route) and never lerp raw lat/lon (cuts
 *   corners off curves).
 * - Position AND bearing derive from the interpolated distance via the
 *   shared `interpolateAlongRoute` — the same function, route, and
 *   cumulative table the server used. Because bearing is a pure function of
 *   route distance, deriving it this way IS the correct shortest-arc
 *   interpolation of the server's bearings, with the smoothing window
 *   already applied (no 359°→1° wraparound spin possible).
 * - Render ~1.5 snapshot intervals behind receipt time so there is almost
 *   always a fresh pair to interpolate between. When the buffer runs dry
 *   (packet gap), clamp to the newest snapshot — no client-side prediction,
 *   the ball just holds still (inputs live on the server; there is nothing
 *   honest to extrapolate from).
 *
 * Snapshots are stamped with `performance.now()` at receipt (same pattern as
 * sensorStore.updateClock) so interpolation runs on the local monotonic
 * clock and never trusts network timing.
 */

import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import type { GameEventDto, RoutePoint, WsGameStateMessage } from '@littlecycling/shared';
import {
  buildCumulativeDistances,
  interpolateAlongRoute,
  type InterpolatedPosition,
} from '@littlecycling/shared';

/**
 * How far behind receipt time we render. 1.5× the 50ms broadcast interval:
 * one interval of headroom plus half an interval of jitter margin. Raising
 * it smooths bigger jitter at the cost of visible latency.
 */
const RENDER_DELAY_MS = 75;

/** Snapshots kept for interpolation (~3s at 20Hz — plenty past the delay). */
const BUFFER_MAX = 64;

interface BufferedSnapshot {
  /** performance.now() at receipt — the interpolation time axis. */
  rx: number;
  cum: number;
  speedKmh: number;
  steeringAngle: number;
}

export const useGameStateStore = defineStore('gameState', () => {
  // ── Route geometry (set once per game) ──
  let routePoints: RoutePoint[] = [];
  let cumulativeDists: number[] = [];
  let totalDist = 0;

  // ── Snapshot buffer (plain array — not reactive, touched at 20Hz/60fps) ──
  let buffer: BufferedSnapshot[] = [];

  // ── Interpolated outputs (written by sample(), read by renderer/HUD) ──
  const position = shallowRef<InterpolatedPosition>({ lat: 0, lon: 0, ele: 0, bearing: 0 });
  const cumulativeDistance = ref(0);
  const distanceTraveled = ref(0);
  const laps = ref(0);
  const speedKmh = ref(0);
  const steeringAngle = ref(0);

  // ── Discrete state (latest-value semantics, written at receipt) ──
  const paused = ref(true);
  const ended = ref(false);
  /** Server-effective watts (meter reading, or trainer-curve estimate on
   *  power-less rigs). Step signal — latest value, never interpolated. THE
   *  value every client-side power evaluation must use (not speedKmh). */
  const powerW = ref(0);
  /** 'meter' when a real PWR sensor drives powerW, 'estimated' otherwise. */
  const powerSource = ref<'meter' | 'estimated'>('estimated');
  const zone = ref<number | null>(null);
  const combo = ref(1);
  const coinsTotal = ref(0);
  const elapsed = ref(0);
  /** Latest in-flight random event (null when idle/cooldown). */
  const event = ref<GameEventDto | null>(null);
  /** ms the rider has been not-pedalling (0 when pedalling or paused). Drives
   *  the scold bubble + auto-pause countdown bar. */
  const idleMs = ref(0);
  /** True when the sim auto-paused from 30s of no pedalling (vs manual pause).
   *  Drives the "pedal to resume" prompt; server auto-resumes on pedalling. */
  const autoPaused = ref(false);
  /** True once at least one game_state frame has arrived this game. */
  const hasFrames = ref(false);

  // ── Coin ops pass-through (P5) ──
  // Coin deltas carry renderer resources (visual handles live in the coin
  // layer), so the store doesn't own them — it forwards each message's ops
  // to the single registered adapter. Missed ops (adapter not yet mounted)
  // are healed by the server's periodic reconcile.
  type CoinOps = NonNullable<WsGameStateMessage['coins']>;
  let coinOpsHandler: ((ops: CoinOps) => void) | null = null;

  function onCoinOps(handler: ((ops: CoinOps) => void) | null): void {
    coinOpsHandler = handler;
  }

  function setRoute(points: RoutePoint[]): void {
    routePoints = points;
    cumulativeDists = points.length > 0 ? buildCumulativeDistances(points) : [];
    totalDist = cumulativeDists.length > 0 ? cumulativeDists[cumulativeDists.length - 1] : 0;
    if (points.length > 0) {
      position.value = interpolateAlongRoute(routePoints, cumulativeDists, 0);
    }
  }

  function push(msg: WsGameStateMessage): void {
    buffer.push({
      rx: performance.now(),
      cum: msg.cumulativeDistance,
      speedKmh: msg.speedKmh,
      steeringAngle: msg.steeringAngle,
    });
    if (buffer.length > BUFFER_MAX) {
      buffer.splice(0, buffer.length - BUFFER_MAX);
    }

    // Discrete state doesn't interpolate — latest value wins immediately.
    paused.value = msg.paused;
    ended.value = msg.ended;
    powerW.value = msg.powerW ?? 0;
    powerSource.value = msg.powerSource ?? 'estimated';
    zone.value = msg.zone;
    combo.value = msg.combo;
    coinsTotal.value = msg.coinsTotal;
    elapsed.value = msg.elapsed;
    event.value = msg.event ?? null;
    idleMs.value = msg.idleMs ?? 0;
    autoPaused.value = msg.autoPaused ?? false;
    hasFrames.value = true;

    if (msg.coins && coinOpsHandler) {
      coinOpsHandler(msg.coins);
    }
  }

  /**
   * Interpolate state at (nowPerf - RENDER_DELAY_MS) and publish to the
   * reactive outputs. Called once per rendered frame by the game loop.
   */
  function sample(nowPerf: number): void {
    const n = buffer.length;
    if (n === 0) return; // keep last published values

    const target = nowPerf - RENDER_DELAY_MS;

    let cum: number;
    let spd: number;
    let steer: number;

    const newest = buffer[n - 1];
    if (target >= newest.rx || n === 1) {
      // Buffer ran dry (or only one frame yet): clamp, no extrapolation.
      cum = newest.cum;
      spd = newest.speedKmh;
      steer = newest.steeringAngle;
    } else if (target <= buffer[0].rx) {
      const oldest = buffer[0];
      cum = oldest.cum;
      spd = oldest.speedKmh;
      steer = oldest.steeringAngle;
    } else {
      // Scan from the tail — target is almost always inside the last pair.
      let i = n - 2;
      while (i > 0 && buffer[i].rx > target) i--;
      const a = buffer[i];
      const b = buffer[i + 1];
      const span = b.rx - a.rx;
      const t = span > 0 ? (target - a.rx) / span : 1;
      // cum is monotonic: lerping it can only move forward. This is the
      // whole trick — a lap boundary between a and b is invisible here.
      cum = a.cum + (b.cum - a.cum) * t;
      spd = a.speedKmh + (b.speedKmh - a.speedKmh) * t;
      steer = a.steeringAngle + (b.steeringAngle - a.steeringAngle) * t;
    }

    cumulativeDistance.value = cum;
    speedKmh.value = spd;
    steeringAngle.value = steer;

    if (totalDist > 0) {
      const lapCount = Math.floor(cum / totalDist);
      const wrapped = cum - lapCount * totalDist;
      laps.value = lapCount;
      distanceTraveled.value = wrapped;
      if (routePoints.length > 0) {
        position.value = interpolateAlongRoute(routePoints, cumulativeDists, wrapped);
      }
    } else {
      laps.value = 0;
      distanceTraveled.value = cum;
    }
  }

  function reset(): void {
    buffer = [];
    position.value = { lat: 0, lon: 0, ele: 0, bearing: 0 };
    cumulativeDistance.value = 0;
    distanceTraveled.value = 0;
    laps.value = 0;
    speedKmh.value = 0;
    steeringAngle.value = 0;
    paused.value = true;
    ended.value = false;
    powerW.value = 0;
    powerSource.value = 'estimated';
    zone.value = null;
    combo.value = 1;
    coinsTotal.value = 0;
    elapsed.value = 0;
    event.value = null;
    idleMs.value = 0;
    autoPaused.value = false;
    hasFrames.value = false;
    routePoints = [];
    cumulativeDists = [];
    totalDist = 0;
    coinOpsHandler = null;
  }

  return {
    // outputs
    position, cumulativeDistance, distanceTraveled, laps, speedKmh, steeringAngle,
    paused, ended, powerW, powerSource, zone, combo, coinsTotal, elapsed, event, idleMs, autoPaused, hasFrames,
    // actions
    setRoute, push, sample, reset, onCoinOps,
  };
});
