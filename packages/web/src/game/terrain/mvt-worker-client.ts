/**
 * Client wrapper for the MVT Web Worker.
 *
 * Shared by both Phaser 2D and Three.js renderers.
 * Spawns a one-shot worker, posts route data, and resolves
 * with the projected features when the worker responds.
 */

import type { RoutePoint } from '@littlecycling/shared';
import type { ProjectedFeature } from './mvt-projection';
import { computeRouteBounds } from './mvt-projection';

export function fetchFeaturesInWorker(
  points: RoutePoint[],
  cumulativeDists: number[],
): Promise<ProjectedFeature[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./mvt-worker.ts', import.meta.url),
      { type: 'module' },
    );
    const bounds = computeRouteBounds(points);
    // Strip Vue reactivity — Proxy objects are not structured-cloneable
    const plainPoints = points.map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele }));
    worker.postMessage({ points: plainPoints, cumulativeDists: [...cumulativeDists], bounds });
    worker.onmessage = (e) => {
      if (e.data.ok) resolve(e.data.features);
      else reject(new Error(e.data.error));
      worker.terminate();
    };
    worker.onerror = (e) => {
      reject(e);
      worker.terminate();
    };
  });
}
