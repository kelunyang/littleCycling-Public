/**
 * Headless preview of the strategy's PROPS — no WebGL, no browser.
 *
 * `npm run check:3d` can prove a prop was built, has the right proportions and
 * the right material ownership. It cannot tell you whether the word is
 * READABLE, or whether the lamp looks like a lamp — which is the only thing
 * either is for. Props fail silently: a glyph with a stroke in the wrong place
 * still builds, still measures right, and still looks like nothing.
 *
 *   PROP=lamp STYLE=paper node --no-warnings \
 *     --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/prop-preview.ts
 *
 * Env: PROP=sign|lamp, STYLE=plastic|paper, WORDS=CAFE,DELI, NIGHT=1, OUT_DIR=…
 *
 * Caveat that matters here: this rasteriser does NOT shade `emissive` and does
 * not blend transparency the way WebGL will. It answers "is the FORM right".
 * Whether a lamp reads as LIT is a browser question — see §10 of
 * CUSTOM_WORLD_INSTRUCTIONS.
 */

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
      get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : () => {}),
      set: () => true,
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

import { collectItems, rasterise, writePng, type RasterItem } from './mini-raster';

const THREE = await import('three');
const { createTerrainStyleStrategy } = await import('@/game/terrain/terrain-style-strategy');
const { SIGN_ALPHABET } = await import('@/game/terrain/sign-spec');

// `circuit` is here because the third world has street lamps too, and the LED's
// lead frame (the asymmetric anvil/post silhouette seen through the lens) is
// exactly the kind of thing that builds, measures right, and looks like nothing.
const STYLE = (process.env.STYLE ?? 'paper') as 'plastic' | 'paper' | 'circuit';
const PROP = process.env.PROP ?? 'sign';
const NIGHT = process.env.NIGHT === '1' ? 1 : 0;
const OUT = process.env.OUT_DIR ?? '/tmp';
const strategy = await createTerrainStyleStrategy(STYLE);

const root = new THREE.Group();
const disposers: (() => void)[] = [];
let label = '';

/**
 * The props that ride with the player. `check:3d` / `props-vs-demo.ts` can
 * prove the coin is the demo's poker chip triangle for triangle; only a picture
 * says whether the knurl edge and the inset ring READ as one at coin size.
 */
const RIDE_PROPS: Record<string, () => void> = {
  coin: () => {
    // Four, turned through a quarter of the spin each: the whole point of a
    // chip over a plain disc is that its features take turns.
    for (let i = 0; i < 4; i++) {
      const coin = strategy.buildCoinMesh();
      coin.position.x = (i - 1.5) * 5;
      coin.rotation.y = (i / 4) * Math.PI;
      root.add(coin);
      disposers.push(() => coin.traverse((o) => {
        const m = o as import('three').Mesh;
        if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
      }));
    }
    label = '4 coins, quarter-turn apart';
  },
  checkpoint: () => {
    const WORDS = ['GO', 'MID', 'END'];
    const COLS = [0xff3b8d, 0x00d8ff, 0xffea00];
    for (let i = 0; i < 3; i++) {
      const cp = strategy.buildCheckpoint(COLS[i], i, WORDS[i]);
      cp.position.x = (i - 1) * 16;
      // `CheckpointFlagManager` yaws the group onto the route tangent, so local
      // +Z is the direction of travel and the rider comes from −Z. Stand the
      // route on end here (route running away from the camera) — otherwise the
      // preview shows the BACK of every plate and looks like a bug.
      cp.rotation.y = Math.PI;
      root.add(cp);
    }
    label = '3 checkpoints (GO / MID / END)';
  },
  bike: () => {
    const parts = strategy.buildBikeOrnament();
    root.add(parts.root);
    disposers.push(parts.dispose);
    label = 'bike ornament';
  },
  tree: () => {
    if (!strategy.buildTreeGeometry) { label = 'no buildTreeGeometry'; return; }
    const mat = strategy.createTreeMaterial();
    for (let i = 0; i < 3; i++) {
      const geo = strategy.buildTreeGeometry!();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.x = (i - 1) * 11;
      mesh.rotation.y = (i / 3) * Math.PI;
      mesh.scale.setScalar(0.7 + i * 0.35);
      root.add(mesh);
      disposers.push(() => geo.dispose());
    }
    disposers.push(() => mat.dispose());
    label = '3 trees, 0.7 / 1.05 / 1.4×';
  },
};

if (RIDE_PROPS[PROP]) {
  RIDE_PROPS[PROP]();
} else if (PROP === 'lamp') {
  // One of each ink the world cycles, side by side — a colour that only works
  // for the first lamp on the street is not a working lamp.
  const N = 4;
  for (let i = 0; i < N; i++) {
    const lamp = strategy.buildStreetLamp(i);
    lamp.setNight(NIGHT);
    lamp.group.position.x = (i - (N - 1) / 2) * 9;
    root.add(lamp.group);
    disposers.push(lamp.dispose);
  }
  label = `${N} lamps, night=${NIGHT}`;
} else {
  if (!strategy.buildSign) {
    console.log(`style ${STYLE} has no buildSign — nothing to preview`);
    process.exit(0);
  }
  const WORDS = (process.env.WORDS ?? 'CAFE,DELI,ABC,SHOP,O0,1I,5S,2Z,8B,QGJW')
    .split(',').map((w) => w.trim()).filter(Boolean);
  const COLS = 5, GAP_X = 11, GAP_Y = 6;
  for (let i = 0; i < WORDS.length; i++) {
    const sign = strategy.buildSign('shop', WORDS[i], 9, { zone: 'commercial', seed: i });
    if (!sign) { console.log(`  (no sign for "${WORDS[i]}")`); continue; }
    sign.group.position.set(
      (i % COLS) * GAP_X - ((COLS - 1) * GAP_X) / 2,
      -Math.floor(i / COLS) * GAP_Y,
      0,
    );
    root.add(sign.group);
    disposers.push(sign.dispose);
  }
  label = `${WORDS.length} signs`;
}
console.log(`${STYLE} / ${PROP}: ${label}`);

const items: RasterItem[] = collectItems(THREE, root);
const bb = new THREE.Box3().setFromObject(root);
const c = bb.getCenter(new THREE.Vector3());
const size = bb.getSize(new THREE.Vector3());
const dist = Math.max(size.x, size.y) * 1.5 + 8;

for (const [tag, eye] of [
  ['', new THREE.Vector3(c.x, c.y, c.z + dist)],
  ['-ride', new THREE.Vector3(c.x - dist * 0.5, c.y + size.y * 0.25, c.z + dist * 0.75)],
] as const) {
  const out = `${OUT}/prop-${STYLE}-${PROP}${NIGHT ? '-night' : ''}${tag}.png`;
  writePng(out, rasterise(items, {
    THREE, width: 1100, height: 620, eye, target: c, fovDeg: 46,
    background: [232, 228, 214], light: new THREE.Vector3(-0.3, 0.6, 1),
  }));
  console.log('wrote', out);
}

for (const d of disposers) d();
