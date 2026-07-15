/**
 * Ground-hugging ribbons — the shared spine of roads, waterways and runways.
 *
 * ## Why this exists
 *
 * These three all used to build their own ribbon, and all three sank into the
 * terrain. The terrain is a staircase: each cell's tread is
 * `round(AVERAGE of its 4 corner DEM samples / layerHeight) * layerHeight`
 * (`quantized-terrain.ts`). The ribbons instead took a POINT DEM sample at each
 * raw MVT vertex and quantised that on its own. Two different functions:
 *
 *  - near a layer boundary, `round(point)` lands a whole step (6 m plastic /
 *    12 m paper) below `round(cell average)` → the road is buried in the tread
 *    it is supposed to sit on;
 *  - MVT vertices can be tens of metres apart, so the straight chord between
 *    them cuts clean through any step that rises in between.
 *
 * Meanwhile the route line raycasts the REAL terrain mesh, so it correctly sat
 * on top of the staircase — which is why the world looked like "the road is
 * underground and the guide line is flying".
 *
 * ## The fix
 *
 * Resample the centreline every few metres and put every vertex on the actual
 * terrain surface, exactly the way the street lamps, coins and checkpoint flags
 * already do (`chunkManager.raycastGroundHeight`). The quantised formula stays
 * only as a fallback for when the ray misses (a chunk that has not streamed in
 * yet), so nothing ever ends up with no height at all.
 */

import * as THREE from 'three';

/** Ground height at a scene-space (x, z), or null if no terrain is there yet. */
export type GroundFn = (x: number, z: number) => number | null;

/**
 * Metres between resampled vertices. The route line uses 6 m; roads carry far
 * more geometry, so 8 m keeps the cost down while still tracking the treads
 * (a cell is 24–32 m across, so this is ~3–4 samples per step).
 */
export const RIBBON_STEP_M = 8;

export interface GroundRibbonOptions {
  /** Half the ribbon's width, in metres. */
  halfWidth: number;
  /** Metres above the ground the ribbon floats (road 0.3, water 0.15, …). */
  heightOffset: number;
  resampleStepM?: number;
  /** Per-vertex colour (roads tint by class). */
  color?: THREE.Color;
  /** Emit uv: u = metres along the ribbon, v = 0/1 across it (dashes, tape). */
  emitUv?: boolean;
}

export interface RibbonProjection {
  originLat: number;
  originLon: number;
  cosOrigin: number;
}

/** A resampled centreline point, in scene metres. */
interface Sample {
  x: number;
  z: number;
  /** Metres travelled along the line to here. */
  alongM: number;
  /** The source coordinate pair this came from (for the fallback height). */
  lon: number;
  lat: number;
}

/**
 * Walk a lon/lat polyline and emit a point every `stepM` metres. The original
 * vertices are kept (they are where the line actually bends).
 */
function resample(
  coords: [number, number][],
  proj: RibbonProjection,
  stepM: number,
): Sample[] {
  const sx = (lon: number) => (lon - proj.originLon) * 111320 * proj.cosOrigin;
  const sz = (lat: number) => -(lat - proj.originLat) * 111320;

  const out: Sample[] = [];
  let alongM = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const [lon0, lat0] = coords[i];
    const [lon1, lat1] = coords[i + 1];
    const x0 = sx(lon0), z0 = sz(lat0);
    const x1 = sx(lon1), z1 = sz(lat1);
    const len = Math.hypot(x1 - x0, z1 - z0);

    out.push({ x: x0, z: z0, alongM, lon: lon0, lat: lat0 });

    const steps = Math.floor(len / stepM);
    for (let s = 1; s <= steps; s++) {
      const t = (s * stepM) / len;
      if (t >= 1) break;
      out.push({
        x: x0 + (x1 - x0) * t,
        z: z0 + (z1 - z0) * t,
        alongM: alongM + len * t,
        lon: lon0 + (lon1 - lon0) * t,
        lat: lat0 + (lat1 - lat0) * t,
      });
    }
    alongM += len;
  }

  const [lonN, latN] = coords[coords.length - 1];
  out.push({ x: sx(lonN), z: sz(latN), alongM, lon: lonN, lat: latN });

  return out;
}

/**
 * Build one ribbon that follows the terrain.
 *
 * @param ground     Terrain probe (raycast). Returns null where no terrain is loaded.
 * @param fallbackY  Height to use where `ground` misses — the old quantised
 *                   formula, so an un-streamed edge is no worse than before.
 */
export function buildGroundRibbon(
  coords: [number, number][],
  proj: RibbonProjection,
  ground: GroundFn,
  fallbackY: (lon: number, lat: number) => number,
  opts: GroundRibbonOptions,
): THREE.BufferGeometry | null {
  if (coords.length < 2) return null;

  const samples = resample(coords, proj, opts.resampleStepM ?? RIBBON_STEP_M);
  if (samples.length < 2) return null;

  const n = samples.length;
  const positions = new Float32Array(n * 2 * 3);
  const colors = opts.color ? new Float32Array(n * 2 * 3) : null;
  const uvs = opts.emitUv ? new Float32Array(n * 2 * 2) : null;
  const indices: number[] = [];

  let lastPx = 0;
  let lastPz = 1; // fallback perpendicular for a degenerate first segment

  for (let i = 0; i < n; i++) {
    const s = samples[i];

    // Both edge vertices share the sample's height, so the ribbon lies flat
    // across its width and only bends along its length (same as the route line).
    const g = ground(s.x, s.z);
    const y = (g ?? fallbackY(s.lon, s.lat)) + opts.heightOffset;

    // Direction from the neighbour; reuse the last one on a degenerate segment.
    const j = i < n - 1 ? i + 1 : i - 1;
    let dx = samples[j].x - s.x;
    let dz = samples[j].z - s.z;
    if (i === n - 1) { dx = -dx; dz = -dz; }
    const len = Math.hypot(dx, dz);
    let px = lastPx, pz = lastPz;
    if (len > 1e-3) {
      px = (-dz / len) * opts.halfWidth;
      pz = (dx / len) * opts.halfWidth;
      lastPx = px;
      lastPz = pz;
    }

    const vi = i * 2;
    positions[vi * 3] = s.x + px;
    positions[vi * 3 + 1] = y;
    positions[vi * 3 + 2] = s.z + pz;
    positions[(vi + 1) * 3] = s.x - px;
    positions[(vi + 1) * 3 + 1] = y;
    positions[(vi + 1) * 3 + 2] = s.z - pz;

    if (colors && opts.color) {
      const c = opts.color;
      colors[vi * 3] = c.r;
      colors[vi * 3 + 1] = c.g;
      colors[vi * 3 + 2] = c.b;
      colors[(vi + 1) * 3] = c.r;
      colors[(vi + 1) * 3 + 1] = c.g;
      colors[(vi + 1) * 3 + 2] = c.b;
    }

    if (uvs) {
      uvs[vi * 2] = s.alongM;
      uvs[vi * 2 + 1] = 0;
      uvs[(vi + 1) * 2] = s.alongM;
      uvs[(vi + 1) * 2 + 1] = 1;
    }

    if (i < n - 1) {
      const a = vi, b = vi + 1, c = vi + 2, d = vi + 3;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Merge ribbons into one buffer. Attributes are carried through only if the
 * FIRST geometry has them — every ribbon in one merge comes from the same
 * builder, so they always agree.
 */
export function mergeRibbonGeometries(
  geometries: THREE.BufferGeometry[],
): THREE.BufferGeometry {
  const first = geometries[0];
  const withColor = !!first.getAttribute('color');
  const withUv = !!first.getAttribute('uv');

  let vertexCount = 0;
  let indexCount = 0;
  for (const g of geometries) {
    vertexCount += g.getAttribute('position').count;
    indexCount += g.index?.count ?? 0;
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = withColor ? new Float32Array(vertexCount * 3) : null;
  const uvs = withUv ? new Float32Array(vertexCount * 2) : null;
  const indices = new Uint32Array(indexCount);

  let vertOffset = 0;
  let idxOffset = 0;

  for (const g of geometries) {
    const pos = g.getAttribute('position');
    const norm = g.getAttribute('normal');
    const col = g.getAttribute('color');
    const uv = g.getAttribute('uv');
    const count = pos.count;

    positions.set(pos.array as Float32Array, vertOffset * 3);
    if (norm) normals.set(norm.array as Float32Array, vertOffset * 3);
    if (colors && col) colors.set(col.array as Float32Array, vertOffset * 3);
    if (uvs && uv) uvs.set(uv.array as Float32Array, vertOffset * 2);

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
  if (colors) merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (uvs) merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}
