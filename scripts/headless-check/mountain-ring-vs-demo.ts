/**
 * `[mountain ring vs demo]` — 遠山環:上色的軸、電子世界的環、以及陰影旗標。
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/mountain-ring-vs-demo.ts
 *
 * ## 先講一件跟預期相反的事:遠山環**沒有**高度分層,而且那是三個 demo 一致的決定
 *
 * 「地形分層色設是非常重要的」對**走廊**成立(`terrain-band-vs-demo.ts`,50 條
 * 斷言),對**環**不成立 —— 而且不是漏做,是三個 demo 各自寫下理由後拿掉的:
 *
 *  - `plan/paper-town-demo.html` 確實有一個逐板套 `TERRAIN_BAND`、含手抖乘數
 *    `0.93 + rng() * 0.14` 的環 —— 那是 `contourRing()`,而它是**死碼**。demo 在
 *    它旁邊寫了為什麼:
 *
 *    > 這裡本來是 contourRing():等高線疊層的瓦楞紙山。錯的不是做法,是**位置**。
 *    > 等高線疊層是**模型本體**的語言 […] 但遠山不是模型的一部分 —— 它是**背板上
 *    > 刷的一道墨**。[…] 把疊層搬到天邊,遠看只會像一圈被美工刀切開的紙箱立在那裡。
 *
 *    活著的是 `inkRidge()`:一圈平塗的墨 + 一條墨線,兩個平色,沒有色帶。
 *  - `blockMountainRing()`(積木)是一片 `toonShared(color)`,一個平色。demo 自己
 *    的 `bandAt()` 就在同一個檔案裡,它一次都沒被叫。
 *  - `heatsinkRing()`(電子)整圈鰭片共用一個 `finMat`,底筒共用一個 `finBaseMat`。
 *
 * 所以環的顏色軸**是「哪一圈」不是「多高」**:近圈濃、遠圈淡(空氣透視)。這支檢查
 * 把那條規則、以及「不分層」這個決定本身,都釘下來 —— 不然下一個人會照著走廊的做法
 * 把色帶接上去,而那正是 demo 拒絕過的東西(CUSTOM_WORLD_INSTRUCTIONS §0.0 第 7 點:
 * **刻意的不一致也要被斷言下來**)。
 *
 * ## 這支補的洞
 *
 * `diorama.ts` 的 `[mountain ring vs demo/paper]` 與 `/plastic` 已經逐三角形比過那
 * 兩個世界。**電子世界一條都沒有** —— 這裡補上,而且是**鰭片對鰭片**:執行 demo 的
 * `heatsinkRing`,把它吐出來的 instance 矩陣跟移植的逐片比,不是抄常數。
 *
 * ## 「遠圈從近圈的縫裡透出來」是可以量的,但**不是**用「兩圈都看得到的方位角比例」
 *
 * demo 選鰭片是有理由的:「散熱片本來就是一片一片、片與片之間有縫的,所以遠一圈的
 * 山會自然從近一圈的縫裡透出來」。第一版想量的是「有多少比例的方位角同時看得到近圈
 * 與遠圈」—— **那個數字分不出來**,實測簾幕 60.7% / 鰭片 63.4%:簾幕的遠圈本來就
 * 從近圈**頂上**露出來(§3.6 就是為了這個),所以「兩圈都看得到」對簾幕早就成立。
 *
 * 分得出來的是**遠圈被切成幾塊**:從騎士眼高沿方位角掃一圈,數遠圈可見區間的個數。
 * 簾幕是 4 塊(兩條剖面的平頂互相高低而已),鰭片是 151 塊 —— 一片縫一塊,數量級
 * 就是近圈的鰭片數。那正是「從縫裡透出來」的定義,而且不需要任何門檻參數。
 *
 * ## 陰影旗標
 *
 * 電子 demo 的 `inst.castShadow = true` / `esdMat.receiveShadow = true`(以及瓦楞紙
 * demo 的 `desk.receiveShadow = true`)在移植裡都沒有宣告。**那是記錄在案的偏離,
 * 理由是量出來的**:陰影框的外接半徑只有 ~526 m,而環在 1700 / 2600 m。換成
 * InstancedMesh 之後帳單變了(308 個 instance 而不是 322 個頂點),結論沒變,而且
 * 兩邊都量在最後一節。
 */
import { readFileSync } from 'node:fs';

// ── Canvas stub ──────────────────────────────────────────────────────────────
// 共用的那一份。自己裝 `globalThis.document` 會讓模組層的貼圖快取落在別人的畫布上
// (被咬過兩次,經過寫在 `recording-canvas.ts`)。電子世界的 horizon material 會畫
// 防靜電袋貼圖,所以這裡真的需要它。
const { installRecordingCanvas } = await import('./recording-canvas.ts');
installRecordingCanvas();

const THREE = await import('three');
const { createTerrainStyleStrategy } = await import('@/game/terrain/terrain-style-strategy');
type Strategy = Awaited<ReturnType<typeof createTerrainStyleStrategy>>;
const { MountainRing } = await import('@/game/terrain/mountain-ring');
const {
  SHADOW_HALF_EXTENT, SHADOW_NEAR, SHADOW_FAR,
} = await import('@/game/terrain/day-night-lighting');
const { ACRYLIC_CASE_RADIUS } = await import('@/game/terrain/acrylic-case');

let failures = 0;
/**
 * 執行過的斷言數。印出來是有原因的:這個檔案有幾條斷言在前一條失敗之後會被
 * `continue` 跳過(例如「環根本不是 InstancedMesh」),而**跳過的斷言不會留下任何
 * 一行輸出** —— 「11 個失敗」看起來像小事,其實有 36 條根本沒跑到
 * (MEMORY:check3d-aborts-on-throw 的同一個形狀)。看 ✓ 的數量,不要只看 ✗。
 */
let executed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  executed++;
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
export function failureCount(): number { return failures; }

// ── Demo slicing ─────────────────────────────────────────────────────────────

/** demo 自己的那段 script(最後一個 `<script>`),不含內嵌的 three.js bundle。 */
function demoScript(file: string): string {
  const src = readFileSync(file, 'utf8');
  const at = src.lastIndexOf('<script>');
  if (at < 0) throw new Error(`no demo script in ${file}`);
  return src.slice(at);
}

/** `function name(` 到配對的 `}`。 */
function sliceFn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`cannot slice ${name} out of the demo`);
  let i = src.indexOf('{', at);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

/** 從 `head` 到 `tail` 結尾(含)的一整段。 */
function sliceBlock(src: string, head: string, tail: string): string {
  const a = src.indexOf(head);
  if (a < 0) throw new Error(`cannot find ${JSON.stringify(head)}`);
  const b = src.indexOf(tail, a);
  if (b < 0) throw new Error(`cannot find ${JSON.stringify(tail)} after it`);
  return src.slice(a, b + tail.length);
}

/** 從 `head` 到它所屬敘述結尾(括號深度 0 的第一個 `;`)。 */
function sliceStatement(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`cannot find ${JSON.stringify(head)}`);
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const ch = src[i];
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    else if (ch === ']' || ch === '}' || ch === ')') depth--;
    else if (ch === ';' && depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unterminated ${JSON.stringify(head)}`);
}

/** `const mountX = fn({ … });` 這種多行呼叫的完整敘述。 */
function sliceCall(src: string, head: string): string {
  const a = src.indexOf(head);
  if (a < 0) throw new Error(`cannot find ${JSON.stringify(head)}`);
  const b = src.indexOf('});', a);
  if (b < 0) throw new Error(`unterminated ${JSON.stringify(head)}`);
  return src.slice(a, b + 3);
}

const SCRIPT = {
  paper: demoScript('plan/paper-town-demo.html'),
  plastic: demoScript('plan/plastic-town-demo.html'),
  circuit: demoScript('plan/circuit-town-demo.html'),
};
type World = keyof typeof SCRIPT;
const WORLDS = ['paper', 'plastic', 'circuit'] as const;

/** demo 的調色盤常數(`  key: '#rrggbb',`)。 */
function demoPaletteHex(src: string, key: string): string {
  const m = src.match(new RegExp(`\\b${key}:\\s*'(#[0-9a-fA-F]{6})'`));
  if (!m) throw new Error(`demo palette has no ${key}`);
  return m[1].slice(1).toLowerCase();
}

/** 一個字串在來源裡出現幾次。 */
function count(src: string, needle: string): number {
  let n = 0;
  for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) n++;
  return n;
}

/**
 * `name(` 的**呼叫點**數:扣掉宣告,也扣掉註解裡的提及。
 *
 * 註解那一半是必要的:paper demo 就在 `inkRidge` 上面寫了「這裡本來是
 * contourRing()」,純字串比對會把那句話算成一個呼叫點,於是「死碼」永遠驗不出來。
 */
function callSites(src: string, name: string): number {
  let n = 0;
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    // 箭頭函式的宣告(`const bandAt = (y) => …`)本來就不含 `bandAt(`,所以只有
    // `function name(` 這一種宣告要扣。
    n += count(line, `${name}(`) - count(line, `function ${name}(`);
  }
  return n;
}

// ── 幾何 / 顏色小工具 ─────────────────────────────────────────────────────────

/** 場景裡的 `mountainRing/*`,以去掉前綴的名字為 key。 */
function ringMeshesByName(scene: THREE.Scene): Map<string, THREE.Mesh> {
  const out = new Map<string, THREE.Mesh>();
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.name.startsWith('mountainRing/')) {
      out.set(o.name.slice('mountainRing/'.length), o as THREE.Mesh);
    }
  });
  return out;
}

/** 這一片面朝環心的比例。騎手在環的裡面,所以應該是 1。 */
function inwardFaceFraction(g: THREE.BufferGeometry): number {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  if (!idx) return 0;
  const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3();
  const e1 = new THREE.Vector3(); const e2 = new THREE.Vector3(); const n = new THREE.Vector3();
  let inward = 0; let total = 0;
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(pos, idx.getX(i));
    b.fromBufferAttribute(pos, idx.getX(i + 1));
    c.fromBufferAttribute(pos, idx.getX(i + 2));
    e1.subVectors(b, a); e2.subVectors(c, a); n.crossVectors(e1, e2);
    if (n.lengthSq() < 1e-12) continue;
    // 面心的水平外法向 = (x, 0, z);朝內 = 兩者內積為負。
    const cx = (a.x + b.x + c.x) / 3; const cz = (a.z + b.z + c.z) / 3;
    total++;
    if (n.x * cx + n.z * cz < 0) inward++;
  }
  return total === 0 ? 0 : inward / total;
}

/** 反轉每個三角形的索引順序 —— 給繞序斷言的反向對照用。 */
function reversedIndex(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.clone();
  const idx = out.getIndex();
  if (!idx) throw new Error('no index buffer');
  for (let i = 0; i < idx.count; i += 3) {
    const t = idx.getX(i); idx.setX(i, idx.getX(i + 2)); idx.setX(i + 2, t);
  }
  return out;
}

/**
 * 一片 mesh 攤成**有順序的世界座標三角形串流**(每個三角形 9 個 float,
 * InstancedMesh 逐 instance 展開)。
 *
 * 為什麼不是包圍盒、不是三角形數:兩者對「索引整個翻轉」完全無感(上一輪證明過),
 * 而繞序翻轉在 CPU 光柵器裡看不出來、在 WebGL 裡會讓整個地平線消失。串流保留順序,
 * 所以繞序、頂點順序、instance 順序全都在裡面。
 */
function worldTriangles(mesh: THREE.Mesh, applyWorld = true): number[] {
  mesh.updateMatrixWorld(true);
  const pos = mesh.geometry.getAttribute('position');
  const idx = mesh.geometry.getIndex();
  const n = idx ? idx.count : pos.count;
  const inst = mesh as unknown as THREE.InstancedMesh;
  const count = inst.isInstancedMesh ? inst.count : 1;
  const out: number[] = [];
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  for (let c = 0; c < count; c++) {
    if (inst.isInstancedMesh) inst.getMatrixAt(c, m); else m.identity();
    if (applyWorld) m.premultiply(mesh.matrixWorld);
    for (let t = 0; t < n; t++) {
      v.fromBufferAttribute(pos as THREE.BufferAttribute, idx ? idx.getX(t) : t).applyMatrix4(m);
      out.push(v.x, v.y, v.z);
    }
  }
  return out;
}

/**
 * 這一圈在某個方位角上的**稜線高度**(局部座標,騎士在原點)。
 *
 * 簾幕跟鰭片同一把尺:兩者都是「射線所在的鉛直半平面切到的最高點」。有了它,環的
 * **高度尺度**就可以從建出來的東西解回來(`(top_i − top_j) / (p_i − p_j)`),不用
 * 分兩條路,也不用把 NEAR_/FAR_MAX_HEIGHT 抄進這個檔案。
 */
function crestAt(tris: number[], az: number): number {
  const dx = Math.cos(az); const dz = Math.sin(az);
  const nx = -dz; const nz = dx;
  let hi = -Infinity;
  for (let t = 0; t < tris.length; t += 9) {
    const s = [0, 0, 0];
    for (let k = 0; k < 3; k++) s[k] = tris[t + k * 3] * nx + tris[t + k * 3 + 2] * nz;
    for (let k = 0; k < 3; k++) {
      const k2 = (k + 1) % 3;
      if ((s[k] <= 0 && s[k2] > 0) || (s[k] > 0 && s[k2] <= 0)) {
        const f = s[k] / (s[k] - s[k2]);
        const px = tris[t + k * 3] + f * (tris[t + k2 * 3] - tris[t + k * 3]);
        const py = tris[t + k * 3 + 1] + f * (tris[t + k2 * 3 + 1] - tris[t + k * 3 + 1]);
        const pz = tris[t + k * 3 + 2] + f * (tris[t + k2 * 3 + 2] - tris[t + k * 3 + 2]);
        if (px * dx + pz * dz > 0 && py > hi) hi = py;
      }
    }
  }
  return hi;
}

/**
 * 這一圈的方位角解析度 —— 簾幕是段數,鰭片是鰭片數。剖面的第 i 格在兩種造型裡都
 * 剛好落在方位角 `2π i / N` 上,所以有了 N 就能把剖面對回稜線。
 */
function ringResolution(mesh: THREE.Mesh): number {
  const inst = mesh as unknown as THREE.InstancedMesh;
  return inst.isInstancedMesh ? inst.count : mesh.geometry.getAttribute('position').count / 2 - 1;
}

/** 一圈環(簾幕的 wash/ridgeLine,或鰭片的 fins + 底筒)的三角形串流。 */
function layerTriangles(meshes: Map<string, THREE.Mesh>, layer: 'near' | 'far'): number[] {
  const out: number[] = [];
  for (const [name, m] of meshes) {
    if (name === 'disc' || !name.startsWith(layer)) continue;
    out.push(...worldTriangles(m));
  }
  return out;
}

/**
 * 幾何快照:每一片的**局部**座標三角形串流(含 instance 矩陣),用來比「有沒有變」。
 *
 * 局部而不是世界,因為 `update()` 本來就會搬 `mesh.position` —— 這條要問的是
 * 「頂點/矩陣有沒有被動到」,不是「物件有沒有移動」。
 */
function positionSnapshot(scene: THREE.Scene): string {
  return [...ringMeshesByName(scene)]
    .map(([name, m]) => `${name}:${worldTriangles(m, false).join(',')}`)
    .join('|');
}

/**
 * 這片幾何能畫出**幾個顏色**。1 = 「一片幾何一個平色」,也就是環不吃高度分層。
 *
 * 逐頂點色、逐 instance 色、多材質 + group,三種載體全部數進來 —— 換成鰭片之後
 * `instanceColor` 是新的一種,而 `BoxGeometry` 本來就自帶 6 個 group(給六材質用的),
 * 那些 group 在單一材質下畫不出第二個顏色,所以只有配上材質陣列才算數。
 */
function colourCarriers(mesh: THREE.Mesh): string[] {
  const bad: string[] = [];
  const g = mesh.geometry;
  const mat = mesh.material as THREE.Material & { vertexColors?: boolean };
  if (g.getAttribute('color')) bad.push('color attribute');
  if (Array.isArray(mesh.material)) {
    bad.push(`${mesh.material.length} 個材質 × ${g.groups.length} 個 group`);
  }
  if (!Array.isArray(mesh.material) && mat.vertexColors) bad.push('vertexColors=true');
  const inst = mesh as unknown as THREE.InstancedMesh;
  if (inst.isInstancedMesh && inst.instanceColor) bad.push('instanceColor');
  return bad;
}

interface Hsl { h: number; s: number; l: number }
function hslOf(hex: number): Hsl {
  const out = { h: 0, s: 0, l: 0 };
  new THREE.Color(hex).getHSL(out);
  return { h: out.h * 360, s: out.s, l: out.l };
}
/** 兩個色相的環狀差,度。 */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** 平頂比例:相鄰兩格同高的比例。連續剖面 ≈ 0,分階/分組剖面很高。 */
function flatFraction(p: number[]): number {
  let same = 0;
  for (let i = 1; i < p.length; i++) if (p[i] === p[i - 1]) same++;
  return same / (p.length - 1);
}

/** 連續同值的段長。 */
function runLengths(p: number[]): number[] {
  const runs: number[] = [];
  let c = 1;
  for (let i = 1; i < p.length; i++) {
    if (p[i] === p[i - 1]) c++; else { runs.push(c); c = 1; }
  }
  runs.push(c);
  return runs;
}

/** `<ident>.castShadow|receiveShadow = <rhs>;`,依出現順序。 */
function shadowAssignments(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/([A-Za-z0-9_$]+)\.(castShadow|receiveShadow)\s*=\s*([^;]+);/g)) {
    out.push(`${m[1]}.${m[2]}=${m[3].trim()}`);
  }
  return out;
}

// ── 「遠圈從近圈的縫裡透出來」的量法 ────────────────────────────────────────
//
// 環永遠以騎士為心,所以從眼睛射出的每一條射線都是從圓心往外。把一條射線寫成
// (方位角 az, 仰角 el),近圈的東西一定比遠圈近(近圈外緣 < 遠圈內緣,下面有斷言),
// 所以「遠圈在這個方向看不看得到」= 遠圈蓋到的仰角區間扣掉近圈蓋到的還剩不剩。
//
// 三角形只跟自己方位角範圍內的那幾條射線有關,所以先按方位角分桶,不然 3600 條射線
// × 3952 個三角形要跑很久。

const TWO_PI = Math.PI * 2;
/** 方位角取樣數。近圈鰭片間距 360/168 = 2.14°,0.1° 一格 → 一條縫約 10 格。 */
const AZ_SAMPLES = 3600;
/** 小於這個仰角(弧度,≈0.011°)的可見縫當成浮點雜訊。 */
const VISIBLE_EPS = 2e-4;

interface AzimuthBuckets { tris: number[]; buckets: number[][] }

/** 三角形按**自己的方位角跨度**分桶。 */
function bucketByAzimuth(tris: number[], n: number): AzimuthBuckets {
  const buckets: number[][] = Array.from({ length: n }, () => []);
  const step = TWO_PI / n;
  for (let t = 0; t < tris.length; t += 9) {
    const ang: number[] = [];
    for (let k = 0; k < 3; k++) {
      let a = Math.atan2(tris[t + k * 3 + 2], tris[t + k * 3]);
      if (a < 0) a += TWO_PI;
      ang.push(a);
    }
    ang.sort((a, b) => a - b);
    // 三個角度的**最小覆蓋弧** = 全圓扣掉最大的那個間隙。
    let bestGap = -1; let bestAt = 0;
    for (let i = 0; i < 3; i++) {
      const g = (ang[(i + 1) % 3] - ang[i] + TWO_PI) % TWO_PI;
      if (g > bestGap) { bestGap = g; bestAt = i; }
    }
    const start = ang[(bestAt + 1) % 3];
    const j1 = Math.ceil((start + TWO_PI - bestGap) / step);
    for (let j = Math.floor(start / step); j <= j1; j++) buckets[((j % n) + n) % n].push(t);
  }
  return { tris, buckets };
}

/** 這一堆三角形在某個方位角上蓋住的仰角區間(未合併)。 */
function elevationSpans(b: AzimuthBuckets, j: number, az: number, eyeY: number): [number, number][] {
  const dx = Math.cos(az); const dz = Math.sin(az);
  const nx = -dz; const nz = dx;          // 射線所在鉛直半平面的水平法向
  const out: [number, number][] = [];
  for (const t of b.buckets[j]) {
    const s = [0, 0, 0];
    for (let k = 0; k < 3; k++) s[k] = b.tris[t + k * 3] * nx + b.tris[t + k * 3 + 2] * nz;
    let lo = Infinity; let hi = -Infinity; let hits = 0; let behind = false;
    for (let k = 0; k < 3; k++) {
      const k2 = (k + 1) % 3;
      if ((s[k] <= 0 && s[k2] > 0) || (s[k] > 0 && s[k2] <= 0)) {
        const f = s[k] / (s[k] - s[k2]);
        const px = b.tris[t + k * 3] + f * (b.tris[t + k2 * 3] - b.tris[t + k * 3]);
        const py = b.tris[t + k * 3 + 1] + f * (b.tris[t + k2 * 3 + 1] - b.tris[t + k * 3 + 1]);
        const pz = b.tris[t + k * 3 + 2] + f * (b.tris[t + k2 * 3 + 2] - b.tris[t + k * 3 + 2]);
        const r = px * dx + pz * dz;
        if (r <= 0) { behind = true; break; }   // 射線的反方向,不算
        const e = Math.atan2(py - eyeY, r);
        if (e < lo) lo = e;
        if (e > hi) hi = e;
        hits++;
      }
    }
    if (!behind && hits >= 2) out.push([lo, hi]);
  }
  return out;
}

/** 合併成互斥、遞增的區間。 */
function mergeSpans(spans: [number, number][]): [number, number][] {
  if (!spans.length) return [];
  const s = spans.map((x) => [...x] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [s[0]];
  for (let i = 1; i < s.length; i++) {
    const last = out[out.length - 1];
    if (s[i][0] <= last[1]) last[1] = Math.max(last[1], s[i][1]);
    else out.push(s[i]);
  }
  return out;
}

/** `spans` 扣掉 `blockers` 之後剩下的總長度。 */
function uncoveredLength(spans: [number, number][], blockers: [number, number][]): number {
  let total = 0;
  for (const [lo, hi] of spans) {
    let cur = lo;
    for (const [bl, bh] of blockers) {
      if (bh <= cur) continue;
      if (bl >= hi) break;
      if (bl > cur) total += bl - cur;
      cur = Math.max(cur, bh);
      if (cur >= hi) break;
    }
    if (cur < hi) total += hi - cur;
  }
  return total;
}

interface RingVisibility {
  /** 遠圈可見的方位角比例。**這個數字分不出簾幕跟鰭片**,留著就是為了說明它分不出來。 */
  anyFraction: number;
  /** 遠圈被切成幾個互不相連的方位角區間 —— 一片縫一塊。 */
  pieces: number;
  /** 遠圈可見的立體角,平方度。 */
  farSolidDeg2: number;
  /** 近圈自己佔的立體角,平方度(給上面那個當分母看)。 */
  nearSolidDeg2: number;
}

/** 從騎士眼高掃一圈,量遠圈到底怎麼露出來。 */
function ringVisibility(
  meshes: Map<string, THREE.Mesh>, eyeY: number, n = AZ_SAMPLES,
): RingVisibility {
  const bn = bucketByAzimuth(layerTriangles(meshes, 'near'), n);
  const bf = bucketByAzimuth(layerTriangles(meshes, 'far'), n);
  const dPhi = TWO_PI / n;
  const visible: boolean[] = [];
  let any = 0; let farSolid = 0; let nearSolid = 0;
  for (let j = 0; j < n; j++) {
    const az = (j / n) * TWO_PI;
    const ns = mergeSpans(elevationSpans(bn, j, az, eyeY));
    const fs = mergeSpans(elevationSpans(bf, j, az, eyeY));
    const open = uncoveredLength(fs, ns);
    visible.push(open > VISIBLE_EPS);
    if (open > VISIBLE_EPS) any++;
    farSolid += open * dPhi;
    for (const [lo, hi] of ns) nearSolid += (hi - lo) * dPhi;
  }
  let pieces = 0;
  for (let j = 0; j < n; j++) if (visible[j] && !visible[(j - 1 + n) % n]) pieces++;
  // 整圈都看得到 → 沒有任何邊界,那是「一塊」。
  if (pieces === 0 && visible[0]) pieces = 1;
  const deg2 = (sr: number): number => sr * (180 / Math.PI) ** 2;
  return {
    anyFraction: any / n,
    pieces,
    farSolidDeg2: deg2(farSolid),
    nearSolidDeg2: deg2(nearSolid),
  };
}

/**
 * 騎士的眼高,公尺 —— **從 `fps-camera.ts` 解析出來的**,不是抄的。
 * 追焦鏡頭是 `CHASE_UP = 9.5 * BIKE_SCALE`,那就是 §3.4「騎士眼睛只在地面上 6.3 公尺」
 * 的來源;調整車架縮放會同時改變這裡量到的天際線,那正是應該發生的事。
 */
const EYE_HEIGHT = (() => {
  const src = readFileSync('packages/web/src/game/terrain/fps-camera.ts', 'utf8');
  const scale = Number(src.match(/const BIKE_SCALE = ([\d.]+);/)![1]);
  const up = Number(src.match(/const CHASE_UP = ([\d.]+) \* BIKE_SCALE;/)![1]);
  return up * scale;
})();

const SEED = 12345;
/** MountainRing 的逐圈種子(`build()`:far 用 seed,near 用 seed ^ 0x5f3759df)。 */
const seedOf = (layer: 'near' | 'far'): number => (layer === 'far' ? SEED : SEED ^ 0x5f3759df);

const STYLES: Record<World, Strategy> = {
  paper: await createTerrainStyleStrategy('paper'),
  plastic: await createTerrainStyleStrategy('plastic'),
  circuit: await createTerrainStyleStrategy('circuit'),
};

/** 建一圈環,回傳場景(呼叫端負責 dispose)。 */
function buildRing(strategy: Strategy, corridorHalfWidth = 500): {
  scene: THREE.Scene; ring: InstanceType<typeof MountainRing>; meshes: Map<string, THREE.Mesh>;
} {
  const scene = new THREE.Scene();
  const ring = new MountainRing(scene, strategy, SEED, corridorHalfWidth);
  return { scene, ring, meshes: ringMeshesByName(scene) };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 分層設色的軸 —— 環是逐圈,不是逐高度
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[mountain ring — 環不吃高度分層,而那是 demo 寫下理由的決定]');

// ── 1a. 瓦楞紙:contourRing 是死碼 ──
//
// 這一段直接回答「demo 的環逐板套 TERRAIN_BAND」這個說法:那段程式碼確實存在,
// 手抖乘數也確實是 `0.93 + rng() * 0.14` —— 但它在 `contourRing()` 裡面,而
// `contourRing` 從來沒有被呼叫過。
{
  const s = SCRIPT.paper;
  // ⚠ 這幾條是**反向**斷言,不是「demo 必須留著 contourRing」。
  //
  // contourRing 是被否決的設計。把它的存在斷言下來,等於把它釘死在 demo 裡,而且
  // 下一個讀這個檔的人會以為那是要移植的東西 —— 這一輪的 brief 就是這樣被寫錯的
  // (它把 contourRing 的 `0.93 + rng() * 0.14` 當成遠山環該有的分層)。所以規則是:
  //
  //   ・contourRing 可以留著、也可以被刪掉,但**永遠不准有呼叫點**;
  //   ・它的逐板色帶手抖乘數**不准出現在它以外的任何地方**(刪掉它 → 0 次,也通過)。
  const contourAt = s.indexOf('function contourRing(');
  const contour = contourAt >= 0 ? sliceFn(s, 'contourRing') : '';
  console.log(contourAt >= 0
    ? '  · paper demo 還留著 contourRing(死碼:等高線疊層的遠山,被 inkRidge 取代)'
    : '  · paper demo 已經把 contourRing 刪掉了 —— 更好,下面的規則照樣成立');
  const ink = sliceFn(s, 'inkRidge');
  const JITTER = '0.93 + rng() * 0.14';

  check('contourRing 永遠沒有呼叫點 —— 它是被否決的設計,不准有人把它接回去',
    callSites(s, 'contourRing') === 0,
    `${callSites(s, 'contourRing')} 個呼叫點`);
  check(`逐板色帶的手抖乘數 \`${JITTER}\` 不准出現在 contourRing 以外的地方`,
    count(s, JITTER) - count(contour, JITTER) === 0,
    `全檔 ${count(s, JITTER)} 次 / contourRing 內 ${count(contour, JITTER)} 次`);
  check('活著的那個環是 inkRidge(兩個呼叫點),而且它連 TERRAIN_BAND / band 都沒提',
    callSites(s, 'inkRidge') === 2
    && !ink.includes('TERRAIN_BAND') && !/\bband\b/.test(ink),
    `${callSites(s, 'inkRidge')} 個呼叫點`);
  // 反過來:色帶在同一個檔案裡是活的,所以環的「沒有」是選擇不是缺漏。
  check('TERRAIN_BAND 在 paper demo 是活的(走廊的 plateTopMats 在吃)',
    /const plateTopMats = TERRAIN_BAND\.map\(/.test(s));
}

// ── 1b. 積木:bandAt 活著,環一次都沒叫它 ──
{
  const s = SCRIPT.plastic;
  const ring = sliceFn(s, 'blockMountainRing');
  check('plastic demo 宣告了 bandAt,而且真的在用(走廊)',
    /const bandAt = \(y\) =>/.test(s) && callSites(s, 'bandAt') > 0,
    `${callSites(s, 'bandAt')} 個呼叫點`);
  check('…但 blockMountainRing 一次都沒叫它,也沒提 TERRAIN_BAND',
    callSites(ring, 'bandAt') === 0 && !ring.includes('TERRAIN_BAND'));
  check('blockMountainRing 整圈只有一個材質參數(color),沒有色帶',
    /return new THREE\.Mesh\(g, toonShared\(color,/.test(ring));
}

// ── 1c. 電子:沒有 bandAt 這個軸,環也只有一個 finMat ──
{
  const s = SCRIPT.circuit;
  const ring = sliceFn(s, 'heatsinkRing');
  check('circuit demo 沒有 bandAt / TERRAIN_BAND(板面的顏色被分區佔走了)',
    !/const bandAt\b/.test(s) && !/const TERRAIN_BAND\b/.test(s));
  check('heatsinkRing 整圈鰭片共用一個 finMat、底筒共用一個 finBaseMat',
    /new THREE\.InstancedMesh\(unitBox, finMat, o\.fins\)/.test(ring)
    && /new THREE\.Mesh\(baseGeo, finBaseMat\)/.test(ring)
    && count(ring, 'setColorAt') === 0);
}

// ── 1d. 執行 demo 的環,看它真的吐出幾個顏色軸 ──
//
// 上面是讀原始碼;這裡是**跑**它。逐頂點色是分層唯一可能的載體(材質只有一個),
// 所以「沒有 color attribute、沒有 instanceColor」就是「沒有分層」的執行證據。
const demoRings = (() => {
  // 三個世界都一樣的作法:把 builder 包一層攔下**呼叫點的參數**,再重跑。參數一個都
  // 不准打進這個檔案 —— 抄過來的常數只會把當初打錯的東西再確認一遍(§0.0 第 5 點)。
  // paper
  const paper = new Function('THREE', 'Math', [
    sliceFn(SCRIPT.paper, 'mulberry32'),
    sliceFn(SCRIPT.paper, 'inkRidge'),
    'const OPTS = [];',
    'const real = inkRidge;',
    'inkRidge = function (o) { OPTS.push(o); return real(o); };',
    'const washFarMat = {}, lineFarMat = {}, washNearMat = {}, lineNearMat = {};',
    sliceCall(SCRIPT.paper, 'const mountFar = inkRidge({'),
    sliceCall(SCRIPT.paper, 'const mountNear = inkRidge({'),
    'return { inkRidge: real, OPTS };',
  ].join('\n'))(THREE, Object.create(Math)) as {
    inkRidge: (o: Record<string, unknown>) => { wash: THREE.Mesh; line: THREE.Mesh };
    OPTS: Record<string, number>[];
  };

  // plastic
  const toonShared = (color: string, opts?: Record<string, unknown>): THREE.Material =>
    new THREE.MeshBasicMaterial({ color, side: opts?.side as THREE.Side });
  const plastic = new Function('THREE', 'Math', 'toonShared', [
    sliceFn(SCRIPT.plastic, 'mulberry32'),
    sliceFn(SCRIPT.plastic, 'blockMountainRing'),
    'const CALLS = [];',
    'const real = blockMountainRing;',
    'blockMountainRing = function (...a) { CALLS.push(a); return real(...a); };',
    sliceStatement(SCRIPT.plastic, 'const mountFar = blockMountainRing('),
    sliceStatement(SCRIPT.plastic, 'const mountNear = blockMountainRing('),
    'return { blockMountainRing: real, CALLS };',
  ].join('\n'))(THREE, Object.create(Math), toonShared) as {
    blockMountainRing: (r: number, h: number, c: string, s: number) => THREE.Mesh;
    CALLS: [number, number, string, number][];
  };

  // circuit
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const finHex = demoPaletteHex(SCRIPT.circuit, 'copperFin');
  const finBaseHex = demoPaletteHex(SCRIPT.circuit, 'copperFinDeep');
  const finMat = new THREE.MeshToonMaterial({ color: `#${finHex}` });
  const finBaseMat = new THREE.MeshToonMaterial({ color: `#${finBaseHex}`, side: THREE.DoubleSide });
  const circuit = new Function('THREE', 'Math', 'unitBox', 'finMat', 'finBaseMat', [
    sliceFn(SCRIPT.circuit, 'mulberry32'),
    sliceFn(SCRIPT.circuit, 'heatsinkRing'),
    'const OPTS = [];',
    'const real = heatsinkRing;',
    'heatsinkRing = function (o) { OPTS.push(o); return real(o); };',
    sliceCall(SCRIPT.circuit, 'const mountNear = heatsinkRing({'),
    sliceCall(SCRIPT.circuit, 'const mountFar = heatsinkRing({'),
    'return { heatsinkRing: real, OPTS };',
  ].join('\n'))(THREE, Object.create(Math), unitBox, finMat, finBaseMat) as {
    heatsinkRing: (o: Record<string, number>) => THREE.Group;
    OPTS: Record<string, number>[];
  };
  return { paper, plastic, circuit, finHex, finBaseHex };
})();

{
  check('三個 demo 的呼叫點都攔到了(遠 + 近)',
    demoRings.paper.OPTS.length === 2 && demoRings.plastic.CALLS.length === 2
    && demoRings.circuit.OPTS.length === 2,
    `paper ${demoRings.paper.OPTS.length} / plastic ${demoRings.plastic.CALLS.length}`
    + ` / circuit ${demoRings.circuit.OPTS.length}`);
  const paperRing = demoRings.paper.inkRidge({
    ...demoRings.paper.OPTS[0],
    washMat: new THREE.MeshBasicMaterial(), lineMat: new THREE.MeshBasicMaterial(),
  });
  const plasticRing = demoRings.plastic.blockMountainRing(...demoRings.plastic.CALLS[0]);
  const circuitRing = demoRings.circuit.heatsinkRing(demoRings.circuit.OPTS[1]);

  const noVertexColour = (g: THREE.BufferGeometry): boolean => !g.getAttribute('color');
  check('paper demo 的環跑出來沒有逐頂點色(wash / line 各一片平色)',
    noVertexColour(paperRing.wash.geometry) && noVertexColour(paperRing.line.geometry));
  check('plastic demo 的環跑出來沒有逐頂點色',
    noVertexColour(plasticRing.geometry));
  const inst = circuitRing.children[0] as THREE.InstancedMesh;
  check('circuit demo 的環跑出來沒有逐頂點色、也沒有 instanceColor(整圈同一個銅)',
    inst.isInstancedMesh && inst.instanceColor === null
    && circuitRing.children.every((c) => noVertexColour((c as THREE.Mesh).geometry)),
    `${inst.count} 片鰭片 + 底筒`);
}

// ── 1e. 移植側:環的幾何也沒有任何分層載體 ──
for (const w of WORLDS) {
  const { scene, ring, meshes } = buildRing(STYLES[w]);
  const bad: string[] = [];
  for (const [name, m] of meshes) {
    for (const carrier of colourCarriers(m)) bad.push(`${name}: ${carrier}`);
  }
  check(`${w}: 環的每一片都是「一片幾何一個平色」(逐頂點/逐 instance/多材質全都沒有)`,
    bad.length === 0, bad.length ? bad.join(' | ') : `${meshes.size} 片`);
  ring.dispose();
  scene.clear();
}
// 反向對照:`colourCarriers` 真的抓得到。沒有這條,上面三條「都沒有」有可能只是因為
// 這個函式什麼都不看 —— 而它剛剛才被改過(鰭片帶進了 instanceColor 這個新載體)。
{
  const { scene, ring, meshes } = buildRing(STYLES.circuit);
  const victim = meshes.get('near')!;
  const inst = victim as unknown as THREE.InstancedMesh;
  const before = colourCarriers(victim).length;
  const planted: string[] = [];
  if (inst.isInstancedMesh) {
    inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(inst.count * 3).fill(1), 3);
    planted.push(...colourCarriers(victim));
    inst.instanceColor = null;
  }
  victim.geometry.setAttribute('color', new THREE.Float32BufferAttribute(
    new Float32Array(victim.geometry.getAttribute('position').count * 3).fill(1), 3));
  const withVertexColour = colourCarriers(victim);
  check('反向對照:硬塞一個 instanceColor / color attribute 進去,colourCarriers 都抓得到',
    before === 0 && planted.length === 1 && withVertexColour.length === 1,
    `原本 ${before} 個 / 塞 instanceColor → ${planted.join(',') || '(沒抓到)'}`
    + ` / 塞 color attribute → ${withVertexColour.join(',') || '(沒抓到)'}`);
  ring.dispose();
  scene.clear();
}

// ── 1f. 移植側:建環時三個「高度 → 顏色/階」的 hook 一次都沒被叫 ──
//
// 這是規則本身,不是形狀:如果哪天有人把走廊的 bandAt 接到環上,上面的幾何斷言全部
// 照樣通過(色帶會走 material.color,不會長出 color attribute),只有這一條會響。
for (const w of WORLDS) {
  const base = STYLES[w];
  const calls: Record<string, number> = {
    bandAt: 0, terrainVertexColor: 0, quantizeElevation: 0,
    mountainColor: 0, generateMountainProfile: 0,
  };
  const spy: Strategy = {
    ...base,
    bandAt: base.bandAt ? ((y: number) => { calls.bandAt++; return base.bandAt!(y); }) : undefined,
    terrainVertexColor: (...a: Parameters<Strategy['terrainVertexColor']>) => {
      calls.terrainVertexColor++; return base.terrainVertexColor(...a);
    },
    quantizeElevation: (...a: Parameters<Strategy['quantizeElevation']>) => {
      calls.quantizeElevation++; return base.quantizeElevation(...a);
    },
    mountainColor: (...a: Parameters<Strategy['mountainColor']>) => {
      calls.mountainColor++; return base.mountainColor(...a);
    },
    generateMountainProfile: (...a: Parameters<Strategy['generateMountainProfile']>) => {
      calls.generateMountainProfile++; return base.generateMountainProfile(...a);
    },
  };
  const { scene, ring } = buildRing(spy);
  check(`${w}: 建環時 bandAt / terrainVertexColor / quantizeElevation 一次都沒被叫`,
    calls.bandAt === 0 && calls.terrainVertexColor === 0 && calls.quantizeElevation === 0,
    `band=${calls.bandAt} vtx=${calls.terrainVertexColor} quant=${calls.quantizeElevation}`);
  // 正向對照:同一個 spy 的計數器是會動的 —— 環真的問過 mountainColor 與剖面,
  // 各兩次(近 + 遠)。沒有這條,上面那條「都是 0」有可能只是 spy 根本沒接上。
  check(`${w}: …而 spy 是接上的:mountainColor / generateMountainProfile 各被叫了 2 次`,
    calls.mountainColor === 2 && calls.generateMountainProfile === 2,
    `color=${calls.mountainColor} profile=${calls.generateMountainProfile}`);
  ring.dispose();
  scene.clear();
  if (base.bandAt) {
    const before = calls.bandAt;
    spy.bandAt!(0);
    check(`${w}: …而 bandAt 的計數器本身是活的(直接叫一次會 +1)`,
      calls.bandAt === before + 1, `${before} → ${calls.bandAt}`);
  } else {
    check(`${w}: 這個世界根本沒宣告 bandAt(它走 terrainWallLevels)`,
      base.bandAt === undefined && typeof base.terrainWallLevels === 'number',
      `terrainWallLevels=${base.terrainWallLevels}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. 環真正的顏色軸:兩圈的濃淡(空氣透視)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[mountain ring — 顏色軸是「哪一圈」:遠淡近濃,色相守住]');

for (const w of WORLDS) {
  const near = hslOf(STYLES[w].mountainColor('near'));
  const far = hslOf(STYLES[w].mountainColor('far'));
  const hex = (l: 'near' | 'far') => STYLES[w].mountainColor(l).toString(16).padStart(6, '0');
  check(`${w}: 遠圈比近圈淡(空氣透視;水墨叫「遠淡近濃」)`,
    far.l > near.l + 0.03,
    `near #${hex('near')} L=${near.l.toFixed(3)} → far #${hex('far')} L=${far.l.toFixed(3)}`);
  check(`${w}: …而且是同一個色相被沖淡,不是換了一個顏色`,
    hueGap(near.h, far.h) <= 8,
    `Δhue ${hueGap(near.h, far.h).toFixed(2)}°`);
}

// ── 2b. 而那兩個顏色**真的落到了對的那一圈** ──
//
// ⚠ 上面兩條問的是 **strategy**,不是建出來的環。這是「記錄了 ≠ 送得到」第三次
// 出現在這個專案裡(前兩次:circuit 的 normalBias 1.2 被斷言成分歧卻沒有通道送到光上;
// 瓦楞紙的樹 receiveShadow 偏離,理由是「沒有逐世界的通道」)。
//
// 這個洞是突變測出來的:把 `buildRing` 裡的 `strategy.mountainColor(layer)` 改成
// `strategy.mountainColor('near')`(兩圈同色,殺掉空氣透視),上面兩條照樣全過,
// **連那條數 mountainColor 被叫兩次的 spy 也照樣過** —— 它叫了兩次,只是兩次都問 'near'。
for (const w of WORLDS) {
  const { scene, ring, meshes } = buildRing(STYLES[w]);
  const colorOf = (name: string): number | null => {
    const m = meshes.get(name);
    if (!m) return null;
    const mat = m.material as THREE.MeshToonMaterial;
    return mat.color ? mat.color.getHex() : null;
  };
  const gotNear = colorOf('near');
  const gotFar = colorOf('far');
  const wantNear = STYLES[w].mountainColor('near');
  const wantFar = STYLES[w].mountainColor('far');
  check(`${w}: 近圈那片的材質色 = mountainColor('near')`,
    gotNear === wantNear,
    `mesh #${(gotNear ?? -1).toString(16)} vs strategy #${wantNear.toString(16)}`);
  check(`${w}: 遠圈那片的材質色 = mountainColor('far') —— 不是又拿了一次 near`,
    gotFar === wantFar && gotFar !== gotNear,
    `far mesh #${(gotFar ?? -1).toString(16)} vs strategy #${wantFar.toString(16)}`
    + `(near mesh #${(gotNear ?? -1).toString(16)})`);
  ring.dispose();
  scene.clear();
}

// paper / plastic 的兩個色都是 demo 自己寫的兩個色(diorama 已逐色比過);
// circuit 的 demo **只有一個色**,遠圈那個是移植自己補的 —— 記錄在案的偏離。
{
  const c = STYLES.circuit;
  const nearHex = c.mountainColor('near').toString(16).padStart(6, '0');
  const farHex = c.mountainColor('far').toString(16).padStart(6, '0');
  check('circuit demo 的兩圈是**同一個** finMat(一個 copperFin,沒有遠近之分)',
    count(sliceFn(SCRIPT.circuit, 'heatsinkRing'), 'finMat') === 1
    && /const finMat = toon\(\{ color: E\.copperFin \}\)/.test(SCRIPT.circuit));
  check('circuit: 移植的近圈就是 demo 的 copperFin,一格沒動',
    nearHex === demoRings.finHex, `#${nearHex} vs demo #${demoRings.finHex}`);
  check('circuit: 遠圈是移植自己補的、更淡的同色相銅 —— 記錄在案的偏離'
    + '(demo 兩圈同色,gameview 的兩圈差 900 m,不分濃淡就疊成一坨)',
    farHex !== demoRings.finHex
    && hueGap(hslOf(c.mountainColor('far')).h, hslOf(c.mountainColor('near')).h) <= 8
    && hslOf(c.mountainColor('far')).l > hslOf(c.mountainColor('near')).l,
    `#${farHex} vs demo #${demoRings.finHex}`);
  // 底筒:demo 的 `finBaseMat` 是**一個** copperFinDeep,兩圈共用。移植照抄 ——
  // 鰭片分遠近濃淡而底筒不分,是有理由的不對稱:底筒是一圈矮牆,遠圈那圈幾乎整條
  // 躲在近圈後面,沒有兩圈並排比較的機會(鰭片有,而且差 900 m)。
  const { scene, ring, meshes } = buildRing(STYLES.circuit);
  // ⚠ `?.` 不是防禦性寫法而是**斷言的一部分**:底筒不見了(例如有人把 mountainRingFins
  // 拿掉)必須是一條乾乾淨淨的 ✗,不是一個 TypeError —— 一 throw,這支檢查後面幾十條
  // 就整批不執行了,而輸出看起來只有「1 個失敗」(MEMORY:check3d-aborts-on-throw)。
  const baseHexOf = (l: 'near' | 'far'): string =>
    (meshes.get(`${l}Base`)?.material as THREE.MeshBasicMaterial | undefined)
      ?.color.getHexString() ?? '(沒有底筒)';
  check('circuit: 兩圈的底筒 = demo 的 copperFinDeep,而且兩圈同色(demo 只有一個 finBaseMat)',
    baseHexOf('near') === demoRings.finBaseHex && baseHexOf('far') === demoRings.finBaseHex,
    `near #${baseHexOf('near')} / far #${baseHexOf('far')} vs demo #${demoRings.finBaseHex}`);
  check('circuit: 底筒的氧化色沒有變成鰭片的色 —— 兩者是不同的東西',
    baseHexOf('near') !== nearHex && baseHexOf('far') !== farHex,
    `底筒 #${baseHexOf('near')} vs 鰭片 near #${nearHex} / far #${farHex}`);
  ring.dispose();
  scene.clear();
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. 電子世界的環 vs demo heatsinkRing —— `check:3d` 先前一條都沒有
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[mountain ring vs demo — circuit (heatsink fins)]');

{
  const opts = { near: demoRings.circuit.OPTS[0], far: demoRings.circuit.OPTS[1] };
  check('circuit demo 的兩個呼叫點都攔到了', demoRings.circuit.OPTS.length === 2,
    `near fins=${opts.near.fins} / far fins=${opts.far.fins}`);

  const { scene, ring, meshes } = buildRing(STYLES.circuit);
  check('circuit 不畫稜線墨帶,而且它的環是**鰭片 + 底筒**不是簾幕:'
    + '每圈兩片 + 地平圓盤 = 5 片',
    STYLES.circuit.mountainRingFinish === undefined && meshes.size === 5,
    [...meshes.keys()].join(', '));

  /**
   * demo 的 `profile(u)` 本人 —— 把它從 `heatsinkRing` 裡切出來執行。
   * 用來證明下面那個接縫偏離是 demo 的算式在 u > 1 的行為,不是移植走樣。
   */
  const demoProfileFn = (seed: number): ((u: number) => number) =>
    new Function('seed', [
      sliceFn(SCRIPT.circuit, 'mulberry32'),
      'const rng = mulberry32(seed);',
      sliceStatement(SCRIPT.circuit, 'const peaks = [];'),
      sliceStatement(SCRIPT.circuit, 'for (let i = 0; i < 22; i++) peaks.push('),
      sliceStatement(SCRIPT.circuit, 'const profile = (u) => {'),
      'return profile;',
    ].join('\n'))(seed) as (u: number) => number;

  /** 從 demo 的 InstancedMesh 矩陣反推鰭高(maxH=1, baseH=0 → scale.y = heights[i])。 */
  const demoHeights = (o: Record<string, number>, seed: number, fins: number): number[] => {
    const grp = demoRings.circuit.heatsinkRing({ ...o, maxH: 1, baseH: 0, sink: 0, fins, seed });
    const im = grp.children[0] as THREE.InstancedMesh;
    const m = new THREE.Matrix4(); const p = new THREE.Vector3();
    const q = new THREE.Quaternion(); const s = new THREE.Vector3();
    const out: number[] = [];
    for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, m); m.decompose(p, q, s); out.push(s.y); }
    return out;
  };

  /** 一批 instance 矩陣拆成 (位置, 轉角, 縮放)。 */
  const decompose = (im: THREE.InstancedMesh): {
    p: THREE.Vector3[]; q: THREE.Quaternion[]; s: THREE.Vector3[];
  } => {
    const m = new THREE.Matrix4();
    const p: THREE.Vector3[] = []; const q: THREE.Quaternion[] = []; const s: THREE.Vector3[] = [];
    for (let i = 0; i < im.count; i++) {
      const pp = new THREE.Vector3(); const qq = new THREE.Quaternion(); const ss = new THREE.Vector3();
      im.getMatrixAt(i, m); m.decompose(pp, qq, ss);
      p.push(pp); q.push(qq); s.push(ss);
    }
    return { p, q, s };
  };

  // 裙襬深度:從**簾幕世界建出來的環**讀回來,不是打進這個檔案。鰭片的底筒必須落到
  // 同一條裙襬,不然電子世界的山腳會在下坡時看穿到天空。
  const SKIRT_DROP = (() => {
    const s = new THREE.Scene();
    const r = new MountainRing(s, STYLES.plastic, SEED, 500);
    const t = layerTriangles(ringMeshesByName(s), 'near');
    let lo = Infinity;
    for (let i = 1; i < t.length; i += 3) lo = Math.min(lo, t[i]);
    r.dispose(); s.clear();
    return -lo;
  })();

  // ── 那個數字自己有沒有出處 ──────────────────────────────────────────────
  //
  // 上面那段只證明「鰭片的底筒跟簾幕落在同一條線上」—— 它拿實作量實作,對
  // 「這條線該有多深」一個字都沒說。三個 demo 各自寫了一個裙襬,一個都沒被比過:
  //
  //   paper     inkRidge           整片 wash 的最低點(yBase)
  //   plastic   blockMountainRing  整片的最低點
  //   circuit   heatsinkRing       底筒的最低點(−1.5·sink,而且**兩圈不同**)
  //
  // 全部**執行 demo 自己的 builder** 讀最低的 y,一個常數都不打進來(§0.0 第 5 點)。
  // 移植的是**張角**不是公尺:demo 挑自己的世界尺寸,gameview 的兩圈半徑由 §3.6 定死,
  // 所以可轉移的量是 drop / radius —— 這個檔案比環高時用的也是同一個貨幣。
  //
  // ⚠ 這裡是 `≥` 而不是 `===`,而且那個不等號本身就是要斷言的東西。gameview 比
  // 六個 demo 全部都深,理由量過:demo 的地平面是一張**整片**的
  // `CircleGeometry(1000)`(藍圖桌 / 地墊 / 防靜電袋),壓在騎士腳下 0.3–9.6 m,
  // 所以它的簾幕永遠碰不到真正的洞 —— 把那張盤拿掉再用真實 DEM 跑
  // (`?loc=alpedhuez` / `?loc=amalfi`),三個 demo 都從 3.3°…38° 漏出天空。
  // gameview 的地平圓盤是**環狀**的(中間 540 m 是走廊,不能蓋),裙襬因此是唯一
  // 擋得住那個俯角的東西。所以 demo 給的是**下界**,不是值。
  const demoSkirt = (() => {
    const minY = (g: THREE.BufferGeometry, m?: THREE.Object3D): number => {
      const p = g.getAttribute('position');
      let lo = Infinity;
      for (let i = 0; i < p.count; i++) lo = Math.min(lo, p.getY(i) + (m?.position.y ?? 0));
      return lo;
    };
    const out: { world: string; layer: string; radius: number; drop: number }[] = [];
    for (const [i, layer] of ['far', 'near'].entries()) {
      const o = demoRings.paper.OPTS[i];
      const ring = demoRings.paper.inkRidge({
        ...o, washMat: new THREE.MeshBasicMaterial(), lineMat: new THREE.MeshBasicMaterial(),
      });
      out.push({ world: 'paper', layer, radius: o.radius, drop: -minY(ring.wash.geometry) });
    }
    for (const [i, layer] of ['far', 'near'].entries()) {
      const call = demoRings.plastic.CALLS[i];
      const mesh = demoRings.plastic.blockMountainRing(...call);
      out.push({ world: 'plastic', layer, radius: call[0], drop: -minY(mesh.geometry) });
    }
    for (const [i, layer] of ['near', 'far'].entries()) {
      const o = demoRings.circuit.OPTS[i];
      const grp = demoRings.circuit.heatsinkRing(o);
      const base = grp.children[1] as THREE.Mesh;
      out.push({ world: 'circuit', layer, radius: o.radius, drop: -minY(base.geometry, base) });
    }
    return out;
  })();
  {
    // gameview 的兩圈半徑也是量出來的(從簾幕的頂點),不是打進來的。
    const s = new THREE.Scene();
    const r = new MountainRing(s, STYLES.plastic, SEED, 500);
    const m = ringMeshesByName(s);
    const radiusOf = (l: 'near' | 'far'): number => {
      const t = layerTriangles(m, l);
      let hi = 0;
      for (let i = 0; i < t.length; i += 3) hi = Math.max(hi, Math.hypot(t[i], t[i + 2]));
      return hi;
    };
    const gameR = { near: radiusOf('near'), far: radiusOf('far') };
    r.dispose(); s.clear();
    const need = demoSkirt.map((d) => ({
      ...d, want: (d.drop / d.radius) * gameR[d.layer as 'near' | 'far'],
    }));
    const deepest = need.reduce((a, b) => (b.want > a.want ? b : a));
    check('裙襬至少跟 demo 一樣深 —— 六個 demo 裙襬(三個世界 × 兩圈,執行它們自己的'
      + ' builder 讀回來)換算成同一個張角 drop/radius,gameview 取得過最深的那一個',
      SKIRT_DROP >= deepest.want - 1e-6,
      `gameview −${SKIRT_DROP.toFixed(0)} m;最深的是 ${deepest.world}/${deepest.layer}`
      + ` −${deepest.drop.toFixed(0)} m @ R${deepest.radius} → 換算 −${deepest.want.toFixed(1)} m;`
      + ` 六個:${need.map((d) => `${d.world}/${d.layer} −${d.want.toFixed(0)}`).join(' ')}`);
    check('…而且比六個都深,那是記錄在案的偏離:demo 的地平面是整片圓盤、'
      + 'gameview 的是中間挖了走廊的環,所以那邊的簾幕碰不到的俯角,這邊只剩簾幕擋',
      need.every((d) => SKIRT_DROP > d.want),
      `−${SKIRT_DROP.toFixed(0)} m vs 最深的 demo −${deepest.want.toFixed(1)} m`);
  }

  for (const layer of ['near', 'far'] as const) {
    const o = opts[layer];
    const fins = meshes.get(layer) as unknown as THREE.InstancedMesh;
    const base = meshes.get(`${layer}Base`);
    check(`${layer}: 環是 InstancedMesh 的鰭片批次 + 一個底筒(demo heatsinkRing 的兩個 child)`,
      !!fins && fins.isInstancedMesh === true && !!base,
      `${fins?.isInstancedMesh ? `InstancedMesh × ${fins.count}` : '不是 InstancedMesh'}`
      + ` / 底筒 ${base ? base.geometry.type : '沒有'}`);
    if (!fins?.isInstancedMesh || !base) continue;

    check(`${layer}: instance 數 === demo 的 o.fins`,
      fins.count === o.fins, `${fins.count} vs demo ${o.fins}`);
    check(`${layer}: 每片鰭片就是 demo 的 unitBox(BoxGeometry 1×1×1)`,
      fins.geometry.type === 'BoxGeometry'
      && (fins.geometry as THREE.BoxGeometry).parameters.width === 1
      && (fins.geometry as THREE.BoxGeometry).parameters.height === 1
      && (fins.geometry as THREE.BoxGeometry).parameters.depth === 1,
      `${fins.geometry.type} ${JSON.stringify((fins.geometry as THREE.BoxGeometry).parameters)}`);

    const seed = seedOf(layer);
    const prof = STYLES.circuit.generateMountainProfile(layer, seed, o.fins);

    // ── 剖面 = demo 的鰭高,逐片 ──
    // 現在是**用鰭片數驅動**(不是 gameview 的 160 格簾幕):demo 的分組平頂就是散熱
    // 片,一組 = 一片上的幾根鰭,所以解析度必須是鰭片數本身。
    const heights = demoHeights(o, seed, o.fins);
    const mismatch: number[] = [];
    for (let i = 0; i < o.fins; i++) if (Math.abs(heights[i] - prof[i]) > 1e-6) mismatch.push(i);
    const lastRun = runLengths(heights)[runLengths(heights).length - 1];
    const lastStart = o.fins - lastRun;
    check(`${layer}: 鰭高逐片 === demo heatsinkRing(峰取 max + 分組平頂 + rng 抽取順序)`
      + ',只有 demo 自己在環接縫上那一組可以例外',
      mismatch.every((i) => i >= lastStart),
      mismatch.length
        ? `${mismatch.length} 片不同,全在最後一組 [${lastStart}, ${o.fins})`
        : `${o.fins} 片逐片相同`);
    check(`${layer}: 環是閉合的(剖面第一格 === 最後一格)`,
      prof[o.fins] === prof[0], `${prof[0]} vs ${prof[o.fins]}`);

    // ── 分組平頂:同一片散熱片上的鰭是齊的 ──
    // demo 的 run = `4 + floor(rng()*6)`,相鄰兩組抽到同高會併起來,所以只有下界。
    const runs = runLengths(prof.slice(0, o.fins));
    check(`${layer}: 鰭高是一組一組的平頂,每組 ≥ 4 片(demo 的 4 + floor(rng()×6))`,
      Math.min(...runs.slice(0, -1)) >= 4,
      `${runs.length} 組,長度 ${Math.min(...runs.slice(0, -1))}…${Math.max(...runs)}`);

    // ── 鰭片對鰭片:同一個各向異性縮放,逐片 ──
    //
    // demo 挑自己的世界尺寸,gameview 的兩圈半徑與高度尺度由 §3.6 定死,所以移植是
    // demo 的環乘上一個**各向異性**縮放:水平 kR、垂直 kH。這裡不打任何常數進來 ——
    // 兩個係數各從**一片**鰭片量出來,再要求其餘每一片、以及底筒,全部跟著同一組係數。
    const demoGrp = demoRings.circuit.heatsinkRing({ ...o, seed });
    const demoFins = decompose(demoGrp.children[0] as THREE.InstancedMesh);
    const gameFins = decompose(fins);
    const kR = gameFins.s[0].z / demoFins.s[0].z;      // thick
    const kH = gameFins.s[0].y / demoFins.s[0].y;      // 第一片的高
    let yawErr = 0; let thickErr = 0; let depthErr = 0; let hErr = 0; let dirErr = 0; let yErr = 0;
    // 比到兩邊都還有鰭片為止。片數本身已經有自己那一條斷言,這裡越界只會 throw 掉
    // 後面幾十條(MEMORY:check3d-aborts-on-throw)。
    const n = Math.min(o.fins, gameFins.s.length, demoFins.s.length);
    const demoR = o.radius + o.depth / 2;
    const gameDepth = gameFins.s[0].x;
    const gameR = Math.hypot(gameFins.p[0].x, gameFins.p[0].z);
    // 環的半徑 = 鰭片中線 − depth/2(demo 的 `radius + o.depth / 2`,反解回來)。
    const gameRadius = gameR - gameDepth / 2;
    for (let i = 0; i < n; i++) {
      yawErr = Math.max(yawErr, gameFins.q[i].angleTo(demoFins.q[i]));
      thickErr = Math.max(thickErr, Math.abs(gameFins.s[i].z - demoFins.s[i].z * kR));
      depthErr = Math.max(depthErr, Math.abs(gameFins.s[i].x - gameDepth));
      dirErr = Math.max(dirErr,
        Math.abs(gameFins.p[i].x / gameR - demoFins.p[i].x / demoR),
        Math.abs(gameFins.p[i].z / gameR - demoFins.p[i].z / demoR));
      if (mismatch.includes(i)) continue;             // 接縫那一組,下面單獨處理
      hErr = Math.max(hErr, Math.abs(gameFins.s[i].y - demoFins.s[i].y * kH));
      yErr = Math.max(yErr, Math.abs(gameFins.p[i].y - demoFins.p[i].y * kH));
    }
    check(`${layer}: 每一片鰭片的轉角 === demo 的 q.setFromAxisAngle(up, -a)`,
      yawErr < 1e-6, `最大差 ${(yawErr * 180 / Math.PI).toExponential(2)}°`);
    check(`${layer}: 每一片的切向厚度 === demo × kR(kR = ${kR.toFixed(4)} = 半徑比)`
      + ' —— 所以鰭片的張角 thick/radius 逐片等於 demo 的,梳子的疏密一模一樣',
      thickErr < 1e-3 && Math.abs(kR - gameRadius / o.radius) < 1e-4,
      `最大差 ${thickErr.toExponential(2)} m / kR ${kR.toFixed(6)}`
      + ` vs 半徑比 ${(gameRadius / o.radius).toFixed(6)}`);
    check(`${layer}: 每一片的高 === demo × kH(kH = ${kH.toFixed(4)} = 高度尺度比),`
      + '底也一樣(pos.y = h/2 − sink)',
      hErr < 1e-3 && yErr < 1e-3,
      `高最大差 ${hErr.toExponential(2)} m / 位置 y 最大差 ${yErr.toExponential(2)} m`);
    check(`${layer}: 每一片都站在 demo 那條 (radius + depth/2) 中線的同一個方位上`,
      dirErr < 1e-6, `最大單位向量差 ${dirErr.toExponential(2)}`);
    check(`${layer}: 整圈鰭片同一個徑向長度(demo 的 o.depth,一片一片不會各自不同)`,
      depthErr < 1e-3, `${gameDepth.toFixed(1)} m,最大差 ${depthErr.toExponential(2)}`);

    // ── 底筒 = demo 的 CylinderGeometry(r+depth, r+depth, baseH+sink, 64, 1, true) ──
    const bp = (base.geometry as THREE.CylinderGeometry).parameters;
    const baseTris = worldTriangles(base);
    let baseTop = -Infinity; let baseBottom = Infinity;
    for (let i = 1; i < baseTris.length; i += 3) {
      baseTop = Math.max(baseTop, baseTris[i]); baseBottom = Math.min(baseBottom, baseTris[i]);
    }
    // sink 與 baseH 從建出來的鰭片解回來:鰭底 = −sink,鰭高 = profile × maxHeight + baseH。
    const sink = gameFins.s[0].y / 2 - gameFins.p[0].y;
    const iHi = prof.indexOf(Math.max(...prof.slice(0, o.fins)));
    const iLo = prof.indexOf(Math.min(...prof.slice(0, o.fins)));
    const maxHeight = (gameFins.s[iHi].y - gameFins.s[iLo].y) / (prof[iHi] - prof[iLo]);
    const baseH = gameFins.s[iHi].y - prof[iHi] * maxHeight;
    check(`${layer}: 底筒是 demo 的 64 段、開口圓筒,半徑 = radius + depth`,
      bp.radialSegments === 64 && bp.heightSegments === 1 && bp.openEnded === true
      && Math.abs(bp.radiusTop - (gameRadius + gameDepth)) < 1e-2
      && bp.radiusTop === bp.radiusBottom,
      `r=${bp.radiusTop.toFixed(2)} vs radius+depth=${(gameRadius + gameDepth).toFixed(2)}`);
    check(`${layer}: 底筒的頂 = demo 的 baseH − sink/2(× kH 之後),一格沒動`,
      Math.abs(baseTop - (baseH - sink / 2)) < 1e-3
      && Math.abs((baseH - sink / 2) - (o.baseH - o.sink / 2) * kH) < 1e-3,
      `頂 ${baseTop.toFixed(2)} m / demo ${(o.baseH - o.sink / 2).toFixed(2)} × kH`
      + ` = ${((o.baseH - o.sink / 2) * kH).toFixed(2)} m`);
    check(`${layer}: …但底拉到跟簾幕同一條裙襬 −${SKIRT_DROP} m ——`
      + '記錄在案的偏離:demo 的板子是平的,gameview 的走廊會掉到騎士下面幾百公尺',
      Math.abs(baseBottom + SKIRT_DROP) < 1e-6
      && baseBottom < -1.5 * sink,
      `底 ${baseBottom.toFixed(1)} m(demo 會停在 ${(-1.5 * sink).toFixed(1)} m)`);
    check(`${layer}: 底筒吃 baseH + sink 的比例,demo 的 sink 也照 kH 縮放`,
      Math.abs(sink - o.sink * kH) < 1e-3 && Math.abs(baseH - o.baseH * kH) < 1e-3,
      `sink ${sink.toFixed(2)} vs ${(o.sink * kH).toFixed(2)}`
      + ` / baseH ${baseH.toFixed(2)} vs ${(o.baseH * kH).toFixed(2)}`);

    // ── 繞序:鰭片是**實心盒子**,所以規則從「朝內」變成「朝外」 ──
    //
    // 簾幕是一片開口的帶子,騎手在裡面,所以每一面都要朝內。鰭片是封閉的箱子,
    // 每一面要朝**自己那個箱子的外面**(BoxGeometry 原本的繞序)。兩者都是
    // FrontSide,兩者反過來都會在 WebGL 裡消失、在 CPU probe 裡完全正常。
    const outward = (g: THREE.BufferGeometry): number => {
      const pos = g.getAttribute('position'); const idx = g.getIndex()!;
      const a = new THREE.Vector3(); const b = new THREE.Vector3(); const c = new THREE.Vector3();
      const n = new THREE.Vector3();
      let out = 0; let total = 0;
      for (let i = 0; i < idx.count; i += 3) {
        a.fromBufferAttribute(pos, idx.getX(i));
        b.fromBufferAttribute(pos, idx.getX(i + 1));
        c.fromBufferAttribute(pos, idx.getX(i + 2));
        n.crossVectors(b.clone().sub(a), c.clone().sub(a));
        if (n.lengthSq() < 1e-12) continue;
        total++;
        // 單位盒的中心在原點,所以面心本身就是往外的方向。
        if (n.dot(a.add(b).add(c).divideScalar(3)) > 0) out++;
      }
      return total === 0 ? 0 : out / total;
    };
    check(`${layer}: 每一片鰭片的每一面都朝著自己盒子的外面`,
      outward(fins.geometry) === 1, `${(outward(fins.geometry) * 100).toFixed(1)}% outward`);
    check(`${layer}: …而且反向對照抓得到(索引翻轉 → 0% outward)`,
      outward(reversedIndex(fins.geometry)) === 0);

    // ── 材質 ──
    const mat = fins.material as THREE.MeshBasicMaterial;
    check(`${layer}: 鰭片吃霧(demo 的 finMat 是 toon(),沒有關掉 three 的預設 fog)`,
      mat.fog === true && !/const finMat = toon\(\{[^}]*fog:/.test(SCRIPT.circuit));
    check(`${layer}: 鰭片是 FrontSide(封閉盒子,繞序才有意義),底筒是 DoubleSide`
      + '(demo 的 finBaseMat 就是 DoubleSide:騎手在筒子裡面)',
      mat.side === THREE.FrontSide
      && (base.material as THREE.Material).side === THREE.DoubleSide
      && /const finBaseMat = toon\(\{ color: E\.copperFinDeep, side: THREE\.DoubleSide \}\)/
        .test(SCRIPT.circuit));

    // ── 材質**類別** ──
    //
    // 2026-07-28 的決定:「circuit 環按照 demo 設計」的最後一格。demo 的
    // `finMat` / `finBaseMat` 都是 `toon(…)`,而移植先前一律走這個檔案共通的
    // 不發光 `MeshBasicMaterial`。
    //
    // ⚠ 這條是補上去的,因為**換材質那次檢查一聲都沒吭**:上面那兩條問的是
    // `fog` 與 `side`,兩個在 Basic 與 Toon 上都存在也都相同 —— 「兩種實作在出貨
    // 的數字下等價」那個漏網形狀,這個 session 第三次。
    const demoToon = /const finMat = toon\(/.test(SCRIPT.circuit)
      && /const finBaseMat = toon\(/.test(SCRIPT.circuit);
    check(`${layer}: demo 的 finMat / finBaseMat 都是 toon()`, demoToon);
    check(`${layer}: 移植的鰭片與底筒也是 MeshToonMaterial —— 不是不發光的替身`,
      mat.type === 'MeshToonMaterial'
      && (base.material as THREE.Material).type === 'MeshToonMaterial',
      `鰭片 ${mat.type} / 底筒 ${(base.material as THREE.Material).type}`);
    // 而且它拿的是**這個世界的** gradientMap,不是 three 的預設兩階。
    check(`${layer}: …而且掛著這個世界自己的 gradientMap(§3.8 從自己的貨架拿)`,
      (mat as unknown as THREE.MeshToonMaterial).gradientMap != null,
      `gradientMap ${(mat as unknown as THREE.MeshToonMaterial).gradientMap ? '有' : '無'}`);
  }

  // ── 接縫:demo 的 profile 在 u > 1 是壞的,移植修掉了 ──
  //
  // demo 的最後一組會餵進 u = (i + run/2) / fins > 1,而它的環狀包繞
  // `if (d > 0.5) d = 1 - d` 只在 u ∈ [0,1] 正確:u > 1 時,位置小於 u−1 的峰拿到
  // **負的**距離,`t = 1 - d/w` 因此大於 1,那一組鰭片被灌高。移植的 `% segments`
  // 把 u 收回 [0,1)。這條把「差在哪、為什麼」都執行一遍,免得下一個人照 demo 改回去。
  {
    const seed = seedOf('far');
    const P = demoProfileFn(seed);
    let worstJump = 0; let worstU = 0;
    for (let x = 0; x <= 0.05; x += 0.0005) {
      const d = Math.abs(P(1 + x) - P(x));
      if (d > worstJump) { worstJump = d; worstU = x; }
    }
    check('demo 的 profile(u) 在 u = 1 的接縫上不連續 —— `d > 0.5 → 1 − d` 只在 u ∈ [0,1] 是包繞',
      worstJump > 0.1,
      `最大跳變 ${worstJump.toFixed(4)} @ u=${worstU.toFixed(4)} vs ${(1 + worstU).toFixed(4)}`);
    // 而移植取的是 u < 1 的那一邊 —— 對每一片對不上的鰭片都成立。
    const o = opts.far;
    const prof = STYLES.circuit.generateMountainProfile('far', seed, o.fins);
    const heights = demoHeights(o, seed, o.fins);
    const bad = [...Array(o.fins).keys()].filter((i) => Math.abs(heights[i] - prof[i]) > 1e-6);
    const rs = runLengths(heights);
    const lastStart = o.fins - rs[rs.length - 1];
    // demo 的 run ∈ [4, 9]:把它解出來,才知道那一組的 u 是多少。
    const run = [4, 5, 6, 7, 8, 9].find(
      (r) => Math.abs(P((lastStart + r / 2) / o.fins) - heights[lastStart]) < 1e-6);
    const u = run === undefined ? NaN : (lastStart + run / 2) / o.fins;
    check('遠圈那一組對不上的鰭片,差的正是這件事:demo 取 u > 1,移植取 u mod 1',
      bad.length > 0 && run !== undefined && u > 1
      && Math.abs(P(u) - heights[bad[0]]) < 1e-6
      && Math.abs(P(u % 1) - prof[bad[0]]) < 1e-6,
      `${bad.length} 片 @[${lastStart}, ${o.fins}),run=${run},u=${u.toFixed(4)}:`
      + ` demo P(u)=${P(u).toFixed(6)} vs 移植 P(u mod 1)=${P(u % 1).toFixed(6)}`);
    check('近圈整圈逐片相同 —— 這個瑕疵是接縫落在哪裡的問題,不是每一圈都會踩到',
      (() => {
        const on = opts.near;
        const p = STYLES.circuit.generateMountainProfile('near', seedOf('near'), on.fins);
        const h = demoHeights(on, seedOf('near'), on.fins);
        return h.every((v, i) => Math.abs(v - p[i]) <= 1e-6);
      })(), `${opts.near.fins} 片`);
  }

  // ── depth 是唯一一個沒有照 kR 放大的 demo 數字,擋住它的是壓克力罩 ──
  //
  // demo 自己也守「罩子在鰭片外面」(CASE_R 960 vs 鰭片外緣 620+190 = 810)。
  // gameview 的罩子半徑是照著**簾幕**(沒有徑向厚度的 2600)訂的,所以遠圈的 depth
  // 照 kR 放大會刺穿它。上限取 demo 自己那個比例套在 gameview 的罩子上。
  {
    const CASE_R = Number(SCRIPT.circuit.match(/const CASE_R = (\d+)/)![1]);
    const demoOuter = opts.far.radius + opts.far.depth;
    const limit = ACRYLIC_CASE_RADIUS * (demoOuter / CASE_R);
    const outerOf = (layer: 'near' | 'far'): number => {
      const t = layerTriangles(meshes, layer);
      let hi = 0;
      for (let i = 0; i < t.length; i += 3) hi = Math.max(hi, Math.hypot(t[i], t[i + 2]));
      return hi;
    };
    const innerOf = (layer: 'near' | 'far'): number => {
      const t = layerTriangles(meshes, layer);
      let lo = Infinity;
      for (let i = 0; i < t.length; i += 3) lo = Math.min(lo, Math.hypot(t[i], t[i + 2]));
      return lo;
    };
    /**
     * 這一圈的 (半徑, depth) —— 從第一片鰭的矩陣反解(中線 = radius + depth/2)。
     * 不是鰭片就回 NaN,讓下面每一條變成乾淨的 ✗ 而不是 TypeError(見上面那段註解)。
     */
    const ringOf = (layer: 'near' | 'far'): { radius: number; depth: number } => {
      const im = meshes.get(layer) as unknown as THREE.InstancedMesh;
      if (!im?.isInstancedMesh) return { radius: NaN, depth: NaN };
      const m = new THREE.Matrix4(); const p = new THREE.Vector3();
      const q = new THREE.Quaternion(); const s = new THREE.Vector3();
      im.getMatrixAt(0, m); m.decompose(p, q, s);
      return { radius: Math.hypot(p.x, p.z) - s.x / 2, depth: s.x };
    };
    const nearRing = ringOf('near');
    const farRing = ringOf('far');
    const kRnear = nearRing.radius / opts.near.radius;
    const kRfar = farRing.radius / opts.far.radius;
    check('近圈的 depth 沒有被上限碰到 —— demo 的 depth/radius 比例原封不動',
      Math.abs(nearRing.depth - opts.near.depth * kRnear) < 1e-2
      && nearRing.radius + nearRing.depth < limit,
      `${nearRing.depth.toFixed(1)} m = demo ${opts.near.depth} × kR ${kRnear.toFixed(3)}`);
    check('遠圈的 depth **被上限切掉了**,而上限就是 demo 自己的(鰭片外緣 / CASE_R)× 罩子半徑',
      farRing.depth < opts.far.depth * kRfar - 1
      && Math.abs(farRing.radius + farRing.depth - limit) < 1e-2,
      `照比例會是 ${(opts.far.depth * kRfar).toFixed(0)} m(外緣 `
      + `${(farRing.radius + opts.far.depth * kRfar).toFixed(0)} m),實際 `
      + `${farRing.depth.toFixed(0)} m(外緣 ${outerOf('far').toFixed(0)} m,上限 ${limit.toFixed(0)} m)`);
    check('兩圈都整個站在壓克力罩裡面(連最高那片鰭的外上角也在)',
      (() => {
        for (const l of ['near', 'far'] as const) {
          const t = layerTriangles(meshes, l);
          for (let i = 0; i < t.length; i += 3) {
            if (Math.hypot(t[i], t[i + 1], t[i + 2]) > ACRYLIC_CASE_RADIUS) return false;
          }
        }
        return true;
      })(),
      `罩子 ${ACRYLIC_CASE_RADIUS} m / 近圈外緣 ${outerOf('near').toFixed(0)} m`
      + ` / 遠圈外緣 ${outerOf('far').toFixed(0)} m`);
    check('近圈的外緣還是整個在遠圈的內緣以內 —— 「近的一定比遠的近」,'
      + '透縫的量法靠這件事才成立',
      outerOf('near') < innerOf('far'),
      `近圈外緣 ${outerOf('near').toFixed(0)} m < 遠圈內緣 ${innerOf('far').toFixed(0)} m`);
  }

  ring.dispose();
  scene.clear();
}

// ── InstancedMesh 的第二個 GPU buffer 也要收 ──
//
// `geometry.dispose()` 碰不到 `instanceMatrix`,那個 buffer 是 three 從 **mesh 自己的**
// `dispose()` 收的(它在那裡發 'dispose' 事件,renderer 聽到才釋放)。環在每一次世界
// 切換都會重建,漏掉就是每切一次漏一份矩陣 buffer。這條聽那個事件,不看旗標。
{
  const scene = new THREE.Scene();
  const ring = new MountainRing(scene, STYLES.circuit, SEED, 500);
  const fired = new Set<string>();
  for (const layer of ['near', 'far'] as const) {
    const im = ringMeshesByName(scene).get(layer) as unknown as THREE.InstancedMesh;
    im.addEventListener('dispose', () => fired.add(layer));
  }
  ring.dispose();
  check('circuit: dispose() 也收掉兩圈鰭片的 instanceMatrix(geometry.dispose() 碰不到它)',
    fired.size === 2, `收到的: ${[...fired].join(', ') || '(一個都沒有)'}`);
  scene.clear();
}

// ── 簾幕世界的繞序:騎手在環的裡面,而且鰭片的分支沒有碰到它們 ──
//
// 這條以前只有電子世界有(它現在改用「朝著自己盒子的外面」)。簾幕的規則是反過來的,
// 而它一樣是「CPU probe 看不出來、WebGL 整條地平線消失」那一類,所以補在這裡。
for (const w of ['paper', 'plastic'] as const) {
  const { scene, ring, meshes } = buildRing(STYLES[w]);
  const strips = [...meshes].filter(([n]) => n !== 'disc');
  check(`${w}: 環的每一片都是簾幕,而且每一面都朝著環心(騎手在裡面)`,
    strips.length > 0 && strips.every(([, m]) =>
      !(m as unknown as THREE.InstancedMesh).isInstancedMesh
      && inwardFaceFraction(m.geometry) === 1),
    strips.map(([n, m]) => `${n} ${(inwardFaceFraction(m.geometry) * 100).toFixed(0)}%`).join(' / '));
  check(`${w}: …而且反向對照抓得到(索引翻轉 → 0% inward)`,
    strips.every(([, m]) => inwardFaceFraction(reversedIndex(m.geometry)) === 0));
  ring.dispose();
  scene.clear();
}

// ── 遠圈到底有沒有從近圈的縫裡透出來 ──────────────────────────────────────────
//
// 這是整輪的重點,而它是可以量的。量法與「為什麼不是量方位角比例」見檔頭。
console.log('\n[mountain ring — 遠圈從近圈的縫裡透出來(從騎士眼高掃一圈)]');
{
  const vis: Record<string, RingVisibility> = {};
  for (const w of WORLDS) {
    const { scene, ring, meshes } = buildRing(STYLES[w]);
    vis[w] = ringVisibility(meshes, EYE_HEIGHT);
    ring.dispose(); scene.clear();
  }
  // 移植前的狀態,一模一樣地建出來:把 `mountainRingFins` 拿掉,circuit 就走回共用的
  // 簾幕。這條是「這個斷言真的會失敗」的常設證明,不是一次性的截圖。
  {
    const scene = new THREE.Scene();
    const ring = new MountainRing(
      scene, { ...STYLES.circuit, mountainRingFins: undefined }, SEED, 500);
    vis['circuit(簾幕)'] = ringVisibility(ringMeshesByName(scene), EYE_HEIGHT);
    ring.dispose(); scene.clear();
  }
  for (const [k, v] of Object.entries(vis)) {
    console.log(`  · ${k}: 遠圈可見 ${(v.anyFraction * 100).toFixed(1)}% 的方位角,`
      + `切成 ${v.pieces} 塊,佔 ${v.farSolidDeg2.toFixed(0)} 平方度`
      + `(近圈自己 ${v.nearSolidDeg2.toFixed(0)} 平方度)`);
  }
  check('circuit: 遠圈被近圈的鰭片切成上百塊 —— 一片縫一塊,數量級就是近圈的鰭片數',
    vis.circuit.pieces >= 100,
    `${vis.circuit.pieces} 塊(近圈 ${demoRings.circuit.OPTS[0].fins} 片鰭)`);
  check('反向對照:把 mountainRingFins 拿掉(= 移植前的簾幕),縫整個消失',
    vis['circuit(簾幕)'].pieces <= 20 && vis.circuit.pieces > vis['circuit(簾幕)'].pieces * 5,
    `簾幕 ${vis['circuit(簾幕)'].pieces} 塊 → 鰭片 ${vis.circuit.pieces} 塊`);
  check('另外兩個世界還是簾幕,遠圈只從近圈頂上露出來(§3.6),塊數是個位數',
    vis.paper.pieces <= 20 && vis.plastic.pieces <= 20,
    `paper ${vis.paper.pieces} 塊 / plastic ${vis.plastic.pieces} 塊`);
  // 而「兩圈都看得到的方位角比例」**分不出來** —— 這條把那件事本身釘住,免得下一個人
  // 拿它當「透縫」的證據(第一版就是這樣寫的,簾幕 60.7% / 鰭片 63.4%)。
  check('⚠「兩圈都看得到的方位角比例」不是透縫的證據:簾幕跟鰭片差不到 10 個百分點',
    Math.abs(vis.circuit.anyFraction - vis['circuit(簾幕)'].anyFraction) < 0.1,
    `簾幕 ${(vis['circuit(簾幕)'].anyFraction * 100).toFixed(1)}%`
    + ` vs 鰭片 ${(vis.circuit.anyFraction * 100).toFixed(1)}%`);
}

// ── §3.6:三個 demo 自己的張角比,以及移植的 ──
//
// 這是 CUSTOM_WORLD_INSTRUCTIONS §3.6(遠圈的 maxH/radius 必須大於近圈)在三個 demo
// 上的實際成績。**塑膠違反,另外兩個遵守** —— 刻意的不一致,釘下來免得下一個人默默
// 「修好」它(或反過來,照著塑膠把移植也弄反)。
{
  // 全部從攔下來的呼叫點參數算,一個數字都沒有打進這個檔案。
  // 呼叫順序:paper 遠→近、plastic 遠→近、circuit 近→遠(demo 自己的順序)。
  const ratio = (maxH: number, radius: number) => maxH / radius;
  const ratios: Record<World, { near: number; far: number }> = {
    paper: {
      far: ratio(demoRings.paper.OPTS[0].maxH, demoRings.paper.OPTS[0].radius),
      near: ratio(demoRings.paper.OPTS[1].maxH, demoRings.paper.OPTS[1].radius),
    },
    plastic: {
      far: ratio(demoRings.plastic.CALLS[0][1], demoRings.plastic.CALLS[0][0]),
      near: ratio(demoRings.plastic.CALLS[1][1], demoRings.plastic.CALLS[1][0]),
    },
    circuit: {
      near: ratio(demoRings.circuit.OPTS[0].maxH, demoRings.circuit.OPTS[0].radius),
      far: ratio(demoRings.circuit.OPTS[1].maxH, demoRings.circuit.OPTS[1].radius),
    },
  };
  const fmt = (r: { near: number; far: number }) => `近 ${r.near.toFixed(3)} / 遠 ${r.far.toFixed(3)}`;
  check('§3.6 paper demo 遵守(遠圈張角 > 近圈)', ratios.paper.far > ratios.paper.near, fmt(ratios.paper));
  check('§3.6 circuit demo 遵守', ratios.circuit.far > ratios.circuit.near, fmt(ratios.circuit));
  check('§3.6 plastic demo **違反** —— 刻意的不一致,不要默默「修好」它'
    + '(它靠的是別的東西:環近而矮、天空球也近)',
    ratios.plastic.far < ratios.plastic.near, fmt(ratios.plastic));
  // 移植的兩圈張角三個世界共用(§3.6 的 NEAR_/FAR_MAX_HEIGHT),而它站在多數決 +
  // 成文法那一邊。
  //
  // ⚠ 電子世界換成鰭片之後這條**不准變**:縫是**多的**那一份可見度,不是張角的替代品。
  // 所以量法改成從**世界座標三角形串流**取(峰高 / 最內側半徑),簾幕跟鰭片同一把尺,
  // 而且下面還有一條直接比三個世界的張角。
  const angOf: Record<World, { near: number; far: number }> = {
    paper: { near: 0, far: 0 }, plastic: { near: 0, far: 0 }, circuit: { near: 0, far: 0 },
  };
  for (const w of WORLDS) {
    const { scene, ring, meshes } = buildRing(STYLES[w]);
    const ang = (layer: 'near' | 'far'): number => {
      const t = layerTriangles(meshes, layer);
      let hi = -Infinity; let inner = Infinity;
      for (let i = 0; i < t.length; i += 3) {
        hi = Math.max(hi, t[i + 1]);
        inner = Math.min(inner, Math.hypot(t[i], t[i + 2]));
      }
      return hi / inner;
    };
    angOf[w] = { near: ang('near'), far: ang('far') };
    check(`§3.6 ${w}: 移植的遠圈張角 > 近圈`,
      angOf[w].far > angOf[w].near,
      `近 ${angOf[w].near.toFixed(3)} / 遠 ${angOf[w].far.toFixed(3)}`);
    ring.dispose();
    scene.clear();
  }
  // 三個世界的張角**互相**也要對得上,而且這條才是「換成鰭片沒有動張角」真正的證據。
  //
  // ⚠ 上面那個「峰高 / 半徑」不能拿來比世界:峰高還吃剖面自己的最大值(瓦楞紙的諧波
  // 和到 1.006、電子的三角峰只到 0.90),所以三個世界的峰角本來就不同。要比的是環的
  // **高度尺度**(剖面 1.0 是幾公尺),而它可以從建出來的東西解回來:
  // `(稜線_i − 稜線_j) / (剖面_i − 剖面_j)`,簾幕與鰭片同一條式子,因為兩者的第 i 格
  // 都落在方位角 2πi/N 上。一個數字都沒有從 mountain-ring.ts 抄過來。
  const scaleOf: Record<World, { near: number; far: number }> = {
    paper: { near: 0, far: 0 }, plastic: { near: 0, far: 0 }, circuit: { near: 0, far: 0 },
  };
  for (const w of WORLDS) {
    const { scene, ring, meshes } = buildRing(STYLES[w]);
    for (const layer of ['near', 'far'] as const) {
      const N = ringResolution(meshes.get(layer)!);
      const prof = STYLES[w].generateMountainProfile(layer, seedOf(layer), N).slice(0, N);
      const iHi = prof.indexOf(Math.max(...prof));
      const iLo = prof.indexOf(Math.min(...prof));
      const tris = layerTriangles(meshes, layer);
      const yHi = crestAt(tris, (iHi / N) * Math.PI * 2);
      const yLo = crestAt(tris, (iLo / N) * Math.PI * 2);
      let radius = Infinity;
      for (let i = 0; i < tris.length; i += 3) {
        radius = Math.min(radius, Math.hypot(tris[i], tris[i + 2]));
      }
      scaleOf[w][layer] = (yHi - yLo) / (prof[iHi] - prof[iLo]) / radius;
    }
    ring.dispose();
    scene.clear();
  }
  const spread = (l: 'near' | 'far'): number => {
    const v = WORLDS.map((w) => scaleOf[w][l]);
    return (Math.max(...v) - Math.min(...v)) / Math.min(...v);
  };
  check('§3.6 三個世界的高度尺度 / 半徑是同一組 —— 電子換成鰭片**沒有動張角**'
    + '(縫是多的那一份可見度,不是張角的替代品)',
    spread('near') < 0.01 && spread('far') < 0.01,
    `近 ${WORLDS.map((w) => scaleOf[w].near.toFixed(5)).join(' / ')}`
    + ` | 遠 ${WORLDS.map((w) => scaleOf[w].far.toFixed(5)).join(' / ')}`);
  check('§3.6 而它們的比也還是遠 > 近(同一套 NEAR_/FAR_MAX_HEIGHT)',
    WORLDS.every((w) => scaleOf[w].far > scaleOf[w].near),
    WORLDS.map((w) => `${w} ${(scaleOf[w].far / scaleOf[w].near).toFixed(3)}×`).join(' / '));
}

// ── 三個世界的剖面「長相」互相分得開 ──
//
// 三條剖面都是 0..1 的數列,包圍盒與格數完全一樣,所以「有沒有抄錯世界」只有形狀
// 分得出來:瓦楞紙是連續諧波(平頂比例 ≈ 0),另外兩個是量化/分組(> 0.6)。
{
  const flat: Record<World, number> = { paper: 0, plastic: 0, circuit: 0 };
  for (const w of WORLDS) {
    flat[w] = (['near', 'far'] as const)
      .map((l) => flatFraction(STYLES[w].generateMountainProfile(l, seedOf(l), 160)))
      .reduce((a, b) => Math.min(a, b));
  }
  check('paper 的稜線是連續諧波:相鄰同高的比例 ≈ 0', flat.paper < 0.02, flat.paper.toFixed(3));
  check('plastic 的稜線是量化階 + hold:平頂比例 > 0.6', flat.plastic > 0.6, flat.plastic.toFixed(3));
  check('circuit 的稜線是分組平頂:平頂比例 > 0.6', flat.circuit > 0.6, flat.circuit.toFixed(3));
  check('plastic 的階數就是 demo 的 6 階',
    new Set(STYLES.plastic.generateMountainProfile('far', seedOf('far'), 160)).size
      <= Number(sliceFn(SCRIPT.plastic, 'blockMountainRing').match(/const levels = (\d+)/)![1]) + 1,
    `${new Set(STYLES.plastic.generateMountainProfile('far', seedOf('far'), 160)).size} 階`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. 基準面:環根本沒有一個,所以也沒有接縫可以出現
// ═══════════════════════════════════════════════════════════════════════════
//
// 走廊的分層踩過「不能拿 originEle 當基準面」的坑(騎乘中 `updateOrigin` 會重設
// 基準,新舊 chunk 之間出現一道顏色接縫)。環沒有這個問題,而且理由要比「量過沒事」
// 更強:
//
//   ・環的高度是**角度**的函式(`profile[i] × maxHeight`),世界高程完全不進來;
//   ・環的顏色是**哪一圈**的函式,高度也完全不進來(第 1、2 節);
//   ・環的網格只在 `build()` / `setStrategy()` 時生成一次,`update()` 只搬
//     `mesh.position`,一個頂點都不動。
//
// 所以「跨 chunk」對環不存在,「跨重建」才存在 —— 下面驗的是後者。
console.log('\n[mountain ring — 沒有基準面,所以沒有接縫]');

for (const w of WORLDS) {
  const { scene, ring, meshes } = buildRing(STYLES[w]);
  const before = positionSnapshot(scene);
  const coloursBefore = [...meshes.values()]
    .map((m) => (m.material as THREE.MeshBasicMaterial).color.getHexString()).join(',');

  // 騎士走 12 km、掉 742 m —— 遠比任何一次 floating-origin rebase 都大。
  ring.update(new THREE.Vector3(0, 0, 0));
  ring.update(new THREE.Vector3(12345.5, -742.25, -9876.5));
  check(`${w}: update() 換位置/換高度,環的頂點一個都沒動(只有 mesh.position 走)`,
    positionSnapshot(scene) === before
    && [...meshes.values()].every((m) => m.position.x === 12345.5),
    `${meshes.size} 片`);
  check(`${w}: …顏色也一格沒動(顏色跟高度無關)`,
    [...meshes.values()].map((m) => (m.material as THREE.MeshBasicMaterial).color.getHexString()).join(',')
      === coloursBefore);

  // 換 strategy(世界切換的路徑)重建,同一個 seed → 逐位元組相同。
  ring.setStrategy(STYLES[w]);
  check(`${w}: setStrategy() 重建之後,幾何逐位元組相同(同一個 seed → 同一條天際線)`,
    positionSnapshot(scene) === before);

  ring.dispose();
  scene.clear();
}
{
  // 反向對照:換了 seed 就該不一樣 —— 而且是**每一圈**都不一樣。沒有這條,上面三條
  // 「都一樣」有可能是快照函式根本沒讀到東西;而只比整串的話,「近圈還在吃 seed、遠圈
  // 被寫死了」會照樣通過(實測:突變 I3 就是這樣溜過第一版的)。
  //
  // ⚠ 三個世界都跑。只跑 plastic 的話,電子世界換成 InstancedMesh 之後這條會靜靜地
  // 退化 —— 鰭片的 `geometry.position` 是一個共用的單位盒,**逐位元組跟 seed 無關**;
  // 天際線住在 instance 矩陣裡,所以快照必須是世界座標三角形串流(`worldTriangles`)。
  const perMesh = (w: World, seed: number): Map<string, string> => {
    const s = new THREE.Scene();
    const r = new MountainRing(s, STYLES[w], seed, 500);
    const out = new Map<string, string>();
    for (const [name, m] of ringMeshesByName(s)) {
      if (name === 'disc') continue;              // 圓盤不吃 seed,它是同心圓
      if (name.endsWith('Base')) continue;        // 底筒也不吃 seed,它是同心圓筒
      out.set(name, worldTriangles(m).join(','));
    }
    r.dispose(); s.clear();
    return out;
  };
  for (const w of WORLDS) {
    const snapA = perMesh(w, SEED);
    const snapB = perMesh(w, SEED + 1);
    const unchanged = [...snapA].filter(([n, v]) => snapB.get(n) === v).map(([n]) => n);
    check(`反向對照 ${w}:換一個 seed,**每一圈**的天際線都不一樣(快照真的讀得到東西)`,
      snapA.size >= 2 && unchanged.length === 0,
      unchanged.length ? `沒動的: ${unchanged.join(', ')}` : `${snapA.size} 圈都變了`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. 陰影旗標 —— 記錄在案的偏離,理由是量出來的
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[mountain ring shadow flags vs demos]');

// ── 5a. 完整性守門:三個 demo 的遠山 + 地平圓盤那一段裡,每一條旗標宣告都在這張表上 ──
//
// `shadow-flags-vs-demo.ts` 的守門是**逐 site** 的,而遠山/地平圓盤從來沒有被登記成
// 一個 site —— 所以它抓不到這兩條,不是它壞了,是這塊地不歸它管。這裡把它補上。
{
  const REGIONS: Record<World, { src: string; expect: string[] }> = {
    paper: {
      src: sliceBlock(SCRIPT.paper, '  // ── 遠山 = 一抹墨色 ──', '  scene.add(desk);'),
      expect: ['desk.receiveShadow=true'],
    },
    plastic: {
      src: sliceBlock(SCRIPT.plastic, '  // ── 積木階梯遠山環(plastic', '  scene.add(mat0);'),
      expect: [],
    },
    circuit: {
      src: sliceBlock(SCRIPT.circuit, '  // 遠山 = 兩圈散熱鰭片', '  scene.add(esdMat);'),
      expect: ['inst.castShadow=true', 'esdMat.receiveShadow=true'],
    },
  };
  const got = Object.fromEntries(
    WORLDS.map((w) => [w, shadowAssignments(REGIONS[w].src)]),
  ) as Record<World, string[]>;
  for (const w of WORLDS) {
    check(`${w} demo 的遠山/地平圓盤區段裡,旗標宣告就是這些(沒有未登記的)`,
      got[w].join(' | ') === REGIONS[w].expect.join(' | '),
      got[w].length ? got[w].join(' | ') : '(一條都沒有)');
  }
  // 三個 demo 在這件事上**不一致**,而且不一致本身要被釘住。從**解析出來的**
  // `got` 讀,不是從上面那張期望表 —— 從表讀的話這兩條就只是在確認一份手抄的副本。
  const casts = (w: World) => got[w].some((a) => a.endsWith('.castShadow=true'));
  const recvs = (w: World) => got[w].some((a) => a.endsWith('.receiveShadow=true'));
  check('demo 之間刻意的不一致①:只有 circuit 的鰭片投影(1/3)',
    casts('circuit') && !casts('paper') && !casts('plastic'),
    WORLDS.map((w) => `${w}=${casts(w)}`).join(' '));
  check('demo 之間刻意的不一致②:paper 的桌面與 circuit 的防靜電袋收影,plastic 的地墊不收(2/3)',
    recvs('paper') && recvs('circuit') && !recvs('plastic'),
    WORLDS.map((w) => `${w}=${recvs(w)}`).join(' '));
}

// ── 5b. 移植側:環與圓盤兩個旗標都沒開 ──
for (const w of WORLDS) {
  const { scene, ring, meshes } = buildRing(STYLES[w]);
  const bad = [...meshes].filter(([, m]) => m.castShadow || m.receiveShadow)
    .map(([n, m]) => `${n}:${m.castShadow ? 'C' : '-'}${m.receiveShadow ? 'R' : '-'}`);
  check(`${w}: 環與地平圓盤 castShadow / receiveShadow 都是關的`,
    bad.length === 0, bad.join(' ') || `${meshes.size} 片全 --`);
  ring.dispose();
  scene.clear();
}

// ── 5c. 理由,量出來的 ──
//
// 陰影相機是正交的:橫向 ±SHADOW_HALF_EXTENT、沿光軸 ±(FAR−NEAR)/2。任何一點想
// 進得了這個盒子,離騎士的距離就不可能超過這個盒子的**外接半徑**。這個界跟太陽仰角
// 無關(盒子會轉,半徑不會),所以它是一個乾淨的上界。
{
  const halfDepth = (SHADOW_FAR - SHADOW_NEAR) / 2;
  const REACH = Math.hypot(SHADOW_HALF_EXTENT, SHADOW_HALF_EXTENT, halfDepth);
  console.log(`  · 陰影框 ±${SHADOW_HALF_EXTENT} m × 深 ±${halfDepth.toFixed(1)} m`
    + ` → 外接半徑 ${REACH.toFixed(1)} m`);

  const { scene, ring, meshes } = buildRing(STYLES.circuit);
  // ⚠ 從**世界座標三角形串流**量,不是從 `geometry.position`:鰭片的 position 是一個
  // 中心在原點的單位盒,直接讀會量到 0.707 m,這條斷言會整個反過來。
  let minRingRadius = Infinity;
  for (const layer of ['near', 'far'] as const) {
    const t = layerTriangles(meshes, layer);
    for (let i = 0; i < t.length; i += 3) {
      minRingRadius = Math.min(minRingRadius, Math.hypot(t[i], t[i + 2]));
    }
  }
  check('環上最近的一個頂點都還在陰影框的外接半徑之外 —— 所以 castShadow 開了也是零像素',
    minRingRadius > REACH,
    `最近 ${minRingRadius.toFixed(0)} m vs 外接半徑 ${REACH.toFixed(1)} m（${(minRingRadius / REACH).toFixed(1)}×）`);
  // 成本不是零:環是 `frustumCulled = false`,所以 castShadow 一開就是**每幀無條件**
  // 送進 depth pass(three 的 shadow map 對 frustumCulled=false 的物件不做剔除)。
  check('…而且成本不是零:環是 frustumCulled = false,開了就是每幀無條件進 depth pass',
    [...meshes].filter(([n]) => n !== 'disc').every(([, m]) => m.frustumCulled === false));
  // 換成鰭片之後帳單本身也要重算一次(brief 指名的):instance 數 × 單位盒的三角形,
  // 加上兩個底筒。比簾幕**更貴**,而且照樣是零像素 —— 偏離的理由因此更強不是更弱。
  {
    const finTris = (['near', 'far'] as const).reduce((n, l) => {
      const im = meshes.get(l) as unknown as THREE.InstancedMesh;
      return n + (im?.isInstancedMesh ? im.count * (im.geometry.getIndex()!.count / 3) : 0);
    }, 0);
    const baseTris = (['nearBase', 'farBase'] as const).reduce(
      (n, l) => n + (meshes.get(l)?.geometry.getIndex()?.count ?? 0) / 3, 0);
    const instances = (['near', 'far'] as const).reduce(
      (n, l) => n + ((meshes.get(l) as unknown as THREE.InstancedMesh)?.count ?? 0), 0);
    // 簾幕那一版:同一支 MountainRing,只是不宣告鰭片。
    const s = new THREE.Scene();
    const r = new MountainRing(s, { ...STYLES.circuit, mountainRingFins: undefined }, SEED, 500);
    const curtainTris = (['near', 'far'] as const).reduce(
      (n, l) => n + ringMeshesByName(s).get(l)!.geometry.getIndex()!.count / 3, 0);
    r.dispose(); s.clear();
    check('陰影偏離重新確認:鰭片版送進 depth pass 的量比簾幕版**更大**,而且一樣是零像素',
      finTris + baseTris > curtainTris,
      `${instances} 個 instance × 12 = ${finTris} 個三角形 + 底筒 ${baseTris}`
      + ` = ${finTris + baseTris},簾幕版 ${curtainTris}`);
  }
  ring.dispose();
  scene.clear();

  // 圓盤:內緣 = 走廊半寬 + 邊距。出貨預設(viewRange 500)也在框外;但**不是**整個
  // 合法範圍都在框外 —— 滑桿最小值 100 就進得來。兩邊都斷言,這條註記才不會爛掉。
  const innerRadius = (halfWidth: number): number => {
    const s = new THREE.Scene();
    const r = new MountainRing(s, STYLES.circuit, SEED, halfWidth);
    const p = ringMeshesByName(s).get('disc')!.geometry.getAttribute('position');
    let lo = Infinity;
    for (let i = 0; i < p.count; i++) lo = Math.min(lo, Math.hypot(p.getX(i), p.getZ(i)));
    r.dispose(); s.clear();
    return lo;
  };
  const atDefault = innerRadius(500);   // shared/src/config.ts 的 viewRange 預設
  const atMin = innerRadius(100);       // SettingsPanel.vue 的滑桿下限
  check('地平圓盤的內緣在出貨預設(viewRange 500)下也在陰影框之外 → receiveShadow 是空操作',
    atDefault > REACH, `內緣 ${atDefault.toFixed(0)} m vs ${REACH.toFixed(1)} m`);
  check('…但 viewRange 拉到滑桿下限 100 時它就進得來 —— 這條偏離的邊界,寫下來免得爛掉',
    atMin < REACH, `內緣 ${atMin.toFixed(0)} m vs ${REACH.toFixed(1)} m`);
}

for (const w of WORLDS) STYLES[w].dispose();

console.log(`\n[mountain ring vs demo] ${executed} assertions executed, `
  + `${failures === 0 ? 'all clear' : `${failures} FAILURES`}`);
