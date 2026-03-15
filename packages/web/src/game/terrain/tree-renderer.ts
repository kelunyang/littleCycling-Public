/**
 * Tree renderer: places low-poly cartoon trees (cone + cylinder) in forest
 * polygons using THREE.InstancedMesh for efficient rendering.
 *
 * Each chunk produces a single InstancedMesh draw call.
 * Typical: 200-300 trees × ~100 triangles = 20-30K triangles/chunk.
 */

import * as THREE from 'three';
import type { ElevationSampler } from './elevation-sampler';
import type { MVTFeature } from './mvt-fetcher';
import { extractPolygonCoords } from './landuse-renderer';
import { pointInPolygon } from './zone-detector';
import {
  TREE_TRUNK_COLOR,
  TREE_CANOPY_COLORS,
  GRADIENT_MAP,
} from './cartoon-materials';

/** Grid spacing for tree placement in meters. */
const TREE_GRID_SPACING = 20;

/** Random jitter range in meters (±). */
const TREE_JITTER = 5;

/** Maximum trees per chunk. */
const MAX_TREES_PER_CHUNK = 300;

/** Tree geometry dimensions (meters). */
const TRUNK_RADIUS_BOTTOM = 0.35;
const TRUNK_RADIUS_TOP = 0.2;
const TRUNK_HEIGHT = 1.8;
const TRUNK_SEGMENTS = 5;

const CANOPY_RADIUS = 2.5;
const CANOPY_HEIGHT = 5;
const CANOPY_SEGMENTS = 6;

export interface TreeRenderResult {
  mesh: THREE.InstancedMesh;
  treeCount: number;
}

/**
 * Build an InstancedMesh of cartoon trees placed within forest polygons.
 */
export async function buildTreeMeshes(
  forestFeatures: MVTFeature[],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
): Promise<TreeRenderResult> {
  const cosOrigin = Math.cos((originLat * Math.PI) / 180);

  // Collect all forest polygon rings
  const forestPolygons: [number, number][][] = [];
  for (const f of forestFeatures) {
    const polys = extractPolygonCoords(f);
    for (const ring of polys) {
      if (ring.length >= 3) forestPolygons.push(ring);
    }
  }

  if (forestPolygons.length === 0) {
    return { mesh: new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), 0), treeCount: 0 };
  }

  // Generate tree positions using grid sampling + jitter + point-in-polygon
  const treePositions: { lon: number; lat: number }[] = [];

  for (const ring of forestPolygons) {
    if (treePositions.length >= MAX_TREES_PER_CHUNK) break;

    // Compute bounding box of polygon (in lon/lat)
    let minLon = Infinity, maxLon = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }

    // Convert grid spacing from meters to degrees
    const gridStepLon = TREE_GRID_SPACING / (111320 * cosOrigin);
    const gridStepLat = TREE_GRID_SPACING / 111320;
    const jitterLon = TREE_JITTER / (111320 * cosOrigin);
    const jitterLat = TREE_JITTER / 111320;

    // Grid sampling within bounding box
    for (let lon = minLon; lon <= maxLon; lon += gridStepLon) {
      for (let lat = minLat; lat <= maxLat; lat += gridStepLat) {
        if (treePositions.length >= MAX_TREES_PER_CHUNK) break;

        // Deterministic jitter from position hash
        const hash = deterministicHash(lon, lat);
        const jLon = (hashFloat(hash, 0) - 0.5) * 2 * jitterLon;
        const jLat = (hashFloat(hash, 1) - 0.5) * 2 * jitterLat;
        const testLon = lon + jLon;
        const testLat = lat + jLat;

        if (pointInPolygon(testLon, testLat, ring)) {
          treePositions.push({ lon: testLon, lat: testLat });
        }
      }
    }
  }

  if (treePositions.length === 0) {
    return { mesh: new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial(), 0), treeCount: 0 };
  }

  // Build combined tree geometry (trunk + canopy) with vertex colors
  const treeGeometry = buildTreeGeometry();

  // Create material
  const material = new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap: GRADIENT_MAP,
    side: THREE.DoubleSide,
  });

  const count = treePositions.length;
  const instancedMesh = new THREE.InstancedMesh(treeGeometry, material, count);

  // Set instance colors (canopy color variation per tree)
  const instanceColor = new THREE.Color();
  const dummy = new THREE.Object3D();

  for (let i = 0; i < count; i++) {
    const { lon, lat } = treePositions[i];

    // Scene coordinates
    const x = (lon - originLon) * 111320 * cosOrigin;
    const z = -(lat - originLat) * 111320;

    // Elevation
    let ele: number;
    try {
      ele = await sampler.getElevation(lat, lon);
    } catch {
      ele = originEle;
    }
    const y = ele - originEle;

    // Deterministic scale and rotation from position
    const hash = deterministicHash(lon, lat);
    const scale = 0.7 + hashFloat(hash, 2) * 0.7; // 0.7 ~ 1.4
    const rotY = hashFloat(hash, 3) * Math.PI * 2;

    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rotY, 0);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    instancedMesh.setMatrixAt(i, dummy.matrix);

    // Per-instance canopy color variation
    const colorIdx = Math.floor(hashFloat(hash, 4) * TREE_CANOPY_COLORS.length) % TREE_CANOPY_COLORS.length;
    instanceColor.setHex(TREE_CANOPY_COLORS[colorIdx]);
    instancedMesh.setColorAt(i, instanceColor);
  }

  instancedMesh.instanceMatrix.needsUpdate = true;
  if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;

  return { mesh: instancedMesh, treeCount: count };
}

/**
 * Build combined trunk + canopy geometry with vertex colors baked in.
 */
function buildTreeGeometry(): THREE.BufferGeometry {
  // Trunk — cylinder
  const trunkGeom = new THREE.CylinderGeometry(
    TRUNK_RADIUS_TOP, TRUNK_RADIUS_BOTTOM, TRUNK_HEIGHT, TRUNK_SEGMENTS,
  );
  // Position trunk so bottom sits at y=0
  trunkGeom.translate(0, TRUNK_HEIGHT / 2, 0);

  // Canopy — cone
  const canopyGeom = new THREE.ConeGeometry(
    CANOPY_RADIUS, CANOPY_HEIGHT, CANOPY_SEGMENTS,
  );
  // Position canopy on top of trunk
  canopyGeom.translate(0, TRUNK_HEIGHT + CANOPY_HEIGHT / 2, 0);

  // Bake vertex colors
  const trunkColor = new THREE.Color(TREE_TRUNK_COLOR);
  const canopyColor = new THREE.Color(TREE_CANOPY_COLORS[0]); // base green

  addVertexColors(trunkGeom, trunkColor);
  addVertexColors(canopyGeom, canopyColor);

  // Merge into one geometry
  const merged = mergeTreeGeometries(trunkGeom, canopyGeom);

  trunkGeom.dispose();
  canopyGeom.dispose();

  return merged;
}

/** Add a uniform vertex color attribute to a geometry. */
function addVertexColors(geom: THREE.BufferGeometry, color: THREE.Color): void {
  const count = geom.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Merge two indexed geometries into one. */
function mergeTreeGeometries(
  a: THREE.BufferGeometry,
  b: THREE.BufferGeometry,
): THREE.BufferGeometry {
  // Ensure both have normals
  a.computeVertexNormals();
  b.computeVertexNormals();

  const aPos = a.attributes.position;
  const bPos = b.attributes.position;
  const aNorm = a.attributes.normal;
  const bNorm = b.attributes.normal;
  const aColor = a.attributes.color;
  const bColor = b.attributes.color;

  const totalVerts = aPos.count + bPos.count;
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);

  // Copy A
  for (let i = 0; i < aPos.count * 3; i++) {
    positions[i] = (aPos.array as Float32Array)[i];
    normals[i] = (aNorm.array as Float32Array)[i];
    colors[i] = (aColor.array as Float32Array)[i];
  }

  // Copy B (offset)
  const offset = aPos.count * 3;
  for (let i = 0; i < bPos.count * 3; i++) {
    positions[offset + i] = (bPos.array as Float32Array)[i];
    normals[offset + i] = (bNorm.array as Float32Array)[i];
    colors[offset + i] = (bColor.array as Float32Array)[i];
  }

  // Merge indices
  const aIdx = a.index;
  const bIdx = b.index;
  const aIdxCount = aIdx ? aIdx.count : aPos.count;
  const bIdxCount = bIdx ? bIdx.count : bPos.count;
  const indices = new Uint32Array(aIdxCount + bIdxCount);

  if (aIdx) {
    for (let i = 0; i < aIdx.count; i++) indices[i] = aIdx.array[i];
  } else {
    for (let i = 0; i < aPos.count; i++) indices[i] = i;
  }

  const vertOffset = aPos.count;
  if (bIdx) {
    for (let i = 0; i < bIdx.count; i++) indices[aIdxCount + i] = bIdx.array[i] + vertOffset;
  } else {
    for (let i = 0; i < bPos.count; i++) indices[aIdxCount + i] = i + vertOffset;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));

  return merged;
}

// ── Deterministic hash helpers ──

/** Simple integer hash from two floats. */
function deterministicHash(a: number, b: number): number {
  // Quantize to ~1m precision then hash
  const ia = Math.round(a * 100000);
  const ib = Math.round(b * 100000);
  let h = (ia * 2654435761) ^ (ib * 2246822519);
  h = ((h >>> 16) ^ h) * 0x45d9f3b;
  h = ((h >>> 16) ^ h) * 0x45d9f3b;
  h = (h >>> 16) ^ h;
  return h >>> 0; // unsigned 32-bit
}

/** Extract a float in [0, 1) from a hash using a channel index. */
function hashFloat(hash: number, channel: number): number {
  const mixed = (hash * (channel + 1) * 2654435761) >>> 0;
  return (mixed & 0xffff) / 0x10000;
}

/** Dispose tree mesh resources. */
export function disposeTreeMesh(result: TreeRenderResult): void {
  result.mesh.geometry.dispose();
  if (result.mesh.material instanceof THREE.Material) {
    result.mesh.material.dispose();
  }
}
