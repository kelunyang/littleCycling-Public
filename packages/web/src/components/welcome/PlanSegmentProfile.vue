<template>
  <!-- compact:day cell 用的極簡色塊 band(無軸無字無 hover) -->
  <div v-if="compact" class="segprof__compact">
    <div
      v-for="(seg, i) in segments"
      :key="i"
      class="segprof__band"
      :style="{ flexGrow: Math.max(seg.durationMin, 0.5), background: segVar(seg.type) }"
    />
  </div>

  <!-- 完整模式:workout profile 圖 + legend -->
  <div v-else ref="rootRef" class="segprof">
    <div class="segprof__chart">
      <svg
        v-if="width > 0 && totalMin > 0"
        :width="width"
        :height="FULL_H"
        :viewBox="`0 0 ${width} ${FULL_H}`"
        role="img"
        aria-label="訓練段落心率區間圖"
      >
        <!-- recessive 水平 gridline + bpm 刻度 -->
        <g>
          <line
            v-for="t in yTicks"
            :key="'g' + t.v"
            :x1="PAD.left"
            :x2="width - PAD.right"
            :y1="t.y"
            :y2="t.y"
            class="segprof__grid"
          />
          <text
            v-for="t in yTicks"
            :key="'yl' + t.v"
            :x="PAD.left - 5"
            :y="t.y + 3"
            text-anchor="end"
            class="segprof__axtext"
          >{{ t.v }}</text>
        </g>

        <!-- x 軸分鐘刻度 -->
        <g>
          <template v-for="t in xTicks" :key="'x' + t.m">
            <line
              :x1="t.x"
              :x2="t.x"
              :y1="plotBottom"
              :y2="plotBottom + 4"
              class="segprof__grid"
            />
            <text
              :x="t.x"
              :y="plotBottom + 15"
              text-anchor="middle"
              class="segprof__axtext"
            >{{ t.m }}</text>
          </template>
        </g>

        <!-- 每段一個 HR band rect(2px 間隙、2px 圓角、fill 走 chart token)-->
        <rect
          v-for="(r, i) in rects"
          :key="'r' + i"
          :x="r.x"
          :y="r.y"
          :width="r.w"
          :height="r.h"
          rx="2"
          ry="2"
          :fill="r.fill"
        />

        <!-- actual HR 疊線:先 surface 4px halo,再 2px 主線,壓在色塊上仍可讀 -->
        <template v-if="actualPoints">
          <polyline :points="actualPoints" fill="none" class="segprof__actual-halo" />
          <polyline :points="actualPoints" fill="none" class="segprof__actual-line" />
        </template>

        <!-- x 軸單位 -->
        <text :x="PAD.left" :y="FULL_H - 3" class="segprof__axtext">min</text>
      </svg>

      <!-- hover 命中區(透明 HTML overlay,方便 tooltip 定位)-->
      <div v-if="width > 0" class="segprof__hits">
        <div
          v-for="(r, i) in rects"
          :key="'h' + i"
          class="segprof__hit"
          :style="{ left: r.x + 'px', width: r.w + 'px' }"
          @mouseenter="showTip(i, $event)"
          @mousemove="moveTip($event)"
          @mouseleave="hideTip"
        />
      </div>

      <!-- 評級徽章(文字 + 框線,不用純色示意)-->
      <div v-if="actual" class="segprof__badge">
        評級 {{ actual.grade }} · 達標 {{ Math.round(actual.overallTimeOnTargetPct) }}%
      </div>

      <!-- tooltip -->
      <div
        v-if="tip"
        class="segprof__tip"
        :style="{ left: tip.x + 'px', top: tip.y + 'px' }"
      >{{ tip.text }}</div>
    </div>

    <!-- legend(swatch + 中文標籤,文字用 dim token 不穿 series 色)-->
    <div class="segprof__legend">
      <span v-for="l in legend" :key="l.label" class="segprof__legend-item">
        <span class="segprof__swatch" :style="{ background: l.color }" />
        {{ l.label }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import type { PlanSegment, SegmentType } from '@littlecycling/shared';

const props = withDefaults(
  defineProps<{
    segments: PlanSegment[];
    compact?: boolean;
    /** 已完成訓練的實際資料;loading 期間先渲染 prescribed,資料到再疊線。 */
    actual?: { hrTrack: { tMs: number; hr: number }[]; grade: string; overallTimeOnTargetPct: number } | null;
  }>(),
  { compact: false, actual: null },
);

// ── segment type → chart token / 中文標籤 ──
// fill 一律引用 CSS var(--chart-seg-*),hex 只住 App.vue 主題區塊(見 CLAUDE.md)。
const SEG_VAR: Record<SegmentType, string> = {
  warmup: 'var(--chart-seg-warmup)',
  steady: 'var(--chart-seg-steady)',
  interval_work: 'var(--chart-seg-work)',
  interval_rest: 'var(--chart-seg-rest)',
  cooldown: 'var(--chart-seg-cooldown)',
};
const SEG_LABEL: Record<SegmentType, string> = {
  warmup: '熱身',
  steady: '穩定',
  interval_work: '間歇作',
  interval_rest: '間歇歇',
  cooldown: '收操',
};
function segVar(type: SegmentType): string {
  return SEG_VAR[type];
}

// warmup 與 cooldown 同色 → legend 合併「熱身/收操」
const LEGEND_DEFS: { types: SegmentType[]; label: string; color: string }[] = [
  { types: ['warmup', 'cooldown'], label: '熱身/收操', color: SEG_VAR.warmup },
  { types: ['steady'], label: '穩定', color: SEG_VAR.steady },
  { types: ['interval_work'], label: '間歇作', color: SEG_VAR.interval_work },
  { types: ['interval_rest'], label: '間歇歇', color: SEG_VAR.interval_rest },
];
const legend = computed(() => {
  const present = new Set(props.segments.map((s) => s.type));
  return LEGEND_DEFS.filter((d) => d.types.some((t) => present.has(t)));
});

// ── 版面常數(px:量測實寬,1 user unit = 1px,讓 2px 間隙/圓角視覺精準)──
const FULL_H = 160;
const PAD = { top: 10, right: 10, bottom: 26, left: 38 };
const GAP = 2; // 色塊間 surface 間隙

const rootRef = ref<HTMLElement | null>(null);
const width = ref(0);
let ro: ResizeObserver | null = null;

onMounted(() => {
  if (props.compact) return;
  if (rootRef.value) {
    width.value = rootRef.value.clientWidth;
    ro = new ResizeObserver(() => {
      if (rootRef.value) width.value = rootRef.value.clientWidth;
    });
    ro.observe(rootRef.value);
  }
});
onUnmounted(() => ro?.disconnect());

const totalMin = computed(() => props.segments.reduce((a, s) => a + s.durationMin, 0));

const plotW = computed(() => Math.max(0, width.value - PAD.left - PAD.right));
const plotH = FULL_H - PAD.top - PAD.bottom;
const plotBottom = PAD.top + plotH;

// y domain:min(hrMin)−10 ~ max(hrMax)+10
const yDomain = computed(() => {
  if (props.segments.length === 0) return { min: 60, max: 180 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of props.segments) {
    if (s.hrMin < lo) lo = s.hrMin;
    if (s.hrMax > hi) hi = s.hrMax;
  }
  return { min: lo - 10, max: hi + 10 };
});

function yOf(bpm: number): number {
  const { min, max } = yDomain.value;
  const span = max - min || 1;
  return PAD.top + (1 - (bpm - min) / span) * plotH;
}
function xOfMin(min: number): number {
  const t = totalMin.value > 0 ? min / totalMin.value : 0;
  return PAD.left + t * plotW.value;
}

// 每段一個 rect:x=累積分鐘,y=hrMax..hrMin band
const rects = computed(() => {
  const out: { x: number; y: number; w: number; h: number; fill: string; seg: PlanSegment }[] = [];
  let acc = 0;
  for (const seg of props.segments) {
    const x0 = xOfMin(acc);
    const x1 = xOfMin(acc + seg.durationMin);
    const yTop = yOf(seg.hrMax);
    const yBot = yOf(seg.hrMin);
    out.push({
      x: x0,
      y: yTop,
      w: Math.max(1, x1 - x0 - GAP),
      h: Math.max(2, yBot - yTop),
      fill: segVar(seg.type),
      seg,
    });
    acc += seg.durationMin;
  }
  return out;
});

// 3–4 條 recessive gridline + bpm 刻度
const yTicks = computed(() => {
  const { min, max } = yDomain.value;
  const span = max - min;
  const steps = [10, 15, 20, 25, 50];
  const raw = span / 4;
  let step = steps[steps.length - 1];
  for (const s of steps) {
    if (s >= raw) {
      step = s;
      break;
    }
  }
  const start = Math.ceil(min / step) * step;
  const out: { v: number; y: number }[] = [];
  for (let v = start; v <= max; v += step) out.push({ v, y: yOf(v) });
  return out;
});

// x 軸每 10 或 15 分一刻度(依總長選)
const xTicks = computed(() => {
  const tot = totalMin.value;
  if (tot <= 0) return [];
  const step = tot > 75 ? 15 : 10;
  const out: { m: number; x: number }[] = [];
  for (let m = 0; m <= tot + 1e-6; m += step) out.push({ m: Math.round(m), x: xOfMin(m) });
  return out;
});

// actual HR 折線 points:x=tMs→分鐘(clamp 進圖內),y=bpm
const actualPoints = computed(() => {
  const a = props.actual;
  if (!a || !a.hrTrack?.length || totalMin.value <= 0) return null;
  const right = PAD.left + plotW.value;
  const pts = a.hrTrack.map((p) => {
    const x = Math.min(right, xOfMin(p.tMs / 60000));
    return `${x.toFixed(1)},${yOf(p.hr).toFixed(1)}`;
  });
  return pts.join(' ');
});

// ── tooltip ──
const tip = ref<{ x: number; y: number; text: string } | null>(null);
function tipText(seg: PlanSegment): string {
  const parts = [`${SEG_LABEL[seg.type]} ${seg.durationMin}min`, `HR ${seg.hrMin}–${seg.hrMax}`];
  if (seg.cadenceRpm) parts.push(`${seg.cadenceRpm}rpm`);
  return parts.join(' · ');
}
function localXY(e: MouseEvent): { x: number; y: number } {
  const host = rootRef.value?.querySelector('.segprof__chart') as HTMLElement | null;
  const rect = host?.getBoundingClientRect();
  return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
}
function showTip(i: number, e: MouseEvent) {
  const seg = rects.value[i]?.seg;
  if (!seg) return;
  const { x, y } = localXY(e);
  tip.value = { x, y, text: tipText(seg) };
}
function moveTip(e: MouseEvent) {
  if (!tip.value) return;
  const { x, y } = localXY(e);
  tip.value = { ...tip.value, x, y };
}
function hideTip() {
  tip.value = null;
}
</script>

<style scoped>
/* ── compact:day cell 色塊 band ── */
.segprof__compact {
  display: flex;
  width: 100%;
  height: 100%;
  /* 塞進 flex day cell 時 height:100% 可能塌成 0,給個下限確保色塊可見 */
  min-height: 22px;
  gap: 1px;
  border-radius: 2px;
  overflow: hidden;
}
.segprof__band {
  min-width: 0;
}

/* ── 完整模式 ── */
.segprof {
  width: 100%;
}
.segprof__chart {
  position: relative;
  width: 100%;
}
.segprof__chart svg {
  display: block;
  width: 100%;
}

/* recessive grid/軸線:細線走 border token */
.segprof__grid {
  stroke: var(--hud-border);
  stroke-width: 1;
}
/* 軸文字一律 text token,不穿 series 色 */
.segprof__axtext {
  fill: var(--hud-text-dim);
  font-size: 10px;
  font-family: var(--font-body);
}

/* actual 疊線:surface 底描邊 halo + chart-actual 主線 */
.segprof__actual-halo {
  stroke: var(--surface);
  stroke-width: 4;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.segprof__actual-line {
  stroke: var(--chart-actual);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}

/* hover 命中區 */
.segprof__hits {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
}
.segprof__hit {
  position: absolute;
  top: 0;
  bottom: 0;
  pointer-events: auto;
  cursor: crosshair;
}

/* 評級徽章:文字 + 框線 */
.segprof__badge {
  position: absolute;
  top: 4px;
  right: 6px;
  font-size: 10px;
  color: var(--hud-text-bright);
  border: 1.5px solid var(--hud-border-bright);
  background: var(--surface);
  padding: 2px 6px;
  border-radius: 3px;
  letter-spacing: 0.5px;
  pointer-events: none;
}

/* tooltip */
.segprof__tip {
  position: absolute;
  transform: translate(-50%, -130%);
  padding: 4px 8px;
  font-size: 11px;
  white-space: nowrap;
  color: var(--hud-text-bright);
  background: var(--surface);
  border: 1.5px solid var(--hud-border-bright);
  border-radius: 3px;
  pointer-events: none;
  z-index: 2;
}

/* legend */
.segprof__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 6px;
  padding-left: 2px;
}
.segprof__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--hud-text-dim);
}
.segprof__swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
}
</style>
