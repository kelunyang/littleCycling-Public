/**
 * Quantised corridor terrain engine — the shared core behind BOTH world styles
 * (blocks = small cubic steps, paper = tall contour sheets). It turns the
 * smooth sampled corridor grid into stacked flat-top cells joined by vertical
 * drop faces, so the ground reads as "built from units" instead of a ramp.
 *
 * Key properties:
 *  - Elevation is quantised in ABSOLUTE world metres (via the strategy), so the
 *    layer phase is fixed in world space and adjacent chunks line up (no seam)
 *    regardless of the floating origin.
 *  - Cells are FLAT (single quantised height) with their own, unshared vertices
 *    → computeVertexNormals gives per-face flat shading → crisp block edges.
 *  - An optional per-cell height jitter (`params.heightJitter`) sinks each cell
 *    a deterministic 0..jitter metres below its quantised layer, so same-layer
 *    blocks vary slightly and the ground reads as hand-stacked bricks.
 *  - Every cell edge that borders a lower cell (or the chunk boundary) gets a
 *    vertical wall / skirt, so there are no gaps or see-through steps.
 *  - Top faces and wall faces are emitted as TWO geometry groups, so a style
 *    can give the walls their own material — this is how paper shows raw
 *    corrugated cardboard on every cut edge while the top stays "printed"
 *    coloured paper. Wall UVs: u = metres along the wall / WALL_U_METERS,
 *    v = ABSOLUTE elevation / layerHeight → exactly one texture repeat per
 *    stacked sheet, so tall skirts read as a pile of cardboard layers.
 *
 * The step resolution comes from the sampled grid density (driven by
 * `params.gridSize`); the step height comes from `params.layerHeight`.
 */

import * as THREE from 'three';
import type { TerrainStyleStrategy } from './terrain-style-strategy';

/** World metres covered by one horizontal repeat of the wall texture. */
export const WALL_U_METERS = 8;

/** Row-major sampled corridor grid (a = along-route section, c = cross column). */
export interface CorridorGrid {
  /** Scene X per grid vertex (origin-relative, length along*cross). */
  gx: number[];
  /** Scene Z per grid vertex. */
  gz: number[];
  /** ABSOLUTE elevation (metres) per grid vertex. */
  gele: number[];
  /** RGB per grid vertex (length along*cross*3). */
  gcol: number[];
  along: number;
  cross: number;
}

export interface QuantizedGeometryData {
  positions: number[];
  colors: number[];
  /** UVs — walls: metres-along/8 × ele/layerHeight (see header); tops:
   *  world-plane raw scene metres (scale via texture.repeat). */
  uvs: number[];
  indices: number[];
  /** Number of indices belonging to top faces (geometry group 0). The rest are
   *  wall faces (group 1) and may use a separate material. */
  topIndexCount: number;
}

/**
 * Build blocky (flat cells + vertical walls) geometry from a sampled grid.
 * Y values are converted to origin-relative on output (matching the smooth path).
 */
export function buildQuantizedCorridorGeometry(
  grid: CorridorGrid,
  strategy: TerrainStyleStrategy,
  originEle: number,
): QuantizedGeometryData {
  const { gx, gz, gele, gcol, along, cross } = grid;
  const cellsA = along - 1;
  const cellsC = cross - 1;

  // Tops and walls buffered separately, merged into one two-group geometry.
  const topPos: number[] = [];
  const topCol: number[] = [];
  const topUv: number[] = [];
  const topIdx: number[] = [];
  const wallPos: number[] = [];
  const wallCol: number[] = [];
  const wallUv: number[] = [];
  const wallIdx: number[] = [];

  if (cellsA < 1 || cellsC < 1) {
    return { positions: [], colors: [], uvs: [], indices: [], topIndexCount: 0 };
  }

  const layerH = Math.max(1, strategy.params.layerHeight);
  const jitterAmp = Math.max(0, strategy.params.heightJitter);

  const gi = (a: number, c: number) => a * cross + c;
  const ci = (a: number, c: number) => a * cellsC + c;

  // ── Pass 1: per-cell quantised height (absolute) + flat colour ──
  const cellY = new Float64Array(cellsA * cellsC);
  const cellCol = new Float64Array(cellsA * cellsC * 3);
  let minY = Infinity;

  for (let a = 0; a < cellsA; a++) {
    for (let c = 0; c < cellsC; c++) {
      const i00 = gi(a, c), i01 = gi(a, c + 1), i10 = gi(a + 1, c), i11 = gi(a + 1, c + 1);
      const avgEle = (gele[i00] + gele[i01] + gele[i10] + gele[i11]) / 4;
      let qy = strategy.quantizeElevation(avgEle);
      // Per-cell DOWNWARD sink (0..heightJitter m) so same-layer blocks sit at
      // slightly different heights — reads as hand-stacked toy bricks. Hashed
      // from the cell-centre scene position so it's stable across rebuilds.
      // Downward-only: overlays (roads/landuse/trees) sit at the quantised
      // layer height and must never be impaled by a raised block.
      if (jitterAmp > 0) {
        const cx = (gx[i00] + gx[i01] + gx[i10] + gx[i11]) / 4;
        const cz = (gz[i00] + gz[i01] + gz[i10] + gz[i11]) / 4;
        const h = Math.sin(cx * 12.9898 + cz * 78.233) * 43758.5453;
        qy -= (h - Math.floor(h)) * jitterAmp;
      }
      cellY[ci(a, c)] = qy;
      if (qy < minY) minY = qy;
      // Flat cell colour = mean of the 4 corner colours.
      const k = ci(a, c) * 3;
      cellCol[k] = (gcol[i00 * 3] + gcol[i01 * 3] + gcol[i10 * 3] + gcol[i11 * 3]) / 4;
      cellCol[k + 1] = (gcol[i00 * 3 + 1] + gcol[i01 * 3 + 1] + gcol[i10 * 3 + 1] + gcol[i11 * 3 + 1]) / 4;
      cellCol[k + 2] = (gcol[i00 * 3 + 2] + gcol[i01 * 3 + 2] + gcol[i10 * 3 + 2] + gcol[i11 * 3 + 2]) / 4;
    }
  }

  // Skirt bottom: below the lowest cell so boundary skirts always close the gap.
  const skirtDrop = Math.max(strategy.params.layerHeight, 4);
  const baseY = minY - skirtDrop - originEle;

  // ── Helpers ──
  /** Push one TOP triangle (3 vertices) with a flat colour. Top UVs are a
   *  world-plane mapping (raw scene metres) so a style can tile a surface
   *  texture (e.g. paper's crayon shading) seamlessly across cells + chunks;
   *  the texture's own `repeat` sets the scale. */
  const pushTopTri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    r: number, g: number, b: number,
  ) => {
    const base = topPos.length / 3;
    topPos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    topCol.push(r, g, b, r, g, b, r, g, b);
    topUv.push(ax, az, bx, bz, cx, cz);
    topIdx.push(base, base + 1, base + 2);
  };

  /**
   * Vertical wall quad between edge points (x0,z0)-(x1,z1), yTop→yBot.
   * UVs: u = world metres projected on the wall direction (phase-continuous
   * across collinear neighbouring walls), v = absolute elevation / layerHeight
   * (one sheet per repeat, aligned to the world layer grid).
   */
  const addWall = (
    x0: number, z0: number, x1: number, z1: number,
    yTop: number, yBot: number,
    r: number, g: number, b: number,
  ) => {
    if (yTop - yBot < 1e-4) return;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    const dnx = dx / len, dnz = dz / len;
    const u0 = (x0 * dnx + z0 * dnz) / WALL_U_METERS;
    const u1 = u0 + len / WALL_U_METERS;
    const vTop = (yTop + originEle) / layerH;
    const vBot = (yBot + originEle) / layerH;

    const base = wallPos.length / 3;
    // 4 vertices: TL, TR, BR, BL — two triangles. DoubleSide → winding cosmetic.
    wallPos.push(x0, yTop, z0, x1, yTop, z1, x1, yBot, z1, x0, yBot, z0);
    wallUv.push(u0, vTop, u1, vTop, u1, vBot, u0, vBot);
    for (let i = 0; i < 4; i++) wallCol.push(r, g, b);
    wallIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  // ── Pass 2: top faces + walls ──
  for (let a = 0; a < cellsA; a++) {
    for (let c = 0; c < cellsC; c++) {
      const y = cellY[ci(a, c)] - originEle;
      const k = ci(a, c) * 3;
      const r = cellCol[k], g = cellCol[k + 1], b = cellCol[k + 2];

      const i00 = gi(a, c), i01 = gi(a, c + 1), i10 = gi(a + 1, c), i11 = gi(a + 1, c + 1);
      // Top face — replicate the smooth grid winding (i0,i2,i1)/(i1,i2,i3) so
      // the up-normal matches the rest of the terrain lighting.
      pushTopTri(gx[i00], y, gz[i00], gx[i10], y, gz[i10], gx[i01], y, gz[i01], r, g, b);
      pushTopTri(gx[i01], y, gz[i01], gx[i10], y, gz[i10], gx[i11], y, gz[i11], r, g, b);

      // Wall colour — darken slightly so step risers read (used by styles whose
      // wall material keeps vertex colours, e.g. plastic).
      const wr = r * 0.82, wg = g * 0.82, wb = b * 0.82;

      // Right neighbour wall (shared edge (a,c+1)-(a+1,c+1)).
      if (c < cellsC - 1) {
        const ny = cellY[ci(a, c + 1)] - originEle;
        addWall(gx[i01], gz[i01], gx[i11], gz[i11], Math.max(y, ny), Math.min(y, ny), wr, wg, wb);
      }
      // Front neighbour wall (shared edge (a+1,c)-(a+1,c+1)).
      if (a < cellsA - 1) {
        const ny = cellY[ci(a + 1, c)] - originEle;
        addWall(gx[i10], gz[i10], gx[i11], gz[i11], Math.max(y, ny), Math.min(y, ny), wr, wg, wb);
      }

      // Boundary skirts (drop to baseY) — close the corridor sides + chunk ends.
      const sr = r * 0.7, sg = g * 0.7, sb = b * 0.7;
      if (c === 0) addWall(gx[i00], gz[i00], gx[i10], gz[i10], y, baseY, sr, sg, sb);
      if (c === cellsC - 1) addWall(gx[i01], gz[i01], gx[i11], gz[i11], y, baseY, sr, sg, sb);
      if (a === 0) addWall(gx[i00], gz[i00], gx[i01], gz[i01], y, baseY, sr, sg, sb);
      if (a === cellsA - 1) addWall(gx[i10], gz[i10], gx[i11], gz[i11], y, baseY, sr, sg, sb);
    }
  }

  // ── Merge: tops first (group 0), then walls (group 1) ──
  const topVerts = topPos.length / 3;
  const positions = topPos.concat(wallPos);
  const colors = topCol.concat(wallCol);
  const uvs = topUv.concat(wallUv);
  const indices = topIdx.concat(wallIdx.map((i) => i + topVerts));

  return { positions, colors, uvs, indices, topIndexCount: topIdx.length };
}

/**
 * Build a THREE.BufferGeometry from quantised geometry data (flat-shaded).
 * Group 0 = top faces (material index 0), group 1 = walls (material index 1) —
 * pass a `[topMaterial, wallMaterial]` array to the mesh to split them.
 */
export function quantizedDataToGeometry(data: QuantizedGeometryData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(data.colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
  geometry.setIndex(data.indices);
  geometry.addGroup(0, data.topIndexCount, 0);
  geometry.addGroup(data.topIndexCount, data.indices.length - data.topIndexCount, 1);
  geometry.computeVertexNormals();
  return geometry;
}
