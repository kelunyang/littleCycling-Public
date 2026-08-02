/**
 * `[route body vs demo]` — 電子世界的路線本體:一串接龍的杜邦線。
 *
 * 這一支驗的是 `plan/circuit-town-demo.html` 的 `buildDupont` / `dupontWireGeo`
 * 有沒有真的**搬進** gameview,而不是被照著重寫。做法是 CUSTOM_WORLD_INSTRUCTIONS
 * §0.0 第 5 點:**把 demo 的那幾支從 HTML 切出來執行**,餵它跟 gameview 一模一樣
 * 的路徑,然後比對**出貨的三角形**。
 *
 * 為什麼是三角形而不是常數:抄過來的常數只會把當初打錯的東西再確認一遍,而這裡
 * 要抓的偏離全都住在幾何裡 —— DUP_LAT(路線貼哪一側、離中線多遠)、DUP_ARCH
 * (拱多高)、DUP_R(線徑)、LS/RS(管子的分段)、膠殼/肋/針的尺寸與擺位、以及
 * `extendDupont` 那條「弦切超過 DUP_SAG 就換一段短的」的鏈。三角形串流一比,
 * 上面每一個數字都在裡面。
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/route-body-vs-demo.ts
 *
 * 兩個 fixture,各自逼問不同的東西:
 *
 *  A. **直線**。弦切恆為 0,所以整條鏈純由 `mulberry32(0x4a17)` 決定 —— 兩邊的
 *     接點里程逐位元組相同,可以要求三角形**完全**相等。它驗的是造型。
 *  B. **彎道**。弦切開始咬,`while (L > DUP_MIN && chordCut(...) > DUP_SAG) L -= 4`
 *     那一行才會被跑到。它驗的是鏈 —— 而且是 A 完全測不到的那一半。
 */
import { readFileSync } from 'node:fs';

// 走共用的那一份 canvas stub(貼圖快取是模組層、按寬度收的,見 §9.0)。
const { installRecordingCanvas } = await import('./recording-canvas.ts');
type Op = import('./recording-canvas.ts').Op;
type RecCanvas = import('./recording-canvas.ts').RecCanvas;
installRecordingCanvas();

const THREE = await import('three');
const { createTerrainStyleStrategy } = await import('@/game/terrain/terrain-style-strategy');
const { createRouteLine, projectRouteLineOntoTerrain, setRouteLineWindow, disposeRouteLine } =
  await import('@/game/terrain/route-line-mesh');
const { setNightLitFactor } = await import('@/game/terrain/building-lights');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
export function failureCount(): number { return failures; }

// ── Demo slicing ─────────────────────────────────────────────────────────────
function demoScript(path: string): string {
  const html = readFileSync(path, 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const src = blocks[1];
  if (!src) throw new Error(`${path}: no second <script> block`);
  return src;
}
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
/**
 * A run of statements from `head` up to and including the line starting `endHead`
 * — for demo code that lives inline in `animate()` rather than in a function.
 *
 * The spark animation is exactly that: eleven lines between `let nSpark = 0;` and
 * `flushParts(sparkParts, nSpark);`. Slicing it is the only way to compare against
 * the demo's ACTUAL phase maths (the 0.028 attack, the 0.085 decay, the 5.4 scale)
 * rather than against numbers copied out of it — §0.0 第 5 點.
 */
function sliceBlock(src: string, head: string, endHead: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`cannot slice \`${head}\` out of the demo`);
  const end = src.indexOf(endHead, at);
  if (end < 0) throw new Error(`cannot find \`${endHead}\` after \`${head}\``);
  return src.slice(at, end + endHead.length);
}
function sliceStatement(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`cannot slice \`${head}\` out of the demo`);
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const ch = src[i];
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    else if (ch === ']' || ch === '}' || ch === ')') depth--;
    else if (ch === ';' && depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unterminated \`${head}\``);
}

const circuitSrc = demoScript('plan/circuit-town-demo.html');

/** A point + unit tangent on a path, the demo's `pathAt` return shape. */
interface PathPoint { x: number; y: number; z: number; tx: number; tz: number }

/**
 * The demo's dupont block, executed. `pathAt` is injected: it is the INPUT to
 * everything here, and the whole point is to feed both sides the same one.
 */
function demoDupont(pathAt: (d: number) => PathPoint) {
  const factory = new Function('THREE', 'pathAt', `
    const gradientMap = null;
    ${sliceFn(circuitSrc, 'toon')}
    ${sliceFn(circuitSrc, 'metal')}
    ${sliceFn(circuitSrc, 'tex')}
    ${sliceFn(circuitSrc, 'cv')}
    ${sliceFn(circuitSrc, 'mulberry32')}
    ${sliceStatement(circuitSrc, 'const E = {')}
    ${sliceFn(circuitSrc, 'pulseTexture')}
    const GEO = { on: false };
    ${sliceFn(circuitSrc, 'geoGroundY')}
    ${sliceFn(circuitSrc, 'offsetAt')}
    ${sliceStatement(circuitSrc, 'const unitBox = ')}
    ${sliceFn(circuitSrc, 'box')}
    ${sliceStatement(circuitSrc, 'const DUP_LAT = ')}
    ${sliceStatement(circuitSrc, 'const DUP_DRAW = ')}
    ${sliceStatement(circuitSrc, 'const DUP_MIN = ')}
    ${sliceStatement(circuitSrc, 'const DUP_SAG = ')}
    ${sliceStatement(circuitSrc, 'const DUP_Y = ')}
    ${sliceStatement(circuitSrc, 'const DUP_R = ')}
    ${sliceStatement(circuitSrc, 'const DUP_ARCH = ')}
    ${sliceStatement(circuitSrc, 'const DUP_FL = ')}
    ${sliceStatement(circuitSrc, 'const DUP_ML = ')}
    ${sliceStatement(circuitSrc, 'const DUP_GAP = ')}
    ${sliceStatement(circuitSrc, 'const PULSE_UV = ')}
    ${sliceStatement(circuitSrc, 'const DUP_COLORS = ')}
    ${sliceStatement(circuitSrc, 'const dupJoints = ')}
    ${sliceStatement(circuitSrc, 'const dupRng = ')}
    ${sliceFn(circuitSrc, 'chordCut')}
    ${sliceFn(circuitSrc, 'extendDupont')}
    ${sliceStatement(circuitSrc, 'const dupShellMat = ')}
    ${sliceStatement(circuitSrc, 'const dupRibMat = ')}
    ${sliceStatement(circuitSrc, 'const dupPinMat = ')}
    ${sliceStatement(circuitSrc, 'const pulseTex = ')}
    ${sliceStatement(circuitSrc, 'pulseTex.wrapT = ')}
    ${sliceStatement(circuitSrc, 'const dupWireMats = ')}
    ${sliceFn(circuitSrc, 'dupontWireGeo')}
    ${sliceFn(circuitSrc, 'buildDupont')}
    // demo 的 applyDayNight 裡驅動線身亮度的那一行,原地執行(powerOn = wg = k = 1
    // 就是它的夜間峰值)。gameview 的夜燈只寫 emissive 的**顏色**,所以強度是常數,
    // 而那個常數必須等於這條式子的峰值。
    const demoWirePeak = (() => {
      const powerOn = 1, wg = 1, k = 1;
      const dupWireMats = [{ emissiveIntensity: 0 }];
      ${sliceStatement(circuitSrc, 'for (const m of dupWireMats)')}
      return dupWireMats[0].emissiveIntensity;
    })();
    return {
      demoWirePeak,
      DUP_LAT, DUP_DRAW, DUP_MAX, DUP_MIN, DUP_SAG, DUP_Y, DUP_R, DUP_ARCH,
      DUP_FL, DUP_FW, DUP_FH, DUP_ML, DUP_MW, DUP_MH, DUP_GAP,
      PULSE_UV, DUP_COLORS, dupJoints, chordCut, extendDupont, offsetAt,
      dupontWireGeo, buildDupont, dupWireMats, dupShellMat, dupRibMat, dupPinMat,
      pulseTex, pulseTexture,
    };
  `) as (t: typeof THREE, p: (d: number) => PathPoint) => {
    DUP_LAT: number; DUP_DRAW: number; DUP_MAX: number; DUP_MIN: number;
    DUP_SAG: number; DUP_Y: number; DUP_R: number; DUP_ARCH: number;
    DUP_FL: number; DUP_FW: number; DUP_FH: number;
    DUP_ML: number; DUP_MW: number; DUP_MH: number; DUP_GAP: number;
    PULSE_UV: number; DUP_COLORS: string[];
    dupJoints: { d: number }[];
    chordCut: (d0: number, d1: number) => number;
    extendDupont: (d: number) => void;
    buildDupont: (
      g: THREE.Group, d0: number, d1: number,
      disposables: THREE.BufferGeometry[], sparks: unknown[],
    ) => void;
    dupWireMats: THREE.MeshPhongMaterial[];
    dupShellMat: THREE.Material;
    dupRibMat: THREE.Material;
    dupPinMat: THREE.Material;
    pulseTex: THREE.CanvasTexture;
    pulseTexture: () => RecCanvas;
    demoWirePeak: number;
  };
  return factory(THREE, pathAt);
}

/** One spark landing, the demo's `sparks.push({ x, y, z, d })` shape. */
interface DemoSpark { x: number; y: number; z: number; d: number }

/**
 * The demo's 踏頻/功率 mappings and the two brightness lines they feed, executed.
 *
 * `setPedal` is the demo's OWN clamp — the two lines out of `readPedal` — not a
 * re-typed pair of ranges, because the ranges are what gameview has to reproduce
 * for inputs the demo's sliders cannot produce (0 rpm, 400 W). It also
 * cross-checks them against the slider elements in the demo's HTML, so a demo
 * that widens a slider without widening the clamp fails here.
 */
function demoPedal() {
  const factory = new Function('THREE', `
    ${sliceStatement(circuitSrc, 'let cadence = 85')}
    ${sliceStatement(circuitSrc, 'const cadenceSpeed = ')}
    ${sliceStatement(circuitSrc, 'const wattGain = ')}
    return {
      openingCadence: cadence,
      openingWatts: watts,
      setPedal(r, w) {
        ${sliceBlock(circuitSrc, 'if (Number.isFinite(r))', 'Math.max(80, w));')}
      },
      cadenceSpeed, wattGain,
      /** demo applyDayNight 的線身那一行,原地執行。 */
      wireIntensity(k) {
        const powerOn = 1, wg = wattGain();
        const dupWireMats = [{ emissiveIntensity: 0 }];
        ${sliceStatement(circuitSrc, 'for (const m of dupWireMats)')}
        return dupWireMats[0].emissiveIntensity;
      },
      /** demo applyDayNight 的火花那一行,原地執行。 */
      sparkOpacity(k) {
        const powerOn = 1, wg = wattGain();
        const sparkMat = { opacity: 0 };
        ${sliceStatement(circuitSrc, 'sparkMat.opacity = ')}
        return sparkMat.opacity;
      },
    };
  `) as (t: typeof THREE) => {
    openingCadence: number;
    openingWatts: number;
    setPedal: (r: number, w: number) => void;
    cadenceSpeed: () => number;
    wattGain: () => number;
    wireIntensity: (k: number) => number;
    sparkOpacity: (k: number) => number;
  };
  return factory(THREE);
}

/** The demo's own slider bounds, read off its HTML. */
function sliderRange(id: string): { min: number; max: number; value: number } {
  const html = readFileSync('plan/circuit-town-demo.html', 'utf8');
  const tag = html.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`no #${id} slider in the demo`);
  const num = (attr: string): number => Number(tag.match(new RegExp(`${attr}="([^"]+)"`))?.[1]);
  return { min: num('min'), max: num('max'), value: num('value') };
}

/**
 * The demo's spark POOL and its per-frame block, executed.
 *
 * Both halves come out of the demo source:
 *  · `protoParts(...)` builds the real `InstancedMesh` with the demo's own flags
 *    (castShadow, renderOrder, DynamicDrawUsage, frustumCulled, count 0,
 *    visible false) — so those can be compared object to object instead of being
 *    re-typed here, which is the failure mode 阻焊邊 already paid for.
 *  · the `let nSpark = 0; … flushParts(...)` block from `animate()` — the phase
 *    maths itself.
 */
function demoSparkPool() {
  const factory = new Function('THREE', `
    ${sliceFn(circuitSrc, 'cv')}
    ${sliceFn(circuitSrc, 'tex')}
    ${sliceFn(circuitSrc, 'sparkTexture')}
    ${sliceStatement(circuitSrc, 'const glowQuad = ')}
    ${sliceStatement(circuitSrc, 'const sparkMat = ')}
    ${sliceStatement(circuitSrc, 'const _hm = ')}
    ${sliceStatement(circuitSrc, 'const tmpM = ')}
    ${sliceStatement(circuitSrc, 'const tmpV3 = ')}
    ${sliceStatement(circuitSrc, 'const IDENT_Q = ')}
    ${sliceStatement(circuitSrc, 'const DUP_Y = ')}
    ${sliceStatement(circuitSrc, 'const PULSE_UV = ')}
    ${sliceStatement(circuitSrc, 'const PULSE_BANDS = ')}
    // protoParts adds to the scene; a stub is enough, nothing here renders.
    const scene = { add() {} };
    ${sliceFn(circuitSrc, 'protoParts')}
    ${sliceFn(circuitSrc, 'writeParts')}
    ${sliceFn(circuitSrc, 'flushParts')}
    ${sliceStatement(circuitSrc, 'const COIN_CAP = ')}
    ${sliceStatement(circuitSrc, 'const sparkParts = ')}
    /** One frame of the demo's spark block, over one synthetic chunk. */
    function frame(sparks, pulseU, powerOn) {
      const chunks = new Map([[0, { sparks }]]);
      ${sliceBlock(circuitSrc, 'let nSpark = 0;', 'flushParts(sparkParts, nSpark);')}
      return nSpark;
    }
    return { sparkParts, sparkMat, glowQuad, sparkTexture, frame, SPARK_CAP, PULSE_BANDS };
  `) as (t: typeof THREE) => {
    sparkParts: { im: THREE.InstancedMesh; local: THREE.Matrix4 }[];
    sparkMat: THREE.MeshBasicMaterial;
    glowQuad: THREE.BufferGeometry;
    sparkTexture: () => RecCanvas;
    frame: (sparks: DemoSpark[], pulseU: number, powerOn: number) => number;
    SPARK_CAP: number;
    PULSE_BANDS: number[];
  };
  return factory(THREE);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
interface RoutePt { lat: number; lon: number; ele: number; distance: number }

/**
 * A route as GPX points. `bend` is the heading change per 20 m step in radians —
 * 0 is fixture A (dead straight, chord cut identically zero) and a non-zero value
 * is fixture B (the corner, where `extendDupont` starts shortening segments).
 */
function makeRoute(originLat: number, originLon: number, n: number, bend: number): RoutePt[] {
  const cosLat = Math.cos((originLat * Math.PI) / 180);
  const pts: RoutePt[] = [];
  let x = 0, z = 0, heading = 0, dist = 0;
  for (let i = 0; i < n; i++) {
    pts.push({
      lat: originLat - z / 111320,
      lon: originLon + x / (111320 * cosLat),
      ele: 0,
      distance: dist,
    });
    x += Math.sin(heading) * 20;
    z -= Math.cos(heading) * 20;
    dist += 20;
    heading += bend;
  }
  return pts;
}

/**
 * `pathAt(d)` read straight off the route line's own vertex array — the CHECK's
 * reading of the path, not gameview's implementation of it. Both sides get this
 * one function, so the path is a controlled input and the only thing under test
 * is what each side builds along it.
 */
function pathReader(group: THREE.Group): (d: number) => PathPoint {
  const pos = group.userData._routePositions as number[];
  const cum = group.userData._routeCum as number[];
  const n = cum.length;
  return (d: number): PathPoint => {
    const target = Math.max(0, Math.min(d, cum[n - 1]));
    let lo = 0, hi = n - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid; else hi = mid;
    }
    const a = lo * 3, b = hi * 3;
    const seg = cum[hi] - cum[lo];
    const t = seg > 1e-9 ? (target - cum[lo]) / seg : 0;
    const dx = pos[b] - pos[a], dz = pos[b + 2] - pos[a + 2];
    const len = Math.hypot(dx, dz) || 1;
    return {
      x: pos[a] + dx * t,
      y: pos[a + 1] + (pos[b + 1] - pos[a + 1]) * t,
      z: pos[a + 2] + dz * t,
      tx: dx / len, tz: dz / len,
    };
  };
}

/**
 * Every triangle a group would draw, in world space, as flat vertex triples.
 *
 * `route/spark` is skipped, and that exclusion is asserted separately rather than
 * assumed: the demo's `buildDupont` outputs spark COORDINATES and nothing else
 * (its quads live in the `sparkParts` InstancedMesh pool, built elsewhere), so a
 * spark quad on this side has no counterpart on that side and would make the two
 * triangle sets differ by exactly two triangles — which is not a porting defect.
 * `[route body: 接點火花]` below compares that batch against the demo's own pool.
 */
function triangles(root: THREE.Object3D): number[][] {
  root.updateMatrixWorld(true);
  const out: number[][] = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.name === 'route/spark') return;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const idx = geo.index;
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const tri: number[] = [];
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(i + k) : i + k;
        v.fromBufferAttribute(pos, vi).applyMatrix4(mesh.matrixWorld);
        tri.push(v.x, v.y, v.z);
      }
      out.push(tri);
    }
  });
  return out;
}

/** Canonical order so two identical sets compare regardless of emission order. */
function sortTris(tris: number[][]): number[][] {
  const key = (t: number[]): string => t.map((n) => n.toFixed(4)).join(',');
  return [...tris].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function maxTriDelta(a: number[][], b: number[][]): number {
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    for (let k = 0; k < 9; k++) worst = Math.max(worst, Math.abs(a[i][k] - b[i][k]));
  }
  return worst;
}

const circuit = await createTerrainStyleStrategy('circuit');

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[route body: circuit draws the dupont chain, not the ribbon]');
// ═════════════════════════════════════════════════════════════════════════════
const plastic = await createTerrainStyleStrategy('plastic');
{
  check('電子宣告了 buildRouteBody,另外兩個世界沒有',
    typeof circuit.buildRouteBody === 'function' && plastic.buildRouteBody === undefined);
}

/** Build circuit's route line (= the body) over a fixture and drape it flat. */
function buildBody(points: RoutePt[], groundY: number | null = 0): THREE.Group {
  const g = createRouteLine(
    points as never, points[0].lat, points[0].lon, 0, { width: 800, height: 600 },
    { style: circuit.routeLine, body: circuit.buildRouteBody?.bind(circuit) },
  );
  if (groundY !== null) projectRouteLineOntoTerrain(g, () => groundY);
  return g;
}

const straight = makeRoute(25, 121, 200, 0);          // 4 km dead straight
/**
 * 4 km on a 200 m radius, bending AWAY from the side the wire hugs.
 *
 * Both halves of that sentence are load-bearing. The radius sets the sagitta:
 * `L²/8R` is 3.06 m over DUP_MAX (70 m) and 1.89 m over DUP_DRAW (55 m), so the
 * chain straddles DUP_SAG and the `L -= 4` loop actually runs — at 364 m it never
 * fires and this fixture is just the straight one again. And the SIGN matters:
 * the wire sits at `+DUP_LAT`, which on a curve bending that way is the INSIDE of
 * the arc, where the chord bulges OUT and `chordCut` comes back negative. The
 * assertion below is what proved this fixture was inert the first time round.
 */
const corner = makeRoute(25, 121, 200, -0.1);

{
  const g = buildBody(straight);
  const meshes: THREE.Mesh[] = [];
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const names = meshes.map((m) => m.name).sort();
  check('路線不再是兩條緞帶(route/core + route/glow 都不在)',
    !names.includes('route/core') && !names.includes('route/glow'), names.join(' '));
  // 10 = 9 + 一批接點火花。火花是 InstancedMesh(整條路線一個 draw call,不是每個
  // 接點一個),所以「加了火花」在這張帳上只准是 +1。
  check('整條路線收成 10 個 draw call:六個線色 + 膠殼 + 肋 + 針 + 一批接點火花',
    meshes.length === 10
    && names.filter((n) => n.startsWith('route/wire')).length === 6
    && names.includes('route/shell') && names.includes('route/rib')
    && names.includes('route/pin') && names.includes('route/spark'),
    `${meshes.length} 個: ${names.join(' ')}`);
  check('而且是**整條路線** 10 個,不是每個 chunk 10 個(它跟 chunk 無關)',
    (g.userData._routeCum as number[]).slice(-1)[0] > 3900 && meshes.length === 10,
    `${((g.userData._routeCum as number[]).slice(-1)[0] / 1000).toFixed(1)} km → 10 draws`);
  disposeRouteLine(g);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[route body: 三角形逐個對 demo 的 buildDupont(直線)]');
// ═════════════════════════════════════════════════════════════════════════════
{
  const g = buildBody(straight);
  const demo = demoDupont(pathReader(g));
  const demoGroup = new THREE.Group();
  const disposables: THREE.BufferGeometry[] = [];
  const sparks: unknown[] = [];
  const lengthM = (g.userData._routeCum as number[]).slice(-1)[0];
  demo.buildDupont(demoGroup, 0, lengthM, disposables, sparks);

  check('demo 的 buildDupont 切得出來而且真的跑了',
    demoGroup.children.length > 0 && sparks.length > 0,
    `${demoGroup.children.length} 個 mesh / ${sparks.length} 個接點`
    + ` / DUP_LAT ${demo.DUP_LAT} · DUP_ARCH ${demo.DUP_ARCH} · DUP_R ${demo.DUP_R}`);

  const gvTris = triangles(g);
  const demoTris = triangles(demoGroup);
  check('三角形數一模一樣(接點數 × 188 = 線身 140 + 四個膠殼/肋/針 48)',
    gvTris.length === demoTris.length,
    `gameview ${gvTris.length} vs demo ${demoTris.length}`);

  {
    const same = gvTris.length === demoTris.length;
    const delta = same ? maxTriDelta(sortTris(gvTris), sortTris(demoTris)) : Infinity;
    check('每一個三角形的每一個頂點都落在 demo 的同一個位置',
      same && delta < 1e-3,
      same ? `最大偏差 ${delta.toExponential(2)} m` : '三角形數不同,位置無從比對');
  }

  // uv 的 u = **絕對里程 × PULSE_UV**。全場共用一份脈衝貼圖、推一次 offset,電流
  // 才會沿著整條路連續往前跑 —— 對不上就會在每一段的邊界斷開。
  {
    const wire = [...g.children[0].children].find(
      (c) => c.name === 'route/wire0') as THREE.Mesh;
    const uv = wire.geometry.getAttribute('uv');
    const pos = wire.geometry.getAttribute('position');
    // 第一條線的第一圈:里程 ≈ 它的 z 距離(直線朝北)。
    let worst = 0;
    for (let i = 0; i < uv.count; i++) {
      const mileage = -pos.getZ(i);
      // u 對應的里程(u = d * PULSE_UV),容差是拱起造成的縱向差(線身只走
      // s0..s1,兩端的 z 就是那兩個里程)。
      worst = Math.max(worst, Math.abs(uv.getX(i) / demo.PULSE_UV - mileage));
    }
    check('線身的 u = 絕對里程 × demo 的 PULSE_UV(整條路連續,不逐段重來)',
      worst < 0.05, `最大偏差 ${worst.toExponential(2)} m(PULSE_UV = ${demo.PULSE_UV}）`);
  }

  for (const geo of disposables) geo.dispose();
  disposeRouteLine(g);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[route body: 彎道 — 弦切鏈(直線 fixture 測不到的那一半)]');
// ═════════════════════════════════════════════════════════════════════════════
{
  const g = buildBody(corner);
  const demo = demoDupont(pathReader(g));
  const lengthM = (g.userData._routeCum as number[]).slice(-1)[0];
  const demoGroup = new THREE.Group();
  const disposables: THREE.BufferGeometry[] = [];
  demo.buildDupont(demoGroup, 0, lengthM, disposables, []);

  // 這個 fixture 必須真的踩到那條 while:不然它跟直線那個一樣。
  demo.extendDupont(lengthM);
  const spans: number[] = [];
  for (let k = 0; k + 1 < demo.dupJoints.length; k++) {
    if (demo.dupJoints[k].d >= lengthM) break;
    spans.push(demo.dupJoints[k + 1].d - demo.dupJoints[k].d);
  }
  const shortened = spans.filter((s) => s < demo.DUP_DRAW).length;
  check('(這個 fixture 真的讓弦切咬到了 —— 有段被縮到 DUP_DRAW 以下)',
    shortened > 0 && spans.every((s) => s >= demo.DUP_MIN - 1e-9 && s <= demo.DUP_MAX + 1e-9),
    `${shortened}/${spans.length} 段被縮短,長度 ${Math.min(...spans).toFixed(1)}–`
    + `${Math.max(...spans).toFixed(1)} m(DUP_MIN ${demo.DUP_MIN} / DUP_MAX ${demo.DUP_MAX})`);
  check('每一段的弦切都在 demo 的 DUP_SAG 以內,或已經縮到 DUP_MIN 不能再縮',
    spans.every((s, k) => demo.chordCut(demo.dupJoints[k].d, demo.dupJoints[k].d + s)
      <= demo.DUP_SAG + 1e-9 || s <= demo.DUP_MIN + 4),
    `最深的弦切 ${Math.max(...spans.map((s, k) =>
      demo.chordCut(demo.dupJoints[k].d, demo.dupJoints[k].d + s))).toFixed(3)} m`
    + ` / DUP_SAG ${demo.DUP_SAG}`);

  const gvTris = triangles(g);
  const demoTris = triangles(demoGroup);
  check('彎道上的三角形數也一樣(鏈長被弦切改過之後仍然對得上)',
    gvTris.length === demoTris.length,
    `gameview ${gvTris.length} vs demo ${demoTris.length}`);
  {
    const same = gvTris.length === demoTris.length;
    const delta = same ? maxTriDelta(sortTris(gvTris), sortTris(demoTris)) : Infinity;
    check('彎道上每一個頂點也落在 demo 的同一個位置',
      same && delta < 1e-3,
      same ? `最大偏差 ${delta.toExponential(2)} m` : '三角形數不同,位置無從比對');
  }

  // 接頭是**坐在地上**的零件,不是飄在空中的導引線(舊版那條浮在 5 m 的跑道燈)。
  {
    let lo = Infinity, hi = -Infinity;
    let shell: THREE.Mesh | null = null;
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.name === 'route/shell') shell = mesh;
    });
    const pos = (shell as THREE.Mesh | null)?.geometry.getAttribute('position');
    for (let i = 0; pos && i < pos.count; i++) {
      lo = Math.min(lo, pos.getY(i));
      hi = Math.max(hi, pos.getY(i));
    }
    // 地面在 y = 0,膠殼中心在 DUP_Y、高 DUP_FH → 底面 DUP_Y − DUP_FH/2。
    check('接頭坐在地面上:膠殼底面 = demo 的 DUP_Y − DUP_FH / 2',
      Math.abs(lo - (demo.DUP_Y - demo.DUP_FH / 2)) < 1e-3,
      `底面 ${lo.toFixed(3)} m,demo ${(demo.DUP_Y - demo.DUP_FH / 2).toFixed(3)} m`
      + `(頂 ${hi.toFixed(3)} m)`);
  }

  for (const geo of disposables) geo.dispose();
  disposeRouteLine(g);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[route body: 發光 — 電流跑在線裡面]');
// ═════════════════════════════════════════════════════════════════════════════
{
  const g = buildBody(straight);
  const demo = demoDupont(pathReader(g));
  const wires: THREE.Mesh[] = [];
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.name.startsWith('route/wire')) wires.push(m);
  });
  wires.sort((a, b) => a.name.localeCompare(b.name));

  // 一個 throw 會把這支從那一行起整個截斷,後面的斷言就靜靜地沒跑到 ——
  // 「0 個 ✗ 也可能是 crash」。所以下面每一個查找都先記失敗再早退。
  check('六條線身都在(每個線色一份 merged mesh)',
    wires.length === demo.DUP_COLORS.length,
    `${wires.length} 條,demo 有 ${demo.DUP_COLORS.length} 個顏色`);

  check('六條線六個顏色,逐個等於 demo 的 DUP_COLORS(排線本來就是彩虹色)',
    wires.length === demo.DUP_COLORS.length
    && wires.every((w, i) => (w.material as THREE.MeshPhongMaterial).color.getHex()
      === demo.dupWireMats[i].color.getHex()),
    demo.DUP_COLORS.join(' '));

  // 夜裡的發光顏色。demo 是 `color.lerp('#c8fdff', 0.3)`:往青白拉 0.3,不是拉到
  // 白 —— 紅線要跑紅光。gameview 的夜燈只寫 emissive 的顏色,所以把全域寫到 1
  // 再比,兩邊的 emissive 必須是同一個顏色。
  setNightLitFactor(1);
  const glowBad = wires.filter((w, i) => {
    const a = (w.material as THREE.MeshPhongMaterial).emissive;
    const b = demo.dupWireMats[i].emissive;
    return Math.abs(a.r - b.r) > 2 / 255 || Math.abs(a.g - b.g) > 2 / 255
      || Math.abs(a.b - b.b) > 2 / 255;
  });
  check('入夜的發光色逐條等於 demo 的 emissive(外皮色往青白拉 0.3,不是拉到白)',
    glowBad.length === 0,
    wires.map((w, i) => `${w.name}=#${(w.material as THREE.MeshPhongMaterial)
      .emissive.getHexString()}/demo #${demo.dupWireMats[i].emissive.getHexString()}`)
      .slice(0, 2).join(' '));
  // 反向:白天必須是黑的(這個世界的夜景招牌動作是**入夜才亮**)。
  setNightLitFactor(0);
  check('白天不發光(全場一起亮就沒有重點了)',
    wires.every((w) => (w.material as THREE.MeshPhongMaterial).emissive.getHex() === 0));
  setNightLitFactor(1);

  check('夜間發光強度 = demo applyDayNight 那一行的峰值(powerOn × wg × (0.34 + 1.5k))',
    wires.length > 0 && wires.every(
      (w) => Math.abs((w.material as THREE.MeshPhongMaterial).emissiveIntensity
        - demo.demoWirePeak) < 1e-9),
    `gameview ${(wires[0]?.material as THREE.MeshPhongMaterial)?.emissiveIntensity}`
    + ` / demo ${demo.demoWirePeak}`);

  const map = wires.length
    ? (wires[0].material as THREE.MeshPhongMaterial).emissiveMap : null;
  // wrapT 從 **demo 自己那一行**讀(`pulseTex.wrapT = …`),不寫成常數:
  // 阻焊邊那次的教訓就是「抄過來的常數只會把當初打錯的東西再確認一遍」。
  check('電流是線的 emissiveMap,而且 wrapT 跟 demo 那一行一樣',
    !!map && map.wrapT === demo.pulseTex.wrapT,
    `wrapT ${map?.wrapT} / demo ${demo.pulseTex.wrapT}`
    + `(ClampToEdge = ${THREE.ClampToEdgeWrapping})`);
  const gvOps = ((map?.image as RecCanvas | undefined)?.ops ?? []) as Op[];
  const demoOps = demo.pulseTexture().ops as Op[];
  const same = gvOps.length === demoOps.length && gvOps.every((o, i) => (
    o.kind === demoOps[i].kind && o.a === demoOps[i].a && o.b === demoOps[i].b
    && o.c === demoOps[i].c && o.d === demoOps[i].d && o.alpha === demoOps[i].alpha
    && o.style.toLowerCase() === demoOps[i].style.toLowerCase()
  ));
  check('脈衝貼圖跟 demo 的 pulseTexture() 逐筆相同(三顆亮團 × 34 圈衰減)',
    same, `${gvOps.length} 筆 vs demo ${demoOps.length} 筆`);

  // 影子旗標。**兩邊都從對方讀**,不寫成字面值:demo 的線身是
  // `w.castShadow = true`(receive 留在預設的 false),膠殼/肋/針走 `box()`
  // (兩個都開)。旗標是逐 draw 的,合併時混在一起就等於把 demo 逐件寫下的那些
  // 丟掉,所以這條要盯著 demo 的當下值。
  const byName = new Map<string, THREE.Mesh>();
  g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) byName.set(m.name, m); });
  {
    const demoG = new THREE.Group();
    demo.buildDupont(demoG, 0, 200, [], []);
    const meshes = demoG.children.filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[];
    const demoWire = meshes.find((m) => m.geometry.type !== 'BoxGeometry');
    const demoBox = meshes.find((m) => m.geometry.type === 'BoxGeometry');
    check('castShadow / receiveShadow 逐項等於 demo 的那幾行',
      !!demoWire && !!demoBox && wires.length > 0
      && wires.every((w) => w.castShadow === demoWire.castShadow
        && w.receiveShadow === demoWire.receiveShadow)
      && ['route/shell', 'route/rib', 'route/pin'].every(
        (n) => byName.get(n)?.castShadow === demoBox.castShadow
          && byName.get(n)?.receiveShadow === demoBox.receiveShadow),
      `demo 線身 cast=${demoWire?.castShadow}/recv=${demoWire?.receiveShadow},`
      + `膠殼 cast=${demoBox?.castShadow}/recv=${demoBox?.receiveShadow}`);
  }

  disposeRouteLine(g);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[route body: 電流 — 踏頻推脈衝(demo cadenceSpeed)]');
// ═════════════════════════════════════════════════════════════════════════════
/** The pulse's u offset, read off the thing that actually carries it. */
function pulseOffset(g: THREE.Group): number {
  let u = NaN;
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.name === 'route/wire0') {
      u = (m.material as THREE.MeshPhongMaterial).emissiveMap?.offset.x ?? NaN;
    }
  });
  return u;
}
const feed = (
  cadenceRpm: number | null,
  dt: number,
  powerW: number | null = null,
  powerSource: 'meter' | 'estimated' | null = null,
): void => {
  circuit.updateRiderSignals?.({ cadenceRpm, powerW, powerSource }, dt);
};
{
  const pedal = demoPedal();
  const g = buildBody(straight);

  check('demo 的兩支滑桿與 readPedal 的夾值一致(範圍是同一組數字)',
    (() => {
      const rpm = sliderRange('rpm'), pwr = sliderRange('pwr');
      pedal.setPedal(rpm.min - 50, pwr.min - 50);
      const lo = [pedal.cadenceSpeed(), pedal.wattGain()];
      pedal.setPedal(rpm.min, pwr.min);
      const atMin = [pedal.cadenceSpeed(), pedal.wattGain()];
      pedal.setPedal(rpm.max + 90, pwr.max + 500);
      const hi = [pedal.cadenceSpeed(), pedal.wattGain()];
      pedal.setPedal(rpm.max, pwr.max);
      const atMax = [pedal.cadenceSpeed(), pedal.wattGain()];
      return lo[0] === atMin[0] && lo[1] === atMin[1]
        && hi[0] === atMax[0] && hi[1] === atMax[1];
    })(),
    `踏頻 ${sliderRange('rpm').min}–${sliderRange('rpm').max} rpm`
    + ` / 功率 ${sliderRange('pwr').min}–${sliderRange('pwr').max} W`);

  // 每一幀的 dt 都不同,而且刻意不是 1/60 的倍數。相等的 dt 會讓「乘 dt」跟
  // 「乘一個定值」在總量上分不出來,那正是這個 repo 最近三輪的突變盲點。
  const DTS = [0.0131, 0.0207, 0.0166, 0.0413, 0.0092, 0.0288];
  /** Signed travel over `frames` frames, unwrapping the ±1 rollover. */
  const travel = (rpm: number | null, frames: number): { moved: number; wraps: number; peak: number } => {
    let prev = pulseOffset(g);
    let moved = 0, wraps = 0, peak = -Infinity;
    for (let i = 0; i < frames; i++) {
      feed(rpm, DTS[i % DTS.length]);
      const u = pulseOffset(g);
      let d = u - prev;
      if (d > 0.5) { d -= 1; wraps++; }        // 繞回:−0.99 → −0.01 之類
      moved += d;
      peak = Math.max(peak, u);
      prev = u;
    }
    return { moved, wraps, peak };
  };
  const dtSum = (frames: number): number => {
    let s = 0;
    for (let i = 0; i < frames; i++) s += DTS[i % DTS.length];
    return s;
  };

  for (const rpm of [60, 85, 110]) {
    pedal.setPedal(rpm, 200);
    const expect = -pedal.cadenceSpeed() * dtSum(40);
    const { moved } = travel(rpm, 40);
    check(`脈衝每幀前進 dt × demo 的 cadenceSpeed(${rpm} rpm)`,
      Math.abs(moved - expect) < 1e-9,
      `40 幀走了 ${moved.toFixed(6)} uv,demo ${expect.toFixed(6)}`
      + `(速度 ${pedal.cadenceSpeed().toFixed(4)} uv/秒)`);
  }

  // 方向。demo 的原話:「offset 是**減**的:貼圖 offset 加會讓花紋往 −u 跑,也就是
  // 往騎手後面跑。」
  {
    const before = pulseOffset(g);
    feed(85, 0.05);
    check('offset 是**減**的(電流往騎手前方跑,不是往後)',
      pulseOffset(g) - before < 0 || pulseOffset(g) - before > 0.5,
      `${before.toFixed(5)} → ${pulseOffset(g).toFixed(5)}`);
  }

  // 繞回。1200 幀 × ~0.022 秒 × 0.9 uv/秒 ≈ 24 圈 —— fixture 一定要真的跨過 1
  // 好幾次,不然「全部在 (−1, 0] 之內」是恆真句(前幾輪就出過這種空斷言)。
  {
    const { wraps, peak, moved } = travel(110, 1200);
    let min = 0;
    for (let i = 0; i < 200; i++) { feed(110, 0.03); min = Math.min(min, pulseOffset(g)); }
    check('u 跨過一整圈之後繞回,而且永遠留在 (−1, 0](去掉 % 1 就會走到 −1 以下)',
      wraps >= 20 && min > -1 && peak <= 0,
      `繞回 ${wraps} 次(共走 ${moved.toFixed(1)} uv),最小 ${min.toFixed(5)} / 最大 ${peak.toFixed(5)}`);
  }

  // 值不存在 vs 值是 0 —— 兩件不同的事,demo 只有前者的答案(它的開場值)。
  {
    const one = (rpm: number | null): number => {
      const before = pulseOffset(g);
      feed(rpm, 0.01);
      const d = pulseOffset(g) - before;
      return d > 0.5 ? d - 1 : d;
    };
    pedal.setPedal(pedal.openingCadence, 200);
    const atOpening = -pedal.cadenceSpeed() * 0.01;
    pedal.setPedal(0, 200);                       // demo 自己夾成 60
    const atFloor = -pedal.cadenceSpeed() * 0.01;
    pedal.setPedal(400, 200);                     // demo 自己夾成 110
    const atCeil = -pedal.cadenceSpeed() * 0.01;
    check('沒有踏頻感測器(null)→ demo 的開場值 85 rpm,不是 0 也不是最慢那一檔',
      Math.abs(one(null) - atOpening) < 1e-12 && Math.abs(atOpening - atFloor) > 1e-6,
      `null → ${one(null).toExponential(4)} / demo@85 ${atOpening.toExponential(4)}`
      + ` / demo@60 ${atFloor.toExponential(4)}`);
    check('0 rpm → demo 的下界(60 rpm),電流不會停也不會倒著跑',
      Math.abs(one(0) - atFloor) < 1e-12 && atFloor < 0,
      `0 rpm → ${one(0).toExponential(4)} / demo@60 ${atFloor.toExponential(4)}`);
    check('感測器給出上界以外的踏頻 → demo 的上界(110 rpm),不會無上限加速',
      Math.abs(one(400) - atCeil) < 1e-12,
      `400 rpm → ${one(400).toExponential(4)} / demo@110 ${atCeil.toExponential(4)}`);
  }

  disposeRouteLine(g);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[route body: 接點火花 — 吃脈衝相位]');
// ═════════════════════════════════════════════════════════════════════════════
{
  const pool = demoSparkPool();
  const demoIm = pool.sparkParts[0].im;
  const staticFlags = {
    cast: demoIm.castShadow, recv: demoIm.receiveShadow, order: demoIm.renderOrder,
    culled: demoIm.frustumCulled, usage: demoIm.instanceMatrix.usage,
  };
  const g = buildBody(straight);
  let spark: THREE.InstancedMesh | null = null;
  g.traverse((o) => {
    const m = o as THREE.InstancedMesh;
    if (m.isInstancedMesh && m.name === 'route/spark') spark = m;
  });
  const sp = spark as THREE.InstancedMesh | null;

  check('接點火花真的被建出來了(一批 InstancedMesh,不是每個接點一個 mesh)',
    !!sp, sp ? `capacity ${sp.instanceMatrix.count}` : '沒有 route/spark');

  check('沒有人餵訊號就一片都不畫(count 0 / visible false)——'
    + '「常亮的白點比不畫更錯」那句話還在生效',
    !!sp && sp.count === 0 && sp.visible === false,
    `count ${sp?.count} visible ${sp?.visible}`);

  check('那批的旗標逐項等於 demo `protoParts` 建出來的那顆',
    !!sp && sp.castShadow === staticFlags.cast && sp.receiveShadow === staticFlags.recv
    && sp.renderOrder === staticFlags.order && sp.frustumCulled === staticFlags.culled
    && sp.instanceMatrix.usage === staticFlags.usage,
    `demo cast=${staticFlags.cast} order=${staticFlags.order} culled=${staticFlags.culled}`
    + ` usage=${staticFlags.usage}`);

  // 材質。**兩邊都從 demo 讀**,包含那張貼圖的每一筆 canvas 操作。
  {
    const gv = sp?.material as THREE.MeshBasicMaterial | undefined;
    const dm = pool.sparkMat;
    check('火花材質逐格等於 demo 的 sparkMat(加色、不寫深度、雙面、吃霧)',
      !!gv && gv.color.getHex() === dm.color.getHex() && gv.transparent === dm.transparent
      && gv.blending === dm.blending && gv.depthWrite === dm.depthWrite
      && gv.fog === dm.fog && gv.side === dm.side,
      `#${gv?.color.getHexString()} blending ${gv?.blending} depthWrite ${gv?.depthWrite}`
      + ` side ${gv?.side} fog ${gv?.fog}`);
    // ⚠ `ops` 這個視角在這裡是**空的**,兩邊都空:它只收 fillRect 與 stroke,而這張
    // 貼圖整張是 `beginPath / arc / fill`(demo 自己寫「故意不填背景」)。拿 `ops` 比
    // 就是拿兩個空陣列比 —— 恆真句,而且它會在貼圖被改壞的那一天照樣通過。所以用
    // `trace`(資訊量的上界,含樣式變更、有順序)。
    const gvTrace = (gv?.map?.image as RecCanvas | undefined)?.trace ?? [];
    const demoCanvas = pool.sparkTexture();
    const demoTrace = demoCanvas.trace;
    const same = gvTrace.length === demoTrace.length
      && gvTrace.every((t, i) => t.toLowerCase() === demoTrace[i].toLowerCase());
    check('火花貼圖跟 demo 的 sparkTexture() 逐筆相同(30 圈放射衰減,不填背景)',
      same && demoTrace.length >= 30
      && (gv?.map?.image as RecCanvas | undefined)?.width === demoCanvas.width
      && (gv?.map?.image as RecCanvas | undefined)?.height === demoCanvas.height,
      `${gvTrace.length} 筆 vs demo ${demoTrace.length} 筆`
      + ` / ${demoCanvas.width}×${demoCanvas.height}`);
  }

  // ── 一幀,兩邊逐個矩陣比對 ──
  const demoGroup = new THREE.Group();
  const disposables: THREE.BufferGeometry[] = [];
  const demoSparks: DemoSpark[] = [];
  const demo = demoDupont(pathReader(g));
  const lengthM = (g.userData._routeCum as number[]).slice(-1)[0];
  demo.buildDupont(demoGroup, 0, lengthM, disposables, demoSparks);

  // 容量。**刻意的分歧要被斷言下來**(DEMO_POC_GUIDE §5):demo 是固定池,gameview
  // 的容量跟著路線長。
  //
  // ⚠ 這條需要**第二個 fixture**,而那不是保險是必要的:4 km 的直線剛好長出 64 個
  // 接點,也就是剛好等於 demo 的 `SPARK_CAP = 64`。只用它的話「跟著路線長」與「固定
  // 64」在這條路線上完全分不出來 —— 正是這個 repo 一再出現的「兩種實作在出貨的數字
  // 下等價」。8 km 那條才把兩者分開。
  {
    const demoCap = pool.SPARK_CAP;
    check('容量 = 整條路線的接點數(4 km 這條剛好也是 64,跟 SPARK_CAP 撞號)',
      !!sp && sp.instanceMatrix.count === demoSparks.length,
      `gameview ${sp?.instanceMatrix.count} vs 接點 ${demoSparks.length}`
      + ` vs demo SPARK_CAP ${demoCap}`);
    const g2 = buildBody(makeRoute(25, 121, 400, 0));       // 8 km
    let sp2: THREE.InstancedMesh | null = null;
    g2.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (m.isInstancedMesh && m.name === 'route/spark') sp2 = m;
    });
    const cap2 = (sp2 as THREE.InstancedMesh | null)?.instanceMatrix.count ?? -1;
    check('而且它真的跟著路線長:8 km 的容量是 4 km 的兩倍,不是停在 SPARK_CAP',
      cap2 > demoCap && Math.abs(cap2 - 2 * (sp?.instanceMatrix.count ?? 0)) <= 2
      && demoCap === 64,
      `8 km → ${cap2} 個接點(4 km → ${sp?.instanceMatrix.count},SPARK_CAP ${demoCap})`);
    disposeRouteLine(g2);
  }

  feed(85, 1 / 60);
  const u = pulseOffset(g);
  const n = pool.frame(demoSparks, u, 1);

  check('餵了訊號之後畫的張數 = 窗裡的接點數(窗沒開 = 整條路線)',
    !!sp && sp.count === n && n > 0 && sp.visible === true,
    `gameview ${sp?.count} vs demo ${n}`);

  {
    // 這個 fixture 必須真的有接點正在被電流經過 —— 全部都停在 0.001 的話,
    // 「兩邊相等」就只是在比一排相同的常數,是恆真句。
    const scaleOf = (m: THREE.InstancedMesh, i: number): number => {
      const mm = new THREE.Matrix4();
      m.getMatrixAt(i, mm);
      return new THREE.Vector3().setFromMatrixScale(mm).x;
    };
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, scaleOf(demoIm, i));
    check('(這個 fixture 真的有接點被電流打亮 —— 不是一排 0.001 的恆真比對)',
      peak > 1, `最大 scale ${peak.toFixed(4)}(靜止值 0.001,滿亮 ${(0.001 + 5.4).toFixed(3)})`);

    const a = new THREE.Matrix4(), b = new THREE.Matrix4();
    let worst = 0;
    for (let i = 0; i < n && sp; i++) {
      sp.getMatrixAt(i, a);
      demoIm.getMatrixAt(i, b);
      for (let k = 0; k < 16; k++) worst = Math.max(worst, Math.abs(a.elements[k] - b.elements[k]));
    }
    check('每一片火花的位置與大小逐個等於 demo 那一段 animate 算出來的'
      + '(0.028 起、0.085 退、5.4 倍、抬 DUP_Y + 0.9)',
      !!sp && sp.count === n && worst < 1e-6,
      `最大偏差 ${worst.toExponential(2)}`);
  }

  // ── 這批火花的帳面成本,量出來寫在這裡 ──
  //
  // ⚠ **`render-probe` 的 CENSUS 看不到它**,而那是 probe 會騙人的一個新例子:
  // render-probe 建完場景就光柵化,一幀都不推,所以這批 `count = 0 / visible = false`
  // 的 instance 在 `isShown()` 那一關就被跳過 —— 三個世界的 census 因此在這一輪
  // 「一格都沒動」,而電子世界在**真的騎乘中**是多一個 draw call 的。那個數字必須
  // 有人講出來,所以在這裡量。
  {
    const { census } = await import('./scene-census.mjs');
    type C = { calls: number; geometries: number; materials: number };
    // 全新的一份 —— 上面已經餵過訊號的那條路線,它的火花早就 visible 了。
    const fresh = buildBody(straight);
    const idle = census(fresh, '') as C;
    circuit.updateRiderSignals?.({ cadenceRpm: 85, powerW: null, powerSource: null }, 1 / 60);
    const live = census(fresh, '') as C;
    check('火花的帳面成本:被驅動時 +1 draw call / +1 geometry / +1 material,沒被驅動時 0',
      idle.calls === 9 && live.calls - idle.calls === 1
      && live.geometries - idle.geometries === 1
      && live.materials - idle.materials === 1,
      `靜止 ${idle.calls} draws / ${idle.geometries} geo / ${idle.materials} mat`
      + ` → 驅動中 ${live.calls} / ${live.geometries} / ${live.materials}`);
    disposeRouteLine(fresh);
  }

  // 相位真的在動:換一個 pulseU,同一個接點的亮度要不一樣。
  {
    const scales = (): number[] => {
      const out: number[] = [];
      const mm = new THREE.Matrix4();
      for (let i = 0; i < (sp?.count ?? 0); i++) {
        sp!.getMatrixAt(i, mm);
        out.push(new THREE.Vector3().setFromMatrixScale(mm).x);
      }
      return out;
    };
    const before = scales();
    for (let i = 0; i < 8; i++) feed(110, 0.02);
    const after = scales();
    const moved = before.filter((s, i) => Math.abs(s - after[i]) > 1e-4).length;
    check('火花跟著相位走(推了脈衝之後,亮著的接點換人)',
      moved > 0, `${moved}/${before.length} 個接點的亮度變了`);
  }

  // 窗:火花跟線身用同一個判準,所以開窗之後兩邊一起縮。
  //
  // ⚠ 這裡要**兩個**窗,而那是突變測試逼出來的:只用中段那個窗的話,近端那條
  // (`d0 - DUP_MAX`)一個人就把數量壓下來了,於是「遠端那條有沒有生效」完全沒被測到
  // —— 把 `winD1` 改成恆為 +∞ 照樣通過。第二個窗貼著路線起點,近端條件在那裡不咬,
  // 只剩遠端。
  {
    const countWith = (range: { startIdx: number; endIdx: number } | null): number => {
      setRouteLineWindow(g, range);
      feed(85, 1 / 60);
      return sp?.count ?? -1;
    };
    /**
     * 線身那邊**同一個窗**畫到了幾個接點,從 `route/shell` 的 drawRange 反推。
     *
     * 這是這條斷言的重點:不要在測試裡把 `s.d < winD0 - DUP_MAX || s.d > winD1` 再寫
     * 一遍(那只是把同一條式子抄兩份,任何一邊改了都一起改)。火花跟線身讀的是同一個
     * 範圍,所以拿**另一個消費端**的結果來比 —— 兩邊不一致就是有一邊的判準被動過。
     */
    const drawnJoints = (): number => {
      let mesh: THREE.Mesh | null = null;
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.name === 'route/shell') mesh = m;
      });
      const geo = (mesh as THREE.Mesh | null)?.geometry;
      const total = geo?.index?.count ?? 0;
      if (!geo || !total || !sparksPerRoute) return -1;
      const perJoint = total / sparksPerRoute;          // 母頭 + 公頭 = 兩個 box
      const r = geo.drawRange;
      const drawn = Math.min(r.count === Infinity ? total : r.count, total - r.start);
      return drawn / perJoint;
    };
    const sparksPerRoute = sp?.instanceMatrix.count ?? 0;
    const middle = countWith({ startIdx: 20, endIdx: 60 });
    const middleWire = drawnJoints();
    const head = countWith({ startIdx: 0, endIdx: 40 });      // 只有遠端會咬
    const headWire = drawnJoints();
    const whole = countWith(null);
    check('開窗之後只算窗裡的火花,而且張數跟線身畫到的接點數一致(同一個判準)',
      middle > 0 && middle < whole && middle === middleWire,
      `窗裡火花 ${middle} / 線身接點 ${middleWire} / 整條 ${whole}`);
    check('而且**遠端**那條也真的生效(貼著起點的窗,近端條件不咬)',
      head > 0 && head < whole && head === headWire,
      `路線頭 40 個 GPX 點 → 火花 ${head} / 線身 ${headWire} / 整條 ${whole}`);
  }

  // refresh 不會讓火花越長越多。這條的原因很具體:`buildDupont` 的 `sparks.push` 在
  // 每次重建接點時都會跑,而地形是串流進來的 —— 一趟騎乘裡每個接點會被重建很多次。
  // 用 push 累積的話這個陣列會整趟一直長,而症狀只有「記憶體慢慢多」跟「火花的張數
  // 對不上接點數」,不會有例外。
  {
    const jointCount = sp?.count ?? -1;
    for (let i = 0; i < 5; i++) {
      projectRouteLineOntoTerrain(g, () => 0, undefined, { startIdx: 0, endIdx: 40 });
    }
    feed(85, 1 / 60);
    check('重投影五次之後火花的張數不變(接點是寫回原位,不是再 push 一個)',
      (sp?.count ?? -2) === jointCount && jointCount > 0,
      `${jointCount} → ${sp?.count}`);
  }

  // ── 亮度:功率 × 日夜,demo applyDayNight 的那兩行 ──
  {
    const pedal = demoPedal();
    const wires: THREE.MeshPhongMaterial[] = [];
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.name.startsWith('route/wire')) wires.push(m.material as THREE.MeshPhongMaterial);
    });
    const gvSpark = sp?.material as THREE.MeshBasicMaterial;

    for (const [k, watts] of [[1, 320], [1, 80], [0.4, 200]] as [number, number][]) {
      setNightLitFactor(k);
      feed(85, 1 / 60, watts, 'meter');
      pedal.setPedal(85, watts);
      const wantWire = pedal.wireIntensity(1);      // k 那一半由 emissive 顏色帶走
      const wantSpark = pedal.sparkOpacity(k);
      check(`量到的 ${watts} W · 夜 ${k} → 線身亮度與火花不透明度都等於 demo 那兩行`,
        wires.length === 6
        && wires.every((m) => Math.abs(m.emissiveIntensity - wantWire) < 1e-12)
        && Math.abs(gvSpark.opacity - wantSpark) < 1e-12,
        `線身 ${wires[0]?.emissiveIntensity.toFixed(6)} / demo ${wantWire.toFixed(6)}`
        + ` · 火花 ${gvSpark.opacity.toFixed(6)} / demo ${wantSpark.toFixed(6)}`
        + `(wg ${pedal.wattGain().toFixed(4)})`);
    }

    // 估計功率 ≠ 量到的功率。同一個瓦數,標成 estimated 就必須落回中性值。
    setNightLitFactor(1);
    feed(85, 1 / 60, 320, 'meter');
    const measured = wires[0].emissiveIntensity;
    feed(85, 1 / 60, 320, 'estimated');
    const estimated = wires[0].emissiveIntensity;
    feed(85, 1 / 60, null, null);
    const unknown = wires[0].emissiveIntensity;
    pedal.setPedal(85, pedal.openingWatts);
    const neutral = pedal.wireIntensity(1);
    check('powerSource = estimated 走「不知道」那一條(等於沒有功率計,不等於量到的)',
      Math.abs(estimated - neutral) < 1e-12 && Math.abs(unknown - neutral) < 1e-12
      && Math.abs(measured - neutral) > 1e-3,
      `量到 320 W → ${measured.toFixed(6)} / 估計 320 W → ${estimated.toFixed(6)}`
      + ` / 沒有 → ${unknown.toFixed(6)} / demo 中性(${pedal.openingWatts} W)`
      + ` → ${neutral.toFixed(6)}`);
    setNightLitFactor(0);
  }

  for (const geo of disposables) geo.dispose();
  disposeRouteLine(g);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[route body: 生命週期(窗、重投影、回收)]');
// ═════════════════════════════════════════════════════════════════════════════
{
  const g = buildBody(straight);
  const meshes: THREE.Mesh[] = [];
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const total = meshes.reduce((n, m) => n + (m.geometry.index?.count ?? 0), 0);
  const drawn = (): number => meshes.reduce((n, m) => {
    const r = m.geometry.drawRange;
    return n + Math.min(r.count === Infinity || r.count === null ? Infinity
      : r.count, (m.geometry.index?.count ?? 0) - r.start);
  }, 0);
  check('沒開窗就是整條路都畫', drawn() === total, `${drawn() / 3} 個三角形`);
  setRouteLineWindow(g, { startIdx: 20, endIdx: 60 });
  const near = drawn();
  check('開窗之後只畫窗裡那一段(遠處的線不再是天上的一條黑線)',
    near > 0 && near < total / 3,
    `${near / 3} of ${total / 3} 個三角形(200 個 GPX 點裡的 20–60)`);
  setRouteLineWindow(g, null);
  check('窗關掉會回到整條', drawn() === total);

  // 地形是串流進來的:接點的地面高度比幾何晚到,重投影只能動它自己那一段。
  const y0 = new THREE.Box3().setFromObject(g).min.y;
  projectRouteLineOntoTerrain(g, () => 500, undefined, { startIdx: 0, endIdx: 20 });
  const box = new THREE.Box3().setFromObject(g);
  check('一個 chunk 的重投影只抬它自己那一段(其餘留在原地)',
    box.max.y > 500 && Math.abs(box.min.y - y0) < 0.01,
    `y ${box.min.y.toFixed(2)} … ${box.max.y.toFixed(2)} m`);

  let wireMat: THREE.Material | null = null;
  g.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.name === 'route/wire0') wireMat = mesh.material as THREE.Material;
  });
  disposeRouteLine(g);
  check('回收之後 group 是空的', g.children.length === 0);
  const g2 = buildBody(straight);
  let again: THREE.Material | null = null;
  g2.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.name === 'route/wire0') again = mesh.material as THREE.Material;
  });
  check('回收**沒有**把 strategy 的共用材質帶走(重建拿回同一份實例)',
    !!wireMat && again === wireMat
    && (wireMat as THREE.Material).userData.shared === true);
  disposeRouteLine(g2);
}

// `setNightLitFactor` is a GLOBAL write over every registered material, including
// the ones checks that run after this one own. Put it back where it started.
setNightLitFactor(0);
circuit.dispose();
plastic.dispose();
