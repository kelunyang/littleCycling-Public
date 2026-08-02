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
import type { PhaserWorldOptionKey, WorldOptionValue } from '@littlecycling/shared';
import type { ZoneKind } from '@/game/terrain/land-zone';
import type { SignVocabulary } from '@/game/terrain/sign-spec';

export type PhaserStyle = 'plastic' | 'cuphead' | 'circuit';

/**
 * The 2D-only world options, as this renderer reads them.
 *
 * The mirror image of `StyleParams` for the 3D side: `WORLD_OPTIONS` rows marked
 * `modes: ['phaser']` are checked against THIS interface, so a 2D switch with no
 * code behind it fails to compile exactly the way a 3D one does. See the
 * `WorldOptionKey` split in `shared/src/world-options.ts` for why the two halves
 * are checked separately.
 *
 * Values arrive from `resolveWorldOptions`, which has already filled in every
 * default and dropped anything of the wrong type — so these are total, not
 * partial, by the time they reach `createStyleStrategy`.
 */
export interface PhaserWorldOptions {
  /** Poster gouache on (default) ↔ bare kraft board. Corrugated world only;
   *  the other two ignore it (`cuphead-style.setCupheadPaintMode`). */
  paintEnabled: boolean;
}

/** Every `modes: ['phaser']` key must be a `PhaserWorldOptions` field. Declare a
 *  2D option with nothing behind it and this line stops compiling — the same
 *  contract `_AssertWorldOptionKeysAreStyleParams` gives the 3D half. */
type _AssertPhaserOptionKeysAreHandled =
  PhaserWorldOptionKey extends keyof PhaserWorldOptions ? true : never;
const _assertPhaserOptionKeys: _AssertPhaserOptionKeysAreHandled = true;
void _assertPhaserOptionKeys;

/**
 * Read the 2D-relevant options out of a resolved world-option bag.
 *
 * The single consumption point, so the assertion above has teeth: a key that is
 * declared but never read here would leave its field unused, and a field that is
 * read but never declared would not typecheck.
 */
export function phaserWorldOptions(
  values?: Readonly<Record<string, WorldOptionValue>>,
): PhaserWorldOptions {
  return {
    // `!== false` rather than `=== true`: an absent bag means "nobody has an
    // opinion", and the declared default is on.
    paintEnabled: values?.paintEnabled !== false,
  };
}

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
 * The box a `renderBuilding` call actually filled: left, top, width, height, in
 * the same world-px frame the nominal box arrived in.
 *
 * It is not the nominal box, because every style reshapes what it is handed.
 * The toy world SNAPS to its 24 px grid, so a 15 × 19 footprint is drawn
 * 24 × 48. The paper world's school and tape dispenser deliberately stay LOW and
 * spread WIDE — a 40 × 84 box comes out about 106 × 40, its top 44 px below the
 * nominal one. Anything that wants to lay something ON a building has to be told
 * where the building actually ended up, or on a short body it lands in the sky
 * above it (`plan/migrate-demo-worlds.md` §3.8, which is exactly the night
 * window grid `terrain-builder` used to stamp over the nominal box).
 *
 * This is the SOLID MASS, not a raster bounding box. A stud on top of a brick, a
 * 4 px neon glow stroke, a wobbled ink outline — all overshoot it by a pixel or
 * two, and chasing that would put arithmetic nobody reads into every body.
 * Whatever consumes this has to tolerate a couple of px.
 *
 * Returning nothing is legal and means "the nominal box is close enough".
 */
export interface DrawnBox {
  x: number;
  y: number;
  w: number;
  h: number;
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

  /**
   * Draw the terrain surface line + fill. `intro` is present only while the
   * entrance animation is running (see IntroState).
   *
   * `zones` is the land-use district at each sample, PARALLEL to `points` —
   * `zones[i]` is the district `points[i]` stands in, null outside every known
   * one. Same signal, same resolver (`zoneFromLanduseClass`) as `renderUrban`'s
   * `zone` and `renderBuilding`'s; this is the along-the-ground version of it.
   *
   * It exists because in the circuit world the SOLDER MASK COLOUR *is* the
   * zoning — the demo changes it segment by segment down the whole board and
   * drops a silkscreen boundary line through the board's thickness at every
   * edge, and `renderUrban`'s 60 px strip cannot say that. The other two worlds
   * carry their districts on the buildings and their ground band, and simply
   * ignore this.
   *
   * Omitted or shorter than `points` means "no zoning known", which is what the
   * headless probes and the welcome backdrop pass; a style must then draw what
   * it drew before this existed.
   */
  drawTerrainSurface(
    gfx: Phaser.GameObjects.Graphics,
    points: { x: number; y: number }[],
    bottomY: number,
    seed: number,
    intro?: IntroState,
    zones?: readonly (ZoneKind | null)[],
  ): void;

  /** Draw the screen overlay (CRT scanlines or film grain). */
  drawOverlay(scene: Phaser.Scene): Phaser.GameObjects.GameObject | null;

  /** Optional backdrop behind the terrain but in front of the sky (plastic's
   *  neon grid). Recreated on resize, like drawOverlay. */
  drawBackdrop?(scene: Phaser.Scene): Phaser.GameObjects.GameObject | null;

  /** Update overlay per frame (e.g. film grain shifting). */
  updateOverlay?(frameCount: number): void;

  // ── Background features ──

  /**
   * One building, standing in the box (x, y, w, h) with its base at y + h.
   *
   * `zone` is the land-use district the footprint stands in — the same signal
   * the 3D `buildBuildingBody(box, seed, zone)` takes, from the same
   * `ZoneIndex`. null means it stands outside every known zone, which is most
   * of a real route and is NOT residential (`land-zone.ts` says so where it
   * defines the type): a rural road is not a suburb. A style may ignore it and
   * keep one body for the whole city, but the point of carrying it is that a
   * hospital should not look like a house.
   *
   * The choice must be deterministic in `seed` alone. Not a shuffle bag: a bag
   * carries state between calls, so which body a footprint got would depend on
   * the order the chunk happened to draw its neighbours — and chunks load and
   * unload as the rider moves, so the same building would change shape when you
   * rode back past it.
   *
   * Returns the box it actually drew in (see `DrawnBox`), or nothing when the
   * nominal box is close enough. Every style here reshapes its box, so every
   * style here answers.
   *
   * `posts` is the world X of every THIN VERTICAL thing standing in front of
   * this footprint — lamps, checkpoint markers, tree trunks. It exists for one
   * job: all three 2D demos hang a shop sign on the facade and then nudge it
   * sideways within the slack its own body allows, so a lamp post standing in
   * the same metre does not cut the sign in half (`signShift`, declared
   * identically in all three). Lamps and markers are laid out on fixed spacing
   * and will never move for a building, so the sign is the thing that gives way.
   * Empty or omitted means "nothing known to be in the way", which is what the
   * headless probes and the welcome backdrop pass — the sign then sits centred,
   * exactly as `signShift`'s own `!posts.length` early-out does.
   *
   * It is deliberately NOT a generic occlusion list: nothing else may read it,
   * and nothing in it may change what is GENERATED (the demos' own rule,
   * 「只動招牌,不動任何生成順序」).
   *
   * `vocabulary` is which shelf this ride's shop signs draw their word from —
   * shopfronts, or the training ride's encouragement words (`SignVocabulary`).
   * It arrives per call, as an ARGUMENT, for the same reason the 3D twin takes
   * it as one on `mountShopSign` rather than reading it off the strategy:
   *
   *  · it is a fact about the RIDE, and the strategy is a fact about the WORLD.
   *    `createStyleStrategy` builds a fresh strategy every time the world is
   *    swapped (the Welcome backdrop does exactly that, live), so anything
   *    parked on the strategy — or on module state inside a code-split style —
   *    would silently revert to the declared default on the swap. The chunk
   *    manager owns this and outlives it.
   *  · module state would also be shared with the Welcome backdrop, which is
   *    not a ride at all and must always say shop names.
   *
   * Omitted means `'shop'`, which is what the headless probes, the Welcome
   * backdrop and every free ride pass. It is fixed for a ride and has no
   * setter on purpose: a chunk already on screen is never redrawn, so a value
   * that changed mid-ride would only reach the chunks ahead and the street
   * would say two different things at once.
   */
  renderBuilding(
    gfx: Phaser.GameObjects.Graphics,
    x: number, y: number, w: number, h: number,
    colorIndex: number, seed: number,
    zone: ZoneKind | null,
    posts?: readonly number[],
    vocabulary?: SignVocabulary,
  ): DrawnBox | void;

  /**
   * This building's night lights, drawn onto the chunk's ADDITIVE lights
   * Graphics — the same arrangement `renderRoadLampGlow` already has, and for
   * the same reason: an emissive pass has to live on its own layer so the night
   * factor can fade the whole chunk's lights with one alpha write.
   *
   * The arguments are `renderBuilding`'s, deliberately unchanged. The strategy
   * re-derives which body it drew from `(seed, zone)` — exactly what the 3D
   * `buildBuildingLights(box, seed, zone)` does — so asking a building for its
   * lights can never re-roll its shape. Derive the lights from the SAME layout
   * numbers the body used; two functions that each "work out where the windows
   * are" drift the first time one of them is tuned.
   *
   * DEVPLAN's rule: **the thing that decides the SHAPE decides the LIGHTS.**
   * Drawing NOTHING for a given building is a real answer — this kind of
   * building has no lights. OMITTING the hook is a different answer: then
   * `terrain-builder` stamps its generic warm-window grid over the extent
   * `renderBuilding` reported. That grid survives only as the fallback for a
   * style that has not declared its lights yet; on a themed body it is wrong by
   * construction, because one window pattern flattens every shape in the world
   * (the 3D side calls this "a capacitor with windows").
   *
   * The layer is ADD-blended, so this is FILL RATE on a machine where gameview
   * already costs 7× the demo per pixel (`plan/migrate-demo-worlds.md` §5) and
   * the 2D world is CPU-bound besides. Keep the glows small and few, and bound
   * their count in the box HEIGHT — the grid this replaces was linear in it.
   */
  renderBuildingLights?(
    gfx: Phaser.GameObjects.Graphics,
    x: number, y: number, w: number, h: number,
    colorIndex: number, seed: number,
    zone: ZoneKind | null,
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

  /**
   * Built-up area tint — a low-key ground-band treatment so town stretches read
   * against open country. Must stay quieter than the buildings standing on it.
   *
   * `zone` is the DISTRICT this band covers, resolved from the same landuse
   * class the polygon arrived with. It used not to be passed at all, and that
   * was the whole reason this hook drew an anonymous grey smudge: all six 2D and
   * 3D demos paint the ground band in the district's own colour (the toy world's
   * `ZONE_COLORS` over its baseplate, the paper world's `drawZoneBands`), which
   * is what makes「走過去就看得出換區了」true from the ground up rather than only
   * from the buildings. null means the class did not map to a district.
   *
   * ⚠ Today only residential / commercial / industrial can arrive: `landuse`
   * school and hospital are dropped upstream in `mvt-projection.classifyFeature`
   * (they are not ground tint there), so the toy world's cyan and near-white
   * bands are reachable only once that changes.
   */
  renderUrban(
    gfx: Phaser.GameObjects.Graphics,
    x: number, y: number, w: number, h: number, seed: number,
    zone: ZoneKind | null,
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

  /** Draw the themed finish-line aircraft (a Lakitu-style guide that hovers
   *  over the route's finish — cuphead: a hand-drawn 1930s zeppelin; plastic:
   *  a retro-arcade neon flying saucer). `cx,cy` is the hull centre in world
   *  px; `animPhase` is a seconds clock driving blink / propeller / wobble.
   *  The strategy also draws the hanging banner BOARD and returns its centre
   *  so the scene can pin a Phaser Text (the "remaining km · min" readout) on
   *  top. Optional — same opt-in pattern as drawSun/drawBackdrop; styles
   *  without an aircraft simply omit the hook. */
  drawAircraft?(
    gfx: Phaser.GameObjects.Graphics,
    cx: number, cy: number, seed: number, animPhase: number,
  ): { bannerCx: number; bannerCy: number };

  // ── Wind particles ──

  getWindParticleColor(): number;
  getWindParticleAlpha(): number;
}

/**
 * Factory function — creates the appropriate strategy instance.
 * Uses dynamic import so each style is code-split.
 *
 * `options` is a resolved world-option bag (`resolveWorldOptions(style, …)`).
 * It is applied HERE rather than at each call site because the 2D options are
 * module state inside a code-split style, and this factory is the one place that
 * has already awaited that module. Both call sites — the game renderer and the
 * welcome backdrop's live style swap — therefore get the switch for free.
 *
 * Omitting it means "the declared defaults", which is what the headless probes
 * and any future caller with no settings store want.
 */
export async function createStyleStrategy(
  style: PhaserStyle,
  options?: Readonly<Record<string, WorldOptionValue>>,
): Promise<PhaserStyleStrategy> {
  const opts = phaserWorldOptions(options);
  if (style === 'cuphead') {
    const { createCupheadStyle, setCupheadPaintMode } = await import('./cuphead-style');
    // Before the factory: the palette table it hands back is built in the
    // current mode (see `applyPaintMode` there), so setting it after would give
    // the scene a painted palette over a bare world.
    setCupheadPaintMode(opts.paintEnabled);
    return createCupheadStyle();
  }
  if (style === 'circuit') {
    const { createCircuitStyle } = await import('./circuit-style');
    return createCircuitStyle();
  }
  const { createPlasticStyle } = await import('./plastic-style');
  return createPlasticStyle();
}
