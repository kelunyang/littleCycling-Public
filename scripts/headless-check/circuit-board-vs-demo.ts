/**
 * `[board texture vs demo — circuit]`
 *
 * The PCB face + glow maps are what fill the screen in the 3D world, and the
 * demo's own rule is that they must be drawn in ONE pass or the night glow lands
 * beside the traces instead of on them. This records every 2D-context call made
 * by the shipping strategy's first two canvases and diffs them against the
 * demo's `pcbTextures(0x1c0de)`, executed here.
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/circuit-board-vs-demo.ts
 */
import { readFileSync } from 'node:fs';

// 這份 stub **不再是自己的**。它原本在 import 時直接覆蓋 `globalThis.document`,
// 而另外五支檢查也各自這麼做 —— 接進 `check:3d` 之後最後一個 import 的贏,先前
// 已經畫過並快取的貼圖留在別人的畫布上。經過寫在 `recording-canvas.ts`。
// 這支要的是最細的那個視角:含樣式變更、有順序的字串 trace。
const { installRecordingCanvas, canvases } = await import('./recording-canvas.ts');
installRecordingCanvas();

type Op = string;

const { createTerrainStyleStrategy } = await import('@/game/terrain/terrain-style-strategy');

// ── the port: its very first two canvases are pcbTextures(0x1c0de)'s face+glow ──
const portStart = canvases.length;
await createTerrainStyleStrategy('circuit');
const portFace = canvases[portStart].trace;
const portGlow = canvases[portStart + 1].trace;

// ── the demo's own pcbTextures, executed ──
const SRC = readFileSync('plan/circuit-town-demo.html', 'utf8');
function sliceFn(name: string): string {
  const at = SRC.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`cannot slice ${name}`);
  let i = SRC.indexOf('{', at), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(at, i + 1); }
  }
  throw new Error('unbalanced');
}
function sliceLine(head: string): string {
  const at = SRC.indexOf(head);
  if (at < 0) throw new Error(`cannot slice ${head}`);
  return SRC.slice(at, SRC.indexOf('\n', at));
}
function sliceBlock(head: string, tail: string): string {
  const at = SRC.indexOf(head);
  if (at < 0) throw new Error(`cannot slice ${head}`);
  const end = SRC.indexOf(tail, at);
  return SRC.slice(at, end + tail.length);
}
const demoSrc = [
  sliceBlock('  const E = {', '\n  };'),
  sliceLine('  const TS = 256;'),
  sliceLine('  const PCB_G = 4;'),
  sliceLine('  const PCB_P = 16;'),
  sliceLine('  const PCB_STAG = 8;'),
  sliceLine('  const PCB_TOP = '),
  sliceLine('  const PCB_BOT = '),
  sliceFn('mulberry32'),
  sliceFn('cv'),
  sliceFn('wrap9'),
  sliceBlock('  const NULL_CTX = (() => {', '})();'),
  sliceFn('pcbTextures'),
  'return pcbTextures;',
].join('\n');
const demoStart = canvases.length;
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const pcbTextures = new Function(demoSrc)() as (seed: number) => unknown;
pcbTextures(0x1c0de);
const demoFace = canvases[demoStart].trace;
const demoGlow = canvases[demoStart + 1].trace;

let failures = 0;
function diff(name: string, ours: Op[], theirs: Op[]): void {
  const n = Math.max(ours.length, theirs.length);
  let bad = 0;
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    if (ours[i] !== theirs[i]) {
      bad++;
      if (lines.length < 12) lines.push(`  [${i}] demo ${theirs[i] ?? '(none)'}  |  ours ${ours[i] ?? '(none)'}`);
    }
  }
  if (bad) failures++;
  console.log(`  ${bad ? '\u2717' : '\u2713'} ${name} — demo ${theirs.length} ops / `
    + `ours ${ours.length}${bad ? `, ${bad} differ` : ', identical'}`);
  for (const l of lines) console.log(l);
}
console.log('\n[board texture vs demo — circuit]');
diff('board face — solder mask, pours, bundles, vias, silkscreen', portFace, demoFace);
diff('board glow — drawn in the SAME pass, so it lands on the traces', portGlow, demoGlow);
console.log(failures ? `\n${failures} FAILED` : '\nall passed');

/** How many assertions failed — so `diorama.ts` can fold this into its tally:
 *
 *   await block('circuit vs demo', async () => {
 *     for (const p of ['./circuit-board-vs-demo', './circuit-3d-vs-demo',
 *       './circuit-2d-vs-demo']) {
 *       failures += ((await import(p)) as { failureCount(): number }).failureCount();
 *     }
 *   });
 *
 * Never sets `process.exitCode` to 0: standalone it fails the run, imported it
 * leaves the host's exit code alone. */
export const failureCount = (): number => failures;
if (failures) process.exitCode = 1;
