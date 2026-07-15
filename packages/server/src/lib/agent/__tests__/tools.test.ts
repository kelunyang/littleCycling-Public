import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolRegistry, submitPlanTool } from '../tools.js';
import type { AgentTool, ToolContext } from '../types.js';
import type { RideDatabase } from '../../database.js';
import type { AppConfig, Ride, RideSample } from '@littlecycling/shared';

// ── 虛構資料（遵守個資規範，全部明顯虛構）──
// 注意：正式跑法應以 better-sqlite3 :memory: + 真 RideDatabase 塞資料驗證，
// 但 WSL 無法載入 Windows 編譯的 better-sqlite3 native module，故此處以型別
// 相容的假 DB 注入，專注驗證工具層的降採樣與 FTP×0.95 邏輯。

function makeSamples(): RideSample[] {
  // 40 分鐘、每分鐘一點；4 桶各 10 分鐘，功率 100/200/300/400。
  const out: RideSample[] = [];
  for (let min = 0; min <= 40; min++) {
    const bucket = Math.min(3, Math.floor(min / 10));
    out.push({ elapsedMs: min * 60_000, powerW: (bucket + 1) * 100, hr: 120 + bucket * 10, cadence: 90 });
  }
  return out;
}

const rideA: Ride = {
  id: 1, startedAt: dayMs('2026-07-01'), endedAt: dayMs('2026-07-01') + 2_400_000,
  durationMs: 2_400_000, distanceM: 15_000, avgPowerW: 210.4, avgHr: 135, avgCadence: 88,
  maxHr: 168, maxPowerW: 400, totalCoins: 0, totalLaps: 0, zoneSustainPct: 62.5,
  routeName: '測試路線甲', routeId: 'route-test',
};

function dayMs(d: string): number {
  return new Date(`${d}T00:00:00`).getTime();
}

// 虛構課表（get_plan_detail 用）：2 週，週 1 有 1 訓練日 + 1 休息日。
const fakePlan = {
  id: 'plan-test', name: '測試課表', description: '虛構課表說明', totalDays: 2, createdAt: 0, source: 'llm' as const,
  weeks: [
    {
      week: 1, focus: '基礎有氧', sessions: [
        { day: 1, type: 'training' as const, durationMin: 30, segments: [
          { type: 'warmup' as const, durationMin: 10, hrMin: 100, hrMax: 120 },
          { type: 'steady' as const, durationMin: 20, hrMin: 120, hrMax: 140, cadenceRpm: 85, notes: '穩定踩' },
        ] },
        { day: 2, type: 'rest' as const, durationMin: 0, segments: [] },
      ],
    },
  ],
};

const fakeDb = {
  listRides: (opts: { routeId?: string } = {}): Ride[] =>
    opts.routeId ? [rideA].filter((r) => r.routeId === opts.routeId) : [rideA, { ...rideA, id: 2 }],
  getRide: (id: number): Ride | undefined => (id === 1 ? rideA : undefined),
  getSamplesForExport: (rideId: number): RideSample[] => (rideId === 1 ? makeSamples() : []),
  getBest20MinAvgPower: (rideId: number): number | null =>
    rideId === 1 ? 200 : rideId === 2 ? 250 : null,
  getRidesByDate: (): Ride[] => [rideA],
  getRideCountsByDateRange: () => [{ date: '2026-07-01', count: 1 }],
  getBestRideForRoute: () => ({ ride: rideA, zoneSustainPct: 62.5 }),
  getActivePlans: () => [],
  getCompletions: () => [],
  getPlan: (id: string) => (id === 'plan-test' ? fakePlan : null),
  createPlan: (p: any) => ({ ...p, id: 'plan-x', createdAt: 0 }),
} as unknown as RideDatabase;

const config = { training: { hrMax: 190, ftp: 200 } } as unknown as AppConfig;
const ctx: ToolContext = { db: fakeDb, config };

function tool(name: string): AgentTool {
  const t = buildToolRegistry(ctx).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

test('get_ride_summary_stats：降採樣桶平均正確，不含逐點', async () => {
  const res: any = await tool('get_ride_summary_stats').execute({ rideId: 1, buckets: 4 }, ctx);
  assert.equal(res.buckets.length, 4);
  assert.equal(res.buckets[0].avgPower, 100);
  assert.equal(res.buckets[1].avgPower, 200);
  assert.equal(res.buckets[2].avgPower, 300);
  assert.equal(res.buckets[3].avgPower, 400);
  assert.equal(res.power.max, 400);
  assert.equal(res.durationMin, 40);
  assert.equal(res.samples, 41);
  // 不得洩漏原始逐點
  assert.equal('samplesRaw' in res, false);
  assert.ok(!Array.isArray(res.power));
});

test('estimate_ftp：指定 rideId → best×0.95', async () => {
  const res: any = await tool('estimate_ftp').execute({ rideId: 1 }, ctx);
  assert.equal(res.best20MinAvgPower, 200);
  assert.equal(res.estimatedFtp, 190); // round(200*0.95)
  assert.equal(res.confidence, 'ok');
});

test('estimate_ftp：不指定則掃最近取最佳', async () => {
  const res: any = await tool('estimate_ftp').execute({}, ctx);
  assert.equal(res.best20MinAvgPower, 250);
  assert.equal(res.estimatedFtp, 238); // round(250*0.95)
  assert.equal(res.rideId, 2);
});

test('estimate_ftp：無足夠資料 → insufficient', async () => {
  const res: any = await tool('estimate_ftp').execute({ rideId: 99 }, ctx);
  assert.equal(res.confidence, 'insufficient');
  assert.equal(res.estimatedFtp, null);
});

test('list_recent_rides：精簡列含 date 且不含逐點', async () => {
  const res: any = await tool('list_recent_rides').execute({ limit: 5 }, ctx);
  assert.equal(res.length, 2);
  assert.equal(res[0].date, '2026-07-01');
  assert.equal(res[0].durationMin, 40);
  assert.equal(res[0].distanceKm, 15);
  assert.equal(res[0].routeName, '測試路線甲');
  assert.equal('segments' in res[0], false);
});

test('get_training_config：回傳心率區間邊界', async () => {
  const res: any = await tool('get_training_config').execute({}, ctx);
  assert.equal(res.hrMax, 190);
  assert.equal(res.ftp, 200);
  assert.ok(res.hrZones.z1 < res.hrZones.z2);
  assert.ok(res.hrZones.z5 > res.hrZones.z4);
});

test('rideFilter：excludeEmpty 由 ctx 透傳到 db 查詢（tool 層強制）', async () => {
  // 記錄各 db 方法收到的過濾參數，驗證 tool 層確實把 ctx.rideFilter 傳下去。
  const seen: { listRides?: boolean; byDate?: boolean; counts?: boolean } = {};
  const spyDb = {
    listRides: (opts: { excludeEmpty?: boolean } = {}): Ride[] => {
      seen.listRides = opts.excludeEmpty;
      return [rideA];
    },
    getRidesByDate: (_date: string, excludeEmpty?: boolean): Ride[] => {
      seen.byDate = excludeEmpty;
      return [rideA];
    },
    getRideCountsByDateRange: (_f: number, _t: number, excludeEmpty?: boolean) => {
      seen.counts = excludeEmpty;
      return [{ date: '2026-07-01', count: 1 }];
    },
    getBest20MinAvgPower: () => 200,
  } as unknown as RideDatabase;
  const filterCtx: ToolContext = { db: spyDb, config, rideFilter: { excludeEmpty: true } };
  const t = (name: string): AgentTool => {
    const found = buildToolRegistry(filterCtx).find((x) => x.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };

  await t('list_recent_rides').execute({ limit: 5 }, filterCtx);
  await t('get_rides_by_date').execute({ date: '2026-07-01' }, filterCtx);
  await t('get_ride_counts').execute({ fromDate: '2026-07-01', toDate: '2026-07-02' }, filterCtx);
  await t('estimate_ftp').execute({}, filterCtx); // 掃描模式走 listRides

  assert.equal(seen.listRides, true);
  assert.equal(seen.byDate, true);
  assert.equal(seen.counts, true);
});

test('toLeanRide：補上 rpe（rideA 無 workoutId/planId → null）', async () => {
  const res: any = await tool('list_recent_rides').execute({ limit: 5 }, ctx);
  assert.equal('workoutId' in res[0], true);
  assert.equal(res[0].workoutId, null);
  assert.equal(res[0].planId, null);
  assert.equal(res[0].rpe, null);
});

test('get_plan_detail：無 week/day → 每週 focus + 天數摘要', async () => {
  const res: any = await tool('get_plan_detail').execute({ planId: 'plan-test' }, ctx);
  assert.equal(res.name, '測試課表');
  assert.equal(res.weeks.length, 1);
  assert.equal(res.weeks[0].focus, '基礎有氧');
  assert.equal(res.weeks[0].trainingDays, 1);
  assert.equal(res.weeks[0].restDays, 1);
  assert.equal(res.weeks[0].totalMin, 30);
  // 摘要模式不吐完整 segments
  assert.equal('segments' in res.weeks[0], false);
});

test('get_plan_detail：帶 week → 該週 session 概要（含段數，不含完整 segments）', async () => {
  const res: any = await tool('get_plan_detail').execute({ planId: 'plan-test', week: 1 }, ctx);
  assert.equal(res.week, 1);
  assert.equal(res.sessions.length, 2);
  assert.equal(res.sessions[0].segmentCount, 2);
  assert.equal('segments' in res.sessions[0], false);
});

test('get_plan_detail：帶 day → 單日完整 segments', async () => {
  const res: any = await tool('get_plan_detail').execute({ planId: 'plan-test', day: 1 }, ctx);
  assert.equal(res.day, 1);
  assert.equal(res.type, 'training');
  assert.equal(res.segments.length, 2);
  assert.equal(res.segments[1].cadenceRpm, 85);
  assert.equal(res.segments[1].notes, '穩定踩');
});

test('get_plan_detail：找不到課表 → error', async () => {
  const res: any = await tool('get_plan_detail').execute({ planId: 'nope' }, ctx);
  assert.ok(res.error);
});

test('get_workout_compliance：自由騎（無 workoutId）→ 說明性錯誤', async () => {
  const res: any = await tool('get_workout_compliance').execute({ rideId: 1 }, ctx);
  assert.ok(res.error);
  assert.match(res.error, /workoutId/);
});

test('get_workout_profile_defs：回傳模板結構（含 %FTP）', async () => {
  const res: any = await tool('get_workout_profile_defs').execute({}, ctx);
  assert.ok(Array.isArray(res) && res.length > 0);
  assert.ok(res[0].id && res[0].name);
  assert.ok(Array.isArray(res[0].segments));
  assert.ok(typeof res[0].segments[0].targetFtpPercent === 'number');
});

test('get_ftp_trend：逐筆 best20 + 估算 FTP，時間由舊到新', async () => {
  const res: any = await tool('get_ftp_trend').execute({ limit: 5 }, ctx);
  assert.equal(res.withPower, 2);
  assert.equal(res.trend.length, 2);
  // ride 1 → best 200 → ftp 190；ride 2 → best 250 → ftp 238
  assert.equal(res.trend[res.trend.length - 1].estimatedFtp, 190);
});

test('get_training_config：有體重時附 wPerKg', async () => {
  const cfgW = { training: { hrMax: 190, ftp: 200, weightKg: 80, age: 30 } } as unknown as AppConfig;
  const ctxW: ToolContext = { db: fakeDb, config: cfgW };
  const t = buildToolRegistry(ctxW).find((x) => x.name === 'get_training_config')!;
  const res: any = await t.execute({}, ctxW);
  assert.equal(res.weightKg, 80);
  assert.equal(res.wPerKg, 2.5); // 200/80
  assert.equal(res.age, 30);
});

test('submit_plan：合法課表 → ok，含 plan；不合法 → errors', async () => {
  const good = {
    name: '測試課表', description: '虛構', weeks: [
      { week: 1, focus: '基礎', sessions: [
        { day: 1, type: 'training', durationMin: 30, segments: [
          { type: 'warmup', durationMin: 10, hrMin: 100, hrMax: 120 },
          { type: 'steady', durationMin: 20, hrMin: 120, hrMax: 140 },
        ] },
        { day: 2, type: 'rest', durationMin: 0, segments: [] },
      ] },
    ],
  };
  const okRes: any = await submitPlanTool(ctx).execute(good, ctx);
  assert.equal(okRes.ok, true);
  assert.ok(okRes.plan);
  assert.equal(okRes.plan.source, 'llm');

  const badRes: any = await submitPlanTool(ctx).execute({ name: '', weeks: [] }, ctx);
  assert.equal(badRes.ok, false);
  assert.ok(Array.isArray(badRes.errors) && badRes.errors.length > 0);
});
