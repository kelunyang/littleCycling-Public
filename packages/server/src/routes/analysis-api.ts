/**
 * 訓練分析 — Fastify plugin。
 *
 * `POST /api/analysis/generate`（SSE）：以自行車教練角色，透過 agent tool-use
 * loop 查詢騎手的真實訓練紀錄與 FTP 趨勢，最終以 Markdown（phase:'final'）給出
 * 繁體中文的分析報告。與課表生成共用 buildToolRegistry，但**不含** submit_plan
 * （分析不需要建立課表，終局走最終文字而非終局 tool）。產出的報告會落庫到
 * `analysis_reports`，前端可透過 GET /api/analysis/reports 瀏覽/刪除歷史。
 */

import type { FastifyInstance } from 'fastify';
import type { AnalysisFocus } from '@littlecycling/shared';
import { MAX_ANALYSIS_RIDES } from '@littlecycling/shared';
import type { RideDatabase } from '../lib/database.js';
import type { ConfigStore } from '../lib/config-store.js';
import type { RouteStore } from '../lib/route-store.js';
import { runAgent } from '../lib/agent/agent-loop.js';
import { buildToolRegistry } from '../lib/agent/tools.js';
import type { AgentEvent, ToolContext } from '../lib/agent/types.js';
import { formatSseFrame, createReasoningThrottle } from '../lib/agent/sse.js';

interface AnalysisApiOpts {
  db: RideDatabase;
  configStore: ConfigStore;
  routeStore: RouteStore;
}

/** 教練角色 system prompt。 */
function buildAnalysisSystemPrompt(): string {
  return `你是一位專業的自行車教練，擅長解讀室內訓練台的功率與心率資料。
你的任務是根據騎手的真實訓練紀錄，給出具體、可執行的訓練分析與建議。

【工具使用指引】
- 你可以呼叫工具查詢騎手的訓練紀錄、FTP 估算、心率區間設定與課表進度。
- 基本流程：先 get_training_config 取得心率區間、FTP（與 W/kg）；用 list_recent_rides 掌握近期訓練量與強度；用 estimate_ftp 估算實際 FTP；必要時用 get_ride_summary_stats 檢視單次節奏、get_ride_counts 觀察頻率。
- 建議的深入流程：
  - 評論單次訓練 → get_ride_zone_distribution（強度分布）+ get_ride_power_metrics（NP/IF/TSS/VI）；該筆若有 workoutId 再 get_workout_compliance 看照表程度。
  - 談進步 / 趨勢 → get_ftp_trend + get_best_efforts（功率曲線）+ get_weekly_load_summary（週負荷）。
  - 課表相關（今天該練什麼、有無照表）→ get_active_plans 找出 planId 後 get_plan_detail（加 day 看單日）。
  - 想看耐力品質 → get_hr_drift（有氧脫鉤）；區分地形影響 → get_route_info；前後對照 → compare_rides。
- 列出騎乘的工具（list_recent_rides、get_rides_by_date、estimate_ftp 掃描、get_ride_counts、get_ftp_trend、get_weekly_load_summary、get_best_efforts 掃描）只會回傳符合使用者過濾設定的紀錄；若某些紀錄「看似缺漏」，是被使用者的過濾條件排除，屬正常，不必臆測。
- 只根據查到的真實資料下結論，資料不足時明確說明「資料不足」，不要臆測或編造數字。

【輸出要求】
- 一律使用繁體中文。
- 以 Markdown 撰寫，用 \`##\` 標題分段（例如：訓練回顧、強度分布、FTP 趨勢、建議），段落內以條列（bullet）呈現；數據比較可用表格。
- 給出的建議要具體可執行（頻率、時長、目標心率區間），避免空泛。
- 只使用一般 Markdown（標題、粗體、條列、表格）；禁止 mermaid、LaTeX 數學式與 HTML 標籤；也不要把整份輸出包在 \`\`\` 圍欄裡。
- 查到足夠資訊後，直接輸出最終 Markdown 分析，不要再呼叫工具。`;
}

/** 依 focus 組出 focus 對應的提示語（不含指定騎乘的前置段）。 */
function buildFocusPrompt(focus: AnalysisFocus, question?: string): string {
  if (focus === 'ftp_trend') {
    return '請分析我近期的 FTP 趨勢：先估算目前 FTP，回顧最近幾次訓練的最佳 20 分鐘功率變化，判斷體能是進步、持平還是退步，並給出下一步的訓練強度建議。';
  }
  if (focus === 'custom') {
    const q = (question ?? '').trim();
    return q.length > 0
      ? q
      : '請根據我的訓練紀錄，給我一份整體的訓練回顧與建議。';
  }
  // review（預設）
  return '請回顧我最近的訓練狀況：整理近期的訓練量、強度分布與心率表現，指出目前的優缺點，並給出接下來的訓練重點建議。';
}

/**
 * 組出給模型的第一則使用者訊息。使用者若指定 rideIds，前置一段要求模型逐筆
 * 檢視這些騎乘，再接上 focus 對應的提示語。
 */
function buildAnalysisUserPrompt(focus: AnalysisFocus, question?: string, rideIds?: number[]): string {
  const focusPrompt = buildFocusPrompt(focus, question);
  if (rideIds && rideIds.length > 0) {
    const idList = rideIds.join('、');
    return (
      `使用者指定本次分析以這 ${rideIds.length} 筆騎乘為主（ride ID：${idList}）。` +
      `請先用 get_ride_detail 與 get_ride_summary_stats 逐筆檢視這些騎乘;需要更多背景` +
      `（趨勢、比較）可自行查詢其他紀錄。\n\n${focusPrompt}`
    );
  }
  return focusPrompt;
}

/**
 * 剝除模型偶爾把整段輸出包起來的單一 markdown 圍欄（``` 或 ```markdown）。
 * 只在「首行是圍欄開頭、末行是單獨 ```」時剝一層，內文中的其他內容不動。
 */
function stripOuterFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const lines = trimmed.split('\n');
  if (lines.length < 2 || lines[lines.length - 1].trim() !== '```') return trimmed;
  return lines.slice(1, -1).join('\n').trim();
}

export default async function analysisApi(fastify: FastifyInstance, opts: AnalysisApiOpts): Promise<void> {
  const { db, configStore, routeStore } = opts;

  fastify.post('/api/analysis/generate', async (req, reply) => {
    const body = req.body as {
      llmIndex: number;
      focus?: AnalysisFocus;
      question?: string;
      rideIds?: number[];
      rideFilter?: { excludeEmpty?: boolean };
    };
    const focus: AnalysisFocus = body.focus ?? 'review';

    // rideIds 驗證：正整數陣列、去重、上限 MAX_ANALYSIS_RIDES。
    let rideIds: number[] | undefined;
    if (body.rideIds !== undefined) {
      if (!Array.isArray(body.rideIds)) {
        return reply.code(400).send({ error: 'rideIds must be an array of positive integers' });
      }
      if (body.rideIds.some((n) => !Number.isInteger(n) || n <= 0)) {
        return reply.code(400).send({ error: 'rideIds must all be positive integers' });
      }
      const deduped = [...new Set(body.rideIds)];
      if (deduped.length > MAX_ANALYSIS_RIDES) {
        return reply.code(400).send({ error: `最多只能指定 ${MAX_ANALYSIS_RIDES} 筆騎乘` });
      }
      if (deduped.length > 0) rideIds = deduped;
    }

    const config = configStore.get();
    // provider 現在存在 SQLite；llmIndex 對應 sort_order 排序後的 index。
    const provider = db.listLlmProviders()[body.llmIndex];
    if (!provider) {
      return reply.code(400).send({ error: `LLM provider at index ${body.llmIndex} not configured` });
    }

    // rideFilter 傳入 ToolContext，tool 層據此強制套用過濾（見 tools.ts）。
    const rideFilter = body.rideFilter?.excludeEmpty
      ? { excludeEmpty: true }
      : undefined;
    const ctx: ToolContext = { db, config, rideFilter, routeStore };
    const tools = buildToolRegistry(ctx); // 不含 submit_plan
    const userPrompt = buildAnalysisUserPrompt(focus, body.question, rideIds);

    // ── SSE 串流 ──
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      // close 不能 keep-alive:同 plan-api——SSE 結束後這條 socket 不能被
      // proxy 重用,否則下一個請求(分析後的 fetchReports)會踩 HPE 400。
      Connection: 'close',
      'X-Accel-Buffering': 'no',
    });

    // 攔截 phase:'final'：先剝掉整段圍欄再送，確保「串流內容」與「存檔內容」一致。
    let finalContent = '';
    const send = (e: AgentEvent) => {
      let frame: string;
      if (e.phase === 'final') {
        finalContent = stripOuterFence(e.message ?? '');
        frame = formatSseFrame({ phase: 'final', message: finalContent });
      } else {
        frame = formatSseFrame(e);
      }
      // debug:逐幀 log(reasoning 幀量大,略過),供比對前端 [agent-stream]。
      if (e.phase !== 'reasoning') {
        console.log(`[analysis-api][sse] → ${e.phase} (${Buffer.byteLength(frame)} bytes)`);
      }
      raw.write(frame);
    };
    const throttle = createReasoningThrottle((delta) => send({ phase: 'reasoning', delta }));

    try {
      console.log(`[analysis-api] Generating analysis (focus=${focus}) via ${provider.name}...`);
      const result = await runAgent({
        provider,
        system: buildAnalysisSystemPrompt(),
        initialUser: userPrompt,
        tools,
        ctx,
        // 分析無終局 tool：模型停止呼叫工具即以 phase:'final' 收尾。
        onEvent: send,
        onReasoning: throttle.push,
      });
      throttle.flush();

      // 落庫：以攔截到的 final 為主，退而用 result.finalText（同樣剝圍欄）。
      const content = finalContent || stripOuterFence(result.finalText ?? '');
      if (content.trim().length > 0) {
        const reportId = db.createAnalysisReport({
          focus,
          question: focus === 'custom' ? body.question : undefined,
          content,
          providerName: provider.name,
          providerModel: provider.model,
          rideIds,
        });
        // 補送 result 幀，讓前端拿到剛存的報告 id（useAgentStream 會 parse）。
        send({ phase: 'result', data: { reportId } });
      }
    } catch (err) {
      throttle.flush();
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[analysis-api] analysis failed:`, message);
      send({ phase: 'error', message: `訓練分析失敗：${message}` });
    } finally {
      raw.end();
      console.log('[analysis-api][sse] stream closed');
    }
  });

  // ── 歷史報告 ──

  /** 列出所有分析報告摘要（不含 content）。 */
  fastify.get('/api/analysis/reports', async () => {
    return { reports: db.listAnalysisReports() };
  });

  /** 取單一分析報告（含 content）。 */
  fastify.get<{ Params: { id: string } }>('/api/analysis/reports/:id', async (req, reply) => {
    const report = db.getAnalysisReport(Number(req.params.id));
    if (!report) return reply.code(404).send({ error: 'Report not found' });
    return report;
  });

  /** 刪除一份分析報告。 */
  fastify.delete<{ Params: { id: string } }>('/api/analysis/reports/:id', async (req, reply) => {
    const deleted = db.deleteAnalysisReport(Number(req.params.id));
    if (!deleted) return reply.code(404).send({ error: 'Report not found' });
    return { ok: true };
  });
}
