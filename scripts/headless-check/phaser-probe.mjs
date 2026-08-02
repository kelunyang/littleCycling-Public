/**
 * Headless CPU preview for plan/phaser-*-demo.html.
 *
 * The three.js demos have demo-probe.mjs; the Phaser ones had nothing, so a 2D
 * demo could only be checked by opening a browser. This stubs Phaser itself —
 * Scene, Game, Graphics, Container, Camera — records every Graphics draw call
 * the scene makes, then rasterises them in depth order with a tiny scanline
 * filler and writes a PNG.
 *
 * The `Graphics` stub and the scanline filler live in `phaser-stub.mjs`, shared
 * with `phaser-style-probe.mjs` — read that file's header for what the stub
 * does and does not model. Everything below is the DEMO harness: the fake
 * browser, the fake Phaser namespace, the camera transform, and the PNG writer.
 *
 * It is NOT Phaser: strokes are quads and blend modes are plain source-over
 * alpha. It answers "is the picture roughly right, in the right order, in the
 * right place" — which is the question that actually bites (things drawn under
 * the terrain, coordinates off by a screen, a layer that never draws at all).
 *
 *   node phaser-probe.mjs <html> <out.png> [--frames N] [--w N] [--h N]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { Sink, makeGraphics, createRaster, rgb, unstubbedReport } from './phaser-stub.mjs';

const [, , htmlPath, outPath, ...rest] = process.argv;
const opt = (n, d) => { const i = rest.indexOf('--' + n); return i < 0 ? d : rest[i + 1]; };
const W = Number(opt('w', 1280)), H = Number(opt('h', 720));
const FRAMES = Number(opt('frames', 90));

// ── recorded draw list ──
// One sink for the whole scene: depth ordering is global here, unlike the style
// probe where every case gets its own.
const sink = new Sink();

class Container {
  constructor(scene, x, y, kids) { this.scene = scene; this.x = x; this.y = y; this.kids = kids || []; this.depth = 0; this.rot = 0; }
  setDepth(d) { this.depth = d; for (const k of this.kids) k.depth = d; return this; }
  setPosition(x, y) {
    this.x = x; this.y = y;
    for (const k of this.kids) { k.x = x; k.y = y; k.rot = this.rot; }
    return this;
  }
  setRotation(r) { this.rot = r; for (const k of this.kids) k.rot = r; return this; }
  setAlpha(a) { this.alpha = a; for (const k of this.kids) k.alpha = a; return this; }
  setScale(s) { this.scale = s; return this; }
  setVisible(v) { this.visible = v; for (const k of this.kids) k.visible = v; return this; }
  setScrollFactor(f) { for (const k of this.kids) k.sf = f; return this; }
  destroy() { for (const k of this.kids) k.destroy?.(); }
}

const camera = {
  zoom: 1, cx: 0, cy: 0,
  setZoom(z) { this.zoom = z; return this; },
  centerOn(x, y) { this.cx = x; this.cy = y; return this; },
};

const Phaser = {
  AUTO: 0, HEADLESS: 4,
  Scale: { RESIZE: 3, CENTER_BOTH: 3, FIT: 1 },
  Math: { Clamp: (v, a, b) => Math.min(b, Math.max(a, v)) },
  Display: {
    Color: {
      ValueToColor: (v) => ({ r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }),
      GetColor: (r, g, b) => (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b),
      Interpolate: {
        ColorWithColor: (a, b, steps, t) => ({
          r: a.r + (b.r - a.r) * (t / (steps || 1)),
          g: a.g + (b.g - a.g) * (t / (steps || 1)),
          b: a.b + (b.b - a.b) * (t / (steps || 1)),
        }),
      },
    },
  },
  Scene: class {
    constructor() {
      // Only graphics/container are modelled; everything else on scene.add
      // returns a chainable no-op so an unmodelled call cannot abort the run.
      this.add = new Proxy({
        graphics: () => makeGraphics(sink, this),
        container: (x, y, kids) => new Container(this, x, y, kids),
      }, { get: (t, p) => (p in t ? t[p] : () => chainNoop()) });
      this.cameras = { main: camera };
      this.scale = { width: W, height: H, on: () => {} };
      // Permissive: the demos reach for assorted texture-manager methods
      // (remove / get / addCanvas / …). Anything not listed is a no-op rather
      // than a crash — this probe is about the picture, not texture bookkeeping.
      this.textures = new Proxy({
        exists: () => true,
        createCanvas: () => ({ getContext: () => stub2d(), refresh() {} }),
      }, { get: (t, p) => (p in t ? t[p] : () => {}) });
      this.tweens = { add: () => chainNoop() };
      this.time = { addEvent: () => chainNoop(), delayedCall: () => chainNoop() };
      this.input = new Proxy({}, { get: () => () => {} });
    }
  },
  Game: class {
    constructor(cfg) {
      const S = cfg.scene;
      const inst = new S();
      inst.create();
      // DIST=<metres>: jump down the route instead of waiting ~8 m/s of frames
      if (process.env.DIST) inst.dist = Number(process.env.DIST);
      if (process.env.NIGHT === '0') { inst.night = false; inst.drawSky?.(); }
      if (process.env.NIGHT === '1') { inst.night = true; inst.drawSky?.(); }
      if (process.env.POWER === '0') inst.power = 0;
      let t = 0;
      for (let i = 0; i < FRAMES; i++) { t += 16.7; inst.update(t, 16.7); }
      globalThis.__scene = inst;
    }
  },
};
/** Chainable object where every method returns itself — for unmodelled Phaser
 *  game objects (tileSprite, image, text…), which the demos only configure. */
function chainNoop() {
  const o = new Proxy({ x: 0, y: 0, width: 0, height: 0 }, {
    get: (t, p) => (p in t ? t[p] : () => o),
    set: (t, p, v) => { t[p] = v; return true; },
  });
  return o;
}
function stub2d() {
  const gradient = { addColorStop: () => {} };
  return new Proxy({
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => null,
    getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  }, {
    get(t, p) { return p in t ? t[p] : (typeof p === 'string' && /^[a-z]/.test(p) ? () => {} : undefined); },
    set() { return true; },
  });
}

const els = new Map();
globalThis.document = {
  getElementById: (id) => {
    if (!els.has(id)) els.set(id, { textContent: '', style: {}, addEventListener() {}, classList: { toggle() {} } });
    return els.get(id);
  },
  createElement: () => ({ width: 0, height: 0, getContext: () => stub2d(), style: {} }),
  addEventListener() {},
};
// A real browser always has `location`, so demo code that reads query params is
// perfectly legitimate — but this stub used to omit it, which made any such demo
// die with "location is not defined" the moment it was added. Two features have
// now been bitten by that. Provide it, and let QS drive it the same way
// demo-probe does, so `?paint=0`-style switches are testable here too.
const QS = process.env.QS ?? '';
globalThis.location = { search: QS, pathname: '/probe.html', href: 'file:///probe.html' + QS };
globalThis.window = {
  addEventListener() {}, innerWidth: W, innerHeight: H, location: globalThis.location,
};
globalThis.Phaser = Phaser;

// ── run the demo's own script block ──
const html = readFileSync(htmlPath, 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (blocks.length < 2) throw new Error(`expected 2 <script> blocks, got ${blocks.length}`);
new Function(blocks[1])();     // block 0 is the Phaser bundle; we replaced Phaser

// ── rasterise ──
const R = createRaster(W, H);

// world -> screen, honouring per-axis scrollFactor like Phaser does:
// the camera offset an object feels is scaled by its own scrollFactor, so 0
// pins it to the screen, 1 scrolls with the world, and anything between is
// parallax.
const proj = (x, y, g) => {
  let wx = x, wy = y;
  if (g && g.rot) {
    const c = Math.cos(g.rot), s = Math.sin(g.rot);
    wx = x * c - y * s; wy = x * s + y * c;
  }
  if (g && (g.x || g.y)) { wx += g.x; wy += g.y; }
  // Phaser's actual transform is screen = (world - camera.scroll * factor) * zoom,
  // and scroll is the viewport's top-left, not its centre. Folding the +W/2 in
  // unconditionally (as if scroll were the centre) is only correct at factor 1 —
  // at factor 0 it puts the layer half a screen off, which is what made the
  // hand-drawn demo's parallax hills appear to sink behind the terrain.
  const z = camera.zoom;
  const fx = g ? g.sfx : 1, fy = g ? g.sfy : 1;
  const sX = camera.cx - W / (2 * z), sY = camera.cy - H / (2 * z);
  return [(wx - sX * fx) * z, (wy - sY * fy) * z];
};

let drawn = 0;
const cmds = sink.cmds;
cmds.sort((a, b) => (a.depth - b.depth) || (a.seq - b.seq));
for (const c of cmds) {
  if (c.g.visible === false) continue;
  const col = rgb(c.col);
  // Live alpha, not the value at push time: a demo may setAlpha() a whole layer
  // after it has drawn into it.
  const al = c.a * (c.g.alpha ?? 1);
  const z = camera.zoom;
  const P = (x, y) => proj(x, y, c.g);
  if (c.t === 'poly') {
    R.fillPoly(c.pts.map(([x, y]) => P(x, y)), col, al);
  } else if (c.t === 'line') {
    const [ax, ay] = P(c.x1, c.y1), [bx, by] = P(c.x2, c.y2);
    R.strokeQuad(ax, ay, bx, by, c.w * z, col, al);
  } else if (c.t === 'circ') {
    const [cx, cy] = P(c.x, c.y);
    R.fillDisc(cx, cy, c.rx * z, c.ry * z, col, al);
  } else if (c.t === 'ring') {
    const [cx, cy] = P(c.x, c.y);
    R.fillDisc(cx, cy, c.rx * z, c.ry * z, col, al, undefined, c.w * z);
  }
  drawn++;
}
console.log(`draw commands: ${cmds.length} (rasterised ${drawn})`);
const byDepth = new Map();
for (const c of cmds) byDepth.set(c.depth, (byDepth.get(c.depth) ?? 0) + 1);
console.log('by depth:', [...byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([d, n]) => `${d}:${n}`).join('  '));
const s = globalThis.__scene;
if (s) console.log(`scene: dist=${s.dist?.toFixed?.(0)} speed=${s.speed?.toFixed?.(1)} camY=${s.camY?.toFixed?.(0)} zoom=${camera.zoom.toFixed(2)}`);
// Silent no-ops are how a missing shape becomes a confident "the picture is fine".
const missed = unstubbedReport();
if (missed) console.log('⚠ unstubbed Graphics calls (drawn as nothing):', missed);

function chunkPng(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
const scan = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y++) R.buf.copy(scan, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(outPath, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunkPng('IHDR', ihdr), chunkPng('IDAT', deflateSync(scan)), chunkPng('IEND', Buffer.alloc(0)),
]));
console.log('wrote', outPath);
