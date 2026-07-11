/**
 * Unit tests for route-geometry interpolation.
 *
 * Runs against the built output (dist/) with Node's built-in test runner —
 * no test framework dependency. Run via `npm test -w packages/shared`
 * (builds first).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCumulativeDistances,
  interpolateAlongRoute,
  computeSmoothedBearing,
  totalRouteDistance,
} from '../dist/route-geometry.js';

// A straight north-heading route along a meridian: each 0.001° lat ≈ 111.2 m.
// Using a meridian keeps segment lengths uniform and bearings exactly 0°.
const STRAIGHT = [
  { lat: 25.000, lon: 121.5, ele: 10 },
  { lat: 25.001, lon: 121.5, ele: 20 },
  { lat: 25.002, lon: 121.5, ele: 30 },
  { lat: 25.003, lon: 121.5, ele: 40 },
];

// An L-shaped route: north leg then east leg.
const L_SHAPE = [
  { lat: 25.000, lon: 121.500, ele: 0 },
  { lat: 25.002, lon: 121.500, ele: 0 },
  { lat: 25.002, lon: 121.502, ele: 0 },
];

test('buildCumulativeDistances starts at 0 and is strictly increasing', () => {
  const dists = buildCumulativeDistances(STRAIGHT);
  assert.equal(dists.length, STRAIGHT.length);
  assert.equal(dists[0], 0);
  for (let i = 1; i < dists.length; i++) {
    assert.ok(dists[i] > dists[i - 1], `dists[${i}] > dists[${i - 1}]`);
  }
  // 0.003° of latitude ≈ 333.6 m (within 1%)
  const total = dists[dists.length - 1];
  assert.ok(Math.abs(total - 333.6) < 3.5, `total ≈ 333.6m, got ${total}`);
});

test('interpolateAlongRoute at distance 0 returns the first point', () => {
  const dists = buildCumulativeDistances(STRAIGHT);
  const pos = interpolateAlongRoute(STRAIGHT, dists, 0);
  assert.equal(pos.lat, STRAIGHT[0].lat);
  assert.equal(pos.lon, STRAIGHT[0].lon);
  assert.equal(pos.ele, STRAIGHT[0].ele);
});

test('interpolateAlongRoute at total distance returns the last point', () => {
  const dists = buildCumulativeDistances(STRAIGHT);
  const total = dists[dists.length - 1];
  const pos = interpolateAlongRoute(STRAIGHT, dists, total);
  assert.ok(Math.abs(pos.lat - STRAIGHT[3].lat) < 1e-9);
  assert.ok(Math.abs(pos.ele - STRAIGHT[3].ele) < 1e-9);
});

test('interpolateAlongRoute midway through a segment lerps lat/ele', () => {
  const dists = buildCumulativeDistances(STRAIGHT);
  // Halfway into the first segment
  const pos = interpolateAlongRoute(STRAIGHT, dists, dists[1] / 2);
  assert.ok(Math.abs(pos.lat - 25.0005) < 1e-6, `lat ≈ 25.0005, got ${pos.lat}`);
  assert.ok(Math.abs(pos.ele - 15) < 0.01, `ele ≈ 15, got ${pos.ele}`);
  assert.equal(pos.lon, 121.5);
});

test('interpolateAlongRoute clamps: negative and beyond-total distances', () => {
  const dists = buildCumulativeDistances(STRAIGHT);
  const total = dists[dists.length - 1];

  const before = interpolateAlongRoute(STRAIGHT, dists, -50);
  assert.equal(before.lat, STRAIGHT[0].lat);

  const after = interpolateAlongRoute(STRAIGHT, dists, total + 500);
  assert.ok(Math.abs(after.lat - STRAIGHT[3].lat) < 1e-9);
});

test('interpolateAlongRoute on empty route returns zeros', () => {
  const pos = interpolateAlongRoute([], [], 100);
  assert.deepEqual(pos, { lat: 0, lon: 0, ele: 0, bearing: 0 });
});

test('bearing on a straight north route is ~0°', () => {
  const dists = buildCumulativeDistances(STRAIGHT);
  const pos = interpolateAlongRoute(STRAIGHT, dists, dists[2] / 2);
  // 0° or 360° both mean north
  const b = pos.bearing % 360;
  assert.ok(b < 0.5 || b > 359.5, `bearing ≈ 0°, got ${pos.bearing}`);
});

test('smoothed bearing transitions gradually through the L corner', () => {
  const dists = buildCumulativeDistances(L_SHAPE);
  const cornerD = dists[1]; // distance at the corner point

  const before = computeSmoothedBearing(L_SHAPE, dists, cornerD - 50);
  const atCorner = computeSmoothedBearing(L_SHAPE, dists, cornerD);
  const after = computeSmoothedBearing(L_SHAPE, dists, cornerD + 50);

  // Well before: ~north (0°). Well after: ~east (90°). At corner: in between.
  assert.ok(before < 5 || before > 355, `before ≈ 0°, got ${before}`);
  assert.ok(Math.abs(after - 90) < 5, `after ≈ 90°, got ${after}`);
  assert.ok(atCorner > 5 && atCorner < 85, `corner between 0° and 90°, got ${atCorner}`);
});

test('totalRouteDistance matches cumulativeDistances tail within float tolerance', () => {
  // The sim must use cumulativeDistances[last] as its lap length (they are
  // computed by the same haversine, so they should agree to float precision).
  const dists = buildCumulativeDistances(STRAIGHT);
  const total = totalRouteDistance(STRAIGHT);
  assert.ok(
    Math.abs(total - dists[dists.length - 1]) < 1e-6,
    `totalRouteDistance ${total} ≈ cumulative tail ${dists[dists.length - 1]}`,
  );
});
