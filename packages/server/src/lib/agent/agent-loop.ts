/**
 * Agentic tool-use 主迴圈。
 *
 * runAgent：反覆「送一輪 → 若要求 tool 就執行並回填結果 → 再送」，直到
 * provider 給出終局（無 tool call）、某個終局 tool 成功、或達 maxIterations。
 * 所有 tool 錯誤（執行丟例外、未知 tool、參數不合 schema）都回填成 tool
 * 訊息（isError）讓 LLM 自行修正，不 throw。
 */

import type { LlmProvider } from '@littlecycling/shared';
import type { AgentEvent, AgentMessage, AgentTool, AgentToolCall, ToolContext } from './types.js';
import { pickAdapter, type ProviderAdapter, type SendOpts } from './provider-adapter.js';
import { validateSchema } from './schema-validate.js';

export interface RunAgentOpts {
  provider: LlmProvider;
  system: string;
  initialUser: string;
  tools: AgentTool[];
  ctx: ToolContext;
  maxIterations?: number;              // 預設 8
  onEvent: (e: AgentEvent) => void;
  /** 可注入自訂 adapter（測試用 mock）；預設依 provider 挑選。 */
  adapter?: ProviderAdapter;
  /** 這些 tool 成功執行（結果非 {ok:false}）即視為終局，發 result 事件並結束。 */
  finalToolNames?: string[];
  /** 送出時的 override（temperature / maxTokens）。 */
  sendOpts?: SendOpts;
  /** DeepSeek CoT 節流轉發。 */
  onReasoning?: (delta: string) => void;
}

export interface RunAgentResult {
  finalText: string;
  messages: AgentMessage[];
  /** 終局 tool（如 submit_plan）成功時的結果 payload。 */
  result?: unknown;
}

const FORCE_FINAL_PROMPT =
  '已達查詢上限，請根據現有資訊直接輸出最終結果，勿再呼叫任何工具。';

export async function runAgent(opts: RunAgentOpts): Promise<RunAgentResult> {
  const {
    provider, system, initialUser, tools, ctx, onEvent,
    adapter = pickAdapter(provider),
    maxIterations = 8,
    finalToolNames = [],
    sendOpts,
    onReasoning,
  } = opts;

  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const finalSet = new Set(finalToolNames);
  const messages: AgentMessage[] = [{ role: 'user', content: initialUser }];

  onEvent({ phase: 'start', message: '開始規劃…' });

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    onEvent({ phase: 'thinking', iteration });

    const turn = await adapter.send(provider, system, messages, tools, sendOpts, onReasoning);

    // 無 tool call → 終局
    if (turn.toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: turn.text });
      onEvent({ phase: 'final', message: turn.text });
      return { finalText: turn.text, messages };
    }

    // 有 tool call → 記錄 assistant 回合，逐一執行。
    // reasoning 一併存下：thinking 模式（DeepSeek V4）多輪回帶時必需。
    messages.push({
      role: 'assistant',
      content: turn.text,
      toolCalls: turn.toolCalls,
      reasoning: turn.reasoning,
    });

    let finalResult: unknown;
    let finished = false;

    for (const call of turn.toolCalls) {
      onEvent({ phase: 'tool_call', iteration, toolName: call.name, args: call.input });
      const { content, isError, raw } = await executeCall(call, toolMap, ctx);
      messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content, isError });
      onEvent({
        phase: 'tool_result',
        iteration,
        toolName: call.name,
        ok: !isError,
        summary: summarise(content),
      });

      // 終局 tool 成功 → 準備結束
      if (!isError && finalSet.has(call.name) && !isFalseOk(raw)) {
        finalResult = raw;
        finished = true;
      }
    }

    if (finished) {
      onEvent({ phase: 'result', data: finalResult });
      return { finalText: '', messages, result: finalResult };
    }
  }

  // 達上限仍未終局 → 補強制終局訊息，再送最後一輪
  messages.push({ role: 'user', content: FORCE_FINAL_PROMPT });
  onEvent({ phase: 'thinking', iteration: maxIterations + 1 });
  const lastTurn = await adapter.send(provider, system, messages, tools, sendOpts, onReasoning);
  messages.push({
    role: 'assistant',
    content: lastTurn.text,
    toolCalls: lastTurn.toolCalls,
    reasoning: lastTurn.reasoning,
  });

  if (lastTurn.toolCalls.length > 0) {
    onEvent({ phase: 'error', message: '已達查詢上限，模型仍要求呼叫工具，已終止。' });
    return { finalText: lastTurn.text, messages };
  }

  onEvent({ phase: 'final', message: lastTurn.text });
  return { finalText: lastTurn.text, messages };
}

/** 執行單一 tool call：驗參數 → 執行 → 回填字串內容與 isError。 */
async function executeCall(
  call: AgentToolCall,
  toolMap: Map<string, AgentTool>,
  ctx: ToolContext,
): Promise<{ content: string; isError: boolean; raw: unknown }> {
  const tool = toolMap.get(call.name);
  if (!tool) {
    return {
      content: JSON.stringify({ error: `未知的工具名稱 "${call.name}"` }),
      isError: true,
      raw: undefined,
    };
  }

  const validation = validateSchema(call.input, tool.parameters);
  if (!validation.valid) {
    return {
      content: JSON.stringify({ error: `參數不符 schema：${validation.errors.join('；')}` }),
      isError: true,
      raw: undefined,
    };
  }

  try {
    const raw = await tool.execute(call.input, ctx);
    return { content: JSON.stringify(raw), isError: false, raw };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: JSON.stringify({ error: msg }), isError: true, raw: undefined };
  }
}

function isFalseOk(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as { ok?: unknown }).ok === false;
}

function summarise(content: string): string {
  return content.length > 120 ? `${content.slice(0, 120)}…` : content;
}

/**
 * 單輪對話（無 tools），給訊息變體等純生成場景用。
 * = runAgent with tools=[]、maxIterations=1，但直接回傳文字。
 */
export async function singleTurn(
  provider: LlmProvider,
  system: string,
  user: string,
  opts?: SendOpts,
  onReasoning?: (delta: string) => void,
  adapter: ProviderAdapter = pickAdapter(provider),
): Promise<string> {
  const messages: AgentMessage[] = [{ role: 'user', content: user }];
  const turn = await adapter.send(provider, system, messages, [], opts, onReasoning);
  return turn.text;
}
