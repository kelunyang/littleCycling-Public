/**
 * Circuit (powered PCB) terrain style — the「單晶片機」look for the Three.js
 * world. The reference is `plan/circuit-town-demo.html` (the demo is the SPEC,
 * not a sketch); every colour, building recipe and night rule below is that
 * file's, cited where it helps.
 *
 * The world in one sentence: the diorama is a populated circuit board on an
 * anti-static bag, ringed by copper heatsink fins, and its signature move is
 * that AT NIGHT THE BOARD POWERS UP — the traces, the nixie digits, the tube
 * filament and the LEDs glow, and nothing else does.
 *
 * What carries the look:
 *  - Terrain tops are the solder-mask board texture: bundled bus routing on a
 *    4 px grid, 45° corners with staggered elbows, length-matched serpentines,
 *    outlined copper pours, silkscreen part outlines. Its emissiveMap is drawn
 *    IN THE SAME PASS as the face, so the night glow lands exactly on the
 *    traces (the demo's own rule: two separately drawn maps never line up).
 *  - Quantised terrain steps read as stacked boards: every riser shows the FR4
 *    cut edge with its copper layers.
 *  - Zone-driven buildings are electronic components (capacitor / nixie sign /
 *    transformer / DIP ICs / vacuum tube), all generic JEDEC-style package
 *    shapes — no maker's marks, no part numbers (copyright rule).
 *  - Only things that really emit light are in the night set:「全場一起發光等
 *    於沒有重點」. E-paper signs deliberately do NOT glow — reflective display.
 *
 *  - The ROUTE is the powered dupont wire: a chain of chorded, slightly arched
 *    wire bodies between moulded connector shells, hugging one side of the bus
 *    (`buildRouteBody` / `buildDupont`, the demo's own函式). It is the one thing
 *    in this world that must visibly glow, so its emissive rides the pulse map —
 *    and the pulse RUNS at the rider's cadence (`updateRiderSignals`), which is
 *    the demo's own rule:「踏頻決定脈衝沿走線行進的速度,功率決定亮度」.
 *  - Road CLASS is trace WIDTH (`BUS_W` = the demo's `ROAD_W`), and a class change
 *    is a 45° wedge Δ/2 metres long (`roadTaperLength` = the demo's `taperLen`),
 *    never a step — the same rule the board texture's routing grammar uses.
 *
 * NOT ported (deliberately, see the migration report): per-component bus stubs,
 * 電容環形光的 halo quads, the demo's own bloom chain (gameview's shared
 * SceneBloomPass carries it), resistor bushes (no gameview hook for樹叢),
 * stacked-board hills as props (the quantised terrain carries the stacking
 * instead), and the QFP/晶振 accessory minis.
 *
 * The current pulse and its joint sparks USED to be on that list, with the reason
 * "neither cadence nor power reaches a strategy". They both do now, through
 * `updateRiderSignals` (`RiderSignals` in terrain-style-strategy.ts) — the pulse
 * runs at cadence, the sparks fire as it passes each connector, and measured
 * watts scale the glow. What still does not port is the demo's daytime base glow:
 * see `DUP_GLOW_PEAK` for why `k` cannot live here and `wg` can.
 */

import * as THREE from 'three';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SceneBloomPass } from './scene-bloom-pass';
import { disposeGroup } from './bike-ornament';
import {
  nightLitFactor,
  registerNightLitMaterial,
  unregisterNightLitMaterial,
} from './building-lights';
import {
  celestialDiscRadius,
  defaultStyleParams,
  markInstanceTemplate,
  mulberry32,
  quantizeToLayer,
  type BikeOrnamentParts,
  type BuildingBox,
  type FinishAirshipParts,
  type RouteBody,
  type RouteGroundFn,
  type RoutePath,
  type SignPurpose,
  type StreetLampParts,
  type StyleParams,
  type TerrainStyleStrategy,
} from './terrain-style-strategy';
import { SIGN_RATIO, sanitizeSignText, signStrokes, SIGN_GLYPHS, type ZoneKind } from './sign-spec';
import { buildStrokeGeometry, buildSignTriangleGeometry } from './sign-builder';
import { ACRYLIC_CASE_RADIUS } from './acrylic-case';
import type { FinnedMountainRingStyle, MountainRingFins } from './mountain-ring';

// ═══════════════════════════════════════════════════════════════════════════
// Palette — the demo's `E`, verbatim. These are 3D scene colours (lit by the
// rig), not UI colours; the UI tokens live in themes.scss ($circuit).
// ═══════════════════════════════════════════════════════════════════════════
const E = {
  mask: 0x0d4f33,        // 阻焊綠
  maskHi: 0x17734c,
  maskLo: 0x073b26,
  fr4: 0xc9a86a,         // 板材切邊(玻纖)
  copper: 0xb87333,
  gold: 0xc9a227,
  goldHi: 0xefd77a,
  silk: 0xe4ece2,        // 絲印白
  ic: 0x16181c,          // IC 黑塑封
  icHi: 0x2a2e36,
  tin: 0xc2c8d2,         // 引腳鍍錫
  solder: 0xaeb6c2,      // 焊錫
  alu: 0x9aa4ad,         // 金屬罐(晶振)的鋁
  copperFin: 0xc0762f,   // 純銅鰭片(遠山)
  copperFinDeep: 0x8a4f1e,
  trace: 0x23f0ff,       // 通電發光
  hot: 0xff2d9b,
  foam: 0xe88bb4,        // 防靜電泡棉粉紅(雲)
  bagBase: 0x4a5058,     // 防靜電袋:暗鉛灰
  bagCrease: 0xc8d2dc,   // 折痕峰線
  bagShade: 0x2b3036,    // 折痕谷線
  ink: 0x071a14,
  epaper: 0xdcdfd6,      // 電子紙:反射式,**不發光**
  epaperRed: 0xc0392b,   // 黑/白/紅三色電子紙的第三色
  fpc: 0xc58a2e,         // FPC 軟排線的琥珀色
  acrylic: 0xcfe6ea,     // 防塵罩的染色
  acrylicRain: 0x9fc6d8,
  // ── 磷光。日月圓盤(圓形示波器的螢光屏)用的兩個型號 ──
  // P3 / P11 是 EIA/JEDEC 的**真實磷光型號**,不是調出來的兩個顏色:
  //   P3  (Zn,Be)₂SiO₄:Mn   琥珀黃   CIE 1931 x 0.523, y 0.469
  //   P11 ZnS:Ag            藍       CIE 1931 x 0.139, y 0.148
  // 這兩個 hex 是把上面的色度座標走 sRGB(D65)矩陣換算出來的,**不是挑的** ——
  // check:3d 的 [celestial design vs demos] 會拿 demo 註解裡那組座標把換算重跑
  // 一次。色域處理:P11 落在 sRGB 之外(R 是負的),走「保留色相、把純度收到色域
  // 邊界」(負值截到 0 再正規化),**不是**往白稀釋 —— 稀釋會推成青色,跟走線輝光
  // E.trace(#23f0ff)撞號(§3.3)。
  p3: 0xffa700,
  p11: 0x0085ff,
} as const;

/** CSS hex string for canvas painting. */
const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

/** Metres of ground per board-texture tile — the demo's own scale (一格貼圖 =
 *  65 × 65 世界單位: the 4 px routing grid lands on 1 m, trace pitch on 4 m). */
const PCB_TILE_METERS = 65;
/** Metres per anti-static-bag tile. The demo's disc: repeat 14 over r=1000 —
 *  「袋子的折痕是一張袋子上的幾道,鋪太密會變成布紋」. */
const ESD_TILE_METERS = 140;
/** Metres of road per bus-texture repeat (demo: u = d / 16). */
const BUS_TILE_METERS = 16;
/** 阻焊邊:製程參數,固定 1 公尺,不隨等級縮放(demo `const BUS_MASK = 1.0;`)。 */
const BUS_MASK = 1.0;
/**
 * 這個世界的走線寬度,一級一個 —— **demo 的 `ROAD_W`,一格沒動**:
 *
 * ```js
 * const ROAD_W = { motorway: 14, trunk: 12, primary: 12, secondary: 10, tertiary: 8, minor: 8 };
 * ```
 *
 * 這裡曾經放著 gameview 自己那張 [4..12] 的表,理由寫的是「demo 那些寬度存在只
 * 因為它的杜邦線貼著匯流排的一側走(DUP_LAT 3.9)」。**杜邦線現在就在這個檔案裡**
 * (見 `DUP_LAT` / `buildDupont`),所以那個理由不成立了 —— 它反過來變成必須照抄
 * 的理由:路線本體離中線 3.9 m,半寬只剩 2 m 的巷弄會讓整條路線掉到板子上,
 * 「路線跑在道路上」就不成立。demo 自己那段話就是規格:
 *
 * > 但**絕對寬度一定要壓縮**。遊戲的 4:12(1:0.33)搬過來會讓巷弄比路線本身還窄:
 * > 杜邦線貼著匯流排的一側走(DUP_LAT 3.9),半寬只剩 2 公尺的話整條路線會掉到板子
 * > 上,「路線跑在道路上」就不成立了。所以把 [4,12] 線性映到 [8,14]…
 * > 再**收斂成四個偶數線寬**(8 / 10 / 12 / 14),六級對四寬。這不是偷懶:真板子的
 * > 線寬本來就是製程的**離散選項**,不是連續刻度。而且偶數才讓 45° 錐段的兩端都
 * > 落在整公尺上(錐長 = Δ/2)。
 *
 * 順帶把當初那句「clearances are contracts」記錄成量出來的事實:`roadWidth` 在整個
 * repo 只有**一個**消費者(`road-renderer.ts` 的 ribbon 半寬)。建築讓路走的是
 * `building-renderer.ts` 的 `ROUTE_CLEARANCE_M = 4`(對**路線中線**,不是路寬),
 * 跟這張表沒有關係。
 *
 * ⚠ **六級只有四個寬度**(trunk = primary = 12、tertiary = minor = 8)。分級在
 * 「寬度」這一個維度上因此**分不出這兩對** —— 而這個世界的路面只有一種造型
 * (鍍金匯流排),顏色/貼圖都是寬度的函式(`busTexture(w)`),所以那兩對在 3D 裡
 * 是**完全同一條路**。demo 自己的話:「材質按**寬度**收,不是按等級收 —— 六級只有
 * 四個寬度」。demo 用「換級要求寬度差 ≥ 2」把撞號的兩級排開,gameview 的等級來自
 * MVT、排不開,所以 trunk 接 primary 在 3D 裡就是一條連續的路(錐長也剛好 = 0)。
 *
 * 但**寬度表是誰的**跟**阻焊邊怎麼算**是兩件事:demo 的規則(1 公尺,不隨等級
 * 縮放)套在這張表上照樣成立,而且正是它讓 `busTexture` 必須一種寬度一張。
 * 四個寬度 → 四張 128²,共 65 K texels(demo 同一段:「四張一次生完。總共才 65k
 * texels」),建一次給整條路線用。
 */
const BUS_W: Record<string, number> = {
  motorway: 14, trunk: 12, primary: 12, secondary: 10, tertiary: 8, minor: 8,
};
/**
 * 沒有等級可問時的公稱寬(跑道走 `aeroway-renderer`,它沒有 MVT 的道路等級,
 * 而 demo 從來沒有跑道 —— 見 `plan/demo-gaps.md` 第三級)。取 8 m,也就是這個
 * 檔案原本那張唯一貼圖的公稱寬,所以跑道的外觀一格沒動。
 */
const BUS_W_DEFAULT = 8;
/**
 * 高度覆蓋分區:超過這個(公尺)就是真空管地標,不管在哪一區。
 *
 * demo 的門檻是它自己那個合成 `scale`(>1.40),它要的其實是**比例**:約 1/9
 * 的站點。gameview 沒有那個量,只能改用公尺,所以這個數字是量出來的不是推出來的
 * ——`render-probe CENSUS=1` 跑真實大直路線,chunk2 的 795 個 footprint 裡有
 * **62 個**過門檻(`chunk2/deco13 x558` = 62 支真空管 × 9 圈柵極),7.8%,正好
 * 落在 demo 那一段。
 *
 * ⚠ 曾經憑感覺改成 45 m(「20 m 只是七層公寓」),那會讓地標掉到 1–2%,是把量
 * 過的東西換成猜的。要動這個數字請先重跑 probe。
 *
 * 這個數字跟 2D 的 `circuit-style.ts` `LANDMARK_M` **必須一致**:同一棟房子在
 * 兩個視角要是同一個元件,不然騎士切換 2D/3D 會看到兩座不同的城市。
 */
const LANDMARK_H = 20;

// ═══════════════════════════════════════════════════════════════════════════
// 遠山 = 兩圈散熱鰭片 — demo `heatsinkRing` 的兩個呼叫點
// ═══════════════════════════════════════════════════════════════════════════
/**
 * `plan/circuit-town-demo.html` 的兩個呼叫點,一格沒動:
 *
 * ```js
 * const mountNear = heatsinkRing({
 *   radius: 380, depth: 130, maxH: 92, baseH: 16, sink: 14, fins: 168, thick: 7, seed: 9319 });
 * const mountFar  = heatsinkRing({
 *   radius: 620, depth: 190, maxH: 230, baseH: 22, sink: 18, fins: 140, thick: 12, seed: 4177 });
 * ```
 *
 * `seed` 不在這裡:環自己逐圈發種子(`MountainRing.build()`),一次騎乘一條天際線。
 * `radius` / `maxH` 留著,但**不是拿來用的,是拿來當分母的** —— 它們是 demo 自己
 * 挑的世界尺寸,gameview 的兩圈半徑與高度尺度由 §3.6 決定(`mountain-ring.ts` 的
 * NEAR_/FAR_MAX_HEIGHT),所以這裡把 demo 其餘的數字**照著那兩個比例縮放**:
 *
 *   ・水平的(`depth`、`thick`)乘 kR = gameview 半徑 / demo 半徑 —— 鰭片的張角
 *     `thick / radius` 因此逐格等於 demo 的,梳子的疏密一模一樣;
 *   ・垂直的(`baseH`、`sink`)乘 kH = gameview 高度尺度 / demo maxH —— 底座對峰
 *     高的比例因此等於 demo 的;
 *   ・`fins` 是**個數**,沒有單位,照抄。
 */
const DEMO_HEATSINK_RING = {
  near: { radius: 380, depth: 130, maxH: 92, baseH: 16, sink: 14, fins: 168, thick: 7 },
  far: { radius: 620, depth: 190, maxH: 230, baseH: 22, sink: 18, fins: 140, thick: 12 },
} as const;

/**
 * 鰭片外緣(`radius + depth`)的上限,公尺 —— **唯一一個沒有照 kR 放大的 demo 數字**。
 *
 * 擋住它的是壓克力罩。demo 自己就守這條規矩,而且把理由寫在旁邊:
 *
 * > 半徑 CASE_R = 960:遠山圈之外(散熱鰭片外緣 620+190 = 810)、既有天空球
 * > (r=1100 的 skyMat)之內。
 *
 * gameview 的 `ACRYLIC_CASE_RADIUS` = 3200 是照著**簾幕**訂的(`acrylic-case.ts`:
 * 「Must sit OUTSIDE the far mountain ring (2600 m)」),而簾幕沒有徑向厚度。遠圈
 * 的 depth 照 kR 放大是 190 × (2600/620) = 797 m,外緣 3397 m —— 直接刺穿罩子。
 *
 * 讓步的是 depth 而不是罩子,因為 **depth 是這個環上唯一「改了看不出來」的數字**:
 * 環永遠以騎士為心,每一片鰭都正好側面對著眼睛,剪影就是它最內側那個端面,由
 * `radius` 與 `thick` 決定;depth 只決定底筒站在哪一圈。上限取 demo 自己的比例
 * (鰭片外緣 / CASE_R)套在 gameview 的罩子上,所以連這一步都還是 demo 的數字。
 */
const FIN_OUTER_LIMIT = ACRYLIC_CASE_RADIUS
  * ((DEMO_HEATSINK_RING.far.radius + DEMO_HEATSINK_RING.far.depth) / 960);

// ═══════════════════════════════════════════════════════════════════════════
// Procedural textures — ported from the demo (same drawing rules, same seeds
// where the seed is content: the routing grammar is the point, not the RNG).
// ═══════════════════════════════════════════════════════════════════════════
const TS = 256;
/** 佈線格點 / 束內線距 / 45° 轉角錯位 —「整齊」九成來自這三個數字。 */
const PCB_G = 4;
const PCB_P = 16;
const PCB_STAG = 8;
const PCB_TOP = { face: hex(E.gold), glow: hex(E.trace), w: 3.0, via: hex(E.goldHi), vg: hex(E.trace) };
const PCB_BOT = { face: '#8f7420', glow: '#0d7f90', w: 2.5, via: '#b39134', vg: '#0d7f90' };

function cv(w: number, h?: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h ?? w;
  return c;
}

/** 畫在九宮格上,四邊都不會被切掉(只畫真的會壓到畫布的那幾格)。 */
function wrap9(
  g: CanvasRenderingContext2D, draw: () => void, x: number, y: number, r: number,
): void {
  for (let dx = -1; dx <= 1; dx++) {
    if (dx < 0 && x <= TS - r) continue;
    if (dx > 0 && x >= r) continue;
    for (let dy = -1; dy <= 1; dy++) {
      if (dy < 0 && y <= TS - r) continue;
      if (dy > 0 && y >= r) continue;
      g.save();
      g.translate(dx * TS, dy * TS);
      draw();
      g.restore();
    }
  }
}

/** A no-op 2D context stand-in, for the face-only variant (the bike frame needs
 *  no glow map; the demo counted 146k pixel-writes saved). */
const NULL_CTX = (() => {
  const o: Record<string, () => void> = {};
  for (const k of ['fillRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill',
    'arc', 'save', 'restore', 'translate', 'closePath', 'clip', 'strokeRect']) o[k] = () => {};
  return o as unknown as CanvasRenderingContext2D;
})();

/**
 * The board's routing, drawn ONCE onto two canvases: the visible face (solder
 * mask + gold traces + white silkscreen) and a black-backed glow map for the
 * emissive channel. One pass for both is what guarantees the night glow lands
 * on the traces (demo:「分開各畫一次的話兩張對不齊,夜裡會看到光跑在板子的空白
 * 處」).
 *
 * The four rules that make it read as ROUTING and not scribble (demo v2):
 * everything on the PCB_G grid; traces run in equal-pitch bundles; corners are
 * 45° with elbows staggered by PCB_STAG; and one bundle runs length-matched
 * serpentines. Copper pours have an outline (mask relief edge + thermal grid +
 * stitching vias); every trace lays a mask-coloured clearance stroke first.
 */
function pcbTextures(seed: number, faceOnly?: boolean): {
  face: HTMLCanvasElement; glow: HTMLCanvasElement | null;
} {
  const face = cv(TS);
  const glow = faceOnly ? null : cv(TS);
  const g = face.getContext('2d')!;
  const q = glow ? glow.getContext('2d')! : NULL_CTX;
  const rng = mulberry32(seed);
  const G = PCB_G, P = PCB_P, STAG = PCB_STAG;
  const snap = (v: number): number => Math.round(v / G) * G;

  g.fillStyle = hex(E.mask);
  g.fillRect(0, 0, TS, TS);
  q.fillStyle = '#000000';
  q.fillRect(0, 0, TS, TS);

  type Lane = { face: string; glow: string; w: number; via: string; vg: string };
  const vias: [number, number, number, Lane][] = [];
  const via = (x: number, y: number, r: number, L: Lane): void => { vias.push([x, y, r, L]); };
  const XY = (h: boolean, a: number, b: number): [number, number] => (h ? [a, b] : [b, a]);

  function drawTrace(pts: [number, number][], L: Lane): void {
    const pass = (ctx: CanvasRenderingContext2D, col: string, lw: number): void => {
      ctx.strokeStyle = col;
      ctx.lineWidth = lw;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    };
    pass(g, hex(E.mask), L.w + 5);   // clearance:裸板上隱形,鋪銅上讓出間隙
    pass(g, L.face, L.w);
    pass(q, '#000000', L.w + 5);
    pass(q, L.glow, L.w);
  }

  /** 一束等距平行走線,中間一次 45° 閃避(轉出去、平走、轉回來 = 無縫)。 */
  function busBundle(h: boolean, lane0: number, count: number, L: Lane, forceDir?: number): void {
    const dir = forceDir ?? (rng() > 0.5 ? 1 : -1);
    const jl = G * (rng() > 0.5 ? 3 : 2);
    const j0 = snap(84 + rng() * 24);
    const runLen = snap(24 + rng() * 40);
    const lanes: number[] = [];
    for (let i = 0; i < count; i++) {
      const b = lane0 + i * P;
      const x1 = j0 - dir * STAG * i;
      const x2 = x1 + jl, x3 = x2 + runLen, x4 = x3 + jl;
      drawTrace([
        XY(h, -8, b), XY(h, x1, b), XY(h, x2, b + dir * jl),
        XY(h, x3, b + dir * jl), XY(h, x4, b), XY(h, TS + 8, b),
      ], L);
      lanes.push(b);
    }
    // 過孔排成一列;40 / 236 永遠落在閃避段之外的直線上(demo 的推導)。
    const va = rng() > 0.5 ? 40 : 236;
    for (const b of lanes) {
      const xy = XY(h, va, b);
      via(xy[0], xy[1], L.w + 2.2, L);
    }
  }

  /** 等長蛇形:三條線,齒數 5/4/3 —— 一眼認得出的等長回繞。 */
  function matchedBundle(h: boolean, lane0: number, L: Lane): void {
    const SP = 36, A = 12, W = 32;
    const x0 = snap(44 + rng() * 12);
    for (let i = 0; i < 3; i++) {
      const b = lane0 + i * SP;
      const pts: [number, number][] = [XY(h, -8, b)];
      for (let k = 0; k < 5 - i; k++) {
        const xa = x0 + k * W, d = k % 2 ? -1 : 1;
        pts.push(XY(h, xa, b));
        pts.push(XY(h, xa + A, b + d * A));
        pts.push(XY(h, xa + W - A, b + d * A));
        pts.push(XY(h, xa + W, b));
      }
      pts.push(XY(h, TS + 8, b));
      drawTrace(pts, L);
    }
  }

  /** 鋪銅區:八角銅面,邊緣退阻焊、內部散熱網格、邊上縫合過孔。 */
  function pourRegion(x0: number, y0: number, w: number, h: number): void {
    const ch = 16;
    const path = (ctx: CanvasRenderingContext2D): void => {
      ctx.beginPath();
      ctx.moveTo(x0 + ch, y0);
      ctx.lineTo(x0 + w - ch, y0);
      ctx.lineTo(x0 + w, y0 + ch);
      ctx.lineTo(x0 + w, y0 + h - ch);
      ctx.lineTo(x0 + w - ch, y0 + h);
      ctx.lineTo(x0 + ch, y0 + h);
      ctx.lineTo(x0, y0 + h - ch);
      ctx.lineTo(x0, y0 + ch);
      ctx.closePath();
    };
    // fill() 而非 fillRect():這塊不該去搶 headless probe 的替身色判定。
    g.fillStyle = hex(E.maskHi);
    path(g); g.fill();
    g.save();
    path(g); g.clip();
    g.strokeStyle = hex(E.maskLo);
    g.lineWidth = 2;
    for (let x = x0; x <= x0 + w; x += G * 4) { g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y0 + h); g.stroke(); }
    for (let y = y0; y <= y0 + h; y += G * 4) { g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + w, y); g.stroke(); }
    g.strokeStyle = hex(E.copper);
    g.lineWidth = 7;
    path(g); g.stroke();
    g.restore();
    g.strokeStyle = '#06301f';
    g.lineWidth = 1.5;
    path(g); g.stroke();
    // 地平面夜裡也通電,但只給一點點 —— 主角是走線
    q.globalAlpha = 0.12;
    q.fillStyle = hex(E.trace);
    path(q); q.fill();
    q.globalAlpha = 1;
    for (let x = x0 + ch; x <= x0 + w - ch; x += G * 6) {
      via(x, y0, 3.4, PCB_BOT);
      via(x, y0 + h, 3.4, PCB_BOT);
    }
  }

  pourRegion(snap(20 + rng() * 8), snap(100 + rng() * 8), 112, 100);
  pourRegion(snap(148 + rng() * 8), snap(20 + rng() * 8), 84, 68);
  busBundle(false, 44, 3, PCB_BOT);
  busBundle(false, 156, 4, PCB_BOT);
  busBundle(true, 20, 5, PCB_TOP);
  matchedBundle(true, 116, PCB_TOP);
  busBundle(true, 224, 2, PCB_TOP, -1);

  for (const [x, y, r, L] of vias) {
    wrap9(g, () => {
      g.fillStyle = L.via;
      g.beginPath(); g.arc(x, y, r, 0, 6.284); g.fill();
      g.fillStyle = '#120f08';
      g.beginPath(); g.arc(x, y, r * 0.42, 0, 6.284); g.fill();
    }, x, y, r + 1);
    if (glow) {
      const qq = q;
      wrap9(qq, () => {
        qq.fillStyle = L.vg;
        qq.beginPath(); qq.arc(x, y, r * 0.78, 0, 6.284); qq.fill();
      }, x, y, r + 1);
    }
  }

  // 絲印:元件外框 + 極性點 + 刻度,一樣上格點,不寫字(§3.7)。絲印也進 glow
  // (走線的一半亮度)—— 住宅區(電容)按規矩沒有燈,腳下這一格格的光就是它夜裡
  // 的照明,而破例讓電容發光是這個世界最不能犯的錯(demo 的原話)。
  g.lineWidth = 1.6;
  g.strokeStyle = hex(E.silk);
  q.lineWidth = 1.6;
  q.strokeStyle = hex(E.silk);
  for (let i = 0; i < 6; i++) {
    const w = snap(24 + rng() * 36), h = snap(12 + rng() * 24);
    const x = snap(12 + rng() * (TS - 24 - w)), y = snap(12 + rng() * (TS - 24 - h));
    g.globalAlpha = 0.72;
    g.strokeRect(x, y, w, h);
    g.beginPath(); g.arc(x + 5, y + 5, 2.2, 0, 6.284); g.stroke();
    q.globalAlpha = 0.34;
    q.strokeRect(x, y, w, h);
    q.beginPath(); q.arc(x + 5, y + 5, 2.2, 0, 6.284); q.stroke();
    g.globalAlpha = 0.42;
    q.globalAlpha = 0.2;
    for (let k = 0; k < 3; k++) {
      const ty = y + h + 4 + k * G;
      g.beginPath(); g.moveTo(x, ty); g.lineTo(x + snap(w * (0.3 + rng() * 0.5)), ty); g.stroke();
    }
    g.globalAlpha = 1;
    q.globalAlpha = 1;
  }
  return { face, glow };
}

/**
 * 鍍金匯流排(道路):阻焊開窗露出鍍金,兩側留一道阻焊邊。v 是橫向。
 *
 * demo 的原話,一個字沒改:
 *
 * > **一種道路等級一張**(見「道路分級 → 走線寬度」)。等級決定的是帶子在世界裡
 * > 有多寬,而阻焊邊是**製程參數** —— 真板子上它是固定的 mm 數,不會跟著線寬一起
 * > 放大。所以邊界佔貼圖高度的比例 = BUS_MASK / w:粗線的綠邊窄、細線的綠邊寬,
 * > 換算回世界剛好都是 1 公尺。同一個寬度只畫一次(busTexCache)。
 * >
 * > 畫的順序刻意翻過來:先鋪滿鍍金再壓兩道阻焊邊(舊版是先鋪滿阻焊再開窗)。
 * > 出來的圖一模一樣,但「覆蓋面積最大的 fillRect」從阻焊變成鍍金 —— headless
 * > probe 拿那個當替身色,翻過來之後探針圖裡的路才是金的(才看得出寬度分級),
 * > 而且少畫一整張畫布的底。
 *
 * 這裡曾經是**一張** `m = 16`(12.5%)的貼圖,而 12.5% 是把 demo 的 1 公尺除以
 * 它自己的 8 m 公稱寬算出來的比例,再套到每一級上 —— 於是阻焊邊在高速公路變成
 * 1.50 m、次要道路 0.50 m。那不是製程參數了,讀起來像窄路上的金被銼掉。
 */
const busTexCache = new Map<number, HTMLCanvasElement>();
function busTexture(w: number): HTMLCanvasElement {
  const hit = busTexCache.get(w);
  if (hit) return hit;
  const c = cv(128, 128);
  const g = c.getContext('2d')!;
  const rng = mulberry32(0x5150);
  const m = Math.max(4, Math.round(128 * BUS_MASK / w));    // 阻焊邊(px)
  g.fillStyle = hex(E.gold);
  g.fillRect(0, 0, 128, 128);
  const grad = g.createLinearGradient(0, m, 0, 128 - m);
  grad.addColorStop(0, hex(E.gold));
  grad.addColorStop(0.5, hex(E.goldHi));
  grad.addColorStop(1, hex(E.gold));
  g.fillStyle = grad;
  g.fillRect(0, m, 128, 128 - 2 * m);
  for (let i = 0; i < 130; i++) {
    g.globalAlpha = 0.05 + rng() * 0.12;
    g.strokeStyle = rng() > 0.5 ? '#fff1b8' : '#8a6f18';
    g.lineWidth = 0.6 + rng() * 1.2;
    const y = m + 2 + rng() * (128 - 2 * m - 4);
    g.beginPath(); g.moveTo(0, y); g.lineTo(128, y + (rng() - 0.5) * 2); g.stroke();
  }
  g.globalAlpha = 1;
  g.fillStyle = hex(E.maskLo);
  g.fillRect(0, 0, 128, m);
  g.fillRect(0, 128 - m, 128, m);
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.fillRect(0, m, 128, 2);
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.fillRect(0, 128 - m - 2, 128, 2);
  busTexCache.set(w, c);
  return c;
}

/** 電流脈衝:黑底上幾顆亮團,offset 一推就是電流在跑(demo `pulseTexture`)。
 *  它是杜邦線身的 emissiveMap —— 電流跑在線**裡面**,不跑在路面上。 */
function pulseTexture(): HTMLCanvasElement {
  const c = cv(256, 16);
  const g = c.getContext('2d')!;
  g.fillStyle = '#000000';
  g.fillRect(0, 0, 256, 16);
  for (let i = 0; i < 3; i++) {
    const x = i * 85 + 20;
    for (let r = 34; r > 0; r--) {
      g.globalAlpha = 0.035 * (1 - r / 34) + 0.01;
      g.fillStyle = hex(E.trace);
      g.fillRect(x - r, 0, r * 2, 16);
    }
  }
  g.globalAlpha = 1;
  return c;
}

/**
 * 接點火花:一顆放射狀衰減的白點(demo `sparkTexture`,一格沒動)。demo 的原話:
 *
 * > **故意不填背景** —— 畫布本來就是全透明的,加色混合下沒畫到的地方就是沒貢獻;
 * > 填一層黑底反而會讓它在 headless probe 裡被當成「這張貼圖是黑的」。沒有這層
 * > 衰減的話,加色的方片會閃成一個硬邊正方形。
 */
function sparkTexture(): HTMLCanvasElement {
  const c = cv(64, 64);
  const g = c.getContext('2d')!;
  g.fillStyle = '#dffbff';
  g.globalAlpha = 0.06;
  for (let r = 30; r > 0; r--) {
    g.beginPath(); g.arc(32, 32, r, 0, 6.284); g.fill();
  }
  g.globalAlpha = 1;
  return c;
}

/**
 * 疊層小丘的切邊:**銅箔層數 = 高度**(demo 的 `edgeMatForLevel`)。
 *
 * demo 的原話,一個字沒改:
 *
 * > 這是製圖的分層設色套進這個世界的版本,但走的不是顏色 —— 電子世界的顏色已經
 * > 被分區佔走了(阻焊色是分區的路標),再拿它編碼高度,低地的醫院區跟高地的住
 * > 宅區會撞成同一色。所以換一個軸。
 * >
 * > 切邊正好是製圖慣例裡**等高線該在的位置**(層積模型的垂直面就是上面那片板的
 * > 切口)。而真實的多層板,切邊看到的就是那疊層數:2 層、4 層、6 層 —— 越往上
 * > 越多。物理上是真的。
 *
 * 玻纖織紋沿用 gameview 這張已經在跑的(demo 那版織紋是單色的 `E.fr4w`,這裡
 * 早就換成了雙色交替 —— 那是既有的移植決定,不在這次要換的東西裡)。這次搬進來
 * 的是**銅箔層**:層數公式、內外層粗細、插入位置、以及 rng 的種子偏移,全部照抄。
 */
const FR4_MAX_LEVEL = 4;
function fr4EdgeTexture(level = 0): HTMLCanvasElement {
  const layers = Math.min(8, 2 + level * 2);            // 2 / 4 / 6 / 8,到頂就不再加
  const c = cv(128, 64);
  const g = c.getContext('2d')!;
  const rng = mulberry32(0xf4 + layers);
  g.fillStyle = hex(E.fr4);
  g.fillRect(0, 0, 128, 64);
  g.globalAlpha = 0.16;
  for (let i = 0; i < 128; i += 5) {
    g.fillStyle = i % 10 ? '#8f7233' : '#e6cf9a';
    g.fillRect(i, 0, 3, 64);
  }
  for (let i = 0; i < 64; i += 5) {
    g.fillStyle = i % 10 ? '#a8873f' : '#dcc48c';
    g.fillRect(0, i, 128, 3);
  }
  g.globalAlpha = 1;
  // 銅箔層:上下兩面固定,中間依層數平均插入。**外層畫粗一點** —— 真的板子外層
  // 銅厚就是比內層厚,而且遠看只有外層那兩道撐得住。
  g.fillStyle = hex(E.copper);
  g.fillRect(0, 2, 128, 3);
  g.fillRect(0, 59, 128, 3);
  for (let i = 1; i < layers / 2; i++) {
    const y = 2 + (57 * i) / (layers / 2);
    g.fillRect(0, y, 128, 1.6);
    g.fillRect(0, 61 - (y - 2), 128, 1.6);
  }
  g.fillStyle = hex(E.maskLo);
  g.fillRect(0, 0, 128, 2);
  g.fillRect(0, 62, 128, 2);
  for (let i = 0; i < 90; i++) {
    g.globalAlpha = 0.1 + rng() * 0.2;
    g.fillStyle = rng() > 0.5 ? '#f0e0b4' : '#6b5525';
    g.fillRect(rng() * 128, rng() * 64, 1 + rng() * 3, 1);
  }
  g.globalAlpha = 1;
  return c;
}

/**
 * 防靜電袋(桌面):暗鉛灰底 + 導電網紋 + 折痕。亮的只有折痕峰線 —— 金屬感放
 * 在線上不是面上,夜裡整片才沉得下去(demo 的解法,包含「步進整除 TS」與
 * 「波數取整」兩條無縫規則,以及**不畫 ESD 警告三角**:平鋪貼圖承載不了只出現
 * 一次的記號)。
 */
function esdBagTexture(): HTMLCanvasElement {
  const c = cv(TS);
  const g = c.getContext('2d')!;
  const rng = mulberry32(0xba9);
  g.fillStyle = hex(E.bagBase);
  g.fillRect(0, 0, TS, TS);

  const STEP = TS / 32;
  for (const dir of [1, -1]) {
    g.strokeStyle = 'rgba(206,214,222,0.14)';
    g.lineWidth = 0.7;
    for (let k = -32; k <= 64; k++) {
      g.beginPath();
      g.moveTo(k * STEP, 0);
      g.lineTo(k * STEP + dir * TS, TS);
      g.stroke();
    }
  }
  for (let i = 0; i < 11; i++) {
    const y0 = rng() * TS;
    const w = 1 + Math.floor(rng() * 3), ph = rng() * 6.283;
    const seg = 32;
    const path = (off: number): void => {
      g.beginPath();
      for (let k = 0; k <= seg; k++) {
        const x = (k / seg) * TS;
        const y = y0 + off + Math.sin((x / TS) * Math.PI * 2 * w + ph) * 5;
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    };
    g.globalAlpha = 0.5 + rng() * 0.3;
    g.strokeStyle = hex(E.bagCrease);
    g.lineWidth = 1.3;
    path(0);
    g.globalAlpha = 0.3;
    g.strokeStyle = hex(E.bagShade);
    g.lineWidth = 2.2;
    path(2.4);
  }
  g.globalAlpha = 1;
  return c;
}

/** 鋪銅面(公園等地被):亮一階的銅 + 散熱網格開口 + 斜刷痕。 */
function pourTexture(): HTMLCanvasElement {
  const c = cv(TS);
  const g = c.getContext('2d')!;
  g.fillStyle = hex(E.copper);
  g.fillRect(0, 0, TS, TS);
  g.globalAlpha = 0.35;
  g.fillStyle = hex(E.maskLo);
  for (let x = 0; x < TS; x += 16) {
    for (let y = 0; y < TS; y += 16) g.fillRect(x + 5, y + 5, 7, 7);
  }
  g.globalAlpha = 0.2;
  g.strokeStyle = '#f0c98a';
  g.lineWidth = 2;
  for (let i = -TS; i < TS * 2; i += 23) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + TS, TS); g.stroke(); }
  g.globalAlpha = 1;
  return c;
}

// ═══════════════════════════════════════════════════════════════════════════
// 五格地被的貼圖 —— demo 的 `luFarmTex` / `luWetTex` / `luSportsTex` /
// `luPlayTex` / `luSandTex`,逐件照抄
// ═══════════════════════════════════════════════════════════════════════════
// 兩條軸是 demo 先定好的(三個世界都照這兩條走,只是各自用自己的語彙講):
//
//   A. 自然那一對要分得出來,而且都不准「長一棵樹」—— park / forest 已經在種
//      `discCapTree`(§3.3 一個元件只能有一個身分),所以農田與濕地再種圓片電容
//      就是把詞彙量做成虛胖的。
//      · 農田 = **規則的行列**(人種的:壟、等距)
//      · 濕地 = **不規則 + 水**(沒有行列,有積水與叢生)
//   B. 玩具那三個差在**結構的量**:球場平(只有線)/ 遊樂場有小結構(五格裡唯一
//      站得起來的)/ 沙地沒有結構,只有顆粒。
//
// §3.4 眼高法則是最硬的約束:騎士的眼睛只在地面上 6.3 m,掠角看過去,而這五格全部
// 躺平 —— 細節在那個角度一律死掉。所以每一格只賭**一個**活得下來的訊號:
//   農田 → 壟的方向與間距(銅條做**寬**:4 m 一道,跟板子上匯流排束同節距)
//   濕地 → 濕(深色 + 半透)+ 叢生的剪影
//   球場 → 白絲印線的**寬度**(0.75 m,真球場線 0.1 m 的七倍;照真值畫等於沒畫)
//   遊樂場 → 剪影(所以它是唯一站得起來的)
//   沙地 → 顏色與粗糙度

/**
 * 一格貼圖 = 幾公尺。地被 slab 是 `ShapeGeometry` 的 **world uv**(單位:公尺),
 * 所以 repeat = 1 / 這個數 ——「每公尺幾格」。跨 chunk 因此天然接得上:壟不會在
 * chunk 邊界錯位,絲印的格點也不會。demo 的 `LU_TILE`,原封。
 */
const LU_TILE = { farmland: 16, wetland: 20, sports: 24, playground: 12, sand: 10 } as const;

/**
 * 地被材質的深度階。demo 的 `luApplyDepth(mat, kind)` 在 gameview 這一側是
 * `landuse-renderer` 的 `applyOverlayDepth(mat, kind)` —— **名次由它給**(那張表住
 * 在 `overlay-depth.ts`,demo 的 `LU_RANK` 就是照抄它的),所以這裡只留旗標,
 * factor / units 一律等呼叫端蓋上去。
 *
 * 那為什麼旗標要留在工廠裡:五個工廠也會被**直接**呼叫(`diorama.ts` 的
 * 「polygon-offset lifted off the terrain」那組,以及 `props-vs-demo.ts`),那條路
 * 上沒有人幫忙蓋。旗標本來就是這個材質的一部分(demo 的 luApplyDepth 也開它),
 * 留著是描述事實,不是為了讓檢查變綠。
 */
const LU_DEPTH = { polygonOffset: true } as const;

/**
 * 農田 = **條狀洞洞板**(stripboard / 萬用板),不是「洞洞板孔陣」。
 *
 * 改的理由只有一個,而且是 §3.4:**一片孔陣讀不出方向**。等距的孔在掠角下就是
 * 雜訊,而農田唯一活得下來的訊號正是「壟往哪個方向、隔多遠」。條狀洞洞板的銅條
 * 本來就是一道一道平行的銅 —— 它同時給了方向、間距,而且孔還在(孔在銅條上,
 * 那就是行內的株距)。
 *
 * 顏色:綠阻焊底 + 裸銅條。銅的暖橘 = 翻過的土,條間露出來的綠 = 作物。底色
 * **沒有**用 FR4 素板的黃褐:那個色被沙地(玻纖鑽屑)佔走了,兩塊躺平的黃褐地在
 * 掠角下就是同一塊(§3.2 手感撞號比輪廓撞號更難察覺)。
 *
 * 節距:銅條 64 px = 4 m(跟匯流排束同節距),孔 32 px = 2 m。兩個都整除 256,
 * 而且所有元素都留在畫布內 —— 無縫(§7.1)。
 */
function luFarmTexture(): HTMLCanvasElement {
  const c = cv(TS);
  const g = c.getContext('2d')!;
  g.fillStyle = hex(E.mask);
  g.fillRect(0, 0, TS, TS);
  for (let i = 0; i < 4; i++) {
    const y = 10 + i * 64;
    g.fillStyle = hex(E.copper);
    g.fillRect(0, y, TS, 44);
    // 蝕刻出來的銅條有側面:上緣迎光、下緣是陰影。少了這兩道,四條銅在掠角下
    // 會糊成一片橘,壟的「一道一道」就沒有了。
    g.fillStyle = '#d8974a';
    g.fillRect(0, y, TS, 4);
    g.fillStyle = '#7d4a1c';
    g.fillRect(0, y + 40, TS, 4);
    // 孔:鍍金焊環 + 中間真的那個洞。株距 2 m。
    for (let k = 0; k < 8; k++) {
      const hx = (k + 0.5) * 32;
      g.fillStyle = hex(E.gold);
      g.beginPath(); g.arc(hx, y + 22, 8, 0, Math.PI * 2); g.fill();
      g.fillStyle = hex(E.goldHi);
      g.beginPath(); g.arc(hx, y + 22, 6, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#1a1208';
      g.beginPath(); g.arc(hx, y + 22, 3, 0, Math.PI * 2); g.fill();
    }
  }
  return c;
}

/**
 * 濕地 = **助焊劑殘膜**(rosin flux residue)。
 *
 * ⚠ 這一格唯一要贏的比較是**跟焊錫池分得開**(§3.2)。焊錫池是
 * `metal(E.solder, 200)` —— 硬、鏡面、不透、灰;殘膜是霧面、半透、深琥珀、黏。
 * **手感完全反過來**,所以連材質類別都換掉:池是 Phong 高光,這裡是 toon 沒有
 * 高光。兩塊都躺在地上,但一塊會反出天空、一塊不會。
 *
 * 「不規則」在三個地方同時講:環本身是資料給的多邊形、白化殘膜的斑塊是亂數 +
 * wrap9、蘆葦是叢生不是行列。一條直線都沒有。
 *
 * 斜的拖刷痕間距 32 px —— 45° 的斜線只有在間距整除畫布寬時才接得起來。
 * (`pourTexture` 那組是 `i += 23`,23 不整除 256,那張其實有一條斜縫;不照抄。)
 */
function luWetTexture(): HTMLCanvasElement {
  const c = cv(TS);
  const g = c.getContext('2d')!;
  const rng = mulberry32(0x51ce);
  g.fillStyle = '#6d4f1c';
  g.fillRect(0, 0, TS, TS);
  g.globalAlpha = 0.18;
  g.strokeStyle = '#946c24';
  g.lineWidth = 7;
  for (let i = -TS; i < TS * 2; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + TS, TS); g.stroke(); }
  // 白化殘膜:助焊劑吸了濕氣之後泛出來的那層乳白。**大而淡**(5 片、半徑 34–60、
  // alpha 0.16–0.30),它是一層鋪開的膜,不是一顆一顆的東西。
  // rng() 在 wrap9 外面呼叫 —— 不然九宮格拿到的是九個不同的點,而不是同一個點
  // 的九份複製(§7.1)。
  //
  // 第一版是「膜」跟「積水」兩組都畫成差不多大的圓斑,結果整張讀成**迷彩**:
  // 兩種一樣大的斑點在掠角下就是雜訊,「濕」完全出不來。所以改成兩個尺度 ——
  // 膜大、水窪小,而且水窪加一圈亮邊(表面張力的邊緣本來就會挑光)。
  for (let i = 0; i < 5; i++) {
    const x = rng() * TS, y = rng() * TS, r0 = 34 + rng() * 26;
    g.globalAlpha = 0.16 + rng() * 0.14;
    g.fillStyle = '#cbb68d';
    wrap9(g, () => { g.beginPath(); g.arc(x, y, r0, 0, Math.PI * 2); g.fill(); }, x, y, r0);
  }
  // 積水:小、深、有亮邊。深色才讀得出「這裡是濕的」—— 亮的一律讀成乾掉的粉。
  for (let i = 0; i < 7; i++) {
    const x = rng() * TS, y = rng() * TS, r0 = 8 + rng() * 11;
    g.globalAlpha = 0.62;
    g.fillStyle = '#2c1f08';
    wrap9(g, () => { g.beginPath(); g.arc(x, y, r0, 0, Math.PI * 2); g.fill(); }, x, y, r0);
    g.globalAlpha = 0.4;
    g.strokeStyle = '#d8c79c';
    g.lineWidth = 2;
    wrap9(g, () => { g.beginPath(); g.arc(x, y, r0, 0, Math.PI * 2); g.stroke(); }, x, y, r0 + 2);
  }
  g.globalAlpha = 1;
  return c;
}

/**
 * 球場 = **一塊絲印區**,而且是照元件外框的畫法畫的。
 *
 * **只畫一張。** 這裡本來還有第二張 glow 畫布當 emissiveMap,而 demo 已經刪掉了:
 * 「通電的那一圈:鍍金走線 + 四角過孔。**只畫金,不再另外畫一張發光圖** ——
 * 夜裡照亮這塊地的是場邊那顆 LED 路燈,不是地面自己」。少一張 256×256 的畫布、
 * 少一張貼圖,而球場的夜間照明改由路燈負責。
 *
 * 場地線是**絲印白**(這個世界標邊界本來就用它,分區邊界那道線同一種);場地
 * 外圍那一圈是**鍍金走線 + 四角過孔**。
 * 左上角切一刀 45° + 一個實心點 —— 那是絲印的 pin 1 記號,也剛好是球場的角。
 * 全部 45°/90°,而且落在格點上。
 */
function luSportsTextures(): HTMLCanvasElement {
  const face = cv(TS);
  const g = face.getContext('2d')!;
  // 底是**暗一階的阻焊**。用板子那個綠的話,球場會讀成「板子上畫了幾條線」;
  // 壓暗之後白絲印的對比拉到最大,而那是這一格唯一活得下來的訊號。
  g.fillStyle = hex(E.maskLo);
  g.fillRect(0, 0, TS, TS);
  // 通電的那一圈:鍍金走線 + 四角過孔。**只畫金**,沒有第二張發光圖(demo)。
  const R = 14;
  g.strokeStyle = hex(E.gold); g.lineWidth = 5;
  g.strokeRect(R, R, TS - R * 2, TS - R * 2);
  for (const vx of [R, TS - R]) {
    for (const vy of [R, TS - R]) {
      g.fillStyle = hex(E.goldHi);
      g.beginPath(); g.arc(vx, vy, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#1a1208';
      g.beginPath(); g.arc(vx, vy, 3.5, 0, Math.PI * 2); g.fill();
    }
  }
  // 絲印:場地外框(左上角 45° 倒角 = pin 1)、中線、中圈、兩個禁區。
  g.strokeStyle = hex(E.silk);
  g.lineWidth = 8;
  g.beginPath();
  g.moveTo(34, 62); g.lineTo(62, 34); g.lineTo(222, 34);
  g.lineTo(222, 222); g.lineTo(34, 222); g.closePath();
  g.stroke();
  g.beginPath(); g.moveTo(34, 128); g.lineTo(222, 128); g.stroke();
  g.beginPath(); g.arc(128, 128, 40, 0, Math.PI * 2); g.stroke();
  g.strokeRect(34, 82, 30, 92);
  g.strokeRect(192, 82, 30, 92);
  g.fillStyle = hex(E.silk);
  g.beginPath(); g.arc(128, 128, 7, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(52, 52, 6, 0, Math.PI * 2); g.fill();
  return face;
}

/**
 * 遊樂場 = **麵包板**(solderless breadboard)。
 *
 * 提案是「排針 + 跳線帽的攀爬架」,不能用:那**就是** checkpoint
 * (`buildCheckpoint`:排針座 + 一顆跳線帽),同一組兩個零件、同一個組合方式,
 * §3.3 的原話就是這種情況。所以整組換掉,而麵包板反而更對題 —— 麵包板是電子
 * 世界裡**專門拿來玩的**那塊板子:東西插上去、拔下來、再插一次,不焊死。遊樂場
 * 的語感一模一樣,而且「結構是插在上面的」剛好給了三件小結構一個站得住的理由。
 *
 * 也試過 **防靜電泡棉**(軟、粉紅、正好是遊樂場的軟墊):駁回,泡棉是這個世界
 * 的**雲**(`E.foam`,天上那些)。同一個零件在天上一次地上一次,就是 §3.3。
 *
 * 米白 ABS + 中央溝 + 上紅下藍電源軌 + 插孔陣列。插孔節距 16 px = 0.75 m,
 * 比農田的株距(2 m)細一倍有餘 —— 兩塊有孔的板子靠這個分開。
 */
function luPlayTexture(): HTMLCanvasElement {
  const c = cv(TS);
  const g = c.getContext('2d')!;
  g.fillStyle = '#ddd8c6';
  g.fillRect(0, 0, TS, TS);
  // 中央溝:跨接 DIP 的那一道。麵包板最好認的特徵就是它。
  g.fillStyle = '#c3bda8';
  g.fillRect(0, 116, TS, 24);
  g.fillStyle = '#a9a28c';
  g.fillRect(0, 116, TS, 3);
  g.fillRect(0, 137, TS, 3);
  // 電源軌:上紅下藍。真的麵包板就是印這兩條,不是自己配的色。
  g.fillStyle = '#c0392b';
  g.fillRect(0, 13, TS, 4);
  g.fillStyle = '#1e56b8';
  g.fillRect(0, 239, TS, 4);
  // 插孔。16 整除 256 → 無縫;孔在 x = k*16+5,最右一格右緣 245 < 256,不跨界。
  g.fillStyle = '#2b2a24';
  for (let k = 0; k < 16; k++) {
    const x = k * 16 + 5;
    for (const y of [26, 42, 58, 74, 90, 150, 166, 182, 198, 214]) g.fillRect(x, y, 6, 6);
    // 電源軌旁邊那排是**五孔一組**、組間留一格 —— 真麵包板的軌是斷開的。
    if (k % 6 !== 5) { g.fillRect(x, 4, 6, 6); g.fillRect(x, 246, 6, 6); }
  }
  return c;
}

/**
 * 沙地 = **玻纖鑽屑**(PCB 鑽孔粉塵)+ 混在裡面的**錫珠**。
 *
 * 提案是純錫珠。改的理由是 §3.2:錫珠是**焊錫**,而焊錫池是這個世界的**水體**
 * —— 一塊躺平的地被跟水用同一種材料,遠看就是同一個東西,而且沙地跟水正好最
 * 常相鄰(海灘)。所以主體換成鑽屑:FR4 的玻纖磨成粉本來就是**沙**(玻纖=玻璃
 * =矽砂,這條路是真的),顏色是暖砂色,跟綠板、跟灰錫都拉得開。
 * 錫珠沒有丟掉 —— 它們變成混在沙裡的粗粒(貼圖上十六顆,地上再擺八顆幾何),
 * 那也是真的:鑽孔粉塵跟回流爐掉出來的錫珠本來就混在同一個工作面上。
 *
 * §3.4 說沙地活下來的訊號是**顏色與粗糙度**,所以這張圖只做這兩件事:一個亮
 * 暖色的底 + 三個色階的顆粒,一條線都沒有。顆粒一律 wrap9(不然邊上會被切一刀,
 * 拼起來就是一條縫)。
 */
function luSandTexture(): HTMLCanvasElement {
  const c = cv(TS);
  const g = c.getContext('2d')!;
  const rng = mulberry32(0x5a2d);
  g.fillStyle = '#cfbc93';
  g.fillRect(0, 0, TS, TS);
  // 兩個尺度的粗糙度。第一版只有細顆粒(1–3 px = 5–12 cm),在 40 m 外整片平掉,
  // 而「顆粒」正是這一格唯一活得下來的訊號之一 —— 細節在掠角下平掉就等於沒畫。
  // 所以先鋪一層**大而淡的堆積**(半徑 0.7–2 m 的粉堆,它在遠處還讀得到),
  // 再撒細顆粒給近處。
  for (let i = 0; i < 14; i++) {
    const x = rng() * TS, y = rng() * TS, r0 = 18 + rng() * 22;
    g.globalAlpha = 0.22;
    g.fillStyle = i % 2 ? '#e0d3ac' : '#ac9770';
    wrap9(g, () => { g.beginPath(); g.arc(x, y, r0, 0, Math.PI * 2); g.fill(); }, x, y, r0);
  }
  g.globalAlpha = 1;
  const tones = ['#e4d8b6', '#bda780', '#9b8a63'];
  for (let i = 0; i < 300; i++) {
    const x = rng() * TS, y = rng() * TS, r0 = 1.2 + rng() * 2.0;
    g.fillStyle = tones[Math.floor(rng() * 3)];
    wrap9(g, () => { g.beginPath(); g.arc(x, y, r0, 0, Math.PI * 2); g.fill(); }, x, y, r0);
  }
  for (let i = 0; i < 13; i++) {
    const x = rng() * TS, y = rng() * TS, r0 = 4.0 + rng() * 2.6;
    g.fillStyle = hex(E.solder);
    wrap9(g, () => { g.beginPath(); g.arc(x, y, r0, 0, Math.PI * 2); g.fill(); }, x, y, r0);
    // 錫珠是球,球一定有一點高光 —— 少了它就只是灰點。高光壓成暖白而不是純白:
    // 純白配上灰錫,在暖砂色旁邊會被眼睛讀成藍色的小果子。
    g.fillStyle = '#e6e2dc';
    wrap9(g, () => {
      g.beginPath(); g.arc(x - r0 * 0.3, y - r0 * 0.3, r0 * 0.33, 0, Math.PI * 2); g.fill();
    }, x, y, r0);
  }
  return c;
}

/**
 * 合併本體(`CircuitMass`)裡每一根圓柱的段數。
 *
 * demo 的 `cyl()` 一律走 16 段的共用 `unitCyl` —— 對 demo 那是**零成本**,因為
 * 它每根圓柱都是一顆指向同一份幾何的 Mesh。gameview 不行:`buildBuildingBody`
 * 的合約是回傳**已經合併的**幾何(整個 chunk 一次 draw call),所以每一段圓柱
 * 都是逐棟樓寫進 JS 陣列的頂點,段數直接乘上 chunk 的建構時間。
 *
 * 量出來的(`render-probe CENSUS=1`,大直路線 chunk2 的 795 個 footprint,同一
 * 台機器,各三次取中位數):
 *   demo 的 16 段     → **371 ms**、verts 863k、tris 1686k
 *   這裡的 12 段      → **321 ms**、verts 706k、tris 1608k
 *   (移植進來時的 8 / 10 / 12 / 14 混用 → 294 ms —— 但那不是量出來的,是重寫
 *    時各憑感覺挑的,DIP 的一腳凹點只有 8 面、輝光管的管座只有 10 面。)
 * 所以這是**一條量過的裁減**:單一數字、可稽核,代價 +27 ms、換掉全套 16 段要
 * 再 +50 ms。三角形數對幀時間實測零相關
 * (`plan/render-mechanism-comparison.md`),chunk 建構時間不是 —— 這是唯一還
 * 站得住的成本,所以裁的是它。
 *
 * **共用的那幾份幾何(`unitCyl`、`ledBody`)不裁**:它們一輩子只建一次,
 * demo 的 16 段照抄。
 */
const BODY_SEGS = 12;

// ═══════════════════════════════════════════════════════════════════════════
// CircuitMass — vertex-coloured flat-shaded geometry accumulator for the
// merged building bodies (the corrugated world's `PaperMass` pattern: a dense
// chunk builds hundreds of bodies, so no per-part BoxGeometry + merge).
// ═══════════════════════════════════════════════════════════════════════════
const MASS_COLOR = new THREE.Color();

class CircuitMass {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly col: number[] = [];
  private readonly idx: number[] = [];
  private r = 1;
  private g = 1;
  private b = 1;

  paint(hexColor: number): this {
    MASS_COLOR.setHex(hexColor);
    this.r = MASS_COLOR.r;
    this.g = MASS_COLOR.g;
    this.b = MASS_COLOR.b;
    return this;
  }

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(this.r, this.g, this.b);
  }

  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
  ): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = dx - ax, vy = dy - ay, vz = dz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    // Degenerates are dropped, not emitted: invisible in the CPU rasteriser,
    // drawn (and shaded) by WebGL — the probe-blindness the memory note warns
    // about.
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    const base = this.pos.length / 3;
    this.vert(ax, ay, az, nx, ny, nz);
    this.vert(bx, by, bz, nx, ny, nz);
    this.vert(cx, cy, cz, nx, ny, nz);
    this.vert(dx, dy, dz, nx, ny, nz);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    const base = this.pos.length / 3;
    this.vert(ax, ay, az, nx, ny, nz);
    this.vert(bx, by, bz, nx, ny, nz);
    this.vert(cx, cy, cz, nx, ny, nz);
    this.idx.push(base, base + 1, base + 2);
  }

  /** Axis-aligned solid block centred on (x, y, z), optional yaw about +y. */
  block(w: number, h: number, d: number, x: number, y: number, z: number, rotY = 0): void {
    const hw = w / 2, hh = h / 2, hd = d / 2;
    const cy_ = Math.cos(rotY), sy = Math.sin(rotY);
    const X = (dx: number, dz: number): [number, number] =>
      [x + dx * cy_ + dz * sy, z - dx * sy + dz * cy_];
    const [ax, az] = X(-hw, -hd);
    const [bx, bz] = X(hw, -hd);
    const [cx2, cz2] = X(hw, hd);
    const [dx2, dz2] = X(-hw, hd);
    // top / bottom
    this.quad(ax, y + hh, az, bx, y + hh, bz, cx2, y + hh, cz2, dx2, y + hh, dz2);
    this.quad(ax, y - hh, az, dx2, y - hh, dz2, cx2, y - hh, cz2, bx, y - hh, bz);
    // four sides
    this.quad(ax, y - hh, az, bx, y - hh, bz, bx, y + hh, bz, ax, y + hh, az);
    this.quad(bx, y - hh, bz, cx2, y - hh, cz2, cx2, y + hh, cz2, bx, y + hh, bz);
    this.quad(cx2, y - hh, cz2, dx2, y - hh, dz2, dx2, y + hh, dz2, cx2, y + hh, cz2);
    this.quad(dx2, y - hh, dz2, ax, y - hh, az, ax, y + hh, az, dx2, y + hh, dz2);
  }

  /** Vertical cylinder (axis +y), capped both ends. */
  cylinderY(r: number, h: number, x: number, y: number, z: number, segs = 12): void {
    const y0 = y - h / 2, y1 = y + h / 2;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const x0 = x + Math.cos(a0) * r, z0 = z + Math.sin(a0) * r;
      const x1 = x + Math.cos(a1) * r, z1 = z + Math.sin(a1) * r;
      // Side winds so the outward normal faces away from the axis.
      this.quad(x0, y0, z0, x0, y1, z0, x1, y1, z1, x1, y0, z1);
      this.tri(x, y1, z, x0, y1, z0, x1, y1, z1);
      this.tri(x, y0, z, x1, y0, z1, x0, y0, z0);
    }
  }

  /** Horizontal cylinder along local +x — the transformer coil when the
   *  building's long axis is x. Same body as `cylinderZ`, different axis:
   *  the demo's coil is always wound with its axis along the lamination
   *  direction, and gameview's footprint decides which world axis that is. */
  cylinderX(r: number, len: number, x: number, y: number, z: number, segs = 12): void {
    const x0 = x - len / 2, x1 = x + len / 2;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const y0 = y + Math.sin(a0) * r, z0 = z + Math.cos(a0) * r;
      const y1 = y + Math.sin(a1) * r, z1 = z + Math.cos(a1) * r;
      this.quad(x0, y0, z0, x0, y1, z1, x1, y1, z1, x1, y0, z0);
      this.tri(x1, y, z, x1, y0, z0, x1, y1, z1);
      this.tri(x0, y, z, x0, y1, z1, x0, y0, z0);
    }
  }

  /** Horizontal cylinder along local +z (the transformer coil), capped. */
  cylinderZ(r: number, len: number, x: number, y: number, z: number, segs = 12): void {
    const z0 = z - len / 2, z1 = z + len / 2;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const x0 = x + Math.cos(a0) * r, y0 = y + Math.sin(a0) * r;
      const x1 = x + Math.cos(a1) * r, y1 = y + Math.sin(a1) * r;
      this.quad(x0, y0, z0, x1, y1, z0, x1, y1, z1, x0, y0, z1);
      this.tri(x, y, z1, x0, y0, z1, x1, y1, z1);
      this.tri(x, y, z0, x1, y1, z0, x0, y0, z0);
    }
  }

  /**
   * Append a ready-made THREE geometry, transformed by `m` and painted the
   * current colour.
   *
   * For the parts the demo builds out of a THREE primitive rather than out of
   * boxes — `unitSphere` (SphereGeometry(1, 14, 10)) is the disc-cap tree's
   * canopy — this is the only way to keep the demo's ACTUAL topology instead of
   * re-deriving a lookalike out of quads. It also carries a rotation the
   * box/cylinder helpers cannot express (`block` only yaws; the tree's legs
   * splay about z).
   */
  merge(geo: THREE.BufferGeometry, m: THREE.Matrix4): void {
    const src = geo.index ? geo.toNonIndexed() : geo;
    const p = src.getAttribute('position');
    const n = src.getAttribute('normal');
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const v = new THREE.Vector3();
    const base = this.pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(m);
      const px = v.x, py = v.y, pz = v.z;
      v.set(n.getX(i), n.getY(i), n.getZ(i)).applyMatrix3(nm).normalize();
      this.vert(px, py, pz, v.x, v.y, v.z);
    }
    for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    if (src !== geo) src.dispose();
  }

  geometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.idx);
    return geo;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Zone → component. The demo's table (`ZONE_BUILDER` + `ZONE_NEIGHBOURS`):
//   residential 電解電容 / commercial 輝光管招牌 / industrial 變壓器 /
//   school 黑塑封 DIP / hospital 白陶瓷 DIP + 紅 LED / 地標 真空管(高度覆蓋)
// ═══════════════════════════════════════════════════════════════════════════
type CircuitKind = ZoneKind | 'landmark';

/** 80% 該區招牌建築、20% 鄰近型別 — the demo's neighbour bias, verbatim. */
const ZONE_NEIGHBOURS: Record<ZoneKind, readonly ZoneKind[]> = {
  residential: ['commercial', 'school'],
  commercial: ['residential', 'industrial'],
  industrial: ['commercial', 'residential'],
  school: ['residential', 'hospital'],
  hospital: ['residential', 'school'],
};

/**
 * Which component this footprint is. Deterministic in `(seed, zone, height)`
 * on its OWN stream — never the chunk's shared RNG (adding a consumer there
 * re-rolls every downstream building; the demo's sign bug), and never a
 * shuffle bag (bags carry order-dependent state; a building must not change
 * shape when you ride back past it).
 *
 * Height OVERRIDES zone past LANDMARK_H: a tall roll is a vacuum tube whatever
 * district it stands in — it is this world's landmark.
 *
 * Outside every zone → the electrolytic capacitor, the world's most generic
 * component (mirrors the paper world's "unzoned = eraser" answer).
 */
function circuitKind(zone: ZoneKind | null, seed: number, height: number): CircuitKind {
  if (height > LANDMARK_H) return 'landmark';
  if (!zone) return 'residential';
  const rng = mulberry32((seed * 2246822519 + 0xc1c) >>> 0);
  if (rng() < 0.8) return zone;
  const near = ZONE_NEIGHBOURS[zone];
  return near[Math.floor(rng() * near.length)] ?? zone;
}

/** A second derived stream for size details, distinct from the kind roll so
 *  tuning one can never re-roll the other. */
function detailRng(seed: number): () => number {
  return mulberry32((seed * 3266489917 + 0x51c) >>> 0);
}

// ── Layouts — ONE function per body feeds the mass, the trim AND the lights,
// so the three can never disagree (the rule: whatever decides the shape
// decides the lights). All in the box's local frame; the long footprint axis
// is where repeated features (pins, tubes) go so the street side sees them.

function longAxis(box: BuildingBox): { along: 'x' | 'z'; L: number; W: number } {
  return box.width >= box.depth
    ? { along: 'x', L: box.width, W: box.depth }
    : { along: 'z', L: box.depth, W: box.width };
}

/**
 * Place (a, b) — `a` on the long axis, `b` across it — into local (x, z).
 *
 * The two branches are a **rotation** of each other (`R_y(π/2)`), never the
 * obvious swap. `[b, a]` is a REFLECTION: it hands back the building's mirror
 * image, so every chiral feature reads backwards on whichever half of the
 * footprints happens to be longer the other way. That shipped: the nixie
 * sign's seven-segment glyphs came out mirrored on every footprint with
 * `depth > width` (a "2" reading as "S"), and the DIP's pin-1 dimple sat on the
 * wrong corner. Neither a bounding box nor a triangle count can see it — the
 * whole building is exactly as wide, as tall and as many triangles either way.
 *
 * `hand` is which way the demo's own builder wound its along axis, and the two
 * families disagree: `nixieSign` / `longDip` build on local +X and then turn
 * the whole group (`grp.rotation.y = Math.PI / 2` / `inner.rotation.y = …`),
 * while `transformer` is built directly in the placed frame with x = across.
 * Those conventions are mirror images of each other, so the transformer asks
 * for `hand = -1` and keeps its own. Whatever `hand` is, the two branches stay
 * a rotation apart — that is the invariant, and `circuit-3d-vs-demo.ts`
 * asserts it against the demo for both footprint orientations.
 */
function onAxis(along: 'x' | 'z', a: number, b: number, hand: 1 | -1 = 1): [number, number] {
  return along === 'x' ? [a, hand * b] : [b, -hand * a];
}

/**
 * …and the matching yaw, because a part is **turned**, never re-axised.
 *
 * `onAxis` alone moves a part's centre; what it cannot do is carry the part's
 * own orientation, and swapping its width and depth instead ("it comes out the
 * same box") is where the rewrite crept back in: `longDip` is literally one
 * line, `inner.rotation.y = Math.PI / 2`, and a swapped box is that line's
 * result only if the box happens to be symmetric under it. Feed every oriented
 * part `frameYaw` and the whole local frame turns as one piece — which is what
 * the demo does, and the reason a footprint that is longer the other way can
 * never come out as anything but the same building, turned.
 */
function frameYaw(along: 'x' | 'z', hand: 1 | -1 = 1): number {
  return along === 'x' ? 0 : hand * Math.PI / 2;
}

function capLayout(box: BuildingBox, seed: number) {
  const rng = detailRng(seed);
  const r = Math.max(1.4, Math.min(box.width, box.depth) * 0.46);
  const h = Math.max(3, box.height - 1.1);
  return { r, h, tint: Math.floor(rng() * 3), footH: 0.6 };
}

function nixieLayout(box: BuildingBox, seed: number) {
  const rng = detailRng(seed);
  const { along, L, W } = longAxis(box);
  const H = box.height;
  const r = Math.max(1.1, Math.min(1.25 + H * 0.045, W * 0.42));
  const pitch = r * 2.5;
  const tubes = Math.max(2, Math.min(4, Math.floor(L / pitch)));
  const LUG = 1.0, SOCK = 1.4;
  const sw = pitch * tubes + 1.4;
  const sd = Math.min(W, r * 2.7);
  const y0 = LUG + SOCK;
  const bodyH = Math.max(3.4, H - y0 - 1.2 - r);
  // 下限 1.3:數字太小的話 0.34 的條段會佔掉半個字寬(demo)。
  const dw = Math.max(1.3, Math.min(r * 1.32, bodyH * 0.32));
  const dy = y0 + 1.2 + bodyH * 0.54;
  // **一管一組**。demo 的抽取迴圈在 `for (let i = 0; i < tubes; i++)` **裡面**,
  // 所以每支管子有自己的三個數字;移植時它被抬到迴圈外,整面招牌因此每一管都
  // 亮同一個數字 —— 三管的招牌讀成「777」。輝光管招牌是拿來顯示一個**數**的,
  // 每管同號等於把它退回成一個字。
  const digits: number[][] = [];
  for (let i = 0; i < tubes; i++) {
    const d3: number[] = [];
    // 三個數字強制不重複 —— 抽到同一個,三層段位就完全疊死(demo)。
    while (d3.length < 3) {
      const v = Math.floor(rng() * 10);
      if (!d3.includes(v)) d3.push(v);
    }
    digits.push(d3);
  }
  return { along, r, pitch, tubes, LUG, SOCK, sw, sd, y0, bodyH, dw, dy, digits };
}

function xformerLayout(box: BuildingBox, seed: number) {
  const rng = detailRng(seed);
  const { along, L, W } = longAxis(box);
  const baseH = 1.3;
  const coreH = Math.max(3, box.height - baseH);
  // **抽取順序照 demo**:`W = coreH*(0.5+rng*0.14)` 先、`D = coreH*(0.78+rng*0.2)`
  // 後。兩個 rng() 對調的話兩個尺寸互換係數,整批變壓器的比例就跟 demo 不同了。
  // 疊層方向沿路(長軸)—— 側面才看得到一條一條(demo)。
  const Wc = Math.min(W * 0.9, coreH * (0.5 + rng() * 0.14) + W * 0.2);
  const D = Math.min(L * 0.9, coreH * (0.78 + rng() * 0.2) + L * 0.2);
  const n = 7 + Math.floor(rng() * 4);
  const th = D / n;
  const Rc = Math.min(Wc * 0.66, W * 0.48);
  const coilL = D * 0.5;
  const cy = baseH + coreH * 0.5;
  return { along, baseH, coreH, D, W: Wc, n, th, Rc, coilL, cy };
}

function dipLayout(box: BuildingBox, _seed: number) {
  const { along, L, W } = longAxis(box);
  const w = Math.max(6, L * 0.94);
  const d = Math.max(3, W * 0.8);
  // demo `dipDims`:`h = 3.4 + H * 0.24`,**沒有亂數**。那兩個 rng 抽取
  // (`w += rng()*3`、`d += rng()*1.5`)是**長度與寬度**的抖動,而 gameview 的
  // 長寬是地圖給的,所以它們沒有落點 —— 移植時其中一個被挪到了 `h` 上面,那正
  // 是 demo 那一行紅字禁止的事(「抽到的高度往**長度**長,不往高度長。DIP 拉高
  // 會變成一塊沒有特徵的黑牆」)。高度回到 demo 的純函數;`min(box.height, …)`
  // 留著,因為地圖會給 `height = 0`。
  const h = Math.max(2.6, Math.min(box.height, 3.4 + box.height * 0.24));
  const LIFT = 2.8; // 本體離板 = 看得到的那一段腳(demo DIP_LIFT)
  const n = Math.max(4, Math.round(w / 2.4));
  const step = (w - 2.4) / (n - 1);
  const pinY = LIFT + h * 0.22;
  return { along, w, d, h, LIFT, n, step, pinY };
}

function tubeLayout(box: BuildingBox, seed: number) {
  const rng = detailRng(seed);
  const H = box.height;
  const R = Math.max(1.6, Math.min(H * 0.15, Math.min(box.width, box.depth) * 0.46));
  const LUG = 1.0, SOCK = 1.6, BASE = 2.2;
  const y0 = LUG + SOCK + BASE;
  const bodyH = Math.max(4, H - y0 - R);
  const pw = R * 1.62, ph = bodyH * 0.58;
  const fy = y0 + bodyH * 0.215;
  void rng;
  return { R, LUG, SOCK, BASE, y0, bodyH, pw, ph, fy };
}

// ═══════════════════════════════════════════════════════════════════════════
// The factory
// ═══════════════════════════════════════════════════════════════════════════
export function createCircuitTerrainStyle(): TerrainStyleStrategy {
  const params: StyleParams = defaultStyleParams('circuit');

  const gradientMap = (() => {
    // The demo's toon ramp (0.28 / 0.55 / 0.82 over 4 texels).
    const data = new Uint8Array([
      Math.round(0.28 * 255), Math.round(0.55 * 255), Math.round(0.82 * 255), 255,
    ]);
    const t = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  })();

  const toon = (opts: THREE.MeshToonMaterialParameters): THREE.MeshToonMaterial =>
    new THREE.MeshToonMaterial({ gradientMap, ...opts });
  const metal = (color: number, shininess = 120): THREE.MeshPhongMaterial =>
    new THREE.MeshPhongMaterial({ color, specular: 0xffffff, shininess });

  // ── Shared textures (strategy-owned singletons) ──
  const pcb = pcbTextures(0x1c0de);
  const texOf = (canvas: HTMLCanvasElement, repX?: number, repY?: number): THREE.CanvasTexture => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    if (repX !== undefined) t.repeat.set(repX, repY ?? repX);
    return t;
  };
  const ownedTextures: THREE.Texture[] = [];
  const own = <T extends THREE.Texture>(t: T): T => {
    ownedTextures.push(t);
    return t;
  };
  // Terrain-material maps are cloned per chunk material? No — three shares a
  // texture across any number of materials; the STRATEGY owns these, and the
  // per-chunk materials that reference them never dispose maps (the paper
  // world's horizon contract, applied everywhere here).
  const pcbFaceTex = own(texOf(pcb.face, 1 / PCB_TILE_METERS, 1 / PCB_TILE_METERS));
  const pcbGlowTex = own(texOf(pcb.glow!, 1 / PCB_TILE_METERS, 1 / PCB_TILE_METERS));
  const fr4Tex = own(texOf(fr4EdgeTexture()));
  const esdTex = own(texOf(esdBagTexture(), 1 / ESD_TILE_METERS, 1 / ESD_TILE_METERS));
  const pourTex = own(texOf(pourTexture(), 1 / 20, 1 / 20));
  // 五格地被:repeat 一律是 demo 的 `1 / LU_TILE[kind]`(uv 是世界公尺)。
  const luFarmTex = own(texOf(luFarmTexture(), 1 / LU_TILE.farmland));
  const luWetTex = own(texOf(luWetTexture(), 1 / LU_TILE.wetland));
  const luSportsFaceTex = own(texOf(luSportsTextures(), 1 / LU_TILE.sports));
  const luPlayTex = own(texOf(luPlayTexture(), 1 / LU_TILE.playground));
  const luSandTex = own(texOf(luSandTexture(), 1 / LU_TILE.sand));

  // ── Night-lit + trim materials (strategy-owned, `userData.shared`) ──
  const trimMaterials = new Map<string, THREE.Material>();
  const nightLit = new Set<THREE.Material & { emissive: THREE.Color }>();
  const sharedTrim = <T extends THREE.Material>(key: string, make: () => T): T => {
    let m = trimMaterials.get(key) as T | undefined;
    if (!m) {
      m = make();
      m.userData.shared = true;
      trimMaterials.set(key, m);
    }
    return m;
  };
  const sharedGlow = (
    key: string,
    make: () => THREE.MeshPhongMaterial,
    glowHex: number,
    peak: number,
  ): THREE.MeshPhongMaterial =>
    sharedTrim(key, () => {
      const m = make();
      m.emissive.setHex(0x000000);
      // The demo drives emissiveIntensity along the night blend and pushes it
      // past 1 into ACES white-heat; gameview's global driver writes only the
      // emissive COLOUR (building-lights.setNightLitFactor), so the intensity
      // carries the peak as a constant and the colour ramps 0 → glow.
      m.emissiveIntensity = peak;
      registerNightLitMaterial(m, glowHex);
      nightLit.add(m);
      return m;
    });

  /**
   * 板子的切邊材質,一階一份(demo 的 `fr4Cache` / `edgeMatForLevel`)。
   *
   * 走廊裡的切口(`createTerrainWallMaterialForLevel`)跟板子外緣的側牆
   * (`sideWall`)都從這裡拿:第 0 階就是 demo 的 `edgeMat`,一個實例。
   */
  const fr4EdgeMat = (level: number): THREE.Material => sharedTrim(
    `fr4Edge:${level}`,
    () => toon({
      map: level === 0 ? fr4Tex : own(texOf(fr4EdgeTexture(level))),
      side: THREE.DoubleSide,
    }),
  );

  /**
   * 鍍金匯流排的材質。demo 的 `busMatFor`,連同它的理由:
   *
   * > 材質按**寬度**收,不是按等級收 —— 六級只有四個寬度,按等級收會讓同一張畫布
   * > 被包成三份 CanvasTexture,那是三次 GPU 上傳。
   *
   * (表照抄 demo 之後六級只有四寬,所以這裡就是 demo 說的四份:`trunk`/`primary`
   * 共用 12 m 那張、`tertiary`/`minor` 共用 8 m 那張。)`road-renderer` 依**回傳的
   * 材質實例**分桶,所以撞號的兩級也會併成同一個 draw call。
   *
   * u = 路的公尺數(ribbon 的 uv 就是公尺),一格 16 m;v 是橫向 0…1,`ClampToEdge`
   * ——阻焊邊就在 v 的兩端,repeat 的話邊會被折回來壓在鍍金上。
   */
  const busTexOf = (() => {
    const cache = new Map<number, THREE.CanvasTexture>();
    return (w: number): THREE.CanvasTexture => {
      let t = cache.get(w);
      if (!t) {
        t = own(texOf(busTexture(w), 1 / BUS_TILE_METERS, 1));
        t.wrapT = THREE.ClampToEdgeWrapping;
        cache.set(w, t);
      }
      return t;
    };
  })();
  const busMaterial = (w: number): THREE.MeshToonMaterial => toon({
    map: busTexOf(w),
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const busMatFor = (roadClass?: string): THREE.Material => {
    // 沒有等級 = 跑道(`aeroway-renderer`)。它必須拿到**自己的一份**:呼叫端會在
    // 上面蓋自己的 `applyOverlayDepth('aeroway')`,共用實例的話那一下會把整條路的
    // 深度階(rank 12)改成跑道的(rank 9),於是路開始跟地形互穿。
    if (roadClass === undefined) return busMaterial(BUS_W_DEFAULT);
    const w = BUS_W[roadClass] ?? BUS_W_DEFAULT;
    return sharedTrim(`bus:${w}`, () => busMaterial(w));
  };
  // 四張一次生完(六級四寬,`busTexCache` 按寬度收)。總共 65 K texels(可以忽略),
  // 但留到「騎到才生」的話,第一次遇到某一級就會在 buildChunk 裡臨時插一張 128² 的
  // 畫布 —— N100 上那是一個看得到的頓格,而且發生的時機完全不可預測。
  // (demo 同一段:「四張一次生完。總共才 65k texels」。)
  for (const cls of Object.keys(BUS_W)) busMatFor(cls);

  // Opaque component materials — the demo's block, same colours.
  const icMat = () => sharedTrim('ic', () => toon({ color: E.ic }));
  const pinMat = () => sharedTrim('pin', () => metal(E.tin, 140));
  const goldPinMat = () => sharedTrim('goldPin', () => metal(E.goldHi, 170));
  const solderMat = () => sharedTrim('solder', () => metal(E.solder, 200));
  const copperMat = () => sharedTrim('copper', () => metal(E.copper, 90));
  const gridMat = () => sharedTrim('grid', () => metal(0x8d8577, 60));
  const getterMat = () => sharedTrim('getter', () => {
    const m = metal(0xc6cfd8, 260);
    m.side = THREE.DoubleSide;
    return m;
  });
  const ledCupMat = () => sharedTrim('ledCup', () => metal(0xc9ccd2, 160));
  /** 玻璃:opacity 壓在 0.5 以下(主角是裡面那些東西),depthWrite 關掉,不然
   *  玻璃會把自己裡面的電極擋掉(demo + §3.10 的鐵律)。 */
  const glassMat = () => sharedTrim('glass', () => {
    const m = new THREE.MeshPhongMaterial({
      color: 0xcfe3e8, transparent: true, opacity: 0.45, depthWrite: false,
      specular: 0xffffff, shininess: 220, side: THREE.DoubleSide,
    });
    return m;
  });

  // The night set —「只有真的會發光的元件」: nixie digits, tube filament, the
  // hospital LED, plus the two informed exceptions (cap crimp ring, DIP pin
  // windows) and the transformer's lamination leak. Values from the demo's
  // EMISSIVE_PARTS table.
  const nixieLitMat = () => sharedGlow('nixieLit',
    () => new THREE.MeshPhongMaterial({ color: 0xffb37a, shininess: 40 }), 0xff8a1e, 2.6);
  /**
   * 通電數字前面那一片加色的暈(demo `nixieHaloMat`,peak 0.62)。
   *
   * demo 的理由照抄:**emissive 本身不會外溢**,它只把自己的顏色加上去,所以
   * 遠看只是「一塊比較亮的橘」;眼睛讀成「在發光」的是外溢那一圈。這個世界有
   * SceneBloomPass,但 bloom 綁畫質分級 —— low 沒有 bloom,那一階的輝光管就只
   * 剩色塊,而發光正是這個世界的識別性。
   *
   * demo 用的是 `MeshBasicMaterial` + 逐幀寫 opacity;gameview 的夜間驅動只寫
   * **emissive 顏色**(`setNightLitFactor`),所以這裡改成黑底 Phong:color 與
   * specular 都是 0,打光項恆為 0,畫面上只有 emissive 那一份,再走
   * AdditiveBlending —— 白天 emissive=0 等於不存在,不必另外開關。
   *
   * ⚠ **`mini-raster` 會把這片畫成一塊實心黑**(house-preview / render-probe 的
   * 那顆光柵器不做 emissive、不做 transparent、不做 blending,見它的檔頭)。
   * 真的 WebGL 裡白天是 `dst += rgb × a = dst + 0`,什麼都沒加。**看到輝光管上
   * 有黑條不要來「修」這裡**,那是探針的限制不是 bug;要讓探針說實話,得讓
   * `mini-raster` 跳過 `blending === AdditiveBlending` 且 emissive 為黑的材質。
   */
  const nixieHaloMat = () => sharedGlow('nixieHalo', () => new THREE.MeshPhongMaterial({
    color: 0x000000, specular: 0x000000, shininess: 0,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    side: THREE.DoubleSide,
  }), 0xff9a3c, 0.62);
  const filamentMat = () => sharedGlow('filament',
    () => new THREE.MeshPhongMaterial({ color: 0xffb066, shininess: 30 }), 0xff6a12, 1.8);
  /** 疊層縫的暖光:底色刻意是暗的 —— 那是一道縫,不是發光面(demo)。 */
  const laminationMat = () => sharedGlow('lamination',
    () => new THREE.MeshPhongMaterial({ color: 0x3a2a18, shininess: 8 }), 0xff9430, 1.15);
  /** 電容捲邊溝槽的環形光 — 冷白,peak < 1(補光不是招牌,demo 的破例規則)。 */
  const capRingMat = () => sharedGlow('capRing',
    () => new THREE.MeshPhongMaterial({ color: 0x93b6c2, shininess: 60 }), 0xcfeaf2, 0.95);
  /** DIP 引腳窗 — 冷青白:它反射板子,不是自己亮(demo)。窗本身是 `dipIC()` 本體
   *  裡的方塊(見 `buildBuildingDecoration` 的 school/hospital),不是蓋上去的網格。 */
  const dipWinMat = () => sharedGlow('dipWin',
    () => new THREE.MeshPhongMaterial({ color: 0x7d939c, shininess: 40 }), 0xa8dcea, 0.9);
  /** 紅 LED 的殼:半透明 + depthWrite off(殼會擋掉自己的晶粒),只染一點光。 */
  const ledRedMat = () => sharedGlow('ledRed', () => {
    const m = new THREE.MeshPhongMaterial({
      color: 0xff4136, transparent: true, opacity: 0.62,
      specular: 0xffffff, shininess: 200, depthWrite: false,
    });
    return m;
  }, 0x52150f, 1.2);
  /** 紅 LED 的晶粒:glow 是「白 0.75 + 紅」的暖白,intensity 2 推進 ACES 的白熱
   *  區 — 核心白、暈開有紅,亮度才過得了 bloom 的門檻(demo 的 0.2126R 說明)。 */
  const ledRedDieMat = () => sharedGlow('ledRedDie',
    () => new THREE.MeshPhongMaterial({ color: 0x241014, shininess: 10 }), 0xffb3a8, 2.0);

  // ── Building material (shared singleton, the interface's one exception) ──
  let buildingMaterial: THREE.MeshToonMaterial | null = null;

  // ── Instance templates for the trim (chunk merger batches per template) ──
  const trimTemplates = new Map<string, THREE.BufferGeometry>();
  const trimTemplate = (
    key: string, material: THREE.Material, make: () => THREE.BufferGeometry,
  ): THREE.BufferGeometry => {
    let geo = trimTemplates.get(key);
    if (!geo) {
      geo = make();
      trimTemplates.set(key, geo);
    }
    // Re-tagged per hand-out: `markInstanceTemplate` is where the black-part
    // trap (vertexColors lives on the MATERIAL) is caught.
    return markInstanceTemplate(geo, material);
  };
  const _im = new THREE.Matrix4();
  const _ip = new THREE.Vector3();
  const _iq = new THREE.Quaternion();
  const _ie = new THREE.Euler();
  const _is = new THREE.Vector3();
  const setInstance = (
    mesh: THREE.InstancedMesh, i: number,
    w: number, h: number, d: number, x: number, y: number, z: number,
    rx = 0, ry = 0, rz = 0,
  ): void => {
    _is.set(Math.max(w, 1e-4), Math.max(h, 1e-4), Math.max(d, 1e-4));
    _iq.setFromEuler(_ie.set(rx, ry, rz));
    mesh.setMatrixAt(i, _im.compose(_ip.set(x, y, z), _iq, _is));
  };
  /**
   * 一批 trim。`cast` / `recv` 是這一批的陰影旗標,預設 (false, false)。
   *
   * demo 的預設不是這個:它的 `box()` 開 (T, T)、`cyl()` 與 `dome()` 只開 cast,
   * 再由各個 builder 逐件關掉。這裡不做那種階層,因為 `mergeBuildingDecorations`
   * 是**照 (material, cast, recv) 分桶**的 —— 旗標寫錯不只是影子錯,還會多切一
   * 個 draw call。所以每一批都在呼叫點明寫它從 demo 的哪一件繼承來的那一對。
   *
   * 在 `fill` **之前**設,fill 裡仍然可以改(那是它自己的話)。
   */
  const trimBatch = (
    group: THREE.Group, key: string, material: THREE.Material,
    make: () => THREE.BufferGeometry, n: number,
    fill: (mesh: THREE.InstancedMesh) => void,
    cast = false, recv = false,
  ): void => {
    if (n <= 0) return;
    const mesh = new THREE.InstancedMesh(trimTemplate(key, material, make), material, n);
    mesh.castShadow = cast;
    mesh.receiveShadow = recv;
    fill(mesh);
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  };
  const unitBox = (): THREE.BufferGeometry => new THREE.BoxGeometry(1, 1, 1);
  /**
   * demo 的 `unitCyl` 是 **16** 段(`unitCyl8` 才是 8)。這一份曾經是 12,而且
   * 整個檔案的 `cylinderY/X/Z` 也散落著 10 / 12 / 14 —— demo 的 `cyl()` 除非明寫
   * `seg === 8`,否則一律走 unitCyl。那是「照著重寫」留下的指紋(§0.0 的杯塔:
   * 14 面被寫成 8 面),不是量過的裁減:實測把全部改回 16 之後 chunk2 的建構
   * 時間沒有變化,三角形 +2%。
   */
  const unitCyl = (): THREE.BufferGeometry => new THREE.CylinderGeometry(1, 1, 1, 16);
  const unitCyl8 = (): THREE.BufferGeometry => new THREE.CylinderGeometry(1, 1, 1, 8);
  const unitHemi = (): THREE.BufferGeometry =>
    new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const unitTorus = (): THREE.BufferGeometry => new THREE.TorusGeometry(1, 0.062, 6, 18);
  const unitTorusThin = (): THREE.BufferGeometry => new THREE.TorusGeometry(1, 0.038, 5, 16);
  /**
   * 電解電容的捲邊溝槽。demo 是 `TorusGeometry(r*0.93, max(0.12, r*0.055), 5, 18)`
   * —— **5** 段不是 6(那是變壓器銅圈用的),而且管徑有 0.12 的下界。
   *
   * 這裡是共用 unit 幾何 + 每個 instance 一組縮放,所以管徑只能靠縮放帶:
   * 環面的 local +z 就是它的軸,轉 90° 之後是世界的 +y —— 騎士看這圈光幾乎是
   * 正側面,**讀到的粗細就是垂直方向那一段**,所以 z 軸單獨縮放去吃 demo 的下界,
   * 徑向那一半仍然是 0.055r(小罐子上比 demo 細,見報告)。
   */
  const CAP_RING_TUBE = 0.055 / 0.93;
  const unitCapRing = (): THREE.BufferGeometry =>
    new THREE.TorusGeometry(1, CAP_RING_TUBE, 5, 18);
  const unitGetterCap = (): THREE.BufferGeometry =>
    new THREE.SphereGeometry(1, 18, 6, 0, Math.PI * 2, 0, Math.PI * 0.42);
  /** demo 的 `glowQuad` —— 輝光管數字前面那片暈。 */
  const unitQuad = (): THREE.BufferGeometry => new THREE.PlaneGeometry(1, 1);
  /** demo 的 `unitSphere`(14 × 10)—— 沙地那八顆錫珠走它。 */
  const unitSphere = (): THREE.BufferGeometry => new THREE.SphereGeometry(1, 14, 10);

  /** Lift a local-frame trim group into the scene placement the interface
   *  wants (`buildBuildingDecoration` returns scene coordinates). */
  const placeTrim = (box: BuildingBox, group: THREE.Group): THREE.Group => {
    group.position.set(box.cx, box.baseY, box.cz);
    group.rotation.y = box.rotY;
    return group;
  };

  // ═════════════════════════════════════════════════════════════════════════
  // Bodies (merged, vertex-coloured) — one recipe per component, off the same
  // layout functions the trim and the lights read.
  // ═════════════════════════════════════════════════════════════════════════
  const CAP_SLEEVES = [0x1b3a6b, 0x0e0f12, 0x5a1b1b] as const;

  function capBody(box: BuildingBox, seed: number): THREE.BufferGeometry {
    const L = capLayout(box, seed);
    const m = new CircuitMass();
    const skirtY = -box.skirt;
    // 底座的絕緣墊(黑)埋到 skirt 底,罐子絕不懸空。
    m.paint(E.ic).cylinderY(L.r * 1.02, L.footH + box.skirt, 0, (L.footH + skirtY) / 2, 0, BODY_SEGS);
    // 套管 + 負極白條(一條嵌在表面的窄瓦)
    m.paint(CAP_SLEEVES[L.tint]).cylinderY(L.r, L.h, 0, L.footH + L.h / 2, 0, BODY_SEGS);
    m.paint(0xeef2f6).block(0.24, L.h * 0.9, L.r * 0.5, L.r * 0.88, L.footH + L.h / 2, 0);
    // 頂蓋鋁面 + 防爆刻痕(十字)。demo 的 y 是絕對值(套管 0.6..0.6+h):
    // cap 圓心 = 套管頂(h+0.6)、刻痕 h+0.9。這裡的原點在 footprint 底,所以
    // 一律 +footH —— 曾經整組往上挪了 0.25「讓鋁蓋不要陷進套管」,那讓下面那圈
    // 捲邊光跟著跑到鋁蓋裡面(見 buildBuildingDecoration 的 capRing)。
    m.paint(0xc8ced6).cylinderY(L.r * 0.98, 0.5, 0, L.footH + L.h, 0, BODY_SEGS);
    m.paint(E.ic).block(L.r * 1.7, 0.3, 0.45, 0, L.footH + L.h + 0.3, 0);
    m.paint(E.ic).block(0.45, 0.3, L.r * 1.7, 0, L.footH + L.h + 0.3, 0);
    return m.geometry();
  }

  function nixieBody(box: BuildingBox, seed: number): THREE.BufferGeometry {
    const L = nixieLayout(box, seed);
    const m = new CircuitMass();
    const put = (a: number, b: number): [number, number] => onAxis(L.along, a, b);
    const yaw = frameYaw(L.along);
    // 管座:黑電木,埋 skirt(插件式元件一定要有管座 — demo 紅線)。
    m.paint(0x231a14).block(L.sw, L.SOCK + box.skirt, L.sd, 0,
      L.LUG + (L.SOCK - box.skirt) / 2, 0, yaw);
    for (let i = 0; i < L.tubes; i++) {
      const c = (i - (L.tubes - 1) / 2) * L.pitch;
      const [cx, cz] = put(c, 0);
      // 管子自己的電木底座
      m.paint(0x231a14).cylinderY(L.r * 1.05, 1.2, cx, L.y0 + 0.6, cz, BODY_SEGS);
      // 陰極支架:兩根立柱把整疊數字撐在管子中間(demo `nixieSign` 的 `rod`,
      // `box(0.3, bodyH * 0.72, 0.3, cathodeMat)`,每管兩根)。少了它整疊數字
      // 是浮在管子裡的 —— 跟真空管柵極的支撐柱同一族。
      const [r1x, r1z] = put(c + L.r * 0.82, 0);
      const [r2x, r2z] = put(c - L.r * 0.82, 0);
      m.paint(0x565c66).block(0.3, L.bodyH * 0.72, 0.3, r1x, L.dy, r1z, yaw);
      m.paint(0x565c66).block(0.3, L.bodyH * 0.72, 0.3, r2x, L.dy, r2z, yaw);
    }
    return m.geometry();
  }

  function xformerBody(box: BuildingBox, seed: number): THREE.BufferGeometry {
    const L = xformerLayout(box, seed);
    const m = new CircuitMass();
    // `hand = -1`:demo 的 `transformer` **沒有**轉那 90°(它直接建在擺放的框
    // 裡,x = across),跟 `nixieSign` / `longDip` 的慣用手相反。見 `onAxis`。
    const put = (a: number, b: number): [number, number] => onAxis(L.along, a, b, -1);
    const yaw = frameYaw(L.along, -1);
    // 電木底座(埋 skirt)
    m.paint(0x231a14).block(L.D * 1.06, L.baseH + box.skirt, L.W * 1.18, 0,
      (L.baseH - box.skirt) / 2, 0, yaw);
    // 矽鋼片:厚片相貼沒有縫 — 薄片會消失,有縫的話天際線會開洞(demo)。
    for (let i = 0; i < L.n; i++) {
      const a = -L.D / 2 + L.th * (i + 0.5);
      const [px, pz] = put(a, 0);
      m.paint(i % 2 ? 0x6b727a : 0x98a0a8)
        .block(L.th, L.coreH, L.W, px, L.baseH + L.coreH / 2, pz, yaw);
    }
    // 銅線圈:軸向 = 疊層方向(沿路),半徑大於鐵芯半厚,銅才鼓出來被看見。
    // 線軸的兩片擋板是 demo 的 `cyl(Rc*1.1, 0.55, bakeliteMat)` —— **圓盤**,
    // 不是方塊:方塊的四個角會從銅圈外緣戳出來,遠看變成線圈上夾了兩塊板子。
    if (L.along === 'x') {
      m.paint(E.copper).cylinderX(L.Rc, L.coilL, 0, L.cy, 0, BODY_SEGS);
      m.paint(0x231a14).cylinderX(L.Rc * 1.1, 0.55, -L.coilL / 2, L.cy, 0, BODY_SEGS);
      m.paint(0x231a14).cylinderX(L.Rc * 1.1, 0.55, L.coilL / 2, L.cy, 0, BODY_SEGS);
    } else {
      m.paint(E.copper).cylinderZ(L.Rc, L.coilL, 0, L.cy, 0, BODY_SEGS);
      m.paint(0x231a14).cylinderZ(L.Rc * 1.1, 0.55, 0, L.cy, -L.coilL / 2, BODY_SEGS);
      m.paint(0x231a14).cylinderZ(L.Rc * 1.1, 0.55, 0, L.cy, L.coilL / 2, BODY_SEGS);
    }
    // 鋼帶夾:把整疊片箍起來(上下兩道)
    for (const yy of [0.2, 0.84]) {
      m.paint(0x5a6068).block(L.D * 1.03, 0.6, L.W * 1.07, 0, L.baseH + L.coreH * yy, 0, yaw);
    }
    return m.geometry();
  }

  function dipBody(box: BuildingBox, seed: number, ceramic: boolean): THREE.BufferGeometry {
    const L = dipLayout(box, seed);
    const m = new CircuitMass();
    const put = (a: number, b: number): [number, number] => onAxis(L.along, a, b);
    const yaw = frameYaw(L.along);
    const bodyCol = ceramic ? 0xe8e4d8 : E.ic;
    const topCol = ceramic ? 0x454b55 : E.icHi;
    m.paint(bodyCol).block(L.w, L.h, L.d, 0, L.h / 2 + L.LIFT, 0, yaw);
    // 頂面厚封蓋(陶瓷版是深色 kovar 蓋 — 白陶瓷站在白阻焊上的輪廓線,不能省)。
    // demo 的圓心就在 `h + DIP_LIFT`,也就是**一半陷在本體裡**:封蓋是嵌進封裝
    // 的,整片浮在上面會讀成黏了一塊板子。凹點同理跟著 demo 的 +0.55。
    m.paint(topCol).block(L.w * 0.86, 0.8, L.d * 0.82, 0, L.h + L.LIFT, 0, yaw);
    // 一腳記號的凹點
    const [dx, dz] = put(-L.w / 2 + 1.4, -L.d / 2 + 1.4);
    m.paint(topCol).cylinderY(0.62, 0.3, dx, L.h + L.LIFT + 0.55, dz, BODY_SEGS);
    return m.geometry();
  }

  function tubeBody(box: BuildingBox, seed: number): THREE.BufferGeometry {
    const L = tubeLayout(box, seed);
    const m = new CircuitMass();
    // 管座 + 電木底座 + 金屬箍(玻璃、電極細節歸 decoration)
    m.paint(0x231a14).cylinderY(L.R * 1.3, L.SOCK + box.skirt, 0, L.LUG + (L.SOCK - box.skirt) / 2, 0, BODY_SEGS);
    m.paint(0x231a14).cylinderY(L.R * 1.05, L.BASE, 0, L.LUG + L.SOCK + L.BASE / 2, 0, BODY_SEGS);
    m.paint(0x5a6068).cylinderY(L.R * 1.08, 0.4, 0, L.LUG + L.SOCK + L.BASE - 0.3, 0, BODY_SEGS);
    // 屏極:佔掉大半體積 — 它才是輪廓的主體(demo 第一版做小了,整支管子讀成
    // 一疊甜甜圈)。
    m.paint(0x474d58).block(L.pw, L.ph, L.pw * 0.72, 0, L.y0 + L.bodyH * 0.58, 0);
    for (const s of [-1, 1]) {
      m.paint(0x5a6068).block(0.34, L.ph * 0.94, 0.34, s * L.pw / 2, L.y0 + L.bodyH * 0.58, 0);
    }
    // 雲母墊片:上下各一片
    for (const f of [0.13, 0.9]) {
      m.paint(0xc9b489).cylinderY(L.R * 0.9, 0.35, 0, L.y0 + L.bodyH * f, 0, BODY_SEGS);
    }
    return m.geometry();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // ledBody — 一顆 LED 的內臟。路燈跟醫院的指示燈共用這一份:兩份程式碼畫同一
  // 種零件,它們遲早會長得不一樣(§3.10,這條在這個 repo 踩過兩次)。
  // 座標:原點在凸緣中心,+y 往上;比例全部相對 r(demo 的 ledBody,原封)。
  // ═════════════════════════════════════════════════════════════════════════
  function ledBody(
    r: number, lensMat: THREE.Material, dieMat: THREE.Material, cupMat: THREE.Material,
    /**
     * 幾何走共用快取(依 `r` 分格),而且**不進 `owned`** —— 呼叫端不可以 dispose
     * 它。只有路燈開這個:它一次做 20 盞,八份幾何 × 20 是 §6 排第三的那個指標
     * 上白花的 152 份。其他呼叫端(苗、醫院 DIP 的指示燈)一個地點只做一顆,而
     * 且它們的幾何要跟著 chunk 一起被收掉,所以維持預設的 false。
     */
    shareGeo = false,
  ): {
    group: THREE.Group;
    die: { x: number; y: number };
    owned: THREE.BufferGeometry[];
  } {
    const g = new THREE.Group();
    const owned: THREE.BufferGeometry[] = [];
    // demo 的 box() 開 cast+recv、cyl()/dome() 只開 cast,ledBody 再逐件關掉幾個
    // ——那些 false 是 demo 寫下的決定(「球冠不投影:透鏡投出來的影子會在板子上
    // 多一塊黑點」),連同 true 一起搬過來。gameview 目前沒開 shadowMap,所以這
    // 兩個旗標現在不花錢;它們在這裡是為了下次有人打開陰影時不必重推一遍。
    const geoOf = (key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry =>
      shareGeo ? lampGeo(`led:${key}:${r}`, make) : make();
    const mk = (
      key: string, make: () => THREE.BufferGeometry,
      mat: THREE.Material, cast: boolean, recv = false,
    ): THREE.Mesh => {
      const geo = geoOf(key, make);
      if (!shareGeo) owned.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = cast;
      m.receiveShadow = recv;
      return m;
    };
    const rim = mk('rim',
      () => new THREE.CylinderGeometry(1.206 * r, 1.206 * r, 0.294 * r, 16), lensMat, true);
    g.add(rim);
    const body = mk('body', () => new THREE.CylinderGeometry(r, r, 2.0 * r, 16), lensMat, true);
    body.position.y = 0.853 * r;
    g.add(body);
    // 球冠不投影:透鏡投出來的影子會在板子上多一塊黑點(demo)。
    const head = mk('head',
      () => new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), lensMat, false);
    head.position.y = 1.853 * r;
    g.add(head);
    // 削平的那一側 —— 負極,LED 唯一的方向記號。
    const flat = mk('flat',
      () => new THREE.BoxGeometry(0.165 * r, 2.0 * r, 1.529 * r), lensMat, true, true);
    flat.position.set(-0.953 * r, 0.853 * r, 0);
    g.add(flat);
    // 導線架:左高右矮的不對稱剪影,隔著半透明的殼看得見 —— 「這是 LED」最強
    // 的記號。
    const anvil = mk('anvil',
      () => new THREE.BoxGeometry(0.294 * r, 1.412 * r, 0.176 * r), cupMat, false, true);
    anvil.position.set(-0.324 * r, 0.559 * r, 0);
    g.add(anvil);
    const post = mk('post',
      () => new THREE.BoxGeometry(0.271 * r, 0.941 * r, 0.165 * r), cupMat, false, true);
    post.position.set(0.559 * r, 0.324 * r, 0);
    g.add(post);
    const cup = mk('cup',
      () => new THREE.CylinderGeometry(0.424 * r, 0.424 * r, 0.247 * r, 8), cupMat, false);
    cup.position.set(-0.324 * r, 1.324 * r, 0);
    g.add(cup);
    const die = mk('die',
      () => new THREE.CylinderGeometry(0.235 * r, 0.235 * r, 0.2 * r, 8), dieMat, false);
    die.position.set(-0.324 * r, 1.529 * r, 0);
    g.add(die);
    return { group: g, die: { x: -0.324 * r, y: 1.529 * r }, owned };
  }

  // ── Street lamp (5mm LED) ──
  //
  // 殼與晶粒的材質**逐盞**,腳與導線架的材質、以及**整份幾何**共用。
  //
  // 逐盞的理由只有一個,而且是量出來的:`setNight` 會寫 `lensMat.emissive` /
  // `lensMat.opacity` / `dieMat.color`,而 `street-lamp.ts` 的 `update()` 給池裡
  // 那批的是 `litFactor`(隧道裡恆為 1)、給球場邊那盞的是**原始的**
  // `nightFactor` —— 兩邊刻意不一樣(「隧道不該點亮外面兩公里的球場」)。跨過那
  // 條線共用一份被寫的材質,最後一個寫的人贏,隧道會在正午變黑。
  //
  // 幾何沒有這個問題:它一根頂點都不隨日夜動,而且**四個顏色的形狀完全相同**。
  // 用 scene-census.mjs 量池子本身(一條普通的路上 10 盞):
  //
  //   circuit  road   draw calls 100 / unique geo 100 / unique mat 22
  //   circuit  tunnel draw calls 200 / unique geo 200 / unique mat 42
  //
  // —— 材質早就共用了一半(`pinMat` / `ledCupMat`),幾何是那 100 份裡的 100 份。
  const LED_COLORS = [0xff3b3b, 0x3bff7a, 0x3b8cff, 0xffd23b] as const;

  /**
   * 路燈自己那幾份共用幾何。**不走 `trimTemplate`** —— 那一份會順手蓋上
   * `markInstanceTemplate`,把幾何交給 `mergeBuildingDecorations` 的 instance
   * 分支;路燈根本不經過那條路,標了只會多一個沒人讀、卻會誤導下一個人的旗標。
   * 標的是 `userData.shared`,讓 `disposeGroup` 放過它們。
   */
  const lampGeos = new Map<string, THREE.BufferGeometry>();
  const lampGeo = (key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry => {
    let geo = lampGeos.get(key);
    if (!geo) {
      geo = make();
      geo.userData.shared = true;
      lampGeos.set(key, geo);
    }
    return geo;
  };

  function buildLedLamp(index: number): StreetLampParts {
    const group = new THREE.Group();
    const col = new THREE.Color(LED_COLORS[index % LED_COLORS.length]);
    const owned: (THREE.BufferGeometry | THREE.Material)[] = [];
    const lensMat = new THREE.MeshPhongMaterial({
      color: col, transparent: true, opacity: 0.55,
      specular: 0xffffff, shininess: 180, emissive: 0x000000,
      depthWrite: false, // 半透明的殼不關掉會擋住自己的晶粒
    });
    // 晶粒:demo 的 `ledDieMats` 是 **MeshBasicMaterial**,而且非它不可 ——
    // applyBulb 夜裡把 color 推到 0.75 白 + 1.35 色(最亮 2.1),那個值要原封
    // 送進 framebuffer 才過得了 bloom 的亮度門檻。改成會吃光照的 Phong,
    // 這個 2.1 會先被夜間的 ambient(0.18 上下)乘掉,晶粒在夜裡反而是全場
    // 最暗的一塊:殼有 emissive 在發光、裡面那顆亮點是黑的 —— 正好是 §3.10
    // 說的「一個看不到光源的色塊」,而且是倒過來的那一種。
    const dieMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
    owned.push(lensMat, dieMat);

    // 腳:長腳(正極)比短腳長 —— LED 唯一的方向記號,少了就只是根柱子。
    // 走共用的 pinMat():demo 的腳吃的就是全場那份 `pinMat`,而它不隨日夜動,
    // 每盞燈自己 new 一份只是二十份一模一樣的錫色。
    const legMat = pinMat();
    for (const [sd, len] of [[-1, 9.2], [1, 7.6]] as const) {
      const leg = new THREE.Mesh(
        lampGeo(`leg:${len}`, () => new THREE.BoxGeometry(0.32, len, 0.32)), legMat);
      leg.position.set(sd * 0.9, len / 2, 0);
      leg.castShadow = true;
      leg.receiveShadow = true;
      group.add(leg);
    }
    const body = ledBody(1.7, lensMat, dieMat, ledCupMat(), true);
    body.group.position.y = 8.95;
    group.add(body.group);
    for (const geo of body.owned) owned.push(geo);   // shareGeo → 空陣列,留著當守門

    const light = new THREE.PointLight(col, 0, 30, 1.8);
    // 就放在晶粒上:看到的亮點跟照出去的光要在同一個位置。
    light.position.set(body.die.x, 8.95 + body.die.y, 0);
    group.add(light);

    let night = 0;
    let lightEnabled = true;
    return {
      group,
      setNight: (k) => {
        night = k;
        // demo applyBulb, verbatim: 殼只帶淡淡的染色,夜裡 opacity 反而降 —
        // 要看得進去才像燈;晶粒 0.75 白 + 1.35 色,核心白、暈開有色。
        lensMat.emissive.setRGB(col.r * k * 0.35, col.g * k * 0.35, col.b * k * 0.35);
        lensMat.opacity = 0.55 - 0.12 * k;
        const wk = 0.75 * k, ck = 1.35 * k, dk = 0.30 * (1 - k);
        dieMat.color.setRGB(
          dk + wk + col.r * ck, dk + wk + col.g * ck, dk + wk + col.b * ck);
        light.intensity = k * 16;
        light.visible = lightEnabled && k > 0.02;
      },
      setLightEnabled: (enabled) => {
        lightEnabled = enabled;
        light.visible = enabled && night > 0.02;
      },
      dispose: () => {
        disposeGroup(group);
        for (const o of owned) o.dispose();
      },
    };
  }

  // ── Sign: the e-paper module (電子紙招牌). Reflective — it never glows;
  // that is its division of labour with the nixie tube (the commercial zone's
  // own building glows, the sign does not). ──
  const ZONE_MASK_3D: Record<ZoneKind, number> = {
    residential: 0x1f8a52,  // 綠阻焊 — 最常見的阻焊配最常見的分區
    commercial: 0x1e56b8,   // 藍阻焊 — 輝光管的暖橘壓在藍底上最跳
    industrial: 0xd9c22b,   // 黃阻焊 — 變壓器灰矽鋼 + 銅圈在黃底上跳出來
    school: 0xa8261e,       // 紅阻焊 — 黑塑封 DIP 的輪廓在紅底上最清楚
    hospital: 0xe6ece7,     // 白阻焊 — 紅 LED 在白底上跳
  };
  const epaperMat = () => sharedTrim('epaper', () => toon({ color: E.epaper }));
  const inkStrokeMat = () => sharedTrim('inkStroke', () => toon({ color: E.ink }));
  const epaperRedMat = () => sharedTrim('epaperRed', () => toon({ color: E.epaperRed }));
  const fpcMat = () => sharedTrim('fpc', () => toon({ color: E.fpc }));
  const signBackMat = (zone: ZoneKind) =>
    sharedTrim(`signBack:${zone}`, () => toon({ color: ZONE_MASK_3D[zone] }));

  // ═════════════════════════════════════════════════════════════════════════
  // 五格地被會站起來的東西 —— demo 的 `LU_STYLE.props(kind, ctx)`
  // ═════════════════════════════════════════════════════════════════════════
  // §6 效能:**貼圖優先,只有真的必須站起來的才給幾何**。農田的孔陣、球場的絲印
  // 線、沙地的顆粒全部在貼圖裡;站起來的只有濕地的蘆葦、遊樂場的三件結構、農田
  // 種在孔裡的苗,以及沙地那八顆錫珠。每一格的上限寫在各自的分支第一行。

  /**
   * 種在農田孔裡的苗:一顆**綠 LED**的殼。
   *
   * 身分:這不是路燈。路燈是「兩隻長腳把 LED 舉到 9 m 高、裡面掛一盞 PointLight、
   * 入夜會亮」;苗是「1.8 m、直接插在洞洞板的孔裡、沒有腳、**永遠不亮**」。
   * §3.3 管的是「遠看兩處長不長一樣」,這兩個的剪影與亮度都反過來。
   * 而 §3.10 管的是「同一種零件只能有一份做法」—— 所以它走的是**同一支**
   * `ledBody()`,只是換材質換尺寸,跟醫院 DIP 頂上那顆指示燈一樣。
   *
   * 材質自己一份,不能借 `ledRedMat()` —— 那組進了 `nightLit`,`setNightLitFactor`
   * 每一幀在寫它們的 emissive。借過來的話入夜整片田會亮成一片,而農田照 §3.9 是
   * **沒有燈**的(田在板子的邊上,根本沒接上匯流排)。這一份**不註冊**。
   */
  const luCropLensMat = () => sharedTrim('luCropLens', () => new THREE.MeshPhongMaterial({
    color: 0x5ad46a, transparent: true, opacity: 0.62,
    specular: 0xffffff, shininess: 190, emissive: 0x000000,
    // 半透明的殼要關 depthWrite,不然它擋掉自己裡面的晶粒(§3.10)。
    depthWrite: false,
  }));
  /** 沒點亮的數字陰極。苗的晶粒借它:語意剛好(「沒點亮」),而且省一份材質。 */
  const cathodeMat = () => sharedTrim('cathode', () => toon({ color: 0x565c66 }));
  /** 遊樂場那三件的塑膠件:撥鈕與旋鈕的橘紅。一份材質服務三件結構。 */
  const luToyMat = () => sharedTrim('luToy', () => toon({ color: 0xe0533a }));
  /** 晶振罐的鋁 —— 旋轉盤(微調電位器)的本體也是它(demo `aluMat`)。 */
  const aluMat = () => sharedTrim('alu', () => toon({ color: E.alu }));

  /** 落到最近的一格。農田的苗要真的長在貼圖畫出來的孔上,所以要 snap(demo)。 */
  const luSnap = (v: number, step: number, phase: number): number =>
    Math.round((v - phase) / step) * step + phase;

  /**
   * 地被道具的共用單位幾何。標 `userData.shared` 是給下面的 `luHarvest` 看的:
   * 它會把**沒標**的來源幾何收掉,而 `ledBody()` 每次呼叫都 new 一份自己的。
   * 本體住在 `trimTemplates`,由 strategy 的 `dispose()` 釋放。
   */
  const luUnit = (
    key: string, mat: THREE.Material, make: () => THREE.BufferGeometry,
  ): THREE.BufferGeometry => {
    const geo = trimTemplate(key, mat, make);
    geo.userData.shared = true;
    return geo;
  };
  /** demo 的 `box(sx, sy, sz, mat)`:unitBox 縮放,cast + receive 都開。 */
  const luBox = (sx: number, sy: number, sz: number, mat: THREE.Material): THREE.Mesh => {
    const m = new THREE.Mesh(luUnit('lu:box', mat, unitBox), mat);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  /** demo 的 `cyl(r, h, mat, seg)`:只開 cast(receive 是預設的 false)。 */
  const luCyl = (r: number, h: number, mat: THREE.Material, seg?: number): THREE.Mesh => {
    const m = new THREE.Mesh(
      seg === 8 ? luUnit('lu:cyl8', mat, unitCyl8) : luUnit('lu:cyl', mat, unitCyl), mat);
    m.scale.set(r, h, r);
    m.castShadow = true;
    return m;
  };

  /**
   * demo 在 `buildChunk` 結尾那次 `harvest()`,搬到這一側。
   *
   * demo 把道具當一顆一顆的 Mesh 寫進 group,然後在 chunk 收尾時把「同一份幾何 +
   * 同一份材質」的整批收成 InstancedMesh —— 所以「多幾株苗」漲的是 instance 數,
   * 不是 draw call。**gameview 這一側沒有那台機器**(找過:`landuse-renderer` 只
   * 會把 slab 併起來,道具是直接掛在 slab 底下的子物件),而這個世界已知的瓶頸就
   * 是純 draw call 浪費(§6),所以在這裡補上等價的那一步。
   *
   * 收法是**合併**不是 instancing,理由是所有權:`disposeLanduseMeshes` 只 dispose
   * 幾何與材質,**不會**呼叫 `InstancedMesh.dispose()`,而那支才是釋放 instanceMatrix
   * 那條 GL buffer 的人(three 的 `WebGLObjects.onInstancedMeshDispose`)。一株苗
   * 九塊地一直回收,漏的就是那些。合併出來的幾何是**逐塊地**的,沒標 shared,
   * 正好落在回收器設計好的那一半;來源的共用單位幾何標了 shared,它放過。
   *
   * 分桶的 key 是 `(material, castShadow, receiveShadow)` —— 後兩個是**逐 draw**
   * 的旗標,混在一起併就等於把 demo 逐件寫下的那些 `castShadow = false` 丟掉。
   */
  const luHarvest = (src: THREE.Group): THREE.Group | null => {
    src.updateMatrixWorld(true);
    const buckets = new Map<string, {
      mat: THREE.Material; cast: boolean; recv: boolean; parts: THREE.BufferGeometry[];
    }>();
    const sources = new Set<THREE.BufferGeometry>();
    src.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.Material;
      const key = `${mat.uuid}|${mesh.castShadow ? 1 : 0}|${mesh.receiveShadow ? 1 : 0}`;
      let b = buckets.get(key);
      if (!b) {
        b = { mat, cast: mesh.castShadow, recv: mesh.receiveShadow, parts: [] };
        buckets.set(key, b);
      }
      b.parts.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
      sources.add(mesh.geometry);
    });
    for (const g of sources) if (!g.userData.shared) g.dispose();
    const out = new THREE.Group();
    for (const b of buckets.values()) {
      const merged = mergeGeometries(b.parts);
      for (const g of b.parts) g.dispose();
      if (!merged) continue;
      const m = new THREE.Mesh(merged, b.mat);
      m.castShadow = b.cast;
      m.receiveShadow = b.recv;
      out.add(m);
    }
    return out.children.length > 0 ? out : null;
  };

  // ═══════════════════════════════════════════════════════════════════════
  // 路線 = 一串接龍的杜邦線 — demo `buildDupont` / `dupontWireGeo`
  // ═══════════════════════════════════════════════════════════════════════
  // demo 那一段的原話,一個字沒改:
  //
  // > 舊版路線是一條貼在匯流排上的發光緞帶 —— 它會完美貼合曲線,因為它是布。
  // > 杜邦線不是布,**它有點硬**:兩個接頭之間就是一條直的,所以整條路線變成一串
  // > **弦線**,過彎時會小小切內角。那不是缺陷,是物理誠實,不要想辦法讓它貼合。
  // >
  // > 只有兩件事被限制住:
  // >  1. 轉彎只發生在**接點**上(公頭插進母頭的地方),段中間不准彎。
  // >  2. 線材硬 → 弦切得太深就接不上了,所以切超過 DUP_SAG 就換一段短的。真的在
  // >     板子上排線也是這樣:直線段用長的,轉角處換短的。
  // > 整條鏈**貼著匯流排的一側走**,不走中線 —— 騎手在中線上,線長在他身上就變成
  // > 每一幀都在穿模。接點永遠在 DUP_LAT,只有段中間會往內切,所以最窄處還有 1.9。
  //
  // 那個 1.9 是**這張寬度表算出來的**(最窄 8 m 的半寬 4,減 DUP_LAT 3.9 再加回
  // 弦切的餘量),所以 `BUS_W` 照抄 demo 跟這一段是同一件事的兩半,見 `BUS_W`。
  const DUP_LAT = 3.9;
  const DUP_DRAW = 55, DUP_MAX = 70;   // 想要的段長
  const DUP_MIN = 34;                  // 轉角處容許縮到多短
  const DUP_SAG = 2.0;                 // 弦線容許往內切多少
  const DUP_Y = 0.85;                  // 接頭中心高
  const DUP_R = 0.5;                   // 線徑
  const DUP_ARCH = 0.55;               // 拱起(離開板面一點,才不會跟匯流排貼死)
  const DUP_FL = 5.2, DUP_FW = 2.3, DUP_FH = 1.6;   // 母頭膠殼
  const DUP_ML = 4.2, DUP_MW = 2.0, DUP_MH = 1.4;   // 公頭膠殼
  const DUP_GAP = 1.2;                 // 兩個膠殼之間露出來的那截金屬
  const PULSE_UV = 1 / 60;             // 脈衝貼圖:1 格 = 60 公尺(3 顆 → 每 20 公尺一顆)
  // demo 的原話,一個字沒改:
  // > pulseTexture() 把三顆亮團畫在 x = 20 / 105 / 190(共 256)。接點要在電流經過
  // > 的**那一刻**才抖,所以這裡得知道亮團在 uv 上的位置 —— 兩邊同一組數字。
  const PULSE_BANDS = [20 / 256, 105 / 256, 190 / 256];
  /**
   * demo 的 `applyDayNight`:
   * `for (const m of dupWireMats) m.emissiveIntensity = powerOn * wg * (0.34 + 1.5 * k);`
   *
   * gameview 的夜燈只寫 emissive 的**顏色**(`setNightLitFactor`),所以 `k` 那一半
   * 由顏色從 0 爬到 glow 帶走,強度這一格只剩它的峰值 —— 跟這個世界其他每一個發光
   * 件同一個做法(見 `sharedGlow`)。代價是 demo 白天那 0.34 的底光收不到,而**那是
   * 全世界統一的取捨,不是路線的特例**:板面走線 0.08、支線 0.10 都一樣被收掉了。
   *
   * ⚠ 剩下的 `wg`(功率增益)**沒有**被收掉:它乘的是 `emissiveIntensity`,而夜燈
   * 驅動寫的是 `emissive` 的顏色,兩者不是同一格。所以 `updateRiderSignals` 每幀
   * 把它乘回去(`wattGain`),而在功率未知時 `wattGain` 回傳 1 —— 也就是這個常數
   * 本身,一格沒動。
   */
  const DUP_GLOW_PEAK = 0.34 + 1.5;
  /**
   * demo 的兩條映射,一個字沒改(它自己的滑桿範圍就是這兩條式子的定義域):
   *
   * ```js
   * const cadenceSpeed = () => 0.28 + (cadence - 60) / 50 * 0.62;   // 0.28 .. 0.90 uv/秒
   * const wattGain = () => 0.55 + (watts - 80) / 240 * 0.90;        // 0.55 .. 1.45 倍
   * ```
   *
   * demo 的原話:「**踏頻決定脈衝沿走線行進的速度,功率決定亮度**」,而且兩者都是
   * **乘進去**既有的日夜與總開關,不是取代。
   *
   * ## demo 沒有被問到的兩件事(`DEMO_POC_GUIDE` §2 的病 A),與這裡的答案
   *
   * 1. **範圍外的輸入。** demo 的滑桿在讀進來的那一步就夾住
   *    (`cadence = Math.min(110, Math.max(60, r))` / 功率同理 80–320),所以那兩條
   *    式子從來沒收到範圍外的數。真的感測器會給 0 rpm、也會給 130 rpm。夾住是
   *    demo 自己的作法,所以照抄它:**向下延伸那條線是錯的** —— 0 rpm 代進
   *    `cadenceSpeed` 是 −0.46 uv/秒,電流會倒著跑,而板子通電時電流不會倒流。
   *    0 rpm 因此看起來像 60 rpm(0.28 uv/秒,最慢那一檔),那是這個世界的規矩:
   *    `powerOn` 是總開關,踩踏只調它的量。
   * 2. **值不存在。** demo 永遠有滑桿值。沒有感測器時回傳 demo 自己的開場值
   *    (踏頻 85、功率 200),因為那才是「不知道」該長的樣子 —— 而 200 W 代進
   *    `wattGain` 剛好是 **1.0**,也就是「不乘」。**估計功率也走這一條**:
   *    `powerSource === 'estimated'` 的瓦數是從輪速推回來的,拿它去調亮度等於把
   *    「你騎得比較快」演成「你踩得比較用力」,那是騙人。
   */
  const CAD_MIN = 60, CAD_MAX = 110, CAD_DEFAULT = 85;
  const WATT_MIN = 80, WATT_MAX = 320;
  const cadenceSpeed = (rpm: number | null): number => {
    const cadence = rpm === null
      ? CAD_DEFAULT
      : Math.min(CAD_MAX, Math.max(CAD_MIN, rpm));
    return 0.28 + (cadence - 60) / 50 * 0.62;
  };
  const wattGain = (measuredW: number | null): number => {
    if (measuredW === null) return 1;
    const watts = Math.min(WATT_MAX, Math.max(WATT_MIN, measuredW));
    return 0.55 + (watts - 80) / 240 * 0.90;
  };
  /** demo 的 `let pulseU = 0` —— 脈衝貼圖在 u 上走到哪了。 */
  let pulseU = 0;
  /**
   * 還活著的路線本體的每幀火花驅動,`buildRouteBody` 交上來的。
   *
   * 為什麼在這一層而不是 `RouteBody` 上多一個方法:火花的相位跟線身的脈衝是**同一個
   * `pulseU`**,而 `pulseU` 是 strategy 的(貼圖也是)。把驅動掛在路線物件上等於要
   * 把相位也傳一份下去,那就是兩個地方各有一份「電流跑到哪了」。demo 也是這樣:
   * `pulseU` 是它的模組層變數,`animate()` 直接讀。
   *
   * 為什麼是 Set 而不是「最後建的那一份」:同時只會有一條路線,**但建與收的順序不
   * 保證**(換世界時是先建新的再收舊的)。用單一變數的話「收掉一份不是當前那份的
   * 路線」就會把還活著的那條的驅動一起清掉,而症狀是火花靜靜地停住 —— 沒有例外、
   * 沒有畫面異常,只是不再抖。加進來、拿掉自己,順序就不再是前提。
   */
  const liveRoutes = new Set<() => void>();
  // 排線本來就是彩虹色。黑色留在最後 —— 一整排彩色裡有一條黑的才像真的排線。
  const DUP_COLORS = ['#e0342c', '#e8c62a', '#2a6fe0', '#eef2f6', '#2fa84a', '#161a20'];

  const pulseTex = own(texOf(pulseTexture()));
  pulseTex.wrapT = THREE.ClampToEdgeWrapping;
  const dupShellMat = (): THREE.Material =>
    sharedTrim('dupShell', () => toon({ color: 0x111419 }));      // 膠殼(黑,霧面)
  const dupRibMat = (): THREE.Material =>
    sharedTrim('dupRib', () => toon({ color: 0x2a2f38 }));         // 殼上的防滑肋
  const dupPinMat = (): THREE.Material =>
    sharedTrim('dupPin', () => metal(E.tin, 190));                 // 露出來的那截金屬
  /**
   * 線身:color = 外皮,emissiveMap = 電流(demo)。
   *
   * > emissive 只往青白拉 0.3 —— 拉太多每條線的脈衝都會被推成同一種白,紅線就該跑
   * > 紅光、藍線就該跑藍光。
   */
  const dupWireMats: THREE.MeshPhongMaterial[] = [];
  const dupWireMat = (i: number): THREE.MeshPhongMaterial => {
    const m = sharedGlow(
      `dupWire:${i}`,
      () => new THREE.MeshPhongMaterial({
        color: DUP_COLORS[i], specular: 0xffffff, shininess: 80,
        emissiveMap: pulseTex, emissiveIntensity: 0,
      }),
      new THREE.Color(DUP_COLORS[i]).lerp(new THREE.Color(0xc8fdff), 0.3).getHex(),
      DUP_GLOW_PEAK,
    );
    // demo 的 `dupWireMats` 是一次做滿六條的陣列;這裡是 lazy 的(`sharedTrim` 快取)
    // 所以邊做邊收,好讓 `updateRiderSignals` 有 demo 那一行要走的那個集合。**收的是
    // 已經存在的那幾條**,不是先建滿六條 —— 沒有路線的世界不該多六個發光材質。
    if (!dupWireMats.includes(m)) dupWireMats.push(m);
    return m;
  };
  /**
   * 接觸電阻:電流過接點會抖一下。demo `sparkMat`,一格沒動 —— 連它自己的理由:
   *
   * > 材質**全場一份**(不能每個接點 new 一個,chunk 換頁就是漏),所以亮度靠
   * > scale 動,不靠 opacity 動。
   *
   * `opacity` 因此只剩日夜與功率那一格(demo 的 `applyDayNight` 寫在這裡),
   * 見 `updateRiderSignals`。
   */
  const sparkMat = (): THREE.MeshBasicMaterial => sharedTrim(
    'dupSpark',
    () => new THREE.MeshBasicMaterial({
      map: own(texOf(sparkTexture())), color: 0xdffbff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: true,
      side: THREE.DoubleSide,
    }),
  );

  /**
   * 線身:兩端點之間微微拱起的圓管。demo `dupontWireGeo`,一格沒動。
   *
   * > uv 的 u 用**絕對里程**算,所以全場共用一份脈衝貼圖、推一次 offset,電流就沿
   * > 著整條路連續往前跑,段與段之間不會對不上。
   */
  const dupontWireGeo = (
    a: { x: number; y?: number; z: number }, b: { x: number; y?: number; z: number },
    dA: number, dB: number,
  ): THREE.BufferGeometry => {
    const LS = 10, RS = 7;
    const pos: number[] = [], uvs: number[] = [], idx: number[] = [];
    const dx = b.x - a.x, dz = b.z - a.z;
    // 兩端腳下的地面高度。線材是硬的:段中間**不跟著地面起伏**,只在兩個接頭之間
    // 拉一條直的 —— 跟弦線切內角是同一件事的縱向版本,那是物理誠實,不要想辦法
    // 讓它貼合。
    const ga = a.y || 0, dgy = (b.y || 0) - ga;
    const len = Math.hypot(dx, dz) || 1;
    const sx = -dz / len, sz = dx / len;                    // 水平側向,永遠垂直切線
    for (let i = 0; i <= LS; i++) {
      const t = i / LS;
      const cx = a.x + dx * t, cz = a.z + dz * t;
      const cy = ga + dgy * t + DUP_Y + 4 * DUP_ARCH * t * (1 - t);
      // 拱起的斜率(加上兩端地面的落差)
      const hp = dgy + 4 * DUP_ARCH * (1 - 2 * t);
      const m = Math.hypot(hp, len);
      const vx = -dx * hp / len / m, vy = len / m, vz = -dz * hp / len / m;
      const u = (dA + (dB - dA) * t) * PULSE_UV;
      for (let j = 0; j <= RS; j++) {
        const ang = (j / RS) * Math.PI * 2;
        const c = Math.cos(ang) * DUP_R, s = Math.sin(ang) * DUP_R;
        pos.push(cx + sx * c + vx * s, cy + vy * s, cz + sz * c + vz * s);
        uvs.push(u, j / RS);
      }
      if (i < LS) {
        for (let j = 0; j < RS; j++) {
          const k = i * (RS + 1) + j;
          idx.push(k, k + RS + 1, k + 1, k + RS + 1, k + RS + 2, k + 1);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };

  /**
   * 接點火花的落點(demo `buildDupont` 的 `sparks` 輸出)。
   *
   * 這裡曾經寫著「**只收座標,不畫**」,理由是「踏頻與功率到不了 strategy,沒有相位
   * 就沒有『那一刻』,火花只會變成一排常亮的白點,那比不畫更錯」。相位現在到得了
   * (`updateRiderSignals` / `RiderSignals.cadenceRpm`),所以火花照 demo 畫出來了 ——
   * 而當時那句話的另一半仍然成立且值得留著:**常亮的白點比不畫更錯**,所以驅動一旦
   * 沒接上(沒有人呼叫 `updateRiderSignals`),這批 instance 的 `count` 就停在 0,
   * 什麼都不畫,而不是退化成一排靜止的亮點。
   */
  interface DupSpark { x: number; y: number; z: number; d: number }

  /**
   * `[d0, d1)` 裡的每個接點,連同它往前的那一段線。demo `buildDupont`,一格沒動 ——
   * 除了 `pathAt` / `offsetAt` / `box` 三個 helper 由呼叫端注入(gameview 的路徑來自
   * 真實 GPX,不是 demo 自己長出來的那條合成路)。
   */
  const buildDupont = (
    group: THREE.Group, d0: number, d1: number,
    disposables: THREE.BufferGeometry[], sparks: DupSpark[],
    ctx: {
      joints: { d: number }[];
      extend: (d: number) => void;
      offsetAt: (d: number, lateral: number) => { x: number; y: number; z: number };
      box: (sx: number, sy: number, sz: number, mat: THREE.Material) => THREE.Mesh;
    },
  ): void => {
    ctx.extend(d1 + DUP_MAX * 2);
    const dupJoints = ctx.joints;
    for (let k = 0; k + 1 < dupJoints.length; k++) {
      const jd = dupJoints[k].d, nd = dupJoints[k + 1].d;
      if (jd < d0 || jd >= d1) continue;
      const A = ctx.offsetAt(jd, DUP_LAT), B = ctx.offsetAt(nd, DUP_LAT);
      const dx = B.x - A.x, dz = B.z - A.z;
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len;
      const rot = Math.atan2(ux, uz);          // 繞 Y 轉 θ:局部 +Z → (sinθ, 0, cosθ)
      // 地面高度沿這一段線性內插:接頭在地上,線身在兩個接頭之間拉直。
      const gA = A.y || 0, dgy = (B.y || 0) - gA;
      const at = (s: number, y: number): [number, number, number] =>
        [A.x + ux * s, gA + dgy * (s / len) + y, A.z + uz * s];

      // 這一段起點的母頭:黑膠殼 + 一道防滑肋
      const fem = ctx.box(DUP_FW, DUP_FH, DUP_FL, dupShellMat());
      fem.position.set(...at(DUP_FL / 2, DUP_Y));
      fem.rotation.y = rot;
      group.add(fem);
      const rib = ctx.box(DUP_FW * 0.62, 0.28, DUP_FL * 0.5, dupRibMat());
      rib.position.set(...at(DUP_FL * 0.52, DUP_Y + DUP_FH / 2));
      rib.rotation.y = rot;
      group.add(rib);

      // 線身:從母頭尾端拉到下一個接點前的公頭尾端
      const s0 = DUP_FL, s1 = len - DUP_GAP - DUP_ML;
      if (s1 > s0 + 2) {
        const geo = dupontWireGeo(
          { x: A.x + ux * s0, y: gA + dgy * (s0 / len), z: A.z + uz * s0 },
          { x: A.x + ux * s1, y: gA + dgy * (s1 / len), z: A.z + uz * s1 },
          jd + s0, jd + s1);
        const w = new THREE.Mesh(geo, dupWireMat(k % DUP_COLORS.length));
        w.castShadow = true;
        group.add(w);
        disposables.push(geo);
      }

      // 這一段終點的公頭:膠殼 + 露出來插進下一段母頭的那根針
      const male = ctx.box(DUP_MW, DUP_MH, DUP_ML, dupShellMat());
      male.position.set(...at(len - DUP_GAP - DUP_ML / 2, DUP_Y));
      male.rotation.y = rot;
      group.add(male);
      const pin = ctx.box(0.5, 0.5, DUP_GAP + 2.4, dupPinMat());
      pin.position.set(...at(len - DUP_GAP + 0.9, DUP_Y));
      pin.rotation.y = rot;
      group.add(pin);

      sparks.push({ x: B.x, y: B.y || 0, z: B.z, d: nd });
    }
  };

  /**
   * The route body: run `buildDupont` over the whole route, then flatten it the
   * way this world flattens everything else (§6「事後攤平」/ `luHarvest`).
   *
   * ## Why the whole route and not per chunk
   *
   * The demo calls `buildDupont(group, d0, d1, …)` from `buildChunk`, and its
   * wire bodies are the one thing its own `harvest()` cannot batch («每一段的頂點
   * 都不一樣,收不了») — so in the demo each resident chunk pays its wires in
   * draw calls. gameview's route object is not chunked: it is built once for the
   * whole route and windowed with `setDrawRange` (that is why the ribbon it
   * replaces costs 2 draw calls for a 45 km route, not 2 per chunk).
   *
   * Keeping that lifecycle is what keeps this inside §6's budget: **9 draw calls
   * for the entire route** (six wire colours + shell + rib + pin), independent of
   * how many chunks are resident, versus 9 PER CHUNK if the demo's call site were
   * copied along with its function. The function itself is called exactly as the
   * demo calls it — a mileage window — just with the window set to the route.
   *
   * ## Why the merged buffers keep per-joint slices
   *
   * Terrain streams in, so a joint's ground height arrives long after its
   * geometry did. Every piece has a FIXED vertex count (wire 88, each box 24) and
   * the joint chain is stable under both re-projection (only y moves) and a
   * floating-origin re-base (a translation), so each piece's slice of the merged
   * buffer is stable too — `refresh` rebuilds only the joints in range and writes
   * their vertices back in place.
   */
  const buildRouteBody = (path: RoutePath): RouteBody => {
    // ── The path, as the demo's two helpers ──
    /** demo `offsetAt(d, lateral)` 的 x/z 部分(y 要問地面,見 `seat`)。 */
    const offsetXZ = (d: number, lateral: number): { x: number; z: number } => {
      const p = path.at(d);
      return { x: p.x - p.tz * lateral, z: p.z + p.tx * lateral };
    };
    /** 這一段弦往內切多少(正值 = 切進去了)。demo `chordCut`,一格沒動。 */
    const chordCut = (d0: number, d1: number): number => {
      const a = offsetXZ(d0, DUP_LAT), b = offsetXZ(d1, DUP_LAT);
      const m = path.at((d0 + d1) / 2);
      return DUP_LAT - (((a.x + b.x) / 2 - m.x) * -m.tz + ((a.z + b.z) / 2 - m.z) * m.tx);
    };
    // demo `extendDupont` + `dupRng`,一格沒動。**弦切只看 x/z**,所以整條鏈的里程
    // 在地形串流進來、或浮動原點重設之後都不會變 —— 那是 slice 站得住的前提。
    const joints: { d: number }[] = [];
    const dupRng = mulberry32(0x4a17);
    const extend = (d: number): void => {
      if (!joints.length) joints.push({ d: 0 });
      while (joints[joints.length - 1].d < d) {
        const d0 = joints[joints.length - 1].d;
        let L = DUP_DRAW + dupRng() * (DUP_MAX - DUP_DRAW);
        while (L > DUP_MIN && chordCut(d0, d0 + L) > DUP_SAG) L -= 4;
        joints.push({ d: d0 + L });
      }
    };

    // Ground under a joint. `null` (terrain not streamed in yet) falls back to the
    // route line's own height there, which is the only other height in reach —
    // the demo never meets this case (`geoGroundY` always answers).
    let ground: RouteGroundFn = () => null;
    const seat = (d: number): { x: number; y: number; z: number } => {
      const { x, z } = offsetXZ(d, DUP_LAT);
      const routeY = path.at(d).y;
      return { x, y: ground(x, z, routeY) ?? routeY, z };
    };

    /** demo 的 `box(sx, sy, sz, mat)`:unitBox 縮放,cast + receive 都開。 */
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const box = (sx: number, sy: number, sz: number, mat: THREE.Material): THREE.Mesh => {
      const m = new THREE.Mesh(boxGeo, mat);
      m.scale.set(sx, sy, sz);
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    };
    const ctx = { joints, extend, offsetAt: seat, box };

    /** One merged mesh: everything in the route that shares a material + flags. */
    interface Bucket {
      key: string;
      mat: THREE.Material;
      cast: boolean;
      recv: boolean;
      name: string;
      parts: THREE.BufferGeometry[];
      /** Per-piece placement in the merged buffers, in append (= mileage) order. */
      slices: { joint: number; vert: number; verts: number; idx: number; idxs: number }[];
      mesh: THREE.Mesh | null;
      vertCount: number;
      idxCount: number;
    }
    const buckets = new Map<string, Bucket>();
    /** Per joint, where each of its pieces landed — the refresh map. */
    const jointSlices: { d: number; pieces: { bucket: Bucket; slice: number }[] }[] = [];
    /**
     * One spark per entry in `jointSlices`, same index — `buildDupont` pushes
     * exactly one per joint it builds (the `sparks.push` at the end of its loop
     * body is unconditional).
     *
     * INDEXED and not appended, and that is a fix rather than a style choice:
     * `buildJoint` also runs from `refresh` (a streamed-in chunk re-seats ~17
     * joints), and letting the demo's `sparks.push` accumulate there would grow
     * this array for the whole ride — a joint's spark would be in it once per
     * time its chunk was ever projected. It has to be a WRITE at the joint's own
     * slot, exactly like `writeSlice` is for the vertices.
     */
    const sparks: DupSpark[] = [];
    /** Scratch for one `buildJoint` call — see `sparks`. */
    const sparkOut: DupSpark[] = [];

    /**
     * Build ONE joint and hand back its meshes, in the order `buildDupont` added
     * them. The narrow mileage window is the demo's own early-out
     * (`if (jd < d0 || jd >= d1) continue;`), so this is that function unmodified.
     *
     * The joint's spark lands in `sparkOut[0]`; the caller files it.
     */
    const buildJoint = (d: number): THREE.Mesh[] => {
      const g = new THREE.Group();
      const disposables: THREE.BufferGeometry[] = [];
      sparkOut.length = 0;
      buildDupont(g, d, d + 1e-9, disposables, sparkOut, ctx);
      g.updateMatrixWorld(true);
      const out: THREE.Mesh[] = [];
      for (const child of g.children) if ((child as THREE.Mesh).isMesh) out.push(child as THREE.Mesh);
      return out;
    };

    /** Mesh → census name. Keyed by MATERIAL, because the piece order inside a
     *  joint changes when a segment is too short for a wire body. */
    const pieceName = (mesh: THREE.Mesh, k: number): string => {
      const mat = mesh.material as THREE.Material;
      if (mesh.geometry !== boxGeo) return `route/wire${k % DUP_COLORS.length}`;
      if (mat === dupRibMat()) return 'route/rib';
      if (mat === dupPinMat()) return 'route/pin';
      return 'route/shell';
    };

    const bucketFor = (mesh: THREE.Mesh, name: string): Bucket => {
      const mat = mesh.material as THREE.Material;
      const key = `${mat.uuid}|${mesh.castShadow ? 1 : 0}|${mesh.receiveShadow ? 1 : 0}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          key, mat, cast: mesh.castShadow, recv: mesh.receiveShadow, name,
          parts: [], slices: [], mesh: null, vertCount: 0, idxCount: 0,
        };
        buckets.set(key, b);
      }
      return b;
    };

    // ── Pass 1: every joint on the route, bucketed ──
    extend(path.lengthM);
    for (let k = 0; k + 1 < joints.length; k++) {
      if (joints[k].d >= path.lengthM) break;
      const meshes = buildJoint(joints[k].d);
      if (!meshes.length) continue;
      const entry = { d: joints[k].d, pieces: [] as { bucket: Bucket; slice: number }[] };
      for (const mesh of meshes) {
        const isWire = mesh.geometry !== boxGeo;
        const b = bucketFor(mesh, pieceName(mesh, k));
        const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        const verts = geo.getAttribute('position').count;
        const idxs = geo.index?.count ?? 0;
        b.slices.push({ joint: jointSlices.length, vert: b.vertCount, verts, idx: b.idxCount, idxs });
        entry.pieces.push({ bucket: b, slice: b.slices.length - 1 });
        b.parts.push(geo);
        b.vertCount += verts;
        b.idxCount += idxs;
        if (isWire) mesh.geometry.dispose();
      }
      sparks[jointSlices.length] = sparkOut[0];
      jointSlices.push(entry);
    }

    const group = new THREE.Group();
    group.name = 'route/dupont';
    const order = [...buckets.values()];
    for (const b of order) {
      const merged = mergeGeometries(b.parts);
      for (const g of b.parts) g.dispose();
      b.parts.length = 0;
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, b.mat);
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.recv;
      mesh.name = b.name;
      // 整條路線的包圍球等於整個世界,而它是一條 45 km 的線 —— frustum culling 對
      // 它只會白算(而且 drawRange 已經把「畫多少」收掉了)。
      mesh.frustumCulled = false;
      b.mesh = mesh;
      group.add(mesh);
    }

    // ── 接點火花的批次(demo 的 `sparkParts = protoParts(…, SPARK_CAP)`)──────
    //
    // demo 的原話:「這兩種每一幀都在變(金幣自轉+浮動、火花靠 scale 亮),放進上面
    // 的靜態池等於每幀重寫整池。改成自己的 InstancedMesh。」
    //
    // 容量是**整條路線的接點數**,不是 demo 的 `SPARK_CAP = 64`。理由跟線身選擇整條
    // 路線一份 merged buffer 完全一樣(見上面「Why the whole route and not per
    // chunk」):demo 的池是給「常駐 chunk 的火花」用的固定池,而 gameview 的路線物件
    // 本來就是整條建一次、用 `window` 收。64 這個數字搬過來會在 6 km 的窗(當前 chunk
    // ±1,每個 2 km,接點每 ~60 m 一個 → ~100 個)裡不夠用,而不夠用的那一段剛好可能
    // 落在騎士前面。每幀只寫窗裡那幾個 instance(`addUpdateRange`),所以上傳量跟窗
    // 成正比、跟路線長度無關。
    const sparkGeo = new THREE.PlaneGeometry(1, 1);
    // demo:`sp.rotation.x = -Math.PI / 2`,而 `protoParts` 把原型的 `matrixWorld`
    // 當成 local 存下來,每幀 `world × local`。這裡就是那個 local。
    const sparkLocal = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    const sparkMesh = new THREE.InstancedMesh(
      sparkGeo, sparkMat(), Math.max(1, sparks.length),
    );
    sparkMesh.name = 'route/spark';
    sparkMesh.castShadow = false;      // demo:`sp.castShadow = false`
    sparkMesh.receiveShadow = false;
    sparkMesh.renderOrder = 11;        // demo:`sp.renderOrder = 11`
    sparkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    sparkMesh.frustumCulled = false;   // 實例散在整條走廊上,包圍球等於整個世界
    sparkMesh.count = 0;
    sparkMesh.visible = false;
    group.add(sparkMesh);

    /** Copy a freshly built piece's vertices into its slice of the merged buffer. */
    const writeSlice = (b: Bucket, slice: number, src: THREE.BufferGeometry): void => {
      const dst = b.mesh?.geometry;
      if (!dst) return;
      const s = b.slices[slice];
      const srcPos = src.getAttribute('position');
      if (srcPos.count !== s.verts) return;   // shape changed — cannot happen, see above
      for (const name of ['position', 'normal', 'uv'] as const) {
        const a = src.getAttribute(name);
        const t = dst.getAttribute(name) as THREE.BufferAttribute | undefined;
        if (!a || !t) continue;
        (t.array as Float32Array).set(a.array as Float32Array, s.vert * t.itemSize);
        // Partial upload. `needsUpdate` alone re-sends the WHOLE buffer, and this
        // one is megabytes for a 45 km route while a chunk load touches ~17 joints
        // of it — so the update range is not a micro-optimisation, it is the
        // difference between a few KB and the entire route per streamed chunk.
        t.addUpdateRange(s.vert * t.itemSize, s.verts * t.itemSize);
        t.needsUpdate = true;
      }
    };

    let disposed = false;

    /**
     * 一幀的火花。demo `animate()` 那一段,一個字沒改 —— 包含它自己的理由:
     *
     * > 接觸電阻:電流過接點抖一下。起得快、退得慢(接點被燙了一下才慢慢暗),
     * > 而且亮度靠 scale —— 材質是全場共用的,不能為了單一接點去改 opacity。
     *
     * 相位來自 `pulseU`(踏頻推的),所以這支只在 `updateRiderSignals` 之後跑;沒有
     * 人餵訊號的話 `count` 停在 0,一片都不畫(見 `DupSpark`)。
     *
     * demo 的 `if (nSpark >= SPARK_CAP) break;` 在這裡不需要:容量就是接點數,而窗
     * 只會是它的子集。
     */
    const sparkTmpW = new THREE.Matrix4();
    const sparkTmpM = new THREE.Matrix4();
    const sparkTmpV = new THREE.Vector3();
    const sparkTmpS = new THREE.Vector3();
    const SPARK_IDENT_Q = new THREE.Quaternion();
    /** 目前的窗,`window()` 記下來的(null 的窗 = 整條路線)。 */
    let winD0 = Number.NEGATIVE_INFINITY, winD1 = Number.POSITIVE_INFINITY;
    const animateSparks = (): void => {
      if (disposed) return;
      let n = 0;
      for (let i = 0; i < sparks.length; i++) {
        const s = sparks[i];
        if (!s) continue;
        // 窗的判準用**做出這個火花的那個接點**的里程,不是火花自己的位置(火花坐在
        // 下一個接點上,兩者差一段線)。理由有兩個,而且都不是細節:
        //  · demo 就是這樣分的 —— 它跑的是 `for (const c of chunks) for (const s of
        //    c.sparks)`,而一個 chunk 的 sparks 就是「建這個 chunk 的接點時押進去的
        //    那些」,也就是照**產出它的接點**分組。
        //  · 這樣火花跟線身(`window()` 篩的是 `jointSlices[s.joint].d`)才是同一組
        //    接點。用火花自己的位置篩會在窗的兩端各差一個 —— 而症狀是窗邊有一段線
        //    畫著、它的接點卻不會抖。
        const jd = jointSlices[i]?.d ?? s.d;
        if (jd < winD0 - DUP_MAX || jd > winD1) continue;
        let v = 0;
        const f = s.d * PULSE_UV + pulseU;
        for (const b of PULSE_BANDS) {
          let dd = f - b - Math.floor(f - b);          // 0..1,0 = 脈衝正在這個接點上
          if (dd > 0.5) dd -= 1;
          const a = dd < 0 ? 1 + dd / 0.028 : 1 - dd / 0.085;
          if (a > v) v = a;
        }
        sparkTmpV.set(s.x, (s.y || 0) + DUP_Y + 0.9, s.z);
        sparkTmpS.setScalar(v > 0 ? 0.001 + v * 5.4 : 0.001);
        sparkTmpW.compose(sparkTmpV, SPARK_IDENT_Q, sparkTmpS);
        sparkMesh.setMatrixAt(n++, sparkTmpM.multiplyMatrices(sparkTmpW, sparkLocal));
      }
      sparkMesh.count = n;
      sparkMesh.visible = n > 0;
      // 只上傳寫過的那一段 —— 跟 `writeSlice` 同一條理由,一條 45 km 的路線有 ~750
      // 個接點而窗裡只有 ~100 個。
      sparkMesh.instanceMatrix.addUpdateRange(0, n * 16);
      sparkMesh.instanceMatrix.needsUpdate = true;
    };

    const body: RouteBody = {
      group,
      refresh: (groundFn, d0, d1) => {
        if (disposed) return;
        ground = groundFn;
        for (let ji = 0; ji < jointSlices.length; ji++) {
          const entry = jointSlices[ji];
          // A joint's wire reaches forward to the NEXT joint, so a joint just
          // behind the range still has geometry inside it.
          if (entry.d < d0 - DUP_MAX || entry.d > d1) continue;
          const meshes = buildJoint(entry.d);
          // 這個接點的火花也剛剛被重算了 —— 地面高度是串流進來的,火花跟接頭坐在
          // 同一個地面上,所以它跟頂點一樣是**寫回原位**,不是再 push 一個。
          if (sparkOut[0]) sparks[ji] = sparkOut[0];
          if (meshes.length !== entry.pieces.length) continue;
          for (let i = 0; i < meshes.length; i++) {
            const mesh = meshes[i];
            mesh.updateMatrixWorld(true);
            const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
            const { bucket, slice } = entry.pieces[i];
            writeSlice(bucket, slice, geo);
            geo.dispose();
            if (mesh.geometry !== boxGeo) mesh.geometry.dispose();
          }
        }
        ground = () => null;
        // INVALIDATE, don't recompute. Both caches go stale the moment vertices
        // move in place (the same trap `refreshRibbons` documents), and three
        // recomputes either on demand — but eagerly walking all 150 k vertices
        // twice per streamed chunk buys nothing here: these meshes are
        // `frustumCulled = false` (one mesh IS the whole route, so its sphere is
        // the world) and nothing raycasts the route.
        for (const b of order) {
          const geo = b.mesh?.geometry;
          if (!geo) continue;
          geo.boundingBox = null;
          geo.boundingSphere = null;
        }
      },
      window: (range) => {
        // 火花走的是 instance 的 count,不是 drawRange —— 但**判準是同一個**,所以
        // 這裡只記下範圍,讓 `animateSparks` 用同一條式子篩。兩份判準遲早會分岔。
        winD0 = range ? range.d0 : Number.NEGATIVE_INFINITY;
        winD1 = range ? range.d1 : Number.POSITIVE_INFINITY;
        for (const b of order) {
          const geo = b.mesh?.geometry;
          if (!geo?.index) continue;
          if (!range) { geo.setDrawRange(0, Infinity); continue; }
          let from = -1, to = -1;
          for (const s of b.slices) {
            const d = jointSlices[s.joint].d;
            if (d < range.d0 - DUP_MAX || d > range.d1) continue;
            if (from < 0) from = s.idx;
            to = s.idx + s.idxs;
          }
          geo.setDrawRange(from < 0 ? 0 : from, from < 0 ? 0 : to - from);
        }
      },
      dispose: () => {
        disposed = true;
        for (const b of order) {
          b.mesh?.geometry.dispose();
          b.mesh = null;
        }
        group.clear();
        boxGeo.dispose();
        sparkGeo.dispose();
        // 這一行不是重複的:`geometry.dispose()` 碰不到 instanceMatrix,那顆 buffer
        // 住在 mesh 上(§6「`InstancedMesh` 也要 dispose,而且很容易漏」)。
        sparkMesh.dispose();
        liveRoutes.delete(animateSparks);
        // Materials and the pulse texture are strategy-owned singletons
        // (`sharedTrim` / `sharedGlow` / `own`) — a route rebuild must not take
        // them with it. `strategy.dispose()` is the owner.
        sparks.length = 0;
      },
    };
    // 每幀的驅動要找得到還活著的路線本體。
    liveRoutes.add(animateSparks);
    return body;
  };

  // ═════════════════════════════════════════════════════════════════════════
  const strategy: TerrainStyleStrategy & FinnedMountainRingStyle = {
    style: 'circuit',
    params,

    // ── Colours ──
    // The board is ONE uniform green — elevation reads from the FR4 risers and
    // the lighting, not from a colour ramp (a tinted board would break the
    // "this is a real PCB" read the routing texture is carrying).
    terrainVertexColor: () => new THREE.Color(1, 1, 1),
    // Slivers / degenerate footprints (no themed body): generic SMD package
    // colours, deterministic per location.
    buildingColor: (lon, lat) => {
      const h = Math.sin(lon * 127.1 + lat * 311.7) * 43758.5453;
      const u = h - Math.floor(h);
      const palette = [E.icHi, E.alu, 0xe8e4d8, 0x1b3a6b];
      return palette[Math.floor(u * palette.length) % palette.length];
    },
    roadColor: () => E.gold,
    // 一張表,兩個用途:帶子多寬,以及它的貼圖該畫多寬的阻焊邊(見 `BUS_W`)。
    // 兩份的話「阻焊邊在世界裡是 1 公尺」會在其中一份被改掉的那一刻靜靜失效。
    roadWidth: (cls) => BUS_W[cls] ?? BUS_W_DEFAULT,
    // demo 的 `busMats` key:**寬度**。撞寬的兩級(這張表有兩對:trunk/primary、
    // tertiary/minor)自動共用同一張畫布,也就自動併成同一個 draw call。
    roadMaterialKey: (cls) => String(BUS_W[cls] ?? BUS_W_DEFAULT),
    /**
     * 換級處的 45° 錐段長 —— demo 的 `taperLen`,一行照抄:
     *
     * ```js
     * function taperLen(wa, wb) { return Math.abs(wa - wb) / 2; }
     * ```
     *
     * 這是這張表**收斂成偶數寬**的回報:Δ ∈ {2, 4, 6} → 錐長 {1, 2, 3},兩端都落
     * 在整公尺上,跟板面貼圖那套 45° 走線文法同一把尺。
     */
    roadTaperLength: (wa, wb) => Math.abs(wa - wb) / 2,
    /**
     * 錐段上的 v 半幅 —— demo `busSeg` 的 `hv`,連同它的理由:
     *
     * ```js
     * const b = BUS_MASK / nomW;                      // 這張貼圖的阻焊邊佔 v 的比例
     * const hv = (0.5 - b) * w / (w - 2 * BUS_MASK);
     * ```
     *
     * 阻焊邊是製程參數(1 公尺),而貼圖是照**公稱寬**畫的,所以錐段上要反算 v 的
     * 半幅,綠邊在世界裡才一路維持 1 公尺。
     *
     * 下界是 gameview 自己補的:demo 的公式沒有下界(它的最窄是 8 m),而 `w` 收窄
     * 到 2 × BUS_MASK 就除以零 —— 那時候整條路面已經只剩阻焊邊、沒有鍍金了,v 回
     * 0.5(貼圖原樣)是唯一講得通的答案。
     */
    roadUvHalfSpan: (w, nomW) => (
      w > 2 * BUS_MASK ? (0.5 - BUS_MASK / nomW) * w / (w - 2 * BUS_MASK) : 0.5
    ),
    zoneDecalColor: (zone) => ZONE_MASK_3D[zone ?? 'residential'],
    treeTrunkColor: E.tin,
    // 圓片陶瓷電容的三種釉色(demo discCapMats)。
    treeCanopyColors: [0x3a6fc4, 0xc9822a, 0x7a4a2a],

    // ── Materials ──
    createTerrainMaterial: () => {
      const m = toon({
        vertexColors: true,
        map: pcbFaceTex,
        emissiveMap: pcbGlowTex,
        emissive: new THREE.Color(0x000000),
        // Night peak from the demo's applyDayNight (0.08 + 1.25k → 1.33): the
        // global driver ramps the emissive COLOUR 0 → trace, this carries the
        // scale.
        emissiveIntensity: 1.33,
      });
      // 招牌動作:入夜整片板子的走線亮起來。Fresh per chunk, so registration
      // must not outlive the material — three dispatches 'dispose', and the
      // listener keeps the global night registry from accumulating dead chunks.
      registerNightLitMaterial(m, E.trace);
      m.addEventListener('dispose', () => unregisterNightLitMaterial(m));
      return m;
    },
    // 每一道量化地形的豎邊都是板子的剖面:FR4 玻纖 + 上下銅箔層。
    // 沒有 `createTerrainWallMaterial`:這個世界的切邊一律走下面的分階版本,
    // 留一支「不分階」的在旁邊就是同一種零件兩份做法,遲早會分岔。
    // 這個世界的「分層設色」在切邊的層數上,不在板色上 —— 見 `fr4EdgeTexture`。
    terrainWallLevels: FR4_MAX_LEVEL,
    // demo 的 `sunLight.shadow.normalBias = 1.2` —— 另外兩個 demo 寫 1.5,而這是
    // 三份陰影設定裡**唯一**不一致的一格。理由在零件的尺度:SMD 本體、散熱鰭片、
    // 跳線帽都是毫米級的,1.5 m 的法線偏移會把影子從它們自己腳下抬走。
    shadowNormalBias: 1.2,
    // demo 的 `fr4Cache` 就在這裡:一階一張 128×64,四張總共 32 K pixel-writes,
    // 建一次給整條路線用。不 cache 的話每個 chunk 重畫四張,那才是成本。
    createTerrainWallMaterialForLevel: (level) => fr4EdgeMat(level),
    /**
     * 板子的切邊 —— demo 的
     * `sideWallSeg(d0, d1, side * boardW / 2, -9, 0, 0.06)` + `edgeMat`。
     *
     * demo 那三行原封不動:
     *
     * ```js
     * const edgeMat = toon({ map: tex(fr4Tex, 0.06, 1), side: THREE.DoubleSide });
     * for (const side of [-1, 1]) {
     *   const wallGeo = sideWallSeg(d0, d1, side * boardW / 2, -9, 0, 0.06);
     * ```
     *
     * `edgeMat` 用的是**沒有分階的** `fr4Tex`(2 層銅箔的裸板),不是
     * `edgeMatForLevel(n)` —— 板子的外緣是板子本身的厚度,不是某一片疊層的切口。
     * 所以這裡指到 `fr4EdgeMat(0)`,跟走廊裡第 0 階的切邊**是同一個實例**:同一
     * 種零件只能有一份做法(§3.10 最後一條),兩份遲早會分岔。
     *
     * u 的尺度沒有照抄 demo 的 0.06:gameview 的牆 uv 走 `WALL_U_METERS` / 量化
     * 階(`quantized-terrain.ts` 的合約,整條走廊的切口都吃它),側牆走另一套的話
     * 它跟隔壁的切口就會是兩種織紋。
     */
    sideWall: {
      drop: 9,               // demo: `sideWallSeg(…, -9, 0, 0.06)`,板面在 y = 0
      createMaterial: () => fr4EdgeMat(0),
    },
    createBuildingMaterial: () => {
      if (!buildingMaterial) {
        buildingMaterial = toon({ vertexColors: true, side: THREE.DoubleSide });
      }
      return buildingMaterial;
    },
    // 鍍金匯流排:阻焊開窗露出鍍金,兩道阻焊邊在世界裡固定 1 公尺(見 busMatFor)。
    createRoadMaterial: (_color, roadClass) => busMatFor(roadClass),
    // 焊錫池:表面張力鼓起來的液態金屬 — 不透明、高鏡面(demo 的 solderMat)。
    createWaterMaterial: () => metal(E.solder, 200),
    // 公園 = 鋪銅面(邊緣裸銅、內部散熱網格的那塊 landuse)。
    createParkMaterial: () => toon({
      map: pourTex,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    // 森林 = 密集感測區:亮一階的阻焊(元件將它填滿,樹會蓋在上面)。
    createForestMaterial: () => toon({
      color: E.maskHi,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    // 沙地 = 玻纖鑽屑 + 混在裡面的錫珠(見 `luSandTexture`)。
    //
    // 這一格**換掉了**移植時寫的「未上阻焊的裸板(FR4)」:那是同一張 `fr4Tex`,
    // 而它同時是走廊每一道量化階的切邊與板子外緣的側牆 —— 一塊躺平的地被跟全場
    // 的切口用同一張圖,就是 §3.2 的手感撞號;而且它的 repeat 沒設(1 格 = 1 公尺),
    // 一張織紋圖每公尺重複一次在騎士眼高等於一片噪點。demo 的答案:§3.4 說沙地
    // 活得下來的訊號是**顏色與粗糙度**,所以那張圖只做這兩件事。
    createSandMaterial: () => toon({ map: luSandTex, side: THREE.DoubleSide, ...LU_DEPTH }),
    createZoneDecalMaterial: () => toon({
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    createTreeMaterial: () => toon({ vertexColors: true }),
    /**
     * 濕地 = **助焊劑殘膜**(rosin flux residue),demo 的 `luWetlandMat`。
     *
     * ⚠ 這一格唯一要贏的比較是**跟焊錫池分得開**(§3.2)。上一版是
     * `MeshPhongMaterial({ shininess: 90, specular: #ffffff })` —— 那跟
     * `createWaterMaterial()` 的 `metal(E.solder, 200)` 是**同一個材質類別、同一種
     * 手感**:兩塊都躺在地上,兩塊都會反出天空,只是一塊灰一塊琥珀。手感撞號比輪
     * 廓撞號更難察覺,而沼澤跟水正好最常相鄰。
     *
     * demo 的答案是把手感**整個反過來**:池是硬、鏡面、不透;殘膜是霧面、半透、
     * 深琥珀、黏 —— 所以連材質類別都換掉,池是 Phong 高光,這裡是 toon **沒有**
     * 高光。opacity 也照 demo 的 0.86(不是 0.5):半透是為了「看得出底下還有
     * 東西 = 濕」,不是為了把地被變成一層玻璃紙。
     */
    createWetlandMaterial: () => toon({
      map: luWetTex, side: THREE.DoubleSide,
      // 半透 = 看得出底下還有東西 = 濕。**沒有** specular(那是焊錫池的事)。
      transparent: true, opacity: 0.86,
      ...LU_DEPTH,
    }),
    // 農田 = 條狀洞洞板:綠阻焊底 + 一道一道的裸銅條,孔在銅條上(見
    // `luFarmTexture`)。上一版是「等距平行的金線」—— 同一個念頭,但線是 3 px /
    // 16 px 節距(≈ 0.2 m 寬、1 m 一道),在 6.3 m 眼高的掠角下整片糊成一塊綠。
    // demo 把它做**寬**:銅條 44 px / 64 px 節距 = 2.75 m 寬、4 m 一道,跟板子上
    // 匯流排束同節距 —— 那是這個世界已經驗過「一眼看得出是一束一束」的數字。
    createFarmlandMaterial: () => toon({ map: luFarmTex, side: THREE.DoubleSide, ...LU_DEPTH }),
    /**
     * 運動場 = **一塊絲印區**。底色是暗一階的 `E.maskLo`(把白絲印的對比拉到最大),
     * 線寬 8 px = 0.75 m —— 真球場線的七倍,因為照真值畫在 6.3 m 眼高的掠角下等於
     * 沒畫。
     *
     * 夜:**這片地自己不發光**(使用者裁示,demo 已改)。原本這裡掛
     * `emissiveMap: luSportsGlowTex` + `emissiveIntensity: 1.51` +
     * `registerNightLitMaterial`,而一整片地面亮起來讀出來是**招牌**不是照明 ——
     * 招牌是別的元件的身分(§3.3),而且那正是 §3.10「小、在裡面、被半透明的殼
     * 包著」的反面。demo 現在寫得很直白:「球場**不自己發光**…五格地被現在**一格
     * 都不自己發光**,燈全部在燈上」。
     *
     * 照亮它的是場邊那顆 **LED 路燈**,燈的身分跟**地塊的 seed** 綁(那塊地重心
     * 取整),不是路燈池的索引 —— 池是滑動的,綁索引會讓同一座球場每 70 m 換一次
     * 色(`2427d86` 修過)。擺燈是 `landuse-renderer` 的事,不新增任何詞彙。
     */
    createSportsFieldMaterial: () => toon({
      map: luSportsFaceTex, side: THREE.DoubleSide, ...LU_DEPTH,
    }),
    // 遊樂場 = **麵包板**:電子世界裡專門拿來玩的那塊板子(見 `luPlayTexture`)。
    // 提案的「排針 + 跳線帽的攀爬架」駁回 —— 那**就是** checkpoint
    // (`buildCheckpoint`:排針座 + 一顆跳線帽),同一組兩個零件、同一個組合方式,
    // §3.3 的原話就是這種情況。
    createPlaygroundMaterial: () => toon({ map: luPlayTex, side: THREE.DoubleSide, ...LU_DEPTH }),

    // ── Diorama props ──

    // 防靜電袋收掉地平線(demo:換掉桌墊,因為瓦楞紙的地面已經是綠色切割墊 —
    // 跨世界的手感撞號)。horizonColor = 貼圖的底色,fallback 才是同一張桌子。
    horizonColor: E.bagBase,
    createHorizonMaterial: () => toon({ map: esdTex, side: THREE.FrontSide }),

    /**
     * 防塵/防靜電罩 — the circuit world's identity for the shared acrylic case
     * (boards ARE stored under one; same object family as the bag it sits on).
     * Numbers from the demo's case block, with ONE deliberate deviation: the
     * demo's crown streaks stop at theta ≈ 1.0, which `AcrylicStreak`'s
     * contract documents as the bug both other demos also shipped — from the
     * rider's 6.3 m eye the sky band is theta 1.2–1.57 and a streak that stops
     * at the crown is never seen. Both existing worlds extended theirs at port
     * time; this follows them (demo phi positions kept).
     */
    acrylicCase: {
      tintDay: E.acrylic,
      tintNight: E.acrylic,   // the demo's case does not re-tint at night
      tintRain: E.acrylicRain,
      rimDay: E.acrylic,
      rimNight: E.acrylic,
      lipColor: 0xeaf7fa,
      streakDay: 0xffffff,
      streakNight: 0xffffff,
      rainFilmColor: 0xceecf6,
      shellOpacity: 0.085,
      rimOpacity: 0.2,
      lipOpacity: 0.42,
      streakOpacity: 0.15,
      streaks: [
        [0.85, 0.09, 0.1, 1.42],
        [2.55, 0.09, 0.24, 1.2],
      ],
    },

    // 白天 = 實驗室日光燈下的工作檯;夜晚 = 關燈,只剩板子自己在發光。demo 的
    // DAY / NIGHT,含夜間三盞燈拉回三世界同一階的那次補救(0.62 / 0.5 / 0.18;
    // gameview 的 amb ≥ 0.18 硬地板正是為它立的)。
    skyPalette: {
      // demo:`float h = clamp(vP.y / 300.0, …)` / `floor(h * 6.0) / 6.0` on its
      // 1100 m dome. **6 bands, not 5** — the only demo that posterises the sky
      // differently, and deliberately: one more step is one more contour on a
      // scope's screen.
      //
      // ⚠ 這個分母**曾經是 500**(跟瓦楞紙一樣),而那讓天色整個看不到。500 代表
      // 天頂色要**仰角 27.0°** 才到位,但騎乘視角根本到不了那裡:
      //
      //   畫面頂邊仰角 = 跟騎相機的俯角 + DEFAULT_FOV / 2
      //     跟騎:車後 CHASE_BACK 11.2 m / 高 CHASE_UP 6.3 m,看前方
      //     CHASE_LOOK_AHEAD 5.3 m 處的 gaze 高;config 預設 cameraPitch 12
      //     (不是 CHASE_NEUTRAL_PITCH 的 30)⇒ 俯角 7.8°,+27.5° = **19.9°**
      //   遠山稜線 = atan(FAR_MAX_HEIGHT / MOUNTAIN_FAR_RADIUS)
      //           = atan(170 × 2600/640 / 2600) = **14.88°**
      //
      // 所以真正露出來的天空只有 14.9°→19.9° 那條窄帶(山谷處往下到約 6°),
      // 而漸層在那裡只走到 50-67% —— 混出來是 6-17% 飽和的灰。陰天再往
      // `#c4c8cc` 拉 50%,剩 8-10%。那就是「這個世界沒有天空」的成因。
      //
      // 300 是從稜線 14.88° 反推的:天頂色改成 15.8° 到位,壓在稜線上方一點,
      // 畫面上半整片是天色,而階界(2.60/5.21/7.84/10.50/13.21/15.96 度)還留
      // 4 條色帶在可見範圍內,所以 6 階這個分歧沒有被犧牲掉。
      //
      // 光改分母不夠:漸層**下緣**也一起從 `#dfe8e2` 抬成 `#cfe0e4`,見 day
      // 那一段。**demo 兩處都一起改了**(circuit-town-demo.html 的 shader 與
      // DAY.bottom),所以這不是偏離 demo —— diorama.ts 會去讀 demo 的原始碼
      // 比對,只改這裡是過不了的。
      gradient: { demoHeight: 300, steps: 6 },
      // demo 的星星那一段,原封搬過來(plan/circuit-town-demo.html):
      //   const n = 300 … ph = Math.random() * Math.PI * 0.42 + 0.06
      //   sg.fillStyle = '#cfeef8'; sg.arc(16, 16, 6, 0, 6.284);
      //   new THREE.PointsMaterial({ size: 25.263157894736842, … })
      // **四個數字都跟另外兩個世界不同,而那是刻意的**(跟 normalBias 1.2 vs 1.5
      // 同一個形狀):多 40 顆、每顆小一階(8 vs 9,搬到新天球後 25.26 vs 28.42)、
      // 帶子往上多開 1.14°(polarMin 0.06 vs 0.08)、圓點 6 px 而不是 7 px,顏色是
      // 冷磷光藍而不是暖黃 —— 這個世界的夜空是關了燈的實驗室,不是玩具箱。
      // size 是**世界公尺**(sizeAttenuation),不是螢幕像素 —— 見 starPointSize。
      stars: {
        count: 300, size: 25.263157894736842,
        polarSpan: 0.42, polarMin: 0.06,
        spriteRadius: 6, color: '#cfeef8',
      },
      day: {
        // skyBottom 曾經是 `#dfe8e2` —— 近乎白的灰綠,飽和只有 3%。它是漸層的
        // 下緣,而遠山稜線的**山谷**會露到仰角 5-10°,那一段永遠取樣在漸層下半
        // 部,所以光把 gradient.demoHeight 拉低(見上面)只會讓稜線**以上**變成
        // 天色,山谷還是灰的。`#cfe0e4` 把下緣也拉成天色,山谷那一段從 6% 飽和
        // 變成 14%。demo 的 DAY.bottom 一起改了。
        //
        // fog 刻意**不動**:霧管的是遠處地形褪成什麼顏色,不是天空。
        skyTop: 0x9fc6d4, skyBottom: 0xcfe0e4, fog: 0xcfdcd6,
        sunColor: 0xfff8ea, sunIntensity: 2.0,
        hemiSky: 0xd6e8ee, hemiGround: 0x2c5c44, hemiIntensity: 0.9,
        ambientColor: 0xeaf4ff, ambientIntensity: 0.35,
      },
      night: {
        skyTop: 0x050d14, skyBottom: 0x0a2028, fog: 0x08171c,
        sunColor: 0x8fb4d4, sunIntensity: 0.62,
        hemiSky: 0x16394c, hemiGround: 0x10301f, hemiIntensity: 0.5,
        ambientColor: 0xeaf4ff, ambientIntensity: 0.18,
      },
    },

    // 天上那兩顆:一台圓形示波器的螢光屏 —— demo 的 `skyDisc` 原封搬過來
    // (plan/circuit-town-demo.html)。同一支管子、兩種磷光:白天是 P3 琥珀黃、
    // 夜裡是 P11 藍,所以日與月是同一件事的兩端,跟天相滑桿在做的事同一件。
    //
    // 不撞身分(§3.3):LED 是路燈、輝光管與真空管是建築,**CRT 這個世界一個都
    // 還沒有**。邊緣語彙 = 刻度格線(8×10 格 + 中央兩條加粗的軸 + 軸上的次刻度),
    // 外面再套一圈鋁製管口。
    //
    // ## 掃描線是**動的**,而且它是免費的
    //
    // P3 / P11 的招牌特性就是長餘輝 —— 光點掃過去、尾巴慢慢衰減,所以「掃描線 +
    // 拖尾」不是加戲,那就是這兩個型號本來的樣子。
    //
    // ⚠ 實作方式決定它是免費還是很貴:**不逐幀重畫 canvas 再上傳**。一次 texture
    //   upload 就是一個 GPU 同步點,而 N100 實測 GPU 是 50 ms 的固定地板、跟畫什麼
    //   無關;逐幀上傳正好加在那個地板上。這裡把波形烤成一張**橫向可重複**的貼圖,
    //   每幀只推 `map.offset.x`(sky-and-fog 的 `scrollCelestialBeams` 認得
    //   `userData.beam` / `userData.beamSpeed`)—— 一個 uniform、零上傳,而且掃描線
    //   本來就是由左往右掃。餘輝烤進貼圖自己的 alpha 梯度裡(頭亮尾暗)。
    // ⚠ 兩張波形貼圖是各自 `new` 出來的,**沒有第二個寫入者** —— 遠山那次
    //   (27b34aa)就是每幀寫共用 singleton 的 map.offset,害切割墊以騎士的速度滑動。
    //
    // 掃描線是**第二片 mesh**('crtBeam'),所以這個世界的日月各多一個 draw call。
    buildCelestialDisc: (body, shellRadius) => {
      // demo:`skyDisc(44, E.p3)` / `skyDisc(30, E.p11)` —— 44 / 30 跟 paper /
      // plastic 的 42 / 34 **刻意不同**(§0.0 第 7 點:刻意的不一致也要寫下來)。
      // 管子比紙圓片大一點、藍磷光的月亮小一點,兩個都是這個世界自己的決定。
      const [demoRadius, phosphor] = body === 'sun'
        ? [44, hex(E.p3)] as const
        : [30, hex(E.p11)] as const;
      const r = celestialDiscRadius(body, shellRadius, demoRadius);
      // ── 屏面 + 刻度格線(靜態,一次畫完) ──
      const c = cv(128, 128);
      const g = c.getContext('2d')!;
      g.fillStyle = hex(E.ink);
      g.beginPath(); g.arc(64, 64, 60, 0, 6.284); g.fill();
      g.save();
      g.beginPath(); g.arc(64, 64, 58, 0, 6.284); g.clip();
      g.strokeStyle = phosphor;
      g.lineWidth = 1;
      g.globalAlpha = 0.22;
      for (let k = -5; k <= 5; k++) {
        if (k === 0) continue;
        const p = 64 + k * 11;
        g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 128); g.stroke();
        g.beginPath(); g.moveTo(0, p); g.lineTo(128, p); g.stroke();
      }
      g.globalAlpha = 0.42;
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(64, 2); g.lineTo(64, 126); g.stroke();
      g.beginPath(); g.moveTo(2, 64); g.lineTo(126, 64); g.stroke();
      // 次刻度:兩條軸上每格再分五小格。少了它,格線只是網格;有了它才是示波器。
      g.lineWidth = 1;
      for (let k = -25; k <= 25; k++) {
        if (k % 5 === 0) continue;
        const p = 64 + k * 2.2;
        g.beginPath(); g.moveTo(p, 60); g.lineTo(p, 68); g.stroke();
        g.beginPath(); g.moveTo(60, p); g.lineTo(68, p); g.stroke();
      }
      g.restore();
      g.strokeStyle = hex(E.alu);
      g.globalAlpha = 0.9;
      g.lineWidth = 5;
      g.beginPath(); g.arc(64, 64, 61, 0, 6.284); g.stroke();
      g.globalAlpha = 1;

      // ── 波形(橫向可重複,靠 offset 滑動) ──
      // 接縫:整數波數 + 步進整除畫布寬(§7.1)。餘輝的梯度每個週期自己歸零,所以
      // 貼圖左右邊界落在同一個相位上,接得起來;每個週期開頭那一下**是回掃**,
      // 示波器本來就長這樣。
      const W = 256, CYC = 4, SEG = 128;
      const tc = cv(W, 128);
      const tg = tc.getContext('2d')!;
      const yAt = (u: number): number => 64 - Math.sin(u * Math.PI * 2 * CYC) * 30;
      tg.strokeStyle = phosphor;
      tg.lineWidth = 3;
      tg.lineCap = 'round';
      for (let k = 0; k < SEG; k++) {
        const u0 = k / SEG, u1 = (k + 1) / SEG;
        const f = (u0 * CYC) % 1;                    // 這一段在自己那個週期裡走到哪
        tg.globalAlpha = 0.18 + 0.82 * (1 - f) * (1 - f);
        tg.beginPath();
        tg.moveTo(u0 * W, yAt(u0));
        tg.lineTo(u1 * W, yAt(u1));
        tg.stroke();
      }
      // 光點:每個週期的頭上一顆,那是電子束現在打到的地方。
      tg.globalAlpha = 1;
      tg.fillStyle = phosphor;
      for (let k = 0; k < CYC; k++) {
        const u = k / CYC;
        tg.beginPath(); tg.arc(u * W, yAt(u), 4, 0, 6.284); tg.fill();
      }

      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      const bt = new THREE.CanvasTexture(tc);
      bt.colorSpace = THREE.SRGBColorSpace;
      bt.wrapS = THREE.RepeatWrapping;
      bt.wrapT = THREE.ClampToEdgeWrapping;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 40),
        new THREE.MeshBasicMaterial({
          map: t, transparent: true, fog: false, depthWrite: false,
        }));
      const beam = new THREE.Mesh(new THREE.CircleGeometry(r * 0.86, 40),
        new THREE.MeshBasicMaterial({
          map: bt, transparent: true, fog: false, depthWrite: false,
        }));
      // demo 的 `beam.position.z = 0.4`,照它的圓盤半徑(44)推到我們的:屏面與掃描
      // 線的距離必須跟著圓盤一起放大,不然在 3000 m 的天球上那 0.4 m 會被深度誤差
      // 吃掉,兩片變成同一個平面而 z-fighting。
      beam.position.z = 0.4 * (r / demoRadius);
      beam.name = 'crtBeam';
      disc.add(beam);
      // sky-and-fog 每幀推這張貼圖的 offset.x(demo 的 dt * 0.35 / dt * 0.22)。
      disc.userData.beam = bt;
      disc.userData.beamSpeed = body === 'sun' ? 0.35 : 0.22;
      return disc;
    },

    // 防靜電泡棉雲:IC 出貨就插在這種粉紅泡棉上,所以它是這個世界「空中飄的一
    // 塊軟東西」最合理的候選(demo)。亂數消費順序與 demo 逐字一致(n → 每塊
    // 的 scale x/y/z → position y/z → rotY),校準檢查靠這個對齊。
    buildCloud: (_index, rand) => {
      const rnd = rand ?? Math.random;
      const geo = trimTemplate('cloudBox', sharedTrim('foam', () => toon({ color: E.foam })), unitBox);
      geo.userData.shared = true;
      const mat = sharedTrim('foam', () => toon({ color: E.foam }));
      const grp = new THREE.Group();
      const n = 3 + Math.floor(rnd() * 3);
      for (let j = 0; j < n; j++) {
        const s = new THREE.Mesh(geo, mat);
        s.scale.set(12 + rnd() * 12, 3.4 + rnd() * 2.6, 9 + rnd() * 8);
        s.position.set((j - n / 2) * 9, (rnd() - 0.5) * 2.2, (rnd() - 0.5) * 6);
        s.rotation.y = (rnd() - 0.5) * 0.3;
        grp.add(s);
      }
      return grp;
    },

    /**
     * **不畫**(`buildRouteBody` 在下面接手)。這一組數字是杜邦線移植之前那條頂替
     * 的緞帶,demo 自己把它退役了:「舊版路線是一條貼在匯流排上的發光緞帶 […]
     * 杜邦線不是布」。留著是因為介面要求每個世界都有一組(兩個世界的路線**就是**
     * 那條緞帶),而且一旦 `buildRouteBody` 被拿掉,這裡就是它退回去的地方。
     */
    routeLine: {
      coreColor: 0x9dfcff,
      coreWidth: 1.4,
      coreOpacity: 0.95,
      glowColor: E.trace,
      glowWidth: 4.0,
      glowOpacity: 0.3,
    },
    // 路線本體 = 一串接龍的杜邦線(demo `buildDupont`)。電流跑在線**裡面**。
    buildRouteBody,
    // 圓片電容的釉色由 instance tint 帶(白色頂點色 × 三色循環);錫腳的頂點色
    // 會跟著乘一次 — 遠看是暗一階的金屬,可接受(積木的線圈樹同一個取捨)。
    tintTreeInstances: true,
    outlineTrees: false,

    /**
     * 近圈 = demo 的 `finMat`(`E.copperFin`),一格沒動。
     *
     * 遠圈 `0xcf8a45` **不在 demo 的調色盤裡**,是移植自己補的,理由跟另外兩個
     * 世界同一條:demo 兩圈共用一個 `finMat`(它的兩圈只差 240 m),gameview 的
     * 兩圈差 **900 m**(1700 / 2600),同色的話兩圈會疊成一坨銅、視差沒有東西可
     * 以差。所以走空氣透視 ——「遠淡近濃」,同色相(Δhue < 8°)只提亮度,跟
     * paper / plastic 的兩圈是同一條規則。這個關係(不是這個值)釘在
     * `[mountain ring vs demo]` 裡。
     *
     * 底筒的 `copperFinDeep` **兩圈共用**,那才是 demo 的原樣:底座是一圈矮牆,
     * 遠圈的那圈幾乎整條躲在近圈後面,沒有兩圈並排比較的機會。
     */
    mountainColor: (layer) => (layer === 'near' ? E.copperFin : 0xcf8a45),

    /**
     * 遠山 = 兩圈散熱鰭片(demo `heatsinkRing`)。造型與比例見
     * `DEMO_HEATSINK_RING` / `FIN_OUTER_LIMIT`;實際的 InstancedMesh 與底筒在
     * `mountain-ring.ts` 的 `buildFinRing`,那裡是 demo 那個函式的抄本。
     *
     * demo 用鰭片是**有理由的**,而且那個理由不是造型偏好:
     *
     * > 散熱片本來就是一片一片、片與片之間有縫的,所以遠一圈的山會自然從近一圈
     * > 的縫裡透出來 —— paper 版為了讓兩圈都看得到,花了很大力氣去調張角(近矮
     * > 遠高),這裡是造型免費附送的。
     *
     * ⚠ 縫是**多的**那一份可見度,不是替代品:兩圈的張角仍然照 §3.6 走
     * (`mountain-ring.ts` 的 NEAR_/FAR_MAX_HEIGHT,三個世界共用),不因為有了縫
     * 就把它改掉。
     */
    mountainRingFins: (layer, radius, maxHeight): MountainRingFins => {
      const o = DEMO_HEATSINK_RING[layer];
      const kR = radius / o.radius;
      const kH = maxHeight / o.maxH;
      return {
        fins: o.fins,
        depth: Math.min(o.depth * kR, Math.max(0, FIN_OUTER_LIMIT - radius)),
        thick: o.thick * kR,
        baseH: o.baseH * kH,
        sink: o.sink * kH,
        baseColor: E.copperFinDeep,
        // demo 的 `finMat = toon({ color: E.copperFin })` /
        // `finBaseMat = toon({ color: E.copperFinDeep, side: DoubleSide })` ——
        // 從**這個世界自己的貨架**拿(§3.8),因為 toon 要的是這個世界的
        // gradientMap,`mountain-ring.ts` 沒有也不該有它。
        //
        // ⚠ 這是 2026-07-28 的決定「circuit 環照 demo 設計」的最後一格,而它有
        // 量過的代價:鰭片除了小小的頂蓋以外每一面都是垂直的,太陽一高 N·L 就塌,
        // 環會往地平線壓黑(`buildStrip` 註解裡的「山裡冒出黑線」)。demo 躲得掉
        // 是因為它的太陽釘死在 47.4°;我們的會擺到 15°,台北正午則超過 80°。
        material: (color, opts) => toon({
          color, side: opts.side, fog: opts.fog,
        }),
      };
    },

    // 散熱鰭片遠山:鰭高「一組一組」等高(同一片散熱片上的鰭是齊的),組間跳變
    // —— 平滑漸變會讀成柵欄不是散熱片(demo heatsinkRing 的 profile + 分組)。
    //
    // ⚠ `((i + run / 2) % segments)` 的 `% segments` 是**移植修掉的一個接縫瑕疵**,
    // 不是筆誤:demo 的 `profile((i + run/2) / o.fins)` 在最後一組會餵進 u > 1,
    // 而它的環狀包繞 `if (d > 0.5) d = 1 - d` 只在 u ∈ [0,1] 正確 —— u > 1 時,
    // 位置小於 u−1 的峰會拿到**負的**距離,`t = 1 - d/w` 因此大於 1,那一組鰭片
    // 被灌高。接縫正好在方位角 0,固定那一格。`% segments` 把 u 收回 [0,1),
    // 是同一個意圖的正確寫法。`[mountain ring vs demo]` 執行 demo 自己的 profile
    // 把這件事量出來,免得下一個人「照 demo 修回去」。
    generateMountainProfile: (_layer, seed, segments) => {
      const rng = mulberry32(seed);
      const peaks: [number, number, number][] = [];
      for (let i = 0; i < 22; i++) peaks.push([rng(), 0.28 + rng() * 0.72, 0.035 + rng() * 0.07]);
      const profileAt = (u: number): number => {
        let h = 0.08;
        for (const [pu, ph, pw] of peaks) {
          let d = Math.abs(u - pu);
          if (d > 0.5) d = 1 - d;
          const t = 1 - d / pw;
          if (t > 0 && ph * t > h) h = ph * t;   // 取 max 不是相加 — 相加會把山谷墊高
        }
        return h;
      };
      const out: number[] = [];
      for (let i = 0; i <= segments;) {
        const run = 4 + Math.floor(rng() * 6);
        const h = profileAt(((i + run / 2) % segments) / segments);
        for (let k = 0; k < run && i <= segments; k++, i++) out.push(h);
      }
      out[out.length - 1] = out[0];   // first == last, the ring contract
      return out;
    },

    // ── Rider & props ──

    // 螢光輪單車(demo, verbatim where it can be):車架是一片挖空的板子,發光
    // 輪圈是市售 LED 輪圈燈的通用造型。刻意避開某部 1982 年電影那台機車的識別
    // 特徵:不做包覆式車身、不拖光帶尾跡(版權節)。
    buildBikeOrnament: (): BikeOrnamentParts => {
      const root = new THREE.Group();
      const lean = new THREE.Group();
      root.add(lean);
      const glowMat = new THREE.MeshBasicMaterial({ color: E.trace, fog: true });
      const glowMat2 = new THREE.MeshBasicMaterial({ color: 0x9dfcff, fog: true });
      const frameTex = new THREE.CanvasTexture(pcbTextures(0xb1ce, true).face);
      frameTex.wrapS = frameTex.wrapT = THREE.RepeatWrapping;
      frameTex.colorSpace = THREE.SRGBColorSpace;
      frameTex.repeat.set(0.12, 0.12);
      const frameMat = toon({ map: frameTex, side: THREE.DoubleSide });
      const tyreMat = toon({ color: 0x14171c });
      const hubMat = metal(E.tin, 140);
      const saddleMat = toon({ color: 0x1b1f26 });
      const goldMat = new THREE.MeshBasicMaterial({ color: E.goldHi });

      const R = 2.1;
      const rimGeo = new THREE.TorusGeometry(R * 0.86, 0.13, 8, 40);
      const tyreGeo = new THREE.TorusGeometry(R, 0.2, 8, 40);
      const boxGeo = new THREE.BoxGeometry(1, 1, 1);
      const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
      const wheels: THREE.Object3D[] = [];
      for (const x of [-2.9, 2.9]) {
        const grp = new THREE.Group();
        grp.add(new THREE.Mesh(rimGeo, glowMat));
        const tyre = new THREE.Mesh(tyreGeo, tyreMat);
        tyre.castShadow = true;
        grp.add(tyre);
        for (let i = 0; i < 4; i++) {
          const sp = new THREE.Mesh(boxGeo, glowMat2);
          sp.scale.set(0.07, R * 1.7, 0.07);
          sp.rotation.z = (i / 4) * Math.PI;
          grp.add(sp);
        }
        const hub = new THREE.Mesh(cylGeo, hubMat);
        hub.scale.set(0.34, 0.5, 0.34);
        hub.rotation.x = Math.PI / 2;
        grp.add(hub);
        grp.position.set(x, R, 0);
        lean.add(grp);
        wheels.push(grp);
      }

      // 車架 = 一片挖空的板子
      const fs = new THREE.Shape();
      fs.moveTo(-3.2, 1.5);
      fs.lineTo(-1.3, 5.5);
      fs.lineTo(2.3, 5.7);
      fs.lineTo(3.2, 1.5);
      fs.lineTo(1.1, 1.0);
      fs.lineTo(-1.1, 1.0);
      fs.closePath();
      const h1 = new THREE.Path();
      h1.moveTo(-2.3, 2.0); h1.lineTo(-1.35, 4.6); h1.lineTo(-0.4, 2.0); h1.closePath();
      const h2 = new THREE.Path();
      h2.moveTo(0.5, 2.0); h2.lineTo(1.35, 4.9); h2.lineTo(2.4, 2.1); h2.closePath();
      fs.holes.push(h1, h2);
      const frame = new THREE.Mesh(
        new THREE.ExtrudeGeometry(fs, { depth: 0.26, bevelEnabled: false }), frameMat);
      frame.position.z = -0.13;
      frame.castShadow = true;
      lean.add(frame);
      // 板子邊緣的一圈金
      const edgeTop = new THREE.Mesh(boxGeo, goldMat);
      edgeTop.scale.set(3.7, 0.1, 0.34);
      edgeTop.position.set(0.5, 5.62, 0);
      lean.add(edgeTop);

      const bar = new THREE.Mesh(cylGeo, hubMat);
      bar.scale.set(0.14, 3.4, 0.14);
      bar.rotation.x = Math.PI / 2;
      bar.position.set(2.3, 5.9, 0);
      lean.add(bar);
      for (const s of [-1, 1]) {
        const grip = new THREE.Mesh(boxGeo, glowMat);
        grip.scale.set(0.42, 0.42, 0.9);
        grip.position.set(2.3, 5.9, 1.45 * s);
        lean.add(grip);
      }
      const saddle = new THREE.Mesh(boxGeo, saddleMat);
      saddle.scale.set(2.0, 0.55, 1.0);
      saddle.position.set(-1.35, 6.1, 0);
      saddle.castShadow = true;
      lean.add(saddle);

      const crank = new THREE.Group();
      crank.position.set(0, 1.9, 0);
      for (const s of [-1, 1]) {
        const arm = new THREE.Mesh(boxGeo, hubMat);
        arm.scale.set(0.16, 1.5, 0.16);
        arm.position.set(0, 0.75 * s, 0.5 * s);
        crank.add(arm);
        const pedal = new THREE.Mesh(boxGeo, glowMat2);
        pedal.scale.set(0.9, 0.16, 0.55);
        pedal.position.set(0, 1.5 * s, 0.75 * s);
        crank.add(pedal);
      }
      lean.add(crank);
      return {
        root, lean, wheels, crank,
        dispose: () => {
          frameTex.dispose();
          disposeGroup(root);
        },
      };
    },

    /**
     * Aerodrome prop: a bare-PCB quadcopter parked on the strip. Not in the
     * demo (it has no aerodrome concept) — built in this world's own grammar
     * instead: crossed board arms with gold edges, a black QFN in the middle,
     * four rotors. Generic multirotor shape, no brand geometry.
     */
    buildPlaneOrnament: (): THREE.Group => {
      const group = new THREE.Group();
      const boardMat2 = toon({ color: E.mask });
      const goldMat = new THREE.MeshBasicMaterial({ color: E.goldHi });
      const black = toon({ color: E.ic });
      const tin = metal(E.tin, 140);
      const propMat = toon({ color: E.icHi, side: THREE.DoubleSide });
      const arm = new THREE.BoxGeometry(9, 0.3, 1.6);
      for (const rot of [Math.PI / 4, -Math.PI / 4]) {
        const a = new THREE.Mesh(arm, boardMat2);
        a.position.y = 1.5;
        a.rotation.y = rot;
        a.castShadow = true;
        group.add(a);
        const edge = new THREE.Mesh(new THREE.BoxGeometry(9.1, 0.08, 1.7), goldMat);
        edge.position.y = 1.66;
        edge.rotation.y = rot;
        group.add(edge);
      }
      const core = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 2.4), black);
      core.position.y = 2.1;
      group.add(core);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const mx = sx * 3.1, mz = sz * 3.1;
          const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.0, 10), tin);
          motor.position.set(mx, 2.1, mz);
          group.add(motor);
          for (const rr of [0, Math.PI / 2]) {
            const blade = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.08, 0.5), propMat);
            blade.position.set(mx, 2.7, mz);
            blade.rotation.y = rr + sx * 0.4;
            group.add(blade);
          }
          const skid = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.5, 0.3), black);
          skid.position.set(mx, 0.75, mz);
          group.add(skid);
        }
      }
      return group;
    },

    /**
     * 終點:掛著電子紙橫幅的四旋翼無人機。The demo has no finish airship (its
     * 32-item list ends at the acrylic case), so this is built from the
     * world's own shelf: a flying bare-PCB drone IS circuitry, and the banner
     * is the same e-paper module every sign in this world uses. The banner
     * TEXT is drawn from `SIGN_GLYPHS` strokes on the canvas — never a system
     * font (§3.7; the other two worlds' airship banners still carry that
     * violation, this one does not). `fog: false` everywhere per the
     * FinishAirshipParts contract.
     */
    buildFinishAirship: (): FinishAirshipParts => {
      const root = new THREE.Group();
      const body = new THREE.Group();
      root.add(body);
      const noFog = <T extends THREE.Material & { fog?: boolean }>(m: T): T => {
        m.fog = false;
        return m;
      };
      const boardMat2 = noFog(toon({ color: E.mask }));
      const goldMat = noFog(new THREE.MeshBasicMaterial({ color: E.goldHi }));
      const black = noFog(toon({ color: E.ic }));
      const tin = noFog(metal(E.tin, 140));
      const blurMat = noFog(new THREE.MeshBasicMaterial({
        color: 0xcfd6dc, transparent: true, opacity: 0.2,
        side: THREE.DoubleSide, depthWrite: false,
      }));

      const props: THREE.Group[] = [];
      const armGeo = new THREE.BoxGeometry(16, 0.5, 2.6);
      for (const rot of [Math.PI / 4, -Math.PI / 4]) {
        const a = new THREE.Mesh(armGeo, boardMat2);
        a.rotation.y = rot;
        body.add(a);
        const edge = new THREE.Mesh(new THREE.BoxGeometry(16.1, 0.12, 2.75), goldMat);
        edge.position.y = 0.3;
        edge.rotation.y = rot;
        body.add(edge);
      }
      const core = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.6, 4.2), black);
      core.position.y = 0.9;
      body.add(core);
      const dot = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.2, 10), noFog(toon({ color: E.icHi })));
      dot.position.set(-1.4, 1.75, -1.4);
      body.add(dot);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const mx = sx * 5.6, mz = sz * 5.6;
          const motor = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 1.6, 10), tin);
          motor.position.set(mx, 1.0, mz);
          body.add(motor);
          const prop = new THREE.Group();
          prop.position.set(mx, 2.0, mz);
          for (const rr of [0, Math.PI / 2]) {
            const blade = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.12, 0.8), noFog(toon({ color: E.icHi, side: THREE.DoubleSide })));
            blade.rotation.y = rr;
            prop.add(blade);
          }
          const blur = new THREE.Mesh(new THREE.CircleGeometry(3.4, 20), blurMat);
          blur.rotation.x = -Math.PI / 2;
          blur.position.y = 0.1;
          prop.add(blur);
          body.add(prop);
          props.push(prop);
        }
      }

      // Banner: e-paper module hung on two FPC ribbons. CanvasTexture, text in
      // SIGN_GLYPHS strokes.
      const bw = 512, bh = 128;
      const canvas = cv(bw, bh);
      const ctx = canvas.getContext('2d')!;
      const drawBanner = (text: string): void => {
        ctx.fillStyle = hex(E.epaper);
        ctx.fillRect(0, 0, bw, bh);
        ctx.strokeStyle = hex(E.ink);
        ctx.lineWidth = 6;
        ctx.strokeRect(3, 3, bw - 6, bh - 6);
        // Zone strip along the bottom (the module board's own mask colour).
        ctx.fillStyle = hex(E.mask);
        ctx.fillRect(6, bh - 16, bw - 12, 10);
        if (!text) return;
        // Geometric stroke text — SIGN_GLYPHS only, plus '.'/'·' as squares.
        const chars = text.toUpperCase().split('');
        const capH = 56, capW = capH * 0.62, adv = capW * 1.3;
        let width = 0;
        for (const ch of chars) width += (ch === ' ' ? adv * 0.6 : adv);
        let x = (bw - width) / 2;
        const cy = bh / 2 - 6;
        ctx.strokeStyle = hex(E.ink);
        ctx.lineWidth = capH * 0.16;
        ctx.lineCap = 'round';
        for (const ch of chars) {
          if (ch === ' ') { x += adv * 0.6; continue; }
          if (ch === '.' || ch === '·' || ch === ':') {
            ctx.fillStyle = hex(E.ink);
            ctx.fillRect(x + capW * 0.4, ch === '·' || ch === ':' ? cy : cy + capH * 0.34, capH * 0.14, capH * 0.14);
            if (ch === ':') ctx.fillRect(x + capW * 0.4, cy - capH * 0.3, capH * 0.14, capH * 0.14);
            x += adv * 0.7;
            continue;
          }
          const segs = SIGN_GLYPHS[ch];
          if (segs) {
            for (const q of segs) {
              ctx.beginPath();
              ctx.moveTo(x + q[0] * capW, cy - capH / 2 + q[1] * capH);
              ctx.lineTo(x + q[2] * capW, cy - capH / 2 + q[3] * capH);
              ctx.stroke();
            }
          }
          // Unknown char: skip (a gap is legible; a wrong glyph is not).
          x += adv;
        }
      };
      drawBanner('');
      const bannerTex = new THREE.CanvasTexture(canvas);
      bannerTex.colorSpace = THREE.SRGBColorSpace;
      const bannerGroup = new THREE.Group();
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(12, 3),
        noFog(new THREE.MeshBasicMaterial({ map: bannerTex, side: THREE.DoubleSide })),
      );
      panel.position.y = -7.4;
      bannerGroup.add(panel);
      const fpc = noFog(toon({ color: E.fpc, side: THREE.DoubleSide }));
      for (const sx of [-4.6, 4.6]) {
        const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 5.4), fpc);
        ribbon.position.set(sx, -3.2, 0);
        bannerGroup.add(ribbon);
      }
      root.add(bannerGroup);

      return {
        root,
        setBannerText: (text: string) => {
          drawBanner(text);
          bannerTex.needsUpdate = true;
        },
        setBannerVisible: (visible: boolean) => { bannerGroup.visible = visible; },
        update: (dt: number, elapsed: number) => {
          for (let i = 0; i < props.length; i++) {
            props[i].rotation.y += dt * (i % 2 ? 26 : -26);
          }
          body.rotation.z = Math.sin(elapsed * 1.7) * 0.02;
          bannerGroup.rotation.z = Math.sin(elapsed * 0.9) * 0.03;
        },
        dispose: () => {
          bannerTex.dispose();
          disposeGroup(root);
        },
      };
    },

    buildStreetLamp: (index = 0) => buildLedLamp(index),

    // 金幣 = CR2032:亮面不鏽鋼,上蓋比下殼小一圈(側面那道摺邊),正極面十字
    // 凸紋(不寫料號 — 那是廠牌資訊)。
    buildCoinMesh: () => {
      const rimMat = metal(0x9aa1ab, 160);
      const topMat = metal(0xdfe4ea, 210);
      topMat.emissive.setHex(0x2a2e33);   // 一點底光,金幣在陰影裡也讀得到
      // 16 面 = demo 的 `unitCyl`(`cyl()` 除非指定 seg === 8 都走它)。
      // demo `makeCoin`:`base` / `top` 走 `cyl()`(cast 開、receive 不開),
      // 十字凸紋走 `box()`(兩個都開)。
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.75, 1.75, 0.75, 16), rimMat);
      base.geometry.rotateX(Math.PI / 2);
      base.castShadow = true;
      const top = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.95, 16), topMat);
      top.geometry.rotateX(Math.PI / 2);
      top.castShadow = true;
      base.add(top);
      // 正極面上的十字凸紋。兩條同幾何同材質,批成一個 instance —— demo 自己
      // 也是這樣收的(`protoParts(makeCoin(), COIN_CAP)`),而金幣是池化的:
      // 一枚多一次 draw call,滿池就是多兩百次。
      const ridge = new THREE.InstancedMesh(new THREE.BoxGeometry(1.7, 0.18, 0.26), rimMat, 2);
      ridge.castShadow = true;
      ridge.receiveShadow = true;
      ridge.rotation.x = Math.PI / 2;    // demo 的 `cell.rotation.x = π/2` 那一層
      const rm = new THREE.Matrix4();
      for (let i = 0; i < 2; i++) {
        ridge.setMatrixAt(i, rm.makeRotationY(i * Math.PI / 2).setPosition(0, 0.5, 0));
      }
      ridge.instanceMatrix.needsUpdate = true;
      base.add(ridge);
      base.userData.isCoin = true;
      return base;
    },

    // Checkpoint = 排針座 + 跳線帽:跳線帽是彩色的,那就是旗子。字直接刻在跳
    // 線帽正面(demo:再掛一塊板等於同一根桿子上兩個東西在搶身分),用的是招
    // 牌那套 glyph 幾何 — 同一個世界只有一種寫字的方式。Fresh materials:
    // CheckpointFlagManager fades opacity onto everything it reaches.
    buildCheckpoint: (color, _index, label) => {
      const group = new THREE.Group();
      const headMat = toon({ color: 0x0e1013 });
      const pinsMat = metal(E.tin, 140);
      const capMat = toon({ color });
      // demo `makeCheckpoint`:每一件都是 `box()`,也就是 (cast, receive) 全開;
      // 針座那四根與跳線帽多寫的一句 `castShadow = true` 在 demo 裡是多餘的。
      // 只有刻在帽面上的字例外 —— 它走 `glyphStrokes`,那裡逐筆 `castShadow =
      // false`(壓在帽面上的 0.1 m 筆畫,影子會落在自己身上),receive 留著。
      const base = new THREE.Mesh(new THREE.BoxGeometry(9, 2.4, 3.4), headMat);
      base.position.y = 1.2;
      base.castShadow = true;
      base.receiveShadow = true;
      group.add(base);
      for (let k = 0; k < 4; k++) {
        const pin = new THREE.Mesh(new THREE.BoxGeometry(0.62, 12, 0.62), pinsMat);
        pin.position.set(-3.3 + k * 2.2, 6, 0);
        pin.castShadow = true;
        pin.receiveShadow = true;
        group.add(pin);
      }
      const jumper = new THREE.Mesh(new THREE.BoxGeometry(5.2, 4.2, 2.6), capMat);
      jumper.position.set(-2.2, 11.4, 0);
      jumper.castShadow = true;
      jumper.receiveShadow = true;
      group.add(jumper);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(5.6, 1.0, 3.0), capMat);
      grip.position.set(-2.2, 13.2, 0);
      grip.castShadow = true;
      grip.receiveShadow = true;
      group.add(grip);
      const text = sanitizeSignText(label ?? '');
      if (text) {
        const strokes = buildStrokeGeometry(signStrokes(4.6, 4.6 / SIGN_RATIO * 2, text), 0.12);
        if (strokes) {
          // 字刻在**迎著騎士**的那一面。`CheckpointFlagManager` 用 demo 的
          // `cp.rotation.y = atan2(p.tx, p.tz)` 把局部 +Z 對到前進方向,騎士從
          // −Z 過來 —— demo 把字放在 +Z(z = 1.42),那面他一路上看不到。
          // ⚠ 三支 demo 只有積木問過這件事(「結果整塊牌子側對騎手」),這裡跟它。
          // rotateY 先把筆畫鏡回來,不然從背面讀是反的。
          strokes.rotateY(Math.PI);
          strokes.translate(-2.2, 11.4, -1.36);
          const silk = toon({ color: E.epaper });
          const glyphs = new THREE.Mesh(strokes, silk);
          glyphs.receiveShadow = true;   // demo glyphStrokes: castShadow=false only
          group.add(glyphs);
        }
      }
      return group;
    },

    /**
     * 電子紙招牌 — 霧面灰白模組、極細黑框、幾何筆畫純黑字,側邊一條 FPC 排線
     * 收回建築;載板阻焊 = 該分區色票,從四周露出一圈。**不發光**(反射式;
     * 這正是它跟輝光管的分工),所以這裡沒有任何材質進夜光集合。
     *
     * `purpose === 'checkpoint'` returns null BY DESIGN: this world's
     * checkpoint text is embossed on the jumper cap itself (see
     * buildCheckpoint) — the demo tried a second plate on the same post and
     * called it what it was, two things fighting over one identity.
     */
    buildSign: (purpose: SignPurpose, text, maxWidth, opts) => {
      if (purpose === 'checkpoint') return null;
      const clean = sanitizeSignText(text);
      const symbol = opts?.symbol ?? null;
      if (!clean && !symbol) return null;
      const w = Math.min(maxWidth, 9.0);        // demo SIGN_W_MAX
      if (w < 3.4) return null;                 // demo SIGN_W_MIN:4 個字排不進規格字高
      const h = w / SIGN_RATIO;
      const zone = opts?.zone ?? 'commercial';

      const group = new THREE.Group();
      const geos: THREE.BufferGeometry[] = [];
      const T = 0.2, MARGIN = 0.22, BEZEL = 0.1;
      /** demo 的 `castShadow = false` + receive 留著 —— 貼在載板正面的那一疊。 */
      const faceLayer = (g: THREE.BufferGeometry, m: THREE.Material): THREE.Mesh => {
        const mesh = new THREE.Mesh(g, m);
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        return mesh;
      };

      const back = new THREE.BoxGeometry(w, h, T);
      geos.push(back);
      // demo `epaperSign`:載板是 `box()`(兩個都開);黑框 / 顯示面 / 字 /
      // 三角 / 排線座 / 排線也都是 `box()`,但每一件緊接著 `castShadow = false`
      // —— 它們是貼在載板正面 0.08–0.1 m 的薄片,自己投影只會在載板上壓一塊
      // 黑。receive 一件都沒關。兩支固定臂沒關(它們離開載板往牆走)。
      const backMesh = new THREE.Mesh(back, signBackMat(zone));
      backMesh.castShadow = true;
      backMesh.receiveShadow = true;
      group.add(backMesh);

      const fw = w - MARGIN * 2, fh = h - MARGIN * 2;
      const bezel = new THREE.BoxGeometry(fw, fh, 0.08);
      bezel.translate(0, 0, T * 0.55);
      geos.push(bezel);
      group.add(faceLayer(bezel, icMat()));
      const panel = new THREE.BoxGeometry(fw - BEZEL * 2, fh - BEZEL * 2, 0.1);
      panel.translate(0, 0, T * 0.62);
      geos.push(panel);
      group.add(faceLayer(panel, epaperMat()));

      const iz = T * 0.62 + 0.09;
      if (symbol) {
        const tri = buildSignTriangleGeometry(h, 0.1);
        tri.translate(0, 0, iz);
        geos.push(tri);
        group.add(faceLayer(tri, epaperRedMat()));
      } else {
        const strokes = buildStrokeGeometry(signStrokes(fw - BEZEL * 2, fh - BEZEL * 2, clean), 0.1);
        if (strokes) {
          strokes.translate(0, 0, iz);
          geos.push(strokes);
          group.add(faceLayer(strokes, inkStrokeMat()));
        }
      }

      // FPC 排線 + 排線座:有它才看得出「這是接在建築上的模組」,不是一片看板。
      const conn = new THREE.BoxGeometry(0.34, h * 0.34, 0.34);
      conn.translate(-(w / 2 + 0.17), -h * 0.14, 0);
      geos.push(conn);
      group.add(faceLayer(conn, icMat()));
      const ribbon = new THREE.BoxGeometry(0.08, h * 0.3, 1.5);
      ribbon.translate(-(w / 2 + 0.17), -h * 0.14, -0.85);
      geos.push(ribbon);
      group.add(faceLayer(ribbon, fpcMat()));
      for (const s of [-1, 1]) {
        const arm = new THREE.BoxGeometry(0.18, 0.18, 0.85);
        arm.translate(s * w * 0.3, h * 0.28, -0.5);
        geos.push(arm);
        const armMesh = new THREE.Mesh(arm, icMat());
        armMesh.castShadow = true;      // demo: `arm` 是 box() 且沒有關掉
        armMesh.receiveShadow = true;
        group.add(armMesh);
      }
      return {
        group,
        width: w,
        height: h,
        // Shared materials are the strategy's to free; only geometry is ours.
        dispose: () => { for (const g of geos) g.dispose(); },
      };
    },

    // 隧道口 = 卡緣連接器:黑膠殼一圈,開口是不受光的深色 — 它代表一個洞,受
    // 光面在太陽照到坡面的那一刻會變淡(interface 的規則)。
    buildTunnelPortal: (width) => {
      const group = new THREE.Group();
      const w = Math.max(5, width * 1.5);
      const h = Math.max(5, w * 0.62);
      const lip = Math.max(0.8, w * 0.12);
      const shell = sharedTrim('tunnelShell', () => toon({ color: 0x0e1013 }));
      const mouthMat = sharedTrim('tunnelMouth', () => new THREE.MeshBasicMaterial({ color: 0x05070a }));
      const goldMat = sharedTrim('tunnelGold', () => new THREE.MeshBasicMaterial({ color: E.goldHi }));
      const top = new THREE.Mesh(new THREE.BoxGeometry(w + lip * 2, lip, 1.2), shell);
      top.position.set(0, h + lip / 2, -0.6);
      group.add(top);
      for (const s of [-1, 1]) {
        const side = new THREE.Mesh(new THREE.BoxGeometry(lip, h, 1.2), shell);
        side.position.set(s * (w + lip) / 2, h / 2, -0.6);
        group.add(side);
        // 卡緣的鍍金手指:洞口兩側一列短金條 — 連接器的識別點。
        for (let i = 0; i < 3; i++) {
          const finger = new THREE.Mesh(new THREE.BoxGeometry(lip * 0.5, h * 0.14, 0.1), goldMat);
          finger.position.set(s * (w + lip) / 2, h * (0.25 + i * 0.25), 0.02);
          group.add(finger);
        }
      }
      const mouth = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mouthMat);
      mouth.position.set(0, h / 2, -1.1);
      group.add(mouth);
      return group;
    },

    buildBuildingBody: (box, seed, zone) => {
      switch (circuitKind(zone, seed, box.height)) {
        case 'commercial': return nixieBody(box, seed);
        case 'industrial': return xformerBody(box, seed);
        case 'school': return dipBody(box, seed, false);
        case 'hospital': return dipBody(box, seed, true);
        case 'landmark': return tubeBody(box, seed);
        default: return capBody(box, seed);
      }
    },

    /*
     * `buildBuildingLights` is NOT declared here, and that is the demo's answer.
     *
     * `plan/circuit-town-demo.html` emits no light quads at all. Its `lights`
     * list is `{ kind: 'led' | 'lamination' | 'inline' }` — declarations the
     * renderer turns into GEOMETRY (an indicator LED, a lamination slit) or
     * skips entirely ('inline' = 「燈已經是本體的一部分」). All six buildings
     * light a part they already have, through `EMISSIVE_PARTS`:
     *
     *   residential 電解電容   capRingMat     捲邊溝槽的環形光
     *   commercial  輝光管     nixieLitMat    通電的數字(+ nixieHaloMat 的暈)
     *   industrial  變壓器     laminationMat  疊層縫透出的暖光 → 已在 decoration
     *   school      黑塑封 DIP dipWinMat      引腳根部的那一排窗 → 見 decoration
     *   hospital    白陶瓷 DIP ledRedDieMat   旁邊那顆紅 LED    → 已在 decoration
     *   landmark    真空管     filamentMat    燈絲
     *
     * The DIP's pin-root windows were the one thing that came across as quads,
     * drawn with the generic facade template — a fixed `BoxGeometry(1.0, 0.55,
     * 0.16)` where the demo builds `box(step * 0.42, h * 0.2, 0.16, dipWinMat)`
     * INSIDE `dipIC()`. They are part of the body, so they are now built where
     * the rest of the body's own-material parts are built, at the demo's size.
     */

    /**
     * Trim — the parts that need their OWN material: glass envelopes, every
     * glowing element, and the metal (pins / solder / grids). All instanced
     * off unit templates so the chunk merger batches them per material.
     */
    buildBuildingDecoration: (box, seed, zone) => {
      const kind = circuitKind(zone, seed, box.height);
      const group = new THREE.Group();

      if (kind === 'residential') {
        const L = capLayout(box, seed);
        // 捲邊溝槽的環形光:一圈細環 —— 不是窗戶、不是光柱,是罐子通電的樣子。
        // **y 是 demo 的 h + 0.36**,也就是套管頂(footH + h)往下 0.24:捲邊
        // 是鋁罐翻捲壓住橡膠塞的那一道溝,它在頂蓋**底下**。曾經寫成
        // `footH + h + 0.36`(往上 0.36),那讓半徑 0.93r 的環整個埋進半徑
        // 0.98r 的鋁蓋裡 —— 住宅區唯一的一盞燈在畫面上是不存在的。
        // demo `electrolyticCap`: `ring.castShadow = false` — 一圈 0.12 m 的細
        // 環貼在鋁蓋底下,影子只會在自己的罐身上畫一道假的接縫。
        trimBatch(group, 'unitCapRing', capRingMat(), unitCapRing, 1, (mesh) => {
          const r = L.r * 0.93;
          const tube = Math.max(0.12, L.r * 0.055);
          setInstance(mesh, 0, r, r, tube / CAP_RING_TUBE,
            0, L.footH + L.h - 0.24, 0, Math.PI / 2, 0, 0);
        }, false, false);
        return placeTrim(box, group);
      }

      if (kind === 'commercial') {
        const L = nixieLayout(box, seed);
        const put = (a: number, b: number): [number, number] => onAxis(L.along, a, b);
        const yaw = frameYaw(L.along);
        // 管座的一圈焊接腳
        const lugs = L.tubes * 3;
        trimBatch(group, 'unitBox', pinMat(), unitBox, lugs * 2, (mesh) => {
          let n = 0;
          for (let i = 0; i < lugs; i++) {
            for (const s of [-1, 1]) {
              const a = -L.sw / 2 + 0.8 + i * ((L.sw - 1.6) / Math.max(1, lugs - 1));
              const [x, z] = put(a, s * (L.sd / 2 - 0.35));
              setInstance(mesh, n++, 0.36, L.LUG, 0.36, x, L.LUG / 2, z, 0, yaw, 0);
            }
          }
        // demo: `lug = box(0.36, LUG, 0.36, pinMat)` — 它們站在板子上,是這棟
        // 樓唯一碰得到板面的東西。
        }, true, true);
        // 玻璃管身 + 圓頂
        trimBatch(group, 'unitCyl', glassMat(), unitCyl, L.tubes, (mesh) => {
          for (let i = 0; i < L.tubes; i++) {
            const c = (i - (L.tubes - 1) / 2) * L.pitch;
            const [x, z] = put(c, 0);
            setInstance(mesh, i, L.r, L.bodyH, L.r, x, L.y0 + 1.2 + L.bodyH / 2, z);
          }
        // demo: `glass.castShadow = false` — 玻璃投出來是一塊實心的黑。
        }, false, false);
        trimBatch(group, 'unitHemi', glassMat(), unitHemi, L.tubes, (mesh) => {
          for (let i = 0; i < L.tubes; i++) {
            const c = (i - (L.tubes - 1) / 2) * L.pitch;
            const [x, z] = put(c, 0);
            setInstance(mesh, i, L.r, L.r, L.r, x, L.y0 + 1.2 + L.bodyH, z);
          }
        // demo: `cap.castShadow = false`,同一個理由。
        }, false, false);
        // 疊起來的數字陰極:最前面那個通電發光,後面的是暗的金屬(識別點:
        // 玻璃管裡疊著一整組數字,同時只有一個亮)。七段用 unitBox 條段近似。
        const SEG: readonly (readonly number[])[] = [
          [1, 1, 1, 1, 1, 1, 0], [0, 1, 1, 0, 0, 0, 0], [1, 1, 0, 1, 1, 0, 1],
          [1, 1, 1, 1, 0, 0, 1], [0, 1, 1, 0, 0, 1, 1], [1, 0, 1, 1, 0, 1, 1],
          [1, 0, 1, 1, 1, 1, 1], [1, 1, 1, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1, 1],
          [1, 1, 1, 1, 0, 1, 1],
        ];
        const segsOf = (d: number): number => SEG[d % 10].reduce((a, b) => a + b, 0);
        // 每管自己一組數字(見 `nixieLayout`),所以段數要逐管加起來,不能拿
        // 一管的段數乘管數。
        let litCount = 0, darkCount = 0;
        for (let i = 0; i < L.tubes; i++) {
          litCount += segsOf(L.digits[i][0]);
          for (let k = 1; k < 3; k++) darkCount += segsOf(L.digits[i][k]);
        }
        const t = 0.34;
        const emitDigit = (
          mesh: THREE.InstancedMesh, n0: number, tubeC: number, digit: number,
          scale: number, depth: number,
        ): number => {
          const s = SEG[digit % 10];
          const dw = L.dw * scale, dh = L.dw * 1.6 * scale;
          const hh = dh / 2;
          const parts: [number, number, number, number][] = [];
          if (s[0]) parts.push([0, hh, dw, t]);
          if (s[1]) parts.push([dw / 2, hh / 2, t, hh]);
          if (s[2]) parts.push([dw / 2, -hh / 2, t, hh]);
          if (s[3]) parts.push([0, -hh, dw, t]);
          if (s[4]) parts.push([-dw / 2, -hh / 2, t, hh]);
          if (s[5]) parts.push([-dw / 2, hh / 2, t, hh]);
          if (s[6]) parts.push([0, 0, dw, t]);
          let n = n0;
          for (const [px, py, sw2, sh2] of parts) {
            // 段條沿長軸排、面向 across —— 而且是**整個框轉過去**,不是把寬深
            // 對調:七段的字形有左右(b 在右上、e 在左下),對調過的框會把「2」
            // 畫成鏡像的「S」。
            const [x, z] = put(tubeC + px, depth);
            setInstance(mesh, n++, sw2, sh2, t, x, L.dy + py, z, 0, yaw, 0);
          }
          return n;
        };
        trimBatch(group, 'unitBox', nixieLitMat(), unitBox, litCount, (mesh) => {
          let n = 0;
          for (let i = 0; i < L.tubes; i++) {
            const c = (i - (L.tubes - 1) / 2) * L.pitch;
            n = emitDigit(mesh, n, c, L.digits[i][0], 1, L.r * 0.42);
          }
        // demo `nixieDigit`:每一段都是 `box()` 再 `b.castShadow = false`,所以
        // 是 (false, TRUE) —— **不是** (false, false)。receive 留著是有意義的:
        // 段條在玻璃管**裡面**,管子上方的屏極/柵極本來就會落影在它身上。
        }, false, true);
        // 亮著的數字前面那片暈:demo 的 `glowQuad`,scale dw*3.4、深度再往外
        // 0.5。整個 chunk 的暈會被合成器收成**一個** draw call(合成是照
        // (template, material) 分桶的),所以一支管子一片是負擔得起的。
        trimBatch(group, 'unitQuad', nixieHaloMat(), unitQuad, L.tubes, (mesh) => {
          const hw = L.dw * 3.4;
          for (let i = 0; i < L.tubes; i++) {
            const c = (i - (L.tubes - 1) / 2) * L.pitch;
            const [x, z] = put(c, L.r * 0.42 + 0.5);
            setInstance(mesh, i, hw, hw, 1, x, L.dy, z, 0, yaw, 0);
          }
          mesh.renderOrder = 12;
        // demo: `halo.castShadow = false`,receive 也沒開 —— 加色的暈是光,
        // 不是物體。
        }, false, false);
        trimBatch(group, 'unitBox', cathodeMat(), unitBox, darkCount, (mesh) => {
          let n = 0;
          for (let i = 0; i < L.tubes; i++) {
            const c = (i - (L.tubes - 1) / 2) * L.pitch;
            for (let k = 1; k < 3; k++) {
              // 越後面的畫得越大一點點 — 從輪廓邊緣露出來,「疊了好幾個」才成立。
              n = emitDigit(mesh, n, c, L.digits[i][k], 1 + k * 0.11, L.r * 0.42 - k * 0.52);
            }
          }
        // 同上:暗的那兩層數字也是 `box()` + castShadow=false。
        }, false, true);
        return placeTrim(box, group);
      }

      if (kind === 'industrial') {
        const L = xformerLayout(box, seed);
        // `hand = -1` — 跟 `xformerBody` 同一個理由(demo 的變壓器沒轉 90°)。
        const put = (a: number, b: number): [number, number] => onAxis(L.along, a, b, -1);
        const yaw = frameYaw(L.along, -1);
        // 端子:一排錫腳(朝一側)
        trimBatch(group, 'unitBox', pinMat(), unitBox, 4, (mesh) => {
          for (let i = 0; i < 4; i++) {
            const [x, z] = put(-L.D * 0.34 + i * (L.D * 0.68 / 3), L.W * 0.6);
            setInstance(mesh, i, 0.42, 0.9, 0.42, x, 0.45, z, 0, yaw, 0);
          }
        // demo `transformer`: `t = box(0.42, 0.9, 0.42, pinMat)`.
        }, true, true);
        // 看得見的幾圈銅線(繞在線圈上)
        trimBatch(group, 'unitTorus', copperMat(), unitTorus, 4, (mesh) => {
          for (let i = 0; i < 4; i++) {
            const a = -L.coilL * 0.32 + i * (L.coilL * 0.64 / 3);
            const [x, z] = put(a, 0);
            const r = L.Rc * 1.05;
            // 環面的軸是它的 local +z,而 demo 的銅圈軸 = 疊層方向 = 長軸,所以
            // 基準是 +π/2(+z → +x),再疊上這個框自己的 yaw。
            setInstance(mesh, i, r, r, r, x, L.cy, z, 0, Math.PI / 2 + yaw, 0);
          }
        // demo: `ring.castShadow = true` on the visible copper turns, and
        // nothing about receiving — a 0.06 m torus wrapped on the coil.
        }, true, false);
        // 疊層縫的暖光:隔一片一道、只取中段,避開鋼帶夾(demo)。
        const slits: number[] = [];
        for (let i = 2; i < L.n - 1; i += 2) slits.push(-L.D / 2 + L.th * i);
        trimBatch(group, 'unitBox', laminationMat(), unitBox, slits.length * 2, (mesh) => {
          let n = 0;
          for (const a of slits) {
            for (const s of [-1, 1]) {
              const [x, z] = put(a, s * (L.W / 2 + 0.04));
              setInstance(mesh, n++, Math.min(0.42, L.th * 0.5), L.coreH * 0.34, 0.08,
                x, L.baseH + L.coreH * 0.52, z, 0, yaw, 0);
            }
          }
        // demo `addBuildingLights`(kind 'lamination'):`b = box(...)` 再
        // `b.castShadow = false` → (false, TRUE)。那是縫裡漏出來的光,不是一塊
        // 站在外面的板子,所以不投影;但它嵌在疊層之間,還是收得到影子。
        }, false, true);
        return placeTrim(box, group);
      }

      if (kind === 'school' || kind === 'hospital') {
        const L = dipLayout(box, seed);
        const put = (a: number, b: number): [number, number] => onAxis(L.along, a, b);
        const yaw = frameYaw(L.along);
        const pm = kind === 'hospital' ? goldPinMat() : pinMat();
        // 腳:knee(轉出)+ drop(落地),兩側各一排 — DIP 最好認的特徵。
        trimBatch(group, 'unitBox', pm, unitBox, L.n * 4, (mesh) => {
          let n = 0;
          const out = 0.9;
          for (const s of [-1, 1]) {
            for (let i = 0; i < L.n; i++) {
              const a = -L.w / 2 + 1.2 + i * L.step;
              const [kx, kz] = put(a, s * (L.d / 2 + out / 2 - 0.05));
              setInstance(mesh, n++, 0.34, 0.34, out, kx, L.pinY, kz, 0, yaw, 0);
              const [dx2, dz2] = put(a, s * (L.d / 2 + out));
              setInstance(mesh, n++, 0.34, L.pinY, 0.34, dx2, L.pinY / 2, dz2, 0, yaw, 0);
            }
          }
        // demo `legRow`:`knee` 與 `drop` 都是 `box()` —— DIP 最好認的特徵,
        // 而且是這棟樓唯一從板面站起來的東西。
        }, true, true);
        // 引腳根部的那一排窗。**demo 把它畫在 `dipIC()` 本體裡**,不是事後蓋上去
        // 的網格:`box(step * 0.42, h * 0.2, 0.16, dipWinMat)`,位置
        // `(-w/2 + 1.2 + i*step, pinY + h*0.14, s*(d/2 + 0.08))`,逐字照抄。
        // 節奏不用發明 —— **那排腳本來就是等距的**,窗只是把它們接進封裝的那一點
        // 畫出來;夜裡亮的是引腳(金屬)接到板子的光,所以顏色跟著板子走(冷青白,
        // `dipWinMat` 進 `nightLit`),不是招牌的暖橘。
        //
        // 這裡以前是空的,窗走 `buildBuildingLights` + `facadeWindows` 的模板 ——
        // 一塊全世界共用的 `BoxGeometry(1.0, 0.55, 0.16)`,而 demo 的窗高是
        // `h * 0.2`(24 m 的 DIP 上是 4.8 m,不是 0.55)。模板沒有尺寸的管道,
        // 而根本問題是那個模板不該存在。
        trimBatch(group, 'unitBox', dipWinMat(), unitBox, L.n * 2, (mesh) => {
          let n = 0;
          for (const s of [-1, 1]) {
            for (let i = 0; i < L.n; i++) {
              const a = -L.w / 2 + 1.2 + i * L.step;
              const [wx, wz] = put(a, s * (L.d / 2 + 0.08));
              setInstance(mesh, n++, L.step * 0.42, L.h * 0.2, 0.16,
                wx, L.pinY + L.h * 0.14, wz, 0, yaw, 0);
            }
          }
        // demo:`win.castShadow = false` —— 一片貼在封裝側面的薄窗,它整片坐在
        // 自己的本體上。receive 也不開(demo 的 `box()` 只被 `castShadow = false`
        // 覆寫了一半?不是 —— 它走 `box()` 開兩個,再明寫關掉 cast)。
        }, false, true);
        // 焊錫圓角:每隻腳的落點一顆 — 焊點會**反光**,不會發光(solderMat 的
        // emissive 一路 #000000,不進發光集合)。
        trimBatch(group, 'unitCyl8', solderMat(), unitCyl8, L.n * 2, (mesh) => {
          let n = 0;
          for (const s of [-1, 1]) {
            for (let i = 0; i < L.n; i++) {
              const a = -L.w / 2 + 1.2 + i * L.step;
              const [x, z] = put(a, s * (L.d / 2 + 0.9));
              setInstance(mesh, n++, 0.44, 0.36, 0.44, x, 0.18, z);
            }
          }
        // demo `legRow(sol=true)`:`fillet.castShadow = false` —— 焊點是腳底下
        // 那一小顆,它整個坐在腳自己的影子裡。
        }, false, false);
        if (kind === 'hospital') {
          // 這一區唯一會發光的是旁邊那顆紅 LED — 白陶瓷本身不發光。
          // demo `hospitalDip` 的 lights: `{ kind: 'led', x: 0, y: dim.h +
          // DIP_LIFT + 0.4, z: 0, s: 1.5 }`,而 `indicatorLed(s)` 就是
          // `ledBody(0.56 * s)` → 0.56 × 1.5 = **0.84**。
          const led = ledBody(0.84, ledRedMat(), ledRedDieMat(), ledCupMat());
          for (const geo of led.owned) geo.userData.shared = false;
          led.group.position.set(0, L.h + L.LIFT + 0.4, 0);
          // LED 自己是**有手性的**(削平的負極在 −x、高的那片導線架在 −x、矮的
          // 在 +x),而 demo 把它**不旋轉**地放進 `longDip` 的 wrap 框裡 —— 那個
          // 框的 +x 是 across。`onAxis` 的 along='z' 分支就是那個框,along='x'
          // 分支是它繞 y 轉 −90°,所以 LED 也要跟著轉,否則半數醫院的 LED 剪影
          // 是另一個方向的(那顆晶粒杯會從側面看不見)。
          led.group.rotation.y = yaw - Math.PI / 2;
          group.add(led.group);
        }
        return placeTrim(box, group);
      }

      // landmark: vacuum tube
      const L = tubeLayout(box, seed);
      // 管座的一圈焊接腳
      trimBatch(group, 'unitBox', pinMat(), unitBox, 8, (mesh) => {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          setInstance(mesh, i, 0.42, L.LUG, 0.42,
            Math.cos(a) * L.R * 1.12, L.LUG / 2, Math.sin(a) * L.R * 1.12, 0, -a, 0);
        }
      // demo `vacuumTube`: `lug = box(0.42, LUG, 0.42, pinMat)`.
      }, true, true);
      // 玻璃泡:圓柱 + 半球頂
      trimBatch(group, 'unitCyl', glassMat(), unitCyl, 1, (mesh) => {
        setInstance(mesh, 0, L.R, L.bodyH, L.R, 0, L.y0 + L.bodyH / 2, 0);
      // demo: `glass.castShadow = false` / `top.castShadow = false`.
      }, false, false);
      trimBatch(group, 'unitHemi', glassMat(), unitHemi, 1, (mesh) => {
        setInstance(mesh, 0, L.R, L.R, L.R, 0, L.y0 + L.bodyH, 0);
      }, false, false);
      // 燈絲:屏極底下那一段,夜裡發暖橘光(kind='inline' 的那盞)。
      trimBatch(group, 'unitBox', filamentMat(), unitBox, 2, (mesh) => {
        for (const [i, s] of [-1, 1].entries()) {
          setInstance(mesh, i, 0.32, L.bodyH * 0.1, 0.32, s * L.R * 0.3, L.fy, 0);
        }
      // demo: `f = box(...)` 再 `f.castShadow = false` → (false, TRUE)。
      }, false, true);
      trimBatch(group, 'unitCyl8', filamentMat(), unitCyl8, 1, (mesh) => {
        setInstance(mesh, 0, L.R * 0.44, 0.45, L.R * 0.44, 0, L.fy - L.bodyH * 0.05, 0);
      // demo: `fb = cyl(...)` 再 `fb.castShadow = false` → (false, false)。
      // `cyl()` 本來就沒開 receive,所以這一對跟上面那一批不同 —— 兩件挨在一起、
      // 同一份材質,旗標卻不一樣,而 batch key 吃旗標,所以它們本來就是兩批。
      }, false, false);
      // 柵極:屏極外一圈細螺旋(一疊微傾的細圈近似 — 真螺旋要 per-instance 幾何)。
      trimBatch(group, 'unitTorusThin', gridMat(), unitTorusThin, 9, (mesh) => {
        const gr = L.R * 0.93;
        for (let i = 0; i < 9; i++) {
          setInstance(mesh, i, gr, gr, gr, 0, L.y0 + L.bodyH * (0.31 + i * 0.54 / 8), 0,
            Math.PI / 2 + 0.05, 0, 0);
        }
      // demo: 九圈細絲是 `new THREE.Mesh(unitTorusThin, gridMat)`,兩個旗標都
      // 沒碰過 —— 沒有經過 `box()`/`cyl()`,所以是 three 的預設 (false, false)。
      }, false, false);
      // 繞柵極的那兩根支撐柱(demo:`box(0.3, bodyH*0.6, 0.3, gridMat)` 站在
      // ±gr 上)。整組**曾經整個掉了** —— 少了它那九圈細絲是浮在管子裡的,
      // 「柵極」讀不出來(§0.0 的杯口環同一類:被讀懂、被重寫、然後被漏掉)。
      trimBatch(group, 'unitBox', gridMat(), unitBox, 2, (mesh) => {
        const gr = L.R * 0.93;
        for (const [i, s] of [-1, 1].entries()) {
          setInstance(mesh, i, 0.3, L.bodyH * 0.6, 0.3, s * gr, L.y0 + L.bodyH * 0.58, 0);
        }
      // demo: `rod = box(...)` 再 `rod.castShadow = false` → (false, TRUE)。
      }, false, true);
      // 吸氣劑鏡面(getter flash):玻璃頂端的銀斑 — 一眼認出真空管的那個點,
      // 畫在玻璃外緣(內側會被 45% 的玻璃壓掉一半亮度)。
      trimBatch(group, 'unitGetterCap', getterMat(), unitGetterCap, 1, (mesh) => {
        const r = L.R * 1.008;
        setInstance(mesh, 0, r, r, r, 0, L.y0 + L.bodyH, 0);
      // demo: `getter = new THREE.Mesh(getterCapGeo, getterMat)` — 沒碰旗標。
      }, false, false);
      trimBatch(group, 'unitCyl', getterMat(), unitCyl, 1, (mesh) => {
        const r = L.R * 1.008;
        setInstance(mesh, 0, r, L.bodyH * 0.1, r, 0, L.y0 + L.bodyH * 0.95, 0);
      // demo: `flashRing = cyl(R * 1.008, bodyH * 0.1, getterMat)` —— 走 `cyl()`
      // 而且**沒有**被關掉,所以它是 (TRUE, false)。這一圈在玻璃**外緣**
      // (R×1.008,demo 特地寫過為什麼不畫在內側),所以它是真的擋得住光的一
      // 圈銀 —— 跟它上面那頂同材質的球冠不同,球冠沒經過 `cyl()`。
      }, true, false);
      return placeTrim(box, group);
    },

    /*
     * `facadeWindows` USED TO BE HERE — a 6 × 5 m grid whose template was a
     * fixed `BoxGeometry(1.0, 0.55, 0.16)` in `dipWinMat`. It served two jobs
     * and got both wrong: it stamped windows on any footprint with no themed
     * body, AND it was what actually drew the school's declared pin-root
     * windows, at 1.00 × 0.55 m where the demo builds 0.98 × 1.45 m for the
     * same DIP. There is no channel for a size in a shared template, and the
     * reason there is no channel is that the template should not exist.
     * Deleted with the mechanism; the windows are now `dipIC`'s own boxes.
     */

    // ── Geometry hooks ──
    quantizeElevation: (absEle) => quantizeToLayer(absEle, params),

    // 圓片陶瓷電容樹:壓扁的鏡片形圓片(沾出來的,不是車出來的 — 側面轉過來還
    // 有厚度,做成薄片的話 rotation.y 一轉就有一半的樹變成一條線)+ 兩隻錫腳。
    buildTreeGeometry: () => {
      const m = new CircuitMass();
      // demo `discCapTree(kind, s)`,逐件照抄(s = 1;每棵樹的大小由 instance
      // 矩陣給)。圓片是 `unitSphere` **壓扁**的球 —— 不是兩個淺錐拼的鏡片:
      // 圓片電容是沾出來的,球在側面轉過來時的厚度就是它;拼出來的鏡片邊緣是
      // 一圈硬折,而且 12 段對上 demo 的 14×10 少了一個量級的輪廓。
      // 圓片:白色頂點色 — instance tint 帶三色釉(treeCanopyColors)。
      const sphere = new THREE.SphereGeometry(1, 14, 10);
      m.paint(0xffffff);
      m.merge(sphere, new THREE.Matrix4()
        .makeScale(3.4, 3.4, 1.5).setPosition(0, 6.2, 0));
      sphere.dispose();
      // 兩隻腳(微外八 —— demo `leg.rotation.z = -sd * 0.06`;`block()` 只轉
      // yaw,所以走 merge)
      const leg = new THREE.BoxGeometry(0.3, 6.6, 0.3);
      m.paint(E.tin);
      for (const sd of [-1, 1]) {
        m.merge(leg, new THREE.Matrix4()
          .makeRotationZ(-sd * 0.06).setPosition(sd * 1.1, 3.3, 0));
      }
      leg.dispose();
      return m.geometry();
    },

    /**
     * 五格地被會站起來的東西 —— demo 的 `LU_STYLE.props(kind, ctx)`,逐件照抄。
     *
     * ctx 的對照:demo 的 `cx / cz / r / rng` 就是這裡的
     * `centerX / centerZ / radius / rng`;demo 的
     * `top(x, z) = geoGroundY(x, z) + LU_H[kind]` 是 **`ctx.slabY`**。
     *
     * ⚠ 這一步不是「把 demo 的公式抄短」,是兩邊的地被本來就不一樣:demo 的
     *   `luSlab` 是**貼著地面鋪**的(逐頂點取自己的地面高度),因為它的走廊是平滑
     *   的一張帶子;gameview 的 slab 是一片**平板**,高度取「這一環最低的 DEM 取樣
     *   再 floor 到量化階」。所以在這一側,道具腳下唯一正確的高度就是那片平板本身
     *   ——重新取一次 DEM 會讓腳落在它站的那張墊子上面或下面一階。
     *
     * gameview 會拿九格都來問(water / park / forest / urban 也在內),demo 那支
     * 對不認得的 kind 是 `throw`,這裡改成回 null —— 「這一格不站東西」在這個
     * 介面上本來就是合法答案,而且是多數。
     */
    buildLanduseProps: (ctx) => {
      const { kind, centerX: cx, centerZ: cz, radius: r, rng } = ctx;
      const top = ctx.slabY;
      const group = new THREE.Group();

      if (kind === 'farmland') {
        // **上限 9 株**(3×3)。一株是 `ledBody` 的 8 個 mesh,9 株 = 72 個,但
        // 全部走共用材質 → `luHarvest` 一次併成 6 份幾何,draw call 是 6 不是 72。
        // 台北一個 3×3 圖磚窗口只有 13 塊農田(amalfi 23 塊),所以真正該省的是
        // draw call 不是頂點數。太小的地不種 —— 三株擠在一起讀不出行列。
        if (r < 7) return null;
        for (let i = -1; i <= 1; i++) {
          for (let j = -1; j <= 1; j++) {
            // 貼圖上孔在 x ≡ 1 (mod 2)、銅條中心在 z ≡ 2 (mod 4)(uv 是世界公尺),
            // 所以 snap 過去苗就真的長在孔裡,而且跨 chunk 對得上。
            // (gameview 的 world uv 是 `(x, north)` = `(x, −z)`,demo 是 `(x, z)`
            //  —— 兩道格點的相位在 mod 4 下對稱於 2,所以同一個 snap 兩邊都對。)
            const x = luSnap(cx + i * 6 + (rng() - 0.5) * 1.4, 2, 1);
            const z = luSnap(cz + j * 8 + (rng() - 0.5) * 1.4, 4, 2);
            if (Math.hypot(x - cx, z - cz) > r * 0.62) continue;
            const led = ledBody(0.62, luCropLensMat(), cathodeMat(), ledCupMat());
            led.group.position.set(x, top + 0.1, z);
            group.add(led.group);
          }
        }
        return luHarvest(group);
      }

      if (kind === 'wetland') {
        // **上限 16 支蘆葦**(最多 4 叢 × 4 支)。叢生、不成行 —— 這一格的
        // 「不規則」跟農田的「規則行列」是同一條軸的兩端,排整齊就前功盡棄。
        //
        // 蘆葦 = **未剪腳的元件引腳**:手焊的板子翻過來就是一片沒剪的腳。頂上
        // 沾一顆長條的錫 = 香蒲的穗。細長不是圓球 —— 圓球會讀成路燈的頭。
        if (r < 5) return null;
        let left = 16;
        const clumps = 2 + Math.floor(rng() * 3);
        // 散佈半徑**夾在 30 m**:真的 MVT 濕地可以是一整片保育區(半徑幾百公尺),
        // 照 r 撒出去就是十六支互相看不到的針。上限是「十六支」不是「密度」,所以
        // 要把它們留在同一個看得完的範圍裡。
        const spread = Math.min(r, 30);
        for (let c = 0; c < clumps && left > 0; c++) {
          const a = rng() * Math.PI * 2, rad = spread * (0.2 + rng() * 0.55);
          const bx = cx + Math.cos(a) * rad, bz = cz + Math.sin(a) * rad;
          const stems = Math.min(left, 3 + Math.floor(rng() * 2));
          left -= stems;
          for (let s = 0; s < stems; s++) {
            // 叢要**擠**(±1.2 m)。散開到 ±1.7 m 時每一支都是孤立的一根,讀成
            // 「插了幾根針」而不是「一叢蘆葦」—— 叢生是這一格「不規則」的載體。
            const x = bx + (rng() - 0.5) * 2.4, z = bz + (rng() - 0.5) * 2.4;
            const h = 3.0 + rng() * 2.0, y0 = top;
            const stem = luBox(0.2, h, 0.2, pinMat());
            stem.position.set(x, y0 + h / 2, z);
            stem.rotation.z = (rng() - 0.5) * 0.3;
            stem.rotation.x = (rng() - 0.5) * 0.3;
            stem.castShadow = false;
            group.add(stem);
            const head = luCyl(0.34, 1.15, solderMat(), 8);
            head.position.set(x, y0 + h + 0.5, z);
            head.castShadow = false;
            group.add(head);
          }
        }
        return luHarvest(group);
      }

      if (kind === 'sports') {
        // **上限 0**。球場是「平的,只有線」—— 那是 B 軸的一端,不是還沒做完。
        // 投射燈也不做成燈桿:一加桿子它就跟遊樂場一樣「有結構」,兩格就撞號了,
        // 而且台北一個圖磚窗口 512 塊球場 × 4 支燈桿是 draw call 自殺。
        // 它的燈住在材質裡(`createSportsFieldMaterial` 的 emissiveMap)。
        return null;
      }

      if (kind === 'playground') {
        // **上限 3 件**,而且一種各一件:溜滑梯 / 蹺蹺板 / 旋轉盤,共 13 個 mesh。
        // 五格裡只有這一格可以站高 —— §3.4 說掠角下它唯一活得下來的訊號是剪影,
        // 所以滑梯的頂端拉到 5.3 m(騎士眼高 6.3 m),它會切在天際線上。
        // 太小的地不擺:三件擠在一起會讀成一坨零件。
        if (r < 6) return null;
        const yaw = rng() * Math.PI * 2;
        const put = (obj: THREE.Object3D, ox: number, oz: number): void => {
          const x = cx + Math.cos(yaw) * ox - Math.sin(yaw) * oz;
          const z = cz + Math.sin(yaw) * ox + Math.cos(yaw) * oz;
          obj.position.set(x, top, z);
          obj.rotation.y = yaw;
          group.add(obj);
        };

        // 溜滑梯 = **板邊金手指卡**斜插進麵包板。滑道就是那排鍍金的金手指 ——
        // 一片斜著的板,本來就是滑梯的形狀。提案的「斜插的散熱鰭片」駁回:鰭片
        // 是這個世界的**遠山**(`mountainRingFins`,兩圈),同一個零件不能再當
        // 滑梯(§3.3)。高端加一支梯架 + 三道橫桿,剪影才讀得出「一邊爬上去、
        // 一邊滑下來」。
        //
        // 卡的材質就是板子的切邊 `fr4EdgeMat(0)`(demo 的 `edgeMat`,同一個實例
        // ——同一種零件只能有一份做法)。它的 u 尺度走 gameview 的 `WALL_U_METERS`
        // 而不是 demo 的 0.06,那是這個檔案早就記錄在案的偏離(見 `sideWall`)。
        const slide = new THREE.Group();
        const TILT = 0.62, DECK = 8.2;
        const card = luBox(2.6, 0.34, DECK, fr4EdgeMat(0));
        card.rotation.x = TILT;
        card.position.set(0, 2.9, 0);
        slide.add(card);
        const gold = luBox(1.9, 0.16, DECK - 0.8, goldPinMat());
        gold.rotation.x = TILT;
        gold.position.set(0, 2.9 + 0.25 * Math.cos(TILT), 0.25 * Math.sin(TILT));
        slide.add(gold);
        for (const sd of [-1, 1]) {
          const leg = luBox(0.34, 5.1, 0.34, pinMat());
          leg.position.set(sd * 1.05, 2.55, -3.1);
          slide.add(leg);
        }
        for (let k = 0; k < 3; k++) {
          const rung = luBox(2.3, 0.24, 0.24, pinMat());
          rung.position.set(0, 1.5 + k * 1.2, -3.1);
          slide.add(rung);
        }
        put(slide, 0, -4.5);

        // 蹺蹺板 = **蹺板開關**(rocker switch)。中文名字本身就是答案:一片會
        // 翹起來的撥鈕架在一顆本體上。提案的「橫躺的電阻架在支點上」駁回 ——
        // 橫躺的色環電阻**就是**這個世界的樹叢。
        const rock = new THREE.Group();
        const rbase = luBox(2.4, 1.1, 1.7, icMat());
        rbase.position.y = 0.55;
        rock.add(rbase);
        const pivot = luCyl(0.35, 2.2, pinMat(), 8);
        pivot.rotation.x = Math.PI / 2;
        pivot.position.y = 1.15;
        rock.add(pivot);
        const pad = luBox(5.8, 0.5, 1.9, luToyMat());
        pad.position.y = 1.55;
        pad.rotation.z = 0.3;
        rock.add(pad);
        put(rock, 6.2, 3.4);

        // 旋轉盤 = **微調電位器**:一顆會被螺絲起子轉的旋鈕,頂上還有那道一字槽。
        // 遊樂場的旋轉盤本來就是低的,不必硬拉高 —— 高的那件已經有滑梯了。
        const pot = new THREE.Group();
        const pbody = luCyl(1.9, 0.9, aluMat());
        pbody.position.y = 0.45;
        pot.add(pbody);
        const knob = luCyl(1.35, 0.7, luToyMat());
        knob.position.y = 1.2;
        pot.add(knob);
        const slot = luBox(2.2, 0.22, 0.34, icMat());
        slot.position.y = 1.56;
        pot.add(slot);
        put(pot, -6.4, 4.2);
        return luHarvest(group);
      }

      if (kind === 'sand') {
        // **上限 8 顆**。這八顆是**顆粒**不是道具:半埋、不投影、最大 1.1 m,
        // 站不起來 —— 沙地照定義沒有結構。真正的沙感住在貼圖裡。
        // 幾何走共用的 `unitSphere` + `solderMat()`,而 solderMat 早就有一堆用戶
        // (每隻 IC 腳底下都有一顆焊錫圓角),所以連新的材質都不會多開一份。
        if (r < 4) return null;
        const spread = Math.min(r, 26);           // 同上:大沙灘不把八顆撒到地平線
        for (let i = 0; i < 8; i++) {
          const a = rng() * Math.PI * 2, rad = spread * Math.sqrt(rng()) * 0.8;
          const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
          const s = 0.5 + rng() * 0.6;
          const ball = new THREE.Mesh(luUnit('lu:sphere', solderMat(), unitSphere), solderMat());
          ball.scale.setScalar(s);
          ball.position.set(x, top + s * 0.42, z);
          group.add(ball);
        }
        return luHarvest(group);
      }

      return null;
    },

    createOutline: () => null,   // 電路世界沒有墨線(inkEnabled: false)

    // ── Post ──
    /**
     * 三個世界只有這一個要「強」bloom:這個世界的識別性就是發光,而 emissive
     * 本身不會外溢 — 外溢那一圈才是眼睛讀成「在發光」的東西(demo)。閾值用
     * demo 的 bright-pass 數字(0.72 / knee 0.4),比積木的 0.85 低一截:走線、
     * 輝光管、LED 都要進得來,不只鏡面高光。
     */
    createPostPass: (width, height) => {
      if (!params.sceneBloomEnabled) return null;
      return new SceneBloomPass(width, height, {
        threshold: 0.72,
        knee: 0.4,
      });
    },
    applyPostParams: (pass: ShaderPass) => {
      // Strength follows the day/night blend and is driven by the render loop
      // (same contract as the toy world's pass).
      void pass;
    },

    /**
     * 騎士的腳接到板子上。demo `animate()` 與 `applyDayNight()` 裡屬於「電流」那
     * 一族的每一行,原地照抄:
     *
     * ```js
     * // animate()
     * if (powerOn) {
     *   pulseU -= dt * cadenceSpeed();
     *   pulseTex.offset.x = pulseU;
     * }
     * // applyDayNight()
     * const wg = wattGain();
     * for (const m of dupWireMats) m.emissiveIntensity = powerOn * wg * (0.34 + 1.5 * k);
     * sparkMat.opacity = Math.min(1, powerOn * wg * (0.34 + 0.5 * k));
     * ```
     *
     * 三處與 demo 不同,每一處都有理由:
     *
     *  1. **`powerOn` 沒有對應物。** 那是 demo 控制列上的斷電開關(「斷電時踩再用力
     *     都不會亮」),gameview 沒有那個開關,所以它恆為 1 —— 而不是被發明成別的
     *     東西(例如暫停)。
     *  2. **`(0.34 + 1.5 * k)` 收成 `DUP_GLOW_PEAK`。** `k` 那一半由夜燈驅動寫在
     *     emissive 的**顏色**上,見 `DUP_GLOW_PEAK`。留在這裡的是 `wg`,因為它乘的
     *     是 `emissiveIntensity`,那一格夜燈驅動不寫 —— 兩隻手不碰同一格。
     *  3. **`pulseU` 每圈繞回。** demo 不繞,它跑的是幾分鐘;一趟騎乘是幾小時,
     *     0.9 uv/秒 累到 −9700 之後 `offset.x` 上傳成 float32 的解析度就只剩
     *     ~1e-3 uv(256 寬的貼圖上是 0.26 px),脈衝會開始一格一格跳。貼圖是
     *     `RepeatWrapping`,而火花的相位只讀 `frac(f - band)`,**所以減掉整數圈在
     *     數學上完全等價** —— 這是修精度,不是改動畫。
     */
    updateRiderSignals: (signals, dt) => {
      pulseU = (pulseU - dt * cadenceSpeed(signals.cadenceRpm)) % 1;
      pulseTex.offset.x = pulseU;
      // 估計功率不是量到的功率(`RiderSignals.powerSource`):拿輪速推回來的瓦數去
      // 調亮度,等於把「你騎得比較快」演成「你踩得比較用力」。所以它跟「沒有功率計」
      // 走同一條 —— `wattGain(null)` = 1,也就是不乘。
      const wg = wattGain(signals.powerSource === 'meter' ? signals.powerW : null);
      for (const m of dupWireMats) m.emissiveIntensity = wg * DUP_GLOW_PEAK;
      sparkMat().opacity = Math.min(1, wg * (0.34 + 0.5 * nightLitFactor()));
      for (const animate of liveRoutes) animate();
    },

    dispose: () => {
      buildingMaterial?.dispose();
      buildingMaterial = null;
      // Unregister BEFORE disposing — the global night driver writes into
      // every registered material each frame.
      for (const mat of nightLit) unregisterNightLitMaterial(mat);
      nightLit.clear();
      for (const mat of trimMaterials.values()) mat.dispose();
      trimMaterials.clear();
      for (const geo of trimTemplates.values()) geo.dispose();
      trimTemplates.clear();
      for (const t of ownedTextures) t.dispose();
      ownedTextures.length = 0;
      gradientMap.dispose();
    },
  };

  return strategy;
}
