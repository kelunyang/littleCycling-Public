/**
 * Route line mesh — the route drawn ON the road, the way the two demos do it:
 * a narrow marker stroke with a wider, fainter halo bleeding out from under it.
 *
 *  - paper (cuphead): a highlighter pen swiped along the route.
 *  - plastic: a neon tape strip with a soft spill.
 *
 * Both are flat, unlit `MeshBasicMaterial` ribbons — NO chase animation, NO
 * chevron arrows, NO bloom layer. The old floating runway-light line hovered 5 m
 * above the ground and read as a HUD overlay; in the third-person diorama the
 * route has to look drawn on the world, so it sits just above the road surface
 * (road = terrain + 0.3 m) and never moves.
 *
 * Colours/widths come from the world-style strategy (`strategy.routeLine`).
 */

import * as THREE from 'three';
import { applyOverlayDepth } from './overlay-depth';
import type { RoutePoint } from '@littlecycling/shared';
import type {
  RouteBody, RouteLineStyle, RoutePath, RoutePathPoint,
} from './terrain-style-strategy';

/**
 * Bloom layer index — objects on this layer are picked up by the selective bloom
 * pass. Nothing occupies it any more (the demo route line is flat and matte);
 * kept because `cycling-glasses-effect` still defines its bloom chain around it
 * and a future glow object would use it.
 */
export const BLOOM_LAYER = 1;

/**
 * Height above the raycast ground, in metres. The road ribbon now rides the same
 * raycast ground at +0.30 (ROAD_HEIGHT_OFFSET), so the stroke sits 15 cm proud
 * of the tarmac — the demos' road/highlighter gap (0.06 → 0.35) at our scale.
 *
 * (It used to be 0.6, which looked right only because the ROAD was wrong: the
 * road computed its own quantised height and sank into the terrain steps, so the
 * line had to hover to clear them. With both on the same ground, it comes down.)
 */
export const ROUTE_HEIGHT_OFFSET = 0.45;
const HEIGHT_OFFSET = ROUTE_HEIGHT_OFFSET;

/** The halo rides a hair below the core stroke, as in the demos (0.35 → 0.3). */
const GLOW_DROP = 0.05;

export interface RouteLineMeshOptions {
  heightOffset?: number;
  /** Look of the stroke — from the world-style strategy. */
  style: RouteLineStyle;
  /**
   * The world's own route BODY (`strategy.buildRouteBody`), for a world whose
   * route is an object along the path instead of a mark on the road — circuit's
   * chain of dupont wires. Given, the two ribbons are NOT built: drawing both
   * would put a painted stripe under a physical wire.
   */
  body?: (path: RoutePath) => RouteBody;
}

// ── The path, by mileage — what a route body walks ──

/**
 * Cumulative XZ arclength of the resampled polyline, metres.
 *
 * XZ only, and that is what makes a body's mileage chain stable: projecting onto
 * streamed-in terrain moves y alone, and a floating-origin re-base translates
 * every vertex equally, so neither changes a single distance here.
 */
function cumulativeXZ(positions: number[]): number[] {
  const n = positions.length / 3;
  const cum = new Array<number>(n);
  cum[0] = 0;
  for (let i = 1; i < n; i++) {
    const a = (i - 1) * 3, b = i * 3;
    cum[i] = cum[i - 1] + Math.hypot(positions[b] - positions[a], positions[b + 2] - positions[a + 2]);
  }
  return cum;
}

/**
 * A `RoutePath` over the group's live position array — the gameview counterpart
 * of the demos' `pathAt(d)`.
 *
 * The tangent is the containing segment's direction, which is the SAME convention
 * `fillRibbon` uses for its perpendicular, so a body offset by `+lateral` lands on
 * the same side of the route the ribbon's `+half` edge did. (The demo blends the
 * two neighbouring segment directions; that smooths ITS synthetic path, whose
 * vertices are a fixed 6 m grid of heading steps. A real GPX trace bends where it
 * bends, and the resampled vertices already are that bend.)
 */
function makeRoutePath(group: THREE.Group): RoutePath {
  const positions = group.userData._routePositions as number[];
  const cum = group.userData._routeCum as number[];
  const n = cum.length;
  const out: RoutePathPoint = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
  return {
    get lengthM() { return n > 0 ? cum[n - 1] : 0; },
    at(d: number): RoutePathPoint {
      if (n === 0) return out;
      if (n === 1) {
        out.x = positions[0]; out.y = positions[1]; out.z = positions[2];
        return out;
      }
      // Binary search for the segment holding `d` (clamped at both ends).
      const target = Math.max(0, Math.min(d, cum[n - 1]));
      let lo = 0, hi = n - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= target) lo = mid; else hi = mid;
      }
      const a = lo * 3, b = hi * 3;
      const seg = cum[hi] - cum[lo];
      const t = seg > 1e-9 ? (target - cum[lo]) / seg : 0;
      out.x = positions[a] + (positions[b] - positions[a]) * t;
      out.y = positions[a + 1] + (positions[b + 1] - positions[a + 1]) * t;
      out.z = positions[a + 2] + (positions[b + 2] - positions[a + 2]) * t;
      const dx = positions[b] - positions[a], dz = positions[b + 2] - positions[a + 2];
      const len = Math.hypot(dx, dz);
      if (len > 1e-9) { out.tx = dx / len; out.tz = dz / len; }
      return out;
    },
  };
}

/** The body hanging off a route-line group, if this world has one. */
function bodyOf(group: THREE.Group): RouteBody | null {
  return (group.userData._routeBody as RouteBody | undefined) ?? null;
}

/** Vertex index → metres along the route. */
function mileageAt(group: THREE.Group, vertexIdx: number): number {
  const cum = group.userData._routeCum as number[] | undefined;
  if (!cum || cum.length === 0) return 0;
  return cum[Math.max(0, Math.min(vertexIdx, cum.length - 1))];
}

// ── Geometry ──

/**
 * Write a flat XZ ribbon of the given width, centred on the route, into `pos`.
 * Two vertices per route point (left/right of the path), so the vertex count is
 * fixed — a re-projection onto streamed-in terrain rewrites in place.
 */
function fillRibbon(pos: Float32Array, positions: number[], width: number, yLift: number): void {
  const n = positions.length / 3;
  const half = width / 2;

  let lastPx = 0;
  let lastPz = 1; // fallback perpendicular for a degenerate first segment

  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const x = positions[i3], y = positions[i3 + 1], z = positions[i3 + 2];

    // Direction from the neighbouring point (reuse the last one when degenerate).
    const j3 = i < n - 1 ? i3 + 3 : i3 - 3;
    let dx = positions[j3] - x;
    let dz = positions[j3 + 2] - z;
    if (i === n - 1) { dx = -dx; dz = -dz; }
    const len = Math.hypot(dx, dz);
    let px = lastPx, pz = lastPz;
    if (len > 1e-3) {
      px = -dz / len;
      pz = dx / len;
      lastPx = px;
      lastPz = pz;
    }

    const vi = i * 2;
    pos[vi * 3] = x + px * half;
    pos[vi * 3 + 1] = y + yLift;
    pos[vi * 3 + 2] = z + pz * half;
    pos[(vi + 1) * 3] = x - px * half;
    pos[(vi + 1) * 3 + 1] = y + yLift;
    pos[(vi + 1) * 3 + 2] = z - pz * half;
  }
}

function buildRibbonGeometry(
  positions: number[],
  width: number,
  yLift: number,
): THREE.BufferGeometry | null {
  const n = positions.length / 3;
  if (n < 2) return null;

  const pos = new Float32Array(n * 2 * 3);
  fillRibbon(pos, positions, width, yLift);

  const indices: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, b, c, b, d, c);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * One ribbon layer. `renderOrder` keeps the core stroke over its own halo, and
 * `depthWrite: false` keeps both from occluding the coins/props above them.
 */
function buildLayer(
  name: string,
  positions: number[],
  width: number,
  yLift: number,
  color: number,
  opacity: number,
  renderOrder: number,
): THREE.Mesh | null {
  const geo = buildRibbonGeometry(positions, width, yLift);
  if (!geo) return null;

  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  // The route mark still depth-TESTS against the terrain even though it does
  // not write depth, so at range it dashes in and out exactly like the road
  // ribbons did. `name` is 'core' or 'glow' here.
  applyOverlayDepth(mat, name === 'core' ? 'routeCore' : 'routeGlow');

  const mesh = new THREE.Mesh(geo, mat);
  // Namespaced so the scene-inspector's layer list can group it; `check:3d`
  // asserts on this exact string.
  mesh.name = `route/${name}`;
  mesh.renderOrder = renderOrder;
  mesh.userData._ribbonWidth = width;
  mesh.userData._ribbonLift = yLift;
  return mesh;
}

/** Rewrite both ribbons' vertices from the group's current positions. */
function refreshRibbons(group: THREE.Group): void {
  const positions = group.userData._routePositions as number[] | undefined;
  if (!positions) return;

  for (const child of group.children) {
    const mesh = child as THREE.Mesh;
    const attr = mesh.geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!attr) continue;
    fillRibbon(
      attr.array as Float32Array,
      positions,
      mesh.userData._ribbonWidth as number,
      mesh.userData._ribbonLift as number,
    );
    attr.needsUpdate = true;
    // Both caches go stale when the vertices move in place — the sphere drives
    // frustum culling, the box drives raycasts/Box3. Recompute both or the line
    // gets culled (or measured) against where it used to be.
    mesh.geometry.computeBoundingSphere();
    mesh.geometry.computeBoundingBox();
  }
}

/**
 * Vertex spacing along the route, in metres.
 *
 * GPX points are FAR too sparse to lay a mark on the ground with: on our routes
 * the median gap is ~70 m, the 90th percentile ~240 m, and the worst single leg
 * is over 2 km. One vertex per GPX point means the ribbon is a long straight
 * plank that only touches the terrain at its two ends — it sinks through the
 * quantised terrain steps and the road ribbon in between, and cuts the corner on
 * every bend. That is the "guide line overlaps the road" the demos never show:
 * they emit a vertex every few metres along their path.
 *
 * So we resample. 6 m ≈ the demos' segment length; a 60 km route becomes ~10k
 * vertices × 2 ribbons, which is nothing.
 */
const RESAMPLE_STEP_M = 6;

/**
 * Route polyline resampled to a fixed spacing, in scene metres.
 *
 * `srcIdx[i]` is the ORIGINAL route-point index the vertex came from (ascending).
 * `projectRouteLineOntoTerrain`'s `range` is expressed in original point indices
 * (that is what `TerrainChunkManager.getChunkPointRange` returns), so without
 * this mapping a chunk load would re-project the wrong slice of the line.
 */
interface ResampledRoute {
  positions: number[];
  srcIdx: number[];
  /** Per-vertex GPS altitude in scene metres (ele − originEle) — the layer
   *  disambiguator for `projectRouteLineOntoTerrain`: at a switchback the
   *  terrain covers one (x, z) at two heights, and without this the line
   *  snaps to whichever deck the scan finds first and zigzags through the air. */
  gpsY: number[];
}

function toScenePositions(
  points: RoutePoint[],
  originLat: number,
  originLon: number,
  originEle: number,
  heightOffset: number,
): ResampledRoute {
  const cosOrigin = Math.cos((originLat * Math.PI) / 180);
  const sx = (p: RoutePoint) => (p.lon - originLon) * 111320 * cosOrigin;
  const sz = (p: RoutePoint) => -(p.lat - originLat) * 111320;

  const positions: number[] = [];
  const srcIdx: number[] = [];
  const gpsY: number[] = [];
  if (points.length === 0) return { positions, srcIdx, gpsY };

  const push = (x: number, z: number, i: number, y: number) => {
    positions.push(x, heightOffset, z);
    srcIdx.push(i);
    gpsY.push(y);
  };

  for (let i = 0; i < points.length - 1; i++) {
    const x0 = sx(points[i]), z0 = sz(points[i]);
    const x1 = sx(points[i + 1]), z1 = sz(points[i + 1]);
    const y0 = points[i].ele - originEle;
    const y1 = points[i + 1].ele - originEle;
    const len = Math.hypot(x1 - x0, z1 - z0);

    push(x0, z0, i, y0);

    // Interior samples — the segment's own end is emitted by the next iteration
    // (or by the tail push below), so stop short of it.
    const steps = Math.floor(len / RESAMPLE_STEP_M);
    for (let s = 1; s <= steps; s++) {
      const t = (s * RESAMPLE_STEP_M) / len;
      if (t >= 1) break;
      push(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, i, y0 + (y1 - y0) * t);
    }
  }

  const last = points.length - 1;
  push(sx(points[last]), sz(points[last]), last, points[last].ele - originEle);

  return { positions, srcIdx, gpsY };
}

/** First vertex whose source point index is >= `value` (srcIdx ascending). */
function lowerBoundSrc(srcIdx: number[], value: number): number {
  let lo = 0, hi = srcIdx.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (srcIdx[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ── Public API ──

/** Create the route line group: halo ribbon + marker-stroke ribbon over it. */
export function createRouteLine(
  points: RoutePoint[],
  originLat: number,
  originLon: number,
  _originEle: number,
  _resolution: { width: number; height: number },
  options: RouteLineMeshOptions,
): THREE.Group {
  const { style } = options;
  const heightOffset = options.heightOffset ?? HEIGHT_OFFSET;
  const { positions, srcIdx, gpsY } = toScenePositions(points, originLat, originLon, _originEle, heightOffset);

  const group = new THREE.Group();
  group.userData._routePositions = positions;
  group.userData._routeSrcIdx = srcIdx;
  group.userData._routeGpsY = gpsY;
  group.userData._routeCum = cumulativeXZ(positions);
  group.userData._routeStyle = style;

  // A world with its own route body gets THAT and not the ribbons.
  if (options.body && positions.length >= 6) {
    const body = options.body(makeRoutePath(group));
    group.userData._routeBody = body;
    group.add(body.group);
    return group;
  }

  // Halo first (renderOrder 9), stroke on top (10) — the demos' ordering.
  const glow = buildLayer(
    'glow', positions, style.glowWidth, -GLOW_DROP, style.glowColor, style.glowOpacity, 9,
  );
  if (glow) group.add(glow);

  const core = buildLayer(
    'core', positions, style.coreWidth, 0, style.coreColor, style.coreOpacity, 10,
  );
  if (core) group.add(core);

  return group;
}

/** Update the route line when the floating origin changes. */
export function updateRouteLineOrigin(
  group: THREE.Group,
  points: RoutePoint[],
  originLat: number,
  originLon: number,
  _originEle: number,
  heightOffset = HEIGHT_OFFSET,
): void {
  const { positions, srcIdx, gpsY } = toScenePositions(points, originLat, originLon, _originEle, heightOffset);
  group.userData._routePositions = positions;
  group.userData._routeSrcIdx = srcIdx;
  group.userData._routeGpsY = gpsY;
  group.userData._routeCum = cumulativeXZ(positions);
  const body = bodyOf(group);
  // A re-base translates the whole path, so every joint moves — and the heights
  // it had came from a ground function this call does not have. Re-seat the whole
  // body from the path itself; the next chunk projection puts the ground back.
  if (body) body.refresh(() => null, 0, Number.POSITIVE_INFINITY);
  else refreshRibbons(group);
}

/**
 * Project the route line onto terrain by sampling ground height per vertex —
 * this is what makes the mark hug the ground instead of hovering over it.
 *
 * `heightFn` is the chunk manager's `raycastGroundHeight`, which is now an
 * O(1)/coherent height-grid lookup (a warm-started section scan against the
 * BUILT terrain surface) rather than a per-vertex mesh raycast — the ribbon can
 * resample thousands of vertices along a streamed-in chunk without the old
 * O(triangles)-per-vertex hitch. `range` still limits the work to the span that
 * just gained terrain (one chunk); omit it to reproject everything (style
 * switch). Because the resampled vertices are walked in route order, the grid's
 * `_lastSection` coherence cache keeps each lookup a couple of comparisons.
 *
 * NOTE `range` is in ORIGINAL route-point indices (that is what the chunk manager
 * knows about); the ribbon's vertices are resampled, so the span is translated
 * through `_routeSrcIdx` first.
 */
export function projectRouteLineOntoTerrain(
  group: THREE.Group,
  heightFn: (x: number, z: number, gpsY: number) => number | null,
  heightOffset = HEIGHT_OFFSET,
  range?: { startIdx: number; endIdx: number },
): number {
  const positions = group.userData._routePositions as number[] | undefined;
  const srcIdx = group.userData._routeSrcIdx as number[] | undefined;
  const gpsYArr = group.userData._routeGpsY as number[] | undefined;
  if (!positions || !srcIdx) return 0;

  const vertexCount = positions.length / 3;
  // Original-point span → resampled-vertex span. endIdx is inclusive, so take
  // every vertex before the first one belonging to the point after it.
  const from = range ? lowerBoundSrc(srcIdx, range.startIdx) : 0;
  const to = range
    ? Math.min(vertexCount - 1, lowerBoundSrc(srcIdx, range.endIdx + 1) - 1)
    : vertexCount - 1;
  let projected = 0;

  for (let i = from; i <= to; i++) {
    const i3 = i * 3;
    const groundY = heightFn(positions[i3], positions[i3 + 2], gpsYArr?.[i] ?? positions[i3 + 1]);
    if (groundY !== null) {
      positions[i3 + 1] = groundY + heightOffset;
      projected++;
    }
  }

  if (projected === 0) return 0;

  const body = bodyOf(group);
  if (body) {
    // The body asks the ground for ITS own (off-centreline) footing, so it gets
    // the height function rather than the reprojected centreline. `gpsY` is the
    // deck disambiguator, exactly as above.
    body.refresh(
      (x, z, preferY) => heightFn(x, z, preferY),
      mileageAt(group, from),
      mileageAt(group, to),
    );
  } else {
    refreshRibbons(group);
  }
  return projected;
}

/**
 * Restrict both ribbons to the sample window covering original point indices
 * [startIdx, endIdx] — the guide line's DISTANT segments otherwise snake along
 * far mountain ridges as permanent dark lines across the sky (the glow halo is
 * a 4.2m translucent ribbon; against the sky it reads as a black line). Pass
 * null to show the whole route again.
 */
export function setRouteLineWindow(
  group: THREE.Group,
  range: { startIdx: number; endIdx: number } | null,
): void {
  const srcIdx = group.userData._routeSrcIdx as number[] | undefined;
  if (!srcIdx || srcIdx.length < 2) return;
  let start = 0;
  let count = Number.POSITIVE_INFINITY;
  let from = 0;
  let to = srcIdx.length - 1;
  if (range) {
    from = lowerBoundSrc(srcIdx, range.startIdx);
    to = Math.min(srcIdx.length - 1, lowerBoundSrc(srcIdx, range.endIdx + 1) - 1);
    start = from * 6;
    count = Math.max(0, to - from) * 6;
  }
  const body = bodyOf(group);
  if (body) {
    body.window(range ? { d0: mileageAt(group, from), d1: mileageAt(group, to) } : null);
    return;
  }
  for (const child of group.children) {
    const mesh = child as THREE.Mesh;
    const geo = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geo?.index) continue;
    geo.setDrawRange(start, Math.min(count, Math.max(0, geo.index.count - start)));
  }
}

/** Dispose all route line resources. */
export function disposeRouteLine(group: THREE.Group): void {
  const body = bodyOf(group);
  if (body) {
    // The body owns its geometry and NOT its materials (they are the strategy's
    // shared singletons), so it disposes itself — this file must not walk into it
    // and dispose materials another chunk is still drawing with.
    body.dispose();
    group.userData._routeBody = undefined;
    group.clear();
    return;
  }
  for (const child of [...group.children]) {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    (mesh.material as THREE.Material | undefined)?.dispose();
  }
  group.clear();
}
