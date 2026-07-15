/**
 * Provider adapter — 把統一的 AgentMessage / AgentTool 轉成各家 wire
 * format 並送出一輪請求，回傳統一的 AgentTurn。
 *
 * 支援兩種格式：
 * - Anthropic（tool_use / tool_result block；多個 tool_result 必須合併進
 *   同一則 user 訊息，且緊接對應 tool_use 的下一則，否則 400）。
 * - OpenAI-compatible（tool_calls；arguments 是字串化 JSON，需 JSON.parse；
 *   每個 tool 結果各一則 role:'tool' 訊息）。DeepSeek 目前走非串流路徑，
 *   串流 tool_calls 分片拼接留待 P6。
 */

import type { LlmProvider } from '@littlecycling/shared';
import {
  isAnthropicProvider,
  isDeepSeekProvider,
  streamChatCompletionRaw,
  type StreamState,
} from '../llm-client.js';
import type { AgentMessage, AgentTool, AgentToolCall, AgentTurn } from './types.js';

const DEFAULT_MAX_TOKENS = 16384;

/** 單輪送出的 override 選項（訊息變體要調 temperature / maxTokens）。 */
export interface SendOpts {
  temperature?: number;
  maxTokens?: number;
}

export interface ProviderAdapter {
  /**
   * 送一輪請求，回傳統一結果。
   * onReasoning 供 DeepSeek CoT 節流轉發（P1 非串流時不會被呼叫）。
   */
  send(
    provider: LlmProvider,
    system: string,
    messages: AgentMessage[],
    tools: AgentTool[],
    opts?: SendOpts,
    onReasoning?: (delta: string) => void,
  ): Promise<AgentTurn>;
}

/** 依 provider 名稱挑選對應 adapter。 */
export function pickAdapter(provider: LlmProvider): ProviderAdapter {
  return isAnthropicProvider(provider) ? anthropicAdapter : openAiAdapter;
}

// ── Anthropic adapter ──

export const anthropicAdapter: ProviderAdapter = {
  async send(provider, system, messages, tools, opts) {
    const url = `${provider.endpoint.replace(/\/+$/, '')}/messages`;
    const body: Record<string, unknown> = {
      model: provider.model,
      max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      system,
      messages: toAnthropicMessages(messages),
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    // 刻意不送 temperature/top_p/top_k：新版 Claude model（Opus 4.7/4.8、
    // Sonnet 5、Fable 5）已移除 sampling 參數，傳了會直接回 400；風格改由
    // prompt 控制。OpenAI-compatible 路徑不受此限（見下方 openAiAdapter）。

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': provider.key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`LLM API error ${res.status}: ${errBody.slice(0, 500)}`);
    }
    const data = await res.json();
    return parseAnthropicResponse(data);
  },
};

/** AgentMessage[] → Anthropic messages（合併連續 tool 結果進單一 user 訊息）。 */
export function toAnthropicMessages(messages: AgentMessage[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length > 0) {
        const content: unknown[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
        }
        out.push({ role: 'assistant', content });
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
    } else {
      // tool：把連續的 tool 結果合併成一則 user 訊息
      const content: unknown[] = [];
      let j = i;
      while (j < messages.length && messages[j].role === 'tool') {
        const t = messages[j] as Extract<AgentMessage, { role: 'tool' }>;
        content.push({
          type: 'tool_result',
          tool_use_id: t.toolCallId,
          content: t.content,
          is_error: t.isError ?? false,
        });
        j++;
      }
      out.push({ role: 'user', content });
      i = j - 1;
    }
  }
  return out;
}

/** 解析 Anthropic /messages 回應為 AgentTurn。 */
export function parseAnthropicResponse(data: unknown): AgentTurn {
  const d = data as {
    content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    stop_reason?: string;
    stop_details?: unknown;
  };

  // 新版 Claude 可能以 HTTP 200 回 stop_reason:"refusal"（安全機制拒絕，content
  // 可能為空）。此時 throw 明確錯誤，交由 route 層以 phase:'error' 透出前端。
  if (d.stop_reason === 'refusal') {
    const detail = d.stop_details ? `（${JSON.stringify(d.stop_details).slice(0, 200)}）` : '';
    throw new Error(`Claude 安全機制拒絕了此請求${detail}`);
  }

  const blocks = d.content ?? [];
  let text = '';
  const toolCalls: AgentToolCall[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text) {
      text += b.text;
    } else if (b.type === 'tool_use' && b.id && b.name) {
      toolCalls.push({ id: b.id, name: b.name, input: (b.input as Record<string, unknown>) ?? {} });
    }
  }
  return { text, toolCalls, stopReason: mapAnthropicStop(d.stop_reason, toolCalls.length) };
}

function mapAnthropicStop(reason: string | undefined, toolCallCount: number): AgentTurn['stopReason'] {
  if (reason === 'tool_use' || toolCallCount > 0) return 'tool_use';
  if (reason === 'max_tokens') return 'length';
  return 'end';
}

// ── OpenAI-compatible adapter ──

export const openAiAdapter: ProviderAdapter = {
  async send(provider, system, messages, tools, opts, onReasoning) {
    const url = `${provider.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.key}`,
    };
    const body: Record<string, unknown> = {
      model: provider.model,
      max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: toOpenAiMessages(system, messages),
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;

    // DeepSeek：thinking + stream 並存，避免長思考期間非串流 timeout。串流中
    // 除了累積 content / reasoning_content（轉發 onReasoning），也依 tool_calls
    // 的 index 分片拼接（見 llm-client applySseData / streamStateToTurn）。
    // 部分端點在 thinking 模式下不支援 tools——會回 HTTP 400，
    // streamChatCompletionRaw throw 的訊息已帶 response body 摘要。
    if (isDeepSeekProvider(provider)) {
      body.thinking = { type: 'enabled' };
      const state = await streamChatCompletionRaw(url, headers, body, onReasoning);
      return streamStateToTurn(state);
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`LLM API error ${res.status}: ${errBody.slice(0, 500)}`);
    }
    const data = await res.json();
    return parseOpenAiResponse(data);
  },
};

/**
 * 把 DeepSeek 串流累積狀態（StreamState）收斂為 AgentTurn。
 * 對每個拼接完成的 tool call：過濾缺 id/name 的空洞，並對 arguments 做
 * JSON.parse（try/catch）；parse 失敗回退空物件，交由 agent-loop 的 schema
 * 驗證回填成 tool 執行錯誤，讓 LLM 自行修正（與非串流 parseOpenAiResponse 一致）。
 */
export function streamStateToTurn(state: StreamState): AgentTurn {
  const toolCalls: AgentToolCall[] = [];
  for (const slot of state.toolCalls) {
    if (!slot || !slot.id || !slot.name) continue;
    let input: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(slot.arguments || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      input = {};
    }
    toolCalls.push({ id: slot.id, name: slot.name, input });
  }
  return {
    text: state.content,
    toolCalls,
    stopReason: mapOpenAiStop(state.finishReason ?? undefined, toolCalls.length),
    // thinking 模式的 CoT；帶進 turn 以便多輪回帶 reasoning_content（DeepSeek 必需）。
    reasoning: state.reasoning || undefined,
  };
}

/** AgentMessage[] → OpenAI chat messages（system 前置，每個 tool 結果各一則）。 */
export function toOpenAiMessages(system: string, messages: AgentMessage[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length > 0) {
        const asst: Record<string, unknown> = {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        };
        // DeepSeek thinking 模式：帶 tool call 的 assistant 訊息後續請求必須完整
        // 回帶 reasoning_content，否則多輪 tool calling 出錯。其他 OpenAI-compatible
        // 端點會忽略此未知欄位，帶著無害。
        if (m.reasoning) asst.reasoning_content = m.reasoning;
        out.push(asst);
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

/** 解析 OpenAI-compatible chat/completions 回應為 AgentTurn。 */
export function parseOpenAiResponse(data: unknown): AgentTurn {
  const d = data as {
    choices?: {
      message?: {
        content?: string | null;
        // DeepSeek thinking 模式非串流回應的 CoT 欄位。
        reasoning_content?: string | null;
        tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
      };
      finish_reason?: string;
    }[];
  };
  const choice = d.choices?.[0];
  const msg = choice?.message;
  const text = msg?.content ?? '';
  const toolCalls: AgentToolCall[] = [];
  for (const tc of msg?.tool_calls ?? []) {
    if (!tc.id || !tc.function?.name) continue;
    let input: Record<string, unknown> = {};
    // arguments 是字串化 JSON；壞掉時給空物件，交由 schema 驗證回填 error。
    try {
      const parsed = JSON.parse(tc.function.arguments || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      input = {};
    }
    toolCalls.push({ id: tc.id, name: tc.function.name, input });
  }
  return {
    text,
    toolCalls,
    stopReason: mapOpenAiStop(choice?.finish_reason, toolCalls.length),
    // thinking 模式的 CoT；帶進 turn 以便多輪回帶 reasoning_content（DeepSeek 必需）。
    reasoning: msg?.reasoning_content || undefined,
  };
}

function mapOpenAiStop(reason: string | undefined, toolCallCount: number): AgentTurn['stopReason'] {
  if (reason === 'tool_calls' || toolCallCount > 0) return 'tool_use';
  if (reason === 'length') return 'length';
  return 'end';
}
