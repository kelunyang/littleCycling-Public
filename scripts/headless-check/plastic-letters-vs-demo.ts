/**
 * `[plastic-letters vs demo]` —— 字母積木的 **3D 字形幾何**。
 *
 * `plan/plastic-town-demo.html` 的 `letterGeo` / `ltrBar` / `ltrArc` / `LETTERS`
 * 是一整套手畫的幾何字型:直棒 + 由短棒排成的圓弧,單位字框 1×1,沿 +z 擠出到
 * `LTR_E`。移植原本沒接上這套 —— 它去借了 `sign-spec.ts` 的 `SIGN_GLYPHS`
 * (`signStrokes(1, 1, ch)`),那是**跨三個世界共用的招牌字型**,形狀、字高
 * (0.62 對 0.92)、字重(0.105 對 `LTR_T` = 0.15)、字表(15 個直線字對 26 個
 * 字母)四樣全部不同。2D 那邊踩過同一個坑而且已經退回去了
 * (`plastic-style.ts` 的 `LETTER_STROKES` docstring 寫著這件事),3D 沒有。
 *
 * ⚠ 2D 與 3D 是**兩張字表**,而且兩支 demo 自己就是這樣寫的:2D 的
 * `LETTER_STROKES` 只收 15 個直線畫得出來的字(平塗側視,曲線在那個尺寸下糊
 * 掉),3D 的 `LETTERS` 把弧拆成短棒所以收滿 A–Z。這支不比 2D —— 它比的是
 * 「3D 有沒有接上 3D demo 那一張」。
 *
 * ## 這支怎麼驗
 *
 * 全部都是**把 demo 的原始碼從 HTML 切出來執行**,不比對抄進來的常數 ——
 * 抄過來的常數只會把當初打錯的東西再確認一遍(`CUSTOM_WORLD_INSTRUCTIONS`
 * §0.0 第 5 點)。切出來的有 `mergeGeos` / `LTR_T` / `LTR_E` / `ltrBar` /
 * `ltrArc` / `LETTERS` / `LETTER_KEYS` / `LETTER_MISSING` / `letterGeo`,以及
 * `alphabetBlocks` 裡那張 `faces` 表與 `ls` / `rs` 兩個縮放。
 *
 * 比對的是**有順序的世界座標三角形串流**,同時帶兩種法線:
 *  - **幾何法線**(三個角算出來的)—— 把繞序反轉,三個角還在同樣三個點上,
 *    包圍盒與三角形數**完全不變**,只有這個會翻號。
 *  - **著色法線**(`normal` 屬性過 normal matrix)—— 抓「頂點沒動但法線變了」。
 * 兩種都有反向對照(§0),不然這支就是一個永遠回報 clean 的檢查。
 *
 * 字形這個世界是**幾何不是貼圖**(demo 的 `letterGeo` 回傳 `BufferGeometry`,
 * 一筆 canvas 都沒碰),所以這裡不看 `recording-canvas` 的 `trace` / `rects`
 * 視角 —— 但 canvas stub 還是要裝共用那一份,因為 strategy 一建起來就會畫它
 * 自己的貼圖,而貼圖快取是模組層的。
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/plastic-letters-vs-demo.ts
 */
import { readFileSync } from 'node:fs';

// canvas stub 走 harness 共用的那一份。冪等由 installRecordingCanvas 自己保證。
const { installRecordingCanvas } = await import('./recording-canvas.ts');
installRecordingCanvas();

const THREE = await import('three');
const { createPlasticTerrainStyle, letterGeo, LETTER_KEYS } =
  await import('@/game/terrain/plastic-terrain-style');
type BuildingBox = import('@/game/terrain/terrain-style-strategy').BuildingBox;
type BoxPart = import('@/game/terrain/terrain-style-strategy').BoxPart;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ── 切 demo ─────────────────────────────────────────────────────────────────

const SRC = readFileSync('plan/plastic-town-demo.html', 'utf8');

/** 一整個 `function name(...) { … }`,大括號配平。 */
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
/** 以 `head` 開頭的一整行(含行尾註解)。 */
function sliceLine(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`cannot slice line ${head}`);
  return src.slice(at, src.indexOf('\n', at));
}
/** 從 `head` 開始、括號配平的一句敘述。 */
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

/**
 * demo 的字型 + 字母積木擺放,執行在**真的** three 上。
 *
 * `LETTER_KEYS` 那一行的位置是有意義的:demo 把它放在補完 A–Z 之後、補數字
 * 之前,所以字母積木抽不到數字。切片保留那個順序,順序本身也是被斷言的東西。
 */
interface DemoLetters {
  letterGeo(ch: string): THREE.BufferGeometry;
  LETTER_KEYS: string[];
  LTR_T: number;
  LTR_E: number;
  ABC_S: number;
  ABC_PLINTH: number;
  /** demo `alphabetBlocks` 的 `faces` 表,cube 座標。 */
  faces: number[][];
  /** demo `alphabetBlocks` 的浮凸字與外框縮放,在 S = ABC_S 下。 */
  ls: THREE.Vector3;
  rs: THREE.Vector3;
}
const demo = ((): DemoLetters => {
  const prelude = [
    sliceFn(SRC, 'mergeGeos'),
    sliceLine(SRC, '  const LTR_T = '),
    sliceLine(SRC, '  const LTR_E = '),
    sliceFn(SRC, 'ltrBar'),
    sliceFn(SRC, 'ltrArc'),
    sliceLine(SRC, '  const _PI = '),
    sliceStmt(SRC, '  const LETTERS = {'),
    sliceStmt(SRC, '  Object.assign(LETTERS, {\n    F:'),
    sliceLine(SRC, '  const LETTER_KEYS = '),
    sliceStmt(SRC, "  Object.assign(LETTERS, {\n    '0':"),
    sliceStmt(SRC, '  const LETTER_MISSING = '),
    sliceLine(SRC, '  const letterWarned = '),
    sliceLine(SRC, '  const letterGeos = '),
    sliceFn(SRC, 'letterGeo'),
    // 積木本體的兩個常數,以及 alphabetBlocks 裡的 k / faces / ls / rs。
    sliceLine(SRC, '  const ABC_S = '),
    sliceLine(SRC, '  const ABC_PLINTH = '),
    'const S = ABC_S;',
    sliceLine(SRC, '      const k = S * 0.66;'),
    sliceStmt(SRC, '      const faces = ['),
    sliceLine(SRC, '      const ls = '),
    sliceLine(SRC, '      const rs = '),
  ];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('THREE', 'console', [...prelude, `
    return { letterGeo, LETTER_KEYS, LTR_T, LTR_E, ABC_S, ABC_PLINTH, faces, ls, rs };
  `].join('\n'))(THREE, { warn: () => {} }) as DemoLetters;
})();

// ── 三角形串流 ──────────────────────────────────────────────────────────────

/**
 * 一份幾何在世界座標下的每一個三角形,**依 index 順序**,帶兩種法線。
 * 見檔頭:包圍盒與三角形數對繞序反轉是瞎的,這個不是。
 */
function worldTris(geo: THREE.BufferGeometry, m: THREE.Matrix4): string[] {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const idx = geo.index;
  const n = idx ? idx.count : pos.count;
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const fn = new THREE.Vector3(), sn = new THREE.Vector3(), tmp = new THREE.Vector3();
  const out: string[] = [];
  const f = (x: number): string => (Math.abs(x) < 5e-4 ? '0' : x.toFixed(3));
  for (let i = 0; i < n; i += 3) {
    sn.set(0, 0, 0);
    for (let k = 0; k < 3; k++) {
      const j = idx ? idx.getX(i + k) : i + k;
      v[k].set(pos.getX(j), pos.getY(j), pos.getZ(j)).applyMatrix4(m);
      if (nrm) sn.add(tmp.set(nrm.getX(j), nrm.getY(j), nrm.getZ(j)).applyMatrix3(nm).normalize());
    }
    e1.subVectors(v[1], v[0]);
    e2.subVectors(v[2], v[0]);
    fn.crossVectors(e1, e2);
    if (fn.lengthSq() > 1e-18) fn.normalize();
    if (sn.lengthSq() > 1e-18) sn.normalize();
    out.push(`${v.map((q) => `${f(q.x)},${f(q.y)},${f(q.z)}`).join(' ')} `
      + `g${f(fn.x)},${f(fn.y)},${f(fn.z)} s${f(sn.x)},${f(sn.y)},${f(sn.z)}`);
  }
  return out;
}
const IDENTITY = new THREE.Matrix4();
function firstDiff(a: string[], b: string[]): string {
  if (a.length !== b.length) return `三角形數 demo ${a.length} vs ours ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return `tri ${i}: demo [${a[i]}] vs ours [${b[i]}]`;
  }
  return 'identical';
}
const triCount = (g: THREE.BufferGeometry): number =>
  (g.index ? g.index.count : g.attributes.position.count) / 3;

/** 深度優先、依子節點順序。 */
interface Part { geo: THREE.BufferGeometry; m: THREE.Matrix4 }
function partsOf(root: THREE.Object3D): Part[] {
  const out: Part[] = [];
  root.updateMatrixWorld(true);
  const walk = (o: THREE.Object3D): void => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) out.push({ geo: mesh.geometry, m: o.matrixWorld.clone() });
    for (const c of o.children) walk(c);
  };
  walk(root);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 0. 先證明這支的比對器抓得到東西
// ═══════════════════════════════════════════════════════════════════════════
//
// §10.5:「加任何稽核都要做反向對照 —— 拿一份正確的幾何故意把索引反轉,確認它
// 真的抓得到。永遠回報 clean 的檢查等於沒有檢查。」下面每一條斷言都靠
// `worldTris`,所以 `worldTris` 自己得先被看著抓到東西。
console.log('\n[plastic letters vs demo — 反向對照]');
{
  const good = demo.letterGeo('A');
  const base = worldTris(good, IDENTITY);

  // (a) 繞序反轉。三個角還在同樣三個點上 —— 包圍盒、三角形數、頂點集合全不變。
  const flipped = good.index ? good.clone().toNonIndexed() : good.clone();
  {
    const p = flipped.getAttribute('position').array as Float32Array;
    const q = flipped.getAttribute('normal').array as Float32Array;
    for (let i = 0; i < p.length; i += 9) {
      for (let c = 0; c < 3; c++) {
        [p[i + c], p[i + 6 + c]] = [p[i + 6 + c], p[i + c]];
        [q[i + c], q[i + 6 + c]] = [q[i + 6 + c], q[i + c]];
      }
    }
  }
  const flippedTris = worldTris(flipped, IDENTITY);
  good.computeBoundingBox();
  flipped.computeBoundingBox();
  check('反向對照:繞序反轉之後包圍盒與三角形數一模一樣(所以它們抓不到)',
    triCount(good) === triCount(flipped)
      && good.boundingBox!.min.distanceTo(flipped.boundingBox!.min) < 1e-9
      && good.boundingBox!.max.distanceTo(flipped.boundingBox!.max) < 1e-9,
    `${triCount(good)} 個三角形,bbox 相同`);
  check('反向對照:三角形串流抓得到繞序反轉',
    flippedTris.length === base.length
      && base.every((t, i) => t !== flippedTris[i]),
    `${base.filter((t, i) => t !== flippedTris[i]).length}/${base.length} 條不同`);

  // (b) 只動 normal 屬性、頂點一格不動 —— 幾何法線看不出來,著色法線看得出來。
  const nOnly = good.clone();
  {
    const q = nOnly.getAttribute('normal').array as Float32Array;
    for (let i = 0; i < q.length; i++) q[i] = -q[i];
  }
  const nTris = worldTris(nOnly, IDENTITY);
  check('反向對照:三角形串流抓得到「頂點沒動、只有法線翻面」',
    nTris.length === base.length && nTris.some((t, i) => t !== base[i]),
    `${base.filter((t, i) => t !== nTris[i]).length}/${base.length} 條不同`);
  flipped.dispose();
  nOnly.dispose();
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 字表:哪些字、什麼順序
// ═══════════════════════════════════════════════════════════════════════════
//
// 順序是有作用的:`LETTER_KEYS[floor(rng() * n) % n]` 是一個 index,重排 key
// 等於把整條路線上每一所學校重新印一次字。而且 demo 刻意在**補數字之前**取這
// 張表 —— 字母積木上出現數字就變成另一種玩具了。
console.log('\n[plastic letters vs demo — 字表]');
check('字表就是 demo 的 LETTER_KEYS(內容與順序)',
  LETTER_KEYS.join('') === demo.LETTER_KEYS.join(''),
  `demo ${demo.LETTER_KEYS.join('')} (${demo.LETTER_KEYS.length}) / `
  + `ours ${LETTER_KEYS.join('')} (${LETTER_KEYS.length})`);
check('字表是 A–Z 全部 26 個,不是只收直線字的那一份',
  [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].every((c) => LETTER_KEYS.includes(c)),
  `缺 ${[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter((c) => !LETTER_KEYS.includes(c)).join('') || '(無)'}`);
check('字表裡沒有數字(demo 在補 0–9 之前就把 keys 取走了)',
  LETTER_KEYS.length > 0 && LETTER_KEYS.every((c) => !/[0-9]/.test(c)),
  LETTER_KEYS.filter((c) => /[0-9]/.test(c)).join('') || '(無)');

// ═══════════════════════════════════════════════════════════════════════════
// 2. 逐字比對三角形串流
// ═══════════════════════════════════════════════════════════════════════════
//
// A–Z、0–9,加上兩個查不到的字元(那條走 `LETTER_MISSING` 的打叉方框)。demo
// 側是執行出來的,不是抄的。
console.log('\n[plastic letters vs demo — 每一個字形]');
const ALL_CHARS = [...demo.LETTER_KEYS, ...'0123456789', '?', '@'];
{
  let worst = '';
  let bad = 0;
  for (const ch of ALL_CHARS) {
    const d = worldTris(demo.letterGeo(ch), IDENTITY);
    const o = worldTris(letterGeo(ch), IDENTITY);
    if (d.join('|') !== o.join('|')) {
      bad++;
      if (!worst) worst = `'${ch}' ${firstDiff(d, o)}`;
    }
  }
  check(`每一個字形的三角形串流都是 demo 的(${ALL_CHARS.length} 個字元)`,
    bad === 0, bad === 0 ? 'A–Z + 0–9 + 缺字記號,逐三角形相同' : `${bad} 個不同;第一個 ${worst}`);
}
// 「兩邊都回傳空幾何」也能讓上面那條過。
check('而且每一個字形都真的有三角形(不是兩邊一起空)',
  ALL_CHARS.every((ch) => triCount(letterGeo(ch)) > 0),
  `最少 ${Math.min(...ALL_CHARS.map((ch) => triCount(letterGeo(ch))))} 個三角形/字`);
// 缺字記號:不可以退回系統字型(法則 3.7),也不可以無聲略過 —— 移植原本正是
// 後者(`signStrokes` 查不到就回空陣列,`buildLetterRelief` 直接 continue)。
{
  const missing = triCount(letterGeo('@'));
  check('查不到的字元畫成 demo 的打叉方框,而不是消失',
    missing === triCount(demo.letterGeo('@')) && missing > 0,
    `${missing} 個三角形 = ${missing / 12} 根棒`);
  const mark = worldTris(letterGeo('@'), IDENTITY).join('|');
  check('…而且那個記號跟任何一個真的字母都不一樣',
    demo.LETTER_KEYS.every((c) => worldTris(letterGeo(c), IDENTITY).join('|') !== mark));
}
// 單位字框:字高、筆畫寬、擠出深度。這三個是移植原本最大的偏離(招牌字型的
// cap 0.62 / 筆畫 0.105 / 深度正規化到 1),值一律從執行 demo 拿。
{
  const g = letterGeo('I');    // 直桿 + 上下橫槓:高度就是字高,橫槓厚度就是字重
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const dg = demo.letterGeo('I');
  dg.computeBoundingBox();
  const dbb = dg.boundingBox!;
  check('單位字框:字高是 demo 的(不是招牌字型的 cap height)',
    Math.abs((bb.max.y - bb.min.y) - (dbb.max.y - dbb.min.y)) < 1e-6,
    `${(bb.max.y - bb.min.y).toFixed(4)} / demo ${(dbb.max.y - dbb.min.y).toFixed(4)}`);
  check('單位字框:字寬(橫槓)也是 demo 的',
    Math.abs((bb.max.x - bb.min.x) - (dbb.max.x - dbb.min.x)) < 1e-6,
    `${(bb.max.x - bb.min.x).toFixed(4)} / demo ${(dbb.max.x - dbb.min.x).toFixed(4)}`);
  check('單位字框:擠出從 0 長到 demo 的 LTR_E(擺上去就是浮凸)',
    Math.abs(bb.min.z) < 1e-6 && Math.abs(bb.max.z - demo.LTR_E) < 1e-6,
    `z ∈ [${bb.min.z.toFixed(4)}, ${bb.max.z.toFixed(4)}] / LTR_E = ${demo.LTR_E}`);
  // 筆畫寬:量 H 的橫槓厚度。H 只有三根軸對齊的棒(兩根直的在 y = ±0.46,一根
  // 橫的在 y = ±LTR_T/2),所以相異 y 由小到大是 [-0.46, -T/2, +T/2, +0.46],
  // 中間兩個的差就是筆畫寬。兩邊用同一把尺量。
  const strokeOf = (geo: THREE.BufferGeometry): number => {
    const ys = new Set<number>();
    const p = geo.getAttribute('position');
    for (let i = 0; i < p.count; i++) ys.add(Number(p.getY(i).toFixed(5)));
    const s = [...ys].sort((a, b) => a - b);
    return s[2] - s[1];
  };
  const stroke = strokeOf(letterGeo('H'));
  check('單位字框:筆畫寬是 demo 的 LTR_T(招牌字型是 0.17 × cap = 0.105)',
    Math.abs(stroke - strokeOf(demo.letterGeo('H'))) < 1e-6
      && Math.abs(stroke - demo.LTR_T) < 1e-4,
    `${stroke.toFixed(4)} / LTR_T = ${demo.LTR_T}`);
}
// 圓弧:demo 特地不用 TorusGeometry,而是把弧拆成一串短棒(torus 的截面是圓
// 的,浮凸厚度會被綁死成筆畫寬,而且跟直筆畫接不平)。這一條把段數釘下來 ——
// 招牌字型的 O 是 8 段折線多邊形,差得很遠。
{
  const bars = triCount(letterGeo('O')) / 12;
  check('圓弧字是短棒排出來的,段數 = demo 的 max(3, round(|sweep| / 0.42))',
    triCount(letterGeo('O')) === triCount(demo.letterGeo('O'))
      && bars === Math.max(3, Math.round((2 * Math.PI) / 0.42)),
    `O = ${bars} 根棒 / T = ${triCount(letterGeo('T')) / 12} 根`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. 快取:借出去的是 clone,不是快取本身
// ═══════════════════════════════════════════════════════════════════════════
//
// `mergeBuildingDecorations` 會 dispose 每一份交給它的幾何。demo 的 `letterGeos`
// 是**永久**快取、chunk 之間共用,所以移植這邊只能借 clone —— 借快取本身的話
// 一個 chunk 之後整張表就空了,而症狀會出現在很遠的地方(下一個 chunk 的學校
// 沒有字)。
console.log('\n[plastic letters vs demo — 快取]');
check('同一個字元永遠回同一份幾何(永久快取,跟 demo 的 letterGeos 同壽命)',
  letterGeo('A') === letterGeo('A') && letterGeo('A') !== letterGeo('B'));

// ═══════════════════════════════════════════════════════════════════════════
// 4. 出貨路徑:學校身上的字,真的是這些字形
// ═══════════════════════════════════════════════════════════════════════════
//
// 上面全部走 `letterGeo` 這個匯出。這一節只走 `TerrainStyleStrategy` 的公開
// hook,證明「出貨的那條路徑用的是它」—— 不然 `letterGeo` 大可以是一份沒人呼叫
// 的死程式碼,而斷言照樣全綠。
//
// demo 側的參考是**整份組出來的**:demo 自己的 `faces` 表(cube 座標)、自己的
// `ls` / `rs` 縮放、自己的 `letterGeo(ch)`,乘上移植從 `buildBuildingBoxes`
// 公開出來的積木位置與 `rotY`。「哪個字」不需要知道 —— 26 個字都試,要求有一個
// 對得上,而且整條串流要剛好用完。
console.log('\n[plastic letters vs demo — 出貨路徑]');

const strategy = createPlasticTerrainStyle();

/**
 * 一個讓移植的 prop 縮放剛好等於 1 的學校 footprint,`n` 顆積木。
 *
 * across 必須 ≥ `ABC_S + 1.6` 而且 long ≥ across(移植把**長邊**當排的方向),
 * 所以 n = 1 的那一個 depth 不能用 `ABC_S + 0.5` —— 它比 across 短。取 8 m:
 * `round(8 / 5.7) = 1`,而且 8 > 6.8。積木邊長會被下面斷言真的等於 `ABC_S`,
 * 所以這段算術寫錯不會靜靜地過去。
 */
function demoSizedSchool(n: number): BuildingBox {
  return {
    cx: 0, cz: 0, rotY: 0, baseY: 0, skirt: 0, color: 0,
    width: demo.ABC_S + 1.6,
    depth: n === 1 ? 8 : n * (demo.ABC_S + 0.5),
    height: demo.ABC_PLINTH + demo.ABC_S,
  };
}
/** 這個 seed 有沒有抽中字母積木,而且積木數如預期。 */
function schoolBlocks(box: BuildingBox, seed: number, n: number): BoxPart[] | null {
  const parts = strategy.buildBuildingBoxes?.(box, seed, 'school') ?? [];
  if (parts.length !== n + 1) return null;
  const blocks = parts.slice(1);
  // 字母積木是唯一會給出正立方體的學校量體。
  if (!blocks.every((b) => Math.abs(b.w - b.h) < 1e-6 && Math.abs(b.d - b.h) < 1e-6)) return null;
  return blocks;
}

/** demo 的一顆積木身上三個面的字:cube 在 (0, cy, cz)、繞 y 轉 yaw。 */
function demoBlockLetters(
  ch: string, cy: number, cz: number, yaw: number, which: 'ls' | 'rs',
): string[] {
  const g = demo.letterGeo(ch);
  const cube = new THREE.Matrix4().makeRotationY(yaw).setPosition(0, cy, cz);
  const s = which === 'ls' ? demo.ls : demo.rs;
  const out: string[] = [];
  for (const f of demo.faces) {
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(f[0], f[1], f[2]),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(f[3], f[4], f[5])),
      s);
    out.push(...worldTris(g, new THREE.Matrix4().multiplyMatrices(cube, local)));
  }
  return out;
}

/**
 * 把移植的浮凸字串流逐顆積木吃掉,回傳抽到的字。
 *
 * `buildLetterRelief` 依材質分兩份 mesh(深色字 / 白字),一顆積木的三個面一定
 * 落在同一份裡,而每一份內部維持積木順序 —— 所以兩份各開一個游標,每顆積木從
 * **某一份的頭部**吃掉它自己那一段。
 */
function matchBlocks(
  blocks: BoxPart[], buckets: string[][], which: 'ls' | 'rs',
): { chars: string[]; fail: string } {
  const cur = buckets.map(() => 0);
  const chars: string[] = [];
  for (const b of blocks) {
    let hit = '';
    outer: for (let g = 0; g < buckets.length; g++) {
      for (const ch of demo.LETTER_KEYS) {
        const ref = demoBlockLetters(ch, b.y, b.z, b.rotY ?? 0, which);
        if (buckets[g].slice(cur[g], cur[g] + ref.length).join('|') === ref.join('|')) {
          hit = ch;
          cur[g] += ref.length;
          break outer;
        }
      }
    }
    if (!hit) {
      return {
        chars,
        fail: `積木 @z=${b.z.toFixed(2)} yaw=${(b.rotY ?? 0).toFixed(4)}:26 個字沒有一個對得上`,
      };
    }
    chars.push(hit);
  }
  const left = buckets.reduce((a, bk, g) => a + (bk.length - cur[g]), 0);
  return { chars, fail: left === 0 ? '' : `串流沒吃完,剩 ${left} 條三角形` };
}

{
  const N = 4;
  const box = demoSizedSchool(N);
  let seed = -1;
  let blocks: BoxPart[] = [];
  for (let s = 0; s < 4096 && seed < 0; s++) {
    const b = schoolBlocks(box, s, N);
    if (b && strategy.buildBuildingDecoration?.(box, s, 'school')) { seed = s; blocks = b; }
  }
  check('找得到一個抽中字母積木、而且是 demo 那排長度的學校 seed', seed >= 0, `n = ${N}`);
  if (seed >= 0) {
    check('這個 footprint 下移植的積木邊長就是 demo 的 ABC_S(所以 ls / rs 可以直接比)',
      blocks.every((b) => Math.abs(b.h - demo.ABC_S) < 1e-6),
      `${blocks.length} 顆,邊長 ${blocks[0].h.toFixed(3)} / demo ABC_S = ${demo.ABC_S}`);

    const parts = partsOf(strategy.buildBuildingDecoration!(box, seed, 'school')!);
    // `buildLetterRelief` 一種材質一份 mesh:深色字 / 白字 / 外框。一顆積木一份
    // 是移植最容易退化成的樣子(一所學校 15 個 Mesh),demo 的註解特地寫了
    //「三面同一個字、同一個材質,那就是一個 draw call 的事」。
    check('學校的字是二到三份 mesh(深色字 / 白字 / 外框),不是一顆積木一份',
      parts.length >= 2 && parts.length <= 3, `${parts.length} 份`);

    const glyphBuckets = parts.slice(0, -1).map((p) => worldTris(p.geo, p.m));
    const rimBucket = worldTris(parts[parts.length - 1].geo, parts[parts.length - 1].m);

    const ink = matchBlocks(blocks, glyphBuckets, 'ls');
    check('每一顆積木的浮凸字都是 demo 的字形 + demo 的 faces / ls 擺放',
      ink.fail === '' && ink.chars.length === blocks.length,
      ink.fail || `抽到 ${ink.chars.join('')},共 ${glyphBuckets.flat().length} 條三角形`);

    // 這一條同時釘住「外框是最後一份」—— 它拿最後一份去比 `rs`,擺錯順序就對不上。
    const rim = matchBlocks(blocks, [rimBucket], 'rs');
    check('最後一份是外框:同一份字形,縮放換成 demo 的 rs(xy ×1.16、深度 ×0.42)',
      rim.fail === '' && rim.chars.join('') === ink.chars.join(''),
      rim.fail || `${rim.chars.join('')},${rimBucket.length} 條三角形`);
  }
}

// 26 個字母是不是**每一個**都上得了牆。掃 seed 把出貨路徑真的印出來過的字收集
// 起來 —— 這條抓的是「字表縮水」:借招牌字型的那個版本只印得出 15 個字,而逐字
// 串流比對(§2)對「有字形但沒有人用」是瞎的。
{
  const box = demoSizedSchool(1);
  const seen = new Set<string>();
  let schools = 0;
  // 26 個字均勻抽,coupon collector 期望 ~100 次就集滿;2000 個 seed 綽綽有餘,
  // 而且集滿就跳出。⚠ 收的必須是 `matchBlocks` **比對出來**的字,不是候選字 ——
  // 收候選的話每一個三角形數只會記到第一個代表,26 個字會塌成 9 個。
  for (let s = 0; s < 2000 && seen.size < demo.LETTER_KEYS.length; s++) {
    const blocks = schoolBlocks(box, s, 1);
    if (!blocks) continue;
    const deco = strategy.buildBuildingDecoration?.(box, s, 'school');
    if (!deco) continue;
    schools++;
    const m = matchBlocks(blocks, partsOf(deco).slice(0, -1).map((p) => worldTris(p.geo, p.m)), 'ls');
    if (m.fail === '') seen.add(m.chars[0]);
  }
  check('26 個字母每一個都真的印得到積木上(不是只有直線字那 15 個)',
    seen.size === demo.LETTER_KEYS.length,
    `${schools} 所學校印出 ${[...seen].sort().join('')} (${seen.size}/${demo.LETTER_KEYS.length})`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. demo 的公式沒有下界
// ═══════════════════════════════════════════════════════════════════════════
//
// demo 的積木永遠是 5.2 m;真實路線會餵 `height = 0` 與 0 寬的 footprint。字形
// 自己沒有除法所以不會炸,但**擺放**會:`k` 掉到 0 的時候,一個 O 就是 180 個
// 零面積三角形 —— CPU 光柵器看不見它們(MEMORY:probe renders hide degenerate
// triangles),WebGL 照畫。
console.log('\n[plastic letters vs demo — 路線會餵零]');
{
  const base = { cx: 0, cz: 0, rotY: 0, baseY: 0, skirt: 0, color: 0 };
  const degenerate: BuildingBox[] = [
    { ...base, width: 0, depth: 0, height: 0 },
    { ...base, width: 0, depth: 40, height: 0 },
    { ...base, width: 40, depth: 300, height: 0 },
    { ...base, width: 1e-9, depth: 1e-9, height: 1e-9 },
  ];
  let nan = 0;
  let zeroArea = 0;
  let threw = '';
  let built = 0;
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cr = new THREE.Vector3();
  for (const b of degenerate) {
    for (let s = 0; s < 96; s++) {
      let deco: THREE.Object3D | null = null;
      try {
        deco = strategy.buildBuildingDecoration?.(b, s, 'school') ?? null;
      } catch (err) {
        threw ||= `${(err as Error).message} @ ${b.width}×${b.depth}×${b.height}`;
      }
      if (!deco) continue;
      built++;
      for (const p of partsOf(deco)) {
        const pos = p.geo.getAttribute('position');
        const idx = p.geo.index;
        const n = idx ? idx.count : pos.count;
        for (let i = 0; i < n; i += 3) {
          for (let k = 0; k < 3; k++) {
            const j = idx ? idx.getX(i + k) : i + k;
            v[k].set(pos.getX(j), pos.getY(j), pos.getZ(j)).applyMatrix4(p.m);
            if (!Number.isFinite(v[k].x + v[k].y + v[k].z)) nan++;
          }
          cr.crossVectors(e1.subVectors(v[1], v[0]), e2.subVectors(v[2], v[0]));
          if (cr.length() < 1e-12) zeroArea++;
        }
      }
    }
  }
  check('零尺寸的 footprint 不會讓字形的建構丟例外', threw === '',
    threw || `4 種退化箱 × 96 seed,建出 ${built} 份裝飾`);
  check('…也不會產生 NaN 頂點', nan === 0, `${nan} 個`);
  check('…也不會留下零面積三角形(probe 看不見,WebGL 照畫)', zeroArea === 0, `${zeroArea} 個`);
}

export function failureCount(): number {
  return failures;
}
