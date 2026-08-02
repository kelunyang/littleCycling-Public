/**
 * Terrain chunk: a corridor-shaped mesh (~2km long × 400m wide) built
 * from DEM elevation data along a segment of the GPX route.
 *
 * The corridor is constructed by sampling elevation along cross-sections
 * perpendicular to the route direction, then building a BufferGeometry
 * from the resulting vertex grid.
 *
 * Surface: MeshToonMaterial with procedural vertex colors (neon/graffiti palette).
 * No raster satellite tiles — all colors are procedurally generated.
 */

import * as THREE from 'three';
import type { RoutePoint } from '@littlecycling/shared';
import type { ElevationSampler } from './elevation-sampler';
import type { TerrainStyleStrategy } from './terrain-style-strategy';
import {
  buildQuantizedCorridorGeometry,
  corridorCentreColumns,
  quantizedDataToGeometry,
  registerWallMaterial,
} from './quantized-terrain';
import { computeSmoothedBearing } from '../route-geometry';
import { createYielder } from './build-yield';

/** Default half-width of the corridor in meters. */
const DEFAULT_CORRIDOR_HALF_WIDTH = 500;

/**
 * Clamp the cross-CELL count (across the corridor) for perf/stitching.
 *
 * ODD, both of them — see `crossCount` in `buildTerrainChunk`: an odd number of
 * cells is what puts the road down the middle of one of them. The clamp has to
 * preserve that or a very fine `gridSize` would silently hand back the old
 * even-cell corridor with the road on a cell boundary again.
 */
const MIN_CROSS_CELLS = 5;
const MAX_CROSS_CELLS = 79;
/** Clamp the along-route section count. */
const MAX_SECTIONS = 240;


export interface ChunkBuildInput {
  /** Route points for this chunk segment. */
  points: RoutePoint[];
  /** Cumulative distances matching `points`, relative to route start. */
  cumulativeDistances: number[];
  /** Start index into the route for this chunk. */
  startIdx: number;
  /** End index into the route for this chunk. */
  endIdx: number;
  /** Chunk index (0-based, sequential along route). */
  chunkIndex: number;
  /** Last cross-section vertex data from previous chunk (for seamless joining). */
  prevEdge?: ChunkEdgeData;
  /** Corridor half-width in meters (overrides default). */
  corridorHalfWidth?: number;
  /**
   * Multiplier on the style's grid spacing for this chunk's build (far-chunk
   * LOD). 1 = full resolution; 2 = coarse (~¼ the triangles). Default 1.
   */
  gridSizeScale?: number;
}

/** Vertex data for one cross-section edge, used to stitch chunks seamlessly. */
export interface ChunkEdgeData {
  /** Flat array of xyz positions (length = crossCount * 3). */
  positions: number[];
  /** Flat array of rgb colors (length = crossCount * 3). */
  colors: number[];
  /** Geographic coords for each vertex in the edge (length = crossCount). */
  geoCoords: { lat: number; lon: number }[];
  /** ABSOLUTE elevation per edge vertex (length = crossCount). Used by the
   *  quantised builder so the shared edge snaps to the same layer either side. */
  eles: number[];
}

export interface TerrainChunkResult {
  mesh: THREE.Mesh;
  chunkIndex: number;
  /** Center of this chunk in geographic coords (for positioning). */
  centerLat: number;
  centerLon: number;
  centerEle: number;
  /** Last cross-section data for stitching with the next chunk. */
  lastEdge: ChunkEdgeData;
  /** Ground-height lookup grid captured from the BUILT geometry (post-quantise /
   *  jitter), so ground queries match the rendered surface exactly. */
  heightGrid: ChunkHeightGrid;
}

/**
 * A per-chunk ground-height lookup, captured from the geometry actually built
 * (AFTER quantisation + jitter), so a world→cell lookup returns the exact height
 * the rider/lamps/route-line must sit on — replacing the per-query mesh raycast.
 *
 * The corridor follows the route: each "section" is a straight cross-slice line
 * perpendicular to the (smoothed) route bearing, and consecutive sections form a
 * warped quad strip. World→cell mapping inverts that strip: for each section pair
 * (s, s+1) we project the query point onto the centre segment to get the along
 * parameter tA, then measure the signed cross distance along the interpolated
 * right vector; the first pair that contains the point (tA∈[0,1], |cross|≤half)
 * wins. `_lastSection` caches the last hit so coherent queries (route-line walk,
 * rider each frame) are O(1).
 */
/**
 * Uniform (x, z) bucket index over the chunk's CELL QUADS.
 *
 * The corridor's own parameterisation cannot answer "which cell covers this
 * point". `tA` is found by projecting onto the ~25 m segment between two
 * section centres, but the perpendicular slices fan out, and wherever the route
 * turns tighter than the corridor half-width (500 m — i.e. every street corner)
 * the slices cross and the corridor folds onto itself. The projection then
 * names a cell hundreds of metres away. Measured against the rendered mesh on
 * the Dazhi route: 66% agreement on the flat straight chunk, 29% and 8.5% on
 * the two hill chunks.
 *
 * So: index the quads themselves and answer the question exactly. Built once
 * per chunk over ~3.4 K cells; a query touches one bucket.
 */
export interface CellIndex {
  cellSize: number;
  minX: number;
  minZ: number;
  nx: number;
  nz: number;
  /** CSR offsets, length nx*nz+1. */
  starts: Int32Array;
  /** Cell ids, grouped by bucket. */
  items: Int32Array;
}

export interface ChunkHeightGrid {
  /** true → `heights` is per-cell flat tops (quantised style); false → per-vertex
   *  absolute elevation, bilinear-interpolated (smooth style). */
  quantized: boolean;
  /** Grid vertex positions (length along*cross) — the cell quads' corners, and
   *  the only exact way to test what covers a point. Quantised path only. */
  gx?: Float32Array;
  gz?: Float32Array;
  /** Spatial index over those quads. Quantised path only. */
  cellIndex?: CellIndex;
  /** Section (along-route) count and cross-column count of the source grid. */
  along: number;
  cross: number;
  /** Half-width of the corridor in scene metres (centre → edge along `right`). */
  halfWidth: number;
  /** Axis-aligned bounds of the corridor (section centres grown by
   *  halfWidth*1.02 + section spacing) — a cheap O(1) reject before the section
   *  scan for a query point that can't possibly lie in this chunk. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Per-section centre point (route centreline) in scene X/Z (length `along`). */
  centerX: Float32Array;
  centerZ: Float32Array;
  /** Per-section unit "right" vector (cross direction) in scene X/Z. */
  rightX: Float32Array;
  rightZ: Float32Array;
  /** Heights in ABSOLUTE world metres. quantised: (along-1)×(cross-1) cells,
   *  index a*(cross-1)+c. smooth: along×cross vertices, index a*cross+c. */
  heights: Float32Array;
  /** Per-cell hypsometric band level (layers above the road at that section) —
   *  see `QuantizedGeometryData.cellBand`. Quantised path only. Studs read it so
   *  a stud is moulded in the same colour as the brick it stands on. */
  cellBand?: Int8Array;
  /** Last section index that satisfied a query — coherence cache (mutable). */
  _lastSection: number;
}

/**
 * One route sample used by the medial-axis mask: scene position + distance along
 * the route. Resampled at a fixed metre step so a sparse GPX and a dense one
 * give the same answer.
 */
export interface RouteSamples {
  x: Float64Array;
  z: Float64Array;
  d: Float64Array;
}

/**
 * Resample the route between two distances at `step` metres, in scene coords.
 * Exported for the headless checks — the mask is only as good as these.
 */
export function sampleRouteForMask(
  points: RoutePoint[],
  cumulativeDistances: number[],
  fromDist: number,
  toDist: number,
  step: number,
  originLat: number,
  originLon: number,
  cosOrigin: number,
): RouteSamples {
  const total = cumulativeDistances[cumulativeDistances.length - 1];
  const from = Math.max(0, fromDist);
  const to = Math.min(total, toDist);
  const n = Math.max(2, Math.floor((to - from) / step) + 1);
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  const d = new Float64Array(n);
  let i = 0;
  for (let k = 0; k < n; k++) {
    const dist = from + k * step;
    while (i < points.length - 2 && cumulativeDistances[i + 1] < dist) i++;
    const d0 = cumulativeDistances[i], d1 = cumulativeDistances[i + 1];
    const t = d1 > d0 ? Math.min(1, Math.max(0, (dist - d0) / (d1 - d0))) : 0;
    const a = points[i], b = points[i + 1];
    const lat = a.lat + (b.lat - a.lat) * t;
    const lon = a.lon + (b.lon - a.lon) * t;
    x[k] = (lon - originLon) * 111320 * cosOrigin;
    z[k] = -(lat - originLat) * 111320;
    d[k] = dist;
  }
  return { x, z, d };
}

/**
 * MEDIAL-AXIS MASK — which of a chunk's cells are ground, and which are the
 * corridor lying on top of itself.
 *
 * The corridor is an OFFSET RIBBON: every cross-section is the route's position
 * pushed ±`corridorHalfWidth` along its own perpendicular. An offset ribbon only
 * parameterises the plane one-to-one out to the route's RADIUS OF CURVATURE.
 * Past that the slices cross, the quads turn inside-out, and the same ground is
 * covered again and again at different heights.
 *
 * That is not a corner case here, it is the normal state of a mountain chunk.
 * Measured on the Taipei summit chunk (`scripts/headless-check/clip-probe.ts`,
 * real DEM + MVT, half-width 500 m, paper's 32 m grid):
 *
 *   · every world point under the rider is covered by 9.2 cells (worst 24)
 *   · 43.1 % of those cells are wound inside-out
 *   · they disagree by 35.6 m on average, 92.8 m at worst
 *   · their xz diagonals average 218 m — against a nominal grid of 32 m
 *   · so the drawn ground at the rider sat a mean 8.9 m above the DEM at the
 *     same point and jumped 19.2 m between two consecutive frames
 *
 * The rider therefore rides the UPPER ENVELOPE of nine disagreeing surfaces,
 * which is why the bike is inside the terrain 3–8 % of frames whatever the step
 * height is, and why no query policy can fix it: the mesh draws all nine.
 *
 * The cut is the medial axis, and the test is exact because the construction
 * hands it to us: a grid VERTEX at column c was PLACED `|offset_c|` metres from
 * its own section's centre, and that centre is on the route. So
 *
 *     the vertex is past the medial axis
 *       ⟺  some other part of the route is CLOSER to it than |offset_c|
 *
 * — no tolerance on distances-along, no curvature estimate, nothing to tune but
 * `MEDIAL_SLACK` (which only absorbs the few per-cent by which the SMOOTHED
 * bearing tilts the offset off the true normal).
 *
 * A cell is ground if ANY of its four corners is. That closure is what makes
 * the rule safe, and it gives three properties worth stating:
 *
 *  - **The rider's own lane can never be cut.** This used to be free: the centre
 *    COLUMN had `offset = 0`, and nothing can be closer to a point than the
 *    route it sits on. With an even column count there is no column on the route
 *    any more — the two lane columns straddle it at ±half a cell (12–16 m) — so
 *    the property is now DECLARED instead of inherited: `corridorCentreColumns`
 *    names them and they are owned unconditionally. What that buys is unchanged
 *    and slightly stronger: the rider's own cell has both its long edges owned,
 *    and the cell either side of it has one, so the road's cell and its two
 *    neighbours always survive. (At a 10 m-radius hairpin a vertex 15 m inside
 *    the bend is past the centre of curvature and the far leg IS nearer than its
 *    own section — which is exactly the case the declaration exists to cover.)
 *  - **On a straight route it keeps everything.** Every vertex's nearest route
 *    point is its own section's centre, so a flat/straight scene is what it
 *    always was. The mask only bites where the corridor actually folds.
 *  - **It hands ground over rather than dropping it.** Testing the CENTRE of a
 *    cell instead does open holes — two switchback legs 25 m apart make each
 *    other's centre-lane cell centres foreign and both sides drop: measured
 *    7.2 % of the corridor gone and 42 % of the rider's ground queries
 *    answering "no chunk covers this". The corner closure is what removes that;
 *    the price is a one-cell band of overlap along the axis itself.
 *
 * Scope: the competing route is limited to ±one chunk length, so a chunk only
 * ever defers to neighbours that stream in with it. An out-and-back that
 * revisits the same road 20 km later still draws both passes, exactly as today
 * — deferring there would leave the rider on unbuilt ground.
 */
/**
 * How much closer than `|offset|` a competing stretch of route has to be before
 * a vertex counts as past the medial axis.
 *
 * It is NOT a fudge factor for the medial axis itself — that test is exact.
 * It covers one thing: `computeSmoothedBearing` averages over a 30 m window, so
 * on a bend the cross-section is not quite the true normal and the vertex sits
 * `|offset|·(1 − cos θ)` closer to the route than its own section is. At the
 * corridor edge (500 m) a 10° tilt is 7.6 m, i.e. 1.5 %; 5 % is three times
 * that. Bigger than it needs to be would start keeping real folds — the folds
 * this cuts bring the competing route to within a few per cent of nothing (the
 * worst measured plate was 480 m from its own section and 5 m from the rider's
 * road).
 */
export const MEDIAL_SLACK = 0.05;

/**
 * Ceiling on what the safety net below may put back, in nominal cell widths.
 *
 * The corridor's own fan produces cells hundreds of metres across, and one of
 * those covers the road as well as the patch it was called back for. Measured on
 * the Taipei summit chunk (bike inside the terrain / drawn ground − DEM / corridor
 * cells with no ground at all):
 *
 *   no safety net   4.58 %   1.53 m   2.88 % of cells (all ≥141 m from the road)
 *   cap ∞           7.58 %   2.53 m   0
 *   cap 4 cells     see the header of `buildTerrainChunk`'s call site
 *
 * A patch that only a several-hundred-metre plate can cover is out past the last
 * fold; a flat plate that size is not that ground either, so nothing is gained
 * by drawing it over the road to hide it.
 */
export const RESURRECT_SPAN_CELLS = 6;

export function buildMedialAxisMask(
  gx: number[], gz: number[], along: number, cross: number,
  corridorHalfWidth: number,
  route: RouteSamples,
  /** This chunk's own stretch of route. Ground whose nearest route is OUTSIDE it
   *  belongs to a neighbouring chunk, so the safety net leaves it to them —
   *  `-Infinity` / `+Infinity` at the ends of the route, where there is nobody
   *  else to leave it to. */
  ownFrom = -Infinity, ownTo = Infinity,
): Uint8Array {
  const cellsA = along - 1, cellsC = cross - 1;
  const mask = new Uint8Array(Math.max(0, cellsA * cellsC));
  const n = route.d.length;
  if (cellsA < 1 || cellsC < 1 || n < 2) {
    mask.fill(1);
    return mask;
  }
  // Per-vertex ownership first: a vertex is shared by up to four cells, so
  // testing it once and OR-ing into the cells is both cheaper and the only way
  // "any corner" means the same thing from either side of an edge.
  const owned = new Uint8Array(along * cross);
  const [laneL, laneR] = corridorCentreColumns(cross);
  for (let s = 0; s < along; s++) {
    for (let c = 0; c < cross; c++) {
      const i = s * cross + c;
      // The two columns that bound the rider's own cell: always ours (see the
      // header). For an odd `cross` these collapse to the single centre column,
      // whose `offset` is 0 — i.e. exactly the branch this replaces.
      if (c === laneL || c === laneR) { owned[i] = 1; continue; }
      const off = Math.abs(((c / (cross - 1)) * 2 - 1) * corridorHalfWidth);
      const lim = off * (1 - MEDIAL_SLACK);
      // Only reachable now for a degenerate `corridorHalfWidth = 0`, and it is
      // not load-bearing there either: `lim2` would be 0 and `d2 < 0` false for
      // every sample, so the loop below already answers "ours". Kept as the
      // short-circuit it is, not as a guard pretending to hold something up.
      if (lim <= 0) { owned[i] = 1; continue; }
      const lim2 = lim * lim;
      const vx = gx[i], vz = gz[i];
      let ok = 1;
      for (let k = 0; k < n; k++) {
        const dx = route.x[k] - vx, dz = route.z[k] - vz;
        if (dx * dx + dz * dz < lim2) { ok = 0; break; }
      }
      owned[i] = ok;
    }
  }
  for (let a = 0; a < cellsA; a++) {
    for (let c = 0; c < cellsC; c++) {
      const i00 = a * cross + c;
      mask[a * cellsC + c] =
        owned[i00] | owned[i00 + 1] | owned[i00 + cross] | owned[i00 + cross + 1];
    }
  }

  // ── Safety net: the mask may not make ground disappear ──
  //
  // The corner closure hands ground over rather than dropping it, but in a tight
  // switchback bundle the stretch of route that takes it over can itself be cut
  // by a THIRD pass, and then nobody draws that patch. Measured on the Taipei
  // summit chunk: 2.88 % of the corridor's cells lost their ground that way —
  // all of it 141 m or further from the road (median 391 m), i.e. out where the
  // fold was worst, which is exactly where a gap reads as a hole in the
  // hillside. So ask the question directly instead of arguing about it: a cut
  // cell whose ground nobody else covers comes back.
  //
  // Cut cells get first refusal SMALLEST FIRST, and each one that comes back
  // joins the index before the next is asked. Order is the whole trick: the
  // cells that lose their ground out in the fold zone include 450 m plates, and
  // letting one of those answer first put a plate back over the road and drove
  // the bike's time inside the terrain from 4.6 % up to 7.2 %. The smallest cell
  // covering a patch is the one whose four DEM samples are actually near it.
  const cellArea = Math.max(1, (2 * corridorHalfWidth) / Math.max(1, cellsC));
  const bucket = cellArea * 2;
  let bMinX = Infinity, bMinZ = Infinity, bMaxX = -Infinity, bMaxZ = -Infinity;
  for (let i = 0; i < along * cross; i++) {
    if (gx[i] < bMinX) bMinX = gx[i];
    if (gx[i] > bMaxX) bMaxX = gx[i];
    if (gz[i] < bMinZ) bMinZ = gz[i];
    if (gz[i] > bMaxZ) bMaxZ = gz[i];
  }
  const bnx = Math.max(1, Math.ceil((bMaxX - bMinX) / bucket) + 1);
  const bnz = Math.max(1, Math.ceil((bMaxZ - bMinZ) / bucket) + 1);
  const buckets: number[][] = new Array(bnx * bnz);
  const corners = (a: number, c: number): number[] => {
    const i00 = a * cross + c;
    return [i00, i00 + 1, i00 + cross + 1, i00 + cross];
  };
  const insert = (id: number): void => {
    const qi = corners(Math.floor(id / cellsC), id % cellsC);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const i of qi) {
      if (gx[i] < x0) x0 = gx[i];
      if (gx[i] > x1) x1 = gx[i];
      if (gz[i] < z0) z0 = gz[i];
      if (gz[i] > z1) z1 = gz[i];
    }
    const bx0 = Math.max(0, Math.floor((x0 - bMinX) / bucket));
    const bx1 = Math.min(bnx - 1, Math.floor((x1 - bMinX) / bucket));
    const bz0 = Math.max(0, Math.floor((z0 - bMinZ) / bucket));
    const bz1 = Math.min(bnz - 1, Math.floor((z1 - bMinZ) / bucket));
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let bz = bz0; bz <= bz1; bz++) (buckets[bz * bnx + bx] ??= []).push(id);
    }
  };
  const centreOf = (id: number): [number, number] => {
    const qi = corners(Math.floor(id / cellsC), id % cellsC);
    let mx = 0, mz = 0;
    for (const i of qi) { mx += gx[i] / 4; mz += gz[i] / 4; }
    return [mx, mz];
  };
  const covered = (mx: number, mz: number): boolean => {
    const bx = Math.floor((mx - bMinX) / bucket);
    const bz = Math.floor((mz - bMinZ) / bucket);
    if (bx < 0 || bx >= bnx || bz < 0 || bz >= bnz) return false;
    const list = buckets[bz * bnx + bx];
    if (!list) return false;
    for (const id of list) {
      const oq = corners(Math.floor(id / cellsC), id % cellsC);
      let inside = false;
      for (let p = 0, q = 3; p < 4; q = p++) {
        const xp = gx[oq[p]], zp = gz[oq[p]];
        const xq = gx[oq[q]], zq = gz[oq[q]];
        if ((zp > mz) !== (zq > mz) && mx < ((xq - xp) * (mz - zp)) / (zq - zp) + xp) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  };

  /** 格心最近的那個路線取樣點,里程是多少。 */
  const nearestRouteDist = (mx: number, mz: number): number => {
    let best = 0, bestD = Infinity;
    for (let k = 0; k < n; k++) {
      const dx = route.x[k] - mx, dz = route.z[k] - mz;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) { bestD = d2; best = k; }
    }
    return route.d[best];
  };
  const cut: { id: number; span: number }[] = [];
  for (let id = 0; id < cellsA * cellsC; id++) {
    if (mask[id] === 1) { insert(id); continue; }
    const qi = corners(Math.floor(id / cellsC), id % cellsC);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const i of qi) {
      if (gx[i] < x0) x0 = gx[i];
      if (gx[i] > x1) x1 = gx[i];
      if (gz[i] < z0) z0 = gz[i];
      if (gz[i] > z1) z1 = gz[i];
    }
    cut.push({ id, span: Math.hypot(x1 - x0, z1 - z0) });
  }
  cut.sort((p, q) => p.span - q.span || p.id - q.id);
  const spanCap = cellArea * RESURRECT_SPAN_CELLS;
  for (const { id, span } of cut) {
    if (span > spanCap) continue;
    const [mx, mz] = centreOf(id);
    if (covered(mx, mz)) continue;
    // `covered` can only see THIS chunk's cells, so without this line a chunk
    // calls a cell back to cover ground the NEXT chunk already draws — and its
    // cells there are hundreds of metres from its own centreline, so they land
    // on the neighbour's road. Measured on Alpe d'Huez chunk 1: 76.5 % of the
    // rider's frames still had a second surface over them, and it was
    // cross-chunk almost every time.
    const d = nearestRouteDist(mx, mz);
    if (d < ownFrom || d > ownTo) continue;
    mask[id] = 1;
    insert(id);
  }
  return mask;
}

/** Build the bucket index over a chunk's cell quads. */
function buildCellIndex(
  gx: Float32Array, gz: Float32Array, along: number, cross: number,
  /** Per-cell heights; a NaN entry is a cell the medial-axis mask removed and
   *  must not be indexed — a ground query has to be unable to name it. */
  heights: Float32Array,
): CellIndex {
  const cellsA = along - 1, cellsC = cross - 1;
  const n = cellsA * cellsC;

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < gx.length; i++) {
    if (gx[i] < minX) minX = gx[i];
    if (gx[i] > maxX) maxX = gx[i];
    if (gz[i] < minZ) minZ = gz[i];
    if (gz[i] > maxZ) maxZ = gz[i];
  }
  // Size buckets for roughly one cell each: fewer buckets than cells wastes
  // query time, many more wastes memory on an empty grid. A fixed 128-wide grid
  // spent 64 KB per chunk on the bucket array alone, most of it empty, on a
  // machine where RAM is the binding constraint (see the N100 profile).
  const area = Math.max(1, (maxX - minX) * (maxZ - minZ));
  const cellSize = Math.max(8, Math.sqrt(area / Math.max(1, n)));
  const nx = Math.max(1, Math.ceil((maxX - minX) / cellSize) + 1);
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cellSize) + 1);

  const bboxOf = (id: number): [number, number, number, number] => {
    const a = Math.floor(id / cellsC), c = id % cellsC;
    const i00 = a * cross + c;
    const idx = [i00, i00 + 1, i00 + cross, i00 + cross + 1];
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const i of idx) {
      if (gx[i] < x0) x0 = gx[i];
      if (gx[i] > x1) x1 = gx[i];
      if (gz[i] < z0) z0 = gz[i];
      if (gz[i] > z1) z1 = gz[i];
    }
    return [x0, x1, z0, z1];
  };

  // Two passes: count, then fill (CSR — no per-bucket arrays).
  const counts = new Int32Array(nx * nz + 1);
  const visit = (id: number, fn: (b: number) => void) => {
    const [x0, x1, z0, z1] = bboxOf(id);
    const bx0 = Math.max(0, Math.floor((x0 - minX) / cellSize));
    const bx1 = Math.min(nx - 1, Math.floor((x1 - minX) / cellSize));
    const bz0 = Math.max(0, Math.floor((z0 - minZ) / cellSize));
    const bz1 = Math.min(nz - 1, Math.floor((z1 - minZ) / cellSize));
    for (let bx = bx0; bx <= bx1; bx++) for (let bz = bz0; bz <= bz1; bz++) fn(bz * nx + bx);
  };
  for (let id = 0; id < n; id++) {
    if (Number.isNaN(heights[id])) continue;
    visit(id, (b) => { counts[b + 1]++; });
  }
  for (let i = 0; i < nx * nz; i++) counts[i + 1] += counts[i];
  const starts = counts;
  const items = new Int32Array(starts[nx * nz]);
  const cursor = new Int32Array(nx * nz);
  for (let id = 0; id < n; id++) {
    if (Number.isNaN(heights[id])) continue;
    visit(id, (b) => { items[starts[b] + cursor[b]++] = id; });
  }
  return { cellSize, minX, minZ, nx, nz, starts, items };
}

/**
 * Height of the cell quad covering (x, z), ORIGIN-RELATIVE, or null.
 *
 * `wantHighest` picks the topmost where the corridor genuinely folds over
 * itself — that is the surface you can see, and therefore the one anything
 * draped on the ground must sit on.
 */
function pickCell(
  grid: ChunkHeightGrid, x: number, z: number, wantHighest: boolean,
): number {
  const { gx, gz, cellIndex, cross, heights } = grid;
  if (!gx || !gz || !cellIndex) return -1;
  const { cellSize, minX, minZ, nx, nz, starts, items } = cellIndex;
  const bx = Math.floor((x - minX) / cellSize);
  const bz = Math.floor((z - minZ) / cellSize);
  if (bx < 0 || bx >= nx || bz < 0 || bz >= nz) return -1;
  const b = bz * nx + bx;
  const cellsC = cross - 1;

  let best = -1;
  for (let k = starts[b]; k < starts[b + 1]; k++) {
    const id = items[k];
    const a = Math.floor(id / cellsC), c = id % cellsC;
    const i00 = a * cross + c;
    // Corner order matters: i00, i01, i11, i10 walks the quad's perimeter.
    const qi = [i00, i00 + 1, i00 + cross + 1, i00 + cross];
    let inside = false;
    for (let p = 0, q = 3; p < 4; q = p++) {
      const xp = gx[qi[p]], zp = gz[qi[p]];
      const xq = gx[qi[q]], zq = gz[qi[q]];
      if ((zp > z) !== (zq > z) && x < ((xq - xp) * (z - zp)) / (zq - zp) + xp) inside = !inside;
    }
    if (!inside) continue;
    if (best < 0 || (wantHighest ? heights[id] > heights[best] : false)) best = id;
    if (!wantHighest) break;
  }
  return best;
}

function sampleByCellIndex(
  grid: ChunkHeightGrid, x: number, z: number, originEle: number, wantHighest: boolean,
): number | null {
  const id = pickCell(grid, x, z, wantHighest);
  return id < 0 ? null : grid.heights[id] - originEle;
}

/**
 * Height AND hypsometric band of the cell covering (x, z) — origin-relative
 * height, or null outside the corridor.
 *
 * Exists as one call rather than two so that a stud gets its height and its
 * colour from the SAME cell. Two independent lookups would agree almost always,
 * and the rare disagreement is precisely the failure the studs exist to rule
 * out: a stud one band off its brick reads as「綠色的釘子插過一張色紙」, which
 * is the thing 同一塊塑膠射出來的東西不會兩個色 forbids.
 */
export function sampleChunkCell(
  grid: ChunkHeightGrid, x: number, z: number, originEle: number,
): { y: number; band: number } | null {
  if (!grid.cellIndex) {
    const y = sampleChunkHeight(grid, x, z, originEle);
    return y === null ? null : { y, band: 0 };
  }
  const id = pickCell(grid, x, z, true);
  if (id < 0) return null;
  return { y: grid.heights[id] - originEle, band: grid.cellBand ? grid.cellBand[id] : 0 };
}

/** Height at fractional (along, cross) grid coordinates, ABSOLUTE metres. */
function heightAtGrid(grid: ChunkHeightGrid, aFrac: number, cFrac: number): number {
  const { along, cross, heights, quantized } = grid;
  if (quantized) {
    const cellsA = along - 1, cellsC = cross - 1;
    let a = Math.floor(aFrac);
    if (a < 0) a = 0; else if (a > cellsA - 1) a = cellsA - 1;
    let c = Math.floor(cFrac);
    if (c < 0) c = 0; else if (c > cellsC - 1) c = cellsC - 1;
    return heights[a * cellsC + c];
  }
  // Smooth: bilinear over the four surrounding grid vertices.
  let a0 = Math.floor(aFrac);
  if (a0 < 0) a0 = 0; else if (a0 > along - 2) a0 = along - 2;
  let c0 = Math.floor(cFrac);
  if (c0 < 0) c0 = 0; else if (c0 > cross - 2) c0 = cross - 2;
  let fa = aFrac - a0; fa = fa < 0 ? 0 : fa > 1 ? 1 : fa;
  let fc = cFrac - c0; fc = fc < 0 ? 0 : fc > 1 ? 1 : fc;
  const h00 = heights[a0 * cross + c0];
  const h01 = heights[a0 * cross + c0 + 1];
  const h10 = heights[(a0 + 1) * cross + c0];
  const h11 = heights[(a0 + 1) * cross + c0 + 1];
  const top = h00 + (h01 - h00) * fc;
  const bot = h10 + (h11 - h10) * fc;
  return top + (bot - top) * fa;
}

/**
 * Ground height at scene (x, z) from a chunk's height grid, ORIGIN-RELATIVE
 * (i.e. the same value the terrain mesh renders at: absolute − originEle),
 * or null if the point is outside this chunk's corridor.
 *
 * A linear scan over the ~80 sections, warm-started from `_lastSection`, so a
 * coherent stream of queries (route-line resample, per-frame rider) is O(1).
 */
export function sampleChunkHeight(
  grid: ChunkHeightGrid,
  x: number,
  z: number,
  originEle: number,
  preferY?: number,
): number | null {
  // Exact path: ask the cell quads directly. The section-projection scan below
  // is kept only for the smooth (non-quantised) style, which has no cells.
  //
  // `preferY` is deliberately ignored here. It existed to disambiguate the
  // stacked corridor passes the old scan produced, but most of that stacking
  // was the scan naming the wrong cell in the first place. Where the corridor
  // really does fold, the visible surface is the top one, so that is what
  // everything draped on the ground must sit on.
  if (grid.cellIndex) return sampleByCellIndex(grid, x, z, originEle, true);
  const { along, cross, halfWidth, centerX, centerZ, rightX, rightZ } = grid;
  const nSeg = along - 1;
  if (nSeg < 1 || halfWidth <= 0) return null;
  // Cheap AABB reject: a point outside the corridor's bounding box can't be in
  // any section, so skip the full scan entirely (kills the cost for non-covering
  // chunks probed by raycastGroundHeight).
  if (x < grid.minX || x > grid.maxX || z < grid.minZ || z > grid.maxZ) return null;
  const crossLimit = halfWidth * 1.02; // small tolerance at the corridor edge

  const trySeg = (s: number): number => {
    // (kept in sync with sampleChunkHeightAtSection below — same maths)
    const cx0 = centerX[s], cz0 = centerZ[s];
    const fx = centerX[s + 1] - cx0, fz = centerZ[s + 1] - cz0;
    const segLen2 = fx * fx + fz * fz;
    if (segLen2 < 1e-9) return NaN;
    let tA = ((x - cx0) * fx + (z - cz0) * fz) / segLen2;
    if (tA < -0.001 || tA > 1.001) return NaN;
    if (tA < 0) tA = 0; else if (tA > 1) tA = 1;
    // Centreline point at tA, and the right vector interpolated between sections.
    const mx = cx0 + fx * tA, mz = cz0 + fz * tA;
    let rx = rightX[s] + (rightX[s + 1] - rightX[s]) * tA;
    let rz = rightZ[s] + (rightZ[s + 1] - rightZ[s]) * tA;
    const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
    const d = (x - mx) * rx + (z - mz) * rz; // signed cross distance from centre
    if (d < -crossLimit || d > crossLimit) return NaN;
    grid._lastSection = s;
    const aFrac = s + tA;
    const cFrac = (d / halfWidth + 1) * 0.5 * (cross - 1);
    return heightAtGrid(grid, aFrac, cFrac) - originEle;
  };

  // Layer disambiguation: at a switchback the corridor crosses over itself,
  // so one (x, z) is covered by TWO sections at very different heights.
  // First-match (below) then returns whichever pass the scan finds first —
  // for the rider that teleports them onto the wrong deck and clips the
  // camera into the hillside. With `preferY`, scan ALL sections and return
  // the height closest to it (the rider's current height).
  if (preferY !== undefined) {
    let best: number | null = null;
    for (let s = 0; s < nSeg; s++) {
      const h = trySeg(s);
      if (!Number.isNaN(h) && (best === null || Math.abs(h - preferY) < Math.abs(best - preferY))) {
        best = h;
      }
    }
    return best;
  }

  const last = grid._lastSection;
  if (last >= 0 && last < nSeg) {
    const h = trySeg(last);
    if (!Number.isNaN(h)) return h;
  }
  for (let s = 0; s < nSeg; s++) {
    if (s === last) continue;
    const h = trySeg(s);
    if (!Number.isNaN(h)) return h;
  }
  return null;
}

/** One section's height at (x, z), or null if the point is not inside it.
 *  Same maths as `sampleChunkHeight`'s internal `trySeg`. */
function sampleChunkHeightAtSection(
  grid: ChunkHeightGrid,
  x: number,
  z: number,
  originEle: number,
  s: number,
): number | null {
  const { cross, halfWidth, centerX, centerZ, rightX, rightZ } = grid;
  const cx0 = centerX[s], cz0 = centerZ[s];
  const fx = centerX[s + 1] - cx0, fz = centerZ[s + 1] - cz0;
  const segLen2 = fx * fx + fz * fz;
  if (segLen2 < 1e-9) return null;
  let tA = ((x - cx0) * fx + (z - cz0) * fz) / segLen2;
  if (tA < -0.001 || tA > 1.001) return null;
  if (tA < 0) tA = 0; else if (tA > 1) tA = 1;
  const mx = cx0 + fx * tA, mz = cz0 + fz * tA;
  let rx = rightX[s] + (rightX[s + 1] - rightX[s]) * tA;
  let rz = rightZ[s] + (rightZ[s + 1] - rightZ[s]) * tA;
  const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
  const d = (x - mx) * rx + (z - mz) * rz;
  const crossLimit = halfWidth * 1.02;
  if (d < -crossLimit || d > crossLimit) return null;
  const cFrac = (d / halfWidth + 1) * 0.5 * (cross - 1);
  return heightAtGrid(grid, s + tA, cFrac) - originEle;
}

/**
 * The HIGHEST terrain surface over (x, z), origin-relative, or null if this
 * chunk's corridor does not cover the point.
 *
 * Where a climb's corridor folds back over the valley, one (x, z) carries two
 * surfaces and the mesh draws both — so the only one you can see is the top.
 * Anything draped below it is inside the hill.
 *
 * This exists as its own function because the obvious shortcut does NOT work:
 * `sampleChunkHeight(..., Number.POSITIVE_INFINITY)` looks like it should pick
 * the highest layer, but the comparison is `Math.abs(h - preferY)`, which is
 * Infinity for every candidate, so `Infinity < Infinity` is false and it
 * silently returns the FIRST hit instead.
 */
export function maxChunkHeight(
  grid: ChunkHeightGrid,
  x: number,
  z: number,
  originEle: number,
): number | null {
  if (grid.cellIndex) return sampleByCellIndex(grid, x, z, originEle, true);
  const { along, halfWidth } = grid;
  const nSeg = along - 1;
  if (nSeg < 1 || halfWidth <= 0) return null;
  if (x < grid.minX || x > grid.maxX || z < grid.minZ || z > grid.maxZ) return null;

  let best: number | null = null;
  for (let s = 0; s < nSeg; s++) {
    const h = sampleChunkHeightAtSection(grid, x, z, originEle, s);
    if (h !== null && (best === null || h > best)) best = h;
  }
  return best;
}

/**
 * Build a terrain mesh for one route chunk.
 *
 * @param input - Route segment info
 * @param sampler - DEM elevation sampler
 * @param originLat - Scene origin latitude (floating origin)
 * @param originLon - Scene origin longitude
 * @param originEle - Scene origin elevation
 */
export async function buildTerrainChunk(
  input: ChunkBuildInput,
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
  strategy: TerrainStyleStrategy,
): Promise<TerrainChunkResult> {
  const { points, startIdx, endIdx, chunkIndex } = input;
  const corridorHalfWidth = input.corridorHalfWidth ?? DEFAULT_CORRIDOR_HALF_WIDTH;
  const segPoints = points.slice(startIdx, endIdx + 1);
  const params = strategy.params;

  // Grid resolution driven by the style's gridSize (world-aligned cell size),
  // scaled up for coarse far-chunk LOD builds (gridSizeScale).
  const gridSize = Math.max(4, params.gridSize * (input.gridSizeScale ?? 1));
  // The road runs down the MIDDLE OF ONE CELL, not along the edge between two.
  //
  // The count used to be forced ODD ("keep a center column for the GPX blend"),
  // which put a grid COLUMN — a cell edge — exactly on the route. The two cells
  // either side of the rider then took their flat tops from "road ± half a cell
  // of cross-slope", so the ground under the left half of the bike and the
  // ground under the right half differed by the full cross-slope over one cell.
  // Measured with `scripts/headless-check/clip-probe.ts` (real DEM + MVT, the
  // ground 3 m each side of the road, and a bike that only has WIDTH — axle
  // ±0.5 m — so the along-route steps are excluded):
  //
  //                     ground step across the road    frames the 1 m-wide bike
  //                                                    is inside the terrain
  //   Taipei summit            2.52 m                        1.23 %
  //   Alpe d'Huez              7.18 m                       50.90 %
  //   Amalfi SS163            21.97 m                       26.15 %
  //
  // The blend that justified the odd count was removed a round ago (see the
  // per-vertex sampling loop below), so the reason went with it. An EVEN column
  // count = an ODD cell count = one cell centred on the route, whose flat top is
  // the mean of the four corners, i.e. the cross-slope cancels instead of being
  // split into a step. Everything that used to read "the centre column" now goes
  // through `corridorCentreColumns`.
  let crossCells = Math.max(1, Math.round((corridorHalfWidth * 2) / gridSize));
  if (crossCells % 2 === 0) crossCells += 1;
  crossCells = Math.max(MIN_CROSS_CELLS, Math.min(MAX_CROSS_CELLS, crossCells));
  const crossCount = crossCells + 1;
  const [laneColL, laneColR] = corridorCentreColumns(crossCount);

  const segLength =
    input.cumulativeDistances[endIdx] - input.cumulativeDistances[startIdx];
  let numSections = Math.max(2, Math.round(segLength / gridSize) + 1);
  numSections = Math.min(numSections, MAX_SECTIONS);

  // Sampled corridor grid (row-major over sections × cross columns).
  const gx: number[] = [];
  const gz: number[] = [];
  const gele: number[] = [];       // ABSOLUTE elevation
  const gcol: number[] = [];       // rgb per vertex
  const geoCoords: { lat: number; lon: number }[] = [];

  const cosOrigin = Math.cos((originLat * Math.PI) / 180);

  // Prefetch every DEM tile covering this corridor up front, so the per-vertex
  // sampling loop below can read elevations synchronously (getElevationSync)
  // instead of awaiting a microtask per vertex (~10k awaits/chunk). One await
  // here replaces thousands and keeps the main thread from thrashing mid-build.
  {
    let bs = Infinity, bn = -Infinity, bw = Infinity, be = -Infinity;
    for (const p of segPoints) {
      if (p.lat < bs) bs = p.lat;
      if (p.lat > bn) bn = p.lat;
      if (p.lon < bw) bw = p.lon;
      if (p.lon > be) be = p.lon;
    }
    const latPad = (corridorHalfWidth + gridSize) / 111320;
    const lonPad = latPad / Math.max(0.1, cosOrigin);
    try {
      await sampler.prefetchBounds({
        south: bs - latPad, north: bn + latPad,
        west: bw - lonPad, east: be + lonPad,
      });
    } catch {
      // Offline / tile fetch failed — sync sampling falls back to GPX per vertex.
    }
  }

  // Only reuse the previous edge if its width matches (else the grid resolution
  // changed — e.g. a live gridSize tweak — and we sample a fresh edge).
  const prevEdge =
    input.prevEdge && input.prevEdge.geoCoords.length === crossCount
      ? input.prevEdge
      : undefined;

  // Hand the thread back periodically: the numSections×crossCount sampling below
  // (up to 240×81 ≈ 19k per-vertex iterations) is one synchronous CPU burst that
  // would otherwise freeze the frame. Yield at most once per section (the same
  // granularity the overlay builders use via createYielder).
  const maybeYield = createYielder();

  /** Monotone walker into `cumulativeDistances` for the distance-based placement. */
  let walk = startIdx;

  for (let s = 0; s < numSections; s++) {
    await maybeYield();
    // First section: reuse previous chunk's last edge for a seamless join.
    if (s === 0 && prevEdge) {
      for (let c = 0; c < crossCount; c++) {
        gx.push(prevEdge.positions[c * 3]);
        gz.push(prevEdge.positions[c * 3 + 2]);
        gele.push(prevEdge.eles[c]);
        gcol.push(prevEdge.colors[c * 3], prevEdge.colors[c * 3 + 1], prevEdge.colors[c * 3 + 2]);
        geoCoords.push(prevEdge.geoCoords[c]);
      }
      continue;
    }

    const t = s / (numSections - 1);
    // Sections sit at equal DISTANCES along the route, not at equal point
    // INDICES.
    //
    // `numSections` is `segLength / gridSize`, i.e. the count is already derived
    // from distance — but the placement used to be `floor(t · (points-1))`, and a
    // recorded ride's points are spaced by TIME. On this Taipei route that is
    // 3.3 m apart climbing at 12 km/h and 12.5 m apart descending at 45, so the
    // sections bunched up on the climbs and stretched to ~87 m on the descents:
    // the terrain's along-route resolution tracked how fast the rider had been
    // going, and the cells were up to 2.7× the style's own `gridSize`.
    //
    // It was also internally inconsistent: `absDistance` below (which drives the
    // BEARING, and therefore which way the cross-section points) has always been
    // distance-based, so wherever the spacing was uneven the slice was drawn at
    // one place and aimed as if it were at another.
    const absDistance = input.cumulativeDistances[startIdx] + t * segLength;
    while (
      walk < endIdx - 1
      && input.cumulativeDistances[walk + 1] < absDistance
    ) walk++;
    const d0 = input.cumulativeDistances[walk];
    const d1 = input.cumulativeDistances[walk + 1];
    const localT = d1 > d0 ? Math.min(1, Math.max(0, (absDistance - d0) / (d1 - d0))) : 0;

    // Interpolate position on route
    const a = points[walk];
    const b = points[walk + 1];
    const lat = a.lat + (b.lat - a.lat) * localT;
    const lon = a.lon + (b.lon - a.lon) * localT;

    // Smoothed bearing for perpendicular cross-section (prevents overlap at sharp turns)
    const bearing = computeSmoothedBearing(points, input.cumulativeDistances, absDistance);
    const perpRad = ((bearing + 90) * Math.PI) / 180;

    for (let c = 0; c < crossCount; c++) {
      const offset = ((c / (crossCount - 1)) * 2 - 1) * corridorHalfWidth;

      // Offset point perpendicular to route
      const sampleLat = lat + (offset * Math.cos(perpRad)) / 111320;
      const sampleLon = lon + (offset * Math.sin(perpRad)) / (111320 * cosOrigin);

      // Get elevation from DEM (synchronous — tiles were prefetched above).
      // Null (uncached tile / fetch failure) falls back to GPX interpolation.
      const sampled = sampler.getElevationSync(sampleLat, sampleLon);
      // The elevation of a point is the DEM at that point — for EVERY column.
      //
      // The centre column used to be `DEM·0.5 + GPX·0.5`, "to prevent ball
      // floating/sinking", from when the rider's height came from the GPX and
      // the terrain from the DEM. The rider has since read its height off this
      // very grid (`raycastGroundHeight`), so the blend cannot stop it floating
      // — it can only make ONE column of the corridor disagree with the ground
      // either side of it, and it does: on this Taipei route the DEM reads the
      // tree canopy and sits +45.7 m above the recorded GPX, so half of that is
      // a 22.8 m notch one column wide, i.e. a ~10 m ditch running down the
      // exact strip the rider rides (measured: the road's own cells were 10.2 m
      // below the DEM while the cells 31 m to either side were on it). With the
      // corridor's folds cut away that ditch became the largest thing left: the
      // bike's nose crossing into a neighbouring cell went 10 m into the
      // hillside, 6.2 % of frames.
      //
      // ⚠ This does NOT touch the DEM-vs-GPX offset itself, which is a property
      // of the elevation source (terrarium reads canopy, not ground) and is the
      // same 45.7 m everywhere. All this removes is the ONE column that was
      // treated differently from its neighbours. The GPX is still the fallback
      // when the DEM has no answer, one line above.
      const ele = sampled !== null ? sampled : a.ele + (b.ele - a.ele) * localT;

      // Convert to scene coordinates (meters from origin)
      const x = (sampleLon - originLon) * 111320 * cosOrigin;
      const z = -(sampleLat - originLat) * 111320; // negate: +lat = north = -z in Three.js

      gx.push(x);
      gz.push(z);
      gele.push(ele);
      geoCoords.push({ lat: sampleLat, lon: sampleLon });

      // Procedural vertex color from the active style (same-zone-same-colour).
      const color = strategy.terrainVertexColor(ele, x, z);
      gcol.push(color.r, color.g, color.b);
    }
  }

  // Capture last section edge data for next chunk stitching (absolute eles too).
  const lastEdgeStart = (numSections - 1) * crossCount;
  const edgePositions: number[] = [];
  for (let c = 0; c < crossCount; c++) {
    const gi = lastEdgeStart + c;
    edgePositions.push(gx[gi], gele[gi] - originEle, gz[gi]);
  }
  const lastEdge: ChunkEdgeData = {
    positions: edgePositions,
    colors: gcol.slice(lastEdgeStart * 3, (lastEdgeStart + crossCount) * 3),
    geoCoords: geoCoords.slice(lastEdgeStart, lastEdgeStart + crossCount),
    eles: gele.slice(lastEdgeStart, lastEdgeStart + crossCount),
  };

  // ── Ground-height lookup grid ──
  // Per-section frame for world→cell inversion (see ChunkHeightGrid). Each cross
  // row is a straight perpendicular slice; the centre is the MIDPOINT of the two
  // lane columns (which is the route point itself — offset→lat/lon→scene is
  // affine, so the midpoint of ±half a cell is exactly offset 0), and the
  // "right" axis is the row's own direction (c=0 → c=cross-1).
  const centerX = new Float32Array(numSections);
  const centerZ = new Float32Array(numSections);
  const rightX = new Float32Array(numSections);
  const rightZ = new Float32Array(numSections);
  for (let s = 0; s < numSections; s++) {
    const base = s * crossCount;
    centerX[s] = (gx[base + laneColL] + gx[base + laneColR]) / 2;
    centerZ[s] = (gz[base + laneColL] + gz[base + laneColR]) / 2;
    let dx = gx[base + crossCount - 1] - gx[base];
    let dz = gz[base + crossCount - 1] - gz[base];
    const len = Math.hypot(dx, dz) || 1;
    rightX[s] = dx / len;
    rightZ[s] = dz / len;
  }
  // Half-width (centre → +edge) in scene metres; falls back to the nominal value
  // if the first row is degenerate. Measured from the same midpoint, in doubles
  // (centerX is Float32) so it lands on the nominal half-width exactly.
  const midX0 = (gx[laneColL] + gx[laneColR]) / 2;
  const midZ0 = (gz[laneColL] + gz[laneColR]) / 2;
  const halfWidth =
    Math.hypot(gx[crossCount - 1] - midX0, gz[crossCount - 1] - midZ0) ||
    corridorHalfWidth;

  // AABB reject bounds: section-centre extent grown by the corridor half-width
  // (+2% tolerance, matching sampleChunkHeight's crossLimit) plus one section's
  // spacing, so any point inside the corridor still passes while far-off queries
  // reject in O(1) before the section scan.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let maxSpacing = 0;
  for (let s = 0; s < numSections; s++) {
    if (centerX[s] < minX) minX = centerX[s];
    if (centerX[s] > maxX) maxX = centerX[s];
    if (centerZ[s] < minZ) minZ = centerZ[s];
    if (centerZ[s] > maxZ) maxZ = centerZ[s];
    if (s > 0) {
      const sp = Math.hypot(centerX[s] - centerX[s - 1], centerZ[s] - centerZ[s - 1]);
      if (sp > maxSpacing) maxSpacing = sp;
    }
  }
  const aabbPad = halfWidth * 1.02 + maxSpacing;
  minX -= aabbPad; maxX += aabbPad; minZ -= aabbPad; maxZ += aabbPad;

  // Typed copies of the grid vertex positions — the cell-quad index and every
  // ground query read these for the life of the chunk.
  const gxArr = Float32Array.from(gx);
  const gzArr = Float32Array.from(gz);

  // Build geometry — quantised blocks/sheets, or the smooth ramp fallback.
  let geometry: THREE.BufferGeometry;
  let material: THREE.Material | THREE.Material[];
  let heightGrid: ChunkHeightGrid;
  if (params.quantEnabled) {
    // Which cells are ground and which are the corridor folded onto itself.
    // Resampled at a quarter of the grid so the cut does not depend on how the
    // GPX happened to be recorded; the competing route reaches one chunk length
    // either side (see `buildMedialAxisMask`).
    const cellMask = buildMedialAxisMask(
      gx, gz, numSections, crossCount, corridorHalfWidth,
      sampleRouteForMask(
        points, input.cumulativeDistances,
        input.cumulativeDistances[startIdx] - segLength,
        input.cumulativeDistances[endIdx] + segLength,
        Math.max(4, gridSize / 4),
        originLat, originLon, cosOrigin,
      ),
      startIdx === 0 ? -Infinity : input.cumulativeDistances[startIdx],
      endIdx === points.length - 1 ? Infinity : input.cumulativeDistances[endIdx],
    );
    const data = buildQuantizedCorridorGeometry(
      { gx, gz, gele, gcol, along: numSections, cross: crossCount, cellMask },
      strategy,
      originEle,
    );
    geometry = quantizedDataToGeometry(data);
    // Ground grid = the exact flat-top height of every rendered cell.
    heightGrid = {
      quantized: true,
      along: numSections,
      cross: crossCount,
      halfWidth,
      minX, maxX, minZ, maxZ,
      centerX, centerZ, rightX, rightZ,
      heights: data.cellY,
      cellBand: data.cellBand,
      gx: gxArr,
      gz: gzArr,
      cellIndex: buildCellIndex(gxArr, gzArr, numSections, crossCount, data.cellY),
      _lastSection: 0,
    };
    // Groups 0…T-1 = printed top faces, then the cut-edge walls. A style may give
    // the walls their own material (paper → raw corrugated cardboard), and may
    // split them by band level (circuit → 2/4/6/8-layer FR4 edges).
    //
    // The TREADS split the same way when a style declares `terrainTopLevels`
    // (paper → level 0 is the cutting mat the model stands on, not a sheet of
    // board). `null` back from the hook means "this level has nothing of its
    // own", so every world that declares nothing gets exactly one tread material
    // from `createTerrainMaterial()` — the array it always had.
    const topMaterials: THREE.Material[] = [];
    for (let g = 0; g < data.topIndexCounts.length; g++) {
      topMaterials.push(
        strategy.createTerrainTopMaterialForLevel?.(g) ?? strategy.createTerrainMaterial(),
      );
    }
    const wallMaterials: THREE.Material[] = [];
    for (let g = 0; g < data.wallIndexCounts.length; g++) {
      const m = strategy.createTerrainWallMaterialForLevel?.(g)
        ?? strategy.createTerrainWallMaterial?.()
        ?? strategy.createTerrainMaterial();
      registerWallMaterial(m);
      wallMaterials.push(m);
    }
    // 最後一格是板子的側牆(demo `sideWallSeg` 的 `boardSideMat` / `edgeMat`)。
    // 它是 strategy 擁有的 singleton —— 已標 `userData.shared`,chunk 回收器放過
    // 它;`registerWallMaterial` 是牆的可見性診斷,側牆也是牆,所以一起註冊。
    if (strategy.sideWall) {
      const m = strategy.sideWall.createMaterial();
      registerWallMaterial(m);
      wallMaterials.push(m);
    }
    material = [...topMaterials, ...wallMaterials];
  } else {
    const positions: number[] = [];
    const uvs: number[] = [];
    for (let i = 0; i < gx.length; i++) {
      positions.push(gx[i], gele[i] - originEle, gz[i]);
      // World-plane UVs (raw metres) — same convention as the quantised tops.
      uvs.push(gx[i], gz[i]);
    }
    const indices: number[] = [];
    for (let s = 0; s < numSections - 1; s++) {
      for (let c = 0; c < crossCount - 1; c++) {
        const i0 = s * crossCount + c;
        const i1 = i0 + 1;
        const i2 = i0 + crossCount;
        const i3 = i2 + 1;
        indices.push(i0, i2, i1);
        indices.push(i1, i2, i3);
      }
    }
    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(gcol, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    // Smooth ramp: single style material with procedural vertex colors.
    material = strategy.createTerrainMaterial();
    // Ground grid = the per-vertex absolute elevation the ramp is built from
    // (bilinear-interpolated at query time).
    heightGrid = {
      quantized: false,
      along: numSections,
      cross: crossCount,
      halfWidth,
      minX, maxX, minZ, maxZ,
      centerX, centerZ, rightX, rightZ,
      heights: Float32Array.from(gele),
      _lastSection: 0,
    };
  }

  const mesh = new THREE.Mesh(geometry, material);
  // 陰影:地面**同時收影也投影**,而 demo 的底板只收不投——這是一處刻意的偏離。
  //
  // demo 的地面是一塊平的 130 m 寬底板(`board.receiveShadow = true`,castShadow
  // 留 false),世界的起伏另外用會投影的物件疊上去:電子的疊層小丘與散熱片環是
  // `m.castShadow = true`、塑膠的公園草皮只收影。gameview 沒有這個分工——底板跟
  // 山是同一張 heightfield,而兩者裡「山」才是重點:低角度太陽下,路旁的山把影子
  // 打過馬路,那是這條路線真正的樣子(實測這條台北路線,±180 m 內地形跨
  // +94.7 / −107.5 m)。castShadow 是逐物件的旗標,切不開,所以取有山的那一半。
  //
  // 便宜:三個 chunk 的地形合計 ~148 K 頂點,對照建築裝飾的 4.98 M 三角形
  // (render-probe CENSUS)是零頭。切邊牆面(group 1)跟踏面在同一個 mesh 裡,
  // 所以 demo 給底板側牆的那個 castShadow 是順帶拿到的,不是另外決定的。
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Chunk center for reference
  const midIdx = Math.floor((startIdx + endIdx) / 2);
  const centerPt = points[midIdx];

  return {
    mesh,
    chunkIndex,
    centerLat: centerPt.lat,
    centerLon: centerPt.lon,
    centerEle: centerPt.ele,
    lastEdge,
    heightGrid,
  };
}

// ── Helpers ──

export function computeGeoBounds(
  coords: { lat: number; lon: number }[],
): { south: number; north: number; west: number; east: number } {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const c of coords) {
    if (c.lat < south) south = c.lat;
    if (c.lat > north) north = c.lat;
    if (c.lon < west) west = c.lon;
    if (c.lon > east) east = c.lon;
  }
  return { south, north, west, east };
}
