<template>
  <div v-if="configs.length > 0" class="hud-chart" :class="`hud-chart--${theme}`">
    <div class="hud-chart__legend">
      <span
        v-for="cfg in configs"
        :key="cfg.key"
        class="hud-chart__legend-item"
      >
        <span class="hud-chart__legend-swatch" :style="{ background: cfg.color }" />
        {{ cfg.label }} ({{ cfg.unit }})
      </span>
    </div>
    <canvas ref="canvasRef" :width="WIDTH" :height="HEIGHT" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { TimeSeriesSample } from '@/composables/useGameLoop';
import type { PinConfig, PinnableMetric } from '@/composables/useChartPin';

/** Chart skin. 'neon' = cyberpunk glow (3D-ish renderers); 'plastic' /
 *  'cuphead' = flat, hand-drawn ink for the Phaser 2D world. */
type ChartTheme = 'neon' | 'plastic' | 'cuphead';

const props = withDefaults(
  defineProps<{
    samples: TimeSeriesSample[];
    configs: PinConfig[];
    theme?: ChartTheme;
  }>(),
  { theme: 'neon' },
);

// Sized to sit above the minimap in the bottom-right column (same 210px block).
const WIDTH = 210;
const HEIGHT = 84;
const PADDING = { top: 6, right: 10, bottom: 18, left: 34 };
const MAX_VISIBLE_SECONDS = 120;

const canvasRef = ref<HTMLCanvasElement | null>(null);
let rafId: number | null = null;

/* ── Per-theme palette ──
 * Canvas colours can't read CSS var(), so the hand-drawn themes below mirror the
 * palette in src/styles/themes.scss by value (plastic ink #1a1140; cuphead ink
 * #2a2420) — keep the two in sync. */

interface ChartPalette {
  neon: boolean;
  /** Solid background fill, or null to use the cyberpunk gradient. */
  fill: string | null;
  /** Horizontal texture line colour (scanlines / paper grain), or null. */
  texture: string | null;
  border: string;
  /** Glow colour for the border/lines, or null for a flat ink look. */
  glow: string | null;
  font: string;
  xText: string;
  grid: string;
  /** Dark underlay stroke drawn beneath the coloured line (ink outline). */
  inkUnder: string | null;
  cursor: string | null;
}

function getPalette(theme: ChartTheme): ChartPalette {
  switch (theme) {
    case 'plastic':
      return {
        neon: false,
        fill: 'rgba(255, 247, 251, 0.92)',
        texture: null,
        border: '#1a1140',
        glow: null,
        font: 'Fredoka, "Baloo 2", system-ui, sans-serif',
        xText: 'rgba(26, 17, 64, 0.7)',
        grid: 'rgba(26, 17, 64, 0.12)',
        inkUnder: '#1a1140',
        cursor: 'rgba(26, 17, 64, 0.25)',
      };
    case 'cuphead':
      return {
        neon: false,
        fill: 'rgba(232, 220, 192, 0.94)',
        texture: 'rgba(42, 36, 32, 0.05)',
        border: '#2a2420',
        glow: null,
        font: '"Cabin Sketch", "Patrick Hand", cursive',
        xText: 'rgba(42, 36, 32, 0.72)',
        grid: 'rgba(42, 36, 32, 0.14)',
        inkUnder: '#2a2420',
        cursor: 'rgba(42, 36, 32, 0.3)',
      };
    default:
      return {
        neon: true,
        fill: null,
        texture: 'rgba(0, 229, 255, 0.04)',
        border: 'rgba(0, 229, 255, 0.3)',
        glow: 'rgba(0, 229, 255, 0.4)',
        font: 'Orbitron, monospace',
        xText: 'rgba(0, 229, 255, 0.5)',
        grid: 'rgba(0, 229, 255, 0.15)',
        inkUnder: null,
        cursor: 'rgba(0, 229, 255, 0.3)',
      };
  }
}

function getValue(sample: TimeSeriesSample, key: PinnableMetric): number {
  return sample[key];
}

/* ── Sub-draw functions ── */

function drawBackground(ctx: CanvasRenderingContext2D, pal: ChartPalette) {
  if (pal.fill === null) {
    const bgGrad = ctx.createLinearGradient(0, 0, WIDTH, 0);
    bgGrad.addColorStop(0, 'rgba(5, 10, 20, 0.82)');
    bgGrad.addColorStop(0.5, 'rgba(5, 8, 16, 0.75)');
    bgGrad.addColorStop(1, 'rgba(5, 10, 20, 0.82)');
    ctx.fillStyle = bgGrad;
  } else {
    ctx.fillStyle = pal.fill;
  }
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Horizontal texture (CRT scanlines / paper grain)
  if (pal.texture) {
    ctx.strokeStyle = pal.texture;
    ctx.lineWidth = 1;
    for (let y = PADDING.top; y <= HEIGHT - PADDING.bottom; y += 3) {
      ctx.beginPath();
      ctx.moveTo(PADDING.left, y);
      ctx.lineTo(WIDTH - PADDING.right, y);
      ctx.stroke();
    }
  }

  // Border frame — glowing (neon) or offset ink sticker (hand-drawn)
  ctx.save();
  if (pal.glow) {
    ctx.shadowBlur = 6;
    ctx.shadowColor = pal.glow;
    ctx.strokeStyle = pal.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, WIDTH - 1, HEIGHT - 1);
  } else {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
    ctx.strokeStyle = pal.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, WIDTH - 3, HEIGHT - 3);
  }
  ctx.restore();
}

/** Compute nice Y-axis range & ticks for a metric within visible samples */
function computeYRange(cfg: PinConfig, visible: TimeSeriesSample[]) {
  let minVal = Infinity;
  let maxVal = -Infinity;
  for (const s of visible) {
    const v = getValue(s, cfg.key);
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }
  if (maxVal === minVal) {
    maxVal += 10;
    minVal = Math.max(0, minVal - 10);
  }
  const range = maxVal - minVal;
  minVal = Math.max(0, minVal - range * 0.1);
  maxVal = maxVal + range * 0.1;

  // Generate 3 ticks (bottom, mid, top)
  const ticks = [
    Math.round(minVal),
    Math.round((minVal + maxVal) / 2),
    Math.round(maxVal),
  ];
  return { minVal, maxVal, ticks };
}

function drawYAxis(
  ctx: CanvasRenderingContext2D,
  cfg: PinConfig,
  yRange: { minVal: number; maxVal: number; ticks: number[] },
  plotH: number,
  side: 'left' | 'right',
  pal: ChartPalette,
) {
  const { minVal, maxVal, ticks } = yRange;
  const range = maxVal - minVal;

  ctx.save();
  ctx.font = `8px ${pal.font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = side === 'left' ? 'right' : 'left';

  for (const tick of ticks) {
    const y = PADDING.top + plotH * (1 - (tick - minVal) / range);
    const x = side === 'left' ? PADDING.left - 3 : WIDTH - PADDING.right + 3;

    ctx.fillStyle = cfg.color;
    ctx.globalAlpha = pal.neon ? 0.6 : 0.9;
    ctx.fillText(String(tick), x, y);

    // Grid line
    ctx.strokeStyle = pal.neon ? cfg.color : pal.grid;
    ctx.globalAlpha = pal.neon ? 0.08 : 1;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PADDING.left, y);
    ctx.lineTo(WIDTH - PADDING.right, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawXAxis(
  ctx: CanvasRenderingContext2D,
  firstT: number,
  lastT: number,
  plotW: number,
  pal: ChartPalette,
) {
  ctx.save();
  ctx.font = `8px ${pal.font}`;
  ctx.fillStyle = pal.xText;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';

  const totalSec = lastT - firstT;
  // Choose tick interval: 30s or 60s depending on range
  const interval = totalSec > 90 ? 60 : 30;
  const baseY = HEIGHT - PADDING.bottom + 3;

  for (let t = Math.ceil(firstT / interval) * interval; t <= lastT; t += interval) {
    const x = PADDING.left + ((t - firstT) / totalSec) * plotW;
    const min = Math.floor(t / 60);
    const sec = t % 60;
    const label = `${min}:${String(sec).padStart(2, '0')}`;
    ctx.fillText(label, x, baseY);

    // Tick mark
    ctx.strokeStyle = pal.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, HEIGHT - PADDING.bottom);
    ctx.lineTo(x, HEIGHT - PADDING.bottom + 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawMetricLine(
  ctx: CanvasRenderingContext2D,
  cfg: PinConfig,
  visible: TimeSeriesSample[],
  firstT: number,
  lastT: number,
  plotW: number,
  plotH: number,
  yRange: { minVal: number; maxVal: number },
  pal: ChartPalette,
) {
  const { minVal, maxVal } = yRange;
  const range = maxVal - minVal;

  const points: { x: number; y: number }[] = [];
  for (const s of visible) {
    const x = PADDING.left + ((s.t - firstT) / (lastT - firstT)) * plotW;
    const v = getValue(s, cfg.key);
    const y = PADDING.top + plotH * (1 - (v - minVal) / range);
    points.push({ x, y });
  }
  if (points.length < 2) return;

  const tracePath = () => {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
  };

  // Gradient fill under line
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.lineTo(points[points.length - 1].x, HEIGHT - PADDING.bottom);
  ctx.lineTo(points[0].x, HEIGHT - PADDING.bottom);
  ctx.closePath();

  const fillGrad = ctx.createLinearGradient(0, PADDING.top, 0, HEIGHT - PADDING.bottom);
  fillGrad.addColorStop(0, cfg.color + (pal.neon ? '33' : '3a'));
  fillGrad.addColorStop(1, cfg.color + (pal.neon ? '08' : '0f'));
  ctx.fillStyle = fillGrad;
  ctx.fill();

  // Neon: soft glow pass beneath the sharp line.
  if (pal.glow) {
    ctx.save();
    ctx.shadowBlur = 6;
    ctx.shadowColor = cfg.color;
    ctx.strokeStyle = cfg.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    tracePath();
    ctx.stroke();
    ctx.restore();
  }

  // Hand-drawn: dark ink underlay so the coloured trace reads as an inked line.
  if (pal.inkUnder) {
    ctx.strokeStyle = pal.inkUnder;
    ctx.lineWidth = 3.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    tracePath();
    ctx.stroke();
  }

  // Coloured trace on top
  ctx.strokeStyle = cfg.color;
  ctx.lineWidth = pal.neon ? 1.5 : 2.2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  tracePath();
  ctx.stroke();
}

function drawScanCursor(ctx: CanvasRenderingContext2D, plotW: number, pal: ChartPalette) {
  if (!pal.cursor) return;
  const scanX = PADDING.left + plotW;
  ctx.save();
  if (pal.glow) {
    ctx.shadowBlur = 8;
    ctx.shadowColor = 'rgba(0, 229, 255, 0.5)';
    ctx.strokeStyle = pal.cursor;
    ctx.lineWidth = 1;
  } else {
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = pal.cursor;
    ctx.lineWidth = 1;
  }
  ctx.beginPath();
  ctx.moveTo(scanX, PADDING.top);
  ctx.lineTo(scanX, HEIGHT - PADDING.bottom);
  ctx.stroke();
  ctx.restore();
}

/* ── Main draw ── */

function draw() {
  const canvas = canvasRef.value;
  if (!canvas || props.configs.length === 0) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const pal = getPalette(props.theme);

  const dpr = window.devicePixelRatio || 1;
  canvas.width = WIDTH * dpr;
  canvas.height = HEIGHT * dpr;
  canvas.style.width = `${WIDTH}px`;
  canvas.style.height = `${HEIGHT}px`;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, WIDTH, HEIGHT);

  drawBackground(ctx, pal);

  const samples = props.samples;
  if (samples.length < 2) {
    // A line needs ≥2 time-samples (~1 per game-second). Until then show a
    // gentle placeholder so the pinned chart doesn't look broken.
    ctx.save();
    ctx.font = `9px ${pal.font}`;
    ctx.fillStyle = pal.neon ? 'rgba(0, 229, 255, 0.7)' : pal.border;
    ctx.globalAlpha = pal.neon ? 1 : 0.7;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('WAITING FOR DATA…', WIDTH / 2, HEIGHT / 2);
    ctx.restore();
    return;
  }

  const plotW = WIDTH - PADDING.left - PADDING.right;
  const plotH = HEIGHT - PADDING.top - PADDING.bottom;

  const lastT = samples[samples.length - 1].t;
  const firstT = Math.max(0, lastT - MAX_VISIBLE_SECONDS);
  const visible = samples.filter((s) => s.t >= firstT);
  if (visible.length < 2) return;

  // Compute Y ranges per config (for axis ticks)
  const yRanges = props.configs.map((cfg) => computeYRange(cfg, visible));

  // Draw Y-axis ticks (first config on left, second on right)
  if (yRanges.length >= 1) {
    drawYAxis(ctx, props.configs[0], yRanges[0], plotH, 'left', pal);
  }
  if (yRanges.length >= 2) {
    drawYAxis(ctx, props.configs[1], yRanges[1], plotH, 'right', pal);
  }

  // Draw X-axis
  drawXAxis(ctx, firstT, lastT, plotW, pal);

  // Draw metric lines
  for (let i = 0; i < props.configs.length; i++) {
    drawMetricLine(ctx, props.configs[i], visible, firstT, lastT, plotW, plotH, yRanges[i], pal);
  }

  drawScanCursor(ctx, plotW, pal);
}

// Per-frame redraw loop. Reading props.samples fresh every frame sidesteps any
// watch/reactivity subtlety: if the series is genuinely growing, the chart sees
// it. draw() self-gates (returns early when nothing is pinned or the canvas
// isn't mounted), so this is cheap while idle.
function loop() {
  draw();
  rafId = requestAnimationFrame(loop);
}

onMounted(() => {
  rafId = requestAnimationFrame(loop);
});

onUnmounted(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
});
</script>

<style scoped>
.hud-chart {
  pointer-events: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-end;
}

.hud-chart canvas {
  display: block;
}

.hud-chart__legend {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 2px;
}

.hud-chart__legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-display);
  font-size: 9px;
  font-weight: 600;
  color: var(--hud-text);
  opacity: 0.75;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.hud-chart__legend-swatch {
  display: inline-block;
  width: 8px;
  height: 3px;
  border-radius: 1px;
  box-shadow: 0 0 4px currentColor;
}

/* Hand-drawn skins: flat ink swatch, no neon glow, stronger label ink. */
.hud-chart--plastic .hud-chart__legend-swatch,
.hud-chart--cuphead .hud-chart__legend-swatch {
  box-shadow: none;
  border: 1px solid rgba(0, 0, 0, 0.55);
  height: 4px;
}

.hud-chart--plastic .hud-chart__legend-item,
.hud-chart--cuphead .hud-chart__legend-item {
  color: var(--hud-text-bright);
  opacity: 0.95;
  text-transform: none;
  text-shadow:
    -1px -1px 0 rgba(255, 255, 255, 0.5),
    1px 1px 0 rgba(0, 0, 0, 0.3);
}
</style>
