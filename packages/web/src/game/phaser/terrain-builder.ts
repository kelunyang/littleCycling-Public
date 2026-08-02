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
import { computeRouteBounds } from '@/game/terrain/mvt-projection';
import { zoneFromLanduseClass, type ZoneKind } from '@/game/terrain/land-zone';
import type { SignVocabulary } from '@/game/terrain/sign-spec';
import { PX_PER_METER, type Phaser2DScene } from './phaser2d-scene';
import type { PhaserStyleStrategy } from './phaser-style-strategy';
import { nightLightAlpha } from './night-grade';
import { buildZoneBands } from './zone-bands';

// Re-exported so a consumer that already imports the chunk manager does not need
// to know the arithmetic moved out of here (it moved because Phaser cannot be
// loaded in Node, and the districts had to stay checkable — see zone-bands.ts).
export type { ZoneBand } from './zone-bands';
export { buildZoneBands } from './zone-bands';

// Re-export ProjectedFeature so existing consumers don't need to change imports
export type { ProjectedFeature } from '@/game/terrain/mvt-projection';
import type { ProjectedFeature } from '@/game/terrain/mvt-projection';

/** Sampling interval for elevation profile (meters). */
const ELEVATION_SAMPLE_INTERVAL = 5;

// `nightLightAlpha` used to live here, module-private, which forced the
// headless probe to hand-copy it. It now shares `duskRamp` with the night veil
// in night-grade.ts — the windows lighting up and the world darkening have to
// happen over the SAME window, and two copies of a curve is how they drift.

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

  /** Which shelf this ride's shop signs draw from — see the `vocabulary`
   *  argument on `PhaserStyleStrategy.renderBuilding`. Deliberately `readonly`
   *  with no setter, exactly like the 3D `TerrainChunkManager.signVocabulary`:
   *  the answer is fixed before the first chunk builds, and a chunk already on
   *  screen is not rebuilt, so a mid-ride change would only reach the chunks
   *  ahead and the street would say two different things at once. */
  private readonly signVocabulary: SignVocabulary;

  constructor(
    scene: Phaser2DScene,
    elevationProfile: ElevationSample[],
    features: ProjectedFeature[],
    strategy: PhaserStyleStrategy,
    /** Omitted = `'shop'`, which is what the Welcome backdrop and every free
     *  ride want. `usePhaserRenderer` passes the ride's answer. */
    signVocabulary: SignVocabulary = 'shop',
  ) {
    this.scene = scene;
    this.strategy = strategy;
    this.signVocabulary = signVocabulary;
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
    // Pushed rather than returned: the districts belong to the WHOLE route, not
    // to a chunk, and this is the only object that holds the projected features.
    // Doing it here also means no renderer call site has to learn about zoning —
    // the scene just finds itself with a zoned board.
    this.scene.setZoneBands(buildZoneBands(features));
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
    // The veil must not dim the lights: hand this layer to the scene's
    // pipeline-free lights camera so it composites ABOVE the night veil
    // (option D, plan/phaser-2d-lighting.md). No-op in welcome mode, which
    // has no veil.
    this.scene.adoptNightLights(lightsGfx);
    const objects: Phaser.GameObjects.GameObject[] = [];

    const chunkFeatures = this.featuresByChunk.get(index) || [];
    const h = this.scene.game.canvas.height;
    const baselineY = h * 0.75;
    const elevRange = Math.max(this.maxElevation - this.minElevation, 10);

    // Road surface first — it lies on the ground, everything else stands on it.
    this.renderRoadSpans(gfx, startDistM, endDistM);

    // Every thin upright in this chunk, so a shop sign can step sideways out
    // from behind one (`renderBuilding`'s `posts`). Gathered BEFORE the draw
    // loop because a sign has to know about the lamp two metres to its right
    // that has not been drawn yet — and gathered read-only, because the demos'
    // rule is that the sign moves and nothing else does.
    //
    // Lamps are collected before `renderRoadLamp`'s minimum-spacing filter has
    // run (that filter carries state across chunks and cannot be replayed here),
    // so the list is a superset: a sign may occasionally dodge a lamp that was
    // skipped. The cost of that is a sign a few px off centre.
    const posts: number[] = [];
    for (const f of chunkFeatures) {
      if (f.type === 'road' || f.type === 'tree') posts.push(f.distanceM * PX_PER_METER);
    }

    const chunkWaters: WaterFeaturePos[] = [];
    for (const f of chunkFeatures) {
      switch (f.type) {
        case 'building':
          this.renderBuilding(gfx, f, baselineY, elevRange, lightsGfx, posts);
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
    posts: readonly number[],
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
    // The land-use district this footprint stands in, resolved in the worker
    // (see mvt-zone-worker.ts — the polygon rings never cross the postMessage).
    // `undefined` is what a feature built by hand carries: the Welcome backdrop
    // fabricates ProjectedFeatures with no map under them. It must land as
    // UNZONED, not residential — outside every landuse polygon is most of a real
    // route, and reading that as housing turns a country road into a suburb.
    const zone = (feature.props.zone as ZoneKind | null | undefined) ?? null;
    const drawn = this.strategy.renderBuilding(
      gfx, bx, by, widthPx, heightPx, colorIndex, hash, zone, posts, this.signVocabulary);

    // ── Night lights ──
    // Ask the STYLE first, exactly the way the 3D `building-renderer` does.
    // DEVPLAN's rule is that whatever decided the shape decides the lights, and
    // the grid below cannot: it divides a bounding box into rows and columns and
    // stamps the same little dot onto an eraser, an abacus and a domino wall
    // alike. Declaring the hook and drawing nothing is a real answer ("this
    // building has no lights"); only OMITTING it falls through to the grid.
    if (this.strategy.renderBuildingLights) {
      this.strategy.renderBuildingLights(
        lightsGfx, bx, by, widthPx, heightPx, colorIndex, hash, zone);
      return;
    }

    // The fallback grid, for a style that has not declared its lights yet.
    //
    // Laid over what `renderBuilding` REPORTED it drew, not over the nominal
    // box (`plan/migrate-demo-worlds.md` §3.8). Styles reshape their box —
    // snapping it up to a grid, or deliberately staying low and spreading wide —
    // and a grid computed from the nominal box puts a short building's glows in
    // the sky above it. A style that reports nothing gets the nominal box, which
    // is what this always used.
    //
    // Warm glows, a deterministic ~40% lit. Cost is linear in the HEIGHT, which
    // is why a themed body should never be on this path: a 125 m tower is ~120
    // additive circles for one building.
    const ex = drawn ? drawn.x : bx;
    const ey = drawn ? drawn.y : by;
    const ew = drawn ? drawn.w : widthPx;
    const eh = drawn ? drawn.h : heightPx;
    const gap = 6, size = 2.4;
    lightsGfx.fillStyle(0xffdd88, 0.9);
    for (let wy = ey + 5; wy < ey + eh - 4; wy += gap) {
      for (let wx = ex + 4; wx < ex + ew - 4; wx += gap) {
        const r = Math.sin(wx * 12.9898 + wy * 78.233) * 43758.5453;
        if (r - Math.floor(r) >= 0.42) continue;
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
    // The lamp's glow takes the same route past the night veil as the chunk
    // window lights (option D): both 2D demos composite it there — plastic
    // draws the bubble's shine on the glow layer (depth 40) over the veil
    // (30, "夜幕壓在 depth 30,會亮的東西要畫在 glow 層(40)"), handdrawn on
    // glowGfx 885 over 880. Unlike the window layer this one is visible by
    // DAY too (always-on pulse), so it also rides above the lens tint and
    // barrel distortion in daylight — the demos swap layers at nightfall
    // instead, but a per-dusk camera swap buys back only a few px of
    // distortion at the frame's corners. No-op in welcome mode (no veil).
    this.scene.adoptNightLights(glowGfx);
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

  /** Render built-up-area ground tint — delegates to strategy.
   *
   *  The district comes straight off the polygon's own landuse class, not from
   *  the `ZoneIndex` the buildings use: an `urban` feature IS a landuse polygon,
   *  so asking the index which polygon it is inside would be asking it about
   *  itself. `zoneFromLanduseClass` is the same function the worker builds the
   *  index with, so the band and the buildings standing on it can never disagree
   *  about what district this is. */
  private renderUrban(
    gfx: Phaser.GameObjects.Graphics,
    feature: ProjectedFeature,
    baselineY: number,
    elevRange: number,
  ) {
    const groundY = this.getGroundY(feature.distanceM, baselineY, elevRange);
    const x = feature.distanceM * PX_PER_METER;
    const seed = Math.abs(Math.round(x * 23)) % 100;
    const zone = zoneFromLanduseClass(feature.props.class as string | undefined);

    this.strategy.renderUrban(gfx, x, groundY, 60, 5, seed, zone);
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
 * Fetch MVT features along a route, project them to 2D, and tag every building
 * with its land-use zone. Runs in a Web Worker to avoid blocking the main
 * thread. Returns ProjectedFeature[] sorted by distance.
 *
 * The worker is `./mvt-zone-worker.ts`, not the shared
 * `terrain/mvt-worker-client.fetchFeaturesInWorker` this used to call: the
 * zoning has to happen on the far side of the postMessage, because the landuse
 * polygon rings it needs do not survive the trip. That file's header has the
 * full argument.
 */
export async function fetchAndProjectFeatures(
  points: RoutePoint[],
  cumulativeDists: number[],
): Promise<ProjectedFeature[]> {
  if (points.length < 2) return [];
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./mvt-zone-worker.ts', import.meta.url),
      { type: 'module' },
    );
    const bounds = computeRouteBounds(points);
    // Strip Vue reactivity — Proxy objects are not structured-cloneable.
    const plainPoints = points.map((p) => ({ lat: p.lat, lon: p.lon, ele: p.ele }));
    worker.postMessage({ points: plainPoints, cumulativeDists: [...cumulativeDists], bounds });
    worker.onmessage = (e) => {
      if (e.data.ok) resolve(e.data.features);
      else reject(new Error(e.data.error));
      worker.terminate();
    };
    worker.onerror = (e) => {
      reject(e);
      worker.terminate();
    };
  });
}
