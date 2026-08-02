/**
 * `avgOutsideMs` 拆帳 —— 把「不是 `render()` 的那一段」拆成有名字的桶。
 *
 * ── 為什麼需要這支 ──
 *
 * `useTerrainRenderer` 的 `avgOutsideMs` 是個**殘差**：wall-clock 減掉
 * `render()`。殘差沒有名字,所以每個人都可以把自己的假設塞進去。
 * 這個 repo 已經為此付過兩次代價:
 *
 *  1. 有人把它當成 GPU 時間,推出「gameview 每像素貴 7 倍、是填充率受限」——
 *     `game/terrain/gpu-timer.ts` 量了真正的 GPU 之後推翻(high tier 全開,
 *     GPU 只用掉 16.7 ms 裡的 8.17 ms)。
 *  2. GPU 量出來以後,又有人把剩下的殘差當成「Vue HUD 的主執行緒工作」,
 *     並拿 medium tier「14 fps / GPU 6.35 ms」那幾筆當證據。**那幾筆是暫停中的
 *     畫面**:`useGameLoop` 的 `PAUSED_FRAME_MS = 1000/15` 節流閥把 rAF 量化成
 *     4 或 5 個 vsync(66.7 / 83.3 ms),而 perf 紀錄裡**沒有 `paused` 欄位**,
 *     所以沒人看得出來。整段殘差是設計好的等待,不是工作。
 *
 * 兩次都是同一個錯誤:把「沒有量到的東西」當成「量到是某個值」。
 * 所以這支照 `gpu-timer.ts` 的規矩來 —— **量不到就回 null,不回 0**,而且
 * 一定附上 `paused`,讓下一份 log 自己講清楚它是不是在暫停狀態。
 *
 * ── 怎麼切 ──
 *
 * 一個 rAF 幀在 Chromium 裡是這樣走的(BeginMainFrame 是**一個** task):
 *
 * ```
 *   [ task: BeginMainFrame ]
 *      rAF callbacks(依註冊順序)
 *        ├── useGameLoop.frame()  ← frameStart … renderStart/renderEnd … frameEnd
 *        └── 其他 rAF 迴圈(HudChart / useWindSimulator …)
 *      microtasks(Vue scheduler flush ⇒ patch DOM)
 *      style → layout → paint → commit
 *   [ /task ]
 *   [ task: 我們在 tail 裡 post 的 MessageChannel 訊息 ]   ← 這裡才拿得到時間
 *   … 空等 vsync / compositor / GPU / 其他 task …
 *   [ 下一個 BeginMainFrame ]
 * ```
 *
 * 於是:
 *
 * | 桶 | 區間 | 裝了什麼 |
 * |---|---|---|
 * | `avgPreMs`   | rAF 進入 → `render()` 開始 | `gameStateStore.sample()`、`updateBallVisual()`(含 `updateDistance` → **chunk streaming**)、相機 |
 * | `avgJsMs`    | `render()` 全程 | (由 `useTerrainRenderer` 自己記,這裡不重複) |
 * | `avgPostMs`  | `render()` 結束 → `frame()` 返回 | 迴圈尾巴的取樣 |
 * | `avgTailMs`  | `frame()` 返回 → tail callback | **排在我們後面的其他 rAF 迴圈** |
 * | `avgPaintMs` | tail callback → 之後第一個 macrotask | **Vue flush + style + layout + paint** |
 * | `avgIdleMs`  | 該 macrotask → 下一個 render 幀的 rAF 進入 | vsync 空等 / compositor / GPU 回壓 / 別人的 task |
 * | `avgRafLagMs` | rAF 的 frame 時間戳 → 我們的 callback 真的開始 | **排在我們前面**的 rAF callback + 起幀成本(是 `avgIdleMs` 的一部分,不另計) |
 *
 * 判讀規則(寫在這裡,免得下一個人又要猜):
 * - `avgPaintMs` 大 ⇒ **HUD 有罪**(Vue 重繪 + SVG/濾鏡重新光柵化)。
 * - `avgIdleMs` 大而 `avgPaintMs` 小 ⇒ 主執行緒是**閒的**,幀被 vsync /
 *   compositor / GPU 定速 —— 這時候去節流 HUD 一點用都沒有。
 * - `pausedFrames` 接近 `phaseFrames` ⇒ 這一秒根本在暫停節流下,整份數字別讀。
 *
 * 誠實的但書:`avgPaintMs` 是 style/layout/paint 的**上界**(它也含 tail 之後
 * 其餘 rAF callback 與 microtask),`avgIdleMs` 是閒置的**下界**(排在我們訊息
 * 前面的其他 task 會算進去)。要再細就得靠 DevTools,不是這支的工作。
 *
 * ── 成本 ──
 *
 * 只在 debug 開關下啟動。啟動後每幀多一個 rAF callback、一則 MessageChannel
 * 訊息、十來次 `performance.now()`。關掉時所有進入點都是一個布林判斷。
 */

import { isDebugEnabled } from '@/game/debug-logger';

/** 一秒份的拆帳結果,量不到的欄位是 null。 */
export interface FramePhaseTimings {
  /** rAF 進入 → `render()` 開始(ms/幀)。 */
  avgPreMs: number | null;
  /** `render()` 結束 → `frame()` 返回。 */
  avgPostMs: number | null;
  /** `frame()` 返回 → tail callback:其他 rAF 迴圈。 */
  avgTailMs: number | null;
  /** tail → 下一個 macrotask:Vue flush + style + layout + paint。 */
  avgPaintMs: number | null;
  /** 該 macrotask → 下一個 render 幀:vsync / compositor / GPU / 別人的 task。 */
  avgIdleMs: number | null;
  /**
   * rAF 帶進來的 frame 時間戳 → 我們的 callback **真的**開始跑之間的差。
   * 裝的是「排在我們前面的 rAF callback」加上瀏覽器起幀的成本。
   *
   * **這一段是 `avgIdleMs` 的一部分,不要重複計入 sum。** 它單獨列出來是因為
   * `avgTailMs` 只看得到排在我們後面的迴圈,前面的那些沒有任何桶會顯示。
   */
  avgRafLagMs: number | null;
  /** 五個桶的和。跟 `avgFrameMs - avgJsMs`(= `avgOutsideMs`)對得起來才算數。 */
  avgPhaseSumMs: number | null;
  /** 有幾幀湊齊了全部五個時間點。0 = 沒量到,不是「都是 0」。 */
  phaseFrames: number;
  /** 其中有幾幀是在暫停節流(`PAUSED_FRAME_MS`)下畫的。**先看這個再看別的。** */
  pausedFrames: number;
  /** 這一秒 >50 ms 的 long task 總時數(chunk build 切片、GC 會落在這裡)。 */
  longTaskMs: number | null;
  longTasks: number;
  /**
   * 沒有數字的時候,說明為什麼沒有。`off` = 沒開 debug;`pending` = 開了但這一
   * 秒沒有任何一幀湊齊(分頁隱藏走 setTimeout、或剛啟動)。
   */
  phaseStatus: 'ok' | 'off' | 'pending';
}

const EMPTY: FramePhaseTimings = {
  avgPreMs: null, avgPostMs: null, avgTailMs: null, avgPaintMs: null,
  avgIdleMs: null, avgRafLagMs: null, avgPhaseSumMs: null,
  phaseFrames: 0, pausedFrames: 0,
  longTaskMs: null, longTasks: 0,
  phaseStatus: 'off',
};

/** 這一幀走到哪了。tail / macrotask 只在對的階段才記錄,別的幀不干擾。 */
type Stage = 'idle' | 'inFrame' | 'awaitTail' | 'awaitTask' | 'awaitIdle';

let enabled = false;
let stage: Stage = 'idle';

// 當前幀的時間點
let tFrameStart = 0;
let frameRafLag = 0;
let tRenderStart = 0;
let tRenderEnd = 0;
let tFrameEnd = 0;
let tTail = 0;
let tTask = 0;
let framePaused = false;

// 等著被下一個 render 幀的 rAF 進入時間收尾的那四個值
let heldPre = 0;
let heldPost = 0;
let heldTail = 0;
let heldPaint = 0;
let heldRafLag = 0;
let heldPaused = false;

// 一秒份的累加器
let accPre = 0;
let accPost = 0;
let accTail = 0;
let accPaint = 0;
let accIdle = 0;
let accRafLag = 0;
let accFrames = 0;
let accPaused = 0;
let accLongTaskMs = 0;
let accLongTasks = 0;
let longTaskSupported = false;

let tailRaf = 0;
let channel: MessageChannel | null = null;
let observer: PerformanceObserver | null = null;

/**
 * tail callback 必須跑在**同一批** rAF 的最後一個。做法:它在自己的結尾重新
 * 註冊自己 —— 那時候 `useGameLoop` 的 `scheduleNext()` 已經在這一批稍早跑過了,
 * 所以下一批的順序永遠是 `[…, frame, tail]`。自我修正,不需要外部維持順序。
 */
function onTail(now: number): void {
  if (!enabled) return;
  if (stage === 'awaitTail') {
    tTail = now;
    stage = 'awaitTask';
    // 這則訊息會排在**這個 task 之後**才跑,也就是 style/layout/paint 都做完
    // 之後 —— 這正是我們要的那條分界線。
    channel?.port2.postMessage(0);
  }
  tailRaf = requestAnimationFrame(onTail);
}

function onTask(): void {
  if (!enabled || stage !== 'awaitTask') return;
  tTask = performance.now();
  heldTail = tTail - tFrameEnd;
  heldPaint = tTask - tTail;
  stage = 'awaitIdle';
}

/** 開始拆帳。非 debug 時完全不啟動。 */
export function startFramePhases(): void {
  if (enabled || !isDebugEnabled()) return;
  enabled = true;
  stage = 'idle';
  tFrameStart = tRenderStart = tRenderEnd = tFrameEnd = tTail = tTask = 0;

  channel = new MessageChannel();
  channel.port1.onmessage = onTask;
  // Safari 需要;Chromium 不需要但無害。
  channel.port1.start?.();

  // long task = chunk build 的 10 ms 切片、GC、以及任何一口氣吃掉 >50 ms 的
  // 東西。它跟上面五個桶是**交叉**的(一個 long task 可能橫跨 paint 與 idle),
  // 所以不加進 sum,只當旁證。
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        accLongTaskMs += e.duration;
        accLongTasks++;
      }
    });
    observer.observe({ type: 'longtask', buffered: false });
    longTaskSupported = true;
  } catch {
    observer = null;
    longTaskSupported = false;
  }

  tailRaf = requestAnimationFrame(onTail);
}

export function stopFramePhases(): void {
  if (!enabled) return;
  enabled = false;
  stage = 'idle';
  if (tailRaf) cancelAnimationFrame(tailRaf);
  tailRaf = 0;
  channel?.port1.close();
  channel?.port2.close();
  channel = null;
  observer?.disconnect();
  observer = null;
  longTaskSupported = false;
  accPre = accPost = accTail = accPaint = accIdle = accRafLag = 0;
  accFrames = accPaused = 0;
  accLongTaskMs = 0;
  accLongTasks = 0;
}

/**
 * rAF callback 的第一行。`rafNow` = rAF 傳進來的 frame 時間戳,
 * `paused` = 這一幀走的是暫停節流那條路。
 *
 * 邊界一律用 `performance.now()`,**不用 `rafNow`** —— `avgOutsideMs` 的兩端
 * (`_renderT0` / `_perfLastFrameEnd`)都是 `performance.now()`,混用會讓
 * pre 與 idle 的分帳偏掉(sum 還是對的,因為中間項會消掉,但分帳就沒意義了)。
 * 兩者的差本身有資訊,記成 `avgRafLagMs`。
 */
export function phaseFrameStart(rafNow: number, paused: boolean): void {
  if (!enabled) return;
  const t = performance.now();
  frameRafLag = t - rafNow;
  tFrameStart = t;
  framePaused = paused;
  stage = 'inFrame';
}

/**
 * `render()` 的第一行。順便替**上一個** render 幀收尾 —— `avgIdleMs` 的終點
 * 就是這裡:兩個 render 幀之間被暫停節流跳過的 rAF tick 也算在 idle 裡,這樣
 * 五個桶的和才對得上 renderer 自己算的 `avgFrameMs`。
 */
export function phaseRenderStart(nowMs: number): void {
  if (!enabled || stage !== 'inFrame') return;
  if (tTask > 0 && tFrameStart > tTask) {
    accPre += heldPre;
    accPost += heldPost;
    accTail += heldTail;
    accPaint += heldPaint;
    accIdle += tFrameStart - tTask;
    accRafLag += heldRafLag;
    accFrames++;
    if (heldPaused) accPaused++;
    tTask = 0;
  }
  tRenderStart = nowMs;
  tRenderEnd = 0;
}

/** `render()` 的最後一行。 */
export function phaseRenderEnd(): void {
  if (!enabled || stage !== 'inFrame' || tRenderStart === 0) return;
  tRenderEnd = performance.now();
}

/**
 * rAF callback 的最後一行(含提早 return 的那條路)。沒有畫過的幀直接放掉:
 * 暫停節流跳過的 tick 不該進統計,它們是 idle 的一部分。
 */
export function phaseFrameEnd(): void {
  if (!enabled || stage !== 'inFrame') return;
  if (tRenderStart === 0 || tRenderEnd === 0) {
    stage = 'idle';
    return;
  }
  tFrameEnd = performance.now();
  heldPre = tRenderStart - tFrameStart;
  heldPost = tFrameEnd - tRenderEnd;
  heldRafLag = frameRafLag;
  heldPaused = framePaused;
  tRenderStart = 0;
  tRenderEnd = 0;
  stage = 'awaitTail';
}

/** 取走這一秒的拆帳並歸零 —— 跟 perf 紀錄裡其他計數器同一個節奏。 */
export function takeFramePhases(): FramePhaseTimings {
  if (!enabled) return { ...EMPTY };
  const n = accFrames;
  const longTaskMs = longTaskSupported ? +accLongTaskMs.toFixed(1) : null;
  const longTasks = accLongTasks;
  accLongTaskMs = 0;
  accLongTasks = 0;
  if (n === 0) {
    return { ...EMPTY, phaseStatus: 'pending', longTaskMs, longTasks };
  }
  const avg = (v: number) => +(v / n).toFixed(2);
  const out: FramePhaseTimings = {
    avgPreMs: avg(accPre),
    avgPostMs: avg(accPost),
    avgTailMs: avg(accTail),
    avgPaintMs: avg(accPaint),
    avgIdleMs: avg(accIdle),
    avgRafLagMs: avg(accRafLag),
    avgPhaseSumMs: avg(accPre + accPost + accTail + accPaint + accIdle),
    phaseFrames: n,
    pausedFrames: accPaused,
    longTaskMs,
    longTasks,
    phaseStatus: 'ok',
  };
  accPre = accPost = accTail = accPaint = accIdle = accRafLag = 0;
  accFrames = accPaused = 0;
  return out;
}
