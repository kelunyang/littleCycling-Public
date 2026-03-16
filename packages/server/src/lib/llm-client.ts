/**
 * LLM API client for training plan generation.
 * Supports OpenAI-compatible APIs and Anthropic Claude API.
 */

import type { LlmProvider } from '@littlecycling/shared';

/**
 * Detect API format from provider name.
 * Names containing "claude" or "anthropic" use Anthropic format;
 * everything else uses OpenAI-compatible format.
 */
function isAnthropicProvider(provider: LlmProvider): boolean {
  const lower = provider.name.toLowerCase();
  return lower.includes('claude') || lower.includes('anthropic');
}

/**
 * Call an LLM API with the given prompt and return the raw text response.
 * Throws on network errors or non-200 responses.
 */
export async function callLlm(provider: LlmProvider, prompt: string): Promise<string> {
  if (isAnthropicProvider(provider)) {
    return callAnthropic(provider, prompt);
  }
  return callOpenAICompatible(provider, prompt);
}

async function callOpenAICompatible(provider: LlmProvider, prompt: string): Promise<string> {
  const url = `${provider.endpoint.replace(/\/+$/, '')}/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.key}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 16384,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM API error ${res.status}: ${body.slice(0, 500)}`);
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
