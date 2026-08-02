/**
 * Generative background music — procedural theme songs, one per world style.
 *
 * Like nes-synth.ts, everything is synthesised from OscillatorNode; there are
 * no audio files and no external dependencies (which also keeps us clear of
 * any sample/SoundFont licensing — see DEVPLAN「外部資料源與版權」).
 *
 * 三個世界各一首。設計原則跟視覺那邊同一條:
 * **樂器從世界的材料推出來,不是先挑一個曲風再套上去。**
 *
 *   積木 plastic → 硬塑膠互相敲擊:音樂盒、玩具鋼琴、木魚、橡皮筋。全是短促的
 *                  斷奏,沒有一個長音 —— 塑膠不會延音。
 *   紙板 cuphead → 辦公桌上的東西:打字機、行末鈴、迴紋針、尺、氈槌鋼琴、紙的
 *                  摩擦。快三拍、大調 —— 這是一間快樂的辦公室,不是深夜的
 *                  工作檯。金屬(迴紋針/圖釘/訂書針)正是這個世界缺的高頻。
 *   電子 circuit → 機器自己的聲音:50Hz 市電哼聲當底噪、繼電器喀噠當打擊、線圈
 *                  嘯叫當持續音、方波當旋律。開場是一段真的開機自檢掃描。
 *
 * A seed (derived from the route id) fully determines the tune, so the same
 * route always plays the same theme song.
 *
 * Prototype and design notes: plan/theme-music-demo-opus.html
 *
 * 這份檔案是那支 demo 的移植:作曲函式、聲部表、合成器全部照抄,變數名、magic
 * number、rng 抽取順序都保留。唯一的機械替換是 demo 的模組全域 `ac` / `master`
 * 換成實例欄位 `this.ctx` / `this.out`(遊戲裡 AudioContext 由 AudioManager 持有)。
 * 逐事件比對見 `scripts/headless-check/diorama.ts` 的 `[theme music vs demo]`。
 */

export type WorldStyle = 'plastic' | 'cuphead' | 'circuit';

/* ── Types ─────────────────────────────────────────────────────────────── */

export type VoiceName =
  // 積木
  | 'musicbox' | 'toypiano' | 'rubber' | 'wood'
  // 紙板
  | 'felt' | 'typewriter' | 'bell' | 'clip' | 'brush' | 'ruler' | 'pencil'
  | 'cardthump' | 'pad'
  // 電子
  | 'square' | 'tri' | 'relay' | 'hat';

/** note = { t(以拍為單位), dur, midi, vel, voice } */
export interface Note {
  t: number;
  dur: number;
  midi: number;
  vel: number;
  voice: VoiceName;
}

export interface Piece {
  bpm: number;
  beatsPerBar: number;
  bars: number;
  notes: Note[];
  desc: string;
}

/* ══════════════════════════════════════════════════════════════════════
 * 決定性亂數 + 樂理
 * ══════════════════════════════════════════════════════════════════════ */

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

const SCALE = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  minPent: [0, 3, 5, 7, 10],
};
type ScaleName = keyof typeof SCALE;

/** 音階級數 → midi。degree 可以是負的或超過八度,自動換八度。 */
function deg(root: number, scale: ScaleName, d: number): number {
  const s = SCALE[scale];
  const oct = Math.floor(d / s.length);
  const i = ((d % s.length) + s.length) % s.length;
  return root + oct * 12 + s[i];
}
/** 把音收進 [lo,hi],一次移一個八度。 */
function fold(m: number, lo: number, hi: number): number {
  while (m < lo) m += 12;
  while (m > hi) m -= 12;
  return m;
}

/**
 * Turn an arbitrary route id into a stable 32-bit seed (FNV-1a).
 *
 * demo 那邊 seed 是一個 UI 上骰出來的數字;遊戲裡它必須從路線 id 長出來,
 * 所以這個函式是遊戲側的,不在 demo 裡。同一條路線永遠同一首。
 */
export function seedFromString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ══════════════════════════════════════════════════════════════════════
 * 作曲:每個世界回傳 { bpm, beatsPerBar, bars, notes[] }
 * ══════════════════════════════════════════════════════════════════════ */

/* ── 積木:發條玩具進行曲 ────────────────────────────────────────────
 * 2/4、C 大調、132 BPM。旋律**級進為主**、大量重複音、樂句收在主音上 ——
 * 這是玩具音樂盒滾筒的限制:針只能撥到固定的幾根梳齒,跳進太多會不像。
 * 每個音都短。塑膠不延音,一有長音整首就變成別的東西。
 */
function composePlastic(seed: number): Piece {
  const rng = makeRng(seed);
  const root = 60;              // C4
  const notes: Note[] = [];
  const BAR = 2;                // 2/4
  const BARS = 16;
  const add = (t: number, dur: number, midi: number, vel: number, voice: VoiceName): number =>
    notes.push({ t, dur, midi, vel, voice });

  // 和聲:I - V - vi - IV 的玩具版(全部三和弦,不轉位)
  const prog = [0, 4, 5, 3, 0, 4, 5, 4];   // 級數,每 2 小節一個

  // 動機:4 個十六分音符的細胞,整首靠它變形
  const CELLS = [
    [0, 0, 1, 2], [0, 1, 0, -1], [2, 1, 0, 0], [0, 2, 1, 0], [4, 2, 0, 1],
  ];
  const motif = pick(rng, CELLS);

  for (let bar = 0; bar < BARS; bar++) {
    const t0 = bar * BAR;
    const ch = prog[Math.floor(bar / 2) % prog.length];
    const isB = bar >= 8 && bar < 12;        // B 段:動機上行、音域拉高

    // 木魚:每拍一下,反拍加半下(進行曲的骨架)
    for (let b = 0; b < BAR; b++) {
      add(t0 + b, 0.1, 0, b === 0 ? 1 : 0.7, 'wood');
      if (rng() < 0.45) add(t0 + b + 0.5, 0.08, 0, 0.35, 'wood');
    }

    // 橡皮筋低音:根音 + 五度,踏在正拍
    const bass = fold(deg(root, 'major', ch) - 12, 40, 52);
    add(t0, 0.42, bass, 0.9, 'rubber');
    add(t0 + 1, 0.42, fold(bass + 7, 40, 52), 0.7, 'rubber');

    // 玩具鋼琴:和弦內音,八分音符,偶爾休止(休止讓它有呼吸,不然像鬧鐘)
    for (let i = 0; i < 4; i++) {
      if (rng() < 0.22) continue;
      const d = ch + [0, 2, 4, 2][i];
      add(t0 + i * 0.5, 0.22, fold(deg(root, 'major', d), 55, 72), 0.5, 'toypiano');
    }

    // 音樂盒旋律:十六分音符跑動機,B 段整組上移三度
    const lift = isB ? 2 : 0;
    for (let i = 0; i < 8; i++) {
      const step = motif[i % 4] + (i >= 4 ? 1 : 0) + lift;
      const midi = fold(deg(root, 'major', ch + step), 67, 84);
      // 樂句最後一拍收在主音,四小節一次
      const last = (bar % 4 === 3) && i >= 6;
      add(t0 + i * 0.25, 0.2, last ? fold(root + 12, 67, 84) : midi,
        last ? 0.95 : 0.62 + rng() * 0.2, 'musicbox');
    }
  }
  return { bpm: 132, beatsPerBar: BAR, bars: BARS, notes,
    desc: '2/4・C 大調・132 — 動機 [' + motif.join(' ') + ']' };
}

/* ── 紙板:快樂的辦公室 ───────────────────────────────────────────
 * 3/4、D 大調、138 BPM 的快三拍。
 *
 * 前兩版的檢討(兩次都被聽出來,而且兩次的原因不同):
 *
 * 第一版「聽不出來是什麼曲子」——
 *   1. **沒有動機。** 旋律是 `d += pick([-2,-1,1,1,2])` 的隨機遊走。隨機遊走
 *      沒有辨識度,聽十次是十條不同的線。改成 3 音細胞在整首變形。
 *   2. **旋律沒有起音。** 氈槌鋼琴慢起音、低通,那是伴奏音色。旋律改由「尺」
 *      擔(壓在桌邊彈),氈槌退回伴奏。
 *   3. **音量。** 旋律實測 0.126、pad 只有 0.013(等於不存在)。
 *
 * 第二版「還是很悶」—— 這個字在中文裡同時罵了兩件事,而且**兩件都成立**:
 *   4. **音色悶。** 全部聲部都在 3 kHz 以下:氈槌低通 1150、尺掃到 900、
 *      pad 低通 620。整首沒有任何一個亮的東西,像隔著棉被聽。
 *   5. **情緒悶。** A 多利安是小調,92 BPM 的三拍是慢華爾滋 —— 那是「深夜
 *      的工作檯」,不是「快樂的辦公室」。
 *
 * 所以這一版改的是**世界的時段**,不只是配器:D 大調、138 BPM,濾波器全部
 * 往上開。並且承認一件事 —— **這個世界是有金屬的**:迴紋針、圖釘、訂書針、
 * 打字機的鍵桿與行末鈴。前一版寫著「一點金屬都沒有」是我自己記錯了詞彙表
 * (連遊戲本體的紙板單車都是迴紋針折的、金幣是圖釘)。金屬正好補上缺的高頻。
 *
 * 辦公室的脈搏是**打字**,不是鼓。所以節奏骨架交給打字機,行末那一聲鈴是
 * 整首最快樂的一個聲音,四小節響一次。
 */
function composePaper(seed: number): Piece {
  const rng = makeRng(seed);
  const root = 62;              // D4
  const notes: Note[] = [];
  const BAR = 3;                // 3/4(快三拍)
  const BARS = 16;
  const add = (t: number, dur: number, midi: number, vel: number, voice: VoiceName): number =>
    notes.push({ t, dur, midi, vel, voice });

  const prog = [0, 4, 5, 3, 0, 4, 1, 4];    // I - V - vi - IV,大調的老實走法

  // 動機:3 個音的細胞,一拍一個,整首靠它變形
  const CELLS = [[0, 2, 1], [0, 1, 3], [2, 4, 3], [0, -1, 2], [1, 3, 2], [4, 2, 1]];
  const motif = pick(rng, CELLS);

  for (let bar = 0; bar < BARS; bar++) {
    const t0 = bar * BAR;
    const ch = prog[Math.floor(bar / 2) % prog.length];
    const phraseEnd = bar % 4 === 3;
    const isB = bar >= 8 && bar < 12;        // B 段:動機整組上行三度

    // 打字機:辦公室的脈搏。正拍一下、反拍補字,偶爾連打兩個
    for (let b = 0; b < BAR; b++) {
      add(t0 + b, 0.05, 0, b === 0 ? 0.85 : 0.6, 'typewriter');
      if (rng() < 0.65) add(t0 + b + 0.5, 0.04, 0, 0.4, 'typewriter');
      if (rng() < 0.3) add(t0 + b + 0.75, 0.04, 0, 0.28, 'typewriter');
    }
    // 行末鈴:四小節一次,跟樂句一起收
    if (phraseEnd) add(t0 + 2, 1.6, root + 12, 0.72, 'bell');
    // 迴紋針掉在桌上:反拍的一個亮點
    if (rng() < 0.7) add(t0 + 1.5, 0.1, fold(deg(root, 'major', ch + 4), 79, 91), 0.5, 'clip');

    // 紙的摩擦 / 鉛筆:退成質感,不再擔節奏
    add(t0 + (rng() < 0.5 ? 0 : 1.5), 1.1, 0, 0.28 + 0.18 * Math.sin(bar / 3), 'brush');
    if (rng() < 0.5) add(t0 + 2.5, 0.09, 0, 0.24 + rng() * 0.14, 'pencil');
    if (phraseEnd) add(t0 + 2, 0.5, 0, 0.55, 'cardthump');

    // 氈槌鋼琴:低音走句。踩死在根音上會沉,三拍各換一個和弦內音才走得動
    const b0 = fold(deg(root, 'major', ch) - 12, 38, 50);
    add(t0, 0.9, b0, 0.55, 'felt');
    add(t0 + 1, 0.5, fold(deg(root, 'major', ch + 4) - 12, 38, 50), 0.34, 'felt');
    add(t0 + 2, 0.5, fold(deg(root, 'major', ch + 2) - 12, 38, 50), 0.34, 'felt');

    // 尺:旋律。動機三個音踩在三拍上,附點的跳音是快三拍的彈性所在
    const lift = isB ? 2 : 0;
    for (let i = 0; i < 3; i++) {
      const last = phraseEnd && i === 2;
      const midi = last ? fold(root + 12, 64, 84)
        : fold(deg(root, 'major', ch + motif[i] + lift), 64, 84);
      add(t0 + i, last ? 1.5 : 0.5, midi, last ? 0.92 : 0.7 + rng() * 0.14, 'ruler');
      if (!last && rng() < 0.55) {
        const d = ch + motif[i] + lift + (rng() < 0.5 ? 1 : 2);
        add(t0 + i + 0.66, 0.28, fold(deg(root, 'major', d), 64, 84), 0.52, 'ruler');
      }
    }

    // 底噪 pad,整小節
    add(t0, BAR, fold(deg(root, 'major', ch), 50, 62), 0.3, 'pad');
  }
  return { bpm: 138, beatsPerBar: BAR, bars: BARS, notes,
    desc: '3/4・D 大調・138 — 打字機當脈搏,動機 [' + motif.join(' ') + ']' };
}

/* ── 電子:開機自檢 ───────────────────────────────────────────────
 * 4/4、A 小調五聲、140 BPM。第 1 小節是**真的開機自檢**:方波由低到高掃一遍
 * (像 LED 依序點亮),繼電器一路喀噠,然後主題進來。
 * 底噪永遠有市電哼聲跟線圈嘯叫 —— 板子只要通電就在響。
 *
 * 第一版「聽不出來是什麼曲子」,量出來三個原因:
 *   1. **低音壓過旋律。** 方波旋律實測 0.067、三角波低音 0.224 —— 低音是旋律
 *      的 3.3 倍。chiptune 的招牌整個被自己的貝斯蓋掉。現在旋律 ~0.24、
 *      低音 ~0.14。
 *   2. **方波只有琶音,沒有旋律。** 琶音是織體不是旋律。改成兩層:動機踩正拍
 *      (前景),琶音退到十六分的內聲部而且音域壓到旋律以下(背景)。
 *   3. **開頭與中段都是洞。** 自檢佔 2 小節(3.4 秒)才進主題;第 11–12 小節
 *      的 drop 每小節只有 6 個音,等於中間又靜音 3.4 秒。自檢縮成 1 小節,
 *      drop 段保留旋律(變成有主題的收束,不是斷電)。
 */
function composeCircuit(seed: number): Piece {
  const rng = makeRng(seed);
  const root = 57;              // A3
  const notes: Note[] = [];
  const BAR = 4;
  const BARS = 16;
  const add = (t: number, dur: number, midi: number, vel: number, voice: VoiceName): number =>
    notes.push({ t, dur, midi, vel, voice });

  // ── 開機自檢:1 小節 ──
  for (let i = 0; i < 8; i++) {
    add(i * 0.5, 0.14, root + 12 + i * 3, 0.55, 'square');
    if (i % 2 === 0) add(i * 0.5, 0.05, 0, 0.7, 'relay');
  }
  add(3.5, 0.5, root + 36, 0.8, 'square');       // 自檢完成的長音

  const prog = [0, 0, 3, 4, 0, 2, 3, 4];         // 五聲級數
  // 主題動機:4 個音的細胞
  const CELLS = [[0, 2, 1, 4], [0, 4, 2, 1], [2, 0, 3, 1], [0, 1, 4, 2]];
  const motif = pick(rng, CELLS);

  for (let bar = 1; bar < BARS; bar++) {
    const t0 = bar * BAR;
    const ch = prog[(bar - 1) % prog.length];
    const drop = bar >= 10 && bar < 12;          // 收束段:抽掉織體,只留旋律與骨架
    const isB = bar >= 6 && bar < 10;            // B 段:動機上行

    // 繼電器:機械式的打擊。正拍重、十六分的裝飾輕
    for (let b = 0; b < BAR; b++) {
      add(t0 + b, 0.04, 0, b % 2 === 0 ? 0.85 : 0.55, 'relay');
      if (!drop && rng() < 0.5) add(t0 + b + 0.75, 0.03, 0, 0.3, 'relay');
    }
    // 高帽:十六分,只在非 drop 段
    if (!drop) for (let i = 0; i < 8; i++) {
      if (rng() < 0.3) continue;
      add(t0 + i * 0.5, 0.03, 0, i % 2 ? 0.18 : 0.3, 'hat');
    }

    // 三角波低音:八分音符的走句
    const b0 = fold(deg(root, 'minPent', ch) - 12, 33, 45);
    for (let i = 0; i < 8; i++) {
      if (drop && i % 4 !== 0) continue;
      add(t0 + i * 0.5, 0.24, i % 4 === 0 ? b0 : fold(b0 + (i % 8 === 6 ? 3 : 7), 33, 45),
        0.6, 'tri');
    }

    // 主旋律:動機四個音踩在四個正拍上,四小節一次收在主音
    const lift = isB ? 2 : 0;
    for (let i = 0; i < 4; i++) {
      const last = (bar % 4 === 0) && i === 3;
      const midi = last ? fold(root + 24, 69, 88)
        : fold(deg(root, 'minPent', ch + motif[i] + lift), 69, 88);
      add(t0 + i, drop ? 0.9 : (last ? 1.2 : 0.42), midi, drop ? 0.7 : 0.92, 'square');
    }
    if (drop) continue;

    // 方波琶音:十六分的內聲部。正拍讓給旋律,音域也壓到旋律以下 ——
    // 同一個聲部要同時當前景跟背景,只能靠音量跟音域分開。
    const arp = [0, 2, 4, 2, 3, 5, 4, 2];
    for (let i = 0; i < 16; i++) {
      if (i % 4 === 0) continue;
      const midi = fold(deg(root, 'minPent', ch + arp[i % 8] + (i >= 8 ? 2 : 0)), 64, 79);
      add(t0 + i * 0.25, 0.11, midi, 0.3, 'square');
    }
  }
  return { bpm: 140, beatsPerBar: BAR, bars: BARS, notes,
    desc: '4/4・A 小調五聲・140 — 開機自檢 1 小節,動機 [' + motif.join(' ') + ']' };
}

/**
 * demo 的 `WORLDS`。key 從 demo 的 `paper` 換成遊戲的 `cuphead` —— 這是這份
 * 檔案裡唯一被改掉的 demo 名字,因為 `WorldStyle` 是全專案共用的;作曲函式本身
 * 仍叫 `composePaper`,好讓下一次比對認得出它是哪一段。
 */
export const WORLDS: Record<WorldStyle, { compose: (seed: number) => Piece; label: string }> = {
  plastic: { compose: composePlastic, label: '積木・發條玩具進行曲' },
  cuphead: { compose: composePaper, label: '紙板・快樂的辦公室' },
  circuit: { compose: composeCircuit, label: '電子・開機自檢' },
};

/** 選一個世界的曲子。音符依 t 排序 —— 排程器逐一往前掃,順序是它的前提。 */
export function compose(style: WorldStyle, seed: number): Piece {
  const piece = WORLDS[style].compose(seed);
  piece.notes.sort((a, b) => a.t - b.t);
  return piece;
}

/* ══════════════════════════════════════════════════════════════════════
 * 排程(lookahead)
 * ══════════════════════════════════════════════════════════════════════ */

const LOOKAHEAD = 0.18; // seconds of notes scheduled ahead of the clock
const TICK = 25;        // ms between scheduler passes

/**
 * How far cadence may push tempo either side of the song's base BPM.
 *
 * demo 沒有這一段 —— 它的 BPM 是固定的。踏頻驅動速度是遊戲側的功能
 * (`AudioManager.setCadence`),移植時保留原本的三個常數不動。
 */
const TEMPO_SPAN = 0.34;
const CADENCE_MIN = 50;
const CADENCE_MAX = 120;

interface Drone {
  g: GainNode;
  parts: OscillatorNode[];
}

interface ToneOpts {
  wave?: OscillatorType;
  duty?: number;
  filter?: number;
  filterType?: BiquadFilterType;
  filterTo?: number;
  q?: number;
  attack?: number;
  detune?: number;
  pitchTo?: number;
}

export class GenerativeBgm {
  private ctx: AudioContext;
  /** demo 的 `master`。 */
  private out: GainNode;
  private waveCache = new Map<string, PeriodicWave>();
  private drone: Drone | null = null;

  private piece: Piece | null = null;
  private baseBpm = 132;
  private bpm = 132;
  private len = 0;
  private startAt = 0;
  private nextIdx = 0;
  private loopN = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  // setCadence throttle: skip redundant tempo updates (called every frame).
  private lastCadenceBpm = -1;
  private lastCadenceSetSec = -1;

  /**
   * demo 的 `initAudio()`:master gain → destination。
   *
   * demo 把 master 開在 0.7,那是它介面上音量滑桿的預設值,不是編曲的一部分
   * (聲部之間的平衡全在 VOICES 的增益裡,跟 master 無關)。遊戲要跟 NES 音效
   * 與環境音混在一起,所以沿用原本的 0.22。
   */
  constructor(ctx: AudioContext, destination: AudioNode, volume = 0.22) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = volume;
    this.out.connect(destination);
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  /** Start (or restart) the theme for a world style and seed. */
  start(style: WorldStyle, seed: number): void {
    this.stop();
    this.piece = compose(style, seed);
    this.baseBpm = this.piece.bpm;
    this.bpm = this.baseBpm;
    this.len = this.piece.bars * this.piece.beatsPerBar;
    this.startAt = this.ctx.currentTime + 0.12;
    this.nextIdx = 0;
    this.loopN = 0;
    this.startDrone(style);
    this.timer = setInterval(() => this.schedule(), TICK);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopDrone();
  }

  /**
   * Cadence drives tempo — pedal faster and the theme speeds up.
   * Idle (rpm <= 0) holds the current tempo rather than dropping to a crawl.
   */
  setCadence(rpm: number): void {
    if (!this.piece || rpm <= 0) return;
    const clamped = Math.max(CADENCE_MIN, Math.min(CADENCE_MAX, rpm));
    const norm = (clamped - CADENCE_MIN) / (CADENCE_MAX - CADENCE_MIN); // 0..1
    const nextBpm = this.baseBpm * (1 - TEMPO_SPAN + norm * TEMPO_SPAN * 2);
    // Called every frame; skip unless the tempo moved audibly or ≥100ms passed.
    const now = this.ctx.currentTime;
    if (Math.abs(nextBpm - this.lastCadenceBpm) < 0.5 && now - this.lastCadenceSetSec < 0.1) {
      return;
    }
    this.lastCadenceBpm = nextBpm;
    this.lastCadenceSetSec = now;
    // demo 的排程是 `at = startAt + (絕對拍數) * spb`,整條時間軸釘在 startAt 上。
    // 換了 spb 之後同一個拍數會算到完全不同的時刻(整首會瞬移),所以把錨點往回
    // 推到「現在正好落在同一拍」的位置,拍數連續、只有拍長改變。
    if (this.playing) {
      const beats = (now - this.startAt) / this.spb();
      this.bpm = nextBpm;
      this.startAt = now - beats * this.spb();
    } else {
      this.bpm = nextBpm;
    }
  }

  dispose(): void {
    this.stop();
    this.out.disconnect();
    this.piece = null;
  }

  // ── scheduler ──

  /** demo 的 `piece.spb`。踏頻會改 bpm,所以每次都重算。 */
  private spb(): number {
    return 60 / this.bpm;
  }

  /**
   * Schedule notes ahead of the audio clock. A JS timer is far too jittery to
   * trigger sound directly, so it only queues events onto the AudioContext
   * timeline, where they are sample-accurate.
   */
  private schedule(): void {
    const piece = this.piece;
    if (!piece) return;
    // demo 的 while(true) 靠 `at > now + LOOKAHEAD` 跳出。空的音符表會讓
    // `nextIdx >= 0` 恆成立而永遠不 break —— demo 的作曲函式不會產生空表,
    // 但排程器凍掉整個分頁的代價太高,所以擋一下。
    if (piece.notes.length === 0) return;

    const now = this.ctx.currentTime;
    const spb = this.spb();
    for (;;) {
      if (this.nextIdx >= piece.notes.length) {
        // 進下一輪:整首往後推一個循環長度
        this.loopN++;
        this.nextIdx = 0;
      }
      const n = piece.notes[this.nextIdx];
      const at = this.startAt + (this.loopN * this.len + n.t) * spb;
      if (at > now + LOOKAHEAD) break;
      if (at >= now - 0.05) this.renderNote(n, at);
      this.nextIdx++;
    }
  }

  /**
   * demo 的 `VOICES[n.voice](n, at)`。
   *
   * public 是為了讓 headless check 能驅動排程器走的**同一條**程式碼路徑,
   * 而不是另外抄一份聲部表出來比。
   */
  renderNote(n: Note, at: number): void {
    const v = this.VOICES[n.voice];
    if (v) v(n, at);
  }

  /* ── 合成器 ────────────────────────────────────────────────────── */

  /** 方波的 duty 變化是 chiptune 的靈魂,用 PeriodicWave 做。 */
  private pulseWave(duty: number): PeriodicWave {
    const key = duty.toFixed(2);
    const cached = this.waveCache.get(key);
    if (cached) return cached;
    const N = 32;
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 1; n < N; n++) im[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
    const w = this.ctx.createPeriodicWave(re, im, { disableNormalization: false });
    this.waveCache.set(key, w);
    return w;
  }

  /** 一個帶包絡的振盪器。opts: filter/q/attack/detune/wave/duty/pitchTo */
  private tone(freq: number, t: number, dur: number, vol: number, opts: ToneOpts = {}): void {
    const o = this.ctx.createOscillator();
    if (opts.duty !== undefined) o.setPeriodicWave(this.pulseWave(opts.duty));
    else o.type = opts.wave || 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (opts.pitchTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.pitchTo), t + dur);
    if (opts.detune) o.detune.value = opts.detune;

    let node: AudioNode = o;
    if (opts.filter) {
      const f = this.ctx.createBiquadFilter();
      f.type = opts.filterType || 'lowpass';
      f.frequency.setValueAtTime(opts.filter, t);
      if (opts.filterTo) f.frequency.exponentialRampToValueAtTime(Math.max(60, opts.filterTo), t + dur);
      f.Q.value = opts.q ?? 1;
      o.connect(f);
      node = f;
    }
    const g = this.ctx.createGain();
    const atk = opts.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, atk + 0.02));
    node.connect(g);
    g.connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.08);
  }

  /** 噪音爆(所有打擊的底)。 */
  private noise(
    t: number, dur: number, type: BiquadFilterType, freq: number, vol: number, q?: number,
  ): void {
    const n = Math.max(1, Math.ceil(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q ?? 1;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.out);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  /* ── 聲部表(demo 的 `VOICES`)────────────────────────────────── */

  private readonly VOICES: Record<VoiceName, (n: Note, t: number) => void> = {
    // ── 積木 ──
    // 音樂盒:基音 + 一個不準的泛音(真的滾筒梳齒就是不準),衰減很快
    musicbox: (n, t) => {
      const f = mtof(n.midi);
      this.tone(f, t, 0.9, n.vel * 0.3, { wave: 'sine', filter: 5200 });
      this.tone(f * 2, t, 0.42, n.vel * 0.11, { wave: 'sine', detune: 12 });
      this.tone(f * 5.9, t, 0.14, n.vel * 0.05, { wave: 'sine' });
    },
    // 玩具鋼琴:方波過帶通 + 一個敲擊的瞬態。短到不能再短
    toypiano: (n, t) => {
      this.tone(mtof(n.midi), t, 0.24, n.vel * 0.22, {
        duty: 0.5, filter: 2400, filterType: 'bandpass', q: 2.2,
      });
      this.noise(t, 0.014, 'highpass', 3800, n.vel * 0.14);
    },
    // 橡皮筋:三角波 + 濾波器往下掃(彈性帶的鬆弛感)
    rubber: (n, t) => {
      this.tone(mtof(n.midi), t, 0.4, n.vel * 0.36, {
        wave: 'triangle', filter: 1500, filterTo: 240, q: 3,
      });
    },
    wood: (n, t) => { this.noise(t, 0.045, 'bandpass', 1750, n.vel * 0.3, 9); },

    // ── 紙板 ──
    // 這一組的濾波器截止頻率是**一起**調高的。第一版全部壓在 3 kHz 以下
    // (氈槌 1150、尺掃到 900、pad 620),整首沒有一個亮的東西,聽起來像隔著
    // 棉被 —— 「悶」罵的就是這件事。音符改了但濾波器沒開,一樣悶。
    // 氈槌:三角 + 正弦疊,慢起音。木槌包了氈就是這個聲音
    felt: (n, t) => {
      const f = mtof(n.midi);
      this.tone(f, t, n.dur * 1.6, n.vel * 0.3, { wave: 'triangle', filter: 2400, attack: 0.014 });
      this.tone(f * 2.01, t, n.dur * 0.8, n.vel * 0.08, { wave: 'sine', attack: 0.02 });
    },
    // 打字機:鍵桿打到紙上。亮的木頭撞擊 + 紙後面滾筒的悶響,兩個疊起來
    typewriter: (n, t) => {
      this.noise(t, 0.016, 'bandpass', 3200, n.vel * 0.26, 2.2);
      this.noise(t + 0.004, 0.03, 'lowpass', 900, n.vel * 0.1, 1);
    },
    // 行末鈴:辦公室裡最快樂的一個聲音。三個不成整數比的泛音疊出金屬感
    // (整數比會變成管風琴),收得慢
    bell: (n, t) => {
      const f = mtof(n.midi);
      for (const [m, v, d] of [[1, 0.16, 1.5], [2.76, 0.09, 1.0], [5.4, 0.05, 0.6]]) {
        this.tone(f * m, t, d, n.vel * v, { wave: 'sine', attack: 0.002 });
      }
    },
    // 迴紋針掉在桌上:很短、很亮的一聲叮。這個世界**是有金屬的** —— 迴紋針、
    // 圖釘、訂書針,只是都很小,所以聲音要短、要高、要瞬間就沒
    clip: (n, t) => {
      const f = mtof(n.midi);
      this.tone(f, t, 0.12, n.vel * 0.14, { wave: 'sine', attack: 0.001 });
      this.tone(f * 3.1, t, 0.07, n.vel * 0.08, { wave: 'sine', attack: 0.001 });
      this.noise(t, 0.008, 'highpass', 6000, n.vel * 0.1, 1);
    },
    // 紙的摩擦:寬頻噪音、慢起慢收 —— 手掌抹過卡紙
    brush: (n, t) => {
      const dur = 1.0;
      const nn = Math.ceil(this.ctx.sampleRate * dur);
      const buf = this.ctx.createBuffer(1, nn, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < nn; i++) d[i] = (Math.random() * 2 - 1) * 0.6;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.Q.value = 0.9;
      f.frequency.setValueAtTime(900, t);
      f.frequency.linearRampToValueAtTime(2600, t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(n.vel * 0.09, t + dur * 0.35);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      src.connect(f); f.connect(g); g.connect(this.out);
      src.start(t); src.stop(t + dur + 0.02);
    },
    // 尺:壓在桌邊彈一下 —— 這張工作檯上本來就有的、而且**有音高**的東西。
    // 氈槌沒有起音,拿它當旋律永遠浮不出來;這裡需要一個會「彈」的音源。
    // 尺在振動時有效長度會變,所以音高在衰減過程中往下掉一點點,那個微微
    // 走音的 boing 才是尺,不然只是一個三角波。
    ruler: (n, t) => {
      const f = mtof(n.midi);
      this.tone(f, t, Math.max(0.3, n.dur * 0.95), n.vel * 0.28, {
        wave: 'triangle', filter: 5000, filterTo: 1900, q: 1.6,
        pitchTo: f * 0.965, attack: 0.003,
      });
      this.tone(f * 0.5, t, 0.09, n.vel * 0.07, { wave: 'sine', attack: 0.002 });  // 桌板被帶動的悶響
      this.noise(t, 0.012, 'bandpass', 1400, n.vel * 0.09, 4);                     // 指甲撥到的那一下
    },
    pencil: (n, t) => { this.noise(t, 0.07, 'highpass', 2600, n.vel * 0.12, 0.7); },
    cardthump: (n, t) => {
      this.noise(t, 0.16, 'lowpass', 210, n.vel * 0.34, 1.2);
      this.tone(64, t, 0.16, n.vel * 0.1, { wave: 'sine', pitchTo: 42 });
    },
    pad: (n, t) => {
      this.tone(mtof(n.midi), t, n.dur * 1.1, n.vel * 0.16, { wave: 'triangle', filter: 1400, attack: 0.4 });
    },

    // ── 電子 ──
    // square 跟 tri 的增益是**一起**調的:第一版 square 0.16 / tri 0.32,低音
    // 是旋律的兩倍,再乘上音符力度(0.42 vs 0.70)就變成 3.3 倍 —— chiptune
    // 的旋律被自己的貝斯蓋掉。旋律聲部的增益一定要壓過低音聲部。
    square: (n, t) => {
      // duty 隨音高微變 —— chiptune 的音色會跟著旋律呼吸
      const duty = 0.22 + ((n.midi % 12) / 12) * 0.24;
      this.tone(mtof(n.midi), t, n.dur * 1.1, n.vel * 0.26, { duty, filter: 5200 });
    },
    tri: (n, t) => {
      this.tone(mtof(n.midi), t, n.dur * 1.2, n.vel * 0.24, { wave: 'triangle', filter: 900 });
    },
    // 繼電器:兩段極短的爆音(吸合 + 撞到鐵芯),中間差 6ms。一段的話只是「click」
    relay: (n, t) => {
      this.noise(t, 0.006, 'bandpass', 2900, n.vel * 0.3, 3);
      this.noise(t + 0.006, 0.018, 'bandpass', 1150, n.vel * 0.22, 5);
    },
    hat: (n, t) => { this.noise(t, 0.022, 'highpass', 8200, n.vel * 0.16, 0.8); },
  };

  /* ── 底噪 ──────────────────────────────────────────────────────── */

  /** 市電哼聲 + 線圈嘯叫。只有電子世界有,而且從頭響到尾 —— 板子通電就在響。 */
  private startDrone(world: WorldStyle): void {
    this.stopDrone();
    if (world !== 'circuit') return;
    const g = this.ctx.createGain();
    g.gain.value = 0.0001;
    g.gain.exponentialRampToValueAtTime(0.032, this.ctx.currentTime + 1.2);
    g.connect(this.out);
    const parts: OscillatorNode[] = [];
    // 50Hz + 諧波 = 市電。基頻在筆電喇叭上根本推不出來,卻照樣吃掉動態餘裕
    // (旋律因此更聽不見),所以基頻壓低、把重量交給 100Hz 那根諧波。
    for (const [f, v] of [[50, 0.5], [100, 0.55], [150, 0.24], [250, 0.1]]) {
      const o = this.ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      const og = this.ctx.createGain(); og.gain.value = v;
      o.connect(og); og.connect(g); o.start();
      parts.push(o);
    }
    // 線圈嘯叫:高頻正弦,慢慢飄
    const w = this.ctx.createOscillator();
    w.type = 'sine'; w.frequency.value = 7400;
    const wg = this.ctx.createGain(); wg.gain.value = 0.035;
    const lfo = this.ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.07;
    const lg = this.ctx.createGain(); lg.gain.value = 420;
    lfo.connect(lg); lg.connect(w.frequency);
    w.connect(wg); wg.connect(g);
    w.start(); lfo.start();
    parts.push(w, lfo);
    this.drone = { g, parts };
  }

  private stopDrone(): void {
    if (!this.drone) return;
    const { g, parts } = this.drone;
    this.drone = null;
    g.gain.cancelScheduledValues(this.ctx.currentTime);
    g.gain.setValueAtTime(g.gain.value, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.4);
    for (const p of parts) { try { p.stop(this.ctx.currentTime + 0.5); } catch { /* 已停 */ } }
  }
}
