<template>
  <div class="checklist">
    <!-- Plan indicator -->
    <div v-if="todayTrainingSessions.length > 0" class="checklist__plan-tag">
      <font-awesome-icon icon="clipboard-list" />
      <span v-for="s in todayTrainingSessions" :key="s.plan.id">
        {{ s.plan.name }} Day {{ s.day }} ({{ s.session.durationMin }} min)
      </span>
    </div>

    <!-- Duration picker -->
    <div class="checklist__duration">
      <label>
        <font-awesome-icon icon="clock" />
        Duration (min)
      </label>
      <el-input-number
        v-model="durationMinModel"
        :min="1"
        :max="300"
        size="small"
        controls-position="right"
      />
    </div>

    <!-- Ride type -->
    <div class="checklist__workout">
      <label>
        <font-awesome-icon icon="bolt" />
        Ride Type
      </label>
      <el-segmented
        v-model="gameStore.selectedWorkoutId"
        :options="workoutOptions"
        size="small"
      />
      <!-- Random events toggle (freeride only) -->
      <div v-if="gameStore.selectedWorkoutId === 'none'" class="checklist__toggle checklist__toggle--indent">
        <label>
          <font-awesome-icon icon="dice" />
          Random Events
        </label>
        <el-switch v-model="gameStore.randomEventsEnabled" />
      </div>
      <div v-if="selectedWorkoutProfile" class="checklist__workout-desc">
        {{ selectedWorkoutProfile.description }}
      </div>
    </div>

    <!-- Weather override -->
    <div class="checklist__weather">
      <label>
        <font-awesome-icon icon="cloud-sun" />
        Weather
      </label>
      <el-segmented
        v-model="gameStore.weatherOverride"
        :options="weatherOptions"
        size="small"
      />
    </div>

    <!-- Billboard clouds toggle -->
    <div class="checklist__toggle">
      <label>
        <font-awesome-icon icon="cloud" />
        Billboard Clouds
      </label>
      <el-switch v-model="gameStore.cloudsEnabled" />
    </div>

    <!-- Glasses lens — works in both Phaser 2D and Three.js modes -->
    <div class="checklist__frame-material">
      <label>
        <font-awesome-icon icon="glasses" />
        Lens
      </label>
      <el-segmented v-model="gameStore.glassesLens" :options="lensOptions" size="small" />
    </div>

    <!-- Glasses frame color -->
    <div class="checklist__frame-color">
      <label>
        <font-awesome-icon icon="glasses" />
        Frame Color
      </label>
      <el-segmented v-model="frameColorMode" :options="frameColorOptions" size="small" />
    </div>

    <!-- Glasses frame material -->
    <div class="checklist__frame-material">
      <label>
        <font-awesome-icon icon="cube" />
        Material
      </label>
      <el-segmented v-model="gameStore.glassesFrameMaterial" :options="materialOptions" size="small" />
    </div>

    <!-- World style — drives both the Phaser 2D visuals and the welcome theme. -->
    <div class="checklist__frame-material">
      <label>
        <font-awesome-icon icon="paintbrush" />
        World Style
      </label>
      <el-segmented v-model="phaserStyleModel" :options="worldStyleOptions" size="small" />
    </div>

    <!-- Free roam toggle (only if dual-sided power detected) -->
    <div v-if="hasDualPower" class="checklist__toggle">
      <label>
        <font-awesome-icon icon="arrows-left-right" />
        Free Roam
      </label>
      <el-switch v-model="gameStore.freeRoam" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { WORKOUT_PROFILES, WORKOUT_PROFILES_MAP, isDualSidedPower } from '@littlecycling/shared';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSensorStore } from '@/stores/sensorStore';
import { useGameStore, type FrameColorMode } from '@/stores/gameStore';
import { usePlanStore } from '@/stores/planStore';

const settingsStore = useSettingsStore();
const sensorStore = useSensorStore();
const gameStore = useGameStore();
const planStore = usePlanStore();

const frameColorOptions = [
  { label: 'Black', value: 'black' },
  { label: 'White', value: 'white' },
  { label: 'Gray', value: 'gray' },
  { label: 'Red', value: 'red' },
  { label: 'Yellow', value: 'yellow' },
  { label: 'Random', value: 'random' },
];

const frameColorMode = computed({
  get: () => gameStore.glassesFrameColorMode,
  set: (val: FrameColorMode) => gameStore.setFrameColorMode(val),
});

const materialOptions = [
  { label: 'Plastic', value: 'plastic' },
  { label: 'Metallic', value: 'metallic' },
  { label: 'Matte', value: 'matte' },
];

const lensOptions = [
  { label: 'Clear', value: 'clear' },
  { label: 'Dark', value: 'dark' },
  { label: 'Red', value: 'red' },
  { label: 'Yellow', value: 'yellow' },
  { label: 'Auto', value: 'auto' },
];

const worldStyleOptions = [
  { label: 'Plastic', value: 'plastic' },
  { label: 'Hand-drawn', value: 'cuphead' },
];

const phaserStyleModel = computed({
  get: () => settingsStore.config.map.phaserStyle ?? 'plastic',
  set: (val: string) => settingsStore.updateMap({ phaserStyle: val as 'plastic' | 'cuphead' }),
});

const weatherOptions = [
  { value: null, label: 'Auto' },
  { value: 'sunny', label: 'Sunny' },
  { value: 'cloudy', label: 'Cloudy' },
  { value: 'rainy', label: 'Rainy' },
  { value: 'snowy', label: 'Snowy' },
];

const workoutOptions = [
  { value: 'none', label: 'Free Ride' },
  ...WORKOUT_PROFILES.map((p) => ({ value: p.id, label: p.name })),
];

const selectedWorkoutProfile = computed(() =>
  WORKOUT_PROFILES_MAP[gameStore.selectedWorkoutId] ?? null,
);

/** Today's active plan training sessions (filtered to training type only). */
const todayTrainingSessions = computed(() =>
  planStore.todaySessions.filter((s) => s.session.type === 'training'),
);

const durationMinModel = computed({
  get: () => Math.round(settingsStore.config.training.defaultDuration / 60000),
  set: (val: number) => settingsStore.updateTraining({ defaultDuration: val * 60000 }),
});

const hasDualPower = computed(
  () => sensorStore.pwr !== null && isDualSidedPower(sensorStore.pwr)
);
</script>

<style scoped>
.checklist {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.checklist__plan-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: rgba(var(--accent-rgb), 0.08);
  border: 1.5px solid rgba(var(--accent-rgb), 0.2);
  font-size: 10px;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.checklist__duration {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}

.checklist__duration :deep(.el-input-number) {
  flex: 1;
  width: auto;
  border: 1.5px solid var(--hud-border);
  border-radius: var(--card-radius-sm);
  background: var(--accent-soft);
  height: 38px;
  line-height: 38px;
}

.checklist__duration :deep(.el-input-number .el-input__wrapper) {
  background: transparent !important;
  box-shadow: none !important;
  border: none;
  padding: 0;
}

.checklist__duration :deep(.el-input-number .el-input__inner) {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  color: var(--hud-text-bright);
  text-align: center;
  height: 38px;
  line-height: 38px;
}

.checklist__duration :deep(.el-input-number__decrease),
.checklist__duration :deep(.el-input-number__increase) {
  background: var(--accent-tint) !important;
  color: var(--hud-cyan) !important;
  border-color: var(--hud-border) !important;
  width: 32px;
  font-size: 14px;
}

.checklist__duration :deep(.el-input-number__decrease:hover),
.checklist__duration :deep(.el-input-number__increase:hover) {
  background: var(--accent-hover) !important;
  color: var(--hud-cyan) !important;
}

.checklist__workout {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
}

.checklist__workout-desc {
  font-size: 10px;
  color: var(--hud-text);
  opacity: 0.6;
  line-height: 1.4;
}

.checklist__duration label,
.checklist__weather label,
.checklist__workout label,
.checklist__toggle label,
.checklist__frame-color label,
.checklist__frame-material label {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  font-family: var(--font-display);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--hud-cyan);
  opacity: 0.8;
}

.checklist__toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
}

.checklist__toggle--indent {
  margin-top: 2px;
  padding-left: 4px;
}

.checklist__weather {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
}

.checklist__weather,
.checklist__frame-color,
.checklist__frame-material,
.checklist__workout {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.checklist__weather :deep(.el-segmented),
.checklist__workout :deep(.el-segmented),
.checklist__frame-color :deep(.el-segmented),
.checklist__frame-material :deep(.el-segmented) {
  --el-border-radius-base: var(--card-radius-sm);
  background: transparent;
  border: 1.5px solid var(--hud-border);
  border-radius: var(--card-radius-sm);
  width: 100%;
}

/* Allow many ride-type chips to wrap across two rows in narrow viewports. */
.checklist__workout :deep(.el-segmented__group),
.checklist__weather :deep(.el-segmented__group) {
  flex-wrap: wrap;
}

.checklist__weather :deep(.el-segmented__item),
.checklist__workout :deep(.el-segmented__item),
.checklist__frame-color :deep(.el-segmented__item),
.checklist__frame-material :deep(.el-segmented__item) {
  font-family: var(--font-display);
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--hud-text);
  padding: 8px 14px;
}

.checklist__weather :deep(.el-segmented__item-selected),
.checklist__workout :deep(.el-segmented__item-selected),
.checklist__frame-color :deep(.el-segmented__item-selected),
.checklist__frame-material :deep(.el-segmented__item-selected) {
  background: rgba(var(--accent-rgb), 0.15);
  border-radius: var(--card-radius-sm);
  box-shadow: var(--hud-glow-cyan);
}

.checklist__weather :deep(.el-segmented__item.is-selected),
.checklist__workout :deep(.el-segmented__item.is-selected),
.checklist__frame-color :deep(.el-segmented__item.is-selected),
.checklist__frame-material :deep(.el-segmented__item.is-selected) {
  color: var(--hud-cyan);
}
</style>
