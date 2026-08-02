/**
 * Plastic style strategy — neon Tetris.
 *
 * The 2D counterpart of the 3D plastic world's quantized brick terrain: the
 * ground is a wall of stacked tetromino blocks glowing against a dark grid,
 * buildings are block towers, and the world *drops into place* on entry.
 *
 * Glow is faked with layered strokes (dark fill → bright inner stroke → two
 * fading outer strokes), not postFX — one Graphics, no extra render targets.
 *
 * Colour source: `styles/themes.scss` `$plastic` map (`--pl-*`). Canvas/JS
 * can't read CSS vars, so these are MIRRORED values — change themes.scss and
 * sync here (see CLAUDE.md 主題配色規範). ORANGE and BLUE below complete the
 * seven tetromino colours and have no themes.scss counterpart yet.
 */

import type Phaser from 'phaser';
import type { ZoneKind } from '@/game/terrain/land-zone';
import {
  SIGN_ZONES, signContent, signPlacement, signStrokes, type SignVocabulary,
} from '@/game/terrain/sign-spec';
import { SIGN_TOPFACE, signShift, signStroke, signTriPoints } from './sign-carrier';
import { INTRO_DURATION_S, type DrawnBox, type PhaserStyleStrategy } from './phaser-style-strategy';

// ── Tetromino palette (mirrors themes.scss $plastic unless noted) ──

const T_CYAN = 0x00d8ff;   // --pl-cyan    (I)
const T_YELLOW = 0xffea00; // --pl-yellow  (O)
const T_PURPLE = 0xd500f9; // --pl-purple  (T)
const T_GREEN = 0x76ff03;  // --pl-green   (S)
const T_ORANGE = 0xff8c1a; // no themes.scss token — tetromino L
const T_BLUE = 0x2979ff;   // no themes.scss token — tetromino J
const T_PINK = 0xff3b8d;   // --pl-pink    (Z)

/** The seven block colours, cycled across the terrain surface. */
const NEON: readonly number[] = [T_CYAN, T_YELLOW, T_PURPLE, T_GREEN, T_ORANGE, T_BLUE, T_PINK];

/**
 * The demo's `CANDY` — the six colours the five zone bodies are painted from,
 * in the demo's order (`plan/phaser-plastic-demo.html`).
 *
 * SIX, not `NEON`'s seven, and that is not a detail: every body indexes it as
 * `(ci + k) % 6`, so a seventh entry re-phases which colour lands next to which
 * on a stacking tower's three-colour cycle and on the letter row's `(i + t) * 2`
 * stride. Every one of the six is a `themes.scss` `$plastic` token; the two
 * NEON-only colours (ORANGE, BLUE) exist for the tetromino terrain and have no
 * token, so keeping them out of the bodies moves this file CLOSER to 主題配色規範,
 * not further from it.
 */
const CANDY: readonly number[] = [T_PINK, T_CYAN, T_YELLOW, T_GREEN, T_PURPLE, 0xffb300];

/** Grid cell size — buildings (`gridBox`, `towerGrid`) and the ground snap
 *  share it. */
const TILE = 24;

/**
 * The demo's two baseplate moduli.
 *
 * `STUD` is the stud pitch and「這個世界的模距」; `BRICK_H` is one course of
 * brick. They are the demo's literals and they are NOT `TILE`: the toy world has
 * three different modules at once and always did — a stud is 18 across, a course
 * is 26 tall, and the building grid is 24. Folding them together would move
 * every body that `gridBox` has already placed (and `check2DFootprintSizing`
 * asserts at 12 px half-bricks), for a tidiness nobody can see.
 *
 * ⚠ The ground SNAP stays on `TILE`, not `BRICK_H`. The demo's `brickY` snaps to
 * its own 26 because 26 is the only module it has; here `snapGroundY` is what
 * the rider, the coins, the flags and every building base stand on, and it has
 * been 24 since `gridBox` landed. Course seams are drawn per column FROM that
 * column's own surface (the demo's own arrangement — neighbouring columns at
 * different heights never share a seam line anyway), so the two moduli do not
 * have to agree for the courses to read.
 */
const STUD = 18;
const BRICK_H = 26;

/** The two parallax mountain layers — the demo's `drawMountains` table, minus
 *  its `sf` / `baseOff` (this renderer's caller owns the scroll factor and the
 *  base line) and minus its two colour literals (see `drawMountainSilhouette`
 *  and `PALETTE.mountainFar` / `mountainNear`). */
const MOUNTAIN_FAR_LAYER = { step: 46, maxH: 0.36 } as const;
const MOUNTAIN_NEAR_LAYER = { step: 34, maxH: 0.26 } as const;

/** Entrance animation: how far each column falls, and how long its fall takes. */
const DROP_HEIGHT_PX = 520;
const DROP_FALL_S = 0.5;

const DEEP_LINE = 0x2d2260;  // urban ground shadows
const NIGHT_BG = 0x0a081a;   // --pl-page-lo

/**
 * The baseplate — the demo's `C.baseGreen` / `C.baseSide` / `C.baseDeep`,
 * mirrored from the 3D toy world's terrain ramp (the demo says so where it
 * declares them).
 *
 * `baseGreen` is the TOP face, `baseSide` the vertical one. The side being a
 * step darker than the top is one of the three things the demo's `drawTerrain`
 * lists as what makes a flat side view read as a moulded baseplate at all; the
 * other two are the row of studs and the staggered brick courses.
 *
 * These replace the dark violet bedrock the neon-Tetris terrain stood on.
 */
const BASE_GREEN = 0x39e75f;
const BASE_SIDE = 0x1fae44;
// (`C.baseDeep` = 0x158a34 is declared in the demo's palette and drawn by
// nothing — its courses use `darken(baseSide, 0.72)` instead. Not copied: an
// unused constant is not part of the port.)

/**
 * The sky — `plan/phaser-plastic-demo.html`'s `BG_DAY_TOP` / `BG_DAY_BOT` /
 * `BG_NIGHT_TOP` / `BG_NIGHT_BOT`, mirrored from `themes.scss $plastic`
 * (`--pl-sky-day-hi` … `--pl-sky-night-lo`).
 *
 * This file used to hold a dark violet arcade sky, and that was not a colour
 * choice that survived the world changing under it: the demo's header says the
 * neon-Tetris shell (CRT scanlines, neon grid, dark backdrop) was DELETED when
 * the toy box moved in, because「配糖果色會變濁」— candy plastic against a dark
 * ground goes muddy. Bright sky, solid candy bodies, no glow: that is the world
 * the five zone bodies were drawn for.
 */
const BG_DAY_TOP = 0x8fd8ee;
const BG_DAY_BOT = 0xffe0ef;
const BG_NIGHT_TOP = 0x14103a;
const BG_NIGHT_BOT = 0x3a2a66;

// ── Palette ──

const PALETTE = {
  terrainFill: BASE_SIDE,
  terrainOutline: BASE_GREEN,
  ink: 0x1a1140,           // --pl-ink
  skyDayTop: BG_DAY_TOP,
  skyDayBottom: BG_DAY_BOT,
  // The BODIES' palette, so `terrain-builder`'s `hash % buildingColors.length`
  // spreads a chunk evenly over the six colours the five zone bodies actually
  // index (`CANDY`). It was NEON's seven — one of which (a colour no body can
  // ever paint) was drawn 1/7 of the time and folded onto CANDY[0] by the
  // bodies' own `% 6`.
  buildingColors: [...CANDY],
  treeTrunk: 0x2d2260,
  treeCanopy: T_GREEN,
  treeCanopyColors: [
    T_GREEN,
    0x00c853, // --pl-green-deep
    T_CYAN,
    T_PURPLE,
  ],
  waterFill: 0x2979ff,
  waterOutline: T_CYAN,
  grassOverlay: T_GREEN,
  lampPost: 0x2d2260,
  lampGlow: T_YELLOW,
  // The demo's two parallax layers (`drawMountains`'s `L.c`). Its own comment
  // says why they are GREYER and PALER than the baseplate rather than the same
  // candy green: 「跟底板同一個鮮綠的話,遠山跟地形會糊成同一塊 —— 都是綠的、
  // 都有凸點、都是階梯,分不出遠近」. They replaced two violets that only made
  // sense under the deleted arcade sky.
  mountainFar: 0x86b9a6,
  mountainNear: 0x4f9d78,
  // Cloud: the day sky's own horizon pink, so a block cloud reads as a lighter
  // mass in a bright sky instead of the slate-blue it was against the old dark
  // one. (The demo draws no clouds at all — see `drawCloud`.)
  cloud: 0xfff1f7,
  moon: 0xe8e0ff,
  coinGold: T_YELLOW,
  coinHighlight: 0xffffff,
  coinOutline: 0xffb300, // --pl-amber
  markerTick: T_CYAN,
  // Not in the demo (it has no weather). Moved off the old violet with the sky:
  // a violet haze laid over a cyan-to-pink gradient reads as a bruise. This is
  // the day horizon, which is what haze in this world would actually be.
  fogColor: BG_DAY_BOT,
  cyclistBody: 0xffffff,
  cyclistHelmet: T_YELLOW,
  cyclistSkin: 0xffcc80,
} as const;

// ── Block drawing ──

function darken(color: number, f: number): number {
  const r = Math.round(((color >> 16) & 0xff) * f);
  const g = Math.round(((color >> 8) & 0xff) * f);
  const b = Math.round((color & 0xff) * f);
  return (r << 16) | (g << 8) | b;
}

/** …and toward white. Same signature, `f` = how far. */
function lighten(color: number, f: number): number {
  const m = (v: number) => Math.round(v + (255 - v) * f);
  return (m((color >> 16) & 0xff) << 16) | (m((color >> 8) & 0xff) << 8) | m(color & 0xff);
}

/** One glowing tetromino cell at grid position (x, y), size px. */
function neonCell(
  gfx: Phaser.GameObjects.Graphics,
  x: number, y: number, size: number, color: number, alpha: number,
) {
  gfx.fillStyle(darken(color, 0.24), alpha);
  gfx.fillRect(x + 1, y + 1, size - 2, size - 2);
  gfx.lineStyle(4, color, 0.22 * alpha);   // outer bloom
  gfx.strokeRect(x, y, size, size);
  gfx.lineStyle(2, color, 0.95 * alpha);   // bright edge
  gfx.strokeRect(x + 2, y + 2, size - 4, size - 4);
  gfx.lineStyle(1, 0xffffff, 0.5 * alpha); // top highlight
  gfx.lineBetween(x + 3, y + 3, x + size - 3, y + 3);
}

/** Deterministic 0..1 from any number — same block, same colour, every frame. */
function seeded(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ── Zone-driven building bodies ─────────────────────────────────────────────
//
// The map already says what a district is FOR, and this renderer used to throw
// it away: one tetromino tower stood in for a house, a hospital and a factory
// alike. These five bodies are `plan/phaser-plastic-demo.html`'s — the demo is
// the SPEC, not a sketch — and they are the same five the 3D plastic world
// builds off the same `ZoneIndex` (`terrain/plastic-terrain-style.ts`). Colours
// are mirrored from that file so one building does not come out two colours in
// the two views.
//
// **Scaling — the part the demo cannot tell us.** Its five are fixed-size props
// beside a synthetic route. Here every body has to fill a box the map hands it,
// and those boxes run from squat to very tall: 24 × 12 px for a 4 m house up
// to 48 × 300 for a tower (`terrain-builder` clamps the width to 15–40 px and
// lets the height run with `render_height`; `gridBox` covers that in
// half-bricks). Tiling a fixed unit does not work — a
// 300 px domino wall of 10 px plates is a picket fence — so each body derives
// its UNIT from the box and keeps its own proportion: a tall building gets
// BIGGER pieces, not more of them. That is also what bounds the cost, which the
// tetromino tower does not do (its cell count is linear in height, and a tall
// one costs ~209 draw commands).
//
// **What does NOT scale.** Two of the five are low and wide by identity (the
// letter blocks, the domino wall). Handed a 48 × 300 box they spread sideways
// past it and stay short rather than growing into a tower with letters on it —
// the low wide row IS the school. And at the extreme end the pieces stop being
// truthful: a 300 px domino is a slat, not a 3.4:1 domino. That is the same
// trade the 3D wall makes ("the plates simply get narrower than a real domino,
// which is a much smaller lie"), for the same reason.
//
// **Colour.** Solid two-tone candy — `darken(c, 0.7)` body with `c` across the
// top — which is the demo's language, not `neonCell`'s dark fill and glowing
// rim. The rim recipe costs ten draw commands per CELL; on the 2D CPU budget
// that is the one thing five bodies cannot afford.

/** The pixel house's window: a voxel RECOLOURED, never a hole cut in it. A hole
 *  in a 15 px silhouette is a hole in the dusk skyline. */
const CLAY_WINDOW = 0xfff3b0;
/** …and its door, same trick, one voxel of the ground floor. The demo's hex. */
const CLAY_DOOR = 0x8a6440;
/** Clay dries a shade paler than it was pressed, so the candy palette is pulled
 *  this far toward white. It is the cheapest half of what keeps the clay house
 *  apart from the stacking tower, which uses the same palette raw. */
const CLAY_LIGHTEN = 0.34;
/** Domino plates — the demo's `ivory`. Nothing else in this world is white,
 *  and that alone separates the hospital wall from three candy neighbours at
 *  any distance. WARM white, not the blue-white the port had invented: it is
 *  the one unsaturated mass in a candy street and a cool white reads as another
 *  moulded part. */
const PORCELAIN = 0xfff6ea;
/** The plate a cup tower stands its next storey of cups on — the demo's `C.plate`. */
const CUP_PLATE = 0xf4f6ff;
/** Letter blocks stand on a solid bar, so the gaps between them are not holes.
 *  The demo uses `C.plate` here too — same moulded white part. */
const ABC_PLINTH = 0xf4f6ff;
/**
 * The hospital marker's red.
 *
 * `themes.scss $plastic` has no true red (its nearest is `--pl-pink` #ff3b8d),
 * and a hospital mark has to be red — magenta on white does not read. So this is
 * the demo's own derived step from pink toward red, FOR THE MARK ONLY, and it is
 * the documented exception to 主題配色規範 rather than a stray hex.
 */
const CROSS_RED = 0xff2d3f;

// ── Night tones ──
//
// Mirrored from the 3D toy world (`terrain/plastic-terrain-style.ts`), which
// lights the same parts by registering a material with `registerNightLitMaterial`
// and writing one global emissive factor. 2D has no materials, so every one of
// these is a draw on the chunk's additive lights layer — which is why the bodies
// below light a HANDFUL of marks each and never a grid.
//
/** The letter blocks' rim (3D `abcRimMat`). */
const ABC_RIM_GLOW = 0xffd77e;
/** The domino pips and the groove that halves the plate (3D `dominoInkMat`). */
const DOMINO_PIP_GLOW = 0xffe1a0;
/** Lit windows — the clay house's recoloured voxel and the tower's slab ends.
 *  No 3D hex to mirror: over there they are instanced quads sharing the scene's
 *  one window material. This is CLAY_WINDOW warmed a step, so the voxel that is
 *  pale yellow by day is the same window after dark. */
const WINDOW_GLOW = 0xffe8a8;

/**
 * The letter blocks' own stroke font — `plan/phaser-plastic-demo.html`'s
 * `LETTER_STROKES`, verbatim.
 *
 * NOT `sign-spec.ts`'s `SIGN_GLYPHS`, and the demo says why where it declares
 * this table: they are TWO fonts on purpose. `SIGN_GLYPHS` is the cross-world
 * shared part — every sign in every world must letter identically, so it may
 * never be edited for one world's convenience — whereas this one belongs to a
 * single BUILDING BODY and therefore only admits letters a straight-stroke
 * moulded block can carry. Sharing them looked like a saving and was the port's
 * quietest deviation: it swapped this table's shapes (and its 15-letter
 * alphabet, which has C and O and no F or W) for the sign font's.
 *
 * Unit coordinates, x and y both 0..1, y down. No system font: it blurs at
 * riding distance and every machine picks a different fallback (法則 3.7).
 */
const LETTER_STROKES: Record<string, readonly (readonly [number, number, number, number])[]> = {
  A: [[0.06, 1, 0.5, 0], [0.5, 0, 0.94, 1], [0.2, 0.62, 0.8, 0.62]],
  C: [[0.94, 0.1, 0.16, 0.1], [0.16, 0.1, 0.16, 0.9], [0.16, 0.9, 0.94, 0.9]],
  E: [[0.18, 0.04, 0.18, 0.96], [0.18, 0.04, 0.92, 0.04], [0.18, 0.5, 0.78, 0.5], [0.18, 0.96, 0.92, 0.96]],
  H: [[0.14, 0, 0.14, 1], [0.86, 0, 0.86, 1], [0.14, 0.5, 0.86, 0.5]],
  I: [[0.18, 0.04, 0.82, 0.04], [0.5, 0.04, 0.5, 0.96], [0.18, 0.96, 0.82, 0.96]],
  K: [[0.16, 0, 0.16, 1], [0.88, 0, 0.16, 0.55], [0.34, 0.42, 0.88, 1]],
  L: [[0.2, 0.02, 0.2, 0.96], [0.2, 0.96, 0.9, 0.96]],
  M: [[0.1, 1, 0.1, 0], [0.1, 0, 0.5, 0.62], [0.5, 0.62, 0.9, 0], [0.9, 0, 0.9, 1]],
  N: [[0.14, 1, 0.14, 0], [0.14, 0, 0.86, 1], [0.86, 1, 0.86, 0]],
  O: [[0.16, 0.08, 0.84, 0.08], [0.84, 0.08, 0.84, 0.92], [0.84, 0.92, 0.16, 0.92], [0.16, 0.92, 0.16, 0.08]],
  T: [[0.06, 0.05, 0.94, 0.05], [0.5, 0.05, 0.5, 1]],
  V: [[0.08, 0, 0.5, 1], [0.5, 1, 0.92, 0]],
  X: [[0.1, 0, 0.9, 1], [0.9, 0, 0.1, 1]],
  Y: [[0.1, 0, 0.5, 0.52], [0.9, 0, 0.5, 0.52], [0.5, 0.52, 0.5, 1]],
  Z: [[0.12, 0.06, 0.88, 0.06], [0.88, 0.06, 0.12, 0.94], [0.12, 0.94, 0.88, 0.94]],
};
const LETTER_KEYS = Object.keys(LETTER_STROKES);

/**
 * Domino pip positions on the 3×3 field, in grid steps — the demo's `PIP_SPOTS`,
 * all SIX faces.
 *
 * The port had trimmed this to four ("at ~10 px across a five- or six-pip face
 * is a grey smear"). Restored: it is a domino, a domino has one to six, and the
 * smear argument is an argument about the SIZE the pips are drawn at, which the
 * demo answers with `r = max(1.4, w * 0.15)` — a floor, not a cull. Cutting the
 * top two faces also biased every wall toward sparse plates, which is the
 * opposite of the window density a hospital block wants after dark.
 */
const PIP_SPOTS: readonly (readonly (readonly [number, number])[])[] = [
  [[1, 1]],
  [[0, 0], [2, 2]],
  [[0, 0], [1, 1], [2, 2]],
  [[0, 0], [2, 0], [0, 2], [2, 2]],
  [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
];

/** The six bodies this style can draw. `tetromino` is the unzoned one. */
type PlasticBody = 'tetromino' | 'clay' | 'stack' | 'cup' | 'letters' | 'domino';

/** The demo's zone→building table, verbatim. */
const ZONE_BODY: Record<ZoneKind, PlasticBody> = {
  residential: 'clay',    // clay pixel house — stacked voxels, matte, pale
  commercial: 'stack',    // pull-out tower — stacked bars, hard gloss
  industrial: 'cup',      // cup tower — trapezoid, white shelves
  school: 'letters',      // letter blocks — one low wide row, embossed letters
  hospital: 'domino',     // domino wall — upright ivory plates, pips for windows
};

/** The demo's neighbour table, verbatim. Neighbours are FUNCTIONAL, not
 *  chromatic: a school has houses around it, industry has commerce. */
const ZONE_NEIGHBORS: Record<ZoneKind, readonly [ZoneKind, ZoneKind]> = {
  residential: ['commercial', 'school'],
  commercial: ['residential', 'industrial'],
  industrial: ['commercial', 'hospital'],
  school: ['residential', 'hospital'],
  hospital: ['school', 'commercial'],
};

/**
 * Which body this footprint gets.
 *
 * Zone → body is a BIAS, not a mapping: 80 % the district's own building, 20 %
 * one of its two functional neighbours. A hard mapping gives five blocks of
 * sample housing laid end to end; one or two outsiders on a street is what
 * reads as a city (DEVPLAN, "分區『傾向』某種房子").
 *
 * Pure in `(seed, zone)` and deliberately NOT a shuffle bag. A bag carries
 * state between calls, so the body a footprint got would depend on the order
 * the chunk happened to draw its neighbours — and chunks unload and reload as
 * the rider moves, so the same building would change shape when you rode back
 * past it. Its own hash stream, too: sharing the window/colour one would tie
 * which building type came up to which colour it was painted.
 *
 * An UNZONED footprint keeps the tetromino tower. Not residential: `zoneAt`
 * returns null for everything outside a landuse polygon, which is most of a
 * real route, and reading that as housing turns a country road into a suburb.
 */
function bodyKind(seed: number, zone: ZoneKind | null): PlasticBody {
  if (!zone) return 'tetromino';
  const roll = seeded(seed * 23 + 3);
  const src = roll < 0.8 ? zone : ZONE_NEIGHBORS[zone][roll < 0.9 ? 0 : 1];
  return ZONE_BODY[src];
}

/** A body's drawing box: left edge, width, the ground line it stands on, and
 *  how tall it is. */
interface BodyBox { x: number; w: number; gy: number; h: number; }

/** Half a terrain brick — the step the zone bodies quantise to. Whole bricks
 *  cannot tell a 4 m house (10 px) from a 12 m block (29 px): both are "about
 *  one brick", and the old whole-brick snap with its two-row height floor
 *  pushed EVERY small footprint up to 24 × 48 — a street's worth of different
 *  buildings drawn as one object (plan/migrate-demo-worlds.md §3.12). Half a
 *  brick is the coarsest step that keeps the four common street footprints
 *  (15×10 / 15×19 / 17×29 / 29×48) four different sizes. */
const HALF_TILE = TILE / 2;

/**
 * The smallest a body's repeating unit may be — a voxel, a bar, a cup, a plate.
 *
 * MEASURED, not defensive, and the same finding as the 3D port's
 * `MIN_BODY_HEIGHT`. Every one of the demo's five bodies divides by a size it
 * derives from the box, and the demo never had to think about it because its own
 * props are 90–130 px. The saved Taipei route hands `render_height` of exactly 0
 * over a thousand footprints; `gridBox` rounds 0 up to 0, and a unit of 0 turns
 * `count = span / unit` into Infinity — a 4 GB heap exhaustion, not a slow frame.
 * That is exactly how the first run of the 3D port died.
 *
 * Three pixels rather than a hair above zero because these counts are `span /
 * unit`: at 0.1 px a 40 px footprint asks for 400 cups.
 */
const MIN_UNIT = 3;

/**
 * The box a body actually occupies.
 *
 * Still quantised — this is a world built by stacking bricks, and a body sized
 * to the raw box would be the one thing in it standing off the grid — but to
 * HALF bricks, rounded UP: a footprint gets the bricks that COVER it, the way
 * a 15 px wall takes two half-bricks, never fewer than one each way. Rounding
 * to nearest instead would fold 15×19 and 17×29 back onto one box, which is
 * §3.12 again at a finer pitch. The unzoned tower keeps whole bricks
 * (`towerGrid`): its cell IS the terrain brick, and that is as finely as its
 * grid can speak.
 */
function gridBox(x: number, y: number, w: number, h: number): BodyBox {
  return {
    x: Math.round(x / HALF_TILE) * HALF_TILE,
    w: Math.ceil(w / HALF_TILE) * HALF_TILE,
    gy: Math.round((y + h) / TILE) * TILE,
    h: Math.ceil(h / HALF_TILE) * HALF_TILE,
  };
}

/** The unzoned tetromino tower's cells, snapped to the world grid so towers line
 *  up with the ground. Kept out of `renderBuilding` so the night pass walks the
 *  same cells rather than re-deriving them. Whole bricks, rounded UP like
 *  `gridBox` — but the floor is ONE row, not the old two: forcing a second row
 *  was half of §3.12, every 4 m shed standing two bricks tall. A 4 m and an
 *  8 m footprint still come out the same single brick, and that is the honest
 *  limit of a body whose cell is the terrain brick, not a bug to chase with
 *  half-cells (a 12 px neonCell would be a new part, §3.3). */
function towerGrid(x: number, y: number, w: number, h: number) {
  return {
    cols: Math.max(1, Math.ceil(w / TILE)),
    rows: Math.max(1, Math.ceil(h / TILE)),
    baseCol: Math.round(x / TILE),
    groundRow: Math.round((y + h) / TILE),
  };
}

/** Whether the tower's cell at grid (col, row) has a light in it. Keyed on the
 *  WORLD grid position, not the loop index, so the pattern stays put on the
 *  world when a chunk reloads. */
function towerLit(col: number, row: number, seed: number): boolean {
  return seeded(col * 7 + row * 13 + seed) > 0.55;
}

/**
 * One stud — the smallest identifying mark in this world. The demo's `stud`,
 * verbatim: a rounded barrel, the dome, and the specular catch on the dome.
 *
 * The port had dropped the third command ("about one pixel across on a 12 px
 * letter block"). It is not one pixel: at the demo's own widths the catch is
 * `w * 0.5 × 2.4`, i.e. half the stud across, and it is the only thing that says
 * the top is a DOME rather than a printed circle. Restored; measured cost is one
 * fill per stud (see the counts in `renderBuilding`'s comment).
 *
 * The 6 / 7 / 5.5 / 6.8 / 2.4 are the demo's ABSOLUTE pixels and are kept
 * absolute, because the demo itself uses this one function at four very
 * different widths (baseplate 11.2, mountain 10.2–13.8, letter block ~13.4,
 * the rider's helmet 7) without scaling them.
 */
function stud(gfx: Phaser.GameObjects.Graphics, x: number, y: number, w: number, col: number) {
  gfx.fillStyle(darken(col, 0.82), 1);
  gfx.fillRect(x - w / 2, y - 6, w, 7);
  gfx.fillStyle(col, 1);
  gfx.fillEllipse(x, y - 6, w, 5.5);
  gfx.fillStyle(lighten(col, 0.45), 1);
  gfx.fillEllipse(x - w * 0.12, y - 6.8, w * 0.5, 2.4);
}

/** How far a stud stands above the face it is on: the demo's barrel (6) plus
 *  the half-height of the specular catch drawn at y − 6.8 (1.2). Constant,
 *  because the demo's stud is. Small, but on the letter blocks it IS the top of
 *  the skyline and the school is the body whose reported extent matters most
 *  (`plan/migrate-demo-worlds.md` §3.8). */
const STUD_RISE = 8;

/**
 * One glyph as thick strokes — the demo's `letter`, verbatim.
 *
 * Each segment is TWO triangles plus a square cap at each end, which is four
 * draw commands where a `lineBetween` would be one. That is the demo's own
 * trade and the reason is in its comment: square joins. A stroked line in
 * Phaser has butt caps, so at a letter's corners (A's apex, K's junction, Z's
 * two turns) the two segments leave a notch; the demo fills the corner with a
 * `t × t` square so the join is SHARP. Rounding it — which is what a round-cap
 * line would do — is the one thing the demo says not to do here (「補圓角就不
 * 銳利了」), because hard corners are half of what separates the moulded letter
 * block from the clay house next door.
 */
function letterStrokes(
  gfx: Phaser.GameObjects.Graphics,
  ch: string, x: number, y: number, w: number, h: number, t: number, col: number,
  alpha = 1,
) {
  const segs = LETTER_STROKES[ch];
  if (!segs) return;
  gfx.fillStyle(col, alpha);
  for (const s of segs) {
    const x0 = x + s[0] * w, y0 = y + s[1] * h;
    const x1 = x + s[2] * w, y1 = y + s[3] * h;
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
    const px = (-dy / L) * (t / 2), py = (dx / L) * (t / 2);
    gfx.fillTriangle(x0 + px, y0 + py, x1 + px, y1 + py, x1 - px, y1 - py);
    gfx.fillTriangle(x0 + px, y0 + py, x1 - px, y1 - py, x0 - px, y0 - py);
    gfx.fillRect(x0 - t / 2, y0 - t / 2, t, t);
    gfx.fillRect(x1 - t / 2, y1 - t / 2, t, t);
  }
}

/**
 * Residential — the clay pixel house.
 *
 * Hand-pressed cubes stacked into a house with a gabled top. Three things carry
 * "clay" in a flat side view, and dropping any one turns it straight back into
 * toy bricks:
 *  · PALE — the candy colour pulled toward white (`CLAY_LIGHTEN`).
 *  · NO TWO ALIKE — size and position jitter on every voxel.
 *  · PRESSED TOGETHER — voxels are drawn LARGER than their pitch, so the seams
 *    read as squash marks. Leave a gap and it is a brick stack again.
 *
 * The ROOF gets its own course height rather than a share of the courses, and
 * that is not a detail: the boxes this renderer gets are 1:2 to 1:5, so courses
 * sized to fill the height turn every voxel into a plank — and a gable built out
 * of two planks is a chimney, not a roof. Capping the gable at about a third of
 * the box keeps a house-shaped top on a body that has to stretch.
 */
function clayHouse(
  gfx: Phaser.GameObjects.Graphics, b: BodyBox, colorIndex: number, seed: number,
): DrawnBox {
  const L = clayLayout(b);
  const { S, SP, nx, floors, roofL } = L;
  const x = b.x + b.w / 2;
  const body = lighten(CANDY[colorIndex % 6], CLAY_LIGHTEN);
  const roof = lighten(CANDY[(colorIndex + 3) % 6], CLAY_LIGHTEN);

  for (let iy = 0; iy < floors + roofL; iy++) {
    const inset = Math.max(0, iy - floors + 1);
    const x0 = inset, x1 = nx - 1 - inset;
    if (x1 < x0) break;
    const isRoof = iy >= floors;
    for (let ix = x0; ix <= x1; ix++) {
      const n = seed + ix * 7 + iy * 31;
      let col = isRoof ? roof : body;
      if (iy === 0 && ix === (nx - 1) / 2) col = CLAY_DOOR;
      else if (iy === CLAY_WINDOW_FLOOR && (ix === x0 + 1 || ix === x1 - 1)) col = CLAY_WINDOW;
      const p = clayLump(L, x, b.gy, ix, iy, n);
      gfx.fillStyle(darken(col, 0.78), 1);
      gfx.fillRoundedRect(p.cx - p.sz / 2, p.cy - p.sz / 2, p.sz, p.sz, p.sz * 0.24);
      gfx.fillStyle(col, 1);
      gfx.fillRoundedRect(p.cx - p.sz / 2, p.cy - p.sz / 2, p.sz, p.sz * 0.82, p.sz * 0.24);
    }
  }
  // Reported as the BRICK BOX, not the art's own bounds.
  //
  // This is the one place the three brick bodies (clay / stack / cup) do not
  // report what they literally drew, and the reason is that they are the bodies
  // that sit ON the grid: `check2DFootprintSizing` requires their reported box
  // to be a whole number of half-bricks and never smaller than the footprint,
  // because a body that reports a smoothly-scaled box has stopped speaking this
  // world's language even if it draws correctly. A house of square voxels cannot
  // simultaneously fill a 2 : 1 box and stay square, so the difference is
  // absorbed here rather than in the geometry. Measured worst case is
  // `phaser-style-probe.mjs`'s slack column — keep it under §3.8's 4.1 px.
  return { x: b.x, y: b.gy - b.h, w: b.w, h: b.h };
}

/** The course the clay house's windows sit on. The demo's `iy === 1`: not the
 *  ground floor, which carries the door. */
const CLAY_WINDOW_FLOOR = 1;

/**
 * The voxel size a clay house is drawn from, and how many columns of it fit.
 *
 * The demo's own structure survives whole — `floors = 3`, `roofL = 2`, a square
 * voxel `S` across laid at the pitch `SP = S * 0.94` that presses the lumps into
 * each other — and only the SIZE is derived, by the rule the 3D port settled on
 * (`terrain/plastic-terrain-style.ts`): scale the prop by the box HEIGHT, then
 * count units across the box WIDTH at the scaled pitch. A tall building gets
 * BIGGER voxels, not more of them, which is also what bounds the cost.
 *
 * `S` is rounded to a whole pixel because the demo's is (`Math.round(20 *
 * b.scale)`), and the width divides it back out so a 20 px footprint under a
 * 300 px height cannot grow a house five times wider than its own plot.
 *
 * ⚠ `MIN_UNIT` is not defensive. A real route hands `render_height` of exactly
 * 0 (the 3D port measured it as the minimum over 1 000 bodies), `gridBox` rounds
 * that up to 0, and `S = 0` makes `SP` zero and the column count `w / 0` =
 * Infinity. That is the 2D twin of the 4 GB heap exhaustion that killed the
 * first run of the 3D port.
 */
function clayLayout(b: BodyBox) {
  // 4.72 / 2.88 are the demo's own `bodyBox` ratios: total height ÷ S at
  // (floors 3 + roofL 2), and total width ÷ S at the narrowest legal row (3).
  // The width participates so a 20 px footprint under a 300 px height cannot
  // grow a house ten times wider than the plot it stands on; when it bites, the
  // COURSE COUNT below takes up the slack instead.
  const S = Math.max(MIN_UNIT, Math.round(Math.min(b.h / 4.72, b.w / 2.88)));
  const SP = S * 0.94;
  // Count across at the scaled pitch, then force ODD. The gable insets one
  // voxel at each end per course, so only an odd row can peak in a single
  // voxel; an even one peaks in two and reads as a flat-topped shed.
  const raw = Math.round((b.w - S) / SP) + 1;
  const nx = clamp(2 * Math.round((raw - 1) / 2) + 1, 3, 7);
  // Gable courses. Never more than the demo's two, and never more than the row
  // can carry — nx 3 peaks after one. Identical to letting the demo's
  // `if (x1 < x0) break` fire, written out so the reported height need not guess.
  const roofL = Math.min(2, Math.floor((nx - 1) / 2));
  // Courses. THREE is the demo's and is also the floor, because the ground
  // course carries the door and the one above it the window. Above that the
  // house grows in courses rather than in voxel size, which is what lets a
  // width-capped tall box actually reach its own roofline: without it a 48 × 84
  // footprint drew 64 px of house and reported 84, i.e. 19.7 px of §3.8 slack
  // (measured on `phaser-style-probe.mjs` — it is now 3.6). The 40 is a stop,
  // not a target: cost here is ~18 fills per unit of box ASPECT, so it only
  // binds on something 200 storeys tall.
  const floors = clamp(Math.round(b.h / SP) - roofL, 3, 40);
  return { S, SP, nx, floors, roofL };
}

/**
 * Where one pressed lump lands — the demo's arithmetic, in one place so the
 * night layer lights the voxel the body actually drew.
 *
 * The jitter is part of the answer, not noise: it is the demo's second clay
 * rule (「每顆都歪一點」). Its 3.2 / 2.4 are ABSOLUTE pixels tuned at the demo's
 * S = 20, so they are divided back by that 20 — the same "keep the demo's
 * literal, write the normalising divisor next to it" the 3D port uses.
 */
function clayLump(
  L: ReturnType<typeof clayLayout>,
  x: number, gy: number, ix: number, iy: number, n: number,
) {
  const k = L.S / 20;
  return {
    cx: x + (ix - (L.nx - 1) / 2) * L.SP + (seeded(n) - 0.5) * 3.2 * k,
    cy: gy - iy * L.SP - L.SP / 2 + (seeded(n + 1) - 0.5) * 2.4 * k,
    sz: L.S * (0.95 + seeded(n + 2) * 0.12),
  };
}

/**
 * Residential at night: the window voxels, and nothing else.
 *
 * ⚠ NOT FROM THIS DEMO. `plan/phaser-plastic-demo.html` lights NO building at
 * all — its only night emitter is the bubble lamp, and every body including
 * this one sits 40 depth units UNDER the veil (§3.4 of
 * `plan/migrate-demo-worlds.md`, and confirmed by reading every `this.night`
 * site in the demo). The lights in this file and its four siblings are mirrored
 * from the 3D toy world (`terrain/plastic-terrain-style.ts`), where all five
 * districts do light, and they are kept because a world whose night is
 * completely dark is not obviously the better answer. **Whether 2D should
 * follow the 2D demo (dark) or the 3D world (lit) is the developer's call.**
 *
 * The 3D house answers exactly this (`clayHouseLayout(box, seed).windows` —
 * "the light still comes from the layout that decided where the yellow voxel
 * went"). The door is not a light and the roof is not a light; one or two soft
 * ellipses is the whole of a house after dark, which is also what keeps a
 * residential street from reading as a downtown.
 */
function clayNightLights(
  gfx: Phaser.GameObjects.Graphics, b: BodyBox, seed: number,
) {
  const L = clayLayout(b);
  const x = b.x + b.w / 2;
  // The demo's window course, and the demo's own two columns on it: at `iy = 1`
  // the row is uninset, so `x0 + 1` and `x1 - 1` are 1 and `nx - 2`. On a
  // three-wide house those are the SAME voxel — one window, not two drawn twice.
  const cols = L.nx - 2 === 1 ? [1] : [1, L.nx - 2];
  // Kept low — but its REASON has moved once already, so mind the arithmetic
  // before retuning. This 0.5 was born pre-veil, when the voxel under it stayed
  // at full daytime brightness. Since option D (plan/phaser-2d-lighting.md) the
  // night veil dims the voxel first, but this layer composites ABOVE the veil
  // at layer alpha 0.9, so its whole contribution lands: at 0.5 the sum on the
  // veiled voxel is ~(255,232,183) — R at the ceiling, G/B still carrying the
  // warm colour, i.e. a warm-white window. At the towers' 0.75 it would clip
  // to (255,255,221) and stop being a colour at all. Verify with
  // `phaser-style-probe.mjs NIGHT=1` before touching either number.
  gfx.fillStyle(WINDOW_GLOW, 0.5);
  for (const ix of cols) {
    const n = seed + ix * 7 + CLAY_WINDOW_FLOOR * 31;
    const p = clayLump(L, x, b.gy, ix, CLAY_WINDOW_FLOOR, n);
    // A little wider than the voxel: a fill that stops at the window's edge
    // reads as a sticker, and spill is the only bloom 2D has.
    gfx.fillEllipse(p.cx, p.cy, p.sz * 1.2, p.sz * 1.05);
  }
}

/**
 * Commercial — the pull-out tower (抽抽樂 / Jenga).
 *
 * Bars stacked flat: some pulled half out, some gone entirely. The dark core
 * behind them is not decoration — pull a bar with no core there and you see
 * straight through the tower to the sky.
 *
 * Bar thickness comes from the height and the count from the thickness, so a
 * tall tower gets THICKER bars rather than forty thin ones (that is a ladder,
 * and it is where the cost would run away).
 */
function stackTower(
  gfx: Phaser.GameObjects.Graphics, b: BodyBox, colorIndex: number, seed: number,
): DrawnBox {
  const L = stackLayout(b, seed);
  const x = b.x + b.w / 2, w = b.w, lh = L.lh, gap = L.gap;
  const pal = [
    CANDY[colorIndex % 6],
    CANDY[(colorIndex + 2) % 6],
    CANDY[(colorIndex + 4) % 6],
  ];

  // The dark core. Not decoration: pull a bar with no core behind it and you see
  // straight through the tower to the sky.
  gfx.fillStyle(darken(pal[0], 0.42), 1);
  gfx.fillRect(x - w * 0.34, b.gy - L.layers * lh, w * 0.68, L.layers * lh);

  for (let i = 0; i < L.layers; i++) {
    const bar = stackBar(b, L, seed, i);
    if (bar.gone) continue;
    const y = b.gy - (i + 1) * lh;
    const col = pal[i % 3];
    const { pull, dir } = bar;
    gfx.fillStyle(darken(col, 0.7), 1);
    gfx.fillRect(x - w / 2 + pull * dir, y, w, lh - gap);
    gfx.fillStyle(col, 1);
    gfx.fillRect(x - w / 2 + pull * dir, y, w, (lh - gap) * 0.72);
    // The end face of a pulled bar, one shade up. Without it the bar reads as
    // printed on rather than slid out. The demo's 4 px, and the demo's own
    // asymmetric placement (the far end when it slid right, the near end when
    // it slid left) — which is correct, because you only ever see the face the
    // bar was pulled AWAY from.
    if (pull) {
      gfx.fillStyle(lighten(col, 0.3), 1);
      gfx.fillRect(dir > 0 ? x + w / 2 + pull - 4 : x - w / 2 + pull * dir, y, 4, lh - gap);
    }
  }
  // A pulled bar can stand up to ~0.42 × w proud of the box; reported as the
  // solid mass (see `DrawnBox`).
  return { x: b.x, y: b.gy - L.layers * lh, w: b.w, h: L.layers * lh };
}

/**
 * How the tower's height splits into bars.
 *
 * `layers` is the demo's own roll — `7 + floor(seeded(d) * 3)` — so a street of
 * towers varies the way the demo's does, and the bar thickness follows from the
 * box height. The demo's `gap = 2.5` px is kept as the literal it is, with the
 * demo's own ratio (2.5 / 15) as the ceiling for bars thinner than the demo's:
 * a flat 2.5 px seam on a 6 px bar is 42 % air and reads as a venetian blind.
 *
 * ⚠ The clamp on `layers` is the guard the demo never needed. Its towers are
 * 105–135 px tall, so nine bars are 15 px each; `gridBox` hands this a 12 px box
 * for a 4 m shop, where nine bars are 1.3 px. `MIN_UNIT` keeps a bar a bar.
 */
function stackLayout(b: BodyBox, seed: number) {
  const layers = clamp(7 + Math.floor(seeded(seed) * 3), 2, Math.max(2, Math.floor(b.h / MIN_UNIT)));
  const lh = b.h / layers;
  return { layers, lh, gap: Math.min(2.5, lh * (2.5 / 15)) };
}

/** One bar: whether it was pulled out of the stack entirely, how far it slid,
 *  and which way. Shared with `stackNightLights` so a lit end never hangs in the
 *  air where the body decided there is no bar.
 *
 *  `160 * b.scale` is the demo's pull, with the demo's own `w = 54 * b.scale`
 *  divided back out so the slide stays the same FRACTION of the tower it is on. */
function stackBar(
  b: BodyBox, L: ReturnType<typeof stackLayout>, seed: number, i: number,
) {
  const roll = seeded(seed * 3 + i * 17);
  // Never the bottom or top bar: the tower has to keep standing on something
  // and has to keep a lid.
  const gone = i > 0 && i < L.layers - 1 && roll < 0.14;
  const pull = i < L.layers - 1 && roll > 0.86 ? (roll - 0.86) * (160 / 54) * b.w : 0;
  const dir = seeded(seed + i) > 0.5 ? 1 : -1;
  return { gone, pull, dir, x: b.x + pull * dir, y: b.gy - (i + 1) * L.lh };
}

/**
 * Commercial at night: the ENDS of the bars.
 *
 * The 3D tower's ruling, ported: "the tower's windows ARE its exposed short
 * faces… those squares are already there, already the right size, and already
 * in the right places — lighting a few of them is the whole feature." A flat
 * side elevation shows the two ends of every bar, so those are the squares here,
 * and the pulled ones stay attached to the bar that slid out.
 *
 * The lit fraction is the 3D one, per district — a commercial tower standing in
 * a residential block is dimmer than one downtown. Its OWN hash stream: share
 * `stackBar`'s and deciding which windows are lit would also re-roll which bars
 * got pulled out.
 */
function stackNightLights(
  gfx: Phaser.GameObjects.Graphics, b: BodyBox, seed: number, zone: ZoneKind | null,
) {
  const L = stackLayout(b, seed);
  const lit = zone === 'commercial' ? 0.55 : zone === 'residential' ? 0.42 : 0.34;
  const barH = L.lh - L.gap;
  const ww = clamp(b.w * 0.14, 2.5, 5);
  const wh = Math.max(2, barH * 0.5);
  gfx.fillStyle(WINDOW_GLOW, 0.75);
  for (let i = 0; i < L.layers; i++) {
    const bar = stackBar(b, L, seed, i);
    if (bar.gone) continue;
    for (const s of [-1, 1]) {
      if (seeded(seed * 7.7 + i * 3.1 + (s > 0 ? 41.3 : 0)) > lit) continue;
      gfx.fillRect(
        s < 0 ? bar.x + 1 : bar.x + b.w - ww - 1,
        bar.y + (barH - wh) / 2, ww, wh,
      );
    }
  }
}

/**
 * Industrial — the cup tower.
 *
 * The third silhouette in the skyline: a TRAPEZOID. A row of moulded cups per
 * storey, a white plate between storeys, one fewer cup per storey going up.
 * Without the plate the cups sit rim-on-base and the whole thing reads as a
 * fluted column instead of something stacked.
 *
 * Each cup is two four-point fills, not the demo's four triangles: Phaser fills
 * a convex quad in one command, so the triangle pairs were pure cost.
 */
function cupTower(
  gfx: Phaser.GameObjects.Graphics, b: BodyBox, colorIndex: number, _seed: number,
): DrawnBox {
  const L = cupLayout(b);
  const { cw, ch } = L;
  const x = b.x + b.w / 2;
  let y = b.gy;
  for (let lv = 0; lv < L.levels; lv++) {
    const n = Math.max(1, L.cols0 - lv);
    const col = CANDY[(colorIndex + lv) % 6];
    for (let i = 0; i < n; i++) {
      const cx = x + (i - (n - 1) / 2) * (cw + 3);
      // FOUR triangles, which is what the port had "optimised" into two convex
      // quads. They are not the same shape: the demo's outer pair spans
      // `-cw/2 … +cw/2` at the rim and `-0.34cw … +0.34cw` at the foot, and the
      // bright inner pair is inset by a flat 3 px at the top and 2 px at the
      // bottom — a constant inset, not a proportional one, which is what makes
      // the wall read as a THICKNESS rather than a gradient. Two quads at
      // 0.46 / 0.30 gave a narrower rim, a wider foot and a shallower taper.
      gfx.fillStyle(darken(col, 0.72), 1);
      gfx.fillTriangle(cx - cw / 2, y - ch, cx + cw / 2, y - ch, cx + cw * 0.34, y);
      gfx.fillTriangle(cx - cw / 2, y - ch, cx + cw * 0.34, y, cx - cw * 0.34, y);
      gfx.fillStyle(col, 1);
      gfx.fillTriangle(cx - cw * 0.42, y - ch + 3, cx + cw * 0.42, y - ch + 3, cx + cw * 0.3, y - 2);
      gfx.fillTriangle(cx - cw * 0.42, y - ch + 3, cx + cw * 0.3, y - 2, cx - cw * 0.3, y - 2);
      // The rolled rim. It is what says "cup" rather than "wedge".
      gfx.fillStyle(lighten(col, 0.4), 1);
      gfx.fillRect(cx - cw / 2 - 1, y - ch - 2, cw + 2, 3.5);
    }
    y -= ch + 2;
    if (lv < L.levels - 1) {
      // Sized to the storey it stands ON — `n` is still this level's count. The
      // port had sized it to the storey ABOVE, which makes the shelf narrower
      // than the cups holding it up and reads as a table with legs.
      gfx.fillStyle(CUP_PLATE, 1);
      gfx.fillRect(x - (n * (cw + 3)) / 2 - 3, y - 4, n * (cw + 3) + 6, 5);
      y -= 5;
    }
  }
  // The brick box, for the reason given on `clayHouse`'s return. The cup tower's
  // own extent tracks the box closely (within ~1.5 px on every street
  // footprint), so this costs almost nothing here.
  return { x: b.x, y: b.gy - b.h, w: b.w, h: b.h };
}

/**
 * Cups per storey, storeys, and the shelf between them.
 *
 * The demo's cup is `22 × 26` at scale 1 on a `cw + 3` pitch, with a 5 px shelf
 * and a 2 px seat between storeys; those are the literals below. Only the SIZE
 * is derived, by the same rule as every other body here: the cup is scaled by
 * the box HEIGHT and then counted across the box WIDTH at the scaled pitch.
 *
 * `ch` is rounded to a whole pixel and `cw` derived from it by the demo's own
 * 22 : 26, which is exactly what `Math.round(22 * b.scale)` computes — so a box
 * that asks for the demo's cup gets the demo's cup, to the pixel.
 *
 * ⚠ `levels` is capped by what the box can hold, not fixed at the demo's 3: at
 * `gridBox`'s 12 px floor three storeys plus two shelves leave a NEGATIVE cup.
 */
function cupLayout(b: BodyBox) {
  const levels = clamp(Math.floor((b.h - 2 + 7) / (MIN_UNIT + 7)), 1, 3);
  const ch = Math.max(MIN_UNIT, Math.round((b.h - 2 - (levels - 1) * 7) / levels));
  const cw = Math.max(MIN_UNIT, Math.round((ch * 22) / 26));
  const cols0 = clamp(Math.round((b.w - cw - 2) / (cw + 3)) + 1, 1, 5);
  return {
    levels, ch, cw, cols0,
    drawnW: (cols0 - 1) * (cw + 3) + cw + 2,
    drawnH: levels * ch + (levels - 1) * 7 + 2,
  };
}

/** The bright face inside the cup's rim — the surface the body paints and the
 *  night layer lights. The demo's inner pair, as a quad, so the glow is the same
 *  shape and not a second guess at it. */
function cupInnerWall(cx: number, y: number, cw: number, ch: number) {
  return [
    { x: cx - cw * 0.42, y: y - ch + 3 }, { x: cx + cw * 0.42, y: y - ch + 3 },
    { x: cx + cw * 0.3, y: y - 2 }, { x: cx - cw * 0.3, y: y - 2 },
  ];
}

/**
 * Industrial at night: the cups themselves.
 *
 * The 3D twin's `cupWallMat` is a `glowTrim` — "the one see-through surface in
 * the world, and its own night light (what glows is the drink inside, not a
 * window cut in it)" — and it glows its OWN colour rather than a shared warm
 * white, so a factory district reads as coloured light and never as offices.
 * Same here: the inner wall quad the body already drew, refilled once.
 *
 * This is the one body that lights inside an industrial district (see
 * `renderBuildingLights`): the glow is the cup's identity, not a lit room.
 */
function cupNightLights(
  gfx: Phaser.GameObjects.Graphics, b: BodyBox, colorIndex: number,
) {
  const L = cupLayout(b);
  const x = b.x + b.w / 2;
  let y = b.gy;
  for (let lv = 0; lv < L.levels; lv++) {
    const n = Math.max(1, L.cols0 - lv);
    gfx.fillStyle(darken(CANDY[(colorIndex + lv) % 6], 0.5), 0.8);
    for (let i = 0; i < n; i++) {
      const cx = x + (i - (n - 1) / 2) * (L.cw + 3);
      gfx.fillPoints(cupInnerWall(cx, y, L.cw, L.ch), true);
    }
    y -= L.ch + 2 + (lv < L.levels - 1 ? 5 : 0);
  }
}

/**
 * School — the letter blocks.
 *
 * Moulded cubes with an embossed letter, laid out as a LOW WIDE row. The risk
 * of collision with the clay house is the highest in the set — both are cubes —
 * so they are kept apart by FEEL, not by outline. The demo's own list:
 *  · one row across, not stacked up (clay stacks courses and a gable)
 *  · square corners and a hard gloss (clay is round-cornered and matte pale)
 *  · every block aligned and equal (clay jitters every voxel)
 *  · the letters
 *
 * A school is therefore allowed to spread WIDER than the box it was handed and
 * to stay short: the low wide row IS the identity, and a tower with letters on
 * it is not a school. A second tier appears only when the box is more than five
 * blocks tall, which keeps a genuine high-rise from looking like a bungalow
 * without ever letting a school become a tower.
 */
function letterBlocks(
  gfx: Phaser.GameObjects.Graphics, b: BodyBox, colorIndex: number, seed: number,
): DrawnBox {
  const L = letterLayout(b, seed);
  const { S, n, tiers, ph, x0 } = L;

  // The plinth. Without it the short blocks sink into the terrain's top row of
  // studs and lose half a letter; with it the row reads as "set down together".
  // It also fills the gaps between blocks from below, which would otherwise be
  // holes punched through the skyline at dusk.
  gfx.fillStyle(darken(ABC_PLINTH, 0.62), 1);
  gfx.fillRect(x0 - 4, b.gy - ph, n * S + 8, ph);
  gfx.fillStyle(ABC_PLINTH, 1);
  gfx.fillRect(x0 - 4, b.gy - ph, n * S + 8, ph * 0.5);

  for (let t = 0; t < tiers; t++) {
    for (let i = 0; i < n; i++) {
      const col = CANDY[(colorIndex + (i + t) * 2) % 6];
      const bx = x0 + i * S;
      const by = b.gy - ph - (t + 1) * S;
      gfx.fillStyle(darken(col, 0.6), 1);
      gfx.fillRect(bx, by, S - 1.5, S);
      gfx.fillStyle(col, 1);
      gfx.fillRect(bx, by, S - 1.5, S * 0.84);
      // Hard gloss, the half of "moulded" that separates this from clay: a
      // white rule along the top edge and a corner catch-light. PURE white at
      // 0.28, the demo's — a catch-light tinted with the block's own colour is
      // a lighter block, not a highlight, and gloss is exactly what this body
      // has that the matte clay house next door does not.
      gfx.fillStyle(lighten(col, 0.6), 1);
      gfx.fillRect(bx, by, S - 1.5, S * 0.1);
      gfx.fillStyle(0xffffff, 0.28);
      gfx.fillTriangle(bx + 2, by + 2, bx + S * 0.44, by + 2, bx + 2, by + S * 0.44);

      const g = letterGlyph(L, seed, i, t, by);
      // Emboss = a dark pass offset down-right under the bright one, ALWAYS.
      // The port skipped it under 18 px; the offset there is `t * 0.55` of a
      // 2.6 px stroke, about 1.4 px, which is exactly the size at which a
      // letter needs the relief most.
      letterStrokes(gfx, g.ch, g.x + g.t * 0.55, g.y + g.t * 0.55, g.w, g.h, g.t, darken(col, 0.4));
      letterStrokes(gfx, g.ch, g.x, g.y, g.w, g.h, g.t, lighten(col, 0.78));
      // A brick is a brick: one stud on top, unconditionally, like the demo.
      stud(gfx, bx + (S - 1.5) / 2, by, S * 0.42, lighten(col, 0.18));
    }
  }
  // The one body that is routinely WIDER and SHORTER than the box it was handed
  // — a school is a low wide row by identity (see the header). This is the
  // report §3.8 is about: without it the fallback glow grid covers a nominal
  // 40 × 84 while the art is ~110 × 40, and 44 px of it hangs in the sky.
  // The studs are counted because on this body they ARE the top edge.
  const top = b.gy - ph - tiers * S - STUD_RISE;
  return { x: x0 - 4, y: top, w: n * S + 8, h: b.gy - top };
}

/**
 * Block size, how many across, how many tiers, and where the row starts.
 *
 * `n` is the demo's own roll, `5 + floor(seeded(seed * 1.7) * 3)`, so the row
 * length varies down a campus the way the demo's does. The block SIZE is what
 * the box decides, and here — uniquely among the five — it comes from the
 * WIDTH, not the height: a school is a LOW WIDE ROW by identity, so its height
 * is an output, not an input. The row therefore runs several times wider than
 * its own footprint, which is exactly what `check2DFootprintSizing` records as
 * the documented school exception (three of the four street footprints share a
 * width once `gridBox` has rounded them up, so they share a row — TWO boxes,
 * not four).
 *
 * `ph` is the demo's `max(6, round(8 * scale))`, written in terms of `S` —
 * identical arithmetic, since the demo's `S` is `round(32 * scale)`.
 */
function letterLayout(b: BodyBox, seed: number) {
  const n = 5 + Math.floor(seeded(seed * 1.7) * 3);
  // Floored at 11 px, and that floor is MEASURED, not tidiness. A letter block
  // is the one body whose whole point is a glyph on its face; under about 11 px
  // the glyph's stroke is `S * 0.12` ≈ 1 px and the emboss offset is half of
  // that. Worse, `tiers` counts in units of `S`, so a small `S` turned an
  // ordinary 17 × 29 footprint into two tiers of seven 5 px blocks — 428 draw
  // commands for ONE building, measured on `phaser-style-probe.mjs`, against
  // 133 for the demo's own school. `MIN_UNIT` is the anti-Infinity floor; this
  // is the anti-mush one. Rounded to a whole pixel, like the demo's
  // `Math.round(32 * b.scale)`.
  const S = clamp(Math.round(b.w * 0.52), 11, 40);
  // ⚠ NOT the demo's. The demo's school is always ONE row, because its props
  // stand beside a synthetic route; a real campus hands this a 300 px box, and
  // a 40 px row at the bottom of it is a hole in the skyline. A second and
  // third tier appear only past five and nine blocks of height — enough that a
  // genuine high-rise does not read as a bungalow, never enough to turn the row
  // into a tower.
  const tiers = b.h > S * 9 ? 3 : (b.h > S * 5 ? 2 : 1);
  return { S, n, tiers, ph: Math.max(6, Math.round(S / 4)), x0: b.x + b.w / 2 - (n * S) / 2 };
}

/** Which letter is on block (i, t) and the box it is drawn in. Shared with the
 *  night rim so the glow traces the letter that is actually there. The `t`
 *  salt is zero on the demo's single row, so tier 0 letters the demo's word. */
function letterGlyph(
  L: ReturnType<typeof letterLayout>, seed: number, i: number, t: number, by: number,
) {
  const { S } = L;
  return {
    ch: LETTER_KEYS[
      Math.floor(seeded(seed + i * 23.3 + t * 61.7) * LETTER_KEYS.length) % LETTER_KEYS.length],
    x: L.x0 + i * S + S * 0.24,
    y: by + S * 0.2,
    w: S * 0.52,
    h: S * 0.5,
    t: Math.max(2.6, S * 0.12),
  };
}

/**
 * School at night: a rim of light round the letters.
 *
 * The 3D twin's `abcRimMat` — "a rim of light around each stroke at night" — is
 * a registered material, so over there every block on every tier lights for one
 * emissive write. Here each stroke is a draw, so this lights the BOTTOM TIER
 * only: that row is the school (the upper tiers exist solely so a campus
 * high-rise is not a bungalow), and it caps the cost at five blocks × ~3
 * segments whatever the box height. Blocks are not sampled — half a row lit
 * reads as broken signage, not as a school with some rooms dark.
 *
 * WIDER than the stroke it lights — and the 2.2× has outlived its birth
 * reason, so know which reason holds now. It was born pre-veil: the day glyph
 * is `lighten(col, 0.78)`, near white, and with the world undimmed an additive
 * pass the same width as the letter landed on a surface already at ceiling and
 * disappeared. Since option D (plan/phaser-2d-lighting.md) the veil dims the
 * glyph to a mid tone first, so a 1× pass WOULD read — but then it would only
 * recolour the stroke. The 2.2× stays because the spill past the stroke onto
 * the darker block face is what makes this a RIM, which is what "a rim of
 * light around each stroke" means over in the 3D file. Judge it in
 * `phaser-style-probe.mjs NIGHT=1` (and `VEIL=0` for the world it was born in).
 */
function letterNightLights(
  gfx: Phaser.GameObjects.Graphics, b: BodyBox, seed: number,
) {
  const L = letterLayout(b, seed);
  const by = b.gy - L.ph - L.S;
  for (let i = 0; i < L.n; i++) {
    const g = letterGlyph(L, seed, i, 0, by);
    letterStrokes(gfx, g.ch, g.x, g.y, g.w, g.h, g.t * 2.2, ABC_RIM_GLOW, 0.4);
  }
}

/**
 * Hospital — the domino wall.
 *
 * Ivory plates stood on edge shoulder to shoulder, with a staggered second row
 * behind: a single row of plates seen side-on is a line, and the building
 * vanishes. The pips ARE the windows, so no square window is ever cut in the
 * white — and the white itself is the separator, because nothing else in this
 * world is white.
 *
 * Plate width follows the wall HEIGHT (a domino is ~3.4× as tall as it is wide)
 * but never at the cost of dropping below three plates: two plates read as a
 * slab with a seam down the middle, and the whole point of the wall is that it
 * is made of pieces. On a very tall box the plates end up narrower than a real
 * domino — the same trade the 3D wall makes, and a much smaller lie than a
 * picket fence.
 */
function dominoWall(
  gfx: Phaser.GameObjects.Graphics, b: BodyBox, _colorIndex: number, seed: number,
): DrawnBox {
  const L = dominoLayout(b, seed);
  const { boardH, dh, n, pitch, dw, x0 } = L;
  const gy = b.gy;
  const x = b.x + b.w / 2;

  // Back row: one slab, offset half a pitch, a shade down. It backs every seam
  // between the front plates, so the volume has no holes in it. The demo's flat
  // 7 px of overshoot at the top, not a fraction of the board.
  gfx.fillStyle(darken(PORCELAIN, 0.66), 1);
  gfx.fillRect(x0 + pitch * 0.5, gy - dh - 7, n * pitch - pitch * 0.5, dh + 7);

  for (let i = 0; i < n; i++) {
    const bx = x0 + i * pitch;
    const by = gy - dh;
    gfx.fillStyle(darken(PORCELAIN, 0.8), 1);
    gfx.fillRect(bx, by, dw, dh);
    gfx.fillStyle(PORCELAIN, 1);
    gfx.fillRect(bx, by, dw - 2, dh - 3);
    // The scored centre line. Without it this is a row of white cards. The
    // demo's flat 2.2 px: at `dh * 0.02` the groove vanished on every plate
    // shorter than the demo's own.
    gfx.fillStyle(PALETTE.ink, 0.85);
    gfx.fillRect(bx + 1.5, by + dh / 2 - 1, dw - 5, 2.2);
    for (const half of [0, 1]) {
      const f = dominoFace(b, L, seed, i, half);
      gfx.fillStyle(PALETTE.ink, 0.9);
      for (const s of f.spots) {
        gfx.fillCircle(f.x + (s[0] / 2) * f.w, f.y + (s[1] / 2) * f.h, f.r);
      }
    }
  }

  // Marker board, sitting ON the wall top — a sign floating above it reads as
  // fake instantly.
  const pw = L.pw;
  const px = x - pw / 2;
  const py = gy - dh - boardH;
  gfx.fillStyle(darken(PORCELAIN, 0.72), 1);
  gfx.fillRect(px, py, pw, boardH);
  gfx.fillStyle(PORCELAIN, 1);
  gfx.fillRect(px + 1.5, py + 1.5, pw - 4, boardH - 4);
  // A TRIANGLE, never a red cross: a red cross on white is a protected emblem
  // under the Geneva Conventions and national law.
  gfx.fillStyle(CROSS_RED, 1);
  gfx.fillTriangle(
    x, py + boardH * 0.14,
    px + pw * 0.86, py + boardH * 0.84,
    px + pw * 0.14, py + boardH * 0.84,
  );
  // The wall spreads well past the box by design (the demo's plate count is the
  // wall's identity, not the footprint's), and the marker board is the top of
  // it — the box's own height is never reached.
  return { x: x0, y: py, w: n * pitch, h: dh + boardH };
}

/**
 * Plate count, pitch and the board on top.
 *
 * `n` is the demo's own `6 + floor(seeded(d * 2.3) * 4)`, so a ward block is
 * six to nine plates long whatever footprint it stands on — a wall of dominoes
 * is a LONG thing, and letting the footprint set the count turns a small
 * hospital into a three-plate slab with a seam down it.
 *
 * Everything else is the demo's prop scaled by the box HEIGHT, at the demo's own
 * ratios against its `dh = 54`: plate `16`, board `28`, board width `34`. All
 * four are rounded to whole pixels, which is what `Math.round(16 * b.scale)` and
 * friends compute — so an 82 px box (the demo's `54 + 28`) reproduces the demo's
 * plate to the pixel.
 */
function dominoLayout(b: BodyBox, seed: number) {
  const n = 6 + Math.floor(seeded(seed * 2.3) * 4);
  const dh = Math.max(MIN_UNIT, Math.round((b.h * 54) / 82));
  const dw = Math.max(MIN_UNIT, Math.round((dh * 16) / 54));
  const boardH = Math.max(MIN_UNIT, Math.round((dh * 28) / 54));
  const pitch = dw + 2.5;              // the demo's gap
  return {
    boardH, dh, n, pitch, dw,
    pw: Math.max(MIN_UNIT, Math.round((dh * 34) / 54)),
    x0: b.x + b.w / 2 - (n * pitch) / 2,
  };
}

/** One half of one plate: where its pips go, how big they are, and which of the
 *  SIX faces it shows. Its own function so the night layer lights the pips the
 *  wall drew rather than a second guess at them.
 *
 *  The demo's field is `(bx + 2, by + 3)`, `dw - 6` wide, `dh/2 - 6` tall. The
 *  3 px margin becomes proportional only once the plate is shorter than the
 *  demo's — two fixed 3 px margins on a 16 px plate leave a NEGATIVE field and
 *  the pips walk off the porcelain. At the demo's `dh = 54` the two agree
 *  exactly. */
function dominoFace(
  b: BodyBox, L: ReturnType<typeof dominoLayout>, seed: number, i: number, half: number,
) {
  const w = Math.max(1, L.dw - 6);
  const m = Math.min(3, L.dh * 0.11);
  const n = 1 + Math.floor(seeded(seed + i * 5.1 + half * 77) * 6);
  return {
    x: L.x0 + i * L.pitch + 2,
    y: b.gy - L.dh + (half === 0 ? m : L.dh / 2 + m),
    w,
    h: L.dh / 2 - 2 * m,
    r: Math.max(1.4, w * 0.15),
    spots: PIP_SPOTS[clamp(n, 1, 6) - 1],
  };
}

/**
 * Hospital at night: the pips, on ONE half of each plate.
 *
 * The 3D twin lights pips and scored groove together through `dominoInkMat`, and
 * the pips ARE the windows there and here — no square window is ever cut in the
 * white. What differs is the half: lighting both halves of every plate is a
 * uniform dot field and the wall stops reading as PIECES, which is the same
 * argument the paper world's pill box makes for lighting alternate compartments
 * ("all of them lit would be one light bar"). Which half is a hash, so a ward
 * block has a scatter of lit and dark faces.
 *
 * Cost is bounded by the plate count (3–7 × at most 4 pips), not by the height.
 */
function dominoNightLights(
  gfx: Phaser.GameObjects.Graphics, b: BodyBox, seed: number,
) {
  const L = dominoLayout(b, seed);
  gfx.fillStyle(DOMINO_PIP_GLOW, 0.8);
  for (let i = 0; i < L.n; i++) {
    const f = dominoFace(b, L, seed, i, seeded(seed + i * 5.1 + 211) < 0.5 ? 0 : 1);
    for (const s of f.spots) {
      // 1.8 × the pip: an additive dot exactly the size of the hole it fills
      // disappears at riding distance, and spill is the only bloom 2D has.
      gfx.fillCircle(f.x + (s[0] / 2) * f.w, f.y + (s[1] / 2) * f.h, f.r * 1.8);
    }
  }
}

// ── The shop sign: a printed sticker ────────────────────────────────────────

/**
 * The five districts' colours — the demo's `ZONE_COLORS`, all five `$plastic`
 * tokens.
 *
 * The demo's note on the choice: the band is laid at 0.6 over a bright green
 * baseplate, so these are the five hues that stay apart after 40 % green is
 * mixed into them — olive-yellow, hot pink, violet, cyan, near-white mint. The
 * sticker's printed panel uses the SAME five, so the band under a shop and the
 * sticker on its wall are the one colour saying "this is the commercial strip".
 */
const ZONE_COLORS: Record<ZoneKind, number> = {
  residential: 0xffb300,   // --pl-amber
  commercial: T_PINK,
  industrial: T_PURPLE,
  school: T_CYAN,
  hospital: CUP_PLATE,     // --pl-paper-hi-ish moulded white
};

/** Sign width ceiling, px — the demo's `SIGN_MAX_W`. The toy world's bodies are
 *  the biggest of the three, so its ceiling is a size up (circuit and paper both
 *  use 46) or the letters stop being readable on a wall this wide. */
const SIGN_MAX_W = 74;

/**
 * The demo's `bodyBox` `lo` / `hi` — the sub-range of the 0.55–0.70 hanging band
 * each body pushes its sign into, so the plate lands on the emptiest part of
 * THAT body.
 *
 * The demo's own two reasons, kept with its numbers: the pull-out tower does not
 * care (0.55–0.70, the spec's full range), while the domino wall's red triangle
 * marker board sits on top and a sign hung high would cover it (0.55–0.62).
 *
 * The demo carries the body's WIDTH and HEIGHT in this table too. Those are not
 * copied: every body here already returns a `DrawnBox`, so the sign is hung on
 * what was actually drawn. That closes the failure mode the demo's own comment
 * warns about —「改了那邊要順手改這裡,不然招牌會掛在空氣上」— by construction
 * rather than by discipline.
 */
const SIGN_BAND: Record<PlasticBody, { lo: number; hi: number }> = {
  tetromino: { lo: 0.55, hi: 0.70 },
  clay: { lo: 0.55, hi: 0.66 },
  stack: { lo: 0.55, hi: 0.70 },
  cup: { lo: 0.55, hi: 0.70 },
  letters: { lo: 0.58, hi: 0.68 },
  domino: { lo: 0.55, hi: 0.62 },
};

/** A plate narrower than this is four smudges — the demo's own legibility floor
 *  (「太小就讀不出字,寧可不掛」), at the toy world's value. */
const SIGN_MIN_W = 22;

/**
 * The carrier is the **printed sticker that came in the toy set** — the demo's
 * `signSticker`.
 *
 * *Not letter bricks*: those are already the school BODY, and one component may
 * only have one identity (法則 3.3). A sticker is flat printed film and an
 * embossed brick is a solid — the two never read as the same thing.
 *
 * Two rotations that must not be confused. The spec's 8° downward tilt is the
 * PLATE's pitch, invisible in an orthographic side view and drawn here as the
 * lit top band (`SIGN_TOPFACE`). The 3–6° this function rolls is the sticker's
 * IN-PLANE skew on the plate, and it is the identifying mark of the carrier:
 * nobody has ever applied a printed sticker straight.
 *
 * Everything else is this file's existing toy vocabulary — flat colour, one step
 * of `darken` and one of `lighten`, a ring of ink round the outside.
 */
function signSticker(
  gfx: Phaser.GameObjects.Graphics,
  body: DrawnBox, kind: PlasticBody, seed: number, zone: ZoneKind,
  posts: readonly number[],
  vocabulary: SignVocabulary,
): void {
  const bodyW = body.w, bodyH = body.h;
  const baseY = body.y + body.h;
  const cx0 = body.x + body.w / 2;
  const band = SIGN_BAND[kind];
  const place = signPlacement(bodyW, bodyH, seed, SIGN_MAX_W, band.lo, band.hi);
  if (!place || place.width < SIGN_MIN_W) return;

  const S = { w: place.width, h: place.height, cy: baseY - place.centerY };
  const bx = cx0 + signShift(cx0, bodyW, S.w, posts);
  const L = bx - S.w / 2, T = S.cy - S.h / 2;

  // The plate: a hard glossy moulded part. Ink frame, then the face, then the
  // upper 0.84 one step brighter. The face is deliberately GREY rather than
  // white — the sticker's die-cut white border only reads if the thing under it
  // is not also white.
  gfx.fillStyle(PALETTE.ink, 1);
  gfx.fillRect(L - 2.5, T - 2.5, S.w + 5, S.h + 5);
  gfx.fillStyle(darken(CUP_PLATE, 0.62), 1);
  gfx.fillRect(L, T, S.w, S.h);
  gfx.fillStyle(darken(CUP_PLATE, 0.84), 1);
  gfx.fillRect(L, T, S.w, S.h * 0.84);
  gfx.fillStyle(CUP_PLATE, 1);
  gfx.fillRect(L, T, S.w, Math.max(1.5, S.h * SIGN_TOPFACE));

  // The sticker: skewed 3–6°, deterministically, either way.
  const a = ((3 + seeded(seed * 5.3 + 1.1) * 3) * Math.PI) / 180
    * (seeded(seed * 2.9) > 0.5 ? 1 : -1);
  const ca = Math.cos(a), sa = Math.sin(a);
  const rot = (dx: number, dy: number): [number, number] => (
    [bx + dx * ca - dy * sa, S.cy + dx * sa + dy * ca]
  );
  const quad = (hw: number, hh: number, col: number, alpha = 1): void => {
    const p0 = rot(-hw, -hh), p1 = rot(hw, -hh), p2 = rot(hw, hh), p3 = rot(-hw, hh);
    gfx.fillStyle(col, alpha);
    gfx.fillTriangle(p0[0], p0[1], p1[0], p1[1], p2[0], p2[1]);
    gfx.fillTriangle(p0[0], p0[1], p2[0], p2[1], p3[0], p3[1]);
  };
  const sw = S.w * 0.94, sh = S.h * 0.94, mg = S.h * 0.075;
  quad(sw / 2, sh / 2, PALETTE.ink, 0.3);            // the film's own thin shadow
  quad(sw / 2 - 0.8, sh / 2 - 0.8, 0xffffff);        // the die-cut white border
  // A ring of ink INSIDE the border before the printed panel: the hospital
  // district's colour is itself near-white, and without this the border and the
  // panel merge and "printed, with a white margin" stops being visible.
  quad(sw / 2 - mg + 1, sh / 2 - mg + 1, PALETTE.ink, 0.55);
  quad(sw / 2 - mg, sh / 2 - mg, ZONE_COLORS[zone]);

  // Type and symbols are PRINTED ON the sticker, so they carry its skew.
  const rp = (x: number, y: number): [number, number] => rot(x - bx, y - S.cy);
  const content = signContent(zone, seed, 'plastic', vocabulary);
  if (content?.symbol === 'triangle') {
    const p = signTriPoints(bx, S.cy, S.h);
    const a0 = rp(p[0], p[1]), a1 = rp(p[2], p[3]), a2 = rp(p[4], p[5]);
    gfx.fillStyle(CROSS_RED, 1);
    gfx.fillTriangle(a0[0], a0[1], a1[0], a1[1], a2[0], a2[1]);
  } else if (content?.text) {
    gfx.fillStyle(PALETTE.ink, 1);
    // The demo lays the text out across the PRINTED PANEL (`sw − 2mg`), not
    // across the plate, so the letters stay inside the white margin.
    // `sign-spec` is plate-local with +y UP (Three's convention); 2D negates y.
    for (const q of signStrokes(sw - mg * 2, S.h, content.text)) {
      const p0 = rp(bx + q.x0, S.cy - q.y0), p1 = rp(bx + q.x1, S.cy - q.y1);
      signStroke(gfx, p0[0], p0[1], p1[0], p1[1], q.width);
    }
  }

  // The lifted corner bubble. Without it this is a printed panel, not a sticker.
  const bh = S.h * 0.26;
  const bp = rot(-sw / 2 + bh * 0.9, sh / 2 - bh * 0.7);
  gfx.fillStyle(0xffffff, 0.55);
  gfx.fillEllipse(bp[0], bp[1], bh * 1.5, bh);
  gfx.fillStyle(0xffffff, 0.9);
  gfx.fillEllipse(bp[0] - bh * 0.22, bp[1] - bh * 0.2, bh * 0.5, bh * 0.32);
}

// ── Pipe-cleaner tree ──

/** The 3D tree's numbers, mirrored (`terrain/plastic-terrain-style.ts`,
 *  `buildCoilTreeGeometry`): ~6 turns, a cone that keeps 16% of its radius at
 *  the tip, and a ribbon whose inner edge sits at 0.78 of the cone. Kept in sync
 *  by hand — a coil that tapers differently in 2D and 3D reads as two species. */
const COIL_TURNS = 6;
const COIL_TAPER = 0.84;
const COIL_INNER = 0.78;

/** The radial wobble that IS the fuzz. Two incommensurate periods: a single one
 *  degenerates into a regular saw edge, which reads as a machined part rather
 *  than a pipe cleaner. Same constants as the 3D geometry so both views fray the
 *  same way. */
function coilFuzz(u: number): number {
  return 0.19 + 0.11 * Math.sin(u * 2.7) + 0.07 * Math.sin(u * 5.3 + 1.1);
}

/**
 * The coil's side-view silhouette as a closed ring of points — left edge bottom
 * to top, right edge back down.
 *
 * 2D is a painted side view, not a projection of the 3D mesh: rasterising a
 * 62-segment helix per tree would cost more than the rest of the streetscape,
 * and a tree is ~40 px tall here, so a single bristle is subpixel. The outline
 * is the only place the fuzz can live. What must survive is a sawtooth cone —
 * one tooth per turn per side, with the two sides half a pitch OUT OF STEP.
 * Aligned teeth read as a fir tree; the offset is the only thing a flat view has
 * that says "one strand wound round" instead of "layers stacked up".
 */
function coilPath(
  gfx: Phaser.GameObjects.Graphics,
  cx: number, baseY: number, r: number, h: number, seed: number, pad: number,
) {
  const K = COIL_TURNS;
  const cone = (t: number) => 1 - COIL_TAPER * t;
  const yAt = (t: number) => baseY + pad - t * (h + pad * 2);
  let first = true;
  const at = (t: number, radius: number) => {
    if (first) { gfx.moveTo(cx + radius, yAt(t)); first = false; } else gfx.lineTo(cx + radius, yAt(t));
  };
  const tooth = (t: number, u: number, side: number) => at(t, side * (r * (cone(t) + coilFuzz(u)) + pad));
  const notch = (t: number, side: number) => at(t, side * (r * cone(t) * COIL_INNER + pad * 0.5));

  gfx.beginPath();
  notch(0, -1);
  for (let k = 0; k < K; k++) {                   // left edge, bottom to top
    tooth((k + 0.5) / K, seed + k * 2 + 1, -1);
    notch((k + 1) / K, -1);
  }
  for (let k = K - 1; k >= 0; k--) {              // right edge, back down, offset
    notch((k + 0.5) / K, 1);
    tooth(k / K, seed + k * 2, 1);
  }
  gfx.closePath();
  gfx.fillPath();
}

/**
 * The demo's three coil greens (`COIL_GREENS`), which are the 3D world's.
 *
 * A shade DEEPER than the baseplate's ramp on purpose: 2D is flat colour with no
 * lighting to separate a tree from the ground it stands on, and fuzzy pipe
 * cleaner takes light worse than moulded plastic anyway. The port had these as
 * `treeCanopyColors` — neon green, cyan and PURPLE — so one tree in four was
 * violet.
 */
const COIL_GREENS: readonly number[] = [0x1a7d35, 0x248f42, 0x2ea34f];
/** The demo's `C.trunk`. */
const COIL_TRUNK = 0xa06a35;

/** The four colours a blown-plastic lamp comes in (the demo's `L.ci` table). */
const LAMP_COLORS: readonly number[] = [T_PINK, T_CYAN, T_YELLOW, T_GREEN];

/** The demo's `C.coin` — a poker chip's gold, one step warmer than the
 *  tetromino yellow the terrain uses. */
const CHIP_GOLD = 0xffd400;
/** …and the demo's `C.metal`, the chip a checkpoint pawn stands on. */
const CHIP_METAL = 0x8a90a0;

/** Sample the terrain surface Y at world X by interpolating the profile points. */
function surfaceYAt(points: { x: number; y: number }[], x: number): number {
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

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

// ── Cyclist constants ──

/**
 * The baked frame, sized to the demo's rig rather than to a round number.
 *
 * The demo's `drawCyclist` spans x −26 … +26 (the two 11 px wheels at ±15) and
 * y −49 (the top of the helmet stud) … +11, i.e. 52 × 60. The old 48 × 48 was
 * drawn for a SMALLER neon rider — `wheelR = 8` against the demo's 11 — and both
 * axes of it cut the demo's rig: the wheels off the sides and the stud off the
 * top. The stud is the one mark that says which world this rider comes from.
 *
 * The demo's size is the right one and not a coincidence: it draws at `PXM = 3`
 * and this game's `PX_PER_METER` is also 3, so its 11 px wheel is a 700 mm
 * wheel in both. Measured with `phaser-style-probe.mjs WHAT=cyclist`, which
 * outlines the frame against what was drawn.
 */
const CYCLIST_W = 56;
const CYCLIST_H = 68;

// ── Coin constants ──

/** Half-extent of the coin texture. THIRTEEN, the demo's `rw = 13` at full
 *  face, so the baked chip is the demo's 26 px across. */
const COIN_SIZE = 13;

/** `0xrrggbb` → the `#rrggbb` a canvas 2D context wants. The chip is drawn into
 *  a texture rather than a `Graphics`, so its colours have to cross that line;
 *  they are still the same numbers as everything else in this file. */
function hexToCss(c: number): string {
  return `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
}

// ── Strategy implementation ──

export function createPlasticStyle(): PhaserStyleStrategy {
  return {
    style: 'plastic',
    palette: {
      ...PALETTE,
      buildingColors: [...PALETTE.buildingColors] as number[],
      treeCanopyColors: [...PALETTE.treeCanopyColors] as number[],
    },

    // ── Terrain ──

    /** Objects stand on top of the drawn block row (top edge of the surface
     *  cell, 1px above the highlight line) — mirrors drawTerrainSurface's
     *  floor() quantisation so the rider never sinks into a block. */
    snapGroundY(y) {
      return Math.floor(y / TILE) * TILE - 1;
    },

    /**
     * The STUDDED BASEPLATE — the demo's `drawTerrain`, in place of the glowing
     * tetromino wall.
     *
     * Its comment names the three things that make a flat side elevation read as
     * a moulded baseplate, and all three are here:「表面一排凸點、磚縫錯開
     * (交丁)、側面比頂面暗一階」— a row of studs on the surface, brick courses
     * with every other course offset half a stud, and the vertical face a step
     * darker than the top one.
     *
     * TWO PASSES, in the demo's order: every column's body first, then every
     * column's detail. One `fillStyle` for the whole body pass is why it is
     * split that way.
     *
     * **One rect per column, never one big polygon** — the demo says why, and it
     * is about the entrance: a polygon pinned to the view bottom has its TOP edge
     * lifted and its bottom edge nailed down, so the intro reads as a wall
     * growing in from the side rather than blocks dropping from above. Columns
     * are `STUD + 0.5` wide to close the seam.
     *
     * ⚠ Columns are anchored to the WORLD (`col * STUD`), not to the view's left
     * edge. The demo starts its loop at `view.left - 80` and computes `col0`
     * only for the intro delay, so its studs slide along the ground as the
     * camera moves — invisible at its speed on a uniform pattern, not survivable
     * on a route where the rider stops. `col0` is the demo's own number; this
     * just uses it for the loop as well.
     *
     * ⚠ Cost is `columns × (4 + 2 × visible courses)`. The courses run from each
     * column's surface to `bottomY`, so this grows with how much GROUND is on
     * screen — deepest at the bottom of a descent with the camera-lift zoom out.
     * That is the demo's own shape, and the measured numbers are in the port
     * report; the tetromino wall it replaces was `columns × 2 × 10` and had the
     * same character.
     *
     * The demo also stamps a zone colour band and an ink post at district
     * boundaries here. Those are NOT here: gameview gets its districts as
     * separate `urban` features, so the band is `renderUrban`'s (which is where
     * the demo's 0.6 alpha now lives).
     */
    drawTerrainSurface(gfx, points, bottomY, _seed, intro) {
      if (points.length < 2) return;

      const col0 = Math.floor(points[0].x / STUD);
      const col1 = Math.ceil(points[points.length - 1].x / STUD);
      const originCol = intro ? Math.floor(intro.originX / STUD) : 0;

      /** Falling offset for a column during the intro (0 once it has landed).
       *  The demo's `dropOffset`: 0.03 s of delay per column from the origin,
       *  a 0.5 s cubic ease over 520 px. The delay is CAPPED, which the demo
       *  does not need — its route starts under the camera, whereas a column
       *  that scrolls into view late here would otherwise still be falling when
       *  the intro window shuts and would snap down in one frame. */
      const dropOffset = (col: number): number => {
        if (!intro) return 0;
        const delay = Math.min(
          Math.max(0, col - originCol) * 0.03,
          INTRO_DURATION_S - DROP_FALL_S - 0.1,
        );
        const k = easeOutCubic((intro.t - delay) / DROP_FALL_S);
        return -(1 - k) * DROP_HEIGHT_PX;
      };

      /** The drawn ground line for a column: the same `floor(y / TILE) * TILE`
       *  the rider stands on (`snapGroundY`). */
      const settledY = (x: number): number => Math.floor(surfaceYAt(points, x) / TILE) * TILE;

      // ── Body: the vertical face, a step darker than the top ──
      gfx.fillStyle(BASE_SIDE, 1);
      for (let col = col0; col <= col1; col++) {
        const x = col * STUD;
        const settled = settledY(x);
        gfx.fillRect(x, settled + dropOffset(col), STUD + 0.5, bottomY - settled);
      }

      // ── Detail: top face, brick courses, one stud ──
      for (let col = col0; col <= col1; col++) {
        const x = col * STUD;
        const settled = settledY(x);
        const off = dropOffset(col);
        const y = settled + off;

        gfx.fillStyle(BASE_GREEN, 1);
        gfx.fillRect(x, y, STUD, 9);

        // Courses. The vertical seam moves half a stud on alternate courses —
        // that stagger (交丁) is what says "laid in bricks" rather than "ruled".
        gfx.fillStyle(darken(BASE_SIDE, 0.72), 0.55);
        const colBottom = bottomY + off;
        for (let r = 0, ry = y + BRICK_H; ry < colBottom; r++, ry += BRICK_H) {
          gfx.fillRect(x, ry, STUD, 1.5);
          gfx.fillRect(x + (r % 2 ? STUD / 2 : 0), ry, 1.5, BRICK_H);
        }

        stud(gfx, x + STUD / 2, y, STUD * 0.62, BASE_GREEN);
      }
    },

    /**
     * NO screen overlay, and NO backdrop — both deleted with the arcade sky.
     *
     * `plan/phaser-plastic-demo.html`'s header lists exactly what it threw away
     * when the toy box replaced neon Tetris:「丟掉的:CRT 掃描線跟霓虹格線 ——
     * 那是霓虹風的殼,配糖果色會變濁」. The demo has no `drawOverlay` and no
     * backdrop layer, and the two it deleted are the two this file had:
     *
     *  · CRT scanlines — a 0.06 black rule every 3 px. Bright candy is what
     *    this world is FOR; combing it with black lines is the muddying the
     *    demo names, and it also cost `h / 3` fills a frame (≈ 240 at 720p)
     *    on the layer that redraws on every resize.
     *  · The neon cyan grid — a screen-fixed tile sprite at 0.09. Its whole job
     *    was to give a DARK sky something to read speed against; the sky is now
     *    a bright gradient and the studded baseplate scrolls under the rider,
     *    so the parallax it was carrying is already on screen.
     *
     * `drawBackdrop` is optional, so it is simply gone. `drawOverlay` is not, so
     * it answers null — the honest "this world draws nothing on the glass".
     */
    drawOverlay() {
      return null;
    },

    updateOverlay: undefined,

    // ── Background features ──

    /**
     * A building, biased by the district it stands in.
     *
     * Five bodies for the five land-use zones (see the "Zone-driven building
     * bodies" section), and the tetromino tower for everything outside them.
     * Unzoned is NOT residential: it is most of a real route.
     *
     * The tower below is the original body — only its snap moved into step
     * with gridBox (§3.12). It is also the expensive one, because its cell
     * count grows with the height and nothing else here does. Measured draw
     * commands per building (seed 0, own-body roll), smallest street box
     * (nominal 15 × 10, drawn 24 × 12) → tallest (nominal 40 × 240):
     *
     *   tetromino  11 → 207      stack   5 →  15      cup     6 →  37
     *   domino     34 →  34      clay   14 →  58      letters 28 → 142
     *
     * Every zone body's cost is capped by its own counts (courses, storeys,
     * plates, blocks), so the tall end still belongs to the tower alone —
     * and the small end got CHEAPER when gridBox stopped rounding every
     * street footprint up to 24 × 48 (a 4 m shed no longer pays for two
     * storeys it does not have).
     */
    renderBuilding(gfx, x, y, w, h, colorIndex, seed, zone, posts = [], vocabulary = 'shop') {
      const kind = bodyKind(seed, zone);
      if (kind !== 'tetromino') {
        const b = gridBox(x, y, w, h);
        const drawn = kind === 'clay' ? clayHouse(gfx, b, colorIndex, seed)
          : kind === 'stack' ? stackTower(gfx, b, colorIndex, seed)
            : kind === 'cup' ? cupTower(gfx, b, colorIndex, seed)
              : kind === 'letters' ? letterBlocks(gfx, b, colorIndex, seed)
                : dominoWall(gfx, b, colorIndex, seed);
        // The sign hangs on the DISTRICT, not on the body type — a clay house
        // borrowed into a commercial block gets one too, or「這一段是商店街」is
        // left to the ground band alone. Residential and industrial get none
        // (`SIGN_ZONES`).
        //
        // NOT unioned into the reported box, and that is the difference between
        // this carrier and circuit's: a sticker is stuck ON the facade and adds
        // no solid mass, whereas the e-paper module hangs off the side on a
        // standoff and genuinely widens the object. `DrawnBox` is documented as
        // the solid mass; a decal is not part of it.
        if (zone && SIGN_ZONES.has(zone)) {
          signSticker(gfx, drawn, kind, seed, zone, posts, vocabulary);
        }
        return drawn;
      }

      const t = towerGrid(x, y, w, h);
      for (let r = 0; r < t.rows; r++) {
        for (let c = 0; c < t.cols; c++) {
          const col = t.baseCol + c;
          const row = t.groundRow - 1 - r;
          // 2×2 clumps share a colour → tetromino-shaped patches up the tower.
          const piece = colorIndex + Math.floor(r / 2) * 3 + Math.floor(c / 2);
          const color = NEON[((piece % 7) + 7) % 7];
          neonCell(gfx, col * TILE, row * TILE, TILE, color, 0.8);

          // Lit window — deterministic per cell.
          if (towerLit(col, row, seed)) {
            gfx.fillStyle(0xffffff, 0.85);
            gfx.fillRect(col * TILE + TILE / 2 - 2, row * TILE + TILE / 2 - 2, 4, 4);
          }
        }
      }
      // The snap is the whole point of reporting an extent from this style: a
      // 15 × 19 footprint is DRAWN 24 × 24, so a glow grid laid over the
      // nominal box would sit a quarter off it (§3.8).
      return {
        x: t.baseCol * TILE,
        y: (t.groundRow - t.rows) * TILE,
        w: t.cols * TILE,
        h: t.rows * TILE,
      };
    },

    /**
     * Which parts of a toy building are lit, per the 3D twin
     * (`terrain/plastic-terrain-style.ts`, `buildBuildingLights` + the three
     * `glowTrim` materials). Nothing here invents a light: every one of these is
     * a mark the body already drew.
     *
     *   clay      the recoloured window voxels (1–2)
     *   stack     the exposed ends of the bars, 34–55 % by district
     *   cup       the cups themselves, each its own colour
     *   letters   a rim round the bottom tier's letters
     *   domino    the pips of one half of each plate
     *   tetromino the same cells the body painted white
     *
     * `zone === 'industrial'` kills the WINDOW routes, exactly as the 3D hook's
     * first line does: a warehouse district with every unit lit reads as
     * housing, and leaving it dark is what makes the zoning legible after dusk.
     * It does not kill the cup, whose glow is a material over there and is the
     * building's identity, not a lit room.
     *
     * Measured additive draw commands per building (probe `prims`), mean over
     * 60 seeds per district, nominal 15 × 19 → 40 × 300. Districts rather than
     * bodies, because the 20 % neighbour bias mixes them:
     *
     *   residential 2.6 → 4.0    commercial 3.0 →  9.9   industrial 2.4 → 9.0
     *   school      9.5 → 9.7    hospital   7.7 →  8.2   unzoned    0.6 → 11.9
     *   ── the generic grid this replaces:  1.0 → 113.0 ──
     *
     * `fillStyle` calls are 1.0–4.0 (hoisted out of the loops). The point is not
     * the 10× at the top end but the SHAPE: the grid was linear in the box
     * height and every one of these is bounded, so a 125 m tower stops being the
     * expensive case on an ADD-blended layer.
     */
    renderBuildingLights(gfx, x, y, w, h, colorIndex, seed, zone) {
      const kind = bodyKind(seed, zone);
      if (kind === 'cup') { cupNightLights(gfx, gridBox(x, y, w, h), colorIndex); return; }
      if (kind === 'letters') { letterNightLights(gfx, gridBox(x, y, w, h), seed); return; }
      if (kind === 'domino') { dominoNightLights(gfx, gridBox(x, y, w, h), seed); return; }

      if (zone === 'industrial') return;
      if (kind === 'clay') { clayNightLights(gfx, gridBox(x, y, w, h), seed); return; }
      if (kind === 'stack') { stackNightLights(gfx, gridBox(x, y, w, h), seed, zone); return; }

      // Tetromino: the tower's own lit cells, glowing. Same grid, same hash —
      // the white pip the day layer painted is what lights up, so the glow can
      // never sit on a dark cell.
      const t = towerGrid(x, y, w, h);
      gfx.fillStyle(WINDOW_GLOW, 0.8);
      for (let r = 0; r < t.rows; r++) {
        for (let c = 0; c < t.cols; c++) {
          const col = t.baseCol + c;
          const row = t.groundRow - 1 - r;
          if (!towerLit(col, row, seed)) continue;
          gfx.fillCircle(col * TILE + TILE / 2, row * TILE + TILE / 2, 4.5);
        }
      }
    },

    /**
     * Tree as a pipe-cleaner coil on a stub trunk — NOT a block stack.
     *
     * It changed for the same reason the 3D world's did (see
     * `buildCoilTreeGeometry`): everything in this world is built by STACKING —
     * the terrain rows, the tetromino towers, and until now the tree — so a
     * stacked tree read as more terrain. Recolouring does not help; the grammar
     * has to change, and a coil is the one construction this world does not
     * otherwise use.
     *
     * Cost: 2 fillPaths + 6 seams + 2 trunk rects = 10 draw ops, which is the
     * demo's own figure (its comment: 10 per tree against the old block tree's
     * 14) — the 2D worlds are CPU-bound on the N100 target, not fill-bound.
     *
     * `size` is ignored, as it always has been: `terrain-builder` passes 0 for
     * every tree. The demo's per-tree scale roll stands in for it.
     */
    renderTree(gfx, x, y, _size, seed) {
      // The demo's `s = 0.75 + seeded(d * 11) * 0.5`.
      const s = 0.75 + seeded(seed * 11) * 0.5;
      const green = COIL_GREENS[Math.abs(Math.round(seed * 3)) % 3];

      // Trunk: only the bottom stub shows. A pipe-cleaner tree is one strand
      // twisted into a stem with a second wound up it, so the stem's upper half
      // is buried in the first turn — the demo's 13 px, not the 20 px the old
      // block tree needed to hold up two cubes of canopy. Ink first, then wood:
      // everything in this world is set in a ring of ink.
      gfx.fillStyle(PALETTE.ink, 1);
      gfx.fillRect(x - 4.5 * s, y - 13 * s, 9 * s, 13 * s);
      gfx.fillStyle(COIL_TRUNK, 1);
      gfx.fillRect(x - 3 * s, y - 13 * s, 6 * s, 13 * s);

      // The silhouette, twice: once inflated by `pad` in ink, once in green.
      // That is the demo's outlining trick and it matters for cost — a
      // `strokePath` on this polygon is 25 separate line segments in the
      // rasteriser, one tree eating a whole street's budget.
      const baseY = y - 11 * s, hc = 45 * s, r = 14.5 * s, seedOff = seed * 0.7;
      gfx.fillStyle(PALETTE.ink, 1);
      coilPath(gfx, x, baseY, r, hc, seedOff, 1.6);
      gfx.fillStyle(green, 1);
      coilPath(gfx, x, baseY, r, hc, seedOff, 0);

      // Seams between turns. Only the front half of each turn is visible, and it
      // runs right→left while climbing half a pitch, so the front face is a set
      // of parallel DIAGONALS. Without them the outline is right but the middle
      // is a flat slab; the tilt is what separates wound from stacked.
      gfx.lineStyle(2.2 * s, darken(green, 0.66), 1);
      for (let k = 0; k < COIL_TURNS; k++) {
        const t0 = k / COIL_TURNS;
        const t1 = (k + 0.5) / COIL_TURNS;
        const r0 = r * (1 - COIL_TAPER * t0) * 0.92;
        const r1 = r * (1 - COIL_TAPER * t1) * 0.92;
        gfx.lineBetween(x + r0, baseY - t0 * hc, x - r1, baseY - t1 * hc);
      }
    },

    renderWater(gfx, x, y, _w, h, _seed) {
      const waterWidth = 60;

      // Glowing pool: dark body + bright surface line
      gfx.fillStyle(darken(PALETTE.waterFill, 0.4), 0.75);
      gfx.fillRect(x - waterWidth / 2, y, waterWidth, h);
      gfx.lineStyle(4, PALETTE.waterOutline, 0.2);
      gfx.lineBetween(x - waterWidth / 2, y, x + waterWidth / 2, y);
      gfx.lineStyle(2, PALETTE.waterOutline, 0.9);
      gfx.lineBetween(x - waterWidth / 2, y, x + waterWidth / 2, y);

      return { x, y, w: waterWidth };
    },

    renderGrass(gfx, x, y, _w, _h, _seed) {
      // A run of glowing studs along the surface rather than a flat band.
      gfx.fillStyle(PALETTE.grassOverlay, 0.5);
      for (let i = -12; i <= 12; i += 6) {
        gfx.fillRect(x + i, y - 3, 3, 3);
      }
      gfx.fillStyle(PALETTE.grassOverlay, 0.15);
      gfx.fillRect(x - 15, y - 2, 30, 4);
    },

    /** Sand: amber studs, dimmer and sparser than grass. */
    renderSand(gfx, x, y, _w, _h, seed) {
      gfx.fillStyle(0xffb300, 0.45); // --pl-amber
      for (let i = -18; i <= 18; i += 8) {
        if (seeded(seed + i) < 0.25) continue;
        gfx.fillRect(x + i, y - 3, 3, 3);
      }
      gfx.fillStyle(0xffb300, 0.12);
      gfx.fillRect(x - 20, y - 2, 40, 4);
    },

    /**
     * The DISTRICT COLOUR BAND — the demo's, stamped on the baseplate's top
     * course.
     *
     * The demo draws this inside `drawTerrain`, one `STUD`-wide cell per column,
     * `ZONE_COLORS[zone]` at **0.6**. That alpha is not a taste call: it is the
     * one number the demo pins to the real game ("唯一對齊現況的是地面貼花的
     * opacity 0.6" — the 3D `landuse-renderer`'s zone decal), so the ground reads
     * the same in both views.
     *
     * Two details from the demo that carry the whole effect:
     *  · the band is **14 px deep from the top face**, and the studs are drawn
     *    from `y − 6` upward, so the colour never touches them. Staining the
     *    studs would eat this world's strongest identifying mark.
     *  · it is laid in `STUD` cells rather than as one long rect, so the district
     *    reads as painted onto the baseplate's own module.
     *
     * Unzoned falls back to the old anonymous shadow row: without a district
     * there is no colour to be, and a grey band is at least honest about it.
     *
     * ⚠ Flat, at the ONE ground sample this hook is handed. The demo re-samples
     * per column because it has the profile; here the band can be up to a brick
     * out where the stepped ground changes level inside the 60 px span. Fixing
     * that means moving ground cover onto a `points` list the way
     * `renderRoadSurface` already is — a separate change.
     */
    renderUrban(gfx, x, y, w, _h, seed, zone) {
      if (!zone) {
        gfx.fillStyle(DEEP_LINE, 0.35);
        for (let i = -30; i <= 30; i += 10) {
          if (seeded(seed + i * 3) < 0.3) continue;
          gfx.fillRect(x + i, y - 2, 6, 3);
        }
        return;
      }
      // `y` is `snapGroundY` — one px above the drawn top face, which is where
      // the terrain's own `fillRect(x, y, STUD, 9)` starts.
      const top = y + 1;
      const col0 = Math.floor((x - w / 2) / STUD);
      const col1 = Math.ceil((x + w / 2) / STUD);
      gfx.fillStyle(ZONE_COLORS[zone], 0.6);
      for (let col = col0; col < col1; col++) {
        gfx.fillRect(col * STUD, top, STUD, 14);
      }
    },

    /** Waterway: same glowing pool as renderWater, narrower. */
    renderWaterway(gfx, x, y, w, h, _seed) {
      gfx.fillStyle(darken(PALETTE.waterFill, 0.4), 0.75);
      gfx.fillRect(x - w / 2, y, w, h);
      gfx.lineStyle(4, PALETTE.waterOutline, 0.2);
      gfx.lineBetween(x - w / 2, y, x + w / 2, y);
      gfx.lineStyle(2, PALETTE.waterOutline, 0.9);
      gfx.lineBetween(x - w / 2, y, x + w / 2, y);
      return { x, y, w };
    },

    /** Aeroway: dark concrete block strip with a glowing centreline. */
    renderAeroway(gfx, x, y, w, kind, _seed) {
      const half = w / 2;
      const stripH = TILE / 2;
      gfx.fillStyle(0x2a2a3e, 0.9);
      gfx.fillRect(x - half, y - stripH, w, stripH);
      gfx.lineStyle(1, T_CYAN, 0.4);
      gfx.strokeRect(x - half, y - stripH, w, stripH);
      // Centreline dashes — runway gets the bold neon treatment
      gfx.fillStyle(T_YELLOW, kind === 'runway' ? 0.9 : 0.5);
      for (let i = -half + 4; i < half - 8; i += 16) {
        gfx.fillRect(x + i, y - stripH / 2 - 1, 8, 2);
      }
    },

    /** Road: a half-tile asphalt band riding the block tops, with neon lane
     *  dashes — paved stretches read against the raw tetromino ground. */
    renderRoadSurface(gfx, points, _seed) {
      const H = TILE / 2;
      // Asphalt band
      gfx.fillStyle(0x11101f, 0.85);
      gfx.beginPath();
      gfx.moveTo(points[0].x, points[0].y);
      for (const p of points) gfx.lineTo(p.x, p.y);
      for (let i = points.length - 1; i >= 0; i--) gfx.lineTo(points[i].x, points[i].y + H);
      gfx.closePath();
      gfx.fillPath();
      // Edge glow
      gfx.lineStyle(1, T_CYAN, 0.35);
      gfx.beginPath();
      gfx.moveTo(points[0].x, points[0].y + 1);
      for (const p of points) gfx.lineTo(p.x, p.y + 1);
      gfx.strokePath();
      // Lane dashes
      gfx.fillStyle(T_YELLOW, 0.8);
      for (let i = 0; i < points.length; i += 6) {
        const p = points[i];
        gfx.fillRect(p.x, p.y + H / 2 - 1, 10, 2);
      }
    },

    /**
     * Blown-plastic street lamp — the demo's, in place of the municipal iron
     * post this file used to draw.
     *
     * Two things carry it and NEITHER is on the bulb: the curled-over tail it
     * stands on, and the fact that the bubble is a MEMBRANE — a thin bright
     * rim, a very faint fill and one curved catch-light, never a filled disc.
     * The colour is one of the demo's four (`L.ci`), so a street of lamps is a
     * street of colours, not a row of identical fittings.
     *
     * Everything below the bubble lives here; the bubble itself and the blob of
     * unblown plastic inside it are in `renderRoadLampGlow`, because at night
     * those are the parts that have to ride ABOVE the world veil (the demo puts
     * them on `glowGfx` at depth 40 for exactly this reason).
     */
    renderRoadLamp(gfx, x, y, seed) {
      const col = LAMP_COLORS[Math.floor(seeded(seed) * 4) % 4];
      // The curled tail. Wider than the tube — this is the whole reason the
      // thing stands up.
      gfx.fillStyle(darken(col, 0.72), 1);
      gfx.fillEllipse(x, y - 5, 32, 11);
      gfx.fillRect(x - 16, y - 12, 32, 3);                 // the pinched fold
      // The flattened section. STRAIGHT and WIDE, with a STEP up to the round
      // tube above it: taper the two into each other and it becomes a vase.
      gfx.fillStyle(col, 1);
      gfx.fillRect(x - 13, y - 30, 26, 20);
      gfx.fillTriangle(x - 13, y - 30, x + 13, y - 30, x + 8, y - 36);
      gfx.fillTriangle(x - 13, y - 30, x + 8, y - 36, x - 8, y - 36);
      gfx.fillRect(x - 8, y - 70, 16, 34);                 // the tube
      gfx.fillStyle(lighten(col, 0.4), 1);                 // only a ROUND tube has this
      gfx.fillRect(x - 6, y - 68, 3.5, 30);
      gfx.fillStyle(col, 1);
      gfx.fillTriangle(x - 8, y - 70, x + 8, y - 70, x + 4, y - 78);   // shoulder
      gfx.fillTriangle(x - 8, y - 70, x + 4, y - 78, x - 4, y - 78);
      gfx.fillRect(x - 4, y - 88, 8, 10);                  // the neck
      gfx.fillStyle(darken(col, 0.7), 1);                  // its thread
      for (let i = 0; i < 3; i++) gfx.fillRect(x - 4.6, y - 86 - i * 3.2, 9.2, 1.6);
    },

    /**
     * The bubble, and the blob of unblown plastic inside it.
     *
     * In the demo this whole group moves to the glow layer at night and is drawn
     * on the prop layer by day, with three values switching: the halo appears,
     * the film fill drops 0.22 → 0.16, and the blob turns from `darken(col,0.8)`
     * to a hot `0xfff6d8`. This hook is ALWAYS the night layer here, so it draws
     * the night form — what glows is the blob, not the whole bubble, because a
     * bubble lit end to end is just a coloured disc.
     */
    renderRoadLampGlow(gfx, x, y, seed) {
      const col = LAMP_COLORS[Math.floor(seeded(seed) * 4) % 4];
      const by = y - 105;
      for (let r = 5; r >= 1; r--) {
        gfx.fillStyle(col, 0.075 * r);
        gfx.fillCircle(x, y - 90, r * 7);
      }
      gfx.fillStyle(col, 0.16);
      gfx.fillCircle(x, by, 17);
      gfx.lineStyle(2.2, lighten(col, 0.45), 0.9);         // the film's bright rim
      gfx.strokeCircle(x, by, 17);
      gfx.fillStyle(0xffffff, 0.55);                       // one curved catch-light
      gfx.fillEllipse(x - 6, by - 7, 9, 5);
      gfx.fillStyle(col, 0.5);                             // the waist blown from the neck
      gfx.fillTriangle(x - 3, y - 88, x + 3, y - 88, x + 8, y - 96);
      gfx.fillTriangle(x - 3, y - 88, x + 8, y - 96, x - 8, y - 96);
      gfx.fillStyle(0xfff6d8, 1);                          // the thing actually alight
      gfx.fillEllipse(x, y - 90, 9, 7);
    },

    // ── Sky / weather ──

    /**
     * A BRIGHT toy-box sky — the demo's, in place of the dark arcade one.
     *
     * The demo has exactly two states (`this.night ? BG_NIGHT_* : BG_DAY_*`)
     * because it has a toggle. The game has a real sun, so the two endpoints are
     * kept verbatim and the sun elevation chooses the mix; the WINDOW is the
     * game's, not the demo's, and it is the twilight band the rest of the 2D
     * scene already uses (+6° … −12°, `updateStars`' own fade window).
     *
     * The old ramp's dusk magenta went with the arcade sky it belonged to.
     * There is no third colour here on purpose: this world is a moulded toy in a
     * lit room, and the demo's own deletion note (「配糖果色會變濁」) is an
     * argument against every muddy intermediate, sunset included.
     */
    getSkyColors(sunElevation, weather) {
      // 0 at full day, 1 at full night. Smoothstepped so dusk does not arrive as
      // a linear wipe across a gradient that is already a gradient.
      const raw = clamp((6 - sunElevation) / 18, 0, 1);
      const n = raw * raw * (3 - 2 * raw);
      let topColor = lerpColor(BG_DAY_TOP, BG_NIGHT_TOP, n);
      let bottomColor = lerpColor(BG_DAY_BOT, BG_NIGHT_BOT, n);

      // Weather brightness
      const wb: Record<string, number> = { sunny: 1.0, cloudy: 0.7, rainy: 0.5, snowy: 0.6 };
      const brightness = wb[weather] ?? 1.0;
      if (brightness < 1.0) {
        topColor = lerpColor(topColor, 0x000000, 1 - brightness);
        bottomColor = lerpColor(bottomColor, 0x000000, 1 - brightness);
      }

      return { top: topColor, bottom: bottomColor };
    },

    /** Cloud as a loose block cluster — a drifting tetromino, basically.
     *  (The caller sets the base fill colour before calling.) */
    drawCloud(gfx, cx, cy, w, h, seed) {
      const unit = Math.max(6, Math.round(w / 5));
      const cells: [number, number][] = [[0, 0], [1, 0], [2, 0], [1, -1], [2, -1], [3, 0]];
      for (const [gx, gy] of cells) {
        if (seeded(seed + gx * 3 + gy * 7) < 0.15) continue; // ragged edge
        gfx.fillRect(cx - w * 0.4 + gx * unit, cy + gy * unit - h * 0.1, unit - 1, unit - 1);
      }
      gfx.fillStyle(0xffffff, 0.18);
      gfx.fillRect(cx - w * 0.4, cy - h * 0.1, unit - 1, 2);
    },

    /**
     * The demo's `drawMountains` — two layers of stepped BRICK mountains.
     *
     * Not a sine ridge quantised afterwards, which is what this used to be: the
     * demo builds the skyline out of columns `L.step` wide whose heights come in
     * GROUPS of four (`grp = floor(x / (step * 4))`), so the horizon is a run of
     * equal-height terraces with square risers between them. Its comment says
     * why the grouping is load-bearing:「一組一組等高 —— 積木山是一階一階疊的,
     * 平滑漸變會讀成山丘不是積木」.
     *
     * Heights land on whole `BRICK_H` courses, so a mountain is the same brick
     * as the ground the rider is on.
     *
     * ⚠ The demo measures its heights against the SCREEN height and this
     * interface hands `skyH` (the horizon line, ~0.75 of it), so the same
     * `maxH` yields terraces about a quarter shorter here. Kept as the demo's
     * literal rather than divided back out: `skyH` is where the horizon IS, and
     * a mountain sized off the full canvas would climb through it.
     */
    generateMountainPoints(baseY, skyH, totalWidth, layer, seed) {
      const L = layer === 'far' ? MOUNTAIN_FAR_LAYER : MOUNTAIN_NEAR_LAYER;
      const points: { x: number; y: number }[] = [];
      // One point per column, `step` apart — `drawMountainSilhouette` reads the
      // step back off the spacing rather than being told twice.
      for (let x = 0; x <= totalWidth + L.step; x += L.step) {
        const grp = Math.floor(x / (L.step * 4));
        // The demo's `seeded(grp * 5.7)`, salted with the caller's session seed
        // so two rides do not get the identical skyline (the demo has a fixed
        // synthetic route and no reason to care).
        const hh = Math.round(
          ((0.3 + seeded(grp * 5.7 + seed) * 0.7) * skyH * L.maxH) / BRICK_H,
        ) * BRICK_H;
        points.push({ x, y: baseY - hh });
      }
      return points;
    },

    /**
     * The columns, their lit top faces, and two studs on each — the demo's
     * inner loop.
     *
     * The demo draws one `fillRect` per column; the body here is ONE stepped
     * `fillPath` instead, which rasterises to the identical shape (its columns
     * are edge to edge and, unlike the terrain's, have no per-column drop
     * offset to keep them apart). That matters because this layer is `w / 0.1`
     * wide — ten screens for the far one — so per-column body rects would be
     * ~280 commands for a shape that is one.
     *
     * The STUDS cannot be folded that way and are not: they are the whole reason
     * the ridge reads as bricks rather than hills (「遠看才知道那是積木不是山」),
     * and each is the demo's own three-fill `stud`. Measured cost is in the
     * report next to `renderBuilding`'s.
     *
     * `color` arrives already darkened by the caller's aerial perspective (far
     * ×0.8, near ×0.95, plus the dusk ramp), so the top face is derived from it
     * rather than being a second literal. The demo's own pairs are
     * `0x86b9a6 → 0x9dcbb8` and `0x4f9d78 → 0x63b48c`; `lighten(c, 0.21)` lands
     * within (2, 3, 1) of the first and (17, 2, 8) of the second, which is
     * closer than either literal would be once the caller has dimmed it.
     */
    drawMountainSilhouette(gfx, points, color, bottomY, _seed) {
      if (points.length < 2) return;
      const step = points[1].x - points[0].x;
      const top = lighten(color, 0.21);
      const last = points[points.length - 1];

      gfx.fillStyle(color, 1);
      gfx.beginPath();
      gfx.moveTo(points[0].x, bottomY);
      for (const p of points) {
        gfx.lineTo(p.x, p.y);
        gfx.lineTo(p.x + step, p.y);
      }
      gfx.lineTo(last.x + step, bottomY);
      gfx.closePath();
      gfx.fillPath();

      // The lit top face: the demo's flat 5 px, as one stepped ribbon.
      gfx.fillStyle(top, 1);
      gfx.beginPath();
      gfx.moveTo(points[0].x, points[0].y);
      for (const p of points) {
        gfx.lineTo(p.x, p.y);
        gfx.lineTo(p.x + step, p.y);
      }
      for (let i = points.length - 1; i >= 0; i--) {
        gfx.lineTo(points[i].x + step, points[i].y + 5);
        gfx.lineTo(points[i].x, points[i].y + 5);
      }
      gfx.closePath();
      gfx.fillPath();

      for (const p of points) {
        for (let s = 0; s < 2; s++) {
          stud(gfx, p.x + step * (0.28 + s * 0.44), p.y + 1, step * 0.3, top);
        }
      }
    },

    drawMoon(gfx, cx, cy, radius, phase, _seed) {
      const brightness = 0.3 + 0.7 * Math.abs(phase - 0.5) * 2;
      gfx.fillStyle(PALETTE.moon, brightness);
      gfx.fillCircle(cx, cy, radius);

      if (phase < 0.45 || phase > 0.55) {
        const shadowOffset = (phase < 0.5 ? 1 : -1) * radius * 0.8;
        // Shadow uses sky-matching color — caller should set appropriate color
        gfx.fillCircle(cx + shadowOffset, cy, radius * 0.9);
      }
    },

    drawStar(gfx, x, y, size, brightness, _seed) {
      gfx.fillStyle(0xffffff, brightness);
      gfx.fillCircle(x, y, size);
    },

    // ── Cyclist ──

    getCyclistFrameSize() {
      return { w: CYCLIST_W, h: CYCLIST_H };
    },

    /**
     * The BRICK BIKE — the demo's `drawCyclist`.
     *
     * Its rig, part for part: two black tyres with a yellow hub and four spokes
     * on a `pedal * 1.6` phase, a frame made of two candy BRICK BARS (a dark
     * body with the top 4.5 px in full colour — the same two-tone every body in
     * this world uses), a cyan head tube, a yellow bar and saddle, a white
     * noodle rider, a purple helmet, and one STUD on top of the helmet.
     *
     * The stud is the joke and the signature: this rider is a minifig, so the
     * one thing on the whole sprite that says which world it belongs to is the
     * knob on its head. It is drawn with the same `stud()` every brick uses.
     *
     * ── What the demo does not have, and how it is carried ──
     *
     * The demo's rider is rigid; it has one pose and no `PoseParams`. Dropping
     * the game's four poses to match would delete a feature to gain fidelity on
     * a sprite nobody can see the difference in at 48 px, so the demo's rig is
     * ARTICULATED at its own joints instead — no new parts, no new colours:
     *
     *   rockAmplitude  sways the rider (not the bike) side to side
     *   hipOffsetY     lifts the hip off the saddle — the demo's `(−2, −17)`
     *   torsoAngle     swings the torso noodle about that hip
     *   headTilt       the demo's helmet, up or down
     *
     * The bike itself never moves, which is what "out of the saddle" looks like.
     *
     * ── Coordinates ──
     *
     * The demo draws in world px about the wheel centreline (`y = 0` at the
     * axles, `x = 0` between them); this bakes into a `CYCLIST_W × CYCLIST_H`
     * canvas frame. `(bx, by)` below is that origin, so every literal in this
     * function is the demo's own number.
     */
    generateCyclistFrame(ctx, ox, frame, _pose, params) {
      const FRAMES = 6;
      const R = 11;                                  // the demo's wheel radius
      const bx = ox + CYCLIST_W / 2;
      const by = CYCLIST_H - 2 - R;                  // axle line
      const pedal = (frame / FRAMES) * Math.PI * 2;
      const rock = params.rockAmplitude * Math.sin(pedal);

      const fill = (c: number, a = 1): void => {
        ctx.globalAlpha = a;
        ctx.fillStyle = hexToCss(c);
      };
      const rect = (x: number, y: number, w: number, h: number): void => {
        ctx.fillRect(bx + x, by + y, w, h);
      };
      const disc = (x: number, y: number, r: number): void => {
        ctx.beginPath();
        ctx.arc(bx + x, by + y, r, 0, Math.PI * 2);
        ctx.fill();
      };
      const line = (x0: number, y0: number, x1: number, y1: number): void => {
        ctx.beginPath();
        ctx.moveTo(bx + x0, by + y0);
        ctx.lineTo(bx + x1, by + y1);
        ctx.stroke();
      };
      const stroke = (w: number, c: number): void => {
        ctx.globalAlpha = 1;
        ctx.lineWidth = w;
        ctx.lineCap = 'butt';
        ctx.strokeStyle = hexToCss(c);
      };

      // ── Wheels: black tyre, yellow hub, four spokes ──
      const a0 = pedal * 1.6;
      for (const wx of [-15, 15]) {
        fill(0x1b1f26); disc(wx, 0, R);
        fill(T_YELLOW); disc(wx, 0, R * 0.42);
        stroke(2, 0x1b1f26);
        for (let i = 0; i < 4; i++) {
          const a = a0 + (i / 4) * Math.PI * 2;
          line(wx, 0, wx + Math.cos(a) * (R - 2), Math.sin(a) * (R - 2));
        }
      }

      // ── Frame: two brick bars, then the tubes ──
      fill(darken(T_PINK, 0.75)); rect(-17, -6, 34, 7);
      fill(T_PINK); rect(-17, -6, 34, 4.5);
      fill(T_PINK); rect(-6, -18, 6, 14);            // seat tube
      fill(T_CYAN); rect(9, -20, 6, 16);             // head tube
      fill(T_YELLOW); rect(6, -24, 14, 5);           // bar
      fill(T_YELLOW); rect(-12, -22, 12, 5);         // saddle

      // ── Rider: white noodles ──
      // Hip and shoulder are the demo's two torso endpoints, moved by the pose.
      const hipX = -2 + rock, hipY = -17 - params.hipOffsetY;
      // The demo's torso runs (−4, −18) → (3, −30): 13.9 px long, leaning 30.2°
      // forward. `torsoAngle` replaces that 30.2 and nothing else, so at the
      // `normal` pose's 35 the rider is within five degrees of the demo's.
      const torsoRad = (params.torsoAngle * Math.PI) / 180;
      const shX = hipX - 2 + Math.sin(torsoRad) * 13.9;
      const shY = hipY - 1 - Math.cos(torsoRad) * 13.9;
      stroke(3.4, 0xffffff);
      line(hipX - 2, hipY - 1, shX, shY);            // torso
      line(hipX, hipY, Math.cos(pedal) * 7, -3 + Math.sin(pedal) * 7);   // near leg
      line(hipX, hipY, -Math.cos(pedal) * 7, -3 - Math.sin(pedal) * 7);  // far leg
      line(shX, shY + 2, 11, -21);                   // arm, out to the bar

      // ── Helmet, and the stud that makes this a minifig ──
      const hx = shX + 3, hy = shY - 5 + params.headTilt;
      fill(T_PURPLE); disc(hx, hy, 6);
      // `stud()` takes a Phaser Graphics; the sprite is baked into a canvas, so
      // its three fills are written out here at the demo's own numbers (barrel
      // 6/7, dome w × 5.5, catch at −0.12w / −6.8 sized 0.5w × 2.4).
      const sw = 7;
      fill(darken(T_PURPLE, 0.82));
      rect(hx - sw / 2, hy - 5 - 6, sw, 7);
      fill(T_PURPLE);
      ctx.beginPath();
      ctx.ellipse(bx + hx, by + hy - 5 - 6, sw / 2, 5.5 / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      fill(lighten(T_PURPLE, 0.45));
      ctx.beginPath();
      ctx.ellipse(bx + hx - sw * 0.12, by + hy - 5 - 6.8, sw * 0.25, 1.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    },

    getCyclistZone5Tint(isDarkened) {
      if (!isDarkened) return null;
      const flash = Math.sin(Date.now() * 0.01) > 0;
      return flash ? 0xff3333 : 0xcc2222;
    },

    // ── Coins ──

    getCoinSize() {
      return COIN_SIZE;
    },

    /**
     * Coin as a POKER CHIP, the demo's — three stacked ellipses: a shadow ring
     * a couple of pixels low, the gold face, and the coloured inlay that is what
     * makes it a chip rather than a coin.
     *
     * ⚠ ONE deviation, and it is forced by the pipeline rather than chosen. The
     * demo redraws its chip every frame and narrows it with
     * `rw = 13 * (0.25 + 0.75 * |cos(t)|)` — the chip is really turning on its
     * edge. Here `drawCoinTexture` bakes ONE canvas that `phaser-coin-layer`
     * reuses for every coin on the route, so there is no per-frame width to
     * modulate: this is the demo's chip at full face (`spin = 1`), and the spin
     * would have to come back as a sprite `scaleX` in the coin layer.
     */
    drawCoinTexture(ctx, cx, cy, size, _seed) {
      // The demo's chip is 26 px tall and 26 wide face-on; `size` is the
      // half-extent the coin layer allocates, so everything scales off it.
      const rx = size, ry = size;
      const ell = (ox: number, oy: number, w: number, h: number, fill: string) => {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.ellipse(cx + ox, cy + oy, w, h, 0, 0, Math.PI * 2);
        ctx.fill();
      };
      // Thickness — the demo's `y + 2` on a 26 px chip.
      ell(0, ry * (2 / 13), rx, ry, hexToCss(darken(CHIP_GOLD, 0.7)));
      ell(0, 0, rx, ry, hexToCss(CHIP_GOLD));
      // The inlay: 1.2/2 across and 15/26 tall of the face, in the world's pink.
      ell(0, 0, rx * 0.6, ry * (15 / 26), hexToCss(T_PINK));
    },

    // ── Markers / flags ──

    getMarkerFont() {
      return 'Consolas, "Courier New", "Noto Sans TC", monospace';
    },

    /**
     * Checkpoint as a BOARD-GAME PAWN standing on a big chip — the demo's, in
     * place of the checkerboard pennant this file used to draw.
     *
     * The silhouette is the turned profile of a pawn and every step in it is
     * load-bearing: wide chip base → waisted cone → collar → neck → round head.
     * The chip's six edge notches are what says "gaming chip" rather than
     * "coaster", and they cost six fills, which is why they are notches and not
     * a milled ring.
     *
     * `label` stays unused: the scene pins a Phaser Text over this, and nothing
     * in this world writes with a system font (法則 3.7).
     */
    drawFlag(gfx, x, y, color, _label, _seed) {
      gfx.fillStyle(CHIP_METAL, 1);
      gfx.fillEllipse(x, y - 4, 46, 13);
      gfx.fillStyle(color, 1);
      for (let i = 0; i < 6; i++) gfx.fillRect(x - 23 + i * 9, y - 8, 5, 8);
      gfx.fillStyle(darken(color, 0.75), 1);
      gfx.fillEllipse(x, y - 10, 34, 12);
      gfx.fillTriangle(x - 17, y - 12, x + 17, y - 12, x + 7, y - 40);
      gfx.fillTriangle(x - 17, y - 12, x + 7, y - 40, x - 7, y - 40);
      gfx.fillStyle(color, 1);
      gfx.fillRect(x - 9, y - 46, 18, 7);
      gfx.fillRect(x - 6, y - 40, 12, 30);
      gfx.fillCircle(x, y - 56, 12);
      gfx.fillStyle(lighten(color, 0.4), 1);
      gfx.fillCircle(x - 4, y - 60, 4);
    },

    /** Finish-line aircraft: a Space-Invaders-style neon flying saucer built
     *  from neonCell() on a coarse ~8px grid — white-hot canopy over a cyan
     *  dome, a candy-striped hull (7-cell accent row over a 9-cell
     *  pink/purple-alternating widest row), a 5-light ping-pong marquee, a
     *  flickering hover exhaust, and a blinking antenna beacon. A dark rounded
     *  board hangs below on two thin neon lines; its centre is returned so the
     *  scene pins the "剩 … km" Text there. Lives in routeLayer, so the route
     *  bloom gives the whole thing its glow for free. */
    drawAircraft(gfx, cx, cy, _seed, animPhase) {
      const CELL = 8;
      /** One neon grid cell centred at hull-relative (col, row). */
      const cell = (col: number, row: number, color: number, alpha: number) => {
        neonCell(gfx, cx + col * CELL - CELL / 2, cy + row * CELL - CELL / 2, CELL, color, alpha);
      };

      // Antenna + blinking beacon above the dome.
      const blink = Math.floor(animPhase * 3) % 2 === 0;
      gfx.lineStyle(1, T_CYAN, 0.7);
      gfx.lineBetween(cx, cy - 2.5 * CELL, cx, cy - 3.4 * CELL);
      gfx.fillStyle(T_YELLOW, blink ? 1 : 0.25);
      gfx.fillCircle(cx, cy - 3.7 * CELL, 3);
      gfx.lineStyle(3, T_YELLOW, blink ? 0.35 : 0.1); // beacon bloom
      gfx.strokeCircle(cx, cy - 3.7 * CELL, 4.5);

      // Canopy → dome → candy-striped disc (7 accent + 9 alternating).
      cell(0, -2, 0xffffff, 0.95);                                          // white-hot canopy
      for (let c = -1; c <= 1; c++) cell(c, -1, T_CYAN, 0.85);              // dome base
      for (let c = -3; c <= 3; c++) cell(c, 0, c === 0 ? T_GREEN : T_PURPLE, 0.95); // accent row
      for (let c = -4; c <= 4; c++) cell(c, 1, (c & 1) ? T_PURPLE : T_PINK, 0.9);   // widest row, candy stripe

      // Under-edge marquee lights (5) — ping-pong chase, not a loop.
      const LIGHTS = 5;
      const span = 2 * LIGHTS - 2;
      const ph = Math.floor(animPhase * 7) % span;
      const lit = ph < LIGHTS ? ph : span - ph;
      for (let i = 0; i < LIGHTS; i++) {
        cell(i - 2, 2, T_YELLOW, i === lit ? 1 : 0.2);
      }

      // Hover exhaust shimmer under the centre.
      const flicker = Math.floor(animPhase * 11) % 2 === 0 ? 0.3 : 0.14;
      cell(0, 3, T_CYAN, flicker);

      // ── Hanging banner board ──
      const saucerBottom = cy + 2.5 * CELL;
      const bannerW = 92;
      const bannerH = 26;
      const bannerTop = saucerBottom + 20;
      const bannerCx = cx;
      const bannerCy = bannerTop + bannerH / 2;

      // Two thin neon suspension lines (clear of the exhaust cell).
      gfx.lineStyle(1.5, T_CYAN, 0.8);
      gfx.lineBetween(cx - 20, saucerBottom, bannerCx - bannerW * 0.28, bannerTop);
      gfx.lineBetween(cx + 20, saucerBottom, bannerCx + bannerW * 0.28, bannerTop);

      // Dark rounded board + neon border with an outer bloom pass (Text is
      // drawn on top by the scene).
      gfx.fillStyle(NIGHT_BG, 0.92);
      gfx.fillRoundedRect(bannerCx - bannerW / 2, bannerTop, bannerW, bannerH, 6);
      gfx.lineStyle(3, T_CYAN, 0.25);
      gfx.strokeRoundedRect(bannerCx - bannerW / 2 - 1, bannerTop - 1, bannerW + 2, bannerH + 2, 7);
      gfx.lineStyle(1, T_CYAN, 0.95);
      gfx.strokeRoundedRect(bannerCx - bannerW / 2, bannerTop, bannerW, bannerH, 6);

      return { bannerCx, bannerCy };
    },

    // ── Wind particles ──

    getWindParticleColor() {
      return 0xffffff;
    },

    getWindParticleAlpha() {
      return 0.5;
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
