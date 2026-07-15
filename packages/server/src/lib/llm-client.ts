/**
 * LLM API client for training plan generation.
 * Supports OpenAI-compatible APIs and Anthropic Claude API.
 * DeepSeek runs in its native reasoning (thinking) mode over a streamed
 * connection — see callOpenAICompatible / streamChatCompletion below.
 */

import type { LlmProvider } from '@littlecycling/shared';

/**
 * Detect API format from provider name.
 * Names containing "claude" or "anthropic" use Anthropic format;
 * everything else uses OpenAI-compatible format.
 */
export function isAnthropicProvider(provider: LlmProvider): boolean {
  const lower = provider.name.toLowerCase();
  return lower.includes('claude') || lower.includes('anthropic');
}

/** DeepSeek: use its native reasoning mode over a streamed connection. */
export function isDeepSeekProvider(provider: LlmProvider): boolean {
  return provider.name.toLowerCase().includes('deepseek');
}

// ── 串流解析（純函數，方便無網路單元測試）──

/** 拼接中的單一 tool call 分片（arguments 逐片 append）。 */
export interface StreamToolCallDraft {
  id: string;
  name: string;
  arguments: string;
}

/** 串流累積狀態：content、reasoning、依 index 拼接的 tool_calls、finishReason。 */
export interface StreamState {
  content: string;
  reasoning: string;
  /** 依 tool_calls[].index 定位（可能稀疏），收尾再過濾空洞。 */
  toolCalls: StreamToolCallDraft[];
  finishReason: string | null;
}

export function createStreamState(): StreamState {
  return { content: '', reasoning: '', toolCalls: [], finishReason: null };
}

/**
 * 套用單一 SSE `data:` 幀的 JSON 內容到累積狀態（純函數）。
 *
 * `data` 已去除 "data:" 前綴且非 `[DONE]`。負責：
 * - 累積 `delta.content`；
 * - 累積 `delta.reasoning_content` 並轉發給 onReasoning（DeepSeek CoT）；
 * - 依 `delta.tool_calls[].index` 分片拼接：`id`／`function.name` 首片才有，
 *   `function.arguments` 逐片 append；
 * - 記錄 `finish_reason`。
 * 壞掉／keep-alive 幀直接忽略，不丟例外。
 */
export function applySseData(
  state: StreamState,
  data: string,
  onReasoning?: (delta: string) => void,
): void {
  let chunk: {
    choices?: {
      delta?: {
        content?: string;
        reasoning_content?: string;
        tool_calls?: {
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }[];
      };
      finish_reason?: string | null;
    }[];
  };
  try {
    chunk = JSON.parse(data);
  } catch {
    return; // 忽略壞掉 / 半截的 keep-alive 幀
  }

  const choice = chunk.choices?.[0];
  if (!choice) return;
  const delta = choice.delta;

  if (delta?.reasoning_content) {
    state.reasoning += delta.reasoning_content;
    onReasoning?.(delta.reasoning_content);
  }
  if (delta?.content) state.content += delta.content;

  if (Array.isArray(delta?.tool_calls)) {
    for (const frag of delta.tool_calls) {
      const idx = typeof frag.index === 'number' ? frag.index : 0;
      let slot = state.toolCalls[idx];
      if (!slot) {
        slot = { id: '', name: '', arguments: '' };
        state.toolCalls[idx] = slot;
      }
      if (frag.id) slot.id = frag.id;
      if (frag.function?.name) slot.name = frag.function.name;
      if (frag.function?.arguments) slot.arguments += frag.function.arguments;
    }
  }

  if (choice.finish_reason) state.finishReason = choice.finish_reason;
}

/**
 * 給定完整 SSE 文字（多個 `data:` 行）逐行套用，回傳最終累積狀態。
 * 純函數、無 I/O，供單元測試模擬 chunk 序列（含 tool_calls 分片交錯）。
 */
export function parseSseStream(
  sseText: string,
  onReasoning?: (delta: string) => void,
): StreamState {
  const state = createStreamState();
  for (const rawLine of sseText.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '' || data === '[DONE]') continue;
    applySseData(state, data, onReasoning);
  }
  return state;
}

/**
 * Stream an OpenAI-compatible chat completion (SSE) and accumulate full state.
 *
 * DeepSeek's reasoning mode emits its chain-of-thought as
 * `delta.reasoning_content` *before* any answer tokens — we forward those
 * deltas to `onReasoning` and keep reading the socket throughout the long
 * silent thinking phase, which prevents the non-streaming timeout DeepSeek is
 * prone to. Tool calls arrive fragmented across chunks and are reassembled by
 * `applySseData` (see StreamState).
 */
export async function streamChatCompletionRaw(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  onReasoning?: (delta: string) => void,
): Promise<StreamState> {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, stream: true }),
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM API error ${res.status}: ${text.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const state = createStreamState();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are newline-delimited; each `data:` line carries one JSON chunk.
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '' || data === '[DONE]') continue;
      applySseData(state, data, onReasoning);
    }
  }

  // 處理無換行結尾的尾端殘留幀。
  const tail = buffer.trim();
  if (tail.startsWith('data:')) {
    const data = tail.slice(5).trim();
    if (data && data !== '[DONE]') applySseData(state, data, onReasoning);
  }

  return state;
}

/**
 * Stream an OpenAI-compatible chat completion and return just the final
 * assistant `content`（薄包裝，供不需要 tool_calls 的舊路徑沿用）。
 */
export async function streamChatCompletion(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  onReasoning?: (delta: string) => void,
): Promise<string> {
  const state = await streamChatCompletionRaw(url, headers, body, onReasoning);
  return state.content;
}

/**
 * Call an LLM API with the given prompt and return the raw text response.
 * Throws on network errors or non-200 responses.
 *
 * @deprecated 新程式碼請走 agent 模組的統一路徑（runAgent / singleTurn →
 * provider-adapter）。此函數（連同 callAnthropic / callOpenAICompatible）僅
 * 保留給課表生成的 `?legacy=1` / `?stream=0` fallback 舊路徑使用。
 */
export async function callLlm(provider: LlmProvider, prompt: string): Promise<string> {
  if (isAnthropicProvider(provider)) {
    return callAnthropic(provider, prompt);
  }
  return callOpenAICompatible(provider, prompt);
}

async function callOpenAICompatible(provider: LlmProvider, prompt: string): Promise<string> {
  const url = `${provider.endpoint.replace(/\/+$/, '')}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.key}`,
  };
  const body: Record<string, unknown> = {
    model: provider.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 16384,
  };

  // DeepSeek native reasoning: enable thinking + stream, so we keep receiving
  // the chain-of-thought (relayed to stdout) instead of blocking on one slow
  // non-streaming response. temperature is ignored while thinking is on.
  if (isDeepSeekProvider(provider)) {
    body.thinking = { type: 'enabled' };
    const content = await streamChatCompletion(url, headers, body, (r) => process.stdout.write(r));
    return content;
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

  const data = await res.json() as {
    choices: { message: { content: string } }[];
  };

  return data.choices[0]?.message?.content ?? '';
}

async function callAnthropic(provider: LlmProvider, prompt: string): Promise<string> {
  const url = `${provider.endpoint.replace(/\/+$/, '')}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 16384,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = await res.json() as {
    content: { type: string; text: string }[];
  };

  const textBlock = data.content.find((b) => b.type === 'text');
  return textBlock?.text ?? '';
}

/**
 * Extract JSON from LLM response text.
 * Handles cases where the LLM wraps JSON in markdown code blocks.
 */
export function extractJson(text: string): string {
  // Try to extract from markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0].trim();

  return text.trim();
}
