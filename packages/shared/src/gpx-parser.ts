/**
 * GPX/TCX parser — extracts route points from XML.
 * Works in both Node.js and browser (uses DOMParser).
 */

import type { RoutePoint } from './types.js';

/**
 * Parse a GPX XML string into an array of route points.
 */
export function parseGpx(xml: string): RoutePoint[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');
  const points: RoutePoint[] = [];

  const trkpts = doc.getElementsByTagName('trkpt');
  for (let i = 0; i < trkpts.length; i++) {
    const pt = trkpts[i];
    const lat = parseFloat(pt.getAttribute('lat') ?? '0');
    const lon = parseFloat(pt.getAttribute('lon') ?? '0');

    const eleEl = pt.getElementsByTagName('ele')[0];
    const ele = eleEl ? parseFloat(eleEl.textContent ?? '0') : 0;

    const timeEl = pt.getElementsByTagName('time')[0];
    const tsEpoch = timeEl ? new Date(timeEl.textContent ?? '').getTime() : undefined;

    points.push({ lat, lon, ele, tsEpoch: tsEpoch && !isNaN(tsEpoch) ? tsEpoch : undefined });
  }

  return points;
}

/**
 * Parse a TCX XML string into an array of route points.
 */
export function parseTcx(xml: string): RoutePoint[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');
  const points: RoutePoint[] = [];

  const trackpoints = doc.getElementsByTagName('Trackpoint');
  for (let i = 0; i < trackpoints.length; i++) {
    const tp = trackpoints[i];
    const posEl = tp.getElementsByTagName('Position')[0];
    if (!posEl) continue;

    const latEl = posEl.getElementsByTagName('LatitudeDegrees')[0];
    const lonEl = posEl.getElementsByTagName('LongitudeDegrees')[0];
    if (!latEl || !lonEl) continue;

    const lat = parseFloat(latEl.textContent ?? '0');
    const lon = parseFloat(lonEl.textContent ?? '0');

    const altEl = tp.getElementsByTagName('AltitudeMeters')[0];
    const ele = altEl ? parseFloat(altEl.textContent ?? '0') : 0;

    const timeEl = tp.getElementsByTagName('Time')[0];
    const tsEpoch = timeEl ? new Date(timeEl.textContent ?? '').getTime() : undefined;

    points.push({ lat, lon, ele, tsEpoch: tsEpoch && !isNaN(tsEpoch) ? tsEpoch : undefined });
  }

  return points;
}

/**
 * Auto-detect file format and parse.
 * @param xml - Raw XML string
 * @param filename - Optional filename for format detection
 */
export function parseRouteFile(xml: string, filename?: string): RoutePoint[] {
  const lower = filename?.toLowerCase() ?? '';
  if (lower.endsWith('.tcx') || xml.includes('<TrainingCenterDatabase')) {
    return parseTcx(xml);
  }
  return parseGpx(xml);
}

/**
 * Calculate total route distance in meters using Haversine formula.
 */
export function calcRouteDistance(points: RoutePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversine(points[i - 1], points[i]);
  }
  return total;
}

/**
 * Calculate total elevation gain in meters (only counts climbs, not descents).
 */
export function calcElevationGain(points: RoutePoint[]): number {
  let gain = 0;
  for (let i = 1; i < points.length; i++) {
    const diff = points[i].ele - points[i - 1].ele;
    if (diff > 0) gain += diff;
  }
  return gain;
}

function haversine(a: RoutePoint, b: RoutePoint): number {
  const R = 6371000; // Earth radius in meters
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
