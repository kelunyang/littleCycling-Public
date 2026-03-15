/**
 * Zone detector: determines the environment type at the rider's current
 * position by sampling nearby MVT features.
 *
 * Priority: tunnel > forest > urban > open
 */

import type { MVTFeature } from './mvt-fetcher';

export type ZoneType = 'urban' | 'forest' | 'tunnel' | 'open';

/**
 * Detect the zone type at (lat, lon) from cached MVT features.
 *
 * @param lat  Rider latitude
 * @param lon  Rider longitude
 * @param features  MVT features from the current chunk
 */
export function detectZone(
  lat: number,
  lon: number,
  features: MVTFeature[],
): ZoneType {
  // 1. Tunnel — check if nearest transportation segment has brunnel=tunnel
  if (isInTunnel(lat, lon, features)) return 'tunnel';

  // 2. Forest — point-in-polygon for landcover wood/forest
  if (isInForest(lat, lon, features)) return 'forest';

  // 3. Urban — point-in-polygon for landuse residential/commercial/industrial
  //    OR high building density nearby
  if (isInUrban(lat, lon, features)) return 'urban';

  return 'open';
}

// ── Tunnel detection ──

/** Max distance (in degrees, ~30m ≈ 0.00027°) to consider a road segment. */
const TUNNEL_DISTANCE_DEG = 0.0003;

function isInTunnel(lat: number, lon: number, features: MVTFeature[]): boolean {
  for (const f of features) {
    if (f.layer !== 'transportation') continue;
    if (f.properties.brunnel !== 'tunnel') continue;

    // Check if any segment of this feature is close to (lat, lon)
    const coords = extractLineCoords(f);
    for (const line of coords) {
      for (let i = 0; i < line.length - 1; i++) {
        const dist = pointToSegmentDistDeg(
          lon, lat,
          line[i][0], line[i][1],
          line[i + 1][0], line[i + 1][1],
        );
        if (dist < TUNNEL_DISTANCE_DEG) return true;
      }
    }
  }
  return false;
}

// ── Forest detection ──

function isInForest(lat: number, lon: number, features: MVTFeature[]): boolean {
  for (const f of features) {
    if (f.layer !== 'landcover') continue;
    const cls = f.properties.class;
    if (cls !== 'wood' && cls !== 'forest') continue;

    if (isPointInFeaturePolygon(lon, lat, f)) return true;
  }
  return false;
}

// ── Urban detection ──

/** Radius in degrees (~50m) for building density check. */
const BUILDING_RADIUS_DEG = 0.00045;
const BUILDING_COUNT_THRESHOLD = 5;

function isInUrban(lat: number, lon: number, features: MVTFeature[]): boolean {
  // Check landuse polygons first
  for (const f of features) {
    if (f.layer !== 'landuse') continue;
    const cls = f.properties.class;
    if (cls !== 'residential' && cls !== 'commercial' && cls !== 'industrial' && cls !== 'retail') continue;

    if (isPointInFeaturePolygon(lon, lat, f)) return true;
  }

  // Fallback: count nearby buildings
  let buildingCount = 0;
  for (const f of features) {
    if (f.layer !== 'building') continue;
    // Use centroid approximation from first coordinate
    const firstCoord = getFirstCoord(f);
    if (!firstCoord) continue;
    const dLon = firstCoord[0] - lon;
    const dLat = firstCoord[1] - lat;
    if (dLon * dLon + dLat * dLat < BUILDING_RADIUS_DEG * BUILDING_RADIUS_DEG) {
      buildingCount++;
      if (buildingCount >= BUILDING_COUNT_THRESHOLD) return true;
    }
  }

  return false;
}

// ── Geometry helpers ──

/** Extract line coordinates from a transportation feature. */
function extractLineCoords(feature: MVTFeature): [number, number][][] {
  const geom = feature.geometry;
  if (geom.type === 'LineString') {
    return [(geom as GeoJSON.LineString).coordinates as [number, number][]];
  }
  if (geom.type === 'MultiLineString') {
    return (geom as GeoJSON.MultiLineString).coordinates as [number, number][][];
  }
  return [];
}

/** Get the first coordinate of any feature geometry. */
function getFirstCoord(feature: MVTFeature): [number, number] | null {
  const geom = feature.geometry;
  if (geom.type === 'Point') {
    return (geom as GeoJSON.Point).coordinates as [number, number];
  }
  if (geom.type === 'Polygon') {
    const ring = (geom as GeoJSON.Polygon).coordinates[0];
    return ring?.[0] as [number, number] ?? null;
  }
  if (geom.type === 'MultiPolygon') {
    const ring = (geom as GeoJSON.MultiPolygon).coordinates[0]?.[0];
    return ring?.[0] as [number, number] ?? null;
  }
  return null;
}

/** Check if (px, py) is inside any polygon of a feature. */
function isPointInFeaturePolygon(px: number, py: number, feature: MVTFeature): boolean {
  const geom = feature.geometry;
  if (geom.type === 'Polygon') {
    const ring = (geom as GeoJSON.Polygon).coordinates[0] as [number, number][];
    return pointInPolygon(px, py, ring);
  }
  if (geom.type === 'MultiPolygon') {
    const polys = (geom as GeoJSON.MultiPolygon).coordinates;
    for (const poly of polys) {
      if (pointInPolygon(px, py, poly[0] as [number, number][])) return true;
    }
  }
  return false;
}

/**
 * Point-in-polygon test using winding number algorithm.
 * (px, py) is the test point; ring is an array of [x, y] vertices.
 */
export function pointInPolygon(px: number, py: number, ring: [number, number][]): boolean {
  let winding = 0;
  const n = ring.length;

  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];

    if (y1 <= py) {
      if (y2 > py) {
        // Upward crossing
        if (isLeft(x1, y1, x2, y2, px, py) > 0) winding++;
      }
    } else {
      if (y2 <= py) {
        // Downward crossing
        if (isLeft(x1, y1, x2, y2, px, py) < 0) winding--;
      }
    }
  }

  return winding !== 0;
}

/** Is point (px, py) left of line (x1,y1)→(x2,y2)? >0 = left, <0 = right, 0 = on. */
function isLeft(
  x1: number, y1: number,
  x2: number, y2: number,
  px: number, py: number,
): number {
  return (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1);
}

/**
 * Approximate distance from point (px, py) to line segment (x1,y1)→(x2,y2).
 * All in degrees — sufficient for short-distance comparison.
 */
function pointToSegmentDistDeg(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;

  if (lenSq < 1e-12) {
    // Degenerate segment
    const ddx = px - x1;
    const ddy = py - y1;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }

  // Project point onto segment, clamped to [0, 1]
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const closestX = x1 + t * dx;
  const closestY = y1 + t * dy;
  const ddx = px - closestX;
  const ddy = py - closestY;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}
