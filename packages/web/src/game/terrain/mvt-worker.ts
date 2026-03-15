/**
 * Web Worker script for MVT tile fetching + projection.
 *
 * Runs fetch + decode + O(features x routePoints) projection off the main thread.
 * Used by both Phaser 2D and Three.js renderers via mvt-worker-client.ts.
 */

import { MVTFetcher } from './mvt-fetcher';
import { projectMVTFeatures } from './mvt-projection';

self.onmessage = async (e: MessageEvent) => {
  const { points, cumulativeDists, bounds } = e.data;
  try {
    const fetcher = new MVTFetcher();
    await fetcher.initialize();
    const raw = await fetcher.getFeaturesForBounds(bounds);
    const projected = projectMVTFeatures(raw, points, cumulativeDists);
    projected.sort((a, b) => a.distanceM - b.distanceM);
    self.postMessage({ ok: true, features: projected });
  } catch (err: any) {
    self.postMessage({ ok: false, error: err.message });
  }
};
