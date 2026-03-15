/**
 * Catalog API — browse EuroVelo routes and download GPX stages.
 *
 * Data: © EuroVelo (eurovelo.com), available under ODbL
 */

import type { FastifyInstance } from 'fastify';
import { parseRouteFile } from '@littlecycling/shared';
import type { RouteStore } from '../lib/route-store.js';
import { EuroveloCatalog } from '../lib/eurovelo-catalog.js';

// Polyfill DOMParser for Node.js (shared gpx-parser uses it)
import { DOMParser as LinkedomDOMParser } from 'linkedom';
if (typeof globalThis.DOMParser === 'undefined') {
  (globalThis as Record<string, unknown>).DOMParser = LinkedomDOMParser;
}

/** Deterministic fileName for catalog stages — used to detect duplicates. */
function catalogFileName(raceId: string, stage: number): string {
  return `${raceId}-stage-${stage}.gpx`;
}

export default async function catalogApi(
  fastify: FastifyInstance,
  opts: { routeStore: RouteStore },
): Promise<void> {
  const { routeStore } = opts;
  const catalog = new EuroveloCatalog();

  /** Fetch EuroVelo catalog → return catalog + which stages are already downloaded. */
  fastify.get('/api/catalog', async (_, reply) => {
    let catalogData;
    try {
      catalogData = await catalog.getCatalog();
    } catch (err) {
      return reply.code(502).send({ error: `Failed to fetch catalog: ${(err as Error).message}` });
    }

    // Detect already-downloaded stages by matching fileName
    const existing = routeStore.list();
    const existingFileNames = new Set(existing.map((r) => r.fileName));

    const downloadedStageIds: string[] = [];
    for (const race of catalogData.races) {
      for (const stage of race.stages) {
        if (existingFileNames.has(catalogFileName(race.id, stage.stage))) {
          downloadedStageIds.push(`${race.id}-s${stage.stage}`);
        }
      }
    }

    return { catalog: catalogData, downloadedStageIds };
  });

  /** Download a GPX stage from EuroVelo and save as a route. */
  fastify.post<{ Body: { raceId: string; stage: number } }>('/api/catalog/download', async (req, reply) => {
    const { raceId, stage } = req.body;

    if (!raceId || stage == null) {
      return reply.code(400).send({ error: 'Missing raceId or stage' });
    }

    // Check if already downloaded
    const fn = catalogFileName(raceId, stage);
    const existing = routeStore.list();
    const alreadyDownloaded = existing.find((r) => r.fileName === fn);
    if (alreadyDownloaded) {
      return alreadyDownloaded;
    }

    // Find race and stage in catalog
    const found = await catalog.findStage(raceId, stage);
    if (!found) return reply.code(404).send({ error: `Stage ${stage} not found in ${raceId}` });

    const { race, stage: stageInfo } = found;

    // Download GPX from EuroVelo
    let gpxXml: string;
    try {
      gpxXml = await catalog.downloadGpx(stageInfo.gpxId);
    } catch (err) {
      return reply.code(502).send({ error: `Failed to download GPX: ${(err as Error).message}` });
    }

    // Parse GPX
    const points = parseRouteFile(gpxXml, fn);
    if (points.length === 0) {
      return reply.code(400).send({ error: 'No route points found in downloaded GPX' });
    }

    // Save as route
    const name = `${race.name} — Stage ${stage}: ${stageInfo.name}`;
    const route = routeStore.create(name, fn, points);

    // Return summary (without points to save bandwidth)
    const { points: _, ...summary } = route;
    return reply.code(201).send(summary);
  });
}
