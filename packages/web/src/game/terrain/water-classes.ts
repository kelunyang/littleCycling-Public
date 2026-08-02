/**
 * What counts as water — the single source of truth for BOTH renderers.
 *
 * Same shape, and the same reason, as `road-classes.ts`: Three.js decides this
 * in `landuse-renderer.ts`, Phaser 2D decides it in `mvt-projection.ts`'s
 * `classifyFeature`, and until now **neither of them read the `class` at all**.
 * The whole `water` layer went to one bucket, so a private back-garden swimming
 * pool got the Keelung River's material, the Keelung River's 0.1 m slab and the
 * Keelung River's shine.
 *
 * Deliberately free of any THREE / Phaser import: `mvt-projection` runs inside a
 * Web Worker, and pulling a renderer into that would drag the whole engine in
 * with it.
 *
 * ## Measured, because "pools are rare" is the assumption that hid this
 *
 * 3×3 z14 windows fetched at run time from OpenFreeMap through the production
 * `decodeMVTTile` — nothing stored (CLAUDE.md 外部資料源版權規範; the counts
 * below are statistics, not data, which `plan/DEMO_POC_GUIDE.md` §4 allows):
 *
 * ```
 *   Los Angeles   swimming_pool 2901   lake  7   pond  9   river 4   → 99.3% pools
 *   Taipei        swimming_pool   28   lake 17   pond 86   river 14  → 19.4% pools
 *   Alpe d'Huez   swimming_pool   12   lake  3             river 3   → 66.7% pools
 *   Narita        swimming_pool    6   lake 23   pond 15
 *   Amalfi                             ocean 6   river 2
 *   Afsluitdijk                        ocean 9   lake  3             (no pools)
 * ```
 *
 * A pool is 8 × 4 m of somebody's garden. A suburban chunk was spending four
 * fifths of its water triangles, its merge time and its transparent overdraw on
 * them, in a world whose three demos contain no swimming pool at all.
 *
 * ## Dropped, not re-styled
 *
 * `plan/DEMO_POC_GUIDE.md` §1: where the demo has no answer the porter can only
 * invent, and nobody can diff an invention. A fourth water vocabulary across
 * three worlds is exactly that. 「這種東西沒有」 is a legal answer
 * (CUSTOM_WORLD_INSTRUCTIONS §3.9) and it is the one the demos give.
 *
 * ## A DENY-list, unlike roads
 *
 * `DRAWN_ROAD_CLASSES` is a whitelist because the `transportation` layer is full
 * of things that are not roads. The `water` layer is by definition water, so the
 * default has to be "draw it": an allow-list here would silently swallow the
 * next class OpenMapTiles names (reservoir, lagoon, …) with nothing to say so.
 */

/** MVT feature properties, narrowed to what this policy reads. */
interface WaterProps {
  class?: unknown;
}

/**
 * `water` classes that are NOT landscape water.
 *
 * One entry, and it should stay hard to add to: every addition is a piece of the
 * map this game stops showing.
 */
export const NON_LANDSCAPE_WATER_CLASSES: ReadonlySet<string> = new Set([
  'swimming_pool',
]);

/** Should this `water` feature be drawn as water? */
export function isLandscapeWater(props: WaterProps | undefined | null): boolean {
  if (!props) return false;
  return !NON_LANDSCAPE_WATER_CLASSES.has(String(props.class ?? ''));
}
