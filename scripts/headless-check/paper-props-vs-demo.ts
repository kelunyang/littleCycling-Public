/**
 * `[paper-props vs demo]` —— 瓦楞紙世界的兩件小東西:**樹腳下的白膠痕**,以及
 * 「等高線小丘還活著嗎」這個問題本身。
 *
 * 同一套紀律:demo 的原始碼從 `plan/paper-town-demo.html` **切出來執行**,再跟真實
 * 遊戲的策略逐項比。這個檔案裡沒有一個抄過來的常數 —— 抄過來的常數只會把當初打錯
 * 的東西再確認一遍(CUSTOM_WORLD_INSTRUCTIONS §0.0 第 5 點)。
 *
 * 三段:
 *
 *  1. **可達性。** demo 會刪東西,而移植不會自己跟上(§0.0 第 6 點),但**反過來
 *     也一樣危險**:demo 裡留著一份被否決的函式,而移植的人把它當成規格。這個世界
 *     已經發生過一次 —— `contourRing` 定義完整、註解寫得像規格,而**沒有任何人呼叫
 *     它**;活的是 `inkRidge`。所以這裡從 demo 的 chunk 建構器做一次可達性走訪,把
 *     「誰還活著」變成一條會失敗的斷言,而不是每一輪重讀一次 HTML 的人工判斷。
 *
 *  2. **白膠痕的幾何。** 比的是**有順序的世界座標三角形串流**,同時帶幾何法線(抓
 *     反向纏繞)與過了 normal matrix 的著色法線。圓盤的段數、半徑、離板面的高度、
 *     朝上還是朝下,全部在這條串流裡。
 *
 *  3. **它真的被送到畫面上。**「記錄了」不等於「送得到」:新 hook 光是宣告不算數,
 *     所以這裡跑真的 `buildTreeMeshes`,確認姊妹 InstancedMesh 真的長出來、真的
 *     共用同一組 instance matrix、旗標是 demo 的那一組、而且 dispose 收得掉。
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/paper-props-vs-demo.ts
 */
import { readFileSync } from 'node:fs';

// canvas stub 走 harness 共用的那一份。貼圖快取是模組層的,自己裝一個
// `globalThis.document` 會把別人錄的東西丟掉 —— 那個病讓兩次假通過靜靜地過了關。
const { installRecordingCanvas, canvases } = await import('./recording-canvas.ts');
type RecCanvas = import('./recording-canvas.ts').RecCanvas;
installRecordingCanvas();

const THREE = await import('three');
const { createTerrainStyleStrategy } = await import('@/game/terrain/terrain-style-strategy');
const { buildTreeMeshes, disposeTreeMesh } = await import('@/game/terrain/tree-renderer');
const { buildQuantizedCorridorGeometry, quantizedDataToGeometry } =
  await import('@/game/terrain/quantized-terrain');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
export function failureCount(): number { return failures; }

// ── demo 切片 ────────────────────────────────────────────────────────────────

const HTML = readFileSync('plan/paper-town-demo.html', 'utf8');
/** demo 自己的程式碼是第二個 `<script>`(第一個是打包進去的 three)。 */
const SRC = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])[1] ?? '';

/** 一整個 `function name(...) { … }`,大括號配對。 */
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
/** 以 `head` 開頭的一整行。 */
function sliceLine(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`cannot slice line ${head}`);
  return src.slice(at, src.indexOf('\n', at));
}
/** 以 `head` 開頭、括號配對的一句宣告(`const x = (() => {…})();`)。 */
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

/** 用**真的** three 執行 demo 的原始碼。 */
function runDemo(prelude: string[], tail: string): Record<string, never> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('THREE', [...prelude, tail].join('\n'))(THREE) as Record<string, never>;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 可達性 —— demo 裡哪些造型函式還活著
// ═══════════════════════════════════════════════════════════════════════════
//
// 這一段回答的是「這個函式該不該被移植」。答案不能靠讀註解:`contourRing` 的標頭
// 註解把它寫得像是這個世界的地形規格,而它是死的;活的是 `inkRidge`,它的標頭比較
// 短。一個 agent 因為讀反了這兩段而差點移植了死碼。
//
// 走訪從 demo 的 chunk 建構器 `buildChunk` 出發 —— 那是「一個 chunk 裡會出現什麼」
// 的唯一入口,也就是移植要對齊的那個集合。

console.log('\n[paper demo: 造型函式的可達性]');

/** 註解裡的名字不是呼叫。`contourRing` 在一段長註解裡出現過,那正是它騙人的地方。 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** demo 頂層 `function NAME(` 的名字 → 它的函式體。 */
function topLevelFns(code: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (out.has(name)) continue;
    let i = code.indexOf('{', m.index), depth = 0;
    for (; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') { depth--; if (depth === 0) break; }
    }
    out.set(name, code.slice(m.index, i + 1));
  }
  return out;
}

const FNS = topLevelFns(CODE);
check('demo 的頂層函式切得出來', FNS.size > 40, `${FNS.size} 個`);
check('走訪的起點 buildChunk 在裡面', FNS.has('buildChunk'));

/** 從 buildChunk 出發,誰被誰提到 —— 傳遞閉包。 */
function reachableFrom(root: string): Set<string> {
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length) {
    const body = FNS.get(queue.shift()!) ?? '';
    // 自己的函式標頭不算「呼叫自己」。
    const inner = body.slice(body.indexOf('(') + 1);
    for (const name of FNS.keys()) {
      if (seen.has(name)) continue;
      if (new RegExp(`\\b${name}\\s*\\(`).test(inner)) { seen.add(name); queue.push(name); }
    }
  }
  return seen;
}
const LIVE = reachableFrom('buildChunk');

// 反向對照就在同一次執行裡:同一支走訪器同時被要求說「這個活著」跟「這個到不了」,
// 所以一個永遠回 true(或永遠回 false)的走訪器過不了這兩條。
check('走訪器分得出死活:blobShape 從 buildChunk 到得了(池塘在用)',
  LIVE.has('blobShape'), `${LIVE.size} 個函式可達`);
check('…而 inkRidge 到不了 —— 遠山是頂層建一次的,不在 chunk 裡',
  !LIVE.has('inkRidge'));

// ── 等高線小丘三兄弟:**已刪除**,而且不准回來 ────────────────────────────
//
// 2026-07-28 使用者裁示。這三條原本是「contourPlate 活著 / contourRing 是死碼」,
// 現在方向反過來了,理由比當初更強(`plan/demo-gaps.md`「demo 為了自己的限制而
// 發明的東西」):
//
//   `contourHill` 存在的理由是「demo 的地面是一張平的切割墊,它得假造起伏」。
//   demo 的地面現在可以是真的(`?loc=` 走 DEM),那個理由就消失了 —— 留著它,
//   小丘會疊在真坡上,跟騎士正在爬的坡度矛盾,變成 **demo 自己畫錯**,而 demo
//   是 POC,它畫錯就等於規格錯。
//
// `contourRing` 一併刪:它定義完整、註解寫得像規格,而**呼叫點是 0**。那段註解
// 已經騙過人兩次(有人從死碼裡抄了「逐板色帶 + 手抖乘數」寫進移植交接文件)。
//
// 這三條是**反向斷言**:不是「demo 必須留著它們」,是「它們必須不在」。
for (const name of ['contourPlate', 'contourHill', 'contourRing'] as const) {
  const defined = FNS.has(name);
  const called = new RegExp(`\\b${name}\\s*\\(`).test(CODE);
  check(`${name} 已經從 demo 刪掉了 —— 定義與呼叫都不准回來`,
    !defined && !called, `定義=${defined} 呼叫點=${called}`);
}
// 上面那三條在「這個判斷永遠說不在」的情況下也會過,所以要有一個對照:同一組
// 判斷拿去問一個確實還在的名字,必須說「在」。
check('反向對照:同一組判斷對 inkRidge 說「還在」',
  FNS.has('inkRidge') && /\binkRidge\s*\(/.test(CODE));
// 而刪掉小丘**不可以**順手帶走 PLATE_H / plateTopMats —— 那不是小丘的東西,是
// 量化地形的踏面色與生瓦楞豎邊,gameview 早就移植了(terrain-band-vs-demo.ts
// 釘著)。它們跟小丘住在同一段,是最容易被一起刪掉的東西。
check('留下來的是走廊地形的東西:PLATE_H / PLATE_UV / plateTopMats / plateEdgeMat 都還在',
  ['const PLATE_H =', 'const PLATE_UV =', 'const plateTopMats =', 'const plateEdgeMat =']
    .every((k) => SRC.includes(k)));

/** 把某個函式**自己的定義**整段挖掉之後,還有沒有人提到它。 */
const mentionedElsewhere = (name: string): boolean => {
  const own = FNS.get(name);
  if (!own) return false;
  return new RegExp(`\\b${name}\\s*\\(`).test(CODE.replace(own, ''));
};
// 遠山不在 buildChunk 底下(它是頂層建一次的),所以那一圈走訪看不到它 —— 用第二個
// 角度問同一件事,而且兩個名字共用同一支判斷,答案卻必須一個 true 一個 false。
check('第二個角度:遠山走的是 inkRidge(它有人用)', mentionedElsewhere('inkRidge'));
// gouacheCanvas 之類的貼圖工廠只被自己那一段用到,不是造型函式;拿一個**確實
// 存在但沒有第二個呼叫者**的名字當 false 那一邊,才不會是「拿不存在的名字問」
// 那種空對照(刪掉的三個名字問下去一律回 false,那證明不了什麼)。
{
  const dead = [...FNS.keys()].filter((n) => !mentionedElsewhere(n));
  check('第二個角度的 false 對照:demo 裡確實有「定義了但沒有第二個呼叫者」的函式',
    dead.length > 0, `${dead.length} 個:${dead.slice(0, 6).join(', ')}${dead.length > 6 ? ' …' : ''}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. 白膠痕 —— 幾何
// ═══════════════════════════════════════════════════════════════════════════
//
// demo 的 `treeBucket.add` 一棵樹丟三筆矩陣:兩張卡(`unitPlane`,scale 10s,
// 抬到 y + 5s)加一片膠痕(`unitDisc`,rotation.x = −π/2,scale 2.6s,y + 0.07)。
// 移植把卡片的 10s / +5s 烘進幾何,所以膠痕也照同一條規矩烘 —— 兩者共用同一組
// instance matrix,這是它能只花一個 draw call 的原因。
//
// 卡片邊長 demo 是 10、移植是 8(instance scale 的範圍也不同),所以「2.6」不能
// 照抄,能照抄的是**比**:2.6 / 10。這裡的每一個數字都是從 demo 執行出來的,
// 沒有一個是打在這個檔案裡的。

console.log('\n[白膠痕 vs demo — 幾何]');

/** demo 的 treeBucket,以 s = 1、ry = 0 跑一棵樹。 */
const demoTree = (() => {
  const d = runDemo([
    'const geoCache = new Map(); const SHARED_GEO = new Set();',
    sliceFn(SRC, 'shared'),
    sliceLine(SRC, '  const unitPlane = '),
    sliceLine(SRC, '  const unitDisc = '),
    'const treeMats = new Proxy({}, { get: () => ["cut0", "cut1"] });',
    'const treeDepthMats = treeMats; const glueMat = "glueMat";',
    sliceFn(SRC, 'treeBucket'),
  ], `
    const b = treeBucket();
    b.add('round', 1, 0, 0, 0, 0);
    const group = new THREE.Group();
    b.flush(group, []);
    return { group };
  `) as unknown as { group: THREE.Group };
  d.group.updateMatrixWorld(true);
  const batches = d.group.children as unknown as THREE.InstancedMesh[];
  const glue = batches.find((m) => m.material === ('glueMat' as unknown));
  const card = batches.find((m) => m.material !== ('glueMat' as unknown));
  if (!glue || !card) throw new Error('demo treeBucket produced no glue/card batch');
  const gm = new THREE.Matrix4(), cm = new THREE.Matrix4();
  glue.getMatrixAt(0, gm);
  card.getMatrixAt(0, cm);
  const dec = (m: THREE.Matrix4) => {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    return { p, q, s };
  };
  const flags = (o: THREE.Object3D) => ({ cast: o.castShadow, recv: o.receiveShadow });
  return {
    glueGeo: glue.geometry, glue: dec(gm), card: dec(cm), batches: batches.length,
    glueFlags: flags(glue), cardFlags: flags(card),
  };
})();

check('demo 的一棵樹是三批:兩張卡 + 一片膠痕', demoTree.batches === 3,
  `${demoTree.batches} 批`);

const style = await createTerrainStyleStrategy('paper');
check('瓦楞紙宣告了 treeGroundMark', typeof style.treeGroundMark === 'function');

const mark = style.treeGroundMark?.() ?? null;
check('而且它真的回得出東西(不是 null)', mark !== null);

const cardGeo = style.buildTreeGeometry!();
const cardBox = new THREE.Box3().setFromBufferAttribute(
  cardGeo.getAttribute('position') as THREE.BufferAttribute);
const portCardSide = cardBox.max.x - cardBox.min.x;

/**
 * demo 的膠痕該有多大,換算到移植的卡片尺寸上:`2.6 / 10` 這個**比**乘上移植的
 * 卡片邊長。兩個 demo 數字都是從上面執行出來的矩陣讀的。
 */
const demoRatio = demoTree.glue.s.x / demoTree.card.s.x;
const wantRadius = portCardSide * demoRatio;

if (mark) {
  const markBox = new THREE.Box3().setFromBufferAttribute(
    mark.geometry.getAttribute('position') as THREE.BufferAttribute);
  const gotRadius = (markBox.max.x - markBox.min.x) / 2;
  check('膠痕對卡片的比 = demo 的 2.6 / 10',
    Math.abs(gotRadius / portCardSide - demoRatio) < 1e-9,
    `demo ${demoRatio.toFixed(6)} vs ours ${(gotRadius / portCardSide).toFixed(6)}`);
  check('圓盤是平躺的(y 方向沒有厚度)',
    Math.abs(markBox.max.z - markBox.min.z - 2 * gotRadius) < 1e-6
    && Math.abs(markBox.max.y - markBox.min.y) < 1e-9,
    `x ${(markBox.max.x - markBox.min.x).toFixed(4)} `
    + `y ${(markBox.max.y - markBox.min.y).toFixed(4)} `
    + `z ${(markBox.max.z - markBox.min.z).toFixed(4)}`);
  check('離板面的高度 = demo 的 0.07',
    Math.abs(markBox.min.y - demoTree.glue.p.y) < 1e-9,
    `demo ${demoTree.glue.p.y} vs ours ${markBox.min.y}`);
}

/**
 * 有順序的世界座標三角形串流,兩種法線都帶:
 *  - **幾何法線**(三個角點算出來的)—— 纏繞反轉會翻號,而包圍盒與三角形數一格
 *    不動,所以只有這條抓得到。
 *  - **著色法線**(`normal` 屬性過 normal matrix)—— 圓盤翻面、或忘了轉 −π/2
 *    卻用位置補回來,兩者位置相同而法線相反。
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
  const f = (x: number): string => (Math.abs(x) < 5e-4 ? '0' : x.toFixed(3));
  const out: string[] = [];
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
function firstDiff(a: string[], b: string[]): string {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return `tri ${i}: demo [${a[i] ?? '—'}] vs ours [${b[i] ?? '—'}]`;
  }
  return 'identical';
}

if (mark) {
  // demo 自己那片 `unitDisc`,擺在 demo 自己的姿態上(位移、旋轉照抄),只有
  // **縮放**換成「同一個比 × 移植的卡片邊長」。
  const want = new THREE.Matrix4().compose(
    demoTree.glue.p, demoTree.glue.q, new THREE.Vector3().setScalar(wantRadius),
  );
  const a = worldTris(demoTree.glueGeo, want);
  const b = worldTris(mark.geometry, new THREE.Matrix4());
  check('每一個三角形(含纏繞與兩種法線)都跟 demo 的 unitDisc 相同',
    a.length > 0 && a.join('|') === b.join('|'),
    `${a.length} vs ${b.length} tris — ${firstDiff(a, b)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. 白膠痕 —— 材質與那張貼圖
// ═══════════════════════════════════════════════════════════════════════════
//
// 這片痕跡的全部就是它的 alpha ramp(0.02 → 0.12),而 3D probe 讀不到 per-texel
// alpha(§10 第 7 條:它拿整個 `material.opacity` 當全片 alpha)。所以唯一驗得了
// 這件事的地方是**畫布上的筆觸**,逐筆比。

console.log('\n[白膠痕 vs demo — 材質與貼圖]');

/**
 * 從錄下來的筆觸還原「一圈一圈」:每個 `arc(cx, cy, r, …)` 配上它前面最近的一次
 * `globalAlpha=`。收尾那筆 `globalAlpha = 1` 後面沒有 arc,所以自然不會進來。
 */
function ringsOf(trace: string[]): { r: number; a: number }[] {
  const out: { r: number; a: number }[] = [];
  let a = 1;
  for (const op of trace) {
    if (op.startsWith('globalAlpha=')) a = Number(op.slice('globalAlpha='.length));
    else if (op.startsWith('arc(')) out.push({ r: Number(op.slice(4, -1).split(',')[2]), a });
  }
  return out;
}

const demoGlueMat = (runDemo(
  [sliceStmt(SRC, '  const glueMat = (() => {')],
  'return { m: glueMat };',
) as unknown as { m: THREE.MeshBasicMaterial }).m;

if (mark) {
  const got = mark.material as THREE.MeshBasicMaterial;
  const facts = (m: THREE.MeshBasicMaterial) => ({
    cls: m.constructor.name,
    color: m.color.getHex(),
    opacity: m.opacity,
    transparent: m.transparent,
    depthWrite: m.depthWrite,
    side: m.side,
  });
  const w = facts(demoGlueMat), g = facts(got);
  for (const k of ['cls', 'color', 'opacity', 'transparent', 'depthWrite', 'side'] as const) {
    const show = (v: unknown): string => (k === 'color' ? Number(v).toString(16) : String(v));
    check(`glueMat 的 ${k}`, w[k] === g[k], `demo ${show(w[k])} vs ours ${show(g[k])}`);
  }
  const wTex = demoGlueMat.map as THREE.CanvasTexture;
  const gTex = got.map as THREE.CanvasTexture;
  check('兩邊都真的掛了一張貼圖', !!wTex && !!gTex);
  if (wTex && gTex) {
    const wc = wTex.image as unknown as RecCanvas;
    const gc = gTex.image as unknown as RecCanvas;
    check('畫布尺寸相同', wc.width === gc.width && wc.height === gc.height,
      `demo ${wc.width}×${wc.height} vs ours ${gc.width}×${gc.height}`);
    check('colorSpace 相同', wTex.colorSpace === gTex.colorSpace,
      `demo ${wTex.colorSpace} vs ours ${gTex.colorSpace}`);
    // 逐筆:含 `globalAlpha=` 與 `fillStyle=` 的樣式變更,有順序。alpha ramp 的
    // 31 個值就住在這串裡 —— 少一圈、ramp 的方向反了、顏色換了都會在這裡爆。
    const wt = wc.trace, gt = gc.trace;
    let bad = -1;
    for (let i = 0; i < Math.max(wt.length, gt.length); i++) {
      if (wt[i] !== gt[i]) { bad = i; break; }
    }
    check('每一筆都跟 demo 的 glueMat 畫布相同(含 31 圈的 alpha ramp)',
      bad < 0 && wt.length > 0,
      `${wt.length} vs ${gt.length} ops` + (bad < 0 ? '' : ` — #${bad}: [${wt[bad]}] vs [${gt[bad]}]`));
    // ── 這片痕跡「是」它的 alpha ramp,所以 ramp 本身也要被斷言 ──
    //
    // ⚠ 最後那一筆 `globalAlpha = 1` 是**收尾的重設**,不是 ramp 的一端。把它算
    // 進去的話,「最濃有沒有超過 0.9」這種斷言會被那個 1 餵飽,而 ramp 的係數改成
    // 任何值都照樣通過。所以這裡改成讀**每一圈**的 (半徑, alpha),再看形狀。
    const rings = ringsOf(gc.trace);
    check('膠痕是一圈一圈疊出來的,而且圈數 = demo 的 31',
      rings.length === ringsOf(wc.trace).length && rings.length > 1,
      `${rings.length} 圈`);
    const outward = rings.slice().sort((p, q) => q.r - p.r);
    check('由外往內一圈比一圈濃(嚴格遞增),而且濃淡差 5 倍以上',
      outward.every((x, i) => i === 0 || x.a > outward[i - 1].a)
      && outward[outward.length - 1].a > outward[0].a * 5,
      `${outward[0]?.a} … ${outward[outward.length - 1]?.a}`);

    // 為什麼它不能跟卡片共用材質,量出來:卡片是 `alphaTest` 的,而膠痕的整條
    // falloff 就落在門檻底下 —— 共用的話剩下的是一個硬邊的圓,那正好是這片痕跡
    // 存在的反面。兩個門檻都是從真實材質讀的,沒有一個是打在這裡的。
    const card = style.createTreeMaterial() as THREE.MeshToonMaterial;
    const keptR = (alphaTest: number, opacity: number): number => {
      let kept = 0;
      for (let r = 0; r <= rings[0].r; r++) {
        // 疊上去的圈:半徑 ≥ r 的都蓋過這一點。source-over 的累積不透明度。
        let clear = 1;
        for (const g2 of rings) if (g2.r >= r) clear *= 1 - g2.a;
        if (opacity * (1 - clear) >= alphaTest) kept = r;
      }
      return kept / rings[0].r;
    };
    const glueKept = keptR(got.alphaTest, got.opacity);
    const cardKept = keptR(card.alphaTest, got.opacity);
    check('卡片的材質是 alphaTest 的、膠痕的不是', card.alphaTest > 0 && got.alphaTest === 0,
      `card ${card.alphaTest} vs glue ${got.alphaTest}`);
    check('用卡片的門檻畫膠痕會砍掉外圈,用它自己的材質整片都在',
      glueKept === 1 && cardKept < 0.7,
      `自己的材質留下 ${(glueKept * 100).toFixed(0)}%、卡片的門檻只留下 `
      + `${(cardKept * 100).toFixed(0)}% 的半徑`);
    card.dispose();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. 它真的被送到畫面上了嗎
// ═══════════════════════════════════════════════════════════════════════════
//
// 「記錄了」不等於「送得到」。陰影那次量到三個 demo 的 normalBias 不一致、把那個
// 分歧斷言了下來,而三個世界照樣全拿多數決那個值 —— 因為沒有任何東西把逐世界的值
// 送到光上。所以這一段跑的是真的 `buildTreeMeshes`。

console.log('\n[白膠痕:真的被 tree-renderer 消費了]');

const flatSampler = {
  getElevationSync: () => 0,
  getElevation: async () => 0,
} as unknown as Parameters<typeof buildTreeMeshes>[1];

/** 原點上一塊約 400 m 見方的森林 —— `buildTreeMeshes` 吃的是 GeoJSON。 */
function forestFeature(): Parameters<typeof buildTreeMeshes>[0][number] {
  const d = 400 / 111320;
  return {
    layer: 'landuse',
    properties: { class: 'wood' },
    geometry: {
      type: 'Polygon',
      coordinates: [[[-d, -d], [d, -d], [d, d], [-d, d], [-d, -d]]],
    },
  } as unknown as Parameters<typeof buildTreeMeshes>[0][number];
}

type World = 'paper' | 'plastic' | 'circuit';
const flagStr = (o: THREE.Object3D): string =>
  `${o.castShadow ? 'C' : '-'}${o.receiveShadow ? 'R' : '-'}`;

/**
 * demo 的 `treeBucket.flush` 給了哪些旗標 —— **執行出來的**,不是 grep 出來的:
 * 那個分支是 `if (depthMat) { im.castShadow = true; … }`,而膠痕那批沒有 depthMat。
 * 一條寫死的 regex 只證明「原始碼長那樣」,執行證明「跑出來的物件是那樣」。
 */
const fl = (f: { cast: boolean; recv: boolean }): string =>
  `${f.cast ? 'C' : '-'}${f.recv ? 'R' : '-'}`;
const demoCardFlags = fl(demoTree.cardFlags);
const demoGlueFlags = fl(demoTree.glueFlags);
check('demo 的卡片是 C-(只投影)', demoCardFlags === 'C-', demoCardFlags);
check('demo 的膠痕是 --(什麼都不給)', demoGlueFlags === '--', demoGlueFlags);

const built: Record<string, Awaited<ReturnType<typeof buildTreeMeshes>>> = {};
for (const world of ['paper', 'plastic', 'circuit'] as World[]) {
  const s = world === 'paper' ? style : await createTerrainStyleStrategy(world);
  const res = await buildTreeMeshes(
    [forestFeature()], flatSampler, 0, 0, 0, s,
  );
  built[world] = res;
  // 一棵樹都沒種到的話會退回空的 fallback mesh,它的旗標是 three 的預設值 ——
  // 下面每一條斷言都會因為錯的理由通過。
  check(`${world}: 真的種到樹了`, res.treeCount > 0, `${res.treeCount} 棵`);
}

{
  const res = built.paper;
  const kids = res.mesh.children as unknown as THREE.InstancedMesh[];
  check('瓦楞紙的樹多長出一個姊妹 InstancedMesh(一個 chunk 一個 draw call)',
    kids.length === 1 && !!kids[0]?.isInstancedMesh, `${kids.length} 個子物件`);
  const m = kids[0];
  if (m) {
    check('姊妹的 instance 數 = 樹的棵數', m.count === res.treeCount,
      `${m.count} vs ${res.treeCount}`);
    const a = res.mesh.instanceMatrix.array as Float32Array;
    const b = m.instanceMatrix.array as Float32Array;
    let diff = -1;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { diff = i; break; }
    check('而且共用同一組 instance matrix,逐個 float 相同', diff < 0 && a.length > 0,
      diff < 0 ? `${a.length / 16} 個矩陣` : `第 ${diff} 個 float 不同`);
    check('姊妹畫的是膠痕那片圓盤(12 段 = 12 個三角形)',
      (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3 === 12,
      `${(m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3} tris`);
    check(`膠痕的旗標 = demo 的 ${demoGlueFlags}`, flagStr(m) === demoGlueFlags,
      `demo ${demoGlueFlags} vs ours ${flagStr(m)}`);
  }
  check(`瓦楞紙的樹本體 = demo 卡片的 ${demoCardFlags}`,
    flagStr(res.mesh) === demoCardFlags, `demo ${demoCardFlags} vs ours ${flagStr(res.mesh)}`);
}

// 沒宣告這兩樣的世界必須**一格沒動** —— optional 欄位最常見的失敗是它悄悄改了別人。
for (const world of ['plastic', 'circuit'] as const) {
  const res = built[world];
  check(`${world}: 沒宣告 treeGroundMark,所以樹沒有子物件`,
    res.mesh.children.length === 0, `${res.mesh.children.length} 個`);
  check(`${world}: 沒宣告 treeShadow,所以還是 CR`, flagStr(res.mesh) === 'CR', flagStr(res.mesh));
}

// dispose 的所有權:膠痕的幾何是**新的**(不是樹那份),沒人收就是每個 chunk 漏一片。
{
  const kid = built.paper.mesh.children[0] as THREE.Mesh | undefined;
  let freedGeo = false, freedMat = false;
  kid?.geometry.addEventListener('dispose', () => { freedGeo = true; });
  (kid?.material as THREE.Material | undefined)?.addEventListener('dispose', () => { freedMat = true; });
  const map = (kid?.material as THREE.MeshBasicMaterial | undefined)?.map ?? null;
  let freedMap = false;
  map?.addEventListener('dispose', () => { freedMap = true; });
  for (const world of ['paper', 'plastic', 'circuit'] as World[]) disposeTreeMesh(built[world]);
  check('disposeTreeMesh 收掉了膠痕的幾何', freedGeo);
  check('也收掉了它的材質', freedMat);
  // 貼圖是 strategy 擁有的 singleton(材質 dispose 不會碰 map),由 dispose() 收 ——
  // chunk 回收器碰了它,下一個 chunk 的膠痕就是一張空白貼圖。
  check('但**沒有**收掉貼圖(那是 strategy 的)', !freedMap);
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. 地面**實際畫出來的**顏色
// ═══════════════════════════════════════════════════════════════════════════
//
// 「宣告了」不等於「畫得出來」,而這個世界有兩個候選:平滑地形走
// `terrainVertexColor`(它在這個世界是 `paperify(積木的地形色)`),量化地形走
// `bandAt`。`terrain-band-vs-demo.ts` 那五十條全部問的是 `bandAt` **宣告**成什麼,
// 沒有任何一條問過「哪一個真的進了 color attribute」—— 所以這裡走真正的
// `buildQuantizedCorridorGeometry` + `quantizedDataToGeometry`,直接讀 buffer。
//
// 第二段問的是同一個顏色**送到螢幕上**還剩下什麼。demo 的畫面是
// `renderer.render(scene, camera)` —— 沒有 composer、沒有任何全螢幕色彩變換,
// 這個世界的紙感全部由幾何與材質帶。gameview 多掛了一張 paper pass,所以「它
// 有沒有把 demo 的色票挪走」必須被量,而且要用**這支 pass 自己的 uniform**去量,
// 不是用寫在這裡的常數。

console.log('\n[地面實際畫出來的顏色 vs demo]');

/** demo 的 TERRAIN_BAND / PLATE_H —— 從 HTML 切出來執行。 */
const paperBandDemo = runDemo([], `
  ${sliceStmt(SRC, '  const TERRAIN_BAND = [')}
  ${sliceLine(SRC, '  const PLATE_H = ')}
  return { TERRAIN_BAND, PLATE_H };
`) as unknown as { TERRAIN_BAND: string[]; PLATE_H: number };

const LAYER = style.params.layerHeight;

/** 一塊 ALONG×CROSS 的走廊網格,`stepAt` 決定每一欄比路面高幾階。 */
function corridorGrid(originEle: number, stepAt: (c: number) => number, x0 = 0, z0 = 0) {
  const ALONG = 6, CROSS = 6;
  const gx: number[] = [], gz: number[] = [], gele: number[] = [], gcol: number[] = [];
  for (let a = 0; a < ALONG; a++) {
    for (let c = 0; c < CROSS; c++) {
      const x = x0 + c * 30, z = z0 + a * 30;
      const ele = originEle + stepAt(c) * LAYER;
      gx.push(x); gz.push(z); gele.push(ele);
      const col = style.terrainVertexColor(ele, x, z);
      gcol.push(col.r, col.g, col.b);
    }
  }
  return { gx, gz, gele, gcol, along: ALONG, cross: CROSS };
}

/** 踏面(group 0)每個 level 出現的顏色,依出現順序。 */
function topColours(grid: ReturnType<typeof corridorGrid>, originEle: number): string[] {
  const data = buildQuantizedCorridorGeometry(grid as never, style, originEle);
  const geo = quantizedDataToGeometry(data);
  const col = geo.getAttribute('color');
  const idx = geo.index!;
  const seen: string[] = [];
  const tmp = new THREE.Color();
  for (let i = 0; i < data.topIndexCount; i++) {
    const j = idx.getX(i);
    tmp.setRGB(col.getX(j), col.getY(j), col.getZ(j));
    const hex = `#${tmp.getHexString()}`;
    if (!seen.includes(hex)) seen.push(hex);
  }
  geo.dispose();
  return seen;
}

const GROUND_ORIGIN = 100;
const drawn = topColours(corridorGrid(GROUND_ORIGIN, (c) => Math.min(5, c)), GROUND_ORIGIN);
check('走真的 buildQuantizedCorridorGeometry,踏面畫出了六階的前三階',
  drawn.length === 3, drawn.join(' '));
check('而且那三階逐位元組 = demo 的 TERRAIN_BAND 前三個',
  drawn.join(' ') === paperBandDemo.TERRAIN_BAND.slice(0, 3).join(' ').toLowerCase(),
  `demo ${paperBandDemo.TERRAIN_BAND.slice(0, 3).join(' ')} vs 畫出來 ${drawn.join(' ')}`);

// 反向對照:把 `terrainVertexColor` 換成洋紅再建一次。它**一格都不該**進踏面 ——
// 這條是「地面到底走哪個函式」的直接證據,而不是讀原始碼推的。
{
  const orig = style.terrainVertexColor;
  (style as unknown as { terrainVertexColor: unknown }).terrainVertexColor =
    () => new THREE.Color(1, 0, 1);
  const magenta = topColours(corridorGrid(GROUND_ORIGIN, (c) => Math.min(5, c)), GROUND_ORIGIN);
  (style as unknown as { terrainVertexColor: unknown }).terrainVertexColor = orig;
  check('把 terrainVertexColor 換成洋紅,踏面一格都沒變 —— 地面走的是 bandAt',
    !magenta.includes('#ff00ff') && magenta.join(' ') === drawn.join(' '),
    magenta.join(' '));
}

// ── 送到螢幕上還剩什麼 ──

/** demo 自己的畫面:`renderer.render(scene, camera)`,沒有 composer。 */
const demoPostOps = ['EffectComposer', 'ShaderPass', 'RenderPass', 'composer.render'];
check('demo 完全沒有全螢幕後製(它的紙感住在幾何與材質裡)',
  demoPostOps.every((k) => !SRC.includes(k)) && SRC.includes('renderer.render(scene, camera)'),
  demoPostOps.filter((k) => SRC.includes(k)).join(', ') || 'renderer.render(scene, camera)');

const postPass = style.createPostPass!(1920, 1080)!;
const PU = (postPass as unknown as { uniforms: Record<string, { value: unknown }> }).uniforms;
// 下面那支評估器是照 uniform 算的,所以它看不見「寫死在 GLSL 裡的色偏」。那正是
// 這道被拔掉的乘法原本的形狀(`col *= uPaperColor;`),所以連原始碼一起問一次:
// 整片 `col` 不可以再乘上任何 vec3。純量乘(紙纖維)不在這條規則裡。
{
  const frag = (postPass as unknown as { material: { fragmentShader: string } })
    .material.fragmentShader;
  const vecMul = frag.match(/\bcol\s*\*=\s*(?!mix|vec3\(\s*1\.0\s*,\s*1\.0\s*,\s*1\.0\s*\))[A-Za-z_]\w*\s*;|\bcol\s*\*=\s*vec3\s*\(/g) ?? [];
  check('paper pass 的著色器裡沒有任何「整片乘一個顏色」的步驟',
    vecMul.length === 0 && !('uPaperColor' in PU), vecMul.join(' ') || 'none');
}
/**
 * paper pass 的片段著色器,照它自己的順序跑一次。**每一個係數都是從這支 pass
 * 的 uniform 讀的**,沒有一個打在這個檔案裡 —— 改 shader 的預設值,這裡量到的
 * 就會跟著變。輸入輸出都是線性空間(composer 的順序是 RenderPass → stylePass →
 * OutputPass,所以這支 pass 看到的是還沒編碼成 sRGB 的值)。
 */
function throughPaperPass(c: THREE.Color, fiber = 0.95): THREE.Color {
  const L = PU['uLevels'].value as number;
  const P = PU['uPosterize'].value as number;
  const D = PU['uDesaturate'].value as number;
  const F = PU['uFiberStrength'].value as number;
  const S = PU['uStrength'].value as number;
  const tint = PU['uPaperColor']?.value as THREE.Vector3 | undefined;
  const src: [number, number, number] = [c.r, c.g, c.b];
  let v: [number, number, number] = [...src];
  v = v.map((x) => x + (Math.floor(x * L + 0.5) / L - x) * P) as [number, number, number];
  const lum = 0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2];
  v = v.map((x) => x + (lum - x) * D) as [number, number, number];
  if (tint) v = [v[0] * tint.x, v[1] * tint.y, v[2] * tint.z];
  const m = 1 + (fiber - 1) * F;
  v = v.map((x) => x * m) as [number, number, number];
  v = v.map((x, i) => src[i] + (x - src[i]) * S) as [number, number, number];
  return new THREE.Color(v[0], v[1], v[2]);
}

function hueDeg(c: THREE.Color): number {
  const o = { h: 0, s: 0, l: 0 };
  c.getHSL(o);
  return o.h * 360;
}
function satOf(c: THREE.Color): number {
  const o = { h: 0, s: 0, l: 0 };
  c.getHSL(o);
  return o.s;
}

{
  // 量的是**畫出來的那個顏色**(上面從 color attribute 讀的),不是宣告值。
  const shifts = drawn.map((hex) => {
    const before = new THREE.Color(hex);
    const after = throughPaperPass(before);
    let dh = hueDeg(after) - hueDeg(before);
    if (dh > 180) dh -= 360;
    if (dh < -180) dh += 360;
    return { hex, after: `#${after.getHexString()}`, dh, keep: satOf(after) / satOf(before) };
  });
  const worstHue = shifts.reduce((a, b) => (Math.abs(b.dh) > Math.abs(a.dh) ? b : a));
  const worstSat = shifts.reduce((a, b) => (b.keep < a.keep ? b : a));
  const detail = shifts
    .map((s) => `${s.hex}→${s.after} Δh ${s.dh.toFixed(1)}° sat×${s.keep.toFixed(2)}`)
    .join(' / ');
  // demo 一次都沒有把顏色送過全螢幕變換,所以「送過去之後還是同一個顏色」是
  // 唯一站得住的門檻。留 2° / 3% 給紙纖維那道灰階乘法(它只讀 .r,不動色相)。
  check('地面的顏色送過 paper pass 之後色相沒有被挪走(demo 根本沒有這道)',
    Math.abs(worstHue.dh) <= 2, detail);
  check('… 飽和度也沒有被再降一次(paperify 已經在色票裡降過一次了)',
    worstSat.keep >= 0.97, detail);
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. 地面為什麼會閃
// ═══════════════════════════════════════════════════════════════════════════
//
// 踏面的 uv 是**原始場景公尺**(`quantized-terrain.ts` 的 `pushTopTri` 直接推
// `ax, az`),而場景原點是路線的第一個點且不再重設 —— 所以騎到二十公里處時,
// 那個 varying 的量級是 20000 / 貼圖公尺數。float32 在那個量級的 eps 已經比
// 「相鄰兩個像素之間的 uv 差」還大,於是所有靠**螢幕空間有限差分**的東西
// (mip 選階、bumpMap 的 dHdxy)拿到的是量化雜訊,而不是導數。
//
// bumpMap 是其中最致命的一個:踏面是**平的**,整片地板的 dot(N,L) 是同一個值,
// 而 toon 的 gradientMap 是三階硬階梯 —— 法線被雜訊推一下就整片跨階。
// demo 一張 bumpMap 都沒有。

console.log('\n[地面的閃爍:demo 沒有的東西]');

const demoBumpHits = (CODE.match(/\bbump(Map|Scale)\b/g) ?? []).length;
check('demo 從頭到尾沒有任何 bumpMap / bumpScale', demoBumpHits === 0, `${demoBumpHits} 處`);

{
  const terrainMat = style.createTerrainMaterial() as THREE.MeshToonMaterial;
  check('所以踏面的材質也不可以掛 bumpMap',
    terrainMat.bumpMap === null,
    terrainMat.bumpMap ? `bumpScale=${terrainMat.bumpScale}` : 'null');
  // 貼圖過濾:demo 的板子邊長 130、霧 260–780;gameview 串流的是 45 km 的路線,
  // 地板一路貼到霧的盡頭。demo 仲裁不了這件事(plan/demo-gaps.md §7),但
  // 「各向異性 = 1」在掠角地面上就是抖動的定義。
  const map = terrainMat.map as THREE.Texture | null;
  check('踏面貼圖有開各向異性過濾(掠角地面 = 1 就是抖動)',
    !!map && map.anisotropy > 1, map ? `anisotropy=${map.anisotropy}` : 'no map');
  terrainMat.dispose();
}

{
  // uv 的連續性:兩塊相鄰的網格,共用的那條世界座標上的 uv 必須一致。
  // (這條**應該通過** —— 接縫不是這次的病因,量它是為了把它排除掉。)
  const O = 100;
  const a = buildQuantizedCorridorGeometry(
    corridorGrid(O, () => 0, 0, 0) as never, style, O);
  const b = buildQuantizedCorridorGeometry(
    corridorGrid(O, () => 0, 0, 150) as never, style, O);
  const uvAt = (d: typeof a, x: number, z: number): [number, number] | null => {
    for (let i = 0; i < d.positions.length / 3; i++) {
      if (Math.abs(d.positions[i * 3] - x) < 1e-6 && Math.abs(d.positions[i * 3 + 2] - z) < 1e-6) {
        return [d.uvs[i * 2], d.uvs[i * 2 + 1]];
      }
    }
    return null;
  };
  const ua = uvAt(a, 60, 150);
  const ub = uvAt(b, 60, 150);
  check('跨 chunk 取樣同一個世界座標,uv 連續(接縫不是病因)',
    !!ua && !!ub && ua[0] === ub[0] && ua[1] === ub[1],
    `${ua?.join(',')} vs ${ub?.join(',')}`);
  // 反向對照,同一支取樣器:換一個**不同**的世界座標,uv 必須不一樣。少了這條,
  // 一個永遠回同一組 uv(或永遠回 null)的取樣器也照樣通過上面那條。
  const uc = uvAt(b, 60, 180);
  check('反向對照:換一個世界座標,uv 就不一樣了(取樣器真的讀得到東西)',
    !!ub && !!uc && (ub[0] !== uc[0] || ub[1] !== uc[1]),
    `${ub?.join(',')} vs ${uc?.join(',')}`);
}

{
  // 為什麼「螢幕空間有限差分」在這個世界的地板上特別危險,量出來。
  //
  // 踏面的 uv 是原始場景公尺,而場景原點是路線的第一個點、不再重設,所以那個
  // varying 的量級跟騎乘距離同階。float32 的 ULP 隨量級成長,而「相鄰兩個像素
  // 之間的 uv 差」不會 —— 騎士正前方三公尺的地面,55° FOV / 1920 px 寬,一個像
  // 素約 1.6 mm。兩條線遲早會交叉,交叉之後 `dFdx` 拿到的是量化雜訊。
  //
  // 兩條斷言走**同一段算式**,一條要它還沒塌、一條要它塌了 —— 一支永遠回同一個
  // 答案的算式過不了這兩條,而且第二條順便把極限印出來。
  const PIXEL_M = 0.0016;
  const mat = style.createTerrainMaterial() as THREE.MeshToonMaterial;
  const perTile = 1 / ((mat.map as THREE.Texture).repeat.x);
  mat.dispose();
  const d = Math.fround(PIXEL_M / perTile);
  const collapsedAt = (rideM: number): boolean => {
    const uv = Math.fround(rideM / perTile);
    return Math.fround(uv + d) === uv;
  };
  /** 第一個讓相鄰像素的 uv 差整個消失的騎乘距離,以 100 m 為刻度。 */
  let cliff = 0;
  for (let m = 100; m <= 400000; m += 100) {
    if (collapsedAt(m)) { cliff = m; break; }
  }
  check('騎到 20 km 時,踏面 uv 的相鄰像素差還沒被 float32 完全吃掉',
    !collapsedAt(20000),
    `${perTile} m/tile,相鄰像素 Δuv=${d.toExponential(2)},uv(20 km)=${Math.fround(20000 / perTile)}`);
  check('反向對照:同一段算式在夠長的路線上真的會塌 —— 而且極限就在這裡',
    cliff > 0 && collapsedAt(cliff), `臨界距離 ≈ ${(cliff / 1000).toFixed(1)} km`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. 上色 ↔ 素紙板(demo 有、gameview 缺的那半)
// ═══════════════════════════════════════════════════════════════════════════
//
// demo 從第一版就有這顆按鈕(`?paint=0`),機制是 `swappable(mat, plain, painted)`
// 登記 + `applyPaintMode()` 整組換。「素」不是灰階、也不是塗成同一個棕色:是
// **還沒上色的稿** —— 每一塊填色換成牛皮紙 / 平塗的原色,墨線與天空不動。

console.log('\n[上色 ↔ 素紙板 vs demo]');

check('demo 的開場狀態是「上色」(paintOn = true)',
  /\blet paintOn = true\b/.test(CODE), sliceLine(SRC, '  let paintOn = true').trim());
check('demo 用 swappable() 登記雙態材質,而且不只一兩處',
  (CODE.match(/\bswappable\(/g) ?? []).length > 10,
  `${(CODE.match(/\bswappable\(/g) ?? []).length} 處`);

/** demo 的 plateTopMats:兩態各是什麼,執行出來而不是讀出來。 */
const demoPlateTop = (() => {
  const d = runDemo([
    'const swaps = [];',
    'function swappable(mat, plain, painted) { swaps.push({ plain, painted }); return mat; }',
    'const gradientMap = null;',
    sliceFn(SRC, 'toon'),
    'const kraftTop = "kraftTop"; const washBody = "washBody";',
    'const rep = (tex) => tex;',
    'const washColor = (hex) => hex;',
    sliceStmt(SRC, '  const TERRAIN_BAND = ['),
    sliceLine(SRC, '  const PLATE_UV = '),
    sliceStmt(SRC, '  const plateTopMats = '),
  ], 'return { swaps };') as unknown as {
    swaps: { plain: { map: string; color: string }; painted: { map: string; color: string } }[];
  };
  return d.swaps;
})();
check('demo 的等高線踏面是六階雙態材質', demoPlateTop.length === 6,
  `${demoPlateTop.length} 階`);
check('素紙板態的踏面 = 牛皮紙(不是分層色)',
  demoPlateTop.every((s) => s.plain.map === 'kraftTop')
  && new Set(demoPlateTop.map((s) => s.plain.color)).size === 2,
  demoPlateTop.map((s) => s.plain.color).join(' '));

const paperStyleParams = style.params as unknown as Record<string, unknown>;
check('gameview 的 paper 策略認得 paintEnabled(applyWorldOptions 會寫進來的那個鍵)',
  typeof paperStyleParams.paintEnabled === 'boolean',
  `params.paintEnabled = ${String(paperStyleParams.paintEnabled)}`);

{
  // 真的關掉它再問一次同一個問題:地面的踏面色必須整組換成牛皮紙色,而且要跟
  // demo 素態的那兩個色**一模一樣**。
  const painted = drawn.slice();
  paperStyleParams.paintEnabled = false;
  const plain = topColours(corridorGrid(GROUND_ORIGIN, (c) => Math.min(5, c)), GROUND_ORIGIN);
  const plainAll: string[] = [];
  for (let k = 0; k < 6; k++) plainAll.push(`#${style.bandAt!(k * LAYER).top.getHexString()}`);
  paperStyleParams.paintEnabled = true;
  const back = topColours(corridorGrid(GROUND_ORIGIN, (c) => Math.min(5, c)), GROUND_ORIGIN);

  check('關掉上色,地面畫出來的顏色真的變了', plain.join(' ') !== painted.join(' '),
    `上色 ${painted.join(' ')} / 素紙板 ${plain.join(' ')}`);
  check('素紙板的六階 = demo plateTopMats 素態的那兩個牛皮紙色,交替',
    plainAll.join(' ') === demoPlateTop.map((s) => s.plain.color.toLowerCase()).join(' '),
    `demo ${demoPlateTop.map((s) => s.plain.color).join(' ')} vs ours ${plainAll.join(' ')}`);
  check('打開回來又是原本那三階(切換是可逆的)', back.join(' ') === painted.join(' '),
    back.join(' '));
}

{
  // 剪紙樹:港版原本只烘了 demo 的 `painted = false` 那一張(底紙 #5aa646、
  // 深色 #33632f、樹幹 #8a5a2b),而 demo 開場是**上色**態。兩態的差別逐筆比。
  //
  // ⚠ 順序很重要:先跑**我們的**,把畫布的快照收起來,再跑 demo 的。反過來的話
  // 下面那個 128 底紙的集合裡會混進 demo 自己畫的那兩張,兩條斷言就會因為在跟
  // demo 自己比而永遠通過。

  /** 港版的樹貼圖是一張圖集(兩個 seed 的變體 `drawImage` 並排),所以圖集自己
   *  的 trace 只有兩筆 —— 要比的是**這一態建出來的每一張畫布**。
   *  每一態開一個全新的策略:貼圖快取是策略自己的 Map,同一個策略問第二次只會
   *  拿到第一次那張,於是「兩態一樣」會因為錯的理由通過。 */
  const treeTrace = async (paint: boolean): Promise<string> => {
    const s = await createTerrainStyleStrategy('paper');
    (s.params as unknown as Record<string, unknown>).paintEnabled = paint;
    const mark = canvases.length;
    const m = s.createTreeMaterial() as THREE.MeshToonMaterial;
    const made = canvases.slice(mark).map((c) => c.trace.join('|')).join('##');
    m.dispose();
    s.dispose();
    return made;
  };
  const oursPaint = await treeTrace(true);
  const oursPlain = await treeTrace(false);
  /** 這個 process 到目前為止,**我們**畫過的每一張 128 底紙(treePaper)。 */
  const ourPapers = new Set(canvases
    .filter((c) => c.width === 128 && c.height === 128)
    .map((c) => c.trace.join('|')));

  const demoRun = (painted: boolean) => {
    const mark = canvases.length;
    const d = runDemo([
      sliceFn(SRC, 'mulberry32'),
      sliceFn(SRC, 'wrap9'),
      sliceFn(SRC, 'rgbOf'),
      sliceFn(SRC, 'tint'),
      sliceLine(SRC, '  const GS = '),
      sliceLine(SRC, '  const BOARD = '),
      sliceFn(SRC, 'gouacheCanvas'),
      sliceStmt(SRC, '  const PAINT = {'),
      'const treePaperCache = new Map();',
      sliceFn(SRC, 'treePaper'),
      sliceFn(SRC, 'treeCutoutTexture'),
    ], `return { c: treeCutoutTexture('round', ${painted}, ${0x3a01}) };`) as unknown as
      { c: { image: RecCanvas } };
    return {
      tile: (d.c.image as RecCanvas).trace.join('|'),
      // 底紙畫在**自己的**畫布上,所以它不在上面那串筆觸裡。不比它的話,底紙
      // 從 gouache 換成美術紙都不會有人發現(剪刀那一圈一筆不差)。
      paper: canvases.slice(mark)
        .filter((c) => c.width === 128 && c.height === 128)
        .map((c) => c.trace.join('|'))[0] ?? '',
    };
  };
  const demoPlainRun = demoRun(false);
  const demoPaintRun = demoRun(true);

  check('demo 的剪紙樹兩態真的畫得不一樣(剪刀那一圈)',
    demoPlainRun.tile !== demoPaintRun.tile,
    `${demoPlainRun.tile.length} vs ${demoPaintRun.tile.length} chars`);
  check('demo 的剪紙樹兩態底紙也不一樣(美術紙 vs 廣告顏料)',
    !!demoPlainRun.paper && !!demoPaintRun.paper
    && demoPlainRun.paper !== demoPaintRun.paper,
    `${demoPlainRun.paper.length} vs ${demoPaintRun.paper.length} chars`);

  check('gameview 的剪紙樹也有兩態(而且各建各的畫布)',
    oursPaint !== oursPlain && oursPaint.length > 0 && oursPlain.length > 0,
    `${oursPaint.length} vs ${oursPlain.length} chars`);
  check('上色態的剪刀輪廓 = demo 的 painted = true 那一張',
    oursPaint.includes(demoPaintRun.tile) && !oursPaint.includes(demoPlainRun.tile));
  check('素紙板態的剪刀輪廓 = demo 的 painted = false 那一張',
    oursPlain.includes(demoPlainRun.tile) && !oursPlain.includes(demoPaintRun.tile));
  check('上色態的底紙 = demo 的 gouache 那張,逐筆',
    ourPapers.has(demoPaintRun.paper),
    `${demoPaintRun.paper.length} chars,我們畫過 ${ourPapers.size} 張 128 底紙`);
  check('素紙板態的底紙 = demo 的美術紙那張,逐筆',
    ourPapers.has(demoPlainRun.paper),
    `${demoPlainRun.paper.length} chars`);
}

postPass.dispose?.();
cardGeo.dispose();
style.dispose();
