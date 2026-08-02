/**
 * Baseplate studs — the ground the rider rides on, moulded.
 *
 * ## What this is a port of
 *
 * `plan/plastic-town-demo.html`, the IIFE commented「底板凸點(一格一凸點,道路
 * 走廊/物件/水面跳過;草地板換淺色)」plus `studInstances` / `studLevelFor` /
 * `applyStudLod`. The demo's own words for why it exists at all:
 *
 * > 凸點是這個世界唯一的身分(2D 版還為此把整條馬路拿掉,因為 stud 才是識別),
 * > 所以一顆都不能少。
 *
 * gameview had the studs PAINTED INTO A TEXTURE (`createBaseplateTexture`), and
 * a painted stud cannot take a colour from the land use underneath it, which is
 * the one thing the demo's baseplate does that matters:
 *
 * > 分區貼花底下的凸點要**跟著分區的顏色**,不是留著底板綠。[…] 同一塊塑膠射出
 * > 來的東西不會兩個色,這條規則在分區上也一樣成立。
 *
 * ## What had to be adapted, and why
 *
 * The demo's board is a flat 130 m ribbon at y = 0 with a synthetic `zoneAt(d)`
 * that slices the route into 220–420 m districts. gameview's ground is quantised
 * DEM terrain and its districts are real MVT landuse polygons. So:
 *
 *  · the LATTICE is the demo's, unchanged — `STEP` 5 m, `|lat| < 7.5` skipped
 *    for the road corridor, `-boardW/2 + 4 … boardW/2 - 4` across. `boardW` is
 *    the demo's own 130: it is the width of the board the demo studs, and
 *    gameview's corridor (±500 m) is ground the demo never had. See
 *    `GroundStudStyle.halfWidth`.
 *  · the HEIGHT of each stud comes from the chunk's height grid instead of being
 *    0 (`sampleChunkCell`), so a stud sits on the quantised cell it stands on
 *    and is moulded in that cell's band colour.
 *  · the ZONE of each stud comes from `ZoneIndex.zoneAt(lon, lat)` — the same
 *    lookup the buildings use — instead of the demo's band test.
 *  · the demo's `occupied` list (its props: lamps, ponds, hills) becomes an
 *    occupancy raster stamped from the meshes this chunk ALREADY built flat on
 *    the ground: road ribbons, rails, water, wetland, pitches, farmland. Same
 *    rule as the demo's ——「道路走廊/物件/水面跳過」—— just answered from the
 *    geometry rather than from a list of circles.
 *
 * ## 分層設色(這一段以前寫著「不在這裡」)
 *
 * 當初把 `TERRAIN_BAND` 留在門外的理由是對的,但它只反對做**一半**:
 *
 * > 只把凸點依高度分階、而底下的地面還是 `terrainVertexColor`,會違反凸點存在
 * > 的那條規則(同一塊塑膠射出來的東西不會兩個色)…它必須把地形表面跟凸點一起
 * > 搬。
 *
 * 現在地形先搬了(`quantized-terrain.ts` 的 `cellBand` + strategy 的 `bandAt`),
 * 所以順序反過來就不衝突了:**磚先分階,凸點再跟著自己的磚**。每顆凸點的階由它
 * 站的那一格提供(`sampleChunkCell`,跟高度同一次查詢、同一格),不是自己再算
 * 一遍 —— 兩次查詢遲早會有一次不同意,而不同意的那一顆就正是這條規則要擋的東西。
 */

import * as THREE from 'three';
import type { ZoneKind } from './land-zone';
import type { ChunkHeightGrid } from './terrain-chunk';
import { sampleChunkCell } from './terrain-chunk';
import type { TerrainStyleStrategy } from './terrain-style-strategy';

/**
 * Landuse kinds a stud must not stand on (`LanduseLayer.kind`).
 *
 * The demo's rule ——「道路走廊/物件/水面跳過;草地板換淺色」—— sorted into the
 * layers gameview actually has. The split is by what the surface IS, not by how
 * opaque it happens to be: `water` / `wetland` are liquid and `sports` /
 * `farmland` are printed plates laid ON the board, so a stud poking through any
 * of them reads as a fault. `urban` and `park` are WASHES — colour brushed onto
 * the board — so studs stay and take their colour instead, which is the whole
 * point. `forest` and `sand` stay studded too: they are ground, and the demo
 * studs right up to its own trees.
 *
 * Lives here rather than in the chunk manager so the chunk manager and
 * `render-probe` read the SAME set. A mirrored copy is how `makeGroundFn` came
 * to exist twice and disagree.
 */
export const STUD_BLOCKING_LANDUSE: ReadonlySet<string> =
  new Set(['water', 'wetland', 'sports', 'farmland']);

/**
 * What a stud is standing on. `null` = plain baseplate — and that is NOT the
 * same as residential (see `zoneFromLanduseClass`): an unzoned stud keeps the
 * board's own green.
 */
export type StudGround = ZoneKind | 'park' | null;

/** A style's baseplate. Omit `TerrainStyleStrategy.groundStuds` and a world has
 *  no studs at all — which is the right answer for the paper world (a cutting
 *  mat has none) and for any world that has not declared one yet. */
export interface GroundStudStyle {
  /** Metres between studs — the demo's `STEP`. */
  readonly pitch: number;
  /** Half-width of the studded board — the demo's `boardW / 2`. */
  readonly halfWidth: number;
  /** …minus this inset at each edge, so the outermost stud is not on the lip
   *  (the demo's `-boardW / 2 + 4`). */
  readonly edgeInset: number;
  /** Studs closer than this to the route centreline are the road (demo: 7.5). */
  readonly corridorSkip: number;
  /** Stud radius and height in metres (demo: `studInstances(pts, 1.5, 0.7, …)`). */
  readonly radius: number;
  readonly height: number;
  /** The three unit studs of the LOD table, finest first. Strategy-owned and
   *  strategy-disposed: chunks only ever point at them. */
  lodGeometries(): THREE.BufferGeometry[];
  /**
   * The colour the plastic was moulded in at this spot. `band` is the
   * hypsometric level of the cell the stud stands on, already clamped into the
   * style's own band table.
   *
   * Optional, and 0 is the meaningful default rather than a placeholder: band 0
   * is the level the ROAD runs at, i.e. the untouched baseplate colour a stud
   * had before there were bands. A caller that has no cell to ask (a preview, a
   * palette dump) gets the board green, which is the right answer for it.
   */
  colorFor(ground: StudGround, band?: number): number;
  /** How many entries the style's band table has, so `buildGroundStuds` can
   *  clamp before calling `colorFor`. Omit for a world with no bands. */
  readonly bandCount?: number;
  /** Shared material for that colour — same colour must give the same object,
   *  or the buckets stop being buckets. */
  materialFor(color: number): THREE.Material;
}

/** One chunk's studs: a handful of InstancedMeshes, one per colour bucket. */
export interface GroundStudResult {
  meshes: THREE.InstancedMesh[];
  /** Total studs placed — diagnostics, census, and the probe's before/after. */
  studCount: number;
  /** The unit studs this chunk's meshes may point at (strategy-owned). */
  lodGeos: THREE.BufferGeometry[];
  /** Current LOD level, -1 until `applyStudLod` first runs (demo: `lod: -1`). */
  lod: number;
}

/**
 * 凸點 LOD:腳下(含後方)0、下一個 chunk 1、再遠一律 2。
 *
 * demo 的 `studLevelFor` 原封搬過來。`rel` 是**有號**的 chunk 差(`i - idx`):
 * 騎過去的 chunk 仍然是最高級,所以永遠不會出現「騎過去就變粗」。
 */
export function studLevelFor(rel: number): number {
  return rel <= 0 ? 0 : (rel === 1 ? 1 : 2);
}

/**
 * 換級 = 把 InstancedMesh.geometry 指到另一份單位凸點。實例矩陣不用重寫,也沒有
 * 任何 buffer 要重傳,所以每次跨 chunk 邊界重掃一次是免費的。(demo: `applyStudLod`)
 */
export function applyStudLod(res: GroundStudResult, rel: number): void {
  const lv = studLevelFor(rel);
  if (res.lod === lv) return;
  res.lod = lv;
  // A style is expected to declare exactly `STUD_LOD.length` geometries; clamp
  // rather than assign `undefined` if one ever declares fewer, because a chunk
  // with no geometry is a hard crash in the renderer, not a visual bug.
  const geo = res.lodGeos[Math.min(lv, res.lodGeos.length - 1)];
  for (const m of res.meshes) m.geometry = geo;
}

/**
 * `points` 可以是 [x,y,z](吃參數的 radius/height)或 [x,y,z,r,h](每顆自己帶
 * 大小)。後者是為了把樹頂那種大小不一的凸點也併進同一批。(demo: `studInstances`)
 */
export function studInstances(
  points: number[][],
  radius: number,
  height: number,
  material: THREE.Material,
  geometry: THREE.BufferGeometry,
): THREE.InstancedMesh | null {
  if (!points.length) return null;
  const inst = new THREE.InstancedMesh(geometry, material, points.length);
  const m = new THREE.Matrix4();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const r = p.length > 3 ? p[3] : radius;
    m.makeScale(r, p.length > 3 ? p[4] : height, r);
    m.setPosition(p[0], p[1], p[2]);
    inst.setMatrixAt(i, m);
  }
  inst.castShadow = true;
  inst.receiveShadow = true;
  inst.userData.stud = 1;            // the LOD sweep recognises studs by this
  return inst;
}

/**
 * Occupancy raster: "is something already drawn flat on the ground here?".
 *
 * This is the demo's `occupied` list, answered from geometry. The demo could
 * keep a list of circles because it placed every prop itself; gameview's ground
 * furniture comes out of a vector tile, so the cheap exact answer is to stamp
 * the triangles that were just built into a bitmask at stud pitch and ask it.
 *
 * XZ only, and deliberately: everything it blocks against (road ribbons, water,
 * pitches) is a flat sheet lying ON the ground, so its plan outline is the whole
 * of its footprint.
 */
class GroundOccupancy {
  private readonly bits: Uint8Array;

  constructor(
    private readonly minX: number,
    private readonly minZ: number,
    private readonly cell: number,
    private readonly nx: number,
    private readonly nz: number,
  ) {
    this.bits = new Uint8Array(nx * nz);
  }

  /** Stamp every triangle of a mesh's geometry. */
  stamp(mesh: THREE.Mesh | undefined | null): void {
    const pos = mesh?.geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    const index = mesh!.geometry.getIndex();
    const tris = index ? index.count / 3 : pos.count / 3;
    for (let t = 0; t < tris; t++) {
      const a = index ? index.getX(t * 3) : t * 3;
      const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      this.tri(
        pos.getX(a), pos.getZ(a), pos.getX(b), pos.getZ(b), pos.getX(c), pos.getZ(c),
      );
    }
  }

  /**
   * Mark every cell the triangle covers, ROW BY ROW.
   *
   * Not the triangle's bounding box, and not box-vs-box-per-cell. Both were
   * tried on the real Dazhi chunk and both are wrong in a way that shows:
   *
   *  · **bounding box.** A road ribbon triangle is a sliver a few metres across
   *    and its box is honest, but a landuse polygon comes out of earcut tens of
   *    metres on a side and its box is far bigger than the shape. Measured:
   *    chunk 2 lost 5 000 of its 8 800 studs to water and parkland it was
   *    nowhere near — 3 719 studs where the row test gives 6 392.
   *  · **box test per cell in the box.** Correct, but it pays for every cell of
   *    those same oversized boxes and then throws almost all of them away —
   *    18 ms of a 33 ms chunk 2 stud build.
   *
   * Per row it is the exact x-extent of the triangle ∩ that row's slab: every
   * vertex inside the slab, plus every edge crossing of the slab's two z lines.
   * Cost is then O(rows + cells actually marked), and the only slop left is the
   * ≤ 1 cell of quantisation at each end of a row.
   */
  private tri(
    ax: number, az: number, bx: number, bz: number, cx: number, cz: number,
  ): void {
    let bz0 = Math.floor((Math.min(az, bz, cz) - this.minZ) / this.cell);
    let bz1 = Math.floor((Math.max(az, bz, cz) - this.minZ) / this.cell);
    if (bz1 < 0 || bz0 >= this.nz) return;
    if (bz0 < 0) bz0 = 0;
    if (bz1 >= this.nz) bz1 = this.nz - 1;
    const vx = [ax, bx, cx];
    const vz = [az, bz, cz];
    for (let bzi = bz0; bzi <= bz1; bzi++) {
      const z0 = this.minZ + bzi * this.cell;
      const z1 = z0 + this.cell;
      let xmin = Infinity, xmax = -Infinity;
      for (let e = 0; e < 3; e++) {
        const px = vx[e], pz = vz[e];
        const qx = vx[(e + 1) % 3], qz = vz[(e + 1) % 3];
        if (pz >= z0 && pz <= z1) {
          if (px < xmin) xmin = px;
          if (px > xmax) xmax = px;
        }
        const dz = qz - pz;
        if (dz === 0) continue;
        for (let k = 0; k < 2; k++) {
          const t = ((k === 0 ? z0 : z1) - pz) / dz;
          if (t < 0 || t > 1) continue;
          const x = px + (qx - px) * t;
          if (x < xmin) xmin = x;
          if (x > xmax) xmax = x;
        }
      }
      if (xmin > xmax) continue;
      let bx0 = Math.floor((xmin - this.minX) / this.cell);
      let bx1 = Math.floor((xmax - this.minX) / this.cell);
      if (bx1 < 0 || bx0 >= this.nx) continue;
      if (bx0 < 0) bx0 = 0;
      if (bx1 >= this.nx) bx1 = this.nx - 1;
      const row = bzi * this.nx;
      for (let bxi = bx0; bxi <= bx1; bxi++) this.bits[row + bxi] = 1;
    }
  }

  blocked(x: number, z: number): boolean {
    const bx = Math.floor((x - this.minX) / this.cell);
    const bz = Math.floor((z - this.minZ) / this.cell);
    if (bx < 0 || bz < 0 || bx >= this.nx || bz >= this.nz) return false;
    return this.bits[bz * this.nx + bx] === 1;
  }
}

/** What the caller hands over so the studs can be coloured and cleared. */
export interface GroundStudInput {
  grid: ChunkHeightGrid;
  originLat: number;
  originLon: number;
  originEle: number;
  /** Chunk-local zone lookup — the same `ZoneIndex` the buildings use. */
  zoneAt: (lon: number, lat: number) => ZoneKind | null;
  /** Ground-covering meshes already built for this chunk — a stud never stands
   *  on one. */
  blockers?: (THREE.Mesh | undefined | null)[];
  /** Parkland meshes. A stud standing on one is moulded in the park's green —
   *  asked of the MESH rather than of a polygon index, for the same reason the
   *  blockers are: it is the surface that got drawn, and there is then only one
   *  spatial structure in this file instead of two. */
  parkMeshes?: (THREE.Mesh | undefined | null)[];
}

/**
 * Build one chunk's baseplate studs.
 *
 * The lattice loop is the demo's, transliterated: walk the corridor in `STEP`
 * metres along and across, skip the road, skip anything already on the ground,
 * bucket BY COLOUR, and flush one InstancedMesh per bucket.
 *
 * > 依「腳下那塊板實際是什麼顏色」分桶:沒有貼花的是底板綠,有貼花的是疊出來的
 * > 混色。桶數 = 1 + 用到幾種分區,所以最多六個 InstancedMesh。
 */
export function buildGroundStuds(
  strategy: TerrainStyleStrategy,
  input: GroundStudInput,
): GroundStudResult | null {
  const style = strategy.groundStuds;
  if (!style) return null;

  const { grid, originLat, originLon, originEle, zoneAt } = input;
  const nSeg = grid.along - 1;

  const STEP = style.pitch;
  const bandMax = Math.max(0, (style.bandCount ?? 1) - 1);
  const boardW = style.halfWidth * 2;
  const lat0 = -boardW / 2 + style.edgeInset;
  const lat1 = boardW / 2 - style.edgeInset;

  // Occupancy raster, sized to the STUDDED BAND rather than to the corridor.
  // The corridor is ±500 m and the board is ±65, so a raster over the corridor
  // would be ~50× the bytes for the same answer — and RAM, not triangles, is
  // what binds on the low-end target (see the N100 profile).
  //
  // One cell per stud RADIUS, which is what makes the centre test honest: a
  // stud is blocked when something is drawn within about its own rim, not when
  // something is drawn under the exact point its axis passes through.
  const cell = style.radius;
  const pad = style.halfWidth + STEP;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let s = 0; s < grid.along; s++) {
    if (grid.centerX[s] < minX) minX = grid.centerX[s];
    if (grid.centerX[s] > maxX) maxX = grid.centerX[s];
    if (grid.centerZ[s] < minZ) minZ = grid.centerZ[s];
    if (grid.centerZ[s] > maxZ) maxZ = grid.centerZ[s];
  }
  minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
  const occ = new GroundOccupancy(minX, minZ, cell, nx, nz);
  for (const m of input.blockers ?? []) occ.stamp(m);
  // Parkland, same raster machinery — a stud standing on grass is grass-green.
  let park: GroundOccupancy | null = null;
  if (input.parkMeshes?.some((m) => m)) {
    park = new GroundOccupancy(minX, minZ, cell, nx, nz);
    for (const m of input.parkMeshes) park.stamp(m);
  }

  const cosOrigin = Math.cos((originLat * Math.PI) / 180);

  // 依「腳下那塊板實際是什麼顏色」分桶。
  const buckets = new Map<number, number[][]>();
  const push = (color: number, pt: number[]): void => {
    let b = buckets.get(color);
    if (!b) { b = []; buckets.set(color, b); }
    b.push(pt);
  };

  // The demo's lattice loop:
  //
  //   for (let d = d0 + STEP / 2; d < d1; d += STEP)
  //     for (let lat = -boardW/2 + 4; lat <= boardW/2 - 4; lat += STEP)
  //
  // …walked over a corridor instead of a straight ribbon. `d` accumulates over
  // the WHOLE chunk and the section it falls in is looked up, rather than
  // restarting at each section: gameview's sections are `gridSize` apart (24 m
  // for this world) and STEP is 5, so a per-section restart would put a short
  // or long row at every single section seam — 83 seams in a 2 km chunk.
  const { centerX, centerZ, rightX, rightZ } = grid;
  let d = STEP / 2;
  let acc = 0;                       // route distance at the start of section s
  for (let s = 0; s < nSeg; s++) {
    const cx0 = centerX[s], cz0 = centerZ[s];
    const fx = centerX[s + 1] - cx0, fz = centerZ[s + 1] - cz0;
    const segLen = Math.hypot(fx, fz);
    if (segLen < 1e-6) continue;
    for (; d < acc + segLen; d += STEP) {
      const tA = (d - acc) / segLen;
      const mx = cx0 + fx * tA, mz = cz0 + fz * tA;
      const rx = rightX[s] + (rightX[s + 1] - rightX[s]) * tA;
      const rz = rightZ[s] + (rightZ[s + 1] - rightZ[s]) * tA;
      for (let lat = lat0; lat <= lat1; lat += STEP) {
        if (Math.abs(lat) < style.corridorSkip) continue;
        const x = mx + rx * lat, z = mz + rz * lat;
        if (occ.blocked(x, z)) continue;
        // Height AND band from ONE cell lookup — see `sampleChunkCell`.
        const cellHit = sampleChunkCell(grid, x, z, originEle);
        if (cellHit === null) continue;      // outside this chunk's built corridor
        const { y } = cellHit;
        const band = cellHit.band < 0 ? 0
          : cellHit.band > bandMax ? bandMax : cellHit.band;
        // 公園的凸點 = 公園色,而且優先於分區 —— 公園是**畫在**街廓上的一塊草地,
        // 腳下那塊板就是草地色。(demo 也是先測 parks 再測分區貼花)
        let ground: StudGround = null;
        if (park?.blocked(x, z)) {
          ground = 'park';
        } else {
          const lon = originLon + x / (111320 * cosOrigin);
          const geoLat = originLat - z / 111320;
          ground = zoneAt(lon, geoLat);
        }
        push(style.colorFor(ground, band), [x, y, z]);
      }
    }
    acc += segLen;
  }

  const lodGeos = style.lodGeometries();
  const meshes: THREE.InstancedMesh[] = [];
  let studCount = 0;
  for (const [color, pts] of buckets) {
    const im = studInstances(
      pts, style.radius, style.height, style.materialFor(color), lodGeos[0],
    );
    if (im) {
      meshes.push(im);
      studCount += pts.length;
    }
  }
  if (meshes.length === 0) return null;
  return { meshes, studCount, lodGeos, lod: -1 };
}

/**
 * Free a chunk's studs.
 *
 * ⚠ `InstancedMesh.dispose()` only frees its own instanceMatrix — it does NOT
 * touch geometry or material, which is exactly right here: both the unit studs
 * and the bucket materials are strategy-owned singletons shared by every chunk.
 */
export function disposeGroundStuds(res: GroundStudResult): void {
  for (const m of res.meshes) m.dispose();
  res.meshes.length = 0;
}
