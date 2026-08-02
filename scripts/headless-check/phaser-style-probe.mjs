/**
 * Headless CPU preview for the GAME's Phaser 2D styles —
 * `packages/web/src/game/phaser/{plastic,cuphead}-style.ts`.
 *
 * `phaser-probe.mjs` does this for the standalone `plan/phaser-*-demo.html`
 * files. This one skips the demos and drives the SHIPPING strategy objects
 * (`PhaserStyleStrategy`) through a stubbed Phaser `Graphics`, then rasterises
 * the recorded commands into one labelled grid — so a whole vocabulary (every
 * land-use zone × several box sizes) is a single PNG instead of six browser
 * sessions and a lot of squinting.
 *
 * Three agents in a row hand-rolled this harness to look at their own work
 * (`plan/migrate-demo-worlds.md` §3.11). This is that harness, kept.
 *
 * ── Invocation ──
 *
 *   STYLE=plastic WHAT=building OUT_DIR=/tmp node --no-warnings \
 *     --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/phaser-style-probe.mjs
 *
 *   STYLE     any key of WORLD_OPTIONS (plastic | cuphead |
 *             circuit | …)                                   (default plastic)
 *   WHAT      building | tree | lamp | cloud | flag          (default building)
 *   SIZES     building boxes, "WxH,WxH,…" in NOMINAL px      (default 5 sizes)
 *   ZONES     building zones, comma list, `null` for unzoned (default all six)
 *   SEED      base seed; change it to reshuffle every case   (default 0)
 *   NIGHT     1 → night sky + veil + the additive lights     (default 0)
 *   VEIL      0 → NIGHT=1 without the world veil: the pre-
 *             option-D composite, the state the styles' old
 *             compensations were tuned against               (default 1)
 *   LIGHTS    auto | grid — `grid` forces terrain-builder's
 *             FALLBACK window grid even on a style that has
 *             declared its own lights, which is the only way
 *             to see where the grid would land               (default auto)
 *   BOXES     0 → drop the three extent overlays, for when
 *             you are reading the ART and not the geometry   (default 1)
 *   MAX_SLACK px of reported-beyond-drawn to tolerate before
 *             the run FAILS (exit 1). Unset → report only.
 *   OUT_DIR   where the PNG lands                            (default /tmp)
 *
 * Adding a method is a couple of lines: append an entry to `WHATS` below. A
 * case is `{ label, draw(gfx, ax, ay), night?(gfx, ax, ay, out) }` where
 * `(ax, ay)` is the cell's anchor — horizontal centre, ground line. `draw`'s
 * return value optionally declares `{ nominal, reported }`: the box the style
 * was ASKED for, and the `DrawnBox` it REPORTED filling. `night` draws onto the
 * cell's second, ADD-blended Graphics and is only called under `NIGHT=1`.
 *
 * ── What it models ──
 *
 * - Every `Graphics` call the two styles make (`fillRect`, `fillTriangle`,
 *   `fillCircle`, `fillEllipse`, `fillPoints`, `fillPath`, `fillRoundedRect`,
 *   `lineBetween`, `strokeRect`, `strokeCircle`, `strokeEllipse`,
 *   `strokeTriangle`, `strokePoints`, `strokePath`, `arc`, `slice`) — see
 *   `phaser-stub.mjs` for the stub itself and the full list of what it fakes.
 * - `setDepth` ordering WITHIN one case (each case gets its own Graphics; the
 *   commands are sorted by depth then call order before rasterising).
 * - Per-case draw cost, and THREE extents: the NOMINAL box the style was handed
 *   (blue dashes), the `DrawnBox` it REPORTED (solid green), and the bounds its
 *   commands actually covered (pink dashes). See "the extent check" below.
 * - Under `NIGHT=1`, `terrain-builder`'s night layer: a second Graphics per
 *   cell driven by `renderBuildingLights?.()`, composited ADD at
 *   `nightLightAlpha(1)` = 0.9 over the VEILED day frame (see caveat 5).
 *   Including its three-way fallback — hook declared → the style owns the
 *   layer; declared and nothing drawn → a real "this building has no lights";
 *   omitted → the generic warm-window grid over the REPORTED extent.
 * - Anything NOT stubbed is counted by name and printed. Nothing silently
 *   no-ops.
 *
 * ── The extent check (what `MAX_SLACK` guards) ──
 *
 * `renderBuilding` returns the solid mass it drew. Anything that lays something
 * ON a building — the fallback window grid, and whatever comes next — trusts
 * that number, so a style that LIES about it puts glows in the sky above a
 * short body. That is `plan/migrate-demo-worlds.md` §3.8, and it is the bug this
 * probe exists to make visible.
 *
 * Two directions, and they are not symmetric:
 *
 *   SPILL  art outside the reported box. EXPECTED and harmless — `DrawnBox` is
 *          the solid mass, and studs, 4 px neon strokes and wobbled ink
 *          outlines all overshoot it by a px or two, by that type's own
 *          documentation.
 *   SLACK  reported box outside the art. The DANGEROUS one: the style claimed
 *          space it never filled, so anything laid over that extent floats.
 *
 * Both are printed per case; only SLACK is failable, and only against a
 * threshold you pass in. The number to beat is §3.8's measured 4.1 px.
 *
 * Reading the overlay: reported is drawn LAST and solid, so a green box sitting
 * exactly on the pink one HIDES it, and that is the good case — the style
 * reported precisely what it drew. Where the two separate you are looking at the
 * error. The blue box is separate information: how far the style moved from what
 * it was asked for, which is large by design in both worlds (plastic's school
 * reports 106 × 40 against a 40 × 84 nominal, and the old grid painted the blue
 * box — 44 px of glow in the sky above the building).
 *
 * ── What it does NOT model — read this before concluding anything ──
 *
 * 1. **It is not Phaser.** No WebGL batcher, no camera scroll/zoom (the
 *    transform is identity), no antialiasing, no premultiplied alpha. The rest
 *    of the list is in `phaser-stub.mjs`'s header — strokes are quads,
 *    `fillRoundedRect` is a 12-segment polygon, `strokeCircle` /
 *    `strokeEllipse` are annular bands, sub-paths do not exist.
 * 2. **The night layer's ADD is not Phaser's ADD.** `NIGHT=1` composites
 *    `dst + src×a` clamped to 8 bits after every command; Phaser adds
 *    premultiplied floats in the GPU blend unit. Overlapping glows therefore
 *    saturate SOONER here — the clamp errs toward "this clipped to white", so a
 *    glow that survives here survives in game, and one that blows out here is
 *    worth a second look rather than an automatic retune.
 * 3. **No bloom, no post pipeline, no tone mapping.** Nothing spreads light
 *    past the geometry that emitted it. A mark that reads in game ONLY because
 *    bloom smeared it will look meaner here than it is; the 2D scene has no
 *    bloom either, which is why this is a smaller lie for the Phaser worlds
 *    than it would be for the three.js ones.
 * 4. **The night sky is flat.** The game draws a vertical gradient (top →
 *    bottom); this fills with `getSkyColors(-20, 'sunny').bottom`, the horizon
 *    band, because that is the colour the buildings actually stand against.
 * 5. **The day layer IS veiled at night and the lights layer is NOT — that is
 *    the game's compositing, reproduced.** Since option D
 *    (plan/phaser-2d-lighting.md) the glasses pipeline mixes the whole
 *    main-camera frame toward the world's veil colour (`night-grade.ts`), and
 *    the chunks' additive lights render on a second, pipeline-free camera
 *    ABOVE that veil. This probe does the identical arithmetic — the
 *    `veiledChannel` mix over the whole frame between the day pass and the
 *    ADD pass — and nothing else of the pipeline: no lens tint, no contrast,
 *    no vignette, no distortion, no tunnel blur. `VEIL=0` drops the veil to
 *    reproduce the pre-option-D composite, the surface plastic's 2.2× letter
 *    rim and 0.5-alpha clay window were originally tuned against. One known
 *    detail: `WHAT=lamp`'s glow row rides above the veil here AND in game —
 *    terrain-builder adopts the lamp's glowGfx into the lights camera the
 *    same way it adopts the chunk window layer, matching the demos' glow-
 *    over-veil depths. What this row still does not show: in game that glow
 *    is always-on and alpha-pulses 0.55–1.0, and by day it rides above the
 *    lens tint and distortion too.
 * 6. **No text.** `getMarkerFont()` and any `Phaser.Text` the scene pins over
 *    a strategy's art (the airship banner readout) do not exist here.
 * 7. Cell labels are drawn from `SIGN_GLYPHS` — the game's own stroke font, per
 *    CUSTOM_WORLD_INSTRUCTIONS §3.7 — so they are UPPERCASE A–Z 0–9 only.
 *
 * ── Two counts, and which one the code comments quote ──
 *
 * `prims` is raster primitives AFTER the stub's decomposition; it is what
 * `phaser-probe.mjs` prints as "draw commands", and it is the convention the
 * numbers already written into `plastic-style.ts`'s `renderBuilding` comment
 * use (tetromino 21 → 205). `api` is the number of geometry-producing
 * `Graphics` method calls, which is closer to what Phaser's own command buffer
 * sees. `state` counts `fillStyle`/`lineStyle`. On the N100 target the 2D world
 * is CPU-bound, so all three are worth watching; `prims` is the comparable one.
 *
 * ── Shared code ──
 *
 * `writePng` comes from `mini-raster.ts`, which exists so there is exactly ONE
 * PNG encoder. The Phaser `Graphics` stub and the scanline filler come from
 * `phaser-stub.mjs`, which exists so there is exactly ONE of those too: they
 * used to be inlined here AND in `phaser-probe.mjs`, and the two copies had
 * already drifted in six places. Two rasterisers that disagree is the failure
 * `mini-raster.ts` was extracted to prevent — do not re-inline either.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writePng } from './mini-raster.ts';
import { Sink, makeGraphics, makeCanvasCtx, createRaster, rgb, unstubbedReport } from './phaser-stub.mjs';
import { SIGN_GLYPHS } from '@/game/terrain/sign-spec';
import { nightLightAlpha, nightVeilAmount, nightVeilRgb } from '@/game/phaser/night-grade';

// ── env ──────────────────────────────────────────────────────────────────────

const env = (k, d) => process.env[k] ?? d;
const STYLE = env('STYLE', 'plastic');
const WHAT = env('WHAT', 'building');
const OUT_DIR = env('OUT_DIR', '/tmp');
const SEED0 = Number(env('SEED', '0'));
const NIGHT = env('NIGHT', '0') === '1';
const VEIL = env('VEIL', '1') !== '0';
const BOXES = env('BOXES', '1') !== '0';
const LIGHTS = env('LIGHTS', 'auto');
if (LIGHTS !== 'auto' && LIGHTS !== 'grid') throw new Error(`LIGHTS must be auto|grid, got "${LIGHTS}"`);
/** Unset → measure and print only; set → also fail the run. */
const MAX_SLACK = process.env.MAX_SLACK === undefined ? null : Number(process.env.MAX_SLACK);
if (MAX_SLACK !== null && !(MAX_SLACK >= 0)) throw new Error(`MAX_SLACK must be a number >= 0, got "${process.env.MAX_SLACK}"`);

/**
 * The chunk lights layer's alpha at full night. Imported, not mirrored: the
 * curve moved into engine-free `night-grade.ts` precisely so this probe could
 * stop hand-copying it (plan/phaser-2d-lighting.md §3.5). Same import gives
 * the veil the shader applies, so the two cannot drift from the game here.
 */
const NIGHT_LAYER_ALPHA = nightLightAlpha(1);

/** Deep night, clear — past astronomical twilight, so both styles' sky ramps
 *  have bottomed out and the colour is the one they hold all night. */
const NIGHT_SUN_ELEVATION = -20;

/** The layout grid, 24 px, because the plastic style snaps its bodies to it
 *  (`gridBox` in plastic-style.ts rounds the ground line to 24 and sizes
 *  bodies in half-bricks of 12). Ground lines land on multiples of TILE so a
 *  body's snapped height is the one the game would draw, not an artefact of
 *  where this probe put the cell. `cellW` must stay a multiple of TILE for
 *  the same reason (checked below). */
const TILE = 24;
const GUTTER = 120;   // 5 tiles — row labels live here
const HEADER = 72;    // 3 tiles
const PAD = 24;       // 1 tile of ground below the baseline
const LABEL_H = 24;   // two label lines at the top of every cell

// ── raster target ────────────────────────────────────────────────────────────
//
// The image size falls out of the layout pass below, so the raster is created
// late; every drawing helper here goes through `R`, which is null until then.

let R = null;
const strokeQuad = (...a) => R.strokeQuad(...a);

/**
 * Rasterise one case's recorded commands, offset by (0, dy), clipped to `clip`.
 *
 * `layerAlpha` is the whole LAYER's alpha, the way Phaser's `setAlpha` on a
 * Graphics multiplies everything drawn into it — that is how the night layer's
 * 0.9 arrives, and it must not be folded into the per-command alphas, because
 * those are the style's own tuning and get read back out in the report.
 */
function rasterCase(cmds, dy, clip, layerAlpha = 1) {
  const sorted = cmds.slice().sort((p, q) => (p.depth - q.depth) || (p.seq - q.seq));
  for (const c of sorted) {
    const col = rgb(c.col);
    // The alpha the Graphics had when the command was recorded — a case is drawn
    // once and never tweened afterwards, unlike the demo scenes.
    const a = c.a * (c.ga ?? 1) * layerAlpha;
    if (c.t === 'poly') R.fillPoly(c.pts.map(([x, y]) => [x, y + dy]), col, a, clip);
    else if (c.t === 'line') R.strokeQuad(c.x1, c.y1 + dy, c.x2, c.y2 + dy, c.w, col, a, clip);
    else if (c.t === 'circ') R.fillDisc(c.x, c.y + dy, c.rx, c.ry, col, a, clip);
    else if (c.t === 'ring') R.fillDisc(c.x, c.y + dy, c.rx, c.ry, col, a, clip, c.w);
  }
}

/** Bounds of a case's art, in the coordinates it was drawn in. */
function boundsOf(cmds) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
  for (const c of cmds) {
    if (c.t === 'poly') for (const p of c.pts) add(p[0], p[1]);
    else if (c.t === 'line') {
      const hw = Math.max(0.5, c.w / 2);
      add(Math.min(c.x1, c.x2) - hw, Math.min(c.y1, c.y2) - hw);
      add(Math.max(c.x1, c.x2) + hw, Math.max(c.y1, c.y2) + hw);
    } else {
      const e = c.t === 'ring' ? Math.max(1, c.w) / 2 : 0;
      add(c.x - c.rx - e, c.y - c.ry - e); add(c.x + c.rx + e, c.y + c.ry + e);
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/**
 * Reported `DrawnBox` vs the bounds the art actually covered.
 *
 * `slack` is the worst SIDE on which the reported box sticks out past the art —
 * the style asked for space it did not fill, and anything laid over that extent
 * floats there (§3.8). `spill` is the worst side on which the art sticks out
 * past the reported box, which `DrawnBox` explicitly sanctions ("the SOLID
 * MASS, not a raster bounding box … tolerate a couple of px").
 *
 * Per-side maxima, not the difference of the widths: a box the right SIZE in
 * the wrong PLACE has zero width error and is just as wrong.
 */
function extentDelta(reported, measured) {
  if (!reported || !measured) return null;
  const rx1 = reported.x + reported.w, ry1 = reported.y + reported.h;
  const slack = Math.max(
    measured.x0 - reported.x, measured.y0 - reported.y,
    rx1 - measured.x1, ry1 - measured.y1, 0,
  );
  const spill = Math.max(
    reported.x - measured.x0, reported.y - measured.y0,
    measured.x1 - rx1, measured.y1 - ry1, 0,
  );
  return { slack, spill };
}

/**
 * `terrain-builder`'s FALLBACK window grid, for a style that has not declared
 * `renderBuildingLights`. A MIRROR of the loop in `terrain-builder.renderBuilding`
 * (the `if (this.strategy.renderBuildingLights) … return;` branch's else) — that
 * one is a private method on a class that constructs Phaser objects, so it
 * cannot be imported. Keep the two in step; the constants are `gap = 6`,
 * `size = 2.4`, `0xffdd88 @ 0.9`, and the same `sin(…)*43758.5453` hash at 0.42.
 *
 * Cost is LINEAR in the box height, which is the reason both shipping styles
 * have moved off it.
 */
function genericWindowGrid(gfx, ex, ey, ew, eh) {
  const gap = 6, size = 2.4;
  gfx.fillStyle(0xffdd88, 0.9);
  for (let wy = ey + 5; wy < ey + eh - 4; wy += gap) {
    for (let wx = ex + 4; wx < ex + ew - 4; wx += gap) {
      const r = Math.sin(wx * 12.9898 + wy * 78.233) * 43758.5453;
      if (r - Math.floor(r) >= 0.42) continue;
      gfx.fillCircle(wx, wy, size);
    }
  }
}

// ── labels: the game's own stroke font (no system fonts — §3.7) ──────────────

function drawText(text, x, y, size, col, a = 1) {
  const gw = size * 0.62, adv = size * 0.78, lw = Math.max(1, size / 8);
  let cx = x;
  for (const raw of text.toUpperCase()) {
    if (raw === ' ') { cx += adv * 0.7; continue; }
    if (raw === '-') { strokeQuad(cx + gw * 0.1, y + size * 0.55, cx + gw * 0.9, y + size * 0.55, lw, col, a); cx += adv; continue; }
    const segs = SIGN_GLYPHS[raw];
    if (!segs) { strokeQuad(cx, y + size, cx + gw, y + size, lw, col, a); cx += adv; continue; }
    for (const [sx, sy, ex, ey] of segs) {
      strokeQuad(cx + sx * gw, y + sy * size, cx + ex * gw, y + ey * size, lw, col, a);
    }
    cx += adv;
  }
  return cx;
}

function dashLine(x1, y1, x2, y2, col, a, dash = 4) {
  const L = Math.hypot(x2 - x1, y2 - y1) || 1;
  for (let d = 0; d < L; d += dash * 2) {
    const t0 = d / L, t1 = Math.min(1, (d + dash) / L);
    strokeQuad(x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0, x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1, 1, col, a);
  }
}
function dashRect(x, y, w, h, col, a, dash = 4) {
  dashLine(x, y, x + w, y, col, a, dash); dashLine(x + w, y, x + w, y + h, col, a, dash);
  dashLine(x + w, y + h, x, y + h, col, a, dash); dashLine(x, y + h, x, y, col, a, dash);
}
function solidRect(x, y, w, h, col, a) {
  strokeQuad(x, y, x + w, y, 1, col, a); strokeQuad(x + w, y, x + w, y + h, 1, col, a);
  strokeQuad(x + w, y + h, x, y + h, 1, col, a); strokeQuad(x, y + h, x, y, 1, col, a);
}

// ── the strategy ─────────────────────────────────────────────────────────────

const { createStyleStrategy } = await import('@/game/phaser/phaser-style-strategy');
// The accepted set comes from WORLD_OPTIONS, not from a list written here: a
// third world had to edit this line to be able to look at itself, which is one
// edit too many for the tool that is supposed to be how you SEE a new world.
const { WORLD_OPTIONS } = await import('../../packages/shared/src/world-options.ts');
const STYLES = Object.keys(WORLD_OPTIONS);
if (!STYLES.includes(STYLE)) throw new Error(`STYLE must be one of ${STYLES.join('|')}, got "${STYLE}"`);

/**
 * `STYLE_MODULE` — drive a style module that is NOT the one in the tree.
 *
 * The point is BEFORE/AFTER. A port's only honest cost claim is the same probe,
 * same WHAT, same seeds, run against the old file and the new one; without this
 * the "before" number has to be copied out of an old commit message and
 * silently stops being comparable the moment a case list changes.
 *
 * Point it at a file (`git show HEAD:…/plastic-style.ts > /tmp/old.ts`) and it
 * imports that instead. The `@/…` specifiers inside the old file still resolve,
 * because `register.mjs`'s alias hook is process-wide and does not care where
 * the importer lives. `STYLE` still selects the FACTORY name and the palette
 * conventions, so the two runs are the same code path in every other respect.
 */
const STYLE_MODULE = process.env.STYLE_MODULE;
const FACTORY = { plastic: 'createPlasticStyle', cuphead: 'createCupheadStyle', circuit: 'createCircuitStyle' };
const styleModule = STYLE_MODULE
  ? await import(pathToFileURL(resolve(STYLE_MODULE)).href)
  : null;
const strategy = styleModule ? styleModule[FACTORY[STYLE]]() : await createStyleStrategy(STYLE);
const PAL = strategy.palette;

/**
 * The palette as it stands BEFORE any paint switch.
 *
 * ONE case uses it: `flag`. The game never passes `palette.markerTick` to
 * `drawFlag` — its flag colours are the scene's own constants (START green,
 * FINISH red, a workout flag's own colour), and `markerTick` only ever reaches
 * `markerGfx` directly. So the argument here is standing in for a colour from
 * OUTSIDE the palette's mapped set, and reading the live table under `PAINT=0`
 * would hand a style its own bare-mode output to map a second time — which is
 * not idempotent (`plainHex(0x8a6b42)` is two bands up) and would make this cell
 * a picture of a bug that the game does not have.
 *
 * `mountain` deliberately does NOT use this — see the comment there.
 *
 * In painted mode it is a copy of the same numbers, so nothing moves.
 */
const PAL_ARGS = { ...PAL };

/**
 * `PAINT=0` — the corrugated world's BARE BOARD mode
 * (`cuphead-style.setCupheadPaintMode`).
 *
 * Here rather than in a separate tool because the whole claim about that switch
 * is a claim about the drawing: painted must be pixel-for-pixel what it was
 * before the switch existed, and bare must be the same picture in kraft. One
 * probe, one env var, and both halves are one `diff` apart.
 */
const PAINT = env('PAINT', '1');
if (PAINT !== '0' && PAINT !== '1' && PAINT !== 'cycle') {
  throw new Error(`PAINT must be 0|1|cycle, got "${PAINT}"`);
}
if (PAINT !== '1') {
  const mod = styleModule ?? await import('@/game/phaser/cuphead-style');
  if (typeof mod.setCupheadPaintMode !== 'function') {
    throw new Error(`PAINT=${PAINT} needs setCupheadPaintMode; STYLE=${STYLE} has none`);
  }
  mod.setCupheadPaintMode(false);
  // `cycle` — go bare and come straight back. The output must then be
  // BYTE-IDENTICAL to a plain painted run.
  //
  // It is a separate mode because the switch rewrites a LIVE table in place
  // (`applyPaintMode`, the demo's own mechanism), and a rewrite that does not
  // restore leaves the world permanently kraft'd the moment the rider opens the
  // option panel and closes it again. Nothing that only ever goes ONE way can
  // see that, which is why `PAINT=0` alone was not enough.
  if (PAINT === 'cycle') mod.setCupheadPaintMode(true);
}

// ── what to exercise ─────────────────────────────────────────────────────────

const ZONES_ALL = ['residential', 'commercial', 'industrial', 'school', 'hospital', null];
const SIZES_DEFAULT = '15x10,15x19,17x29,29x48,40x84';

/**
 * Every entry returns `{ cellW, rows }`, `rows` being
 * `[{ label, cells: [{ label, draw(gfx, ax, ay) }] }]`.
 *
 * `(ax, ay)` is the cell anchor: horizontal centre, ground line. `draw` may
 * return `{ nominal: {x, y, w, h} }` to have the requested box outlined against
 * what actually came out.
 */
const WHATS = {
  /**
   * The one everybody has needed. Every zone × several boxes, small sizes
   * first, because a street is made of the small ones: the default OSM height
   * of 8 m lands on a 15 × 19 px nominal box, which plastic's `gridBox` now
   * covers in half-bricks as 24 × 24. It used to flatten EVERY small
   * footprint to 24 × 48 — the mismatch §3.8 / §3.12 of
   * plan/migrate-demo-worlds.md are about, and this grid is where it was
   * caught. The dashed overlay is the evidence either way.
   */
  building: () => {
    const zones = (process.env.ZONES ? process.env.ZONES.split(',') : ZONES_ALL)
      .map((z) => (z === 'null' || z === '' || z === null ? null : z.trim()));
    const sizes = env('SIZES', SIZES_DEFAULT).split(',').map((s) => {
      const [w, h] = s.trim().toLowerCase().split('x').map(Number);
      if (!(w > 0 && h > 0)) throw new Error(`bad SIZES entry "${s}" — want WxH`);
      return { w, h };
    });
    return {
      cellW: 144,
      rows: zones.map((zone, r) => ({
        label: zone ?? 'unzoned',
        cells: sizes.map(({ w, h }, c) => {
          // Hoisted out of `draw`, because `night` has to hand the strategy the
          // IDENTICAL (seed, colorIndex, zone, box). That is the whole contract
          // of `renderBuildingLights`: it re-derives which body was drawn from
          // those arguments, so one different number and it lights a building
          // that is not the one standing there.
          const seed = SEED0 + r * 13 + c * 101;
          const colorIndex = seed % PAL.buildingColors.length;
          return {
            label: `${w}X${h}`,
            draw(gfx, ax, ay) {
              // Mirrors terrain-builder.renderBuilding exactly: the footprint is
              // centred on its world X and its base sits on the ground line.
              const x = ax - w / 2, y = ay - h;
              const reported = strategy.renderBuilding(gfx, x, y, w, h, colorIndex, seed, zone);
              return { nominal: { x, y, w, h }, reported: reported ?? null };
            },
            /** `terrain-builder`'s three-way, in its order. */
            night(gfx, ax, ay, out) {
              const { x, y } = out.nominal;
              if (LIGHTS === 'auto' && strategy.renderBuildingLights) {
                strategy.renderBuildingLights(gfx, x, y, w, h, colorIndex, seed, zone);
                // Drawing nothing here is a REAL answer ("this building has no
                // lights"), which is why the path is reported separately from
                // the prim count — 0 prims on `style` and 0 prims on `grid` mean
                // opposite things.
                return 'style';
              }
              // Over the REPORTED extent, falling back to the nominal box when
              // the style reported nothing — exactly what terrain-builder does,
              // and the half of §3.8 that is still reachable.
              const e = out.reported ?? out.nominal;
              genericWindowGrid(gfx, e.x, e.y, e.w, e.h);
              return 'grid';
            },
          };
        }),
      })),
    };
  },

  tree: () => ({
    cellW: 120,
    rows: [{
      label: 'tree',
      cells: Array.from({ length: 8 }, (_, i) => ({
        label: `SEED ${SEED0 + i}`,
        draw(gfx, ax, ay) { strategy.renderTree(gfx, ax, ay, 0, SEED0 + i); },
      })),
    }],
  }),

  /** In game the pole and the glow are two layers, the glow additive and
   *  alpha-tweened by the night factor. `NIGHT=1` reproduces that. Without it
   *  the glow is drawn onto the DAY Graphics instead — source-over, no night
   *  factor — because a glow row that renders empty by day is less useful than
   *  one that is honestly labelled as geometry-only. */
  lamp: () => ({
    cellW: 120,
    rows: [
      { label: 'post', cells: lampCells(false) },
      { label: 'post+glow', cells: lampCells(true) },
    ],
  }),

  cloud: () => ({
    cellW: 168,
    rows: [{
      label: 'cloud',
      cells: Array.from({ length: 6 }, (_, i) => ({
        label: `SEED ${SEED0 + i}`,
        draw(gfx, ax, ay) { strategy.drawCloud(gfx, ax, ay - 40, 110, 46, SEED0 + i); },
      })),
    }],
  }),

  /**
   * The PALETTE ITSELF — every entry the strategy hands the scene, as a swatch,
   * drawn straight onto a `Graphics` with no strategy method in between.
   *
   * That is exactly how the scene uses it: `phaser-weather`'s fog wash,
   * `phaser2d-scene`'s water shimmer and km ticks all read `strategy.palette.*`
   * and fill with it themselves. So this is the only case here that can see a
   * style whose TABLE is wrong rather than whose DRAWING is wrong — and a paint
   * mode is precisely a change to the table.
   *
   * Read together with `PAINT`:
   *   PAINT=1      the painted table
   *   PAINT=0      the bare one — every entry the scene draws with itself must
   *                have moved onto `KRAFT_RAMP`, and the three the scene hands
   *                back to a strategy method must NOT have
   *                (`PALETTE_KEEPS_PAINTED`)
   *   PAINT=cycle  must be byte-identical to PAINT=1
   *
   * Array entries are expanded one swatch per element, because the arrays are
   * rewritten IN PLACE (the demo's `arr()`) and a copy-instead-of-rewrite is
   * invisible from anything that only asks for `.length`.
   */
  palette: () => {
    const entries = [];
    for (const [k, v] of Object.entries(PAL)) {
      if (Array.isArray(v)) v.forEach((c, i) => entries.push([k + i, c]));
      else entries.push([k, v]);
    }
    const PER_ROW = 8;
    const rows = [];
    for (let i = 0; i < entries.length; i += PER_ROW) {
      rows.push({
        label: String(i),
        cells: entries.slice(i, i + PER_ROW).map(([k, c]) => ({
          label: k.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 11),
          draw(gfx, ax, ay) {
            gfx.fillStyle(c, 1);
            gfx.fillRect(ax - 40, ay - 56, 80, 56);
          },
        })),
      });
    }
    return { cellW: 96, rows };
  },

  flag: () => ({
    cellW: 144,
    rows: [{
      label: 'flag',
      cells: Array.from({ length: 5 }, (_, i) => ({
        label: `KM ${i + 1}`,
        // PAL_ARGS, not PAL: the colour is an ARGUMENT to a strategy method.
        draw(gfx, ax, ay) { strategy.drawFlag(gfx, ax, ay, PAL_ARGS.markerTick, String(i + 1), SEED0 + i); },
      })),
    }],
  }),

  /**
   * The GROUND — `drawTerrainSurface`, plus the district band `renderUrban`
   * lays on it.
   *
   * The one WHAT whose cost does not fit in a cell: this hook is handed the
   * whole visible surface at once and its price is `columns × visible depth`,
   * which is the shape both worlds' terrains have and the thing a port of one
   * has to be able to see. So a cell here is a WIDE strip of ground rather than
   * a single object, and the labels say which profile.
   *
   * Depths are 24 / 96 / 240 px of ground below the surface — flat riding, a
   * normal descent, and the bottom of a valley with the camera-lift zoomed out.
   * A style whose terrain is linear in depth shows it as a straight line down
   * the `prims` column; one that caps it does not.
   */
  terrain: () => {
    const SPAN = 384;                 // 16 tiles of ground per cell
    const PROFILES = [
      { label: 'FLAT', at: () => 0 },
      { label: 'SLOPE', at: (t) => -t * 60 },
      // A ridge, so the per-column snap has a step in both directions to land on.
      { label: 'RIDGE', at: (t) => -Math.sin(t * Math.PI) * 72 },
    ];
    const DEPTHS = [24, 96, 240];
    return {
      cellW: SPAN + 24,
      rows: [
        ...DEPTHS.map((depth) => ({
          label: `DEPTH ${depth}`,
          cells: PROFILES.map((p) => ({
            label: p.label,
            draw(gfx, ax, ay) {
              const x0 = ax - SPAN / 2;
              const points = [];
              for (let i = 0; i <= 32; i++) {
                const t = i / 32;
                points.push({ x: x0 + t * SPAN, y: ay + p.at(t) });
              }
              strategy.drawTerrainSurface(gfx, points, ay + depth, SEED0, undefined);
              // The district band, on the same ground — `terrain-builder` draws
              // it into the CHUNK graphics, but it lands on this surface and the
              // two are only judgeable together (does the colour eat the studs?).
              const zone = ['residential', 'commercial', 'industrial'][DEPTHS.indexOf(depth)];
              strategy.renderUrban(gfx, ax, ay, 60, 5, SEED0, zone);
            },
          })),
        })),
        // ── The ZONED board ──
        //
        // `drawTerrainSurface`'s `zones` argument: the district at each sample,
        // parallel to `points`. It exists because the circuit world signals its
        // zoning WITH THE SOLDER MASK — its demo re-colours the board segment by
        // segment and drops a silkscreen line down the full board thickness at
        // every boundary, and a 60 px `renderUrban` strip cannot say that.
        //
        // All six values in one strip, in `ZONES_ALL` order, so every entry of a
        // style's zone table is drawn AND five boundaries are exercised — the
        // trailing null is the state a real route spends most of its length in,
        // and a style must draw it exactly as it drew the rows above.
        //
        // `DEPTH 96` above is the CONTROL, and deliberately an exact one: this
        // row is that row with `zones` added and nothing else changed, down to
        // the `renderUrban` call and its district. So a style that ignores the
        // argument must come out with the IDENTICAL prim/api/state counts, and a
        // style that honours it shows its whole cost as the difference.
        {
          label: 'ZONED 96',
          cells: PROFILES.map((p) => ({
            label: p.label,
            draw(gfx, ax, ay) {
              const x0 = ax - SPAN / 2;
              const points = [];
              const zones = [];
              for (let i = 0; i <= 32; i++) {
                const t = i / 32;
                points.push({ x: x0 + t * SPAN, y: ay + p.at(t) });
                zones.push(ZONES_ALL[Math.min(ZONES_ALL.length - 1, Math.floor(i / 6))]);
              }
              strategy.drawTerrainSurface(gfx, points, ay + 96, SEED0, undefined, zones);
              strategy.renderUrban(gfx, ax, ay, 60, 5, SEED0, ZONES_ALL[DEPTHS.indexOf(96)]);
            },
          })),
        },
      ],
    };
  },

  /**
   * The two parallax mountain layers, at the sizes `phaser-weather` really asks
   * for.
   *
   * Its numbers, not invented ones: `farW = w / 0.1`, `nearW = w / 0.3`,
   * `farBaseY = skyH * 0.85`, `nearBaseY = skyH * 0.92`, and the caller's own
   * aerial-perspective dim (far ×0.8, near ×0.95 toward black). That width is
   * the whole reason this case exists — a per-column mountain treatment costs
   * ten screens' worth on the far layer and one screen's worth in a demo, and
   * nothing but the real width shows it.
   *
   * `CANVAS_W` is what the layer is sized against; the cell only SHOWS the first
   * `cellW` of it, which is honest — that is what fits on screen at a time — and
   * the `prims` column reports the whole layer.
   */
  mountain: () => {
    const CANVAS_W = 1280, SKY_H = 540;
    const LAYERS = [
      { label: 'FAR', layer: 'far', w: CANVAS_W / 0.1, base: 0.85, dim: 0.2, seed: 0 },
      { label: 'NEAR', layer: 'near', w: CANVAS_W / 0.3, base: 0.92, dim: 0.05, seed: 999 },
    ];
    return {
      cellW: 456,
      rows: LAYERS.map((L) => ({
        label: L.label,
        cells: Array.from({ length: 2 }, (_, i) => ({
          label: `SEED ${SEED0 + i}`,
          draw(gfx, ax, ay) {
            const baseY = ay - SKY_H + SKY_H * L.base;
            const pts = strategy.generateMountainPoints(
              baseY, SKY_H, L.w, L.layer, SEED0 + i + L.seed);
            // The LIVE palette on purpose. `phaser-weather.drawParallax` reads
            // `strategy.palette.mountainFar` on every redraw — i.e. AFTER any
            // paint switch — and hands it to `drawMountainSilhouette`, which is
            // where a bare mode maps colours. So this is the one case that can
            // see a style mapping the same colour twice, which is exactly what
            // `PALETTE_KEEPS_PAINTED` in cuphead-style.ts exists to prevent.
            const base = L.layer === 'far' ? PAL.mountainFar : PAL.mountainNear;
            const col = mixToBlack(base, L.dim);
            // Drawn at the cell's own X: the layer is generated at 0…w and the
            // caller positions it, so translating is what the game does too.
            const shifted = pts.map((p) => ({ x: p.x + ax - 200, y: p.y }));
            strategy.drawMountainSilhouette(gfx, shifted, col, ay, L.layer === 'far' ? 0 : 1);
          },
        })),
      })),
    };
  },

  /**
   * The rider — `generateCyclistFrame`, all six frames of every pose.
   *
   * It is the only style method that draws into a canvas 2D context instead of
   * a `Graphics`, so it goes through `makeCanvasCtx` (`phaser-stub.mjs`) rather
   * than `makeGraphics`. Same recorder underneath, so its commands land in the
   * same grid and count the same way — which matters, because this sprite is
   * BAKED once and its cost is texture memory, not frame time. What the grid is
   * for is seeing that the demo's rig survived: the six frames must differ, and
   * nothing may be clipped by the frame box (the toy world's helmet stud is one
   * px from the top of it).
   */
  cyclist: () => {
    const { w, h } = strategy.getCyclistFrameSize();
    const POSES = ['normal', 'standing', 'aero', 'sprint'];
    const PARAMS = {
      normal: { torsoAngle: 35, hipOffsetY: 0, headTilt: 0, rockAmplitude: 0 },
      standing: { torsoAngle: 15, hipOffsetY: 4, headTilt: 1, rockAmplitude: 1.5 },
      aero: { torsoAngle: 55, hipOffsetY: 0, headTilt: -2, rockAmplitude: 0 },
      sprint: { torsoAngle: 45, hipOffsetY: 2, headTilt: -1, rockAmplitude: 2.5 },
    };
    return {
      cellW: Math.ceil((w + 24) / TILE) * TILE,
      rows: POSES.map((pose) => ({
        label: pose.toUpperCase(),
        cells: Array.from({ length: 6 }, (_, f) => ({
          label: `F${f}`,
          draw(gfx, ax, ay) {
            // The sprite is baked in FRAME coordinates (0,0 = frame top-left);
            // the ctx translation puts the frame where the cell's ground line
            // is, so the nominal box below IS the sprite's own frame and any
            // clipping shows as art leaving the blue outline.
            const ctx = makeCanvasCtx(gfx, ax - w / 2, ay - h);
            strategy.generateCyclistFrame(ctx, 0, f, pose, PARAMS[pose]);
            return { nominal: { x: ax - w / 2, y: ay - h, w, h } };
          },
        })),
      })),
    };
  },
};

/** `lerpColor(c, 0x000000, k)` — `phaser-weather`'s aerial-perspective dim,
 *  reproduced so the mountain case is handed the colour the game hands it. */
function mixToBlack(c, k) {
  const m = (v) => Math.round(v * (1 - k));
  return (m((c >> 16) & 0xff) << 16) | (m((c >> 8) & 0xff) << 8) | m(c & 0xff);
}

function lampCells(glow) {
  return Array.from({ length: 5 }, (_, i) => ({
    label: `SEED ${SEED0 + i}`,
    draw(gfx, ax, ay) {
      strategy.renderRoadLamp(gfx, ax, ay, SEED0 + i);
      if (glow && !NIGHT) strategy.renderRoadLampGlow(gfx, ax, ay, SEED0 + i);
    },
    night(gfx, ax, ay) {
      if (!glow) return 'style';
      strategy.renderRoadLampGlow(gfx, ax, ay, SEED0 + i);
      return 'style';
    },
  }));
}

const build = WHATS[WHAT];
if (!build) throw new Error(`WHAT must be one of ${Object.keys(WHATS).join('|')}, got "${WHAT}"`);
const { cellW, rows } = build();
if (cellW % TILE) throw new Error(`WHATS.${WHAT} cellW=${cellW} is not a multiple of TILE=${TILE} — plastic's grid snap would show an offset the game never has`);

// ── pass 1: draw every case at its final X and a provisional ground line ─────
//
// The column X is known before layout, so it is the real one from the start —
// cuphead's `wob(x, seed)` and plastic's `Math.round(x / TILE)` are functions of
// the coordinates they were handed, and drawing at a placeholder X would quietly
// produce a different picture from the one the grid finally shows.
//
// Only the row height is unknown (it depends on how tall the art turns out), so
// Y is provisional and the recorded commands are TRANSLATED by a whole number of
// TILEs afterwards. A translation of the command list is exact; a redraw at a
// different Y would not be.

const PROV = 4800;
const anchorX = (c) => GUTTER + c * cellW + cellW / 2;
let maxAbove = 0;

for (const row of rows) {
  for (const [ci, cell] of row.cells.entries()) {
    const sink = new Sink();
    const gfx = makeGraphics(sink);
    try {
      cell.out = cell.draw(gfx, anchorX(ci), PROV) ?? {};
    } catch (e) {
      cell.error = String(e && e.message ? e.message : e);
      cell.out = {};
    }
    cell.sink = sink;
    cell.bounds = boundsOf(sink.cmds);

    // The night layer: its OWN Sink, because in game it is its own Graphics
    // with its own blend mode and its own alpha. Recorded here, in pass 1,
    // so it gets translated by the same whole-TILE dy as the day layer and the
    // two can never drift apart vertically.
    cell.nightSink = new Sink();
    cell.lightPath = null;
    if (NIGHT && cell.night) {
      try {
        cell.lightPath = cell.night(makeGraphics(cell.nightSink), anchorX(ci), PROV, cell.out) ?? 'style';
      } catch (e) {
        cell.error = (cell.error ? `${cell.error}; ` : '') + `lights: ${String(e && e.message ? e.message : e)}`;
      }
    }

    if (cell.bounds) maxAbove = Math.max(maxAbove, PROV - cell.bounds.y0);
    // Lights that reach above the body still have to fit in the row.
    const nb = boundsOf(cell.nightSink.cmds);
    if (nb) maxAbove = Math.max(maxAbove, PROV - nb.y0);
    const nom = cell.out.nominal;
    if (nom) { maxAbove = Math.max(maxAbove, nom.h); }
  }
}

const rowH = Math.max(120, Math.ceil((maxAbove + LABEL_H + 12 + PAD) / TILE) * TILE);
const W = GUTTER + cellW * Math.max(...rows.map((r) => r.cells.length));
const H = HEADER + rowH * rows.length + TILE;

// ── compose ──────────────────────────────────────────────────────────────────

// The sky the art actually stands against. By day the palette's own horizon
// band; at night whatever `getSkyColors` holds past astronomical twilight —
// asked of the STYLE rather than hardcoded, so a repaint of either world's night
// moves this with it.
const BG = NIGHT
  ? rgb(strategy.getSkyColors(NIGHT_SUN_ELEVATION, 'sunny').bottom)
  : rgb(PAL.skyDayBottom);
R = createRaster(W, H, BG);

// The night veil — the glasses pipeline's night term, same source, same mix
// (`night-grade.ts`). Applied to the whole frame between the day pass and the
// lights pass below; 0 by day, and 0 under VEIL=0.
const veilAmt = NIGHT && VEIL ? nightVeilAmount(1, STYLE) : 0;
const veilCol = nightVeilRgb(STYLE).map((c) => c * 255);

// Ink that survives whichever background this style has. Annotations draw
// after the veil, so judge against the VEILED sky, not the raw one.
const bgShown = BG.map((c, i) => c * (1 - veilAmt) + veilCol[i] * veilAmt);
const lum = 0.2126 * bgShown[0] + 0.7152 * bgShown[1] + 0.0722 * bgShown[2];
const INK = lum > 128 ? [24, 20, 28] : [232, 232, 240];
const NOMINAL_INK = lum > 128 ? [0, 110, 190] : [120, 200, 255];
const DRAWN_INK = [235, 60, 160];
// Three overlays have to be legible at once, so they differ in RHYTHM as well as
// hue: nominal short-dashed, drawn long-dashed, reported SOLID. Hue alone is not
// enough where all three coincide to within a pixel, which is the common case.
const REPORTED_INK = lum > 128 ? [0, 130, 60] : [120, 255, 170];

let totalPrims = 0, totalApi = 0, totalState = 0, totalLights = 0, clipped = 0;
let worstSlack = null;
const table = [];

// ── pass 1: the world — ground lines and the day art ──
rows.forEach((row, r) => {
  const cellTop = HEADER + r * rowH;
  const groundY = cellTop + rowH - PAD;
  row.cells.forEach((cell, c) => {
    const cellX = GUTTER + c * cellW;
    const clip = { x0: cellX, x1: cellX + cellW - 1, y0: cellTop + 1, y1: cellTop + rowH - 1 };
    // Ground line first, so the art stands on something visible.
    strokeQuad(cellX + 4, groundY, cellX + cellW - 4, groundY, 1, INK, 0.3);
    rasterCase(cell.sink.cmds, groundY - PROV, clip);
  });
});

// ── pass 2: the veil, then the lights ABOVE it (option D) ──
// The veil covers the whole frame drawn so far, sky included — exactly what
// the glasses pipeline does to the main camera's frame. The lights are NOT
// under it: in game they render on the second, pipeline-free camera. That
// ordering is the entire reason an additive mark has headroom — the surface
// it has to beat is the veiled one, not the full-brightness daytime one.
if (veilAmt > 0) {
  const buf = R.buf;
  for (let i = 0; i < buf.length; i += 3) {
    buf[i] = buf[i] * (1 - veilAmt) + veilCol[0] * veilAmt;
    buf[i + 1] = buf[i + 1] * (1 - veilAmt) + veilCol[1] * veilAmt;
    buf[i + 2] = buf[i + 2] * (1 - veilAmt) + veilCol[2] * veilAmt;
  }
}
if (NIGHT) {
  R.setBlend('add');
  rows.forEach((row, r) => {
    const cellTop = HEADER + r * rowH;
    const groundY = cellTop + rowH - PAD;
    row.cells.forEach((cell, c) => {
      if (cell.nightSink.cmds.length === 0) return;
      const cellX = GUTTER + c * cellW;
      const clip = { x0: cellX, x1: cellX + cellW - 1, y0: cellTop + 1, y1: cellTop + rowH - 1 };
      rasterCase(cell.nightSink.cmds, groundY - PROV, clip, NIGHT_LAYER_ALPHA);
    });
  });
  R.setBlend('over');
}

// ── pass 3: annotations and bookkeeping — after the veil, so they stay crisp ──
rows.forEach((row, r) => {
  const cellTop = HEADER + r * rowH;
  const groundY = cellTop + rowH - PAD;
  drawText(row.label, 8, cellTop + rowH / 2 - 6, 11, INK, 0.95);
  // Row separator
  strokeQuad(0, cellTop, W, cellTop, 1, INK, 0.16);

  row.cells.forEach((cell, c) => {
    const cellX = GUTTER + c * cellW;
    // Only the clipped-count below still needs the cell rect here — pass 3
    // draws annotations unclipped, as the old single-pass version did too.
    const clip = { x0: cellX, x1: cellX + cellW - 1, y0: cellTop + 1, y1: cellTop + rowH - 1 };
    const dy = groundY - PROV;
    const lights = cell.nightSink.cmds.length;

    const nom = cell.out.nominal;
    const rep = cell.out.reported;
    const b = cell.bounds;
    const delta = extentDelta(rep, b);
    if (BOXES) {
      if (nom) dashRect(nom.x, nom.y + dy, nom.w, nom.h, NOMINAL_INK, 0.85, 4);
      // Drawn bounds: shown whenever there is a reported box to compare against
      // (the point of the picture is the three-way), else only when they differ
      // from nominal, which is what this always did.
      if (b) {
        const dw = b.x1 - b.x0, dh = b.y1 - b.y0;
        if (rep || (nom && (Math.abs(dw - nom.w) > 1 || Math.abs(dh - nom.h) > 1 ||
          Math.abs(b.x0 - nom.x) > 1 || Math.abs(b.y0 - nom.y) > 1))) {
          dashRect(b.x0, b.y0 + dy, dw, dh, DRAWN_INK, 0.8, 9);
        }
      }
      // Reported last and SOLID — it is the number everything downstream trusts.
      if (rep) solidRect(rep.x, rep.y + dy, rep.w, rep.h, REPORTED_INK, 0.9);
    }

    let drawnLabel = '-';
    if (b) {
      drawnLabel = `${Math.round(b.x1 - b.x0)}X${Math.round(b.y1 - b.y0)}`;
      if (b.y0 + dy < clip.y0 || b.y1 + dy > clip.y1) clipped++;
    }

    drawText(cell.label, cellX + 6, cellTop + 5, 9, INK, 0.9);
    drawText(
      NIGHT ? `${cell.sink.cmds.length} PRIM ${lights} LIT` : `${cell.sink.cmds.length} PRIM`,
      cellX + 6, cellTop + 16, 9, INK, 0.6,
    );
    if (cell.error) drawText('ERROR', cellX + 6, cellTop + 28, 9, [255, 60, 60], 1);

    totalPrims += cell.sink.cmds.length;
    totalApi += cell.sink.api;
    totalState += cell.sink.state;
    totalLights += lights;
    if (delta && (worstSlack === null || delta.slack > worstSlack.slack)) {
      worstSlack = { slack: delta.slack, row: row.label, cell: cell.label };
    }
    table.push({
      row: row.label, cell: cell.label,
      prims: cell.sink.cmds.length, api: cell.sink.api, state: cell.sink.state, path: cell.sink.path,
      lights, lightPath: cell.lightPath,
      nominal: nom ? `${nom.w}x${nom.h}` : '-',
      reported: rep ? `${Math.round(rep.w)}x${Math.round(rep.h)}` : '-',
      drawn: drawnLabel,
      slack: delta ? delta.slack : null,
      spill: delta ? delta.spill : null,
      off: b && nom ? `${Math.round(b.x0 - nom.x)},${Math.round(b.y0 - nom.y)}` : '-',
      error: cell.error ?? '',
    });
  });
});

const cases = table.length;
drawText(`${STYLE} ${WHAT}${NIGHT ? ' NIGHT' : ''}`, 8, 10, 16, INK, 1);
drawText(
  `${cases} CASES   ${totalPrims} PRIMS   ${totalApi} API   ${totalState} STATE` +
  (NIGHT ? `   ${totalLights} LIT` : ''),
  8, 34, 10, INK, 0.75,
);
const NIGHT_LEGEND = NIGHT
  ? `   ADD LAYER AT ${NIGHT_LAYER_ALPHA} ${VEIL ? 'ABOVE THE VEIL' : 'NO VEIL'} NOT PHASER BLEND NO BLOOM`
  : '';
drawText(
  BOXES
    ? `BLUE DASH NOMINAL   GREEN SOLID REPORTED   PINK DASH DRAWN${NIGHT_LEGEND}`
    : `NO EXTENT BOXES${NIGHT_LEGEND}`,
  8, 50, 8, INK, 0.5,
);

// `-grid` in the name so a forced-fallback render can never quietly overwrite
// the one showing what the style actually draws; `-noveil` for the same reason.
const out = `${OUT_DIR}/phaser-style-${STYLE}-${WHAT}${NIGHT ? '-night' : ''}${NIGHT && !VEIL ? '-noveil' : ''}${LIGHTS === 'grid' ? '-grid' : ''}.png`;
// `triangles` is mini-raster's 3D field; nothing here is a triangle and writePng
// does not read it.
writePng(out, { width: W, height: H, pixels: R.buf, triangles: 0 });

// ── report ───────────────────────────────────────────────────────────────────

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const px = (v) => (v === null ? '-' : v.toFixed(1));
console.log(`\n${STYLE} / ${WHAT}${NIGHT ? ' / night' : ''} — ${cases} cases`);
console.log(
  `${pad('row', 13)}${pad('case', 10)}${padL('prims', 6)}${padL('api', 5)}${padL('state', 6)}${padL('path', 5)}` +
  (NIGHT ? `${padL('lit', 5)}  ${pad('via', 6)}` : '  ') +
  `${pad('nominal', 9)}${pad('reported', 10)}${pad('drawn', 9)}${padL('slack', 7)}${padL('spill', 7)}  offset`,
);
for (const t of table) {
  console.log(
    `${pad(t.row, 13)}${pad(t.cell, 10)}${padL(t.prims, 6)}${padL(t.api, 5)}${padL(t.state, 6)}${padL(t.path, 5)}` +
    (NIGHT ? `${padL(t.lights, 5)}  ${pad(t.lightPath ?? '-', 6)}` : '  ') +
    `${pad(t.nominal, 9)}${pad(t.reported, 10)}${pad(t.drawn, 9)}${padL(px(t.slack), 7)}${padL(px(t.spill), 7)}  ${t.off}` +
    `${t.error ? `   !! ${t.error}` : ''}`,
  );
}
console.log(
  `${pad('TOTAL', 23)}${padL(totalPrims, 6)}${padL(totalApi, 5)}${padL(totalState, 6)}${padL('', 5)}` +
  (NIGHT ? `${padL(totalLights, 5)}` : ''),
);

const worst = table.filter((t) => t.prims > 0).sort((a, b) => b.prims - a.prims)[0];
if (worst) console.log(`most expensive: ${worst.row} ${worst.cell} — ${worst.prims} prims`);
if (NIGHT) {
  const dark = table.filter((t) => t.lightPath === 'style' && t.lights === 0).length;
  const lit = table.filter((t) => t.lights > 0);
  const worstLit = lit.slice().sort((a, b) => b.lights - a.lights)[0];
  console.log(
    `night: ${totalLights} additive prims over ${cases} cases` +
    (worstLit ? `, dearest ${worstLit.row} ${worstLit.cell} — ${worstLit.lights}` : '') +
    (dark ? `; ${dark} case(s) declared lights and drew none (a real "no lights")` : ''),
  );
  console.log(veilAmt > 0
    ? `veil: ${veilAmt.toFixed(2)} toward rgb(${veilCol.map(Math.round).join(',')}) under the lights (option D compositing)`
    : 'veil: OFF — pre-option-D composite (lights on the unveiled day frame)');
}
if (clipped) console.log(`⚠ ${clipped} case(s) drew outside their cell and were clipped in the PNG (counts are unaffected)`);
const errs = table.filter((t) => t.error);
if (errs.length) console.log(`⚠ ${errs.length} case(s) threw — see !! above`);

// ── the extent check ─────────────────────────────────────────────────────────
//
// SLACK is the failable direction: reported box beyond the art it claims to
// cover, so anything laid over that extent floats (§3.8). SPILL is the sanctioned
// one — `DrawnBox` is the solid mass, and outlines and studs overshoot it.

if (worstSlack) {
  const worstSpill = table.filter((t) => t.spill !== null).sort((a, b) => b.spill - a.spill)[0];
  console.log(
    `extent: worst slack ${worstSlack.slack.toFixed(1)} px (${worstSlack.row} ${worstSlack.cell})` +
    (worstSpill ? `, worst spill ${worstSpill.spill.toFixed(1)} px (${worstSpill.row} ${worstSpill.cell})` : ''),
  );
  if (MAX_SLACK !== null) {
    const over = table.filter((t) => t.slack !== null && t.slack > MAX_SLACK);
    if (over.length) {
      console.log(`✗ ${over.length} case(s) report more space than they drew, over MAX_SLACK=${MAX_SLACK} px:`);
      for (const t of over) console.log(`    ${t.row} ${t.cell}  reported ${t.reported} drawn ${t.drawn}  slack ${t.slack.toFixed(1)} px`);
      process.exitCode = 1;
    } else {
      console.log(`✓ every reported extent is within MAX_SLACK=${MAX_SLACK} px of the art that filled it`);
    }
  }
} else if (MAX_SLACK !== null) {
  // Silence here would read as a pass. It is not one — nothing was measured.
  console.log(`⚠ MAX_SLACK=${MAX_SLACK} was set but no case reported a DrawnBox — nothing was checked`);
  process.exitCode = 1;
}
const missed = unstubbedReport();
if (missed) {
  console.log('⚠ unstubbed Graphics calls (drawn as nothing):', missed);
} else {
  console.log('unstubbed Graphics calls: none');
}
console.log('wrote', out);
