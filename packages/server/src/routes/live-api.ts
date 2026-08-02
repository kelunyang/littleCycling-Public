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
  /**
   * Repeat the workout at its designed length to fill the ride, instead of
   * stretching one round over it. Optional — absent means off, which is the
   * historical behaviour.
   */
  repeatWorkout?: boolean;
  /**
   * 課表訓練時帶上：由此組出 rides.workout_id = `plan:<planId>:<day>`，
   * 優先於 selectedWorkoutId。自由騎 / 一般 workout 不帶。
   */
  planRef?: { planId: string; day: number };
  /** Welcome-screen start window: begin the ride this many metres along the route. */
  startOffsetM?: number;
}

interface StartBody {
  routeId?: string;
  routeName?: string;
  game?: StartGameBody;
  /**
   * P8 幽靈車:所選歷史騎乘 id,以幽靈形式在世界裡對騎。僅在有 game 時有意義;
   * 該騎乘無樣本 → server 記 warning 略過(不擋開賽)。
   */
  ghostRideId?: number;
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
  if (game.startOffsetM !== undefined && (typeof game.startOffsetM !== 'number' || !Number.isFinite(game.startOffsetM) || game.startOffsetM < 0)) {
    return 'game.startOffsetM must be a non-negative number';
  }
  if (game.planRef !== undefined) {
    if (typeof game.planRef !== 'object' || game.planRef === null) return 'game.planRef must be an object';
    if (typeof game.planRef.planId !== 'string' || game.planRef.planId.length === 0) return 'game.planRef.planId must be a non-empty string';
    if (!Number.isInteger(game.planRef.day) || game.planRef.day <= 0) return 'game.planRef.day must be a positive integer';
  }
  return null;
}

/**
 * 由 game config 推導 rides.workout_id：課表訓練優先用 planRef 組
 * `plan:<planId>:<day>`；否則存 workout profile id（'none' 自由騎存 undefined）。
 */
function deriveWorkoutId(game: StartGameBody): string | undefined {
  if (game.planRef) return `plan:${game.planRef.planId}:${game.planRef.day}`;
  return game.selectedWorkoutId !== 'none' ? game.selectedWorkoutId : undefined;
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
      // 訓練模式標記：由 game config 推導（課表訓練 / workout profile / 自由騎）。
      let workoutId: string | undefined;
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
        workoutId = deriveWorkoutId(body.game);
      }

      // P8 幽靈車:選填,帶上就是正整數 ride id(sim 建好後由 LiveSession 載入)。
      if (body.ghostRideId !== undefined) {
        if (!Number.isInteger(body.ghostRideId) || body.ghostRideId <= 0) {
          return reply.code(400).send({ error: 'ghostRideId must be a positive integer' });
        }
      }

      const rideId = await liveSession.startRecording({
        routeId: body.routeId,
        routeName: body.routeName,
        workoutId,
        repeatWorkout: body.game?.repeatWorkout ?? false,
        game,
        ghostRideId: body.ghostRideId,
      });
      // The prescribed segments come back so the client renders what the SERVER
      // decided rather than deriving its own copy — see LiveSession for why.
      return { rideId, workoutSegments: liveSession.prescribedSegments };
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
