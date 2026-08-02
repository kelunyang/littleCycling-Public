/**
 * Circuit style strategy — a powered PCB, seen in cross-section.
 *
 * The 3D world (`terrain/circuit-terrain-style.ts`) is "riding ON a board".
 * The 2D side view gets the thing 3D cannot show: **the board's edge**. So the
 * ground here is not a silhouette with a fill, it is a LAYER STACK — solder
 * mask, four copper layers, the fibreglass between them, and plated through
 * holes punched down the whole thickness. Terrain relief means it is a flex
 * board (FPC); the layers bend with it.
 *
 * Spec: `plan/phaser-circuit-demo.html`. Every number in the "demo px" blocks
 * below is that file's, and PX_PER_METER (3) is the demo's own PXM, so its
 * pixel sizes port across 1:1 with no rescaling. Where gameview needs
 * something the demo has no counterpart for (it has no OSM water, no runway,
 * no coins) the 3D strategy's material for that feature is the source instead,
 * so the two views of one world never speak different vocabularies.
 *
 * Colour source: `styles/themes.scss` `$circuit` (`--ct-*`). Canvas/JS cannot
 * read CSS vars, so these are MIRRORED values — change themes.scss and sync
 * here (CLAUDE.md 主題配色規範). ⚠ `FR4` below is deliberately NOT the
 * themes.scss/3D value: 2D is flat colour and 3D is multiplied by lighting and
 * the toon ramp, so the same board edge needs a darker literal here
 * (CUSTOM_WORLD_INSTRUCTIONS §3.11). The demo settled on both independently.
 *
 * NOT ported, deliberately, and listed so nobody hunts for it:
 *  · 電流脈衝 (the current pulse running inside the route wire) and the
 *    踏頻→速度 / 功率→亮度 mapping. The route is drawn by the scene's
 *    routeLayer, not by a strategy hook. ⚠ **The reason has changed and only
 *    half of it is still true.** Cadence and watts DO reach a 3D strategy now
 *    (`TerrainStyleStrategy.updateRiderSignals`, and `circuit-terrain-style`
 *    runs the demo's pulse + joint sparks off it); what is missing on this side
 *    is a 2D counterpart — `PhaserStyleStrategy` has no per-frame hook at all,
 *    and the route is not the strategy's to draw. So this is a TODO with a
 *    known shape, not a dead end. `phaser2d-scene` giving circuit the route
 *    bloom is as far as this goes today.
 *  · 電子紙 dimming at night (the demo's `epaperLight()` ×0.42). A 2D strategy
 *    only ever draws the DAY layer — the night layer is additive and belongs to
 *    `terrain-builder` (plan/migrate-demo-worlds.md §3.2) — so there is no way
 *    to make something DARKER after dusk from in here. The module is drawn at
 *    its daylight value.
 *  · 色環電阻灌木 (the demo's scatter bushes) and 晶振金屬巨岩. Both are
 *    ground clutter with no hook in either engine (`plan §1`: 樹叢沒有槽).
 */

import type Phaser from 'phaser';
import type { ZoneKind } from '@/game/terrain/land-zone';
import {
  SIGN_TILT_RAD,
  SIGN_ZONES,
  signContent,
  signPlacement,
  signStrokes,
  type SignVocabulary,
} from '@/game/terrain/sign-spec';
import type { DrawnBox, PhaserStyleStrategy } from './phaser-style-strategy';

// ── Palette (mirrors the demo's `C`, and themes.scss $circuit) ──────────────

const MASK = 0x0d4f33;     // --ct-mask     solder-mask green (the board face)
const MASK_HI = 0x17734c;  // --ct-mask-hi
const MASK_LO = 0x073b26;  // --ct-mask-lo
const FR4 = 0xa98a52;      // 2D-only value — see the §3.11 note in the header
const FR4_DK = 0x7d6438;
const COPPER = 0xb87333;   // --ct-copper
const GOLD = 0xc9a227;     // --ct-gold     ENIG plating
const GOLD_HI = 0xefd77a;  // --ct-gold-hi
const SILK = 0xe4ece2;     // --ct-silk     silkscreen white
const TRACE = 0x23f0ff;    // --ct-trace    powered-trace cyan
const HOT = 0xff2d9b;      // --ct-hot
const IC = 0x16181c;       // black plastic package
const IC_HI = 0x2a2e36;
const TIN = 0xc2c8d2;      // tinned leads
const SOLDER = 0xaeb6c2;   // molten solder
const ALU = 0x9aa4ad;      // the aluminium of a can
const FOAM = 0xe88bb4;     // anti-static foam pink (this world's cloud)
const CERM = 0xe9e5d8;     // white ceramic package
const CERM_DK = 0xbdb6a4;
const NEON = 0xff7a1e;     // nixie / filament warm orange
const NEON_HI = 0xffd9a0;
const GLASS = 0xa8e8f0;
const INK = 0x071a14;      // --ct-ink

/** Under the board's own thickness. Not "more ground" — a board has a BOTTOM,
 *  and the dark below it is what makes 74 px read as one piece of board. */
const DEEP = 0x08201a;

// `phaser-circuit-demo.html` 的 BG_DAY_TOP/BOT 與 BG_NIGHT_TOP/BOT,原封搬過來。
//
// ⚠ `BG_DAY_BOT` 跟 3D 的 `skyPalette.day.skyBottom` **從此不同**(3D 是
// `0xcfe0e4`),而那是刻意的,不是誰漏改。3D 的天空是掛在穹頂上的:漸層是仰角的
// 函式,而騎乘視角只看得到山谷到畫面頂那條窄帶,所以下緣那個近乎白的 `0xdfe8e2`
// 會把整片可見天空洗成灰的 —— 3D 那邊為此把下緣抬成帶藍的 `0xcfe0e4`。
// 2D 沒有這個問題:它的天空是螢幕空間的上下漸層(見 getSkyColors),整條漸層本來
// 就全部看得到,`0xdfe8e2` 在那裡就是地平線該有的淡色。兩邊各自對自己的 demo。
const BG_DAY_TOP = 0x9fc6d4, BG_DAY_BOT = 0xdfe8e2;
const BG_NIGHT_TOP = 0x050d14, BG_NIGHT_BOT = 0x0a2028;

// ── Board layer stack, demo px (PX_PER_METER === the demo's PXM === 3) ──────

const MASK_T = 10;                        // solder-mask thickness
const COPPER_LAYERS = [10, 28, 48, 68];   // depth of each of the four copper layers
const BOARD_T = 74;                       // total board thickness
const WEAVE_PITCH = 14;                   // fibreglass weave lines

/** Surface signal bus: three parallel traces that change layer TOGETHER, and
 *  only on the grid — every `BUS_PITCH`, sloping over `BUS_RUN`. The pitch is
 *  what makes it read as routing rather than doodling. It sits in the lower
 *  two-thirds of the mask because the top few px belong to the zone colour
 *  band; a trace run all the way to the surface paints one cyan streak over
 *  every district colour there is. (Demo, verbatim.) */
const BUS_N = 3, BUS_SP = 2.8, BUS_BASE = 5.4, BUS_STEP = 2.0;
const BUS_PITCH = 192, BUS_RUN = 8;
/** Sampling step for the bus. The layer-change corners land ON a sample only
 *  because everything that walks the bus uses this same step. */
const BUS_SS = 8;
/** Pad rows — the footprint of a ribbon connector, on the bus's own grid. */
const PAD_PITCH = BUS_PITCH * 2;

/** Plated through holes, in groups of three. Scattered vias look undesigned,
 *  and this board is designed. */
const VIA_GROUP = 288, VIA_PITCH = 26, VIA_W = 7;
/** Silkscreen ruler: a tick every 96 px, every fourth one long. */
const SILK_PITCH = 96;

/** The power-on sweep: px/s of the lit front, and how long the ramp behind it
 *  is. This world's entrance animation is not blocks dropping or ink drawing —
 *  it is the board coming up. (Demo `live()`.) */
const BOOT_SPEED = 2600;
const BOOT_RAMP = 220;

// ── Heat-sink fins: the far ring (demo `drawFins`) ──────────────────────────
//
// PURE COPPER, not aluminium: copper's warm brown is the complement of the
// green board, which is the only reason the far ring separates from it at all.
// The crystal cans on the ground stay aluminium — that contrast is the point.
//
// §3.6 (遠圈的張角必須比近圈大) holds here: far maxH 0.34 > near 0.23, so the
// back comb is never hidden behind the front one.
const FIN_FAR = { w: 26, gap: 13, maxH: 0.34 };
const FIN_NEAR = { w: 18, gap: 9, maxH: 0.23 };

// ── Helpers ────────────────────────────────────────────────────────────────

function darken(color: number, f: number): number {
  const r = Math.round(((color >> 16) & 0xff) * f);
  const g = Math.round(((color >> 8) & 0xff) * f);
  const b = Math.round((color & 0xff) * f);
  return (r << 16) | (g << 8) | b;
}

function lerpColor(c1: number, c2: number, t: number): number {
  const r = Math.round(((c1 >> 16) & 0xff) + (((c2 >> 16) & 0xff) - ((c1 >> 16) & 0xff)) * t);
  const g = Math.round(((c1 >> 8) & 0xff) + (((c2 >> 8) & 0xff) - ((c1 >> 8) & 0xff)) * t);
  const b = Math.round((c1 & 0xff) + ((c2 & 0xff) - (c1 & 0xff)) * t);
  return (r << 16) | (g << 8) | b;
}

/** The demo's `seeded()` — a plain hash, NOT a stream. Nothing in this file may
 *  consume from a shared RNG: adding one decoration that did would re-roll
 *  every prop generated after it (CUSTOM_WORLD_INSTRUCTIONS §5). */
function seeded(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Which layer the bus is on at x, including the diagonal it changes on. */
function busLevel(k: number): number {
  return seeded(k * 29.3 + 3.1) < 0.5 ? 0 : 1;
}
function busOffset(x: number): number {
  const k = Math.floor(x / BUS_PITCH);
  const t = clamp((x - ((k + 1) * BUS_PITCH - BUS_RUN)) / BUS_RUN, 0, 1);
  const l0 = busLevel(k), l1 = busLevel(k + 1);
  return BUS_BASE + (l0 + (l1 - l0) * t) * BUS_STEP;
}

// ── §3.10: ONE implementation of an LED ────────────────────────────────────
//
// The street lamp and the indicator on top of the ceramic DIP are the same
// part. They used to be two pieces of code, and the moment one was fixed they
// stopped matching — which is exactly the failure CUSTOM_WORLD_INSTRUCTIONS
// §3.10 ends on, and why the 3D side has a single `ledBody()`. These two
// functions are that single implementation for 2D; the lamp and the indicator
// differ only in radius and colour.
//
// Why the shell is never filled solid: when the glowing area equals the
// object's area the eye gets no cue that there is a source INSIDE anything, and
// it reads as a coloured blob. A real LED is a small bright point wrapped in
// something you can see through — small, inside, and the shell stays
// translucent. The last one is the counter-intuitive part: at night the shell
// must NOT get more opaque, or it hides its own die.

/** The lamp body: flange, epoxy shell, the asymmetric lead frame you can see
 *  through it, and the die — the only part that actually lights. */
function drawLedBody(
  gfx: Phaser.GameObjects.Graphics,
  cx: number, cy: number, r: number, col: number, on: number,
): void {
  const bodyH = r * 2.2;
  gfx.fillStyle(darken(col, 0.45), 0.55);
  gfx.fillRect(cx - r * 1.22, cy + bodyH - r * 0.5, r * 2.44, r * 0.5);
  gfx.fillStyle(col, 0.24);
  gfx.fillRoundedRect(cx - r, cy - r * 0.4, r * 2, bodyH, r * 0.34);
  gfx.fillCircle(cx, cy - r * 0.4, r);
  // Lead frame — tall on the left (it carries the cup), short on the right.
  // That asymmetric silhouette through the shell is the strongest single mark
  // that says "LED".
  gfx.fillStyle(TIN, 0.8);
  gfx.fillRect(cx - r * 0.46, cy + r * 0.1, r * 0.3, bodyH * 0.6);
  gfx.fillRect(cx + r * 0.28, cy + r * 0.55, r * 0.28, bodyH * 0.42);
  gfx.fillRect(cx - r * 0.62, cy + r * 0.02, r * 0.62, r * 0.26);
  gfx.fillStyle(on > 0 ? 0xfff0ee : darken(col, 0.5), 1);
  gfx.fillCircle(cx - r * 0.31, cy - r * 0.12, r * 0.3);
  gfx.lineStyle(1.5, 0xffffff, 0.28 + 0.22 * on);
  gfx.strokeCircle(cx, cy - r * 0.4, r);
  gfx.fillStyle(0xffffff, 0.3);
  gfx.fillCircle(cx - r * 0.34, cy - r * 0.78, r * 0.24);
}

/** The spill and the burnt-white die, for the ADDITIVE night layer. It does
 *  NOT redraw the shell: filling the shell bright at night is precisely how it
 *  becomes a solid blob again. */
function drawLedGlow(
  gfx: Phaser.GameObjects.Graphics,
  cx: number, cy: number, r: number, col: number, on: number,
): void {
  if (on <= 0) return;
  for (let i = 5; i >= 1; i--) {
    gfx.fillStyle(col, 0.085 * i * on);
    gfx.fillCircle(cx - r * 0.31, cy - r * 0.12, r * i * 0.85);
  }
  gfx.fillStyle(0xfff4f2, 0.95 * on);
  gfx.fillCircle(cx - r * 0.31, cy - r * 0.12, r * 0.32);
}

// ── Zone-driven component bodies ───────────────────────────────────────────
//
// Five districts, five packages, plus the vacuum tube as the landmark. The
// silhouettes are pulled apart on purpose because a side view has nothing but
// outline to work with: the capacitor is one tall thin can, the nixie three
// tubes side by side, the transformer squat with a copper waist, the DIP long
// and low on a row of legs, the tube very tall.
//
// Copyright: generic package outlines only (JEDEC DIP, TO can, E-I transformer,
// octal tube, nixie), no maker's marks, part numbers or logos.

/**
 * Zone → solder mask. **This is how this world signals zoning at all.**
 *
 * The other two 2D worlds put their districts on the buildings and on a ground
 * band; here the board itself changes colour, which is the thing a rider reads
 * from a screen away — the demo's own note is 遠看一條線就知道現在騎在哪一區.
 *
 * `c` / `a` tint the mask layer, `hi` is the lit surface edge on top of it.
 * Verbatim from `plan/phaser-circuit-demo.html`'s `ZONE_MASK`, alpha included.
 *
 * ⚠ These are NOT `circuit-terrain-style.ts`'s `ZONE_MASK_3D`, and the difference
 * is in the demos, not in the port: the 3D demo picked 綠/藍/黃/紅/白 and the 2D
 * one 綠/藍/紅/黑/白, so industrial and school swap families between the views.
 * Reconciling them is a DEMO change (both would have to move together) and is
 * deliberately not made here — see the report.
 */
const ZONE_MASK: Record<ZoneKind, { c: number; hi: number; a: number }> = {
  residential: { c: 0x1aa564, hi: 0x63f2ae, a: 0.78 },  // 綠阻焊
  commercial: { c: 0x2f6fd0, hi: 0x8cc0ff, a: 0.82 },   // 藍阻焊
  industrial: { c: 0xbe3226, hi: 0xff9077, a: 0.82 },   // 紅阻焊
  school: { c: 0x14171d, hi: 0x79828f, a: 0.86 },       // 黑阻焊
  hospital: { c: 0xe8eeec, hi: 0xffffff, a: 0.88 },     // 白阻焊
};

type CircuitPart = 'cap' | 'nixie' | 'xformer' | 'dip' | 'ceramic' | 'tube';

const ZONE_PART: Record<ZoneKind, CircuitPart> = {
  residential: 'cap',       // electrolytic capacitor
  commercial: 'nixie',      // nixie-tube sign
  industrial: 'xformer',    // laminated transformer + copper winding
  school: 'dip',            // black-plastic DIP
  hospital: 'ceramic',      // white-ceramic DIP + red LED
};

/** 20 % of footprints borrow a neighbouring district's package — a real city
 *  is mixed at its district edges. Same table and same 80/20 split as the 3D
 *  `circuitKind`, so one building is the same component in both views. */
const ZONE_NEIGHBOURS: Record<ZoneKind, readonly [ZoneKind, ZoneKind]> = {
  residential: ['commercial', 'school'],
  commercial: ['residential', 'industrial'],
  industrial: ['commercial', 'residential'],
  school: ['residential', 'hospital'],
  hospital: ['residential', 'school'],
};

/**
 * Height above which a footprint becomes the vacuum tube, whatever district it
 * stands in. It is this world's landmark, and a landmark is defined by standing
 * a good way above its neighbours.
 *
 * **This must equal `LANDMARK_H` in `terrain/circuit-terrain-style.ts`.** The
 * same building has to be the same component in both views, or switching
 * between 2D and 3D shows two different cities.
 *
 * It is expressed in metres and converted through the 2D pipeline's own scaling
 * (`terrain-builder`: heightPx = heightM × PX_PER_METER × 0.8) rather than
 * copied from the demo's `TALL_AT`: that thresholds a synthetic per-prop
 * `scale` which has no counterpart here. What the demo's threshold actually
 * buys is a PROPORTION — about one site in nine — and 20 m was measured to
 * give 62 of chunk2's 795 footprints (7.8 %) on the real Dazhi route
 * (`render-probe CENSUS=1`), which lands in that band.
 */
const LANDMARK_M = 20;
const LANDMARK_PX = LANDMARK_M * 3 * 0.8;

function partKind(seed: number, zone: ZoneKind | null, heightPx: number): CircuitPart {
  if (heightPx >= LANDMARK_PX) return 'tube';
  if (!zone) return 'cap';   // unzoned is NOT residential; it is just the commonest can
  const roll = seeded(seed * 23 + 3);
  const src = roll < 0.8 ? zone : ZONE_NEIGHBOURS[zone][roll < 0.9 ? 0 : 1];
  return ZONE_PART[src];
}

/**
 * Natural size of each package at scale 1 (demo px), plus the three limits that
 * fit it to a box.
 *
 * The demo's parts are fixed props spaced 62–140 px apart beside a synthetic
 * route. Here every body stands in a box the map hands it — 15–40 px wide by
 * `terrain-builder`'s clamp, 24 px to ~300 px tall — and its neighbours are
 * wherever OSM put them. The rule, same as the toy world's five bodies:
 * **height leads, and the aspect ratio is never touched, because the aspect IS
 * the component.** A capacitor stretched to fill a 40 px box stops being a
 * capacitor.
 *
 *   hi    the biggest it may ever get. Two of the six are FLAT BY IDENTITY —
 *         a 300 px DIP is not a DIP, it is a wall — so theirs is low and they
 *         spread sideways instead. Same trade the toy world's letter blocks
 *         and domino wall make.
 *   lo    the legibility floor… itself bounded by `OVER_H` below, or the floor
 *         would draw a 4 m shed as a 30 px can (which is what it did).
 *   wide  how far past the box's WIDTH it may spread. This is the guard the
 *         flat packages need and the landmark must not have: a vacuum tube
 *         allowed to spread stops being tall, and tall is the whole job.
 *   over  what stands ABOVE `h` at scale 1 and is not part of the layout: the
 *         glass domes (drawn as an ellipse ABOUT the shoulder, so half of it
 *         is overshoot) and the ceramic DIP's indicator LED on its posts.
 *         Only `partExtent` reads it, but it has to exist — 20 px of LED is
 *         well past the "tolerate a couple of px" the `DrawnBox` contract
 *         allows, and under-reporting is the exact failure that contract was
 *         written for.
 */
const PART_SIZE: Record<
  CircuitPart, { w: number; h: number; lo: number; hi: number; wide: number; over: number }
> = {
  cap:     { w: 26, h: 72,  lo: 0.30, hi: 3.2, wide: 1.5, over: 0 },
  nixie:   { w: 72, h: 60,  lo: 0.40, hi: 2.4, wide: 1.7, over: 6.2 },   // dome
  xformer: { w: 74, h: 47,  lo: 0.40, hi: 1.6, wide: 1.7, over: 0 },     // squat by identity
  dip:     { w: 62, h: 31,  lo: 0.45, hi: 1.5, wide: 1.7, over: 0 },     // flat by identity
  ceramic: { w: 62, h: 31,  lo: 0.45, hi: 1.5, wide: 1.7, over: 19.7 },  // + LED on posts
  tube:    { w: 40, h: 127, lo: 0.60, hi: 3.0, wide: 1.5, over: 13.2 },  // dome
};

// ⚠ `hi` is a safety ceiling, not the binding limit for five of the six: a
// footprint tall enough to reach it has already become the tube (`LANDMARK_PX`
// is 48 px, and only the tube's own natural height is above that). What binds
// in practice is `wide`, then the OVER_H-bounded floor.

/** How much taller than the box a package may stand. The legibility floor is
 *  capped by this, so a tiny footprint gets a tiny component instead of the
 *  minimum-legible one — otherwise every box under ~30 px came out the SAME
 *  size and a street of sheds read as a street of identical cans. */
const OVER_H = 1.35;

/** Per-footprint knobs. `tint` is the capacitor sleeve colour and rides
 *  `colorIndex` so `palette.buildingColors` stays a live modulo; `flip` is the
 *  side the printed stripe (and the sign post) sits on. */
interface PartVars {
  kind: CircuitPart;
  s: number;
  tint: number;
  flip: 1 | -1;
  seed: number;
}

function partVars(
  seed: number, zone: ZoneKind | null, w: number, h: number, colorIndex: number,
): PartVars {
  const kind = partKind(seed, zone, h);
  const N = PART_SIZE[kind];
  // Height leads; the floor is bounded by OVER_H; the width guard wins last,
  // because spreading over a neighbour is the failure you actually see.
  let s = Math.min(h / N.h, N.hi);
  s = Math.max(s, Math.min(N.lo, (h * OVER_H) / N.h));
  s = Math.min(s, (w * N.wide) / N.w);
  return {
    kind,
    s,
    tint: colorIndex % 3,
    flip: seeded(seed * 7 + 1.3) > 0.5 ? -1 : 1,
    seed,
  };
}

/** The body's own extent, dome / indicator included. */
function partExtent(cx: number, baseY: number, v: PartVars): DrawnBox {
  const N = PART_SIZE[v.kind];
  const w = N.w * v.s, h = (N.h + N.over) * v.s;
  return { x: cx - w / 2, y: baseY - h, w, h };
}

/** Grow a box to cover another. `DrawnBox` is "the box this call actually
 *  filled", and on a signed building the module is part of what it filled —
 *  reporting only the package would under-report by a third of the width. */
function union(a: DrawnBox, b: DrawnBox): DrawnBox {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return {
    x, y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

// ── Package drawing (ported from the demo, verbatim geometry) ───────────────
//
// ONE systematic deviation, and it is deliberate: every fixed-pixel constant
// the demo leaves unscaled (the 6 px lift under a capacitor, the 8 px legs, the
// 2.2 px socket highlight) is multiplied by `s` here. The demo can leave them
// alone because its own `scale` is 0.9–1.32 — at those sizes a fixed 6 px lift
// is invisible either way. `partVars` hands out 0.30–3.2, and at the bottom of
// that range the demo's own numbers break: its four polarity marks are pitched
// 12 px apart starting 10 px down, so on a 0.65-scale can (43 px of body) the
// fourth one lands 6 px BELOW the body it is printed on.
//
// The consequence for verification: at s === 1 these functions must emit a
// draw-command stream IDENTICAL to the demo's, command for command. Four of
// the six can be driven to s === 1 through `renderBuilding` and are checked
// that way; `cap` and `nixie` cannot, because their natural height (72 / 60 px)
// is already past `LANDMARK_PX` and the footprint would become a tube.

function legPin(
  gfx: Phaser.GameObjects.Graphics,
  x: number, y: number, h: number, w = 2, col = TIN,
): void {
  gfx.fillStyle(col, 1);
  gfx.fillRect(x - w / 2, y, w, h);
}

/** Seven-segment digits for the nixie cathodes, bits a=1…g=64.
 *  A real nixie's cathodes are shaped wire, not segments, but at riding
 *  distance the segment combination reads the same — and `fillText` blurs and
 *  differs per machine (§3.7 no system fonts). */
const SEG7 = [63, 6, 91, 79, 102, 109, 125, 7, 127, 111];

function segDigit(
  gfx: Phaser.GameObjects.Graphics,
  cx: number, cy: number, w: number, h: number,
  digit: number, col: number, alpha: number, t: number,
): void {
  const m = SEG7[((digit % 10) + 10) % 10];
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, ym = cy, y1 = cy + h / 2;
  gfx.fillStyle(col, alpha);
  const hbar = (yy: number): void => { gfx.fillRect(x0, yy - t / 2, w, t); };
  const vbar = (xx: number, yy: number): void => { gfx.fillRect(xx - t / 2, yy, t, h / 2); };
  if (m & 1) hbar(y0);
  if (m & 2) vbar(x1, y0);
  if (m & 4) vbar(x1, ym);
  if (m & 8) hbar(y1);
  if (m & 16) vbar(x0, ym);
  if (m & 32) vbar(x0, y0);
  if (m & 64) hbar(ym);
}

/** Residential — electrolytic capacitor. Three sleeve colours; the printed
 *  polarity stripe with its minus marks is on the `flip` side. */
const CAP_SLEEVES = [0x1b3a6b, 0x0e0f12, 0x5a1b1b];

function drawCap(gfx: Phaser.GameObjects.Graphics, x: number, y: number, v: PartVars): void {
  const s = v.s, w = 26 * s, h = 66 * s;
  // The pin WIDTH scales too. It is `legPin`'s default 2 in the demo and every
  // other package here passes an explicit `n * s`; leaving this one literal
  // made a 3.2-scale can stand on two threads, and it was the only command in
  // the whole file that did not normalise back to the demo at scale 1.
  legPin(gfx, x - w * 0.22, y - 6 * s, 8 * s, 2 * s);
  legPin(gfx, x + w * 0.22, y - 6 * s, 8 * s, 2 * s);
  const body = CAP_SLEEVES[v.tint];
  const top = y - 6 * s - h;
  gfx.fillStyle(body, 1);
  gfx.fillRoundedRect(x - w / 2, top, w, h, 4 * s);
  gfx.fillStyle(0xeef2f6, 1);
  gfx.fillRect(x + w * 0.5 * v.flip - (v.flip > 0 ? 7 * s : 0), top + 3 * s, 7 * s, h - 6 * s);
  gfx.fillStyle(darken(body, 0.5), 1);
  // **四道**負極記號 — demo 的固定 4。曾經是 round(h / (12 * s)),但 h 本來
  // 就是 66 * s,那個式子恆等於 5.5 → 6:多兩道,而且第 6 道落在 top + 70 * s,
  // 已經在罐子(top + 66 * s)外面,變成一小塊浮在電容底下的髒點。
  for (let i = 0; i < 4; i++) {
    gfx.fillRect(x + w * 0.5 * v.flip - (v.flip > 0 ? 6 * s : -s), top + (10 + i * 12) * s, 5 * s, 3 * s);
  }
  // Crimped aluminium top with its score line — this is where the 3D world's
  // ring light sits, and it is the only part of a capacitor that ever glows.
  gfx.fillStyle(ALU, 1);
  gfx.fillRect(x - w / 2, top, w, 5 * s);
  gfx.lineStyle(2, darken(ALU, 0.55), 1);
  gfx.lineBetween(x - w * 0.3, top + 2.5 * s, x + w * 0.3, top + 2.5 * s);
}

/** Where the ceramic DIP's indicator LED sits — shared by the body and its
 *  night light so the two can never drift apart. */
function ceramicLed(x: number, y: number, v: PartVars) {
  const s = v.s, w = 62 * s, h = 24 * s;
  return { top: y - 7 * s - h, cx: x + w * 0.30, cy: y - 7 * s - h - 13 * s, r: 4.8 * s };
}

/**
 * School — black-plastic DIP. Hospital — white-ceramic DIP with a gold lid, a
 * red triangle and an indicator LED.
 *
 * One outline, two grades of the same package: the districts are told apart by
 * MATERIAL and FITTINGS, not by shape, because that is what actually
 * distinguishes a commercial part from a hermetic one.
 *
 * The hospital mark is a red TRIANGLE, never a red cross — the white-ground red
 * cross is protected by the Geneva Conventions. The triangle is also the diode
 * symbol, which is this world's own good luck.
 */
function drawDip(
  gfx: Phaser.GameObjects.Graphics, x: number, y: number, v: PartVars, ceramic: boolean,
): void {
  const s = v.s, w = 62 * s, h = 24 * s, top = y - 7 * s - h;
  const n = Math.max(4, Math.round(w / (12 * s)));
  for (let i = 0; i < n; i++) {
    legPin(gfx, x - w / 2 + (i + 0.5) * (w / n), y - 7 * s, 9 * s, 3 * s, ceramic ? GOLD : TIN);
  }
  if (!ceramic) {
    gfx.fillStyle(IC, 1);
    gfx.fillRoundedRect(x - w / 2, top, w, h, 2 * s);
    gfx.fillStyle(IC_HI, 1);
    gfx.fillRect(x - w / 2 + 2 * s, top + 2 * s, w - 4 * s, 3 * s);
    gfx.fillCircle(x - w / 2 + 8 * s, top + h / 2, 3.4 * s);   // pin-1 dimple
    return;
  }
  gfx.fillStyle(CERM, 1);
  gfx.fillRoundedRect(x - w / 2, top, w, h, 2 * s);
  gfx.fillStyle(CERM_DK, 1);
  gfx.fillRect(x - w / 2, top + h - 4 * s, w, 4 * s);
  gfx.fillStyle(GOLD, 1);
  gfx.fillRect(x - w * 0.34, top + 2.5 * s, w * 0.68, h * 0.34);
  gfx.fillStyle(GOLD_HI, 1);
  gfx.fillRect(x - w * 0.34, top + 2.5 * s, w * 0.68, 1.6 * s);
  gfx.fillStyle(CERM_DK, 1);
  gfx.fillCircle(x - w / 2 + 8 * s, top + h * 0.72, 3.2 * s);
  const tw = 12 * s, th = 10.5 * s, tcx = x - w * 0.30, tcy = top + h * 0.68;
  gfx.fillStyle(0xd83a3a, 1);
  gfx.fillTriangle(tcx, tcy - th / 2, tcx + tw / 2, tcy + th / 2, tcx - tw / 2, tcy + th / 2);
  gfx.fillStyle(0xff8f8f, 0.85);
  gfx.fillTriangle(tcx, tcy - th / 2, tcx + tw * 0.16, tcy - th * 0.16, tcx - tw * 0.16, tcy - th * 0.16);
  const L = ceramicLed(x, y, v);
  gfx.fillStyle(GOLD, 1);
  gfx.fillRect(L.cx - 2.6 * s, L.cy, 1.8 * s, L.top - L.cy);
  gfx.fillRect(L.cx + 1.0 * s, L.cy, 1.8 * s, L.top - L.cy);
  drawLedBody(gfx, L.cx, L.cy, L.r, 0xff4136, 0);
}

/** Commercial — three nixie tubes on a plinth. Glass envelopes with a stack of
 *  digit cathodes inside; the powered one glows warm orange. Plug-in parts get
 *  a SOCKET: growing out of the board directly is wrong. */
function nixieGeom(x: number, y: number, v: PartVars) {
  const s = v.s;
  const gw = 17 * s, gh = 34 * s, sock = 8 * s, plinth = 11 * s, pitch = 22 * s;
  const lift = 7 * s;
  const pb = y - lift;
  const gb = pb - plinth - sock, gt = gb - gh;
  return {
    s, gw, gh, sock, plinth, pitch, lift, pb, gb, gt,
    W: 3 * pitch + 6 * s,
    cxs: [x - pitch, x, x + pitch],
  };
}

function nixieDigit(v: PartVars, i: number): number {
  return Math.floor(seeded(v.seed * 0.37 + i * 13.3) * 10);
}

function drawNixie(gfx: Phaser.GameObjects.Graphics, x: number, y: number, v: PartVars): void {
  const N = nixieGeom(x, y, v), s = N.s;
  for (const lx of [-0.34, -0.12, 0.12, 0.34]) {
    legPin(gfx, x + N.W * lx, N.pb - 2 * s, N.lift + 4 * s, 3.2 * s, GOLD);
  }
  gfx.fillStyle(0x241c14, 1);
  gfx.fillRect(x - N.W / 2, N.pb - N.plinth, N.W, N.plinth);
  gfx.fillStyle(0x120d09, 1);
  gfx.fillRect(x - N.W / 2, N.pb - N.plinth * 0.38, N.W, N.plinth * 0.38);
  gfx.fillStyle(GOLD_HI, 0.75);
  gfx.fillRect(x - N.W / 2, N.pb - N.plinth, N.W, 1.6 * s);
  for (let i = 0; i < 3; i++) {
    const cx = N.cxs[i];
    gfx.fillStyle(0x14161a, 1);
    gfx.fillRect(cx - N.gw * 0.66, N.gb, N.gw * 1.32, N.sock);
    gfx.fillStyle(0x2b2f36, 1);
    gfx.fillRect(cx - N.gw * 0.66, N.gb, N.gw * 1.32, 2.2 * s);
    gfx.fillStyle(0x0b171b, 0.82);
    gfx.fillRect(cx - N.gw / 2, N.gt, N.gw, N.gh);
    gfx.fillEllipse(cx, N.gt, N.gw, N.gw * 0.72);
    // The unlit cathodes stacked behind, then the powered one's dark filament —
    // the night layer is what lights it.
    segDigit(gfx, cx + 1.2 * s, N.gt + N.gh * 0.42, N.gw * 0.46, N.gh * 0.38,
      nixieDigit(v, i + 5), 0x4b5560, 0.55, 1.8 * s);
    segDigit(gfx, cx, N.gt + N.gh * 0.46, N.gw * 0.5, N.gh * 0.42,
      nixieDigit(v, i), 0x7a4a22, 0.95, 2.2 * s);
    gfx.lineStyle(0.8, 0xc9d2d8, 0.22);
    for (let k = 1; k < 5; k++) {
      const gx = cx - N.gw / 2 + (k / 5) * N.gw;
      gfx.lineBetween(gx, N.gt + 2 * s, gx, N.gb - 2 * s);
    }
    gfx.fillStyle(0xffffff, 0.13);
    gfx.fillRect(cx - N.gw * 0.38, N.gt + N.gh * 0.10, 2.4 * s, N.gh * 0.66);
    gfx.lineStyle(1.3, GLASS, 0.5);
    gfx.lineBetween(cx - N.gw / 2, N.gt, cx - N.gw / 2, N.gb);
    gfx.lineBetween(cx + N.gw / 2, N.gt, cx + N.gw / 2, N.gb);
  }
}

/** Industrial — an E-I transformer: laminations in black-and-white stripes and
 *  an exposed copper winding at the waist. The stripes have to be high
 *  contrast, because the far heat-sink ring is grey-brown too and a low
 *  contrast stack dissolves straight into it. */
function drawXformer(gfx: Phaser.GameObjects.Graphics, x: number, y: number, v: PartVars): void {
  const s = v.s, w = 74 * s, h = 40 * s, ft = 7 * s;
  const top = y - ft - h;
  gfx.fillStyle(0x3c4249, 1);
  gfx.fillRect(x - w / 2, y - ft, w * 0.22, ft);
  gfx.fillRect(x + w / 2 - w * 0.22, y - ft, w * 0.22, ft);
  gfx.fillStyle(0x767d85, 1);
  gfx.fillRect(x - w / 2, top, w, h);
  const lam = Math.max(7, Math.round(h / (3.4 * s))), lh = h / lam;
  for (let i = 0; i < lam; i++) {
    gfx.fillStyle(i % 2 ? 0x474d55 : 0x9ba3ad, 1);
    gfx.fillRect(x - w / 2, top + i * lh, w, lh * 0.55);
  }
  gfx.lineStyle(1.8, 0x191d22, 0.95);
  gfx.strokeRect(x - w / 2, top, w, h);
  gfx.fillStyle(0x474d55, 1);
  gfx.fillRect(x - w / 2, top, w, 3 * s);
  gfx.fillRect(x - w / 2, top + h - 3 * s, w, 3 * s);
  gfx.fillStyle(TIN, 1);
  for (const bx of [x - w * 0.44, x + w * 0.44]) {
    gfx.fillCircle(bx, top + 4 * s, 2.6 * s);
    gfx.fillCircle(bx, top + h - 4 * s, 2.6 * s);
  }
  const cw = w * 0.34, cx0 = x - cw / 2;
  gfx.fillStyle(COPPER, 1);
  gfx.fillRect(cx0, top + 4 * s, cw, h - 8 * s);
  gfx.lineStyle(1.1, 0x743c14, 0.8);
  for (let wx = cx0 + 2 * s; wx < cx0 + cw - s; wx += 3.4 * s) {
    gfx.lineBetween(wx, top + 4 * s, wx, top + h - 4 * s);
  }
  gfx.fillStyle(0xe0a463, 0.5);
  gfx.fillRect(cx0 + 1.5 * s, top + 4 * s, cw * 0.18, h - 8 * s);
  gfx.fillStyle(0x33241a, 1);
  gfx.fillRect(cx0 - 2.5 * s, top + 2 * s, cw + 5 * s, 3.4 * s);
  gfx.fillRect(cx0 - 2.5 * s, top + h - 5.4 * s, cw + 5 * s, 3.4 * s);
  // Leads run out sideways first, then straight down. A diagonal from core to
  // board reads as a guy rope, not as wire.
  gfx.lineStyle(2.4, COPPER, 1);
  for (const sgn of [-1, 1]) {
    const ex = x + sgn * w * 0.42;
    gfx.lineBetween(x + sgn * cw * 0.3, top + 2 * s, ex, top + 2 * s);
    gfx.lineBetween(ex, top + 2 * s, ex, y - 2 * s);
  }
  legPin(gfx, x - w * 0.42, y - 3 * s, 6 * s, 3 * s, COPPER);
  legPin(gfx, x + w * 0.42, y - 3 * s, 6 * s, 3 * s, COPPER);
}

/** Landmark — vacuum tube. None of its marks is optional: the plate (the dark
 *  metal box that takes most of the volume), the grid spiral around it, the
 *  filament, the GETTER FLASH mirrored on the inside of the glass dome, and the
 *  base pins. */
function tubeGeom(x: number, y: number, v: PartVars) {
  const s = v.s;
  const pinH = 8 * s, sockH = 15 * s, sockW = 40 * s, gw = 32 * s, gh = 104 * s;
  const sb = y - pinH;
  const gb = sb - sockH, gt = gb - gh;
  return {
    s, pinH, sockH, sockW, gw, gh, sb, gb, gt,
    pw: gw * 0.66, pTop: gt + gh * 0.19, pBot: gb - gh * 0.26,
    fTop: gb - gh * 0.22, fBot: gb - gh * 0.06,
  };
}

function drawTube(gfx: Phaser.GameObjects.Graphics, x: number, y: number, v: PartVars): void {
  const T = tubeGeom(x, y, v), s = T.s;
  // Base pins: SHORT, FAT and gold on purpose, so they never get confused with
  // the checkpoint's slim tinned pin header. One part, one identity (§3.3).
  for (let i = 0; i < 5; i++) {
    legPin(gfx, x + (i - 2) * (T.sockW * 0.19), T.sb - 2 * s, T.pinH + 4 * s, 4.4 * s, GOLD);
  }
  gfx.fillStyle(0x14161a, 1);
  gfx.fillRect(x - T.sockW / 2, T.gb, T.sockW, T.sockH);
  gfx.fillStyle(0x272b32, 1);
  gfx.fillRect(x - T.sockW / 2, T.gb, T.sockW, 3 * s);
  gfx.fillStyle(0x0b0d10, 1);
  gfx.fillRect(x - T.sockW / 2, T.sb - 3 * s, T.sockW, 3 * s);
  gfx.fillStyle(0x08090c, 1);
  gfx.fillRect(x - T.sockW * 0.09, T.gb + 3 * s, T.sockW * 0.18, T.sockH - 6 * s);
  gfx.fillStyle(0x0e1a20, 0.92);
  gfx.fillRect(x - T.gw / 2, T.gt, T.gw, T.gh);
  gfx.fillEllipse(x, T.gt, T.gw, T.gw * 0.82);
  // Getter flash: INSET, with a ring of clear glass above it. Filled to the
  // edge it reads as a metal cap rather than a mirror on the inside.
  gfx.fillStyle(0xb4c0c9, 0.94);
  gfx.fillEllipse(x, T.gt + T.gw * 0.03, T.gw - 5 * s, T.gw * 0.62);
  gfx.fillStyle(0x9aa6b0, 0.85);
  gfx.fillRect(x - T.gw / 2 + 2.4 * s, T.gt, T.gw - 4.8 * s, T.gh * 0.10);
  gfx.fillStyle(0xe6eef4, 0.75);
  gfx.fillEllipse(x - T.gw * 0.15, T.gt - T.gw * 0.09, T.gw * 0.36, T.gw * 0.2);
  gfx.fillStyle(0x5d6772, 0.55);
  gfx.fillRect(x - T.gw / 2 + 2.4 * s, T.gt + T.gh * 0.10, T.gw - 4.8 * s, 1.6 * s);
  // Grid spiral. Thin and pale: thicken it and it takes over, and the plate —
  // the part that carries the silhouette — stops reading.
  const gx = T.pw / 2 + 3.4 * s, y0 = T.pTop - 3 * s, y1 = T.pBot + 3 * s;
  gfx.lineStyle(1, 0xb9c1c9, 0.6);
  gfx.lineBetween(x - gx, y0, x - gx, y1);
  gfx.lineBetween(x + gx, y0, x + gx, y1);
  const turns = 18;
  for (let i = 0; i < turns; i++) {
    gfx.lineBetween(x - gx, y0 + (i / turns) * (y1 - y0), x + gx, y0 + ((i + 0.55) / turns) * (y1 - y0));
  }
  gfx.fillStyle(0x363c45, 1);
  gfx.fillRect(x - T.pw / 2, T.pTop, T.pw, T.pBot - T.pTop);
  gfx.fillStyle(0x4e555f, 1);
  gfx.fillRect(x - T.pw / 2, T.pTop, T.pw * 0.38, T.pBot - T.pTop);
  gfx.fillStyle(0x1d2127, 1);
  gfx.fillRect(x - T.pw * 0.07, T.pTop, T.pw * 0.14, T.pBot - T.pTop);
  gfx.fillStyle(0x596069, 1);
  gfx.fillRect(x - T.pw / 2, T.pTop, T.pw, 1.8 * s);
  gfx.lineStyle(1.2, 0x12161a, 0.95);
  gfx.strokeRect(x - T.pw / 2, T.pTop, T.pw, T.pBot - T.pTop);
  gfx.fillStyle(0xd6c6a4, 0.92);
  gfx.fillRect(x - T.gw * 0.40, T.pTop - 3.4 * s, T.gw * 0.80, 3.4 * s);
  gfx.fillRect(x - T.gw * 0.40, T.pBot, T.gw * 0.80, 3.4 * s);
  gfx.lineStyle(2.4 * s, 0x6b3c18, 1);
  gfx.lineBetween(x - T.gw * 0.13, T.fBot, x - T.gw * 0.13, T.fTop);
  gfx.lineBetween(x + T.gw * 0.13, T.fBot, x + T.gw * 0.13, T.fTop);
  gfx.lineBetween(x - T.gw * 0.13, T.fTop, x + T.gw * 0.13, T.fTop);
  gfx.fillStyle(GLASS, 0.09);
  gfx.fillRect(x - T.gw / 2, T.gt, T.gw, T.gh);
  gfx.fillEllipse(x, T.gt, T.gw, T.gw * 0.82);
  gfx.fillStyle(0xffffff, 0.15);
  gfx.fillRect(x - T.gw * 0.40, T.gt + T.gh * 0.16, 3.4 * s, T.gh * 0.6);
  gfx.lineStyle(1.6, 0xbfe6ee, 0.55);
  gfx.lineBetween(x - T.gw / 2, T.gt, x - T.gw / 2, T.gb);
  gfx.lineBetween(x + T.gw / 2, T.gt, x + T.gw / 2, T.gb);
  gfx.lineBetween(x - T.gw / 2, T.gb, x + T.gw / 2, T.gb);
}

// ── Night lights ───────────────────────────────────────────────────────────
//
// ONLY the parts that actually emit get in here: the nixie's warm digits, the
// tube's filament, and the red LED on the ceramic DIP. The capacitor, the
// transformer and the plastic DIP stay dark and that is a real answer, not an
// omission — "this building has no lights" is what CUSTOM_WORLD_INSTRUCTIONS
// §3.9 says to prefer over inventing windows for a capacitor. If everything
// glows, nothing does.

function glowNixie(
  gfx: Phaser.GameObjects.Graphics, x: number, y: number, v: PartVars,
): void {
  const N = nixieGeom(x, y, v), s = N.s;
  for (let i = 0; i < 3; i++) {
    const cx = N.cxs[i], cy = N.gt + N.gh * 0.46;
    // Keep the halo inside the glass. Wider and the three tubes' halos merge
    // into one blob and the tube shape is gone.
    for (let r = 4; r >= 1; r--) {
      gfx.fillStyle(NEON, 0.055 * r);
      gfx.fillEllipse(cx, cy, N.gw * (0.6 + r * 0.24), N.gh * (0.4 + r * 0.16));
    }
    segDigit(gfx, cx, cy, N.gw * 0.5, N.gh * 0.42, nixieDigit(v, i), NEON, 0.95, 2.8 * s);
    segDigit(gfx, cx, cy, N.gw * 0.5, N.gh * 0.42, nixieDigit(v, i), NEON_HI, 0.9, 1.5 * s);
  }
}

function glowTube(
  gfx: Phaser.GameObjects.Graphics, x: number, y: number, v: PartVars,
): void {
  const T = tubeGeom(x, y, v), s = T.s;
  const cy = (T.fTop + T.fBot) / 2;
  for (let r = 5; r >= 1; r--) {
    gfx.fillStyle(NEON, 0.045 * r);
    gfx.fillEllipse(x, cy, T.gw * (0.34 + r * 0.15), (T.fBot - T.fTop) * (0.9 + r * 0.26));
  }
  gfx.lineStyle(3 * s, NEON, 0.9);
  gfx.lineBetween(x - T.gw * 0.13, T.fBot, x - T.gw * 0.13, T.fTop);
  gfx.lineBetween(x + T.gw * 0.13, T.fBot, x + T.gw * 0.13, T.fTop);
  gfx.lineBetween(x - T.gw * 0.13, T.fTop, x + T.gw * 0.13, T.fTop);
  gfx.lineStyle(1.4 * s, NEON_HI, 0.95);
  gfx.lineBetween(x - T.gw * 0.13, T.fBot, x - T.gw * 0.13, T.fTop);
  gfx.lineBetween(x + T.gw * 0.13, T.fBot, x + T.gw * 0.13, T.fTop);
  gfx.lineBetween(x - T.gw * 0.13, T.fTop, x + T.gw * 0.13, T.fTop);
}

// ── The shop sign: an e-paper module ───────────────────────────────────────

/** Sign width ceiling, demo px. */
const SIGN_MAX_W = 46;
/**
 * A NOMINAL box shorter than this carries no sign at all.
 *
 * Gameview-specific, and it has to be: the demo's components stand 62–140 px
 * apart, so a module hung out at their side has empty board to hang over.
 * OSM footprints are adjacent. Without a floor, the default 8 m building — the
 * height `terrain-builder` substitutes whenever OSM gives none, so most of a
 * street — grows a sign wider than itself and the row turns to soup. 40 px is
 * about 16.7 m; above that a footprint has room to own the space beside it.
 */
const SIGN_MIN_BOX_H = 40;
/** 8° of downward tilt is 1 % of foreshortening in an orthographic side view —
 *  doing it literally is doing nothing, and it breaks the 3:1 ratio. All three
 *  2D demos draw the VISIBLE equivalent instead: the sky-facing top face
 *  catching light as a bright band, plus the shadow it drops on the wall. The
 *  band width is derived from the 8°, not picked. */
const SIGN_TOPFACE = Math.sin(SIGN_TILT_RAD);

/**
 * The carrier is an **e-paper module** — matte grey-white panel, pure black
 * type, a hairline black bezel, an FPC ribbon down one side.
 *
 * **It does not emit.** Being reflective is what e-paper IS, and it is also
 * this carrier's division of labour with the nixie tube standing next to it:
 * the tube makes light, the panel borrows it. So the module is drawn on the DAY
 * graphics and never touches the additive night layer. Do not "just add" a
 * glow here.
 *
 * It hangs on a post at the component's side rather than being stuck to its
 * face, and that difference is required, not stylistic: a label tape and a
 * sticker are adhesive, an e-paper module is a part with a ribbon and a
 * standoff. Stuck on the front it would cover the nixie's three tubes and the
 * ceramic DIP's red LED — the identifying marks of the two districts that get
 * signs at all.
 */
function drawEpaper(
  gfx: Phaser.GameObjects.Graphics,
  cx: number, baseY: number, v: PartVars, zone: ZoneKind,
  vocabulary: SignVocabulary,
): DrawnBox | null {
  const N = PART_SIZE[v.kind];
  const bodyW = N.w * v.s, bodyH = N.h * v.s;
  // Flat packages hang their sign at the TOP of the allowed band: the route
  // itself rides the board here, and a module hung low on a 30 px DIP is cut
  // in half by it.
  const flat = v.kind === 'dip' || v.kind === 'ceramic';
  const place = signPlacement(bodyW, bodyH, v.seed, SIGN_MAX_W, flat ? 0.64 : 0.55, 0.70);
  // The demo's own legibility floor: a module under 18 px across is four
  // smudges, and hanging it anyway is worse than leaving the wall bare.
  if (!place || place.width < 18) return null;
  const w = place.width, h = place.height;
  const sx = cx + v.flip * (bodyW / 2 + w * 0.55);
  const sy = baseY - place.centerY;
  const L = sx - w / 2, T = sy - h / 2, B = sy + h / 2;

  // Standoff + hex spacer foot. Without them the module floats over the board.
  gfx.fillStyle(darken(TIN, 0.72), 1);
  gfx.fillRect(sx - 1.8, B - 1, 3.6, baseY - B + 1);
  gfx.fillStyle(GOLD, 1);
  gfx.fillRect(sx - 4, baseY - 7, 8, 7);
  gfx.fillStyle(darken(GOLD, 0.7), 1);
  gfx.fillRect(sx - 4, baseY - 3.2, 8, 1.4);

  // FPC ribbon: amber polyimide with copper traces, back to the component.
  const ix = sx - v.flip * w / 2, ex = cx + v.flip * bodyW * 0.16;
  const iy = sy + h * 0.08, ey = sy + h * 0.46;
  const ribbon = (t: number, col: number): void => {
    gfx.fillStyle(col, 1);
    gfx.beginPath();
    gfx.moveTo(ix, iy - t / 2); gfx.lineTo(ex, ey - t / 2);
    gfx.lineTo(ex, ey + t / 2); gfx.lineTo(ix, iy + t / 2);
    gfx.closePath(); gfx.fillPath();
  };
  ribbon(8.4, 0x8a6524);
  ribbon(6.4, 0xd9a441);
  gfx.lineStyle(0.8, darken(COPPER, 0.85), 0.8);
  for (const k of [-1.8, 0, 1.8]) gfx.lineBetween(ix, iy + k, ex, ey + k);
  gfx.fillStyle(0x14171b, 1);
  gfx.fillRect(ix - (v.flip > 0 ? 5 : 0), iy - 6, 5, 12);

  // Panel: shadow, hairline bezel, matte face, a step of shade at the bottom
  // for thickness, and the lit top band that IS the 8° tilt.
  gfx.fillStyle(0x05100c, 0.45);
  gfx.fillRect(L + 2, T + 3, w, h);
  gfx.fillStyle(0x11150f, 1);
  gfx.fillRect(L - 1.2, T - 1.2, w + 2.4, h + 2.4);
  gfx.fillStyle(0xdfe3dd, 1);
  gfx.fillRect(L, T, w, h);
  gfx.fillStyle(0xc6cbc3, 1);
  gfx.fillRect(L, B - h * 0.12, w, h * 0.12);
  gfx.fillStyle(0xf1f4ee, 1);
  gfx.fillRect(L, T, w, Math.max(1.2, h * SIGN_TOPFACE));
  gfx.lineStyle(0.8, 0x6f776c, 0.7);
  gfx.strokeRect(L + w * 0.035, T + h * 0.10, w * 0.93, h * 0.78);

  // The module + its standoff, so the caller can report what it really filled.
  const extent: DrawnBox = { x: L - 1.2, y: T - 1.2, w: w + 2.4, h: baseY - (T - 1.2) };

  const content = signContent(zone, v.seed, 'circuit', vocabulary);
  if (!content) return extent;
  if (content.symbol === 'triangle') {
    // Black/white/RED e-paper — the third pigment the panel already has, not
    // light it is making.
    const th = h * 0.66, tw = th * 1.15;
    gfx.fillStyle(0xd8443a, 1);
    gfx.fillTriangle(sx, sy - th / 2, sx + tw / 2, sy + th / 2, sx - tw / 2, sy + th / 2);
    return extent;
  }
  gfx.fillStyle(0x0b0f0c, 1);
  for (const q of signStrokes(w * 0.92, h, content.text)) {
    // sign-spec is plate-local with +y UP (Three's convention); 2D negates y.
    strokeQuad(gfx, sx + q.x0, sy - q.y0, sx + q.x1, sy - q.y1, q.width);
  }
  return extent;
}

/** One stroke with thickness and square caps. Rounding the caps costs the
 *  crispness that makes a geometric alphabet legible at forty pixels. */
function strokeQuad(
  gfx: Phaser.GameObjects.Graphics,
  x0: number, y0: number, x1: number, y1: number, t: number,
): void {
  const ex = x1 - x0, ey = y1 - y0, len = Math.hypot(ex, ey) || 1;
  const px = (-ey / len) * (t / 2), py = (ex / len) * (t / 2);
  gfx.fillTriangle(x0 + px, y0 + py, x1 + px, y1 + py, x1 - px, y1 - py);
  gfx.fillTriangle(x0 + px, y0 + py, x1 - px, y1 - py, x0 - px, y0 - py);
  gfx.fillRect(x0 - t / 2, y0 - t / 2, t, t);
  gfx.fillRect(x1 - t / 2, y1 - t / 2, t, t);
}

// ── Palette ────────────────────────────────────────────────────────────────

const PALETTE = {
  terrainFill: FR4,
  terrainOutline: MASK_HI,
  ink: INK,
  skyDayTop: BG_DAY_TOP,
  skyDayBottom: BG_DAY_BOT,
  /** NOT a set of wall colours — nothing in this world is coloured by a hash.
   *  The three capacitor sleeves, so `colorIndex` stays a live modulo that
   *  means something (the sleeve) instead of an index nobody reads. */
  buildingColors: [...CAP_SLEEVES],
  treeTrunk: TIN,
  treeCanopy: 0x3a6fc4,
  /** The three glazes of the 3D world's disc-capacitor tree — same three, so
   *  one tree is one colour in both views. */
  treeCanopyColors: [0x3a6fc4, 0xc9822a, 0x7a4a2a],
  waterFill: SOLDER,
  waterOutline: 0xdfe6ee,
  grassOverlay: COPPER,
  lampPost: TIN,
  lampGlow: 0x3bff7a,
  /** Far ring is DARKER than near here. It reads correctly because both are
   *  copper against a green board rather than haze against sky. (Demo.) */
  mountainFar: darken(COPPER, 0.62),
  mountainNear: darken(COPPER, 0.88),
  cloud: FOAM,
  moon: 0xdff2fb,
  coinGold: 0xdfe4ea,
  coinHighlight: 0xffffff,
  coinOutline: 0x9aa1ab,
  markerTick: SILK,
  /** The 3D demo's DAY fog. The 2D fog layer is a daytime weather effect, so
   *  the night fog (#08171c) would be the wrong one to mirror here. */
  fogColor: 0xcfdcd6,
  cyclistBody: 0xe8f6ff,
  cyclistHelmet: TRACE,
  cyclistSkin: 0xe8f6ff,
};

const CYCLIST_W = 56;
const CYCLIST_H = 56;
const COIN_SIZE = 12;

/** LED lamp colours — the same four the 3D `LED_COLORS` uses. */
const LAMP_COLORS = [0xff3b3b, 0x3bff7a, 0x3b8cff, 0xffd23b];

// ═══════════════════════════════════════════════════════════════════════════

export function createCircuitStyle(): PhaserStyleStrategy {
  return {
    style: 'circuit',
    palette: {
      ...PALETTE,
      buildingColors: [...PALETTE.buildingColors],
      treeCanopyColors: [...PALETTE.treeCanopyColors],
    },

    // ── Terrain ──
    //
    // No `snapGroundY`: this board is a flex board and its layers follow the
    // surface continuously. The 3D world quantises (stacked rigid boards); 2D
    // does not, and that is the demo's own split between the two views.

    /**
     * The board in cross-section, drawn bottom-up in the order a board is
     * actually built: fibreglass, four copper layers, solder mask, routing,
     * silkscreen. Drawn in any other order the upper layers get buried.
     *
     * Cost is bounded by the SAMPLE COUNT, not the depth: the five bands are
     * five polygons over the same `points` array however thick the board is.
     * The per-x loops (weave, vias, ticks, bus) each step at their own fixed
     * pitch, so widening the view is linear and deepening it is free.
     *
     * `intro` is the power-on sweep — a lit front running left to right at
     * BOOT_SPEED with a BOOT_RAMP fade behind it. Unlit, the bus is dark
     * copper; lit, cyan. That is this world's entrance: it does not drop into
     * place or get drawn, it comes UP.
     *
     * ⚠ The demo puts the powered trace on its own glow layer above the night
     * veil; a 2D strategy only ever gets the day layer, so the cyan is laid
     * straight onto the board here at the demo's own alpha. The bus is
     * therefore lit by day too — which is correct for a board that is powered
     * whenever you are riding it.
     */
    drawTerrainSurface(gfx, points, bottomY, _seed, intro, zones) {
      if (points.length < 2) return;
      const left = points[0].x;
      const right = points[points.length - 1].x;

      /** Ground Y at world x, by linear search over the samples we were given.
       *  The per-pitch loops below need Y at THEIR x, not at a sample's. */
      const yAt = (x: number): number => {
        if (x <= points[0].x) return points[0].y;
        const last = points.length - 1;
        if (x >= points[last].x) return points[last].y;
        const span = (points[last].x - points[0].x) / last;
        const i = clamp(Math.floor((x - points[0].x) / span), 0, last - 1);
        const a = points[i], b = points[i + 1];
        const t = (x - a.x) / (b.x - a.x || 1);
        return a.y + (b.y - a.y) * t;
      };

      /** A band `t` px thick, `off` px below the surface. */
      const band = (off: number, t: number, color: number, alpha = 1): void => {
        gfx.fillStyle(color, alpha);
        gfx.beginPath();
        gfx.moveTo(points[0].x, points[0].y + off);
        for (let i = 1; i < points.length; i++) gfx.lineTo(points[i].x, points[i].y + off);
        for (let i = points.length - 1; i >= 0; i--) gfx.lineTo(points[i].x, points[i].y + off + t);
        gfx.closePath();
        gfx.fillPath();
      };

      // Below the board's own thickness: dark. What is down there does not
      // matter; what matters is that the board HAS a bottom, so 74 px reads as
      // one piece rather than as geology going down forever.
      gfx.fillStyle(DEEP, 1);
      gfx.beginPath();
      gfx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) gfx.lineTo(points[i].x, points[i].y);
      gfx.lineTo(right, bottomY);
      gfx.lineTo(left, bottomY);
      gfx.closePath();
      gfx.fillPath();

      band(MASK_T, BOARD_T - MASK_T, FR4);
      gfx.lineStyle(1, darken(FR4, 0.82), 0.5);
      for (let x = Math.floor(left / WEAVE_PITCH) * WEAVE_PITCH; x < right; x += WEAVE_PITCH) {
        const y = yAt(x);
        gfx.lineBetween(x, y + MASK_T + 2, x, y + BOARD_T - 2);
      }
      for (let i = 0; i < COPPER_LAYERS.length; i++) {
        band(COPPER_LAYERS[i], i === 0 ? 3 : 2.4, COPPER);
      }
      band(0, MASK_T, MASK);
      // ── 土地分區 = 阻焊顏色 ──
      //
      // The demo's loop, verbatim: walk runs of same-zone samples, tint ONLY the
      // mask layer over each run, take the lit surface edge from that district,
      // and drop a silkscreen line down the full board thickness at every
      // boundary. Its own statement of the rule is
      // 「分區是『這段板子開什麼色的阻焊』,不是換一塊板子」— the copper and the
      // fibreglass underneath do not move, which is why this sits between the
      // mask band and everything routed on top of it.
      //
      // A null run — outside every known district, which is most of a real
      // route — draws NO tint and keeps the base mask green with `MASK_HI` on
      // its edge, i.e. exactly what this function drew before it had zones. The
      // demo has no such case (its `zoneAt` always answers); an unzoned stretch
      // of board is 「沒開彩色阻焊」, not a sixth colour, and above all not
      // residential (`land-zone.ts` on why those two must never be the same).
      let i0 = 0;
      while (i0 < points.length - 1) {
        const kind = zones?.[i0] ?? null;
        let i1 = i0 + 1;
        while (i1 < points.length - 1 && (zones?.[i1] ?? null) === kind) i1++;
        const Z = kind ? ZONE_MASK[kind] : null;
        if (Z) {
          // 阻焊本來就蓋在最外層銅上,所以帶子往下多吃 3.5px 壓住第一層銅 ——
          // 純粹是為了在 1x 底下讀得出來,10px 太細。(demo, verbatim)
          const ZT = MASK_T + 3.5;
          gfx.fillStyle(Z.c, Z.a);
          gfx.beginPath();
          gfx.moveTo(points[i0].x, points[i0].y - 1);
          for (let i = i0 + 1; i <= i1; i++) gfx.lineTo(points[i].x, points[i].y - 1);
          for (let i = i1; i >= i0; i--) gfx.lineTo(points[i].x, points[i].y + ZT);
          gfx.closePath();
          gfx.fillPath();
        }
        // 表面亮邊吃分區色 —— 遠看一條線就知道現在騎在哪一區
        gfx.lineStyle(2.2, Z ? Z.hi : MASK_HI, 0.9);
        gfx.beginPath();
        gfx.moveTo(points[i0].x, points[i0].y);
        for (let i = i0 + 1; i <= i1; i++) gfx.lineTo(points[i].x, points[i].y);
        gfx.strokePath();
        // 分區交界:一道貫穿板厚的絲印分界線
        if (i1 < points.length - 1) {
          gfx.lineStyle(1, SILK, 0.35);
          gfx.lineBetween(points[i1].x, points[i1].y - 26, points[i1].x, points[i1].y + BOARD_T);
        }
        i0 = i1;
      }
      gfx.lineStyle(1.5, darken(FR4, 0.6), 0.9);
      gfx.beginPath();
      gfx.moveTo(points[0].x, points[0].y + BOARD_T);
      for (let i = 1; i < points.length; i++) gfx.lineTo(points[i].x, points[i].y + BOARD_T);
      gfx.strokePath();

      // ── Surface bus ──
      const front = intro ? intro.originX + intro.t * BOOT_SPEED : Infinity;
      const live = (x: number): number => (x > front ? 0 : Math.min(1, (front - x) / BOOT_RAMP));
      const x0 = Math.floor(left / BUS_SS) * BUS_SS;
      for (let i = 0; i < BUS_N; i++) {
        gfx.lineStyle(1.3, darken(COPPER, 0.72), 0.85);
        gfx.beginPath();
        for (let x = x0, first = true; x <= right + BUS_SS; x += BUS_SS, first = false) {
          const y = yAt(x) + busOffset(x) + i * BUS_SP;
          if (first) gfx.moveTo(x, y); else gfx.lineTo(x, y);
        }
        gfx.strokePath();
      }
      // Powered. One wide low-alpha pass for the bundle's shared halo (three
      // separate halos read as three unrelated wires), then the three cores.
      // The halo must NOT overflow the bundle: over the surface it washes the
      // mask colour out.
      for (let x = x0; x < right; x += BUS_SS) {
        const a = live(x);
        if (a <= 0) continue;
        const yb0 = yAt(x) + busOffset(x);
        const yb1 = yAt(x + BUS_SS) + busOffset(x + BUS_SS);
        gfx.lineStyle(BUS_SP * (BUS_N - 1) + 4, TRACE, 0.03 * a);
        gfx.lineBetween(x, yb0 + BUS_SP, x + BUS_SS, yb1 + BUS_SP);
        for (let i = 0; i < BUS_N; i++) {
          gfx.lineStyle(1.2, TRACE, 0.55 * a);
          gfx.lineBetween(x, yb0 + i * BUS_SP, x + BUS_SS, yb1 + i * BUS_SP);
        }
      }
      // Pads on the bus's own grid — the footprint of a ribbon header.
      for (let x = Math.floor(left / PAD_PITCH) * PAD_PITCH; x < right + PAD_PITCH; x += PAD_PITCH) {
        const yb = yAt(x) + busOffset(x);
        gfx.fillStyle(GOLD, 1);
        for (let i = 0; i < BUS_N; i++) gfx.fillRect(x - 5.5, yb + i * BUS_SP - 0.9, 11, 1.8);
      }
      // Plated through holes: a gold barrel through all four layers with the
      // drill down the middle, and an annular ring on the surface.
      for (let gx = Math.floor(left / VIA_GROUP) * VIA_GROUP; gx < right + VIA_GROUP; gx += VIA_GROUP) {
        for (let k = -1; k <= 1; k++) {
          const x = gx + k * VIA_PITCH;
          if (x < left - 20 || x > right + 20) continue;
          const y = yAt(x);
          gfx.fillStyle(GOLD, 1);
          gfx.fillRect(x - VIA_W / 2, y - 2, VIA_W, BOARD_T + 2);
          gfx.fillStyle(0x120f08, 1);
          gfx.fillRect(x - VIA_W / 2 + 2, y - 1, VIA_W - 4, BOARD_T);
          gfx.fillStyle(GOLD_HI, 1);
          gfx.fillRect(x - VIA_W, y - 3, VIA_W * 2, 4);
        }
      }
      // Silkscreen ruler, on the via grid so the two line up.
      for (let x = Math.floor(left / SILK_PITCH) * SILK_PITCH; x < right; x += SILK_PITCH) {
        const y = yAt(x);
        const long = Math.round(x / SILK_PITCH) % 4 === 0;
        gfx.lineStyle(1, SILK, long ? 0.5 : 0.3);
        gfx.lineBetween(x, y - 3.5, x + (long ? 14 : 6), y - 3.5);
      }
    },

    /** No screen overlay. The demo has neither scanlines nor grain — this world
     *  is a lit object on a bench, not a picture of one, and a filter over it
     *  would be the one un-PCB thing in the frame. */
    drawOverlay() {
      return null;
    },

    // ── Background features ──

    /**
     * One component, standing in the box the map handed us.
     *
     * The e-paper sign is drawn here rather than through a hook because there
     * is no 2D sign hook and the demo draws it in exactly the same pass. Its
     * own legibility floor (a module narrower than 18 px is four smudges) is
     * what keeps it off small buildings: with `widthPx` clamped to 15–40, only
     * footprints from about 16 m up carry one at all.
     */
    // `_posts` is declared only to reach `vocabulary` behind it: this world
    // hangs its module on a standoff at the component's SIDE rather than on
    // the facade, so it has no in-body slack to slide the plate along and the
    // demos' `signShift` never applied to it.
    renderBuilding(gfx, x, y, w, h, colorIndex, seed, zone, _posts, vocabulary = 'shop') {
      const v = partVars(seed, zone, w, h, colorIndex);
      const cx = x + w / 2;
      const baseY = y + h;
      switch (v.kind) {
        case 'nixie': drawNixie(gfx, cx, baseY, v); break;
        case 'xformer': drawXformer(gfx, cx, baseY, v); break;
        case 'dip': drawDip(gfx, cx, baseY, v, false); break;
        case 'ceramic': drawDip(gfx, cx, baseY, v, true); break;
        case 'tube': drawTube(gfx, cx, baseY, v); break;
        default: drawCap(gfx, cx, baseY, v); break;
      }
      const extent = partExtent(cx, baseY, v);
      // The sign hangs on the DISTRICT, not on the package: a landmark tube in
      // a shopping street still needs one, or the only thing saying "shops" is
      // a band of solder-mask colour. Residential and industrial get none.
      if (h < SIGN_MIN_BOX_H || !zone || !SIGN_ZONES.has(zone)) return extent;
      const sign = drawEpaper(gfx, cx, baseY, v, zone, vocabulary);
      return sign ? union(extent, sign) : extent;
    },

    /**
     * This component's lights, on the chunk's ADDITIVE layer.
     *
     * Re-derived from `(seed, zone, h)` through the same `partVars` the body
     * used, so asking for lights can never re-roll a shape, and the two can
     * never disagree about where the glowing part is.
     *
     * Three of the six draw NOTHING, and that is the answer, not a gap: a
     * capacitor does not glow, a transformer does not glow, and a plastic DIP
     * does not glow. Cost is bounded by the component (three tubes, one
     * filament, one die) rather than by the box height — the generic grid this
     * replaces was linear in it, which on an add-blended layer made a tower the
     * most expensive thing on screen.
     */
    renderBuildingLights(gfx, x, y, w, h, colorIndex, seed, zone) {
      const v = partVars(seed, zone, w, h, colorIndex);
      const cx = x + w / 2;
      const baseY = y + h;
      if (v.kind === 'nixie') { glowNixie(gfx, cx, baseY, v); return; }
      if (v.kind === 'tube') { glowTube(gfx, cx, baseY, v); return; }
      if (v.kind === 'ceramic') {
        const L = ceramicLed(cx, baseY, v);
        drawLedGlow(gfx, L.cx, L.cy, L.r, 0xff4136, 1);
      }
    },

    /**
     * Tree — a disc ceramic capacitor on two tin legs.
     *
     * Not the demo's banded-resistor bush: the 3D world's `buildTreeGeometry`
     * is the disc capacitor, and the two views of one world are not allowed to
     * use different objects for the same part (§3.10's closing rule). The
     * resistor bush is the BUSH, which has a hook in neither engine.
     *
     * Proportions are the 3D geometry's, converted at PX_PER_METER: R 3.4 m,
     * 6.2 m to the centre, 6.6 m legs — then ×1.25, which lands it in the ~36 px
     * envelope the other two worlds' trees occupy. That envelope is not
     * cosmetic: bushes, lamps and building skirts are placed against it.
     *
     * `size` is ignored, as it is in the toy world, because `terrain-builder`
     * passes a literal 0 for every tree there has ever been.
     */
    renderTree(gfx, x, y, _size, seed) {
      const k = 1.25;
      const r = 10.2 * k;              // 3.4 m × 3 px/m
      const cy = y - 18.6 * k;         // 6.2 m up
      const glaze = PALETTE.treeCanopyColors[seed % PALETTE.treeCanopyColors.length];
      // Legs SPLAY, the way a radial part's do once it is bent to fit a wider
      // pad pitch (the 3D geometry says 微外八 for the same reason). Drawn
      // parallel at the 3D's 1.1 m spacing they are 4 px apart with a 1.75 px
      // stroke, which at riding distance is one leg.
      gfx.lineStyle(1.6, TIN, 1);
      gfx.lineBetween(x - 3.3 * k, cy, x - 6.0 * k, y);
      gfx.lineBetween(x + 3.3 * k, cy, x + 6.0 * k, y);
      // The disc is DIPPED, not turned: it keeps a rim of thickness, which is
      // also why the 3D one is a squashed lens rather than a plane.
      gfx.fillStyle(darken(glaze, 0.62), 1);
      gfx.fillEllipse(x, cy, r * 2, r * 2);
      gfx.fillStyle(glaze, 1);
      gfx.fillEllipse(x, cy - r * 0.08, r * 1.86, r * 1.78);
      gfx.fillStyle(0xffffff, 0.22);
      gfx.fillEllipse(x - r * 0.34, cy - r * 0.42, r * 0.7, r * 0.5);
      // Marking band across the belly — a disc cap always carries one.
      gfx.fillStyle(darken(glaze, 0.45), 0.8);
      gfx.fillRect(x - r * 0.7, cy + r * 0.28, r * 1.4, Math.max(1, r * 0.16));
    },

    /** Water — a solder pool: opaque liquid metal held up by surface tension,
     *  with a hard specular line where it meets the mask. (3D:
     *  `createWaterMaterial` = high-shininess solder.) */
    renderWater(gfx, x, y, _w, h, _seed) {
      const width = 60;
      gfx.fillStyle(darken(SOLDER, 0.62), 1);
      gfx.fillRect(x - width / 2, y, width, h);
      gfx.fillStyle(SOLDER, 1);
      gfx.fillRect(x - width / 2, y, width, Math.min(h, 5));
      gfx.lineStyle(2, PALETTE.waterOutline, 0.85);
      gfx.lineBetween(x - width / 2, y + 1, x + width / 2, y + 1);
      gfx.fillStyle(0xffffff, 0.35);
      gfx.fillRect(x - width * 0.34, y + 1.6, width * 0.22, 1.6);
      return { x, y, w: width };
    },

    /** Grass / park — copper pour: exposed copper with the mask's thermal
     *  relief squares punched into it. (3D: `createParkMaterial` = pourTex.) */
    renderGrass(gfx, x, y, _w, _h, seed) {
      gfx.fillStyle(COPPER, 0.85);
      gfx.fillRect(x - 16, y - 4, 32, 4);
      gfx.fillStyle(MASK_LO, 0.55);
      for (let i = -12; i <= 12; i += 8) {
        if (seeded(seed + i) < 0.2) continue;
        gfx.fillRect(x + i, y - 3, 3, 3);
      }
      gfx.lineStyle(1, 0xf0c98a, 0.25);
      gfx.lineBetween(x - 16, y - 1, x + 16, y - 4);
    },

    /** Sand — bare board: no mask, just fibreglass with its weave. (3D:
     *  `createSandMaterial` = fr4Tex.) */
    renderSand(gfx, x, y, _w, _h, seed) {
      gfx.fillStyle(FR4, 0.9);
      gfx.fillRect(x - 18, y - 4, 36, 4);
      gfx.lineStyle(1, FR4_DK, 0.5);
      for (let i = -16; i <= 16; i += 5) {
        if (seeded(seed + i * 3) < 0.15) continue;
        gfx.lineBetween(x + i, y - 4, x + i, y);
      }
    },

    /** Built-up — a routed area: mask one step brighter with a silkscreen
     *  outline round it. Deliberately district-BLIND even though the hook now
     *  carries a zone: since `drawTerrainSurface` tints the mask per district,
     *  colouring this 60 px strip as well would put a second, disagreeing
     *  district signal on the same ground (the demo has no such strip at all —
     *  its zoning is the board). This says only 「這一段有佈線」. */
    renderUrban(gfx, x, y, _w, _h, seed) {
      gfx.fillStyle(MASK_HI, 0.7);
      gfx.fillRect(x - 30, y - 3, 60, 3);
      gfx.lineStyle(1, SILK, 0.28);
      for (let i = -28; i <= 28; i += 12) {
        if (seeded(seed + i * 3) < 0.25) continue;
        gfx.lineBetween(x + i, y - 3.5, x + i + 7, y - 3.5);
      }
    },

    /** Waterway — the same solder, running narrow. */
    renderWaterway(gfx, x, y, w, h, _seed) {
      gfx.fillStyle(darken(SOLDER, 0.62), 1);
      gfx.fillRect(x - w / 2, y, w, h);
      gfx.fillStyle(SOLDER, 1);
      gfx.fillRect(x - w / 2, y, w, Math.min(h, 4));
      gfx.lineStyle(1.5, PALETTE.waterOutline, 0.8);
      gfx.lineBetween(x - w / 2, y + 1, x + w / 2, y + 1);
      return { x, y, w };
    },

    /** Aeroway — an in-circuit test pad field: a silkscreen-framed strip of
     *  gold pads. The runway gets the full row, a taxiway a sparser one. */
    renderAeroway(gfx, x, y, w, kind, _seed) {
      const half = w / 2, stripH = 8;
      gfx.fillStyle(MASK_LO, 0.95);
      gfx.fillRect(x - half, y - stripH, w, stripH);
      gfx.lineStyle(1, SILK, 0.45);
      gfx.strokeRect(x - half, y - stripH, w, stripH);
      gfx.fillStyle(GOLD, kind === 'runway' ? 1 : 0.6);
      const step = kind === 'runway' ? 12 : 22;
      for (let i = -half + 6; i < half - 4; i += step) {
        gfx.fillRect(x + i, y - stripH / 2 - 1.5, 6, 3);
      }
    },

    /**
     * Road — the gold main bus: the solder mask is OPENED and the plating
     * underneath is exposed, with a mask lip either side. Same object as the 3D
     * `createRoadMaterial`'s `busTexture` (12.5 % mask margin, gold gradient
     * with a bright core, a light line on the top lip and a dark one on the
     * bottom), read as a side view.
     *
     * Distinct from the signal bus in `drawTerrainSurface` and it must stay
     * that way (§3.3, one identity per part): that one is thin, cyan when
     * powered, and carries signals; this one is wide, gold and always there.
     */
    renderRoadSurface(gfx, points, _seed) {
      const H = 9;                       // opening height
      const lip = Math.max(1.2, H * 0.125);
      const ribbon = (top: number, thick: number, color: number, alpha = 1): void => {
        gfx.fillStyle(color, alpha);
        gfx.beginPath();
        gfx.moveTo(points[0].x, points[0].y + top);
        for (const p of points) gfx.lineTo(p.x, p.y + top);
        for (let i = points.length - 1; i >= 0; i--) gfx.lineTo(points[i].x, points[i].y + top + thick);
        gfx.closePath();
        gfx.fillPath();
      };
      ribbon(0, H, MASK_LO);                          // the mask, cut open
      ribbon(lip, H - 2 * lip, GOLD);                 // exposed plating
      ribbon(lip + (H - 2 * lip) * 0.34, (H - 2 * lip) * 0.32, GOLD_HI);  // the bright core
      gfx.lineStyle(1, 0xffffff, 0.16);
      gfx.beginPath();
      gfx.moveTo(points[0].x, points[0].y + lip);
      for (const p of points) gfx.lineTo(p.x, p.y + lip);
      gfx.strokePath();
      gfx.lineStyle(1, 0x000000, 0.3);
      gfx.beginPath();
      gfx.moveTo(points[0].x, points[0].y + H - lip);
      for (const p of points) gfx.lineTo(p.x, p.y + H - lip);
      gfx.strokePath();
    },

    /** Street lamp — a 5 mm LED standing on its own two legs, long one taller.
     *  The unequal legs are an LED's only direction mark; without them it is a
     *  post. Body and glow are the shared `drawLedBody`/`drawLedGlow` (§3.10) —
     *  the same two the ceramic DIP's indicator uses. */
    renderRoadLamp(gfx, x, y, seed) {
      const col = LAMP_COLORS[seed % LAMP_COLORS.length];
      gfx.fillStyle(TIN, 1);
      gfx.fillRect(x - 5, y - 30, 3, 30);
      gfx.fillRect(x + 2, y - 25, 3, 25);
      drawLedBody(gfx, x, y - 40, 8, col, 0);
    },

    renderRoadLampGlow(gfx, x, y, seed) {
      const col = LAMP_COLORS[seed % LAMP_COLORS.length];
      drawLedGlow(gfx, x, y - 40, 8, col, 1);
    },

    // ── Sky / weather ──

    /**
     * Day is the bench under the fluorescents; night is the lights off, with
     * only the board still lit. The four endpoints are the demo's
     * `BG_DAY_TOP/BOT` and `BG_NIGHT_TOP/BOT`; the ramp between them follows
     * the same elevation bands the other two worlds use so dusk lasts the same
     * length of ride in all three.
     */
    getSkyColors(sunElevation, weather) {
      let top: number;
      let bottom: number;
      if (sunElevation > 10) {
        top = BG_DAY_TOP;
        bottom = BG_DAY_BOT;
      } else if (sunElevation > 0) {
        const t = sunElevation / 10;
        top = lerpColor(0x4d6f80, BG_DAY_TOP, t);
        bottom = lerpColor(0xb8ae94, BG_DAY_BOT, t);   // the room going amber
      } else if (sunElevation > -6) {
        const t = (sunElevation + 6) / 6;
        top = lerpColor(0x0d2028, 0x4d6f80, t);
        bottom = lerpColor(0x2c4348, 0xb8ae94, t);
      } else if (sunElevation > -12) {
        const t = (sunElevation + 12) / 6;
        top = lerpColor(BG_NIGHT_TOP, 0x0d2028, t);
        bottom = lerpColor(BG_NIGHT_BOT, 0x2c4348, t);
      } else {
        top = BG_NIGHT_TOP;
        bottom = BG_NIGHT_BOT;
      }
      const wb: Record<string, number> = { sunny: 1.0, cloudy: 0.7, rainy: 0.5, snowy: 0.6 };
      const brightness = wb[weather] ?? 1.0;
      if (brightness < 1.0) {
        top = lerpColor(top, 0x000000, 1 - brightness);
        bottom = lerpColor(bottom, 0x000000, 1 - brightness);
      }
      return { top, bottom };
    },

    /** Cloud — a slab of anti-static foam, the pink stuff ICs ship stuck into.
     *  It is the one soft thing on this bench, which is what makes it the only
     *  honest candidate for something drifting overhead. (Caller sets the base
     *  fill; the shading passes below set their own.) */
    drawCloud(gfx, cx, cy, w, h, seed) {
      const n = 3 + Math.floor(seeded(seed) * 3);
      const unit = w / n;
      for (let i = 0; i < n; i++) {
        const bx = cx - w / 2 + i * unit;
        const bh = h * (0.62 + seeded(seed + i * 7.7) * 0.38);
        gfx.fillRect(bx, cy - bh / 2, unit * 1.04, bh);
      }
      // Cut edge on top, compressed shadow below — foam is a cut block, and
      // without those two it is just a pink rectangle.
      gfx.fillStyle(0xffffff, 0.22);
      gfx.fillRect(cx - w / 2, cy - h * 0.5, w, Math.max(1.5, h * 0.14));
      gfx.fillStyle(0x000000, 0.16);
      gfx.fillRect(cx - w / 2, cy + h * 0.28, w, Math.max(1.5, h * 0.16));
      // The rows of pin holes IC legs were pushed through.
      gfx.fillStyle(0x000000, 0.22);
      for (let i = 0; i < n * 2; i++) {
        const px = cx - w / 2 + (i + 0.5) * (w / (n * 2));
        gfx.fillRect(px, cy - h * 0.12, 1.6, 2.2);
      }
    },

    /**
     * The far ring is two combs of heat-sink fins.
     *
     * Square wave, not a curve: each point is emitted twice so the silhouette
     * fill turns it into flat-topped fins with sky between them, standing on
     * the base plate the fill leaves below. Fins come in GROUPS of equal
     * height — the fins on one heat sink are cut level, and a smooth gradient
     * reads as a picket fence instead.
     *
     * `maxH` far (0.34) > near (0.23) satisfies §3.6: the back comb is never
     * hidden behind the front one.
     */
    generateMountainPoints(baseY, skyH, totalWidth, layer, seed) {
      const L = layer === 'far' ? FIN_FAR : FIN_NEAR;
      const pitch = L.w + L.gap;
      const floorY = baseY + skyH * (layer === 'far' ? 0.06 : 0.13);
      const points: { x: number; y: number }[] = [];
      points.push({ x: 0, y: floorY });
      for (let x = 0; x <= totalWidth + pitch; x += pitch) {
        const grp = Math.floor(x / (pitch * 6));
        const hh = (0.35 + seeded(grp * 3.3 + seed * 0.017) * 0.65) * skyH * L.maxH;
        const topY = floorY - hh;
        points.push({ x, y: floorY });
        points.push({ x, y: topY });
        points.push({ x: x + L.w, y: topY });
        points.push({ x: x + L.w, y: floorY });
      }
      points.push({ x: totalWidth, y: floorY });
      return points;
    },

    /** Straight fill from the comb down — the solid below the fin roots IS the
     *  heat sink's base plate, so it needs no separate pass. */
    drawMountainSilhouette(gfx, points, color, bottomY, _seed) {
      gfx.fillStyle(color, 1);
      gfx.beginPath();
      gfx.moveTo(points[0].x, bottomY);
      for (const p of points) gfx.lineTo(p.x, p.y);
      gfx.lineTo(points[points.length - 1].x, bottomY);
      gfx.closePath();
      gfx.fillPath();
      // A machined highlight along the fin tops. One stroke for the whole comb.
      gfx.lineStyle(1, lerpColor(color, 0xffffff, 0.35), 0.5);
      gfx.beginPath();
      gfx.moveTo(points[0].x, points[0].y);
      for (const p of points) gfx.lineTo(p.x, p.y);
      gfx.strokePath();
    },

    /** Moon — a cold white LED work lamp: the 3D demo's `skyDisc`, three rings
     *  of #7fb8cc on #dff2fb. */
    drawMoon(gfx, cx, cy, radius, phase, _seed) {
      const brightness = 0.3 + 0.7 * Math.abs(phase - 0.5) * 2;
      gfx.fillStyle(PALETTE.moon, brightness);
      gfx.fillCircle(cx, cy, radius);
      gfx.lineStyle(Math.max(1, radius * 0.09), 0x7fb8cc, 0.75 * brightness);
      for (let i = 0; i < 3; i++) gfx.strokeCircle(cx, cy, radius * (0.89 - i * 0.2));
    },

    /** Sun — the same fitting with a warm shade on it: two rings of #e8c86a on
     *  #fff4d2 (3D demo `skyDisc`, sun variant). */
    drawSun(gfx, cx, cy, radius, _seed) {
      gfx.fillStyle(0xfff4d2, 1);
      gfx.fillCircle(cx, cy, radius);
      gfx.lineStyle(Math.max(1, radius * 0.09), 0xe8c86a, 0.75);
      for (let i = 0; i < 2; i++) gfx.strokeCircle(cx, cy, radius * (0.89 - i * 0.2));
    },

    /** Stars as pixels, not points: every fifth one is trace cyan. (Demo
     *  `drawStars`.) */
    drawStar(gfx, x, y, size, brightness, seed) {
      const s = Math.max(2, size);
      gfx.fillStyle(seed % 5 === 0 ? TRACE : 0xdfeef6, brightness * 0.75);
      gfx.fillRect(x, y, s, s);
    },

    // ── Cyclist ──

    getCyclistFrameSize() {
      return { w: CYCLIST_W, h: CYCLIST_H };
    },

    /**
     * The glowing-wheel bike (demo `drawCyclist`), ported from Graphics to the
     * sprite canvas.
     *
     * Copyright: a glowing rim is the generic shape of an off-the-shelf LED
     * wheel light; the frame is a routed board, which is this world's own
     * vocabulary. It **deliberately avoids** the identifying features of a
     * certain 1982 film's motorcycle: no enclosing bodywork, no light-ribbon
     * trail, and its cyan is not paired with that film's signature orange.
     */
    generateCyclistFrame(ctx, ox, frame, _pose, params) {
      const cx = ox + CYCLIST_W / 2;
      const groundY = CYCLIST_H - 4;
      const FRAME_COUNT = 6;
      const pedalAngle = (frame / FRAME_COUNT) * Math.PI * 2;
      const rock = params.rockAmplitude * Math.sin((frame / FRAME_COUNT) * Math.PI * 2);
      const R = 11;
      const wheelY = groundY - R;
      const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
      const rgba = (c: number, a: number): string =>
        `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;

      for (const wx of [cx - 15, cx + 15]) {
        ctx.lineWidth = 6;
        ctx.strokeStyle = rgba(TRACE, 0.16);
        ctx.beginPath(); ctx.arc(wx, wheelY, R, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#14171c';
        ctx.beginPath(); ctx.arc(wx, wheelY, R, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = hex(TRACE);
        ctx.beginPath(); ctx.arc(wx, wheelY, R - 3, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(157,252,255,0.85)';
        for (let i = 0; i < 4; i++) {
          const a = pedalAngle + (i / 4) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(wx, wheelY);
          ctx.lineTo(wx + Math.cos(a) * (R - 4), wheelY + Math.sin(a) * (R - 4));
          ctx.stroke();
        }
      }

      // Frame: a routed board with gold-plated edges and two cut-outs.
      ctx.fillStyle = hex(MASK);
      ctx.beginPath();
      ctx.moveTo(cx - 15, wheelY);
      ctx.lineTo(cx - 5, wheelY - 16);
      ctx.lineTo(cx + 11, wheelY - 15);
      ctx.lineTo(cx + 15, wheelY);
      ctx.lineTo(cx + 6, wheelY - 2);
      ctx.lineTo(cx - 5, wheelY - 2);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = hex(GOLD_HI);
      ctx.stroke();
      ctx.fillStyle = hex(MASK_LO);
      ctx.beginPath();
      ctx.moveTo(cx - 11, wheelY - 3); ctx.lineTo(cx - 5.5, wheelY - 13);
      ctx.lineTo(cx - 1, wheelY - 3); ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx + 2, wheelY - 3); ctx.lineTo(cx + 8, wheelY - 13);
      ctx.lineTo(cx + 12.5, wheelY - 3.5); ctx.closePath(); ctx.fill();

      // Rider: an incandescent white figure with a cyan helmet light.
      const hipX = cx - 2 + rock;
      const hipY = wheelY - 13 - params.hipOffsetY;
      const lean = params.torsoAngle * (Math.PI / 180);
      const shX = hipX + Math.sin(lean) * 8;
      const shY = hipY - 12;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(232,246,255,0.95)';
      ctx.beginPath(); ctx.moveTo(hipX, hipY); ctx.lineTo(shX, shY); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(hipX, hipY);
      ctx.lineTo(cx + Math.cos(pedalAngle) * 7, wheelY - 3 + Math.sin(pedalAngle) * 7);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(hipX, hipY);
      ctx.lineTo(cx - Math.cos(pedalAngle) * 7, wheelY - 3 - Math.sin(pedalAngle) * 7);
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(shX, shY); ctx.lineTo(cx + 11, wheelY - 16); ctx.stroke();
      const headY = shY - 6 + params.headTilt;
      ctx.lineWidth = 6;
      ctx.strokeStyle = rgba(TRACE, 0.28);
      ctx.beginPath(); ctx.arc(shX + 3, headY, 6, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = hex(TRACE);
      ctx.beginPath(); ctx.arc(shX + 3, headY, 5, 0, Math.PI * 2); ctx.fill();
    },

    /** Zone 5 — the board is running hot. */
    getCyclistZone5Tint(isDarkened) {
      if (!isDarkened) return null;
      return Math.sin(Date.now() * 0.01) > 0 ? 0xff5533 : 0xcc3322;
    },

    // ── Coins ──

    getCoinSize() {
      return COIN_SIZE;
    },

    /** Coin — a lithium coin cell, seen from its stainless top: a bright can
     *  inside a crimped rim, with the two embossed bars. Same object as the 3D
     *  `buildCoinMesh` (rim 1.75 / can 1.5 / two bars). */
    drawCoinTexture(ctx, cx, cy, size, _seed) {
      const r = size - 1;
      ctx.fillStyle = '#9aa1ab';                      // crimped rim
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#dfe4ea';                      // stainless can
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';     // crimp highlight
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.86, Math.PI * 1.05, Math.PI * 1.75); ctx.stroke();
      ctx.fillStyle = '#9aa1ab';                      // the two embossed bars
      ctx.fillRect(cx - r * 0.49, cy - r * 0.07, r * 0.98, r * 0.14);
      ctx.fillRect(cx - r * 0.07, cy - r * 0.49, r * 0.14, r * 0.98);
    },

    // ── Markers / flags ──

    getMarkerFont() {
      return 'Consolas, "Courier New", "Noto Sans TC", monospace';
    },

    /** Checkpoint — a pin header with a coloured jumper on it. The jumper IS
     *  the flag; its colour is the marker's colour. (Demo `drawParts`.) The
     *  pins are slim and tinned, which is what keeps them apart from the
     *  vacuum tube's short fat gold base pins. */
    drawFlag(gfx, x, y, color, _label, _seed) {
      gfx.fillStyle(IC, 1);
      gfx.fillRect(x - 17, y - 10, 34, 10);
      gfx.fillStyle(TIN, 1);
      for (let i = 0; i < 4; i++) gfx.fillRect(x - 13 + i * 8, y - 46, 3, 38);
      // The jumper cap itself is the flag — no plate, no pole, no second thing
      // on the same post fighting it for the identity (3D `buildCheckpoint`
      // took the same decision when the demo tried adding a board to it).
      gfx.fillStyle(color, 1);
      gfx.fillRoundedRect(x - 14, y - 46, 19, 15, 2);
      gfx.fillRect(x - 15, y - 50, 21, 4);
    },

    // No `drawAircraft`: this world has no aircraft in either demo, and the
    // hook is opt-in precisely so a world can decline. `phaser2d-scene` skips
    // the whole finish-airship pass when it is missing.

    // ── Wind particles ──

    getWindParticleColor() {
      return SOLDER;
    },

    getWindParticleAlpha() {
      return 0.45;
    },
  };
}
