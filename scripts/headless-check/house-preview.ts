/**
 * Headless preview of the MATCHBOX HOUSES — no WebGL, no browser.
 *
 * Runs `buildBuildingMeshes` over a handful of synthetic footprints on flat
 * ground for one world style and rasterises the result with a tiny z-buffered
 * renderer that does real Lambert shading, so the block's silhouette, chamfer
 * and trim are all actually visible (the terrain render-probe's flat fill is
 * fine for "is it floating", useless for "does it look like an eraser").
 *
 *   STYLE=plastic node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/house-preview.ts
 */

import { collectItems, rasterise, writePng } from './mini-raster';

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
const { buildBuildingMeshes } = await import('@/game/terrain/building-renderer');

const STYLE = (process.env.STYLE ?? 'plastic') as 'plastic' | 'paper';
const strategy = await createTerrainStyleStrategy(STYLE);

// ── Synthetic block of houses on flat ground ──
const originLat = 25.06, originLon = 121.57, originEle = 0;
const cosO = Math.cos((originLat * Math.PI) / 180);
const toLon = (x: number) => originLon + x / (111320 * cosO);
const toLat = (z: number) => originLat - z / 111320;

/** Axis-aligned rectangle footprint, optionally rotated, centred at (x, z). */
function rect(x: number, z: number, w: number, d: number, rot: number): [number, number][] {
  const c = Math.cos(rot), s = Math.sin(rot);
  const out: [number, number][] = [];
  for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const lx = (su * w) / 2, lz = (sv * d) / 2;
    out.push([toLon(x + lx * c + lz * s), toLat(z - lx * s + lz * c)]);
  }
  out.push(out[0]);
  return out;
}

const footprints = [
  { coordinates: rect(-28, 0, 16, 12, 0.0), height: 7 },
  { coordinates: rect(-6, 4, 12, 14, 0.5), height: 12 },
  { coordinates: rect(14, -2, 18, 13, -0.25), height: 26 },
  { coordinates: rect(36, 6, 11, 11, 0.8), height: 5 },
  { coordinates: rect(2, -26, 22, 15, 0.15), height: 17 },
  { coordinates: rect(-34, -22, 9, 20, -0.6), height: 9 },
];

const sampler = {
  getElevationSync: () => 0,
  async getElevation() { return 0; },
  async prefetchBounds() {},
} as any;

// Zone each building by position so one shot shows all five districts and,
// with them, whether the sign pipeline actually reaches the facade. ZONES=0
// turns zoning off to compare against the unzoned look.
const ZONE_ORDER = ['commercial', 'school', 'hospital', 'residential', 'industrial', 'commercial'] as const;
const zoneAt = process.env.ZONES === '0' ? undefined : (lon: number, lat: number) => {
  // Nearest footprint centre wins — the synthetic block has no real polygons.
  let bestI = 0, bestD = Infinity;
  for (let i = 0; i < footprints.length; i++) {
    const ring = footprints[i].coordinates;
    let cx = 0, cy = 0;
    for (const [a, b] of ring) { cx += a; cy += b; }
    cx /= ring.length; cy /= ring.length;
    const d = (cx - lon) ** 2 + (cy - lat) ** 2;
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return ZONE_ORDER[bestI % ZONE_ORDER.length];
};

const result = await buildBuildingMeshes(
  footprints, sampler, originLat, originLon, originEle, strategy, () => 0,
  // routeDist: pretend the road runs along z = +40, so every sign should end up
  // on the +z face. A sign that lands on the far side is a placement bug.
  (_x: number, z: number) => Math.abs(40 - z),
  zoneAt,
);
console.log('buildings:', result.buildingCount, 'children:', result.mesh.children.length);

// ── Collect, rasterise, write ──
// Rasteriser lives in mini-raster.ts so every headless preview draws the same
// way; see the note there about why one shared copy matters.
const items = collectItems(THREE, result.mesh);
console.log('draw items:', items.length);

// Ground plane so the houses have something to stand on.
items.unshift({
  geo: new THREE.PlaneGeometry(300, 300).rotateX(-Math.PI / 2),
  color: new THREE.Color(0x6ea85a),
});

const res = rasterise(items, {
  THREE,
  eye: new THREE.Vector3(-52, 26, 58),
  target: new THREE.Vector3(2, 6, -6),
});
console.log('triangles drawn:', res.triangles);

const out = `${process.env.OUT_DIR ?? '/tmp'}/houses-${STYLE}.png`;
writePng(out, res);
console.log('wrote', out);
