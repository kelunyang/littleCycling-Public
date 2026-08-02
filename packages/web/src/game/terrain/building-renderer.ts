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
import { debugLog } from '@/game/debug-logger';
import type { ElevationSampler } from './elevation-sampler';
import type { MVTFeature } from './mvt-fetcher';
import { createYielder } from './build-yield';
import {
  mulberry32,
  type BoxPart,
  type BuildingBox,
  type PartShape,
  type TerrainStyleStrategy,
} from './terrain-style-strategy';
import type { ZoneAtFn, ZoneKind } from './land-zone';
import { geoSeed } from './geo-seed';
import {
  SIGN_TILT_RAD, SIGN_ZONES, signContent, signPlacement, signWorldOf,
  type SignVocabulary,
} from './sign-spec';
import {
  buildLightQuadInstancedMesh,
  createBuildingLightReservoir,
  disposeLightQuadMesh,
  type WindowPlacement,
} from './building-lights';

/** Footprints extruded per chunk. A dense Taipei chunk streams in thousands of
 *  footprints; past this we keep the largest (landmarks survive) and drop the
 *  rest, logging how many. Bounds both the geometry and the transient merge.
 *  Tier-scaled via setMaxBuildingsPerChunk (low keeps the N100 playable, high
 *  shows the full city) — affects newly built chunks only, like every other
 *  geometry knob. */
let maxBuildingsPerChunk = 3000;

/** Quality-tier hook — see QUALITY_PRESETS.maxBuildingsPerChunk. */
export function setMaxBuildingsPerChunk(n: number): void {
  maxBuildingsPerChunk = n;
}

/** Extruded footprints merged per batch (peak transient ≈ 2 batches, not the
 *  whole chunk). ~250 keeps the batch merge's parallel copy small while still
 *  amortising the final merge over few batch geometries. */
const BUILDING_MERGE_BATCH = 250;

/**
 * Zones where EVERY building signs itself. Everything else in `SIGN_ZONES` gets
 * one district marker per chunk — see the marker pass in `buildBuildingMeshes`.
 *
 * Known simplification: two separate schools inside one chunk share a marker.
 * Splitting them needs polygon identity through `zoneAt`, which is a bigger
 * change than the payoff; a chunk is ~1 km, so this is rare.
 */
const PER_BUILDING_SIGN_ZONES: ReadonlySet<ZoneKind> = new Set<ZoneKind>(['commercial']);

/** Shared ceiling on shop-sign width (metres) before each style's own cap.
 *  Without one, a sign on a warehouse becomes a wall. */
const SIGN_MAX_WIDTH_M = 12;

/** Fixed seed for the light reservoir so a chunk samples the same lights on
 *  every rebuild (uniform, but stable — not reshuffled each time it reloads). */
const WINDOW_SAMPLE_SEED = 0x9e3779b9;

/** Default building height when data is missing (meters). */
const DEFAULT_BUILDING_HEIGHT = 8;

/** How far a body is buried below its base so a block straddling two terrain
 *  treads never shows a floating slab edge. */
const SKIRT_M = 3;

/**
 * Clear ground kept between the ridden route's centreline and any building.
 *
 * The route ribbon's glow is 4.2 m wide (`strategy.routeLine.glowWidth`), so
 * 4 m leaves the tarmac whole with ~2 m of shoulder either side.
 *
 * Buildings do not actually stand on the road, but three things put them there
 * anyway: GPX traces drift a few metres, OpenMapTiles MERGES adjacent buildings
 * at z14 (95% of a dense Taipei tile arrives as MultiPolygons, and a merged
 * block swallows the streets inside it), and the matchbox body is an oriented
 * box, not the outline — an angled footprint's box spills past its own walls.
 * Measured over the saved Taipei route (10 452 points, 12 485 footprints):
 * the centreline runs THROUGH 37 footprints and within 4 m of 95, i.e. 0.76%.
 */
const ROUTE_CLEARANCE_M = 4;

/** A box trimmed thinner than this has stopped being a building — drop it. */
const MIN_TRIMMED_SIDE_M = 3;

/** Trim passes before a box is written off as sitting ON the route, not beside
 *  it. A graze clears in one or two; a block the route runs straight through
 *  never clears, and shrinking it 4 m at a time to nothing would be far more
 *  work than dropping it. */
const TRIM_PASSES = 4;

/** Spacing of the samples walked along each face, and the cap for a long wall.
 *  Only near-route boxes ever sample (one lookup rejects the rest), so this can
 *  be fine enough that the sampling error is small next to the clearance. */
const FACE_SAMPLE_STEP_M = 1;
const MAX_FACE_SAMPLES = 128;

/**
 * Distance in metres from a point in scene coordinates to the route centreline.
 * `Infinity` where nothing is indexed — the honest answer for "no constraint".
 */
export type RouteDistanceFn = (x: number, z: number) => number;

/**
 * Pull a building's box off the ridden route, or report that nothing usable is
 * left. Mutates `box`; returns false when the caller should drop the building.
 *
 * Trims rather than deletes because a merged block is a whole city block: the
 * route usually only clips a corner, and deleting it would leave a 70 m hole in
 * the streetscape to fix a 2 m overlap. Deleting is what happens when trimming
 * cannot converge, which is exactly the case where the route really does run
 * through the middle of the block.
 *
 * Faces are sampled at a spacing of `ROUTE_CLEARANCE_M`, not just at their
 * corners. The route can only reach the inside of a box by crossing a face, so
 * dense face sampling sees every intrusion — corner-only sampling misses the
 * one that matters most, a route entering the middle of a long wall.
 */
function trimBoxOffRoute(box: BuildingBox, routeDist: RouteDistanceFn): boolean {
  // One lookup rejects the ~99% of buildings that are nowhere near the route.
  const reach = Math.hypot(box.width, box.depth) / 2 + ROUTE_CLEARANCE_M;
  if (routeDist(box.cx, box.cz) > reach) return true;

  // A group rotated rotY about +y maps local (x, z) to (x·cos + z·sin,
  // −x·sin + z·cos) — the same transform the body build uses.
  const cos = Math.cos(box.rotY);
  const sin = Math.sin(box.rotY);
  const at = (lx: number, lz: number): number =>
    routeDist(box.cx + lx * cos + lz * sin, box.cz - lx * sin + lz * cos);

  /**
   * Closest the route comes to one face, and the error that sampling leaves.
   *
   * Distance-to-a-polyline is 1-Lipschitz along the face, so between two
   * samples `s` apart the true distance can dip `s/2` below both of them —
   * `guard` is that bound, and the caller demands `CLEARANCE + guard` so the
   * REAL clearance still lands on 4 m. Sampling at the clearance itself (the
   * first cut of this) left blocks 2.2 m from the route: exactly half a step.
   */
  const faceMin = (axis: 'u' | 'v', sign: number): { d: number; guard: number } => {
    const hw = box.width / 2;
    const hd = box.depth / 2;
    const span = axis === 'u' ? box.depth : box.width;

    // Coarse first, refining only while the bound cannot settle the question.
    // On a city street most walls face the road at 5–15 m and are proven clear
    // by four samples; paying 1 m spacing for all of them would cost a dense
    // chunk tens of thousands of route lookups it does not need.
    let steps = 4;
    for (;;) {
      steps = Math.min(MAX_FACE_SAMPLES, steps);
      let min = Infinity;
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps - 0.5) * span;
        const d = axis === 'u' ? at(sign * hw, t) : at(t, sign * hd);
        if (d < min) min = d;
      }
      const guard = span / steps / 2;
      const fineEnough = span / steps <= FACE_SAMPLE_STEP_M || steps >= MAX_FACE_SAMPLES;
      if (fineEnough || min - guard >= ROUTE_CLEARANCE_M) return { d: min, guard };
      steps *= 4;
    }
  };

  for (let pass = 0; pass < TRIM_PASSES; pass++) {
    const faces = [
      { axis: 'u' as const, sign: 1, ...faceMin('u', 1) },
      { axis: 'u' as const, sign: -1, ...faceMin('u', -1) },
      { axis: 'v' as const, sign: 1, ...faceMin('v', 1) },
      { axis: 'v' as const, sign: -1, ...faceMin('v', -1) },
    ];
    let worst = faces[0];
    for (const f of faces) if (f.d - f.guard < worst.d - worst.guard) worst = f;
    if (worst.d - worst.guard >= ROUTE_CLEARANCE_M) return true;

    // Pull that face back by the shortfall, leaving the OPPOSITE face where it
    // is: the axis loses `pen` and the centre moves half of it the other way.
    const pen = ROUTE_CLEARANCE_M + worst.guard - worst.d;
    if (worst.axis === 'u') {
      if (box.width - pen < MIN_TRIMMED_SIDE_M) return false;
      box.width -= pen;
      box.cx -= worst.sign * (pen / 2) * cos;
      box.cz += worst.sign * (pen / 2) * sin;
    } else {
      if (box.depth - pen < MIN_TRIMMED_SIDE_M) return false;
      box.depth -= pen;
      box.cx -= worst.sign * (pen / 2) * sin;
      box.cz -= worst.sign * (pen / 2) * cos;
    }
  }
  return false;
}

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
  /**
   * The light quads this chunk's buildings DECLARED, as one InstancedMesh over
   * a unit plane. Only the toy world has any — the other two light parts of
   * their bodies through `registerNightLitMaterial` and never place anything.
   */
  lightsMesh?: THREE.InstancedMesh;
  /**
   * Shop signs hung, per zone: `[zone, signs, buildings]`. Diagnostic only.
   * "Zoned buildings but no signs" looks exactly like "no such district here",
   * so the counts have to be reachable from outside — otherwise the failure is
   * invisible from a screenshot AND from the code.
   */
  signsByZone?: [ZoneKind, number, number][];
}

/**
 * Only footprints that actually fill their oriented bounding box get style trim
 * (a boxy roof on an L-shaped block would hang in mid-air). Ragged footprints
 * keep the plain extrusion.
 */
const OBB_FILL_THRESHOLD = 0.55;

// ── Instanced building bodies ───────────────────────────────────────────────
//
// A style whose bodies are boxes (`buildBuildingBoxes`) never builds geometry
// at all: it hands over a list of boxes and the whole chunk goes out as ONE
// InstancedMesh over a 24-vertex cube. Chunk 2 of the saved Taipei route is 794
// footprints / 14 620 boxes; merging them was 198 ms and 12.6 MB of vertex
// buffer, which measurement put at very nearly the entire chunk build.
//
// Read the win narrowly. It is CPU time and RAM. It is NOT fill rate — the same
// 175 k triangles are rasterised — and it is NOT culling: an InstancedMesh is
// frustum-culled as one object, exactly like the merged mesh it replaces, so
// the "one 175 k-triangle draw call spanning the whole chunk" note in
// plan/migrate-demo-worlds.md §5 still stands and still wants spatial bucketing.

/** Scratch for the per-box transform. Safe as module state: `pushBodyBoxes`
 *  never awaits, so two interleaved chunk builds cannot share one mid-write. */
const _boxMatrix = new THREE.Matrix4();
const _boxScale = new THREE.Vector3();
const _boxColor = new THREE.Color();
const _boxEuler = new THREE.Euler();
const _boxQuat = new THREE.Quaternion();
const _boxYawQuat = new THREE.Quaternion();
const _boxUpAxis = new THREE.Vector3(0, 1, 0);

/**
 * The instance geometry for one `BoxPart` shape, sized so a part's own extents
 * ARE the instance scale: a 1 m cube, or whatever the STYLE hands back for its
 * own key (`buildPartTemplate`, normalised to unit extents).
 *
 * Only `'box'` is built here. Everything else belongs to the style, because a
 * renderer-owned shape is a shape every style has to WANT - and the one time
 * this file owned a second primitive (a frustum with a fixed taper and eight
 * facets) it silently re-tapered and de-facetted the toy world's cup and threw
 * its rim away. See `PartShape`.
 *
 * The style's geometry is CLONED: a chunk frees its own instance geometry in
 * `disposeBuildingMesh`, and a style that cached its template would find it
 * disposed after one chunk.
 *
 * The white `color` attribute is not decoration, it is load-bearing. The
 * building material is shared with the merge path and therefore has
 * `vertexColors: true`; three defines `USE_COLOR` from the MATERIAL alone, so a
 * geometry without a `color` attribute leaves the shader reading the default
 * generic vertex attribute — (0, 0, 0) — and every instanced building comes out
 * black. White is the identity for the `vColor *= color; vColor *= instanceColor`
 * the shader then does. Applied HERE rather than left to the style, so a new
 * shape cannot be added without it.
 *
 * Fresh per chunk and freed by `disposeBuildingMesh`, same lifecycle as the
 * facade-window template.
 */
function unitPartGeometry(
  shape: PartShape,
  strategy: TerrainStyleStrategy,
): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry | null = null;
  if (shape !== 'box') {
    const template = strategy.buildPartTemplate?.(shape) ?? null;
    // Falling back to a cube would put a chunk full of cubes on screen with no
    // error anywhere - the exact silent failure an open key risks. Say it.
    if (!template) {
      throw new Error(`terrain style has no buildPartTemplate for BoxPart shape '${shape}'`);
    }
    geo = template.clone();
  }
  geo ??= new THREE.BoxGeometry(1, 1, 1);
  geo.deleteAttribute('uv'); // the building material has no map
  const n = geo.attributes.position.count;
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return geo;
}

/**
 * Accumulates a chunk's body boxes as raw instance data.
 *
 * Grown by doubling rather than collected as objects: holding 14 620 little
 * `{w,h,d,…}` records until the end of the build would put back a chunk of the
 * RAM this exists to save, and the arrays are what the InstancedMesh wants
 * anyway. Peak is ≤ 2× the final ~1.1 MB.
 */
class PartInstanceBatch {
  private matrices = new Float32Array(256 * 16);
  private colors = new Float32Array(256 * 3);
  count = 0;

  push(matrix: THREE.Matrix4, color: THREE.Color): void {
    if ((this.count + 1) * 16 > this.matrices.length) this.grow();
    this.matrices.set(matrix.elements, this.count * 16);
    const c = this.count * 3;
    this.colors[c] = color.r;
    this.colors[c + 1] = color.g;
    this.colors[c + 2] = color.b;
    this.count++;
  }

  private grow(): void {
    const m = new Float32Array(this.matrices.length * 2);
    m.set(this.matrices);
    this.matrices = m;
    const c = new Float32Array(this.colors.length * 2);
    c.set(this.colors);
    this.colors = c;
  }

  /** One shape's body draw call, or null if no style contributed that shape. */
  build(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.InstancedMesh | null {
    if (this.count === 0) { geometry.dispose(); return null; }
    const mesh = new THREE.InstancedMesh(geometry, material, this.count);
    // Hand over our own buffers instead of copying into the ones the
    // constructor just allocated. `subarray` keeps the doubling overshoot
    // alive, which is cheaper than a second full-size copy to trim it.
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(
      this.matrices.subarray(0, this.count * 16), 16,
    );
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      this.colors.subarray(0, this.count * 3), 3,
    );
    // Left for three to derive lazily — InstancedMesh.computeBoundingSphere
    // walks the instance matrices, which is the only way to get a sphere that
    // covers the chunk rather than the 1 m cube the geometry describes.
    mesh.boundingSphere = null;
    // Shadows: the demos' `box()` helper opens both flags on every body box
    // (`plastic:781-782`, `paper:1437-1438`), and this batch IS those boxes.
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
}

/**
 * One batch per `BoxPart` shape, built lazily so a chunk pays for nothing it
 * never saw. A style that only makes boxes still ends up with exactly one body
 * draw call, which is what it had before cones existed.
 */
class PartInstanceBatches {
  private readonly byShape = new Map<PartShape, PartInstanceBatch>();
  /** Parts pushed, across every shape. */
  count = 0;

  push(shape: PartShape, matrix: THREE.Matrix4, color: THREE.Color): void {
    let batch = this.byShape.get(shape);
    if (!batch) {
      batch = new PartInstanceBatch();
      this.byShape.set(shape, batch);
    }
    batch.push(matrix, color);
    this.count++;
  }

  /** The chunk's body draw calls, in the order the shapes first appeared.
   *
   *  ONE batch per shape, all of it on the shared building material. That is
   *  also why a body PART cannot be the thing that glows: a glow needs its own
   *  material, and a second material means a second batch. The corrugated
   *  world's lit beads and lit lid compartments would be exactly that, and they
   *  are light QUADS instead for this reason — see `buildBuildingLights`. */
  build(material: THREE.Material, strategy: TerrainStyleStrategy): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = [];
    for (const [shape, batch] of this.byShape) {
      const mesh = batch.build(unitPartGeometry(shape, strategy), material);
      if (mesh) out.push(mesh);
    }
    return out;
  }
}

/**
 * Bake one building's boxes into the chunk's instance batch.
 *
 * Same local-frame → scene transform the merged path applies with
 * `geometry.rotateY(box.rotY); geometry.translate(cx, baseY, cz)`, composed per
 * box instead of per vertex:
 *
 *   T(cx, baseY, cz) · Ry(box.rotY) · T(part) · R(part) · S(w, h, d)
 *
 * A part that only YAWS (four of the toy world's five bodies, and every part of
 * every other style) collapses the two rotations to one `makeRotationY`, which
 * is why that case is still spelled out separately. A part that TILTS (the clay
 * house's hand-pressed lumps) cannot: `Ry · Rxyz` is not an Euler triple, so it
 * is composed as quaternions, and the part's own euler is read in three's
 * default XYZ order because that is the order the demo's `e.set(...)` means.
 *
 * Either way the part's centre is turned by `box.rotY`
 * before it is placed — the same (x·cos + z·sin, −x·sin + z·cos)
 * mapping every other placement in this file uses.
 *
 * Non-uniform scale is safe for the normals: three divides the instance normal
 * by the squared column lengths before applying it (defaultnormal_vertex), so
 * the cube's axis-aligned face normals come out exact, not sheared.
 */
function pushBodyBoxes(
  box: BuildingBox,
  baseY: number,
  parts: readonly BoxPart[],
  out: PartInstanceBatches,
): void {
  const cos = Math.cos(box.rotY);
  const sin = Math.sin(box.rotY);
  for (const p of parts) {
    if (p.rotX || p.rotZ) {
      _boxEuler.set(p.rotX ?? 0, p.rotY ?? 0, p.rotZ ?? 0);
      _boxQuat.setFromEuler(_boxEuler);
      _boxYawQuat.setFromAxisAngle(_boxUpAxis, box.rotY);
      _boxMatrix.makeRotationFromQuaternion(_boxQuat.premultiply(_boxYawQuat));
    } else {
      _boxMatrix.makeRotationY(box.rotY + (p.rotY ?? 0));
    }
    _boxMatrix.scale(_boxScale.set(p.w, p.h, p.d));
    _boxMatrix.setPosition(
      box.cx + p.x * cos + p.z * sin,
      baseY + p.y,
      box.cz - p.x * sin + p.z * cos,
    );
    // `Color.setHex` applies the same sRGB→linear conversion `new THREE.Color`
    // does on the merge path, so an instanced body and a merged one painted
    // from the same palette entry come out the same colour.
    out.push(p.shape ?? 'box', _boxMatrix, _boxColor.setHex(p.color));
  }
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
  strategy: TerrainStyleStrategy,
  ground: (x: number, z: number) => number | null = () => null,
  routeDist: RouteDistanceFn = () => Infinity,
  zoneAt: ZoneAtFn = () => null,
  /**
   * Which shelf this chunk's shop signs draw their words from — the RIDE's
   * answer, handed down from `TerrainChunkManager` (see `SignVocabulary`).
   *
   * Defaults to `'shop'` so every existing caller (and every headless probe)
   * keeps the behaviour it had; the game's own path always passes one.
   */
  signVocabulary: SignVocabulary = 'shop',
): Promise<BuildingRenderResult> {
  if (footprints.length === 0) {
    return { mesh: new THREE.Mesh(), buildingCount: 0 };
  }

  // Per-chunk budget: past maxBuildingsPerChunk keep the largest footprints
  // (landmarks survive, slivers drop) — never a silent head-truncation. Ranking
  // is by cheap shoelace area on the outer ring in lon/lat: a plain number per
  // candidate, no per-footprint allocation, and within a chunk the latitude is
  // near-constant so raw lon/lat area preserves the size ordering we want.
  const working = selectBudgetedFootprints(footprints);

  const cosOrigin = Math.cos((originLat * Math.PI) / 180);
  const maybeYield = createYielder();
  const mergedBatches: THREE.BufferGeometry[] = [];
  let batch: THREE.BufferGeometry[] = [];
  /** Every part of every body a box-decomposing style handed over (see above),
   *  in one batch per shape. */
  const bodyBoxes = new PartInstanceBatches();
  const decorationGroups: THREE.Object3D[] = [];
  // Light quads a style DECLARED, reservoir-sampled during collection
  // (algorithm-R) so peak memory is the cap rather than every candidate. There
  // is no second reservoir any more: the generic facade grid that fed one is
  // gone (see building-lights.ts), so this holds only lights a building asked
  // for by name.
  const lights = createBuildingLightReservoir(mulberry32(WINDOW_SAMPLE_SEED));

  // Merge one batch, dispose its sources, keep the merged result. Peak transient
  // is thus ~1 batch of ExtrudeGeometry + its one merge copy, not the whole chunk.
  const flushBatch = (): void => {
    if (batch.length === 0) return;
    mergedBatches.push(mergeGeometries(batch));
    for (const g of batch) g.dispose();
    batch = [];
  };

  // Bodies actually built — `working.length` counts CANDIDATES, and several
  // paths below drop one (degenerate ring, no shape, standing on the route).
  let built = 0;
  let trimmedOffRoute = 0;
  let droppedOnRoute = 0;

  // ── Shop signs ──
  // Mounted HERE, not inside `buildBuildingDecoration`, for the same reason
  // facade windows are: only the renderer knows the box→scene transform, which
  // facade the ROUTE is on, and what else the chunk contains. A style supplies
  // the carrier (`buildSign`); placement and batching are the renderer's.
  const zoneBuildings = new Map<ZoneKind, number>();
  const zoneSigns = new Map<ZoneKind, number>();
  /** Largest candidate per signable zone, kept for the pass after the loop. */
  const zoneFallback = new Map<ZoneKind, { box: BuildingBox; baseY: number; seed: number }>();

  for (let fpIdx = 0; fpIdx < working.length; fpIdx++) {
    const fp = working[fpIdx];
    if (fp.coordinates.length < 3) continue;

    // Get base elevation at footprint centroid. The terrain build that ran just
    // before us has almost always cached the covering DEM tile, so the sync
    // lookup hits — only a cache miss (or a DEM hole) awaits a microtask.
    const centroid = polygonCentroid(fp.coordinates);
    let baseEle = sampler.getElevationSync(centroid[1], centroid[0]);
    if (baseEle === null) {
      try {
        baseEle = await sampler.getElevation(centroid[1], centroid[0]);
      } catch {
        baseEle = originEle;
      }
    }

    // Base = the BUILT terrain surface under the centroid (height grid) — a
    // raw DEM sample here reads the building's own height baked into the
    // surface-model raster and floats the box on a phantom spike. Fall back
    // to the quantised DEM only when no grid covers the point.
    const cx = (centroid[0] - originLon) * 111320 * cosOrigin;
    const cz = -(centroid[1] - originLat) * 111320;
    const baseY = ground(cx, cz) ?? strategy.quantizeElevation(baseEle) - originEle;

    // Assign vertex color based on building coordinate (same-zone-same-colour).
    // Up-facing vertices optionally take the style's roof colour (paper → raw
    // kraft board so the building reads as a cardboard box).
    const bColor = new THREE.Color(strategy.buildingColor(centroid[0], centroid[1]));
    const topColor = strategy.buildingTopColor !== undefined
      ? new THREE.Color(strategy.buildingTopColor)
      : null;

    // What kind of district is this building in? Null outside every zone —
    // which must NOT be read as residential, or a rural route becomes a suburb.
    const zone = zoneAt(centroid[0], centroid[1]);

    // ── The sign's seed is the BUILDING, not the loop counter ──
    //
    // `fpIdx` restarts at 0 in every chunk, so `signContent`'s word draw
    // replayed the same sequence every CHUNK_LENGTH (2000 m): the plastic
    // shelf's first twelve shops were BOAT CAFE DECO BEAD BOAT MALL DUO MART
    // HALL HALL BAKE BOAT, and then they were again, and again, for the whole
    // ride. On a training ride the shelf is six words instead of twenty-four
    // and the loop is that much more obvious.
    //
    // It is the same defect `street-lamp.ts`'s `poolIndexFor` and
    // `landuse-renderer.ts`'s `patchSeed` are both written against, in its
    // third host: an identity bound to an array position. Bound to the
    // building's own place on Earth instead, a shop keeps its name across a
    // chunk boundary, a chunk rebuild, a different tile window and a second
    // route through the same street — and two neighbours no longer inherit
    // consecutive draws just because they decoded next to each other.
    //
    // Only the SIGN moves. `fpIdx` still seeds the body, the trim and the
    // declared lights, because that is what the per-item demo diffs pin.
    const signSeed = geoSeed(centroid[0], centroid[1]);

    const obb = footprintOBB(fp.coordinates, originLat, originLon, cosOrigin);
    const matchbox = obb !== null && strategy.buildBuildingBody !== undefined;
    // A matchbox stands in for the footprint, so it must COVER THE SAME AREA,
    // not the footprint's bounding box. An L-shaped block or a footprint set at
    // an angle to its longest edge fills barely half its OBB, and a full-size
    // box there spills across the gaps into its neighbours — a street of them
    // merged into one continuous slab and ate the whole block's silhouette.
    // Shrinking both axes by √fill puts the block's footprint area back on the
    // building's own, centred where it belongs.
    const shrink = matchbox ? Math.sqrt(obb!.fill) : 1;
    const box: BuildingBox | null = obb && {
      cx: obb.cx,
      cz: obb.cz,
      width: obb.width * shrink,
      depth: obb.depth * shrink,
      rotY: obb.rotY,
      height: fp.height,
      baseY,
      skirt: SKIRT_M,
      color: bColor.getHex(),
    };

    // ── Keep off the road we ride on ──
    // Every downstream piece (body, trim, facade windows, window lights) is
    // derived from `box`, so trimming HERE moves all of them at once. A sliver
    // with no oriented box is extruded from its raw outline and cannot be
    // trimmed — for those the centroid test is the whole decision.
    if (box) {
      const before = box.width * box.depth;
      if (!trimBoxOffRoute(box, routeDist)) { droppedOnRoute++; continue; }
      if (box.width * box.depth < before - 0.5) trimmedOffRoute++;
    } else if (routeDist(cx, cz) < ROUTE_CLEARANCE_M) {
      droppedOnRoute++;
      continue;
    }

    // ── Body ──
    // Matchbox styles hand back ONE themed block for the whole building; the
    // literal MVT outline only survives where no oriented box exists (slivers,
    // sub-2m footprints), or for a style with no matchbox hook at all.
    //
    // Boxes first: a body that decomposes into boxes is INSTANCED and never
    // becomes geometry here (that is the whole point — see BoxInstanceBatch).
    // `buildBuildingBody` still answers for the bodies that are not all boxes,
    // and for styles that never declared the decomposition.
    let boxParts: BoxPart[] | null = null;
    let geometry: THREE.BufferGeometry | null = null;
    if (box) {
      boxParts = strategy.buildBuildingBoxes?.(box, fpIdx, zone) ?? null;
      if (!boxParts) geometry = strategy.buildBuildingBody?.(box, fpIdx, zone) ?? null;
    }
    const isMatchbox = boxParts !== null || geometry !== null;

    if (boxParts) {
      pushBodyBoxes(box!, baseY, boxParts, bodyBoxes);
    } else if (geometry) {
      // Local box frame → scene: exactly the transform a decoration Group with
      // position (cx, 0, cz) and rotation.y = rotY applies to its children.
      geometry.rotateY(box!.rotY);
      geometry.translate(box!.cx, baseY, box!.cz);
    } else {
      const shape = footprintToShape(fp.coordinates, originLat, originLon, cosOrigin);
      if (!shape) continue;
      // Foundation skirt: extrude a little below the base so a footprint
      // straddling two terrain treads never shows a floating slab edge.
      const extruded = new THREE.ExtrudeGeometry(shape, {
        depth: fp.height + SKIRT_M,
        bevelEnabled: false,
      });
      // Rotate from XY extrusion to XZ (horizontal), then translate up.
      extruded.rotateX(-Math.PI / 2);
      extruded.translate(0, baseY - SKIRT_M, 0);
      geometry = extruded;
    }

    // NOTHING is stamped on the walls here any more. This used to be
    // `collectBuildingWindows(...)` — a warm-yellow window every ~4 m along
    // every wall edge of every floor of every building in every world, which no
    // demo has and which ran even on the themed bodies whose own lights are
    // declared below.

    // Style trim (roof + windows). A matchbox body IS the oriented box, so the
    // trim always fits; the extrusion fallback keeps the old rectangularity
    // test (a boxy roof on an L-shaped block would hang in mid-air).
    if (box && (isMatchbox || obb!.fill >= OBB_FILL_THRESHOLD)) {
      const trim = strategy.buildBuildingDecoration(box, fpIdx, zone);
      if (trim) decorationGroups.push(trim);
      if (zone && SIGN_ZONES.has(zone)) {
        zoneBuildings.set(zone, (zoneBuildings.get(zone) ?? 0) + 1);
        // Shops sign themselves — that is what a shopfront IS. Schools and
        // hospitals get ONE identifying marker for the district instead
        // (DEVPLAN「學校與醫院各掛一塊」), handled in the pass below. Signing
        // every building there is both wrong and expensive: one Taipei chunk
        // has 26 school buildings, and 26 identical `ABC` plates is 13k
        // triangles spent saying the same thing 26 times.
        if (PER_BUILDING_SIGN_ZONES.has(zone)) {
          const sign = mountShopSign(
            strategy, box, baseY, signSeed, zone, routeDist, 0.8, signVocabulary,
          );
          if (sign) {
            decorationGroups.push(sign);
            zoneSigns.set(zone, (zoneSigns.get(zone) ?? 0) + 1);
          }
        }
        const prev = zoneFallback.get(zone);
        if (!prev || box.width * box.depth > prev.box.width * prev.box.depth) {
          zoneFallback.set(zone, { box: { ...box }, baseY, seed: signSeed });
        }
      }
      // ── Lights ──
      // Only what the STYLE declared. §3.9's rule is that whatever decided the
      // shape decides the lights, and there is no longer any fallback to fall
      // back to: a style with nothing to declare here has its lights as
      // materials on parts of its body instead (two of the three worlds), and a
      // footprint with no themed body legitimately has no lights at all.
      const declared = isMatchbox
        ? strategy.buildBuildingLights?.(box, fpIdx, zone)
        : undefined;
      if (declared !== undefined) {
        // Local box frame → scene. Same transform the body and the decorations
        // get; doing it here means a style never has to redo the trigonometry
        // (and never gets it subtly wrong). `w`/`h` ride through untouched —
        // a yaw does not resize a quad.
        const cosB = Math.cos(box.rotY);
        const sinB = Math.sin(box.rotY);
        for (const p of declared) {
          // A quad that only YAWS adds the two angles and is done. One that
          // TILTS cannot: `Ry · Rxyz` is not an Euler triple, so it goes through
          // quaternions and comes back as an XYZ triple — the same composition
          // `pushBodyBoxes` does for a tilted body part, for the same reason.
          let rx = 0;
          let ry = p.rotY + box.rotY;
          let rz = 0;
          if (p.rotX || p.rotZ) {
            _boxEuler.set(p.rotX ?? 0, p.rotY, p.rotZ ?? 0);
            _boxQuat.setFromEuler(_boxEuler);
            _boxYawQuat.setFromAxisAngle(_boxUpAxis, box.rotY);
            _boxEuler.setFromQuaternion(_boxQuat.premultiply(_boxYawQuat), 'XYZ');
            rx = _boxEuler.x;
            ry = _boxEuler.y;
            rz = _boxEuler.z;
          }
          lights.push({
            x: box.cx + p.x * cosB + p.z * sinB,
            y: baseY + p.y,
            z: box.cz - p.x * sinB + p.z * cosB,
            rotY: ry,
            rotX: rx,
            rotZ: rz,
            w: p.w,
            h: p.h,
            lit: p.lit,
          });
        }
      }
    }
    // A body that arrives WITH vertex colours painted them for a reason — the
    // brick stack colours every layer separately, and flooding it with the one
    // building colour would collapse the whole stack into a monolith. Only
    // paint bodies that came in bare. (An instanced body carries its colour per
    // instance and never reaches this.)
    if (geometry) {
      if (!geometry.getAttribute('color')) {
        const nrm = geometry.attributes.normal as THREE.BufferAttribute | undefined;
        const vCount = geometry.attributes.position.count;
        const colorArr = new Float32Array(vCount * 3);
        for (let v = 0; v < vCount; v++) {
          const c = topColor && nrm && nrm.getY(v) > 0.7 ? topColor : bColor;
          colorArr[v * 3] = c.r;
          colorArr[v * 3 + 1] = c.g;
          colorArr[v * 3 + 2] = c.b;
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));
      }

      batch.push(geometry);
      if (batch.length >= BUILDING_MERGE_BATCH) flushBatch();
    }
    built++;

    // Hand the thread back every ~10ms so a downtown chunk doesn't freeze the
    // frame (and V8 can GC the just-disposed batch sources between bursts).
    await maybeYield();
  }
  flushBatch();

  // ── District markers, and the empty-zone floor ──
  //
  // Two jobs, one pass, because they are the same operation:
  //  · A school / hospital district gets ONE marker, on its biggest building.
  //  · Any signable zone that ended up with NO sign gets one forced onto its
  //    biggest building at full width instead of 0.8 ×.
  //
  // The floor exists because "the chunk has a commercial district and not one
  // shop sign" is indistinguishable on screen from "there is no commercial
  // district here" — and the first is a bug. Relaxing the width cap is a
  // bounded, honest retry; fabricating a plate too small to read would not be,
  // which is why this can still come up empty and say so.
  for (const [zone, n] of zoneBuildings) {
    if (n === 0 || (zoneSigns.get(zone) ?? 0) > 0) continue;
    const fb = zoneFallback.get(zone);
    if (!fb) continue;
    const sign = mountShopSign(strategy, fb.box, fb.baseY, fb.seed, zone, routeDist, 1.0, signVocabulary);
    if (sign) {
      decorationGroups.push(sign);
      zoneSigns.set(zone, 1);
    } else {
      debugLog('chunk', 'zone has buildings but no sign would fit', {
        zone, buildings: n, widestM: Number(fb.box.width.toFixed(1)),
      });
    }
  }

  if (zoneBuildings.size > 0) {
    debugLog('chunk', 'shop signs hung', {
      byZone: [...zoneBuildings].map(([z, n]) => `${z} ${zoneSigns.get(z) ?? 0}/${n}`).join(', '),
    });
  }

  if (trimmedOffRoute > 0 || droppedOnRoute > 0) {
    debugLog('chunk', 'buildings kept clear of the route', {
      candidates: working.length, built, trimmedOffRoute, droppedOnRoute,
      clearanceM: ROUTE_CLEARANCE_M,
    });
  }

  if (mergedBatches.length === 0 && bodyBoxes.count === 0) {
    return { mesh: new THREE.Mesh(), buildingCount: 0 };
  }

  // Shared singleton material owned by the strategy (do not dispose here).
  const buildingMaterial = strategy.createBuildingMaterial();
  const instancedBodies = bodyBoxes.build(buildingMaterial, strategy);

  // Final merge of the per-batch geometries. Their normals were already smoothed
  // per source during the batch merge (recomputeNormals=true there), so we must
  // NOT recompute here — the batch geometries carry the exact normals the old
  // single merge produced. One batch → it already IS the final geometry.
  const merged =
    mergedBatches.length === 0
      ? null
      : mergedBatches.length === 1
        ? mergedBatches[0]
        : mergeGeometries(mergedBatches, false);
  if (mergedBatches.length > 1) {
    for (const g of mergedBatches) g.dispose();
  }

  // The chunk's root. With a box-decomposing style there is usually nothing
  // left to merge (the toy world merges only cup towers and slivers), and
  // parenting the instanced bodies to an empty Mesh would leave the scene a
  // geometry-less draw call with a meaningless bounding sphere — so in that
  // case the InstancedMesh IS the root. Everything downstream (the chunk
  // manager's add / remove / origin-shift, the decoration children below)
  // treats it as any other Object3D.
  //
  // With more than one shape in play the FIRST batch is the root and the rest
  // hang off it. Arbitrary, but it keeps the "no empty root" rule above without
  // inventing a container object, and the batches carry absolute matrices so
  // parenting one to another changes nothing about where they draw.
  let mesh: THREE.Mesh;
  if (merged) {
    mesh = new THREE.Mesh(merged, buildingMaterial);
    // Shadows: same as the instanced bodies above — walls cast and receive.
    // Set per mesh rather than by traversing the subtree, because the ink
    // outline hung below is an INVERTED HULL: it is a size larger than the body
    // by construction, so letting it cast would fatten every shadow in the
    // corrugated world by `inkThickness`. Leaving it at three's default false
    // is the whole guard.
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Ink outline (paper style) — added as a child so it tracks the mesh. It
    // hulls the MERGED walls only; paper has no box decomposition, so today it
    // still sees every body it ever did. A future style declaring both would
    // need the instanced bodies outlined some other way (an inverted-hull
    // InstancedMesh over the same matrices).
    const outline = strategy.createOutline?.(mesh);
    if (outline) mesh.add(outline);
    for (const body of instancedBodies) mesh.add(body);
  } else {
    mesh = instancedBodies[0];
    for (let i = 1; i < instancedBodies.length; i++) mesh.add(instancedBodies[i]);
  }

  // Roof flaps / caps / pips / sleeves: baked into scene space and collapsed per
  // material into ONE draw call each for the whole chunk, so N buildings' trim
  // costs a handful of draw calls instead of ~N–3N. Added as children so the
  // chunk manager's existing add / remove / origin-shift paths cover them for
  // free — including the instanced batches, whose buffers `disposeBuildingMesh`
  // frees through the same InstancedMesh.dispose() the bodies use.
  for (const deco of mergeBuildingDecorations(decorationGroups)) mesh.add(deco);

  // The reservoir is already capped, so the subsample inside is a no-op
  // (step = 1); this just builds the InstancedMesh from the sampled placements.
  // The first batch is `lightsMesh` (the chunk manager adds/removes/origin-
  // shifts it); any further `lit` keys hang under it, so they ride the same
  // paths for free.
  const lightBatches = buildDeclaredLightMeshes(strategy, lights.items);
  const lightsMesh = lightBatches[0];
  for (let i = 1; i < lightBatches.length; i++) lightsMesh.add(lightBatches[i]);

  return {
    mesh,
    buildingCount: built,
    lightsMesh,
    signsByZone: [...zoneBuildings].map(([z, n]) => [z, zoneSigns.get(z) ?? 0, n]),
  };
}

/**
 * Apply the per-chunk building budget. Under the cap the input is returned
 * untouched (so the decoration/window seeds — the footprint index — are stable
 * and the visual output is byte-identical to before). Over the cap, footprints
 * are ranked by outer-ring area (shoelace on lon/lat, one number each, no
 * per-candidate object) and the largest maxBuildingsPerChunk are kept; the
 * drop count is logged rather than silently swallowed.
 */
function selectBudgetedFootprints(footprints: BuildingFootprint[]): BuildingFootprint[] {
  if (footprints.length <= maxBuildingsPerChunk) return footprints;

  const areas = new Float64Array(footprints.length);
  for (let i = 0; i < footprints.length; i++) {
    areas[i] = footprintRingArea(footprints[i].coordinates);
  }
  // Sort indices (numbers only) by descending area, then take the top N.
  const order = Array.from(areas.keys());
  order.sort((a, b) => areas[b] - areas[a]);

  const kept: BuildingFootprint[] = new Array(maxBuildingsPerChunk);
  for (let i = 0; i < maxBuildingsPerChunk; i++) kept[i] = footprints[order[i]];

  debugLog('chunk', 'building budget exceeded — kept largest footprints', {
    total: footprints.length,
    kept: maxBuildingsPerChunk,
    dropped: footprints.length - maxBuildingsPerChunk,
  });
  return kept;
}

/** Shoelace area of a polygon's outer ring in lon/lat (relative size only). */
function footprintRingArea(coords: [number, number][]): number {
  const n = coords.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = coords[i];
    const [x1, y1] = coords[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/**
 * Batch every light quad a chunk's buildings declared into ONE InstancedMesh.
 *
 * The geometry is a UNIT plane and the size rides in each instance's scale, so
 * one batch serves lights of every size — which is what lets a style size each
 * light to the thing it lights instead of stamping one template (the demo's
 * `winQuadGeo = PlaneGeometry(1, 1)` + `ws.set(L[4], L[5], 1)`).
 *
 * The geometry is fresh per chunk (the chunk disposes it); the material is a
 * strategy-owned singleton tagged `userData.shared`, so `disposeBuildingMesh`
 * leaves it alone.
 */
function buildDeclaredLightMeshes(
  strategy: TerrainStyleStrategy,
  placements: WindowPlacement[],
): THREE.InstancedMesh[] {
  if (placements.length === 0 || !strategy.createBuildingLightMaterial) return [];
  // One batch per `lit` key — a style whose lights are all one kind (the toy
  // world) leaves the key undefined and gets exactly one, which is what it had.
  const byKey = new Map<string | undefined, WindowPlacement[]>();
  for (const p of placements) {
    let arr = byKey.get(p.lit);
    if (!arr) { arr = []; byKey.set(p.lit, arr); }
    arr.push(p);
  }
  const out: THREE.InstancedMesh[] = [];
  for (const [key, group] of byKey) {
    const mesh = buildLightQuadInstancedMesh(
      new THREE.PlaneGeometry(1, 1), strategy.createBuildingLightMaterial(key), group,
    );
    if (mesh) out.push(mesh);
  }
  return out;
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
  keep: (lon: number, lat: number) => boolean = () => true,
): BuildingFootprint[] {
  const footprints: BuildingFootprint[] = [];

  for (const feature of features) {
    if (feature.layer !== 'building') continue;

    // z14 OpenMapTiles merges adjacent buildings into MultiPolygons — in a
    // dense Taipei tile 95%+ of all footprints arrive that way. Treat every
    // sub-polygon as its own footprint (each keeps the feature's height);
    // skipping non-Polygon features silently dropped whole city blocks.
    let rings: [number, number][][];
    if (feature.geometry.type === 'Polygon') {
      rings = [(feature.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][]];
    } else if (feature.geometry.type === 'MultiPolygon') {
      rings = (feature.geometry as GeoJSON.MultiPolygon).coordinates.map(
        (poly) => poly[0] as [number, number][],
      );
    } else {
      continue;
    }

    const height =
      feature.properties.render_height ??
      feature.properties.height ??
      (feature.properties.levels ? feature.properties.levels * 3 : DEFAULT_BUILDING_HEIGHT);

    for (const coords of rings) {
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
      // Ownership + terrain-coverage clip: exactly one chunk builds a
      // footprint, and none is built floating past the corridor where no
      // ground exists.
      if (!keep(centroid[0], centroid[1])) continue;

      footprints.push({ coordinates: coords, height });
    }
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

  // rotateX(-90°) maps shape-Y to NEGATIVE world-Z, so the shape must store
  // +latitude metres (NOT the scene's negated z) — storing world z here
  // MIRRORED every extruded body across the origin's east-west axis while
  // the OBB decorations (built directly in world space) stayed put: whole
  // city blocks rendered kilometres away as black masses, with their roofs
  // floating at the real site. Ring order is reversed so the handedness
  // (and thus cap orientation/normals) stays what ExtrudeGeometry expects.
  const shape = new THREE.Shape();
  const last = coordinates[coordinates.length - 1];
  shape.moveTo(
    (last[0] - originLon) * 111320 * cosOrigin,
    (last[1] - originLat) * 111320,
  );
  for (let i = coordinates.length - 2; i >= 0; i--) {
    shape.lineTo(
      (coordinates[i][0] - originLon) * 111320 * cosOrigin,
      (coordinates[i][1] - originLat) * 111320,
    );
  }

  shape.closePath();
  return shape;
}

/**
 * Oriented bounding box of a footprint, in scene metres. The box axis is taken
 * from the LONGEST edge — for the rectangular-ish buildings that dominate MVT
 * data that lands within a degree or two of the true minimum-area box, at a
 * fraction of the cost of rotating calipers.
 *
 * `fill` is the polygon's area over the box's area: 1 = a perfect rectangle,
 * ~0.5 = an L-shape. Callers use it to decide whether a boxy roof fits.
 */
function footprintOBB(
  coordinates: [number, number][],
  originLat: number,
  originLon: number,
  cosOrigin: number,
): { cx: number; cz: number; width: number; depth: number; rotY: number; fill: number } | null {
  const n = coordinates.length;
  if (n < 3) return null;

  const pts: [number, number][] = coordinates.map(([lon, lat]) => [
    (lon - originLon) * 111320 * cosOrigin,
    -(lat - originLat) * 111320,
  ]);

  // Longest edge → box axis.
  let ux = 1;
  let uz = 0;
  let best = 0;
  for (let i = 0; i < n; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % n];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len > best) {
      best = len;
      ux = dx / len;
      uz = dz / len;
    }
  }
  if (best < 1e-6) return null;

  // Perpendicular axis, then extents along both.
  const vx = -uz;
  const vz = ux;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const [x, z] of pts) {
    const pu = x * ux + z * uz;
    const pv = x * vx + z * vz;
    if (pu < uMin) uMin = pu;
    if (pu > uMax) uMax = pu;
    if (pv < vMin) vMin = pv;
    if (pv > vMax) vMax = pv;
  }

  const width = uMax - uMin;
  const depth = vMax - vMin;
  if (width < 2 || depth < 2) return null;

  const uMid = (uMin + uMax) / 2;
  const vMid = (vMin + vMax) / 2;

  // Shoelace area of the footprint vs. the box area.
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % n];
    area2 += ax * bz - bx * az;
  }
  const fill = Math.abs(area2) / 2 / (width * depth);

  // A group rotated by rotY about +y maps its local +x to (cos, −sin) in (x, z),
  // so the axis we want (ux, uz) needs rotY = atan2(−uz, ux).
  return {
    cx: uMid * ux + vMid * vx,
    cz: uMid * uz + vMid * vz,
    width,
    depth,
    rotY: Math.atan2(-uz, ux),
    fill: Math.min(1, fill),
  };
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

/**
 * Texture slots that are sampled with the geometry's own uv, and therefore
 * decide whether a merged decoration needs one.
 *
 * `gradientMap` is deliberately absent: a toon material samples it by the
 * light's dot product, not by uv, and treating it as a uv map would put 8 bytes
 * a vertex on every toon-shaded decoration in the world for nothing. `envMap` is
 * absent for the same reason (reflection vector).
 */
const UV_SAMPLED_MAPS = [
  'map', 'alphaMap', 'aoMap', 'bumpMap', 'displacementMap', 'emissiveMap',
  'lightMap', 'metalnessMap', 'normalMap', 'roughnessMap', 'specularMap',
] as const;

/** Whether this material reads uv — see `UV_SAMPLED_MAPS`. */
function samplesUV(material: THREE.Material): boolean {
  const m = material as unknown as Record<string, unknown>;
  return UV_SAMPLED_MAPS.some((key) => m[key] != null);
}

/**
 * Hang one shop sign on a building and return it already placed in SCENE
 * coordinates, ready to go into `decorationGroups` (which merges per material —
 * a street of shops therefore costs a handful of draw calls, not three each).
 *
 * Three placement decisions, all of which have a wrong answer that looks fine
 * in a screenshot and fails on the bike:
 *
 *  1. WHICH FACE. The one nearest the route. A sign on the back of the building
 *     is a sign nobody will ever see, and it costs exactly as much to draw.
 *  2. HOW HIGH. 0.55–0.70 of the building height (DEVPLAN). Lower and the body
 *     of the building hides it as you come alongside. A style whose body has a
 *     LEDGE the sign belongs on may name the exact height (and any extra
 *     standoff its overhang needs) through `signAnchor` — the corrugated
 *     world's school writes its label across the middle archive box's lid rim,
 *     which a random draw inside the band would hit once in a while and miss
 *     the rest of the time.
 *  3. TILT. 8° down. The chase camera's eye is 6.3 m up, so a sign hung flat
 *     against a facade is edge-on to the rider — and tilting about its own
 *     centre swings the bottom edge INTO the wall, so the standoff has to grow
 *     by half the plate height × sin 8° to compensate.
 *
 * Ownership: the returned group's geometries are consumed (and disposed) by
 * `mergeBuildingDecorations`, so `SignParts.dispose()` must NOT be called here
 * — it would double-free. The materials are strategy-owned singletons.
 *
 * Exported for `npm run check:3d`: "the sign ended up on the side of the
 * building the rider is on" cannot be asserted once the chunk has merged every
 * decoration into one mesh per material.
 */
export function mountShopSign(
  strategy: TerrainStyleStrategy,
  box: BuildingBox,
  baseY: number,
  seed: number,
  zone: ZoneKind,
  routeDist: RouteDistanceFn,
  widthFrac: number,
  /** Shop shelf or training shelf — see `SignVocabulary`. A ride-wide
   *  constant, so it arrives as an argument rather than being read off the
   *  strategy: a world-style switch mid-ride builds a BRAND-NEW strategy with
   *  default params, and anything parked on those params would silently
   *  revert. The chunk manager outlives the switch; the strategy does not. */
  vocabulary: SignVocabulary = 'shop',
): THREE.Object3D | null {
  if (!strategy.buildSign) return null;
  // The words come from THIS world's shelf — a board does not sell cake.
  const content = signContent(zone, seed, signWorldOf(strategy.style), vocabulary);
  if (!content) return null;
  const place = signPlacement(box.width * (widthFrac / 0.8), box.height, seed, SIGN_MAX_WIDTH_M);
  if (!place) return null;
  // The style's own anchor, when it has one. Only the height and the standoff
  // move: the PLATE (width, ratio, glyphs) is still `signPlacement`'s and
  // `buildSign`'s, so a style cannot quietly shrink its sign out of legibility
  // here.
  const anchor = strategy.signAnchor?.(box, zone) ?? null;

  const sign = strategy.buildSign('shop', content.text, place.width, {
    zone,
    symbol: content.symbol,
    seed,
  });
  if (!sign) return null;

  // Pick the facade facing the route. Four outward normals in the box's own
  // frame; sample a point a little way off each and take the nearest to the
  // line we ride.
  const faces: { yaw: number; half: number }[] = [
    { yaw: 0, half: box.depth / 2 },              // +z
    { yaw: Math.PI, half: box.depth / 2 },        // -z
    { yaw: Math.PI / 2, half: box.width / 2 },    // +x
    { yaw: -Math.PI / 2, half: box.width / 2 },   // -x
  ];
  let best = faces[0];
  let bestDist = Infinity;
  for (const f of faces) {
    const a = f.yaw + box.rotY;
    const px = box.cx + Math.sin(a) * (f.half + 4);
    const pz = box.cz + Math.cos(a) * (f.half + 4);
    const d = routeDist(px, pz);
    if (d < bestDist) { bestDist = d; best = f; }
  }

  // Tilting about the plate's centre swings its lower edge outward by
  // (height/2)·sin(tilt); without that term the bottom of every sign is buried
  // in the wall it hangs on.
  const standoff = best.half + (anchor?.faceOut ?? 0) + 0.45
    + (sign.height / 2) * Math.sin(SIGN_TILT_RAD);

  sign.group.rotation.x = SIGN_TILT_RAD;

  const face = new THREE.Group();
  face.rotation.y = best.yaw;
  face.add(sign.group);
  sign.group.position.set(0, 0, standoff);

  const root = new THREE.Group();
  root.position.set(box.cx, baseY, box.cz);
  root.rotation.y = box.rotY;
  face.position.y = anchor?.centerY ?? place.centerY;
  root.add(face);
  return root;
}

/**
 * Collapse every building's decoration group (roof flaps, caps, pips, sleeves)
 * into ONE draw call per unique material for the whole chunk. Strategy-owned
 * trim materials (roofs/flaps/tape) collapse across the WHOLE chunk; per-chunk
 * materials collapse per building. Grouping is by material identity plus the two
 * shadow flags (see `batchKey`), so the output is pixel-identical to drawing
 * every decoration on its own.
 *
 * TWO paths out, and which one a decoration takes is the style's decision:
 *
 *  · BATCHED. An `InstancedMesh` over a geometry tagged by
 *    `markInstanceTemplate` never becomes vertices here at all — only its
 *    matrices are collected, and the chunk gets one InstancedMesh per
 *    (template, material). This is for the parts that repeat by the thousand at
 *    different sizes: a domino pip, an eraser sleeve. The template belongs to
 *    the strategy and is NOT disposed here; the chunk draws a clone of it.
 *  · MERGED. Everything else is copied into one buffer per material, with its
 *    world transform (and, for an untagged InstancedMesh, each instance matrix)
 *    folded into that single copy. Nothing is cloned and nothing is transformed
 *    in place — see `BakedMerge` for what that was costing.
 *
 * Sources are disposed at the end rather than as they are read: a decoration
 * whose geometry is read once per instance must not be freed after the first.
 * The merged geometries are freed by `disposeBuildingMesh`, which skips shared
 * materials.
 */
function mergeBuildingDecorations(groups: THREE.Object3D[]): THREE.Mesh[] {
  if (groups.length === 0) return [];

  /**
   * Batch key: material identity AND the two shadow flags — the circuit demo's
   * `batchOf`, which puts them in its key for a reason it wrote down:
   *
   * > 陰影旗標進 key:InstancedMesh 的 castShadow 是整批的,不是逐 instance 的。
   * > 輝光管數字 / 玻璃 / 光暈都是 castShadow=false,跟會投影的方塊混在一起就會
   * > 多出一堆本來沒有的影子。
   *
   * That is exactly this merge's situation. `circuit-terrain-style.ts` turns
   * castShadow OFF on ~20 parts (lens domes, nixie glass, halos) and the flags
   * are per-DRAW, not per-instance, so bucketing on material alone would hand
   * one batch two answers and silently keep whichever mesh arrived first.
   * (The paper demo's `batchGroup` ORs them instead — that is the same bug with
   * a fixed outcome, and it only passes there because paper has almost nothing
   * that declines to cast.)
   */
  const batchKey = (mat: THREE.Material, o: THREE.Object3D): string =>
    `${mat.uuid}|${o.castShadow ? 1 : 0}${o.receiveShadow ? 1 : 0}`;

  interface Flags { mat: THREE.Material; cast: boolean; recv: boolean }
  /** Per batch: the source geometries and where each one goes. The transform
   *  is CARRIED, not applied — see the note above for why. */
  const byMaterial = new Map<
    string,
    Flags & { geoms: THREE.BufferGeometry[]; transforms: THREE.Matrix4[] }
  >();
  /** Per batch, per template geometry: one matrix per instance, no vertices
   *  at all. This is the batched path. */
  const byTemplate = new Map<
    string,
    Flags & { byGeo: Map<THREE.BufferGeometry, THREE.Matrix4[]> }
  >();
  /** Disposed once each after the merges. An exploded InstancedMesh contributes
   *  the same geometry once per instance, so this cannot be a plain loop. */
  const sources = new Set<THREE.BufferGeometry>();

  const bucket = (mat: THREE.Material, o: THREE.Object3D) => {
    const key = batchKey(mat, o);
    let b = byMaterial.get(key);
    if (!b) {
      b = { mat, cast: o.castShadow, recv: o.receiveShadow, geoms: [], transforms: [] };
      byMaterial.set(key, b);
    }
    return b;
  };
  const templateBucket = (
    mat: THREE.Material, o: THREE.Object3D, tpl: THREE.BufferGeometry,
  ): THREE.Matrix4[] => {
    const key = batchKey(mat, o);
    let b = byTemplate.get(key);
    if (!b) {
      b = { mat, cast: o.castShadow, recv: o.receiveShadow, byGeo: new Map() };
      byTemplate.set(key, b);
    }
    let arr = b.byGeo.get(tpl);
    if (!arr) { arr = []; b.byGeo.set(tpl, arr); }
    return arr;
  };

  for (const group of groups) {
    group.updateMatrixWorld(true);
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material;
      if (!(material instanceof THREE.Material)) return; // decorations are single-material
      const inst = mesh as unknown as THREE.InstancedMesh;
      if (inst.isInstancedMesh) {
        const template = inst.geometry.userData.instanceTemplate === true;
        const out = template
          ? templateBucket(material, mesh, inst.geometry)
          : bucket(material, mesh);
        for (let i = 0; i < inst.count; i++) {
          // instance → group-local → scene, composed once.
          const m = new THREE.Matrix4();
          inst.getMatrixAt(i, m);
          m.premultiply(mesh.matrixWorld);
          if (Array.isArray(out)) {
            out.push(m);
          } else {
            out.geoms.push(inst.geometry);
            out.transforms.push(m);
          }
        }
        inst.dispose(); // frees the per-building instanceMatrix buffer
        // A TEMPLATE is a strategy-owned singleton that outlives the chunk —
        // freeing it here would empty the style's cache after one chunk.
        if (!template) sources.add(inst.geometry);
      } else {
        const b = bucket(material, mesh);
        b.geoms.push(mesh.geometry);
        b.transforms.push(mesh.matrixWorld.clone());
        sources.add(mesh.geometry);
      }
    });
  }

  const out: THREE.Mesh[] = [];
  for (const { mat: material, cast, recv, geoms, transforms } of byMaterial.values()) {
    // Baked normals are already correct once the transform is applied — they
    // must NOT be recomputed, or the trim shading shifts.
    const merged = new THREE.Mesh(
      mergeGeometries(geoms, false, { transforms, keepUV: samplesUV(material) }),
      material,
    );
    merged.castShadow = cast;
    merged.receiveShadow = recv;
    out.push(merged);
  }
  for (const { mat: material, cast, recv, byGeo } of byTemplate.values()) {
    for (const [template, matrices] of byGeo) {
      // The chunk draws a CLONE, so the chunk disposer can free it blindly and
      // the strategy's own copy survives. `BufferGeometry.copy` shares the
      // userData OBJECT rather than copying it, so the clone would otherwise
      // still claim to be a template.
      const geometry = template.clone();
      geometry.userData = {};
      const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
      for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = cast;
      mesh.receiveShadow = recv;
      // Derived lazily from the instance matrices, which is the only way to get
      // a sphere covering the chunk rather than the unit part.
      mesh.boundingSphere = null;
      out.push(mesh);
    }
  }
  for (const g of sources) g.dispose();
  return out;
}

/**
 * Options for the baked (decoration) merge.
 *
 * `transforms` is parallel to `geometries` — source i lands in the merged buffer
 * already transformed by transforms[i]. That is the whole point: the old path
 * cloned every source, called `applyMatrix4` on the clone (a pass over the
 * positions, then a pass over the normals, then a normalise), and only then
 * copied it into the merge. Four passes and a full extra allocation per source,
 * for something the copy loop can do on its way past. Chunk 2 of the saved
 * Taipei route, corrugated world, was 2 152 decoration meshes / 297 K vertices
 * and 90 ms of merging; it is 20 ms now (batching took most of the vertices
 * away, this took the extra passes off what is left). Output is the same
 * geometry to within float32 rounding — 7.5e-7 m, measured vertex by vertex.
 *
 * `keepUV` carries the uv attribute through. The decoration merge dropped it
 * unconditionally, which is why a TEXTURED card could not live in a decoration —
 * it sampled a single texel. (plan/migrate-demo-worlds.md §3.1: this is what
 * blocked the printed frames on the corrugated eraser's paper sleeve.) It is
 * asked for per MATERIAL (`samplesUV`) rather than always, because uv is 8 bytes
 * a vertex and almost every decoration in both worlds is flat colour: switching
 * it on unconditionally cost 1.2 MB of attribute memory across the scene for
 * nothing. The body merge never asks — the building material has no map.
 */
interface BakedMerge {
  transforms: readonly THREE.Matrix4[];
  keepUV?: boolean;
}

/**
 * Simple geometry merge (no dependency on BufferGeometryUtils).
 *
 * `recomputeNormals` (default true) recomputes smooth normals per source, as the
 * vertex-coloured building walls want. Baked decorations pass false: their
 * normals are already right once `bake.transforms` has turned them. The
 * vertex-colour buffer is allocated only when a source actually has one (walls
 * do; most trim doesn't), and uv only when `bake.keepUV` asks for it.
 */
function mergeGeometries(
  geometries: readonly THREE.BufferGeometry[],
  recomputeNormals = true,
  bake?: BakedMerge,
): THREE.BufferGeometry {
  let totalVerts = 0;
  let totalIndices = 0;
  let hasColor = false;
  let hasUV = false;

  for (const g of geometries) {
    totalVerts += g.attributes.position.count;
    totalIndices += g.index ? g.index.count : g.attributes.position.count;
    if (g.attributes.color) hasColor = true;
    if (g.attributes.uv) hasUV = true;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = hasColor ? new Float32Array(totalVerts * 3) : null;
  // Sources without uv leave zeros: every vertex in a merged buffer must have
  // one, and a part with no texture never samples it anyway.
  const uvs = hasUV && bake?.keepUV ? new Float32Array(totalVerts * 2) : null;
  const indices = new Uint32Array(totalIndices);

  const normalMatrix = new THREE.Matrix3();
  let vertOffset = 0;
  let idxOffset = 0;

  for (let gi = 0; gi < geometries.length; gi++) {
    const g = geometries[gi];
    if (recomputeNormals) g.computeVertexNormals();

    const pos = g.attributes.position.array as Float32Array;
    const norm = g.attributes.normal?.array as Float32Array | undefined;
    const col = g.attributes.color?.array as Float32Array | undefined;
    const uv = g.attributes.uv?.array as Float32Array | undefined;
    const count = g.attributes.position.count;
    const base = vertOffset * 3;

    const m = bake ? bake.transforms[gi].elements : null;
    if (m) {
      // Same maths `BufferGeometry.applyMatrix4` does — the full matrix on the
      // positions, its inverse-transpose (normalised) on the normals — folded
      // into the one copy that was happening anyway.
      const n = normalMatrix.getNormalMatrix(bake!.transforms[gi]).elements;
      for (let i = 0; i < count; i++) {
        const x = pos[i * 3];
        const y = pos[i * 3 + 1];
        const z = pos[i * 3 + 2];
        positions[base + i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
        positions[base + i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        positions[base + i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        if (norm) {
          const nx = norm[i * 3];
          const ny = norm[i * 3 + 1];
          const nz = norm[i * 3 + 2];
          let tx = n[0] * nx + n[3] * ny + n[6] * nz;
          let ty = n[1] * nx + n[4] * ny + n[7] * nz;
          let tz = n[2] * nx + n[5] * ny + n[8] * nz;
          const len = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
          tx /= len; ty /= len; tz /= len;
          normals[base + i * 3] = tx;
          normals[base + i * 3 + 1] = ty;
          normals[base + i * 3 + 2] = tz;
        }
      }
    } else {
      positions.set(pos.subarray(0, count * 3), base);
      if (norm) normals.set(norm.subarray(0, count * 3), base);
    }
    if (colors && col) colors.set(col.subarray(0, count * 3), base);
    if (uvs && uv) uvs.set(uv.subarray(0, count * 2), vertOffset * 2);

    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < g.index.count; i++) {
        indices[idxOffset + i] = src[i] + vertOffset;
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
  if (colors) merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (uvs) merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));

  return merged;
}

/**
 * Dispose building mesh resources: every geometry, plus the materials this
 * chunk owns. The wall material and the trim materials are strategy-owned
 * singletons (tagged `userData.shared`) and must survive; the ink outline's
 * material is per-chunk and must not.
 */
export function disposeBuildingMesh(result: BuildingRenderResult): void {
  result.mesh.geometry.dispose();
  // The ROOT is an InstancedMesh whenever a box-decomposing style left nothing
  // to merge. Its own `dispose()` is what fires the event three listens for to
  // free the instanceMatrix AND instanceColor GPU buffers — the geometry
  // dispose above frees neither, and a chunk that reloads on every pass would
  // leak ~1.1 MB of VRAM per visit.
  if ((result.mesh as unknown as THREE.InstancedMesh).isInstancedMesh) {
    (result.mesh as unknown as THREE.InstancedMesh).dispose();
  }
  for (const child of result.mesh.children) {
    child.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      // The outline shares the wall geometry — already freed above; disposing a
      // BufferGeometry twice is a no-op, so a blanket dispose is safe here.
      mesh.geometry?.dispose?.();
      // InstancedMesh (bodies, trim batches, instanced outlines): only its own
      // dispose() event frees the instanceMatrix/instanceColor GPU buffers.
      if ((mesh as unknown as THREE.InstancedMesh).isInstancedMesh) {
        (mesh as unknown as THREE.InstancedMesh).dispose();
      }
      const m = mesh.material;
      if (m instanceof THREE.Material && !m.userData.shared) m.dispose();
    });
  }
  // Declared light quads: geometry only (materials are shared singletons).
  // Extra `lit` keys ride as children of the first batch.
  if (result.lightsMesh) {
    for (const child of result.lightsMesh.children) {
      disposeLightQuadMesh(child as THREE.InstancedMesh);
    }
    disposeLightQuadMesh(result.lightsMesh);
  }
}
