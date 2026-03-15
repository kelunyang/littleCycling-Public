/**
 * Strategy pattern interface for Phaser 2D visual styles.
 *
 * Two implementations:
 * - PlasticStyleStrategy: original neon/flat cartoon style (default)
 * - CupheadStyleStrategy: 1930s hand-drawn Cuphead-inspired style
 *
 * The renderer delegates all style-specific drawing to the active strategy.
 */

import type Phaser from 'phaser';

export type PhaserStyle = 'plastic' | 'cuphead';

/**
 * Drawing strategy interface for all Phaser 2D visual elements.
 *
 * Each method handles one visual component. The renderer calls these
 * instead of hardcoding drawing logic, enabling style switching.
 */
export interface PhaserStyleStrategy {
  readonly style: PhaserStyle;

  /** Color palette for this style. */
  readonly palette: {
    terrainFill: number;
    terrainOutline: number;
    ink: number;
    skyDayTop: number;
    skyDayBottom: number;
    buildingColors: number[];
    treeTrunk: number;
    treeCanopy: number;
    waterFill: number;
    waterOutline: number;
    grassOverlay: number;
    lampPost: number;
    lampGlow: number;
    mountainFar: number;
    mountainNear: number;
    cloud: number;
    moon: number;
    coinGold: number;
    coinHighlight: number;
    coinOutline: number;
    markerTick: number;
    fogColor: number;
    cyclistBody: number;
    cyclistHelmet: number;
    cyclistSkin: number;
  };

  // ── Terrain ──

  /** Draw the terrain surface line + fill. */
  drawTerrainSurface(
    gfx: Phaser.GameObjects.Graphics,
    points: { x: number; y: number }[],
    bottomY: number,
    seed: number,
  ): void;

  /** Draw the screen overlay (CRT scanlines or film grain). */
  drawOverlay(scene: Phaser.Scene): Phaser.GameObjects.GameObject | null;

  /** Update overlay per frame (e.g. film grain shifting). */
  updateOverlay?(frameCount: number): void;

  // ── Background features ──

  renderBuilding(
    gfx: Phaser.GameObjects.Graphics,
    x: number, y: number, w: number, h: number,
    colorIndex: number, seed: number,
  ): void;

  renderTree(
    gfx: Phaser.GameObjects.Graphics,
    x: number, y: number, size: number, seed: number,
  ): void;

  renderWater(
    gfx: Phaser.GameObjects.Graphics,
    x: number, y: number, w: number, h: number, seed: number,
  ): { x: number; y: number; w: number } | null;

  renderGrass(
    gfx: Phaser.GameObjects.Graphics,
    x: number, y: number, w: number, h: number, seed: number,
  ): void;

  /** Render a street lamp at road positions. */
  renderRoadLamp(
    gfx: Phaser.GameObjects.Graphics,
    x: number, y: number, seed: number,
  ): void;

  // ── Sky / weather ──

  getSkyColors(sunElevation: number, weather: string): {
    top: number;
    bottom: number;
  };

  drawCloud(
    gfx: Phaser.GameObjects.Graphics,
    cx: number, cy: number, w: number, h: number, seed: number,
  ): void;

  /** Generate mountain silhouette points for parallax layers.
   *  seed randomises the shape so mountains look different each session. */
  generateMountainPoints(
    baseY: number, skyH: number, totalWidth: number, layer: 'far' | 'near', seed: number,
  ): { x: number; y: number }[];

  drawMountainSilhouette(
    gfx: Phaser.GameObjects.Graphics,
    points: { x: number; y: number }[],
    color: number,
    bottomY: number,
    seed: number,
  ): void;

  drawMoon(
    gfx: Phaser.GameObjects.Graphics,
    cx: number, cy: number, radius: number, phase: number, seed: number,
  ): void;

  drawStar(
    gfx: Phaser.GameObjects.Graphics,
    x: number, y: number, size: number, brightness: number, seed: number,
  ): void;

  // ── Cyclist ──

  getCyclistFrameSize(): { w: number; h: number };

  generateCyclistFrame(
    ctx: CanvasRenderingContext2D,
    ox: number,
    frame: number,
    pose: string,
    params: {
      torsoAngle: number;
      hipOffsetY: number;
      headTilt: number;
      rockAmplitude: number;
    },
  ): void;

  /** Zone 5 tint behavior for cyclist sprite. */
  getCyclistZone5Tint(isDarkened: boolean): number | null;

  // ── Coins ──

  getCoinSize(): number;

  drawCoinTexture(
    ctx: CanvasRenderingContext2D,
    cx: number, cy: number, size: number, seed: number,
  ): void;

  // ── Markers / flags ──

  getMarkerFont(): string;

  drawFlag(
    gfx: Phaser.GameObjects.Graphics,
    x: number, y: number, color: number, label: string, seed: number,
  ): void;

  // ── Wind particles ──

  getWindParticleColor(): number;
  getWindParticleAlpha(): number;
}

/**
 * Factory function — creates the appropriate strategy instance.
 * Uses dynamic import so each style is code-split.
 */
export async function createStyleStrategy(style: PhaserStyle): Promise<PhaserStyleStrategy> {
  if (style === 'cuphead') {
    const { createCupheadStyle } = await import('./cuphead-style');
    return createCupheadStyle();
  }
  const { createPlasticStyle } = await import('./plastic-style');
  return createPlasticStyle();
}
