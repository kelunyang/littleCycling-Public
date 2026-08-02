/**
 * The finish airship — a single themed aircraft (cuphead zeppelin / plastic UFO)
 * floating over the ride's *predicted* end point, with a hanging banner reading
 * the live "remaining km · min".
 *
 * Three things make it actually visible, which the first cut got wrong:
 *
 * 1. **The target is not the route's end.** In a timed session (a 30-min FTP set)
 *    the ride stops when the clock does, so the real end is "where the current
 *    average pace lands you". The server predicts that (`finishTarget`), and the
 *    airship drifts as the prediction moves. On EuroVelo the route end is 1000 km
 *    away and would never be seen; the predicted end always will be.
 * 2. **Lakitu clamp** (same rule the 2D scroller uses): while the target is
 *    further than MAX_LEAD_M the airship rides along the route at exactly that
 *    lead, guiding rather than marking. It settles onto the true spot once the
 *    target comes within range — so the last stretch is honest.
 * 3. **Constant angular size.** A 14 m UFO at 3 km is ~5 px on 1080p — a speck.
 *    Beyond REF_DIST_M the group scales with distance, holding its on-screen size
 *    so it reads as a landmark instead of dust.
 *
 * Ground height comes from the route's own GPX elevation at the displayed
 * distance (the target moves every frame, so a DEM sampler round-trip per
 * position is pointless — HOVER_M of clearance swallows the difference).
 */

import * as THREE from 'three';
import { interpolateAlongRoute, type RoutePoint } from '@littlecycling/shared';
import type { FinishAirshipParts, TerrainStyleStrategy } from './terrain-style-strategy';

/** Hover height above the ground elevation below it (metres). */
const HOVER_M = 120;

/** Bob amplitude (metres) + angular speed of the floating motion. */
const BOB_AMPLITUDE = 2.5;
const BOB_SPEED = 0.8;

/** Lakitu clamp — how far ahead of the rider the airship may sit (metres).
 *  Past this it stops being a position marker and becomes a guide. */
const MAX_LEAD_M = 1500;

/** Distance at which the airship renders at its authored size; beyond this it
 *  scales linearly with distance to hold a constant on-screen size. */
const REF_DIST_M = 600;

/** Time constant (s) of the positional smoothing. The prediction drifts as pace
 *  changes — without this an interval start would visibly yank the airship. */
const SMOOTH_TAU = 0.8;

/**
 * Format the banner string (zh-TW). Pure — the 2D side imports this.
 * `remainingMs === null` (freeRoam / no target duration) drops the minutes.
 * Times stay in ms until this last-mile format (CLAUDE.md); a bare minutes ceil
 * needs no dayjs.
 */
export function formatFinishBanner(remainingKm: number, remainingMs: number | null): string {
  const km = Math.max(0, remainingKm).toFixed(1);
  if (remainingMs === null) return `剩 ${km} km`;
  const min = Math.ceil(Math.max(0, remainingMs) / 60000);
  return `剩 ${km} km · ${min} 分`;
}

export class FinishAirshipManager {
  private scene: THREE.Scene;
  private strategy: TerrainStyleStrategy;
  private parts: FinishAirshipParts | null = null;

  /** Route + projection origin, kept for the per-frame distance→world lookup. */
  private points: RoutePoint[] = [];
  private cumulativeDists: number[] = [];
  private totalDist = 0;
  private originLon = 0;
  private originLat = 0;
  private originEle = 0;
  private cosLat = 1;

  /** Smoothed world position (x/z, and y as the bob baseline). */
  private worldX = 0;
  private worldZ = 0;
  private baseY = 0;
  /** False until the first setTarget — the first sample snaps instead of eases. */
  private placed = false;

  /** True once spawn() has a usable route — update() no-ops before then. */
  private spawned = false;

  /** Last banner string baked — skip a re-bake when it hasn't changed. */
  private lastBannerText = '';

  constructor(scene: THREE.Scene, strategy: TerrainStyleStrategy) {
    this.scene = scene;
    this.strategy = strategy;
  }

  /** Bind the route. The airship stays hidden until the first setTarget(). */
  spawn(
    points: RoutePoint[],
    cumulativeDists: number[],
    originLon: number,
    originLat: number,
    originEle: number,
  ): void {
    this.dispose();
    if (points.length < 2 || cumulativeDists.length !== points.length) return;

    this.points = points;
    this.cumulativeDists = cumulativeDists;
    this.totalDist = cumulativeDists[cumulativeDists.length - 1];
    this.originLon = originLon;
    this.originLat = originLat;
    this.originEle = originEle;
    this.cosLat = Math.cos((originLat * Math.PI) / 180);

    this.placed = false;
    this.spawned = true;
    this.rebuild();
  }

  /**
   * Feed the predicted finish (both monotonic, same axis as cumulativeDistance).
   * Applies the Lakitu clamp, resolves the route position, and eases toward it.
   * Safe to call every frame; `dt` drives the smoothing.
   */
  setTarget(targetCum: number, playerCum: number, dt: number): void {
    if (!this.spawned || this.totalDist <= 0) return;

    // Lakitu: never further ahead than MAX_LEAD_M, never behind the rider.
    const lead = Math.max(0, targetCum - playerCum);
    const displayedCum = playerCum + Math.min(lead, MAX_LEAD_M);

    // Wrap onto the route (laps) and read the position + ground elevation there.
    const wrapped = displayedCum - Math.floor(displayedCum / this.totalDist) * this.totalDist;
    const p = interpolateAlongRoute(this.points, this.cumulativeDists, wrapped);

    const tx = (p.lon - this.originLon) * 111320 * this.cosLat;
    const tz = -(p.lat - this.originLat) * 111320;
    const ty = (p.ele - this.originEle) + HOVER_M;

    if (!this.placed) {
      this.worldX = tx;
      this.worldZ = tz;
      this.baseY = ty;
      this.placed = true;
      if (this.parts) {
        this.parts.root.position.set(tx, ty, tz);
        this.parts.root.visible = true; // hidden until the first real target
      }
      return;
    }

    // Exponential ease — frame-rate independent.
    const k = 1 - Math.exp(-Math.max(0, dt) / SMOOTH_TAU);
    this.worldX += (tx - this.worldX) * k;
    this.worldZ += (tz - this.worldZ) * k;
    this.baseY += (ty - this.baseY) * k;
  }

  /**
   * Swap the world style — rebuild in place, keeping position and banner text.
   */
  setStrategy(strategy: TerrainStyleStrategy): void {
    this.strategy = strategy;
    if (this.spawned) this.rebuild();
  }

  /** Feed the banner (1 Hz). Skips the CanvasTexture re-bake when unchanged. */
  setBannerInfo(remainingKm: number, remainingMs: number | null): void {
    const text = formatFinishBanner(remainingKm, remainingMs);
    if (text === this.lastBannerText) return;
    this.lastBannerText = text;
    this.parts?.setBannerText(text);
  }

  /** Per-frame: bob, distance-compensated scale, theme animation. */
  update(dt: number, elapsed: number, cameraPos: THREE.Vector3): void {
    const parts = this.parts;
    if (!parts || !this.spawned || !this.placed) return;

    const y = this.baseY + Math.sin(elapsed * BOB_SPEED) * BOB_AMPLITUDE;
    parts.root.position.set(this.worldX, y, this.worldZ);

    // Hold a constant apparent size past REF_DIST_M, so the airship stays a
    // readable landmark instead of shrinking into a pixel.
    const dx = cameraPos.x - this.worldX;
    const dy = cameraPos.y - y;
    const dz = cameraPos.z - this.worldZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    parts.root.scale.setScalar(Math.max(1, dist / REF_DIST_M));

    parts.update(dt, elapsed);
  }

  dispose(): void {
    this.spawned = false;
    this.placed = false;
    this.points = [];
    this.cumulativeDists = [];
    this.totalDist = 0;
    if (this.parts) {
      this.scene.remove(this.parts.root);
      this.parts.dispose();
      this.parts = null;
    }
  }

  /** Tear down the old parts (if any) and build fresh at the stored position. */
  private rebuild(): void {
    if (this.parts) {
      this.scene.remove(this.parts.root);
      this.parts.dispose();
      this.parts = null;
    }
    const parts = this.strategy.buildFinishAirship();
    parts.root.position.set(this.worldX, this.baseY, this.worldZ);
    // The banner rides along at every distance now (the clamp keeps the airship
    // close enough to read), so there is no far-away hide state to manage.
    parts.setBannerVisible(true);
    if (this.lastBannerText) parts.setBannerText(this.lastBannerText);
    parts.root.visible = this.placed;
    this.scene.add(parts.root);
    this.parts = parts;
  }
}
