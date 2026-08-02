/**
 * 穿模量測探針 —— **不是檢查**,故意沒有註冊進 `STANDALONE_CHECKS`。
 *
 * 使用者實騎回報:「當單車撞到裙邊之後,應該就要自動爬升到裙邊的平面部分,這樣
 * 最簡單,目前的處理方式在山頂還是非常容易穿模」。這支探針的工作是**先量再修**
 * ——在動任何一行修法之前,把「山頂到底穿多少、是哪一種穿」量出來。
 *
 * 量的方式跟 `dazhi-repro.ts` 同一路:抓**真的** terrarium DEM 與 OpenFreeMap
 * MVT(執行時抓、用完就丟,一格都不落地),用**真的** `buildTerrainChunk` 蓋出
 * 山頂那三個 chunk,再用**真的** `sampleChunkHeight` 沿路線推騎士 —— 也就是
 * `TerrainChunkManager.raycastGroundHeight` 的那條路徑,連 `wantHighest`、連
 * grid 沒中就退回 raycast 都照抄。
 *
 * ## 為什麼要有一個獨立的「地表真相」
 *
 * 拿高度網格去驗高度網格等於沒有驗。所以這支自己在**建好的 mesh 三角形**上蓋了
 * 一份 xz 桶索引(`buildSurfaceIndex`),回答「(x, z) 上畫出來的面有哪幾層」。
 * 騎士的 y 是網格給的,穿模與否是 mesh 給的,兩邊互不相欠。
 *
 * ## 兩種分類(使用者的修法只蓋得到第一種)
 *
 *  (a) **一幀跨過一整階** —— 前後兩幀的騎士高度差 ≥ 一個 layerHeight。踏面是整格
 *      平的,所以這件事只會發生在格子邊界上;車頭(1.6 m)在越界前就已經插進下
 *      一格的豎邊裡了。使用者提的「撞到裙邊就爬上踏面」治的正是這一種。
 *  (b) **grid 查不到,退回 raycast / DEM** —— 那時候連踏面在哪都不知道,「爬上
 *      踏面」無從爬起。
 *
 * ## 2026-07-29 上午量到的結論(第一輪)
 *
 *  · (b) 幾乎不存在:騎士的地面查詢 0.00–0.30% 走退路,視線取樣 0.00–0.35%。
 *    騎士永遠在走廊中線上,走廊半寬 500 m,所以格子永遠蓋得到他。
 *  · (a) 存在而且**沒有因為 c9f81d5 變好,反而變壞 10 倍**:paper 山頂那個 chunk,
 *    階高 12 m 時車體插進地表 0.30%(29 幀 / 2 km),階高 3.2 m 時 3.22%(309 幀)。
 *  · 而且穿的深度遠大於一階:畫出來的地面比同一點的 DEM 平均高 8.94 m(最多 22.9 m)。
 *
 * ## 2026-07-29 下午:那 8.94 m 拆完之後,前一輪的推論是**錯的**
 *
 * 前一輪把 8.94 m 記在 `pickCell(wantHighest)` 頭上。這支加了拆帳(`attPickOverDem`
 * / `attNearOverDem`)之後量到的是:
 *
 *  · **`wantHighest` 只值 0.02 m。** 把它換成「挑最接近騎士當前高度的那一格」,
 *    答案逐格相同 —— 因為外層 `raycastGroundHeight` 已經在 chunk 之間做過同一件事。
 *  · 真正的來源是**走廊本身**:它是一條偏移緞帶,而偏移緞帶只在路線的曲率半徑
 *    以內是一對一的。走廊半寬 500 m、山路的曲率半徑 30–200 m,所以騎士腳下平均
 *    疊了 9.19 格(最多 24),其中 43.1% 是**翻面**的,彼此差 35.6 m(最多 92.8),
 *    而格子的 xz 對角平均 218 m —— 名目 gridSize 是 32 m。騎士騎的是那疊面的
 *    **上緣**,所以階高調成多少都沒有用。
 *  · 第二個獨立來源是中心欄的 `DEM×0.5 + GPX×0.5`:這條路線的 DEM 讀的是林冠,
 *    比 GPX 高 45.7 m,所以那個混合在**只有一欄寬**的地方挖了一條 10 m 深的溝,
 *    而騎士正好騎在溝裡。
 *
 * 修法(`terrain-chunk.ts` 的 `buildMedialAxisMask` + 斷面改照距離擺 + 拿掉中心欄
 * 的混合)之後,台北山頂 chunk、下坡 45 km/h、paper:
 *
 *      覆蓋層數 9.19 → 2.5 格;層間全距 35.6 → 4.8 m;
 *      畫出來的地面 − DEM 8.94 → 1.6 m;最大單幀落差 19.2 → 6.4 m;
 *      騎士頭上還有一片面 33.2% → 25%(最高 32.0 → 9.6 m)
 *
 * ## 2026-07-29 傍晚:路壓在兩格的共用邊上 —— 修掉了,但那個「一比一」是假的
 *
 * 走廊的中心**欄**就是路,所以路正好壓在兩格的**共用邊**上,左右各屬於一格,而
 * 那兩格的踏面各自是「路 ± 半格橫坡」的平均。這件事是真的,而且它是山路上穿模的
 * 主因。**但前一輪寫在這裡的「一比一」是分母湊出來的**:
 *
 *  · 車道落差的平均分母是**全部的幀**,插入深度的平均分母只有**穿模的那幾幀**
 *    (台北 4.58%)。兩個不同分母的平均擺在一起,看起來當然像一比一。
 *  · 逐幀配對之後(這支現在會印 `跟插入深度的逐幀相關`),Pearson r 只有
 *    0.11(paper 台北)到 0.66(plastic Alpe d'Huez 最陡段),而且分桶之後
 *    台北 paper 那條完全不單調:0–1 階 0.10 m、1–2 階 0.35 m、2–3 階 0.23 m。
 *  · 而且重量的時候台北那一列(2.52 / 4.36)重現得出來,另外兩列重現不出來
 *    (Alpe d'Huez 量到 7.18 / 20.84,Amalfi 21.97 / 25.80)。
 *
 * 真正成立的是**機制**,而拆成兩台一維的車就看得見(`latClip*` / `lonClip*`):
 *
 *      路線          車道落差   只有寬度的車穿模   只有長度的車穿模
 *      台北山頂       2.52 m        1.23 %             2.53 %
 *      Alpe d'Huez    7.18 m       50.90 %             4.48 %
 *      Amalfi 海崖   21.97 m       26.15 %             5.47 %
 *
 * 山路上「只有寬度」那台車就是全部 —— 那是橫向落差,不是沿路的台階。
 *
 * 修法:`crossCount` 從**奇數**(原註解:「keep a center column for the GPX
 * blend」,而那個 blend 上一輪已經拿掉)改成**偶數**,路因此落在一格的正中央,
 * 踏面是四個角的平均,橫坡在格內相消。`centerCol` 的下游全部改走
 * `corridorCentreColumns`(斷面中心線、走廊半寬、`datum`、中軸遮罩那條保證)。
 * 修完:
 *
 *      路線          車道落差            只有寬度的車穿模      整台車穿模
 *      台北山頂       2.52 → 1.43 m       1.23 → 0.24 %        4.58 → 2.39 %
 *      Alpe d'Huez    7.18 → 0.51 m      50.90 → 0.04 %       55.34 → 3.79 %
 *      Amalfi 海崖   21.97 → 0.10 m      26.15 → 0.07 %       31.14 → 4.02 %
 *
 * (以上都是 paper、下坡 45 km/h;另外兩個世界同量級。)剩下的殘量幾乎全是沿路
 * 的台階,那是 `climbOntoTread` 的守備範圍 —— 它因此從「值 18–24 %」變成
 * 「值 14–98 %」,見 `packages/web/src/game/terrain/climb-onto-tread.ts`。
 *
 * 跑法:
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/clip-probe.ts
 *
 * 環境變數:
 *   ROUTE=<path>    路線 JSON(預設 data/routes/morning-ride-20260313215539.json)
 *   STYLES=a,b,c    要跑的世界(預設 paper,plastic,circuit)
 *   LAYER=<m>       蓋掉 layerHeight —— 拿來跑 c9f81d5 之前的對照組(paper 12)
 *   SPEED=<km/h>    模擬速度(預設 45,下坡;會另外再跑一趟 12 的爬坡)
 *   CHUNK=<i>       指定中央 chunk(預設:海拔最高點所在的那個)
 *   CLIMB=1         打開「撞到裙邊就爬上踏面」,量修法的前後差
 *   CLIMB_LIMIT=<n> 爬升上限(幾個階高,預設 1.5)
 *   LOC=<key>       改用 demo 控制列的真實地點建路線(taipei / alpedhuez /
 *                   ventoux / afsluitdijk / amalfi),規則照抄 demo 的
 *                   `geoBuildRoute`;高程直接取 DEM,所以那種路線的
 *                   「DEM − GPX」恆為 0,可以把資料源的偏差跟走廊折疊分開量
 *   DUMP=<km>       在那個里程的第一幀,把覆蓋騎士那一點的每一格列出來
 *   DUMPOVER=<m>    改成在「挑到的格子比 DEM 高過這麼多」的第一幀 dump
 */

import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

// ── Canvas stub (same as dazhi-repro.ts / diorama.ts) ──
function stubContext() {
  const gradient = { addColorStop: () => {} };
  return new Proxy(
    {
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      putImageData: () => {},
      createRadialGradient: () => gradient,
      createLinearGradient: () => gradient,
      measureText: () => ({ width: 0 }),
    } as Record<string, unknown>,
    {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        return typeof prop === 'string' && /^[a-z]/.test(prop) ? () => {} : undefined;
      },
      set() {
        return true;
      },
    },
  );
}
(globalThis as any).document = {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
    return { width: 0, height: 0, getContext: () => stubContext() };
  },
};
(globalThis as any).window = { devicePixelRatio: 1 };

const { createTerrainStyleStrategy } = await import('@/game/terrain/terrain-style-strategy');
const { buildTerrainChunk, sampleChunkHeight } = await import('@/game/terrain/terrain-chunk');
const { decodeMVTTile } = await import('@/game/terrain/mvt-fetcher');
const { buildCumulativeDistances } = await import('@/game/route-geometry');
const { isUrbanLanduse, extractPolygonCoords } = await import('@/game/terrain/landuse-renderer');
const { CHUNK_LENGTH } = await import('@/game/terrain/terrain-chunk-manager');
const { requiredLift, SIGHTLINE_SAMPLES } = await import('@/game/terrain/camera-collision');
const { CHASE_LOOK_HEIGHT } = await import('@/game/terrain/fps-camera');

type TerrainStyle = 'paper' | 'plastic' | 'circuit';

// ── 真實 DEM(terrarium PNG 手解;瀏覽器那條 Image 路在 Node 下不存在)──
type DemTile = { ele: (px: number, py: number) => number };
async function fetchDem(z: number, x: number, y: number): Promise<DemTile> {
  const buf = Buffer.from(
    await (
      await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`)
    ).arrayBuffer(),
  );
  let pos = 8;
  let w = 0, h = 0, ch = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ch = data[9] === 6 ? 4 : 3; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let yr = 0; yr < h; yr++) {
    const f = raw[rp++];
    const row = yr * stride, prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const rb = raw[rp + i];
      const a = i >= ch ? out[row + i - ch] : 0;
      const b = yr > 0 ? out[prev + i] : 0;
      const c = yr > 0 && i >= ch ? out[prev + i - ch] : 0;
      let v: number;
      switch (f) {
        case 0: v = rb; break;
        case 1: v = rb + a; break;
        case 2: v = rb + b; break;
        case 3: v = rb + ((a + b) >> 1); break;
        default: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = rb + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
      }
      out[row + i] = v & 0xff;
    }
    rp += stride;
  }
  return {
    ele: (px, py) => {
      const o = Math.min(h - 1, Math.max(0, py)) * stride + Math.min(w - 1, Math.max(0, px)) * ch;
      return out[o] * 256 + out[o + 1] + out[o + 2] / 256 - 32768;
    },
  };
}

const Z = 14;
const n2 = 2 ** Z;
const demTiles = new Map<string, DemTile>();
function tileXY(lat: number, lon: number): { x: number; y: number; fx: number; fy: number } {
  const xf = ((lon + 180) / 360) * n2;
  const latRad = (lat * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n2;
  return { x: Math.floor(xf), y: Math.floor(yf), fx: xf, fy: yf };
}
function demSyncAt(lat: number, lon: number): number | null {
  const { x, y, fx, fy } = tileXY(lat, lon);
  const tile = demTiles.get(`${x}/${y}`);
  if (!tile) return null;
  return tile.ele(Math.round((fx - x) * 255), Math.round((fy - y) * 255));
}

const sampler = {
  correction: null as null | ((lat: number, lon: number, ele: number) => number),
  async getElevation(lat: number, lon: number): Promise<number> {
    return this.getElevationSync(lat, lon) ?? 0;
  },
  getElevationSync(lat: number, lon: number): number | null {
    const ele = demSyncAt(lat, lon);
    if (ele === null) return null;
    return this.correction ? this.correction(lat, lon, ele) : ele;
  },
  async prefetchBounds(_b: unknown): Promise<void> {},
};

// ── 路線 ──
//
// 兩種來源:
//  · 預設 —— 真的騎乘紀錄(GPX 的 ele 是氣壓計/GPS 記下來的)
//  · `LOC=<key>` —— demo 控制列的那五個真實地點(`plan/*-demo.html` 的 `GEO_PLACES`)。
//    路線是**從真的 MVT 拉出來的**:由高到低找第一條拉得出 ≥1.5 km 連續鏈的道路
//    等級,跟 demo 的 `geoBuildRoute` 同一套規則。高程直接取 DEM,所以這種路線的
//    「DEM − GPX」恆為 0 —— 拿來把資料源的偏差跟走廊折疊分開量,正好。
const GEO_PLACES: Record<string, { label: string; lat: number; lon: number }> = {
  taipei: { label: '台北・松山–大直', lat: 25.0680, lon: 121.5500 },
  alpedhuez: { label: "Alpe d'Huez(法)", lat: 45.0750, lon: 6.0550 },
  ventoux: { label: 'Mont Ventoux(法)', lat: 44.1620, lon: 5.2700 },
  afsluitdijk: { label: 'Afsluitdijk(荷)', lat: 52.9900, lon: 5.1400 },
  amalfi: { label: 'Amalfi SS163(義)', lat: 40.6340, lon: 14.6030 },
};
const GEO_ROAD_RANK = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor'];
const GEO_MIN_CHAIN = 1500;
const GEO_RING = 1;        // 圖資 3×3
const GEO_DEM_RING = 2;    // 高程 5×5(feature 會超出自己那張磚,見 demo 的註解)
const GEO_STEP = 10;       // 重新取樣的間距

const LOC = process.env.LOC ?? null;
const ROUTE = process.env.ROUTE ?? 'data/routes/morning-ride-20260313215539.json';

/** 已抓過的 MVT 圖磚(LOC 與後面的走廊窗口共用,不重抓)。 */
const mvtCache = new Map<string, any[]>();
let tilejsonTpl: string | null = null;
async function mvtTile(x: number, y: number): Promise<any[]> {
  const key = `${x}/${y}`;
  const hit = mvtCache.get(key);
  if (hit) return hit;
  if (tilejsonTpl === null) {
    tilejsonTpl = (await (await fetch('https://tiles.openfreemap.org/planet')).json()).tiles[0];
  }
  const buf = await (
    await fetch(tilejsonTpl!.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y)))
  ).arrayBuffer();
  const feats = decodeMVTTile(buf, x, y, Z);
  mvtCache.set(key, feats);
  return feats;
}
async function ensureDem(x: number, y: number): Promise<void> {
  const key = `${x}/${y}`;
  if (demTiles.has(key)) return;
  demTiles.set(key, await fetchDem(Z, x, y));
}

async function buildRouteFromLoc(key: string): Promise<{ lat: number; lon: number; ele: number }[]> {
  const place = GEO_PLACES[key];
  if (!place) throw new Error(`unknown LOC=${key} (${Object.keys(GEO_PLACES).join(', ')})`);
  const c = tileXY(place.lat, place.lon);
  const demJobs: Promise<void>[] = [];
  for (let dx = -GEO_DEM_RING; dx <= GEO_DEM_RING; dx++) {
    for (let dy = -GEO_DEM_RING; dy <= GEO_DEM_RING; dy++) demJobs.push(ensureDem(c.x + dx, c.y + dy));
  }
  await Promise.all(demJobs);
  const feats: any[] = [];
  for (let dx = -GEO_RING; dx <= GEO_RING; dx++) {
    for (let dy = -GEO_RING; dy <= GEO_RING; dy++) feats.push(...await mvtTile(c.x + dx, c.y + dy));
  }
  // demo 的 geoChains:逐磚裁切的線段用端點座標接回去(1e-5 度 ≈ 1.1 m)。
  const chains = (cls: string): { pts: [number, number][]; m: number }[] => {
    const segs: [number, number][][] = [];
    for (const f of feats) {
      if (f.layer !== 'transportation' || f.properties.class !== cls) continue;
      const g = f.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates]
        : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const co of lines) if (co && co.length >= 2) segs.push(co);
    }
    const k = (p: [number, number]): string => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
    const adj = new Map<string, { s: [number, number][]; rev: boolean }[]>();
    const push = (kk: string, s: [number, number][], rev: boolean): void => {
      if (!adj.has(kk)) adj.set(kk, []);
      adj.get(kk)!.push({ s, rev });
    };
    for (const s of segs) { push(k(s[0]), s, false); push(k(s[s.length - 1]), s, true); }
    const metres = (co: [number, number][]): number => {
      let t = 0;
      for (let i = 0; i < co.length - 1; i++) {
        const cl = Math.cos((co[i][1] * Math.PI) / 180);
        t += Math.hypot((co[i + 1][0] - co[i][0]) * 111320 * cl, (co[i + 1][1] - co[i][1]) * 111320);
      }
      return t;
    };
    const used = new Set<[number, number][]>();
    const out: { pts: [number, number][]; m: number }[] = [];
    for (const s of segs) {
      if (used.has(s)) continue;
      used.add(s);
      let ch = s.slice();
      for (let g = 0; g < 9999; g++) {
        const e = (adj.get(k(ch[ch.length - 1])) ?? []).find((v) => !used.has(v.s));
        if (!e) break;
        used.add(e.s);
        ch = ch.concat((e.rev ? e.s.slice().reverse() : e.s).slice(1));
      }
      for (let g = 0; g < 9999; g++) {
        const e = (adj.get(k(ch[0])) ?? []).find((v) => !used.has(v.s));
        if (!e) break;
        used.add(e.s);
        const cc = e.rev ? e.s : e.s.slice().reverse();
        ch = cc.slice(0, -1).concat(ch);
      }
      out.push({ pts: ch, m: metres(ch) });
    }
    out.sort((a, b) => b.m - a.m);
    return out;
  };
  let picked: { cls: string; chain: { pts: [number, number][]; m: number } } | null = null;
  for (const cls of GEO_ROAD_RANK) {
    const ch = chains(cls);
    if (ch.length && ch[0].m >= GEO_MIN_CHAIN) { picked = { cls, chain: ch[0] }; break; }
  }
  if (!picked) {
    for (const cls of GEO_ROAD_RANK) {
      const ch = chains(cls);
      if (ch.length && (!picked || ch[0].m > picked.chain.m)) picked = { cls, chain: ch[0] };
    }
  }
  if (!picked) throw new Error(`${key}: 這個窗口裡一條可騎的路都沒有`);
  // demo 的 geoTrimToDem:留下最長一段查得到高程的連續子鏈。
  const raw = picked.chain.pts;
  let bestA = 0, bestN = 0, a0 = -1;
  for (let i = 0; i <= raw.length; i++) {
    const ok = i < raw.length && demSyncAt(raw[i][1], raw[i][0]) !== null;
    if (ok) { if (a0 < 0) a0 = i; } else if (a0 >= 0) {
      if (i - a0 > bestN) { bestN = i - a0; bestA = a0; }
      a0 = -1;
    }
  }
  const trimmed = raw.slice(bestA, bestA + bestN);
  if (trimmed.length < 2) throw new Error(`${key}: 挑中的路線整條都在高程覆蓋範圍外`);
  // 每 GEO_STEP 一個點重新取樣,ele 取 DEM。
  const cl = Math.cos((place.lat * Math.PI) / 180);
  const cum: number[] = [0];
  for (let i = 1; i < trimmed.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(
      (trimmed[i][0] - trimmed[i - 1][0]) * 111320 * cl,
      (trimmed[i][1] - trimmed[i - 1][1]) * 111320,
    ));
  }
  const total = cum[cum.length - 1];
  const out: { lat: number; lon: number; ele: number }[] = [];
  let seg = 0;
  for (let d = 0; d <= total; d += GEO_STEP) {
    while (seg < cum.length - 2 && cum[seg + 1] < d) seg++;
    const span = cum[seg + 1] - cum[seg] || 1;
    const f = (d - cum[seg]) / span;
    const lon = trimmed[seg][0] + (trimmed[seg + 1][0] - trimmed[seg][0]) * f;
    const lat = trimmed[seg][1] + (trimmed[seg + 1][1] - trimmed[seg][1]) * f;
    out.push({ lat, lon, ele: demSyncAt(lat, lon) ?? 0 });
  }
  console.log(`LOC=${key} ${place.label}: 道路等級 ${picked.cls},鏈長 ${(picked.chain.m / 1000).toFixed(2)} km` +
    ` → 取樣 ${out.length} 點 / ${(total / 1000).toFixed(2)} km`);
  return out;
}

const points = LOC
  ? await buildRouteFromLoc(LOC)
  : (JSON.parse(readFileSync(ROUTE, 'utf8')).points as { lat: number; lon: number; ele: number }[]);
const cumulative = buildCumulativeDistances(points);

// `TerrainChunkManager.buildSlices` 逐字複刻(它是 private)。
const slices: { startIdx: number; endIdx: number; startDist: number; endDist: number }[] = [];
{
  let startIdx = 0;
  let startDist = 0;
  while (startIdx < points.length - 1) {
    const targetEnd = startDist + CHUNK_LENGTH;
    let endIdx = startIdx;
    while (endIdx < points.length - 1 && cumulative[endIdx] < targetEnd) endIdx++;
    if (endIdx === startIdx) endIdx = Math.min(startIdx + 1, points.length - 1);
    slices.push({ startIdx, endIdx, startDist, endDist: cumulative[endIdx] });
    startDist = cumulative[endIdx];
    startIdx = endIdx;
  }
}

// 中央 chunk = 海拔最高點所在的那一個(山頂),前後各加一個當鄰居/接縫。
let summitIdx = 0;
for (let i = 1; i < points.length; i++) if (points[i].ele > points[summitIdx].ele) summitIdx = i;
let midChunk = slices.findIndex((s) => summitIdx >= s.startIdx && summitIdx <= s.endIdx);
if (process.env.CHUNK) midChunk = Number(process.env.CHUNK);
const WINDOW = [midChunk - 1, midChunk, midChunk + 1].filter((i) => i >= 0 && i < slices.length);

const originLat = points[0].lat, originLon = points[0].lon, originEle = points[0].ele;
const cosLat = Math.cos((originLat * Math.PI) / 180);
const sceneX = (lon: number): number => (lon - originLon) * 111320 * cosLat;
const sceneZ = (lat: number): number => -(lat - originLat) * 111320;

console.log(`route: ${LOC ? `LOC=${LOC}` : ROUTE}`);
console.log(`  ${points.length} pts, ${(cumulative[points.length - 1] / 1000).toFixed(1)} km, ` +
  `ele ${Math.min(...points.map((p) => p.ele)).toFixed(0)}..${points[summitIdx].ele.toFixed(0)} m`);
console.log(`  summit at point #${summitIdx} (${(cumulative[summitIdx] / 1000).toFixed(2)} km) ` +
  `→ chunk ${midChunk}, building chunks [${WINDOW.join(', ')}]`);

// ── 這三個 chunk 的地理範圍 ──
let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
for (const ci of WINDOW) {
  for (let i = slices[ci].startIdx; i <= slices[ci].endIdx; i++) {
    const p = points[i];
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
}
const PAD = 0.012; // 走廊半寬 500 m ≈ 0.0045°,再留 MVT 的 0.005 + 邊
minLat -= PAD; maxLat += PAD; minLon -= PAD; maxLon += PAD;

// DEM:把覆蓋範圍的圖磚全部抓進來(執行時抓,不落地)
{
  const tl = tileXY(maxLat, minLon), br = tileXY(minLat, maxLon);
  const jobs: Promise<void>[] = [];
  for (let x = tl.x; x <= br.x; x++) {
    for (let y = tl.y; y <= br.y; y++) jobs.push(ensureDem(x, y));
  }
  await Promise.all(jobs);
}
console.log(`DEM tiles: ${demTiles.size}`);

// MVT:同一組範圍,拿來裝「建築/市區壓平」的 correction(跟 chunk manager 一樣,
// 地形取樣 DEM 之前就要裝好)
const features: any[] = [];
{
  const tl = tileXY(maxLat, minLon), br = tileXY(minLat, maxLon);
  for (let x = tl.x; x <= br.x; x++) {
    for (let y = tl.y; y <= br.y; y++) features.push(...await mvtTile(x, y));
  }
}
type Entry = {
  ring: [number, number][];
  minLon: number; maxLon: number; minLat: number; maxLat: number;
  floor: number | 'route';
};
const entries: Entry[] = [];
for (const f of features) {
  const isBld = f.layer === 'building';
  const isUrb = f.layer === 'landuse' && isUrbanLanduse(f);
  if (!isBld && !isUrb) continue;
  for (const ring of extractPolygonCoords(f)) {
    if (ring.length < 3) continue;
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [lo, la] of ring) {
      if (lo < a) a = lo; if (lo > b) b = lo;
      if (la < c) c = la; if (la > d) d = la;
    }
    if (isBld) {
      let floor = Infinity;
      const step = Math.max(1, Math.floor(ring.length / 8));
      for (let k = 0; k < ring.length; k += step) {
        const s = demSyncAt(ring[k][1], ring[k][0]);
        if (s !== null && s < floor) floor = s;
      }
      if (!Number.isFinite(floor)) continue;
      entries.push({ ring, minLon: a, maxLon: b, minLat: c, maxLat: d, floor });
    } else {
      entries.push({ ring, minLon: a, maxLon: b, minLat: c, maxLat: d, floor: 'route' });
    }
  }
}
const URBAN_CLAMP_M = 12;
function nearestRouteEle(lon: number, lat: number): number {
  let best = Infinity, bestEle = Infinity;
  for (let i = 0; i < points.length; i += 8) {
    const dx = (points[i].lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180);
    const dz = (points[i].lat - lat) * 111320;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) { best = d2; bestEle = points[i].ele; }
  }
  return best < 1500 * 1500 ? bestEle : Infinity;
}
sampler.correction = (lat, lon, ele) => {
  let out = ele;
  let routeFloor: number | null = null;
  for (const e of entries) {
    if (lon < e.minLon || lon > e.maxLon || lat < e.minLat || lat > e.maxLat) continue;
    let floor: number;
    if (e.floor === 'route') {
      if (routeFloor === null) routeFloor = nearestRouteEle(lon, lat) + URBAN_CLAMP_M;
      floor = routeFloor;
    } else floor = e.floor;
    if (floor >= out) continue;
    let inside = false;
    const ring = e.ring;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) out = floor;
  }
  return out;
};
console.log(`MVT features: ${features.length}, flatten entries: ${entries.length}`);

// ── 地表真相:直接在建好的三角形上蓋一份 xz 桶索引 ──
//
// 不能拿高度網格去驗高度網格。這份索引回答「(x, z) 這一點,畫出來的面有哪幾層」,
// 資料來源是 `mesh.geometry` 的 index buffer 本身。豎面(投影到 xz 面積為 0)
// 直接跳過 —— 它們不是「地表」,是地表之間的切口。
interface SurfaceIndex {
  cell: number; minX: number; minZ: number; nx: number; nz: number;
  buckets: Int32Array[]; pos: Float32Array; tri: Int32Array;
}
function buildSurfaceIndex(meshes: THREE.Mesh[]): SurfaceIndex {
  const posList: number[] = [];
  const triList: number[] = [];
  for (const m of meshes) {
    const g = m.geometry as THREE.BufferGeometry;
    const p = g.getAttribute('position');
    const idx = g.index;
    if (!p || !idx) continue;
    const base = posList.length / 3;
    for (let i = 0; i < p.count; i++) posList.push(p.getX(i), p.getY(i), p.getZ(i));
    const arr = idx.array;
    for (let t = 0; t + 2 < arr.length; t += 3) {
      triList.push(base + arr[t], base + arr[t + 1], base + arr[t + 2]);
    }
  }
  const pos = Float32Array.from(posList);
  const tri = Int32Array.from(triList);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i] < minX) minX = pos[i];
    if (pos[i] > maxX) maxX = pos[i];
    if (pos[i + 2] < minZ) minZ = pos[i + 2];
    if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
  }
  const cell = 24;
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
  const counts = new Int32Array(nx * nz);
  const visit = (t: number, fn: (b: number) => void): void => {
    const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
    const x0 = Math.min(pos[a], pos[b], pos[c]), x1 = Math.max(pos[a], pos[b], pos[c]);
    const z0 = Math.min(pos[a + 2], pos[b + 2], pos[c + 2]);
    const z1 = Math.max(pos[a + 2], pos[b + 2], pos[c + 2]);
    // 投影面積 ~0 的三角形是豎面(切口),不是地表。
    const area = Math.abs(
      (pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]) - (pos[c] - pos[a]) * (pos[b + 2] - pos[a + 2]),
    ) / 2;
    if (area < 1e-4) return;
    const bx0 = Math.max(0, Math.floor((x0 - minX) / cell));
    const bx1 = Math.min(nx - 1, Math.floor((x1 - minX) / cell));
    const bz0 = Math.max(0, Math.floor((z0 - minZ) / cell));
    const bz1 = Math.min(nz - 1, Math.floor((z1 - minZ) / cell));
    for (let bx = bx0; bx <= bx1; bx++) for (let bz = bz0; bz <= bz1; bz++) fn(bz * nx + bx);
  };
  for (let t = 0; t < tri.length; t += 3) visit(t, (b) => { counts[b]++; });
  const buckets: Int32Array[] = new Array(nx * nz);
  for (let i = 0; i < nx * nz; i++) buckets[i] = new Int32Array(counts[i]);
  const cursor = new Int32Array(nx * nz);
  for (let t = 0; t < tri.length; t += 3) visit(t, (b) => { buckets[b][cursor[b]++] = t; });
  return { cell, minX, minZ, nx, nz, buckets, pos, tri };
}

// ── 歸因用:覆蓋 (x, z) 的**每一格** ──
//
// `pickCell` 是 private 而且只回一個答案。要拆帳就得看到它挑之前的整份候選,
// 所以這裡照抄它的四邊形 even-odd 測試,但把命中的全部交出來(附 section a 與
// 欄 c —— 「這是不是騎士自己那一折」只有欄位看得出來)。
interface Cover {
  chunk: number; id: number; a: number; c: number; h: number; span: number;
  /** 這一格四邊形在 xz 平面的**有號**面積。走廊折到自己身上時它會翻負。 */
  area: number;
  /** 格心。 */
  mx: number; mz: number;
}
function coveringCells(
  grid: any, chunk: number, x: number, z: number, out: Cover[],
): void {
  const { gx, gz, cellIndex, cross, heights } = grid;
  if (!gx || !gz || !cellIndex) return;
  const { cellSize, minX, minZ, nx, nz, starts, items } = cellIndex;
  const bx = Math.floor((x - minX) / cellSize);
  const bz = Math.floor((z - minZ) / cellSize);
  if (bx < 0 || bx >= nx || bz < 0 || bz >= nz) return;
  const b = bz * nx + bx;
  const cellsC = cross - 1;
  for (let k = starts[b]; k < starts[b + 1]; k++) {
    const id = items[k];
    const a = Math.floor(id / cellsC), c = id % cellsC;
    const i00 = a * cross + c;
    const qi = [i00, i00 + 1, i00 + cross + 1, i00 + cross];
    let inside = false;
    for (let p = 0, q = 3; p < 4; q = p++) {
      const xp = gx[qi[p]], zp = gz[qi[p]];
      const xq = gx[qi[q]], zq = gz[qi[q]];
      if ((zp > z) !== (zq > z) && x < ((xq - xp) * (z - zp)) / (zq - zp) + xp) inside = !inside;
    }
    if (!inside) continue;
    // 這一格在 xz 平面上有多大。轉彎處走廊外緣的格子會被拉到上百公尺 —— 一片
    // 那麼大的**平**踏面,拿它當「這一點的地面」就會差掉整座山坡。
    let sx0 = Infinity, sx1 = -Infinity, sz0 = Infinity, sz1 = -Infinity;
    for (const i of qi) {
      if (gx[i] < sx0) sx0 = gx[i];
      if (gx[i] > sx1) sx1 = gx[i];
      if (gz[i] < sz0) sz0 = gz[i];
      if (gz[i] > sz1) sz1 = gz[i];
    }
    let area = 0, mx = 0, mz = 0;
    for (let p = 0, q = 3; p < 4; q = p++) {
      area += gx[qi[q]] * gz[qi[p]] - gx[qi[p]] * gz[qi[q]];
      mx += gx[qi[p]] / 4; mz += gz[qi[p]] / 4;
    }
    out.push({
      chunk, id, a, c, h: heights[id], span: Math.hypot(sx1 - sx0, sz1 - sz0),
      area: area / 2, mx, mz,
    });
  }
}

/** 畫出來的面在 (x, z) 上的所有高度,由高到低。 */
function surfacesAt(ix: SurfaceIndex, x: number, z: number, out: number[]): number[] {
  out.length = 0;
  const bx = Math.floor((x - ix.minX) / ix.cell);
  const bz = Math.floor((z - ix.minZ) / ix.cell);
  if (bx < 0 || bx >= ix.nx || bz < 0 || bz >= ix.nz) return out;
  const bucket = ix.buckets[bz * ix.nx + bx];
  const { pos, tri } = ix;
  for (let k = 0; k < bucket.length; k++) {
    const t = bucket[k];
    const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
    const ax = pos[a], az = pos[a + 2];
    const bx2 = pos[b], bz2 = pos[b + 2];
    const cx = pos[c], cz = pos[c + 2];
    const d = (bz2 - cz) * (ax - cx) + (cx - bx2) * (az - cz);
    if (Math.abs(d) < 1e-9) continue;
    const l1 = ((bz2 - cz) * (x - cx) + (cx - bx2) * (z - cz)) / d;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const l3 = 1 - l1 - l2;
    const E = -1e-9;
    if (l1 < E || l2 < E || l3 < E) continue;
    out.push(l1 * pos[a + 1] + l2 * pos[b + 1] + l3 * pos[c + 1]);
  }
  out.sort((p, q) => q - p);
  return out;
}

// ── 模擬 ──
const BIKE_HALF_LEN = 1.6;   // 7 m 的擺飾 × BIKE_SCALE 0.45 ≈ 3.15 m,半長 1.6
const BIKE_HALF_WIDE = 0.5;
const BIKE_HEIGHT = 2.0;     // 判「整台埋住」用的上緣
const CHASE_BACK = 11.2;
const CHASE_UP = 6.3;
/** CLIMB=1 開啟「撞到裙邊就爬上踏面」的模擬(使用者提的修法)。 */
const CLIMB = process.env.CLIMB === '1';
/** 爬上去的高度上限,以「幾個階高」計。超過就當它是上一圈的路面,不爬。 */
const CLIMB_LIMIT = Number(process.env.CLIMB_LIMIT ?? 1.5);
/** DUMP=<km>:在那個里程的第一幀,把覆蓋騎士那一點的每一格列出來。 */
const DUMP = process.env.DUMP ? Number(process.env.DUMP) : null;
/** DUMPOVER=<m>:改成在「挑到的格子比 DEM 高過這麼多」的第一幀 dump。 */
const DUMP_OVER = process.env.DUMPOVER ? Number(process.env.DUMPOVER) : null;

interface Stats {
  frames: number;
  metres: number;
  viaGrid: number; viaRaycast: number; viaNone: number;
  /** 視線取樣(相機那一側)走到退路的次數 */
  sightGrid: number; sightRaycast: number; sightNone: number;
  /** (a) 一幀跨過一整階 —— 再拆成「同一個 chunk 內的台階」與「換 chunk」 */
  stepJumps: number; stepJumpsSameChunk: number; stepJumpsCrossChunk: number; maxJumpM: number;
  /** 車體插進地表的幀數 / 深度(0 < 深度 ≤ 車高 = 部分埋住) */
  clipFrames: number; clipSumM: number; maxClipM: number;
  /**
   * 同一件事拆成兩種,因為它們不是同一個病:
   *  · **台階**(≤ 1.5 階):車頭跨過一道豎邊。demo 的階高就是這麼高,
   *    `climbOntoTread` 治的正是這一種。
   *  · **結構**(> 1.5 階):地面本身錯了 —— 走廊折疊疊出來的那疊面。
   * 只看總幀數會把兩者混在一起,而修好結構的那一半之後,騎士從「疊在最上面」
   * 掉回自己那條路,台階那一半反而會**變多**(因為原本九層疊著,總有一層在
   * 腳邊 0.5 m 內,計數就漏掉了)。
   */
  clipStepFrames: number; clipDeepFrames: number; clipDeepSumM: number;
  /** 整台車都在土裡(深度 > 車高) */
  buriedFrames: number;
  /** 騎士自己那一點:網格給的高度不是任何一片畫出來的面 */
  gridNotOnMesh: number; maxGridNotOnMeshM: number;
  /** 騎士自己那一點:最上面那片畫出來的面比騎士高多少 */
  aboveHeadFrames: number; maxAboveHeadM: number;
  /** 相機遮蔽抬升 */
  liftMax: number; liftP50: number; liftP95: number; liftOver50: number; liftOver150: number;
  /** 車在雲底下、而相機被抬到雲底(含穿過去)的幀數;以及裝上天花板之後 */
  inCloudUncapped: number; inCloudCapped: number; riderInDeck: number;
  /** CLIMB=1:騎士被車頭那一筆抬高了多少(浮在自己那格上方) */
  floatFrames: number; floatSumM: number; maxFloatM: number;
  /** 畫出來的地面 vs GPX 自己的高程 —— 台階到底是不是「路的坡度」量出來的 */
  eleErrSum: number; eleErrAbsSum: number; maxEleErr: number; minEleErr: number;
  demVsGpxSum: number; cellOverDemSum: number; maxCellOverDem: number;
  /**
   * 「網格挑的格子比 DEM 高 8.94 m」的拆帳。三個數都減同一個 DEM,所以可以直接
   * 相減:
   *  · attPick  = 實際回給騎士的高度(`pickCell(wantHighest)` 那一格)
   *  · attNear  = 覆蓋這一點的所有格子裡,高度最接近 `preferY` 的那一格
   *  · attLane  = 只看走廊**中心兩欄**(騎士自己那條車道)的同一個問題
   * attPick − attNear = wantHighest 多挑的;attNear − 0 = 騎士那一折自己的誤差。
   */
  attFrames: number; attPickOverDem: number; attNearOverDem: number;
  attLaneFrames: number; attLaneOverDem: number;
  attCoverSum: number; attMaxCover: number;
  attFoldFrames: number; attCrossChunkFrames: number;
  attSpreadSum: number; attMaxSpread: number;
  /** 挑到的那一格在 xz 平面的對角長(轉彎處走廊外緣會被拉到上百公尺)。 */
  attPickSpanSum: number; attMaxPickSpan: number; attSpanSum: number;
  /**
   * 走廊的中心**欄**就是路,所以路正好壓在兩格的共用邊上:騎士左右兩邊各是一格,
   * 而那兩格的踏面各自是「路 + 半格橫坡」與「路 − 半格橫坡」的平均。橫坡越陡,
   * 這道**沿著路**的落差越大 —— 這一欄量的就是它。
   */
  laneStepFrames: number; laneStepSum: number; laneStepMax: number;
  /**
   * 上面那道落差跟車體插進地表的深度到底是不是同一件事 —— 逐幀配對量,不是比
   * 兩個平均數。
   *
   *  · `corr*` 是 Pearson 的累加項(x = 那一幀的車道落差,y = 那一幀的插入深度,
   *    沒插到就是 0)。**兩個平均數接近不代表相關**:同一組平均值可以由「每一幀
   *    都差一點」或「一成的幀差很多」湊出來,而那兩件事要修的東西不一樣。
   *  · `latClip*` / `lonClip*` 把車體拆成兩台只有一個維度的車:
   *      橫向 = 車軸那一點左右各 0.5 m(**只有寬度**)→ 量的是車道落差本身
   *      縱向 = 車頭 / 車尾 ±1.6 m,不偏移(**只有長度**)→ 量的是沿路的台階,
   *             也就是 `climbOntoTread` 治的那一種
   *    出貨的 `clipFrames` 是六個角點的聯集,拆開才知道哪一半是哪一半。
   */
  corrN: number; corrX: number; corrY: number; corrXX: number; corrYY: number; corrXY: number;
  /** 同一組累加,但 y 換成**只有寬度**那台車的插入深度 —— 車道落差直接造成的那一半。 */
  corrLatY: number; corrLatYY: number; corrLatXY: number;
  latClipFrames: number; latClipSum: number; latClipMax: number;
  lonClipFrames: number; lonClipSum: number; lonClipMax: number;
  /** 車道落差分桶(以階高計):幀數 / 該桶的平均插入深度。 */
  laneBinN: number[]; laneBinClip: number[]; laneBinLat: number[];
  /** 三條收件規則的試算(見 `ownsCell` 上面那段)。 */
  ruleTopErr: number[]; ruleTopAbs: number[]; ruleKept: number[]; ruleEmpty: number[];
  ruleNegArea: number;
  /** 相鄰兩格的高度差(沿路每 32 m 一格)的分佈 */
  cellDeltas: number[];
  /** 最大的幾次單幀落差(位置 + 是不是換 chunk) */
  worstJumps: { d: number; jump: number; cross: boolean }[];
}

// ── 雲層(fallback 那組數字,也就是天氣抓不到時的常態)──
const CLOUD_BASE_SCENE_Y = 200;   // CLOUD_BASE_FALLBACK_AGL
const CLOUD_THICKNESS = 200;      // CLOUD_LAYER_THICKNESS
const CLOUD_CLEARANCE = 25;       // CLOUD_CAMERA_CLEARANCE
const CLOUD_LOWEST_GEOM = 11.7;   // 最會垂的那個世界(paper 的棉花球)+ bob
function ceilingFor(camY: number): number | null {
  if (camY > CLOUD_BASE_SCENE_Y + CLOUD_THICKNESS) return null;
  return CLOUD_BASE_SCENE_Y - CLOUD_CLEARANCE;
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

interface Built {
  grids: { grid: any; cx: number; cz: number }[];
  index: SurfaceIndex;
  layerHeight: number;
  gridSize: number;
}

// ── 「如果只收下這些格子會怎樣」的試算 ──
//
// 量到走廊在轉彎處把格子拉到 100–650 m 之後,問題就變成「哪一條收件規則能把同一
// 點上的那疊面收成一片」。三條候選:
//   R1 只丟**翻面**的格子(走廊折到自己身上,有號面積變號)
//   R2 丟掉**被拉爛**的格子(xz 對角 > 2 × gridSize)
//   R3 歸屬:格心最近的那段路線必須就是這一格自己的斷面(中軸切割)
// 每一條都要回答同一組問題:剩下的最上面那片離 DEM 多遠、還剩幾片、有沒有把
// 這一點**整個**清空(= 地表破洞,比穿模更糟)。
const routeSX = new Float64Array(points.length);
const routeSZ = new Float64Array(points.length);
for (let i = 0; i < points.length; i++) {
  routeSX[i] = sceneX(points[i].lon);
  routeSZ[i] = sceneZ(points[i].lat);
}
/**
 * R3 的判準:**中軸切割**。走廊的斷面中心就是路線上的取樣點,所以「離格心最近的
 * 那個斷面中心」= 這一塊地離哪一段路最近。一格只有在「最近的斷面就是自己」時才
 * 算數 —— 這正是偏移曲線不自交的充要條件(超過中軸的部分,本來就有另一段路蓋著)。
 */
let sites: { chunk: number; a: number; x: number; z: number }[] = [];
let ownCache = new Map<number, boolean>();
function ownsCell(_b: Built, cv: Cover): boolean {
  const key = cv.chunk * 1e7 + cv.id;
  const hit = ownCache.get(key);
  if (hit !== undefined) return hit;
  let best = sites[0], bestD = Infinity;
  for (const s of sites) {
    const dx = s.x - cv.mx, dz = s.z - cv.mz;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = s; }
  }
  // 一格夾在斷面 a 與 a+1 之間,所以兩個都算它自己。
  const ok = best.chunk === cv.chunk && (best.a === cv.a || best.a === cv.a + 1);
  ownCache.set(key, ok);
  return ok;
}

async function build(style: TerrainStyle, layerOverride: number | null): Promise<Built> {
  const strategy = await createTerrainStyleStrategy(style);
  if (layerOverride !== null) (strategy.params as any).layerHeight = layerOverride;
  const grids: { grid: any; cx: number; cz: number }[] = [];
  const meshes: THREE.Mesh[] = [];
  let prevEdge: any = undefined;
  for (const ci of WINDOW) {
    const s = slices[ci];
    const t = await buildTerrainChunk(
      {
        points, cumulativeDistances: cumulative,
        startIdx: s.startIdx, endIdx: s.endIdx, chunkIndex: ci,
        prevEdge, corridorHalfWidth: 500, gridSizeScale: 1,
      } as any,
      sampler as any, originLat, originLon, originEle, strategy,
    );
    prevEdge = t.lastEdge;
    const mid = points[Math.floor((s.startIdx + s.endIdx) / 2)];
    grids.push({ grid: t.heightGrid, cx: sceneX(mid.lon), cz: sceneZ(mid.lat) });
    meshes.push(t.mesh);
  }
  const index = buildSurfaceIndex(meshes);
  ownCache = new Map();
  sites = [];
  for (let k = 0; k < grids.length; k++) {
    const g = grids[k].grid;
    for (let a = 0; a < g.along; a++) sites.push({ chunk: k, a, x: g.centerX[a], z: g.centerZ[a] });
  }
  return {
    grids, index,
    layerHeight: strategy.params.layerHeight,
    gridSize: strategy.params.gridSize,
  };
}

/**
 * `TerrainChunkManager.raycastGroundHeight` 的複刻:先問每一個 chunk 的高度網格
 * (有 preferY 就全掃取最接近的),都沒中才退回 mesh raycast(這裡用同一份三角形
 * 索引的最上層面,跟 THREE.Raycaster 由上往下第一個命中同義)。
 */
function groundAt(
  b: Built, x: number, z: number, rx: number, rz: number, preferY: number | undefined,
  scratch: number[],
): { y: number | null; via: 'grid' | 'raycast' | 'none'; chunk: number } {
  const order = b.grids
    .map((g, i) => ({ i, d: (g.cx - rx) ** 2 + (g.cz - rz) ** 2 }))
    .sort((p, q) => p.d - q.d);
  if (preferY !== undefined) {
    let best: number | null = null;
    let bestChunk = -1;
    for (const { i } of order) {
      const h = sampleChunkHeight(b.grids[i].grid, x, z, originEle, preferY);
      if (h !== null && (best === null || Math.abs(h - preferY) < Math.abs(best - preferY))) {
        best = h; bestChunk = i;
      }
    }
    if (best !== null) return { y: best, via: 'grid', chunk: bestChunk };
  } else {
    for (const { i } of order) {
      const h = sampleChunkHeight(b.grids[i].grid, x, z, originEle);
      if (h !== null) return { y: h, via: 'grid', chunk: i };
    }
  }
  const s = surfacesAt(b.index, x, z, scratch);
  return s.length > 0
    ? { y: s[0], via: 'raycast', chunk: -1 }
    : { y: null, via: 'none', chunk: -1 };
}

/** 路線上距離 d 處的 lat/lon/ele + 前進方向。 */
function atDistance(d: number): { lat: number; lon: number; ele: number; fx: number; fz: number } {
  let i = 1;
  while (i < points.length - 1 && cumulative[i] < d) i++;
  const d0 = cumulative[i - 1], d1 = cumulative[i];
  const t = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
  const p0 = points[i - 1], p1 = points[i];
  const lat = p0.lat + (p1.lat - p0.lat) * t;
  const lon = p0.lon + (p1.lon - p0.lon) * t;
  const ele = p0.ele + (p1.ele - p0.ele) * t;
  let fx = sceneX(p1.lon) - sceneX(p0.lon);
  let fz = sceneZ(p1.lat) - sceneZ(p0.lat);
  const l = Math.hypot(fx, fz) || 1;
  return { lat, lon, ele, fx: fx / l, fz: fz / l };
}

function ride(b: Built, from: number, to: number, stepM: number): Stats {
  const st: Stats = {
    frames: 0, metres: to - from,
    viaGrid: 0, viaRaycast: 0, viaNone: 0,
    sightGrid: 0, sightRaycast: 0, sightNone: 0,
    stepJumps: 0, stepJumpsSameChunk: 0, stepJumpsCrossChunk: 0, maxJumpM: 0,
    clipFrames: 0, clipSumM: 0, maxClipM: 0,
    clipStepFrames: 0, clipDeepFrames: 0, clipDeepSumM: 0,
    buriedFrames: 0,
    gridNotOnMesh: 0, maxGridNotOnMeshM: 0,
    aboveHeadFrames: 0, maxAboveHeadM: 0,
    liftMax: 0, liftP50: 0, liftP95: 0, liftOver50: 0, liftOver150: 0,
    inCloudUncapped: 0, inCloudCapped: 0, riderInDeck: 0,
    floatFrames: 0, floatSumM: 0, maxFloatM: 0,
    eleErrSum: 0, eleErrAbsSum: 0, maxEleErr: -Infinity, minEleErr: Infinity,
    demVsGpxSum: 0, cellOverDemSum: 0, maxCellOverDem: -Infinity,
    attFrames: 0, attPickOverDem: 0, attNearOverDem: 0,
    attLaneFrames: 0, attLaneOverDem: 0,
    attCoverSum: 0, attMaxCover: 0,
    attFoldFrames: 0, attCrossChunkFrames: 0,
    attSpreadSum: 0, attMaxSpread: 0,
    attPickSpanSum: 0, attMaxPickSpan: 0, attSpanSum: 0,
    laneStepFrames: 0, laneStepSum: 0, laneStepMax: 0,
    corrN: 0, corrX: 0, corrY: 0, corrXX: 0, corrYY: 0, corrXY: 0,
    corrLatY: 0, corrLatYY: 0, corrLatXY: 0,
    latClipFrames: 0, latClipSum: 0, latClipMax: 0,
    lonClipFrames: 0, lonClipSum: 0, lonClipMax: 0,
    laneBinN: [0, 0, 0, 0, 0], laneBinClip: [0, 0, 0, 0, 0], laneBinLat: [0, 0, 0, 0, 0],
    ruleTopErr: [0, 0, 0, 0], ruleTopAbs: [0, 0, 0, 0], ruleKept: [0, 0, 0, 0],
    ruleEmpty: [0, 0, 0, 0], ruleNegArea: 0,
    cellDeltas: [],
    worstJumps: [],
  };
  const scratch: number[] = [];
  const covers: Cover[] = [];
  let dumped = false;
  const lifts: number[] = [];
  let lastValidGroundY = 0;
  let hasFix = false;
  let prevY: number | null = null;
  let prevChunk = -2;
  const sightline: { t: number; groundY: number | null }[] = [];

  for (let d = from; d <= to; d += stepM) {
    const p = atDistance(d);
    const x = sceneX(p.lon), z = sceneZ(p.lat);
    const preferY = hasFix ? lastValidGroundY : p.ele - originEle;
    const g = groundAt(b, x, z, x, z, preferY, scratch);
    st.frames++;
    if (g.via === 'grid') st.viaGrid++;
    else if (g.via === 'raycast') st.viaRaycast++;
    else st.viaNone++;

    let riderY: number;
    if (g.y !== null) {
      lastValidGroundY = g.y;
      hasFix = true;
      riderY = g.y;
    } else {
      // 遊戲的退路:上一個有效值 vs DEM,取高的
      const demY = (sampler.getElevationSync(p.lat, p.lon) ?? lastValidGroundY + originEle) - originEle;
      riderY = Math.max(lastValidGroundY, demY);
    }
    const axleY = riderY;

    // CLIMB=1 —— 使用者提的修法:再問一次「車頭那一點」的踏面,高的話就爬上去。
    // 上限一階半:那是「台階」跟「上一圈的路面」的分界,沒有它,髮夾彎會把騎士
    // 直接傳送到上面那條路。
    if (CLIMB) {
      const nx = x + p.fx * BIKE_HALF_LEN;
      const nz = z + p.fz * BIKE_HALF_LEN;
      const nose = groundAt(b, nx, nz, x, z, riderY, scratch);
      if (nose.y !== null && nose.y > riderY && nose.y - riderY <= b.layerHeight * CLIMB_LIMIT) {
        riderY = nose.y;
      }
    }
    if (riderY > axleY + 0.05) {
      st.floatFrames++;
      st.floatSumM += riderY - axleY;
      if (riderY - axleY > st.maxFloatM) st.maxFloatM = riderY - axleY;
    }

    // 畫出來的地面 vs GPX 自己記的高程。台階如果真的是「這條路的坡度」量化出來
    // 的,這個差就該落在 ±½ 階以內;差很多就表示格子的高度不是路的高度。
    const err = riderY - (p.ele - originEle);
    st.eleErrSum += err;
    st.eleErrAbsSum += Math.abs(err);
    if (err > st.maxEleErr) st.maxEleErr = err;
    if (err < st.minEleErr) st.minEleErr = err;
    // 拆帳:DEM 本身跟 GPX 差多少(資料源的事)vs 網格挑的格子又比 DEM 高多少
    // (走廊自己折起來、`pickCell(wantHighest)` 挑到上面那一折的事)。
    const demHere = sampler.getElevationSync(p.lat, p.lon);
    if (demHere !== null) {
      st.demVsGpxSum += demHere - p.ele;
      const overDem = riderY - (demHere - originEle);
      st.cellOverDemSum += overDem;
      if (overDem > st.maxCellOverDem) st.maxCellOverDem = overDem;
    }

    // 路左右各 3 m 的地面差多少 —— 這一輪的主角,所以**不**掛在拆帳那個
    // `demHere !== null` 的條件底下(那會讓它跟插入深度的樣本對不齊)。
    let laneD: number | null = null;
    {
      const lx = -p.fz * 3, lz = p.fx * 3;
      const gl = groundAt(b, x + lx, z + lz, x, z, riderY, scratch);
      const gr = groundAt(b, x - lx, z - lz, x, z, riderY, scratch);
      if (gl.y !== null && gr.y !== null) {
        laneD = Math.abs(gl.y - gr.y);
        st.laneStepFrames++;
        st.laneStepSum += laneD;
        if (laneD > st.laneStepMax) st.laneStepMax = laneD;
      }
    }

    // ── 拆帳:那 8.94 m 是 wantHighest 多挑的,還是騎士自己那一折就已經歪了 ──
    covers.length = 0;
    for (let i = 0; i < b.grids.length; i++) coveringCells(b.grids[i].grid, i, x, z, covers);
    if (demHere !== null && covers.length > 0 && g.y !== null) {
      const demRel = demHere - originEle;
      let near = covers[0];
      let lane: Cover | null = null;
      let picked = covers[0];
      let hi = covers[0].h, lo = covers[0].h;
      const perChunk = new Map<number, number>();
      for (const cv of covers) {
        if (Math.abs(cv.h - originEle - g.y) < Math.abs(picked.h - originEle - g.y)) picked = cv;
        st.attSpanSum += cv.span;
        const hRel = cv.h - originEle;
        if (Math.abs(hRel - preferY) < Math.abs(near.h - originEle - preferY)) near = cv;
        // 中心兩欄 = 騎士的車道:走廊的中心欄是 `centerCol`,而它同時是 c 與
        // c-1 兩格的邊,所以兩格都算(見 terrain-chunk 的 `centerCol`)。
        const cc = Math.floor(b.grids[cv.chunk].grid.cross / 2);
        if ((cv.c === cc || cv.c === cc - 1)
          && (lane === null
            || Math.abs(hRel - preferY) < Math.abs(lane.h - originEle - preferY))) lane = cv;
        if (cv.h > hi) hi = cv.h;
        if (cv.h < lo) lo = cv.h;
        perChunk.set(cv.chunk, (perChunk.get(cv.chunk) ?? 0) + 1);
      }
      st.attFrames++;
      st.attPickOverDem += g.y - demRel;
      st.attNearOverDem += near.h - originEle - demRel;
      if (lane !== null) {
        st.attLaneFrames++;
        st.attLaneOverDem += lane.h - originEle - demRel;
      }
      st.attCoverSum += covers.length;
      if (covers.length > st.attMaxCover) st.attMaxCover = covers.length;
      let folded = false;
      for (const n of perChunk.values()) if (n >= 2) { folded = true; break; }
      if (folded) st.attFoldFrames++;
      if (perChunk.size >= 2) st.attCrossChunkFrames++;
      st.attSpreadSum += hi - lo;
      if (hi - lo > st.attMaxSpread) st.attMaxSpread = hi - lo;
      st.attPickSpanSum += picked.span;
      if (picked.span > st.attMaxPickSpan) st.attMaxPickSpan = picked.span;

      // 三條收件規則的試算。看得見的是**最上面那片**(mesh 全部都畫),所以每條
      // 規則量的都是「剩下的最高那片離這一點的 DEM 多遠」。
      // ⚠ 走廊格子的**自然**繞向在 scene 座標下是負的(斷面往前 = z 減、欄往右 =
      // x 加,shoelace 出來是 −d²)。所以「面積 > 0」才是翻面,不是 < 0。
      for (const cv of covers) if (cv.area > 0) st.ruleNegArea++;
      for (let r = 0; r < 4; r++) {
        let top = -Infinity;
        let kept = 0;
        for (const cv of covers) {
          const ok = r === 0 ? true
            : r === 1 ? cv.area <= 0
            : r === 2 ? cv.span <= b.gridSize * 2
            : ownsCell(b, cv);
          if (!ok) continue;
          kept++;
          if (cv.h > top) top = cv.h;
        }
        st.ruleKept[r] += kept;
        if (kept === 0) { st.ruleEmpty[r]++; continue; }
        const e = top - originEle - demRel;
        st.ruleTopErr[r] += e;
        st.ruleTopAbs[r] += Math.abs(e);
      }
      // DUMP=<km>:把那一幀底下**每一格**印出來(chunk / 斷面 a / 欄 c / 高度)。
      // 「9 格覆蓋同一點」是走廊真的折回來,還是同一段路的斷面互相穿插,只有這張
      // 表分得出來 —— a 差得遠 = 折回來,a 是連號 = 斷面自己交叉。
      if (!dumped
        && ((DUMP !== null && d >= DUMP * 1000)
          || (DUMP_OVER !== null && g.y - (demHere - originEle) >= DUMP_OVER))) {
        dumped = true;
        console.log(`    [DUMP] d=${(d / 1000).toFixed(3)} km  x=${x.toFixed(1)} z=${z.toFixed(1)}` +
          `  DEM ${demHere.toFixed(1)} m  騎士 ${(g.y + originEle).toFixed(1)} m  preferY ${(preferY + originEle).toFixed(1)} m`);
        for (const cv of [...covers].sort((p, q) => q.h - p.h)) {
          const cc = Math.floor(b.grids[cv.chunk].grid.cross / 2);
          console.log(`      chunk ${cv.chunk}  斷面 a=${String(cv.a).padStart(3)}  欄 c=${String(cv.c).padStart(2)}` +
            ` (中心欄 ${cc}, 離中心 ${cv.c - cc + 0.5 >= 0 ? '+' : ''}${(cv.c - cc + 0.5).toFixed(1)} 欄)` +
            `  高 ${cv.h.toFixed(1)} m  (DEM ${(cv.h - demHere >= 0 ? '+' : '')}${(cv.h - demHere).toFixed(1)})` +
            `  格子對角 ${cv.span.toFixed(0)} m`);
        }
      }
    }
    if (prevY !== null && Math.abs(riderY - prevY) > 0.05) st.cellDeltas.push(Math.abs(riderY - prevY));

    // (a) 一幀跨過一整階 —— 並且分辨「同一個 chunk 裡的台階」跟「答案換了 chunk」
    if (prevY !== null) {
      const jump = Math.abs(riderY - prevY);
      if (jump >= b.layerHeight * 0.999) {
        st.stepJumps++;
        const cross = g.chunk !== prevChunk;
        if (cross) st.stepJumpsCrossChunk++; else st.stepJumpsSameChunk++;
        st.worstJumps.push({ d, jump, cross });
      }
      if (jump > st.maxJumpM) st.maxJumpM = jump;
    }
    prevY = riderY;
    prevChunk = g.chunk;

    // 騎士自己那一點:網格給的高度到底是不是一片畫出來的面?
    const own = surfacesAt(b.index, x, z, scratch);
    if (own.length > 0) {
      let onMesh = false;
      for (const s of own) if (Math.abs(s - riderY) <= 0.05) { onMesh = true; break; }
      if (!onMesh) {
        st.gridNotOnMesh++;
        let closest = Infinity;
        for (const s of own) closest = Math.min(closest, Math.abs(s - riderY));
        if (closest > st.maxGridNotOnMeshM) st.maxGridNotOnMeshM = closest;
      }
      const above = own[0] - riderY;
      if (above > 0.05) {
        st.aboveHeadFrames++;
        if (above > st.maxAboveHeadM) st.maxAboveHeadM = above;
      }
    }

    // 車體踏面:車頭 / 車尾 ± 半寬。
    //
    // 判準要能分開兩件長得很像的事:
    //  · 那一點**沒有**跟騎士同高的面 → 車身伸過去的地方是下一階的踏面/豎邊,
    //    車就插在裡面。深度 = 高過騎士的**最低**那片面。
    //  · 那一點**有**跟騎士同高的面,上面還另有一片 → 走廊自己疊起來(髮夾彎),
    //    車在下層路上,上層是天花板,不是穿模。
    let worst = 0;
    /** 同一支測針,但只算「純橫向」與「純縱向」那兩組角點(見 Stats 的 latClip*)。 */
    const penAt = (along: number, side: number): number => {
      const px = x + p.fx * along - p.fz * side;
      const pz = z + p.fz * along + p.fx * side;
      const ss = surfacesAt(b.index, px, pz, scratch);
      if (ss.length === 0) return 0;
      for (const s of ss) if (Math.abs(s - riderY) <= 0.5) return 0;
      let lowestAbove = Infinity;
      for (const s of ss) if (s > riderY + 0.05 && s < lowestAbove) lowestAbove = s;
      return lowestAbove === Infinity ? 0 : lowestAbove - riderY;
    };
    for (const along of [BIKE_HALF_LEN, -BIKE_HALF_LEN]) {
      for (const side of [-BIKE_HALF_WIDE, 0, BIKE_HALF_WIDE]) {
        const pen = penAt(along, side);
        if (pen > worst) worst = pen;
      }
    }
    // 只有寬度的車(車軸左右各 0.5 m)—— 車道落差自己造成的穿模。
    const latPen = Math.max(penAt(0, -BIKE_HALF_WIDE), penAt(0, BIKE_HALF_WIDE));
    // 只有長度的車(車頭 / 車尾,不偏移)—— 沿路的台階,`climbOntoTread` 的守備範圍。
    const lonPen = Math.max(penAt(BIKE_HALF_LEN, 0), penAt(-BIKE_HALF_LEN, 0));
    if (latPen > 0.05) {
      st.latClipFrames++;
      st.latClipSum += latPen;
      if (latPen > st.latClipMax) st.latClipMax = latPen;
    }
    if (lonPen > 0.05) {
      st.lonClipFrames++;
      st.lonClipSum += lonPen;
      if (lonPen > st.lonClipMax) st.lonClipMax = lonPen;
    }
    if (laneD !== null) {
      st.corrN++;
      st.corrX += laneD; st.corrXX += laneD * laneD;
      st.corrY += worst; st.corrYY += worst * worst;
      st.corrXY += laneD * worst;
      st.corrLatY += latPen; st.corrLatYY += latPen * latPen;
      st.corrLatXY += laneD * latPen;
      const bin = Math.min(4, Math.floor(laneD / Math.max(1e-6, b.layerHeight)));
      st.laneBinN[bin]++;
      st.laneBinClip[bin] += worst;
      st.laneBinLat[bin] += latPen;
    }
    if (worst > 0.05) {
      st.clipFrames++;
      st.clipSumM += worst;
      if (worst > st.maxClipM) st.maxClipM = worst;
      if (worst > BIKE_HEIGHT) st.buriedFrames++;
      if (worst <= b.layerHeight * 1.5) st.clipStepFrames++;
      else { st.clipDeepFrames++; st.clipDeepSumM += worst; }
    }

    // 相機遮蔽抬升(第一件的證據):追焦相機在車後 11.2 m、高 6.3 m
    const camX = x - p.fx * CHASE_BACK, camZ = z - p.fz * CHASE_BACK;
    const camY = riderY + CHASE_UP;
    sightline.length = 0;
    for (let i = 1; i <= SIGHTLINE_SAMPLES; i++) {
      const tt = i / SIGHTLINE_SAMPLES;
      // 視線取樣**沒有** preferY —— 跟 updateCamera 一樣
      const s = groundAt(b, x + (camX - x) * tt, z + (camZ - z) * tt, x, z, undefined, scratch);
      if (s.via === 'grid') st.sightGrid++;
      else if (s.via === 'raycast') st.sightRaycast++;
      else st.sightNone++;
      sightline.push({ t: tt, groundY: s.y });
    }
    const raw = requiredLift(riderY, camY, CHASE_LOOK_HEIGHT, sightline);
    const capped = requiredLift(riderY, camY, CHASE_LOOK_HEIGHT, sightline, ceilingFor(camY));
    lifts.push(raw);
    if (raw > st.liftMax) st.liftMax = raw;
    if (raw > 50) st.liftOver50++;
    if (raw > 150) st.liftOver150++;
    // 相機碰到雲了嗎?判準不是「相機在雲**裡**」—— 車在雲底下、相機被抬到雲底
    // 之上,雲就整片橫在相機與車之間,那正是使用者看到的一大塊灰。所以只要
    // 「車在雲底下 ∧ 相機到得了雲底」就算中。
    const cloudFloor = CLOUD_BASE_SCENE_Y - CLOUD_LOWEST_GEOM;
    if (riderY >= cloudFloor) {
      st.riderInDeck++; // 車自己就在雲裡/雲上,相機夾不夾都一樣
    } else {
      if (camY + raw >= cloudFloor) st.inCloudUncapped++;
      if (camY + capped >= cloudFloor) st.inCloudCapped++;
    }
  }
  lifts.sort((a, c) => a - c);
  st.liftP50 = pct(lifts, 0.5);
  st.liftP95 = pct(lifts, 0.95);
  st.worstJumps.sort((a, c) => c.jump - a.jump);
  st.worstJumps.length = Math.min(5, st.worstJumps.length);
  return st;
}

function report(label: string, st: Stats, layerHeight: number): void {
  const km = st.metres / 1000;
  const sight = st.sightGrid + st.sightRaycast + st.sightNone;
  console.log(`  ${label}`);
  console.log(`    frames ${st.frames} over ${km.toFixed(2)} km   (階高 ${layerHeight} m)`);
  console.log(`    (b) 騎士地面查詢: grid ${st.viaGrid} / raycast 退路 ${st.viaRaycast} / 完全沒有 ${st.viaNone}` +
    `   → 退路占 ${((100 * (st.viaRaycast + st.viaNone)) / st.frames).toFixed(2)}%`);
  console.log(`    (b) 視線取樣: grid ${st.sightGrid} / raycast 退路 ${st.sightRaycast} / 完全沒有 ${st.sightNone}` +
    `   → 退路占 ${((100 * (st.sightRaycast + st.sightNone)) / sight).toFixed(2)}%`);
  console.log(`    (a) 一幀跨整階: ${st.stepJumps} 次 = ${(st.stepJumps / km).toFixed(1)}/km` +
    ` (同 chunk ${st.stepJumpsSameChunk} / 換 chunk ${st.stepJumpsCrossChunk})` +
    `,最大單幀落差 ${st.maxJumpM.toFixed(2)} m`);
  for (const w of st.worstJumps) {
    console.log(`        ↳ ${(w.d / 1000).toFixed(3)} km  Δ${w.jump.toFixed(2)} m  ${w.cross ? '換 chunk' : '同 chunk'}`);
  }
  console.log(`    車體插進地表: ${st.clipFrames} 幀 (${((100 * st.clipFrames) / st.frames).toFixed(2)}%)` +
    `,平均深 ${(st.clipFrames ? st.clipSumM / st.clipFrames : 0).toFixed(2)} m,最深 ${st.maxClipM.toFixed(2)} m` +
    `,整台埋住 ${st.buriedFrames} 幀`);
  console.log(`      └ 拆成兩種: 台階(≤1.5 階) ${st.clipStepFrames} 幀 ` +
    `(${((100 * st.clipStepFrames) / st.frames).toFixed(2)}%)` +
    `;結構(>1.5 階) ${st.clipDeepFrames} 幀 (${((100 * st.clipDeepFrames) / st.frames).toFixed(2)}%)` +
    `,平均深 ${(st.clipDeepFrames ? st.clipDeepSumM / st.clipDeepFrames : 0).toFixed(2)} m`);
  console.log(`      └ 拆成兩台一維的車: 只有寬度(車軸左右 0.5 m) ${st.latClipFrames} 幀 ` +
    `(${((100 * st.latClipFrames) / st.frames).toFixed(2)}%),平均深 ` +
    `${(st.latClipFrames ? st.latClipSum / st.latClipFrames : 0).toFixed(2)} m,最深 ${st.latClipMax.toFixed(2)} m` +
    `;只有長度(車頭/車尾 1.6 m) ${st.lonClipFrames} 幀 (${((100 * st.lonClipFrames) / st.frames).toFixed(2)}%)` +
    `,平均深 ${(st.lonClipFrames ? st.lonClipSum / st.lonClipFrames : 0).toFixed(2)} m,最深 ${st.lonClipMax.toFixed(2)} m`);
  console.log(`    網格給的高度不在任何一片畫出來的面上: ${st.gridNotOnMesh} 幀,最大偏離 ${st.maxGridNotOnMeshM.toFixed(2)} m`);
  console.log(`    騎士頭上還有一片面: ${st.aboveHeadFrames} 幀 (${((100 * st.aboveHeadFrames) / st.frames).toFixed(1)}%)` +
    `,最高 ${st.maxAboveHeadM.toFixed(1)} m`);
  console.log(`    相機遮蔽抬升 requiredLift: p50 ${st.liftP50.toFixed(1)} / p95 ${st.liftP95.toFixed(1)}` +
    ` / max ${st.liftMax.toFixed(1)} m,>50 m ${st.liftOver50} 幀,>150 m ${st.liftOver150} 幀`);
  const under = st.frames - st.riderInDeck;
  console.log(`    雲橫在相機與車之間(車在雲底下的 ${under} 幀裡): 沒有天花板 ${st.inCloudUncapped} 幀 ` +
    `(${under ? ((100 * st.inCloudUncapped) / under).toFixed(2) : '0.00'}%) → 裝上天花板 ${st.inCloudCapped} 幀` +
    `;車自己已在雲裡/雲上 ${st.riderInDeck} 幀`);
  if (CLIMB) {
    console.log(`    CLIMB(上限 ${CLIMB_LIMIT} 階): 騎士被車頭抬高 ${st.floatFrames} 幀 ` +
      `(${((100 * st.floatFrames) / st.frames).toFixed(2)}%)` +
      `,平均 ${(st.floatFrames ? st.floatSumM / st.floatFrames : 0).toFixed(2)} m,最大 ${st.maxFloatM.toFixed(2)} m`);
  }
  const cd = [...st.cellDeltas].sort((a, c) => a - c);
  console.log(`    畫出來的地面 vs GPX 高程: 平均 ${(st.eleErrSum / st.frames).toFixed(2)} m` +
    `,平均絕對值 ${(st.eleErrAbsSum / st.frames).toFixed(2)} m,範圍 ${st.minEleErr.toFixed(1)}..${st.maxEleErr.toFixed(1)} m` +
    `  (半階 = ${(layerHeight / 2).toFixed(2)} m)`);
  console.log(`      拆帳: DEM − GPX 平均 ${(st.demVsGpxSum / st.frames).toFixed(2)} m(資料源)` +
    `,網格挑的格子 − DEM 平均 ${(st.cellOverDemSum / st.frames).toFixed(2)} m,最大 ${st.maxCellOverDem.toFixed(1)} m(走廊折疊)`);
  console.log(`    路左右各 3 m 的地面落差: ${st.laneStepFrames} 幀量得到` +
    `,平均 ${(st.laneStepFrames ? st.laneStepSum / st.laneStepFrames : 0).toFixed(2)} m` +
    `,最大 ${st.laneStepMax.toFixed(1)} m`);
  if (st.corrN > 1) {
    const n = st.corrN;
    const cov = st.corrXY / n - (st.corrX / n) * (st.corrY / n);
    const sx = Math.sqrt(Math.max(0, st.corrXX / n - (st.corrX / n) ** 2));
    const sy = Math.sqrt(Math.max(0, st.corrYY / n - (st.corrY / n) ** 2));
    const r = sx > 1e-9 && sy > 1e-9 ? cov / (sx * sy) : NaN;
    const covL = st.corrLatXY / n - (st.corrX / n) * (st.corrLatY / n);
    const sl = Math.sqrt(Math.max(0, st.corrLatYY / n - (st.corrLatY / n) ** 2));
    const rl = sx > 1e-9 && sl > 1e-9 ? covL / (sx * sl) : NaN;
    console.log(`      └ 跟插入深度的逐幀相關: r = ${r.toFixed(3)}` +
      `(車道落差 μ ${(st.corrX / n).toFixed(2)} σ ${sx.toFixed(2)} m` +
      `;插入深度 μ ${(st.corrY / n).toFixed(2)} σ ${sy.toFixed(2)} m)` +
      `;只算「只有寬度」那台車 r = ${rl.toFixed(3)}(μ ${(st.corrLatY / n).toFixed(2)} m)`);
    const bins = st.laneBinN
      .map((c, i) => `${i === 4 ? '≥4' : i}–${i === 4 ? '∞' : i + 1}階 ${c} 幀 → ` +
        `${c ? (st.laneBinClip[i] / c).toFixed(2) : '—'} / ` +
        `${c ? (st.laneBinLat[i] / c).toFixed(2) : '—'} m`)
      .join(' | ');
    console.log(`      └ 分桶(車道落差以階高計 → 平均插入深度 全車 / 只有寬度): ${bins}`);
  }
  if (st.attFrames > 0) {
    const pick = st.attPickOverDem / st.attFrames;
    const near = st.attNearOverDem / st.attFrames;
    const lane = st.attLaneFrames ? st.attLaneOverDem / st.attLaneFrames : NaN;
    console.log(`      再拆: 挑到的 − DEM ${pick.toFixed(2)} m = wantHighest 多挑的 ${(pick - near).toFixed(2)} m` +
      ` + 騎士那一折自己的 ${near.toFixed(2)} m(中心兩欄 ${lane.toFixed(2)} m,${st.attLaneFrames} 幀)`);
    console.log(`      覆蓋這一點的格子: 平均 ${(st.attCoverSum / st.attFrames).toFixed(2)} 格,最多 ${st.attMaxCover} 格` +
      `;同一 chunk 內 ≥2 格 ${st.attFoldFrames} 幀 ` +
      `(${((100 * st.attFoldFrames) / st.attFrames).toFixed(1)}%)` +
      `,跨 chunk ${st.attCrossChunkFrames} 幀 (${((100 * st.attCrossChunkFrames) / st.attFrames).toFixed(1)}%)` +
      `;候選高度全距 平均 ${(st.attSpreadSum / st.attFrames).toFixed(2)} m,最大 ${st.attMaxSpread.toFixed(1)} m`);
    console.log(`      格子大小(xz 對角): 挑到的那格平均 ${(st.attPickSpanSum / st.attFrames).toFixed(1)} m` +
      `,最大 ${st.attMaxPickSpan.toFixed(0)} m;所有候選平均 ${(st.attSpanSum / st.attCoverSum).toFixed(1)} m` +
      `  (gridSize 名目值應該是幾十公尺)`);
    const names = ['R0 全收', 'R1 丟翻面', 'R2 丟拉爛', 'R3 歸屬'];
    for (let r = 0; r < 4; r++) {
      const n = st.attFrames - st.ruleEmpty[r];
      console.log(`      ${names[r]}: 剩下最高的一片 − DEM 平均 ` +
        `${n ? (st.ruleTopErr[r] / n).toFixed(2) : 'n/a'} m,平均絕對值 ` +
        `${n ? (st.ruleTopAbs[r] / n).toFixed(2) : 'n/a'} m` +
        `;平均剩 ${(st.ruleKept[r] / st.attFrames).toFixed(2)} 片` +
        `,整個清空(破洞)${st.ruleEmpty[r]} 幀 (${((100 * st.ruleEmpty[r]) / st.attFrames).toFixed(2)}%)`);
    }
    console.log(`      翻面的格子: ${st.ruleNegArea} 次(占所有候選 ${((100 * st.ruleNegArea) / st.attCoverSum).toFixed(1)}%)`);
  }
  console.log(`    每次換格的高度差: ${cd.length} 次,中位數 ${pct(cd, 0.5).toFixed(2)} m` +
    `,p95 ${pct(cd, 0.95).toFixed(2)} m,最大 ${(cd[cd.length - 1] ?? 0).toFixed(2)} m` +
    `  (= ${(pct(cd, 0.5) / layerHeight).toFixed(1)} / ${(pct(cd, 0.95) / layerHeight).toFixed(1)} 階)`);
}

/**
 * 地表覆蓋掃描 —— **任何「少畫一點格子」的修法都要先過這一關**。
 *
 * 拿走廊自己的取樣點當樣本(每個斷面 × 每一欄的格心),問三件事:
 *  · 這一點被幾格蓋到(1 = 單值地表,>1 = 疊起來)
 *  · 有沒有**一格都沒有**(= 地表破洞,比穿模更糟:會看到山裡面)
 *  · 疊起來的那幾格高度差多少
 *
 * 樣本取走廊自己的格心而不是一張方格,因為要問的是「原本畫得出來的地方,修完
 * 還畫不畫得出來」—— 走廊以外本來就沒有地面,拿方格會把它算成破洞。
 */
function coverageSweep(b: Built): void {
  const covers: Cover[] = [];
  let pts = 0, empty = 0, one = 0, many = 0, coverSum = 0, spreadSum = 0, maxSpread = 0;
  const holeOffsets: number[] = [];
  for (let k = 0; k < b.grids.length; k++) {
    const g = b.grids[k].grid;
    const cellsA = g.along - 1, cellsC = g.cross - 1;
    for (let a = 0; a < cellsA; a++) {
      for (let c = 0; c < cellsC; c++) {
        const i00 = a * g.cross + c;
        const qi = [i00, i00 + 1, i00 + g.cross + 1, i00 + g.cross];
        let mx = 0, mz = 0;
        for (const i of qi) { mx += g.gx[i] / 4; mz += g.gz[i] / 4; }
        covers.length = 0;
        for (let j = 0; j < b.grids.length; j++) coveringCells(b.grids[j].grid, j, mx, mz, covers);
        pts++;
        coverSum += covers.length;
        if (covers.length === 0) {
          empty++;
          const off = Math.abs((c + 0.5 - (g.cross - 1) / 2) * (g.halfWidth / ((g.cross - 1) / 2)));
          holeOffsets.push(off);
          continue;
        }
        if (covers.length === 1) one++; else many++;
        let hi = covers[0].h, lo = covers[0].h;
        for (const cv of covers) { if (cv.h > hi) hi = cv.h; if (cv.h < lo) lo = cv.h; }
        spreadSum += hi - lo;
        if (hi - lo > maxSpread) maxSpread = hi - lo;
      }
    }
  }
  console.log(`  地表覆蓋掃描(${pts} 個格心): 一格都沒蓋到 ${empty} ` +
    `(${((100 * empty) / pts).toFixed(2)}%,= 破洞)`, `恰好一格 ${one} (${((100 * one) / pts).toFixed(1)}%)` +
    `,兩格以上 ${many} (${((100 * many) / pts).toFixed(1)}%)`);
  if (holeOffsets.length > 0) {
    const s = [...holeOffsets].sort((a, b) => a - b);
    console.log(`    破洞離路中線多遠: 最近 ${s[0].toFixed(0)} m,中位數 ${pct(s, 0.5).toFixed(0)} m` +
      `,最遠 ${s[s.length - 1].toFixed(0)} m;≤100 m 的有 ${s.filter((v) => v <= 100).length} 個`);
  }
  console.log(`    平均覆蓋 ${(coverSum / pts).toFixed(2)} 格` +
    `;疊起來的高度全距 平均 ${(spreadSum / Math.max(1, pts - empty)).toFixed(2)} m,最大 ${maxSpread.toFixed(1)} m`);
}

// 中央 chunk 的距離範圍
const rideFrom = slices[midChunk].startDist;
const rideTo = slices[midChunk].endDist;

// 最陡的 300 m(加密取樣用)
let steepFrom = rideFrom, steepGrade = 0;
for (let d = rideFrom; d + 300 <= rideTo; d += 25) {
  const a = atDistance(d), b2 = atDistance(d + 300);
  const grade = Math.abs(b2.ele - a.ele) / 300;
  if (grade > steepGrade) { steepGrade = grade; steepFrom = d; }
}
console.log(`  最陡的 300 m: ${(steepFrom / 1000).toFixed(2)}–${((steepFrom + 300) / 1000).toFixed(2)} km` +
  `,坡度 ${(steepGrade * 100).toFixed(1)}%\n`);

const STYLES = (process.env.STYLES ?? 'paper,plastic,circuit').split(',') as TerrainStyle[];
const LAYER = process.env.LAYER ? Number(process.env.LAYER) : null;
const SPEED_KMH = Number(process.env.SPEED ?? 45);

for (const style of STYLES) {
  const b = await build(style, LAYER);
  console.log(`── ${style} ──`);
  coverageSweep(b);
  const fast = (SPEED_KMH / 3.6) / 60;   // 每幀前進公尺(60 Hz)
  const slow = (12 / 3.6) / 60;
  report(`下坡 ${SPEED_KMH} km/h(每幀 ${fast.toFixed(3)} m)`, ride(b, rideFrom, rideTo, fast), b.layerHeight);
  report(`爬坡 12 km/h(每幀 ${slow.toFixed(3)} m)`, ride(b, rideFrom, rideTo, slow), b.layerHeight);
  report(`最陡 300 m,加密 0.02 m/樣`, ride(b, steepFrom, steepFrom + 300, 0.02), b.layerHeight);
  console.log('');
}

console.log('done');
