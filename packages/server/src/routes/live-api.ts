/**
 * Live session REST API — sensor status, start/stop recording.
 */

import type { FastifyInstance } from 'fastify';
import type { LiveSession } from '../lib/live-session.js';

export default async function liveApi(
  fastify: FastifyInstance,
  opts: { liveSession: LiveSession },
): Promise<void> {
  const { liveSession } = opts;

  /** Get live session status + detected sensors. */
  fastify.get('/api/live/status', async () => {
    return {
      state: liveSession.state,
      sensors: liveSession.detectedSensors,
      rideId: liveSession.rideId,
      snapshot: liveSession.snapshot,
    };
  });

  /** Start recording a new ride. */
  fastify.post<{
    Body: { routeId?: string; routeName?: string };
  }>('/api/live/start', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { routeId?: string; routeName?: string };
      const rideId = await liveSession.startRecording({
        routeId: body.routeId,
        routeName: body.routeName,
      });
      return { rideId };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  /** Stop the current recording. */
  fastify.post('/api/live/stop', async (_req, reply) => {
    try {
      const summary = await liveSession.stopRecording();
      return { summary };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
}
