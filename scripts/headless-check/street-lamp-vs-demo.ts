/**
 * `[street lamp vs demo]` — 路燈**站到路上之後**的稽核。
 *
 * `diorama.ts` 裡的 `[street lamp vs demo]` 驗的是**一盞燈長什麼樣**(幾何、材質、
 * §3.10 的殼與亮點),它只問 `buildStreetLamp(0)`。這一支驗的是另外一半:**那盞燈
 * 站在哪、是什麼顏色、朝哪邊、亮不亮** —— 也就是 `street-lamp.ts` 那個滑動池的行為。
 *
 * ## 為什麼要有這一支(實騎回報的 bug)
 *
 * 三個 demo 擺路燈的程式碼都長這樣(這裡把它切出來**執行**,不是抄):
 *
 * ```js
 * for (let i = 0; i < 2; i++) {
 *   const ld = d0 + 55 + i * 110;
 *   const side = (idx + i) % 2 ? 1 : -1;     // ← 左右
 *   const { x, z } = place(ld, side * 7.5);
 *   const { grp, bulb } = bubbleLamp(idx + i); // ← 顏色,同一個整數
 *   ...
 * }
 * ```
 *
 * demo 的 `idx + i` 是**位置身分**:chunk 建一次就不動,燈永遠不換顏色,而且左右與
 * 顏色來自**同一個整數**。移植把同一個變數名接到了滑動池的**陣列索引**上 ——
 * `buildStreetLamp(i)` 的 i 是池裡的第幾個物件,而池每前進一個 spacing 就滑一格,
 * 於是站在同一個位置的燈換成池裡的另一個物件,**顏色跟著換**。使用者實騎回報:
 * 「靠近時路燈會突然變色」,塑膠與瓦楞紙都會。
 *
 * 所以這裡的主斷言是**騎過去一遍再回頭比**,而不是問策略宣告了什麼顏色:
 * 模擬騎士從 0 騎到 2 km(跨過幾十個 spacing 邊界,含隧道進出),**對每一個實體
 * 位置記下它拿到的顏色**,然後要求「同一個位置從頭到尾同一個顏色」。
 *
 * ## 量的是送得到的東西
 *
 * 每一項都從 `scene` 裡那 20 個 group **實際的樣子**讀出來,不讀 manager 記在
 * `PooledLamp.distanceM` 上的帳:
 *   ・位置   = `group.position`(直路上 `-z` 就是路線距離)
 *   ・左右   = `sign(group.position.x)`
 *   ・顏色   = 那盞燈 `PointLight` 的 `color`(調色盤原色,`setNight` 只動 intensity)
 *   ・亮不亮 = `PointLight.visible`(`setNight`/`setLightEnabled` 的合成結果)
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/street-lamp-vs-demo.ts
 */
import { readFileSync } from 'node:fs';

// 共用的 canvas stub。**不要**自己裝 `globalThis.document`(理由見 recording-canvas.ts)。
const { installRecordingCanvas } = await import('./recording-canvas.ts');
installRecordingCanvas();

const THREE = await import('three');
const { createTerrainStyleStrategy } = await import('@/game/terrain/terrain-style-strategy');
const { StreetLampManager } = await import('@/game/terrain/street-lamp');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
export function failureCount(): number { return failures; }

// ── demo slicing ─────────────────────────────────────────────────────────────
/** 從 `at` 起的那一個 `{ … }` 區塊(含 `at` 之前的 header)。 */
function blockAt(src: string, at: number, what: string): string {
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error(`unbalanced ${what}`);
}
function sliceBlock(src: string, head: string, tail: string, what: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`${what}: 找不到 \`${head}\``);
  const end = src.indexOf(tail, at);
  if (end < 0) throw new Error(`${what}: \`${head}\` 沒有結尾 \`${tail}\``);
  return src.slice(at, end + tail.length);
}
function sliceLine(src: string, head: string, what: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`${what}: 找不到 \`${head}\``);
  const end = src.indexOf('\n', at);
  return src.slice(at, end < 0 ? undefined : end);
}
/** demo 裡「每 chunk 擺兩盞路燈」的那個迴圈 —— 由它自己的內容認出來,不靠行號。 */
function sliceLampLoop(src: string, what: string): string {
  const head = 'for (let i = 0; i < 2; i++) {';
  for (let from = 0; ;) {
    const at = src.indexOf(head, from);
    if (at < 0) throw new Error(`${what}: 找不到擺路燈的迴圈`);
    const body = blockAt(src, at, `${what} lamp loop`);
    if (/Lamp\(/.test(body)) return body;
    from = at + head.length;
  }
}

interface DemoLamp {
  /** demo 餵給造型函式的那個整數(= `idx + i`)。 */
  n: number;
  /** 路的哪一邊,由 `place(ld, side * 7.5)` 的橫向偏移讀回來。 */
  side: number;
  /** 路線距離。 */
  d: number;
}

/**
 * 執行 demo 的擺燈迴圈(§0.0 第 5 點:驗證是執行 demo 的原始碼,不是比對抄過來的
 * 常數)。造型函式換成一個只記帳的替身 —— 這裡要的是「哪個整數決定了什麼」,
 * 不是幾何。
 */
function runDemoLamps(src: string, what: string, chunks: number[]): DemoLamp[] {
  const chunkLen = Number(/const CHUNK_LEN = (\d+)/.exec(src)?.[1]);
  if (!Number.isFinite(chunkLen)) throw new Error(`${what}: 讀不到 CHUNK_LEN`);
  const body = sliceLampLoop(src, what)
    .replace(/\b(?:bubbleLamp|hiliteLamp|ledLamp)\(/g, 'lampFn(');
  const out: DemoLamp[] = [];
  let lat = 0;
  let d = 0;
  const place = (dd: number, ll: number): { x: number; z: number } => {
    d = dd; lat = ll;
    return { x: ll, z: -dd };
  };
  const lampFn = (n: number): unknown => {
    out.push({ n, side: Math.sign(lat), d });
    return { grp: { position: { set: () => {} }, rotation: { y: 0 } }, bulb: {} };
  };
  const run = new Function('d0', 'idx', 'place', 'lampFn', 'group', 'bulbs', 'occupied', body);
  for (const idx of chunks) {
    run(idx * chunkLen, idx, place, lampFn, { add: () => {} }, [], []);
  }
  return out;
}

/** demo 的路燈調色盤,執行它自己的宣告取得(順序就是 demo 的順序)。 */
function runDemoPalette(src: string, world: World): number[] {
  const parts: string[] = [];
  if (world === 'plastic') {
    parts.push(sliceBlock(src, 'const C = {', '\n  };', world));
    parts.push(sliceLine(src, 'const LAMP_COLS = [', world));
    parts.push('return LAMP_COLS;');
  } else if (world === 'paper') {
    parts.push(sliceLine(src, 'const HL_INKS = [', world));
    parts.push('return HL_INKS;');
  } else {
    parts.push(sliceLine(src, 'const LED_COLORS = [', world));
    parts.push('return LED_COLORS;');
  }
  const cols = new Function(parts.join('\n'))() as (string | number)[];
  return cols.map((c) => new THREE.Color(c as THREE.ColorRepresentation).getHex());
}

// ── 真實遊戲側:一段路線 + 那 20 個 group 實際的樣子 ──────────────────────────
const ORIGIN_LAT = 25;
const ORIGIN_LON = 121;
const M_PER_DEG = 111320;

interface Route {
  points: { lat: number; lon: number; ele: number; time: number }[];
  cum: number[];
}

/** 正北的直路:`z === -distance`、`x === 橫向偏移`,量什麼都不必反推。 */
function straightRoute(lengthM: number, stepM = 20): Route {
  const n = Math.round(lengthM / stepM) + 1;
  const points = Array.from({ length: n }, (_, i) => ({
    lat: ORIGIN_LAT + (i * stepM) / M_PER_DEG,
    lon: ORIGIN_LON,
    ele: 0,
    time: i * 1000,
  }));
  return { points, cum: points.map((_, i) => i * stepM) };
}

/** 一段大彎:每一個 slot 的切線都不同,才驗得到「朝向也跟著位置」。 */
function curvedRoute(lengthM: number, stepM = 20): Route {
  const cosLat = Math.cos((ORIGIN_LAT * Math.PI) / 180);
  const n = Math.round(lengthM / stepM) + 1;
  const R = 700;
  const points = Array.from({ length: n }, (_, i) => {
    const t = (i * stepM) / R;
    const east = R * Math.sin(t);
    const north = R * (1 - Math.cos(t));
    return {
      lat: ORIGIN_LAT + north / M_PER_DEG,
      lon: ORIGIN_LON + east / (M_PER_DEG * cosLat),
      ele: 0,
      time: i * 1000,
    };
  });
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = (points[i].lon - points[i - 1].lon) * M_PER_DEG * cosLat;
    const dz = (points[i].lat - points[i - 1].lat) * M_PER_DEG;
    cum.push(cum[i - 1] + Math.hypot(dx, dz));
  }
  return { points, cum };
}

interface Seen {
  /** 直路上的路線距離(= `-z`)。 */
  d: number;
  x: number;
  z: number;
  rotY: number;
  /** 這盞燈 PointLight 的顏色 = 它的調色盤原色。 */
  colour: number;
  /** 它現在有沒有帶一顆真的點光源。 */
  lit: boolean;
}

function lightOf(group: THREE.Object3D): THREE.PointLight | null {
  let found: THREE.PointLight | null = null;
  group.traverse((o) => {
    if ((o as THREE.PointLight).isPointLight) found = o as THREE.PointLight;
  });
  return found;
}

/** 場上**看得見**的每一盞燈,從物件本身讀。 */
function observe(scene: THREE.Scene): Seen[] {
  const out: Seen[] = [];
  for (const g of scene.children) {
    if (!g.visible) continue;
    const light = lightOf(g);
    out.push({
      d: -g.position.z,
      x: g.position.x,
      z: g.position.z,
      rotY: g.rotation.y,
      colour: light ? light.color.getHex() : -1,
      lit: light ? light.visible : false,
    });
  }
  return out;
}

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
const key3 = (s: Seen): string => `${s.x.toFixed(4)},${s.z.toFixed(4)}`;

type World = 'plastic' | 'paper' | 'circuit';

const WORLDS: { world: World; label: string; demo: string }[] = [
  { world: 'plastic', label: 'plastic (blown-bubble tube)', demo: 'plan/plastic-town-demo.html' },
  { world: 'paper', label: 'cuphead (highlighter)', demo: 'plan/paper-town-demo.html' },
  { world: 'circuit', label: 'circuit (5 mm LED)', demo: 'plan/circuit-town-demo.html' },
];

for (const { world, label, demo } of WORLDS) {
  console.log(`\n[street lamp placement vs demo — ${label}]`);

  const src = readFileSync(demo, 'utf8');

  // ── 1. demo 說了什麼(執行它) ──────────────────────────────────────────────
  const demoRows = runDemoLamps(src, world, Array.from({ length: 60 }, (_, i) => i));
  check(`${world}: demo 的擺燈迴圈跑得動,而且真的擺了燈`,
    demoRows.length === 120, `${demoRows.length} 盞`);

  // 左右與顏色來自同一個整數 —— 這是整支檔案的地基,所以先把它證明出來。
  const sameInteger = demoRows.every((r) => r.side === (r.n % 2 ? 1 : -1));
  check(`${world}: demo 的左右與顏色 index 是**同一個整數**(side = (idx+i)%2、`
    + 'lamp = (idx+i))', sameInteger,
    demoRows.slice(0, 6).map((r) => `n=${r.n}${r.side > 0 ? 'R' : 'L'}`).join(' '));

  // 而且它是位置的函式:同一段路再跑一次(這次倒著跑),每個位置拿到同一個整數。
  const forward = new Map(demoRows.map((r) => [r.d.toFixed(3), r.n]));
  const backward = runDemoLamps(src, world, Array.from({ length: 60 }, (_, i) => 59 - i));
  const stable = backward.every((r) => forward.get(r.d.toFixed(3)) === r.n);
  check(`${world}: demo 的顏色 index 是**位置**的函式(chunk 換個順序建,結果一樣)`,
    stable && backward.length === demoRows.length);

  const demoPalette = runDemoPalette(src, world);
  const L = demoPalette.length;
  check(`${world}: demo 的調色盤有 ${L} 色`, L >= 3,
    demoPalette.map(hex).join(' '));

  // demo 允許的 (左右, 顏色 index) 組合。四色的世界會把它綁死成「偶數色在同一邊」,
  // 三色的世界(瓦楞紙)週期是 6,六種組合全部出現 —— 那就是 demo 的答案,這裡不
  // 替它發明一條更嚴的規則。
  const demoPairs = new Set(demoRows.map((r) => `${r.side}/${r.n % L}`));
  check(`${world}: demo 的 (左右 × 顏色) 組合共 ${demoPairs.size} 種`,
    demoPairs.size === (L % 2 === 0 ? L : 2 * L),
    [...demoPairs].sort().join(' '));

  // ── 2. 真實遊戲的調色盤 ────────────────────────────────────────────────────
  const strategy = await createTerrainStyleStrategy(world);
  const refs = Array.from({ length: L + 2 }, (_, j) => strategy.buildStreetLamp(j));
  const refColours = refs.map((p) => {
    const l = lightOf(p.group);
    return l ? l.color.getHex() : -1;
  });
  check(`${world}: 每盞燈都帶著一顆 PointLight,顏色就是它的調色盤色`,
    refColours.every((c) => c >= 0));
  check(`${world}: buildStreetLamp(0…${L - 1}) 的顏色就是 demo 的調色盤,順序也一樣`,
    refColours.slice(0, L).every((c, j) => c === demoPalette[j]),
    `ours ${refColours.slice(0, L).map(hex).join(' ')} vs demo ${demoPalette.map(hex).join(' ')}`);
  check(`${world}: index 是 % ${L} 環回去的(第 ${L}、${L + 1} 盞回到第 0、1 色)`,
    refColours[L] === refColours[0] && refColours[L + 1] === refColours[1]);
  // 主斷言不能靠一組「反正都一樣」的顏色混過去。
  check(`${world}: ${L} 個 index 真的是 ${L} 個不同的顏色(不然下面全是廢話)`,
    new Set(refColours.slice(0, L)).size === L);

  const paletteIndex = new Map(refColours.slice(0, L).map((c, j) => [c, j]));

  // ── 3. 騎過去:同一個位置,顏色不可以變 ────────────────────────────────────
  const route = straightRoute(3000);
  const scene = new THREE.Scene();
  const lamps = new StreetLampManager(
    scene, strategy, route.points as never, route.cum, ORIGIN_LAT, ORIGIN_LON,
  );

  /** 一段騎乘:沿途每一格畫面看到的燈,收成「位置 → 顏色們」與 (左右 × 顏色) 組合。 */
  const pairsSeen = new Set<string>();
  let minVisible = Infinity;
  let maxVisible = 0;
  const rideRoad = (from: number, to: number, step: number, tunnel = false): Map<number, Set<number>> => {
    const seenAt = new Map<number, Set<number>>();
    for (let d = from; d <= to; d += step) {
      lamps.update(d, 1, undefined, tunnel);
      const frame = observe(scene);
      if (d >= 500 && !tunnel) {
        minVisible = Math.min(minVisible, frame.length);
        maxVisible = Math.max(maxVisible, frame.length);
      }
      for (const s of frame) {
        const k = Math.round(s.d * 1000) / 1000;
        let set = seenAt.get(k);
        if (!set) { set = new Set(); seenAt.set(k, set); }
        set.add(s.colour);
        pairsSeen.add(`${Math.sign(s.x)}/${paletteIndex.get(s.colour)}`);
      }
    }
    return seenAt;
  };

  const report = (seenAt: Map<number, Set<number>>): string => {
    const bad = [...seenAt.entries()].filter(([, set]) => set.size > 1);
    const worst = bad.slice(0, 3).map(([d, set]) =>
      `${d} m 拿過 ${set.size} 種顏色 (${[...set].map(hex).join(', ')})`).join('; ');
    return `${bad.length}/${seenAt.size} 個位置變過色${worst ? ` — ${worst}` : ''}`;
  };

  // 開放道路(spacing 70):0 → 2 km,每 5 m 一次 —— 跨過 ~28 個 spacing 邊界。
  const road = rideRoad(0, 2000, 5);
  check(`${world}: 開放道路 —— 同一個位置的燈,整段騎乘都是同一個顏色`,
    [...road.values()].every((set) => set.size === 1), report(road));
  check(`${world}: (而且這段騎乘真的掃過幾十個位置)`, road.size >= 25,
    `${road.size} 個位置`);

  // 隧道(spacing 18):密得多,邊界更多。
  const tunnel = rideRoad(0, 2000, 3, true);
  check(`${world}: 隧道 —— 同一個位置的燈,整段騎乘都是同一個顏色`,
    [...tunnel.values()].every((set) => set.size === 1), report(tunnel));
  // 上面那條的防空轉:隧道那一排要真的**更密**(不然「掃過更多位置」只是池比較
  // 大而已,把 TUNNEL_SPACING 改成 70 都還會通過)。
  const minGap = (m: Map<number, unknown>): number => {
    const ks = [...m.keys()].sort((a, b) => a - b);
    let g = Infinity;
    for (let i = 1; i < ks.length; i++) g = Math.min(g, ks[i] - ks[i - 1]);
    return g;
  };
  const roadGap = minGap(road);
  const tunnelGap = minGap(tunnel);
  check(`${world}: (而且隧道那一排真的更密、掃過的位置更多)`,
    tunnelGap < roadGap / 2 && tunnel.size > road.size,
    `隧道 ${tunnelGap} m / ${tunnel.size} 個位置,路上 ${roadGap} m / ${road.size} 個`);

  // 進出隧道:出來之後,路上那些位置還是原來的顏色。
  const before = rideRoad(600, 900, 5);
  rideRoad(900, 1300, 3, true);
  const after = rideRoad(1300, 2000, 5);
  let crossed = 0;
  let jumped = 0;
  for (const [d, set] of after) {
    const was = before.get(d);
    if (!was) continue;
    crossed++;
    if (![...set].every((c) => was.has(c)) || set.size > 1 || was.size > 1) jumped++;
  }
  check(`${world}: 進隧道再出來,路上同一個位置的燈沒有換色`,
    crossed > 0 && jumped === 0, `${crossed} 個位置比得到,${jumped} 個變了`);

  // ── 4. 左右與顏色仍然來自同一個整數(demo 的那條規則) ─────────────────────
  // 收的是**整段騎乘**看過的組合,不是某一格畫面。單一格畫面永遠只會是那一組或
  // 它的鏡射(池的索引與 slot 只差一個常數),要騎起來才看得出手性有沒有在翻。
  const mirrored = new Set([...pairsSeen]
    .map((p) => `${-Number(p.split('/')[0])}/${p.split('/')[1]}`));
  const subset = (a: Set<string>): boolean => [...a].every((p) => demoPairs.has(p));
  // 左右的絕對手性是路線方向與切線慣例決定的,不是 demo 的主張;所以左右整體
  // 鏡射過來也算對,兩種朝向試一次。
  check(`${world}: 整段騎乘的 (左右 × 顏色) 組合是 demo 那一組(或它的鏡射)`,
    subset(pairsSeen) || subset(mirrored),
    `ours ${[...pairsSeen].sort().join(' ')} / demo ${[...demoPairs].sort().join(' ')}`);
  check(`${world}: 開放道路上永遠是 10 盞(池裡另外 10 盞留給隧道,不會一起冒出來)`,
    minVisible === 10 && maxVisible === 10, `${minVisible}…${maxVisible} 盞`);

  // ── 5. 帶真光源的是離騎士最近的那幾盞 ─────────────────────────────────────
  // 「the nearest few light the road」是 street-lamp.ts 自己寫下的規則。它一度是
  // 「池陣列的前幾個」,而池的第 0 個是**騎士後方 80 公尺**那盞 —— 低畫質檔
  // (budget 3)於是把三顆光全點在騎士背後。
  const litRule = (rider: number, budget: number, inTunnel: boolean): string => {
    lamps.setLightBudget(budget);
    lamps.update(rider, 1, undefined, inTunnel);
    const seen = observe(scene);
    const want = [...seen]
      .sort((a, b) => Math.abs(a.d - rider) - Math.abs(b.d - rider))
      .slice(0, Math.min(budget, seen.length))
      .map((s) => s.d).sort((a, b) => a - b);
    const got = seen.filter((s) => s.lit).map((s) => s.d).sort((a, b) => a - b);
    return want.join(',') === got.join(',') ? ''
      : `rider ${rider}${inTunnel ? ' (隧道)' : ''} budget ${budget}: `
        + `亮的是 ${got.map((d) => (d - rider).toFixed(0)).join('/')} m,`
        + `最近的是 ${want.map((d) => (d - rider).toFixed(0)).join('/')} m`;
  };
  for (const inTunnel of [false, true]) {
    const bad: string[] = [];
    for (const budget of [3, 4, 8]) {
      for (const rider of [517, 1033, 1461]) {
        const why = litRule(rider, budget, inTunnel);
        if (why && bad.length < 2) bad.push(why);
      }
    }
    check(`${world}: ${inTunnel ? '隧道' : '開放道路'} —— 帶真光源的就是離騎士最近的那幾盞`,
      bad.length === 0, bad.join(' | '));
  }
  // budget 0 是合法的(見 street-lamp.ts 的註記),它不可以炸也不可以偷點燈。
  lamps.setLightBudget(0);
  lamps.update(1000, 1);
  check(`${world}: budget 0 → 一盞都不點(但燈還在)`,
    observe(scene).length > 0 && observe(scene).every((s) => !s.lit));
  lamps.setLightBudget(8);

  // ── 6. 池的完整性:同一個 group 不可以同時站在兩個位置 ─────────────────────
  const groups = scene.children.length;
  let dupes = 0;
  let maxLive = 0;
  for (let d = 0; d <= 2000; d += 7) {
    const inTunnel = d > 800 && d < 1400;
    lamps.update(d, 1, undefined, inTunnel);
    const live = scene.children.filter((g) => g.visible);
    maxLive = Math.max(maxLive, live.length);
    if (new Set(live.map((g) => key3({ x: g.position.x, z: g.position.z } as Seen))).size
      !== live.length) dupes++;
  }
  check(`${world}: 池永遠是那 ${groups} 個 group(不會為了隧道中途再建 10 盞)`,
    scene.children.length === groups && groups === 20, `${groups} 個`);
  check(`${world}: 沒有任何一格畫面出現「兩盞燈疊在同一個位置」`, dupes === 0,
    `${dupes} 格`);
  check(`${world}: 隧道那段真的用滿了整個池`, maxLive === 20, `最多同時 ${maxLive} 盞`);

  // ── 7. 彎路:朝向也是位置決定的 ────────────────────────────────────────────
  const curve = curvedRoute(2000);
  const scene2 = new THREE.Scene();
  const lamps2 = new StreetLampManager(
    scene2, strategy, curve.points as never, curve.cum, ORIGIN_LAT, ORIGIN_LON,
  );
  const spotColour = new Map<string, Set<number>>();
  const spotRot = new Map<string, Set<string>>();
  // 去了再倒回來。倒帶是 replay 拉時間軸會發生的事,而且它是唯一能讓**同一個
  // 地點**被重新擺一次的騎法 —— 沒有它,「同一個地點永遠同一個朝向」在一趟只
  // 往前的騎乘裡是自動成立的,那就不是斷言了。
  for (const d of [
    ...Array.from({ length: 301 }, (_, i) => i * 5),
    ...Array.from({ length: 301 }, (_, i) => 1500 - i * 5),
  ]) {
    lamps2.update(d, 1);
    for (const s of observe(scene2)) {
      const k = key3(s);
      if (!spotColour.has(k)) { spotColour.set(k, new Set()); spotRot.set(k, new Set()); }
      spotColour.get(k)!.add(s.colour);
      spotRot.get(k)!.add(s.rotY.toFixed(6));
    }
  }
  const rotSpread = [...spotRot.values()].reduce((a, s) => a + s.size, 0);
  check(`${world}: 彎路上,同一個地點的燈永遠同一個顏色`,
    [...spotColour.values()].every((s) => s.size === 1),
    `${[...spotColour.values()].filter((s) => s.size > 1).length}/${spotColour.size} 個地點變過色`);
  check(`${world}: 彎路上,同一個地點的燈永遠同一個朝向`,
    rotSpread === spotRot.size, `${rotSpread - spotRot.size} 個地點轉過向`);
  // 彎路上的朝向本來就該各不相同,不然上一條是廢話。
  check(`${world}: (而且這條彎路上的朝向真的各不相同)`,
    new Set([...spotRot.values()].map((s) => [...s][0])).size > 5,
    `${new Set([...spotRot.values()].map((s) => [...s][0])).size} 種朝向`);

  lamps2.dispose();
  lamps.dispose();
  for (const p of refs) p.dispose();
  strategy.dispose();
}

// ═══════════════════════════════════════════════════════════════════════════
// 地被的燈:球場與遊樂場**由燈照亮**,不是自己發光
// ═══════════════════════════════════════════════════════════════════════════
//
// 上一輪五格地被落地時,三個世界都讓**球場的材質自己發光**(plastic 的
// `glowAtNight`、paper 的 `nightLit`、circuit 的 emissive + emissiveMap)。
// 使用者裁示那讀起來是**招牌**而不是照明 —— 招牌是別的元件的身分(§3.3),
// 而且「一整片地面自己亮」正是 §3.10「小、在裡面、被半透明的殼包著」的反面。
//
// 新的事實(這一節釘的就是它,而且比舊的那條嚴):
//
//   · 五格地被**一格都不自己發光**。「只有球場會亮」變成「一格都不亮」。
//   · 球場與遊樂場各配**一盞路燈**,而那盞燈走的是這個世界**既有的**路燈建構器
//     —— 沒有為地被發明第二套燈(§3.10 最後一條:同一種零件只能有一份做法)。
//   · 燈的身分是**那塊地的位置**(跟 props 同一個 `seed`),不是路燈池的索引。
//     池是滑動的,拿索引當身分正是 2427d86 修掉的那個「燈每 70 m 換色」。
console.log('\n[地被的燈 —— 球場 / 遊樂場改由路燈照亮]');
{
  const DEMOS = {
    plastic: ['plan/plastic-town-demo.html', 'bubbleLamp'],
    paper: ['plan/paper-town-demo.html', 'hiliteLamp'],
    circuit: ['plan/circuit-town-demo.html', 'ledLamp'],
  } as const;
  const LU_BEGIN = '── LANDUSE 區塊開始 ──';
  const LU_END = '// ══ LANDUSE 區塊結束 ══';
  /** 註解不是程式碼 —— `contourRing` 就是靠一段長註解騙過人兩次的。 */
  const codeOf = (t: string): string =>
    t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '');

  const dispatch: string[] = [];
  for (const [world, [file, lampFn]] of Object.entries(DEMOS)) {
    const src = readFileSync(file, 'utf8');
    const a = src.indexOf(LU_BEGIN), b = src.indexOf(LU_END);
    const lu = codeOf(src.slice(a, b));

    // 1. 燈只掛在那兩格上,而且是共用區塊在派工(造型才是各世界的事)。
    const gate = /if \(kind === 'sports' \|\| kind === 'playground'\) \{/.exec(lu);
    const call = /LU_STYLE\.lamp\(\{ group, bulbs, cx: lx, cz: lz, y: geoGroundY\(lx, lz\), id: seed \}\);/
      .exec(lu);
    dispatch.push((gate ? gate[0] : '(無)') + ' + ' + (call ? call[0] : '(無)'));
    check(`${world}: LANDUSE 區塊只給球場與遊樂場派燈`,
      !!gate && !!call && (lu.match(/LU_STYLE\.lamp\(/g) || []).length === 1,
      gate ? `${(lu.match(/LU_STYLE\.lamp\(/g) || []).length} 處派工` : '找不到那道 gate');
    // 2. 身分取自那塊地的 seed,不是滑動池的索引 —— 而 seed 只從空間量算出來。
    const seed = /const seed = \(\(Math\.round\(info\.cx \* 4\) \* \d+\) \^ \(Math\.round\(info\.cz \* 4\) \* \d+\)\) >>> 0;/
      .test(lu);
    check(`${world}: 那盞燈的身分是那塊地的位置(seed),不是路燈池的索引`,
      seed && !!call, seed ? 'id: seed' : 'seed 不再是空間量算出來的');
    // 3. LU_STYLE.lamp 呼叫的是**這個世界既有的**路燈建構器 —— 路邊那兩盞用的
    //    是同一支函式,所以不可能有第二套燈長出來。
    const code = codeOf(src);
    const lampBody = code.slice(code.indexOf('lamp(ctx) {'), code.indexOf('props(kind, ctx) {'));
    const roadside = new RegExp(`const \\{ grp, bulb \\} = ${lampFn}\\(idx \\+ i\\);`).test(code);
    check(`${world}: 地被的燈走的是路邊那兩盞同一支 ${lampFn}() —— 沒有第二套做法`,
      lampBody.includes(`= ${lampFn}(ctx.id);`) && roadside,
      lampBody.includes(`= ${lampFn}(ctx.id);`) ? `${lampFn}(ctx.id)` : '地被的燈另外刻了一份');
    // 4. 五格**一格都不自己發光**。三個世界的登記函式名字不同,所以逐一問:
    //    地被材質的宣告區裡不准出現任何一種夜間發光的登記。
    const GLOW = /glowAtNight\(|nightLit\(|emissiveMap|emissiveIntensity|emissive:/;
    const luMatRegion = world === 'plastic'
      ? code.slice(code.indexOf("else if (kind === 'sports') {"), code.indexOf("else if (kind === 'playground')"))
      : code.slice(code.indexOf('const luSportsMat'),
        code.indexOf('\n  const ', code.indexOf('const luSportsMat') + 1));
    // 切歪 = 空字串 = 上面那條會**無聲通過**(這個 session 已經抓到過同一個形狀),
    // 所以切出來的東西必須夠長才算數,而且必須真的是球場那一段。
    check(`${world}: (球場材質那一段真的切到了)`,
      luMatRegion.length > 60 && /sports/.test(luMatRegion), `${luMatRegion.length} chars`);
    check(`${world}: 地被材質一格都不自己發光(「只有球場會亮」→「一格都不亮」)`,
      !GLOW.test(luMatRegion) && !/luSportsMat\.emissive/.test(code),
      GLOW.test(luMatRegion) ? `還留著:${GLOW.exec(luMatRegion)![0]}` : '五格全部靠燈');
    // 反向對照:同一支偵測器拿去問這個世界**確實會發光**的東西,必須說「會」——
    // 不然上面那條在「偵測器根本抓不到東西」時也會過。
    check(`${world}: …而同一支偵測器在這個世界的夜光件上是會響的`,
      GLOW.test(code), '偵測器是活的');
  }
  // 三份的派工逐字相同(DEMO_POC_GUIDE §5)。
  check('三份 demo 的地被派燈逐字相同', dispatch.every((d) => d === dispatch[0]), dispatch[0]);
}

console.log(`\n[street lamp vs demo] ${failures === 0 ? 'all clear' : `${failures} FAILURES`}`);
if (failures > 0 && !process.env.NO_EXIT_CODE) process.exitCode = 1;
