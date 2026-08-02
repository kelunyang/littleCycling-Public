/**
 * Headless CPU render of the real Dazhi scene — no WebGL, no browser, no
 * round-trips. Builds chunks 2-4 + the route line through the PRODUCTION
 * pipeline, rasterises them with a tiny z-buffered renderer from the rider's
 * viewpoint, and writes PNGs. CATEGORY env bisects: "all" or a comma list of
 * terrain,road,rail,building,landuse,route.
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs scripts/headless-check/render-probe.ts
 */

import { inflateSync, deflateSync, crc32 } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

// ── Canvas stub (same as diorama.ts) ──
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
const { buildTerrainChunk, sampleChunkHeight, maxChunkHeight } = await import('@/game/terrain/terrain-chunk');
const { buildRoadMeshes } = await import('@/game/terrain/road-renderer');
const { extractBuildingsFromMVT, buildBuildingMeshes } = await import('@/game/terrain/building-renderer');
const { buildLanduseMeshes, extractPolygonCoords, isUrbanLanduse } = await import('@/game/terrain/landuse-renderer');
const { ZoneIndex, zoneFromLanduseClass } = await import('@/game/terrain/land-zone');
const { buildWaterwayMeshes } = await import('@/game/terrain/waterway-renderer');
const { buildAerowayMeshes } = await import('@/game/terrain/aeroway-renderer');
const { buildTreeMeshes } = await import('@/game/terrain/tree-renderer');
// NOT a mirror: the blocking set lives in `ground-studs.ts` and both the chunk
// manager and this probe read that one. (Copying the pipeline is what makes a
// probe useful; copying its LOGIC is what makes it lie — see `makeGroundFn`.)
const { buildGroundStuds, STUD_BLOCKING_LANDUSE } = await import('@/game/terrain/ground-studs');
const { decodeMVTTile } = await import('@/game/terrain/mvt-fetcher');
const { census, formatCensus } = await import('./scene-census.mjs');
const { buildCumulativeDistances } = await import('@/game/route-geometry');
const { createRouteLine, projectRouteLineOntoTerrain, setRouteLineWindow } =
  await import('@/game/terrain/route-line-mesh');
const { MountainRing } = await import('@/game/terrain/mountain-ring');

// ── DEM (same decoder as dazhi-repro) ──
type DemTile = { ele: (px: number, py: number) => number };
async function fetchDem(z: number, x: number, y: number): Promise<DemTile> {
  const buf = Buffer.from(await (await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`)).arrayBuffer());
  let pos = 8; let w = 0, h = 0, ch = 0; const idat: Buffer[] = [];
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
  const stride = w * ch; const out = Buffer.alloc(h * stride); let rp = 0;
  for (let yr = 0; yr < h; yr++) {
    const f = raw[rp++]; const row = yr * stride, prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const rb = raw[rp + i];
      const a = i >= ch ? out[row + i - ch] : 0, b = yr > 0 ? out[prev + i] : 0;
      const c = yr > 0 && i >= ch ? out[prev + i - ch] : 0;
      let v: number;
      switch (f) {
        case 0: v = rb; break; case 1: v = rb + a; break; case 2: v = rb + b; break;
        case 3: v = rb + ((a + b) >> 1); break;
        default: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = rb + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
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
const Z = 14, n2 = 2 ** Z;
const demTiles = new Map<string, DemTile>();
async function demAt(lat: number, lon: number): Promise<number> {
  const tx = Math.floor(((lon + 180) / 360) * n2);
  const latRad = (lat * Math.PI) / 180;
  const tyF = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n2;
  const ty = Math.floor(tyF);
  const key = `${tx}/${ty}`;
  let t = demTiles.get(key);
  if (!t) { t = await fetchDem(Z, tx, ty); demTiles.set(key, t); }
  return t.ele(Math.round((((lon + 180) / 360) * n2 - tx) * 255), Math.round((tyF - ty) * 255));
}
function demSyncAt(lat: number, lon: number): number | null {
  const tx = Math.floor(((lon + 180) / 360) * n2);
  const latRad = (lat * Math.PI) / 180;
  const tyF = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n2;
  const ty = Math.floor(tyF);
  const t = demTiles.get(`${tx}/${ty}`);
  if (!t) return null;
  return t.ele(Math.round((((lon + 180) / 360) * n2 - tx) * 255), Math.round((tyF - ty) * 255));
}
const sampler = {
  correction: null as null | ((lat: number, lon: number, ele: number) => number),
  async getElevation(lat: number, lon: number) { const e = await demAt(lat, lon); return this.correction ? this.correction(lat, lon, e) : e; },
  getElevationSync(lat: number, lon: number) { const e = demSyncAt(lat, lon); return e === null ? null : (this.correction ? this.correction(lat, lon, e) : e); },
  async prefetchBounds() {},
};

// ── Route + chunks ──
const route = JSON.parse(readFileSync('data/routes/morning-ride-20260313215539.json', 'utf8'));
const points = route.points as { lat: number; lon: number; ele: number }[];
const cumulative = buildCumulativeDistances(points);
const originLat = points[0].lat, originLon = points[0].lon, originEle = points[0].ele;
const cosO = Math.cos((originLat * Math.PI) / 180);

const CHUNKS: Record<number, [number, number]> = { 2: [603, 951], 3: [951, 1558], 4: [1558, 2009] };

// nearest-route ownership (production-equivalent, stride 4)
function ownerChunkOf(lon: number, lat: number): number {
  let best = Infinity, bi = -1;
  for (let i = 0; i < points.length; i += 4) {
    const dx = (points[i].lon - lon) * 111320 * cosO;
    const dz = (points[i].lat - lat) * 111320;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) { best = d2; bi = i; }
  }
  if (bi < 0 || best > 1200 * 1200) return -1;
  for (const [ci, [s, e]] of Object.entries(CHUNKS)) if (bi >= s && bi <= e) return +ci;
  return -1;
}

// preload DEM over all three chunks' padded bounds — EVERY covering tile, the
// way production's sampler.prefetchBounds does. Sampling only the four corners
// left the interior tiles uncached, so getElevationSync returned null for most
// of the probe's ground queries and the run exercised a fallback path that
// production almost never takes.
{
  let mnLa = Infinity, mxLa = -Infinity, mnLo = Infinity, mxLo = -Infinity;
  for (let i = CHUNKS[2][0]; i <= CHUNKS[4][1]; i++) {
    const p = points[i];
    mnLa = Math.min(mnLa, p.lat); mxLa = Math.max(mxLa, p.lat);
    mnLo = Math.min(mnLo, p.lon); mxLo = Math.max(mxLo, p.lon);
  }
  mnLa -= 0.012; mxLa += 0.012; mnLo -= 0.012; mxLo += 0.012;
  const txMin = Math.floor(((mnLo + 180) / 360) * n2);
  const txMax = Math.floor(((mxLo + 180) / 360) * n2);
  const tyOf = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n2);
  };
  const tyMin = tyOf(mxLa), tyMax = tyOf(mnLa);
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) {
      const key = `${tx}/${ty}`;
      if (!demTiles.has(key)) demTiles.set(key, await fetchDem(Z, tx, ty));
    }
  }
  console.log('DEM tiles preloaded:', demTiles.size);
}

// STYLE=plastic|paper|circuit — the styles build very different geometry, so
// the vertex budget below has to be checked for every one of them. (This takes
// the INTERNAL terrain-style id, where the corrugated world is called `paper` —
// see terrain-style-strategy.ts §10.1 on the naming.)
const strategy = await createTerrainStyleStrategy(
  (process.env.STYLE ?? 'plastic') as 'plastic' | 'paper' | 'circuit');
const tilejson = await (await fetch('https://tiles.openfreemap.org/planet')).json();
const tpl = tilejson.tiles[0] as string;

// ── BOXSTATS=1 — what sizes does the real route actually hand a body builder? ──
//
// Exists because porting a demo body means porting its FORMULAS, and a demo's
// formulas only ever saw the demo's own `buildingDims` table (a paper shop is
// 6.5–9 m tall there, an MVT commercial block is whatever it is). Every clamp a
// port keeps on top of the demo has to be justified by a number from HERE, not
// by a feeling that "MVT boxes can be big" — and the one that killed the first
// run of the toy-world port was the opposite mistake: `box.height = 0` fed into
// a demo formula that divides by height.
//
// Wraps the strategy rather than reaching into the renderer, so it measures the
// boxes the STYLE is asked about, which is exactly the population in question.
if (process.env.BOXSTATS) {
  const seen = new Map<string, { w: number[]; d: number[]; h: number[] }>();
  const note = (zone: string | null, b: { width: number; depth: number; height: number }): void => {
    const key = zone ?? 'none';
    let s = seen.get(key);
    if (!s) { s = { w: [], d: [], h: [] }; seen.set(key, s); }
    s.w.push(b.width); s.d.push(b.depth); s.h.push(b.height);
  };
  for (const hook of ['buildBuildingBoxes', 'buildBuildingBody'] as const) {
    const fn = (strategy as any)[hook];
    if (!fn) continue;
    (strategy as any)[hook] = (b: any, seed: number, zone: any) => {
      note(zone, b);
      return fn.call(strategy, b, seed, zone);
    };
  }
  process.on('exit', () => {
    console.log('\nBOXSTATS — oriented box extents the style was asked about');
    const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
    for (const [zone, s] of [...seen].sort((a, b) => b[1].w.length - a[1].w.length)) {
      for (const arr of [s.w, s.d, s.h]) arr.sort((a, b) => a - b);
      console.log(
        `  ${zone.padEnd(12)} n=${String(s.w.length).padStart(4)}  `
        + `w ${q(s.w, 0).toFixed(1)}/${q(s.w, 0.5).toFixed(1)}/${q(s.w, 0.99).toFixed(1)}  `
        + `d ${q(s.d, 0).toFixed(1)}/${q(s.d, 0.5).toFixed(1)}/${q(s.d, 0.99).toFixed(1)}  `
        + `h ${q(s.h, 0).toFixed(1)}/${q(s.h, 0.5).toFixed(1)}/${q(s.h, 0.99).toFixed(1)}  (min/median/p99)`);
    }
  });
}

// EYE / TARGET as "x,y,z" scene metres — so a report can be reproduced from
// wherever the rider actually was.
const parseV = (env: string | undefined, dx: number, dy: number, dz: number) => {
  if (!env) return new THREE.Vector3(dx, dy, dz);
  const [a, b, c] = env.split(',').map(Number);
  return new THREE.Vector3(a, b, c);
};
const eyeForRing = parseV(process.env.EYE, -1060, 8, -2780);
const targetForRing = parseV(process.env.TARGET, -1160, 12, -2880);

interface Draw { name: string; cat: string; mesh: import('three').Mesh; }
const draws: Draw[] = [];

// ── ROADAUDIT=runs: how badly is a ribbon shredded? ──
//
// `assembleStrip` bridges a quad only between DIRECTLY adjacent kept samples,
// so every sample the ground function refuses splits the ribbon. A run left
// with one or two quads is a black confetto lying on the hillside, which is
// what the "black lines" reports have been about since the flying ones were
// fixed. Vertex audits are blind to this — the vertices are all exactly where
// they should be; it is the STITCHING that is missing.
const groundNulls = { ok: 0, noGrid: 0, buried: 0, farFromDem: 0 };
function resetGroundNulls(): void {
  groundNulls.ok = 0; groundNulls.noGrid = 0; groundNulls.buried = 0; groundNulls.farFromDem = 0;
}

/** Walk a built ribbon mesh and report its runs of stitched quads. */
function reportRibbonRuns(
  label: string,
  mesh: import('three').Mesh,
  nulls: typeof groundNulls,
): void {
  const geo = mesh.geometry as import('three').BufferGeometry | undefined;
  const idx = geo?.index;
  const pos = geo?.getAttribute?.('position');
  if (!idx || !pos) { console.log(`${label}: no ribbon geometry`); return; }

  // Quads are emitted as (a, a+1, a+2) + (a+1, a+3, a+2) with `a` the first
  // vertex of the earlier sample's pair, so a run is a maximal chain whose `a`
  // steps by exactly 2. A merge boundary breaks the chain on its own.
  const arr = idx.array as ArrayLike<number>;
  const runs: number[] = []; // metres per run
  let runQuads = 0, runLen = 0, prevA = -99;
  const mid = (slotBase: number): [number, number, number] => [
    (pos.getX(slotBase) + pos.getX(slotBase + 1)) / 2,
    (pos.getY(slotBase) + pos.getY(slotBase + 1)) / 2,
    (pos.getZ(slotBase) + pos.getZ(slotBase + 1)) / 2,
  ];
  const quadCounts: number[] = [];
  const flush = (): void => {
    if (runQuads > 0) { runs.push(runLen); quadCounts.push(runQuads); }
    runQuads = 0; runLen = 0;
  };
  let outOfRange = 0, nonFinite = 0;
  const samples: string[] = [];
  for (let t = 0; t + 5 < arr.length; t += 6) {
    const a = arr[t];
    if (a !== prevA + 2) flush();
    if (a + 3 >= pos.count) {
      outOfRange++;
      if (samples.length < 5) samples.push(`idx[${t}]=${a} but pos.count=${pos.count}`);
      prevA = a; continue;
    }
    const p = mid(a), q = mid(a + 2);
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (!Number.isFinite(d)) {
      nonFinite++;
      if (samples.length < 5) samples.push(`idx[${t}]=${a} p=${p.map((v) => v.toFixed(1))} q=${q.map((v) => v.toFixed(1))}`);
      prevA = a; continue;
    }
    runLen += d;
    runQuads++;
    prevA = a;
  }
  flush();
  if (outOfRange || nonFinite) {
    console.log(`  !! ${outOfRange} quads index past the vertex buffer, ${nonFinite} with non-finite positions`);
    for (const s of samples) console.log(`     ${s}`);
  }

  const bands = [0, 5, 10, 15, 25, 50, 100, Infinity];
  const total = runs.reduce((s, r) => s + r, 0);
  console.log(`\n── ${label}: ${runs.length} stitched runs, ${total.toFixed(0)} m of ribbon ──`);
  for (let i = 0; i < bands.length - 1; i++) {
    const sel = runs.filter((r) => r >= bands[i] && r < bands[i + 1]);
    if (sel.length === 0) continue;
    const m = sel.reduce((s, r) => s + r, 0);
    console.log(
      `  ${String(bands[i]).padStart(4)}–${String(bands[i + 1]).padStart(4)} m: ` +
      `${String(sel.length).padStart(5)} runs, ${m.toFixed(0).padStart(6)} m ` +
      `(${((m / Math.max(1, total)) * 100).toFixed(1)}% of length)`,
    );
  }
  const confetti = runs.filter((r) => r < 15);
  console.log(
    `  runs under 15 m: ${confetti.length} (${((confetti.length / Math.max(1, runs.length)) * 100).toFixed(1)}% of runs, ` +
    `${((confetti.reduce((s, r) => s + r, 0) / Math.max(1, total)) * 100).toFixed(1)}% of length)`,
  );
  const nTotal = nulls.ok + nulls.noGrid + nulls.buried + nulls.farFromDem;
  console.log(
    `  ground() over ${nTotal} samples: ok=${nulls.ok} ` +
    `noGrid=${nulls.noGrid} buried=${nulls.buried} farFromDem=${nulls.farFromDem} ` +
    `(${(((nTotal - nulls.ok) / Math.max(1, nTotal)) * 100).toFixed(1)}% refused)`,
  );
}
const grids: { grid: any; }[] = [];
const terrains: any[] = [];

for (const [ciStr, [sIdx, eIdx]] of Object.entries(CHUNKS)) {
  const ci = +ciStr;
  const terrain = await buildTerrainChunk(
    {
      points, cumulativeDistances: cumulative, startIdx: sIdx, endIdx: eIdx,
      chunkIndex: ci, prevEdge: undefined, corridorHalfWidth: 500, gridSizeScale: 1,
    } as any,
    sampler as any, originLat, originLon, originEle, strategy,
  );
  grids.push({ grid: terrain.heightGrid });
  terrains.push(terrain);
  draws.push({ name: `chunk${ci}/terrain`, cat: 'terrain', mesh: terrain.mesh });

  // bounds + MVT
  let mnLa = Infinity, mxLa = -Infinity, mnLo = Infinity, mxLo = -Infinity;
  for (let i = sIdx; i <= eIdx; i++) {
    const p = points[i];
    mnLa = Math.min(mnLa, p.lat); mxLa = Math.max(mxLa, p.lat);
    mnLo = Math.min(mnLo, p.lon); mxLo = Math.max(mxLo, p.lon);
  }
  const bounds = { south: mnLa - 0.005, north: mxLa + 0.005, west: mnLo - 0.005, east: mxLo + 0.005 };
  const feats: any[] = [];
  const tl = { x: Math.floor(((bounds.west + 180) / 360) * n2), y: Math.floor(((1 - Math.log(Math.tan(bounds.north * Math.PI / 180) + 1 / Math.cos(bounds.north * Math.PI / 180)) / Math.PI) / 2) * n2) };
  const br = { x: Math.floor(((bounds.east + 180) / 360) * n2), y: Math.floor(((1 - Math.log(Math.tan(bounds.south * Math.PI / 180) + 1 / Math.cos(bounds.south * Math.PI / 180)) / Math.PI) / 2) * n2) };
  for (let x = tl.x; x <= br.x; x++) for (let y = tl.y; y <= br.y; y++) {
    const buf = await (await fetch(tpl.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y)))).arrayBuffer();
    feats.push(...decodeMVTTile(buf, x, y, Z));
  }

  // !! MIRROR OF TerrainChunkManager.makeGroundFn !!
  // This copy exists because the probe builds chunks directly instead of
  // driving a real chunk manager. It has drifted from production more than once
  // and every time it did, the probe reported a fix as working when the game
  // had never seen it. If you change makeGroundFn, change this in the same
  // commit.
  const ground = (x: number, z: number, preferY?: number) => {
    const lon = originLon + x / (111320 * cosO);
    const lat = originLat - z / 111320;
    const dem = sampler.getElevationSync(lat, lon);
    if (dem === null) {
      const h0 = sampleChunkHeight(terrain.heightGrid, x, z, originEle, preferY);
      if (h0 === null) { groundNulls.noGrid++; return null; }
      if (preferY === undefined) return h0;
      if (Math.abs(h0 - preferY) > 12) { groundNulls.farFromDem++; return null; }
      return h0;
    }
    const demRel = dem - originEle;
    const h = sampleChunkHeight(terrain.heightGrid, x, z, originEle, demRel);
    if (h === null) { groundNulls.noGrid++; return null; }
    const top = maxChunkHeight(terrain.heightGrid, x, z, originEle);
    if (top !== null && top - h > 2) { groundNulls.buried++; return null; } // buried under a higher deck
    if (Math.abs(h - demRel) > 12) { groundNulls.farFromDem++; return null; }
    groundNulls.ok++;
    return h;
  };
  const owns = (lon: number, lat: number) => ownerChunkOf(lon, lat) === ci;

  resetGroundNulls();
  const _tRoad = performance.now();
  const roads = await buildRoadMeshes(feats, sampler as any, originLat, originLon, originEle, strategy, ground, owns);
  const roadMs = performance.now() - _tRoad;
  // Roads are per-chunk, and chunk build time is the only cost in this project
  // that has ever held up under measurement — so it gets printed, like the studs
  // and the building footprints do. `meshes.length` is the material split (one
  // per drawn road class for a world whose road texture varies with width).
  console.log(
    `chunk${ci} roads: ${roads.roadCount} features → ${roads.meshes.length} mesh(es) in `
    + `${roadMs.toFixed(0)} ms`,
  );
  roads.meshes.forEach((m, i) => {
    const nm = roads.meshes.length > 1 ? `chunk${ci}/road${i}` : `chunk${ci}/road`;
    if (process.env.ROADAUDIT === 'runs') reportRibbonRuns(nm, m, groundNulls);
    draws.push({ name: nm, cat: 'road', mesh: m });
  });
  // Tunnel portals only exist where the corridor actually has terrain to cut
  // into. Around Dazhi every mouth of Ziqiang Tunnel sits beyond the +/-500 m
  // corridor, so the count here is legitimately 0 — worth printing so a future
  // "portals are broken" report can be checked in one run.
  if (roads.portals.length > 0) {
    console.log(`chunk${ci}: ${roads.portals.length} tunnel portals`);
  }
  for (const portal of roads.portals) {
    portal.updateMatrixWorld(true);
    portal.traverse((o: any) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      draws.push({ name: `chunk${ci}/tunnel-portal`, cat: 'portal', mesh: new THREE.Mesh(g, o.material) as any });
    });
  }
  if (roads.railMesh) draws.push({ name: `chunk${ci}/rail`, cat: 'rail', mesh: roads.railMesh });

  const cosLat = Math.cos((originLat * Math.PI) / 180);
  const keep = (lon: number, lat: number) => {
    if (!owns(lon, lat)) return false;
    const x = (lon - originLon) * 111320 * cosLat;
    const z = -(lat - originLat) * 111320;
    return ground(x, z) !== null;
  };
  // Land-use zoning. NOT a mirror — the index itself lives in `land-zone.ts` and
  // this is the same class the chunk manager uses, so the probe cannot zone
  // differently from the game. (Copying the pipeline is what makes a probe
  // useful; copying its LOGIC is what makes it lie.)
  const zones = new ZoneIndex();
  for (const f of feats) {
    if (f.layer !== 'landuse' || !isUrbanLanduse(f)) continue;
    const zone = zoneFromLanduseClass(f.properties?.class);
    if (!zone) continue;
    for (const ring of extractPolygonCoords(f)) zones.add(ring, zone);
  }
  const fps = extractBuildingsFromMVT(feats, bounds, keep);
  const zoneHist = new Map<string, number>();
  for (const fp of fps) {
    let cx = 0, cy = 0;
    for (const [a, c] of fp.coordinates) { cx += a; cy += c; }
    const z = zones.zoneAt(cx / fp.coordinates.length, cy / fp.coordinates.length) ?? 'none';
    zoneHist.set(z, (zoneHist.get(z) ?? 0) + 1);
  }
  console.log(`chunk${ci} zoning: ${zones.size} polygons; buildings by zone — `
    + [...zoneHist].map(([k, v]) => `${k}:${v}`).join(' '));
  const _tB = performance.now();
  const blds = await buildBuildingMeshes(
    fps, sampler as any, originLat, originLon, originEle, strategy, ground,
    // routeDist stays at its default (Infinity) as it always has here — this
    // probe does not trim buildings off the route. One consequence worth
    // knowing when reading the PNGs: with no route to face, every shop sign
    // falls back to the box's own +z face instead of the one the rider sees.
    undefined,
    (lon: number, lat: number) => zones.zoneAt(lon, lat),
  );
  const buildMs = performance.now() - _tB;
  {
    let decoTris = 0;
    for (const c of blds.mesh.children) {
      const g = (c as import('three').Mesh).geometry;
      if (g?.index) decoTris += g.index.count / 3;
      else if (g?.attributes?.position) decoTris += g.attributes.position.count / 3;
    }
    console.log(`chunk${ci} shop signs: `
      + ((blds.signsByZone ?? []).map(([z, s2, n]) => `${z} ${s2}/${n}`).join(' ') || 'none')
      + `  |  decoration draw calls ${blds.mesh.children.length}, ${decoTris} tris`
      + `  |  ${fps.length} footprints built in ${buildMs.toFixed(0)} ms`);
  }
  draws.push({ name: `chunk${ci}/building`, cat: 'building', mesh: blds.mesh });
  blds.mesh.children.forEach((c, i) => draws.push({ name: `chunk${ci}/deco${i}`, cat: 'building', mesh: c as import('three').Mesh }));

  const lu = await buildLanduseMeshes(
    feats, sampler as any, originLat, originLon, originEle, strategy, owns,
    // The real thing supplies both (terrain-chunk-manager). `ground` is this
    // chunk's own drape; `routePointNear` is the nearest route VERTEX in scene
    // metres, which is what decides which edge of a pitch its lamp stands on.
    {
      ground,
      routePointNear: (x: number, z: number) => {
        let best: { x: number; z: number } | null = null;
        let bd = Infinity;
        for (const p of points as any[]) {
          const px = (p.lon - originLon) * 111320 * cosLat;
          const pz = -(p.lat - originLat) * 111320;
          const d = (px - x) ** 2 + (pz - z) ** 2;
          if (d < bd) { bd = d; best = { x: px, z: pz }; }
        }
        return best;
      },
    },
  );
  for (const l of lu.layers) draws.push({ name: `chunk${ci}/landuse:${l.kind}`, cat: 'landuse', mesh: l.mesh });
  // Lamps hang off their layer's slab mesh, exactly like the standing props do,
  // so the census walks into them through the parent. Printed because they are
  // the draw calls this route pays for the pitch/playground night.
  console.log(`chunk${ci} landuse lamps: ${lu.lamps.length}`
    + `  (patches — ${lu.layers.filter((l) => l.kind === 'sports' || l.kind === 'playground')
      .map((l) => `${l.kind} ${l.count}`).join(' ')})`);

  // Waterways, runways and trees were missing from this probe entirely, which
  // made every category bisect it ran a partial answer.
  const wat = await buildWaterwayMeshes(feats, sampler as any, originLat, originLon, originEle, strategy, ground, owns);
  draws.push({ name: `chunk${ci}/waterway`, cat: 'waterway', mesh: wat.mesh });

  const aero = await buildAerowayMeshes(feats, sampler as any, originLat, originLon, originEle, strategy, ground, owns);
  draws.push({ name: `chunk${ci}/aeroway`, cat: 'aeroway', mesh: aero.mesh });

  // NOTE: buildTreeMeshes takes no `ground` — it places trees on the quantised
  // RAW DEM, not on the built terrain surface. That is exactly the kind of gap
  // this probe exists to expose, so it is built here with the real signature.
  const forest = feats.filter((f: any) => f.layer === 'landcover' || f.layer === 'landuse');
  const trees = await buildTreeMeshes(forest, sampler as any, originLat, originLon, originEle, strategy, owns);
  if (trees.treeCount > 0) draws.push({ name: `chunk${ci}/trees`, cat: 'trees', mesh: trees.mesh as any });

  // Baseplate studs. Mirrors the chunk manager's call exactly (same blockers,
  // same park meshes, same ZoneIndex) — it is the one number the port had to
  // watch, because studs are per-chunk ground furniture and chunk build time is
  // the only cost in this project that has ever held up under measurement.
  const _tS = performance.now();
  const studs = buildGroundStuds(strategy, {
    grid: terrain.heightGrid,
    originLat, originLon, originEle,
    zoneAt: (lon: number, lat: number) => zones.zoneAt(lon, lat),
    blockers: [
      ...roads.meshes, roads.railMesh, wat.mesh, aero.mesh,
      ...lu.layers.filter((l) => STUD_BLOCKING_LANDUSE.has(l.kind)).map((l) => l.mesh),
    ],
    parkMeshes: lu.layers.filter((l) => l.kind === 'park').map((l) => l.mesh),
  });
  const studMs = performance.now() - _tS;
  if (studs) {
    const byColor = studs.meshes.map((m) =>
      `#${((m.material as import('three').MeshToonMaterial).color?.getHexString?.() ?? '??')}×${m.count}`);
    console.log(`chunk${ci} baseplate studs: ${studs.studCount} in ${studs.meshes.length} buckets `
      + `(${byColor.join(' ')}) built in ${studMs.toFixed(0)} ms`);
    studs.meshes.forEach((m, i) =>
      draws.push({ name: `chunk${ci}/studs${i}`, cat: 'studs', mesh: m as any }));
  } else {
    console.log(`chunk${ci} baseplate studs: none (style declares no groundStuds)`);
  }
}

// ── Route line (windowed to chunk 3 ±1, projected with gpsY preference) ──
const routeLine = createRouteLine(points as any, originLat, originLon, originEle, { width: 1920, height: 1080 }, { style: (strategy as any).routeLine, body: (strategy as any).buildRouteBody?.bind(strategy) });
projectRouteLineOntoTerrain(routeLine, (x, z, gpsY) => {
  let best: number | null = null;
  for (const { grid } of grids) {
    const h = sampleChunkHeight(grid, x, z, originEle, gpsY);
    if (h !== null && (best === null || Math.abs(h - gpsY) < Math.abs(best - gpsY))) best = h;
  }
  return best;
});
setRouteLineWindow(routeLine, { startIdx: CHUNKS[2][0], endIdx: CHUNKS[4][1] });
// A route BODY (circuit's dupont chain) is a Group of merged meshes, not two flat
// ribbons, so walk the subtree rather than the direct children.
routeLine.traverse((o) => {
  const m = o as import('three').Mesh;
  if (m.isMesh) draws.push({ name: (m as any).name, cat: 'route', mesh: m });
});

// ── Distant mountain ring + horizon disc ──
// These are anchored to the RIDER, not to the world: the near ring sits at
// ~1700 m and the far one at ~2600 m. The corridor is only 500 m wide, so the
// class comments reason about lateral overlap only — but the route runs for
// 45 km, and loaded chunks stretch kilometres ahead and behind. The ring is
// therefore drawn straight through real terrain. Never rendered by this probe
// before, which is exactly why a whole day of bisects kept missing it.
{
  const ringScene = new THREE.Scene();
  const ring = new MountainRing(ringScene as any, strategy as any, 4177, 500);
  (ring as any).update?.(eyeForRing);
  ringScene.updateMatrixWorld(true);
  ringScene.traverse((o: any) => {
    if (!o.isMesh) return;
    // ⚠ An `InstancedMesh` goes in AS ITSELF.
    //
    // This block used to flatten every ring mesh with
    // `geometry.clone().applyMatrix4(matrixWorld)` into a plain `THREE.Mesh`.
    // For the circuit world's heatsink that is a lie twice over: the 168-fin
    // (near) and 140-fin (far) batches came out as ONE 1 m unit box each — so
    // `CATEGORY=mountain STYLE=circuit` drew the plinth and the disc and no
    // fins at all — and the census counted two `plain` draw calls carrying 2
    // triangles' worth of box instead of two instanced ones carrying 308.
    // Everything downstream already knows how to expand instances (the
    // `isInstancedMesh` pass before the rasteriser, and `mini-raster.ts`'s
    // `collectItems`, which is the same walk); what it never got was an
    // InstancedMesh to expand. Flattening here is what threw it away.
    if (o.isInstancedMesh) {
      draws.push({
        name: `mountainRing/${o.name || 'mesh'}`,
        cat: o.name?.includes('ridgeLine') ? 'mountainInk' : 'mountain',
        mesh: o,
      });
      return;
    }
    // The rasteriser reads raw geometry positions, so bake the world transform
    // in — the ring is POSITIONED on the rider, and drawing it at the origin
    // instead makes it look like a wall in your face (it is not).
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    // The ridge ink line gets its OWN category, and it has to: this rasteriser
    // paints an untinted mesh with its category colour, so a band whose entire
    // reason to exist is being a darker tone than the wash beside it would be
    // drawn in exactly the wash's colour and be invisible in the PNG — the
    // check would pass, the render would look unchanged, and nobody could tell
    // which was true. Same trap as the texture stand-in colours (§10.6).
    draws.push({
      name: `mountainRing/${o.name || 'mesh'}`,
      cat: o.name?.includes('ridgeLine') ? 'mountainInk' : 'mountain',
      mesh: new THREE.Mesh(g, o.material) as any,
    });
  });
}

// ── Rasteriser ──
const W = 1440, H = 810;
const zbuf = new Float32Array(W * H).fill(Infinity);
const img = Buffer.alloc(W * H * 3);
// sky
for (let i = 0; i < W * H; i++) { img[i * 3] = 130; img[i * 3 + 1] = 160; img[i * 3 + 2] = 200; }

// Camera at the user's spot (from click data): eye near (-1070, 6, -2790),
// looking along the route (toward chunk 3's climb).
const eye = eyeForRing;
const target = targetForRing;
const camF = target.clone().sub(eye).normalize();
const camR = new THREE.Vector3().crossVectors(camF, new THREE.Vector3(0, 1, 0)).normalize();
const camU = new THREE.Vector3().crossVectors(camR, camF).normalize();
const FOV = 70 * Math.PI / 180;
const focal = (H / 2) / Math.tan(FOV / 2);

const CAT_COLORS: Record<string, [number, number, number]> = {
  terrain: [60, 160, 60], road: [40, 40, 40], rail: [140, 130, 115],
  mountain: [230, 60, 230], mountainInk: [90, 0, 110], portal: [255, 140, 0],
  building: [200, 90, 120], landuse: [90, 190, 90], route: [230, 40, 140],
  waterway: [60, 130, 220], aeroway: [200, 200, 210], trees: [20, 90, 40],
  // Baseplate studs deliberately read as a LIGHTER green than the terrain they
  // stand on, not as a contrast colour: the question this probe is asked about
  // them is "do they cover the ground evenly and stop at the roads", and a
  // magenta answer to that is unreadable at a glance.
  studs: [150, 235, 150],
};

// Per-category vertex budget — the number that decides whether a downtown
// chunk fits on the N100, and the one a geometry change (matchbox bodies,
// bevels, stud grids) moves without ever showing up in a screenshot.
{
  const byCat = new Map<string, number>();
  for (const d of draws) {
    const c = d.mesh.geometry?.getAttribute?.('position')?.count ?? 0;
    byCat.set(d.cat, (byCat.get(d.cat) ?? 0) + c);
  }
  console.log('verts by category:', [...byCat].map(([k, v]) => `${k}=${v}`).join(' '));
}

// ROADAUDIT=1: road vertices vs the TERRAIN GRID they are supposed to lie on.
// Auditing against the DEM answers a different question — the DEM is not what
// is on screen. The rendered ground is the quantised terrain mesh, and the grid
// is its exact per-cell top. A road floating above THAT is a road you can see
// hanging in the air.
// LOOKUP=1: does the height grid agree with the MESH that is drawn?
//
// Everything drapes on `sampleChunkHeight` — roads, the route line, lamps,
// coins, and the rider's own altitude. It finds a cell by projecting onto the
// segment between two section CENTRES (~25 m apart) and accepting any cross
// offset out to the corridor half-width (500 m). Where the route curves, more
// than one section passes that test for the same point and each hands back a
// different cell, possibly hundreds of metres away along the route.
//
// The rendered mesh is the ground truth: raycast straight down onto it and
// compare. Any disagreement here IS the "buried road / rider inside the hill"
// family, at its source.
if (process.env.LOOKUP) {
  const chunkKeys = Object.keys(CHUNKS);
  const ray = new THREE.Raycaster();
  ray.near = 0;
  ray.far = 6000;
  const down = new THREE.Vector3(0, -1, 0);
  for (let gi = 0; gi < grids.length; gi++) {
    const grid: any = grids[gi].grid;
    const mesh = terrains[gi].mesh;
    mesh.updateMatrixWorld(true);
    let checked = 0, agree = 0, worstErr = 0, worstAt = '';
    const step = 30;
    for (let x = grid.minX; x < grid.maxX; x += step) {
      for (let z = grid.minZ; z < grid.maxZ; z += step) {
        const got = process.env.LOOKUP === 'max'
          ? maxChunkHeight(grid, x, z, originEle)
          : sampleChunkHeight(grid, x, z, originEle);
        if (got === null) continue;
        ray.set(new THREE.Vector3(x, 3000, z), down);
        const hits = ray.intersectObject(mesh, false);
        if (hits.length === 0) continue;
        // Highest hit = the surface you actually see from above.
        const truth = hits[0].point.y;
        checked++;
        const err = Math.abs(got - truth);
        if (err < 1) agree++;
        else if (err > worstErr) {
          worstErr = err;
          worstAt = `(${x.toFixed(0)},${z.toFixed(0)}) grid=${got.toFixed(0)} mesh=${truth.toFixed(0)}`;
        }
      }
    }
    console.log(`chunk${chunkKeys[gi]} lookup vs mesh: ${agree}/${checked} agree within 1m (${(100 * agree / checked).toFixed(1)}%); worst ${worstErr.toFixed(0)}m ${worstAt}`);
  }
}

// (The old OVERLAP=1 metric compared sampleChunkHeight against maxChunkHeight.
// Both now resolve through the same exact cell-quad lookup, so it can only ever
// report 0% — a tautology, not a result. LOOKUP=1 above replaces it: it checks
// the height grid against the mesh that is actually drawn, which is the
// invariant that matters and the one that was broken.)

if (process.env.ROADAUDIT) {
  const chunkKeys = Object.keys(CHUNKS);
  const bad: { chunk: string; d: number; y: number; g: number; lat: number; lon: number }[] = [];
  let total = 0, offGrid = 0;
  for (const d of draws) {
    if (d.cat !== 'road') continue;
    const ci = d.name.match(/chunk(\d+)/)![1];
    const grid = grids[chunkKeys.indexOf(ci)].grid;
    const pos = d.mesh.geometry.getAttribute('position');
    // Vertices come in pairs: the two EDGES of one centreline sample. Probing
    // the midpoint tells us whether a burial is a draping error or simply the
    // ribbon being flat across its width on sloping ground.
    const edgeMode = process.env.ROADAUDIT === 'edge';
    for (let i = 0; i < pos.count; i += edgeMode ? 1 : 2) {
      const x = edgeMode ? pos.getX(i) : (pos.getX(i) + pos.getX(i + 1)) / 2;
      const y = edgeMode ? pos.getY(i) : (pos.getY(i) + pos.getY(i + 1)) / 2;
      const z = edgeMode ? pos.getZ(i) : (pos.getZ(i) + pos.getZ(i + 1)) / 2;
      total++;
      // The number that decides whether you can SEE a problem: how far the
      // road sits below the HIGHEST terrain layer over that (x, z). A corridor
      // that folds over itself covers one point twice; the surface you look at
      // is the top one, so anything under it is inside the hill and will
      // surface through the quantised steps. (preferY = +inf picks the highest
      // layer — sampleChunkHeight returns whichever is closest to it.)
      const g = maxChunkHeight(grid, x, z, originEle);
      if (g === null) { offGrid++; continue; }
      const diff = y - g;
      if (Math.abs(diff) > 1.5) {
        bad.push({
          chunk: d.name, d: diff, y, g,
          lat: originLat - z / 111320,
          lon: originLon + x / (111320 * cosO),
        });
      }
    }
  }
  const buckets: Record<string, number> = {};
  for (const b of bad) {
    const a = Math.abs(b.d);
    const k = a < 3 ? '1.5-3m' : a < 6 ? '3-6m' : a < 12 ? '6-12m' : a < 30 ? '12-30m' : '>30m';
    buckets[`${b.d < 0 ? 'below' : 'ABOVE'} ${k}`] = (buckets[`${b.d < 0 ? 'below' : 'ABOVE'} ${k}`] ?? 0) + 1;
  }
  console.log('  distribution:', JSON.stringify(buckets));
  bad.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  console.log(`\nroad verts ${total}; off the terrain GRID by >1.5m: ${bad.length}; outside any grid: ${offGrid}`);
  for (const b of bad.slice(0, 15)) {
    console.log(`  ${b.chunk} Δ=${b.d.toFixed(1)}m (road y=${b.y.toFixed(1)} grid=${b.g.toFixed(1)}) @ ${b.lat.toFixed(5)},${b.lon.toFixed(5)}`);
  }
}

// AUDIT=1: for every mesh, how far its vertices stray from the TRUE ground.
// Viewpoint-independent — the "what is floating?" question, answered without
// having to guess where the rider was standing.
if (process.env.AUDIT) {
  const rows: { name: string; cat: string; worst: number; y: number; dem: number; at: string; n: number }[] = [];
  for (const d of draws) {
    const pos = d.mesh.geometry?.getAttribute?.('position');
    if (!pos || pos.count === 0) continue;
    let worst = 0, wy = 0, wdem = 0, wat = '', off = 0;
    const step = Math.max(1, Math.floor(pos.count / 4000)); // sample big meshes
    for (let i = 0; i < pos.count; i += step) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const lon = originLon + x / (111320 * cosO);
      const lat = originLat - z / 111320;
      const dem = sampler.getElevationSync(lat, lon);
      if (dem === null) continue;
      const diff = y - (dem - originEle);
      if (Math.abs(diff) > 12) off++;
      if (Math.abs(diff) > Math.abs(worst)) {
        worst = diff; wy = y; wdem = dem - originEle;
        wat = `${lat.toFixed(5)},${lon.toFixed(5)}`;
      }
    }
    rows.push({ name: d.name, cat: d.cat, worst, y: wy, dem: wdem, at: wat, n: off });
  }
  rows.sort((a, b) => Math.abs(b.worst) - Math.abs(a.worst));
  console.log('\n── furthest-from-ground vertex per mesh (buildings legitimately rise) ──');
  for (const r of rows.slice(0, 20)) {
    console.log(
      `  ${r.name.padEnd(26)} ${r.cat.padEnd(9)} worst Δ=${r.worst.toFixed(1)}m ` +
      `(y=${r.y.toFixed(1)} dem=${r.dem.toFixed(1)}) offGround=${r.n} @ ${r.at}`,
    );
  }
}

const want = (process.env.CATEGORY ?? 'all');
const wantSet = new Set(want.split(','));
// `CATEGORY=mountain` means the whole ring — the ridge ink line is a separate
// category only so the PNG can tell the two tones apart, not so a bisect can
// leave half the horizon on screen while claiming it turned the horizon off.
let active = draws.filter((d) => want === 'all' || wantSet.has(d.cat)
  || (d.cat === 'mountainInk' && wantSet.has('mountain')));

// Expand InstancedMesh into one draw per instance.
//
// This rasteriser walks `mesh.geometry` directly, so an InstancedMesh used to
// draw as ONE copy of its source geometry at the origin — a 1 m cube where a
// city block should be. Trees had this for a while; the instanced building
// bodies made it load-bearing, because after that change most of the toy world
// simply was not in this PNG. A probe that silently omits the thing you are
// looking at is worse than no probe.
{
  const expanded: typeof active = [];
  const im = new THREE.Matrix4();
  for (const d of active) {
    const inst = d.mesh as unknown as import('three').InstancedMesh;
    if (!inst.isInstancedMesh) { expanded.push(d); continue; }
    inst.updateMatrixWorld(true);
    for (let i = 0; i < inst.count; i++) {
      inst.getMatrixAt(i, im);
      const g = inst.geometry.clone();
      g.applyMatrix4(im);
      g.applyMatrix4(inst.matrixWorld);
      const m = new THREE.Mesh(g, inst.material as import('three').Material);
      m.name = d.mesh.name;
      expanded.push({ ...d, mesh: m as never });
    }
  }
  active = expanded;
}
console.log('drawing categories:', want, '| meshes:', active.length);

let triTotal = 0;
for (const d of active) {
  const g = d.mesh.geometry as import('three').BufferGeometry;
  const pos = g?.getAttribute?.('position');
  if (!pos || pos.count === 0) continue;
  const col = g.getAttribute('color');
  const idx = g.index;
  const drawStart = g.drawRange.start;
  const drawCount = Math.min(g.drawRange.count, (idx ? idx.count : pos.count) - drawStart);
  const triCount = Math.floor(drawCount / 3);
  const base = CAT_COLORS[d.cat] ?? [255, 0, 255];
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const pr = (v: import('three').Vector3): [number, number, number] | null => {
    const rel = v.clone().sub(eye);
    const zc = rel.dot(camF);
    if (zc < 0.3) return null;
    const xc = rel.dot(camR), yc = rel.dot(camU);
    return [W / 2 + (xc / zc) * focal, H / 2 - (yc / zc) * focal, zc];
  };
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx.array[drawStart + t * 3] : drawStart + t * 3;
    const i1 = idx ? idx.array[drawStart + t * 3 + 1] : drawStart + t * 3 + 1;
    const i2 = idx ? idx.array[drawStart + t * 3 + 2] : drawStart + t * 3 + 2;
    va.fromBufferAttribute(pos as any, i0);
    vb.fromBufferAttribute(pos as any, i1);
    vc.fromBufferAttribute(pos as any, i2);
    const pa = pr(va), pb = pr(vb), pc = pr(vc);
    if (!pa || !pb || !pc) continue;
    triTotal++;
    // colour: vertex colour if present, else category
    let r = base[0], gg = base[1], b = base[2];
    if (col) {
      r = Math.round(((col.getX(i0) + col.getX(i1) + col.getX(i2)) / 3) * 255);
      gg = Math.round(((col.getY(i0) + col.getY(i1) + col.getY(i2)) / 3) * 255);
      b = Math.round(((col.getZ(i0) + col.getZ(i1) + col.getZ(i2)) / 3) * 255);
    }
    // bbox scan rasterise
    const minX = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0])));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
    const minY = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1])));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));
    if (maxX < minX || maxY < minY) continue;
    const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
    if (Math.abs(area) < 1e-9) continue;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const w0 = ((pb[0] - px) * (pc[1] - py) - (pb[1] - py) * (pc[0] - px)) / area;
        const w1 = ((pc[0] - px) * (pa[1] - py) - (pc[1] - py) * (pa[0] - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const depth = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
        const o = py * W + px;
        if (depth < zbuf[o]) {
          zbuf[o] = depth;
          img[o * 3] = r; img[o * 3 + 1] = gg; img[o * 3 + 2] = b;
        }
      }
    }
  }
}
console.log('triangles drawn:', triTotal);

// PNG out
function chunkPng(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
const scan = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y++) {
  scan[y * (W * 3 + 1)] = 0;
  img.copy(scan, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
// OUT_DIR, not a hard-coded path: this line used to point at one particular
// session's scratch directory, so every later run wrote its PNG somewhere
// nobody was looking.
const outName = `${process.env.OUT_DIR ?? '/tmp'}/render-${want.replace(/[^a-z,]/g, '')}.png`;
writeFileSync(outName, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunkPng('IHDR', ihdr), chunkPng('IDAT', deflateSync(scan)), chunkPng('IEND', Buffer.alloc(0)),
]));
console.log('wrote', outName);

// ── Scene census (CENSUS=1) ──────────────────────────────────────────────────
// Same counter the demos use (`scene-census.mjs`), so "the demo does 259 draw
// calls and the real game does N" is a sentence worth saying. Without a shared
// definition it would not be: "draw call" has several defensible meanings and
// two probes that each picked one produce a confident, wrong comparison.
//
// `draws` holds parents AND their children (the probe rasterises them
// separately), so census only the ROOTS — otherwise every building chunk's
// decorations are counted twice.
if (process.env.CENSUS) {
  // Carry the probe's own labels onto the meshes so the "heaviest draw calls"
  // table names what it found instead of printing `BufferGeometry` ten times.
  for (const d of draws) {
    const m = d.mesh as unknown as import('three').Object3D;
    if (m && !m.name) m.name = d.name;
  }
  const all = new Set(draws.map((d) => d.mesh as unknown as import('three').Object3D));
  const roots: import('three').Object3D[] = [];
  for (const o of all) {
    let anc = o.parent;
    let nested = false;
    while (anc) { if (all.has(anc)) { nested = true; break; } anc = anc.parent; }
    if (!nested) roots.push(o);
  }
  const walker = { traverse: (fn: (o: import('three').Object3D) => void) => {
    for (const r of roots) r.traverse(fn);
  } };
  console.log('\n' + formatCensus(census(walker, `real route (${want})`)));
}
