import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resampleTo1Hz,
  zoneDistribution,
  powerMetrics,
  bestEfforts,
  hrDrift,
  workoutCompliance,
  type RideSample,
  type WorkoutSegment,
} from '@littlecycling/shared';

// ── 合成樣本（全部明顯虛構，驗證數學）──

/** 每秒一點、power 恆定的樣本，共 durSec+1 點（含 t=0）。 */
function constantPower(durSec: number, watts: number, hr = 140): RideSample[] {
  const out: RideSample[] = [];
  for (let t = 0; t <= durSec; t++) {
    out.push({ elapsedMs: t * 1000, powerW: watts, hr, cadence: 90 });
  }
  return out;
}

test('resampleTo1Hz：carry-forward 網格長度與值正確', () => {
  const samples: RideSample[] = [
    { elapsedMs: 0, powerW: 100 },
    { elapsedMs: 5000, powerW: 200 },
  ];
  const g = resampleTo1Hz(samples);
  assert.equal(g.totalSec, 5);
  assert.equal(g.power.length, 6); // 0..5
  assert.equal(g.power[0], 100);
  assert.equal(g.power[4], 100); // 尚未到 5s 事件
  assert.equal(g.power[5], 200);
});

test('powerMetrics：恆定功率 → NP==avg，IF/TSS/VI 精確', () => {
  const samples = constantPower(3600, 200); // 1 小時 @ 200W
  const m = powerMetrics(samples, 200)!;
  assert.equal(m.avgPower, 200);
  assert.equal(m.normalizedPower, 200);
  assert.equal(m.intensityFactor, 1);
  assert.equal(m.tss, 100); // 一小時 @ IF 1.0 = 100 TSS
  assert.equal(m.variabilityIndex, 1);
  assert.equal(m.durationSec, 3600);
});

test('powerMetrics：Coggan 區歸類（200W vs FTP 200 → Threshold Z4）', () => {
  const m = powerMetrics(constantPower(600, 200), 200)!;
  const z4 = m.cogganZones.find((z) => z.zone === 4)!;
  assert.ok(z4.pct > 99); // 幾乎全在 Z4
});

test('powerMetrics：無功率資料 → null', () => {
  const samples: RideSample[] = [
    { elapsedMs: 0, hr: 130 },
    { elapsedMs: 1000, hr: 131 },
  ];
  assert.equal(powerMetrics(samples, 200), null);
});

test('zoneDistribution：兩區心率串流 → 各區分鐘數正確', () => {
  const hrMax = 190;
  const samples: RideSample[] = [];
  // t=1..600 hr=120（Z2, 63%），t=601..1200 hr=150（Z3, 79%）；每點 dt=1000ms。
  for (let t = 1; t <= 600; t++) samples.push({ elapsedMs: t * 1000, hr: 120 });
  for (let t = 601; t <= 1200; t++) samples.push({ elapsedMs: t * 1000, hr: 150 });
  const d = zoneDistribution(samples, hrMax);
  const z2 = d.zones.find((z) => z.zone === 2)!;
  const z3 = d.zones.find((z) => z.zone === 3)!;
  assert.equal(z2.minutes, 10);
  assert.equal(z3.minutes, 10);
  assert.equal(z2.pct, 50);
  assert.equal(z3.pct, 50);
});

test('zoneDistribution：跳過 >10s 斷點', () => {
  const samples: RideSample[] = [
    { elapsedMs: 1000, hr: 120 },
    { elapsedMs: 20000, hr: 120 }, // dt=19s > 10s → 不計
    { elapsedMs: 21000, hr: 120 }, // dt=1s → 計 1s
  ];
  const d = zoneDistribution(samples, 190);
  // 只有最後一段 1s 被計入 → 約 0.0 分鐘（1s）
  assert.ok(d.totalMinutes < 0.1);
});

test('bestEfforts：階梯訊號 → 5s/60s 命中高原', () => {
  // 0..599 @100W，600..659 @300W（60 秒），660.. @100W。
  const samples: RideSample[] = [
    { elapsedMs: 0, powerW: 100 },
    { elapsedMs: 600_000, powerW: 300 },
    { elapsedMs: 660_000, powerW: 100 },
    { elapsedMs: 1_300_000, powerW: 100 },
  ];
  const e = bestEfforts(samples, [5, 60, 300, 1200]);
  const w = (win: number) => e.find((x) => x.windowSec === win)!.watts;
  assert.equal(w(5), 300);
  assert.equal(w(60), 300);
  // 5min 視窗含 60s@300 + 240s@100 = 140W
  assert.equal(w(300), 140);
  assert.ok((w(1200) as number) > 100); // 20min 視窗有值
});

test('hrDrift：同功率下後半心率漂高 → 正 drift、decoupled', () => {
  const samples: RideSample[] = [];
  for (let t = 0; t <= 1000; t++) {
    const hr = t < 550 ? 140 : 160;
    samples.push({ elapsedMs: t * 1000, powerW: 200, hr });
  }
  const d = hrDrift(samples)!;
  assert.ok(Math.abs(d.driftPct - 12.5) < 0.2);
  assert.equal(d.decoupled, true);
});

test('hrDrift：資料不足 → null', () => {
  assert.equal(hrDrift([{ elapsedMs: 0, powerW: 200 }]), null);
});

test('workoutCompliance：HR 區間全達標 → 100%、A 級', () => {
  const segments: WorkoutSegment[] = [
    { name: 'Steady', durationMs: 600_000, targetFtpPercent: 0, color: '#000', hrMin: 140, hrMax: 160 },
  ];
  const samples: RideSample[] = [];
  for (let t = 1; t <= 600; t++) samples.push({ elapsedMs: t * 1000, hr: 150, powerW: 180 });
  const r = workoutCompliance(samples, segments, 200);
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].targetType, 'hr');
  assert.equal(r.overallTimeOnTargetPct, 100);
  assert.equal(r.grade, 'A');
});

test('workoutCompliance：功率帶（±10%）以 FTP% 推目標', () => {
  // 目標 100% FTP=200 → 帶寬 180-220；實際 200 全達標。
  const segments: WorkoutSegment[] = [
    { name: 'FTP', durationMs: 300_000, targetFtpPercent: 100, color: '#000' },
  ];
  const samples: RideSample[] = [];
  for (let t = 1; t <= 300; t++) samples.push({ elapsedMs: t * 1000, powerW: 200, hr: 150 });
  const r = workoutCompliance(samples, segments, 200);
  assert.equal(r.segments[0].targetType, 'power');
  assert.equal(r.segments[0].targetLow, 180);
  assert.equal(r.segments[0].targetHigh, 220);
  assert.equal(r.overallTimeOnTargetPct, 100);
});
