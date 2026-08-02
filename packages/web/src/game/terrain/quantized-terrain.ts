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
 *  - Top faces and wall faces are emitted as SEPARATE geometry groups, so a
 *    style can give the walls their own material — this is how paper shows raw
 *    corrugated cardboard on every cut edge while the top stays "printed"
 *    coloured paper. Both sides can be split FURTHER by band level: walls via
 *    `terrainWallLevels` (circuit's FR4 stack), treads via `terrainTopLevels`
 *    (paper's level 0 = the cutting mat rather than a sheet of board). A world
 *    that declares neither gets exactly the two groups it always had.
 *    Wall UVs: u = metres along the wall / WALL_U_METERS,
 *    v = ABSOLUTE elevation / layerHeight → exactly one texture repeat per
 *    stacked sheet, so tall skirts read as a pile of cardboard layers.
 *
 * The step resolution comes from the sampled grid density (driven by
 * `params.gridSize`); the step height comes from `params.layerHeight`.
 *
 * ## 分層設色(hypsometric tinting)在這裡落地
 *
 * demo 的一句話規格(`plan/plastic-town-demo.html`,`TERRAIN_BAND` 上面那段):
 *
 * > **踏面 = 色帶,側面 = 等高線**。層積模型的垂直面就是上面那片板的切口,在讀
 * > 圖上扮演的角色是等高線本身,所以側面一律比自己的踏面深一階。
 *
 * 這條規則在這個引擎裡**不用付任何代價**:每一格的踏面本來就有自己一份不共用
 * 的頂點(才有 flat shading),而豎面本來就在另一組 buffer 裡。所以「踏面吃色帶、
 * 側面吃等高線色」只是把兩個 buffer 各填各的顏色,沒有拆頂點、沒有多一個
 * attribute、沒有 shader term。**唯一**改到的是:一道豎面的顏色從「這一格的」
 * 改成「上下兩格裡較高那格的」—— 因為那道切口是上面那片板切出來的,不是下面那
 * 片。
 *
 * 階數(`cellBand`)是「這一格比**腳下那條路**高幾層」。demo 的 `bandAt(y)` 量的
 * 是離底板多高,而 gameview 沒有底板 —— 騎手騎的那條路就是這個世界的底板,所以
 * 基準面取該斷面的路面高度(quantise 過,所以差值永遠是整數層)。
 *
 * 「該斷面的路面」是哪幾個頂點,由走廊的欄數決定(`corridorCentreColumns`):出貨
 * 的走廊欄數是**偶數**,路走在正中央那一格的軸線上,所以基準面 = 那一格四個角的
 * 平均 —— 也就是那一格自己的 `avgEle`,於是**騎士腳下那一格的階數恆為 0**。
 * 欄數是奇數時(合成網格的檢查會餵)中線正好壓在一欄上,基準面就取那一欄。
 *
 * 基準面**不可以**用 `originEle`:floating origin 會隨騎乘 rebase(見
 * `TerrainChunkManager.updateOrigin`),用它當基準的話已建好的 chunk 跟新建的
 * chunk 會分屬不同色階,邊界上會出現一條色差線。路面高度是絕對公尺,不會漂。
 */

import * as THREE from 'three';
import type { TerrainStyleStrategy } from './terrain-style-strategy';

/** World metres covered by one horizontal repeat of the wall texture. */
export const WALL_U_METERS = 8;

/**
 * 走廊中線(offset = 0,也就是騎士騎的那條路)落在哪。
 *
 * 回傳的是**欄**的索引,一對:
 *  · 欄數**偶數**(gameview 出貨的走廊,見 `terrain-chunk.ts` 的 `crossCount`)
 *    → 中線在 `cross/2 - 1` 與 `cross/2` **之間**,也就是正中央那一格的軸線。
 *    那一格(格索引 = `cross/2 - 1`)就是騎士的車道,路在它的正中央。
 *  · 欄數**奇數** → 中線正好壓在 `(cross-1)/2` 那一欄上,兩個索引相同。這是舊的
 *    走廊形狀,也是路壓在兩格共用邊上的那個病;合成網格的檢查還會餵奇數進來,
 *    所以規則要對兩種同時成立。
 *
 * 這一對是「路在哪」的**唯一**來源:斷面中心線、走廊半寬、量化的基準面、以及
 * 中軸遮罩「騎士的車道切不掉」那條保證都從這裡取。
 */
export function corridorCentreColumns(cross: number): [number, number] {
  const m = cross >> 1;
  return cross % 2 === 0 ? [m - 1, m] : [m, m];
}

/**
 * Live diagnostic: hide every terrain WALL face (geometry group 1 — step
 * risers, drop faces and boundary skirts), leaving only the flat tops.
 *
 * These are the only terrain faces that are vertical, that are emitted with
 * "winding cosmetic" (see addWall — the material is DoubleSide so nobody chose
 * an outward side), and that a boundary skirt can drive hundreds of metres
 * straight down. If a report of "black lines coming out of the hillside"
 * disappears when this is switched off, it is them; if it survives, walls are
 * exonerated and the search moves elsewhere. One toggle, one answer — cheaper
 * than another round of inference.
 */
const wallMaterials = new Set<THREE.Material>();
let wallsVisible = true;

/** Called by the chunk builder for each wall material it mints. */
export function registerWallMaterial(material: THREE.Material): void {
  wallMaterials.add(material);
  material.visible = wallsVisible;
}

export function setTerrainWallsVisible(visible: boolean): void {
  wallsVisible = visible;
  for (const m of wallMaterials) m.visible = visible;
}

export function getTerrainWallsVisible(): boolean {
  return wallsVisible;
}

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
  /**
   * Per-cell ground mask from `buildMedialAxisMask` — 1 = this cell is ground,
   * 0 = it is the corridor lying on top of itself and a nearer stretch of route
   * draws that ground instead. Length (along-1)*(cross-1).
   *
   * Absent (undefined) = keep every cell, which is what a straight route's mask
   * says anyway; the smooth (non-quantised) path never passes one.
   */
  cellMask?: Uint8Array;
}

export interface QuantizedGeometryData {
  positions: number[];
  colors: number[];
  /** UVs — walls: metres-along/8 × ele/layerHeight (see header); tops:
   *  world-plane raw scene metres (scale via texture.repeat). */
  uvs: number[];
  indices: number[];
  /** Number of indices belonging to top faces (geometry groups 0…T-1, i.e. the
   *  sum of `topIndexCounts`). Everything after them is a wall face. */
  topIndexCount: number;
  /**
   * Index count of each TREAD group, in emission order (group 0 = the road's own
   * band level, `topIndexCounts[0]`).
   *
   * Length 1 for every world whose treads are all the same material — that is
   * the pre-existing single top group, byte for byte. Paper declares
   * `terrainTopLevels` and gets one group for band level 0 and one for
   * everything above it, because in that world elevation 0 is not a sheet of
   * cardboard at all: it is the CUTTING MAT the model is built on (demo:
   * `boardTopMat`), and only ground higher than the first contour starts
   * stacking board.
   */
  topIndexCounts: number[];
  /**
   * Index count of each WALL group, in emission order (group 1 = wallIndexCounts[0]).
   *
   * Length 1 for every world whose cut edges are all the same material. Circuit
   * declares `terrainWallLevels` and gets one group per FR4 stack height, so a
   * riser three layers above the road shows a 8-layer board edge and one at road
   * level shows a 2-layer one (demo: `edgeMatForLevel`).
   */
  wallIndexCounts: number[];
  /**
   * Index count of the SIDE WALL group — the board's own edge, emitted after
   * every wall bucket (so its material is the last entry of the material array).
   *
   * 0 for a world that declares no `sideWall`: its corridor sides keep the plain
   * short lip and stay inside the wall buckets, exactly as before.
   */
  sideWallIndexCount: number;
  /** Per-cell flat top height in ABSOLUTE world metres (post-quantise + jitter) —
   *  exactly the height each rendered top face sits at. Row-major over
   *  (along-1) × (cross-1) cells (index a*(cross-1)+c). The ground-height grid
   *  reads this so the rider/lamps/route-line sit flush on the visible step,
   *  instead of raycasting the mesh. */
  cellY: Float32Array;
  /**
   * Per-cell band level: how many quantised layers this cell's tread sits ABOVE
   * the road at its own section (negative below). Same indexing as `cellY`.
   *
   * Computed from the PRE-jitter quantised height, so `heightJitter` (which sinks
   * a block up to 1.5 m for the hand-stacked look) can never drop a block into
   * the band below and put a colour seam through a flat field.
   *
   * Carried out of here rather than recomputed by every consumer because three
   * things have to agree on it exactly: the tread colour, the cut-edge material,
   * and the stud standing on the cell (同一塊塑膠射出來的東西不會兩個色).
   */
  cellBand: Int8Array;
  /** Cell grid dimensions (along-1, cross-1). */
  cellsA: number;
  cellsC: number;
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
  const { gx, gz, gele, gcol, along, cross, cellMask } = grid;
  const cellsA = along - 1;
  const cellsC = cross - 1;
  /** 這一格是不是地面(中軸遮罩,見 `buildMedialAxisMask`)。 */
  const alive = (id: number): boolean => !cellMask || cellMask[id] === 1;

  // Tops and walls buffered separately, merged into one multi-group geometry.
  // Walls are bucketed by band level when the style declares `terrainWallLevels`
  // (circuit's FR4 stack); every other world has exactly one wall bucket.
  // TREADS bucket the same way when the style declares `terrainTopLevels`
  // (paper: level 0 is the cutting mat, not cardboard); every other world has
  // exactly one tread bucket and is untouched by this.
  const topGroups = Math.max(1, Math.min(16, strategy.terrainTopLevels ?? 1));
  const mkTop = <T>(f: () => T) => Array.from({ length: topGroups }, f);
  const topPos: number[][] = mkTop(() => []);
  const topCol: number[][] = mkTop(() => []);
  const topUv: number[][] = mkTop(() => []);
  const topIdx: number[][] = mkTop(() => []);
  const wallGroups = Math.max(1, Math.min(16, strategy.terrainWallLevels ?? 1));
  const mk = <T>(f: () => T) => Array.from({ length: wallGroups }, f);
  const wallPos: number[][] = mk(() => []);
  const wallCol: number[][] = mk(() => []);
  const wallUv: number[][] = mk(() => []);
  const wallIdx: number[][] = mk(() => []);
  // 板子的側牆(demo `sideWallSeg`)自己一桶。它跟切口不是同一種東西 —— 切口是
  // 「上面那片板切出來的」而牆是板子的**外緣**,所以材質也不是同一份。
  const sideWall = strategy.sideWall;
  const sidePos: number[] = [];
  const sideCol: number[] = [];
  const sideUv: number[] = [];
  const sideIdx: number[] = [];

  if (cellsA < 1 || cellsC < 1) {
    return {
      positions: [], colors: [], uvs: [], indices: [], topIndexCount: 0,
      topIndexCounts: mkTop(() => 0),
      wallIndexCounts: mk(() => 0), sideWallIndexCount: 0,
      cellY: new Float32Array(0), cellBand: new Int8Array(0),
      cellsA: Math.max(0, cellsA), cellsC: Math.max(0, cellsC),
    };
  }

  const layerH = Math.max(1, strategy.params.layerHeight);
  const jitterAmp = Math.max(0, strategy.params.heightJitter);
  /** 這個世界的分層設色表。沒有 = 顏色照舊由 `terrainVertexColor` 決定。 */
  const bandAt = strategy.bandAt;
  /** 基準面取哪(幾)欄:走廊的中線就是路(見 `corridorCentreColumns`)。 */
  const [laneL, laneR] = corridorCentreColumns(cross);

  const gi = (a: number, c: number) => a * cross + c;
  const ci = (a: number, c: number) => a * cellsC + c;

  // ── Pass 1: per-cell quantised height (absolute) + band + flat colour ──
  const cellY = new Float64Array(cellsA * cellsC);
  const cellCol = new Float64Array(cellsA * cellsC * 3);
  /** 這一格切口的顏色。分層設色的世界拿色帶的 `side`(比自己的踏面深一階),
   *  其餘世界維持原本的「踏面 × 0.82」。 */
  const cellSide = new Float64Array(cellsA * cellsC * 3);
  const cellBand = new Int8Array(cellsA * cellsC);

  for (let a = 0; a < cellsA; a++) {
    // 這個斷面的基準面 = 路面高度,quantise 過 —— 兩邊都是 layerHeight 的整數
    // 倍,所以下面的 (qLevelY - datum) / layerH 是**精確**的整數,不會因為浮點
    // 誤差在一片平地上跳階。
    //
    // 偶數欄:中線在 laneL / laneR 兩欄之間,所以路面高度取那一格四個角的平均
    // —— 那**逐位元**就是那一格自己的 `avgEle`(同樣的四項、同樣的相加順序),
    // 於是騎士腳下那一格的 `above` 恆為 0,階數恆為 0。
    // 奇數欄:laneL === laneR,退回「中線那一欄在 a 與 a+1 的平均」,也就是這條
    // 規則原本的樣子。
    const datum = strategy.quantizeElevation(
      laneL === laneR
        ? (gele[gi(a, laneL)] + gele[gi(a + 1, laneL)]) / 2
        : (gele[gi(a, laneL)] + gele[gi(a, laneR)]
          + gele[gi(a + 1, laneL)] + gele[gi(a + 1, laneR)]) / 4,
    );
    for (let c = 0; c < cellsC; c++) {
      // 中軸遮罩切掉的格子:沒有踏面、沒有牆,而且高度是 NaN —— 高度網格的空間
      // 索引看到 NaN 就不收它,所以任何地面查詢都**叫不出**這一格。
      if (!alive(ci(a, c))) { cellY[ci(a, c)] = NaN; continue; }
      const i00 = gi(a, c), i01 = gi(a, c + 1), i10 = gi(a + 1, c), i11 = gi(a + 1, c + 1);
      const avgEle = (gele[i00] + gele[i01] + gele[i10] + gele[i11]) / 4;
      const qLevelY = strategy.quantizeElevation(avgEle);
      let qy = qLevelY;
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
      // 階數用 PRE-jitter 的高度算(見 `cellBand` 的說明)。
      const above = qLevelY - datum;
      const level = Math.round(above / layerH);
      cellBand[ci(a, c)] = level < -127 ? -127 : level > 127 ? 127 : level;

      const k = ci(a, c) * 3;
      const band = bandAt?.(above);
      if (band) {
        // 踏面 = 色帶。**不**混 `terrainVertexColor` 的噪點:射出成型的塑膠是
        // 單一色,而分層設色靠的就是「同一階=同一色」,摻噪點就讀不出階了。
        cellCol[k] = band.top.r; cellCol[k + 1] = band.top.g; cellCol[k + 2] = band.top.b;
        // 側面 = 等高線。色帶沒給 side 的世界(瓦楞紙:切邊是不上色的生紙板,
        // 材質根本不吃頂點色)沿用原本的加深。
        const side = band.side;
        cellSide[k] = side ? side.r : band.top.r * 0.82;
        cellSide[k + 1] = side ? side.g : band.top.g * 0.82;
        cellSide[k + 2] = side ? side.b : band.top.b * 0.82;
      } else {
        // Flat cell colour = mean of the 4 corner colours.
        cellCol[k] = (gcol[i00 * 3] + gcol[i01 * 3] + gcol[i10 * 3] + gcol[i11 * 3]) / 4;
        cellCol[k + 1] = (gcol[i00 * 3 + 1] + gcol[i01 * 3 + 1] + gcol[i10 * 3 + 1] + gcol[i11 * 3 + 1]) / 4;
        cellCol[k + 2] = (gcol[i00 * 3 + 2] + gcol[i01 * 3 + 2] + gcol[i10 * 3 + 2] + gcol[i11 * 3 + 2]) / 4;
        // Darken slightly so step risers read (used by styles whose wall
        // material keeps vertex colours).
        cellSide[k] = cellCol[k] * 0.82;
        cellSide[k + 1] = cellCol[k + 1] * 0.82;
        cellSide[k + 2] = cellCol[k + 2] * 0.82;
      }
    }
  }

  // Skirt depth. LOCAL, not global.
  //
  // This used to drop every boundary skirt to `minY - skirtDrop` — the floor of
  // the WHOLE chunk. On a chunk that spans a valley and a hillside that makes
  // the skirt as tall as the chunk's relief: measured on the Dazhi route, over
  // 100 m of vertical curtain running along the corridor edge of chunk 3. That
  // curtain is a closed box around the corridor, which is why roads and street
  // lamps draped down in the valley end up INSIDE it, and why riding near the
  // edge reads as riding into a wall.
  //
  // Each edge cell now hangs its own short lip instead. Outside the corridor
  // there is no terrain at all, so the lip only has to stop you seeing the
  // underside of the slab — it never has to reach the chunk floor.
  const skirtDrop = Math.max(strategy.params.layerHeight, 4);

  // ── Helpers ──
  /** Push one TOP triangle (3 vertices) with a flat colour. Top UVs are a
   *  world-plane mapping (raw scene metres) so a style can tile a surface
   *  texture (e.g. paper's crayon shading) seamlessly across cells + chunks;
   *  the texture's own `repeat` sets the scale. */
  const pushTopTri = (
    grp: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    r: number, g: number, b: number,
  ) => {
    const base = topPos[grp].length / 3;
    topPos[grp].push(ax, ay, az, bx, by, bz, cx, cy, cz);
    topCol[grp].push(r, g, b, r, g, b, r, g, b);
    topUv[grp].push(ax, az, bx, bz, cx, cz);
    topIdx[grp].push(base, base + 1, base + 2);
  };

  /**
   * Vertical wall quad between edge points (x0,z0)-(x1,z1), yTop→yBot.
   * UVs: u = world metres projected on the wall direction (phase-continuous
   * across collinear neighbouring walls), v = absolute elevation / layerHeight
   * (one sheet per repeat, aligned to the world layer grid).
   *
   * `owner` is the CELL WHOSE CUT THIS IS — always the higher of the two cells
   * a riser separates. 「側面一律比自己的踏面深一階」only means anything if the
   * side knows which tread it belongs to; taking the lower cell's colour would
   * paint the contour line of the slab BELOW the one that was actually cut.
   */
  const addWall = (
    x0: number, z0: number, x1: number, z1: number,
    yTop: number, yBot: number,
    owner: number,
    /** true = 這一段是板子的側牆,走 `sideWall` 那一桶與那份材質。 */
    isSideWall = false,
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

    const lvl = cellBand[owner];
    const grp = lvl <= 0 ? 0 : lvl >= wallGroups ? wallGroups - 1 : lvl;
    const k = owner * 3;
    const r = cellSide[k], g = cellSide[k + 1], b = cellSide[k + 2];

    const wp = isSideWall ? sidePos : wallPos[grp];
    const wu = isSideWall ? sideUv : wallUv[grp];
    const wc = isSideWall ? sideCol : wallCol[grp];
    const wi = isSideWall ? sideIdx : wallIdx[grp];
    const base = wp.length / 3;
    // 4 vertices: TL, TR, BR, BL — two triangles. DoubleSide → winding cosmetic.
    wp.push(x0, yTop, z0, x1, yTop, z1, x1, yBot, z1, x0, yBot, z0);
    wu.push(u0, vTop, u1, vTop, u1, vBot, u0, vBot);
    for (let i = 0; i < 4; i++) wc.push(r, g, b);
    wi.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  // ── Pass 2: top faces + walls ──
  for (let a = 0; a < cellsA; a++) {
    for (let c = 0; c < cellsC; c++) {
      if (!alive(ci(a, c))) continue;
      const y = cellY[ci(a, c)] - originEle;
      const k = ci(a, c) * 3;
      const r = cellCol[k], g = cellCol[k + 1], b = cellCol[k + 2];

      const i00 = gi(a, c), i01 = gi(a, c + 1), i10 = gi(a + 1, c), i11 = gi(a + 1, c + 1);
      // Which tread bucket this cell belongs to — same clamp as the wall buckets
      // below the road clamps to 0, which is the answer that reads: everything at
      // or under the road is the surface the model was BUILT ON, not a sheet of
      // it (demo: 「墊子就是海拔 0,只有高過第一道等高線的地方才開始疊瓦楞紙」).
      const tLvl = cellBand[ci(a, c)];
      const tGrp = tLvl <= 0 ? 0 : tLvl >= topGroups ? topGroups - 1 : tLvl;
      // Top face — replicate the smooth grid winding (i0,i2,i1)/(i1,i2,i3) so
      // the up-normal matches the rest of the terrain lighting.
      pushTopTri(tGrp, gx[i00], y, gz[i00], gx[i10], y, gz[i10], gx[i01], y, gz[i01], r, g, b);
      pushTopTri(tGrp, gx[i01], y, gz[i01], gx[i10], y, gz[i10], gx[i11], y, gz[i11], r, g, b);

      const self = ci(a, c);
      // Right neighbour wall (shared edge (a,c+1)-(a+1,c+1)).
      //
      // 遮罩切掉的鄰居**不是**一格比較低的地,是「這裡沒有地」—— 所以那一邊變成
      // 邊界,掛跟走廊外緣同一種短裙(見下面 skirtDrop 那段的理由:裙子只要擋住
      // 板子的底面,不必伸到谷底)。沒有這一段,切口那一排就會看到板子的背面。
      if (c < cellsC - 1) {
        const nb = ci(a, c + 1);
        if (alive(nb)) {
          const ny = cellY[nb] - originEle;
          addWall(gx[i01], gz[i01], gx[i11], gz[i11],
            Math.max(y, ny), Math.min(y, ny), ny > y ? nb : self);
        } else {
          addWall(gx[i01], gz[i01], gx[i11], gz[i11], y, y - skirtDrop, self);
        }
      }
      // Front neighbour wall (shared edge (a+1,c)-(a+1,c+1)).
      if (a < cellsA - 1) {
        const nb = ci(a + 1, c);
        if (alive(nb)) {
          const ny = cellY[nb] - originEle;
          addWall(gx[i10], gz[i10], gx[i11], gz[i11],
            Math.max(y, ny), Math.min(y, ny), ny > y ? nb : self);
        } else {
          addWall(gx[i10], gz[i10], gx[i11], gz[i11], y, y - skirtDrop, self);
        }
      }
      // 反向的兩面:鄰居活著的時候由**它**那一格畫共用的豎面,所以只有在鄰居被
      // 切掉時這一格才要自己補左緣 / 後緣。
      if (c > 0 && !alive(ci(a, c - 1))) {
        addWall(gx[i00], gz[i00], gx[i10], gz[i10], y, y - skirtDrop, self);
      }
      if (a > 0 && !alive(ci(a - 1, c))) {
        addWall(gx[i00], gz[i00], gx[i01], gz[i01], y, y - skirtDrop, self);
      }

      // Boundary skirts — close the corridor sides + chunk ends with a short
      // lip under THIS cell (see skirtDrop above). The lip IS this cell's own
      // cut, so it takes the same contour colour a riser would.
      //
      // 走廊的**兩個側邊**是這個世界的板子邊緣,所以宣告了 `sideWall` 的世界在
      // 這裡改掛 demo 的側牆(`sideWallSeg`,深 9 m、板子自己的材質)。chunk 的
      // 前後兩端**不算** —— 那是 gameview 逐 chunk 建才有的接縫,demo 的板子是
      // 連續的,而且兩個 chunk 貼在一起時那道牆是看不到的。
      const skirtBase = y - skirtDrop;
      const sideBase = sideWall ? y - sideWall.drop : skirtBase;
      if (c === 0) addWall(gx[i00], gz[i00], gx[i10], gz[i10], y, sideBase, self, !!sideWall);
      if (c === cellsC - 1) addWall(gx[i01], gz[i01], gx[i11], gz[i11], y, sideBase, self, !!sideWall);
      if (a === 0) addWall(gx[i00], gz[i00], gx[i01], gz[i01], y, skirtBase, self);
      if (a === cellsA - 1) addWall(gx[i10], gz[i10], gx[i11], gz[i11], y, skirtBase, self);
    }
  }

  // ── Merge: tread buckets first (groups 0…T-1), then one group per wall bucket ──
  // ⚠ 每一桶的索引數一定要在合併**之前**全部抄下來:下面是直接往 `topIdx[0]` 上
  //   疊,合併完再讀長度拿到的是總數,group 0 就會吃掉整份索引 —— 牆的材質從此
  //   不會被用到(瓦楞紙的生紙板切邊會整個變成踏面色,而且看起來很合理)。
  const topIndexCounts = topIdx.map((a) => a.length);
  const positions = topPos[0];
  const colors = topCol[0];
  const uvs = topUv[0];
  const indices = topIdx[0];
  for (let g = 1; g < topGroups; g++) {
    const base = positions.length / 3;
    for (const v of topPos[g]) positions.push(v);
    for (const v of topCol[g]) colors.push(v);
    for (const v of topUv[g]) uvs.push(v);
    for (const i of topIdx[g]) indices.push(i + base);
  }
  const topIndexCount = indices.length;
  const wallIndexCounts: number[] = [];
  for (let g = 0; g < wallGroups; g++) {
    const base = positions.length / 3;
    for (const v of wallPos[g]) positions.push(v);
    for (const v of wallCol[g]) colors.push(v);
    for (const v of wallUv[g]) uvs.push(v);
    for (const i of wallIdx[g]) indices.push(i + base);
    wallIndexCounts.push(wallIdx[g].length);
  }
  // 側牆最後一桶 → 材質陣列的最後一格(見 `terrain-chunk.ts` 的組裝)。
  const sideBase = positions.length / 3;
  for (const v of sidePos) positions.push(v);
  for (const v of sideCol) colors.push(v);
  for (const v of sideUv) uvs.push(v);
  for (const i of sideIdx) indices.push(i + sideBase);
  const sideWallIndexCount = sideIdx.length;

  // Hand back the per-cell heights (as Float32) so the chunk can build a
  // ground-height grid that matches these exact flat tops.
  const cellYOut = Float32Array.from(cellY);

  return {
    positions, colors, uvs, indices, topIndexCount, topIndexCounts,
    wallIndexCounts, sideWallIndexCount,
    cellY: cellYOut, cellBand, cellsA, cellsC,
  };
}

/**
 * Build a THREE.BufferGeometry from quantised geometry data (flat-shaded).
 * Groups 0…T-1 = tread buckets, T…T+N-1 = wall buckets, T+N = the board's side
 * wall — pass `[...topMaterials, ...wallMaterials, sideWallMaterial]` to the
 * mesh to split them. `T` is 1 for every world that does not declare
 * `terrainTopLevels`, which is what keeps those worlds' material indices
 * exactly where they were.
 */
export function quantizedDataToGeometry(data: QuantizedGeometryData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(data.colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
  geometry.setIndex(data.indices);
  let start = 0;
  for (let g = 0; g < data.topIndexCounts.length; g++) {
    // Empty buckets emit NO group — see the wall loop below for why.
    if (data.topIndexCounts[g] > 0) geometry.addGroup(start, data.topIndexCounts[g], g);
    start += data.topIndexCounts[g];
  }
  const topGroups = data.topIndexCounts.length;
  for (let g = 0; g < data.wallIndexCounts.length; g++) {
    // Empty buckets emit NO group — a zero-length group is still one draw call
    // in three's group loop (and one line in the census), and a chunk that never
    // rises three layers above the road should not pay for the material it never
    // used. `materialIndex` is explicit, so skipping does not shift the others.
    if (data.wallIndexCounts[g] > 0) {
      geometry.addGroup(start, data.wallIndexCounts[g], topGroups + g);
    }
    start += data.wallIndexCounts[g];
  }
  // 側牆:最後一個 materialIndex。空的就不開 group(同上一段的理由)。
  if (data.sideWallIndexCount > 0) {
    geometry.addGroup(start, data.sideWallIndexCount, topGroups + data.wallIndexCounts.length);
  }
  geometry.computeVertexNormals();
  return geometry;
}
