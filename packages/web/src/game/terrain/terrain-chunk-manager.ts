/**
 * Terrain chunk manager: splits the route into ~2km chunks, loads/unloads
 * them based on the ball's current position, and caches meshes for lap races.
 *
 * Lifecycle:
 * - Keep 3-5 chunks in the scene (current + 1 behind + 1-3 ahead)
 * - Preload first 10km (5 chunks) at game start
 * - When ball enters the back half of a chunk, start loading the next
 * - Chunks that are > 2 chunks behind are removed from scene but kept in cache
 * - On lap race: cached chunks are re-added to scene instantly
 * - The cache is capped (CHUNK_CACHE_MAX): past that, the chunks furthest from
 *   the rider are disposed, so a long ride doesn't grow the heap without bound
 */

import * as THREE from 'three';
import type { RoutePoint } from '@littlecycling/shared';
import { buildCumulativeDistances } from '../route-geometry';
import { debugLog, isDebugEnabled } from '@/game/debug-logger';
import { ElevationSampler } from './elevation-sampler';
import {
  buildTerrainChunk,
  computeGeoBounds,
  sampleChunkHeight,
  type ChunkBuildInput,
  type ChunkEdgeData,
  type ChunkHeightGrid,
  type TerrainChunkResult, maxChunkHeight } from './terrain-chunk';
import { MVTFetcher, type MVTFeature } from './mvt-fetcher';
import { buildRoadMeshes, disposeRoadMesh, type RoadRenderResult } from './road-renderer';
import { buildWaterwayMeshes, disposeWaterwayMesh, type WaterwayRenderResult } from './waterway-renderer';
import { buildAerowayMeshes, disposeAerowayMeshes, type AerowayRenderResult } from './aeroway-renderer';
import { buildBuildingMeshes, extractBuildingsFromMVT, disposeBuildingMesh, type BuildingRenderResult } from './building-renderer';
import { buildLanduseMeshes, disposeLanduseMeshes, extractPolygonCoords, isUrbanLanduse, landuseMeshes, type LanduseRenderResult } from './landuse-renderer';
import { buildTreeMeshes, disposeTreeMesh, type TreeRenderResult } from './tree-renderer';
import { extractZoneFeatures, estimateZoneFeatureBytes, type ZoneFeatures } from './zone-detector';
import type { TerrainStyleStrategy } from './terrain-style-strategy';
import { ZoneIndex, zoneFromLanduseClass, type ZoneKind } from './land-zone';
import type { SignVocabulary } from './sign-spec';
import {
  buildGroundStuds, disposeGroundStuds, applyStudLod, STUD_BLOCKING_LANDUSE,
  type GroundStudResult,
} from './ground-studs';


/** Approximate length of each chunk in meters. */
export const CHUNK_LENGTH = 2000;

/** Number of chunks to keep in the scene ahead of the ball. */
export const CHUNKS_AHEAD = 3;

/** Number of chunks to keep in the scene behind the ball. */
const CHUNKS_BEHIND = 1;

/** Number of chunks to preload at game start. */
const PRELOAD_CHUNKS = 5;

/**
 * Cap on cached (built) chunks. Chunks are kept after leaving the scene so a
 * lap race re-mounts them for free — but a 100km point-to-point would otherwise
 * hold every metre of terrain, buildings and trees it ever drew. At 2km a chunk
 * this keeps ~40km resident, so any route short enough to actually be lapped
 * still stays whole in the cache; anything longer sheds its far end.
 */
const CHUNK_CACHE_MAX = 20;

/**
 * Byte ceiling on retained (cached) chunk meshes. Dense-urban chunks retain
 * 80–150 MB each, so a plain count of 20 could pin ~3 GB. The cache is trimmed
 * whenever EITHER this budget OR CHUNK_CACHE_MAX is exceeded — whichever binds
 * first — always keeping the live window (in-scene + building) whole.
 */
const CHUNK_CACHE_BYTE_BUDGET = 512 * 1024 * 1024; // 512 MB

/** At most this many chunk builds run concurrently. A dense route requesting a
 *  storm of chunks (preload + a fast-advancing rider) queues past this cap so
 *  transient build memory stays bounded (~2 × 150–250 MB instead of 10–20 ×). */
const MAX_CONCURRENT_BUILDS = 2;

/** Thrown by buildChunkMeshes when a chunk leaves the wanted window mid-build:
 *  partial meshes are disposed and the build aborts (see the abandon checks). */
class ChunkAbandoned extends Error {
  constructor() { super('chunk build abandoned'); this.name = 'ChunkAbandoned'; }
}

/** A queued/in-flight chunk build. First-time near-window builds outrank LOD
 *  upgrade rebuilds; preload targets are never dropped as stale. */
type BuildKind = 'build' | 'upgrade';
interface BuildRequest {
  chunkIndex: number;
  kind: BuildKind;
  /** Part of the initial preload batch — always built, never dropped as stale. */
  preloadTarget: boolean;
  /** Callers awaiting this exact chunk (preload gate, style-switch reload). */
  resolvers: Array<() => void>;
  rejecters: Array<(err: unknown) => void>;
}

/** Active entrance-animation state for a chunk (F1). */
interface ChunkEntrance {
  age: number;
  duration: number;
  mode: 'drop' | 'unfold';
}

/** All meshes produced for one chunk (terrain + MVT overlays). */
interface ChunkMeshes {
  terrain: TerrainChunkResult;
  road?: RoadRenderResult;
  waterway?: WaterwayRenderResult;
  aeroway?: AerowayRenderResult;
  building?: BuildingRenderResult;
  landuse?: LanduseRenderResult;
  /** Slimmed zone-detection features (tunnels/forest/urban polys + building
   *  centroids) — the ONLY subset of the decoded GeoJSON the chunk retains; the
   *  full tile GeoJSON is dropped after the build (the MVT tile cache still keeps
   *  its own copy until network eviction). */
  zoneFeatures?: ZoneFeatures;
  /** Instanced tree meshes for forest areas (Phase 3). */
  trees?: TreeRenderResult;
  /** Baseplate studs — one InstancedMesh per colour bucket. Only ever built for
   *  a full-resolution chunk: beyond the near window nothing but the terrain
   *  silhouette is drawn anyway (see update()), so a coarse chunk would build
   *  ~9 000 invisible instances and throw them away on upgrade. */
  studs?: GroundStudResult;
  /** Non-null while its entrance animation is running (F1). */
  entering?: ChunkEntrance | null;
  /** Far-chunk LOD level this chunk was built at: 0 = full resolution, 1 = coarse
   *  (double gridSize, ~¼ triangles). Always 0 when farChunkLod is off. */
  lodLevel: 0 | 1;
  /** Estimated retained bytes (mesh geometry + height grid + slim features),
   *  computed at build completion — drives the byte-aware cache budget. */
  retainedBytes?: number;
}

/** LOD levels: 0 = full resolution (near the rider), 1 = coarse (far ahead). */
type LodLevel = 0 | 1;

/** Chunk entrance timing/geometry (F1). */
const ENTRANCE_DURATION = 1.6;      // seconds
const ENTRANCE_DROP_HEIGHT = 160;   // metres a dropping chunk falls from

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);
const easeOutBounce = (x: number): number => {
  const n1 = 7.5625, d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) { x -= 1.5 / d1; return n1 * x * x + 0.75; }
  if (x < 2.5 / d1) { x -= 2.25 / d1; return n1 * x * x + 0.9375; }
  x -= 2.625 / d1; return n1 * x * x + 0.984375;
};

export interface ChunkManagerOptions {
  scene: THREE.Scene;
  points: RoutePoint[];
  sampler?: ElevationSampler;
  /** MVT fetcher for road/building/water overlay data. */
  mvtFetcher?: MVTFetcher;
  /** Corridor half-width in meters (passed to terrain chunks). */
  corridorHalfWidth?: number;
  /** Route distance (m) the ride starts at (welcome-screen start window).
   *  Preload and the initial chunk window centre here instead of chunk 0. */
  startDistanceM?: number;
  /** Active world-style strategy (materials + colours + geometry). */
  strategy: TerrainStyleStrategy;
  /** Called after a chunk finishes building and is added to the scene. */
  onChunkLoaded?: (chunkIndex: number) => void;
  /** Called when a background preload-target build settles with a real error, so
   *  a load bar can count it as accounted (loaded OR failed) and still reach 100%. */
  onChunkFailed?: (chunkIndex: number) => void;
  /** Far-chunk LOD: when true, chunks ≥2 ahead build coarse and upgrade to full
   *  as they enter the near window. Default false = today's behaviour exactly. */
  farChunkLod?: boolean;
  /**
   * Which shelf this ride's shop signs draw their words from.
   *
   * A property of the RIDE, not of the world and not of the chunk, so it lives
   * here — on the one object that outlives both. It deliberately does NOT ride
   * on `strategy.params` the way `paintEnabled` does: a world-style switch
   * mid-ride replaces the strategy with a fresh one carrying
   * `defaultStyleParams`, and a ride fact parked there would silently revert to
   * the default the first time the rider changed worlds.
   *
   * Fixed for the ride (see `SignVocabulary`), hence a construction option with
   * no setter: chunks already on screen are never rebuilt, so a value that could
   * change would only reach the chunks ahead.
   */
  signVocabulary?: SignVocabulary;
}

interface ChunkSlice {
  startIdx: number;
  endIdx: number;
  startDist: number;
  endDist: number;
}

export class TerrainChunkManager {
  private readonly scene: THREE.Scene;
  private readonly points: RoutePoint[];
  private readonly cumulativeDistances: number[];
  private readonly sampler: ElevationSampler;
  private readonly mvtFetcher: MVTFetcher | null;
  private readonly totalDistance: number;

  /** Route split into chunk slices. */
  private readonly slices: ChunkSlice[] = [];

  /** Mesh cache: chunkIndex → all meshes. Trimmed to CHUNK_CACHE_MAX around the
   *  rider; everything within that window survives leaving the scene. */
  private readonly cache = new Map<number, ChunkMeshes>();

  /** Trailing edge of each built chunk, kept OUTSIDE the mesh cache so evicting
   *  a chunk can't cost its neighbour the seam-stitching data (one vertex row —
   *  free to keep forever, unlike the meshes). */
  private readonly edges = new Map<number, ChunkEdgeData>();

  /** Chunks whose entrance animation (F1) has already played (NOT the in-flight
   *  set — that's `entering` below). Survives eviction, so a chunk rebuilt on
   *  lap 2 mounts instantly instead of dropping in again. */
  private readonly entrancePlayed = new Set<number>();

  /** Whether the route closes on itself (start ≈ finish) — decides if chunk
   *  distance wraps around the route end (lap races) or not (point-to-point). */
  private readonly isLoop: boolean;

  /** Chunks currently added to the scene. */
  private readonly inScene = new Set<number>();

  /** Build scheduler: every request (preload, update(), LOD upgrade) enqueues
   *  here and at most MAX_CONCURRENT_BUILDS run at once. `requests` keys every
   *  chunk currently queued OR in flight; `queue` holds the not-yet-started
   *  chunk indices (dequeued nearest-first). */
  private readonly requests = new Map<number, BuildRequest>();
  private readonly queue: number[] = [];
  private activeBuilds = 0;

  /** Monotonic build generation. clearChunks()/rebuild() bump it; each in-flight
   *  build/upgrade captures it at start and, after its last await, refuses to
   *  touch cache/scene/callbacks if the generation moved on under it (the chunks
   *  it built belong to a world that has since been torn down). */
  private buildGeneration = 0;

  /** Far-chunk LOD master switch (from the quality tier). Off → byte-identical
   *  to the pre-LOD behaviour (every chunk builds full). */
  private farChunkLod: boolean;

  /** Shop-sign shelf for this ride — see `ChunkManagerOptions.signVocabulary`. */
  private readonly signVocabulary: SignVocabulary;

  /** Floating origin (updated from game loop). */
  private readonly corridorHalfWidth?: number;
  private strategy: TerrainStyleStrategy;
  private readonly onChunkLoaded?: (chunkIndex: number) => void;
  private readonly onChunkFailed?: (chunkIndex: number) => void;

  /** Last distance passed to update() — used to reload after a rebuild. */
  private lastDistanceM = 0;

  /** Current chunk the last time the tile caches were trimmed — so evictOutside
   *  runs only when the rider crosses into a new chunk, not every frame. */
  private lastNetworkEvictChunk = -1;

  private originLat = 0;
  private originLon = 0;
  private originEle = 0;

  /** Index of the chunk the rider is currently in. */
  private _currentChunkIndex = 0;

  /** Chunk indices with an entrance animation in progress (F1). Iterated each
   *  frame by updateEntrances — kept as a small set so the per-frame cost is
   *  O(animating) not O(cache). */
  private readonly entering = new Set<number>();

  /** Reusable raycast scratch — avoids allocating per ground-height query
   *  (called for the rider + every coin, potentially many times per frame). */
  private readonly _raycaster = new THREE.Raycaster();
  private readonly _rayOrigin = new THREE.Vector3();
  private readonly _raycastMeshes: THREE.Mesh[] = [];
  private readonly _raycastHits: THREE.Intersection[] = [];
  /** Scratch for ordering in-scene chunks nearest-first per ground query. */
  private readonly _inSceneByRing: number[] = [];
  /** Dirty flag for `_inSceneByRing`: the sorted nearest-first order only changes
   *  when inScene membership changes (addChunkToScene/removeChunkFromScene) or the
   *  rider crosses into a new chunk (update → _currentChunkIndex). Cache the sort
   *  and rebuild it lazily so the ~7+ raycastGroundHeight calls per frame reuse one
   *  sort instead of rebuilding it each call. */
  private _ringOrderDirty = true;
  private static readonly RAY_DOWN = new THREE.Vector3(0, -1, 0);

  /** Overlay-ownership index (lazy): route points hashed into square cells so
   *  `ownerChunkOf` can find the nearest route point — and thus the ONE chunk
   *  allowed to build a given overlay feature — in O(cells scanned). Anchored
   *  to points[0], NOT the floating render origin, so ownership never shifts. */
  private _ownerGrid: Map<number, number[]> | null = null;
  private _ownerPointChunk: Int32Array | null = null;
  /** Pre-projected route-point coords (metres from points[0]) — ownerChunkOf
   *  runs hot inside overlay builds; recomputing the projection per candidate
   *  made dense-chunk builds crawl. */
  private _ownerPx: Float32Array | null = null;
  private _ownerPz: Float32Array | null = null;
  private _ownerCos = 1;
  private static readonly OWNER_CELL_M = 400;

  constructor(options: ChunkManagerOptions) {
    this.scene = options.scene;
    this.points = options.points;
    this.sampler = options.sampler ?? new ElevationSampler();
    this.mvtFetcher = options.mvtFetcher ?? null;
    this.corridorHalfWidth = options.corridorHalfWidth;
    this.strategy = options.strategy;
    this.onChunkLoaded = options.onChunkLoaded;
    this.onChunkFailed = options.onChunkFailed;
    this.farChunkLod = options.farChunkLod ?? false;
    this.signVocabulary = options.signVocabulary ?? 'shop';
    this.cumulativeDistances = buildCumulativeDistances(this.points);
    this.totalDistance =
      this.cumulativeDistances[this.cumulativeDistances.length - 1];

    // Loop detection: start and finish within 200m ≈ a closed lap course.
    const first = this.points[0];
    const last = this.points[this.points.length - 1];
    const dxM = (last.lon - first.lon) * 111320 * Math.cos((first.lat * Math.PI) / 180);
    const dzM = (last.lat - first.lat) * 111320;
    this.isLoop = Math.hypot(dxM, dzM) < 200;

    this.buildSlices();

    // Start window (welcome screen): the ride may begin mid-route. Seed the
    // rider's chunk so preload() and the first update() build around the real
    // start instead of chunk 0.
    const startDist = this.totalDistance > 0
      ? Math.max(0, options.startDistanceM ?? 0) % this.totalDistance
      : 0;
    this.lastDistanceM = startDist;
    this._currentChunkIndex = this.getChunkIndex(startDist);

    if (isDebugEnabled()) {
      debugLog('chunk', `Route: ${this.points.length} points, ${(this.totalDistance / 1000).toFixed(1)} km, ${this.slices.length} chunks`);
      for (let i = 0; i < this.slices.length; i++) {
        const s = this.slices[i];
        debugLog('chunk', `chunk[${i}]: points ${s.startIdx}-${s.endIdx}, dist ${s.startDist.toFixed(0)}-${s.endDist.toFixed(0)}m`);
      }
    }
  }

  /** Split route into ~2km chunks. */
  private buildSlices(): void {
    let startIdx = 0;
    let startDist = 0;

    while (startIdx < this.points.length - 1) {
      const targetEnd = startDist + CHUNK_LENGTH;
      let endIdx = startIdx;

      // Find end index for this chunk
      while (
        endIdx < this.points.length - 1 &&
        this.cumulativeDistances[endIdx] < targetEnd
      ) {
        endIdx++;
      }

      // Ensure at least 2 points per chunk
      if (endIdx === startIdx) endIdx = Math.min(startIdx + 1, this.points.length - 1);

      this.slices.push({
        startIdx,
        endIdx,
        startDist,
        endDist: this.cumulativeDistances[endIdx],
      });

      startDist = this.cumulativeDistances[endIdx];
      startIdx = endIdx;
    }
  }

  /** Set floating origin (call when ball position is first known). */
  setOrigin(lat: number, lon: number, ele: number): void {
    this.originLat = lat;
    this.originLon = lon;
    this.originEle = ele;
  }

  /** Get the chunk index for a given distance along the route. */
  getChunkIndex(distanceM: number): number {
    for (let i = 0; i < this.slices.length; i++) {
      if (distanceM <= this.slices[i].endDist) return i;
    }
    return this.slices.length - 1;
  }

  /** Total number of chunks in the route. */
  get chunkCount(): number {
    return this.slices.length;
  }

  /** Chunk indices preload() will build, nearest-first from the start chunk —
   *  forward along the route, wrapping on loop courses, clamped otherwise. */
  get preloadIndices(): number[] {
    const n = this.slices.length;
    const count = Math.min(PRELOAD_CHUNKS, n);
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const idx = this._currentChunkIndex + i;
      if (idx >= n) {
        if (!this.isLoop) break;
        out.push(idx % n);
      } else {
        out.push(idx);
      }
    }
    return out;
  }

  /** How many chunks preload() will build — the denominator for a load bar.
   *  Short routes have fewer chunks than PRELOAD_CHUNKS. */
  get preloadCount(): number {
    return this.preloadIndices.length;
  }

  /** Whether a chunk is part of the initial preload batch (load-bar counting). */
  isPreloadChunk(idx: number): boolean {
    return this.preloadIndices.includes(idx);
  }

  /**
   * Quality-tier hook: enable/disable far-chunk LOD at runtime. Affects only
   * chunks built/entered from here on — a mid-ride toggle never rebuilds the
   * chunks already resident (the near window rebuilds coarse ones to full as the
   * rider reaches them anyway). Turning it off just stops new coarse builds.
   */
  setLodEnabled(enabled: boolean): void {
    this.farChunkLod = enabled;
  }

  /** Ring distance from a chunk index to the rider's current chunk (short way
   *  round on a loop course, linear otherwise) — matches evictDistantChunks. */
  private lodDistance(idx: number): number {
    const n = this.slices.length;
    const d = Math.abs(idx - this._currentChunkIndex);
    return this.isLoop ? Math.min(d, n - d) : d;
  }

  /**
   * SIGNED ring offset — the demo's `i - idx`, negative behind the rider.
   *
   * `lodDistance` cannot stand in: the stud LOD keeps the chunk you have just
   * ridden through at the FINEST level (`studLevelFor`: `rel <= 0 ? 0`), so that
   * riding past a stud never coarsens it under your wheels. An absolute distance
   * would make chunk −1 look like chunk +1 and do exactly that.
   */
  private lodOffset(idx: number): number {
    const n = this.slices.length;
    let d = idx - this._currentChunkIndex;
    if (this.isLoop && n > 0) {
      d = ((d % n) + n) % n;
      if (d > n / 2) d -= n;
    }
    return d;
  }

  /**
   * LOD level a chunk should be built at, decided from its distance to the
   * rider's current chunk: the near window [current-1 … current+1] is full res,
   * everything ≥2 away is coarse. Always full when far-chunk LOD is off.
   */
  private targetLod(idx: number): LodLevel {
    if (!this.farChunkLod) return 0;
    return this.lodDistance(idx) >= 2 ? 1 : 0;
  }

  /**
   * Preload initial chunks at game start. All preloadCount chunks are enqueued
   * through the same 2-at-a-time scheduler; the returned promise resolves as
   * soon as the first TWO (current + next) are built — enough for a world to
   * look at — while the remaining chunks keep building in the background.
   */
  async preload(): Promise<void> {
    const indices = this.preloadIndices;
    if (indices.length === 0) return;
    const promises: Promise<void>[] = [];
    for (const idx of indices) {
      promises.push(this.enqueueBuild(idx, 'build', true));
    }
    // Gate on the nearest two only. The scheduler already dequeues nearest-first,
    // so those are the start chunk + the next one (current + next). Swallow the
    // rest's rejections — they run detached; a genuine failure there must not
    // surface as unhandled.
    const gate = Math.min(2, indices.length);
    // A background preload chunk that fails still notifies onChunkFailed so a load
    // bar counts it as accounted (loaded OR failed) and reaches 100%. Drops (stale
    // / abandoned) resolve, so only a real error lands here.
    for (let i = gate; i < indices.length; i++) {
      promises[i].catch(() => this.onChunkFailed?.(indices[i]));
    }
    await Promise.all(promises.slice(0, gate));
  }

  /**
   * Update which chunks are in the scene based on ball's current route distance.
   * Call this every frame or when ball moves significantly.
   */
  update(distanceM: number): void {
    this.lastDistanceM = distanceM;
    // Handle lap wrapping
    const wrappedDist = this.totalDistance > 0
      ? distanceM % this.totalDistance
      : distanceM;

    const currentChunk = this.getChunkIndex(wrappedDist);
    // The nearest-first ground-query order is ranked by distance from the current
    // chunk, so a change here invalidates the cached sort.
    if (currentChunk !== this._currentChunkIndex) this._ringOrderDirty = true;
    this._currentChunkIndex = currentChunk;

    // Determine which chunks should be in the scene
    const wanted = this.computeWanted(currentChunk);

    // Remove chunks that are no longer wanted from scene (but keep in cache)
    for (const idx of this.inScene) {
      if (!wanted.has(idx)) {
        const cached = this.cache.get(idx);
        if (cached) {
          this.removeChunkFromScene(cached);
        }
        this.inScene.delete(idx);
      }
    }

    // Add/load wanted chunks. A chunk built coarse (far-chunk LOD) that has now
    // reached the near window is upgraded to full res underneath — shown coarse
    // meanwhile so there's never a hole.
    for (const idx of wanted) {
      const needFull = this.targetLod(idx) === 0;

      if (this.inScene.has(idx)) {
        const shown = this.cache.get(idx);
        if (needFull && shown && shown.lodLevel === 1) this.upgradeChunk(idx);
        continue;
      }

      const cached = this.cache.get(idx);
      if (cached) {
        // Re-add from cache (zero cost for lap races).
        this.addChunkToScene(cached);
        this.inScene.add(idx);
        // A cached coarse chunk can't stand in for a full-res requirement.
        if (needFull && cached.lodLevel === 1) this.upgradeChunk(idx);
      } else {
        // Start async build (at the LOD its distance dictates).
        this.ensureChunk(idx);
      }
    }

    this.evictDistantChunks();

    // FAR chunks show TERRAIN ONLY. The corridor world has no ground mass
    // around a distant chunk, so every overlay there floats in mid-air seen
    // from here: switchback road ribbons, landuse slab edges, and mountainside
    // ROOF PLATES all render as webs of thin lines across the sky (each round
    // of the scene-inventory probe caught another category — roads, then
    // slabs, then building decorations). One rule ends the whack-a-mole:
    // beyond the near window (current ±1) nothing but the terrain silhouette
    // survives; everything pops back in as the rider approaches.
    for (const idx of this.inScene) {
      const chunk = this.cache.get(idx);
      if (!chunk) continue;
      const showOverlays = this.lodDistance(idx) <= 1;
      for (const m of this.chunkMeshList(chunk)) {
        if (m === chunk.terrain.mesh) continue;
        m.visible = showOverlays;
      }
      // 換級 = 把 InstancedMesh.geometry 指到另一份單位凸點,零 buffer 重傳,
      // 所以每次跨 chunk 邊界重掃一次是免費的。(demo: updateChunks → applyStudLod)
      if (chunk.studs) applyStudLod(chunk.studs, this.lodOffset(idx));
    }

    // Bound the DEM + MVT tile caches to the live window as the rider advances,
    // and abort tile fetches for chunks that have streamed off the back. Only on
    // a chunk crossing — the window doesn't move within one chunk.
    if (currentChunk !== this.lastNetworkEvictChunk) {
      this.lastNetworkEvictChunk = currentChunk;
      this.evictNetworkCaches(this.liveKeepSet());
    }
  }

  /** The chunks that should be in the scene around `current` (wraps on a loop). */
  private computeWanted(current: number): Set<number> {
    const n = this.slices.length;
    const wanted = new Set<number>();
    for (let i = current - CHUNKS_BEHIND; i <= current + CHUNKS_AHEAD; i++) {
      wanted.add(((i % n) + n) % n);
    }
    return wanted;
  }

  /** Tiles worth keeping right now: the wanted window PLUS every chunk queued or
   *  mid-build PLUS everything in the scene. Passing this to evictNetworkCaches
   *  guarantees a tile fetch for an about-to-appear (or preloading) chunk is
   *  never aborted out from under it. */
  private liveKeepSet(): Set<number> {
    const keep = this.computeWanted(this._currentChunkIndex);
    for (const idx of this.requests.keys()) keep.add(idx);
    for (const idx of this.inScene) keep.add(idx);
    return keep;
  }

  /**
   * Trim the DEM and MVT tile caches to the tiles the live window (the chunks
   * currently wanted around the rider) needs, plus a margin. Bounds cover the
   * whole wanted range — INCLUDING chunks still mid-build — so an in-flight
   * fetch for an about-to-appear chunk is never aborted out from under it.
   */
  private evictNetworkCaches(wanted: Set<number>): void {
    let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
    for (const idx of wanted) {
      const slice = this.slices[idx];
      if (!slice) continue;
      for (let i = slice.startIdx; i <= slice.endIdx; i++) {
        const p = this.points[i];
        if (p.lat < south) south = p.lat;
        if (p.lat > north) north = p.lat;
        if (p.lon < west) west = p.lon;
        if (p.lon > east) east = p.lon;
      }
    }
    if (!Number.isFinite(south)) return;
    // Pad ~2 km beyond the corridor (roads/trees fetch a padded bound), so a
    // feature just outside the route corridor keeps its tile.
    const PAD = 0.02;
    const bounds = {
      south: south - PAD, north: north + PAD,
      west: west - PAD, east: east + PAD,
    };
    this.mvtFetcher?.evictOutside(bounds);
    this.sampler.evictOutside(bounds);
  }

  /**
   * Trim the mesh cache, dropping the chunks furthest from the rider first.
   * The live window (in-scene, mid-build, or mid-upgrade) is untouchable; of the
   * rest we evict farthest-first until BOTH the byte budget and the count cap are
   * satisfied — whichever binds first drives it, so a handful of dense-urban
   * chunks (150 MB each) can no longer pin ~3 GB just by staying under 20 count.
   *
   * On a loop course distance is measured the short way round, so the chunks just
   * behind the start line count as near; on a point-to-point route it is NOT —
   * wrapping there would pin the never-again-visited start chunks in the cache
   * while recently-ridden terrain gets evicted.
   */
  private evictDistantChunks(): void {
    let totalBytes = 0;
    for (const chunk of this.cache.values()) totalBytes += chunk.retainedBytes ?? 0;

    if (this.cache.size <= CHUNK_CACHE_MAX && totalBytes <= CHUNK_CACHE_BYTE_BUDGET) return;

    const evictable: { idx: number; dist: number }[] = [];
    for (const idx of this.cache.keys()) {
      // Untouchable = in scene OR queued/in-flight (a build/upgrade is about to
      // write this slot). `requests` keys every queued + in-flight chunk.
      if (this.inScene.has(idx) || this.requests.has(idx)) continue;
      evictable.push({ idx, dist: this.lodDistance(idx) });
    }
    // Farthest first.
    evictable.sort((a, b) => b.dist - a.dist);

    for (const { idx } of evictable) {
      if (this.cache.size <= CHUNK_CACHE_MAX && totalBytes <= CHUNK_CACHE_BYTE_BUDGET) break;
      const chunk = this.cache.get(idx);
      if (!chunk) continue;
      const freed = chunk.retainedBytes ?? 0;
      this.disposeChunk(chunk);
      this.cache.delete(idx);
      totalBytes -= freed;
      debugLog('chunk', `Chunk ${idx} evicted`, {
        cache: `${this.cache.size}/${CHUNK_CACHE_MAX}`,
        freedMB: +(freed / (1024 * 1024)).toFixed(1),
        retainedMB: +(totalBytes / (1024 * 1024)).toFixed(1),
      });
    }
  }

  /** Remove a chunk from the scene and free every GPU resource it owns. */
  private disposeChunk(chunk: ChunkMeshes): void {
    this.removeChunkFromScene(chunk);

    chunk.terrain.mesh.geometry.dispose();
    // `userData.shared` = strategy-owned singleton, NOT this chunk's to free.
    // Circuit's per-level FR4 cut-edge materials are cached by the strategy (one
    // 128×64 canvas per stack height, the demo's `fr4Cache`), so freeing them
    // here would both rebuild them on the next chunk and leave the chunks that
    // still point at them drawing a disposed texture.
    const freeMat = (m: THREE.Material): void => { if (!m.userData?.shared) m.dispose(); };
    const mat = chunk.terrain.mesh.material;
    if (Array.isArray(mat)) mat.forEach(freeMat);
    else if (mat instanceof THREE.Material) freeMat(mat);

    if (chunk.road) disposeRoadMesh(chunk.road);
    if (chunk.waterway) disposeWaterwayMesh(chunk.waterway);
    if (chunk.aeroway) disposeAerowayMeshes(chunk.aeroway);
    if (chunk.building) disposeBuildingMesh(chunk.building);
    if (chunk.landuse) disposeLanduseMeshes(chunk.landuse);
    if (chunk.trees) disposeTreeMesh(chunk.trees);
    if (chunk.studs) disposeGroundStuds(chunk.studs);
  }

  /**
   * Reposition all cached meshes when the floating origin changes.
   * Call this when setOrigin is updated.
   */
  updateOrigin(newLat: number, newLon: number, newEle: number): void {
    const dLat = newLat - this.originLat;
    const dLon = newLon - this.originLon;
    const dEle = newEle - this.originEle;

    if (Math.abs(dLat) < 1e-8 && Math.abs(dLon) < 1e-8 && Math.abs(dEle) < 0.01) {
      return; // No significant change
    }

    const cosLat = Math.cos((newLat * Math.PI) / 180);
    const dx = -dLon * 111320 * cosLat;
    const dy = -dEle;
    const dz = dLat * 111320; // negate already handled in terrain-chunk

    for (const chunk of this.cache.values()) {
      chunk.terrain.mesh.position.x += dx;
      chunk.terrain.mesh.position.y += dy;
      chunk.terrain.mesh.position.z += dz;
      if (chunk.waterway) {
        chunk.waterway.mesh.position.x += dx;
        chunk.waterway.mesh.position.y += dy;
        chunk.waterway.mesh.position.z += dz;
      }
      if (chunk.aeroway) {
        for (const o of [chunk.aeroway.mesh, ...chunk.aeroway.planes]) {
          o.position.x += dx;
          o.position.y += dy;
          o.position.z += dz;
        }
      }
      if (chunk.road) {
        for (const m of chunk.road.meshes) {
          m.position.x += dx;
          m.position.y += dy;
          m.position.z += dz;
        }
        if (chunk.road.railMesh) {
          chunk.road.railMesh.position.x += dx;
          chunk.road.railMesh.position.y += dy;
          chunk.road.railMesh.position.z += dz;
        }
      }
      if (chunk.building) {
        chunk.building.mesh.position.x += dx;
        chunk.building.mesh.position.y += dy;
        chunk.building.mesh.position.z += dz;
      }
      if (chunk.landuse) {
        for (const m of landuseMeshes(chunk.landuse)) {
          m.position.x += dx;
          m.position.y += dy;
          m.position.z += dz;
        }
      }
      if (chunk.trees) {
        chunk.trees.mesh.position.x += dx;
        chunk.trees.mesh.position.y += dy;
        chunk.trees.mesh.position.z += dz;
      }
      if (chunk.studs) {
        for (const m of chunk.studs.meshes) {
          m.position.x += dx;
          m.position.y += dy;
          m.position.z += dz;
        }
      }
    }

    this.originLat = newLat;
    this.originLon = newLon;
    this.originEle = newEle;
  }

  /**
   * Fire-and-forget entry point from update(): request a first-time build of a
   * chunk (at the LOD its distance dictates). Enqueues through the scheduler —
   * at most MAX_CONCURRENT_BUILDS run at once. Rejections are swallowed here
   * (the caller drops the promise); genuine surfacing happens via preload().
   */
  private ensureChunk(chunkIndex: number): void {
    // update() calls this every frame for each wanted chunk; skip the wasted
    // promise churn once it's already cached or requested (queued/in-flight).
    if (this.cache.has(chunkIndex) || this.requests.has(chunkIndex)) return;
    this.enqueueBuild(chunkIndex, 'build', false).catch(() => {});
  }

  // ── Build scheduler ──

  /**
   * Enqueue a chunk build (or LOD upgrade) and return a promise that settles
   * when it finishes, is dropped as stale, or fails. Idempotent: a chunk already
   * queued/in-flight attaches a new waiter to the existing request instead of
   * duplicating it. Kicks the pump so a free slot starts work immediately.
   */
  private enqueueBuild(chunkIndex: number, kind: BuildKind, preloadTarget: boolean): Promise<void> {
    if (chunkIndex < 0 || chunkIndex >= this.slices.length) return Promise.resolve();
    if (kind === 'build' && this.cache.has(chunkIndex)) return Promise.resolve();
    if (kind === 'upgrade') {
      const cached = this.cache.get(chunkIndex);
      // Only a cached coarse chunk that still needs full res is worth upgrading.
      if (!cached || cached.lodLevel === 0) return Promise.resolve();
    }

    const existing = this.requests.get(chunkIndex);
    if (existing) {
      if (preloadTarget) existing.preloadTarget = true;
      return new Promise<void>((res, rej) => {
        existing.resolvers.push(res);
        existing.rejecters.push(rej);
      });
    }

    const req: BuildRequest = { chunkIndex, kind, preloadTarget, resolvers: [], rejecters: [] };
    const p = new Promise<void>((res, rej) => { req.resolvers.push(res); req.rejecters.push(rej); });
    this.requests.set(chunkIndex, req);
    this.queue.push(chunkIndex);
    this.pump();
    return p;
  }

  /** Start queued builds until the concurrency cap is hit or the queue drains.
   *  Stale requests are dropped (resolved) at dequeue time. */
  private pump(): void {
    while (this.activeBuilds < MAX_CONCURRENT_BUILDS && this.queue.length > 0) {
      const idx = this.takeNextQueued();
      if (idx === undefined) break;
      const req = this.requests.get(idx);
      if (!req) continue;
      if (this.isStaleRequest(req)) { this.settleRequest(req, null); continue; }

      this.activeBuilds++;
      void this.runRequest(req);
    }
  }

  /** Pop the highest-priority queued chunk: first-time builds before LOD
   *  upgrades, then nearest ring-distance, then ahead-of-rider before behind. */
  private takeNextQueued(): number | undefined {
    if (this.queue.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) {
      if (this.comparePriority(this.queue[i], this.queue[best]) < 0) best = i;
    }
    const idx = this.queue[best];
    this.queue.splice(best, 1);
    return idx;
  }

  /** <0 if chunk `a` should build before chunk `b`. */
  private comparePriority(a: number, b: number): number {
    const ka = this.requests.get(a)?.kind === 'upgrade' ? 1 : 0;
    const kb = this.requests.get(b)?.kind === 'upgrade' ? 1 : 0;
    if (ka !== kb) return ka - kb;                    // first-time builds first
    const da = this.lodDistance(a), db = this.lodDistance(b);
    if (da !== db) return da - db;                    // nearest first
    return (this.isAhead(a) ? 0 : 1) - (this.isAhead(b) ? 0 : 1); // ahead on ties
  }

  /** Is chunk `idx` ahead of the rider (short way round on a loop)? */
  private isAhead(idx: number): boolean {
    const n = this.slices.length;
    const fwd = (((idx - this._currentChunkIndex) % n) + n) % n;
    return fwd <= n - fwd;
  }

  /** A request is stale (drop it at dequeue) when the chunk no longer needs to
   *  build — unless it is a preload target, which always builds. */
  private isStaleRequest(req: BuildRequest): boolean {
    if (req.preloadTarget) return false;
    const idx = req.chunkIndex;
    if (req.kind === 'build') {
      if (this.cache.has(idx)) return true;                 // already built
      return !this.computeWanted(this._currentChunkIndex).has(idx);
    }
    // upgrade: gone from cache, already full, or no longer needs full res.
    const cached = this.cache.get(idx);
    if (!cached || cached.lodLevel === 0) return true;
    return this.targetLod(idx) !== 0;
  }

  /** Run one dequeued request, then clean scheduler state and pump the next.
   *  A mid-build abandon (ChunkAbandoned) settles as a drop, not a failure, so a
   *  later update() can re-enqueue a fresh build for the same chunk. */
  private async runRequest(req: BuildRequest): Promise<void> {
    const idx = req.chunkIndex;
    try {
      if (req.kind === 'upgrade') await this.doUpgrade(idx);
      else await this.doBuild(req);
      this.settleRequest(req, null);
    } catch (err) {
      this.settleRequest(req, err instanceof ChunkAbandoned ? null : err);
    } finally {
      this.activeBuilds--;
      // Bound the tile caches after a build — but only once per chunk crossing
      // (same gate update() uses), so a 5-build preload burst runs it once, not
      // five times. Trimming the mesh cache to the byte budget is unconditional
      // so a dense preload/stream can't outrun eviction between game-loop ticks.
      if (this._currentChunkIndex !== this.lastNetworkEvictChunk) {
        this.lastNetworkEvictChunk = this._currentChunkIndex;
        this.evictNetworkCaches(this.liveKeepSet());
      }
      this.evictDistantChunks();
      this.pump();
    }
  }

  /** Resolve (err === null) or reject every waiter on a request, then forget it.
   *  Only clears the map slot if it still points at THIS request — a rebuild()
   *  can clear `requests` mid-flight and a fresh request take the same slot; we
   *  must not delete that newer one out from under it. */
  private settleRequest(req: BuildRequest, err: unknown | null): void {
    if (this.requests.get(req.chunkIndex) === req) this.requests.delete(req.chunkIndex);
    if (err === null) for (const r of req.resolvers) r();
    else for (const j of req.rejecters) j(err);
  }

  /** First-time build: build meshes (abandon-checked), estimate their retained
   *  bytes, cache, and mount. Called only from the scheduler. */
  private async doBuild(req: BuildRequest): Promise<void> {
    const idx = req.chunkIndex;
    const gen = this.buildGeneration;
    const abandon = () =>
      !req.preloadTarget && !this.computeWanted(this._currentChunkIndex).has(idx);
    const chunkMeshes = await this.buildChunkMeshes(idx, this.targetLod(idx), abandon);
    // A clearChunks()/rebuild() ran while we built — this chunk belongs to a torn
    // down world. Dispose it and drop (abandonBuild throws ChunkAbandoned, settled
    // as a drop) without touching cache/scene/callbacks.
    if (gen !== this.buildGeneration) this.abandonBuild(chunkMeshes);
    chunkMeshes.retainedBytes = this.estimateChunkBytes(chunkMeshes);

    this.cache.set(idx, chunkMeshes);
    this.addChunkToScene(chunkMeshes);
    this.inScene.add(idx);
    this.onChunkLoaded?.(idx);
  }

  /**
   * Estimate the bytes a built chunk retains: every BufferGeometry
   * attribute/index (recursing into building decorations + instanced meshes),
   * plus the height grid's Float32Arrays and the slimmed zone features.
   */
  private estimateChunkBytes(chunk: ChunkMeshes): number {
    let bytes = 0;
    const addGeom = (g: THREE.BufferGeometry | undefined | null): void => {
      if (!g) return;
      for (const name in g.attributes) {
        const arr = (g.attributes[name] as THREE.BufferAttribute)?.array as
          | ArrayBufferView
          | undefined;
        if (arr) bytes += arr.byteLength;
      }
      const idxArr = g.index?.array as ArrayBufferView | undefined;
      if (idxArr) bytes += idxArr.byteLength;
    };
    for (const root of this.chunkMeshList(chunk)) {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if ((m as { isMesh?: boolean }).isMesh) addGeom(m.geometry as THREE.BufferGeometry);
        const inst = o as THREE.InstancedMesh;
        if ((inst as { isInstancedMesh?: boolean }).isInstancedMesh) {
          const im = inst.instanceMatrix?.array as ArrayBufferView | undefined;
          if (im) bytes += im.byteLength;
          const ic = inst.instanceColor?.array as ArrayBufferView | undefined;
          if (ic) bytes += ic.byteLength;
        }
      });
    }
    const g = chunk.terrain.heightGrid;
    bytes += g.centerX.byteLength + g.centerZ.byteLength +
             g.rightX.byteLength + g.rightZ.byteLength + g.heights.byteLength;
    if (chunk.zoneFeatures) bytes += estimateZoneFeatureBytes(chunk.zoneFeatures);
    return bytes;
  }

  /**
   * Build every mesh for one chunk at the given LOD (0 = full, 1 = coarse) and
   * return them — WITHOUT touching the cache, scene, or `building`/`upgrading`
   * bookkeeping (the caller owns that). Coarse builds double the terrain grid
   * spacing (~¼ the triangles); MVT overlays are unchanged. Also refreshes this
   * chunk's stitching edge.
   *
   * `isAbandoned` is polled between the major build stages (terrain → overlays →
   * trees); when it returns true the partial meshes built so far are disposed and
   * ChunkAbandoned is thrown, so a chunk the rider has already left never pays for
   * its remaining stages.
   */
  private async buildChunkMeshes(
    chunkIndex: number,
    lod: LodLevel,
    isAbandoned: () => boolean,
  ): Promise<ChunkMeshes> {
    const slice = this.slices[chunkIndex];
    // Get previous chunk's last edge for seamless stitching
    const prevEdge: ChunkEdgeData | undefined = this.edges.get(chunkIndex - 1);

    const buildInput: ChunkBuildInput = {
      points: this.points,
      cumulativeDistances: this.cumulativeDistances,
      startIdx: slice.startIdx,
      endIdx: slice.endIdx,
      chunkIndex,
      prevEdge,
      corridorHalfWidth: this.corridorHalfWidth,
      // Coarse far-chunk LOD builds at double grid spacing.
      gridSizeScale: lod === 1 ? 2 : 1,
    };

    // Perf probe (debug only): split the chunk build into decode vs mesh-build
    // so we can see whether load time is network+decode (movable to a worker /
    // cacheable) or geometry construction (needs instancing / analytic ground).
    const _perf = { terrainMs: 0, mvtDecodeMs: 0, demMs: 0, overlayBuildMs: 0, buildingMs: 0, treeMs: 0, studMs: 0 };
    const _t0 = performance.now();

    // ── MVT + DEM FIRST: the terrain build must see the building footprints
    // (bare-earth flattening) before it samples the DEM, or downtown chunks
    // grow the phantom terrain towers baked into the surface-model raster. ──
    let mvtFeatures: Awaited<ReturnType<MVTFetcher['getFeaturesForBounds']>> | null = null;
    let bounds: { south: number; north: number; west: number; east: number } | null = null;
    if (this.mvtFetcher) {
      // Compute geographic bounds for this chunk's corridor
      const segPoints = this.points.slice(slice.startIdx, slice.endIdx + 1);
      const coords = segPoints.map((p) => ({ lat: p.lat, lon: p.lon }));
      bounds = computeGeoBounds(coords);
      // Expand bounds slightly to capture features at edges
      const PAD = 0.005; // ~500m
      bounds.south -= PAD;
      bounds.north += PAD;
      bounds.west -= PAD;
      bounds.east += PAD;

      try {
        const _tMvt = performance.now();
        mvtFeatures = await this.mvtFetcher.getFeaturesForBounds(bounds);
        _perf.mvtDecodeMs = performance.now() - _tMvt;   // MVT fetch + pbf decode + toGeoJSON

        const _tDem = performance.now();
        await this.sampler.prefetchBounds(bounds);
        _perf.demMs = performance.now() - _tDem;

        // Every footprint in the padded bounds (NO ownership filter — terrain
        // must flatten identically across chunk seams).
        this.registerBuildingFloors(extractBuildingsFromMVT(mvtFeatures, bounds));
        // Urban zones: clamp the surface-model plateau down to route level.
        this.registerUrbanZones(mvtFeatures);
      } catch (err) {
        console.warn(`[ChunkManager] MVT prefetch failed for chunk ${chunkIndex}:`, err);
        mvtFeatures = null;
      }
    }

    // Abandon check #0 — nothing built yet, cheapest possible exit.
    if (isAbandoned()) throw new ChunkAbandoned();

    const _tTerrain = performance.now();
    const terrainResult = await buildTerrainChunk(
      buildInput,
      this.sampler,
      this.originLat,
      this.originLon,
      this.originEle,
      this.strategy,
    );
    _perf.terrainMs = performance.now() - _tTerrain;

    const chunkMeshes: ChunkMeshes = { terrain: terrainResult, lodLevel: lod };
    if (terrainResult.lastEdge) this.edges.set(chunkIndex, terrainResult.lastEdge);

    // Abandon check #1 — terrain done; bail before spending anything on overlays
    // if the rider has already left this chunk's window.
    if (isAbandoned()) this.abandonBuild(chunkMeshes);

    // Build MVT overlay meshes (roads, buildings, water/parks) in parallel
    if (mvtFeatures && bounds) {
        try {
          // Ribbon overlays lie ON this chunk's terrain — see makeGroundFn.
          const ground = this.makeGroundFn(terrainResult.heightGrid);
          // Exactly one chunk owns each overlay feature in the padded overlap
          // band — see the ownership section above.
          const owns = this.makeOwnsFn(chunkIndex);

          // Abandon check #2 — features decoded + DEM warm, but the overlay mesh
          // build (the expensive stage) hasn't started. Last cheap exit point.
          if (isAbandoned()) this.abandonBuild(chunkMeshes);

          const _tBuild = performance.now();
          const [roadResult, waterwayResult, aerowayResult, buildingResult, landuseResult] = await Promise.all([
            buildRoadMeshes(mvtFeatures, this.sampler, this.originLat, this.originLon, this.originEle, this.strategy, ground, owns),
            buildWaterwayMeshes(mvtFeatures, this.sampler, this.originLat, this.originLon, this.originEle, this.strategy, ground, owns),
            buildAerowayMeshes(mvtFeatures, this.sampler, this.originLat, this.originLon, this.originEle, this.strategy, ground, owns),
            // Buildings are timed SEPARATELY inside the Promise.all. They are
            // the overwhelming majority of `overlayBuildMs` on a dense chunk
            // (measured on the Dazhi route: 794 footprints ≈ 190 ms of a ~210 ms
            // overlay build), and a single lumped number cannot tell "the city
            // is expensive" from "the roads are expensive" — which is the whole
            // question when a chunk streams in mid-ride and drops frames.
            (async () => {
              const t = performance.now();
              try {
                return await this.buildChunkBuildings(mvtFeatures, bounds, ground, owns);
              } finally {
                _perf.buildingMs = performance.now() - t;
              }
            })(),
            // The two hooks are for the lamp a pitch / playground stands on its
            // own edge: `ground` is the demos' `geoGroundY` (the lamp is on the
            // patch EDGE, which on a real polygon can be a hundred metres from
            // the slab's centroid) and `routePointNear` is their `luRouteAt` +
            // `pathAt` — it decides WHICH edge, namely the one facing the road.
            buildLanduseMeshes(
              mvtFeatures, this.sampler, this.originLat, this.originLon, this.originEle,
              this.strategy, owns,
              { ground, routePointNear: (x, z) => this.routePointNear(x, z) },
            ),
          ]);
          _perf.overlayBuildMs = performance.now() - _tBuild;   // C: mesh geometry + raycast ground-fit

          // Retain ONLY the slim zone-detection subset (tunnels/forest/urban
          // polys + building centroids) — never the full decoded GeoJSON, which
          // pinned 80–150 MB per dense chunk in the cache. The MVT tile cache
          // still holds the raw tiles until network eviction; that's bounded.
          chunkMeshes.zoneFeatures = extractZoneFeatures(mvtFeatures);

          if (roadResult.roadCount > 0) chunkMeshes.road = roadResult;
          if (waterwayResult.waterwayCount > 0) chunkMeshes.waterway = waterwayResult;
          if (aerowayResult.featureCount > 0) chunkMeshes.aeroway = aerowayResult;
          if (buildingResult.buildingCount > 0) chunkMeshes.building = buildingResult;
          if (landuseResult.layers.some((l) => l.count > 0)) {
            chunkMeshes.landuse = landuseResult;
          }

          // Abandon check #3 — overlays are up; skip the tree instancing pass if
          // the rider has since left. (Overlays already built are disposed.)
          if (isAbandoned()) this.abandonBuild(chunkMeshes);

          // Build trees in forest areas
          const forestFeatures = mvtFeatures.filter(
            (f) => f.layer === 'landcover' && (f.properties.class === 'wood' || f.properties.class === 'forest'),
          );
          if (forestFeatures.length > 0) {
            try {
              const _tTree = performance.now();
              const treeResult = await buildTreeMeshes(
                forestFeatures, this.sampler,
                this.originLat, this.originLon, this.originEle, this.strategy,
                owns,
              );
              _perf.treeMs = performance.now() - _tTree;
              if (treeResult.treeCount > 0) {
                chunkMeshes.trees = treeResult;
              }
            } catch (treeErr) {
              console.warn(`[ChunkManager] Tree build failed for chunk ${chunkIndex}:`, treeErr);
            }
          }
        } catch (err) {
          // A mid-build abandon is not an overlay failure — let it propagate so
          // the scheduler drops (not fails) the request.
          if (err instanceof ChunkAbandoned) throw err;
          console.warn(`[ChunkManager] MVT overlay failed for chunk ${chunkIndex}:`, err);
        }
    }

    // ── Baseplate studs ──
    //
    // LAST, and outside the MVT block: a stud must not stand on anything already
    // lying flat here, so it has to see the finished ground pass — and a route
    // with no vector tiles still gets a studded baseplate, just an unzoned one.
    //
    // Only at full resolution. Beyond the near window a chunk shows its terrain
    // silhouette and nothing else (see update()), so a coarse chunk would build
    // ~9 000 invisible instances and throw them away the moment it upgraded.
    if (lod === 0) {
      const _tStud = performance.now();
      chunkMeshes.studs = buildGroundStuds(this.strategy, {
        grid: terrainResult.heightGrid,
        originLat: this.originLat,
        originLon: this.originLon,
        originEle: this.originEle,
        // The same ZoneIndex the buildings use, so a stud and the building
        // beside it can never disagree about which district they are in.
        zoneAt: (lon, lat) => this.zoneAt(lon, lat),
        blockers: [
          ...(chunkMeshes.road?.meshes ?? []), chunkMeshes.road?.railMesh,
          chunkMeshes.waterway?.mesh, chunkMeshes.aeroway?.mesh,
          ...(chunkMeshes.landuse?.layers ?? [])
            .filter((l) => STUD_BLOCKING_LANDUSE.has(l.kind))
            .map((l) => l.mesh),
        ],
        parkMeshes: (chunkMeshes.landuse?.layers ?? [])
          .filter((l) => l.kind === 'park')
          .map((l) => l.mesh),
      }) ?? undefined;
      _perf.studMs = performance.now() - _tStud;
    }

    if (isDebugEnabled()) {
      const terrVerts = chunkMeshes.terrain.mesh.geometry.getAttribute('position')?.count ?? 0;
      const roadCount = chunkMeshes.road?.roadCount ?? 0;
      const buildingCount = chunkMeshes.building?.buildingCount ?? 0;
      const landuseCounts: Record<string, number> = {};
      for (const l of chunkMeshes.landuse?.layers ?? []) {
        if (l.count > 0) landuseCounts[l.kind] = l.count;
      }
      debugLog('chunk', `Chunk ${chunkIndex} built (lod ${lod})`, {
        terrainVerts: terrVerts, roads: roadCount, buildings: buildingCount,
        waterways: chunkMeshes.waterway?.waterwayCount ?? 0,
        ...landuseCounts, trees: chunkMeshes.trees?.treeCount ?? 0,
        studs: chunkMeshes.studs?.studCount ?? 0,
      });
      // Timing breakdown: mvtDecode+dem = network+decode (worker-movable);
      // overlayBuild+tree (+ part of terrain) = main-thread geometry (C).
      debugLog('chunk', `Chunk ${chunkIndex} timing`, {
        terrainMs: +_perf.terrainMs.toFixed(1),
        mvtDecodeMs: +_perf.mvtDecodeMs.toFixed(1),
        demMs: +_perf.demMs.toFixed(1),
        overlayBuildMs: +_perf.overlayBuildMs.toFixed(1),
        buildingMs: +_perf.buildingMs.toFixed(1),
        treeMs: +_perf.treeMs.toFixed(1),
        studMs: +_perf.studMs.toFixed(1),
        totalMs: +(performance.now() - _t0).toFixed(1),
      });
    }

    return chunkMeshes;
  }

  /**
   * Far-chunk-LOD upgrade edge: a coarse chunk has reached the near window, so
   * rebuild it at full resolution and swap it in place. The coarse version stays
   * visible until the full build lands (never a hole), and the entrance drop-in
   * is NOT replayed on the swap. Guarded so a chunk with an upgrade already in
   * flight never starts a second one.
   */
  private upgradeChunk(chunkIndex: number): void {
    // Skip the wasted promise if an upgrade is already queued/in-flight (update()
    // re-checks the coarse chunk every frame until the full build lands).
    if (this.requests.has(chunkIndex)) return;
    this.enqueueBuild(chunkIndex, 'upgrade', false).catch(() => {});
  }

  /** The actual LOD upgrade, run from the scheduler (lower priority than
   *  first-time builds). Abandon-checked on the target LOD so a coarse chunk that
   *  drifts back out of the near window mid-rebuild leaves the coarse one alone. */
  private async doUpgrade(chunkIndex: number): Promise<void> {
    const gen = this.buildGeneration;
    let full: ChunkMeshes;
    try {
      full = await this.buildChunkMeshes(chunkIndex, 0, () => this.targetLod(chunkIndex) !== 0);
    } catch (err) {
      if (err instanceof ChunkAbandoned) return; // coarse version stays in place
      throw err;
    }

    // A clearChunks()/rebuild() ran while we rebuilt — the world this upgrade
    // targeted is gone. Throw the fresh build away without touching cache/scene.
    if (gen !== this.buildGeneration) {
      this.disposeChunk(full);
      return;
    }

    // The rider may have moved on while we rebuilt. If full res is no longer
    // required, throw the fresh build away and leave the coarse one in place.
    if (this.targetLod(chunkIndex) !== 0) {
      this.disposeChunk(full);
      return;
    }

    full.retainedBytes = this.estimateChunkBytes(full);
    const old = this.cache.get(chunkIndex);
    const wasInScene = this.inScene.has(chunkIndex);
    if (old) this.disposeChunk(old); // also removes it from the scene

    // No entrance replay on a LOD swap — mark it played before it mounts.
    this.entrancePlayed.add(chunkIndex);
    this.cache.set(chunkIndex, full);
    if (wasInScene) {
      this.addChunkToScene(full);
      this.inScene.add(chunkIndex);
    }
    // Route line etc. re-project onto the now-exact full-res surface.
    this.onChunkLoaded?.(chunkIndex);
  }

  /** Dispose a chunk's partial meshes and abort the rest of its build. Called
   *  from the abandon checks in buildChunkMeshes. */
  private abandonBuild(partial: ChunkMeshes): never {
    this.disposeChunk(partial);
    throw new ChunkAbandoned();
  }

  /** Build building meshes from MVT features for a chunk. */
  private async buildChunkBuildings(
    mvtFeatures: import('./mvt-fetcher').MVTFeature[],
    bounds: { south: number; north: number; west: number; east: number },
    ground: (x: number, z: number) => number | null = () => 0,
    owns: (lon: number, lat: number) => boolean = () => true,
  ): Promise<BuildingRenderResult> {
    // Keep a footprint only when this chunk owns it AND terrain exists under
    // it — a footprint past every corridor would extrude floating over void.
    const cosLat = Math.cos((this.originLat * Math.PI) / 180);
    const keep = (lon: number, lat: number): boolean => {
      if (!owns(lon, lat)) return false;
      const x = (lon - this.originLon) * 111320 * cosLat;
      const z = -(lat - this.originLat) * 111320;
      return ground(x, z) !== null;
    };
    const footprints = extractBuildingsFromMVT(mvtFeatures, bounds, keep);
    return buildBuildingMeshes(
      footprints,
      this.sampler,
      this.originLat,
      this.originLon,
      this.originEle,
      this.strategy,
      ground,
      (x, z) => this.routeDistanceAt(x, z),
      (lon, lat) => this.zoneAt(lon, lat),
      this.signVocabulary,
    );
  }

  /**
   * Raycast downward at (x, z) in scene coordinates to find the terrain
   * surface height. Returns the y-coordinate of the hit point, or null if
   * no terrain mesh is hit (e.g. chunks not yet loaded).
   */
  /**
   * Ground probe for the overlays of ONE chunk being built.
   *
   * Roads/waterways/runways used to derive their own height from the DEM and
   * quantise it themselves, which put them a whole layer out from the terrain's
   * (cell-averaged) steps — they sank into the ground. Now they lie on the real
   * surface, like the lamps and coins already did.
   *
   * The chunk is not in the scene yet (it is added after all its overlays are
   * built), so `raycastGroundHeight` cannot see it. Instead we read this chunk's
   * own height grid directly, falling back to `raycastGroundHeight` for anything
   * reaching into an already-loaded neighbour (the MVT bounds are padded ~500 m
   * beyond the chunk), and finally to null → the caller's old quantised formula.
   */
  private makeGroundFn(grid: ChunkHeightGrid): (x: number, z: number) => number | null {
    /** How far under the topmost surface a drape may sit before it counts as
     *  buried. One quantised step is 6 m (plastic) / 12 m (paper) and the
     *  per-cell jitter is up to 1.5 m, so this only has to clear the jitter. */
    const BURIED_MARGIN_M = 2;
    const cosLat = Math.cos((this.originLat * Math.PI) / 180);
    return (x: number, z: number, preferY?: number): number | null => {
      // OWN grid ONLY. Draping onto neighbour grids let a chunk's roads run
      // past its own visible terrain — mountain-descent ribbons "grew out of"
      // the green corridor and hung mid-air across the gap to the next one.
      // A road may only exist ON the terrain of the chunk that draws it; the
      // portion outside is dropped (whichever chunk owns that stretch draws it
      // on ITS ground). Null = the ribbon splits there, by design.
      //
      // Layer disambiguation: where a climb's corridor passes back over the
      // valley, ONE (x, z) is covered by TWO corridor passes at very different
      // heights — first-match sent valley roads rocketing up 150m spikes onto
      // the upper deck (the giant black arches). The raw DEM elevation is the
      // single-valued truth for where the GROUND is; prefer the grid layer
      // closest to it.
      const lon = this.originLon + x / (111320 * cosLat);
      const lat = this.originLat - z / 111320;
      const dem = this.sampler.getElevationSync(lat, lon);
      if (dem === null) {
        // No DEM tile here (a hole, or a probe just past the prefetched bounds)
        // so the "true ground" cross-check below is unavailable. Without one,
        // an unvalidated first-match layer is exactly how ribbons used to get
        // hoisted onto the elevated pass — fall back to the caller's own
        // continuity instead: stay on the deck the ribbon is already on.
        const h = sampleChunkHeight(grid, x, z, this.originEle, preferY);
        if (h === null || preferY === undefined) return h;
        return Math.abs(h - preferY) > 12 ? null : h;
      }
      const demRel = dem - this.originEle;
      // ALWAYS anchor the layer choice on the DEM, never on the caller's
      // running height.
      //
      // Threading the previous sample's height in here was meant to stop a
      // ribbon flipping decks mid-run, and it did — but where a switchback
      // stacks two corridor passes over one (x, z), it pinned the road to the
      // LOWER deck while the terrain draws both and you only ever see the
      // upper one. Measured on Dazhi chunks 2-4: 13% of road vertices ended up
      // off the rendered surface, the worst of them 180 m INSIDE the mountain,
      // surfacing as slivers through every quantised step. The DEM is
      // single-valued and is what the terrain itself was built from, so it is
      // the only anchor that agrees with what is on screen.
      //
      // The deck-flip protection now comes entirely from the sanity trim below
      // plus MAX_RIBBON_JUMP_M: an ambiguous stretch is DROPPED rather than
      // guessed at. A missing few metres of road beats a road inside a hill.
      const h = sampleChunkHeight(grid, x, z, this.originEle, demRel);
      if (h === null) return null;

      // BURIED CHECK. Where a climb's corridor passes back over the valley, one
      // (x, z) carries two terrain surfaces and the terrain mesh draws both —
      // so the only surface you can actually see is the TOP one. A ribbon
      // draped on the lower deck is inside the hill, and because the terrain is
      // a staircase it does not stay hidden: it surfaces as a sliver through
      // every step riser it crosses. That is the "black lines coming out of the
      // mountain", and it accounted for 2452 of 9808 road vertices on the Dazhi
      // chunks (25%) against just 111 floating above the ground.
      //
      // Drop the sample instead of guessing. The ribbon splits, the road has a
      // gap, and a gap is the right answer here — this is a toy diorama, not a
      // street atlas, and a missing few metres of road beats a road growing out
      // of a hillside.
      const top = maxChunkHeight(grid, x, z, this.originEle);
      if (top !== null && top - h > BURIED_MARGIN_M) return null;
      // Sanity: if even the closest layer is far from the TRUE ground, only an
      // elevated pass of the corridor covers this point — there is no real
      // ground here for an overlay to lie on. Trim instead of hoisting it.
      return Math.abs(h - demRel) > 12 ? null : h;
    };
  }

  // ── Overlay ownership ──
  //
  // Each chunk's MVT bounds are padded ~500 m past its corridor, so adjacent
  // corridors overlap and every feature in the band used to be built TWICE —
  // at two different heights (each copy draped on its own chunk's grid), which
  // put one copy underground and z-fought the rest. Ownership rule: a feature
  // belongs to the chunk whose route segment is nearest to it. Deterministic
  // (pure geometry, no load-order dependence), so every chunk computes the
  // same answer and each feature is built exactly once.

  private ensureOwnerIndex(): Map<number, number[]> {
    if (this._ownerGrid) return this._ownerGrid;
    const ref = this.points[0];
    this._ownerCos = Math.cos((ref.lat * Math.PI) / 180);
    const grid = new Map<number, number[]>();
    const cell = TerrainChunkManager.OWNER_CELL_M;
    const px = new Float32Array(this.points.length);
    const pz = new Float32Array(this.points.length);
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      const x = (p.lon - ref.lon) * 111320 * this._ownerCos;
      const z = (p.lat - ref.lat) * 111320;
      px[i] = x;
      pz[i] = z;
      const key = (Math.floor(x / cell) + 32768) * 65536 + (Math.floor(z / cell) + 32768);
      let arr = grid.get(key);
      if (!arr) { arr = []; grid.set(key, arr); }
      arr.push(i);
    }
    this._ownerPx = px;
    this._ownerPz = pz;
    const pointChunk = new Int32Array(this.points.length);
    for (let c = 0; c < this.slices.length; c++) {
      const s = this.slices[c];
      pointChunk.fill(c, s.startIdx, s.endIdx + 1);
    }
    this._ownerGrid = grid;
    this._ownerPointChunk = pointChunk;
    return grid;
  }

  /** Chunk index owning geographic (lon, lat), or -1 when the location is too
   *  far (> ~3 cells) from the route to belong to anyone. */
  private ownerChunkOf(lon: number, lat: number): number {
    const idx = this.nearestRoutePoint(lon, lat);
    return idx >= 0 ? this._ownerPointChunk![idx] : -1;
  }

  /** Nearest route-point index to geographic (lon, lat), or -1 when too far. */
  private nearestRoutePoint(lon: number, lat: number): number {
    const grid = this.ensureOwnerIndex();
    const ref = this.points[0];
    const x = (lon - ref.lon) * 111320 * this._ownerCos;
    const z = (lat - ref.lat) * 111320;
    const cell = TerrainChunkManager.OWNER_CELL_M;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);

    let bestIdx = -1;
    let bestD2 = Infinity;
    // Scan growing rings; once a ring finds candidates, scan ONE more ring
    // (a slightly nearer point can sit just across a cell boundary) and stop.
    let foundAtRing = -1;
    for (let r = 0; r <= 3; r++) {
      if (foundAtRing >= 0 && r > foundAtRing + 1) break;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring shell only
          const arr = grid.get((cx + dx + 32768) * 65536 + (cz + dz + 32768));
          if (!arr) continue;
          if (foundAtRing < 0) foundAtRing = r;
          const pxArr = this._ownerPx!;
          const pzArr = this._ownerPz!;
          for (const i of arr) {
            const ddx = pxArr[i] - x;
            const ddz = pzArr[i] - z;
            const d2 = ddx * ddx + ddz * ddz;
            if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
          }
        }
      }
    }
    return bestIdx;
  }

  /** Ownership predicate for one chunk's overlay build. */
  private makeOwnsFn(chunkIndex: number): (lon: number, lat: number) => boolean {
    return (lon: number, lat: number): boolean => this.ownerChunkOf(lon, lat) === chunkIndex;
  }

  /**
   * The route point nearest a scene-local point, back in SCENE metres — the
   * demos' `luRouteAt(x, z)` followed by `pathAt(near.d)`.
   *
   * Only the DIRECTION from a landuse patch to the road is wanted (which edge
   * does its lamp stand on), so the route VERTEX is close enough — the demos
   * resolve to `PATH_STEP = 8 m` and take the nearest sample the same way. Frame
   * conversion is `routeDistanceAt`'s: the owner index works anchored at
   * `points[0]` with +z = north, which is not the scene frame, so this goes
   * through lon/lat rather than trying to relate the two directly.
   */
  private routePointNear(x: number, z: number): { x: number; z: number } | null {
    const cosOrigin = Math.cos((this.originLat * Math.PI) / 180);
    const lon = this.originLon + x / (111320 * cosOrigin);
    const lat = this.originLat - z / 111320;
    const idx = this.nearestRoutePoint(lon, lat);
    if (idx < 0) return null;
    const p = this.points[idx];
    return {
      x: (p.lon - this.originLon) * 111320 * cosOrigin,
      z: -(p.lat - this.originLat) * 111320,
    };
  }

  /**
   * Distance in metres from a point in SCENE coordinates to the route
   * centreline; Infinity when nothing is indexed within reach (the honest
   * answer for "this point is under no constraint from the route").
   *
   * Distance to the nearest route SEGMENT, not the nearest route point: the
   * saved Taipei route samples every ~4 m, so a nearest-point answer overstates
   * the clearance by up to ~2 m mid-segment — half the budget the building
   * trim works with.
   */
  private routeDistanceAt(x: number, z: number): number {
    const cosOrigin = Math.cos((this.originLat * Math.PI) / 180);
    const lon = this.originLon + x / (111320 * cosOrigin);
    const lat = this.originLat - z / 111320;
    const idx = this.nearestRoutePoint(lon, lat);
    if (idx < 0) return Infinity;

    // nearestRoutePoint works in the OWNER frame (anchored at points[0], with
    // +z = north), which is not the scene frame (+z = south). Go through
    // lon/lat rather than trying to relate the two directly.
    const ref = this.points[0];
    const px = (lon - ref.lon) * 111320 * this._ownerCos;
    const pz = (lat - ref.lat) * 111320;
    const ax = this._ownerPx!;
    const az = this._ownerPz!;

    let best = Math.hypot(px - ax[idx], pz - az[idx]);
    for (const j of [idx - 1, idx]) {
      if (j < 0 || j + 1 >= ax.length) continue;
      const dx = ax[j + 1] - ax[j];
      const dz = az[j + 1] - az[j];
      const len2 = dx * dx + dz * dz;
      if (len2 <= 0) continue;
      let t = ((px - ax[j]) * dx + (pz - az[j]) * dz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(px - (ax[j] + t * dx), pz - (az[j] + t * dz));
      if (d < best) best = d;
    }
    return best;
  }

  // ── Bare-earth flattening ──
  //
  // Terrarium DEM is a SURFACE model in dense cities: building heights are
  // baked into the elevation raster, so downtown Taipei grows 30-50m phantom
  // terrain towers — roads draped over them "fly", and buildings float on the
  // spikes their own roofs put into the DEM. We know exactly where buildings
  // are (the MVT footprints), so before a chunk's terrain builds we register
  // every footprint with its street level (min elevation around the ring) and
  // install a sampler correction that clamps samples inside a footprint down
  // to that floor. Global + append-only: overlapping chunks re-register the
  // same footprints (deduped), and every DEM consumer (terrain, buildings,
  // trees, water) sees the same corrected ground.

  /** Footprint/urban-zone entries hashed by ~110m lon/lat cells. `floor` is a
   *  fixed street level for building footprints; `'route'` marks an URBAN
   *  landuse polygon, whose ceiling is resolved per sample as "nearest route
   *  point's elevation + URBAN_CLAMP_M" — the DEM in dense cities is a broad
   *  surface-model plateau (wider than any one footprint), and the route's own
   *  GPX elevation is the one trustworthy street-level signal we have. Real
   *  hills (forest/park landcover) are never registered, so mountains keep
   *  their height. */
  private readonly _flattenCells = new Map<number, {
    ring: [number, number][];
    minLon: number; maxLon: number; minLat: number; maxLat: number;
    floor: number | 'route';
  }[]>();
  private static readonly URBAN_CLAMP_M = 12;
  private readonly _flattenSeen = new Set<number>();
  private static readonly FLATTEN_CELL_DEG = 0.001;

  /**
   * Land-use ZONING index — the same urban polygons the flatten index already
   * walks, kept with their class instead of thrown away.
   *
   * Costs no extra MVT decoding and no extra ring extraction: it is filled
   * inside `registerUrbanZones`, which was already iterating exactly these
   * rings to clamp the DEM. All that was ever missing was keeping the class.
   *
   * The implementation lives in `land-zone.ts` so `render-probe` zones the same
   * way this does — a probe that mirrors the pipeline and then disagrees with
   * it is worse than no probe.
   */
  private readonly _zones = new ZoneIndex();

  private static flattenCellKey(lon: number, lat: number): number {
    const c = TerrainChunkManager.FLATTEN_CELL_DEG;
    return (Math.floor(lon / c) + 200000) * 400000 + (Math.floor(lat / c) + 200000);
  }

  /** Register building footprints (padded chunk bounds — ownership does NOT
   *  apply here: terrain must flatten consistently across chunk seams). */
  private registerBuildingFloors(footprints: { coordinates: [number, number][] }[]): void {
    const c = TerrainChunkManager.FLATTEN_CELL_DEG;
    for (const fp of footprints) {
      const ring = fp.coordinates;
      if (ring.length < 3) continue;
      let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
      let cLon = 0, cLat = 0;
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        cLon += lon;
        cLat += lat;
      }
      cLon /= ring.length;
      cLat /= ring.length;
      // Dedup across overlapping chunk registrations (~1m grid on the centroid).
      const seenKey = Math.round(cLon * 1e5) * 4e7 + Math.round(cLat * 1e5);
      if (this._flattenSeen.has(seenKey)) continue;
      this._flattenSeen.add(seenKey);

      // Street level = min elevation around the ring (buildings meet the
      // street at their perimeter). Sampled sync — the caller prefetched the
      // DEM for these bounds already.
      let floor = Infinity;
      const step = Math.max(1, Math.floor(ring.length / 8));
      for (let i = 0; i < ring.length; i += step) {
        const s = this.sampler.getElevationSync(ring[i][1], ring[i][0]);
        if (s !== null && s < floor) floor = s;
      }
      if (!Number.isFinite(floor)) continue;

      this.addFlattenEntry(ring, minLon, maxLon, minLat, maxLat, floor);
    }
    // Install the correction on first use (idempotent).
    if (!this.sampler.correction) {
      this.sampler.correction = (lat, lon, ele) => this.flattenedEle(lat, lon, ele);
    }
  }

  /** Register URBAN landuse polygons: inside them the DEM is clamped to the
   *  nearest route point's elevation + URBAN_CLAMP_M at query time. */
  private registerUrbanZones(features: MVTFeature[]): void {
    for (const f of features) {
      if (f.layer !== 'landuse' || !isUrbanLanduse(f)) continue;
      const zone = zoneFromLanduseClass(f.properties.class as string | undefined);
      for (const ring of extractPolygonCoords(f)) {
        if (ring.length < 3) continue;
        let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
        let cLon = 0, cLat = 0;
        for (const [lon, lat] of ring) {
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          cLon += lon;
          cLat += lat;
        }
        const seenKey = Math.round((cLon / ring.length) * 1e5) * 4e7 + Math.round((cLat / ring.length) * 1e5) + 1;
        // The zone index keeps its OWN seen-set (inside ZoneIndex). Sharing the
        // flatten one would mean a ring already registered by a neighbouring
        // chunk — correctly skipped for flattening — never reaches the zone
        // index at all, and buildings near a chunk seam would come back unzoned
        // for no visible reason.
        if (zone) this._zones.add(ring, zone);
        if (this._flattenSeen.has(seenKey)) continue;
        this._flattenSeen.add(seenKey);
        this.addFlattenEntry(ring, minLon, maxLon, minLat, maxLat, 'route');
      }
    }
    if (!this.sampler.correction) {
      this.sampler.correction = (lat, lon, ele) => this.flattenedEle(lat, lon, ele);
    }
  }

  /** What kind of district is this point in? Null = outside every known zone. */
  zoneAt(lon: number, lat: number): ZoneKind | null {
    return this._zones.zoneAt(lon, lat);
  }

  private addFlattenEntry(
    ring: [number, number][],
    minLon: number, maxLon: number, minLat: number, maxLat: number,
    floor: number | 'route',
  ): void {
    const c = TerrainChunkManager.FLATTEN_CELL_DEG;
    const entry = { ring, minLon, maxLon, minLat, maxLat, floor };
    for (let gx = Math.floor(minLon / c); gx <= Math.floor(maxLon / c); gx++) {
      for (let gy = Math.floor(minLat / c); gy <= Math.floor(maxLat / c); gy++) {
        const key = (gx + 200000) * 400000 + (gy + 200000);
        let arr = this._flattenCells.get(key);
        if (!arr) { arr = []; this._flattenCells.set(key, arr); }
        arr.push(entry);
      }
    }
  }

  /** Clamp a DEM sample inside a known building footprint / urban zone. */
  private flattenedEle(lat: number, lon: number, ele: number): number {
    const arr = this._flattenCells.get(TerrainChunkManager.flattenCellKey(lon, lat));
    if (!arr) return ele;
    let out = ele;
    // Lazily resolved once per query — nearest-route lookup is not free.
    let routeFloor: number | null = null;
    for (const e of arr) {
      if (lon < e.minLon || lon > e.maxLon || lat < e.minLat || lat > e.maxLat) continue;
      let floor: number;
      if (e.floor === 'route') {
        if (routeFloor === null) {
          const idx = this.nearestRoutePoint(lon, lat);
          routeFloor = idx >= 0
            ? this.points[idx].ele + TerrainChunkManager.URBAN_CLAMP_M
            : Infinity;
        }
        floor = routeFloor;
      } else {
        floor = e.floor;
      }
      if (floor >= out) continue;
      // Even-odd point-in-polygon on the outer ring.
      let inside = false;
      const ring = e.ring;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      if (inside) out = floor;
    }
    return out;
  }

  /**
   * Ground surface height at scene (x, z), or null if no loaded chunk covers it.
   *
   * Reads each in-scene chunk's height grid — captured from the BUILT geometry
   * (post-quantise/jitter), so the value is the exact surface the rider, lamps
   * and route-line must sit on. This replaces the old per-call mesh raycast
   * (rebuilding a candidate array + intersecting ~14–21k triangles per chunk,
   * ~7×/frame); the grid lookup is a warm-started linear scan over ~80 sections,
   * effectively O(1) for the coherent queries this gets. A real raycast is kept
   * ONLY as a fallback for the rare point that misses every grid corridor, so the
   * null/hit contract is identical to before.
   */
  raycastGroundHeight(x: number, z: number, preferY?: number): number | null {
    if (this.inScene.size === 0) return null;

    // preferY (the rider's current height): at a switchback the corridor
    // covers one (x, z) at TWO heights — evaluate every candidate and take the
    // layer closest to where the rider already is, instead of first-hit.
    if (preferY !== undefined) {
      if (this._ringOrderDirty) {
        this._inSceneByRing.length = 0;
        for (const i of this.inScene) this._inSceneByRing.push(i);
        this._inSceneByRing.sort((a, b) => this.lodDistance(a) - this.lodDistance(b));
        this._ringOrderDirty = false;
      }
      let best: number | null = null;
      for (const idx of this._inSceneByRing) {
        const cached = this.cache.get(idx);
        if (!cached || cached.entering) continue;
        const h = sampleChunkHeight(cached.terrain.heightGrid, x, z, this.originEle, preferY);
        if (h !== null && (best === null || Math.abs(h - preferY) < Math.abs(best - preferY))) {
          best = h;
        }
      }
      if (best !== null) return best;
      return this.raycastFallback(x, z);
    }

    // Probe in-scene chunks nearest-first (ring distance from the rider's chunk):
    // the nearest chunk is the full-res one under the query window, so when two
    // chunks' padded corridors overlap at a seam the near one wins deterministically
    // — and the covering chunk is usually found first, cutting the scan short.
    // Reuse the cached nearest-first order; only rebuild+resort when inScene
    // membership or the current chunk changed (see _ringOrderDirty), so the ~7+
    // ground queries per frame share one sort instead of one sort per call.
    const order = this._inSceneByRing;
    if (this._ringOrderDirty) {
      order.length = 0;
      for (const idx of this.inScene) order.push(idx);
      order.sort((a, b) => this.lodDistance(a) - this.lodDistance(b));
      this._ringOrderDirty = false;
    }

    for (const idx of order) {
      const cached = this.cache.get(idx);
      // Skip chunks mid-entrance (F1): their terrain is up in the air / part way
      // unfolded, so its resting-height grid would teleport the rider and let
      // coins cache a wrong (transient) ground height. They fall back to DEM.
      if (!cached || cached.entering) continue;
      const h = sampleChunkHeight(cached.terrain.heightGrid, x, z, this.originEle);
      if (h !== null) return h;
    }

    // Fallback: the point missed every corridor grid (e.g. just off the padded
    // corridor edge). Preserve the old exact behaviour with a real raycast.
    return this.raycastFallback(x, z);
  }

  /** Old mesh-raycast path — used only when no height grid covers (x, z). */
  private raycastFallback(x: number, z: number): number | null {
    this._rayOrigin.set(x, 5000, z);
    this._raycaster.set(this._rayOrigin, TerrainChunkManager.RAY_DOWN);
    this._raycaster.near = 0;
    this._raycaster.far = 10000;

    const meshes = this._raycastMeshes;
    meshes.length = 0;
    for (const idx of this.inScene) {
      const cached = this.cache.get(idx);
      if (cached && !cached.entering) meshes.push(cached.terrain.mesh);
    }

    this._raycastHits.length = 0;
    const hits = this._raycaster.intersectObjects(meshes, false, this._raycastHits);
    return hits.length > 0 ? hits[0].point.y : null;
  }

  /** Route point index range [startIdx, endIdx] a chunk covers, or null. Used
   *  to project only the affected route-line segment when a chunk streams in. */
  getChunkPointRange(chunkIndex: number): { startIdx: number; endIdx: number } | null {
    const slice = this.slices[chunkIndex];
    return slice ? { startIdx: slice.startIdx, endIdx: slice.endIdx } : null;
  }

  /** Get the index of the chunk the rider is currently in. */
  getCurrentChunkIndex(): number {
    return this._currentChunkIndex;
  }

  /** Get the slimmed zone-detection features for a chunk (used by zone detector),
   *  or null if the chunk isn't built yet. */
  getChunkZoneFeatures(chunkIndex: number): ZoneFeatures | null {
    return this.cache.get(chunkIndex)?.zoneFeatures ?? null;
  }

  /** Add all meshes of a chunk to the scene. */
  private addChunkToScene(chunk: ChunkMeshes): void {
    this._ringOrderDirty = true; // inScene membership changes → resort next query
    // Diagnostic names — the debug scene-inventory dump reads these, turning
    // "MeshToonMaterial verts=8604" mysteries into "chunk5/building".
    const idx0 = chunk.terrain.chunkIndex;
    chunk.terrain.mesh.name = `chunk${idx0}/terrain`;
    if (chunk.road) {
      // 一個世界的路可能不只一份材質(電子:一級一張阻焊寬度的貼圖),所以名字帶
      // 序號 —— 場景清單上「chunk5/road0…road5」比六個同名的 mesh 好查。
      chunk.road.meshes.forEach((m, i) => {
        m.name = chunk.road!.meshes.length > 1 ? `chunk${idx0}/road${i}` : `chunk${idx0}/road`;
      });
      if (chunk.road.railMesh) chunk.road.railMesh.name = `chunk${idx0}/rail`;
    }
    if (chunk.waterway) chunk.waterway.mesh.name = `chunk${idx0}/waterway`;
    if (chunk.aeroway) chunk.aeroway.mesh.name = `chunk${idx0}/aeroway`;
    if (chunk.building) {
      chunk.building.mesh.name = `chunk${idx0}/building`;
      chunk.building.mesh.children.forEach((c, i) => { if (!c.name) c.name = `chunk${idx0}/building-deco${i}`; });
      if (chunk.building.lightsMesh) chunk.building.lightsMesh.name = `chunk${idx0}/window-lights`;
    }
    if (chunk.landuse) {
      for (const l of chunk.landuse.layers) l.mesh.name = `chunk${idx0}/landuse:${l.kind}`;
    }
    if (chunk.trees) chunk.trees.mesh.name = `chunk${idx0}/trees`;
    if (chunk.studs) {
      chunk.studs.meshes.forEach((m, i) => { m.name = `chunk${idx0}/studs${i}`; });
    }

    this.scene.add(chunk.terrain.mesh);
    if (chunk.waterway) this.scene.add(chunk.waterway.mesh);
    if (chunk.aeroway) {
      this.scene.add(chunk.aeroway.mesh);
      for (const p of chunk.aeroway.planes) this.scene.add(p);
    }
    if (chunk.road) {
      for (const m of chunk.road.meshes) this.scene.add(m);
      if (chunk.road.railMesh) this.scene.add(chunk.road.railMesh);
      for (const p of chunk.road.portals) {
        p.name = `chunk${idx0}/tunnel-portal`;
        this.scene.add(p);
      }
    }
    if (chunk.building) {
      this.scene.add(chunk.building.mesh);
      if (chunk.building.lightsMesh) this.scene.add(chunk.building.lightsMesh);
    }
    if (chunk.landuse) {
      for (const m of landuseMeshes(chunk.landuse)) this.scene.add(m);
    }
    if (chunk.trees) this.scene.add(chunk.trees.mesh);
    if (chunk.studs) for (const m of chunk.studs.meshes) this.scene.add(m);

    // Entrance animation (F1) — only the FIRST time a chunk is shown, and only
    // for chunks strictly ahead of the rider (never the ground under the rider
    // nor the chunk behind, which would make the floor jump). Lap re-mounts are
    // already in `entered` → mount instantly.
    const idx = chunk.terrain.chunkIndex;
    if (!this.entrancePlayed.has(idx)) {
      this.entrancePlayed.add(idx);
      if (idx > this._currentChunkIndex) {
        chunk.entering = {
          age: 0,
          duration: ENTRANCE_DURATION,
          // paper unfolds like a pop-up book; plastic AND circuit drop — for
          // circuit that is a decision, not a fallthrough: SMT parts are set
          // down by the pick-and-place head, and "components dropping onto the
          // board" is that machine's own motion. (A power-on sweep entrance is
          // the 2D demo's move; if 3D ever wants it, add a third mode here.)
          mode: this.strategy.style === 'paper' ? 'unfold' : 'drop',
        };
        this.entering.add(idx);
        this.applyEntrance(chunk, 0); // seed the start pose before first render
      }
    }
  }

  /** Remove all meshes of a chunk from the scene. */
  private removeChunkFromScene(chunk: ChunkMeshes): void {
    this._ringOrderDirty = true; // inScene membership changes → resort next query
    // If it leaves mid-entrance, snap it to the landed pose so a later re-mount
    // (hasEntered=true → no replay) isn't stuck half-dropped/half-unfolded.
    if (chunk.entering) this.finalizeEntrance(chunk);

    this.scene.remove(chunk.terrain.mesh);
    if (chunk.waterway) this.scene.remove(chunk.waterway.mesh);
    if (chunk.aeroway) {
      this.scene.remove(chunk.aeroway.mesh);
      for (const p of chunk.aeroway.planes) this.scene.remove(p);
    }
    if (chunk.road) {
      for (const m of chunk.road.meshes) this.scene.remove(m);
      if (chunk.road.railMesh) this.scene.remove(chunk.road.railMesh);
      for (const p of chunk.road.portals) this.scene.remove(p);
    }
    if (chunk.building) {
      this.scene.remove(chunk.building.mesh);
      if (chunk.building.lightsMesh) this.scene.remove(chunk.building.lightsMesh);
    }
    if (chunk.landuse) {
      for (const m of landuseMeshes(chunk.landuse)) this.scene.remove(m);
    }
    if (chunk.trees) this.scene.remove(chunk.trees.mesh);
    if (chunk.studs) for (const m of chunk.studs.meshes) this.scene.remove(m);
  }

  // ── Entrance animation (F1) ──

  /** Advance every in-flight chunk entrance. Call once per frame from the
   *  renderer with the frame dt. */
  updateEntrances(dt: number): void {
    if (this.entering.size === 0) return;
    for (const idx of this.entering) {
      const chunk = this.cache.get(idx);
      if (!chunk || !chunk.entering) { this.entering.delete(idx); continue; }
      chunk.entering.age += dt;
      const t = chunk.entering.age / chunk.entering.duration;
      if (t >= 1) {
        this.finalizeEntrance(chunk);
        // Terrain is now at its real height — (re)project the route line onto it.
        this.onChunkLoaded?.(idx);
      } else {
        this.applyEntrance(chunk, t);
      }
    }
  }

  /** Every mesh of a chunk, so the whole block moves as one unit. Props ride on
   *  top of the ground rather than floating in on a separate timeline (which
   *  would leave buildings hanging in mid-air while the ground lands). */
  private chunkMeshList(chunk: ChunkMeshes): THREE.Object3D[] {
    const out: THREE.Object3D[] = [chunk.terrain.mesh];
    if (chunk.waterway) out.push(chunk.waterway.mesh);
    if (chunk.aeroway) out.push(chunk.aeroway.mesh, ...chunk.aeroway.planes);
    if (chunk.road) {
      out.push(...chunk.road.meshes);
      if (chunk.road.railMesh) out.push(chunk.road.railMesh);
    }
    if (chunk.landuse) out.push(...landuseMeshes(chunk.landuse));
    if (chunk.building) {
      out.push(chunk.building.mesh);
      if (chunk.building.lightsMesh) out.push(chunk.building.lightsMesh);
    }
    if (chunk.trees) out.push(chunk.trees.mesh);
    if (chunk.studs) out.push(...chunk.studs.meshes);
    return out;
  }

  /** Apply the entrance pose at normalised time t (0..1). drop = Y offset (base
   *  is 0, floating origin is fixed); unfold = Y scale about the origin plane. */
  private applyEntrance(chunk: ChunkMeshes, t: number): void {
    const mode = chunk.entering!.mode;
    const meshes = this.chunkMeshList(chunk);
    if (mode === 'drop') {
      const y = ENTRANCE_DROP_HEIGHT * (1 - easeOutBounce(clamp01(t)));
      for (const m of meshes) m.position.y = y;
    } else {
      const s = Math.max(0.02, easeOutCubic(clamp01(t)));
      for (const m of meshes) m.scale.y = s;
    }
  }

  private finalizeEntrance(chunk: ChunkMeshes): void {
    for (const m of this.chunkMeshList(chunk)) { m.position.y = 0; m.scale.y = 1; }
    if (chunk.entering) this.entering.delete(chunk.terrain.chunkIndex);
    chunk.entering = null;
  }

  /**
   * Swap the active world-style strategy and rebuild all terrain/overlay meshes
   * so materials, colours, and (from P1) quantised geometry update live. Heavy —
   * only call on an explicit style switch, not per-frame. Disposes every cached
   * chunk (freeing per-chunk materials the OLD strategy handed out) then reloads
   * the chunks currently around the rider.
   */
  setStrategy(strategy: TerrainStyleStrategy): void {
    this.strategy = strategy;
    this.rebuild();
  }

  /** Dispose all cached chunks and reload the ones around the rider. */
  rebuild(): void {
    this.clearChunks();
    // The new style quantises elevation differently, so the old seams no longer
    // fit — and the whole world re-enters, as it did on the first load.
    this.edges.clear();
    this.entrancePlayed.clear();
    // Reload the chunks the rider currently needs.
    this.update(this.lastDistanceM);
  }

  /** Dispose all resources. Call on game end. */
  dispose(): void {
    this.clearChunks();
    this.edges.clear();
    this.entrancePlayed.clear();
    this.sampler.clearCache();
    this.mvtFetcher?.clearCache();
  }

  /** Free every cached chunk and reset the scene bookkeeping. */
  private clearChunks(): void {
    // Bump the generation so any in-flight build/upgrade, on its next await
    // boundary, sees the mismatch and abandons instead of writing into the fresh
    // world's cache/scene (the in-flight-build race).
    this.buildGeneration++;
    for (const chunk of this.cache.values()) this.disposeChunk(chunk);
    this.cache.clear();
    this.inScene.clear();
    this.entering.clear();
    // Drop queued build bookkeeping. In-flight builds keep running and decrement
    // activeBuilds themselves in runRequest's finally (so it is NOT reset here —
    // resetting would drive the counter negative); their settleRequest becomes a
    // harmless no-op once requests is cleared, and new requests re-enqueue clean.
    this.requests.clear();
    this.queue.length = 0;
  }
}
