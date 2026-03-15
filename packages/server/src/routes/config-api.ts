/**
 * Config API — Fastify plugin for reading/writing app config.
 */

import type { FastifyInstance } from 'fastify';
import type { ConfigStore } from '../lib/config-store.js';

export default async function configApi(fastify: FastifyInstance, opts: { configStore: ConfigStore }): Promise<void> {
  const { configStore } = opts;

  /** Read current config. */
  fastify.get('/api/config', async () => {
    return configStore.get();
  });

  /** Partial update config (deep merge). */
  fastify.patch('/api/config', async (req) => {
    const partial = req.body as Record<string, unknown>;
    return configStore.save(partial);
  });
}
