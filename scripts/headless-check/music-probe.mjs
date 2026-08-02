/**
 * Headless check for plan/theme-music-demo-*.html.
 *
 * Audio cannot be heard here, but almost everything that actually breaks a
 * generative score is checkable without ears:
 *   - NaN / Infinity reaching an AudioParam (silently kills a whole voice, and
 *     in a real AudioContext throws only sometimes)
 *   - notes referencing a voice name that does not exist (silent no-op)
 *   - midi numbers outside anything audible, negative durations, negative time
 *   - a "loop" whose notes do not actually cover its stated length (dead bars)
 *   - the same seed not reproducing the same piece (breaks route-seeded BGM)
 *
 * It stubs Web Audio, runs every world's composer, validates the note list, and
 * then plays every note through the real voice code with the stub so any bad
 * parameter surfaces.
 *
 *   node music-probe.mjs plan/theme-music-demo-opus.html
 */
import { readFileSync } from 'node:fs';

const htmlPath = process.argv[2];
if (!htmlPath) throw new Error('usage: music-probe.mjs <html>');

const issues = [];
const bad = (v) => typeof v !== 'number' || !Number.isFinite(v);

// ── Web Audio stub: every AudioParam write is checked ──
function paramStub(owner, name) {
  const chk = (m, v, t) => {
    if (bad(v)) issues.push(`${owner}.${name}.${m}() value = ${v}`);
    if (t !== undefined && bad(t)) issues.push(`${owner}.${name}.${m}() time = ${t}`);
  };
  return {
    _v: 0,
    get value() { return this._v; },
    set value(v) { if (bad(v)) issues.push(`${owner}.${name}.value = ${v}`); this._v = v; },
    setValueAtTime(v, t) { chk('setValueAtTime', v, t); return this; },
    linearRampToValueAtTime(v, t) { chk('linearRampToValueAtTime', v, t); return this; },
    exponentialRampToValueAtTime(v, t) {
      chk('exponentialRampToValueAtTime', v, t);
      // a real context throws on a zero/negative target here
      if (!bad(v) && v <= 0) issues.push(`${owner}.${name}.exponentialRamp target <= 0 (${v})`);
      return this;
    },
    cancelScheduledValues(t) { chk('cancelScheduledValues', 0, t); return this; },
  };
}
const node = (kind) => ({
  _kind: kind,
  connect() { return this; },
  disconnect() {},
  start(t) { if (t !== undefined && bad(t)) issues.push(`${kind}.start(${t})`); },
  stop(t) { if (t !== undefined && bad(t)) issues.push(`${kind}.stop(${t})`); },
  frequency: paramStub(kind, 'frequency'),
  detune: paramStub(kind, 'detune'),
  gain: paramStub(kind, 'gain'),
  Q: paramStub(kind, 'Q'),
  type: 'sine',
  setPeriodicWave() {},
  buffer: null,
});

let voicesExercised = 0;
class AudioContextStub {
  constructor() { this.currentTime = 1; this.sampleRate = 48000; this.state = 'running'; this.destination = node('dest'); }
  createGain() { return node('gain'); }
  createOscillator() { return node('osc'); }
  createBiquadFilter() { return node('filter'); }
  createBufferSource() { return node('bufsrc'); }
  createBuffer(ch, len, sr) {
    if (bad(len) || len < 1) issues.push(`createBuffer length = ${len}`);
    const d = new Float32Array(Math.max(1, len | 0));
    return { getChannelData: () => d, length: d.length, sampleRate: sr };
  }
  createPeriodicWave(re, im) {
    for (const a of [re, im]) for (const v of a) if (bad(v)) issues.push('periodicWave coefficient NaN');
    return { _wave: true };
  }
  resume() {}
}

const els = new Map();
globalThis.window = { AudioContext: AudioContextStub };
globalThis.document = {
  getElementById: (id) => {
    if (!els.has(id)) els.set(id, { textContent: '', innerHTML: '', dataset: {}, className: '',
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      addEventListener() {}, appendChild() {}, setAttribute() {} });
    return els.get(id);
  },
  querySelectorAll: () => [],
  createElement: () => ({ className: '', dataset: {}, classList: { toggle() {}, add() {} } }),
  body: { dataset: {} },
};

const html = readFileSync(htmlPath, 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const app = blocks[blocks.length - 1];

// Run the page, then reach the module-scope bindings we need by re-evaluating
// the source with an epilogue that hands them back.
const runner = new Function(`${app}\nreturn { WORLDS, VOICES, initAudio, startDrone, stopDrone, mtof };`);
const { WORLDS, VOICES, initAudio, startDrone, stopDrone } = runner();

console.log(`worlds: ${Object.keys(WORLDS).join(', ')}`);
initAudio();

let total = 0;
for (const [name, w] of Object.entries(WORLDS)) {
  const a = w.compose(12345);
  const b = w.compose(12345);
  const c = w.compose(999);

  // determinism — route-seeded BGM depends on this
  if (JSON.stringify(a.notes) !== JSON.stringify(b.notes)) issues.push(`${name}: same seed produced a different piece`);
  if (JSON.stringify(a.notes) === JSON.stringify(c.notes)) issues.push(`${name}: different seeds produced an identical piece`);

  const len = a.bars * a.beatsPerBar;
  const voices = new Set();
  let maxT = 0, minMidi = Infinity, maxMidi = -Infinity;
  for (const n of a.notes) {
    if (bad(n.t) || n.t < 0) issues.push(`${name}: note t = ${n.t}`);
    if (bad(n.dur) || n.dur <= 0) issues.push(`${name}: note dur = ${n.dur}`);
    if (bad(n.vel) || n.vel <= 0 || n.vel > 1.5) issues.push(`${name}: note vel = ${n.vel}`);
    if (bad(n.midi)) issues.push(`${name}: note midi = ${n.midi}`);
    if (n.t >= len) issues.push(`${name}: note at t=${n.t} is past the loop length ${len}`);
    if (!VOICES[n.voice]) issues.push(`${name}: unknown voice "${n.voice}"`);
    // midi 0 is the percussion convention here; anything else must be audible
    if (n.midi !== 0 && (n.midi < 24 || n.midi > 108)) issues.push(`${name}: midi ${n.midi} out of audible range`);
    voices.add(n.voice);
    maxT = Math.max(maxT, n.t);
    if (n.midi > 0) { minMidi = Math.min(minMidi, n.midi); maxMidi = Math.max(maxMidi, n.midi); }
  }
  // dead bars: every bar should have at least one note
  const perBar = new Array(a.bars).fill(0);
  for (const n of a.notes) perBar[Math.floor(n.t / a.beatsPerBar)]++;
  const dead = perBar.map((v, i) => (v === 0 ? i : -1)).filter((i) => i >= 0);
  if (dead.length) issues.push(`${name}: silent bars ${dead.join(',')}`);

  // exercise every voice through the real synth code with the stub
  for (const n of a.notes) { VOICES[n.voice](n, 1 + n.t * (60 / a.bpm)); voicesExercised++; }
  startDrone(name); stopDrone();

  total += a.notes.length;
  console.log(
    `  ${name.padEnd(8)} ${String(a.bpm).padStart(3)}bpm ${a.beatsPerBar}/4 ` +
    `${a.bars}bar  notes=${String(a.notes.length).padStart(4)}  ` +
    `voices=${[...voices].join('/')}  midi ${minMidi}–${maxMidi}  ` +
    `coverage=${maxT.toFixed(1)}/${len}`);
}

console.log(`\nexercised ${voicesExercised} note events through the real voice code`);
if (issues.length) {
  const uniq = [...new Set(issues)];
  console.log(`\n!! ${issues.length} problems (${uniq.length} distinct):`);
  for (const u of uniq.slice(0, 30)) console.log('   ' + u);
  process.exitCode = 1;
} else {
  console.log('clean: no NaN into AudioParams, no unknown voices, no dead bars, seeds reproduce');
}
