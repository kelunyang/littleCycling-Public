import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import planApi from '../../../routes/plan-api.js';
import type { RideDatabase } from '../../database.js';
import type { ConfigStore } from '../../config-store.js';
import type { RouteStore } from '../../route-store.js';
import type { RideSample, PlanDayCompletion } from '@littlecycling/shared';

// ── 虛構資料(全部明顯虛構)──
// WSL 無法載入 Windows 編譯的 better-sqlite3,故以型別相容的假 DB / configStore
// 注入,專注驗證 route 層的 404 / 手動標記 / 遵從度管線形狀。
//
// 注意:workoutCompliance 會略過 dt>10s 的斷點,所以樣本間隔必須 ≤10s,
// 這裡用 1s 間隔;day1 兩段各 1 分鐘,HR 全程壓在目標帶內 → 達標 100% → 評級 A。

const fakePlan = {
  id: 'plan-1', name: '測試課表', description: '虛構', totalDays: 2, createdAt: 0, source: 'llm' as const,
  weeks: [
    {
      week: 1, focus: '基礎', sessions: [
        { day: 1, type: 'training' as const, durationMin: 2, segments: [
          { type: 'warmup' as const, durationMin: 1, hrMin: 100, hrMax: 120 },
          { type: 'steady' as const, durationMin: 1, hrMin: 130, hrMax: 150, cadenceRpm: 85 },
        ] },
        { day: 2, type: 'rest' as const, durationMin: 0, segments: [] },
      ],
    },
  ],
};

// 0..120s、每秒一點:< 60s 壓在 warmup 帶(110),≥ 60s 壓在 steady 帶(140)。
function makeSamples(): RideSample[] {
  const out: RideSample[] = [];
  for (let sec = 0; sec <= 120; sec++) {
    const t = sec * 1000;
    out.push({ elapsedMs: t, hr: t < 60_000 ? 110 : 140, cadence: 85 });
  }
  return out;
}

const completions: PlanDayCompletion[] = [
  { planId: 'plan-1', day: 1, rideId: 7, completedAt: 0, manual: false },
  { planId: 'plan-1', day: 2, rideId: null, completedAt: 0, manual: true },
];

const fakeDb = {
  getPlan: (id: string) => (id === 'plan-1' ? fakePlan : null),
  getCompletions: (planId: string) => (planId === 'plan-1' ? completions : []),
  getSamplesForExport: (rideId: number) => (rideId === 7 ? makeSamples() : []),
} as unknown as RideDatabase;

const fakeConfigStore = {
  get: () => ({ training: { ftp: 200 } }),
} as unknown as ConfigStore;

const fakeRouteStore = {} as unknown as RouteStore;

async function buildApp() {
  const app = Fastify();
  await app.register(planApi, { db: fakeDb, configStore: fakeConfigStore, routeStore: fakeRouteStore });
  await app.ready();
  return app;
}

test('GET /actual — 404 when plan missing', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/api/plans/nope/days/1/actual' });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET /actual — manual completion (no rideId) → hasActual false', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/api/plans/plan-1/days/2/actual' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { hasActual: false });
  await app.close();
});

test('GET /actual — 400 when day is not a positive integer', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/api/plans/plan-1/days/0/actual' });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('GET /actual — happy path shape (grade A, HR track)', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/api/plans/plan-1/days/1/actual' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.hasActual, true);
  assert.equal(body.rideId, 7);
  assert.equal(body.grade, 'A');
  assert.equal(body.overallTimeOnTargetPct, 100);
  assert.equal(body.segments.length, 2);
  assert.ok(Array.isArray(body.hrTrack));
  assert.ok(body.hrTrack.length > 0 && body.hrTrack.length <= 240);
  assert.ok('tMs' in body.hrTrack[0] && 'hr' in body.hrTrack[0]);
  await app.close();
});

test('GET /compliance-summary — 404 when plan missing', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/api/plans/nope/compliance-summary' });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('GET /compliance-summary — map keyed by day, manual day omitted', async () => {
  const app = await buildApp();
  const res = await app.inject({ method: 'GET', url: '/api/plans/plan-1/compliance-summary' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body, { days: { 1: { grade: 'A', pct: 100 } } });
  await app.close();
});
