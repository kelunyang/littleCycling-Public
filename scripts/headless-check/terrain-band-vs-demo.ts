/**
 * `[terrain banding vs demo]` — 等高線分層設色的移植稽核。
 *
 * 三個世界各有一套「高度怎麼被讀出來」的答案,三套都不是這個檔案裡的常數決定的:
 * demo 的表與函式從 `plan/*-demo.html` **切出來執行**,再跟真實遊戲的策略逐項比。
 * 抄過來的常數只會把當初打錯的東西再確認一遍(見 CUSTOM_WORLD_INSTRUCTIONS §0.0
 * 第 5 點),所以這裡一個色票都沒有硬寫。
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/terrain-band-vs-demo.ts
 *
 * 驗的是**規則**不只是數值:
 *   ・積木的色帶是**單一色相的明度階**(色相階 = 另一個世界,必須失敗)
 *   ・方向是山腳深、山頭淡
 *   ・第 0 階 = 底板色,一格沒動
 *   ・一道切口的顏色 = **它上面那片板**的色帶側面色(比自己的踏面深一階)
 *   ・瓦楞紙走它自己的色相階(草綠→土黃),不是把積木的表 paperify 一次
 *   ・電子不上分層色,改用 FR4 切邊的銅箔層數
 *   ・基準面是路面不是 floating origin(換 originEle 顏色不能變)
 *   ・凸點跟著它腳下那塊磚(同一塊塑膠射出來的東西不會兩個色)
 *
 * 折進 `diorama.ts` 的方式:拿掉下面的 canvas stub(diorama 自己有一個)、把
 * `check` 換成 diorama 的、三個區塊各包一層 `await block(...)`。
 */
import { readFileSync } from 'node:fs';

// ── Recording canvas stub ────────────────────────────────────────────────────
// 這份**不再是自己的**。FR4 切邊的層數是畫出來的,3D probe 看不到貼圖(它把貼圖換成
// 面積加權主色),所以要驗那條規則只能看畫布上的筆觸 —— 但「誰的畫布」不能由 import
// 順序決定。理由與被咬過兩次的經過寫在 `recording-canvas.ts`。
// 這支要的是 fillRect 那個視角(`.rects`)。
const { installRecordingCanvas } = await import('./recording-canvas.ts');
type RecCanvas = import('./recording-canvas.ts').RecCanvas;
type RectOp = import('./recording-canvas.ts').RectOp;
installRecordingCanvas();

const THREE = await import('three');
const { createTerrainStyleStrategy } = await import('@/game/terrain/terrain-style-strategy');
const { buildQuantizedCorridorGeometry, quantizedDataToGeometry } = await import('@/game/terrain/quantized-terrain');
const { buildTerrainChunk, sampleChunkCell } = await import('@/game/terrain/terrain-chunk');
const { buildGroundStuds } = await import('@/game/terrain/ground-studs');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
export function failureCount(): number { return failures; }

// ── Demo slicing ─────────────────────────────────────────────────────────────
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
/** From `head` to the end of the statement it starts (first line ending in `;`
 *  at brace depth 0) — covers both the one-line and multi-line array literals. */
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

const plasticSrc = readFileSync('plan/plastic-town-demo.html', 'utf8');
const paperSrc = readFileSync('plan/paper-town-demo.html', 'utf8');
const circuitSrc = readFileSync('plan/circuit-town-demo.html', 'utf8');

// ── Colour helpers (measure the RULE, not the hex) ───────────────────────────
/** HSL hue in degrees, and lightness in 0..1 — the two axes the rules talk about. */
function hsl(hex: string): { h: number; l: number; s: number } {
  const c = new THREE.Color(hex);
  const out = { h: 0, s: 0, l: 0 };
  c.getHSL(out);
  return { h: out.h * 360, l: out.l, s: out.s };
}
/** Circular spread of a set of hues, in degrees. */
function hueSpread(hexes: string[]): number {
  const hs = hexes.map((x) => hsl(x).h);
  let best = 360;
  for (const anchor of hs) {
    let lo = 0, hi = 0;
    for (const h of hs) {
      let d = h - anchor;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    best = Math.min(best, hi - lo);
  }
  return best;
}
const hexOf = (c: THREE.Color): string => `#${c.getHexString()}`;
const sameColor = (a: THREE.Color, b: string): boolean =>
  Math.abs(a.r - new THREE.Color(b).r) < 1e-6
  && Math.abs(a.g - new THREE.Color(b).g) < 1e-6
  && Math.abs(a.b - new THREE.Color(b).b) < 1e-6;

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[plastic band table vs demo]');
// ═════════════════════════════════════════════════════════════════════════════
const plasticDemo = new Function(`
  ${sliceStatement(plasticSrc, 'const TERRAIN_BAND = [')}
  ${sliceStatement(plasticSrc, 'const STEP_H = ')}
  ${sliceStatement(plasticSrc, 'const bandAt = (y) =>')}
  return { TERRAIN_BAND, STEP_H, bandAt };
`)() as {
  TERRAIN_BAND: { top: string; side: string }[];
  STEP_H: number;
  bandAt: (y: number) => { top: string; side: string };
};

const plastic = await createTerrainStyleStrategy('plastic');
const P_STEP = plastic.params.layerHeight;

check('demo 的 TERRAIN_BAND 切得出來且非空',
  plasticDemo.TERRAIN_BAND.length > 0,
  `${plasticDemo.TERRAIN_BAND.length} 階,demo STEP_H = ${plasticDemo.STEP_H}`);
check('gameview 宣告了 bandAt', typeof plastic.bandAt === 'function');

{
  // demo 的 STEP_H 是一片 plasticSlab 的厚度(它的量化階);gameview 的量化階是
  // params.layerHeight。搬過來的是「一階色帶 = 一階量化」這個**關係**,所以逐階比。
  let bad = 0;
  for (let k = 0; k < plasticDemo.TERRAIN_BAND.length; k++) {
    const d = plasticDemo.bandAt(k * plasticDemo.STEP_H);
    const g = plastic.bandAt!(k * P_STEP);
    if (!sameColor(g.top, d.top) || !g.side || !sameColor(g.side, d.side)) {
      bad++;
      if (bad <= 3) {
        console.log(`      階 ${k}: demo ${d.top}/${d.side} vs gameview ${hexOf(g.top)}/${g.side ? hexOf(g.side) : '—'}`);
      }
    }
  }
  check('每一階的 top/side 都跟 demo 一模一樣', bad === 0,
    `${plasticDemo.TERRAIN_BAND.length} 階,一階 = ${P_STEP} m(demo ${plasticDemo.STEP_H} m)`);
}
{
  // 夾住的行為也要一樣:負的回第 0 階(底板),超過表尾停在最淡那一階。
  const dLo = plasticDemo.bandAt(-99 * plasticDemo.STEP_H);
  const gLo = plastic.bandAt!(-99 * P_STEP);
  const dHi = plasticDemo.bandAt(99 * plasticDemo.STEP_H);
  const gHi = plastic.bandAt!(99 * P_STEP);
  check('路面以下夾回第 0 階', sameColor(gLo.top, dLo.top) && sameColor(gLo.top, plasticDemo.TERRAIN_BAND[0].top),
    hexOf(gLo.top));
  check('超過表尾停在最淡那一階',
    sameColor(gHi.top, dHi.top)
    && sameColor(gHi.top, plasticDemo.TERRAIN_BAND[plasticDemo.TERRAIN_BAND.length - 1].top), hexOf(gHi.top));
  // 半階的位置也要一致(demo 用 Math.round,不是 floor —— 這兩個差一階)。
  let roundBad = 0;
  for (let k = 0; k < plasticDemo.TERRAIN_BAND.length; k++) {
    for (const frac of [-0.49, -0.2, 0.2, 0.49]) {
      const d = plasticDemo.bandAt((k + frac) * plasticDemo.STEP_H);
      const g = plastic.bandAt!((k + frac) * P_STEP);
      if (!sameColor(g.top, d.top)) roundBad++;
    }
  }
  check('階與階之間的取整跟 demo 一致(round,不是 floor/ceil)', roundBad === 0,
    `${roundBad} 個偏移點不合`);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[plastic band rules — 規則本身]');
// ═════════════════════════════════════════════════════════════════════════════
// 這一組是拿**gameview 實際會畫出來的顏色**去驗 demo 那段文字寫下的規則。表對了
// 但規則不對(例如有人把它換成綠→黃→褐的色相階)在上面那一組是抓不到的:那組只
// 說「跟 demo 一樣」,而 demo 也可能被一起改掉。
const gTops: string[] = [];
const gSides: string[] = [];
for (let k = 0; k < plasticDemo.TERRAIN_BAND.length; k++) {
  const b = plastic.bandAt!(k * P_STEP);
  gTops.push(hexOf(b.top));
  gSides.push(b.side ? hexOf(b.side) : '');
}
check('單一色相的明度階,不是色相階', hueSpread([...gTops, ...gSides]) <= 15,
  `色相跨度 ${hueSpread([...gTops, ...gSides]).toFixed(1)}°(門檻 15°)`);
check('飽和度沒有崩到灰(還是「玩具磚的綠」)',
  gTops.every((c) => hsl(c).s > 0.3), `最低 ${Math.min(...gTops.map((c) => hsl(c).s)).toFixed(2)}`);
{
  let mono = true;
  for (let k = 1; k < gTops.length; k++) if (hsl(gTops[k]).l <= hsl(gTops[k - 1]).l) mono = false;
  check('踏面:山腳深、山頭淡(明度單調遞增)', mono,
    gTops.map((c) => hsl(c).l.toFixed(2)).join(' → '));
}
{
  let mono = true;
  for (let k = 1; k < gSides.length; k++) if (hsl(gSides[k]).l <= hsl(gSides[k - 1]).l) mono = false;
  check('側面:同一個方向(明度單調遞增)', mono,
    gSides.map((c) => hsl(c).l.toFixed(2)).join(' → '));
}
{
  // 「側面一律比自己的踏面深一階」。兩件事都要:比自己的踏面深(第 0 階只有這一
  // 條可驗),而且深到比**下面**那一階的踏面還深 —— 不然「深一階」只是深一點點。
  let ownBad = 0, prevBad = 0;
  for (let k = 0; k < gTops.length; k++) {
    if (hsl(gSides[k]).l >= hsl(gTops[k]).l) ownBad++;
    if (k > 0 && hsl(gSides[k]).l >= hsl(gTops[k - 1]).l) prevBad++;
  }
  check('每一階的側面都比自己的踏面深', ownBad === 0, `${ownBad} 階不合`);
  check('每一階的側面都比下面那一階的踏面還深(真的是「深一階」)', prevBad === 0,
    `${prevBad} 階不合`);
}
{
  // 「底板就是第 0 階,顏色一格沒動 —— 亮綠底板是這個世界的招牌」。
  // 對照的是 demo 自己的 C.baseGreen,不是這個檔案裡的字串;而且是問**凸點**,
  // 因為那顆凸點的顏色就是底板顏色在真實遊戲裡的出口。
  const C = new Function(`${sliceStatement(plasticSrc, 'const C = {')} return C;`)() as
    Record<string, string>;
  const studBase = plastic.groundStuds!.colorFor(null, 0);
  check('第 0 階 = demo 的 C.baseGreen(底板一格沒動)',
    sameColor(new THREE.Color(studBase), C.baseGreen),
    `stud #${studBase.toString(16).padStart(6, '0')} vs demo ${C.baseGreen}`);
  check('第 0 階的側面 = demo 的 C.baseSide',
    sameColor(plastic.bandAt!(0).side!, C.baseSide),
    `${hexOf(plastic.bandAt!(0).side!)} vs demo ${C.baseSide}`);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[paper band table vs demo]');
// ═════════════════════════════════════════════════════════════════════════════
const paperDemo = new Function(`
  ${sliceStatement(paperSrc, 'const TERRAIN_BAND = [')}
  ${sliceStatement(paperSrc, 'const PLATE_H = ')}
  return { TERRAIN_BAND, PLATE_H };
`)() as { TERRAIN_BAND: string[]; PLATE_H: number };

const paper = await createTerrainStyleStrategy('paper');
const PA_STEP = paper.params.layerHeight;

check('demo 的瓦楞紙 TERRAIN_BAND 切得出來', paperDemo.TERRAIN_BAND.length > 0,
  `${paperDemo.TERRAIN_BAND.length} 階,demo PLATE_H = ${paperDemo.PLATE_H}`);
check('gameview 的瓦楞紙宣告了 bandAt', typeof paper.bandAt === 'function');
{
  let bad = 0;
  for (let k = 0; k < paperDemo.TERRAIN_BAND.length; k++) {
    const g = paper.bandAt!(k * PA_STEP);
    if (!sameColor(g.top, paperDemo.TERRAIN_BAND[k])) {
      bad++;
      if (bad <= 3) console.log(`      階 ${k}: demo ${paperDemo.TERRAIN_BAND[k]} vs gameview ${hexOf(g.top)}`);
    }
  }
  check('每一階都跟瓦楞紙 demo 一模一樣', bad === 0,
    `${paperDemo.TERRAIN_BAND.length} 階,一階 = ${PA_STEP} m(demo ${paperDemo.PLATE_H} m)`);
}
{
  const tops: string[] = [];
  for (let k = 0; k < paperDemo.TERRAIN_BAND.length; k++) tops.push(hexOf(paper.bandAt!(k * PA_STEP).top));
  let mono = true;
  for (let k = 1; k < tops.length; k++) if (hsl(tops[k]).l <= hsl(tops[k - 1]).l) mono = false;
  check('瓦楞紙也是山腳深、山頭淡', mono, tops.map((c) => hsl(c).l.toFixed(2)).join(' → '));
  // 這個世界**不是**單色相 —— 它是草綠走到帶土的灰黃。這條寫成斷言,是為了擋掉
  // 「把積木的表 paperify 一次就當成瓦楞紙的」那個作法:那樣做出來會是單色相。
  check('瓦楞紙走的是它自己的色相階(不是把積木的表 paperify)',
    hueSpread(tops) >= 30, `色相跨度 ${hueSpread(tops).toFixed(1)}°(門檻 30°)`);
  const plasticified = tops.map((c, k) => sameColor(new THREE.Color(c), gTops[Math.min(k, gTops.length - 1)]));
  check('也不是直接抄積木的表', !plasticified.every(Boolean));
}
check('瓦楞紙的切邊不吃色帶(生紙板),所以 side 留空',
  paper.bandAt!(0).side === undefined && typeof paper.createTerrainWallMaterial === 'function');

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[paper 第 0 階 = 切割墊 vs demo]');
// ═════════════════════════════════════════════════════════════════════════════
//
// 使用者實騎回報兩件事,而它們是同一件:
//
// > 「demo 的 paper world 會把第一層等高線畫成綠色墊子,在那之上才是瓦楞紙」
// > 「瓦楞紙世界的第一層等高線還是有會閃爍的材質(很像是黑色的刷線),但 POC 都沒有」
//
// demo 的答案在材質區,而且是**兩個不同的東西**:
//
//   const boardTopMat = toon({ map: rep(cuttingMatTex, 5, 5) });          ← 第 0 階
//   const plateTopMats = TERRAIN_BAND.map((c, i) => swappable(toon({}),…)) ← 第 1 階以上
//
// 第 0 階是桌上的**工具**(切割墊),不是那一疊板的第一片:沒有頂點色、沒有雙態、
// 沒有顏料的刷痕。gameview 的踏面材質是 `crayonize(...)`,它的 shader 是
// `diffuseColor.rgb *= crayonTex.r` —— R 低的地方壓黑,那就是使用者說的黑色刷線。
// 所以「移植第 0 階」跟「修掉那個閃爍」是同一個動作,而**第 1 階以上的蠟筆紋是
// demo 有的**,下面有一條反向斷言盯著它不准被一起拿掉。
{
  const demoBoardTopMat = sliceStatement(paperSrc, 'const boardTopMat = ');
  const demoPlateTopMats = sliceStatement(paperSrc, 'const plateTopMats = ');
  check('demo 的 boardTopMat / plateTopMats 是兩段不同的宣告(第 0 階跟它上面那疊不是同一個東西)',
    demoBoardTopMat.length > 0 && demoPlateTopMats.length > 0
    && demoBoardTopMat !== demoPlateTopMats,
    `${demoBoardTopMat.length} / ${demoPlateTopMats.length} chars`);

  // ── demo 寫下的規則,從它自己的原始碼讀,不是打進來的 ──────────────────────
  check('demo 的第 0 階吃的是切割墊的貼圖',
    /rep\(\s*cuttingMatTex\s*,/.test(demoBoardTopMat), demoBoardTopMat.trim());
  check('demo 的第 0 階沒有頂點色、也不是雙態(墊子是桌上的工具,不隨上色模式變)',
    !/vertexColors/.test(demoBoardTopMat) && !/swappable\(/.test(demoBoardTopMat));
  check('而 demo 的第 1 階以上才是雙態的 TERRAIN_BAND 色帶',
    /swappable\(/.test(demoPlateTopMats) && /TERRAIN_BAND\.map/.test(demoPlateTopMats));

  // ── 貼圖:執行 demo 自己那段畫布程式碼,逐筆比 ────────────────────────────
  // 這是唯一抓得到「seed 抄過來、產生器沒抄過來」的方式 —— 兩邊都是 46 道隨機
  // 刀痕,肉眼、census、3D probe 全都看不出差別(3D probe 連貼圖都不看)。
  const demoMatTex = new Function('THREE', `
    ${sliceFn(paperSrc, 'mulberry32')}
    ${sliceStatement(paperSrc, 'const cuttingMatTex = ')}
    return cuttingMatTex;
  `)(THREE) as THREE.CanvasTexture;
  const demoMatTrace = (demoMatTex.image as RecCanvas).trace;

  const matMat = paper.createTerrainTopMaterialForLevel?.(0) as THREE.MeshToonMaterial | null;
  check('gameview 宣告了踏面分階,而且第 0 階有自己的材質',
    (paper.terrainTopLevels ?? 1) >= 2
    && typeof paper.createTerrainTopMaterialForLevel === 'function'
    && !!matMat, `terrainTopLevels = ${paper.terrainTopLevels}`);

  const gameMatTrace = (matMat?.map?.image as RecCanvas | undefined)?.trace ?? [];
  {
    let firstDiff = -1;
    for (let i = 0; i < Math.max(demoMatTrace.length, gameMatTrace.length); i++) {
      if (demoMatTrace[i] !== gameMatTrace[i]) { firstDiff = i; break; }
    }
    check('第 0 階的畫布跟 demo 的 cuttingMatTex 逐筆相同(底色 / 格線 / 46 道刀痕)',
      firstDiff < 0,
      firstDiff < 0
        ? `${demoMatTrace.length} 筆`
        : `第 ${firstDiff} 筆:demo「${demoMatTrace[firstDiff]}」vs gameview「${gameMatTrace[firstDiff]}」`);
    // 反向對照:兩邊的 trace 真的都有東西可比(空 vs 空也會「相同」)。
    const lineTos = (t: string[]) => t.filter((s) => s.startsWith('lineTo(')).length;
    check('(而且兩邊的 trace 真的都錄到了那 46 道刀痕,不是空的)',
      demoMatTrace.length > 300 && lineTos(demoMatTrace) >= 46
      && gameMatTrace.length === demoMatTrace.length && lineTos(gameMatTrace) >= 46,
      `demo ${demoMatTrace.length} 筆 / ${lineTos(demoMatTrace)} 道,`
      + `gameview ${gameMatTrace.length} 筆 / ${lineTos(gameMatTrace)} 道`);
  }

  // ── 材質本身:沒有頂點色、沒有蠟筆紋,但有雲影 ────────────────────────────
  /** 把材質的 onBeforeCompile 真的跑一次,看注進去了什麼 —— 讀的是最後會編譯的
   *  那份 GLSL,不是讀原始碼推的。 */
  const compiled = (m: THREE.Material): string => {
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: '#include <begin_vertex>',
      fragmentShader: '#include <map_fragment>\n#include <color_fragment>',
    };
    m.onBeforeCompile?.(shader as never, null as never);
    return shader.fragmentShader;
  };
  const matFrag = matMat ? compiled(matMat) : '';
  check('第 0 階不吃頂點色(墊子不是那一疊板的第一片)', matMat?.vertexColors === false,
    `vertexColors = ${matMat?.vertexColors}`);
  check('第 0 階沒有蠟筆紋 —— 使用者說的「會閃爍的黑色刷線」在這一階不存在',
    !matFrag.includes('crayonTex'));
  check('但第 0 階仍然吃雲影(不然一朵雲的影子會剛好停在階界上)',
    matFrag.includes('uCloudStrength'));

  // 反向:第 1 階以上**必須**還有蠟筆紋。demo 的 plateTopMats 上色態就是刷痕,
  // 把它一起拿掉等於順手刪掉這個世界的踏面質感。
  check('第 1 階以上回 null,走既有的踏面材質',
    paper.createTerrainTopMaterialForLevel?.(1) === null);
  {
    const above = paper.createTerrainMaterial() as THREE.MeshToonMaterial;
    const aboveFrag = compiled(above);
    check('…而那份材質照舊是頂點色 + 蠟筆紋(這一半不准被一起拿掉)',
      above.vertexColors === true && aboveFrag.includes('crayonTex'),
      `vertexColors = ${above.vertexColors}, crayon = ${aboveFrag.includes('crayonTex')}`);
    check('兩階的貼圖是兩張不同的畫布(墊子沒有被 crayonize 吃掉 map)',
      !!above.map && !!matMat?.map && above.map.image !== matMat.map.image);
    above.dispose();
  }

  // ── 所有權(§6 的合約,跟 createTerrainWallMaterialForLevel 同一條)────────
  {
    const a = paper.createTerrainTopMaterialForLevel!(0)!;
    const b = paper.createTerrainTopMaterialForLevel!(0)!;
    check('第 0 階的材質是 cache 過的同一個實例(不是每個 chunk 一份)', a === b);
    check('而且標了 userData.shared,chunk 回收器不會 dispose 它',
      a.userData?.shared === true);
  }

  // ── 墊子不是雙態的 ────────────────────────────────────────────────────────
  {
    const saved = paper.params.paintEnabled;
    paper.params.paintEnabled = false;
    const plainMat = paper.createTerrainTopMaterialForLevel!(0);
    const plainTop = paper.createTerrainMaterial() as THREE.MeshToonMaterial;
    const plainFrag = compiled(plainTop);
    paper.params.paintEnabled = saved;
    check('關掉上色,墊子一格不動(demo:「墊子是桌上的工具,不會因為你開始上色就變」)',
      plainMat === matMat);
    check('(而同一個開關真的把踏面的顏料拿走了 —— 對照組是活的)',
      !plainFrag.includes('crayonTex'));
    plainTop.dispose();
  }

  // ── 重複率:demo 答得出來的那一半,與它答不出來的那一半 ────────────────────
  //
  // demo 的地台是 `ribbonSeg(d0, d1, boardW, 0, 1 / 30)`:u = 沿路公尺 × uvScale、
  // v = 0…1 橫跨 boardW。配 repeat(5, 5) 之後一格貼圖沿路 30/5 = 6 m、橫向
  // 130/5 = 26 m —— **兩軸不一樣長**,那是 ribbon 把 v 正規化的副作用,不是設計。
  // gameview 的踏面 uv 兩軸都是場景公尺,所以只能是方的,而「該多大」demo 答不出來。
  {
    const repMatch = /rep\(\s*cuttingMatTex\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/.exec(demoBoardTopMat);
    const boardW = new Function(`${sliceStatement(paperSrc, 'const boardW = ')} return boardW;`)() as number;
    const uvMatch = /ribbonSeg\(d0,\s*d1,\s*boardW,\s*0,\s*([^)]+)\)/.exec(paperSrc);
    const repX = Number(repMatch?.[1]), repY = Number(repMatch?.[2]);
    const uvScale = uvMatch ? (new Function(`return ${uvMatch[1]};`)() as number) : NaN;
    const alongTile = 1 / uvScale / repX;
    const acrossTile = boardW / repY;
    check('demo 的地台一格貼圖沿路 6 m、橫向 26 m —— 兩軸不一樣長,所以它答不出「一格該多方」',
      Math.abs(alongTile - 6) < 1e-9 && Math.abs(acrossTile - 26) < 1e-9
      && Math.abs(alongTile - acrossTile) > 1,
      `repeat ${repX}×${repY}, boardW ${boardW}, uvScale ${uvScale} → ${alongTile} m × ${acrossTile} m`);

    const disc = paper.createHorizonMaterial!() as THREE.MeshToonMaterial;
    const floorTex = matMat!.map!;
    const discTex = disc.map!;
    check('gameview 的墊子是方的',
      Math.abs(floorTex.repeat.x - floorTex.repeat.y) < 1e-12,
      `repeat ${floorTex.repeat.x} × ${floorTex.repeat.y}`);
    // **墊子只能有一張**:走廊的踏面跟 4 km 的地墊圓盤是同一張墊子,格線必須同相。
    // 圓盤的 uv 是「本地公尺 + 騎手位移」= 世界公尺,踏面的 uv 也是世界公尺,所以
    // 只要尺度一樣,兩邊的格子就接得起來。
    check('走廊的墊子跟 4 km 圓盤同一個尺度(墊子只能有一張,格線要接得起來)',
      Math.abs(floorTex.repeat.x - discTex.repeat.x) < 1e-12
      && Math.abs(floorTex.repeat.y - discTex.repeat.y) < 1e-12,
      `走廊 1/${(1 / floorTex.repeat.x).toFixed(0)} m vs 圓盤 1/${(1 / discTex.repeat.x).toFixed(0)} m`);
    check('走廊那份是圓盤那份的 clone:同一張畫布,不同的貼圖實例',
      floorTex !== discTex && floorTex.image === discTex.image);
    disc.dispose();
  }

  // ⚠ offset 的坑:`mountain-ring.update()` 每一幀寫**圓盤那份**的 `map.offset`
  //   (把跟著騎手走的圓盤釘回世界)。走廊的 uv 本來就在世界座標上,共用同一個
  //   實例的話墊子會跟著騎手滑。而 clone 是懶建的 —— 騎到一半才建的那份會抄到
  //   圓盤當下的位移,所以它必須自己歸零。這裡用一個全新的 strategy 重現那個順序。
  {
    const fresh = await createTerrainStyleStrategy('paper');
    const discFirst = fresh.createHorizonMaterial!() as THREE.MeshToonMaterial;
    discFirst.map!.offset.set(0.37, -0.91);          // = mountain-ring 騎了一段之後
    const floorAfter = fresh.createTerrainTopMaterialForLevel!(0) as THREE.MeshToonMaterial;
    check('先騎一段再建的墊子,offset 仍然是 0(不會抄到圓盤的位移)',
      floorAfter.map!.offset.x === 0 && floorAfter.map!.offset.y === 0,
      `offset ${floorAfter.map!.offset.x}, ${floorAfter.map!.offset.y}`);
    check('(而且對照組是活的:圓盤那份的確被推走了)',
      discFirst.map!.offset.x === 0.37);
    discFirst.dispose();
    fresh.dispose();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[terrace step height vs demo]');
// ═════════════════════════════════════════════════════════════════════════════
//
// 上面兩段比的是「一階色帶 = 一階量化」這個**關係**,所以它們是**尺度無關**的
// (兩邊都用 `k × 自己的階高` 取樣)—— 也就是說階高本身被放大三倍,那些斷言一條
// 都不會響。而階高被放大三倍過:paper 是 3.2 → 12(3.75×)、plastic 是 4 → 6,
// 兩處都只留下一句「taller cardboard sheets」,沒有理由、沒有斷言。
//
// 它是**兩件事**的同一個數字,所以走樣也是兩份:
//   1. 踏面的高度 —— 使用者的原話是「確實太厚」;
//   2. 豎邊貼圖的縱向重複 —— `quantized-terrain.ts` 的 `v = 絕對高程 / layerHeight`,
//      一階正好一張,就是 demo 的 `rep(plateEdgeTex, 0.05, 1 / PLATE_H)`。階高一放大,
//      同一張瓦楞就被縱向拉長 3.75 倍,楞的長寬比從 ~1:1 變成 1:3.3 —— 那是「豎邊的
//      fill 不是 POC 的風格」的機制,而它的成因只有階高一個。
//
// 所以這裡直接比公尺數,而且三個世界的值全部從 demo 原始碼切出來,一個常數都不打進來。
// 綁在 `layerHeight` 上的好處也一併釘住:改階高,貼圖自動跟著對,不會再有第二次走樣。
{
  const circuitStep = new Function(`
    ${sliceStatement(circuitSrc, 'const TERRAIN_STEP_H = ')}
    return TERRAIN_STEP_H;
  `)() as number;
  const rows: [string, number, number][] = [
    ['plastic (STEP_H)', plasticDemo.STEP_H, P_STEP],
    ['paper (PLATE_H)', paperDemo.PLATE_H, PA_STEP],
    ['circuit (TERRAIN_STEP_H)', circuitStep, (await createTerrainStyleStrategy('circuit')).params.layerHeight],
  ];
  for (const [what, demoH, gameH] of rows) {
    check(`${what}: gameview 的 layerHeight === demo 的階高`,
      Math.abs(demoH - gameH) < 1e-9, `demo ${demoH} m vs gameview ${gameH} m`);
  }
  // 貼圖的縱向重複**不是**另一個數字,它就是階高。這一條擋的是「以後有人補一個
  // 獨立的公尺數上去」—— 那樣兩者會再度各走各的。
  const wallMat = paper.createTerrainWallMaterial!() as THREE.MeshToonMaterial;
  check('瓦楞紙的切邊貼圖沒有自己的 repeat —— 縱向節奏由 uv(高程 / 階高)帶,'
    + '所以改階高的同時貼圖自動跟著對',
    !!wallMat.map && Math.abs(wallMat.map.repeat.x - 1) < 1e-9
    && Math.abs(wallMat.map.repeat.y - 1) < 1e-9,
    `repeat ${wallMat.map?.repeat.x} × ${wallMat.map?.repeat.y}`);
  wallMat.dispose();
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[circuit FR4 edge layers vs demo]');
// ═════════════════════════════════════════════════════════════════════════════
// 電子世界的高度**不編在顏色上**(阻焊色是分區的路標),編在切邊的銅箔層數上。
// 所以這裡驗的是畫布上的銅箔筆觸,不是頂點色。
const demoEdge = new Function(`
  ${sliceStatement(circuitSrc, 'const E = {')}
  ${sliceFn(circuitSrc, 'mulberry32')}
  ${sliceFn(circuitSrc, 'cv')}
  const TS = 256;
  const tex = (canvas) => ({ image: canvas });
  const toon = (o) => o;
  const THREE = { DoubleSide: 2 };
  const fr4Cache = { get: () => undefined, set: () => {} };
  ${sliceFn(circuitSrc, 'edgeMatForLevel')}
  return edgeMatForLevel;
`)() as (k: number) => { map: { image: RecCanvas } };

const circuit = await createTerrainStyleStrategy('circuit');
check('電子世界不上分層色(板面是一片阻焊,顏色被分區佔走了)',
  circuit.bandAt === undefined);
check('電子世界改用分階的切邊材質',
  typeof circuit.createTerrainWallMaterialForLevel === 'function'
  && (circuit.terrainWallLevels ?? 0) > 1, `${circuit.terrainWallLevels} 階`);

{
  const COPPER = '#b87333';
  /** 一張 FR4 切邊上的銅箔條:y 位置與粗細,由上到下。 */
  const copperBars = (ops: RectOp[]): string =>
    ops.filter((o) => o.fill.toLowerCase() === COPPER && o.alpha === 1)
      .map((o) => `${o.y.toFixed(2)}+${o.h.toFixed(2)}`)
      .sort()
      .join(' ');
  let bad = 0;
  const rows: string[] = [];
  for (let k = 0; k < (circuit.terrainWallLevels ?? 0); k++) {
    const d = copperBars(demoEdge(k).map.image.rects);
    const m = circuit.createTerrainWallMaterialForLevel!(k) as THREE.MeshToonMaterial;
    const g = copperBars(((m.map as THREE.CanvasTexture).image as RecCanvas).rects);
    rows.push(`階 ${k}: ${d.split(' ').length} 條`);
    if (d !== g) { bad++; console.log(`      階 ${k}\n        demo     ${d}\n        gameview ${g}`); }
  }
  check('每一階的銅箔層(位置 + 粗細)都跟 demo 的 edgeMatForLevel 一致', bad === 0,
    rows.join(', '));
  // 「越往上越多」—— 這條是規則,不是數值。
  const counts: number[] = [];
  for (let k = 0; k < (circuit.terrainWallLevels ?? 0); k++) {
    const m = circuit.createTerrainWallMaterialForLevel!(k) as THREE.MeshToonMaterial;
    counts.push(((m.map as THREE.CanvasTexture).image as RecCanvas).rects
      .filter((o) => o.fill.toLowerCase() === COPPER && o.alpha === 1).length);
  }
  let up = true;
  for (let k = 1; k < counts.length; k++) if (counts[k] <= counts[k - 1]) up = false;
  check('層數越往上越多', up, counts.join(' → '));
  // demo 的每一階都是**不同**的貼圖 —— 兩階撞成同一張就等於這個功能沒有生效。
  const uniq = new Set<unknown>();
  for (let k = 0; k < (circuit.terrainWallLevels ?? 0); k++) {
    const m = circuit.createTerrainWallMaterialForLevel!(k) as THREE.MeshToonMaterial;
    uniq.add((m.map as THREE.CanvasTexture).image);
  }
  check('每一階是自己的一張貼圖', uniq.size === (circuit.terrainWallLevels ?? 0));
  // …而材質本身必須是 strategy 擁有的 singleton(chunk 回收器不可以 dispose),
  // 否則每個 chunk 重畫四張 128×64。
  let shared = true, stable = true;
  for (let k = 0; k < (circuit.terrainWallLevels ?? 0); k++) {
    const a = circuit.createTerrainWallMaterialForLevel!(k);
    const b = circuit.createTerrainWallMaterialForLevel!(k);
    if (a !== b) stable = false;
    if (!a.userData?.shared) shared = false;
  }
  check('切邊材質是 cache 過的同一個實例(demo 的 fr4Cache)', stable);
  check('而且標了 userData.shared,chunk 回收器不會 dispose 它', shared);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[banding engine — 真的畫出來的那一份]');
// ═════════════════════════════════════════════════════════════════════════════
// 上面全部通過而畫面仍然可以是錯的:表對了不代表接對了。這一段餵一片合成的走廊
// 進**真正的** buildQuantizedCorridorGeometry,再從吐出來的 buffer 反推規則。

/**
 * 一條直的走廊,橫向線性上坡 —— 每一欄剛好落在不同的階上。
 *
 * `vc` 決定頂點色從哪來:積木那組刻意餵一個**色帶裡沒有的顏色**(純紅),分層設色
 * 漏接的話畫面會紅得很明顯;電子那組要走真正的 `terrainVertexColor`,因為它那條
 * 「板面不被高度染色」的斷言量的就是那個函式的輸出。
 */
function synthGrid(
  along: number, cross: number, slope: number, roadEle: number,
  vc: (ele: number, x: number, z: number) => [number, number, number] = () => [1, 0, 0],
) {
  const gx: number[] = [], gz: number[] = [], gele: number[] = [], gcol: number[] = [];
  for (let a = 0; a < along; a++) {
    for (let c = 0; c < cross; c++) {
      const off = (c - (cross - 1) / 2) * 25;
      const ele = roadEle + off * slope;
      gx.push(off);
      gz.push(-a * 25);
      gele.push(ele);
      gcol.push(...vc(ele, off, -a * 25));
    }
  }
  return { gx, gz, gele, gcol, along, cross };
}

{
  const ORIGIN = 100;
  const grid = synthGrid(9, 21, 0.18, 400);
  const data = buildQuantizedCorridorGeometry(grid, plastic, ORIGIN);
  const layerH = plastic.params.layerHeight;
  const nBands = plasticDemo.TERRAIN_BAND.length;
  const centerCol = Math.floor(grid.cross / 2);
  const clamp = (k: number) => (k < 0 ? 0 : k > nBands - 1 ? nBands - 1 : k);

  // 基準面:每一列的路面高度,quantise 過(引擎的定義,這裡從 grid 自己重算)。
  const datumOf = (a: number) => plastic.quantizeElevation(
    (grid.gele[a * grid.cross + centerCol] + grid.gele[(a + 1) * grid.cross + centerCol]) / 2);

  check('合成走廊真的跨越了整張表',
    new Set(Array.from(data.cellBand).map(clamp)).size === nBands,
    `用到 ${new Set(Array.from(data.cellBand).map(clamp)).size}/${nBands} 階`);

  // ① 踏面 = 色帶。每一格的頂面顏色必須**正好**是它那一階的 top。
  {
    let bad = 0;
    for (let id = 0; id < data.cellsA * data.cellsC; id++) {
      const want = plastic.bandAt!(clamp(data.cellBand[id]) * layerH).top;
      for (let v = 0; v < 6; v++) {                 // pushTopTri × 2 = 6 頂點/格
        const o = (id * 6 + v) * 3;
        if (Math.abs(data.colors[o] - want.r) > 1e-5
          || Math.abs(data.colors[o + 1] - want.g) > 1e-5
          || Math.abs(data.colors[o + 2] - want.b) > 1e-5) { bad++; break; }
      }
    }
    check('每一格踏面的顏色正好是它那一階的色帶', bad === 0, `${bad} 格不合`);
  }

  // ② 階數 = 比路面高幾層,而且 jitter 動不了它。
  {
    let bad = 0, jitterBad = 0;
    for (let a = 0; a < data.cellsA; a++) {
      const datum = datumOf(a);
      for (let c = 0; c < data.cellsC; c++) {
        const id = a * data.cellsC + c;
        if (Math.round((data.cellY[id] - datum) / layerH) !== data.cellBand[id]) jitterBad++;
        const i00 = a * grid.cross + c;
        const avg = (grid.gele[i00] + grid.gele[i00 + 1]
          + grid.gele[i00 + grid.cross] + grid.gele[i00 + grid.cross + 1]) / 4;
        if (Math.round((plastic.quantizeElevation(avg) - datum) / layerH) !== data.cellBand[id]) bad++;
      }
    }
    check('階數 = 這一格比腳下那條路高幾層', bad === 0, `${bad} 格不合`);
    check('heightJitter 不會把一格擠到隔壁階', jitterBad === 0,
      `jitter ${plastic.params.heightJitter} m / 階高 ${layerH} m,${jitterBad} 格被擠掉`);
  }

  // ②b 上面那條在**出廠設定**下是空話,必須另外量。
  //
  //     jitter 1.5 m 配階高 6 m,沉下去最多 0.25 階,`Math.round` 一定拉得回來
  //     —— 所以「用 jitter 前的高度算」跟「用 jitter 後的高度算」在出廠數字上
  //     完全等價,改成後者一個斷言都不會亮。可是這兩個旋鈕都在調校面板上,使用
  //     者把 jitter 拉過階高的一半,後者就會在一片平地上撒出隨機的色階。
  //     所以這裡刻意把它調到那個區域再問一次。
  {
    const savedJ = plastic.params.heightJitter;
    const savedL = plastic.params.layerHeight;
    plastic.params.heightJitter = savedL * 0.9;   // 沉下去 0.9 階 —— round 拉不回來
    const stressed = buildQuantizedCorridorGeometry(grid, plastic, ORIGIN);
    plastic.params.heightJitter = savedJ;
    let moved = 0;
    for (let i = 0; i < stressed.cellBand.length; i++) {
      if (stressed.cellBand[i] !== data.cellBand[i]) moved++;
    }
    check('把 heightJitter 拉到階高的 0.9 倍,階數還是一格都不動', moved === 0,
      `jitter ${(savedL * 0.9).toFixed(1)} m / 階高 ${savedL} m,${moved} 格改階`);
  }

  // ③ 路面那一階,以及路面以下,一律是沒動過的底板色。
  {
    const base = plastic.bandAt!(0).top;
    let bad = 0, n = 0;
    for (let id = 0; id < data.cellsA * data.cellsC; id++) {
      if (data.cellBand[id] > 0) continue;
      n++;
      const o = id * 6 * 3;
      if (Math.abs(data.colors[o] - base.r) > 1e-5 || Math.abs(data.colors[o + 2] - base.b) > 1e-5) bad++;
    }
    check('路面與路面以下都是第 0 階的底板色', bad === 0 && n > 0, `${n} 格,${bad} 格不合`);
  }

  // ④ 側面 = 等高線,而且是**上面那片板**的切口。
  //
  //    每一道豎面的 yTop 就是上面那格的踏面高度,所以「這道切口該是哪一階」可以
  //    直接從 buffer 自己的座標反推 —— 不必抄實作的走訪順序。若實作誤取了下面
  //    那格,顏色會是 yBot 那一階的,這裡就會抓到。
  {
    const wallStart = data.topIndexCount / 3 * 3;   // 頂面頂點數 = 索引數(未共用)
    const firstWallVert = data.topIndexCount;       // 每個索引一個頂點
    let bad = 0, discriminating = 0;
    let v = firstWallVert;
    void wallStart;
    while (v + 3 < data.positions.length / 3 + 1) {
      if ((v + 4) * 3 > data.positions.length) break;
      const yTop = data.positions[v * 3 + 1];
      const yBot = data.positions[(v + 2) * 3 + 1];
      const a = Math.max(0, Math.min(data.cellsA - 1,
        Math.round(-data.positions[v * 3 + 2] / 25) - 1));
      const lvl = Math.round((yTop + ORIGIN - datumOf(a)) / layerH);
      const lvlBot = Math.round((yBot + ORIGIN - datumOf(a)) / layerH);
      if (lvl !== lvlBot) discriminating++;
      const want = plastic.bandAt!(clamp(lvl) * layerH).side!;
      const o = v * 3;
      if (Math.abs(data.colors[o] - want.r) > 1e-5
        || Math.abs(data.colors[o + 1] - want.g) > 1e-5
        || Math.abs(data.colors[o + 2] - want.b) > 1e-5) bad++;
      v += 4;
    }
    check('每一道切口都是它上面那片板的側面色', bad === 0, `${bad} 道不合`);
    check('而且真的有上下不同階的切口在測這件事(不是全部同階)',
      discriminating > 0, `${discriminating} 道跨階`);
  }

  // ⑤ group 必須**剛好**切在踏面與切口之間。
  //    這條看起來像廢話,但它抓到過一個真的 bug:合併時 `positions`/`indices` 就
  //    是 `topPos`/`topIdx` 本人,合併完再讀 `topIdx.length` 拿到的是總數,於是
  //    group 0(踏面材質)吃掉了整份索引,牆的材質一次都沒被用到 —— 瓦楞紙的生
  //    紙板切邊整個變成踏面色,而且看起來完全合理。
  {
    const geo = quantizedDataToGeometry(data);
    const total = data.indices.length;
    const covered = geo.groups.reduce((s, g) => s + g.count, 0);
    const g0 = geo.groups.find((g) => g.materialIndex === 0);
    check('group 0(踏面)的長度剛好是踏面的索引數', g0?.count === data.topIndexCount,
      `${g0?.count} vs ${data.topIndexCount}`);
    check('所有 group 加起來剛好蓋滿索引 buffer,不重疊不溢出',
      covered === total
      && geo.groups.every((g) => g.start + g.count <= total)
      && geo.groups.reduce((s, g) => Math.max(s, g.start + g.count), 0) === total,
      `${covered} / ${total}`);
    check('牆真的分到了非 0 的材質槽',
      geo.groups.some((g) => (g.materialIndex ?? 0) > 0 && g.count > 0),
      geo.groups.map((g) => `${g.materialIndex}:${g.count}`).join(' '));
    geo.dispose();
  }

  // ⑥ 基準面是路面,不是 floating origin。originEle 會隨騎乘 rebase,拿它當基準
  //    的話舊 chunk 跟新 chunk 會分屬不同色階,邊界上出現一條色差線。
  {
    const other = buildQuantizedCorridorGeometry(grid, plastic, ORIGIN + 777);
    let bad = 0;
    for (let i = 0; i < data.colors.length; i++) {
      if (Math.abs(data.colors[i] - other.colors[i]) > 1e-6) bad++;
    }
    check('換掉 originEle,顏色一個 channel 都不動', bad === 0, `${bad} 個 channel 變了`);
    // 反向對照:路面本身抬高,色階就**必須**跟著走(不然它根本沒在看路面)。
    const lifted = buildQuantizedCorridorGeometry(
      synthGrid(9, 21, 0.18, 400 + 3 * plastic.params.layerHeight), plastic, ORIGIN);
    let same = true;
    for (let i = 0; i < data.cellBand.length; i++) {
      if (data.cellBand[i] !== lifted.cellBand[i]) { same = false; break; }
    }
    check('反向對照:整條路抬高三階,階數不變(基準面跟著路走)', same);
  }
}

// 電子的切邊分階:每一道豎面要落在**它自己那階**的 group 裡。
{
  const ORIGIN = 0;
  const grid = synthGrid(9, 21, 0.18, 400, (ele, x, z) => {
    const c = circuit.terrainVertexColor(ele, x, z);
    return [c.r, c.g, c.b];
  });
  const data = buildQuantizedCorridorGeometry(grid, circuit, ORIGIN);
  const layerH = circuit.params.layerHeight;
  const nLevels = circuit.terrainWallLevels!;
  const centerCol = Math.floor(grid.cross / 2);
  const datumOf = (a: number) => circuit.quantizeElevation(
    (grid.gele[a * grid.cross + centerCol] + grid.gele[(a + 1) * grid.cross + centerCol]) / 2);

  check('電子的牆分成 terrainWallLevels 個 group',
    data.wallIndexCounts.length === nLevels,
    `[${data.wallIndexCounts.join(', ')}] 個索引`);
  check('每一階都真的有牆落進去(不是全部擠在第 0 階)',
    data.wallIndexCounts.every((n) => n > 0), `[${data.wallIndexCounts.join(', ')}]`);
  {
    let bad = 0;
    let v = data.topIndexCount;
    for (let g = 0; g < nLevels; g++) {
      const quads = data.wallIndexCounts[g] / 6;
      for (let q = 0; q < quads; q++) {
        const yTop = data.positions[v * 3 + 1];
        const a = Math.max(0, Math.min(data.cellsA - 1,
          Math.round(-data.positions[v * 3 + 2] / 25) - 1));
        const lvl = Math.round((yTop + ORIGIN - datumOf(a)) / layerH);
        const want = lvl < 0 ? 0 : lvl > nLevels - 1 ? nLevels - 1 : lvl;
        if (want !== g) bad++;
        v += 4;
      }
    }
    check('每一道切口都在自己那階的 group 裡', bad === 0, `${bad} 道放錯`);
  }
  // 板面本身不能被染色 —— 這個世界的顏色是分區的路標。
  {
    let tinted = 0;
    for (let i = 0; i < data.topIndexCount * 3; i += 3) {
      if (data.colors[i] !== data.colors[i + 1] || data.colors[i + 1] !== data.colors[i + 2]) tinted++;
    }
    check('板面沒有被高度染色(踏面維持中性)', tinted === 0, `${tinted} 個頂點被染色`);
  }
}

// 瓦楞紙的踏面分桶:第 0 階(以及路面以下)是墊子,第 1 階以上才是紙板。
// 上面那一整段 `[paper 第 0 階 = 切割墊 vs demo]` 驗的是**材質**;這一段驗的是
// 「哪一片三角形拿到哪一份材質」—— 表對了不代表接對了。
{
  const ORIGIN = 137;
  // 橫向坡度取 0.05 而不是別處那個 0.18:0.18 的話連最靠中間的兩欄都已經差了一整
  // 階,走廊裡**一格第 0 階都沒有** —— 而第 0 階正是這一段要測的東西。
  const grid = synthGrid(9, 21, 0.05, 400);
  // 沿路也讓路面起伏:基準面因此逐列不同,下面從 z 反推的那個 `a` 才是**被測的**
  // (路面平的話反推錯了也照樣過)。
  for (let a = 0; a < grid.along; a++) {
    const bump = Math.sin(a * 0.9) * 6;
    for (let c = 0; c < grid.cross; c++) grid.gele[a * grid.cross + c] += bump;
  }
  const data = buildQuantizedCorridorGeometry(grid, paper, ORIGIN);
  const layerH = paper.params.layerHeight;
  const centerCol = Math.floor(grid.cross / 2);
  const datumOf = (a: number) => paper.quantizeElevation(
    (grid.gele[a * grid.cross + centerCol] + grid.gele[(a + 1) * grid.cross + centerCol]) / 2);

  check('瓦楞紙的踏面分成 terrainTopLevels 個桶',
    data.topIndexCounts.length === (paper.terrainTopLevels ?? 1),
    `[${data.topIndexCounts.join(', ')}] 個索引`);
  check('兩桶都真的有踏面落進去(不是全部擠在一桶)',
    data.topIndexCounts.every((n) => n > 0), `[${data.topIndexCounts.join(', ')}]`);
  check('兩桶加起來剛好是 topIndexCount(牆的起點沒有被挪掉)',
    data.topIndexCounts.reduce((s, n) => s + n, 0) === data.topIndexCount,
    `${data.topIndexCounts.join('+')} = ${data.topIndexCount}`);
  {
    // 每一片踏面三角形:從它自己的座標反推階數,再看它落在哪一桶。
    // 第一個頂點永遠是格子的 (a, c) 角(pushTopTri 的兩次呼叫都以 row a 開頭),
    // 所以 z 直接反推得到 a。
    let bad = 0, matTris = 0, boardTris = 0, belowRoad = 0, atRoad = 0;
    let v = 0;
    for (let g = 0; g < data.topIndexCounts.length; g++) {
      for (let t = 0; t < data.topIndexCounts[g] / 3; t++, v += 3) {
        const y = data.positions[v * 3 + 1];
        const a = Math.max(0, Math.min(data.cellsA - 1,
          Math.round(-data.positions[v * 3 + 2] / 25)));
        const lvl = Math.round((y + ORIGIN - datumOf(a)) / layerH);
        const want = lvl <= 0 ? 0 : Math.min(lvl, data.topIndexCounts.length - 1);
        if (want !== g) bad++;
        if (g === 0) { matTris++; if (lvl < 0) belowRoad++; if (lvl === 0) atRoad++; } else boardTris++;
      }
    }
    check('每一片踏面都落在自己那桶(第 0 階與路面以下 → 墊子)', bad === 0,
      `墊子 ${matTris} 片(第 0 階 ${atRoad} / 路面以下 ${belowRoad})、紙板 ${boardTris} 片,${bad} 片放錯`);
    check('而且第 0 階與路面以下兩種格子都真的在場(不是空話)',
      atRoad > 0 && belowRoad > 0, `第 0 階 ${atRoad} 片、路面以下 ${belowRoad} 片`);
  }
  {
    const geo = quantizedDataToGeometry(data);
    const total = data.indices.length;
    const covered = geo.groups.reduce((s, g) => s + g.count, 0);
    check('group:第 0 桶 materialIndex 0、第 1 桶 1,牆從 2 開始',
      geo.groups[0]?.materialIndex === 0 && geo.groups[0]?.count === data.topIndexCounts[0]
      && geo.groups[1]?.materialIndex === 1 && geo.groups[1]?.count === data.topIndexCounts[1]
      && geo.groups[2]?.materialIndex === 2,
      geo.groups.map((g) => `${g.materialIndex}:${g.count}`).join(' '));
    check('所有 group 加起來仍然剛好蓋滿索引 buffer,不重疊不溢出',
      covered === total
      && geo.groups.reduce((s, g) => Math.max(s, g.start + g.count), 0) === total,
      `${covered} / ${total}`);
    geo.dispose();
  }
  // 反向對照:另外兩個世界沒宣告 `terrainTopLevels`,踏面就該**只有一桶**,而且
  // 牆的 materialIndex 一格都不准動(它們是這一輪「一格都不該動」的那兩個)。
  for (const [name, s] of [['plastic', plastic], ['circuit', circuit]] as const) {
    const d = buildQuantizedCorridorGeometry(synthGrid(9, 21, 0.18, 400, (ele, x, z) => {
      const c = s.terrainVertexColor(ele, x, z);
      return [c.r, c.g, c.b];
    }), s, ORIGIN);
    const geo = quantizedDataToGeometry(d);
    check(`${name}: 沒宣告 terrainTopLevels → 踏面只有一桶,牆照舊從 materialIndex 1 開始`,
      s.terrainTopLevels === undefined
      && d.topIndexCounts.length === 1 && d.topIndexCounts[0] === d.topIndexCount
      && geo.groups[0]?.materialIndex === 0
      && (geo.groups[1]?.materialIndex ?? -1) === 1,
      geo.groups.map((g) => `${g.materialIndex}:${g.count}`).join(' '));
    geo.dispose();
  }
}

// 真的走一遍 `buildTerrainChunk`:材質陣列的組法才是畫面最後吃到的東西。
{
  const originLat = 25.08, originLon = 121.55, originEle = 400;
  const cosO = Math.cos((originLat * Math.PI) / 180);
  const points = Array.from({ length: 40 }, (_, i) => ({
    lat: originLat - (i * 40) / 111320, lon: originLon, ele: originEle,
  }));
  const sampler = {
    async prefetchBounds() {},
    getElevationSync: (_lat: number, lon: number) =>
      originEle + (lon - originLon) * 111320 * cosO * 0.18,
    async getElevation(lat: number, lon: number) { return this.getElevationSync(lat, lon); },
  };
  const terrain = await buildTerrainChunk(
    {
      points, cumulativeDistances: points.map((_, i) => i * 40), startIdx: 0,
      endIdx: points.length - 1, chunkIndex: 0, corridorHalfWidth: 500, gridSizeScale: 1,
    } as never,
    sampler as never, originLat, originLon, originEle, paper,
  );
  const mats = terrain.mesh.material as THREE.Material[];
  check('瓦楞紙的地形 mesh 拿到三份材質:墊子 / 紙板踏面 / 生瓦楞切邊',
    Array.isArray(mats) && mats.length === 3, `${Array.isArray(mats) ? mats.length : 1} 份`);
  check('第 0 格就是 strategy 那份切割墊 singleton',
    mats[0] === paper.createTerrainTopMaterialForLevel!(0));
  check('第 1 格是 per-chunk 的踏面材質(頂點色 + 蠟筆紋),不是 singleton',
    (mats[1] as THREE.MeshToonMaterial)?.vertexColors === true
    && mats[1]?.userData?.shared !== true);
  check('第 2 格是生瓦楞的切邊,不吃頂點色',
    (mats[2] as THREE.MeshToonMaterial)?.vertexColors === false && !!(mats[2] as THREE.MeshToonMaterial)?.map);
  // chunk 回收器只放過標了旗子的那一份 —— 這正是它能認出墊子的依據。
  check('三份裡只有墊子標了 userData.shared(chunk 回收器認的就是它)',
    mats.filter((m) => m.userData?.shared === true).length === 1);
  terrain.mesh.geometry.dispose();
  for (const m of mats) if (!m.userData?.shared) m.dispose();
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[studs follow their brick]');
// ═════════════════════════════════════════════════════════════════════════════
// 「同一塊塑膠射出來的東西不會兩個色」。凸點的顏色必須等於它站的那一格的踏面色。
// 走真正的 buildTerrainChunk + buildGroundStuds,合成 DEM(不連網)。
{
  const originLat = 25.08, originLon = 121.55, originEle = 400;
  const cosO = Math.cos((originLat * Math.PI) / 180);
  const points = Array.from({ length: 40 }, (_, i) => ({
    lat: originLat - (i * 40) / 111320, lon: originLon, ele: originEle,
  }));
  // 橫向線性上坡的合成 DEM:走廊裡剛好跨過好幾階。
  const sampler = {
    async prefetchBounds() {},
    getElevationSync: (_lat: number, lon: number) =>
      originEle + (lon - originLon) * 111320 * cosO * 0.18,
    async getElevation(lat: number, lon: number) { return this.getElevationSync(lat, lon); },
  };
  const cumulative = points.map((_, i) => i * 40);
  const terrain = await buildTerrainChunk(
    {
      points, cumulativeDistances: cumulative, startIdx: 0, endIdx: points.length - 1,
      chunkIndex: 0, corridorHalfWidth: 500, gridSizeScale: 1,
    } as never,
    sampler as never, originLat, originLon, originEle, plastic,
  );
  const studs = buildGroundStuds(plastic, {
    grid: terrain.heightGrid, originLat, originLon, originEle, zoneAt: () => null,
  });
  check('合成路線長得出凸點', studs !== null && studs.studCount > 0,
    `${studs?.studCount ?? 0} 顆,${studs?.meshes.length ?? 0} 個色桶`);
  check('凸點不只一個色桶(真的分到階了)', (studs?.meshes.length ?? 0) > 1,
    `${studs?.meshes.length ?? 0} 桶`);
  if (studs) {
    const m4 = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let bad = 0, n = 0;
    const bandsSeen = new Set<number>();
    for (const mesh of studs.meshes) {
      const col = (mesh.material as THREE.MeshToonMaterial).color.getHex();
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m4);
        p.setFromMatrixPosition(m4);
        const hit = sampleChunkCell(terrain.heightGrid, p.x, p.z, originEle);
        if (!hit) continue;
        n++;
        bandsSeen.add(hit.band);
        if (col !== plastic.groundStuds!.colorFor(null, Math.max(0, Math.min(
          (plastic.groundStuds!.bandCount ?? 1) - 1, hit.band)))) bad++;
      }
    }
    check('每一顆凸點都跟它腳下那一格同色', bad === 0, `${n} 顆,${bad} 顆不合`);
    check('而且凸點真的踩到了不只一階', bandsSeen.size > 1,
      `踩到 ${[...bandsSeen].sort((a, b) => a - b).join('/')} 階`);
    // 「等於底板色」不是廢話:colorFor(null, k) 必須是那一階的踏面色本人。
    let tie = 0;
    for (let k = 0; k < (plastic.groundStuds!.bandCount ?? 1); k++) {
      if (sameColor(plastic.bandAt!(k * P_STEP).top,
        `#${plastic.groundStuds!.colorFor(null, k).toString(16).padStart(6, '0')}`)) tie++;
    }
    check('colorFor(null, k) 就是第 k 階的踏面色', tie === (plastic.groundStuds!.bandCount ?? 1),
      `${tie}/${plastic.groundStuds!.bandCount} 階對上`);
  }
}

console.log(`\n[terrain banding vs demo] ${failures === 0 ? 'all clear' : `${failures} FAILURES`}`);
if (failures > 0 && !process.env.NO_EXIT_CODE) process.exitCode = 1;
