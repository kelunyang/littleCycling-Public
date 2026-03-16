/**
 * LLM generation REST API — trigger variant generation for game messages.
 */

import type { FastifyInstance } from 'fastify';
import type { RideDatabase } from '../lib/database.js';
import type { ConfigStore } from '../lib/config-store.js';
import { GAME_MESSAGE_TYPES } from '@littlecycling/shared';
import { LlmService } from '../lib/llm-service.js';

const DELAY_BETWEEN_TYPES_MS = 500;

export default async function llmApi(
  fastify: FastifyInstance,
  opts: { db: RideDatabase; configStore: ConfigStore },
): Promise<void> {
  const { db, configStore } = opts;
  const llm = new LlmService();

  /** Get first enabled LLM provider from config. */
  function getProvider() {
    const config = configStore.get();
    return config.llm.find((p) => p.enabled);
  }

  /** Generate variants for a single message type. */
  fastify.post<{
    Params: { typeId: string };
    Body: { count?: number; stylePrompt?: string };
  }>('/api/messages/generate/:typeId', async (req, reply) => {
    const provider = getProvider();
    if (!provider) {
      return reply.status(400).send({ error: 'No enabled LLM provider configured' });
    }

    const { typeId } = req.params;
    if (!GAME_MESSAGE_TYPES[typeId]) {
      return reply.status(404).send({ error: `Unknown message type: ${typeId}` });
    }

    const body = req.body as { count?: number; stylePrompt?: string };
    const count = body?.count ?? 5;
    const stylePrompt = body?.stylePrompt;

    try {
      const result = await llm.generateVariants(provider, typeId, count, stylePrompt);
      if (result.variants.length > 0) {
        db.upsertMessageVariants(typeId, result.variants);
      }
      return {
        ok: true,
        typeId,
        generated: result.variants.length,
        variants: result.variants,
        provider: result.provider,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: message });
    }
  });

  /** Generate variants for ALL message types (sequential to avoid rate limits). */
  fastify.post<{
    Body: { count?: number; stylePrompt?: string };
  }>('/api/messages/generate-all', async (req, reply) => {
    const provider = getProvider();
    if (!provider) {
      return reply.status(400).send({ error: 'No enabled LLM provider configured' });
    }

    const body = req.body as { count?: number; stylePrompt?: string };
    const count = body?.count ?? 5;
    const stylePrompt = body?.stylePrompt;
    const typeIds = Object.keys(GAME_MESSAGE_TYPES);
    const results: Array<{ typeId: string; generated: number; error?: string }> = [];

    for (let i = 0; i < typeIds.length; i++) {
      const typeId = typeIds[i];
      try {
        const result = await llm.generateVariants(provider, typeId, count, stylePrompt);
        if (result.variants.length > 0) {
          db.upsertMessageVariants(typeId, result.variants);
        }
        results.push({ typeId, generated: result.variants.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ typeId, generated: 0, error: message });
      }

      // Delay between calls to avoid rate limiting (skip after last)
      if (i < typeIds.length - 1) {
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_TYPES_MS));
      }
    }

    return { ok: true, results, provider: provider.name };
  });
}
