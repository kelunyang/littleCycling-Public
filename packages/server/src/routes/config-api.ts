/**
 * Config API — Fastify plugin for reading/writing app config.
 */

import type { FastifyInstance } from 'fastify';
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
    // LLM providers live in SQLite now (see /api/llm-providers); drop any `llm`
    // a client echoes back so it can never be re-persisted into config.json.
    delete partial.llm;
    configStore.save(partial);
    // Refresh first-run missing-settings tracking: any required field this PATCH
    // provided is now filled; once none remain, setupCompleted is flagged.
    configStore.markPatched(partial);
    // Return the redacted view so the client's copy also never holds keys and
    // picks up the refreshed missingSettings (drives the settings-drawer prompt).
    return configStore.getRedacted();
  });
}
