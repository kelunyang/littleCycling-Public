/**
 * Agent tool registry — 對映 RideDatabase 的查詢工具集。
 *
 * 所有回傳都經摘要 / 降採樣控制 token（尤其 get_ride_summary_stats 絕不
 * 回傳原始逐點樣本）。時間欄位一律 ms timestamp，用 dayjs 轉換並同時附上
 * `YYYY-MM-DD` 字串方便 LLM 判讀。description 用繁中，給 LLM 讀。
 */

import dayjs from 'dayjs';
import {
  validatePlanInput,
  createPlanFromInput,
  getCurrentPlanDay,
  getSessionByDay,
  planSegmentsToWorkoutSegments,
  buildWorkoutSegments,
  WORKOUT_PROFILES,
  WORKOUT_PROFILES_MAP,
  zoneDistribution,
  powerMetrics,
  bestEfforts,
  hrDrift,
  workoutCompliance,
  type Ride,
  type RideSample,
  type TrainingPlan,
  type TrainingPlanInput,
  type WorkoutSegment,
} from '@littlecycling/shared';
import { hrZoneBoundaries } from '../plan-prompt.js';
import type { AgentTool, JsonSchema, ToolContext } from './types.js';

// ── 共用：精簡騎乘列（不含逐點樣本）──

interface LeanRide {
  id: number;
  startedAt: number;
  date: string;
  durationMin: number;
  distanceKm: number;
  avgPowerW: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  zoneSustainPct: number | null;
  routeName: string | null;
  // 訓練模式 / 課表連結 / 主觀強度——教練據此判讀「這是什麼訓練、感覺如何」。
  workoutId: string | null;
  planId: string | null;
  planDay: number | null;
  rpe: number | null;
}

function toLeanRide(r: Ride): LeanRide {
  return {
    id: r.id,
    startedAt: r.startedAt,
    date: dayjs(r.startedAt).format('YYYY-MM-DD'),
    durationMin: r.durationMs ? Math.round(r.durationMs / 60_000) : 0,
    distanceKm: Math.round((r.distanceM ?? 0) / 100) / 10,
    avgPowerW: round1(r.avgPowerW),
    avgHr: round1(r.avgHr),
    maxHr: r.maxHr ?? null,
    avgCadence: round1(r.avgCadence),
    zoneSustainPct: r.zoneSustainPct ?? null,
    routeName: r.routeName ?? null,
    workoutId: r.workoutId ?? null,
    planId: r.planId ?? null,
    planDay: r.planDay ?? null,
    rpe: r.rpe ?? null,
  };
}

function round1(v: number | undefined | null): number | null {
  return v == null ? null : Math.round(v * 10) / 10;
}

function avgOf(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

// ── 建立工具集 ──

export function buildToolRegistry(ctx: ToolContext): AgentTool[] {
  return [
    listRecentRidesTool(ctx),
    getRideDetailTool(ctx),
    getRideSummaryStatsTool(ctx),
    estimateFtpTool(ctx),
    getRideCountsTool(ctx),
    getRidesByDateTool(ctx),
    getRouteBestTool(ctx),
    getActivePlansTool(ctx),
    getPlanCompletionsTool(ctx),
    getTrainingConfigTool(ctx),
    // ── P0 ──
    getPlanDetailTool(ctx),
    getRideZoneDistributionTool(ctx),
    getWorkoutProfileDefsTool(ctx),
    getFtpTrendTool(ctx),
    // ── P1 ──
    getRidePowerMetricsTool(ctx),
    getWorkoutComplianceTool(ctx),
    getWeeklyLoadSummaryTool(ctx),
    getBestEffortsTool(ctx),
    // ── P2 ──
    getHrDriftTool(ctx),
    getRouteInfoTool(ctx),
    compareRidesTool(ctx),
  ];
}

// ── 個別工具 ──

function listRecentRidesTool(ctx: ToolContext): AgentTool {
  return {
    name: 'list_recent_rides',
    description: '列出最近的騎乘紀錄（精簡摘要，不含逐點樣本）。可用 routeId 過濾特定路線。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '筆數（預設 10，最多 50）', minimum: 1, maximum: 50 },
        routeId: { type: 'string', description: '選填，只列出此路線的紀錄' },
      },
      required: [],
    },
    execute(args: { limit?: number; routeId?: string }) {
      const limit = Math.min(args.limit ?? 10, 50);
      // tool 層強制套用使用者的過濾條件（excludeEmpty），不只靠 prompt 提醒。
      return ctx.db
        .listRides({ limit, routeId: args.routeId, excludeEmpty: ctx.rideFilter?.excludeEmpty })
        .map(toLeanRide);
    },
  };
}

function getRideDetailTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_ride_detail',
    description: '取得單筆騎乘的完整欄位（不含逐點樣本；逐點統計請用 get_ride_summary_stats）。',
    parameters: {
      type: 'object',
      properties: { rideId: { type: 'integer', description: '騎乘 ID' } },
      required: ['rideId'],
    },
    execute(args: { rideId: number }) {
      const ride = ctx.db.getRide(args.rideId);
      if (!ride) return { error: `找不到騎乘 ${args.rideId}` };
      return { ...ride, date: dayjs(ride.startedAt).format('YYYY-MM-DD') };
    },
  };
}

function getRideSummaryStatsTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_ride_summary_stats',
    description:
      '取得單筆騎乘的時序摘要：把整段時間切成 N 個桶，每桶回傳功率/心率/踏頻的平均，' +
      '另附全程平均與最大值。絕不回傳原始逐點資料，適合分析訓練節奏。',
    parameters: {
      type: 'object',
      properties: {
        rideId: { type: 'integer', description: '騎乘 ID' },
        buckets: { type: 'integer', description: '時序桶數（預設 12）', minimum: 1, maximum: 60 },
      },
      required: ['rideId'],
    },
    execute(args: { rideId: number; buckets?: number }) {
      const samples = ctx.db.getSamplesForExport(args.rideId);
      if (samples.length === 0) return { error: `騎乘 ${args.rideId} 沒有樣本資料` };
      return summariseSamples(samples, args.buckets ?? 12);
    },
  };
}

function estimateFtpTool(ctx: ToolContext): AgentTool {
  return {
    name: 'estimate_ftp',
    description:
      '估算 FTP（功能性閾值功率）= 最佳連續 20 分鐘平均功率 × 0.95。' +
      '指定 rideId 則針對該筆；不指定則掃描最近 20 筆取最佳。',
    parameters: {
      type: 'object',
      properties: { rideId: { type: 'integer', description: '選填，指定騎乘 ID' } },
      required: [],
    },
    execute(args: { rideId?: number }) {
      let rideId = args.rideId;
      let best: number | null = null;
      if (rideId != null) {
        best = ctx.db.getBest20MinAvgPower(rideId);
      } else {
        // 掃描模式：同樣尊重使用者的 excludeEmpty 過濾。
        for (const r of ctx.db.listRides({ limit: 20, excludeEmpty: ctx.rideFilter?.excludeEmpty })) {
          const b = ctx.db.getBest20MinAvgPower(r.id);
          if (b != null && (best == null || b > best)) {
            best = b;
            rideId = r.id;
          }
        }
      }
      if (best == null) {
        return { rideId: rideId ?? null, best20MinAvgPower: null, estimatedFtp: null, confidence: 'insufficient' as const };
      }
      return {
        rideId: rideId ?? null,
        best20MinAvgPower: best,
        estimatedFtp: Math.round(best * 0.95),
        confidence: 'ok' as const,
      };
    },
  };
}

function getRideCountsTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_ride_counts',
    description: '統計某日期區間內每天的騎乘次數（含起訖日）。日期格式 YYYY-MM-DD。',
    parameters: {
      type: 'object',
      properties: {
        fromDate: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        toDate: { type: 'string', description: '結束日期 YYYY-MM-DD（含當日）' },
      },
      required: ['fromDate', 'toDate'],
    },
    execute(args: { fromDate: string; toDate: string }) {
      const fromTs = dayjs(args.fromDate).startOf('day').valueOf();
      const toTs = dayjs(args.toDate).add(1, 'day').startOf('day').valueOf();
      return ctx.db.getRideCountsByDateRange(fromTs, toTs, ctx.rideFilter?.excludeEmpty);
    },
  };
}

function getRidesByDateTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_rides_by_date',
    description: '列出某一天的所有騎乘紀錄（精簡摘要）。日期格式 YYYY-MM-DD。',
    parameters: {
      type: 'object',
      properties: { date: { type: 'string', description: '日期 YYYY-MM-DD' } },
      required: ['date'],
    },
    execute(args: { date: string }) {
      return ctx.db.getRidesByDate(args.date, ctx.rideFilter?.excludeEmpty).map(toLeanRide);
    },
  };
}

function getRouteBestTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_route_best',
    description: '取得某條路線的最佳騎乘（依平均功率），並附 Z2+Z3 心率維持百分比。',
    parameters: {
      type: 'object',
      properties: { routeId: { type: 'string', description: '路線 ID' } },
      required: ['routeId'],
    },
    execute(args: { routeId: string }) {
      const best = ctx.db.getBestRideForRoute(args.routeId, ctx.config.training.hrMax);
      if (!best) return { ride: null, zoneSustainPct: null };
      return { ride: toLeanRide(best.ride), zoneSustainPct: best.zoneSustainPct };
    },
  };
}

function getActivePlansTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_active_plans',
    description: '列出目前啟用中的訓練課表，含起始日、總天數與今天是課表第幾天。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute() {
      const out: { planId: string; name: string; startDate: string; totalDays: number; currentDay: number }[] = [];
      for (const active of ctx.db.getActivePlans()) {
        const plan = ctx.db.getPlan(active.planId);
        if (!plan) continue;
        out.push({
          planId: plan.id,
          name: plan.name,
          startDate: active.startDate,
          totalDays: plan.totalDays,
          currentDay: getCurrentPlanDay(active.startDate),
        });
      }
      return out;
    },
  };
}

function getPlanCompletionsTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_plan_completions',
    description: '列出某課表已完成的天數紀錄（含是否手動標記、完成時間）。',
    parameters: {
      type: 'object',
      properties: { planId: { type: 'string', description: '課表 ID' } },
      required: ['planId'],
    },
    execute(args: { planId: string }) {
      return ctx.db.getCompletions(args.planId).map((c) => ({
        day: c.day,
        rideId: c.rideId,
        manual: c.manual,
        completedAt: c.completedAt,
        date: dayjs(c.completedAt).format('YYYY-MM-DD'),
      }));
    },
  };
}

function getTrainingConfigTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_training_config',
    description:
      '取得騎手的訓練設定：最大心率、FTP、五個心率區間（Zone）的邊界值（bpm），' +
      '若有設定則附上體重（kg）、W/kg（FTP÷體重）與年齡。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute() {
      const t = ctx.config.training;
      const hrMax = t.hrMax;
      const out: {
        hrMax: number; ftp: number; hrZones: ReturnType<typeof hrZoneBoundaries>;
        weightKg?: number; wPerKg?: number; age?: number;
      } = {
        hrMax,
        ftp: t.ftp,
        hrZones: hrZoneBoundaries(hrMax),
      };
      if (t.weightKg != null && t.weightKg > 0) {
        out.weightKg = t.weightKg;
        if (t.ftp > 0) out.wPerKg = Math.round((t.ftp / t.weightKg) * 10) / 10;
      }
      if (t.age != null && t.age > 0) out.age = t.age;
      return out;
    },
  };
}

// ── P0：課表內容 / 區間分布 / 模板定義 / FTP 趨勢 ──

function getPlanDetailTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_plan_detail',
    description:
      '查詢訓練課表的內容（摘要化控 token）。只給 planId：回每週 focus 與訓練/休息天數摘要；' +
      '加 week：回該週各日 session 概要（type/時長/段數）；加 day：回單日完整 segments（強度、' +
      '目標心率、時長、教練提示）。想知道「今天該練什麼」用 day 模式。',
    parameters: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: '課表 ID' },
        week: { type: 'integer', description: '選填，指定週次（1-based）', minimum: 1 },
        day: { type: 'integer', description: '選填，指定天數（1-based 連續編號）', minimum: 1 },
      },
      required: ['planId'],
    },
    execute(args: { planId: string; week?: number; day?: number }) {
      const plan = ctx.db.getPlan(args.planId);
      if (!plan) return { error: `找不到課表 ${args.planId}` };

      // day 模式：單日完整 segments。
      if (args.day != null) {
        const session = getSessionByDay(plan, args.day);
        if (!session) return { error: `課表 ${plan.id} 沒有第 ${args.day} 天` };
        return {
          planId: plan.id,
          day: session.day,
          type: session.type,
          durationMin: session.durationMin,
          segments: session.segments.map((s) => ({
            type: s.type,
            durationMin: s.durationMin,
            hrMin: s.hrMin,
            hrMax: s.hrMax,
            cadenceRpm: s.cadenceRpm ?? null,
            notes: s.notes ?? null,
          })),
        };
      }

      // week 模式：該週 session 概要。
      if (args.week != null) {
        const wk = plan.weeks.find((w) => w.week === args.week);
        if (!wk) return { error: `課表 ${plan.id} 沒有第 ${args.week} 週` };
        return {
          planId: plan.id,
          week: wk.week,
          focus: wk.focus,
          sessions: wk.sessions.map((s) => ({
            day: s.day,
            type: s.type,
            durationMin: s.durationMin,
            segmentCount: s.segments.length,
          })),
        };
      }

      // 摘要模式：每週 focus + 天數統計。
      return {
        planId: plan.id,
        name: plan.name,
        totalDays: plan.totalDays,
        description: plan.description,
        weeks: plan.weeks.map((w) => {
          const training = w.sessions.filter((s) => s.type === 'training').length;
          const rest = w.sessions.filter((s) => s.type === 'rest').length;
          const totalMin = w.sessions.reduce((sum, s) => sum + s.durationMin, 0);
          return { week: w.week, focus: w.focus, trainingDays: training, restDays: rest, totalMin };
        }),
      };
    },
  };
}

function getRideZoneDistributionTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_ride_zone_distribution',
    description:
      '取得單筆騎乘的全五區心率 time-in-zone（每區分鐘數 + 占比%）。以 dt 加權、跳過 >10s ' +
      '斷點，與前端 ride 圖表一致；用於判讀強度分布（polarized / pyramidal）。',
    parameters: {
      type: 'object',
      properties: { rideId: { type: 'integer', description: '騎乘 ID' } },
      required: ['rideId'],
    },
    execute(args: { rideId: number }) {
      const samples = ctx.db.getSamplesForExport(args.rideId);
      if (samples.length === 0) return { error: `騎乘 ${args.rideId} 沒有樣本資料` };
      const dist = zoneDistribution(samples, ctx.config.training.hrMax);
      if (dist.totalMinutes === 0) return { error: `騎乘 ${args.rideId} 沒有有效心率資料` };
      return dist;
    },
  };
}

function getWorkoutProfileDefsTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_workout_profile_defs',
    description:
      '列出內建的結構化訓練模板（workout profile）定義：id、名稱、說明，以及各 segment 的 ' +
      '%FTP 目標與時長占比。用於解讀某筆 ride 的 workoutId（如 "ftp-test"）到底是什麼訓練。',
    parameters: { type: 'object', properties: {}, required: [] },
    execute() {
      return WORKOUT_PROFILES.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        segments: p.templates.map((t) => ({
          name: t.name,
          durationPct: Math.round(t.durationPct * 1000) / 10,
          targetFtpPercent: t.targetFtpPercent,
          targetCadence: t.targetCadence ?? null,
        })),
      }));
    },
  };
}

function getFtpTrendTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_ftp_trend',
    description:
      '近 N 筆騎乘（≤30）逐筆的最佳 20 分鐘平均功率與估算 FTP（best20 × 0.95）時序，用於判斷 ' +
      '體能進步 / 持平 / 退步。只納入有足夠功率資料的騎乘；尊重使用者的過濾設定。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '掃描筆數（預設 10，最多 30）', minimum: 1, maximum: 30 },
      },
      required: [],
    },
    execute(args: { limit?: number }) {
      const limit = Math.min(args.limit ?? 10, 30);
      const rides = ctx.db.listRides({ limit, excludeEmpty: ctx.rideFilter?.excludeEmpty });
      const trend: { rideId: number; date: string; best20MinW: number; estimatedFtp: number }[] = [];
      for (const r of rides) {
        const best = ctx.db.getBest20MinAvgPower(r.id);
        if (best == null) continue;
        trend.push({
          rideId: r.id,
          date: dayjs(r.startedAt).format('YYYY-MM-DD'),
          best20MinW: best,
          estimatedFtp: Math.round(best * 0.95),
        });
      }
      // 時間由舊到新，方便看趨勢。
      trend.reverse();
      return { scanned: rides.length, withPower: trend.length, trend };
    },
  };
}

// ── P1：功率指標 / 課表遵從度 / 週負荷 / best efforts ──

function getRidePowerMetricsTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_ride_power_metrics',
    description:
      '取得單筆騎乘的進階功率指標：NP（標準化功率）、IF（強度因子）、TSS（訓練壓力分數）、' +
      'VI（變異指數），以及 Coggan 七區功率時間分布。以設定的 FTP 計算；有設定體重時附 W/kg。',
    parameters: {
      type: 'object',
      properties: { rideId: { type: 'integer', description: '騎乘 ID' } },
      required: ['rideId'],
    },
    execute(args: { rideId: number }) {
      const samples = ctx.db.getSamplesForExport(args.rideId);
      if (samples.length === 0) return { error: `騎乘 ${args.rideId} 沒有樣本資料` };
      const ftp = ctx.config.training.ftp;
      const m = powerMetrics(samples, ftp);
      if (!m) return { error: `騎乘 ${args.rideId} 沒有可用的功率資料` };
      const weightKg = ctx.config.training.weightKg;
      const out: typeof m & { ftp: number; avgWPerKg?: number; npWPerKg?: number } = { ...m, ftp };
      if (weightKg != null && weightKg > 0) {
        out.avgWPerKg = Math.round((m.avgPower / weightKg) * 10) / 10;
        out.npWPerKg = Math.round((m.normalizedPower / weightKg) * 10) / 10;
      }
      return out;
    },
  };
}

/** 由 ride.workoutId 還原 prescribed segments（plan:<id>:<day> 或 workout profile id）。 */
function resolveWorkoutSegments(
  ctx: ToolContext,
  ride: Ride,
): { segments: WorkoutSegment[]; source: string } | { error: string } {
  // Recorded at start — the only version that is certainly what the rider was
  // actually shown. Everything below is a best-effort reconstruction for rides
  // predating rides.workout_segments.
  if (ride.workoutSegments && ride.workoutSegments.length > 0) {
    return { segments: ride.workoutSegments, source: ride.workoutId ?? 'recorded' };
  }
  const workoutId = ride.workoutId;
  if (!workoutId) {
    return { error: `騎乘 ${ride.id} 沒有 workoutId（自由騎），無對應課表可比對遵從度` };
  }
  // plan:<planId>:<day> → 從課表取該日 segments。
  if (workoutId.startsWith('plan:')) {
    const rest = workoutId.slice('plan:'.length);
    const lastColon = rest.lastIndexOf(':');
    const planId = lastColon >= 0 ? rest.slice(0, lastColon) : rest;
    const day = lastColon >= 0 ? Number(rest.slice(lastColon + 1)) : NaN;
    const plan: TrainingPlan | null = ctx.db.getPlan(planId);
    if (!plan) return { error: `找不到課表 ${planId}` };
    const session = getSessionByDay(plan, day);
    if (!session) return { error: `課表 ${planId} 沒有第 ${day} 天` };
    return { segments: planSegmentsToWorkoutSegments(session.segments), source: `plan:${planId}:${day}` };
  }
  // workout profile id → 依 ride 實際時長把百分比模板展開。
  const profile = WORKOUT_PROFILES_MAP[workoutId];
  if (!profile) return { error: `未知的 workoutId "${workoutId}"` };
  const durationMs = ride.durationMs ?? 0;
  if (durationMs <= 0) return { error: `騎乘 ${ride.id} 缺少時長，無法展開 workout profile` };
  // Legacy path only. This expands the profile against the ride's ACTUAL
  // duration and without knowing whether repeat-to-fill was on, so it can only
  // approximate what the rider rode. Rides recorded since workout_segments
  // exists never reach here.
  return { segments: buildWorkoutSegments(profile, durationMs), source: `${profile.id} (reconstructed)` };
}

function getWorkoutComplianceTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_workout_compliance',
    description:
      '評估單筆課表訓練的遵從度：把 ride 對齊 prescribed segments（課表日或 workout 模板），' +
      '算每段 time-on-target%（心率區間或 ±10% 功率帶）與整體評級（A-D）。ride 為自由騎' +
      '（無 workoutId）時回傳說明性錯誤。',
    parameters: {
      type: 'object',
      properties: { rideId: { type: 'integer', description: '騎乘 ID' } },
      required: ['rideId'],
    },
    execute(args: { rideId: number }) {
      const ride = ctx.db.getRide(args.rideId);
      if (!ride) return { error: `找不到騎乘 ${args.rideId}` };
      const resolved = resolveWorkoutSegments(ctx, ride);
      if ('error' in resolved) return { error: resolved.error };
      const samples = ctx.db.getSamplesForExport(args.rideId);
      if (samples.length === 0) return { error: `騎乘 ${args.rideId} 沒有樣本資料` };
      const result = workoutCompliance(samples, resolved.segments, ctx.config.training.ftp);
      return { rideId: args.rideId, workoutSource: resolved.source, ...result };
    },
  };
}

function getWeeklyLoadSummaryTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_weekly_load_summary',
    description:
      '近 N 週的訓練量彙總（每週一列）：騎乘次數、總時數、總距離 km、平均功率、TSS 合計、' +
      '五區心率分鐘數合計。省去逐筆自行加總。尊重使用者的過濾設定。',
    parameters: {
      type: 'object',
      properties: {
        weeks: { type: 'integer', description: '回顧週數（預設 4，最多 12）', minimum: 1, maximum: 12 },
      },
      required: [],
    },
    execute(args: { weeks?: number }) {
      const weeks = Math.min(args.weeks ?? 4, 12);
      const from = dayjs().startOf('week').subtract(weeks - 1, 'week').valueOf();
      const rides = ctx.db.listRides({
        limit: 500,
        from,
        excludeEmpty: ctx.rideFilter?.excludeEmpty,
      });
      const ftp = ctx.config.training.ftp;
      const hrMax = ctx.config.training.hrMax;

      // 以每週起始日（startOf('week')）為 key 分組。
      const buckets = new Map<string, {
        weekStart: string; rides: number; hours: number; km: number;
        powerSum: number; powerN: number; tss: number; zoneMin: number[];
      }>();
      for (const r of rides) {
        const key = dayjs(r.startedAt).startOf('week').format('YYYY-MM-DD');
        let b = buckets.get(key);
        if (!b) {
          b = { weekStart: key, rides: 0, hours: 0, km: 0, powerSum: 0, powerN: 0, tss: 0, zoneMin: [0, 0, 0, 0, 0] };
          buckets.set(key, b);
        }
        b.rides++;
        b.hours += (r.durationMs ?? 0) / 3_600_000;
        b.km += (r.distanceM ?? 0) / 1000;
        if (r.avgPowerW != null) { b.powerSum += r.avgPowerW; b.powerN++; }

        const samples = ctx.db.getSamplesForExport(r.id);
        if (samples.length > 0) {
          const pm = powerMetrics(samples, ftp);
          if (pm) b.tss += pm.tss;
          const zd = zoneDistribution(samples, hrMax);
          zd.zones.forEach((z, i) => { b.zoneMin[i] += z.minutes; });
        }
      }

      const weeksOut = [...buckets.values()]
        .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1))
        .map((b) => ({
          weekStart: b.weekStart,
          rides: b.rides,
          hours: Math.round(b.hours * 10) / 10,
          km: Math.round(b.km * 10) / 10,
          avgPowerW: b.powerN > 0 ? Math.round(b.powerSum / b.powerN) : null,
          totalTss: Math.round(b.tss * 10) / 10,
          zoneMinutes: b.zoneMin.map((m) => Math.round(m * 10) / 10),
        }));
      return { weeks: weeksOut };
    },
  };
}

function getBestEffortsTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_best_efforts',
    description:
      '功率曲線最佳輸出：5s / 1min / 5min / 20min 的最佳 rolling 平均功率（W）。給 rideId 針對' +
      '該筆；不給則掃描最近 ≤20 筆取每個時窗的最佳（附對應 rideId）。尊重使用者的過濾設定。',
    parameters: {
      type: 'object',
      properties: {
        rideId: { type: 'integer', description: '選填，指定騎乘 ID' },
        limit: { type: 'integer', description: '掃描模式的筆數（預設 20，最多 20）', minimum: 1, maximum: 20 },
      },
      required: [],
    },
    execute(args: { rideId?: number; limit?: number }) {
      const WINDOWS = [5, 60, 300, 1200];
      if (args.rideId != null) {
        const samples = ctx.db.getSamplesForExport(args.rideId);
        if (samples.length === 0) return { error: `騎乘 ${args.rideId} 沒有樣本資料` };
        return { rideId: args.rideId, efforts: bestEfforts(samples, WINDOWS) };
      }
      // 掃描模式：逐窗取跨 ride 最佳，記住來源 ride。
      const limit = Math.min(args.limit ?? 20, 20);
      const rides = ctx.db.listRides({ limit, excludeEmpty: ctx.rideFilter?.excludeEmpty });
      const best = WINDOWS.map((w) => ({ windowSec: w, watts: null as number | null, rideId: null as number | null }));
      for (const r of rides) {
        const samples = ctx.db.getSamplesForExport(r.id);
        if (samples.length === 0) continue;
        const efforts = bestEfforts(samples, WINDOWS);
        efforts.forEach((e, i) => {
          if (e.watts != null && (best[i].watts == null || e.watts > (best[i].watts as number))) {
            best[i].watts = e.watts;
            best[i].rideId = r.id;
          }
        });
      }
      return { scanned: rides.length, efforts: best };
    },
  };
}

// ── P2：有氧脫鉤 / 路線資訊 / 騎乘比較 ──

function getHrDriftTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_hr_drift',
    description:
      '有氧脫鉤（Pw:HR decoupling）分析：排除暖身前 10% 後，前半 vs 後半的 power:HR 比值漂移%' +
      '（正值＝同功率下心率漂高）。>5% 標記有氧耐力不足。資料不足回錯誤。',
    parameters: {
      type: 'object',
      properties: { rideId: { type: 'integer', description: '騎乘 ID' } },
      required: ['rideId'],
    },
    execute(args: { rideId: number }) {
      const samples = ctx.db.getSamplesForExport(args.rideId);
      if (samples.length === 0) return { error: `騎乘 ${args.rideId} 沒有樣本資料` };
      const drift = hrDrift(samples);
      if (!drift) return { error: `騎乘 ${args.rideId} 的心率+功率資料不足以計算脫鉤` };
      return { rideId: args.rideId, ...drift };
    },
  };
}

function getRouteInfoTool(ctx: ToolContext): AgentTool {
  return {
    name: 'get_route_info',
    description:
      '查詢路線資訊：給 routeId 回單條（名稱、距離 m、爬升 m、點數）；不給則列出全部路線摘要。' +
      '用於把「190W 爬 800m」與「190W 平路」區分。',
    parameters: {
      type: 'object',
      properties: { routeId: { type: 'string', description: '選填，指定路線 ID' } },
      required: [],
    },
    execute(args: { routeId?: string }) {
      if (!ctx.routeStore) return { error: '路線資料未接入（routeStore 不可用）' };
      if (args.routeId != null) {
        const route = ctx.routeStore.get(args.routeId);
        if (!route) return { error: `找不到路線 ${args.routeId}` };
        return {
          id: route.id,
          name: route.name,
          distanceM: Math.round(route.distanceM),
          elevGainM: Math.round(route.elevGainM),
          points: route.points.length,
        };
      }
      return ctx.routeStore.list().map((r) => {
        const full = ctx.routeStore!.get(r.id);
        return {
          id: r.id,
          name: r.name,
          distanceM: Math.round(r.distanceM),
          elevGainM: Math.round(r.elevGainM),
          points: full ? full.points.length : null,
        };
      });
    },
  };
}

function compareRidesTool(ctx: ToolContext): AgentTool {
  return {
    name: 'compare_rides',
    description:
      '對齊比較兩筆騎乘：各切成 N 桶回傳功率/心率/踏頻平均，並附整體平均與差值（B − A）。' +
      '用於前後對照同一種訓練是否進步。',
    parameters: {
      type: 'object',
      properties: {
        rideIdA: { type: 'integer', description: '騎乘 A 的 ID（基準）' },
        rideIdB: { type: 'integer', description: '騎乘 B 的 ID（對照）' },
        buckets: { type: 'integer', description: '時序桶數（預設 8）', minimum: 1, maximum: 30 },
      },
      required: ['rideIdA', 'rideIdB'],
    },
    execute(args: { rideIdA: number; rideIdB: number; buckets?: number }) {
      const buckets = args.buckets ?? 8;
      const sa = ctx.db.getSamplesForExport(args.rideIdA);
      const sb = ctx.db.getSamplesForExport(args.rideIdB);
      if (sa.length === 0) return { error: `騎乘 ${args.rideIdA} 沒有樣本資料` };
      if (sb.length === 0) return { error: `騎乘 ${args.rideIdB} 沒有樣本資料` };
      const a = summariseSamples(sa, buckets);
      const b = summariseSamples(sb, buckets);
      const delta = (x: number | null, y: number | null): number | null =>
        x == null || y == null ? null : Math.round((y - x) * 10) / 10;
      return {
        rideA: { rideId: args.rideIdA, ...a },
        rideB: { rideId: args.rideIdB, ...b },
        deltas: {
          avgPower: delta(a.power.avg, b.power.avg),
          avgHr: delta(a.hr.avg, b.hr.avg),
          avgCadence: delta(a.cadence.avg, b.cadence.avg),
          durationMin: b.durationMin - a.durationMin,
        },
      };
    },
  };
}

// ── 降採樣：時序桶平均 ──

function summariseSamples(samples: RideSample[], buckets: number) {
  const durationMs = samples[samples.length - 1].elapsedMs;
  const bucketMs = Math.max(1, durationMs / buckets);

  const acc = Array.from({ length: buckets }, () => ({
    pwr: [] as number[],
    hr: [] as number[],
    cad: [] as number[],
  }));
  const allPwr: number[] = [];
  const allHr: number[] = [];
  const allCad: number[] = [];
  let maxPwr = 0;
  let maxHr = 0;

  for (const s of samples) {
    const idx = Math.min(buckets - 1, Math.floor(s.elapsedMs / bucketMs));
    if (s.powerW != null) {
      acc[idx].pwr.push(s.powerW);
      allPwr.push(s.powerW);
      if (s.powerW > maxPwr) maxPwr = s.powerW;
    }
    if (s.hr != null) {
      acc[idx].hr.push(s.hr);
      allHr.push(s.hr);
      if (s.hr > maxHr) maxHr = s.hr;
    }
    if (s.cadence != null) {
      acc[idx].cad.push(s.cadence);
      allCad.push(s.cadence);
    }
  }

  return {
    durationMin: Math.round(durationMs / 60_000),
    samples: samples.length,
    power: { avg: avgOf(allPwr), max: allPwr.length ? Math.round(maxPwr) : null },
    hr: { avg: avgOf(allHr), max: allHr.length ? maxHr : null },
    cadence: { avg: avgOf(allCad) },
    buckets: acc.map((b, i) => ({
      tMin: Math.round(((i + 0.5) * bucketMs) / 60_000),
      avgPower: avgOf(b.pwr),
      avgHr: avgOf(b.hr),
      avgCadence: avgOf(b.cad),
    })),
  };
}

// ── P2：課表生成終局 tool ──

/** submit_plan 的參數 schema，對齊 shared 的 validatePlanInput。 */
const PLAN_SEGMENT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['warmup', 'steady', 'interval_work', 'interval_rest', 'cooldown'],
      description: 'segment 類型；間歇必須把 work / rest 拆成獨立 segment',
    },
    durationMin: { type: 'number', description: '此 segment 分鐘數（正整數）', minimum: 1 },
    hrMin: { type: 'number', description: '目標心率下限 bpm' },
    hrMax: { type: 'number', description: '目標心率上限 bpm' },
    cadenceRpm: { type: 'number', description: '選填，目標踏頻' },
    notes: { type: 'string', description: '選填，簡短教練提示' },
  },
  required: ['type', 'durationMin', 'hrMin', 'hrMax'],
};

const PLAN_SESSION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    day: { type: 'integer', description: '1-based 連續天數編號（第1天=1）', minimum: 1 },
    type: { type: 'string', enum: ['training', 'rest'], description: 'training 或 rest；rest 日 segments 必須為空' },
    durationMin: { type: 'number', description: '當日總分鐘數（rest 日為 0）' },
    segments: { type: 'array', items: PLAN_SEGMENT_SCHEMA, description: 'rest 日為空陣列' },
  },
  required: ['day', 'type', 'durationMin', 'segments'],
};

const SUBMIT_PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '課表名稱' },
    description: { type: 'string', description: '課表說明——可用 Markdown（標題、粗體、條列）；不要輸出 HTML' },
    weeks: {
      type: 'array',
      description: '各週資料',
      items: {
        type: 'object',
        properties: {
          week: { type: 'integer', description: '1-based 週次', minimum: 1 },
          focus: { type: 'string', description: '本週訓練重點' },
          sessions: { type: 'array', items: PLAN_SESSION_SCHEMA, description: '含休息日的每日 session' },
        },
        required: ['week', 'focus', 'sessions'],
      },
    },
  },
  required: ['name', 'description', 'weeks'],
};

/**
 * 課表生成的終局 tool。驗證通過即建立並存檔，回 {ok:true, planId, plan}；
 * 驗證失敗回 {ok:false, errors} 讓 LLM 修正後重新呼叫。
 */
export function submitPlanTool(ctx: ToolContext): AgentTool {
  return {
    name: 'submit_plan',
    description:
      '提交最終課表。規則：每個 segment 只能代表單一連續動作；間歇必須把 work / rest 交替' +
      '拆成獨立 segment；休息日 type 為 "rest" 且 segments 為空陣列；所有數值為整數；' +
      'day 使用 1-based 連續編號。驗證失敗會回傳錯誤清單，請修正後再次呼叫本工具。',
    parameters: SUBMIT_PLAN_SCHEMA,
    execute(args: unknown) {
      const validation = validatePlanInput(args);
      if (!validation.valid) {
        return { ok: false as const, errors: validation.errors };
      }
      const planData = createPlanFromInput(args as TrainingPlanInput, 'llm');
      const plan = ctx.db.createPlan(planData);
      return { ok: true as const, planId: plan.id, plan };
    },
  };
}
