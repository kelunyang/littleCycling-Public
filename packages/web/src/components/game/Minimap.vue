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
      <!-- Backdrop lives on the container (solid black), so the SVG itself is
           transparent — any letterboxing from stretching just shows black,
           never a seam. -->
      <g :transform="rotateTransform">
        <!-- Inner group carries the per-frame ball-centering pan. The route
             points are projected once in a fixed frame (see routePolyline); the
             pan below re-centres them on the ball each frame as an O(1) SVG
             translate. Kept out of the rotation group's CSS transition so the
             pan stays instant (matching the old per-frame points rebuild) while
             only the rotation eases. -->
        <g :transform="panTransform" class="minimap-pan">
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
      </g>
      <!-- Sonar ping: rings ripple outward from the current position. Two,
           staggered, so a ring is always mid-flight. -->
      <circle
        class="sonar-ring"
        :cx="ballPos.x"
        :cy="ballPos.y"
        fill="none"
        stroke="#ff2d6b"
        stroke-width="1.5"
      />
      <circle
        class="sonar-ring sonar-ring--delayed"
        :cx="ballPos.x"
        :cy="ballPos.y"
        fill="none"
        stroke="#ff2d6b"
        stroke-width="1.5"
      />
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

// Fixed projection origin (route bounding-box min corner). Independent of the
// ball, so the projected polyline below only rebuilds when the route changes —
// not on every frame as the ball moves.
const projOrigin = computed(() => {
  let minLat = Infinity, minLon = Infinity;
  for (const p of props.routePoints) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
  }
  return { lat0: minLat, lon0: minLon };
});

/**
 * 抽稀門檻(SVG 使用者座標 ≈ 顯示 px)。
 *
 * 整條路線被 uniformScale 壓進 160×100 的框裡,遠比畫面解析得出來的細;而這條
 * polyline 掛著 `filter="url(#minimap-glow)"`(feGaussianBlur),外層的 pan /
 * rotate 一動,整條路徑就得連同濾鏡重新光柵化一次。
 *
 * 丟掉與前一個保留點距離不足 0.4 px 的點。實測(data/routes 那條 45.6 km、
 * 10452 點的台北路線):
 *
 *   點數        10452 → 844   (8.1%)
 *   points 屬性 394 KB → 11 KB (2.8%)
 *   被丟掉的點離保留路徑最遠 0.34 px
 *
 * 筆畫寬 2 px 又被 stdDeviation 1.5 的高斯模糊糊過,0.34 px 在像素上不存在。
 * (這是**幾何**的浪費,不是填充率的浪費 —— 範圍一點都沒變。)
 */
const MIN_POINT_SPACING_PX = 0.4;

// Route projected once in the fixed frame. Per-frame ball-centering is applied
// as an SVG translate (panTransform) instead of re-projecting every point.
const routePolyline = computed(() => {
  const s = uniformScale.value;
  const { lat0, lon0 } = projOrigin.value;
  const pts = props.routePoints;
  if (pts.length === 0) return '';
  const minSq = MIN_POINT_SPACING_PX * MIN_POINT_SPACING_PX;
  const out: string[] = [];
  let lastX = 0;
  let lastY = 0;
  for (let i = 0; i < pts.length; i++) {
    const x = centerX + (pts[i].lon - lon0) * s;
    const y = centerY - (pts[i].lat - lat0) * s; // flip Y
    // 首尾一定保留,中間看間距。
    if (i > 0 && i < pts.length - 1) {
      const dx = x - lastX;
      const dy = y - lastY;
      if (dx * dx + dy * dy < minSq) continue;
    }
    // 2 位小數 = 1/100 px。原本輸出的是完整浮點數,一個點就三十幾個字元。
    out.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    lastX = x;
    lastY = y;
  }
  return out.join(' ');
});

const ballPos = computed(() => ({ x: centerX, y: centerY }));

/**
 * 這三個 transform 的量化門檻。
 *
 * 為什麼要量化:ballLat/ballLon/bearing 每幀都在變,所以這三個 computed 每幀都
 * 會重算,每幀都會改寫 SVG 的 transform,而底下那棵子樹掛著高斯模糊 —— 每幀
 * 重新光柵化一次。**量化之後 computed 回傳的是同一個字串**,Vue 的 patchProps
 * 有 `next !== prev` 把關,連 setAttribute 都不會發生,自然也就沒有
 * style / layout / paint。
 *
 * 為什麼看不出來:
 * - pan:上面那條路線實測 0.0079 px/m ⇒ 騎士 30 km/h 時這個 pan **每秒只移動
 *   0.066 px**。不量化的話,是每幀為了千分之一個像素把整條濾鏡路徑重畫一次;
 *   量化成 1/4 px 之後,這個 transform 大約 4 秒才變一次。1/4 px 的量子在
 *   2 px 寬又被模糊過的筆畫上不可見。
 * - rotate:viewBox 內離中心最遠約 108 px,0.25° 只有 0.47 px 的位移,而且
 *   `.minimap g` 本來就掛著 `transition: transform 0.3s ease`,那條 transition
 *   會把階梯補成連續 —— 它以前的作用只是被每秒重啟 60 次,現在才真的在補間。
 */
const PAN_QUANT_PX = 0.25;
const BEARING_QUANT_DEG = 0.25;

function quantise(v: number, step: number): string {
  // toFixed 收掉 Math.round(v/step)*step 的浮點尾巴(0.7500000000000001)——
  // 尾巴會讓字串每次都不同,量化就白做了。
  return (Math.round(v / step) * step).toFixed(2);
}

// Per-frame pan: shift the fixed-frame route so the ball sits at center. Chosen
// so that fixed-frame X + tx === old ball-relative X (and likewise for Y):
//   centerX + (lon - lon0)*s + tx === centerX + (lon - ballLon)*s.
const panTransform = computed(() => {
  const s = uniformScale.value;
  const { lat0, lon0 } = projOrigin.value;
  const tx = quantise((lon0 - props.ballLon) * s, PAN_QUANT_PX);
  const ty = quantise((props.ballLat - lat0) * s, PAN_QUANT_PX);
  return `translate(${tx}, ${ty})`;
});

// 兩個 rotate 共用同一個量化角度,省一次計算也保證羅盤與地圖永遠同步。
const negBearingQ = computed(() => quantise(-props.bearing, BEARING_QUANT_DEG));

// Rotate the route/background around center (= ball) so travel direction points up
const rotateTransform = computed(() => {
  return `rotate(${negBearingQ.value}, ${centerX}, ${centerY})`;
});

// Compass rotates with bearing so N always points to true north
const compassTransform = computed(() => {
  return `rotate(${negBearingQ.value}, ${compassX}, ${compassY})`;
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
  background: #000;
  border: 1.5px solid var(--hud-border);
  clip-path: var(--clip-panel);
}

.minimap {
  width: 100%;
  height: 100%;
}

.minimap g {
  transition: transform 0.3s ease;
}

/* The ball-centering pan must be instant (it replaces the old per-frame points
   rebuild); only the rotation group keeps the 0.3s ease. Higher specificity than
   `.minimap g` so it wins. */
.minimap g.minimap-pan {
  transition: none;
}

/* Sonar ping — radius grows from the ball outward while fading. Animating the
   SVG `r` geometry property (supported in Chromium, which is what we ship). */
.sonar-ring {
  animation: minimap-sonar 2.4s ease-out infinite;
}

.sonar-ring--delayed {
  animation-delay: 1.2s;
}

@keyframes minimap-sonar {
  0% { r: 4; opacity: 0.7; }
  100% { r: 26; opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .sonar-ring { display: none; }
}
</style>
