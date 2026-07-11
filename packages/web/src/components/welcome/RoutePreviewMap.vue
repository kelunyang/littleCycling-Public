<template>
  <div class="route-preview">
    <svg class="route-preview__svg" :viewBox="viewBox" preserveAspectRatio="xMidYMid meet" overflow="hidden">
      <defs>
        <filter id="preview-glow">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect x="0" y="0" :width="svgW" :height="svgH" class="route-preview__bg" />
      <polyline
        :points="routePolyline"
        class="route-preview__line"
        stroke-width="2"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      <!-- Start marker -->
      <circle
        v-if="startPt"
        :cx="startPt.x"
        :cy="startPt.y"
        r="4"
        class="route-preview__marker route-preview__marker--start"
      />
      <!-- End marker -->
      <circle
        v-if="endPt"
        :cx="endPt.x"
        :cy="endPt.y"
        r="4"
        class="route-preview__marker route-preview__marker--end"
      />
    </svg>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { RoutePoint } from '@littlecycling/shared';

const svgW = 180;
const svgH = 120;
const padding = 12;

const props = defineProps<{
  routePoints: RoutePoint[];
}>();

const viewBox = `0 0 ${svgW} ${svgH}`;

const bounds = computed(() => {
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;
  for (const p of props.routePoints) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return { minLat, maxLat, minLon, maxLon };
});

const centerLat = computed(() => (bounds.value.minLat + bounds.value.maxLat) / 2);
const centerLon = computed(() => (bounds.value.minLon + bounds.value.maxLon) / 2);

const uniformScale = computed(() => {
  const { minLat, maxLat, minLon, maxLon } = bounds.value;
  const rangeW = maxLon - minLon || 0.001;
  const rangeH = maxLat - minLat || 0.001;
  const drawW = svgW - padding * 2;
  const drawH = svgH - padding * 2;
  return Math.min(drawW / rangeW, drawH / rangeH);
});

function project(lat: number, lon: number): { x: number; y: number } {
  const s = uniformScale.value;
  return {
    x: svgW / 2 + (lon - centerLon.value) * s,
    y: svgH / 2 - (lat - centerLat.value) * s,
  };
}

const routePolyline = computed(() =>
  props.routePoints.map((p) => {
    const { x, y } = project(p.lat, p.lon);
    return `${x},${y}`;
  }).join(' ')
);

const startPt = computed(() => {
  if (props.routePoints.length === 0) return null;
  return project(props.routePoints[0].lat, props.routePoints[0].lon);
});

const endPt = computed(() => {
  if (props.routePoints.length < 2) return null;
  const last = props.routePoints[props.routePoints.length - 1];
  return project(last.lat, last.lon);
});
</script>

<style scoped>
.route-preview {
  width: 180px;
  height: 120px;
  flex-shrink: 0;
  overflow: hidden;
  border: 1.5px solid var(--hud-border-bright);
  border-radius: var(--card-radius-sm);
  background: var(--surface-light);
  box-shadow: var(--accent-glow-soft);
}

.route-preview__svg {
  width: 100%;
  height: 100%;
}

.route-preview__bg {
  fill: var(--surface-light);
}

.route-preview__line {
  fill: none;
  stroke: var(--hud-cyan);
  filter: url(#preview-glow);
  opacity: 0.95;
}

.route-preview__marker {
  filter: url(#preview-glow);
  stroke: var(--hud-border-bright);
  stroke-width: 1.5;
}

.route-preview__marker--start {
  fill: #00c853;
}

.route-preview__marker--end {
  fill: var(--hud-magenta);
}
</style>
