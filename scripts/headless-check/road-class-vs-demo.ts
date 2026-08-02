/**
 * `[road class + side wall vs demo]` — 兩件移植的稽核,共用同一份 demo 切片。
 *
 * 兩件事都是「demo 有答案、而 gameview 自己發明了一個」的例子:
 *
 *  1. **阻焊邊是製程參數**。電子 demo 的原話:「固定 1 公尺,不隨等級縮放」。
 *     它因此**一種寬度一張貼圖**(`busTexture(w)` / `busMatFor(cls)`)。gameview
 *     曾經只有一張 `m = 16`(12.5%)的貼圖,於是邊寬變成路寬的固定百分比 ——
 *     高速公路 1.50 m、次要道路 0.50 m。這裡驗的是**規則**不是數值:
 *     每一級換算回世界都必須是同一個公尺數,而那個公尺數從 demo 讀,不是抄的。
 *  2. **板子的側牆**(`sideWallSeg`)。積木與電子的板子各有一道九公尺的側牆,
 *     而瓦楞紙 demo **自己把它刪掉了**(地台是切割墊本身,沒有紙板就沒有切口)。
 *     所以「瓦楞紙沒有側牆」是一條要被斷言的規則,不是漏做。
 *
 * 做法一律是 CUSTOM_WORLD_INSTRUCTIONS §0.0 第 5 點:**把 demo 的函式從 HTML 切
 * 出來執行再逐項比對**,不跟抄進這個檔案的常數比 —— 抄過來的常數只會把當初打錯
 * 的東西再確認一遍。
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/road-class-vs-demo.ts
 *
 * 折進 `diorama.ts` 的方式跟 `terrain-band-vs-demo.ts` 一樣:拿掉下面的 canvas
 * stub(diorama 自己有一個)、把 `check` 換成 diorama 的、三個區塊各包一層
 * `await block(...)`。
 */
import { readFileSync } from 'node:fs';

// ── Recording canvas stub ────────────────────────────────────────────────────
// 這一份**不再是自己的**。它原本住在這個檔案裡,單獨跑得很好;接進 diorama 之後
// 才發現貼圖快取是按寬度收的模組層狀態 —— 第一個畫某個寬度的檢查決定了所有人拿到
// 的畫布,而 diorama 那份不會錄。所以 stub 搬到 `recording-canvas.ts`,誰先跑都一樣。
// (只有在**單獨**執行這支時,下面這行才是真的在裝;走 diorama 的話它早就裝好了。)
const { installRecordingCanvas } = await import('./recording-canvas.ts');
type Op = import('./recording-canvas.ts').Op;
type RecCanvas = import('./recording-canvas.ts').RecCanvas;
installRecordingCanvas();

const THREE = await import('three');
const { createTerrainStyleStrategy } = await import('@/game/terrain/terrain-style-strategy');
const { buildQuantizedCorridorGeometry, quantizedDataToGeometry } =
  await import('@/game/terrain/quantized-terrain');
const { buildRoadMeshes } = await import('@/game/terrain/road-renderer');
const { DRAWN_ROAD_CLASSES } = await import('@/game/terrain/road-classes');
const { OVERLAY_RANK } = await import('@/game/terrain/overlay-depth');

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
const paperSrc = demoScript('plan/paper-town-demo.html');
const circuitSrc = demoScript('plan/circuit-town-demo.html');

const plastic = await createTerrainStyleStrategy('plastic');
const paper = await createTerrainStyleStrategy('paper');
const circuit = await createTerrainStyleStrategy('circuit');

/** The MVT classes both renderers actually draw — the policy, not a copy of it. */
const CLASSES = [...DRAWN_ROAD_CLASSES].sort();

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[circuit bus texture vs demo]');
// ═════════════════════════════════════════════════════════════════════════════
const circuitDemo = new Function(`
  ${sliceStatement(circuitSrc, 'const TS = ')}
  ${sliceFn(circuitSrc, 'mulberry32')}
  ${sliceFn(circuitSrc, 'cv')}
  ${sliceStatement(circuitSrc, 'const E = {')}
  ${sliceStatement(circuitSrc, 'const BUS_MASK = ')}
  ${sliceStatement(circuitSrc, 'const ROAD_W = {')}
  ${sliceStatement(circuitSrc, 'const busTexCache = new Map();')}
  ${sliceFn(circuitSrc, 'busTexture')}
  ${sliceFn(circuitSrc, 'taperLen')}
  ${sliceStatement(circuitSrc, 'const ROAD_CLASSES = ')}
  ${sliceStatement(circuitSrc, 'const ROAD_WEIGHT = ')}
  ${sliceStatement(circuitSrc, 'const ROAD_SEG_MIN = ')}
  ${sliceStatement(circuitSrc, 'const roadSegs = ')}
  ${sliceStatement(circuitSrc, 'const roadRng = ')}
  ${sliceFn(circuitSrc, 'extendRoads')}
  ${sliceFn(circuitSrc, 'busWidthAt')}
  return { BUS_MASK, ROAD_W, busTexture, E, taperLen, busWidthAt, roadSegs, extendRoads };
`)() as {
  BUS_MASK: number;
  ROAD_W: Record<string, number>;
  busTexture: (w: number) => RecCanvas;
  E: Record<string, string>;
  /** 換級處的錐段長 —— demo 的一行:`Math.abs(wa - wb) / 2`。 */
  taperLen: (wa: number, wb: number) => number;
  /** 這個里程的走線寬度(段內固定,換級處走 45° 梯形)。 */
  busWidthAt: (d: number) => number;
  roadSegs: { d0: number; d1: number; cls: string }[];
  extendRoads: (d: number) => void;
};

check('demo 的 BUS_MASK / busTexture 切得出來',
  circuitDemo.BUS_MASK > 0 && typeof circuitDemo.busTexture === 'function',
  `BUS_MASK = ${circuitDemo.BUS_MASK} m,demo 的 ROAD_W = ${JSON.stringify(circuitDemo.ROAD_W)}`);

/** gameview 這一級的路面貼圖畫了什麼(從真的材質上取,不重跑一次它的程式碼)。 */
function gameviewBusOps(cls: string): Op[] {
  const mat = circuit.createRoadMaterial(0x3a3a3a, cls) as THREE.MeshToonMaterial;
  const canvas = mat.map?.image as RecCanvas | undefined;
  if (!canvas || !Array.isArray(canvas.ops)) {
    throw new Error(`circuit road material for ${cls} has no recorded canvas`);
  }
  return canvas.ops;
}
/** 阻焊邊的高度(px):畫布上下兩端那兩塊 maskLo 的填色。 */
function maskPx(ops: Op[]): number {
  const lo = circuitDemo.E.maskLo.toLowerCase();
  const bands = ops.filter((o) => o.kind === 'fillRect' && o.style.toLowerCase() === lo);
  if (bands.length !== 2) throw new Error(`expected 2 solder-mask bands, got ${bands.length}`);
  const top = bands.find((o) => o.b === 0);
  if (!top) throw new Error('no top solder-mask band');
  return top.d;
}
const sameOps = (a: Op[], b: Op[]): boolean =>
  a.length === b.length && a.every((o, i) => (
    o.kind === b[i].kind && o.a === b[i].a && o.b === b[i].b && o.c === b[i].c
    && o.d === b[i].d && o.alpha === b[i].alpha && o.lineWidth === b[i].lineWidth
    && o.style.toLowerCase() === b[i].style.toLowerCase()
  ));

{
  // ── 寬度表本身 ──
  // 以前這裡寫著「寬度餵 gameview 的表(那是刻意的偏離)」。那個偏離**已經取消**:
  // 杜邦線移植進來之後,demo 壓縮寬度的理由(路線貼著匯流排一側走,DUP_LAT 3.9,
  // 半寬 2 m 的巷弄接不住它)在 gameview 也成立了,所以表就是 demo 的 ROAD_W。
  let bad = 0;
  for (const cls of CLASSES) {
    if (circuit.roadWidth(cls) !== circuitDemo.ROAD_W[cls]) bad++;
  }
  check('六級的寬度逐級等於 demo 的 ROAD_W(不是壓縮過的另一張表)', bad === 0,
    CLASSES.map((c) => `${c} ${circuit.roadWidth(c)}/${circuitDemo.ROAD_W[c]}`).join(' '));

  // demo 的原話:「再**收斂成四個偶數線寬**(8 / 10 / 12 / 14),六級對四寬」,以及
  // 「材質按**寬度**收 —— 六級只有四個寬度」。這個後果要被**斷言下來**,不然下一個
  // 人會把它當成漏做的分級去「修好」:六級之中有兩對在**寬度上分不出來**,而這個
  // 世界的路面只有一種造型(鍍金匯流排)、貼圖是寬度的函式,所以那兩對在 3D 裡是
  // 同一條路。哪兩對是 demo 決定的,從 demo 讀。
  const widthOf = (cls: string): number => circuitDemo.ROAD_W[cls];
  const demoPairs = CLASSES.flatMap(
    (a, i) => CLASSES.slice(i + 1).filter((b) => widthOf(a) === widthOf(b)).map((b) => `${a}=${b}`));
  const gvPairs = CLASSES.flatMap(
    (a, i) => CLASSES.slice(i + 1)
      .filter((b) => circuit.roadWidth(a) === circuit.roadWidth(b)).map((b) => `${a}=${b}`));
  check('撞寬的那幾對跟 demo 完全一樣(六級 → 四寬,是規格不是漏做)',
    demoPairs.length > 0 && demoPairs.join(',') === gvPairs.join(','),
    `${new Set(CLASSES.map(widthOf)).size} 種寬度 / ${CLASSES.length} 級,撞寬:${demoPairs.join(' ')}`);
  check('撞寬的兩級因此共用同一份材質(= 同一個 draw call),而不同寬的不共用',
    demoPairs.every((p) => {
      const [a, b] = p.split('=');
      return circuit.createRoadMaterial(0x3a3a3a, a) === circuit.createRoadMaterial(0x3a3a3a, b);
    })
    && circuit.createRoadMaterial(0x3a3a3a, 'motorway')
      !== circuit.createRoadMaterial(0x3a3a3a, 'minor'));
}

{
  // 逐級跑 **demo 自己的** busTexture,拿它畫下來的每一筆跟 gameview 的比。
  let bad = 0;
  const detail: string[] = [];
  for (const cls of CLASSES) {
    const w = circuit.roadWidth(cls);
    const demoOps = circuitDemo.busTexture(w).ops;
    const gvOps = gameviewBusOps(cls);
    if (!sameOps(demoOps, gvOps)) {
      bad++;
      if (bad <= 3) {
        const n = Math.min(demoOps.length, gvOps.length);
        let at = -1;
        for (let i = 0; i < n; i++) if (!sameOps([demoOps[i]], [gvOps[i]])) { at = i; break; }
        detail.push(`${cls} (w=${w}): ops ${demoOps.length} vs ${gvOps.length}`
          + (at >= 0 ? `, first diff #${at} ${JSON.stringify(demoOps[at])} vs ${JSON.stringify(gvOps[at])}` : ''));
      }
    }
  }
  check('每一級的貼圖跟 demo 的 busTexture(w) 逐筆相同(fillRect + 130 道刷痕)',
    bad === 0, detail.join(' | ') || `${CLASSES.length} 級全對`);
}

{
  // ── 規則本身 ──
  // 阻焊邊是**製程參數**:換算回世界公尺,每一級都必須是同一個數字,而那個數字
  // 是 demo 的 BUS_MASK。容差只有貼圖自己的量化(128 texel 上 round 最多差半格
  // → w/256 公尺),不是隨手挑的。
  const rows = CLASSES.map((cls) => {
    const w = circuit.roadWidth(cls);
    const px = maskPx(gameviewBusOps(cls));
    return { cls, w, px, meters: w * px / 128 };
  });
  let bad = 0;
  for (const r of rows) if (Math.abs(r.meters - circuitDemo.BUS_MASK) > r.w / 256) bad++;
  check('阻焊邊在**世界裡**每一級都是同一個公尺數,而且等於 demo 的 BUS_MASK',
    bad === 0,
    rows.map((r) => `${r.cls} ${r.w}m→${r.px}px=${r.meters.toFixed(3)}m`).join('  '));

  // 反向:它**不可以**是貼圖上的固定比例。舊版就是 16 px(12.5%)一路到底,而那
  // 個版本在這一行上會通過上面那條嗎?不會 —— 但只有這一行證明得了「px 有跟著
  // 寬度變」,而不是「碰巧都算出 1.0」。
  const pxs = new Set(rows.map((r) => r.px));
  check('阻焊邊在**貼圖上**不是固定比例(px 隨等級變)',
    pxs.size === new Set(rows.map((r) => r.w)).size && pxs.size > 1,
    `${rows.length} 級 → ${pxs.size} 種 px:${[...pxs].sort((a, b) => a - b).join('/')}`);

  // 而且窄路的綠邊要比寬路**寬**(固定公尺數除以較小的寬度)。方向錯了的話
  // 上面兩條仍然會過(例如把 128*BUS_MASK/w 寫成 128*w/BUS_MASK 的倒數對稱式)。
  const byW = [...rows].sort((a, b) => a.w - b.w);
  check('窄路的阻焊邊佔貼圖的比例比寬路大(方向)',
    byW[0].px > byW[byW.length - 1].px,
    `最窄 ${byW[0].cls} ${byW[0].px}px > 最寬 ${byW[byW.length - 1].cls} ${byW[byW.length - 1].px}px`);
}

{
  // demo:「材質按**寬度**收,不是按等級收」。現行表六級六寬,所以撞號的情況今天
  // 一次都不會發生 —— 只斷言「六份材質」等於斷言了一個永遠成立的巧合。改成驗
  // **機制**:key 必須是寬度,這樣換一張撞寬的表也還是對的。
  let bad = 0;
  for (const cls of CLASSES) {
    if (circuit.roadMaterialKey?.(cls) !== String(circuit.roadWidth(cls))) bad++;
  }
  check('材質的 key 是寬度不是等級(demo `busMats`)', bad === 0,
    CLASSES.map((c) => `${c}→${circuit.roadMaterialKey?.(c)}`).join(' '));
  check('同一級問兩次拿到同一份材質(strategy 擁有的 singleton)',
    circuit.createRoadMaterial(0x3a3a3a, 'minor') === circuit.createRoadMaterial(0x3a3a3a, 'minor'));
  check('另外兩個世界不宣告 key,六級共用一份材質',
    plastic.roadMaterialKey === undefined && paper.roadMaterialKey === undefined);
}

{
  // 跑道(`aeroway-renderer`)沒有 MVT 的道路等級,而它會在拿到的材質上蓋自己的
  // `applyOverlayDepth('aeroway')`。共用實例的話那一下會把整條路的深度階改掉。
  const road = circuit.createRoadMaterial(0x3a3a3a, 'primary');
  const runway1 = circuit.createRoadMaterial(0x9a9a9a);
  const runway2 = circuit.createRoadMaterial(0x9a9a9a);
  check('沒有等級時回傳的是**新的一份**(跑道會在上面改 polygonOffset)',
    runway1 !== road && runway2 !== road && runway1 !== runway2);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[circuit 45° taper at a class change vs demo]');
// ═════════════════════════════════════════════════════════════════════════════
{
  // ── 錐段長:demo 的 `taperLen(wa, wb) = |wa − wb| / 2` ──
  //
  // ⚠ **只餵這張表的寬度是測不出那個除數的。** 8/10/12/14 兩兩相減永遠是偶數,
  // 所以 `Δ/2`、`Math.round(Δ/2)`、`Math.ceil(Δ/2)`、`Math.floor(Δ/2)` 在出貨的
  // 每一個寬度組合上**捨入結果完全相同** —— 這個專案最近兩輪的突變盲點就是這種
  // (`round(w/22)` 對 `round(w/21)`)。所以下面刻意挑**奇數差**去問這支純函式:
  // Δ = 3 / 5 / 7 時 L = 1.5 / 2.5 / 3.5,四種寫法互不相同,除數才真的被看見。
  const oddPairs: [number, number][] = [[9, 14], [7, 10], [5, 12], [8, 13]];
  const evenPairs: [number, number][] = CLASSES.flatMap(
    (a) => CLASSES.map((b) => [circuitDemo.ROAD_W[a], circuitDemo.ROAD_W[b]] as [number, number]));
  const taperBad = [...oddPairs, ...evenPairs].filter(
    ([a, b]) => Math.abs(circuit.roadTaperLength!(a, b) - circuitDemo.taperLen(a, b)) > 1e-12);
  check('錐段長逐對等於 demo 的 taperLen —— 含奇數差(除數看得見的那幾組)',
    taperBad.length === 0,
    oddPairs.map(([a, b]) => `${a}↔${b}→${circuit.roadTaperLength!(a, b)}`).join(' ')
    + ` / ${evenPairs.length} 組出貨寬度全對`);
  // 證明 fixture 挑對了,而且證明「只用出貨的寬度」挑不對:
  //  ・奇數差:`Δ/2` 跟 round / ceil / floor / Δ/3 / Δ/2.5 **每一個都不同**;
  //  ・偶數差(這張表的全部):round / ceil / floor 跟 `Δ/2` **完全一樣** —— 換句話
  //    說,如果只餵出貨的寬度,有人在除法外面包一層 round 這裡是看不見的。
  const variants = (d: number): number[] =>
    [Math.round(d / 2), Math.ceil(d / 2), Math.floor(d / 2), d / 3, d / 2.5];
  check('(而且那幾組奇數差讓每一種捨入/除數寫法都算出不同的錐長 —— 證明 fixture 挑對了)',
    oddPairs.every(([a, b]) => {
      const d = Math.abs(a - b);
      return variants(d).every((v) => v !== d / 2);
    })
    && evenPairs.every(([a, b]) => {
      const d = Math.abs(a - b);
      return [Math.round(d / 2), Math.ceil(d / 2), Math.floor(d / 2)].every((v) => v === d / 2);
    }),
    oddPairs.map(([a, b]) => {
      const d = Math.abs(a - b);
      return `Δ${d}: /2=${d / 2} vs ${variants(d).join('/')}`;
    }).join(' | ')
    + ' ‖ 偶數差在三種捨入下全部相同(所以出貨寬度單獨測不出除數)');
  check('另外兩個世界不宣告錐段(它們的路寬是一刀切,幾何一格沒動)',
    plastic.roadTaperLength === undefined && paper.roadTaperLength === undefined);

  // ── 出貨的幾何 vs demo 的 busWidthAt ──
  // demo 沿著自己的里程切段(`extendRoads`),gameview 的等級來自 MVT 的 feature。
  // 所以把 demo 的那條鏈**照抄成 feature**:一段一個 LineString,首尾共用節點,
  // 沿子午線南北走 —— 於是里程 = −z、路寬的方向 = x,量得出來。
  const originLat = 25.08, originLon = 121.55;
  const END = 2000;
  circuitDemo.extendRoads(END);
  const segs = circuitDemo.roadSegs.filter((s) => s.d0 < END);
  const latAt = (m: number): number => originLat + m / 111320;
  /**
   * 每一段的兩端各加四個 0.7 m 間隔的中間點。
   *
   * **這幾個點是這個 fixture 的關鍵,不是裝飾。** 錐段最長 3 m 而 `RIBBON_STEP_M`
   * 是 8 m,所以錐段裡**沒有內部取樣點** —— 只有兩個轉角(界上那個,加上硬插進去
   * 的那個)。而任何插值曲線在兩個端點上都等於線性的,於是「45°」與「等於
   * busWidthAt」這兩條在只有端點的情況下**看不出插值形狀**:實測把線性換成
   * `Math.sqrt(d / L)` 兩條都照樣通過。原始 MVT 的頂點會落在任何地方,所以讓
   * fixture 也如此,錐段裡就量得到形狀了。0.7 m 是刻意選的**非整數**間隔:它不會
   * 跟「插在錐段轉角」的那個點(整數 L)重合,兩個機制因此各自可見。
   */
  const feats = segs.map((s) => {
    const d1 = Math.min(s.d1, END);
    const ds = [s.d0];
    for (const k of [0.7, 1.4, 2.1, 2.8]) ds.push(s.d0 + k, d1 - k);
    ds.push((s.d0 + d1) / 2, d1);
    ds.sort((a, b) => a - b);
    return {
      layer: 'transportation',
      properties: { class: s.cls },
      geometry: {
        type: 'LineString',
        coordinates: ds.map((d) => [originLon, latAt(d)]),
      },
    };
  });
  const built = await buildRoadMeshes(
    feats as never, {} as never, originLat, originLon, 0, circuit, () => 0, () => true,
  );

  /** 出貨的每一對頂點:里程、全寬、以及橫向的 uv 跨幅。 */
  const pairs: {
    d: number; w: number; v0: number; v1: number; maskM: number; maskTol: number;
  }[] = [];
  /** 阻焊邊寬度對不回任何一個 demo 公稱寬的貼圖 —— 收集起來一次報,**不 throw**:
   *  一個 throw 會把這支從那一行起整個截斷,後面幾十條就靜靜地沒跑到。 */
  const unmatchedPx: number[] = [];
  for (const mesh of built.meshes) {
    const pos = mesh.geometry.getAttribute('position');
    const uv = mesh.geometry.getAttribute('uv');
    const px = maskPx(((mesh.material as THREE.MeshToonMaterial).map!.image as RecCanvas).ops);
    // 這張貼圖是照哪個**公稱寬**畫的:px = round(128 × BUS_MASK / nomW),從 demo 的
    // ROAD_W 裡把那個寬度找回來(不是抄一張表)。
    // 找不到就記一筆失敗再往下走(不 throw):**一個 throw 會把這支檢查從那一行
    // 起整個截斷**,後面幾十條斷言就靜靜地沒跑到 —— 「0 個 ✗ 也可能是 crash」。
    const nomW = [...new Set(Object.values(circuitDemo.ROAD_W))].find(
      (n) => Math.max(4, Math.round(128 * circuitDemo.BUS_MASK / n)) === px);
    if (nomW === undefined) { unmatchedPx.push(px); continue; }
    for (let i = 0; i + 1 < pos.count; i += 2) {
      const w = Math.abs(pos.getX(i) - pos.getX(i + 1));
      const v0 = uv.getY(i), v1 = uv.getY(i + 1);
      // 阻焊邊換算回世界公尺。貼圖上那道邊佔 v ∈ [0, px/128],而帶子只**看得到**
      // v ∈ [min(v0,v1), max(v0,v1)] 這一段(錐段上這個範圍會縮進去,`ClampToEdge`
      // 則讓超出 0…1 的部分繼續是邊的顏色)—— 所以量的是**看得到的那一截**,
      // 不是整道邊:`(b − vLo) × w / Δv`。
      const vLo = Math.min(v0, v1);
      const m = circuitDemo.BUS_MASK;
      pairs.push({
        d: -pos.getZ(i), w, v0, v1,
        maskM: (px / 128 - vLo) * w / Math.abs(v1 - v0),
        // 容差 = 貼圖自己的量化,傳播過來的那一份。`px` 只能是整數,所以邊的 v 比例
        // 最多差半格(1/256),而錐段把它放大 nomW(w − 2m) / (nomW − 2m) 倍 ——
        // 這不是隨手挑的數字,是上面那條換算式對 px 的偏導數。
        maskTol: (1 / 256) * (nomW * (w - 2 * m)) / (nomW - 2 * m),
      });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  check('每一張路面貼圖的阻焊邊都對得回 demo ROAD_W 裡的一個公稱寬',
    unmatchedPx.length === 0,
    unmatchedPx.length ? `對不上:${unmatchedPx.join('/')}px` : `${built.meshes.length} 張全對`);

  const boundaries = segs.slice(1).map((s, i) => ({
    d: s.d0, wU: circuitDemo.ROAD_W[segs[i].cls], wD: circuitDemo.ROAD_W[s.cls],
  })).filter((b) => circuitDemo.taperLen(b.wU, b.wD) > 0);

  /**
   * demo 的 `busWidthAt(d)`,加上移植**唯一**那一處刻意的偏離。
   *
   * demo 的鏈有順序(里程),所以它能說「錐段擺在新的那一級裡」;道路網沒有順序,
   * 而照 MVT 的走向決定會在兩條路頭對頭相接時直接壞掉(兩邊都收,而且對接點的寬度
   * 各說一套)。gameview 的規則因此是**無序**的:交會點的寬度 = 進來的最粗那條,
   * 每一條比它細的往外張開 Δ/2 公尺。
   *
   * 兩者的關係是一個**平移**,不是另一種造型:
   *  ・**變窄**的界(下游較細)→ 錐段落在下游,跟 demo **逐點相同**;
   *  ・**變寬**的界(下游較粗)→ 錐段落在上游,等於 demo 那一段往前挪 L 公尺,
   *    也就是 `busWidthAt(d + L)`。
   * 兩邊都是**執行 demo 的函式**算出來的,沒有抄常數。
   */
  const expectedW = (d: number): number => {
    for (const b of boundaries) {
      if (b.wD <= b.wU) continue;
      const L = circuitDemo.taperLen(b.wU, b.wD);
      if (d > b.d - L - 1e-6 && d < b.d + L + 1e-6) return circuitDemo.busWidthAt(d + L);
    }
    return circuitDemo.busWidthAt(d);
  };

  let worst = 0, worstAt = -1;
  for (const p of pairs) {
    const e = expectedW(p.d);
    if (Math.abs(p.w - e) > worst) { worst = Math.abs(p.w - e); worstAt = p.d; }
  }
  check('出貨的每一對頂點的寬度都等於 demo 的 busWidthAt(平移過的那一半見上)',
    worst < 0.02 && pairs.length > END / 8,
    `${pairs.length} 對頂點,最大偏差 ${worst.toExponential(2)} m @ d = ${worstAt.toFixed(1)} m`);

  const narrowing = boundaries.filter((b) => b.wD < b.wU);
  const widening = boundaries.filter((b) => b.wD > b.wU);
  check('(這條鏈兩種界都有 —— 不然上面那條只驗到一半)',
    narrowing.length > 0 && widening.length > 0,
    `${segs.length} 段:變窄 ${narrowing.length} 界 / 變寬 ${widening.length} 界`
    + ` / 同寬(無界)${segs.length - 1 - boundaries.length}`);

  // 45°:邊緣橫向移動的速率 = 沿路前進的速率,也就是**半寬對里程的斜率 = ±1**。
  // 這是 `taperLen = Δ/2` 的幾何後果,直接從出貨的頂點量。
  {
    let ramps = 0, slopeBad = 0, worstSlope = 0;
    for (let i = 1; i < pairs.length; i++) {
      const a = pairs[i - 1], b = pairs[i];
      const dd = b.d - a.d;
      if (dd < 1e-6 || Math.abs(b.w - a.w) < 1e-9) continue;
      const slope = Math.abs(b.w - a.w) / 2 / dd;   // 半寬 / 里程
      ramps++;
      worstSlope = Math.max(worstSlope, Math.abs(slope - 1));
      if (Math.abs(slope - 1) > 0.02) slopeBad++;
    }
    check('每一段寬度在變的地方都是 45°(半寬對里程的斜率 = 1)',
      ramps > 0 && slopeBad === 0,
      `${ramps} 段錐面,最大偏離 ${worstSlope.toExponential(2)}`);
  }

  // demo 的 busSeg:「把每個錐段的起訖點硬插進去 —— 均勻取樣一定會把錐形的兩個
  // 轉角切掉」。錐長最短 1 m,取樣步距 8 m,所以沒插的話轉角一定不見。
  {
    const hasVertexAt = (d: number): boolean => pairs.some((p) => Math.abs(p.d - d) < 1e-3);
    const missing = [
      ...narrowing.map((b) => b.d + circuitDemo.taperLen(b.wU, b.wD)),
      ...widening.map((b) => b.d - circuitDemo.taperLen(b.wU, b.wD)),
    ].filter((d) => !hasVertexAt(d));
    check('錐段的兩個轉角各有一個頂點(demo:硬插進去,不然轉角會被步距切掉)',
      missing.length === 0,
      `${narrowing.length + widening.length} 個轉角,漏 ${missing.length} 個`);
  }

  // 阻焊邊是製程參數:錐段上實際寬度不是公稱寬,所以 v 的半幅要反算
  // (demo busSeg 的 `hv`)。不反算的話錐段上的綠邊會跟著縮。
  {
    let maskWorst = 0;
    let insideSpan = 0;
    let over = 0;
    for (const p of pairs) {
      const err = Math.abs(p.maskM - circuitDemo.BUS_MASK);
      maskWorst = Math.max(maskWorst, err);
      if (err > p.maskTol) over++;
      if (Math.abs(p.v1 - p.v0) < 0.999) insideSpan++;
    }
    check('阻焊邊在錐段上仍然是 demo 的 BUS_MASK 公尺(v 的半幅被反算了)',
      over === 0,
      `最大偏差 ${maskWorst.toFixed(4)} m(容差 ≤ ${Math.max(...pairs.map((p) => p.maskTol))
        .toFixed(4)} m,貼圖量化),BUS_MASK = ${circuitDemo.BUS_MASK} m`);
    check('(而且真的有頂點的 v 跨幅不是 0…1 —— 不然上面那條只是在量公稱寬)',
      insideSpan > 0, `${insideSpan}/${pairs.length} 對頂點的 v 跨幅 < 1`);
  }

  for (const m of built.meshes) m.geometry.dispose();
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[road meshes bucket by material]');
// ═════════════════════════════════════════════════════════════════════════════
{
  // 一條路一級,全部平行、全部在同一片平地上 —— 只驗分桶,不驗貼地。
  const originLat = 25.08, originLon = 121.55;
  const feats = CLASSES.map((cls, i) => ({
    layer: 'transportation',
    properties: { class: cls },
    geometry: {
      type: 'LineString',
      coordinates: [
        [originLon + i * 0.001, originLat],
        [originLon + i * 0.001, originLat + 0.004],
      ],
    },
  }));
  const ground = () => 0;

  const build = async (s: typeof plastic) => buildRoadMeshes(
    feats as never, {} as never, originLat, originLon, 0, s, ground, () => true,
  );
  const rPlastic = await build(plastic);
  const rPaper = await build(paper);
  const rCircuit = await build(circuit);

  const verts = (r: { meshes: THREE.Mesh[] }) => r.meshes.reduce(
    (n, m) => n + (m.geometry.getAttribute('position')?.count ?? 0), 0);

  check('沒宣告 roadMaterialKey 的世界:六級合成**一份** mesh(跟改動前一模一樣)',
    rPlastic.meshes.length === 1 && rPaper.meshes.length === 1,
    `plastic ${rPlastic.meshes.length}, paper ${rPaper.meshes.length}`);
  check('電子:一個寬度一份 mesh',
    rCircuit.meshes.length === new Set(CLASSES.map((c) => circuit.roadWidth(c))).size,
    `${rCircuit.meshes.length} 份,${CLASSES.length} 級`);
  check('拆桶沒有掉幾何也沒有重複:三個世界的頂點總數相同',
    verts(rPlastic) === verts(rCircuit) && verts(rPaper) === verts(rCircuit),
    `${verts(rCircuit)} verts`);
  check('每一份路面材質都標了 shared(chunk 回收器不可以 dispose)',
    [...rPlastic.meshes, ...rCircuit.meshes].every(
      (m) => (m.material as THREE.Material).userData.shared === true));
  check('每一份路面材質都帶著 road 這一階的 polygonOffset',
    [...rPlastic.meshes, ...rCircuit.meshes].every((m) => {
      const mat = m.material as THREE.Material;
      return mat.polygonOffset === true && mat.polygonOffsetFactor === -OVERLAY_RANK.road;
    }), `factor = ${-OVERLAY_RANK.road}`);
  check('電子的六份 mesh 各自帶不同的阻焊寬度',
    new Set(rCircuit.meshes.map(
      (m) => maskPx(((m.material as THREE.MeshToonMaterial).map!.image as RecCanvas).ops))).size
      === rCircuit.meshes.length,
    rCircuit.meshes.map(
      (m) => maskPx(((m.material as THREE.MeshToonMaterial).map!.image as RecCanvas).ops) + 'px')
      .join(' '));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[side wall vs demo]');
// ═════════════════════════════════════════════════════════════════════════════
/**
 * demo 掛側牆的那一行裡的兩個數字:`sideWallSeg(d0, d1, side * boardW / 2, y0, y1)`
 * 的 `y0`,以及 `const boardW`。從 HTML 讀,不抄。
 */
function demoSideWall(src: string): { drop: number; halfWidth: number } | null {
  if (!/function sideWallSeg\(/.test(src)) return null;
  const call = src.match(/sideWallSeg\(d0,\s*d1,\s*side\s*\*\s*boardW\s*\/\s*2,\s*(-?[\d.]+),\s*(-?[\d.]+)/);
  if (!call) throw new Error('sideWallSeg exists but its board call site does not match');
  const board = sliceStatement(src, 'const boardW = ');
  const halfWidth = Number(board.match(/=\s*([\d.]+)/)![1]) / 2;
  // 牆從板面(y1)走到 y0,深度是兩者之差。
  return { drop: Math.abs(Number(call[2]) - Number(call[1])), halfWidth };
}
const dwPlastic = demoSideWall(plasticSrc);
const dwCircuit = demoSideWall(circuitSrc);
const dwPaper = demoSideWall(paperSrc);

check('積木 demo 有 sideWallSeg,而且切得出它的深度', dwPlastic !== null,
  dwPlastic ? `drop ${dwPlastic.drop} m,板半寬 ${dwPlastic.halfWidth} m` : '');
check('電子 demo 有 sideWallSeg,而且切得出它的深度', dwCircuit !== null,
  dwCircuit ? `drop ${dwCircuit.drop} m,板半寬 ${dwCircuit.halfWidth} m` : '');
check('瓦楞紙 demo **沒有** sideWallSeg —— 地台是切割墊本身,沒有紙板就沒有切口',
  dwPaper === null);

check('積木宣告的側牆深度 = demo 的', plastic.sideWall?.drop === dwPlastic!.drop,
  `gameview ${plastic.sideWall?.drop} / demo ${dwPlastic!.drop}`);
check('電子宣告的側牆深度 = demo 的', circuit.sideWall?.drop === dwCircuit!.drop,
  `gameview ${circuit.sideWall?.drop} / demo ${dwCircuit!.drop}`);
check('瓦楞紙不宣告側牆(跟著 demo 一起沒有)', paper.sideWall === undefined);

check('側牆材質是 strategy 擁有的 singleton,而且標了 shared',
  plastic.sideWall!.createMaterial() === plastic.sideWall!.createMaterial()
  && plastic.sideWall!.createMaterial().userData.shared === true
  && circuit.sideWall!.createMaterial() === circuit.sideWall!.createMaterial()
  && circuit.sideWall!.createMaterial().userData.shared === true);
check('電子的側牆跟第 0 階的切邊是**同一份**材質(同一種零件只能有一份做法)',
  circuit.sideWall!.createMaterial() === circuit.createTerrainWallMaterialForLevel!(0));
check('積木的側牆色 = 第 0 階色帶的 side(底板就是第 0 階,模邊就是它的切口)',
  (plastic.sideWall!.createMaterial() as THREE.MeshToonMaterial).color.getHex()
    === plastic.bandAt!(0).side!.getHex(),
  `#${(plastic.sideWall!.createMaterial() as THREE.MeshToonMaterial).color.getHexString()}`);
check('兩個世界的側牆都是 DoubleSide(demo 兩個都是)',
  plastic.sideWall!.createMaterial().side === THREE.DoubleSide
  && circuit.sideWall!.createMaterial().side === THREE.DoubleSide);

/** 一條直的走廊,橫向線性上坡,沿路也有起伏 —— 每一格的踏面高度都不一樣。 */
function synthGrid(along: number, cross: number, halfWidth: number) {
  const gx: number[] = [], gz: number[] = [], gele: number[] = [], gcol: number[] = [];
  for (let a = 0; a < along; a++) {
    for (let c = 0; c < cross; c++) {
      const off = ((c / (cross - 1)) * 2 - 1) * halfWidth;
      // 橫向上坡 + 沿路波動:踏面階數沿兩個方向都在變,側牆的「往下走 drop」
      // 因此必須是**逐格**的,不是整條牆一個底。
      const ele = 100 + off * 0.12 + Math.sin(a * 0.7) * 9;
      gx.push(off);
      gz.push(-a * 25);
      gele.push(ele);
      gcol.push(1, 1, 1);
    }
  }
  return { gx, gz, gele, gcol, along, cross };
}

const ALONG = 9, CROSS = 11, HALF = 500;
for (const [name, s] of [['plastic', plastic], ['circuit', circuit], ['paper', paper]] as const) {
  const grid = synthGrid(ALONG, CROSS, HALF);
  const data = buildQuantizedCorridorGeometry(grid, s, 0);
  const cellsA = ALONG - 1, cellsC = CROSS - 1;
  const quads = data.sideWallIndexCount / 6;

  /**
   * 走廊外側那兩欄上的豎面 —— 兩個端點的 |x| 都等於半寬的,只有 c===0 /
   * c===cellsC-1 的裙邊(或側牆)符合:相鄰格的切口一定橫跨兩欄,chunk 前後端的
   * 裙邊也一樣(它沿著橫向走)。回傳每一片的落差。
   */
  const edgeDrops = (
    positions: number[], from: number, quadCount: number,
  ): number[] => {
    const out: number[] = [];
    for (let q = 0; q < quadCount; q++) {
      const v = from + q * 4;
      const x0 = positions[v * 3], x1 = positions[v * 3 + 3];
      if (Math.abs(Math.abs(x0) - HALF) > 1e-4 || Math.abs(Math.abs(x1) - HALF) > 1e-4) continue;
      out.push(positions[v * 3 + 1] - positions[v * 3 + 3 * 2 + 1]);
    }
    return out;
  };
  // 牆桶(側牆之外的每一片豎面)的頂點起點與片數。踏面每一個三角形都推自己的三個
  // 頂點(flat shading 的代價),所以踏面的**頂點數 = 索引數**,牆從那裡開始。
  const wallQuads = data.wallIndexCounts.reduce((n, c) => n + c, 0) / 6;
  const wallStart = data.topIndexCount;

  if (!s.sideWall) {
    check(`${name}: 沒有側牆桶`, data.sideWallIndexCount === 0);
    // 走廊側邊仍然要收邊,只是走原本那道短裙邊 —— 而且它必須**還在**。
    const lip = Math.max(s.params.layerHeight, 4);
    const drops = edgeDrops(data.positions, wallStart, wallQuads);
    check(`${name}: 走廊側邊照舊掛 max(layerHeight, 4) = ${lip} m 的短裙邊`,
      drops.length === cellsA * 2 && drops.every((d) => Math.abs(d - lip) < 1e-4),
      `${drops.length} 片(期望 ${cellsA * 2}),落差 ${[...new Set(drops.map((d) => d.toFixed(2)))].join('/')}`);
    continue;
  }

  // 反過來:宣告了側牆的世界,牆桶裡**不可以**再留下走廊外側的裙邊 —— 留著就是
  // 同一道邊畫了兩次(一次深 9 m、一次深 skirtDrop),z-fight 而且顏色是錯的。
  check(`${name}: 走廊外側的裙邊全部搬進側牆桶,牆桶裡一片都不剩`,
    edgeDrops(data.positions, wallStart, wallQuads).length === 0,
    `牆桶 ${wallQuads} 片`);

  check(`${name}: 側牆一格一段,兩側各 ${cellsA} 段`,
    quads === cellsA * 2, `${quads} quads(cellsA=${cellsA})`);

  // 每一片牆:讀回它的四個頂點,驗「上緣 = 那一格的踏面、下緣 = 上緣 − drop」、
  // 以及「它站在走廊的最外側那一欄」。
  const pos = data.positions;
  const start = (data.positions.length / 3) - quads * 4;
  let badDrop = 0, badX = 0, worstDrop = 0;
  const tops = new Set<number>();
  for (let q = 0; q < quads; q++) {
    const v = start + q * 4;
    const yTop = pos[v * 3 + 1];
    const yBot = pos[v * 3 + 3 * 2 + 1];   // 第三個頂點 = BR
    const x0 = pos[v * 3], x1 = pos[v * 3 + 3];
    const d = yTop - yBot;
    if (Math.abs(d - s.sideWall.drop) > 1e-4) { badDrop++; worstDrop = Math.max(worstDrop, Math.abs(d - s.sideWall.drop)); }
    if (Math.abs(Math.abs(x0) - HALF) > 1e-4 || Math.abs(Math.abs(x1) - HALF) > 1e-4) badX++;
    tops.add(Math.round(yTop * 1000));
  }
  check(`${name}: 每一片側牆都從**自己那一格的踏面**往下走 ${s.sideWall.drop} m`,
    badDrop === 0, badDrop ? `${badDrop}/${quads} 片錯,最差 ${worstDrop.toFixed(3)} m` : `${tops.size} 個不同的上緣高度`);
  check(`${name}: 側牆全部落在走廊的兩個外側欄(|x| = ${HALF})`, badX === 0);
  check(`${name}: 上緣高度不只一個(牆跟著地形走,不是一條水平帶)`, tops.size > 1,
    `${tops.size} 種`);

  // chunk 的前後兩端**不算**側牆 —— 那是 gameview 的接縫,demo 的板子是連續的。
  // 若把 a===0 / a===cellsA-1 也算進去,quads 會變成 2*cellsA + 2*cellsC。
  check(`${name}: chunk 的前後兩端不掛側牆(demo 的板子是連續的)`,
    quads !== cellsA * 2 + cellsC * 2, `${quads} ≠ ${cellsA * 2 + cellsC * 2}`);

  // 幾何 group:側牆自己一個,materialIndex 排在所有牆桶之後。
  const geo = quantizedDataToGeometry(data);
  const last = geo.groups[geo.groups.length - 1];
  check(`${name}: 側牆是最後一個 group,materialIndex = 牆桶數 + 1`,
    last.materialIndex === data.wallIndexCounts.length + 1 && last.count === data.sideWallIndexCount,
    `materialIndex ${last.materialIndex}, count ${last.count}`);
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
