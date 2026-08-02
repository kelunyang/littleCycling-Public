/**
 * Lightweight zone detector for the Phaser side-scrolling renderer.
 *
 * The Three.js path uses lat/lng + raw MVT geometry to classify the
 * environment. The Phaser path only has ProjectedFeature[] (1D — projected
 * onto route distance), so we approximate with feature counts inside a
 * window around the cyclist's current distanceM.
 *
 * Priority: tunnel > forest > urban > open
 */

import type { ProjectedFeature } from '@/game/terrain/mvt-projection';

export type ZoneType = 'urban' | 'forest' | 'tunnel' | 'open';

const WINDOW_M = 60;
const URBAN_BUILDING_THRESHOLD = 4;
const FOREST_TREE_THRESHOLD = 6;

export function detectPhaserZone(
  distanceM: number,
  features: ProjectedFeature[],
): ZoneType {
  let trees = 0;
  let buildings = 0;

  for (const f of features) {
    const d = Math.abs(f.distanceM - distanceM);
    if (d > WINDOW_M) continue;

    // Tunnel: classified as its own type now — tunnels are deliberately not
    // paved (a tunnel is inside the hill, not on it), so they no longer arrive
    // as 'road'.
    if (f.type === 'tunnel') return 'tunnel';
    if (f.type === 'tree') trees++;
    else if (f.type === 'building') buildings++;
  }

  if (trees >= FOREST_TREE_THRESHOLD && trees > buildings) return 'forest';
  if (buildings >= URBAN_BUILDING_THRESHOLD) return 'urban';
  return 'open';
}
