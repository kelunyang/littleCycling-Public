<template>
  <Transition name="event-bar">
    <div v-if="isEventActive && activeEvent" class="hud-event-bar" :style="barStyle">
      <!-- Event icon + name -->
      <div class="event-bar__header">
        <font-awesome-icon :icon="activeEvent.icon" class="event-bar__icon" />
        <span class="event-bar__name">{{ activeEvent.name }}</span>
        <span v-if="targetWatts > 0" class="event-bar__target">
          <font-awesome-icon icon="bolt" class="event-bar__bolt" />
          {{ targetWatts }}W
        </span>
        <span v-if="targetCadence" class="event-bar__target">
          <font-awesome-icon icon="rotate" class="event-bar__bolt" />
          {{ targetCadence }} rpm
        </span>
      </div>

      <!-- Progress bar -->
      <div class="event-bar__track">
        <div class="event-bar__fill" :style="fillStyle" />
      </div>

      <!-- Time remaining + on-target indicator -->
      <div class="event-bar__footer">
        <span class="event-bar__time">{{ remainingText }}</span>
        <span class="event-bar__status" :class="{ 'event-bar__status--on': isOnTarget }">
          <font-awesome-icon :icon="isOnTarget ? 'circle-check' : 'circle-xmark'" />
          {{ isOnTarget ? 'ON TARGET' : 'OFF TARGET' }}
        </span>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { RandomEventDef } from '@littlecycling/shared';

const props = defineProps<{
  isEventActive: boolean;
  activeEvent: RandomEventDef | null;
  eventElapsedMs: number;
  eventProgress: number;
  targetWatts: number;
  targetCadence: number | null;
  isOnTarget: boolean;
}>();

const barStyle = computed(() => {
  const color = props.activeEvent?.color ?? 'var(--hud-cyan)';
  return { '--event-color': color };
});

const fillStyle = computed(() => ({
  width: `${Math.min(100, props.eventProgress * 100)}%`,
}));

const remainingText = computed(() => {
  if (!props.activeEvent) return '';
  const remainMs = Math.max(0, props.activeEvent.durationMs - props.eventElapsedMs);
  const sec = Math.ceil(remainMs / 1000);
  return `${sec}s`;
});
</script>

<style scoped>
.hud-event-bar {
  background: var(--hud-bg);
  clip-path: var(--clip-panel-sm);
  border: 1px solid var(--event-color, var(--hud-cyan));
  padding: 10px 14px;
  min-width: 240px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.event-bar__header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.event-bar__icon {
  color: var(--event-color, var(--hud-cyan));
  font-size: 14px;
  filter: drop-shadow(0 0 4px var(--event-color, var(--hud-cyan)));
}

.event-bar__name {
  font-family: var(--font-display);
  font-weight: 700;
  color: var(--hud-text-bright);
  text-transform: uppercase;
  letter-spacing: 1px;
  flex: 1;
}

.event-bar__target {
  font-family: var(--font-display);
  font-weight: 600;
  color: var(--event-color, var(--hud-cyan));
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

.event-bar__bolt {
  font-size: 9px;
  margin-right: 2px;
  opacity: 0.7;
}

.event-bar__track {
  height: 6px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  overflow: hidden;
}

.event-bar__fill {
  height: 100%;
  background: var(--event-color, var(--hud-cyan));
  border-radius: 3px;
  transition: width 0.3s linear;
  box-shadow: 0 0 8px var(--event-color, var(--hud-cyan));
}

.event-bar__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10px;
}

.event-bar__time {
  font-family: var(--font-display);
  font-weight: 600;
  color: var(--hud-text-bright);
  font-variant-numeric: tabular-nums;
  letter-spacing: 1px;
}

.event-bar__status {
  font-family: var(--font-display);
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--hud-magenta);
  transition: color 0.2s;
}

.event-bar__status--on {
  color: var(--hud-cyan);
  text-shadow: 0 0 6px rgba(0, 229, 255, 0.4);
}

/* Transition */
.event-bar-enter-active {
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.event-bar-leave-active {
  transition: all 0.2s ease-in;
}
.event-bar-enter-from {
  opacity: 0;
  transform: translateY(20px) scale(0.9);
}
.event-bar-leave-to {
  opacity: 0;
  transform: translateY(-10px) scale(0.95);
}
</style>
