/**
 * Web Worker for the Phaser 2D feature pipeline: fetch, project — and ZONE.
 *
 * The 2D path used to share `terrain/mvt-worker.ts`'s fetch+project branch. It
 * cannot carry the zoning, and the reason is worth writing down before someone
 * tries to fold this back in:
 *
 *  · Zoning needs the landuse POLYGON RINGS. A `ProjectedFeature` carries a
 *    centroid and its properties, nothing else — by the time features reach the
 *    main thread the rings are gone.
 *  · `classifyFeature` has also already dropped `landuse` school and hospital
 *    outright (neither is ground tint), so two of the five zones never even
 *    leave this side.
 *  · Rebuilding them on the main thread means refetching and redecoding every
 *    tile of the route. That decode is the entire reason this stage runs in a
 *    worker in the first place.
 *
 * So the index is built HERE, where the rings already exist, and each building
 * carries home nothing heavier than one `zone` string in its props.
 *
 * ⚠ Nothing in this file may reach a renderer. `land-zone.ts` is deliberately
 * free of any THREE import for exactly this call site (its header says so), and
 * dragging three.js into a Web Worker would undo that. `landuse-renderer.ts` is
 * NOT free of it — it opens with `import * as THREE` — which is why
 * `landuseRings` below exists instead of importing its `extractPolygonCoords`.
 */

import { MVTFetcher, type MVTFeature } from '@/game/terrain/mvt-fetcher';
import { projectMVTFeatures } from '@/game/terrain/mvt-projection';
import { ZoneIndex, zoneFromLanduseClass } from '@/game/terrain/land-zone';

/**
 * The outer ring of every polygon in a feature.
 *
 * A copy of `landuse-renderer.extractPolygonCoords`, on purpose rather than by
 * accident: that module imports three.js, and pulling a renderer into this
 * worker to read four lines of GeoJSON is the one thing the header forbids.
 * Ten lines duplicated beats three.js in the worker bundle — but they are a
 * pair, so a geometry type added to one belongs in the other.
 */
function landuseRings(feature: MVTFeature): [number, number][][] {
  const geom = feature.geometry;
  if (geom.type === 'Polygon') {
    return [(geom as GeoJSON.Polygon).coordinates[0] as [number, number][]];
  }
  if (geom.type === 'MultiPolygon') {
    return (geom as GeoJSON.MultiPolygon).coordinates.map(
      (poly) => poly[0] as [number, number][],
    );
  }
  return [];
}

/**
 * Index every urban landuse ring in the route corridor.
 *
 * No `isUrbanLanduse` guard: `zoneFromLanduseClass` recognises exactly the same
 * eleven classes and returns null for everything else, so the `if (!zone)` below
 * IS the guard. Checking both (as the 3D chunk manager does) would mean two
 * class lists that can drift apart.
 */
function buildZoneIndex(features: MVTFeature[]): ZoneIndex {
  const zones = new ZoneIndex();
  for (const f of features) {
    if (f.layer !== 'landuse') continue;
    const zone = zoneFromLanduseClass(f.properties.class as string | undefined);
    if (!zone) continue;
    for (const ring of landuseRings(f)) zones.add(ring, zone);
  }
  return zones;
}

self.onmessage = async (e: MessageEvent) => {
  const { points, cumulativeDists, bounds } = e.data;
  try {
    const fetcher = new MVTFetcher();
    await fetcher.initialize();
    const raw = await fetcher.getFeaturesForBounds(bounds);
    const projected = projectMVTFeatures(raw, points, cumulativeDists);

    // Only buildings ask. Ground cover already knows what it is (it arrives as
    // its own feature type), and zoning a tree would only cost lookups.
    const zones = buildZoneIndex(raw);
    for (const f of projected) {
      if (f.type !== 'building') continue;
      f.props.zone = zones.zoneAt(f.props.lon, f.props.lat);
    }

    projected.sort((a, b) => a.distanceM - b.distanceM);
    self.postMessage({ ok: true, features: projected, zoneRings: zones.size });
  } catch (err: any) {
    self.postMessage({ ok: false, error: err.message });
  }
};
