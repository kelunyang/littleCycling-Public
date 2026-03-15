/**
 * Building renderer: fetches building footprints from vector tiles and
 * renders them as gray extruded meshes in the Three.js scene.
 *
 * Data source options:
 * A) Hidden MapLibre instance: querySourceFeatures('building')
 * B) Direct MVT fetch + @mapbox/vector-tile + pbf decode
 *
 * Currently uses approach A (simplest, leverages existing MapLibre setup).
 * Buildings are cached with terrain chunks — same lifecycle.
 */

import * as THREE from 'three';
import type { ElevationSampler } from './elevation-sampler';
import type { MVTFeature } from './mvt-fetcher';
import { buildingColorFromCoord, createBuildingToonMaterial, GRADIENT_MAP } from './cartoon-materials';

/** Default building height when data is missing (meters). */
const DEFAULT_BUILDING_HEIGHT = 8;

/** Shared toon material for merged buildings (uses vertex colors). */
const BUILDING_MATERIAL = new THREE.MeshToonMaterial({
  vertexColors: true,
  gradientMap: GRADIENT_MAP,
  side: THREE.DoubleSide,
});

export interface BuildingFootprint {
  /** Polygon coordinates [[lon, lat], ...] — outer ring only. */
  coordinates: [number, number][];
  /** Building height in meters (from vector tile or default). */
  height: number;
}

export interface BuildingRenderResult {
  /** Combined mesh for all buildings in this chunk. */
  mesh: THREE.Mesh;
  /** Number of buildings rendered. */
  buildingCount: number;
}

/**
 * Build extruded building meshes from footprint data.
 *
 * @param footprints - Building footprint polygons with heights
 * @param sampler - Elevation sampler to get building base height
 * @param originLat - Scene floating origin latitude
 * @param originLon - Scene floating origin longitude
 * @param originEle - Scene floating origin elevation
 */
export async function buildBuildingMeshes(
  footprints: BuildingFootprint[],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
): Promise<BuildingRenderResult> {
  if (footprints.length === 0) {
    return { mesh: new THREE.Mesh(), buildingCount: 0 };
  }

  const cosOrigin = Math.cos((originLat * Math.PI) / 180);
  const geometries: THREE.BufferGeometry[] = [];

  for (const fp of footprints) {
    const shape = footprintToShape(fp.coordinates, originLat, originLon, cosOrigin);
    if (!shape) continue;

    // Get base elevation at footprint centroid
    const centroid = polygonCentroid(fp.coordinates);
    let baseEle: number;
    try {
      baseEle = await sampler.getElevation(centroid[1], centroid[0]);
    } catch {
      baseEle = originEle;
    }

    const extrudeSettings: THREE.ExtrudeGeometryOptions = {
      depth: fp.height,
      bevelEnabled: false,
    };

    const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);

    // Position: rotate from XY extrusion to XZ (horizontal) then translate up
    // ExtrudeGeometry extrudes along Z, we need to rotate to Y-up
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, baseEle - originEle, 0);

    // Assign vertex color based on building coordinate (neon spray-paint palette)
    const bColor = new THREE.Color(buildingColorFromCoord(centroid[0], centroid[1]));
    const vCount = geometry.attributes.position.count;
    const colorArr = new Float32Array(vCount * 3);
    for (let v = 0; v < vCount; v++) {
      colorArr[v * 3] = bColor.r;
      colorArr[v * 3 + 1] = bColor.g;
      colorArr[v * 3 + 2] = bColor.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));

    geometries.push(geometry);
  }

  if (geometries.length === 0) {
    return { mesh: new THREE.Mesh(), buildingCount: 0 };
  }

  // Merge all building geometries into one for efficient rendering
  const merged = mergeGeometries(geometries);

  // Dispose individual geometries
  for (const g of geometries) g.dispose();

  const mesh = new THREE.Mesh(merged, BUILDING_MATERIAL);

  return { mesh, buildingCount: footprints.length };
}

/**
 * Extract building footprints from a hidden MapLibre instance.
 * Queries the 'building' source features within the given bounds.
 */
export function extractBuildingsFromMapLibre(
  map: any,
  bounds: { south: number; north: number; west: number; east: number },
): BuildingFootprint[] {
  const footprints: BuildingFootprint[] = [];

  try {
    // Query rendered features in the building layer
    const features = map.queryRenderedFeatures(undefined, {
      layers: ['building-3d', 'building'],
    });

    if (!features || features.length === 0) return footprints;

    for (const feature of features) {
      if (feature.geometry?.type !== 'Polygon') continue;

      const coords = feature.geometry.coordinates[0] as [number, number][];
      if (!coords || coords.length < 3) continue;

      // Check if building is within our bounds
      const centroid = polygonCentroid(coords);
      if (
        centroid[1] < bounds.south ||
        centroid[1] > bounds.north ||
        centroid[0] < bounds.west ||
        centroid[0] > bounds.east
      ) {
        continue;
      }

      const height =
        feature.properties?.height ??
        feature.properties?.render_height ??
        (feature.properties?.levels ? feature.properties.levels * 3 : DEFAULT_BUILDING_HEIGHT);

      footprints.push({ coordinates: coords, height });
    }
  } catch {
    // MapLibre might not be available or layer might not exist
  }

  return footprints;
}

/**
 * Extract building footprints from MVT features (replaces MapLibre dependency).
 */
export function extractBuildingsFromMVT(
  features: MVTFeature[],
  bounds: { south: number; north: number; west: number; east: number },
): BuildingFootprint[] {
  const footprints: BuildingFootprint[] = [];

  for (const feature of features) {
    if (feature.layer !== 'building') continue;
    if (feature.geometry.type !== 'Polygon') continue;

    const coords = (feature.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][];
    if (!coords || coords.length < 3) continue;

    const centroid = polygonCentroid(coords);
    if (
      centroid[1] < bounds.south ||
      centroid[1] > bounds.north ||
      centroid[0] < bounds.west ||
      centroid[0] > bounds.east
    ) {
      continue;
    }

    const height =
      feature.properties.render_height ??
      feature.properties.height ??
      (feature.properties.levels ? feature.properties.levels * 3 : DEFAULT_BUILDING_HEIGHT);

    footprints.push({ coordinates: coords, height });
  }

  return footprints;
}

// ── Helpers ──

/** Convert a polygon [lon, lat][] to a THREE.Shape in scene meters. */
function footprintToShape(
  coordinates: [number, number][],
  originLat: number,
  originLon: number,
  cosOrigin: number,
): THREE.Shape | null {
  if (coordinates.length < 3) return null;

  const shape = new THREE.Shape();
  const first = coordinates[0];
  const x0 = (first[0] - originLon) * 111320 * cosOrigin;
  const z0 = -(first[1] - originLat) * 111320;

  shape.moveTo(x0, z0);

  for (let i = 1; i < coordinates.length; i++) {
    const x = (coordinates[i][0] - originLon) * 111320 * cosOrigin;
    const z = -(coordinates[i][1] - originLat) * 111320;
    shape.lineTo(x, z);
  }

  shape.closePath();
  return shape;
}

/** Compute centroid of a polygon. Returns [lon, lat]. */
function polygonCentroid(coords: [number, number][]): [number, number] {
  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of coords) {
    sumLon += lon;
    sumLat += lat;
  }
  return [sumLon / coords.length, sumLat / coords.length];
}

/** Simple geometry merge (no dependency on BufferGeometryUtils). */
function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0;
  let totalIndices = 0;

  for (const g of geometries) {
    totalVerts += g.attributes.position.count;
    totalIndices += g.index ? g.index.count : g.attributes.position.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);

  let vertOffset = 0;
  let idxOffset = 0;

  for (const g of geometries) {
    g.computeVertexNormals();

    const pos = g.attributes.position;
    const norm = g.attributes.normal;
    const col = g.attributes.color;
    const count = pos.count;

    for (let i = 0; i < count * 3; i++) {
      positions[vertOffset * 3 + i] = (pos.array as Float32Array)[i];
      if (norm) {
        normals[vertOffset * 3 + i] = (norm.array as Float32Array)[i];
      }
      if (col) {
        colors[vertOffset * 3 + i] = (col.array as Float32Array)[i];
      }
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
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));

  return merged;
}

/** Dispose building mesh resources. */
export function disposeBuildingMesh(result: BuildingRenderResult): void {
  result.mesh.geometry.dispose();
  // Don't dispose shared BUILDING_MATERIAL
}
