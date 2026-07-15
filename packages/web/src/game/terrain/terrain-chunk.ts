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
import type { TerrainStyleStrategy } from './terrain-style-strategy';
import {
  buildQuantizedCorridorGeometry,
  quantizedDataToGeometry,
} from './quantized-terrain';
import { computeSmoothedBearing } from '../route-geometry';

/** Default half-width of the corridor in meters. */
const DEFAULT_CORRIDOR_HALF_WIDTH = 500;

/** Clamp the cross-column count (across the corridor) for perf/stitching. */
const MIN_CROSS = 5;
const MAX_CROSS = 81;
/** Clamp the along-route section count. */
const MAX_SECTIONS = 240;


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
  /** Flat array of xyz positions (length = crossCount * 3). */
  positions: number[];
  /** Flat array of rgb colors (length = crossCount * 3). */
  colors: number[];
  /** Geographic coords for each vertex in the edge (length = crossCount). */
  geoCoords: { lat: number; lon: number }[];
  /** ABSOLUTE elevation per edge vertex (length = crossCount). Used by the
   *  quantised builder so the shared edge snaps to the same layer either side. */
  eles: number[];
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
  strategy: TerrainStyleStrategy,
): Promise<TerrainChunkResult> {
  const { points, startIdx, endIdx, chunkIndex } = input;
  const corridorHalfWidth = input.corridorHalfWidth ?? DEFAULT_CORRIDOR_HALF_WIDTH;
  const segPoints = points.slice(startIdx, endIdx + 1);
  const params = strategy.params;

  // Grid resolution driven by the style's gridSize (world-aligned cell size).
  const gridSize = Math.max(4, params.gridSize);
  let crossCount = Math.round((corridorHalfWidth * 2) / gridSize) + 1;
  crossCount = Math.max(MIN_CROSS, Math.min(MAX_CROSS, crossCount));
  if (crossCount % 2 === 0) crossCount += 1; // keep a center column for the GPX blend
  const centerCol = Math.floor(crossCount / 2);

  const segLength =
    input.cumulativeDistances[endIdx] - input.cumulativeDistances[startIdx];
  let numSections = Math.max(2, Math.round(segLength / gridSize) + 1);
  numSections = Math.min(numSections, MAX_SECTIONS);

  // Sampled corridor grid (row-major over sections × cross columns).
  const gx: number[] = [];
  const gz: number[] = [];
  const gele: number[] = [];       // ABSOLUTE elevation
  const gcol: number[] = [];       // rgb per vertex
  const geoCoords: { lat: number; lon: number }[] = [];

  const cosOrigin = Math.cos((originLat * Math.PI) / 180);

  // Prefetch every DEM tile covering this corridor up front, so the per-vertex
  // sampling loop below can read elevations synchronously (getElevationSync)
  // instead of awaiting a microtask per vertex (~10k awaits/chunk). One await
  // here replaces thousands and keeps the main thread from thrashing mid-build.
  {
    let bs = Infinity, bn = -Infinity, bw = Infinity, be = -Infinity;
    for (const p of segPoints) {
      if (p.lat < bs) bs = p.lat;
      if (p.lat > bn) bn = p.lat;
      if (p.lon < bw) bw = p.lon;
      if (p.lon > be) be = p.lon;
    }
    const latPad = (corridorHalfWidth + gridSize) / 111320;
    const lonPad = latPad / Math.max(0.1, cosOrigin);
    try {
      await sampler.prefetchBounds({
        south: bs - latPad, north: bn + latPad,
        west: bw - lonPad, east: be + lonPad,
      });
    } catch {
      // Offline / tile fetch failed — sync sampling falls back to GPX per vertex.
    }
  }

  // Only reuse the previous edge if its width matches (else the grid resolution
  // changed — e.g. a live gridSize tweak — and we sample a fresh edge).
  const prevEdge =
    input.prevEdge && input.prevEdge.geoCoords.length === crossCount
      ? input.prevEdge
      : undefined;

  for (let s = 0; s < numSections; s++) {
    // First section: reuse previous chunk's last edge for a seamless join.
    if (s === 0 && prevEdge) {
      for (let c = 0; c < crossCount; c++) {
        gx.push(prevEdge.positions[c * 3]);
        gz.push(prevEdge.positions[c * 3 + 2]);
        gele.push(prevEdge.eles[c]);
        gcol.push(prevEdge.colors[c * 3], prevEdge.colors[c * 3 + 1], prevEdge.colors[c * 3 + 2]);
        geoCoords.push(prevEdge.geoCoords[c]);
      }
      continue;
    }

    const t = s / (numSections - 1);
    const ptIdx = Math.min(
      Math.floor(t * (segPoints.length - 1)),
      segPoints.length - 2,
    );
    const localT = t * (segPoints.length - 1) - ptIdx;

    // Interpolate position on route
    const a = segPoints[ptIdx];
    const b = segPoints[ptIdx + 1];
    const lat = a.lat + (b.lat - a.lat) * localT;
    const lon = a.lon + (b.lon - a.lon) * localT;

    // Smoothed bearing for perpendicular cross-section (prevents overlap at sharp turns)
    const absDistance = input.cumulativeDistances[startIdx] + t * segLength;
    const bearing = computeSmoothedBearing(points, input.cumulativeDistances, absDistance);
    const perpRad = ((bearing + 90) * Math.PI) / 180;

    for (let c = 0; c < crossCount; c++) {
      const offset = ((c / (crossCount - 1)) * 2 - 1) * corridorHalfWidth;

      // Offset point perpendicular to route
      const sampleLat = lat + (offset * Math.cos(perpRad)) / 111320;
      const sampleLon = lon + (offset * Math.sin(perpRad)) / (111320 * cosOrigin);

      // Get elevation from DEM (synchronous — tiles were prefetched above).
      // Null (uncached tile / fetch failure) falls back to GPX interpolation.
      const sampled = sampler.getElevationSync(sampleLat, sampleLon);
      let ele = sampled !== null ? sampled : a.ele + (b.ele - a.ele) * localT;

      // For the center column, blend with GPX elevation to prevent ball floating/sinking
      if (c === centerCol) {
        const gpxEle = a.ele + (b.ele - a.ele) * localT;
        ele = ele * 0.5 + gpxEle * 0.5;
      }

      // Convert to scene coordinates (meters from origin)
      const x = (sampleLon - originLon) * 111320 * cosOrigin;
      const z = -(sampleLat - originLat) * 111320; // negate: +lat = north = -z in Three.js

      gx.push(x);
      gz.push(z);
      gele.push(ele);
      geoCoords.push({ lat: sampleLat, lon: sampleLon });

      // Procedural vertex color from the active style (same-zone-same-colour).
      const color = strategy.terrainVertexColor(ele, x, z);
      gcol.push(color.r, color.g, color.b);
    }
  }

  // Capture last section edge data for next chunk stitching (absolute eles too).
  const lastEdgeStart = (numSections - 1) * crossCount;
  const edgePositions: number[] = [];
  for (let c = 0; c < crossCount; c++) {
    const gi = lastEdgeStart + c;
    edgePositions.push(gx[gi], gele[gi] - originEle, gz[gi]);
  }
  const lastEdge: ChunkEdgeData = {
    positions: edgePositions,
    colors: gcol.slice(lastEdgeStart * 3, (lastEdgeStart + crossCount) * 3),
    geoCoords: geoCoords.slice(lastEdgeStart, lastEdgeStart + crossCount),
    eles: gele.slice(lastEdgeStart, lastEdgeStart + crossCount),
  };

  // Build geometry — quantised blocks/sheets, or the smooth ramp fallback.
  let geometry: THREE.BufferGeometry;
  let material: THREE.Material | THREE.Material[];
  if (params.quantEnabled) {
    const data = buildQuantizedCorridorGeometry(
      { gx, gz, gele, gcol, along: numSections, cross: crossCount },
      strategy,
      originEle,
    );
    geometry = quantizedDataToGeometry(data);
    // Group 0 = printed top faces, group 1 = cut-edge walls. A style may give
    // the walls their own material (paper → raw corrugated cardboard).
    material = [
      strategy.createTerrainMaterial(),
      strategy.createTerrainWallMaterial?.() ?? strategy.createTerrainMaterial(),
    ];
  } else {
    const positions: number[] = [];
    const uvs: number[] = [];
    for (let i = 0; i < gx.length; i++) {
      positions.push(gx[i], gele[i] - originEle, gz[i]);
      // World-plane UVs (raw metres) — same convention as the quantised tops.
      uvs.push(gx[i], gz[i]);
    }
    const indices: number[] = [];
    for (let s = 0; s < numSections - 1; s++) {
      for (let c = 0; c < crossCount - 1; c++) {
        const i0 = s * crossCount + c;
        const i1 = i0 + 1;
        const i2 = i0 + crossCount;
        const i3 = i2 + 1;
        indices.push(i0, i2, i1);
        indices.push(i1, i2, i3);
      }
    }
    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(gcol, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    // Smooth ramp: single style material with procedural vertex colors.
    material = strategy.createTerrainMaterial();
  }

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
