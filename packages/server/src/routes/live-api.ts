/**
 * Live session REST API — sensor status, start/stop recording, game pause.
 */

import type { FastifyInstance } from 'fastify';
import type { RoutePoint } from '@littlecycling/shared';
import type { LiveSession } from '../lib/live-session.js';
import type { RouteStore } from '../lib/route-store.js';
import type { GameSimConfig } from '../lib/game-simulation.js';

/**
 * Config fields the game simulation needs from the client at start time.
 * Validated strictly: a missing field would otherwise silently fall back to
 * a default and corrupt a whole ride's simulation (plan: fail loudly).
 */
interface StartGameBody {
  ftp: number;
  hrMax: number;
  trainerModel: string;
  freeRoam: boolean;
  targetDurationMs: number;
  randomEventsEnabled: boolean;
  selectedWorkoutId: string;
}

interface StartBody {
  routeId?: string;
  routeName?: string;
  game?: StartGameBody;
}

/** Returns an error string, or null when the body is a valid GameSimConfig. */
function validateGameConfig(game: StartGameBody): string | null {
  if (typeof game.ftp !== 'number' || game.ftp <= 0) return 'game.ftp must be a positive number';
  if (typeof game.hrMax !== 'number' || game.hrMax <= 0) return 'game.hrMax must be a positive number';
  if (typeof game.trainerModel !== 'string' || game.trainerModel.length === 0) return 'game.trainerModel is required';
  if (typeof game.freeRoam !== 'boolean') return 'game.freeRoam must be a boolean';
  if (typeof game.targetDurationMs !== 'number' || game.targetDurationMs <= 0) return 'game.targetDurationMs must be a positive number';
  if (typeof game.randomEventsEnabled !== 'boolean') return 'game.randomEventsEnabled must be a boolean';
  if (typeof game.selectedWorkoutId !== 'string') return 'game.selectedWorkoutId is required';
  return null;
}

export default async function liveApi(
  fastify: FastifyInstance,
  opts: { liveSession: LiveSession; routeStore: RouteStore },
): Promise<void> {
  const { liveSession, routeStore } = opts;

  /** Get live session status + detected sensors. */
  fastify.get('/api/live/status', async () => {
    return {
      state: liveSession.state,
      sensors: liveSession.detectedSensors,
      rideId: liveSession.rideId,
      snapshot: liveSession.snapshot,
    };
  });

  /** Start recording a new ride (optionally with the game simulation). */
  fastify.post<{ Body: StartBody }>('/api/live/start', async (req, reply) => {
    try {
      const body = (req.body ?? {}) as StartBody;

      // Game start: validate config + resolve route points server-side. All
      // failures are loud 400s — a silently-defaulted config or missing
      // route would corrupt the entire ride's simulation.
      let game: { routePoints: RoutePoint[]; config: GameSimConfig } | undefined;
      if (body.game) {
        const configError = validateGameConfig(body.game);
        if (configError) {
          return reply.code(400).send({ error: configError });
        }
        if (!body.routeId) {
          return reply.code(400).send({ error: 'game start requires routeId' });
        }
        const route = routeStore.get(body.routeId);
        if (!route || route.points.length < 2) {
          return reply.code(400).send({ error: `route not found or has no points: ${body.routeId}` });
        }
        game = { routePoints: route.points, config: body.game };
      }

      const rideId = await liveSession.startRecording({
        routeId: body.routeId,
        routeName: body.routeName,
        game,
      });
      return { rideId };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  /** Stop the current recording. */
  fastify.post<{
    Body?: { totalCoins?: number; totalLaps?: number };
  }>('/api/live/stop', async (req, reply) => {
    try {
      // Body is optional — a bare stop (no coins/laps) is still valid and
      // just persists zeros for the game-layer totals.
      const body = (req.body ?? {}) as { totalCoins?: number; totalLaps?: number };
      const summary = await liveSession.stopRecording({
        totalCoins: body.totalCoins,
        totalLaps: body.totalLaps,
      });
      return { summary };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  /** Pause the game simulation (physics freeze; clock and recording continue). */
  fastify.post('/api/live/pause', async (_req, reply) => {
    try {
      liveSession.setGamePaused(true);
      return { paused: true };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  /** Resume the game simulation. */
  fastify.post('/api/live/resume', async (_req, reply) => {
    try {
      liveSession.setGamePaused(false);
      return { paused: false };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  /** Tear down and re-run the sensor scan (picks up devices powered on late). */
  fastify.post('/api/live/rescan', async (_req, reply) => {
    try {
      const sensors = await liveSession.rescan();
      return { sensors };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
}
