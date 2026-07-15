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

/** How long a style's entrance animation runs, in seconds. The scene forces a
 *  terrain redraw every frame until this elapses (the camera may not be moving
 *  yet, and the dirty flag would otherwise freeze the animation on frame 1). */
export const INTRO_DURATION_S = 3.6;

/**
 * Entrance-animation state handed to drawTerrainSurface.
 *
 * plastic  — blocks drop in column by column (Tetris).
 * cuphead  — an ink pen strokes the outline left-to-right, then watercolour
 *            washes brush in behind it.
 *
 * `originX` is the world X of the view's left edge when the intro started, so
 * the per-column delay stays anchored even as the camera drifts.
 */
export interface IntroState {
  /** Seconds since the intro started. */
  t: number;
  /** World X the reveal sweeps out from. */
  originX: number;
}

/**
 * Drawing strategy interface for all Phaser 2D visual elements.
 *
 * Each method handles one visual component. The renderer calls these
 * instead of hardcoding drawing logic, enabling style switching.
 */
export interface PhaserStyleStrategy {
  readonly style: PhaserStyle;

  /** Keep a few clouds drifting even in sunny weather (cuphead — a 1930s
   *  cartoon sky always has ink clouds in it). */
  readonly cloudsOnSunny?: boolean;

  /** Opt-in to the Preetham analytic (photorealistic) sky on sunny days.
   *  Neither hand-styled world wants it — a physically-correct blue sky on
   *  top of ink-and-watercolour (or a neon block world) reads as a bug, not
   *  a feature. Left as an opt-in for a possible future realistic style. */
  readonly wantsRealisticSky?: boolean;

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
    /** Multi-color canopy variants. renderTree picks one per seed for visual variety. */
    treeCanopyColors: number[];
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

  /** Snap a continuous terrain-surface Y to where this style actually DRAWS
   *  the ground. The Tetris style quantises the surface to 24px block rows —
   *  without this, the rider (and coins, flags, lamps, buildings) stand on
   *  the mathematical surface and sink up to a block into the drawn one.
   *  Styles that draw the surface continuously omit the hook. */
  snapGroundY?(y: number): number;

  /** Draw the terrain surface line + fill. `intro` is present only while the
   *  entrance animation is running (see IntroState). */
  drawTerrainSurface(
    gfx: Phaser.GameObjects.Graphics,
    points: { x: number; y: number }[],
    bottomY: number,
    seed: number,
    intro?: IntroState,
  ): void;

  /** Draw the screen overlay (CRT scanlines or film grain). */
  drawOverlay(scene: Phaser.Scene): Phaser.GameObjects.GameObject | null;

  /** Optional backdrop behind the terrain but in front of the sky (plastic's
   *  neon grid). Recreated on resize, like drawOverlay. */
  drawBackdrop?(scene: Phaser.Scene): Phaser.GameObjects.GameObject | null;

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

  /** Sandy ground patch (landcover class=sand — beaches, dunes). */
  renderSand(
    gfx: Phaser.GameObjects.Graphics,
    x: number, y: number, w: number, h: number, seed: number,
  ): void;

  /** Built-up area tint (landuse residential/commercial/industrial) — a low-key
   *  ground-band treatment so town stretches read against open country. Must
   *  stay quieter than the buildings standing on it. */
  renderUrban(
    gfx: Phaser.GameObjects.Graphics,
    x: number, y: number, w: number, h: number, seed: number,
  ): void;

  /** Linear watercourse crossing the route (river/canal/stream). Narrower than
   *  renderWater; returns its position so the shimmer animation plays on it. */
  renderWaterway(
    gfx: Phaser.GameObjects.Graphics,
    x: number, y: number, w: number, h: number, seed: number,
  ): { x: number; y: number; w: number } | null;

  /** Airport runway/taxiway strip on the ground. */
  renderAeroway(
    gfx: Phaser.GameObjects.Graphics,
    x: number, y: number, w: number, kind: 'runway' | 'taxiway', seed: number,
  ): void;

  /** Paved-road surface treatment along the terrain. `points` samples the
   *  drawn ground surface (style-snapped) left→right across the road span. */
  renderRoadSurface(
    gfx: Phaser.GameObjects.Graphics,
    points: { x: number; y: number }[],
    seed: number,
  ): void;

  /** Render the static parts of a street lamp (pole/arm/housing). */
  renderRoadLamp(
    gfx: Phaser.GameObjects.Graphics,
    x: number, y: number, seed: number,
  ): void;

  /** Render only the lamp's emissive glow (circles + light beam) on a
   *  separate Graphics so it can be alpha-tweened independently. */
  renderRoadLampGlow(
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

  /** Draw a stylised sun (cuphead's ink disc with radiating strokes). Styles
   *  without one (plastic's dark arcade sky) simply omit the hook. */
  drawSun?(
    gfx: Phaser.GameObjects.Graphics,
    cx: number, cy: number, radius: number, seed: number,
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
