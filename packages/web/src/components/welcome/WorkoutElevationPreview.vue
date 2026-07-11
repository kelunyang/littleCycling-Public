<template>
  <div ref="containerRef" class="elev-preview">
    <canvas ref="canvasRef" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import type { RoutePoint, WorkoutSegment } from '@littlecycling/shared';
import { buildCumulativeDistances } from '@/game/route-geometry';
import { useSettingsStore } from '@/stores/settingsStore';

const settingsStore = useSettingsStore();
const worldStyle = computed(
  () => settingsStore.config.map.phaserStyle ?? 'plastic',
);

interface ElevPalette {
  bg: string;
  scanline: string;
  line: string;
  fillTop: string;
  fillBottom: string;
  glow: string;
  border: string;
  cursor: string;
  cursorGlow: string;
  slopeText: string;
  slopeShadow: string;
  segmentSeparator: string;
  segmentBoundary: string;
  segmentLabel: string;
  activeStripe: string;
  font: string;
}

const PALETTES: Record<'plastic' | 'cuphead' | 'default', ElevPalette> = {
  plastic: {
    bg: 'rgba(255, 247, 251, 0.94)',
    scanline: 'rgba(26, 17, 64, 0.05)',
    line: 'rgba(255, 59, 141, 0.95)',
    fillTop: 'rgba(255, 59, 141, 0.30)',
    fillBottom: 'rgba(255, 59, 141, 0.04)',
    glow: 'rgba(255, 59, 141, 0.55)',
    border: '#1a1140',
    cursor: 'rgba(255, 234, 0, 1)',
    cursorGlow: 'rgba(26, 17, 64, 0.7)',
    slopeText: '#1a1140',
    slopeShadow: 'rgba(255, 234, 0, 0.6)',
    segmentSeparator: 'rgba(26, 17, 64, 0.2)',
    segmentBoundary: 'rgba(26, 17, 64, 0.5)',
    segmentLabel: 'rgba(26, 17, 64, 0.7)',
    activeStripe: 'rgba(26, 17, 64, 0.18)',
    font: '11px Fredoka, sans-serif',
  },
  cuphead: {
    bg: 'rgba(232, 220, 192, 0.95)',
    scanline: 'rgba(42, 36, 32, 0.05)',
    line: '#a0523c',
    fillTop: 'rgba(196, 160, 53, 0.45)',
    fillBottom: 'rgba(196, 160, 53, 0.10)',
    glow: 'rgba(0, 0, 0, 0)',
    border: '#2a2420',
    cursor: '#a0523c',
    cursorGlow: 'rgba(0, 0, 0, 0)',
    slopeText: '#2a2420',
    slopeShadow: 'rgba(196, 160, 53, 0.55)',
    segmentSeparator: 'rgba(42, 36, 32, 0.3)',
    segmentBoundary: 'rgba(42, 36, 32, 0.55)',
    segmentLabel: 'rgba(42, 36, 32, 0.8)',
    activeStripe: 'rgba(42, 36, 32, 0.2)',
    font: '12px "Cabin Sketch", cursive',
  },
  default: {
    bg: 'rgba(5, 10, 20, 0.82)',
    scanline: 'rgba(0, 229, 255, 0.04)',
    line: 'rgba(0, 229, 255, 0.9)',
    fillTop: 'rgba(0, 229, 255, 0.15)',
    fillBottom: 'rgba(0, 229, 255, 0.02)',
    glow: 'rgba(0, 229, 255, 0.8)',
    border: 'rgba(0, 229, 255, 0.3)',
    cursor: 'rgba(0, 229, 255, 0.95)',
    cursorGlow: 'rgba(0, 229, 255, 0.8)',
    slopeText: 'rgba(255, 215, 0, 0.85)',
    slopeShadow: 'rgba(255, 215, 0, 0.4)',
    segmentSeparator: 'rgba(255, 255, 255, 0.15)',
    segmentBoundary: 'rgba(255, 255, 255, 0.35)',
    segmentLabel: 'rgba(255, 255, 255, 0.4)',
    activeStripe: 'rgba(255, 255, 255, 0.18)',
    font: '11px Orbitron, monospace',
  },
};

const palette = computed<ElevPalette>(
  () => PALETTES[worldStyle.value] ?? PALETTES.default,
);

/** Build cumulative elapsed time (ms) from tsEpoch. Returns null if timestamps missing. */
function buildCumulativeTimes(pts: RoutePoint[]): number[] | null {
  if (pts.length < 2 || pts[0].tsEpoch == null || pts[pts.length - 1].tsEpoch == null) return null;
  const t0 = pts[0].tsEpoch!;
  const times = new Array<number>(pts.length);
  for (let i = 0; i < pts.length; i++) {
    times[i] = (pts[i].tsEpoch ?? t0) - t0;
  }
  // Ensure total > 0
  return times[times.length - 1] > 0 ? times : null;
}

const props = withDefaults(defineProps<{
  routePoints: RoutePoint[];
  workoutSegments: WorkoutSegment[];
  totalDurationMs: number;
  /** X-axis range = user target ride time. If > route/workout duration, profile & bands tile. */
  displayDurationMs?: number;
  /** When provided, enables live-tracking mode: triangle cursor + active segment stripes */
  elapsedMs?: number;
}>(), {
  displayDurationMs: 0,
  elapsedMs: -1,
});

const containerRef = ref<HTMLElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

const CANVAS_H = 120;
const PAD = { top: 10, right: 10, bottom: 22, left: 10 };

/** Estimate route duration: prefer GPX timestamps, fallback = distance / 20 km/h */
const FALLBACK_SPEED_MS = 20 / 3.6; // 20 km/h → m/s

// Pre-compute elevation data
const elevData = computed(() => {
  const pts = props.routePoints;
  if (pts.length < 2) return null;

  const cumDists = buildCumulativeDistances(pts);
  const totalDist = cumDists[cumDists.length - 1];
  if (totalDist <= 0) return null;

  // Prefer time-based X axis; fall back to distance (≈ constant speed)
  const cumTimes = buildCumulativeTimes(pts);
  const cumX = cumTimes ?? cumDists;
  const totalX = cumX[cumX.length - 1];

  // Route's natural duration (ms) for one lap
  const routeDurationMs = cumTimes
    ? cumTimes[cumTimes.length - 1]
    : (totalDist / FALLBACK_SPEED_MS) * 1000;

  let minEle = Infinity;
  let maxEle = -Infinity;
  for (const p of pts) {
    if (p.ele < minEle) minEle = p.ele;
    if (p.ele > maxEle) maxEle = p.ele;
  }
  if (maxEle === minEle) {
    maxEle += 10;
    minEle = Math.max(0, minEle - 10);
  }
  const range = maxEle - minEle;
  minEle = Math.max(0, minEle - range * 0.05);
  maxEle = maxEle + range * 0.05;

  return { cumDists, totalDist, cumX, totalX, routeDurationMs, minEle, maxEle };
});

// Slope markers: segments where avg gradient > 5%
const slopeMarkers = computed(() => {
  const data = elevData.value;
  if (!data) return [];

  const pts = props.routePoints;
  const { cumDists, totalDist, cumX, totalX } = data;
  const markers: { xPct: number; gradient: number }[] = [];

  // Divide route into ~20 distance-based segments for slope analysis
  const numSegs = 20;
  const segLen = totalDist / numSegs;

  for (let s = 0; s < numSegs; s++) {
    const startDist = s * segLen;
    const endDist = (s + 1) * segLen;
    const midDist = (startDist + endDist) / 2;

    // Find elevation at start and end via interpolation
    let startEle = pts[0].ele;
    let endEle = pts[pts.length - 1].ele;
    // Also find the cumX value at the midpoint for time-based positioning
    let midX = (midDist / totalDist) * totalX;

    for (let i = 0; i < pts.length - 1; i++) {
      if (cumDists[i] <= startDist && cumDists[i + 1] >= startDist) {
        const t = (startDist - cumDists[i]) / (cumDists[i + 1] - cumDists[i] || 1);
        startEle = pts[i].ele + (pts[i + 1].ele - pts[i].ele) * t;
      }
      if (cumDists[i] <= endDist && cumDists[i + 1] >= endDist) {
        const t = (endDist - cumDists[i]) / (cumDists[i + 1] - cumDists[i] || 1);
        endEle = pts[i].ele + (pts[i + 1].ele - pts[i].ele) * t;
      }
      if (cumDists[i] <= midDist && cumDists[i + 1] >= midDist) {
        const t = (midDist - cumDists[i]) / (cumDists[i + 1] - cumDists[i] || 1);
        midX = cumX[i] + (cumX[i + 1] - cumX[i]) * t;
      }
    }

    const gradient = ((endEle - startEle) / segLen) * 100;
    if (gradient > 5) {
      markers.push({
        xPct: midX / totalX,
        gradient: Math.round(gradient),
      });
    }
  }

  return markers;
});

function draw() {
  const canvas = canvasRef.value;
  const container = containerRef.value;
  const data = elevData.value;
  if (!canvas || !container || !data) return;

  const dpr = window.devicePixelRatio || 1;
  const w = container.clientWidth;
  if (w <= 0) return;

  canvas.width = w * dpr;
  canvas.height = CANVAS_H * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${CANVAS_H}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, CANVAS_H);

  const pal = palette.value;

  // Background
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, w, CANVAS_H);

  const plotW = w - PAD.left - PAD.right;
  const plotH = CANVAS_H - PAD.top - PAD.bottom;

  // ── Display range ──
  const segs = props.workoutSegments;
  const workoutDur = props.totalDurationMs;
  // X-axis total = displayDurationMs (user target), fallback to workout or route duration
  const displayDur = props.displayDurationMs > 0
    ? props.displayDurationMs
    : (workoutDur > 0 ? workoutDur : data.routeDurationMs);
  const isLive = props.elapsedMs >= 0;

  // ── Workout segment color bands (tiled) ──
  // Determine active segment index for live mode (wrapping)
  let activeSegIdx = -1;
  if (isLive && segs.length > 0 && workoutDur > 0) {
    const wrapped = props.elapsedMs % workoutDur;
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      if (wrapped < acc + segs[i].durationMs) { activeSegIdx = i; break; }
      acc += segs[i].durationMs;
    }
    if (activeSegIdx < 0) activeSegIdx = segs.length - 1;
  }

  if (segs.length > 0 && workoutDur > 0) {
    const numCycles = Math.ceil(displayDur / workoutDur);
    let xOffset = PAD.left;
    for (let cycle = 0; cycle < numCycles; cycle++) {
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        let segW = (seg.durationMs / displayDur) * plotW;
        // Clamp last segment of last cycle so we don't overflow
        if (xOffset + segW > PAD.left + plotW) segW = PAD.left + plotW - xOffset;
        if (segW <= 0) break;

        // Fill band
        ctx.fillStyle = hexToRgba(seg.color, 0.15);
        ctx.fillRect(xOffset, PAD.top, segW, plotH);

        // Active segment diagonal stripes (live mode only)
        const globalIdx = cycle * segs.length + i;
        const isActive = isLive && cycle === Math.floor(props.elapsedMs / workoutDur) && i === activeSegIdx;
        if (isActive) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(xOffset, PAD.top, segW, plotH);
          ctx.clip();
          ctx.strokeStyle = pal.activeStripe;
          ctx.lineWidth = 1;
          const step = 6;
          const span = segW + plotH;
          for (let d = -plotH; d < span; d += step) {
            ctx.beginPath();
            ctx.moveTo(xOffset + d, PAD.top + plotH);
            ctx.lineTo(xOffset + d + plotH, PAD.top);
            ctx.stroke();
          }
          ctx.restore();
        }

        // Segment separator line (skip first of first cycle)
        if (globalIdx > 0) {
          ctx.save();
          ctx.strokeStyle = cycle > 0 && i === 0
            ? pal.segmentBoundary // stronger line at cycle boundary
            : pal.segmentSeparator;
          ctx.lineWidth = 1;
          ctx.setLineDash(cycle > 0 && i === 0 ? [5, 3] : [3, 3]);
          ctx.beginPath();
          ctx.moveTo(xOffset, PAD.top);
          ctx.lineTo(xOffset, PAD.top + plotH);
          ctx.stroke();
          ctx.restore();
        }

        // Segment name label at bottom
        if (segW > 20) {
          ctx.save();
          ctx.font = pal.font;
          ctx.fillStyle = pal.segmentLabel;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          const labelX = xOffset + segW / 2;
          const labelY = PAD.top + plotH + 4;
          const maxChars = Math.floor(segW / 5);
          let label = seg.name;
          if (label.length > maxChars) label = label.substring(0, Math.max(2, maxChars - 1)) + '…';
          ctx.fillText(label, labelX, labelY);
          ctx.restore();
        }

        xOffset += segW;
      }
    }
  }

  // CRT scan lines
  ctx.strokeStyle = pal.scanline;
  ctx.lineWidth = 1;
  for (let y = PAD.top; y <= PAD.top + plotH; y += 3) {
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + plotW, y);
    ctx.stroke();
  }

  // ── Elevation profile (tiled to fill displayDur) ──
  const { cumX, totalX, routeDurationMs, minEle, maxEle } = data;
  const pts = props.routePoints;
  const eleRange = maxEle - minEle;

  // How many laps of the route fit in displayDur
  const lapDurMs = routeDurationMs;
  const numLaps = Math.ceil(displayDur / lapDurMs);
  const lapWidthPx = (lapDurMs / displayDur) * plotW;

  // Build points for all laps
  const points: { x: number; y: number }[] = [];
  const step = Math.max(1, Math.floor(pts.length / Math.max(1, lapWidthPx)));
  for (let lap = 0; lap < numLaps; lap++) {
    const lapOffsetPx = PAD.left + lap * lapWidthPx;
    for (let i = 0; i < pts.length; i += step) {
      const x = lapOffsetPx + (cumX[i] / totalX) * lapWidthPx;
      if (x > PAD.left + plotW + 1) break; // past visible area
      const y = PAD.top + plotH * (1 - (pts[i].ele - minEle) / eleRange);
      points.push({ x, y });
    }
    // Include last point of this lap
    const lastI = pts.length - 1;
    const lx = lapOffsetPx + lapWidthPx;
    if (lx <= PAD.left + plotW + 1) {
      const ly = PAD.top + plotH * (1 - (pts[lastI].ele - minEle) / eleRange);
      if (points.length === 0 || points[points.length - 1].x < lx - 1) {
        points.push({ x: lx, y: ly });
      }
    }
  }

  if (points.length < 2) return;

  // Gradient fill under elevation line
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.lineTo(points[points.length - 1].x, PAD.top + plotH);
  ctx.lineTo(points[0].x, PAD.top + plotH);
  ctx.closePath();

  const fillGrad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + plotH);
  fillGrad.addColorStop(0, pal.fillTop);
  fillGrad.addColorStop(1, pal.fillBottom);
  ctx.fillStyle = fillGrad;
  ctx.fill();

  // Glow pass
  ctx.save();
  ctx.shadowBlur = 8;
  ctx.shadowColor = pal.glow;
  ctx.strokeStyle = pal.glow;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
  ctx.restore();

  // Sharp line
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();

  // ── Slope markers (tiled) ──
  for (let lap = 0; lap < numLaps; lap++) {
    const lapOffsetPx = lap * lapWidthPx;
    for (const marker of slopeMarkers.value) {
      const mx = PAD.left + lapOffsetPx + marker.xPct * lapWidthPx;
      if (mx > PAD.left + plotW) break;
      // Find Y at this position by interpolating points array
      let my = PAD.top;
      for (let i = 0; i < points.length - 1; i++) {
        if (points[i].x <= mx && points[i + 1].x >= mx) {
          const t = (mx - points[i].x) / (points[i + 1].x - points[i].x || 1);
          my = points[i].y + (points[i + 1].y - points[i].y) * t;
          break;
        }
      }

      ctx.save();
      ctx.font = pal.font;
      ctx.fillStyle = pal.slopeText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.shadowBlur = 4;
      ctx.shadowColor = pal.slopeShadow;
      ctx.fillText(`▲${marker.gradient}%`, mx, my - 4);
      ctx.restore();
    }
  }

  // ── Minute graduations on the X (time) axis ──
  drawMinuteTicks(ctx, plotW, plotH, displayDur, pal);

  // ── Live-mode triangle cursor ──
  if (isLive && displayDur > 0) {
    const pct = Math.min(1, Math.max(0, props.elapsedMs / displayDur));
    const cx = PAD.left + pct * plotW;
    const triH = 8;
    const triW = 6;
    ctx.save();
    ctx.shadowBlur = 6;
    ctx.shadowColor = pal.cursorGlow;
    ctx.fillStyle = pal.cursor;
    ctx.beginPath();
    ctx.moveTo(cx, PAD.top + plotH + 2);        // tip pointing down into label area
    ctx.lineTo(cx - triW, PAD.top + plotH + 2 + triH);
    ctx.lineTo(cx + triW, PAD.top + plotH + 2 + triH);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Border (themed)
  ctx.save();
  ctx.strokeStyle = pal.border;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(0.75, 0.75, w - 1.5, CANVAS_H - 1.5);
  ctx.restore();
}

/**
 * Draw one graduation per minute along the X (time) axis so the rider can always
 * read elapsed/remaining time even if the game state misbehaves. Every minute gets
 * a tick; minute numbers are labelled at a spacing that avoids overlap.
 */
function drawMinuteTicks(
  ctx: CanvasRenderingContext2D,
  plotW: number,
  plotH: number,
  displayDur: number,
  pal: ElevPalette,
) {
  if (displayDur <= 0 || plotW <= 0) return;

  const totalMin = displayDur / 60000;
  const pxPerMin = (60000 / displayDur) * plotW;

  // Pick a label spacing (in minutes) so numbers stay ~20px apart
  let labelEvery = 1;
  for (const step of [1, 2, 5, 10, 15, 30, 60]) {
    labelEvery = step;
    if (pxPerMin * step >= 20) break;
  }

  const lastMin = Math.floor(totalMin + 1e-6);
  ctx.save();
  ctx.font = pal.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (let m = 0; m <= lastMin; m++) {
    const x = PAD.left + ((m * 60000) / displayDur) * plotW;
    if (x > PAD.left + plotW + 0.5) break;
    const labeled = m % labelEvery === 0;

    if (labeled && m > 0) {
      // Full-height faint guide line to help align with the cursor
      ctx.strokeStyle = pal.segmentSeparator;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, PAD.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Top-edge tick mark (stronger on labelled minutes)
    ctx.strokeStyle = labeled ? pal.segmentBoundary : pal.segmentSeparator;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + (labeled ? 6 : 3));
    ctx.stroke();

    // Minute number (skip 0 to avoid crowding the left border)
    if (labeled && m > 0) {
      ctx.fillStyle = pal.segmentLabel;
      ctx.fillText(String(m), x, PAD.top + 6);
    }
  }
  ctx.restore();
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Responsive resize
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
});

// Redraw when props or theme change
watch(
  () => [
    props.routePoints,
    props.workoutSegments,
    props.totalDurationMs,
    props.displayDurationMs,
    props.elapsedMs,
    worldStyle.value,
  ],
  () => draw(),
  { deep: true },
);
</script>

<style scoped>
.elev-preview {
  width: 100%;
  flex-shrink: 0;
}

.elev-preview canvas {
  display: block;
  width: 100%;
}
</style>
