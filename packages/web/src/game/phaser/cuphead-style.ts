/**
 * Cuphead hand-drawn style strategy — 1930s vintage aesthetic.
 *
 * All visual elements are procedurally drawn with:
 * - Wobbly ink outlines (seed-based, deterministic)
 * - Watercolor-style fills (layered semi-transparent)
 * - Cross-hatching for shadows
 * - Organic blob shapes (trees, clouds, moon)
 * - Film grain overlay (pre-rendered canvas, shifted every 4 frames)
 * - Warm muted color palette replacing neon
 * - 64×64 rubber-hose cyclist with pie-cut eyes
 */

import type Phaser from 'phaser';
import type { ZoneKind } from '@/game/terrain/land-zone';
import {
  SIGN_ZONES, signContent, signPlacement, signStrokes, type SignVocabulary,
} from '@/game/terrain/sign-spec';
import { SIGN_TOPFACE, signShift, signStroke, signTriPoints } from './sign-carrier';
import type { DrawnBox, PhaserStyleStrategy } from './phaser-style-strategy';
import * as P from './cuphead-palette';
import {
  seededRandom,
  generateWobbleOffsets,
  drawInkLine,
  drawInkRect,
  drawSimpleHatch,
  drawWatercolorFill,
  drawOrganicBlob,
  generateFilmGrainCanvas,
} from './cuphead-draw';

// ── Film grain state (module-level, shared across resize) ──
let grainImage: Phaser.GameObjects.Image | null = null;
const GRAIN_TEXTURE_KEY = '__cuphead_grain__';
const IRIS_TEXTURE_KEY = '__cuphead_iris__';

// ── Terrain watercolour layers ──
// The terrain's permanent paint job — the entrance animation brushes the same
// three layers in one at a time. Each layer sits a little lower than the one
// above so the edges bleed like wet paint.
const WASHES: readonly { color: number; alpha: number; dy: number }[] = [
  { color: 0x7a8a5a, alpha: 0.5, dy: 16 },  // dusty sage under-wash
  { color: 0x8a9a6a, alpha: 0.45, dy: 7 },  // mid tone
  { color: P.TERRAIN_FILL, alpha: 0.85, dy: 0 },
];

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** The paper itself — the demo's `C.paper`, `themes.scss $cuphead 'paper'`. The
 *  sign's lit top face, and one of the values paint mode leaves alone. */
const PAPER_CREAM = 0xe8dcc0;

// ── Paint mode: poster gouache ↔ bare board ────────────────────────────────
//
// `plan/phaser-handdrawn-demo.html`'s `applyPaintMode` / `KRAFT_RAMP` / `PLAIN`,
// which the 3D paper world has always had and this side did not.
//
// "Bare" in this world means **an unpainted maquette**: the ink is all there,
// the gouache has not gone on yet. So it is NOT a greyscale filter and NOT a
// single flat brown — the demo's own warning is that 2D has no lighting, so
// without a value difference the whole picture collapses into one slab (「3D 那邊
// 還有光影可以撐」). Every fill is instead binned by LUMINANCE into five kraft
// tones: keep the value structure, throw away the hue, which is exactly what an
// unpainted card model looks like.
//
// What stays painted is not "the non-paper materials" — the demo is explicit
// that the highlighter barrel and the sticky notes are not card and get
// kraft'd anyway. The test is whether the colour is **a fill brushed onto the
// model**: the ink is the drawing itself, the paper is the substrate, and the
// sky, sun and moon are BEHIND the paper rather than on it.

/** Kraft in five steps, dark to light. All five are this world's own tones; the
 *  ramp introduces no new colour. */
const KRAFT_RAMP: readonly number[] = [0x8a6b42, 0xa8875a, 0xc9a877, 0xe0d3b4, 0xe8dcbf];

const lum = (h: number): number => (
  (0.2126 * ((h >> 16) & 255) + 0.7152 * ((h >> 8) & 255) + 0.0722 * (h & 255)) / 255
);

/** A colour's bare-board equivalent: the kraft tone of the same value band. */
export function plainHex(h: number): number {
  return KRAFT_RAMP[Math.min(KRAFT_RAMP.length - 1, Math.floor(lum(h) * KRAFT_RAMP.length))];
}

/**
 * The colours paint mode leaves alone — the demo's `KEEP_UNPAINTED`, by VALUE
 * rather than by key.
 *
 * The demo can key on names because it draws from one mutable table; this file
 * draws from `cuphead-palette.ts` exports and two dozen module constants, so the
 * switch is applied one layer down (see `paper()`), where all it has is the
 * number. Constants that happen to SHARE a value with a kept one therefore stay
 * painted where the demo would kraft them, and there are three, not the two this
 * comment used to claim:
 *
 *  · `TAPE_HUB` and `MOON` are both `0xe8dcc0`. `plainHex(0xe8dcc0)` is
 *    `0xe8dcbf` — one unit of blue, invisible.
 *  · **`LAMP_GLOW` and `SUN` are both `0xd4b050`**, so the street lamp's amber
 *    stays amber on a bare board. That one IS visible, and it is a port artefact
 *    rather than a demo decision: the demo has no lamp glow, and it kraft's every
 *    other light it does have (`hlGlow`, `filmGlow`). Found by `WHAT=palette
 *    PAINT=0`, which is the first thing that ever showed this table as a table.
 *    Left as it is because changing it changes shipped bare-mode pixels on a
 *    judgement the demo does not make — see the report.
 */
const KEEP_UNPAINTED: ReadonlySet<number> = new Set<number>([
  P.INK, PAPER_CREAM,
  P.SKY_DAY_TOP, P.SKY_DAY_BOTTOM, P.SKY_DUSK_TOP, P.SKY_DUSK_BOTTOM,
  P.SKY_NIGHT_TOP, P.SKY_NIGHT_BOTTOM,
  P.MOON, P.SUN,
]);

const paintColor = (c: number): number => (KEEP_UNPAINTED.has(c) ? c : plainHex(c));

/**
 * The colour to use RIGHT NOW.
 *
 * `paintColor` is the substitution itself and is deliberately unconditional —
 * `paper()` is the only thing that calls it and it has already checked the mode.
 * Anything outside that wrapper (a baked canvas, a colour handed to the scene)
 * has to ask about the mode here, or it kraft's the world while it is painted.
 */
const paintNow = (c: number): number => (paintOn ? c : paintColor(c));

/** `paintNow` as a canvas 2D `fillStyle` string. The rider sprite and the coin
 *  are baked into canvases rather than drawn through `Graphics`, so `paper()`
 *  never sees them and they have to ask for themselves. */
const paintHex = (c: number): string => `#${paintNow(c).toString(16).padStart(6, '0')}`;

/**
 * The palette the SCENE reads — `phaser-weather`'s fog, the water shimmer, the
 * km ticks.
 *
 * It lives out here rather than inside `createCupheadStyle` for the demo's own
 * reason: `C` is「目前這一套」, one mutable table that `applyPaintMode` writes over,
 * so「不必動任何一個 fillStyle 的呼叫端」. Same property here, one level out — the
 * scene holds `strategy.palette` across a paint toggle and simply reads new
 * numbers out of the same object.
 */
type CupheadPalette = PhaserStyleStrategy['palette'];

/** The palette AS PAINTED — the source `applyPaintMode` copies back from, which
 *  is what makes the switch reversible (the demo's `PAINTED`). */
const PALETTE_PAINTED: CupheadPalette = {
  terrainFill: P.TERRAIN_FILL,
  terrainOutline: P.TERRAIN_OUTLINE,
  ink: P.INK,
  skyDayTop: P.SKY_DAY_TOP,
  skyDayBottom: P.SKY_DAY_BOTTOM,
  buildingColors: [...P.BUILDING_COLORS],
  treeTrunk: P.TREE_TRUNK,
  treeCanopy: P.TREE_CANOPY,
  treeCanopyColors: [...P.TREE_CANOPY_COLORS],
  waterFill: P.WATER_FILL,
  waterOutline: P.WATER_OUTLINE,
  grassOverlay: P.GRASS_OVERLAY,
  lampPost: P.LAMP_POST,
  lampGlow: P.LAMP_GLOW,
  mountainFar: P.MOUNTAIN_FAR,
  mountainNear: P.MOUNTAIN_NEAR,
  cloud: P.CLOUD,
  moon: P.MOON,
  coinGold: P.COIN_GOLD,
  coinHighlight: P.COIN_HIGHLIGHT,
  coinOutline: P.COIN_OUTLINE,
  markerTick: P.MARKER_TICK,
  fogColor: P.FOG_COLOR,
  cyclistBody: P.CYCLIST_BODY,
  cyclistHelmet: P.CYCLIST_HELMET,
  cyclistSkin: P.CYCLIST_SKIN,
};

/** The live table. Arrays are COPIED, not shared: `applyPaintMode` rewrites them
 *  in place (the demo's `arr(ERASER, ERASER_PAINTED)`) and would otherwise eat
 *  the painted source it needs to switch back to. */
const PALETTE: CupheadPalette = {
  ...PALETTE_PAINTED,
  buildingColors: [...PALETTE_PAINTED.buildingColors],
  treeCanopyColors: [...PALETTE_PAINTED.treeCanopyColors],
};

/**
 * The three entries bare mode leaves PAINTED, and it is not an oversight.
 *
 * Everything else in this table is drawn by the scene on its OWN `Graphics`
 * (`fogGfx`, `waterShimmerGfx`, `markerGfx`), which never passes through
 * `paper()` — so those have to arrive already kraft'd or they stay in colour on
 * a bare board.
 *
 * These three do the opposite: `phaser-weather` reads them and hands them
 * straight back to `drawCloud` / `drawMountainSilhouette`, which DO run through
 * `paper()`. Kraft them here as well and the substitution happens twice, and it
 * is not idempotent — `plainHex(0x8a6b42)` is `0xc9a877`, two bands up. Worse for
 * the mountains, the value is lerped toward black on the way (dusk, weather dim),
 * so mapping first would produce tones that are not on `KRAFT_RAMP` at all and
 * the demo's whole claim — every fill is one of five kraft tones — would stop
 * being true of the biggest shape on screen. Mapping LAST, at the fill, keeps it.
 *
 * The rule, for whatever reads this table next: an entry the scene draws with
 * ITSELF is mapped here; an entry it hands back to a strategy method is not.
 */
const PALETTE_KEEPS_PAINTED: ReadonlySet<string> = new Set([
  'cloud', 'mountainFar', 'mountainNear',
]);

/** Gouache on (the demo's own default — its button reads「上色:廣告顏料」at
 *  start, and it says so because the first version promised the opposite). */
let paintOn = true;

/**
 * The demo's `applyPaintMode`: write the whole table over, so no call site has
 * to know. Scalars by assignment, arrays IN PLACE — its `arr` helper.
 *
 * In place rather than replaced because the array is handed out by reference and
 * a consumer is entitled to keep it. No 2D consumer does today (`terrain-builder`
 * re-reads `palette.buildingColors.length` every building, and nothing reads the
 * VALUES at all), so this particular property is currently unobservable — it is
 * kept because the demo does it and because the day something caches the array
 * is not the day to discover it.
 */
function applyPaintMode(): void {
  const src = PALETTE_PAINTED as unknown as Record<string, number | number[]>;
  const dst = PALETTE as unknown as Record<string, number | number[]>;
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (Array.isArray(v)) {
      const out = dst[k] as number[];
      for (let i = 0; i < v.length; i++) out[i] = paintOn ? v[i] : paintColor(v[i]);
      continue;
    }
    dst[k] = paintOn || PALETTE_KEEPS_PAINTED.has(k) ? v : paintColor(v as number);
  }
}

/**
 * Switch the corrugated world between poster gouache and bare kraft board.
 *
 * The rider-facing switch is `paintEnabled` in
 * `packages/shared/src/world-options.ts` (`modes: ['phaser']`), applied by
 * `createStyleStrategy` before this module's factory runs. Also reachable from
 * `PAINT=0` in `phaser-style-probe.mjs` and from the console.
 *
 * ⚠ Two things in this world are BAKED, not drawn per frame: the rider's
 * spritesheet and the coin texture. Toggling this at runtime therefore has to be
 * followed by `rebuildCyclistTextures(scene, strategy, sprite)` and by dropping
 * the `__phaser_coin__` texture, or the world goes bare with a full-colour rider
 * still pedalling through it. `Phaser2DScene.setStrategy` handles the rest
 * (overlay, backdrop, wind emitter, terrain redraw).
 */
export function setCupheadPaintMode(on: boolean): void {
  paintOn = on;
  applyPaintMode();
}

/** Whether the world is currently painted. */
export function isCupheadPainted(): boolean {
  return paintOn;
}

/**
 * The switch, applied to a `Graphics`.
 *
 * The demo swaps the values in one table so that no `fillStyle` call site has to
 * change (「不必動任何一個 fillStyle 的呼叫端」— its stated reason, and a good one:
 * the file's appearance must not move just because a switch was added). This
 * file has no such table, so the identical property is bought one layer down:
 * every strategy entry point runs its `Graphics` through here, and in bare mode
 * it comes back as a wrapper that maps `fillStyle` / `lineStyle` colours and
 * forwards everything else untouched.
 *
 * **Painted mode returns the Graphics itself**, so the default path allocates
 * nothing, branches once, and is provably identical to before this existed —
 * which is how the substitution is verified (`phaser-style-probe.mjs` painted
 * must be byte-identical to the pre-paint-mode file).
 *
 * The wrapper is cached per Graphics: a chunk redraws its own `Graphics` many
 * times, and a new Proxy per building would be the one thing a CPU-bound 2D
 * world cannot afford.
 */
const plainWrappers = new WeakMap<object, Phaser.GameObjects.Graphics>();

function paper(gfx: Phaser.GameObjects.Graphics): Phaser.GameObjects.Graphics {
  if (paintOn) return gfx;
  const hit = plainWrappers.get(gfx);
  if (hit) return hit;
  const wrapped = new Proxy(gfx, {
    get(target, key) {
      if (key === 'fillStyle') {
        return (c: number, a?: number) => { target.fillStyle(paintColor(c), a); return wrapped; };
      }
      if (key === 'lineStyle') {
        return (w: number, c: number, a?: number) => { target.lineStyle(w, paintColor(c), a); return wrapped; };
      }
      const v = (target as unknown as Record<string | symbol, unknown>)[key];
      if (typeof v !== 'function') return v;
      // Phaser's Graphics methods return `this` for chaining; hand back the
      // wrapper instead or a chained call would escape the filter.
      return (...args: unknown[]) => {
        const r = (v as (...a: unknown[]) => unknown).apply(target, args);
        return r === target ? wrapped : r;
      };
    },
  }) as Phaser.GameObjects.Graphics;
  plainWrappers.set(gfx, wrapped);
  return wrapped;
}

/** Smooth deterministic wobble — same world x, same offset, every frame.
 *  (The demo's `wob`: two incommensurate sines, no RNG jitter.) */
function wob(x: number, seed: number): number {
  return Math.sin(x * 0.045 + seed) * 1.6 + Math.sin(x * 0.13 + seed * 2.3) * 1.0;
}

/** Linear-interpolated surface Y at world x from the terrain point list. */
function surfYAt(points: { x: number; y: number }[], x: number): number {
  if (points.length === 0) return 0;
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x <= x) lo = mid;
    else hi = mid;
  }
  const p0 = points[lo];
  const p1 = points[hi];
  const span = p1.x - p0.x;
  const t = span > 0 ? (x - p0.x) / span : 0;
  return p0.y + (p1.y - p0.y) * t;
}

/** Demo's ink tree: wobbly trunk strokes under a lumpy 24-gon canopy blob. */
function drawInkTree(
  gfx: Phaser.GameObjects.Graphics,
  x: number, y: number, s: number, seed: number,
): void {
  gfx.lineStyle(3, P.INK, 0.95);
  gfx.lineBetween(x + wob(x, 2), y, x + wob(x, 5), y - 26 * s);
  gfx.fillStyle(P.TERRAIN_FILL, 0.9);
  gfx.lineStyle(2.5, P.INK, 0.9);
  gfx.beginPath();
  for (let j = 0; j <= 24; j++) {
    const a = (j / 24) * Math.PI * 2;
    const r = (16 + Math.sin(a * 5 + seed) * 4.5) * s;
    const px = x + Math.cos(a) * r;
    const py = y - 26 * s - 10 * s + Math.sin(a) * r * 0.85;
    if (j === 0) gfx.moveTo(px, py); else gfx.lineTo(px, py);
  }
  gfx.closePath();
  gfx.fillPath();
  gfx.strokePath();
}

/**
 * Decorative ink trees scattered along the terrain — the demo world is dotted
 * with them everywhere, not only where OSM happens to map a forest. Placed on
 * a deterministic world grid (~270px), skipping steep ground; MVT forest trees
 * still draw on top where real forests exist, which only adds foliage.
 * During the intro each tree "grows" in with a staggered delay.
 */
function drawScatteredTrees(
  gfx: Phaser.GameObjects.Graphics,
  points: { x: number; y: number }[],
  introT: number | null,
): void {
  if (points.length < 2) return;
  const SPACING = 270; // ≈90 m at 3 px/m
  const x0 = points[0].x;
  const x1 = points[points.length - 1].x;
  for (let gx = Math.ceil(x0 / SPACING) * SPACING; gx < x1; gx += SPACING) {
    if (seededRandom(gx) < 0.45) continue;
    // Skip steep ground — trees on a wall read as a mistake.
    const dy = surfYAt(points, gx + 15) - surfYAt(points, gx - 15);
    if (Math.abs(dy / 30) > 0.12) continue;

    let grow = 1;
    if (introT !== null) {
      grow = easeOutCubic((introT - 1.9 - seededRandom(gx * 11) * 0.8) / 0.45);
      if (grow <= 0) continue;
    }
    const x = gx + (seededRandom(gx * 3) - 0.5) * 50;
    const s = (0.7 + seededRandom(gx * 7) * 0.7) * grow;
    drawInkTree(gfx, x, surfYAt(points, x) + 2, s, gx);
  }
}

/** One watercolour layer: fill from the (already wobbled) surface, shifted
 *  down by the layer's dy, to the bottom of the view. */
function fillWash(
  gfx: Phaser.GameObjects.Graphics,
  pts: { x: number; y: number }[],
  bottomY: number,
  wash: { color: number; alpha: number; dy: number },
): void {
  gfx.fillStyle(wash.color, wash.alpha);
  gfx.beginPath();
  gfx.moveTo(pts[0].x, bottomY);
  for (const p of pts) gfx.lineTo(p.x, p.y + wash.dy);
  gfx.lineTo(pts[pts.length - 1].x, bottomY);
  gfx.closePath();
  gfx.fillPath();
}

/** The pen line along the surface: a 4px ink stroke with a thin offset echo —
 *  one pass of a nib leaves two edges, and that is what sells "drawn". */
function strokeTerrainInk(
  gfx: Phaser.GameObjects.Graphics,
  pts: { x: number; y: number }[],
): void {
  gfx.lineStyle(4, P.INK, 1);
  gfx.beginPath();
  gfx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts) gfx.lineTo(p.x, p.y);
  gfx.strokePath();
  gfx.lineStyle(1.5, P.INK, 0.55);
  gfx.beginPath();
  gfx.moveTo(pts[0].x, pts[0].y + 5);
  for (const p of pts) gfx.lineTo(p.x, p.y + 5);
  gfx.strokePath();
}

/** Hatch shading on the STEEP stretches only — three 45° strokes below the
 *  surface every ~36px where the grade exceeds ~4%. Flat ground stays clean
 *  paper; the pen only shades where the hill needs explaining. */
function drawTerrainHatch(
  gfx: Phaser.GameObjects.Graphics,
  points: { x: number; y: number }[],
  bottomY: number,
  alpha: number,
): void {
  if (points.length < 5) return;
  // Visual-slope threshold for a ~4% grade at the scene's px-per-metre scales
  // (4 px/m vertical over 3 px/m horizontal).
  const SLOPE_MIN = 0.053;
  const STEP_PX = 36;
  gfx.lineStyle(1.5, P.TERRAIN_OUTLINE, 0.6 * alpha);
  let nextX = points[0].x;
  for (let i = 2; i < points.length - 2; i++) {
    const p = points[i];
    if (p.x < nextX) continue;
    nextX = p.x + STEP_PX;
    const a = points[i - 2];
    const b = points[i + 2];
    const dx = b.x - a.x;
    if (dx <= 0 || Math.abs((b.y - a.y) / dx) < SLOPE_MIN) continue;
    for (let k = 0; k < 3; k++) {
      const yy = p.y + 10 + k * 11;
      if (yy > bottomY) break;
      gfx.lineBetween(p.x - 7, yy + 7, p.x + 7, yy - 7);
    }
  }
}

// ── Cyclist frame size (larger for rubber-hose detail) ──
const CYCLIST_W = 64;
const CYCLIST_H = 64;
const FRAME_COUNT = 6;

// ── Coin size ──
const COIN_SIZE = 14;

// ── Ink color as CSS hex ──
const INK_HEX = `#${P.INK.toString(16).padStart(6, '0')}`;

// ── Finish-airship tones ──
const AIRSHIP_CREAM = 0xe4d8b4; // warm cream hull watercolour
const AIRSHIP_KRAFT = 0xc4a87a; // kraft-toned wooden sign (P.MARKER_TICK sandstone)

// ── Eraser tones (the 3D paper town's residential block, ported down) ──
// The 3D world (game/terrain/paper-terrain-style.ts) builds every building as a
// draughtsman's eraser: coloured rubber with a printed paper sleeve pushed on
// from the BOTTOM, and a red plastic FILM banded round the sleeve's top edge.
// The film is the residential zone's night light — see ERASER_BAND_COLOR /
// ERASER_BAND_GLOW there, whose values these mirror. Kept here beside the
// airship tones (this file's existing home for object tones the shared palette
// does not carry) rather than inlined at the call site; change both files
// together or the two worlds drift apart.
const ERASER_SLEEVE = 0xe8dcbf; // printed paper sleeve (3D SLEEVE_COLOR)
/**
 * The red plastic film over the sleeve — `plan/phaser-handdrawn-demo.html`'s
 * `film`, not the 3D world's raw `#c8443a`.
 *
 * The demo takes the 3D hex and MUDDIES it toward gouache, and says so where it
 * declares the pair. That is not decoration: this world's plain-paper mode
 * (`applyPaintMode`) maps every fill onto a five-step kraft ramp by luminance,
 * and the demo picked these two values so the film lands on step 2 and its glow
 * on step 3. At the 3D hexes they fall on steps 1 and 2 — the band and its own
 * light would collapse onto adjacent kraft tones. The port had taken the 3D
 * values for both.
 */
const ERASER_FILM   = 0xbe5346;

// ── Night tones ──
//
// The 3D corrugated world lights three of its five bodies through a MATERIAL
// (`registerNightLitMaterial`, one global emissive write per frame) and two
// through placed quads. 2D has neither: every light below is a draw on the
// chunk's additive lights layer, so each body lights ONE mark it already drew.
// Values mirrored from `terrain/paper-terrain-style.ts` — change both together.
//
/** The eraser's plastic film alight — the demo's `filmGlow`, its gouache-muddied
 *  step off the 3D `ERASER_BAND_GLOW` (see ERASER_FILM above for why the two
 *  values are not the 3D ones). Residential's only light in either view, which
 *  is why the band exists at all. */
const ERASER_FILM_GLOW = 0xf58a6e;
/** The index tabs backlit — the demo's `tabGlow`, mirroring 3D `TAB_GLOW`.
 *
 *  It used to be the compartment panes' glow. A row of lit panes reads as an
 *  office block at dusk, which is the one silhouette this district must avoid,
 *  so the light moved onto the tabs — translucent label paper lit from behind is
 *  something the object already does. ONE warm glow for all four tab colours:
 *  four saturated glows would be a fairground, and every other district in this
 *  world lights warm. See `shopNightLight`. */
const TAB_GLOW = 0xb8862e;
/** The bore through the tape roll (3D TAPE_HUB_GLOW). */
const TAPE_HUB_GLOW = 0xad5a18;
/** The file box's lit handle bezel. The 3D world lights ONE whole bezel colour
 *  (`RING_COLORS[RING_LIT_INDEX]`, the amber one) with `RING_LIT_GLOW`
 *  `#b07d1c`; this is that glow pulled into the watercolour range, and like
 *  `ERASER_FILM_GLOW` it is a step brighter than the bezel itself — matched to
 *  the bezel and the night veil swallows it. */
const RING_GLOW = 0xf0c065;
/**
 * Which of the four bezel colours is the lit one — **1, the same index as the
 * 3D world's `RING_LIT_INDEX`**, and that is the whole reason `RING_COLORS`
 * below is four entries in the 3D order rather than the eraser's six.
 *
 * The abacus that stood here shared `ERASER_BODY_COLORS` (six) and lit index 3,
 * so "one whole colour" meant a SIXTH of the beads against the 3D world's
 * quarter — a documented, deliberate mismatch that only existed because the
 * ramps had different lengths. A file box wears one colour per box, three boxes
 * out of four colours, so the ramp has to be four on both sides or "the amber
 * box is the lit one" stops meaning the same thing. `npm run check:3d` pins the
 * index across the two renderers.
 */
const RING_LIT_INDEX = 1;
/** The pill box's lid (3D PILL_CELL_COLOR, the compartments it lights). */
const PILL_LID_GLOW = 0xf7f2e8;

// ── Highlighter street lamp (the demo's `hl*` tones) ──
const HL_BARREL = 0xb4c93e;  // the pen's body
const HL_CAP    = 0xd0dc92;  // the translucent cap, drawn at 0.32 / 0.6
const HL_NIB    = 0x687a16;  // the chisel tip shut inside it
const HL_GLOW   = 0xd8ea6a;  // its halo after dark
/** The nib's hard core. The demo's one bare hex outside its palette block, and
 *  it has to be: the halo is the pen's own ink and the core is the point being
 *  LOOKED AT, so it sits a step past the ramp on purpose. */
const HL_CORE   = 0xf4ffd0;
/** The pen's height. The demo's `58 * grow`, with `grow` at rest. */
const LAMP_HEIGHT = 58;

// ── Pushpin coin / pin-and-sticky checkpoint (the demo's `pin*` tones) ──
const PIN_SHAFT = 0xb8bfc8;
const PIN_HEAD  = 0xc4483a;

/**
 * The twelve radiating pen strokes shared by the sun and the moon — the demo's
 * `drawCelestial` loop, which draws BOTH bodies and only swaps the stroke
 * colour between them.
 *
 * One function because the two are one hand-drawn object seen twice; the port
 * had them as a sun with rays and a moon without, so they had stopped being the
 * same thing. The caller sets `lineStyle` first, exactly as the demo does.
 *
 * `wob(i * 40, 3)` and `seeded(i)` are the demo's, and they take the RAY INDEX,
 * not a per-object seed: the sun in the sky is the same sun every day, and a
 * per-session jitter would have it re-drawn each reload.
 */
function celestialRays(
  gfx: Phaser.GameObjects.Graphics, cx: number, cy: number, radius: number,
): void {
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.2;
    const r1 = radius + 7 + wob(i * 40, 3) * 1.5;
    const r2 = r1 + 9 + seededRandom(i) * 6;
    gfx.lineBetween(
      cx + Math.cos(a) * r1, cy + Math.sin(a) * r1,
      cx + Math.cos(a) * r2, cy + Math.sin(a) * r2,
    );
  }
}

/** Where the generic (unzoned) body's sleeve and film sit on its nominal box.
 *  Straight-edged, unlike `eraserBand`'s — see the note in `renderBuilding`.
 *  Shared with the night pass so the glow bands the film and not the paper. */
function genericFilm(y: number, h: number): { top: number; filmH: number } {
  return { top: y + h * 0.48, filmH: Math.max(2, Math.min(3.5, h * 0.05)) };
}

// ── Zone-driven building bodies ─────────────────────────────────────────────
//
// The map already says what a district is FOR, and this renderer used to throw
// it away: one generic block stood in for a house, a hospital and a factory
// alike. These five bodies are `plan/phaser-handdrawn-demo.html`'s — the demo
// is the SPEC, not a sketch — and they are the same five the 3D corrugated-
// paper world builds off the same `ZoneIndex` (`terrain/paper-terrain-style.ts`,
// `paperBuildingKind`), so one footprint does not come out as two different
// things in the two views.
//
//   residential  eraser house    rubber block + bottom paper sleeve + red film
//   commercial   tab dispenser   kraft stand + a row of index tabs + pane band
//   industrial   tape dispenser  heavy trapezoid base + reel + toothed blade
//   school       file boxes      three stacked archive boxes + handle bezels
//   hospital     pill box        white carton + flipped-open lid + red triangle
//
// All five are drawn in the language this file already speaks — `wob`bled
// outlines, an ink stroke round every edge, watercolour-muted fills, no system
// type anywhere. A hard-edged block with a flat fill would drag this world
// toward the toy-brick one next door, which is the one thing five new shapes
// must not do (§3.3: a part may have exactly one identity, and that goes for a
// whole visual grammar too).
//
// **Scaling — the part the demo cannot tell us.** Its five are fixed-size props
// standing beside a synthetic route: 40–60 px wide, 42–98 px tall, aspect never
// worse than about 2.5:1. Here the box comes off the map and is much narrower
// and much taller — `terrain-builder.renderBuilding` clamps the width to
// 15–40 px and lets the height run with `render_height`, so a 125 m tower
// arrives as 40 × 300. Most of the five stop being themselves long before that,
// so each carries the tallest aspect ratio it survives; see `BODY_SHAPE`.

// ── Zone-building tones ──
// Mirrors of the demo's palette block, which is itself the 3D world's colours
// pulled down to watercolour muddiness (the 3D values in
// `terrain/paper-terrain-style.ts` are lit by a scene; these are flat paint on
// paper and cannot be). They live here beside AIRSHIP_CREAM / ERASER_SLEEVE for
// the reason those do — the shared `cuphead-palette` carries the WORLD's
// colours, not one object's, and CLAUDE.md forbids a bare theme hex at the call
// site. Change the demo and change these together, or the two drift apart.

/** The eraser's six rubber colours. (They used to double as the abacus's beads;
 *  the school is a file-box stack now and its handle bezels have their own
 *  four-entry ramp — see `RING_COLORS` for why the length matters.) */
const ERASER_BODY_COLORS: readonly number[] = [
  0xc25f5c, 0x6faaa4, 0x8cb865, 0xd6c25e, 0xa06aa2, 0xc47b52,
];
/** The printed rule across the eraser's paper sleeve. */
const ERASER_SLEEVE_INK = 0x4a3a28;
/** Traced frames on the exposed rubber. A COLD blue in a world of warm tones on
 *  purpose: it is the only mark on the eraser's upper half and it has to be
 *  findable at riding distance. */
const CRAYON_WINDOW = 0x5a7d9d;
/** Shop front: corrugated kraft card, and the shade down its flutes. */
const SHOP_KRAFT = 0xc9a877;
const SHOP_KRAFT_DARK = 0xa8875a;
/** Sticky notes — the awning's folds and the two signs hung under it. */
const STICKY_COLORS: readonly number[] = [0xe0c358, 0xd88fa8, 0x89b8c8];
/** Tape dispenser: grey plastic base, kraft reel, cream hub, steel blade. */
const TAPE_BASE = 0x7f7a8c;
const TAPE_ROLL = 0xcfa871;
const TAPE_HUB = 0xe8dcc0;
const TAPE_BLADE = 0xb9bec6;
/**
 * File box: greyed corrugated board, its lid a step darker, and the dark face
 * inside a handle hole (3D `FILE_BOX_COLOR` / `FILE_LID_COLOR` /
 * `FILE_HOLE_COLOR`, pulled into the watercolour range).
 *
 * ⚠ `FILE_BOX` must not collide with `SHOP_KRAFT`: both bodies are cartons, the
 * outline separates them by stacking, and the colour has to separate them too —
 * the shop's kraft is warm brown, the file box is grey-beige.
 */
const FILE_BOX = 0xbdb497;
const FILE_LID = 0x99907a;
const FILE_HOLE = 0x4a4034;
/**
 * The bezel round each handle hole, one colour per box in the stack.
 *
 * **Four entries, in the 3D world's own `RING_COLORS` order** (vermilion,
 * cadmium, cerulean, viridian), muted to watercolour. The order is spec, not
 * layout: both renderers pick a box's colour with `(c0 + tier) % 4` and both
 * light index 1, so the index has to mean the same colour on both sides. That is
 * also why this does NOT reuse `ERASER_BODY_COLORS` the way the abacus's beads
 * did — mod 6 cannot line up with mod 4.
 */
const RING_COLORS: readonly number[] = [0xc4563f, 0xd9a248, 0x5f90b0, 0x4f8f77];
/** Boxes in the stack. A flat 3 on both sides of the fence — the 3D world's
 *  `FILE_TIERS`, and `check:3d` binds the two. */
const FILE_TIERS = 3;
/** Pill box: the carton, and its lid one shade down so the thrown-back flap
 *  reads as a different plane rather than a hole. */
const PILL_WHITE = 0xf0e6d2;
const PILL_LID = 0xdccfb4;
/** The hospital mark is a red TRIANGLE, never a red cross: a red cross on white
 *  is protected by the Geneva Conventions and by national law almost
 *  everywhere. Same reasoning as `sign-spec.ts` and the 3D world's
 *  HOSPITAL_MARK_COLOR. */
const PILL_MARK = 0xc4483a;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * The demo's `wq`: a hand-drawn box has no straight edge. Traces a quad whose
 * four corners are each pushed around by `wob`; the caller fills it, strokes
 * it, or both — so one path can serve a filled panel and an outlined one.
 *
 * `(x, gy)` is the BOTTOM CENTRE. Every body here stands on the ground line, so
 * that is the anchor they all share, and it is also the demo's convention.
 */
function wobQuad(
  gfx: Phaser.GameObjects.Graphics,
  x: number, gy: number, w: number, h: number, seed: number,
): void {
  const j = (n: number): number => wob(x + n * 37, seed + n) * 0.8;
  gfx.beginPath();
  gfx.moveTo(x - w / 2 + j(1), gy - h + j(2));
  gfx.lineTo(x + w / 2 + j(3), gy - h + j(4));
  gfx.lineTo(x + w / 2 + j(5), gy + j(6));
  gfx.lineTo(x - w / 2 + j(7), gy + j(8));
  gfx.closePath();
}

/** The five zone bodies. Unzoned is deliberately NOT one of them — see
 *  `bodyFor` and `renderBuilding`. */
type PaperBody = 'eraser' | 'shop' | 'tape' | 'fileBox' | 'pill';

/** The demo's zone→building table (`ZONE_BUILDING`), verbatim. */
const ZONE_BODY: Record<ZoneKind, PaperBody> = {
  residential: 'eraser',
  commercial: 'shop',
  industrial: 'tape',
  school: 'fileBox',
  hospital: 'pill',
};

/** The paper world's neighbour table (`ZONE_MIX`), shared verbatim with the 3D
 *  `paper-terrain-style.ts` and with `plan/paper-town-demo.html`. Neighbours are
 *  FUNCTIONAL, not chromatic: a shop among the houses, a clinic by the school. */
const ZONE_MIX: Record<ZoneKind, readonly [ZoneKind, ZoneKind]> = {
  residential: ['commercial', 'school'],
  commercial: ['residential', 'hospital'],
  industrial: ['commercial', 'residential'],
  school: ['residential', 'hospital'],
  hospital: ['residential', 'school'],
};

/**
 * Which body this footprint gets, or null for "keep the generic one".
 *
 * Zone → body is a BIAS, not a mapping: 80 % the district's signature building,
 * 20 % one of its two functional neighbours. A hard mapping stands one model in
 * a row down every street; one or two outsiders is what reads as a town.
 *
 * Pure in `(seed, zone)` and deliberately NOT a shuffle bag. A bag carries
 * state between calls, so the body a footprint got would depend on the order
 * the chunk happened to draw its neighbours — and chunks unload and reload as
 * the rider moves, so the same building would change shape when you rode back
 * past it. It also gets its OWN hash stream (`seed * 0.618 + 91.7`): sharing
 * the one the outlines wobble on would tie which building came up to how its
 * edges happen to wobble.
 *
 * An UNZONED footprint keeps the generic body. Not residential: `zoneAt`
 * returns null for everything outside a landuse polygon, which is most of a
 * real route, and reading that as housing turns a country road into a suburb.
 * (The 3D world answers `residential` there because its generic body IS the
 * eraser; this renderer still has a separate generic one, so it can say so.)
 */
function bodyFor(seed: number, zone: ZoneKind | null): PaperBody | null {
  if (!zone) return null;
  const roll = seededRandom(seed * 0.618 + 91.7);
  if (roll < 0.8) return ZONE_BODY[zone];
  return ZONE_BODY[ZONE_MIX[zone][roll < 0.9 ? 0 : 1]];
}

/** Where a body stands and how big it is: bottom CENTRE, drawn footprint, and
 *  `k`, the demo-scale factor (see `bodyBox`). */
interface PaperBox { x: number; gy: number; w: number; h: number; k: number; }

/**
 * Per body: the demo's own width/height multipliers on the map's box, the
 * tallest aspect (drawn h ÷ drawn w) the shape survives, and the height the
 * demo actually drew it at.
 *
 * **maxAR** is where the demo runs out and the 3D world's answer takes over.
 * The demo's own tallest shop front is 62 × 51 (0.82) and its tallest file-box
 * stack 78 × 88 (1.13), and stopping there is defensible on shape — but it
 * throws away the one thing a side elevation reads best, which is HEIGHT: a
 * 125 m commercial block would draw 51 px, a fifth of the tower next door. The
 * 3D corrugated-paper world hit this first and wrote the ruling down
 * (`stickyShopBody`: "the demo never had to answer this — its shops are
 * 6.5–9 m — but an MVT commercial block often is 30 m"). Its answer, in all
 * five bodies, is: KEEP THE HEIGHT and repeat the motif — the carton grows
 * storey rims, the tape dispenser's housing takes whatever the reel does not.
 *
 * So each ceiling here is a whole number of the demo's own units rather than
 * one of them: two shop storeys (1.6), and for the tape dispenser 2.6 — enough
 * that the reel, whose radius is bounded by the WIDTH, sits on a housing rather
 * than being the whole building. Under those ceilings — which is every ordinary
 * street, up to about 40 m — the shapes come out at exactly the demo's
 * proportions, low and wide.
 *
 * The file box's 1.5 is derived differently, and it is the only ceiling here
 * with a shape reason rather than a repeat-count reason: the stack is THREE
 * boxes tall, so at an aspect of 1.5 each box is exactly as tall as half its own
 * width — 2:1 in elevation, which is where a box stops looking like a box and
 * starts looking like a crate on end. Its own tallest (1.13) is under it, so the
 * demo's proportions are untouched, and unlike the abacus that stood here it
 * needs no repeat-count ceiling at all: a taller stack is still three boxes,
 * which is exactly what the 3D `fileBoxSchool` does with `tierH = h / 3`.
 *
 * Two have no ceiling. The eraser is the one body that has to be able to be a
 * tower (a stretched rubber block is still a rubber block), and residential is
 * both the commonest district and the one that must absorb a genuine high-rise.
 * The pill box is a carton, and a tall carton is still a carton.
 *
 * **demoH** turns the demo's fixed pixel details (a 15 px awning, a 7 px lid
 * thickness) into a proportion. `k = min(1, drawn h / demoH)` is exactly the
 * demo's own `grow` factor, reused for a different question: not "how far has
 * this animated in" but "how much smaller than the prop the demo drew is this
 * footprint". It is capped at 1 so no detail ever grows PAST the demo — which
 * also caps what the details can cost.
 *
 * `k` scales SIZES and OFFSETS only, never a COUNT. Counts (compartments, blade
 * teeth, handle holes, traced window cells) divide by a plain pixel
 * pitch, because a pitch is what the eye reads: how many folds fit across this
 * awning, not how many fitted across the demo's. Dividing a count by `k` as
 * well was the first version and it inverted — the smallest shop got the most
 * folds (6 across 26 px), which is the one thing that was measurably wrong.
 */
const BODY_SHAPE: Record<PaperBody, {
  w: number; h: number; maxAR: number; demoH: number;
}> = {
  eraser: { w: 1, h: 1, maxAR: Infinity, demoH: 70 },
  shop: { w: 1.55, h: 0.52, maxAR: 1.6, demoH: 36 },
  tape: { w: 1.3, h: 0.74, maxAR: 2.6, demoH: 50 },
  // ⚠ `h` is 0.9 where the abacus's was 0.52. That is not a taste change: the
  // abacus was deliberately SQUASHED into a low wide rack, and a stack of three
  // needs its real height or the three bands have nothing to divide. At 0.52 a
  // 9 m school draws 11 px, i.e. 3.7 px a box; at 0.9 it draws 19 px. The demo
  // draws it at 0.9 too, so this is still the demo's number.
  fileBox: { w: 1.95, h: 0.9, maxAR: 1.5, demoH: 63 },
  pill: { w: 1.05, h: 0.78, maxAR: Infinity, demoH: 55 },
};

function bodyBox(
  kind: PaperBody, x: number, y: number, w: number, h: number,
): PaperBox {
  const s = BODY_SHAPE[kind];
  const bw = w * s.w;
  const bh = Math.min(h * s.h, bw * s.maxAR);
  return { x: x + w / 2, gy: y + h, w: bw, h: bh, k: Math.min(1, bh / s.demoH) };
}

/**
 * Residential — the draughtsman's eraser.
 *
 * The generic body below already wears half of this (sleeve, chevron, film);
 * this is the demo's whole one, and the four things the 3D world learned the
 * hard way come with it:
 *  · SQUARE CORNERS. Round them and it is an American soft eraser, which at
 *    building scale is a bar of soap.
 *  · The sleeve is pushed on from the BOTTOM and covers the lower half, so the
 *    visual weight sits low. It is not a belt round the waist.
 *  · The top edge SLOPES — that is the end that has been ground down in use,
 *    and it is the only asymmetry the block has.
 *  · The red film bands the sleeve's TOP edge, and the sleeve's chevron grows
 *    out from behind it. A real drawing eraser has that ring already, which is
 *    why the 3D world could light it at night without inventing a new shape.
 *
 * The traced boxes on the exposed rubber are NOT windows — an eraser has none,
 * day or night. They are printed marks, and they only sit on the rubber the
 * sleeve leaves showing. Rows and columns are capped at two: the demo's fixed
 * 20 px cell would rule six rows onto a 300 px tower, and this is the commonest
 * body on the route while 2D is CPU-bound on the N100 target.
 *
 * The film IS what lights at night, on the additive layer — `eraserFilmLight`
 * below, off the same `eraserBand` numbers this draws it from.
 */
function eraserHouse(
  gfx: Phaser.GameObjects.Graphics, b: PaperBox, colorIndex: number, seed: number,
): DrawnBox {
  const { x, gy, w, h, k } = b;
  const body = ERASER_BODY_COLORS[colorIndex % ERASER_BODY_COLORS.length];
  const wear = Math.min(5, h * 0.1);

  gfx.fillStyle(body, 0.92);
  gfx.lineStyle(3, P.INK, 0.95);
  gfx.beginPath();
  gfx.moveTo(x - w / 2 + wob(x, seed + 1), gy - h + wear + wob(x, seed + 2));
  gfx.lineTo(x + w / 2 + wob(x, seed + 3), gy - h + wob(x, seed + 4));
  gfx.lineTo(x + w / 2 + wob(x, seed + 5), gy + wob(x, seed + 6));
  gfx.lineTo(x - w / 2 + wob(x, seed + 7), gy + wob(x, seed + 8));
  gfx.closePath();
  gfx.fillPath();
  gfx.strokePath();

  const B = eraserBand(b);
  const sleeveH = B.sleeveH;
  const top = gy - h + wear + 9 * k;
  const bot = gy - sleeveH - 8 * k;
  if (bot > top + 12 * k) {
    const rows = clamp(Math.floor((bot - top) / 20), 1, 2);
    const cols = clamp(Math.round(w / 20), 1, 2);
    const cw = w / cols;
    const rh = (bot - top) / rows;
    gfx.lineStyle(2.4, CRAYON_WINDOW, 0.75);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        wobQuad(
          gfx,
          x - w / 2 + (c + 0.5) * cw,
          top + (r + 0.5) * rh + Math.min(5 * k, rh * 0.2),
          Math.min(12 * k, cw * 0.62), Math.min(10 * k, rh * 0.5),
          seed + r * 3 + c,
        );
        gfx.strokePath();
      }
    }
  }

  // The sleeve, wider than the block it is pushed onto (paper bulges), with its
  // top edge cut to a point. Drop the chevron and the building is two stacked
  // colours and stops reading as stationery at all.
  const sw = B.sw;
  const chev = Math.min(12 * k, sleeveH * 0.3);
  gfx.fillStyle(ERASER_SLEEVE, 0.95);
  gfx.lineStyle(3, P.INK, 0.95);
  gfx.beginPath();
  gfx.moveTo(x - sw / 2 + wob(x, seed + 11), gy - sleeveH + wob(x, seed + 12));
  gfx.lineTo(x + wob(x, seed + 13), gy - sleeveH - chev);
  gfx.lineTo(x + sw / 2 + wob(x, seed + 14), gy - sleeveH + wob(x, seed + 15));
  gfx.lineTo(x + sw / 2 + wob(x, seed + 16), gy + wob(x, seed + 6));
  gfx.lineTo(x - sw / 2 + wob(x, seed + 17), gy + wob(x, seed + 8));
  gfx.closePath();
  gfx.fillPath();
  gfx.strokePath();
  gfx.lineStyle(2.6, ERASER_SLEEVE_INK, 0.8);
  gfx.lineBetween(
    x - sw / 2 + 2, gy - sleeveH * 0.68 + wob(x, seed + 21),
    x + sw / 2 - 2, gy - sleeveH * 0.68 + wob(x + 40, seed + 21),
  );

  // The film. No 3 px ink outline round it: the band is 2.5–5 px tall and a pen
  // that thick would swallow it whole. One thin rule under it is the seam where
  // plastic meets paper; the top edge is closed by the sleeve's own outline.
  gfx.fillStyle(ERASER_FILM, 0.95);
  wobQuad(gfx, x, B.bandTop + B.bandH, sw + 2 * k, B.bandH, seed + 31);
  gfx.fillPath();
  gfx.lineStyle(1.6, P.INK, 0.7);
  gfx.lineBetween(
    x - sw / 2 - k, B.bandTop + B.bandH + wob(x, seed + 33),
    x + sw / 2 + k, B.bandTop + B.bandH + wob(x + 40, seed + 33),
  );
  // The sleeve is drawn wider than the block it is pushed onto, and the film
  // wider still; the top edge is the block's, sloped or not.
  return { x: x - (w + 6 * k) / 2, y: gy - h, w: w + 6 * k, h };
}

/** The paper sleeve and the plastic film banding its top edge.
 *
 *  Its own function because the film is the ONE thing this building lights, and
 *  the 3D world's rule is that whatever decided the shape decides the light —
 *  a night pass that re-derived "roughly where the band goes" would sit a pixel
 *  off a 2.5 px band, which is all of it. */
function eraserBand(b: PaperBox) {
  const sleeveH = b.h * 0.52;
  return {
    sleeveH,
    sw: b.w + 4 * b.k,
    bandH: Math.max(2.5 * b.k, Math.min(5 * b.k, sleeveH * 0.16)),
    bandTop: b.gy - sleeveH,
  };
}

/**
 * Residential at night: the red film, and nothing else.
 *
 * This is what the 3D `eraserFilmMaterial` does with one emissive write, and it
 * is the whole reason the band is on the building — residential is the
 * commonest district and was the only fully dark one before the film carried
 * its light (`paper-terrain-style.ts` says so). An eraser has no windows, day or
 * night, so the traced marks on the rubber stay dark: they are printed marks.
 *
 * THREE nested rings and a near-opaque core, which is the demo's own halo and
 * not a flat quad. Rectangles, not circles, and the demo says why: a circular
 * halo on a band this wide balloons into a ball that swallows the house. The
 * ring count is three where the highlighter lamp's is five, deliberately — the
 * band is long, so each ring costs far more fill than a lamp's, and the N100 is
 * the target. The port had collapsed all four draws into one 0.8-alpha quad,
 * which is a lit band with no light AROUND it.
 */
function eraserFilmLight(
  gfx: Phaser.GameObjects.Graphics, b: PaperBox, _seed: number,
): void {
  const B = eraserBand(b);
  const k = b.k;
  const bx = b.x - B.sw / 2 - k, bw = B.sw + 2 * k;
  for (let r = 3; r >= 1; r--) {
    gfx.fillStyle(ERASER_FILM_GLOW, 0.09 * r);
    gfx.fillRect(bx - r * 2.5 * k, B.bandTop - r * 1.6 * k, bw + r * 5 * k, B.bandH + r * 3.2 * k);
  }
  gfx.fillStyle(ERASER_FILM_GLOW, 0.92);
  gfx.fillRect(bx, B.bandTop, bw, B.bandH);
}

/**
 * Commercial — the coloured index-tab dispenser (the demo's `drawTabStand`).
 *
 * A low wide kraft stand: a pressed lid rim, a row of coloured index tabs
 * standing up off it, a compartmented window band down at riding height, and an
 * angled dispensing lip pressed over the band with one tab pulled out of each
 * compartment. Three things carry it:
 *  · The ROW STANDING ON THE RIM is the whole silhouette at distance. The body
 *    this replaced put its teeth on the underside of an awning; these point up,
 *    and either way this is the district whose outline is not a flat rule (which
 *    is also why it still has to stay low — see `BODY_SHAPE`).
 *  · The compartments are PAINTED, never punched. A hole in a 15 px silhouette
 *    is a hole in the dusk skyline behind it, so the band is a dark wash with
 *    the window panes painted onto it.
 *  · The saturated colour appears at TWO heights. An MVT commercial block often
 *    runs tall, and tabs on the rim alone leave the whole street-level stretch
 *    of the facade brown.
 */
function tabStand(
  gfx: Phaser.GameObjects.Graphics, b: PaperBox, colorIndex: number, seed: number,
): DrawnBox {
  const { x, gy, w, h, k } = b;

  gfx.fillStyle(SHOP_KRAFT, 0.9);
  gfx.lineStyle(3, P.INK, 0.95);
  wobQuad(gfx, x, gy, w, h, seed + 3);
  gfx.fillPath();
  gfx.strokePath();
  gfx.lineStyle(1.6, SHOP_KRAFT_DARK, 0.5);
  for (const t of [-0.28, 0.3]) {
    gfx.lineBetween(
      x + w * t + wob(x, seed + 4), gy - h + 5 * k,
      x + w * t + wob(x, seed + 6), gy - 4 * k,
    );
  }
  // Pressed storey rims. A carton taller than one storey is a STACK of cartons,
  // not one impossible box — the 3D `tabDispenserParts` repeats its rim for the
  // same reason, and without them the extra height a `maxAR` of 1.6 buys is a
  // blank brown wall. At most two: the ceiling only ever allows two storeys.
  const storeys = Math.min(3, Math.round(h / 42));
  for (let s = 1; s < storeys; s++) {
    const ry = gy - (h * s) / storeys;
    gfx.lineBetween(x - w / 2, ry + wob(x, seed + 14), x + w / 2, ry + wob(x + 50, seed + 14));
  }

  const B = tabBand(b);
  const top = gy - h;

  // The pressed lid rim — the carton's identifying edge, and what the row above
  // stands on.
  gfx.fillStyle(SHOP_KRAFT_DARK, 0.9);
  gfx.lineStyle(2.2, P.INK, 0.9);
  wobQuad(gfx, x, top + B.rimH, w + 6 * k, B.rimH, seed + 8);
  gfx.fillPath();
  gfx.strokePath();

  // The row standing on the rim. Each tab leans on its own — a row in perfect
  // alignment reads as a printed colour bar, not as loose card.
  const tw = (w * 0.86) / B.n;
  const th = Math.min(13 * k, h * 0.42);
  for (let i = 0; i < B.n; i++) {
    const tx = x - w * 0.43 + (i + 0.5) * tw;
    const lean = (i % 2 ? 1 : -1) * 1.8 * k;
    gfx.fillStyle(STICKY_COLORS[(colorIndex + i) % STICKY_COLORS.length], 0.9);
    gfx.lineStyle(2, P.INK, 0.85);
    gfx.beginPath();
    gfx.moveTo(tx - tw * 0.30 + wob(tx, seed + 1) * 0.4, top + B.rimH * 0.5);
    gfx.lineTo(tx + tw * 0.30 + wob(tx, seed + 2) * 0.4, top + B.rimH * 0.5);
    gfx.lineTo(tx + tw * 0.30 + lean, top - th);
    gfx.lineTo(tx - tw * 0.30 + lean, top - th);
    gfx.closePath();
    gfx.fillPath();
    gfx.strokePath();
  }

  // The compartment band, at riding height.
  gfx.fillStyle(P.INK, 0.34);
  gfx.lineStyle(2.4, P.INK, 0.85);
  wobQuad(gfx, x, B.bot, w * 0.92, B.bandH, seed + 12);
  gfx.fillPath();
  gfx.strokePath();
  for (let i = 0; i < B.n; i++) {
    gfx.fillStyle(CRAYON_WINDOW, 0.8);
    gfx.lineStyle(1.6, P.INK, 0.5);
    wobQuad(gfx, B.paneX(i), B.paneBot, B.paneW, B.paneH, seed + 14 + i);
    gfx.fillPath();
    gfx.strokePath();
  }

  // The dispensing lip, pressed over the band's top edge, with one tab pulled
  // part-way out of each compartment.
  gfx.fillStyle(SHOP_KRAFT_DARK, 0.92);
  gfx.lineStyle(2.4, P.INK, 0.9);
  gfx.beginPath();
  gfx.moveTo(x - w * 0.49, B.top - 5 * k + wob(x, seed + 9) * 0.4);
  gfx.lineTo(x + w * 0.49, B.top - 5 * k + wob(x + 40, seed + 9) * 0.4);
  gfx.lineTo(x + w * 0.46, B.top + 2 * k);
  gfx.lineTo(x - w * 0.46, B.top + 2 * k);
  gfx.closePath();
  gfx.fillPath();
  gfx.strokePath();
  for (let i = 0; i < B.n; i++) {
    gfx.fillStyle(STICKY_COLORS[(colorIndex + i + 1) % STICKY_COLORS.length], 0.92);
    gfx.lineStyle(1.8, P.INK, 0.8);
    wobQuad(gfx, B.paneX(i), B.top + 7 * k, B.cw * 0.48, 5 * k, seed + 20 + i);
    gfx.fillPath();
    gfx.strokePath();
  }

  // The rim overhangs both sides and the row stands above the box's own top, so
  // this body really does draw outside the box it was handed.
  return { x: x - w / 2 - 3 * k, y: top - th, w: w + 6 * k, h: h + th };
}

/**
 * The compartment band — shared by the body, the lip and `shopNightLight`,
 * because the thing that decides the SHAPE has to decide the LIGHT. A pane grid
 * recomputed in the night pass is how the glow ends up floating beside the
 * window it is supposed to be coming out of.
 */
function tabBand(b: PaperBox): {
  n: number; cw: number; rimH: number; bandH: number; top: number; bot: number;
  paneW: number; paneH: number; paneBot: number; paneX: (i: number) => number;
} {
  const { x, gy, w, h, k } = b;
  // 3–5 compartments. Two do not read as "compartmented" and six blur into one
  // band at riding distance — and each is a filled, stroked path on the body
  // this district is mostly made of, on a target where 2D is CPU-bound.
  const n = Math.max(3, Math.min(5, Math.round(w / (13 * k))));
  const cw = (w * 0.92) / n;
  const bandH = Math.min(16 * k, h * 0.34);
  const bot = gy - 4 * k;
  return {
    n, cw, rimH: Math.max(3, 5 * k), bandH, bot, top: bot - bandH,
    paneW: cw * 0.62,
    paneH: bandH * 0.56,
    paneBot: bot - bandH * 0.18,
    paneX: (i: number) => x - w * 0.46 + (i + 0.5) * cw,
  };
}

/**
 * Commercial at night: BOTH rows of index tabs, lit. The panes stay dark.
 *
 * The 3D world lights exactly this (`tabLights` — quads on the face of every
 * tab), and like every other light in this file it is a surface the body already
 * painted by day. The panes it replaced are still drawn at noon and simply go
 * dark at dusk; see `TAB_GLOW` for why they had to stop glowing.
 *
 * One halo rectangle per tab and not the eraser's three: the tabs are small,
 * there are two rows of up to five, and a commercial district is a whole street
 * of this body — halo layers multiply by the building count and 2D is CPU-bound
 * on the N100 target.
 */
function shopNightLight(
  gfx: Phaser.GameObjects.Graphics, b: PaperBox, _seed: number,
): void {
  const B = tabBand(b);
  const { w, h, k } = b;
  const top = b.gy - h;
  const tw = (w * 0.86) / B.n;
  const th = Math.min(13 * k, h * 0.42);
  for (let i = 0; i < B.n; i++) {
    const tx = b.x - w * 0.43 + (i + 0.5) * tw;
    gfx.fillStyle(TAB_GLOW, 0.12);
    gfx.fillRect(tx - tw * 0.30 - 3 * k, top - th - 3 * k,
      tw * 0.60 + 6 * k, th + 6 * k);
    gfx.fillStyle(TAB_GLOW, 0.85);
    gfx.fillRect(tx - tw * 0.30, top - th, tw * 0.60, th);
  }
  for (let i = 0; i < B.n; i++) {
    gfx.fillStyle(TAB_GLOW, 0.85);
    gfx.fillRect(B.paneX(i) - B.cw * 0.24, B.top + 2 * k, B.cw * 0.48, 5 * k);
  }
}

/**
 * Industrial — the tape dispenser.
 *
 * A heavy trapezoid base with a reel sitting on it and a row of blade teeth
 * along the front lip. The reel is the point: it is the only CIRCLE in the
 * skyline, so the factory separates from four boxes at any distance. Two traps
 * the demo records:
 *  · The base has to stay THICK — never less than 0.4 of the height. Thin it
 *    and the reel sits on the ground and the whole building is a doughnut.
 *  · The reel's radius is bounded by the WIDTH, not just the free height. So on
 *    a tall box the reel does NOT grow, and the housing takes the remainder
 *    instead — which is what a factory looks like anyway: a stepped-back block
 *    with the machinery out front. That is the 3D `tapeLayout`'s ruling,
 *    verbatim; sizing the base at the demo's flat 0.56 of the height instead
 *    left the top third of a tall building simply missing from the skyline.
 */
function tapeDispenser(
  gfx: Phaser.GameObjects.Graphics, b: PaperBox, _colorIndex: number, seed: number,
): DrawnBox {
  const { x, gy, w, k } = b;
  const L = tapeLayout(b);
  const { rr, baseH } = L;

  gfx.fillStyle(TAPE_BASE, 0.9);
  gfx.lineStyle(3.2, P.INK, 0.95);
  gfx.beginPath();
  gfx.moveTo(x - w * 0.40 + wob(x, seed + 1), gy - baseH + wob(x, seed + 2));
  gfx.lineTo(x + w * 0.44 + wob(x, seed + 3), gy - baseH * 0.88 + wob(x, seed + 4));
  gfx.lineTo(x + w * 0.50 + wob(x, seed + 5), gy + wob(x, seed + 6));
  gfx.lineTo(x - w * 0.50 + wob(x, seed + 7), gy + wob(x, seed + 8));
  gfx.closePath();
  gfx.fillPath();
  gfx.strokePath();
  gfx.lineStyle(1.8, P.INK, 0.3);
  gfx.lineBetween(x - w * 0.42, gy - baseH * 0.42, x + w * 0.44, gy - baseH * 0.36);

  const { cx, cy } = L;
  gfx.fillStyle(TAPE_ROLL, 0.9);
  gfx.fillCircle(cx, cy, rr);
  gfx.lineStyle(3, P.INK, 0.95);
  gfx.strokeCircle(cx, cy, rr);
  gfx.lineStyle(1.6, P.INK, 0.28);
  gfx.strokeCircle(cx, cy, rr * 0.78); // the wound edge of the tape
  gfx.fillStyle(TAPE_HUB, 0.92);
  gfx.fillCircle(cx, cy, rr * 0.4);
  gfx.lineStyle(2.4, P.INK, 0.9);
  gfx.strokeCircle(cx, cy, rr * 0.4);

  const lx0 = x - w * 0.54;
  const lx1 = x - w * 0.02;
  const ly = gy - baseH - 2 * k;
  const n = clamp(Math.round((lx1 - lx0) / 8), 4, 6);
  const th = 6.5 * k;
  gfx.fillStyle(TAPE_BLADE, 0.95);
  gfx.lineStyle(2.2, P.INK, 0.95);
  gfx.beginPath();
  gfx.moveTo(lx0, ly + 5 * k);
  for (let i = 0; i < n; i++) {
    const mx = lx0 + ((i + 0.5) * (lx1 - lx0)) / n;
    const ex = lx0 + ((i + 1) * (lx1 - lx0)) / n;
    gfx.lineTo(mx + wob(mx, seed + i) * 0.4, ly - th);
    gfx.lineTo(ex, ly + wob(ex, seed + i) * 0.4);
  }
  gfx.lineTo(lx1, ly + 5 * k);
  gfx.closePath();
  gfx.fillPath();
  gfx.strokePath();
  // The blade lip reaches further left than the base; the reel sets the top,
  // and on a tall box that top is well SHORT of the height the map asked for —
  // `baseH` caps at h − rr·1.5 and the housing takes the rest.
  return {
    x: x - w * 0.54, y: gy - baseH - rr * 1.45,
    w: w * 1.04, h: baseH + rr * 1.45,
  };
}

/** Reel radius, housing height, and where the reel sits. The reel's radius is
 *  bounded by the WIDTH, so on a tall box it does not grow and the housing takes
 *  the remainder (the 3D `tapeLayout`'s ruling, verbatim). */
function tapeLayout(b: PaperBox) {
  const rr = Math.max(6 * b.k, Math.min(b.w * 0.30, b.h * 0.34));
  const baseH = Math.max(b.h * 0.4, b.h - rr * 1.5);
  return { rr, baseH, cx: b.x + b.w * 0.10, cy: b.gy - baseH - rr * 0.45 };
}

/**
 * Industrial at night: the hub of the reel.
 *
 * "The bore through the middle of a tape roll — the industrial district's one
 * light, and the only warm colour on the machine… the whole part glows (the
 * machine has not stopped), it is not a grid of windows." That is the 3D
 * `tapeHubMaterial`'s note, and this is one circle.
 */
function tapeHubLight(gfx: Phaser.GameObjects.Graphics, b: PaperBox): void {
  const L = tapeLayout(b);
  gfx.fillStyle(TAPE_HUB_GLOW, 0.8);
  gfx.fillCircle(L.cx, L.cy, L.rr * 0.55);
}

/**
 * School — three office file boxes, stacked.
 *
 * The side elevation of the 3D world's `fileBoxSchool`: one solid mass divided
 * into three by three lid courses, with a row of hand-holes and coloured bezels
 * across the front of each box. At distance it is THREE HORIZONTAL BANDS with a
 * row of coloured slots, which is a rhythm nothing else in this world has — the
 * other four are all single masses.
 *
 * ── What a side view can and cannot show, and what was therefore dropped ──
 *
 * Three of the 3D body's features are NOT drawn here, each for a measured
 * reason rather than to save work:
 *
 *  1. **The lid's overhang.** 3D steps every lid 0.7 m proud of its box. This
 *     renderer's bodies are 29–117 px wide and stand for footprints tens of
 *     metres across, so that step lands at ≤ 1.8 px a side — and `wob` jitters
 *     every corner by ±0.8 px on its own. A step smaller than the wobble is
 *     noise. So a lid here is a FULL-WIDTH band a shade darker, not a ledge:
 *     what the eye is being sold is three lines, and three darker bands are
 *     those three lines.
 *  2. **The 0.28 m recess behind each hole.** An orthographic elevation has no
 *     perspective, so a depth step is exactly zero pixels. The dark fill says
 *     "hole" by itself; nothing else is needed and nothing else would show.
 *  3. **The holes on the far face.** 3D puts them on both long faces because its
 *     oriented box does not know which one the rider will see. An elevation has
 *     one face.
 *
 * And one thing is drawn DIFFERENTLY: the bezel is a single closed coloured
 * outline, not the 3D body's four separate bars. On a 5–15 px slot four
 * filled-and-stroked quads are eight draw commands that read exactly like one
 * stroke.
 *
 * ⚠ There are ALWAYS three boxes. A lid band that shrinks to 1 px degrades into
 * an ink rule on its own, which is the right answer, so there is no "too small
 * to divide" threshold — the only thing that drops out is the holes.
 */
function fileBoxes(
  gfx: Phaser.GameObjects.Graphics, b: PaperBox, colorIndex: number, seed: number,
): DrawnBox {
  const { x, gy, w, h } = b;
  const L = fileBoxLayout(b);

  // The mass: ONE outline for the whole stack, solid. Each box does NOT get its
  // own 3 px pen — the division is the lid bands below, and outlining every box
  // as well turns a short stack into a black smear.
  gfx.fillStyle(FILE_BOX, 0.9);
  gfx.lineStyle(3, P.INK, 0.95);
  wobQuad(gfx, x, gy, w, h, seed + 4);
  gfx.fillPath();
  gfx.strokePath();

  for (let t = 0; t < L.tiers; t++) {
    const top = gy - (t + 1) * L.tierH;
    // A darker full-width band plus ONE ink rule along its top edge, not an ink
    // outline all the way round. Same argument as the eraser's film: at 1–2 px a
    // 2.2 px pen swallows the band whole, and a closed stroke is four draw
    // commands where a rule is one (measured: dropping the outline here and the
    // ink round each slot below took this body from 39 to 26 prims on a 15 × 25
    // box). The band's own boundary against the mass is its bottom edge; the rule
    // is the seam where the lid clips on.
    gfx.fillStyle(FILE_LID, 0.92);
    wobQuad(gfx, x, top + L.lidH, w, L.lidH, seed + 7 + t * 3);
    gfx.fillPath();
    gfx.lineStyle(1.6, P.INK, 0.7);
    gfx.lineBetween(
      x - w / 2 + wob(x, seed + 7 + t), top, x + w / 2 + wob(x + 40, seed + 7 + t), top,
    );

    if (!L.holes) continue;
    const ring = RING_COLORS[fileRingColorIndex(t, colorIndex)];
    for (let k = 0; k < L.holes.n; k++) {
      const p = fileHandle(b, L, t, k);
      // Fill only. The coloured bezel sits immediately outside it and IS its
      // outline; an ink stroke as well is the same edge drawn twice.
      gfx.fillStyle(FILE_HOLE, 0.9);
      wobQuad(gfx, p.x, p.y + L.holes.h / 2, L.holes.w, L.holes.h, seed + 21 + t * 5 + k);
      gfx.fillPath();
      gfx.lineStyle(2.2, ring, 0.95);
      wobQuad(gfx, p.x, p.y + L.holes.h / 2 + L.holes.rw,
        L.holes.w + L.holes.rw * 2, L.holes.h + L.holes.rw * 2, seed + 33 + t * 5 + k);
      gfx.strokePath();
    }
  }
  return { x: x - w / 2, y: gy - h, w, h };
}

/**
 * The stack's divisions and its handle row — or `holes: null` when the slots
 * would be smaller than the pen drawing them. Shared with `handleRingLights` for
 * the reason the 3D `fileBoxLayout` is shared with `fileHandleLights` over
 * there: the lit bezels have to BE bezels that were drawn.
 *
 * `tiers` is a FLAT 3, exactly as in 3D, and `lidH` carries the same
 * `min(fixed, tierH * f)` shape so a short box never gets a lid taller than its
 * own body.
 */
function fileBoxLayout(b: PaperBox) {
  const { w, h, k } = b;
  const tiers = FILE_TIERS;
  const tierH = h / tiers;
  const lidH = Math.min(3.4 * k, tierH * 0.34);
  const bodyH = tierH - lidH;
  // A COUNT, so it divides a plain pixel pitch and not `k` — see BODY_SHAPE.
  //
  // ⚠ It cannot be the 3D world's `max(1, round(w / 22))` even in spirit,
  // because this renderer never sees the footprint's width:
  // `terrain-builder.renderBuilding` sets `widthPx = max(15, min(40, heightPx *
  // 0.6))`, i.e. the drawn width is a clamped function of the HEIGHT. A 82 m
  // school and a 15 m one both arrive here 15–40 px wide. So the pitch here is a
  // pixel pitch with no metric meaning, the counts legitimately differ between
  // the two renderers, and what `check:3d` binds across them is the handle
  // LAYOUT (evenly spaced, centred in its cell) rather than the number.
  const n = Math.max(1, Math.round(w / 26));
  const cellW = w / n;
  const slotW = Math.min(cellW * 0.30, bodyH * 1.25, 16);
  const slotH = slotW * 0.28;
  const rw = Math.min(1.6, slotH * 0.42);
  return {
    tiers, tierH, lidH, bodyH,
    // Below 1.4 px a slot plus a bezel is a smudge, and the three banded boxes
    // still read as a stack of boxes without it.
    holes: slotH < 1.4 ? null : { n, cellW, w: slotW, h: slotH, rw },
  };
}

/** Which of the four bezel colours box `t` wears. Both renderers use this exact
 *  expression, which is what makes "the lit box is the amber one" the same
 *  statement in each. */
function fileRingColorIndex(t: number, c0: number): number {
  return (c0 + t) % RING_COLORS.length;
}

/** Where handle `k` of box `t` sits — bottom-centre of the slot. `0.4` of the
 *  box's own body band above its lid line puts it in the UPPER half of the box,
 *  which is where a hand-hole is because that is where you grip. */
function fileHandle(
  b: PaperBox, L: ReturnType<typeof fileBoxLayout>, t: number, k: number,
): { x: number; y: number } {
  const holes = L.holes!;
  return {
    x: b.x - b.w / 2 + (k + 0.5) * holes.cellW,
    y: b.gy - (t + 1) * L.tierH + L.lidH + L.bodyH * 0.4,
  };
}

/**
 * School at night: one whole bezel colour, on bezels that are already there.
 *
 * The 3D `fileHandleLights`'s rule, unchanged — and because a box's colour is
 * `(c0 + tier) % 4`, "one colour" is ONE WHOLE BOX of handles, a different box
 * on every school. What glows is the bezel OUTLINE, so this is a stroke widened
 * into a halo rather than a filled patch over the hole.
 *
 * Bounded at holes × 3 layers, so at most twelve fills on the widest stack this
 * body ever draws.
 */
function handleRingLights(
  gfx: Phaser.GameObjects.Graphics, b: PaperBox, colorIndex: number, seed: number,
): void {
  const L = fileBoxLayout(b);
  if (!L.holes) return;
  for (let t = 0; t < L.tiers; t++) {
    if (fileRingColorIndex(t, colorIndex) !== RING_LIT_INDEX) continue;
    for (let k = 0; k < L.holes.n; k++) {
      const p = fileHandle(b, L, t, k);
      // ONE spreading stroke then the core — §3.10's「小亮點 + 半透明的殼」in the
      // cheapest form that still has two layers. A FILLED rectangle would light
      // the dark hole along with the bezel and the ring would stop being a ring;
      // the eraser's film affords three halo layers because it is one band per
      // building, where this is one per hole per lit box (measured: three layers
      // put the school's night mean at 30 additive prims on the widest stack,
      // two put it at 20, against 294 for the grid this replaces).
      gfx.lineStyle(L.holes.rw * 4.2, RING_GLOW, 0.22);
      wobQuad(gfx, p.x, p.y + L.holes.h / 2 + L.holes.rw,
        L.holes.w + L.holes.rw * 2, L.holes.h + L.holes.rw * 2, seed + 33 + t * 5 + k);
      gfx.strokePath();
      gfx.lineStyle(L.holes.rw * 1.6, RING_GLOW, 0.9);
      wobQuad(gfx, p.x, p.y + L.holes.h / 2 + L.holes.rw,
        L.holes.w + L.holes.rw * 2, L.holes.h + L.holes.rw * 2, seed + 33 + t * 5 + k);
      gfx.strokePath();
    }
  }
}

/**
 * Hospital — the pill / sticking-plaster box.
 *
 * A white carton whose lid is hinged at the top-right corner and thrown back up
 * and to the left. That diagonal is the whole identity: without it this is
 * another white box, and white is the one thing that already separates it from
 * its neighbours, so the shape has to earn its place too. The lid is given a
 * THICKNESS rather than being a single stroke — a flat flap reads as a crack in
 * the box rather than a lid standing open.
 *
 * The mark is a red TRIANGLE, drawn with the same wobbled-corner, ink-outlined
 * language as everything else — never a red cross (see `PILL_MARK`) and never a
 * glyph from a font.
 */
function pillBox(
  gfx: Phaser.GameObjects.Graphics, b: PaperBox, _colorIndex: number, seed: number,
): DrawnBox {
  const { x, gy, w, h, k } = b;

  gfx.fillStyle(PILL_WHITE, 0.95);
  gfx.lineStyle(3, P.INK, 0.95);
  wobQuad(gfx, x, gy, w, h, seed + 6);
  gfx.fillPath();
  gfx.strokePath();
  // The carton's two side folds — faint, but they are what makes the white a
  // BOX rather than a sheet.
  gfx.lineStyle(1.5, P.INK, 0.22);
  gfx.lineBetween(x - w * 0.34, gy - h + 4 * k, x - w * 0.34 + wob(x, seed + 3), gy - 3 * k);
  gfx.lineBetween(x + w * 0.34, gy - h + 4 * k, x + w * 0.34 + wob(x, seed + 9), gy - 3 * k);

  const lid = pillLid(b, seed);
  gfx.fillStyle(PILL_LID, 0.95);
  gfx.lineStyle(2.8, P.INK, 0.95);
  gfx.beginPath();
  gfx.moveTo(lid.pts[0].x, lid.pts[0].y);
  for (let i = 1; i < lid.pts.length; i++) gfx.lineTo(lid.pts[i].x, lid.pts[i].y);
  gfx.closePath();
  gfx.fillPath();
  gfx.strokePath();

  const cs = Math.min(w * 0.62, h * 0.6);
  const ccy = gy - h * 0.42;
  const j = (n: number): number => wob(x + n * 29, seed + 13 + n) * 0.9;
  gfx.fillStyle(PILL_MARK, 0.92);
  gfx.lineStyle(2.2, P.INK, 0.9);
  gfx.beginPath();
  gfx.moveTo(x + j(1), ccy - cs * 0.58 + j(2));
  gfx.lineTo(x + cs * 0.5 + j(3), ccy + cs * 0.42 + j(4));
  gfx.lineTo(x - cs * 0.5 + j(5), ccy + cs * 0.42 + j(6));
  gfx.closePath();
  gfx.fillPath();
  gfx.strokePath();
  // The thrown-back lid is the only thing standing above the carton, and it
  // leans INWARD, so the width is the carton's.
  return { x: x - w / 2, y: gy - h - lid.up, w, h: h + lid.up };
}

/** The lid, hinged at the carton's top-right corner and thrown back up and to
 *  the left, as a four-point path plus how far above the carton it reaches.
 *
 *  Shared with `pillLidLight`. The lid is the pill box's whole identity ("that
 *  diagonal… without it this is another white box"), and it is what the night
 *  layer lights — so a second guess at its corners would light a flap that is
 *  not where the flap is. */
function pillLid(b: PaperBox, seed: number) {
  const { x, gy, w, h, k } = b;
  const a = 0.52;                 // how far the lid is thrown back, radians
  const lw = w * 0.6;
  const lt = 7 * k;               // lid thickness
  const ux = -Math.cos(a);
  const uy = -Math.sin(a);
  const nx = -Math.sin(a);        // the lid's own normal, for the thickness
  const ny = Math.cos(a);
  const hx = x + w / 2 + wob(x, seed + 2);
  const hy = gy - h + wob(x, seed + 4);
  return {
    up: -uy * lw,
    pts: [
      { x: hx, y: hy },
      { x: hx + ux * lw + wob(x, seed + 11) * 0.5, y: hy + uy * lw + wob(x, seed + 12) * 0.5 },
      { x: hx + ux * lw + nx * lt, y: hy + uy * lw + ny * lt },
      { x: hx + nx * lt, y: hy + ny * lt },
    ],
  };
}

/**
 * Hospital at night: the inside of the open lid.
 *
 * The 3D box lights every OTHER compartment of its lid ("all of them lit would
 * be one light bar"), but 2D's lid is a single flap — the compartments are a
 * detail only the 3D lid is big enough to carry, and inventing a row of cells
 * at night that nothing draws by day is the failure this system exists to stop.
 * So the flap itself carries the light: one filled quad, and the light comes off
 * the part that was already the building's identity.
 */
function pillLidLight(
  gfx: Phaser.GameObjects.Graphics, b: PaperBox, seed: number,
): void {
  const lid = pillLid(b, seed);
  gfx.fillStyle(PILL_LID_GLOW, 0.5);
  gfx.beginPath();
  gfx.moveTo(lid.pts[0].x, lid.pts[0].y);
  for (let i = 1; i < lid.pts.length; i++) gfx.lineTo(lid.pts[i].x, lid.pts[i].y);
  gfx.closePath();
  gfx.fillPath();
}

// ── The shop sign: an embossed label tape ──────────────────────────────────

/**
 * The five districts' colours — the demo's `ZONE_COLOR_PAINTED`.
 *
 * Gouache-muddied rather than poster-bright, and the two annotations the demo
 * attaches are load-bearing because they are about the GROUND band, where these
 * sit at 0.6 over terrain green: slate-violet is the darkest of the five on
 * purpose (「0.6 疊在地形綠上會把一切拉回綠,分區只能靠明度差拉開,不能只靠色相」)
 * and bone-pink the lightest, so the set separates by VALUE and not only by hue.
 * The same five paint the label tape, so the band under a shop and the tape on
 * its wall are one statement.
 */
const ZONE_COLOR: Record<ZoneKind, number> = {
  residential: 0xc9a15e,   // ochre
  commercial: 0xc2603c,    // brick orange
  industrial: 0x4a4d64,    // slate violet-grey
  school: 0x3f8f8c,        // rusted teal
  hospital: 0xeabbb0,      // bone pink
};

/** The plastic pulled white where the machine pressed a letter through it — the
 *  demo's `emboss`. NOT pure white: nothing in this world is, and pure white
 *  jumps off watercolour paper. */
const EMBOSS = 0xf5eeda;


/** Sign width ceiling, px — the demo's `SIGN_MAX_W`. Its own reasoning: the
 *  narrowest body in this world is about 40 px, so a ceiling under that is what
 *  keeps a tape from covering a whole wall. */
const SIGN_MAX_W = 46;

/**
 * The demo's `HOUSE_BODY` `ox` / `lo` / `hi` — where each body wants its sign.
 *
 * `ox` is a horizontal offset in units of the body's own width, and every
 * non-zero one is dodging that body's identifying mark: the shop front's right
 * doorway, the tape dispenser's right-hand reel. `lo` / `hi` narrow the
 * 0.55–0.70 hanging band; the pill box's 0.68–0.70 is the extreme case and the
 * demo says why — its printed red triangle reaches to about 0.7, so a tape hung
 * any lower cuts across the triangle's waist and the two reds merge.
 *
 * The demo's `w` / `h` from the same table are NOT repeated here: they are
 * already `BODY_SHAPE`, which `bodyBox` applies.
 */
const SIGN_BAND: Record<PaperBody, { ox: number; lo: number; hi: number }> = {
  eraser: { ox: 0, lo: 0.55, hi: 0.70 },
  shop: { ox: -0.06, lo: 0.60, hi: 0.70 },
  tape: { ox: -0.08, lo: 0.55, hi: 0.70 },
  // The file box does not take a seeded draw at all: its tape goes on the MIDDLE
  // box's lid rim, the same anchor the 3D world's `signAnchor` names
  // (`2h/3 − lidH/2`). `lo`/`hi` are the band that anchor moves inside as the
  // stack's lid scales — asserted, so a retune that leaves the band cannot
  // silently leave the DEVPLAN range with it.
  fileBox: { ox: 0, lo: 0.610, hi: 0.667 },
  pill: { ox: 0, lo: 0.68, hi: 0.70 },
};

/**
 * The exact height the file box wants its tape at, as a fraction of the body —
 * the middle box's lid rim.
 *
 * The 3D world states the case in `signAnchor`: a body with a LEDGE the label
 * belongs on has to name the height, because a seeded draw inside a band lands
 * on the rim once in a while and misses the rest of the time. Same body, same
 * ledge, same answer.
 *
 * `ox` stays 0 to match 3D, and that costs the middle box's handle: 3D floats
 * its plate 0.8 m clear so it only clips the slot's top edge, while a flat
 * elevation covers it outright. Two of the three handle rows still read, and the
 * night glow is on the ADD-blended layer so it comes through the tape anyway.
 */
function fileBoxSignFrac(b: PaperBox): number {
  const L = fileBoxLayout(b);
  return (2 * L.tierH - L.lidH / 2) / b.h;
}

/**
 * The carrier is a **label-maker's embossed plastic tape** — the demo's
 * `drawLabelTape`.
 *
 * *Not a sticky note*: the sticky-note shopfront is already the commercial
 * BODY, and one component may only have one identity (法則 3.3).
 *
 * Everything is this file's existing hand-drawn vocabulary and nothing new was
 * introduced for it: a `wob`bled outline, an ink pen line, translucent
 * watercolour. The rounded ends are CUT corners rather than arcs, because a
 * hand-drawn radius is a couple of straight cuts — a true arc reads as printed.
 *
 * It is stuck flat on the facade, not hung out on a bracket: adhesive carriers
 * go on the wall. That is also what keeps it clear of the awning's scallops and
 * the pill box's thrown-back lid. (On a file box it does NOT clear the middle
 * box's handle — see `fileBoxSignFrac`, where that trade is stated.)
 */
function labelTape(
  gfx: Phaser.GameObjects.Graphics,
  b: PaperBox, kind: PaperBody, seed: number, zone: ZoneKind,
  posts: readonly number[],
  vocabulary: SignVocabulary,
): void {
  const band = SIGN_BAND[kind];
  const grow = b.k;
  const x0 = b.x + b.w * band.ox;
  // A body that names its own anchor gets it; everything else takes the seeded
  // draw inside its band. Only the HEIGHT is named — the plate's width, ratio and
  // glyphs stay `signPlacement`'s and the carrier's, so a body cannot shrink its
  // sign out of legibility here.
  const anchor = kind === 'fileBox' ? fileBoxSignFrac(b) : null;
  const place = signPlacement(b.w, b.h, seed, SIGN_MAX_W * grow,
    anchor ?? band.lo, anchor ?? band.hi);
  // The demo's own legibility floor —「太小就讀不出字,寧可不掛」— at a FLAT 15 px.
  //
  // ⚠ The demo writes `15 * grow`, and copying that literally is the one place
  // this port had to stop copying. In the demo `grow` is the ENTRANCE animation
  // (0 → 1, and 1 for the entire ride), so its floor is 15 px; here `k` is a
  // permanent "how much smaller than the demo's prop is this footprint", so
  // `15 * k` on the default 8 m OSM shop is a floor of 4 px and the body grew an
  // 11 px tape with four letters pressed into it. `SIGN_MAX_W * k` above KEEPS
  // the scaling, because that one is asking a different question — how big may
  // this sign be — and a 26 px shopfront should not carry the demo's full 46 px
  // tape. Same conclusion circuit-style reached from the other direction with
  // `SIGN_MIN_BOX_H`: OSM footprints are adjacent, so an unfloored sign turns a
  // street into soup.
  if (!place || place.width < 15) return;

  const S = { w: place.width, h: place.height, cy: b.gy - place.centerY };
  const x = x0 + signShift(x0, b.w, S.w, posts);
  const L = x - S.w / 2, R = x + S.w / 2, T = S.cy - S.h / 2, B = S.cy + S.h / 2;
  const r = Math.min(S.h * 0.40, S.w * 0.10);
  const j = (n: number): number => wob(x + n * 23, 5.5 + n) * 0.7;

  // Eight points: a long rounded strip with one cut taken off each corner.
  const strip = (dx: number, dy: number): void => {
    gfx.beginPath();
    gfx.moveTo(L + r + dx + j(1), T + dy + j(2));
    gfx.lineTo(R - r + dx + j(3), T + dy + j(3));
    gfx.lineTo(R + dx + j(4), T + r + dy + j(4));
    gfx.lineTo(R + dx + j(5), B - r + dy + j(5));
    gfx.lineTo(R - r + dx + j(6), B + dy + j(6));
    gfx.lineTo(L + r + dx + j(7), B + dy + j(7));
    gfx.lineTo(L + dx + j(8), B - r + dy + j(8));
    gfx.lineTo(L + dx + j(9), T + r + dy + j(9));
    gfx.closePath();
  };

  // The shadow the 8° tilt drops on the wall — the tilt itself is invisible in
  // an orthographic side view, this is what you actually see of it.
  gfx.fillStyle(P.INK, 0.2);
  strip(2.4 * grow, 3.4 * grow);
  gfx.fillPath();
  // The tape, in the district's colour.
  gfx.fillStyle(ZONE_COLOR[zone], 0.94);
  gfx.lineStyle(2.6, P.INK, 0.95);
  strip(0, 0);
  gfx.fillPath();
  gfx.strokePath();
  // …and the lit top face, the other half of the tilt.
  gfx.fillStyle(PAPER_CREAM, 0.32);
  gfx.fillRect(L + r * 0.7, T + 1.2, S.w - r * 1.4, Math.max(1.3, S.h * SIGN_TOPFACE));
  // The two grooves the machine rolls into the tape's edges.
  gfx.lineStyle(1.3, P.INK, 0.26);
  gfx.beginPath();
  gfx.moveTo(L + r, T + 2.6 + j(2) * 0.5); gfx.lineTo(R - r, T + 2.6 + j(3) * 0.5);
  gfx.moveTo(L + r, B - 2.6 + j(6) * 0.5); gfx.lineTo(R - r, B - 2.6 + j(7) * 0.5);
  gfx.strokePath();

  const content = signContent(zone, seed, 'cuphead', vocabulary);
  if (content?.symbol === 'triangle') {
    const p = signTriPoints(x, S.cy, S.h);
    gfx.fillStyle(P.INK, 0.4);
    gfx.fillTriangle(
      p[0] + 1.1 * grow, p[1] + 1.3 * grow, p[2] + 1.1 * grow, p[3] + 1.3 * grow,
      p[4] + 1.1 * grow, p[5] + 1.3 * grow,
    );
    gfx.fillStyle(PILL_MARK, 0.95);
    gfx.fillTriangle(p[0], p[1], p[2], p[3], p[4], p[5]);
    // The embossed ridge all the way round. The pill box already carries a
    // printed red triangle, and without this white rule the two merge into one
    // shape at riding distance.
    gfx.lineStyle(1.5, EMBOSS, 0.8);
    gfx.beginPath();
    gfx.moveTo(p[0], p[1]); gfx.lineTo(p[2], p[3]); gfx.lineTo(p[4], p[5]); gfx.lineTo(p[0], p[1]);
    gfx.strokePath();
    return;
  }
  if (!content?.text) return;
  // Embossing is TWO passes of the same strokes: the valley the letter was
  // pressed into (down-right, dark) and the ridge of stretched plastic on top.
  // `sign-spec` is plate-local with +y UP (Three's convention); 2D negates y.
  const qs = signStrokes(S.w, S.h, content.text).map((q) => ({
    x0: x + q.x0, y0: S.cy - q.y0, x1: x + q.x1, y1: S.cy - q.y1, t: q.width,
  }));
  gfx.fillStyle(P.INK, 0.42);
  for (const q of qs) signStroke(gfx, q.x0, q.y0, q.x1, q.y1, q.t, 1.1 * grow, 1.3 * grow);
  gfx.fillStyle(EMBOSS, 0.96);
  for (const q of qs) signStroke(gfx, q.x0, q.y0, q.x1, q.y1, q.t);
}

export function createCupheadStyle(): PhaserStyleStrategy {
  return {
    style: 'cuphead',
    cloudsOnSunny: true, // a 1930s cartoon sky always has ink clouds in it
    // The module-level table, by reference — see `applyPaintMode`. Handing back
    // a fresh copy here would freeze whichever mode the strategy happened to be
    // built in, which is precisely what a live toggle must not do.
    palette: PALETTE,

    // ── Terrain ──

    /**
     * Terrain surface — and, on entry, the animation of it being *drawn*:
     * an ink pen strokes the outline left-to-right (0–1.1 s), watercolour
     * washes brush in behind it one layer at a time (from 0.7 s), then the
     * hatch shading fades up (1.7 s). The plastic world drops into place;
     * this one gets painted.
     */
    drawTerrainSurface(gfxIn, points, bottomY, seed, intro) {
      const gfx = paper(gfxIn);
      if (points.length < 2) return;
      const wobble = generateWobbleOffsets(points.length, seed, 1.8);
      const wobbly = points.map((pt, i) => ({
        x: pt.x + (wobble[i]?.dx ?? 0),
        y: pt.y + (wobble[i]?.dy ?? 0),
      }));

      // Steady state IS the intro's final frame — same washes, same pen line —
      // so the animation ends without a visible switch of rendering paths.
      if (!intro) {
        for (const wash of WASHES) fillWash(gfx, wobbly, bottomY, wash);
        strokeTerrainInk(gfx, wobbly);
        drawTerrainHatch(gfx, wobbly, bottomY, 1);
        drawScatteredTrees(gfx, wobbly, null);
        return;
      }

      // The reveal sweeps from where the view started, not from the (moving)
      // left edge of the current point list.
      const sweepFrom = intro.originX - 70;
      const sweepSpan = (wobbly[wobbly.length - 1].x - sweepFrom) + 140;

      // ── Watercolour washes (three layers, brushed in one after another) ──
      for (let i = 0; i < WASHES.length; i++) {
        const wash = WASHES[i];
        const k = (intro.t - 0.7 - i * 0.45) / 0.9;
        if (k <= 0) continue;

        let layer = wobbly;
        let brushX: number | null = null;
        if (k < 1) {
          brushX = sweepFrom + sweepSpan * easeOutCubic(k);
          layer = wobbly.filter((p) => p.x <= brushX!);
          if (layer.length < 2) continue;
        }

        fillWash(gfx, layer, bottomY, wash);

        // Wet brush head: a blob of pigment with a drag mark behind it.
        if (brushX !== null) {
          const tip = layer[layer.length - 1];
          gfx.fillStyle(wash.color, 0.55);
          gfx.fillEllipse(tip.x, tip.y + wash.dy + 6, 34, 16);
          gfx.fillStyle(wash.color, 0.3);
          gfx.fillEllipse(tip.x - 14, tip.y + wash.dy + 20, 26, 12);
        }
      }

      // ── Ink outline, drawn by a travelling pen nib ──
      const inkK = intro.t / 1.1;
      let inkPts = wobbly;
      let nib: { x: number; y: number } | null = null;
      if (inkK < 1) {
        const cutX = sweepFrom + sweepSpan * easeOutCubic(inkK);
        inkPts = wobbly.filter((p) => p.x <= cutX);
        nib = inkPts.length > 0 ? inkPts[inkPts.length - 1] : null;
      }
      if (inkPts.length >= 2) strokeTerrainInk(gfx, inkPts);
      if (nib) {
        gfx.fillStyle(P.INK, 1);
        gfx.fillCircle(nib.x, nib.y, 3.5);
        gfx.lineStyle(3, P.INK, 0.9);
        gfx.lineBetween(nib.x, nib.y, nib.x + 14, nib.y - 22); // pen shaft
      }

      // ── Hatch shading, fading up once the paint is down ──
      const hatchA = Math.min(1, Math.max(0, (intro.t - 1.7) / 0.6));
      if (hatchA > 0) drawTerrainHatch(gfx, wobbly, bottomY, hatchA);

      // ── Trees grow in last, staggered ──
      drawScatteredTrees(gfx, wobbly, intro.t);
    },

    drawOverlay(scene) {
      // scale.width/height 跟隨 resize;game.config 是建立當下的尺寸,永不更新
      const w = scene.scale.width;
      const h = scene.scale.height;

      // Generate film grain texture
      if (scene.textures.exists(GRAIN_TEXTURE_KEY)) {
        scene.textures.remove(GRAIN_TEXTURE_KEY);
      }
      const grainCanvas = generateFilmGrainCanvas(w, h, 0.5);

      // Add warm tint to the grain
      const ctx = grainCanvas.getContext('2d')!;
      const r = (P.GRAIN_TINT >> 16) & 0xff;
      const g = (P.GRAIN_TINT >> 8) & 0xff;
      const b = P.GRAIN_TINT & 0xff;
      ctx.fillStyle = `rgba(${r},${g},${b},${P.GRAIN_ALPHA})`;
      ctx.fillRect(0, 0, w, h);

      scene.textures.addCanvas(GRAIN_TEXTURE_KEY, grainCanvas);
      grainImage = scene.add.image(w / 2, h / 2, GRAIN_TEXTURE_KEY);
      grainImage.setAlpha(0.8);
      // 2× overscan: camera-lift zoom-out scales scrollFactor(0) layers too;
      // without this the grain would shrink and leave clean borders.
      grainImage.setScale(2);

      // Both overlay pieces ride in one container (drawOverlay returns a
      // single object that the scene destroys/recreates on resize). Children
      // of a container follow ITS scrollFactor, so it carries the (0, 0).
      const container = scene.add.container(0, 0, [grainImage]);
      container.setScrollFactor(0);
      container.setDepth(999);

      // Iris vignette — the 1930s picture-frame darkening at the corners.
      // Game mode already gets a vignette from the cycling-glasses PostFX;
      // doubling them up goes muddy, so the iris only draws on welcome.
      const mode = (scene as Partial<{ sceneMode: string }>).sceneMode;
      if (mode === 'welcome') {
        if (scene.textures.exists(IRIS_TEXTURE_KEY)) {
          scene.textures.remove(IRIS_TEXTURE_KEY);
        }
        const tex = scene.textures.createCanvas(IRIS_TEXTURE_KEY, w, h);
        if (tex) {
          const ictx = tex.getContext();
          const grad = ictx.createRadialGradient(
            w / 2, h / 2, Math.min(w, h) * 0.42,
            w / 2, h / 2, Math.max(w, h) * 0.78,
          );
          grad.addColorStop(0, 'rgba(42,36,32,0)');   // P.INK, transparent
          grad.addColorStop(1, 'rgba(42,36,32,0.5)'); // P.INK at the corners
          ictx.fillStyle = grad;
          ictx.fillRect(0, 0, w, h);
          tex.refresh();
          const iris = scene.add.image(w / 2, h / 2, IRIS_TEXTURE_KEY);
          iris.setScale(2); // 2× overscan, same reason as the grain
          container.add(iris);
        }
      }

      return container;
    },

    updateOverlay(frameCount) {
      if (!grainImage) return;
      // Shift grain position every 4 frames for flickering effect
      if (frameCount % 4 === 0) {
        const shift = (frameCount / 4) % 4;
        grainImage.setPosition(
          grainImage.x + (shift === 0 ? 0 : shift === 1 ? 1 : shift === 2 ? -1 : 0),
          grainImage.y + (shift === 0 ? 1 : shift === 1 ? 0 : shift === 2 ? 0 : -1),
        );
      }
    },

    // ── Background features ──

    /**
     * A building, biased by the district it stands in.
     *
     * Five bodies for the five land-use zones (see the "Zone-driven building
     * bodies" section above), and the generic block below for everything
     * outside them. Unzoned is NOT residential: it is most of a real route.
     *
     * Measured draw commands per BODY (Phaser calls; a stroked closed path counts
     * one per edge — `sink.cmds.length` in `phaser-stub.mjs`), across the boxes
     * `terrain-builder` actually makes. The label tape is NOT in these numbers:
     * it costs 19 commands with a symbol on it and about 150 with four letters,
     * it is the same tape on every body that carries one, and it is the district
     * that decides whether there is one at all.
     *
     *            15×25   24×40   40×72   40×150   40×300
     *   eraser      14      14      22       30       30
     *   shop        51      51      57       58       58
     *   tape        22      22      22       22       22
     *   fileBox     26      41      56       56       56
     *   pill        16      16      16       16       16
     *   generic     40      53     112      210      397
     *
     * Every zone body is cheaper than the generic it replaces, and all five are
     * BOUNDED in the height, where the generic's window grid is linear in it —
     * a 125 m tower costs the generic ~397 commands and the dearest zone body
     * 58. The two that cost most on a SMALL box are the shop (51 vs 40) and the
     * file box (26 vs 40, i.e. still under it): the shop's fan-folded awning is
     * five filled-and-stroked paths and is the whole silhouette, so it is the
     * one place worth paying 1.3× the generic on the commonest footprint size.
     *
     * ⚠ Three rows moved when the abacus became a file-box stack, and only one
     * of the three is that change:
     *  · `abacus 21 21 45 79 79` → `fileBox 26 41 56 56 56`. Dearer on a small
     *    or medium box (three banded boxes with a handle row each, where a small
     *    abacus was a frame with its beads dropped) and CHEAPER on a tall one,
     *    because the stack is three boxes at any height while the abacus grew
     *    bead rows. Its ceiling is 56 against the abacus's 79.
     *  · `generic 38 51 110 208 395` → `40 53 112 210 397`. Not a code change at
     *    all: `phaser-stub.mjs` made `strokePath` honour `closePath`, which adds
     *    the closing edge of the generic body's ink rectangle. Re-measured rather
     *    than left, because a table nobody re-measures is a table that drifts.
     *  · shop and pill are unchanged at every size, which is the control: the two
     *    bodies this round did not touch measure exactly what they measured
     *    before.
     *
     * The generic is left alone. It is what an unzoned country road gets, where
     * buildings are few and short — the expensive tall case is a city, and a
     * city has zones.
     *
     * Four of these five deliberately draw SHORTER than the box they were
     * handed, so every one of them reports what it actually drew (see
     * `DrawnBox`). That was `plan/migrate-demo-worlds.md` §3.8: the night
     * window-glow grid `terrain-builder` used to paint was computed over the
     * NOMINAL box, and at the 40 × 300 extreme the drawn heights are eraser 300,
     * pill 234, fileBox 117, tape 135, shop 99 — so a tall shop carried 200 px of
     * glow floating in the sky above it. It is doubly fixed now: the grid lands
     * on the reported extent, and it no longer runs on these bodies at all,
     * because `renderBuildingLights` below says where each one lights.
     */
    renderBuilding(gfxIn, x, y, w, h, colorIndex, seed, zone, posts = [], vocabulary = 'shop') {
      const gfx = paper(gfxIn);
      const kind = bodyFor(seed, zone);
      if (kind) {
        const b = bodyBox(kind, x, y, w, h);
        const drawn = kind === 'eraser' ? eraserHouse(gfx, b, colorIndex, seed)
          : kind === 'shop' ? tabStand(gfx, b, colorIndex, seed)
            : kind === 'tape' ? tapeDispenser(gfx, b, colorIndex, seed)
              : kind === 'fileBox' ? fileBoxes(gfx, b, colorIndex, seed)
                : pillBox(gfx, b, colorIndex, seed);
        // The sign hangs on the DISTRICT, not on the body: a borrowed eraser
        // house standing in a commercial block gets one too, or「這一段是商店街」
        // is left to the ground band alone. Residential and industrial get none.
        //
        // NOT unioned into the reported box: a label tape is stuck flat on the
        // wall and adds no solid mass, and `DrawnBox` is the solid mass.
        if (zone && SIGN_ZONES.has(zone)) labelTape(gfx, b, kind, seed, zone, posts, vocabulary);
        return drawn;
      }

      const color = P.BUILDING_COLORS[colorIndex % P.BUILDING_COLORS.length];

      // Watercolor fill body
      drawWatercolorFill(gfx, x, y, w, h, color, seed, 3);

      // Ink outline
      drawInkRect(gfx, x, y, w, h, seed, 2.5, P.INK);

      // ── Eraser sleeve + red plastic film ──
      // This is the FLAT sleeve, not `eraserHouse`'s. Two versions of one part
      // is normally the mistake this repo has made twice, so the split is
      // deliberate and narrow: the zoned eraser draws the demo's wobbled sleeve
      // with a chevron and a printed rule, and it can, because its traced marks
      // are the only other thing on it. This body still rules a full-height grid
      // of painted windows over itself (below), and a chevron cutting through
      // that grid reads as damage — so: straight edge, no printed rule.
      // (`terrain-builder`'s own night grid used to be the other half of this
      // argument; that half is gone, see `renderBuildingLights`.)
      //
      // The paper sleeve covers the bottom 52% (3D ERASER_SLEEVE_FRAC), and the
      // film bands its TOP EDGE. The film is what the 3D world lights at night:
      // residential was the only fully dark zone there (24% of all buildings,
      // the commonest kind) while the other four each had a light, and a real
      // eraser's paper/plastic seam is a material boundary that is already
      // there — nothing had to be invented to carry the light. It is what this
      // body lights too, and the ONLY thing: `genericFilm` below is shared with
      // the night pass.
      //
      // Drawn BEFORE the windows on purpose: the painted windows run the
      // building's whole height, and a sleeve laid on top would hide the lower
      // half of them.
      const F = genericFilm(y, h);
      const sleeveTop = F.top;
      gfx.fillStyle(ERASER_SLEEVE, 0.5);
      gfx.fillRect(x, sleeveTop, w, y + h - sleeveTop);
      // Chevron: the sleeve's top edge is cut to a point. Without it the
      // building is just two stacked colours and stops reading as stationery.
      const chev = Math.min(5, h * 0.06);
      gfx.fillTriangle(x, sleeveTop, x + w, sleeveTop, x + w / 2, sleeveTop - chev);
      // The film itself. No ink outline: at 15–40 px wide a 2.5 px pen would
      // swallow a 2 px band whole — one thin rule under it is the seam where
      // plastic meets paper. That rule is `wob`bed rather than drawInkLine'd:
      // at 1 px the wobble is sub-pixel either way, and drawInkLine costs 3–4
      // draw commands per building where this costs one (2D is CPU-bound).
      gfx.fillStyle(ERASER_FILM, 0.9);
      gfx.fillRect(x, sleeveTop, w, F.filmH);
      const seamY = sleeveTop + F.filmH;
      gfx.lineStyle(1, P.INK, 0.5);
      gfx.lineBetween(x, seamY + wob(x, seed) * 0.2, x + w, seamY + wob(x + w, seed) * 0.2);

      // Warm yellow windows
      const winSize = 3;
      const winGap = 6;
      for (let wy = y + 5; wy < y + h - 5; wy += winGap) {
        for (let wx = x + 4; wx < x + w - 4; wx += winGap) {
          gfx.fillStyle(0xd4b050, 0.5);
          gfx.fillRect(wx, wy, winSize, winSize);
        }
      }

      // Right-side shadow hatch
      const shadowW = Math.min(w * 0.3, 8);
      drawSimpleHatch(gfx, x + w - shadowW, y, shadowW, h, P.INK, 0.1, 4);

      // Wobbly roofline
      drawInkLine(gfx, x - 2, y, x + w + 2, y, seed + 500, 2, P.INK);
      // No extent reported: this body fills the box it was handed, give or take
      // the couple of px the ink wobble adds. That is the legal "nothing" answer
      // (see `DrawnBox`), not an oversight.
    },

    /**
     * Which part of a paper building is lit, per the 3D corrugated world
     * (`terrain/paper-terrain-style.ts`). Nothing here invents a light: each is
     * a surface the body already drew.
     *
     *   eraser   the red plastic film banding the sleeve      4 fills
     *   shop     both rows of index tabs                      9–15 fills
     *   tape     the hub of the reel                          1 circle
     *   fileBox  one bezel colour = one whole box of handles   0 or 8–24 strokes
     *   pill     the inside of the thrown-back lid            1 fill
     *   generic  its film, same as the eraser                 4 fills
     *
     * Measured additive draw commands per building, mean over 60 seeds per
     * district, nominal 15 × 19 → 40 × 300 (districts not bodies — the 20 %
     * neighbour bias mixes them):
     *
     *   residential 3.8 → 4.6    commercial 1.4 → 1.4    industrial 1.1 → 1.1
     *   school      7.1 → 20.2   hospital   1.8 → 2.5    unzoned    1.0 → 1.0
     *   ── the generic grid this replaces:  1 → 116 ──
     *
     * All six are bounded in the box height where the grid was linear in it, on
     * an ADD-blended layer, on a machine that is fill-bound. The school is the
     * dearest and its ceiling is arithmetic rather than empirical: ONE box of
     * three lights, its handle row is at most three holes (`widthPx` is clamped
     * to 40 px upstream), and each ring is a spread stroke plus a core, so
     * 3 × 2 × 4 edges = 24 and no box height can raise it.
     *
     * ⚠ Two of the six rows moved for reasons that are NOT this change, and both
     * were re-measured rather than trusted. `residential 0.9 → 3.8` and the
     * generic's `1.0 → 1` / `113.0 → 116`: the eraser's film glow is three halo
     * rectangles plus a core (4 fills), not the 1 the old row was written
     * against, and the grid mirror counts the hash rejection. `commercial`,
     * `industrial` and `unzoned` moving by 0.1–0.4 is the 20 % neighbour bias
     * now mixing in a file box instead of an abacus.
     *
     * What does NOT light, on purpose: the traced marks on an eraser's rubber
     * and the painted window grid on the generic body. Both are printed marks —
     * "the traced boxes on the exposed rubber are NOT windows — an eraser has
     * none, day or night". The 3D world says the same by answering `[]` for
     * this body and letting the film material carry the whole district.
     */
    renderBuildingLights(gfxIn, x, y, w, h, colorIndex, seed, zone) {
      const gfx = paper(gfxIn);
      const kind = bodyFor(seed, zone);
      if (kind) {
        const b = bodyBox(kind, x, y, w, h);
        if (kind === 'eraser') eraserFilmLight(gfx, b, seed);
        else if (kind === 'shop') shopNightLight(gfx, b, seed);
        else if (kind === 'tape') tapeHubLight(gfx, b);
        else if (kind === 'fileBox') handleRingLights(gfx, b, colorIndex, seed);
        else pillLidLight(gfx, b, seed);
        return;
      }
      const F = genericFilm(y, h);
      gfx.fillStyle(ERASER_FILM_GLOW, 0.7);
      gfx.fillRect(x - 1, F.top - F.filmH * 0.4, w + 2, F.filmH * 1.8);
    },

    renderTree(gfxIn, x, y, size, seed) {
      const gfx = paper(gfxIn);
      // Per-tree size variation
      const scale = 0.8 + ((seed % 100) / 100) * 0.5;
      const treeH = (18 + (seed % 12)) * scale;
      const crownR = (7 + (seed % 5)) * scale;
      const trunkH = (5 + (seed % 3)) * scale;

      const canopyColor = P.TREE_CANOPY_COLORS[seed % P.TREE_CANOPY_COLORS.length];
      // Three blob silhouettes: round (single blob), tall (vertical ellipse-ish via stacked blobs), wide (two-blob bushy)
      const shape = seed % 3;

      // Wobbly trunk
      drawInkLine(gfx, x, y, x + (seededRandom(seed + 10) - 0.5) * 3, y - trunkH, seed, 3, P.TREE_TRUNK);

      const canopyCy = y - trunkH - crownR * 0.7;

      if (shape === 0) {
        // Round single blob — original look
        drawOrganicBlob(gfx, x, canopyCy, crownR, seed + 50, canopyColor, P.INK, 2);
      } else if (shape === 1) {
        // Tall poplar — two stacked blobs
        const upperCy = canopyCy - crownR * 0.7;
        drawOrganicBlob(gfx, x, canopyCy, crownR * 0.85, seed + 50, canopyColor, P.INK, 2);
        drawOrganicBlob(gfx, x, upperCy, crownR * 0.65, seed + 90, canopyColor, P.INK, 2);
      } else {
        // Wide bushy — twin side-by-side blobs
        drawOrganicBlob(gfx, x - crownR * 0.4, canopyCy, crownR * 0.75, seed + 50, canopyColor, P.INK, 2);
        drawOrganicBlob(gfx, x + crownR * 0.4, canopyCy - crownR * 0.2, crownR * 0.7, seed + 110, canopyColor, P.INK, 2);
      }

      // Highlight spot (slightly lighter than canopy)
      gfx.fillStyle(0x8aaa5a, 0.3);
      gfx.fillCircle(x - crownR * 0.3, canopyCy - crownR * 0.2, crownR * 0.35);

      // Shadow hatch on right side of canopy
      drawSimpleHatch(
        gfx,
        x, canopyCy - crownR * 0.3,
        crownR, crownR * 0.8,
        P.INK, 0.08, 3,
      );
    },

    renderWater(gfxIn, x, y, w, h, seed) {
      const gfx = paper(gfxIn);
      const waterWidth = 60;

      // Watercolor fill
      drawWatercolorFill(gfx, x - waterWidth / 2, y, waterWidth, h, P.WATER_FILL, seed, 3);

      // Wobbly surface line
      drawInkLine(
        gfx,
        x - waterWidth / 2, y,
        x + waterWidth / 2, y,
        seed + 77, 2.5, P.WATER_OUTLINE,
      );

      // Subtle wave marks
      for (let i = 0; i < 2; i++) {
        const lineY = y + 5 + i * 8;
        drawInkLine(
          gfx,
          x - waterWidth / 3, lineY,
          x + waterWidth / 3, lineY,
          seed + 200 + i, 1, P.WATER_OUTLINE, 0.3,
        );
      }

      return { x, y, w: waterWidth };
    },

    renderGrass(gfxIn, x, y, _w, _h, seed) {
      const gfx = paper(gfxIn);
      // 2-3 small organic blobs
      const count = 2 + Math.floor(seededRandom(seed) * 2);
      for (let i = 0; i < count; i++) {
        const bx = x - 8 + seededRandom(seed + i * 41) * 16;
        const by = y - 1;
        const br = 2 + seededRandom(seed + i * 67) * 2;
        drawOrganicBlob(gfx, bx, by, br, seed + i * 100, P.GRASS_OVERLAY, P.INK, 1, 0.4);
      }
    },

    /** Sand: warm sandstone hump with ink stipple — a pen-shaded dune. */
    renderSand(gfxIn, x, y, _w, _h, seed) {
      const gfx = paper(gfxIn);
      gfx.fillStyle(0xc4a87a, 0.55); // P.MARKER_TICK sandstone
      gfx.beginPath();
      gfx.moveTo(x - 22, y);
      for (let i = -22; i <= 22; i += 4) {
        gfx.lineTo(x + i, y - 3 - Math.sin((i + 22) / 44 * Math.PI) * 3 + wob(x + i, seed));
      }
      gfx.lineTo(x + 22, y);
      gfx.closePath();
      gfx.fillPath();
      // Ink stipple
      gfx.fillStyle(P.INK, 0.4);
      for (let i = 0; i < 7; i++) {
        const sx = x + (seededRandom(seed + i * 13) - 0.5) * 40;
        const sy = y - 2 - seededRandom(seed + i * 29) * 4;
        gfx.fillRect(sx, sy, 1.2, 1.2);
      }
    },

    /**
     * The DISTRICT WASH BAND — the demo's `drawZoneBands`.
     *
     * It replaces a warm-grey smudge that said "town" and nothing else. The
     * demo's three constraints are its whole construction and all three survive:
     *
     *  1. **Do not cover the ink.** The band starts `TOP = 9` px below the
     *     surface, which clears the terrain's pen line and its offset echo, and
     *     it is drawn BEFORE them so line, echo and hatch all sit on top.
     *  2. **Do not make the ground look dirty.** It is narrow (17 px, `TOP` 9 →
     *     `BOT` 26) and its lower edge is not a hard one: a wobbled watercolour
     *     edge, then a 0.18 bleed running further down, then a 1.5 px pale ink
     *     line to close it.
     *  3. **Show the boundary.** A short ink stroke at the segment's start,
     *     because otherwise two districts are only a change of colour.
     *
     * 0.6 is the alpha the demo pins to the real game (the 3D `landuse-renderer`
     * zone decal's opacity), which is the one number both views agree on.
     *
     * ⚠ Two of the demo's three are FLAT here. The demo re-samples `terrainY`
     * every 8 m across the whole segment; this hook is handed one ground sample
     * and a 60 px span, so the band is a straight strip and the boundary stroke
     * has nowhere to go — a segment boundary is not a thing a single `urban`
     * feature knows about. Both come back if ground cover ever moves onto a
     * `points` list the way `renderRoadSurface` already has.
     */
    renderUrban(gfxIn, x, y, w, _h, seed, zone) {
      const gfx = paper(gfxIn);
      if (!zone) {
        gfx.fillStyle(P.FOG_COLOR, 0.25);
        gfx.fillRect(x - 30, y - 3, 60, 5);
        gfx.fillStyle(P.INK, 0.3);
        for (let i = 0; i < 5; i++) {
          const sx = x + (seededRandom(seed + i * 17) - 0.5) * 55;
          gfx.fillRect(sx, y - 2 + seededRandom(seed + i * 7) * 2, 2, 1.2);
        }
        return;
      }
      const TOP = 9, BOT = 26;
      const L = x - w / 2, R = x + w / 2;
      const col = ZONE_COLOR[zone];
      // The demo's wobbled lower edge, sampled at its own 8 m (24 px) pitch.
      const xs: number[] = [];
      for (let px = L; px < R; px += 24) xs.push(px);
      xs.push(R);
      const botY = (px: number): number => y + BOT + wob(px, 4.2) * 1.6;
      const bleedY = (px: number): number => y + BOT + 9 + wob(px, 6.4) * 2.4;

      gfx.fillStyle(col, 0.6);
      gfx.beginPath();
      gfx.moveTo(L, y + TOP);
      gfx.lineTo(R, y + TOP);
      for (let i = xs.length - 1; i >= 0; i--) gfx.lineTo(xs[i], botY(xs[i]));
      gfx.closePath();
      gfx.fillPath();

      // The wash running on down past the edge, so the band has no hard bottom.
      gfx.fillStyle(col, 0.18);
      gfx.beginPath();
      gfx.moveTo(xs[0], botY(xs[0]));
      for (const px of xs) gfx.lineTo(px, botY(px));
      for (let i = xs.length - 1; i >= 0; i--) gfx.lineTo(xs[i], bleedY(xs[i]));
      gfx.closePath();
      gfx.fillPath();

      gfx.lineStyle(1.5, P.INK, 0.32);
      gfx.beginPath();
      gfx.moveTo(xs[0], botY(xs[0]));
      for (const px of xs) gfx.lineTo(px, botY(px));
      gfx.strokePath();
    },

    /** Waterway: teal channel with wobbled ink banks — renderWater, narrowed. */
    renderWaterway(gfxIn, x, y, w, h, seed) {
      const gfx = paper(gfxIn);
      const half = w / 2;
      gfx.fillStyle(P.WATER_FILL, 0.55);
      gfx.fillRect(x - half, y, w, h);
      // Ink banks
      gfx.lineStyle(2, P.INK, 0.7);
      gfx.lineBetween(x - half + wob(y, seed), y, x - half + wob(y + 40, seed), y + h);
      gfx.lineBetween(x + half + wob(y, seed + 3), y, x + half + wob(y + 40, seed + 3), y + h);
      // Surface line
      gfx.lineStyle(2, P.WATER_OUTLINE, 0.6);
      gfx.lineBetween(x - half, y, x + half, y);
      return { x, y, w };
    },

    /** Aeroway: warm concrete strip, ink edges, white dashes — and a little
     *  tethered balloon-plane bobbing over the runway (the 3D cuphead world
     *  parks one at every aerodrome too). */
    renderAeroway(gfxIn, x, y, w, kind, seed) {
      const gfx = paper(gfxIn);
      const half = w / 2;
      const stripH = 7;
      gfx.fillStyle(0x9a8a7a, 0.7); // P.FOG_COLOR — warm concrete
      gfx.fillRect(x - half, y - stripH, w, stripH);
      gfx.lineStyle(2, P.INK, 0.7);
      gfx.lineBetween(x - half, y - stripH, x + half, y - stripH);
      gfx.lineBetween(x - half, y, x + half, y);
      gfx.fillStyle(0xffffff, 0.7);
      for (let i = -half + 4; i < half - 10; i += 18) {
        gfx.fillRect(x + i, y - stripH / 2 - 1, 9, 2);
      }
      if (kind !== 'runway') return;

      // Balloon plane: round body + triangle wing + rope down to the strip
      const px = x + (seededRandom(seed) - 0.5) * w * 0.5;
      const py = y - 60 - seededRandom(seed + 5) * 15;
      gfx.lineStyle(1.5, P.INK, 0.8);
      gfx.lineBetween(px, py + 9, px, y - stripH); // tether
      gfx.fillStyle(0xa0523c, 0.95);               // brick-red body
      gfx.lineStyle(2, P.INK, 0.9);
      gfx.beginPath();
      gfx.arc(px, py, 9, 0, Math.PI * 2);
      gfx.closePath();
      gfx.fillPath();
      gfx.strokePath();
      gfx.fillStyle(0xc4a035, 0.95);               // mustard wing
      gfx.fillTriangle(px - 2, py, px - 14, py - 7, px - 12, py + 4);
      gfx.lineStyle(1.5, P.INK, 0.9);
      gfx.strokeTriangle(px - 2, py, px - 14, py - 7, px - 12, py + 4);
      // Propeller tick
      gfx.lineStyle(1.5, P.INK, 0.8);
      gfx.lineBetween(px + 9, py - 5, px + 11, py + 5);
    },

    /** Road: a dirt-track band — warm earth wash between two wobbled ink
     *  edges, with dashed wheel ruts down the middle. */
    renderRoadSurface(gfxIn, points, seed) {
      const gfx = paper(gfxIn);
      const H = 8;
      // Earth wash
      gfx.fillStyle(0xb5a67a, 0.5); // khaki earth
      gfx.beginPath();
      gfx.moveTo(points[0].x, points[0].y + 1);
      for (const p of points) gfx.lineTo(p.x, p.y + 1);
      for (let i = points.length - 1; i >= 0; i--) gfx.lineTo(points[i].x, points[i].y + H);
      gfx.closePath();
      gfx.fillPath();
      // Lower ink edge (the surface's own double-stroke line is the upper one)
      gfx.lineStyle(1.5, P.INK, 0.5);
      gfx.beginPath();
      gfx.moveTo(points[0].x, points[0].y + H + wob(points[0].x, seed));
      for (const p of points) gfx.lineTo(p.x, p.y + H + wob(p.x, seed));
      gfx.strokePath();
      // Wheel-rut dashes
      gfx.lineStyle(1.2, P.INK, 0.35);
      for (let i = 2; i < points.length - 3; i += 5) {
        const p = points[i];
        gfx.lineBetween(p.x, p.y + H * 0.55, p.x + 12, p.y + H * 0.55);
      }
    },

    /**
     * The highlighter street lamp — `plan/phaser-handdrawn-demo.html`'s
     * `drawHiliteLamp`, in place of the municipal iron post this file drew.
     *
     * The road in this world IS a highlighter stroke, so what stands beside it
     * is the pen that drew it: a round barrel, a translucent cap a size bigger
     * than the barrel (the single most legible sign that there IS a cap), a
     * chisel nib shut inside the cap, and the pocket clip without which the
     * whole thing is a fat stick.
     *
     * **Draw order is load-bearing and the demo says so**: the nib goes down
     * FIRST and the 0.32-alpha cap over it, so the nib shows THROUGH. Reverse
     * them and the cap is opaque and the lamp has no lamp in it.
     */
    renderRoadLamp(gfxIn, x, y, seed) {
      const gfx = paper(gfxIn);
      const hgt = LAMP_HEIGHT;
      const bw = 13, cw = 15.5;                      // cap is a size up on barrel
      const capBot = y - hgt * 0.58;
      const capTop = y - hgt;
      // Barrel
      gfx.fillStyle(HL_BARREL, 0.92);
      gfx.lineStyle(3, P.INK, 0.95);
      wobQuad(gfx, x, y, bw, y - capBot, seed + 2);
      gfx.fillPath();
      gfx.strokePath();
      gfx.lineStyle(1.8, P.INK, 0.45);               // the end plug
      gfx.lineBetween(x - bw / 2, y - 5, x + bw / 2, y - 5);
      // The chisel nib — drawn BEFORE the cap that has to show it through.
      const nibY = capBot - 9;
      gfx.fillStyle(HL_NIB, 1);
      gfx.beginPath();
      gfx.moveTo(x - 3.4, nibY + 5);
      gfx.lineTo(x + 3.4, nibY + 1.5);
      gfx.lineTo(x + 3.4, nibY - 6);
      gfx.lineTo(x - 3.4, nibY - 2.5);
      gfx.closePath();
      gfx.fillPath();
      // The translucent cap = the lamp's shade.
      gfx.fillStyle(HL_CAP, 0.32);
      gfx.lineStyle(3, P.INK, 0.95);
      wobQuad(gfx, x, capBot + 1, cw, capBot - capTop, seed + 5);
      gfx.fillPath();
      gfx.strokePath();
      gfx.fillStyle(HL_CAP, 0.6);                    // the knob on the cap's crown
      wobQuad(gfx, x, capTop + 1.5, 6.5, 4.5, seed + 9);
      gfx.fillPath();
      gfx.strokePath();
      // Pocket clip.
      gfx.fillStyle(HL_BARREL, 0.95);
      gfx.lineStyle(2.2, P.INK, 0.9);
      wobQuad(gfx, x + cw / 2 + 1.4, capBot - 3, 3.6, (capBot - capTop) * 0.72, seed + 11);
      gfx.fillPath();
      gfx.strokePath();
    },

    /** What is alight is the NIB, inside the cap — never the whole pen. The 3D
     *  world's LED post learned that one the hard way: light the body and you
     *  have a glowing stick, not a lamp. Five rings and a hard core, the demo's. */
    renderRoadLampGlow(gfxIn, x, y, _seed) {
      const gfx = paper(gfxIn);
      const nibY = y - LAMP_HEIGHT * 0.58 - 9;
      for (let r = 5; r >= 1; r--) {
        gfx.fillStyle(HL_GLOW, 0.07 * r);
        gfx.fillCircle(x, nibY, r * 7);
      }
      gfx.fillStyle(HL_CORE, 0.95);
      gfx.fillCircle(x, nibY, 3.2);
    },

    // ── Sky / weather ──

    getSkyColors(sunElevation, weather) {
      let topColor: number;
      let bottomColor: number;

      if (sunElevation > 10) {
        topColor = P.SKY_DAY_TOP;
        bottomColor = P.SKY_DAY_BOTTOM;
      } else if (sunElevation > 0) {
        const t = sunElevation / 10;
        topColor = lerpColor(P.SKY_DUSK_TOP, P.SKY_DAY_TOP, t);
        bottomColor = lerpColor(P.SKY_DUSK_BOTTOM, P.SKY_DAY_BOTTOM, t);
      } else if (sunElevation > -6) {
        const t = (sunElevation + 6) / 6;
        topColor = lerpColor(P.SKY_NIGHT_TOP, P.SKY_DUSK_TOP, t);
        bottomColor = lerpColor(P.SKY_NIGHT_BOTTOM, P.SKY_DUSK_BOTTOM, t);
      } else {
        topColor = P.SKY_NIGHT_TOP;
        bottomColor = P.SKY_NIGHT_BOTTOM;
      }

      // Weather dimming
      const wb: Record<string, number> = { sunny: 1.0, cloudy: 0.75, rainy: 0.55, snowy: 0.65 };
      const brightness = wb[weather] ?? 1.0;
      if (brightness < 1.0) {
        topColor = lerpColor(topColor, 0x0a0a0a, 1 - brightness);
        bottomColor = lerpColor(bottomColor, 0x0a0a0a, 1 - brightness);
      }

      return { top: topColor, bottom: bottomColor };
    },

    /** Demo's cloud: one squashed 7-lobe blob with a bold ink outline —
     *  reads as a single confident pen shape, not a cluster of puffs. */
    drawCloud(gfxIn, cx, cy, w, _h, seed) {
      const gfx = paper(gfxIn);
      const s = w / 110; // demo blob is ~110px wide at scale 1
      gfx.fillStyle(P.CLOUD, 0.9);
      gfx.lineStyle(2.5, P.INK, 0.75);
      gfx.beginPath();
      const lobes = 7;
      for (let j = 0; j <= lobes * 8; j++) {
        const a = (j / (lobes * 8)) * Math.PI * 2;
        const r = (34 + Math.sin(a * lobes + seed) * 10 + wob(j * 9, seed) * 2) * s;
        const px = cx + Math.cos(a) * r * 1.6;
        const py = cy + Math.sin(a) * r * 0.62; // demo's squash — h is implied by w
        if (j === 0) gfx.moveTo(px, py); else gfx.lineTo(px, py);
      }
      gfx.closePath();
      gfx.fillPath();
      gfx.strokePath();
    },

    /** Demo's mountain profile: two incommensurate sines + wobble around the
     *  base line — soft rolling ranges, not jagged peaks. The far layer is
     *  taller and lazier; the near one busier and lower. */
    generateMountainPoints(baseY, skyH, totalWidth, layer, seed) {
      const points: { x: number; y: number }[] = [];
      const s = layer === 'far' ? 5 + seed * 0.37 : 11 + seed * 0.37;
      const amp = skyH * (layer === 'far' ? 0.11 : 0.085);
      const freq = layer === 'far' ? 0.0016 : 0.003;
      for (let x = 0; x <= totalWidth; x += 6) {
        const y = baseY
          + Math.sin(x * freq + s) * amp
          + Math.sin(x * freq * 2.7 + s * 2) * amp * 0.45
          + wob(x, s) * 2;
        points.push({ x, y });
      }
      return points;
    },

    /** Demo's range drawing: a near-opaque fill with a bold 3px ink outline —
     *  the outline (0.35 far / 0.5 near) is what makes them read as DRAWN.
     *  (Weather passes seed 0 for the far layer, 1 for the near one.) */
    drawMountainSilhouette(gfxIn, points, color, bottomY, seed) {
      const gfx = paper(gfxIn);
      gfx.fillStyle(color, 0.9);
      gfx.lineStyle(3, P.INK, seed === 0 ? 0.35 : 0.5);
      gfx.beginPath();
      gfx.moveTo(points[0].x, bottomY);
      for (const pt of points) gfx.lineTo(pt.x, pt.y);
      gfx.lineTo(points[points.length - 1].x, bottomY);
      gfx.closePath();
      gfx.fillPath();
      gfx.strokePath();
    },

    /**
     * The moon — the demo's, which is the SUN's drawing with two substitutions:
     * a bite of night sky taken out of it for the phase, and the twelve rays
     * drawn in moonlight instead of ink.
     *
     * The port had this as a wobbled blob with an ink outline and neither the
     * bite nor the rays, and it ignored `phase` entirely. Both matter: the rays
     * are what make the sun and moon the same hand-drawn OBJECT seen twice, and
     * the bite is the only thing that says which night of the month it is.
     *
     * The bite is a disc of `SKY_NIGHT_TOP` at 0.85, offset up and left by
     * `(10, 5)` on the demo's radius 26 — kept as that FRACTION so a bigger moon
     * gets a proportionally placed bite rather than a nick out of one edge.
     * `phase` swings the offset: 0 and 1 are new (the bite centred, the moon
     * eaten), 0.5 is full (the bite carried right off the disc).
     */
    drawMoon(gfxIn, cx, cy, radius, phase, _seed) {
      const gfx = paper(gfxIn);
      const k = radius / 26;
      gfx.fillStyle(P.MOON, 1);
      gfx.fillCircle(cx, cy, radius);
      // The demo's fixed bite is `phase = 0.5 - 10/(26*4)` worth of offset; the
      // sweep below passes through it, so the demo's own picture is one frame of
      // this one rather than a special case.
      gfx.fillStyle(P.SKY_NIGHT_TOP, 0.85);
      gfx.fillCircle(cx - (1 - 2 * Math.abs(phase - 0.5)) * 40 * k, cy - 5 * k, radius * 0.8);
      gfx.lineStyle(2, P.MOON, 0.6);
      celestialRays(gfx, cx, cy, radius);
    },

    /** Mustard ink-outlined disc with twelve radiating pen strokes — the
     *  demo's hand-drawn sun. Replaces the (style-gated-off) Preetham sky
     *  as the only daytime sun. */
    drawSun(gfxIn, cx, cy, radius, _seed) {
      const gfx = paper(gfxIn);
      gfx.fillStyle(P.SUN, 1);
      gfx.fillCircle(cx, cy, radius);
      gfx.lineStyle(3, P.INK, 0.8);
      gfx.strokeCircle(cx, cy, radius);
      gfx.lineStyle(2.5, P.INK, 0.7);
      celestialRays(gfx, cx, cy, radius);
    },

    drawStar(gfxIn, x, y, size, brightness, seed) {
      const gfx = paper(gfxIn);
      // Slightly larger stars than plastic
      const starSize = size * 1.3;
      gfx.fillStyle(0xffffff, brightness);
      gfx.fillCircle(x, y, starSize);

      // 10% chance of cross-star sparkle
      if (seededRandom(seed) < 0.1) {
        gfx.lineStyle(0.5, 0xffffff, brightness * 0.6);
        const armLen = starSize * 2.5;
        gfx.lineBetween(x - armLen, y, x + armLen, y);
        gfx.lineBetween(x, y - armLen, x, y + armLen);
      }
    },

    // ── Cyclist (64×64 rubber-hose style) ──

    getCyclistFrameSize() {
      return { w: CYCLIST_W, h: CYCLIST_H };
    },

    /** The demo's ink noodle rider, ported 1:1 — big 3.5px ink wheels with
     *  rotating spokes, a solid red watercolour jersey patch, straight noodle
     *  limbs, cream head under a leather half-cap, one ink-dot eye. The pose
     *  params map to small offsets so the pose system still reads (standing
     *  rocks the body, aero leans it, headTilt nods the head). */
    generateCyclistFrame(ctx, ox, frame, _pose, params) {
      const cx = ox + CYCLIST_W / 2;
      const groundY = CYCLIST_H - 2;
      const R = 11;                    // demo wheel radius
      const axleY = groundY - R;       // demo's origin: the wheel axle line
      const pedalAngle = (frame / FRAME_COUNT) * Math.PI * 2;
      const rock = params.rockAmplitude * Math.sin(pedalAngle);
      const lift = params.hipOffsetY * 0.6;
      const lean = Math.sin(params.torsoAngle * (Math.PI / 180)) * 6;
      const X = (dx: number) => cx + dx;
      const Y = (dy: number) => axleY + dy;

      // Through `paintHex`, not raw: this is a CANVAS, baked once into a
      // spritesheet, so bare mode has to be asked for here or the rider stays in
      // full colour on a kraft world (`rebuildCyclistTextures` re-bakes it).
      const bodyHex = paintHex(P.CYCLIST_BODY);
      const skinHex = paintHex(P.CYCLIST_SKIN);
      const capHex = paintHex(P.CYCLIST_HELMET);

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // ── Wheels + rotating spokes ──
      //
      // The wheel turns at `pedal × 1.6`, which is the demo's `wheelA` and was
      // the one number this "ported 1:1" rider had quietly dropped: at ×1.0 the
      // four spokes advance exactly 60° a frame, and with spokes 90° apart that
      // is only THREE distinct wheels in the six-frame loop — the wheel visibly
      // stutters while the legs pedal on. Caught by the spoke-phase check, not
      // by eye.
      //
      // ⚠ The demo's `pedal` is continuous and this sheet is a six-frame LOOP,
      // so ×1.6 does not close: 6 × 60° × 1.6 = 576°, which is 36° short of a
      // whole number of 90° spoke steps, and the loop seam pops by that much.
      // Kept anyway, because it is the demo's number and 36° on four
      // indistinguishable spokes at 8 fps is smaller than the three-phase
      // stutter it replaces. The nearest multiplier that BOTH closes the loop
      // and gives six distinct wheels is 1.25 (60 × 1.25 = 75°, and 75 × 6 =
      // 450 ≡ 0 mod 90); take it only with the demo changed to match.
      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 3.5;
      for (const wx of [-15, 15]) {
        ctx.beginPath(); ctx.arc(X(wx), Y(0), R, 0, Math.PI * 2); ctx.stroke();
      }
      const wheelA = pedalAngle * 1.6;
      ctx.lineWidth = 2;
      for (const wx of [-15, 15]) {
        for (let i = 0; i < 4; i++) {
          const a = wheelA + (i / 4) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(X(wx), Y(0));
          ctx.lineTo(X(wx) + Math.cos(a) * (R - 2), Y(0) + Math.sin(a) * (R - 2));
          ctx.stroke();
        }
      }

      // ── Frame ──
      ctx.lineWidth = 3;
      const seg = (x1: number, y1: number, x2: number, y2: number) => {
        ctx.beginPath(); ctx.moveTo(X(x1), Y(y1)); ctx.lineTo(X(x2), Y(y2)); ctx.stroke();
      };
      seg(-15, 0, 0, -3);
      seg(0, -3, 15, 0);
      seg(0, -3, -4, -14);
      seg(15, 0, 10, -15);

      // ── Noodle legs (two phases of the same pedal circle) ──
      ctx.lineWidth = 3;
      const hipY = -13 - lift;
      seg(-2, hipY, Math.cos(pedalAngle) * 7, -3 + Math.sin(pedalAngle) * 7);
      seg(-2, hipY, -Math.cos(pedalAngle) * 7, -3 - Math.sin(pedalAngle) * 7);

      // ── Jersey: solid red watercolour patch, ink outlined ──
      const quad: [number, number][] = [
        [-6 + rock, -14 - lift],
        [2 + rock + lean, -28 - lift],
        [9 + rock + lean, -24 - lift],
        [4 + rock, -12 - lift],
      ];
      ctx.fillStyle = bodyHex;
      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(X(quad[0][0]), Y(quad[0][1]));
      for (let i = 1; i < quad.length; i++) ctx.lineTo(X(quad[i][0]), Y(quad[i][1]));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // ── Arm to the bars ──
      ctx.lineWidth = 3;
      seg(5 + rock + lean, -24 - lift, 11, -16);

      // ── Head: cream disc + leather half-cap + ink-dot eye ──
      const hx = X(6 + rock + lean);
      const hy = Y(-33 - lift + params.headTilt);
      ctx.fillStyle = skinHex;
      ctx.beginPath(); ctx.arc(hx, hy, 7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(hx, hy, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = capHex;
      ctx.beginPath(); ctx.arc(hx, hy - 2, 7.5, Math.PI, 0); ctx.closePath(); ctx.fill();
      ctx.fillStyle = INK_HEX;
      ctx.beginPath(); ctx.arc(hx + 2.5, hy, 1.8, 0, Math.PI * 2); ctx.fill();
    },

    getCyclistZone5Tint(isDarkened) {
      if (!isDarkened) return null;
      // Warm red-brown pulsing instead of neon red
      const pulse = Math.sin(Date.now() * 0.008) * 0.5 + 0.5;
      return pulse > 0.5 ? 0xc44a3a : 0xa03828;
    },

    // ── Coins ──

    getCoinSize() {
      return COIN_SIZE;
    },

    /**
     * Coin as a PUSHPIN — the demo's `drawPushpin`, in place of the starred
     * doubloon this file baked.
     *
     * The pin is the whole point: a stationery world's collectable is a piece
     * of stationery, and the SPIKE is what stops the round head reading as a
     * coin. Head, spike, ink outline, one highlight; no star, no hatch, no
     * milled rim.
     *
     * ⚠ ONE deviation, forced by the pipeline. The demo redraws its pin every
     * frame and narrows the head with `rw = 11 * (0.3 + 0.7 * spin)` — the head
     * really turns while the spike stays put. `drawCoinTexture` bakes ONE canvas
     * that `phaser-coin-layer` reuses for every coin, so this is the pin at full
     * face (`spin = 1`); the turn would have to come back as a sprite `scaleX`,
     * and it cannot, because that would squash the spike too.
     */
    drawCoinTexture(ctx, cx, cy, size, _seed) {
      // Baked canvas, same as the rider — see `paintHex`.
      const coinHex = paintHex(P.COIN_GOLD);
      const highlightHex = paintHex(P.COIN_HIGHLIGHT);
      const pinHex = paintHex(PIN_SHAFT);
      // The demo's pin is 11 px of head half-width against a 23 px spike; `size`
      // is the half-extent the coin layer allocates, and the spike is the tall
      // half, so everything scales off `k = size / 23`.
      const k = size / 23;
      // Spike first — the head sits on top of where it enters.
      ctx.fillStyle = pinHex;
      ctx.beginPath();
      ctx.moveTo(cx - 2.6 * k, cy + 4 * k);
      ctx.lineTo(cx + 2.6 * k, cy + 4 * k);
      ctx.lineTo(cx, cy + 23 * k);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 2.2 * k;
      ctx.stroke();
      // Head.
      const rw = 11 * k, rh = 9.5 * k;   // the demo's 19-tall ellipse, halved
      ctx.fillStyle = coinHex;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = INK_HEX;
      ctx.lineWidth = 2.6 * k;
      ctx.stroke();
      // One highlight, up and to the left, like every other round thing here.
      ctx.fillStyle = highlightHex;
      ctx.beginPath();
      ctx.ellipse(cx - rw * 0.3, cy - 3 * k, rw * 0.325, 3 * k, 0, 0, Math.PI * 2);
      ctx.fill();
    },

    // ── Markers / flags ──

    getMarkerFont() {
      return 'Georgia, "Noto Sans TC", serif';
    },

    /**
     * Checkpoint as a DRESSMAKER'S PIN with a sticky note on it — the demo's
     * `drawStickyPin`, in place of the pennant this file drew.
     *
     * Two things carry it. The shaft is drawn TWICE, ink under steel, because a
     * 2 px steel line on a watercolour ground disappears and a pin has to read
     * as METAL in a world made of paper. And the note is a NOTE — it has ruled
     * lines on it, which is what stops a coloured quad reading as a flag.
     *
     * `label` stays unused: the scene pins a Phaser Text over this, and the
     * demo's own note is blank and ruled (法則 3.7 — no system fonts in the art).
     */
    drawFlag(gfxIn, x, y, color, _label, seed) {
      const gfx = paper(gfxIn);
      const hgt = 74;
      const w1 = wob(x, 1), w3 = wob(x, 3);
      gfx.lineStyle(3.4, P.INK, 0.95);
      gfx.lineBetween(x + w1, y, x + w3, y - hgt);
      gfx.lineStyle(2.2, PIN_SHAFT, 1);
      gfx.lineBetween(x + w1, y, x + w3, y - hgt);
      gfx.fillStyle(PIN_HEAD, 1);
      gfx.fillCircle(x + w3, y - hgt - 5, 7);
      gfx.lineStyle(2.6, P.INK, 0.95);
      gfx.strokeCircle(x + w3, y - hgt - 5, 7);

      // The note. Its colour is the CALLER's (start / finish / km markers each
      // have one), where the demo cycles its own three sticky colours — that is
      // the one place this hook has to answer to the game rather than the demo.
      const sw = 42, sh = 34;
      const sx = x + 4 + sw / 2, sy = y - hgt + 24;
      gfx.fillStyle(color, 0.9);
      gfx.lineStyle(2.6, P.INK, 0.9);
      wobQuad(gfx, sx, sy, sw, sh, seed + 5);
      gfx.fillPath();
      gfx.strokePath();
      gfx.lineStyle(1.6, P.INK, 0.22);
      for (let i = 1; i < 4; i++) {
        const ly = sy - sh + i * (sh / 4);
        gfx.lineBetween(sx - sw / 2 + 5, ly + wob(sx, i), sx + sw / 2 - 5, ly + wob(sx + 30, i));
      }
    },

    /** Finish-line aircraft: a hand-drawn 1930s zeppelin. Teardrop hull (round
     *  nose right, tapered tail left) whose outline "boils" at ~2 fps (seed
     *  steps with floor(animPhase*2) — the classic rubber-hose look), curved
     *  longitudinal panel seams, belly hatch crescent, a top highlight arc,
     *  cream fins with red tips, a side-view tail propeller with a blur
     *  ellipse, a strutted gondola with portholes, a fluttering nose pennant,
     *  and a kraft wooden sign roped down below. The sign's centre is returned
     *  so the scene pins the "剩 … km" Text on it. */
    drawAircraft(gfxIn, cx, cy, seed, animPhase) {
      const gfx = paper(gfxIn);
      const rx = 56; // hull half-length
      const ry = 19; // hull half-height
      const boil = Math.floor(animPhase * 2); // ~2 fps outline jitter → "boiling"
      const bs = seed + boil * 101;

      // Hull profile — round nose (right), tapered tail (left).
      const yScaleAt = (t: number) => 1 - 0.34 * Math.pow(t, 1.6); // t: 0 nose → 1 tail
      const hullPt = (a: number) => {
        const t = (1 - Math.cos(a)) / 2;
        const wob = 1 + (seededRandom(bs + Math.round(a * 53)) - 0.5) * 0.07;
        return {
          x: cx + Math.cos(a) * rx * wob,
          y: cy + Math.sin(a) * ry * yScaleAt(t) * wob,
        };
      };
      const halfH = (x: number): number => {
        const c = Math.max(-1, Math.min(1, (x - cx) / rx));
        return ry * Math.sqrt(Math.max(0, 1 - c * c)) * yScaleAt((1 - c) / 2);
      };
      const N = 36;
      const hull: { x: number; y: number }[] = [];
      for (let i = 0; i <= N; i++) hull.push(hullPt((i / N) * Math.PI * 2));
      const tracePath = (): void => {
        gfx.beginPath();
        gfx.moveTo(hull[0].x, hull[0].y);
        for (const p of hull) gfx.lineTo(p.x, p.y);
        gfx.closePath();
      };

      const tailX = cx - rx;

      // ── Tail fins (cream cutouts with red tips, behind the hull) ──
      const fin = (upper: boolean): void => {
        const s = upper ? -1 : 1;
        const ax = tailX + 12; const ay = cy + s * 4;   // root, on the hull
        const bx = tailX - 18; const by = cy + s * 24;  // swept tip
        const dx = tailX - 22; const dy = cy + s * 6;   // trailing corner
        gfx.fillStyle(AIRSHIP_CREAM, 0.92);
        gfx.fillTriangle(ax, ay, bx, by, dx, dy);
        // Red tip stripe (quarter-scale triangle at the swept corner).
        gfx.fillStyle(P.CYCLIST_BODY, 0.85);
        gfx.fillTriangle(bx, by, (ax + bx) / 2, (ay + by) / 2, (dx + bx) / 2, (dy + by) / 2);
        gfx.lineStyle(2.5, P.INK, 0.95);
        gfx.strokeTriangle(ax, ay, bx, by, dx, dy);
      };
      fin(true);
      fin(false);

      // ── Tail propeller: blur ellipse + two side-view strokes + hub ──
      const pcx = tailX - 8;
      const pr = 12;
      gfx.lineStyle(1.5, P.INK, 0.16);
      gfx.strokeEllipse(pcx, cy, 9, pr * 2 + 4); // spin-blur disc, edge-on
      const pa = animPhase * 5;
      gfx.lineStyle(2.5, P.INK, 0.9);
      for (let k = 0; k < 2; k++) {
        const a = pa + k * (Math.PI / 2);
        gfx.lineBetween(
          pcx - Math.cos(a) * 3, cy - Math.sin(a) * pr,
          pcx + Math.cos(a) * 3, cy + Math.sin(a) * pr,
        );
      }
      gfx.fillStyle(P.INK, 1);
      gfx.fillCircle(pcx, cy, 2.5); // prop hub

      // ── Hull: layered watercolour + boiling ink outline ──
      gfx.fillStyle(AIRSHIP_CREAM, 0.5); tracePath(); gfx.fillPath();
      gfx.fillStyle(AIRSHIP_CREAM, 0.5); tracePath(); gfx.fillPath();
      gfx.lineStyle(3, P.INK, 1); tracePath(); gfx.strokePath();

      // Curved longitudinal panel seams that follow the hull's taper.
      gfx.lineStyle(1.5, P.INK, 0.4);
      for (const f of [-0.42, 0.1, 0.55]) {
        gfx.beginPath();
        let first = true;
        for (let x = cx + rx * 0.88; x >= cx - rx * 0.85; x -= 9) {
          const y = cy + f * halfH(x) + (seededRandom(bs + Math.round(x * 7 + f * 997)) - 0.5) * 1.6;
          if (first) { gfx.moveTo(x, y); first = false; } else { gfx.lineTo(x, y); }
        }
        gfx.strokePath();
      }

      // Belly shading crescent (two stepped hatch bands hug the underside).
      drawSimpleHatch(gfx, cx - rx * 0.55, cy + ry * 0.3, rx * 1.05, ry * 0.42, P.INK, 0.1, 6);
      drawSimpleHatch(gfx, cx - rx * 0.28, cy + ry * 0.6, rx * 0.6, ry * 0.28, P.INK, 0.1, 5);

      // Top highlight arc, drifting from crown toward the nose.
      gfx.lineStyle(2.5, 0xfaf4e4, 0.8);
      gfx.beginPath();
      for (let i = 0; i <= 8; i++) {
        const p = hullPt(Math.PI * 1.5 + (i / 8) * 0.55);
        const px = cx + (p.x - cx) * 0.86;
        const py = cy + (p.y - cy) * 0.8;
        if (i === 0) { gfx.moveTo(px, py); } else { gfx.lineTo(px, py); }
      }
      gfx.strokePath();

      // ── Gondola: hangs below the hull on two ink struts, with portholes ──
      const gonW = 24;
      const gonH = 10;
      const gonTop = cy + ry + 4;
      const gonX = cx - gonW / 2 + 2;
      gfx.lineStyle(2, P.INK, 0.85);
      gfx.lineBetween(gonX + 4, gonTop, cx - 10, cy + halfH(cx - 10) - 2);
      gfx.lineBetween(gonX + gonW - 4, gonTop, cx + 12, cy + halfH(cx + 12) - 2);
      drawWatercolorFill(gfx, gonX, gonTop, gonW, gonH, 0x8a6a4a, seed + 30, 2);
      drawInkRect(gfx, gonX, gonTop, gonW, gonH, seed + 40, 2, P.INK);
      gfx.fillStyle(P.INK, 0.75);
      gfx.fillRect(gonX + 5, gonTop + 3, 3.5, 3.5);
      gfx.fillRect(gonX + 13, gonTop + 3, 3.5, 3.5);

      // ── Nose pennant: a little red flag on a mast, fluttering with the boil ──
      const noseX = cx + rx;
      const flap = (seededRandom(bs + 7) - 0.5) * 4;
      gfx.lineStyle(1.5, P.INK, 0.9);
      gfx.lineBetween(noseX - 2, cy - 2, noseX + 6, cy - 14);
      gfx.fillStyle(P.CYCLIST_BODY, 0.9);
      gfx.fillTriangle(noseX + 6, cy - 14, noseX + 20, cy - 11 + flap, noseX + 7, cy - 7);

      // ── Kraft wooden sign, roped down below the gondola ──
      const signW = 96;
      const signH = 28;
      const signTop = gonTop + gonH + 22;
      const bannerCx = cx;
      const bannerCy = signTop + signH / 2;

      // Two rope lines with knots where they meet the board.
      gfx.lineStyle(2, P.INK, 0.7);
      gfx.lineBetween(cx - 14, gonTop + gonH, bannerCx - signW * 0.32, signTop);
      gfx.lineBetween(cx + 14, gonTop + gonH, bannerCx + signW * 0.32, signTop);

      // Wooden board: watercolour kraft + plank separations + ink border.
      drawWatercolorFill(gfx, bannerCx - signW / 2, signTop, signW, signH, AIRSHIP_KRAFT, seed + 7, 3);
      gfx.lineStyle(1.5, P.INK, 0.3);
      gfx.lineBetween(bannerCx - signW / 2 + 4, signTop + signH / 3, bannerCx + signW / 2 - 4, signTop + signH / 3 + 1);
      gfx.lineBetween(bannerCx - signW / 2 + 4, signTop + (2 * signH) / 3 + 1, bannerCx + signW / 2 - 4, signTop + (2 * signH) / 3);
      drawInkRect(gfx, bannerCx - signW / 2, signTop, signW, signH, seed + 9, 2.5, P.INK);
      gfx.fillStyle(P.INK, 0.8);
      gfx.fillCircle(bannerCx - signW * 0.32, signTop + 2, 2.2);
      gfx.fillCircle(bannerCx + signW * 0.32, signTop + 2, 2.2);

      return { bannerCx, bannerCy };
    },

    // ── Wind particles ──

    getWindParticleColor() {
      // The scene bakes this into a 2×1 canvas for the emitter, so it never
      // meets `paper()` — same reason the rider and the coin ask for themselves.
      return paintNow(P.WIND_COLOR);
    },

    getWindParticleAlpha() {
      return P.WIND_ALPHA;
    },
  };
}

// ── Helper ──

function lerpColor(c1: number, c2: number, t: number): number {
  const r1 = (c1 >> 16) & 0xff;
  const g1 = (c1 >> 8) & 0xff;
  const b1 = c1 & 0xff;
  const r2 = (c2 >> 16) & 0xff;
  const g2 = (c2 >> 8) & 0xff;
  const b2 = c2 & 0xff;
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return (r << 16) | (g << 8) | b;
}
