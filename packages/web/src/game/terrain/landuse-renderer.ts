/**
 * Landuse renderer: builds flat polygon meshes for the ground cover the map
 * gives us — water, parks, forests, sand, urban zones, and (since the MVT survey
 * showed we were downloading and dropping them) wetland, farmland, and pitches.
 * Overlaid on terrain with slight height offsets to prevent z-fighting.
 */

import * as THREE from 'three';
import type { ElevationSampler } from './elevation-sampler';
import type { MVTFeature } from './mvt-fetcher';
import type { TerrainStyleStrategy } from './terrain-style-strategy';

/** Height offsets above terrain to prevent z-fighting. Wetter/lower first. */
const WATER_HEIGHT_OFFSET = 0.1;
const WETLAND_HEIGHT_OFFSET = 0.09;
const PARK_HEIGHT_OFFSET = 0.05;
const FOREST_HEIGHT_OFFSET = 0.04;
const SPORTS_HEIGHT_OFFSET = 0.035;
const SAND_HEIGHT_OFFSET = 0.03;
const FARMLAND_HEIGHT_OFFSET = 0.025;
const URBAN_HEIGHT_OFFSET = 0.02;

/** One ground-cover kind: its features, the mesh built from them. */
export interface LanduseLayer {
  kind: string;
  mesh: THREE.Mesh;
  count: number;
}

export interface LanduseRenderResult {
  /** Every overlay mesh, so callers never have to enumerate the kinds by hand. */
  layers: LanduseLayer[];
}

/** All overlay meshes of a result — add/remove/shift/dispose iterate this. */
export function landuseMeshes(result: LanduseRenderResult): THREE.Mesh[] {
  return result.layers.map((l) => l.mesh);
}

/** Build flat overlay meshes for every ground-cover class we render. */
export async function buildLanduseMeshes(
  features: MVTFeature[],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
  strategy: TerrainStyleStrategy,
): Promise<LanduseRenderResult> {
  const cosOrigin = Math.cos((originLat * Math.PI) / 180);

  const urbanFeatures = features.filter(
    (f) => f.layer === 'landuse' && isUrbanLanduse(f),
  );

  // One spec per ground cover: what to match, how high to float it, and the
  // material. Adding a class means adding a row here — nothing else.
  const specs: {
    kind: string;
    match: (f: MVTFeature) => boolean;
    offset: number;
    material: () => THREE.Material;
  }[] = [
    {
      kind: 'water',
      match: (f) => f.layer === 'water',
      offset: WATER_HEIGHT_OFFSET,
      material: () => strategy.createWaterMaterial(),
    },
    {
      kind: 'wetland',
      match: (f) => f.layer === 'landcover' && isWetlandLandcover(f),
      offset: WETLAND_HEIGHT_OFFSET,
      material: () => strategy.createWetlandMaterial(),
    },
    {
      kind: 'forest',
      match: (f) => f.layer === 'landcover' && isForestLandcover(f),
      offset: FOREST_HEIGHT_OFFSET,
      material: () => strategy.createForestMaterial(),
    },
    {
      kind: 'park',
      match: (f) => f.layer === 'park' || (f.layer === 'landcover' && isParkLandcover(f)),
      offset: PARK_HEIGHT_OFFSET,
      material: () => strategy.createParkMaterial(),
    },
    {
      kind: 'sports',
      match: (f) => f.layer === 'landuse' && isSportsLanduse(f),
      offset: SPORTS_HEIGHT_OFFSET,
      material: () => strategy.createSportsFieldMaterial(),
    },
    {
      kind: 'sand',
      match: (f) => f.layer === 'landcover' && f.properties.class === 'sand',
      offset: SAND_HEIGHT_OFFSET,
      material: () => strategy.createSandMaterial(),
    },
    {
      kind: 'farmland',
      match: (f) => f.layer === 'landcover' && isFarmlandLandcover(f),
      offset: FARMLAND_HEIGHT_OFFSET,
      material: () => strategy.createFarmlandMaterial(),
    },
    {
      kind: 'urban',
      match: (f) => f.layer === 'landuse' && isUrbanLanduse(f),
      offset: URBAN_HEIGHT_OFFSET,
      // Dominant class tints the whole zone (residential ≠ industrial).
      material: () => strategy.createUrbanMaterial(getDominantUrbanColor(urbanFeatures, strategy)),
    },
  ];

  const matched = specs.map((s) => features.filter(s.match));

  const geomGroups = await Promise.all(
    specs.map((s, i) =>
      buildGeometryGroup(
        matched[i], sampler, originLat, originLon, originEle, cosOrigin, s.offset, strategy,
      ),
    ),
  );

  const layers: LanduseLayer[] = specs.map((s, i) => ({
    kind: s.kind,
    mesh: createMeshFromGeoms(geomGroups[i], s.material()),
    count: matched[i].length,
  }));

  return { layers };
}

// ── Feature classification ──

/** Check if a landcover feature is forest/wood. */
function isForestLandcover(feature: MVTFeature): boolean {
  const cls = feature.properties.class;
  return cls === 'wood' || cls === 'forest';
}

/** Check if a landcover feature is grass/park (not forest). */
function isParkLandcover(feature: MVTFeature): boolean {
  const cls = feature.properties.class;
  return cls === 'grass' || cls === 'park';
}

/** Marsh/bog. */
function isWetlandLandcover(feature: MVTFeature): boolean {
  return feature.properties.class === 'wetland';
}

/** Fields — nurseries read as fields too. */
function isFarmlandLandcover(feature: MVTFeature): boolean {
  const cls = feature.properties.class;
  return cls === 'farmland' || cls === 'plant_nursery';
}

/** Pitches, playgrounds, running tracks, stadiums — all get the court plate. */
function isSportsLanduse(feature: MVTFeature): boolean {
  const cls = feature.properties.class;
  return cls === 'pitch' || cls === 'playground' || cls === 'track' || cls === 'stadium';
}

/**
 * Urban ground. Institutional grounds (schools, hospitals, campuses) are folded
 * in deliberately: they read as built-up land, and their buildings already come
 * from the `building` layer — no separate art needed for the ground they sit on.
 */
function isUrbanLanduse(feature: MVTFeature): boolean {
  const cls = feature.properties.class;
  return (
    cls === 'residential' || cls === 'commercial' || cls === 'industrial' || cls === 'retail' ||
    cls === 'school' || cls === 'hospital' || cls === 'university' || cls === 'college' ||
    cls === 'kindergarten' || cls === 'library' || cls === 'education'
  );
}

/** Get the most common urban color from a set of urban features. */
function getDominantUrbanColor(
  urbanFeatures: MVTFeature[],
  strategy: TerrainStyleStrategy,
): number {
  if (urbanFeatures.length === 0) return strategy.urbanColor('residential');
  const counts: Record<string, number> = {};
  for (const f of urbanFeatures) {
    const cls = (f.properties.class as string) || 'residential';
    counts[cls] = (counts[cls] || 0) + 1;
  }
  let dominant = 'residential';
  let maxCount = 0;
  for (const [cls, count] of Object.entries(counts)) {
    if (count > maxCount) { dominant = cls; maxCount = count; }
  }
  return strategy.urbanColor(dominant);
}

// ── Geometry helpers ──

/** Build geometries for a group of features. */
async function buildGeometryGroup(
  features: MVTFeature[],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
  cosOrigin: number,
  heightOffset: number,
  strategy: TerrainStyleStrategy,
): Promise<THREE.BufferGeometry[]> {
  const geometries: THREE.BufferGeometry[] = [];
  for (const feature of features) {
    const polys = extractPolygonCoords(feature);
    for (const coords of polys) {
      const geom = await buildFlatPolygon(
        coords, sampler, originLat, originLon, originEle, cosOrigin, heightOffset, strategy,
      );
      if (geom) geometries.push(geom);
    }
  }
  return geometries;
}

/** Create a mesh from geometries, or an empty mesh if none. */
function createMeshFromGeoms(
  geoms: THREE.BufferGeometry[],
  material: THREE.Material,
): THREE.Mesh {
  if (geoms.length === 0) {
    material.dispose();
    return new THREE.Mesh();
  }
  const merged = mergeGeometries(geoms);
  for (const g of geoms) g.dispose();
  return new THREE.Mesh(merged, material);
}

/** Extract polygon coordinate rings from a feature (handles Polygon and MultiPolygon). */
export function extractPolygonCoords(feature: MVTFeature): [number, number][][] {
  const geom = feature.geometry;
  if (geom.type === 'Polygon') {
    return [(geom as GeoJSON.Polygon).coordinates[0] as [number, number][]];
  }
  if (geom.type === 'MultiPolygon') {
    return (geom as GeoJSON.MultiPolygon).coordinates.map(
      (poly) => poly[0] as [number, number][],
    );
  }
  return [];
}

/**
 * Build a flat triangulated polygon mesh at terrain elevation.
 */
async function buildFlatPolygon(
  coords: [number, number][],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
  cosOrigin: number,
  heightOffset: number,
  strategy: TerrainStyleStrategy,
): Promise<THREE.BufferGeometry | null> {
  if (coords.length < 3) return null;

  // Convert to scene coordinates
  const shape = new THREE.Shape();
  const first = coords[0];
  const x0 = (first[0] - originLon) * 111320 * cosOrigin;
  const z0 = -(first[1] - originLat) * 111320;
  shape.moveTo(x0, z0);

  for (let i = 1; i < coords.length; i++) {
    const x = (coords[i][0] - originLon) * 111320 * cosOrigin;
    const z = -(coords[i][1] - originLat) * 111320;
    shape.lineTo(x, z);
  }
  shape.closePath();

  // Create flat geometry from shape
  const shapeGeom = new THREE.ShapeGeometry(shape);

  // Get elevation at centroid for the whole polygon
  let sumLon = 0, sumLat = 0;
  for (const [lon, lat] of coords) {
    sumLon += lon;
    sumLat += lat;
  }
  const cLon = sumLon / coords.length;
  const cLat = sumLat / coords.length;

  let baseEle: number;
  try {
    baseEle = await sampler.getElevation(cLat, cLon);
  } catch {
    baseEle = originEle;
  }

  const y = strategy.quantizeElevation(baseEle) - originEle + heightOffset;

  // ShapeGeometry produces geometry in XY plane, we need XZ
  // Rotate -90° around X to lay flat, then translate to correct height
  shapeGeom.rotateX(-Math.PI / 2);
  shapeGeom.translate(0, y, 0);

  return shapeGeom;
}

/** Simple geometry merge. */
function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0;
  let totalIndices = 0;

  for (const g of geometries) {
    totalVerts += g.attributes.position.count;
    totalIndices += g.index ? g.index.count : g.attributes.position.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);

  let vertOffset = 0;
  let idxOffset = 0;

  for (const g of geometries) {
    g.computeVertexNormals();

    const pos = g.attributes.position;
    const norm = g.attributes.normal;
    const count = pos.count;

    for (let i = 0; i < count * 3; i++) {
      positions[vertOffset * 3 + i] = (pos.array as Float32Array)[i];
      if (norm) normals[vertOffset * 3 + i] = (norm.array as Float32Array)[i];
    }

    if (g.index) {
      for (let i = 0; i < g.index.count; i++) {
        indices[idxOffset + i] = g.index.array[i] + vertOffset;
      }
      idxOffset += g.index.count;
    } else {
      for (let i = 0; i < count; i++) {
        indices[idxOffset + i] = vertOffset + i;
      }
      idxOffset += count;
    }

    vertOffset += count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));

  return merged;
}

/** Dispose all landuse mesh resources. */
export function disposeLanduseMeshes(result: LanduseRenderResult): void {
  for (const mesh of landuseMeshes(result)) {
    mesh.geometry.dispose();
    if (mesh.material instanceof THREE.Material) mesh.material.dispose();
  }
}
