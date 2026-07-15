<template>
  <div class="hud">
    <div class="hud__top-left">
      <HudTopBar
        :virtual-power="virtualPower"
        :pinned-metrics="chartPin.pinned.value"
        :fps="fps"
        :fps-max="fpsMax"
        :fps-min="fpsMin"
        :hr-max="hrMax"
        :hr-min="hrMin"
        :speed-max="speedMax"
        :speed-min="speedMin"
        :cadence-max="cadenceMax"
        :cadence-min="cadenceMin"
        :power-max="powerMax"
        :power-min="powerMin"
        :camera-pitch="cameraPitch"
        :camera-height="cameraHeight"
        @toggle-pin="chartPin.togglePin"
      />
    </div>

    <div class="hud__top-right">
      <HudCoins :combo="combo" />
    </div>

    <div class="hud__bottom-left">
      <HudBottomLeft
        :elapsed-ms="elapsedMs"
        :route-points="routePoints"
        :distance-traveled="distanceTraveled"
        :workout-segments="props.workoutSegments"
        :current-segment-index="props.currentSegmentIndex"
        :target-watts="props.targetWatts"
        :is-on-target="props.isOnTarget"
        :current-segment-name="props.currentSegmentName"
      />
    </div>

    <div class="hud__bottom-right">
      <HudChart
        :samples="timeSeries"
        :configs="chartPin.pinnedConfigs.value"
        :theme="chartTheme"
      />
      <HudBottomRight
        :route-points="routePoints"
        :ball-lat="ballLat"
        :ball-lon="ballLon"
        :ball-bearing="ballBearing"
        :is-paused="gameStore.isPaused"
        :idle-ms="props.idleMs"
        :auto-paused="props.autoPaused"
        :pip-supported="props.pipSupported"
        @stop="emit('stop')"
        @pause="emit('pause')"
        @pip="emit('togglePip')"
      />
    </div>

    <!-- Center-bottom challenge panel: themed workout segment (structured
         training) or random event (freeride) — the sim never runs both.
         The stopped-pedalling countdown now lives on the PAUSE button, so this
         slot no longer yields to it. -->
    <!-- Camera view switch — top-centre, where the message bubble pops (the
         bubble is transient, so it borrows the slot and the switch yields while
         one is showing). 3D orbits the bike; 2D detaches the side-on camera so
         it can be dragged and zoomed around the world. -->
    <div v-if="showCameraMode" class="hud__camera-mode">
      <HudCameraMode />
    </div>

    <div class="hud__event-bar">
      <HudWorkoutBar
        v-if="hasWorkout"
        :theme="workoutTheme"
        :segment-name="props.currentSegmentName"
        :segment-index="props.currentSegmentIndex"
        :target-watts="props.targetWatts"
        :current-watts="props.currentWatts"
        :power-source="props.powerSource"
        :target-cadence="currentWorkoutSegment?.targetCadence"
        :current-cadence="props.currentCadence"
        :remaining-ms="props.segmentRemainingMs"
        :is-on-target="props.isOnTarget"
      />
      <HudEventBar
        v-else
        :is-event-active="props.isEventActive"
        :active-event="props.activeEvent"
        :event-elapsed-ms="props.eventElapsedMs"
        :event-progress="props.eventProgress"
        :target-watts="props.eventTargetWatts"
        :target-cadence="props.eventTargetCadence"
        :is-on-target="props.isEventOnTarget"
        :current-watts="props.currentWatts"
        :current-cadence="props.currentCadence"
      />
    </div>

    <!-- Screen tint overlay: random event first, else workout segment theme -->
    <div
      class="event-overlay"
      :style="{
        backgroundColor: activeTint ?? 'transparent',
        opacity: activeTint ? activeTintOpacity : 0,
      }"
    />

    <ZoneWarning :visible="redLine" />

    <GameBubble
      :message="message"
      @typewriter-done="(ms: number) => emit('typewriterDone', ms)"
    />

    <GameSummary :workout-segments="props.workoutSegments" @continue="emit('continue')" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { getSegmentTheme } from '@littlecycling/shared';
import type { RoutePoint, WorkoutSegment, RandomEventDef } from '@littlecycling/shared';
import type { TimeSeriesSample } from '@/composables/useGameLoop';
import type { GameMessage } from '@/composables/useGameMessages';
import { useChartPin } from '@/composables/useChartPin';
import { useGameStore } from '@/stores/gameStore';
import { useSettingsStore } from '@/stores/settingsStore';
import HudTopBar from './HudTopBar.vue';
import HudCoins from './HudCoins.vue';
import HudBottomLeft from './HudBottomLeft.vue';
import HudBottomRight from './HudBottomRight.vue';
import HudChart from './HudChart.vue';
import ZoneWarning from './ZoneWarning.vue';
import GameBubble from './GameBubble.vue';
import GameSummary from './GameSummary.vue';
import HudEventBar from './HudEventBar.vue';
import HudWorkoutBar from './HudWorkoutBar.vue';
import HudCameraMode from './HudCameraMode.vue';

const props = defineProps<{
  routePoints: RoutePoint[];
  ballLat: number;
  ballLon: number;
  ballBearing: number;
  elapsedMs: number;
  distanceTraveled: number;
  combo: number;
  redLine: boolean;
  virtualPower?: number;
  timeSeries: TimeSeriesSample[];
  fps: number;
  fpsMax: number;
  fpsMin: number | null;
  hrMax: number;
  hrMin: number | null;
  speedMax: number;
  speedMin: number | null;
  cadenceMax: number;
  cadenceMin: number | null;
  powerMax: number;
  powerMin: number | null;
  workoutSegments: WorkoutSegment[];
  currentSegmentIndex: number;
  targetWatts: number;
  isOnTarget: boolean;
  currentSegmentName: string;
  segmentRemainingMs: number;
  /** Effective watts — real meter first, else server trainer-curve estimate. */
  currentWatts: number;
  powerSource: 'meter' | 'estimated';
  currentCadence: number | null;
  pipSupported: boolean;
  cameraPitch: number;
  cameraHeight: number;
  message: GameMessage | null;
  // Random events
  isEventActive: boolean;
  activeEvent: RandomEventDef | null;
  eventElapsedMs: number;
  eventProgress: number;
  eventTargetWatts: number;
  eventTargetCadence: number | null;
  isEventOnTarget: boolean;
  eventScreenTint: string | null;
  eventScreenTintOpacity: number;
  // Idle (stopped-pedalling) auto-pause countdown
  idleMs: number;
  autoPaused: boolean;
}>();

const emit = defineEmits<{ stop: []; pause: []; togglePip: []; typewriterDone: [durationMs: number]; continue: [] }>();

const chartPin = useChartPin();
const gameStore = useGameStore();
const settingsStore = useSettingsStore();

// Chart skin follows the world: neon for the 3D-ish renderers (Three.js /
// MapLibre), the hand-drawn/plastic palette for the Phaser 2D world.
const chartTheme = computed<'neon' | 'plastic' | 'cuphead'>(() => {
  if (settingsStore.config.map.renderMode !== 'phaser') return 'neon';
  return settingsStore.config.map.worldStyle ?? 'plastic';
});

// ── Workout segment theming (narrative event skin) ──

const hasWorkout = computed(() => props.workoutSegments.length > 0);

/** The camera switch only exists in 3D. It sits in the message bubble's spot,
 *  so it steps aside while a bubble is actually up — nothing else hides it
 *  (the old bottom-centre placement vanished whenever a workout was loaded,
 *  which for this rider was always). */
const showCameraMode = computed(() => {
  const mode = settingsStore.config.map.renderMode;
  return (mode === 'threejs' || mode === 'phaser') && !props.message;
});

const currentWorkoutSegment = computed<WorkoutSegment | null>(() => {
  if (props.currentSegmentIndex < 0 || props.currentSegmentIndex >= props.workoutSegments.length) {
    return null;
  }
  return props.workoutSegments[props.currentSegmentIndex];
});

const workoutTheme = computed(() =>
  currentWorkoutSegment.value ? getSegmentTheme(currentWorkoutSegment.value) : null,
);

// Screen tint: an in-flight random event wins (short + loud); otherwise the
// current workout segment's theme tint (long + subtle).
const activeTint = computed<string | null>(() => {
  if (props.eventScreenTint) return props.eventScreenTint;
  return workoutTheme.value?.screenTint ?? null;
});

const activeTintOpacity = computed(() => {
  if (props.eventScreenTint) return props.eventScreenTintOpacity;
  return workoutTheme.value?.screenTintOpacity ?? 0;
});

</script>

<style scoped>
.hud {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 10;
}

.hud__top-left {
  position: absolute;
  top: 16px;
  left: 16px;
}

.hud__top-right {
  position: absolute;
  top: 16px;
  right: 16px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  pointer-events: auto;
}

.hud__bottom-left {
  position: absolute;
  bottom: 16px;
  left: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hud__bottom-right {
  position: absolute;
  bottom: 16px;
  right: 16px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.hud__event-bar {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
}

/* The message bubble's spot (GameBubble: top 76px, centred) — the bubble is
   transient and the switch yields to it, so they never actually collide. */
.hud__camera-mode {
  position: absolute;
  top: 76px;
  left: 50%;
  transform: translateX(-50%);
}

.event-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 9;
  transition: opacity 0.3s ease, background-color 0.3s ease;
}
</style>
