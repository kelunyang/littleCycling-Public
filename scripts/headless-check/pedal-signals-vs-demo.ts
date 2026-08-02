/**
 * `[pedal signals vs demo]` — 三份 demo 的即時訊號:共用的輸入,不共用的反應。
 *
 * 這一支跟 `rider-signals-vs-demo.ts` 分工清楚:那一支問「訊號到不到得了
 * gameview 的造型層」,這一支問**demo 這一側**兩件事 ——
 *
 *  1. **輸入是不是真的共用**:`── PEDAL 區塊 ──` 三份逐位元組相同(DEMO_POC_GUIDE
 *     §5 的「複製三次」陷阱),而且那個區塊裡不准出現任何世界自己的函式名。
 *  2. **反應是不是真的不同種類**:電子是連續的相位、積木是離散的顆粒、瓦楞紙是
 *     週期的整體。這一條**不可以**寫成「三個函式名不同」—— 那是恆真句。所以它是
 *     **執行 demo 自己那幾段**,量出訊號的**時間形狀**:
 *
 *       | 世界   | 每幀步長全部相等 | 存在「這一幀沒動」的幀 | 跨過平均值 ≥ 4 次 |
 *       |--------|------------------|------------------------|-------------------|
 *       | 電子   | ✓                | ✗                      | ✗                 |
 *       | 積木   | ✗                | ✓                      | ✗                 |
 *       | 瓦楞紙 | ✗                | ✗                      | ✓                 |
 *
 *     一個世界一個 ✓、一個欄位一個 ✓ —— 對角線。任何一個世界的反應被改成另一種
 *     形狀(例如把瓦楞紙的 `Math.sin(th)` 改成 `th`),對角線就會塌掉。
 *  3. **每一支新滑桿真的改到出貨的東西**:讀回 instance 矩陣、`mesh.scale`、
 *     `material.color`,不是讀那個變數本身。
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/pedal-signals-vs-demo.ts
 *
 * ⚠ 為什麼 fixture 的 `dt` 是 0.0173 而不是 1/60:這個 repo 最近四輪的突變盲點全部
 * 是「捨入或取模在測試資料上剛好一致」。`dt = 1/60` 配上「每 n 幀生一顆」這種累加
 * 器,會讓一整排不同的速率落在同一個 `Math.floor` 上。0.0173 s × 190 幀 = 3.287 s
 * 是刻意挑的:六個踏頻檔位生出 3 / 9 / 14 / 20 / 25 / 31 顆,**六個都不一樣**
 * (下面 D1 會把這六個數字印出來,那就是「fixture 挑對了」的證據)。
 */
import { readFileSync } from 'node:fs';

// 走共用的那一份 canvas stub(貼圖快取是模組層、按寬度收的,見 §9.0)。
const { installRecordingCanvas } = await import('./recording-canvas.ts');
installRecordingCanvas();

const THREE = await import('three');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
export function failureCount(): number { return failures; }

// ── demo 切片 ────────────────────────────────────────────────────────────────
const DEMOS = {
  circuit: 'plan/circuit-town-demo.html',
  plastic: 'plan/plastic-town-demo.html',
  paper: 'plan/paper-town-demo.html',
} as const;
type World = keyof typeof DEMOS;
const WORLDS = ['circuit', 'plastic', 'paper'] as const;

function demoScript(path: string): string {
  const html = readFileSync(path, 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const src = blocks[1];
  if (!src) throw new Error(`${path}: no second <script> block`);
  return src;
}
const SRC: Record<World, string> = {
  circuit: demoScript(DEMOS.circuit),
  plastic: demoScript(DEMOS.plastic),
  paper: demoScript(DEMOS.paper),
};

/** 從 `head` 切到 `tail`(含)。 */
function span(src: string, head: string, tail: string, what: string): string {
  const a = src.indexOf(head);
  if (a < 0) throw new Error(`${what}: 找不到 \`${head.slice(0, 40)}\``);
  const b = src.indexOf(tail, a);
  if (b < 0) throw new Error(`${what}: \`${head.slice(0, 24)}\` 之後找不到 \`${tail.slice(0, 40)}\``);
  return src.slice(a, b + tail.length);
}
/** 從 `head` 切到 `stop` 之前(不含 stop)—— 用來切「一整節」。 */
function upTo(src: string, head: string, stop: string, what: string): string {
  const a = src.indexOf(head);
  if (a < 0) throw new Error(`${what}: 找不到 \`${head.slice(0, 40)}\``);
  const b = src.indexOf(stop, a);
  if (b < 0) throw new Error(`${what}: \`${head.slice(0, 24)}\` 之後找不到 \`${stop.slice(0, 40)}\``);
  return src.slice(a, b);
}
function sliceFn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`切不出 ${name}`);
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error(`${name} 括號不平衡`);
}
function sliceStatement(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`切不出 \`${head}\``);
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const ch = src[i];
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    else if (ch === ']' || ch === '}' || ch === ')') depth--;
    else if (ch === ';' && depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`\`${head}\` 沒有結束`);
}

const PEDAL_BEGIN = '  // 騎士的即時訊號:踏頻 / 功率 / 功率來源  ── PEDAL 區塊開始 ──';
const PEDAL_END = '  // ══ PEDAL 區塊結束 ══';
const pedalBlock = (w: World): string => span(SRC[w], PEDAL_BEGIN, PEDAL_END, `${w} PEDAL`);

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[pedal: PEDAL 區塊三份逐位元組相同]');
// ═════════════════════════════════════════════════════════════════════════════
{
  const blocks = WORLDS.map((w) => pedalBlock(w));
  const same = blocks.every((b) => b === blocks[0]);
  const firstDiff = same ? -1 : Math.min(...[1, 2].map((j) => {
    const at = [...blocks[0]].findIndex((c, i) => c !== blocks[j][i]);
    return at < 0 ? blocks[0].length : at;
  }));
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(blocks[0]).digest('hex').slice(0, 16);
  check('三份 demo 的 PEDAL 區塊逐位元組相同', same,
    same ? `${blocks[0].length} chars, sha256 ${sha}` : `第一個差異在第 ${firstDiff} 個字元`);
  // 「切到了東西」跟「切對了東西」是兩件事:區塊要夠長,而且那幾件必須在裡面。
  // 少了這一條,把區塊縮成一行註解也會讓上面那條通過。
  const must = [
    'function readPedal()',
    'if (Number.isFinite(r)) cadence = Math.min(110, Math.max(60, r));',
    'if (Number.isFinite(w)) watts = Math.min(320, Math.max(80, w));',
    'const onPedal =',
    'let powerSource =',
    'function pedalKnob(',
    'globalThis.pedalControl = pedalControl;',
  ];
  const missing = must.filter((k) => !blocks[0].includes(k));
  check('…而且它真的是那個區塊(夾值、readPedal、登記處、旋鈕、把手都在裡面)',
    blocks[0].length > 5000 && missing.length === 0,
    missing.length ? `少了:${missing.join(' / ')}` : `${blocks[0].length} chars`);
  // 反向對照:上面那條**不是恆真句** —— 三個世界接在區塊之後的反應碼互不相同。
  // (「三份 HTML 有一段一樣」如果連反應也一樣,那就不是共用機制而是共用造型。)
  const tails = WORLDS.map((w) => {
    const s = SRC[w];
    const a = s.indexOf(PEDAL_END) + PEDAL_END.length;
    return s.slice(a, s.indexOf('const orbit = { theta: 0.6', a));
  });
  check('反向對照:三個世界接在區塊之後的反應碼**互不相同**(所以上面那條不是恆真)',
    tails[0] !== tails[1] && tails[1] !== tails[2] && tails[0] !== tails[2]
      && tails.every((t) => t.length > 200),
    tails.map((t, i) => `${WORLDS[i]} ${t.length}`).join(' / '));
  // 共用碼不准認識任何世界自己的函式名 —— 原本電子的 readPedal 尾巴就是這樣直接
  // 寫 `applyDayNight(nightBlend)` 的,而那個名字在另外兩個世界不存在。
  //
  // ⚠ 掃的是**去掉註解之後的程式碼**:區塊自己的 ⚠ 那一段刻意把
  // `applyDayNight(nightBlend)` 寫出來當反例,那是說明不是耦合。連註解一起掃會逼
  // 下一個人把那段說明刪掉,而那段說明正是這條規矩唯一寫下來的地方。
  const codeOnly = blocks[0]
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
    .replace(/\/\/.*$/gm, ' ');
  const worldOnly = ['applyDayNight', 'applySky', 'applyBulb', 'applyWeather', 'applyPaintMode',
    'updateBubbles', 'updateBeat', 'applyNib', 'bubbleRate', 'beatHz', 'nibPressure',
    'nightBlend', 'powerOn', 'raining'];
  const leaked = worldOnly.filter((n) => new RegExp(`\\b${n}\\b`).test(codeOnly));
  check('共用區塊裡沒有任何世界自己的函式 / 狀態名(耦合走 onPedal 登記處)',
    leaked.length === 0 && codeOnly.includes('function readPedal()'),
    leaked.join(', ') || `一個都沒有(掃過 ${codeOnly.length} chars 的純程式碼)`);
  // 反向對照:同一支掃描器對**沒有**去掉註解的版本會抓到 applyDayNight —— 否則
  // 上面那條有可能只是因為掃描器什麼都掃不到。
  check('反向對照:同一支掃描器在**不去註解**時真的會咬到 applyDayNight',
    /\bapplyDayNight\b/.test(blocks[0]) && !/\bapplyDayNight\b/.test(codeOnly));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[pedal: 夾值與那個 NaN 坑 —— 執行共用區塊本身]');
// ═════════════════════════════════════════════════════════════════════════════
interface PedalRun {
  readPedal(): void;
  drag(rpm: string, pwr: string): void;
  peek(): { cadence: number; watts: number; wattsMeter: number;
    powerSource: string; trust: number };
  click(): void;
  hooks: number[];
  control: {
    spec(k: string): { min: number; max: number; step: number; def: number; value: number } | null;
    set(k: string, v: number): number | null;
    label(k: string): string;
    readonly source: string;
    readonly cadence: number;
    readonly meterWatts: number;
    readonly watts: number;
  };
}
/**
 * 執行**共用區塊本身**(不帶任何世界的東西)。這是可行的,而且那正是它是共用機制
 * 的證明:它只需要 document / location。
 *
 * `withValue = false` 就是 headless probe 的替身形狀 —— `getElementById` 回一個
 * **沒有 value** 的東西,`Number(undefined)` = NaN。那個坑就是這樣被抓到的。
 */
function runPedal(search: string, withValue: boolean,
  values: Record<string, string> = {}): PedalRun {
  const hooks: number[] = [];
  const handlers = new Map<string, () => void>();
  const els = new Map<string, Record<string, unknown>>();
  const doc = {
    getElementById(id: string): Record<string, unknown> {
      let el = els.get(id);
      if (!el) {
        el = {
          textContent: '',
          classList: { toggle() {}, add() {}, remove() {} },
          addEventListener(type: string, fn: () => void) { handlers.set(id + ':' + type, fn); },
        };
        if (withValue) el.value = values[id] ?? '';
        // ⚠ `withValue = false` 的替身要**吃掉對 value 的寫入**,不是只有「一開始
        //   沒有 value」。原因是量出來的:區塊結尾的 pedalPaint() 自己會寫
        //   `elRpm.value = String(cadence)`,而 headless probe 的替身是一個普通物件
        //   —— 那一行會**幫它長出 value**,於是 Number(undefined) 這條路在
        //   demo-probe 裡其實已經走不到了。第一版的 fixture 因此是恆真句:拿掉
        //   Number.isFinite 護欄它照樣綠(突變測試在這裡抓到我一次)。
        //   這個替身模擬的是「這個元素永遠讀不到值」,也就是護欄真正要擋的情況。
        else Object.defineProperty(el, 'value', { get: () => undefined, set: () => {} });
        els.set(id, el);
      }
      return el;
    },
  };
  const factory = new Function('document', 'location', 'HOOKS', `
${pedalBlock('circuit')}
    onPedal(() => HOOKS.push(1));
    return {
      readPedal,
      peek: () => ({ cadence, watts, wattsMeter, powerSource, trust: pedalEstTrust }),
      control: pedalControl,
      handlers: null,
    };
  `);
  const out = factory(doc, { search }, hooks) as Omit<PedalRun, 'click' | 'hooks' | 'drag'>;
  return Object.assign(out, {
    hooks,
    click(): void {
      const fn = handlers.get('btn-psrc:click');
      if (!fn) throw new Error('btn-psrc 沒有掛上 click');
      fn();
    },
    /**
     * 拖滑桿。**一定要在建構之後才寫 value** —— 區塊結尾的 pedalPaint() 會把滑桿
     * 推回它自己的狀態(瀏覽器裡也是這樣:?rpm= 決定滑桿停在哪),所以建構時給的
     * value 早就被蓋掉了。第一版就是這樣量到「readPedal 什麼都沒讀到」的。
     */
    drag(rpm: string, pwr: string): void {
      (doc.getElementById('rpm') as { value?: string }).value = rpm;
      (doc.getElementById('pwr') as { value?: string }).value = pwr;
      out.readPedal();
    },
  }) as PedalRun;
}
{
  // 1. probe 形狀:沒有 value。readPedal 跑完不可以留下 NaN,而且**一格都不能動**。
  const probe = runPedal('', false);
  const before = probe.peek();
  probe.readPedal();
  const after = probe.peek();
  const finite = [after.cadence, after.watts, after.wattsMeter].every(Number.isFinite);
  check('讀不到 value 的替身:readPedal 之後沒有 NaN,而且值一格沒動',
    finite && after.cadence === before.cadence && after.watts === before.watts
      && after.wattsMeter === before.wattsMeter,
    `cadence ${after.cadence} watts ${after.watts}`);
  // 反向對照:同一支 readPedal 在**有** value 的環境下真的讀得到滑桿(不然上面
  // 那條只是在說「這個函式什麼都不做」)。
  const live = runPedal('', true);
  live.drag('97', '265');
  check('反向對照:替身有 value 時 readPedal 真的讀進去了', live.peek().cadence === 97
    && live.peek().wattsMeter === 265, JSON.stringify(live.peek()));

  // 2. 夾值:真的感測器會給 0 rpm 與 400 W(§4.5「範圍外的輸入是你的問題」)。
  const cases: Array<[string, string, number, number]> = [
    ['400', '900', 110, 320],
    ['0', '0', 60, 80],
    ['-5', '-999', 60, 80],
    ['85', '200', 85, 200],
  ];
  const bad = cases.filter(([r, w, cad, wt]) => {
    const run = runPedal('', true);
    run.drag(r, w);
    const p = run.peek();
    return p.cadence !== cad || p.wattsMeter !== wt;
  });
  check('夾值:踏頻夾在 60–110、功率夾在 80–320(四個 fixture,含兩端與負數)',
    bad.length === 0, bad.length ? JSON.stringify(bad) : '四個都對');

  // 3. ?rpm= / ?w= 走同一組夾值(probe 靠它驗兩端,所以這一條不能只驗滑桿)。
  //
  // ⚠ **兩端都要問。** 第一版只寫了 `?rpm=999&w=1`,也就是踏頻的上界配功率的下界
  //   —— 把踏頻的**下界**從 60 改成 50 的突變因此完全看不見(999 照樣夾成 110)。
  //   一個夾值有兩個邊,漏掉一邊的 fixture 就是漏掉一半。
  const qHi = runPedal('?rpm=999&w=9999', false).peek();
  const qLo = runPedal('?rpm=0&w=1', false).peek();
  check('?rpm= / ?w= 走同一組夾值,**四個邊都問過**',
    qHi.cadence === 110 && qHi.wattsMeter === 320
    && qLo.cadence === 60 && qLo.wattsMeter === 80,
    `999→${qHi.cadence} rpm / 0→${qLo.cadence} rpm;`
    + ` 9999→${qHi.wattsMeter} W / 1→${qLo.wattsMeter} W`);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[pedal: 功率來源 —— 折向中性點,不是折向下界]');
// ═════════════════════════════════════════════════════════════════════════════
{
  const meter = runPedal('?w=320', false);
  check('預設是 meter,而且 watts **===** 量測值(不是近似)',
    meter.peek().powerSource === 'meter' && meter.peek().watts === 320
    && meter.peek().watts === meter.peek().wattsMeter,
    `${meter.peek().watts} W`);

  const t1 = runPedal('?w=320&psrc=estimated&trust=1', false).peek();
  const t0 = runPedal('?w=320&psrc=estimated&trust=0', false).peek();
  const th = runPedal('?w=320&psrc=estimated&trust=0.5', false).peek();
  const lo = runPedal('?w=80&psrc=estimated&trust=0.5', false).peek();
  check('trust=1 → 一視同仁(320 W);trust=0 → 當作沒有訊號(200 W,§4.5 的讀法)',
    t1.watts === 320 && t0.watts === 200, `1× ${t1.watts} W / 0× ${t0.watts} W`);
  // **這一條才是「折向中間」與「折向下界」的分水嶺**:折向下界的話 320 W 會變成
  // 200(不是 260),而 80 W 會**留在 80**(不是 140)。所以兩端都要問。
  check('trust=0.5 → 折向 200 W 的中性點:320 → 260,而 80 → 140(兩邊都往中間走)',
    th.watts === 260 && lo.watts === 140, `320→${th.watts} W / 80→${lo.watts} W`);

  // 切換鈕真的切得動,而且切完 hook 被呼叫到(不然畫面不會更新)。
  const run = runPedal('?w=320&trust=0.5', false);
  const h0 = run.hooks.length;
  run.click();
  const afterClick = run.peek();
  run.click();
  const back = run.peek();
  check('btn-psrc 真的切狀態,而且每一次都呼叫到 hook(出貨的 watts 跟著變)',
    afterClick.powerSource === 'estimated' && afterClick.watts === 260
    && back.powerSource === 'meter' && back.watts === 320
    && run.hooks.length === h0 + 2,
    `meter ${back.watts} W ⇄ estimated ${afterClick.watts} W,hook +${run.hooks.length - h0}`);

  // 折扣本身是一根旋鈕,所以它跟其他反應走同一條路(網址 → 夾值 → 面板把手)。
  const spec = run.control.spec('trust')!;
  check('折扣是一根**旋鈕**(面板拿得到範圍與預設,而且 set() 夾值)',
    spec !== null && spec.min === 0 && spec.max === 1 && spec.def === 0.5
    && run.control.set('trust', 9) === 1 && run.control.set('trust', -9) === 0,
    `?trust= ${spec.min}..${spec.max} 預設 ${spec.def}`);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[pedal: 三個世界的反應是三種不同的種類 —— 執行 demo 自己那幾段]');
// ═════════════════════════════════════════════════════════════════════════════
/** 一次量測:每一幀的「出貨值」。 */
interface Shape { series: number[]; extra?: Record<string, unknown> }

const DT = 0.0173;          // 刻意不是 1/60 的倍數(見檔頭那個 ⚠)
const N = 190;              // 190 × 0.0173 = 3.287 s < BUB_LIFE 3.4,所以泡泡還沒破

/** 電子:demo animate() 那兩行,原地執行。出貨的是 pulseTex.offset.x。 */
function circuitShape(cadence: number): Shape {
  // ⚠ head 刻意不含結尾的 `;`:含了的話任何改到那一行的突變都會讓**切片器**先炸,
  //   斷言就沒有機會失敗(突變測試只看到一個 throw,看不到「哪一條抓到了」)。
  const body = span(SRC.circuit, '      pulseU -= dt * cadenceSpeed()',
    'pulseTex.offset.x = pulseU;', 'circuit pulse');
  const fn = new Function('cadence', 'DT', 'N', `
    let watts = 200;
    ${sliceStatement(SRC.circuit, 'const cadenceSpeed = ')}
    let pulseU = 0;
    const pulseTex = { offset: { x: 0 } };
    const out = [];
    for (let i = 0; i < N; i++) {
      const dt = DT;
${body}
      out.push(pulseTex.offset.x);
    }
    return out;
  `);
  return { series: fn(cadence, DT, N) as number[] };
}

/** 積木:整節「吹泡泡」原地執行。出貨的是 bubbleField.count。 */
function plasticShape(cadence: number, watts: number,
  knobs: Record<string, number> = {}, meterWatts = 999): Shape {
  const section = upTo(SRC.plastic, '  const BUB_CAP = 96;',
    '\n  const orbit = { theta: 0.6', 'plastic bubbles');
  const fn = new Function('THREE', 'cadence', 'watts', 'KNOB', 'DT', 'N', 'meterWatts', `
    const pedalKnob = (key, spec) => {
      if (!(key in KNOB)) KNOB[key] = spec.def;
      return () => KNOB[key];
    };
    // 量測瓦數刻意跟可信瓦數不同(預設 999,夾值之外)。世界要是讀錯那一個 ——
    // 讀 wattsMeter 而不是 watts —— 出貨的數字就會跟著錯,那才抓得到。
    let wattsMeter = meterWatts;
    const ballGeo = new THREE.SphereGeometry(1.15, 16, 12);
    const scene = new THREE.Scene();
    // 三根噴口 —— 五個 chunk 十盞燈是真實值,但這裡要的是可重現的除數。
    const chunks = new Map([[0, { nozzles: [
      { x: 0, y: 10.9, z: 0 }, { x: 20, y: 10.9, z: 5 }, { x: -20, y: 10.9, z: -5 },
    ] }]]);
${section}
    const counts = [], scales = [], shown = [];
    // **建好但一幀都還沒推**的狀態。render-probe 就停在這裡(它建完場景就光柵化,
    // 一幀都不推),所以宣告時的 visible 是它唯一看得到的那一格。
    const shownAtBuild = bubbleField.visible;
    const m = new THREE.Matrix4(), p = new THREE.Vector3(),
      q = new THREE.Quaternion(), s = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      updateBubbles(DT);
      counts.push(bubbleField.count);
      shown.push(bubbleField.visible);
      if (bubbleField.count > 0) {
        bubbleField.getMatrixAt(0, m);
        m.decompose(p, q, s);
        scales.push(s.x);
      }
    }
    return { counts, scales, shown, shownAtBuild, cap: BUB_CAP,
      rate: bubbleRate(), size: bubbleSize() };
  `);
  const r = fn(THREE, cadence, watts, knobs, DT, N, meterWatts) as
    { counts: number[]; scales: number[]; shown: boolean[]; shownAtBuild: boolean;
      cap: number; rate: number; size: number };
  return { series: r.counts, extra: r };
}

/** 瓦楞紙:整節「拍子 + 筆壓」原地執行。出貨的是房子的 scale.y。 */
function paperShape(cadence: number, watts: number,
  knobs: Record<string, number> = {}, meterWatts = 999): Shape {
  const section = upTo(SRC.paper, '  const BEAT_SQUASH = 0.085;',
    '\n  onPedal(applyNib);', 'paper beat+nib');
  const fn = new Function('THREE', 'cadence', 'watts', 'KNOB', 'DT', 'N', 'meterWatts', `
    const pedalKnob = (key, spec) => {
      if (!(key in KNOB)) KNOB[key] = spec.def;
      return () => KNOB[key];
    };
    // 見 plasticShape 同一行:量測與可信刻意不同,讀錯那一個才看得出來。
    let wattsMeter = meterWatts;
    const onPedal = () => {};
    const gradientMap = null;
    ${sliceFn(SRC.paper, 'toon')}
    ${sliceStatement(SRC.paper, 'const dashGeo = ')}
    ${sliceStatement(SRC.paper, 'const dashMat = ')}
    ${sliceStatement(SRC.paper, 'const sleeveInkMat = ')}
    const dashBase = dashMat.color.clone();
    const sleeveBase = sleeveInkMat.color.clone();
    // 一個 chunk 的替身:一棟房子、一根路燈、兩張樹卡片、五段虛線。
    const body = new THREE.Object3D();
    const sway = new THREE.Object3D();
    sway.rotation.z = 0.031;                       // 它原本就有的那一點歪
    const cardGeo = new THREE.PlaneGeometry(1, 1);
    const cardIM = new THREE.InstancedMesh(cardGeo, dashMat, 2);
    const tmp = new THREE.Object3D();
    for (let k = 0; k < 2; k++) {
      tmp.position.set(k * 7, 5, k * 3);
      tmp.rotation.set(0, k * 0.7, 0);
      tmp.scale.setScalar(10);
      tmp.updateMatrix();
      cardIM.setMatrixAt(k, tmp.matrix);
    }
    const dashIM = new THREE.InstancedMesh(dashGeo, dashMat, 5);
    for (let k = 0; k < 5; k++) {
      tmp.position.set(0, 0.12, k * 13);
      tmp.rotation.set(-Math.PI / 2, 0.4, 0);
      tmp.scale.setScalar(1);
      tmp.updateMatrix();
      dashIM.setMatrixAt(k, tmp.matrix);
    }
    const chunks = new Map([[0, { beat: {
      bodies: [body],
      sways: [{ o: sway, z0: sway.rotation.z }],
      cards: [{ im: cardIM, base: cardIM.instanceMatrix.array.slice() }],
      dashes: [{ im: dashIM, base: dashIM.instanceMatrix.array.slice() }],
    } }]]);
${section}
    applyNib();
    const sy = [], swz = [];
    for (let i = 0; i < N; i++) {
      updateBeat(DT);
      sy.push(body.scale.y);
      swz.push(sway.rotation.z);
    }
    return {
      sy, swz,
      cardBase: Array.from(chunks.get(0).beat.cards[0].base),
      cardNow: Array.from(cardIM.instanceMatrix.array),
      dashBaseM: Array.from(chunks.get(0).beat.dashes[0].base),
      dashNow: Array.from(dashIM.instanceMatrix.array),
      nibWidth: nibWidth(), nibPressure: nibPressure(),
      dashColor: dashMat.color.getHex(), dashOrig: dashBase.getHex(),
      sleeveColor: sleeveInkMat.color.getHex(), sleeveOrig: sleeveBase.getHex(),
      beatHz: beatHz(),
    };
  `);
  const r = fn(THREE, cadence, watts, knobs, DT, N, meterWatts) as Record<string, never>;
  return { series: (r as unknown as { sy: number[] }).sy, extra: r };
}

/** 三個描述子。每一個都只讀「出貨的那一串數字」。 */
function describe(series: number[]): { stepsEqual: boolean; hasStill: boolean;
  returns: number; monotone: boolean; span: number } {
  const d: number[] = [];
  for (let i = 1; i < series.length; i++) d.push(series[i] - series[i - 1]);
  const nz = d.filter((v) => Math.abs(v) > 1e-12);
  const stepsEqual = nz.length === d.length
    && d.every((v) => Math.abs(v - d[0]) < 1e-12);
  const hasStill = d.some((v) => v === 0);
  // 「回到起點」用一個 ±2e-3 的窗去接是行不通的:瓦楞紙一幀就走 0.026,窗子接不到
  // 那個點(第一版量到 1 次而實際上是 9 次)。改成數**跨過自己平均值**的次數 ——
  // 單調的序列一定恰好 1 次,週期的序列是每個週期兩次,而且三個世界可以拿同一支
  // 尺量(它不需要知道誰的靜止值是多少)。
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  let returns = 0;
  for (let i = 1; i < series.length; i++) {
    if ((series[i - 1] - mean) * (series[i] - mean) < 0) returns++;
  }
  const monotone = d.every((v) => v >= -1e-12) || d.every((v) => v <= 1e-12);
  return { stepsEqual, hasStill, returns, monotone,
    span: Math.max(...series) - Math.min(...series) };
}
{
  // ⚠ 形狀是在**前 90 幀**上量的,不是全部 190 幀,而且 fixture 的踏頻是 110 rpm。
  //   兩件事都是被突變測試逼出來的:BUB_CAP = 96 比 190 小,所以「每幀都生」的
  //   突變會在第 96 顆撞到上限、之後 count 不再變 —— 靜止幀又回來了,離散那一條
  //   就抓不到它。90 < 96,而 110 rpm 讓原版每 6 幀生一顆(靜止幀很多)、突變版
  //   每一幀都生(一個靜止幀都沒有)。
  const SHAPE_N = 90, SHAPE_CAD = 110;
  const win = (s: Shape): number[] => s.series.slice(0, SHAPE_N);
  const c = describe(win(circuitShape(SHAPE_CAD)));
  const p = describe(win(plasticShape(SHAPE_CAD, 200)));
  const q = describe(win(paperShape(SHAPE_CAD, 200)));
  const row = (n: string, x: ReturnType<typeof describe>): string =>
    `${n} 等步長 ${x.stepsEqual ? 'Y' : 'N'} / 有靜止幀 ${x.hasStill ? 'Y' : 'N'}`
    + ` / 跨過平均值 ${x.returns} 次`;

  check('電子 = **連續等速**:每一幀都動,而且步長全部相等',
    c.stepsEqual && !c.hasStill, row('circuit', c));
  check('積木 = **離散顆粒**:存在「這一幀什麼都沒生」的幀,所以步長不可能全相等',
    p.hasStill && !p.stepsEqual, row('plastic', p));
  check('瓦楞紙 = **週期整體**:同一段時間裡來回跨過平均值好幾次,而且有界',
    q.returns >= 4 && q.span < 0.4 && !q.monotone,
    `${row('paper', q)},振幅 ${q.span.toFixed(4)}`);
  // 對角線:一個世界一個 ✓、一個欄位一個 ✓。任何一個世界被改成另一種形狀
  // (例如把瓦楞紙的 sin 換成線性、把積木的累加器改成每幀都生)都會讓它塌掉。
  const col = [
    [c.stepsEqual, p.stepsEqual, q.stepsEqual],
    [c.hasStill, p.hasStill, q.hasStill],
    // 週期那一格要跟上面瓦楞紙那條同一個判準(來回 + 有界 + 非單調)。只問「跨過
    // 平均值幾次」的話,把 sin 換成線性得到的**鋸齒**也會跨很多次 —— 突變測試
    // 走過這裡一次:那個突變被「有界」抓到了,對角線卻一聲不吭。
    [c.returns >= 4 && c.span < 0.4 && !c.monotone,
      p.returns >= 4 && p.span < 0.4 && !p.monotone,
      q.returns >= 4 && q.span < 0.4 && !q.monotone],
  ];
  check('對角線:三個描述子每一個只有一個世界為真 —— 三種**種類**,不是三個名字',
    col.every((v) => v.filter(Boolean).length === 1)
    && col[0][0] && col[1][1] && col[2][2],
    col.map((v) => v.map((b) => (b ? 'Y' : 'N')).join('')).join(' | '));

  // 源碼那一半:三個世界寫的**出貨欄位種類**互斥。這不是比名字,是比「寫到哪一類
  // GPU 狀態」—— 把積木的泡泡改成一張捲動的貼圖(跟電子同類)就會失敗。
  const SLOTS: Array<[string, RegExp]> = [
    ['texture-offset', /\.offset\.x\s*[-+]?=/],
    ['draw-count', /\.count\s*=\s*bubbles\.length|\.count\s*=\s*\w+\.length/],
    ['node-scale', /\.scale\.set\(/],
    ['node-rotation', /\.rotation\.z\s*=\s*\w+\.z0/],
    ['material-color', /\.mat\.color\.copy\(/],
  ];
  const react: Record<World, string> = {
    circuit: span(SRC.circuit, '      pulseU -= dt * cadenceSpeed()',
      'pulseTex.offset.x = pulseU;', 'circuit pulse'),
    plastic: upTo(SRC.plastic, '  const BUB_CAP = 96;',
      '\n  const orbit = { theta: 0.6', 'plastic bubbles'),
    paper: upTo(SRC.paper, '  const BEAT_SQUASH = 0.085;',
      '\n  onPedal(applyNib);', 'paper beat+nib'),
  };
  const sets = WORLDS.map((w) => SLOTS.filter(([, re]) => re.test(react[w])).map(([n]) => n));
  const uniq = (i: number): string[] =>
    sets[i].filter((s) => !sets[(i + 1) % 3].includes(s) && !sets[(i + 2) % 3].includes(s));
  check('三個世界寫的出貨欄位**各有一類是別人沒有的**(不是同一種反應換顏色)',
    uniq(0).length > 0 && uniq(1).length > 0 && uniq(2).length > 0
    && sets[0].includes('texture-offset') && sets[1].includes('draw-count')
    && sets[2].includes('node-scale'),
    WORLDS.map((w, i) => `${w}: ${sets[i].join('+') || '(無)'}`).join(' | '));
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[pedal: 每一支新滑桿真的改到**出貨的東西**]');
// ═════════════════════════════════════════════════════════════════════════════
{
  // ── 積木:泡泡速率(踏頻)──
  // fixture 是刻意挑的:六個踏頻檔位生出六個**不同**的累計顆數。這一條印出來的
  // 那六個數字就是「fixture 挑對了」的證據 —— 換成 dt = 1/60 的話 85 rpm 與
  // 86 rpm 會落在同一個 Math.floor 上,那種 fixture 什麼都證明不了。
  const byCadence = [60, 70, 80, 90, 100, 110]
    .map((cad) => plasticShape(cad, 200).series[N - 1]);
  check('泡泡速率:踏頻掃過六檔 → 六個**不同**的累計顆數,而且嚴格遞增',
    new Set(byCadence).size === 6
    && byCadence.every((v, i) => i === 0 || v > byCadence[i - 1]),
    `${byCadence.join(' → ')} 顆(dt ${DT}s × ${N} 幀 × 3 根噴口)`);
  const byGain = [0, 0.5, 1, 1.5, 2, 3]
    .map((g) => plasticShape(85, 200, { bub: g }).series[N - 1]);
  // 0 顆的時候那一批要**連 visible 都關掉**,不是只有 count = 0。理由是量出來的:
  // scene-census 的 isShown() 只看 visible(往上找 parent),一個 count = 0 的
  // InstancedMesh 照樣被算成一個 draw call —— 實測 ?bub=0 在關掉 visible 之前是
  // 253 個 draw call、關掉之後回到 252(= 改動前的數字)。§4.5.5 第 4 點寫「count
  // = 0 / visible = false 的批次在 isShown() 那一關被跳過」,真正做事的只有後者。
  {
    type Vis = { shown: boolean[]; shownAtBuild: boolean };
    const off = plasticShape(85, 200, { bub: 0 }).extra as Vis;
    const on = plasticShape(85, 200, { bub: 1 }).extra as Vis;
    check('泡泡速率 0×:那一批**連 visible 都關掉**,而且宣告時就是關的'
      + '(不然 census / render-probe 照樣算它一個 draw call)',
      off.shownAtBuild === false && on.shownAtBuild === false
      && off.shown.every((v) => v === false) && on.shown.some((v) => v === true),
      `宣告時 ${on.shownAtBuild};0× visible ${off.shown.filter(Boolean).length}/`
      + `${off.shown.length} 幀,1× ${on.shown.filter(Boolean).length}/${on.shown.length} 幀`);
  }
  check('泡泡速率滑桿(?bub=)真的到得了出貨:0× 一顆都不生,往上掃六檔六個不同的數',
    byGain[0] === 0 && new Set(byGain).size === 6
    && byGain.every((v, i) => i === 0 || v > byGain[i - 1]),
    `${byGain.join(' → ')} 顆`);

  // ── 積木:泡泡大小(功率)—— 讀回**instance 矩陣**,不是讀那個變數 ──
  const scaleAt = (w: number, g: number): number => {
    const r = plasticShape(85, w, { bubsz: g }).extra as { scales: number[] };
    return r.scales[0];
  };
  const sLo = scaleAt(80, 1), sHi = scaleAt(320, 1);
  const gLo = scaleAt(200, 0.4), gHi = scaleAt(200, 2.5);
  check('泡泡大小:功率 80 → 320 W 讓 instance 矩陣的 scale 變大 ≥ 3.5 倍',
    sHi / sLo >= 3.5, `${sLo.toFixed(4)} → ${sHi.toFixed(4)}(×${(sHi / sLo).toFixed(2)})`);
  check('泡泡大小滑桿(?bubsz=)真的到得了那個矩陣:0.4× 與 2.5× 相差 ≥ 6 倍',
    gHi / gLo >= 6, `${gLo.toFixed(4)} → ${gHi.toFixed(4)}(×${(gHi / gLo).toFixed(2)})`);

  // ── 瓦楞紙:擺動幅度 ──
  const beat0 = paperShape(85, 200, { beat: 0 });
  const beat1 = paperShape(85, 200, { beat: 1 });
  const beat3 = paperShape(85, 200, { beat: 3 });
  const e0 = beat0.extra as { cardBase: number[]; cardNow: number[]; swz: number[] };
  check('擺動幅度 0×:房子的 scale 精確回到 1,樹卡片的 instance 矩陣**逐位元組**原樣',
    beat0.series.every((v) => v === 1)
    && e0.cardNow.every((v, i) => Object.is(v, e0.cardBase[i]))
    && e0.swz.every((v) => v === 0.031),
    `scale ${beat0.series[0]} / 矩陣 ${e0.cardNow.length} 個 float 全等`);
  const amp = (s: Shape): number => Math.max(...s.series) - Math.min(...s.series);
  const e3 = beat3.extra as { cardBase: number[]; cardNow: number[] };
  check('擺動幅度滑桿(?beat=)真的到得了出貨:3× 的振幅 ≥ 1× 的 2.9 倍,而且矩陣真的動了',
    amp(beat3) / amp(beat1) >= 2.9
    && e3.cardNow.some((v, i) => v !== e3.cardBase[i]),
    `1× ${amp(beat1).toFixed(5)} → 3× ${amp(beat3).toFixed(5)}`
    + `(×${(amp(beat3) / amp(beat1)).toFixed(2)})`);

  // ── 瓦楞紙:拍子倍率 ──
  // ⚠ 這裡就是「取模在測試資料上剛好一致」最容易發生的地方。0.0173 s × 190 幀 =
  //   3.287 s 不是任何一個週期的整數倍,所以 0.5× / 1× / 2× 的跨越次數不會被
  //   同一個取整壓成同一個數:量到 4 / 9 / 18。
  const cross = (s: Shape): number => {
    let n = 0;
    for (let i = 1; i < s.series.length; i++) {
      if ((s.series[i - 1] - 1) * (s.series[i] - 1) < 0) n++;
    }
    return n;
  };
  const c05 = cross(paperShape(85, 200, { beathz: 0.5 }));
  const c10 = cross(paperShape(85, 200, { beathz: 1 }));
  const c20 = cross(paperShape(85, 200, { beathz: 2 }));
  check('拍子倍率滑桿(?beathz=)真的改頻率:0.5× / 1× / 2× 的跨越次數約成 1:2:4',
    c05 >= 3 && Math.abs(c10 - 2 * c05) <= 1 && Math.abs(c20 - 2 * c10) <= 1
    && new Set([c05, c10, c20]).size === 3,
    `${c05} / ${c10} / ${c20} 次(3.287 s,踏頻 85 rpm → 1 拍 = ${
      (paperShape(85, 200).extra as { beatHz: number }).beatHz.toFixed(4)} Hz)`);

  // ── 瓦楞紙:筆壓 ──
  const nibDef = paperShape(85, 200).extra as {
    nibWidth: number; dashColor: number; dashOrig: number;
    sleeveColor: number; sleeveOrig: number;
    dashBaseM: number[]; dashNow: number[];
  };
  check('筆壓在**預設**(200 W、1×)出貨的東西逐位元組沒動:線寬精確 1.0、'
    + '虛線矩陣逐位元組原樣、兩支筆的顏色精確等於材質原色',
    nibDef.nibWidth === 1
    && nibDef.dashNow.every((v, i) => Object.is(v, nibDef.dashBaseM[i]))
    && nibDef.dashColor === nibDef.dashOrig && nibDef.sleeveColor === nibDef.sleeveOrig,
    `線寬 ${nibDef.nibWidth},虛線 #${nibDef.dashColor.toString(16)}`
    + ` / 紙套墨 #${nibDef.sleeveColor.toString(16)}`);
  const nibLo = paperShape(85, 200, { nib: 0.2 }).extra as typeof nibDef;
  const nibHi = paperShape(85, 200, { nib: 3 }).extra as typeof nibDef;
  const dashScale = (r: typeof nibDef): number => {
    const m = new THREE.Matrix4().fromArray(r.dashNow, 0);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    return s.x;
  };
  const wLo = dashScale(nibLo), wHi = dashScale(nibHi), wDef = dashScale(nibDef);
  check('筆壓滑桿(?nib=)真的到得了出貨,而且**兩邊反向**:0.2× 的線比預設細、'
    + '3× 的比預設粗,墨色也跟著兩邊各走一邊',
    wLo < wDef * 0.98 && wHi > wDef * 1.02
    && nibLo.dashColor !== nibDef.dashColor && nibHi.dashColor !== nibDef.dashColor
    && nibLo.sleeveColor !== nibDef.sleeveColor && nibHi.sleeveColor !== nibDef.sleeveColor,
    `線寬 ${wLo.toFixed(4)} < ${wDef.toFixed(4)} < ${wHi.toFixed(4)};`
    + ` 墨 #${nibLo.dashColor.toString(16)} / #${nibDef.dashColor.toString(16)}`
    + ` / #${nibHi.dashColor.toString(16)}`);

  // ── 功率來源真的走到造型層 ──
  //
  // 這一條把 PEDAL 區塊與造型之間那條線釘住,而它是**兩個執行結果串起來的**:
  // 區塊把「320 W + 估計 + trust」收成一個可信瓦數,世界再對那個數字反應。
  //
  // ⚠ 第一版是恆真句 —— 兩邊都是同一個 `paperShape(85, 200)`。現在可信瓦數是從
  //   跑過的區塊讀回來的,而且兩支 harness 都另外餵一個**不同的量測瓦數**,所以
  //   「世界讀錯那一個」(讀 wattsMeter 而不是 watts)也會失敗。
  const trustedEst = runPedal('?w=320&psrc=estimated&trust=0', false).peek().watts;
  const trustedMeter = runPedal('?w=320', false).peek().watts;
  const w320 = paperShape(85, trustedMeter, {}, 320).extra as typeof nibDef;
  const w200 = paperShape(85, 200, {}, 320).extra as typeof nibDef;
  const est0 = paperShape(85, trustedEst, {}, 320).extra as typeof nibDef;
  check('功率來源走到瓦楞紙的筆壓:估計 + trust=0 的線寬 === 200 W 的,而量測 320 W 不同',
    trustedEst === 200 && trustedMeter === 320
    && est0.nibWidth === w200.nibWidth && w320.nibWidth !== w200.nibWidth,
    `可信 ${trustedEst} W → 線寬 ${est0.nibWidth.toFixed(4)};`
    + ` 量測 ${trustedMeter} W → ${w320.nibWidth.toFixed(4)}`);
  // 積木那一側同一件事:泡泡大小吃的也必須是可信瓦數。
  const bubEst = (plasticShape(85, trustedEst, {}, 320).extra as { scales: number[] }).scales[0];
  const bubMeter = (plasticShape(85, trustedMeter, {}, 320).extra as { scales: number[] })
    .scales[0];
  const bub200 = (plasticShape(85, 200, {}, 320).extra as { scales: number[] }).scales[0];
  check('功率來源走到積木的泡泡大小:估計 + trust=0 的 scale === 200 W 的,而量測 320 W 不同',
    bubEst === bub200 && bubMeter !== bub200,
    `可信 ${bubEst.toFixed(4)} / 量測 ${bubMeter.toFixed(4)}`);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[pedal: 面板那幾列真的接到旋鈕上]');
// ═════════════════════════════════════════════════════════════════════════════
{
  // 每一支新滑桿都必須:(1) 是世界宣告的旋鈕、(2) 在面板的 SWITCHES 表裡有一列、
  // (3) 那一列不自帶範圍/預設(範圍只能有一個來源)。
  const expected: Record<World, string[]> = {
    circuit: ['trust'],
    plastic: ['trust', 'bub', 'bubsz'],
    paper: ['trust', 'beat', 'beathz', 'nib'],
  };
  for (const w of WORLDS) {
    const s = SRC[w];
    const declared = [...s.matchAll(/pedalKnob\('([a-z]+)'/g)].map((m) => m[1]).sort();
    const rows = [...s.matchAll(/\{ kind: 'pedal', key: '([a-z]+)'/g)].map((m) => m[1]).sort();
    const want = [...expected[w]].sort();
    check(`${w}: 宣告的旋鈕 = 面板的列 = 預期那幾支`,
      declared.join(',') === want.join(',') && rows.join(',') === want.join(','),
      `宣告 ${declared.join('/')};面板 ${rows.join('/')}`);
    // 範圍與預設只能住在世界那一側 —— 表裡再寫一份就會分岔(而且沒有人看得見)。
    const rowSrc = [...s.matchAll(/\{ kind: 'pedal',[\s\S]*?\n(?=    \{|  \];)/g)]
      .map((m) => m[0]).join('');
    check(`${w}: 面板那幾列沒有自帶 min / max / def(範圍只有一個來源)`,
      !/\bmin:|\bmax:|\bdef:|\bstep:/.test(rowSrc), rowSrc.length + ' chars');
  }
  // 控制列那一段 markup 三份逐字相同(DEMO_POC_GUIDE §5:三份獨立的 HTML、控制列
  // 複製三次,最容易長出「只有積木那份有那顆按鈕」這種分岔)。CSS **刻意不比** ——
  // 那是造型,三個世界本來就該長得不一樣。
  {
    const html = WORLDS.map((w) => readFileSync(DEMOS[w], 'utf8'));
    const bars = html.map((h) => span(h, '<div class="pedal">', '</div>', 'pedal bar'));
    check('控制列的 .pedal 那一段 markup 三份逐字相同(§5)',
      bars.every((b) => b === bars[0])
      && ['id="rpm"', 'id="pwr"', 'id="btn-psrc"'].every((k) => bars[0].includes(k)),
      `${bars[0].length} chars`
      + (bars.every((b) => b === bars[0]) ? '' : ` / ${bars.map((b) => b.length).join(' vs ')}`));
  }
  // 面板的 `pedal` 那一支渲染分支三份逐字相同(它是機制)。
  const branch = WORLDS.map((w) => span(SRC[w], "    } else if (sw.kind === 'pedal') {",
    "    } else if (sw.kind === 'range') {", `${w} panel branch`));
  check('設定面板的 `pedal` 渲染分支三份逐字相同(它是機制,不是造型)',
    branch.every((b) => b === branch[0]) && branch[0].length > 400,
    `${branch[0].length} chars`);
}
