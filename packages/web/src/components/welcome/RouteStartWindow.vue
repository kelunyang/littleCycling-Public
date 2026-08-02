<template>
  <div class="start-window">
    <div class="start-window__labels">
      <span class="start-window__label">
        <font-awesome-icon icon="flag" />
        Start at {{ (modelValue / 1000).toFixed(1) }} km
      </span>
      <span class="start-window__label start-window__label--dim">
        <font-awesome-icon icon="clock" />
        ~{{ windowMinutes }} min ≈ {{ (windowM / 1000).toFixed(1) }} km
        <template v-if="!draggable">(whole route)</template>
      </span>
    </div>
    <div ref="containerRef" class="start-window__chart" :class="{ 'start-window__chart--locked': !draggable }">
      <canvas
        ref="canvasRef"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import type { RoutePoint } from '@littlecycling/shared';
import { buildCumulativeDistances } from '@/game/route-geometry';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * Full-route elevation strip with a draggable "start window": the highlighted
 * span is roughly how far the target ride time gets you (GPX pace, else
 * 20 km/h), and its left edge is where the ride will begin
 * (gameStore.startOffsetM → server sim startOffsetM).
 */

const props = defineProps<{
  routePoints: RoutePoint[];
  /** Target ride time (config.training.defaultDuration) — sizes the window. */
  targetDurationMs: number;
}>();

const modelValue = defineModel<number>({ default: 0 });

const settingsStore = useSettingsStore();
const worldStyle = computed(() => settingsStore.config.map.worldStyle ?? 'plastic');

interface WindowPalette {
  bg: string;
  line: string;
  fill: string;
  border: string;
  dim: string;
  windowEdge: string;
  windowFill: string;
  font: string;
  text: string;
}

// Canvas colours can't read CSS var() directly — mirrors themes.scss by value,
// same convention as WorkoutElevationPreview (keep in sync when re-theming).
const PALETTES: Record<'plastic' | 'cuphead' | 'circuit' | 'default', WindowPalette> = {
  circuit: {
    // JS mirror of $circuit in themes.scss — same convention as above.
    bg: 'rgba(13, 79, 51, 0.94)',
    line: 'rgba(201, 162, 39, 0.95)',
    fill: 'rgba(201, 162, 39, 0.16)',
    border: '#071a14',
    dim: 'rgba(7, 26, 20, 0.5)',
    windowEdge: 'rgba(35, 240, 255, 0.95)',
    windowFill: 'rgba(35, 240, 255, 0.08)',
    font: '10px "Courier New", ui-monospace, monospace',
    text: '#e4ece2',
  },
  plastic: {
    bg: 'rgba(255, 247, 251, 0.94)',
    line: 'rgba(255, 59, 141, 0.95)',
    fill: 'rgba(255, 59, 141, 0.18)',
    border: '#1a1140',
    dim: 'rgba(26, 17, 64, 0.28)',
    windowEdge: 'rgba(255, 234, 0, 1)',
    windowFill: 'rgba(255, 234, 0, 0.10)',
    font: '10px Fredoka, sans-serif',
    text: '#1a1140',
  },
  cuphead: {
    bg: 'rgba(232, 220, 192, 0.95)',
    line: '#a0523c',
    fill: 'rgba(196, 160, 53, 0.30)',
    border: '#2a2420',
    dim: 'rgba(42, 36, 32, 0.30)',
    windowEdge: '#a0523c',
    windowFill: 'rgba(196, 160, 53, 0.12)',
    font: '11px "Cabin Sketch", cursive',
    text: '#2a2420',
  },
  default: {
    bg: 'rgba(5, 10, 20, 0.82)',
    line: 'rgba(0, 229, 255, 0.9)',
    fill: 'rgba(0, 229, 255, 0.10)',
    border: 'rgba(0, 229, 255, 0.3)',
    dim: 'rgba(0, 0, 0, 0.55)',
    windowEdge: 'rgba(0, 229, 255, 0.95)',
    windowFill: 'rgba(0, 229, 255, 0.06)',
    font: '10px Orbitron, monospace',
    text: 'rgba(255, 255, 255, 0.75)',
  },
};

const palette = computed<WindowPalette>(() => PALETTES[worldStyle.value] ?? PALETTES.default);

const containerRef = ref<HTMLElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

const CANVAS_H = 72;
const PAD = { top: 6, right: 8, bottom: 14, left: 8 };

const routeData = computed(() => {
  const pts = props.routePoints;
  if (pts.length < 2) return null;
  const cumDists = buildCumulativeDistances(pts);
  const totalDist = cumDists[cumDists.length - 1];
  if (totalDist <= 0) return null;

  let minEle = Infinity;
  let maxEle = -Infinity;
  for (const p of pts) {
    if (p.ele < minEle) minEle = p.ele;
    if (p.ele > maxEle) maxEle = p.ele;
  }
  if (maxEle - minEle < 5) maxEle = minEle + 5;

  // Pace: GPX timestamps when present, else 20 km/h — same fallback the
  // elevation preview uses for its duration estimate.
  const t0 = pts[0].tsEpoch;
  const t1 = pts[pts.length - 1].tsEpoch;
  const gpxMs = t0 != null && t1 != null ? t1 - t0 : 0;
  const speedMps = gpxMs > 0 ? totalDist / (gpxMs / 1000) : 20 / 3.6;

  return { cumDists, totalDist, minEle, maxEle, speedMps };
});

/** Window length in metres — target ride time at the route's pace. */
const windowM = computed(() => {
  const data = routeData.value;
  if (!data) return 0;
  return Math.min(data.totalDist, data.speedMps * (props.targetDurationMs / 1000));
});

const windowMinutes = computed(() => Math.round(props.targetDurationMs / 60000));

const maxStartM = computed(() => {
  const data = routeData.value;
  if (!data) return 0;
  return Math.max(0, data.totalDist - windowM.value);
});

/** False when the window spans the whole route — nothing to adjust. */
const draggable = computed(() => maxStartM.value > 1);

function clampStart(m: number): number {
  return Math.min(maxStartM.value, Math.max(0, m));
}

// ── Drawing ──

let lastCanvasW = -1;
let lastCanvasDpr = -1;

function draw(): void {
  const canvas = canvasRef.value;
  const container = containerRef.value;
  const data = routeData.value;
  if (!canvas || !container || !data) return;

  const cssW = container.clientWidth;
  if (cssW <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  if (cssW !== lastCanvasW || dpr !== lastCanvasDpr) {
    canvas.width = cssW * dpr;
    canvas.height = CANVAS_H * dpr;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${CANVAS_H}px`;
    lastCanvasW = cssW;
    lastCanvasDpr = dpr;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const pal = palette.value;
  const plotW = cssW - PAD.left - PAD.right;
  const plotH = CANVAS_H - PAD.top - PAD.bottom;
  const xOf = (m: number): number => PAD.left + (m / data.totalDist) * plotW;
  const yOf = (ele: number): number =>
    PAD.top + plotH - ((ele - data.minEle) / (data.maxEle - data.minEle)) * plotH;

  ctx.clearRect(0, 0, cssW, CANVAS_H);
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, cssW, CANVAS_H);

  // Elevation profile (downsample to ~2 points per px)
  const pts = props.routePoints;
  const step = Math.max(1, Math.floor(pts.length / (plotW * 2)));
  const tracePath = (): void => {
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(pts[0].ele));
    for (let i = step; i < pts.length; i += step) {
      ctx.lineTo(xOf(data.cumDists[i]), yOf(pts[i].ele));
    }
    ctx.lineTo(xOf(data.totalDist), yOf(pts[pts.length - 1].ele));
  };
  tracePath();
  ctx.lineTo(xOf(data.totalDist), PAD.top + plotH);
  ctx.lineTo(xOf(0), PAD.top + plotH);
  ctx.closePath();
  ctx.fillStyle = pal.fill;
  ctx.fill();
  tracePath();
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Start window: dim everything OUTSIDE it, edge lines on it.
  const x0 = xOf(clampStart(modelValue.value));
  const x1 = xOf(clampStart(modelValue.value) + windowM.value);
  ctx.fillStyle = pal.dim;
  ctx.fillRect(PAD.left, PAD.top, Math.max(0, x0 - PAD.left), plotH);
  ctx.fillRect(x1, PAD.top, Math.max(0, PAD.left + plotW - x1), plotH);
  ctx.fillStyle = pal.windowFill;
  ctx.fillRect(x0, PAD.top, x1 - x0, plotH);
  ctx.strokeStyle = pal.windowEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(x0, PAD.top, x1 - x0, plotH);

  // Distance ticks: 0 / mid / end
  ctx.fillStyle = pal.text;
  ctx.font = pal.font;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('0', PAD.left, PAD.top + plotH + 2);
  ctx.textAlign = 'center';
  ctx.fillText(`${(data.totalDist / 2000).toFixed(1)}k`, PAD.left + plotW / 2, PAD.top + plotH + 2);
  ctx.textAlign = 'right';
  ctx.fillText(`${(data.totalDist / 1000).toFixed(1)}km`, PAD.left + plotW, PAD.top + plotH + 2);

  // Border
  ctx.strokeStyle = pal.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, cssW - 1, CANVAS_H - 1);
}

// ── Dragging ──

let dragging = false;
/** Metres between the pointer and the window's left edge at grab time. */
let grabOffsetM = 0;

function eventDistM(ev: PointerEvent): number {
  const canvas = canvasRef.value;
  const data = routeData.value;
  if (!canvas || !data) return 0;
  const rect = canvas.getBoundingClientRect();
  const frac = (ev.clientX - rect.left - PAD.left) / Math.max(1, rect.width - PAD.left - PAD.right);
  return Math.min(1, Math.max(0, frac)) * data.totalDist;
}

function onPointerDown(ev: PointerEvent): void {
  if (!draggable.value) return;
  const m = eventDistM(ev);
  const start = clampStart(modelValue.value);
  if (m >= start && m <= start + windowM.value) {
    grabOffsetM = m - start; // grab inside → keep the relative grip
  } else {
    grabOffsetM = windowM.value / 2; // click outside → centre the window there
    modelValue.value = clampStart(m - grabOffsetM);
  }
  dragging = true;
  (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
}

function onPointerMove(ev: PointerEvent): void {
  if (!dragging) return;
  modelValue.value = clampStart(eventDistM(ev) - grabOffsetM);
}

function onPointerUp(ev: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  (ev.target as HTMLElement).releasePointerCapture(ev.pointerId);
}

// ── Lifecycle ──

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  draw();
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(() => draw());
    resizeObserver.observe(containerRef.value);
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

watch([() => props.routePoints, () => props.targetDurationMs, modelValue, palette], () => {
  // A route change can leave the stored offset past the new route's end.
  const clamped = clampStart(modelValue.value);
  if (clamped !== modelValue.value) modelValue.value = clamped;
  draw();
});
</script>

<style scoped>
.start-window {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.start-window__labels {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--hud-text, rgba(255, 255, 255, 0.85));
}

.start-window__label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.start-window__label--dim {
  opacity: 0.7;
}

.start-window__chart {
  width: 100%;
  cursor: grab;
  touch-action: none;
}

.start-window__chart:active {
  cursor: grabbing;
}

.start-window__chart--locked {
  cursor: default;
}

.start-window__chart canvas {
  display: block;
  width: 100%;
}
</style>
