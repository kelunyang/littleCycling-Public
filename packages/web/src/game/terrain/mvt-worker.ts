/**
 * Web Worker script for MVT tile fetching + projection.
 *
 * Runs fetch + decode + O(features x routePoints) projection off the main thread.
 * Used by both Phaser 2D and Three.js renderers via mvt-worker-client.ts.
 */

import { MVTFetcher, decodeMVTTile } from './mvt-fetcher';
import { projectMVTFeatures } from './mvt-projection';

self.onmessage = async (e: MessageEvent) => {
  const data = e.data;

  // 3D terrain path: decode a single raw tile buffer (transferred) and return the
  // GeoJSON features. Multiplexed by `id` so one persistent worker serves many
  // tiles. Distinct from the Phaser fetch+project message below (no `type`).
  if (data && data.type === 'decode') {
    const { id, buffer, x, y, zoom } = data;
    try {
      const features = decodeMVTTile(buffer, x, y, zoom);
      self.postMessage({ type: 'decode', id, ok: true, features });
    } catch (err: any) {
      self.postMessage({ type: 'decode', id, ok: false, error: err.message });
    }
    return;
  }

  // Phaser 2D path (unchanged): fetch the whole route's tiles, project, sort.
  const { points, cumulativeDists, bounds } = data;
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
