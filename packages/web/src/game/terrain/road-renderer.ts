/**
 * Road renderer: builds 3D ribbon meshes from MVT transportation features.
 *
 * Each road polyline becomes a triangle-strip ribbon projected onto the terrain.
 * Roads are merged into a single mesh per chunk for efficient draw calls.
 */

import * as THREE from 'three';
import type { ElevationSampler } from './elevation-sampler';
import type { MVTFeature } from './mvt-fetcher';
import {
  roadWidthForClass,
  roadColorForClass,
  createRoadToonMaterial,
  GRADIENT_MAP,
} from './cartoon-materials';

/** Road height above terrain to prevent z-fighting. */
const ROAD_HEIGHT_OFFSET = 0.3;

export interface RoadRenderResult {
  mesh: THREE.Mesh;
  roadCount: number;
}

/**
 * Build road ribbon meshes from MVT transportation features.
 */
export async function buildRoadMeshes(
  features: MVTFeature[],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
): Promise<RoadRenderResult> {
  const roads = features.filter(
    (f) => f.layer === 'transportation' && f.geometry.type === 'LineString',
  );
  // Also handle MultiLineString
  const multiRoads = features.filter(
    (f) => f.layer === 'transportation' && f.geometry.type === 'MultiLineString',
  );

  if (roads.length === 0 && multiRoads.length === 0) {
    return { mesh: new THREE.Mesh(), roadCount: 0 };
  }

  const cosOrigin = Math.cos((originLat * Math.PI) / 180);
  const geometries: THREE.BufferGeometry[] = [];
  const materialMap = new Map<number, THREE.MeshToonMaterial>();

  // Process LineString roads
  for (const road of roads) {
    const coords = (road.geometry as GeoJSON.LineString).coordinates as [number, number][];
    const roadClass = (road.properties.class as string) || 'minor';
    const geom = await buildRibbonGeometry(
      coords, roadClass, sampler, originLat, originLon, originEle, cosOrigin,
    );
    if (geom) geometries.push(geom);
  }

  // Process MultiLineString roads
  for (const road of multiRoads) {
    const lines = (road.geometry as GeoJSON.MultiLineString).coordinates as [number, number][][];
    const roadClass = (road.properties.class as string) || 'minor';
    for (const coords of lines) {
      const geom = await buildRibbonGeometry(
        coords, roadClass, sampler, originLat, originLon, originEle, cosOrigin,
      );
      if (geom) geometries.push(geom);
    }
  }

  if (geometries.length === 0) {
    return { mesh: new THREE.Mesh(), roadCount: 0 };
  }

  // Merge all geometries
  const merged = mergeGeometries(geometries);
  for (const g of geometries) g.dispose();

  // Use a single dark road material (most common color)
  const material = createRoadToonMaterial(0x3a3a3a);

  const mesh = new THREE.Mesh(merged, material);
  return { mesh, roadCount: roads.length + multiRoads.length };
}

/**
 * Build a triangle-strip ribbon geometry for a road polyline.
 */
async function buildRibbonGeometry(
  coords: [number, number][],
  roadClass: string,
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
  cosOrigin: number,
): Promise<THREE.BufferGeometry | null> {
  if (coords.length < 2) return null;

  const halfWidth = roadWidthForClass(roadClass) / 2;
  const vertCount = coords.length * 2;
  const positions = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);
  const indices: number[] = [];

  const roadColor = new THREE.Color(roadColorForClass(roadClass));

  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];

    // Convert geo to scene coordinates (same as building-renderer)
    const x = (lon - originLon) * 111320 * cosOrigin;
    const z = -(lat - originLat) * 111320;

    // Get elevation
    let ele: number;
    try {
      ele = await sampler.getElevation(lat, lon);
    } catch {
      ele = originEle;
    }
    const y = ele - originEle + ROAD_HEIGHT_OFFSET;

    // Compute perpendicular direction for ribbon width
    let dx: number, dz: number;
    if (i < coords.length - 1) {
      const nextLon = coords[i + 1][0];
      const nextLat = coords[i + 1][1];
      dx = (nextLon - lon) * 111320 * cosOrigin;
      dz = -(nextLat - lat) * 111320;
    } else {
      const prevLon = coords[i - 1][0];
      const prevLat = coords[i - 1][1];
      dx = (lon - prevLon) * 111320 * cosOrigin;
      dz = -(lat - prevLat) * 111320;
    }

    // Perpendicular (rotate 90 degrees)
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) continue; // degenerate segment
    const px = -dz / len * halfWidth;
    const pz = dx / len * halfWidth;

    // Left and right vertices
    const vi = i * 2;
    positions[vi * 3] = x + px;
    positions[vi * 3 + 1] = y;
    positions[vi * 3 + 2] = z + pz;

    positions[(vi + 1) * 3] = x - px;
    positions[(vi + 1) * 3 + 1] = y;
    positions[(vi + 1) * 3 + 2] = z - pz;

    // Vertex colors
    colors[vi * 3] = roadColor.r;
    colors[vi * 3 + 1] = roadColor.g;
    colors[vi * 3 + 2] = roadColor.b;
    colors[(vi + 1) * 3] = roadColor.r;
    colors[(vi + 1) * 3 + 1] = roadColor.g;
    colors[(vi + 1) * 3 + 2] = roadColor.b;

    // Triangle strip indices
    if (i < coords.length - 1) {
      const a = vi, b = vi + 1, c = vi + 2, d = vi + 3;
      indices.push(a, b, c);
      indices.push(b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

/** Simple geometry merge. */
function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0;
  let totalIndices = 0;

  for (const g of geometries) {
    totalVerts += g.attributes.position.count;
    totalIndices += g.index ? g.index.count : 0;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);

  let vertOffset = 0;
  let idxOffset = 0;

  for (const g of geometries) {
    const pos = g.attributes.position;
    const norm = g.attributes.normal;
    const col = g.attributes.color;
    const count = pos.count;

    for (let i = 0; i < count * 3; i++) {
      positions[vertOffset * 3 + i] = (pos.array as Float32Array)[i];
      if (norm) normals[vertOffset * 3 + i] = (norm.array as Float32Array)[i];
      if (col) colors[vertOffset * 3 + i] = (col.array as Float32Array)[i];
    }

    if (g.index) {
      for (let i = 0; i < g.index.count; i++) {
        indices[idxOffset + i] = g.index.array[i] + vertOffset;
      }
      idxOffset += g.index.count;
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

/** Dispose road mesh resources. */
export function disposeRoadMesh(result: RoadRenderResult): void {
  result.mesh.geometry.dispose();
  if (result.mesh.material instanceof THREE.Material) {
    result.mesh.material.dispose();
  }
}
