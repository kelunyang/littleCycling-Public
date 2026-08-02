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
  /** 幽靈的單調距離(P8)— null = 本場無幽靈。與 cum 同軸內插。 */
  ghostCum: number | null;
}

export const useGameStateStore = defineStore('gameState', () => {
  // ── Route geometry (set once per game) ──
  let routePoints: RoutePoint[] = [];
  let startOffset = 0;
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

  // ── Ghost (P8) — 幽靈車模式的鏡像輸出 ──
  /** 本場有幽靈(game_state 帶 ghost 區塊)。 */
  const ghostActive = ref(false);
  /** 幽靈內插後的單調距離(m);無幽靈為 null。 */
  const ghostDistanceM = ref<number | null>(null);
  /** 幽靈位置 — 由內插距離經同一套 interpolateAlongRoute 導出。 */
  const ghostPosition = shallowRef<InterpolatedPosition | null>(null);
  /** 幽靈的 wrapped 每圈距離(2D 卷軸的 x 軸用)。 */
  const ghostDistanceTraveled = ref(0);
  const ghostLaps = ref(0);
  /** 時間差(ms):正 = 玩家領先。離散值,latest wins(看板 1 Hz 級顯示)。 */
  const ghostGapMs = ref<number | null>(null);
  /** 幽靈已騎完它的錄製全程(停在終點)。 */
  const ghostFinished = ref(false);

  // ── 終點飛船目標 ──
  /** 預估結束位置的單調距離(m)。限時模式會隨配速漂移;無幀時為 null。
   *  刻意不內插:它本來就是個緩慢漂移的預估值,20 Hz 的階梯肉眼看不出,
   *  而飛船端另有指數平滑吸收跳動。 */
  const finishTargetCum = ref<number | null>(null);
  /** 距離預估終點還有多少(m)。 */
  const finishRemainingM = ref(0);
  /** 剩餘時間(ms);freeRoam/無時間目標為 null。 */
  const finishRemainingMs = ref<number | null>(null);

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

  function setRoute(points: RoutePoint[], startOffsetM = 0): void {
    routePoints = points;
    cumulativeDists = points.length > 0 ? buildCumulativeDistances(points) : [];
    totalDist = cumulativeDists.length > 0 ? cumulativeDists[cumulativeDists.length - 1] : 0;
    // Welcome-screen start window: the server sim uses the same offset, so the
    // ridden-space `cum` it broadcasts maps to route space via offset + cum on
    // both ends identically.
    startOffset = totalDist > 0 ? Math.max(0, startOffsetM) % totalDist : 0;
    // Seed the derived state at the offset too — before the first server frame
    // arrives, consumers (chunk streaming, HUD) must already sit at the start
    // window, not at route km 0.
    distanceTraveled.value = startOffset;
    if (points.length > 0) {
      position.value = interpolateAlongRoute(routePoints, cumulativeDists, startOffset);
    }
  }

  function push(msg: WsGameStateMessage): void {
    buffer.push({
      rx: performance.now(),
      cum: msg.cumulativeDistance,
      speedKmh: msg.speedKmh,
      steeringAngle: msg.steeringAngle,
      ghostCum: msg.ghost?.distanceM ?? null,
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

    // Ghost 離散值(gap/圈數/完賽)— latest wins;距離走內插(見 sample)。
    if (msg.ghost) {
      ghostActive.value = true;
      ghostGapMs.value = msg.ghost.gapMs;
      ghostLaps.value = msg.ghost.laps;
      ghostFinished.value = msg.ghost.finished;
    } else if (ghostActive.value) {
      ghostActive.value = false;
      ghostGapMs.value = null;
      ghostFinished.value = false;
    }

    if (msg.finishTarget) {
      finishTargetCum.value = msg.finishTarget.cumulativeM;
      finishRemainingM.value = msg.finishTarget.remainingM;
      finishRemainingMs.value = msg.finishTarget.remainingMs;
    }

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
    let ghostCum: number | null;

    const newest = buffer[n - 1];
    if (target >= newest.rx || n === 1) {
      // Buffer ran dry (or only one frame yet): clamp, no extrapolation.
      cum = newest.cum;
      spd = newest.speedKmh;
      steer = newest.steeringAngle;
      ghostCum = newest.ghostCum;
    } else if (target <= buffer[0].rx) {
      const oldest = buffer[0];
      cum = oldest.cum;
      spd = oldest.speedKmh;
      steer = oldest.steeringAngle;
      ghostCum = oldest.ghostCum;
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
      // Ghost 距離同軸同法內插(也是單調);任一端缺值就 clamp 到有值端。
      ghostCum = a.ghostCum !== null && b.ghostCum !== null
        ? a.ghostCum + (b.ghostCum - a.ghostCum) * t
        : (b.ghostCum ?? a.ghostCum);
    }

    cumulativeDistance.value = cum;
    speedKmh.value = spd;
    steeringAngle.value = steer;

    if (ghostCum !== null && totalDist > 0 && routePoints.length > 0) {
      const gLaps = Math.floor(ghostCum / totalDist);
      const gWrapped = ghostCum - gLaps * totalDist;
      ghostDistanceM.value = ghostCum;
      ghostDistanceTraveled.value = gWrapped;
      ghostPosition.value = interpolateAlongRoute(routePoints, cumulativeDists, gWrapped);
    } else if (ghostCum === null) {
      ghostDistanceM.value = null;
      ghostPosition.value = null;
      ghostDistanceTraveled.value = 0;
    }

    if (totalDist > 0) {
      // Shift ridden-space cum into route space (start window) — mirrors the
      // server sim's derivation exactly.
      const routeCum = startOffset + cum;
      const lapCount = Math.floor(routeCum / totalDist);
      const wrapped = routeCum - lapCount * totalDist;
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
    ghostActive.value = false;
    ghostDistanceM.value = null;
    ghostPosition.value = null;
    ghostDistanceTraveled.value = 0;
    ghostLaps.value = 0;
    ghostGapMs.value = null;
    ghostFinished.value = false;
    finishTargetCum.value = null;
    finishRemainingM.value = 0;
    finishRemainingMs.value = null;
    routePoints = [];
    cumulativeDists = [];
    totalDist = 0;
    coinOpsHandler = null;
  }

  return {
    // outputs
    position, cumulativeDistance, distanceTraveled, laps, speedKmh, steeringAngle,
    paused, ended, powerW, powerSource, zone, combo, coinsTotal, elapsed, event, idleMs, autoPaused, hasFrames,
    ghostActive, ghostDistanceM, ghostPosition, ghostDistanceTraveled, ghostLaps, ghostGapMs, ghostFinished,
    finishTargetCum, finishRemainingM, finishRemainingMs,
    // actions
    setRoute, push, sample, reset, onCoinOps,
  };
});
