/**
 * `[rider signals vs demo]` — 騎士的即時訊號接到造型層的那條線。
 *
 * 這一支不驗幾何,它驗**訊號到不到得了**。這個 repo 最貴的一類缺陷長的就是這個樣子:
 * CUSTOM_WORLD_INSTRUCTIONS 附註「**「記錄了」不等於「送得到」**」記著陰影那次 ——
 * 三個 demo 的 `normalBias` 不一致被斷言下來了,而三個世界照樣全拿多數決那個值,
 * 因為沒有任何東西把逐世界的值送到光上。一個宣告在介面上、沒有人餵的 hook 是同一
 * 種東西。
 *
 * 所以這裡的每一條都打在**行為**上:曲柄真的轉了幾弧度、哪個世界真的被呼叫到。
 * 唯一的例外是最後那一節(從 GameView 到 renderer 的那一跳),它是**原始碼文字**
 * 斷言,而且原因寫在那一節裡 —— 那一跳沒有 WebGL 就執行不了。
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/rider-signals-vs-demo.ts
 *
 * 為什麼叫 `-vs-demo`:曲柄的**規格來源**是 demo 的踏頻語意(「踏頻決定…」),而
 * demo 沒有單車,所以這一格是 gameview 自己的 —— 這支檔案就是那件事的記錄。
 */
import { readFileSync } from 'node:fs';

const { installRecordingCanvas } = await import('./recording-canvas.ts');
installRecordingCanvas();

const THREE = await import('three');
const { createTerrainStyleStrategy } = await import('@/game/terrain/terrain-style-strategy');
const { BikeOrnament } = await import('@/game/terrain/bike-ornament');
const { nightLitFactor, setNightLitFactor } =
  await import('@/game/terrain/building-lights');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
export function failureCount(): number { return failures; }

const STYLES = ['circuit', 'plastic', 'paper'] as const;
const strategies = {
  circuit: await createTerrainStyleStrategy('circuit'),
  plastic: await createTerrainStyleStrategy('plastic'),
  paper: await createTerrainStyleStrategy('paper'),
};

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[rider signals: 誰宣告了這個 hook]');
// ═════════════════════════════════════════════════════════════════════════════
{
  check('電子宣告了 updateRiderSignals(它的 demo 把騎士放進世界自己的邏輯裡)',
    typeof strategies.circuit.updateRiderSignals === 'function');
  // 「不宣告」是合法答案,而且必須真的是 undefined 而不是一個空函式:renderer 靠
  // `?.` 決定要不要呼叫,空函式等於每幀白付一次呼叫,而且會讓「沒宣告的世界一格
  // 沒動」變成一句沒有人在守的話。
  // ⚠ 2026-07-30:這是一張**帳**,不是一句永久的事實。三個 POC 現在都有反應了
  // (積木=泡泡速率/大小、瓦楞紙=全鎮拍子/筆壓),只是還沒移植進 gameview。移植的
  // 時候把這條**反過來**(要求它們是 function),不要刪掉 —— 刪掉等於讓帳靜靜過期,
  // 而這個 repo 已經因為過期的計畫文件派出過三張錯誤工單。
  check('積木與瓦楞紙**還沒**宣告(POC 有、gameview 未移植),而且是 undefined 不是空函式',
    strategies.plastic.updateRiderSignals === undefined
    && strategies.paper.updateRiderSignals === undefined);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[rider signals: 曲柄吃真踏頻,沒有踏頻才退回車輪]');
// ═════════════════════════════════════════════════════════════════════════════
/**
 * One bike, one `update`, and the two rotations it moved.
 *
 * `dt` is fed twice on purpose: `BikeOrnament` primes `prevYaw` on its first call
 * and skips the spin when `dt <= 0`, so a single call would measure the priming
 * frame. The FIRST call here is the priming one and its numbers are discarded.
 */
function spinOnce(
  style: (typeof STYLES)[number],
  speedMps: number,
  dt: number,
  cadence: number | null | undefined,
): { crank: number; wheel: number } | null {
  const scene = new THREE.Scene();
  const bike = new BikeOrnament(scene, strategies[style]);
  const parts = (bike as unknown as {
    parts: { crank: THREE.Object3D | null; wheels: THREE.Object3D[] } | null;
  }).parts;
  if (!parts?.crank || !parts.wheels.length) { bike.dispose(); return null; }
  const pos = new THREE.Vector3(0, 0, 0);
  bike.update(pos, 0, speedMps, dt, cadence as number | null);
  const c0 = parts.crank.rotation.z, w0 = parts.wheels[0].rotation.z;
  bike.update(pos, 0, speedMps, dt, cadence as number | null);
  const out = { crank: parts.crank.rotation.z - c0, wheel: parts.wheels[0].rotation.z - w0 };
  bike.dispose();
  return out;
}

{
  const DT = 1 / 60, SPEED = 8.5;      // 8.5 m/s ≈ 30.6 km/h

  for (const style of STYLES) {
    const fallback = spinOnce(style, SPEED, DT, null);
    check(`${style}: 三個世界的車都有曲柄(沒有的話下面每一條都是空的)`,
      fallback !== null && fallback.wheel !== 0,
      fallback ? `車輪 ${fallback.wheel.toExponential(3)} rad/幀` : '沒有曲柄或沒有輪子');
  }

  // ── 退路:沒有踏頻感測器 → 一格沒動(這是這個參數出現以前的行為)──
  for (const style of STYLES) {
    const a = spinOnce(style, SPEED, DT, null)!;
    const b = spinOnce(style, SPEED * 2, DT, null)!;
    // 0.4 是 `CRANK_RATIO`,而這裡寫死它是**故意的**:這一格要盯的就是「沒有踏頻時
    // 跟以前逐位元組相同」,所以它必須是一個不准動的字面值。
    check(`${style}: 踏頻 = null → 曲柄 = 車輪 × 0.4(CRANK_RATIO,舊行為原封不動)`,
      Math.abs(a.crank - a.wheel * 0.4) < 1e-15
      && Math.abs(b.crank - b.wheel * 0.4) < 1e-15
      && Math.abs(b.crank - 2 * a.crank) < 1e-15,
      `${a.crank.toExponential(4)} / 車輪 ${a.wheel.toExponential(4)}`
      + `(速度加倍 → ${b.crank.toExponential(4)})`);
    // 省略參數必須跟 null 完全一樣 —— 另外兩個世界的呼叫端若有一天忘了傳,行為
    // 不能靜靜地換掉。
    const omitted = spinOnce(style, SPEED, DT, undefined)!;
    check(`${style}: 不傳這個參數 === 傳 null(呼叫端漏了不會改變畫面)`,
      omitted.crank === a.crank && omitted.wheel === a.wheel);
  }

  // ── 有踏頻:rpm → rad/s,而且跟車速無關(這就是那個 bug)──
  {
    const RPM = 90;
    const want = -(RPM / 60) * Math.PI * 2 * DT;
    const at1 = spinOnce('circuit', SPEED, DT, RPM)!;
    const at2 = spinOnce('circuit', SPEED * 3, DT, RPM)!;
    check('踏頻 90 rpm → 曲柄每幀 −(90/60)×2π×dt,而且**車速換三倍也不變**',
      Math.abs(at1.crank - want) < 1e-15 && at1.crank === at2.crank
      && at2.wheel !== at1.wheel,
      `${at1.crank.toExponential(6)} / 應為 ${want.toExponential(6)}`
      + `(車輪 ${at1.wheel.toExponential(3)} → ${at2.wheel.toExponential(3)})`);

    // 這個 fixture 必須讓「真踏頻」與「車輪 × 0.4」**算出不同的數**,不然上面那條
    // 在出貨的數字下是恆真的(§6.3「兩種實作在出貨的數字下等價」)。
    const fb = spinOnce('circuit', SPEED, DT, null)!;
    check('(這個 fixture 真的分得開兩條路:真踏頻 ≠ 車輪 × 0.4)',
      Math.abs(at1.crank - fb.crank) > 1e-4,
      `真踏頻 ${at1.crank.toExponential(4)} vs 退路 ${fb.crank.toExponential(4)}`
      + `(差 ${(100 * Math.abs(at1.crank / fb.crank - 1)).toFixed(1)}%)`);

    // dt 也要真的被乘進去(前幾輪的突變盲點之一:每幀固定量在均勻 dt 下看不出來)。
    const half = spinOnce('circuit', SPEED, DT / 2, RPM)!;
    check('曲柄轉的量正比於 dt(不是每幀固定量)',
      Math.abs(half.crank - at1.crank / 2) < 1e-15,
      `dt/2 → ${half.crank.toExponential(6)} vs dt → ${at1.crank.toExponential(6)}`);
  }

  // ── 0 rpm ≠ 沒有踏頻。這是整個介面為什麼是 `number | null` 的那一條 ──
  for (const style of STYLES) {
    const stopped = spinOnce(style, SPEED, DT, 0)!;
    const unknown = spinOnce(style, SPEED, DT, null)!;
    check(`${style}: 0 rpm → 曲柄**不轉**,而車輪照轉(踩停了不是沒感測器)`,
      stopped.crank === 0 && stopped.wheel !== 0,
      `曲柄 ${stopped.crank} / 車輪 ${stopped.wheel.toExponential(3)}`);
    check(`${style}: 而且 0 跟 null 畫出來不一樣(0 是「停了」,null 是「不知道」)`,
      stopped.crank !== unknown.crank,
      `0 → ${stopped.crank} vs null → ${unknown.crank.toExponential(4)}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[rider signals: 夜的那個數字只有一個來源]');
// ═════════════════════════════════════════════════════════════════════════════
{
  // 電子的火花亮度是 `wattGain × (0.34 + 0.5 × k)`,而 `k` 必須是**夜燈驅動寫下的
  // 那一個**,不是第二個「現在多暗」。這條盯的是那個讀取端真的讀到寫進去的值。
  const before = nightLitFactor();
  setNightLitFactor(0.37);
  const read = nightLitFactor();
  setNightLitFactor(before);
  check('nightLitFactor() 讀到的就是 setNightLitFactor() 寫下的那一個(不是另一份狀態)',
    read === 0.37 && nightLitFactor() === before, `寫 0.37 → 讀 ${read}`);
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\n[rider signals: 從 store 到 strategy 的每一跳都接上了]');
// ═════════════════════════════════════════════════════════════════════════════
/**
 * ⚠ **這一節是原始碼文字斷言,而上面每一節都不是。** 理由:這一跳住在
 * `GameView.vue` 的 rAF 迴圈與 `useTerrainRenderer` 的 `render()` 裡,而
 * `useTerrainRenderer` 沒有 WebGL context 就走不到 `render()`(它第一件事就是
 * `if (!gameRenderer) return;`)。所以這裡能證明的只有「那幾行還在」,不是「它們
 * 真的跑了」—— 這比沒有強,但**它是這支檔案裡最弱的一節**,不要拿它當行為證明。
 *
 * 它要抓的是一種很具體的退化:hook 宣告在介面上、strategy 也實作了、上面那些行為
 * 斷言全綠,而中間有人把 `setRiderSignals` 那一段刪掉或改成傳 0。那樣的話畫面上
 * 什麼都不會動,而**除了這一節以外沒有任何東西會失敗**。
 */
{
  const src = (p: string): string => readFileSync(p, 'utf8');
  const view = src('packages/web/src/views/GameView.vue');
  const rend = src('packages/web/src/composables/useTerrainRenderer.ts');

  check('GameView 每幀把訊號交給 3D renderer,而且三個欄位都在',
    /terrainRenderer!?\.setRiderSignals\(\{[\s\S]{0,400}?cadenceRpm:[\s\S]{0,400}?powerW:[\s\S]{0,400}?powerSource:/.test(view),
    'terrainRenderer.setRiderSignals({ cadenceRpm, powerW, powerSource })');

  check('踏頻來自 sensor store 的踏頻通道(速度/踏頻感測器優先,再退到功率計那一路)',
    /currentCadence\s*=\s*computed<number \| null>\(\s*\(\)\s*=>\s*sensorStore\.sc\?\.cadence\s*\?\?\s*sensorStore\.pwr\?\.cadence\s*\?\?\s*null/.test(view)
    && /cadenceRpm:\s*currentCadence\.value/.test(view),
    'currentCadence = sc.cadence ?? pwr.cadence ?? null');

  // 「還沒有幀」要傳 null,不是 0。powerW 的初值就是 0,直接傳等於把「不知道」
  // 說成「沒出力」—— 而那正是這個介面存在的理由。
  check('第一幀還沒到之前傳 null 而不是 powerW 的初值 0',
    /powerW:\s*gameStateStore\.hasFrames\s*\?\s*gameStateStore\.powerW\s*:\s*null/.test(view)
    && /powerSource:\s*gameStateStore\.hasFrames\s*\?\s*gameStateStore\.powerSource\s*:\s*null/.test(view),
    'hasFrames ? … : null');

  check('renderer 有 setRiderSignals,而且它在對外的 API 表上(不然 GameView 叫不到)',
    /function setRiderSignals\(signals: RiderSignals\): void \{\s*riderSignals = signals;\s*\}/.test(rend)
    && /^\s{4}setRiderSignals,$/m.test(rend));

  check('render() 每幀把訊號交給 strategy(而且是可選呼叫 —— 沒宣告的世界不被叫到)',
    /strategy\?\.updateRiderSignals\?\.\(riderSignals, dt\);/.test(rend));

  check('render() 也把踏頻交給曲柄(不是只交給 strategy)',
    /bike\?\.update\([^)]*riderSignals\.cadenceRpm\)/.test(rend));

  // 前端只負責 render:這條 hook 上不准長出計算。`riderSignals` 只准出現在四個
  // 地方 —— 宣告、setter 的那一個賦值、交給曲柄、交給 strategy。多出來的第五個
  // 幾乎一定是在算什麼(平滑、門檻、區間),而那是後端的事。
  const sites = rend.match(/riderSignals/g)?.length ?? 0;
  check('這條路上沒有新的業務邏輯:renderer 只是存下來再轉手(riderSignals 只有四個出現點)',
    sites === 4
    && /let riderSignals: RiderSignals = \{ cadenceRpm: null, powerW: null, powerSource: null \};/.test(rend),
    `${sites} 個出現點(宣告 / setter 賦值 / 曲柄 / strategy)`);
}

for (const s of Object.values(strategies)) s.dispose();
