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

    <!-- Appearance shortcuts — weather / glasses / world collapse into three
         icon buttons; each opens its own drawer for the detailed picks. -->
    <div class="checklist__appearance">
      <button type="button" class="appearance-btn" @click="weatherOpen = true">
        <font-awesome-icon :icon="weatherIcon" class="appearance-btn__icon" />
        <span class="appearance-btn__label">Weather</span>
      </button>
      <button type="button" class="appearance-btn" @click="glassesOpen = true">
        <font-awesome-icon
          icon="glasses"
          class="appearance-btn__icon glasses-glyph"
          :style="{ color: glassesIconColor }"
        />
        <span class="appearance-btn__label">Glasses</span>
      </button>
      <button type="button" class="appearance-btn" @click="worldOpen = true">
        <font-awesome-icon :icon="worldIcon" class="appearance-btn__icon" />
        <span class="appearance-btn__label">World</span>
      </button>
    </div>

    <!-- Comparison ride toggle: when on, Start opens the comparison-ride picker -->
    <div class="checklist__toggle">
      <label>
        <font-awesome-icon icon="clock-rotate-left" />
        Comparison Ride
      </label>
      <el-switch v-model="gameStore.comparePickerEnabled" />
    </div>

    <!-- Free roam toggle (only if dual-sided power detected) -->
    <div v-if="hasDualPower" class="checklist__toggle">
      <label>
        <font-awesome-icon icon="arrows-left-right" />
        Free Roam
      </label>
      <el-switch v-model="gameStore.freeRoam" />
    </div>

    <!-- ── Weather drawer (fullscreen) ────────────────────────────── -->
    <el-drawer
      v-model="weatherOpen"
      direction="btt"
      size="100%"
      :with-header="false"
      append-to-body
      class="appearance-drawer"
    >
      <div class="appearance-drawer__header">
        <h3>
          <font-awesome-icon :icon="weatherIcon" />
          Weather
        </h3>
        <el-button circle @click="weatherOpen = false">
          <font-awesome-icon icon="xmark" />
        </el-button>
      </div>
      <div class="appearance-drawer__body">
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

        <div class="checklist__toggle">
          <label>
            <font-awesome-icon icon="cloud" />
            Billboard Clouds
          </label>
          <el-switch v-model="gameStore.cloudsEnabled" />
        </div>
      </div>
    </el-drawer>

    <!-- ── Glasses drawer (fullscreen) ────────────────────────────── -->
    <el-drawer
      v-model="glassesOpen"
      direction="btt"
      size="100%"
      :with-header="false"
      append-to-body
      class="appearance-drawer"
    >
      <div class="appearance-drawer__header">
        <h3>
          <font-awesome-icon icon="glasses" class="glasses-glyph" :style="{ color: glassesIconColor }" />
          Glasses
        </h3>
        <el-button circle @click="glassesOpen = false">
          <font-awesome-icon icon="xmark" />
        </el-button>
      </div>
      <div class="appearance-drawer__body">
        <div class="checklist__frame-material">
          <label>
            <font-awesome-icon icon="glasses" />
            Lens
          </label>
          <el-segmented v-model="gameStore.glassesLens" :options="lensOptions" size="small" />
        </div>

        <div class="checklist__frame-color">
          <label>
            <font-awesome-icon icon="glasses" />
            Frame Color
          </label>
          <el-segmented v-model="frameColorMode" :options="frameColorOptions" size="small" />
        </div>

        <div class="checklist__frame-material">
          <label>
            <font-awesome-icon icon="cube" />
            Material
          </label>
          <el-segmented v-model="gameStore.glassesFrameMaterial" :options="materialOptions" size="small" />
        </div>
      </div>
    </el-drawer>

    <!-- ── World drawer (fullscreen) ──────────────────────────────── -->
    <el-drawer
      v-model="worldOpen"
      direction="btt"
      size="100%"
      :with-header="false"
      append-to-body
      class="appearance-drawer"
    >
      <div class="appearance-drawer__header">
        <h3>
          <font-awesome-icon icon="paintbrush" />
          World
        </h3>
        <el-button circle @click="worldOpen = false">
          <font-awesome-icon icon="xmark" />
        </el-button>
      </div>
      <div class="appearance-drawer__body">
        <!-- Render mode — 3D (Three.js FPS / MapLibre) vs 2D (Phaser). Lives here
             so the mode can be picked straight from the welcome screen. -->
        <div class="checklist__frame-material">
          <label>
            <font-awesome-icon icon="cube" />
            Render Mode
          </label>
          <el-segmented v-model="renderModeModel" :options="renderModeOptions" size="small">
            <template #default="{ item }">
              <span class="segmented-item">
                <font-awesome-icon :icon="item.icon" />
                {{ item.label }}
              </span>
            </template>
          </el-segmented>
        </div>

        <!-- World style — only meaningful for the stylised renderers (Three.js /
             Phaser). MapLibre is the realistic "classic" map, so there's no style
             to choose; it just renders straight. -->
        <div v-if="renderModeModel !== 'maplibre'" class="checklist__frame-material">
          <label>
            <font-awesome-icon icon="paintbrush" />
            World Style
          </label>
          <el-segmented v-model="worldStyleModel" :options="worldStyleOptions" size="small" />
        </div>
        <p v-else class="appearance-drawer__note">
          <font-awesome-icon icon="circle-info" />
          Classic map renders realistically — no world style to pick.
        </p>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { WORKOUT_PROFILES, WORKOUT_PROFILES_MAP, isDualSidedPower, type AppConfig } from '@littlecycling/shared';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSensorStore } from '@/stores/sensorStore';
import { useGameStore, resolveLensColor, type FrameColorMode } from '@/stores/gameStore';
import { usePlanStore } from '@/stores/planStore';

const settingsStore = useSettingsStore();
const sensorStore = useSensorStore();
const gameStore = useGameStore();
const planStore = usePlanStore();

// Appearance drawers — weather / glasses / world each collapse into an icon
// button on the checklist and expand into their own drawer.
const weatherOpen = ref(false);
const glassesOpen = ref(false);
const worldOpen = ref(false);

/** Weather button icon mirrors the current override so the pick shows at a glance. */
const weatherIcon = computed(() => {
  switch (gameStore.weatherOverride) {
    case 'sunny':
      return 'sun';
    case 'cloudy':
      return 'cloud';
    case 'rainy':
      return 'cloud-rain';
    case 'snowy':
      return 'snowflake';
    default:
      return 'cloud-sun';
  }
});

/**
 * The glasses glyph is a single-colour Font Awesome path, so it can only carry
 * one of the two picks. It carries the lens — that is what you actually see the
 * world through, and 'clear' falls back to the frame colour anyway.
 */
const glassesIconColor = computed(() =>
  resolveLensColor(gameStore.glassesLens, gameStore.weatherOverride, gameStore.glassesFrameColor),
);

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

const worldStyleModel = computed({
  get: () => settingsStore.config.map.worldStyle ?? 'plastic',
  set: (val: string) => settingsStore.updateMap({ worldStyle: val as 'plastic' | 'cuphead' }),
});

const renderModeOptions = [
  { label: '3D (FPS)', value: 'threejs', icon: 'mountain-sun' },
  { label: 'Classic', value: 'maplibre', icon: 'map-location-dot' },
  { label: '2D', value: 'phaser', icon: 'chess-board' },
];

const renderModeModel = computed({
  get: () => settingsStore.config.map.renderMode,
  set: (val: AppConfig['map']['renderMode']) => settingsStore.updateMap({ renderMode: val }),
});

/** World button glyph mirrors the picked render mode, so it reads at a glance
 *  (2D → map, Classic → map-pin, 3D → mountain) instead of a static brush. */
const worldIcon = computed(
  () => renderModeOptions.find((o) => o.value === renderModeModel.value)?.icon ?? 'paintbrush',
);

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

/* Icon + label inside a segmented option (render mode picker). */
.segmented-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.segmented-item svg {
  font-size: 0.9em;
}

/* ── Appearance shortcut buttons (weather / glasses / world) ─────── */
.checklist__appearance {
  display: flex;
  gap: 10px;
}

.appearance-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px 6px;
  background: var(--accent-soft);
  border: 1.5px solid var(--hud-border);
  border-radius: var(--card-radius-sm);
  color: var(--hud-cyan);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, transform 0.15s;
}

.appearance-btn:hover {
  background: var(--accent-hover);
  border-color: var(--hud-cyan);
  transform: translateY(-1px);
}

.appearance-btn__icon {
  font-size: 22px;
}

/* Tint the glasses glyph with the chosen lens colour; a faint outline keeps the
   pale ones (clear-on-white frame, yellow) legible on any card background.
   Shared by the checklist button and the drawer title. */
.glasses-glyph {
  filter:
    drop-shadow(0.6px 0 0 rgba(128, 128, 128, 0.7))
    drop-shadow(-0.6px 0 0 rgba(128, 128, 128, 0.7))
    drop-shadow(0 0.6px 0 rgba(128, 128, 128, 0.7))
    drop-shadow(0 -0.6px 0 rgba(128, 128, 128, 0.7));
}

.appearance-btn__label {
  font-family: var(--font-display);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 1px;
  opacity: 0.85;
}

/* Fullscreen drawer header — mirrors SettingsPanel's title bar. */
.appearance-drawer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 4px 16px;
  margin-bottom: 4px;
  border-bottom: 1.5px solid var(--hud-border);
}

.appearance-drawer__header h3 {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: var(--hud-cyan);
}

/* Drawer body reuses the checklist layout for the moved segmented pickers.
   Constrain the width so controls don't stretch edge-to-edge on a full screen. */
.appearance-drawer__body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 640px;
  margin: 0 auto;
  padding-top: 8px;
}

.appearance-drawer__note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  color: var(--hud-text-dim);
  opacity: 0.8;
}
</style>
