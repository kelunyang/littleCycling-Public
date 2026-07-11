/**
 * Config API — Fastify plugin for reading/writing app config.
 */

import type { FastifyInstance } from 'fastify';
import type { LlmProvider } from '@littlecycling/shared';
import type { ConfigStore } from '../lib/config-store.js';

export default async function configApi(fastify: FastifyInstance, opts: { configStore: ConfigStore }): Promise<void> {
  const { configStore } = opts;

  /** Read current config — LLM keys are redacted (write-only, never read back). */
  fastify.get('/api/config', async () => {
    return configStore.getRedacted();
  });

  /** Partial update config (deep merge). */
  fastify.patch('/api/config', async (req) => {
    const partial = req.body as Record<string, unknown>;
    // Blank keys in an incoming llm array mean "unchanged" — preserve the
    // stored key (matched by id) so a redacted read-back can't wipe secrets.
    if (Array.isArray(partial.llm)) {
      partial.llm = configStore.reconcileLlmKeys(partial.llm as LlmProvider[]);
    }
    configStore.save(partial);
    // Return the redacted view so the client's copy also never holds keys.
    return configStore.getRedacted();
  });
}
