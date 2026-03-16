<template>
  <div class="checklist">
    <h3 class="checklist__title">
      <font-awesome-icon icon="check" />
      Ready to Ride
    </h3>

    <div class="checklist__items">
      <div v-for="item in checks" :key="item.label" class="checklist__item">
        <font-awesome-icon
          :icon="item.passed ? 'check' : 'xmark'"
          :class="item.passed ? 'checklist__icon--pass' : 'checklist__icon--fail'"
        />
        <span>{{ item.label }}</span>
      </div>
    </div>

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

    <!-- Workout mode -->
    <div class="checklist__workout">
      <label>
        <font-awesome-icon icon="bolt" />
        Workout Mode
      </label>
      <el-select
        v-model="gameStore.selectedWorkoutId"
        size="small"
        style="width: 100%;"
      >
        <el-option
          v-for="opt in workoutOptions"
          :key="opt.value"
          :value="opt.value"
          :label="opt.label"
        />
      </el-select>
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
      <div v-if="workoutPreviewSegments.length > 0" class="checklist__workout-preview">
        <div
          v-for="(seg, i) in workoutPreviewSegments"
          :key="i"
          class="checklist__workout-preview-seg"
          :style="{
            width: (seg.durationMs / settingsStore.config.training.defaultDuration * 100) + '%',
            backgroundColor: seg.color,
          }"
          :title="seg.name + ' (' + seg.targetFtpPercent + '% FTP)'"
        />
      </div>
    </div>

    <!-- Weather override -->
    <div class="checklist__weather">
      <label>
        <font-awesome-icon icon="cloud-sun" />
        Weather
      </label>
      <el-radio-group v-model="gameStore.weatherOverride" size="small">
        <el-radio-button v-for="opt in weatherOptions" :key="String(opt.value)" :value="opt.value">
          <font-awesome-icon :icon="opt.icon" />
          <span>{{ opt.label }}</span>
        </el-radio-button>
      </el-radio-group>
    </div>

    <!-- Billboard clouds toggle -->
    <div class="checklist__toggle">
      <label>
        <font-awesome-icon icon="cloud" />
        Billboard Clouds
      </label>
      <el-switch v-model="gameStore.cloudsEnabled" />
    </div>

    <!-- Glasses frame color (Three.js only) -->
    <div v-show="!isPhaser" class="checklist__frame-color">
      <label>
        <font-awesome-icon icon="glasses" />
        Frame Color
      </label>
      <el-color-picker
        v-model="gameStore.glassesFrameColor"
        :predefine="predefineColors"
        size="small"
      />
    </div>

    <!-- Glasses frame material (Three.js only) -->
    <div v-show="!isPhaser" class="checklist__frame-material">
      <label>
        <font-awesome-icon icon="cube" />
        Material
      </label>
      <el-segmented v-model="gameStore.glassesFrameMaterial" :options="materialOptions" size="small" />
    </div>

    <!-- World style (Phaser 2D only) -->
    <div v-show="isPhaser" class="checklist__frame-material">
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

    <el-button
      type="success"
      size="large"
      :disabled="!allPassed"
      @click="openComparisonDialog"
      style="margin-top: 8px;"
    >
      <font-awesome-icon icon="play" style="margin-right: 8px;" />
      Start Ride
    </el-button>

    <!-- Comparison ride picker dialog -->
    <el-dialog
      v-model="showCompareDialog"
      title=""
      width="480px"
      :close-on-click-modal="false"
      :show-close="false"
      class="compare-dialog"
      append-to-body
    >
      <template #header>
        <div class="compare-dialog__header">
          <font-awesome-icon icon="clock-rotate-left" />
          <span>Load Comparison Ride?</span>
        </div>
      </template>

      <div class="compare-dialog__body">
        <div v-if="historyRides.length === 0" class="compare-dialog__empty">
          No previous rides found.
        </div>

        <div
          v-for="ride in historyRides"
          :key="ride.id"
          class="compare-dialog__item"
          :class="{ 'compare-dialog__item--selected': comparisonStore.compareRideId === ride.id }"
          @click="toggleCompare(ride.id)"
        >
          <div class="compare-dialog__info">
            <span class="compare-dialog__date">{{ formatDate(ride.startedAt) }}</span>
            <span class="compare-dialog__stats">
              {{ formatDuration(ride.durationMs) }}
              <template v-if="ride.avgHr"> | {{ Math.round(ride.avgHr) }} bpm</template>
              <template v-if="ride.avgPowerW"> | {{ Math.round(ride.avgPowerW) }} W</template>
              <template v-if="ride.avgSpeed"> | {{ ride.avgSpeed.toFixed(1) }} km/h</template>
            </span>
          </div>
          <font-awesome-icon
            v-if="comparisonStore.compareRideId === ride.id"
            icon="check"
            class="compare-dialog__check"
          />
        </div>
      </div>

      <template #footer>
        <div class="compare-dialog__footer">
          <el-button @click="proceedWithoutComparison">
            <font-awesome-icon icon="xmark" style="margin-right: 6px;" />
            Skip
          </el-button>
          <el-button type="primary" @click="proceedToGame">
            <font-awesome-icon icon="play" style="margin-right: 6px;" />
            {{ comparisonStore.compareRideId ? 'Start with Comparison' : 'Start Ride' }}
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import dayjs from 'dayjs';
import type { Ride } from '@littlecycling/shared';
import { WORKOUT_PROFILES, WORKOUT_PROFILES_MAP, buildWorkoutSegments, isDualSidedPower } from '@littlecycling/shared';
import { useRouteStore } from '@/stores/routeStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSensorStore } from '@/stores/sensorStore';
import { useGameStore } from '@/stores/gameStore';
import { useComparisonStore } from '@/stores/comparisonStore';
import { usePlanStore } from '@/stores/planStore';
import { notifyWarn } from '@/utils/notify';

const router = useRouter();
const routeStore = useRouteStore();
const settingsStore = useSettingsStore();
const sensorStore = useSensorStore();
const gameStore = useGameStore();
const comparisonStore = useComparisonStore();
const planStore = usePlanStore();

const showCompareDialog = ref(false);
const historyRides = ref<Ride[]>([]);

const predefineColors = [
  '#1a1a1a', '#333333', '#e8e8e8',
  '#cc2222', '#1a5eaa', '#39e75f',
];

const materialOptions = [
  { label: 'Plastic', value: 'plastic' },
  { label: 'Metallic', value: 'metallic' },
  { label: 'Matte', value: 'matte' },
];

const worldStyleOptions = [
  { label: 'Plastic', value: 'plastic' },
  { label: 'Hand-drawn', value: 'cuphead' },
];

const isPhaser = computed(() => settingsStore.config.map.renderMode === 'phaser');

const phaserStyleModel = computed({
  get: () => settingsStore.config.map.phaserStyle ?? 'plastic',
  set: (val: string) => settingsStore.updateMap({ phaserStyle: val as 'plastic' | 'cuphead' }),
});

const weatherOptions = [
  { value: null, icon: 'wand-magic-sparkles', label: 'Auto' },
  { value: 'sunny', icon: 'sun', label: 'Sunny' },
  { value: 'cloudy', icon: 'cloud', label: 'Cloudy' },
  { value: 'rainy', icon: 'cloud-rain', label: 'Rainy' },
  { value: 'snowy', icon: 'snowflake', label: 'Snowy' },
];

const workoutOptions = [
  { value: 'none', label: 'Free Ride' },
  ...WORKOUT_PROFILES.map((p) => ({ value: p.id, label: p.name })),
];

const selectedWorkoutProfile = computed(() =>
  WORKOUT_PROFILES_MAP[gameStore.selectedWorkoutId] ?? null,
);

const workoutPreviewSegments = computed(() => {
  const profile = selectedWorkoutProfile.value;
  if (!profile) return [];
  return buildWorkoutSegments(profile, settingsStore.config.training.defaultDuration);
});

/** Today's active plan training sessions (filtered to training type only). */
const todayTrainingSessions = computed(() =>
  planStore.todaySessions.filter((s) => s.session.type === 'training'),
);

const mapReachable = ref(false);
const starting = ref(false);

const durationMinModel = computed({
  get: () => Math.round(settingsStore.config.training.defaultDuration / 60000),
  set: (val: number) => settingsStore.updateTraining({ defaultDuration: val * 60000 }),
});

const hasDualPower = computed(
  () => sensorStore.pwr !== null && isDualSidedPower(sensorStore.pwr)
);

const sensorConnected = computed(() => {
  return sensorStore.connected || sensorStore.hr !== null || sensorStore.sc !== null || sensorStore.pwr !== null;
});

const checks = computed(() => [
  { label: 'Route selected', passed: routeStore.hasRoute },
  { label: 'Duration set', passed: settingsStore.config.training.defaultDuration > 0 },
  { label: 'Map tiles reachable', passed: mapReachable.value },
  { label: 'Sensor connected', passed: sensorConnected.value },
]);

const allPassed = computed(() => checks.value.every((c) => c.passed));

async function fetchHistoryRides() {
  try {
    const res = await fetch('/api/rides?limit=10');
    if (res.ok) {
      const data = await res.json();
      historyRides.value = data.rides;
    }
  } catch {
    notifyWarn('Failed to load ride history');
  }
}

function openComparisonDialog() {
  comparisonStore.clear();
  fetchHistoryRides();
  showCompareDialog.value = true;
}

function toggleCompare(rideId: number) {
  if (comparisonStore.compareRideId === rideId) {
    comparisonStore.clear();
  } else {
    comparisonStore.selectRide(rideId);
  }
}

function proceedWithoutComparison() {
  comparisonStore.clear();
  showCompareDialog.value = false;
  launchGame();
}

function proceedToGame() {
  showCompareDialog.value = false;
  launchGame();
}

async function launchGame() {
  if (starting.value) return;
  starting.value = true;

  try {
    const route = routeStore.activeRoute;
    const res = await fetch('/api/live/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routeId: route?.id,
        routeName: route?.name,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      gameStore.currentRideId = data.rideId;
    }
  } catch {
    notifyWarn('Sensor recording unavailable');
  }

  // Inject plan segments if an active plan has training for today
  const todayTraining = todayTrainingSessions.value[0];
  if (todayTraining) {
    gameStore.planDaySegments = todayTraining.session.segments;
  }

  gameStore.startGame(settingsStore.config.training.defaultDuration);
  router.push('/game');
  starting.value = false;
}

function formatDate(tsEpoch: number): string {
  return dayjs(tsEpoch).format('YYYY-MM-DD HH:mm');
}

function formatDuration(ms?: number): string {
  if (!ms) return '--:--';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function checkMapReachable() {
  try {
    const res = await fetch('https://tiles.openfreemap.org/styles/liberty', {
      method: 'HEAD',
      mode: 'no-cors',
    });
    mapReachable.value = true;
  } catch {
    mapReachable.value = false;
  }
}

let mapCheckTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  checkMapReachable();
  // Retry every 10s until map tiles are reachable
  mapCheckTimer = setInterval(() => {
    if (!mapReachable.value) checkMapReachable();
  }, 10000);
});

onUnmounted(() => {
  if (mapCheckTimer) {
    clearInterval(mapCheckTimer);
    mapCheckTimer = null;
  }
});
</script>

<style scoped>
.checklist {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.checklist__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 2px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--hud-border);
  text-shadow: 0 0 10px rgba(0,229,255,0.3);
}

.checklist__items {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.checklist__item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.checklist__icon--pass {
  color: var(--zone-3);
  filter: drop-shadow(0 0 4px rgba(0,255,136,0.6));
}

.checklist__icon--fail {
  color: var(--accent-danger);
  filter: drop-shadow(0 0 4px rgba(255,45,107,0.6));
}

.checklist__plan-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: rgba(0, 229, 255, 0.08);
  border: 1px solid rgba(0, 229, 255, 0.2);
  font-size: 10px;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

.checklist__duration {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
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

.checklist__workout-preview {
  display: flex;
  height: 8px;
  border: 1px solid var(--hud-border);
  overflow: hidden;
}

.checklist__workout-preview-seg {
  height: 100%;
  min-width: 2px;
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

.checklist__weather :deep(.el-radio-button__inner) {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  font-size: 10px;
  border-radius: 0;
  font-family: var(--font-display);
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.checklist__weather :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background: rgba(0,229,255,0.15);
  border-color: var(--hud-cyan);
  box-shadow: var(--hud-glow-cyan);
  color: var(--hud-cyan);
}

.checklist__frame-color {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
}

.checklist__frame-material {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
}

.checklist__frame-material :deep(.el-segmented) {
  --el-border-radius-base: 0;
  background: transparent;
  border: 1px solid var(--hud-border);
}

.checklist__frame-material :deep(.el-segmented__item) {
  font-family: var(--font-display);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--hud-text);
}

.checklist__frame-material :deep(.el-segmented__item-selected) {
  background: rgba(0,229,255,0.15);
  border-radius: 0;
  box-shadow: var(--hud-glow-cyan);
}

.checklist__frame-material :deep(.el-segmented__item.is-selected) {
  color: var(--hud-cyan);
}

/* Start Ride button — pulsing neon */
.checklist :deep(.el-button--success) {
  background: rgba(0,229,255,0.1);
  color: var(--hud-cyan);
  border: 1px solid var(--hud-cyan);
  border-radius: 0;
  clip-path: var(--clip-panel-sm);
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 2px;
  text-shadow: 0 0 8px rgba(0,229,255,0.4);
  animation: neon-pulse-border 2s ease-in-out infinite;
  transition: background 0.2s;
}

.checklist :deep(.el-button--success:hover) {
  background: rgba(0,229,255,0.2);
}

.checklist :deep(.el-button--success.is-disabled) {
  opacity: 0.3;
  animation: none;
  filter: none;
}

/* Comparison dialog */
.compare-dialog__header {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 2px;
  text-shadow: 0 0 10px rgba(0,229,255,0.3);
}

.compare-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 300px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(0,229,255,0.3) transparent;
}

.compare-dialog__empty {
  font-size: 12px;
  color: var(--hud-text);
  opacity: 0.6;
  text-align: center;
  padding: 20px 0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.compare-dialog__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: rgba(0,229,255,0.02);
  border: 1px solid var(--hud-border);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  font-size: 12px;
}

.compare-dialog__item:hover {
  background: rgba(0,229,255,0.06);
  border-color: rgba(0,229,255,0.3);
}

.compare-dialog__item--selected {
  background: rgba(0,229,255,0.1);
  border-color: var(--hud-cyan);
  box-shadow: 0 0 8px rgba(0,229,255,0.2);
}

.compare-dialog__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.compare-dialog__date {
  color: var(--hud-text-bright);
  font-family: var(--font-display);
  font-weight: 600;
  letter-spacing: 0.5px;
}

.compare-dialog__stats {
  color: var(--hud-text);
  opacity: 0.7;
  font-size: 10px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.compare-dialog__check {
  color: var(--zone-3);
  font-size: 16px;
  filter: drop-shadow(0 0 4px rgba(0,255,136,0.6));
}

.compare-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
