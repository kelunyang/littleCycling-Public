<template>
  <div ref="rootRef" class="ramp">
    <div class="ramp__chart">
      <svg
        v-if="width > 0"
        :width="width"
        :height="RAMP_H"
        :viewBox="`0 0 ${width} ${RAMP_H}`"
        role="img"
        aria-label="每週訓練分鐘數堆疊圖"
      >
        <!-- recessive gridline + 分鐘刻度 -->
        <g>
          <line
            v-for="t in yTicks"
            :key="'g' + t.v"
            :x1="PAD.left"
            :x2="width - PAD.right"
            :y1="t.y"
            :y2="t.y"
            class="ramp__grid"
          />
          <text
            v-for="t in yTicks"
            :key="'yl' + t.v"
            :x="PAD.left - 5"
            :y="t.y + 3"
            text-anchor="end"
            class="ramp__axtext"
          >{{ t.v }}</text>
        </g>

        <!-- 每週一根堆疊 bar -->
        <g v-for="col in columns" :key="col.week">
          <!-- 目前頁週的 ring -->
          <rect
            v-if="col.isCurrent"
            :x="col.x - 2"
            :y="col.topY - 2"
            :width="col.w + 4"
            :height="plotBottom - col.topY + 4"
            fill="none"
            class="ramp__ring"
            rx="2"
          />
          <rect
            v-for="(s, si) in col.stacks"
            :key="si"
            :x="col.x"
            :y="s.y"
            :width="col.w"
            :height="s.h"
            :fill="s.fill"
            rx="1"
          />
          <!-- selective 總分鐘標籤 -->
          <text
            v-if="col.showLabel"
            :x="col.x + col.w / 2"
            :y="col.topY - 4"
            text-anchor="middle"
            class="ramp__axtext"
          >{{ col.total }}</text>
        </g>
      </svg>

      <!-- hover / click 命中區 -->
      <div v-if="width > 0" class="ramp__hits">
        <div
          v-for="col in columns"
          :key="'h' + col.week"
          class="ramp__hit"
          :style="{ left: col.x + 'px', width: col.w + 'px' }"
          @mouseenter="showTip(col.idx, $event)"
          @mousemove="moveTip($event)"
          @mouseleave="hideTip"
          @click="emit('select', col.idx)"
        />
      </div>

      <!-- tooltip -->
      <div
        v-if="tip"
        class="ramp__tip"
        :style="{ left: tip.x + 'px', top: tip.y + 'px' }"
      >
        <div class="ramp__tip-head">W{{ tip.week }} · {{ tip.focus }}</div>
        <div v-for="row in tip.rows" :key="row.label" class="ramp__tip-row">
          <span class="ramp__swatch" :style="{ background: row.color }" />
          {{ row.label }} {{ row.min }}min
        </div>
      </div>
    </div>

    <!-- legend(與 profile 同款樣式)-->
    <div class="ramp__legend">
      <span v-for="l in LEGEND_DEFS" :key="l.label" class="ramp__legend-item">
        <span class="ramp__swatch" :style="{ background: l.color }" />
        {{ l.label }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import type { PlanWeek, SegmentType } from '@littlecycling/shared';

const props = defineProps<{
  weeks: PlanWeek[];
  /** 目前頁週的 0-based index(對映 PresetDrawer 的 weekPage)。 */
  currentWeek: number;
}>();
const emit = defineEmits<{ select: [weekIndex: number] }>();

// warmup/cooldown 同色合併;堆疊順序 bottom→top。fill 走 chart token。
const STACK_ORDER: { types: SegmentType[]; label: string; color: string }[] = [
  { types: ['warmup', 'cooldown'], label: '熱身/收操', color: 'var(--chart-seg-warmup)' },
  { types: ['steady'], label: '穩定', color: 'var(--chart-seg-steady)' },
  { types: ['interval_work'], label: '間歇作', color: 'var(--chart-seg-work)' },
  { types: ['interval_rest'], label: '間歇歇', color: 'var(--chart-seg-rest)' },
];
const LEGEND_DEFS = STACK_ORDER;

// ── 版面 ──
const RAMP_H = 110;
const PAD = { top: 16, right: 8, bottom: 18, left: 30 };
const plotH = RAMP_H - PAD.top - PAD.bottom;
const plotBottom = PAD.top + plotH;
const STACK_GAP = 2;

const rootRef = ref<HTMLElement | null>(null);
const width = ref(0);
let ro: ResizeObserver | null = null;
onMounted(() => {
  if (rootRef.value) {
    width.value = rootRef.value.clientWidth;
    ro = new ResizeObserver(() => {
      if (rootRef.value) width.value = rootRef.value.clientWidth;
    });
    ro.observe(rootRef.value);
  }
});
onUnmounted(() => ro?.disconnect());

// 每週各 segment type 分鐘數(rest 日無 segments,自然不計)
const weekMinutes = computed(() =>
  props.weeks.map((wk) => {
    const mins = STACK_ORDER.map(() => 0);
    for (const session of wk.sessions) {
      for (const seg of session.segments) {
        const si = STACK_ORDER.findIndex((o) => o.types.includes(seg.type));
        if (si >= 0) mins[si] += seg.durationMin;
      }
    }
    return mins;
  }),
);

const maxTotal = computed(() => {
  let m = 0;
  for (const mins of weekMinutes.value) {
    const t = mins.reduce((a, b) => a + b, 0);
    if (t > m) m = t;
  }
  return m || 1;
});

const plotW = computed(() => Math.max(0, width.value - PAD.left - PAD.right));

function yOf(min: number): number {
  return PAD.top + (1 - min / maxTotal.value) * plotH;
}

const columns = computed(() => {
  const n = props.weeks.length;
  if (n === 0) return [];
  const slot = plotW.value / n;
  const barW = Math.max(6, Math.min(40, slot * 0.6));
  return props.weeks.map((wk, idx) => {
    const mins = weekMinutes.value[idx];
    const total = mins.reduce((a, b) => a + b, 0);
    const x = PAD.left + slot * idx + (slot - barW) / 2;
    // 由底往上堆
    const stacks: { y: number; h: number; fill: string }[] = [];
    let accBottom = plotBottom;
    for (let s = 0; s < mins.length; s++) {
      if (mins[s] <= 0) continue;
      const h = (mins[s] / maxTotal.value) * plotH;
      const y = accBottom - h;
      stacks.push({ y, h: Math.max(1, h - STACK_GAP), fill: STACK_ORDER[s].color });
      accBottom = y;
    }
    const topY = total > 0 ? yOf(total) : plotBottom;
    // selective:週數少全標;多則隔一標,且目前週一定標
    const showLabel = total > 0 && (n <= 6 || idx % 2 === 0 || idx === props.currentWeek);
    return {
      week: wk.week,
      idx,
      x,
      w: barW,
      stacks,
      total,
      topY,
      showLabel,
      isCurrent: idx === props.currentWeek,
    };
  });
});

const yTicks = computed(() => {
  const max = maxTotal.value;
  const steps = [10, 15, 20, 30, 60, 120];
  const raw = max / 3;
  let step = steps[steps.length - 1];
  for (const s of steps) {
    if (s >= raw) {
      step = s;
      break;
    }
  }
  const out: { v: number; y: number }[] = [];
  for (let v = 0; v <= max; v += step) out.push({ v, y: yOf(v) });
  return out;
});

// ── tooltip ──
const tip = ref<
  | { x: number; y: number; week: number; focus: string; rows: { label: string; color: string; min: number }[] }
  | null
>(null);
function localXY(e: MouseEvent): { x: number; y: number } {
  const host = rootRef.value?.querySelector('.ramp__chart') as HTMLElement | null;
  const rect = host?.getBoundingClientRect();
  return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
}
function showTip(idx: number, e: MouseEvent) {
  const wk = props.weeks[idx];
  const mins = weekMinutes.value[idx];
  if (!wk) return;
  const rows = STACK_ORDER.map((o, s) => ({ label: o.label, color: o.color, min: mins[s] })).filter(
    (r) => r.min > 0,
  );
  const { x, y } = localXY(e);
  tip.value = { x, y, week: wk.week, focus: wk.focus, rows };
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
.ramp {
  width: 100%;
}
.ramp__chart {
  position: relative;
  width: 100%;
}
.ramp__chart svg {
  display: block;
  width: 100%;
}

.ramp__grid {
  stroke: var(--hud-border);
  stroke-width: 1;
}
.ramp__axtext {
  fill: var(--hud-text-dim);
  font-size: 10px;
  font-family: var(--font-body);
}
.ramp__ring {
  stroke: var(--hud-cyan);
  stroke-width: 1.5;
}

.ramp__hits {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
}
.ramp__hit {
  position: absolute;
  top: 0;
  bottom: 0;
  pointer-events: auto;
  cursor: pointer;
}

.ramp__tip {
  position: absolute;
  transform: translate(-50%, -108%);
  padding: 5px 8px;
  font-size: 11px;
  white-space: nowrap;
  color: var(--hud-text-bright);
  background: var(--surface);
  border: 1.5px solid var(--hud-border-bright);
  border-radius: 3px;
  pointer-events: none;
  z-index: 2;
}
.ramp__tip-head {
  font-weight: 700;
  margin-bottom: 3px;
  color: var(--hud-cyan);
}
.ramp__tip-row {
  display: flex;
  align-items: center;
  gap: 5px;
}

.ramp__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 4px;
  padding-left: 2px;
}
.ramp__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--hud-text-dim);
}
.ramp__swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
}
</style>
