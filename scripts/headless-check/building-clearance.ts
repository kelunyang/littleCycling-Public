/**
 * How often does the ridden route actually pass THROUGH a building?
 *
 * Answers the "should houses just avoid the route?" question with numbers
 * instead of a guess: decodes the real OpenFreeMap `building` layer over a saved
 * route and measures, per footprint, the closest approach of the route
 * centreline — plus whether the line goes straight through the polygon.
 *
 *   ROUTE=morning-ride-20260313215539 node --no-warnings \
 *     --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/building-clearance.ts
 *
 * Env: ROUTE (file stem in data/routes), CLEAR (metres of clearance to cost out,
 * default 4).
 */

import { readFileSync } from 'node:fs';

const { decodeMVTTile } = await import('@/game/terrain/mvt-fetcher');

interface RoutePoint { lat: number; lon: number }

const stem = process.env.ROUTE ?? 'morning-ride-20260313215539';
const CLEAR = Number(process.env.CLEAR ?? 4);
const route = JSON.parse(
  readFileSync(new URL(`../../data/routes/${stem}.json`, import.meta.url), 'utf8'),
) as { name: string; points: RoutePoint[] };
const pts = route.points;
console.log(`route "${route.name}" — ${pts.length} points`);

// ── Local metric projection, anchored at the first point ──
const ref = pts[0];
const cosLat = Math.cos((ref.lat * Math.PI) / 180);
const toX = (lon: number) => (lon - ref.lon) * 111320 * cosLat;
const toZ = (lat: number) => (lat - ref.lat) * 111320;

const rx = new Float64Array(pts.length);
const rz = new Float64Array(pts.length);
for (let i = 0; i < pts.length; i++) { rx[i] = toX(pts[i].lon); rz[i] = toZ(pts[i].lat); }

// ── Bucket the route SEGMENTS so a footprint only tests what is near it ──
const CELL = 50;
const key = (cx: number, cz: number) => `${cx},${cz}`;
const buckets = new Map<string, number[]>();
for (let i = 0; i < pts.length - 1; i++) {
  const x0 = Math.min(rx[i], rx[i + 1]), x1 = Math.max(rx[i], rx[i + 1]);
  const z0 = Math.min(rz[i], rz[i + 1]), z1 = Math.max(rz[i], rz[i + 1]);
  for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
    for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
      const k = key(cx, cz);
      let arr = buckets.get(k);
      if (!arr) buckets.set(k, (arr = []));
      arr.push(i);
    }
  }
}

/** Distance from point to segment i..i+1. */
function segDist(px: number, pz: number, i: number): number {
  const ax = rx[i], az = rz[i], bx = rx[i + 1], bz = rz[i + 1];
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** Route segments whose bucket is within `radius` of (px, pz). */
function nearbySegments(px: number, pz: number, radius: number): number[] {
  const out = new Set<number>();
  const r = Math.ceil(radius / CELL);
  const cx0 = Math.floor(px / CELL), cz0 = Math.floor(pz / CELL);
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      const arr = buckets.get(key(cx0 + dx, cz0 + dz));
      if (arr) for (const i of arr) out.add(i);
    }
  }
  return [...out];
}

function segIntersect(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): boolean {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function pointInRing(px: number, pz: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// ── Fetch every z14 tile the route touches, building layer only ──
const Z = 14, n2 = 2 ** Z;
const tileX = (lon: number) => Math.floor(((lon + 180) / 360) * n2);
const tileY = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n2);
};
const tiles = new Set<string>();
for (const p of pts) tiles.add(`${tileX(p.lon)}/${tileY(p.lat)}`);
console.log(`${tiles.size} z14 tiles cover the route`);

const tilejson = await (await fetch('https://tiles.openfreemap.org/planet')).json();
const tpl = tilejson.tiles[0] as string;

interface Hit {
  ring: number[][];
  coords: [number, number][];
  height: number;
  area: number;
  minDist: number;
  crosses: boolean;
  lat: number; lon: number;
}
const hits: Hit[] = [];
let totalFootprints = 0;
const SEARCH = 60; // only footprints within this of the route are interesting

for (const t of tiles) {
  const [tx, ty] = t.split('/').map(Number);
  const res = await fetch(tpl.replace('{z}', String(Z)).replace('{x}', String(tx)).replace('{y}', String(ty)));
  if (!res.ok) { console.warn(`tile ${t}: HTTP ${res.status}`); continue; }
  const feats = decodeMVTTile(await res.arrayBuffer(), tx, ty, Z);

  for (const f of feats) {
    if (f.layer !== 'building') continue;
    let rings: [number, number][][];
    if (f.geometry.type === 'Polygon') rings = [(f.geometry as any).coordinates[0]];
    else if (f.geometry.type === 'MultiPolygon') rings = (f.geometry as any).coordinates.map((p: any) => p[0]);
    else continue;

    for (const coords of rings) {
      if (!coords || coords.length < 3) continue;
      totalFootprints++;
      const ring = coords.map(([lo, la]) => [toX(lo), toZ(la)]);

      // Cheap reject: centroid far from every bucketed segment.
      let cx = 0, cz = 0;
      for (const [x, z] of ring) { cx += x; cz += z; }
      cx /= ring.length; cz /= ring.length;
      const segs = nearbySegments(cx, cz, SEARCH + 200);
      if (segs.length === 0) continue;

      let minDist = Infinity;
      let crosses = false;
      for (const i of segs) {
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k], b = ring[(k + 1) % ring.length];
          const d = Math.min(segDist(a[0], a[1], i), segDist(b[0], b[1], i));
          if (d < minDist) minDist = d;
          if (!crosses && segIntersect(rx[i], rz[i], rx[i + 1], rz[i + 1], a[0], a[1], b[0], b[1])) {
            crosses = true;
          }
        }
        if (!crosses && pointInRing(rx[i], rz[i], ring)) crosses = true;
      }
      if (minDist > SEARCH) continue;

      let area = 0;
      for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
        area += (ring[j][0] + ring[k][0]) * (ring[j][1] - ring[k][1]);
      }
      const height =
        (f.properties.render_height as number) ?? (f.properties.height as number) ??
        ((f.properties.levels as number) ? (f.properties.levels as number) * 3 : 8);
      hits.push({
        ring, coords: coords as [number, number][], height,
        area: Math.abs(area) / 2, minDist, crosses,
        lat: ref.lat + cz / 111320, lon: ref.lon + cx / (111320 * cosLat),
      });
    }
  }
}

console.log(`\n${totalFootprints} footprints decoded, ${hits.length} within ${SEARCH} m of the route\n`);

const crossing = hits.filter((h) => h.crosses);
const bands = [0, 1, 2, 3, 4, 6, 8, 12, 20, 60];
console.log('── closest approach of the route centreline to a footprint ──');
for (let i = 0; i < bands.length - 1; i++) {
  const n = hits.filter((h) => h.minDist >= bands[i] && h.minDist < bands[i + 1]).length;
  console.log(`  ${String(bands[i]).padStart(3)}–${String(bands[i + 1]).padStart(3)} m: ${String(n).padStart(5)}`);
}
console.log(`\nroute goes THROUGH the footprint: ${crossing.length}` +
  ` (${((crossing.length / Math.max(1, hits.length)) * 100).toFixed(1)}% of near footprints,` +
  ` ${((crossing.length / Math.max(1, totalFootprints)) * 100).toFixed(2)}% of all)`);

const wouldDrop = hits.filter((h) => h.minDist < CLEAR);
const dropArea = wouldDrop.reduce((a, h) => a + h.area, 0);
const nearArea = hits.reduce((a, h) => a + h.area, 0);
console.log(`\na "drop anything within ${CLEAR} m of the route" rule would delete ` +
  `${wouldDrop.length} footprints (${((wouldDrop.length / Math.max(1, totalFootprints)) * 100).toFixed(2)}% of all), ` +
  `${(dropArea / Math.max(1, nearArea) * 100).toFixed(1)}% of the near-route built area`);

const big = wouldDrop.filter((h) => h.area > 2000);
console.log(`  of those, ${big.length} are larger than 2000 m² (a whole merged block, not a shed)`);

console.log('\n── 10 worst offenders (route deepest inside) ──');
for (const h of [...crossing].sort((a, b) => b.area - a.area).slice(0, 10)) {
  console.log(`  area=${h.area.toFixed(0).padStart(6)} m²  minDist=${h.minDist.toFixed(1).padStart(5)} m  ${h.lat.toFixed(5)},${h.lon.toFixed(5)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// AFTER: run the PRODUCTION builder over those footprints and measure what it
// actually drew. The numbers above are about the source data; this is about the
// geometry the rider meets, which is what the trim has to get right — the
// matchbox body is an oriented BOX, so a footprint that clears the route by 5 m
// can still be drawn across it.
// ─────────────────────────────────────────────────────────────────────────────

// Canvas stub — the style strategies bake textures at construction (same shim
// as house-preview.ts). Must be installed before the strategy import.
function stubContext() {
  const gradient = { addColorStop: () => {} };
  return new Proxy(
    {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4), width: w, height: h,
      }),
      putImageData: () => {},
      createRadialGradient: () => gradient,
      createLinearGradient: () => gradient,
      measureText: () => ({ width: 0 }),
    } as Record<string, unknown>,
    {
      get(t, p) {
        if (p in t) return t[p as string];
        return typeof p === 'string' && /^[a-z]/.test(p) ? () => {} : undefined;
      },
      set() { return true; },
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

const THREE = await import('three');
const { createTerrainStyleStrategy } = await import('@/game/terrain/terrain-style-strategy');
const { buildBuildingMeshes } = await import('@/game/terrain/building-renderer');

const STYLE = (process.env.STYLE ?? 'plastic') as 'plastic' | 'paper';
const strategy = await createTerrainStyleStrategy(STYLE);

// Scene frame: x east, z SOUTH (the negation is the whole reason the manager
// converts through lon/lat instead of reusing the owner frame directly).
const routeDist = (x: number, z: number): number => {
  const px = x, pz = -z; // back to the +north frame the buckets are built in
  const segs = nearbySegments(px, pz, 120);
  let best = Infinity;
  for (const i of segs) {
    const d = segDist(px, pz, i);
    if (d < best) best = d;
  }
  return best;
};

const sampler = {
  getElevationSync: () => 0,
  async getElevation() { return 0; },
  async prefetchBounds() {},
} as any;

const result = await buildBuildingMeshes(
  hits.map((h) => ({ coordinates: h.coords, height: h.height })),
  sampler, ref.lat, ref.lon, 0, strategy, () => 0, routeDist,
);
console.log(`\nbuilt ${result.buildingCount} of ${hits.length} near-route footprints ` +
  `(${hits.length - result.buildingCount} dropped as standing on the route)`);

// Walk every drawn vertex — bodies, roof trim, facade windows and all.
/** Anything below this can hit the rider; above it is an overhang they pass
 *  under. The plastic body deliberately EJECTS slabs up to 3.2 m out of its box
 *  ("someone played with this"), but never on the ground floor — so the two
 *  numbers have to be reported separately or the pass/fail is meaningless. */
const RIDER_HEAD_M = 2.5;

let minVertDist = Infinity, minHeadDist = Infinity;
let violating = 0, checked = 0, headHigh = 0;
const headSamples: string[] = [];
const worstAt: { x: number; z: number } = { x: 0, z: 0 };
const v = new THREE.Vector3();
const byObject = new Map<string, number>();
result.mesh.updateMatrixWorld(true);
result.mesh.traverse((obj) => {
  const mesh = obj as import('three').Mesh;
  if (!mesh.isMesh || !mesh.geometry?.getAttribute?.('position')) return;
  const inst = mesh as unknown as import('three').InstancedMesh;
  const pos = mesh.geometry.getAttribute('position');
  const mats: import('three').Matrix4[] = [];
  if (inst.isInstancedMesh) {
    for (let i = 0; i < inst.count; i++) {
      const m = new THREE.Matrix4();
      inst.getMatrixAt(i, m);
      mats.push(m.premultiply(mesh.matrixWorld));
    }
  } else {
    mats.push(mesh.matrixWorld);
  }
  for (const m of mats) {
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos as any, i).applyMatrix4(m);
      const d = routeDist(v.x, v.z);
      checked++;
      if (d < minVertDist) { minVertDist = d; worstAt.x = v.x; worstAt.z = v.z; }
      if (d < CLEAR) {
        violating++;
        if (v.y <= RIDER_HEAD_M) {
          headHigh++;
          if (d < minHeadDist) { minHeadDist = d; }
          if (headSamples.length < 40) {
            headSamples.push(`${(ref.lat - v.z / 111320).toFixed(5)},${(ref.lon + v.x / (111320 * cosLat)).toFixed(5)} y=${v.y.toFixed(1)} d=${d.toFixed(2)}`);
          }
        }
        const tag = `${obj.name || (obj === result.mesh ? 'merged-bodies' : 'child')}` +
          ` [${obj.type}${inst.isInstancedMesh ? ` ×${inst.count}` : ''}] y≤${RIDER_HEAD_M}m:${v.y <= RIDER_HEAD_M}`;
        byObject.set(tag, (byObject.get(tag) ?? 0) + 1);
      }
    }
  }
});

const wLat = ref.lat - worstAt.z / 111320;
const wLon = ref.lon + worstAt.x / (111320 * cosLat);
console.log(`checked ${checked} drawn vertices — closest approach to the route: ` +
  `${minVertDist.toFixed(2)} m at ${wLat.toFixed(5)},${wLon.toFixed(5)}`);
console.log(`${violating} vertices inside the ${CLEAR} m corridor at any height ` +
  `(${headHigh} of them at or below ${RIDER_HEAD_M} m, closest ${
    Number.isFinite(minHeadDist) ? `${minHeadDist.toFixed(2)} m` : 'n/a'})`);
console.log(headHigh === 0
  ? `PASS: nothing the rider can hit is inside the ${CLEAR} m corridor`
  : `FAIL: ${headHigh} vertices at rider height inside the ${CLEAR} m corridor`);
for (const [tag, n] of [...byObject].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${tag}: ${n}`);
}
for (const s of headSamples) console.log(`    at ${s}`);

