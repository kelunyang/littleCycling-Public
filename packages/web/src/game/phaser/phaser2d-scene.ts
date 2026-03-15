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

/** Vertical exaggeration factor for elevation. */
export const ELEVATION_EXAGGERATION = 4;

/** Cyclist screen position as fraction of viewport width from left. */
const CYCLIST_SCREEN_X = 0.3;

/** Ground baseline Y position (pixels from top) — terrain is drawn relative to this. */
export const GROUND_BASELINE_Y = 0.75; // 75% down from top

export class Phaser2DScene extends Phaser.Scene {
  private bridge: PhaserBridge;
  private strategy: PhaserStyleStrategy;

  // Promise that resolves when create() finishes — await before using scene objects
  private _readyResolve!: () => void;
  readonly ready = new Promise<void>((r) => { this._readyResolve = r; });

  // Graphics layers (initialized in create())
  private terrainGfx!: Phaser.GameObjects.Graphics;
  private overlayObj!: Phaser.GameObjects.GameObject | null;
  private markerGfx!: Phaser.GameObjects.Graphics;

  // Speed/wind particle emitter
  private windEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;

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

  constructor(bridge: PhaserBridge, strategy: PhaserStyleStrategy) {
    super({ key: 'Phaser2DScene' });
    this.bridge = bridge;
    this.strategy = strategy;
  }

  create() {
    // Terrain graphics — scrolls with the world
    this.terrainGfx = this.add.graphics();

    // Distance markers — scrolls with the world
    this.markerGfx = this.add.graphics();
    this.markerGfx.setDepth(50);

    // Water shimmer layer — above terrain features
    this.waterShimmerGfx = this.add.graphics();
    this.waterShimmerGfx.setDepth(16);

    // Zone color filter — semi-transparent fullscreen overlay
    this.zoneFilterGfx = this.add.graphics();
    this.zoneFilterGfx.setScrollFactor(0);
    this.zoneFilterGfx.setDepth(950);

    // Style-specific overlay (CRT scanlines for plastic, film grain for cuphead, etc.)
    this.overlayObj = this.strategy.drawOverlay(this);

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

      // Draw static markers (flags, distance ticks)
      this.drawStaticMarkers();
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

  /** Draw terrain from elevation profile — delegates visual style to strategy. */
  private drawTerrain(w: number, h: number) {
    this.terrainGfx.clear();

    if (this.elevationProfile.length < 2) return;

    const baselineY = h * GROUND_BASELINE_Y;
    const elevRange = Math.max(this.maxElevation - this.minElevation, 10);

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
      if (x > visRight) {
        const y = baselineY - ((pt.eleM - this.minElevation) / elevRange) * (baselineY * 0.6) * ELEVATION_EXAGGERATION / (this.maxElevation > 500 ? 2 : 1);
        points.push({ x, y });
        break;
      }
      const normalizedEle = (pt.eleM - this.minElevation) / elevRange;
      const y = baselineY - normalizedEle * (baselineY * 0.6) * ELEVATION_EXAGGERATION / (elevRange > 500 ? 2 : 1);
      points.push({ x, y });
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
    const baselineY = h * GROUND_BASELINE_Y;

    if (this.elevationProfile.length < 2) return baselineY;

    const elevRange = Math.max(this.maxElevation - this.minElevation, 10);

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

    const normalizedEle = (ele - this.minElevation) / elevRange;
    return baselineY - normalizedEle * (baselineY * 0.6) * ELEVATION_EXAGGERATION / (elevRange > 500 ? 2 : 1);
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
}
