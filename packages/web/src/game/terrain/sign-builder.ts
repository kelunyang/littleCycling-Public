/**
 * Turning `sign-spec` strokes into Three.js geometry.
 *
 * Split from `sign-spec.ts` on purpose: the spec (proportions, glyph shapes,
 * what each zone says) must stay importable by the 2D renderer, which has no
 * business pulling THREE in. This file is the 3D half.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { signStrokes, type SignStroke } from './sign-spec';

/**
 * Strokes → ONE merged geometry of thin slabs, in the plate's local frame:
 * centre at the origin, +x right, +y up, extruded along +z from 0 to `depth`.
 *
 * Merged rather than one mesh per stroke because a four-letter word is 20-odd
 * strokes; at one mesh each, a street of shops would cost more draw calls than
 * the buildings under them.
 *
 * Each slab is lengthened by one stroke width so the ends are SQUARE and butt
 * cleanly at corners. Round caps would be wrong for both carriers we have —
 * embossed tape and printed sticker are both cut, not drawn.
 */
export function buildStrokeGeometry(
  strokes: readonly SignStroke[],
  depth: number,
): THREE.BufferGeometry | null {
  if (!strokes.length) return null;
  const parts: THREE.BufferGeometry[] = [];
  for (const s of strokes) {
    const dx = s.x1 - s.x0;
    const dy = s.y1 - s.y0;
    const len = Math.hypot(dx, dy);
    // A zero-length segment would produce a NaN rotation. None of the tables
    // has one, but a future glyph typo should not blow up a whole chunk.
    if (!(len > 1e-6)) continue;
    const g = new THREE.BoxGeometry(len + s.width, s.width, depth);
    g.rotateZ(Math.atan2(dy, dx));
    g.translate((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, depth / 2);
    parts.push(g);
  }
  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return merged;
}

/** Convenience: lay `text` out in a `w × h` plate and build its geometry. */
export function buildSignTextGeometry(
  text: string,
  w: number,
  h: number,
  depth: number,
): THREE.BufferGeometry | null {
  return buildStrokeGeometry(signStrokes(w, h, text), depth);
}

/**
 * The hospital marker: a solid triangle, `h × 0.66` tall, extruded like the
 * strokes. NOT a red cross — that mark is protected by the Geneva Conventions
 * and by national law in most jurisdictions (see `sign-spec.ts`).
 */
export function buildSignTriangleGeometry(h: number, depth: number): THREE.BufferGeometry {
  const th = h * 0.66;
  const tw = th * 1.15;
  const shape = new THREE.Shape();
  shape.moveTo(0, th / 2);
  shape.lineTo(tw / 2, -th / 2);
  shape.lineTo(-tw / 2, -th / 2);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geo.translate(0, 0, 0);
  return geo;
}

/**
 * A rounded-corner plate outline, for carriers that are cut plastic rather than
 * a raw rectangle (label tape, stickers). `r` is clamped so a short plate
 * cannot produce a self-intersecting shape.
 */
export function roundedPlateShape(w: number, h: number, r: number): THREE.Shape {
  const rr = Math.min(r, w / 2 - 0.001, h / 2 - 0.001);
  const x = w / 2;
  const y = h / 2;
  const s = new THREE.Shape();
  s.moveTo(-x + rr, -y);
  s.lineTo(x - rr, -y);
  s.absarc(x - rr, -y + rr, rr, -Math.PI / 2, 0, false);
  s.lineTo(x, y - rr);
  s.absarc(x - rr, y - rr, rr, 0, Math.PI / 2, false);
  s.lineTo(-x + rr, y);
  s.absarc(-x + rr, y - rr, rr, Math.PI / 2, Math.PI, false);
  s.lineTo(-x, -y + rr);
  s.absarc(-x + rr, -y + rr, rr, Math.PI, Math.PI * 1.5, false);
  return s;
}
