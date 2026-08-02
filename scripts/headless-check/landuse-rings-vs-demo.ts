/**
 * `[landuse rings vs demo]` — 地被「環」那一層的逐件比對。
 *
 * ## 為什麼是一支新檔,而不是一次移植
 *
 * 這支的來由是一張「還沒移植」的清單:`luKindOf` / `luRings` / `luRingInfo`。
 * 三個都在 `node scripts/headless-check/demo-coverage.mjs` 的 ABSENT 欄裡,而
 * **三個都已經在 gameview 裡了**:
 *
 * | demo(LANDUSE 區塊) | gameview | 住在哪 |
 * |---|---|---|
 * | `luKindOf(f)` | 九列 spec 的 `match` 述詞 | `landuse-renderer.ts` |
 * | `luRings(f)` | `extractPolygonCoords(f)` | 同上(而且是 export 的) |
 * | `luRingInfo(ring)` | `buildGeometryGroup` 裡算 `LandusePatch` 的那一段 | 同上 |
 *
 * demo 那一段自己寫著「**這一段是反方向的移植:分派邏輯逐條照抄 gameview**」——
 * 它們是 gameview 先有、demo 後抄的東西,不是待移植的 demo 造型。coverage 報表看
 * 不到它們的原因是**結構性的**:那支工具只拿 demo 去比 `*-terrain-style.ts`
 * (每個世界自己的貨架),而這三個是**世界無關**的分派/幾何碼,所以住在共用的
 * renderer 裡。同一個坑已經被補過一次 —— plastic 的 targets 額外列了
 * `ground-studs.ts`,理由逐字是「Without this the report calls them missing」。
 * 而且這三個函式體裡**一個 magic number 都沒有**(`fingerprint()` 全空 → ratio
 * 由 `named` 決定 → 改名就是 ABSENT),所以光加 target 也翻不過來,要的是
 * `ALIASES` 那一格。
 *
 * ## 所以這支證明的是「等價」,不是「有搬」
 *
 * §0.0 第 6 點:**「照抄」是一次性的動作,「還是一樣」不是。** 兩邊各自長大的
 * 唯一擋法就是把 demo 的那段**切出來執行**再比出貨物件。這支比三件事:
 *
 *   1. `luRings` vs `extractPolygonCoords` —— 兩邊都執行,逐點比。內環(洞)要
 *      掉、MultiPolygon 每個 poly 只留外環、非多邊形回空陣列。
 *   2. `luRingInfo` vs gameview 送進 `buildLanduseProps` 的 `centerX / centerZ /
 *      radius` —— 出貨物件,跑的是真的 `buildLanduseMeshes`。
 *   3. `luKindOf` vs gameview 九列 spec 的**執行結果**(哪一格的 layer 真的收到
 *      了那個多邊形),而不是拿 regex 去 gameview 原始碼裡撈 class 字串。
 *
 * 而且 demo 側全部走**三份 demo 各自的**切片,所以其中一份漂掉就會失敗(§5)。
 *
 * ## 兩個刻意不比的地方,理由寫在這裡
 *
 * - **`luSlab` 的高度不比。** demo 是「每個頂點各自貼地」,gameview 是「一環最低
 *   的 DEM 取樣 → 往下夾一階 → floor 到量化階的**平板**」。demo 自己寫了為什麼
 *   (它的走廊是平滑的,平板會一半埋一半浮),並註明「**不是**要移植回去的規則」。
 *   所以這支只比 `x / z`,`y` 只做一條**自我一致**的斷言:送出去的 `slabY` 必須
 *   等於那塊板子幾何裡的 y(道具站在板子上,不是站在原始 DEM 上)。
 * - **rng / seed 不比。** 那是 `props-vs-demo.ts` 的 `[landuse props: 種子取自
 *   位置]` 與 `[landuse lamp → gameview]` 兩節的事(它們跑的是 `geoSeed`
 *   換座標系那條分歧)。這支只管環的幾何。
 *
 * 單獨跑:
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/landuse-rings-vs-demo.ts
 */
import { readFileSync } from 'node:fs';

// canvas stub 走共用的那一份(理由見 `recording-canvas.ts`)。這支用的是假 strategy,
// 自己不畫任何貼圖,但 import 圖上的別人會 —— 所以照規矩裝共用那一份,不自己造。
const { installRecordingCanvas } = await import('./recording-canvas.ts');
installRecordingCanvas();

const THREE = await import('three');
const { buildLanduseMeshes, disposeLanduseMeshes, extractPolygonCoords } =
  await import('@/game/terrain/landuse-renderer');
type LanduseResult = Awaited<ReturnType<typeof buildLanduseMeshes>>;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
export function failureCount(): number { return failures; }

console.log('\n[landuse rings vs demo]');

// ── demo 側:切出來執行 ───────────────────────────────────────────────────────

const WORLDS = ['paper', 'plastic', 'circuit'] as const;
type World = typeof WORLDS[number];
const DEMO_PATH: Record<World, string> = {
  paper: 'plan/paper-town-demo.html',
  plastic: 'plan/plastic-town-demo.html',
  circuit: 'plan/circuit-town-demo.html',
};
const SRC: Record<World, string> = {
  paper: readFileSync(DEMO_PATH.paper, 'utf8'),
  plastic: readFileSync(DEMO_PATH.plastic, 'utf8'),
  circuit: readFileSync(DEMO_PATH.circuit, 'utf8'),
};

/** 一支 `function name(...) { … }`,靠數大括號抓到它自己的收尾。 */
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
/** 含某個片段的那**一行**(用來取 demo 自己算 cosLat 的那一句)。 */
function sliceLine(src: string, needle: string): string {
  const at = src.indexOf(needle);
  if (at < 0) throw new Error(`cannot find line containing ${needle}`);
  const a = src.lastIndexOf('\n', at) + 1;
  const b = src.indexOf('\n', at);
  return src.slice(a, b < 0 ? src.length : b);
}
/** `  const NAME = …;` 一路到它自己收尾的那個分號(靠數括號)。 */
function sliceStmt(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`cannot slice statement ${head}`);
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ';' && depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unterminated statement ${head}`);
}

type Ring = [number, number][];
type LonLatRing = [number, number][];
interface RingInfo { cx: number; cz: number; r: number }
interface DemoLu {
  luRings: (f: unknown) => LonLatRing[];
  luRingInfo: (ring: Ring) => RingInfo;
  luKindOf: (f: unknown) => string | null;
  geoToLocal: (lat: number, lon: number) => { x: number; z: number };
  cosLat: number;
  /** demo 的 `luPatches` 那一行:經緯度環 → 世界公尺環。 */
  toLocalRing: (lonlat: LonLatRing) => Ring;
}

/** 這條路線的原點。gameview 與 demo 的 `GEO` 都吃這一組,不然公尺座標系不同。 */
const ORIGIN_LAT = 25.0431;
const ORIGIN_LON = 121.5654;
const ORIGIN_ELE = 17;

/**
 * demo 的三支 + 那條投影,從 HTML 切出來在 sandbox 裡跑。
 *
 * `cosLat` 不是這個檔案算的 —— 它是 demo 自己那一行 `GEO.cosLat = Math.cos(…)`。
 * gameview 的 `cosOrigin` 是同一個運算式,所以兩邊的公尺座標系逐位元一致;抄一份
 * 到這裡只會把當初打錯的東西再確認一遍(§0.0 第 5 點)。
 */
function demoLu(w: World): DemoLu {
  const src = SRC[w];
  const make = new Function('originLat', 'originLon', `
    const GEO = { originLat, originLon, cosLat: 1 };
    ${sliceLine(src, 'GEO.cosLat = Math.cos(').trim()}
    ${sliceFn(src, 'geoToLocal')}
    ${sliceFn(src, 'luRings')}
    ${sliceFn(src, 'luRingInfo')}
    ${sliceFn(src, 'luKindOf')}
    const toLocalRing = (lonlat) => lonlat.map((p) => {
      const l = geoToLocal(p[1], p[0]);
      return [l.x, l.z];
    });
    return { luRings, luRingInfo, luKindOf, geoToLocal, toLocalRing, cosLat: GEO.cosLat };
  `) as (a: number, b: number) => DemoLu;
  return make(ORIGIN_LAT, ORIGIN_LON);
}

const LU: Record<World, DemoLu> = {
  paper: demoLu('paper'), plastic: demoLu('plastic'), circuit: demoLu('circuit'),
};

// 三份 demo 的這三支必須逐位元組相同(§5)。`props-vs-demo.ts` 已經比過整段
// LANDUSE 區塊;這一條比的是**我切出來的這三支**,所以「切錯地方」也會現形 ——
// 例如哪天有人在區塊外面又寫了一個同名的 `luRingInfo`,indexOf 會先撞到那一個。
{
  const cuts = WORLDS.map((w) => ['luRings', 'luRingInfo', 'luKindOf']
    .map((n) => sliceFn(SRC[w], n)).join('\n'));
  const same = cuts.every((c) => c === cuts[0]);
  check('三份 demo 切出來的 luRings / luRingInfo / luKindOf 逐位元組相同',
    same && cuts[0].length > 500, same ? `${cuts[0].length} chars` : '三份不一樣');
  // …而且它們真的在共用的 LANDUSE 區塊裡面,不是區塊外某個同名的東西。
  const inBlock = WORLDS.every((w) => {
    const a = SRC[w].indexOf('── LANDUSE 區塊開始 ──');
    const b = SRC[w].indexOf('// ══ LANDUSE 區塊結束 ══');
    return ['luRings', 'luRingInfo', 'luKindOf'].every((n) => {
      const at = SRC[w].indexOf(`function ${n}(`);
      return a >= 0 && b > a && at > a && at < b;
    });
  });
  check('…而且切到的是共用 LANDUSE 區塊裡的那三支', inBlock);
  check('三份 demo 的 cosLat 一致,而且是 demo 自己那一行算的',
    new Set(WORLDS.map((w) => LU[w].cosLat)).size === 1 && LU.paper.cosLat < 1,
    `cosLat = ${LU.paper.cosLat}`);
}

// ── 測資:閉合、歪一邊、半徑由**一個**頂點決定 ─────────────────────────────
//
// 三件事同時要成立,不然斷言會變成恆真句:
//
//   ・**閉合**(首 = 尾)—— 真實 MVT 的環就是閉合的,而重複的那個頂點會把重心往
//     那個角拉 1/n。兩邊都吃同一份偏差,所以它必須在測資裡出現;
//     `props-vs-demo.ts` 那一節刻意給不閉合的四點環(它量的是擺燈規則),
//     這裡剛好補上它避開的那一格。
//   ・**歪一邊** —— 重心不等於外框中心,而且 cx ≠ cz,所以「cx/cz 寫反」會現形。
//   ・**單一遠頂點** —— r 由某一個頂點決定,所以 `Math.max` → 別的縮併會現形。
function lopsidedRing(cLon: number, cLat: number, n: number, phase: number): LonLatRing {
  const out: LonLatRing = [];
  for (let i = 0; i < n; i++) {
    // `+ 0.37` 讓沒有一個頂點落在座標軸上。少了它,最遠的那個頂點在某些 phase 上
    // 剛好 dz = 0,於是「半徑只量 x」這個突變跟正確實作等價 —— 一個實測抓到的
    // 恆真句(差 0.0 m)。
    const a = ((i + 0.37) / n) * Math.PI * 2;
    // 一個瓣伸到 2.4 倍,其餘塌回 1 倍。經度振幅只有 0.55 倍 → 這塊地是**南北長**
    // 的,所以 cx ≠ cz(「cx/cz 寫反」現形),而且最遠的那個頂點的 |dz| 遠大於
    // |dx| —— 「半徑只量 x」那個突變因此差得出來(第一版把長軸放在東西向,兩者只
    // 差 0.04 m,`> 1 m` 的門檻抓不到,實測是 MISSED)。
    const rad = 1.3e-4 * (1 + 1.4 * Math.max(0, Math.cos(a - phase)) ** 3);
    out.push([cLon + Math.cos(a) * rad * 0.55, cLat + Math.sin(a) * rad]);
  }
  out.push([out[0][0], out[0][1]]);       // 閉合,跟真實 MVT 一樣
  return out;
}

// ── A. luRings vs extractPolygonCoords ──────────────────────────────────────
//
// 兩邊都執行,逐點比。測資裡**一定要有洞**,不然「把內環也留下來」這個突變在
// 沒有洞的多邊形上跟正確實作完全等價(§6.3 那一族)。
{
  const outerA = lopsidedRing(ORIGIN_LON, ORIGIN_LAT, 13, 0.7);
  const holeA1 = lopsidedRing(ORIGIN_LON, ORIGIN_LAT, 7, 2.1).map(
    (p) => [ORIGIN_LON + (p[0] - ORIGIN_LON) * 0.3, ORIGIN_LAT + (p[1] - ORIGIN_LAT) * 0.3],
  ) as LonLatRing;
  const holeA2 = lopsidedRing(ORIGIN_LON, ORIGIN_LAT, 5, 4.4).map(
    (p) => [ORIGIN_LON + (p[0] - ORIGIN_LON) * 0.15, ORIGIN_LAT + (p[1] - ORIGIN_LAT) * 0.15],
  ) as LonLatRing;
  const multi = [0, 1, 2].map((i) => {
    const lon = ORIGIN_LON + 0.004 * (i + 1);
    const lat = ORIGIN_LAT + 0.003 * (i - 1);
    const outer = lopsidedRing(lon, lat, 9 + i * 2, 1.1 * (i + 1));
    const hole = lopsidedRing(lon, lat, 6, 0.3 * (i + 1)).map(
      (p) => [lon + (p[0] - lon) * 0.25, lat + (p[1] - lat) * 0.25],
    ) as LonLatRing;
    return [outer, hole];
  });

  const FIXTURES: { name: string; f: unknown; wantRings: number }[] = [
    {
      name: 'Polygon + 兩個洞',
      f: { layer: 'landuse', properties: { class: 'pitch' },
        geometry: { type: 'Polygon', coordinates: [outerA, holeA1, holeA2] } },
      wantRings: 1,
    },
    {
      name: 'MultiPolygon 三塊,每塊各一個洞',
      f: { layer: 'landcover', properties: { class: 'wetland' },
        geometry: { type: 'MultiPolygon', coordinates: multi } },
      wantRings: 3,
    },
    {
      name: 'LineString(不是多邊形)',
      f: { layer: 'waterway', properties: { class: 'stream' },
        geometry: { type: 'LineString', coordinates: outerA } },
      wantRings: 0,
    },
    {
      name: 'Point(不是多邊形)',
      f: { layer: 'poi', properties: { class: 'tree' },
        geometry: { type: 'Point', coordinates: outerA[0] } },
      wantRings: 0,
    },
  ];

  for (const fx of FIXTURES) {
    const gv = extractPolygonCoords(fx.f as never);
    const bad: string[] = [];
    for (const w of WORLDS) {
      const dm = LU[w].luRings(fx.f);
      if (JSON.stringify(dm) !== JSON.stringify(gv)) bad.push(w);
    }
    check(`luRings ≡ extractPolygonCoords:${fx.name}`,
      bad.length === 0 && gv.length === fx.wantRings,
      bad.length ? `不一致的世界:${bad.join('/')}`
        : `${gv.length} 環 / ${gv.reduce((n, r) => n + r.length, 0)} 點`);
  }

  // 反向對照:洞真的被丟掉了 —— 上面那四條在「兩邊都把洞留下」時一樣會過。
  // 比的是**點數**:留了洞就會多 7 + 5 個點(Polygon)/ 每塊多 7 個點。
  const inPts = (rings: LonLatRing[][]): number =>
    rings.reduce((n, poly) => n + poly.reduce((m, r) => m + r.length, 0), 0);
  const p1 = extractPolygonCoords(FIXTURES[0].f as never);
  const p2 = extractPolygonCoords(FIXTURES[1].f as never);
  check('內環(洞)兩邊都真的丟掉了 —— 出來的點數比進去的少',
    inPts([[outerA, holeA1, holeA2]]) > p1.reduce((n, r) => n + r.length, 0)
    && inPts(multi) > p2.reduce((n, r) => n + r.length, 0),
    `Polygon ${inPts([[outerA, holeA1, holeA2]])} → ${p1.reduce((n, r) => n + r.length, 0)} 點 · `
    + `MultiPolygon ${inPts(multi)} → ${p2.reduce((n, r) => n + r.length, 0)} 點`);
  // …而留下來的就是**外**環,不是別的那一圈。
  check('留下來的是外環(第 0 圈),不是隨便一圈',
    JSON.stringify(p1[0]) === JSON.stringify(outerA)
    && p2.every((r, i) => JSON.stringify(r) === JSON.stringify(multi[i][0])));
}

// ── gameview 側:跑真的 buildLanduseMeshes,把出貨物件錄下來 ──────────────────

interface ShipRec {
  kind: string; centerX: number; centerZ: number; radius: number; slabY: number;
}
interface LampRec { x: number; y: number; z: number }

/**
 * 一份只實作 landuse-renderer 真的會呼叫的那幾支的假 strategy。
 *
 * 用假的而不是真的三個世界:環的重心與半徑**完全不經過 strategy**,而真的
 * strategy 會把 `buildLanduseProps` 的 ctx 吃掉(它回傳的是 Object3D,不是它拿到
 * 的參數)。要比出貨物件就得攔在那個介面上。
 */
function fakeStrategy(rec: ShipRec[], lamps: LampRec[]): {
  strategy: Parameters<typeof buildLanduseMeshes>[5];
  } {
  const mat = (): THREE.Material => new THREE.MeshBasicMaterial();
  const s = {
    params: { layerHeight: 6, quantEnabled: true },
    createWaterMaterial: mat, createWetlandMaterial: mat, createForestMaterial: mat,
    createParkMaterial: mat, createSportsFieldMaterial: mat, createPlaygroundMaterial: mat,
    createSandMaterial: mat, createFarmlandMaterial: mat, createZoneDecalMaterial: mat,
    zoneDecalColor: () => 0xffffff,
    buildLanduseProps: (ctx: ShipRec & { rng: () => number }) => {
      rec.push({
        kind: ctx.kind, centerX: ctx.centerX, centerZ: ctx.centerZ,
        radius: ctx.radius, slabY: ctx.slabY,
      });
      return null;
    },
    buildStreetLamp: () => {
      const group = new THREE.Group();
      const parts = {
        group,
        setNight: () => {},
        setLightEnabled: () => {},
        dispose: () => { lamps.push({ x: group.position.x, y: group.position.y, z: group.position.z }); },
      };
      return parts;
    },
  };
  return { strategy: s as unknown as Parameters<typeof buildLanduseMeshes>[5] };
}

/** 起伏的假 DEM:每個取樣點都不同,所以平板的「取一環最低」真的有東西可取。 */
const sampler = {
  getElevationSync: (lat: number, lon: number): number =>
    ORIGIN_ELE + 40 * Math.sin(lat * 900) + 25 * Math.cos(lon * 1300),
  getElevation: async (lat: number, lon: number): Promise<number> =>
    ORIGIN_ELE + 40 * Math.sin(lat * 900) + 25 * Math.cos(lon * 1300),
} as unknown as Parameters<typeof buildLanduseMeshes>[1];

type Hooks = Parameters<typeof buildLanduseMeshes>[7];

/**
 * 路線 = 通過原點的緯線(z = 0),而路點刻意**往東偏 37 m**。
 *
 * ⚠ **偏移不是裝飾,它是這一節唯一測得到 `lx` 的辦法。** 第一版讓路點正對重心
 *   (`{ x, z: 0 }`),於是 `dx = 0`,`lx = cx + (0/dl)·r` —— 那一行不管乘上什麼
 *   都吐同一個數。突變測試證明了它:demo 與 gameview 兩邊各把 `lx` 的 r 乘上
 *   0.8 / 0.9,**兩次都全綠**。偏開之後 dx 與 dz 都非零,兩行才都在測。
 *   (`plan/DEMO_POC_GUIDE.md` §6.3「某個分支只有閾值的一邊被跑到」那一族。)
 */
const ROUTE_DX = 37;
const HOOKS = {
  ground: (): number => 0,
  routePointNear: (x: number): { x: number; z: number } => ({ x: x + ROUTE_DX, z: 0 }),
};
/** demo 的 `luRouteAt` 回 null 的那一支:沒有路可以面對,燈站到 +z 邊上。 */
const HOOKS_NO_ROUTE = { ground: (): number => 0, routePointNear: (): null => null };

async function ship(features: unknown[], hooks: Hooks = HOOKS): Promise<{
  rec: ShipRec[]; lamps: LampRec[]; res: LanduseResult;
}> {
  const rec: ShipRec[] = [];
  const lamps: LampRec[] = [];
  const { strategy } = fakeStrategy(rec, lamps);
  const res = await buildLanduseMeshes(
    features as never, sampler, ORIGIN_LAT, ORIGIN_LON, ORIGIN_ELE, strategy, undefined, hooks,
  );
  // 燈的位置在 dispose 時錄(group 那時還沒被搬走),所以位置要先抄下來。
  for (const l of res.lamps) lamps.push({ x: l.group.position.x, y: l.group.position.y, z: l.group.position.z });
  return { rec, lamps, res };
}

// ── B. luRingInfo vs 出貨的 centerX / centerZ / radius ──────────────────────
//
// 兩條路徑寫得不一樣,所以「等價」要量:
//
//   demo    先投影每個頂點 → 取平均 → 逐頂點量最遠
//   gameview 先在**度**上取平均 → 投影那一個重心 → 逐頂點投影後量最遠
//
// 投影是仿射的(`(lon−originLon)·111320·cosLat`),所以「先平均再投影」與「先投影
// 再平均」在數學上同一件事,差的只有加總順序帶來的浮點尾數。**這一條就是在量那個
// 尾數有多小** —— 量不出來就不是等價,是巧合。
{
  const KINDS: [string, string, string][] = [
    ['farmland', 'landcover', 'farmland'],
    ['wetland', 'landcover', 'wetland'],
    ['sand', 'landcover', 'sand'],
    ['sports', 'landuse', 'pitch'],
    ['playground', 'landuse', 'playground'],
    // demo 的 luKindOf 不管這四格(它回 null),但 gameview 的環那一段對九格是
    // **同一段程式碼**,而 luRingInfo 也跟 kind 無關。一起量,寬度才夠。
    ['park', 'landcover', 'grass'],
    ['forest', 'landcover', 'wood'],
    ['water', 'water', 'lake'],
    ['urban', 'landuse', 'residential'],
  ];
  const rings = new Map<string, LonLatRing>();
  const feats = KINDS.map(([kind, layer, cls], i) => {
    const ring = lopsidedRing(
      ORIGIN_LON + 0.0021 * (i - 4), ORIGIN_LAT + 0.0004 * ((i % 3) - 1), 11 + i, 0.55 * i,
    );
    rings.set(kind, ring);
    return { layer, properties: { class: cls }, geometry: { type: 'Polygon', coordinates: [ring] } };
  });

  const { rec, res } = await ship(feats);
  check('九格地被各出貨一筆 patch(環那一段對九格是同一段程式碼)',
    rec.length === KINDS.length,
    `${rec.length} 筆:${rec.map((r) => r.kind).join('/')}`);

  let worstC = 0, worstR = 0;
  const bad: string[] = [];
  for (const w of WORLDS) {
    for (const [kind] of KINDS) {
      const got = rec.find((r) => r.kind === kind);
      const want = LU[w].luRingInfo(LU[w].toLocalRing(rings.get(kind)!));
      if (!got) { bad.push(`${kind}(沒出貨)`); continue; }
      const dc = Math.max(Math.abs(got.centerX - want.cx), Math.abs(got.centerZ - want.cz));
      const dr = Math.abs(got.radius - want.r);
      worstC = Math.max(worstC, dc);
      worstR = Math.max(worstR, dr);
      if (dc > 1e-6 || dr > 1e-6) {
        bad.push(`${w}/${kind} Δc=${dc.toExponential(2)} Δr=${dr.toExponential(2)}`);
      }
    }
  }
  check('luRingInfo ≡ 出貨的 centerX / centerZ / radius(三份 demo × 九格)',
    bad.length === 0,
    bad.length ? bad.slice(0, 4).join(' · ')
      : `最大重心差 ${worstC.toExponential(2)} m、最大半徑差 ${worstR.toExponential(2)} m`);

  // ── 反恆真句 1:這組環真的分得開四種寫法 ──
  //
  // 四個「另一種合理實作」的預測值必須跟出貨值**差得出來**,不然上面那條在它們
  // 身上也會過。四個都對應一個一行就能打進去的突變:
  //   ・外框中心(不是頂點平均)      —— 重心的定義換掉
  //   ・cx / cz 寫反                  —— 兩個投影軸交換
  //   ・半徑取**最近**而不是最遠      —— `Math.max` → `Math.min`
  //   ・半徑只量 x 方向               —— `Math.hypot(dx, dz)` → `Math.abs(dx)`
  //
  // ⚠ 第一版用的是「半徑取**最後一個**頂點的距離」,而它是恆真句:環是閉合的,
  //   末點就是首點,而首點在某些 phase 上剛好就是最遠的那個瓣 → 差 0.0 m。
  {
    const alt = KINDS.map(([kind]) => {
      const ring = LU.paper.toLocalRing(rings.get(kind)!);
      const xs = ring.map((p) => p[0]), zs = ring.map((p) => p[1]);
      const bbx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const bbz = (Math.min(...zs) + Math.max(...zs)) / 2;
      const got = rec.find((r) => r.kind === kind)!;
      const info = LU.paper.luRingInfo(ring);
      const ds = ring.map((p) => Math.hypot(p[0] - info.cx, p[1] - info.cz));
      const dxs = ring.map((p) => Math.abs(p[0] - info.cx));
      return {
        kind,
        dBox: Math.max(Math.abs(got.centerX - bbx), Math.abs(got.centerZ - bbz)),
        dSwap: Math.abs(got.centerX - info.cz) + Math.abs(got.centerZ - info.cx),
        dMin: Math.abs(got.radius - Math.min(...ds)),
        dAbsX: Math.abs(got.radius - Math.max(...dxs)),
      };
    });
    const minBox = Math.min(...alt.map((a) => a.dBox));
    const minSwap = Math.min(...alt.map((a) => a.dSwap));
    const minMin = Math.min(...alt.map((a) => a.dMin));
    const minAbsX = Math.min(...alt.map((a) => a.dAbsX));
    check('(這組環真的分得開四種「另一種合理寫法」—— 不然上一條是空的)',
      minBox > 1 && minSwap > 1 && minMin > 1 && minAbsX > 1,
      `外框中心差 ≥ ${minBox.toFixed(1)} m · cx/cz 對調差 ≥ ${minSwap.toFixed(1)} m · `
      + `半徑取最近差 ≥ ${minMin.toFixed(2)} m · 半徑只量 x 差 ≥ ${minAbsX.toFixed(2)} m`);
  }

  // ── 反恆真句 2:閉合的那個重複頂點真的把重心拉走了 ──
  //
  // 真實 MVT 的環首尾相同,兩邊的重心都吃這個偏差。它如果小到量不出來,上面那條
  // 就不能證明「兩邊對閉合環的處理一致」—— 只能證明「差在容差以內」。
  {
    let worst = 0;
    for (const [kind] of KINDS) {
      const closed = LU.paper.toLocalRing(rings.get(kind)!);
      const open = closed.slice(0, -1);
      const a = LU.paper.luRingInfo(closed), b = LU.paper.luRingInfo(open);
      worst = Math.max(worst, Math.hypot(a.cx - b.cx, a.cz - b.cz));
    }
    check('(閉合環那個重複頂點真的把重心拉走了 —— 兩邊吃的是同一個偏差)',
      worst > 1, `閉合 vs 不閉合的重心差 ${worst.toFixed(2)} m`);
  }

  // ── 那條刻意的分歧:slabY 是**板子自己的**高度,不是原始 DEM ──
  //
  // demo 給 LU_STYLE.props 的是 `geoGroundY(cx, cz)`(貼地),gameview 給的是
  // 平板的 y —— 這是 demo 自己註明「不要移植回去」的那一處。所以這裡不比 demo,
  // 只比 gameview 的自我一致:送出去的 slabY 必須就是那塊板子幾何裡的 y。
  {
    const bad2: string[] = [];
    for (const [kind] of KINDS) {
      const layer = res.layers.find((l) => l.kind === kind)!;
      const pos = layer.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const got = rec.find((r) => r.kind === kind)!;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < pos.count; i++) { lo = Math.min(lo, pos.getY(i)); hi = Math.max(hi, pos.getY(i)); }
      if (!(Math.abs(lo - hi) < 1e-3 && Math.abs(lo - got.slabY) < 1e-3)) {
        bad2.push(`${kind} slabY ${got.slabY.toFixed(3)} vs 板子 ${lo.toFixed(3)}…${hi.toFixed(3)}`);
      }
    }
    check('出貨的 slabY 就是那塊板子幾何裡的 y(道具站在板子上,不是站在 DEM 上)',
      bad2.length === 0, bad2.length ? bad2.slice(0, 3).join(' · ') : `${KINDS.length} 格都對齊`);
    // 而且這組測資真的有高低差 —— 假 DEM 平掉的話上面那條是空的。
    const ys = rec.map((r) => r.slabY);
    check('(這組測資的板子真的落在不同高度 —— 不然上一條是空的)',
      Math.max(...ys) - Math.min(...ys) > 1,
      `slabY 落差 ${(Math.max(...ys) - Math.min(...ys)).toFixed(1)} m`);
  }

  // ── 投影那條橋是對的:gameview 自己投影出來的環 = demo 的 geoToLocal ──
  //
  // 上面拿 demo 的 `geoToLocal` 當橋把經緯度環換成公尺環。橋歪了的話 cx/cz 會一起
  // 歪,而斷言只會說「不等價」。所以直接比 gameview **自己**投影的結果:板子幾何裡
  // 的 (x, z) 就是它投影出來的環(ShapeGeometry 會丟掉閉合那個重複點,而繞向由
  // earcut 正規化,所以比的是**點集**不是順序)。
  {
    const key = (x: number, z: number): string => `${x.toFixed(3)},${z.toFixed(3)}`;
    const bad3: string[] = [];
    for (const [kind] of KINDS) {
      const layer = res.layers.find((l) => l.kind === kind)!;
      const pos = layer.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const gvSet = new Set<string>();
      for (let i = 0; i < pos.count; i++) gvSet.add(key(pos.getX(i), pos.getZ(i)));
      const want = new Set(
        LU.paper.toLocalRing(rings.get(kind)!).slice(0, -1).map((p) => key(p[0], p[1])),
      );
      const miss = [...want].filter((k) => !gvSet.has(k));
      if (miss.length || gvSet.size !== want.size) {
        bad3.push(`${kind} 少 ${miss.length} 點(${gvSet.size} vs ${want.size})`);
      }
    }
    check('gameview 自己投影出來的環 = demo 的 geoToLocal(那條橋沒歪)',
      bad3.length === 0, bad3.length ? bad3.slice(0, 3).join(' · ') : `${KINDS.length} 格點集相同`);
  }

  disposeLanduseMeshes(res);
}

// ── C. MultiPolygon:一環一筆,而且各自算自己的重心 ──────────────────────────
//
// demo 的 `luPatches` 是 `for (const lonlat of luRings(f))` 再逐環 `luRingInfo`。
// 一個「先把所有環併起來再算一次」的實作會少送兩筆、而且重心落在三塊地中間 ——
// 那個中心點在三塊地的**任何一塊裡面都不在**,所以蘆葦會長在水面外。
{
  const centres: [number, number][] = [
    [ORIGIN_LON - 0.006, ORIGIN_LAT + 0.0012],
    [ORIGIN_LON + 0.001, ORIGIN_LAT - 0.0009],
    [ORIGIN_LON + 0.007, ORIGIN_LAT + 0.0015],
  ];
  const outers = centres.map(([lon, lat], i) => lopsidedRing(lon, lat, 8 + i * 3, 2.0 * i));
  const feat = {
    layer: 'landcover', properties: { class: 'wetland' },
    geometry: {
      type: 'MultiPolygon',
      coordinates: outers.map((o, i) => [o, lopsidedRing(centres[i][0], centres[i][1], 6, 1.0).map(
        (p) => [centres[i][0] + (p[0] - centres[i][0]) * 0.2, centres[i][1] + (p[1] - centres[i][1]) * 0.2],
      )]),
    },
  };
  const { rec, res } = await ship([feat]);
  const want = outers.map((o) => LU.paper.luRingInfo(LU.paper.toLocalRing(o)));
  const ok = rec.length === 3 && want.every((wv, i) =>
    Math.abs(rec[i].centerX - wv.cx) < 1e-6
    && Math.abs(rec[i].centerZ - wv.cz) < 1e-6
    && Math.abs(rec[i].radius - wv.r) < 1e-6);
  check('MultiPolygon 的每個外環各出貨一筆,重心/半徑各算自己的',
    ok, `${rec.length} 筆 · r = ${rec.map((r) => r.radius.toFixed(1)).join(' / ')} m`);
  // 反恆真句:「三環併成一筆」的預測值真的不一樣 —— 三塊地離得夠遠。
  {
    const all = LU.paper.toLocalRing(outers.flat() as LonLatRing);
    const merged = LU.paper.luRingInfo(all);
    const far = Math.min(...rec.map((r) => Math.hypot(r.centerX - merged.cx, r.centerZ - merged.cz)));
    check('(三環併成一筆的重心離每一塊都很遠 —— 不然上一條是空的)',
      far > 50 && merged.r > Math.max(...rec.map((r) => r.radius)) * 2,
      `併起來的重心離最近的一塊 ${far.toFixed(0)} m、半徑 ${merged.r.toFixed(0)} m vs `
      + `最大單環 ${Math.max(...rec.map((r) => r.radius)).toFixed(0)} m`);
  }
  disposeLanduseMeshes(res);
}

// ── D. 燈站的位置吃的是 luRingInfo 的 r ─────────────────────────────────────
//
// demo 的那段(`buildLanduse` 尾巴)**切出來執行**,把 `LU_STYLE.lamp` 收到的
// cx / cz 拿去比 gameview 那盞燈的 `group.position`。這一條是 `luRingInfo.r` 的
// 第三個消費點,而且它把 r 變成一個**看得見的位置** —— 上面 B 比的是介面上的數字,
// 這一條比的是出貨物件。
//
// 這裡不比 y(demo 走 `geoGroundY`,gameview 走 `hooks.ground` —— 那是同一個
// 東西的兩個殼)也不比 id(seed 那條分歧是 `props-vs-demo.ts` 的事)。
{
  /** demo 的 `buildLanduse` 切出來跑,只留下它擺的那盞燈。`route === null` 走它自己的 p === null 那一支。 */
  const demoLamp = (
    w: World, kind: string, ring: Ring, route: { x: number; z: number } | null,
  ): LampRec => {
    const out: LampRec[] = [];
    const src = SRC[w];
    const run = new Function('dep', `
      const { THREE, LU_STYLE, luPatches, luSlab, geoGroundY, luRouteAt, pathAt, mulberry32 } = dep;
      ${sliceStmt(src, '  const LU_RANK = {')}
      ${sliceFn(src, 'luRingInfo')}
      ${sliceFn(src, 'buildLanduse')}
      return buildLanduse;
    `) as (dep: unknown) => (
      g: unknown, d: unknown[], i: number, a: number, b: number, bulbs: unknown,
    ) => number;
    const build = run({
      THREE,
      LU_STYLE: {
        material: () => new THREE.MeshBasicMaterial(),
        props: () => {},
        lamp: (o: { cx: number; cz: number; y: number }) => out.push({ x: o.cx, y: o.y, z: o.cz }),
      },
      luPatches: () => [{ kind, ring }],
      luSlab: () => new THREE.BufferGeometry(),
      geoGroundY: () => 0,
      luRouteAt: () => (route ? { d: 0, lat: 0 } : null),
      pathAt: () => route,
      mulberry32: () => () => 0.5,
    });
    build(new THREE.Group(), [], 0, 0, 1000, []);
    if (out.length !== 1) throw new Error(`demo buildLanduse 擺了 ${out.length} 盞燈`);
    return out[0];
  };

  const bad: string[] = [];
  let worst = 0;
  let guard = '';
  for (const kind of ['sports', 'playground']) {
    const [layer, cls] = kind === 'sports' ? ['landuse', 'pitch'] : ['landuse', 'playground'];
    // 半徑約 19 m,而燈的走廊是 65 + r —— 這塊地貼著路線,兩邊都會給它一盞。
    const ring = lopsidedRing(ORIGIN_LON + 0.0013, ORIGIN_LAT + 0.00018, 12, 3.3);
    const feat = {
      layer, properties: { class: cls }, geometry: { type: 'Polygon', coordinates: [ring] },
    };
    const info = LU.paper.luRingInfo(LU.paper.toLocalRing(ring));

    // 兩種路線狀態:偏在一旁的路(dx、dz 都非零)與**沒有路**(demo 的 p === null)。
    const CASES: [string, { x: number; z: number } | null, Hooks][] = [
      ['有路(偏一旁)', { x: info.cx + ROUTE_DX, z: 0 }, HOOKS],
      ['沒有路可以面對', null, HOOKS_NO_ROUTE],
    ];
    for (const [how, route, hooks] of CASES) {
      const { lamps, res } = await ship([feat], hooks);
      if (lamps.length !== 1) {
        bad.push(`${kind}/${how}: gameview 擺了 ${lamps.length} 盞`);
        disposeLanduseMeshes(res);
        continue;
      }
      for (const w of WORLDS) {
        const want = demoLamp(w, kind, LU[w].toLocalRing(ring), route);
        const d = Math.max(Math.abs(lamps[0].x - want.x), Math.abs(lamps[0].z - want.z));
        worst = Math.max(worst, d);
        if (d > 1e-6) bad.push(`${w}/${kind}/${how} Δ=${d.toExponential(2)} m`);
      }
      // 反恆真句 1:燈真的被 r 推出去了 —— 不然「站在重心上」也會過。
      const push = Math.hypot(lamps[0].x - info.cx, lamps[0].z - info.cz);
      check(`${kind}(${how}): 燈被 luRingInfo 的 r 推到邊上,一步不差`,
        Math.abs(push - info.r) < 1e-6 && info.r > 5,
        `離重心 ${push.toFixed(3)} m,r = ${info.r.toFixed(3)} m`);
      // 反恆真句 2:**兩個軸都真的在被測**。
      //
      // ⚠ 這一條是突變測試逼出來的。第一版讓路點正對重心,`dx` 恆為 0,於是
      //   `lx = cx + (dx/dl)·r` 這一行不管乘上什麼都吐同一個數 —— demo 與 gameview
      //   兩邊各把它的 r 乘上 0.8 / 0.9,**兩次都全綠**。所以現在明文量:燈相對
      //   重心的位移在 x 與 z 上都要離 0 遠。
      if (route) {
        const ox = Math.abs(lamps[0].x - info.cx), oz = Math.abs(lamps[0].z - info.cz);
        guard = `Δx ${ox.toFixed(2)} m / Δz ${oz.toFixed(2)} m`;
        check(`${kind}(${how}): (燈的位移在 x 與 z 上都非零 —— 不然有一行是測不到的)`,
          ox > 1 && oz > 1, guard);
      }
      disposeLanduseMeshes(res);
    }
  }
  check('demo 的 buildLanduse 擺的燈位 ≡ gameview 那盞燈的位置(三份 demo × 兩格 × 有路/沒路)',
    bad.length === 0,
    bad.length ? bad.slice(0, 4).join(' · ') : `最大差 ${worst.toExponential(2)} m(${guard})`);
}

// ── E. luKindOf vs gameview 九列 spec 的**執行結果** ────────────────────────
//
// `props-vs-demo.ts` 已經比過這一格,但它是拿 regex 去 `landuse-renderer.ts` 的
// 述詞函式體裡撈 `'…'` 字串 —— 讀的是原始碼。這一條改成**跑真的
// `buildLanduseMeshes`**:餵一塊多邊形進去,看哪一格的 layer 真的收到它。
//
// 兩個方向都要:demo 說是哪一格,gameview 就得放進哪一格;demo 說 null(不歸它管
// 的四格 + 兩邊都不畫的),gameview 就**不准**把它放進那五格裡的任何一格。
{
  const FIVE = new Set(['farmland', 'wetland', 'sand', 'sports', 'playground']);
  // 詞彙表是**測資**,不是抄過來的常數:兩邊認得的、只有一邊認得的、兩邊都不認得的
  // 都要在裡面,不然「反向對照」那一半是空的。
  const VOCAB: [string, string][] = [
    ['landcover', 'farmland'], ['landcover', 'plant_nursery'], ['landcover', 'wetland'],
    ['landcover', 'sand'], ['landcover', 'grass'], ['landcover', 'park'],
    ['landcover', 'wood'], ['landcover', 'forest'], ['landcover', 'rock'],
    ['landcover', 'bare_rock'], ['landcover', 'ice'],
    ['landuse', 'pitch'], ['landuse', 'track'], ['landuse', 'stadium'],
    ['landuse', 'playground'], ['landuse', 'residential'], ['landuse', 'commercial'],
    ['landuse', 'industrial'], ['landuse', 'retail'], ['landuse', 'school'],
    ['landuse', 'hospital'], ['landuse', 'cemetery'], ['landuse', 'quarry'],
    ['water', 'lake'], ['water', 'pond'], ['water', 'swimming_pool'],
    ['park', 'national_park'], ['waterway', 'stream'],
  ];
  const ring = lopsidedRing(ORIGIN_LON, ORIGIN_LAT, 10, 1.9);
  const bad: string[] = [];
  let agreedFive = 0, agreedNull = 0;
  for (const [layer, cls] of VOCAB) {
    const f = { layer, properties: { class: cls }, geometry: { type: 'Polygon', coordinates: [ring] } };
    const { rec, res } = await ship([f]);
    const gvKinds = rec.map((r) => r.kind);
    disposeLanduseMeshes(res);
    const answers = new Set(WORLDS.map((w) => LU[w].luKindOf(f)));
    if (answers.size !== 1) { bad.push(`${layer}/${cls}: 三份 demo 不同調`); continue; }
    const demo = [...answers][0];
    if (demo === null) {
      const hit = gvKinds.filter((k) => FIVE.has(k));
      if (hit.length) bad.push(`${layer}/${cls}: demo null 而 gameview → ${hit.join('+')}`);
      else agreedNull++;
    } else if (gvKinds.length !== 1 || gvKinds[0] !== demo) {
      bad.push(`${layer}/${cls}: demo ${demo} vs gameview ${gvKinds.join('+') || '(沒人收)'}`);
    } else agreedFive++;
  }
  check('luKindOf ≡ gameview 九列 spec 跑出來的分派(兩個方向)',
    bad.length === 0 && agreedFive >= 8 && agreedNull >= 10,
    bad.length ? bad.slice(0, 4).join(' · ')
      : `${agreedFive} 個 class 落在 demo 說的那一格、${agreedNull} 個 demo 不認 gameview 也沒放進那五格`);
  // 反恆真句:這張詞彙表真的有東西**落進**那五格,也真的有東西落在別的格。
  {
    let five = 0, other = 0, none = 0;
    for (const [layer, cls] of VOCAB) {
      const f = { layer, properties: { class: cls }, geometry: { type: 'Polygon', coordinates: [ring] } };
      const { rec, res } = await ship([f]);
      const k = rec.map((r) => r.kind);
      disposeLanduseMeshes(res);
      if (k.some((x) => FIVE.has(x))) five++;
      else if (k.length) other++;
      else none++;
    }
    check('(這張詞彙表三種結果都有 —— 五格 / 別的格 / 沒人收)',
      five >= 8 && other >= 6 && none >= 3, `五格 ${five} · 別的格 ${other} · 沒人收 ${none}`);
  }
}
