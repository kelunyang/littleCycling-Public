/**
 * 騎乘進階指標 — 純函式，吃 RideSample[] 加參數，前後端皆可用、可單測。
 *
 * 事件驅動的樣本間距不固定，凡是需要「等時距」的計算（NP、best efforts、
 * 最佳 20 分鐘）都先用 carry-forward 重採樣到 1Hz 網格再做 rolling window。
 * 心率區間分布則沿用前端圖表的 dt-weighted、跳 >10s 斷點演算法，確保後端
 * 工具回報的數字與前端 ride 圖表一致。
 *
 * 時間一律 ms；此檔不碰 I/O，所有輸入輸出都是純資料。
 */

import type { RideSample } from './types.js';
import { getHrZone, HR_ZONES } from './hr-zones.js';
import { workoutGrade, type WorkoutSegment } from './workouts.js';

// ── 1Hz carry-forward 重採樣 ──

/** 重採樣結果：每個 channel 為長度 totalSec+1 的 1 秒網格（缺值 carry-forward，初始 0）。 */
export interface Resampled1Hz {
  /** 最後一筆樣本的秒數（floor(elapsedMs/1000)）；網格索引 0..totalSec。 */
  totalSec: number;
  power: number[];
  hr: number[];
  cadence: number[];
  speed: number[];
}

/**
 * 把不等距樣本重採樣到 1Hz 網格。功率/心率/踏頻/速度視為分段常數
 * （carry-forward）：每一秒取「時間 <= 該秒」的最後一次讀值，缺值沿用上一個。
 *
 * 這是 database.getBest20MinAvgPower 原本內嵌的手法抽出來共用——行為刻意保持
 * 一致（功率網格與原本逐位元組相同），故該函式改吃本結果不會改變估算值。
 */
export function resampleTo1Hz(samples: RideSample[]): Resampled1Hz {
  if (samples.length === 0) {
    return { totalSec: 0, power: [], hr: [], cadence: [], speed: [] };
  }
  const totalSec = Math.floor(samples[samples.length - 1].elapsedMs / 1000);
  const power = new Array<number>(totalSec + 1);
  const hr = new Array<number>(totalSec + 1);
  const cadence = new Array<number>(totalSec + 1);
  const speed = new Array<number>(totalSec + 1);

  let si = 0;
  let lastPower = 0;
  let lastHr = 0;
  let lastCad = 0;
  let lastSpeed = 0;
  for (let t = 0; t <= totalSec; t++) {
    const tMs = t * 1000;
    while (si < samples.length && samples[si].elapsedMs <= tMs) {
      const s = samples[si];
      if (s.powerW != null) lastPower = s.powerW;
      if (s.hr != null) lastHr = s.hr;
      if (s.cadence != null) lastCad = s.cadence;
      if (s.speedKmh != null) lastSpeed = s.speedKmh;
      si++;
    }
    power[t] = lastPower;
    hr[t] = lastHr;
    cadence[t] = lastCad;
    speed[t] = lastSpeed;
  }
  return { totalSec, power, hr, cadence, speed };
}

/** grid 上寬度 win 秒的 rolling 平均最大值；資料不足回 null。 */
function bestRollingAvg(grid: number[], win: number): number | null {
  if (win <= 0 || grid.length < win) return null;
  let sum = 0;
  for (let i = 0; i < win; i++) sum += grid[i];
  let best = sum;
  for (let i = win; i < grid.length; i++) {
    sum += grid[i] - grid[i - win];
    if (sum > best) best = sum;
  }
  const avg = best / win;
  return avg > 0 ? Math.round(avg) : null;
}

// ── 心率區間分布（全五區）──

/** 單一區的時間占比。 */
export interface ZoneBucket {
  zone: number;   // 1-5
  name: string;
  minutes: number;
  pct: number;    // 占「有效心率時間」的百分比（0-100，一位小數）
}

export interface ZoneDistribution {
  totalMinutes: number;
  zones: ZoneBucket[];
}

/**
 * 全五區 time-in-zone（dt-weighted），跳過 >10s 的斷點。
 *
 * 演算法移植自前端 useRideCharts.renderZoneDistribution：以相鄰樣本的時間差
 * dt 加權累計，dt<=0 或 >10000ms（感測器掉線）不計入，確保與前端圖表一致。
 */
export function zoneDistribution(samples: RideSample[], hrMax: number): ZoneDistribution {
  const zoneMs = [0, 0, 0, 0, 0];
  let prevMs = 0;
  for (const s of samples) {
    if (s.hr == null) continue;
    const dt = s.elapsedMs - prevMs;
    prevMs = s.elapsedMs;
    if (dt <= 0 || dt > 10_000) continue;
    const zone = getHrZone(s.hr, hrMax);
    if (zone && zone.zone >= 1 && zone.zone <= 5) {
      zoneMs[zone.zone - 1] += dt;
    }
  }
  const totalMs = zoneMs.reduce((a, b) => a + b, 0);
  const zones: ZoneBucket[] = HR_ZONES.map((z, i) => ({
    zone: z.zone,
    name: z.name,
    minutes: Math.round((zoneMs[i] / 60_000) * 10) / 10,
    pct: totalMs > 0 ? Math.round((zoneMs[i] / totalMs) * 1000) / 10 : 0,
  }));
  return { totalMinutes: Math.round((totalMs / 60_000) * 10) / 10, zones };
}

// ── 進階功率指標（NP / IF / TSS / VI + Coggan 七區）──

/** Coggan 功率七區（以 FTP 百分比的上界界定；最後一區為開放上界）。 */
const COGGAN_ZONES: { zone: number; name: string; maxPct: number }[] = [
  { zone: 1, name: 'Active Recovery', maxPct: 0.55 },
  { zone: 2, name: 'Endurance',       maxPct: 0.75 },
  { zone: 3, name: 'Tempo',           maxPct: 0.90 },
  { zone: 4, name: 'Threshold',       maxPct: 1.05 },
  { zone: 5, name: 'VO2max',          maxPct: 1.20 },
  { zone: 6, name: 'Anaerobic',       maxPct: 1.50 },
  { zone: 7, name: 'Neuromuscular',   maxPct: Infinity },
];

export interface PowerZoneBucket {
  zone: number;
  name: string;
  minutes: number;
  pct: number;
}

export interface PowerMetrics {
  durationSec: number;
  avgPower: number;         // 1Hz 網格平均功率（含滑行）
  normalizedPower: number;  // NP
  intensityFactor: number;  // IF = NP / FTP（兩位小數）
  tss: number;              // Training Stress Score（一位小數）
  variabilityIndex: number; // VI = NP / avgPower（兩位小數）
  cogganZones: PowerZoneBucket[];
}

/**
 * NP / IF / TSS / VI 與 Coggan 七區功率分布。
 * - NP：1Hz 網格上 30 秒 rolling 平均 → 四次方 → 取平均 → 開四次方。
 * - IF = NP / FTP；TSS = (durSec × NP × IF)/(FTP × 3600) × 100；VI = NP / avgP。
 * 無可用功率（全 0 或無樣本）回 null。
 */
export function powerMetrics(samples: RideSample[], ftp: number): PowerMetrics | null {
  const { power, totalSec } = resampleTo1Hz(samples);
  if (power.length === 0) return null;

  const sumPower = power.reduce((a, b) => a + b, 0);
  const avgPower = sumPower / power.length;
  if (avgPower <= 0) return null;

  // NP：30 秒 rolling 平均（不足 30 秒則以全段平均為單一視窗）。
  const win = 30;
  let fourthSum = 0;
  let fourthCount = 0;
  if (power.length < win) {
    const m = avgPower;
    fourthSum = Math.pow(m, 4);
    fourthCount = 1;
  } else {
    let roll = 0;
    for (let i = 0; i < power.length; i++) {
      roll += power[i];
      if (i >= win) roll -= power[i - win];
      if (i >= win - 1) {
        const m = roll / win;
        fourthSum += Math.pow(m, 4);
        fourthCount++;
      }
    }
  }
  const np = Math.round(Math.pow(fourthSum / fourthCount, 0.25));

  const intensityFactor = ftp > 0 ? Math.round((np / ftp) * 100) / 100 : 0;
  const durationSec = totalSec;
  const tss = ftp > 0
    ? Math.round((durationSec * np * intensityFactor) / (ftp * 3600) * 100 * 10) / 10
    : 0;
  const variabilityIndex = Math.round((np / avgPower) * 100) / 100;

  // Coggan 七區時間分布（以網格每秒的功率歸類）。
  const zoneSec = new Array<number>(COGGAN_ZONES.length).fill(0);
  for (const p of power) {
    const pct = ftp > 0 ? p / ftp : 0;
    for (let z = 0; z < COGGAN_ZONES.length; z++) {
      if (pct < COGGAN_ZONES[z].maxPct) {
        zoneSec[z]++;
        break;
      }
    }
  }
  const totalGridSec = power.length;
  const cogganZones: PowerZoneBucket[] = COGGAN_ZONES.map((z, i) => ({
    zone: z.zone,
    name: z.name,
    minutes: Math.round((zoneSec[i] / 60) * 10) / 10,
    pct: totalGridSec > 0 ? Math.round((zoneSec[i] / totalGridSec) * 1000) / 10 : 0,
  }));

  return {
    durationSec,
    avgPower: Math.round(avgPower),
    normalizedPower: np,
    intensityFactor,
    tss,
    variabilityIndex,
    cogganZones,
  };
}

// ── Best efforts（功率曲線）──

export interface BestEffort {
  windowSec: number;
  watts: number | null;
}

/** 各時窗（預設 5s/1min/5min/20min）的最佳 rolling 平均功率。 */
export function bestEfforts(
  samples: RideSample[],
  windowsSec: number[] = [5, 60, 300, 1200],
): BestEffort[] {
  const { power } = resampleTo1Hz(samples);
  return windowsSec.map((w) => ({ windowSec: w, watts: bestRollingAvg(power, w) }));
}

// ── 有氧脫鉤（Pw:HR decoupling）──

export interface HrDriftResult {
  driftPct: number;             // (前半比值 − 後半比值) / 前半比值 × 100（正值=脫鉤）
  firstHalf: { avgPower: number; avgHr: number; ratio: number };
  secondHalf: { avgPower: number; avgHr: number; ratio: number };
  decoupled: boolean;           // driftPct > 5 視為有氧耐力不足
}

/**
 * Pw:HR 脫鉤分析：排除暖身前 10%，把剩餘時間對半切，各半計算 power/hr 比值，
 * drift% = (前半 − 後半)/前半 × 100（正值代表同功率下心率漂高＝脫鉤）。
 * 心率+功率資料不足時回 null。
 */
export function hrDrift(samples: RideSample[]): HrDriftResult | null {
  const valid = samples.filter((s) => s.hr != null && s.hr > 0 && s.powerW != null);
  if (valid.length < 4) return null;

  const start = valid[0].elapsedMs;
  const end = valid[valid.length - 1].elapsedMs;
  const total = end - start;
  if (total <= 0) return null;

  const remainStart = start + total * 0.10; // 跳過暖身前 10%
  const mid = remainStart + (end - remainStart) / 2;

  let p1 = 0, h1 = 0, n1 = 0;
  let p2 = 0, h2 = 0, n2 = 0;
  for (const s of valid) {
    if (s.elapsedMs < remainStart) continue;
    if (s.elapsedMs < mid) {
      p1 += s.powerW as number; h1 += s.hr as number; n1++;
    } else {
      p2 += s.powerW as number; h2 += s.hr as number; n2++;
    }
  }
  if (n1 === 0 || n2 === 0) return null;

  const avgP1 = p1 / n1, avgH1 = h1 / n1;
  const avgP2 = p2 / n2, avgH2 = h2 / n2;
  if (avgH1 <= 0 || avgH2 <= 0) return null;

  const ratio1 = avgP1 / avgH1;
  const ratio2 = avgP2 / avgH2;
  if (ratio1 === 0) return null;

  const driftPct = Math.round(((ratio1 - ratio2) / ratio1) * 1000) / 10;
  return {
    driftPct,
    firstHalf: { avgPower: Math.round(avgP1), avgHr: Math.round(avgH1), ratio: Math.round(ratio1 * 1000) / 1000 },
    secondHalf: { avgPower: Math.round(avgP2), avgHr: Math.round(avgH2), ratio: Math.round(ratio2 * 1000) / 1000 },
    decoupled: driftPct > 5,
  };
}

// ── 課表遵從度 ──

/** 單一 prescribed segment 的遵從度結果（涵蓋 HR 或功率兩種目標）。 */
export interface ComplianceSegmentResult {
  name: string;
  startMs: number;
  endMs: number;
  durationMin: number;
  targetType: 'hr' | 'power';
  targetLow: number;
  targetHigh: number;
  avgActual: number | null;      // 該段實際平均（HR 或功率），無資料為 null
  timeOnTargetPct: number;       // 於目標區間內的時間占比（占有效量測時間，0-100）
}

export interface WorkoutComplianceResult {
  segments: ComplianceSegmentResult[];
  overallTimeOnTargetPct: number;
  grade: string;                 // workoutGrade(A-D)
}

/**
 * 逐 prescribed segment 計算 time-on-target%。segment 的絕對起訖時間由各段
 * durationMs 累加得出；目標優先取 hrMin/hrMax 心率區間（課表 segment），否則
 * 以 targetFtpPercent × ftp 的 ±10% 功率帶（workout profile segment）。
 * dt-weighted、跳 >10s 斷點；整體評級沿用 workoutGrade()。
 */
export function workoutCompliance(
  samples: RideSample[],
  segments: WorkoutSegment[],
  ftp: number,
): WorkoutComplianceResult {
  // 各段絕對邊界 + 目標定義。
  const bounds = segments.map((seg) => {
    const usesHr = seg.hrMin != null && seg.hrMax != null;
    let targetLow: number, targetHigh: number, targetType: 'hr' | 'power';
    if (usesHr) {
      targetType = 'hr';
      targetLow = seg.hrMin as number;
      targetHigh = seg.hrMax as number;
    } else {
      targetType = 'power';
      const target = (seg.targetFtpPercent / 100) * ftp;
      targetLow = Math.round(target * 0.9);
      targetHigh = Math.round(target * 1.1);
    }
    return { seg, targetType, targetLow, targetHigh, start: 0, end: 0, onTargetMs: 0, measuredMs: 0, sum: 0, n: 0 };
  });
  let acc = 0;
  for (const b of bounds) {
    b.start = acc;
    b.end = acc + b.seg.durationMs;
    acc += b.seg.durationMs;
  }

  let prevMs = 0;
  for (const s of samples) {
    const dt = s.elapsedMs - prevMs;
    prevMs = s.elapsedMs;
    if (dt <= 0 || dt > 10_000) continue;
    const b = bounds.find((x) => s.elapsedMs >= x.start && s.elapsedMs < x.end);
    if (!b) continue;
    const actual = b.targetType === 'hr' ? s.hr : s.powerW;
    if (actual == null) continue;
    b.measuredMs += dt;
    b.sum += actual;
    b.n++;
    if (actual >= b.targetLow && actual <= b.targetHigh) b.onTargetMs += dt;
  }

  let totOn = 0, totMeasured = 0;
  const segResults: ComplianceSegmentResult[] = bounds.map((b) => {
    totOn += b.onTargetMs;
    totMeasured += b.measuredMs;
    return {
      name: b.seg.name,
      startMs: b.start,
      endMs: b.end,
      durationMin: Math.round((b.seg.durationMs / 60_000) * 10) / 10,
      targetType: b.targetType,
      targetLow: b.targetLow,
      targetHigh: b.targetHigh,
      avgActual: b.n > 0 ? Math.round(b.sum / b.n) : null,
      timeOnTargetPct: b.measuredMs > 0 ? Math.round((b.onTargetMs / b.measuredMs) * 1000) / 10 : 0,
    };
  });

  const overall = totMeasured > 0 ? Math.round((totOn / totMeasured) * 1000) / 10 : 0;
  return {
    segments: segResults,
    overallTimeOnTargetPct: overall,
    grade: workoutGrade(overall),
  };
}
