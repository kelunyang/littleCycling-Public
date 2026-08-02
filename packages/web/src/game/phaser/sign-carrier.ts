/**
 * The part of the shop-sign spec that `terrain/sign-spec.ts` does not carry yet
 * — shared by the 2D worlds' three sign CARRIERS.
 *
 * All six demos declare one block of sign code and say so in it:「以下這一整段
 * (到 signTri 為止)三支 phaser demo 完全相同,改要一起改」. Most of that block was
 * already promoted into `sign-spec.ts` (`SIGN_RATIO`, `SIGN_TILT_RAD`,
 * `SIGN_ZONES`, `SIGN_GLYPHS`, `signStrokes`, `signPlacement`, `signContent`).
 * Four pieces were not, and every 2D style that grew a sign has since had to
 * re-type them:
 *
 *   · `SIGN_TOPFACE`   — the visible stand-in for the 8° tilt
 *   · `signStroke`     — one thick stroke with SQUARE caps
 *   · `signTriPoints`  — the hospital triangle's proportions
 *   · `signShift`      — stepping the plate out from behind a lamp post
 *
 * They live here rather than in three copies for the same reason the rest lives
 * in `sign-spec.ts`: a sign is a CROSS-WORLD component, and the moment one world
 * "just tweaks" a proportion the six stop reading as the same kind of object at
 * distance. They belong in `sign-spec.ts` proper; this module is where they wait
 * until that file's owner can take them. (`circuit-style.ts` still has its own
 * `SIGN_TOPFACE` and `strokeQuad`, deliberately untouched here — folding it in
 * is a separate, verifiable change.)
 *
 * Deliberately free of any THREE import, like `sign-spec.ts` and
 * `road-classes.ts`: `Phaser.GameObjects.Graphics` is a TYPE-only import, so
 * nothing here drags an engine behind it.
 */

import type Phaser from 'phaser';
import { SIGN_TILT_RAD } from '@/game/terrain/sign-spec';

/**
 * The 8° downward tilt, as the fraction of the plate height its sky-facing top
 * face occupies. ≈ 0.139.
 *
 * Doing the tilt LITERALLY in a 2D orthographic side view is doing nothing —
 * `cos 8° = 0.990`, one percent of foreshortening — and it breaks the 3:1 ratio
 * every world shares. So all three 2D demos draw the visible EQUIVALENT instead:
 * the top face catching the light as a bright band, plus the shadow the plate
 * drops on the wall behind it. The band's width is derived from the angle, not
 * chosen.
 */
export const SIGN_TOPFACE = Math.sin(SIGN_TILT_RAD);

/**
 * One stroke of a glyph, with thickness and SQUARE caps — the demos'
 * `signStroke`.
 *
 * Two triangles for the shaft and a `t × t` square at each end. The squares are
 * the point: a stroked line has butt caps, so at a letter's corners the two
 * segments leave a notch, and filling the corner keeps the join sharp. The
 * demos' comment forbids the obvious alternative —「補圓角就不銳利了」— because a
 * rounded join is exactly what stops a four-letter word being legible at forty
 * pixels.
 *
 * `dx` / `dy` shift the whole stroke, which is how the label-tape emboss and the
 * sticker's drop shadow are drawn: the same strokes, twice, offset.
 */
export function signStroke(
  gfx: Phaser.GameObjects.Graphics,
  x0: number, y0: number, x1: number, y1: number, t: number,
  dx = 0, dy = 0,
): void {
  const ax = x0 + dx, ay = y0 + dy, bx = x1 + dx, by = y1 + dy;
  const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey) || 1;
  const px = (-ey / len) * (t / 2), py = (ex / len) * (t / 2);
  gfx.fillTriangle(ax + px, ay + py, bx + px, by + py, bx - px, by - py);
  gfx.fillTriangle(ax + px, ay + py, bx - px, by - py, ax - px, ay - py);
  gfx.fillRect(ax - t / 2, ay - t / 2, t, t);
  gfx.fillRect(bx - t / 2, by - t / 2, t, t);
}

/**
 * The hospital marker's triangle, centred on `(cx, cy)` — the demos' `signTri`,
 * `[x0, y0, x1, y1, x2, y2]` ready for `fillTriangle`.
 *
 * A TRIANGLE, never a red cross: a red cross on white is protected by the Geneva
 * Conventions and by national law in most jurisdictions. Height is 0.66 of the
 * plate and the base 1.15 of the height, in all six worlds.
 */
export function signTriPoints(
  cx: number, cy: number, plateH: number,
): [number, number, number, number, number, number] {
  const th = plateH * 0.66, tw = th * 1.15;
  return [cx, cy - th / 2, cx + tw / 2, cy + th / 2, cx - tw / 2, cy + th / 2];
}

/**
 * How far to slide the plate sideways so a thin upright is not standing in
 * front of it — the demos' `signShift`, verbatim.
 *
 * Lamps and checkpoint markers are laid out on fixed spacing and will never step
 * aside for a building, so sooner or later one of them stands exactly in front
 * of a sign. The plate moves instead, but only within the slack its own body
 * gives it: nine candidate offsets across `±(bodyW − signW) / 2`, pick the one
 * whose nearest post is furthest away. If none of them clears, it stays put —
 * 「細桿子擋住一角,比招牌飛出建築外面好看」.
 *
 * The `+ 0.5` is not slop: it is what makes offset 0 win ties, so a sign only
 * moves when moving actually buys more than half a pixel of clearance.
 *
 * ⚠ This must never feed back into what is GENERATED. The demos state it
 * outright —「只動招牌,不動任何生成順序」— because a sign that consumed from a
 * shared RNG would re-roll every prop placed after it.
 */
export function signShift(
  cx: number, bodyW: number, signW: number, posts: readonly number[],
): number {
  const room = (bodyW - signW) / 2;
  if (room < 1.5 || !posts.length) return 0;
  let best = 0, bestClear = -Infinity;
  for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
    const off = (room * k) / 4;
    let clear = Infinity;
    for (const p of posts) clear = Math.min(clear, Math.abs(p - (cx + off)) - signW / 2);
    if (clear > bestClear + 0.5) { bestClear = clear; best = off; }
  }
  return best;
}
