/**
 * Phaser-side lens marks manager — procedural dirt/rain/scratch overlay
 * on the cycling glasses, ported from cycling-glasses-effect's LensMarksManager.
 *
 * Maintains a 512×512 Canvas registered as a Phaser CanvasTexture so the
 * GLSL pipeline can sample it via uMarksTexture.
 *
 * Marks spawn with a type, random position, and opacity, then fade over time.
 * Texture is refreshed at most 10 Hz to limit CPU + GPU upload cost.
 */

import Phaser from 'phaser';

export type MarkType = 'rain' | 'snow' | 'dust' | 'coin' | 'leaf';

interface Rect {
  x: number; y: number; w: number; h: number;
}

interface Mark {
  type: MarkType;
  x: number;
  y: number;
  opacity: number;
  lifetime: number;
  maxLifetime: number;
  size: number;
  angle: number;
  active: boolean;
  bbox: Rect;
}

const CANVAS_SIZE = 512;
const MAX_MARKS = 30;
const MIN_REDRAW_INTERVAL = 1 / 10;
const MARKS_TEXTURE_KEY = '__phaser_lens_marks__';

export class PhaserLensMarksManager {
  private scene: Phaser.Scene;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly canvasTexture: Phaser.Textures.CanvasTexture;
  private pool: Mark[];
  private dirtyRects: Rect[] = [];
  private timeSinceRedraw = 0;
  private dirty = false;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;

    // Reuse existing texture if hot-reloaded.
    if (scene.textures.exists(MARKS_TEXTURE_KEY)) {
      scene.textures.remove(MARKS_TEXTURE_KEY);
    }

    this.canvasTexture = scene.textures.createCanvas(MARKS_TEXTURE_KEY, CANVAS_SIZE, CANVAS_SIZE)!;
    this.canvas = this.canvasTexture.getCanvas();
    this.ctx = this.canvasTexture.getContext();

    this.pool = Array.from({ length: MAX_MARKS }, () => ({
      type: 'dust' as MarkType, x: 0, y: 0, opacity: 0,
      lifetime: 0, maxLifetime: 0, size: 0, angle: 0, active: false,
      bbox: { x: 0, y: 0, w: 0, h: 0 },
    }));
  }

  /** WebGL texture handle for binding into the glasses pipeline. */
  get glTexture(): WebGLTexture | Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper | null {
    const source = this.canvasTexture.source?.[0];
    return source ? (source.glTexture as any) ?? null : null;
  }

  addMark(type: MarkType): void {
    let slot = this.pool.find((m) => !m.active);

    if (!slot) {
      slot = this.pool.reduce((oldest, m) => (m.lifetime < oldest.lifetime ? m : oldest));
      this.dirtyRects.push({ ...slot.bbox });
    }

    const lifetime = 5 + Math.random() * 5;
    slot.type = type;
    slot.x = Math.random() * CANVAS_SIZE;
    slot.y = Math.random() * CANVAS_SIZE;
    slot.opacity = 1.0;
    slot.lifetime = lifetime;
    slot.maxLifetime = lifetime;
    slot.size = this.getSize(type);
    slot.angle = Math.random() * Math.PI * 2;
    slot.active = true;
    slot.bbox = this.computeBbox(slot);
    this.dirtyRects.push({ ...slot.bbox });
    this.dirty = true;
  }

  private getSize(type: MarkType): number {
    switch (type) {
      case 'rain': return 15 + Math.random() * 20;
      case 'snow': return 20 + Math.random() * 30;
      case 'dust': return 30 + Math.random() * 40;
      case 'coin': return 40 + Math.random() * 30;
      case 'leaf': return 25 + Math.random() * 20;
    }
  }

  update(dt: number): void {
    let hasActive = false;

    for (const m of this.pool) {
      if (!m.active) continue;
      hasActive = true;
      m.lifetime -= dt;
      if (m.lifetime <= 0) {
        m.active = false;
        this.dirtyRects.push({ ...m.bbox });
        this.dirty = true;
        continue;
      }
      const fadeStart = Math.min(2, m.maxLifetime * 0.3);
      if (m.lifetime < fadeStart) {
        m.opacity = m.lifetime / fadeStart;
        this.dirtyRects.push({ ...m.bbox });
        this.dirty = true;
      }
    }

    if (!hasActive && !this.dirty) return;

    this.timeSinceRedraw += dt;
    if (this.dirty && this.timeSinceRedraw >= MIN_REDRAW_INTERVAL) {
      this.redraw();
      this.timeSinceRedraw = 0;
      this.dirty = false;
    }
  }

  private redraw(): void {
    const ctx = this.ctx;

    if (this.dirtyRects.length === 0) {
      ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      for (const m of this.pool) {
        if (m.active) this.drawMark(ctx, m);
      }
      this.canvasTexture.refresh();
      return;
    }

    const merged = this.mergeDirtyRects(this.dirtyRects);
    this.dirtyRects.length = 0;

    for (const r of merged) {
      ctx.clearRect(r.x, r.y, r.w, r.h);
    }

    for (const m of this.pool) {
      if (!m.active) continue;
      if (merged.some((r) => this.rectsIntersect(r, m.bbox))) {
        this.drawMark(ctx, m);
      }
    }

    this.canvasTexture.refresh();
  }

  private drawMark(ctx: CanvasRenderingContext2D, m: Mark): void {
    ctx.save();
    ctx.globalAlpha = m.opacity;
    ctx.translate(m.x, m.y);
    ctx.rotate(m.angle);

    switch (m.type) {
      case 'rain': this.drawRainDrop(ctx, m.size); break;
      case 'snow': this.drawSnowSplat(ctx, m.size); break;
      case 'dust': this.drawDust(ctx, m.size); break;
      case 'coin': this.drawCoinScratch(ctx, m.size); break;
      case 'leaf': this.drawLeafScratch(ctx, m.size); break;
    }

    ctx.restore();
  }

  private computeBbox(m: Mark): Rect {
    const scale = m.type === 'dust' ? 1.5 : 1;
    const halfSize = m.size * scale;
    const pad = 4;
    return {
      x: m.x - halfSize - pad,
      y: m.y - halfSize - pad,
      w: halfSize * 2 + pad * 2,
      h: halfSize * 2 + pad * 2,
    };
  }

  private rectsIntersect(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
  }

  private mergeDirtyRects(rects: Rect[]): Rect[] {
    if (rects.length <= 1) return rects.slice();
    if (rects.length > 8) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const r of rects) {
        if (r.x < minX) minX = r.x;
        if (r.y < minY) minY = r.y;
        if (r.x + r.w > maxX) maxX = r.x + r.w;
        if (r.y + r.h > maxY) maxY = r.y + r.h;
      }
      return [{ x: minX, y: minY, w: maxX - minX, h: maxY - minY }];
    }
    const result: Rect[] = [];
    const used = new Array(rects.length).fill(false);
    for (let i = 0; i < rects.length; i++) {
      if (used[i]) continue;
      let r = { ...rects[i] };
      for (let j = i + 1; j < rects.length; j++) {
        if (used[j]) continue;
        if (this.rectsIntersect(r, rects[j])) {
          const minX = Math.min(r.x, rects[j].x);
          const minY = Math.min(r.y, rects[j].y);
          r = {
            x: minX, y: minY,
            w: Math.max(r.x + r.w, rects[j].x + rects[j].w) - minX,
            h: Math.max(r.y + r.h, rects[j].y + rects[j].h) - minY,
          };
          used[j] = true;
        }
      }
      result.push(r);
    }
    return result;
  }

  private drawRainDrop(ctx: CanvasRenderingContext2D, size: number): void {
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, size / 2);
    grad.addColorStop(0, 'rgba(180, 210, 255, 0.6)');
    grad.addColorStop(0.3, 'rgba(150, 190, 240, 0.4)');
    grad.addColorStop(1, 'rgba(120, 170, 220, 0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.beginPath();
    ctx.arc(-size * 0.1, -size * 0.1, size * 0.15, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawSnowSplat(ctx: CanvasRenderingContext2D, size: number): void {
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, size / 2);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.7)');
    grad.addColorStop(0.5, 'rgba(240, 245, 255, 0.3)');
    grad.addColorStop(1, 'rgba(220, 230, 250, 0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawDust(ctx: CanvasRenderingContext2D, size: number): void {
    ctx.scale(1.5, 1);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, size / 2);
    grad.addColorStop(0, 'rgba(160, 130, 90, 0.35)');
    grad.addColorStop(1, 'rgba(140, 110, 70, 0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawCoinScratch(ctx: CanvasRenderingContext2D, size: number): void {
    ctx.strokeStyle = 'rgba(255, 200, 50, 0.6)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-size / 2, 0);
    ctx.lineTo(size / 2, 0);
    ctx.stroke();

    if (Math.random() > 0.5) {
      ctx.beginPath();
      ctx.moveTo(-size * 0.3, size * 0.2);
      ctx.lineTo(size * 0.3, -size * 0.15);
      ctx.stroke();
    }
  }

  private drawLeafScratch(ctx: CanvasRenderingContext2D, size: number): void {
    ctx.strokeStyle = 'rgba(80, 180, 60, 0.5)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, size * 0.3, size / 2, -Math.PI * 0.8, -Math.PI * 0.2);
    ctx.stroke();
  }

  dispose(): void {
    for (const m of this.pool) m.active = false;
    if (this.scene.textures.exists(MARKS_TEXTURE_KEY)) {
      this.scene.textures.remove(MARKS_TEXTURE_KEY);
    }
  }
}
