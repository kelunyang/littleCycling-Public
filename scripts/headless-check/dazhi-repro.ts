/**
 * One-off reproduction probe for the Dazhi "flying roads / floating roofs"
 * report — builds a REAL Dazhi chunk (real route slice, real terrarium DEM,
 * real OpenFreeMap MVT) through the production pipeline and scans the output
 * geometry for absurd heights. Run:
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs scripts/headless-check/dazhi-repro.ts
 */

import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

// ── Canvas stub (same as diorama.ts) ──
function stubContext() {
  const gradient = { addColorStop: () => {} };
  return new Proxy(
    {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      putImageData: () => {},
      createRadialGradient: () => gradient,
      createLinearGradient: () => gradient,
      measureText: () => ({ width: 0 }),
    } as Record<string, unknown>,
    {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        return typeof prop === 'string' && /^[a-z]/.test(prop) ? () => {} : undefined;
      },
      set() {
        return true;
      },
    },
  );
}
(globalThis as any).document = {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
    return { width: 0, height: 0, getContext: () => stubContext() };
  },
};
(globalThis as any).window = { devicePixelRatio: 1 };

const { createPlasticTerrainStyle } = await import('@/game/terrain/plastic-terrain-style');
const { buildTerrainChunk, sampleChunkHeight } = await import('@/game/terrain/terrain-chunk');
const { buildRoadMeshes } = await import('@/game/terrain/road-renderer');
const { extractBuildingsFromMVT, buildBuildingMeshes } = await import('@/game/terrain/building-renderer');
const { decodeMVTTile } = await import('@/game/terrain/mvt-fetcher');
const { buildCumulativeDistances } = await import('@/game/route-geometry');

// ── Real DEM (terrarium PNG decoded manually — the sampler's Image path
//    doesn't exist under Node) ──
type DemTile = { ele: (px: number, py: number) => number };
async function fetchDem(z: number, x: number, y: number): Promise<DemTile> {
  const buf = Buffer.from(
    await (await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`)).arrayBuffer(),
  );
  let pos = 8;
  let w = 0, h = 0, ch = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ch = data[9] === 6 ? 4 : 3; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let yr = 0; yr < h; yr++) {
    const f = raw[rp++];
    const row = yr * stride, prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const rb = raw[rp + i];
      const a = i >= ch ? out[row + i - ch] : 0;
      const b = yr > 0 ? out[prev + i] : 0;
      const c = yr > 0 && i >= ch ? out[prev + i - ch] : 0;
      let v: number;
      switch (f) {
        case 0: v = rb; break;
        case 1: v = rb + a; break;
        case 2: v = rb + b; break;
        case 3: v = rb + ((a + b) >> 1); break;
        default: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = rb + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
      }
      out[row + i] = v & 0xff;
    }
    rp += stride;
  }
  return { ele: (px, py) => {
    const o = Math.min(h - 1, Math.max(0, py)) * stride + Math.min(w - 1, Math.max(0, px)) * ch;
    return out[o] * 256 + out[o + 1] + out[o + 2] / 256 - 32768;
  } };
}

const Z = 14;
const n2 = 2 ** Z;
const demTiles = new Map<string, DemTile>();
async function demAt(lat: number, lon: number): Promise<number> {
  const tx = Math.floor(((lon + 180) / 360) * n2);
  const latRad = (lat * Math.PI) / 180;
  const tyF = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n2;
  const ty = Math.floor(tyF);
  const key = `${tx}/${ty}`;
  let tile = demTiles.get(key);
  if (!tile) { tile = await fetchDem(Z, tx, ty); demTiles.set(key, tile); }
  const px = Math.round((((lon + 180) / 360) * n2 - tx) * 255);
  const py = Math.round((tyF - ty) * 255);
  return tile.ele(px, py);
}

// Sampler facade over the pre-decoded tiles — fully synchronous once the
// covering tiles are loaded (mirrors the browser sampler's post-prefetch path).
function demSyncAt(lat: number, lon: number): number | null {
  const tx = Math.floor(((lon + 180) / 360) * n2);
  const latRad = (lat * Math.PI) / 180;
  const tyF = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n2;
  const ty = Math.floor(tyF);
  const tile = demTiles.get(`${tx}/${ty}`);
  if (!tile) return null;
  const px = Math.round((((lon + 180) / 360) * n2 - tx) * 255);
  const py = Math.round((tyF - ty) * 255);
  return tile.ele(px, py);
}
const sampler = {
  correction: null as null | ((lat: number, lon: number, ele: number) => number),
  async getElevation(lat: number, lon: number): Promise<number> {
    const ele = await demAt(lat, lon);
    return this.correction ? this.correction(lat, lon, ele) : ele;
  },
  getElevationSync(lat: number, lon: number): number | null {
    const ele = demSyncAt(lat, lon);
    if (ele === null) return null;
    return this.correction ? this.correction(lat, lon, ele) : ele;
  },
  async prefetchBounds(_b: unknown): Promise<void> {},
};

// ── Route slice through Dazhi (real saved route) ──
const route = JSON.parse(readFileSync('data/routes/morning-ride-20260313215539.json', 'utf8'));
const points = route.points as { lat: number; lon: number; ele: number }[];
const cumulative = buildCumulativeDistances(points);
// Chunk to reproduce — default 2 (Dazhi); CHUNK=0 tests the dense-city start.
const CHUNK_RANGES: Record<string, [number, number]> = {
  '0': [0, 339], '1': [339, 603], '2': [603, 951], '3': [951, 1558],
  '4': [1558, 2009], '5': [2009, 2413], '6': [2413, 3279], '7': [3279, 4120],
};
const [startIdx, endIdx] = CHUNK_RANGES[process.env.CHUNK ?? '2'] ?? CHUNK_RANGES['2'];
// Toggle the urban/building flattening with FLATTEN=0 for A/B comparison.
const FLATTEN = process.env.FLATTEN !== '0';
const originLat = points[0].lat, originLon = points[0].lon, originEle = points[0].ele;

// Pre-warm the sync elevation cache for every sample the pipeline will ask for:
// brute-force a lat/lon grid over the corridor bounds instead (nearest-100k key).
let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
for (let i = startIdx; i <= endIdx; i++) {
  const p = points[i];
  if (p.lat < minLat) minLat = p.lat;
  if (p.lat > maxLat) maxLat = p.lat;
  if (p.lon < minLon) minLon = p.lon;
  if (p.lon > maxLon) maxLon = p.lon;
}
const PADD = 0.012;
minLat -= PADD; maxLat += PADD; minLon -= PADD; maxLon += PADD;
// Preload every DEM tile covering the padded bounds (corner sampling).
for (const lat of [minLat, maxLat]) {
  for (const lon of [minLon, maxLon]) {
    await demAt(lat, lon);
  }
}
console.log('DEM tiles preloaded:', demTiles.size);

const strategy = createPlasticTerrainStyle();

// ── Fetch MVT FIRST (mirrors the new pipeline) and install the urban/building
// flattening correction before the terrain samples the DEM. ──
const tilejson0 = await (await fetch('https://tiles.openfreemap.org/planet')).json();
const tpl0 = tilejson0.tiles[0] as string;
function tileOf0(lat: number, lon: number) {
  const x = Math.floor(((lon + 180) / 360) * n2);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n2);
  return { x, y };
}
const tl0 = tileOf0(maxLat, minLon);
const br0 = tileOf0(minLat, maxLon);
const preFeatures: any[] = [];
for (let x = tl0.x; x <= br0.x; x++) {
  for (let y = tl0.y; y <= br0.y; y++) {
    const buf = await (await fetch(tpl0.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y)))).arrayBuffer();
    preFeatures.push(...decodeMVTTile(buf, x, y, Z));
  }
}
const { isUrbanLanduse, extractPolygonCoords } = await import('@/game/terrain/landuse-renderer');
type Entry = { ring: [number, number][]; minLon: number; maxLon: number; minLat: number; maxLat: number; floor: number | 'route' };
const entries: Entry[] = [];
for (const f of preFeatures) {
  const isBld = f.layer === 'building';
  const isUrb = f.layer === 'landuse' && isUrbanLanduse(f);
  if (!isBld && !isUrb) continue;
  for (const ring of extractPolygonCoords(f)) {
    if (ring.length < 3) continue;
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [lo, la] of ring) {
      if (lo < a) a = lo; if (lo > b) b = lo;
      if (la < c) c = la; if (la > d) d = la;
    }
    if (isBld) {
      let floor = Infinity;
      const step = Math.max(1, Math.floor(ring.length / 8));
      for (let k = 0; k < ring.length; k += step) {
        const s = demSyncAt(ring[k][1], ring[k][0]);
        if (s !== null && s < floor) floor = s;
      }
      if (!Number.isFinite(floor)) continue;
      entries.push({ ring, minLon: a, maxLon: b, minLat: c, maxLat: d, floor });
    } else {
      entries.push({ ring, minLon: a, maxLon: b, minLat: c, maxLat: d, floor: 'route' });
    }
  }
}
console.log('flatten entries:', entries.length, `(urban: ${entries.filter((e) => e.floor === 'route').length})`);
const URBAN_CLAMP_M = 12;
function nearestRouteEle(lon: number, lat: number): number {
  let best = Infinity, bestEle = Infinity;
  for (let i = 0; i < points.length; i += 8) {
    const dx = (points[i].lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180);
    const dz = (points[i].lat - lat) * 111320;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) { best = d2; bestEle = points[i].ele; }
  }
  return best < 1500 * 1500 ? bestEle : Infinity;
}
sampler.correction = !FLATTEN ? null : (lat, lon, ele) => {
  let out = ele;
  let routeFloor: number | null = null;
  for (const e of entries) {
    if (lon < e.minLon || lon > e.maxLon || lat < e.minLat || lat > e.maxLat) continue;
    let floor: number;
    if (e.floor === 'route') {
      if (routeFloor === null) routeFloor = nearestRouteEle(lon, lat) + URBAN_CLAMP_M;
      floor = routeFloor;
    } else floor = e.floor;
    if (floor >= out) continue;
    let inside = false;
    const ring = e.ring;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) out = floor;
  }
  return out;
};

const terrain = await buildTerrainChunk(
  {
    points,
    cumulativeDistances: cumulative,
    startIdx,
    endIdx,
    chunkIndex: 2,
    prevEdge: undefined,
    corridorHalfWidth: 500,
    gridSizeScale: 1,
  } as any,
  sampler as any,
  originLat,
  originLon,
  originEle,
  strategy,
);
const grid = terrain.heightGrid;
console.log('terrain built, verts:', terrain.mesh.geometry.getAttribute('position').count);

// Terrain height stats
const tp = terrain.mesh.geometry.getAttribute('position');
let tMin = Infinity, tMax = -Infinity;
for (let i = 0; i < tp.count; i++) {
  const y = tp.getY(i);
  if (y < tMin) tMin = y;
  if (y > tMax) tMax = y;
}
console.log(`terrain y range: ${tMin.toFixed(1)} .. ${tMax.toFixed(1)}`);

const ground = (x: number, z: number): number | null => sampleChunkHeight(grid, x, z, originEle);

// ── Real MVT for the same bounds ──
const tilejson = await (await fetch('https://tiles.openfreemap.org/planet')).json();
const tpl = tilejson.tiles[0] as string;
function tileOf(lat: number, lon: number) {
  const x = Math.floor(((lon + 180) / 360) * n2);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n2);
  return { x, y };
}
const tl = tileOf(maxLat, minLon);
const br = tileOf(minLat, maxLon);
const features: any[] = [];
for (let x = tl.x; x <= br.x; x++) {
  for (let y = tl.y; y <= br.y; y++) {
    const buf = await (await fetch(tpl.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y)))).arrayBuffer();
    features.push(...decodeMVTTile(buf, x, y, Z));
  }
}
console.log('MVT features:', features.length);

// ── Roads through the real pipeline ──
const roadResult = await buildRoadMeshes(
  features, sampler as any, originLat, originLon, originEle, strategy, ground,
);
// One mesh per distinct road MATERIAL (circuit splits by class; the others
// merge to one), so every count here is over all of them.
let roadVerts = 0;
let rMin = Infinity, rMax = -Infinity;
const highSamples: { x: number; y: number; z: number }[] = [];
for (const mesh of roadResult.meshes) {
  const rp2 = mesh.geometry.getAttribute('position');
  roadVerts += rp2.count;
  for (let i = 0; i < rp2.count; i++) {
    const y = rp2.getY(i);
    if (y < rMin) rMin = y;
    if (y > rMax) rMax = y;
    if (y > tMax + 5 && highSamples.length < 12) {
      highSamples.push({ x: rp2.getX(i), y, z: rp2.getZ(i) });
    }
  }
}
console.log(`roads: ${roadResult.roadCount}, ${roadResult.meshes.length} mesh(es), verts ${roadVerts}, y range ${rMin.toFixed(1)} .. ${rMax.toFixed(1)} (terrain max ${tMax.toFixed(1)})`);
for (const s of highSamples) {
  const lon = originLon + s.x / (111320 * Math.cos((originLat * Math.PI) / 180));
  const lat = originLat - s.z / 111320;
  console.log(`  HIGH road vert y=${s.y.toFixed(1)} at ${lat.toFixed(5)},${lon.toFixed(5)} ground=${ground(s.x, s.z)?.toFixed(1) ?? 'null'}`);
}
if (roadResult.railMesh) {
  const rl = roadResult.railMesh.geometry.getAttribute('position');
  let ylo = Infinity, yhi = -Infinity;
  for (let i = 0; i < rl.count; i++) {
    const y = rl.getY(i);
    if (y < ylo) ylo = y;
    if (y > yhi) yhi = y;
  }
  console.log(`rails: verts ${rl.count}, y range ${ylo.toFixed(1)} .. ${yhi.toFixed(1)}`);
}

// ── Buildings through the real pipeline ──
const bounds = { south: minLat, north: maxLat, west: minLon, east: maxLon };
const fps = extractBuildingsFromMVT(features, bounds);
console.log('footprints:', fps.length);
const bResult = await buildBuildingMeshes(
  fps, sampler as any, originLat, originLon, originEle, strategy, ground,
);
const bp = bResult.mesh.geometry.getAttribute('position');
let bMin = Infinity, bMax = -Infinity, nanCount = 0;
for (let i = 0; i < bp.count; i++) {
  const y = bp.getY(i);
  if (Number.isNaN(y) || Number.isNaN(bp.getX(i)) || Number.isNaN(bp.getZ(i))) { nanCount++; continue; }
  if (y < bMin) bMin = y;
  if (y > bMax) bMax = y;
}
console.log(`buildings: ${bResult.buildingCount}, verts ${bp.count}, y range ${bMin.toFixed(1)} .. ${bMax.toFixed(1)}, NaN verts: ${nanCount}`);

// Height histogram of extruded bodies: how many buildings are TALL?
const heightHist = new Map<number, number>();
for (const fp of fps) {
  const bucket = Math.min(100, Math.round(fp.height / 10) * 10);
  heightHist.set(bucket, (heightHist.get(bucket) ?? 0) + 1);
}
console.log('footprint height histogram (10m buckets):',
  [...heightHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}m:${v}`).join(' '));

// Scan EVERY produced object (body + decorations + facades + lights) for
// world-spanning bounding boxes — the "black sheets across the sky".
function describe(obj: import('three').Object3D, label: string): void {
  const m = obj as import('three').Mesh;
  const g = m.geometry as import('three').BufferGeometry | undefined;
  if (!g?.getAttribute) return;
  const p = g.getAttribute('position');
  if (!p) return;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity, nan = 0;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) { nan++; continue; }
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const inst = (m as unknown as { isInstancedMesh?: boolean; count?: number }).isInstancedMesh
    ? ` instanced×${(m as unknown as { count: number }).count}`
    : '';
  console.log(`  [${label}]${inst} verts=${p.count} nan=${nan} x ${x0.toFixed(0)}..${x1.toFixed(0)} y ${y0.toFixed(1)}..${y1.toFixed(1)} z ${z0.toFixed(0)}..${z1.toFixed(0)}`);
}
console.log('building mesh children:');
describe(bResult.mesh, 'body');
bResult.mesh.children.forEach((c, i) => describe(c, `child${i}:${c.type}`));
if (bResult.lightsMesh) describe(bResult.lightsMesh, 'lights');

// Instanced meshes: bbox of GEOMETRY is per-instance — also scan instance matrices
// INCLUDING tz (the z-mirror bug family hides there).
for (const c of [bResult.mesh, ...bResult.mesh.children, ...(bResult.lightsMesh ? [bResult.lightsMesh] : [])]) {
  const im = c as import('three').InstancedMesh;
  if (!(im as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) continue;
  const arr = im.instanceMatrix.array as Float32Array;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity, nan = 0;
  for (let i = 0; i < im.count; i++) {
    const tx = arr[i * 16 + 12], ty = arr[i * 16 + 13], tz = arr[i * 16 + 14];
    if (Number.isNaN(tx) || Number.isNaN(ty) || Number.isNaN(tz)) { nan++; continue; }
    if (tx < x0) x0 = tx; if (tx > x1) x1 = tx;
    if (ty < y0) y0 = ty; if (ty > y1) y1 = ty;
    if (tz < z0) z0 = tz; if (tz > z1) z1 = tz;
  }
  console.log(`  instanced [${(c as import('three').Object3D).name || 'mesh'}]: n=${im.count} nan=${nan} x ${x0.toFixed(0)}..${x1.toFixed(0)} y ${y0.toFixed(1)}..${y1.toFixed(1)} z ${z0.toFixed(0)}..${z1.toFixed(0)}`);
}

// ── Landuse + aeroway slabs share the ShapeGeometry+rotateX(-90°) pattern —
// check their z sign against the roads (which are known-correct). ──
const { buildLanduseMeshes } = await import('@/game/terrain/landuse-renderer');
const landuse = await buildLanduseMeshes(
  features, sampler as any, originLat, originLon, originEle, strategy,
);
for (const layer of landuse.layers) {
  const g = layer.mesh.geometry as import('three').BufferGeometry;
  const p = g?.getAttribute?.('position');
  if (!p || p.count === 0) continue;
  let z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  console.log(`  landuse[${layer.kind}] n=${layer.count} z ${z0.toFixed(0)}..${z1.toFixed(0)}`);
}
const { buildAerowayMeshes } = await import('@/game/terrain/aeroway-renderer');
const aero = await buildAerowayMeshes(
  features, sampler as any, originLat, originLon, originEle, strategy, ground,
);
{
  const p = (aero.mesh.geometry as import('three').BufferGeometry)?.getAttribute?.('position');
  if (p && p.count > 0) {
    let z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i);
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    console.log(`  aeroway n=${aero.featureCount} z ${z0.toFixed(0)}..${z1.toFixed(0)}`);
  }
}
console.log('roads z reference: should be NEGATIVE band (north of origin) like the body mesh');

// ── Sliver-triangle detector: triangles with any edge > 100m are geometry
// soup (they render as the "lines across the sky"). ──
function scanSlivers(label: string, mesh: import('three').Mesh | null | undefined): void {
  const g = mesh?.geometry as import('three').BufferGeometry | undefined;
  const p = g?.getAttribute?.('position');
  if (!g || !p || !g.index) { console.log(`  sliver[${label}]: (no indexed geometry)`); return; }
  const idx = g.index.array;
  let bad = 0;
  const examples: string[] = [];
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ax = p.getX(a), ay = p.getY(a), az = p.getZ(a);
    const bx = p.getX(b), by = p.getY(b), bz = p.getZ(b);
    const cx = p.getX(c), cy = p.getY(c), cz = p.getZ(c);
    const e1 = Math.hypot(ax - bx, ay - by, az - bz);
    const e2 = Math.hypot(bx - cx, by - cy, bz - cz);
    const e3 = Math.hypot(cx - ax, cy - ay, cz - az);
    const m = Math.max(e1, e2, e3);
    if (m > 800) {
      bad++;
      if (examples.length < 5) {
        examples.push(`tri#${t / 3} maxEdge=${m.toFixed(0)}m A(${ax.toFixed(0)},${ay.toFixed(0)},${az.toFixed(0)}) B(${bx.toFixed(0)},${by.toFixed(0)},${bz.toFixed(0)}) C(${cx.toFixed(0)},${cy.toFixed(0)},${cz.toFixed(0)})`);
      }
    }
  }
  console.log(`  sliver[${label}]: ${bad} triangles with edge >800m (of ${idx.length / 3})`);
  for (const e of examples) console.log(`    ${e}`);
}
roadResult.meshes.forEach((m, i) => scanSlivers(`roads[${i}]`, m));
scanSlivers('rails', roadResult.railMesh);
scanSlivers('terrain', terrain.mesh);
scanSlivers('buildings', bResult.mesh);
for (const layer of landuse.layers) scanSlivers(`landuse:${layer.kind}`, layer.mesh);
scanSlivers('aeroway', aero.mesh);
const { buildWaterwayMeshes } = await import('@/game/terrain/waterway-renderer');
const ww = await buildWaterwayMeshes(features, sampler as any, originLat, originLon, originEle, strategy, ground);
scanSlivers('waterway', ww.mesh);
console.log('done');
