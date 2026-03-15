<template>
  <div class="minimap-container">
    <svg class="minimap" :viewBox="viewBox" preserveAspectRatio="xMidYMid meet" overflow="hidden">
      <defs>
        <filter id="minimap-glow">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g :transform="rotateTransform">
        <rect x="0" y="0" :width="svgW" :height="svgH" fill="rgba(5,10,20,0.8)" />
        <polyline
          :points="routePolyline"
          fill="none"
          stroke="#fcee09"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
          filter="url(#minimap-glow)"
          opacity="0.8"
        />
      </g>
      <!-- Ball stays fixed at center (not rotated) -->
      <circle
        :cx="ballPos.x"
        :cy="ballPos.y"
        r="4"
        fill="#ff2d6b"
        filter="url(#minimap-glow)"
      />
      <!-- Direction indicator (small triangle pointing up from ball) -->
      <polygon
        :points="directionArrow"
        fill="#ff2d6b"
        opacity="0.8"
      />

      <!-- Compass rose (top-right corner, rotates opposite to map) -->
      <g :transform="compassTransform">
        <!-- N arrow (magenta/bright) -->
        <polygon
          :points="`${compassX},${compassY - 10} ${compassX - 4},${compassY} ${compassX + 4},${compassY}`"
          fill="#ff2d6b"
          filter="url(#minimap-glow)"
        />
        <!-- S arrow (dim) -->
        <polygon
          :points="`${compassX},${compassY + 10} ${compassX - 4},${compassY} ${compassX + 4},${compassY}`"
          fill="rgba(0,229,255,0.3)"
        />
        <!-- N label -->
        <text
          :x="compassX"
          :y="compassY - 13"
          text-anchor="middle"
          font-size="8"
          font-weight="700"
          fill="#ff2d6b"
          font-family="Orbitron, monospace"
          filter="url(#minimap-glow)"
        >N</text>
        <!-- Crosshair ring -->
        <circle
          :cx="compassX"
          :cy="compassY"
          r="12"
          fill="none"
          stroke="rgba(0,229,255,0.2)"
          stroke-width="0.5"
        />
        <!-- E/W tick marks -->
        <line
          :x1="compassX - 12" :y1="compassY"
          :x2="compassX - 8" :y2="compassY"
          stroke="rgba(0,229,255,0.3)" stroke-width="0.5"
        />
        <line
          :x1="compassX + 8" :y1="compassY"
          :x2="compassX + 12" :y2="compassY"
          stroke="rgba(0,229,255,0.3)" stroke-width="0.5"
        />
      </g>
    </svg>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { RoutePoint } from '@littlecycling/shared';

const svgW = 180;
const svgH = 120;
const padding = 10;

// Compass position (top-right area)
const compassX = svgW - 18;
const compassY = 18;

const props = defineProps<{
  routePoints: RoutePoint[];
  ballLat: number;
  ballLon: number;
  bearing: number;
}>();

const viewBox = `0 0 ${svgW} ${svgH}`;

// Ball is always pinned to SVG center
const centerX = svgW / 2;
const centerY = svgH / 2;

// Uniform scale: fit entire route into the drawable area while keeping aspect ratio
const uniformScale = computed(() => {
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;
  for (const p of props.routePoints) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  const rangeW = maxLon - minLon || 0.001;
  const rangeH = maxLat - minLat || 0.001;
  const drawW = svgW - padding * 2;
  const drawH = svgH - padding * 2;
  return Math.min(drawW / rangeW, drawH / rangeH);
});

// Project relative to ball position — ball stays at center
function project(lat: number, lon: number): { x: number; y: number } {
  const s = uniformScale.value;
  return {
    x: centerX + (lon - props.ballLon) * s,
    y: centerY - (lat - props.ballLat) * s, // flip Y
  };
}

const routePolyline = computed(() =>
  props.routePoints.map((p) => {
    const { x, y } = project(p.lat, p.lon);
    return `${x},${y}`;
  }).join(' ')
);

const ballPos = computed(() => ({ x: centerX, y: centerY }));

// Rotate the route/background around center (= ball) so travel direction points up
const rotateTransform = computed(() => {
  return `rotate(${-props.bearing}, ${centerX}, ${centerY})`;
});

// Compass rotates with bearing so N always points to true north
const compassTransform = computed(() => {
  return `rotate(${-props.bearing}, ${compassX}, ${compassY})`;
});

// Small triangle pointing up from the ball to indicate direction
const directionArrow = computed(() => {
  const size = 5;
  return `${centerX},${centerY - size - 4} ${centerX - size * 0.6},${centerY - 4} ${centerX + size * 0.6},${centerY - 4}`;
});
</script>

<style scoped>
.minimap-container {
  width: 180px;
  height: 120px;
  overflow: hidden;
  background: #050a14;
  border: 1px solid var(--hud-border);
  clip-path: var(--clip-panel);
  box-shadow: var(--hud-glow-cyan);
}

.minimap {
  width: 100%;
  height: 100%;
}

.minimap g {
  transition: transform 0.3s ease;
}
</style>
