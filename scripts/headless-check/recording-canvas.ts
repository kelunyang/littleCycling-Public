/**
 * 這個 harness **只能有一份** canvas stub,而且它必須錄下筆觸。
 *
 * ## 為什麼只能有一份
 *
 * 貼圖快取是**模組層**的狀態,而且是按寬度收的(`circuit-terrain-style.ts` 的
 * `busTexCache`、`fr4Cache`…),一條路線同一個寬度只畫一次。所以**第一個**把某個
 * 寬度畫出來的檢查,決定了後面所有人拿到的畫布。
 *
 * 在這之前有六份各自為政的 stub,每一份都在 import 時直接覆蓋 `globalThis.document`,
 * 而且錄的東西不一樣:
 *
 * | 檔案 | 錄什麼 |
 * |---|---|
 * | `diorama.ts` | 什麼都不錄 |
 * | `terrain-band-vs-demo.ts` | 只錄 fillRect(丟掉 stroke) |
 * | `road-class-vs-demo.ts` | fillRect + stroke |
 * | `circuit-board-vs-demo.ts` | 完整字串 trace(含樣式變更,有順序) |
 * | `circuit-3d` / `props` | 什麼都不錄 |
 *
 * 它們單獨跑都對。接進 `diorama.ts` 之後,**最後一個 import 的贏**,而先前已經被
 * 畫過並快取的貼圖留在別人的畫布上。這咬過兩次,而且都是靜悄悄的:
 *
 * 1. `road-class-vs-demo` 拿到 diorama 那份不會錄的畫布 → `mat.map.image.ops`
 *    是 undefined → 整支 throw。
 * 2. 修掉之後換成 `terrain-band-vs-demo` 那份只錄 fillRect 的贏 → demo 側的
 *    130 道刷痕全部消失 → 6 ops vs 136。
 *
 * 兩次都因為那六支**從來沒被註冊進 `check:3d`**,所以沒有人看過。
 *
 * ## 一張畫布,三種視角
 *
 * 不同檢查要看的粒度不同,所以這裡把最細的錄下來,再導出另外兩種視角:
 *
 * - `trace` —— 字串 trace,含樣式變更,有順序(`circuit-board` 用)
 * - `ops`   —— fillRect + stroke 的結構化版本(`road-class` 用)
 * - `rects` —— 只有 fillRect(`terrain-band` 用)
 *
 * `trace` 是資訊量的上界,另外兩個都是從同一次錄製導出的,所以三者永遠一致。
 */

/** `road-class` 的視角:fillRect 與 stroke,連同當時的樣式狀態。 */
export interface Op {
  kind: 'fillRect' | 'stroke';
  a: number; b: number; c: number; d: number;
  style: string; alpha: number; lineWidth: number;
}
/** `terrain-band` 的視角:只有 fillRect。 */
export interface RectOp {
  x: number; y: number; w: number; h: number; fill: string; alpha: number;
}

export interface RecCanvas {
  width: number;
  height: number;
  /** 字串 trace,含樣式變更,有順序。 */
  trace: string[];
  /** fillRect + stroke。 */
  ops: Op[];
  /** 只有 fillRect。 */
  rects: RectOp[];
  getContext(): unknown;
}

/** 每一張建出來的畫布,依建立順序。`circuit-board` 靠「前兩張」定位。 */
export const canvases: RecCanvas[] = [];

const num = (v: unknown): string =>
  typeof v === 'number' ? (Math.round(v * 1e6) / 1e6).toString() : String(v);

// `circuit-board` 原本就是錄這一串方法。少一個就是那一筆從 trace 裡消失,
// 而 trace 是逐筆比對的,所以 demo 與 gameview 會**同時**少掉那一筆 —— 差異被
// 對消,檢查照樣通過。這份清單只能加不能減。
const METHODS = [
  'fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'stroke',
  'fill', 'arc', 'save', 'restore', 'translate', 'closePath', 'clip', 'rect',
  'fillText', 'strokeText', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo',
  'setTransform', 'drawImage', 'putImageData', 'scale', 'rotate',
];

function recordingContext(rec: RecCanvas): unknown {
  // 刻意**不預填** fillStyle/globalAlpha 等預設值:trace 只在「值有變」時記一筆,
  // 預填會讓「第一次就設成預設值」那一筆消失,而 demo 與 gameview 未必都會設它。
  const state: Record<string, unknown> = {};
  const gradient = { addColorStop: () => {} };
  let path: number[] = [];

  const styleNow = () => String(state.fillStyle ?? '#000000');
  const alphaNow = () => Number(state.globalAlpha ?? 1);
  const widthNow = () => Number(state.lineWidth ?? 1);

  const ctx: Record<string, unknown> = {};
  for (const m of METHODS) {
    ctx[m] = (...a: unknown[]) => { rec.trace.push(`${m}(${a.map(num).join(',')})`); };
  }
  // 下面這幾個在 trace 之外還要餵結構化視角,所以覆寫回去 —— trace 那一筆照樣記。
  ctx.fillRect = (x: number, y: number, w: number, h: number) => {
    rec.trace.push(`fillRect(${[x, y, w, h].map(num).join(',')})`);
    rec.ops.push({
      kind: 'fillRect', a: x, b: y, c: w, d: h,
      style: styleNow(), alpha: alphaNow(), lineWidth: widthNow(),
    });
    rec.rects.push({ x, y, w, h, fill: styleNow(), alpha: alphaNow() });
  };
  ctx.beginPath = () => { rec.trace.push('beginPath()'); path = []; };
  ctx.moveTo = (x: number, y: number) => {
    rec.trace.push(`moveTo(${num(x)},${num(y)})`); path.push(x, y);
  };
  ctx.lineTo = (x: number, y: number) => {
    rec.trace.push(`lineTo(${num(x)},${num(y)})`); path.push(x, y);
  };
  ctx.stroke = (...a: unknown[]) => {
    rec.trace.push(`stroke(${a.map(num).join(',')})`);
    rec.ops.push({
      kind: 'stroke',
      a: path[0] ?? 0, b: path[1] ?? 0, c: path[2] ?? 0, d: path[3] ?? 0,
      style: String(state.strokeStyle ?? '#000000'),
      alpha: alphaNow(), lineWidth: widthNow(),
    });
  };

  ctx.createLinearGradient = () => gradient;
  ctx.createRadialGradient = () => gradient;
  ctx.createPattern = () => null;
  ctx.getImageData = (_x: number, _y: number, w: number, h: number) =>
    ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
  ctx.measureText = () => ({ width: 0 });

  return new Proxy(ctx, {
    get(t, p) {
      if (p in t) return t[p as string];
      // 寫進去的樣式讀得回來。沒寫過的小寫名字當成沒實作的 2D API,回一個 no-op。
      if (p in state) return state[p as string];
      return typeof p === 'string' && /^[a-z]/.test(p) ? () => {} : undefined;
    },
    set(_t, p, v) {
      const k = p as string;
      if (state[k] !== v) rec.trace.push(`${k}=${num(v)}`);
      state[k] = v;
      return true;
    },
  });
}

export function makeRecordingCanvas(): RecCanvas {
  const rec: RecCanvas = {
    width: 0, height: 0, trace: [], ops: [], rects: [],
    getContext: () => recordingContext(rec),
  };
  canvases.push(rec);
  return rec;
}

const MARK = '__littlecyclingRecordingCanvas';

/**
 * 裝上 `document.createElement('canvas')` 與 `window.devicePixelRatio`。
 * 冪等 —— 重複呼叫不會換掉已經裝好的那份(換掉就等於把先前錄的東西丟了,
 * 而快取住的貼圖不會重畫)。
 */
export function installRecordingCanvas(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const doc = g.document as Record<string, unknown> | undefined;
  if (doc && doc[MARK]) return;
  g.document = {
    [MARK]: true,
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      return makeRecordingCanvas();
    },
  };
  g.window = { devicePixelRatio: 1 };
}
