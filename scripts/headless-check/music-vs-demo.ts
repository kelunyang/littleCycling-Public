/**
 * 主題配樂對 demo 逐事件比對 —— `plan/theme-music-demo-opus.html` vs
 * `packages/web/src/game/audio/generative-bgm.ts`。
 *
 * 音樂沒辦法用聽的驗(這裡沒有耳朵),但**會壞的東西幾乎全是可比對的資料**:
 *
 *   - 音符表本身就是資料:t / dur / midi / vel / voice、bpm、拍號、小節數。
 *     少一小節、音程差一個半音、動機細胞抽錯一個,逐欄比對都看得見。
 *   - **Web Audio graph 就是那個要 diff 的產物。** 節點型別、連線拓樸、每一個
 *     排上時間軸的參數(頻率、增益、時刻、長度、曲線種類、Q、detune)全部
 *     可觀測 —— 只要兩邊都跑在同一支會錄音的 stub 上。
 *   - 排程器可以真的驅動:餵同一串 currentTime,兩邊必須排出同一組
 *     (音符, 絕對時刻)。lookahead、`now - 0.05` 那個窗、循環回捲、
 *     `startAt + 0.12`,錯一個就對不上。
 *
 * 做法照 `CUSTOM_WORLD_INSTRUCTIONS.md` §0.0 第 5 點:**把 demo 的原始碼從
 * HTML 切出來執行**,再跟正式版比。這裡不存在任何從 demo 抄進檢查的常數 ——
 * 抄過來的常數只會把當初打錯的東西再確認一遍。
 *
 * 驗不到的東西(必須誠實寫下來):**音色好不好聽**。兩邊送出一模一樣的節點與
 * 參數,就代表兩邊會發出一模一樣的聲音;但那個聲音是不是想要的,只有耳朵知道。
 */

import { readFileSync } from 'node:fs';

type Check = (label: string, ok: boolean, detail?: string) => void;

const DEMO = 'plan/theme-music-demo-opus.html';

/** demo 的世界 key → 遊戲的 WorldStyle。demo 叫 paper,遊戲叫 cuphead。 */
const WORLD_MAP: ReadonlyArray<readonly [demo: string, game: string]> = [
  ['plastic', 'plastic'],
  ['paper', 'cuphead'],
  ['circuit', 'circuit'],
];

const SEED = 12345;

/* ── 錄音用的 Web Audio stub ─────────────────────────────────────────────
 *
 * 每個節點拿一個 `kind#n` 的序號 id,所以 **id 相等本身就是一條拓樸斷言**:
 * 兩邊要在同一個順序建出同一種節點,序號才會對得上。
 */

type Op = unknown[];

/** Float32Array 的整數雜湊 —— 噪音緩衝與 PeriodicWave 係數都靠它比。 */
function hashF32(a: Float32Array): number {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) {
    h = Math.imul(h ^ (Math.round(a[i] * 1e6) | 0), 16777619);
  }
  return h >>> 0;
}

const norm = (v: unknown): unknown => (typeof v === 'number' && Object.is(v, -0) ? 0 : v);

interface Recorder {
  ops: Op[];
  ctx: any;
  /** 取走並清空自上次以來錄到的事件。 */
  take(): Op[];
  /** setInterval 被叫過幾次、間隔多少。 */
  timers: number[];
  install(): void;
  restore(): void;
}

function makeRecorder(): Recorder {
  const ops: Op[] = [];
  const timers: number[] = [];
  let uid = 0;

  function param(ownerId: string, name: string): any {
    const pid = `${ownerId}.${name}`;
    const p: any = {
      _pid: pid,
      _v: 0,
      get value() { return p._v; },
      set value(v: number) { ops.push(['param', pid, 'value', norm(v)]); p._v = v; },
      setValueAtTime(v: number, t: number) { ops.push(['param', pid, 'setValueAtTime', norm(v), norm(t)]); return p; },
      linearRampToValueAtTime(v: number, t: number) { ops.push(['param', pid, 'linearRamp', norm(v), norm(t)]); return p; },
      exponentialRampToValueAtTime(v: number, t: number) { ops.push(['param', pid, 'expRamp', norm(v), norm(t)]); return p; },
      setTargetAtTime(v: number, t: number, tc: number) { ops.push(['param', pid, 'setTarget', norm(v), norm(t), norm(tc)]); return p; },
      cancelScheduledValues(t: number) { ops.push(['param', pid, 'cancel', norm(t)]); return p; },
    };
    return p;
  }

  function mknode(kind: string, extra: unknown[] = []): any {
    const id = `${kind}#${uid++}`;
    ops.push(['create', id, ...extra]);
    const n: any = {
      _id: id,
      connect(dst: any) {
        ops.push(['connect', id, dst?._id ?? dst?._pid ?? String(dst)]);
        return dst;
      },
      disconnect(dst?: any) { ops.push(['disconnect', id, dst?._id ?? dst?._pid ?? '*']); },
      start(t?: number) { ops.push(['start', id, t === undefined ? 'now' : norm(t)]); },
      stop(t?: number) { ops.push(['stop', id, t === undefined ? 'now' : norm(t)]); },
      setPeriodicWave(w: any) { ops.push(['setPeriodicWave', id, w?._id ?? String(w)]); },
    };
    n.frequency = param(id, 'frequency');
    n.detune = param(id, 'detune');
    n.gain = param(id, 'gain');
    n.Q = param(id, 'Q');
    n.delayTime = param(id, 'delayTime');
    n.playbackRate = param(id, 'playbackRate');
    for (const prop of ['type', 'loop', 'loopStart', 'loopEnd', 'channelCount']) {
      let v: unknown;
      Object.defineProperty(n, prop, {
        get: () => v,
        set: (x) => { v = x; ops.push(['prop', id, prop, norm(x)]); },
      });
    }
    let buf: any;
    Object.defineProperty(n, 'buffer', {
      get: () => buf,
      // 內容在 createBuffer 之後才被填,所以雜湊要等到 buffer 被指派給 source
      // 的這一刻才算 —— brush 的 `* 0.6` 就是靠這個看得見。
      set: (b) => { buf = b; ops.push(['prop', id, 'buffer', b?._id ?? String(b), b ? hashF32(b._data) : 0]); },
    });
    return n;
  }

  const destination = { _id: 'dest', connect() { return destination; }, disconnect() {} };

  const ctx: any = {
    currentTime: 1,
    sampleRate: 48000,
    state: 'running',
    destination,
    resume() { ops.push(['resume']); },
    close() { ops.push(['close']); },
    createGain: () => mknode('gain'),
    createOscillator: () => mknode('osc'),
    createBiquadFilter: () => mknode('filter'),
    createBufferSource: () => mknode('bufsrc'),
    createDelay: (max: number) => mknode('delay', [norm(max)]),
    createBuffer(ch: number, len: number, sr: number) {
      const id = `buf#${uid++}`;
      const data = new Float32Array(Math.max(1, len | 0));
      ops.push(['create', id, ch, len, sr]);
      return {
        _id: id, _data: data, length: data.length, sampleRate: sr,
        numberOfChannels: ch, getChannelData: () => data,
      };
    },
    createPeriodicWave(re: Float32Array, im: Float32Array, opts: any) {
      const id = `wave#${uid++}`;
      ops.push(['create', id, hashF32(re), hashF32(im), re.length, im.length,
        opts?.disableNormalization ?? null]);
      return { _id: id };
    },
    // 這個專案不准有取樣檔(見 DEVPLAN「外部資料源與版權」)。踩到就是硬錯。
    decodeAudioData() { throw new Error('decodeAudioData — BGM must stay fully synthesised'); },
  };

  // Math.random 也要決定性,不然噪音緩衝的雜湊每次都不一樣。兩邊各自從同一顆
  // 種子起跑,所以「某一邊多抽了一次 random」會直接讓後面全部對不上 —— 那正是
  // 想抓的東西。
  let rndState = 0x9e3779b9;
  const seededRandom = (): number => {
    rndState |= 0; rndState = rndState + 0x6D2B79F5 | 0;
    let t = Math.imul(rndState ^ rndState >>> 15, 1 | rndState);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };

  // demo 的 build() 會去碰 DOM(進度燈),所以 document stub 必須在**整段互動**
  // 期間都在,不只是 load 的那一瞬間 —— diorama 自己的 document stub 只認 canvas,
  // 一碰 createElement('i') 就丟例外。
  const els = new Map<string, any>();
  const mkEl = (): any => ({
    textContent: '', innerHTML: '', dataset: {}, className: '', children: [],
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener() {}, setAttribute() {},
    appendChild(c: any) { this.children.push(c); },
  });

  const saved: Record<string, unknown> = {};
  return {
    ops, ctx, timers,
    take() { return ops.splice(0, ops.length); },
    install() {
      saved.random = Math.random;
      saved.setInterval = globalThis.setInterval;
      saved.clearInterval = globalThis.clearInterval;
      saved.document = (globalThis as any).document;
      saved.window = (globalThis as any).window;
      rndState = 0x9e3779b9;
      Math.random = seededRandom;
      // 排程器的 timer 不能真的跑 —— 檢查要自己餵 currentTime。順便把間隔錄下來。
      (globalThis as any).setInterval = (fn: () => void, ms: number) => {
        timers.push(ms);
        (globalThis as any).__lastTimerFn = fn;
        return timers.length;
      };
      (globalThis as any).clearInterval = () => {};
      (globalThis as any).document = {
        getElementById: (id: string) => {
          if (!els.has(id)) els.set(id, mkEl());
          return els.get(id);
        },
        querySelectorAll: () => [],
        createElement: () => mkEl(),
        body: { dataset: {} },
      };
      (globalThis as any).window = { AudioContext: function () { return ctx; } };
    },
    restore() {
      Math.random = saved.random as typeof Math.random;
      (globalThis as any).setInterval = saved.setInterval;
      (globalThis as any).clearInterval = saved.clearInterval;
      (globalThis as any).document = saved.document;
      (globalThis as any).window = saved.window;
    },
  };
}

/* ── demo 側:把 HTML 裡的 script 切出來執行 ─────────────────────────── */

interface DemoApi {
  WORLDS: Record<string, { compose: (seed: number) => any; label: string }>;
  VOICES: Record<string, (n: any, t: number) => void>;
  initAudio: () => void;
  startDrone: (world: string) => void;
  stopDrone: () => void;
  schedule: () => void;
  play: () => void;
  stop: () => void;
  LOOKAHEAD: number;
  TICK: number;
  _set: (w: string, s: number) => void;
  _piece: () => any;
}

function demoSource(): string {
  const html = readFileSync(DEMO, 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!blocks.length) throw new Error(`no <script> in ${DEMO}`);
  return blocks[blocks.length - 1];
}

/**
 * 執行 demo 的 app script,把需要的 module-scope binding 交回來。
 * 呼叫前 recorder 必須已經 install()(document / window.AudioContext 都在它手上)。
 *
 * `_set` / `_piece` 是 epilogue 裡的 arrow —— 它們閉包在 demo 自己的
 * module scope 上,所以 `world` / `seed` / `piece` 這些 `let` 都是**同一個**,
 * 不是複本。排程器因此可以被真的驅動。
 */
function loadDemo(): DemoApi {
  const epilogue = `
return {
  WORLDS, VOICES, initAudio, startDrone, stopDrone, schedule, play, stop,
  LOOKAHEAD, TICK,
  _set: (w, s) => { world = w; seed = s; },
  _piece: () => piece,
};`;
  return new Function(`${demoSource()}\n${epilogue}`)() as DemoApi;
}

/* ── 比對工具 ───────────────────────────────────────────────────────── */

/** 兩串事件第一個對不上的位置,連前後文一起講出來。 */
function firstDiff(a: Op[], b: Op[]): string {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const sa = i < a.length ? JSON.stringify(a[i]) : 'END';
    const sb = i < b.length ? JSON.stringify(b[i]) : 'END';
    if (sa !== sb) {
      const ctxLine = i > 0 ? ` (after ${JSON.stringify(a[i - 1])})` : '';
      return `event ${i}${ctxLine}: demo ${sa} vs ours ${sb}`;
    }
  }
  return '';
}

function sameStream(check: Check, label: string, demo: Op[], ours: Op[]): void {
  const d = firstDiff(demo, ours);
  check(label, d === '' && demo.length > 0,
    d || `${demo.length} audio events identical`);
}

/* ── 主檢查 ─────────────────────────────────────────────────────────── */

export async function checkThemeMusicVsDemo(check: Check): Promise<void> {
  console.log(`\n[theme music vs demo — ${DEMO}]`);

  const bgmMod = await import('@/game/audio/generative-bgm');
  const { GenerativeBgm, compose, WORLDS, seedFromString } = bgmMod as any;

  // ── 0. 這個專案不准有取樣檔 ──
  const srcPath = 'packages/web/src/game/audio/generative-bgm.ts';
  const src = readFileSync(srcPath, 'utf8');
  const sampleish = /decodeAudioData|\bfetch\s*\(|XMLHttpRequest|new Audio\b|\.(mp3|wav|ogg|sf2|flac)\b/i;
  check('everything stays synthesised — no sample/SoundFont/audio file anywhere',
    !sampleish.test(src),
    'only OscillatorNode + createBuffer white noise (DEVPLAN「外部資料源與版權」)');

  // ── 1. demo 宣告的世界 ↔ 遊戲的 WorldStyle ──
  const probe = makeRecorder();
  probe.install();
  let demoProbe: DemoApi;
  try {
    demoProbe = loadDemo();
  } finally {
    probe.restore();
  }
  const demoKeys = Object.keys(demoProbe.WORLDS);
  check('demo declares exactly the three worlds the game has',
    demoKeys.length === 3 && WORLD_MAP.every(([d]) => demoKeys.includes(d)),
    `demo: ${demoKeys.join(', ')} → game: ${WORLD_MAP.map(([, g]) => g).join(', ')}`);
  check('the shipping WORLDS table is keyed by WorldStyle and covers all three',
    Object.keys(WORLDS).sort().join(',') === 'circuit,cuphead,plastic',
    Object.keys(WORLDS).join(', '));
  for (const [d, g] of WORLD_MAP) {
    check(`label carried over verbatim: ${g} = ${demoProbe.WORLDS[d].label}`,
      WORLDS[g]?.label === demoProbe.WORLDS[d].label,
      `ours "${WORLDS[g]?.label}"`);
  }

  // ── 2. 每個世界:曲子本身(資料層) ──
  //
  // **一顆種子不夠。** 突變測試第一輪就證明了:`if (rng() < 0.22) continue` 改成
  // 0.25、`Math.floor` 改成 `Math.trunc`(只有負的音階級數會不同),兩個在
  // seed 12345 下都活了下來 —— 前者是那一顆種子剛好沒抽到 0.22–0.25 之間,
  // 後者是那一顆種子剛好沒抽到含 -1 的動機細胞。分支要被走到才驗得到,
  // 所以這裡掃一排種子,包含真的從路線 id 長出來的那種。
  const SEEDS = [SEED, 777, 4242, 1, 0xffffffff, 20250720,
    seedFromString('taipei-riverside'), seedFromString('route-abc'),
    seedFromString('sun-moon-lake'), seedFromString('wuling')];

  const voicesSeen = new Set<string>();
  const motifsSeen = new Set<string>();
  for (const [dw, gw] of WORLD_MAP) {
    const demoPiece = demoProbe.WORLDS[dw].compose(SEED);
    demoPiece.notes.sort((a: any, b: any) => a.t - b.t);
    const ourPiece = compose(gw, SEED);

    check(`${gw}: tempo / metre / length match the demo`,
      demoPiece.bpm === ourPiece.bpm
      && demoPiece.beatsPerBar === ourPiece.beatsPerBar
      && demoPiece.bars === ourPiece.bars,
      `${ourPiece.bpm}bpm ${ourPiece.beatsPerBar}/4 ${ourPiece.bars}bar`);

    // 逐顆種子比整張音符表 + desc(desc 裡帶著抽到的動機,所以連 rng 的抽取
    // 順序都被釘住了)
    let where = '';
    for (const s of SEEDS) {
      const dp = demoProbe.WORLDS[dw].compose(s);
      dp.notes.sort((a: any, b: any) => a.t - b.t);
      const op = compose(gw, s);
      motifsSeen.add(`${gw}:${op.desc}`);
      if (dp.desc !== op.desc) { where = `seed ${s}: demo desc "${dp.desc}" vs ours "${op.desc}"`; break; }
      const dJson = JSON.stringify(dp.notes);
      const oJson = JSON.stringify(op.notes);
      if (dJson === oJson) continue;
      const n = Math.max(dp.notes.length, op.notes.length);
      for (let i = 0; i < n; i++) {
        const a = JSON.stringify(dp.notes[i] ?? null);
        const b = JSON.stringify(op.notes[i] ?? null);
        if (a !== b) { where = `seed ${s}, note ${i}: demo ${a} vs ours ${b}`; break; }
      }
      break;
    }
    check(`${gw}: every note (t/dur/midi/vel/voice) identical to the demo, over ${SEEDS.length} seeds`,
      where === '', where || `${ourPiece.notes.length} notes at seed ${SEED}`);

    // 「一個聲部從頭到尾沒被用到」是移植時很容易掉的東西
    const dVoices = [...new Set(demoPiece.notes.map((n: any) => n.voice))].sort();
    const oVoices = [...new Set(ourPiece.notes.map((n: any) => n.voice))].sort();
    check(`${gw}: same set of voices in play`,
      JSON.stringify(dVoices) === JSON.stringify(oVoices),
      (oVoices as string[]).join('/'));
    for (const v of oVoices as string[]) voicesSeen.add(v);

    // 每小節都要有東西 —— 死小節是聽得出來的洞。每一顆種子都要成立。
    let dead = '';
    for (const s of SEEDS) {
      const p = compose(gw, s);
      const len = p.bars * p.beatsPerBar;
      const perBar = new Array(p.bars).fill(0);
      for (const n of p.notes) perBar[Math.floor(n.t / p.beatsPerBar)]++;
      if (!perBar.every((c: number) => c > 0)) { dead = `seed ${s}: silent bar(s)`; break; }
      if (!p.notes.every((n: any) => n.t < len)) { dead = `seed ${s}: a note past the loop end`; break; }
    }
    check(`${gw}: no silent bar, and nothing spills past the loop, on any seed`,
      dead === '', dead || `${ourPiece.bars} bars`);
  }

  // 掃過的種子必須真的抽到過不只一個動機 —— 否則上面那圈只是同一首驗了十次。
  check('the seed sweep actually reaches different motif cells (the branches get walked)',
    motifsSeen.size > WORLD_MAP.length * 2,
    `${motifsSeen.size} distinct (world, motif) combinations across ${SEEDS.length} seeds`);

  check('every voice the demo defines is actually reached by some world',
    voicesSeen.size === Object.keys(demoProbe.VOICES).length,
    `${voicesSeen.size} of ${Object.keys(demoProbe.VOICES).length} demo voices exercised`);

  // ── 3. seed 決定曲子(路線 → 主題曲的前提) ──
  for (const [, gw] of WORLD_MAP) {
    const a = JSON.stringify(compose(gw, 777).notes);
    const b = JSON.stringify(compose(gw, 777).notes);
    const c = JSON.stringify(compose(gw, 778).notes);
    check(`${gw}: same seed → byte-identical piece`, a === b);
    check(`${gw}: a different seed → a different piece`, a !== c);
  }
  // `seedFromString` 是**遊戲側**的函式,demo 裡沒有(demo 的 seed 是介面上骰的
  // 數字),所以這一條沒有 demo 可以比 —— 它是一個 golden vector 迴歸釘,而且
  // 必須說清楚它是。改動這個雜湊不會壞掉任何一首曲子,但會讓**每一條已存在的
  // 路線換一首主題曲**,而那正是「同一條路線永遠同一首」要擋的事。
  check('route id → seed is pinned (changing it silently re-rolls every saved route\'s theme)',
    seedFromString('route-abc') === 1139906423
    && seedFromString('') === 2166136261
    && seedFromString('taipei-riverside') === 414506553,
    `"route-abc" → ${seedFromString('route-abc')}, `
    + `"" → ${seedFromString('')}, "taipei-riverside" → ${seedFromString('taipei-riverside')}`);

  // ── 4. 電子世界不再借積木的曲子(migrate-demo-worlds.md 的缺口) ──
  {
    const c = compose('circuit', SEED);
    const p = compose('plastic', SEED);
    check('circuit has a theme of its own, not the plastic one on loan',
      JSON.stringify(c.notes) !== JSON.stringify(p.notes)
      && c.bpm !== p.bpm && c.beatsPerBar !== p.beatsPerBar,
      `circuit ${c.bpm}bpm ${c.beatsPerBar}/4 vs plastic ${p.bpm}bpm ${p.beatsPerBar}/4`);
    check('circuit opens with the power-on self test — a rising square sweep in bar 0',
      (() => {
        const bar0 = c.notes.filter((n: any) => n.t < c.beatsPerBar && n.voice === 'square');
        if (bar0.length < 8) return false;
        for (let i = 1; i < 8; i++) if (bar0[i].midi <= bar0[i - 1].midi) return false;
        return true;
      })(),
      `${c.notes.filter((n: any) => n.t < c.beatsPerBar && n.voice === 'square').length} square notes in bar 0`);
  }

  // ── 5. 主輸出:結構一樣,音量是遊戲側刻意的差異 ──
  {
    const r = makeRecorder();
    r.install();
    try {
      const d = loadDemo();
      d.initAudio();
      const demoInit = r.take();
      const ours = new GenerativeBgm(r.ctx, r.ctx.destination);
      const oursInit = r.take();
      // 兩段是接著錄在同一支 recorder 上,序號自然會差,所以 id 正規化掉;
      // master 的音量刻意不同(見下),所以也遮掉 —— **其餘每一個欄位都逐字比**。
      const shape = (o: Op[]): Op[] => o.map((e) => e.map((x, i) => {
        if (i === 1 && typeof x === 'string') return x.replace(/#\d+/, '#');
        if (e[0] === 'param' && e[2] === 'value' && i === 3) return 'VOL';
        return x;
      }));
      const d1 = firstDiff(shape(demoInit), shape(oursInit));
      check('master output chain is the demo\'s, node for node (gain → destination)',
        d1 === '' && demoInit.length > 0,
        d1 || shape(oursInit).map((e) => e.join(' ')).join(' | '));
      const demoVol = (demoInit.find((e) => e[0] === 'param' && e[2] === 'value') as any)?.[3];
      const ourVol = (oursInit.find((e) => e[0] === 'param' && e[2] === 'value') as any)?.[3];
      // 刻意不同,而且說出來:demo 的 0.7 是它介面上音量滑桿的預設值;遊戲要跟
      // NES 音效與環境音混,沿用原本的 0.22。編曲內部的平衡在 VOICES 的增益裡,
      // 跟 master 無關,所以這個差不動任何一個聲部的相對音量。
      check('master gain: demo 0.7 is its volume slider, the game ships 0.22 for the mix',
        demoVol === 0.7 && ourVol === 0.22, `demo ${demoVol} / ours ${ourVol}`);
    } finally {
      r.restore();
    }
  }

  // ── 6. 每個世界:整首曲子逐音符送進真的聲部程式碼,比 audio graph ──
  // 兩顆種子:音高、力度、長度都會換一組,方波的 duty 也會落到別的格子上。
  const GRAPH_SEEDS = [SEED, 4242];
  const allOurOps: Op[] = [];
  for (const [dw, gw] of WORLD_MAP) {
    // demo 側
    const rd = makeRecorder();
    rd.install();
    let demoOps: Op[];
    let demoNoteCount = 0;
    try {
      const d = loadDemo();
      d.initAudio();
      rd.take();                                     // master 的建立不算在這一段
      for (const s of GRAPH_SEEDS) {
        const piece = d.WORLDS[dw].compose(s);
        piece.notes.sort((a: any, b: any) => a.t - b.t);
        const spb = 60 / piece.bpm;
        for (const n of piece.notes) d.VOICES[n.voice](n, 1 + n.t * spb);
        demoNoteCount += piece.notes.length;
      }
      demoOps = rd.take();
    } finally {
      rd.restore();
    }

    // 我們這側
    const ro = makeRecorder();
    ro.install();
    let ourOps: Op[];
    try {
      const bgm = new GenerativeBgm(ro.ctx, ro.ctx.destination, 0.7);
      ro.take();
      for (const s of GRAPH_SEEDS) {
        const piece = compose(gw, s);
        const spb = 60 / piece.bpm;
        for (const n of piece.notes) bgm.renderNote(n, 1 + n.t * spb);
      }
      ourOps = ro.take();
    } finally {
      ro.restore();
    }

    sameStream(check,
      `${gw}: audio graph identical over ${demoNoteCount} notes `
      + '(node types, topology, every scheduled param)',
      demoOps, ourOps);
    allOurOps.push(...ourOps);
  }

  // ── 6b. 送進 AudioParam 的每一個值都要是合理的 ──
  //
  // 這一條沒有 demo 可以比,它陳述的是規則本身。CUSTOM_WORLD_INSTRUCTIONS §0.0
  // 第 4 點:「demo 的公式沒有下界」—— 真實輸入會餵出 demo 從來沒遇過的數。
  // NaN 進 AudioParam 會**整個聲部靜音而且不丟例外**,exponentialRamp 的目標是
  // 0 或負數在真的 AudioContext 上會丟,兩個都是聽起來像「沒聲音」的無聲失敗。
  {
    const bad: string[] = [];
    for (const e of allOurOps) {
      if (e[0] !== 'param') continue;
      const [, pid, kind, v, t] = e as [string, string, string, number, number];
      if (typeof v !== 'number' || !Number.isFinite(v)) { bad.push(`${pid}.${kind} value=${v}`); break; }
      if (t !== undefined && (typeof t !== 'number' || !Number.isFinite(t) || t < 0)) {
        bad.push(`${pid}.${kind} time=${t}`); break;
      }
      if (kind === 'expRamp' && v <= 0) { bad.push(`${pid} exponentialRamp target ${v} (a real ctx throws)`); break; }
      if (pid.endsWith('.frequency') && kind !== 'value' && (v <= 0 || v > 24000)) {
        bad.push(`${pid} ${kind} ${v}Hz — outside 0..Nyquist`); break;
      }
    }
    check('no NaN / negative time / zero-target exponential ramp / out-of-band frequency '
      + 'reaches any AudioParam',
      bad.length === 0,
      bad[0] ?? `${allOurOps.filter((e) => e[0] === 'param').length} parameter writes all sane`);
  }

  // ── 7. 排程器:餵同一串 currentTime,兩邊要排出同一組事件 ──
  //
  // 兩件事是第一輪突變測試逼出來的:
  //
  //   a. **每一趟排程前先插一個 `['@', now]` 標記。** 沒有標記的話,LOOKAHEAD
  //      是看不見的 —— 音符的 `at` 只跟 startAt/spb 有關,lookahead 只決定它
  //      「在哪一趟」被排出去。把整串事件接起來比,0.18 改成 0.16 完全一樣。
  //   b. **後面補一段卡住的時鐘。** `at >= now - 0.05` 那個寬限窗只有在排程器
  //      落後的時候才走得到;25ms 一趟的規律時鐘永遠不會落後,那個窗因此
  //      從來沒有被驗過。這裡讓時鐘每隔幾趟跳 0.45 秒(> LOOKAHEAD),
  //      模擬分頁被凍住之後回來 —— 那是真的會發生的事。
  const clockFor = (spanSec: number): number[] => {
    const times: number[] = [];
    for (let t = 1; t <= 1 + spanSec; t += 0.025) times.push(+t.toFixed(6));
    let t = times[times.length - 1];
    for (let i = 0; i < 120; i++) {
      t = +(t + (i % 3 === 2 ? 0.45 : 0.025)).toFixed(6);
      times.push(t);
    }
    return times;
  };

  for (const [dw, gw] of WORLD_MAP) {
    const rd = makeRecorder();
    rd.install();
    let demoOps: Op[];
    let clock: number[] = [];
    let demoSpan = 0;
    let demoTick = 0;
    try {
      const d = loadDemo();
      d._set(dw, SEED);
      d.play();                                       // initAudio + build + startDrone + setInterval
      const piece = d._piece();
      demoSpan = piece.len * piece.spb * 1.15;        // 走過一整輪多一點,回捲才會被走到
      clock = clockFor(demoSpan);
      demoTick = rd.timers[rd.timers.length - 1];
      rd.take();
      for (const t of clock) { rd.ops.push(['@', t]); rd.ctx.currentTime = t; d.schedule(); }
      d.stop();
      demoOps = rd.take();
    } finally {
      rd.restore();
    }

    const ro = makeRecorder();
    ro.install();
    let ourOps: Op[];
    let ourTick = 0;
    try {
      const bgm = new GenerativeBgm(ro.ctx, ro.ctx.destination, 0.7);
      ro.take();
      bgm.start(gw, SEED);
      ourTick = ro.timers[ro.timers.length - 1];
      const tick = (globalThis as any).__lastTimerFn as () => void;
      ro.take();
      for (const t of clock) { ro.ops.push(['@', t]); ro.ctx.currentTime = t; tick(); }
      bgm.stop();
      ourOps = ro.take();
    } finally {
      ro.restore();
    }

    sameStream(check,
      `${gw}: scheduler puts the same notes at the same times over `
      + `${demoSpan.toFixed(1)}s (lookahead, the −0.05 window, loop wrap)`,
      demoOps, ourOps);
    check(`${gw}: scheduler runs on the demo's TICK`, demoTick === ourTick,
      `${ourTick}ms`);
  }

  // ── 8. 底噪:只有電子世界有,而且從頭響到尾 ──
  for (const [dw, gw] of WORLD_MAP) {
    const rd = makeRecorder();
    rd.install();
    let demoOps: Op[];
    try {
      const d = loadDemo();
      d.initAudio();
      rd.take();
      d.startDrone(dw);
      d.stopDrone();
      demoOps = rd.take();
    } finally {
      rd.restore();
    }

    const ro = makeRecorder();
    ro.install();
    let ourOps: Op[];
    try {
      const bgm = new GenerativeBgm(ro.ctx, ro.ctx.destination, 0.7);
      ro.take();
      bgm.start(gw, SEED);
      bgm.stop();
      ourOps = ro.take();
    } finally {
      ro.restore();
    }

    if (gw === 'circuit') {
      sameStream(check,
        'circuit: mains hum + coil whine drone identical to the demo (start and fade-out)',
        demoOps, ourOps);
    } else {
      check(`${gw}: no drone — the demo only gives one to circuit`,
        demoOps.length === 0 && ourOps.length === 0,
        `demo ${demoOps.length} events, ours ${ourOps.length}`);
    }
  }

  // ── 9. 踏頻驅動速度:遊戲側的功能,demo 沒有,所以規則直接陳述 ──
  {
    const r = makeRecorder();
    r.install();
    try {
      const bgm: any = new GenerativeBgm(r.ctx, r.ctx.destination, 0.7);
      bgm.start('plastic', SEED);
      const base = bgm.baseBpm;

      bgm.setCadence(0);
      check('cadence: idle (rpm ≤ 0) holds tempo instead of crawling',
        bgm.bpm === base, `${bgm.bpm}bpm`);

      // 50 → 底、120 → 頂、超出範圍要夾住
      r.ctx.currentTime = 5;
      bgm.setCadence(50);
      const low = bgm.bpm;
      r.ctx.currentTime = 6;
      bgm.setCadence(120);
      const high = bgm.bpm;
      r.ctx.currentTime = 7;
      bgm.setCadence(400);
      const clamped = bgm.bpm;
      check('cadence: 50–120 rpm maps onto ±34% of the song\'s own BPM, and clamps',
        Math.abs(low - base * 0.66) < 1e-9
        && Math.abs(high - base * 1.34) < 1e-9
        && clamped === high,
        `${low.toFixed(1)} … ${base} … ${high.toFixed(1)} bpm`);

      // 換速度不能讓整首瞬移:同一個時刻算出來的拍數必須連續。
      // demo 的排程是 `at = startAt + 拍數 * spb`,spb 一變、錨點沒動,
      // 下一拍就會跳到別的地方(往回跳的話 lookahead 會把整批音符吃掉)。
      r.ctx.currentTime = 12;
      const beatsBefore = (r.ctx.currentTime - bgm.startAt) / (60 / bgm.bpm);
      bgm.setCadence(70);
      const beatsAfter = (r.ctx.currentTime - bgm.startAt) / (60 / bgm.bpm);
      check('cadence: a tempo change re-anchors the timeline — the beat position is continuous',
        Math.abs(beatsBefore - beatsAfter) < 1e-9,
        `beat ${beatsBefore.toFixed(4)} → ${beatsAfter.toFixed(4)}`);
      bgm.stop();
    } finally {
      r.restore();
    }
  }
}
