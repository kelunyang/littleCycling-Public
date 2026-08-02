/**
 * What counts as a road — the single source of truth for BOTH renderers.
 *
 * Three.js decides this in `road-renderer.ts`; Phaser 2D decides it in
 * `mvt-projection.ts`'s `classifyFeature`. They were separate, and the 2D side
 * simply mapped the whole `transportation` layer to "road". Keeping the policy
 * here means a decision made for one renderer cannot silently fail to reach the
 * other — which is exactly how the 2D world kept drawing things the 3D world
 * had already been fixed to leave out.
 *
 * Deliberately free of any THREE / Phaser import: `mvt-projection` runs inside
 * a Web Worker, and pulling a renderer into that would drag the whole engine in
 * with it.
 */

/**
 * The only MVT `transportation` classes drawn as roads.
 *
 * A WHITELIST. Both renderers' colour/width lookups fall back to a plain grey
 * road for anything they do not recognise, so a blacklist means every class
 * nobody thought about gets silently painted as tarmac — which is how the
 * elevated MRT guideway (`transit`) came to be drawn as a road lying on the
 * ground.
 *
 * What is left out, and why:
 *  - `path` / `track`: footpaths and trails. In the hills above Dazhi they are
 *    42% of the whole transportation layer — 135 pieces in a single 1 km box.
 *    Nobody rides a bike up a hiking trail, and draping that many ribbons over
 *    a staircase-quantised slope was most of the "black lines" report.
 *  - `service`: driveways, parking aisles, back alleys. Clutter at this scale.
 *  - `transit`: rail and metro. `subclass=subway` in Taipei — not a road.
 *
 * This is a toy diorama, not a survey map: missing minor ways is fine, drawing
 * things that are not roads is not.
 */
export const DRAWN_ROAD_CLASSES: ReadonlySet<string> = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor',
]);

/** MVT feature properties, narrowed to what this policy reads. */
interface RoadProps {
  class?: unknown;
  brunnel?: unknown;
}

/**
 * Should this `transportation` feature be drawn as a road?
 *
 * Tunnels are excluded: a tunnel is INSIDE the hill, not on it, so draping one
 * on the surface paints a road over the ridge it is meant to bore through. No
 * bore is modelled in either renderer — the 3D side marks the mouths with
 * portals, and the rider's own tunnels are conveyed by packing street lamps
 * tight (see street-lamp.ts).
 */
export function isDrawnRoad(props: RoadProps | undefined | null): boolean {
  if (!props) return false;
  if (props.brunnel === 'tunnel') return false;
  return DRAWN_ROAD_CLASSES.has(String(props.class ?? ''));
}
