/**
 * `[zone plan vs demo]` — 兩條**分派規則**的逐件比對:分區→建築型別,以及踏面高度→
 * 色帶。兩者在 gameview 裡都早就存在,但都**沒有任何斷言把它們釘在 demo 上**。
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/zone-plan-vs-demo.ts
 *
 * ## 為什麼是這兩支
 *
 * `node scripts/headless-check/demo-coverage.mjs` 把 `pickBuildingKind` /
 * `bandPaint` / `zoneStuds` 三支列進積木世界的 **ABSENT**,而三支**都在**:
 *
 *   demo                  gameview                                     釘住它的檢查
 *   ────────────────────  ───────────────────────────────────────────  ─────────────
 *   pickBuildingKind      `plastic-terrain-style.ts` 的 ZONE_PLAN      **這一支**
 *                         + `plasticBuildingKind(seed, zone)`
 *   bandPaint             `quantized-terrain.ts` 的 per-cell 色帶       **這一支**(demo 側)
 *   zoneStuds             `ground-studs.ts` 的顏色分桶 + `colorFor`     diorama「底板凸點」
 *
 * 那份 ABSENT 是**誤判,而且是結構性的**:coverage 靠「函式體裡的 magic number」比
 * 對,而它的 `BORING` 表把 `0.8` / `0.5` / `0.4` / `3` 全部排除掉了 —— 這三支函式的
 * 指紋因此**都是空的**,ratio 退化成 0,判定完全等於「名字有沒有出現在 port 裡」。
 * 它的文件說「`absent` 才是可信的那一半」,對指紋空的函式並不成立。
 *
 * ## 這一支新增的是什麼(以及**不是**什麼)
 *
 * `terrain-band-vs-demo.ts` 已經把 `TERRAIN_BAND` / `STEP_H` / `bandAt` 逐階比完,
 * 也已經從 **gameview 側**證明了「基準面是路面不是 originEle」。它沒做的是
 * **執行 demo 的 `bandPaint`**:今天有人把 demo 的 `datum` 換成 originEle 或把列距
 * 從 3 m 改掉,沒有一條斷言會紅。§0.0 第 6 點講的就是這件事 ——「照抄」是一次性
 * 動作,「還是一樣」不是。
 *
 * 所以下面 B 段跑的是 demo 自己那段程式碼,而 A 段跑的是 demo 自己那張表。
 * 一個常數都沒有抄進這個檔案:門檻 0.8 與 0.5 是**用二分搜尋從 demo 的函式行為
 * 量出來的**,色階邊界是從 demo 的 `STEP_H` 推出來的。
 *
 * 折進 `diorama.ts` 的方式跟 `terrain-band-vs-demo.ts` 一樣:拿掉下面的 canvas
 * stub、把 `check` 換成 diorama 的、兩個區塊各包一層 `await block(...)`。
 */
import { readFileSync } from 'node:fs';

// ── Recording canvas stub ────────────────────────────────────────────────────
// 共用的那一份(理由見 `recording-canvas.ts`):貼圖快取是模組層、按寬度收的,
// 六份各自為政的 stub 讓「誰錄到什麼」由 import 順序決定,已經假通過過兩次。
// 這一支自己不看畫布,但 `createPlasticTerrainStyle()` 會畫底板貼圖,所以它需要
// 一個 canvas 在場 —— 而那個 canvas 必須是別人也看得到的同一個。
const { installRecordingCanvas } = await import('./recording-canvas.ts');
installRecordingCanvas();

const THREE = await import('three');
const { createPlasticTerrainStyle } = await import('@/game/terrain/plastic-terrain-style');
const { ZONE_KINDS } = await import('@/game/terrain/land-zone');
type ZoneKind = import('@/game/terrain/land-zone').ZoneKind;
type BuildingBox = import('@/game/terrain/terrain-style-strategy').BuildingBox;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
export function failureCount(): number { return failures; }

// ── Demo slicing ─────────────────────────────────────────────────────────────
/** The demo's OWN script block (block 0 is the bundled three.js). */
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
/** From `head` to the end of the statement it starts (first `;` at depth 0). */
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

const plasticSrc = demoScript('plan/plastic-town-demo.html');
const plastic = createPlasticTerrainStyle();

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[plastic zone→body plan vs demo]');
// ═════════════════════════════════════════════════════════════════════════════
//
// demo:「**80% 該區的招牌建築,20% 鄰近型別**。不硬對應 —— 分區只是「傾向」,一條街
// 上混一兩棟外來戶才像真的城市;全對應會變成五段各自純色的樣板街。」
//
// gameview 的 `plasticBuildingKind(seed, zone)` 是 module-private,而且它不吃 rng
// 而是**自己從 seed 發一條流**(它必須能被 `buildBuildingLights` 重推一次)。所以
// 這裡不去 import 它,改**從出貨物件反推**它的答案 —— 那也才是真的畫出來的那一份。
{
  const demo = new Function(`
    ${sliceStatement(plasticSrc, 'const ZONES = ')}
    ${sliceStatement(plasticSrc, 'const ZONE_PLAN = {')}
    ${sliceFn(plasticSrc, 'pickBuildingKind')}
    return { ZONES, ZONE_PLAN, pickBuildingKind };
  `)() as {
    ZONES: string[];
    ZONE_PLAN: Record<string, { main: string; near: string[] }>;
    pickBuildingKind: (zone: string, rng: () => number) => string;
  };

  check('demo 的 ZONES / ZONE_PLAN / pickBuildingKind 切得出來且可執行',
    demo.ZONES.length > 0 && typeof demo.pickBuildingKind === 'function',
    `${demo.ZONES.length} 區,ZONE_PLAN ${Object.keys(demo.ZONE_PLAN).length} 筆`);

  // ── demo 的三個答案,用**腳本化的 rng** 從它的函式行為問出來 ────────────────
  // 不讀 ZONE_PLAN 的欄位,而是餵值進去看它回什麼:表對了但函式接錯(例如把
  // near[0] / near[1] 反過來取)在讀表的版本裡是看不到的。
  const seq = (...v: number[]) => { let i = 0; return () => v[Math.min(i++, v.length - 1)]; };
  /** 這一區的 [main, near0, near1] —— demo 的函式自己說的。 */
  const answersOf = (z: string): [string, string, string] => [
    demo.pickBuildingKind(z, seq(0)),
    demo.pickBuildingKind(z, seq(1, 0)),
    demo.pickBuildingKind(z, seq(1, 1)),
  ];
  /**
   * 門檻:`rng()` 小於多少才回招牌建築。二分搜尋 demo 的**行為**,不抄它的 0.8
   * —— 抄過來的常數只會把當初打錯的東西再確認一遍(§0.0 第 5 點),而且 demo 改了
   * 0.8 的話這個數字要跟著動,下面那條頻率斷言才會紅。
   */
  const thresholdOf = (z: string): number => {
    const main = demo.pickBuildingKind(z, seq(0));
    let lo = 0, hi = 1;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      if (demo.pickBuildingKind(z, seq(mid, 0)) === main) lo = mid; else hi = mid;
    }
    return hi;
  };
  /** 落到 near 之後,再抽一次決定取哪一個 —— 同樣二分搜尋出來。 */
  const splitOf = (z: string): number => {
    const n0 = demo.pickBuildingKind(z, seq(1, 0));
    let lo = 0, hi = 1;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      if (demo.pickBuildingKind(z, seq(1, mid)) === n0) lo = mid; else hi = mid;
    }
    return hi;
  };

  const plans = demo.ZONES.map(answersOf);
  const thresholds = demo.ZONES.map(thresholdOf);
  const splits = demo.ZONES.map(splitOf);
  check('demo 每一區都問得出三個不同的型別(招牌 + 兩個鄰近)',
    plans.every((p) => new Set(p).size === 3),
    demo.ZONES.map((z, i) => `${z} ${plans[i].join('/')}`).join('  '));
  check('demo 的門檻與二選一的分點,五區一致(它是一條規則不是五條)',
    new Set(thresholds).size === 1 && new Set(splits).size === 1,
    `門檻 ${thresholds[0]},分點 ${splits[0]}`);
  const T = thresholds[0], S = splits[0];

  // ── 詞彙表:demo 的五區 = gameview 的五區,所以 demo 那個 `|| residential`
  //    fallback 對**詞彙內**的分區永遠碰不到 ────────────────────────────────
  check('ZONE_PLAN 的鍵剛好是 demo 的 ZONES(fallback 對詞彙內的分區是死碼)',
    [...demo.ZONES].sort().join(',') === Object.keys(demo.ZONE_PLAN).sort().join(','),
    Object.keys(demo.ZONE_PLAN).sort().join(','));
  check('而 gameview 的 ZONE_KINDS 就是 demo 的 ZONES',
    [...ZONE_KINDS].sort().join(',') === [...demo.ZONES].sort().join(','),
    [...ZONE_KINDS].sort().join(','));

  // demo 的 `zoneAt` 從來不回 null —— 這是 gameview 為什麼**必須自己發明**一個
  // 「沒有分區」的答案(`land-zone.ts`:「rural ≠ suburb」)。執行 demo 的產生器
  // 把它量出來,而不是憑印象斷言。
  {
    const zoneGen = new Function(`
      ${sliceFn(plasticSrc, 'mulberry32')}
      ${sliceStatement(plasticSrc, 'const ZONES = ')}
      ${sliceStatement(plasticSrc, 'const zoneRng = ')}
      ${sliceStatement(plasticSrc, 'const zoneSegs = [')}
      ${sliceFn(plasticSrc, 'extendZones')}
      ${sliceFn(plasticSrc, 'zoneAt')}
      return zoneAt;
    `)() as (d: number) => string;
    let outside = 0, n = 0;
    for (let d = -500; d < 20000; d += 7) {
      n++;
      if (!demo.ZONES.includes(zoneGen(d))) outside++;
    }
    check('demo 的 zoneAt 在 20 km 上一次都沒回過詞彙外的東西(所以 demo 沒被問過「沒有分區」)',
      outside === 0 && n > 1000, `${n} 個取樣點,${outside} 個詞彙外`);
  }

  // ── gameview 的答案:從出貨的量體反推 ───────────────────────────────────────
  //
  // 判別靠**結構**不是零件數:杯塔與黏土屋各自帶一種 `shape`,骨牌牆把點數
  // instancing、字母積木把字合併、抽抽樂塔沒有裝飾。猜「沒有特別形狀 ⇒ 抽抽樂塔」
  // 是 diorama 那條檢查第一版把學校當成塔的原因。
  const box: BuildingBox = {
    cx: 0, cz: 0, width: 12, depth: 26, rotY: 0, height: 12, baseY: 0, skirt: 0, color: 0,
  };
  const kindOf = (seed: number, zone: ZoneKind | null): string => {
    const parts = plastic.buildBuildingBoxes?.(box, seed, zone) ?? [];
    const shapes = new Set(parts.map((p) => p.shape ?? 'box'));
    if (shapes.has('cup')) return 'cup';
    if (shapes.has('clayCube')) return 'clay';
    const deco = plastic.buildBuildingDecoration(box, seed, zone);
    if (!deco) return 'stack';
    let instanced = false;
    deco.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) instanced = true; });
    deco.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g && g.userData.instanceTemplate !== true) g.dispose();
    });
    return instanced ? 'domino' : 'alphabet';
  };
  // 判別器自己要先被證明分得開五種 —— 不然下面的集合比對就是「三種裡永遠有一種
  // 抽不到」那類恆真句(最近一次踩到的形狀:一個世界只穿四色中的三色)。
  {
    const seen = new Set<string>();
    for (const z of ZONE_KINDS) for (let s = 0; s < 64; s++) seen.add(kindOf(s, z));
    check('這個 footprint 上五種量體都分得出來(判別器不是三選二)',
      seen.size === 5, `${[...seen].sort().join('/')}`);
  }

  // ① 逐 seed 的精確比對。
  //
  // gameview 的 rng 只吃 seed,**跟分區無關** —— 所以同一個 seed 在五個分區抽到的
  // 是**同一個索引**(招牌 / near0 / near1)。於是五個分區的答案合起來只能是三個
  // tuple 之一,而那三個 tuple 完全由 demo 的表決定,彼此不相交:
  //
  //   MAIN  = (clay, stack, cup, alphabet, domino)
  //   NEAR0 = (stack, alphabet, stack, clay, stack)
  //   NEAR1 = (domino, clay, domino, domino, cup)
  //
  // 這一條是**唯一**釘得住 `near[0]` / `near[1]` 順序的方式:兩者的機率都是 0.1,
  // 單看頻率把它們對調是完全等價的實作(§6.3 的「兩種實作在出貨的數字下等價」)。
  // 只在一個分區裡對調,它的答案就會離開這三個 tuple。
  const N_TUPLE = 2000;
  {
    const want = [0, 1, 2].map((j) => demo.ZONES.map((_z, i) => plans[i][j]).join(','));
    check('三個 tuple 互不相交(不然下面那條分不出 near 的順序)',
      new Set(want).size === 3, want.map((w, j) => `${['main', 'near0', 'near1'][j]} ${w}`).join(' | '));
    const hit = [0, 0, 0];
    let bad = 0, firstBad = '';
    for (let s = 0; s < N_TUPLE; s++) {
      const got = ZONE_KINDS.map((z) => kindOf(s, z)).join(',');
      const j = want.indexOf(got);
      if (j < 0) { bad++; if (!firstBad) firstBad = `seed ${s} → (${got})`; } else hit[j]++;
    }
    check('每一個 seed 的五區答案都是 demo 那張表的三個 tuple 之一',
      bad === 0, firstBad || `${N_TUPLE} 個 seed 全中`);
    check('而且三個 tuple 都真的出現過(不是永遠只抽到招牌那一個)',
      hit.every((h) => h > 0), `main ${hit[0]} / near0 ${hit[1]} / near1 ${hit[2]}`);
  }

  // ② 傾向而不是對應:招牌的比例必須是 demo 那個門檻。
  //
  // 只問住宅一區就夠 —— ① 已經證明索引跟分區無關,而住宅的三個答案互不相同,所以
  // 一次 `kindOf` 就讀得出索引。兩條 rng 流不一樣(gameview 的種子變換是它自己的),
  // 所以這裡必然是統計的;N 選在「±0.008 的容差 ≈ 4σ」上,量得到的解析度是
  // 門檻差 0.008 / 分點差 0.04。
  {
    const N = 24000;
    const [rMain, rNear0, rNear1] = plans[demo.ZONES.indexOf('residential')];
    const tally: Record<string, number> = { [rMain]: 0, [rNear0]: 0, [rNear1]: 0 };
    let stray = 0;
    for (let s = 0; s < N; s++) {
      const k = kindOf(s, 'residential');
      if (k in tally) tally[k]++; else stray++;
    }
    const TOL = 0.008;
    const share = (k: string) => tally[k] / N;
    check('住宅區只抽得到 demo 那三種', stray === 0, `${stray} 個離群`);
    check(`招牌建築的比例 = demo 的門檻 ${T}`,
      Math.abs(share(rMain) - T) < TOL,
      `${share(rMain).toFixed(4)} vs ${T}(N = ${N},容差 ${TOL})`);
    check(`鄰近型別各佔 (1 − ${T}) × ${S} 與 (1 − ${T}) × (1 − ${S})`,
      Math.abs(share(rNear0) - (1 - T) * S) < TOL
      && Math.abs(share(rNear1) - (1 - T) * (1 - S)) < TOL,
      `${share(rNear0).toFixed(4)} / ${share(rNear1).toFixed(4)}`
        + ` vs ${((1 - T) * S).toFixed(4)} / ${((1 - T) * (1 - S)).toFixed(4)}`);
    // 反向對照:如果它退化成硬對應(比例 1.0),上面那條也會紅,但這條說得更明白。
    check('反向對照:它不是硬對應(招牌沒有吃掉全部)', share(rMain) < 1 - 1e-9,
      `${(1 - share(rMain)).toFixed(4)} 是外來戶`);
  }

  // ③ 同一個 (seed, zone) 問兩次要一樣。`buildBuildingLights` 得再推一次同一個
  //    答案,所以這不是隨手加的性質,是它的合約。
  {
    let unstable = 0;
    for (let s = 0; s < 200; s++) {
      for (const z of ZONE_KINDS) if (kindOf(s, z) !== kindOf(s, z)) unstable++;
    }
    check('同一個 (seed, zone) 問兩次是同一個量體(lights 要重推它)', unstable === 0);
  }

  // ④ **刻意的分歧,斷言下來**(§0.0 第 7 點):沒有分區時 demo 會退回住宅的那一
  //    份計畫,gameview 不會 —— 它給一個固定的量體,而且不擲骰。理由在
  //    `land-zone.ts` 開頭:`null` 不是住宅,把它讀成住宅會讓鄉間路變成郊區。
  //    上面已經量過 demo 的 `zoneAt` 從來不回 null,所以這一格是 demo 沒被問到的。
  {
    const unzoned = new Set<string>();
    for (let s = 0; s < 512; s++) unzoned.add(kindOf(s, null));
    const demoFallback = new Set<string>();
    for (const j of [0, 1, 2]) demoFallback.add(plans[demo.ZONES.indexOf('residential')][j]);
    check('沒有分區時 gameview 不擲骰(每個 seed 同一個量體)', unzoned.size === 1,
      [...unzoned].join('/'));
    check('而且那個量體不是 demo fallback 的招牌(null ≠ residential,刻意的分歧)',
      ![...unzoned].includes(plans[demo.ZONES.indexOf('residential')][0]),
      `gameview ${[...unzoned][0]} vs demo fallback 的招牌 ${plans[demo.ZONES.indexOf('residential')][0]}`);
    // 反向對照:有分區的時候它**會**擲骰 —— 不然上面那條只是在說「它什麼都不做」。
    const zoned = new Set<string>();
    for (let s = 0; s < 512; s++) zoned.add(kindOf(s, 'residential'));
    check('反向對照:有分區的時候它會擲骰', zoned.size === 3, [...zoned].sort().join('/'));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[plastic band datum vs demo — bandPaint]');
// ═════════════════════════════════════════════════════════════════════════════
//
// demo 的 `bandPaint(geo, d0, d1)` 把一段走廊底板的頂點依「**高過該橫斷面道路**的
// 階數」上色,而它的註解說得很清楚為什麼是那個基準面:
//
// > 基準面是那個斷面上的**路面**(`datum`),不是 originEle —— 用 originEle 的話新舊
// > chunk 之間會出現一道顏色接縫。
//
// gameview 用**不同的機制**做同一件事(`quantized-terrain.ts`:一格一色、色從
// `bandAt(qLevelY − datum)` 來),而 `terrain-band-vs-demo.ts` 已經從 gameview 側
// 驗過那條規則。這裡補的是**demo 側**:把 `bandPaint` 切出來執行,證明它量的真的
// 是「路面之上幾階」,而不是絕對高度、也不是整段共用一個基準面。
{
  /** 注入的 `pathAt` —— 每一條 run 換一次。 */
  let pathY: (d: number) => number = () => 0;
  const demo = new Function('THREE', 'pathAt', `
    ${sliceStatement(plasticSrc, 'const TERRAIN_BAND = [')}
    ${sliceStatement(plasticSrc, 'const STEP_H = ')}
    ${sliceStatement(plasticSrc, 'const bandAt = (y) =>')}
    ${sliceFn(plasticSrc, 'bandPaint')}
    return { TERRAIN_BAND, STEP_H, bandAt, bandPaint };
  `)(THREE, (d: number) => ({ y: pathY(d) })) as {
    TERRAIN_BAND: { top: string; side: string }[];
    STEP_H: number;
    bandAt: (y: number) => { top: string; side: string };
    bandPaint: (geo: THREE.BufferGeometry, d0: number, d1: number) => void;
  };

  check('demo 的 bandPaint 切得出來且可執行', typeof demo.bandPaint === 'function',
    `${demo.TERRAIN_BAND.length} 階,STEP_H = ${demo.STEP_H}`);
  const S = demo.STEP_H;
  // 非整數階也能直接比,因為兩邊的階高是**同一個數字**。這一條是下面所有斷言的
  // 前提,所以擺在這裡讓它自己說話(`terrain-band-vs-demo.ts` 另外釘著它)。
  check('demo 的 STEP_H 就是 gameview 的 params.layerHeight',
    S === plastic.params.layerHeight, `${S} vs ${plastic.params.layerHeight}`);

  /**
   * 一段假的 `ribbonSeg` 產物:`rows + 1` 個橫斷面 × `cols` 個頂點,逐斷面吐出
   * —— 那正是 `bandPaint` 反推列號的依據。
   *
   * ⚠ `d1 - d0` 選成 `3 * rows`,因為 demo 的列數是 `ceil((d1 - d0) / 3)`。**沒有
   *   把 3 抄進來當常數**:下面 run B 只有在兩邊的列數對得上時才會全部落在第 0 階,
   *   所以 demo 把列距從 3 m 改掉的話,run B 就會紅 —— 那個 3 是被斷言蓋住的,不是
   *   被假設的。
   */
  const ROWS = 8;
  const D0 = 0, D1 = 3 * ROWS;
  const mkGeo = (cols: number, yOf: (row: number, col: number) => number) => {
    const pos: number[] = [];
    for (let r = 0; r <= ROWS; r++) {
      for (let c = 0; c < cols; c++) pos.push(c * 10, yOf(r, c), -r * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return g;
  };
  const hexOf = (c: THREE.Color): string => `#${c.getHexString()}`;
  /** 每一列的顏色(逐列取第一個頂點;同列同高 → 同色)。 */
  const rowColors = (
    cols: number, yOf: (row: number, col: number) => number, py: (d: number) => number,
  ): string[] => {
    pathY = py;
    const g = mkGeo(cols, yOf);
    demo.bandPaint(g, D0, D1);
    const col = g.getAttribute('color') as THREE.BufferAttribute;
    const perRow = col.count / (ROWS + 1);
    const out: string[] = [];
    for (let r = 0; r <= ROWS; r++) {
      const i = r * perRow;
      out.push(hexOf(new THREE.Color(col.getX(i), col.getY(i), col.getZ(i))));
    }
    g.dispose();
    return out;
  };

  // 一條**非線性**的路面。線性的路面對「列號→里程」的映射太寬容 —— 映射錯一格,
  // 線性的還是線性的;非線性的一錯就對不上。
  const roadOf = (d: number) => S * ((d / 3) ** 2) / 4;

  // ── run A:路面平的,地面一階一階往上 ──────────────────────────────────────
  const runA = rowColors(3, (r) => r * S, () => 0);
  {
    const want = Array.from({ length: ROWS + 1 }, (_, r) =>
      demo.TERRAIN_BAND[Math.min(demo.TERRAIN_BAND.length - 1, r)].top);
    check('路面平、地面逐階上升 → 顏色照色帶一階一階走,到表尾停住',
      runA.join(' ') === want.join(' '), runA.join(' '));
    check('反向對照:這一條真的用到了整張表(不是全部同一色)',
      new Set(runA).size === demo.TERRAIN_BAND.length,
      `${new Set(runA).size}/${demo.TERRAIN_BAND.length} 階`);
  }

  // ── run B:地面完全一樣,但路面跟著它一起爬(非線性)──────────────────────
  // 全部第 0 階,才叫「基準面是那個斷面上的路面」。如果 `datum` 取的是 d0、是整段
  // 的平均、或是一個絕對高度,這裡會爬上色帶。
  const runB = rowColors(3, (r) => roadOf(D0 + (r / ROWS) * (D1 - D0)), roadOf);
  {
    const base = demo.TERRAIN_BAND[0].top;
    check('路面跟地面一起爬(非線性)→ 每一列都是第 0 階',
      runB.every((c) => c === base), runB.join(' '));
  }

  // ── run C:B 再整個抬高一千公尺 ────────────────────────────────────────────
  // 逐位元組等於 B。這一條擋的是「拿絕對高度或 originEle 當基準面」。
  const runC = rowColors(3, (r) => roadOf(D0 + (r / ROWS) * (D1 - D0)) + 1000, (d) => roadOf(d) + 1000);
  check('整個世界抬高 1000 m,顏色一格不動(基準面跟著路走,不是 originEle)',
    runC.join(' ') === runB.join(' '), runC.join(' '));

  // ── run D:只抬地面、不抬路面 ──────────────────────────────────────────────
  // 全部往上兩階 —— 證明上面那三條不是「它其實什麼都沒量」。
  const runD = rowColors(3, (r) => roadOf(D0 + (r / ROWS) * (D1 - D0)) + 2 * S, roadOf);
  check('只把地面抬兩階(路面不動)→ 每一列都是第 2 階',
    runD.every((c) => c === demo.TERRAIN_BAND[2].top), runD.join(' '));

  // ── run E:同一列上橫向掃過整個色階,逐頂點跟 gameview 的 bandAt 對 ─────────
  //
  // 掃描點從 demo 的 `STEP_H` 推出來:每一個 `Math.round` 邊界的兩側各 0.1 m,
  // 外加遠低於路面與遠高於表尾的兩個夾住點。這一條同時證明兩件事:demo 的
  // `bandPaint` 寫進去的就是 `bandAt(above)`,而 gameview 的 `bandAt` 逐點同意它。
  {
    const above: number[] = [-99 * S, 0, 99 * S];
    for (let k = 0; k <= demo.TERRAIN_BAND.length; k++) {
      above.push((k + 0.5) * S - 0.1, (k + 0.5) * S + 0.1);
    }
    pathY = () => 100;
    const g = mkGeo(above.length, (_r, c) => 100 + above[c]);
    demo.bandPaint(g, D0, D1);
    const col = g.getAttribute('color') as THREE.BufferAttribute;
    let bad = 0, firstBad = '';
    const seen = new Set<string>();
    for (let i = 0; i < col.count; i++) {
      const a = above[i % above.length];
      const got = hexOf(new THREE.Color(col.getX(i), col.getY(i), col.getZ(i)));
      const want = hexOf(plastic.bandAt!(a).top);
      seen.add(got);
      if (got !== want) { bad++; if (!firstBad) firstBad = `above ${a} → demo ${got} vs gameview ${want}`; }
    }
    g.dispose();
    check('橫向掃過整個色階,demo 的 bandPaint 每一個頂點都等於 gameview 的 bandAt',
      bad === 0, firstBad || `${col.count} 個頂點,${above.length} 個高差`);
    check('反向對照:掃描點真的跨過每一個 round 邊界(整張表都被用到)',
      seen.size === demo.TERRAIN_BAND.length,
      `用到 ${seen.size}/${demo.TERRAIN_BAND.length} 階`);
    // 邊界的兩側必須落在**不同**階 —— 不然「±0.1 跨過邊界」只是句話。
    let straddled = 0;
    for (let k = 0; k < demo.TERRAIN_BAND.length - 1; k++) {
      const lo = hexOf(plastic.bandAt!((k + 0.5) * S - 0.1).top);
      const hi = hexOf(plastic.bandAt!((k + 0.5) * S + 0.1).top);
      if (lo !== hi) straddled++;
    }
    check('每一個 round 邊界的兩側真的分屬相鄰兩階',
      straddled === demo.TERRAIN_BAND.length - 1,
      `${straddled}/${demo.TERRAIN_BAND.length - 1} 個邊界`);
  }
}

console.log(`\n[zone plan vs demo] ${failures === 0 ? 'all clear' : `${failures} FAILURES`}`);
if (failures > 0 && !process.env.NO_EXIT_CODE) process.exitCode = 1;
