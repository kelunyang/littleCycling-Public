/**
 * Landuse renderer: builds flat polygon meshes for water, parks, forests,
 * sand, and urban zones from MVT features.
 * Overlaid on terrain with slight height offsets to prevent z-fighting.
 */

import * as THREE from 'three';
import type { ElevationSampler } from './elevation-sampler';
import type { MVTFeature } from './mvt-fetcher';
import {
  createWaterToonMaterial,
  createParkToonMaterial,
  createForestToonMaterial,
  createSandToonMaterial,
  createUrbanToonMaterial,
  urbanColorForClass,
} from './cartoon-materials';

/** Height offsets above terrain to prevent z-fighting. */
const WATER_HEIGHT_OFFSET = 0.1;
const PARK_HEIGHT_OFFSET = 0.05;
const FOREST_HEIGHT_OFFSET = 0.04;
const SAND_HEIGHT_OFFSET = 0.03;
const URBAN_HEIGHT_OFFSET = 0.02;

export interface LanduseRenderResult {
  waterMesh: THREE.Mesh;
  parkMesh: THREE.Mesh;
  forestMesh: THREE.Mesh;
  sandMesh: THREE.Mesh;
  urbanMesh: THREE.Mesh;
  waterCount: number;
  parkCount: number;
  forestCount: number;
  sandCount: number;
  urbanCount: number;
}

/**
 * Build flat overlay meshes for water, park, forest, sand, and urban features.
 */
export async function buildLanduseMeshes(
  features: MVTFeature[],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
): Promise<LanduseRenderResult> {
  const cosOrigin = Math.cos((originLat * Math.PI) / 180);

  // Classify features into categories
  const waterFeatures = features.filter((f) => f.layer === 'water');

  const forestFeatures = features.filter(
    (f) => f.layer === 'landcover' && isForestLandcover(f),
  );

  const parkFeatures = features.filter(
    (f) => f.layer === 'park' || (f.layer === 'landcover' && isParkLandcover(f)),
  );

  const sandFeatures = features.filter(
    (f) => f.layer === 'landcover' && f.properties.class === 'sand',
  );

  const urbanFeatures = features.filter(
    (f) => f.layer === 'landuse' && isUrbanLanduse(f),
  );

  // Build geometry groups in parallel
  const [waterGeoms, forestGeoms, parkGeoms, sandGeoms, urbanGeoms] = await Promise.all([
    buildGeometryGroup(waterFeatures, sampler, originLat, originLon, originEle, cosOrigin, WATER_HEIGHT_OFFSET),
    buildGeometryGroup(forestFeatures, sampler, originLat, originLon, originEle, cosOrigin, FOREST_HEIGHT_OFFSET),
    buildGeometryGroup(parkFeatures, sampler, originLat, originLon, originEle, cosOrigin, PARK_HEIGHT_OFFSET),
    buildGeometryGroup(sandFeatures, sampler, originLat, originLon, originEle, cosOrigin, SAND_HEIGHT_OFFSET),
    buildGeometryGroup(urbanFeatures, sampler, originLat, originLon, originEle, cosOrigin, URBAN_HEIGHT_OFFSET),
  ]);

  // Determine dominant urban color (most frequent class)
  const urbanColor = getDominantUrbanColor(urbanFeatures);

  const waterMesh = createMeshFromGeoms(waterGeoms, createWaterToonMaterial());
  const forestMesh = createMeshFromGeoms(forestGeoms, createForestToonMaterial());
  const parkMesh = createMeshFromGeoms(parkGeoms, createParkToonMaterial());
  const sandMesh = createMeshFromGeoms(sandGeoms, createSandToonMaterial());
  const urbanMesh = createMeshFromGeoms(urbanGeoms, createUrbanToonMaterial(urbanColor));

  return {
    waterMesh,
    parkMesh,
    forestMesh,
    sandMesh,
    urbanMesh,
    waterCount: waterFeatures.length,
    parkCount: parkFeatures.length,
    forestCount: forestFeatures.length,
    sandCount: sandFeatures.length,
    urbanCount: urbanFeatures.length,
  };
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

/** Check if a landuse feature is urban. */
function isUrbanLanduse(feature: MVTFeature): boolean {
  const cls = feature.properties.class;
  return cls === 'residential' || cls === 'commercial' || cls === 'industrial' || cls === 'retail';
}

/** Get the most common urban color from a set of urban features. */
function getDominantUrbanColor(urbanFeatures: MVTFeature[]): number {
  if (urbanFeatures.length === 0) return 0xb0bec5; // default residential gray
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
  return urbanColorForClass(dominant);
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
): Promise<THREE.BufferGeometry[]> {
  const geometries: THREE.BufferGeometry[] = [];
  for (const feature of features) {
    const polys = extractPolygonCoords(feature);
    for (const coords of polys) {
      const geom = await buildFlatPolygon(
        coords, sampler, originLat, originLon, originEle, cosOrigin, heightOffset,
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

  const y = baseEle - originEle + heightOffset;

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
  const meshes = [
    result.waterMesh, result.parkMesh, result.forestMesh,
    result.sandMesh, result.urbanMesh,
  ];
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    if (mesh.material instanceof THREE.Material) mesh.material.dispose();
  }
}
