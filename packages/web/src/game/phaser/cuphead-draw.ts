/**
 * Cuphead hand-drawn style drawing utilities.
 *
 * All functions are deterministic (seed-based) so chunks render
 * identically on load/unload cycles. No per-frame randomness.
 *
 * Techniques:
 * - Wobbly ink outlines (seed-based displacement)
 * - Watercolor fill (layered semi-transparent rects)
 * - Cross-hatching (diagonal parallel lines)
 * - Organic blob shapes (irregular circles)
 * - Film grain overlay (pre-rendered canvas texture)
 */

import type Phaser from 'phaser';

// ── Seeded random ──

/** Simple deterministic pseudo-random from a seed. Returns 0-1. */
export function seededRandom(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Get N deterministic random values from a seed. */
function seededRandomN(seed: number, count: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    result.push(seededRandom(seed + i * 73));
  }
  return result;
}

// ── Wobble offsets ──

export interface WobbleOffset {
  dx: number;
  dy: number;
}

/**
 * Generate deterministic wobble offsets for a set of points.
 * Used to make straight lines look hand-drawn.
 */
export function generateWobbleOffsets(
  pointCount: number,
  seed: number,
  amplitude = 1.5,
): WobbleOffset[] {
  const offsets: WobbleOffset[] = [];
  for (let i = 0; i < pointCount; i++) {
    const r1 = seededRandom(seed + i * 37);
    const r2 = seededRandom(seed + i * 53 + 100);
    offsets.push({
      dx: (r1 - 0.5) * 2 * amplitude,
      dy: (r2 - 0.5) * 2 * amplitude,
    });
  }
  return offsets;
}

// ── Ink line drawing (Phaser Graphics) ──

/**
 * Draw a wobbly ink line between two points.
 * Simulates hand-drawn strokes with slight curves.
 */
export function drawInkLine(
  gfx: Phaser.GameObjects.Graphics,
  x1: number, y1: number,
  x2: number, y2: number,
  seed: number,
  lineWidth = 3,
  color: number,
  alpha = 1,
): void {
  gfx.lineStyle(lineWidth, color, alpha);
  gfx.beginPath();
  gfx.moveTo(x1, y1);

  // Split into 3-4 segments with slight wobble
  const segments = 3 + Math.floor(seededRandom(seed) * 2);
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const mx = x1 + (x2 - x1) * t;
    const my = y1 + (y2 - y1) * t;
    const wobbleX = (seededRandom(seed + i * 17) - 0.5) * lineWidth * 0.8;
    const wobbleY = (seededRandom(seed + i * 31) - 0.5) * lineWidth * 0.8;
    gfx.lineTo(mx + wobbleX, my + wobbleY);
  }
  gfx.strokePath();
}

/**
 * Draw a wobbly ink rectangle outline.
 */
export function drawInkRect(
  gfx: Phaser.GameObjects.Graphics,
  x: number, y: number,
  w: number, h: number,
  seed: number,
  lineWidth = 3,
  color: number,
): void {
  // Draw 4 wobbly edges
  drawInkLine(gfx, x, y, x + w, y, seed, lineWidth, color);
  drawInkLine(gfx, x + w, y, x + w, y + h, seed + 100, lineWidth, color);
  drawInkLine(gfx, x + w, y + h, x, y + h, seed + 200, lineWidth, color);
  drawInkLine(gfx, x, y + h, x, y, seed + 300, lineWidth, color);
}

// ── Cross-hatching ──

/**
 * Draw diagonal cross-hatch lines inside a rectangle.
 * Creates the classic hand-drawn shading effect.
 */
export function drawCrossHatch(
  gfx: Phaser.GameObjects.Graphics,
  x: number, y: number,
  w: number, h: number,
  color: number,
  alpha = 0.15,
  spacing = 5,
): void {
  gfx.lineStyle(1, color, alpha);
  // Diagonal lines from top-left to bottom-right direction
  for (let offset = -h; offset < w; offset += spacing) {
    const x1 = Math.max(x, x + offset);
    const y1 = Math.max(y, y - offset);
    const x2 = Math.min(x + w, x + offset + h);
    const y2 = Math.min(y + h, y - offset + w);

    // Clip to rect bounds
    const cx1 = Math.max(x, Math.min(x + w, x1));
    const cy1 = Math.max(y, Math.min(y + h, y + (cx1 - x1)));
    const cx2 = Math.max(x, Math.min(x + w, x2));
    const cy2 = Math.max(y, Math.min(y + h, y + (cx2 - x)));

    if (cx1 !== cx2 || cy1 !== cy2) {
      gfx.lineBetween(
        x + offset, y,
        x + offset + h, y + h,
      );
    }
  }
}

/**
 * Simpler cross-hatch that clips properly.
 */
export function drawSimpleHatch(
  gfx: Phaser.GameObjects.Graphics,
  x: number, y: number,
  w: number, h: number,
  color: number,
  alpha = 0.12,
  spacing = 5,
): void {
  gfx.lineStyle(0.8, color, alpha);
  // 45-degree lines going ↘
  const totalSpan = w + h;
  for (let d = 0; d < totalSpan; d += spacing) {
    // Line from top edge or left edge to bottom edge or right edge
    const startX = d < w ? x + d : x + w;
    const startY = d < w ? y : y + (d - w);
    const endX = d < h ? x : x + (d - h);
    const endY = d < h ? y + d : y + h;
    if (startX >= x && endY <= y + h) {
      gfx.lineBetween(startX, startY, endX, endY);
    }
  }
}

// ── Watercolor fill ──

/**
 * Simulate a watercolor wash by layering semi-transparent fills
 * with slight size/position variations.
 */
export function drawWatercolorFill(
  gfx: Phaser.GameObjects.Graphics,
  x: number, y: number,
  w: number, h: number,
  color: number,
  seed: number,
  passes = 3,
): void {
  for (let i = 0; i < passes; i++) {
    const r = seededRandomN(seed + i * 71, 4);
    const ox = (r[0] - 0.5) * 3;
    const oy = (r[1] - 0.5) * 2;
    const sw = w + (r[2] - 0.5) * 4;
    const sh = h + (r[3] - 0.5) * 3;
    gfx.fillStyle(color, 0.25);
    gfx.fillRect(x + ox, y + oy, sw, sh);
  }
}

// ── Organic blob ──

/**
 * Draw an irregular circle (organic blob shape).
 * Used for tree canopies, clouds, moon.
 */
export function drawOrganicBlob(
  gfx: Phaser.GameObjects.Graphics,
  cx: number, cy: number,
  radius: number,
  seed: number,
  fillColor: number,
  strokeColor: number,
  strokeWidth = 2.5,
  fillAlpha = 1,
): void {
  const points = 10;
  const angleStep = (Math.PI * 2) / points;

  // Generate wobbly radius per point
  gfx.fillStyle(fillColor, fillAlpha);
  gfx.beginPath();
  for (let i = 0; i <= points; i++) {
    const idx = i % points;
    const angle = idx * angleStep;
    const wobble = 1 + (seededRandom(seed + idx * 23) - 0.5) * 0.3;
    const r = radius * wobble;
    const px = cx + Math.cos(angle) * r;
    const py = cy + Math.sin(angle) * r;
    if (i === 0) gfx.moveTo(px, py);
    else gfx.lineTo(px, py);
  }
  gfx.closePath();
  gfx.fillPath();

  // Ink outline
  if (strokeWidth > 0) {
    gfx.lineStyle(strokeWidth, strokeColor, 1);
    gfx.beginPath();
    for (let i = 0; i <= points; i++) {
      const idx = i % points;
      const angle = idx * angleStep;
      const wobble = 1 + (seededRandom(seed + idx * 23) - 0.5) * 0.3;
      const r = radius * wobble;
      const px = cx + Math.cos(angle) * r;
      const py = cy + Math.sin(angle) * r;
      if (i === 0) gfx.moveTo(px, py);
      else gfx.lineTo(px, py);
    }
    gfx.closePath();
    gfx.strokePath();
  }
}

// ── Wobbly terrain path ──

/**
 * Draw a filled terrain surface with wobbly ink outline.
 * The fill uses a solid color; the outline has seed-based displacement.
 */
export function drawWobblyTerrainPath(
  gfx: Phaser.GameObjects.Graphics,
  points: { x: number; y: number }[],
  wobbleOffsets: WobbleOffset[],
  fillColor: number,
  strokeColor: number,
  strokeWidth: number,
  bottomY: number,
): void {
  if (points.length === 0) return;

  // Build wobbled points
  const wobbly = points.map((pt, i) => ({
    x: pt.x + (wobbleOffsets[i]?.dx ?? 0),
    y: pt.y + (wobbleOffsets[i]?.dy ?? 0),
  }));

  // Fill
  gfx.fillStyle(fillColor, 1);
  gfx.beginPath();
  gfx.moveTo(wobbly[0].x, wobbly[0].y);
  for (let i = 1; i < wobbly.length; i++) {
    gfx.lineTo(wobbly[i].x, wobbly[i].y);
  }
  gfx.lineTo(wobbly[wobbly.length - 1].x, bottomY);
  gfx.lineTo(wobbly[0].x, bottomY);
  gfx.closePath();
  gfx.fillPath();

  // Ink outline (top surface only)
  gfx.lineStyle(strokeWidth, strokeColor, 1);
  gfx.beginPath();
  gfx.moveTo(wobbly[0].x, wobbly[0].y);
  for (let i = 1; i < wobbly.length; i++) {
    gfx.lineTo(wobbly[i].x, wobbly[i].y);
  }
  gfx.strokePath();
}

// ── Film grain ──

/**
 * Generate a pre-rendered film grain canvas texture.
 * Returns a canvas that can be added to Phaser as a texture.
 */
export function generateFilmGrainCanvas(
  w: number,
  h: number,
  density = 0.4,
  margin = 6,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  // Scatter noise dots
  const dotCount = Math.floor(w * h * density * 0.01);
  for (let i = 0; i < dotCount; i++) {
    const x = margin + Math.random() * (w - margin * 2);
    const y = margin + Math.random() * (h - margin * 2);
    const size = 0.5 + Math.random() * 1.5;
    const brightness = Math.random() > 0.5 ? 255 : 0;
    const alpha = 0.02 + Math.random() * 0.06;
    ctx.fillStyle = `rgba(${brightness},${brightness},${brightness},${alpha})`;
    ctx.fillRect(x, y, size, size);
  }

  return canvas;
}

// ── Canvas 2D ink line (for sprite generation) ──

/**
 * Draw a wobbly ink line on a Canvas 2D context (not Phaser Graphics).
 * Used for cyclist sprite generation.
 */
export function drawInkLineCtx(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
  seed: number,
  lineWidth = 3,
  color: string,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);

  const segments = 3;
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const mx = x1 + (x2 - x1) * t;
    const my = y1 + (y2 - y1) * t;
    const wx = (seededRandom(seed + i * 17) - 0.5) * lineWidth * 0.6;
    const wy = (seededRandom(seed + i * 31) - 0.5) * lineWidth * 0.6;
    ctx.lineTo(mx + wx, my + wy);
  }
  ctx.stroke();
}

/**
 * Draw an organic blob on a Canvas 2D context (not Phaser Graphics).
 * Used for cyclist head, tree canopy in sprites.
 */
export function drawOrganicBlobCtx(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  radius: number,
  seed: number,
  fillColor: string,
  strokeColor: string,
  strokeWidth = 2,
): void {
  const points = 8;
  const angleStep = (Math.PI * 2) / points;

  ctx.fillStyle = fillColor;
  ctx.beginPath();
  for (let i = 0; i <= points; i++) {
    const idx = i % points;
    const angle = idx * angleStep;
    const wobble = 1 + (seededRandom(seed + idx * 23) - 0.5) * 0.25;
    const r = radius * wobble;
    const px = cx + Math.cos(angle) * r;
    const py = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  if (strokeWidth > 0) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}
