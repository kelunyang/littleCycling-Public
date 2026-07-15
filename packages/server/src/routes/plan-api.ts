/**
 * Training plan CRUD + LLM generation — Fastify plugin.
 */

import type { FastifyInstance } from 'fastify';
import {
  validatePlanInput,
  createPlanFromInput,
  getSessionByDay,
  planSegmentsToWorkoutSegments,
  workoutCompliance,
} from '@littlecycling/shared';
import type { TrainingPlan, RideSample, WorkoutComplianceResult } from '@littlecycling/shared';
import type { RideDatabase } from '../lib/database.js';
import type { ConfigStore } from '../lib/config-store.js';
import type { RouteStore } from '../lib/route-store.js';
import { buildDefaultUserPrompt, buildFullPrompt, buildAgentSystemPrompt } from '../lib/plan-prompt.js';
import { callLlm, extractJson } from '../lib/llm-client.js';
import { runAgent } from '../lib/agent/agent-loop.js';
import { buildToolRegistry, submitPlanTool } from '../lib/agent/tools.js';
import type { AgentEvent, ToolContext } from '../lib/agent/types.js';
import { formatSseFrame, createReasoningThrottle } from '../lib/agent/sse.js';

interface PlanApiOpts {
  db: RideDatabase;
  configStore: ConfigStore;
  routeStore: RouteStore;
}

// ── 課表遵從度共用管線 ──

/**
 * 解析某一天的 session → segments → 用實際 samples 算遵從度。
 * 回 null 代表「無法計算」：該天不是訓練日、無 segment、或無騎乘樣本。
 * 兩個 endpoint(/actual 與 /compliance-summary)共用此管線,避免邏輯分岔。
 */
function computeDayCompliance(
  plan: TrainingPlan,
  day: number,
  samples: RideSample[],
  ftp: number,
): WorkoutComplianceResult | null {
  const session = getSessionByDay(plan, day);
  if (!session || session.type !== 'training' || session.segments.length === 0) return null;
  if (samples.length === 0) return null;
  return workoutCompliance(samples, planSegmentsToWorkoutSegments(session.segments), ftp);
}

/**
 * HR 軌跡降採樣:過濾掉 hr 為 null 的樣本,依索引平均分桶到 ≤maxPoints 點,
 * 每桶回傳平均後的 { tMs, hr }。前端只負責畫線,降採樣在後端做。
 */
function downsampleHrTrack(samples: RideSample[], maxPoints = 240): { tMs: number; hr: number }[] {
  const valid = samples.filter((s) => s.hr != null);
  if (valid.length === 0) return [];
  if (valid.length <= maxPoints) {
    return valid.map((s) => ({ tMs: s.elapsedMs, hr: s.hr as number }));
  }
  const out: { tMs: number; hr: number }[] = [];
  const bucketSize = valid.length / maxPoints;
  for (let i = 0; i < maxPoints; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    let sumT = 0, sumH = 0, n = 0;
    for (let j = start; j < end; j++) {
      sumT += valid[j].elapsedMs;
      sumH += valid[j].hr as number;
      n++;
    }
    if (n > 0) out.push({ tMs: Math.round(sumT / n), hr: Math.round(sumH / n) });
  }
  return out;
}

export default async function planApi(fastify: FastifyInstance, opts: PlanApiOpts): Promise<void> {
  const { db, configStore, routeStore } = opts;

  // ── Plan CRUD ──

  /** List all plans (summaries). */
  fastify.get('/api/plans', async () => {
    const plans = db.listPlans();
    // debug:回了幾筆。若前端列表是 0 但這裡是 1+,問題在前端/傳輸;
    // 若這行根本沒出現,代表前端的請求打到了別的 server。
    console.log(`[plan-api] GET /api/plans → ${plans.length} plan(s)`);
    return { plans };
  });

  /** Get full plan with weeks. */
  fastify.get<{ Params: { id: string } }>('/api/plans/:id', async (req, reply) => {
    const plan = db.getPlan(req.params.id);
    if (!plan) return reply.code(404).send({ error: 'Plan not found' });
    return plan;
  });

  /** Create a plan from JSON body (manual import). */
  fastify.post('/api/plans', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const validation = validatePlanInput(body);
    if (!validation.valid) {
      return reply.code(400).send({ error: 'Invalid plan', details: validation.errors });
    }
    const planData = createPlanFromInput(body as any, 'manual');
    const plan = db.createPlan(planData);
    return reply.code(201).send(plan);
  });

  /** Delete a plan. */
  fastify.delete<{ Params: { id: string } }>('/api/plans/:id', async (req, reply) => {
    // Also remove from active plans if active
    db.removeActivePlan(req.params.id);
    const deleted = db.deletePlan(req.params.id);
    if (!deleted) return reply.code(404).send({ error: 'Plan not found' });
    return { ok: true };
  });

  // ── LLM Generation ──

  /**
   * Generate a plan via LLM.
   *
   * 預設走 agentic tool-use loop（runAgent）並以 SSE 串流即時回報進度：模型可
   * 查騎手真實紀錄、FTP 估算後再個人化課表，最終呼叫 submit_plan 提交。每一則
   * AgentEvent 一幀 `data:`；submit_plan 成功推 `{phase:'result', data: plan}`。
   *
   * fallback：
   * - `?stream=0` 走同步 runAgent（一次回 JSON，不串流）。
   * - `?legacy=1` 走舊的單輪 callLlm + extractJson 路徑。
   */
  fastify.post('/api/plans/generate', async (req, reply) => {
    const body = req.body as {
      llmIndex: number;
      weeks?: number;
      sessionsPerWeek?: number;
      minutesPerSession?: number;
      goal?: string;
      notes?: string;      // special instructions for the LLM
      userPrompt?: string; // user-edited prompt (optional override)
    };
    const query = req.query as { legacy?: string; stream?: string };

    const config = configStore.get();
    // provider 現在存在 SQLite；llmIndex 對應 sort_order 排序後的 index。
    const provider = db.listLlmProviders()[body.llmIndex];
    if (!provider) {
      return reply.code(400).send({ error: `LLM provider at index ${body.llmIndex} not configured` });
    }

    // Build the rider-info user prompt (shared by all paths).
    const userPrompt = body.userPrompt ?? buildDefaultUserPrompt({
      hrMax: config.training.hrMax,
      weeks: body.weeks ?? 4,
      sessionsPerWeek: body.sessionsPerWeek ?? 3,
      minutesPerSession: body.minutesPerSession ?? 35,
      goal: body.goal ?? '減脂與體重控制',
      notes: body.notes,
    });

    // ── Legacy fallback：舊單輪路徑（?legacy=1）──
    if (query.legacy) {
      const fullPrompt = buildFullPrompt(userPrompt);
      try {
        console.log(`[plan-api] (legacy) Generating plan via ${provider.name}...`);
        const rawResponse = await callLlm(provider, fullPrompt);
        const jsonStr = extractJson(rawResponse);

        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          return reply.code(502).send({ error: 'LLM returned invalid JSON', raw: jsonStr.slice(0, 2000) });
        }

        const validation = validatePlanInput(parsed);
        if (!validation.valid) {
          return reply.code(502).send({
            error: 'LLM output failed validation',
            details: validation.errors,
            raw: jsonStr.slice(0, 2000),
          });
        }

        const planData = createPlanFromInput(parsed as any, 'llm');
        const plan = db.createPlan(planData);
        console.log(`[plan-api] (legacy) Plan "${plan.name}" created (${plan.totalDays} days)`);
        return reply.code(201).send(plan);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[plan-api] (legacy) LLM generation failed:`, message);
        return reply.code(502).send({ error: `LLM call failed: ${message}` });
      }
    }

    // ── Agentic 路徑：組 tools ──
    const ctx: ToolContext = { db, config, routeStore };
    const tools = [...buildToolRegistry(ctx), submitPlanTool(ctx)];

    // ── 同步 fallback（?stream=0）：一次回 JSON，不串流 ──
    if (query.stream === '0') {
      try {
        console.log(`[plan-api] Generating plan (agentic, sync) via ${provider.name}...`);
        const result = await runAgent({
          provider,
          system: buildAgentSystemPrompt(),
          initialUser: userPrompt,
          tools,
          ctx,
          finalToolNames: ['submit_plan'],
          onEvent: (e: AgentEvent) => console.log(`[plan-api][agent] ${JSON.stringify(e)}`),
        });

        const submitted = result.result as { ok?: boolean; plan?: unknown } | undefined;
        if (submitted?.ok && submitted.plan) {
          const plan = submitted.plan as { name: string; totalDays: number };
          console.log(`[plan-api] Plan "${plan.name}" created (${plan.totalDays} days)`);
          return reply.code(201).send(submitted.plan);
        }
        return reply.code(502).send({
          error: 'LLM did not submit a valid plan',
          raw: result.finalText.slice(0, 2000),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[plan-api] LLM generation failed:`, message);
        return reply.code(502).send({ error: `LLM call failed: ${message}` });
      }
    }

    // ── SSE 串流路徑（預設）──
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      // 必須是 close,不能 keep-alive:Vite proxy 轉發本請求時帶 Connection:
      // close,若回應宣告 keep-alive,proxy 的 agent 會把「下一個請求」重用同
      // 一條 socket,server 解析器直接回 HPE_CLOSED_CONNECTION 400——受害者
      // 正是生成結束後的 GET /api/plans(列表因此永遠刷新不到)。
      Connection: 'close',
      'X-Accel-Buffering': 'no', // 關掉反向代理緩衝，確保逐幀送出
    });

    const send = (e: AgentEvent) => {
      // submit_plan 成功時 runAgent 會發 result 事件，data 為 {ok,planId,plan}；
      // 依計畫把 result 的 data 收斂成純 plan 物件供前端刷新使用。
      let frame: string;
      if (e.phase === 'result') {
        const d = e.data as { plan?: unknown } | undefined;
        const plan = d && typeof d === 'object' && 'plan' in d ? d.plan : e.data;
        frame = formatSseFrame({ phase: 'result', data: plan });
      } else {
        frame = formatSseFrame(e);
      }
      // debug:逐幀 log phase 與大小,供比對前端 [agent-stream] 判斷幀在哪端消失
      //（reasoning 幀量大,略過不記）。
      if (e.phase !== 'reasoning') {
        console.log(`[plan-api][sse] → ${e.phase} (${Buffer.byteLength(frame)} bytes)`);
      }
      raw.write(frame);
    };

    // reasoning（DeepSeek CoT）節流後才推 SSE，避免打爆串流。
    const throttle = createReasoningThrottle((delta) => send({ phase: 'reasoning', delta }));

    try {
      console.log(`[plan-api] Generating plan (agentic, SSE) via ${provider.name}...`);
      const result = await runAgent({
        provider,
        system: buildAgentSystemPrompt(),
        initialUser: userPrompt,
        tools,
        ctx,
        finalToolNames: ['submit_plan'],
        onEvent: send,
        onReasoning: throttle.push,
      });
      throttle.flush();

      const submitted = result.result as { ok?: boolean; plan?: { name?: string; totalDays?: number } } | undefined;
      if (submitted?.ok && submitted.plan) {
        console.log(`[plan-api] Plan "${submitted.plan.name}" created (${submitted.plan.totalDays} days)`);
      } else {
        // runAgent 未捕捉到成功的 submit_plan → 明確送一則 error。
        send({ phase: 'error', message: '模型未提交有效的課表。' });
      }
    } catch (err) {
      throttle.flush();
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[plan-api] LLM generation failed:`, message);
      send({ phase: 'error', message: `課表生成失敗：${message}` });
    } finally {
      raw.end();
      console.log('[plan-api][sse] stream closed');
    }
  });

  /** Get default user prompt (for pre-filling the textarea). */
  fastify.get('/api/plans/default-prompt', async (req) => {
    const query = req.query as {
      weeks?: string;
      sessionsPerWeek?: string;
      minutesPerSession?: string;
      goal?: string;
      notes?: string;
    };
    const config = configStore.get();
    return {
      prompt: buildDefaultUserPrompt({
        hrMax: config.training.hrMax,
        weeks: parseInt(query.weeks ?? '4', 10),
        sessionsPerWeek: parseInt(query.sessionsPerWeek ?? '3', 10),
        minutesPerSession: parseInt(query.minutesPerSession ?? '35', 10),
        goal: query.goal ?? '減脂與體重控制',
        notes: query.notes,
      }),
    };
  });

  // ── Active plans ──

  /** Get all active plans. */
  fastify.get('/api/plans/active', async () => {
    return { activePlans: db.getActivePlans() };
  });

  /** Activate a plan. */
  fastify.post('/api/plans/active', async (req, reply) => {
    const { planId, startDate } = req.body as { planId: string; startDate: string };
    if (!planId || !startDate) {
      return reply.code(400).send({ error: 'planId and startDate are required' });
    }
    // Verify plan exists
    if (!db.getPlan(planId)) {
      return reply.code(404).send({ error: 'Plan not found' });
    }
    db.addActivePlan(planId, startDate);
    return { ok: true };
  });

  /** Deactivate a plan. */
  fastify.delete<{ Params: { planId: string } }>('/api/plans/active/:planId', async (req, reply) => {
    const removed = db.removeActivePlan(req.params.planId);
    if (!removed) return reply.code(404).send({ error: 'Plan was not active' });
    return { ok: true };
  });

  // ── Completions ──

  /** Get completions for a plan. */
  fastify.get<{ Params: { id: string } }>('/api/plans/:id/completions', async (req) => {
    return { completions: db.getCompletions(req.params.id) };
  });

  // ── 課表視覺化:實際 vs prescribed ──

  /**
   * 某一天的實際遵從度 + HR 軌跡(展開日子時拉,把實際疊在 prescribed profile 上)。
   * - plan / 該 day 的 session 不存在 → 404。
   * - 該 (planId, day) 無 completion 或 completion 無 rideId(手動標記)→ { hasActual: false }。
   * - 有 rideId → 撈 samples,算 workoutCompliance + 降採樣 HR 軌跡。
   */
  fastify.get<{ Params: { id: string; day: string } }>(
    '/api/plans/:id/days/:day/actual',
    async (req, reply) => {
      const plan = db.getPlan(req.params.id);
      if (!plan) return reply.code(404).send({ error: 'Plan not found' });

      const day = Number(req.params.day);
      if (!Number.isInteger(day) || day < 1) {
        return reply.code(400).send({ error: 'day must be a positive integer' });
      }

      const session = getSessionByDay(plan, day);
      if (!session) return reply.code(404).send({ error: 'Day not found in plan' });

      const completion = db.getCompletions(req.params.id).find((c) => c.day === day);
      if (!completion || completion.rideId == null) {
        return { hasActual: false };
      }

      const samples = db.getSamplesForExport(completion.rideId);
      const ftp = configStore.get().training.ftp;
      const result = computeDayCompliance(plan, day, samples, ftp);
      // rest 日 / 無 segment / 無樣本 → 無法計算,視同無實際資料。
      if (!result) return { hasActual: false };

      return {
        hasActual: true,
        rideId: completion.rideId,
        grade: result.grade,
        overallTimeOnTargetPct: result.overallTimeOnTargetPct,
        segments: result.segments,
        hrTrack: downsampleHrTrack(samples),
      };
    },
  );

  /**
   * 整份課表的遵從度摘要:逐個「有 rideId 的 completion」算 grade + 達標%,
   * 回 { days: { [day]: { grade, pct } } }。展開課表卡時一次拉,day cell 顯示等級。
   * 略過:該天無訓練 session、或該 ride 無樣本(不入 map)。
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/plans/:id/compliance-summary',
    async (req, reply) => {
      const plan = db.getPlan(req.params.id);
      if (!plan) return reply.code(404).send({ error: 'Plan not found' });

      const ftp = configStore.get().training.ftp;
      const days: Record<number, { grade: string; pct: number }> = {};
      for (const c of db.getCompletions(req.params.id)) {
        if (c.rideId == null) continue;
        const samples = db.getSamplesForExport(c.rideId);
        const result = computeDayCompliance(plan, c.day, samples, ftp);
        if (!result) continue;
        days[c.day] = { grade: result.grade, pct: result.overallTimeOnTargetPct };
      }
      return { days };
    },
  );

  /** Record a completion. */
  fastify.post<{ Params: { id: string } }>('/api/plans/:id/completions', async (req, reply) => {
    const { day, rideId, manual } = req.body as {
      day: number;
      rideId?: number;
      manual?: boolean;
    };
    if (typeof day !== 'number' || day < 1) {
      return reply.code(400).send({ error: 'day must be a positive integer' });
    }
    db.recordCompletion(req.params.id, day, rideId ?? null, manual ?? false);
    return { ok: true };
  });
}
