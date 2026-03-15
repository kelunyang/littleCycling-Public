<template>
  <Transition name="chart-fade">
    <div v-if="configs.length > 0" class="hud-chart">
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
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import type { TimeSeriesSample } from '@/composables/useGameLoop';
import type { PinConfig, PinnableMetric } from '@/composables/useChartPin';

const props = defineProps<{
  samples: TimeSeriesSample[];
  configs: PinConfig[];
}>();

const WIDTH = 320;
const HEIGHT = 80;
const PADDING = { top: 6, right: 8, bottom: 18, left: 36 };
const MAX_VISIBLE_SECONDS = 120;

const canvasRef = ref<HTMLCanvasElement | null>(null);
let rafId: number | null = null;

function getValue(sample: TimeSeriesSample, key: PinnableMetric): number {
  return sample[key];
}

/* ── Sub-draw functions ── */

function drawBackground(ctx: CanvasRenderingContext2D) {
  const bgGrad = ctx.createLinearGradient(0, 0, WIDTH, 0);
  bgGrad.addColorStop(0, 'rgba(5, 10, 20, 0.82)');
  bgGrad.addColorStop(0.5, 'rgba(5, 8, 16, 0.75)');
  bgGrad.addColorStop(1, 'rgba(5, 10, 20, 0.82)');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // CRT horizontal scan lines
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.04)';
  ctx.lineWidth = 1;
  for (let y = PADDING.top; y <= HEIGHT - PADDING.bottom; y += 3) {
    ctx.beginPath();
    ctx.moveTo(PADDING.left, y);
    ctx.lineTo(WIDTH - PADDING.right, y);
    ctx.stroke();
  }

  // Glowing border frame
  ctx.save();
  ctx.shadowBlur = 6;
  ctx.shadowColor = 'rgba(0, 229, 255, 0.4)';
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.3)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, WIDTH - 1, HEIGHT - 1);
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
) {
  const { minVal, maxVal, ticks } = yRange;
  const range = maxVal - minVal;

  ctx.save();
  ctx.font = '8px Orbitron, monospace';
  ctx.fillStyle = cfg.color;
  ctx.globalAlpha = 0.6;
  ctx.textBaseline = 'middle';
  ctx.textAlign = side === 'left' ? 'right' : 'left';

  for (const tick of ticks) {
    const y = PADDING.top + plotH * (1 - (tick - minVal) / range);
    const x = side === 'left' ? PADDING.left - 3 : WIDTH - PADDING.right + 3;
    ctx.fillText(String(tick), x, y);

    // Grid line
    ctx.strokeStyle = cfg.color;
    ctx.globalAlpha = 0.08;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PADDING.left, y);
    ctx.lineTo(WIDTH - PADDING.right, y);
    ctx.stroke();
    ctx.globalAlpha = 0.6;
  }
  ctx.restore();
}

function drawXAxis(
  ctx: CanvasRenderingContext2D,
  firstT: number,
  lastT: number,
  plotW: number,
) {
  ctx.save();
  ctx.font = '8px Orbitron, monospace';
  ctx.fillStyle = 'rgba(0, 229, 255, 0.5)';
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
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.15)';
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
  fillGrad.addColorStop(0, cfg.color + '33');
  fillGrad.addColorStop(1, cfg.color + '08');
  ctx.fillStyle = fillGrad;
  ctx.fill();

  // Glow pass
  ctx.save();
  ctx.shadowBlur = 6;
  ctx.shadowColor = cfg.color;
  ctx.strokeStyle = cfg.color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
  ctx.restore();

  // Sharp line on top
  ctx.strokeStyle = cfg.color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
}

function drawScanCursor(ctx: CanvasRenderingContext2D, plotW: number) {
  const scanX = PADDING.left + plotW;
  ctx.save();
  ctx.shadowBlur = 8;
  ctx.shadowColor = 'rgba(0, 229, 255, 0.5)';
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.3)';
  ctx.lineWidth = 1;
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

  const dpr = window.devicePixelRatio || 1;
  canvas.width = WIDTH * dpr;
  canvas.height = HEIGHT * dpr;
  canvas.style.width = `${WIDTH}px`;
  canvas.style.height = `${HEIGHT}px`;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, WIDTH, HEIGHT);

  drawBackground(ctx);

  const samples = props.samples;
  if (samples.length < 2) return;

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
    drawYAxis(ctx, props.configs[0], yRanges[0], plotH, 'left');
  }
  if (yRanges.length >= 2) {
    drawYAxis(ctx, props.configs[1], yRanges[1], plotH, 'right');
  }

  // Draw X-axis
  drawXAxis(ctx, firstT, lastT, plotW);

  // Draw metric lines
  for (let i = 0; i < props.configs.length; i++) {
    drawMetricLine(ctx, props.configs[i], visible, firstT, lastT, plotW, plotH, yRanges[i]);
  }

  drawScanCursor(ctx, plotW);
}

watch(
  [() => props.samples.length, () => props.configs],
  () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(draw);
  },
  { deep: true },
);

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
}

.hud-chart canvas {
  display: block;
}

.hud-chart__legend {
  display: flex;
  gap: 10px;
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
  opacity: 0.7;
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

/* Transition */
.chart-fade-enter-active,
.chart-fade-leave-active {
  transition: opacity 0.3s ease;
}

.chart-fade-enter-from,
.chart-fade-leave-to {
  opacity: 0;
}
</style>
