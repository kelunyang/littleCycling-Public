/**
 * `[sky vs demo]` — 天空的兩件事:**星星的大小模型**與**日照數學**。
 *
 * 兩件都不是 diorama.ts 已經在問的東西:
 *
 * - `[celestial shell]` 問的是**半徑**(天球 3000 m 在遠山之外、相機遠裁面之內,
 *   而且 demo 的 `SKY_SHELL_R` 跟 gameview 的 `MOON_DISTANCE` 相等)。它從來沒有
 *   問過**星星有多大** —— 而大小是一個**模型**不是一個數字:demo 走
 *   `sizeAttenuation: true`(世界公尺,投影替你縮),gameview 走
 *   `sizeAttenuation: false`(螢幕像素,不管多遠都一樣)。半徑對齊了不代表大小
 *   對齊,兩件事互相獨立。
 * - `[sun shadow map vs demos]` 已經把 `skyKeyFullDeg` / `skyKeyGainAt` 跟執行
 *   demo 得到的值逐位元組比過了。**沒有比過的是另外那半套**:`skySmoothstep`
 *   (gameview 的 `smoothstep` / `nightFactorFromElevation`)、`skyElevOf` /
 *   `skyAzimOf`(gameview 走的是它們的**反函式** `setFromSphericalCoords`)、
 *   以及 `SKY_RISE` 那條弧本身。
 *
 * ## 兩邊都讀「出貨的物件」,不讀原始碼
 *
 * 星星那一段的**註解裡剛好寫著 `fog: false`**,所以任何 regex 都永遠搜得到 ——
 * 前幾輪被這個騙過。這裡的做法一律是:把 demo 那段 IIFE 切出來**執行**,拿到
 * 真的 `THREE.Points`,讀它的 `material.size` / `material.sizeAttenuation` 與
 * `geometry.attributes.position`;gameview 側則是真的 `new SkyAndFog(...).init()`
 * 之後從 `scene` 裡把那顆 `Points` 撈出來讀同樣的欄位。兩邊都是出貨的物件。
 *
 * ## 日照數學:gameview 沒有「相位」,所以比的是**同一條弧**
 *
 * demo 的 7 個名字裡,只有 `skySmoothstep` 在 gameview 有一份自己的實作
 * (`day-night-lighting.ts` 的 `smoothstep`)。`skyWrap` / `skyTurnCos` /
 * `skyTurnSin` / `SKY_RISE` 是那根**相位滑桿**的內部零件 —— gameview 沒有滑桿,
 * 它從 `sun-moon-calc.ts` 拿真實星曆,所以把它們搬過去只會多四個死函式
 * (CUSTOM_WORLD_INSTRUCTIONS §0.0 第 2 條:只在真的擋住的地方改)。而
 * `skyElevOf` / `skyAzimOf` 在 gameview 是**反過來跑的**:demo 由向量讀角度,
 * gameview 由角度擺向量(`setFromSphericalCoords(1, 90−仰角, 方位)`)。
 *
 * 所以這裡不比對「有沒有那 7 個函式」,比對的是**它們算出來的東西**:
 * 把 demo 那條弧一個相位一個相位跑出來,餵進**真的** `SkyAndFog.applyLighting`,
 * 看主光被瞄到哪裡、夜間程度是多少,然後跟 demo 出貨的 `skyCelestial(p)` 比。
 * 7 個函式全部在那條路徑上,任何一個被改動都會讓下面的數字動。
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/sky-vs-demo.ts
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// 共用的 canvas stub。**不要**自己裝 `globalThis.document`(理由見 recording-canvas.ts)。
const { installRecordingCanvas } = await import('./recording-canvas.ts');
installRecordingCanvas();

const THREE = await import('three');
const { SkyAndFog, MOON_DISTANCE } = await import('@/game/terrain/sky-and-fog');
const { nightFactorFromElevation } = await import('@/game/terrain/day-night-lighting');
const { configureSunShadow, anchorSunShadow, GameRenderer } =
  await import('@/game/terrain/game-renderer');
const { createPlasticTerrainStyle } = await import('@/game/terrain/plastic-terrain-style');
const { createPaperTerrainStyle } = await import('@/game/terrain/paper-terrain-style');
const { createCircuitTerrainStyle } = await import('@/game/terrain/circuit-terrain-style');
type RecCanvas = import('./recording-canvas.ts').RecCanvas;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
export function failureCount(): number { return failures; }

const DEMOS = {
  plastic: 'plan/plastic-town-demo.html',
  paper: 'plan/paper-town-demo.html',
  circuit: 'plan/circuit-town-demo.html',
} as const;
type World = keyof typeof DEMOS;
const WORLDS = Object.keys(DEMOS) as World[];

const SRC: Record<World, string> = Object.fromEntries(
  WORLDS.map((w) => [w, readFileSync(DEMOS[w], 'utf8')]),
) as Record<World, string>;

const D2R = Math.PI / 180;

// ── demo 切片 ────────────────────────────────────────────────────────────────

/** 從 `at` 起、以第一個 `{` 開頭的那一個平衡區塊(含 header)。 */
function blockAt(src: string, at: number, what: string): string {
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error(`unbalanced ${what}`);
}

function sliceBetween(src: string, head: string, tail: string, what: string): string {
  const a = src.indexOf(head);
  if (a < 0) throw new Error(`${what}: 找不到 \`${head}\``);
  const b = src.indexOf(tail, a);
  if (b <= a) throw new Error(`${what}: \`${head}\` 之後找不到 \`${tail}\``);
  return src.slice(a, b);
}

/**
 * 日照數學那一節 —— **7 個名字全部住在這裡**:`SKY_RISE`、`skyWrap`、
 * `skyTurnCos`、`skyTurnSin`、`skySmoothstep`、`skyElevOf`、`skyAzimOf`
 * (外加 `skyCelestial` / `skyKeyFullDeg` / `skyKeyGainAt`)。
 *
 * 這一段是**純的**(不碰場景、不碰網址),所以可以直接 `new Function` 執行。
 * 邊界靠內容認,不靠行號。
 */
const MATH_HEAD = 'const SKY_NOON =';
const MATH_TAIL = '  // ── 這根滑桿接到世界上';
const mathSection = (w: World): string => sliceBetween(SRC[w], MATH_HEAD, MATH_TAIL, `${w} 日照數學`);

interface DemoState {
  phase: number;
  sun: { x: number; y: number; z: number };
  moon: { x: number; y: number; z: number };
  key: { x: number; y: number; z: number };
  isDay: boolean;
  sunElev: number; sunAzim: number;
  moonElev: number; moonAzim: number;
  keyElev: number; keyAzim: number;
  night: number;
}
interface DemoMath {
  skyCelestial: (p: number) => DemoState;
  skySmoothstep: (a: number, b: number, x: number) => number;
  skyElevOf: (v: { x: number; y: number; z: number }) => number;
  skyAzimOf: (v: { x: number; y: number; z: number }) => number;
  skyWrap: (p: number) => number;
  skyTurnCos: (t: number) => number;
  skyTurnSin: (t: number) => number;
  SKY_NOON: { x: number; y: number; z: number };
  SKY_RISE: { x: number; y: number; z: number };
}

/** 執行 demo 的日照數學,把那 7 個名字原樣交出來(§0.0 第 5 點)。 */
function runDemoMath(w: World): DemoMath {
  return new Function(`${mathSection(w)}
return { skyCelestial, skySmoothstep, skyElevOf, skyAzimOf, skyWrap,
         skyTurnCos, skyTurnSin, SKY_NOON, SKY_RISE };`)() as DemoMath;
}

/**
 * 執行 demo 的星星那一段 IIFE,交出真的 `THREE.Points`。
 *
 * 三份 demo 的畫布取得方式不同(paper / plastic 直接 `document.createElement`,
 * circuit 走自己的 `cv(w, h)`),`skyAnchor` 與 `SKY_SHELL_R` 則由外面注入 ——
 * 半徑是**世界自己宣告的**,所以從那份 demo 讀,而不是從這裡打進去。
 */
function runDemoStars(w: World): THREE.Points {
  const src = SRC[w];
  const at = src.indexOf('const stars = (() => {');
  if (at < 0) throw new Error(`${w}: 找不到星星那一段`);
  // `blockAt` 停在 arrow body 的 `}`,IIFE 的 `)();` 要補回去。
  const body = `${blockAt(src, at, `${w} stars`)})();`;
  const shellSrc = /const SKY_SHELL_R = (\d+);/.exec(src);
  if (!shellSrc) throw new Error(`${w}: 找不到 SKY_SHELL_R`);
  const anchor = new THREE.Group();
  const cv = (a: number, b: number): unknown => {
    const c = document.createElement('canvas') as unknown as { width: number; height: number };
    c.width = a || 32; c.height = b || a || 32;
    return c;
  };
  const run = new Function('THREE', 'document', 'skyAnchor', 'SKY_SHELL_R', 'cv',
    `${body}\nreturn stars;`);
  return run(THREE, globalThis.document, anchor, Number(shellSrc[1]), cv) as THREE.Points;
}

/** demo 自己宣告的天球半徑(給張角那條當分母的**另一個**來源用)。 */
const demoShellR = (w: World): number =>
  Number(/const SKY_SHELL_R = (\d+);/.exec(SRC[w])![1]);

/**
 * demo 那句 `stars.material.opacity = <運算式>;` —— **切出運算式再執行**,不是
 * 在這裡重打一次 `k * 0.9`。抄過來的常數只會把當初打錯的東西再確認一遍
 * (§0.0 第 5 點),而且這一句住在 `applyDayNight` 裡、跟整個場景綁在一起,
 * 整支跑不動,所以能執行的最小單位就是這個運算式本身。
 */
function demoStarOpacity(w: World): (k: number) => number {
  const m = /^\s*stars\.material\.opacity = (.+);$/m.exec(SRC[w]);
  if (!m) throw new Error(`${w}: 找不到 stars.material.opacity 那一句`);
  return new Function('k', `return ${m[1]};`) as (k: number) => number;
}

// ── rng shim:兩邊抽同一串亂數,位置就可以**逐位元組**比 ────────────────────
//
// demo 與 gameview 的取樣**順序**一樣(先 a 再 ph),每顆星各抽兩次,所以只要
// 餵同一串亂數,兩邊的 Float32Array 應該一個 bit 都不差。這比「兩邊各自亂數、
// 再比 min/max」強得多:260 個樣本的觀測極值本來就會晃 ±0.3°,而 circuit 跟另外
// 兩個世界的帶子只差 1.15° —— 用統計去比,那個刻意的分歧會被雜訊蓋掉。
const realRandom = Math.random;
function seedRandom(seed: number): void {
  let t = seed >>> 0;
  Math.random = (): number => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const restoreRandom = (): void => { Math.random = realRandom; };

// ── gameview 側:真的 SkyAndFog,真的 GameRenderer.setKeyLightDirection ───────

/**
 * `SkyAndFog` 講話的那個 GameRenderer 介面。主光經過 `configureSunShadow`,
 * 因為地平線增益是**從那塊 shadow 算出來的**(框、圖大小、normalBias),一盞裸
 * 的 DirectionalLight 會除以 0 然後把 NaN 餵給每一條斷言。
 */
function fakeRenderer(): {
  scene: THREE.Scene;
  keyLightCalls: [number, number][];
  directionalLight: THREE.DirectionalLight;
} & Record<string, unknown> {
  const keyLightCalls: [number, number][] = [];
  const directionalLight = new THREE.DirectionalLight();
  configureSunShadow(directionalLight);
  return {
    scene: new THREE.Scene(),
    ambientLight: new THREE.AmbientLight(),
    directionalLight,
    hemisphereLight: new THREE.HemisphereLight(),
    camera: new THREE.PerspectiveCamera(),
    renderer: {
      shadowMap: { enabled: true, type: THREE.PCFSoftShadowMap },
      domElement: { width: 1920, height: 1080 },
    },
    shadowLevel: 'full',
    keyLightGain: 1,
    setToneMappingExposure: () => {},
    setFog: () => {},
    setBackground: () => {},
    keyLightCalls,
    setKeyLightDirection: (e: number, a: number) => { keyLightCalls.push([e, a]); },
    // **借** GameRenderer 自己的,不是在這裡重寫一份 —— `castShadow` 有兩個主人
    // (品質分級的天花板與天空的地平線增益),鏡像的實作只會把當初打錯的東西
    // 再確認一遍(diorama.ts 的 `rendererProto` 同一個理由)。
    setShadowLevel: rendererProto.setShadowLevel,
    setKeyLightShadowGain: rendererProto.setKeyLightShadowGain,
    syncKeyLightCastShadow: rendererProto.syncKeyLightCastShadow,
  };
}

/** 三個世界的 strategy 工廠 —— `DEMOS` 的鍵對到自己那份。 */
const STYLE_OF: Record<World, () => { skyPalette: unknown }> = {
  plastic: createPlasticTerrainStyle,
  paper: createPaperTerrainStyle,
  circuit: createCircuitTerrainStyle,
};

/**
 * 一顆跑完 `init()` 的天空,以及它掛進 scene 的那片星星。
 *
 * `seed` 有給的話,就在 `setPalette` **之前**把 rng 釘住 —— `setPalette` 會重建
 * 星場(逐世界的顆數/帶子/貼圖都不同,改不了就地),而重建到讀出來之間沒有第二
 * 個 `Math.random()` 的使用者,所以那 `2 × count` 次抽取全部是 demo 那一串。
 */
function gameSky(world: World = 'plastic', seed?: number): {
  sky: { applyLighting: (c: unknown, p: THREE.Vector3 | null) => void;
    setDayNightEnabled: (b: boolean) => void;
    setWeather: (c: unknown) => void; };
  fake: ReturnType<typeof fakeRenderer>;
  stars: THREE.Points;
} {
  const fake = fakeRenderer();
  const sky = new SkyAndFog(fake as never) as never as {
    init: () => void; setPalette: (p: unknown) => void;
    applyLighting: (c: unknown, p: THREE.Vector3 | null) => void;
    setDayNightEnabled: (b: boolean) => void;
    setWeather: (c: unknown) => void;
  };
  sky.init();
  // strategy 要在**釘住 rng 之前**建好 —— 瓦楞紙的工廠自己會抽亂數(紙纖維、
  // 筆觸),建在窗口裡就會把那串亂數吃掉幾個,星星從第一顆就對不上。
  const palette = STYLE_OF[world]().skyPalette;
  if (seed !== undefined) seedRandom(seed);
  sky.setPalette(palette);
  if (seed !== undefined) restoreRandom();
  // 雨雪的粒子也是 THREE.Points,但它們走 ShaderMaterial;星星是這個場景裡唯一
  // 一片 `PointsMaterial`,所以由**材質類別**認,不靠名字或加入順序。
  const found: THREE.Points[] = [];
  fake.scene.traverse((o) => {
    const p = o as THREE.Points;
    if (p.isPoints && (p.material as THREE.PointsMaterial).isPointsMaterial) found.push(p);
  });
  if (found.length !== 1) throw new Error(`gameview: 找到 ${found.length} 片 PointsMaterial 星星`);
  return { sky, fake, stars: found[0] };
}

/**
 * gameview 真正把角度變成方向的那一支 —— `GameRenderer.prototype`
 * **借出來**,不是在這裡重寫一份(diorama.ts 的 `rendererProto` 同一個理由:
 * 鏡像的實作只會把當初打錯的東西再確認一遍)。
 */
const aimKeyLight = (elevDeg: number, azimDeg: number): THREE.Vector3 => {
  const light = new THREE.DirectionalLight();
  configureSunShadow(light);
  const target = new THREE.Object3D();
  const self = {
    keyLightDir: new THREE.Vector3(),
    directionalLight: light,
    sunTarget: target,
  };
  (GameRenderer.prototype as unknown as {
    setKeyLightDirection: (e: number, a: number) => void;
  }).setKeyLightDirection.call(self, elevDeg, azimDeg);
  // 借出來的那一支也真的用到了 anchorSunShadow;引用它一次,免得 lint 把 import
  // 當成死的,同時證明這個替身撐得起那條路徑。
  anchorSunShadow(light, target, target.position, self.keyLightDir);
  return self.keyLightDir;
};

/** 二進位相同(含 −0 / NaN)。閾值比較會讓「換成 clamp」這種突變溜過去。 */
const same = (a: number, b: number): boolean => Object.is(a, b);

/** `GameRenderer` 身上那幾支會寫 `castShadow` 的方法,借給替身用。 */
const rendererProto = GameRenderer.prototype as unknown as {
  setShadowLevel(level: string): void;
  setKeyLightShadowGain(gain: number): void;
  syncKeyLightCastShadow(): void;
};

console.log('\n[sky vs demo]');

// ── 1. 星星:**逐世界**跟自己的 demo 對 ─────────────────────────────────────
//
// 這一節的每一條都是「同一個世界的 demo vs 同一個世界的 gameview」。上一版只比
// plastic 一顆,而 `SkyPalette` 那時候沒有星星這一格 —— 三個世界共用一份寫死的
// 400 顆 / 10°–85° / 8×8 徑向漸層,沒有一項是任何一份 demo 說的。
{
  const RNG_SEED = 0x5741ab1e;
  const demoStars = {} as Record<World, THREE.Points>;
  for (const w of WORLDS) {
    seedRandom(RNG_SEED);
    demoStars[w] = runDemoStars(w);
    restoreRandom();
  }
  const demoMat = Object.fromEntries(
    WORLDS.map((w) => [w, demoStars[w].material as THREE.PointsMaterial]),
  ) as Record<World, THREE.PointsMaterial>;

  const ourStars = {} as Record<World, THREE.Points>;
  for (const w of WORLDS) ourStars[w] = gameSky(w, RNG_SEED).stars;
  const ourMat = Object.fromEntries(
    WORLDS.map((w) => [w, ourStars[w].material as THREE.PointsMaterial]),
  ) as Record<World, THREE.PointsMaterial>;

  // 1a. 模型:世界空間,不是螢幕像素。這是 demo 對「星星有多大」的答案,而
  //     gameview 原本走的是另一個模型(`sizeAttenuation: false`,固定螢幕像素)。
  //     一個模型錯了,size 給幾都對不起來,所以這條排在數字前面。
  const attn = WORLDS.map((w) => demoMat[w].sizeAttenuation);
  const ourAttn = WORLDS.map((w) => ourMat[w].sizeAttenuation);
  check('三份 demo 的星星都在世界空間裡量大小(sizeAttenuation),gameview 三個世界也是',
    attn.every((a) => a === true) && ourAttn.every((a) => a === true),
    `demo ${attn.join('/')} / gameview ${ourAttn.join('/')}`);

  // 1b. 尺度前提:世界空間的 size 只有在**兩邊的球一樣大**時才能字面照抄。
  //     半徑從**出貨的頂點**量,不讀常數 —— 常數對得上而頂點沒放上去過的情況
  //     正是 `STAR_RADIUS` 上一次被抓到的形狀。
  const radii = (p: THREE.Points): { min: number; max: number } => {
    const a = p.geometry.getAttribute('position');
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < a.count; i++) {
      const r = Math.hypot(a.getX(i), a.getY(i), a.getZ(i));
      min = Math.min(min, r); max = Math.max(max, r);
    }
    return { min, max };
  };
  // 容許量 1 mm:兩邊的位置都住在 Float32Array 裡,3000 m 上的 float32 間距是
  // 0.24 mm,所以這個界限只放過量化誤差,放不過任何「換了一顆球」的改動。
  const TOL = 1e-3;
  const off = (r: { min: number; max: number }): number =>
    Math.max(Math.abs(r.min - MOON_DISTANCE), Math.abs(r.max - MOON_DISTANCE));
  const demoR = Object.fromEntries(WORLDS.map((w) => [w, radii(demoStars[w])])) as
    Record<World, { min: number; max: number }>;
  const ourR = Object.fromEntries(WORLDS.map((w) => [w, radii(ourStars[w])])) as
    Record<World, { min: number; max: number }>;
  const shellOk = WORLDS.every((w) => off(demoR[w]) < TOL && off(ourR[w]) < TOL);
  check('兩邊的星星球一樣大(從頂點量,不讀常數)—— 這是 size 可以字面照抄的前提',
    shellOk,
    `demo 偏差 ${Math.max(...WORLDS.map((w) => off(demoR[w]))).toExponential(2)} m / gameview `
    + `${Math.max(...WORLDS.map((w) => off(ourR[w]))).toExponential(2)} m(對 ${MOON_DISTANCE} m)`);

  // ── 1c. ★ 這一輪最重要的一條:**視覺張角**,不是 size ★ ────────────────
  //
  // `sizeAttenuation: true` 的 size 是**世界公尺**,所以「星星有多大」是
  // `size / 天球半徑`,不是 `size`。兩個數字必須一起搬 —— 而 17c0f86 只搬了
  // 天球(950 → 3000),沒搬 size,demo 自己的星星就地縮成 0.317×(1080 高的
  // 視窗:5.12 px → 1.62 px)。日月圓盤逃過一劫是因為 `skyPlaceDisc` 走
  // `scale.setScalar(skyShell / r)`,自己跟著天球;星星走 size,不會。
  //
  // **所以這裡比的是張角,兩邊都用自己那顆球當分母。** 有人再搬一次天球而忘了
  // size,demo 的張角就會動、gameview 的不會,這一條當場紅 —— 這正是上一輪
  // 「size 對上了、星星卻看不到」溜過去的那個洞。
  //
  // 分母是**量出來的**(出貨頂點的平均半徑),不是常數:常數對得上而頂點沒放上去
  // 的情形,`STAR_RADIUS` 已經被抓過一次。代價是不能逐位元組比 —— float32 的
  // 相對誤差 6.0e-8,兩邊各吃一次就是 1.2e-7,所以下面用 1e-6 的相對容許量
  // (八倍餘裕)。size 本身的**逐位元組**比在 1d,兩條合起來沒有縫。
  const angleOf = (size: number, r: { min: number; max: number }): number =>
    size / ((r.min + r.max) / 2);
  const px = (size: number, r: { min: number; max: number }, cssH: number): number =>
    (size * cssH) / (2 * ((r.min + r.max) / 2));
  let angWorst = 0, angAt = '';
  for (const w of WORLDS) {
    const a = angleOf(demoMat[w].size, demoR[w]);
    const b = angleOf(ourMat[w].size, ourR[w]);
    const rel = Math.abs(a - b) / a;
    if (rel > angWorst) { angWorst = rel; angAt = w; }
  }
  check('★ 星星的**視覺張角**(size / 天球半徑)demo === gameview,逐世界 '
    + '—— 搬天球而沒搬 size 會被這條抓到',
    angWorst < 1e-6,
    WORLDS.map((w) => `${w} ${px(demoMat[w].size, demoR[w], 1080).toFixed(2)}`
      + `/${px(ourMat[w].size, ourR[w], 1080).toFixed(2)} px@1080`).join('  ')
    + `;最差相對差 ${angWorst.toExponential(2)}${angAt ? `(${angAt})` : ''}`);

  // 1d. 而 size 本身也逐位元組相同 —— **字面照抄**,不換算成等效的螢幕像素
  //     (換算過的數字下一個人看不出它為什麼是那個數字,§0.0 第 1 條)。今天
  //     兩邊的球一樣大,所以「張角相同」與「size 相同」同時成立;哪天不一樣了,
  //     1c 才是那條該留下來的,這一條會是第一個告訴你的。
  const sizeBad = WORLDS.filter((w) => !same(ourMat[w].size, demoMat[w].size));
  check('gameview 每個世界的 size === 它自己那份 demo 的 size(逐位元組)',
    sizeBad.length === 0,
    WORLDS.map((w) => `${w} ${demoMat[w].size}→${ourMat[w].size}`).join('  '));

  // 1e. 電子說的是 8(搬到新天球是 25.263157894736842),另外兩個是 9(28.42…)。
  //     **斷言這個差異**,不是抹平它:跟 normalBias(plastic/paper 1.5、
  //     circuit 1.2)同一個形狀,多數值是**預設**。而且兩邊都要問 —— 上一版只
  //     問了 demo 側,因為 gameview 那時候三個世界共用同一個數字。
  check('電子的星星比另外兩個小 —— 既有的分歧,demo 與 gameview 兩邊都斷言下來',
    demoMat.circuit.size < demoMat.plastic.size && demoMat.circuit.size > 0
    && ourMat.circuit.size < ourMat.plastic.size
    && same(demoMat.plastic.size, demoMat.paper.size)
    && same(ourMat.plastic.size, ourMat.paper.size),
    `demo ${demoMat.circuit.size} vs ${demoMat.plastic.size}`
    + ` / gameview ${ourMat.circuit.size} vs ${ourMat.plastic.size}`);

  // 1f. 顆數與**每一顆的位置**逐位元組相同。
  //
  //     兩邊餵的是同一串亂數(`seedRandom`),而且取樣順序一樣(先方位 a 再極角
  //     ph、每顆兩抽),所以 Float32Array 應該一個 bit 都不差。這一條一次蓋掉
  //     顆數、仰角帶、球半徑、以及三個軸的擺法 —— gameview 原本寫的是
  //     `(10 + rnd*75)°` 配 `sin/cos` 的另一種參數化,連「均勻」的意思都跟 demo
  //     不同,而且 400 顆、10°–85°,三個世界共用。
  const posOf = (p: THREE.Points): Float32Array =>
    p.geometry.getAttribute('position').array as Float32Array;
  let posBad = '';
  const bandDetail: string[] = [];
  for (const w of WORLDS) {
    const a = posOf(demoStars[w]), b = posOf(ourStars[w]);
    if (a.length !== b.length) { posBad ||= `${w}: ${a.length / 3} vs ${b.length / 3} 顆`; continue; }
    for (let i = 0; i < a.length; i++) {
      if (!same(a[i], b[i])) { posBad ||= `${w}: 第 ${i} 個分量 ${a[i]} ≠ ${b[i]}`; break; }
    }
    const elev = (arr: Float32Array): { lo: number; hi: number } => {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < arr.length; i += 3) {
        const e = Math.atan2(arr[i + 1], Math.hypot(arr[i], arr[i + 2])) / D2R;
        lo = Math.min(lo, e); hi = Math.max(hi, e);
      }
      return { lo, hi };
    };
    const e = elev(a);
    bandDetail.push(`${w} ${a.length / 3} 顆 ${e.lo.toFixed(2)}–${e.hi.toFixed(2)}°`);
  }
  check('顆數與每一顆星的座標逐位元組相同(同一串亂數)—— 顆數/仰角帶/取樣法一次蓋掉',
    posBad === '', posBad || bandDetail.join('  '));

  // 1g. 星點的**貼圖**:命令串流逐筆相同。
  //
  //     這是能見度比 size 更大的槓桿。demo 畫的是**實心圓盤**(32 px 畫布、
  //     半徑 7 / 6),gameview 原本畫的是 8×8 的徑向漸層,alpha 在 0.7 半徑處
  //     就掉到 0.2 —— 在 3–10 px 的尺寸下,實心 vs 漸層比 size 差得更多。
  //
  //     兩邊都從**出貨材質的 `map.image`** 讀(錄影畫布),不搜原始碼。
  const FULL = 6.283185; // recording-canvas 的 num() 是 1e-6 進位,Math.PI*2 進位後就是它
  const arcOf = (t: string[]): RegExpExecArray | null => {
    for (const op of t) {
      const m = /^arc\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)$/.exec(op);
      if (m) return m;
    }
    return null;
  };
  // circuit 的 demo 把整圈寫成 `6.284` 而不是 `Math.PI * 2`(另外兩份是 2π)。
  // 兩個都是「畫滿一整圈」,畫出來一模一樣,所以掃角在比對前正規化 —— 而
  // 「真的是一整圈」由下面那條單獨問,正規化不是用來蓋掉半圓的。
  const norm = (t: string[]): string => t.map((op) => {
    const m = /^arc\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)$/.exec(op);
    if (!m) return op;
    return Number(m[5]) - Number(m[4]) >= FULL
      ? `arc(${m[1]},${m[2]},${m[3]},${m[4]},FULL_TURN)` : op;
  }).join(' | ');
  const canvasOf = (m: THREE.PointsMaterial): RecCanvas =>
    (m.map as THREE.CanvasTexture).image as unknown as RecCanvas;
  let texBad = '';
  for (const w of WORLDS) {
    const a = canvasOf(demoMat[w]), b = canvasOf(ourMat[w]);
    if (a.width !== b.width || a.height !== b.height) {
      texBad ||= `${w}: 畫布 ${a.width}×${a.height} vs ${b.width}×${b.height}`;
      continue;
    }
    if (norm(a.trace) !== norm(b.trace)) texBad ||= `${w}:\n      demo ${norm(a.trace)}\n      我方 ${norm(b.trace)}`;
  }
  check('星點貼圖的 canvas 命令串流逐筆相同(實心圓盤,不是徑向漸層)',
    texBad === '',
    texBad || WORLDS.map((w) => `${w} ${canvasOf(demoMat[w]).width}px ${norm(canvasOf(demoMat[w]).trace)}`).join('\n      '));

  // 1h. …而那個 arc 真的是**一整圈**,兩邊都是。上面的正規化只放過「掃角 ≥ 2π」,
  //     這一條把它量出來,免得正規化自己變成一張遮羞布。
  const arcs = WORLDS.flatMap((w) => [arcOf(canvasOf(demoMat[w]).trace), arcOf(canvasOf(ourMat[w]).trace)]);
  check('…而且兩邊畫的都是整圓(掃角 ≥ 2π),正規化沒有放過半圓',
    arcs.every((m) => m !== null && Number(m[5]) - Number(m[4]) >= FULL),
    arcs.map((m) => (m ? (Number(m[5]) - Number(m[4])).toFixed(6) : 'none')).join(' / '));

  // 1i. 材質旗標。`fog: false` 那條 diorama 已經在問了(而且被註解騙過一次);
  //     這裡問的是另外四個,其中 **blending** 是這一輪補的:gameview 原本走
  //     `AdditiveBlending`,而三份 demo 都是預設的 `NormalBlending` —— 加法混色
  //     會把每個世界的星星洗成同一種白,而顏色現在是住在貼圖裡的。
  let flagBad = '';
  for (const w of WORLDS) {
    const a = demoMat[w], b = ourMat[w];
    if (a.blending !== b.blending) flagBad ||= `${w} blending ${a.blending} vs ${b.blending}`;
    if (a.transparent !== b.transparent) flagBad ||= `${w} transparent`;
    if (a.depthWrite !== b.depthWrite) flagBad ||= `${w} depthWrite`;
    if (a.fog !== b.fog) flagBad ||= `${w} fog`;
    if (a.color.getHex() !== b.color.getHex()) flagBad ||= `${w} color`;
  }
  check('星星材質:blending / transparent / depthWrite / fog / color 兩邊相同',
    flagBad === '',
    flagBad || `blending ${demoMat.plastic.blending}(Normal=${THREE.NormalBlending})`
      + `,transparent ${demoMat.plastic.transparent},depthWrite ${demoMat.plastic.depthWrite}`
      + `,fog ${demoMat.plastic.fog},color #${demoMat.plastic.color.getHexString()}`);

  // 1j. 星星的**亮度曲線**:demo 那句 `stars.material.opacity = k * 0.9` ——
  //     切出**運算式再執行**,再跟真的 `applyLighting` 之後材質上的值比。
  //     gameview 原本自己寫了一條 0° → −6° 的直線斜坡,而 demo 的窗口是
  //     +8° → −12°(`skySmoothstep(−12, 8, ·)`),整個民用曙暮光都被原本那條
  //     藏掉了。上限也不同:demo 留 0.9,原本是 1.0。
  {
    const opacityExpr = WORLDS.map((w) => demoStarOpacity(w));
    const { sky, stars } = gameSky('plastic', RNG_SEED);
    const mat = stars.material as THREE.PointsMaterial;
    let oDrift = 0, oWorst = '', maxSeen = 0;
    for (let e = -30; e <= 30; e += 0.05) {
      const elev = Math.round(e * 100) / 100;
      sky.applyLighting({
        sunElevation: elev, sunAzimuth: 180,
        moonElevation: -elev, moonAzimuth: 0,
        moonPhase: 0.5, isDaytime: elev > 0, dayFactor: elev > 0 ? 1 : 0,
      }, new THREE.Vector3());
      const want = opacityExpr[0](nightFactorFromElevation(elev));
      maxSeen = Math.max(maxSeen, mat.opacity);
      if (!same(mat.opacity, want)) {
        oDrift++;
        oWorst ||= `${elev}° → ${mat.opacity} ≠ ${want}`;
      }
    }
    check('星星的透明度 ≡ 執行 demo 那句 `stars.material.opacity = …`(整條弧逐位元組)',
      oDrift === 0,
      oDrift === 0 ? `1201 個仰角全中,峰值 ${maxSeen}` : `${oDrift} 處:${oWorst}`);
    // …而三份 demo 那一句是同一句(它們的 applyDayNight 是逐字相同的那一段之外
    // 的東西,所以這裡真的要問),而且它真的是一條**曲線**,不是常數。
    const sameExpr = opacityExpr.every((f) => same(f(0.37), opacityExpr[0](0.37)));
    check('…三份 demo 那一句算出來一樣,而且它會隨夜間程度變(不是常數)',
      sameExpr && opacityExpr[0](0) !== opacityExpr[0](1),
      `k=0 → ${opacityExpr[0](0)},k=1 → ${opacityExpr[0](1)}`);
  }

  // 1k. 反向對照:三個世界的星場**本來就互不相同**,所以上面每一條都不是
  //     「反正三份都一樣」撐起來的恆真句。3 × 3 交叉比對,只有對角線該相等。
  const fingerprint = (p: THREE.Points, m: THREE.PointsMaterial): string =>
    `${p.geometry.getAttribute('position').count}|${m.size}|`
    + `${norm(canvasOf(m).trace)}|${posOf(p)[1].toFixed(4)}`;
  let diag = 0, offDiag = 0;
  for (const a of WORLDS) for (const b of WORLDS) {
    const eq = fingerprint(demoStars[a], demoMat[a]) === fingerprint(ourStars[b], ourMat[b]);
    if (a === b) { if (eq) diag++; } else if (eq) offDiag++;
  }
  check('反向對照:三個世界的星場互不相同,只有「自己對自己」那三格相等',
    diag === 3 && offDiag === 0,
    `對角線 ${diag}/3 相等,非對角線 ${offDiag}/6 相等;`
    + WORLDS.map((w) => `${w}=${demoStars[w].geometry.getAttribute('position').count}顆/`
      + `${demoMat[w].size.toFixed(2)}m/r${arcOf(canvasOf(demoMat[w]).trace)![3]}px`).join(' '));

  // 1l. 星場**跟著騎士整顆移動**,三個軸都要。demo 的星星、日月與天空球掛在
  //     同一個 `skyAnchor` 上,而它是 `set(bp.x, bp.y, bp.z)` —— gameview 這邊
  //     原本只複製了 x 與 z,爬升 h 公尺就把頭頂的星星拉近 h 公尺,而天球釘在
  //     3000 m 的唯一理由就是要待在遠山環(2600)與電子鰭片(2700)外面。
  {
    const at = new THREE.Vector3(1234.5, 678.25, -910.75);
    // demo 側也是**執行**的:把那一行切出來,餵一個假的 anchor 與假的騎士位置,
    // 看它把 anchor 擺到哪。`^\s*skyAnchor\.` 認得出註解裡的同一串字(註解那行
    // 開頭是 `/`),而且改成 `set(bp.x, 0, bp.z)` 這種寫法會當場現形 ——
    // 純字串比對兩件事都做不到。
    const demoAnchor = WORLDS.map((w) => {
      const line = /^\s*skyAnchor\.position\.set\([^)]*\);$/m.exec(SRC[w]);
      if (!line) throw new Error(`${w}: 找不到 skyAnchor 跟騎士的那一行`);
      const g = new THREE.Group();
      new Function('skyAnchor', 'bp', line[0])(g, { x: at.x, y: at.y, z: at.z });
      return g.position.clone();
    });
    const { sky, stars } = gameSky('plastic', RNG_SEED);
    sky.applyLighting({
      sunElevation: -30, sunAzimuth: 180, moonElevation: 30, moonAzimuth: 0,
      moonPhase: 0.5, isDaytime: false, dayFactor: 0,
    }, at);
    check('星場整顆跟著騎士走(x / y / z 都要)—— 執行 demo 那行 skyAnchor 擺位來比',
      stars.visible && demoAnchor.every((p) => p.equals(at)) && stars.position.equals(at),
      `demo 的 skyAnchor → ${demoAnchor.map((p) => p.toArray().join('/')).join('  ')}`
      + `;gameview 的星場 → ${stars.position.toArray().join('/')}(騎士在 ${at.toArray().join('/')})`);
  }
}

// ── 2. 日照數學:三份 demo 逐位元組相同 ─────────────────────────────────────
{
  const secs = WORLDS.map(mathSection);
  const sha = createHash('sha256').update(secs[0]).digest('hex');
  const identical = secs.every((s) => s === secs[0]);
  const firstDiff = identical ? -1 : [...secs[0]].findIndex((c, i) => c !== secs[1][i]);
  check('三份 demo 的日照數學(SKY_NOON … skyKeyGainAt)逐位元組相同',
    identical && secs[0].length > 3000,
    identical ? `${secs[0].length} chars, sha256 ${sha.slice(0, 10)}`
      : `第一個差異在第 ${firstDiff} 個字元`);
  // 而那 7 個名字真的在裡面 —— 不然上面那條在「整節被刪光」時也會過
  // (三份都空 → 三份仍然相同)。
  const NAMES = ['SKY_RISE', 'skyWrap', 'skyTurnCos', 'skyTurnSin',
    'skySmoothstep', 'skyElevOf', 'skyAzimOf'];
  const missing = NAMES.filter((n) => !new RegExp(`(const|function|let) ${n}\\b`).test(secs[0]));
  check('…而那 7 個名字真的宣告在這一節裡', missing.length === 0,
    missing.length ? `少了 ${missing.join(', ')}` : NAMES.join(' '));
}

// ── 3. 日照數學:gameview 的那一套 vs 執行 demo 得到的 ───────────────────────
{
  const math = Object.fromEntries(WORLDS.map((w) => [w, runDemoMath(w)])) as Record<World, DemoMath>;
  const m = math.plastic;

  // 3a. `skySmoothstep` ≡ gameview 的 `smoothstep`。gameview 沒有把它公開,但
  //     `nightFactorFromElevation` 就是 `1 − smoothstep(−12, 8, x)`,所以問它
  //     等於問那一支。**逐位元組**,而且掃過兩個端點與整個飽和區 —— 只點中間
  //     一個角度的話,把 smoothstep 換成線性 clamp 也照樣過。
  let sDrift = 0, sWorst = '';
  const probes: number[] = [-12, 8, -12 - 1e-12, 8 + 1e-12, 0, -0];
  for (let e = -90; e <= 90; e += 0.01) probes.push(Math.round(e * 100) / 100);
  for (const e of probes) {
    const ours = nightFactorFromElevation(e);
    const theirs = 1 - m.skySmoothstep(-12, 8, e);
    if (!same(ours, theirs)) { sDrift++; if (!sWorst) sWorst = `${e}° → ${ours} ≠ ${theirs}`; }
  }
  check('gameview 的 nightFactorFromElevation ≡ 執行 demo 的 skySmoothstep(−12, 8, ·)',
    sDrift === 0, sDrift === 0 ? `${probes.length} 個仰角逐位元組全中` : `${sDrift} 處:${sWorst}`);

  // 3b. 反向對照:那條曲線真的在動。兩端都取得到、中間有一段真的中間值,而且
  //     單調 —— 不然 3a 在「兩邊都退化成常數」時也會全中。
  let mono = true, mid = 0, sawOne = false, sawZero = false;
  for (let e = -30; e <= 30; e += 0.5) {
    const a = nightFactorFromElevation(e), b = nightFactorFromElevation(e + 0.5);
    if (b > a) mono = false;
    if (a > 0 && a < 1) mid += 0.5;
    if (a === 1) sawOne = true;
    if (a === 0) sawZero = true;
  }
  check('…而且那條曲線是活的:單調下降、兩端都取得到、中間有整整一段過渡',
    mono && sawOne && sawZero && mid >= 19, `中間值涵蓋 ${mid}° 的仰角(邊界 −12…8)`);

  // 3c. demo **出貨的物件**上的 `night`,跟 gameview 的算出來一樣。3a 是拿
  //     `skySmoothstep` 直接比,這一條走的是 `skyCelestial(p).night` ——
  //     也就是 demo 自己組好、自己會用的那個值,順帶把 `SKY_RISE` 的弧、
  //     `skyTurnCos/Sin` 的整點查表、`skyElevOf` 的 asin 全部串進來。
  //     相位取 **i / 1024**(二進位有限小數),`skyWrap` 因此是精確的,下面
  //     3d 才能用逐位元組比。
  const PH = 1024;
  const phases: number[] = [];
  for (let i = 0; i < PH; i++) phases.push(i / PH);
  let nDrift = 0, nWorst = '';
  for (const p of phases) {
    const st = m.skyCelestial(p);
    const ours = nightFactorFromElevation(st.sunElev);
    if (!same(ours, st.night)) { nDrift++; if (!nWorst) nWorst = `相位 ${p} → ${ours} ≠ ${st.night}`; }
  }
  check('gameview 的夜間程度 ≡ demo 出貨的 skyCelestial(p).night,整條弧逐位元組',
    nDrift === 0, nDrift === 0 ? `${PH} 個相位全中` : `${nDrift} 處:${nWorst}`);

  // 3d. `skyWrap`:相位加減整數圈是**同一張天**。gameview 沒有相位,所以它不需要
  //     這支函式 —— 但下面 3e/3f 要在 ±2 圈的範圍掃,靠的就是這個性質。
  let wDrift = 0;
  for (const p of phases) {
    const base = m.skyCelestial(p);
    for (const k of [-2, -1, 1, 2]) {
      const st = m.skyCelestial(p + k);
      if (!same(st.key.x, base.key.x) || !same(st.key.y, base.key.y)
        || !same(st.key.z, base.key.z) || !same(st.night, base.night)) wDrift++;
    }
  }
  check('skyWrap:相位 ±1 / ±2 圈落在同一張天(二進位相位下逐位元組)',
    wDrift === 0, wDrift === 0 ? `${PH} × 4 個偏移全中` : `${wDrift} 處不同`);

  // 3e. **`skyElevOf` / `skyAzimOf` 的反函式就是 gameview 的擺位。**
  //     demo 由向量讀角度,gameview 由角度擺向量。這一條把 demo 那條弧上的每一顆
  //     主光的 (仰角, 方位) 餵進**借出來的** `GameRenderer.setKeyLightDirection`,
  //     再跟 demo 自己那個 key 向量的單位向量比。任何一邊換了軸序、掉了 `90 −`、
  //     或把 atan2 的兩個引數對調,這裡就會炸開(那些都是 O(1) 的偏差)。
  let worstAng = 0, worstAt = '';
  for (const p of [...phases, ...phases.map((x) => x + 2), ...phases.map((x) => x - 1)]) {
    const st = m.skyCelestial(p);
    const dir = aimKeyLight(st.keyElev, st.keyAzim);
    const inv = 1 / Math.hypot(st.key.x, st.key.y, st.key.z);
    const d = Math.hypot(dir.x - st.key.x * inv, dir.y - st.key.y * inv, dir.z - st.key.z * inv);
    if (d > worstAng) { worstAng = d; worstAt = `相位 ${p.toFixed(4)}`; }
  }
  check('gameview 瞄主光的方向 ≡ demo 的 skyElevOf / skyAzimOf 反過來算(整條弧)',
    worstAng < 1e-12,
    `最差 ${worstAng.toExponential(2)}(單位向量,${worstAt});3072 個相位`);

  // 3f. 而且那條弧真的是一顆**球**上的弧 —— `SKY_RISE` 跟 `SKY_NOON` 等長且正交,
  //     所以 |key| 是常數。這正是 gameview 把日月釘在固定 `MOON_DISTANCE` 上
  //     (`placeCelestialDisc`)的前提:半徑會變的話,照抄一個半徑就是錯的。
  const len = (v: { x: number; y: number; z: number }): number => Math.hypot(v.x, v.y, v.z);
  let rMin = Infinity, rMax = -Infinity;
  for (const p of phases) { const r = len(m.skyCelestial(p).key); rMin = Math.min(rMin, r); rMax = Math.max(rMax, r); }
  const noonLen = len(m.SKY_NOON);
  const dot = m.SKY_NOON.x * m.SKY_RISE.x + m.SKY_NOON.y * m.SKY_RISE.y + m.SKY_NOON.z * m.SKY_RISE.z;
  check('SKY_RISE 與 SKY_NOON 等長且正交 —— 日月跑在一顆球上,半徑不會變',
    Math.abs(len(m.SKY_RISE) - noonLen) < 1e-9 && Math.abs(dot) < 1e-9
    && rMax - rMin < 1e-9 && Math.abs(rMin - noonLen) < 1e-9,
    `|SKY_NOON| ${noonLen.toFixed(6)} / |SKY_RISE| ${len(m.SKY_RISE).toFixed(6)}`
    + `,dot ${dot.toExponential(1)},弧上半徑 ${rMin.toFixed(6)}…${rMax.toFixed(6)}`);

  // 3g. 三份 demo 的這幾支算出來的東西也一樣(它們的原始碼逐位元組相同,但
  //     「相同的原始碼」跟「相同的行為」是兩件事 —— 上面是讀檔比字串,這裡是
  //     三份各自執行再比值)。
  let xDrift = 0;
  for (const p of phases) {
    const a = math.plastic.skyCelestial(p);
    for (const w of ['paper', 'circuit'] as World[]) {
      const b = math[w].skyCelestial(p);
      if (!same(a.keyElev, b.keyElev) || !same(a.keyAzim, b.keyAzim) || !same(a.night, b.night)) xDrift++;
    }
  }
  check('三份 demo 各自執行也給出同一條弧', xDrift === 0,
    xDrift === 0 ? `${PH} 個相位 × 2 份全中` : `${xDrift} 處不同`);
}

// ── 4. 送得到:真的 applyLighting 走完之後,主光被瞄到 demo 說的那個方向 ─────
//
// 「記錄了 ≠ 送得到」。上面第 3 節問的是純函式;這一節跑的是真的
// `SkyAndFog.applyLighting`,讀 `setKeyLightDirection` 實際收到什麼。
{
  const m = runDemoMath('plastic');
  const { sky, fake } = gameSky();
  const PH = 512;

  let routed = 0, rWorst = '';
  for (let i = 0; i < PH; i++) {
    const p = i / PH;
    const st = m.skyCelestial(p);
    // 太陽剛好落在 0° 的那兩個相位(0.25 / 0.75)兩邊的當班規則不同 ——
    // demo 是 `sun.y >= 0`,gameview 的 `isDaytime` 是 `> 0`。那一格由 4b 單獨
    // 處理,這裡掃的是其餘全部。
    if (st.sunElev === 0) continue;
    fake.keyLightCalls.length = 0;
    sky.applyLighting({
      sunElevation: st.sunElev, sunAzimuth: st.sunAzim,
      moonElevation: st.moonElev, moonAzimuth: st.moonAzim,
      moonPhase: 0.5, isDaytime: st.sunElev > 0, dayFactor: st.sunElev > 0 ? 1 : 0,
    }, new THREE.Vector3());
    const call = fake.keyLightCalls[0];
    if (!call) { routed++; rWorst ||= `相位 ${p} 沒有瞄任何方向`; continue; }
    if (!same(call[0], st.keyElev) || !same(call[1], st.keyAzim)) {
      routed++;
      rWorst ||= `相位 ${p}:送出 ${call[0]}/${call[1]},demo 說 ${st.keyElev}/${st.keyAzim}`;
    }
  }
  check('applyLighting 把主光瞄到 demo 當班那一顆的仰角與方位(逐位元組)',
    routed === 0, routed === 0 ? `${PH - 2} 個相位全中` : `${routed} 處:${rWorst}`);

  // 4b. **既有的分歧,斷言下來。** demo 的當班規則是 `sun.y >= 0`(它自己寫了
  //     理由:「日出 / 日落那一刻太陽**就在**地平線上」),gameview 的
  //     `isDaytime` 是 `> 0`。所以在**恰好** 0° 那一刻兩邊選不同顆,方位差
  //     180°。它之所以沒有後果,是因為 `skyKeyGainAt(0) = 0`:兩顆都不照、
  //     兩顆都不投影,天光接手 —— 這一條把「沒有後果」也一起量出來,不然
  //     它只是一句話。
  const at0 = m.skyCelestial(0.25);
  fake.keyLightCalls.length = 0;
  sky.applyLighting({
    sunElevation: at0.sunElev, sunAzimuth: at0.sunAzim,
    moonElevation: at0.moonElev, moonAzimuth: at0.moonAzim,
    moonPhase: 0.5, isDaytime: at0.sunElev > 0, dayFactor: 0,
  }, new THREE.Vector3());
  const call0 = fake.keyLightCalls[0];
  const azimGap = ((call0[1] - at0.keyAzim) % 360 + 360) % 360;
  check('恰好 0° 時兩邊選不同顆(demo `>= 0` / gameview `> 0`),但主光的強度是 0 —— 分歧無後果',
    at0.sunElev === 0 && at0.isDay && call0[0] === 0 && Math.abs(azimGap - 180) < 1e-9
    && fake.directionalLight.intensity === 0 && !fake.directionalLight.castShadow,
    `demo 挑太陽 ${at0.keyAzim.toFixed(2)}° / gameview 挑月亮 ${call0[1].toFixed(2)}°`
    + `(差 ${azimGap.toFixed(2)}°),主光 intensity ${fake.directionalLight.intensity}`);

  // 4c. 月亮是太陽的**正對面** —— 走 gameview 自己的 `legacyCelestial`
  //     (`setDayNightEnabled(false)` + `setWeather` 才到得了那條路),
  //     跟 demo 的 `moon = -sun` 比。這是 gameview 唯一一處自己算月亮位置的
  //     地方,而它算的必須是 demo 那條弧。
  sky.setDayNightEnabled(false);
  let lDrift = 0, lWorst = '', lMax = 0;
  for (let i = 0; i < PH; i++) {
    const st = m.skyCelestial(i / PH);
    if (st.sunElev === 0) continue;
    fake.keyLightCalls.length = 0;
    sky.setWeather({ type: 'sunny', sunElevation: st.sunElev, sunAzimuth: st.sunAzim });
    const call = fake.keyLightCalls[fake.keyLightCalls.length - 1];
    const dE = Math.abs(call[0] - st.keyElev);
    const dA = Math.abs(((call[1] - st.keyAzim) % 360 + 540) % 360 - 180);
    lMax = Math.max(lMax, dE, dA);
    if (dE > 1e-9 || dA > 1e-9) {
      lDrift++;
      lWorst ||= `仰角 ${st.sunElev.toFixed(3)}°:送出 ${call[0]}/${call[1]},demo 說 ${st.keyElev}/${st.keyAzim}`;
    }
  }
  check('day/night 關掉的那條路(legacyCelestial)算出來的月亮 ≡ demo 的 moon = −sun',
    lDrift === 0, lDrift === 0 ? `${PH - 2} 個仰角,最差 ${lMax.toExponential(2)}°` : `${lDrift} 處:${lWorst}`);
}
