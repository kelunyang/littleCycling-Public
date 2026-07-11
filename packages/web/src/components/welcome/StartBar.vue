<template>
  <div class="start-bar">
    <!-- Elevation widget (collapsible) -->
    <div class="start-bar__elev">
      <button
        type="button"
        class="start-bar__elev-toggle"
        :class="{ 'start-bar__elev-toggle--expanded': elevExpanded }"
        @click="elevExpanded = !elevExpanded"
      >
        <font-awesome-icon :icon="elevExpanded ? 'chevron-down' : 'chevron-up'" />
        <span>{{ elevExpanded ? 'Collapse profile' : 'Show profile' }}</span>
      </button>

      <div v-if="elevExpanded" class="start-bar__elev-full">
        <WorkoutElevationPreview
          v-if="routeStore.activeRoute"
          :route-points="routeStore.activeRoute.points"
          :workout-segments="workoutPreviewSegments"
          :total-duration-ms="settingsStore.config.training.defaultDuration"
        />
        <div v-else class="start-bar__elev-empty">
          <font-awesome-icon icon="circle-info" />
          Select a route to preview the elevation profile
        </div>
      </div>

      <div v-else class="start-bar__elev-bar" @click="elevExpanded = true">
        <template v-if="workoutPreviewSegments.length > 0">
          <div
            v-for="(seg, i) in workoutPreviewSegments"
            :key="i"
            class="start-bar__elev-seg"
            :style="{
              width: (seg.durationMs / settingsStore.config.training.defaultDuration * 100) + '%',
              backgroundColor: seg.color,
            }"
            :title="seg.name + ' (' + seg.targetFtpPercent + '% FTP)'"
          />
        </template>
        <div v-else class="start-bar__elev-bar-empty">
          <font-awesome-icon icon="bicycle" />
          <span>{{ routeStore.activeRoute ? 'Free Ride — no segments' : 'No route selected' }}</span>
        </div>
      </div>
    </div>

    <!-- Buttons row -->
    <div class="start-bar__buttons">
      <el-button
        type="success"
        size="large"
        :disabled="!allPassed"
        class="start-bar__start"
        @click="openComparisonDialog"
      >
        <font-awesome-icon icon="play" style="margin-right: 8px;" />
        Start Ride
      </el-button>

      <el-button
        size="large"
        class="start-bar__device"
        @click="showSensorDrawer = true"
      >
        <font-awesome-icon icon="tower-broadcast" />
        <span class="start-bar__device-label">Devices</span>
        <span
          class="start-bar__device-badge"
          :class="{ 'start-bar__device-badge--zero': sensorStore.sensors.length === 0 }"
        >
          {{ sensorStore.sensors.length }}
        </span>
      </el-button>
    </div>

    <!-- Disabled reason hint -->
    <div v-if="!allPassed && disabledReason" class="start-bar__hint">
      <font-awesome-icon icon="circle-info" />
      <span>{{ disabledReason }}</span>
    </div>

    <!-- Sensor detail drawer -->
    <el-drawer
      v-model="showSensorDrawer"
      direction="rtl"
      size="320px"
      :with-header="true"
      class="sensor-drawer"
    >
      <template #header>
        <div class="sensor-drawer__header">
          <font-awesome-icon icon="tower-broadcast" />
          <span>Sensors</span>
          <span class="sensor-drawer__badge">{{ sensorStore.sensors.length }}</span>
        </div>
      </template>

      <div class="sensor-drawer__body">
        <!-- Session state + rescan -->
        <div class="sensor-drawer__state-row">
          <div class="sensor-drawer__state">
            <font-awesome-icon :icon="stateIcon" :spin="sensorStore.sessionState === 'scanning'" />
            {{ sensorStore.sessionState.toUpperCase() }}
          </div>
          <el-button
            size="small"
            :loading="rescanning"
            :disabled="rescanDisabled"
            @click="rescanSensors"
          >
            <font-awesome-icon icon="rotate" :spin="rescanning" style="margin-right: 6px;" />
            Rescan
          </el-button>
        </div>

        <!-- Host capability probe results -->
        <div class="sensor-drawer__caps">
          <div class="sensor-drawer__caps-title">
            <font-awesome-icon icon="microchip" />
            Host adapters
          </div>

          <div
            class="sensor-drawer__cap-row"
            :class="capRowClass(sensorStore.capabilities.ant)"
            :title="sensorStore.capabilities.antMessage ?? ''"
          >
            <span class="sensor-drawer__cap-label">
              <font-awesome-icon icon="tower-broadcast" /> ANT+ stick
            </span>
            <span class="sensor-drawer__cap-status">
              <font-awesome-icon
                :icon="capIcon(sensorStore.capabilities.ant)"
                :spin="sensorStore.capabilities.ant === 'unknown'"
              />
              {{ capLabel(sensorStore.capabilities.ant) }}
            </span>
          </div>
          <div
            v-if="sensorStore.capabilities.ant === 'unavailable' && sensorStore.capabilities.antMessage"
            class="sensor-drawer__cap-detail"
          >
            {{ truncateMessage(sensorStore.capabilities.antMessage) }}
          </div>

          <div
            class="sensor-drawer__cap-row"
            :class="capRowClass(sensorStore.capabilities.ble)"
            :title="sensorStore.capabilities.bleMessage ?? ''"
          >
            <span class="sensor-drawer__cap-label">
              <font-awesome-icon :icon="['fab', 'bluetooth']" /> Bluetooth
            </span>
            <span class="sensor-drawer__cap-status">
              <font-awesome-icon
                :icon="capIcon(sensorStore.capabilities.ble)"
                :spin="sensorStore.capabilities.ble === 'unknown'"
              />
              {{ capLabel(sensorStore.capabilities.ble) }}
            </span>
          </div>
          <div
            v-if="sensorStore.capabilities.ble === 'unavailable' && sensorStore.capabilities.bleMessage"
            class="sensor-drawer__cap-detail"
          >
            {{ truncateMessage(sensorStore.capabilities.bleMessage) }}
          </div>
        </div>

        <!-- Map reachability -->
        <div class="sensor-drawer__state" :class="{ 'sensor-drawer__state--warn': !mapReachable }">
          <font-awesome-icon :icon="mapReachable ? 'check' : 'triangle-exclamation'" />
          Map tiles {{ mapReachable ? 'reachable' : 'unreachable' }}
        </div>

        <!-- No sensors -->
        <div v-if="sensorStore.sensors.length === 0" class="sensor-drawer__empty">
          No sensors detected.
        </div>

        <!-- Sensor list -->
        <div v-for="sensor in sensorStore.sensors" :key="sensor.deviceId" class="sensor-drawer__card">
          <div class="sensor-drawer__card-header">
            <font-awesome-icon :icon="profileIcon(sensor.profile)" />
            <span class="sensor-drawer__profile">{{ sensor.profile }}</span>
            <span class="sensor-drawer__source">{{ sensor.source ?? 'ant' }}</span>
          </div>
          <div class="sensor-drawer__card-detail">
            Device #{{ sensor.deviceId }}
            <template v-if="sensor.name"> &middot; {{ sensor.name }}</template>
          </div>
        </div>

        <!-- Live values -->
        <div v-if="sensorStore.hr || sensorStore.sc || sensorStore.pwr" class="sensor-drawer__values">
          <div class="sensor-drawer__values-title">
            <font-awesome-icon icon="wave-square" />
            Live Values
          </div>

          <div v-if="sensorStore.hr" class="sensor-drawer__value-row">
            <span class="sensor-drawer__value-label">
              <font-awesome-icon icon="heart-pulse" /> HR
            </span>
            <span class="sensor-drawer__value-num">{{ sensorStore.hr.heartRate }} <small>bpm</small></span>
          </div>

          <div v-if="sensorStore.pwr" class="sensor-drawer__value-row">
            <span class="sensor-drawer__value-label">
              <font-awesome-icon icon="bolt" /> Power
            </span>
            <span class="sensor-drawer__value-num">{{ sensorStore.pwr.power }} <small>W</small></span>
          </div>

          <div v-if="sensorStore.pwr?.balance != null" class="sensor-drawer__value-row">
            <span class="sensor-drawer__value-label">
              <font-awesome-icon icon="arrows-left-right" /> Balance
            </span>
            <span class="sensor-drawer__value-num">{{ sensorStore.pwr.balance }}% <small>L</small></span>
          </div>

          <div v-if="sensorStore.sc" class="sensor-drawer__value-row">
            <span class="sensor-drawer__value-label">
              <font-awesome-icon icon="gauge-high" /> Speed
            </span>
            <span class="sensor-drawer__value-num">{{ sensorStore.sc.speed.toFixed(1) }} <small>km/h</small></span>
          </div>

          <div v-if="sensorStore.sc" class="sensor-drawer__value-row">
            <span class="sensor-drawer__value-label">
              <font-awesome-icon icon="rotate" /> Cadence
            </span>
            <span class="sensor-drawer__value-num">{{ sensorStore.sc.cadence }} <small>rpm</small></span>
          </div>

          <div v-if="sensorStore.pwr?.cadence != null && !sensorStore.sc" class="sensor-drawer__value-row">
            <span class="sensor-drawer__value-label">
              <font-awesome-icon icon="rotate" /> Cadence
            </span>
            <span class="sensor-drawer__value-num">{{ sensorStore.pwr.cadence }} <small>rpm</small></span>
          </div>
        </div>
      </div>
    </el-drawer>

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
import { WORKOUT_PROFILES_MAP, buildWorkoutSegments } from '@littlecycling/shared';
import { useRouteStore } from '@/stores/routeStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSensorStore } from '@/stores/sensorStore';
import { useGameStore } from '@/stores/gameStore';
import { useComparisonStore } from '@/stores/comparisonStore';
import { usePlanStore } from '@/stores/planStore';
import { notifyWarn } from '@/utils/notify';
import WorkoutElevationPreview from './WorkoutElevationPreview.vue';

const router = useRouter();
const routeStore = useRouteStore();
const settingsStore = useSettingsStore();
const sensorStore = useSensorStore();
const gameStore = useGameStore();
const comparisonStore = useComparisonStore();
const planStore = usePlanStore();

const elevExpanded = ref(false);
const showSensorDrawer = ref(false);
const showCompareDialog = ref(false);
const historyRides = ref<Ride[]>([]);
const mapReachable = ref(false);
const starting = ref(false);
const rescanning = ref(false);

const rescanDisabled = computed(() =>
  rescanning.value
  || sensorStore.sessionState === 'scanning'
  || sensorStore.sessionState === 'recording',
);

async function rescanSensors() {
  if (rescanDisabled.value) return;
  rescanning.value = true;
  try {
    const res = await fetch('/api/live/rescan', { method: 'POST' });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error) detail = String(body.error);
      } catch { /* not json */ }
      notifyWarn(`Rescan failed: ${detail}`);
    }
  } catch (err) {
    notifyWarn(`Rescan failed: ${err instanceof Error ? err.message : 'network error'}`);
  } finally {
    rescanning.value = false;
  }
}

const workoutPreviewSegments = computed(() => {
  const profile = WORKOUT_PROFILES_MAP[gameStore.selectedWorkoutId];
  if (!profile) return [];
  return buildWorkoutSegments(profile, settingsStore.config.training.defaultDuration);
});

const todayTrainingSessions = computed(() =>
  planStore.todaySessions.filter((s) => s.session.type === 'training'),
);

const allPassed = computed(() =>
  routeStore.hasRoute &&
  settingsStore.config.training.defaultDuration > 0 &&
  mapReachable.value &&
  sensorStore.sensors.length > 0,
);

const disabledReason = computed(() => {
  if (!routeStore.hasRoute) return 'Pick a route to continue';
  if (settingsStore.config.training.defaultDuration <= 0) return 'Set a duration to continue';
  if (!mapReachable.value) return 'Map tiles unreachable — check network';
  if (sensorStore.sensors.length === 0) return 'Connect a sensor to continue';
  return '';
});

const stateIcon = computed(() => {
  switch (sensorStore.sessionState) {
    case 'scanning': return 'spinner';
    case 'ready': return 'check';
    case 'recording': return 'circle-dot';
    default: return 'plug';
  }
});

function capIcon(state: 'unknown' | 'available' | 'unavailable'): string {
  switch (state) {
    case 'available': return 'check';
    case 'unavailable': return 'xmark';
    default: return 'spinner';
  }
}

function capLabel(state: 'unknown' | 'available' | 'unavailable'): string {
  switch (state) {
    case 'available': return 'Detected';
    case 'unavailable': return 'Not detected';
    default: return 'Probing…';
  }
}

function capRowClass(state: 'unknown' | 'available' | 'unavailable'): string {
  return `sensor-drawer__cap-row--${state}`;
}

function truncateMessage(msg: string): string {
  const firstLine = msg.split(/\r?\n/)[0];
  return firstLine.length > 100 ? firstLine.slice(0, 99) + '…' : firstLine;
}

function profileIcon(profile: string): string {
  switch (profile) {
    case 'HR': return 'heart-pulse';
    case 'PWR': return 'bolt';
    case 'SC': return 'gauge-high';
    case 'SPD': return 'gauge-high';
    case 'CAD': return 'rotate';
    default: return 'microchip';
  }
}

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

function launchGame() {
  if (starting.value) return;
  starting.value = true;

  // Recording is deferred: instead of starting the server recording here, we
  // stash the full training/game config and let GameView fire /api/live/start
  // only once the user passes the start prompt (pedals or presses Space). This
  // keeps the backend out of 'recording' state — no ride row, jsonl, clock, or
  // moving ball — while the prompt is still showing.
  const route = routeStore.activeRoute;
  gameStore.pendingStart = {
    routeId: route?.id,
    routeName: route?.name,
    game: route
      ? {
          ftp: settingsStore.config.training.ftp,
          hrMax: settingsStore.config.training.hrMax,
          trainerModel: settingsStore.config.sensor.trainerModel,
          freeRoam: gameStore.freeRoam,
          targetDurationMs: settingsStore.config.training.defaultDuration,
          randomEventsEnabled: gameStore.randomEventsEnabled,
          selectedWorkoutId: gameStore.selectedWorkoutId,
        }
      : undefined,
  };

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
    await fetch('https://tiles.openfreemap.org/styles/liberty', {
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
.start-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1.5px solid var(--hud-border);
  flex-shrink: 0;
}

/* ── Elevation widget ── */
.start-bar__elev {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.start-bar__elev-toggle {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  padding: 0;
  font-family: var(--font-display);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--hud-cyan);
  opacity: 0.7;
  cursor: pointer;
  transition: opacity 0.15s;
}

.start-bar__elev-toggle:hover {
  opacity: 1;
  text-shadow: 0 0 6px rgba(var(--accent-rgb), 0.5);
}

.start-bar__elev-bar {
  display: flex;
  height: 14px;
  border: 1.5px solid var(--hud-border);
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.start-bar__elev-bar:hover {
  border-color: var(--hud-cyan);
  box-shadow: 0 0 6px rgba(var(--accent-rgb), 0.3);
}

.start-bar__elev-seg {
  height: 100%;
  min-width: 2px;
}

.start-bar__elev-bar-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 10px;
  color: var(--hud-text);
  opacity: 0.5;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.start-bar__elev-full {
  display: flex;
  flex-direction: column;
}

.start-bar__elev-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 60px;
  border: 1.5px solid var(--hud-border);
  font-size: 10px;
  color: var(--hud-text);
  opacity: 0.5;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* ── Buttons row ── */
.start-bar__buttons {
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.start-bar__start {
  flex: 1;
}

.start-bar__device {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--hud-cyan);
  background: var(--accent-soft);
  border: 1.5px solid var(--hud-border);
  border-radius: var(--card-radius-sm);
}

.start-bar__device:hover {
  border-color: var(--hud-cyan);
  background: rgba(var(--accent-rgb), 0.12);
  filter: drop-shadow(0 0 6px rgba(var(--accent-rgb), 0.4));
}

.start-bar__device-label {
  letter-spacing: 1.5px;
}

.start-bar__device-badge {
  font-size: 11px;
  font-weight: 700;
  background: rgba(var(--accent-rgb), 0.18);
  border: 1.5px solid var(--hud-cyan);
  padding: 1px 7px;
  letter-spacing: 1px;
  min-width: 16px;
  text-align: center;
}

.start-bar__device-badge--zero {
  background: rgba(255, 45, 107, 0.12);
  border-color: var(--accent-danger);
  color: var(--accent-danger);
}

/* Start Ride button — neutral base; theme overrides give it personality. */
.start-bar :deep(.el-button--success) {
  background: var(--accent-hover);
  color: var(--hud-cyan);
  border: 1.5px solid var(--hud-cyan);
  border-radius: var(--card-radius-sm);
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 1.5px;
  transition: background 0.2s, transform 0.1s, box-shadow 0.1s;
}

.start-bar :deep(.el-button--success:hover) {
  background: var(--accent-strong);
}

.start-bar :deep(.el-button--success.is-disabled) {
  opacity: 0.4;
  animation: none;
  filter: none;
  box-shadow: none !important;
  transform: none !important;
}

.start-bar__hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-family: var(--font-display);
  font-size: 10px;
  color: var(--accent-danger);
  opacity: 0.85;
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* ── Comparison dialog ── */
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
  text-shadow: 0 0 10px rgba(var(--accent-rgb), 0.3);
}

.compare-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 300px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(var(--accent-rgb), 0.3) transparent;
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
  background: rgba(var(--accent-rgb), 0.02);
  border: 1.5px solid var(--hud-border);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  font-size: 12px;
}

.compare-dialog__item:hover {
  background: rgba(var(--accent-rgb), 0.06);
  border-color: rgba(var(--accent-rgb), 0.3);
}

.compare-dialog__item--selected {
  background: rgba(var(--accent-rgb), 0.1);
  border-color: var(--hud-cyan);
  box-shadow: 0 0 8px rgba(var(--accent-rgb), 0.2);
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

/* ── Sensor drawer ── */
.sensor-drawer__header {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 2px;
  text-shadow: 0 0 10px rgba(var(--accent-rgb), 0.3);
}

.sensor-drawer__badge {
  font-size: 11px;
  background: rgba(var(--accent-rgb), 0.15);
  border: 1.5px solid var(--hud-cyan);
  padding: 1px 8px;
  letter-spacing: 1px;
}

.sensor-drawer__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sensor-drawer__state-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.sensor-drawer__state {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--hud-text);
  opacity: 0.7;
}

.sensor-drawer__state--warn {
  color: var(--accent-danger);
  opacity: 0.9;
}

.sensor-drawer__caps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  background: rgba(var(--accent-rgb), 0.04);
  border: 1.5px solid var(--hud-border);
}

.sensor-drawer__caps-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-display);
  font-size: 9px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 1px;
  padding-bottom: 4px;
  border-bottom: 1.5px solid var(--hud-border);
  margin-bottom: 2px;
}

.sensor-drawer__cap-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  font-family: var(--font-display);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.sensor-drawer__cap-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--hud-text);
  opacity: 0.85;
}

.sensor-drawer__cap-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 700;
}

.sensor-drawer__cap-row--available .sensor-drawer__cap-status {
  color: var(--zone-3);
  filter: drop-shadow(0 0 4px rgba(0,255,136,0.4));
}

.sensor-drawer__cap-row--unavailable .sensor-drawer__cap-status {
  color: var(--accent-danger);
  filter: drop-shadow(0 0 4px rgba(255,45,107,0.4));
}

.sensor-drawer__cap-row--unknown .sensor-drawer__cap-status {
  color: var(--hud-cyan);
  opacity: 0.7;
}

.sensor-drawer__cap-detail {
  font-size: 9px;
  color: var(--accent-danger);
  opacity: 0.75;
  letter-spacing: 0.3px;
  padding-left: 18px;
  line-height: 1.4;
}

.sensor-drawer__empty {
  font-size: 11px;
  color: var(--hud-text);
  opacity: 0.5;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 16px 0;
  text-align: center;
}

.sensor-drawer__card {
  padding: 10px 12px;
  background: rgba(var(--accent-rgb), 0.04);
  border: 1.5px solid var(--hud-border);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sensor-drawer__card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  color: var(--hud-text-bright);
  text-transform: uppercase;
  letter-spacing: 1px;
}

.sensor-drawer__profile {
  flex: 1;
}

.sensor-drawer__source {
  font-size: 9px;
  font-weight: 400;
  color: var(--hud-cyan);
  background: rgba(var(--accent-rgb), 0.1);
  border: 1.5px solid rgba(var(--accent-rgb), 0.2);
  padding: 1px 6px;
  letter-spacing: 0.5px;
}

.sensor-drawer__card-detail {
  font-size: 10px;
  color: var(--hud-text);
  opacity: 0.6;
  letter-spacing: 0.5px;
}

.sensor-drawer__values {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sensor-drawer__values-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 1px;
  padding-bottom: 4px;
  border-bottom: 1.5px solid var(--hud-border);
}

.sensor-drawer__value-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
}

.sensor-drawer__value-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--hud-text);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.sensor-drawer__value-num {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  color: var(--hud-text-bright);
  letter-spacing: 1px;
  text-shadow: 0 0 8px rgba(var(--accent-rgb), 0.2);
}

.sensor-drawer__value-num small {
  font-size: 10px;
  font-weight: 400;
  opacity: 0.6;
}
</style>
