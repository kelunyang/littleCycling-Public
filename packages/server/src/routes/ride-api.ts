/**
 * Ride history REST API — list, detail, delete, ghost trace (P8), FIT export.
 */

import type { FastifyInstance } from 'fastify';
import type { GhostTraceDto } from '@littlecycling/shared';
import type { RideDatabase } from '../lib/database.js';
import { buildGhostTrace } from '../lib/ghost-trace.js';
import { exportRideToFit } from '../lib/fit-exporter.js';

export default async function rideApi(
  fastify: FastifyInstance,
  opts: { db: RideDatabase },
): Promise<void> {
  const { db } = opts;

  /** Calendar: ride counts grouped by date within a range. */
  fastify.get<{
    Querystring: { from?: string; to?: string };
  }>('/api/rides/calendar', async (req) => {
    const from = parseInt(req.query.from ?? '0', 10) || 0;
    const to = parseInt(req.query.to ?? String(Date.now()), 10) || Date.now();
    const days = db.getRideCountsByDateRange(from, to);
    return { days };
  });

  /** List rides (paginated, optionally filtered by routeId / date / range / mode). */
  fastify.get<{
    Querystring: {
      routeId?: string; limit?: string; offset?: string; date?: string;
      from?: string; to?: string; excludeEmpty?: string; mode?: string;
    };
  }>('/api/rides', async (req) => {
    const { date } = req.query;
    // '1' / 'true' 都視為開啟 0km/0W 過濾。
    const excludeEmpty = req.query.excludeEmpty === '1' || req.query.excludeEmpty === 'true';

    // Date-based query: return all rides for a specific YYYY-MM-DD
    if (date) {
      const rides = db.getRidesByDate(date, excludeEmpty);
      return { rides };
    }

    const limit = parseInt(req.query.limit ?? '20', 10) || 20;
    const offset = parseInt(req.query.offset ?? '0', 10) || 0;
    const routeId = req.query.routeId;
    // from/to 為 epoch ms；缺省時不加時間過濾。
    const from = req.query.from ? parseInt(req.query.from, 10) : undefined;
    const to = req.query.to ? parseInt(req.query.to, 10) : undefined;
    const mode = req.query.mode || undefined;
    const rides = db.listRides({
      limit,
      offset,
      routeId,
      from: Number.isFinite(from) ? from : undefined,
      to: Number.isFinite(to) ? to : undefined,
      excludeEmpty,
      mode,
    });
    return { rides };
  });

  /** Get personal best ride for a route (highest avg power). */
  fastify.get<{
    Querystring: { routeId?: string; hrMax?: string };
  }>('/api/rides/best', async (req, reply) => {
    const { routeId } = req.query;
    if (!routeId) return reply.code(400).send({ error: 'routeId is required' });

    const hrMax = parseInt(req.query.hrMax ?? '190', 10) || 190;
    const result = db.getBestRideForRoute(routeId, hrMax);

    if (!result) return { ride: null, zoneSustainPct: 0 };
    return { ride: result.ride, zoneSustainPct: result.zoneSustainPct };
  });

  /** Get a single ride. */
  fastify.get<{ Params: { id: string } }>('/api/rides/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: 'Invalid ride ID' });

    const ride = db.getRide(id);
    if (!ride) return reply.code(404).send({ error: 'Ride not found' });
    return ride;
  });

  /**
   * 騎後回饋：主觀強度 RPE（1-5 整數）與 / 或備註（≤2000 字）。至少要帶一個
   * 欄位，且都通過驗證才寫入。ride 不存在回 404。
   */
  fastify.patch<{
    Params: { id: string };
    Body: { rpe?: number; notes?: string };
  }>('/api/rides/:id/feedback', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: 'Invalid ride ID' });

    const body = req.body ?? {};
    const patch: { rpe?: number; notes?: string } = {};

    if (body.rpe !== undefined) {
      if (!Number.isInteger(body.rpe) || body.rpe < 1 || body.rpe > 5) {
        return reply.code(400).send({ error: 'rpe must be an integer between 1 and 5' });
      }
      patch.rpe = body.rpe;
    }
    if (body.notes !== undefined) {
      if (typeof body.notes !== 'string' || body.notes.length > 2000) {
        return reply.code(400).send({ error: 'notes must be a string of at most 2000 characters' });
      }
      patch.notes = body.notes;
    }
    if (patch.rpe === undefined && patch.notes === undefined) {
      return reply.code(400).send({ error: 'at least one of rpe / notes is required' });
    }

    if (!db.getRide(id)) return reply.code(404).send({ error: 'Ride not found' });
    db.updateRideFeedback(id, patch);
    return { ok: true };
  });

  /** Delete a ride (cascades to ride_samples). */
  fastify.delete<{ Params: { id: string } }>('/api/rides/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: 'Invalid ride ID' });

    const deleted = db.deleteRide(id);
    if (!deleted) return reply.code(404).send({ error: 'Ride not found' });
    return { ok: true };
  });

  /**
   * FTP estimate for a ride from its best continuous 20-min average power
   * (FTP ≈ best20min × 0.95). Used after an FTP-test workout to suggest an
   * updated FTP. Returns nulls when the ride is too short / has no power.
   */
  fastify.get<{ Params: { id: string } }>('/api/rides/:id/ftp-estimate', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: 'Invalid ride ID' });

    const ride = db.getRide(id);
    if (!ride) return reply.code(404).send({ error: 'Ride not found' });

    const best20MinW = db.getBest20MinAvgPower(id);
    const estimatedFtp = best20MinW != null ? Math.round(best20MinW * 0.95) : null;
    return { best20MinW, estimatedFtp };
  });

  /** Get all samples for a ride (for charts / detail view). */
  fastify.get<{ Params: { id: string } }>('/api/rides/:id/samples', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: 'Invalid ride ID' });

    const ride = db.getRide(id);
    if (!ride) return reply.code(404).send({ error: 'Ride not found' });

    const samples = db.getSamplesForExport(id);
    return { samples };
  });

  /**
   * P8 幽靈車:輸出所選騎乘的 distance-vs-time trace(GhostTraceDto)。
   * 前端多半不需要(sim 開賽時廣播 ghost 狀態),此端點供名牌 metadata 與
   * 未來用途。空 trace(騎乘無樣本)→ 422:此騎乘不能當幽靈。
   */
  fastify.get<{ Params: { id: string } }>('/api/rides/:id/ghost-trace', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: 'Invalid ride ID' });

    const ride = db.getRide(id);
    if (!ride) return reply.code(404).send({ error: 'Ride not found' });

    const { points, source } = buildGhostTrace(db.getSamplesForGhost(id));
    if (points.length === 0) {
      return reply.code(422).send({ error: 'Ride has no samples — cannot be used as a ghost' });
    }

    const dto: GhostTraceDto = { rideId: id, startedAt: ride.startedAt, source, points };
    return dto;
  });

  /** Export ride as FIT file for Strava/Garmin upload. */
  fastify.get<{ Params: { id: string } }>('/api/rides/:id/export.fit', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: 'Invalid ride ID' });

    const ride = db.getRide(id);
    if (!ride) return reply.code(404).send({ error: 'Ride not found' });

    const samples = db.getSamplesForExport(id);
    if (samples.length === 0) {
      return reply.code(400).send({ error: 'No samples recorded for this ride' });
    }

    const fitData = exportRideToFit(ride, samples);
    const fileName = `ride-${id}.fit`;

    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${fileName}"`)
      .send(Buffer.from(fitData));
  });
}
