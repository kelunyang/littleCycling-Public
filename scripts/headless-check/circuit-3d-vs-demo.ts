/**
 * `[zone bodies vs demo — circuit (electronics)]`
 *
 * Same discipline as `[zone bodies vs demo — plastic]` in `diorama.ts`: the
 * demo's OWN builders are sliced out of `plan/circuit-town-demo.html` with every
 * helper they call, executed, and diffed part for part against the shipping
 * strategy. Nothing here is compared against a constant transcribed into this
 * file — a transcription only re-confirms whatever was typed.
 *
 * The demo runs against a recording `THREE` whose GEOMETRY classes are the real
 * ones and whose unit geometries are the demo's own declarations, so a part is
 * comparable as a world-space bounding box AND a vertex count (a bounding box
 * alone cannot see 16 facets rewritten down to 12 — that is the 杯塔 failure).
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/circuit-3d-vs-demo.ts
 *
 * Folding into `diorama.ts`: drop the canvas stub below (diorama installs one),
 * replace the local `check` with diorama's, and wrap the three sections in
 * `await block('zone bodies vs demo — circuit', …)`.
 */
import { readFileSync } from 'node:fs';

// canvas stub 走 harness 共用的那一份(`recording-canvas.ts`)。這支自己不看筆觸,
// 但它**不能**把別人的畫布換掉:貼圖快取是模組層的,換掉之後先前錄的東西就沒了,
// 而快取住的貼圖不會重畫。冪等由 installRecordingCanvas 自己保證。
const { installRecordingCanvas } = await import('./recording-canvas.ts');
installRecordingCanvas();

const THREE = await import('three');
const { createTerrainStyleStrategy, mulberry32 } =
  await import('@/game/terrain/terrain-style-strategy');
const { setNightLitFactor } = await import('@/game/terrain/building-lights');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

type DemoPart = {
  geo: THREE.BufferGeometry; mat: string; aabb: THREE.Box3; m: THREE.Matrix4;
  pos: [number, number, number]; rot: [number, number, number];
  scale: [number, number, number];
};

function sliceFn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`cannot slice ${name} out of the demo`);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
function sliceLine(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`cannot slice ${head}`);
  return src.slice(at, src.indexOf('\n', at));
}
function sliceArray(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`cannot slice ${head}`);
  const end = src.indexOf('\n  ];', at);
  return src.slice(at, end + 4);
}

const MAT_TOKENS = [
  'capAluMat', 'capRingMat', 'icMat', 'icTopMat', 'bakeliteMat',
  'pinMat', 'bandMat', 'glassMat', 'micaMat', 'filamentMat', 'plateMat', 'gridMat',
  'getterMat', 'solderMat', 'goldPinMat', 'ceramicMat', 'kovarLidMat', 'ledCupMat',
  'ledRedMat', 'ledRedDieMat', 'steelAMat', 'steelBMat', 'copperMat', 'nixieLitMat',
  'cathodeMat', 'nixieHaloMat', 'dipWinMat', 'laminationMat',
];
const GEO_TOKENS = ['unitBox', 'unitCyl', 'unitCyl8', 'unitSphere', 'unitHemi',
  'unitTorus', 'unitTorusThin', 'getterCapGeo', 'glowQuad'];

function fakeThree() {
  class V3 {
    x = 0; y = 0; z = 0;
    set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
    setScalar(s: number) { return this.set(s, s, s); }
  }
  class Obj {
    children: Obj[] = [];
    position = new V3();
    rotation = new V3();
    scale = new V3().setScalar(1);
    userData: Record<string, unknown> = {};
    name = ''; castShadow = false; receiveShadow = false; renderOrder = 0;
    isMesh = false; geometry: unknown = null; material: unknown = null;
    add(...o: Obj[]) { this.children.push(...o); return this; }
  }
  class Group extends Obj {}
  class Mesh extends Obj {
    constructor(geo: unknown, mat: unknown) {
      super(); this.isMesh = true; this.geometry = geo; this.material = mat;
    }
  }
  return {
    Group, Mesh, Vector3: V3,
    // REAL geometry classes: a part's shape is then readable as an actual
    // bounding box, which is what makes the comparison exact instead of
    // "same numbers in the constructor".
    TorusGeometry: THREE.TorusGeometry,
    PlaneGeometry: THREE.PlaneGeometry,
    SphereGeometry: THREE.SphereGeometry,
    CylinderGeometry: THREE.CylinderGeometry,
    BoxGeometry: THREE.BoxGeometry,
    PointLight: class extends Obj {},
    DoubleSide: THREE.DoubleSide,
  };
}

function demoSandbox(src: string) {
  const prelude = [
    ...MAT_TOKENS.map((m) => `const ${m} = '${m}';`),
    "const capSleeveMats = ['capSleeve0', 'capSleeve1', 'capSleeve2'];",
    ...GEO_TOKENS.map((g) => sliceLine(src, `  const ${g} = new THREE.`)),
    sliceArray(src, '  const DIGIT_SEG = ['),
    sliceLine(src, '  const DIP_LIFT = '),
    'const DIP_BLACK = { body: icMat, top: icTopMat, pin: pinMat };',
    'const DIP_CERAMIC = { body: ceramicMat, top: kovarLidMat, pin: goldPinMat };',
    sliceFn(src, 'box'),
    sliceFn(src, 'cyl'),
    sliceFn(src, 'dome'),
    sliceFn(src, 'ledBody'),
    sliceFn(src, 'legRow'),
    sliceFn(src, 'dipIC'),
    sliceFn(src, 'electrolyticCap'),
    sliceFn(src, 'nixieDigit'),
    sliceFn(src, 'nixieSign'),
    sliceFn(src, 'transformer'),
    sliceFn(src, 'dipDims'),
    sliceFn(src, 'longDip'),
    sliceLine(src, '  const dipBox = '),
    sliceFn(src, 'indicatorLed'),
    sliceFn(src, 'addBuildingLights'),
    sliceFn(src, 'schoolDip'),
    sliceFn(src, 'hospitalDip'),
    sliceFn(src, 'vacuumTube'),
    'return { ledBody, dipIC, electrolyticCap, nixieDigit, nixieSign, transformer,'
    + ' dipDims, longDip, dipBox, indicatorLed, addBuildingLights, schoolDip, hospitalDip,'
    + ' vacuumTube, DIP_LIFT, DIP_BLACK, DIP_CERAMIC, DIGIT_SEG,'
    + ' unitCyl, unitCyl8, unitBox, unitHemi, glowQuad };',
  ].join('\n');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('THREE', prelude)(fakeThree()) as Record<string, never>;
}

/** demo material name → its colour, read out of the demo's own declarations. */
function demoMatColours(src: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /const (\w+) = (?:toon|metal)\(\s*(?:\{\s*color:\s*)?(?:E\.(\w+)|'#([0-9a-fA-F]{6})')/g;
  const E: Record<string, number> = {};
  const eBlock = src.slice(src.indexOf('const E = {'), src.indexOf('};', src.indexOf('const E = {')));
  for (const m of eBlock.matchAll(/(\w+):\s*'#([0-9a-fA-F]{6})'/g)) E[m[1]] = parseInt(m[2], 16);
  for (const m of src.matchAll(re)) {
    out[m[1]] = m[3] !== undefined ? parseInt(m[3], 16) : E[m[2]];
  }
  // The MeshPhongMaterial-literal ones (glow set + glass).
  for (const m of src.matchAll(/const (\w+) = new THREE\.MeshPhongMaterial\(\{[\s\S]{0,120}?color:\s*'#([0-9a-fA-F]{6})'/g)) {
    out[m[1]] = parseInt(m[2], 16);
  }
  for (const m of src.matchAll(/const (\w+) = new THREE\.MeshBasicMaterial\(\{[\s\S]{0,120}?color:\s*'#([0-9a-fA-F]{6})'/g)) {
    out[m[1]] = parseInt(m[2], 16);
  }
  return out;
}

function demoPartsOf(root: unknown): DemoPart[] {
  const out: DemoPart[] = [];
  const walk = (n: never, parent: THREE.Matrix4): void => {
    const o = n as unknown as {
      children: never[];
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number };
      scale: { x: number; y: number; z: number };
      isMesh?: boolean; geometry?: THREE.BufferGeometry; material?: unknown;
    };
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(o.position.x, o.position.y, o.position.z),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(o.rotation.x, o.rotation.y, o.rotation.z)),
      new THREE.Vector3(o.scale.x, o.scale.y, o.scale.z));
    const world = parent.clone().multiply(local);
    if (o.isMesh) {
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      world.decompose(p, q, s);
      const e = new THREE.Euler().setFromQuaternion(q);
      const geo = o.geometry!;
      if (!geo.boundingBox) geo.computeBoundingBox();
      out.push({
        geo, mat: String(o.material),
        aabb: geo.boundingBox!.clone().applyMatrix4(world), m: world.clone(),
        pos: [p.x, p.y, p.z], rot: [e.x, e.y, e.z], scale: [s.x, s.y, s.z],
      });
    }
    for (const c of o.children) walk(c, world);
  };
  walk(root as never, new THREE.Matrix4());
  return out;
}

type PortPart = {
  colour: number; additive: boolean; mat: THREE.Material;
  geo: THREE.BufferGeometry; aabb: THREE.Box3; m: THREE.Matrix4;
  pos: [number, number, number]; rot: [number, number, number];
  scale: [number, number, number];
};
function portPartsOf(group: THREE.Object3D): PortPart[] {
  const out: PortPart[] = [];
  group.updateMatrixWorld(true);
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.Material & { color?: THREE.Color };
    const inst = mesh as unknown as THREE.InstancedMesh;
    const push = (m: THREE.Matrix4): void => {
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      m.decompose(p, q, s);
      const e = new THREE.Euler().setFromQuaternion(q);
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      out.push({
        colour: mat.color ? mat.color.getHex() : -1,
        additive: mat.blending === THREE.AdditiveBlending,
        mat, geo: mesh.geometry,
        aabb: mesh.geometry.boundingBox!.clone().applyMatrix4(m), m: m.clone(),
        pos: [p.x, p.y, p.z], rot: [e.x, e.y, e.z], scale: [s.x, s.y, s.z],
      });
    };
    if (inst.isInstancedMesh) {
      for (let i = 0; i < inst.count; i++) {
        const m = new THREE.Matrix4();
        inst.getMatrixAt(i, m);
        push(m.premultiply(mesh.matrixWorld));
      }
    } else push(mesh.matrixWorld.clone());
  });
  return out;
}

const src = readFileSync('plan/circuit-town-demo.html', 'utf8');
const demo = demoSandbox(src);
const MC = demoMatColours(src);
const style = await createTerrainStyleStrategy('circuit');
/** The demo's own halo peak, out of its HALO_PARTS table. */
/** The demo's three capacitor sleeve colours, off its own array. */
const CAP_SLEEVES_DEMO = [...
  /const capSleeveTexes = \[([^\]]+)\]/.exec(src)![1].matchAll(/'#([0-9a-fA-F]{6})'/g)]
  .map((m) => parseInt(m[1], 16));
const demoHaloPeak = Number(
  /\{\s*mat:\s*nixieHaloMat,\s*peak:\s*([\d.]+)\s*\}/.exec(src)![1]);

const boxOf = (w: number, d: number, h: number) => ({
  cx: 0, cz: 0, baseY: 0, width: w, depth: d, height: h, rotY: 0, skirt: 0,
}) as never;
const near = (a: number, b: number, tol = 1e-6): boolean => Math.abs(a - b) <= tol;
const maxDiff = (a: number[], b: number[]): number =>
  (a.length !== b.length ? Infinity : Math.max(0, ...a.map((v, i) => Math.abs(v - b[i]))));
/** A seed whose `circuitKind` roll keeps the zone's own body. */
function ownZoneSeed(): number {
  for (let s = 1; s < 20000; s++) {
    if (mulberry32((s * 2246822519 + 0xc1c) >>> 0)() < 0.8) return s;
  }
  throw new Error('no seed');
}
const disposeDeco = (g: THREE.Object3D): void => {
  g.traverse((o) => {
    const im = o as unknown as THREE.InstancedMesh;
    if (im.isInstancedMesh) im.dispose();
  });
};

console.log('\n[zone bodies vs demo — circuit (electronics)]');

const aabbNums = (b: THREE.Box3): number[] =>
  [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
const aabbKey = (b: THREE.Box3): string => aabbNums(b).map((v) => v.toFixed(3)).join(',');
/**
 * Same parts, box for box. Tolerance is 1 mm: the demo composes its parts as
 * `mesh.scale` over a unit geometry while the port bakes the size into the
 * geometry, and those two orders of multiplication differ in the 4th decimal.
 */
const sameParts = (a: { aabb: THREE.Box3 }[], b: { aabb: THREE.Box3 }[]): boolean => {
  if (a.length !== b.length) return false;
  const A = a.map((p) => aabbNums(p.aabb)).sort((x, y) => aabbKey0(x) < aabbKey0(y) ? -1 : 1);
  const B = b.map((p) => aabbNums(p.aabb)).sort((x, y) => aabbKey0(x) < aabbKey0(y) ? -1 : 1);
  return A.every((v, i) => v.every((n, k) => Math.abs(n - B[i][k]) <= 1e-3));
};
const aabbKey0 = (v: number[]): string => v.map((n) => n.toFixed(3)).join(',');

// ── The ordered world-space triangle stream ─────────────────────────────────
/**
 * `sameParts` above compares bounding boxes, and a bounding box is blind to two
 * things this world has actually shipped:
 *
 *  1. **Winding.** Reversing an index buffer leaves every box and every
 *     triangle count untouched, and the CPU rasteriser in `demo-probe` draws
 *     both sides — but WebGL's default `FrontSide` renders the reversed one as
 *     a hole (`CUSTOM_WORLD_INSTRUCTIONS` §10.5).
 *  2. **Chirality.** A part swapped onto the mirrored axis has the same box,
 *     the same triangle count and the same everything else — the nixie sign's
 *     glyphs read backwards and nothing aggregate can see it.
 *
 * So a part is compared as its FULL stream of world-space triangles: each
 * triangle carries its three vertices in a canonical CYCLE (rotated to start at
 * the lexicographically smallest vertex, which preserves winding and therefore
 * fails on a reversal), its geometric normal taken from that winding, and its
 * three SHADING normals pushed through the part's normal matrix. The shading
 * normals are what catch `computeVertexNormals()` leaking into a pipeline that
 * is supposed to be flat-shaded — those come out as neighbour averages, not as
 * the face normal.
 */
/**
 * A triangle is carried as BOTH a quantised string (only ever used to line the
 * two streams up in the same order) and the raw numbers (what is actually
 * compared, with a tolerance). It has to be that way round: `InstancedMesh`
 * keeps `instanceMatrix` in a **Float32Array**, so the port's world positions
 * carry ~1e-6 of quantisation the demo's double-precision `mesh.scale` path
 * does not. String-equal keys would report a defect on every value that lands
 * within 1e-6 of a rounding boundary — and the sphere caps land on one
 * (`√2/4 × 1.97` puts a dome vertex at exactly z = 4.2285).
 */
type TriRec = { key: string; v: number[] };
/** 1 mm quantum — the sort key only; equality is `TRI_TOL` below. */
const f3 = (n: number): string => {
  const q = Math.round(n * 1000) / 1000;
  return Math.abs(q) < 5e-4 ? '0.000' : q.toFixed(3);
};
const v3s = (v: number[]): string => `${f3(v[0])} ${f3(v[1])} ${f3(v[2])}`;
/** Float32 instance matrices cost ~1e-6; a flipped winding costs 2.0, a mirror
 *  costs metres. 1 mm sits between the two by three orders of magnitude. */
const TRI_TOL = 1e-3;

function trisOf(geo: THREE.BufferGeometry, m: THREE.Matrix4): TriRec[] {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const pos = src.getAttribute('position');
  const nrm = src.getAttribute('normal');
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const v = new THREE.Vector3();
  const out: TriRec[] = [];
  for (let i = 0; i + 2 < pos.count; i += 3) {
    const P: number[][] = [];
    const N: number[][] = [];
    for (let k = 0; k < 3; k++) {
      v.set(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)).applyMatrix4(m);
      P.push([v.x, v.y, v.z]);
      v.set(nrm.getX(i + k), nrm.getY(i + k), nrm.getZ(i + k)).applyMatrix3(nm).normalize();
      N.push([v.x, v.y, v.z]);
    }
    const u = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]];
    const w = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
    const g = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const gl = Math.hypot(g[0], g[1], g[2]);
    const gn = gl > 1e-9 ? [g[0] / gl, g[1] / gl, g[2] / gl] : [0, 0, 0];
    const s = P.map(v3s);
    let r = 0;
    for (let k = 1; k < 3; k++) if (s[k] < s[r]) r = k;
    out.push({
      key: `${s[r]} / ${s[(r + 1) % 3]} / ${s[(r + 2) % 3]}`
        + ` | gn ${v3s(gn)}`
        + ` | sn ${v3s(N[r])} / ${v3s(N[(r + 1) % 3])} / ${v3s(N[(r + 2) % 3])}`,
      v: [...P[0], ...P[1], ...P[2], ...gn, ...N[0], ...N[1], ...N[2]],
    });
  }
  if (src !== geo) src.dispose();
  return out;
}

/** Every triangle of every part, in one canonically ordered stream. */
function streamOf(
  parts: { geo: THREE.BufferGeometry; m: THREE.Matrix4 }[], xf?: THREE.Matrix4,
): TriRec[] {
  const out: TriRec[] = [];
  for (const p of parts) out.push(...trisOf(p.geo, xf ? xf.clone().multiply(p.m) : p.m));
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Same triangle? The three CYCLIC rotations are all accepted — they are the
 * same winding, and which vertex a generator happens to emit first is not a
 * fact about the model. The reversal is NOT accepted: it lives in `gn`, which
 * flips sign and is 2.0 away.
 */
function sameTri(a: number[], b: number[]): boolean {
  for (let k = 0; k < 3; k++) if (Math.abs(a[9 + k] - b[9 + k]) > TRI_TOL) return false;
  for (let r = 0; r < 3; r++) {
    let ok = true;
    for (let i = 0; i < 3 && ok; i++) {
      const j = (i + r) % 3;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(a[i * 3 + k] - b[j * 3 + k]) > TRI_TOL) { ok = false; break; }
        if (Math.abs(a[12 + i * 3 + k] - b[12 + j * 3 + k]) > TRI_TOL) { ok = false; break; }
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * First triangle of `a` with no partner in `b`, or -1. Walks outward from the
 * aligned index because both streams are sorted on the same key, so the partner
 * is almost always index `i` — the widening search is only there for the values
 * whose 1 mm key rounds the other way.
 */
function streamDiff(a: TriRec[], b: TriRec[]): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  const used = new Uint8Array(b.length);
  for (let i = 0; i < a.length; i++) {
    let found = -1;
    for (let d = 0; d < b.length && found < 0; d++) {
      for (const j of d === 0 ? [i] : [i + d, i - d]) {
        if (j < 0 || j >= b.length || used[j]) continue;
        if (sameTri(a[i].v, b[j].v)) { found = j; break; }
      }
    }
    if (found < 0) return i;
    used[found] = 1;
  }
  return -1;
}

/**
 * The eight ways a footprint-local frame can be laid down: four rotations about
 * y, and the same four with the along axis reflected. A port that needs one of
 * the MIRRORED four to line up with the demo is drawing the building's mirror
 * image — legal for anything symmetric, a defect the moment the shape is
 * chiral (a seven-segment glyph, a pin-1 dimple, an LED's lead frame).
 */
const FRAMES: [string, THREE.Matrix4, boolean][] = [];
/** Built by hand, so the entries are exactly 0 / ±1 — `makeRotationY(π/2)`
 *  leaves a 6e-17 cosine behind, and that is enough to move a value that sits
 *  on a rounding boundary. */
const quarter = (k: number, mz: number): THREE.Matrix4 => {
  const c = [1, 0, -1, 0][k & 3], s = [0, 1, 0, -1][k & 3];
  return new THREE.Matrix4().set(
    c, 0, s * mz, 0,
    0, 1, 0, 0,
    -s, 0, c * mz, 0,
    0, 0, 0, 1);
};
for (const k of [0, 1, 2, 3]) FRAMES.push([`rotY ${k * 90}°`, quarter(k, 1), false]);
for (const k of [0, 1, 2, 3]) {
  FRAMES.push([`MIRROR + rotY ${k * 90}°`, quarter(k, -1), true]);
}
/**
 * Which of the eight frames map the demo's boxes onto the port's.
 *
 * Tolerance is 2 mm, not equality: the demo scales a unit geometry where the
 * port bakes the size in, the rotation goes through a 4×4, and those two orders
 * of multiplication disagree in the 4th decimal. 2 mm is far below anything
 * this comparison is looking for — the smallest feature in play is a 0.3 m rod
 * and the mirror it is hunting moves parts by metres.
 */
const FRAME_TOL = 2e-3;
function frameFits(
  demoBoxes: { aabb: THREE.Box3 }[], portBoxes: { aabb: THREE.Box3 }[], m: THREE.Matrix4,
): boolean {
  if (demoBoxes.length !== portBoxes.length) return false;
  // Pair them off greedily rather than by sorting: a box whose 4th decimal
  // rounds the other way sorts somewhere else entirely, and lugs at
  // ±2.48950000 do exactly that.
  const B = portBoxes.map((p) => aabbNums(p.aabb));
  const used = new Array<boolean>(B.length).fill(false);
  for (const p of demoBoxes) {
    const v = aabbNums(p.aabb.clone().applyMatrix4(m));
    const at = B.findIndex((w, i) =>
      !used[i] && w.every((n, k) => Math.abs(n - v[k]) <= FRAME_TOL));
    if (at < 0) return false;
    used[at] = true;
  }
  return true;
}
function framesMatching(
  demoBoxes: { aabb: THREE.Box3 }[], portBoxes: { aabb: THREE.Box3 }[],
): [string, THREE.Matrix4, boolean][] {
  return FRAMES.filter(([, m]) => frameFits(demoBoxes, portBoxes, m));
}
/**
 * The frame to compare triangle streams in. Prefer a rotation; fall back to the
 * mirror and then to the identity so the stream comparison ALWAYS runs — a
 * mutation run caught this: with the frame search failing, `if (rot)` quietly
 * skipped four stream assertions and the mutation looked half-detected.
 */
function streamFrame(hits: [string, THREE.Matrix4, boolean][]): THREE.Matrix4 {
  return (hits.find(([, , mirror]) => !mirror) ?? hits[0] ?? FRAMES[0])[1];
}
/** When nothing lines up: the closest frame and what it still disagrees on. */
function dumpFrames(
  demoBoxes: { aabb: THREE.Box3 }[], portBoxes: { aabb: THREE.Box3 }[],
): void {
  const B = portBoxes.map((p) => aabbKey(p.aabb)).sort();
  let best: [string, string[]] = ['—', []];
  let hi = -1;
  for (const [name, m] of FRAMES) {
    const A = demoBoxes.map((p) => aabbKey(p.aabb.clone().applyMatrix4(m))).sort();
    const shared = A.filter((v) => B.includes(v)).length;
    if (shared > hi) { hi = shared; best = [name, A]; }
  }
  console.log(`      closest frame ${best[0]}: ${hi}/${B.length} boxes agree (string-exact)`);
  for (const v of best[1]) if (!B.includes(v)) console.log(`      demo-only ${v}`);
  for (const v of B) if (!best[1].includes(v)) console.log(`      ours-only ${v}`);
}

/** Extent of the vertices painted `hex` in a merged body, per axis. */
function colourExtent(geo: THREE.BufferGeometry, hex: number): THREE.Box3 {
  const c = new THREE.Color(hex);
  const pos = geo.getAttribute('position');
  const col = geo.getAttribute('color');
  const box = new THREE.Box3();
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(col.getX(i) - c.r) > 1e-3) continue;
    if (Math.abs(col.getY(i) - c.g) > 1e-3) continue;
    if (Math.abs(col.getZ(i) - c.b) > 1e-3) continue;
    box.expandByPoint(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  return box;
}


/**
 * The SEPARATE parts painted `hex` in a merged body, as one box each.
 *
 * `colourExtent` above returns the union, which is all you can ask of a colour
 * two different parts share — but when the parts do not touch (the nixie sign's
 * two cathode support rods per tube) the union is a box neither of them has,
 * and a rod that moved to the middle would still land inside it. `CircuitMass`
 * emits per-face vertices, so a solid is exactly one connected component under
 * "shares a vertex position", and union-find over rounded positions recovers
 * the original parts.
 */
function colourClusters(geo: THREE.BufferGeometry, hex: number): THREE.Box3[] {
  const c = new THREE.Color(hex);
  const pos = geo.getAttribute('position');
  const col = geo.getAttribute('color');
  const idx = geo.index;
  const n = idx ? idx.count : pos.count;
  const node = new Map<string, number>();
  const parent: number[] = [];
  const pts: number[][] = [];
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) { parent[r] = parent[parent[r]]; r = parent[r]; }
    return r;
  };
  const uni = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const isMine = (v: number): boolean =>
    Math.abs(col.getX(v) - c.r) < 1e-3 && Math.abs(col.getY(v) - c.g) < 1e-3
    && Math.abs(col.getZ(v) - c.b) < 1e-3;
  for (let i = 0; i + 2 < n; i += 3) {
    const ids = [0, 1, 2].map((k) => (idx ? idx.getX(i + k) : i + k));
    if (!ids.every(isMine)) continue;
    const ns = ids.map((v) => {
      const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      const key = `${f3(x)},${f3(y)},${f3(z)}`;
      let id = node.get(key);
      if (id === undefined) {
        id = parent.length;
        node.set(key, id);
        parent.push(id);
        pts.push([x, y, z]);
      }
      return id;
    });
    uni(ns[0], ns[1]);
    uni(ns[1], ns[2]);
  }
  const boxes = new Map<number, THREE.Box3>();
  for (let i = 0; i < parent.length; i++) {
    const r = find(i);
    const b = boxes.get(r) ?? new THREE.Box3().makeEmpty();
    b.expandByPoint(new THREE.Vector3(pts[i][0], pts[i][1], pts[i][2]));
    boxes.set(r, b);
  }
  return [...boxes.values()];
}

/** Triangles in a geometry. */
const triCount = (g: THREE.BufferGeometry): number =>
  (g.index ? g.index.count : g.attributes.position.count) / 3;

/**
 * Every cylinder in a merged body must use ONE segment count, and it has to sit
 * between the measured floor (12, see BODY_SEGS) and the demo's own 16. The
 * count is SOLVED for out of the triangle total rather than read from the
 * source, so the 8 / 10 / 12 / 14 salad the port arrived with comes out as a
 * non-integer and fails.
 */
function solveBodySegs(portGeo: THREE.BufferGeometry, parts: DemoPart[],
  isCyl: (g: THREE.BufferGeometry) => boolean, colours: number[]): number {
  let cyls = 0, other = 0;
  for (const p of parts) { if (isCyl(p.geo)) cyls++; else other += triCount(p.geo); }
  // Only the triangles painted a colour the DEMO also has: the port adds a
  // polarity stripe as geometry where the demo has it in the sleeve texture,
  // and a merged body cannot carry per-part textures.
  const want = colours.map((c) => new THREE.Color(c));
  const col = portGeo.getAttribute('color');
  const idx = portGeo.index;
  const n = idx ? idx.count : col.count;
  let mine = 0;
  for (let i = 0; i < n; i += 3) {
    const v = idx ? idx.getX(i) : i;
    if (want.some((c) => Math.abs(col.getX(v) - c.r) < 1e-3
      && Math.abs(col.getY(v) - c.g) < 1e-3 && Math.abs(col.getZ(v) - c.b) < 1e-3)) mine++;
  }
  return (mine - other) / (4 * cyls);
}

/** Merged-body parts compared BY COLOUR: the port paints each part with the
 *  demo's own hex, so the union extent per colour is a per-part diff. */
function bodyColourDiff(
  portGeo: THREE.BufferGeometry, parts: DemoPart[],
  colourOf: (matName: string) => number | undefined,
): { colour: number; demo: THREE.Box3; ours: THREE.Box3 }[] {
  const byColour = new Map<number, THREE.Box3>();
  for (const p of parts) {
    const c = colourOf(p.mat);
    if (c === undefined) continue;
    const b = byColour.get(c) ?? new THREE.Box3().makeEmpty();
    b.union(p.aabb);
    byColour.set(c, b);
  }
  return [...byColour].map(([colour, demo]) => ({
    colour, demo, ours: colourExtent(portGeo, colour),
  }));
}

// ── 1. 電解電容:捲邊溝槽那圈光 ────────────────────────────────────────────
// TWO footprints on purpose: the demo's tube radius is `max(0.12, r × 0.055)`
// and the floor only binds on the SMALL one (r 1.4 → 0.077 < 0.12). A single
// fat case never exercises it, which is exactly how a dropped floor survives.
for (const [bw, bd, bh] of [[7, 7, 12], [3, 3, 8]] as const) {
  const seed = ownZoneSeed();
  const box = boxOf(bw, bd, bh);
  const r = Math.max(1.4, Math.min(box.width, box.depth) * 0.46);
  const h = Math.max(3, box.height - 1.1);
  const FOOT = 0.6;
  const tag = `r=${r.toFixed(2)}`;
  const dParts = demoPartsOf(demo.electrolyticCap(r, h, 0).obj);
  const theirs = dParts.filter((p) => p.mat === 'capRingMat');
  const deco = style.buildBuildingDecoration!(box, seed, 'residential' as never)!;
  const ours = portPartsOf(deco).filter((p) => p.colour === MC.capRingMat);

  check(`demo: one crimp-groove ring on the capacitor (${tag})`, theirs.length === 1,
    `${theirs.length}`);
  check(`port: one ring instance, in the demo's colour (${tag})`, ours.length === 1,
    `${ours.length}`);
  if (theirs.length === 1 && ours.length === 1) {
    const d = theirs[0], o = ours[0];
    const demoDrop = (0.6 + h) - d.pos[1];
    const ourDrop = (FOOT + h) - o.pos[1];
    check(`ring sits the demo's distance BELOW the can top (${tag})`,
      near(demoDrop, ourDrop), `demo ${demoDrop.toFixed(4)} vs ours ${ourDrop.toFixed(4)}`);
    // What the rider actually reads is the ring's VERTICAL thickness: from
    // 6.3 m eye height this groove is seen almost edge-on. That one is exact,
    // demo floor and all.
    check(`ring vertical extent = the demo's, max(0.12, 0.055r) floor included (${tag})`,
      near(d.aabb.min.y, o.aabb.min.y) && near(d.aabb.max.y, o.aabb.max.y),
      `demo ${d.aabb.min.y.toFixed(4)}..${d.aabb.max.y.toFixed(4)} vs `
      + `ours ${o.aabb.min.y.toFixed(4)}..${o.aabb.max.y.toFixed(4)}`);
    // RADIAL is the one measured deviation: a shared unit torus can only carry
    // ONE tube/radius ratio, so the floor cannot reach that axis. Worst case is
    // the smallest can the layout allows (r = 1.4): demo 0.120, ours 0.077.
    const gap = d.aabb.max.x - o.aabb.max.x;
    check(`ring radial extent: the demo's, or at most the measured 0.043 m thinner (${tag})`,
      gap >= -1e-3 && gap <= 0.0435,
      `demo ±${d.aabb.max.x.toFixed(4)} vs ours ±${o.aabb.max.x.toFixed(4)} (gap ${gap.toFixed(4)})`);
    check(`ring facets = the demo's torus, same vertex count (${tag})`,
      d.geo.attributes.position.count === o.geo.attributes.position.count,
      `demo ${d.geo.attributes.position.count} verts, ours ${o.geo.attributes.position.count}`);
  }
  const bodyGeo = style.buildBuildingBody!(box, seed, 'residential' as never)!;
  bodyGeo.computeBoundingBox();
  const demoTop = Math.max(...dParts.filter((p) => p.mat !== 'capRingMat')
    .map((p) => p.aabb.max.y));
  check(`body top = the demo's — alu lid seated in the sleeve, score bar on it (${tag})`,
    near(demoTop, bodyGeo.boundingBox!.max.y),
    `demo ${demoTop.toFixed(4)} vs ours ${bodyGeo.boundingBox!.max.y.toFixed(4)}`);
  // Every merged part, by the colour the demo painted it. The skirt-buried
  // insulating foot is the one part the port lengthens on purpose (the demo's
  // props never stand on a slope), so it is compared from its TOP down.
  const tint = Math.floor(mulberry32((seed * 3266489917 + 0x51c) >>> 0)() * 3);
  const sleeveOf = (m: string): number | undefined =>
    (m.startsWith('capSleeve') ? CAP_SLEEVES_DEMO[tint] : MC[m]);
  const cmp = bodyColourDiff(bodyGeo, dParts.filter((p) => p.mat !== 'capRingMat'), sleeveOf);
  for (const { colour, demo: dd, ours: oo } of cmp) {
    const skirted = colour === MC.icMat;   // the foot + the score bars share E.ic
    check(`cap body part #${colour.toString(16)} = the demo's box (${tag})`,
      near(dd.min.x, oo.min.x, 2e-3) && near(dd.max.x, oo.max.x, 2e-3)
      && near(dd.min.z, oo.min.z, 2e-3) && near(dd.max.z, oo.max.z, 2e-3)
      && near(dd.max.y, oo.max.y, 2e-3) && (skirted || near(dd.min.y, oo.min.y, 2e-3)),
      `demo ${aabbKey(dd)} | ours ${aabbKey(oo)}`);
  }
  const segs = solveBodySegs(bodyGeo, dParts.filter((p) => p.mat !== 'capRingMat'),
    (g) => g === demo.unitCyl, cmp.map((c) => c.colour));
  check(`merged body: ONE cylinder tessellation, 12 ≤ n ≤ the demo's 16 (${tag})`,
    Number.isInteger(segs) && segs >= 12 && segs <= 16, `n = ${segs}`);
  bodyGeo.dispose();
  disposeDeco(deco);
}

// ── 2. 真空管:柵極(9 圈細絲 + 2 根支撐柱) ───────────────────────────────
{
  // Wide enough that the port's footprint clamp on R does not bind, so the
  // demo's own R = H × 0.15 is what both sides are drawing.
  const box = boxOf(22, 22, 60);
  const deco = style.buildBuildingDecoration!(box, 7, null as never)!;
  const theirs = demoPartsOf(demo.vacuumTube(box.height, () => 0.5, null).obj)
    .filter((p) => p.mat === 'gridMat');
  const ours = portPartsOf(deco).filter((p) => p.colour === MC.gridMat);
  check('demo: the grid is 9 spiral rings + 2 support rods', theirs.length === 11, `${theirs.length}`);
  check('port: the same 11 grid parts, box for box', sameParts(theirs, ours),
    `demo ${theirs.length} vs ours ${ours.length}`);
  // The glass envelope — cylinder + dome — is the one place the demo's 16-sided
  // `unitCyl` is visible through the port's instanced trim.
  const dGlass = demoPartsOf(demo.vacuumTube(box.height, () => 0.5, null).obj)
    .filter((p) => p.mat === 'glassMat');
  const oGlass = portPartsOf(deco).filter((p) => p.colour === MC.glassMat);
  check('glass envelope = the demo\'s cylinder + dome, box for box',
    sameParts(dGlass, oGlass), `demo ${dGlass.length} vs ours ${oGlass.length}`);
  check('…at the demo\'s facet counts (unitCyl 16, unitHemi 16×8)',
    dGlass.reduce((n, p) => n + p.geo.attributes.position.count, 0)
    === oGlass.reduce((n, p) => n + p.geo.attributes.position.count, 0),
    `demo ${dGlass.reduce((n, p) => n + p.geo.attributes.position.count, 0)} verts vs `
    + `ours ${oGlass.reduce((n, p) => n + p.geo.attributes.position.count, 0)}`);
  disposeDeco(deco);
}

// ── 3. 輝光管:亮著的數字前面那片暈 ────────────────────────────────────────
{
  const seed = ownZoneSeed();
  const box = boxOf(14, 8, 16);
  const deco = style.buildBuildingDecoration!(box, seed, 'commercial' as never)!;
  const ours = portPartsOf(deco).filter((p) => p.additive);
  const glass = portPartsOf(deco).filter((p) => p.colour === MC.glassMat);
  const theirs = demoPartsOf(demo.nixieSign(box.height, mulberry32(1)).obj)
    .filter((p) => p.mat === 'nixieHaloMat');
  check('demo: an additive halo in front of every lit digit', theirs.length > 0,
    `${theirs.length} halo(s), ${theirs.length ? 'glowQuad' : '-'}`);
  // The port's tube count comes off the footprint, so the invariant is
  // "one halo per glass envelope", which is what the demo does.
  const tubes = glass.length / 2;   // cylinder + dome per tube
  check('port: one halo per tube', ours.length === tubes,
    `${ours.length} halo(s) for ${tubes} tube(s)`);
  if (ours.length) {
    const m = ours[0].mat as THREE.MeshPhongMaterial;
    setNightLitFactor(1);
    check('halo glows in the demo\'s colour at the demo\'s peak',
      m.emissive.getHex() === MC.nixieHaloMat && near(m.emissiveIntensity, demoHaloPeak, 1e-9),
      `#${m.emissive.getHexString()} × ${m.emissiveIntensity} vs demo `
      + `#${MC.nixieHaloMat.toString(16)} × ${demoHaloPeak}`);
    setNightLitFactor(0);
    check('…and adds nothing by day (emissive 0, additive blend)',
      m.emissive.getHex() === 0 && m.blending === THREE.AdditiveBlending
      && m.color.getHex() === 0 && m.depthWrite === false);
    check('halo quad is square and unscaled in z, like the demo\'s',
      near(theirs[0].scale[0], theirs[0].scale[1]) && near(theirs[0].scale[2], 1)
      && near(ours[0].scale[0], ours[0].scale[1]) && near(ours[0].scale[2], 1));
  }
  disposeDeco(deco);
}

// ── 4. 變壓器:兩個尺寸的 rng 抽取順序 ──────────────────────────────────────
{
  const seed = ownZoneSeed();
  const box = boxOf(26, 22, 14);
  const rng = mulberry32((seed * 3266489917 + 0x51c) >>> 0);
  const dBox = demo.transformer(box.height, rng).box as { across: number; along: number };
  const demoW = dBox.across / 1.18, demoD = dBox.along / 1.06;
  const bodyGeo = style.buildBuildingBody!(box, seed, 'industrial' as never)!;
  // The laminations are the ONE part whose extents are exactly (W, D) — the
  // bobbin cheeks stick out past the base on both sides, in the demo too.
  const a = colourExtent(bodyGeo, 0x98a0a8);
  const b = colourExtent(bodyGeo, 0x6b727a);
  const lam = a.union(b);
  check('transformer W (across) = demo W + footprint term — the FIRST rng draw',
    near(demoW + box.depth * 0.2, lam.max.z - lam.min.z),
    `demo ${(demoW + box.depth * 0.2).toFixed(4)} vs ours ${(lam.max.z - lam.min.z).toFixed(4)}`);
  check('transformer D (along, the lamination axis) = demo D + term — the SECOND draw',
    near(demoD + box.width * 0.2, lam.max.x - lam.min.x),
    `demo ${(demoD + box.width * 0.2).toFixed(4)} vs ours ${(lam.max.x - lam.min.x).toFixed(4)}`);
  bodyGeo.dispose();
}

// ── 5. DIP:封蓋座在本體裡,腳與焊錫圓角逐件相同 ────────────────────────────
//
// 尺寸**由 demo 自己的 `dipDims` 決定**,不是把移植裡那條公式抄過來 —— 抄過來
// 的公式只會把當初打錯的東西再確認一遍(§0.0 第 5 點)。這一段先問 demo 要
// `dipDims(H, rng)`,再反推出一個會讓 `dipLayout` 算出同一組 (w, d, h) 的
// footprint:port 的 `w = max(6, L × 0.94)` / `d = max(3, W × 0.8)`,所以
// `L = w / 0.94`、`W = d / 0.8`。高度是 demo 的 `3.4 + H × 0.24` —— demo 的
// `dipDims` **不抽亂數給高度**(它的兩個 rng 抽取都給了長與寬),而
// 「抽到的高度往長度長,不往高度長」正是它寫在那一行的紅字。
const DIP_H = 16;
const dipDim = demo.dipDims(DIP_H, mulberry32(0xd19)) as unknown as
  { w: number; d: number; h: number };
/** A footprint whose `dipLayout` reproduces the demo's own `dipDims` exactly. */
const dipFoot = (swap: boolean): never =>
  (swap ? boxOf(dipDim.d / 0.8, dipDim.w / 0.94, DIP_H)
    : boxOf(dipDim.w / 0.94, dipDim.d / 0.8, DIP_H));
{
  const seed = ownZoneSeed();
  const box = dipFoot(false);
  const bodyGeo = style.buildBuildingBody!(box, seed, 'school' as never)!;
  bodyGeo.computeBoundingBox();
  const theirs = demoPartsOf(demo.dipIC(dipDim.w, dipDim.d, dipDim.h, demo.DIP_BLACK));
  const demoTop = Math.max(...theirs
    .filter((p) => p.mat !== 'dipWinMat' && p.mat !== 'solderMat')
    .map((p) => p.aabb.max.y));
  check('DIP body top = the demo\'s (lid half-sunk in the package, dimple on it)',
    near(demoTop, bodyGeo.boundingBox!.max.y),
    `demo ${demoTop.toFixed(4)} vs ours ${bodyGeo.boundingBox!.max.y.toFixed(4)}`);
  bodyGeo.dispose();

  const deco = style.buildBuildingDecoration!(box, seed, 'school' as never)!;
  const port = portPartsOf(deco);
  const dLeg = theirs.filter((p) => p.mat === 'pinMat');
  const oLeg = port.filter((p) => p.colour === MC.pinMat);
  const dSol = theirs.filter((p) => p.mat === 'solderMat');
  const oSol = port.filter((p) => p.colour === MC.solderMat);
  check('every DIP leg the demo emits (knee + drop, both rows), box for box',
    sameParts(dLeg, oLeg), `demo ${dLeg.length} vs ours ${oLeg.length}`);
  check('every solder fillet, at the demo\'s size and height',
    sameParts(dSol, oSol), `demo ${dSol.length} vs ours ${oSol.length}`);
  // 引腳根部那一排窗。這一條以前不存在,而那正是它要抓的東西:窗走
  // `buildBuildingLights` + `facadeWindows` 的共用模板時,只有**位置**能對得上
  // demo,尺寸是全世界同一塊 `BoxGeometry(1.0, 0.55, 0.16)` —— 這條 DIP 上 demo
  // 的窗是 0.98 × 1.45,而移植畫 1.00 × 0.55(窗高只有 38%)。比包圍盒就抓得到,
  // 因為包圍盒同時帶位置**與尺寸**。
  const dWin = theirs.filter((p) => p.mat === 'dipWinMat');
  const oWin = port.filter((p) => p.colour === MC.dipWinMat);
  check('引腳根部那一排窗 = demo dipIC 的 box(step * 0.42, h * 0.2, 0.16),box for box',
    sameParts(dWin, oWin) && dWin.length > 0,
    `demo ${dWin.length} vs ours ${oWin.length}`);
  // …and triangle for triangle. `sameParts` above only sees boxes: a leg with a
  // reversed index buffer, or a fillet whose 8 facets were re-derived by hand,
  // has exactly the same box.
  for (const [what, dp, op] of [['leg', dLeg, oLeg], ['fillet', dSol, oSol]] as const) {
    const A = streamOf(dp), B = streamOf(op);
    const at = streamDiff(A, B);
    check(`…and the same ${what} triangles — winding, geometric AND shading normals`,
      at < 0 && A.length > 0,
      at < 0 ? `${A.length} tris` : `first差異 #${at}\n        demo ${A[at]?.key}\n        ours ${B[at]?.key}`);
  }
  disposeDeco(deco);
}

// ── 7. dipBox:哪一邊沿路、哪一邊垂直路面,以及封裝頂面在哪 ────────────────
// demo `const dipBox = (dim) => ({ across: dim.d, along: dim.w, h: dim.h + DIP_LIFT })`
// —— **長邊(w)沿路**、短邊(d)垂直路面,而它宣告的高度是**封裝本體的頂面**
// (不含封蓋與凹點)。gameview 沒有「路在哪一邊」可問,它只有 footprint,所以這
// 個合約在移植裡的形狀是:長邊落在 footprint 的長軸上,短邊落在短軸上 —— 兩種
// footprint 方向都要成立,不然同一棟樓會依「地圖剛好哪一邊比較長」轉 90°。
{
  const seed = ownZoneSeed();
  const dBox = demo.dipBox(dipDim) as unknown as
    { across: number; along: number; h: number };
  for (const swap of [false, true]) {
    const box = dipFoot(swap) as unknown as { width: number; depth: number };
    const tag = `${box.width > box.depth ? 'long-x' : 'long-z'}`;
    const bodyGeo = style.buildBuildingBody!(box as never, seed, 'school' as never)!;
    // The package block is the one part painted the demo's `icMat`; the lid and
    // the pin-1 dimple are `icTopMat`, so this extent IS `dipBox`.
    const pkg = colourExtent(bodyGeo, MC.icMat);
    const along = box.width > box.depth ? pkg.max.x - pkg.min.x : pkg.max.z - pkg.min.z;
    const across = box.width > box.depth ? pkg.max.z - pkg.min.z : pkg.max.x - pkg.min.x;
    check(`dipBox.along = the demo's (long side ON the long footprint axis) (${tag})`,
      near(dBox.along, along, 2e-3), `demo ${dBox.along.toFixed(4)} vs ours ${along.toFixed(4)}`);
    check(`dipBox.across = the demo's (short side across it) (${tag})`,
      near(dBox.across, across, 2e-3), `demo ${dBox.across.toFixed(4)} vs ours ${across.toFixed(4)}`);
    check(`dipBox.h = the demo's — package top, lid NOT counted (${tag})`,
      near(dBox.h, pkg.max.y, 2e-3), `demo ${dBox.h.toFixed(4)} vs ours ${pkg.max.y.toFixed(4)}`);
    bodyGeo.dispose();
  }
}

// ── 8. longDip:dipIC 轉 90°,而且是**轉**不是**鏡射** ─────────────────────
// `longDip` 的全部內容就是 `inner.rotation.y = Math.PI / 2`。移植沒有那一行,它
// 用一個 (a, b) → (x, z) 的映射代替,而那個映射原本寫成 `[b, a]` —— 那是**反
// 射**,不是旋轉。反射過的 DIP 一腳記號的凹點會跑到對角,而包圍盒、三角形數、
// 甚至整組腳(它們左右對稱)全部一模一樣。
// 這裡把整棟樓(合併本體的逐色範圍 + 每一支腳 + 每一顆焊錫 + 每一格引腳窗)拿去
// 跟 demo 的 `longDip` 對位,列舉繞 y 的四個旋轉與它們的四個鏡射,要求**至少有
// 一個純旋轉**對得上。
{
  const seed = ownZoneSeed();
  const pt = (v: THREE.Vector3): { aabb: THREE.Box3 } => ({ aabb: new THREE.Box3(v, v) });
  const built = demo.schoolDip(DIP_H, mulberry32(0xd19)) as unknown as {
    obj: unknown; lights: unknown[];
  };
  const dParts = demoPartsOf(built.obj);
  const dFeat: { aabb: THREE.Box3 }[] = [
    ...dParts.filter((p) => p.mat === 'pinMat' || p.mat === 'solderMat'),
    // 本體是合併的,所以逐色的**聯集範圍**就是它可比的粒度。封蓋 + 凹點同色,
    // 而凹點只戳出封蓋的一角 —— 那個不對稱就是這一段真正在量的東西。
    { aabb: dParts.filter((p) => p.mat === 'icMat')
      .reduce((b, p) => b.union(p.aabb), new THREE.Box3().makeEmpty()) },
    { aabb: dParts.filter((p) => p.mat === 'icTopMat')
      .reduce((b, p) => b.union(p.aabb), new THREE.Box3().makeEmpty()) },
    ...dParts.filter((p) => p.mat === 'dipWinMat')
      .map((p) => pt(p.aabb.getCenter(new THREE.Vector3()))),
  ];
  for (const swap of [false, true]) {
    const box = dipFoot(swap) as unknown as { width: number; depth: number };
    const tag = `${box.width > box.depth ? 'long-x' : 'long-z'}`;
    const bodyGeo = style.buildBuildingBody!(box as never, seed, 'school' as never)!;
    const deco = style.buildBuildingDecoration!(box as never, seed, 'school' as never)!;
    const port = portPartsOf(deco);
    // 引腳窗以前走 `buildBuildingLights` + 一塊全世界共用的 `facadeWindows` 模板;
    // demo 把它畫在 `dipIC()` 本體裡,移植現在也是(trim 的 dipWin 那一批)。
    // 所以這裡改成從**建出來的東西**認它 —— 用材質顏色,跟旁邊的腳與焊點同一招。
    const wins = port.filter((p) => p.colour === MC.dipWinMat);
    const oFeat: { aabb: THREE.Box3 }[] = [
      ...port.filter((p) => p.colour === MC.pinMat || p.colour === MC.solderMat),
      { aabb: colourExtent(bodyGeo, MC.icMat) },
      { aabb: colourExtent(bodyGeo, MC.icTopMat) },
      ...wins.map((w) => pt(w.aabb.getCenter(new THREE.Vector3()))),
    ];
    const hits = framesMatching(dFeat, oFeat);
    check(`longDip: the demo's DIP turned 90°, never mirrored (${tag})`,
      hits.some(([, , mirror]) => !mirror),
      hits.length ? hits.map(([n]) => n).join(' / ')
        : `no frame lines up (demo ${dFeat.length} features, ours ${oFeat.length})`);
    if (!hits.length) dumpFrames(dFeat, oFeat);
    check(`…every pin-root window the demo declares, same count, same places (${tag})`,
      wins.length === dParts.filter((p) => p.mat === 'dipWinMat').length && wins.length > 0,
      `demo ${dParts.filter((p) => p.mat === 'dipWinMat').length} vs ours ${wins.length}`);
    // …and the legs and fillets triangle for triangle IN THAT FRAME, so the
    // turned footprint gets the same scrutiny as the un-turned one.
    {
      const frame = streamFrame(hits);
      const A = streamOf(dParts.filter((p) => p.mat === 'pinMat' || p.mat === 'solderMat'), frame);
      const B = streamOf(port.filter((p) =>
        p.colour === MC.pinMat || p.colour === MC.solderMat));
      const at = streamDiff(A, B);
      check(`…and every leg / fillet triangle in that same frame (${tag})`,
        at < 0 && A.length > 0,
        at < 0 ? `${A.length} tris`
          : `first差異 #${at}\n        demo ${A[at]?.key}\n        ours ${B[at]?.key}`);
    }
    bodyGeo.dispose();
    disposeDeco(deco);
  }
}

// ── 9. hospitalDip + indicatorLed:白陶瓷的皮,加上旁邊那顆紅 LED ───────────
// demo `hospitalDip` 宣告 `{ kind: 'led', x: 0, y: dim.h + DIP_LIFT + 0.4, z: 0,
// s: 1.5 }`,而 `indicatorLed(s)` 是 `ledBody(0.56 * s, ledRedMat, ledRedDieMat)`
// —— 也就是**路燈的那一份 ledBody**,只是半徑不同。移植寫死 0.84;0.56 × 1.5
// 確實等於 0.84,但那是巧合等式,要由 demo 自己算出來才算數。
{
  const seed = ownZoneSeed();
  const built = demo.hospitalDip(DIP_H, mulberry32(0xd19)) as unknown as {
    obj: unknown; lights: { kind: string; x: number; y: number; z: number; s: number }[];
  };
  demo.addBuildingLights(built.obj, built.lights);
  // Optional-chained on purpose: a check that throws prints no ✗ at all, and a
  // mutation run then reads as "nothing detected it" (this one did, once).
  const led = built.lights.find((l) => l.kind === 'led');
  const dParts = demoPartsOf(built.obj);
  const dLed = dParts.filter((p) => p.mat === 'ledRedMat' || p.mat === 'ledRedDieMat'
    || p.mat === 'ledCupMat');
  check('demo: the hospital DIP declares exactly one LED, and it is ledBody(0.56 × s)',
    built.lights.length === 1 && led?.s === 1.5 && dLed.length === 8,
    `s=${led?.s}, ${dLed.length} LED parts`);
  // 陶瓷皮:demo 的 DIP_CERAMIC = { ceramicMat, kovarLidMat, goldPinMat }。
  const seedH = seed;
  for (const swap of [false, true]) {
    const box = dipFoot(swap) as unknown as { width: number; depth: number };
    const tag = `${box.width > box.depth ? 'long-x' : 'long-z'}`;
    const bodyGeo = style.buildBuildingBody!(box as never, seedH, 'hospital' as never)!;
    const deco = style.buildBuildingDecoration!(box as never, seedH, 'hospital' as never)!;
    const port = portPartsOf(deco);
    const oLed = port.filter((p) => p.colour === MC.ledRedMat || p.colour === MC.ledRedDieMat
      || p.colour === MC.ledCupMat);
    check(`hospital skin is the demo's ceramic + kovar, not the black package (${tag})`,
      !colourExtent(bodyGeo, MC.ceramicMat).isEmpty()
      && !colourExtent(bodyGeo, MC.kovarLidMat).isEmpty()
      && colourExtent(bodyGeo, MC.icMat).isEmpty(),
      `#${MC.ceramicMat.toString(16)} / #${MC.kovarLidMat.toString(16)}`);
    check(`hospital legs are the demo's gold pins, not tin (${tag})`,
      port.some((p) => p.colour === MC.goldPinMat)
      && !port.some((p) => p.colour === MC.pinMat));
    // The LED is CHIRAL — flat cathode side on −x, tall anvil on −x, short post
    // on +x — but its own bounding boxes are symmetric across z, so matched on
    // its OWN it accepts any orientation you like. A mutation run proved that:
    // dropping the LED's frame rotation altogether failed nothing. So the frame
    // is the PACKAGE's, decided by the legs and the ceramic skin, and the LED
    // has to be in it — which is what the demo does when it drops the LED into
    // `longDip`'s wrap unrotated.
    const dPkg: { aabb: THREE.Box3 }[] = [
      ...dParts.filter((p) => p.mat === 'goldPinMat' || p.mat === 'solderMat'),
      { aabb: dParts.filter((p) => p.mat === 'ceramicMat')
        .reduce((b, p) => b.union(p.aabb), new THREE.Box3().makeEmpty()) },
      { aabb: dParts.filter((p) => p.mat === 'kovarLidMat')
        .reduce((b, p) => b.union(p.aabb), new THREE.Box3().makeEmpty()) },
    ];
    const oPkg: { aabb: THREE.Box3 }[] = [
      ...port.filter((p) => p.colour === MC.goldPinMat || p.colour === MC.solderMat),
      { aabb: colourExtent(bodyGeo, MC.ceramicMat) },
      { aabb: colourExtent(bodyGeo, MC.kovarLidMat) },
    ];
    const pkgHits = framesMatching(dPkg, oPkg);
    const frame = streamFrame(pkgHits);
    check(`indicatorLed sits in the PACKAGE's frame, box for box (${tag})`,
      pkgHits.some(([, , mirror]) => !mirror) && frameFits(dLed, oLed, frame),
      `package frame ${pkgHits.map(([n]) => n).join(' / ') || 'NONE'}; `
      + `demo ${dLed.length} LED parts vs ours ${oLed.length}`);
    {
      const A = streamOf(dLed, frame), B = streamOf(oLed);
      const at = streamDiff(A, B);
      check(`…triangle for triangle, facets and shading normals included (${tag})`,
        at < 0 && A.length > 0,
        at < 0 ? `${A.length} tris`
          : `first差異 #${at}\n        demo ${A[at]?.key}\n        ours ${B[at]?.key}`);
      // Height above the package is the demo's own `dim.h + DIP_LIFT + 0.4`.
      const dY = Math.min(...dLed.map((p) => p.aabb.min.y));
      const oY = Math.min(...oLed.map((p) => p.aabb.min.y));
      check(`…seated the demo's distance above the package (${tag})`, near(dY, oY, 2e-3),
        `demo ${dY.toFixed(4)} vs ours ${oY.toFixed(4)}`);
    }
    bodyGeo.dispose();
    disposeDeco(deco);
  }
}

// ── 10. nixieDigit / nixieSign:一管一組數字,而且字不能反過來 ──────────────
// demo 的三個數字是在 `for (let i = 0; i < tubes; i++)` **裡面**抽的,所以每一管
// 有自己的三個。移植把那段抬到迴圈外,整面招牌因此每管都亮同一個數字。
// 而數字本身是有手性的:七段的 b(右上)/ e(左下)分得出左右,鏡射過的「2」讀
// 起來是「S」。包圍盒與三角形數對這兩件事**完全看不見**。
{
  const seed = ownZoneSeed();
  const NIX_H = 16;
  // 這個 footprint 讓移植的每一個夾擠都不咬:r = 1.25 + H×0.045(< W×0.42)、
  // sd = r×2.7(< W)、tubes = floor(L / pitch) = 3(demo 的 2 + floor(rng×2)
  // 抽得到 3)。夾擠一咬,兩邊畫的就不是同一支招牌了。
  const nixFoot = (swap: boolean): never =>
    (swap ? boxOf(8, 16, NIX_H) : boxOf(16, 8, NIX_H));
  const dr = mulberry32((seed * 3266489917 + 0x51c) >>> 0);
  let first = true;
  // demo 的第一個抽取是管數(`2 + floor(rng() * 2)`),移植的管數改由 footprint
  // 決定(gameview 有 footprint,demo 沒有),所以只有這一個值是餵進去的;數字
  // 那一串**是移植自己的流**,一個值都沒有改。
  const shim = (): number => {
    if (first) { first = false; return 0.75; }   // → 2 + floor(1.5) = 3 tubes
    return dr();
  };
  const dSign = demo.nixieSign(NIX_H, shim) as unknown as { obj: unknown };
  const dParts = demoPartsOf(dSign.obj);
  const dCath = dParts.filter((p) => p.mat === 'cathodeMat');
  // 陰極支撐棒 = `box(0.3, bodyH * 0.72, 0.3)`,比任何一段數字都高得多,所以用
  // 高度就分得開(數字最高的一段是 dw × 1.6 × 1.22 / 2)。
  const rodH = Math.max(...dCath.map((p) => p.aabb.max.y - p.aabb.min.y));
  const dRod = dCath.filter((p) => near(p.aabb.max.y - p.aabb.min.y, rodH, 1e-6));
  const dDark = dCath.filter((p) => !near(p.aabb.max.y - p.aabb.min.y, rodH, 1e-6));
  const dLit = dParts.filter((p) => p.mat === 'nixieLitMat');
  check('demo: 3 tubes × 2 cathode support rods hold the digit stack up',
    dRod.length === 6, `${dRod.length} rods, ${dDark.length} dark segments`);
  /**
   * Lit segments per tube, ordered along whichever axis the tubes are strung
   * out on. If every tube is fed the SAME digit — the port's bug — the three
   * counts are necessarily identical, so this reads the sign the way a rider
   * does: three different numerals or one numeral three times.
   */
  const perTube = (
    lit: { aabb: THREE.Box3 }[], tubes: { aabb: THREE.Box3 }[], axis: 'x' | 'z',
  ): number[] => {
    const c = (b: THREE.Box3): number => (axis === 'x'
      ? (b.min.x + b.max.x) : (b.min.z + b.max.z)) / 2;
    const centres = [...new Set(tubes.map((t) => c(t.aabb).toFixed(3)))]
      .map(Number).sort((a, b) => a - b);
    // Catchment = half the tube spacing, so every segment of a digit lands in
    // its own tube and none of them lands in two. A fixed radius would quietly
    // drop the two upright segments (they sit at ±dw/2 ≈ 1.3 m) and count only
    // the horizontal bars.
    const half = centres.length > 1
      ? Math.min(...centres.slice(1).map((v, i) => v - centres[i])) / 2 : 1e9;
    return centres.map((k) => lit.filter((p) => Math.abs(c(p.aabb) - k) < half).length);
  };
  const dPer = perTube(dLit, dParts.filter((p) => p.mat === 'glassMat'), 'z');
  check('demo: the three tubes show three DIFFERENT numerals (rng draws inside the tube loop)',
    dPer.length === 3 && new Set(dPer).size > 1, `segments per tube ${dPer.join('/')}`);

  for (const swap of [false, true]) {
    const box = nixFoot(swap) as unknown as { width: number; depth: number };
    const tag = `${box.width > box.depth ? 'long-x' : 'long-z'}`;
    const axis = box.width > box.depth ? 'x' : 'z';
    const bodyGeo = style.buildBuildingBody!(box as never, seed, 'commercial' as never)!;
    const deco = style.buildBuildingDecoration!(box as never, seed, 'commercial' as never)!;
    const port = portPartsOf(deco);
    const oGlass = port.filter((p) => p.colour === MC.glassMat);
    check(`port: the demo's 3 tubes (glass tube + dome each) (${tag})`,
      oGlass.length === 6, `${oGlass.length} glass parts`);
    // 支撐棒住在合併本體裡,所以按顏色抓出連通元件再逐根比。
    const oRod = colourClusters(bodyGeo, MC.cathodeMat).map((b) => ({ aabb: b }));
    const oLit = port.filter((p) => p.colour === MC.nixieLitMat);
    const oDark = port.filter((p) => p.colour === MC.cathodeMat);

    const feat = (
      rods: { aabb: THREE.Box3 }[], lit: { aabb: THREE.Box3 }[],
      dark: { aabb: THREE.Box3 }[], glass: { aabb: THREE.Box3 }[],
      lugs: { aabb: THREE.Box3 }[], halo: { aabb: THREE.Box3 }[],
    ): { aabb: THREE.Box3 }[] => [...rods, ...lit, ...dark, ...glass, ...lugs, ...halo];
    const dFeat = feat(dRod, dLit, dDark,
      dParts.filter((p) => p.mat === 'glassMat'),
      dParts.filter((p) => p.mat === 'pinMat'),
      dParts.filter((p) => p.mat === 'nixieHaloMat'));
    const oFeat = feat(oRod, oLit, oDark, oGlass,
      port.filter((p) => p.colour === MC.pinMat),
      port.filter((p) => p.additive));
    const hits = framesMatching(dFeat, oFeat);
    check(`the whole nixie sign IS the demo's, turned — never mirrored (${tag})`,
      hits.some(([, , mirror]) => !mirror),
      hits.length ? hits.map(([n]) => n).join(' / ')
        : `demo ${dFeat.length} features vs ours ${oFeat.length}`);
    if (!hits.length) dumpFrames(dFeat, oFeat);
    const rot = streamFrame(hits);
    // 陰極支撐棒:demo 每管兩根 `box(0.3, bodyH × 0.72, 0.3, cathodeMat)`。它們
    // 住在合併本體裡,所以逐根的證據是連通元件,不是聯集範圍 —— 聯集看不出一根
    // 跑到了中間。
    check(`cathode support rods: 2 per tube, at the demo's box (${tag})`,
      oRod.length === dRod.length && frameFits(dRod, oRod, rot),
      `demo ${dRod.length} vs ours ${oRod.length}`
      + (oRod.length ? ` @ ${oRod.map((r) => aabbKey(r.aabb)).sort()[0]}…` : ''));
    // 一管一組:三管的亮段數若被綁成同一個數字,三個計數必定相同。
    const oPer = perTube(oLit, oGlass, axis);
    const sorted = (v: number[]): string => [...v].sort((a, b) => a - b).join('/');
    check(`每管自己一組數字 — the demo's per-tube segment counts, tube for tube (${tag})`,
      sorted(oPer) === sorted(dPer) && new Set(oPer).size > 1,
      `demo ${dPer.join('/')} vs ours ${oPer.join('/')}`);
    {
      const streamParts = [
        ...dLit, ...dDark, ...dParts.filter((p) => p.mat === 'glassMat'),
        ...dParts.filter((p) => p.mat === 'pinMat'),
        ...dParts.filter((p) => p.mat === 'nixieHaloMat'),
      ];
      const oStreamParts = [
        ...oLit, ...oDark, ...oGlass, ...port.filter((p) => p.colour === MC.pinMat),
        ...port.filter((p) => p.additive),
      ];
      const A = streamOf(streamParts, rot), B = streamOf(oStreamParts);
      const at = streamDiff(A, B);
      check(`…and every glyph triangle, winding and shading normals included (${tag})`,
        at < 0 && A.length > 0,
        at < 0 ? `${A.length} tris`
          : `first差異 #${at}\n        demo ${A[at]?.key}\n        ours ${B[at]?.key}`);
    }
    bodyGeo.dispose();
    disposeDeco(deco);
  }
}

// ── 6. LED 的內臟(路燈 = demo 的 ledBody) ─────────────────────────────────
{
  const lamp = style.buildStreetLamp(0);
  const ours = portPartsOf(lamp.group).filter((p) => p.aabb.min.y > 5);
  const holder = { children: [demo.ledBody(1.7, 'lens', 'die')],
    position: { x: 0, y: 8.95, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 } };
  const theirs = demoPartsOf(holder);
  check('street lamp IS the demo\'s ledBody(1.7) — same parts, same boxes',
    sameParts(theirs, ours), `demo ${theirs.length} vs ours ${ours.length}`);
  // Facets too: a cylinder's bounding box is the same at 12 sides as at 16, so
  // the boxes alone would not notice the demo's 16-segment `unitCyl` being
  // rewritten down — which is the杯塔 failure verbatim.
  const dv = theirs.reduce((n, p) => n + p.geo.attributes.position.count, 0);
  const ov = ours.reduce((n, p) => n + p.geo.attributes.position.count, 0);
  check('…and the same facet counts (demo unitCyl is 16-sided, unitCyl8 is 8)',
    dv === ov, `demo ${dv} verts vs ours ${ov}`);
  if (!sameParts(theirs, ours)) {
    const a = theirs.map((p) => aabbKey(p.aabb)).sort();
    const b = ours.map((p) => aabbKey(p.aabb)).sort();
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) console.log(`      demo ${a[i]}\n      ours ${b[i]}`);
    }
  }
  lamp.dispose();
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');

/** How many assertions failed — so `diorama.ts` can fold this into its tally:
 *
 *   await block('circuit vs demo', async () => {
 *     for (const p of ['./circuit-board-vs-demo', './circuit-3d-vs-demo',
 *       './circuit-2d-vs-demo']) {
 *       failures += ((await import(p)) as { failureCount(): number }).failureCount();
 *     }
 *   });
 *
 * Never sets `process.exitCode` to 0: standalone it fails the run, imported it
 * leaves the host's exit code alone. */
export const failureCount = (): number => failures;
if (failures) process.exitCode = 1;
