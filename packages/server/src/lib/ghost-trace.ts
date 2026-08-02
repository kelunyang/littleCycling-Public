/**
 * Ghost trace (P8) — 把一筆歷史騎乘變成幽靈的 distance-vs-time 曲線。
 *
 * 兩條路徑:
 *  - 'recorded':ride_samples 有 distance_m(sim 權威 cumulativeDistance,
 *    含暫停凍結/staleness 歸零語意)→ 直接 1 Hz 重採樣。
 *  - 'reintegrated':舊騎乘無 distance_m → 用同一套物理
 *    (estimateVirtualSpeedFromPower)從 power 樣本重新積分;完全沒有 power
 *    樣本的騎乘(純 HR+速度計)退回直接積分 speed_kmh。積分的 dt 有上限
 *    (mirror sim 的 suspend guard),取樣空窗不會讓幽靈瞬移。
 *
 * 時間軸:該次騎乘自己的 elapsed_ms(錨在 recordingStartTime 的牆鐘)。
 * 播放時對齊本場的 gameTimeMs — 見 game-simulation.ts 的 ghost 區塊。
 */

import { estimateVirtualSpeedFromPower, type GhostTracePoint } from '@littlecycling/shared';

/** 重採樣網格間距 — 1 Hz 已足夠平滑(前端每幀再線性內插)。 */
const RESAMPLE_MS = 1_000;

/** Fallback 積分的單段 dt 上限 — mirror sim 的 MAX_TICK_DT suspend guard。 */
const MAX_INTEGRATE_DT_MS = 5_000;

/** buildGhostTrace 的輸入列(ride_samples 的相關欄位;distanceM 舊騎乘為 null)。 */
export interface GhostSampleRow {
  elapsedMs: number;
  distanceM: number | null;
  powerW: number | null;
  speedKmh: number | null;
}

export interface BuiltGhostTrace {
  points: GhostTracePoint[];
  source: 'recorded' | 'reintegrated';
}

/**
 * 由 ride_samples 建 trace。樣本須依 elapsedMs 升冪(DB index 保證)。
 * 空樣本回傳空 points — 呼叫端(端點)應視為「此騎乘不能當幽靈」。
 */
export function buildGhostTrace(samples: GhostSampleRow[]): BuiltGhostTrace {
  if (samples.length === 0) return { points: [], source: 'recorded' };

  // distance_m 欄有實質資料(最後一筆 > 0)→ recorded 路徑。
  const lastWithDist = [...samples].reverse().find((s) => s.distanceM !== null);
  if (lastWithDist && (lastWithDist.distanceM ?? 0) > 0) {
    return { points: resampleRecorded(samples), source: 'recorded' };
  }
  return { points: reintegrate(samples), source: 'reintegrated' };
}

/** recorded 路徑:對 (elapsedMs, distanceM) 折線做 1 Hz 重採樣 + 單調化。 */
function resampleRecorded(samples: GhostSampleRow[]): GhostTracePoint[] {
  const pts = samples
    .filter((s) => s.distanceM !== null)
    .map((s) => ({ tMs: s.elapsedMs, distM: s.distanceM as number }));
  if (pts.length === 0) return [];
  return resampleMonotonic(pts);
}

/** reintegrated 路徑:同套物理從 power 積分;無 power 則直接積分 speed。 */
function reintegrate(samples: GhostSampleRow[]): GhostTracePoint[] {
  const hasPower = samples.some((s) => (s.powerW ?? 0) > 0);
  const pts: GhostTracePoint[] = [];
  let dist = 0;
  let prevT: number | null = null;
  let prevSpeedMps = 0;

  for (const s of samples) {
    if (prevT !== null) {
      // 空窗上限:錄製中斷(訊號掉線)不該讓幽靈以舊速度飛過空窗。
      const dt = Math.min(s.elapsedMs - prevT, MAX_INTEGRATE_DT_MS);
      if (dt > 0) dist += prevSpeedMps * (dt / 1000);
    }
    const speedKmh = hasPower
      ? estimateVirtualSpeedFromPower(s.powerW ?? 0)
      : (s.speedKmh ?? 0);
    prevSpeedMps = (speedKmh * 1000) / 3600;
    prevT = s.elapsedMs;
    pts.push({ tMs: s.elapsedMs, distM: dist });
  }
  return resampleMonotonic(pts);
}

/** 折線 → 1 Hz 網格(線性內插),並強制 distM 單調不減(防原始資料毛刺)。 */
function resampleMonotonic(pts: GhostTracePoint[]): GhostTracePoint[] {
  if (pts.length === 0) return [];
  const endT = pts[pts.length - 1].tMs;
  const out: GhostTracePoint[] = [];
  let i = 0;
  let maxDist = 0;
  for (let t = 0; ; t += RESAMPLE_MS) {
    const clampedT = Math.min(t, endT);
    while (i < pts.length - 1 && pts[i + 1].tMs <= clampedT) i++;
    const a = pts[i];
    const b = pts[Math.min(i + 1, pts.length - 1)];
    let d: number;
    if (clampedT <= a.tMs || b.tMs === a.tMs) {
      d = a.distM;
    } else {
      const f = (clampedT - a.tMs) / (b.tMs - a.tMs);
      d = a.distM + (b.distM - a.distM) * Math.min(1, f);
    }
    maxDist = Math.max(maxDist, d);
    out.push({ tMs: clampedT, distM: maxDist });
    if (clampedT >= endT) break;
  }
  return out;
}

/**
 * 幽靈 trace 的查詢器 — sim 每 tick 用。兩個方向都是二分搜尋,20 Hz 下零負擔。
 * points 必須依 tMs 升冪且 distM 單調不減(buildGhostTrace 的輸出保證)。
 */
export class GhostTraceLookup {
  private readonly points: GhostTracePoint[];

  constructor(points: GhostTracePoint[]) {
    if (points.length === 0) throw new Error('GhostTraceLookup: empty trace');
    this.points = points;
  }

  get finalTimeMs(): number {
    return this.points[this.points.length - 1].tMs;
  }

  get finalDistanceM(): number {
    return this.points[this.points.length - 1].distM;
  }

  /** 幽靈在 tMs 時刻的距離(端點外 clamp — 騎完就停在終點距離)。 */
  distanceAt(tMs: number): number {
    const pts = this.points;
    if (tMs <= pts[0].tMs) return pts[0].distM;
    if (tMs >= this.finalTimeMs) return this.finalDistanceM;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].tMs <= tMs) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    if (b.tMs === a.tMs) return a.distM;
    const f = (tMs - a.tMs) / (b.tMs - a.tMs);
    return a.distM + (b.distM - a.distM) * f;
  }

  /**
   * 幽靈「首次到達」distM 的時刻。distM 超過幽靈全程 → clamp 到終點時刻
   * (時間差因此被低估,但 finished 旗標會讓前端知道幽靈已完賽)。
   * 平坦段(幽靈暫停/停踩)取段首 — 「到達」以第一次觸及為準,對比才公平。
   */
  timeAtDistance(distM: number): number {
    const pts = this.points;
    if (distM <= pts[0].distM) return pts[0].tMs;
    if (distM >= this.finalDistanceM) return this.finalTimeMs;
    // 找第一個 distM >= 目標的點(distM 單調不減 → lower bound)。
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].distM < distM) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    if (b.distM === a.distM) return a.tMs;
    const f = (distM - a.distM) / (b.distM - a.distM);
    return a.tMs + (b.tMs - a.tMs) * f;
  }
}
