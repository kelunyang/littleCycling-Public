/**
 * `[world boundary]` —— 這一支**讀 import 圖,不讀幾何**。
 *
 * 它驗的是 `plan/world-modularity-refactor.md` 的第三步:
 *
 *   任何 packages/web/src/game/terrain/*-terrain-style.ts
 *     ❌ 不准 import 另一個世界的模組(含另一個 *-terrain-style.ts)
 *     ❌ 不准從共用模組 import 色票或材質工廠
 *     ✅ 可以 import 機制(登記處、排版、合併工具、介面、post pass)
 *     ✅ 可以 import **自己世界**的模組(`plastic-*` / `paper-*` / `circuit-*`),
 *        那是它自己的貨架,裡面放什麼都行 —— 但它的 import 一樣要守上面兩條,
 *        不然「借由自己的檔案去別人貨架上拿」就是一條沒人看的暗管。
 *
 * ## 為什麼要多這一支
 *
 * 這是**逐件比對抓不到**的那一類。逐件比對比的是有順序的世界座標三角形串流 ——
 * 幾何與材質參數 —— 它**不讀 import**。一個世界從別人的貨架上拿東西,在那串
 * 三角形裡完全看不出來:拿到的顏色是「一個顏色」,它只是**錯的那一個**。
 *
 * 實際發生過的那一件:塑膠的樹去拿共用貨架的 `TREE_CANOPY_COLORS`(通用卡通綠)
 * 而不是 demo 的 `COIL_GREENS`。這一週抓到的移植漂移逐件比對全部抓到了 ——
 * 金幣、便利貼、樹冠面數、電容環、LED 材質類別、十二個電子零件的 `receiveShadow`
 * —— 只有這一件躲掉。
 *
 * ## 「帶色票」怎麼判定(可執行,不靠命名慣例)
 *
 * 判定的對象是**真的被 import 進去的那幾個 binding 的執行期值**,不是模組名字,
 * 也不是整個 namespace —— 一支機制模組往後大可以長出一個大家共用的材質,那不該
 * 讓所有 import 它的人一起變紅。
 *
 *   色票    = `THREE.Color` 實例、`#rrggbb` 之類的字串、CSS 顏色名,或**在原始碼
 *             裡寫成 16 進位字面值**的整數(陣列/物件會往下遞迴)。
 *             用「原始碼裡是不是 `0x…`」而不是用數值門檻,是因為門檻會誤傷
 *             `ACRYLIC_CASE_RADIUS = 3200`、`MOUNTAIN_FAR_RADIUS = 2600` 這類
 *             真的常數 —— 這個 repo 的顏色一律寫成 `0xrrggbb`。
 *   材質工廠 = **呼叫看看**,回傳 `instanceof THREE.Material` 就是。回傳的東西
 *             如果就是傳進去的那個引數則不算(`injectCloudShadow(mat)` 回傳的是
 *             你給它的那一個,它是機制不是工廠)。連同直接 export 出來的
 *             `THREE.Material` 實例一起算。
 *   色票(函式版) = **呼叫看看,回傳的是顏色**。這一條是量出來補的:第一版只認
 *             「常數」與「回傳材質的函式」,而 `plastic-materials.ts` 有 **5 個
 *             export 是回傳顏色的函式**(`terrainColorForElevation` /
 *             `terrainVertexColor` 回傳 `THREE.Color`,`roadColorForClass` /
 *             `buildingColorFromCoord` / `urbanColorForClass` 回傳
 *             `0xrrggbb`)—— 它們全部被判成機制。**穿了函式外衣的色票還是色票**:
 *             `TREE_CANOPY_COLORS` 那件事只要包成 `canopyColorFor(i)` 就整個躲掉。
 *
 *             這一條比常數版**緊**,而且是刻意的:回傳值不往物件裡遞迴(不然
 *             `defaultStyleParams()` 回傳的 StyleParams 裡只要有一個顏色欄位,
 *             整支機制就被錯殺),而且**排除 0**。0 是量到的假陽性 ——
 *             `day-night-lighting.ts` 的 `nightFactorFromElevation`
 *             / `nightKeyFloorGain` 會 `return 0`,而同一個檔案裡有
 *             `overcastColor: 0x000000`,於是「原始碼裡寫成 16 進位」對 0 恆真。
 *             整數要**寫成六位數 `0xrrggbb`** 才算,這也是這個 repo 的慣例。
 *
 * ## 第二條漏管:洗錢(2026-07-29 量到的)
 *
 * 上面那套只看**世界的根檔直接連出去的那幾條邊**。所以它看不見這件事:
 *
 *   一支**共用**模組自己去某個世界的貨架上拿色票,而三個世界都 import 它。
 *
 * 這就是 `cartoon-materials` 那個病換一個宿主 —— 一個戴著機制名字的檔案,裡面裝
 * 著某一個世界的造型決定,然後被大家共用。實測過:把
 * `import { TREE_CANOPY_COLORS } from './plastic-materials'` 加進
 * `sign-builder.ts`(三個世界都 import 它),**當時的 13 條斷言一條都沒紅**。
 *
 * 所以下面第 2 段走**共用模組的傳遞閉包**,規則是:
 *
 *   一支共用模組可以一條世界邊都沒有(純機制),也可以是**登記處** ——
 *   但登記處的定義是可執行的:它伸手拿的**每一個檔都必須是某個世界的根**
 *   (`<world>-terrain-style.ts`),而且**三個世界一個都不能少**。
 *
 * 「必須是根」這一半不能省。少了它,`terrain-style-strategy.ts`(它本來就認識
 * 三個世界)只要再加一行 `from './plastic-materials'` 就永遠豁免 —— 豁免條款
 * 自己變成新的暗管。伸手到 `plastic-materials.ts` 從來不是「派工」。
 *
 * ⚠ **一個量過的盲點,寫在這裡免得有人以為它被蓋住了**:道路寬度表
 * (`ROAD_WIDTHS = { motorway: 12, … }`)**這支檢查看不見**。12 是整數,原始碼裡
 * 也不是 `0x…`,它跟任何一個尺寸常數在執行期長得一模一樣。所以「塑膠的道路寬度
 * 表搬回塑膠自己家」是第一步用手做完的,不是這裡守住的。
 *
 * ## 這支檢查自己會不會是死的
 *
 * 「沒有人看過它失敗的檢查不是檢查」。所以分類器每次都先跑**兩個方向**的固定樣本
 * 再去看真正的 import 圖:
 *   ・正向 —— `plastic-materials.ts`(這個世界的貨架)必須被判成「有色票、有材質
 *     工廠」,而且其中**至少 5 個是函式**。把 `colourish()` 改成 `() => false`、
 *     或把 `returnsColour()` 改成 `() => false`,這幾條就紅。
 *   ・反向 —— `sign-builder` / `bike-ornament` / `mountain-ring` / `acrylic-case` /
 *     `cartoon-materials` 必須**一個都沒有**。把 `colourish()` 改成 `() => true`
 *     這條就紅。
 * 少了任何一個方向,這條規則都會退化成「禁止所有 import」而看起來仍然是綠的。
 *
 * 洗錢那一段同樣有它自己的兩個方向:`verdictFor()` 是一個純函式,下面直接餵它
 * 四組**捏造的**邊(全根全世界 / 只認識一個世界 / 認識三個世界但伸手到非 root /
 * 完全沒有世界邊),四種判決都必須答對。把豁免條款寫寬一點,那幾條就紅。
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/world-boundary.ts
 *
 * 刻意**不**叫 `*-vs-demo.ts` —— 它不是 demo diff,而 `diorama.ts` 那條守門斷言
 * 只列舉 `*-vs-demo.ts`。所以它在 `STANDALONE_CHECKS` 之外單獨註冊。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// 共用的 canvas stub。**不要**自己裝 `globalThis.document`(理由見 recording-canvas.ts)。
const { installRecordingCanvas } = await import('./recording-canvas.ts');
installRecordingCanvas();

const THREE = await import('three');
// 探測材質工廠時會把探針材質餵給每一個被 import 的函式,而 `building-lights` 的
// `registerNightLitMaterial` 真的會把它記進夜燈登記處。所以掃完要親手拆掉 ——
// 留著的話 `setNightLitFactor` 每一幀都會寫進一個沒人要的材質。
const { unregisterNightLitMaterial } = await import('@/game/terrain/building-lights');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
export function failureCount(): number { return failures; }

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolvePath(HERE, '..', '..');
const WEB_SRC = join(REPO, 'packages', 'web', 'src');
const TERRAIN_DIR = join(WEB_SRC, 'game', 'terrain');

// ── 世界與歸屬 ───────────────────────────────────────────────────────────────

/** 世界名 = `<world>-terrain-style.ts` 的前綴。表是**掃出來的**,不是抄的。 */
const WORLDS = readdirSync(TERRAIN_DIR)
  .filter((f) => f.endsWith('-terrain-style.ts'))
  .map((f) => f.replace(/-terrain-style\.ts$/, ''))
  .sort();

/** 這個檔屬於哪個世界?`plastic-materials.ts` → plastic,`sign-builder.ts` → null。 */
function ownerOf(file: string): string | null {
  const b = basename(file).replace(/\.tsx?$/, '');
  for (const w of WORLDS) if (b === w || b.startsWith(`${w}-`)) return w;
  return null;
}

// ── import 解析 ──────────────────────────────────────────────────────────────

interface Edge {
  /** 原始 specifier(`./cartoon-materials`)。 */
  spec: string;
  /** 解析後的絕對路徑,解析不到就是 null(外部套件已先濾掉)。 */
  file: string | null;
  /** 真的被 import 進來的名字。`*` 代表整個 namespace(或動態 import)。 */
  names: string[] | '*';
}

/**
 * 把一個檔案的 import 邊抓出來。
 *
 * 三種形式都要:靜態 `import … from '…'` / `export … from '…'`、只有副作用的
 * `import '…'`、以及動態 `import('…')`(動態的一律當成整個 namespace —— 這個
 * repo 的 headless check 就是這樣把產線模組拉進來的,漏掉它就是留一條暗管)。
 * `import type {…}` 與 `{ type X }` 會被跳過:型別在執行期不存在,搬不動任何顏色。
 */
function parseEdges(src: string): Edge[] {
  const edges: Edge[] = [];
  const push = (spec: string, names: string[] | '*'): void => {
    edges.push({ spec, file: null, names });
  };

  // clause 不准跨過 `;` —— 不然 `import './x';` 這種只有副作用的形式會貪心地
  // 跟下一個 statement 的 `from` 湊成一對,產生一條假的邊。
  const STATIC = /(?:^|[\n;{}])\s*(?:import|export)\b([^;]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  for (let m = STATIC.exec(src); m; m = STATIC.exec(src)) {
    const clause = m[1].trim();
    const spec = m[2];
    if (/^type\b/.test(clause)) continue;              // import type { … } from
    if (/^\*/.test(clause)) { push(spec, '*'); continue; }  // import * as NS  /  export * from
    const names: string[] = [];
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (braced) {
      for (const raw of braced[1].split(',')) {
        const part = raw.trim();
        if (!part || /^type\b/.test(part)) continue;   // { type X }
        names.push(part.split(/\s+as\s+/)[0].trim());
      }
    }
    const beforeBrace = clause.split('{')[0].replace(/,\s*$/, '').trim();
    if (beforeBrace && !/^\*/.test(beforeBrace)) names.push(beforeBrace); // default import
    push(spec, names);
  }

  const BARE = /(?:^|[\n;{}])\s*import\s*['"]([^'"]+)['"]/g;
  for (let m = BARE.exec(src); m; m = BARE.exec(src)) push(m[1], []);

  const DYN = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (let m = DYN.exec(src); m; m = DYN.exec(src)) push(m[1], '*');

  return edges;
}

/** `./x` / `../x` / `@/game/terrain/x` → 絕對檔案路徑。外部套件回 undefined。 */
function resolveSpec(fromFile: string, spec: string): string | null | undefined {
  let bare: string;
  if (spec.startsWith('@/')) bare = join(WEB_SRC, spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../')) bare = resolvePath(dirname(fromFile), spec);
  else return undefined;                                // three, vue, @littlecycling/… — 不是這個 repo 的貨架
  for (const cand of [bare, `${bare}.ts`, `${bare}.tsx`, `${bare}.js`, join(bare, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

// ── 分類器:色票 / 材質工廠 ──────────────────────────────────────────────────

const HEX_STRING = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_NAMES: Record<string, number> =
  (THREE.Color as unknown as { NAMES: Record<string, number> }).NAMES ?? {};

/** 這個整數在它自己的原始碼裡是不是寫成 16 進位字面值。 */
function writtenAsHex(v: number, src: string): boolean {
  const h = v.toString(16);
  return new RegExp(`0x0*${h}\\b`, 'i').test(src);
}

/** `THREE.Color` 吃得下、而且**看起來就是拿來當顏色用**的常數。 */
function colourish(v: unknown, src: string, depth = 0): boolean {
  if (v instanceof THREE.Color) return true;
  if (typeof v === 'string') {
    return HEX_STRING.test(v) || Object.prototype.hasOwnProperty.call(COLOR_NAMES, v.toLowerCase());
  }
  if (typeof v === 'number') {
    return Number.isInteger(v) && v >= 0 && v <= 0xffffff && writtenAsHex(v, src);
  }
  if (depth >= 3 || v === null || typeof v !== 'object') return false;
  // 貼圖與材質自己有一堆內部顏色欄位,往裡面遞迴只會問出「three 的預設白」。
  if (v instanceof THREE.Texture || v instanceof THREE.Material) return false;
  if (Array.isArray(v)) return v.some((e) => colourish(e, src, depth + 1));
  return Object.values(v as Record<string, unknown>).some((e) => colourish(e, src, depth + 1));
}

/** 探針材質。`MeshStandardMaterial` 有 `emissive` —— 萬一被登記進夜燈登記處,
 *  `setNightLitFactor` 也不會炸(而且下面掃完會把它拆掉)。 */
const probeMaterials: THREE.MeshStandardMaterial[] = [];
function newProbeMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial();
  probeMaterials.push(m);
  return m;
}

/**
 * 呼叫看看:回傳 `THREE.Material` 的就是材質工廠。
 *
 * 餵垃圾引數本來就會讓 three 對著 stderr 抱怨(`Unknown color residential`
 * 之類),那是預期中的,不是壞掉 —— 所以這段把 console 靜音,免得 `check:3d`
 * 的輸出被幾十行雜訊淹掉。
 */
function probeReturns(fn: (...a: unknown[]) => unknown, visit: (r: unknown, args: unknown[]) => boolean): boolean {
  const fillers: unknown[][] = [
    [0xffffff, 0xffffff, 0xffffff],
    ['residential', 'residential', 'residential'],
    [newProbeMaterial(), 0xffffff, 0xffffff],
  ];
  const { warn, error, log } = console;
  console.warn = console.error = console.log = () => {};
  try {
    for (const filler of fillers) {
      for (let n = 0; n <= 3; n++) {
        const args = filler.slice(0, n);
        let r: unknown;
        try { r = fn(...args); } catch { continue; }
        // async 的 export 餵垃圾引數會回一個必定 reject 的 promise,而沒人 await 的
        // rejection 會直接把 node 打死(掃全 terrain/ 時 `aeroway-renderer` 就是這樣
        // 炸的)。接住它,然後當成「不是我們要找的東西」。
        if (r && typeof (r as { then?: unknown }).then === 'function') {
          void (r as Promise<unknown>).catch(() => {});
          continue;
        }
        if (visit(r, args)) return true;
      }
    }
  } finally {
    console.warn = warn; console.error = error; console.log = log;
  }
  return false;
}

function makesMaterial(fn: (...a: unknown[]) => unknown): boolean {
  // 回傳的就是傳進去的那一個 → 它是「加工」不是「生產」(injectCloudShadow)。
  return probeReturns(fn, (r, args) => r instanceof THREE.Material && !args.includes(r));
}

/**
 * 回傳值專用的顏色判定 —— 比 `colourish()` **緊**,兩個地方刻意不一樣:
 *
 *  1. **不往物件裡遞迴。** `defaultStyleParams()` 回傳的 StyleParams 只要有一個
 *     顏色欄位,整支 `terrain-style-strategy` 就會被錯殺成「帶色票」,而它是
 *     三個世界都在用的介面。陣列只放行「每一個元素都是顏色」的那種。
 *  2. **排除 0,而且整數要寫成六位數 `0xrrggbb`。** 這是量到的假陽性:
 *     `day-night-lighting.ts` 的 `nightFactorFromElevation` / `nightKeyFloorGain`
 *     會 `return 0`,而同一支檔案裡有 `overcastColor: 0x000000`,於是
 *     `writtenAsHex(0)` 恆真 —— 兩個純粹的插值因子會被判成色票。
 *     代價是回傳純黑的顏色函式看不見,寫在這裡當作已知的下界。
 */
function returnedColour(v: unknown, src: string, depth = 0): boolean {
  if (v instanceof THREE.Color) return true;
  if (typeof v === 'string') {
    return HEX_STRING.test(v) || Object.prototype.hasOwnProperty.call(COLOR_NAMES, v.toLowerCase());
  }
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v <= 0 || v > 0xffffff) return false;
    return new RegExp(`0x${v.toString(16).padStart(6, '0')}\\b`, 'i').test(src);
  }
  if (depth === 0 && Array.isArray(v) && v.length > 0) {
    return v.every((e) => returnedColour(e, src, 1));
  }
  return false;
}

/**
 * 呼叫看看:回傳顏色的函式**也是色票**,只是穿了函式外衣。
 *
 * 這條是量出來補的。`plastic-materials.ts` 有 5 個這種 export
 * (`terrainColorForElevation` / `terrainVertexColor` 回 `THREE.Color`,
 * `roadColorForClass` / `buildingColorFromCoord` / `urbanColorForClass` 回
 * `0xrrggbb`),第一版全部把它們判成機制 —— 也就是說 `TREE_CANOPY_COLORS`
 * 那件事只要包成 `canopyColorFor(i)` 就整個躲過這支檢查。
 */
function returnsColour(fn: (...a: unknown[]) => unknown, src: string): boolean {
  return probeReturns(fn, (r) => returnedColour(r, src));
}

interface Finding { palettes: string[]; factories: string[] }

/** 挑出一個模組裡「這幾個名字」帶了色票或材質工廠。 */
function classify(ns: Record<string, unknown>, src: string, names: string[] | '*'): Finding {
  const wanted = names === '*' ? Object.keys(ns) : names;
  const out: Finding = { palettes: [], factories: [] };
  for (const name of wanted) {
    if (!(name in ns)) continue;                       // 型別、或這個 binding 執行期不存在
    const v = ns[name];
    if (v instanceof THREE.Material) { out.factories.push(name); continue; }
    if (typeof v === 'function') {
      const fn = v as (...a: unknown[]) => unknown;
      // 材質優先:生產材質的就算它同時也吐得出顏色,它仍然是材質工廠。
      if (makesMaterial(fn)) out.factories.push(name);
      else if (returnsColour(fn, src)) out.palettes.push(name);
      continue;
    }
    if (colourish(v, src)) out.palettes.push(name);
  }
  return out;
}

const nsCache = new Map<string, Record<string, unknown>>();
async function namespaceOf(file: string): Promise<Record<string, unknown>> {
  let ns = nsCache.get(file);
  if (!ns) {
    ns = (await import(file)) as Record<string, unknown>;
    nsCache.set(file, ns);
  }
  return ns;
}
const srcCache = new Map<string, string>();
function sourceOf(file: string): string {
  let s = srcCache.get(file);
  if (s === undefined) { s = readFileSync(file, 'utf8'); srcCache.set(file, s); }
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// 0. 分類器自己還活著嗎(兩個方向)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n[world boundary]');

check(`找得到三個世界`, WORLDS.length >= 3, WORLDS.join(' / '));

{
  const shelf = join(TERRAIN_DIR, 'plastic-materials.ts');
  const found = existsSync(shelf)
    ? classify(await namespaceOf(shelf), sourceOf(shelf), '*')
    : { palettes: [], factories: [] };
  check('分類器是活的:塑膠自己的貨架被判成「有色票」',
    found.palettes.length >= 8,
    `${found.palettes.length} 個: ${found.palettes.join(', ')}`);
  check('分類器是活的:同一份貨架也被判成「有材質工廠」',
    found.factories.length >= 5,
    `${found.factories.length} 個: ${found.factories.join(', ')}`);
  // 常數版與函式版是兩條各自獨立的路。只斷言總數的話,把 `returnsColour()` 整個
  // 拔掉仍然會綠 —— 11 個常數色票就把 `>= 8` 餵飽了。
  const ns = existsSync(shelf) ? await namespaceOf(shelf) : {};
  const fnPalettes = found.palettes.filter((n) => typeof ns[n] === 'function');
  check('分類器是活的:穿函式外衣的色票(回傳顏色的函式)也被抓出來',
    fnPalettes.length >= 5,
    `${fnPalettes.length} 個: ${fnPalettes.join(', ')}`);
}

{
  // 這幾支都是機制,而且**三個世界真的都在 import 它們**。任何一支被判成帶色票,
  // 這條規則就退化成「禁止所有 import」了。
  const MECHANISMS = ['sign-builder', 'bike-ornament', 'mountain-ring', 'acrylic-case',
    'cartoon-materials', 'terrain-style-strategy', 'sign-spec', 'cloud-shadow'];
  const noisy: string[] = [];
  for (const m of MECHANISMS) {
    const f = join(TERRAIN_DIR, `${m}.ts`);
    if (!existsSync(f)) { noisy.push(`${m}(檔案不見了)`); continue; }
    const found = classify(await namespaceOf(f), sourceOf(f), '*');
    const hits = [...found.palettes, ...found.factories];
    if (hits.length) noisy.push(`${m}: ${hits.join(', ')}`);
  }
  check('分類器不會亂咬:八支機制模組整包掃過,一個色票/材質工廠都沒有',
    noisy.length === 0, noisy.join(' | ') || `掃過 ${MECHANISMS.length} 支`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. 真正的 import 圖
// ═══════════════════════════════════════════════════════════════════════════

for (const world of WORLDS) {
  const root = join(TERRAIN_DIR, `${world}-terrain-style.ts`);
  const crossWorld: string[] = [];
  const leaks: string[] = [];
  const sharedSeen = new Set<string>();
  let bindingsChecked = 0;
  let edgesWalked = 0;

  const visited = new Set<string>([root]);
  const queue = [root];
  while (queue.length) {
    const file = queue.shift()!;
    for (const edge of parseEdges(sourceOf(file))) {
      const target = resolveSpec(file, edge.spec);
      if (target === undefined) continue;              // 外部套件
      if (target === null) {
        leaks.push(`${basename(file)} → ${edge.spec}(解析不到)`);
        continue;
      }
      edgesWalked++;
      const owner = ownerOf(target);
      if (owner && owner !== world) {
        // ❌ 跨世界。杯塔的錐度不是可以換皮的屬性,它**就是**那個世界。
        crossWorld.push(`${basename(file)} → ${basename(target)}`);
        continue;                                      // 不往下走,那不是我們的圖
      }
      if (owner === world) {
        // ✅ 自己的貨架。但要往下走 —— 不然「借自己的檔案去別人家拿」就是暗管。
        if (!visited.has(target)) { visited.add(target); queue.push(target); }
        continue;
      }
      // 共用模組:只看**真的被 import 進來**的那幾個名字。
      sharedSeen.add(basename(target));
      const names = edge.names;
      const ns = await namespaceOf(target);
      const found = classify(ns, sourceOf(target), names);
      bindingsChecked += names === '*' ? Object.keys(ns).length : names.length;
      for (const p of found.palettes) leaks.push(`${basename(target)}.${p}(色票)`);
      for (const f of found.factories) leaks.push(`${basename(target)}.${f}(材質工廠)`);
    }
  }

  const walked = [...visited].map((f) => basename(f)).sort().join(', ');
  check(`${world}: 沒有 import 任何別的世界的模組`,
    crossWorld.length === 0, crossWorld.join(' | ') || `走過 ${visited.size} 檔: ${walked}`);
  check(`${world}: 共用模組拿到的東西全是機制(沒有色票、沒有材質工廠)`,
    leaks.length === 0,
    leaks.join(' | ') || `${bindingsChecked} 個 binding / ${sharedSeen.size} 支共用模組: ${[...sharedSeen].sort().join(', ')}`);
  // 「記錄了 ≠ 送得到」:解析器要是壞掉、一條邊都沒走,上面兩條會安靜地全過。
  check(`${world}: (而且解析器真的走過這張圖)`,
    edgesWalked >= 5 && bindingsChecked >= 5,
    `${edgesWalked} 條邊 / ${bindingsChecked} 個 binding`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. 洗錢:共用模組自己去某個世界的貨架上拿東西
// ═══════════════════════════════════════════════════════════════════════════
//
// 第 1 段只看世界的根**直接**連出去的那幾條邊,所以它看不見「一支共用模組自己去
// 某個世界的貨架上拿色票,而三個世界都 import 它」。那就是 `cartoon-materials`
// 那個病換一個宿主。實測過:把 `TREE_CANOPY_COLORS` 的 import 加進 `sign-builder`
// (三個世界都 import 它),第 1 段當時的 13 條斷言**一條都沒紅**。

/** 一支共用模組伸手拿到的世界檔。`isRoot` = 它是不是那個世界的 `*-terrain-style.ts`。 */
interface WorldEdge { world: string; isRoot: boolean; label: string }

/**
 * 一支共用模組的判決。
 *
 * `registry` 是唯一的豁免,而它的定義**兩半都是必要條件**:
 *  ・拿到的每一個檔都是某個世界的**根** —— 伸手到 `plastic-materials.ts` 從來
 *    不是「派工」,那是拿造型。
 *  ・**三個世界一個都不能少** —— 只認識一個世界的不是登記處,是漏管。
 *
 * 少了「必須是根」那一半,`terrain-style-strategy.ts`(它本來就認識三個世界)
 * 只要再加一行 `from './plastic-materials'` 就永遠豁免,豁免條款自己變成暗管。
 */
function verdictFor(edges: readonly WorldEdge[]): 'clean' | 'registry' | 'leak' {
  if (!edges.length) return 'clean';
  if (!edges.every((e) => e.isRoot)) return 'leak';
  return new Set(edges.map((e) => e.world)).size === WORLDS.length ? 'registry' : 'leak';
}

{
  // 判決器的四個方向,餵的是**捏造的**邊 —— 不依賴磁碟上剛好長什麼樣。
  const roots: WorldEdge[] = WORLDS.map((w) => ({ world: w, isRoot: true, label: `${w}-terrain-style.ts` }));
  const shelf: WorldEdge = { world: WORLDS[0], isRoot: false, label: `${WORLDS[0]}-materials.ts` };
  const verdicts = [
    ['一條世界邊都沒有 → clean', verdictFor([]) === 'clean'],
    ['三個世界的根全到齊 → registry', verdictFor(roots) === 'registry'],
    ['只認識一個世界的根 → leak', verdictFor([roots[0]]) === 'leak'],
    ['三個世界全到齊、但多伸手拿了一個非根的檔 → leak', verdictFor([...roots, shelf]) === 'leak'],
  ] as const;
  const wrong = verdicts.filter(([, ok]) => !ok).map(([label]) => label);
  check('洗錢判定器是活的:四種捏造的邊都判對',
    wrong.length === 0, wrong.join(' | ') || `${verdicts.length} 種都對`);
}

{
  // 共用模組的**傳遞閉包**。走到世界檔就停(不往世界裡面走 —— 那是第 1 段的事),
  // 但世界檔本身還是要走,因為閉包是從世界的根長出來的。
  const sharedClosure = new Set<string>();
  const seenWorldFiles = new Set<string>();
  const queue: string[] = [];
  for (const w of WORLDS) {
    const root = join(TERRAIN_DIR, `${w}-terrain-style.ts`);
    seenWorldFiles.add(root);
    queue.push(root);
  }
  while (queue.length) {
    const file = queue.shift()!;
    for (const edge of parseEdges(sourceOf(file))) {
      const target = resolveSpec(file, edge.spec);
      if (!target) continue;                             // 外部套件 / 解析不到
      if (ownerOf(target)) {
        if (!seenWorldFiles.has(target)) { seenWorldFiles.add(target); queue.push(target); }
        continue;
      }
      if (!sharedClosure.has(target)) { sharedClosure.add(target); queue.push(target); }
    }
  }

  const registries: string[] = [];
  const launderers: string[] = [];
  let worldEdgesSeen = 0;
  for (const file of [...sharedClosure].sort()) {
    const edges: WorldEdge[] = [];
    for (const edge of parseEdges(sourceOf(file))) {
      const target = resolveSpec(file, edge.spec);
      if (!target) continue;
      const owner = ownerOf(target);
      if (!owner) continue;
      worldEdgesSeen++;
      edges.push({
        world: owner,
        isRoot: basename(target) === `${owner}-terrain-style.ts`,
        label: basename(target),
      });
    }
    const verdict = verdictFor(edges);
    if (verdict === 'clean') continue;
    const line = `${basename(file)} → ${[...new Set(edges.map((e) => e.label))].sort().join(', ')}`;
    (verdict === 'registry' ? registries : launderers).push(line);
  }

  check('沒有任何共用模組偷偷去某個世界的貨架上拿東西',
    launderers.length === 0,
    launderers.join(' | ') || `${sharedClosure.size} 支共用模組全乾淨`);
  // 「記錄了 ≠ 送得到」:閉包要是只長出兩三個檔,上面那條會安靜地全過。
  // 門檻取 8(今天是 10)—— 它要抓的是「解析器壞掉,閉包塌成 0」,不是「今天剛好
  // 幾支」。設成剛好等於現值就變成一條會被無關改動絆倒的鐵絲,不是活性斷言。
  check('(而且真的走過共用模組的傳遞閉包)',
    sharedClosure.size >= 8 && worldEdgesSeen >= WORLDS.length,
    `${sharedClosure.size} 支共用模組 / ${worldEdgesSeen} 條指向世界的邊: ` +
      [...sharedClosure].map((f) => basename(f)).sort().join(', '));
  // 豁免那條路徑必須真的被走到過,不然它是一段沒人執行過的程式碼。
  // 而且**只該有一個**派工的地方 —— 第二個出現時要有人看見。
  check('登記處豁免真的被走到,而且全 repo 只有一個',
    registries.length === 1, registries.join(' | ') || '(一個都沒有)');
}

// 探針材質可能被某個登記處收走了,拆掉再丟。
for (const m of probeMaterials) { unregisterNightLitMaterial(m as never); m.dispose(); }

console.log(`\n[world boundary] ${failures === 0 ? 'all clear' : `${failures} FAILURES`}`);
if (failures > 0 && !process.env.NO_EXIT_CODE) process.exitCode = 1;
