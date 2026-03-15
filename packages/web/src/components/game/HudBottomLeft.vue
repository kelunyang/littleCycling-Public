<template>
  <div class="hud-bottom-left">
    <!-- Elevation profile (+ workout bands when applicable) -->
    <WorkoutElevationPreview
      v-if="routePoints.length > 0"
      :route-points="routePoints"
      :workout-segments="workoutSegments"
      :total-duration-ms="workoutTotalMs"
      :display-duration-ms="targetMs"
      :elapsed-ms="elapsedMs"
    />

    <!-- Info bar -->
    <div class="hud-progress">
      <!-- Workout segment info -->
      <div v-if="hasWorkout" class="workout-progress__info">
        <span class="workout-progress__segment-name">
          {{ currentSegmentName }}
        </span>
        <span v-if="currentSeg" class="workout-progress__target">
          {{ currentSeg.targetFtpPercent }}% FTP
          <font-awesome-icon icon="bolt" class="workout-progress__bolt" />
          {{ targetWatts }}W
        </span>
      </div>
      <div class="hud-progress__row">
        <span class="hud-progress__time">
          {{ formatDuration(elapsedMs) }} / {{ formatDuration(targetMs) }}
        </span>
      </div>
    </div>

    <div class="hud-lap">
      <font-awesome-icon icon="flag" />
      <span class="hud-lap__label">LAP</span>
      <span class="hud-lap__value">{{ gameStore.laps + 1 }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { RoutePoint, WorkoutSegment } from '@littlecycling/shared';
import { totalWorkoutDuration } from '@littlecycling/shared';
import { useGameStore } from '@/stores/gameStore';
import WorkoutElevationPreview from '@/components/welcome/WorkoutElevationPreview.vue';

const props = defineProps<{
  elapsedMs: number;
  routePoints: RoutePoint[];
  distanceTraveled: number;
  workoutSegments: WorkoutSegment[];
  currentSegmentIndex: number;
  targetWatts: number;
  isOnTarget: boolean;
  currentSegmentName: string;
}>();

const gameStore = useGameStore();
const targetMs = computed(() => gameStore.targetDurationMs);

const hasWorkout = computed(() => props.workoutSegments.length > 0);
const workoutTotalMs = computed(() => totalWorkoutDuration(props.workoutSegments));

const currentSeg = computed(() => {
  if (props.currentSegmentIndex < 0 || props.currentSegmentIndex >= props.workoutSegments.length) return null;
  return props.workoutSegments[props.currentSegmentIndex];
});

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}
</script>

<style scoped>
.hud-bottom-left {
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: auto;
}

.hud-progress {
  background: var(--hud-bg);
  clip-path: var(--clip-panel-sm);
  padding: 10px 14px;
  min-width: 220px;
  border: 1px solid var(--hud-border);
}


.hud-progress__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hud-progress__time {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 600;
  color: var(--hud-text-bright);
  text-shadow: 0 0 6px rgba(0, 229, 255, 0.3);
  font-variant-numeric: tabular-nums;
  letter-spacing: 1px;
}

.workout-progress__info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 10px;
  letter-spacing: 0.5px;
}

.workout-progress__segment-name {
  font-family: var(--font-display);
  font-weight: 600;
  color: var(--hud-text-bright);
  text-transform: uppercase;
  letter-spacing: 1px;
}

.workout-progress__target {
  font-family: var(--font-display);
  font-weight: 600;
  color: var(--hud-cyan);
  font-variant-numeric: tabular-nums;
}

.workout-progress__bolt {
  font-size: 9px;
  margin: 0 2px;
  opacity: 0.7;
}

.hud-lap {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  background: var(--hud-bg);
  clip-path: var(--clip-panel-sm);
  border: 1px solid var(--hud-border);
  font-size: 12px;
  color: var(--hud-cyan);
}

.hud-lap__label {
  font-family: var(--font-body);
  font-weight: 500;
  letter-spacing: 2px;
  text-transform: uppercase;
  opacity: 0.6;
}

.hud-lap__value {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 14px;
  color: var(--hud-text-bright);
  text-shadow: 0 0 6px rgba(0, 229, 255, 0.3);
}
</style>
