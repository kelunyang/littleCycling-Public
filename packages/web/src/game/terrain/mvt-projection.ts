/**
 * Pure computation logic for projecting MVT features onto a route.
 *
 * Extracted from terrain-builder.ts so it can run in a Web Worker
 * (no Phaser/Three.js dependencies).
 */

import type { RoutePoint } from '@littlecycling/shared';
import type { MVTFeature } from './mvt-fetcher';

/** Maximum distance from route to include a feature (meters). */
export const FEATURE_CORRIDOR_M = 1000;

/** A 2D feature projected onto the route distance axis. */
export interface ProjectedFeature {
  type: 'building' | 'tree' | 'water' | 'grass' | 'sand' | 'road';
  /** Route distance in meters (X position). */
  distanceM: number;
  /** Lateral offset from route in meters (for depth/layering). */
  offsetM: number;
  /** Feature-specific properties. */
  props: Record<string, any>;
}

/**
 * Find the nearest route distance for a given [lon, lat] coordinate.
 * Returns { distanceM, offsetM } where offsetM is perpendicular distance from route.
 */
export function projectToRoute(
  lon: number,
  lat: number,
  points: RoutePoint[],
  cumulativeDists: number[],
): { distanceM: number; offsetM: number } | null {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let bestDist = Infinity;
  let bestRouteDist = 0;

  for (let i = 0; i < points.length - 1; i++) {
    // Simple nearest-point (not segment projection — good enough for 2D)
    const dx = (lon - points[i].lon) * 111320 * cosLat;
    const dy = (lat - points[i].lat) * 111320;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestDist) {
      bestDist = dist;
      bestRouteDist = cumulativeDists[i];
    }
  }

  // Check last point too
  const last = points.length - 1;
  const dxL = (lon - points[last].lon) * 111320 * cosLat;
  const dyL = (lat - points[last].lat) * 111320;
  const distL = Math.sqrt(dxL * dxL + dyL * dyL);
  if (distL < bestDist) {
    bestDist = distL;
    bestRouteDist = cumulativeDists[last];
  }

  if (bestDist > FEATURE_CORRIDOR_M) return null;

  return { distanceM: bestRouteDist, offsetM: bestDist };
}

/**
 * Convert MVT features to projected 2D features along the route.
 */
export function projectMVTFeatures(
  features: MVTFeature[],
  points: RoutePoint[],
  cumulativeDists: number[],
): ProjectedFeature[] {
  const projected: ProjectedFeature[] = [];

  for (const feature of features) {
    const centroid = getFeatureCentroid(feature);
    if (!centroid) continue;

    const proj = projectToRoute(centroid[0], centroid[1], points, cumulativeDists);
    if (!proj) continue;

    const type = classifyFeature(feature);
    if (!type) continue;

    projected.push({
      type,
      distanceM: proj.distanceM,
      offsetM: proj.offsetM,
      props: {
        ...feature.properties,
        lon: centroid[0],
        lat: centroid[1],
      },
    });
  }

  return projected;
}

/** Classify an MVT feature into our 2D types. */
export function classifyFeature(feature: MVTFeature): ProjectedFeature['type'] | null {
  switch (feature.layer) {
    case 'building':
      return 'building';
    case 'water':
      return 'water';
    case 'landcover': {
      const cls = feature.properties.class || feature.properties.subclass || '';
      if (cls === 'forest' || cls === 'wood') return 'tree';
      if (cls === 'grass' || cls === 'meadow' || cls === 'farmland') return 'grass';
      if (cls === 'sand') return 'sand';
      return 'grass'; // default landcover → grass
    }
    case 'park':
      return 'grass';
    case 'landuse': {
      const lc = feature.properties.class || '';
      if (lc === 'residential' || lc === 'commercial' || lc === 'industrial') return null;
      if (lc === 'cemetery' || lc === 'park') return 'grass';
      return null;
    }
    case 'transportation':
      return 'road';
    default:
      return null;
  }
}

/** Extract centroid [lon, lat] from a GeoJSON geometry. */
export function getFeatureCentroid(feature: MVTFeature): [number, number] | null {
  const geom = feature.geometry;
  if (!geom) return null;

  if (geom.type === 'Point') {
    return geom.coordinates as [number, number];
  }

  // For polygons/multipolygons, compute centroid of first ring
  let coords: number[][] | undefined;
  if (geom.type === 'Polygon') {
    coords = (geom as GeoJSON.Polygon).coordinates[0] as number[][];
  } else if (geom.type === 'MultiPolygon') {
    coords = (geom as GeoJSON.MultiPolygon).coordinates[0]?.[0] as number[][];
  } else if (geom.type === 'LineString') {
    coords = (geom as GeoJSON.LineString).coordinates as number[][];
  } else if (geom.type === 'MultiLineString') {
    coords = (geom as GeoJSON.MultiLineString).coordinates[0] as number[][];
  }

  if (!coords || coords.length === 0) return null;

  let sumLon = 0;
  let sumLat = 0;
  for (const c of coords) {
    sumLon += c[0];
    sumLat += c[1];
  }
  return [sumLon / coords.length, sumLat / coords.length];
}

/**
 * Compute geographic bounds of route points with corridor expansion.
 */
export function computeRouteBounds(
  points: RoutePoint[],
): { south: number; north: number; west: number; east: number } {
  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
  for (const pt of points) {
    if (pt.lat < south) south = pt.lat;
    if (pt.lat > north) north = pt.lat;
    if (pt.lon < west) west = pt.lon;
    if (pt.lon > east) east = pt.lon;
  }

  // Expand bounds by corridor
  const latExpand = FEATURE_CORRIDOR_M / 111320;
  const lonExpand = FEATURE_CORRIDOR_M / (111320 * Math.cos(((south + north) / 2) * Math.PI / 180));
  south -= latExpand;
  north += latExpand;
  west -= lonExpand;
  east += lonExpand;

  return { south, north, west, east };
}
