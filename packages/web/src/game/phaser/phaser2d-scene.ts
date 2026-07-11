/**
 * Phaser 2D side-scrolling scene.
 *
 * Mario/Contra-style: cyclist rides left-to-right, terrain scrolls,
 * camera tracks the rider at ~30% from the left edge.
 *
 * The scene reads state from the PhaserBridge (written by Vue each frame)
 * and updates all visual elements accordingly.
 *
 * Performance notes:
 * - Sky rendering is handled by PhaserWeatherSystem (not here)
 * - CRT overlay is drawn once in create() (static)
 * - Terrain uses a dirty flag to skip redraws when camera hasn't moved
 */

import Phaser from 'phaser';
import type { WaterFeaturePos } from './terrain-builder';
import { lerpColor } from './phaser-weather';
import type { PhaserStyleStrategy } from './phaser-style-strategy';
import {
  CyclingGlassesPipeline,
  CYCLING_GLASSES_PIPELINE_KEY,
  type GlassesLens,
  type WeatherType as GlassesWeatherType,
  type ZoneType as GlassesZoneType,
} from './cycling-glasses-pipeline';
import {
  TunnelVisionPipeline,
  TUNNEL_VISION_PIPELINE_KEY,
  computeTunnelIntensity,
} from './tunnel-vision-pipeline';
import { PhaserLensMarksManager, type MarkType } from './phaser-lens-marks-manager';

/** Plain JS object for Vue ↔ Phaser per-frame communication. */
export interface PhaserBridge {
  distanceM: number;
  elevationM: number;
  speedKmh: number;
  cadenceRpm: number;
  isDarkened: boolean;
  bearing: number;
  weather: string;         // sunny | cloudy | rainy | snowy
  sunElevation: number;    // degrees (-90..90)
  moonPhase: number;       // 0..1
}

/** Pixels per meter for the 2D world. */
export const PX_PER_METER = 3;

/** Minimum sky headroom (px) kept above the highest terrain point. */
const TERRAIN_TOP_MARGIN_PX = 140;

/** Vertical exaggeration factor for elevation. */
export const ELEVATION_EXAGGERATION = 4;

/** Cyclist screen position as fraction of viewport width from left.
 * 0.5 keeps the rider perfectly centered horizontally so the world scrolls
 * symmetrically on both sides as they pedal. */
const CYCLIST_SCREEN_X = 0.5;

/** Ground baseline Y position (pixels from top) — terrain is drawn relative to this. */
export const GROUND_BASELINE_Y = 0.75; // 75% down from top

export type PhaserSceneMode = 'game' | 'welcome';

export class Phaser2DScene extends Phaser.Scene {
  private bridge: PhaserBridge;
  private strategy: PhaserStyleStrategy;
  private mode: PhaserSceneMode;
  /** Override of GROUND_BASELINE_Y for this scene instance. Game mode uses
   *  the default 0.75; Welcome lowers it (~0.90) so the green ground band
   *  takes only 10–20 % of screen height instead of ~25 %. */
  private groundBaselineFraction: number = GROUND_BASELINE_Y;

  // Promise that resolves when create() finishes — await before using scene objects
  private _readyResolve!: () => void;
  readonly ready = new Promise<void>((r) => { this._readyResolve = r; });

  // Graphics layers (initialized in create())
  private terrainGfx!: Phaser.GameObjects.Graphics;
  private overlayObj!: Phaser.GameObjects.GameObject | null;
  private markerGfx!: Phaser.GameObjects.Graphics;

  // Independent layers — route line/markers (with Bloom) and text labels stay
  // off the main display list so they can be styled & filtered separately.
  private routeLayer!: Phaser.GameObjects.Layer;
  private textLayer!: Phaser.GameObjects.Layer;

  // Cycling-glasses post-processing
  private glassesPipeline: CyclingGlassesPipeline | null = null;
  private tunnelPipeline: TunnelVisionPipeline | null = null;
  private lensMarks: PhaserLensMarksManager | null = null;
  private markAccumulator = 0;
  private currentMarksWeather: GlassesWeatherType = 'sunny';
  private currentZone: GlassesZoneType = 'open';

  // Speed/wind particle emitter (driven by ride speed, not weather wind)
  private windEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;

  // Environmental wind magnitude (0..2) — drives lens-mark spawn rate
  private windMagnitude = 0;

  // Water shimmer
  private waterShimmerGfx!: Phaser.GameObjects.Graphics;
  private waterShimmerFrame = 0;
  private waterFeatures: WaterFeaturePos[] = [];

  // Terrain data (set externally after scene is ready)
  private elevationProfile: { distM: number; eleM: number }[] = [];
  private minElevation = 0;
  private maxElevation = 100;

  // World dimensions
  private totalRouteDistPx = 0;
  private totalRouteDistM = 0;

  // Dirty flag — skip terrain redraw when camera hasn't moved
  private lastTerrainScrollX = NaN;

  // Zone color filter overlay
  private zoneFilterGfx!: Phaser.GameObjects.Graphics;
  private currentZoneColor = 0;
  private targetZoneColor = 0;
  private zoneFilterAlpha = 0;
  private targetZoneAlpha = 0;

  // Overlay frame counter (for animated overlays like film grain)
  private overlayFrameCount = 0;

  constructor(bridge: PhaserBridge, strategy: PhaserStyleStrategy, mode: PhaserSceneMode = 'game') {
    super({ key: 'Phaser2DScene' });
    this.bridge = bridge;
    this.strategy = strategy;
    this.mode = mode;
  }

  create() {
    // Terrain graphics — scrolls with the world
    this.terrainGfx = this.add.graphics();

    // Route layer holds anything that should glow (distance markers, flags) —
    // a Bloom FX is attached to the layer so its contents render with neon edges.
    this.routeLayer = this.add.layer();
    this.routeLayer.setDepth(60);

    // Text layer holds in-world text (km labels, START/FINISH) so it stays on
    // its own display list, separate from the bloomed route geometry.
    this.textLayer = this.add.layer();
    this.textLayer.setDepth(70);

    // Distance markers — scrolls with the world; lives inside the route layer.
    this.markerGfx = this.add.graphics();
    this.markerGfx.setDepth(50);
    this.routeLayer.add(this.markerGfx);

    // Apply Bloom FX to the route layer so markers/flags get a soft glow.
    // (color, offsetX, offsetY, blurStrength, strength, steps)
    if (this.routeLayer.postFX) {
      this.routeLayer.postFX.addBloom(0xffffff, 1, 1, 1, 1.2, 4);
    }

    // Water shimmer layer — above terrain features
    this.waterShimmerGfx = this.add.graphics();
    this.waterShimmerGfx.setDepth(16);

    // Zone color filter — semi-transparent fullscreen overlay
    this.zoneFilterGfx = this.add.graphics();
    this.zoneFilterGfx.setScrollFactor(0);
    this.zoneFilterGfx.setDepth(950);

    // Style-specific overlay (CRT scanlines for plastic, film grain for cuphead, etc.)
    this.overlayObj = this.strategy.drawOverlay(this);

    // ── Cycling-glasses post-processing (game mode only) ──
    // Welcome backdrop reuses this scene but per the design rule must NOT
    // apply the glasses/tunnel PostFX overlays.
    if (this.mode === 'game') {
      // Lens marks first (canvas → Phaser CanvasTexture), then attach pipelines
      // to the main camera so the whole canvas renders through the glasses.
      this.lensMarks = new PhaserLensMarksManager(this);

      this.cameras.main.setPostPipeline([CYCLING_GLASSES_PIPELINE_KEY, TUNNEL_VISION_PIPELINE_KEY]);
      const glasses = this.cameras.main.getPostPipeline(CYCLING_GLASSES_PIPELINE_KEY);
      const tunnel = this.cameras.main.getPostPipeline(TUNNEL_VISION_PIPELINE_KEY);
      this.glassesPipeline = (Array.isArray(glasses) ? glasses[0] : glasses) as CyclingGlassesPipeline;
      this.tunnelPipeline = (Array.isArray(tunnel) ? tunnel[0] : tunnel) as TunnelVisionPipeline;
      if (this.glassesPipeline && this.lensMarks) {
        // Looked up lazily — Phaser may allocate the canvas's GL texture on first
        // upload, after this scene.create() runs.
        const marks = this.lensMarks;
        this.glassesPipeline.setMarksTextureSource(() => marks.glTexture);
      }
    }

    // Speed/wind particle emitter
    const windColor = this.strategy.getWindParticleColor();
    const windKey = '__wind_particle__';
    if (!this.textures.exists(windKey)) {
      const c = document.createElement('canvas');
      c.width = 2;
      c.height = 1;
      const ctx = c.getContext('2d')!;
      const r = (windColor >> 16) & 0xff;
      const g = (windColor >> 8) & 0xff;
      const b = windColor & 0xff;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, 0, 2, 1);
      this.textures.addCanvas(windKey, c);
    }
    const initH = Number(this.game.config.height);
    this.windEmitter = this.add.particles(0, 0, windKey, {
      x: { min: 0, max: Number(this.game.config.width) + 100 },
      y: { min: 0, max: initH },
      speedX: { min: -400, max: -200 },
      speedY: 0,
      lifespan: 800,
      frequency: 80,
      quantity: 1,
      alpha: { start: this.strategy.getWindParticleAlpha(), end: 0 },
      scaleX: { min: 3, max: 8 },
      active: false,
    });
    this.windEmitter.setScrollFactor(0);
    this.windEmitter.setDepth(450);

    // Signal that the scene is ready for external use
    this._readyResolve();
  }

  /**
   * Load the elevation profile for terrain rendering.
   * Called by usePhaserRenderer after init.
   */
  setElevationProfile(profile: { distM: number; eleM: number }[]) {
    this.elevationProfile = profile;
    if (profile.length > 0) {
      this.minElevation = Math.min(...profile.map((p) => p.eleM));
      this.maxElevation = Math.max(...profile.map((p) => p.eleM));
      this.totalRouteDistM = profile[profile.length - 1].distM;
      this.totalRouteDistPx = this.totalRouteDistM * PX_PER_METER;

      // Draw static markers (flags, distance ticks) — game mode only.
      // Welcome backdrop runs on a synthetic profile and skips km labels.
      if (this.mode === 'game') {
        this.drawStaticMarkers();
      }
    }
  }

  /** Update water feature positions for shimmer animation. */
  setWaterFeatures(features: WaterFeaturePos[]) {
    this.waterFeatures = features;
  }

  /**
   * Called every frame by Phaser (driven externally via tick()).
   */
  update(_time: number, _delta: number) {
    const dtSec = _delta / 1000;
    const { distanceM } = this.bridge;
    const w = this.game.canvas.width;
    const h = this.game.canvas.height;

    // ── Camera: follow cyclist ──
    const worldX = distanceM * PX_PER_METER;
    this.cameras.main.scrollX = worldX - w * CYCLIST_SCREEN_X;

    // ── Terrain (only redraw when camera moves) ──
    const scrollX = this.cameras.main.scrollX;
    if (Math.abs(scrollX - this.lastTerrainScrollX) >= 1 || Number.isNaN(this.lastTerrainScrollX)) {
      this.lastTerrainScrollX = scrollX;
      this.drawTerrain(w, h);
    }

    // ── Speed/wind particles ──
    const speed = this.bridge.speedKmh;
    if (speed < 10) {
      this.windEmitter.active = false;
    } else {
      this.windEmitter.active = true;
      this.windEmitter.frequency = Math.max(10, 80 - speed);
      this.windEmitter.speedX = { min: -(speed * 15 + 200), max: -(speed * 10 + 100) } as any;
    }

    // ── Water shimmer (every 3 frames) ──
    this.waterShimmerFrame++;
    if (this.waterShimmerFrame % 3 === 0) {
      this.drawWaterShimmer();
    }

    // ── Zone color filter (smooth lerp) ──
    this.updateZoneFilter(w, h);

    // ── Overlay animation (film grain shift etc.) ──
    this.overlayFrameCount++;
    this.strategy.updateOverlay?.(this.overlayFrameCount);

    // ── Cycling-glasses post-processing tick ──
    this.tickGlasses(dtSec);
  }

  /**
   * Drive lens-mark spawning, mark fade, and pipeline transition lerps.
   * Mark spawning is weather + zone driven (mirrors useTerrainRenderer behaviour).
   */
  private tickGlasses(dt: number) {
    if (!this.lensMarks || !this.glassesPipeline) return;

    // Weather-driven marks (rain/snow) at fixed rate.
    this.markAccumulator += dt;
    const rate = this.getMarkSpawnRate(this.currentMarksWeather);
    while (rate.interval > 0 && this.markAccumulator >= rate.interval) {
      this.markAccumulator -= rate.interval;
      if (Math.random() < rate.chance) {
        this.lensMarks.addMark(rate.type);
      }
    }

    // Zone-driven ambient marks. Wind boosts dust/leaf spawn (1× .. 2×).
    const windFactor = 1 + this.windMagnitude * 0.5;
    if (this.currentZone === 'forest') {
      if (Math.random() < dt * 0.25 * windFactor) this.lensMarks.addMark('leaf');
    } else if (this.currentZone === 'open') {
      if (Math.random() < dt * 0.08 * windFactor) this.lensMarks.addMark('leaf');
      if (Math.random() < dt * 0.15 * windFactor) this.lensMarks.addMark('dust');
    } else {
      if (Math.random() < dt * 0.3 * windFactor) this.lensMarks.addMark('dust');
    }

    this.lensMarks.update(dt);
    this.glassesPipeline.tick(dt);
  }

  private getMarkSpawnRate(weather: GlassesWeatherType): { type: MarkType; interval: number; chance: number } {
    switch (weather) {
      case 'rainy': return { type: 'rain', interval: 0.3, chance: 0.8 };
      case 'snowy': return { type: 'snow', interval: 0.6, chance: 0.7 };
      default: return { type: 'dust', interval: 0, chance: 0 };
    }
  }

  // ── Public glasses API (called from usePhaserRenderer) ──

  setLens(lens: GlassesLens) {
    this.glassesPipeline?.setLens(lens);
  }

  setMarksWeather(weather: GlassesWeatherType) {
    this.currentMarksWeather = weather;
    this.glassesPipeline?.setWeather(weather);
  }

  /** Set wind magnitude (0..2). Drives leaf/dust lens-mark spawn rate. */
  setWindMagnitude(mag: number) {
    this.windMagnitude = Math.max(0, Math.min(2, mag));
  }

  /** Trigger a brief camera flash to accompany a lightning strike. */
  triggerLightningFlash() {
    // Phaser camera flash: 180ms slight white fade, on top of the bolt graphic.
    this.cameras.main.flash(180, 220, 230, 255, true);
  }

  triggerCoinGlow() {
    this.glassesPipeline?.triggerCoinGlow();
    this.lensMarks?.addMark('coin');
  }

  addLensMark(type: MarkType) {
    this.lensMarks?.addMark(type);
  }

  updatePhysiology(hrZone: number | null, speedKmh: number) {
    if (!this.tunnelPipeline) return;
    const intensity = computeTunnelIntensity(hrZone, speedKmh);
    this.tunnelPipeline.setIntensity(intensity);
  }

  setEnvironmentZone(zone: GlassesZoneType) {
    if (this.currentZone === zone) return;
    this.currentZone = zone;
    this.glassesPipeline?.setZone(zone);
  }

  /**
   * Set the zone color overlay. Pass null to clear.
   * Color transitions smoothly via lerp.
   */
  setZoneColor(color: number | null, alpha = 0.10) {
    if (color === null) {
      this.targetZoneAlpha = 0;
    } else {
      this.targetZoneColor = color;
      this.targetZoneAlpha = alpha;
    }
  }

  /**
   * Draw workout segment flags at the specified distances.
   */
  drawWorkoutFlags(segments: { distM: number; color: number; label: string }[]) {
    for (const seg of segments) {
      this.drawFlag(seg.distM, seg.color, seg.label);
    }
  }

  /** Smoothly transition zone filter overlay. */
  private updateZoneFilter(w: number, h: number) {
    // Lerp alpha
    const lerpRate = 0.08;
    this.zoneFilterAlpha += (this.targetZoneAlpha - this.zoneFilterAlpha) * lerpRate;

    // Lerp color
    if (this.targetZoneAlpha > 0 && this.currentZoneColor !== this.targetZoneColor) {
      this.currentZoneColor = lerpColor(this.currentZoneColor, this.targetZoneColor, lerpRate * 2);
    }

    this.zoneFilterGfx.clear();
    if (this.zoneFilterAlpha < 0.005) return;

    this.zoneFilterGfx.fillStyle(this.currentZoneColor, this.zoneFilterAlpha);
    this.zoneFilterGfx.fillRect(0, 0, w, h);
  }

  /** Draw animated shimmer highlights on water surfaces. */
  private drawWaterShimmer() {
    this.waterShimmerGfx.clear();
    if (this.waterFeatures.length === 0) return;

    const camLeft = this.cameras.main.scrollX - 50;
    const camRight = camLeft + this.game.canvas.width + 100;
    const time = this.waterShimmerFrame * 0.15;

    for (const wf of this.waterFeatures) {
      // Skip off-screen water
      if (wf.x + wf.width / 2 < camLeft || wf.x - wf.width / 2 > camRight) continue;

      // Draw 2-3 sine wave highlight lines
      this.waterShimmerGfx.lineStyle(1, this.strategy.palette.waterOutline, 0.4);
      for (let i = 0; i < 3; i++) {
        this.waterShimmerGfx.beginPath();
        const lineY = wf.groundY + 3 + i * 5;
        const startX = wf.x - wf.width / 2;
        const endX = wf.x + wf.width / 2;
        this.waterShimmerGfx.moveTo(startX, lineY);
        for (let sx = startX + 4; sx <= endX; sx += 4) {
          const dy = Math.sin((sx * 0.15) + time + i * 2) * 1.5;
          this.waterShimmerGfx.lineTo(sx, lineY + dy);
        }
        this.waterShimmerGfx.strokePath();
      }
    }
  }

  /**
   * Pixel span used to draw the full elevation range.
   *
   * The historical scale (baselineY·0.6·EXAGGERATION, halved for >500 m
   * ranges) can exceed the viewport: a route riding near its own high point
   * (e.g. one that STARTS at its summit) put the surface — and the cyclist
   * on it — hundreds of px above the screen top, leaving only the terrain
   * fill visible as a wall of paper. Clamp to the headroom that actually
   * exists between the baseline and the top margin so the surface always
   * stays on screen.
   */
  private eleScalePx(baselineY: number): number {
    const elevRange = Math.max(this.maxElevation - this.minElevation, 10);
    const desired = (baselineY * 0.6) * ELEVATION_EXAGGERATION / (elevRange > 500 ? 2 : 1);
    return Math.min(desired, Math.max(baselineY - TERRAIN_TOP_MARGIN_PX, 0));
  }

  /** Map elevation → scene Y. Single source of truth shared by the terrain
   *  surface, markers, coins and the cyclist so they always agree. */
  eleToY(eleM: number, baselineY: number): number {
    const elevRange = Math.max(this.maxElevation - this.minElevation, 10);
    const normalizedEle = (eleM - this.minElevation) / elevRange;
    return baselineY - normalizedEle * this.eleScalePx(baselineY);
  }

  /** Draw terrain from elevation profile — delegates visual style to strategy. */
  private drawTerrain(w: number, h: number) {
    this.terrainGfx.clear();

    if (this.elevationProfile.length < 2) return;

    const baselineY = h * this.groundBaselineFraction;

    // Determine visible range in world X
    const camLeft = this.cameras.main.scrollX;
    const camRight = camLeft + w;
    const margin = 50;
    const visLeft = camLeft - margin;
    const visRight = camRight + margin;

    // Build point array for the visible terrain surface
    const points: { x: number; y: number }[] = [];
    for (const pt of this.elevationProfile) {
      const x = pt.distM * PX_PER_METER;
      if (x < visLeft) continue;
      points.push({ x, y: this.eleToY(pt.eleM, baselineY) });
      if (x > visRight) break;
    }

    if (points.length === 0) return;

    // Seed from camera position for deterministic wobble in hand-drawn styles
    const seed = Math.abs(Math.round(camLeft * 0.1)) % 10000;

    this.strategy.drawTerrainSurface(this.terrainGfx, points, h, seed);
  }

  /**
   * Get the terrain surface Y coordinate for a given route distance.
   */
  getTerrainY(distanceM: number): number {
    const h = this.game.canvas.height;
    const baselineY = h * this.groundBaselineFraction;

    if (this.elevationProfile.length < 2) return baselineY;

    let lo = 0;
    let hi = this.elevationProfile.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.elevationProfile[mid].distM <= distanceM) lo = mid;
      else hi = mid;
    }

    const p0 = this.elevationProfile[lo];
    const p1 = this.elevationProfile[hi];
    const segLen = p1.distM - p0.distM;
    const t = segLen > 0 ? (distanceM - p0.distM) / segLen : 0;
    const ele = p0.eleM + (p1.eleM - p0.eleM) * Math.max(0, Math.min(1, t));

    return this.eleToY(ele, baselineY);
  }

  /**
   * Get the terrain surface slope (degrees) at a given distance.
   */
  getTerrainSlope(distanceM: number): number {
    if (this.elevationProfile.length < 2) return 0;

    let lo = 0;
    let hi = this.elevationProfile.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this.elevationProfile[mid].distM <= distanceM) lo = mid;
      else hi = mid;
    }

    const p0 = this.elevationProfile[lo];
    const p1 = this.elevationProfile[hi];
    const dx = (p1.distM - p0.distM) * PX_PER_METER;
    const dy = (p1.eleM - p0.eleM) * ELEVATION_EXAGGERATION;
    if (dx === 0) return 0;
    return Math.atan2(-dy, dx) * (180 / Math.PI);
  }

  // ── Visual polish ──

  /** Draw static markers: start/finish flags, distance ticks. */
  private drawStaticMarkers() {
    this.markerGfx.clear();
    if (this.elevationProfile.length < 2) return;

    const markerColor = this.strategy.palette.markerTick;
    const markerFont = this.strategy.getMarkerFont();
    const markerHex = `#${markerColor.toString(16).padStart(6, '0')}`;

    const tickInterval = this.totalRouteDistM > 10000 ? 1000 : 500;
    for (let d = tickInterval; d < this.totalRouteDistM; d += tickInterval) {
      const x = d * PX_PER_METER;
      const groundY = this.getTerrainY(d);
      const isKm = d % 1000 === 0;

      this.markerGfx.lineStyle(isKm ? 2 : 1, markerColor, isKm ? 0.5 : 0.25);
      this.markerGfx.lineBetween(x, groundY, x, groundY - (isKm ? 20 : 10));

      if (isKm) {
        const label = this.add.text(x, groundY - 25, `${d / 1000}km`, {
          fontSize: '9px',
          color: markerHex,
          fontFamily: markerFont,
          align: 'center',
        });
        label.setOrigin(0.5, 1);
        label.setAlpha(0.6);
        label.setDepth(50);
        this.textLayer.add(label);
      }
    }

    this.drawFlag(0, 0x76ff03, 'START');
    this.drawFlag(this.totalRouteDistM, 0xff3366, 'FINISH');
  }

  /** Draw a flag at a given route distance — delegates to strategy. */
  private drawFlag(distM: number, color: number, label: string) {
    const x = distM * PX_PER_METER;
    const groundY = this.getTerrainY(distM);
    const seed = Math.abs(Math.round(distM * 7)) % 10000;

    this.strategy.drawFlag(this.markerGfx, x, groundY, color, label, seed);

    // Label text above the flag
    const markerFont = this.strategy.getMarkerFont();
    const text = this.add.text(x + 10, groundY - 50, label, {
      fontSize: '8px',
      color: `#${color.toString(16).padStart(6, '0')}`,
      fontFamily: markerFont,
      fontStyle: 'bold',
    });
    text.setOrigin(0.5, 1);
    text.setDepth(50);
    this.textLayer.add(text);
  }

  /** Move the ground/sky boundary. Welcome lowers this so the visible green
   *  ground band shrinks to 10–20 % of canvas height; game mode keeps the
   *  default 0.75. Triggers a terrain redraw on the next frame. */
  setGroundBaselineFraction(fraction: number) {
    this.groundBaselineFraction = Math.max(0.5, Math.min(0.95, fraction));
    this.lastTerrainScrollX = NaN;
  }

  /** Read by PhaserWeatherSystem and TerrainChunkManager2D so sky/parallax
   *  and scenery features all stay vertically aligned with the terrain. */
  getGroundBaselineFraction(): number {
    return this.groundBaselineFraction;
  }

  /** Handle resize — recreate overlay and reset terrain dirty flag. */
  onResize(w: number, h: number) {
    // Destroy old overlay and recreate via strategy
    if (this.overlayObj) {
      this.overlayObj.destroy();
    }
    this.overlayObj = this.strategy.drawOverlay(this);
    this.lastTerrainScrollX = NaN;
  }

  /**
   * Hot-swap the visual style strategy without rebuilding the Phaser game.
   * Rebuilds overlay + wind emitter (whose colors depend on the strategy)
   * and forces a terrain redraw on the next frame.
   *
   * Cyclist sprite textures are managed by cyclist-sprite.ts — caller must
   * separately invoke rebuildCyclistTextures() to refresh them.
   */
  setStrategy(newStrategy: PhaserStyleStrategy) {
    this.strategy = newStrategy;

    // Rebuild overlay (CRT scanlines / film grain)
    if (this.overlayObj) {
      this.overlayObj.destroy();
    }
    this.overlayObj = this.strategy.drawOverlay(this);

    // Rebuild wind emitter — its texture color comes from the strategy
    const initW = Number(this.game.config.width);
    const initH = Number(this.game.config.height);
    const wasActive = this.windEmitter.active;
    this.windEmitter.destroy();
    if (this.textures.exists('__wind_particle__')) {
      this.textures.remove('__wind_particle__');
    }
    const windColor = this.strategy.getWindParticleColor();
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 1;
    const wctx = c.getContext('2d')!;
    const wr = (windColor >> 16) & 0xff;
    const wg = (windColor >> 8) & 0xff;
    const wb = windColor & 0xff;
    wctx.fillStyle = `rgb(${wr},${wg},${wb})`;
    wctx.fillRect(0, 0, 2, 1);
    this.textures.addCanvas('__wind_particle__', c);
    this.windEmitter = this.add.particles(0, 0, '__wind_particle__', {
      x: { min: 0, max: initW + 100 },
      y: { min: 0, max: initH },
      speedX: { min: -400, max: -200 },
      speedY: 0,
      lifespan: 800,
      frequency: 80,
      quantity: 1,
      alpha: { start: this.strategy.getWindParticleAlpha(), end: 0 },
      scaleX: { min: 3, max: 8 },
      active: wasActive,
    });
    this.windEmitter.setScrollFactor(0);
    this.windEmitter.setDepth(450);

    // Force terrain redraw next frame
    this.lastTerrainScrollX = NaN;
  }
}
