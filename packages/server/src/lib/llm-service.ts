/**
 * LLM service — calls OpenAI-compatible chat completion endpoints.
 * Uses Node.js native fetch (no extra dependencies).
 */

import type { LlmProvider } from '@littlecycling/shared';
import { GAME_MESSAGE_TYPES, type GameMessageType } from '@littlecycling/shared';
import { isDeepSeekProvider } from './llm-client.js';
import { singleTurn } from './agent/agent-loop.js';

// ── Types ──

export interface LlmGenerateResult {
  typeId: string;
  variants: string[];
  provider: string;
}

// ── System prompt for message variant generation ──

function buildSystemPrompt(stylePrompt?: string): string {
  const style = stylePrompt?.trim()
    ? `4. 風格要求：${stylePrompt.trim()}`
    : '4. 風格可以活潑、鼓勵、幽默，但不要太誇張';

  return `你是一個自行車訓練遊戲的文案助手。你的任務是為遊戲內的即時訊息產生多種創意變體。

規則：
1. 輸出必須是 JSON string array，不要加任何額外文字或 markdown
2. 保留所有 {placeholder} 佔位符，原封不動（例如 {zone}、{amount}）
3. 使用繁體中文
${style}
5. 訊息要簡短（15 字以內）、有趣、有騎車主題的感覺
6. 每個變體都要不同，不要重複`;
}

// ── Core service ──

export class LlmService {
  /**
   * 送一輪 chat completion（無 tools），回傳助手文字內容。
   *
   * 底層改走 agent 模組的統一路徑（singleTurn → provider adapter），因此
   * 除了 OpenAI-compatible / DeepSeek 外，也一併支援 Anthropic provider。
   * 訊息變體不需要 tools，故用 singleTurn；temperature / max_tokens 透過
   * SendOpts 傳入（預設 0.9 / 2048，維持原本文案生成的語氣多樣性）。
   */
  async chatCompletion(
    provider: LlmProvider,
    messages: { role: string; content: string }[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<string> {
    // 把訊息拆成 system（合併所有 system）與 user（合併其餘）。
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const user = messages
      .filter((m) => m.role !== 'system')
      .map((m) => m.content)
      .join('\n\n');

    // DeepSeek 思考鏈仍轉發到 stdout，維持長思考期間的連線保活與可觀測性。
    const onReasoning = isDeepSeekProvider(provider)
      ? (r: string) => process.stdout.write(r)
      : undefined;

    const content = await singleTurn(
      provider,
      system,
      user,
      {
        temperature: options?.temperature ?? 0.9,
        maxTokens: options?.maxTokens ?? 2048,
      },
      onReasoning,
    );

    if (!content) {
      throw new Error('LLM returned empty content');
    }
    return content;
  }

  /**
   * Generate N creative variants for a game message type.
   * Returns validated template strings preserving {placeholder} syntax.
   */
  async generateVariants(
    provider: LlmProvider,
    typeId: string,
    count: number = 5,
    stylePrompt?: string,
  ): Promise<LlmGenerateResult> {
    const msgType = GAME_MESSAGE_TYPES[typeId];
    if (!msgType) throw new Error(`Unknown message type: ${typeId}`);

    const prompt = buildPrompt(msgType, count);
    const raw = await this.chatCompletion(
      provider,
      [
        { role: 'system', content: buildSystemPrompt(stylePrompt) },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.9 },
    );

    const variants = parseVariants(raw, msgType);
    return { typeId, variants, provider: provider.name };
  }
}

// ── Helpers ──

function buildPrompt(msgType: GameMessageType, count: number): string {
  const lines = [
    `訊息類型: "${msgType.id}"`,
    `預設模板: "${msgType.baseTemplate}"`,
  ];
  if (msgType.placeholders.length > 0) {
    lines.push(
      `必須保留的佔位符: ${msgType.placeholders.map((p) => `{${p}}`).join(', ')}`,
    );
  }
  lines.push(`請產生 ${count} 個創意變體。只輸出 JSON string array。`);
  return lines.join('\n');
}

/**
 * Parse LLM response into validated variant strings.
 * Handles markdown code fences and validates placeholders.
 */
export function parseVariants(raw: string, msgType: GameMessageType): string[] {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to find a JSON array in the response
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        parsed = JSON.parse(arrayMatch[0]);
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  // Validate each variant
  return parsed.filter((item): item is string => {
    if (typeof item !== 'string' || item.trim().length === 0) return false;
    // Check all required placeholders are present
    for (const ph of msgType.placeholders) {
      if (!item.includes(`{${ph}}`)) return false;
    }
    return true;
  });
}
