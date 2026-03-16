/**
 * LLM service — calls OpenAI-compatible chat completion endpoints.
 * Uses Node.js native fetch (no extra dependencies).
 */

import type { LlmProvider } from '@littlecycling/shared';
import { GAME_MESSAGE_TYPES, type GameMessageType } from '@littlecycling/shared';

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
   * Send a chat completion request to an OpenAI-compatible endpoint.
   * Returns the assistant's text content.
   */
  async chatCompletion(
    provider: LlmProvider,
    messages: { role: string; content: string }[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<string> {
    // Normalize endpoint: strip trailing slash
    const base = provider.endpoint.replace(/\/+$/, '');
    const url = `${base}/chat/completions`;

    // Build request body
    const body: Record<string, unknown> = {
      model: provider.model,
      messages,
      temperature: options?.temperature ?? 0.9,
      max_tokens: options?.maxTokens ?? 2048,
    };

    // DeepSeek thinking mode: add non-standard parameter
    if (provider.name.toLowerCase().includes('deepseek')) {
      body.thinking = { type: 'enabled' };
      // When thinking is enabled, temperature/top_p are ignored by DeepSeek
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.key}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `LLM API error: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
      );
    }

    const data = await res.json() as {
      choices: { message: { content: string; reasoning_content?: string } }[];
    };

    const content = data.choices?.[0]?.message?.content;
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
function parseVariants(raw: string, msgType: GameMessageType): string[] {
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
