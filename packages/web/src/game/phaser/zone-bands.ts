/**
 * The route's land-use districts as distance bands — the 2D renderer's
 * along-the-ground answer to "which district am I in".
 *
 * ── Why this is its own module ──
 *
 * It has no Phaser in it, on purpose, and for the same reason `night-grade.ts`
 * has none: the natural home for this is `terrain-builder.ts`, which imports
 * `phaser2d-scene.ts`, which does `import Phaser from 'phaser'` — and Phaser
 * cannot be loaded in Node (`device/index.js` wants a DOM). Anything that lives
 * in there can only ever be checked through a browser, so the arithmetic lives
 * out here where a headless check can execute it, and `terrain-builder` and
 * `phaser2d-scene` both import from this side.
 *
 * ── What it is for ──
 *
 * The circuit world signals its zoning WITH THE SOLDER MASK: its demo re-colours
 * the board segment by segment down the whole length and drops a silkscreen line
 * through the board's thickness at every edge. `renderUrban`'s 60 px strip cannot
 * say that, so `drawTerrainSurface` takes a district per sample and needs a
 * distance → district function to fill it from.
 */

import type { ProjectedFeature } from '@/game/terrain/mvt-projection';
import type { ZoneKind } from '@/game/terrain/land-zone';

/** One district, as a distance range on the route. Sorted, non-overlapping. */
export interface ZoneBand {
  startM: number;
  endM: number;
  zone: ZoneKind;
}

/**
 * Buildings further than this from the route are not what the rider is riding
 * through. Same idea as `terrain-builder`'s `ROAD_SPAN_MAX_OFFSET_M`, tighter: a
 * road 150 m away still paves the ground you are on, a tower block 150 m away is
 * the next district over.
 */
export const ZONE_MAX_OFFSET_M = 80;

/**
 * How far a district reaches along the route from the nearest building that
 * declares it.
 *
 * ⚠ **The one number in the zoning that no demo arbitrates.** The 2D circuit
 * demo synthesises its districts as 220–420 m segments off a seeded RNG; real
 * MVT gives point samples with no extent, so something has to say how far one
 * reaches. 100 m means a single isolated building tints at most 200 m of board —
 * under the demo's SHORTEST district — so an outlier can never out-shout a real
 * one, and open country between two towns goes back to bare green mask rather
 * than being split down the middle between them.
 */
export const ZONE_REACH_M = 100;

/**
 * The route's districts, from the buildings' own zones.
 *
 * WHY buildings and not the `urban` ground features: a building's `props.zone`
 * is resolved in `mvt-zone-worker` against the `ZoneIndex`, which is built from
 * ALL ELEVEN landuse classes — so school and hospital arrive here. The `urban`
 * features cannot carry them: `mvt-projection.classifyFeature` drops `landuse`
 * school and hospital before projection (they are not ground tint there), which
 * is why `renderUrban`'s zone is documented as residential / commercial /
 * industrial only. Reading the buildings is what makes all five solder-mask
 * colours reachable today without an upstream change.
 *
 * It also makes the band and the buildings standing on it agree BY
 * CONSTRUCTION — the same guarantee `renderUrban` gets from sharing
 * `zoneFromLanduseClass`, one step stronger.
 *
 * A sample belongs to the nearest zoned building within `ZONE_REACH_M`, so a
 * boundary between two districts falls at the midpoint between their nearest
 * buildings. NOT smoothed and NOT minimum-length filtered: if the map says a
 * commercial unit stands in a residential street, the board says so too, the
 * same way `ground-studs` lets every stud ask the index for itself. Runs are
 * then collapsed, so a uniform district is ONE band however many buildings
 * declare it.
 */
export function buildZoneBands(features: readonly ProjectedFeature[]): ZoneBand[] {
  const marks = features
    .filter((f) => (
      f.type === 'building'
      && f.offsetM <= ZONE_MAX_OFFSET_M
      && typeof f.props.zone === 'string'
    ))
    .map((f) => ({ d: f.distanceM, zone: f.props.zone as ZoneKind }))
    .sort((a, b) => a.d - b.d);
  if (marks.length === 0) return [];

  const bands: ZoneBand[] = [];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    // Reach back / forward to the midpoint to the neighbouring mark, capped at
    // the full reach when that one is far away.
    const prev = marks[i - 1];
    const next = marks[i + 1];
    const back = prev ? Math.min(ZONE_REACH_M, (m.d - prev.d) / 2) : ZONE_REACH_M;
    const fwd = next ? Math.min(ZONE_REACH_M, (next.d - m.d) / 2) : ZONE_REACH_M;
    const startM = Math.max(0, m.d - back);
    const endM = m.d + fwd;

    const last = bands[bands.length - 1];
    // Same district and touching (the midpoint rule makes consecutive marks of
    // one district meet exactly) → one band, not one per building.
    if (last && last.zone === m.zone && startM <= last.endM + 1e-6) {
      last.endM = Math.max(last.endM, endM);
      continue;
    }
    bands.push({ startM, endM, zone: m.zone });
  }
  return bands;
}

/**
 * The district at a route distance, or null outside every band.
 *
 * Binary search because `drawTerrain` asks once per visible sample on every
 * scrolled frame, and on the N100 the 2D world is CPU-bound
 * (`plan/migrate-demo-worlds.md` §5).
 *
 * Null is NOT residential — `land-zone.ts` says why where it defines the type:
 * a rural road is not a suburb, and a board with no coloured solder mask on it
 * is 「沒開彩色阻焊」rather than a green district.
 */
export function zoneAtDistance(
  bands: readonly ZoneBand[],
  distM: number,
): ZoneKind | null {
  if (bands.length === 0) return null;
  let lo = 0;
  let hi = bands.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (distM < bands[mid].endM) hi = mid; else lo = mid + 1;
  }
  const hit = bands[lo];
  return distM >= hit.startM && distM < hit.endM ? hit.zone : null;
}
