/**
 * Paper (corrugated CARDBOARD) terrain style — the "paper tank / hand-drawn"
 * look for the Three.js world.
 *
 * How the paper feel is built (geometry + materials do the heavy lifting; the
 * screen-space paper pass only converges it):
 *  - Terrain is the shared quantised engine with a TALL layer height → the
 *    ground reads as stacked contour cardboard sheets (P1 core).
 *  - Materials are matte, flat-shaded MeshToonMaterial over a soft gradient, and
 *    every colour is "paperified" (desaturated + warm kraft tint) so the same
 *    zone stays one muted construction-paper colour.
 *  - Ink outlines (inverted hull) on buildings + trees — the single biggest
 *    hand-drawn signal.
 *  - Trees are cut-card crosses on a paper-tube trunk.
 *
 * Zero external assets; blocks/paper are generic craft words (no branding).
 */

import * as THREE from 'three';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createPaperPass } from './paper-effect-pass';
import { disposeGroup } from './bike-ornament';
import { simpleNoise2D } from './cartoon-materials';
import { injectCloudShadow } from './cloud-shadow';
import {
  registerNightLitMaterial,
  unregisterNightLitMaterial,
  type WindowPlacement,
} from './building-lights';
// 機制,不是貨架:它只把「這一層地被排在第幾位」寫進 polygonOffset。積水要拿到
// 跟水面同一個名次,而那個名次的唯一來源是這張表 —— 抄一個數字進來,下次插一格
// 就會靜靜地錯位(`overlay-depth.ts` 自己寫著「不准斷言這些數字」)。
import { applyOverlayDepth } from './overlay-depth';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  celestialDiscRadius,
  defaultStyleParams,
  markInstanceTemplate,
  mulberry32,
  quantizeToLayer,
  type BikeOrnamentParts,
  type BoxPart,
  type BuildingBox,
  type FinishAirshipParts,
  type LandusePropContext,
  type PartShape,
  type SignParts,
  type SignPurpose,
  type StreetLampParts,
  type StyleParams,
  type TerrainStyleStrategy,
} from './terrain-style-strategy';
import { SIGN_RATIO, sanitizeSignText, signStrokes, type ZoneKind } from './sign-spec';
import { buildStrokeGeometry, buildSignTriangleGeometry } from './sign-builder';

/**
 * Sign carrier: a DYMO-style embossed label tape.
 *
 * Not a sticky note, even though this world is full of them — the sticky note
 * is already the commercial building's own front (DEVPLAN「一個元件只能有一個
 * 身分」). Tape is a different object off the same desk.
 *
 * Tape colour by zone. These are the saturated plastic tones the tape actually
 * comes in, not paperified kraft: the tape is not made of cardboard, and washing
 * it into the board tones would lose the one high-contrast surface this world
 * has for text.
 */
const SIGN_TAPE_COLORS: Record<ZoneKind, number> = {
  // The demo's `SIGN_TAPE_PLAIN`, verbatim — and it only has these three.
  commercial: 0xd09a34,
  school: 0x7c5ea6,
  hospital: 0x3f7fb5,
  // The demo hangs no sign on a house or a tape dispenser, so these two have no
  // demo answer (DEMO_POC_GUIDE §2, case A). They were BOTH `0x8a8f7a` — one
  // invented grey-green on two different zones, which is §3.2 written out in
  // literal hex: two things that read as the same object from the saddle.
  //
  // Rather than invent a second one, take them off this world's own shelf: the
  // demo's `ZONE_PAINT` has a pigment for all five zones (rose / cadmium / slate
  // / violet / cerulean) and the three tapes above are already its cadmium,
  // violet and cerulean one step down. So residential gets the rose and
  // industrial the slate, which is the same five-hue separation `ZONE_DECAL_COLORS`
  // below already ships — the tape and the ground decal now agree on what colour
  // a district is, instead of disagreeing in two places.
  residential: 0xcf7492,
  industrial: 0x7f8894,
};

/**
 * Embossed letters are WHITE, not the world's ink colour.
 *
 * This is the one place the shared spec's「字 = 該世界的 ink 色」does not apply,
 * and it is deliberate: a label maker does not print, it stretches the plastic,
 * and stretched plastic goes white. Inked letters would turn the tape into a
 * printed card and the carrier stops being a label maker. It also happens to be
 * the highest-contrast option, which is what wins at riding distance.
 */
const SIGN_EMBOSS_COLOR = 0xf7f3e8;

/**
 * Hospital triangle. Never a red cross — see `sign-spec.ts`.
 *
 * The 3D demo's `crossMat` plain state (`{ map: null, color: '#d0402f' }`), which
 * is the same material its pill box wears. This used to be `0xc4483a`, and that
 * value is not wrong so much as from the WRONG DEMO — it is
 * `plan/phaser-handdrawn-demo.html`'s `cross: 0xc4483a`, i.e. the 2D one, which
 * is exactly the copy §3.11 forbids: 2D is flat fill, 3D goes through a light and
 * a toon quantiser as well, so the 3D value has to sit a step brighter. The 3D
 * demo's own answer does. 2D keeps `0xc4483a`; that is not a divergence to fix.
 */
const SIGN_TRIANGLE_COLOR = 0xd0402f;

/** Width ceiling in metres, before the building's own 0.8 × width cap. */
const SIGN_MAX_WIDTH = 9;

/**
 * 標籤帶本體:圓角長條(3:1)。**單位大小共用一份,尺寸靠 scale** —— demo 的
 * `unitLabelTape` 原封搬過來,連厚度先置中(translate −0.5)那一步都一樣。
 *
 * 用單位尺寸不只是為了共用:圓角是四段 absarc,最後一段的終點在最終尺寸下算出來
 * 會離起點差一個 ULP,`ShapeUtils.removeDupEndPts` 是**精確比對**,於是輪廓多留
 * 一個點,兩個端蓋各多一個零面積三角形。
 */
let unitLabelTape: THREE.ExtrudeGeometry | null = null;
function unitLabelTapeGeometry(): THREE.ExtrudeGeometry {
  if (unitLabelTape) return unitLabelTape;
  const hw = SIGN_RATIO / 2, hh = 0.5, r = 0.22;
  const s = new THREE.Shape();
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh);
  s.absarc(hw - r, -hh + r, r, -Math.PI / 2, 0, false);
  s.lineTo(hw, hh - r);
  s.absarc(hw - r, hh - r, r, 0, Math.PI / 2, false);
  s.lineTo(-hw + r, hh);
  s.absarc(-hw + r, hh - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-hw, -hh + r);
  s.absarc(-hw + r, -hh + r, r, Math.PI, Math.PI * 1.5, false);
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false, curveSegments: 4 });
  g.translate(0, 0, -0.5);
  unitLabelTape = g;
  return g;
}

/**
 * The GREEN CUTTING MAT the whole paper world is built on — the surface out past
 * the terrain corridor, and the base colour its texture is filled with.
 *
 * The mat is not scenery, it is the tool the model is being cut on, and that
 * carries two rules straight from the demo:
 *
 *  · THERE IS ONLY ONE MAT, AND IT IS THE GROUND. The demo once had a second
 *    green disc underneath its board and you could see the extra ring edge from
 *    across the world. Whoever adds the blueprint desk the demo draws BEYOND its
 *    mat: gameview has exactly one surface out there, and this is it. A second
 *    disc under this one buys a visible circular seam and nothing else.
 *  · IT IS NOT SWAPPABLE. When the gouache/plain-board double state finally
 *    arrives (`swappable` appears 0 times in this file today), the mat is
 *    excluded: paint mode repaints the MODEL, and the mat is a tool lying on the
 *    desk — it does not get painted because you picked up a brush.
 */
const CUTTING_MAT_COLOR = 0x2f5a4d;
/** Grid lines scored into the mat: cool near-white, every fifth one heavier. */
const CUTTING_MAT_GRID = '226,238,232';
/** Where the knife has been. Cut PVC self-heals pale, never dark. */
const CUTTING_MAT_SCAR = '#dce9e2';
/**
 * Ground metres per mat tile, and 10 grid cells inside it → a 12 m square.
 *
 * A real mat's grid is an inch. At the disc's inner rim (~540 m out) an inch
 * would be far under a pixel, so the grid would exist only in the texture file
 * and the mat would mip to flat green — the same trap the toy world's studs hit.
 * 12 m holds a readable square across the near mat and fades out honestly.
 */
const CUTTING_MAT_TILE_METERS = 120;
const CUTTING_MAT_CELLS = 10;

/**
 * District wash colours — the demo's `ZONE_PAINT`, taken from its gouache
 * palette (rose / cadmium / slate / violet / cerulean).
 *
 * Five hues that stay apart on warm kraft: pink, orange, grey, purple, blue.
 * Green sits the round out on purpose — it belongs to grass and trees here, and
 * a green district would read as a park. These are already paper-toned pigments,
 * so they are NOT run through `paperify` a second time; doing that would drag
 * all five toward the same kraft brown and undo the separation.
 */
const ZONE_DECAL_COLORS: Record<ZoneKind, number> = {
  residential: 0xcf7492,
  commercial: 0xe0a233,
  industrial: 0x7f8894,
  school: 0x8a6cb0,
  hospital: 0x4c90c2,
};

/**
 * The distant range is A WASH OF INK, not stacked board.
 *
 * Contour-stacked cardboard is the language of the MODEL on the desk — the thing
 * that was really cut and glued. The far range is not part of the model; it is a
 * brush stroke on the backdrop behind it, which is how the 2D world has always
 * drawn it: one flat silhouette, no board, no flutes. Layered board put out on
 * the horizon just reads as a slit-open carton standing at the edge of the world.
 *
 * Brown ink, not a cool grey. Everything else here is kraft, and a single cool
 * range would drag the whole palette toward grey board to keep it company; brown
 * ink brushed onto the same kraft sheet needs nothing else changed.
 *
 * NEAR stays DARKER than FAR — 遠淡近濃, and also the physical truth: distance
 * washes a range out through the air in between, it never darkens it. That is
 * why `mountain-ring.ts` draws these UNLIT: a lit vertical curtain 2 km out has
 * a horizontal normal and collapses to black under a high sun, and a painted
 * stroke should not dim when the sun swings behind it anyway. Unlit also means
 * these values are literally what you see — unlike a shaded material, there is
 * no need to pre-lift them a step to survive the lighting.
 *
 * The demo splits each ring into a wash band plus a darker crest line, and BOTH
 * halves now have a home: `mountainRingFinish()` below hands the line colour and
 * its depth to `mountain-ring.ts`, which builds it as a second strip. Until that
 * hook existed the two `INK_*_LINE` values had nowhere to live at all
 * (plan/migrate-demo-worlds.md §3.5) and the horizon was a flat wash.
 */
const MOUNTAIN_FAR_COLOR = 0xa89d86;
const MOUNTAIN_NEAR_COLOR = 0x8d8168;
const MOUNTAIN_FAR_LINE = 0x7d735e;
const MOUNTAIN_NEAR_LINE = 0x5c5240;

/**
 * …AND THE HORIZON HAS TWO STATES LIKE EVERYTHING ELSE ON THIS DESK.
 *
 * The four values above are only half the demo. Its horizon materials are
 * `swappable` like every other surface in the world:
 *
 * > `const inkMat = (paintHex, plainHex) => swappable(`
 * > `  new THREE.MeshBasicMaterial({ fog: false }), { color: plainHex }, { color: paintHex });`
 * > 「素模式:背板還沒上色,山就只剩一條鉛筆打的稿線。」
 * > `const PLAIN_WASH = '#d9cfb4', PLAIN_LINE = '#8a7f66';`
 *
 * The port took the painted half and stopped, so with `paintEnabled: false` the
 * entire model went back to bare board and the range stayed brushed brown ink —
 * the one thing on screen still holding yesterday's state. That is what「配色和
 * POC 不一樣」looks like from the saddle: not a wrong hue, a wrong MODE.
 *
 * ⚠ ONE VALUE FOR BOTH RINGS, and that is the demo's, not a simplification. In
 * paint mode the two rings carry the aerial perspective (遠淡近濃); unpainted
 * they are two pencil lines on the same backdrop, so `inkMat`'s plain argument is
 * the SAME `PLAIN_WASH` / `PLAIN_LINE` at both call sites. Giving the plain state
 * a near/far split would be inventing a distance cue the pencil stage does not
 * have.
 */
const MOUNTAIN_PLAIN_COLOR = 0xd9cfb4;
const MOUNTAIN_PLAIN_LINE = 0x8a7f66;

/**
 * The demo's two `inkRidge()` call sites, verbatim.
 *
 * `base` / `amp` are METRES in the demo and `maxH` only ever scales the ink
 * line, so `prof(a) / maxH` is the normalised profile `mountain-ring.ts` wants
 * and `maxH` is exactly the height scale it multiplies back in — see
 * NEAR_/FAR_MAX_HEIGHT there, which are these two numbers scaled by the ring
 * radius ratio so the crest subtends the demo's own angle.
 *
 * > 諧波次數兩圈互質,免得兩條稜線同相位、峰對峰疊成一座。
 *
 * and, because this is a ring rather than a 2D scanline:
 *
 * > 這裡是繞一圈,所以**諧波次數必須取整數**,不然繞回起點會有一道接不起來的斷崖。
 *
 * 5/13/29 and 7/17/37 are all integers and pairwise coprime across the rings —
 * change any of them to a non-integer and the profile's first and last entries
 * stop being equal, which is a seam from the skirt to the peak.
 */
const INK_RIDGE = {
  far: { base: 96, amp: 46, maxH: 170, h1: 5, h2: 13, h3: 29 },
  near: { base: 34, amp: 20, maxH: 68, h1: 7, h2: 17, h3: 37 },
} as const;

/** Metres of road per repeat of the masking-tape texture (sets the dash pitch). */
const ROAD_TEXTURE_METERS = 14;

/** Soft 3-step gradient → matte, low-contrast paper shading. */
function createPaperGradient(): THREE.DataTexture {
  const data = new Uint8Array([
    Math.round(0.58 * 255),
    Math.round(0.8 * 255),
    255,
  ]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Desaturate toward luminance + warm kraft tint → construction-paper tone. */
function paperify(c: THREE.Color): THREE.Color {
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  const desat = 0.45;
  c.r += (lum - c.r) * desat;
  c.g += (lum - c.g) * desat;
  c.b += (lum - c.b) * desat;
  c.r = Math.min(1, c.r * 1.02 + 0.04);
  c.g = Math.min(1, c.g * 0.98 + 0.02);
  c.b = Math.min(1, c.b * 0.86);
  return c;
}

function paperifyHex(hex: number): number {
  return paperify(new THREE.Color(hex)).getHex();
}

/**
 * 地形分層色。demo(`plan/paper-town-demo.html`)的原話與原值:
 *
 * > 地形分層色。低處草綠 → 高處帶土的灰黃,等高線模型常見的分層上色。
 * > `const TERRAIN_BAND = ['#6d9a46', '#7ea44c', '#93a55a', '#a89b64', '#b6a479', '#c4b596'];`
 *
 * **這是瓦楞紙世界自己的表,不是把積木的表 paperify 一次。** 兩件事不一樣:
 * 積木走的是單色相的明度階(它的招牌是那片亮綠,換色相就換了世界),瓦楞紙走的
 * 是真正的**色相階**——草綠一路走到帶土的灰黃,因為它畫的是建築系評圖的等高線
 * 模型,那種模型本來就是這樣上色的。方向兩邊一致:山腳深、山頭淡。
 *
 * 側面**沒有**色帶,而且這是刻意的 —— demo:
 *
 * > 每片之間看得到那道**切邊**。切邊是不上色的生紙板,踏面才刷顏料 —— 這個
 * > 對比就是整個造型的識別點。
 *
 * 所以 `TerrainBand.side` 留空,切口一律走 `createTerrainWallMaterial()` 的瓦楞
 * 生紙板(那個材質根本不吃頂點色,再給它一個 side 色也只是死值)。
 *
 * 階高:demo 是一片 `PLATE_H = 3.2` 的紙板 —— 一階色帶 = 一片板 = 它的量化階。
 * 搬過來的**連值一起**:`defaultStyleParams('paper').layerHeight === 3.2`,由
 * `[terrace step height vs demo]` 從 demo 原始碼切出來比。它一度是 12(沒有記錄
 * 理由的 3.75× 重推),而那個數字同時把豎邊的瓦楞縱向拉長 3.75 倍 —— 見
 * `createCorrugationTexture`。
 */
const TERRAIN_BAND: readonly string[] =
  ['#6d9a46', '#7ea44c', '#93a55a', '#a89b64', '#b6a479', '#c4b596'];

const bandColors = TERRAIN_BAND.map((c) => ({ top: new THREE.Color(c) }));

/**
 * 素紙板態的踏面色。demo 的 `plateTopMats` 兩態,原話與原值:
 *
 * > 每一層一組頂面材質(共用,所以疊層數再多也不會多出材質)。**素模式全部
 * > 是生紙板**;上色模式才吃 TERRAIN_BAND 的分層色。
 * > `{ map: rep(kraftTop, …), color: ['#e0cfab', '#e6d6b4'][i % 2] }`
 *
 * 所以「素」不是灰階、也不是把六階塗成同一個棕色 —— 是**還沒上色的稿**:六片
 * 板子還是六片板子(交替的兩個牛皮紙色讓相鄰兩階仍然分得開),只是顏料還沒
 * 刷上去。切邊本來就不上色,兩態一樣。
 */
const PLATE_PLAIN_KRAFT: readonly string[] = ['#e0cfab', '#e6d6b4'];

const plainBandColors = TERRAIN_BAND.map((_, i) => ({
  top: new THREE.Color(PLATE_PLAIN_KRAFT[i % PLATE_PLAIN_KRAFT.length]),
}));

/**
 * Raw kraft board colour for box tops.
 *
 * The demo's board FACE is `kraftTop = kraftTexture('#cda36e', '#8a6238')` — the
 * first argument is the sheet, the second its speckle — so `#cda36e` is what a
 * flat, unspeckled kraft face is in this world. `0xc9a670` was near it but from
 * nowhere.
 *
 * ⚠ The board's CUT EDGE is a different colour and lives in
 * `createCorrugationTexture`: the demo's `plateEdgeTexture` fills its core with
 * `#a87c48`, darker than the face, because a cut edge is the exposed fluting and
 * not the liner. Do not collapse the two.
 */
const KRAFT_COLOR = 0xcda36e;

// ── 這個世界自己的貨架 ──────────────────────────────────────────────────────
//
// 底下四組值(建築色、道路、樹、平滑地形色)以前全部是在執行期跑
// `const base = createPlasticTerrainStyle()` 再 `paperify()` 拿到的 ——
// **一個世界在實例化另一個世界**。改積木會靜靜改到瓦楞紙,而逐件比對抓不到:
// 它比的是幾何與材質參數,不讀 import(`plan/world-modularity-refactor.md`)。
//
// 切斷那條依賴不可以改變畫面,所以下面每一個值都與切斷前**逐位元組相同**。
// 每一組都寫清楚它是「demo 的原值」還是「凍結先前送出去的推導結果」——兩者
// 差很多,混在一起就是重推爬進來的地方。

/**
 * 橡皮擦屋的六個色 —— **demo 的字面值,一個字沒改**:
 *
 * > `const ERASER_COLORS = ['#e17779', '#96d9d9', '#b0ec89', '#fae895',
 * >  '#c46ec6', '#e48f6c'];`
 * > 「版權:…配色用我們自己的 paperify(BUILDING_COLORS)」
 * > 「= paperify(遊戲 cartoon-materials.ts 的 BUILDING_COLORS 全六色),順序一致」
 *
 * 也就是說 demo 自己就是這樣推出來的,而且**推完就寫死了**。這裡貼的是 demo 那
 * 六個字面值,不是 `paperifyHex(積木的表)`:兩條路逐個 hex 相等(量過,六個全
 * 中),但只有前者不必在執行期去另一個世界的貨架上拿東西。`paperify()` 還在這
 * 個檔案裡,它現在的角色是「這些數字怎麼來的」的說明,不是它們的來源。
 */
const ERASER_COLORS: readonly number[] = [
  0xe17779, 0x96d9d9, 0xb0ec89, 0xfae895, 0xc46ec6, 0xe48f6c,
];

/**
 * 同一棟建築永遠拿到同一個色。座標雜湊照抄積木那份,而那是**機制**(決定性
 * 選色)不是設計決定 —— 設計決定是上面那六個色,它們是這個世界自己的。
 */
function eraserColorFromCoord(lon: number, lat: number): number {
  const hash = Math.abs(Math.round(lon * 100000) * 31 + Math.round(lat * 100000) * 17);
  return ERASER_COLORS[hash % ERASER_COLORS.length];
}

/**
 * 道路:等級 → 顏色 / 寬度。
 *
 * ⚠ **demo 回答不了這個問題,所以下面不是 demo 的值。** `paper-town-demo.html`
 * 只有一條紙膠帶路:`ribbonSeg(d0, d1, 9, 0.06)` —— 一種寬度、一張貼圖,沒有
 * 等級系統(`plan/DEMO_POC_GUIDE.md` §2 的 A 類:demo 沒被問到那個問題)。
 *
 * 所以這兩張表是**凍結**先前送出去的值,一個位元都沒動:
 *  - 顏色 = `paperifyHex(積木的 ROAD_COLORS)`,推導寫在每一行的行尾註解裡。
 *  - 寬度 = 積木的 `ROAD_WIDTHS` 原數字(公尺)。
 *
 * 兩張表以前是透過 `createPlasticTerrainStyle()` 在執行期拿的。等 demo 真的長
 * 出等級系統,要換的是這兩張表,不是再去接一次別人的貨架。
 */
const ROAD_COLORS: Record<string, number> = {
  motorway: 0x493c29,   // paperify(0x2d2d2d)
  trunk: 0x493c29,      // paperify(0x2d2d2d)
  primary: 0x514636,    // paperify(0x3a3a3a)
  secondary: 0x5d5345,  // paperify(0x4a4a4a)
  tertiary: 0x6a6154,   // paperify(0x5a5a5a)
  minor: 0x797164,      // paperify(0x6b6b6b)
  service: 0x797164,    // paperify(0x6b6b6b)
  path: 0x797164,       // paperify(0x6b6b6b)
  track: 0x797164,      // paperify(0x6b6b6b)
};

/** 未知等級的退路。積木那份是 `?? 0x5a5a5a`,paperify 之後就是 tertiary 的值。 */
const ROAD_COLOR_FALLBACK = 0x6a6154;

/** 道路寬度(公尺)。 */
const ROAD_WIDTHS: Record<string, number> = {
  motorway: 12,
  trunk: 10,
  primary: 8,
  secondary: 6,
  tertiary: 5,
  minor: 4,
  service: 3,
  path: 2,
  track: 2,
};

/** 未知等級的退路,同積木。 */
const ROAD_WIDTH_FALLBACK = 4;

/**
 * 樹幹 / 樹冠色。
 *
 * ⚠ **這個世界畫樹用不到它們。** 剪紙樹的顏色住在 `treeCutoutTexture` 畫出來
 * 的貼圖裡,幾何走自己的 `buildTreeGeometry: () => buildCutCardTreeGeometry()`,
 * 而 `tintTreeInstances: false` 讓 `tree-renderer.ts` 連 instance 染色那段都不
 * 跑。它們是 `TerrainStyleStrategy` 的必填欄位,只有預設的圓錐樹會讀。
 *
 * 值同樣是**凍結**先前送出去的 `paperifyHex(積木的 COIL_TRUNK_COLOR /
 * COIL_GREENS)` —— 而積木那三個綠是它的 demo 為毛根樹挑的,跟這個世界無關。
 * 這裡不從 demo 取值,是因為 demo 的剪紙樹根本沒有「樹幹色」這個東西。
 */
const CUTOUT_TRUNK_COLOR = 0x9b7755;              // paperify(0xa06a35)
const CUTOUT_CANOPY_COLORS: readonly number[] = [
  0x5b7849, 0x658756, 0x709964,                   // paperify(0x1a7d35 / 0x248f42 / 0x2ea34f)
];

/**
 * 平滑地形的頂點色:高程色階 + 噪點混色,再 paperify。
 *
 * ⚠ **正常玩到的地面不會走這裡。** 這個世界的 `quantEnabled` 預設 true 而且
 * `WORLD_OPTIONS.cuphead` **沒有那顆開關**,所以地面永遠是量化的等高線板,
 * 顏色一律由 `bandAt`(→ demo 的 `TERRAIN_BAND`)決定;`paper-props-vs-demo.ts`
 * 把這個函式換成洋紅再建一次,踏面一格都沒變,那是直接的證據。剩下唯一到得了
 * 的路是 `settingsStore.config.debug` 才出現的調校面板把「高程量化」關掉。
 *
 * 這一組以前是**先前送出去的行為**逐位元組搬過來的 ——`paperify(積木的
 * terrainVertexColor(...))`,包含積木的霓虹色階與噪點色,而那段註解自己寫著
 * 「值本身還是別人世界的設計決定…留給人決定」。**現在決定了:換掉。**
 *
 * 它們不是「demo 沒有答案所以只好發明」——demo 對「地面隨高度變什麼顏色」的答案
 * 白紙黑字就是上面的 `TERRAIN_BAND`(草綠 → 帶土的灰黃那條色相階)。而舊的六個值
 * 裡有四個是 CSS 命名色與霓虹色:`#39e75f`/`#c8e620` 是螢光綠,`#6a5acd` 是
 * slateblue,`#8b4513` 是 saddlebrown。牛皮紙的貨架上沒有那些東西(§3.8),而且
 * 這條路徑走的是**平滑地形**,不吃 `bandAt`,所以它以前跟量化地面是兩套完全不同
 * 的配色 —— 同一條路線把「高程量化」關掉,整個世界會換一組色相。
 *
 * 所以三段取 `TERRAIN_BAND` 的低 / 中 / 高三階,噪點取相鄰階(混色本來就是「同一
 * 條色階上抖一下」,不是換一個色相)。
 *
 * ⚠ 換完之後 `groundVertexColor` **不再過 `paperify`**:`TERRAIN_BAND` 已經是這個
 * 世界最終上到螢幕的值(量化地面直接用它,一次都沒 paperify),再抽一次 45% 飽和度
 * 會讓同一片地在開關量化時深淺不一。
 */
const GROUND_COLOR_STOPS: [number, number][] = [
  [500, 0x6d9a46],        // TERRAIN_BAND[0] — 低地的草綠
  [1500, 0xa89b64],       // TERRAIN_BAND[3] — 帶土的黃
  [Infinity, 0xc4b596],   // TERRAIN_BAND[5] — 高處退成紙色
];

const GROUND_NOISE_COLORS: [number, number[]][] = [
  [500, [0x7ea44c, 0x93a55a]],   // TERRAIN_BAND[1] / [2]
  [1500, [0xb6a479]],            // TERRAIN_BAND[4]
  [Infinity, [0xb6a479]],
];

/** 高程 → 底色。 */
function groundColorForElevation(elevation: number): THREE.Color {
  for (const [maxElev, color] of GROUND_COLOR_STOPS) {
    if (elevation < maxElev) return new THREE.Color(color);
  }
  return new THREE.Color(GROUND_COLOR_STOPS[GROUND_COLOR_STOPS.length - 1][1]);
}

/**
 * 底色 + 噪點混色。`noiseScale` 0.002 ≈ 500 公尺一塊。
 * `simpleNoise2D` 是機制(sin 雜湊),從 `cartoon-materials.ts` 拿。
 *
 * **沒有 `paperify`**,理由見 `GROUND_COLOR_STOPS`:色階現在就是 `TERRAIN_BAND`,
 * 而那是量化地面直接送上螢幕的值。
 */
function groundVertexColor(elevation: number, worldX: number, worldZ: number): THREE.Color {
  const noiseScale = 0.002;
  const base = groundColorForElevation(elevation);

  let noiseColors: number[] = [];
  for (const [maxElev, colors] of GROUND_NOISE_COLORS) {
    if (elevation < maxElev) {
      noiseColors = colors;
      break;
    }
  }
  if (noiseColors.length === 0) return base;

  const n1 = simpleNoise2D(worldX * noiseScale, worldZ * noiseScale);
  const n2 = simpleNoise2D(worldX * noiseScale * 2.3 + 100, worldZ * noiseScale * 2.3 + 100);
  const combined = (n1 + n2 * 0.5) / 1.5;

  const noiseColorIdx = Math.floor(combined * noiseColors.length) % noiseColors.length;
  const mixAmount = 0.15 + combined * 0.25;

  base.lerp(new THREE.Color(noiseColors[noiseColorIdx]), mixAmount);
  return base;
}

/** Printed paper sleeve pushed onto an eraser's base, and the ink rule on it.
 *
 *  The demo's `sleeveMat` is `toon({ map: kraftNeutral, color: '#b2854a' })`
 *  over a WHITE kraft speckle, so `#b2854a` is the tone it comes out as; there
 *  is no speckle here, so it is the flat colour. This file had a pale cream
 *  `#e8dcbf` — a different paper. */
const SLEEVE_COLOR = 0xb2854a;
const SLEEVE_INK_COLOR = 0x2f2418;
/** How much of the body the sleeve covers, from the bottom up. */
const ERASER_SLEEVE_FRAC = 0.52;
/** How far the sleeve stands proud of the rubber — one paper thickness. */
const ERASER_SLEEVE_T = 0.14;

/**
 * The red plastic FILM over the sleeve — real drafting erasers almost all have
 * one, and its edge is a ready-made boundary between two materials (paper below,
 * plastic above). That is what lights up at night.
 *
 * Why it exists: residential was the only zone in this world with no night light
 * at all, and it is the most common building on the route (~24 %). The other
 * four zones each have one. The rule that produced that — "an eraser does not
 * glow, so it gets no lights" — is right; the outcome was not.
 *
 * The eraser still has NO WINDOWS. The printed frames on the sleeve stay unlit,
 * day and night; only the film's edge glows. The failure this world was built to
 * avoid — windows stamped onto a shape that has no business having them — does
 * not come back through this door.
 *
 * The circuit world's residential building solves it the same way (a glowing
 * crimp groove around a capacitor's top). Both are "a ring where two materials
 * meet", and the rhyme is deliberate.
 */
const ERASER_BAND_COLOR = 0xc8443a;
const ERASER_BAND_GLOW = 0xff5a44;

/**
 * Arch outline for a tunnel mouth: a rectangle with a semicircular top, as a
 * closed Shape (or Path, for the opening cut out of a frame).
 */
function archOutline<T extends THREE.Shape | THREE.Path>(
  out: T, w: number, h: number,
): T {
  const hw = w / 2;
  const straight = Math.max(0.1, h - hw);
  out.moveTo(-hw, 0);
  out.lineTo(-hw, straight);
  out.absarc(0, straight, hw, Math.PI, 0, true);
  out.lineTo(hw, 0);
  out.closePath();
  return out;
}

/**
 * A `w x d` rectangle centred on the origin. Deliberately SQUARE-cornered: a
 * draughtsman's plastic eraser is a crisp block, and rounding the vertical
 * corners turns the building into a bar of soap (that silhouette belongs to the
 * other, soft kind of eraser). The only soft edge on one is the end that has
 * been rubbed down — see the wear rake in buildBuildingBody.
 */
function eraserRectShape(w: number, d: number): THREE.Shape {
  const hw = Math.max(0.1, w) / 2;
  const hd = Math.max(0.1, d) / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-hw, -hd);
  shape.lineTo(hw, -hd);
  shape.lineTo(hw, hd);
  shape.lineTo(-hw, hd);
  shape.closePath();
  return shape;
}

/**
 * Highlighter pen — the route is swiped onto the road with it. 3D-only (no CSS
 * counterpart), so it lives here rather than in themes.scss, same as KRAFT_COLOR.
 * The ink core and its bleed, straight from the paper demo.
 */
const HIGHLIGHTER_INK = 0xb8ec1e;
const HIGHLIGHTER_BLEED = 0xd8ff66;

/**
 * Procedural corrugated-cardboard cut-edge texture (tileable). Texture space:
 * one full v-repeat = ONE stacked sheet (liner – wavy flute – liner), u repeats
 * every WALL_U_METERS. This is what sells "瓦楞紙" on every vertical face:
 * kraft base, dark liner lines top/bottom, and a sine-wave flute band between.
 * `strength` (params.corrugationStrength) scales the pattern contrast.
 *
 * THE FIVE COLOURS ARE THE DEMO'S `plateEdgeTexture` PALETTE, verbatim:
 *
 * > `const P = { core: '#a87c48', flute: '#7d5730', hi: '#d6b382',`
 * > `  liner: '#cfa971', seam: 'rgba(60,38,16,0.24)', … };`
 *
 * They replace five values that were nowhere in the demo (`#c9a670` core,
 * `#8a6a3e` / `#e8cfa2` flutes, `#7d5f36` / `#f0dcb4` liners). This is the single
 * most-seen surface in the world — every vertical face of every contour plate —
 * so it was also the largest single reason the shipped world did not read like
 * the POC: the port's core was the board FACE colour, which made every cut edge
 * the same tone as the top it belongs to and flattened the whole terrace stack.
 *
 * The layout also follows the demo now: the outer band is the LINER (the paper
 * face, light) with the dark SEAM just inside it. It used to be the other way
 * round — a dark line on the outside — which draws each plate with a printed
 * border instead of a cut edge.
 *
 * ⚠ Only the palette and that order are the demo's. The PERIOD COUNT is not, and
 * cannot be: the demo's canvas is 256×64 with 13 flutes because one u-repeat
 * there is 20 m (`rep(plateEdgeTex, 0.05, …)`); here one u-repeat is
 * `WALL_U_METERS` = 8 m, so 5 flutes. Those come to 0.65 and 0.63 flutes per
 * metre — the same pitch on the wall, expressed in each renderer's own units.
 *
 * The VERTICAL is not a number here at all, and that is the demo's design worth
 * keeping: the demo writes `1 / PLATE_H`, i.e. one plate per step, and
 * `quantized-terrain.ts` puts the same relation in the UV (`v = 絕對高程 /
 * layerHeight`). So this material sets NO `repeat` — the step height alone
 * decides how tall a plate is drawn, and changing it re-fits the texture with no
 * second edit. When `layerHeight` was 12 rather than the demo's 3.2, this is
 * what made the risers stop reading as cardboard: the same flutes stretched to a
 * 1 : 3.3 aspect. `[terrace step height vs demo]` asserts both halves.
 */
function createCorrugationTexture(strength: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const s = Math.max(0, Math.min(1.5, strength));

  // Fluting core — the demo's `P.core`, darker than the board face.
  ctx.fillStyle = '#a87c48';
  ctx.fillRect(0, 0, size, size);

  // Subtle per-pixel paper noise (deterministic).
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  let seed = 0x2545f491;
  for (let i = 0; i < d.length; i += 4) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const n = (((seed >>> 0) % 1000) / 1000 - 0.5) * 18 * (0.5 + s * 0.5);
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  if (s > 0.01) {
    // Wavy flute band — the corrugation core seen edge-on. Shadow stroke plus a
    // slightly offset highlight so the wave reads as a 3D ripple.
    const flutes = 5; // periods per u-repeat (WALL_U_METERS)
    const amp = size * 0.22;
    const mid = size / 2;
    const wave = (offsetY: number, style: string, width: number, alpha: number) => {
      ctx.strokeStyle = style;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let x = 0; x <= size; x += 2) {
        const y = mid + offsetY + Math.sin((x / size) * Math.PI * 2 * flutes) * amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    wave(3, '#7d5730', size * 0.10, 0.55 * s);   // P.flute — flute shadow
    wave(-4, '#d6b382', size * 0.05, 0.45 * s);  // P.hi — flute highlight

    // The two paper faces at the sheet boundaries, demo order: LINER outside
    // (`P.liner`), SEAM just inside it (`P.seam`, a dark hairline where the face
    // is glued to the fluting).
    ctx.globalAlpha = 0.65 * s;
    ctx.fillStyle = '#cfa971';
    ctx.fillRect(0, 0, size, 3);
    ctx.fillRect(0, size - 3, size, 3);
    ctx.globalAlpha = 0.35 * s;
    ctx.fillStyle = '#3c2610';
    ctx.fillRect(0, 3, size, 2);
    ctx.fillRect(0, size - 5, size, 2);
    ctx.globalAlpha = 1;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** World metres per crayon-shading texture repeat (top surfaces). */
const CRAYON_SHADE_METERS = 18;

/**
 * Anisotropic filtering for the two textures that end up lying FLAT on the
 * ground and running to the fog (`crayonShade`, `dent`).
 *
 * The demo cannot arbitrate this one and never had to: its board is 130 units
 * across with fog at 260–780 m, so nothing it draws is ever seen at a real
 * grazing angle. Here the same textures tile from under the rider's wheels out
 * to a 3 km fog wall (`plan/demo-gaps.md` §7 — "真正不同的是看得多遠"), and
 * isotropic mip selection has to take the LONGER of the two footprint axes: on
 * a ground plane that is the along-view axis, which is tens of times the
 * across-view one. The result is over-blur whose selected level slides as the
 * camera moves — i.e. the texture visibly "appears" and crawls.
 *
 * three clamps this to the GPU's `getMaxAnisotropy()` at upload, so a number the
 * hardware cannot honour costs nothing.
 */
const GROUND_ANISOTROPY = 8;

/** Bare-paper colour showing through the crayon tooth gaps (warm off-white). */
const PAPER_TOOTH_RGB = 'vec3(0.93, 0.89, 0.80)';

/**
 * Crayon surface-shading texture (tileable both axes). Channel encoding:
 *  - R: waxy streak multiplier (≈0.78–1.0) — uneven crayon pressure.
 *  - G: paper-tooth mask (mostly 0; speckles/scratches ≈0.4–0.9) — where the
 *    bare paper shows through the wax.
 * Applied by `crayonize()`: diffuse *= R, then mix(diffuse, paperWhite, G).
 * Strokes all lean one diagonal — the way a hand shades a whole area.
 */
function createCrayonShadeTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(0x1b873593);

  // Base: full crayon coverage (R=255), no tooth (G=0).
  ctx.fillStyle = 'rgb(255,0,0)';
  ctx.fillRect(0, 0, size, size);
  ctx.lineCap = 'round';

  // Waxy streaks — one consistent diagonal (~-35°), varying pressure. Each
  // stroke is stamped on a 3×3 wrap grid for seamless tiling.
  const ang = -0.61; // radians
  const dirX = Math.cos(ang), dirY = Math.sin(ang);
  for (let i = 0; i < 170; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const len = 26 + rng() * 80;
    const r = Math.round(205 + rng() * 42); // streak darkness (205–247)
    ctx.strokeStyle = `rgba(${r},0,0,${(0.3 + rng() * 0.4).toFixed(3)})`;
    ctx.lineWidth = 1.5 + rng() * 3.5;
    const jx = (rng() - 0.5) * 8; // slight per-stroke drift off the diagonal
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.beginPath();
        ctx.moveTo(x + ox - dirX * len / 2, y + oy - dirY * len / 2 + jx / 2);
        ctx.lineTo(x + ox + dirX * len / 2, y + oy + dirY * len / 2 - jx / 2);
        ctx.stroke();
      }
    }
  }

  // Paper tooth — speckles + a few short scratches where the wax skipped.
  // rgb(255,255,0): keeps R bright (no darkening) while raising the G mask.
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(255,255,0,${(0.3 + rng() * 0.5).toFixed(3)})`;
    const x = rng() * size;
    const y = rng() * size;
    const rr = 0.5 + rng() * 1.4;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 26; i++) {
    ctx.strokeStyle = `rgba(255,255,0,${(0.25 + rng() * 0.35).toFixed(3)})`;
    ctx.lineWidth = 0.8 + rng() * 1.2;
    const x = rng() * size;
    const y = rng() * size;
    const len = 6 + rng() * 18;
    ctx.beginPath();
    ctx.moveTo(x - dirX * len / 2, y - dirY * len / 2);
    ctx.lineTo(x + dirX * len / 2, y + dirY * len / 2);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / CRAYON_SHADE_METERS, 1 / CRAYON_SHADE_METERS);
  texture.anisotropy = GROUND_ANISOTROPY;
  texture.needsUpdate = true;
  return texture;
}

/** Small seeded RNG (xorshift32) for stable procedural textures. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** World metres per dent-bump texture repeat. */
const DENT_METERS = 26;

/** Bump strength for the cardboard dents (toon steps posterize the shading). */
const DENT_BUMP_SCALE = 2.2;

/**
 * Cardboard dent bump map (tileable): mid-grey base with soft dark hollows and
 * lighter bulges — the "坑坑巴巴" of handled cardboard. Used as `bumpMap` on the
 * crayoned surfaces; under the 3-step toon gradient the dents show up as
 * blotchy light/shadow patches instead of smooth shading.
 */
function createDentTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(0x85ebca6b);

  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, size, size);

  // Soft blobs stamped on a 3×3 wrap grid for seamless tiling:
  // dark = pressed-in hollows, light = pushed-out bulges.
  const blob = (x: number, y: number, r: number, lum: number, alpha: number) => {
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, `rgba(${lum},${lum},${lum},${alpha.toFixed(3)})`);
        g.addColorStop(1, `rgba(${lum},${lum},${lum},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  };

  for (let i = 0; i < 26; i++) {
    // Hollows — bigger, softer.
    blob(rng() * size, rng() * size, 18 + rng() * 34, 70 + Math.round(rng() * 30), 0.22 + rng() * 0.2);
  }
  for (let i = 0; i < 18; i++) {
    // Bulges — smaller, brighter.
    blob(rng() * size, rng() * size, 10 + rng() * 22, 175 + Math.round(rng() * 45), 0.18 + rng() * 0.18);
  }
  // A few sharp creases (thin dark lines).
  ctx.lineCap = 'round';
  for (let i = 0; i < 8; i++) {
    ctx.strokeStyle = `rgba(80,80,80,${(0.18 + rng() * 0.2).toFixed(3)})`;
    ctx.lineWidth = 1 + rng() * 2;
    const x = rng() * size;
    const y = rng() * size;
    const len = 30 + rng() * 90;
    const ang = rng() * Math.PI;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        ctx.beginPath();
        ctx.moveTo(x + ox - Math.cos(ang) * len / 2, y + oy - Math.sin(ang) * len / 2);
        ctx.lineTo(x + ox + Math.cos(ang) * len / 2, y + oy + Math.sin(ang) * len / 2);
        ctx.stroke();
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / DENT_METERS, 1 / DENT_METERS);
  texture.anisotropy = GROUND_ANISOTROPY;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Turn a toon material's map into crayon shading: instead of the standard
 * multiply, R modulates the colour (wax pressure) and G mixes toward bare
 * paper (tooth gaps). Geometries need world-metre UVs (quantised tops,
 * ShapeGeometry landuse, ExtrudeGeometry buildings all qualify).
 */
function crayonize<T extends THREE.MeshToonMaterial>(mat: T, tex: THREE.Texture): T {
  mat.map = tex;
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `
      #ifdef USE_MAP
        vec4 crayonTex = texture2D( map, vMapUv );
        // R: waxy streak pressure; G: paper tooth (bare paper shows through).
        diffuseColor.rgb *= crayonTex.r;
        diffuseColor.rgb = mix( diffuseColor.rgb, ${PAPER_TOOTH_RGB}, crayonTex.g * 0.85 );
      #endif
      `,
    );
  };
  return mat;
}

/** Inverted-hull ink material: back faces pushed out along normals. */
function makeInkMaterial(color: number, thickness: number): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uThickness = { value: thickness };
    shader.vertexShader = 'uniform float uThickness;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  transformed += normalize(normal) * uThickness;',
    );
  };
  return m;
}

/**
 * Masking-tape road surface: grey-blue tape with diagonal weave, white torn
 * edges, and a correction-fluid dashed centre line. Tiles along u (metres of
 * road); v spans the road width, so the dashes keep a constant pitch.
 */
function createTapeRoadTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  // ── The demo's `tapeTexture()`, stroke for stroke ──
  // Its own `mulberry32(0x7a9e11)`, because every wobble below is a draw from
  // that stream in that order.
  const rng = mulberry32(0x7a9e11);
  ctx.fillStyle = '#6d7684';
  ctx.fillRect(0, 0, w, h);

  // Paper fibres, along the long edge, of uneven length.
  for (let i = 0; i < 260; i++) {
    ctx.globalAlpha = 0.04 + rng() * 0.1;
    ctx.strokeStyle = rng() > 0.45 ? '#ffffff' : '#3d4450';
    ctx.lineWidth = 0.7 + rng() * 1.1;
    const y = rng() * h;
    const x = rng() * w;
    const len = 6 + rng() * 40;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (rng() - 0.5) * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Diagonal sheen of the tape.
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 3;
  for (let i = -w; i < w * 2; i += 12) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 40, h);
    ctx.stroke();
  }

  // The splice: the next length of tape laid over the last one, so the overlap
  // is a shade darker and its leading edge is torn rather than cut.
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#2f3540';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  for (let y = 0; y <= h; y += 8) ctx.lineTo(5 + Math.sin(y * 0.11) * 2.5 + rng() * 2, y);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = '#e8e6df';
  ctx.fillRect(0, 0, 1.6, h);
  ctx.globalAlpha = 1;

  // The tape's own two edges — they catch a little light, and they are not
  // straight. (This file used to draw them as two 5 px rectangles.)
  for (const edge of [0, 1]) {
    ctx.fillStyle = 'rgba(240,240,235,0.45)';
    ctx.beginPath();
    for (let x = 0; x <= w; x += 6) {
      const ew = 4 + Math.sin(x * 0.14 + edge * 2) * 1.3 + rng();
      ctx.lineTo(x, edge ? h - ew : ew);
    }
    ctx.lineTo(w, edge ? h : 0);
    ctx.lineTo(0, edge ? h : 0);
    ctx.closePath();
    ctx.fill();
  }

  // ── The correction-fluid dashes, which the demo does NOT paint here ──
  // In the demo they are real geometry: a `PlaneGeometry(0.55, 3.4)` instanced
  // every 7 m down the path at y = 0.12, in `#f5f2e8`. gameview's road has one
  // hook (`createRoadMaterial`) and no place to hang a second layer of ribbon
  // geometry, so the dash is painted into the tape instead. Same colour, same
  // hand-wobbled line; it repeats with the tape (`ROAD_TEXTURE_METERS`) rather
  // than with the road's own length, and it is the one thing on this road that
  // is not the demo's. Porting the real dashes needs a centreline pass in
  // `road-renderer.ts` and a hook to go with it.
  ctx.strokeStyle = '#f5f2e8';
  ctx.lineCap = 'round';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(0, h / 2 + (rng() - 0.5) * 3);
  for (let x = 6; x <= w * 0.5; x += 6) {
    ctx.lineTo(x, h / 2 + (rng() - 0.5) * 3);
  }
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * A crayon-scribbled window on a transparent background — stuck onto building
 * facades as alpha-cut cards (the walls are one merged mesh, so the windows
 * can't live in the wall texture the way the demo does it).
 */
function createCrayonWindowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(0xc2b2ae35);
  ctx.clearRect(0, 0, size, size);

  const jitter = () => (rng() - 0.5) * 6;
  const x = 20;
  const y = 22;
  const w = size - 40;
  const h = size - 44;

  // Two passes of a wobbly outline + a diagonal scribble fill — how a hand
  // colours in a window with a crayon.
  ctx.strokeStyle = '#4a7dbd';
  ctx.lineCap = 'round';
  ctx.lineWidth = 7;
  for (let pass = 0; pass < 2; pass++) {
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(x + jitter(), y + jitter());
    ctx.lineTo(x + w + jitter(), y + jitter());
    ctx.lineTo(x + w + jitter(), y + h + jitter());
    ctx.lineTo(x + jitter(), y + h + jitter());
    ctx.closePath();
    ctx.stroke();
  }
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 8;
  for (let i = 0; i < w + h; i += 11) {
    ctx.beginPath();
    ctx.moveTo(x + Math.min(i, w), y + Math.max(0, i - w));
    ctx.lineTo(x + Math.max(0, i - h), y + Math.min(i, h));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * demo 的 `treePaper(kind, painted)`,兩態都在,原封。
 *
 * 「一種樹 × 一種上色模式**只做一張**,兩個剪法變體共用 —— 底紙是被剪刀輪廓
 * clip 掉大半的,兩張只差在看不見的地方,但各做一張就是四張 256 的成本。剪法
 * 的差異來自 treeCutoutTexture 自己那條 rng,跟底紙無關。」
 *
 * 128 px:整張被 `drawImage` 拉到 256 貼上,那是一片沒有硬邊的水彩底,放大兩倍
 * 看不出來(剪刀邊、鉛筆稿線仍然是 256 畫的)。
 *
 * 上色態是 demo 的 `gouacheCanvas(PAINT.sap, …)` —— 刷上去的廣告顏料;素態是
 * 一張綠色美術紙(平底 + 兩百多道紙紋)。demo 的原話解釋了為什麼素態要**另外
 * 一條 rng**:「底紙怎麼做不能影響後面剪刀的抖動,否則素模式跟上色模式會剪出
 * 兩個不一樣的輪廓,共用的 depth material 就對不上。」
 */
const TREE_PAINT_SAP = '#5c8c3c';
const treePaperCache = new Map<string, HTMLCanvasElement>();
function treePaper(painted: boolean): HTMLCanvasElement {
  const key = painted ? 'p' : 'r';
  const hit = treePaperCache.get(key);
  if (hit) return hit;
  const PS = 128;
  const cv = painted
    ? gouacheCanvas(TREE_PAINT_SAP,
      { seed: 0x5eed, brush: 17, coverage: 0.9, size: PS, speck: ['#2d5220', 120] })
    : (() => {
      const c = document.createElement('canvas');
      c.width = PS;
      c.height = PS;
      const q = c.getContext('2d')!;
      // 用獨立的 rng —— 底紙怎麼做不能影響後面剪刀的抖動。
      const prng = mulberry32(0x5eed);
      q.fillStyle = '#5aa646';
      q.fillRect(0, 0, PS, PS);
      for (let i = 0; i < 230; i++) {
        q.globalAlpha = 0.05 + prng() * 0.09;
        q.fillStyle = prng() > 0.5 ? '#2c5a28' : '#8ccb6e';
        q.fillRect(prng() * PS, prng() * PS, 1 + prng() * 1.5, 1);
      }
      q.globalAlpha = 1;
      return c;
    })();
  treePaperCache.set(key, cv);
  return cv;
}

/** 一張剪紙樹卡的邊長。demo 的 `treeCutoutTexture` 就是 256。 */
const TREE_TILE = 256;

/**
 * demo 的 `treeCutoutTexture('round', false, seed)`,原封搬過來。
 *
 * 這裡的每一筆都是**剪刀**:不規則的雲團輪廓、歪掉的紙條樹幹、偏 (3.5, 4) 的
 * 深色底紙、以及溢出剪裁邊界的鉛筆稿線。`seed` 不是裝飾 —— 它決定的是輪廓,
 * 而輪廓正是兩張卡必須不一樣的那個東西(見 `createTreeCutoutTexture`)。
 *
 * 港版只做 `kind = 'round'`(這個世界的樹只有一種幾何、一份材質),但**兩個
 * 上色態都在** —— demo 開場是上色態,而港版原本只烘了 `painted = false` 那一張,
 * 所以 3D 的樹一直是「還沒上色的稿」。
 */
function treeCutoutTile(seed: number, painted: boolean): HTMLCanvasElement {
  const S = TREE_TILE;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d')!;
  const rng = mulberry32(seed);
  g.clearRect(0, 0, S, S);

  const dark = painted ? '#3c6b39' : '#33632f';
  const paper = treePaper(painted);

  /** 剪刀走過的一圈:折線 + 每個轉折隨機偏一點。 */
  function outline(pts: [number, number][], jitter: number): void {
    g.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = pts[i][0] + (rng() - 0.5) * jitter;
      const y = pts[i][1] + (rng() - 0.5) * jitter;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  }

  const canopy: [number, number][][] = [];
  {
    // 一圈不規則的雲團,半徑隨角度跳動 → 剪出來的圓不會是圓規畫的
    const ring: [number, number][] = [];
    const n = 22;
    let r = 66;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      r += (rng() - 0.5) * 22;
      r = Math.max(46, Math.min(78, r));
      ring.push([128 + Math.cos(a) * r, 118 + Math.sin(a) * r * 0.94]);
    }
    canopy.push(ring);
  }

  // 樹幹:牛皮紙條,兩邊各歪一點
  const tw = 11 + rng() * 4;
  g.fillStyle = painted ? '#7d5a35' : '#8a5a2b';
  g.beginPath();
  g.moveTo(128 - tw + rng() * 2, 252);
  g.lineTo(128 + tw + rng() * 2, 252);
  g.lineTo(128 + tw * 0.7 + (rng() - 0.5) * 4, 150);
  g.lineTo(128 - tw * 0.7 + (rng() - 0.5) * 4, 150);
  g.closePath();
  g.fill();
  g.globalAlpha = 0.35;
  g.strokeStyle = '#4a3520';
  g.lineWidth = 1.2;
  g.stroke();
  g.globalAlpha = 1;

  // 深色底紙(偏 3px)→ 再蓋上正面那張
  for (const pass of [1, 0]) {
    for (const ring of canopy) {
      g.save();
      g.translate(pass ? 3.5 : 0, pass ? 4 : 0);
      outline(ring, 3.2);
      if (pass) {
        g.fillStyle = dark;
        g.fill();
      } else {
        g.clip();
        g.drawImage(paper, 0, 0, S, S);   // 底紙是 128,要撐滿 256
      }
      g.restore();
    }
  }

  // 鉛筆稿線:溢出剪裁邊界,那是還沒剪掉的草稿
  g.globalAlpha = 0.42;
  g.strokeStyle = '#3c3324';
  g.lineWidth = 1.4;
  g.lineJoin = 'round';
  for (const ring of canopy) {
    outline(ring, 5.5);
    g.stroke();
  }
  g.globalAlpha = 1;

  return c;
}

/**
 * demo 的兩個剪法變體,並排成一張 512×256 的圖集。
 *
 * demo 的理由是它自己寫的:「兩張用**不同**的剪法(不同 seed 的貼圖),不然轉到
 * 45° 會看出是同一張鏡射過去的。」demo 走的是**兩份材質**(`treeMats[kind][v]`),
 * 這裡不行 —— 一個 chunk 的樹是**一個** InstancedMesh,一份幾何一份材質,兩份
 * 材質就是兩個 draw call 外加把樹拆成兩批。
 *
 * 所以差異搬到 uv 上:同一張貼圖切成左右兩格,兩張卡各吃一格
 * (`buildCutCardTreeGeometry`)。剪法照舊由 demo 自己那兩個 seed 決定
 * (`0x3a01 + v * 977`,kind = 'round'),一格沒動;變的只有它們住在哪裡。
 */
function createTreeCutoutTexture(painted: boolean): THREE.CanvasTexture {
  const S = TREE_TILE;
  const canvas = document.createElement('canvas');
  canvas.width = S * TREE_CARD_VARIANTS;
  canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  for (let v = 0; v < TREE_CARD_VARIANTS; v++) {
    ctx.drawImage(treeCutoutTile(TREE_CUT_SEED + v * TREE_CUT_SEED_STEP, painted), v * S, 0);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** demo 的 `sd = 0x3a01 + v * 977`(round 的兩個剪法種子)。 */
const TREE_CUT_SEED = 0x3a01;
const TREE_CUT_SEED_STEP = 977;
/** 一棵樹幾張卡 —— demo 的 `for (let i = 0; i < 2; i++)`。 */
const TREE_CARD_VARIANTS = 2;

/**
 * 一張卡的邊長,公尺。demo 是 `o.scale.setScalar(10 * s)` 套在 `unitPlane` 上,
 * 而 `s = 0.75 + rng() * 0.3` → 7.5–10.5 m;這裡是 8 m 再吃 renderer 的
 * 0.7–1.4 倍 → 5.6–11.2 m,同一個帶。
 *
 * 它從 `buildCutCardTreeGeometry` 的區域常數升上來,因為白膠痕的大小是**對卡片
 * 的比例**(見 `TREE_GLUE_RADIUS_RATIO`)—— 兩個數字必須是同一個來源,不然改了
 * 卡片大小膠痕會靜靜地留在原地。
 */
const TREE_CARD_SIZE = 8;

// ── 白膠痕(demo 的 glueMat + treeBucket 那片 unitDisc)──────────────────────
//
// demo 的原話:「白膠黏上去的那圈痕跡 —— 底板上一小片影子,樹才不會像浮在上面。」
// 它是樹的**第三個 mesh**,自己的幾何、自己的材質,理由寫在 `TreeGroundMark`:
// 膠的 alpha 是 0.02 → 0.12 的 ramp,卡片材質 `alphaTest: 0.5` 會把它整個抹掉。

/** demo 的 `c.width = c.height = 64`。 */
const TREE_GLUE_TILE = 64;
/** demo 的 `for (let r = 31; r > 0; r--)` —— 半徑 31 起,一圈一圈往內畫。 */
const TREE_GLUE_RINGS = 31;
/** demo 的 `g.fillStyle = '#5a4526'`(乾掉的白膠在牛皮板上的顏色)。 */
const TREE_GLUE_COLOR = '#5a4526';
/** demo 的 `0.02 + 0.1 * (1 - r / 31)`:外圈幾乎透明,圓心 0.12。 */
const TREE_GLUE_ALPHA_BASE = 0.02;
const TREE_GLUE_ALPHA_RANGE = 0.1;

/**
 * demo 的 `glueMat` 那張 64×64 畫布,原封。
 *
 * 由外往內一圈一圈疊上去,每一圈都比上一圈不透明一點 —— 那個 ramp 就是這片痕跡
 * 的全部,所以它**不能**跟卡片共用材質(見上面)。
 */
function createTreeGlueTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = TREE_GLUE_TILE;
  c.height = TREE_GLUE_TILE;
  const g = c.getContext('2d')!;
  const mid = TREE_GLUE_TILE / 2;
  for (let r = TREE_GLUE_RINGS; r > 0; r--) {
    g.globalAlpha = TREE_GLUE_ALPHA_BASE + TREE_GLUE_ALPHA_RANGE * (1 - r / TREE_GLUE_RINGS);
    g.fillStyle = TREE_GLUE_COLOR;
    g.beginPath();
    g.arc(mid, mid, r, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** demo 的 `unitDisc = new THREE.CircleGeometry(1, 12)`。 */
const TREE_GLUE_SEGMENTS = 12;
/**
 * 膠痕半徑 ÷ 卡片邊長。demo 的 `scale.setScalar(2.6 * s)`(圓盤半徑 1)對
 * `scale.setScalar(10 * s)`(卡片邊長 1)—— `s` 兩邊都約掉了,剩下的比才是這個
 * 世界對「樹腳下那攤膠有多大」的答案,而它換卡片尺寸也活得下來。
 */
const TREE_GLUE_RADIUS_RATIO = 2.6 / 10;
/**
 * 膠痕離板面多高。demo 的 `o.position.set(x, y + 0.07, z)`。
 *
 * ⚠ 一格偏離,記在這裡:demo 的 0.07 **不乘 s**,而移植把它烘進幾何,於是它跟著
 * instance 的 0.7–1.4 倍縮放(0.049–0.098 m)。要維持絕對值就得讓膠痕自己一組
 * 矩陣,那等於放棄「跟樹共用同一組 instance matrix」這件事 —— 為了 5 公分。
 */
const TREE_GLUE_LIFT = 0.07;

/**
 * 白膠痕的幾何,烘在**樹自己的局部座標系**裡(樹底 y = 0),因為它跟樹共用同一組
 * instance matrix(見 `TreeGroundMark`)。
 *
 * 直接用最終半徑建 `CircleGeometry` 而不是「建單位圓再 scale」:圓盤是解析算出來
 * 的扇形,半徑是線性參數、uv 又已經正規化過,所以兩條路**逐位元組相同**。招牌膠帶
 * 那個 `ShapeUtils.removeDupEndPts` 的坑在這裡碰不到 —— 那是 `Shape` 走輪廓點的
 * 問題,`CircleGeometry` 不走輪廓。
 */
function buildTreeGlueGeometry(): THREE.BufferGeometry {
  const geo = new THREE.CircleGeometry(
    TREE_CARD_SIZE * TREE_GLUE_RADIUS_RATIO, TREE_GLUE_SEGMENTS,
  );
  // demo 的 `o.rotation.set(-Math.PI / 2, 0, 0)`:圓盤本來立在 xy 面,躺下來朝上。
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, TREE_GLUE_LIFT, 0);
  return geo;
}

// ── 廣告顏料(gouache)貼圖 —— demo 的 gouacheCanvas 原封搬過來 ──
// (plan/paper-town-demo.html。check:3d 直接執行 demo 自己的原始碼,跟這份
// 港版逐一比對繪圖指令流 —— 所以這裡的每一筆、每一個 globalAlpha、連 6.284
// 這種常數都不能「順手改好」,一改校準就紅。)
// 目前唯一的呼叫端是棉花球雲;「素紙板 ↔ 廣告顏料」雙態落地時其他材質也會
// 走這裡。demo 的 `after` callback(無法快取,雲也沒在用)刻意沒搬。

/** 灰紙板 —— 切邊、以及顏料沒刷到的地方看到的底(demo 的 BOARD)。 */
const GOUACHE_BOARD = '#bda07a';

/** demo 的 GS:貼圖基準邊長。size 是效能旋鈕不是造型旋鈕(等比縮所有尺寸)。 */
const GOUACHE_SIZE = 256;

function gouacheRgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** k>0 往白調、k<0 往黑調;a 省略 = 不透明。(demo 的 tint,字串格式也一致。) */
function gouacheTint(hex: string, k: number, a?: number): string {
  const c = gouacheRgbOf(hex);
  const t = k > 0 ? 255 : 0;
  const m = Math.abs(k);
  const f = (v: number): number => Math.round(v + (t - v) * m);
  return 'rgba(' + f(c[0]) + ',' + f(c[1]) + ',' + f(c[2]) + ',' + (a === undefined ? 1 : a) + ')';
}

interface GouacheOpts {
  seed?: number;
  /** 底板色(顏料沒蓋到的地方露出來的紙)。 */
  substrate?: string;
  /** 0~1 蓋得多滿。 */
  coverage?: number;
  /** 排筆寬 px。 */
  brush?: number;
  /** 疊幾道。 */
  coats?: number;
  /** 底紙纖維量。 */
  grain?: number;
  /** [色, 量] 噴點。 */
  speck?: [string, number];
  /** 畫布邊長,預設 GOUACHE_SIZE。 */
  size?: number;
}

/** 一張刷過廣告顏料的紙板。 */
function gouacheCanvas(hex: string, opts?: GouacheOpts): HTMLCanvasElement {
  const o = opts || {};
  const S = o.size || GOUACHE_SIZE;
  const k = S / GOUACHE_SIZE; // 相對 256 的縮放,所有尺寸都乘它
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const rng = mulberry32(o.seed || 0x9e3779b9);
  const sub = o.substrate || GOUACHE_BOARD;

  // 底:紙板 + 纖維
  g.fillStyle = sub;
  g.fillRect(0, 0, S, S);
  const grainN = Math.round((o.grain === undefined ? 620 : o.grain) * k * k);
  for (let i = 0; i < grainN; i++) {
    g.globalAlpha = 0.06 + rng() * 0.1;
    g.fillStyle = rng() > 0.5 ? '#7a6040' : '#e6d3ad';
    g.fillRect(rng() * S, rng() * S, Math.max(1, (1 + rng() * 3) * k), 1);
  }
  g.globalAlpha = 1;

  /**
   * 把一筆畫在九宮格上,四邊都不會被切掉。給了 (x, y, r) 就只畫真的會壓
   * 到畫布的那幾格 —— 不給也會對,只是九份全畫,慢八倍。
   */
  function wrap9(draw: () => void, x?: number, y?: number, r = 0): void {
    for (let dx = -1; dx <= 1; dx++) {
      if (x !== undefined && dx < 0 && x <= S - r) continue;
      if (x !== undefined && dx > 0 && x >= r) continue;
      for (let dy = -1; dy <= 1; dy++) {
        if (y !== undefined && dy < 0 && y <= S - r) continue;
        if (y !== undefined && dy > 0 && y >= r) continue;
        g.save();
        g.translate(dx * S, dy * S);
        draw();
        g.restore();
      }
    }
  }

  const cover = o.coverage === undefined ? 0.9 : o.coverage;
  const brush = (o.brush || 26) * k;

  /** 一道排筆。vertical = 轉 90° 刷(第二道要交叉才蓋得住)。 */
  function coat(vertical: boolean, spacing: number, alpha: number, wob: number): void {
    g.save();
    if (vertical) {
      g.translate(S, 0);
      g.rotate(Math.PI / 2);
    }
    g.lineCap = 'butt';
    g.lineJoin = 'round';
    for (let y0 = 0; y0 < S; y0 += spacing) {
      const waves = 1 + Math.floor(rng() * 3); // 整數波 = 左右接得起來
      const ph = rng() * Math.PI * 2;
      const lig = (rng() - 0.5) * 0.2;
      const a = alpha * (0.62 + rng() * 0.38);
      const w = spacing * (0.84 + rng() * 0.32);
      // 豬鬃:同一筆裡幾道深淺不一的細痕,廣告顏料稠,鬃痕留得很清楚
      const bristle: [number, number, number, number][] = [];
      const nb = 3 + Math.floor(rng() * 3);
      for (let b = 0; b < nb; b++) {
        bristle.push([(rng() - 0.5) * w * 0.86, (rng() - 0.5) * 0.36,
          (0.8 + rng() * 2.4) * k, 0.18 + rng() * 0.45]);
      }
      // 上下各補一份是為了接縫,但只有貼著邊的那幾道補了才看得到。整頁載
      // 入最貴的就是這些寬筆觸,不擋掉等於白刷三遍。
      const reach = w / 2 + wob + 2 * k;
      for (let off = -S; off <= S; off += S) {
        if (off < 0 && y0 <= S - reach) continue;
        if (off > 0 && y0 >= reach) continue;
        const lay = (dy: number, lw: number, style: string): void => {
          g.beginPath();
          // 取樣要**剛好落在兩端**(所以用段數,不是用 += 固定步長)。步長
          // 沒整除 S 的話最後一點停在 250,右緣少一截,貼圖一重複就是一條
          // 直的縫。段數 26(對 256)→ 擺動最多 3 個波、每個波還有 8 點以
          // 上,夠了;這裡是整頁載入最貴的一段,不必再密,縮圖時跟著少。
          const SEG = Math.max(10, Math.round(26 * k));
          for (let q = 0; q <= SEG; q++) {
            const x = (q / SEG) * S;
            const yy = y0 + off + dy + Math.sin((x / S) * Math.PI * 2 * waves + ph) * wob;
            if (q === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
          }
          g.lineWidth = lw;
          g.strokeStyle = style;
          g.stroke();
        };
        lay(0, w, gouacheTint(hex, lig, a));
        for (let b = 0; b < bristle.length; b++) {
          lay(bristle[b][0], bristle[b][2], gouacheTint(hex, lig + bristle[b][1], a * bristle[b][3]));
        }
      }
    }
    g.restore();
  }

  const coats = o.coats === undefined ? 2 : o.coats;
  if (coats > 0) coat(false, brush, cover, 2.2 * k);
  if (coats > 1) coat(true, brush * 1.32, cover * 0.64, 3.0 * k);
  if (coats > 2) coat(false, brush * 0.8, cover * 0.4, 1.6 * k);

  // 顏料堆積(收筆處會積一坨,乾了顏色深一階)
  for (let i = 0; i < 13; i++) {
    const x = rng() * S, y = rng() * S;
    const rx = (5 + rng() * 20) * k, ry = rx * (0.34 + rng() * 0.5), rot = rng() * 3.14;
    const al = 0.08 + rng() * 0.14;
    wrap9(() => {
      g.globalAlpha = al;
      g.fillStyle = gouacheTint(hex, -0.34);
      g.beginPath();
      g.ellipse(x, y, rx, ry, rot, 0, 6.284);
      g.fill();
    }, x, y, rx + 1);
  }
  // 乾刷:顏料不夠的地方露紙板
  for (let i = 0; i < 11; i++) {
    const x = rng() * S, y = rng() * S;
    const rx = (4 + rng() * 16) * k, ry = rx * (0.22 + rng() * 0.4), rot = rng() * 3.14;
    const al = 0.14 + rng() * 0.24;
    wrap9(() => {
      g.globalAlpha = al;
      g.fillStyle = sub;
      g.beginPath();
      g.ellipse(x, y, rx, ry, rot, 0, 6.284);
      g.fill();
    }, x, y, rx + 1);
  }
  g.globalAlpha = 1;

  if (o.speck) {
    const speckN = Math.round(o.speck[1] * k * k);
    for (let i = 0; i < speckN; i++) {
      g.globalAlpha = 0.25 + rng() * 0.5;
      g.fillStyle = o.speck[0];
      // 位置要在 wrap9 外面決定。擺進 callback 裡的話九份各抽各的亂數,
      // 就不是同一顆點的九個複本了 —— 接縫接不起來,而且點數多九倍。
      const r = Math.max(0.45, (0.7 + rng() * 1.9) * k), x = rng() * S, y = rng() * S;
      wrap9(() => {
        g.beginPath();
        g.arc(x, y, r, 0, 6.284);
        g.fill();
      }, x, y, r + 1);
    }
    g.globalAlpha = 1;
  }

  // 粉感:乾掉的廣告顏料表面會浮一層很淡的白
  g.globalAlpha = 0.055;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, S, S);
  g.globalAlpha = 1;
  return cv;
}

/** Kraft-board colour used for box flaps + slab tops. */
function kraftMaterial(gradient: THREE.DataTexture, color: number): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: gradient });
}

// ══════════════════════════════════════════════════════════════════════════
// 地被的貨架 —— 農田 / 濕地 / 球場 / 遊樂場 / 沙地
// ══════════════════════════════════════════════════════════════════════════
//
// demo(`plan/paper-town-demo.html` 的「地被的貨架 —— LU_STYLE」)整段照抄。
// `landuse-renderer.ts` 決定**哪塊地是哪一格、鋪成什麼形狀**;這一段決定
// **它長什麼樣**,以及**哪一格站得起來**(`buildLanduseProps`)。
//
// 兩條軸線先定,再回這個世界自己的貨架上找東西(§3.8):
//  A. 自然的那一對必須分得出來,而且**都不准再長一棵樹** —— park / forest 已經
//     長樹了,一個元件只能有一個身分(§3.3):
//       農田 = **規則的行列**(人種的:壟、等距)
//       濕地 = **不規則 + 水**(沒有行列,有積水跟一叢一叢)
//  B. 玩的那三個差在**結構量**:
//       球場   = 平的,只有線
//       遊樂場 = 有小結構(五格裡唯一准站高的)
//       沙地   = 沒有結構,只有顆粒
//
// 眼高法則(§3.4:騎士的眼睛只在地面上 6.3 m,而且是掠角)。五片全是躺平的,
// 細節在那個角度會死光,所以每一格只留**一個**活得下來的訊號:
//       農田   → 壟的**方向與間距**(所以壟要**寬**:一道 2 公尺)
//       濕地   → 積水的反光(玻璃紙),不是水暈的細節
//       球場   → 修正液的線
//       沙地   → 顏色與粗糙感
//       遊樂場 → **剪影**(它是唯一站得高的)
//
// draw call 的帳(§6:貼圖優先,只有真的必須站起來的才給幾何)。台北 3×3 圖磚
// 窗口裡球場有 **512 塊**(另有 69 塊遊樂場)—— 球場每多一件道具就是五百多個
// draw call。所以:
//       農田 / 球場 / 沙地 = **0 件道具**。壟、線、顆粒全部是貼圖。
//       濕地   ≤ 2 個 draw call(蘆葦全批成 1 個 InstancedMesh、積水併成 1 份幾何)
//       遊樂場 ≤ 3 個 draw call(夾子本體 IM + 手把 IM + 滑梯)
// 這三個上限是**寫死的**,不是「通常這麼多」:見 `buildLanduseProps`。
//
// 夜(§3.9 決定形體的東西必須同時決定燈):五格裡**只有球場會亮**。泛光燈是真的,
// 農田 / 濕地 / 遊樂場 / 沙地 夜裡就是暗的 ——「這東西沒有燈」是合法而且比硬掰
// 一盞好的答案。球場走這個世界既有的 `registerNightLitMaterial`,不另外發明第二
// 套機制(§3.10 最後一條)。
//   ⚠ **沒有燈桿。** 泛光燈塔會變成第二個「站得高的東西」(跟遊樂場撞剪影),而且
//     512 塊球場各插四支塔是 draw call 自殺。會亮的是**被照亮的地面本身**。
//
// 雙態(§7.2)的判準,用這個世界自己已經寫下來的那條:「上色模式換的是**模型上
// 的顏料**,墊子是桌上的工具,不會因為你開始上色就變成另一種墊子。」所以 ——
//   雙態:農田、濕地、遊樂場(都是刷在模型上的地)、蘆葦、長尾夾
//   非雙態:**球場**(方格紙 + 修正液 = 跟紙膠帶馬路、修正液虛線同一類「畫上去的
//           線」,而那兩個本來就不是雙態);**沙地**(橡皮擦屑是**磨下來的碎屑**,
//           跟切割墊一樣是桌上的東西);**積水**(玻璃紙,沿用這個世界的水材質)。
// 三張雙態的地被貼圖一律畫成**中性灰階**,顏色由 `material.color` 帶 —— 這是
// §6 給這個世界的解法(共用/中性貼圖 + 染色),不要一個顏色重刷一整張 canvas。
// 兩態**只換 color、不換 map**:同一張紙,兩種顏料。
//
// ⚠ 這五張**一張 bumpMap 都不掛**,而且那不是效能取捨。demo 從頭到尾沒有任何
//   bumpMap(`paper-props-vs-demo.ts` 斷言),而踏面那條理由在這裡逐字成立:
//   地被板是**平的**,整片的 `dot(N, L)` 是同一個值、被 toon 的 gradientMap 量化
//   成一階;uv 又是**未 rebase 的世界公尺**(`ShapeGeometry` 的 uv 就是 x/z),
//   二十公里之後 float32 的 ULP 比相鄰兩個 pixel 的 uv 差距還大,`dHdxy_fwd()`
//   拿到的是量化雜訊而不是導數 —— 整片地會逐幀閃。移植過來的前一版把三張都掛上
//   `dentedToon`,那是重推,不是 demo。

/** `luCanvas` 的九宮格包裹器:把一筆畫在 3×3 上,只畫真的壓到畫布的格。 */
type LuWrap9 = (fn: () => void, x: number, y: number, r: number) => void;

/**
 * 地被貼圖用的小畫布(demo 的 `luCanvas`)。`gouacheCanvas` 裡也有一支 wrap9,
 * 但那是它的區域變數;而且這四張畫的不是排筆刷痕(是楞、是水暈、是線、是屑),
 * 本來就不該走那支。
 *
 * 判準跟 §7.1 同一套:會 repeat 的圖,點狀元素一律包九宮格,而且 `rng()` 必須
 * 在 callback **外面**呼叫 —— 擺進去就變成九顆各自抽亂數的點,接縫接不起來,
 * 而且點數多九倍。
 */
function luCanvas(
  S: number,
  seed: number,
  draw: (
    g: CanvasRenderingContext2D, rng: () => number, wrap9: LuWrap9, S: number,
  ) => void,
): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const rng = mulberry32(seed >>> 0);
  /** 把一筆畫在九宮格上;(x, y, r) 是它的**中心與半徑**,只畫真的壓到畫布的格。 */
  const wrap9: LuWrap9 = (fn, x, y, r) => {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx < 0 && x <= S - r) continue;
      if (dx > 0 && x >= r) continue;
      for (let dy = -1; dy <= 1; dy++) {
        if (dy < 0 && y <= S - r) continue;
        if (dy > 0 && y >= r) continue;
        g.save();
        g.translate(dx * S, dy * S);
        fn();
        g.restore();
      }
    }
  };
  draw(g, rng, wrap9, S);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * demo 的 `rep(tex, 1 / TILE)`。地被板是 `ShapeGeometry`,它的 uv 就是**世界
 * 公尺**,所以 repeat 是「一公尺幾張貼圖」= 1 / 一張蓋幾公尺。
 *
 * demo 那支會先 `clone()`,因為它的中性貼圖有好幾個消費者;這裡五張各只有一個
 * 材質在用(`propTexture` 的 lazy singleton),所以直接寫在共用實例上 —— 跟
 * `createRoadMaterial` 對膠帶貼圖做的事同一套。
 */
function luTile(tex: THREE.CanvasTexture, metres: number): THREE.CanvasTexture {
  tex.repeat.set(1 / metres, 1 / metres);
  return tex;
}

// ── 農田:對開的瓦楞板,楞縫朝上 ──────────────────────────────────────────
//
// 楞**就是**壟,不必再發明一種壟。這是貨架上本來就有的東西(§3.8):模型的地形
// 是一片一片瓦楞板疊出來的,把最上面那張紙面撕掉,露出來的芯紙就是一排等間距的
// 壟 —— 建築系做田的時候真的就是這樣做的。
//
// ⚠ 楞的方向是**世界對齊的**,每一塊田都一樣。原因是硬的:uv 就是世界公尺、材質
//   又是 chunk 之間共用的**一份**,材質工廠拿不到 patch,所以沒有 per-patch 的
//   rotation 可以給。但這不是將就 —— 它剛好是這個世界的說法:**整片模型底下是
//   同一張板**,楞的方向就是那張板出廠的方向,所以每一塊田的壟都平行,因為它們
//   是從同一張板上切下來的。
//
// 秧苗**畫在貼圖裡,不站起來**:一株秧苗在 6.3 m 掠角下只有幾個 pixel,而且
// 「地上長綠色的小東西」是灌木已經佔走的身分。
const LU_FARM_TILE = 8;      // 一張貼圖蓋 8 公尺
// 四道楞 → 一道 **2 公尺**。整數才接得起來,而 2 公尺這個數字是從眼高法則反推的:
// 騎士眼睛 6.3 m、田在 35 m 外 → 俯角只有 atan(6.3/35) ≈ 10°,地上的花紋被壓成
// sin(10°) ≈ 0.18 倍。一道 2 m 的楞投影後只剩 0.35 m ≈ 0.57° ≈ **7 個 pixel**
// (55° 直向 FOV / 720 px)。換成一般農田那種 0.5 m 的壟就是 1.7 px —— 糊成一片,
// 而「壟的方向與間距」是這一格**唯一**活得下來的訊號。所以楞要寬到不真實為止。
const LU_FARM_FLUTES = 4;
/** demo 的 `luFarmTex`。中性灰階 —— 顏色由 `material.color` 帶。 */
function createFarmlandTexture(): THREE.CanvasTexture {
  return luCanvas(128, 0x7a1203, (g, rng, wrap9, S) => {
    // 一道楞切成八階。**不用漸層**:texture-probe 直接略過漸層(看不到 = 沒畫),
    // 而且下游是 toon 的四階量化,本來就該是階梯。光從左上來,所以兩側**不對稱**
    // —— 對稱的話讀起來是波浪紋,不是一排立體的壟。
    const PROFILE = ['#8b8b8b', '#a6a6a6', '#c9c9c9', '#e4e4e4',
      '#f0f0f0', '#dedede', '#bfbfbf', '#9d9d9d'];
    const W = S / LU_FARM_FLUTES;          // 32 px = 一道楞
    const bw = W / PROFILE.length;         // 4 px = 一階
    for (let f = 0; f < LU_FARM_FLUTES; f++) {
      for (let b = 0; b < PROFILE.length; b++) {
        g.fillStyle = PROFILE[b];
        g.fillRect(f * W + b * bw, 0, bw + 0.5, S);   // +0.5:不留白縫
      }
    }
    // 芯紙的纖維,順著楞走。撕開紙面之後看到的就是這個。
    for (let i = 0; i < 190; i++) {
      const x = rng() * S, y = rng() * S;
      const len = 9 + rng() * 34, w = 0.7 + rng() * 1.1;
      const al = 0.05 + rng() * 0.11, hi = rng() > 0.5;
      wrap9(() => {
        g.globalAlpha = al;
        g.fillStyle = hi ? '#ffffff' : '#6d6d6d';
        g.fillRect(x, y, w, len);
      }, x + w / 2, y + len / 2, len / 2 + 1);
    }
    g.globalAlpha = 1;
    // 秧苗:插在楞縫裡,一縫一行。沿楞的方向切 **16 段**(整除 128)—— 用「切幾段」
    // 而不是「每次走幾格」,不然最後一格會少一截,一 repeat 就是一條橫縫(§7.1)。
    const ROWS = 16;
    for (let f = 0; f < LU_FARM_FLUTES; f++) {
      const gx = f * W + bw * 1.15;        // 楞縫再往受光那側挪一點,不然黑壓黑看不到
      for (let k = 0; k < ROWS; k++) {
        const x = gx + (rng() - 0.5) * 2.6;
        const y = (k / ROWS) * S + (rng() - 0.5) * 2.2;
        const h = 4.2 + rng() * 2.8, w = 1.4 + rng() * 1.0;
        const al = 0.45 + rng() * 0.35;
        wrap9(() => {
          g.globalAlpha = al;
          g.fillStyle = '#5f5f5f';
          g.fillRect(x, y - h / 2, w, h);
        }, x + w / 2, y, h / 2 + 1);
      }
    }
    g.globalAlpha = 1;
  });
}

// ── 濕地:紙被水暈開的痕跡 ────────────────────────────────────────────────
//
// 一張紙吸了水再乾,會留下一圈**比中間深**的痕(色層析的邊)。那是這個世界表達
// 「這裡有水但不是一池水」唯一不用發明東西的方法 —— 板子本來就會這樣。跟農田唯
// 一要分清楚的事:它**沒有方向、沒有間距**,大小位置全亂。
const LU_WET_TILE = 14;
/** demo 的 `luWetTex`。 */
function createWetlandTexture(): THREE.CanvasTexture {
  return luCanvas(128, 0x4b3c11, (g, rng, wrap9, S) => {
    g.fillStyle = '#dedede';
    g.fillRect(0, 0, S, S);
    // ⚠ 這裡第一版是用 `g.ellipse()` 畫同心的兩圈 —— 出來是一整面**杯底印**:
    //   規則的正圓 + 同心環。那正好是這一格最不該有的東西(規則是農田的身分)。
    //   改成**不規則的閉合輪廓**,而且第二道暈**偏心**:紙上的水漬本來就是一波
    //   停一次、每一波的中心都不一樣。
    const outline = (
      x: number, y: number, r: number, sq: number, rot: number, rad: number[],
    ): void => {
      g.beginPath();
      for (let k = 0; k <= rad.length - 1; k++) {
        const a = (k / (rad.length - 1)) * Math.PI * 2 + rot;
        const px = x + Math.cos(a) * r * rad[k], py = y + Math.sin(a) * r * sq * rad[k];
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
    };
    for (let i = 0; i < 9; i++) {
      const x = rng() * S, y = rng() * S;
      const r = 13 + rng() * 21, sq = 0.6 + rng() * 0.55, rot = rng() * Math.PI;
      // 輪廓的抖動要**在 wrap9 外面**抽好(§7.1):擺進 callback 裡的話九份各抽
      // 各的,同一朵暈的九個複本會長成九個不同的形狀,接縫就接不起來了。
      const N = 17, rad: number[] = [];
      for (let k = 0; k < N; k++) rad.push(0.74 + rng() * 0.5);
      rad.push(rad[0]);                       // 收頭要回到起點
      const ox = (rng() - 0.5) * r * 0.5, oy = (rng() - 0.5) * r * 0.5;
      const lw = 1.4 + rng() * 1.2;
      const rmax = r * 1.24 + lw + 2;
      wrap9(() => {
        g.globalAlpha = 0.17;
        g.fillStyle = '#9d938a';
        outline(x, y, r, sq, rot, rad);
        g.fill();
        // 邊比中間深:紙吸水,溶下來的東西被推到水停下來的那一圈(色層析的邊)
        g.globalAlpha = 0.36;
        g.strokeStyle = '#6d6459';
        g.lineWidth = lw;
        outline(x, y, r, sq, rot, rad);
        g.stroke();
        // 第二道暈:偏心、小一號 —— 水退了一階又停一次
        g.globalAlpha = 0.22;
        g.lineWidth = lw * 0.8;
        outline(x + ox, y + oy, r * 0.58, sq, rot + 0.7, rad);
        g.stroke();
      }, x, y, rmax);
    }
    g.globalAlpha = 1;
    // 泡發的纖維:紙濕過會起毛,方向亂七八糟(農田那張是順著楞的,這裡刻意相反)
    for (let i = 0; i < 240; i++) {
      const x = rng() * S, y = rng() * S;
      const a = rng() * Math.PI, len = 3 + rng() * 12;
      const al = 0.05 + rng() * 0.12, dark = rng() > 0.42;
      const dx2 = Math.cos(a) * len, dy2 = Math.sin(a) * len;
      wrap9(() => {
        g.globalAlpha = al;
        g.strokeStyle = dark ? '#6f6a62' : '#f4f4f4';
        g.lineWidth = 0.8;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + dx2, y + dy2);
        g.stroke();
      }, x + dx2 / 2, y + dy2 / 2, len / 2 + 1);
    }
    g.globalAlpha = 1;
  });
}

// ── 球場:方格紙 + 修正液畫的線 ───────────────────────────────────────────
//
// 「平的、只有線」的那一格。線的物質是**修正液** —— 馬路的虛線(`createTapeRoadTexture`
// 的 `DASH_COLOR`)已經是修正液,同一個世界裡「白線」只能有一份做法(§3.10),
// 所以連色號都照抄。
//
// ⚠ 線是**可以 tile 的線**,不是某一座球場的實際劃線。貼圖每 16 m 重複一次,畫
//   一座 105×68 的足球場進去只會得到六份被切碎的中圈。改成畫「一格一面場」:
//   一圈邊線 + 中線 + 中圈 —— 學校操場上本來就是好幾面場的線疊在一起,所以重複
//   讀起來是對的。
const LU_SPORTS_TILE = 16;
/** demo 的 `luSportsTex`。 */
function createSportsFieldTexture(): THREE.CanvasTexture {
  return luCanvas(256, 0x5c07a1, (g, rng, wrap9, S) => {
    // 紙色壓深一階(第一版 #e7dfc7 太白):修正液是**白的**,底紙不夠深的話
    // 那幾條線在 30 m 外就跟紙一樣了 —— 而線是這一格唯一的訊號。
    g.fillStyle = '#ddd2b4';
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 220; i++) {          // 紙的纖維
      const x = rng() * S, y = rng() * S, len = 4 + rng() * 16, w = 0.8 + rng() * 1.0;
      const al = 0.04 + rng() * 0.08, dark = rng() > 0.5;
      wrap9(() => {
        g.globalAlpha = al;
        g.fillStyle = dark ? '#8d8371' : '#ffffff';
        g.fillRect(x, y, len, w);
      }, x + len / 2, y + w / 2, len / 2 + 1);
    }
    g.globalAlpha = 1;
    // 格線:16 段(每 1 m)細、每 4 段(每 4 m)粗,兩個都整除 256。
    // **要畫到 k = 16**(x = S 那一條也畫):只畫 k = 0 的話那條線有一半在畫布外,
    // tile 起來接縫上只剩半條寬(§7.1)。
    const N = 16;
    for (let k = 0; k <= N; k++) {
      const p = (k / N) * S, heavy = k % 4 === 0;
      g.strokeStyle = heavy ? 'rgba(108,150,156,0.5)' : 'rgba(108,150,156,0.26)';
      g.lineWidth = heavy ? 1.7 : 0.9;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
    }
    // 修正液:稠、不透明、邊緣不平,收筆會積一坨。所以每條疊兩道(寬的那道半透明
    // 當溢出來的邊),而且取樣用**段數**不是固定步長。
    const FLUID = '#f5f2e8';                 // = 馬路虛線的色,同一瓶
    const fluid = (x1: number, y1: number, x2: number, y2: number): void => {
      const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L, ny = dx / L;
      for (let pass = 0; pass < 2; pass++) {
        g.globalAlpha = pass ? 0.4 : 1;
        g.strokeStyle = FLUID;
        g.lineWidth = pass ? 7.0 : 4.4;
        g.lineCap = 'round';
        g.beginPath();
        const SEG = 14;
        for (let q = 0; q <= SEG; q++) {
          const t = q / SEG;
          const w = Math.sin(t * Math.PI * 3 + pass * 1.7) * 0.85;
          const px = x1 + dx * t + nx * w, py = y1 + dy * t + ny * w;
          if (q === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.stroke();
      }
      g.globalAlpha = 1;
    };
    const M = 22, E = S - 22;
    fluid(M, M, E, M); fluid(E, M, E, E); fluid(E, E, M, E); fluid(M, E, M, M);
    fluid(M, S / 2, E, S / 2);
    for (let pass = 0; pass < 2; pass++) {   // 中圈,一樣疊兩道
      g.globalAlpha = pass ? 0.4 : 1;
      g.strokeStyle = FLUID;
      g.lineWidth = pass ? 7.0 : 4.4;
      g.beginPath();
      const SEG = 44;                        // 整圈,收頭要回到起點
      for (let q = 0; q <= SEG; q++) {
        const a = (q / SEG) * Math.PI * 2;
        const r2 = 46 + Math.sin(a * 5 + pass) * 0.9;
        const px = S / 2 + Math.cos(a) * r2, py = S / 2 + Math.sin(a) * r2;
        if (q === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  });
}

// ── 沙地:橡皮擦屑 ───────────────────────────────────────────────────────
//
// 「沒有結構,只有顆粒」的那一格,而且它的顆粒是**有來歷的**:橡皮擦就是這個
// 世界的房子(`ERASER_COLORS`),擦掉的東西堆在桌上就是沙。全世界只有這一塊地是
// 「淡彩色的顆粒」,顏色與粗糙感是它在 6.3 m 掠角下唯一活得下來的訊號(§3.4)。
//
// 這張**不能**走中性貼圖 + 染色那條路:它的識別點就是六個顏色混在一起,乘一個
// material.color 會把六色壓成一色,那就只是一片有雜點的土。
const LU_SAND_TILE = 4;
/** demo 的 `luSandTex`。 */
function createSandTexture(): THREE.CanvasTexture {
  return luCanvas(128, 0x6d1e55, (g, rng, wrap9, S) => {
    g.fillStyle = '#d3c7b6';                 // 磨下來的粉:橡皮 + 紙屑,偏暖的灰
    g.fillRect(0, 0, S, S);
    // 屑是**搓出來的一條**,不是圓點;而且大部分是**沒有顏色的**。
    // 第一版拿六個橡皮擦色平均抽,出來是一面彩色紙屑 —— 紙屑/亮片是「亮粉雨」
    // 已經佔走的身分(§3.3)。實際上一張桌上同時在用的橡皮擦只有一兩塊,磨下來
    // 的絕大多數是白橡膠粉跟紙屑,彩色的只是偶爾混進去的一撮。所以這個袋子裡
    // 十八份只有六份是彩的(= 三分之一),而且還要往白調 0.42。
    const CRUMB = ERASER_COLORS
      .map((c) => `#${c.toString(16).padStart(6, '0')}`)
      .concat([
        '#efe7d8', '#efe7d8', '#e4dac6', '#e4dac6', '#f4efe4', '#e9e0cf',
        '#c3b7a3', '#c3b7a3', '#b3a692', '#b3a692', '#d8cdba', '#cabfab',
      ]);
    for (let i = 0; i < 250; i++) {
      const x = rng() * S, y = rng() * S;
      const len = 2.4 + rng() * 4.6, w = 0.75 + rng() * 0.95, rot = rng() * Math.PI;
      const col = gouacheTint(CRUMB[Math.floor(rng() * CRUMB.length)], 0.42, 0.34 + rng() * 0.4);
      wrap9(() => {
        g.fillStyle = col;
        g.beginPath();
        g.ellipse(x, y, len, w, rot, 0, 6.284);
        g.fill();
      }, x, y, len + 1);
    }
    // 捲起來的那幾條。橡皮擦推久了屑會捲成一小段弧 —— 這是「屑」跟「顆粒」
    // 差在哪裡的地方,只有它是**有長度、有方向**的。
    for (let i = 0; i < 34; i++) {
      const x = rng() * S, y = rng() * S, r = 2.6 + rng() * 4.4;
      const a0 = rng() * 6.28, sweep = 1.6 + rng() * 2.4;
      const col = gouacheTint(CRUMB[Math.floor(rng() * CRUMB.length)], 0.34, 0.4 + rng() * 0.35);
      const lw = 0.9 + rng() * 0.9;
      wrap9(() => {
        g.strokeStyle = col;
        g.lineWidth = lw;
        g.beginPath();
        g.arc(x, y, r, a0, a0 + sweep);
        g.stroke();
      }, x, y, r + lw + 1);
    }
    // 粗糙感:高頻的細點。屑之間漏下去的更細的粉,遠看就是「這片地是粗的」。
    for (let i = 0; i < 460; i++) {
      const x = rng() * S, y = rng() * S, s2 = 0.6 + rng() * 1.0;
      const al = 0.08 + rng() * 0.18, dark = rng() > 0.5;
      wrap9(() => {
        g.globalAlpha = al;
        g.fillStyle = dark ? '#8e8272' : '#f6efe2';
        g.fillRect(x, y, s2, s2);
      }, x + s2 / 2, y + s2 / 2, s2);
    }
    g.globalAlpha = 1;
  });
}

// ── 遊樂場的鋪面:軟木 ───────────────────────────────────────────────────
//
// 布告欄那種軟木。它是這頁唯一一件軟木,而軟木只是「底色 + 一堆斑」—— 跟 demo
// 的 `kraftNeutral` 一模一樣的結構,所以**不另外刷一張造型 canvas**,直接染色 +
// 把 repeat 放大讓斑變粗(§6 這個世界的解法)。
const LU_PLAY_TILE = 3;
/**
 * demo 的 `kraftNeutral = kraftTexture('#ffffff', '#8f8f8f', 700)` —— 中性的紙斑,
 * 白底,顏色一律由 `material.color` 帶。
 *
 * 唯一的偏離:demo 這支用 `Math.random()`,這裡改成種子流。斑點是中性的,換掉
 * 看不出差別;但 gameview 的 probe 會拿貼圖比對,不定的雜訊會讓它每次都不一樣。
 */
function createKraftNeutralTexture(): THREE.CanvasTexture {
  return luCanvas(256, 0x6b4a1f, (g, rng, _wrap9, S) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 700; i++) {
      g.fillStyle = '#8f8f8f';
      g.globalAlpha = 0.05 + rng() * 0.1;
      g.fillRect(rng() * S, rng() * S, 1 + rng() * 2, 1);
    }
    g.globalAlpha = 0.05;
    g.strokeStyle = '#8f8f8f';
    for (let i = 0; i < 40; i++) {
      g.beginPath();
      const y = rng() * S;
      g.moveTo(rng() * S, y);
      g.lineTo(rng() * S, y + (rng() - 0.5) * 8);
      g.stroke();
    }
    g.globalAlpha = 1;
  });
}

// ── 五格地被的顏色 ───────────────────────────────────────────────────────
// 貼圖是中性灰,所以這裡的 color 比想要的成品色**亮一階** —— 乘完才是那塊地的
// 顏色。三組都是 demo 的字面值。

/**
 * 農田。素模式是生瓦楞的牛皮色,上色模式刷成熟麥的土黃綠。
 * **不准刷成 park 那種草綠**:公園已經是草綠,兩塊地在掠角下就只剩「有沒有壟」
 * 可以分,顏色再撞一次等於白做(§3.3)。
 * demo 量到的貼圖平均亮度 **0.748**,所以 `#d3c368 × 0.748 ≈ #9e924e`(熟麥的
 * 土黃綠)、`#e9c896 × 0.748 ≈ #ae9670`(≈ BOARD `#bda07a`,生瓦楞的牛皮色)。
 */
const LU_FARM_PLAIN = 0xe9c896;
const LU_FARM_PAINTED = 0xd3c368;
/**
 * 濕地。素模式是泡過水、比乾的深一階的牛皮板;上色模式刷青綠(水草 + 濁水)。
 * 貼圖平均亮度 **0.800**,所以 `#8caf92 × 0.8 ≈ #708c75`(比公園的草綠灰一階、
 * 暗一階 —— 兩塊地在掠角下才分得開)、`#c2a170 × 0.8 ≈ #9b815a`(比 BOARD 深)。
 */
const LU_WET_PLAIN = 0xc2a170;
const LU_WET_PAINTED = 0x8caf92;
/** 遊樂場的軟木。上色模式刷成磚紅:橡膠鋪面本來就是那個顏色,而且跟四周的
 *  綠/土色拉得開。 */
const LU_PLAY_PLAIN = 0xbf9862;
const LU_PLAY_PAINTED = 0xb06a4c;
/*
 * `LU_SPORTS_GLOW` USED TO BE HERE — a cold-white emissive on the whole pitch.
 * Deleted with the mechanism: 「球場亮起來很怪(變成一種招牌)」, and demo
 * agrees («這片地自己不發光…改成場邊站一支螢光筆路燈»). All five landuse kinds
 * are now dark on their own; the pitch and the playground each get one of this
 * world's EXISTING street lamps, identified by the patch's own seed.
 */

// ── 站得起來的那些的幾何 ─────────────────────────────────────────────────
// 全部共用(`buildLanduseProps` 會標 `userData.shared`),絕對不可以在 chunk 回收
// 時 dispose —— 一個 chunk 可以有十塊地,收掉就是把還在用的別的 chunk 弄掛(§6)。

/** 長尾夾本體:下寬上窄的梯形柱。就是從側面看那個夾子。demo 的 `luClipBody`。 */
function buildClipBodyGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.5, 0);
  s.lineTo(0.5, 0);
  s.lineTo(0.19, 1);
  s.lineTo(-0.19, 1);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
  geo.translate(0, 0, -0.5);
  return geo;
}

/** 手把:半圈鐵絲。段數只給 4×10 —— 遠處一根幾個 pixel 粗的線,再細分是白付
 *  (§3.4)。demo 的 `luClipArm`。 */
function buildClipArmGeometry(): THREE.BufferGeometry {
  return new THREE.TorusGeometry(0.5, 0.05, 4, 10, Math.PI);
}

/**
 * 滑梯:一片厚紙板**折**過來 —— 立起來的背板 + 斜下去的滑面,是同一片紙,所以
 * 外框是一條等厚的折線(不是兩塊板拼的)。厚度 0.12(高 1 的單位裡)= 成品約
 * 0.35 m,§3.4 的「卡片類厚度不得低於 0.3」踩在線上。demo 的 `luSlide`。
 */
function buildSlideGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(0, 1);            // 背板外側
  s.lineTo(1.66, 0.15);      // 滑面(上表面)
  s.lineTo(1.6, 0.05);       // 板厚:滑面的下緣
  s.lineTo(0.12, 0.93);      // 折回來
  s.lineTo(0.12, 0);         // 背板內側
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
  geo.translate(0, 0, -0.5);
  return geo;
}

/** demo 的 `unitCyl(6)`:直徑 1、高 1 的六角柱,蘆葦一根就是它。 */
function buildReedGeometry(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
}

/** 蘆葦 = **毛根(扭扭棒)剪成的短段**,插在泡軟的板子上。
 *  ⚠ 不用迴紋針:騎手本人就是一支迴紋針,同一件文具不能有兩個身分(§3.3)。
 *  毛根另外解決一件事:§3.4 說細桿子在遠處會消失,而毛根是**毛的** —— 它的輪廓
 *  本來就比它的芯粗,是這張桌子上唯一「軟、蓬、有絨毛」的手感(§3.2)。 */
const LU_REED_COLOR = 0x7d9752;
/** 長尾夾的黑鋼本體。烤漆是霧的,所以走 toon 不走 Phong(手把才是金屬)。 */
const LU_CLIP_COLOR = 0x3a3f45;
/** 圖釘的針 —— 這個世界的「鐵絲」,不是新東西。demo 的 `pinMetalMat`,跟
 *  `buildCheckpoint` 的釘桿是同一組數字(檢查點自己擁有一份,因為通過時要淡出)。 */
const LU_PIN_METAL_COLOR = 0xc8cdd4;
/**
 * 一塊地上的道具最多散多遠(公尺)。**這是 demo 沒有的一條**,而且是 gameview
 * 才會遇到的問題:demo 的地塊是它自己切出來的,真實 MVT 的一塊濕地可以是**整座
 * 保護區**(`LandusePropContext.radius` 的註解寫著同一件事)。照 `r` 去散的話
 * 五叢蘆葦會相隔幾百公尺,一叢都讀不出來 —— 而「一叢一叢」正是濕地對著農田的
 * 那條軸線。數量的上限照抄 demo(蘆葦五叢、夾子兩座),只有**散開的半徑**被夾住。
 */
const LU_SPREAD_MAX = 60;

/**
 * The self-healing cutting mat the diorama is built on — the demo's mat, same
 * drawing and same seed, so the two worlds are literally the same tool.
 *
 * Three marks and nothing else: the green PVC, the printed grid (every fifth
 * line heavier, which is what makes it a measuring surface rather than graph
 * paper), and the scars. The scars are what sell it — a fresh mat is just a
 * green rectangle; a used one has been cut across in every direction, and the
 * cuts go PALE because that is what happens to self-healing PVC.
 *
 * SEAMS: the grid loop runs `i <= CELLS`, so a half-width line is drawn at u=0
 * and the other half at u=1. Across a tile boundary the two halves meet and make
 * one full line. Drop either end and every seam becomes a visible thin line.
 *
 * ⚠ THE RNG IS THE DEMO'S, and it has to be. The seed `0xc077ed` was copied
 * across but the generator was not — this drew its scars from `makeRng`
 * (xorshift32) while the demo draws them from `mulberry32`, so "same drawing and
 * same seed" was true of every line above and false of all 46 scars. Nothing
 * could see it: a scar is a random scratch either way, and the only check that
 * can is one that executes the demo's own source and compares the strokes
 * (`terrain-band-vs-demo.ts` `[cutting mat texture vs demo]`, which is exactly
 * how this was found).
 */
function createCuttingMatTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rng = mulberry32(0xc077ed);

  ctx.fillStyle = `#${new THREE.Color(CUTTING_MAT_COLOR).getHexString()}`;
  ctx.fillRect(0, 0, size, size);

  const step = size / CUTTING_MAT_CELLS;
  for (let i = 0; i <= CUTTING_MAT_CELLS; i++) {
    const p = i * step;
    const major = i % 5 === 0;
    ctx.strokeStyle = `rgba(${CUTTING_MAT_GRID},${major ? 0.34 : 0.15})`;
    ctx.lineWidth = major ? 1.6 : 0.9;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }

  // Knife scars, every which way — a mat that has been worked on.
  for (let i = 0; i < 46; i++) {
    ctx.globalAlpha = 0.05 + rng() * 0.16;
    ctx.strokeStyle = CUTTING_MAT_SCAR;
    ctx.lineWidth = 0.6 + rng() * 0.9;
    const x = rng() * size;
    const y = rng() * size;
    const a = rng() * Math.PI;
    const len = 8 + rng() * 60;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // The disc's UVs are scene metres (see mountain-ring.setMetreUVs).
  tex.repeat.set(1 / CUTTING_MAT_TILE_METERS, 1 / CUTTING_MAT_TILE_METERS);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Plane-shaped balloon tethered over an aerodrome (the user's pick over a "real"
 * paper plane). Origin is the ground anchor: a little sandbag, a string, and a
 * fat balloon with card wings floating ~12 m up.
 */
function buildPlaneBalloon(gradient: THREE.DataTexture): THREE.Group {
  const group = new THREE.Group();

  // No demo draws an aeroway prop (`props-vs-demo.ts` pins that), so there is no
  // value to copy — but the SHELF still has to be this world's (§3.8). The red is
  // the demo's own paper red (`awningMats`' plain state `#d9564a`, the folded
  // card awning) instead of the brighter `#e86a5a` that came from nowhere, and
  // the tether is the same string colour the finish airship's rigging uses, so
  // this world has ONE string rather than two that nearly match.
  const balloonMat = new THREE.MeshToonMaterial({ color: 0xd9564a, gradientMap: gradient });
  const creamMat = kraftMaterial(gradient, 0xf2e8d0);
  const cardMat = kraftMaterial(gradient, KRAFT_COLOR);
  const stringMat = new THREE.MeshToonMaterial({ color: 0x6a5535, gradientMap: gradient });

  const FLOAT_H = 12;

  // Fat balloon body — a squashed sphere, nose slightly up like it is straining
  // at the string.
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 14), balloonMat);
  body.scale.set(3.1, 2.0, 2.0);
  body.position.y = FLOAT_H;
  body.rotation.z = 0.08;
  group.add(body);

  // Cream nose cap + a card propeller crossed on it.
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.9, 14, 10), creamMat);
  nose.scale.set(0.7, 1, 1);
  nose.position.set(3.0, FLOAT_H + 0.25, 0);
  group.add(nose);
  for (const tilt of [0, Math.PI / 2]) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.4, 0.5), cardMat);
    blade.position.set(3.7, FLOAT_H + 0.25, 0);
    blade.rotation.x = tilt;
    group.add(blade);
  }

  // Card wings through the body, and a two-card tail.
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 7.2), cardMat);
  wing.position.set(0.4, FLOAT_H + 0.4, 0);
  group.add(wing);
  const tailFin = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.6, 0.12), balloonMat);
  tailFin.position.set(-2.8, FLOAT_H + 1.3, 0);
  group.add(tailFin);
  const tailPlane = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 3.0), cardMat);
  tailPlane.position.set(-2.8, FLOAT_H + 0.7, 0);
  group.add(tailPlane);

  // Tether: string from the belly down to a sandbag at the origin.
  const string = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, FLOAT_H - 1.6, 5),
    stringMat,
  );
  string.position.y = (FLOAT_H - 1.6) / 2 + 0.4;
  group.add(string);
  const sandbag = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.9), cardMat);
  sandbag.position.y = 0.28;
  group.add(sandbag);

  return group;
}

/**
 * Paperclip bike — bent-wire frame, torus wheels with three spokes, an eraser
 * saddle. Local axes: forward = +x, axle = z (see bike-ornament.ts).
 * Recipe lifted from `plan/ref-demo-paper-src.js`.
 */
function buildPaperclipBike(gradient: THREE.DataTexture): BikeOrnamentParts {
  const root = new THREE.Group();
  const lean = new THREE.Group();
  root.add(lean);

  const wire = new THREE.MeshPhongMaterial({ color: 0xcdd3da, specular: 0xffffff, shininess: 140 });
  const wireGold = new THREE.MeshPhongMaterial({ color: 0xd9b04a, specular: 0xfff6d0, shininess: 140 });
  const eraser = kraftMaterial(gradient, 0xf0879a);
  const pedalMat = kraftMaterial(gradient, 0x5a5f66);

  const R = 2.1;
  const wheels: THREE.Object3D[] = [];
  for (const x of [-2.9, 2.9]) {
    const wheel = new THREE.Group();
    // The demo's paperclip bike declares exactly three casters — `rim`,
    // `frame`, `saddle` — and no receivers. Its `batchGroup()` then ORs the
    // flags over the three spokes (all false), so the spoke batch stays off;
    // that OR is the whole reason the rim is a separate mesh from them here.
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.17, 10, 42), wire);
    rim.castShadow = true;
    wheel.add(rim);
    for (let i = 0; i < 3; i++) {
      const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, R * 2 - 0.3, 6), wire);
      spoke.rotation.z = (i / 3) * Math.PI;
      wheel.add(spoke);
    }
    wheel.add(new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), wireGold));
    wheel.position.set(x, R, 0);
    lean.add(wheel);
    wheels.push(wheel);
  }

  const framePath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-2.9, R, 0),
    new THREE.Vector3(-1.0, 5.1, 0),
    new THREE.Vector3(-0.1, 2.3, 0),
    new THREE.Vector3(2.3, 5.3, 0),
    new THREE.Vector3(2.9, R, 0),
  ], false, 'catmullrom', 0.12);
  const frame = new THREE.Mesh(new THREE.TubeGeometry(framePath, 48, 0.17, 8), wire);
  frame.castShadow = true;
  lean.add(frame);
  lean.add(new THREE.Mesh(new THREE.TubeGeometry(
    new THREE.LineCurve3(new THREE.Vector3(-1.0, 5.0, 0), new THREE.Vector3(2.25, 5.2, 0)),
    2, 0.15, 8,
  ), wire));

  // The paperclip's signature: the wire loops back on itself at the seat tube.
  const loop = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.14, 8, 20), wireGold);
  loop.position.set(-1.0, 5.5, 0);
  lean.add(loop);

  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 3.4, 8), wire);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(2.3, 5.6, 0);
  lean.add(bar);
  for (const s of [-1, 1]) {
    const grip = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 8), wireGold);
    grip.position.set(2.3, 5.6, 1.7 * s);
    lean.add(grip);
  }

  const saddle = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.7, 1.1), eraser);
  saddle.position.set(-1.05, 5.95, 0);
  saddle.rotation.z = 0.05;
  saddle.castShadow = true;
  lean.add(saddle);

  const crank = new THREE.Group();
  crank.position.set(-0.1, 2.3, 0);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.5, 6), wire);
    arm.position.set(0, 0.75 * s, 0.5 * s);
    crank.add(arm);
    const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.25, 0.6), pedalMat);
    pedal.position.set(0, 1.5 * s, 0.75 * s);
    crank.add(pedal);
  }
  lean.add(crank);

  return { root, lean, wheels, crank, dispose: () => disposeGroup(root) };
}

/** Pencil street lamp — the sharpened tip is the bulb. */
/**
 * Street lamp: a HIGHLIGHTER, cap down over the nib.
 *
 * The route this world draws is a highlighter swipe (`HIGHLIGHTER_INK`), so the
 * thing standing beside it is the pen that drew it. Its transparent cap is a
 * ready-made lampshade — no need to invent one.
 *
 * WHAT GLOWS, AND WHY IT MATTERS (CUSTOM_WORLD_INSTRUCTIONS §3.10): the CHISEL
 * NIB inside the cap, not the pen. The old pencil lamp lit its whole tip and
 * read as a glowing lump; a light is a small bright thing seen through a shell
 * you can see into. Three conditions, all required — small, inside, and the
 * shell stays translucent (it must NOT go more opaque at night, which is the
 * counter-intuitive one: an opaque shell hides its own light source).
 *
 * No brand identity: barrel, a cap wider than the barrel, a clip, a chisel nib.
 * Nothing printed.
 */
const HL_INKS = [0xd9f52e, 0xff6fb0, 0x4fe3ff] as const;

/**
 * The four shapes every highlighter lamp shares, built once.
 *
 * Same measurement, same reasoning and the same shared/per-lamp split as the toy
 * world's `bubbleLampGeometry` — see the long note there. The corrugated pool is
 * the most expensive of the three because it carries four parts rather than
 * three: censused on an ordinary road it was **40 draw calls, 40 unique
 * geometries and 40 unique materials** for ten lamps, and 80/80/80 in a tunnel,
 * against CUSTOM_WORLD_INSTRUCTIONS §6's whole-world budget of 70 materials.
 *
 * `setNight` writes to `capMat`, `nibMat` and `glowMat`, and the pool's lamps
 * and the pitch-side lamps are deliberately told DIFFERENT nights inside a
 * tunnel (`street-lamp.ts`), so those three stay per-lamp. `barrelMat` is never
 * written to — one per ink, three for the world.
 */
interface HighlighterLampGeometry {
  barrel: THREE.BufferGeometry;
  cap: THREE.BufferGeometry;
  nib: THREE.BufferGeometry;
  glow: THREE.BufferGeometry;
}
let hlLampGeo: HighlighterLampGeometry | null = null;
const hlBarrelMats = new Map<number, THREE.MeshPhongMaterial>();

function highlighterLampGeometry(): HighlighterLampGeometry {
  if (hlLampGeo) return hlLampGeo;

  // Barrel + ferrule + nib seat + clip, merged: one draw call for the opaque
  // half. The clip belongs to the cap, but the cap never comes off and it is
  // the same colour, so merging it here costs nothing and saves a call.
  const barrelParts = [
    new THREE.CylinderGeometry(1.18, 1.18, 0.5, 12).translate(0, 0.25, 0),
    new THREE.CylinderGeometry(1.05, 1.05, 6.55, 12).translate(0, 3.775, 0),
    new THREE.CylinderGeometry(0.52, 1.05, 0.7, 12).translate(0, 7.4, 0),
    new THREE.CylinderGeometry(0.5, 0.5, 0.55, 10).translate(0, 8.02, 0),
    new THREE.BoxGeometry(0.24, 2.6, 0.58).translate(1.24, 9.2, 0),
    new THREE.BoxGeometry(0.36, 0.42, 0.58).translate(1.12, 10.55, 0),
  ];
  const barrel = mergeGeometries(barrelParts, false);
  for (const g of barrelParts) g.dispose();

  // The cap = the lampshade. DoubleSide so the far wall shows through (that is
  // the thickness cue); depthWrite off so it cannot occlude its own nib.
  // Added BEFORE the nib, like the demo's `hiliteLamp`.
  const capParts = [
    new THREE.CylinderGeometry(1.24, 1.24, 0.42, 14).translate(0, 7.71, 0),
    new THREE.CylinderGeometry(1.16, 1.16, 2.35, 14).translate(0, 9.095, 0),
    new THREE.CylinderGeometry(0.62, 1.16, 0.5, 14).translate(0, 10.52, 0),
    new THREE.CylinderGeometry(0.62, 0.62, 0.22, 14).translate(0, 10.88, 0),
  ];
  const cap = mergeGeometries(capParts, false);
  for (const g of capParts) g.dispose();

  const nib = new THREE.BoxGeometry(0.86, 1.55, 0.52).rotateZ(0.4).translate(0, 9.15, 0);
  const glow = new THREE.SphereGeometry(1.6, 12, 8);

  for (const g of [barrel, cap, nib, glow]) g.userData.shared = true;
  hlLampGeo = { barrel, cap, nib, glow };
  return hlLampGeo;
}

function highlighterBarrelMaterial(slot: number, ink: THREE.Color): THREE.MeshPhongMaterial {
  let mat = hlBarrelMats.get(slot);
  if (!mat) {
    mat = new THREE.MeshPhongMaterial({ color: ink, specular: 0xffffff, shininess: 60 });
    mat.userData.shared = true;
    hlBarrelMats.set(slot, mat);
  }
  return mat;
}

function buildHighlighterLamp(gradient: THREE.DataTexture, index: number): StreetLampParts {
  const group = new THREE.Group();
  const slot = index % HL_INKS.length;
  const ink = new THREE.Color(HL_INKS[slot]);
  const owned: (THREE.BufferGeometry | THREE.Material)[] = [];
  const geo = highlighterLampGeometry();

  const barrel = new THREE.Mesh(geo.barrel, highlighterBarrelMaterial(slot, ink));
  barrel.castShadow = true;
  group.add(barrel);

  const capMat = new THREE.MeshPhongMaterial({
    color: ink, transparent: true, opacity: 0.34, side: THREE.DoubleSide,
    specular: 0xffffff, shininess: 200, emissive: 0x000000, depthWrite: false,
  });
  group.add(new THREE.Mesh(geo.cap, capMat));
  owned.push(capMat);

  // The chisel nib — the only thing that lights up. Unlit (MeshBasic) so the
  // white-hot value `applyBulb` writes at night reaches the framebuffer whole:
  // a lit material would have it multiplied by the night's own ambient first,
  // and the bright spot inside the shade would come out darker than the shade.
  // Its colour starts as the raw ink, exactly like the demo's `hlNibMats` —
  // setNight() overwrites it on the first frame either way.
  const nibMat = new THREE.MeshBasicMaterial({ color: ink });
  group.add(new THREE.Mesh(geo.nib, nibMat));
  owned.push(nibMat);

  // Soft halo. Without bloom, emissive alone does not spill onto its
  // surroundings, and spill is most of what the eye reads as "glowing".
  const glowMat = new THREE.MeshBasicMaterial({
    color: ink, transparent: true, opacity: 0, depthWrite: false,
  });
  const glow = new THREE.Mesh(geo.glow, glowMat);
  glow.position.y = 9.15;
  group.add(glow);
  owned.push(glowMat);

  const light = new THREE.PointLight(ink, 0, 26, 1.8);
  light.position.y = 9.15;   // on the nib: the bright spot and the cast light agree
  group.add(light);

  let night = 0;
  let lightEnabled = true;

  return {
    group,
    setNight: (k) => {
      night = k;
      // The cap carries only a hint of the ink it is stained by, and goes
      // slightly MORE transparent at night — you have to be able to see in.
      capMat.emissive.setRGB(ink.r * k * 0.3, ink.g * k * 0.3, ink.b * k * 0.3);
      capMat.opacity = 0.34 - 0.06 * k;
      // The nib: felt soaked in ink by day, a white-hot core at night. The
      // white term is what lifts a saturated ink past "dark coloured shape" —
      // pure pink has a luminance of 0.35 and never reads as a light source.
      nibMat.color.setRGB(
        (1 - k) * (0.18 + ink.r * 0.55) + k * (0.7 + ink.r * 1.3),
        (1 - k) * (0.18 + ink.g * 0.55) + k * (0.7 + ink.g * 1.3),
        (1 - k) * (0.18 + ink.b * 0.55) + k * (0.7 + ink.b * 1.3));
      glowMat.opacity = k * 0.5;
      light.intensity = k * 14;
      // A dozen point lights in the scene cost real fragment work even at zero
      // intensity — hiding them by day takes them out of the render list.
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

// ── Finish airship (1930s zeppelin) ──

/**
 * Hull wrap — cream watercolour with longitudinal ink panel seams and two faint
 * girth rings. The hull sphere is pole-rotated onto the X axis, so canvas
 * verticals become nose→tail seams and converge at the tips for free.
 */
function createZeppelinHullTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(0x9e3779b9);

  // Cream base + loose watercolour blotches (some darker, some lighter).
  ctx.fillStyle = '#f2e8d0';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = rng() > 0.5 ? 'rgba(214,190,150,0.10)' : 'rgba(255,252,240,0.12)';
    ctx.beginPath();
    ctx.ellipse(rng() * w, rng() * h, 40 + rng() * 70, 25 + rng() * 40, rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  // Longitudinal panel seams (canvas verticals → nose-tail lines on the hull).
  ctx.strokeStyle = 'rgba(58,44,28,0.45)';
  ctx.lineWidth = 3;
  for (let i = 0; i < 6; i++) {
    const x = (i / 6) * w + 20;
    ctx.beginPath();
    ctx.moveTo(x + (rng() - 0.5) * 6, 0);
    for (let y = 16; y <= h; y += 16) {
      ctx.lineTo(x + (rng() - 0.5) * 7, y);
    }
    ctx.stroke();
  }

  // Two faint girth rings.
  ctx.strokeStyle = 'rgba(58,44,28,0.22)';
  ctx.lineWidth = 2;
  for (const fy of [0.34, 0.66]) {
    ctx.beginPath();
    ctx.moveTo(0, fy * h);
    for (let x = 24; x <= w; x += 24) {
      ctx.lineTo(x, fy * h + (rng() - 0.5) * 5);
    }
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Tail fin as a paper cutout — swept fin silhouette with a loose watercolour red
 * fill, a wobbly ink border, and root hatching, on a transparent canvas that is
 * alpha-tested onto a quad. One texture shared by all four fins.
 */
function createZeppelinFinTexture(): THREE.CanvasTexture {
  const s = 128;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(0xc2b2ae35);

  const jitter = (v: number) => v + (rng() - 0.5) * 4;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(jitter(26), jitter(118));
    ctx.lineTo(jitter(44), jitter(26));
    ctx.quadraticCurveTo(jitter(70), jitter(14), jitter(98), jitter(34));
    ctx.lineTo(jitter(106), jitter(118));
    ctx.closePath();
  };

  // Watercolour red — two loose passes so the edges bleed a little.
  ctx.fillStyle = 'rgba(200,106,90,0.55)';
  path();
  ctx.fill();
  path();
  ctx.fill();

  // Wobbly ink border.
  ctx.strokeStyle = 'rgba(42,32,24,0.95)';
  ctx.lineWidth = 6;
  ctx.lineJoin = 'round';
  path();
  ctx.stroke();

  // Root shading hatch.
  ctx.strokeStyle = 'rgba(42,32,24,0.28)';
  ctx.lineWidth = 3;
  for (let i = 0; i < 4; i++) {
    const x = 40 + i * 16;
    ctx.beginPath();
    ctx.moveTo(x, 112);
    ctx.lineTo(x + 8, 86);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Draw the rope-hung wooden sign into `ctx`: three kraft planks with wavy grain,
 * a hand-wobbled ink border, rope holes, and dark-ink serif text. Auto-shrinks
 * the font so long strings fit the 512-wide board.
 */
function drawWoodenSign(ctx: CanvasRenderingContext2D, w: number, h: number, text: string): void {
  ctx.clearRect(0, 0, w, h);
  const rng = makeRng(0x51a7c3d9);

  // Plank base + two plank separations.
  ctx.fillStyle = '#b98a4e';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(90,60,25,0.5)';
  ctx.lineWidth = 3;
  for (const fy of [1 / 3, 2 / 3]) {
    ctx.beginPath();
    ctx.moveTo(0, fy * h + (rng() - 0.5) * 4);
    for (let x = 40; x <= w; x += 40) {
      ctx.lineTo(x, fy * h + (rng() - 0.5) * 5);
    }
    ctx.stroke();
  }

  // Wavy wood grain.
  ctx.strokeStyle = 'rgba(90,60,25,0.28)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const y = (i + 0.5) * (h / 6);
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 26; x <= w; x += 26) {
      ctx.lineTo(x, y + Math.sin(x * 0.04 + i * 2) * 2.5 + (rng() - 0.5) * 3);
    }
    ctx.stroke();
  }

  // Hand-wobbled ink border (four polyline edges, not a ruler rectangle).
  const bx = 8;
  const by = 8;
  const bw = w - 16;
  const bh = h - 16;
  const wob = () => (rng() - 0.5) * 5;
  ctx.strokeStyle = 'rgba(58,42,24,0.9)';
  ctx.lineWidth = 6;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(bx + wob(), by + wob());
  for (let x = bx + 60; x <= bx + bw; x += 60) ctx.lineTo(x + wob(), by + wob());
  for (let y = by + 30; y <= by + bh; y += 30) ctx.lineTo(bx + bw + wob(), y + wob());
  for (let x = bx + bw - 60; x >= bx; x -= 60) ctx.lineTo(x + wob(), by + bh + wob());
  for (let y = by + bh - 30; y >= by; y -= 30) ctx.lineTo(bx + wob(), y + wob());
  ctx.closePath();
  ctx.stroke();

  // Rope holes at the top corners.
  ctx.fillStyle = '#3a2410';
  ctx.beginPath();
  ctx.arc(26, 22, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(w - 26, 22, 7, 0, Math.PI * 2);
  ctx.fill();

  // Ink text — 1930s serif.
  if (text) {
    let font = 56;
    const setFont = () => { ctx.font = `bold ${font}px Georgia, 'Times New Roman', serif`; };
    setFont();
    while (ctx.measureText(text).width > w - 60 && font > 22) {
      font -= 2;
      setFont();
    }
    ctx.fillStyle = '#2f1e0c';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 6);
  }
}

/**
 * 1930s zeppelin — a watercolour-wrapped hull (~25 m) with ink panel seams and
 * an inverted-hull outline, four paper-cutout tail fins, a strutted gondola, a
 * side-spinning tail propeller with a blur disc, a fluttering nose pennant, and
 * a rope-hung wooden sign. Every material sets `fog: false` so it stays visible
 * through weather fog (see FinishAirshipParts contract).
 */
function buildZeppelin(gradient: THREE.DataTexture): FinishAirshipParts {
  const root = new THREE.Group();
  const INK = 0x2a2018;
  const toon = (color: number) =>
    new THREE.MeshToonMaterial({ color, gradientMap: gradient, fog: false });

  // Body — hull + fins + gondola + prop (wobbles as one; banner hangs separately).
  const body = new THREE.Group();
  root.add(body);

  // Hull: pole-rotated sphere so the baked texture's seams run nose→tail.
  const hullTex = createZeppelinHullTexture();
  const hullGeo = new THREE.SphereGeometry(1, 36, 24);
  hullGeo.rotateZ(Math.PI / 2);
  const hull = new THREE.Mesh(
    hullGeo,
    new THREE.MeshToonMaterial({ color: 0xffffff, map: hullTex, gradientMap: gradient, fog: false }),
  );
  hull.scale.set(12.5, 4.4, 4.4);
  body.add(hull);

  // Ink outline via a slightly larger inverted (back-side) hull — fog:false so
  // the outline survives the weather fog like the hull it wraps.
  const outline = new THREE.Mesh(
    hullGeo,
    new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide, fog: false }),
  );
  outline.scale.set(13.0, 4.72, 4.72);
  body.add(outline);

  // Painted nose cap — mostly buried in the hull, pokes out at the tip.
  const noseCap = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 12), toon(0xc86a5a));
  noseCap.position.set(11.5, 0, 0);
  body.add(noseCap);

  // Four tail fins — flat paper cutouts (ink border + watercolour red baked in
  // the shared texture), rotated round the hull axis. Unlit on purpose: flat
  // card reads more hand-drawn than a shaded box.
  const finTex = createZeppelinFinTexture();
  const finMat = new THREE.MeshBasicMaterial({
    map: finTex,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    fog: false,
  });
  const finGeo = new THREE.PlaneGeometry(5.0, 5.0);
  for (let i = 0; i < 4; i++) {
    const holder = new THREE.Group();
    holder.rotation.x = (i * Math.PI) / 2;
    const fin = new THREE.Mesh(finGeo, finMat);
    fin.position.set(-9.6, 3.6, 0);
    holder.add(fin);
    body.add(holder);
  }

  // Gondola — hangs below the hull on two struts, with an ink outline shell and
  // a row of porthole dots on the near face.
  const gondola = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.5, 2.0), toon(0xd9c79a));
  gondola.position.set(1.2, -5.3, 0);
  body.add(gondola);
  const gondolaOutline = new THREE.Mesh(
    new THREE.BoxGeometry(4.4, 1.5, 2.0),
    new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide, fog: false }),
  );
  gondolaOutline.scale.setScalar(1.14);
  gondolaOutline.position.copy(gondola.position);
  body.add(gondolaOutline);
  // Portholes are the airship's OWN ink, not a second dark. They used to be
  // `0x2a2038` — a blue-violet black, the only cool value anywhere on this prop,
  // in a world whose every other dark is warm (§3.8).
  const winMat = toon(INK);
  for (let i = 0; i < 3; i++) {
    const dot = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.12, 10), winMat);
    dot.rotation.x = Math.PI / 2;
    dot.position.set(0.1 + i * 1.15, -5.15, 1.06);
    body.add(dot);
  }
  const strutMat = toon(0x6a5535);
  const strutGeo = new THREE.CylinderGeometry(0.07, 0.07, 1.3, 6);
  for (const sx of [-0.4, 2.8]) {
    const strut = new THREE.Mesh(strutGeo, strutMat);
    strut.position.set(sx, -4.35, 0);
    body.add(strut);
  }

  // Tail propeller — spins about the hull's long axis (a pusher prop), with a
  // faint translucent disc selling the motion blur.
  const prop = new THREE.Group();
  prop.position.set(-12.9, 0, 0);
  prop.add(new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), toon(0x8a6a48)));
  const bladeMat = toon(0xc86a5a);
  const bladeGeo = new THREE.BoxGeometry(0.16, 4.6, 0.6);
  const blade1 = new THREE.Mesh(bladeGeo, bladeMat);
  const blade2 = new THREE.Mesh(bladeGeo, bladeMat);
  blade2.rotation.x = Math.PI / 2;
  prop.add(blade1, blade2);
  const blurDisc = new THREE.Mesh(
    new THREE.CircleGeometry(2.5, 24),
    new THREE.MeshBasicMaterial({
      color: 0xf2e8d0,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
    }),
  );
  blurDisc.rotation.y = Math.PI / 2;
  prop.add(blurDisc);
  body.add(prop);

  // Nose pennant — a little red flag streaming off the nose tip.
  const pennantShape = new THREE.Shape();
  pennantShape.moveTo(0, 0);
  pennantShape.lineTo(2.4, 0.35);
  pennantShape.lineTo(0, 0.7);
  pennantShape.closePath();
  const pennant = new THREE.Mesh(
    new THREE.ShapeGeometry(pennantShape),
    new THREE.MeshBasicMaterial({ color: 0xc86a5a, side: THREE.DoubleSide, fog: false }),
  );
  pennant.position.set(12.6, 0.5, 0);
  body.add(pennant);

  // Rope-hung wooden sign (banner) — hung from root so the hull wobble doesn't
  // swing it; it gets its own gentle pendulum sway instead.
  const signGroup = new THREE.Group();
  const ropeMat = toon(0x6a5535);
  const ropeGeo = new THREE.CylinderGeometry(0.07, 0.07, 3.8, 5);
  for (const sx of [-3.4, 3.4]) {
    const rope = new THREE.Mesh(ropeGeo, ropeMat);
    rope.position.set(sx * 0.92, -6.3, 0);
    rope.rotation.z = sx > 0 ? -0.12 : 0.12;
    signGroup.add(rope);
  }
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  drawWoodenSign(ctx, canvas.width, canvas.height, '');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const panelMat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, fog: false });
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(11, 2.75), panelMat);
  panel.position.set(0, -8.9, 0);
  panel.rotation.z = 0.03; // a hair off level — hand-hung
  signGroup.add(panel);
  root.add(signGroup);

  return {
    root,
    setBannerText: (text: string) => {
      drawWoodenSign(ctx, canvas.width, canvas.height, text);
      texture.needsUpdate = true;
    },
    setBannerVisible: (visible: boolean) => {
      signGroup.visible = visible;
    },
    update: (dt: number, elapsed: number) => {
      prop.rotation.x += dt * 6;
      body.rotation.z = Math.sin(elapsed * 1.3) * 0.03; // gentle hull wobble
      pennant.rotation.x = Math.sin(elapsed * 4.2) * 0.25; // pennant flutter
      signGroup.rotation.z = Math.sin(elapsed * 0.9) * 0.04; // sign sway
    },
    dispose: () => {
      // CanvasTextures — disposeGroup doesn't touch material.map.
      hullTex.dispose();
      finTex.dispose();
      texture.dispose();
      disposeGroup(root);
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Zone buildings — five districts, five things off the same desk
// ══════════════════════════════════════════════════════════════════════════
/**
 * Ported from `plan/paper-town-demo.html`: `flagDispenser`, `tapeDispenser`,
 * `fileBoxSchool`, `pillBox`. The eraser house above is the fifth.
 *
 * Five zones, five shape languages — and the MATERIAL is half the identity, not
 * just the outline. Five kraft boxes would be no variation at all, so each one
 * owns something none of the others has:
 *   residential  matte rubber + kraft sleeve  (eraser — the only worn edge)
 *   commercial   carton + fluorescent paper   (the only saturated colour, and
 *                                              the only angled front)
 *   industrial   dark slate + steel           (the only dark mass, only metal)
 *   school       corrugated box + bezels      (the only body whose mass repeats,
 *                                              and the only handle bezels)
 *   hospital     white card + red             (the only white mass)
 *
 * ⚠ The school's identity line used to be "the only rows of round things" (the
 * abacus). Nothing inherited that when it became a stack of file boxes, so the
 * demo moved the claim onto two features that are mechanically checkable
 * instead: the MASS repeats three times, each under its own lid course (no other
 * body repeats its mass at all — note the claim is not "more than one rim", as
 * the tape dispenser wears two identical steel bands), and the `RING_COLORS`
 * bezels are worn by no other building. `npm run check:3d` pins both, so the
 * next person to retune a body gets stopped rather than trusted.
 *
 * The eraser's rules still hold, plus three the demo paid for:
 *  1. NO rounded corners — a rounded block is a bar of soap. Tape rolls are
 *     genuinely round objects and do not count.
 *  2. Masses stay SOLID. A hollow one opens a hole in the skyline and the whole
 *     building disappears backlit, which is why the file box's handle "hole" is
 *     not an opening at all: it is a solid dark slab set 0.28 m behind a raised
 *     bezel, and the recess is read off that step.
 *  3. Nothing thinner than ~0.3 m. The chase camera's eye is only 6.3 m above
 *     the rider (`fps-camera.ts` CHASE_UP), so a card seen edge-on has almost no
 *     area: dispenser lips, index tabs, cutter teeth, lids and marks all get
 *     real thickness.
 *  4. No system font anywhere. The hospital mark is a geometric triangle, and
 *     lettering is `sign-spec.ts`'s job.
 *
 * Copyright: generic forms of generic stationery and office supplies (index-tab
 * dispenser, tape dispenser, side-handled archive box, pill box). No maker's name,
 * part number, logo or packaging pattern; the palette below is this file's own.
 */

// ── Palette ──
// The demo's PLAIN-board tones. Its second, painted state rides on `swappable`,
// which has no counterpart here yet (plan/migrate-demo-worlds.md §4, third
// priority) — porting the shapes does not need it, and half a two-state system
// would be worse than none.
const CARTON_COLOR = 0xac7e42;
const CARTON_RIM_COLOR = 0xcbb287;
const SHOP_GLASS_COLOR = 0x4d6b7a;
/**
 * The tabs alight — the demo's `nightLit(tabMats[i], '#b8862e')`.
 *
 * This value used to be the WINDOW PANES' glow, and moving it is the whole
 * point: a row of lit panes reads as an office block at night, which is the one
 * thing this district must not look like. Index tabs are translucent label
 * paper, so light coming through them is something the object already does —
 * the same "the light lives on a part the body already has" rule the eraser's
 * film and the pill box's compartments follow. The panes still get painted by
 * day; they simply do not glow.
 *
 * ONE warm glow for all four tab colours, not four. Four saturated glows read as
 * a fairground, and every other district in this world lights warm.
 */
const TAB_GLOW = 0xb8862e;
/** Index tabs: the most saturated colour in the world, and the only place it is
 *  allowed to appear. (The demo's `TAB_COLORS` — the same four hexes the sticky
 *  notes wore before the shopfront became a tab dispenser; what changed is the
 *  part, not the pigment.) */
const TAB_COLORS = [0xffd94a, 0xff9ec4, 0x8fd8f0, 0xc6f533] as const;
/** Coloured paper, two to a set. The awning it was cut for is retired; the
 *  playground slide is the only part still using it, and it stays here because
 *  it is a MATERIAL rather than that one part. */
const AWNING_COLORS = [0xd9564a, 0xf0e6cc] as const;

const TAPE_BASE_COLOR = 0x4b525c;
const TAPE_ROLL_COLOR = 0xa9783c;
const TAPE_HUB_COLOR = 0xb8412f;
const TAPE_HUB_GLOW = 0xad5a18;
const BLADE_COLOR = 0xc3c9d2;

/**
 * The school's file boxes. The one trap here is that COMMERCIAL is also a
 * carton, so the two are pulled apart on both axes the demo pulls them apart on:
 * texture (the shopfront is smooth kraft, the file box shows its corrugation)
 * and tone — the carton is a warm `#ac7e42` (H33 S45 L47) against the file box's
 * greyed `#b0a68c` (H40 S18 L62), 27 points of saturation apart.
 */
const FILE_BOX_COLOR = 0xb0a68c;
/** The lid is a step DARKER than the body. A real archive box's lid matches it,
 *  but three same-coloured rims stacked read as one column from down the street,
 *  and those three lines are what makes the repeat legible now that the abacus
 *  is gone. */
const FILE_LID_COLOR = 0x8e846c;
/** The recessed face inside a handle hole. NOT a cut-out — see `fileBoxParts`. */
const FILE_HOLE_COLOR = 0x332c25;
/** The bezel round each handle hole, one colour per box in the stack. These four
 *  are the demo's own `RING_PLAIN`, and they appear on no other building in this
 *  world: with the abacus retired they are half of what identifies a school. */
const RING_COLORS = [0xd8503c, 0xe8a63a, 0x4f95c6, 0x3f8b6e] as const;
/**
 * Which ring colour is the school's night light — ONE whole colour, not a
 * random scatter. Two things fall out of that: the daytime colour scheme is
 * untouched (the lit rings were already the amber ones), and because a box's
 * colour is `(c0 + tier) % 4` with `c0` drawn once per building, what lights up
 * is one whole FLOOR of handles — a different floor on every school, so a street
 * of them is not one glowing band repeated.
 */
const RING_LIT_INDEX = 1;
/** demo `nightLit(ringMats[1], '#b07d1c')`. */
const RING_LIT_GLOW = 0xb07d1c;

const PILL_BODY_COLOR = 0xf2ece0;
const PILL_LID_COLOR = 0xded6c4;
const PILL_CELL_COLOR = 0xf7f2e8;
/** demo `pillCellLitMat = nightLit(swappable(toon({}), PILL_CELL_PLAIN,
 *  PILL_CELL_PAINT), '#c9a45c')` — the lit compartments are the SAME material as
 *  the dark ones by day («兩個材質白天完全一樣…差別只有 emissive»). */
const PILL_CELL_GLOW = 0xc9a45c;
const PILL_BAND_COLOR = 0x3f7fb5;
/** The hospital mark is a red TRIANGLE, never a red cross: the white-ground red
 *  cross is protected by the Geneva Conventions and by national law almost
 *  everywhere. Same reasoning as `sign-spec.ts`. */
const HOSPITAL_MARK_COLOR = 0xd0402f;

/**
 * Zone → building type is a BIAS, not a mapping (the demo's `ZONE_MIX`). A hard
 * mapping stands one model in a row down every street; a real district has a
 * shop among the houses and a clinic beside the school. 80 % the zone's
 * signature building, 20 % a neighbour.
 */
const ZONE_MIX: Record<ZoneKind, readonly ZoneKind[]> = {
  residential: ['commercial', 'school'],
  commercial: ['residential', 'hospital'],
  industrial: ['commercial', 'residential'],
  school: ['residential', 'hospital'],
  hospital: ['residential', 'school'],
};

/**
 * Which of the five this footprint builds.
 *
 * Deterministic in `seed` ALONE, from its own RNG stream. Deliberately NOT a
 * shuffle bag: a bag carries state between calls, so the answer would depend on
 * the order buildings happen to be visited — and the body, the trim and the
 * lights are asked for at three different points in that order and must all
 * agree. (It must not read the chunk's shared stream either: adding a feature
 * that consumes from it re-rolls every building on the route.)
 *
 * Off the zone map it is always the eraser. "Outside every district" must never
 * be read as "residential district" — a rural route is not a suburb.
 */
function paperBuildingKind(zone: ZoneKind | null, seed: number): ZoneKind {
  if (!zone) return 'residential';
  const rng = mulberry32((seed * 2246822519 + 0x2f1b) >>> 0);
  if (rng() < 0.8) return zone;
  const near = ZONE_MIX[zone];
  return near[Math.floor(rng() * near.length)] ?? zone;
}

/** Lift trim built in the box's LOCAL frame into the scene coordinates
 *  `buildBuildingDecoration` has to return. */
function placeTrim(box: BuildingBox, ...parts: THREE.Object3D[]): THREE.Group {
  const group = new THREE.Group();
  for (const p of parts) group.add(p);
  group.position.set(box.cx, box.baseY, box.cz);
  group.rotation.y = box.rotY;
  return group;
}

// ── The demo's shared unit geometry ─────────────────────────────────────────
//
// `plan/paper-town-demo.html` builds its bodies out of six shapes and instances
// them (`shared('tooth')`, `unitCyl(18)`, `shared('tri')`, `unitBox`, `unitPlane`) — that `THREE.Group` of `InstancedMesh` is the demo's BATCHING,
// not its model. `BoxPart` is the same statement written smaller, and
// `buildPartTemplate` is where a shape that is not a cube lives.
//
// ⚠ These templates keep the DEMO'S OWN FRAME, which for two of them is not
// centred on the origin: the tooth spans y −1 … 0 (it hangs from its base edge)
// and the triangle spans y −0.42 … 0.55. That is deliberate. Every placement in
// the demo is written against those origins, so re-centring them would mean
// rewriting every call site by hand — which is exactly the re-derivation this
// port exists to stop. `BoxPart.x/y/z` is the template's ORIGIN, which for a
// centred template is also its centre; the renderer only ever uses it as an
// instance translation, so nothing downstream cares.

/** The demo's `shared('tooth')`: a solid triangular prism, base edge 1 wide at
 *  y = 0, apex 1 BELOW it, 1 thick and centred on z. One shape covers the awning
 *  valance, the cutter serration and the eraser sleeve's chevron — the demo
 *  shares it too, and "one part, one implementation" is a rule this repo has
 *  already paid for twice. */
function buildToothTemplate(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.5, 0);
  s.lineTo(0.5, 0);
  s.lineTo(0, -1);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
  g.translate(0, 0, -0.5);
  return g;
}

/** The demo's `shared('tri')`: the hospital mark, an equilateral-ish triangle
 *  extruded to a real thickness. NOT a red cross — the white-ground red cross is
 *  a protected emblem under the Geneva Conventions and national law. */
function buildTriTemplate(): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  sh.moveTo(0, 0.55);
  sh.lineTo(0.5, -0.42);
  sh.lineTo(-0.5, -0.42);
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: 1, bevelEnabled: false });
  g.translate(0, 0, -0.5);
  return g;
}

/**
 * Template cache — strategy-owned singletons that outlive every chunk (the
 * renderer clones what it is handed), freed in `dispose()`.
 *
 * The key set is this style's shape VOCABULARY and must stay fixed: the renderer
 * builds one template and one `InstancedMesh` per distinct key per chunk, so a
 * per-building key would be a per-building draw call. Four keys, all the demo's.
 */
const PART_TEMPLATES = new Map<PartShape, THREE.BufferGeometry>();
function paperPartTemplate(shape: PartShape): THREE.BufferGeometry | null {
  let geo = PART_TEMPLATES.get(shape);
  if (!geo) {
    if (shape === 'tooth') geo = buildToothTemplate();
    else if (shape === 'tri') geo = buildTriTemplate();
    // ('bead' retired with the abacus — the school is three file boxes now and
    //  its handle bezels are four square bars, so they ride the unit cube. The
    //  demo deleted its `unitBead` in the same change; nothing else in that
    //  world was round-and-repeated.)
    // `unitCyl(18)` / `unitCyl(12)` — the demo's own segment counts. A tape roll
    // is the biggest circle in the world and an 18-gon is where it stops
    // showing corners; the hub behind it is small and gets 12.
    else if (shape === 'roll') geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 18);
    else if (shape === 'hub') geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
    else return null;
    PART_TEMPLATES.set(shape, geo);
  }
  return geo;
}

/**
 * Floors on the box the demo's formulas are evaluated at.
 *
 * The demo's `buildingDims` never produced a small building — its shop is
 * 6.5–9 m tall, its school 9–11, its pill box 12–16 — so most of its formulas
 * have no lower bound. The real route does: MEASURED with `BOXSTATS=1` on the
 * saved Taipei route (984 footprints through the production pipeline), MVT
 * `render_height` bottoms out at **0.0 m** on industrial and footprints get down
 * to 1.5 m across. Zero height makes every extent derived from it a zero column
 * in an instance matrix — which three's instanced normal path divides by, giving
 * NaN normals and a building that is black in WebGL and nowhere else. The toy world's port died on the same class of bug
 * (`Math.round(w / 0)` → `Infinity` → 4 GB of heap), which is why this is stated
 * rather than left as two bare `Math.max`es.
 */
const MIN_BODY_H = 1;
const MIN_BODY_SPAN = 1;

/**
 * The demo's `box(w, h, d, mat)` + `mesh.position.set(...)` + `grp.add(...)`,
 * accumulating `BoxPart`s instead of meshes.
 *
 * `paint()` mirrors `PaperMass` so the instanced path and the merged one read
 * the same way; in the demo the colour is which material the mesh was built
 * with, and its `boxBatcher`/`batchGroup` buckets by exactly that.
 */
class PaperParts {
  readonly out: BoxPart[] = [];
  private c = 0xffffff;

  paint(hex: number): this {
    this.c = hex;
    return this;
  }

  /** One part. Extents are floored at 0.1 mm for the NaN-normal reason spelled
   *  out on `MIN_BODY_H`: a template built once at unit size has no zero-area
   *  face to drop, so a zero extent survives all the way into the shader. */
  add(
    shape: PartShape | null,
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    rotX = 0, rotY = 0, rotZ = 0,
  ): this {
    const part: BoxPart = {
      w: Math.max(w, 1e-4), h: Math.max(h, 1e-4), d: Math.max(d, 1e-4),
      x, y, z, color: this.c,
    };
    if (shape) part.shape = shape;
    if (rotX) part.rotX = rotX;
    if (rotY) part.rotY = rotY;
    if (rotZ) part.rotZ = rotZ;
    this.out.push(part);
    return this;
  }

  box(
    w: number, h: number, d: number, x: number, y: number, z: number,
    rotX = 0, rotY = 0, rotZ = 0,
  ): this {
    return this.add(null, w, h, d, x, y, z, rotX, rotY, rotZ);
  }
}

/**
 * The instanced body as ONE merged geometry, for `buildBuildingBody`.
 *
 * Reads the same templates the renderer instances and applies the same
 * transform order (R · S, then the offset), so "the merged body and the
 * instanced body are the same building" is true by construction. Production
 * never reaches this for the four bodies that decompose — `buildBuildingBoxes`
 * answers first — but the contract says the two must agree, and two functions
 * that each "build the same shop" drift the first time one is tuned.
 */
function partsToGeometry(parts: readonly BoxPart[]): THREE.BufferGeometry {
  const chunks: THREE.BufferGeometry[] = [];
  const unit = new THREE.BoxGeometry(1, 1, 1);
  for (const p of parts) {
    const template = p.shape ? paperPartTemplate(p.shape) : unit;
    if (!template) throw new Error(`paper style has no template for part shape '${p.shape}'`);
    const geo = template.clone();
    // The template's OWN vertex layout, kept vertex for vertex and in order:
    // `check:3d` un-transforms every merged vertex and expects to land on the
    // k-th vertex of the template, which is what makes "the merged body and the
    // instanced body are the same building" checkable rather than assertable.
    // `toNonIndexed()` here would silently re-order and inflate a box from 24
    // vertices to 36. An index is ADDED to the ones that lack it only because
    // `mergeGeometries` refuses a mix of indexed and non-indexed sources.
    geo.deleteAttribute('uv');
    if (!geo.index) {
      const n = geo.attributes.position.count;
      const idx = new Uint32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    geo.scale(p.w, p.h, p.d);
    if (p.rotX || p.rotZ) {
      geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(
        new THREE.Euler(p.rotX ?? 0, p.rotY ?? 0, p.rotZ ?? 0)));
    } else if (p.rotY) {
      geo.rotateY(p.rotY);
    }
    geo.translate(p.x, p.y, p.z);
    const n = geo.attributes.position.count;
    const c = new THREE.Color(p.color);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    chunks.push(geo);
  }
  unit.dispose();
  if (chunks.length === 1) return chunks[0];
  const merged = mergeGeometries(chunks, false);
  for (const g of chunks) g.dispose();
  return merged;
}

// ── Residential: the draughtsman's eraser ───────────────────────────────────
/**
 * The eraser block (the developer's「橡皮擦造型」direction — see
 * plan/paper-town-demo.html, which this mirrors). Unchanged by the zone port;
 * it is what a footprint outside every district builds too.
 */
function eraserBody(box: BuildingBox): THREE.BufferGeometry {
  const total = box.height + box.skirt;
  // Worn rim. Both ends get it; the bottom one lives inside the sleeve and
  // is never seen, which is why one uniform bevel is enough.
  const c = Math.min(0.55, box.height * 0.06, Math.min(box.width, box.depth) * 0.09);
  // The outline is inset by 2c FIRST: ExtrudeGeometry's bevel pushes
  // OUTWARD, so feeding it the full width yields a body (width + 2c) across
  // — wide enough to swallow the sleeve, which only stands 0.14 m proud.
  const geo = new THREE.ExtrudeGeometry(
    eraserRectShape(box.width - 2 * c, box.depth - 2 * c),
    {
      depth: total - 2 * c,
      bevelEnabled: true,
      bevelThickness: c,
      bevelSize: c,
      bevelSegments: 1,
    },
  );
  geo.rotateX(-Math.PI / 2);          // extrude +z -> +y
  geo.translate(0, c - box.skirt, 0); // base down to -skirt

  // Wear: rake the whole top rim into a slope, one side ground down harder
  // than the other. Pure vertex maths — costs no geometry, and this body is
  // paid for twice (the ink outline is an inverted hull sharing it).
  const topY = box.height - c - 1e-3;
  const drop = Math.min(1.4, box.height * 0.1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < topY) continue;
    pos.setY(i, y - drop * (0.15 + 0.85 * (pos.getX(i) / box.width + 0.5)));
  }
  geo.computeVertexNormals();
  return geo;
}

// ══════════════════════════════════════════════════════════════════════════
// The four zone bodies that decompose, ported from plan/paper-town-demo.html
// ══════════════════════════════════════════════════════════════════════════
//
// COPIED, not re-derived. The developer wrote and tuned those models and wired
// the window and sign anchors into that exact geometry; re-deriving them
// silently invalidates all of it and nothing notices. So every formula below is
// the demo's, in the demo's own order, with the demo's own names in the comments
// — and the deviations are enumerated rather than blended in:
//
//  1. THE SKIRT. The demo stands on a flat board and has none. Here a footprint
//     straddling two terrain treads must not show a floating edge, so the
//     ground-touching block of each body is EXTENDED DOWN by `box.skirt`
//     (`h + skirt` tall, centre dropped by `skirt / 2`). At `skirt = 0` every
//     part is the demo's, which is how the check compares them.
//  2. THE FLOORS. `MIN_BODY_H` / `MIN_BODY_SPAN` and a handful of `Math.max`es
//     on quantities that can go negative on a 1 m box. See `MIN_BODY_H` — the
//     route really does hand over `height = 0`.
//  3. ONE proportion: the tape roll's radius is `0.30 * min(w, h)` where the
//     demo says `0.30 * h`. Measured medians on the saved Taipei route are
//     w 17.0 m / h 33.0 m against the demo's own w ≈ h, so a height-only radius
//     puts a 19.8 m roll on a 17 m building. The 0.30 and the second roll's
//     0.21 are untouched.
//
// Everything the port had previously re-derived is back to the demo's number:
// the serration is `max(5, round(w / 1.35))` teeth (was a capped 4–7), the
// school is three stacked file boxes whose lid section and overhang are flat
// constants (was an abacus with three formulas off the box), the commercial
// facade is sized off the building height (was clamped to a 9 m storey), the
// pill box's lid is `h * 0.17` uncapped, and the tape dispenser's housing is
// `h * 0.26` rather than "whatever is left above the base".
//
// (The commercial body used to be the demo's `stickyShop` — a carton shopfront
// under a folded paper awning — and carried a FOURTH deviation for it: the
// awning's `k` ceiling, cut from 1.15 to 1 because at 1.15 the valance tip came
// down 0.46 m from the ridden line at chest height. The developer replaced that
// body with the tab dispenser below; the awning is gone and so is the deviation.
// Three remain.)

// ── Commercial: the coloured index-tab dispenser ──────────────────────
/**
 * The demo's `flagDispenser` layout — shared by the body, the window trim
 * (which is also this building's night light) and `check:3d`, so the three can
 * never disagree about how many compartments this dispenser has.
 *
 * The demo takes all of these off `w` and `h` directly.
 */
function tabDispenserLayout(box: BuildingBox) {
  const w = Math.max(MIN_BODY_SPAN, box.width);
  const d = Math.max(MIN_BODY_SPAN, box.depth);
  const h = Math.max(MIN_BODY_H, box.height);
  // demo: `n = max(3, min(6, round(w / 4.2)))`. Two compartments do not read as
  // "compartmented" and seven blur into one horizontal band at riding distance.
  const n = Math.max(3, Math.min(6, Math.round(w / 4.2)));
  return {
    w, d, h, n,
    /** demo: `cw = (w * 0.92) / n`. */
    cw: (w * 0.92) / n,
    /** demo: `k = max(0.62, min(1, h / 9))` — the lip shrinks with the storey.
     *  A fixed-size lip on a low building eats its whole facade, which is the
     *  lesson the retired awning paid for. */
    k: Math.max(0.62, Math.min(1, h / 9)),
    /** demo: `win = box(cw * 0.72, h * 0.24, 0.34)` at `(…, h * 0.17, zf + s * 0.40)`. */
    winW: ((w * 0.92) / n) * 0.72,
    winH: h * 0.24,
    winY: h * 0.17,
    winZ: d / 2 + 0.40,
    /** demo: the first window's centre is `-w * 0.46 + cw / 2`. */
    winX0: -w * 0.46,
  };
}

/**
 * The demo's `tabLip(w, n, cw, rng, k)`, flattened into parts: the angled
 * dispensing lip and the row of tabs pulled part-way out of it.
 *
 * THE LIP IS THE `tooth`. A dispenser's front is a wedge you drag the tab over,
 * and the demo builds it out of the same `unitTooth` the cutter serration and
 * the eraser sleeve's chevron use — one part, one implementation. Its
 * `-π/2 + 0.35` is ONE angle, not "lie it flat, then tilt it": the π/2 half
 * turns the triangle's apex to face +z and the 0.35 is the pitch, and writing
 * them as two rotations invites the next person to retune one of them alone.
 *
 * The reach is 1.6 k where the retired awning was 2.9 k. That is not caution,
 * it is what the part IS — and it has to stay short for a second reason: the
 * camera looks DOWN from 6.3 m (`fps-camera.ts` CHASE_UP), so anything that
 * overhangs far enough roofs over the window band underneath it, and that band
 * is this building's entire night light.
 *
 * The demo builds this as `lip`(position, rotY = π on the −z side) ▸ children.
 * There is no group to hang things off here, so the composition is baked:
 * `Ry(π)·Rx(θ)` is `Rx(−θ)·Ry(π)`, which as a three `Euler` in its default
 * XYZ order is `(−θ, π, 0)` — hence `side * θ` for the pitch AND the yaw.
 * Writing only `Rx(−θ)` would draw the same boxes (a box is symmetric under
 * `Ry(π)`) and would be a different rotation, which is the kind of "same
 * picture, different number" that stops being harmless the moment a part stops
 * being symmetric. `npm run check:3d` runs the demo's own `tabLip` and diffs the
 * quaternions part for part.
 */
const LIP_PITCH = -Math.PI / 2 + 0.35;

function tabLipTooth(
  P: PaperParts, w: number, k: number, y: number, d: number, side: number,
): void {
  /** The demo's `lip.rotation.y = Math.PI` on the −z side. */
  const yaw = side < 0 ? Math.PI : 0;
  // demo: `const OUT = 1.6 * k, TH = 0.9;`
  P.paint(CARTON_RIM_COLOR).add('tooth', w, 1.6 * k, 0.9, 0, y, side * (d / 2),
    side * LIP_PITCH, yaw);
}

/** One index tab, in the building box's local frame. */
interface TabSlot {
  w: number; h: number; d: number;
  x: number; y: number; z: number;
  rotX: number; rotY: number; rotZ: number;
  color: number;
  /** `lip` = pulled part-way out of the dispensing lip and lying flat;
   *  `lid` = standing up on the lid rim. */
  row: 'lip' | 'lid';
  /** Which face this tab belongs to: +1 is the +z front. */
  side: number;
}

/**
 * EVERY index tab this building has, both rows, in the demo's own emission
 * order — the ONE description of the tabs, read by `tabDispenserParts` (which
 * draws them) and `tabLights` (which lights them).
 *
 * That is not tidiness, it is §3.9: the thing that decides the shape has to
 * decide the lights. Two functions that each "work out where the tabs are"
 * drift the first time one of them is retuned, and the failure is silent — a
 * glow hanging in the air beside the tab it is supposed to be coming out of.
 *
 * ⚠ THE RNG ORDER IS THE GEOMETRY. The demo draws, per face and in this order,
 * one length per pulled tab and then one tilt per lid tab. Every draw here is in
 * that order and there are no others, so this stream and the demo's stay in
 * step. Insert a draw anywhere above and every tab on the route moves.
 */
function tabSlots(box: BuildingBox, seed: number): TabSlot[] {
  const L = tabDispenserLayout(box);
  const { w, d, h, n, cw, k } = L;
  // Its own stream, seeded from the footprint index — see paperBuildingKind.
  const rng = mulberry32((seed * 3266489917 + 0x51c3) >>> 0);
  const lipW = w * 0.97;
  const lipY = h * 0.34;
  const z0 = d / 2;
  // demo: `tw = min(cw * 0.55, 2.2)`, `th = tw * 1.55`.
  const tw = Math.min(cw * 0.55, 2.2);
  const th = tw * 1.55;
  const out: TabSlot[] = [];
  for (const s of [1, -1]) {
    const yaw = s < 0 ? Math.PI : 0;
    // The row pulled part-way out. Each tab's length is its OWN draw — a row of
    // equal tabs falls back to reading as a printed stripe, and "pulled out a
    // bit" is the whole thing this object is doing.
    for (let i = 0; i < n; i++) {
      const len = (1.1 + rng() * 0.6) * k;
      out.push({
        w: cw * 0.60, h: 0.36, d: len,
        x: s * (-lipW / 2 + (i + 0.5) * cw), y: lipY - 0.55, z: s * (z0 + 0.2 + len / 2),
        rotX: s * 0.2, rotY: yaw, rotZ: 0,
        color: TAB_COLORS[i % TAB_COLORS.length], row: 'lip', side: s,
      });
    }
    // The lid's row. Each leans a little on its own (a row in perfect alignment
    // is printing, not stationery) and the whole row leans OUTWARD, or the
    // downward camera sees a row of thin edges and nothing else.
    for (let i = 0; i < n; i++) {
      out.push({
        w: tw, h: th, d: 0.5,
        x: -w * 0.46 + (i + 0.5) * cw, y: h + 1.1 + th / 2, z: s * (z0 + 0.55),
        rotX: s * 0.18, rotY: 0, rotZ: (rng() - 0.5) * 0.24,
        color: TAB_COLORS[(i + (s > 0 ? 0 : 2)) % TAB_COLORS.length], row: 'lid', side: s,
      });
    }
  }
  return out;
}

// Scratch for `tabLights` — one set, reused. A commercial chunk asks for these
// several hundred times and every allocation here is garbage on the build path.
const _tabE = new THREE.Euler();
const _tabQ = new THREE.Quaternion();
const _tabFace = new THREE.Quaternion();
const _tabOff = new THREE.Vector3();
/** Quad normal +z turned to +y, for a light lying on a tab's TOP face. */
const _faceUp = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
/** …and turned to −z, for the far face of the lid's row. */
const _faceBack = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));
/** How far a light quad floats off the face it lights, to stay out of its own
 *  z-fight. Metres — small enough that no camera in this game resolves it. */
const TAB_LIGHT_LIFT = 0.03;

/**
 * Commercial's lights: BOTH rows of index tabs, on the face of each that the
 * rider can actually see.
 *
 *   lid row  the outward face — a standing tab is a panel facing the street
 *   lip row  the TOP face — a pulled tab lies flat, and the chase camera's eye
 *            is 6.3 m above the rider (`fps-camera.ts` CHASE_UP), so its top is
 *            the only side with any area from up there
 *
 * Both rows tilt, which is why `WindowPlacement` carries `rotX`/`rotZ` at all:
 * the alternative was straightening the tabs to suit the light, i.e. letting the
 * light decide the shape, which is §3.9 backwards. Each quad is composed off the
 * TAB'S OWN quaternion and then turned to the face it sits on, so it cannot
 * drift from the tab even if the tilts are retuned.
 */
function tabLights(box: BuildingBox, seed: number): WindowPlacement[] {
  const out: WindowPlacement[] = [];
  for (const t of tabSlots(box, seed)) {
    _tabQ.setFromEuler(_tabE.set(t.rotX, t.rotY, t.rotZ));
    let w: number;
    let h: number;
    if (t.row === 'lid') {
      // Outward is the tab's own ±z; the far face needs the quad turned round.
      _tabOff.set(0, 0, t.side * (t.d / 2 + TAB_LIGHT_LIFT)).applyQuaternion(_tabQ);
      _tabFace.copy(_tabQ);
      if (t.side < 0) _tabFace.multiply(_faceBack);
      w = t.w;
      h = t.h;
    } else {
      _tabOff.set(0, t.h / 2 + TAB_LIGHT_LIFT, 0).applyQuaternion(_tabQ);
      _tabFace.copy(_tabQ).multiply(_faceUp);
      // Turned onto the top face, the quad's height axis runs along the tab's
      // LENGTH, so the quad is `w × d` and not `w × h`.
      w = t.w;
      h = t.d;
    }
    _tabE.setFromQuaternion(_tabFace, 'XYZ');
    out.push({
      x: t.x + _tabOff.x, y: t.y + _tabOff.y, z: t.z + _tabOff.z,
      rotX: _tabE.x, rotY: _tabE.y, rotZ: _tabE.z,
      w, h, lit: 'tab',
    });
  }
  return out;
}

/**
 * The demo's `flagDispenser(w, d, h, rng)`: a carton dispenser with a
 * compartmented window band at street level, an angled lip above it, and a row
 * of coloured index tabs standing on the lid.
 *
 * WHY THE COLOUR IS AT TWO HEIGHTS. The route stretches these bodies to a
 * MEASURED median of 41 m. Tabs on the lid alone are 41 m up and the street sees
 * a blank carton wall; tabs on the facade alone leave the skyline colourless
 * from the chase camera's downward angle. So the lid keeps its row (at the same
 * `h + …` the retired sticky notes were tuned to) and the lip gets a second one.
 *
 * WHY THE COMPARTMENTS ARE NOT HOLES. Masses stay solid — a cut-out opens a gap
 * in the skyline and swallows the building backlit. So the band is a SOLID dark
 * slab with the lit windows standing proud of it, and the slab showing through
 * between them IS the divider. Same construction as the pill box's lid, which is
 * where this world already proved it.
 */
function tabDispenserParts(box: BuildingBox, seed: number): BoxPart[] {
  const L = tabDispenserLayout(box);
  const { w, d, h, k } = L;
  const skirt = box.skirt;
  const P = new PaperParts();
  // Both rows of tabs, off the ONE description of them that the lights read too.
  const slots = tabSlots(box, seed);
  const rowOf = (side: number, row: 'lip' | 'lid'): TabSlot[] =>
    slots.filter((t) => t.side === side && t.row === row);

  P.paint(CARTON_COLOR).box(w, h + skirt, d, 0, (h - skirt) / 2, 0);
  // The pressed rim top and bottom is what says "carton" instead of "block".
  P.paint(CARTON_RIM_COLOR).box(w + 1.0, 1.2, d + 1.0, 0, h + 0.5, 0);
  P.box(w + 0.5, 0.6 + skirt, d + 0.5, 0, (0.6 - skirt) / 2, 0);

  // Both long faces get a front: the oriented box follows the footprint, not the
  // road, so either of them can be the one the rider sees.
  for (const s of [1, -1]) {
    const zf = s * (d / 2);
    // The window band's backing slab. `h * 0.30` rather than "the window plus a
    // fixed border": a constant border pushes the slab below ground on a 4 m
    // building and vanishes on a 40 m one. The whole band sits at 0.17h and not
    // 0.2h so its top clears the row of tabs the lip above it has pulled out —
    // otherwise this building's only night light is partly behind its own tabs.
    // (The panes themselves are trim — they need their own material. They do NOT
    // glow: see `TAB_GLOW`.)
    P.paint(SLEEVE_INK_COLOR).box(w * 0.94, h * 0.30, 0.36, 0, h * 0.17, zf + s * 0.18);

    // Facade order, top down: tabs on the LID → shop sign (0.55–0.70 h, hung by
    // the building renderer) → lip (0.34 h) → window band. Get it wrong and
    // something vanishes, always the same way: the lip reaches OUT and the camera
    // looks DOWN, so anything lower than the lip is roofed over by it.
    //
    // 0.34 h is measured, not chosen: the sign's lower edge lands at 0.58h − H/2
    // and the lip any higher fouls it, and it is also just clear of the top of the
    // window band's slab (0.17h + 0.30h/2 = 0.32h).
    tabLipTooth(P, w * 0.97, k, h * 0.34, d, s);
    // …then the two rows, in the demo's own order: pulled first, lid second.
    for (const row of ['lip', 'lid'] as const) {
      for (const t of rowOf(s, row)) {
        P.paint(t.color).box(t.w, t.h, t.d, t.x, t.y, t.z, t.rotX, t.rotY, t.rotZ);
      }
    }
  }
  return P.out;
}

// ── Industrial: the tape dispenser ──────────────────────────────────────────
/** Machine dimensions shared by the body and the steel/hub trim. */
function tapeLayout(box: BuildingBox) {
  const w = Math.max(MIN_BODY_SPAN, box.width);
  const d = Math.max(MIN_BODY_SPAN, box.depth);
  const h = Math.max(MIN_BODY_H, box.height);
  const hb = h * 0.34;
  // demo: `const hh = h * 0.26;` — the housing steps BACK and stops well short
  // of the top, because on a tape dispenser the rolls are the top. This file had
  // it as `h - hb` (fill the box); that is a different object.
  const hh = h * 0.26;
  // demo: `rolls = [[h * 0.30, -w * 0.20], [h * 0.21, w * 0.27]]`. The one
  // proportion this port changes: `min(w, h)` instead of `h`. See the header —
  // the demo's industrial box is w ≈ h, the route's is h ≈ 2 w.
  const rad = Math.min(w, h);
  return {
    w, d, h, hb, hh,
    len: d * 0.58,
    rolls: [
      { r: rad * 0.30, x: -w * 0.20 },
      { r: rad * 0.21, x: w * 0.27 },
    ],
    teeth: Math.max(5, Math.round(w / 1.35)),
  };
}

/** The demo's `tapeDispenser(w, d, h, rng)` — the most mechanical thing on a
 *  desk. Heavy base, two rolls axis-on to the street, serrated cutter in front.
 *  (The steel and the glowing hubs are trim: they need their own materials.) */
function tapeDispenserParts(box: BuildingBox): BoxPart[] {
  const L = tapeLayout(box);
  const skirt = box.skirt;
  const P = new PaperParts();
  P.paint(TAPE_BASE_COLOR).box(L.w, L.hb + skirt, L.d, 0, (L.hb - skirt) / 2, 0);
  P.box(L.w * 0.78, L.hh, L.d * 0.66, 0, L.hb + L.hh / 2, -L.d * 0.13);
  // The rolls sink a little into the base — sitting ON the machine, not glued to
  // its lid. `unitCyl(18)` laid along +z, which is what `rotation.x = π/2` does.
  P.paint(TAPE_ROLL_COLOR);
  for (const r of L.rolls) {
    P.add('roll', r.r * 2, L.len, r.r * 2, r.x, L.hb + r.r * 0.72, 0, Math.PI / 2);
  }
  return P.out;
}

// ── School: three office file boxes, stacked ────────────────────────────────
/** The demo's stack count, lid section and lid overhang — flat constants, not
 *  formulas off the box. `LID_H` / `LID_OUT` are the numbers the abacus's old
 *  `cap` already used (`w + 0.7` × `0.8` × `d + 0.7`); the stack inherited them
 *  rather than inventing a second set. */
const FILE_TIERS = 3;
const FILE_LID_H = 0.8;
const FILE_LID_OUT = 0.7;

/**
 * Box + handle layout. Shared by the body, `buildBuildingLights` and
 * `signAnchor`, because the thing that decides the SHAPE has to decide the
 * LIGHTS (DEVPLAN) — and a handle grid recomputed in a second function is how
 * the two drift apart.
 *
 * Every one of these is the demo's, INCLUDING the two `Math.min`s that keep the
 * body positive on a degenerate box: the demo carries them itself (see
 * `fileBoxSchool`'s header), so unlike the abacus this layout needs no port-only
 * floor at all. `lidH = min(0.8, tierH / 2)` is what stops `bodyH` going
 * negative on the `height = 0` footprints the route really does produce — a
 * negative extent is a mirrored instance matrix, which draws the part inside
 * out.
 */
function fileBoxLayout(box: BuildingBox) {
  const w = Math.max(MIN_BODY_SPAN, box.width);
  const d = Math.max(MIN_BODY_SPAN, box.depth);
  const h = Math.max(MIN_BODY_H, box.height);
  const tierH = h / FILE_TIERS;
  const lidH = Math.min(FILE_LID_H, tierH * 0.5);
  const bodyH = tierH - lidH;
  // demo: `holes = max(1, round(w / 22))`. A 22 m pitch, not the abacus's 6.5 —
  // one hand hole per box is what a file box has, and at 6.5 the demo's own
  // first attempt drew three tidy rows of small rectangles, i.e. the facade
  // window grid §3.9 exists to kill, wearing a coloured frame.
  const holes = Math.max(1, Math.round(w / 22));
  const cellW = w / holes;
  const holeW = Math.min(cellW * 0.30, bodyH * 1.25, 5.0);
  const holeH = holeW * 0.28;
  const ringW = Math.min(0.3, holeH * 0.42, cellW * 0.1);
  return {
    w, d, h, tierH, lidH, bodyH, holes, cellW, holeW, holeH, ringW,
    tiers: FILE_TIERS,
    /** How far the bezel stands proud of the body face. */
    ringT: 0.34,
    /** Thickness of the dark recessed face. */
    holeT: 0.30,
  };
}

/** Which of the four colours the tier-`t` box wears, given this building's own
 *  draw. Both the body and the lights ask this, so they cannot disagree about
 *  which floor is the amber one. */
function fileRingColorIndex(t: number, c0: number): number {
  return (c0 + t) % RING_COLORS.length;
}

/** The demo's `c0 = Math.floor(rng() * ringMats.length)` — its ONE draw, off
 *  this building's own stream. The demo takes it from the chunk's shared rng at
 *  the top of `fileBoxSchool`; keying it per building here reproduces the fact
 *  that it is the FIRST draw, which is all the geometry depends on. */
function fileBoxColorStart(seed: number): number {
  const rng = mulberry32((seed * 2654435761 + 0x71c3) >>> 0);
  return Math.floor(rng() * RING_COLORS.length);
}

/** The demo's `fileBoxSchool(w, d, h, rng)` — three stacked archive boxes, the
 *  only body in the world with three lid courses and the only one wearing the
 *  handle-bezel colours. */
function fileBoxParts(box: BuildingBox, seed: number): BoxPart[] {
  const L = fileBoxLayout(box);
  const { w, d } = L;
  const skirt = box.skirt;
  const P = new PaperParts();
  const c0 = fileBoxColorStart(seed);

  for (let t = 0; t < L.tiers; t++) {
    const y0 = t * L.tierH;
    // THE SKIRT (port-only, and the only deviation in this body): the bottom
    // box is the ground-touching block, so it is extended DOWN by `box.skirt`
    // and its centre dropped by half of it. At `skirt = 0` this is the demo's
    // own `box(w, bodyH, d)` at `bodyH / 2`, which is how the check compares
    // them.
    const grounded = t === 0 ? skirt : 0;
    P.paint(FILE_BOX_COLOR)
      .box(w, L.bodyH + grounded, d, 0, y0 + (L.bodyH - grounded) / 2, 0);
    P.paint(FILE_LID_COLOR)
      .box(w + FILE_LID_OUT, L.lidH, d + FILE_LID_OUT, 0, y0 + L.bodyH + L.lidH / 2, 0);

    const ring = RING_COLORS[fileRingColorIndex(t, c0)];
    const hy = y0 + L.bodyH * 0.6;
    // Handles on BOTH long faces — the box is oriented by the footprint, so
    // either face can be the street one.
    for (const s of [1, -1]) {
      const hz = s * (d / 2 + L.ringT / 2);
      // NOT a cut-out. A hole punched through the mass opens a gap in the
      // skyline and swallows the building backlit (§3.5), so the "hole" is a
      // SOLID dark slab whose face sits 0.28 m behind the bezel's; the recess is
      // read off that step, not off any actual opening.
      const pz = s * (d / 2 + 0.06 - L.holeT / 2);
      for (let k = 0; k < L.holes; k++) {
        const hx = -w / 2 + (k + 0.5) * L.cellW;
        P.paint(FILE_HOLE_COLOR).box(L.holeW, L.holeH, L.holeT, hx, hy, pz);
        P.paint(ring);
        for (const sy of [1, -1]) {          // bezel: top and bottom bars
          P.box(L.holeW + L.ringW * 2, L.ringW, L.ringT,
            hx, hy + sy * (L.holeH + L.ringW) / 2, hz);
        }
        for (const sx of [-1, 1]) {          // bezel: left and right bars
          P.box(L.ringW, L.holeH, L.ringT,
            hx + sx * (L.holeW + L.ringW) / 2, hy, hz);
        }
      }
    }
  }
  return P.out;
}

/**
 * The school's lights: one whole ring colour, on the bezel bars that are already
 * there. Same layout function as the body, so they cannot drift apart — and each
 * quad is sized to ITS bar, so what glows is a rectangular OUTLINE round a dark
 * hole rather than a lit panel over it. A light that is not the size of the
 * thing it lights is the facade grid coming back under another name.
 */
function fileHandleLights(box: BuildingBox, seed: number): WindowPlacement[] {
  const L = fileBoxLayout(box);
  const c0 = fileBoxColorStart(seed);
  const out: WindowPlacement[] = [];
  for (let t = 0; t < L.tiers; t++) {
    if (fileRingColorIndex(t, c0) !== RING_LIT_INDEX) continue;
    const y0 = t * L.tierH;
    const hy = y0 + L.bodyH * 0.6;
    for (const s of [1, -1]) {
      // Just proud of the bezel's own front face, so the quad reads as the bar
      // glowing rather than as a card floating in front of it.
      const z = s * (L.d / 2 + L.ringT + 0.05);
      for (let k = 0; k < L.holes; k++) {
        const hx = -L.w / 2 + (k + 0.5) * L.cellW;
        for (const sy of [1, -1]) {
          out.push({
            x: hx, y: hy + sy * (L.holeH + L.ringW) / 2, z,
            rotY: s > 0 ? 0 : Math.PI,
            w: L.holeW + L.ringW * 2, h: L.ringW,
            lit: 'handleRing',
          });
        }
        for (const sx of [-1, 1]) {
          out.push({
            x: hx + sx * (L.holeW + L.ringW) / 2, y: hy, z,
            rotY: s > 0 ? 0 : Math.PI,
            w: L.ringW, h: L.holeH,
            lit: 'handleRing',
          });
        }
      }
    }
  }
  return out;
}

// ── Hospital: the pill box ──────────────────────────────────────────────────
/** Lid + compartment layout. Shared with `buildBuildingLights`: the lit cells
 *  ARE compartments of the lid, not extra quads invented on the wall. */
function pillBoxLayout(box: BuildingBox) {
  const w = Math.max(MIN_BODY_SPAN, box.width);
  const d = Math.max(MIN_BODY_SPAN, box.depth);
  const h = Math.max(MIN_BODY_H, box.height);
  // demo: `const lidH = h * 0.17;` — uncapped. This file capped it at 2.6 m,
  // which on a 40 m block makes the lid a rim instead of a lid.
  const lidH = h * 0.17;
  const cells = Math.max(3, Math.min(7, Math.round(w / 1.9)));
  return { w, d, h, lidH, cells, cw: (w + 0.9) / cells, cellY: h + lidH * 0.77 };
}

/** The demo's `pillBox(w, d, h, rng)` — white card and red, the only white mass
 *  in the world. */
function pillBoxParts(box: BuildingBox): BoxPart[] {
  const L = pillBoxLayout(box);
  const { w, d, h } = L;
  const skirt = box.skirt;
  const P = new PaperParts();

  P.paint(PILL_BODY_COLOR).box(w, h + skirt, d, 0, (h - skirt) / 2, 0);

  // ── The compartmented lid (= this building's lights) ──
  // A pill box's lid is already divided, so the lights do not have to be
  // invented: one continuous base with the compartments standing on it, and the
  // gaps between them show the base through, which IS the divider.
  //
  P.paint(PILL_LID_COLOR);
  P.box(w + 0.9, L.lidH * 0.34, d + 0.9, 0, h + L.lidH * 0.17, 0);
  P.paint(PILL_CELL_COLOR);
  for (let i = 0; i < L.cells; i++) {
    P.box(L.cw * 0.78, L.lidH * 0.86, d + 0.62,
      -(w + 0.9) / 2 + (i + 0.5) * L.cw, L.cellY, 0);
  }

  P.paint(PILL_LID_COLOR).box(w + 0.6, 0.7 + skirt, d + 0.6, 0, (0.7 - skirt) / 2, 0);
  // demo: `band = box(w + 0.16, h * 0.11, d + 0.16)` at `h * 0.3` — uncapped.
  P.paint(PILL_BAND_COLOR).box(w + 0.16, h * 0.11, d + 0.16, 0, h * 0.3, 0);

  // The mark: extruded geometry, not a glyph and not a texture.
  //
  // `redCross(L, th)` in the demo is a `unitTri` mesh scaled `(L, L, th)` inside
  // a group that carries the position and rotation, so the part IS the group's
  // transform — which is why these come out as one `shape: 'tri'` part each.
  // The demo's four, in the demo's order: the −z face, the two ends (both at
  // `rotation.y = π/2`, which for a solid prism is the same object either way),
  // and the roof.
  const markL = Math.min(w, h * 0.5) * 0.62;
  const roofL = Math.min(w, d) * 0.62;
  P.paint(HOSPITAL_MARK_COLOR);
  P.add('tri', markL, markL, 0.45, 0, h * 0.62, -(d / 2 + 0.2), 0, Math.PI);
  for (const s of [1, -1]) {
    P.add('tri', markL * 0.78, markL * 0.78, 0.45,
      s * (w / 2 + 0.2), h * 0.62, 0, 0, Math.PI / 2);
  }
  // The one the downward camera angle sees.
  P.add('tri', roofL, roofL, 0.5, 0, h + L.lidH * 1.2 + 0.3, 0, -Math.PI / 2);

  // ── The one part of this body the demo does not have ──
  // The demo leaves +z bare because every one of its buildings hangs a sign
  // there and that sign already carries the triangle; a second one on the same
  // face would only read as dirt. Here only ONE hospital per district is signed
  // (`PER_BUILDING_SIGN_ZONES` is commercial-only) and the box is oriented by its
  // footprint rather than by the road, so a bare face toward the street is a
  // white block with a blue stripe and nothing that says hospital. Doubling the
  // symbol on the single signed building is much the cheaper mistake.
  //
  // Emitted LAST and on the +z side alone, which is how `npm run check:3d` tells
  // it apart from the demo's four without counting indices.
  P.add('tri', markL, markL, 0.45, 0, h * 0.62, d / 2 + 0.2);
  return P.out;
}

/**
 * The hospital's lights: every other compartment of the lid — the demo's
 * `i % 2 === 0 ? pillCellLitMat : pillCellMat`. All of them lit would be one
 * light bar, and "a row of compartments" is the thing being read.
 *
 * Sized to THE COMPARTMENT: `cw * 0.78` wide and `lidH * 0.86` tall, which are
 * the compartment's own extents out of `pillBoxLayout`, so what lights up is
 * the cell rather than a rectangle parked in front of it.
 */
function pillCellLights(box: BuildingBox): WindowPlacement[] {
  const L = pillBoxLayout(box);
  const out: WindowPlacement[] = [];
  // The compartment is `d + 0.62` deep, so its face is at `d / 2 + 0.31`.
  const zf = L.d / 2 + 0.31 + 0.05;
  for (let i = 0; i < L.cells; i += 2) {
    const x = -(L.w + 0.9) / 2 + (i + 0.5) * L.cw;
    for (const s of [1, -1]) {
      out.push({
        x, y: L.cellY, z: s * zf, rotY: s > 0 ? 0 : Math.PI,
        w: L.cw * 0.78, h: L.lidH * 0.86,
        lit: 'pillCell',
      });
    }
  }
  return out;
}

/**
 * The parts one body is made of — ONE function behind `buildBuildingBoxes` and
 * `buildBuildingBody`, so the instanced body and the merged one cannot disagree
 * about what this building is.
 *
 * Four of the five answer. The eraser returns null and stays on the merge path:
 * its rubber block is an `ExtrudeGeometry` whose bevel is
 * `min(0.55, h * 0.06, min(w, d) * 0.09)` and whose worn top edge is a per-vertex
 * rake — neither of which is a linear scale of a unit shape, so it cannot be one
 * template. The demo gets away with instancing it because its residential
 * buildings come from a three-row table and there are exactly three of them in
 * the world; here every footprint is a different size, and a per-building
 * template key would be a per-building draw call (see `PartShape`).
 */
function paperBodyParts(
  box: BuildingBox, seed: number, zone: ZoneKind | null,
): BoxPart[] | null {
  switch (paperBuildingKind(zone, seed)) {
    case 'commercial': return tabDispenserParts(box, seed);
    case 'industrial': return tapeDispenserParts(box);
    case 'school': return fileBoxParts(box, seed);
    case 'hospital': return pillBoxParts(box);
    default: return null;
  }
}

export function createPaperTerrainStyle(): TerrainStyleStrategy {
  const params: StyleParams = defaultStyleParams('paper');

  // ── 螢幕後製的兩顆旋鈕在這裡歸零 ──────────────────────────────────────────
  //
  // demo 的畫面是 `renderer.render(scene, camera)` —— 一道後製都沒有。這個世界
  // 的紙感全部住在幾何、貼圖與 toon 的階梯裡。`paper-effect-pass` 剩下的職責只
  // 有紙纖維(一道只讀 R 通道的灰階乘法,動不了色相),色階化與降飽和都是「同
  // 一件事做第二次」:
  //   ・色階化 → toon 的 gradientMap 已經在每一個材質上做過,而且這支 pass 跑
  //     在 OutputPass **之前**,量化的是線性值 —— 四階會把整個中間調壓到 0/0.25。
  //   ・降飽和 → `paperify()` 已經在色票裡抽掉 45%,一次,而且是在來源。
  // 量出來的代價寫在 `paper-effect-pass.ts` 的檔頭:地面的 `#6d9a46` 被推到
  // `#808457`(R≈G 的土黃),整份色票色相位移最多 36°、飽和度掉 25–73%。
  //
  // ⚠ 這兩個值的正確歸宿是 `defaultStyleParams('paper')`,但那支檔案這一輪由別
  // 的 agent 握著。搬過去的時候把這一段一起刪掉 —— 兩個地方寫同一個預設值只會
  // 讓下一個人改錯邊。`paperStrength` / `paperFiber` **不在**這裡覆寫:它們是
  // 宣告過的玩家選項,預設值必須等於 `defaultStyleParams`(diorama 有一條在守)。

  /**
   * 上色 ↔ 素紙板。demo 的 `paintOn`,預設 `true`(它的按鈕開場寫「上色:廣告
   * 顏料」,`?paint=0` 才是素紙板)。
   *
   * 值從 `params.paintEnabled` 讀 —— `applyWorldOptions()` 在策略建好之後、第一
   * 個 chunk 之前,把 `WORLD_OPTIONS.cuphead` 的每一個鍵原封寫上 `strat.params`
   * (它**不**依 render mode 過濾),所以這個鍵今天就已經送得到,即使那一列還掛
   * 著 `modes: ['phaser']`。
   *
   * ⚠ 它現在是 `StyleParams` 上的一個**未宣告**欄位。正確的落點是把
   * `paintEnabled: boolean` 加進 `StyleParams`、`defaultStyleParams` 三個世界各
   * 給一個值,然後 `WORLD_OPTIONS.cuphead` 那一列的 `modes` 加上 `'threejs'`;
   * 那支檔案這一輪由別的 agent 握著,所以先在這裡補上 demo 的預設值。三件事要
   * 同一個 commit 做完 —— diorama 的 `[world options — round trip]` 會要求
   * 「宣告的預設值 === 策略自己的預設值」。
   */
  const paintOn = (): boolean => params.paintEnabled !== false;

  const gradient = createPaperGradient();

  let buildingMaterial: THREE.MeshToonMaterial | null = null;

  // Corrugation texture cache — regenerated when the panel's strength changes
  // (wall materials are recreated per chunk build, so a rebuild picks it up).
  let corrTex: { tex: THREE.CanvasTexture; strength: number } | null = null;
  const corrugationTexture = (): THREE.CanvasTexture => {
    const strength = params.corrugationStrength;
    if (!corrTex || corrTex.strength !== strength) {
      corrTex?.tex.dispose();
      corrTex = { tex: createCorrugationTexture(strength), strength };
    }
    return corrTex.tex;
  };

  // Crayon shading texture — shared by every coloured surface (lazy singleton).
  let crayonTex: THREE.CanvasTexture | null = null;
  const crayonTexture = (): THREE.CanvasTexture => {
    if (!crayonTex) crayonTex = createCrayonShadeTexture();
    return crayonTex;
  };

  // Cardboard dent bump map — shared (lazy singleton).
  let dentTex: THREE.CanvasTexture | null = null;
  const dentTexture = (): THREE.CanvasTexture => {
    if (!dentTex) dentTex = createDentTexture();
    return dentTex;
  };

  // 棉花球雲的共用資源(懶建:歡迎頁、關雲的畫質層不付這張貼圖)。
  // 「一朵雲的四五顆棉球同幾何同材質,批掉」是 demo 的原話 —— 這裡更進一步,
  // 整層雲共用同一顆球、同一份材質,一朵雲就是一個 InstancedMesh、一個
  // draw call。材質是雲專用的(入雲淡出會寫它的 opacity,合約見 buildCloud)。
  let cottonGeo: THREE.SphereGeometry | null = null;
  let cottonTex: THREE.CanvasTexture | null = null;
  let cottonMat: THREE.MeshToonMaterial | null = null;

  // Prop textures — lazy singletons, all freed in dispose().
  const propTextures = new Map<string, THREE.CanvasTexture>();
  const propTexture = (key: string, make: () => THREE.CanvasTexture): THREE.CanvasTexture => {
    let tex = propTextures.get(key);
    if (!tex) {
      tex = make();
      propTextures.set(key, tex);
    }
    return tex;
  };

  // Shared building-trim materials (kraft flaps, tape, crayon windows). Tagged
  // `shared` so the chunk disposer leaves them to the strategy.
  const trimMaterials = new Map<string, THREE.Material>();
  const sharedTrim = (key: string, make: () => THREE.Material): THREE.Material => {
    let mat = trimMaterials.get(key);
    if (!mat) {
      mat = make();
      mat.userData.shared = true;
      trimMaterials.set(key, mat);
    }
    return mat;
  };

  const toon = (opts: THREE.MeshToonMaterialParameters) =>
    new THREE.MeshToonMaterial({ gradientMap: gradient, side: THREE.DoubleSide, ...opts });

  /**
   * 第 0 階的踏面 —— **切割墊本身**。demo 的 `boardTopMat`,一行:
   *
   * > `const boardTopMat = toon({ map: rep(cuttingMatTex, 5, 5) });`
   *
   * 三件事跟著那一行走,而且每一件都是「沒有」:
   *  · **沒有 `vertexColors`。** 墊子不吃分層色 —— 它不是那一疊板的第一片,它是那一
   *    疊板放在上面的桌墊。
   *  · **沒有 `crayonize`。** 廣告顏料刷在模型上,不刷在工具上。這同時是使用者
   *    回報的那件事的根因:`crayonize` 的 shader 是 `diffuseColor.rgb *= crayonTex.r`,
   *    R 低的地方壓黑 —— 那就是「第一層等高線有會閃爍的黑色刷線」,而 POC 上沒有,
   *    因為 POC 的第 0 階根本不是紙。第 1 階以上照舊掛蠟筆紋(demo 的 `plateTopMats`
   *    上色態就是刷痕),那一半不動。
   *  · **沒有雙態。** demo:「墊子**不是**雙態的:上色模式換的是模型上的顏料,墊子是
   *    桌上的工具,不會因為你開始上色就變成另一種墊子。」所以它不看 `paintOn()`。
   *
   * **重複率**:demo 的地台是一條 `ribbonSeg(d0, d1, 130, 0, 1/30)`,u = 沿路公尺 / 30、
   * v = 0…1 橫跨 130 m,配 `repeat(5, 5)` → 一格貼圖沿路 **6 m**、橫向 **26 m**。那個
   * 6:26 的長寬比是 ribbon 把 v 正規化的副作用,不是設計 —— gameview 的踏面 uv 是**兩軸
   * 都是場景公尺**(`quantized-terrain.ts` 的 `pushTopTri` 推 `ax, az`),所以只能是方的。
   * 取哪個方形則由 demo 答不出來的一條決定:**墊子只能有一張**。這裡的走廊踏面跟
   * `createHorizonMaterial` 那張 4 km 圓盤是同一張墊子,兩邊的格子必須連得起來,所以
   * 共用 `CUTTING_MAT_TILE_METERS`(120 m 一張、10 格 → 12 m 一格)。圓盤的 uv 是
   * 「本地公尺 + 騎手位移」= 世界公尺,踏面的 uv 也是世界公尺,所以兩者的格線**同相**。
   *
   * ⚠ 但貼圖實例不能共用:`mountain-ring` 每一幀寫圓盤那份的 `map.offset`(把圓盤釘回
   * 世界),而走廊的 uv 本來就在世界座標上 —— 套上去墊子會跟著騎手滑。所以走廊拿一份
   * **clone**(共用同一張畫布與同一個 GPU 上傳,只多一組 uv 設定),並把 offset 歸零:
   * clone 是懶建的,騎到一半才建的話會抄到圓盤當下的位移。這正是 demo 的 `rep()`。
   */
  let cuttingMatFloorMat: THREE.Material | null = null;
  const cuttingMatFloorMaterial = (): THREE.Material => {
    if (!cuttingMatFloorMat) {
      const map = propTexture('cuttingMatFloor', () => {
        const t = propTexture('cuttingMat', createCuttingMatTexture).clone();
        t.offset.set(0, 0);
        t.needsUpdate = true;
        return t;
      });
      // 雲影要跨過階界:第 1 階以上的踏面走 `createTerrainMaterial()`(有雲影),
      // 墊子少了它的話,一朵雲的影子會剛好停在第 0 階的邊緣。
      cuttingMatFloorMat = injectCloudShadow(toon({ map }));
      // strategy 擁有的 singleton —— chunk 回收器看這個旗子(§6)。
      cuttingMatFloorMat.userData.shared = true;
    }
    return cuttingMatFloorMat;
  };

  /** The eraser's plastic film. Shared singleton — one `emissive` write lights
   *  every residential building in the world (see `setNightFactor`). */
  const eraserFilmMaterial = () => sharedTrim('eraserFilm', () => {
    const m = new THREE.MeshPhongMaterial({
      color: ERASER_BAND_COLOR, specular: 0xffffff, shininess: 70, emissive: 0x000000,
    });
    registerNightLitMaterial(m, ERASER_BAND_GLOW);
    return m;
  }) as THREE.MeshPhongMaterial;

  /**
   * The tab dispenser's compartment panes: dark glass reflecting the sky, so you
   * can see how much stock is left in each compartment.
   *
   * **NOT night-lit**, and that is the whole of this change. These panes used to
   * carry the commercial district's entire light, and a row of lit rectangles
   * down a facade is an office block whatever it is called in the source — the
   * one silhouette this district has to stay away from. The light moved onto the
   * tabs (`tabLights`), which is a surface the body already draws and which says
   * "index tabs" at a hundred metres. The panes are painted by day exactly as
   * before and simply go dark at dusk.
   */
  const shopGlassMaterial = () => sharedTrim('shopGlass', () => new THREE.MeshPhongMaterial({
    color: SHOP_GLASS_COLOR, specular: 0xffffff, shininess: 120,
  }));

  /** The bore through the middle of a tape roll — the industrial district's one
   *  light, and the only warm colour on the machine. Same argument as the
   *  glass: the whole part glows (the machine has not stopped), it is not a
   *  grid of windows. */
  const tapeHubMaterial = () => sharedTrim('tapeHub', () => {
    const m = toon({ color: TAPE_HUB_COLOR, emissive: 0x000000 });
    registerNightLitMaterial(m, TAPE_HUB_GLOW);
    return m;
  });

  /**
   * This world's `WindowPlacement.lit` vocabulary — two keys, two glows, both
   * read straight off the demo:
   *
   *   'handleRing'  `nightLit(ringMats[1], '#b07d1c')` — the amber bezel colour,
   *                 one whole colour of the four rather than a random scatter,
   *                 which is what lights one whole FLOOR of handles (and a
   *                 different floor on every school, because the colour order
   *                 starts at a per-building draw).
   *   'pillCell'    `pillCellLitMat = nightLit(…, '#c9a45c')` — every other
   *                 compartment of the lid.
   *
   * They ride `sharedTrim`, so `dispose()` unregisters and frees them along with
   * every other night-lit material — one left registered after a world swap is
   * written every frame forever.
   */
  const LIT_BODY_GLOW: Record<string, number> = {
    tab: TAB_GLOW,
    handleRing: RING_LIT_GLOW,
    pillCell: PILL_CELL_GLOW,
  };

  /** Steel: the serrated cutter and the bands round the base. The only metal in
   *  a world made of board, and most of why an industrial district is
   *  recognisable from three hundred metres away. */
  const bladeMaterial = () => sharedTrim('blade', () => new THREE.MeshPhongMaterial({
    color: BLADE_COLOR, specular: 0xffffff, shininess: 150,
  }));

  /** The demo's `crayonWinMat` — a scribbled frame drawn once and printed on the
   *  eraser's wrapper. ONE material for the wrapper's frames and for the fallback
   *  facade cards below, because they are the same drawing. */
  const crayonWindowMaterial = () => sharedTrim('window', () => new THREE.MeshToonMaterial({
    map: propTexture('crayonWindow', createCrayonWindowTexture),
    gradientMap: gradient,
    transparent: true,
    alphaTest: 0.3,
    side: THREE.DoubleSide,
  }));

  // ── Sign materials ──────────────────────────────────────────────────────
  // Singletons, tagged `userData.shared` so per-chunk disposers leave them
  // alone; freed in `dispose()` below. Lazily built because a route with no
  // checkpoints and no shops never needs them.
  const signMats = new Map<string, THREE.Material>();
  const signMat = (key: string, make: () => THREE.Material): THREE.Material => {
    let m = signMats.get(key);
    if (!m) {
      m = make();
      m.userData.shared = true;
      signMats.set(key, m);
    }
    return m;
  };
  /** Coloured plastic tape — Phong, not toon: it is the one glossy surface on a
   *  desk of matte board, and that sheen is most of what says "not cardboard". */
  const makeTapeMat = (zone: ZoneKind) => new THREE.MeshPhongMaterial({
    color: SIGN_TAPE_COLORS[zone], specular: 0xffffff, shininess: 55,
  });
  const makeEmbossMat = () => toon({ color: SIGN_EMBOSS_COLOR, side: THREE.FrontSide });
  const makeTriangleMat = () => toon({ color: SIGN_TRIANGLE_COLOR, side: THREE.FrontSide });
  /** Toon material whose colour reads as crayon-on-paper (streaks + tooth),
   *  with dented-cardboard bumps under the toon light. */
  // ── Instance templates for the trim ──────────────────────────────────────
  //
  // The batched way out of `mergeBuildingDecorations` (see `markInstanceTemplate`):
  // a trim part whose only difference between buildings is its SIZE never
  // becomes geometry here at all — one unit-sized template lives for the life of
  // the strategy and the chunk collects the matrices.
  //
  // The eraser's sleeve is the case that pays: 249 of the 781 footprints in one
  // dense Taipei chunk are erasers, each building five little boxes and prisms
  // that the chunk then had to copy again. Measured at 24 ms of the 66 ms this
  // style spent building trim, plus 1 245 of the 2 152 meshes going into the
  // merge.
  const trimTemplates = new Map<string, THREE.BufferGeometry>();
  const trimTemplate = (
    key: string, material: THREE.Material, make: () => THREE.BufferGeometry,
  ): THREE.BufferGeometry => {
    let geo = trimTemplates.get(key);
    if (!geo) {
      geo = make();
      trimTemplates.set(key, geo);
    }
    // Re-tagged on every hand-out, not only on creation: one unit box is shared
    // by three materials here, and `markInstanceTemplate` is where the
    // black-part trap (vertexColors lives on the MATERIAL) is caught.
    return markInstanceTemplate(geo, material);
  };

  /** Scratch for composing one instance transform. Safe as closure state: none
   *  of these builders awaits, so no two can interleave mid-write. */
  const _im = new THREE.Matrix4();
  const _ip = new THREE.Vector3();
  const _iq = new THREE.Quaternion();
  const _is = new THREE.Vector3();
  /** One axis-aligned instance: a unit template scaled to (w, h, d) and set down
   *  at (x, y, z), in the same local frame the merged trim used.
   *
   *  The extents are floored at 0.1 mm. `PaperMass` DROPS a zero-area face as it
   *  builds one, and a template built once at unit size has nothing to drop — so
   *  a zero-height footprint (four of them in chunk 2 of the saved Taipei route:
   *  MVT `render_height` really can be 0) would hand the shader an instance
   *  matrix with a zero column, and three's instanced-normal path divides by the
   *  squared column length. 0/0 is NaN, and a NaN normal is a black building in
   *  WebGL only. A 0.1 mm part is invisible; a NaN one is not. */
  const _ie = new THREE.Euler();
  const boxInstance = (
    mesh: THREE.InstancedMesh, i: number,
    w: number, h: number, d: number, x: number, y: number, z: number,
    rotX = 0, rotY = 0, rotZ = 0,
  ): void => {
    _is.set(Math.max(w, 1e-4), Math.max(h, 1e-4), Math.max(d, 1e-4));
    _iq.setFromEuler(_ie.set(rotX, rotY, rotZ));
    mesh.setMatrixAt(i, _im.compose(_ip.set(x, y, z), _iq, _is));
  };
  // The unit shapes. The cutter tooth and the roll hub come from the SAME
  // `paperPartTemplate` the bodies instance, so this world has exactly one
  // opinion about what a tooth is shaped like — the repo has paid twice for the
  // other arrangement (two street lamps, two indicator LEDs).
  const unitBox = (): THREE.BufferGeometry => new THREE.BoxGeometry(1, 1, 1);
  const unitPlane = (): THREE.BufferGeometry => new THREE.PlaneGeometry(1, 1);

  /** Build one batched trim part, or nothing when this building has none.
   *
   *  `cast`/`recv` default OFF — three's own default, and the value for every
   *  part the demo did NOT build through its `box()` helper. They go into
   *  `mergeBuildingDecorations`'s batch key, so a wrong flag here is both a
   *  wrong shadow and an extra draw call. */
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

  /** The same, over one of the demo's shared unit shapes. The template belongs to
   *  `PART_TEMPLATES` (it outlives every chunk and is freed there), so it is
   *  tagged for the merge but never re-registered as trim. */
  const partBatch = (
    group: THREE.Group, shape: PartShape, material: THREE.Material, n: number,
    fill: (mesh: THREE.InstancedMesh) => void,
    cast = false, recv = false,
  ): void => {
    if (n <= 0) return;
    const template = paperPartTemplate(shape);
    if (!template) throw new Error(`paper style has no template for part shape '${shape}'`);
    const mesh = new THREE.InstancedMesh(
      markInstanceTemplate(template, material), material, n);
    mesh.castShadow = cast;
    mesh.receiveShadow = recv;
    fill(mesh);
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  };

  /** Toon material whose colour reads as crayon-on-paper (streaks + tooth),
   *  with dented-cardboard bumps under the toon light. */
  const crayonToon = (opts: THREE.MeshToonMaterialParameters) => {
    const mat = crayonize(toon(opts), crayonTexture());
    if (params.bumpEnabled) {
      mat.bumpMap = dentTexture();
      mat.bumpScale = DENT_BUMP_SCALE;
    }
    return mat;
  };
  /**
   * 「上色 ↔ 素紙板」的通則,一支函式:**關掉上色 = 顏料離開,底下的顏色不動。**
   *
   * demo 的每一組 swappable 都是這個形狀 —— `eraserBodyMats` 的素態是
   * `{ map: null, color: c }`、上色態是 `{ map: rep(washBody, …), color: washColor(c) }`;
   * `parkMat`、`zoneDecalMats`、`bushMats` 全部一樣。所以 gameview 這邊也是同一
   * 條規則:上色態掛顏料的筆觸(這個世界的 `crayonize`),素態不掛。
   *
   * 兩態共用同一個 `opts`,所以顏色、透明度、polygonOffset 之類的東西不可能在
   * 兩態之間分岔 —— demo 的 `swappable(mat, plain, painted)` 買到的也正是這件事
   * (它換的是 map/color/vertexColors,材質本體是同一個)。
   */
  const paintedToon = (opts: THREE.MeshToonMaterialParameters) =>
    (paintOn() ? crayonToon(opts) : dentedToon(opts));
  /** Toon that keeps its OWN colour map (crayonize would overwrite it) but still
   *  gets the dented-cardboard bumps. */
  const dentedToon = (opts: THREE.MeshToonMaterialParameters) => {
    const mat = toon(opts);
    if (params.bumpEnabled) {
      mat.bumpMap = dentTexture();
      mat.bumpScale = DENT_BUMP_SCALE;
    }
    return mat;
  };

  // ── 地被:夜燈登記 + 站得起來的那兩格 ──────────────────────────────────
  //
  // 所有權(hook 的合約 / §6):`buildLanduseProps` 掛上去的東西由
  // `disposeLanduseMeshes` 走訪回收,它會 dispose 每一份**沒有標
  // `userData.shared`** 的幾何與材質。一個 chunk 可以有十塊地,所以這裡的幾何與
  // 材質一律共用 + 標旗,由 `dispose()` 收;真正 per-patch 的只有積水那份
  // `ShapeGeometry`(不標,讓回收器收掉)。

  /** 地被道具的共用幾何。標 `shared`,chunk 回收器因此放過它們。 */
  const luGeos = new Map<string, THREE.BufferGeometry>();
  const luGeo = (key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry => {
    let g = luGeos.get(key);
    if (!g) {
      g = make();
      g.userData.shared = true;
      luGeos.set(key, g);
    }
    return g;
  };
  /** 同上,材質。 */
  const luMats = new Map<string, THREE.Material>();
  const luMat = (key: string, make: () => THREE.Material): THREE.Material => {
    let m = luMats.get(key);
    if (!m) {
      m = make();
      m.userData.shared = true;
      luMats.set(key, m);
    }
    return m;
  };

  /**
   * 濕地會站起來的東西:積水 + 蘆葦。**固定 2 個 draw call**,跟這塊地多大無關。
   *  ・積水:玻璃紙。水在這個世界就是玻璃紙(池塘已經是),所以直接沿用這個世界
   *    的水材質 —— 不是為了省材質,是因為它們**是同一種東西**(§3.10)。一塊地
   *    的所有水窪併成**一份**幾何(`ShapeGeometry` 吃 shape 陣列)。
   *  ・蘆葦:最多五叢、一叢三根,全部批進一個 `InstancedMesh`。
   *
   * ⚠ demo 這裡每一根都各自取自己腳下的地面高度(它的板子是**貼著地形**鋪的)。
   *   gameview 的板子是**平的**、而且已經 floor 量化到它壓到的最低那一階踏面,
   *   所以一律站在 `ctx.slabY` 上 —— 再去取一次 DEM 會把腳放到墊子上/下一層去
   *   (hook 的 docstring 寫著同一件事)。
   */
  const luWetlandProps = (ctx: LandusePropContext): THREE.Object3D => {
    const { centerX: cx, centerZ: cz, radius: r, rng } = ctx;
    const spread = Math.min(r, LU_SPREAD_MAX);
    const group = new THREE.Group();

    const shapes: THREE.Shape[] = [];
    const np = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < np; i++) {
      const ox = (rng() - 0.5) * spread * 1.15, oz = (rng() - 0.5) * spread * 1.15;
      const rr = spread * (0.13 + rng() * 0.15), sd = rng() * 9;
      const s = new THREE.Shape();
      for (let k = 0; k <= 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const rad = rr * (1 + 0.3 * Math.sin(a * 3 + sd) * Math.cos(a * 2 - sd));
        // Shape 的 y 是**北向公尺**,rotateX(-π/2) 會把它映到 −z(地被板同一道坑)
        const px = cx + ox + Math.cos(a) * rad, pz = cz + oz + Math.sin(a) * rad;
        if (k === 0) s.moveTo(px, -pz); else s.lineTo(px, -pz);
      }
      shapes.push(s);
    }
    const pg = new THREE.ShapeGeometry(shapes);
    pg.rotateX(-Math.PI / 2);
    // demo 是逐頂點寫 y(它要跟著地形起伏);這裡整片是平的,所以一次 translate
    // 就好,而且法向 rotateX 之後已經是 +y —— 不必再 computeVertexNormals()。
    pg.translate(0, ctx.slabY + 0.05, 0);
    const puddle = new THREE.Mesh(pg, luMat('puddle', () => {
      const m = strategy.createWaterMaterial();
      // demo 是 `puddle.renderOrder = LU_RANK.water`;gameview 的地被疊序住在
      // polygonOffset 裡(遠處才有效的那道),所以水窪拿的是**水面的名次**。
      applyOverlayDepth(m, 'water');
      return m;
    }));
    puddle.name = 'luwet';
    group.add(puddle);

    const nc = Math.max(2, Math.min(5, Math.round(r / 7)));   // ← 上限五叢,寫死
    const im = new THREE.InstancedMesh(
      luGeo('reed', buildReedGeometry),
      luMat('reed', () => paintedToon({ color: LU_REED_COLOR })),
      nc * 3,
    );
    im.castShadow = true;
    const o = new THREE.Object3D();
    let n = 0;
    for (let c = 0; c < nc; c++) {
      const a = rng() * Math.PI * 2, rad = spread * (0.18 + rng() * 0.64);
      const bx = cx + Math.cos(a) * rad, bz = cz + Math.sin(a) * rad;
      for (let k = 0; k < 3; k++) {
        // 一叢要**擠在一起**才讀得出是一叢(散開就只是三根孤零零的桿子),而且
        // 桿子要夠粗:0.18 那一版在 26 m 外只剩三條髮絲,§3.4 的「薄的會消失」
        // 對圓桿一樣成立。毛根本來就是毛的,粗一點才對。
        const jx = bx + (rng() - 0.5) * 1.2, jz = bz + (rng() - 0.5) * 1.2;
        const h = 1.9 + rng() * 1.5;
        o.position.set(jx, ctx.slabY + h / 2, jz);
        o.rotation.set((rng() - 0.5) * 0.5, rng() * 3.1, (rng() - 0.5) * 0.5);
        o.scale.set(0.27, h, 0.27);
        o.updateMatrix();
        im.setMatrixAt(n++, o.matrix);
      }
    }
    im.instanceMatrix.needsUpdate = true;
    group.add(im);
    return group;
  };

  /**
   * 遊樂場會站起來的東西。**固定 3 個 draw call**。
   * 這是五格裡唯一准站高的一格 —— 它跟球場在騎士眼高下唯一分得出來的訊號就是
   * 剪影(§3.4),所以這裡的東西要**高**、要**實心**(§3.5 鏤空會在天際線開洞)。
   *  ・攀爬架 = **長尾夾**:一個實心的深色梯形 + 兩道翻上來的細弧,約 5 m 高。
   *    不用迴紋針(騎手就是迴紋針,§3.3);長尾夾是這張桌上還沒被用掉的另一件文具。
   *    手把用圖釘的針色 —— 那是這個世界的「鐵絲」,不是新東西。
   *  ・滑梯 = 折過來的一片色紙。載體沿用 `AWNING_COLORS` 那批色紙:色紙是
   *    **材料**,色紙跟滑梯是兩個不同層級的東西,§3.3 管的是零件。
   */
  const luPlaygroundProps = (ctx: LandusePropContext): THREE.Object3D => {
    const { centerX: cx, centerZ: cz, radius: r, rng } = ctx;
    const spread = Math.min(r, LU_SPREAD_MAX);
    const gy = ctx.slabY;
    const group = new THREE.Group();

    const nc = r > 20 ? 2 : 1;              // ← 上限兩座,寫死
    const bodies = new THREE.InstancedMesh(
      luGeo('clipBody', buildClipBodyGeometry),
      luMat('clip', () => paintedToon({ color: LU_CLIP_COLOR })),
      nc,
    );
    const arms = new THREE.InstancedMesh(
      luGeo('clipArm', buildClipArmGeometry),
      luMat('pinMetal', () => new THREE.MeshPhongMaterial({
        color: LU_PIN_METAL_COLOR, specular: 0xffffff, shininess: 130,
      })),
      nc * 2,
    );
    bodies.castShadow = true;
    arms.castShadow = true;
    const o = new THREE.Object3D();
    o.rotation.order = 'YXZ';               // 先轉向,再把手把往前/後翻
    for (let c = 0; c < nc; c++) {
      const a = rng() * Math.PI * 2, rad = spread * (0.15 + rng() * 0.4);
      const bx = cx + Math.cos(a) * rad, bz = cz + Math.sin(a) * rad;
      const h = 3.6 + rng() * 0.9, w = 2.4 + rng() * 0.7, yaw = rng() * Math.PI;
      // 本體與手把的幾何都以**自己的底面**為原點(shape 的 y 是 0~1、半圈鐵絲的
      // 兩隻腳也在 y=0),所以位置直接給地面高度,不要再補 h/2 —— 補了會整座浮空。
      o.rotation.set(0, yaw, 0);
      o.position.set(bx, gy, bz);
      o.scale.set(w, h, w * 0.42);
      o.updateMatrix();
      bodies.setMatrixAt(c, o.matrix);
      for (let s = 0; s < 2; s++) {
        // 張角 0.55:兩支手把要**分得開**。0.42 那一版兩道弧疊在一起變成一個蝴蝶結,
        // 剪影上讀不出「兩支翻上來的手把」——而剪影是遊樂場唯一的訊號。
        o.rotation.set((s ? 1 : -1) * 0.55, yaw, 0);
        o.position.set(bx, gy + h, bz);      // 手把長在本體頂上
        o.scale.set(w * 0.95, h * 0.86, w * 0.95);
        o.updateMatrix();
        arms.setMatrixAt(c * 2 + s, o.matrix);
      }
    }
    bodies.instanceMatrix.needsUpdate = true;
    arms.instanceMatrix.needsUpdate = true;
    group.add(bodies);
    group.add(arms);

    const sa = rng() * Math.PI * 2, srad = spread * (0.3 + rng() * 0.4);
    const sx = cx + Math.cos(sa) * srad, sz = cz + Math.sin(sa) * srad;
    const sh = 2.6 + rng() * 0.7;
    const slide = new THREE.Mesh(
      luGeo('slide', buildSlideGeometry),
      luMat('slide', () => paintedToon({ color: AWNING_COLORS[0] })),
    );
    slide.name = 'luplay';
    slide.scale.set(sh, sh, 2.2 + rng() * 0.8);
    slide.position.set(sx, gy, sz);
    slide.rotation.y = rng() * Math.PI * 2;
    slide.castShadow = true;
    group.add(slide);
    return group;
  };

  const strategy: TerrainStyleStrategy = {
    style: 'paper',
    params,

    // ── Colours (paperified) ──
    terrainVertexColor: (ele, x, z) => groundVertexColor(ele, x, z),
    /** demo 的 `plateTopMats[Math.min(level, plateTopMats.length - 1)]` —— 同一
     *  個「夾在表尾」的選層,寫成積木那邊同一個 `bandAt` 形狀。
     *
     *  兩態:上色 = `TERRAIN_BAND` 的分層色,素紙板 = demo 那兩個交替的牛皮紙色
     *  (`PLATE_PLAIN_KRAFT`)。這是踏面顏色**唯一**的來源 —— 走廊地形的
     *  color attribute 從這裡填,`terrainVertexColor` 一格都碰不到(量在
     *  `paper-props-vs-demo.ts`:把它換成洋紅,踏面一格沒變)。 */
    bandAt: (y) => {
      const level = Math.min(
        TERRAIN_BAND.length - 1,
        Math.max(0, Math.round(y / Math.max(1, params.layerHeight))),
      );
      return paintOn() ? bandColors[level] : plainBandColors[level];
    },
    buildingColor: (lon, lat) => eraserColorFromCoord(lon, lat),
    roadColor: (cls) => ROAD_COLORS[cls] ?? ROAD_COLOR_FALLBACK,
    roadWidth: (cls) => ROAD_WIDTHS[cls] ?? ROAD_WIDTH_FALLBACK,
    // NOT paperified like the colours around it: these five are already gouache
    // pigments off the paper palette, and paperifying them a second time
    // collapses the five hues toward one kraft brown.
    zoneDecalColor: (zone) => ZONE_DECAL_COLORS[zone ?? 'residential'],
    treeTrunkColor: CUTOUT_TRUNK_COLOR,
    treeCanopyColors: CUTOUT_CANOPY_COLORS,
    // No separate roof colour. The kraft top belonged to the cardboard-box
    // buildings; an eraser is one solid piece of rubber, and its only contrast
    // is the paper sleeve — see buildBuildingDecoration.

    // ── Materials (matte kraft; coloured surfaces read as crayon-on-paper) ──
    // injectCloudShadow chains onto crayonize's onBeforeCompile (F3).
    //
    // ⚠ **NO BUMP MAP ON THE GROUND**, and that is not a perf call.
    //
    // The demo has no `bumpMap` anywhere in the file (asserted). Here the dents
    // were being hung on the踏面 too, and the踏面 is the one surface where they
    // cannot survive: it is FLAT, so `dot(N, L)` is one single value over the
    // whole visible floor, and the toon `gradientMap` turns that value into a
    // 3-step staircase. Any per-pixel wobble in the normal therefore does not
    // shade the floor — it flips the entire floor back and forth across one
    // hard step.
    //
    // And the wobble is guaranteed here, for a reason the demo never met: the
    // top UVs are RAW SCENE METRES (`quantized-terrain.ts` `pushTopTri` pushes
    // `ax, az`) measured from the route's first point, which is never rebased.
    // Twenty km along a ride that varying is ~1100, where a float32 ULP is
    // 1.3e-4 — bigger than the uv step between two neighbouring pixels of ground
    // in front of the wheel (~9e-5). three's `dHdxy_fwd()` samples
    // `texture2D(bumpMap, vBumpMapUv + dSTdx)`: at that magnitude the offset
    // rounds to zero for some pixels and to a whole ULP for others, so the
    // "height derivative" is quantisation noise. Noise × a 3-step gradient on a
    // constant-normal plane = the floor sparkling every frame — the rider's
    // 「材質出現會一直閃,不穩定」.
    //
    // The crayon wash stays (a plain `texture2D`, not a finite difference), and
    // it now filters anisotropically (`GROUND_ANISOTROPY`). The dents stay on
    // everything that is not the floor.
    createTerrainMaterial: () => injectCloudShadow(
      paintOn()
        ? crayonize(toon({ vertexColors: true }), crayonTexture())
        : toon({ vertexColors: true }),
    ),
    /**
     * 兩桶踏面:**第 0 階是切割墊,第 1 階以上才是瓦楞紙**(demo 的 `boardTopMat`
     * vs `plateTopMats`,見 `cuttingMatFloorMaterial`)。
     *
     * 為什麼是 2 而不是 6:上面那五階之間的差別是**顏色**,而顏色走的是頂點色 ——
     * 一份材質就夠了,拆成六份只會多五個 draw call 買到同一張畫面。第 0 階不一樣,
     * 它換的是**貼圖**,那非拆不可。
     */
    terrainTopLevels: 2,
    createTerrainTopMaterialForLevel: (level) => (
      level === 0 ? cuttingMatFloorMaterial() : null
    ),
    // Cut edges (step risers / skirts): raw corrugated cardboard — ignores
    // vertex colours so the board core contrasts with the crayoned top sheet.
    createTerrainWallMaterial: () => toon({ map: corrugationTexture() }),
    // **沒有 `sideWall`,而且這是 demo 自己刪掉的。** 另外兩個世界的板子都有一道
    // 九公尺的側牆(`sideWallSeg`);這個世界的地台是切割墊本身,不是一片紙板,
    // 所以沒有板可切。demo 的原話:
    //
    // > 地台 = **切割墊本身**,不是一層瓦楞紙。[…] 評圖模型是「在墊子上疊出地
    // > 形」,所以墊子就是海拔 0,只有高過第一道等高線的地方才開始疊瓦楞紙。多疊
    // > 一層平的紙板,墊子就退化成背景紙,「在上面動刀」那個身分又沒了。
    // > 順帶:兩側的瓦楞切邊跟著消失(沒有紙板哪來的切口),每個 chunk 少 2 個
    // > draw call。
    //
    // 走廊的側邊因此沿用原本那道短裙邊 —— 它是 gameview 才有的東西(地形有起伏,
    // 不收邊會看穿到板子底下),不是 demo 的板緣。
    createBuildingMaterial: () => {
      if (!buildingMaterial) {
        buildingMaterial = paintedToon({ vertexColors: true }) as THREE.MeshToonMaterial;
      }
      return buildingMaterial;
    },

    // Masking tape laid down the road, with correction-fluid dashes. The road
    // ribbon supplies metre-scale u, so the dash pitch is constant.
    createRoadMaterial: () => {
      const map = propTexture('tape', createTapeRoadTexture);
      map.repeat.set(1 / ROAD_TEXTURE_METERS, 1);
      return toon({
        map,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      });
    },
    /**
     * Water = cellophane over blue paper: translucent with a hard white glint.
     * The demo's `pondFilmMat`, number for number.
     *
     * ⚠ The demo's pond is TWO layers — an opaque `pondBottomMat` basin cut out
     * of board (`#4f86b4`) with this film laid over it slightly oversized and
     * turned a few degrees, so the edge lifts. `createWaterMaterial` is one
     * material for one surface, so only the film comes across; the paper basin
     * under it would need a second layer from `landuse-renderer` /
     * `waterway-renderer` and is not ported.
     */
    createWaterMaterial: () => new THREE.MeshPhongMaterial({
      color: 0x7cc4e8,
      specular: 0xffffff,
      shininess: 160,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
    }),
    // The demo's `parkMat` in its plain-board state: cut art paper, not a green
    // wash. (Its painted state is gouache over the same board — `swappable`,
    // which has no counterpart here yet.)
    createParkMaterial: () => paintedToon({
      color: 0x8fbf5a, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    createForestMaterial: () => paintedToon({
      color: paperifyHex(0x1b5e20), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    /**
     * 沙地 = **橡皮擦屑**。demo 的 `luSandMat`。
     *
     * **非雙態**,而且 color 是白的 —— 屑的顏色全部畫在貼圖裡。它的識別點就是
     * 「幾種顏色混在一起」,乘一個 `material.color` 會把六色壓成一色,那就只是
     * 一片有雜點的土(所以這張也是五張裡唯一不走中性灰的)。
     *
     * ⚠ 這裡以前是 `paintedToon({ color: paperifyHex(0xd2b48c) })` —— 一片**純
     *   色**的土黃,而純色在 6.3 m 掠角下等於沒有答案(§3.4:這一格唯一活得下來
     *   的訊號就是顏色與粗糙感)。
     */
    createSandMaterial: () => toon({
      map: luTile(propTexture('luSand', createSandTexture), LU_SAND_TILE),
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    // The district wash — gouache brushed onto the board. `vertexColors` is what
    // lets all five zones share one material; `depthWrite: false` keeps a
    // translucent wash from hiding things legitimately level with it.
    //
    // Ordering note, for whoever tunes the paper look: three runs `map_fragment`
    // BEFORE `color_fragment`, so the crayon shader's mix toward bare paper now
    // happens before the vertex tint instead of after it. The tooth therefore
    // comes out tinted with the district colour rather than paper-neutral — a
    // slightly stronger wash than the old single-colour version. Deliberate;
    // fixing it would mean a second crayon chunk that exists only for this one
    // material.
    createZoneDecalMaterial: () => paintedToon({
      vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    // Scissors-cut card: the silhouette lives in the texture's alpha.
    createTreeMaterial: () => toon({
      // 兩態各一張圖集(demo 的 `treeCutoutTexture(kind, painted, seed)`),各自
      // 快取 —— 共用一個 key 的話切了模式也還是拿到第一次那張。
      map: propTexture(paintOn() ? 'treeCutout' : 'treeCutoutPlain',
        () => createTreeCutoutTexture(paintOn())),
      transparent: true,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    }),
    // 五格地被的材質。**一律 `toon` 不 `crayonToon`**:`crayonize()` 會把
    // `mat.map` 換成它的明暗遮罩,那會靜靜地把這幾張手畫的貼圖吃掉(它做過一次)。
    // 顏料的兩態在這裡是**只換 color、不換 map**(demo 的原話:同一張紙,兩種
    // 顏料),所以貼圖畫成中性灰、色差全部由 `paintOn()` 這一行帶。
    // 也**一律不掛 bumpMap** —— 理由寫在上面那個區塊的檔頭(平面 + 未 rebase 的
    // 公尺 uv = 逐幀閃),而且 demo 從頭到尾一張都沒有。
    //
    // `polygonOffset` 這三個值只是佔位:真正的名次由 `landuse-renderer` 的
    // `sharedLanduseMaterial` 呼叫 `applyOverlayDepth(mat, kind)` 蓋上去。
    createWetlandMaterial: () => toon({
      map: luTile(propTexture('luWet', createWetlandTexture), LU_WET_TILE),
      color: paintOn() ? LU_WET_PAINTED : LU_WET_PLAIN,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    createFarmlandMaterial: () => toon({
      map: luTile(propTexture('luFarm', createFarmlandTexture), LU_FARM_TILE),
      color: paintOn() ? LU_FARM_PAINTED : LU_FARM_PLAIN,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    /**
     * 球場。**非雙態** —— 方格紙是印好的、修正液是畫上去的,兩樣都不是顏料
     * (跟紙膠帶馬路、修正液虛線同一類)。有人來「補上兩態」之前請先看上面那個
     * 區塊裡的判準。
     *
     * 夜:**這片地自己不發光**(使用者裁示,demo 已改)。原本它走 `nightLit()` 刷
     * 一層冷白 emissive,而一整片地面亮起來讀出來是**招牌**不是照明 —— 招牌是別的
     * 元件的身分(§3.3),而且那正是 §3.10「小、在裡面、被半透明的殼包著」的反面。
     * demo 現在就是這一行:`luApplyDepth(toon({ map: rep(luSportsTex, …) }),
     * 'sports')`,五格地被一格都不自己發光。
     *
     * 照亮它的是場邊站的那支**螢光筆路燈**,燈的身分跟**地塊的 seed** 綁(那塊地
     * 重心取整),不是路燈池的索引 —— 池是滑動的,綁索引會讓同一座球場每 70 m 換
     * 一次色(`2427d86` 修過)。擺燈是 `landuse-renderer` 的事,不新增任何詞彙。
     */
    createSportsFieldMaterial: () => toon({
      map: luTile(propTexture('luSports', createSportsFieldTexture), LU_SPORTS_TILE),
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    /**
     * 遊樂場的鋪面 = 軟木(布告欄那種),demo 的 `luPlayMat`。
     *
     * 五格裡唯一站得高的那一格的地墊 —— 造型在 `buildLanduseProps`,這裡只有地。
     * 它**沒有自己的造型 canvas**:軟木就是「底色 + 一堆斑」,跟中性紙斑同構,
     * 所以吃 `kraftNeutral` + 染色 + 把 repeat 放大讓斑變粗(§6 這個世界的解法)。
     */
    createPlaygroundMaterial: () => toon({
      map: luTile(propTexture('kraftNeutral', createKraftNeutralTexture), LU_PLAY_TILE),
      color: paintOn() ? LU_PLAY_PAINTED : LU_PLAY_PLAIN,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),

    /**
     * 五格地被裡站得起來的那兩格。demo 的 `LU_STYLE.props(kind, ctx)`。
     *
     * 農田 / 球場 / 沙地 **一件道具都不放** —— 壟、線、顆粒全部是貼圖,理由是台北
     * 一個 3×3 圖磚窗口裡球場有 512 塊(一件道具 = 五百多個 draw call)。「這一格
     * 什麼都不站」是設計出來的答案,不是還沒做完。
     */
    buildLanduseProps: (ctx) => {
      if (ctx.kind === 'wetland') return luWetlandProps(ctx);
      if (ctx.kind === 'playground') return luPlaygroundProps(ctx);
      return null;
    },

    // ── Diorama props ──

    horizonColor: CUTTING_MAT_COLOR,

    // The cutting mat. NOT `crayonToon` — `crayonize()` REPLACES `mat.map` with
    // its shading mask and would silently eat the mat's grid and scars, exactly
    // as it once ate the three ground overlays below. Plain toon, FrontSide (a
    // 4 km plane seen from underneath is a black wedge across the frame — see
    // mountain-ring.ts), opaque, and no bump map: the dent bumps are for board
    // that has been handled, and a PVC mat is the one flat thing on the desk.
    createHorizonMaterial: () => toon({
      map: propTexture('cuttingMat', createCuttingMatTexture),
      side: THREE.FrontSide,
    }),

    /**
     * The architecture model's PRESENTATION CASE — the cover a crit model is
     * kept under, standing on the cutting mat it was built on. Of the three
     * worlds this is the one that needs no explanation at all; it is simply how
     * these models are stored.
     *
     * Cooler and greyer than the toy world's box: cast sheet acrylic bent and
     * glued, not injection-moulded, so the tint is closer to window glass and
     * the shell carries slightly less colour. Its reflection is a fabricator's
     * one, not a moulder's: TWO wide, soft streaks from the studio's strip
     * lights rather than a hard double bounce. Numbers are the paper demo's own
     * (`plan/paper-town-demo.html`).
     *
     * This world takes no bloom (`sceneBloomEnabled: false`), so the case has to
     * carry its own presence entirely through alpha distribution and highlights
     * — exactly as the demo's comment says.
     */
    acrylicCase: {
      tintDay: 0xdceaef,
      tintNight: 0x8fa2c6,
      tintRain: 0xa9c2cf,
      rimDay: 0xcfe2ea,
      rimNight: 0x8fa2c6,
      lipColor: 0xe2f0f4,
      streakDay: 0xffffff,
      streakNight: 0xd8e2f0,
      rainFilmColor: 0xdceef5,
      shellOpacity: 0.15,
      rimOpacity: 0.3,
      lipOpacity: 0.42,
      streakOpacity: 0.3,
      // Strip lights, wider and softer than the toy box's hard double bounce,
      // in two strong / two faint pairs — a studio's ceiling grid, not a
      // moulder's twin reflection. All four run down to theta ≈ 1.4–1.5 for the
      // reason in `AcrylicStreak`.
      //
      // Spaced right round the case at ~1.6 rad, for the reason spelled out in
      // the toy world's copy of this list: the case never turns, so a cluster
      // is invisible for whichever heading a route happens to hold. One or two
      // are in frame from anywhere, which is the count the spec is about.
      streaks: [
        [0.94, 0.1, 0.1, 1.42],
        [2.54, 0.05, 0.24, 1.2],
        [4.02, 0.07, 0.14, 1.36],
        [5.62, 0.045, 0.28, 1.1],
      ],
    },

    // Warm paper daylight → ink-blue desk-lamp night. Straight from the paper
    // demo (ref-demo-paper-src.js DAY/NIGHT); tuned for exposure 1.05.
    skyPalette: {
      // demo:`float h = clamp(vP.y / 500.0, …)` / `floor(h * 5.0) / 5.0` on its
      // 1100 m dome — a horizon band nearly twice as tall as plastic's 260.
      gradient: { demoHeight: 500, steps: 5 },
      // demo 的星星那一段,原封搬過來(plan/paper-town-demo.html):
      //   const n = 260 … ph = Math.random() * Math.PI * 0.42 + 0.08
      //   sg.fillStyle = '#fff8e0'; sg.arc(16, 16, 7, 0, Math.PI * 2);
      //   new THREE.PointsMaterial({ size: 28.42105263157895, … })
      // size 是**世界公尺**(sizeAttenuation),不是螢幕像素 —— 見 starPointSize。
      // 顏色比塑膠再白一階(#fff8e0 vs #fff2a0):紙上的燈光是暖白,不是糖果黃。
      stars: {
        count: 260, size: 28.42105263157895,
        polarSpan: 0.42, polarMin: 0.08,
        spriteRadius: 7, color: '#fff8e0',
      },
      day: {
        skyTop: 0xa8d4e2, skyBottom: 0xf3e9d2, fog: 0xe8dcc0,
        sunColor: 0xfff1d6, sunIntensity: 2.0,
        hemiSky: 0xcfe8f0, hemiGround: 0xc9a06b, hemiIntensity: 0.9,
        ambientColor: 0xfff5e0, ambientIntensity: 0.35,
      },
      night: {
        skyTop: 0x232a4d, skyBottom: 0x4a4066, fog: 0x3a3355,
        sunColor: 0x9fb4e8, sunIntensity: 0.7,
        hemiSky: 0x3a4470, hemiGround: 0x4a3a30, hemiIntensity: 0.5,
        ambientColor: 0xfff5e0, ambientIntensity: 0.18,
      },
    },

    // 一筆墨畫的天體 —— demo 的 `paperDisc` 原封搬過來(plan/paper-town-demo.html)。
    //
    // 平塗圓 + 12 根放射短線;太陽多一圈墨輪廓,月亮不畫輪廓、改在左上啃掉一塊
    // 當月相。**月相那塊一定要 clip**:2D 版的咬痕圓有一截落在月亮外面,在 2D 那裡
    // 是天空蓋天空所以看不出來,在這裡背景是透明的,不夾就會在圓盤外面留一塊實心色。
    //
    // 顏色是從**這個世界自己的 3D 貨架**推出來的(INK_FAR_* → INK_NEAR_* 那把兩階
    // 濃淡尺各再往外推一階、冷色對自己的 luma 灰軸鏡射),不是從 2D 抄的 —— 2D 是
    // 造型的規格,不是顏色的(§3.11)。推導本身住在 demo 的註解裡,而
    // `[celestial design vs demos]` 會拿 demo 的貨架把它重跑一次,所以這裡照抄
    // demo 的呼叫點就夠了,也只有這樣才不會兩邊各推一次、各推出一個值。
    //
    // 月亮的短線用**月亮自己的平塗色**而不是墨線,那個不對稱是對的:鏡射過去的冷
    // 墨線是 #293342,壓在夜空 #232a4d 上等於沒畫。
    buildCelestialDisc: (body, shellRadius) => {
      // demo:`paperDisc(42, '#c3b9a4', '#3b3122', '')` /
      //      `paperDisc(34, '#b1bbd0', '#b1bbd0', '#232a4d')`
      const [demoRadius, wash, line, bite] = body === 'sun'
        ? [42, '#c3b9a4', '#3b3122', ''] as const
        : [34, '#b1bbd0', '#b1bbd0', '#232a4d'] as const;
      const r = celestialDiscRadius(body, shellRadius, demoRadius);
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d')!;
      // 手抖與亂數走兩支**封閉式**的式子(2D 版 wob / seeded 原式照抄),不從任何
      // 共用亂數流抽數 —— CUSTOM_WORLD_INSTRUCTIONS §5 最後那條。
      const wob = (x: number, seed: number): number =>
        Math.sin(x * 0.045 + seed) * 1.6 + Math.sin(x * 0.13 + seed * 2.3) * 1.0;
      const seeded = (n: number): number => {
        const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
        return s - Math.floor(s);
      };
      // 本體只佔畫布的一半,另一半留給短線 —— 2D 版的比例(本體 26 / 畫到 48)。
      const R = 34;
      g.fillStyle = wash;
      g.beginPath();
      g.arc(64, 64, R, 0, Math.PI * 2);
      g.fill();
      if (bite) {
        g.save();
        g.beginPath();
        g.arc(64, 64, R, 0, Math.PI * 2);
        g.clip();
        g.globalAlpha = 0.85;
        g.fillStyle = bite;
        g.beginPath();
        g.arc(64 - 13, 64 - 6, R * 0.8, 0, Math.PI * 2);
        g.fill();
        g.restore();
      } else {
        g.strokeStyle = line;
        g.lineWidth = 4;
        g.globalAlpha = 0.8;
        g.beginPath();
        g.arc(64, 64, R, 0, Math.PI * 2);
        g.stroke();
      }
      // 12 根放射短線。根數、起始角、內外半徑的式子全部照抄 2D。
      g.strokeStyle = line;
      g.lineWidth = bite ? 3 : 4;
      g.globalAlpha = bite ? 0.6 : 0.7;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + 0.2;
        const r1 = R + 7 + wob(i * 40, 3) * 2;
        const r2 = r1 + 8 + seeded(i) * 6;
        g.beginPath();
        g.moveTo(64 + Math.cos(a) * r1, 64 + Math.sin(a) * r1);
        g.lineTo(64 + Math.cos(a) * r2, 64 + Math.sin(a) * r2);
        g.stroke();
      }
      g.globalAlpha = 1;
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return new THREE.Mesh(
        new THREE.CircleGeometry(r, 40),
        new THREE.MeshBasicMaterial({
          map: t, transparent: true, fog: false, depthWrite: false,
        }),
      );
    },

    // 棉花球雲 —— demo 的「棉花球雲」原封搬過來(plan/paper-town-demo.html):
    // 藥用棉球,表面是絨的,所以是細筆觸 + 幾乎不留底色的 gouache。高度、
    // 漂移、入雲淡出全歸 sky-and-fog(deck 行為不是造型)——這裡只管一朵雲
    // 長什麼樣。
    buildCloud: (_index, rand) => {
      // 亂數一律走 rand(預設 Math.random):three 每建一個物件都會為 uuid 抽
      // 四次 Math.random,check:3d 的 seeded 流直接吃全域的話永遠對不上 demo。
      const rnd = rand ?? Math.random;
      if (!cottonMat) {
        // demo:toon({ map: rep(gouacheTexture('#f6f2e8', {…}), 1.6, 1.6) })
        cottonTex = new THREE.CanvasTexture(gouacheCanvas('#f6f2e8', {
          seed: 0xc077, substrate: '#e2dccc', brush: 15, coverage: 0.97, grain: 200, size: 128,
        }));
        cottonTex.wrapS = cottonTex.wrapT = THREE.RepeatWrapping;
        cottonTex.colorSpace = THREE.SRGBColorSpace;
        cottonTex.repeat.set(1.6, 1.6);
        cottonMat = new THREE.MeshToonMaterial({ gradientMap: gradient, map: cottonTex });
        cottonMat.userData.shared = true;
        cottonGeo = new THREE.SphereGeometry(0.5, 14, 10); // demo 的 unitSphere(14, 10)
        cottonGeo.userData.shared = true;
      }
      // 亂數的**消費順序**跟 demo 一字不差:check:3d 拿同一條 seeded 流跑
      // demo 原始碼跟這裡,逐顆比對矩陣 —— 改順序不會壞畫面,會壞校準。
      const n = 4 + Math.floor(rnd() * 3);
      const cloud = new THREE.InstancedMesh(cottonGeo!, cottonMat, n);
      const m = new THREE.Matrix4();
      for (let j = 0; j < n; j++) {
        const r = 5 + rnd() * 5;
        const px = (j - n / 2) * 6.5;
        const py = (rnd() - 0.5) * 3;
        const pz = (rnd() - 0.5) * 5;
        m.makeScale(r * 2, r * 2 * (0.78 + rnd() * 0.24), r * 2);
        m.setPosition(px, py, pz);
        cloud.setMatrixAt(j, m);
      }
      cloud.instanceMatrix.needsUpdate = true;
      // InstancedMesh 的預設包圍球是那顆 0.5 m 的單位球 —— 不重算的話,雲
      // 稍微離開視錐中心就被整朵剔掉(probe 不做剔除,PNG 上看不出來)。
      cloud.computeBoundingSphere();
      return cloud;
    },

    // Highlighter swipe down the road, ink bleeding out around it — the widths/
    // opacities are the paper demo's (hl 1.8 @ 0.9, glow 4.0 @ 0.25).
    routeLine: {
      coreColor: HIGHLIGHTER_INK,
      coreWidth: 1.8,
      coreOpacity: 0.9,
      glowColor: HIGHLIGHTER_BLEED,
      glowWidth: 4.0,
      glowOpacity: 0.25,
    },
    // The cut-out's own colours must survive: no instanceColor multiply, and no
    // inverted hull (it would be a solid black quad behind each card).
    tintTreeInstances: false,
    outlineTrees: false,

    // Two states, the demo's `inkMat(paintHex, plainHex)` — see MOUNTAIN_PLAIN_*.
    // Read through `paintOn()` at BUILD time, which is the same contract every
    // other two-state surface here works to (`paintedToon`): the ring is rebuilt
    // by `MountainRing.setStrategy`, so it picks the mode up the same way a chunk
    // does.
    mountainColor: (layer) => (paintOn()
      ? (layer === 'near' ? MOUNTAIN_NEAR_COLOR : MOUNTAIN_FAR_COLOR)
      : MOUNTAIN_PLAIN_COLOR),

    // The demo's `inkRidge` ridge line: three summed harmonics at 1 / 0.45 / 0.18
    // of the amplitude, phases drawn in that order from the ring's own stream.
    // Same writing as the 2D version (sin + sin×2.7 + 手抖).
    //
    // What this replaces was a re-derivation — a new random peak height every
    // 4–7 segments, clamped at 0.88 — which is the 2D `generateMountainPoints`
    // idea rather than anything the 3D demo does. It gave a jagged card skyline
    // where the demo gives a rolling ink wash; nothing recorded the divergence.
    generateMountainProfile: (layer, seed, segments) => {
      const o = INK_RIDGE[layer];
      const rng = mulberry32(seed);
      const ph = [rng() * 6.283, rng() * 6.283, rng() * 6.283];
      const prof = (a: number): number => o.base
        + Math.sin(a * o.h1 + ph[0]) * o.amp
        + Math.sin(a * o.h2 + ph[1]) * o.amp * 0.45
        + Math.sin(a * o.h3 + ph[2]) * o.amp * 0.18;
      const profile: number[] = [];
      // i runs to `segments` inclusive; the last angle is a full 2π, and with
      // integer harmonics that lands on exactly the same value as i = 0.
      for (let i = 0; i <= segments; i++) {
        profile.push(prof((i / segments) * Math.PI * 2) / o.maxH);
      }
      return profile;
    },

    // 一圈墨色剪影 = wash + line. Both halves of the demo's `{ wash, line }`.
    //
    // `fog: false` is the load-bearing line. The demo says why:
    //
    // > **不吃霧**。同理:它已經是「遠」的表現手法本身,再被霧吃一次就糊了。
    // > 濃淡直接由兩圈的顏色決定(遠淡近濃),那才是水墨處理距離的方式。
    //
    // The two wash tones above ARE the distance cue; fogging them a second time
    // was putting the far ring 82% of the way to the sky colour, which is a
    // silhouette that has stopped existing. Unlit + unfogged means these hex
    // values are literally what reaches the screen.
    mountainRingFinish: (layer) => ({
      ridgeLineColor: paintOn()
        ? (layer === 'near' ? MOUNTAIN_NEAR_LINE : MOUNTAIN_FAR_LINE)
        : MOUNTAIN_PLAIN_LINE,
      // demo: lineH = o.maxH * 0.035
      ridgeLineThickness: 0.035,
      fog: false,
    }),

    buildBikeOrnament: () => buildPaperclipBike(gradient),
    buildPlaneOrnament: () => buildPlaneBalloon(gradient),
    buildFinishAirship: () => buildZeppelin(gradient),

    buildStreetLamp: (index = 0) => buildHighlighterLamp(gradient, index),

    // Coin = a gold drawing pin: head disc + spike.
    buildCoinMesh: () => {
      const headMat = new THREE.MeshPhongMaterial({
        color: 0xe8b93a, specular: 0xfff2c0, shininess: 110, emissive: 0x5a4008,
      });
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.35, 20), headMat);
      disc.geometry.rotateX(Math.PI / 2);
      // demo `coinBatch`: `heads.castShadow = true`, and NOTHING on `pins` —
      // the spike lives inside the head's own silhouette from every direction
      // the sun comes from, and a coin hovering at 3.4 m receives nothing.
      disc.castShadow = true;
      const pin = new THREE.Mesh(
        new THREE.ConeGeometry(0.3, 1.2, 8),
        new THREE.MeshPhongMaterial({ color: 0xc8cdd4, specular: 0xffffff, shininess: 130 }),
      );
      pin.position.y = -1.6;
      pin.rotation.x = Math.PI;
      disc.add(pin);
      disc.userData.isCoin = true;
      return disc;
    },

    /**
     * Checkpoint = a map pin (silver shaft, red head) flying a strip of LABEL
     * TAPE — the demo's `makeCheckpoint`, including the part it deleted.
     *
     * The flag used to be a blank sticky note with the tape stuck across it.
     * The demo threw the note away and made the tape itself the flag, and said
     * why: 「原本是一張空白便利貼,寫不了字;移植之後系統要在這裡寫『開始 /
     * 結束 / 各階段』,所以載體直接沿用招牌那套 —— 同一個世界不該為了旗子再
     * 發明第二種寫字的東西。」 Keeping both left two things on one pole fighting
     * over which of them is the flag (the failure the circuit demo names by
     * name), and shrank the tape to 5.4 m so it would fit on the note it no
     * longer needs to fit on. The demo's width is 7.2.
     *
     * ONE deviation: the tape takes the segment's colour. The demo cycles
     * `CP_ZONES[i % 3]` through the shop-sign tape palette because it has no
     * other identity to hang on a checkpoint; gameview has a real per-segment
     * colour that the HUD shows too, and the other two worlds already paint
     * their checkpoint with it. Carrier, size, position and tilt are the demo's.
     */
    buildCheckpoint: (color, _index, label) => {
      const group = new THREE.Group();
      const metal = new THREE.MeshPhongMaterial({
        color: 0xc8cdd4, specular: 0xffffff, shininess: 130,
      });

      // demo `makeCheckpoint`: `pole.castShadow` and `head.castShadow`, both
      // with receiveShadow left off — a 0.36 m pin and a ball on top of it.
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 13, 8), metal);
      pole.position.y = 6.5;
      pole.castShadow = true;
      group.add(pole);

      const head = new THREE.Mesh(
        new THREE.SphereGeometry(1.1, 16, 12),
        toon({ color: 0xe34a4a }),
      );
      head.position.y = 13.4;
      head.castShadow = true;
      group.add(head);

      const tag = strategy.buildSign?.('checkpoint', label ?? '', 7.2);
      if (tag) {
        tag.group.position.set(3.4, 10.2, 0);
        // 旗面朝**騎士來的方向**。`CheckpointFlagManager` 用 demo 的
        // `cp.rotation.y = atan2(p.tx, p.tz)` 把局部 +Z 對到前進方向,所以騎士
        // 從 −Z 靠過來 —— 轉 180° 才是迎著他。
        //
        // ⚠ 這一條 demo 不一致:**只有積木 demo 問過這個問題**並寫下答案
        // (「第一版轉了 90°(以為 +X 面向馬路),結果整塊牌子側對騎手」);
        // 瓦楞紙與電子 demo 的字都留在 +Z(順著前進方向),那面騎士一路上看不到。
        // 這裡採積木 demo 的規則 —— 它是三支裡唯一仲裁過的。
        tag.group.rotation.y = Math.PI;
        tag.group.rotation.z = -0.06;
        // The tape is the checkpoint's own material (see `pick` in buildSign),
        // so recolouring it here cannot reach a shop sign.
        const tape = tag.group.getObjectByName('tape') as THREE.Mesh | undefined;
        const tapeMat = tape?.material;
        if (tapeMat instanceof THREE.MeshPhongMaterial) tapeMat.color.set(color);
        group.add(tag.group);
      }
      return group;
    },

    /**
     * Embossed label tape. Local frame: plate centred on the origin, face
     * looking down +Z, thickness centred on z = 0.
     *
     * The 3:1 proportion is shared by every world, so when the height cap bites
     * the WIDTH shrinks with it. Squashing the height instead would break the
     * one thing that makes three different carriers read as the same kind of
     * object from a distance.
     */
    buildSign: (purpose: SignPurpose, text, maxWidth, opts) => {
      const clean = sanitizeSignText(text);
      const symbol = opts?.symbol ?? null;
      // A shop sign with nothing to say is not built at all. A CHECKPOINT still
      // is: the tape IS the flag now (see buildCheckpoint), and the demo's
      // `labelSign` likewise always cuts the strip and only the glyphs are
      // conditional. An unlabelled checkpoint with no flag is a bare pin.
      if (!clean && !symbol && purpose !== 'checkpoint') return null;
      const w = Math.min(maxWidth, SIGN_MAX_WIDTH);
      if (w < 2.5) return null;
      const h = w / SIGN_RATIO;
      // Thickness floor of 0.34 m: the chase camera's eye is only 6.3 m up, so
      // a plate seen edge-on has almost no area. Thin cards disappear.
      const t = Math.max(0.34, h * 0.26);

      const group = new THREE.Group();
      const geos: THREE.BufferGeometry[] = [];
      // A checkpoint OWNS its materials. `CheckpointFlagManager` fades a passed
      // flag by writing `opacity` onto every material in the group — hand it a
      // strategy-owned singleton and one passed checkpoint would fade every
      // shop sign on the route. Checkpoints are one per segment boundary, so
      // the extra materials cost nothing; shop signs (dozens per chunk) share.
      const owned: THREE.Material[] = [];
      const pick = (key: string, make: () => THREE.Material): THREE.Material => {
        if (purpose !== 'checkpoint') return signMat(key, make);
        const m = make();
        owned.push(m);
        return m;
      };

      // The demo's `unitLabelTape`: cut ONCE at unit size (3 × 1 × 1, thickness
      // already centred) and scaled per sign. Cutting the outline at final size
      // instead — `roundedPlateShape(w, h, h * 0.22)` — is the same shape on
      // paper, but the last arc lands on `(-y + rr) - rr`, which for a 7.2 m
      // tape is one ULP off `-y`. `ShapeUtils.removeDupEndPts` compares exactly,
      // so the outline kept a 38th point and the triangulator turned it into a
      // zero-area triangle in each cap. Scaling a unit outline has neither
      // problem and is what the demo does.
      const plate = unitLabelTapeGeometry().clone().scale(h, h, t);
      geos.push(plate);
      const zone = opts?.zone ?? 'commercial';
      const tapeMesh = new THREE.Mesh(plate, pick(`tape:${zone}`, () => makeTapeMat(zone)));
      // Named so a checkpoint can recolour ITS OWN tape (see buildCheckpoint).
      tapeMesh.name = 'tape';
      tapeMesh.castShadow = true;
      tapeMesh.receiveShadow = true;
      group.add(tapeMesh);

      const relief = h * 0.16;
      // demo `labelSign`: the hospital triangle is a raw `unitTri` mesh with
      // `tri.castShadow = true` only; the glyph strokes go through `box()`,
      // which opens both. Same building, two different answers, because the
      // triangle is a plate lying ON the tape and the strokes are solid bars
      // half sunk into it.
      if (symbol) {
        const tri = buildSignTriangleGeometry(h, relief);
        tri.translate(0, 0, t / 2);
        geos.push(tri);
        const triMesh = new THREE.Mesh(tri, pick('tri', makeTriangleMat));
        triMesh.castShadow = true;
        group.add(triMesh);
      } else {
        const strokes = buildStrokeGeometry(signStrokes(w, h, clean), relief);
        if (strokes) {
          strokes.translate(0, 0, t / 2);
          geos.push(strokes);
          const inkMesh = new THREE.Mesh(strokes, pick('emboss', makeEmbossMat));
          inkMesh.castShadow = true;
          inkMesh.receiveShadow = true;
          group.add(inkMesh);
        }
      }
      return {
        group,
        width: w,
        height: h,
        // Shared materials (shop signs) are the strategy's to free — see
        // `dispose()` below. Only the per-checkpoint ones are ours.
        dispose: () => {
          for (const g of geos) g.dispose();
          for (const m of owned) m.dispose();
        },
      };
    },

    /**
     * The school writes its label across a LID RIM, so it names the height
     * rather than taking the renderer's draw — demo:
     * `mountSign(grp, 'school', 'ABC', w, d, h, tierH + bodyH + lidH / 2,
     * LID_OUT / 2)`.
     *
     * Which rim: the MIDDLE box's. That is not a taste call. The height works
     * out to `2h/3 − lidH/2`, i.e. a fraction of `2/3 − lidH/(2h)`, which for
     * `lidH = min(0.8, h/6)` is 0.5833 at and below h = 4.8 m and climbs
     * asymptotically toward 0.6667 above it. The whole range sits inside the
     * DEVPLAN band (0.55–0.70), so "on the lid rim" and "at the height the spec
     * asks for" are the same place and there is nothing to trade off.
     *
     * `faceOut` is the lid's overhang, `LID_OUT / 2` = 0.35 m. The renderer
     * measures the standoff from the BOX face; the lid stands 0.35 m proud of
     * it, so without this the plate would be mounted 0.35 m into the lid it is
     * supposed to be stuck on (0.10 m of clearance instead of 0.45 m).
     *
     * ⚠ The plate is TALLER than the 0.8 m rim and straddles it. Sizing it to
     * fit would mean a width of 3 × 0.8 = 2.4 m, and `signPlacement` refuses
     * anything under 2.5 m as illegible — a school with no sign at all. The 3:1
     * ratio is shared by all six demos and must not be squashed either. A real
     * archive box's label is stuck across the lid rim exactly like this.
     *
     * Null for the other four: their walls are flat and the seeded draw is the
     * right answer there.
     */
    signAnchor: (box, zone) => {
      if (zone !== 'school') return null;
      const L = fileBoxLayout(box);
      return {
        centerY: L.tierH + L.bodyH + L.lidH / 2,
        faceOut: FILE_LID_OUT / 2,
      };
    },

    // Matchbox body: whichever of the five stationery objects this district
    // biases toward (80 % its own, 20 % a neighbour — see paperBuildingKind).
    // Every one of them is built from the SAME layout functions the trim and the
    // lights read, so the three can never disagree about what this building is.
    //
    // Only ever reached for the eraser now (`buildBuildingBoxes` answers for the
    // other four), but it still routes through the same parts for them so the
    // two hooks cannot describe different buildings.
    buildBuildingBody: (box, seed, zone) => {
      const parts = paperBodyParts(box, seed, zone);
      return parts ? partsToGeometry(parts) : eraserBody(box);
    },

    /**
     * The same four bodies as the boxes they are made of, so the renderer
     * INSTANCES them instead of merging ~800 short-lived BufferGeometries per
     * dense chunk. This is the half of the demo that had been dropped: its own
     * `batchGroup()` collapses every repeated part of a building into an
     * `InstancedMesh` before the building is even placed, and the port had been
     * copying the shapes out of that group while leaving the batching behind.
     *
     * Null for the eraser — see `paperBodyParts` for why its rubber block cannot
     * be one unit template — and the renderer falls back to `buildBuildingBody`
     * for that one building.
     */
    buildBuildingBoxes: (box, seed, zone) => paperBodyParts(box, seed, zone),

    buildPartTemplate: (shape) => paperPartTemplate(shape),

    /**
     * Where this building's lights are — the demo's own list, all five of them:
     *
     *   residential 橡皮擦   紙套上那圈紅色塑膠膜  eraserFilmMaterial  material
     *   commercial  標籤片台 兩排標籤片            tabLights           quad
     *   industrial  膠帶台   捲軸中心的孔          tapeHubMaterial     material
     *   school      檔案紙箱 鎘黃那一色的提把環    fileHandleLights    quad
     *   hospital    藥盒     分格蓋子隔一格        pillCellLights      quad
     *
     * Three of the five are SURFACES with a material of their own, so they glow
     * through `registerNightLitMaterial` and answer [] here. That is a real
     * answer, not a stub.
     *
     * The other two are parts of the merged/instanced BODY, and a body part
     * cannot glow here: a chunk's bodies are one InstancedMesh per shape over
     * ONE vertex-coloured material (`PartInstanceBatches`), so a bezel bar with
     * its own emissive would be a second material and therefore a second batch.
     * The demo affords `nightLit(ringMats[1], …)` because it builds one building
     * at a time; here it would cost the batching the whole world runs on. So
     * those two are quads — but quads SIZED TO THE BEZEL BAR and TO THE
     * COMPARTMENT, off the same layout functions the body uses, which is the
     * part the retired facade grid could never do (it drew one 3 × 2.6 m crayon
     * card per storey, whatever was actually there).
     */
    buildBuildingLights: (box, seed, zone) => {
      switch (paperBuildingKind(zone, seed)) {
        case 'commercial': return tabLights(box, seed);
        case 'school': return fileHandleLights(box, seed);
        case 'hospital': return pillCellLights(box);
        default: return [];
      }
    },

    /**
     * The two light materials this world has. The demo gives them DIFFERENT
     * glows (`nightLit(ringMats[1], '#b07d1c')` and `pillCellLitMat` at
     * `'#c9a45c'`), so they stay two rather than being flattened into one.
     *
     * Both are unlit quads whose colour IS the glow: a black-based Phong has
     * every lighting term at zero, so what reaches the screen is `emissive`
     * alone. `hideByDay` switches the batch off at noon, when the quad would
     * otherwise be a black rectangle — and saves the draw call and the blend.
     */
    createBuildingLightMaterial: (lit) => {
      const glow = LIT_BODY_GLOW[lit ?? ''];
      if (glow === undefined) throw new Error(`paper style has no light key '${lit}'`);
      return sharedTrim(`light:${lit}`, () => {
        const m = new THREE.MeshPhongMaterial({
          color: 0x000000, specular: 0x000000, shininess: 0,
        });
        registerNightLitMaterial(m, glow, { hideByDay: true });
        return m;
      });
    },

    // Tunnel mouth: a hole cut in the board, with a kraft lip around it. The
    // road stops at the hillside (a tunnel is inside the hill, not on it — see
    // road-renderer); this is what says "it goes through".
    buildTunnelPortal: (width) => {
      const group = new THREE.Group();
      const w = Math.max(5, width * 1.5);
      const h = Math.max(5, w * 0.75);
      const lip = Math.max(0.7, w * 0.1);

      const outer = archOutline(new THREE.Shape(), w + lip * 2, h + lip);
      outer.holes.push(archOutline(new THREE.Path(), w, h));
      const frame = new THREE.Mesh(
        new THREE.ExtrudeGeometry(outer, { depth: 0.9, bevelEnabled: false, curveSegments: 6 }),
        sharedTrim('tunnelLip', () => kraftMaterial(gradient, KRAFT_COLOR)),
      );
      frame.position.z = -0.9;
      group.add(frame);

      // Unlit, near-black: it is a hole. A shaded surface standing in for one
      // washes out exactly when the sun hits the slope it is cut into.
      const mouth = new THREE.Mesh(
        new THREE.ExtrudeGeometry(archOutline(new THREE.Shape(), w, h), {
          depth: 0.1, bevelEnabled: false, curveSegments: 6,
        }),
        sharedTrim('tunnelMouth', () => new THREE.MeshBasicMaterial({ color: 0x0d0a06 })),
      );
      mouth.position.z = -1.1;
      group.add(mouth);
      return group;
    },

    /**
     * Trim: the parts that need their OWN material.
     *
     * Everything else a zone building is made of lives in `buildBuildingBody`
     * with vertex colours, and that split is not cosmetic. Trim is cloned and
     * matrix-transformed per building at chunk build, and the corrugated world's
     * trim is ALREADY the single biggest slice of its scene (54 K triangles,
     * 36 %, and the reason a paper chunk builds 1.7× slower than a plastic one —
     * PERF_AUDIT). Index tabs, dispenser lips, handle bezels, lid compartments and
     * the red marks are all just toon-shaded colour, which the merged body does
     * for free; only glass, hub and steel earn a place here.
     */
    buildBuildingDecoration: (box, seed, zone) => {
      const kind = paperBuildingKind(zone, seed);

      // Commercial: the lit windows of the compartment band, and nothing else.
      // The dark slab BEHIND them is body, not trim — it has no material of its
      // own, and putting it here would pay the clone-and-transform cost for a
      // block that is plain toon colour.
      // demo: `win = box(cw * 0.72, h * 0.28, 0.34, shopGlassMat)` at
      // `(-w * 0.46 + (i + 0.5) * cw, h * 0.2, zf + s * 0.40)`.
      if (kind === 'commercial') {
        const L = tabDispenserLayout(box);
        const group = new THREE.Group();
        // (T, T) — the demo builds the windows with its `box()` helper, and
        // `box()` opens both. They are SOLID dark blocks, not transparent panes
        // (「鏤空會在天際線開洞,一律不挖」), so unlike the circuit world's real
        // glass envelopes there is nothing here that argues against casting.
        trimBatch(group, 'unitBox', shopGlassMaterial(), unitBox, L.n * 2, (mesh) => {
          let k = 0;
          for (const s of [1, -1]) {
            for (let i = 0; i < L.n; i++) {
              boxInstance(mesh, k++, L.winW, L.winH, 0.34,
                L.winX0 + (i + 0.5) * L.cw, L.winY, s * L.winZ);
            }
          }
        }, true, true);
        return placeTrim(box, group);
      }

      // Industrial: steel (bands, cutter bar, teeth) and the glowing hubs.
      //
      // The whole machine is unit shapes at different sizes, and it is the most
      // numerous building in a Taipei chunk (535 of 781 footprints), so all
      // three parts are batched: bands and cutter bars off the shared unit box,
      // the serration off the demo's `unitTooth`, the hubs off its `unitCyl(12)`.
      if (kind === 'industrial') {
        const L = tapeLayout(box);
        const steel = bladeMaterial();
        const group = new THREE.Group();
        const zFace = (s: number): number => s * (L.d / 2 + 0.34);
        const tw = (L.w * 0.96) / L.teeth;

        trimBatch(group, 'unitBox', steel, unitBox, 4, (mesh) => {
          // demo: two steel bands, `box(w + 0.5, 0.5, d + 0.5)` at `hb * f`…
          [0.34, 0.72].forEach((f, i) => boxInstance(mesh, i,
            L.w + 0.5, 0.5, L.d + 0.5, 0, L.hb * f, 0));
          // …and the cutter bar, `box(w * 0.98, 0.55, 0.8)` at `hb + 0.5`.
          [1, -1].forEach((s, i) => boxInstance(mesh, 2 + i,
            L.w * 0.98, 0.55, 0.8, 0, L.hb + 0.5, zFace(s)));
        // Bands and cutter bar are `box()` in the demo → both flags.
        }, true, true);
        // The serration and the hubs are NOT: the demo builds them straight
        // from `unitTooth` / `unitCyl(12)` and sets `castShadow` only. Both are
        // small round/wedge parts standing proud of a face that already
        // receives, so the second flag would buy a shadow lookup and nothing
        // visible. (`batchGroup` ORs the flags when it batches them, and OR
        // over a set that is uniformly (T,F) is still (T,F).)
        partBatch(group, 'tooth', steel, 2 * L.teeth, (mesh) => {
          let n = 0;
          for (const s of [1, -1]) {
            for (let i = 0; i < L.teeth; i++) {
              // 0.62 m thick: a cutter edge seen side-on still has to exist.
              boxInstance(mesh, n++, tw * 0.9, 1.15, 0.62,
                -L.w * 0.48 + (i + 0.5) * tw, L.hb + 0.28, zFace(s));
            }
          }
        }, true, false);
        // demo: `hub` is `unitCyl(12)` scaled `(R * 0.68, 0.7, R * 0.68)` — that
        // is a DIAMETER of `R * 0.68` on a unit-diameter cylinder, not a radius.
        // This file had it as `R * 0.68 * 2`, i.e. a hub twice the demo's, which
        // at `R * 0.68` of the roll is the difference between "an axle" and "the
        // roll is a doughnut".
        partBatch(group, 'hub', tapeHubMaterial(), 2 * L.rolls.length, (mesh) => {
          let n = 0;
          for (const r of L.rolls) {
            const dia = r.r * 0.68;
            for (const s of [1, -1]) {
              boxInstance(mesh, n++, dia, 0.7, dia,
                r.x, L.hb + r.r * 0.72, s * (L.len / 2 + 0.2), Math.PI / 2);
            }
          }
        }, true, false);
        return placeTrim(box, group);
      }

      // School and hospital have no trim: their bodies are corrugated board,
      // coloured bezels, white card and red, all of which the merged/instanced
      // body carries — and their night lights are body PARTS tagged `lit` (the
      // amber bezel colour, every other lid compartment), not separate objects.
      if (kind !== 'residential') return null;

      // Eraser trim: the paper sleeve. It is pushed on from the BOTTOM and covers
      // the lower half, the way a draughtsman's eraser is sleeved — NOT a band
      // round the waist, which belongs to the other kind of eraser.
      const group = new THREE.Group();
      const sleeveMat = sharedTrim('eraserSleeve', () => kraftMaterial(gradient, SLEEVE_COLOR));
      const bandMat = sharedTrim('eraserBand', () => new THREE.MeshToonMaterial({
        color: SLEEVE_INK_COLOR,
        gradientMap: gradient,
      }));

      const w = Math.max(MIN_BODY_SPAN, box.width);
      const d = Math.max(MIN_BODY_SPAN, box.depth);
      const sleeveH = Math.max(MIN_BODY_H, box.height) * ERASER_SLEEVE_FRAC;
      const t = ERASER_SLEEVE_T;

      // Every piece below is a UNIT shape at a different size, which is what
      // makes the whole sleeve batchable.

      // Sleeve body — square-cornered like the rubber, standing one paper
      // thickness proud of it. demo: `box(w + 2 * SLEEVE_T, sleeveH,
      // d + 2 * SLEEVE_T)` at `sleeveH / 2`.
      // (T, T): the demo's `sleeve` is `box(...)`, so both flags.
      trimBatch(group, 'unitBox', sleeveMat, unitBox, 1,
        (mesh) => boxInstance(mesh, 0,
          w + 2 * t, sleeveH, d + 2 * t, 0, box.baseY + sleeveH / 2, 0),
        true, true);

      // The sleeve's top edge is cut to a point on the two wide faces. Without
      // it the building is just two stacked colours; this is the detail that
      // reads as "stationery sleeve". Negate the apex for a V notch instead.
      //
      // The demo's `unitTooth` turned 180° about z, which is exactly how the
      // demo does it — the same tooth the cutter serration and the awning
      // valance use. Its z is `s * (d / 2 + SLEEVE_T / 2)`, SYMMETRIC about the
      // building; this file had the −z one an extra `t` further out.
      const chev = Math.min(2.4, sleeveH * 0.32);
      partBatch(group, 'tooth', sleeveMat, 2, (mesh) => {
        [-1, 1].forEach((side, i) => boxInstance(mesh, i,
          w + 2 * t, chev, t,
          0, box.baseY + sleeveH, side * (d / 2 + t / 2),
          0, 0, Math.PI));
      // (T, F): the demo's chevron is a raw `unitTooth` mesh with
      // `m.castShadow = true` and nothing else — same as the cutter serration
      // and the awning valance, which are the same shape.
      }, true, false);

      // A printed rule across the sleeve.
      // (T, T): the demo's `rule` is `box(...)`.
      trimBatch(group, 'unitBox', bandMat, unitBox, 1,
        (mesh) => boxInstance(mesh, 0,
          w + 2 * (t + 0.05), 0.32, d + 2 * (t + 0.05),
          0, box.baseY + sleeveH * 0.72, 0),
        true, true);

      // The plastic film, banded round the top of the paper sleeve — the
      // chevron teeth rise out of it. Phong, not toon: this is the one plastic
      // surface in a world of paper, and that bit of specular is where it
      // parts company with the sleeve under it.
      const filmH = Math.min(1.0, sleeveH * 0.15);
      // (T, T): the demo's `band` is `box(...)` — its extra
      // `band.castShadow = true` is redundant there, which is exactly why the
      // port had it half-ported (cast on, receive silently lost).
      trimBatch(group, 'unitBox', eraserFilmMaterial(), unitBox, 1,
        (mesh) => {
          boxInstance(mesh, 0,
            w + 2 * (t + 0.07), filmH, d + 2 * (t + 0.07),
            0, box.baseY + sleeveH - filmH / 2, 0);
        },
        true, true);

      // ── The printed frames on the sleeve ──
      //
      // THE ERASER HAS NO WINDOWS. These are printed on the wrapper, which is a
      // printed object; they look the same at noon and at midnight. The
      // residential night light is the film's edge below them, not this.
      //
      // Recorded as blocked in plan/migrate-demo-worlds.md §3.1 ("the decoration
      // merge drops uv, so a decoration cannot carry a texture card"). It no
      // longer does — `mergeBuildingDecorations` passes
      // `keepUV: samplesUV(material)` — and the batched path never dropped uv at
      // all, because it instances the template rather than merging it. So the
      // demo's `crayonWinMat` frames come across unchanged.
      const printH = Math.min(sleeveH * 0.44, 2.8);
      if (printH > 0.9) {
        const cols = Math.max(1, Math.min(3, Math.round(w / 5)));
        const pw = Math.min(2.9, (w / cols) * 0.64);
        trimBatch(group, 'unitPlane', crayonWindowMaterial(), unitPlane, 2 * cols, (mesh) => {
          let n = 0;
          for (const side of [-1, 1]) {
            for (let cx = 0; cx < cols; cx++) {
              boxInstance(mesh, n++, pw, printH, 1,
                -w / 2 + (cx + 0.5) * (w / cols),
                box.baseY + sleeveH * 0.4,
                (d / 2 + t + 0.08) * side,
                0, side < 0 ? Math.PI : 0);
            }
          }
        });
      }

      group.position.set(box.cx, 0, box.cz);
      group.rotation.y = box.rotY;
      return group;
    },

    // `facadeWindows` USED TO BE HERE — a 6 × 6 m grid of 3 × 2.6 m crayon cards
    // stamped on the two long faces of anything with no themed body. Deleted
    // with the mechanism. `crayonWindowMaterial()` survives and is still the
    // demo's `crayonWinMat`, but only for what the demo uses it for: the frames
    // PRINTED on the eraser's paper wrapper, which look the same at noon and at
    // midnight («橡皮擦仍然沒有窗戶…會亮的只有這一圈膜»).

    // ── Geometry hooks ──
    quantizeElevation: (absEle) => quantizeToLayer(absEle, params),

    // Cut-card trees: two crossed cards carrying the cut-out silhouette.
    buildTreeGeometry: () => buildCutCardTreeGeometry(),

    /**
     * demo 的第三個 mesh:`put(unitDisc, glueMat, glue)`。
     *
     * Fresh geometry + fresh material per call (`disposeTreeMesh` 收),貼圖走
     * `propTexture` 的 singleton —— 材質 dispose 不會碰它的 map,而一條路線上每個
     * chunk 重畫一張 64×64 是白付的 canvas 成本。
     */
    treeGroundMark: () => ({
      geometry: buildTreeGlueGeometry(),
      material: new THREE.MeshBasicMaterial({
        map: propTexture('treeGlue', createTreeGlueTexture),
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    }),

    /**
     * demo 的 `treeBucket.flush`:卡片那批 `im.castShadow = true`(在
     * `if (depthMat)` 裡),`receiveShadow` 整支函式一次都沒出現。
     *
     * 這一格在這個 hook 存在之前是 `CR` —— 一條記錄在案的偏離,因為
     * `tree-renderer` 一個 chunk 一個 InstancedMesh 而旗標是逐 draw 的,沒有
     * 逐世界的通道。現在有了。
     */
    treeShadow: { cast: true, receive: false },

    // Ink outline via inverted hull — works for Mesh and InstancedMesh.
    createOutline: (source) => {
      if (!params.inkEnabled || params.inkThickness <= 0) return null;
      const mat = makeInkMaterial(params.inkColor, params.inkThickness);
      const inst = source as THREE.InstancedMesh;
      if (inst.isInstancedMesh) {
        const outline = new THREE.InstancedMesh(inst.geometry, mat, inst.count);
        (outline.instanceMatrix.array as Float32Array).set(inst.instanceMatrix.array as Float32Array);
        outline.instanceMatrix.needsUpdate = true;
        outline.frustumCulled = false;
        return outline;
      }
      return new THREE.Mesh(source.geometry, mat);
    },

    // ── Post (converged: geometry/materials carry most of the paper feel) ──
    createPostPass: (width, height) => {
      const pass = createPaperPass(width, height);
      strategy.applyPostParams(pass);
      return pass;
    },
    applyPostParams: (pass: ShaderPass) => {
      pass.uniforms['uPosterize'].value = params.paperPosterize;
      pass.uniforms['uDesaturate'].value = params.paperDesaturate;
      pass.uniforms['uFiberStrength'].value = params.paperFiber;
      pass.uniforms['uStrength'].value = params.paperStrength;
    },

    // ⚠ 這裡以前的第一行是 `base.dispose()` —— 收的是那個順手實例化出來的積木
    // strategy。它不只多餘,還會踩到別人:積木的 `PART_TEMPLATES` 是**模組層**
    // 的共用幾何快取,而 `dispose()` 會把它整個 dispose + clear。所以「切到瓦楞
    // 紙再切回去」曾經可以把一份還有人在用的共用幾何收掉(§6:共用的 geometry
    // 絕對不可以在別人手上被 dispose)。依賴一斷,這個坑跟著沒了。
    dispose: () => {
      buildingMaterial?.dispose();
      buildingMaterial = null;
      corrTex?.tex.dispose();
      corrTex = null;
      crayonTex?.dispose();
      crayonTex = null;
      dentTex?.dispose();
      dentTex = null;
      // 第 0 階的墊子:標了 `userData.shared`,所以 chunk 回收器一份都不會收 ——
      // strategy 是唯一收得掉它的人(它的 map 走 `propTextures`,在下面收)。
      cuttingMatFloorMat?.dispose();
      cuttingMatFloorMat = null;
      // Cloud singletons: the deck only ever disposed instance buffers (they
      // are marked userData.shared) — the strategy is the sole owner.
      cottonTex?.dispose();
      cottonTex = null;
      cottonMat?.dispose();
      cottonMat = null;
      cottonGeo?.dispose();
      cottonGeo = null;
      for (const tex of propTextures.values()) tex.dispose();
      propTextures.clear();
      for (const mat of trimMaterials.values()) {
        // Seam-glow materials are written every frame by the global night
        // driver; leaving one registered after a style swap keeps the old
        // world's material alive and being touched forever.
        unregisterNightLitMaterial(mat as THREE.MeshPhongMaterial);
        mat.dispose();
      }
      trimMaterials.clear();
      // Instance templates outlive every chunk on purpose (the chunks draw
      // clones), so the strategy is the only thing that can free them.
      for (const geo of trimTemplates.values()) geo.dispose();
      trimTemplates.clear();
      for (const geo of PART_TEMPLATES.values()) geo.dispose();
      PART_TEMPLATES.clear();
      for (const mat of signMats.values()) mat.dispose();
      signMats.clear();
      // 地被道具的共用幾何/材質:標了 `userData.shared`,所以 chunk 回收器一份
      // 都不會收 —— strategy 是唯一收得掉它們的人。
      for (const geo of luGeos.values()) geo.dispose();
      luGeos.clear();
      for (const mat of luMats.values()) mat.dispose();
      luMats.clear();
      gradient.dispose();
    },
  };

  return strategy;
}

/**
 * Cut-card tree: two perpendicular cards, each carrying the scissors-cut tree
 * silhouette in the material's alpha (the classic cutout trick). The card is
 * 8 m square with its base at y = 0, so the renderer's 0.7–1.4 instance scale
 * lands trees in a believable 5–11 m range.
 *
 * The two quads are merged into ONE geometry so a chunk is still a single
 * InstancedMesh draw call.
 *
 * ⚠ THE TWO CARDS ARE NOT THE SAME CUT. That is the demo's own rule and it
 * wrote the reason down: 「兩張用**不同**的剪法(不同 seed 的貼圖),不然轉到
 * 45° 會看出是同一張鏡射過去的。」 The demo buys it with a second MATERIAL,
 * which this renderer cannot have (one InstancedMesh per chunk), so it is
 * bought with uv instead: `createTreeCutoutTexture` lays the demo's two seeds
 * side by side and card `v` gets the half `[v / 2, (v + 1) / 2]`.
 */
function buildCutCardTreeGeometry(): THREE.BufferGeometry {
  const SIZE = TREE_CARD_SIZE;
  const cards: THREE.BufferGeometry[] = [];
  for (const rotY of [0, Math.PI / 2]) {
    const card = new THREE.PlaneGeometry(SIZE, SIZE);
    card.rotateY(rotY);
    card.translate(0, SIZE / 2, 0);
    cards.push(card.toNonIndexed());
    card.dispose();
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  cards.forEach((card, v) => {
    const pos = card.attributes.position.array as ArrayLike<number>;
    const nrm = card.attributes.normal.array as ArrayLike<number>;
    const uv = card.attributes.uv.array as ArrayLike<number>;
    for (let i = 0; i < card.attributes.position.count * 3; i++) {
      positions.push(pos[i]);
      normals.push(nrm[i]);
    }
    // u into this card's own tile of the atlas; v untouched (the tiles are
    // stacked left-to-right, so only the horizontal axis is shared).
    for (let i = 0; i < card.attributes.uv.count * 2; i++) {
      uvs.push(i % 2 === 0
        ? (uv[i] + v) / TREE_CARD_VARIANTS
        : uv[i]);
    }
    card.dispose();
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}
