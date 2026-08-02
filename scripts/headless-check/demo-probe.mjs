/**
 * Headless CPU preview for plan/*-demo.html.
 *
 * Runs the demo's OWN script under Node with a stubbed 2D canvas + a fake
 * WebGLRenderer (which just captures the scene/camera it is handed), then
 * rasterises the scene graph with a tiny z-buffer and writes a PNG.
 *
 * No WebGL, no browser. Textures don't render (the 2D context is a stub), so
 * shading = material.color x vertex colour x lambert. That is exactly what is
 * needed to check FORM: are the contour terraces there, is the ring inside-out,
 * are there holes.
 *
 *   node demo-probe.mjs <html> <out.png> [--eye x,y,z] [--target x,y,z] [--fov n]
 *
 * --focus <name> [--dist n]: frame a single named object instead of the whole
 * scene. Props are scattered by the chunk RNG, so you cannot know where any one
 * of them ended up; give the prop a .name in the demo and this finds the nearest
 * one to the camera and puts the camera in front of it. That is the only way to
 * check whether a small prop READS at all — from the follow cam a street lamp is
 * forty pixels tall and every silhouette looks alike.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { census, formatCensus, isShown } from './scene-census.mjs';

const [, , htmlPath, outPath, ...rest] = process.argv;
const opt = (name, dflt) => {
  const i = rest.indexOf('--' + name);
  return i < 0 ? dflt : rest[i + 1];
};
const vec = (s) => s.split(',').map(Number);

// ── 2D canvas stub: every call is a no-op, every property reads back ──
// STRICT=1 additionally rejects NaN/undefined coordinates and malformed colour
// strings. Those are the failure mode that matters for procedural textures:
// the real canvas silently draws NOTHING for a NaN argument, so the bug shows
// up only as a blank/black texture in the browser, with no error anywhere.
const STRICT = !!process.env.STRICT;
const ctxIssues = [];
const ops = new Map();
// Textures cannot rasterise here, so a mapped material would otherwise render as
// flat white and every world would look the same colour. Stand in the colour that
// covers the most of the canvas.
//
// "Background fillRect wins" was the first heuristic and it is wrong for exactly
// the case that matters most: the gouache painter lays down the PAPER as its
// background and then brushes the PAINT on in wide strokes, so every painted
// surface came back board-tan. Weigh by covered area instead — a fillRect counts
// w*h, a stroke counts lineWidth * canvas width — times alpha, with colours
// bucketed so the painter's per-stroke lightness jitter accumulates as one hue.
const canvasArea = new WeakMap();   // canvas -> Map(bucketKey -> {w, rgb})
const canvasBase = new WeakMap();   // resolved lazily from canvasArea

/** Largest accumulated colour bucket for a texture canvas. */
function dominantColor(img) {
  if (!img) return null;
  if (canvasBase.has(img)) return canvasBase.get(img);
  const bag = canvasArea.get(img);
  let best = null, bw = 0;
  if (bag) for (const e of bag.values()) if (e.w > bw) { bw = e.w; best = e.rgb; }
  canvasBase.set(img, best);
  return best;
}
function parseCol(v) {
  if (typeof v !== 'string') return null;
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16) / 255);
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) { const a = m[1].split(',').map(Number); return [a[0] / 255, a[1] / 255, a[2] / 255]; }
  return null;
}
const COLORISH = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|transparent$)/i;
function stubContext(tag, owner) {
  const gradient = { addColorStop: () => {} };
  let fillStyle = '#000000';
  let strokeStyle = '#000000';
  let lineWidth = 1;
  let alpha = 1;
  /** Accumulate covered area per bucketed colour. */
  const note = (style, area) => {
    if (!(area > 0)) return;
    const c = parseCol(style);
    if (!c) return;
    const m = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/i.exec(style);
    const a = alpha * (m ? Number(m[1]) : 1);
    if (!(a > 0.02)) return;
    let bag = canvasArea.get(owner);
    if (!bag) { bag = new Map(); canvasArea.set(owner, bag); }
    const key = c.map((v) => Math.round(v * 15)).join(',');
    const e = bag.get(key) ?? { w: 0, rgb: c };
    e.w += area * a;
    bag.set(key, e);
  };
  const noteFill = (args) => {
    // full-canvas fill => this is the texture's background colour.
    // Skip translucent ones: several procedural textures finish with a faint
    // full-canvas glaze (the gouache one lays down 5.5% white to look chalky).
    // Letting that win turns every painted surface into a white blank.
    if (args.length < 4) return;
    note(fillStyle, Math.abs(args[2] * args[3]));
  };
  /** Strokes have no cheap area; canvas width is a fair proxy for these
   *  full-width brush/hatch strokes and keeps the units comparable. */
  const noteStroke = () => note(strokeStyle, Math.abs(lineWidth) * (owner.width || 1));
  const check = (name, args) => {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (typeof a === 'number' && !Number.isFinite(a)) ctxIssues.push(`${tag}: ${name}() arg${i} = ${a}`);
      if (a === undefined && name !== 'getContext') ctxIssues.push(`${tag}: ${name}() arg${i} = undefined`);
    }
  };
  const target = {
    getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => {},
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    createPattern: () => null,
    measureText: () => ({ width: 0 }),
  };
  if (!STRICT) {
    return new Proxy(target, {
      get(t, p) {
        if (p in t) return t[p];
        if (p === 'fillRect') return (...a) => noteFill(a);
        if (p === 'stroke') return () => noteStroke();
        return typeof p === 'string' && /^[a-z]/.test(p) ? () => {} : undefined;
      },
      set(t, p, v) {
        if (p === 'fillStyle') fillStyle = v;
        if (p === 'strokeStyle') strokeStyle = v;
        if (p === 'lineWidth') lineWidth = v;
        if (p === 'globalAlpha') alpha = v;
        return true;
      },
    });
  }
  const props = {};
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p !== 'string') return undefined;
      if (p in props) return props[p];
      return /^[a-z]/.test(p) ? (...args) => {
        ops.set(tag, (ops.get(tag) ?? 0) + 1);
        check(p, args);
        if (p === 'fillRect') noteFill(args);
        if (p === 'stroke') noteStroke();
      } : undefined;
    },
    set(t, p, v) {
      props[p] = v;
      if (p === 'fillStyle') fillStyle = v;
      if (p === 'strokeStyle') strokeStyle = v;
      if (p === 'lineWidth') lineWidth = v;
      if (p === 'globalAlpha') alpha = v;
      if ((p === 'fillStyle' || p === 'strokeStyle') && typeof v === 'string' && !COLORISH.test(v)) {
        ctxIssues.push(`${tag}: ${p} = ${JSON.stringify(v)}`);
      }
      if ((p === 'globalAlpha' || p === 'lineWidth') && !Number.isFinite(v)) {
        ctxIssues.push(`${tag}: ${p} = ${v}`);
      }
      if (p === 'globalAlpha' && (v < 0 || v > 1)) ctxIssues.push(`${tag}: globalAlpha out of range = ${v}`);
      if (p === 'lineWidth' && v <= 0) ctxIssues.push(`${tag}: lineWidth <= 0 = ${v}`);
      return true;
    },
  });
}
let canvasSeq = 0;
const makeCanvas = () => {
  const tag = 'canvas#' + (canvasSeq++);
  let ctx = null;
  const c = {
    width: 0, height: 0,
    getContext: () => (ctx ||= stubContext(tag, c)),
    style: {}, addEventListener() {}, setPointerCapture() {},
  };
  return c;
};

const els = new Map();
const doc = {
  createElement: (tag) => (tag === 'canvas' ? makeCanvas() : { style: {}, addEventListener() {} }),
  createElementNS: () => makeCanvas(),
  getElementById: (id) => {
    if (!els.has(id)) els.set(id, { textContent: '', style: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {} });
    return els.get(id);
  },
  addEventListener() {},
};
const win = {
  devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 720,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  addEventListener() {},
  location: { search: process.env.QS ?? '' },
};
globalThis.window = win;
globalThis.document = doc;
globalThis.self = win;
globalThis.location = win.location;

// STEP_MS: fake a real-time clock so THREE.Clock hands out a usable dt and the
// bike actually travels (in Node the frame loop runs faster than the timer).
// ⚠ Keep the REST of the real `performance` object. Replacing it wholesale with
// `{ now }` broke every run that also fetches real tiles: undici's `fetch` calls
// `performance.markResourceTiming`, so `STEP_MS=… QS="?loc=taipei"` died with
// `TypeError: markResourceTiming is not a function` — and the two knobs a POC
// most wants together are "advance the clock so the chase cam converges" and
// "load a real place". Only `now` is overridden now.
if (process.env.STEP_MS) {
  let t = 0;
  const step = Number(process.env.STEP_MS);
  const real = globalThis.performance;
  const fake = Object.create(real ?? null);
  fake.now = () => (t += step);
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: fake });
}
const rafQueue = [];
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};

// ── pull the script blocks out of the HTML ──
// First is the bundled three.js, LAST is the demo itself; anything between them
// is a vendored library. The 3D demos carry one — the MVT decoder — and it
// deliberately has an `id` attribute so the CHECKS' bare-`<script>` regexes skip
// it (they slice the demo's own source and must not see 1500 lines of vendor).
// This probe is the one reader that must NOT skip it: without the decoder the
// demo cannot fetch real map tiles at all.
const html = readFileSync(htmlPath, 'utf8');
const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (blocks.length < 2) throw new Error(`expected >= 2 <script> blocks, got ${blocks.length}`);

new Function(blocks[0])();                       // three.js bundle -> window.THREE
const THREE = win.THREE;
globalThis.THREE = THREE;

// ── fake renderer: capture what it is asked to draw ──
let captured = null;
THREE.WebGLRenderer = class {
  constructor() {
    this.shadowMap = { enabled: false, type: 0 };
    this.domElement = makeCanvas();
    this.capabilities = { isWebGL2: true, getMaxAnisotropy: () => 1 };
  }
  setPixelRatio() {} setSize() {} setClearColor() {} dispose() {}
  render(scene, camera) { captured = { scene, camera }; }
};

for (let i = 1; i < blocks.length - 1; i++) new Function(blocks[i])();   // vendored libs
new Function(blocks[blocks.length - 1])();       // the demo itself

// QS="?loc=…" makes the demo fetch real DEM + MVT tiles. That work lands on the
// network/microtask queue and the frame pump below is SYNCHRONOUS, so without
// this await the probe would rasterise a world with no chunks in it and report
// a clean run. The demo publishes the promise; nothing else changes.
if (win.__geoPending) {
  console.log('waiting on real tiles…');
  try {
    await win.__geoPending;
    console.log('tiles loaded: ' + (win.__geoInfo ?? '(no summary)'));
  } catch (err) {
    throw new Error(`the demo's tile load rejected: ${err && err.message ? err.message : err}`);
  }
}

// drive a few frames so chunks stream in and the bike moves
for (let i = 0; i < Number(process.env.FRAMES ?? 6); i++) {
  const q = rafQueue.splice(0, rafQueue.length);
  for (const fn of q) fn(i * 16);
}
if (!captured) throw new Error('renderer.render was never called');
const { scene } = captured;

// ── camera ──
const W = 1280, H = 720;
// --democam: use whatever camera the demo itself handed to render() (i.e. the
// real follow/orbit shot), instead of an explicit eye/target.
const dc = captured.camera;
let eye, target, fov;
if (rest.includes('--democam')) {
  dc.updateMatrixWorld(true);
  eye = new THREE.Vector3().setFromMatrixPosition(dc.matrixWorld);
  target = eye.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(dc.quaternion).multiplyScalar(50));
  fov = dc.fov;
  console.log('democam eye', eye.toArray().map((v) => v.toFixed(1)).join(','));
} else if (opt('focus')) {
  const want = opt('focus');
  const dist = Number(opt('dist', 26));
  scene.updateMatrixWorld(true);
  const hits = [];
  scene.traverse((o) => { if (o.name === want) hits.push(o); });
  if (!hits.length) throw new Error(`--focus ${want}: no object with that name`);
  // Nearest to the demo camera, so the shot is one the rider would actually get.
  dc.updateMatrixWorld(true);
  const camPos = new THREE.Vector3().setFromMatrixPosition(dc.matrixWorld);
  const pos = (o) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
  hits.sort((a, b) => pos(a).distanceTo(camPos) - pos(b).distanceTo(camPos));
  // The bounding box can come back EMPTY: a world that flattens its chunk into
  // InstancedMesh pools moves the prop's meshes out of the group and leaves only
  // the lights behind. Fall back to the group's own origin plus a nominal eye
  // height so the shot still lands on the right spot.
  const bb = new THREE.Box3().setFromObject(hits[0]);
  target = bb.isEmpty()
    ? pos(hits[0]).add(new THREE.Vector3(0, Number(opt('focusy', 10)), 0))
    : bb.getCenter(new THREE.Vector3());
  // Stand off along the direction the demo camera already looks from, so the
  // lighting matches what the rider sees rather than an arbitrary angle.
  const dir = camPos.clone().sub(target).setY(0).normalize();
  if (!isFinite(dir.x) || dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
  eye = target.clone().add(dir.multiplyScalar(dist)).setY(target.y + dist * 0.18);
  fov = Number(opt('fov', 50));
  console.log(`focus ${want}: ${hits.length} found, nearest at ` +
    pos(hits[0]).toArray().map((v) => v.toFixed(1)).join(',') +
    `  size ${bb.getSize(new THREE.Vector3()).toArray().map((v) => v.toFixed(1)).join('x')}`);
} else {
  eye = new THREE.Vector3(...vec(opt('eye', '0,120,300')));
  target = new THREE.Vector3(...vec(opt('target', '0,20,0')));
  fov = Number(opt('fov', 50));
}
const focal = H / 2 / Math.tan((fov * Math.PI) / 360);
const camF = target.clone().sub(eye).normalize();
const camR = new THREE.Vector3().crossVectors(camF, new THREE.Vector3(0, 1, 0)).normalize();
const camU = new THREE.Vector3().crossVectors(camR, camF).normalize();

const img = Buffer.alloc(W * H * 3);
// background: pale paper so the silhouette reads
for (let i = 0; i < W * H; i++) { img[i * 3] = 226; img[i * 3 + 1] = 220; img[i * 3 + 2] = 200; }
const zbuf = new Float32Array(W * H).fill(Infinity);

// ── The light. READ OUT OF THE SCENE, not pinned. ────────────────────────────
//
// This used to be `new THREE.Vector3(150, 190, 90).normalize()` — the demos' OLD
// nailed-down sun — with a fixed `0.42 + 0.58 * n·L` on top, and it never looked
// at the scene at all. Since the day-phase slider landed (`?sky`, dc7c043) the
// key light swings from +47° at noon through 0° at sunrise to the moon at
// midnight, and its intensity is multiplied by `skyKeyGain` (zero on the
// horizon), so ALL SEVEN PHASES CAME OUT AS THE SAME PICTURE. Every "I looked at
// the PNG and the lighting was fine" in this repo's history was made with a
// probe that could not see the lighting.
//
// So: direction = `light.position − light.target.position` in world space,
// diffuse = the light's own intensity, fill = the ambient + hemisphere the scene
// actually carries. The two conversion factors are calibrated on the demos' own
// DAY table (`sunI: 2.0`, `hemiI: 0.9`, `amb: 0.35`, identical in all three) so
// that a noon frame comes out BYTE-FOR-BYTE as it did before — the old constants
// were 0.42 fill / 0.58 key, and 0.336 × 1.25 = 0.42, 0.29 × 2.0 = 0.58.
//
// NOT included: the light's COLOUR. This rasteriser's contract is
// `material.color × vertex colour × lambert` and colours out of it are already
// only a hint (CUSTOM_WORLD_INSTRUCTIONS §10.6); tinting every surface by the
// moon's blue would make that worse, not better.
const KEY_PER_UNIT = 0.58 / 2.0;
const FILL_PER_UNIT = 0.42 / (0.35 + 0.9);
const FALLBACK_SUN = new THREE.Vector3(150, 190, 90).normalize();
/**
 * The toon ramp, on `dotNL` — the old `lam < 0.55 ? 0.42 : … : 1.0` ladder
 * solved back for x through `lam = 0.42 + 0.58x`, so a noon frame is unchanged.
 */
const TOON_STEPS = [
  [(0.55 - 0.42) / 0.58, 0],
  [(0.78 - 0.42) / 0.58, (0.68 - 0.42) / 0.58],
  [(0.92 - 0.42) / 0.58, (0.86 - 0.42) / 0.58],
];
function toonStep(x) {
  for (const [edge, v] of TOON_STEPS) if (x < edge) return v;
  return 1;
}
/** Visible directional lights as `{ dir, k }`, plus the ambient/hemi floor. */
function readSceneLights(root) {
  const keys = [];
  let fillUnits = 0;
  // ⚠ "The key light is at intensity ZERO" is a REAL ANSWER, not a missing one.
  // `skyKeyGain` takes the sun to 0 at the horizon on purpose (the demos: 「平行
  // 地面的光照不亮地面…日出的地面本來就是天光照的」), so sunrise and sunset are
  // fill-only frames. Falling back to the pinned constant there — which the first
  // draft of this did — reinstated a 47.4° sun at FULL strength at exactly the
  // two phases whose whole point is that there isn't one.
  let sawDirectional = false;
  root.traverse((o) => {
    if (!o.isLight || !isShown(o)) return;
    if (o.isDirectionalLight) {
      sawDirectional = true;
      // `light.target` is an Object3D the demo parks in the scene and moves with
      // the rider; its world matrix is what makes the direction rider-relative.
      const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
      const t = new THREE.Vector3();
      // three's default target is a bare Object3D that was never added to the
      // scene, so its `matrixWorld` is stale identity — read `position` for
      // those, and the world matrix only for one the demo actually parented.
      if (o.target) {
        if (o.target.parent) t.setFromMatrixPosition(o.target.matrixWorld);
        else t.copy(o.target.position);
      }
      const dir = p.sub(t);
      if (dir.lengthSq() < 1e-12 || !(o.intensity > 0)) return;
      keys.push({ dir: dir.normalize(), k: KEY_PER_UNIT * o.intensity });
    } else if (o.isAmbientLight || o.isHemisphereLight) {
      fillUnits += o.intensity;
    }
  });
  if (!sawDirectional) keys.push({ dir: FALLBACK_SUN.clone(), k: 0.58 });
  return { keys, fill: fillUnits > 0 ? FILL_PER_UNIT * fillUnits : 0.42 };
}
const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
const na = new THREE.Vector3();
const pr = (v) => {
  const rel = v.clone().sub(eye);
  const zc = rel.dot(camF);
  if (zc < 0.3) return null;
  return [W / 2 + (rel.dot(camR) / zc) * focal, H / 2 - (rel.dot(camU) / zc) * focal, zc];
};

const stats = new Map();
let meshes = 0, tris = 0;
scene.updateMatrixWorld(true);
// After updateMatrixWorld: a directional light's direction is where it IS minus
// where it POINTS, and both are world positions.
const { keys: sunKeys, fill: sunFill } = readSceneLights(scene);
console.log('lights: fill ' + sunFill.toFixed(3) + '  key '
  + (sunKeys.length ? '' : '(none — the key light is at zero, this phase is fill only)')
  + sunKeys.map((k) => k.k.toFixed(3)
    + '@(' + k.dir.toArray().map((v) => v.toFixed(2)).join(',') + ')'
    + ' elev ' + ((Math.asin(k.dir.y) * 180) / Math.PI).toFixed(1) + '°').join(' '));
const instMat = new THREE.Matrix4();
scene.traverse((obj) => {
  if (!obj.isMesh) return;
  // Respect visibility: the demos park things like the lightning bolt in the
  // scene with visible=false and switch them on. traverse() does not prune, so
  // without this the probe draws props that are not actually on screen.
  if (!isShown(obj)) return;
  // InstancedMesh is NOT a special case worth skipping: the plastic theme draws
  // every stud that way, so skipping it hides the defining detail of the style.
  // Each instance is just obj.matrixWorld * instanceMatrix[i].
  const insts = obj.isInstancedMesh ? obj.count : 1;
  const g = obj.geometry;
  const pos = g?.getAttribute?.('position');
  if (!pos) return;
  const nor = g.getAttribute('normal');
  const col = g.getAttribute('color');
  const idx = g.index;
  const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
  if (mats.some((m) => m?.isShaderMaterial)) return;       // sky dome
  const groups = g.groups.length ? g.groups : [{ start: 0, count: idx ? idx.count : pos.count, materialIndex: 0 }];
  meshes++;
  for (let inst = 0; inst < insts; inst++) {
  if (obj.isInstancedMesh) {
    obj.getMatrixAt(inst, instMat);
    instMat.premultiply(obj.matrixWorld);
  } else instMat.copy(obj.matrixWorld);
  const nm = new THREE.Matrix3().getNormalMatrix(instMat);
  for (const grp of groups) {
    const mat = mats[grp.materialIndex] ?? mats[0];
    if (!mat || mat.visible === false) continue;
    // Translucent surfaces used to be a binary skip (<0.5 dropped, >=0.5 drawn
    // fully opaque). That made every 0.6-alpha ground decal render at full
    // saturation, which is exactly the call you cannot afford to get wrong when
    // judging zone tints. Blend properly instead; still write depth, which is
    // wrong for stacked transparencies but right for decals on ground.
    const matAlpha = mat.transparent ? (mat.opacity ?? 1) : 1;
    if (matAlpha < 0.04) continue;
    const base = mat.color ? [mat.color.r, mat.color.g, mat.color.b] : [1, 1, 1];
    const useVC = !!(mat.vertexColors && col);
    const key = (obj.name || 'mesh') + ':' + (mat.uuid.slice(0, 4));
    const n3 = Math.floor(grp.count / 3);
    for (let t = 0; t < n3; t++) {
      const g0 = grp.start + t * 3;
      const i0 = idx ? idx.array[g0] : g0, i1 = idx ? idx.array[g0 + 1] : g0 + 1, i2 = idx ? idx.array[g0 + 2] : g0 + 2;
      va.fromBufferAttribute(pos, i0).applyMatrix4(instMat);
      vb.fromBufferAttribute(pos, i1).applyMatrix4(instMat);
      vc.fromBufferAttribute(pos, i2).applyMatrix4(instMat);
      const pa = pr(va), pb = pr(vb), pc = pr(vc);
      if (!pa || !pb || !pc) continue;
      // backface cull in screen space (winding matters — that's a thing to check)
      const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
      if (Math.abs(area) < 1e-9) continue;
      if (mat.side === THREE.FrontSide && area > 0) continue;
      if (mat.side === THREE.BackSide && area < 0) continue;
      if (nor) {
        na.fromBufferAttribute(nor, i0).applyMatrix3(nm).normalize();
      } else na.set(0, 1, 0);
      // MeshBasicMaterial is UNLIT by definition — three never touches it with a
      // light. Lambert-shading it here made flat-colour surfaces (an ink-wash
      // backdrop, a sky shell, a decal) come out far darker in the PNG than in
      // the browser, which is exactly the kind of lie that gets the ART tuned to
      // compensate for the PROBE. Basic and Depth materials render flat.
      const unlit = mat.isMeshBasicMaterial || mat.isMeshDepthMaterial;
      let lam = 1;
      if (!unlit) {
        lam = sunFill;
        // Toon quantises the DIFFUSE RAMP (three indexes its gradient map by
        // dotNL), not the finished pixel. That distinction did not matter while
        // the light was pinned; it does now — the old four steps were written as
        // thresholds on `0.42 + 0.58·x`, so at midnight, where the whole range is
        // 0.23…0.43, every toon surface in the scene snapped to the FIRST step
        // and came out brighter than the true value. Quantising `x` instead is
        // both what three does and exactly the same four steps at noon (see
        // TOON_STEPS: they are the old numbers solved back for x).
        for (const L of sunKeys) {
          const x = Math.max(0, na.dot(L.dir));
          lam += L.k * (mat.isMeshToonMaterial ? toonStep(x) : x);
        }
      }
      let r = base[0], gg = base[1], b = base[2];
      if (useVC) {
        r *= (col.getX(i0) + col.getX(i1) + col.getX(i2)) / 3;
        gg *= (col.getY(i0) + col.getY(i1) + col.getY(i2)) / 3;
        b *= (col.getZ(i0) + col.getZ(i1) + col.getZ(i2)) / 3;
      }
      // stubbed textures render as white; stand in the texture's background
      // colour (see canvasBase), else a neutral so it is not a white-out
      if (mat.map) {
        const bc = dominantColor(mat.map.image);
        if (bc) { r *= bc[0]; gg *= bc[1]; b *= bc[2]; }
        else { r *= 0.72; gg *= 0.7; b *= 0.66; }
      }
      const R = Math.min(255, Math.round(r * lam * 255));
      const G = Math.min(255, Math.round(gg * lam * 255));
      const B = Math.min(255, Math.round(b * lam * 255));
      tris++;
      stats.set(key, (stats.get(key) ?? 0) + 1);
      const minX = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0])));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
      const minY = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1])));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));
      for (let py = minY; py <= maxY; py++) {
        for (let px = minX; px <= maxX; px++) {
          const w0 = ((pb[0] - px) * (pc[1] - py) - (pb[1] - py) * (pc[0] - px)) / area;
          const w1 = ((pc[0] - px) * (pa[1] - py) - (pc[1] - py) * (pa[0] - px)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const d = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
          const o = py * W + px;
          if (d < zbuf[o]) {
            zbuf[o] = d;
            if (matAlpha >= 0.999) {
              img[o * 3] = R; img[o * 3 + 1] = G; img[o * 3 + 2] = B;
            } else {
              const k = matAlpha;
              img[o * 3] = img[o * 3] * (1 - k) + R * k;
              img[o * 3 + 1] = img[o * 3 + 1] * (1 - k) + G * k;
              img[o * 3 + 2] = img[o * 3 + 2] * (1 - k) + B * k;
            }
          }
        }
      }
    }
  }
  }
});
if (STRICT) {
  const uniq = [...new Set(ctxIssues)];
  if (uniq.length) {
    console.log(`\n!! ${ctxIssues.length} bad 2D-context calls (${uniq.length} distinct):`);
    for (const u of uniq.slice(0, 40)) console.log('   ' + u);
    process.exitCode = 1;
  } else console.log('2D context: clean (no NaN/undefined args, no bad colours)');
  const counts = [...ops.values()].sort((a, b) => a - b);
  const empty = [...ops.entries()].filter(([, n]) => n < 20);
  console.log(`texture canvases: ${ops.size}; draw-ops total ${counts.reduce((a, b) => a + b, 0)}; ` +
    `min ${counts[0]} median ${counts[counts.length >> 1]} max ${counts[counts.length - 1]}`);
  if (empty.length) console.log('  suspiciously empty:', empty.map(([t, n]) => `${t}(${n})`).join(' '));
}
// ELDUMP=1: print every stubbed DOM element's textContent. The demos write live
// state there (chunk index, current zone), so this answers "where in the route
// is X?" without exposing anything from inside the demo's IIFE.
if (process.env.ELDUMP) {
  for (const [id, el] of els) if (el.textContent) console.log(`  [${id}] ${el.textContent}`);
}
if (process.env.MATDUMP) {
  const seen = new Map();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || seen.has(m.uuid)) continue;
      seen.set(m.uuid, `${m.type} color=${m.color ? '#' + m.color.getHexString() : '-'} ` +
        `map=${m.map ? 'yes' : 'NO'} vc=${m.vertexColors ? 1 : 0}` +
        (m.transparent ? ` opacity=${(m.opacity ?? 1).toFixed(2)}` : '') +
        (m.emissiveMap ? ` emissiveMap=yes emissive=#${m.emissive.getHexString()} intensity=${m.emissiveIntensity.toFixed(2)}` : '') +
        (!m.emissiveMap && m.emissive && m.emissive.getHex() ? ` emissive=#${m.emissive.getHexString()}` : ''));
    }
  });
  console.log([...seen.values()].sort().join('\n'));
}
console.log(`meshes ${meshes}  triangles drawn ${tris}`);
let sceneTris = 0;
scene.traverse((o) => {
  const p = o.geometry?.getAttribute?.('position');
  if (p && o.isMesh) sceneTris += (o.geometry.index ? o.geometry.index.count : p.count) / 3;
});
console.log('total scene triangles:', Math.round(sceneTris));

// WINDING=1 — triangle winding audit.
//
// This rasteriser does not backface-cull, so a mesh built with reversed
// winding looks perfectly fine in the PNG and then renders as a dark hollow
// shell (or vanishes entirely) under WebGL's default FrontSide. That has
// already bitten once — a hand-built stud geometry — and it was caught by an
// image diff, i.e. by luck. Compare each triangle's geometric normal (cross
// product of its edges) against its stored vertex normal: same hemisphere or
// the face is inside out. Double-sided materials are exempt by definition.
if (process.env.WINDING) {
  const seen = new Set();
  const offenders = new Map();
  let bad = 0, checked = 0;
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.every((m) => m && m.side !== undefined && m.side !== 0)) return;  // 0 = FrontSide
    const g = o.geometry;
    if (seen.has(g.uuid)) return;
    seen.add(g.uuid);
    const p = g.getAttribute('position'), nr = g.getAttribute('normal');
    if (!p || !nr) return;
    const idx = g.index;
    const n = idx ? idx.count : p.count;
    let localBad = 0;
    for (let i = 0; i + 2 < n; i += 3) {
      const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
      const ax = p.getX(a), ay = p.getY(a), az = p.getZ(a);
      const ux = p.getX(b) - ax, uy = p.getY(b) - ay, uz = p.getZ(b) - az;
      const vx = p.getX(c) - ax, vy = p.getY(c) - ay, vz = p.getZ(c) - az;
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (cl < 1e-7) continue;                                // degenerate — skip
      checked++;
      // Average the three vertex normals, not just the first. On SMOOTH-shaded
      // geometry a single vertex normal is the average of every face meeting
      // there, so at a tight bend (a TubeGeometry elbow) it can sit more than
      // 90 degrees off its own face with the winding perfectly correct. Only a
      // decisively opposed normal (dot < -0.3) means the face is really flipped;
      // a plain `< 0` test reports every crease in the scene.
      let nx = 0, ny = 0, nz = 0;
      for (const k of [a, b, c]) { nx += nr.getX(k); ny += nr.getY(k); nz += nr.getZ(k); }
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-7) continue;
      if ((cx * nx + cy * ny + cz * nz) / (cl * nl) < -0.3) { bad++; localBad++; }
    }
    const total = Math.floor((idx ? idx.count : p.count) / 3);
    if (localBad) {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const k = `${o.name || g.type}(${total}tri, ${m?.type}/#${m?.color?.getHexString?.() ?? '------'})`;
      const e = offenders.get(k) ?? { bad: 0, total: 0 };
      e.bad += localBad; e.total += total;
      offenders.set(k, e);
    }
  });
  // Split the report by SHARE, not by count. A geometry built with reversed
  // winding is reversed everywhere — the flipped stud was 100% of its faces.
  // A handful of flipped faces inside an otherwise-correct mesh is a different
  // animal: a swept tube whose path bends tighter than its own radius folds
  // through itself on the inside of the corner, and those faces really are
  // back-to-front without anyone having wound anything backwards. Lumping the
  // two together means the route line cries wolf on every run and the next
  // genuine flip gets ignored.
  const broken = [], nicks = [];
  for (const [k, v] of offenders) ((v.bad / v.total > 0.2) ? broken : nicks).push([k, v]);
  if (broken.length) {
    console.log(`\n!! WINDING: ${broken.length} geometry(s) wound inside out ` +
      `— these vanish or go black under FrontSide in a real renderer`);
    for (const [k, v] of broken.sort((a, b) => b[1].bad - a[1].bad)) {
      console.log(`   ${k}: ${v.bad}/${v.total} (${Math.round(v.bad / v.total * 100)}%)`);
    }
    if (process.env.STRICT) process.exitCode = 1;
  }
  if (nicks.length) {
    console.log(`\nWINDING: isolated flipped faces (self-intersection, not a winding bug):`);
    for (const [k, v] of nicks.sort((a, b) => b[1].bad - a[1].bad).slice(0, 6)) {
      console.log(`   ${k}: ${v.bad}/${v.total}`);
    }
  }
  if (!broken.length && !nicks.length) {
    console.log(`\nWINDING: clean (${checked} triangles across ${seen.size} single-sided geometries)`);
  }
}

// CENSUS=1 — what this scene would cost the real renderer.
//
// Every Mesh is one draw call; an InstancedMesh is one draw call no matter how
// many instances. So `draw calls` is the number to push down, and the gap
// between it and `instances` is how much instancing is already buying. Unique
// geometries/materials matter separately: they are the upload + shader-compile
// cost at chunk build time, which is what stalls on the N100.
if (process.env.CENSUS) {
  // Counting lives in scene-census.mjs so the demos and the real game
  // (render-probe) are measured by the SAME definition — a comparison between
  // two probes that each invented "draw call" is confidently wrong.
  console.log('\n' + formatCensus(census(scene)));
}
function chunkPng(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
const scan = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y++) img.copy(scan, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(outPath, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunkPng('IHDR', ihdr), chunkPng('IDAT', deflateSync(scan)), chunkPng('IEND', Buffer.alloc(0)),
]));
console.log('wrote', outPath);
