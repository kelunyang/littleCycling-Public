/**
 * Terrain chunk: a corridor-shaped mesh (~2km long × 400m wide) built
 * from DEM elevation data along a segment of the GPX route.
 *
 * The corridor is constructed by sampling elevation along cross-sections
 * perpendicular to the route direction, then building a BufferGeometry
 * from the resulting vertex grid.
 *
 * Surface: MeshToonMaterial with procedural vertex colors (neon/graffiti palette).
 * No raster satellite tiles — all colors are procedurally generated.
 */

import * as THREE from 'three';
import type { RoutePoint } from '@littlecycling/shared';
import type { ElevationSampler } from './elevation-sampler';
import { terrainVertexColor, createTerrainToonMaterial } from './cartoon-materials';
import { computeSmoothedBearing } from '../route-geometry';

/** Default half-width of the corridor in meters. */
const DEFAULT_CORRIDOR_HALF_WIDTH = 500;

/** Number of cross-section sample points (across the corridor). */
const CROSS_SAMPLES = 21;

/** Approximate spacing between cross-sections along the route (meters). */
const ALONG_SPACING = 30;


export interface ChunkBuildInput {
  /** Route points for this chunk segment. */
  points: RoutePoint[];
  /** Cumulative distances matching `points`, relative to route start. */
  cumulativeDistances: number[];
  /** Start index into the route for this chunk. */
  startIdx: number;
  /** End index into the route for this chunk. */
  endIdx: number;
  /** Chunk index (0-based, sequential along route). */
  chunkIndex: number;
  /** Last cross-section vertex data from previous chunk (for seamless joining). */
  prevEdge?: ChunkEdgeData;
  /** Corridor half-width in meters (overrides default). */
  corridorHalfWidth?: number;
}

/** Vertex data for one cross-section edge, used to stitch chunks seamlessly. */
export interface ChunkEdgeData {
  /** Flat array of xyz positions (length = CROSS_SAMPLES * 3). */
  positions: number[];
  /** Flat array of rgb colors (length = CROSS_SAMPLES * 3). */
  colors: number[];
  /** Geographic coords for each vertex in the edge (length = CROSS_SAMPLES). */
  geoCoords: { lat: number; lon: number }[];
}

export interface TerrainChunkResult {
  mesh: THREE.Mesh;
  chunkIndex: number;
  /** Center of this chunk in geographic coords (for positioning). */
  centerLat: number;
  centerLon: number;
  centerEle: number;
  /** Last cross-section data for stitching with the next chunk. */
  lastEdge: ChunkEdgeData;
}

/**
 * Build a terrain mesh for one route chunk.
 *
 * @param input - Route segment info
 * @param sampler - DEM elevation sampler
 * @param originLat - Scene origin latitude (floating origin)
 * @param originLon - Scene origin longitude
 * @param originEle - Scene origin elevation
 */
export async function buildTerrainChunk(
  input: ChunkBuildInput,
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
): Promise<TerrainChunkResult> {
  const { points, startIdx, endIdx, chunkIndex } = input;
  const corridorHalfWidth = input.corridorHalfWidth ?? DEFAULT_CORRIDOR_HALF_WIDTH;
  const segPoints = points.slice(startIdx, endIdx + 1);

  // Sample cross-sections along the route segment
  const segLength =
    input.cumulativeDistances[endIdx] - input.cumulativeDistances[startIdx];
  const numSections = Math.max(2, Math.round(segLength / ALONG_SPACING) + 1);

  // Build cross-section sample points
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  // Track geographic coordinates for UV mapping
  const geoCoords: { lat: number; lon: number }[] = [];

  const cosOrigin = Math.cos((originLat * Math.PI) / 180);

  const { prevEdge } = input;

  for (let s = 0; s < numSections; s++) {
    // First section: use previous chunk's last edge if available (seamless join)
    if (s === 0 && prevEdge) {
      for (let c = 0; c < CROSS_SAMPLES; c++) {
        positions.push(
          prevEdge.positions[c * 3],
          prevEdge.positions[c * 3 + 1],
          prevEdge.positions[c * 3 + 2],
        );
        colors.push(
          prevEdge.colors[c * 3],
          prevEdge.colors[c * 3 + 1],
          prevEdge.colors[c * 3 + 2],
        );
        geoCoords.push(prevEdge.geoCoords[c]);
      }
      continue;
    }

    const t = s / (numSections - 1);
    const ptIdx = Math.min(
      Math.floor(t * (segPoints.length - 1)),
      segPoints.length - 2,
    );
    const localT =
      t * (segPoints.length - 1) - ptIdx;

    // Interpolate position on route
    const a = segPoints[ptIdx];
    const b = segPoints[ptIdx + 1];
    const lat = a.lat + (b.lat - a.lat) * localT;
    const lon = a.lon + (b.lon - a.lon) * localT;

    // Smoothed bearing for perpendicular cross-section (prevents overlap at sharp turns)
    const absDistance = input.cumulativeDistances[startIdx] + t * segLength;
    const bearing = computeSmoothedBearing(points, input.cumulativeDistances, absDistance);
    const perpRad = ((bearing + 90) * Math.PI) / 180;

    for (let c = 0; c < CROSS_SAMPLES; c++) {
      const offset =
        ((c / (CROSS_SAMPLES - 1)) * 2 - 1) * corridorHalfWidth;

      // Offset point perpendicular to route
      const sampleLat = lat + (offset * Math.cos(perpRad)) / 111320;
      const sampleLon = lon + (offset * Math.sin(perpRad)) / (111320 * cosOrigin);

      // Get elevation from DEM
      let ele: number;
      try {
        ele = await sampler.getElevation(sampleLat, sampleLon);
      } catch {
        ele = a.ele + (b.ele - a.ele) * localT; // fallback to GPX
      }

      // For the center column, blend with GPX elevation to prevent ball floating/sinking
      if (c === Math.floor(CROSS_SAMPLES / 2)) {
        const gpxEle = a.ele + (b.ele - a.ele) * localT;
        ele = ele * 0.5 + gpxEle * 0.5;
      }

      // Convert to scene coordinates (meters from origin)
      const x = (sampleLon - originLon) * 111320 * cosOrigin;
      const z = -(sampleLat - originLat) * 111320; // negate: +lat = north = -z in Three.js
      const y = ele - originEle;

      positions.push(x, y, z);
      geoCoords.push({ lat: sampleLat, lon: sampleLon });

      // Neon/graffiti procedural vertex color with noise variation
      const color = terrainVertexColor(ele, x, z);
      colors.push(color.r, color.g, color.b);
    }
  }

  // Capture last section edge data for next chunk stitching
  const lastEdgeStart = (numSections - 1) * CROSS_SAMPLES;
  const lastEdge: ChunkEdgeData = {
    positions: positions.slice(lastEdgeStart * 3, (lastEdgeStart + CROSS_SAMPLES) * 3),
    colors: colors.slice(lastEdgeStart * 3, (lastEdgeStart + CROSS_SAMPLES) * 3),
    geoCoords: geoCoords.slice(lastEdgeStart, lastEdgeStart + CROSS_SAMPLES),
  };

  // Build triangle indices (grid topology)
  for (let s = 0; s < numSections - 1; s++) {
    for (let c = 0; c < CROSS_SAMPLES - 1; c++) {
      const i0 = s * CROSS_SAMPLES + c;
      const i1 = i0 + 1;
      const i2 = i0 + CROSS_SAMPLES;
      const i3 = i2 + 1;

      indices.push(i0, i2, i1);
      indices.push(i1, i2, i3);
    }
  }

  // Build geometry
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(colors, 3),
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  // Toon material with procedural vertex colors (no raster tiles needed)
  const material = createTerrainToonMaterial();
  const mesh = new THREE.Mesh(geometry, material);

  // Chunk center for reference
  const midIdx = Math.floor((startIdx + endIdx) / 2);
  const centerPt = points[midIdx];

  return {
    mesh,
    chunkIndex,
    centerLat: centerPt.lat,
    centerLon: centerPt.lon,
    centerEle: centerPt.ele,
    lastEdge,
  };
}

// ── Helpers ──

export function computeGeoBounds(
  coords: { lat: number; lon: number }[],
): { south: number; north: number; west: number; east: number } {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const c of coords) {
    if (c.lat < south) south = c.lat;
    if (c.lat > north) north = c.lat;
    if (c.lon < west) west = c.lon;
    if (c.lon > east) east = c.lon;
  }
  return { south, north, west, east };
}
