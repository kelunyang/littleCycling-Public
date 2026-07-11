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
  gap: 8px;
}

.cal-month__header {
  text-align: center;
  padding-bottom: 8px;
  border-bottom: 1.5px solid var(--hud-border-bright);
}

.cal-month__title {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  color: var(--hud-cyan);
  letter-spacing: 1.5px;
}

.cal-month__weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
  text-align: center;
}

.cal-month__wd {
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--hud-text);
  text-transform: uppercase;
  letter-spacing: 1px;
  padding: 4px 0;
}

.cal-month__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}

.cal-month__cell {
  position: relative;
  aspect-ratio: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--accent-soft);
  border: 1.5px solid var(--hud-border);
  border-radius: var(--card-radius-sm);
  cursor: pointer;
  transition: all 0.15s;
  min-height: 44px;
}

.cal-month__cell--empty {
  background: transparent;
  border-color: transparent;
  cursor: default;
}

.cal-month__cell:not(.cal-month__cell--empty):not(.cal-month__cell--future):hover {
  background: var(--accent-tint);
  border-color: var(--hud-border-bright);
}

.cal-month__cell--has-rides {
  background: var(--accent-tint);
  border-color: var(--hud-border-bright);
}

.cal-month__cell--selected {
  background: var(--accent-hover) !important;
  border: 2px solid var(--hud-cyan) !important;
  box-shadow: var(--hud-glow-cyan);
}

.cal-month__cell--today {
  border-color: var(--hud-yellow);
}

.cal-month__cell--today .cal-month__day-num {
  color: var(--hud-yellow);
}

.cal-month__cell--future {
  opacity: 0.45;
  cursor: default;
}

.cal-month__day-num {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  color: var(--hud-text-bright);
}

.cal-month__plan-dot {
  position: absolute;
  bottom: 3px;
  left: 3px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1.5px solid var(--hud-border-bright);
}

.cal-month__plan-dot--training {
  background: #66bb6a;
}

.cal-month__plan-dot--rest {
  background: #999;
}

.cal-month__plan-dot--done {
  background: var(--hud-cyan);
}

.cal-month__badge {
  position: absolute;
  bottom: 3px;
  right: 3px;
  min-width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--hud-cyan);
  color: var(--hud-text-bright);
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  border: 1.5px solid var(--hud-border-bright);
  border-radius: 9px;
  padding: 0 4px;
}
</style>
