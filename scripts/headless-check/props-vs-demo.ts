/**
 * `[props vs demo]` — the eight strategy hooks that had never been diffed
 * against a demo: the coin, the checkpoint, the bike, the tree, the water
 * material, and the three that turn out to have NO demo counterpart at all
 * (tunnel portal / plane ornament / finish airship).
 *
 * Same discipline as `[zone bodies vs demo]` in `diorama.ts` and
 * `circuit-3d-vs-demo.ts`: the demo's OWN builders are sliced out of
 * `plan/*-town-demo.html` with every helper they call, EXECUTED against the
 * real `three`, and diffed part for part. Nothing here is compared against a
 * constant transcribed into this file — a transcription only re-confirms
 * whatever was typed the first time.
 *
 * Two techniques this file leans on:
 *
 *  - **World-space triangles in order.** Every part's index buffer is expanded
 *    through its world matrix and its normals through the normal matrix, then
 *    the two streams are compared position by position. That sees a REVERSED
 *    WINDING and a re-ordered hierarchy, neither of which a bounding box or a
 *    rasteriser can see. It is also what makes "the port bakes the rotation
 *    into the geometry, the demo puts it on the object" a non-difference
 *    instead of a false alarm.
 *  - **Bucket by (colour, template).** The merged, vertex-coloured geometries
 *    (the circuit tree) are compared per colour, because one colour is one
 *    part of the demo's hierarchy.
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/props-vs-demo.ts
 *
 * Folding into `diorama.ts` — one line, next to the other `vs demo` blocks:
 *
 *   await block('props vs demo', async () => {
 *     failures += ((await import('./props-vs-demo.ts')) as
 *       { failureCount(): number }).failureCount();
 *   });
 */
import { readFileSync } from 'node:fs';

// canvas stub 走 harness 共用的那一份(`recording-canvas.ts`)。這支自己不看筆觸,
// 但它**不能**把別人的畫布換掉:貼圖快取是模組層的,換掉之後先前錄的東西就沒了,
// 而快取住的貼圖不會重畫。冪等由 installRecordingCanvas 自己保證。
const { installRecordingCanvas } = await import('./recording-canvas.ts');
installRecordingCanvas();

const THREE = await import('three');
const { createTerrainStyleStrategy } = await import('@/game/terrain/terrain-style-strategy');
const { disposeLanduseMeshes, buildLanduseMeshes } = await import('@/game/terrain/landuse-renderer');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ── Slicing the demo ────────────────────────────────────────────────────────

const SRC: Record<string, string> = {
  paper: readFileSync('plan/paper-town-demo.html', 'utf8'),
  plastic: readFileSync('plan/plastic-town-demo.html', 'utf8'),
  circuit: readFileSync('plan/circuit-town-demo.html', 'utf8'),
};

/** A whole `function name(...) { … }`, braces balanced. */
function sliceFn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`cannot slice function ${name}`);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
/** One physical line starting with `head`. */
function sliceLine(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`cannot slice line ${head}`);
  return src.slice(at, src.indexOf('\n', at));
}
/** A brace/paren-balanced statement starting at `head` (a `const x = (() => {…})();`
 *  or a multi-line `const x = { … };`). Stops on the balance point. */
function sliceStmt(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`cannot slice statement ${head}`);
  let depth = 0, started = false;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') { depth++; started = true; }
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (started && depth === 0) {
        const semi = src.indexOf(';', i);
        return src.slice(at, semi + 1);
      }
    } else if (c === ';' && (!started || depth === 0)) return src.slice(at, i + 1);
  }
  throw new Error(`unbalanced statement ${head}`);
}
/** Everything between two literal markers, markers included. */
function sliceBlock(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`cannot slice block from ${from}`);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`cannot slice block to ${to}`);
  return src.slice(a, b + to.length);
}

/**
 * Run demo source with the REAL three.
 *
 * Materials are the one thing stubbed to plain strings (`MAT_TOKENS`): a
 * material's identity is what we want to compare, and comparing "which of the
 * demo's named materials is on this part" is stricter than comparing colours —
 * two materials can share a colour and differ in class, which is exactly the
 * LED-die failure.
 */
function runDemo(world: string, prelude: string[], tail: string): Record<string, never> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('THREE', [...prelude, tail].join('\n'))(THREE) as Record<string, never>;
}
const matTokens = (...names: string[]): string[] =>
  names.map((m) => `const ${m} = '${m}';`);

// ── Part extraction ─────────────────────────────────────────────────────────

type Part = {
  geo: THREE.BufferGeometry;
  m: THREE.Matrix4;
  mat: unknown;
  name: string;
};

/** Depth-first in child order, InstancedMesh expanded instance by instance. */
function partsOf(root: THREE.Object3D): Part[] {
  const out: Part[] = [];
  root.updateMatrixWorld(true);
  const walk = (o: THREE.Object3D): void => {
    const mesh = o as THREE.Mesh;
    const inst = o as unknown as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      for (let i = 0; i < inst.count; i++) {
        const m = new THREE.Matrix4();
        inst.getMatrixAt(i, m);
        out.push({
          geo: mesh.geometry, m: m.premultiply(o.matrixWorld),
          mat: mesh.material, name: `${o.name || 'inst'}#${i}`,
        });
      }
    } else if (mesh.isMesh) {
      out.push({ geo: mesh.geometry, m: o.matrixWorld.clone(), mat: mesh.material, name: o.name });
    }
    for (const c of o.children) walk(c);
  };
  walk(root);
  return out;
}

/**
 * Every triangle of a part, in index order, in world space, carrying BOTH
 * normals it has:
 *
 *  - the GEOMETRIC normal, straight off the world-space corners. Flip a
 *    triangle's winding and the three corners still occupy the same three
 *    points — a bounding box sees nothing, and a CPU rasteriser filling both
 *    faces sees nothing — but this flips sign.
 *  - the SHADING normal (the `normal` attribute) through the normal matrix,
 *    averaged over the three corners. The pipe-cleaner tree writes its normals
 *    by hand precisely because `computeVertexNormals()` is wrong for a thin
 *    ribbon, so a port that quietly let three compute them would keep every
 *    vertex in place and shade half the tree dark.
 */
function worldTris(p: Part): string[] {
  const geo = p.geo;
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const idx = geo.index;
  const n = idx ? idx.count : pos.count;
  const nm = new THREE.Matrix3().getNormalMatrix(p.m);
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const fn = new THREE.Vector3(), sn = new THREE.Vector3(), tmp = new THREE.Vector3();
  const out: string[] = [];
  const f = (x: number): string => (Math.abs(x) < 5e-4 ? '0' : x.toFixed(3));
  for (let i = 0; i < n; i += 3) {
    sn.set(0, 0, 0);
    for (let k = 0; k < 3; k++) {
      const j = idx ? idx.getX(i + k) : i + k;
      v[k].set(pos.getX(j), pos.getY(j), pos.getZ(j)).applyMatrix4(p.m);
      if (nrm) {
        sn.add(tmp.set(nrm.getX(j), nrm.getY(j), nrm.getZ(j)).applyMatrix3(nm).normalize());
      }
    }
    e1.subVectors(v[1], v[0]);
    e2.subVectors(v[2], v[0]);
    fn.crossVectors(e1, e2);
    if (fn.lengthSq() > 1e-18) fn.normalize();
    if (sn.lengthSq() > 1e-18) sn.normalize();
    out.push(
      `${v.map((q) => `${f(q.x)},${f(q.y)},${f(q.z)}`).join(' ')} `
      + `g${f(fn.x)},${f(fn.y)},${f(fn.z)} `
      + `s${f(sn.x)},${f(sn.y)},${f(sn.z)}`);
  }
  return out;
}

/** Ordered world-triangle stream over a whole prop. */
function triStream(parts: Part[]): string[] {
  const out: string[] = [];
  for (const p of parts) out.push(...worldTris(p));
  return out;
}

/** First place two streams differ, for the failure detail. */
function firstDiff(a: string[], b: string[]): string {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return `tri ${i}: demo [${a[i] ?? '—'}] vs ours [${b[i] ?? '—'}]`;
  }
  return 'identical';
}

const triCount = (g: THREE.BufferGeometry): number =>
  (g.index ? g.index.count : g.attributes.position.count) / 3;

type MatFacts = {
  cls: string; color: number; emissive: number; specular: number;
  shininess: number; opacity: number; transparent: boolean; side: number;
};
function matFacts(m: unknown): MatFacts {
  const x = m as THREE.MeshPhongMaterial & { gradientMap?: unknown };
  return {
    cls: x.constructor.name,
    color: x.color ? x.color.getHex() : -1,
    emissive: x.emissive ? x.emissive.getHex() : -1,
    specular: x.specular ? x.specular.getHex() : -1,
    shininess: x.shininess ?? -1,
    opacity: x.opacity,
    transparent: x.transparent,
    side: x.side,
  };
}
const matKey = (m: unknown): string => JSON.stringify(matFacts(m));

// ═══════════════════════════════════════════════════════════════════════════
// 1. 金幣 — the coin, all three worlds
// ═══════════════════════════════════════════════════════════════════════════
//
// The coin is on screen for the whole ride and it is pooled per-coin (up to 200
// live meshes), so both its SHAPE and its part count matter. All three demos
// have one; all three are different objects (drawing pin / poker chip / CR2032).
//
// The demos animate the coin as an InstancedMesh whose matrix is rewritten each
// frame; the port hands `CoinPool` one Mesh and `useTerrainRenderer` spins it.
// Comparable at t = 0, seed 0: the demo's own hover is `3.4 + sin(0)·0.45` and
// its spin `0·1.8 + 0`, so the port's coin lifted to y = 3.4 with rotation.y = 0
// is the same pose — and the world-triangle stream then compares the two builds
// through DIFFERENT composition orders (demo: object rotation; port: baked into
// the geometry) without either being privileged.

console.log('\n[coin vs demo — 三個世界]');

/** The demo coin at t = 0, seed 0, as world-space parts. */
function demoCoinParts(world: string): Part[] {
  const src = SRC[world];
  if (world === 'paper') {
    const d = runDemo(world, [
      ...matTokens('coinMat', 'pinMetalMat'),
      'const geoCache = new Map(); const SHARED_GEO = new Set();',
      sliceFn(src, 'shared'),
      sliceLine(src, '  const unitCyl = '),
      sliceLine(src, '  const unitCone = '),
      sliceStmt(src, '  const local = ('),
      sliceLine(src, '  const COIN_HEAD_LOCAL = '),
      sliceLine(src, '  const COIN_PIN_LOCAL = '),
      sliceFn(src, 'coinBatch'),
    ], `
      const coinRoot = new THREE.Object3D();
      const coinM = new THREE.Matrix4();
      const group = new THREE.Group();
      const list = [{ x: 0, z: 0, seed: 0 }];
      const { heads, pins } = coinBatch(list, group, []);
      const t = 0;
      ${sliceBlock(src, '      for (let i = 0; i < list.length; i++) {',
      'pins.setMatrixAt(i, coinM.multiplyMatrices(coinRoot.matrix, COIN_PIN_LOCAL));\n      }')}
      return { group };
    `) as unknown as { group: THREE.Group };
    return partsOf(d.group);
  }
  if (world === 'plastic') {
    const d = runDemo(world, [
      ...matTokens('coinMat', 'chipInnerMat'),
      sliceLine(src, '  const chipBaseGeo = '),
      sliceLine(src, '  const chipEdgeGeo = '),
      sliceLine(src, '  const COIN_BODY_S = '),
      sliceLine(src, '  const COIN_INNER_S = '),
      sliceBlock(src, '  const COIN_NUBS = [];', '.setPosition(Math.cos(a) * 1.5, 0, Math.sin(a) * 1.5));\n  }'),
      sliceFn(src, 'coinField'),
    ], `
      const f = coinField([[0, 0, 0]]);
      f.update(0);
      const group = new THREE.Group();
      for (const m of f.meshes) group.add(m);
      return { group };
    `) as unknown as { group: THREE.Group };
    return partsOf(d.group);
  }
  const d = runDemo(world, [
    ...matTokens('cellRimMat', 'cellTopMat'),
    sliceLine(src, '  const unitBox = '),
    sliceLine(src, '  const unitCyl = '),
    sliceLine(src, '  const unitCyl8 = '),
    sliceFn(src, 'box'),
    sliceFn(src, 'cyl'),
    sliceFn(src, 'makeCoin'),
  ], `
    const grp = makeCoin();
    grp.position.y = 3.4;
    return { group: grp };
  `) as unknown as { group: THREE.Group };
  return partsOf(d.group);
}

/** Demo material name for a part — the port's colour must map onto it. */
const COIN_MAT_COLOUR: Record<string, Record<string, number>> = {
  paper: { coinMat: 0xe8b93a, pinMetalMat: 0xc8cdd4 },
  plastic: { coinMat: 0xffd400, chipInnerMat: 0xff3b8d },
  circuit: { cellRimMat: 0x9aa1ab, cellTopMat: 0xdfe4ea },
};

for (const world of ['paper', 'plastic', 'circuit'] as const) {
  const style = await createTerrainStyleStrategy(world);
  const coin = style.buildCoinMesh();
  coin.position.y = 3.4;                       // demo hover at t = 0
  const ours = partsOf(coin);
  const theirs = demoCoinParts(world);

  check(`${world} coin: same number of parts as the demo`,
    ours.length === theirs.length, `demo ${theirs.length} vs ours ${ours.length}`);

  const dTri = triStream(theirs), oTri = triStream(ours);
  check(`${world} coin: every triangle in world space, in order (winding included)`,
    dTri.length === oTri.length && dTri.every((v, i) => v === oTri[i]),
    dTri.length === oTri.length && dTri.every((v, i) => v === oTri[i])
      ? `${dTri.length} triangles identical`
      : `${theirs.length ? firstDiff(dTri, oTri) : 'no demo parts'} (${dTri.length} vs ${oTri.length})`);

  // The demo splits the coin across TWO materials in every world (head/pin,
  // gold/inner, rim/top). Its material NAME per part is compared against the
  // colour the port paints that part: a part that quietly moved onto its
  // neighbour's material keeps its shape and fails here.
  const want = COIN_MAT_COLOUR[world];
  const demoSeq = theirs.map((p) => want[String(p.mat)]);
  const ourSeq = ours.map((p) => matFacts(p.mat).color);
  check(`${world} coin: each part wears the demo's own material colour`,
    demoSeq.length === ourSeq.length
    && demoSeq.every((v, i) => v === ourSeq[i]),
    `demo [${demoSeq.map((v) => v?.toString(16)).join(' ')}] vs ours `
    + `[${ourSeq.map((v) => v.toString(16)).join(' ')}]`);

  // Draw-call shape. The demos say this outright (plastic: "一枚 = 8 個 Mesh …
  // 是這個場景 draw call 的真兇") and answer it by batching every repeated part.
  // The bound is the demo's OWN bucket count — how many distinct
  // (geometry, material) pairs the coin is made of — not a number picked here.
  // Coins are pooled up to 200 live meshes, so one extra mesh per coin is two
  // hundred extra draw calls.
  const buckets = new Set(theirs.map((p) => `${p.geo.uuid}|${String(p.mat)}`)).size;
  let drawables = 0;
  coin.traverse((o) => { if ((o as THREE.Mesh).isMesh) drawables++; });
  check(`${world} coin: repeated parts stay batched (the demo's ${buckets} buckets)`,
    drawables <= buckets, `${drawables} drawables for ${ours.length} parts`);

  style.dispose();
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Checkpoint 旗
// ═══════════════════════════════════════════════════════════════════════════
//
// Structure only for the label itself: all three worlds write the word through
// their OWN sign carrier (`buildSign` / `glyphStrokes`), and those two layout
// engines are already diffed by `[sign spec]` / `[sign placement]`. What has
// never been checked is the thing under the words — post, head, plate, and
// WHERE the flag hangs.

console.log('\n[checkpoint vs demo — 三個世界]');

/** The demo checkpoint's non-glyph parts. */
function demoCheckpointParts(world: string): { parts: Part[]; flag: THREE.Object3D | null } {
  const src = SRC[world];
  if (world === 'paper') {
    const d = runDemo(world, [
      ...matTokens('pinMetalMat', 'pinHeadMat', 'signInkMat', 'crossMat'),
      'const geoCache = new Map(); const SHARED_GEO = new Set();',
      'const signTapeMats = new Proxy({}, { get: (_t, k) => `tape:${String(k)}` });',
      sliceFn(src, 'shared'),
      sliceLine(src, '  const unitBox = '),
      sliceLine(src, '  const unitSphere = '),
      sliceFn(src, 'box'),
      sliceLine(src, '  const SIGN_RATIO = '),
      sliceLine(src, '  const SIGN_MAX_W = '),
      sliceStmt(src, '  const unitLabelTape = shared('),
      sliceStmt(src, '  const unitTri = shared('),
      'const GLYPH = {}; const GLYPH_MISSING = []; const glyphWarned = new Set();',
      'function glyphOf() { return []; }',
      sliceFn(src, 'labelSign'),
      sliceLine(src, '  const CP_WORDS = '),
      sliceLine(src, '  const CP_ZONES = '),
      sliceLine(src, '  const cpPoleGeo = '),
      sliceFn(src, 'makeCheckpoint'),
    ], 'return { grp: makeCheckpoint(1) };') as unknown as { grp: THREE.Group };
    // ONE deviation, applied to the demo side so the rest of the diff stays
    // exact: the flag is turned to face the rider. `CheckpointFlagManager` yaws
    // the whole checkpoint onto the route tangent (all three demos do:
    // `cp.rotation.y = atan2(p.tx, p.tz)`), which leaves the rider approaching
    // from local −Z. Only the PLASTIC demo noticed and turned its face 180°
    // (「第一版轉了 90°…結果整塊牌子側對騎手」); paper's and circuit's writing
    // is left pointing along the direction of travel, where the rider never
    // sees it. The one demo that arbitrated wins. Everything else — the pole,
    // the head, the tape's size and where it hangs — is the demo's.
    const flag = d.grp.children[2] as THREE.Object3D | undefined;
    if (flag) flag.rotation.y = Math.PI;
    return { parts: partsOf(d.grp), flag: flag ?? null };
  }
  if (world === 'plastic') {
    const d = runDemo(world, [
      'const glossCache = new Map();',
      'const C = { pink: 0xff3b8d, cyan: 0x00d8ff, yellow: 0xffea00, ink: 0x1a1140 };',
      'const chipMetalMat = "chipMetalMat";',
      'function glossShared(c, o) { return `gloss:${c}:${JSON.stringify(o || {})}`; }',
      'function letterGeo() { return new THREE.BoxGeometry(1, 1, 1); }',
      sliceLine(src, '  const signPlateGeo = '),
      sliceLine(src, '  const signPostGeo = '),
      sliceLine(src, '  const signBaseGeo = '),
      // The word is compared by `[sign spec]`, not here: blank it so both sides
      // are the structure alone. (`makeCheckpoint` reads CP_MARKS.)
      "const CP_MARKS = ['', '', ''];",
      sliceFn(src, 'makeCheckpoint'),
    ], 'return { grp: makeCheckpoint(1) };') as unknown as { grp: THREE.Group };
    return { parts: partsOf(d.grp), flag: null };
  }
  const d = runDemo(world, [
    ...matTokens('headerMat', 'pinMat', 'epaperMat'),
    'const JUMPER_COLORS = ["j0", "j1", "j2"]; const jumperMats = JUMPER_COLORS;',
    'function glyphStrokes() {}',
    sliceLine(src, '  const unitBox = '),
    sliceFn(src, 'box'),
    sliceLine(src, '  const CP_WORDS = '),
    sliceFn(src, 'makeCheckpoint'),
  ], 'return { grp: makeCheckpoint(1) };') as unknown as { grp: THREE.Group };
  return { parts: partsOf(d.grp), flag: null };
}

/** AABB of a set of parts, in world space. */
function aabbOf(parts: Part[]): THREE.Box3 {
  const box = new THREE.Box3().makeEmpty();
  for (const p of parts) {
    if (!p.geo.boundingBox) p.geo.computeBoundingBox();
    box.union(p.geo.boundingBox!.clone().applyMatrix4(p.m));
  }
  return box;
}
const boxStr = (b: THREE.Box3): string =>
  `[${b.min.x.toFixed(2)},${b.min.y.toFixed(2)},${b.min.z.toFixed(2)}]…`
  + `[${b.max.x.toFixed(2)},${b.max.y.toFixed(2)},${b.max.z.toFixed(2)}]`;
const boxNear = (a: THREE.Box3, b: THREE.Box3, tol = 2e-3): boolean =>
  Math.abs(a.min.x - b.min.x) <= tol && Math.abs(a.min.y - b.min.y) <= tol
  && Math.abs(a.min.z - b.min.z) <= tol && Math.abs(a.max.x - b.max.x) <= tol
  && Math.abs(a.max.y - b.max.y) <= tol && Math.abs(a.max.z - b.max.z) <= tol;

for (const world of ['paper', 'plastic', 'circuit'] as const) {
  const style = await createTerrainStyleStrategy(world);
  // The BLANK checkpoint on both sides: the demo's word table is stubbed empty
  // above, so what is left is the structure alone — which is the half nothing
  // was checking. (The lettering has `[sign spec]` / `[sign placement]`.)
  const cp = style.buildCheckpoint(0xff3b8d, 1);
  const ours = partsOf(cp);
  const demo = demoCheckpointParts(world);

  check(`${world} checkpoint: same number of parts as the demo`,
    ours.length === demo.parts.length,
    `demo ${demo.parts.length} vs ours ${ours.length}`);

  // Sorted, not ordered: paper's tape is an ExtrudeGeometry over a rounded
  // rectangle, and the port's shape builder starts the outline at a different
  // corner from the demo's. That renumbers vertices without moving one. Sorting
  // gives up the SEQUENCE only — each triangle keeps its own corner order, so a
  // reversed winding still comes out as a different string.
  const dTri = triStream(demo.parts).sort(), oTri = triStream(ours).sort();
  const same = dTri.length === oTri.length && dTri.every((v, i) => v === oTri[i]);
  check(`${world} checkpoint: every triangle in world space (winding included)`,
    same,
    same ? `${dTri.length} triangles identical`
      : `${firstDiff(dTri, oTri)} (${dTri.length} vs ${oTri.length})`);

  // An unlabelled checkpoint must still carry a flag. `segmentSignLabel` never
  // returns empty, but `buildCheckpoint(color, i)` is a public hook and the
  // demo's `labelSign` always cuts the strip before it decides about glyphs —
  // a bare pin with nothing on it is not a checkpoint.
  check(`${world} checkpoint: an unlabelled one still has a flag`,
    ours.length >= 3, `${ours.length} parts`);

  // A labelled one gains geometry and loses nothing.
  const labelled = partsOf(style.buildCheckpoint(0xff3b8d, 1, 'MID'));
  check(`${world} checkpoint: a label only ADDS parts`,
    labelled.length > ours.length, `${ours.length} → ${labelled.length} parts`);

  // …and the WORD faces the rider, who arrives from local −Z once the manager
  // has yawed the group onto the route tangent. See `demoCheckpointParts` for
  // why this is the plastic demo's answer applied to all three.
  const wordBox = aabbOf(labelled.slice(ours.length));
  check(`${world} checkpoint: the word faces the rider (local −Z)`,
    wordBox.max.z <= 1e-6,
    `word z ∈ [${wordBox.min.z.toFixed(2)}, ${wordBox.max.z.toFixed(2)}]`);

  // The segment colour has to reach the flag. This is the one place all three
  // worlds deviate from the demo together and on purpose — the demo cycles a
  // fixed palette by index (`jumperMats[i % 3]`, `CP_ZONES[i % 3]`, `[C.pink,
  // C.cyan, C.yellow][i % 3]`) because it has no per-segment identity to carry;
  // gameview does, and the HUD shows the same colour.
  for (const hex of [0x22ff88, 0xff2200]) {
    const painted = partsOf(style.buildCheckpoint(hex, 1))
      .some((p) => matFacts(p.mat).color === hex);
    check(`${world} checkpoint: the flag takes the segment colour #${hex.toString(16)}`,
      painted, painted ? 'on the flag' : 'nothing wears it');
  }

  style.dispose();
}

// The other half of the demo's checkpoint: its PLACEMENT. All three demos do
// `cp.rotation.y = Math.atan2(p.tx, p.tz)`, and every world's `buildCheckpoint`
// is drawn in that frame. `CheckpointFlagManager` used to set position only,
// which left the plate/tape/cap pointing at whatever direction the map ran.
{
  const { CheckpointFlagManager } = await import('@/game/terrain/checkpoint-flag');
  const style = await createTerrainStyleStrategy('plastic');
  const scene = new THREE.Scene();
  const mgr = new CheckpointFlagManager(scene, style);
  // A route that turns: due east for 200 m, then due north for 200 m. The flag
  // falls in the second leg, so a manager that yawed off the FIRST leg (or off
  // nothing) lands somewhere else.
  const lat0 = 25.06, lon0 = 121.55;
  const dLon = 200 / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const dLat = 200 / 111320;
  const points = [
    { lon: lon0, lat: lat0, ele: 0 },
    { lon: lon0 + dLon, lat: lat0, ele: 0 },
    { lon: lon0 + dLon, lat: lat0 + dLat, ele: 0 },
  ] as never[];
  const cum = [0, 200, 400];
  // 90 s of 120 s → the boundary lands at 300 m, i.e. mid-way along the SECOND
  // leg. (Splitting it 60/60 puts the flag exactly on the corner, where either
  // leg's tangent is defensible — a case that proves nothing.)
  const segs = [
    { name: 'Warm Up', durationMs: 90000, color: '#ff3b8d' },
    { name: 'Interval 1', durationMs: 30000, color: '#00d8ff' },
  ] as never[];
  mgr.spawn(segs, points, cum, 400, lon0, lat0);
  const flag = scene.children[0];
  // Second leg heads north: scene +x = east, scene −z = north, so the tangent
  // is (0, −1) and `atan2(0, −1) = π`.
  check('checkpoint placement: the flag is yawed onto the route tangent',
    !!flag && Math.abs(Math.abs(flag.rotation.y) - Math.PI) < 1e-6,
    `rotation.y = ${flag ? flag.rotation.y.toFixed(4) : 'no flag'} (want ±π on a due-north leg)`);
  mgr.dispose();
  style.dispose();
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. 單車擺件 — the bike
// ═══════════════════════════════════════════════════════════════════════════
//
// On screen for every frame of every ride, and never once diffed. The demos
// build it as an IIFE that adds into `bikeLean`, so the slice is the block, not
// a function.

console.log('\n[bike vs demo — 三個世界]');

function demoBikeParts(world: string): { lean: THREE.Group; wheels: THREE.Object3D[] } {
  const src = SRC[world];
  const common = `
    const bike = new THREE.Group();
    const bikeLean = new THREE.Group();
    bike.add(bikeLean);
    const wheelSpin = [];
    const scene = { add() {} };
  `;
  if (world === 'paper') {
    const d = runDemo(world, [
      'const geoCache = new Map(); const SHARED_GEO = new Set(); const gradientMap = null;',
      sliceFn(src, 'shared'),
      sliceLine(src, '  const unitBox = '),
      sliceLine(src, '  const unitCyl = '),
      sliceLine(src, '  const unitSphere = '),
      sliceFn(src, 'toon'),
      // batchGroup collapses repeated parts into InstancedMesh — the port does
      // the same thing by hand, and `partsOf` expands both back out.
      sliceFn(src, 'batchGroup'),
      common,
      sliceBlock(src, '  (() => {\n    const wire = new THREE.MeshPhongMaterial',
        '    bike.scale.setScalar(1.15);\n    scene.add(bike);\n  })();'),
    ], 'return { lean: bikeLean, wheels: wheelSpin };') as unknown as
      { lean: THREE.Group; wheels: THREE.Object3D[] };
    return d;
  }
  if (world === 'plastic') {
    const d = runDemo(world, [
      'const glossCache = new Map(); const toonCache = new Map(); const gradientMap = null;',
      'const C = { pink: 0xff3b8d, cyan: 0x00d8ff, yellow: 0xffea00, ink: 0x1a1140 };',
      sliceFn(src, 'gloss'),
      sliceFn(src, 'toon'),
      sliceFn(src, 'matKey'),
      sliceFn(src, 'glossShared'),
      sliceFn(src, 'toonShared'),
      sliceLine(src, '  const STUD_LOD = '),
      sliceFn(src, 'makeStudGeo'),
      'const studGeos = STUD_LOD.map(makeStudGeo); const studGeo = studGeos[0];',
      sliceFn(src, 'studInstances'),
      common,
      sliceBlock(src, '  (() => {\n    const frameMat = glossShared(C.pink',
        '    bike.scale.setScalar(1.15);\n    scene.add(bike);\n  })();'),
    ], 'return { lean: bikeLean, wheels: wheelSpin };') as unknown as
      { lean: THREE.Group; wheels: THREE.Object3D[] };
    return d;
  }
  const d = runDemo(world, [
    'const gradientMap = null;',
    'const E = { trace: 0x2ff7c3, tin: 0xd8dde3, goldHi: 0xffd76a };',
    sliceFn(src, 'toon'),
    sliceFn(src, 'metal'),
    'const pinMat = metal(E.tin, { shininess: 140 });',
    'function pcbTextures() { return { face: {} }; }',
    'function tex() { return null; }',
    sliceLine(src, '  const unitBox = '),
    sliceLine(src, '  const unitCyl8 = '),
    'const glowParts = [];',
    common,
    sliceBlock(src, '  (() => {\n    const glowMat = new THREE.MeshBasicMaterial({ color: E.trace',
      '    bike.scale.setScalar(1.15);\n    scene.add(bike);\n  })();'),
  ], 'return { lean: bikeLean, wheels: wheelSpin };') as unknown as
    { lean: THREE.Group; wheels: THREE.Object3D[] };
  return d;
}

for (const world of ['paper', 'plastic', 'circuit'] as const) {
  const style = await createTerrainStyleStrategy(world);
  const parts = style.buildBikeOrnament();
  const ours = partsOf(parts.lean);
  const demo = demoBikeParts(world);
  const theirs = partsOf(demo.lean);

  check(`${world} bike: same part count`, ours.length === theirs.length,
    `demo ${theirs.length} vs ours ${ours.length}`);

  // Sorted, not ordered: `batchGroup` re-parents the demo's repeated parts onto
  // the group root, which reorders them relative to a hand-written hierarchy
  // without moving a single vertex.
  const dTri = triStream(theirs).sort(), oTri = triStream(ours).sort();
  check(`${world} bike: every triangle in world space (winding included)`,
    dTri.length === oTri.length && dTri.every((v, i) => v === oTri[i]),
    dTri.length === oTri.length && dTri.every((v, i) => v === oTri[i])
      ? `${dTri.length} triangles identical`
      : `${firstDiff(dTri, oTri)} (${dTri.length} vs ${oTri.length})`);

  check(`${world} bike: two wheels and a crank the renderer can spin`,
    parts.wheels.length === 2 && !!parts.crank,
    `${parts.wheels.length} wheels`);

  parts.dispose();
  style.dispose();
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. 樹
// ═══════════════════════════════════════════════════════════════════════════
//
// One InstancedMesh per chunk, so the geometry is built ONCE per chunk and the
// per-instance matrix only ever scales uniformly. That is the real constraint:
// where a demo has two tree variants, the port can only ship one.

console.log('\n[tree vs demo — 三個世界]');

/** Triangles of a merged vertex-coloured body, bucketed BY COLOUR — one colour
 *  is one part of the demo's hierarchy. */
function byColour(geo: THREE.BufferGeometry): Map<string, { tris: number; box: THREE.Box3 }> {
  const pos = geo.getAttribute('position');
  const col = geo.getAttribute('color');
  const idx = geo.index;
  const n = idx ? idx.count : pos.count;
  const out = new Map<string, { tris: number; box: THREE.Box3 }>();
  for (let i = 0; i < n; i += 3) {
    const j = idx ? idx.getX(i) : i;
    const key = new THREE.Color(col.getX(j), col.getY(j), col.getZ(j)).getHexString();
    let e = out.get(key);
    if (!e) { e = { tris: 0, box: new THREE.Box3().makeEmpty() }; out.set(key, e); }
    e.tris++;
    for (let k = 0; k < 3; k++) {
      const v = idx ? idx.getX(i + k) : i + k;
      e.box.expandByPoint(new THREE.Vector3(pos.getX(v), pos.getY(v), pos.getZ(v)));
    }
  }
  return out;
}

{
  // ── circuit: 圓片陶瓷電容樹 ──────────────────────────────────────────────
  const src = SRC.circuit;
  const d = runDemo('circuit', [
    ...matTokens('pinMat'),
    'const discCapMats = ["cap0", "cap1", "cap2"];',
    sliceLine(src, '  const unitBox = '),
    sliceLine(src, '  const unitSphere = '),
    sliceFn(src, 'box'),
    sliceFn(src, 'discCapTree'),
  ], 'return { grp: discCapTree(0, 1) };') as unknown as { grp: THREE.Group };
  const theirs = partsOf(d.grp);
  const style = await createTerrainStyleStrategy('circuit');
  const geo = style.buildTreeGeometry!();
  const buckets = byColour(geo);

  // Canopy: the demo's is `unitSphere` squashed — a SphereGeometry(1, 14, 10),
  // not a lens sewn out of quads. Triangle count is the topology fingerprint.
  const canopy = theirs[0];
  const canopyBox = aabbOf([canopy]);
  const ourCanopy = buckets.get('ffffff');
  check('circuit tree: the canopy is the demo\'s squashed unitSphere, facet for facet',
    !!ourCanopy && ourCanopy.tris === triCount(canopy.geo),
    `demo ${triCount(canopy.geo)} triangles vs ours ${ourCanopy?.tris ?? 0}`);
  check('circuit tree: the canopy occupies the demo\'s box',
    !!ourCanopy && boxNear(canopyBox, ourCanopy.box, 5e-3),
    `demo ${boxStr(canopyBox)} vs ours ${ourCanopy ? boxStr(ourCanopy.box) : '—'}`);

  // Legs: two splayed tin sticks. `block()` only yaws, so a port that used it
  // silently dropped `leg.rotation.z = -sd * 0.06` and stood them up straight.
  const legBox = aabbOf(theirs.slice(1));
  // Read out of the demo's own palette, not typed here.
  const tin = new THREE.Color(
    parseInt(/tin:\s*'#([0-9a-fA-F]{6})'/.exec(src)![1], 16)).getHexString();
  const ourLegs = [...buckets].find(([k]) => k !== 'ffffff');
  check('circuit tree: the legs keep the demo\'s splay',
    !!ourLegs && boxNear(legBox, ourLegs[1].box, 5e-3),
    `demo ${boxStr(legBox)} vs ours ${ourLegs ? boxStr(ourLegs[1].box) : '—'}`);
  check('circuit tree: the legs are painted the demo\'s tin, not the canopy glaze',
    ourLegs?.[0] === tin, `${ourLegs?.[0]} vs ${tin}`);

  // Triangle for triangle, winding included. Bounding boxes and triangle counts
  // both survive a REVERSED WINDING (the merge helper appends an index run, and
  // running it backwards moves nothing), which is what this catches.
  const dTri = triStream(theirs).sort();
  const oTri = worldTris({ geo, m: new THREE.Matrix4(), mat: null, name: '' }).sort();
  check('circuit tree: every triangle in world space (winding included)',
    dTri.length === oTri.length && dTri.every((v, i) => v === oTri[i]),
    dTri.length === oTri.length && dTri.every((v, i) => v === oTri[i])
      ? `${dTri.length} triangles identical`
      : `${firstDiff(dTri, oTri)} (${dTri.length} vs ${oTri.length})`);

  // …and the three glazes the demo picks from must be the three the renderer
  // tints with (`discCapMats`), or the world grows a colour it never had.
  const glazes = [.../const discCapMats = \[([^\]]+)\]/.exec(src)![1]
    .matchAll(/'#([0-9a-fA-F]{6})'/g)].map((m) => parseInt(m[1], 16));
  check('circuit tree: treeCanopyColors are the demo\'s three glazes',
    JSON.stringify([...style.treeCanopyColors]) === JSON.stringify(glazes),
    `${[...style.treeCanopyColors].map((c) => c.toString(16))} vs ${glazes.map((c) => c.toString(16))}`);

  geo.dispose();
  style.dispose();
}

{
  // ── plastic: 毛根(扭扭棒)螺旋樹 ────────────────────────────────────────
  // The demo's coil is a UNIT helix scaled per tree; the port bakes an absolute
  // size in (instancing gives it one uniform scale, and lamps/bushes/skirts
  // were placed against that silhouette). So the comparison is the FORMULA:
  // demo coil rescaled onto the port's radius/height must land on the port's
  // vertices exactly.
  const src = SRC.plastic;
  const d = runDemo('plastic', [
    sliceStmt(src, '  const coilGeo = (() => {'),
    sliceLine(src, '  const COIL_GREENS = '),
    // Both tree variants the demo emits, with their (radius, height).
    'const trunkMat = "trunk"; const box = { push: (...a) => trunks.push(a) };',
    'const trunks = []; const coils = [];',
    'const coil = { push: (...a) => coils.push(a) };',
    'function coilMat() { return "coil"; }',
    sliceFn(src, 'emitTree'),
  ], `
    emitTree(box, null, false, 1, 0, 0, 0, 0, coil);
    emitTree(box, null, true, 1, 0, 0, 0, 0, coil);
    return { coilGeo, COIL_GREENS, coils, trunks };
  `) as unknown as {
    coilGeo: THREE.BufferGeometry; COIL_GREENS: string[];
    coils: number[][]; trunks: number[][];
  };

  const style = await createTerrainStyleStrategy('plastic');
  const geo = style.buildTreeGeometry!();
  const buckets = byColour(geo);
  const canopyHex = new THREE.Color(style.treeCanopyColors[0]).getHexString();
  const ourCanopy = buckets.get(canopyHex);
  const demoTris = triCount(d.coilGeo);
  check('plastic tree: the coil has the demo\'s segment count (TURNS 6.2 / SEG 62)',
    ourCanopy?.tris === demoTris, `demo ${demoTris} vs ours ${ourCanopy?.tris ?? 0}`);

  // ── The FORMULA, tunable-free ────────────────────────────────────────────
  // The port bakes an absolute size in (one InstancedMesh gives it one uniform
  // scale; the coil replaced a stacked-cuboid tree that lamps, bushes and
  // building skirts had already been placed against). So the size is solved OUT
  // of the two bounding boxes and then EVERY vertex of the demo's unit coil,
  // put through that solve, has to land on the port's — which is a check the
  // shipped radius/height cannot make true by accident, and which survives
  // someone re-tuning them.
  d.coilGeo.computeBoundingBox();
  const db = d.coilGeo.boundingBox!;
  const ob = ourCanopy!.box;
  const R = (ob.max.x - ob.min.x) / (db.max.x - db.min.x);
  const H = (ob.max.y - ob.min.y) / (db.max.y - db.min.y);
  const y0 = ob.min.y - db.min.y * H;
  const dp = d.coilGeo.getAttribute('position');
  const op = geo.getAttribute('position');
  let worst = 0, at = -1;
  for (let i = 0; i < dp.count; i++) {
    const e = Math.max(
      Math.abs(dp.getX(i) * R - op.getX(i)),
      Math.abs(dp.getY(i) * H + y0 - op.getY(i)),
      Math.abs(dp.getZ(i) * R - op.getZ(i)));
    if (e > worst) { worst = e; at = i; }
  }
  check('plastic tree: every coil vertex is the demo\'s unit helix, rescaled',
    dp.count <= op.count && worst < 1e-4,
    `${dp.count} vertices, worst ${worst.toExponential(2)} at #${at} `
    + `(solved r=${R.toFixed(3)} h=${H.toFixed(3)})`);

  // …and its NORMALS, which are the demo's other hand-written thing and the one
  // a resize cannot touch: 「法向**手動指定成朝外偏上**,不用 computeVertexNormals()
  // …(2) DoubleSide 的背面 three 會在 shader 裡翻法向,但 headless probe 不會 ——
  // 靠自動計算的話,瀏覽器跟 probe 會長得不一樣,那是最糟的情況(兩邊都不能信)。」
  // A ribbon whose normals were left to three keeps EVERY vertex where it is,
  // so only this sees it.
  const dn = d.coilGeo.getAttribute('normal');
  const on = geo.getAttribute('normal');
  let nWorst = 0, nAt = -1;
  for (let i = 0; i < dn.count; i++) {
    const e = Math.max(
      Math.abs(dn.getX(i) - on.getX(i)),
      Math.abs(dn.getY(i) - on.getY(i)),
      Math.abs(dn.getZ(i) - on.getZ(i)));
    if (e > nWorst) { nWorst = e; nAt = i; }
  }
  check('plastic tree: the coil\'s normals are the demo\'s outward-and-up, not computed',
    nWorst < 1e-6, `worst ${nWorst.toExponential(2)} at #${nAt}`);

  // …and the size it was rescaled TO has to stay between the demo's own two
  // tree variants (short r 3.6 / h 7.0, tall r 2.7 / h 9.4). A single geometry
  // cannot be both, but it must not be outside both.
  const dRs = d.coils.map((c) => c[5]), dHs = d.coils.map((c) => c[6]);
  check('plastic tree: its one size lies between the demo\'s two variants',
    R >= Math.min(...dRs) * 0.4 && R <= Math.max(...dRs)
    && H >= Math.min(...dHs) * 0.4 && H <= Math.max(...dHs),
    `ours r=${R.toFixed(2)} h=${H.toFixed(2)} vs demo r ${dRs.join('/')} h ${dHs.join('/')}`
    + ' (instancing gives one uniform scale, so the two variants collapse to one)');

  // The canopy greens: the demo has three, the port ships them as the instance
  // tint palette.
  const greens = d.COIL_GREENS.map((c) => new THREE.Color(c).getHex());
  check('plastic tree: treeCanopyColors are the demo\'s three coil greens',
    JSON.stringify([...style.treeCanopyColors]) === JSON.stringify(greens),
    `${[...style.treeCanopyColors].map((c) => c.toString(16))} vs ${greens.map((c) => c.toString(16))}`);
  // The trunk is a pipe cleaner too, one shade darker — the demo's `trunkMat`.
  const trunkHex = new THREE.Color(
    parseInt(/const trunkMat = toonShared\('#([0-9a-fA-F]{6})'\)/.exec(src)![1], 16)).getHexString();
  check('plastic tree: the trunk wears the demo\'s trunkMat colour',
    buckets.has(trunkHex), `${[...buckets.keys()].join(' ')} — want ${trunkHex}`);

  geo.dispose();
  style.dispose();
}

{
  // ── paper: 剪紙樹(兩張卡插成十字)────────────────────────────────────
  const src = SRC.paper;
  const d = runDemo('paper', [
    'const geoCache = new Map(); const SHARED_GEO = new Set();',
    sliceFn(src, 'shared'),
    sliceLine(src, '  const unitPlane = '),
    sliceLine(src, '  const unitDisc = '),
    'const treeMats = new Proxy({}, { get: () => ["cut0", "cut1"] });',
    'const treeDepthMats = treeMats; const glueMat = "glueMat";',
    sliceFn(src, 'treeBucket'),
  ], `
    const b = treeBucket();
    b.add(0, 1, 0, 0, 0, 0);
    const group = new THREE.Group();
    b.flush(group, []);
    return { group };
  `) as unknown as { group: THREE.Group };
  const theirs = partsOf(d.group);
  const style = await createTerrainStyleStrategy('paper');
  const geo = style.buildTreeGeometry!();

  // Two crossed cards, and the demo's own scale of them.
  const cards = theirs.filter((p) => String(p.mat).startsWith('cut'));
  check('paper tree: two crossed cards', cards.length === 2, `${cards.length} cards`);
  const dCards = aabbOf(cards);
  const ourBox = new THREE.Box3().setFromBufferAttribute(
    geo.getAttribute('position') as THREE.BufferAttribute);
  const dH = dCards.max.y - dCards.min.y, oH = ourBox.max.y - ourBox.min.y;
  const dW = dCards.max.x - dCards.min.x, oW = ourBox.max.x - ourBox.min.x;
  check('paper tree: the card is square, the way the demo cuts it',
    Math.abs(dH / dW - oH / oW) < 1e-6, `demo ${(dH / dW).toFixed(4)} vs ours ${(oH / oW).toFixed(4)}`);
  check('paper tree: the card sits ON the ground (base at y = 0)',
    Math.abs(ourBox.min.y) < 1e-6, `min.y ${ourBox.min.y.toFixed(4)}`);
  check('paper tree: two cards\' worth of triangles, not one',
    triCount(geo) === 4, `${triCount(geo)} triangles`);

  geo.dispose();
  style.dispose();
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. 水面材質
// ═══════════════════════════════════════════════════════════════════════════
//
// `createWaterMaterial` is ONE material for one surface. The paper and plastic
// demos both have a pond, and its film is `pondFilmMat` — a real declaration
// with real numbers, so this one is a straight material diff. (The demo's pond
// is two layers; only the film is what this hook is.)

console.log('\n[water material vs demo]');

/**
 * The demo's own `pondFilmMat`, EXECUTED — not parsed. Plastic's goes through
 * `glossShared`, whose defaults (`specular #ffffff`, `shininess 90`) live in
 * `gloss()`, so reading the literal would miss half of what the material is.
 */
function demoPondFilm(world: string): THREE.MeshPhongMaterial {
  const src = SRC[world];
  if (world === 'paper') {
    return (runDemo(world, [
      sliceStmt(src, '  const pondFilmMat = new THREE.MeshPhongMaterial({'),
    ], 'return { m: pondFilmMat };') as unknown as { m: THREE.MeshPhongMaterial }).m;
  }
  return (runDemo(world, [
    'const glossCache = new Map();',
    sliceStmt(src, '  const C = {'),
    sliceFn(src, 'gloss'),
    sliceFn(src, 'matKey'),
    sliceFn(src, 'glossShared'),
    sliceStmt(src, '  const pondFilmMat = glossShared('),
  ], 'return { m: pondFilmMat };') as unknown as { m: THREE.MeshPhongMaterial }).m;
}

for (const world of ['paper', 'plastic'] as const) {
  const want = matFacts(demoPondFilm(world));
  const style = await createTerrainStyleStrategy(world);
  const mat = style.createWaterMaterial() as THREE.MeshPhongMaterial;
  const got = matFacts(mat);
  for (const k of ['cls', 'color', 'specular', 'shininess', 'opacity',
    'transparent', 'side'] as const) {
    const show = (v: unknown): string =>
      (k === 'color' || k === 'specular' ? Number(v).toString(16) : String(v));
    check(`${world} water: the demo's pondFilmMat ${k}`,
      got[k] === want[k], `demo ${show(want[k])} vs ours ${show(got[k])}`);
  }
  mat.dispose();
  style.dispose();
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. 沒有 demo 對照物的 hook（port-time inventions）
// ═══════════════════════════════════════════════════════════════════════════
//
// `plan/demo-gaps.md` §3 records these as "demo 完全沒有這個概念 / 移植的人決定".
// There is nothing to diff, so what this section pins is the ABSENCE: the day
// somebody draws a tunnel mouth or an aeroplane in a demo, these fail and say
// "there is an answer now — go port it" instead of leaving three inventions
// nobody remembers are inventions.
//
// Fingerprinted by the demo's own vocabulary, not by a hook name: names change
// in a port, and a comment is where a demo announces what it is building.
//
// ⚠ ONE region is cut out first: the demos' GEO section (the `?loc=` DEM + MVT
// loader). It says `aeroway`, `water` and 隧道 because those are the OpenMapTiles
// LAYERS it FETCHES — it draws none of them. Without the cut, the day the demos
// learned to download real map tiles read exactly like the day they learned to
// draw a runway, and two true assertions would have been "fixed" by deleting a
// comment. The region is bounded by markers the demos carry on purpose and BOTH
// the markers and the size of the cut are asserted below, so the exemption
// cannot quietly grow to cover the world-building code it exists to exclude.

console.log('\n[hooks with no demo counterpart — port-time inventions]');

const GEO_BEGIN = '── GEO 區塊開始 ──';
const GEO_END = '// ══ GEO 區塊結束 ══';
/** The demo's source with the geo data-source section removed. */
function outsideGeo(w: 'paper' | 'plastic' | 'circuit'): string {
  const s = SRC[w];
  const a = s.indexOf(GEO_BEGIN);
  const b = s.indexOf(GEO_END);
  if (a < 0 || b < 0 || b <= a) return s;      // no markers → nothing is exempt
  return s.slice(0, a) + s.slice(b + GEO_END.length);
}
/** Just the exempt span, so what is being let off can be inspected directly. */
function geoSection(w: 'paper' | 'plastic' | 'circuit'): string {
  const s = SRC[w];
  const a = s.indexOf(GEO_BEGIN), b = s.indexOf(GEO_END);
  return a >= 0 && b > a ? s.slice(a, b + GEO_END.length) : '';
}
// The fence is CONTENT, not size. A percentage bound was tried first and a
// mutation walked straight through it: `SRC` is the whole HTML file, three
// quarters of which is the bundled three.js, so an end-marker shoved to the last
// line of the demo swallowed every prop in the world and still measured 17%.
// What actually distinguishes the loader from the world is that the loader
// builds no scene — so that is what is asserted.
const NOT_IN_A_LOADER = [
  'buildChunk', 'scene.add(', 'new THREE.Mesh(', 'InstancedMesh', 'castShadow',
];
for (const w of ['paper', 'plastic', 'circuit'] as const) {
  const a = SRC[w].indexOf(GEO_BEGIN), b = SRC[w].indexOf(GEO_END);
  const sec = geoSection(w);
  check(`${w}: the geo section is marked at both ends`, a >= 0 && b > a,
    `begin@${a} end@${b}`);
  const leaked = NOT_IN_A_LOADER.filter((k) => sec.includes(k));
  check(`${w}: …and the exempt region builds nothing — it is a loader`,
    sec.length > 2000 && leaked.length === 0,
    `${sec.length} chars` + (leaked.length ? `, but contains: ${leaked.join(', ')}` : ''));
}

// The vocabulary is UNCHANGED from before the geo loader landed. Widening it to
// 隧道/跑道 was tried and reverted: plastic and paper have carried a 「跑道燈」
// (a neon runway-marker light, an easter egg) in their checklists since long
// before any of this, so the wider net would have been a NEW claim about those
// two worlds smuggled in under a change about tile loading.
const NO_COUNTERPART: [string, RegExp][] = [
  ['tunnel portal (buildTunnelPortal)', /隧道口|tunnelPortal|makeTunnel/],
  ['aeroway plane (buildPlaneOrnament)', /飛機|makePlane\b|aeroway|runway/],
  ['finish airship (buildFinishAirship)', /飛船|airship|zeppelin|makeUfo/i],
];
for (const [what, re] of NO_COUNTERPART) {
  const hits = (['paper', 'plastic', 'circuit'] as const).filter((w) => re.test(outsideGeo(w)));
  check(`no demo draws a ${what} — the shipped one is a port-time invention`,
    hits.length === 0, hits.length ? `now present in: ${hits.join(', ')}` : 'absent in all three');
}
// The cut is an exemption, so it has to be shown to be one: the vocabulary IS in
// there, and the same regexes fire on the unexempted source. Without this the
// two checks above would still pass if the markers ever swallowed everything.
{
  const inGeo = (['paper', 'plastic', 'circuit'] as const)
    .filter((w) => /aeroway/.test(SRC[w]) && !/aeroway/.test(outsideGeo(w)));
  check('the exemption is doing real work — every demo names `aeroway` INSIDE the geo section and nowhere else',
    inGeo.length === 3, `${inGeo.length}/3 worlds`);
}
// Circuit is the one world whose demo has no pond either, so its water material
// (a solder pool) has no arbiter. The other two are diffed above.
check('circuit demo has no water surface — its water material is an invention too',
  !/pondFilmMat|pondBottomMat/.test(SRC.circuit), 'no pond in the circuit demo');

// ═══════════════════════════════════════════════════════════════════════════
// 6a. 三個世界的合成小丘:**已刪除**,而且不准回來
// ═══════════════════════════════════════════════════════════════════════════
//
// 瓦楞紙的 `contourPlate` / `contourHill` / `contourRing` 由 `paper-props-vs-demo.ts`
// 盯著。這裡是**另外兩個世界的同一件事**:積木的 `plasticSlab(blobShape(...))` 疊層
// 與電子的多層板疊層,2026-07-28 一起刪掉,理由一字不差地相同 ——
//
//   它們存在的理由是「demo 的地面是一張平的板,它得假造起伏」。地面現在可以是真
//   的(`?loc=` 走 DEM),那個理由就消失了 —— 留著的話它會疊在真坡上,跟騎士正在
//   爬的坡度矛盾,變成 **demo 自己畫錯**,而 demo 是 POC,它畫錯就等於規格錯。
//
// 判準見 `plan/demo-gaps.md`「demo 為了自己的限制而發明的東西」。
//
// 這幾條是**反向斷言**:不是「demo 必須留著它們」,是「它們必須不在」。
{
  /** 註解裡的名字不是程式碼。`contourRing` 就是靠一段長註解騙過人兩次的。 */
  const codeOf = (w: 'paper' | 'plastic' | 'circuit'): string =>
    SRC[w].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const CODE = {
    plastic: codeOf('plastic'), circuit: codeOf('circuit'), paper: codeOf('paper'),
  };
  /** 定義了或被呼叫了 —— 兩邊都要沒有才算刪乾淨。 */
  const alive = (w: 'paper' | 'plastic' | 'circuit', name: string): boolean =>
    new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(CODE[w])
    || new RegExp(`\\bconst\\s+${name}\\s*=`).test(CODE[w])
    || new RegExp(`\\b${name}\\s*\\(`).test(CODE[w]);

  const GONE: [('plastic' | 'circuit'), string][] = [
    ['plastic', 'plasticSlab'],        // 一片疊層板的建構函式(paper 的 contourPlate)
    ['plastic', 'FORCE_HILL'],         // ?hill=1 —— 沒有小丘可以強制了
    ['circuit', 'addStackConnectors'], // 板與板之間的黑色排母裙邊
    ['circuit', 'moundMat'],           // 小丘專用的第二份佈線取樣
    ['circuit', 'STACK_GAP'],
    ['circuit', 'FORCE_HILL'],
  ];
  for (const [w, name] of GONE) {
    check(`${w}: ${name} 已經從 demo 刪掉了 —— 定義與呼叫都不准回來`,
      !alive(w, name), `alive=${alive(w, name)}`);
  }
  // 上面那幾條在「這個判斷永遠說不在」的情況下也會過,所以要對照:同一支判斷拿去
  // 問確實還在的名字,必須說「在」。挑的是**留下來的那半** —— 也就是墓碑點名不准
  // 跟著被刪的東西:積木的量化色帶三件套、電子的量化豎邊材質。
  const STAYS: [('plastic' | 'circuit'), string][] = [
    ['plastic', 'TERRAIN_BAND'], ['plastic', 'STEP_H'], ['plastic', 'bandAt'],
    ['plastic', 'blobShape'],
    ['circuit', 'edgeMatForLevel'], ['circuit', 'discCapTree'],
    ['circuit', 'headerMat'], ['circuit', 'blobShape'],
  ];
  for (const [w, name] of STAYS) {
    check(`${w}: …而 ${name} 還在 —— 它不是小丘的東西,刪小丘不准順手帶走`,
      alive(w, name));
  }
  // 那顆旗鈕:三份控制列現在都沒有 `hill` 那一列。三個世界的小丘都不在了,留著就是
  // 一列謊話 —— 而 DEMO_POC_GUIDE §5 要求三份控制列逐字相同,所以要走一起走。
  for (const w of ['paper', 'plastic', 'circuit'] as const) {
    check(`${w}: 控制列不再有 hill 那一列`,
      !/key: 'hill'/.test(SRC[w]));
  }
  // 而且元件清單也要跟著收 —— 檔頭那份 `<li>` 清單是這個世界對外宣稱它供應什麼,
  // 留著一個畫不出來的品項,清單就開始說謊(上一輪瓦楞紙就漏了這一條)。
  for (const w of ['paper', 'plastic', 'circuit'] as const) {
    const list = SRC[w].slice(SRC[w].indexOf('<details class="checklist"'),
      SRC[w].indexOf('</details>', SRC[w].indexOf('<details class="checklist"')));
    check(`${w}: 檔頭元件清單裡沒有小丘了`, list.length > 200 && !/小丘/.test(list),
      `${list.length} chars`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6a2. LANDUSE 區塊:分派照抄 gameview,而唯一的分歧是 demo 說了算
// ═══════════════════════════════════════════════════════════════════════════
//
// 五格地被(farmland / wetland / sports / playground / sand)是 `demo-gaps.md`
// 第三級的一整列 —— gameview 有,demo 從來沒仲裁過,所以現在的樣子是移植的人決定
// 的。demo 補上之後,**分派**這一半必須是照抄的(§0.0 第 1 條:反方向的移植規則
// 一樣),否則兩邊會對同一塊地做出不同的判斷。
//
// 所以下面每一個數字都是**執行時從 `packages/` 讀出來**的,一個都沒有打進這個檔案。
//
// 而 demo 相對 gameview 有**一處分歧,而且是 demo 說了算**:gameview 的
// `isSportsLanduse` 把 pitch / playground / track / stadium 收成同一格,一座遊樂場
// 會被畫成一片球場。demo 把 playground 拆出來(球場平、遊樂場有結構)。
// 這一條被斷言成**分歧**而不是被跳過 —— 不然下一個人會把它「修好」。

console.log('\n[landuse dispatch vs gameview]');

const LU_BEGIN = '── LANDUSE 區塊開始 ──';
const LU_END = '// ══ LANDUSE 區塊結束 ══';
function luSection(w: 'paper' | 'plastic' | 'circuit'): string {
  const a = SRC[w].indexOf(LU_BEGIN), b = SRC[w].indexOf(LU_END);
  return a >= 0 && b > a ? SRC[w].slice(a, b + LU_END.length) : '';
}
{
  // 三份逐字相同 —— §5 的那條規矩,而這一段是「複製三次」風險最高的形狀。
  const secs = (['paper', 'plastic', 'circuit'] as const).map(luSection);
  const same = secs.every((s) => s === secs[0] && s.length > 4000);
  const firstDiff = same ? -1 : [...secs[0]].findIndex((c, i) => c !== secs[1][i]);
  check('三份 demo 的 LANDUSE 分派逐字相同', same,
    same ? `${secs[0].length} chars` : `第一個差異在第 ${firstDiff} 個字元`);
  // 而且它真的只是分派:一個顏色、一張畫布都不在裡面(造型住在各世界的 LU_STYLE)。
  const artefacts = ['#', 'getContext', 'MeshToonMaterial', 'MeshBasicMaterial', 'CanvasTexture'];
  const leaked = artefacts.filter((k) => secs[0].includes(k));
  check('…而且那一段裡一件造型都沒有 —— 顏色與畫布全部住在 LU_STYLE',
    leaked.length === 0, leaked.length ? `洩漏:${leaked.join(', ')}` : 'clean');
}

const LR_SRC = readFileSync('packages/web/src/game/terrain/landuse-renderer.ts', 'utf8');
const OD_SRC = readFileSync('packages/web/src/game/terrain/overlay-depth.ts', 'utf8');

/** gameview 某個述詞函式體裡出現的 class 字串。 */
function gvPredicateClasses(fn: string): string[] {
  const at = LR_SRC.indexOf(`function ${fn}(`);
  if (at < 0) return [];
  let i = LR_SRC.indexOf('{', at), depth = 0, end = i;
  for (; i < LR_SRC.length; i++) {
    if (LR_SRC[i] === '{') depth++;
    else if (LR_SRC[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return [...LR_SRC.slice(at, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}
/** gameview 的 `const X_HEIGHT_OFFSET = n;`。 */
function gvOffset(name: string): number {
  const m = new RegExp(`const ${name}_HEIGHT_OFFSET = ([\\d.]+);`).exec(LR_SRC);
  if (!m) throw new Error(`gameview no longer declares ${name}_HEIGHT_OFFSET`);
  return Number(m[1]);
}
/** gameview 的 OVERLAY_RANK,依名次排序後的名字。 */
const gvRankOrder = (() => {
  const at = OD_SRC.indexOf('export const OVERLAY_RANK = {');
  const body = OD_SRC.slice(at, OD_SRC.indexOf('}', at));
  return [...body.matchAll(/(\w+): (\d+),/g)]
    .map((m) => ({ k: m[1], v: Number(m[2]) })).sort((a, b) => a.v - b.v).map((e) => e.k);
})();

// demo 的分派,**切出來執行**。
const demoLu = new Function(`
  ${sliceFn(SRC.paper, 'luKindOf')}
  ${sliceStmt(SRC.paper, '  const LU_KINDS = ')}
  ${sliceStmt(SRC.paper, '  const LU_H = {')}
  ${sliceStmt(SRC.paper, '  const LU_RANK = {')}
  return { luKindOf, LU_KINDS, LU_H, LU_RANK };
`)() as {
  luKindOf: (f: { layer: string; properties: { class?: string } }) => string | null;
  LU_KINDS: string[];
  LU_H: Record<string, number>;
  LU_RANK: Record<string, number>;
};
const luOf = (layer: string, cls: string): string | null =>
  demoLu.luKindOf({ layer, properties: { class: cls } });

check('demo 的 luKindOf / LU_KINDS / LU_H / LU_RANK 切得出來且跑得動',
  typeof demoLu.luKindOf === 'function' && demoLu.LU_KINDS.length === 5,
  demoLu.LU_KINDS.join(', '));

// ── 述詞:gameview 認得的每一個 class,demo 都要判到同一格 ──
for (const [fn, layer, want] of [
  ['isFarmlandLandcover', 'landcover', 'farmland'],
  ['isWetlandLandcover', 'landcover', 'wetland'],
] as const) {
  const classes = gvPredicateClasses(fn);
  const bad = classes.filter((c) => luOf(layer, c) !== want);
  check(`gameview 的 ${fn}(${classes.join('/')})→ demo 全部判成 ${want}`,
    classes.length > 0 && bad.length === 0,
    bad.length ? `不一致:${bad.map((c) => `${c}→${luOf(layer, c)}`).join(', ')}` : `${classes.length} 個 class`);
}
// sand 在 gameview 沒有述詞函式,它是 spec 表上的一句 `f.properties.class === 'sand'`。
check("gameview 的 sand 那一格(landcover class === 'sand')→ demo 也是 sand",
  /f\.layer === 'landcover' && f\.properties\.class === 'sand'/.test(LR_SRC)
  && luOf('landcover', 'sand') === 'sand');

// ── 那一處分歧:**已經收掉了**,所以這兩條從「記錄偏離」翻成「正面陳述」 ──
//
// 這兩條原本寫的是「gameview 把 playground 併進球場,而 demo 拆了」—— 一條記錄
// 缺陷的斷言。缺陷 2026-07-28 補好了(`isSportsLanduse` 不再收 playground,
// `isPlaygroundLanduse` 接手),所以它們必須跟著翻面,而且**一樣嚴**:現在斷言的
// 是兩邊對這四個 class 逐一同意。刪掉會讓「哪天有人把它併回去」變成沒有人看得見。
{
  const sports = gvPredicateClasses('isSportsLanduse');
  const play = gvPredicateClasses('isPlaygroundLanduse');
  check('gameview 已經跟上:isSportsLanduse 不再收 playground',
    !sports.includes('playground') && sports.includes('pitch'),
    `gameview isSportsLanduse = ${sports.join('/')}`);
  check('…而 isPlaygroundLanduse 接住了它,而且只有它',
    play.length === 1 && play[0] === 'playground', `isPlaygroundLanduse = ${play.join('/')}`);
  // 逐一同意 —— 兩邊對這四個 class 判到同一格。用的是 gameview 讀出來的清單,
  // 所以 gameview 哪天再多一個 class,這條會跟著問 demo 認不認得。
  const bad = [...sports.map((c) => [c, 'sports'] as const),
    ...play.map((c) => [c, 'playground'] as const)]
    .filter(([c, want]) => luOf('landuse', c) !== want);
  check('球場/遊樂場那四個 class,demo 與 gameview 逐一同意',
    bad.length === 0 && sports.length + play.length === 4,
    bad.length ? bad.map(([c, w]) => `${c}: demo ${luOf('landuse', c)} vs gameview ${w}`).join(', ')
      : `${sports.join('/')}→sports, ${play.join('/')}→playground`);
}
// 反向對照:gameview 不認得的 class,demo 也不准認。`rock` 是五個地點裡實測都有
// 的一個(taipei 6 / alpedhuez 22 / ventoux 9 / amalfi 24),而兩邊都沒有它。
check('反向對照:landcover rock 兩邊都判不出來(它是真的沒人畫的一格)',
  luOf('landcover', 'rock') === null
  && gvPredicateClasses('isForestLandcover').concat(gvPredicateClasses('isParkLandcover'))
    .indexOf('rock') < 0);
check('反向對照 2:demo 只認自己那五格 —— park / forest / water 不歸它管',
  luOf('landcover', 'wood') === null && luOf('landcover', 'grass') === null
  && luOf('water', 'lake') === null && luOf('landuse', 'residential') === null);

// ── 兩道階梯 ──
{
  const gv: Record<string, number> = {
    water: gvOffset('WATER'), wetland: gvOffset('WETLAND'), park: gvOffset('PARK'),
    forest: gvOffset('FOREST'), sports: gvOffset('SPORTS'), sand: gvOffset('SAND'),
    farmland: gvOffset('FARMLAND'), urban: gvOffset('URBAN'),
  };
  const bad = Object.entries(gv).filter(([k, v]) => demoLu.LU_H[k] !== v);
  check('公尺階梯:gameview 有的八格,demo 一個不差',
    bad.length === 0,
    bad.length ? bad.map(([k, v]) => `${k} demo ${demoLu.LU_H[k]} vs ${v}`).join(', ')
      : Object.keys(gv).length + ' 格');
  // 新的那一格必須擠在球場**正下方** —— 兩者會相鄰,而球場的線要壓在遊樂場地墊上。
  check('新增的 playground 擠在 sports 與 sand 之間',
    demoLu.LU_H.playground < demoLu.LU_H.sports && demoLu.LU_H.playground > demoLu.LU_H.sand,
    `sand ${demoLu.LU_H.sand} < playground ${demoLu.LU_H.playground} < sports ${demoLu.LU_H.sports}`);
}
{
  // 名次比的是**順序**不是數字:demo 多插了一格,所以 playground 以上全部 +1。
  // 比數字會逼 demo 去遷就一張它多一格的表,比順序才是這道階梯真正的規則。
  const shared = gvRankOrder.filter((k) => demoLu.LU_RANK[k] !== undefined);
  const demoOrder = Object.entries(demoLu.LU_RANK)
    .sort((a, b) => a[1] - b[1]).map((e) => e[0]).filter((k) => shared.includes(k));
  check('polygonOffset 名次:demo 與 gameview 的**順序**一致(數字因為多一格而平移)',
    demoOrder.join(',') === shared.join(','),
    `demo ${demoOrder.join('<')} / gameview ${shared.join('<')}`);
  // overlay-depth.ts 自己寫著「保持跟公尺階梯同一個順序,不然遠近會互相矛盾」。
  const byH = Object.entries(demoLu.LU_H).sort((a, b) => a[1] - b[1]).map((e) => e[0]);
  const byRank = Object.entries(demoLu.LU_RANK).sort((a, b) => a[1] - b[1]).map((e) => e[0]);
  check('公尺階梯與名次階梯同序 —— overlay-depth.ts 明文要求的那一條',
    byH.join(',') === byRank.join(','), `${byH.join('<')}`);
  // 而且 luApplyDepth 真的照 overlay-depth.ts 的算式寫(factor = −rank、units = −2·rank)。
  const applyBody = OD_SRC.slice(OD_SRC.indexOf('export function applyOverlayDepth'));
  check('luApplyDepth 的算式跟 gameview 的 applyOverlayDepth 一致',
    /polygonOffsetFactor = -rank;/.test(applyBody) && /polygonOffsetUnits = -rank \* 2;/.test(applyBody)
    && /polygonOffsetFactor = -rank;/.test(luSection('paper'))
    && /polygonOffsetUnits = -rank \* 2;/.test(luSection('paper')));
}

// ── 強制顯示開關 ──
//
// 這是使用者點名的硬需求:五個真實地點沒有一格五類到齊(playground 更是一個都
// 沒有),所以造型評估必須有辦法在**任何**地點把它們叫出來。
for (const w of ['paper', 'plastic', 'circuit'] as const) {
  check(`${w}: 控制列有「強制地被」那一列,而且五格都列得出來`,
    /key: 'landuse'/.test(SRC[w])
    && demoLu.LU_KINDS.every((k) => new RegExp(`v: '${k}'`).test(SRC[w])));
}
{
  // 開關的解析器切出來跑:'1' → 五格輪流、單格 → 只有那一格、亂填 → 關掉。
  const parse = new Function('search', `
    const location = { search };
    ${sliceStmt(SRC.paper, '  const LU_KINDS = ')}
    ${sliceStmt(SRC.paper, '  const LU_FORCE = ')}
    return LU_FORCE;
  `) as (s: string) => string[] | null;
  check('?landuse=1 → 五格輪流', JSON.stringify(parse('?landuse=1')) === JSON.stringify(demoLu.LU_KINDS));
  check('?landuse=wetland → 只有那一格', JSON.stringify(parse('?landuse=wetland')) === '["wetland"]');
  check('沒給 / =0 / 亂填 → 關掉(三個都要,不然只證明了它會回 null)',
    parse('') === null && parse('?landuse=0') === null && parse('?landuse=zzz') === null);
}

// ── LU_STYLE:三個世界都要供得出五格,而且只有球場會亮 ──
//
// §3.9「決定形體的東西必須同時決定燈」:這五格裡只有球場該亮(夜間照明是真的),
// 其餘四格夜裡都是暗的 —— 「這種東西沒有燈」是完全合法的答案。
for (const w of ['paper', 'plastic', 'circuit'] as const) {
  const outside = SRC[w].replace(luSection(w), '');
  check(`${w}: 有自己的 LU_STYLE(而且不在共用區塊裡)`,
    /const LU_STYLE\s*=\s*\{/.test(outside));
  // 五格都要供得出來。缺一格的話那一格會拿到 undefined 材質,three 會靜靜地畫成
  // 白色 —— 「看起來有東西」而其實沒有人設計過它。
  const missing = demoLu.LU_KINDS.filter((k) => !new RegExp(`['"\`]${k}['"\`]`).test(outside));
  check(`${w}: LU_STYLE 五格都點名了`, missing.length === 0,
    missing.length ? `缺:${missing.join(', ')}` : demoLu.LU_KINDS.join('/'));
}

// ═══════════════════════════════════════════════════════════════════════════
// 6a3. 五格地被移植回 gameview:分派、名次、以及那條新的 hook
// ═══════════════════════════════════════════════════════════════════════════
//
// 上一節比的是「demo 的分派有沒有照抄 gameview」。這一節是**移植落地之後**的反
// 方向:demo 仲裁出來的那個分歧(playground 從球場拆出來)有沒有真的送到
// gameview,以及那條為了「會站起來的東西」新增的 hook 有沒有守住它自己的合約。
//
// ⚠ 名次比的是**順序**不是數字。插一格 playground 讓它以上的八格全部 +1,而
//   `overlay-depth.ts` 自己寫著這張表編碼的是順序(而且必須跟公尺階梯同序)。
//   斷言數字的話,下一次插格就會有人為了讓檢查過而去改 demo。

console.log('\n[landuse port → gameview]');

const LR_NOW = readFileSync('packages/web/src/game/terrain/landuse-renderer.ts', 'utf8');
const OD_NOW = readFileSync('packages/web/src/game/terrain/overlay-depth.ts', 'utf8');

{
  // ── A. 那個分歧真的送到了 ──
  const sportsBody = LR_NOW.slice(LR_NOW.indexOf('function isSportsLanduse'),
    LR_NOW.indexOf('}', LR_NOW.indexOf('function isSportsLanduse')));
  check('gameview 的 isSportsLanduse 不再收 playground —— demo 的分歧送到了',
    !/'playground'/.test(sportsBody) && /'pitch'/.test(sportsBody), sportsBody.trim().split('\n').pop());
  check('…而且它長出了自己的述詞 isPlaygroundLanduse',
    /function isPlaygroundLanduse/.test(LR_NOW) && /'playground'/.test(LR_NOW));
  // 光有述詞不算數 ——「宣告了不等於送得到」。要有一列 spec 真的把它畫出來。
  check('landuse-renderer 有 playground 那一列 spec,而且走自己的材質工廠',
    /kind: 'playground'/.test(LR_NOW)
    && /createPlaygroundMaterial\(\)/.test(LR_NOW)
    && /isPlaygroundLanduse\(f\)/.test(LR_NOW));

  // ── B. 公尺階梯:九格都等於 demo 的 LU_H(含新的那格)──
  const gvOff = (name: string): number | undefined => {
    const m = new RegExp(`const ${name}_HEIGHT_OFFSET = ([\\d.]+);`).exec(LR_NOW);
    return m ? Number(m[1]) : undefined;
  };
  const pairs: [string, string][] = [
    ['water', 'WATER'], ['wetland', 'WETLAND'], ['park', 'PARK'], ['forest', 'FOREST'],
    ['sports', 'SPORTS'], ['playground', 'PLAYGROUND'], ['sand', 'SAND'],
    ['farmland', 'FARMLAND'], ['urban', 'URBAN'],
  ];
  const off = pairs.filter(([k, n]) => gvOff(n) !== demoLu.LU_H[k]);
  check('公尺階梯:gameview 九格一個不差(playground 就是 demo 的 0.0345)',
    off.length === 0,
    off.length ? off.map(([k, n]) => `${k}: gameview ${gvOff(n)} vs demo ${demoLu.LU_H[k]}`).join(', ')
      : `${pairs.length} 格`);

  // ── C. 名次:順序,不是數字 ──
  const rankOrder = (src: string, head: string): string[] => {
    const at = src.indexOf(head);
    const body = src.slice(at, src.indexOf('}', at));
    return [...body.matchAll(/(\w+): (\d+),/g)]
      .map((m) => ({ k: m[1], v: Number(m[2]) })).sort((a, b) => a.v - b.v).map((e) => e.k);
  };
  const gvOrder = rankOrder(OD_NOW, 'export const OVERLAY_RANK = {');
  const demoOrder = Object.entries(demoLu.LU_RANK)
    .sort((a, b) => a[1] - b[1]).map((e) => e[0]);
  const shared = gvOrder.filter((k) => demoLu.LU_RANK[k] !== undefined);
  check('OVERLAY_RANK 的順序跟 demo 的 LU_RANK 一致(九格全部,含 playground)',
    shared.join(',') === demoOrder.join(','),
    `gameview ${shared.join('<')} / demo ${demoOrder.join('<')}`);
  check('…而且 playground 就擠在 sports 正下方(兩格相鄰,球場的線要贏)',
    gvOrder.indexOf('playground') + 1 === gvOrder.indexOf('sports'));
  // overlay-depth.ts 自己寫著「保持跟公尺階梯同一個順序」。這條盯的是 gameview
  // 內部的一致性 —— 公尺那道在近處有效、名次那道在遠處有效,不同序就會在中距離
  // 互相蓋來蓋去。
  const gvByH = pairs.map(([k, n]) => ({ k, v: gvOff(n)! }))
    .sort((a, b) => a.v - b.v).map((e) => e.k);
  check('gameview 自己的公尺階梯與名次階梯同序 —— overlay-depth.ts 明文要求的',
    gvByH.join(',') === shared.join(','), gvByH.join('<'));
}

// ── D–G. 三個世界的 strategy ────────────────────────────────────────────────
const { setNightLitFactor } = await import('@/game/terrain/building-lights');
const LU_FIVE = ['farmland', 'wetland', 'sports', 'playground', 'sand'] as const;
/** demo 說「這一格會站起來」的兩格;其餘三格必須回 null。 */
/** 三個世界共有的兩格。哪幾格「站得起來」其餘部分是逐世界的 —— 見下面的說明。 */
const LU_STANDS = new Set(['playground', 'wetland']);
/** 每個世界的道具用了幾個 InstancedMesh —— 給下面那條全域對照用。 */
const imTotals: { world: string; n: number }[] = [];

for (const world of ['plastic', 'paper', 'circuit'] as const) {
  const st = await createTerrainStyleStrategy(world);

  // D. 五個材質工廠都在,而且球場與遊樂場**不是同一個東西**(拆之前它們就是)。
  const mats: Record<string, THREE.Material> = {
    farmland: st.createFarmlandMaterial(),
    wetland: st.createWetlandMaterial(),
    sports: st.createSportsFieldMaterial(),
    playground: st.createPlaygroundMaterial(),
    sand: st.createSandMaterial(),
  };
  check(`${world}: 五格材質工廠都供得出來`,
    LU_FIVE.every((k) => mats[k] instanceof THREE.Material));
  const mapOf = (m: THREE.Material): unknown => (m as THREE.MeshBasicMaterial).map ?? null;
  check(`${world}: 遊樂場不是球場的複本 —— 拆之前它們畫的就是同一塊板`,
    mapOf(mats.playground) !== mapOf(mats.sports)
    || (mats.playground as THREE.MeshBasicMaterial).color?.getHex()
      !== (mats.sports as THREE.MeshBasicMaterial).color?.getHex(),
    `sports map=${mapOf(mats.sports) ? 'tex' : 'flat'} / playground map=${mapOf(mats.playground) ? 'tex' : 'flat'}`);
  // 三格本來是純色的(plastic 濕地/沙地、paper 沙地)。對**平的**那幾格來說,
  // 貼圖是它們在掠角下唯一的訊號,純色等於沒有答案。
  //
  // ⚠ `playground` **不在這條裡面,而且那是 demo 裁示的**。這條原本收了五格,
  // 而積木的地墊是刻意不印任何圖案的(demo:「地墊一個圖案都不印,連一張 canvas
  // 都不開…唯一活得下來的訊號是剪影」)。遊樂場是五格裡唯一站得起來的那格,它的
  // 識別走 `buildLanduseProps`,不走貼圖 —— 逼它印圖案等於把 demo 的答案推翻,
  // 而 demo 是規格。下面那條改問「它的訊號在不在」,問的是同一件事的正確位置。
  const FLAT_KINDS = LU_FIVE.filter((k) => !LU_STANDS.has(k) || k === 'wetland');
  const flat = FLAT_KINDS.filter((k) => !mapOf(mats[k]));
  check(`${world}: 平的那幾格都有貼圖 —— 純色在騎士眼高(6.3 m 掠角)讀不出東西`,
    flat.length === 0,
    flat.length ? `還是純色:${flat.join(', ')}` : FLAT_KINDS.join('/'));

  // E. 新 hook:兩格站起來、三格回 null,**兩邊都跑**。
  //    只驗「回了東西」的話,一個永遠回 Group 的實作也會過。
  check(`${world}: 宣告了 buildLanduseProps`, typeof st.buildLanduseProps === 'function');
  if (typeof st.buildLanduseProps === 'function') {
    const ctxFor = (kind: string): Parameters<NonNullable<typeof st.buildLanduseProps>>[0] => ({
      kind, centerX: 120, centerZ: -340, radius: 22, slabY: 7.5, rng: mulberry32demo(0x51ee),
    });
    const built: Record<string, THREE.Object3D | null> = {};
    for (const k of LU_FIVE) built[k] = st.buildLanduseProps(ctxFor(k));
    const stands = LU_FIVE.filter((k) => built[k] !== null);
    // ⚠ **哪幾格站得起來是逐世界的,不是通用的。** 第一版這裡寫死了「只有
    // playground 與 wetland」,而電子的 demo 農田要在洞洞板的孔裡插 LED、沙地要
    // 撒錫珠 —— 那條斷言等於把一個抄來的常數當成規格,正是 §0.0 第 5 點禁止的事。
    //
    // 所以只斷言**三個世界共有**的那幾條(它們是這個拆分的定義本身),其餘逐世界
    // 印出來:
    //   sports     → 一律 null。「平的,只有線」就是 B 軸的那一端;它一站起來,
    //                跟 playground 的分野就沒了(而那正是這次拆分的全部理由)。
    //   playground → 一律非 null。它是五格裡唯一准站高的,那是它的識別。
    //   wetland    → 一律非 null。叢生的蘆葦是「不規則」那一端的載體,三個 demo
    //                都給了。
    check(`${world}: 球場一律不站東西 —— 平的+只有線,那是這次拆分的定義`,
      built.sports === null, `sports → ${built.sports ? 'Object3D' : 'null'}`);
    check(`${world}: 遊樂場與濕地一律站得起來`,
      built.playground !== null && built.wetland !== null,
      `站起來的(這個世界):${stands.join('/') || '(無)'}`);
    for (const k of [...LU_STANDS]) {
      const parts = built[k] ? partsOf(built[k]!) : [];
      check(`${world}: ${k} 真的長出東西,而且站在 slabY 之上`,
        parts.length > 0
        && new THREE.Box3().setFromObject(built[k]!).max.y > 7.5 + 0.2,
        `${parts.length} 件,頂 ${new THREE.Box3().setFromObject(built[k] ?? new THREE.Group()).max.y.toFixed(2)} m`);
    }
    // F. 同一塊地兩次呼叫必須完全一樣 —— rng 的種子取自位置,而路線是 seed 驅動的,
    //    同一條路每次騎應該長得一樣。順帶抓「從共用亂數流抽數」那個病。
    const a = st.buildLanduseProps(ctxFor('playground'));
    const b = st.buildLanduseProps(ctxFor('playground'));
    // ⚠ `Box3` has no `toArray()` — an earlier draft called it and threw, which
    // silently truncated everything after it in this file. Read min/max instead.
    const bb = (o: THREE.Object3D | null): string => {
      if (!o) return 'null';
      const b3 = new THREE.Box3().setFromObject(o);
      return JSON.stringify([...b3.min.toArray(), ...b3.max.toArray()].map((v) => +v.toFixed(4)));
    };
    check(`${world}: 同一塊地兩次建出來一模一樣(位置驅動的亂數流)`, bb(a) === bb(b), bb(a));
    // …而且不同位置要不一樣,否則上一條在「完全不看 rng」的實作下也會過。
    const c = st.buildLanduseProps({
      kind: 'playground', centerX: 900, centerZ: 40, radius: 22, slabY: 7.5,
      rng: mulberry32demo(0x99aa),
    });
    check(`${world}: …而換一塊地就不一樣(不是把 rng 整個忽略掉)`, bb(c) !== bb(a));

    // G. dispose 所有權:strategy 擁有的東西必須標 `userData.shared`,不然第一個
    //    被回收的 chunk 會把還在用的貼圖 dispose 掉。這裡直接跑真的回收路徑。
    // three 的 `dispose()` 不留任何旗標(它只是發一個事件),所以「有沒有被
    // dispose」只能**攔下那支方法**來看。跑的是真的回收路徑,不是它的複本。
    const layerMesh = new THREE.Mesh(new THREE.BufferGeometry(), mats.playground);
    if (b) layerMesh.add(b);
    const shared: { name: string; hit: boolean }[] = [];
    layerMesh.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const res: { userData?: Record<string, unknown>; dispose?: () => void }[] = [];
      if (mesh.geometry) res.push(mesh.geometry);
      const m = mesh.material;
      for (const mm of Array.isArray(m) ? m : [m]) if (mm instanceof THREE.Material) res.push(mm);
      for (const r of res) {
        if (!r.userData?.shared || !r.dispose) continue;
        const entry = { name: (r as THREE.Material).type ?? 'geometry', hit: false };
        const real = r.dispose.bind(r);
        r.dispose = () => { entry.hit = true; real(); };
        shared.push(entry);
      }
    });
    // `InstancedMesh` owns a third buffer (`instanceMatrix`) that neither
    // `geometry.dispose()` nor `material.dispose()` frees, and props are made of
    // them. §6 calls this out as the easy miss, so it gets its own spy.
    const ims: { hit: boolean }[] = [];
    layerMesh.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if (!im.isInstancedMesh) return;
      const entry = { hit: false };
      const real = im.dispose.bind(im);
      im.dispose = () => { entry.hit = true; real(); };
      ims.push(entry);
    });
    disposeLanduseMeshes({ layers: [{ kind: 'playground', mesh: layerMesh, count: 1, props: 1 }], lamps: [] });
    // 「有幾個」是逐世界的:電子的道具走它自己的 `luHarvest` 攤平池,所以 per-patch
    // 是裸 Mesh,一個 InstancedMesh 都沒有 —— 那是它的效能答案,不是漏做。所以這條
    // 問的是「在的都放掉了」;至於這條會不會變成三個世界都空著的假斷言,由下面那條
    // 全域對照盯著。
    check(`${world}: 回收時每一個 InstancedMesh 的 instanceMatrix 都放掉了`,
      ims.every((e) => e.hit),
      ims.length ? `${ims.length} 個 InstancedMesh,漏掉 ${ims.filter((e) => !e.hit).length} 個`
        : '這個世界的道具沒有用 InstancedMesh(電子走 luHarvest 攤平池)');
    imTotals.push({ world, n: ims.length });
    const freed = shared.filter((s) => s.hit);
    check(`${world}: 回收一個 chunk,標了 shared 的資源一個都沒被 dispose`,
      freed.length === 0,
      shared.length ? `${shared.length} 個 shared 資源,誤放 ${freed.length} 個` : '這個世界的道具沒有共用資源');
    // 反向對照:同一次走訪裡放一個**沒標** shared 的東西進去,它必須被收掉 ——
    // 不然上面那條在「這支回收器根本不 dispose 任何東西」時也會過。
    {
      const perChunk = new THREE.BufferGeometry();
      let hit = false;
      const real = perChunk.dispose.bind(perChunk);
      perChunk.dispose = () => { hit = true; real(); };
      const m2 = new THREE.Mesh(perChunk, new THREE.MeshBasicMaterial());
      disposeLanduseMeshes({ layers: [{ kind: 'playground', mesh: m2, count: 1, props: 0 }], lamps: [] });
      check(`${world}: …而沒標 shared 的 per-chunk 幾何確實被收掉了(回收器是活的)`, hit);
    }
  }

  // H. 夜:五格地被**一格都不自己發光**。
  //
  // 這一條原本是「只有球場會亮」。使用者裁示改掉的:「球場亮起來很怪(變成一種
  // 招牌),給球場、遊樂場都配一個路燈吧,用路燈的燈去點亮他們」—— 而 demo 已經
  // 改完(三份都寫了「球場**不自己發光**」)。一整片地面自己亮讀出來是**招牌**,
  // 招牌是別的元件的身分(§3.3),而且那正是 §3.10「小、在裡面、被半透明的殼
  // 包著」的反面。
  //
  // **不是把舊斷言刪掉**:條件從「只有一格」收到「一格都沒有」是更嚴的,而它原本
  // 的反向對照(那支開關推得動球場)剛好也失效了,所以下面換一條更強的 —— 證明
  // `setNightLitFactor` 在**這個世界**真的推得動東西,而那東西不是地被。
  const emissiveOf = (m: THREE.Material): number =>
    ((m as THREE.MeshPhongMaterial).emissive?.getHex() ?? -1);
  setNightLitFactor(0);
  const day = Object.fromEntries(LU_FIVE.map((k) => [k, emissiveOf(mats[k])]));
  setNightLitFactor(1);
  const night = Object.fromEntries(LU_FIVE.map((k) => [k, emissiveOf(mats[k])]));
  setNightLitFactor(0);
  const lit = LU_FIVE.filter((k) => day[k] !== night[k]);
  check(`${world}: 夜裡五格地被一格都不自己發光(球場的光在場邊那盞路燈上)`,
    lit.length === 0,
    lit.length ? `還會亮的:${lit.join('/')}` : `五格都不動(sports ${day.sports})`);
  // …而且不是「材質根本沒有 emissive 這個欄位」蒙混過去的。球場一定要有那個欄位、
  // 而且白天是純黑 —— 只要哪天有人把 emissiveMap 掛回去,顏色一乘就看得出來。
  check(`${world}: …球場材質有 emissive 欄位而且是純黑(不是欄位不存在混過去的)`,
    emissiveOf(mats.sports) === 0x000000,
    `sports.emissive = ${emissiveOf(mats.sports) < 0 ? '(沒有這個欄位)' : '#' + day.sports.toString(16).padStart(6, '0')}`);
  // 反向對照:上面兩條在「setNightLitFactor 根本沒接上這個世界」時也會過(五格
  // 本來就不動)。所以拿這個世界**建築**的夜燈當活體證明 —— 每個世界至少有一個
  // 建築零件的材質會被那支開關推動。
  {
    const probeBox = {
      cx: 0, cz: 0, width: 16, depth: 12, rotY: 0,
      height: 24, baseY: 0, skirt: 1.5, color: 0xcccccc,
    } as never;
    const emissives: THREE.Color[] = [];
    for (const zone of ['residential', 'commercial', 'industrial', 'school', 'hospital'] as const) {
      const deco = st.buildBuildingDecoration(probeBox, 5, zone as never);
      deco?.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m instanceof THREE.Material && (m as THREE.MeshPhongMaterial).emissive) {
          emissives.push((m as THREE.MeshPhongMaterial).emissive);
        }
      });
    }
    setNightLitFactor(0);
    const dk = emissives.map((c) => c.getHex());
    setNightLitFactor(1);
    const moved = emissives.filter((c, i) => c.getHex() !== dk[i]).length;
    setNightLitFactor(0);
    check(`${world}: …而那支開關在這個世界真的推得動東西(建築的夜燈,不是地被)`,
      moved > 0, `${moved}/${emissives.length} 個建築材質跟著夜色動`);
  }

  for (const k of LU_FIVE) if (!mats[k].userData?.shared) mats[k].dispose();
  st.dispose();
}

// ── I. 種子真的取自位置 —— 走**真的** buildLanduseMeshes,不是我自己餵的 ctx ──
//
// 上面那兩條(同一塊地一樣 / 換一塊地不一樣)驗的是 **strategy** 拿到 rng 之後的
// 決定性,因為 ctx 是這個檔案自己組的。突變測試抓到了那個洞:把 landuse-renderer
// 的種子改成常數 `0x1234`,那兩條一聲不吭 —— 它們從來沒有經過那一行。
//
// 所以這一段跑真的 `buildLanduseMeshes`:兩塊**不同位置**的遊樂場必須長得不一樣,
// 而同一塊地重建兩次必須逐位元組一致(路線是 seed 驅動的,同一條路每次騎應該一樣)。
{
  console.log('\n[landuse props: 種子取自位置]');
  const flatSampler = {
    getElevationSync: () => 0,
    getElevation: async () => 0,
  } as unknown as Parameters<typeof buildLanduseMeshes>[1];
  /** 一塊邊長 ~90 m 的正方形遊樂場,中心在 (lon, lat)。 */
  const pad = (lon: number, lat: number): unknown => ({
    layer: 'landuse',
    properties: { class: 'playground' },
    geometry: {
      type: 'Polygon',
      coordinates: [[[lon - 4e-4, lat - 4e-4], [lon + 4e-4, lat - 4e-4],
        [lon + 4e-4, lat + 4e-4], [lon - 4e-4, lat + 4e-4], [lon - 4e-4, lat - 4e-4]]],
    },
  });
  const propsBox = async (
    st: Awaited<ReturnType<typeof createTerrainStyleStrategy>>, lon: number, lat: number,
  ): Promise<string> => {
    const res = await buildLanduseMeshes(
      [pad(lon, lat)] as never, flatSampler, 25, 121, 0, st,
    );
    const layer = res.layers.find((l) => l.kind === 'playground')!;
    const b3 = new THREE.Box3();
    for (const c of layer.mesh.children) b3.union(new THREE.Box3().setFromObject(c));
    // ⚠ **Relative to the patch centre, not absolute.** The first version compared
    // absolute boxes, and a mutation walked straight through it: pinning the
    // renderer's seed to a constant still moved the box, because the props are
    // laid out around `centerX/centerZ` and the two patches are in different
    // places. Subtracting the centre leaves only the SHAPE, which is the thing
    // the seed decides. (The §6.3 "two implementations equal at shipped numbers"
    // family — the fifth one this session.)
    const px = (lon - 121) * 111320 * Math.cos((25 * Math.PI) / 180);
    const pz = -(lat - 25) * 111320;
    const rel = (v: THREE.Vector3): number[] => [v.x - px, v.y, v.z - pz];
    const out = layer.mesh.children.length
      ? JSON.stringify([...rel(b3.min), ...rel(b3.max)].map((v) => +v.toFixed(3)))
      : 'no props';
    disposeLanduseMeshes(res);
    return out;
  };
  for (const world of ['plastic', 'paper', 'circuit'] as const) {
    const st = await createTerrainStyleStrategy(world);
    const a1 = await propsBox(st, 121.0, 25.0);
    const a2 = await propsBox(st, 121.0, 25.0);
    const b1 = await propsBox(st, 121.006, 25.004);
    check(`${world}: 同一塊地重建兩次,道具逐項相同`, a1 === a2 && a1 !== 'no props', a1);
    check(`${world}: 換一個位置就換一組道具 —— 種子取自 patch 的座標`,
      b1 !== a1 && b1 !== 'no props', b1);
    st.dispose();
  }
}

// 上面那條「在的都放掉了」在三個世界都沒有 InstancedMesh 的情況下會全部空過。
// 這條是它的對照:至少要有人真的用了,不然那條斷言等於沒有。
check('至少有一個世界的地被道具真的用了 InstancedMesh(不然上面三條是空的)',
  imTotals.some((t) => t.n > 0),
  imTotals.map((t) => `${t.world} ${t.n}`).join(' / '));

// ═══════════════════════════════════════════════════════════════════════════
// 6a4. 球場 / 遊樂場那盞燈 —— **落到 gameview 之後**
// ═══════════════════════════════════════════════════════════════════════════
//
// `street-lamp-vs-demo.ts` 的「地被的燈」那一節驗的是 **demo 那一半**:三份 demo
// 的派工逐字相同、id 是 seed、走的是既有的路燈。這一節是另外一半 —— 那段程式碼
// **真的送到 gameview 了嗎**,而且送到的是同一個答案嗎。
//
// 主斷言只有一句話:**同一座球場,整段騎乘裡永遠是同一盞燈。**
//
// 為什麼這句話是主角:池是滑動的,`street-lamp.ts` 的 `poolIndexFor` 存在的全部
// 理由就是「把燈的顏色綁在陣列位置上 → 站在同一個地點的燈每 70 m 換一次色」,那是
// 使用者實騎回報、2427d86 修掉的 bug。地被的燈只要拿「這塊地是這個 chunk 的第幾
// 塊」當身分,同一個病就會換一個形狀回來 —— 而且更難看見,因為 chunk 的地物陣列
// 順序會隨圖磚視窗、擁有權、上游多一個多邊形而重新編號。
//
// ⚠ 所以下面每一條身分斷言都跑**兩個方向**:綁 seed 的預測值要對得上,而綁陣列
//   索引的預測值要**對不上**。兩個實作在這組資料上先分得開,那一條才不是空的
//   (DEMO_POC_GUIDE §6.3;這個 session 已經抓到六次「兩種實作在出貨數字下等價」)。
{
  console.log('\n[landuse lamp → gameview]');

  const streetLamp = await import('@/game/terrain/street-lamp');

  // ── demo 端的兩個數字:**切出來執行 / 讀出來**,一個都不打進這個檔案 ──
  const demoLampSpec = (() => {
    const lu = luSection('paper');
    const seedSrc = /const seed = [^;]+;/.exec(lu)?.[0] ?? '';
    const seedOf = seedSrc
      ? (new Function('info', `${seedSrc} return seed;`) as (i: { cx: number; cz: number }) => number)
      : null;
    const boards = (['paper', 'plastic', 'circuit'] as const)
      .map((w) => Number(/const boardW = (\d+);/.exec(SRC[w])?.[1]));
    return { seedOf, seedSrc, boards };
  })();
  check('demo 的 seed 運算式切得出來而且跑得動',
    !!demoLampSpec.seedOf && demoLampSpec.seedOf({ cx: 12.3, cz: -45.6 }) > 0,
    demoLampSpec.seedSrc.slice(0, 80));
  check('三份 demo 的 boardW 一樣(走廊寬度是共用區塊的東西)',
    demoLampSpec.boards.every((b) => b === demoLampSpec.boards[0] && b > 0),
    `boardW = ${demoLampSpec.boards.join('/')}`);
  const demoSeedOf = demoLampSpec.seedOf!;
  const demoHalfW = demoLampSpec.boards[0] / 2;

  // gameview 的走廊常數必須**就是** demo 的 boardW / 2 —— 讀出來比,不抄。
  const gvHalf = Number(/const LAMP_CORRIDOR_HALF_M = ([\d.]+);/.exec(LR_NOW)?.[1]);
  check('gameview 的燈走廊 = demo 的 boardW / 2(是 demo 的數字,不是新旋鈕)',
    gvHalf === demoHalfW, `gameview ${gvHalf} vs demo ${demoLampSpec.boards[0]} / 2 = ${demoHalfW}`);
  // …而且它只管燈:板子的範圍是 gameview 自己的走廊,這一段不准動到它。
  // 註解不算數(`street-lamp-vs-demo` 的 codeOf 同一招 —— 有東西靠一段長註解騙過
  // 人兩次),所以先把註解剝掉再數:剩下的只能是「宣告」加「那一道閘門」。
  //
  // ⚠ 逐行濾,**不要**用 `/\/\*[\s\S]*?\*\//` 那一招:這個檔案的註解裡寫著
  //   `plan/*-town-demo.html`,那個 `/*` 會開一段假的區塊註解,一路吃到下一個
  //   JSDoc 的結尾 —— 連要數的那行程式碼一起吃掉,而斷言只會說「少了一次」。
  const lrCode = LR_NOW.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('…而且那道閘門只掛在燈上(五格的 spec 一列都沒有它)',
    (lrCode.match(/LAMP_CORRIDOR_HALF_M/g) || []).length === 2
    && /if \(near && dl > LAMP_CORRIDOR_HALF_M \+ p\.radius\) continue;/.test(lrCode),
    `程式碼裡出現 ${(lrCode.match(/LAMP_CORRIDOR_HALF_M/g) || []).length} 次(宣告 + 那一道閘門)`);

  // ── 一塊地被多邊形。lat 25 那條線就是路線,所以 z = 0 是路中心 ──
  const ORIGIN_LAT = 25, ORIGIN_LON = 121;
  const COS = Math.cos((ORIGIN_LAT * Math.PI) / 180);
  const HALF_DEG = 2e-4;                       // ±22 m,radius ≈ 31.5 m
  const KINDCLS: Record<string, [string, string]> = {
    sports: ['landuse', 'pitch'],
    playground: ['landuse', 'playground'],
    farmland: ['landcover', 'farmland'],
    wetland: ['landcover', 'wetland'],
    sand: ['landcover', 'sand'],
  };
  // ⚠ 環**不閉合**(四個點,不重複第一個)。gameview 的重心是「座標表的平均」,
  //   而真實 MVT 的環是閉合的 —— 重複的那一個頂點會把重心往那個角拉 1/n。這裡要
  //   量的是擺燈的規則,不是那個既有的偏差,所以樣本給四個點,重心就是正中央。
  const poly = (kind: string, lon: number, lat: number, h = HALF_DEG): unknown => {
    const [layer, cls] = KINDCLS[kind];
    return {
      layer,
      properties: { class: cls },
      geometry: {
        type: 'Polygon',
        coordinates: [[[lon - h, lat - h], [lon + h, lat - h],
          [lon + h, lat + h], [lon - h, lat + h]]],
      },
    };
  };
  const toX = (lon: number): number => (lon - ORIGIN_LON) * 111320 * COS;
  const toZ = (lat: number): number => -(lat - ORIGIN_LAT) * 111320;
  /**
   * demo 的雜湊,餵**全球**公尺。
   *
   * demo 一頁只有一個原點,所以它拿 `info.cx`(離那個原點的公尺)當身分沒有問題;
   * gameview 的原點是**這條路線的第一個點**,於是同一座球場在每一條經過它的路線
   * 上都是不同的種子 —— 不同的燈色、不同的道具。`geo-seed.ts` 換掉的只有座標系
   * (改成從 (0°, 0°) 起算),雜湊本身還是下面 `demoSeedOf` 從 demo 切出來執行的
   * 那一行。這裡的兩個轉換是**這個檔案自己寫的**,不從 gameview import,不然這條
   * 就變成 gameview 跟自己比。
   */
  const toGX = (lon: number, lat: number): number =>
    lon * 111320 * Math.cos((lat * Math.PI) / 180);
  const toGZ = (lat: number): number => -lat * 111320;
  const seedAt = (lon: number, lat: number): number =>
    demoSeedOf({ cx: toGX(lon, lat), cz: toGZ(lat) });
  const flatSampler2 = {
    getElevationSync: () => 0,
    getElevation: async () => 0,
  } as unknown as Parameters<typeof buildLanduseMeshes>[1];
  /** 路線 = lat 25 那條線,所以最近的路點永遠是同一個 x、z = 0。 */
  const HOOKS = {
    ground: (_x: number, _z: number) => 0,
    routePointNear: (x: number, _z: number) => ({ x, z: 0 }),
  };
  const build = (
    st: Awaited<ReturnType<typeof createTerrainStyleStrategy>>, feats: unknown[],
  ): ReturnType<typeof buildLanduseMeshes> => buildLanduseMeshes(
    feats as never, flatSampler2, ORIGIN_LAT, ORIGIN_LON, 0, st, undefined, HOOKS,
  );
  /** 一盞燈看得見的身分:那顆 PointLight 的顏色(setNight 只動 intensity)。 */
  const lampHue = (parts: { group: THREE.Object3D }): number => {
    let hex = -1;
    parts.group.traverse((o) => {
      const l = o as unknown as THREE.PointLight;
      if (l.isPointLight) hex = l.color.getHex();
    });
    return hex;
  };

  for (const world of ['plastic', 'paper', 'circuit'] as const) {
    const st = await createTerrainStyleStrategy(world);

    // ── A. 只有那兩格配到燈,而且一塊地一盞 ──
    {
      const feats = Object.keys(KINDCLS).map((k, i) => poly(k, ORIGIN_LON + i * 1e-3, 25.0003));
      const res = await build(st, feats);
      const withLamp = res.layers
        .filter((l) => l.mesh.children.some((c) => {
          let hit = false;
          c.traverse((o) => { if ((o as unknown as THREE.PointLight).isPointLight) hit = true; });
          return hit;
        }))
        .map((l) => l.kind).sort();
      check(`${world}: 五格地被裡只有球場與遊樂場配到燈`,
        withLamp.join(',') === 'playground,sports' && res.lamps.length === 2,
        `有燈的:${withLamp.join('/') || '(無)'} · lamps ${res.lamps.length}`);
      // 反向對照:剩下三格一盞都沒有 —— 「這種東西沒有燈」是 §3.9 的合法答案,
      // 而它必須是**量出來的**,不是「上面那條沒說到它們」。
      check(`${world}: 農田 / 濕地 / 沙地夜裡一盞燈都沒有(§3.9 的合法答案)`,
        ['farmland', 'wetland', 'sand'].every((k) => !withLamp.includes(k)));
      streetLamp.setFixedLampNight(0);
      disposeLanduseMeshes(res);
    }

    // ⚠ 先挑一個「兩種實作分得開」的地點。
    //
    // 每個世界的調色盤長度不同(4 / 3 / 4),所以「綁 seed」與「綁陣列位置 0」在
    // 某些地點會**碰巧撞到同一個顏色** —— 第一版就撞了:瓦楞紙的三色盤遇上一個
    // 種子 2714469051(可以被 3 整除),兩種實作給出同一盞燈,那條斷言變成空的。
    // 這正是 §6.3 那一族。所以地點是**找**出來的,而且找不到就當場失敗。
    const pickLon = ((): number => {
      const zero = ((): number => {
        const l = st.buildStreetLamp(0);
        const h = lampHue(l); l.dispose(); return h;
      })();
      for (let i = 0; i < 24; i++) {
        const lon = ORIGIN_LON + 0.0004 + i * 3.1e-4;
        const ref = st.buildStreetLamp(seedAt(lon, 25.0003));
        const h = lampHue(ref);
        ref.dispose();
        if (h !== zero) return lon;
      }
      return NaN;
    })();
    check(`${world}: 找得到一個「綁 seed」與「綁陣列位置」分得開的地點`,
      Number.isFinite(pickLon), `lon = ${pickLon}`);

    // ── B. 那盞燈就是這個世界既有的路燈,而 id 是 demo 那個 seed ──
    //
    // 比的是**整份幾何**:把參考燈搬到場上那盞的位置,再逐三角形比 world tri 流。
    // 只比顏色的話,一個「自己另外刻一盞、剛好挑了同一個色」的實作也會過。
    {
      const P_LON = pickLon, P_LAT = 25.0003;
      const res = await build(st, [poly('sports', P_LON, P_LAT)]);
      const got = res.lamps[0];
      const cx = toX(P_LON), cz = toZ(P_LAT);
      const wantSeed = seedAt(P_LON, P_LAT);
      const ref = st.buildStreetLamp(wantSeed);
      ref.group.position.copy(got.group.position);
      ref.group.rotation.copy(got.group.rotation);
      const a = triStream(partsOf(ref.group));
      const b = triStream(partsOf(got.group));
      check(`${world}: 場邊那盞就是 buildStreetLamp(seed) —— 逐三角形相同,沒有第二套燈`,
        a.length > 0 && a.join('|') === b.join('|'),
        a.join('|') === b.join('|') ? `${a.length} 個三角形` : firstDiff(a, b));
      // 站的位置:demo 的 `centre + unit(route − centre) · r`,而路線在 z = 0,
      // 所以燈落在這塊地**朝路那一側**的邊上,高度走 ground()。
      const layer = res.layers.find((l) => l.kind === 'sports')!;
      const patchR = Math.hypot(toX(P_LON + HALF_DEG) - cx, toZ(P_LAT + HALF_DEG) - cz);
      const p = got.group.position;
      check(`${world}: 燈站在朝路那一側的邊上(demo 的 centre + unit(route−centre)·r)`,
        Math.abs(p.x - cx) < 1e-6 && Math.abs(p.z - (cz + patchR)) < 1e-3 && p.y === 0,
        `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) vs 期望 (${cx.toFixed(2)}, 0, ${(cz + patchR).toFixed(2)})`);
      check(`${world}: …而且它掛在那一格的板子底下(rebase / 回收才跟得上)`,
        got.group.parent === layer.mesh);

      // ⚠ 兩個方向。先證明兩種實作在這組資料上分得開,再證明 gameview 拿的是 seed。
      const bySeed = lampHue(ref);
      const idxRef = st.buildStreetLamp(0);          // 綁「這個 chunk 的第 0 塊」
      const byIndex = lampHue(idxRef);
      check(`${world}: (綁 seed 與綁池索引在這組資料上真的分得開 —— 不然下一條是空的)`,
        bySeed !== byIndex && bySeed >= 0,
        `seed ${wantSeed} → #${bySeed.toString(16)} / index 0 → #${byIndex.toString(16)}`);
      check(`${world}: 那盞燈的身分是 seed,不是它在陣列裡的位置`,
        lampHue(got) === bySeed && lampHue(got) !== byIndex,
        `場上 #${lampHue(got).toString(16)}`);
      idxRef.dispose();
      ref.dispose();
      streetLamp.setFixedLampNight(0);
      disposeLanduseMeshes(res);
    }

    // ── C. 主斷言:同一座球場,整段騎乘裡永遠是同一盞燈 ──
    //
    // 「騎乘」在 gameview 裡對這塊地是這些事:chunk 被回收再蓋、圖磚視窗換了一批
    // 鄰居、地物解碼順序不同、擁有權把別的多邊形分給別的 chunk。**每一種都會把
    // 它在陣列裡的位置換掉**,而它的位置一格都沒動。
    {
      const P_LON = pickLon, P_LAT = 25.0003;
      const me = poly('sports', P_LON, P_LAT);
      const other = (i: number): unknown => poly('sports', ORIGIN_LON + 0.012 + i * 6e-4, 25.0002);
      const play = poly('playground', ORIGIN_LON - 0.001, 25.00025);
      const windows: [string, unknown[]][] = [
        ['單獨一塊', [me]],
        ['前面多兩塊', [other(0), other(1), me]],
        ['後面多兩塊', [me, other(0), other(1)]],
        ['夾在中間 + 別的格', [other(0), play, me, other(1)]],
        ['整個倒過來', [other(1), me, other(0)].reverse()],
        ['重蓋一次', [me]],
      ];
      const seen: { how: string; hue: number; idx: number }[] = [];
      for (const [how, feats] of windows) {
        const res = await build(st, feats);
        const mine = res.lamps.find((l) =>
          Math.abs(l.group.position.x - toX(P_LON)) < 0.5);
        seen.push({
          how,
          hue: mine ? lampHue(mine) : -1,
          idx: res.lamps.indexOf(mine!),
        });
        streetLamp.setFixedLampNight(0);
        disposeLanduseMeshes(res);
      }
      const hues = new Set(seen.map((s) => s.hue));
      const idxs = new Set(seen.map((s) => s.idx));
      check(`${world}: 同一座球場在六種 chunk 視窗下永遠是同一盞燈`,
        hues.size === 1 && !hues.has(-1),
        seen.map((s) => `${s.how}:#${s.hue.toString(16)}`).join(' '));
      // …而它在陣列裡的位置**真的**變過。沒變過的話上面那條什麼都沒證明。
      check(`${world}: (而它在陣列裡的位置在這六次裡真的動過 —— 不然上一條是空的)`,
        idxs.size > 1, `陣列位置:${[...idxs].join('/')}`);
      // 反向對照:換一塊**別的地**要換一盞燈,不然「永遠同一盞」在「全世界只有
      // 一種燈」的實作下也會過。四色調色盤,所以拿一排位置去問。
      const spread = new Set<number>();
      for (let i = 0; i < 8; i++) {
        const res = await build(st, [poly('sports', ORIGIN_LON + i * 7e-4, 25.0003)]);
        spread.add(lampHue(res.lamps[0]));
        streetLamp.setFixedLampNight(0);
        disposeLanduseMeshes(res);
      }
      check(`${world}: …而八個不同地點拿到的不是同一盞(調色盤真的被 seed 攤開)`,
        spread.size > 1, `${spread.size} 種顏色`);
    }

    // ── C2. 同一塊地,**換一條路線**還是同一盞燈、同一批道具 ──
    //
    // C 那一節換的是 chunk 視窗;這一節換的是**原點**,而那是 C 看不見的一整類:
    // gameview 的原點是「這條路線的第一個點」,`TerrainChunkManager.updateOrigin`
    // 還會在騎乘中把它重設一次。種子如果是「離原點幾公尺」,同一塊地在每一條
    // 經過它的路線上就是不同的燈、不同的道具 —— 而 demo 永遠問不到這件事,因為
    // demo 一頁只有一個原點(`plan/DEMO_POC_GUIDE.md` §2 case A)。
    //
    // ⚠ 兩個方向。先證明**舊規則(綁原點相對公尺)在這兩個原點上真的會給不同的
    //   燈**,再證明現在的實作給同一盞。少了前半條,一個「全世界只有一盞燈」的
    //   實作也會過。
    //
    // ⚠ 第二個原點只動**經度**。動緯度的話 `cosOrigin` 跟著變(cos 24.96 / cos 25
    //   差 3e-4),整個局部公尺座標系是縮放而不是平移,道具的頂點在 4 km 外差到
    //   1.3 m —— 那是投影的假差,不是種子的差,量它只會把這條斷言變成量測噪音。
    //   種子本身吃的是這塊地自己的經緯度,跟原點的緯度無關。
    {
      const P_LAT = 25.0003;
      const P_LON = ORIGIN_LON + 0.004;
      const hueOf = (seed: number): number => {
        const l = st.buildStreetLamp(seed);
        const h = lampHue(l);
        l.dispose();
        return h;
      };
      /** 舊規則:同一個 demo 雜湊,但吃的是離**那個原點**的公尺。 */
      const oldSeedFrom = (oLon: number): number => demoSeedOf({
        cx: (P_LON - oLon) * 111320 * COS,
        cz: -(P_LAT - ORIGIN_LAT) * 111320,
      });
      // ⚠ 第二個原點是**找**出來的,理由跟 `pickLon` 一模一樣:三個世界的調色盤
      //   長度不同(4 / 3 / 4),隨手挑一個原點會撞色 —— 第一版挑了西南 0.05°,
      //   瓦楞紙的三色盤在那兩個種子(2758577808 / 4095224667)上剛好給同一支
      //   螢光筆,那條「舊規則會給不同的燈」的前置斷言就變成空的,而它一空,
      //   底下整段就什麼都沒證明。找不到就當場失敗。
      const here = hueOf(oldSeedFrom(ORIGIN_LON));
      const altLon = ((): number => {
        for (let i = 1; i <= 40; i++) {
          const lon = ORIGIN_LON - i * 0.01;
          if (hueOf(oldSeedFrom(lon)) !== here) return lon;
        }
        return NaN;
      })();
      check(`${world}: 找得到一個「舊規則會換一盞燈」的第二原點`,
        Number.isFinite(altLon), `原點經度 ${altLon}`);
      const ALT_LON = Number.isFinite(altLon) ? altLon : ORIGIN_LON - 0.05;

      const oldSeedA = oldSeedFrom(ORIGIN_LON);
      const oldSeedB = oldSeedFrom(ALT_LON);
      check(`${world}: (舊規則在這兩個原點上真的給不同的燈 —— 不然下一條是空的)`,
        oldSeedA !== oldSeedB && hueOf(oldSeedA) !== hueOf(oldSeedB),
        `原點相對公尺 → seed ${oldSeedA} #${hueOf(oldSeedA).toString(16)} `
        + `vs ${oldSeedB} #${hueOf(oldSeedB).toString(16)}`);

      // 用**遊樂場**,不是球場:五格裡只有它會站起來(`buildLanduseProps`),而
      // 種子餵的是燈**和**道具兩條線 —— 拿球場量的話 props 恆為 0,那半條斷言
      // 就是一句恆真句(第一版真的印出「props 0 vs 0」)。
      //
      // 比的是**世界頂點**,不是每一件的世界變換:電子世界的遊樂場把座標烘進
      // 頂點裡(那三件的 group 留在原點),比變換的話它在兩個原點下都是 0,
      // 減掉中心之後反而變成兩個不同的值 —— 一條會誤報的斷言。
      const propVerts = (
        r: Awaited<ReturnType<typeof buildLanduseMeshes>>, cx: number, cz: number,
      ): number[] => {
        const mesh = r.layers.find((l) => l.kind === 'playground')!.mesh;
        // 燈自己不算 —— 上面那條已經逐三角形比過,而它的幾何現在是共用的。
        const lamps = new Set(r.lamps.map((l) => l.group));
        const v = new THREE.Vector3();
        const out: number[] = [];
        for (const child of mesh.children) {
          if (lamps.has(child)) continue;
          for (const part of partsOf(child)) {
            const pos = part.geo.getAttribute('position') as THREE.BufferAttribute;
            for (let i = 0; i < pos.count; i++) {
              v.fromBufferAttribute(pos, i).applyMatrix4(part.m);
              out.push(v.x - cx, v.y, v.z - cz);
            }
          }
        }
        return out;
      };
      const maxGap = (a: number[], b: number[]): number => {
        if (a.length !== b.length || a.length === 0) return Infinity;
        let g = 0;
        for (let i = 0; i < a.length; i++) g = Math.max(g, Math.abs(a[i] - b[i]));
        return g;
      };

      const resA = await build(st, [poly('playground', P_LON, P_LAT)]);
      const hueA = lampHue(resA.lamps[0]);
      const vertsA = propVerts(resA, toX(P_LON), toZ(P_LAT));
      streetLamp.setFixedLampNight(0);
      disposeLanduseMeshes(resA);

      const resB = await buildLanduseMeshes(
        [poly('playground', P_LON, P_LAT)] as never, flatSampler2, ORIGIN_LAT, ALT_LON, 0, st,
        undefined,
        // 路線跟著原點走,不然這塊地會掉出走廊 —— 換的是原點,不是這塊地離路多遠。
        { ground: () => 0, routePointNear: (x: number, z: number) => ({ x, z }) },
      );
      const hueB = lampHue(resB.lamps[0]);
      const vertsB = propVerts(resB, (P_LON - ALT_LON) * 111320 * COS, toZ(P_LAT));
      streetLamp.setFixedLampNight(0);
      disposeLanduseMeshes(resB);

      check(`${world}: 換一個原點(= 換一條路線)之後還是同一盞燈`,
        hueA === hueB && resA.lamps.length === 1 && resB.lamps.length === 1,
        `#${hueA.toString(16)} vs #${hueB.toString(16)}`);
      // 種子餵的是**兩件事**:燈,還有道具流。兩件都要跟著地走。
      check(`${world}: …而那塊地站起來的東西一根頂點都沒動(seed 餵的是燈和道具兩條線)`,
        vertsA.length > 0 && maxGap(vertsA, vertsB) < 1e-3,
        `${vertsA.length / 3} 個頂點,最大差 ${maxGap(vertsA, vertsB).toExponential(1)} m`);
      // 反向對照:頂點要真的跟著 seed 動,不然上一條在「全世界的遊樂場都一樣」
      // 的實作下也會過。
      {
        let worst = 0;
        let base: number[] | null = null;
        for (let i = 0; i < 10; i++) {
          const lon = ORIGIN_LON + i * 9e-4;
          const r = await build(st, [poly('playground', lon, P_LAT)]);
          const vs = propVerts(r, toX(lon), toZ(P_LAT));
          if (base) worst = Math.max(worst, Math.min(maxGap(base, vs), 1e6));
          else base = vs;
          streetLamp.setFixedLampNight(0);
          disposeLanduseMeshes(r);
        }
        check(`${world}: (而那些頂點真的隨地點動 —— 不然上一條是空的)`,
          worst > 0.5, `十個地點,離第一個最遠 ${worst.toFixed(2)} m`);
      }
      // 而且它就是 demo 的雜湊吃全球公尺算出來的那一盞 —— 不是「碰巧兩邊都一樣」。
      check(`${world}: …而那盞燈就是 demo 的雜湊吃全球公尺算出來的那一盞`,
        hueA === hueOf(seedAt(P_LON, P_LAT)),
        `seed ${seedAt(P_LON, P_LAT)} → #${hueOf(seedAt(P_LON, P_LAT)).toString(16)}`);
    }

    // ── D. 走廊閘門:兩個方向 ──
    {
      // 門檻是 65 + r,而這塊地的 r ≈ 30,所以三個樣本:路邊的 30 m、**剛好在
      // 門檻裡面**的 90 m、剛好在外面的 150 m。兩個貼著門檻的樣本是重點 ——
      // 只有 30 / 400 那種極端組合的話,把 65 改成 20 或 200 都照樣會過。
      const at = (m: number): number => ORIGIN_LAT + m / 111320;
      const rIn = await build(st, [poly('sports', ORIGIN_LON, at(30))]);
      const rEdge = await build(st, [poly('sports', ORIGIN_LON, at(90))]);
      const rOut = await build(st, [poly('sports', ORIGIN_LON, at(150))]);
      check(`${world}: 30 m / 90 m 的球場有燈,150 m 的沒有(demo 的 boardW 走廊)`,
        rIn.lamps.length === 1 && rEdge.lamps.length === 1 && rOut.lamps.length === 0,
        `30 m → ${rIn.lamps.length} · 90 m → ${rEdge.lamps.length} · 150 m → ${rOut.lamps.length}`);
      // …而板子兩邊都還在。閘門只收燈,不准連地一起收掉。
      const slab = (r: Awaited<ReturnType<typeof buildLanduseMeshes>>): number =>
        r.layers.find((l) => l.kind === 'sports')!.mesh.geometry.getAttribute('position')?.count ?? 0;
      check(`${world}: …而兩塊地的板子都還在(閘門只掛在燈上)`,
        slab(rIn) > 0 && slab(rOut) === slab(rIn), `${slab(rIn)} vs ${slab(rOut)} 個頂點`);
      streetLamp.setFixedLampNight(0);
      disposeLanduseMeshes(rIn);
      disposeLanduseMeshes(rEdge);
      disposeLanduseMeshes(rOut);
    }

    // ── E. 夜:那盞燈**真的**被那支開關推得動,而且推的是 setNight ──
    //
    // 上面 H 那一節證明的是「五格地被一格都不自己發光」。那條在「燈也不會亮」時
    // 一樣會過 —— 那正是現在這條要補的洞:球場的夜間照明從此**全部**在這盞燈上。
    {
      const res = await build(st, [poly('sports', ORIGIN_LON, 25.0003)]);
      const lamp = res.lamps[0];
      let light: THREE.PointLight | null = null;
      lamp.group.traverse((o) => {
        if ((o as unknown as THREE.PointLight).isPointLight) light = o as unknown as THREE.PointLight;
      });
      streetLamp.setFixedLampNight(0);
      const dayI = (light as unknown as THREE.PointLight).intensity;
      const dayVis = (light as unknown as THREE.PointLight).visible;
      streetLamp.setFixedLampNight(1);
      const nightI = (light as unknown as THREE.PointLight).intensity;
      const nightVis = (light as unknown as THREE.PointLight).visible;
      streetLamp.setFixedLampNight(0);
      check(`${world}: 球場那盞燈白天是暗的、夜裡是亮的(照明全在這一盞上)`,
        !!light && dayI === 0 && !dayVis && nightI > 0 && nightVis,
        `intensity ${dayI} → ${nightI} · visible ${dayVis} → ${nightVis}`);
      // 而且它是**登記進去**的,不是這個檔案自己戳的:註冊簿裡真的多了一盞。
      check(`${world}: …而它是登記進 street-lamp 的註冊簿的(所以每一幀都收得到夜色)`,
        streetLamp.fixedLampCount() === 1, `${streetLamp.fixedLampCount()} 盞在簿子上`);

      // ── F. 回收:註冊簿要放掉,燈要 dispose ──
      let disposed = false;
      const real = lamp.dispose.bind(lamp);
      (lamp as { dispose: () => void }).dispose = () => { disposed = true; real(); };
      disposeLanduseMeshes(res);
      check(`${world}: 回收一個 chunk,燈從註冊簿上消失而且自己 dispose 過`,
        disposed && streetLamp.fixedLampCount() === 0,
        `dispose ${disposed} · 簿子剩 ${streetLamp.fixedLampCount()}`);
    }
    st.dispose();
  }
}

/** demo 的 mulberry32,拿來餵 hook 的 ctx。 */
function mulberry32demo(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 6b. GEO 區塊是**照抄**的,不是重寫的
// ═══════════════════════════════════════════════════════════════════════════
//
// This is a port in the OTHER direction — gameview → demo — and §0.0 rule 1
// applies unchanged: copy, do not re-derive. The three things a re-derivation
// would silently get wrong are the tile SOURCES, the terrarium DECODE and the
// PROJECTION, so all three are read out of `packages/` at run time rather than
// typed in here. If gameview ever changes a source or a formula, these fail and
// name the demo that drifted, instead of leaving three worlds quietly sampling
// a different planet from the one the game does.

console.log('\n[demo geo loader vs gameview]');

const GV = {
  mvt: readFileSync('packages/web/src/game/terrain/mvt-fetcher.ts', 'utf8'),
  ele: readFileSync('packages/web/src/game/terrain/elevation-sampler.ts', 'utf8'),
  bld: readFileSync('packages/web/src/game/terrain/building-renderer.ts', 'utf8'),
};
/** All quoted layer names inside a `WANTED_LAYERS` / `for (const name of [...])` list. */
const namesIn = (block: string): string[] =>
  [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

const gvLayers = namesIn(
  GV.mvt.slice(GV.mvt.indexOf('const WANTED_LAYERS = ['),
    GV.mvt.indexOf(']', GV.mvt.indexOf('const WANTED_LAYERS = ['))),
);
const gvZoom = /const MVT_ZOOM = (\d+);/.exec(GV.mvt)?.[1];
const gvTileJson = /const TILEJSON_URL = '([^']+)'/.exec(GV.mvt)?.[1];
const gvDemUrl = /DEFAULT_TERRARIUM_URL =\s*\n?\s*'([^']+)'/.exec(GV.ele)?.[1];
const gvDemZoom = /this\.zoom = options\?\.zoom \?\? (\d+);/.exec(GV.ele)?.[1];
const gvDecode = /function decodeTerrarium\(r: number, g: number, b: number\): number \{\s*return ([^;]+);/
  .exec(GV.ele)?.[1];
// `x = (lon - originLon) * 111320 * cosOrigin` — the same metres-per-degree
// everywhere in gameview. Read the literal so a change there is not silent.
const gvMetresPerDeg = /\* (\d+) \* cosOrigin/.exec(GV.bld)?.[1];

check('gameview still declares everything this section reads out of it',
  gvLayers.length > 0 && !!gvZoom && !!gvTileJson && !!gvDemUrl && !!gvDemZoom
  && !!gvDecode && !!gvMetresPerDeg,
  `layers ${gvLayers.length} / MVT_ZOOM ${gvZoom} / DEM zoom ${gvDemZoom} / m-per-deg ${gvMetresPerDeg}`);

for (const w of ['paper', 'plastic', 'circuit'] as const) {
  const sec = geoSection(w);
  const demoLayerBlock = sec.slice(sec.indexOf('for (const name of ['),
    sec.indexOf(']', sec.indexOf('for (const name of [')));
  check(`${w}: fetches gameview's WANTED_LAYERS, in gameview's order`,
    namesIn(demoLayerBlock).join(',') === gvLayers.join(','),
    `demo [${namesIn(demoLayerBlock).join(', ')}]`);

  check(`${w}: same zoom as gameview's MVT_ZOOM and ElevationSampler default`,
    /const GEO_Z = (\d+);/.exec(sec)?.[1] === gvZoom && gvZoom === gvDemZoom,
    `demo ${/const GEO_Z = (\d+);/.exec(sec)?.[1]} / MVT ${gvZoom} / DEM ${gvDemZoom}`);

  check(`${w}: same TileJSON endpoint (and it resolves tiles[0], not a hardcoded path)`,
    /const GEO_TILEJSON = '([^']+)'/.exec(sec)?.[1] === gvTileJson
    && /tj\.tiles\[0\]/.test(sec),
    `${/const GEO_TILEJSON = '([^']+)'/.exec(sec)?.[1]}`);

  check(`${w}: same terrarium tile URL as elevation-sampler's DEFAULT_TERRARIUM_URL`,
    /const GEO_DEM_URL = '([^']+)'/.exec(sec)?.[1] === gvDemUrl,
    `${/const GEO_DEM_URL = '([^']+)'/.exec(sec)?.[1]}`);

  // The decode, normalised back to gameview's own r/g/b names. Comparing the
  // EXPRESSION rather than the constants is what catches a re-derivation that
  // happens to use the same numbers in a different arrangement.
  const demoDecode = /const e = ([^;]+);/.exec(sec)?.[1]
    ?.replace(/png\.data\[i \* 4 \+ 2\]/g, 'b')
    .replace(/png\.data\[i \* 4 \+ 1\]/g, 'g')
    .replace(/png\.data\[i \* 4\]/g, 'r');
  check(`${w}: the terrarium decode is elevation-sampler's, expression for expression`,
    demoDecode === gvDecode, `demo \`${demoDecode}\` vs gameview \`${gvDecode}\``);

  // Projection: both directions, and both must use gameview's metres-per-degree.
  const fwd = /x: \(lon - GEO\.originLon\) \* (\d+) \* GEO\.cosLat,\s*\n\s*z: -\(lat - GEO\.originLat\) \* (\d+),/.exec(sec);
  const inv = /lat: GEO\.originLat - z \/ (\d+),\s*\n\s*lon: GEO\.originLon \+ x \/ \((\d+) \* GEO\.cosLat\),/.exec(sec);
  check(`${w}: the projection is gameview's, forward and inverse`,
    !!fwd && !!inv && [fwd[1], fwd[2], inv[1], inv[2]].every((v) => v === gvMetresPerDeg),
    `forward ${fwd?.slice(1).join('/')} · inverse ${inv?.slice(1).join('/')} vs gameview ${gvMetresPerDeg}`);
}

// All three demos must carry the SAME loader — §5 of DEMO_POC_GUIDE exists
// because three copies of one block is exactly how "only the plastic one has a
// seed button" happened. Compared as text, so a one-character drift shows up.
{
  const secs = (['paper', 'plastic', 'circuit'] as const).map((w) => geoSection(w));
  const same = secs.every((s) => s === secs[0]);
  const firstDiff = same ? -1 : [...secs[0]].findIndex((c, i) => c !== secs[1][i]);
  check('all three demos carry the SAME geo loader, character for character',
    same, same ? `${secs[0].length} chars` : `first difference at char ${firstDiff}: `
      + JSON.stringify(secs.map((s) => s.slice(Math.max(0, firstDiff - 30), firstDiff + 30))));
}


// ── J. 建築的窗:通用網格拆掉了,燈長在建築自己身上 ──────────────────────────
//
// 使用者裁示:「其實根本沒有『窗戶尺寸』,demo 的邏輯是他已經在每個建築物都開好
// 窗戶了,所以 gameview 原本強制加窗戶的做法要 drop,只要幫 demo 那邊指定好的
// 『窗戶』亮燈就好」。
//
// 拆掉的是**兩套**網格,而三份 demo 一套都沒有:
//   1. `collectBuildingWindows()` —— 沿每面牆每層每 4 m 蓋一片暖黃加色光片,
//      **全世界每一棟都跑**。
//   2. `collectFacadeWindowPlacements()` + `facadeWindows` —— 拿 OBB 切欄切列,
//      在兩個長面蓋同一塊模板。
// `plan/plastic-town-demo.html` 自己把對應的 `addWindows()` 連函式一起刪掉,並寫
// 下理由:「那個網格完全不知道自己蓋在什麼上面」。
//
// 這一段守的是拆完之後的事實。⚠ `diorama.ts` 那邊有三條 `windows: …` 是掛在
// `strategy.facadeWindows` 上的(積木與瓦楞紙各跑一次,共六次執行),屬性沒了
// 它們會**安靜地不執行** —— 那正是 §10 最後一條警告的形狀,所以替代品放在這裡,
// 而且問的是**建出來的東西**,不是宣告。
{
  console.log('\n[building lights vs demo: 沒有「窗戶尺寸」這種東西]');

  const buildingLights = await import('@/game/terrain/building-lights');
  const buildingRenderer = await import('@/game/terrain/building-renderer');

  // J1. 機制本身要不見。留著任何一支,下一個人就會把網格接回去。
  const goneFromLights = ['collectBuildingWindows', 'windowLightMaterial', 'setWindowLightOpacity',
    'buildWindowLightMesh'].filter((k) => k in buildingLights);
  check('通用窗格的三支入口從 building-lights 消失了',
    goneFromLights.length === 0,
    goneFromLights.length ? `還在:${goneFromLights.join(', ')}` : 'collectBuildingWindows / windowLightMaterial / setWindowLightOpacity 都不在了');
  check('…而 building-renderer 也不再 export collectFacadeWindowPlacements',
    !('collectFacadeWindowPlacements' in buildingRenderer));
  // 反向對照:這兩條在「import 根本沒載到東西」時也會過。
  check('…(而這兩個模組真的載到了東西)',
    typeof buildingLights.setNightLitFactor === 'function'
    && typeof buildingRenderer.buildBuildingMeshes === 'function');

  // J2. 三個世界都不准再宣告 `facadeWindows`,而**誰宣告 quad 是逐世界的分歧**,
  //     要斷言下來不要統一:電子世界一片 quad 都沒有(它的窗是 dipIC 本體裡的
  //     `dipWinMat` 方塊,走 decoration),另外兩個有。
  const STYLES3 = {
    plastic: await createTerrainStyleStrategy('plastic'),
    paper: await createTerrainStyleStrategy('paper'),
    circuit: await createTerrainStyleStrategy('circuit'),
  };
  const declaresGrid = (Object.keys(STYLES3) as (keyof typeof STYLES3)[])
    .filter((w) => 'facadeWindows' in STYLES3[w]);
  check('三個世界一個都不再宣告 facadeWindows(通用網格的旋鈕)',
    declaresGrid.length === 0, declaresGrid.join('/') || '一個都沒有');
  const declaresQuads = (Object.keys(STYLES3) as (keyof typeof STYLES3)[])
    .filter((w) => typeof STYLES3[w].buildBuildingLights === 'function');
  check('宣告光片的是積木與瓦楞紙,電子一片都沒有(逐世界的分歧,不是漏做)',
    declaresQuads.join(',') === 'plastic,paper', declaresQuads.join(',') || '(無)');
  check('…而宣告了光片的世界都供得出光片材質',
    declaresQuads.every((w) => typeof STYLES3[w].createBuildingLightMaterial === 'function'));

  // ── J3. 積木的光片尺寸 = demo `emitSlabFaceLights` **執行出來的**兩個比例 ──
  // 不抄常數(§0.0 第 5 點):把 demo 那支函式連同它吃的兩個常數切出來跑,讀它
  // 推進 out 的 `[.., w, h]`,再回推 w/slabT 與 h/SLAB_H 兩個比例。
  const demoRatios = ((): { rw: number; rh: number } => {
    const src = SRC.plastic;
    const out = runDemo('plastic', [
      sliceLine(src, '  const LAYER_H = 2.3;'),
      sliceLine(src, '  const SLAB_GAP = 0.16;'),
      sliceLine(src, '  const SLAB_H = LAYER_H - SLAB_GAP;'),
      sliceFn(src, 'emitSlabFaceLights'),
    ], `
      const got = [];
      // lrng 恆回 0 → 兩面都亮,兩筆都拿得到。
      emitSlabFaceLights(got, () => 0, 0, 0, 0, 0, true, 10, 3);
      return { got, SLAB_H };
    `) as unknown as { got: number[][]; SLAB_H: number };
    return { rw: out.got[0][4] / 3, rh: out.got[0][5] / out.SLAB_H };
  })();
  check('demo 的光片比例讀得出來(w = 0.68 × 塊厚, h = 0.6 × 塊高)',
    Math.abs(demoRatios.rw - 0.68) < 1e-9 && Math.abs(demoRatios.rh - 0.6) < 1e-9,
    `rw ${demoRatios.rw.toFixed(4)} / rh ${demoRatios.rh.toFixed(4)}`);

  type WinQuad = { x: number; y: number; z: number; w: number; h: number; lit?: string };
  type PartBox = { x: number; y: number; z: number; w: number; h: number; d: number; shape?: string };

  /** 一棟樓的量體零件 + 它宣告的燈,同一個 (box, seed, zone)。 */
  const lightBox = (w: number, d: number, h: number) => ({
    cx: 0, cz: 0, width: w, depth: d, height: h, rotY: 0, baseY: 0, skirt: 1.5,
    color: 0xcccccc,
  }) as never;

  // 每一片燈都要對得上**它蓋在的那個零件**。配對用最近的零件中心 —— 光片是貼在
  // 零件表面上的,所以最近的那個就是它。
  /**
   * 一棟樓宣告的燈 + 它自己的量體零件,同一個 (box, seed, zone)。
   *
   * ⚠ 不做「最近的零件就是它蓋的那一塊」那種配對 —— 光片貼在塊的**端面**上,而
   * 隔壁那塊的中心常常更近,配錯的比對出來的假失敗比真失敗還多(第一版就是這樣)。
   * 改成問**存在性**:這棟樓自己的零件裡,一定找得到一塊,它的尺寸乘上該有的比例
   * 剛好就是這片光片。比的是浮點**精確相等**,所以巧合撞上的機率可以不計;而一塊
   * 共用模板會讓每一片都是同一個尺寸,那在任何一棟不同尺寸的樓上都立刻失敗。
   */
  const lightsWithParts = (
    world: keyof typeof STYLES3, zone: string, boxes: [number, number, number][],
  ): { lights: WinQuad[]; parts: PartBox[] }[] => {
    const st = STYLES3[world];
    const out: { lights: WinQuad[]; parts: PartBox[] }[] = [];
    for (const [bw, bd, bh] of boxes) {
      for (let seed = 0; seed < 24; seed++) {
        const box = lightBox(bw, bd, bh);
        const lights = st.buildBuildingLights!(box, seed, zone as never) as WinQuad[];
        if (!lights.length) continue;
        const parts = (st.buildBuildingBoxes?.(box, seed, zone as never) ?? []) as PartBox[];
        if (parts.length) out.push({ lights, parts });
      }
    }
    return out;
  };
  const eq = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

  {
    // 積木有兩種燈,而且**兩種的尺寸來源不同**,所以分開問(混在一起問的話,
    // 哪一種壞了另一種都會幫它遮掉):
    //   抽抽樂塔  → 露出來的方形短面,demo `emitSlabFaceLights` 的兩個比例。
    //   黏土像素屋 → 那格換色的體素**整面**(demo 走材質,移植只能走光片),
    //                所以是體素自己的 0.86。
    const groups = lightsWithParts('plastic', 'commercial', [[16, 12, 24], [9, 9, 12], [40, 22, 60]]);
    let slab = 0, clay = 0, bad = 0;
    let sample = '';
    for (const g of groups) {
      const isClay = g.parts.some((q) => q.shape === 'clayCube');
      for (const L of g.lights) {
        const hit = g.parts.some((q) => (isClay
          ? eq(L.w, 0.86 * q.w) && eq(L.h, 0.86 * q.h)
          : eq(L.h, demoRatios.rh * q.h)
            && (eq(L.w, demoRatios.rw * q.w) || eq(L.w, demoRatios.rw * q.d))));
        if (isClay) clay++; else slab++;
        if (!hit) {
          bad++;
          if (!sample) sample = ` 例:${L.w.toFixed(3)}×${L.h.toFixed(3)}`;
        }
      }
    }
    check('積木:兩種燈都真的產得出來(抽抽樂塔的短面 + 黏土屋的窗體素)',
      slab > 0 && clay > 0, `塔 ${slab} 片 / 黏土 ${clay} 片`);
    check('積木:每一片光片的尺寸都是**這棟樓自己某一塊**乘上該有的比例'
      + '(塔 = demo 的 0.68/0.6,黏土 = 那格體素的 0.86)',
      slab + clay > 0 && bad === 0, `${slab + clay} 片,對不上 ${bad}${sample}`);
  }
  {
    // 瓦楞紙:demo 那兩格走材質(提把環 / 藥盒格),移植只能走光片(量體整批一份
    // 頂點色材質,單一零件沒有材質可以登記)。demo 因此沒有比例可抄 —— 能斷言的
    // 是**它就是那個零件那一面的大小**,那正是模板做不到的事:舊的通用模板不管
    // 底下是什麼,一律畫 3 × 2.6 m 的蠟筆卡。
    //   提把環 = 四根方料,每一片光片就是**其中一根**的 w × h,一根不差;
    //   藥盒格 = 一塊 box,光片就是它的 w × h,一格不差。
    // ⚠ 分組照**光片自己的 `lit` key**,不照 zone:`ZONE_MIX` 有 20% 會在學校區
    // 抽到藥盒(反之亦然),照 zone 分的話那些會被拿去比錯的規則。
    const groups = [
      ...lightsWithParts('paper', 'school', [[19, 8, 11], [40, 20, 12], [8.2, 4.7, 5]]),
      ...lightsWithParts('paper', 'hospital', [[10, 8.6, 16], [22, 11, 28], [4, 3, 5]]),
    ];
    const seen = new Set<string>();
    let n = 0, bad = 0;
    let sample = '';
    for (const g of groups) {
      for (const L of g.lights) {
        n++;
        seen.add(L.lit ?? '(無)');
        const hit = L.lit === 'handleRing' || L.lit === 'pillCell'
          ? g.parts.some((q) => eq(L.w, q.w) && eq(L.h, q.h))
          : false;
        if (!hit) {
          bad++;
          if (!sample) sample = ` 例(${L.lit}):${L.w.toFixed(3)}×${L.h.toFixed(3)}`;
        }
      }
    }
    check('瓦楞紙:每一片光片就是它照亮的那個零件那一面的大小(提把環的一根方料 / 藥盒格,都是 1:1)',
      n > 0 && bad === 0, `${n} 片,對不上 ${bad}${sample}`);
    // …而且兩種燈都真的出現過(只跑到其中一種的話上面那條有一半是空的)。
    check('…而且提把環與藥盒格兩種燈都真的產得出來',
      seen.has('handleRing') && seen.has('pillCell'), [...seen].join('/'));
    // ⚠ 上面那條的 1:1 對「環」來說太鬆:四根方料裡有兩根是 ringW 寬、兩根是
    // holeH 高,而藥盒格也是一塊 box —— 只問「有沒有一塊尺寸一樣」的話,一片
    // 蓋住整個提把洞的大方片只要剛好等於某一塊就會過。所以再問一次**形狀**:
    // 亮的一定是四根一組(兩橫兩豎),而且橫的比豎的寬、豎的比橫的高。
    let rings = 0, shapeBad = 0;
    for (const g of groups) {
      const ring = g.lights.filter((L) => L.lit === 'handleRing');
      if (!ring.length) continue;
      if (ring.length % 4 !== 0) shapeBad++;
      const wide = ring.filter((L) => L.w > L.h).length;
      const tall = ring.filter((L) => L.h >= L.w).length;
      if (wide !== ring.length / 2 || tall !== ring.length / 2) shapeBad++;
      rings += ring.length;
    }
    check('…而且提把環的燈是**一圈**(四根一組,兩橫兩豎),不是蓋住整個洞的一片',
      rings > 0 && shapeBad === 0, `${rings} 根,不成圈 ${shapeBad} 組`);
  }

  // ── J4. 走真的 chunk 建置:光片批次的 instance **尺寸不是同一個常數** ──
  // 「記錄了 ≠ 送得到」:上面問的是 strategy 宣告了什麼,這一條問渲染器真的建出
  // 來的 InstancedMesh。共用模板的話每一格 scale 都一樣 —— 那正是要抓的東西。
  {
    const FLAT = {
      getElevationSync: () => 0, getElevation: async () => 0,
    } as unknown as Parameters<typeof buildingRenderer.buildBuildingMeshes>[1];
    const footprints = [];
    for (let i = 0; i < 40; i++) {
      const lon = 121.5 + i * 6e-4, lat = 25.05;
      const dlon = 22 / (111320 * Math.cos(lat * Math.PI / 180));
      const dlat = 14 / 111320;
      footprints.push({
        coordinates: [[lon, lat], [lon + dlon, lat], [lon + dlon, lat + dlat],
          [lon, lat + dlat], [lon, lat]] as [number, number][],
        height: 10 + (i % 7) * 6,
      });
    }
    for (const world of ['plastic', 'paper'] as const) {
      const st = STYLES3[world];
      const zoneOf = () => (world === 'plastic' ? 'commercial' : 'school') as never;
      const res = await buildingRenderer.buildBuildingMeshes(
        footprints, FLAT, 25.05, 121.5, 0, st, () => 0, undefined, zoneOf);
      const batch = res.lightsMesh;
      const sizes = new Set<string>();
      let count = 0;
      const m = new THREE.Matrix4(), pos = new THREE.Vector3(),
        q = new THREE.Quaternion(), sc = new THREE.Vector3();
      const walk = (im?: THREE.InstancedMesh): void => {
        if (!im) return;
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, m);
          m.decompose(pos, q, sc);
          sizes.add(`${sc.x.toFixed(3)}x${sc.y.toFixed(3)}`);
          count++;
        }
        for (const c of im.children) walk(c as THREE.InstancedMesh);
      };
      walk(batch);
      check(`${world}: 真的建出來的光片批次裡,尺寸**不只一種**(共用模板只會有一種)`,
        count > 0 && sizes.size > 1,
        `${count} 片 / ${sizes.size} 種尺寸`);
      // …而且那個批次真的走了 style 自己的材質,不是隨便一塊白板。
      const mat = batch?.material as THREE.Material | undefined;
      check(`${world}: …而它畫在 style 自己的光片材質上(shared,chunk 不准 dispose)`,
        !!mat && mat.userData.shared === true);
      // 夜:白天整批關掉(demo `im.visible = nightBlend > 0.02`),入夜打開。
      setNightLitFactor(0);
      const dayVisible = mat?.visible;
      const dayEmissive = (mat as THREE.MeshPhongMaterial | undefined)?.emissive.getHex();
      setNightLitFactor(1);
      const nightVisible = mat?.visible;
      const nightEmissive = (mat as THREE.MeshPhongMaterial | undefined)?.emissive.getHex();
      setNightLitFactor(0);
      check(`${world}: 光片白天整批關掉、入夜才亮(demo 的 im.visible = k > 0.02)`,
        dayVisible === false && nightVisible === true
        && dayEmissive === 0x000000 && (nightEmissive ?? 0) > 0,
        `day vis=${dayVisible} emissive=#${(dayEmissive ?? 0).toString(16)}`
        + ` / night vis=${nightVisible} emissive=#${(nightEmissive ?? 0).toString(16)}`);
      buildingRenderer.disposeBuildingMesh(res);
    }
  }

  for (const w of Object.keys(STYLES3) as (keyof typeof STYLES3)[]) STYLES3[w].dispose();
}

// Every one of these must still BUILD, invention or not.
for (const world of ['paper', 'plastic', 'circuit'] as const) {
  const style = await createTerrainStyleStrategy(world);
  // FOUR widths on purpose, two either side of the clamp. Every world's portal
  // opens `Math.max(5, width * 1.5)`, so the floor binds below width 10/3 —
  // and a check that only ever passes wide roads cannot tell a live floor from
  // a deleted one. Width 0 is in there because §0.0 rule 4 says the map WILL
  // send one (`render_height` bottoms out at 0.0 m on 512 footprints).
  const spans = [0, 3.3, 4, 14].map((w) => {
    const portal = style.buildTunnelPortal?.(w);
    const parts = portal ? partsOf(portal) : [];
    const b = aabbOf(parts);
    return { w, parts: parts.length, span: parts.length ? b.max.x - b.min.x : NaN };
  });
  check(`${world} tunnel portal builds at every width, including 0`,
    spans.every((s) => s.parts > 0 && Number.isFinite(s.span)),
    spans.map((s) => `${s.w}→${s.parts}p/${s.span.toFixed(2)}m`).join(' '));
  check(`${world} tunnel portal: the opening floor binds below width 10/3`,
    Math.abs(spans[0].span - spans[1].span) < 1e-9,
    `w=0 ${spans[0].span.toFixed(3)} vs w=3.3 ${spans[1].span.toFixed(3)}`);
  check(`${world} tunnel portal: and lets go above it`,
    spans[2].span > spans[1].span + 1e-6 && spans[3].span > spans[2].span + 1e-6,
    `3.3→${spans[1].span.toFixed(2)} 4→${spans[2].span.toFixed(2)} 14→${spans[3].span.toFixed(2)}`);
  const plane = style.buildPlaneOrnament();
  check(`${world} plane ornament builds`, partsOf(plane).length > 0,
    `${partsOf(plane).length} parts`);
  const ship = style.buildFinishAirship();
  check(`${world} finish airship builds`, partsOf(ship.root).length > 0,
    `${partsOf(ship.root).length} parts`);
  // Every airship material must opt out of fog — the interface says so, and a
  // fogged one dissolves at exactly the distance it is meant to be seen from.
  let fogged = 0;
  ship.root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (m && (m as THREE.Material).fog) fogged++;
  });
  check(`${world} finish airship: nothing in it takes fog`, fogged === 0,
    `${fogged} fogged materials`);
  ship.dispose();
  style.dispose();
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');

/** How many assertions failed — so `diorama.ts` can fold this into its tally.
 *  Never sets `process.exitCode` to 0: standalone it fails the run, imported it
 *  leaves the host's exit code alone. */
export const failureCount = (): number => failures;
if (failures) process.exitCode = 1;
