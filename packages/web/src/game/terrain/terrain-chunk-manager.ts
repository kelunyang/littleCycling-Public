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
 */

import * as THREE from 'three';
import type { RoutePoint } from '@littlecycling/shared';
import { buildCumulativeDistances } from '../route-geometry';
import { debugLog, isDebugEnabled } from '@/game/debug-logger';
import { ElevationSampler } from './elevation-sampler';
import {
  buildTerrainChunk,
  computeGeoBounds,
  type ChunkBuildInput,
  type ChunkEdgeData,
  type TerrainChunkResult,
} from './terrain-chunk';
import { MVTFetcher } from './mvt-fetcher';
import { buildRoadMeshes, disposeRoadMesh, type RoadRenderResult } from './road-renderer';
import { buildBuildingMeshes, extractBuildingsFromMVT, disposeBuildingMesh, type BuildingRenderResult } from './building-renderer';
import { buildLanduseMeshes, disposeLanduseMeshes, type LanduseRenderResult } from './landuse-renderer';
import { buildTreeMeshes, disposeTreeMesh, type TreeRenderResult } from './tree-renderer';
import type { MVTFeature } from './mvt-fetcher';

/** Approximate length of each chunk in meters. */
export const CHUNK_LENGTH = 2000;

/** Number of chunks to keep in the scene ahead of the ball. */
export const CHUNKS_AHEAD = 3;

/** Number of chunks to keep in the scene behind the ball. */
const CHUNKS_BEHIND = 1;

/** Number of chunks to preload at game start. */
const PRELOAD_CHUNKS = 5;

/** All meshes produced for one chunk (terrain + MVT overlays). */
interface ChunkMeshes {
  terrain: TerrainChunkResult;
  road?: RoadRenderResult;
  building?: BuildingRenderResult;
  landuse?: LanduseRenderResult;
  /** Cached MVT features for zone detection (Phase 2). */
  mvtFeatures?: MVTFeature[];
  /** Instanced tree meshes for forest areas (Phase 3). */
  trees?: TreeRenderResult;
}

export interface ChunkManagerOptions {
  scene: THREE.Scene;
  points: RoutePoint[];
  sampler?: ElevationSampler;
  /** MVT fetcher for road/building/water overlay data. */
  mvtFetcher?: MVTFetcher;
  /** Corridor half-width in meters (passed to terrain chunks). */
  corridorHalfWidth?: number;
  /** Called after a chunk finishes building and is added to the scene. */
  onChunkLoaded?: (chunkIndex: number) => void;
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

  /** Mesh cache: chunkIndex → all meshes. Never disposed during gameplay. */
  private readonly cache = new Map<number, ChunkMeshes>();

  /** Chunks currently added to the scene. */
  private readonly inScene = new Set<number>();

  /** Chunks currently being built (prevents duplicate builds). */
  private readonly building = new Set<number>();

  /** Floating origin (updated from game loop). */
  private readonly corridorHalfWidth?: number;
  private readonly onChunkLoaded?: (chunkIndex: number) => void;

  private originLat = 0;
  private originLon = 0;
  private originEle = 0;

  /** Index of the chunk the rider is currently in. */
  private _currentChunkIndex = 0;

  constructor(options: ChunkManagerOptions) {
    this.scene = options.scene;
    this.points = options.points;
    this.sampler = options.sampler ?? new ElevationSampler();
    this.mvtFetcher = options.mvtFetcher ?? null;
    this.corridorHalfWidth = options.corridorHalfWidth;
    this.onChunkLoaded = options.onChunkLoaded;
    this.cumulativeDistances = buildCumulativeDistances(this.points);
    this.totalDistance =
      this.cumulativeDistances[this.cumulativeDistances.length - 1];

    this.buildSlices();

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

  /**
   * Preload initial chunks at game start.
   * Returns a promise that resolves when all preloaded chunks are ready.
   */
  async preload(): Promise<void> {
    const count = Math.min(PRELOAD_CHUNKS, this.slices.length);
    const promises: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(this.ensureChunk(i));
    }
    await Promise.all(promises);
  }

  /**
   * Update which chunks are in the scene based on ball's current route distance.
   * Call this every frame or when ball moves significantly.
   */
  update(distanceM: number): void {
    // Handle lap wrapping
    const wrappedDist = this.totalDistance > 0
      ? distanceM % this.totalDistance
      : distanceM;

    const currentChunk = this.getChunkIndex(wrappedDist);
    this._currentChunkIndex = currentChunk;

    // Determine which chunks should be in the scene
    const wanted = new Set<number>();
    for (
      let i = currentChunk - CHUNKS_BEHIND;
      i <= currentChunk + CHUNKS_AHEAD;
      i++
    ) {
      // Wrap around for lap races
      const idx = ((i % this.slices.length) + this.slices.length) % this.slices.length;
      wanted.add(idx);
    }

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

    // Add/load wanted chunks
    for (const idx of wanted) {
      if (this.inScene.has(idx)) continue;

      const cached = this.cache.get(idx);
      if (cached) {
        // Re-add from cache (zero cost for lap races)
        this.addChunkToScene(cached);
        this.inScene.add(idx);
      } else {
        // Start async build
        this.ensureChunk(idx);
      }
    }
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
      if (chunk.road) {
        chunk.road.mesh.position.x += dx;
        chunk.road.mesh.position.y += dy;
        chunk.road.mesh.position.z += dz;
      }
      if (chunk.building) {
        chunk.building.mesh.position.x += dx;
        chunk.building.mesh.position.y += dy;
        chunk.building.mesh.position.z += dz;
      }
      if (chunk.landuse) {
        const landuseMeshes = [
          chunk.landuse.waterMesh, chunk.landuse.parkMesh,
          chunk.landuse.forestMesh, chunk.landuse.sandMesh,
          chunk.landuse.urbanMesh,
        ];
        for (const m of landuseMeshes) {
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
    }

    this.originLat = newLat;
    this.originLon = newLon;
    this.originEle = newEle;
  }

  /** Ensure a chunk is built and optionally in the scene. */
  private async ensureChunk(chunkIndex: number): Promise<void> {
    if (this.cache.has(chunkIndex) || this.building.has(chunkIndex)) return;
    if (chunkIndex < 0 || chunkIndex >= this.slices.length) return;

    this.building.add(chunkIndex);

    try {
      const slice = this.slices[chunkIndex];
      // Get previous chunk's last edge for seamless stitching
      const prevResult = this.cache.get(chunkIndex - 1);
      const prevEdge: ChunkEdgeData | undefined = prevResult?.terrain.lastEdge;

      const buildInput: ChunkBuildInput = {
        points: this.points,
        cumulativeDistances: this.cumulativeDistances,
        startIdx: slice.startIdx,
        endIdx: slice.endIdx,
        chunkIndex,
        prevEdge,
        corridorHalfWidth: this.corridorHalfWidth,
      };

      const terrainResult = await buildTerrainChunk(
        buildInput,
        this.sampler,
        this.originLat,
        this.originLon,
        this.originEle,
      );

      const chunkMeshes: ChunkMeshes = { terrain: terrainResult };

      // Build MVT overlay meshes (roads, buildings, water/parks) in parallel
      if (this.mvtFetcher) {
        // Compute geographic bounds for this chunk's corridor
        const segPoints = this.points.slice(slice.startIdx, slice.endIdx + 1);
        const coords = segPoints.map((p) => ({ lat: p.lat, lon: p.lon }));
        const bounds = computeGeoBounds(coords);
        // Expand bounds slightly to capture features at edges
        const PAD = 0.005; // ~500m
        bounds.south -= PAD;
        bounds.north += PAD;
        bounds.west -= PAD;
        bounds.east += PAD;

        try {
          const mvtFeatures = await this.mvtFetcher.getFeaturesForBounds(bounds);

          const [roadResult, buildingResult, landuseResult] = await Promise.all([
            buildRoadMeshes(mvtFeatures, this.sampler, this.originLat, this.originLon, this.originEle),
            this.buildChunkBuildings(mvtFeatures, bounds),
            buildLanduseMeshes(mvtFeatures, this.sampler, this.originLat, this.originLon, this.originEle),
          ]);

          // Cache MVT features for zone detection
          chunkMeshes.mvtFeatures = mvtFeatures;

          if (roadResult.roadCount > 0) chunkMeshes.road = roadResult;
          if (buildingResult.buildingCount > 0) chunkMeshes.building = buildingResult;
          const hasLanduse = landuseResult.waterCount > 0 || landuseResult.parkCount > 0
            || landuseResult.forestCount > 0 || landuseResult.sandCount > 0
            || landuseResult.urbanCount > 0;
          if (hasLanduse) {
            chunkMeshes.landuse = landuseResult;
          }

          // Build trees in forest areas
          const forestFeatures = mvtFeatures.filter(
            (f) => f.layer === 'landcover' && (f.properties.class === 'wood' || f.properties.class === 'forest'),
          );
          if (forestFeatures.length > 0) {
            try {
              const treeResult = await buildTreeMeshes(
                forestFeatures, this.sampler,
                this.originLat, this.originLon, this.originEle,
              );
              if (treeResult.treeCount > 0) {
                chunkMeshes.trees = treeResult;
              }
            } catch (treeErr) {
              console.warn(`[ChunkManager] Tree build failed for chunk ${chunkIndex}:`, treeErr);
            }
          }
        } catch (err) {
          console.warn(`[ChunkManager] MVT overlay failed for chunk ${chunkIndex}:`, err);
        }
      }

      this.cache.set(chunkIndex, chunkMeshes);

      if (isDebugEnabled()) {
        const terrVerts = chunkMeshes.terrain.mesh.geometry.getAttribute('position')?.count ?? 0;
        const roadCount = chunkMeshes.road?.roadCount ?? 0;
        const buildingCount = chunkMeshes.building?.buildingCount ?? 0;
        const lu = chunkMeshes.landuse;
        debugLog('chunk', `Chunk ${chunkIndex} built`, {
          terrainVerts: terrVerts, roads: roadCount, buildings: buildingCount,
          water: lu?.waterCount ?? 0, parks: lu?.parkCount ?? 0,
          forests: lu?.forestCount ?? 0, sand: lu?.sandCount ?? 0,
          urban: lu?.urbanCount ?? 0, trees: chunkMeshes.trees?.treeCount ?? 0,
        });
      }

      // Add to scene if it's still wanted
      this.addChunkToScene(chunkMeshes);
      this.inScene.add(chunkIndex);

      // Notify listener (e.g. to project route line onto new terrain)
      this.onChunkLoaded?.(chunkIndex);
    } finally {
      this.building.delete(chunkIndex);
    }
  }

  /** Build building meshes from MVT features for a chunk. */
  private async buildChunkBuildings(
    mvtFeatures: import('./mvt-fetcher').MVTFeature[],
    bounds: { south: number; north: number; west: number; east: number },
  ): Promise<BuildingRenderResult> {
    const footprints = extractBuildingsFromMVT(mvtFeatures, bounds);
    return buildBuildingMeshes(
      footprints,
      this.sampler,
      this.originLat,
      this.originLon,
      this.originEle,
    );
  }

  /**
   * Raycast downward at (x, z) in scene coordinates to find the terrain
   * surface height. Returns the y-coordinate of the hit point, or null if
   * no terrain mesh is hit (e.g. chunks not yet loaded).
   */
  raycastGroundHeight(x: number, z: number): number | null {
    if (this.inScene.size === 0) return null;

    const origin = new THREE.Vector3(x, 5000, z);
    const direction = new THREE.Vector3(0, -1, 0);
    const raycaster = new THREE.Raycaster(origin, direction, 0, 10000);

    const meshes: THREE.Mesh[] = [];
    for (const idx of this.inScene) {
      const cached = this.cache.get(idx);
      if (cached) meshes.push(cached.terrain.mesh);
    }

    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length > 0) {
      return hits[0].point.y;
    }
    return null;
  }

  /** Get the index of the chunk the rider is currently in. */
  getCurrentChunkIndex(): number {
    return this._currentChunkIndex;
  }

  /** Get cached MVT features for a chunk (used by zone detector). */
  getChunkFeatures(chunkIndex: number): MVTFeature[] {
    return this.cache.get(chunkIndex)?.mvtFeatures ?? [];
  }

  /** Add all meshes of a chunk to the scene. */
  private addChunkToScene(chunk: ChunkMeshes): void {
    this.scene.add(chunk.terrain.mesh);
    if (chunk.road) this.scene.add(chunk.road.mesh);
    if (chunk.building) this.scene.add(chunk.building.mesh);
    if (chunk.landuse) {
      this.scene.add(chunk.landuse.waterMesh);
      this.scene.add(chunk.landuse.parkMesh);
      this.scene.add(chunk.landuse.forestMesh);
      this.scene.add(chunk.landuse.sandMesh);
      this.scene.add(chunk.landuse.urbanMesh);
    }
    if (chunk.trees) this.scene.add(chunk.trees.mesh);
  }

  /** Remove all meshes of a chunk from the scene. */
  private removeChunkFromScene(chunk: ChunkMeshes): void {
    this.scene.remove(chunk.terrain.mesh);
    if (chunk.road) this.scene.remove(chunk.road.mesh);
    if (chunk.building) this.scene.remove(chunk.building.mesh);
    if (chunk.landuse) {
      this.scene.remove(chunk.landuse.waterMesh);
      this.scene.remove(chunk.landuse.parkMesh);
      this.scene.remove(chunk.landuse.forestMesh);
      this.scene.remove(chunk.landuse.sandMesh);
      this.scene.remove(chunk.landuse.urbanMesh);
    }
    if (chunk.trees) this.scene.remove(chunk.trees.mesh);
  }

  /** Dispose all resources. Call on game end. */
  dispose(): void {
    for (const chunk of this.cache.values()) {
      this.removeChunkFromScene(chunk);
      // Terrain
      chunk.terrain.mesh.geometry.dispose();
      const mat = chunk.terrain.mesh.material;
      if (mat instanceof THREE.Material) mat.dispose();
      // Overlays
      if (chunk.road) disposeRoadMesh(chunk.road);
      if (chunk.building) disposeBuildingMesh(chunk.building);
      if (chunk.landuse) disposeLanduseMeshes(chunk.landuse);
      if (chunk.trees) disposeTreeMesh(chunk.trees);
    }
    this.cache.clear();
    this.inScene.clear();
    this.building.clear();
    this.sampler.clearCache();
    this.mvtFetcher?.clearCache();
  }
}
