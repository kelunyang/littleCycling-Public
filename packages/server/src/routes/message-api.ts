/**
 * Message variants REST API — CRUD for LLM-generated message templates.
 */

import type { FastifyInstance } from 'fastify';
import type { RideDatabase } from '../lib/database.js';

export default async function messageApi(
  fastify: FastifyInstance,
  opts: { db: RideDatabase },
): Promise<void> {
  const { db } = opts;

  /** Get variant counts for all types. */
  fastify.get('/api/messages/variants', async () => {
    return { counts: db.getVariantCounts() };
  });

  /** Get all variants for a specific type. */
  fastify.get<{
    Params: { typeId: string };
  }>('/api/messages/variants/:typeId', async (req) => {
    return { variants: db.getVariants(req.params.typeId) };
  });

  /** Batch upsert variants for a type. */
  fastify.put<{
    Params: { typeId: string };
    Body: { templates: string[] };
  }>('/api/messages/variants/:typeId', async (req, reply) => {
    const { templates } = req.body as { templates: string[] };
    if (!Array.isArray(templates) || templates.length === 0) {
      return reply.status(400).send({ error: 'templates must be a non-empty array' });
    }
    db.upsertMessageVariants(req.params.typeId, templates);
    return { ok: true, count: templates.length };
  });

  /** Delete all variants for a type. */
  fastify.delete<{
    Params: { typeId: string };
  }>('/api/messages/variants/:typeId', async (req) => {
    const deleted = db.deleteVariants(req.params.typeId);
    return { ok: true, deleted };
  });

  /** Get one random variant for a type. */
  fastify.get<{
    Params: { typeId: string };
  }>('/api/messages/random/:typeId', async (req) => {
    const template = db.getRandomVariant(req.params.typeId);
    return { template };
  });

  /** Batch: get one random variant per type (for game preload). */
  fastify.get('/api/messages/batch-random', async () => {
    return { variants: db.getBatchRandomVariants() };
  });
}
