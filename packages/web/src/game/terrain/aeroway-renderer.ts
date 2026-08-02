/**
 * Aeroway renderer: runways, taxiways, aprons — and one toy aircraft parked at
 * each aerodrome.
 *
 * Small in the survey (~77 features, and only on some routes), but an airfield
 * is unmistakable when you ride past one, and the plane ornament is the payoff:
 * cuphead gets a tethered plane-shaped BALLOON, plastic a brick plane.
 */

import * as THREE from 'three';
import { applyOverlayDepth } from './overlay-depth';
import type { ElevationSampler } from './elevation-sampler';
import type { MVTFeature } from './mvt-fetcher';
import type { TerrainStyleStrategy } from './terrain-style-strategy';
import { disposeGroup } from './bike-ornament';
import { buildGroundRibbon, mergeRibbonGeometries, type GroundFn } from './ribbon-geometry';
import { createYielder } from './build-yield';
import { emptyMesh } from './empty-mesh';

/** Just above the ground, below the roads (0.3) — apron is painted ON the land. */
export const PAVING_HEIGHT_OFFSET = 0.12;

/** Ribbon widths in metres. A runway is the widest thing on the map. */
const RUNWAY_WIDTH = 30;
const TAXIWAY_WIDTH = 15;

/** Grey concrete — deliberately flat, so the style's toy palette stays the star. */
const PAVING_COLOR = 0x9aa0a8;

/**
 * The paving material is identical across chunks, so share one per strategy
 * instead of minting a fresh one — and GL program — per chunk. WeakMap keyed by
 * the strategy so a style switch starts fresh and the old entry is GC'd with the
 * old strategy. Tagged `userData.shared` so `disposeAerowayMeshes` skips it.
 */
const pavingMaterialCache = new WeakMap<TerrainStyleStrategy, THREE.Material>();

function sharedPavingMaterial(strategy: TerrainStyleStrategy): THREE.Material {
  let mat = pavingMaterialCache.get(strategy);
  if (!mat) {
    mat = strategy.createRoadMaterial(PAVING_COLOR);
    applyOverlayDepth(mat, 'aeroway');
    mat.userData.shared = true;
    pavingMaterialCache.set(strategy, mat);
  }
  return mat;
}

/**
 * Which `aeroway` features this renderer can actually turn into geometry.
 *
 * Two shapes and nothing else: a runway/taxiway CENTRELINE becomes a ribbon, and
 * any polygon (apron, aerodrome, helipad) becomes a slab. Everything else in the
 * layer is a POINT, and the layer's points are `gate` — the numbered stand where
 * an airliner parks at a terminal.
 *
 * ## The data is there; the geometry never was
 *
 * Measured through the production `decodeMVTTile` over 3×3 z14 windows on
 * OpenFreeMap (fetched at run time, nothing stored — CLAUDE.md 外部資料源;
 * `plan/DEMO_POC_GUIDE.md` §4 allows the statistic):
 *
 * ```
 *   Narita   gate 105 (Point)   taxiway 578   apron 10   aerodrome 7   runway 5
 *   Taipei   gate  13 (Point)   taxiway  51   apron 12   aerodrome 4   runway 2
 *   ── 308 gates across nine windows, every one of them a Point ──
 * ```
 *
 * So this is not "the selector is wrong". A gate is a label on a parking space:
 * it has no extent, no demo draws one (`props-vs-demo.ts` pins that no demo
 * draws an aeroway prop at all beyond the aerodrome's one toy aircraft), and
 * inventing a stand marker for three worlds is exactly what
 * `plan/DEMO_POC_GUIDE.md` §1 says nobody will ever be able to diff.
 *
 * ## Why filtering matters even though the answer is "draw nothing"
 *
 * `featureCount` used to count gates. It is what `TerrainChunkManager` tests to
 * decide whether the chunk HAS an aeroway result — so a chunk whose only aeroway
 * content was gates minted the `geometries.length === 0` mesh below, added it to
 * the scene, and paid **one draw call, one unique geometry and one unique
 * material** (three's defaults) for zero pixels, on the two metrics
 * CUSTOM_WORLD_INSTRUCTIONS §6 ranks second and third. "We do not draw it" and
 * "we do not carry it" have to be the same statement.
 */
function isDrawableAeroway(f: MVTFeature): boolean {
  const cls = String(f.properties.class ?? '');
  const type = f.geometry?.type;
  if (type === 'LineString' || type === 'MultiLineString') {
    return cls === 'runway' || cls === 'taxiway';
  }
  return type === 'Polygon' || type === 'MultiPolygon';
}

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
  owns: (lon: number, lat: number) => boolean = () => true,
): Promise<AerowayRenderResult> {
  const aeroways = features.filter((f) => f.layer === 'aeroway' && isDrawableAeroway(f));
  if (aeroways.length === 0) {
    return { mesh: emptyMesh(), planes: [], featureCount: 0 };
  }

  const cosOrigin = Math.cos((originLat * Math.PI) / 180);
  const proj = { originLat, originLon, cosOrigin };
  const geometries: THREE.BufferGeometry[] = [];
  const planes: THREE.Group[] = [];

  const maybeYield = createYielder();

  for (const f of aeroways) {
    await maybeYield();
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
        const geom = buildGroundRibbon(coords, proj, ground, {
          halfWidth: width / 2,
          heightOffset: PAVING_HEIGHT_OFFSET,
          emitUv: true,
          keep: owns,
        });
        if (geom) geometries.push(geom);
      }
      continue;
    }

    // Aprons/aerodromes are polygons → flat slabs. One owner per ring, so the
    // overlap band doesn't get a z-fighting twin from the neighbour chunk.
    if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
      const rings =
        f.geometry.type === 'Polygon'
          ? [(f.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][]]
          : (f.geometry as GeoJSON.MultiPolygon).coordinates.map(
              (poly) => poly[0] as [number, number][],
            );
      for (const ring of rings) {
        let cLon = 0, cLat = 0;
        for (const [lon, lat] of ring) { cLon += lon; cLat += lat; }
        if (!owns(cLon / ring.length, cLat / ring.length)) continue;
        const geom = await buildSlabGeometry(
          ring, sampler, originLat, originLon, originEle, cosOrigin, strategy, ground,
        );
        if (geom) geometries.push(geom);
      }

      // Park one aircraft at the aerodrome's centre.
      if (cls === 'aerodrome') {
        // Same one-owner rule, or every overlapping chunk parks its own plane.
        const first = rings[0];
        let pLon = 0, pLat = 0;
        for (const [lon, lat] of first) { pLon += lon; pLat += lat; }
        if (first.length > 0 && owns(pLon / first.length, pLat / first.length)) {
          const plane = await buildParkedPlane(
            f, sampler, originLat, originLon, originEle, cosOrigin, strategy, ground,
          );
          if (plane) planes.push(plane);
        }
      }
    }
  }

  // Every drawable feature belonged to a neighbouring chunk. `emptyMesh` rather
  // than `new THREE.Mesh()`: see empty-mesh.ts — this was one of the fourteen.
  if (geometries.length === 0) {
    return { mesh: emptyMesh(), planes, featureCount: aeroways.length };
  }

  const merged = mergeRibbonGeometries(geometries);
  for (const g of geometries) g.dispose();

  const material = sharedPavingMaterial(strategy);
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

  // rotateX(-90°) maps shape-Y to NEGATIVE world-Z: store +latitude metres
  // (NOT scene z) or the slab mirrors across the origin's east-west axis — the
  // April bug family that parked a phantom Songshan apron on the far horizon.
  // Ring order reversed so the winding (face orientation) is kept.
  const shape = new THREE.Shape();
  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of coords) {
    sumLon += lon;
    sumLat += lat;
  }
  const lastPt = coords[coords.length - 1];
  shape.moveTo(
    (lastPt[0] - originLon) * 111320 * cosOrigin,
    (lastPt[1] - originLat) * 111320,
  );
  for (let i = coords.length - 2; i >= 0; i--) {
    shape.lineTo(
      (coords[i][0] - originLon) * 111320 * cosOrigin,
      (coords[i][1] - originLat) * 111320,
    );
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
  // `userData.shared` guards the empty singleton the same way it guards the
  // paving material below — an empty result must not free what every other
  // empty result is still pointing at.
  if (!result.mesh.geometry.userData?.shared) result.mesh.geometry.dispose();
  const mat = result.mesh.material;
  if (mat instanceof THREE.Material && !mat.userData.shared) mat.dispose();
  for (const plane of result.planes) disposeGroup(plane);
}
