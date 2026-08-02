/**
 * Renders a 3D demo's **procedural canvas textures** to PNG, and reports what
 * they cost to build.
 *
 * demo-probe.mjs stubs the 2D context, so every texture there collapses to one
 * average colour — it can tell you a mesh is the wrong shape, never that a
 * texture is the wrong drawing. This runs the same demo source against a small
 * real rasteriser instead, so the canvases can actually be looked at.
 *
 *   node scripts/headless-check/texture-probe.mjs plan/paper-town-demo.html out/
 *
 * env:
 *   QS=?paint=0    query string handed to the demo
 *   ONLY=4,83      dump only these canvas ids (ids are creation order; the
 *                  summary at the end lists them all with their sizes)
 *   NOTILE=1       skip the tile-/zoom- variants (faster, smaller output)
 *   GRID=4         audit strokes on a pixel grid: report vertices off the grid
 *                  and segments that are not 0/45/90 degrees. Circuit traces
 *                  must pass this; nothing else should be run through it.
 *   GRIDID=4       restrict the grid audit to one canvas id.
 *
 * ALWAYS pass GRIDID with GRID. Unrestricted, the audit measures every polyline
 * in the file against a rule that only PCB traces are meant to obey — the moment
 * some other texture grows a hand-drawn wobble (the circuit world's anti-static
 * bag creases did exactly this) you get hundreds of "failures" that are the
 * drawing being correct. A wobbly crease SHOULD be off-grid. Point the ruler at
 * the thing it is a ruler for:
 *     GRID=4 GRIDID=4 node texture-probe.mjs plan/circuit-town-demo.html out/
 * (canvas ids are creation order; the summary lists them all with their sizes)
 *
 * For each canvas it writes tex-NN (the texture), tile-NN (2x2 — seams in a
 * repeating texture are invisible until you tile it) and zoom-NN (3x nearest,
 * for anything under 128px where the detail is otherwise unreadable).
 *
 * Supports the 2D ops the demos actually use: fillRect / strokeRect / rect /
 * beginPath / moveTo / lineTo / closePath / arc / ellipse / fill / stroke /
 * clip / save / restore / translate / globalAlpha / fillStyle / strokeStyle /
 * lineWidth. Round joins and caps only — that is what the demos set. Gradients
 * and text are accepted and skipped, so a texture that leans on them will come
 * out blank here; that is a limitation of this tool, not a finding.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const [, , htmlPath, outDirArg] = process.argv;
if (!htmlPath) throw new Error('usage: texture-probe.mjs <html> [outdir]');
const outDir = outDirArg || 'tex-out';
mkdirSync(outDir, { recursive: true });

const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',').map(Number)) : null;
const GRID = process.env.GRID ? Number(process.env.GRID) : 0;
const GRIDID = process.env.GRIDID ? Number(process.env.GRIDID) : null;
const NOTILE = !!process.env.NOTILE;

function parseCol(v) {
  if (typeof v !== 'string') return null;
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, 1]; }
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [...[...m[1]].map((c) => parseInt(c + c, 16) / 255), 1];
  m = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (m) { const a = m[1].split(',').map(Number); return [a[0] / 255, a[1] / 255, a[2] / 255, a.length > 3 ? a[3] : 1]; }
  return null;
}

const AUDIT = { offGrid: [], badAngle: [], polylines: 0 };
const SS = 3;               // subsamples per axis
class Ctx {
  constructor(cnv) {
    this.cnv = cnv;
    this.W = cnv.width; this.H = cnv.height;
    this.buf = new Float32Array(this.W * this.H * 3);
    this.clipMask = new Float32Array(this.W * this.H).fill(1);
    this.stack = [];
    this.fillStyle = '#000000'; this.strokeStyle = '#000000';
    this.lineWidth = 1; this.globalAlpha = 1;
    this.lineJoin = 'round'; this.lineCap = 'round';
    this.tx = 0; this.ty = 0;
    this.subs = []; this.cur = null;
    this.ops = 0;             // paint calls — the build-cost number
    this.px = 0;              // pixels touched — the real cost number
  }
  save() {
    this.stack.push({
      fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha, tx: this.tx, ty: this.ty, clipMask: this.clipMask.slice(),
    });
  }
  restore() {
    const s = this.stack.pop(); if (!s) return;
    Object.assign(this, s);
  }
  translate(x, y) { this.tx += x; this.ty += y; }
  beginPath() { this.subs = []; this.cur = null; }
  moveTo(x, y) { this.cur = [[x + this.tx, y + this.ty]]; this.subs.push(this.cur); }
  lineTo(x, y) { if (!this.cur) this.moveTo(x, y); else this.cur.push([x + this.tx, y + this.ty]); }
  closePath() { if (this.cur && this.cur.length) { this.cur.push(this.cur[0].slice()); this.cur.closed = true; } }
  rect(x, y, w, h) {
    this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath();
  }
  arc(x, y, r, a0, a1) {
    const n = Math.max(10, Math.ceil(r * 2));
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push([x + this.tx + Math.cos(a0 + (a1 - a0) * i / n) * r,
      y + this.ty + Math.sin(a0 + (a1 - a0) * i / n) * r]);
    pts.closed = true;
    this.subs.push(pts); this.cur = pts;
  }
  createLinearGradient() { return { addColorStop() {}, __grad: true }; }
  createRadialGradient() { return { addColorStop() {}, __grad: true }; }
  createPattern() { return null; }
  measureText() { return { width: 0 }; }
  getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
  putImageData() {}
  fillText() {} strokeText() {} setLineDash() {} drawImage() {} scale() {} rotate() {} clearRect() {}
  quadraticCurveTo(cx, cy, x, y) { this.lineTo(x, y); }
  bezierCurveTo(a, b, c, d, x, y) { this.lineTo(x, y); }
  ellipse(x, y, rx, ry, rot, a0, a1) { this.arc(x, y, (rx + ry) / 2, a0, a1); }

  _paint(col, bbox, inside) {
    const c = parseCol(col);
    if (!c) return;
    this.ops++;
    const ga = this.globalAlpha * c[3];
    if (!(ga > 0)) return;
    const x0 = Math.max(0, Math.floor(bbox[0])), y0 = Math.max(0, Math.floor(bbox[1]));
    const x1 = Math.min(this.W - 1, Math.ceil(bbox[2])), y1 = Math.min(this.H - 1, Math.ceil(bbox[3]));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        let hit = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            if (inside(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)) hit++;
          }
        }
        if (!hit) continue;
        const o = py * this.W + px;
        const a = ga * (hit / (SS * SS)) * this.clipMask[o];
        if (a <= 0) continue;
        this.px++;
        this.buf[o * 3] += (c[0] - this.buf[o * 3]) * a;
        this.buf[o * 3 + 1] += (c[1] - this.buf[o * 3 + 1]) * a;
        this.buf[o * 3 + 2] += (c[2] - this.buf[o * 3 + 2]) * a;
      }
    }
  }
  fillRect(x, y, w, h) {
    const ax = x + this.tx, ay = y + this.ty;
    const bx = ax + w, by = ay + h;
    const lx = Math.min(ax, bx), hx = Math.max(ax, bx), ly = Math.min(ay, by), hy = Math.max(ay, by);
    this._paint(this.fillStyle, [lx, ly, hx, hy], (px, py) => px >= lx && px < hx && py >= ly && py < hy);
  }
  _polyBBox() {
    const a = [1e9, 1e9, -1e9, -1e9];
    for (const s of this.subs) for (const p of s) {
      a[0] = Math.min(a[0], p[0]); a[1] = Math.min(a[1], p[1]);
      a[2] = Math.max(a[2], p[0]); a[3] = Math.max(a[3], p[1]);
    }
    return a;
  }
  _insideFn() {
    const subs = this.subs;
    return (px, py) => {
      let wind = 0;
      for (const s of subs) {
        for (let i = 0; i < s.length; i++) {
          const a = s[i], b = s[(i + 1) % s.length];
          if (a[1] <= py) { if (b[1] > py && (b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1]) > 0) wind++; }
          else if (b[1] <= py && (b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1]) < 0) wind--;
        }
      }
      return wind !== 0;
    };
  }
  fill() { this._paint(this.fillStyle, this._polyBBox(), this._insideFn()); }
  clip() {
    const inside = this._insideFn();
    const bb = this._polyBBox();
    for (let py = 0; py < this.H; py++) {
      for (let px = 0; px < this.W; px++) {
        const o = py * this.W + px;
        if (!this.clipMask[o]) continue;
        if (px + 1 < bb[0] || px > bb[2] + 1 || py + 1 < bb[1] || py > bb[3] + 1) { this.clipMask[o] = 0; continue; }
        let hit = 0;
        for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
          if (inside(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)) hit++;
        }
        this.clipMask[o] *= hit / (SS * SS);
      }
    }
  }
  stroke() {
    if (GRID && (GRIDID === null || this.cnv.id === GRIDID)) {
      for (const s of this.subs) {
        if (s.length < 4 || s.closed) continue;
        for (let i = 0; i < s.length; i++) {
          const p = s[i];
          if (Math.abs(p[0] % GRID) > 1e-6 || Math.abs(p[1] % GRID) > 1e-6) AUDIT.offGrid.push(p.join(','));
          if (i + 1 < s.length) {
            const dx = Math.abs(s[i + 1][0] - p[0]), dy = Math.abs(s[i + 1][1] - p[1]);
            if (!(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6)) AUDIT.badAngle.push(`${p} -> ${s[i + 1]}`);
          }
        }
        AUDIT.polylines++;
      }
    }
    const r = this.lineWidth / 2;
    for (const s of this.subs) {
      for (let i = 0; i + 1 < s.length; i++) {
        const a = s[i], b = s[i + 1];
        const bb = [Math.min(a[0], b[0]) - r - 1, Math.min(a[1], b[1]) - r - 1,
          Math.max(a[0], b[0]) + r + 1, Math.max(a[1], b[1]) + r + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const L2 = dx * dx + dy * dy;
        this._paint(this.strokeStyle, bb, (px, py) => {
          let t = L2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / L2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = px - (a[0] + dx * t), ey = py - (a[1] + dy * t);
          return ex * ex + ey * ey <= r * r;
        });
      }
    }
  }
  strokeRect(x, y, w, h) {
    const keep = this.subs, kc = this.cur;
    this.beginPath(); this.rect(x, y, w, h); this.stroke();
    this.subs = keep; this.cur = kc;
  }
}

let seq = 0;
const canvases = [];
const makeCanvas = () => {
  const c = { width: 0, height: 0, id: seq++, style: {}, addEventListener() {}, setPointerCapture() {} };
  c.getContext = () => (c._ctx ||= new Ctx(c));
  canvases.push(c);
  return c;
};
const els = new Map();
globalThis.document = {
  createElement: (t) => (t === 'canvas' ? makeCanvas() : { style: {}, addEventListener() {} }),
  createElementNS: () => makeCanvas(),
  getElementById: (id) => {
    if (!els.has(id)) {
      els.set(id, { textContent: '', innerHTML: '', style: {}, dataset: {},
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {}, appendChild() {}, setAttribute() {} });
    }
    return els.get(id);
  },
  querySelectorAll: () => [],
  body: { dataset: {}, appendChild() {} },
  addEventListener() {},
};
const win = {
  devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  addEventListener() {}, location: { search: process.env.QS ?? '' },
};
globalThis.window = win; globalThis.self = win; globalThis.location = win.location;
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const html = readFileSync(htmlPath, 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
new Function(blocks[0])();                       // three.js bundle -> window.THREE
const THREE = win.THREE;
globalThis.THREE = THREE;
// The renderer never runs; we only want the textures the demo builds on the way.
THREE.WebGLRenderer = class {
  constructor() { this.shadowMap = {}; this.domElement = makeCanvas(); this.capabilities = { isWebGL2: true, getMaxAnisotropy: () => 1 }; }
  setPixelRatio() {} setSize() {} setClearColor() {} dispose() {} render() {} setAnimationLoop() {}
};
new Function(blocks[blocks.length - 1])();       // the demo itself

function png(path, W, H, buf) {
  const raw = Buffer.alloc(H * (W * 3 + 1));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3, d = y * (W * 3 + 1) + 1 + x * 3;
      raw[d] = Math.round(Math.min(1, Math.max(0, buf[o])) * 255);
      raw[d + 1] = Math.round(Math.min(1, Math.max(0, buf[o + 1])) * 255);
      raw[d + 2] = Math.round(Math.min(1, Math.max(0, buf[o + 2])) * 255);
    }
  }
  const ck = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ck('IHDR', ihdr), ck('IDAT', deflateSync(raw)), ck('IEND', Buffer.alloc(0)),
  ]));
}

/** Repeat the canvas NxM so a seam in a tiling texture becomes visible. */
function tiled(path, c, n) {
  const W = c.width, H = c.height, b = c._ctx.buf;
  const out = new Float32Array(W * n * H * n * 3);
  for (let y = 0; y < H * n; y++) {
    for (let x = 0; x < W * n; x++) {
      const s = ((y % H) * W + (x % W)) * 3, d = (y * W * n + x) * 3;
      out[d] = b[s]; out[d + 1] = b[s + 1]; out[d + 2] = b[s + 2];
    }
  }
  png(path, W * n, H * n, out);
}

/** Nearest-neighbour zoom — small textures are unreadable at 1:1. */
function zoomed(path, c, z) {
  const W = c.width, H = c.height, b = c._ctx.buf;
  const out = new Float32Array(W * z * H * z * 3);
  for (let y = 0; y < H * z; y++) {
    for (let x = 0; x < W * z; x++) {
      const s = ((y / z | 0) * W + (x / z | 0)) * 3, d = (y * W * z + x) * 3;
      out[d] = b[s]; out[d + 1] = b[s + 1]; out[d + 2] = b[s + 2];
    }
  }
  png(path, W * z, H * z, out);
}

const live = canvases.filter((c) => c._ctx && c.width && c.height);
let written = 0;
for (const c of live) {
  if (ONLY && !ONLY.has(c.id)) continue;
  const id = String(c.id).padStart(2, '0');
  png(`${outDir}/tex-${id}-${c.width}x${c.height}.png`, c.width, c.height, c._ctx.buf);
  written++;
  if (NOTILE) continue;
  // cap the tiled/zoomed output so a 512px texture does not become 3072px
  const n = Math.max(1, Math.min(3, Math.floor(768 / Math.max(c.width, c.height))));
  if (n > 1) tiled(`${outDir}/tile-${id}.png`, c, n);
  const z = Math.max(1, Math.min(4, Math.floor(512 / Math.max(c.width, c.height))));
  if (z > 1) zoomed(`${outDir}/zoom-${id}.png`, c, z);
}

// ── cost report ──
// Build cost is dominated by pixels touched, not by op count: 30 full-canvas
// washes on a 512 cost more than 3000 one-pixel specks on a 128. Sort by that.
const totalOps = live.reduce((a, c) => a + c._ctx.ops, 0);
const totalPx = live.reduce((a, c) => a + c._ctx.px, 0);
const totalTexels = live.reduce((a, c) => a + c.width * c.height, 0);
const bySize = new Map();
for (const c of live) {
  const k = `${c.width}x${c.height}`;
  bySize.set(k, (bySize.get(k) || 0) + 1);
}
console.log(`wrote ${written} texture png(s) to ${outDir}/`);
console.log(`canvases ${live.length}  texels ${(totalTexels / 1e6).toFixed(2)}M  ` +
  `draw-ops ${totalOps.toLocaleString()}  pixel-writes ${(totalPx / 1e6).toFixed(1)}M`);
console.log('sizes: ' + [...bySize].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join('  '));
console.log('priciest canvases (pixel-writes):');
for (const c of [...live].sort((a, b) => b._ctx.px - a._ctx.px).slice(0, 12)) {
  console.log(`  #${String(c.id).padStart(3)} ${String(c.width) + 'x' + c.height} ` +
    `ops=${String(c._ctx.ops).padStart(6)} px=${(c._ctx.px / 1e3).toFixed(0).padStart(6)}k`);
}
if (GRID) {
  console.log(`grid audit (${GRID}px): polylines ${AUDIT.polylines} | ` +
    `off-grid ${AUDIT.offGrid.length} ${AUDIT.offGrid.slice(0, 4).join(' ')} | ` +
    `non-45/90 ${AUDIT.badAngle.length} ${AUDIT.badAngle.slice(0, 3).join(' ')}`);
  if (AUDIT.offGrid.length || AUDIT.badAngle.length) process.exitCode = 1;
}
