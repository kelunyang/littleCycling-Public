/**
 * Route geometry utilities for MapLibre and ball engine.
 * Converts RoutePoint[] into GeoJSON, interpolates positions, computes bounds.
 */

import type { RoutePoint } from '@littlecycling/shared';
import { calcRouteDistance } from '@littlecycling/shared';

export interface InterpolatedPosition {
  lat: number;
  lon: number;
  ele: number;
  bearing: number; // degrees, 0 = north, clockwise
}

/**
 * Pre-compute cumulative distances for a route.
 * cumulativeDistances[i] = distance from start to point i (in meters).
 */
export function buildCumulativeDistances(points: RoutePoint[]): number[] {
  const dists = new Array<number>(points.length);
  dists[0] = 0;
  for (let i = 1; i < points.length; i++) {
    dists[i] = dists[i - 1] + haversine(points[i - 1], points[i]);
  }
  return dists;
}

/**
 * Interpolate a position along the route at a given distance from start.
 * Uses binary search on pre-computed cumulative distances.
 */
export function interpolateAlongRoute(
  points: RoutePoint[],
  cumulativeDistances: number[],
  distanceM: number,
): InterpolatedPosition {
  if (points.length === 0) {
    return { lat: 0, lon: 0, ele: 0, bearing: 0 };
  }

  const totalDist = cumulativeDistances[cumulativeDistances.length - 1];

  // Clamp to route length
  const d = Math.max(0, Math.min(distanceM, totalDist));

  // Binary search for segment
  let lo = 0;
  let hi = cumulativeDistances.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumulativeDistances[mid] <= d) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const segStart = lo;
  const segEnd = hi;
  const segLen = cumulativeDistances[segEnd] - cumulativeDistances[segStart];
  const t = segLen > 0 ? (d - cumulativeDistances[segStart]) / segLen : 0;

  const a = points[segStart];
  const b = points[segEnd];

  const lat = a.lat + (b.lat - a.lat) * t;
  const lon = a.lon + (b.lon - a.lon) * t;
  const ele = a.ele + (b.ele - a.ele) * t;
  const bearing = computeSmoothedBearing(points, cumulativeDistances, d);

  return { lat, lon, ele, bearing };
}

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

/**
 * Get total route distance in meters.
 */
export function totalRouteDistance(points: RoutePoint[]): number {
  return calcRouteDistance(points);
}

// ── Smoothed bearing ──

/** Bearing smoothing window in meters (half behind, half ahead). */
const BEARING_WINDOW = 30;

/**
 * Interpolate lat/lon/ele only (no bearing) at a given distance along the route.
 * Used internally for bearing smoothing.
 */
function interpolateLatLon(
  points: RoutePoint[],
  cumulativeDistances: number[],
  distanceM: number,
): { lat: number; lon: number; ele: number } {
  const totalDist = cumulativeDistances[cumulativeDistances.length - 1];
  const d = Math.max(0, Math.min(distanceM, totalDist));

  let lo = 0;
  let hi = cumulativeDistances.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumulativeDistances[mid] <= d) lo = mid;
    else hi = mid;
  }

  const segLen = cumulativeDistances[hi] - cumulativeDistances[lo];
  const t = segLen > 0 ? (d - cumulativeDistances[lo]) / segLen : 0;
  const a = points[lo];
  const b = points[hi];

  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
    ele: a.ele + (b.ele - a.ele) * t,
  };
}

/**
 * Compute a smoothed bearing at a given distance along the route.
 * Instead of using the current segment's direction, looks at a point
 * behind and a point ahead to produce a gradual bearing transition
 * through turns.
 */
export function computeSmoothedBearing(
  points: RoutePoint[],
  cumulativeDistances: number[],
  distanceM: number,
  window = BEARING_WINDOW,
): number {
  const totalDist = cumulativeDistances[cumulativeDistances.length - 1];
  const half = window / 2;

  const behindD = Math.max(0, distanceM - half);
  const aheadD = Math.min(totalDist, distanceM + half);

  // If behind and ahead are the same point, fall back to segment bearing
  if (aheadD - behindD < 0.1) {
    const d = Math.max(0, Math.min(distanceM, totalDist));
    let lo = 0;
    let hi = cumulativeDistances.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cumulativeDistances[mid] <= d) lo = mid;
      else hi = mid;
    }
    return computeBearing(points[lo].lat, points[lo].lon, points[hi].lat, points[hi].lon);
  }

  const behind = interpolateLatLon(points, cumulativeDistances, behindD);
  const ahead = interpolateLatLon(points, cumulativeDistances, aheadD);
  return computeBearing(behind.lat, behind.lon, ahead.lat, ahead.lon);
}

// ── Internal helpers ──

function haversine(a: RoutePoint, b: RoutePoint): number {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/**
 * Compute bearing from point (lat1,lon1) to (lat2,lon2) in degrees.
 */
function computeBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
