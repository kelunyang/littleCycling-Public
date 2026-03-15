/**
 * Ride history REST API — list, detail, delete, comparison window.
 */

import type { FastifyInstance } from 'fastify';
import type { RideDatabase } from '../lib/database.js';
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

  /** List rides (paginated, optionally filtered by routeId or date). */
  fastify.get<{
    Querystring: { routeId?: string; limit?: string; offset?: string; date?: string };
  }>('/api/rides', async (req) => {
    const { date } = req.query;

    // Date-based query: return all rides for a specific YYYY-MM-DD
    if (date) {
      const rides = db.getRidesByDate(date);
      return { rides };
    }

    const limit = parseInt(req.query.limit ?? '20', 10) || 20;
    const offset = parseInt(req.query.offset ?? '0', 10) || 0;
    const routeId = req.query.routeId;
    const rides = db.listRides(limit, offset, routeId);
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

  /** Delete a ride (cascades to ride_samples). */
  fastify.delete<{ Params: { id: string } }>('/api/rides/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: 'Invalid ride ID' });

    const deleted = db.deleteRide(id);
    if (!deleted) return reply.code(404).send({ error: 'Ride not found' });
    return { ok: true };
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

  /** Get comparison samples for a time window. */
  fastify.get<{
    Params: { id: string };
    Querystring: { from?: string; to?: string };
  }>('/api/rides/:id/comparison', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return reply.code(400).send({ error: 'Invalid ride ID' });

    const from = parseInt(req.query.from ?? '0', 10) || 0;
    const to = parseInt(req.query.to ?? '120000', 10) || 120000;

    const ride = db.getRide(id);
    if (!ride) return reply.code(404).send({ error: 'Ride not found' });

    const samples = db.getComparisonWindow(id, from, to);
    return { samples };
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
