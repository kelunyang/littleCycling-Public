/**
 * Route CRUD — Fastify plugin for managing saved GPX/TCX/FIT routes.
 */

import type { FastifyInstance } from 'fastify';
import { parseRouteFile } from '@littlecycling/shared';
import { parseFitRoute } from '../lib/fit-parser.js';
import type { RouteStore } from '../lib/route-store.js';

// Polyfill DOMParser for Node.js (shared gpx-parser uses it)
import { DOMParser as LinkedomDOMParser } from 'linkedom';
if (typeof globalThis.DOMParser === 'undefined') {
  (globalThis as Record<string, unknown>).DOMParser = LinkedomDOMParser;
}

export default async function routeApi(fastify: FastifyInstance, opts: { routeStore: RouteStore }): Promise<void> {
  const { routeStore } = opts;

  /** List all routes (summary without points). */
  fastify.get('/api/routes', async () => {
    return { routes: routeStore.list() };
  });

  /** Get a single route with full points. */
  fastify.get<{ Params: { id: string } }>('/api/routes/:id', async (req, reply) => {
    const route = routeStore.get(req.params.id);
    if (!route) return reply.code(404).send({ error: 'Route not found' });
    return route;
  });

  /** Upload GPX/TCX/FIT file to create a new route. */
  fastify.post('/api/routes', async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'No file uploaded' });

    const buffer = await data.toBuffer();
    const fileName = data.filename;
    const isFit = fileName.toLowerCase().endsWith('.fit');
    const nameField = (data.fields as Record<string, { value?: string }>).name?.value;
    const name = nameField || fileName.replace(/\.(gpx|tcx|fit)$/i, '');

    let points;
    if (isFit) {
      try {
        points = await parseFitRoute(buffer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to parse FIT file';
        return reply.code(400).send({ error: msg });
      }
    } else {
      const xml = buffer.toString('utf-8');
      points = parseRouteFile(xml, fileName);
    }

    if (points.length === 0) {
      return reply.code(400).send({ error: 'No route points found in file' });
    }

    const route = routeStore.create(name, fileName, points);
    return reply.code(201).send(route);
  });

  /** Rename a route. */
  fastify.patch<{ Params: { id: string }; Body: { name?: string } }>('/api/routes/:id', async (req, reply) => {
    const route = routeStore.update(req.params.id, req.body);
    if (!route) return reply.code(404).send({ error: 'Route not found' });
    return route;
  });

  /** Delete a route. */
  fastify.delete<{ Params: { id: string } }>('/api/routes/:id', async (req, reply) => {
    const deleted = routeStore.delete(req.params.id);
    if (!deleted) return reply.code(404).send({ error: 'Route not found' });
    return reply.code(204).send();
  });
}
