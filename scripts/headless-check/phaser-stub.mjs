/**
 * The Phaser `Graphics` stub and the scanline filler the 2D headless previews
 * share.
 *
 * Extracted for the same reason `mini-raster.ts` was, and `scene-census.mjs`
 * after it: there must be exactly ONE definition of "what a draw command is"
 * and ONE rasteriser. This repo has been bitten three times by a helper that
 * existed twice and drifted — `makeGroundFn` (probe vs production), the
 * road-class policy (the 2D renderer kept drawing what 3D had been fixed to
 * stop drawing: 1041 features, 591 correct), and nearly the scene census. Two
 * previews that disagree are worse than one preview, because they produce
 * confident wrong conclusions about art nobody has otherwise looked at.
 *
 * Consumers:
 *   - `phaser-probe.mjs`        — drives `plan/phaser-*-demo.html` through a
 *                                 stubbed Phaser and rasterises with a camera.
 *   - `phaser-style-probe.mjs`  — drives the SHIPPING `PhaserStyleStrategy`
 *                                 objects and rasterises into a labelled grid.
 *
 * Plain `.mjs`, no TypeScript and no `@/` aliases, because `phaser-probe.mjs`
 * runs under bare `node` (see the `probe:phaser` npm script) while
 * `phaser-style-probe.mjs` runs under `register.mjs`'s TS loader.
 *
 * ── It is NOT Phaser ──
 *
 * No WebGL batcher, no antialiasing, no premultiplied alpha, no text.
 * Strokes are quads: butt caps, no joins, no mitres, so a thick polyline shows
 * notches at its corners that Phaser would fill in. `strokeRect` /
 * `strokeRoundedRect` decompose into 4 quads; `strokePath` / `strokePoints`
 * into one quad per segment. `fillRoundedRect` is a 12-segment polygon, not a
 * true arc; `strokeCircle` / `strokeEllipse` are annular bands. Sub-paths do not
 * exist — `moveTo` after `closePath` extends the same polyline rather than
 * starting a new one.
 *
 * It answers "is the picture roughly right, in the right order, in the right
 * place", which is the question that actually bites (things drawn under the
 * terrain, coordinates off by a screen, a layer that never draws at all).
 *
 * ── Blend modes ──
 *
 * `Graphics.setBlendMode` is still a no-op on the STUB: a recorded command
 * carries no blend mode, because in the game the mode is a property of the
 * LAYER (`terrain-builder` sets `BlendModes.ADD` on the chunk's lights
 * Graphics, not on any one call). The raster instead takes the mode from its
 * caller — `raster.setBlend('add')` around the pass that stands in for that
 * layer, `'over'` again afterwards. Default is `'over'`, so a consumer that
 * never calls it is unaffected.
 *
 * `'add'` is `dst + src × a`, clamped at 255 per channel per command. That is
 * NOT what Phaser's `BlendModes.ADD` computes: Phaser adds in premultiplied
 * float in the GPU's blend unit and this clamps 8-bit integers after every
 * command, so a stack of overlapping glows saturates EARLIER here than on the
 * real thing. There is also no bloom and no post pipeline of any kind, so a
 * glow that only reads because of bloom in game will look weak here, and one
 * that clips to white here would have clipped in game too (the clamp is the
 * pessimistic direction). Read it for "does this mark survive on this surface
 * at all", never for exact brightness.
 *
 * ── What the two copies disagreed about, and how it was settled ──
 *
 * The old copies had drifted in six behaviours. Each is now decided ONCE, in
 * favour of what Phaser actually does:
 *
 *   1. `strokeEllipse` draws a band, not a solid fill (the demo probe filled
 *      the ellipse, which painted OVER the outline it was meant to be).
 *   2. `arc` appends to an open path; only outside a path is it a wedge.
 *   3. `fillRoundedRect` has real corners.
 *   4. `strokePoints` / `strokeTriangle` exist (the demo probe lacked them).
 *   5. `strokePath` draws the closing edge IFF `closePath()` was called for
 *      that path. The demo probe never closed; the style probe always did
 *      (see the ProbeGraphics constructor) and then kept the flag sticky.
 *   6. `destroy()` removes that Graphics' commands, like Phaser's does.
 *
 * 1, 2, 3, 4 and 6 leave the recorded draw-command COUNT alone; 5 does not, so
 * the demo counts moved when this was merged (hand-drawn 2603 → 2660, circuit
 * 3295 → 3296, plastic unchanged) and cuphead's style counts fell.
 *
 * ── Two counts ──
 *
 * `sink.cmds.length` is raster primitives AFTER the decomposition above; it is
 * what `phaser-probe.mjs` prints as "draw commands" and what
 * `phaser-style-probe.mjs` prints as `prims`. `sink.api` is the number of
 * geometry-producing `Graphics` method calls, closer to what Phaser's own
 * command buffer sees. `sink.state` counts `fillStyle`/`lineStyle`, `sink.path`
 * the path-building calls.
 */

// ── recorded draw list ───────────────────────────────────────────────────────

/** `0xRRGGBB` -> `[r, g, b]`. */
export const rgb = (c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

/** Phaser point lists come as `{x, y}` or `[x, y]`; normalise to `[x, y]`. */
export const xy = (pts) => pts.map((p) => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]));

/** Method names a caller used that this stub does not model, by name. */
export const unstubbed = new Map();

export class Sink {
  constructor() {
    this.cmds = [];
    this.api = 0;     // geometry-producing Graphics calls
    this.state = 0;   // fillStyle / lineStyle
    this.path = 0;    // beginPath / moveTo / lineTo / closePath / arc-into-path
  }
}

/**
 * The Phaser `Graphics` stub. Records; never rasterises. Every method returns
 * `this.self` (the proxy from `makeGraphics`, or the instance) so chained calls
 * work.
 *
 * Command shapes, all in the coordinates the caller drew in:
 *   `{ t:'poly', col, a, pts }`
 *   `{ t:'line', col, a, x1, y1, x2, y2, w }`
 *   `{ t:'circ', col, a, x, y, rx, ry }`
 *   `{ t:'ring', col, a, x, y, rx, ry, w }`
 * plus `g` (the Graphics), `depth`, `seq`, and `ga` (the Graphics' alpha at
 * push time — `phaser-probe` reads live `g.alpha` instead, since a demo may
 * tween it after the fact).
 */
export class ProbeGraphics {
  constructor(sink, scene) {
    this.sink = sink;
    this.scene = scene;
    this.self = this;
    // Every field anything reads is initialised here, deliberately, INCLUDING
    // the private ones. Under `makeGraphics`' Proxy an absent property returns
    // the unstubbed-call function, which is truthy and is NOT counted (the
    // counter only fires if that function is called), so the mistake is
    // completely silent. That is not hypothetical: the old style-probe copy
    // left `_closed` uninitialised, so `if (this._closed)` was always true and
    // every `strokePath` closed its outline whether the caller had asked for it
    // or not. `rot` would have been worse — a function into Math.cos NaNs the
    // whole transform.
    this.depth = 0;
    this.alpha = 1;
    this.visible = true;
    this.x = 0; this.y = 0; this.rot = 0;
    // Phaser takes (x, y) and y defaults to x. Collapsing them to one number is
    // what made the parallax layers slide off: the hand-drawn demo uses
    // setScrollFactor(0.08, 0) — 8% horizontally, pinned vertically.
    this.sfx = 1; this.sfy = 1;
    this._fill = 0xffffff; this._fa = 1;
    this._line = 0xffffff; this._la = 1; this._lw = 1;
    this._path = null;
    this._closed = false;
  }

  // ── state (not geometry) ──
  fillStyle(c, a) { this.sink.state++; this._fill = c; this._fa = a === undefined ? 1 : a; return this.self; }
  lineStyle(w, c, a) { this.sink.state++; this._lw = w; this._line = c; this._la = a === undefined ? 1 : a; return this.self; }
  setDepth(d) { this.depth = d; return this.self; }
  setAlpha(a) { this.alpha = a; return this.self; }
  setVisible(v) { this.visible = v; return this.self; }
  setPosition(x, y) { this.x = x; this.y = y === undefined ? x : y; return this.self; }
  setScrollFactor(x, y) { this.sfx = x === undefined ? 1 : x; this.sfy = y === undefined ? this.sfx : y; return this.self; }
  setBlendMode() { return this.self; }   // not modelled — composites source-over
  /** Phaser's `clear` wipes only THIS object's drawings. */
  clear() { this.sink.cmds = this.sink.cmds.filter((c) => c.g !== this.self); return this.self; }
  /** A destroyed Graphics stops drawing; its commands go with it. */
  destroy() { return this.clear(); }

  // ── path ──
  beginPath() { this.sink.path++; this._path = []; this._closed = false; return this.self; }
  moveTo(x, y) { this.sink.path++; (this._path ||= []).push([x, y]); return this.self; }
  lineTo(x, y) { this.sink.path++; (this._path ||= []).push([x, y]); return this.self; }
  closePath() { this.sink.path++; this._closed = true; return this.self; }
  fillPath() {
    this.sink.api++;
    if (this._path && this._path.length > 2) this._push({ t: 'poly', col: this._fill, a: this._fa, pts: this._path.slice() });
    return this.self;
  }
  strokePath() {
    this.sink.api++;
    const p = this._path;
    if (p) {
      for (let i = 1; i < p.length; i++) this._seg(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
      // `closePath()` closes the path, so stroking draws the closing edge too.
      // The flag is per-`beginPath()`. Both old copies got this wrong in
      // opposite directions: the demo probe never closed anything, and the
      // style probe closed EVERYTHING (see the constructor) and then kept the
      // flag sticky across later paths on the same Graphics.
      if (this._closed && p.length > 2) this._seg(p[p.length - 1][0], p[p.length - 1][1], p[0][0], p[0][1]);
    }
    return this.self;
  }
  /**
   * Phaser's `arc` APPENDS to the current path; only outside a path is it a
   * standalone shape. Collapsing both onto `slice` silently fills a wedge in
   * the middle of someone's outline — cuphead's balloon plane builds its body
   * exactly that way: beginPath → arc → fillPath → strokePath.
   *
   * With no open path Phaser would draw nothing at all; the wedge below
   * DELIBERATELY over-draws rather than vanishing.
   */
  arc(x, y, r, a0, a1, anticlockwise) {
    if (this._path) {
      this.sink.path++;
      for (const p of arcPts(x, y, r, a0, a1, anticlockwise, false)) this._path.push(p);
      return this.self;
    }
    return this.slice(x, y, r, a0, a1, anticlockwise);
  }

  // ── fills ──
  fillRect(x, y, w, h) {
    this.sink.api++;
    return this._push({ t: 'poly', col: this._fill, a: this._fa, pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] });
  }
  fillRoundedRect(x, y, w, h, r) {
    this.sink.api++;
    return this._push({ t: 'poly', col: this._fill, a: this._fa, pts: roundedRectPts(x, y, w, h, r) });
  }
  fillCircle(x, y, r) { this.sink.api++; return this._push({ t: 'circ', col: this._fill, a: this._fa, x, y, rx: r, ry: r }); }
  fillEllipse(x, y, w, h) { this.sink.api++; return this._push({ t: 'circ', col: this._fill, a: this._fa, x, y, rx: w / 2, ry: h / 2 }); }
  fillTriangle(x1, y1, x2, y2, x3, y3) {
    this.sink.api++;
    return this._push({ t: 'poly', col: this._fill, a: this._fa, pts: [[x1, y1], [x2, y2], [x3, y3]] });
  }
  fillPoints(pts) { this.sink.api++; return this._push({ t: 'poly', col: this._fill, a: this._fa, pts: xy(pts) }); }
  /** `Graphics.slice` — a pie wedge, approximated by a fan polygon. */
  slice(x, y, r, a0, a1, anticlockwise) {
    this.sink.api++;
    return this._push({ t: 'poly', col: this._fill, a: this._fa, pts: arcPts(x, y, r, a0, a1, anticlockwise, true) });
  }

  // ── strokes ──
  lineBetween(x1, y1, x2, y2) { this.sink.api++; return this._seg(x1, y1, x2, y2); }
  strokeRect(x, y, w, h) {
    this.sink.api++;
    this._seg(x, y, x + w, y); this._seg(x + w, y, x + w, y + h);
    this._seg(x + w, y + h, x, y + h); this._seg(x, y + h, x, y);
    return this.self;
  }
  /** Same 4 quads as strokeRect — corners squared off. One api call. */
  strokeRoundedRect(x, y, w, h) { return this.strokeRect(x, y, w, h); }
  strokeTriangle(x1, y1, x2, y2, x3, y3) {
    this.sink.api++;
    this._seg(x1, y1, x2, y2); this._seg(x2, y2, x3, y3); this._seg(x3, y3, x1, y1);
    return this.self;
  }
  strokeCircle(x, y, r) { this.sink.api++; return this._push({ t: 'ring', col: this._line, a: this._la, x, y, rx: r, ry: r, w: this._lw }); }
  strokeEllipse(x, y, w, h) { this.sink.api++; return this._push({ t: 'ring', col: this._line, a: this._la, x, y, rx: w / 2, ry: h / 2, w: this._lw }); }
  strokePoints(pts, closeShape) {
    this.sink.api++;
    const p = xy(pts);
    for (let i = 1; i < p.length; i++) this._seg(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
    if (closeShape && p.length > 2) this._seg(p[p.length - 1][0], p[p.length - 1][1], p[0][0], p[0][1]);
    return this.self;
  }

  _seg(x1, y1, x2, y2) {
    return this._push({ t: 'line', col: this._line, a: this._la, x1, y1, x2, y2, w: this._lw });
  }
  _push(o) {
    this.sink.cmds.push(Object.assign(
      { g: this.self, depth: this.depth, seq: this.sink.cmds.length, ga: this.alpha }, o,
    ));
    return this.self;
  }
}

/**
 * Graphics with an unstubbed-call counter: an unknown method is chainable and
 * COUNTED, never a silent no-op (that is how a missing shape turns into a
 * confident "the art is fine").
 */
export function makeGraphics(sink, scene) {
  const g = new ProbeGraphics(sink, scene);
  const proxy = new Proxy(g, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      return (...a) => { unstubbed.set(k, (unstubbed.get(k) ?? 0) + 1); void a; return proxy; };
    },
  });
  g.self = proxy;
  return proxy;
}

/**
 * A canvas 2D **context** stub that records into the same `Sink`.
 *
 * `generateCyclistFrame` and `drawCoinTexture` are the two style methods that do
 * not take a `Graphics` — they are baked into a texture, so they get a
 * `CanvasRenderingContext2D`. Until now nothing could look at them, which is why
 * the rider was the last thing in either 2D world nobody had put a probe on.
 *
 * It records into the SAME command shapes as `ProbeGraphics`, so a canvas method
 * and a Graphics method land in one grid and count the same way — see the
 * `cyclist` case in `phaser-style-probe.mjs`.
 *
 * What it models: `fillRect`, `fill()` of a path built from `moveTo` / `lineTo` /
 * `arc` / `ellipse` / `rect` / `closePath`, `stroke()` of the same, `fillStyle`
 * and `strokeStyle` as `#rrggbb` or `rgba(...)`, `lineWidth`, `globalAlpha`,
 * `save`/`restore` of the whole style block, and `translate`.
 *
 * What it does NOT model, and the list is short on purpose — anything longer
 * would be a second renderer:
 *  · rotate / scale / transform (no style uses them; they would need a matrix)
 *  · gradients and patterns (`createLinearGradient` returns a stub whose colour
 *    is its FIRST stop — enough to see where the fill lands, not what it fades
 *    to). `drawCoinTexture` uses none today.
 *  · `lineCap` / `lineJoin` — strokes are quads here, as everywhere in this file
 *  · `clip`, `globalCompositeOperation`, text
 * Everything unmodelled goes through the same `unstubbed` counter as Graphics,
 * so it is reported rather than silently dropped.
 *
 * `(dx, dy)` translate every coordinate, because a baked sprite is drawn in
 * FRAME coordinates (origin at the frame's top-left) and the probe's grid works
 * in cell coordinates.
 */
export function makeCanvasCtx(gfx, dx = 0, dy = 0) {
  const parseCol = (s) => {
    if (typeof s !== 'string') return { c: 0xffffff, a: 1 };
    const hex = /^#([0-9a-f]{6})$/i.exec(s);
    if (hex) return { c: parseInt(hex[1], 16), a: 1 };
    const short = /^#([0-9a-f]{3})$/i.exec(s);
    if (short) {
      const [r, g, b] = short[1].split('').map((h) => parseInt(h + h, 16));
      return { c: (r << 16) | (g << 8) | b, a: 1 };
    }
    const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
    if (rgba) {
      const [, r, g, b, a] = rgba;
      return { c: (Math.round(+r) << 16) | (Math.round(+g) << 8) | Math.round(+b), a: a === undefined ? 1 : +a };
    }
    return { c: 0xffffff, a: 1 };
  };

  const ctx = {
    fillStyle: '#ffffff',
    strokeStyle: '#ffffff',
    lineWidth: 1,
    globalAlpha: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    _path: [],
    _stack: [],
    _tx: dx,
    _ty: dy,
    save() { this._stack.push([this.fillStyle, this.strokeStyle, this.lineWidth, this.globalAlpha, this._tx, this._ty]); },
    restore() {
      const s = this._stack.pop();
      if (s) [this.fillStyle, this.strokeStyle, this.lineWidth, this.globalAlpha, this._tx, this._ty] = s;
    },
    translate(x, y) { this._tx += x; this._ty += y; },
    beginPath() { this._path = []; },
    closePath() { if (this._path.length) this._path.push(this._path[0].slice()); },
    moveTo(x, y) { this._path.push([x + this._tx, y + this._ty]); },
    lineTo(x, y) { this._path.push([x + this._tx, y + this._ty]); },
    rect(x, y, w, h) {
      this._path.push(
        [x + this._tx, y + this._ty], [x + w + this._tx, y + this._ty],
        [x + w + this._tx, y + h + this._ty], [x + this._tx, y + h + this._ty],
        [x + this._tx, y + this._ty],
      );
    },
    arc(x, y, r, a0, a1, acw) { this.ellipse(x, y, r, r, 0, a0, a1, acw); },
    ellipse(x, y, rx, ry, _rot, a0, a1, acw) {
      let sweep = a1 - a0;
      if (acw) { if (sweep > 0) sweep -= Math.PI * 2; } else if (sweep < 0) sweep += Math.PI * 2;
      const n = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 12)));
      for (let i = 0; i <= n; i++) {
        const a = a0 + (sweep * i) / n;
        this._path.push([x + Math.cos(a) * rx + this._tx, y + Math.sin(a) * ry + this._ty]);
      }
    },
    fill() {
      if (this._path.length < 3) return;
      const { c, a } = parseCol(this.fillStyle);
      gfx.fillStyle(c, a * this.globalAlpha);
      gfx.fillPoints(this._path.map(([x, y]) => ({ x, y })), true);
    },
    stroke() {
      if (this._path.length < 2) return;
      const { c, a } = parseCol(this.strokeStyle);
      gfx.lineStyle(this.lineWidth, c, a * this.globalAlpha);
      for (let i = 1; i < this._path.length; i++) {
        gfx.lineBetween(this._path[i - 1][0], this._path[i - 1][1], this._path[i][0], this._path[i][1]);
      }
    },
    fillRect(x, y, w, h) {
      const { c, a } = parseCol(this.fillStyle);
      gfx.fillStyle(c, a * this.globalAlpha);
      gfx.fillRect(x + this._tx, y + this._ty, w, h);
    },
    strokeRect(x, y, w, h) {
      const { c, a } = parseCol(this.strokeStyle);
      gfx.lineStyle(this.lineWidth, c, a * this.globalAlpha);
      gfx.strokeRect(x + this._tx, y + this._ty, w, h);
    },
    clearRect() { /* the frame starts empty here */ },
    createLinearGradient() {
      let first = '#ffffff';
      return { addColorStop(_t, col) { if (_t === 0) first = col; }, toString: () => first };
    },
  };

  return new Proxy(ctx, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      return (...a) => { unstubbed.set(`ctx.${k}`, (unstubbed.get(`ctx.${k}`) ?? 0) + 1); void a; };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

/** Points along an arc; `withCentre` prepends the centre to make a pie wedge. */
export function arcPts(x, y, r, a0, a1, anticlockwise, withCentre) {
  let sweep = a1 - a0;
  if (anticlockwise) { if (sweep > 0) sweep -= Math.PI * 2; } else if (sweep < 0) sweep += Math.PI * 2;
  const n = Math.max(3, Math.ceil(Math.abs(sweep) / 0.25));
  const pts = withCentre ? [[x, y]] : [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
  }
  return pts;
}

/** 12-segment approximation of a rounded rect (3 segments per corner). */
export function roundedRectPts(x, y, w, h, r) {
  const rad = Math.max(0, Math.min(typeof r === 'number' ? r : 4, Math.min(w, h) / 2));
  if (rad <= 0.5) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const pts = [];
  const corner = (cx, cy, a0) => {
    for (let i = 0; i <= 3; i++) {
      const a = a0 + (Math.PI / 2) * (i / 3);
      pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
    }
  };
  corner(x + w - rad, y + rad, -Math.PI / 2);
  corner(x + w - rad, y + h - rad, 0);
  corner(x + rad, y + h - rad, Math.PI / 2);
  corner(x + rad, y + rad, Math.PI);
  return pts;
}

// ── image + scanline filler ──────────────────────────────────────────────────

/**
 * An RGB byte buffer with the even-odd scanline filler both probes draw
 * through. Everything takes SCREEN coordinates: each probe applies its own
 * transform (a camera in `phaser-probe`, a row offset + cell clip in
 * `phaser-style-probe`) before calling in here.
 *
 * `clip`, where accepted, is `{x0, x1, y0, y1}` inclusive.
 *
 * `setBlend('add' | 'over')` switches compositing for everything drawn after
 * it — see the "Blend modes" note in this file's header for what `'add'` is and
 * is not. It is sticky, not scoped: a caller that turns it on turns it off.
 */
export function createRaster(width, height, background) {
  const buf = Buffer.alloc(width * height * 3);
  if (background) {
    for (let i = 0; i < width * height; i++) {
      buf[i * 3] = background[0]; buf[i * 3 + 1] = background[1]; buf[i * 3 + 2] = background[2];
    }
  }
  let additive = false;

  function plot(x, y, c, a, clip) {
    if (a <= 0) return;
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    if (clip && (x < clip.x0 || x > clip.x1 || y < clip.y0 || y > clip.y1)) return;
    const o = (y * width + x) * 3;
    const k = a > 1 ? 1 : a;
    if (additive) {
      // Clamp explicitly: a Buffer store is `value & 255`, so 260 would WRAP to
      // 4 and a saturated glow would come out as a black hole in the middle of
      // itself. That is the whole failure mode this branch has to avoid.
      const r = buf[o] + c[0] * k, g = buf[o + 1] + c[1] * k, b = buf[o + 2] + c[2] * k;
      buf[o] = r > 255 ? 255 : r;
      buf[o + 1] = g > 255 ? 255 : g;
      buf[o + 2] = b > 255 ? 255 : b;
      return;
    }
    buf[o] = buf[o] * (1 - k) + c[0] * k;
    buf[o + 1] = buf[o + 1] * (1 - k) + c[1] * k;
    buf[o + 2] = buf[o + 2] * (1 - k) + c[2] * k;
  }

  /** `'add'` → `dst + src×a` clamped; `'over'` → source-over alpha (default). */
  function setBlend(mode) {
    if (mode !== 'add' && mode !== 'over') throw new Error(`setBlend wants 'add'|'over', got "${mode}"`);
    additive = mode === 'add';
  }

  /** Even-odd scanline fill, sampling at pixel centres. */
  function fillPoly(pts, col, a, clip) {
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    for (const p of pts) {
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    }
    if (!Number.isFinite(minY)) return;
    if (maxX < 0 || minX >= width || maxY < 0 || minY >= height) return;
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(height - 1, Math.ceil(maxY));
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      xs.length = 0;
      const cy = y + 0.5;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const A = pts[j], B = pts[i];
        if ((A[1] > cy) !== (B[1] > cy)) xs.push(A[0] + ((cy - A[1]) / (B[1] - A[1])) * (B[0] - A[0]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const sx = Math.max(0, Math.ceil(xs[k])), ex = Math.min(width - 1, Math.floor(xs[k + 1]));
        for (let x = sx; x <= ex; x++) plot(x, y, col, a, clip);
      }
    }
  }

  /** A line as a quad: butt caps, no joins. */
  function strokeQuad(x1, y1, x2, y2, w, col, a, clip) {
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
    const hw = Math.max(0.5, w / 2);
    const nx = (-dy / L) * hw, ny = (dx / L) * hw;
    fillPoly([[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]], col, a, clip);
  }

  /** Solid ellipse; with `innerW` an annular band of that stroke width. */
  function fillDisc(x, y, rx, ry, col, a, clip, innerW) {
    const outer = innerW === undefined ? 0 : Math.max(1, innerW) / 2;
    const ox = rx + outer, oy = ry + outer;
    const x0 = Math.max(0, Math.floor(x - ox)), x1 = Math.min(width - 1, Math.ceil(x + ox));
    const y0 = Math.max(0, Math.floor(y - oy)), y1 = Math.min(height - 1, Math.ceil(y + oy));
    const irx = rx - outer, iry = ry - outer;
    for (let py = y0; py <= y1; py++) {
      for (let pxx = x0; pxx <= x1; pxx++) {
        const dx = pxx + 0.5 - x, dy = py + 0.5 - y;
        if ((dx / (ox || 1)) ** 2 + (dy / (oy || 1)) ** 2 > 1) continue;
        if (innerW !== undefined && irx > 0 && iry > 0 && (dx / irx) ** 2 + (dy / iry) ** 2 < 1) continue;
        plot(pxx, py, col, a, clip);
      }
    }
  }

  return { width, height, buf, plot, fillPoly, strokeQuad, fillDisc, setBlend };
}

/** `unstubbed` as a printable one-liner, or null when nothing was missed. */
export function unstubbedReport() {
  if (!unstubbed.size) return null;
  return [...unstubbed.entries()].map(([k, n]) => `${k}×${n}`).join('  ');
}
