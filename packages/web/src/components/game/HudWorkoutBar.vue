<template>
  <Transition name="workout-bar">
    <div v-if="theme && targetWatts > 0" :key="segmentIndex" class="hud-workout-bar" :style="barStyle">
      <!-- Theme header: story name + real segment name + flavor hint -->
      <div class="workout-bar__header">
        <font-awesome-icon :icon="theme.icon" class="workout-bar__icon" />
        <span class="workout-bar__name">{{ theme.name }}</span>
        <span class="workout-bar__segment">{{ segmentName }}</span>
        <span v-if="powerSource === 'estimated'" class="workout-bar__badge">估算功率</span>
      </div>
      <div class="workout-bar__hint-line">{{ theme.hint }}</div>

      <!-- Needle gauge: current effective watts vs target -->
      <PowerGauge
        :target="targetWatts"
        :current="currentWatts"
        :tolerance="0.10"
        unit="W"
        :color="theme.color"
      />

      <!-- Optional cadence target -->
      <div v-if="targetCadence" class="workout-bar__cadence">
        <font-awesome-icon icon="rotate" />
        目標踏頻 {{ targetCadence }} rpm
        <span v-if="currentCadence != null" class="workout-bar__cadence-now">
          （現在 {{ Math.round(currentCadence) }}）
        </span>
      </div>

      <!-- Footer: segment countdown + on-target status -->
      <div class="workout-bar__footer">
        <span class="workout-bar__time">
          <font-awesome-icon icon="clock" />
          撐過 {{ remainingText }}
        </span>
        <span class="workout-bar__status" :class="{ 'workout-bar__status--on': isOnTarget }">
          <font-awesome-icon :icon="isOnTarget ? 'circle-check' : 'circle-xmark'" />
          {{ isOnTarget ? 'ON TARGET' : 'OFF TARGET' }}
        </span>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { SegmentTheme } from '@littlecycling/shared';
import PowerGauge from './PowerGauge.vue';

const props = defineProps<{
  theme: SegmentTheme | null;
  segmentName: string;
  /** Keyed on the panel so segment changes replay the enter transition. */
  segmentIndex: number;
  targetWatts: number;
  /** Effective watts (meter first, else server trainer-curve estimate). */
  currentWatts: number;
  powerSource: 'meter' | 'estimated';
  targetCadence?: number;
  currentCadence?: number | null;
  remainingMs: number;
  isOnTarget: boolean;
}>();

const barStyle = computed(() => ({
  '--workout-color': props.theme?.color ?? 'var(--hud-cyan)',
}));

const remainingText = computed(() => {
  const totalSec = Math.max(0, Math.ceil(props.remainingMs / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
});
</script>

<style scoped>
.hud-workout-bar {
  background: var(--hud-bg);
  clip-path: var(--clip-panel-sm);
  border: 1.5px solid var(--workout-color, var(--hud-cyan));
  padding: 10px 16px 8px;
  min-width: 300px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.workout-bar__header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.workout-bar__icon {
  color: var(--workout-color);
  font-size: 16px;
  filter: drop-shadow(0 0 4px var(--workout-color));
}

.workout-bar__name {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 14px;
  color: var(--hud-text-bright);
  letter-spacing: 2px;
  text-shadow: 0 0 8px var(--workout-color);
}

.workout-bar__segment {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 10px;
  color: var(--hud-text-bright);
  opacity: 0.55;
  text-transform: uppercase;
  letter-spacing: 1px;
  flex: 1;
}

.workout-bar__badge {
  font-family: var(--font-body);
  font-size: 9px;
  letter-spacing: 1px;
  color: #ffab00;
  border: 1px solid rgba(255, 171, 0, 0.5);
  border-radius: 2px;
  padding: 1px 5px;
  white-space: nowrap;
}

.workout-bar__hint-line {
  font-family: var(--font-body);
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--hud-text-bright);
  opacity: 0.6;
}

.workout-bar__cadence {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-family: var(--font-body);
  font-size: 10px;
  letter-spacing: 1px;
  color: var(--hud-cyan);
  font-variant-numeric: tabular-nums;
}

.workout-bar__cadence-now {
  opacity: 0.7;
}

.workout-bar__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10px;
  margin-top: 2px;
}

.workout-bar__time {
  display: flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-display);
  font-weight: 600;
  color: var(--hud-text-bright);
  font-variant-numeric: tabular-nums;
  letter-spacing: 1px;
}

.workout-bar__status {
  font-family: var(--font-display);
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--hud-magenta);
  transition: color 0.2s;
}

.workout-bar__status--on {
  color: #00e676;
  text-shadow: 0 0 6px rgba(0, 230, 118, 0.4);
}

/* Transition — replayed on each segment change (:key) */
.workout-bar-enter-active {
  transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.workout-bar-leave-active {
  transition: all 0.2s ease-in;
  position: absolute;
}
.workout-bar-enter-from {
  opacity: 0;
  transform: translateY(24px) scale(0.85);
}
.workout-bar-leave-to {
  opacity: 0;
  transform: translateY(-12px) scale(0.95);
}
</style>
