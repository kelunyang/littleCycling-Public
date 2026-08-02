/**
 * Signs that carry text — the single source of truth for BOTH renderers.
 *
 * DEVPLAN「招牌、壓克力罩、bloom、電流脈衝(demo 規格)」fixes the mechanism for all
 * six demos and leaves only the CARRIER to each world (corrugated → embossed
 * label tape, blocks → the printed sticker that comes with the toy set,
 * circuit → an e-paper module). This module is that mechanism, promoted out of
 * the demos so the real game cannot drift from them: proportions, layout, glyph
 * shapes, and what each zone's sign says.
 *
 * Deliberately free of any THREE / Phaser import — same reason as
 * `road-classes.ts`. The 2D renderer has to be able to draw the same signs
 * without dragging a 3D engine in behind it.
 *
 * WHY GEOMETRIC STROKES AND NOT A SYSTEM FONT
 * ------------------------------------------
 * Two reasons, both learned the hard way:
 *  1. At riding distance a sign is ~40 px wide. Antialiased type turns to mush;
 *     four fat strokes stay readable.
 *  2. `ctx.font = '... sans-serif'` resolves differently on Windows, in WSL, and
 *     in the headless probe. A sign that fits on one machine overflows on the
 *     next, and no probe can catch it.
 *
 * The finish-airship banner (`FinishAirshipParts.setBannerText`) is the one
 * place in the game that still uses `ctx.font`; it should move onto this.
 */

import type { ZoneKind } from './land-zone';

/** Re-exported so a caller only needs one import to build a sign. */
export type { ZoneKind };

/** Sign aspect ratio (width : height). Fixed across all worlds — the carrier
 *  differs but the proportion must not, or they stop reading as "the same kind
 *  of thing" at distance. */
export const SIGN_RATIO = 3;

/** Hard cap on characters. Five characters at sign scale are already unreadable. */
export const SIGN_MAX_CHARS = 4;

/** Downward tilt. The chase camera's eye sits 6.3 m up (`fps-camera.ts`
 *  CHASE_UP), so a sign hung flat against the facade is edge-on to the rider. */
export const SIGN_TILT_RAD = (8 * Math.PI) / 180;

/** Which zones get a sign at all. Residential and industrial do not. */
export const SIGN_ZONES: ReadonlySet<ZoneKind> = new Set<ZoneKind>([
  'commercial', 'school', 'hospital',
]);

/**
 * One stroke of a glyph: a line segment plus its width, in the unit box
 * `x, y ∈ [0, 1]` with **y = 0 at the TOP** (the order the tables are authored
 * in — `T`'s bar is at y ≈ 0.04).
 */
export type GlyphSegment = readonly [x0: number, y0: number, x1: number, y1: number];

/**
 * The geometric alphabet. A–Z plus 0–9, each a list of segments in the unit box.
 *
 * Authored so the confusable pairs stay apart AT SIGN SIZE, which is a stronger
 * requirement than looking right at 200 px:
 *   0 / O  — the zero is narrower AND slashed.
 *   1 / I  — `I` is symmetric (top bar + stem + bottom bar); `1` has the angled
 *            flag at top-left and no top bar.
 *   2 / Z  — `Z` is three straight strokes; `2` has a curved shoulder.
 *   5 / S  — `5` has a straight top bar and a straight left stem; `S` is a pure
 *            zigzag with neither.
 *   8 / B  — `B` is a left stem with two clipped bowls; `8` is two symmetric
 *            loops with no stem. Their outlines differ, not just their insides.
 * Getting this wrong is invisible on a design mock and obvious on a sign.
 */
export const SIGN_GLYPHS: Readonly<Record<string, readonly GlyphSegment[]>> = {
  A: [[0.06, 1, 0.50, 0], [0.50, 0, 0.94, 1], [0.22, 0.62, 0.78, 0.62]],
  B: [[0.18, 0, 0.18, 1], [0.18, 0, 0.66, 0], [0.66, 0, 0.80, 0.22], [0.80, 0.22, 0.64, 0.46],
    [0.18, 0.46, 0.64, 0.46], [0.64, 0.46, 0.82, 0.72], [0.82, 0.72, 0.66, 1], [0.18, 1, 0.66, 1]],
  C: [[0.90, 0.10, 0.32, 0.10], [0.32, 0.10, 0.16, 0.38], [0.16, 0.38, 0.16, 0.62],
    [0.16, 0.62, 0.32, 0.90], [0.32, 0.90, 0.90, 0.90]],
  D: [[0.18, 0, 0.18, 1], [0.18, 0, 0.60, 0], [0.60, 0, 0.84, 0.30], [0.84, 0.30, 0.84, 0.70],
    [0.84, 0.70, 0.60, 1], [0.60, 1, 0.18, 1]],
  E: [[0.20, 0, 0.20, 1], [0.20, 0, 0.88, 0], [0.20, 0.5, 0.76, 0.5], [0.20, 1, 0.88, 1]],
  F: [[0.20, 0, 0.20, 1], [0.20, 0, 0.88, 0], [0.20, 0.5, 0.74, 0.5]],
  // G = C with the bar turned in. The inward bar must stop short of centre or it
  // reads as a squared-off 6.
  G: [[0.90, 0.10, 0.32, 0.10], [0.32, 0.10, 0.16, 0.38], [0.16, 0.38, 0.16, 0.62],
    [0.16, 0.62, 0.32, 0.90], [0.32, 0.90, 0.86, 0.90], [0.86, 0.90, 0.86, 0.54],
    [0.58, 0.54, 0.86, 0.54]],
  H: [[0.16, 0, 0.16, 1], [0.84, 0, 0.84, 1], [0.16, 0.5, 0.84, 0.5]],
  I: [[0.20, 0, 0.80, 0], [0.50, 0, 0.50, 1], [0.20, 1, 0.80, 1]],
  J: [[0.40, 0.04, 0.86, 0.04], [0.66, 0.04, 0.66, 0.72], [0.66, 0.72, 0.50, 0.94],
    [0.50, 0.94, 0.28, 0.94], [0.28, 0.94, 0.14, 0.74]],
  K: [[0.18, 0, 0.18, 1], [0.86, 0, 0.22, 0.54], [0.38, 0.42, 0.88, 1]],
  L: [[0.22, 0, 0.22, 1], [0.22, 1, 0.88, 1]],
  M: [[0.10, 1, 0.10, 0], [0.10, 0, 0.50, 0.60], [0.50, 0.60, 0.90, 0], [0.90, 0, 0.90, 1]],
  N: [[0.16, 1, 0.16, 0], [0.16, 0, 0.84, 1], [0.84, 1, 0.84, 0]],
  O: [[0.32, 0.06, 0.68, 0.06], [0.68, 0.06, 0.86, 0.32], [0.86, 0.32, 0.86, 0.68],
    [0.86, 0.68, 0.68, 0.94], [0.68, 0.94, 0.32, 0.94], [0.32, 0.94, 0.14, 0.68],
    [0.14, 0.68, 0.14, 0.32], [0.14, 0.32, 0.32, 0.06]],
  P: [[0.18, 0, 0.18, 1], [0.18, 0, 0.68, 0], [0.68, 0, 0.84, 0.26], [0.84, 0.26, 0.68, 0.52],
    [0.68, 0.52, 0.18, 0.52]],
  // Q's tail has to break OUT of the ring. Tucked inside it just looks like a
  // dirty O — a mistake already made once in the toy-world letter table.
  Q: [[0.32, 0.06, 0.68, 0.06], [0.68, 0.06, 0.86, 0.32], [0.86, 0.32, 0.86, 0.68],
    [0.86, 0.68, 0.68, 0.94], [0.68, 0.94, 0.32, 0.94], [0.32, 0.94, 0.14, 0.68],
    [0.14, 0.68, 0.14, 0.32], [0.14, 0.32, 0.32, 0.06], [0.62, 0.68, 0.94, 1]],
  R: [[0.18, 0, 0.18, 1], [0.18, 0, 0.68, 0], [0.68, 0, 0.84, 0.26], [0.84, 0.26, 0.68, 0.52],
    [0.68, 0.52, 0.18, 0.52], [0.46, 0.52, 0.86, 1]],
  S: [[0.88, 0.14, 0.36, 0.04], [0.36, 0.04, 0.16, 0.26], [0.16, 0.26, 0.50, 0.46],
    [0.50, 0.46, 0.84, 0.66], [0.84, 0.66, 0.64, 0.94], [0.64, 0.94, 0.12, 0.84]],
  T: [[0.06, 0.04, 0.94, 0.04], [0.50, 0.04, 0.50, 1]],
  U: [[0.16, 0, 0.16, 0.70], [0.16, 0.70, 0.34, 0.96], [0.34, 0.96, 0.66, 0.96],
    [0.66, 0.96, 0.84, 0.70], [0.84, 0.70, 0.84, 0]],
  V: [[0.10, 0, 0.50, 1], [0.50, 1, 0.90, 0]],
  W: [[0.06, 0, 0.26, 1], [0.26, 1, 0.50, 0.42], [0.50, 0.42, 0.74, 1], [0.74, 1, 0.94, 0]],
  X: [[0.12, 0, 0.88, 1], [0.88, 0, 0.12, 1]],
  Y: [[0.10, 0, 0.50, 0.52], [0.90, 0, 0.50, 0.52], [0.50, 0.52, 0.50, 1]],
  Z: [[0.14, 0.04, 0.86, 0.04], [0.86, 0.04, 0.14, 0.96], [0.14, 0.96, 0.86, 0.96]],

  0: [[0.36, 0.06, 0.64, 0.06], [0.64, 0.06, 0.80, 0.30], [0.80, 0.30, 0.80, 0.70],
    [0.80, 0.70, 0.64, 0.94], [0.64, 0.94, 0.36, 0.94], [0.36, 0.94, 0.20, 0.70],
    [0.20, 0.70, 0.20, 0.30], [0.20, 0.30, 0.36, 0.06], [0.30, 0.80, 0.70, 0.20]],
  1: [[0.28, 0.22, 0.52, 0.04], [0.52, 0.04, 0.52, 1], [0.24, 1, 0.80, 1]],
  2: [[0.16, 0.26, 0.34, 0.06], [0.34, 0.06, 0.66, 0.06], [0.66, 0.06, 0.84, 0.28],
    [0.84, 0.28, 0.16, 0.96], [0.16, 0.96, 0.88, 0.96]],
  3: [[0.16, 0.10, 0.66, 0.06], [0.66, 0.06, 0.82, 0.28], [0.82, 0.28, 0.52, 0.48],
    [0.52, 0.48, 0.84, 0.68], [0.84, 0.68, 0.66, 0.94], [0.66, 0.94, 0.16, 0.90]],
  4: [[0.66, 0.04, 0.16, 0.68], [0.16, 0.68, 0.90, 0.68], [0.66, 0.04, 0.66, 1]],
  5: [[0.84, 0.06, 0.24, 0.06], [0.24, 0.06, 0.22, 0.44], [0.22, 0.44, 0.66, 0.40],
    [0.66, 0.40, 0.84, 0.66], [0.84, 0.66, 0.66, 0.94], [0.66, 0.94, 0.16, 0.88]],
  6: [[0.78, 0.08, 0.40, 0.10], [0.40, 0.10, 0.20, 0.44], [0.20, 0.44, 0.20, 0.74],
    [0.20, 0.74, 0.38, 0.94], [0.38, 0.94, 0.66, 0.94], [0.66, 0.94, 0.82, 0.72],
    [0.82, 0.72, 0.62, 0.52], [0.62, 0.52, 0.24, 0.56]],
  7: [[0.12, 0.06, 0.88, 0.06], [0.88, 0.06, 0.44, 1], [0.30, 0.52, 0.70, 0.52]],
  8: [[0.34, 0.06, 0.66, 0.06], [0.66, 0.06, 0.82, 0.26], [0.82, 0.26, 0.62, 0.46],
    [0.62, 0.46, 0.38, 0.46], [0.38, 0.46, 0.18, 0.26], [0.18, 0.26, 0.34, 0.06],
    [0.38, 0.46, 0.20, 0.70], [0.20, 0.70, 0.36, 0.94], [0.36, 0.94, 0.64, 0.94],
    [0.64, 0.94, 0.80, 0.70], [0.80, 0.70, 0.62, 0.46]],
  9: [[0.22, 0.92, 0.60, 0.90], [0.60, 0.90, 0.80, 0.56], [0.80, 0.56, 0.80, 0.26],
    [0.80, 0.26, 0.62, 0.06], [0.62, 0.06, 0.34, 0.06], [0.34, 0.06, 0.18, 0.28],
    [0.18, 0.28, 0.38, 0.48], [0.38, 0.48, 0.76, 0.44]],
};

/**
 * Every character the alphabet can draw. Anything outside this is dropped by
 * `signStrokes` — and `sanitizeSignText` exists so callers can find that out
 * BEFORE it silently costs them a letter.
 */
export const SIGN_ALPHABET = Object.keys(SIGN_GLYPHS).join('');

/**
 * A laid-out stroke, in PLATE-LOCAL coordinates: origin at the plate's centre,
 * +x right, **+y up** (Three's convention). A 2D renderer negates y.
 */
export interface SignStroke {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Stroke width, in the same units as the coordinates. */
  width: number;
}

/**
 * Uppercase, strip anything the alphabet cannot draw, cap the length.
 * Returns `''` when nothing survives — callers should treat that as "no sign"
 * rather than hanging a blank plate.
 */
export function sanitizeSignText(text: string): string {
  let out = '';
  for (const ch of text.toUpperCase()) {
    if (SIGN_GLYPHS[ch]) out += ch;
    if (out.length >= SIGN_MAX_CHARS) break;
  }
  return out;
}

/**
 * Lay `text` out inside a `w × h` plate.
 *
 * Spec (identical in all six demos): cap height ≥ 0.55 of the plate height
 * (we use 0.62), stroke width ≥ 1/8 of cap height (we use 0.17), and the whole
 * block shrinks to fit 0.84 of the plate width rather than overflowing.
 */
export function signStrokes(w: number, h: number, text: string): SignStroke[] {
  const s = sanitizeSignText(text);
  if (!s) return [];
  const capH = h * 0.62;
  let capW = capH * 0.72;
  let advance = capW * 1.26;
  const natural = s.length * advance - (advance - capW);
  const avail = w * 0.84;
  if (natural > avail) {
    const k = avail / natural;
    capW *= k;
    advance *= k;
  }
  const total = s.length * advance - (advance - capW);
  const width = Math.max(capH / 8, capH * 0.17);
  const left = -total / 2;
  const top = capH / 2;                       // +y up: the top of the cap box
  const out: SignStroke[] = [];
  for (let i = 0; i < s.length; i++) {
    const segs = SIGN_GLYPHS[s[i]];
    if (!segs) continue;
    const gx = left + i * advance;
    for (const q of segs) {
      out.push({
        x0: gx + q[0] * capW,
        y0: top - q[1] * capH,                // table is y-down; flip here, once
        x1: gx + q[2] * capW,
        y1: top - q[3] * capH,
        width,
      });
    }
  }
  return out;
}

/** Where a shop sign hangs on a building, and how big it is. */
export interface SignPlacement {
  /** Plate size in metres. */
  width: number;
  height: number;
  /** Height above the building's base, in metres. */
  centerY: number;
}

/**
 * Size and hang a sign on a building of `bodyWidth × bodyHeight` metres.
 *
 * The width cap matters: without it a wide warehouse gets a sign the size of a
 * wall. `maxWidth` is the world's own ceiling (the demos use ~8.5 m for the toy
 * world, whose letter bricks are 24 m wide).
 *
 * Returns null when the building is too small to carry a legible sign — a
 * 2 m plate is four smudges, and hanging it anyway is worse than nothing.
 */
export function signPlacement(
  bodyWidth: number,
  bodyHeight: number,
  seed: number,
  maxWidth: number,
  lo = 0.55,
  hi = 0.70,
): SignPlacement | null {
  const width = Math.min(bodyWidth * 0.8, maxWidth, bodyHeight * 1.15);
  if (width < 2.5) return null;
  const a = Math.max(0.55, lo);
  const b = Math.min(0.70, hi);
  const t = a + hashUnit(seed * 3.77 + 0.9) * Math.max(0, b - a);
  return { width, height: width / SIGN_RATIO, centerY: bodyHeight * t };
}

/**
 * What a sign SAYS, per world.
 *
 * ── Why this is per world and not one shared list ──
 *
 * §3.8 of `CUSTOM_WORLD_INSTRUCTIONS.md`「材質要從這個世界自己的貨架上拿」
 * is usually read as being about shapes. It applies just as hard to WORDS: a
 * word list is vocabulary, and vocabulary from the wrong shelf reads as wrong
 * however well the sign is drawn.
 *
 * There used to be ONE list here — plastic's twelve plus four additions — used
 * by all three worlds. The circuit world's demo has had its own fourteen
 * electronics words all along, so a printed-circuit district was signposting
 * its buildings 「BAKE」 and 「CAFE」.
 *
 * ── Two registers, and both are right ──
 *
 * The demos did not pick the same KIND of word, and that is not an
 * inconsistency to flatten:
 *
 *  · **plastic** is a toy TOWN, so its signs are the town's shopfronts —
 *    a deli, a hall, a zoo. Its twelve are `plan/plastic-town-demo.html`'s
 *    `SHOP_WORDS`, verbatim.
 *  · **circuit** is a board. A board has no shops; its e-paper modules LABEL
 *    the components they sit on. Its fourteen are
 *    `plan/circuit-town-demo.html`'s `SIGN_WORDS`, verbatim.
 *  · **cuphead** has no shop-word list in its demo at all (only the school's
 *    `ABC` and the hospital's triangle), so it was borrowing plastic's — a
 *    cardboard model town signposted 「BOAT」. Its list is written here from
 *    its own shelf: the stationery and model-making bench its buildings are
 *    made of.
 *
 * ── Which entries are the demo's ──
 *
 * Marked below, because it matters to the next person diffing this against a
 * demo: everything above the `— 以下為擴充` line is a verbatim transcription and
 * must not drift; everything below it was added deliberately, with the
 * developer's approval, purely so the random draw has more to draw from. An
 * addition must stay in its world's own register.
 *
 * Constraints every entry must satisfy: at most `SIGN_MAX_CHARS` (4) glyphs,
 * every glyph in `SIGN_ALPHABET`, and generic nouns only — no brand, no
 * trademark, no real chain.
 */
const SIGN_WORDS = {
  // 玩具鎮的店面。前 12 個是 plastic-town-demo.html 的 SHOP_WORDS,逐字。
  plastic: [
    'DELI', 'TEA', 'ICE', 'TILE', 'CLUB', 'HALL', 'ZOO', 'OAT',
    'BEAD', 'BOAT', 'DUO', 'DECO',
    // — 以下為擴充 —
    'MART', 'CAFE', 'TOYS', 'BAKE', 'BANK', 'POST', 'PARK', 'GYM',
    'PET', 'FARM', 'DOCK', 'MALL',
  ],
  // 文具與模型工作檯。demo 沒有給,整份是照它自己的貨架寫的
  // ——橡皮擦、索引標籤片台、膠帶台、藥盒、檔案紙箱都是從這張桌子上拿的。
  cuphead: [
    // 「MEMO」 not 「PAD」: a solder PAD is one of the circuit demo's own
    // fourteen, and a word on two worlds' shelves is a word that no longer says
    // which world you are in. The demo's entry wins; this one moved.
    'GLUE', 'CLIP', 'TAPE', 'INK', 'CARD', 'PENS', 'NOTE', 'MEMO',
    'RULE', 'NIB', 'CORK', 'BOND', 'LEAD', 'GRID', 'FOAM', 'WAX',
  ],
  // 板子上的元件標籤。前 14 個是 circuit-town-demo.html 的 SIGN_WORDS,逐字。
  circuit: [
    'OHM', 'AMP', 'VOLT', 'FUSE', 'COIL', 'NODE', 'GATE', 'BUS',
    'PAD', 'VIA', 'HEX', 'BIT', 'LED', 'CAP',
    // — 以下為擴充 —
    'CHIP', 'WIRE', 'PORT', 'RAIL', 'GND', 'VCC', 'CLK', 'ROM',
    'RAM', 'ADC',
  ],
} as const satisfies Record<SignWorld, readonly string[]>;

/**
 * What a shop sign says when the ride is a TRAINING ride.
 *
 * ── 為什麼這個也是逐世界一組 ──
 *
 * 跟 `SIGN_WORDS` 同一條理由,而且更硬。上面那段講的是「詞彙是貨架的一部分」;
 * 它還有一個更尖的推論,`MEMO` 就是為它搬過家的:**一個詞同時出現在兩個世界的
 * 貨架上,它就不再說明你在哪個世界。** 一組三個世界共用的激勵詞會把那次搬遷做過
 * 的功一次還回去 —— 招牌照樣畫得漂亮,但它不再是這個世界的招牌。
 *
 * 所以三組互不重疊,而且也不撞任何一個世界的 `SIGN_WORDS`;`[sign spec]` 兩件都
 * 斷言,而且是打在 `signContent()` 的回傳值上,不是打在這張表上。
 *
 * 語域各自跟著自己的世界走:
 *  · **plastic** 是玩具鎮 —— 遊戲場邊喊的話。
 *  · **cuphead** 是 1930 年代的橡皮管動畫 —— 那個年代的加油話。
 *  · **circuit** 是一塊板子 —— 它只會用電氣量詞說「再出力一點」。
 *
 * ── 這裡刻意**沒有**接的東西 ──
 *
 * 詞不隨訓練強度或階段名稱變。那條線只走到 `checkpoint-flag.ts` 的里程碑旗子
 * (`segmentSignLabel`),而店面招牌手上只有 `zone / seed / routeDist` —— 要接強度
 * 得為它另外拉一條線。招牌換的是**語域**,里程碑旗子才是**儀表**,兩者不該重複。
 *
 * ── 限制(與 `SIGN_WORDS` 相同,`[sign spec]` 逐條驗) ──
 *
 * 最多 `SIGN_MAX_CHARS` 個字,而且每個字都要在 `SIGN_GLYPHS` 裡真的畫得出來。
 * 字模表**沒有 `!`** —— 所以是 `GO`,不是 `GO!`。
 *
 * ── 為什麼一本是 16 個而不是 6 個 ──
 *
 * 詞是逐個抽的,所以**相鄰兩面招牌撞字的機率就是 1/k**,跟種子好不好無關 —— 一趟
 * 25 km 訓練騎乘約 660 面招牌(每 2 km 的 chunk 約 51 面),六個詞的實測相鄰重複率
 * 16.7%、最長連續同字平均 4.6 面,而店名那邊(24 個)是 4.2% / 2.8。也就是說六個詞
 * 的街上每六面就有一面跟前一面喊一樣的話,而那不是 bug,是 k 太小。
 *
 * 這件事**不是**種子問題:`9229b07` 已經把招牌的種子從 `fpIdx`(每個 chunk 歸零)
 * 換成 `geoSeed(centroid)`,所以整趟不再每 2 km 原樣重播;剩下的純粹是 1/k。擴到
 * 16 之後實測 6.5% / 3.1,跟 cuphead 那本 16 個店名一模一樣 —— 因為 k 一樣。
 *
 * 推論:**下一個人想再壓低重複率,唯一的辦法是加詞**(k=24 → 4.2%),不要去改
 * `hashUnit` 或種子,那兩個已經在均勻抽樣的理論值上,沒有東西可以修。
 *
 * 這張表是開發者逐字定的。要增刪回去問,不要自己補字。
 */
export const SIGN_TRAINING_WORDS = {
  // 玩具鎮:遊戲場上喊的話。
  plastic: [
    'GO', 'PLAY', 'JUMP', 'ZOOM', 'WIN', 'MORE',
    // — 以下為擴充 —
    'BOLD', 'DASH', 'FAST', 'FUN', 'HERO', 'LEAP', 'NICE', 'PUSH', 'RUSH', 'SPIN',
  ],
  // 1930s 橡皮管動畫:那個年代的加油話。擴充的十個刻意挑那個年代的說法
  // ——`VIM`(精力)、`ACES`(頂尖)、`KEEN`(帶勁)、`JAKE`(妥當),配它的橡膠管調性。
  cuphead: [
    'PEP', 'GRIT', 'ZIP', 'HOLD', 'RISE', 'KEEP',
    // — 以下為擴充 —
    'VIM', 'ACES', 'KEEN', 'JAKE', 'CHIN', 'GAME', 'HUFF', 'TOIL', 'SOAR', 'EDGE',
  ],
  // 板子:用電氣量詞說「再出力一點」。
  circuit: [
    'PWR', 'MAX', 'PEAK', 'GAIN', 'LIVE', 'HIGH',
    // — 以下為擴充 —
    'FLUX', 'WATT', 'PUMP', 'RAMP', 'ZAP', 'FULL', 'FIRE', 'RUN', 'TRUE', 'HOT',
  ],
} as const satisfies Record<SignWorld, readonly string[]>;

/**
 * Which shelf a shop sign draws its word from.
 *
 * `'training'` is decided by ONE fact and nothing finer: **this ride has
 * prescribed segments**. Not the current segment's intensity, not its name —
 * neither of those reaches a shop sign (they stop at `checkpoint-flag.ts`), and
 * a sign that changed as you rode would be a second, worse copy of the flag.
 *
 * A ride's answer is fixed before the first chunk builds, which is what makes
 * this a build-time argument rather than a live one: a chunk already on screen
 * is not rebuilt, so a value that changed mid-ride would only reach the chunks
 * ahead and the street would say two different things at once.
 */
export type SignVocabulary = 'shop' | 'training';

/**
 * Which world's shelf a sign draws from. Mirrors `WorldStyle`, spelled out here
 * so this module stays free of a `@littlecycling/shared` import — it is loaded
 * by the Phaser worker path as well as the Three.js one.
 */
export type SignWorld = 'plastic' | 'cuphead' | 'circuit';

/**
 * `TerrainStyle` spells the corrugated world `paper`; `WorldStyle` spells it
 * `cuphead`. Two vocabularies for one world, both older than this module.
 *
 * One mapping, here, so no call site ever spells it as
 * `style === 'paper' ? … : …` — `CUSTOM_WORLD_INSTRUCTIONS.md` §10.2 names that
 * binary-branch shape as the biggest trap a third world walks into, and this
 * would have been one more of them.
 */
export function signWorldOf(style: SignWorld | 'paper'): SignWorld {
  return style === 'paper' ? 'cuphead' : style;
}

/** What one zone's sign carries. `symbol` wins over `text` when both are set. */
export interface SignContent {
  text: string;
  /** Hospitals show a red triangle instead of letters — see below. */
  symbol: 'triangle' | null;
}

/**
 * What this building's sign says.
 *
 * The hospital marker is a red TRIANGLE, not a red cross: the white-ground red
 * cross is protected by the Geneva Conventions and by national law in most
 * jurisdictions. A triangle reads just as clearly and carries no such problem.
 */
export function signContent(
  zone: ZoneKind,
  seed: number,
  // REQUIRED, deliberately. A default would let a new world silently inherit
  // another's vocabulary, which is exactly the bug this parameter fixes — the
  // circuit board spent its whole existence signposting 「BAKE」 because there
  // was nothing to make the omission visible. Making it required means the
  // compiler names every call site the day a fourth world lands.
  world: SignWorld,
  // REQUIRED for the same reason `world` is, and it buys the same thing: the
  // compiler names every call site the day a third vocabulary lands. It is why
  // the three Phaser call sites read a literal `'shop'` — the 2D renderer has
  // no wire for this yet, and that is now written down in code rather than
  // hidden behind a default nobody would ever look at.
  vocabulary: SignVocabulary,
): SignContent | null {
  if (!SIGN_ZONES.has(zone)) return null;
  // The school's ABC and the hospital's triangle are the same in every demo —
  // a taught alphabet and a medical mark are not world vocabulary, they are
  // what those two buildings ARE. Training changes neither: a hospital does not
  // cheer you on, and a school that said 「GO」 would have stopped being a school.
  if (zone === 'hospital') return { text: '', symbol: 'triangle' };
  if (zone === 'school') return { text: 'ABC', symbol: null };
  const words: readonly string[] = vocabulary === 'training'
    ? SIGN_TRAINING_WORDS[world]
    : SIGN_WORDS[world];
  const i = Math.floor(hashUnit(seed * 7.31 + 1.7) * words.length) % words.length;
  return { text: words[i], symbol: null };
}

/**
 * Deterministic 0..1 from a number. A plain hash, not a PRNG stream — a sign
 * must not consume from any shared RNG, or adding signs re-rolls every prop
 * generated after them. (That exact bug cost a whole re-check of the circuit
 * demo's building layout.)
 */
function hashUnit(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * A ≤4-character label for a workout segment, for the checkpoint flag that
 * marks its start.
 *
 * Multi-word names become initials ("Warm Up" → `WU`, "Cool Down" → `CD`,
 * "Interval 1" → `I1`); single words are cut to three ("Recovery" → `REC`).
 * Three, not four, on purpose: `RECO` reads as a typo at forty pixels, `REC`
 * reads as a word. Anything that survives neither falls back to the segment
 * number, which is always better than a blank plate.
 */
export function segmentSignLabel(name: string, oneBasedIndex: number): string {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  let out = '';
  if (words.length > 1) {
    for (const w of words) out += /^[0-9]+$/.test(w) ? w : w[0];
  } else if (words.length === 1) {
    out = words[0].slice(0, 3);
  }
  out = sanitizeSignText(out);
  return out || sanitizeSignText(String(oneBasedIndex));
}
