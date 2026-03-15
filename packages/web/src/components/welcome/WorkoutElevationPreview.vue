<template>
  <div ref="containerRef" class="elev-preview">
    <canvas ref="canvasRef" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import type { RoutePoint, WorkoutSegment } from '@littlecycling/shared';
import { buildCumulativeDistances } from '@/game/route-geometry';

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

  // Background
  ctx.fillStyle = 'rgba(5, 10, 20, 0.82)';
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
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
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
            ? 'rgba(255, 255, 255, 0.35)' // stronger line at cycle boundary
            : 'rgba(255, 255, 255, 0.15)';
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
          ctx.font = '8px Orbitron, monospace';
          ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
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
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.04)';
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
  fillGrad.addColorStop(0, 'rgba(0, 229, 255, 0.15)');
  fillGrad.addColorStop(1, 'rgba(0, 229, 255, 0.02)');
  ctx.fillStyle = fillGrad;
  ctx.fill();

  // Glow pass
  ctx.save();
  ctx.shadowBlur = 8;
  ctx.shadowColor = 'rgba(0, 229, 255, 0.8)';
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.6)';
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
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.9)';
  ctx.lineWidth = 1.5;
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
      ctx.font = '8px Orbitron, monospace';
      ctx.fillStyle = 'rgba(255, 215, 0, 0.8)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.shadowBlur = 4;
      ctx.shadowColor = 'rgba(255, 215, 0, 0.4)';
      ctx.fillText(`▲${marker.gradient}%`, mx, my - 4);
      ctx.restore();
    }
  }

  // ── Live-mode triangle cursor ──
  if (isLive && displayDur > 0) {
    const pct = Math.min(1, Math.max(0, props.elapsedMs / displayDur));
    const cx = PAD.left + pct * plotW;
    const triH = 8;
    const triW = 6;
    ctx.save();
    ctx.shadowBlur = 6;
    ctx.shadowColor = 'rgba(0, 229, 255, 0.8)';
    ctx.fillStyle = 'rgba(0, 229, 255, 0.95)';
    ctx.beginPath();
    ctx.moveTo(cx, PAD.top + plotH + 2);        // tip pointing down into label area
    ctx.lineTo(cx - triW, PAD.top + plotH + 2 + triH);
    ctx.lineTo(cx + triW, PAD.top + plotH + 2 + triH);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Glowing border
  ctx.save();
  ctx.shadowBlur = 6;
  ctx.shadowColor = 'rgba(0, 229, 255, 0.4)';
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.3)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, CANVAS_H - 1);
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

// Redraw when props change
watch(
  () => [props.routePoints, props.workoutSegments, props.totalDurationMs, props.displayDurationMs, props.elapsedMs],
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
