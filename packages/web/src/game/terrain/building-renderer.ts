/**
 * Building renderer: fetches building footprints from vector tiles and
 * renders them as gray extruded meshes in the Three.js scene.
 *
 * Data source options:
 * A) Hidden MapLibre instance: querySourceFeatures('building')
 * B) Direct MVT fetch + @mapbox/vector-tile + pbf decode
 *
 * Currently uses approach A (simplest, leverages existing MapLibre setup).
 * Buildings are cached with terrain chunks — same lifecycle.
 */

import * as THREE from 'three';
import type { ElevationSampler } from './elevation-sampler';
import type { MVTFeature } from './mvt-fetcher';
import {
  mulberry32,
  type BuildingBox,
  type FacadeWindowStyle,
  type TerrainStyleStrategy,
} from './terrain-style-strategy';
import {
  collectBuildingWindows,
  buildWindowLightMesh,
  buildPlacementInstancedMesh,
  disposeWindowLightMesh,
  type WindowPlacement,
} from './building-lights';

/** Cap on batched facade windows per chunk (they subsample evenly past this —
 *  same guard the window lights have, sized up for the bigger decorative geo). */
const FACADE_WINDOW_MAX_PER_CHUNK = 3000;

/** Default building height when data is missing (meters). */
const DEFAULT_BUILDING_HEIGHT = 8;

export interface BuildingFootprint {
  /** Polygon coordinates [[lon, lat], ...] — outer ring only. */
  coordinates: [number, number][];
  /** Building height in meters (from vector tile or default). */
  height: number;
}

export interface BuildingRenderResult {
  /** Combined mesh for all buildings in this chunk. */
  mesh: THREE.Mesh;
  /** Number of buildings rendered. */
  buildingCount: number;
  /** Warm window lights on the facades — faded in at night (F2). */
  lightsMesh?: THREE.InstancedMesh;
}

/**
 * Only footprints that actually fill their oriented bounding box get style trim
 * (a boxy roof on an L-shaped block would hang in mid-air). Ragged footprints
 * keep the plain extrusion.
 */
const OBB_FILL_THRESHOLD = 0.55;

/**
 * Build extruded building meshes from footprint data.
 *
 * @param footprints - Building footprint polygons with heights
 * @param sampler - Elevation sampler to get building base height
 * @param originLat - Scene floating origin latitude
 * @param originLon - Scene floating origin longitude
 * @param originEle - Scene floating origin elevation
 */
export async function buildBuildingMeshes(
  footprints: BuildingFootprint[],
  sampler: ElevationSampler,
  originLat: number,
  originLon: number,
  originEle: number,
  strategy: TerrainStyleStrategy,
): Promise<BuildingRenderResult> {
  if (footprints.length === 0) {
    return { mesh: new THREE.Mesh(), buildingCount: 0 };
  }

  const cosOrigin = Math.cos((originLat * Math.PI) / 180);
  const geometries: THREE.BufferGeometry[] = [];
  const decoration = new THREE.Group();
  let decorationCount = 0;
  const windows: WindowPlacement[] = [];
  const facadeWindows: WindowPlacement[] = [];

  for (let fpIdx = 0; fpIdx < footprints.length; fpIdx++) {
    const fp = footprints[fpIdx];
    const shape = footprintToShape(fp.coordinates, originLat, originLon, cosOrigin);
    if (!shape) continue;

    // Get base elevation at footprint centroid
    const centroid = polygonCentroid(fp.coordinates);
    let baseEle: number;
    try {
      baseEle = await sampler.getElevation(centroid[1], centroid[0]);
    } catch {
      baseEle = originEle;
    }

    const extrudeSettings: THREE.ExtrudeGeometryOptions = {
      depth: fp.height,
      bevelEnabled: false,
    };

    const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);

    // Position: rotate from XY extrusion to XZ (horizontal) then translate up.
    // Snap the base to the terrain's quantised layer so it sits on the steps.
    const baseY = strategy.quantizeElevation(baseEle) - originEle;
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, baseY, 0);

    // Facade window lights (F2) share that quantised base height.
    collectBuildingWindows(fp.coordinates, originLat, originLon, cosOrigin, baseY, fp.height, windows);

    // Assign vertex color based on building coordinate (same-zone-same-colour).
    // Up-facing vertices optionally take the style's roof colour (paper → raw
    // kraft board so the building reads as a cardboard box).
    const bColor = new THREE.Color(strategy.buildingColor(centroid[0], centroid[1]));
    const topColor = strategy.buildingTopColor !== undefined
      ? new THREE.Color(strategy.buildingTopColor)
      : null;

    // Style trim (roof + windows) — only on box-like footprints.
    const obb = footprintOBB(fp.coordinates, originLat, originLon, cosOrigin);
    if (obb && obb.fill >= OBB_FILL_THRESHOLD) {
      const box = {
        cx: obb.cx,
        cz: obb.cz,
        width: obb.width,
        depth: obb.depth,
        rotY: obb.rotY,
        height: fp.height,
        baseY,
        color: bColor.getHex(),
      };
      const trim = strategy.buildBuildingDecoration(box, fpIdx);
      if (trim) {
        decoration.add(trim);
        decorationCount++;
      }
      // Windows are collected, not built: they get batched into one
      // InstancedMesh for the whole chunk below.
      if (strategy.facadeWindows) {
        collectFacadeWindowPlacements(box, fpIdx, strategy.facadeWindows, facadeWindows);
      }
    }
    const nrm = geometry.attributes.normal as THREE.BufferAttribute | undefined;
    const vCount = geometry.attributes.position.count;
    const colorArr = new Float32Array(vCount * 3);
    for (let v = 0; v < vCount; v++) {
      const c = topColor && nrm && nrm.getY(v) > 0.7 ? topColor : bColor;
      colorArr[v * 3] = c.r;
      colorArr[v * 3 + 1] = c.g;
      colorArr[v * 3 + 2] = c.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));

    geometries.push(geometry);
  }

  if (geometries.length === 0) {
    return { mesh: new THREE.Mesh(), buildingCount: 0 };
  }

  // Merge all building geometries into one for efficient rendering
  const merged = mergeGeometries(geometries);

  // Dispose individual geometries
  for (const g of geometries) g.dispose();

  // Shared singleton material owned by the strategy (do not dispose here).
  const mesh = new THREE.Mesh(merged, strategy.createBuildingMaterial());

  // Ink outline (paper style) — added as a child so it tracks the mesh.
  const outline = strategy.createOutline?.(mesh);
  if (outline) mesh.add(outline);

  // Roof flaps / windows ride along as a child, so the chunk manager's existing
  // add / remove / origin-shift paths cover them for free.
  if (decorationCount > 0) mesh.add(decoration);

  const facades = buildFacadeWindowMesh(strategy, facadeWindows);
  if (facades) mesh.add(facades);

  const lightsMesh = buildWindowLightMesh(windows) ?? undefined;

  return { mesh, buildingCount: footprints.length, lightsMesh };
}

/**
 * Grid one building's facade windows onto its two long faces, in SCENE space —
 * the box centre and rotation are baked in here (once, for every style),
 * because the placements get batched chunk-wide and so cannot ride on a
 * per-building group transform. Exported for the headless diorama check.
 */
export function collectFacadeWindowPlacements(
  box: BuildingBox,
  seed: number,
  style: FacadeWindowStyle,
  out: WindowPlacement[],
): void {
  const rng = mulberry32(seed);
  const cols = Math.max(1, Math.min(4, Math.round(box.width / style.colSpacing)));
  const rows = Math.max(1, Math.min(5, Math.floor(box.height / style.rowSpacing)));
  // An Object3D rotated rotY about +y maps local (x, z) to
  // (x·cos + z·sin, −x·sin + z·cos) — same convention the OBB's rotY assumes.
  const cos = Math.cos(box.rotY);
  const sin = Math.sin(box.rotY);

  for (const side of [-1, 1]) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (rng() < style.skipProb) continue; // a few blanks so it isn't a grid
        const lx = -box.width / 2 + (c + 0.5) * (box.width / cols);
        const lz = (box.depth / 2 + style.faceOffset) * side;
        out.push({
          x: box.cx + lx * cos + lz * sin,
          y: box.baseY + (r + 0.6) * (box.height / (rows + 0.4)),
          z: box.cz - lx * sin + lz * cos,
          rotY: box.rotY + (style.flipBackFace && side < 0 ? Math.PI : 0),
        });
      }
    }
  }
}

/**
 * Batch every building's facade windows in a chunk into ONE InstancedMesh.
 * A downtown chunk runs to a few thousand windows; as individual meshes that
 * was a draw call each, which dwarfed everything else in the chunk.
 *
 * The instance geometry is fresh per chunk (the chunk disposes it); the
 * material is a strategy-owned singleton, so it is tagged `userData.shared`
 * and `disposeBuildingMesh` leaves it alone.
 */
function buildFacadeWindowMesh(
  strategy: TerrainStyleStrategy,
  placements: WindowPlacement[],
): THREE.InstancedMesh | null {
  if (placements.length === 0 || !strategy.facadeWindows) return null;
  const { geometry, material } = strategy.facadeWindows.createTemplate();
  return buildPlacementInstancedMesh(geometry, material, placements, FACADE_WINDOW_MAX_PER_CHUNK);
}

/**
 * Extract building footprints from a hidden MapLibre instance.
 * Queries the 'building' source features within the given bounds.
 */
export function extractBuildingsFromMapLibre(
  map: any,
  bounds: { south: number; north: number; west: number; east: number },
): BuildingFootprint[] {
  const footprints: BuildingFootprint[] = [];

  try {
    // Query rendered features in the building layer
    const features = map.queryRenderedFeatures(undefined, {
      layers: ['building-3d', 'building'],
    });

    if (!features || features.length === 0) return footprints;

    for (const feature of features) {
      if (feature.geometry?.type !== 'Polygon') continue;

      const coords = feature.geometry.coordinates[0] as [number, number][];
      if (!coords || coords.length < 3) continue;

      // Check if building is within our bounds
      const centroid = polygonCentroid(coords);
      if (
        centroid[1] < bounds.south ||
        centroid[1] > bounds.north ||
        centroid[0] < bounds.west ||
        centroid[0] > bounds.east
      ) {
        continue;
      }

      const height =
        feature.properties?.height ??
        feature.properties?.render_height ??
        (feature.properties?.levels ? feature.properties.levels * 3 : DEFAULT_BUILDING_HEIGHT);

      footprints.push({ coordinates: coords, height });
    }
  } catch {
    // MapLibre might not be available or layer might not exist
  }

  return footprints;
}

/**
 * Extract building footprints from MVT features (replaces MapLibre dependency).
 */
export function extractBuildingsFromMVT(
  features: MVTFeature[],
  bounds: { south: number; north: number; west: number; east: number },
): BuildingFootprint[] {
  const footprints: BuildingFootprint[] = [];

  for (const feature of features) {
    if (feature.layer !== 'building') continue;
    if (feature.geometry.type !== 'Polygon') continue;

    const coords = (feature.geometry as GeoJSON.Polygon).coordinates[0] as [number, number][];
    if (!coords || coords.length < 3) continue;

    const centroid = polygonCentroid(coords);
    if (
      centroid[1] < bounds.south ||
      centroid[1] > bounds.north ||
      centroid[0] < bounds.west ||
      centroid[0] > bounds.east
    ) {
      continue;
    }

    const height =
      feature.properties.render_height ??
      feature.properties.height ??
      (feature.properties.levels ? feature.properties.levels * 3 : DEFAULT_BUILDING_HEIGHT);

    footprints.push({ coordinates: coords, height });
  }

  return footprints;
}

// ── Helpers ──

/** Convert a polygon [lon, lat][] to a THREE.Shape in scene meters. */
function footprintToShape(
  coordinates: [number, number][],
  originLat: number,
  originLon: number,
  cosOrigin: number,
): THREE.Shape | null {
  if (coordinates.length < 3) return null;

  const shape = new THREE.Shape();
  const first = coordinates[0];
  const x0 = (first[0] - originLon) * 111320 * cosOrigin;
  const z0 = -(first[1] - originLat) * 111320;

  shape.moveTo(x0, z0);

  for (let i = 1; i < coordinates.length; i++) {
    const x = (coordinates[i][0] - originLon) * 111320 * cosOrigin;
    const z = -(coordinates[i][1] - originLat) * 111320;
    shape.lineTo(x, z);
  }

  shape.closePath();
  return shape;
}

/**
 * Oriented bounding box of a footprint, in scene metres. The box axis is taken
 * from the LONGEST edge — for the rectangular-ish buildings that dominate MVT
 * data that lands within a degree or two of the true minimum-area box, at a
 * fraction of the cost of rotating calipers.
 *
 * `fill` is the polygon's area over the box's area: 1 = a perfect rectangle,
 * ~0.5 = an L-shape. Callers use it to decide whether a boxy roof fits.
 */
function footprintOBB(
  coordinates: [number, number][],
  originLat: number,
  originLon: number,
  cosOrigin: number,
): { cx: number; cz: number; width: number; depth: number; rotY: number; fill: number } | null {
  const n = coordinates.length;
  if (n < 3) return null;

  const pts: [number, number][] = coordinates.map(([lon, lat]) => [
    (lon - originLon) * 111320 * cosOrigin,
    -(lat - originLat) * 111320,
  ]);

  // Longest edge → box axis.
  let ux = 1;
  let uz = 0;
  let best = 0;
  for (let i = 0; i < n; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % n];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len > best) {
      best = len;
      ux = dx / len;
      uz = dz / len;
    }
  }
  if (best < 1e-6) return null;

  // Perpendicular axis, then extents along both.
  const vx = -uz;
  const vz = ux;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const [x, z] of pts) {
    const pu = x * ux + z * uz;
    const pv = x * vx + z * vz;
    if (pu < uMin) uMin = pu;
    if (pu > uMax) uMax = pu;
    if (pv < vMin) vMin = pv;
    if (pv > vMax) vMax = pv;
  }

  const width = uMax - uMin;
  const depth = vMax - vMin;
  if (width < 2 || depth < 2) return null;

  const uMid = (uMin + uMax) / 2;
  const vMid = (vMin + vMax) / 2;

  // Shoelace area of the footprint vs. the box area.
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % n];
    area2 += ax * bz - bx * az;
  }
  const fill = Math.abs(area2) / 2 / (width * depth);

  // A group rotated by rotY about +y maps its local +x to (cos, −sin) in (x, z),
  // so the axis we want (ux, uz) needs rotY = atan2(−uz, ux).
  return {
    cx: uMid * ux + vMid * vx,
    cz: uMid * uz + vMid * vz,
    width,
    depth,
    rotY: Math.atan2(-uz, ux),
    fill: Math.min(1, fill),
  };
}

/** Compute centroid of a polygon. Returns [lon, lat]. */
function polygonCentroid(coords: [number, number][]): [number, number] {
  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of coords) {
    sumLon += lon;
    sumLat += lat;
  }
  return [sumLon / coords.length, sumLat / coords.length];
}

/** Simple geometry merge (no dependency on BufferGeometryUtils). */
function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let totalVerts = 0;
  let totalIndices = 0;

  for (const g of geometries) {
    totalVerts += g.attributes.position.count;
    totalIndices += g.index ? g.index.count : g.attributes.position.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIndices);

  let vertOffset = 0;
  let idxOffset = 0;

  for (const g of geometries) {
    g.computeVertexNormals();

    const pos = g.attributes.position;
    const norm = g.attributes.normal;
    const col = g.attributes.color;
    const count = pos.count;

    for (let i = 0; i < count * 3; i++) {
      positions[vertOffset * 3 + i] = (pos.array as Float32Array)[i];
      if (norm) {
        normals[vertOffset * 3 + i] = (norm.array as Float32Array)[i];
      }
      if (col) {
        colors[vertOffset * 3 + i] = (col.array as Float32Array)[i];
      }
    }

    if (g.index) {
      for (let i = 0; i < g.index.count; i++) {
        indices[idxOffset + i] = g.index.array[i] + vertOffset;
      }
      idxOffset += g.index.count;
    } else {
      for (let i = 0; i < count; i++) {
        indices[idxOffset + i] = vertOffset + i;
      }
      idxOffset += count;
    }

    vertOffset += count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));

  return merged;
}

/**
 * Dispose building mesh resources: every geometry, plus the materials this
 * chunk owns. The wall material and the trim materials are strategy-owned
 * singletons (tagged `userData.shared`) and must survive; the ink outline's
 * material is per-chunk and must not.
 */
export function disposeBuildingMesh(result: BuildingRenderResult): void {
  result.mesh.geometry.dispose();
  for (const child of result.mesh.children) {
    child.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      // The outline shares the wall geometry — already freed above; disposing a
      // BufferGeometry twice is a no-op, so a blanket dispose is safe here.
      mesh.geometry?.dispose?.();
      // InstancedMesh (facade windows, instanced outlines): only its own
      // dispose() event frees the instanceMatrix GPU buffer.
      if ((mesh as unknown as THREE.InstancedMesh).isInstancedMesh) {
        (mesh as unknown as THREE.InstancedMesh).dispose();
      }
      const m = mesh.material;
      if (m instanceof THREE.Material && !m.userData.shared) m.dispose();
    });
  }
  // Window lights: geometry only (material is a shared singleton).
  if (result.lightsMesh) disposeWindowLightMesh(result.lightsMesh);
}
