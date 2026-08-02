/**
 * `[shadow flags vs demo]` — every `castShadow` / `receiveShadow` the three 3D
 * demos declare, against the batch the port hands to the renderer.
 *
 * The sun shadow map went in at c77a756. It is being computed; most of the
 * decoration was not declaring anything, so most of the world was not in it.
 * This check is the port of those declarations, and the thing that keeps them.
 *
 * ## Why the flags are not just cosmetic here
 *
 * `mergeBuildingDecorations` (building-renderer.ts) puts BOTH flags in its batch
 * key, quoting the circuit demo's own reason:
 *
 * > 陰影旗標進 key:InstancedMesh 的 castShadow 是整批的,不是逐 instance 的。
 * > 輝光管數字 / 玻璃 / 光暈都是 castShadow=false,跟會投影的方塊混在一起就會
 * > 多出一堆本來沒有的影子。
 *
 * So a wrong flag is a wrong shadow AND an extra draw call, and "turn everything
 * on, it's safer" is the one answer that is wrong twice.
 *
 * ## How the demo side is obtained (CUSTOM_WORLD_INSTRUCTIONS §0.0 rule 5)
 *
 * Nothing here is a transcribed constant. Each demo object's effective pair is
 * composed from two things, both read out of `plan/*-town-demo.html`:
 *
 *  1. **The primitive that built it, EXECUTED.** `plastic:scaledBox`,
 *     `paper:box`, `circuit:box/cyl/dome` … are sliced out and run against the
 *     real three; the pair they leave on their return value is read off the
 *     object. That is why `circuit:cyl` being (cast, NOT receive) is a fact this
 *     file discovers rather than a number somebody typed — and it is the single
 *     most load-bearing asymmetry in the whole port (the circuit world has 21
 *     parts whose receiveShadow comes from nothing but which helper made them).
 *  2. **The explicit assignments, parsed in order** from the same sliced region.
 *     `x.castShadow = false` after `box(...)` means (false, TRUE), not
 *     (false, false) — twelve circuit parts are exactly that shape and the port
 *     had all twelve at (false, false).
 *
 * On top of that there is a COMPLETENESS guard: every identifier that assigns a
 * shadow flag anywhere in a sliced region must appear in that region's table. A
 * new declaration in a demo therefore cannot land silently; it fails here until
 * someone says where it went (or writes down that it has nowhere to go).
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/shadow-flags-vs-demo.ts
 */
import { readFileSync } from 'node:fs';

// 共用的 canvas stub。**不要**自己裝 `globalThis.document` —— 貼圖快取是模組層
// 的,自己裝一份會把別人已經畫過的畫布換掉(六支檢查因此靜靜地假通過過一次)。
const { installRecordingCanvas } = await import('./recording-canvas.ts');
installRecordingCanvas();

const THREE = await import('three');
const { createTerrainStyleStrategy } = await import('@/game/terrain/terrain-style-strategy');
const { buildBuildingMeshes } = await import('@/game/terrain/building-renderer');
const { buildTreeMeshes } = await import('@/game/terrain/tree-renderer');

type World = 'plastic' | 'paper' | 'circuit';
type Flags = { cast: boolean; recv: boolean };

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const fstr = (f: Flags): string => `${f.cast ? 'C' : '-'}${f.recv ? 'R' : '-'}`;

// ═══════════════════════════════════════════════════════════════════════════
// Slicing the demos
// ═══════════════════════════════════════════════════════════════════════════

const SRC: Record<World, string> = {
  plastic: readFileSync('plan/plastic-town-demo.html', 'utf8'),
  paper: readFileSync('plan/paper-town-demo.html', 'utf8'),
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
/** A brace/paren-balanced statement starting at `head`. */
function sliceStmt(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`cannot slice statement ${head}`);
  let depth = 0, started = false;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') { depth++; started = true; }
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (started && depth === 0) return src.slice(at, src.indexOf(';', i) + 1);
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

// ═══════════════════════════════════════════════════════════════════════════
// The demos' PRIMITIVES, executed
// ═══════════════════════════════════════════════════════════════════════════
//
// These are the helpers that put the flags on in the first place. Running them
// is what makes the rest of this file a comparison rather than a transcription:
// change `circuit`'s `cyl()` to open receiveShadow and every circuit expectation
// that inherits from it moves with it.

function runDemo(prelude: string[], tail: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('THREE', [...prelude, tail].join('\n'))(THREE);
}
const flagsOf = (o: THREE.Object3D): Flags =>
  ({ cast: o.castShadow, recv: o.receiveShadow });

/** `ctor name` → the pair that constructor leaves behind, EXECUTED. */
const PRIMITIVES: Record<World, Record<string, Flags>> = {
  plastic: {}, paper: {}, circuit: {},
};

{
  const s = SRC.plastic;
  const built = runDemo([
    'const toonShared = () => new THREE.MeshBasicMaterial();',
    'const glossShared = toonShared;',
    sliceLine(s, '  const unitBox = new THREE.BoxGeometry(1, 1, 1);'),
    'const studGeo = new THREE.BoxGeometry(1, 1, 1);',
    // `plasticSlab` used to be a sixth primitive here. It went with the stacked
    // toy-brick mound on 2026-07-28 (the demo's ground is real DEM now, so the
    // fake hill became the demo drawing something wrong) — see the tombstone in
    // `plan/plastic-town-demo.html`. The blanket "every plastic primitive casts
    // AND receives" below still runs over the remaining four; the reverse
    // assertion that stops the mound coming back lives in `props-vs-demo.ts`.
    sliceFn(s, 'studInstances'),
    sliceFn(s, 'scaledBox'),
    sliceFn(s, 'boxBatcher'),
    sliceFn(s, 'plasticBox'),
  ], `
    const b = boxBatcher();
    b.push(new THREE.MeshBasicMaterial(), 0, 0, 0, 0, 1, 1, 1);
    const parent = new THREE.Group();
    b.flush(parent);
    return {
      studInstances: studInstances([[0, 0, 0]], 1, 1, '#fff'),
      scaledBox: scaledBox(1, 1, 1, new THREE.MeshBasicMaterial()),
      boxBatcher: parent.children[0],
      plasticBox: plasticBox(1, 1, 1, new THREE.MeshBasicMaterial()),
    };
  `) as Record<string, THREE.Object3D>;
  for (const [k, v] of Object.entries(built)) PRIMITIVES.plastic[k] = flagsOf(v);
}
{
  const s = SRC.paper;
  const built = runDemo([
    'const shared = (_k, f) => f();',
    sliceLine(s, '  const unitBox = shared('),
    sliceFn(s, 'box'),
  ], `
    return { box: box(1, 1, 1, new THREE.MeshBasicMaterial()) };
  `) as Record<string, THREE.Object3D>;
  for (const [k, v] of Object.entries(built)) PRIMITIVES.paper[k] = flagsOf(v);
}
{
  const s = SRC.circuit;
  const built = runDemo([
    sliceLine(s, '  const unitBox = new THREE.BoxGeometry(1, 1, 1);'),
    sliceLine(s, '  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 16);'),
    sliceLine(s, '  const unitCyl8 = new THREE.CylinderGeometry(1, 1, 1, 8);'),
    sliceLine(s, '  const unitHemi = new THREE.SphereGeometry(1, 16, 8'),
    sliceFn(s, 'box'),
    sliceFn(s, 'cyl'),
    sliceFn(s, 'dome'),
  ], `
    const m = new THREE.MeshBasicMaterial();
    return { box: box(1, 1, 1, m), cyl: cyl(1, 1, m), dome: dome(1, m) };
  `) as Record<string, THREE.Object3D>;
  for (const [k, v] of Object.entries(built)) PRIMITIVES.circuit[k] = flagsOf(v);
}

/** three's own defaults — executed, so a three upgrade that changed them would
 *  be visible here rather than silently re-baselining every "the demo left this
 *  alone" expectation. */
const THREE_DEFAULT: Flags = flagsOf(new THREE.Mesh());

console.log('\n[shadow flags vs demo — the demos\' own primitives, executed]');
for (const w of ['plastic', 'paper', 'circuit'] as const) {
  console.log(`  ${w}: `
    + Object.entries(PRIMITIVES[w]).map(([k, v]) => `${k}=${fstr(v)}`).join(' ')
    + `  |  three default ${fstr(THREE_DEFAULT)}`);
}
check('three\'s Object3D still defaults to no shadows at all',
  !THREE_DEFAULT.cast && !THREE_DEFAULT.recv,
  'every "the demo never touched this one" expectation below rests on it');
// The two facts the rest of the circuit table hangs off. Asserted rather than
// assumed: if `cyl()` ever opened receiveShadow, ~20 expectations would move and
// nothing else in this file would notice.
check('circuit: box() opens BOTH flags, cyl()/dome() open only castShadow',
  PRIMITIVES.circuit.box.cast && PRIMITIVES.circuit.box.recv
  && PRIMITIVES.circuit.cyl.cast && !PRIMITIVES.circuit.cyl.recv
  && PRIMITIVES.circuit.dome.cast && !PRIMITIVES.circuit.dome.recv,
  `box=${fstr(PRIMITIVES.circuit.box)} cyl=${fstr(PRIMITIVES.circuit.cyl)} `
  + `dome=${fstr(PRIMITIVES.circuit.dome)}`);
check('plastic/paper: every primitive opens BOTH flags',
  Object.values(PRIMITIVES.plastic).every((f) => f.cast && f.recv)
  && Object.values(PRIMITIVES.paper).every((f) => f.cast && f.recv),
  'so in those two worlds it is the parts NOT built by a primitive that differ');

// ═══════════════════════════════════════════════════════════════════════════
// The demos' explicit assignments, parsed
// ═══════════════════════════════════════════════════════════════════════════

/** One sliced region of a demo, plus what the port did with each thing in it. */
interface Site {
  world: World;
  /** Human label for failures. */
  name: string;
  /** The sliced source. */
  src: string;
  /**
   * Every identifier in `src` that assigns a shadow flag, or is otherwise part
   * of this site's answer, mapped to the primitive that built it. `null` = the
   * value is not a literal (paper's `batchGroup` ORs), so this file forms no
   * opinion — those identifiers are listed only to satisfy the completeness
   * guard.
   */
  vars: Record<string, string | null>;
}

const SITES = new Map<string, Site>();

function site(world: World, name: string, src: string, vars: Site['vars']): void {
  const key = `${world}:${name}`;
  if (SITES.has(key)) throw new Error(`duplicate site ${key}`);
  SITES.set(key, { world, name, src, vars });
}

/** All `<ident>.castShadow|receiveShadow = <rhs>;` in a region, in order. */
function assignments(src: string): { id: string; flag: 'cast' | 'recv'; rhs: string }[] {
  const out: { id: string; flag: 'cast' | 'recv'; rhs: string }[] = [];
  for (const m of src.matchAll(/([A-Za-z0-9_$]+)\.(castShadow|receiveShadow)\s*=\s*([^;]+);/g)) {
    out.push({ id: m[1], flag: m[2] === 'castShadow' ? 'cast' : 'recv', rhs: m[3].trim() });
  }
  return out;
}

/**
 * The demo's effective pair for `id` at `world:siteName`.
 *
 * = the primitive's pair (executed) with every explicit literal assignment
 * applied in source order. Throws rather than guessing — a site that does not
 * declare the variable, or a non-literal RHS on a variable this file claims to
 * understand, is a bug in the table and must not silently pass.
 */
function demoFlags(world: World, siteName: string, id: string): Flags {
  const s = SITES.get(`${world}:${siteName}`);
  if (!s) throw new Error(`no site ${world}:${siteName}`);
  if (!(id in s.vars)) throw new Error(`${world}:${siteName} has no entry for '${id}'`);
  const prim = s.vars[id];
  if (prim === null) throw new Error(`${world}:${siteName}.${id} is declared opinion-free`);
  let f: Flags;
  if (prim === 'three') f = { ...THREE_DEFAULT };
  else {
    const p = PRIMITIVES[world][prim];
    if (!p) throw new Error(`${world} has no executed primitive '${prim}'`);
    f = { ...p };
  }
  for (const a of assignments(s.src)) {
    if (a.id !== id) continue;
    if (a.rhs !== 'true' && a.rhs !== 'false') {
      throw new Error(`${world}:${siteName}.${id} — non-literal RHS '${a.rhs}'`);
    }
    f[a.flag] = a.rhs === 'true';
  }
  return f;
}

// ── plastic ────────────────────────────────────────────────────────────────
{
  const s = SRC.plastic;
  site('plastic', 'cupTower', sliceFn(s, 'cupTower'), {
    im: 'three',      // 每層一個 InstancedMesh 的杯子 → 移植的 buildCupWalls
    plate: 'three',   // 層間白盤 → 移植走 BODY(`shape: 'plate'`),見下面的 note
  });
  site('plastic', 'alphabetBlocks', sliceFn(s, 'alphabetBlocks'), {
    plinth: 'three',  // 底座 → BODY
    body: 'three',    // 積木本體 → BODY
    rim: 'three',     // 字的外框 → buildLetterRelief 的 rims
    im: 'three',      // 浮凸的字 → buildLetterRelief 的 ink / lite
  });
  site('plastic', 'dominoWall', sliceFn(s, 'dominoWall'), {
    plinth: 'three',  // → BODY
    im: 'three',      // inst() 收的三批:骨牌本體(BODY)/ 中線 / 點
    board: 'three',   // 屋頂標誌牌
    v: 'three',       // 三角標記
    hb: 'three',      // 一個空的 Object3D 佔位(demo 自己也沒有幾何),無對應物
  });
  site('plastic', 'flushSigns', sliceFn(s, 'flushSigns'), {
    im: 'three',      // bin.board + bin.field
  });
  site('plastic', 'bubbleLamp', sliceFn(s, 'bubbleLamp'), {
    tube: 'three', bubble: 'three', blob: 'three',
  });
  site('plastic', 'coinField', sliceFn(s, 'coinField'), {
    body: 'three', inner: 'three', nubs: 'three',
  });
  site('plastic', 'makeCheckpoint', sliceFn(s, 'makeCheckpoint'), {
    base: 'three', post: 'three', plate: 'three', sticker: 'three', ltr: 'three',
  });
  // The bike is an IIFE, not a named function — slice the block.
  site('plastic', 'bike',
    sliceBlock(s, '  // ── 玩具積木單車 ──', '    scene.add(bike);'), {
      tire: 'three', frame: 'three', saddle: 'three',
    });
  // The clouds. Its two boxes go through `plasticBox`, which opens both — the
  // one place in these three demos where a cloud casts. See the divergence
  // check at the bottom for why the port does not.
  site('plastic', 'clouds',
    sliceBlock(s, '  // ── 積木雲 ──', '  })();'), {});
}

// ── paper ──────────────────────────────────────────────────────────────────
{
  const s = SRC.paper;
  site('paper', 'eraserHouse', sliceFn(s, 'eraserHouse'), {
    m: 'three',       // 紙套上緣的尖角(unitTooth)
    band: 'box',      // 紅色塑膠膜 —— 已經是 box(),那句 castShadow 是多餘的
  });
  site('paper', 'flagDispenser', sliceFn(s, 'flagDispenser'), {});
  site('paper', 'labelSign', sliceFn(s, 'labelSign'), {
    tape: 'three',    // unitLabelTape
    tri: 'three',     // unitTri
  });
  site('paper', 'tapeDispenser', sliceFn(s, 'tapeDispenser'), {
    roll: 'three',    // unitCyl(18) → BODY
    hub: 'three',     // unitCyl(12)
    t: 'three',       // unitTooth 鋸齒
  });
  site('paper', 'hiliteLamp', sliceFn(s, 'hiliteLamp'), {
    barrel: 'three', cap: 'three', nib: 'three', glow: 'three',
  });
  site('paper', 'coinBatch', sliceFn(s, 'coinBatch'), {
    heads: 'three', pins: 'three',
  });
  site('paper', 'makeCheckpoint', sliceFn(s, 'makeCheckpoint'), {
    pole: 'three', head: 'three',
  });
  site('paper', 'treeBucket', sliceFn(s, 'treeBucket'), {
    im: null,         // `if (depthMat) im.castShadow = true` — 條件式,見樹的那一段
  });
  site('paper', 'bike',
    sliceBlock(s, '  // ── 迴紋針單車 ──', '    bikeLean.add(crank);'), {
      rim: 'three', frame: 'three', saddle: 'three',
    });
  site('paper', 'clouds',
    sliceBlock(s, '  // ── 棉花球雲', '  })();'), {});
}

// ── circuit ────────────────────────────────────────────────────────────────
{
  const s = SRC.circuit;
  site('circuit', 'ledBody', sliceFn(s, 'ledBody'), {
    rim: 'cyl', body: 'cyl', head: 'dome', flat: 'box',
    anvil: 'box', post: 'box', cup: 'cyl', die: 'cyl',
  });
  site('circuit', 'legRow', sliceFn(s, 'legRow'), {
    knee: 'box', drop: 'box', fillet: 'cyl',
  });
  // DIP 本體。**引腳根部那一排窗在這裡面**,不是事後蓋上去的網格:
  // `win = box(step * 0.42, h * 0.2, 0.16, dipWinMat)` 再 `win.castShadow = false`
  // → (false, TRUE)。移植原本讓它走 `facadeWindows` 的共用模板(全世界一塊
  // `BoxGeometry(1.0, 0.55, 0.16)`),現在跟 demo 一樣長在本體那一側。
  site('circuit', 'dipIC', sliceFn(s, 'dipIC'), {
    win: 'box',       // 引腳窗 → buildBuildingDecoration 的 dipWin 那一批
  });
  site('circuit', 'electrolyticCap', sliceFn(s, 'electrolyticCap'), {
    sleeve: 'cyl',    // → BODY
    ring: 'three',    // 捲邊溝槽的環(TorusGeometry,沒經過任何 helper)
  });
  site('circuit', 'nixieSign', sliceFn(s, 'nixieSign'), {
    sock: 'box',      // → BODY
    lug: 'box',       // 管座焊接腳
    tb: 'cyl',        // → BODY
    glass: 'cyl', cap: 'dome',
    halo: 'three',    // glowQuad
    rod: 'box',       // 陰極支架 —— 移植裡沒有這一件(見報告)
  });
  site('circuit', 'nixieDigit', sliceFn(s, 'nixieDigit'), { b: 'box' });
  site('circuit', 'transformer', sliceFn(s, 'transformer'), {
    base: 'box', t: 'box', p: 'box', coil: 'cyl', cheek: 'cyl',
    ring: 'three',    // unitTorus 的銅圈
    band: 'box',
  });
  site('circuit', 'addBuildingLights', sliceFn(s, 'addBuildingLights'), { b: 'box' });
  site('circuit', 'vacuumTube', sliceFn(s, 'vacuumTube'), {
    lug: 'box', base: 'cyl', collar: 'cyl',
    glass: 'cyl', top: 'dome', mica: 'cyl',
    f: 'box', fb: 'cyl', plate: 'box', seam: 'box',
    ring: 'three',    // unitTorusThin 的柵極細絲
    rod: 'box',
    getter: 'three',  // getterCapGeo 的球冠
    flashRing: 'cyl',
  });
  site('circuit', 'glyphStrokes', sliceFn(s, 'glyphStrokes'), { b: 'box' });
  site('circuit', 'epaperSign', sliceFn(s, 'epaperSign'), {
    back: 'box', bar: 'box', side: 'box', panel: 'box',
    conn: 'box', ribbon: 'box', arm: 'box',
  });
  site('circuit', 'makeCoin', sliceFn(s, 'makeCoin'), {
    base: 'cyl', top: 'cyl', b: 'box',
  });
  site('circuit', 'makeCheckpoint', sliceFn(s, 'makeCheckpoint'), {
    base: 'box', pin: 'box', jumper: 'box', grip: 'box',
  });
  site('circuit', 'discCapTree', sliceFn(s, 'discCapTree'), {
    disc: 'three', leg: 'box',
  });
  site('circuit', 'bike',
    sliceBlock(s, '  // 螢光輪單車', '    bikeLean.add(crank);'), {
      ring: 'three', tyre: 'three', sp: 'three', hub: 'three',
      frame: 'three', edgeTop: 'three', bar: 'three', grip: 'three', saddle: 'three',
    });
  site('circuit', 'clouds',
    sliceBlock(s, '  // 雲 = 防靜電泡棉', '  })();'), {});
}

// ── The completeness guard ─────────────────────────────────────────────────
//
// R1 in its strongest form: a demo cannot grow a declaration this file has not
// been told about. Without it, "every `= true` has a counterpart" is only true
// of the ones somebody remembered to list.
console.log('\n[shadow flags vs demo — every declaration in a sliced region is accounted for]');
for (const [key, s] of SITES) {
  const seen = new Set(assignments(s.src).map((a) => a.id));
  const unlisted = [...seen].filter((id) => !(id in s.vars));
  check(`${key}: no unlisted shadow declaration`,
    unlisted.length === 0,
    unlisted.length ? `未登記: ${unlisted.join(', ')}` : `${seen.size} declared`);
}

// ═══════════════════════════════════════════════════════════════════════════
// The port side
// ═══════════════════════════════════════════════════════════════════════════

/** Every Mesh under `root`, depth first, in child order. */
function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh); });
  return out;
}

/** One expected part: which role it plays, and where the demo says its pair
 *  comes from. `want` may also be given directly for a deliberate divergence,
 *  which then has to carry its reason in `why`. */
type Row =
  | { role: string; from: [World, string, string] }
  | { role: string; want: Flags; why: string };

function rowFlags(r: Row): Flags {
  return 'from' in r ? demoFlags(...r.from) : r.want;
}

/**
 * Compare a built prop against an ORDERED list of expectations.
 *
 * Ordered, not set-matched, on purpose: a set comparison passes when two parts
 * swap their flags, and "the glass casts and the socket doesn't" is exactly the
 * failure this world has. A length mismatch is also a failure — a part appearing
 * or vanishing has to be looked at, not absorbed.
 */
function expect(label: string, root: THREE.Object3D | null, rows: Row[]): void {
  if (!root) { check(label, false, 'builder returned null'); return; }
  const got = meshes(root);
  if (got.length !== rows.length) {
    check(label, false, `${rows.length} parts expected, ${got.length} built`);
    return;
  }
  const bad: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const want = rowFlags(rows[i]);
    const have = flagsOf(got[i]);
    if (want.cast !== have.cast || want.recv !== have.recv) {
      bad.push(`${rows[i].role}: demo ${fstr(want)} vs ours ${fstr(have)}`);
    }
  }
  check(label, bad.length === 0,
    bad.length ? bad.join(' | ')
      : rows.map((r, i) => `${r.role}=${fstr(flagsOf(got[i]))}`).join(' '));
}

const STYLES: Record<World, Awaited<ReturnType<typeof createTerrainStyleStrategy>>> = {
  plastic: await createTerrainStyleStrategy('plastic'),
  paper: await createTerrainStyleStrategy('paper'),
  circuit: await createTerrainStyleStrategy('circuit'),
};

// ── Props ──────────────────────────────────────────────────────────────────

console.log('\n[shadow flags vs demo — 道具]');

expect('plastic coin = demo coinField', STYLES.plastic.buildCoinMesh(), [
  { role: 'body', from: ['plastic', 'coinField', 'body'] },
  { role: 'inner', from: ['plastic', 'coinField', 'inner'] },
  { role: 'nubs', from: ['plastic', 'coinField', 'nubs'] },
]);
expect('paper coin = demo coinBatch', STYLES.paper.buildCoinMesh(), [
  { role: 'head', from: ['paper', 'coinBatch', 'heads'] },
  { role: 'pin', from: ['paper', 'coinBatch', 'pins'] },
]);
expect('circuit coin = demo makeCoin', STYLES.circuit.buildCoinMesh(), [
  { role: 'base', from: ['circuit', 'makeCoin', 'base'] },
  { role: 'top', from: ['circuit', 'makeCoin', 'top'] },
  { role: 'ridge', from: ['circuit', 'makeCoin', 'b'] },
]);

expect('plastic checkpoint = demo makeCheckpoint',
  STYLES.plastic.buildCheckpoint(0xff0000, 0, 'GO'), [
    { role: 'base', from: ['plastic', 'makeCheckpoint', 'base'] },
    { role: 'post', from: ['plastic', 'makeCheckpoint', 'post'] },
    { role: 'plate', from: ['plastic', 'makeCheckpoint', 'plate'] },
    { role: 'sticker', from: ['plastic', 'makeCheckpoint', 'sticker'] },
    // The label rides on this world's shared sign carrier (`buildSign`), which
    // the demo's checkpoint does not use — it places `letterGeo` meshes
    // directly. Its sign parts therefore answer to `flushSigns`, below.
    { role: 'tag:backing', from: ['plastic', 'flushSigns', 'im'] },
    { role: 'tag:field', from: ['plastic', 'flushSigns', 'im'] },
    { role: 'tag:ink', from: ['plastic', 'makeCheckpoint', 'ltr'] },
    { role: 'tag:bubble', from: ['plastic', 'makeCheckpoint', 'sticker'] },
  ]);
expect('paper checkpoint = demo makeCheckpoint',
  STYLES.paper.buildCheckpoint(0xff0000, 0, 'GO'), [
    { role: 'pole', from: ['paper', 'makeCheckpoint', 'pole'] },
    { role: 'head', from: ['paper', 'makeCheckpoint', 'head'] },
    { role: 'flag:tape', from: ['paper', 'labelSign', 'tape'] },
    { role: 'flag:ink', from: ['paper', 'eraserHouse', 'band'] },  // = the demo's box()
  ]);
expect('circuit checkpoint = demo makeCheckpoint',
  STYLES.circuit.buildCheckpoint(0xff0000, 0, 'GO'), [
    { role: 'base', from: ['circuit', 'makeCheckpoint', 'base'] },
    { role: 'pin0', from: ['circuit', 'makeCheckpoint', 'pin'] },
    { role: 'pin1', from: ['circuit', 'makeCheckpoint', 'pin'] },
    { role: 'pin2', from: ['circuit', 'makeCheckpoint', 'pin'] },
    { role: 'pin3', from: ['circuit', 'makeCheckpoint', 'pin'] },
    { role: 'jumper', from: ['circuit', 'makeCheckpoint', 'jumper'] },
    { role: 'grip', from: ['circuit', 'makeCheckpoint', 'grip'] },
    { role: 'glyphs', from: ['circuit', 'glyphStrokes', 'b'] },
  ]);

expect('plastic street lamp = demo bubbleLamp', STYLES.plastic.buildStreetLamp(0).group, [
  { role: 'tube', from: ['plastic', 'bubbleLamp', 'tube'] },
  { role: 'bubble', from: ['plastic', 'bubbleLamp', 'bubble'] },
  { role: 'blob', from: ['plastic', 'bubbleLamp', 'blob'] },
]);
expect('paper street lamp = demo hiliteLamp', STYLES.paper.buildStreetLamp(0).group, [
  { role: 'barrel', from: ['paper', 'hiliteLamp', 'barrel'] },
  { role: 'cap', from: ['paper', 'hiliteLamp', 'cap'] },
  { role: 'nib', from: ['paper', 'hiliteLamp', 'nib'] },
  { role: 'glow', from: ['paper', 'hiliteLamp', 'glow'] },
]);
expect('circuit street lamp = demo ledLamp + ledBody', STYLES.circuit.buildStreetLamp(0).group, [
  { role: 'leg0', from: ['circuit', 'nixieSign', 'lug'] },   // demo: box(0.32, len, 0.32)
  { role: 'leg1', from: ['circuit', 'nixieSign', 'lug'] },
  { role: 'rim', from: ['circuit', 'ledBody', 'rim'] },
  { role: 'body', from: ['circuit', 'ledBody', 'body'] },
  { role: 'head', from: ['circuit', 'ledBody', 'head'] },
  { role: 'flat', from: ['circuit', 'ledBody', 'flat'] },
  { role: 'anvil', from: ['circuit', 'ledBody', 'anvil'] },
  { role: 'post', from: ['circuit', 'ledBody', 'post'] },
  { role: 'cup', from: ['circuit', 'ledBody', 'cup'] },
  { role: 'die', from: ['circuit', 'ledBody', 'die'] },
]);

expect('plastic bike = demo 積木單車', STYLES.plastic.buildBikeOrnament().root, [
  { role: 'tyre0', from: ['plastic', 'bike', 'tire'] },
  { role: 'hub0', want: THREE_DEFAULT, why: 'demo: 沒宣告 — 輪圈裡面' },
  { role: 'spoke0a', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'spoke0b', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'spoke0c', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'tyre1', from: ['plastic', 'bike', 'tire'] },
  { role: 'hub1', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'spoke1a', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'spoke1b', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'spoke1c', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'frame', from: ['plastic', 'bike', 'frame'] },
  { role: 'topTube', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'bar', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'grip0', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'grip1', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'saddle', from: ['plastic', 'bike', 'saddle'] },
  { role: 'saddleStud', want: THREE_DEFAULT, why: 'demo 的 studInstances 開了兩個旗標,'
    + '但那是**座墊上的凸點**,demo 的單車段沒有走 studInstances 的路(它直接 new Mesh)' },
  { role: 'crankArm0', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'pedal0', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'crankArm1', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'pedal1', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
]);
expect('paper bike = demo 迴紋針單車', STYLES.paper.buildBikeOrnament().root, [
  { role: 'rim0', from: ['paper', 'bike', 'rim'] },
  { role: 'spoke0a', want: THREE_DEFAULT, why: 'demo: batchGroup 收的三根輻條,OR 之後仍是 --' },
  { role: 'spoke0b', want: THREE_DEFAULT, why: 'demo: 同上' },
  { role: 'spoke0c', want: THREE_DEFAULT, why: 'demo: 同上' },
  { role: 'hub0', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'rim1', from: ['paper', 'bike', 'rim'] },
  { role: 'spoke1a', want: THREE_DEFAULT, why: 'demo: 同上' },
  { role: 'spoke1b', want: THREE_DEFAULT, why: 'demo: 同上' },
  { role: 'spoke1c', want: THREE_DEFAULT, why: 'demo: 同上' },
  { role: 'hub1', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'frame', from: ['paper', 'bike', 'frame'] },
  { role: 'topTube', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'loop', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'bar', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'grip0', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'grip1', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'saddle', from: ['paper', 'bike', 'saddle'] },
  { role: 'crankArm0', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'pedal0', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'crankArm1', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
  { role: 'pedal1', want: THREE_DEFAULT, why: 'demo: 沒宣告' },
]);

// ── Signs ──────────────────────────────────────────────────────────────────

console.log('\n[shadow flags vs demo — 招牌]');

expect('plastic shop sign = demo emitSign / flushSigns',
  STYLES.plastic.buildSign?.('shop', 'DELI', 9, { zone: 'commercial', seed: 1 })?.group ?? null, [
    // demo `bin.board` — the mounting plate; `inst()` opens both. The port folds
    // the demo's separate white sticker sheet into this same backing plate.
    { role: 'backing', from: ['plastic', 'flushSigns', 'im'] },
    { role: 'field', from: ['plastic', 'flushSigns', 'im'] },
    // demo `bin.text` / `bin.white` — merged with `new THREE.Mesh(g, mat)` and
    // NO flags: 0.05–0.07 m films lying on a board that already casts.
    { role: 'ink', want: THREE_DEFAULT, why: 'demo bin.text: bakeParts → 裸 Mesh' },
    { role: 'bubble', want: THREE_DEFAULT, why: 'demo bin.white: bakeParts → 裸 Mesh' },
  ]);
expect('plastic hospital sign = demo emitSign (三角形走 bin.white)',
  STYLES.plastic.buildSign?.('shop', '', 9, { zone: 'hospital', symbol: 'triangle', seed: 1 })?.group ?? null, [
    { role: 'backing', from: ['plastic', 'flushSigns', 'im'] },
    { role: 'field', from: ['plastic', 'flushSigns', 'im'] },
    { role: 'triangle', want: THREE_DEFAULT, why: 'demo bin.white: bakeParts → 裸 Mesh' },
    { role: 'bubble', want: THREE_DEFAULT, why: 'demo bin.white' },
  ]);
expect('paper shop sign = demo labelSign',
  STYLES.paper.buildSign?.('shop', 'DELI', 9, { zone: 'commercial', seed: 1 })?.group ?? null, [
    { role: 'tape', from: ['paper', 'labelSign', 'tape'] },
    // demo: the glyph bars go through `box()`, which opens both.
    { role: 'ink', from: ['paper', 'eraserHouse', 'band'] },
  ]);
expect('paper hospital sign = demo labelSign (紅三角)',
  STYLES.paper.buildSign?.('shop', '', 9, { zone: 'hospital', symbol: 'triangle', seed: 1 })?.group ?? null, [
    { role: 'tape', from: ['paper', 'labelSign', 'tape'] },
    { role: 'triangle', from: ['paper', 'labelSign', 'tri'] },
  ]);
expect('circuit shop sign = demo epaperSign',
  STYLES.circuit.buildSign?.('shop', 'DELI', 9, { zone: 'commercial', seed: 1 })?.group ?? null, [
    { role: 'back', from: ['circuit', 'epaperSign', 'back'] },
    { role: 'bezel', from: ['circuit', 'epaperSign', 'bar'] },
    { role: 'panel', from: ['circuit', 'epaperSign', 'panel'] },
    { role: 'ink', from: ['circuit', 'glyphStrokes', 'b'] },
    { role: 'conn', from: ['circuit', 'epaperSign', 'conn'] },
    { role: 'ribbon', from: ['circuit', 'epaperSign', 'ribbon'] },
    { role: 'arm0', from: ['circuit', 'epaperSign', 'arm'] },
    { role: 'arm1', from: ['circuit', 'epaperSign', 'arm'] },
  ]);
expect('circuit hospital sign = demo epaperSign (紅三角走 epaperRedMat)',
  STYLES.circuit.buildSign?.('shop', '', 9, { zone: 'hospital', symbol: 'triangle', seed: 1 })?.group ?? null, [
    { role: 'back', from: ['circuit', 'epaperSign', 'back'] },
    { role: 'bezel', from: ['circuit', 'epaperSign', 'bar'] },
    { role: 'panel', from: ['circuit', 'epaperSign', 'panel'] },
    { role: 'triangle', from: ['circuit', 'epaperSign', 'bar'] },
    { role: 'conn', from: ['circuit', 'epaperSign', 'conn'] },
    { role: 'ribbon', from: ['circuit', 'epaperSign', 'ribbon'] },
    { role: 'arm0', from: ['circuit', 'epaperSign', 'arm'] },
    { role: 'arm1', from: ['circuit', 'epaperSign', 'arm'] },
  ]);

// ── Building decorations ───────────────────────────────────────────────────

console.log('\n[shadow flags vs demo — 建築 trim]');

const BOX = {
  cx: 0, cz: 0, width: 14, depth: 11, rotY: 0, height: 14, baseY: 0,
  skirt: 0.5, color: 0x999999,
};
type Zone = 'residential' | 'commercial' | 'industrial' | 'school' | 'hospital';
const deco = (w: World, zone: Zone, seed: number, height = 14): THREE.Object3D | null =>
  STYLES[w].buildBuildingDecoration({ ...BOX, height }, seed, zone);

{
  // One batch per storey COLOUR, so the count is data-driven (the demo's
  // `CANDY[(ci + L) % 6]` cycle, cut short by however many storeys fit). The
  // list is therefore generated — but a vacuous pass is guarded: a cup tower
  // with fewer than two wall batches is not a cup tower.
  const cup = deco('plastic', 'industrial', 1);
  const n = cup ? meshes(cup).length : 0;
  check('plastic 杯塔 trim: 每層一批,至少兩批', n >= 2, `${n} 批`);
  expect('plastic 杯塔 trim = demo cupTower', cup,
    [...Array(n).keys()].map((i) => ({
      role: `cupWall#${i}`, from: ['plastic', 'cupTower', 'im'] as [World, string, string],
    })));
}
expect('plastic 字母積木 trim = demo alphabetBlocks', deco('plastic', 'school', 1), [
  { role: 'letters:ink', from: ['plastic', 'alphabetBlocks', 'im'] },
  { role: 'letters:lite', from: ['plastic', 'alphabetBlocks', 'im'] },
  { role: 'rims', from: ['plastic', 'alphabetBlocks', 'rim'] },
]);
expect('plastic 骨牌牆 trim = demo dominoWall', deco('plastic', 'residential', 0), [
  { role: 'pips', from: ['plastic', 'dominoWall', 'im'] },
  { role: 'bars', from: ['plastic', 'dominoWall', 'im'] },
  { role: 'board', from: ['plastic', 'dominoWall', 'board'] },
  { role: 'marks', from: ['plastic', 'dominoWall', 'v'] },
]);

expect('paper 標籤片台 trim = demo flagDispenser', deco('paper', 'commercial', 0), [
  // demo: `win = box(cw * 0.72, h * 0.28, 0.34, shopGlassMat)` — 實心暗塊,不是玻璃片
  { role: 'glass', from: ['paper', 'eraserHouse', 'band'] },
]);
expect('paper 膠帶台 trim = demo tapeDispenser', deco('paper', 'industrial', 0), [
  { role: 'steel', from: ['paper', 'eraserHouse', 'band'] },   // bands + cutter bar = box()
  { role: 'teeth', from: ['paper', 'tapeDispenser', 't'] },
  { role: 'hubs', from: ['paper', 'tapeDispenser', 'hub'] },
]);
expect('paper 橡皮擦屋 trim = demo eraserHouse', deco('paper', 'residential', 0), [
  { role: 'sleeve', from: ['paper', 'eraserHouse', 'band'] },  // sleeve = box()
  { role: 'chevron', from: ['paper', 'eraserHouse', 'm'] },
  { role: 'rule', from: ['paper', 'eraserHouse', 'band'] },    // rule = box()
  { role: 'film', from: ['paper', 'eraserHouse', 'band'] },
  { role: 'printedFrames', want: THREE_DEFAULT, why: 'demo: `fr = new THREE.Mesh(unitPlane, crayonWinMat)` — 印上去的框,沒經過 box()' },
]);

expect('circuit 電解電容 trim = demo electrolyticCap', deco('circuit', 'residential', 0), [
  { role: 'capRing', from: ['circuit', 'electrolyticCap', 'ring'] },
]);
expect('circuit 輝光管 trim = demo nixieSign', deco('circuit', 'commercial', 0), [
  { role: 'lugs', from: ['circuit', 'nixieSign', 'lug'] },
  { role: 'glass', from: ['circuit', 'nixieSign', 'glass'] },
  { role: 'cap', from: ['circuit', 'nixieSign', 'cap'] },
  { role: 'litDigits', from: ['circuit', 'nixieDigit', 'b'] },
  { role: 'halo', from: ['circuit', 'nixieSign', 'halo'] },
  { role: 'darkDigits', from: ['circuit', 'nixieDigit', 'b'] },
]);
expect('circuit 變壓器 trim = demo transformer', deco('circuit', 'industrial', 0), [
  { role: 'terminals', from: ['circuit', 'transformer', 't'] },
  { role: 'copperTurns', from: ['circuit', 'transformer', 'ring'] },
  { role: 'lamination', from: ['circuit', 'addBuildingLights', 'b'] },
]);
expect('circuit DIP trim = demo dipIC / legRow', deco('circuit', 'school', 0), [
  { role: 'legs', from: ['circuit', 'legRow', 'knee'] },
  { role: 'pinWindows', from: ['circuit', 'dipIC', 'win'] },
  { role: 'solder', from: ['circuit', 'legRow', 'fillet'] },
]);
expect('circuit 真空管 trim = demo vacuumTube', deco('circuit', 'landmark' as Zone, 0, 40), [
  { role: 'lugs', from: ['circuit', 'vacuumTube', 'lug'] },
  { role: 'glass', from: ['circuit', 'vacuumTube', 'glass'] },
  { role: 'top', from: ['circuit', 'vacuumTube', 'top'] },
  { role: 'filament', from: ['circuit', 'vacuumTube', 'f'] },
  { role: 'filamentBase', from: ['circuit', 'vacuumTube', 'fb'] },
  { role: 'grid', from: ['circuit', 'vacuumTube', 'ring'] },
  { role: 'gridRods', from: ['circuit', 'vacuumTube', 'rod'] },
  { role: 'getterCap', from: ['circuit', 'vacuumTube', 'getter'] },
  { role: 'flashRing', from: ['circuit', 'vacuumTube', 'flashRing'] },
]);

// ═══════════════════════════════════════════════════════════════════════════
// The flags have to survive the MERGE
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything above reads the style file's output. The renderer does not draw
// that — it draws whatever `mergeBuildingDecorations` makes of it, and the whole
// reason the flags matter is that they are in that merge's batch key. So run the
// real thing (`buildBuildingMeshes`, the exported entry point) and read the
// batches it produced.

console.log('\n[shadow flags vs demo — 合併之後旗標還在]');

/** A square footprint `m` metres on a side, centred on the origin. */
function squareFootprint(metres: number, height: number, i: number): {
  coordinates: [number, number][]; height: number;
} {
  const d = metres / 111320;
  const cx = i * d * 3;
  return {
    coordinates: [
      [cx - d / 2, -d / 2], [cx + d / 2, -d / 2],
      [cx + d / 2, d / 2], [cx - d / 2, d / 2], [cx - d / 2, -d / 2],
    ],
    height,
  };
}
const flatSampler = {
  getElevationSync: () => 0,
  getElevation: async () => 0,
} as unknown as Parameters<typeof buildBuildingMeshes>[1];

for (const world of ['plastic', 'paper', 'circuit'] as const) {
  const style = STYLES[world];
  for (const zone of ['residential', 'commercial', 'industrial', 'school', 'hospital'] as const) {
    // Six footprints so the zone's 80/20 mix produces more than one body type,
    // which is what makes the merge do any bucketing at all.
    const N = 6;
    const fps = [...Array(N).keys()].map((i) => squareFootprint(14, 14, i));
    const built = await buildBuildingMeshes(
      fps, flatSampler, 0, 0, 0, style, () => 0, undefined, () => zone,
    );
    const merged = built.mesh.children as THREE.Mesh[];

    // What the STYLE declared, over exactly the two hooks `building-renderer`
    // feeds into `decorationGroups`: `buildBuildingDecoration` and (through
    // `mountShopSign`) `buildSign`. Both text and symbol signs, because the two
    // carry different materials.
    const declared = new Map<string, Set<string>>();
    const note = (m: THREE.Object3D | null | undefined): void => {
      if (!m) return;
      for (const mesh of meshes(m)) {
        const uuid = (mesh.material as THREE.Material).uuid;
        if (!declared.has(uuid)) declared.set(uuid, new Set());
        declared.get(uuid)!.add(fstr(flagsOf(mesh)));
      }
    };
    for (let i = 0; i < N; i++) {
      note(style.buildBuildingDecoration({ ...BOX, cx: i * 42, height: 14 }, i, zone));
      note(style.buildSign?.('shop', 'DELI', 9, { zone, seed: i })?.group);
      note(style.buildSign?.('shop', '', 9, { zone, symbol: 'triangle', seed: i })?.group);
    }

    // ── A. The merge invents nothing ──────────────────────────────────────
    // This is the survival test, and it is the strong direction. If the merge
    // stopped carrying the flags every batch would come out `--`; if it ORed
    // them (the paper demo's `batchGroup`, which building-renderer names as the
    // same bug with a fixed outcome) the two-answer materials would come out
    // `CR`. Neither pair was declared, so either one fails here.
    const invented = merged
      .map((m) => ({ uuid: (m.material as THREE.Material).uuid, f: fstr(flagsOf(m)) }))
      .filter((b) => declared.has(b.uuid) && !declared.get(b.uuid)!.has(b.f));
    const known = merged.filter((m) => declared.has((m.material as THREE.Material).uuid));
    check(`${world}/${zone}: 合併後每一批的旗標都是 style 宣告過的`,
      invented.length === 0 && known.length > 0,
      known.length === 0
        ? 'no merged batch used a material the style declared (nothing was tested)'
        : invented.length
          ? `${invented.length}/${known.length} 批被改寫: `
            + invented.map((b) => b.f).join(', ')
          : `${known.length} 批,${declared.size} 種材質`);

    // ── B. …and it splits a material that arrived with two answers ────────
    // The reason the flags are in the batch key at all. Only assertable where
    // such a material exists, so it reports when there is none.
    for (const [uuid, want] of declared) {
      if (want.size < 2) continue;
      const got = new Set(merged
        .filter((m) => (m.material as THREE.Material).uuid === uuid)
        .map((m) => fstr(flagsOf(m))));
      if (got.size === 0) continue;   // that body type did not occur in this run
      check(`${world}/${zone}: 同一份材質帶著兩種答案進來,合併之後還是兩批`,
        got.size >= 2 && [...got].every((g) => want.has(g)),
        `宣告 ${[...want].join('/')} → 合併後 ${[...got].join('/')}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 剪紙樹的兩個剪法 —— 同一棵樹,跟著陰影這一輪一起補的
// ═══════════════════════════════════════════════════════════════════════════
//
// demo 的規則與它自己寫的理由:
//
// > 兩張卡片插成十字 —— 模型樹就是這樣做的。兩張用**不同**的剪法(不同 seed 的
// > 貼圖),不然轉到 45° 會看出是同一張鏡射過去的。
//
// 移植原本兩張卡吃同一張貼圖、同一組 uv —— 也就是同一張剪紙轉 90°,正好是那句
// 話要避免的東西。demo 用**兩份材質**買到差異;這個 renderer 一個 chunk 一個
// InstancedMesh,買不起第二份,所以差異搬到 uv 上:一張圖集、兩格、兩個 seed。
//
// 這裡驗兩件事,而且都不是拿抄過來的常數比:
//  1. 每一格的**筆觸流**,跟 demo 的 `treeCutoutTexture('round', false, sd)`
//     執行出來的逐筆比對;
//  2. 兩張卡真的落在不同的格子上。

// ⚠ 這一段必須跑在下面「樹」那一段**之前**:`treePaper()` 的快取是模組層的
// (demo 的 `treePaperCache` 也是),先讓 tree-renderer 建過一次材質的話,底紙
// 就不會再畫,那條逐筆比對會拿不到畫布。
console.log('\n[shadow flags vs demo — 剪紙樹的兩個剪法]');

{
  const { canvases } = await import('./recording-canvas.ts');
  const TILE = 256;
  /** 一次建構期間新生的 256×256 畫布,依建立順序。 */
  const tilesSince = (from: number): string[][] => canvases
    .slice(from)
    .filter((c) => c.width === TILE && c.height === TILE)
    .map((c) => c.trace);
  /** demo 的 `treePaper()` 那張 128 底紙 —— 它畫在自己的畫布上,所以不在
   *  上面的筆觸流裡。不比它的話,底紙整個換掉都不會有人發現。 */
  const paperSince = (from: number): string[] | null => canvases
    .slice(from)
    .filter((c) => c.width === 128 && c.height === 128)
    .map((c) => c.trace)[0] ?? null;

  // ── the port ──
  // 這一段比的是 demo 的 `treeCutoutTexture('round', false, …)`,也就是**素紙板**
  // 那一張。2026-07-28 之前移植只有這一張,所以不必說;現在兩態都在,而策略的預
  // 設是「上色」(demo 的 `paintOn = true`),所以要拿到同一張就得明講。
  // 上色那一張由 `paper-props-vs-demo.ts` 的 `[上色 ↔ 素紙板 vs demo]` 逐筆比。
  const portFrom = canvases.length;
  const fresh = await createTerrainStyleStrategy('paper');
  (fresh.params as unknown as Record<string, unknown>).paintEnabled = false;
  const portMat = fresh.createTreeMaterial() as THREE.MeshToonMaterial;
  const portTiles = tilesSince(portFrom);
  const portPaper = paperSince(portFrom);
  const atlas = portMat.map?.image as { width: number; height: number } | undefined;

  // ── the demo's own `treeCutoutTexture`, executed ──
  const src = SRC.paper;
  const demoFrom = canvases.length;
  runDemo([
    'const shared = (_k, f) => f();',
    'const PAINT = new Proxy({}, { get: () => "#000000" });',
    // 素紙板模式用不到 gouache,但 treePaper 的簽名裡有它 —— 給一個會 throw 的
    // 替身,`painted = false` 這條路一旦誤走進去會立刻現形,而不是靜靜地過。
    'const gouacheCanvas = () => { throw new Error("painted path taken"); };',
    sliceStmt(src, '  const treePaperCache = new Map();'),
    sliceFn(src, 'treePaper'),
    sliceFn(src, 'mulberry32'),
    sliceFn(src, 'treeCutoutTexture'),
  ], `
    return [treeCutoutTexture('round', false, 0x3a01),
            treeCutoutTexture('round', false, 0x3a01 + 977)];
  `);
  const demoTiles = tilesSince(demoFrom);
  const demoPaper = paperSince(demoFrom);

  check('剪紙樹:移植畫了兩格,demo 也是兩張',
    portTiles.length === 2 && demoTiles.length === 2,
    `ours ${portTiles.length} vs demo ${demoTiles.length}`);
  check('剪紙樹:圖集是兩格並排(512×256)',
    !!atlas && atlas.width === TILE * 2 && atlas.height === TILE,
    atlas ? `${atlas.width}×${atlas.height}` : 'no map');

  for (let v = 0; v < Math.min(portTiles.length, demoTiles.length); v++) {
    const a = demoTiles[v], b = portTiles[v];
    let at = -1;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) { at = i; break; }
    }
    check(`剪紙樹 seed #${v}:每一筆都跟 demo 的 treeCutoutTexture 相同`,
      at < 0 && a.length === b.length,
      at < 0 ? `${a.length} 筆` : `第 ${at} 筆: demo [${a[at] ?? '—'}] vs ours [${b[at] ?? '—'}] (${a.length} vs ${b.length})`);
  }
  // …and the two tiles must actually DIFFER, which is the whole point. Without
  // this the check above would pass just as happily on two copies of one cut.
  check('剪紙樹:兩格的筆觸不一樣(不是同一張剪兩次)',
    demoTiles.length === 2 && demoTiles[0].join('|') !== demoTiles[1].join('|')
    && portTiles.length === 2 && portTiles[0].join('|') !== portTiles[1].join('|'),
    'demo 的兩個 seed 本來就該剪出兩個輪廓');

  check('剪紙樹:底紙(treePaper)也是 demo 那 230 筆纖維,逐筆相同',
    !!portPaper && !!demoPaper
    && portPaper.length === demoPaper.length
    && portPaper.every((v, i) => v === demoPaper[i]),
    portPaper && demoPaper
      ? `${demoPaper.length} vs ${portPaper.length} 筆`
      : `demo=${demoPaper ? 'yes' : 'no'} ours=${portPaper ? 'yes' : 'no'}`);

  // ── 兩張卡落在不同的格子上 ──
  const geo = fresh.buildTreeGeometry!();
  const uv = geo.getAttribute('uv');
  const half = [new Set<number>(), new Set<number>()];
  // Two cards, `toNonIndexed` → 6 vertices each, in build order.
  for (let i = 0; i < uv.count; i++) half[i < uv.count / 2 ? 0 : 1].add(uv.getX(i));
  const inFirst = [...half[0]].every((u) => u >= 0 && u <= 0.5);
  const inSecond = [...half[1]].every((u) => u >= 0.5 && u <= 1);
  const disjoint = [...half[0]].every((u) => !half[1].has(u) || u === 0.5);
  check('剪紙樹:兩張卡吃圖集的不同半邊',
    inFirst && inSecond && disjoint && half[0].size > 1 && half[1].size > 1,
    `card0 u∈{${[...half[0]].join(',')}} card1 u∈{${[...half[1]].join(',')}}`);
  geo.dispose();
  fresh.dispose();
}

// ═══════════════════════════════════════════════════════════════════════════
// 樹
// ═══════════════════════════════════════════════════════════════════════════
//
// `tree-renderer` has ONE InstancedMesh per chunk and the flags are per-DRAW, so
// a world whose demo gives its tree parts two different answers cannot have both
// — there is no per-world channel on the tree hooks (`buildTreeGeometry` returns
// one geometry, `createTreeMaterial` one material). What it can be held to is
// that the one pair it ships is the OR of the demo's, which is what a single
// batch of those parts would have to be.

console.log('\n[shadow flags vs demo — 樹]');

const or = (...fs: Flags[]): Flags => ({
  cast: fs.some((f) => f.cast), recv: fs.some((f) => f.recv),
});

async function treeFlags(world: World): Promise<Flags> {
  // One forest polygon, ~400 m square at the origin. `buildTreeMeshes` reads it
  // through `extractPolygonCoords`, which wants GeoJSON — the same shape the MVT
  // fetcher hands it.
  const d = 400 / 111320;
  const feature = {
    layer: 'landuse',
    properties: { class: 'wood' },
    geometry: {
      type: 'Polygon',
      coordinates: [[[-d, -d], [d, -d], [d, d], [-d, d], [-d, -d]]],
    },
  };
  const res = await buildTreeMeshes(
    [feature as unknown as Parameters<typeof buildTreeMeshes>[0][number]],
    flatSampler as unknown as Parameters<typeof buildTreeMeshes>[1],
    0, 0, 0, STYLES[world],
  );
  // A run that placed no trees returns the empty fallback mesh, whose flags are
  // three's defaults — which would make every expectation below pass for the
  // wrong reason. Two of the three worlds want exactly those defaults NOT to be
  // the answer, so the count is asserted first.
  check(`${world}: 樹的檢查真的種到樹了`, res.treeCount > 0, `${res.treeCount} 棵`);
  return flagsOf(res.mesh);
}

{
  // plastic: trunk AND coil both leave through `boxBatcher`, which opens both.
  const want = PRIMITIVES.plastic.boxBatcher;
  const ours = await treeFlags('plastic');
  check('plastic tree = demo emitTree (幹與螺旋都走 boxBatcher)',
    fstr(ours) === fstr(want), `demo ${fstr(want)} vs ours ${fstr(ours)}`);
}
{
  // circuit: the disc is a bare Mesh with `castShadow = true`; the two legs are
  // `box()`. One batch → the OR.
  const want = or(
    demoFlags('circuit', 'discCapTree', 'disc'),
    demoFlags('circuit', 'discCapTree', 'leg'));
  const ours = await treeFlags('circuit');
  check('circuit tree = demo discCapTree 的 disc ∨ leg',
    fstr(ours) === fstr(want),
    `demo disc=${fstr(demoFlags('circuit', 'discCapTree', 'disc'))} `
    + `leg=${fstr(demoFlags('circuit', 'discCapTree', 'leg'))} → ${fstr(want)} `
    + `vs ours ${fstr(ours)}`);
}
{
  // paper: `treeBucket.flush` opens castShadow ONLY, and only on the card
  // batches (`if (depthMat)`); the glue disc gets neither. Parsed here rather
  // than asserted from memory, because the conditional is what makes the two
  // batches differ.
  const t = SITES.get('paper:treeBucket')!.src;
  const cardsCast = /if \(depthMat\) \{ im\.castShadow = true;/.test(t);
  const glueUnflagged = /put\(unitDisc, glueMat, glue\);/.test(t);
  const recvAnywhere = /receiveShadow/.test(t);
  check('paper: demo treeBucket 給卡片 castShadow、給白膠痕什麼都不給,receive 一件都沒有',
    cardsCast && glueUnflagged && !recvAnywhere,
    `cards cast=${cardsCast} glue unflagged=${glueUnflagged} receive mentioned=${recvAnywhere}`);
  const ours = await treeFlags('paper');
  // 這裡曾經是一條**記錄在案的偏離**:移植的樹多開了 receiveShadow,理由是
  // `tree-renderer.ts` 三個世界共用一個 InstancedMesh 而旗標是逐 draw 的,
  // 而 `TerrainStyleStrategy` **沒有逐世界的通道**。
  //
  // 那個理由現在不成立了 —— `treeShadow?: { cast, receive }` 就是那個通道
  // (白膠痕那次順手加的)。所以這條從「偏離」改成**正面陳述**:移植拿到的
  // 就是 demo 自己的那一對,而且是從 demo **執行出來的**旗標推出來的,不是
  // 抄一個 `C-` 進來。
  //
  // ⚠ 這是「記錄了 ≠ 送得到」那一課的另一面:當初斷言了一個事實(移植跟 demo
  // 不一樣),而那個事實本身是缺陷。**斷言一個偏離,不代表那個偏離該永遠存在**
  // —— 它只保證改變不會靜悄悄地發生,而這次改變被抓到了,正是它該有的作用。
  check('paper tree: 拿到的就是 demo 卡片自己的那一對(C-)',
    ours.cast && !ours.recv,
    `demo 卡片 ${fstr({ cast: cardsCast, recv: recvAnywhere })} vs ours ${fstr(ours)}`);
  // 而通道存在不等於另外兩個世界被波及:省略 `treeShadow` 必須維持 (T, T)。
  const plasticTree = await treeFlags('plastic');
  const circuitTree = await treeFlags('circuit');
  check('…而沒有宣告 treeShadow 的世界一格沒動(optional 不外洩)',
    plasticTree.cast && plasticTree.recv && circuitTree.cast && circuitTree.recv,
    `plastic ${fstr(plasticTree)} / circuit ${fstr(circuitTree)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 雲 —— 三個 demo 不一致,而移植選了其中一邊
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n[shadow flags vs demo — 雲]');

{
  // Read the three demos' cloud blocks and classify them BY WHAT THEY CALL,
  // rather than trusting a memory of which world does what.
  const plasticCloud = SITES.get('plastic:clouds')!.src;
  const paperCloud = SITES.get('paper:clouds')!.src;
  const circuitCloud = SITES.get('circuit:clouds')!.src;
  // 「積木的雲會投影」不是靠一個 plasticBox( 出現過就算 —— 那個 regex 在
  // 「五塊裡有一塊改成裸 Mesh」的時候還是 true。條件是**整塊裡一個裸 Mesh 都
  // 沒有**:每一件都經過會開旗標的 primitive。另外兩個世界則是反過來,一次
  // primitive 都不能出現,而且不能有任何 castShadow。
  const plasticCasts = /plasticBox\(/.test(plasticCloud)
    && !/new THREE\.Mesh\(/.test(plasticCloud)
    && PRIMITIVES.plastic.plasticBox.cast;
  const paperBare = /new THREE\.Mesh\(unitSphere\(/.test(paperCloud)
    && !/\b(box|plasticBox|scaledBox|plasticSlab|studInstances)\(/.test(paperCloud)
    && !/castShadow/.test(paperCloud);
  const circuitBare = /new THREE\.Mesh\(unitBox, mat\)/.test(circuitCloud)
    && !/\b(box|cyl|dome)\(/.test(circuitCloud)
    && !/castShadow/.test(circuitCloud);
  check('demo 的雲三個世界不一致:積木的每一件都走 plasticBox(會投影),另外兩個整塊都是裸 Mesh',
    plasticCasts && paperBare && circuitBare,
    `plastic casts=${plasticCasts} paper bare=${paperBare} circuit bare=${circuitBare}`);

  for (const world of ['plastic', 'paper', 'circuit'] as const) {
    const cloud = STYLES[world].buildCloud?.(0, () => 0.5) ?? null;
    const on = cloud ? meshes(cloud).filter((m) => m.castShadow || m.receiveShadow) : [];
    // For paper and circuit this is the demo, verbatim. For PLASTIC it is a
    // divergence, and the reason is that gameview's cloud layer is not the
    // demo's five props: it is a DECK pinned to the weather's condensation
    // altitude that the rider can ride into, and the ground already gets its
    // cloud darkening from `cloud-shadow.ts` — a world-XZ noise multiply into
    // the terrain albedo, with its own written rationale. A cloud deck at
    // condensation altitude is also outside the ±180 m shadow camera, so the
    // flag would buy nothing but a bigger shadow pass.
    check(`${world} cloud: 移植不投影`,
      on.length === 0,
      world === 'plastic'
        ? 'demo 的 plasticBox 開了兩個 —— 這裡是刻意的偏離(雲層是天氣高度的甲板,'
          + '地面的雲影走 cloud-shadow.ts)'
        : 'demo 也是裸 Mesh,一格沒動');
  }
}

console.log(failures === 0
  ? '\n[shadow flags vs demo] all passed.'
  : `\n[shadow flags vs demo] ${failures} FAILED.`);

export function failureCount(): number { return failures; }
