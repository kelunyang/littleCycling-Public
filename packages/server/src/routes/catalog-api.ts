/**
 * Catalog API — browse EuroVelo routes and import individual stages
 * as saved routes.
 *
 * Data: © EuroVelo (eurovelo.com), distributed under ODbL.
 */

import type { FastifyInstance } from 'fastify';
import { parseRouteFile } from '@littlecycling/shared';
import type { RouteStore } from '../lib/route-store.js';
import type { EuroVeloCatalog } from '../lib/eurovelo-catalog.js';

function catalogFileName(routeId: string, stage: number): string {
  return `${routeId}-stage-${stage}.gpx`;
}

export default async function catalogApi(
  fastify: FastifyInstance,
  opts: { routeStore: RouteStore; catalog: EuroVeloCatalog },
): Promise<void> {
  const { routeStore, catalog } = opts;

  /** List the 17 EuroVelo routes + which stages are already saved locally. */
  fastify.get('/api/catalog', async () => {
    const data = catalog.getCatalog();
    const existing = new Set(routeStore.list().map((r) => r.fileName));
    const downloadedStageIds: string[] = [];
    for (const race of data.races) {
      for (const stage of race.stages) {
        if (existing.has(catalogFileName(race.id, stage.stage))) {
          downloadedStageIds.push(`${race.id}-s${stage.stage}`);
        }
      }
    }
    return { catalog: data, downloadedStageIds };
  });

  /** Fetch (or revalidate) a route's stage list. Returns the updated CatalogRace. */
  fastify.post<{ Params: { routeId: string } }>(
    '/api/catalog/route/:routeId/fetch',
    async (req, reply) => {
      try {
        const race = await catalog.fetchRoute(req.params.routeId);
        return race;
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

  /** Download a single stage as a saved route. */
  fastify.post<{ Body: { routeId: string; stage: number } }>(
    '/api/catalog/download',
    async (req, reply) => {
      const { routeId, stage } = req.body ?? {};
      if (!routeId || typeof stage !== 'number') {
        return reply.code(400).send({ error: 'Missing routeId or stage' });
      }

      const fn = catalogFileName(routeId, stage);
      const existing = routeStore.list().find((r) => r.fileName === fn);
      if (existing) {
        return reply.code(200).send({ ...existing, created: false });
      }

      let stageGpx = catalog.getStageGpx(routeId, stage);
      if (!stageGpx) {
        try {
          await catalog.fetchRoute(routeId);
          stageGpx = catalog.getStageGpx(routeId, stage);
        } catch (err) {
          return reply
            .code(502)
            .send({ error: `Failed to fetch route GPX: ${(err as Error).message}` });
        }
      }
      if (!stageGpx) {
        return reply.code(404).send({ error: `Stage ${stage} not found in ${routeId}` });
      }

      const points = parseRouteFile(stageGpx, fn);
      if (points.length === 0) {
        return reply.code(400).send({ error: 'No track points found in stage GPX' });
      }

      const data = catalog.getCatalog();
      const race = data.races.find((r) => r.id === routeId);
      const stageInfo = race?.stages.find((s) => s.stage === stage);
      const displayName = stageInfo
        ? `${race!.name} — Stage ${stage}: ${stageInfo.name}`
        : `${routeId} — Stage ${stage}`;

      const route = routeStore.create(displayName, fn, points);
      console.log(
        `[catalog] saved ${routeId}/stage-${stage}: ${route.id} ` +
          `(${(route.distanceM / 1000).toFixed(1)} km, ${route.points.length} pts)`,
      );
      const { points: _drop, ...summary } = route;
      return reply.code(201).send({ ...summary, created: true });
    },
  );
}
