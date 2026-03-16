/**
 * Training plan CRUD + LLM generation — Fastify plugin.
 */

import type { FastifyInstance } from 'fastify';
import { validatePlanInput, createPlanFromInput } from '@littlecycling/shared';
import type { PlanStore } from '../lib/plan-store.js';
import type { RideDatabase } from '../lib/database.js';
import type { ConfigStore } from '../lib/config-store.js';
import { buildDefaultUserPrompt, buildFullPrompt } from '../lib/plan-prompt.js';
import { callLlm, extractJson } from '../lib/llm-client.js';

interface PlanApiOpts {
  planStore: PlanStore;
  db: RideDatabase;
  configStore: ConfigStore;
}

export default async function planApi(fastify: FastifyInstance, opts: PlanApiOpts): Promise<void> {
  const { planStore, db, configStore } = opts;

  // ── Plan CRUD ──

  /** List all plans (summaries). */
  fastify.get('/api/plans', async () => {
    return { plans: planStore.list() };
  });

  /** Get full plan with weeks. */
  fastify.get<{ Params: { id: string } }>('/api/plans/:id', async (req, reply) => {
    const plan = planStore.get(req.params.id);
    if (!plan) return reply.code(404).send({ error: 'Plan not found' });
    return plan;
  });

  /** Create a plan from JSON body (manual import). */
  fastify.post('/api/plans', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const validation = validatePlanInput(body);
    if (!validation.valid) {
      return reply.code(400).send({ error: 'Invalid plan', details: validation.errors });
    }
    const planData = createPlanFromInput(body as any, 'manual');
    const plan = planStore.create(planData);
    return reply.code(201).send(plan);
  });

  /** Delete a plan. */
  fastify.delete<{ Params: { id: string } }>('/api/plans/:id', async (req, reply) => {
    // Also remove from active plans if active
    db.removeActivePlan(req.params.id);
    const deleted = planStore.delete(req.params.id);
    if (!deleted) return reply.code(404).send({ error: 'Plan not found' });
    return { ok: true };
  });

  // ── LLM Generation ──

  /** Generate a plan via LLM. */
  fastify.post('/api/plans/generate', async (req, reply) => {
    const body = req.body as {
      llmIndex: number;
      weeks?: number;
      sessionsPerWeek?: number;
      minutesPerSession?: number;
      goal?: string;
      notes?: string;      // special instructions for the LLM
      userPrompt?: string; // user-edited prompt (optional override)
    };

    const config = configStore.get();
    const provider = config.llm[body.llmIndex];
    if (!provider) {
      return reply.code(400).send({ error: `LLM provider at index ${body.llmIndex} not configured` });
    }

    // Build prompt
    const userPrompt = body.userPrompt ?? buildDefaultUserPrompt({
      hrMax: config.training.hrMax,
      weeks: body.weeks ?? 4,
      sessionsPerWeek: body.sessionsPerWeek ?? 3,
      minutesPerSession: body.minutesPerSession ?? 35,
      goal: body.goal ?? '減脂與體重控制',
      notes: body.notes,
    });

    const fullPrompt = buildFullPrompt(userPrompt);

    try {
      console.log(`[plan-api] Generating plan via ${provider.name}...`);
      const rawResponse = await callLlm(provider, fullPrompt);
      const jsonStr = extractJson(rawResponse);

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        return reply.code(502).send({
          error: 'LLM returned invalid JSON',
          raw: jsonStr.slice(0, 2000),
        });
      }

      const validation = validatePlanInput(parsed);
      if (!validation.valid) {
        return reply.code(502).send({
          error: 'LLM output failed validation',
          details: validation.errors,
          raw: jsonStr.slice(0, 2000),
        });
      }

      const planData = createPlanFromInput(parsed as any, 'llm');
      const plan = planStore.create(planData);
      console.log(`[plan-api] Plan "${plan.name}" created (${plan.totalDays} days)`);
      return reply.code(201).send(plan);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[plan-api] LLM generation failed:`, message);
      return reply.code(502).send({ error: `LLM call failed: ${message}` });
    }
  });

  /** Get default user prompt (for pre-filling the textarea). */
  fastify.get('/api/plans/default-prompt', async (req) => {
    const query = req.query as {
      weeks?: string;
      sessionsPerWeek?: string;
      minutesPerSession?: string;
      goal?: string;
      notes?: string;
    };
    const config = configStore.get();
    return {
      prompt: buildDefaultUserPrompt({
        hrMax: config.training.hrMax,
        weeks: parseInt(query.weeks ?? '4', 10),
        sessionsPerWeek: parseInt(query.sessionsPerWeek ?? '3', 10),
        minutesPerSession: parseInt(query.minutesPerSession ?? '35', 10),
        goal: query.goal ?? '減脂與體重控制',
        notes: query.notes,
      }),
    };
  });

  // ── Active plans ──

  /** Get all active plans. */
  fastify.get('/api/plans/active', async () => {
    return { activePlans: db.getActivePlans() };
  });

  /** Activate a plan. */
  fastify.post('/api/plans/active', async (req, reply) => {
    const { planId, startDate } = req.body as { planId: string; startDate: string };
    if (!planId || !startDate) {
      return reply.code(400).send({ error: 'planId and startDate are required' });
    }
    // Verify plan exists
    if (!planStore.get(planId)) {
      return reply.code(404).send({ error: 'Plan not found' });
    }
    db.addActivePlan(planId, startDate);
    return { ok: true };
  });

  /** Deactivate a plan. */
  fastify.delete<{ Params: { planId: string } }>('/api/plans/active/:planId', async (req, reply) => {
    const removed = db.removeActivePlan(req.params.planId);
    if (!removed) return reply.code(404).send({ error: 'Plan was not active' });
    return { ok: true };
  });

  // ── Completions ──

  /** Get completions for a plan. */
  fastify.get<{ Params: { id: string } }>('/api/plans/:id/completions', async (req) => {
    return { completions: db.getCompletions(req.params.id) };
  });

  /** Record a completion. */
  fastify.post<{ Params: { id: string } }>('/api/plans/:id/completions', async (req, reply) => {
    const { day, rideId, manual } = req.body as {
      day: number;
      rideId?: number;
      manual?: boolean;
    };
    if (typeof day !== 'number' || day < 1) {
      return reply.code(400).send({ error: 'day must be a positive integer' });
    }
    db.recordCompletion(req.params.id, day, rideId ?? null, manual ?? false);
    return { ok: true };
  });
}
