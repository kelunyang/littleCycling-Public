/**
 * Waterway renderer: rivers, streams, canals and ditches as ribbons on the ground.
 *
 * The map survey found ~1,290 waterway features across our routes — the single
 * biggest thing we were downloading nothing of. The `water` layer we already draw
 * is polygons (lakes); flowing water is a `waterway` LINE, so every river and
 * stream was simply invisible: you rode straight through them.
 *
 * Same ribbon construction as `road-renderer.ts`, with two differences:
 *  - it sits BELOW the road (water goes under bridges, not over them);
 *  - culverted/tunnelled reaches are skipped (see `isUnderground`).
 */

import * as THREE from 'three';
import { applyOverlayDepth } from './overlay-depth';
import type { ElevationSampler } from './elevation-sampler';
import type { MVTFeature } from './mvt-fetcher';
import type { TerrainStyleStrategy } from './terrain-style-strategy';
import { buildGroundRibbon, mergeRibbonGeometries, type GroundFn } from './ribbon-geometry';
import { createYielder } from './build-yield';

/**
 * Height above terrain. Lower than ROAD_HEIGHT_OFFSET (0.3) so a river crossing
 * under a road passes beneath its ribbon instead of z-fighting with it.
 */
export const WATERWAY_HEIGHT_OFFSET = 0.15;

/** Ribbon width in metres, by OSM waterway class. */
const WATERWAY_WIDTH: Record<string, number> = {
  river: 6,
  canal: 5,
  stream: 3,
  ditch: 1.5,
  drain: 1.5,
};
const DEFAULT_WATERWAY_WIDTH = 2;

/**
 * The water material is identical across chunks, so share one per strategy
 * instead of minting a fresh one — and GL program — per chunk. WeakMap keyed by
 * the strategy so a style switch starts fresh and the old entry is GC'd with the
 * old strategy. Tagged `userData.shared` so `disposeWaterwayMesh` skips it.
 */
const waterMaterialCache = new WeakMap<TerrainStyleStrategy, THREE.Material>();

function sharedWaterMaterial(strategy: TerrainStyleStrategy): THREE.Material {
  let mat = waterMaterialCache.get(strategy);
  if (!mat) {
    mat = strategy.createWaterMaterial();
    applyOverlayDepth(mat, 'waterway');
    mat.userData.shared = true;
    waterMaterialCache.set(strategy, mat);
  }
  return mat;
}

export interface WaterwayRenderResult {
  mesh: THREE.Mesh;
  waterwayCount: number;
}

/**
 * Culverts and tunnels carry the water UNDER something — a road, a railway, a
 * field. Drawing them would lay a blue ribbon straight across the tarmac. The
 * survey counted 145 such reaches on our routes, so this is not an edge case.
 */
function isUnderground(feature: MVTFeature): boolean {
  const brunnel = feature.properties.brunnel;
  return brunnel === 'tunnel' || brunnel === 'culvert';
}

export async function buildWaterwayMeshes(
  features: MVTFeature[],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
  strategy: TerrainStyleStrategy,
  ground: GroundFn = () => null,
  owns: (lon: number, lat: number) => boolean = () => true,
): Promise<WaterwayRenderResult> {
  const waterways = features.filter(
    (f) =>
      f.layer === 'waterway' &&
      !isUnderground(f) &&
      (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString'),
  );

  if (waterways.length === 0) {
    return { mesh: new THREE.Mesh(), waterwayCount: 0 };
  }

  const cosOrigin = Math.cos((originLat * Math.PI) / 180);
  const proj = { originLat, originLon, cosOrigin };
  const geometries: THREE.BufferGeometry[] = [];

  const maybeYield = createYielder();

  for (const way of waterways) {
    await maybeYield();
    const cls = (way.properties.class as string) || 'stream';
    const width = WATERWAY_WIDTH[cls] ?? DEFAULT_WATERWAY_WIDTH;

    const lines: [number, number][][] =
      way.geometry.type === 'LineString'
        ? [(way.geometry as GeoJSON.LineString).coordinates as [number, number][]]
        : ((way.geometry as GeoJSON.MultiLineString).coordinates as [number, number][][]);

    for (const coords of lines) {
      const geom = buildGroundRibbon(coords, proj, ground, {
        halfWidth: width / 2,
        // Below the road (0.3): water goes UNDER bridges, not over them. Both
        // ride the same raycast ground, so that gap is now exact everywhere.
        heightOffset: WATERWAY_HEIGHT_OFFSET,
        keep: owns,
      });
      if (geom) geometries.push(geom);
    }
  }

  if (geometries.length === 0) {
    return { mesh: new THREE.Mesh(), waterwayCount: 0 };
  }

  const merged = mergeRibbonGeometries(geometries);
  for (const g of geometries) g.dispose();

  // Same water as the lakes — glossy cellophane / moulded cyan brick. Shared
  // across chunks (one material per strategy).
  const mesh = new THREE.Mesh(merged, sharedWaterMaterial(strategy));
  return { mesh, waterwayCount: waterways.length };
}

export function disposeWaterwayMesh(result: WaterwayRenderResult): void {
  result.mesh.geometry.dispose();
  const mat = result.mesh.material;
  if (mat instanceof THREE.Material && !mat.userData.shared) mat.dispose();
}
