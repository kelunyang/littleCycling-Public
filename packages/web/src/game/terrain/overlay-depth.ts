/**
 * Depth ordering for the flat things we lay ON the terrain.
 *
 * ## The problem this exists to solve
 *
 * Roads, landuse patches, waterways, runways and the route line are all decals:
 * geometry that sits a few centimetres above the ground and has to win the
 * depth test against it, and against each other, in a fixed order.
 *
 * That order used to be expressed purely as a metric height offset — urban
 * 0.02 m, farmland 0.025 m, sand 0.03 m, … road 0.30 m, route 0.45 m. Metric
 * offsets do not survive contact with a depth buffer. With the camera's
 * near/far, a 24-bit depth buffer resolves roughly `z² × (1/near) / 2²⁴` metres
 * at distance z, so:
 *
 *  - at 300 m it resolves ~3 mm — the 5 mm gap between sports and sand is
 *    already marginal;
 *  - at 1 km it resolves ~3 cm — every landuse layer has collapsed into the
 *    terrain;
 *  - at 2 km it resolves ~12 cm — roads join them.
 *
 * Past those distances the terrain and everything laid on it occupy the same
 * depth bucket and interleave per-pixel, which on a hillside reads as black
 * dashes scattered up the slope and along the ridge. Flat ground near the rider
 * stays clean, because near the camera the precision is millimetric — which is
 * exactly the "平地乾淨、山上有線" signature this module addresses.
 *
 * ## The fix
 *
 * `polygonOffset` biases a surface in DEPTH-BUFFER units rather than metres, so
 * one unit is by definition enough to separate two surfaces at ANY distance.
 * The metric offsets stay (they keep the ordering honest up close, and stop
 * ribbons z-fighting the terrain's own quantised risers); this adds the
 * distance-independent tiebreak on top.
 *
 * `factor` scales with the polygon's depth slope, which matters here because
 * every one of these is viewed at a grazing angle from a bike saddle.
 */

import type * as THREE from 'three';

/**
 * Draw order, ground upward. Terrain is rank 0 and takes no offset — everything
 * else is pulled toward the camera relative to it. Keep this list in the same
 * order as the metric offsets in the renderers, or the two will disagree and
 * the result depends on distance.
 */
export const OVERLAY_RANK = {
  urban: 1,
  farmland: 2,
  sand: 3,
  // `playground` was split out of `sports` (2026-07-28, arbitrated by the demos:
  // a pitch is flat-and-lines, a playground is the one ground cover allowed to
  // stand up). It sits IMMEDIATELY below the pitch because the two are adjacent
  // classes and the court lines have to win where they overlap.
  //
  // ⚠ Inserting it shifted every rank above it by one. Nothing may assert these
  // NUMBERS — the rule this list encodes is the ORDER (and that it matches the
  // metric offsets in the renderers). `props-vs-demo.ts` asserts the order.
  playground: 4,
  sports: 5,
  forest: 6,
  park: 7,
  wetland: 8,
  water: 9,
  aeroway: 10,
  waterway: 11,
  road: 13,
  routeGlow: 15,
  routeCore: 16,
} as const;

export type OverlayKind = keyof typeof OVERLAY_RANK;

/**
 * Stamp a shared overlay material with its depth rank. Idempotent — these
 * materials are strategy-owned singletons, so this runs once per material at
 * creation and never per frame.
 */
export function applyOverlayDepth(material: THREE.Material, kind: OverlayKind): void {
  const rank = OVERLAY_RANK[kind];
  material.polygonOffset = true;
  material.polygonOffsetFactor = -rank;
  material.polygonOffsetUnits = -rank * 2;
}
