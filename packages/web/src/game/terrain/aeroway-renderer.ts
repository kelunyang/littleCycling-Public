/**
 * Aeroway renderer: runways, taxiways, aprons — and one toy aircraft parked at
 * each aerodrome.
 *
 * Small in the survey (~77 features, and only on some routes), but an airfield
 * is unmistakable when you ride past one, and the plane ornament is the payoff:
 * cuphead gets a tethered plane-shaped BALLOON, plastic a brick plane.
 */

import * as THREE from 'three';
import type { ElevationSampler } from './elevation-sampler';
import type { MVTFeature } from './mvt-fetcher';
import type { TerrainStyleStrategy } from './terrain-style-strategy';
import { disposeGroup } from './bike-ornament';
import { buildGroundRibbon, mergeRibbonGeometries, type GroundFn } from './ribbon-geometry';

/** Just above the ground, below the roads (0.3) — apron is painted ON the land. */
export const PAVING_HEIGHT_OFFSET = 0.12;

/** Ribbon widths in metres. A runway is the widest thing on the map. */
const RUNWAY_WIDTH = 30;
const TAXIWAY_WIDTH = 15;

/** Grey concrete — deliberately flat, so the style's toy palette stays the star. */
const PAVING_COLOR = 0x9aa0a8;

export interface AerowayRenderResult {
  /** Runways + taxiways + aprons, merged. */
  mesh: THREE.Mesh;
  /** One toy aircraft per aerodrome. */
  planes: THREE.Group[];
  featureCount: number;
}

export async function buildAerowayMeshes(
  features: MVTFeature[],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
  strategy: TerrainStyleStrategy,
  ground: GroundFn = () => null,
): Promise<AerowayRenderResult> {
  const aeroways = features.filter((f) => f.layer === 'aeroway');
  if (aeroways.length === 0) {
    return { mesh: new THREE.Mesh(), planes: [], featureCount: 0 };
  }

  const cosOrigin = Math.cos((originLat * Math.PI) / 180);
  const proj = { originLat, originLon, cosOrigin };
  const geometries: THREE.BufferGeometry[] = [];
  const planes: THREE.Group[] = [];

  const fallbackY = (lon: number, lat: number): number => {
    const ele = sampler.getElevationSync(lat, lon) ?? originEle;
    return strategy.quantizeElevation(ele) - originEle;
  };

  for (const f of aeroways) {
    const cls = (f.properties.class as string) || '';

    // Runways and taxiways are lines → ribbons, same as roads.
    if (cls === 'runway' || cls === 'taxiway') {
      const width = cls === 'runway' ? RUNWAY_WIDTH : TAXIWAY_WIDTH;
      const lines: [number, number][][] =
        f.geometry.type === 'LineString'
          ? [(f.geometry as GeoJSON.LineString).coordinates as [number, number][]]
          : f.geometry.type === 'MultiLineString'
            ? ((f.geometry as GeoJSON.MultiLineString).coordinates as [number, number][][])
            : [];
      for (const coords of lines) {
        const geom = buildGroundRibbon(coords, proj, ground, fallbackY, {
          halfWidth: width / 2,
          heightOffset: PAVING_HEIGHT_OFFSET,
          emitUv: true,
        });
        if (geom) geometries.push(geom);
      }
      continue;
    }

    // Aprons/aerodromes are polygons → flat slabs.
    if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
      const rings =
        f.geometry.type === 'Polygon'
          ? [(f.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][]]
          : (f.geometry as GeoJSON.MultiPolygon).coordinates.map(
              (poly) => poly[0] as [number, number][],
            );
      for (const ring of rings) {
        const geom = await buildSlabGeometry(
          ring, sampler, originLat, originLon, originEle, cosOrigin, strategy, ground,
        );
        if (geom) geometries.push(geom);
      }

      // Park one aircraft at the aerodrome's centre.
      if (cls === 'aerodrome') {
        const plane = await buildParkedPlane(
          f, sampler, originLat, originLon, originEle, cosOrigin, strategy, ground,
        );
        if (plane) planes.push(plane);
      }
    }
  }

  if (geometries.length === 0) {
    return { mesh: new THREE.Mesh(), planes, featureCount: aeroways.length };
  }

  const merged = mergeRibbonGeometries(geometries);
  for (const g of geometries) g.dispose();

  const material = strategy.createRoadMaterial(PAVING_COLOR);
  return { mesh: new THREE.Mesh(merged, material), planes, featureCount: aeroways.length };
}

/** Place the style's aircraft at the aerodrome centroid, sitting on the terrain. */
async function buildParkedPlane(
  feature: MVTFeature,
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
  cosOrigin: number,
  strategy: TerrainStyleStrategy,
  ground: GroundFn,
): Promise<THREE.Group | null> {
  const rings =
    feature.geometry.type === 'Polygon'
      ? [(feature.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][]]
      : (feature.geometry as GeoJSON.MultiPolygon).coordinates.map(
          (p) => p[0] as [number, number][],
        );
  const coords = rings[0];
  if (!coords || coords.length === 0) return null;

  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of coords) {
    sumLon += lon;
    sumLat += lat;
  }
  const cLon = sumLon / coords.length;
  const cLat = sumLat / coords.length;

  const x = (cLon - originLon) * 111320 * cosOrigin;
  const z = -(cLat - originLat) * 111320;

  // Stand it on the real terrain; the quantised formula is only the fallback.
  let y = ground(x, z);
  if (y === null) {
    let ele: number;
    try {
      ele = await sampler.getElevation(cLat, cLon);
    } catch {
      ele = originEle;
    }
    y = strategy.quantizeElevation(ele) - originEle;
  }

  const plane = strategy.buildPlaneOrnament();
  plane.position.set(x, y, z);
  // A deterministic angle so a given field always parks its plane the same way.
  plane.rotation.y = ((Math.abs(Math.round(cLon * 1e4)) % 360) * Math.PI) / 180;
  return plane;
}

/** Flat slab for an apron / aerodrome polygon. */
async function buildSlabGeometry(
  coords: [number, number][],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
  cosOrigin: number,
  strategy: TerrainStyleStrategy,
  ground: GroundFn,
): Promise<THREE.BufferGeometry | null> {
  if (coords.length < 3) return null;

  const shape = new THREE.Shape();
  let sumLon = 0;
  let sumLat = 0;
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    sumLon += lon;
    sumLat += lat;
    const x = (lon - originLon) * 111320 * cosOrigin;
    const z = -(lat - originLat) * 111320;
    if (i === 0) shape.moveTo(x, z);
    else shape.lineTo(x, z);
  }
  shape.closePath();

  // A slab is flat, so it takes one height: the terrain under its centroid.
  const cLon = sumLon / coords.length;
  const cLat = sumLat / coords.length;
  const cx = (cLon - originLon) * 111320 * cosOrigin;
  const cz = -(cLat - originLat) * 111320;

  let base = ground(cx, cz);
  if (base === null) {
    let baseEle: number;
    try {
      baseEle = await sampler.getElevation(cLat, cLon);
    } catch {
      baseEle = originEle;
    }
    base = strategy.quantizeElevation(baseEle) - originEle;
  }
  const y = base + PAVING_HEIGHT_OFFSET;

  // ShapeGeometry lies in XY — lay it flat, same as the landuse overlays. The
  // road material is DoubleSide, so the winding after the rotation is moot.
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y, 0);
  return geometry;
}

export function disposeAerowayMeshes(result: AerowayRenderResult): void {
  result.mesh.geometry.dispose();
  if (result.mesh.material instanceof THREE.Material) result.mesh.material.dispose();
  for (const plane of result.planes) disposeGroup(plane);
}
