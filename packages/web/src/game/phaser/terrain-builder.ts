/**
 * Terrain builder for the Excitebike 2D scene.
 *
 * Converts route elevation data + MVT vector tile features into
 * 2D scene elements:
 * - Elevation profile → ground surface polyline
 * - Buildings → colored rectangles on ground
 * - Forests → triangle+trunk tree sprites
 * - Water → blue fill below ground line
 * - Grass/park → green-tinted ground segments
 *
 * Features are processed in ~500m chunks for progressive loading.
 * MVT fetching + projection is offloaded to a Web Worker.
 */

import type { RoutePoint } from '@littlecycling/shared';
import { fetchFeaturesInWorker } from '@/game/terrain/mvt-worker-client';
import { PX_PER_METER, ELEVATION_EXAGGERATION } from './phaser2d-scene';
import type { PhaserStyleStrategy } from './phaser-style-strategy';

// Re-export ProjectedFeature so existing consumers don't need to change imports
export type { ProjectedFeature } from '@/game/terrain/mvt-projection';
import type { ProjectedFeature } from '@/game/terrain/mvt-projection';

/** Sampling interval for elevation profile (meters). */
const ELEVATION_SAMPLE_INTERVAL = 5;

/** Chunk size in meters for progressive loading. */
export const CHUNK_SIZE_M = 500;

/** Number of chunks to preload ahead of the cyclist. */
const PRELOAD_AHEAD = 3;

/** Number of chunks to keep behind the cyclist. */
const KEEP_BEHIND = 1;

// ── Elevation profile ──

export interface ElevationSample {
  distM: number;
  eleM: number;
}

/**
 * Build a sampled elevation profile from route points.
 * Samples every ELEVATION_SAMPLE_INTERVAL meters.
 */
export function buildElevationProfile(
  points: RoutePoint[],
  cumulativeDists: number[],
): ElevationSample[] {
  if (points.length < 2) return [];

  const totalDist = cumulativeDists[cumulativeDists.length - 1];
  const samples: ElevationSample[] = [];

  for (let d = 0; d <= totalDist; d += ELEVATION_SAMPLE_INTERVAL) {
    // Binary search for segment
    let lo = 0;
    let hi = cumulativeDists.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cumulativeDists[mid] <= d) lo = mid;
      else hi = mid;
    }

    const seg = cumulativeDists[hi] - cumulativeDists[lo];
    const t = seg > 0 ? (d - cumulativeDists[lo]) / seg : 0;
    const ele = points[lo].ele + (points[hi].ele - points[lo].ele) * Math.max(0, Math.min(1, t));
    samples.push({ distM: d, eleM: ele });
  }

  // Ensure the last point is included
  if (samples.length > 0 && samples[samples.length - 1].distM < totalDist) {
    samples.push({ distM: totalDist, eleM: points[points.length - 1].ele });
  }

  return samples;
}

// ── Chunk-based 2D rendering ──

/** A terrain chunk with Phaser game objects. */
export interface TerrainChunk {
  index: number;
  startDistM: number;
  endDistM: number;
  graphics: Phaser.GameObjects.Graphics;
  objects: Phaser.GameObjects.GameObject[];
}

/**
 * Manages chunk-based progressive loading/unloading of 2D terrain features.
 */
/** Water feature position for shimmer animation. */
export interface WaterFeaturePos {
  x: number;
  groundY: number;
  width: number;
}

export class TerrainChunkManager2D {
  private scene: Phaser.Scene;
  private strategy: PhaserStyleStrategy;
  private elevationProfile: ElevationSample[];
  private features: ProjectedFeature[];
  private chunks = new Map<number, TerrainChunk>();
  private featuresByChunk = new Map<number, ProjectedFeature[]>();
  private minElevation: number;
  private maxElevation: number;
  private waterByChunk = new Map<number, WaterFeaturePos[]>();
  /** Track last lamp X to enforce minimum spacing. */
  private lastLampDistM = -Infinity;

  constructor(
    scene: Phaser.Scene,
    elevationProfile: ElevationSample[],
    features: ProjectedFeature[],
    strategy: PhaserStyleStrategy,
  ) {
    this.scene = scene;
    this.strategy = strategy;
    this.elevationProfile = elevationProfile;
    this.features = features;

    this.minElevation = Math.min(...elevationProfile.map((p) => p.eleM));
    this.maxElevation = Math.max(...elevationProfile.map((p) => p.eleM));

    // Pre-sort features into chunks
    for (const f of features) {
      const chunkIdx = Math.floor(f.distanceM / CHUNK_SIZE_M);
      let arr = this.featuresByChunk.get(chunkIdx);
      if (!arr) {
        arr = [];
        this.featuresByChunk.set(chunkIdx, arr);
      }
      arr.push(f);
    }
  }

  /**
   * Update which chunks are active based on cyclist position.
   */
  update(distanceM: number) {
    const currentChunk = Math.floor(distanceM / CHUNK_SIZE_M);
    const minChunk = Math.max(0, currentChunk - KEEP_BEHIND);
    const maxChunk = currentChunk + PRELOAD_AHEAD;

    // Load new chunks
    for (let i = minChunk; i <= maxChunk; i++) {
      if (!this.chunks.has(i)) {
        this.loadChunk(i);
      }
    }

    // Unload distant chunks
    for (const [idx, chunk] of this.chunks) {
      if (idx < minChunk || idx > maxChunk) {
        this.unloadChunk(chunk);
        this.chunks.delete(idx);
      }
    }
  }

  private loadChunk(index: number) {
    const startDistM = index * CHUNK_SIZE_M;
    const endDistM = (index + 1) * CHUNK_SIZE_M;
    const gfx = this.scene.add.graphics();
    gfx.setDepth(15);
    const objects: Phaser.GameObjects.GameObject[] = [];

    const chunkFeatures = this.featuresByChunk.get(index) || [];
    const h = this.scene.game.canvas.height;
    const baselineY = h * 0.75;
    const elevRange = Math.max(this.maxElevation - this.minElevation, 10);

    const chunkWaters: WaterFeaturePos[] = [];
    for (const f of chunkFeatures) {
      switch (f.type) {
        case 'building':
          this.renderBuilding(gfx, f, baselineY, elevRange);
          break;
        case 'tree':
          this.renderTree(gfx, f, baselineY, elevRange);
          break;
        case 'water': {
          const wp = this.renderWater(gfx, f, baselineY, elevRange);
          if (wp) chunkWaters.push(wp);
          break;
        }
        case 'grass':
          this.renderGrass(gfx, f, baselineY, elevRange);
          break;
        case 'road':
          this.renderRoadLamp(gfx, f, baselineY, elevRange);
          break;
      }
    }
    if (chunkWaters.length > 0) {
      this.waterByChunk.set(index, chunkWaters);
    }

    const chunk: TerrainChunk = { index, startDistM, endDistM, graphics: gfx, objects };
    this.chunks.set(index, chunk);
  }

  private unloadChunk(chunk: TerrainChunk) {
    chunk.graphics.destroy();
    for (const obj of chunk.objects) {
      obj.destroy();
    }
    this.waterByChunk.delete(chunk.index);
  }

  /** Render a building — delegates visual style to strategy. */
  private renderBuilding(
    gfx: Phaser.GameObjects.Graphics,
    feature: ProjectedFeature,
    baselineY: number,
    elevRange: number,
  ) {
    const groundY = this.getGroundY(feature.distanceM, baselineY, elevRange);
    const heightM = feature.props.render_height || feature.props.height || 8;
    const heightPx = heightM * PX_PER_METER * 0.8;
    const widthPx = Math.max(15, Math.min(40, heightPx * 0.6));
    const x = feature.distanceM * PX_PER_METER;

    const hash = Math.abs(
      Math.round((feature.props.lon || 0) * 100000) * 31 +
      Math.round((feature.props.lat || 0) * 100000) * 17,
    );
    const colorIndex = hash % this.strategy.palette.buildingColors.length;

    this.strategy.renderBuilding(gfx, x - widthPx / 2, groundY - heightPx, widthPx, heightPx, colorIndex, hash);
  }

  /** Render a tree — delegates visual style to strategy. */
  private renderTree(
    gfx: Phaser.GameObjects.Graphics,
    feature: ProjectedFeature,
    baselineY: number,
    elevRange: number,
  ) {
    const groundY = this.getGroundY(feature.distanceM, baselineY, elevRange);
    const x = feature.distanceM * PX_PER_METER;
    const seed = Math.abs(Math.round(x * 7)) % 100;

    this.strategy.renderTree(gfx, x, groundY, 0, seed);
  }

  /** Render water — delegates visual style to strategy. Returns position for shimmer. */
  private renderWater(
    gfx: Phaser.GameObjects.Graphics,
    feature: ProjectedFeature,
    baselineY: number,
    elevRange: number,
  ): WaterFeaturePos | null {
    const groundY = this.getGroundY(feature.distanceM, baselineY, elevRange);
    const x = feature.distanceM * PX_PER_METER;
    const h = this.scene.game.canvas.height;
    const seed = Math.abs(Math.round(x * 11)) % 100;

    const result = this.strategy.renderWater(gfx, x, groundY, 60, h - groundY, seed);
    if (!result) return null;
    return { x: result.x, groundY: result.y, width: result.w };
  }

  /** Minimum spacing between road lamps in meters. */
  private static readonly LAMP_MIN_SPACING_M = 80;

  /** Render a street lamp at road positions — delegates visual style to strategy. */
  private renderRoadLamp(
    gfx: Phaser.GameObjects.Graphics,
    feature: ProjectedFeature,
    baselineY: number,
    elevRange: number,
  ) {
    // Skip if too close to previous lamp
    if (feature.distanceM - this.lastLampDistM < TerrainChunkManager2D.LAMP_MIN_SPACING_M) return;
    this.lastLampDistM = feature.distanceM;

    const groundY = this.getGroundY(feature.distanceM, baselineY, elevRange);
    const x = feature.distanceM * PX_PER_METER;
    const seed = Math.abs(Math.round(x * 17)) % 100;

    this.strategy.renderRoadLamp(gfx, x, groundY, seed);
  }

  /** Render grass/park — delegates visual style to strategy. */
  private renderGrass(
    gfx: Phaser.GameObjects.Graphics,
    feature: ProjectedFeature,
    baselineY: number,
    elevRange: number,
  ) {
    const groundY = this.getGroundY(feature.distanceM, baselineY, elevRange);
    const x = feature.distanceM * PX_PER_METER;
    const seed = Math.abs(Math.round(x * 13)) % 100;

    this.strategy.renderGrass(gfx, x, groundY, 30, 4, seed);
  }

  /** Get ground Y position for a given route distance. */
  private getGroundY(distanceM: number, baselineY: number, elevRange: number): number {
    // Binary search in elevation profile
    let lo = 0;
    let hi = this.elevationProfile.length - 1;
    if (hi < 0) return baselineY;

    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.elevationProfile[mid].distM <= distanceM) lo = mid;
      else hi = mid;
    }

    const p0 = this.elevationProfile[lo];
    const p1 = this.elevationProfile[hi];
    const seg = p1.distM - p0.distM;
    const t = seg > 0 ? (distanceM - p0.distM) / seg : 0;
    const ele = p0.eleM + (p1.eleM - p0.eleM) * Math.max(0, Math.min(1, t));

    const normalizedEle = (ele - this.minElevation) / elevRange;
    return baselineY - normalizedEle * (baselineY * 0.6) * ELEVATION_EXAGGERATION / (elevRange > 500 ? 2 : 1);
  }

  /** Get all currently loaded water feature positions (for shimmer animation). */
  getWaterFeatures(): WaterFeaturePos[] {
    const result: WaterFeaturePos[] = [];
    for (const waters of this.waterByChunk.values()) {
      result.push(...waters);
    }
    return result;
  }

  dispose() {
    for (const chunk of this.chunks.values()) {
      this.unloadChunk(chunk);
    }
    this.chunks.clear();
    this.waterByChunk.clear();
  }
}

/**
 * Fetch MVT features along a route and project them to 2D.
 * Runs in a Web Worker to avoid blocking the main thread.
 * Returns ProjectedFeature[] sorted by distance.
 */
export async function fetchAndProjectFeatures(
  points: RoutePoint[],
  cumulativeDists: number[],
): Promise<ProjectedFeature[]> {
  if (points.length < 2) return [];
  return fetchFeaturesInWorker(points, cumulativeDists);
}
