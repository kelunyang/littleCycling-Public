/**
 * `[2D bodies vs demo — circuit (electronics)]`
 *
 * The 2D reference is a DRAW-COMMAND STREAM: the demo's own functions are sliced
 * out of `plan/phaser-circuit-demo.html`, executed through `phaser-stub`'s
 * recorder, and diffed command for command against the shipping
 * `PhaserStyleStrategy`. Same recipe the plastic 2D port was verified with.
 *
 * Four of the six packages can be driven to scale exactly 1 through
 * `renderBuilding` and are compared verbatim. `cap` and `nixie` cannot (their
 * natural height is already past `LANDMARK_PX`), so those two are compared after
 * normalising the recorded coordinates by (v − origin) / s — which works
 * precisely because every constant in the port's versions is proportional to s.
 *
 *   node --no-warnings --import ./scripts/headless-check/register.mjs \
 *     scripts/headless-check/circuit-2d-vs-demo.ts
 */
import { readFileSync } from 'node:fs';

const { Sink, makeGraphics } = await import('./phaser-stub.mjs');
const { createStyleStrategy } = await import('@/game/phaser/phaser-style-strategy');

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const SRC = readFileSync('plan/phaser-circuit-demo.html', 'utf8');
function sliceFn(name: string): string {
  const at = SRC.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`cannot slice ${name}`);
  let i = SRC.indexOf('{', at), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(at, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
function sliceMethod(name: string): string {
  const at = SRC.indexOf(`\n  ${name}(`);
  if (at < 0) throw new Error(`cannot slice method ${name}`);
  let i = SRC.indexOf('{', at), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(at + 1, i + 1); }
  }
  throw new Error('unbalanced');
}
function sliceStmt(head: string): string {
  const at = SRC.indexOf(head);
  if (at < 0) throw new Error(`cannot slice ${head}`);
  if (head.trimEnd().endsWith('{')) return SRC.slice(at, SRC.indexOf('\n};', at) + 3);
  return SRC.slice(at, SRC.indexOf('\n', at));
}

const GROUND = 400;
const demoSrc = [
  sliceStmt('const C = {'),
  sliceStmt('const SEG7 = '),
  sliceStmt('const MASK_T = '),
  sliceStmt('const COPPER_LAYERS = '),
  sliceStmt('const BOARD_T = '),
  sliceStmt('const BUS_N = 3'),
  sliceStmt('const BUS_PITCH = '),
  sliceStmt('const ZONE_MASK = {'),
  'const PXM = 3;',
  'const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));',
  `const terrainY = () => ${GROUND};`,
  "const zoneAt = () => 'residential';",
  sliceFn('darken'),
  sliceFn('seeded'),
  sliceFn('busLevel'),
  sliceFn('busOffset'),
  sliceFn('legPin'),
  sliceFn('segDigit'),
  sliceFn('drawCap'),
  sliceFn('drawLedBody'),
  sliceFn('drawLedGlow'),
  sliceFn('ceramicLed'),
  sliceFn('drawDip'),
  sliceFn('nixieGeom'),
  sliceFn('nixieDigit'),
  sliceFn('drawNixie'),
  sliceFn('glowNixie'),
  sliceFn('drawXformer'),
  sliceFn('tubeGeom'),
  sliceFn('drawTube'),
  sliceFn('glowTube'),
  `const board = { boardGfx: null, ${sliceMethod('drawBoard')} };`,
  'return { drawCap, drawDip, drawNixie, glowNixie, drawXformer, drawTube, glowTube,'
  + ' board, ZONE_MASK };',
].join('\n');
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const demo = new Function(demoSrc)() as Record<string, never>;
const style = await createStyleStrategy('circuit');

type Cmd = Record<string, unknown>;
function fmt(c: Cmd): string {
  const k = Object.keys(c).filter((x) => !['g', 'seq', 'ga', 'depth'].includes(x));
  k.sort();
  return k.map((x) => {
    const v = (c as never)[x];
    if (Array.isArray(v)) {
      return `${x}=[${(v as number[][]).map((p) => p.map((n) => (+n).toFixed(3)).join(',')).join(' ')}]`;
    }
    return `${x}=${typeof v === 'number' ? (v as number).toFixed(3) : String(v)}`;
  }).join(' ');
}
function record(fn: (g: never) => void): Cmd[] {
  const sink = new Sink();
  fn(makeGraphics(sink) as never);
  return sink.cmds as Cmd[];
}
function diff(label: string, ours: Cmd[], theirs: Cmd[]): void {
  const a = ours.map(fmt), b = theirs.map(fmt);
  let bad = 0;
  const first: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      bad++;
      if (first.length < 2) first.push(`[${i}] demo ${b[i] ?? '(none)'} | ours ${a[i] ?? '(none)'}`);
    }
  }
  check(label, bad === 0,
    bad === 0 ? `${a.length} draw commands, identical` : `${bad} of ${Math.max(a.length, b.length)} differ; ${first.join(' ;; ')}`);
}

const seeded = (n: number): number => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

console.log('\n[2D bodies vs demo — circuit (electronics)]');

// ── the board: the thing that fills the screen ─────────────────────────────
{
  const LEFT = 0, RIGHT = 1200, BOTTOM = 700;
  const dSink = new Sink();
  (demo.board as never as { boardGfx: unknown }).boardGfx = makeGraphics(dSink);
  (demo.board as never as { drawBoard: (v: unknown) => void })
    .drawBoard({ left: LEFT + 60, right: RIGHT - 60, bottom: BOTTOM - 200 });
  const theirs = dSink.cmds as Cmd[];

  const points: { x: number; y: number }[] = [];
  for (let x = LEFT; x <= RIGHT; x += 6) points.push({ x, y: GROUND });
  const ours = record((g) => {
    (style as never as { drawTerrainSurface: (...a: unknown[]) => void })
      .drawTerrainSurface(g, points, BOTTOM, 0, null);
  });

  const Z = (demo.ZONE_MASK as never as Record<string, { c: number; hi: number }>).residential;
  const MASK_HI = 0x17734c, TRACE = 0x23f0ff;
  // TWO documented deviations, and the check pins both rather than hiding them:
  //  · the district band. `drawTerrainSurface` carries no zone, so the port
  //    cannot tint the mask per district (it needs a hook — see the report).
  //  · the powered bus is drawn in the DAY layer here: a 2D strategy never gets
  //    the additive night layer.
  const dBand = theirs.filter((c) => c.col === Z.c);
  const oTrace = ours.filter((c) => c.col === TRACE);
  check('deviation pinned: the demo tints the mask per district, the port cannot',
    dBand.length === 1 && ours.every((c) => c.col !== Z.c), `demo ${dBand.length} band poly`);
  check('deviation pinned: the port lays the powered bus into the day layer',
    oTrace.length > 0 && theirs.every((c) => c.col !== TRACE),
    `${oTrace.length} powered-trace commands`);
  // Everything else must be the demo's, command for command — including the
  // surface highlight, which is the district's `hi` there and the base mask
  // green here.
  diff('board layer stack, weave, vias, pads and silkscreen ruler',
    ours.filter((c) => c.col !== TRACE),
    theirs.filter((c) => c.col !== Z.c)
      .map((c) => (c.col === Z.hi ? { ...c, col: MASK_HI } : c)));
}

// ── the six packages, at scale exactly 1 where the landmark rule allows ─────
const N_H: Record<string, number> = { xformer: 47, dip: 31, ceramic: 31, tube: 127 };
const N_W: Record<string, number> = { xformer: 74, dip: 62, ceramic: 62, tube: 40 };
const WIDE: Record<string, number> = { xformer: 1.7, dip: 1.7, ceramic: 1.7, tube: 1.5 };
const ZONE: Record<string, string> = {
  xformer: 'industrial', dip: 'school', ceramic: 'hospital', tube: 'residential',
};
const X = 200, BASE = 400;
for (const kind of Object.keys(N_H)) {
  const h = N_H[kind];
  const w = Math.ceil(N_W[kind] / WIDE[kind]) + 2;
  let seed = 0;
  for (let k = 1; k < 5000; k++) {
    if (kind === 'tube' || seeded(k * 23 + 3) < 0.8) { seed = k; break; }
  }
  const p = { scale: 1, tint: 0, flip: seeded(seed * 7 + 1.3) > 0.5 ? -1 : 1, d: seed };
  const ours = record((g) => {
    (style as never as { renderBuilding: (...a: unknown[]) => unknown })
      .renderBuilding(g, X - w / 2, BASE - h, w, h, 0, seed, ZONE[kind]);
  });
  const theirs = record((g) => {
    if (kind === 'xformer') (demo.drawXformer as never as (...a: unknown[]) => void)(g, X, BASE, p);
    else if (kind === 'dip') (demo.drawDip as never as (...a: unknown[]) => void)(g, X, BASE, p, false);
    else if (kind === 'ceramic') (demo.drawDip as never as (...a: unknown[]) => void)(g, X, BASE, p, true);
    else (demo.drawTube as never as (...a: unknown[]) => void)(g, X, BASE, p);
  });
  diff(`${kind} at scale 1`, ours, theirs);
}

// ── the two night layers ───────────────────────────────────────────────────
for (const [kind, h, nw, wide, zone] of [
  ['nixie', 47, 72, 1.7, 'commercial'], ['tube', 127, 40, 1.5, 'residential'],
] as const) {
  const s = kind === 'tube' ? 1 : h / 60;
  const w = Math.ceil((nw * s) / wide) + 2;
  let seed = 0;
  for (let k = 1; k < 5000; k++) {
    if (kind === 'tube' || seeded(k * 23 + 3) < 0.8) { seed = k; break; }
  }
  const p = { scale: s, tint: 0, flip: 1, d: seed };
  const ours = record((g) => {
    (style as never as { renderBuildingLights: (...a: unknown[]) => void })
      .renderBuildingLights(g, X - w / 2, BASE - h, w, h, 0, seed, zone);
  });
  const theirs = record((g) => {
    if (kind === 'nixie') (demo.glowNixie as never as (...a: unknown[]) => void)(g, X, BASE, p, 1);
    else (demo.glowTube as never as (...a: unknown[]) => void)(g, X, BASE, p, 1);
  });
  diff(`${kind} night glow`, ours, theirs);
}

// ── the two the landmark rule keeps off scale 1 ────────────────────────────
// `cap` and `nixie` are 72 / 60 px tall at scale 1, past LANDMARK_PX, so they
// can only be reached smaller. Everything the port draws for them is
// proportional to `s` (that is the whole point of the ×s note in the file
// header), so normalising the recorded coordinates by (v − origin) / s turns the
// port's output back into its scale-1 output and the diff is exact again.
// LINE WIDTHS are deliberately NOT normalised: neither side scales those.
const NORM_X = new Set(['x', 'x1', 'x2']);
const NORM_Y = new Set(['y', 'y1', 'y2']);
const NORM_R = new Set(['rx', 'ry']);
function normalise(c: Cmd, ox: number, oy: number, s: number): Cmd {
  const out: Cmd = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === 'pts') {
      out[k] = (v as number[][]).map(([px, py]) => [(px - ox) / s, (py - oy) / s]);
    } else if (NORM_X.has(k)) out[k] = ((v as number) - ox) / s;
    else if (NORM_Y.has(k)) out[k] = ((v as number) - oy) / s;
    else if (NORM_R.has(k)) out[k] = (v as number) / s;
    else out[k] = v;
  }
  return out;
}
for (const [kind, nh, nw, wide, zone] of [
  ['cap', 72, 26, 1.5, 'residential'], ['nixie', 60, 72, 1.7, 'commercial'],
] as const) {
  const h = 47;
  const s = h / nh;
  const w = Math.ceil((nw * s) / wide) + 2;
  // Enough seeds to put ALL TEN seven-segment digits on screen: a single sign
  // shows six, so one seed leaves four bit patterns in SEG7 unexecuted.
  const seeds: number[] = [];
  const seen = new Set<number>();
  for (let k = 1; k < 5000 && (seen.size < 10 || seeds.length < 2); k++) {
    if (seeded(k * 23 + 3) >= 0.8) continue;
    const digits = [0, 1, 2, 5, 6, 7].map(
      (i) => Math.floor(seeded(k * 0.37 + i * 13.3) * 10));
    if (kind === 'nixie' && seeds.length && digits.every((d) => seen.has(d))) continue;
    for (const d of digits) seen.add(d);
    seeds.push(k);
    if (kind === 'cap') break;
  }
  if (kind === 'nixie') {
    check('nixie seeds cover all ten SEG7 digit patterns', seen.size === 10,
      `${seen.size} of 10 across ${seeds.length} seed(s)`);
  }
  let bad = 0;
  let total = 0;
  for (const seed of seeds) {
    const flip = seeded(seed * 7 + 1.3) > 0.5 ? -1 : 1;
    const all = record((g) => {
      (style as never as { renderBuilding: (...a: unknown[]) => unknown })
        .renderBuilding(g, X - w / 2, BASE - h, w, h, 0, seed, zone);
    });
    const theirs = record((g) => {
      const p = { scale: 1, tint: 0, flip, d: seed };
      if (kind === 'cap') (demo.drawCap as never as (...a: unknown[]) => void)(g, X, BASE, p);
      else (demo.drawNixie as never as (...a: unknown[]) => void)(g, X, BASE, p);
    });
    const ours = all.slice(0, theirs.length).map((c) => normalise(c, X, BASE, s));
    const A = ours.map(fmt), B = theirs.map((c) => normalise(c, X, BASE, 1)).map(fmt);
    total += B.length;
    if (all.length < theirs.length) bad++;
    for (let i = 0; i < B.length; i++) if (A[i] !== B[i]) bad++;
  }
  check(`${kind} at scale ${s.toFixed(4)}, normalised back to 1 (${seeds.length} seed(s))`,
    bad === 0, bad === 0 ? `${total} draw commands, identical` : `${bad} differ`);
}

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
