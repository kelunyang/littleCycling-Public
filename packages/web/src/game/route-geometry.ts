/**
 * Route geometry utilities for MapLibre.
 *
 * The interpolation math (`buildCumulativeDistances`, `interpolateAlongRoute`,
 * `computeSmoothedBearing`, `totalRouteDistance`) moved to
 * @littlecycling/shared so the server-side game simulation uses the exact
 * same geometry as the renderer. Re-exported here so existing imports keep
 * working unchanged. Only the GeoJSON/map helpers live here now.
 */

import type { RoutePoint } from '@littlecycling/shared';

export type { InterpolatedPosition } from '@littlecycling/shared';
export {
  buildCumulativeDistances,
  interpolateAlongRoute,
  totalRouteDistance,
  computeSmoothedBearing,
} from '@littlecycling/shared';

/**
 * Convert route points to a GeoJSON FeatureCollection with a LineString.
 */
export function routeToGeoJSON(points: RoutePoint[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: points.map((p) => [p.lon, p.lat, p.ele]),
        },
      },
    ],
  };
}

/**
 * Compute bounding box for a set of route points.
 * Returns [[west, south], [east, north]].
 */
export function routeBounds(points: RoutePoint[]): [[number, number], [number, number]] {
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;

  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  return [[minLon, minLat], [maxLon, maxLat]];
}
