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
import { PX_PER_METER, type Phaser2DScene } from './phaser2d-scene';
import type { PhaserStyleStrategy } from './phaser-style-strategy';

// Re-export ProjectedFeature so existing consumers don't need to change imports
export type { ProjectedFeature } from '@/game/terrain/mvt-projection';
import type { ProjectedFeature } from '@/game/terrain/mvt-projection';

/** Sampling interval for elevation profile (meters). */
const ELEVATION_SAMPLE_INTERVAL = 5;

/** Window-light layer opacity from the night factor — smoothstep dusk 0.25→0.6. */
function nightLightAlpha(nightFactor: number): number {
  const t = Math.max(0, Math.min(1, (nightFactor - 0.25) / 0.35));
  return t * t * (3 - 2 * t) * 0.9;
}

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
  /** Warm additive window glows for this chunk's buildings — alpha driven by
   *  the night factor (F2). */
  lights?: Phaser.GameObjects.Graphics;
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
  private scene: Phaser2DScene;
  private strategy: PhaserStyleStrategy;
  private elevationProfile: ElevationSample[];
  private features: ProjectedFeature[];
  private chunks = new Map<number, TerrainChunk>();
  private featuresByChunk = new Map<number, ProjectedFeature[]>();
  private minElevation: number;
  private maxElevation: number;
  private waterByChunk = new Map<number, WaterFeaturePos[]>();
  /** Current night factor (0 day → 1 night) — building-light alpha. */
  private currentNightFactor = 0;
  /** Flattened water-feature cache + dirty flag. getWaterFeatures() is polled
   *  every frame by the renderer; water only changes on chunk load/unload, so
   *  rebuild the flat list only then instead of re-flattening every frame. */
  private waterFeaturesCache: WaterFeaturePos[] = [];
  private waterDirty = false;
  /** Track last lamp X to enforce minimum spacing. */
  private lastLampDistM = -Infinity;

  /** Paved stretches of the route (meters), merged from nearby road features.
   *  Where these spans cover the route the ground gets a road-surface
   *  treatment; gaps read as unpaved trail. */
  private roadSpans: { start: number; end: number }[] = [];

  constructor(
    scene: Phaser2DScene,
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

    this.roadSpans = buildRoadSpans(features);
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

  /**
   * Return all projected features within the chunk containing distanceM and
   * the immediate neighbours — used by the cycling-glasses zone detector.
   */
  getNearbyFeatures(distanceM: number): ProjectedFeature[] {
    const chunk = Math.floor(distanceM / CHUNK_SIZE_M);
    const result: ProjectedFeature[] = [];
    for (let i = chunk - 1; i <= chunk + 1; i++) {
      const arr = this.featuresByChunk.get(i);
      if (arr) result.push(...arr);
    }
    return result;
  }

  private loadChunk(index: number) {
    const startDistM = index * CHUNK_SIZE_M;
    const endDistM = (index + 1) * CHUNK_SIZE_M;
    const gfx = this.scene.add.graphics();
    gfx.setDepth(15);
    // Warm additive window glows for this chunk's buildings (F2) — alpha follows
    // the night factor, so they light up after dusk.
    const lightsGfx = this.scene.add.graphics();
    lightsGfx.setDepth(16);
    lightsGfx.setBlendMode(Phaser.BlendModes.ADD);
    lightsGfx.setAlpha(nightLightAlpha(this.currentNightFactor));
    const objects: Phaser.GameObjects.GameObject[] = [];

    const chunkFeatures = this.featuresByChunk.get(index) || [];
    const h = this.scene.game.canvas.height;
    const baselineY = h * 0.75;
    const elevRange = Math.max(this.maxElevation - this.minElevation, 10);

    // Road surface first — it lies on the ground, everything else stands on it.
    this.renderRoadSpans(gfx, startDistM, endDistM);

    const chunkWaters: WaterFeaturePos[] = [];
    for (const f of chunkFeatures) {
      switch (f.type) {
        case 'building':
          this.renderBuilding(gfx, f, baselineY, elevRange, lightsGfx);
          break;
        case 'tree':
          this.renderTree(f, baselineY, elevRange, objects);
          break;
        case 'water': {
          const wp = this.renderWater(gfx, f, baselineY, elevRange);
          if (wp) chunkWaters.push(wp);
          break;
        }
        case 'waterway': {
          const wp = this.renderWaterway(gfx, f, baselineY, elevRange);
          if (wp) chunkWaters.push(wp);
          break;
        }
        case 'grass':
          this.renderGrass(gfx, f, baselineY, elevRange);
          break;
        case 'sand':
          this.renderSand(gfx, f, baselineY, elevRange);
          break;
        case 'urban':
          this.renderUrban(gfx, f, baselineY, elevRange);
          break;
        case 'aeroway':
          this.renderAeroway(gfx, f, baselineY, elevRange);
          break;
        case 'road':
          this.renderRoadLamp(gfx, f, baselineY, elevRange, objects);
          break;
      }
    }
    if (chunkWaters.length > 0) {
      this.waterByChunk.set(index, chunkWaters);
      this.waterDirty = true;
    }

    const chunk: TerrainChunk = { index, startDistM, endDistM, graphics: gfx, objects, lights: lightsGfx };
    this.chunks.set(index, chunk);
  }

  private unloadChunk(chunk: TerrainChunk) {
    chunk.graphics.destroy();
    chunk.lights?.destroy();
    for (const obj of chunk.objects) {
      obj.destroy();
    }
    if (this.waterByChunk.delete(chunk.index)) this.waterDirty = true;
  }

  /** Set the night factor (0 day → 1 night); fades every chunk's window glows.
   *  Called each frame from the renderer with (1 − dayFactor). */
  setNightFactor(f: number): void {
    if (Math.abs(f - this.currentNightFactor) < 0.002) return; // skip micro-updates
    this.currentNightFactor = f;
    const a = nightLightAlpha(f);
    for (const chunk of this.chunks.values()) {
      chunk.lights?.setAlpha(a);
    }
  }

  /** Render a building — delegates visual style to strategy. */
  private renderBuilding(
    gfx: Phaser.GameObjects.Graphics,
    feature: ProjectedFeature,
    baselineY: number,
    elevRange: number,
    lightsGfx: Phaser.GameObjects.Graphics,
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

    const bx = x - widthPx / 2;
    const by = groundY - heightPx;
    this.strategy.renderBuilding(gfx, bx, by, widthPx, heightPx, colorIndex, hash);

    // Warm window glows on the same grid the strategies use — a deterministic
    // ~40% are lit. Drawn into the additive night-lights layer (F2).
    const gap = 6, size = 2.4;
    for (let wy = by + 5; wy < by + heightPx - 4; wy += gap) {
      for (let wx = bx + 4; wx < bx + widthPx - 4; wx += gap) {
        const r = Math.sin(wx * 12.9898 + wy * 78.233) * 43758.5453;
        if (r - Math.floor(r) >= 0.42) continue;
        lightsGfx.fillStyle(0xffdd88, 0.9);
        lightsGfx.fillCircle(wx, wy, size);
      }
    }
  }

  /** Render a tree — its own Graphics so it can sway via rotation tween. */
  private renderTree(
    feature: ProjectedFeature,
    baselineY: number,
    elevRange: number,
    objects: Phaser.GameObjects.GameObject[],
  ) {
    const groundY = this.getGroundY(feature.distanceM, baselineY, elevRange);
    const x = feature.distanceM * PX_PER_METER;
    const seed = Math.abs(Math.round(x * 7)) % 100;

    const treeGfx = this.scene.add.graphics();
    treeGfx.setDepth(15);
    // Strategy draws relative to (0,0) — the tree base sits at the gfx origin
    // so rotating around (0,0) sways the canopy naturally.
    this.strategy.renderTree(treeGfx, 0, 0, 0, seed);
    treeGfx.setPosition(x, groundY);

    const swayAmp = 0.055 + (seed % 10) * 0.004; // ~3.2–5.3°
    const duration = 1800 + (seed % 80) * 30;    // 1.8–4.2s
    const delay = (seed * 67) % 1500;
    this.scene.tweens.add({
      targets: treeGfx,
      rotation: { from: -swayAmp, to: swayAmp },
      duration,
      delay,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.InOut',
    });

    objects.push(treeGfx);
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

  /** Render a street lamp — static parts on chunk gfx, glow on its own
   *  Graphics so it can pulse via an alpha tween. */
  private renderRoadLamp(
    gfx: Phaser.GameObjects.Graphics,
    feature: ProjectedFeature,
    baselineY: number,
    elevRange: number,
    objects: Phaser.GameObjects.GameObject[],
  ) {
    // Skip if too close to previous lamp
    if (feature.distanceM - this.lastLampDistM < TerrainChunkManager2D.LAMP_MIN_SPACING_M) return;
    this.lastLampDistM = feature.distanceM;

    const groundY = this.getGroundY(feature.distanceM, baselineY, elevRange);
    const x = feature.distanceM * PX_PER_METER;
    const seed = Math.abs(Math.round(x * 17)) % 100;

    this.strategy.renderRoadLamp(gfx, x, groundY, seed);

    const glowGfx = this.scene.add.graphics();
    glowGfx.setDepth(15);
    this.strategy.renderRoadLampGlow(glowGfx, 0, 0, seed);
    glowGfx.setPosition(x, groundY);

    const duration = 1500 + (seed % 70) * 25; // 1.5–3.2s
    const delay = (seed * 41) % 1200;
    this.scene.tweens.add({
      targets: glowGfx,
      alpha: { from: 0.55, to: 1.0 },
      duration,
      delay,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.InOut',
    });

    objects.push(glowGfx);
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

  /** Render sandy ground (landcover class=sand) — delegates to strategy. */
  private renderSand(
    gfx: Phaser.GameObjects.Graphics,
    feature: ProjectedFeature,
    baselineY: number,
    elevRange: number,
  ) {
    const groundY = this.getGroundY(feature.distanceM, baselineY, elevRange);
    const x = feature.distanceM * PX_PER_METER;
    const seed = Math.abs(Math.round(x * 19)) % 100;

    this.strategy.renderSand(gfx, x, groundY, 40, 5, seed);
  }

  /** Render built-up-area ground tint — delegates to strategy. */
  private renderUrban(
    gfx: Phaser.GameObjects.Graphics,
    feature: ProjectedFeature,
    baselineY: number,
    elevRange: number,
  ) {
    const groundY = this.getGroundY(feature.distanceM, baselineY, elevRange);
    const x = feature.distanceM * PX_PER_METER;
    const seed = Math.abs(Math.round(x * 23)) % 100;

    this.strategy.renderUrban(gfx, x, groundY, 60, 5, seed);
  }

  /** Render a linear watercourse (river/canal/stream) crossing the route.
   *  Width by class; joins the shimmer list like polygon water does. */
  private renderWaterway(
    gfx: Phaser.GameObjects.Graphics,
    feature: ProjectedFeature,
    baselineY: number,
    elevRange: number,
  ): WaterFeaturePos | null {
    const groundY = this.getGroundY(feature.distanceM, baselineY, elevRange);
    const x = feature.distanceM * PX_PER_METER;
    const h = this.scene.game.canvas.height;
    const seed = Math.abs(Math.round(x * 29)) % 100;

    const cls = feature.props.class || 'stream';
    const width = cls === 'river' ? 40 : cls === 'canal' ? 30 : 16;

    const result = this.strategy.renderWaterway(gfx, x, groundY, width, h - groundY, seed);
    if (!result) return null;
    return { x: result.x, groundY: result.y, width: result.w };
  }

  /** Render an airport runway/taxiway strip — delegates to strategy. */
  private renderAeroway(
    gfx: Phaser.GameObjects.Graphics,
    feature: ProjectedFeature,
    baselineY: number,
    elevRange: number,
  ) {
    const groundY = this.getGroundY(feature.distanceM, baselineY, elevRange);
    const x = feature.distanceM * PX_PER_METER;
    const seed = Math.abs(Math.round(x * 31)) % 100;

    const kind = feature.props.class === 'runway' ? 'runway' as const : 'taxiway' as const;
    this.strategy.renderAeroway(gfx, x, groundY, kind === 'runway' ? 90 : 40, kind, seed);
  }

  /** Sample interval (px) for road-surface points along the terrain. */
  private static readonly ROAD_SAMPLE_PX = 8;

  /** Draw the paved-road surface for every road span crossing this chunk. */
  private renderRoadSpans(
    gfx: Phaser.GameObjects.Graphics,
    startDistM: number,
    endDistM: number,
  ) {
    for (const span of this.roadSpans) {
      const s = Math.max(span.start, startDistM);
      const e = Math.min(span.end, endDistM);
      if (e <= s) continue;

      const points: { x: number; y: number }[] = [];
      const x0 = s * PX_PER_METER;
      const x1 = e * PX_PER_METER;
      for (let x = x0; x <= x1; x += TerrainChunkManager2D.ROAD_SAMPLE_PX) {
        points.push({ x, y: this.scene.getTerrainY(x / PX_PER_METER) });
      }
      if (points.length < 2) continue;

      const seed = Math.abs(Math.round(x0 * 7)) % 10000;
      this.strategy.renderRoadSurface(gfx, points, seed);
    }
  }

  /** Get ground Y position for a given route distance. Delegates to the host
   *  scene so chunks always sit on the same terrain surface as the scene's own
   *  drawTerrain — including any per-instance baseline override (Welcome). */
  private getGroundY(distanceM: number, _baselineY: number, _elevRange: number): number {
    return this.scene.getTerrainY(distanceM);
  }

  /** Get all currently loaded water feature positions (for shimmer animation).
   *  Returns a cached flat list, rebuilt only when chunks changed (waterDirty). */
  getWaterFeatures(): WaterFeaturePos[] {
    if (this.waterDirty) {
      this.waterFeaturesCache = [];
      for (const waters of this.waterByChunk.values()) {
        this.waterFeaturesCache.push(...waters);
      }
      this.waterDirty = false;
    }
    return this.waterFeaturesCache;
  }

  /**
   * Drop every loaded chunk so the next update() repaints them from scratch.
   * Needed whenever the ground line itself moves: chunk scenery bakes its Y
   * at load time, and the terrain baseline is a fraction of the canvas
   * height — after a resize the freshly-laid terrain and the stale chunks
   * disagree, and the trees float. Also the style-switch path.
   */
  reload() {
    for (const chunk of this.chunks.values()) {
      this.unloadChunk(chunk);
    }
    this.chunks.clear();
    this.waterByChunk.clear();
    this.waterDirty = true;
    this.lastLampDistM = -Infinity;
  }

  /**
   * Hot-swap the visual style strategy. Drops every loaded chunk so the next
   * update() repaints them with the new style. Used by the Welcome backdrop
   * when the user toggles plastic ↔ cuphead without rebuilding the scene.
   */
  setStrategy(newStrategy: PhaserStyleStrategy) {
    this.strategy = newStrategy;
    this.reload();
  }

  dispose() {
    for (const chunk of this.chunks.values()) {
      this.unloadChunk(chunk);
    }
    this.chunks.clear();
    this.waterByChunk.clear();
  }
}

/** Roads whose centroid is further than this from the route don't say much
 *  about the surface the rider is on — skip them when building spans. */
const ROAD_SPAN_MAX_OFFSET_M = 150;
/** Road features closer than this along the route merge into one span. */
const ROAD_SPAN_MERGE_GAP_M = 150;
/** Padding added to each end of a merged span. */
const ROAD_SPAN_PAD_M = 40;

/**
 * Merge nearby road features into continuous paved spans along the route.
 * The rider's GPX follows roads, but remote trail sections have no
 * `transportation` features nearby — those gaps stay unpaved, which is
 * exactly the contrast the road surface is there to show.
 */
export function buildRoadSpans(
  features: ProjectedFeature[],
): { start: number; end: number }[] {
  const dists = features
    .filter((f) => f.type === 'road' && f.offsetM <= ROAD_SPAN_MAX_OFFSET_M)
    .map((f) => f.distanceM)
    .sort((a, b) => a - b);
  if (dists.length === 0) return [];

  const spans: { start: number; end: number }[] = [];
  let start = dists[0];
  let prev = dists[0];
  for (let i = 1; i < dists.length; i++) {
    if (dists[i] - prev > ROAD_SPAN_MERGE_GAP_M) {
      spans.push({ start: Math.max(0, start - ROAD_SPAN_PAD_M), end: prev + ROAD_SPAN_PAD_M });
      start = dists[i];
    }
    prev = dists[i];
  }
  spans.push({ start: Math.max(0, start - ROAD_SPAN_PAD_M), end: prev + ROAD_SPAN_PAD_M });
  return spans;
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
