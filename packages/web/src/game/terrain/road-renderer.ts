/**
 * Road renderer: builds 3D ribbon meshes from MVT transportation features.
 *
 * Each road polyline is resampled and laid ON the terrain (see
 * `ribbon-geometry.ts` — the roads used to compute their own quantised height
 * and sank into the steps). Roads are merged into a single mesh per chunk.
 */

import * as THREE from 'three';
import type { ElevationSampler } from './elevation-sampler';
import type { MVTFeature } from './mvt-fetcher';
import type { TerrainStyleStrategy } from './terrain-style-strategy';
import { buildGroundRibbon, mergeRibbonGeometries, type GroundFn } from './ribbon-geometry';

/** Road height above the terrain surface. See the layering table in the plan:
 *  aeroway 0.12 < waterway 0.15 < road 0.30 < route-line glow 0.40 / core 0.45. */
export const ROAD_HEIGHT_OFFSET = 0.3;

export interface RoadRenderResult {
  mesh: THREE.Mesh;
  roadCount: number;
}

/**
 * Build road ribbon meshes from MVT transportation features.
 *
 * @param ground  Terrain probe. Where it misses (terrain not streamed in), the
 *                old quantised-elevation formula is used instead.
 */
export async function buildRoadMeshes(
  features: MVTFeature[],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
  strategy: TerrainStyleStrategy,
  ground: GroundFn = () => null,
): Promise<RoadRenderResult> {
  const roads = features.filter(
    (f) =>
      f.layer === 'transportation' &&
      (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString'),
  );

  if (roads.length === 0) {
    return { mesh: new THREE.Mesh(), roadCount: 0 };
  }

  const cosOrigin = Math.cos((originLat * Math.PI) / 180);
  const proj = { originLat, originLon, cosOrigin };
  const geometries: THREE.BufferGeometry[] = [];

  // Fallback height, for samples the ray misses. Synchronous: the chunk's DEM
  // tiles are already cached by the terrain build that ran just before us, so
  // this never awaits a microtask per vertex the way it used to.
  const fallbackY = (lon: number, lat: number): number => {
    const ele = sampler.getElevationSync(lat, lon) ?? originEle;
    return strategy.quantizeElevation(ele) - originEle;
  };

  for (const road of roads) {
    const roadClass = (road.properties.class as string) || 'minor';
    const color = new THREE.Color(strategy.roadColor(roadClass));
    const halfWidth = strategy.roadWidth(roadClass) / 2;

    const lines: [number, number][][] =
      road.geometry.type === 'LineString'
        ? [(road.geometry as GeoJSON.LineString).coordinates as [number, number][]]
        : ((road.geometry as GeoJSON.MultiLineString).coordinates as [number, number][][]);

    for (const coords of lines) {
      const geom = buildGroundRibbon(coords, proj, ground, fallbackY, {
        halfWidth,
        heightOffset: ROAD_HEIGHT_OFFSET,
        color,
        // u = metres along the road, v = 0/1 across it. The style's road texture
        // (tape weave / dashed centre line) sets its own repeat from this, so the
        // dash pitch stays constant no matter how long the polyline is.
        emitUv: true,
      });
      if (geom) geometries.push(geom);
    }
  }

  if (geometries.length === 0) {
    return { mesh: new THREE.Mesh(), roadCount: 0 };
  }

  const merged = mergeRibbonGeometries(geometries);
  for (const g of geometries) g.dispose();

  // Use a single dark road material (most common color)
  const material = strategy.createRoadMaterial(0x3a3a3a);

  const mesh = new THREE.Mesh(merged, material);
  return { mesh, roadCount: roads.length };
}

/** Dispose road mesh resources. */
export function disposeRoadMesh(result: RoadRenderResult): void {
  result.mesh.geometry.dispose();
  if (result.mesh.material instanceof THREE.Material) {
    result.mesh.material.dispose();
  }
}
