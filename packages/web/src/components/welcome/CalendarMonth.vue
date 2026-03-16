<template>
  <div class="cal-month">
    <div class="cal-month__header">
      <span class="cal-month__title">{{ monthLabel }}</span>
    </div>

    <div class="cal-month__weekdays">
      <span v-for="d in weekdays" :key="d" class="cal-month__wd">{{ d }}</span>
    </div>

    <div class="cal-month__grid">
      <!-- Leading empty cells for offset -->
      <div v-for="_ in startOffset" :key="'e' + _" class="cal-month__cell cal-month__cell--empty" />

      <div
        v-for="day in daysInMonth"
        :key="day"
        class="cal-month__cell"
        :class="{
          'cal-month__cell--has-rides': getCount(day) > 0,
          'cal-month__cell--selected': isSelected(day),
          'cal-month__cell--today': isToday(day),
          'cal-month__cell--future': isFuture(day),
        }"
        @click="onDayClick(day)"
      >
        <span class="cal-month__day-num">{{ day }}</span>
        <span v-if="getCount(day) > 0" class="cal-month__badge">{{ getCount(day) }}</span>
        <span
          v-if="getPlanMarker(day)"
          class="cal-month__plan-dot"
          :class="`cal-month__plan-dot--${getPlanMarker(day)}`"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import dayjs from 'dayjs';

const props = defineProps<{
  year: number;
  month: number; // 0-indexed
  dayCounts: Map<string, number>;
  selectedDate: string | null;
  /** Plan day markers: dateStr → 'training' | 'rest' | 'done' */
  planMarkers?: Map<string, 'training' | 'rest' | 'done'>;
}>();

const emit = defineEmits<{
  (e: 'select-date', dateStr: string): void;
}>();

const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const monthLabel = computed(() =>
  dayjs().year(props.year).month(props.month).format('MMMM YYYY').toUpperCase()
);

const daysInMonth = computed(() =>
  dayjs().year(props.year).month(props.month).daysInMonth()
);

/** Monday-based offset: 0=Mon, 6=Sun */
const startOffset = computed(() => {
  const firstDay = dayjs().year(props.year).month(props.month).date(1).day(); // 0=Sun
  return firstDay === 0 ? 6 : firstDay - 1;
});

function dateStr(day: number): string {
  return dayjs().year(props.year).month(props.month).date(day).format('YYYY-MM-DD');
}

function getCount(day: number): number {
  return props.dayCounts.get(dateStr(day)) ?? 0;
}

function isSelected(day: number): boolean {
  return props.selectedDate === dateStr(day);
}

function isToday(day: number): boolean {
  return dateStr(day) === dayjs().format('YYYY-MM-DD');
}

function isFuture(day: number): boolean {
  return dayjs().year(props.year).month(props.month).date(day).isAfter(dayjs(), 'day');
}

function getPlanMarker(day: number): string | null {
  return props.planMarkers?.get(dateStr(day)) ?? null;
}

function onDayClick(day: number) {
  if (isFuture(day)) return;
  emit('select-date', dateStr(day));
}
</script>

<style scoped>
.cal-month {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cal-month__header {
  text-align: center;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--hud-border);
}

.cal-month__title {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  color: var(--hud-cyan);
  letter-spacing: 2px;
  text-shadow: 0 0 10px rgba(0,229,255,0.3);
}

.cal-month__weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
  text-align: center;
}

.cal-month__wd {
  font-family: var(--font-display);
  font-size: 9px;
  color: rgba(255,255,255,0.35);
  text-transform: uppercase;
  letter-spacing: 1px;
  padding: 2px 0;
}

.cal-month__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.cal-month__cell {
  position: relative;
  aspect-ratio: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(255,255,255,0.02);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
  min-height: 36px;
}

.cal-month__cell--empty {
  background: transparent;
  cursor: default;
}

.cal-month__cell:not(.cal-month__cell--empty):not(.cal-month__cell--future):hover {
  background: rgba(0,229,255,0.06);
  border-color: var(--hud-border);
}

.cal-month__cell--has-rides {
  background: rgba(0,229,255,0.05);
  border-color: rgba(0,229,255,0.15);
}

.cal-month__cell--selected {
  background: rgba(0,229,255,0.12) !important;
  border-color: var(--hud-cyan) !important;
  box-shadow: var(--hud-glow-cyan);
}

.cal-month__cell--today .cal-month__day-num {
  color: var(--hud-yellow);
  text-shadow: 0 0 6px rgba(252,238,9,0.4);
}

.cal-month__cell--future {
  opacity: 0.25;
  cursor: default;
}

.cal-month__day-num {
  font-family: var(--font-display);
  font-size: 12px;
  color: var(--hud-text);
}

.cal-month__plan-dot {
  position: absolute;
  bottom: 2px;
  left: 2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.cal-month__plan-dot--training {
  background: #66bb6a;
  box-shadow: 0 0 4px rgba(102,187,106,0.6);
}

.cal-month__plan-dot--rest {
  background: #666;
}

.cal-month__plan-dot--done {
  background: var(--hud-cyan);
  box-shadow: 0 0 4px rgba(0,229,255,0.6);
}

.cal-month__badge {
  position: absolute;
  bottom: 2px;
  right: 2px;
  min-width: 14px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--hud-cyan);
  color: #000;
  font-family: var(--font-display);
  font-size: 8px;
  font-weight: 700;
  border-radius: 7px;
  padding: 0 3px;
  box-shadow: 0 0 6px rgba(0,229,255,0.5);
}
</style>
