<template>
  <div class="hud">
    <div class="hud__top-left">
      <HudTopBar
        :virtual-power="virtualPower"
        :pinned-metrics="chartPin.pinned.value"
        :comparison="comparison"
        :fps="fps"
        :camera-pitch="cameraPitch"
        :camera-height="cameraHeight"
        @toggle-pin="chartPin.togglePin"
      />
    </div>

    <div class="hud__top-right">
      <HudCoins :combo="combo" />
      <button v-if="pipSupported" class="hud-pip" @click="emit('togglePip')">
        <font-awesome-icon icon="up-right-from-square" />
        PIP
      </button>
      <div v-if="!isPhaser" class="glasses-lens-picker">
        <el-segmented v-model="gameStore.glassesLens" :options="lensOptions" size="small" />
      </div>
    </div>

    <div class="hud__bottom-left">
      <HudChart
        :samples="timeSeries"
        :configs="chartPin.pinnedConfigs.value"
      />
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
      <HudBottomRight
        :route-points="routePoints"
        :ball-lat="ballLat"
        :ball-lon="ballLon"
        :ball-bearing="ballBearing"
        @stop="emit('stop')"
      />
    </div>

    <!-- Random event progress bar -->
    <div class="hud__event-bar">
      <HudEventBar
        :is-event-active="props.isEventActive"
        :active-event="props.activeEvent"
        :event-elapsed-ms="props.eventElapsedMs"
        :event-progress="props.eventProgress"
        :target-watts="props.eventTargetWatts"
        :target-cadence="props.eventTargetCadence"
        :is-on-target="props.isEventOnTarget"
      />
    </div>

    <!-- Event screen tint overlay -->
    <div
      class="event-overlay"
      :style="{
        backgroundColor: props.eventScreenTint ?? 'transparent',
        opacity: props.eventScreenTint ? props.eventScreenTintOpacity : 0,
      }"
    />

    <ZoneWarning :visible="redLine" />

    <GameBubble
      :message="message"
      @typewriter-done="(ms: number) => emit('typewriterDone', ms)"
    />

    <GameSummary
      :elapsed-ms="elapsedMs"
      :distance-traveled="distanceTraveled"
      :stats="stats"
      :workout-segments="props.workoutSegments"
    />
  </div>
</template>

<script setup lang="ts">
import type { RoutePoint, ComparisonMetrics, WorkoutSegment, RandomEventDef } from '@littlecycling/shared';
import type { GameStats, TimeSeriesSample } from '@/composables/useGameLoop';
import type { GameMessage } from '@/composables/useGameMessages';
import { computed } from 'vue';
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
  comparison?: ComparisonMetrics;
  stats: GameStats;
  timeSeries: TimeSeriesSample[];
  fps: number;
  workoutSegments: WorkoutSegment[];
  currentSegmentIndex: number;
  targetWatts: number;
  isOnTarget: boolean;
  currentSegmentName: string;
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
}>();

const emit = defineEmits<{ stop: []; togglePip: []; typewriterDone: [durationMs: number] }>();

const chartPin = useChartPin();
const gameStore = useGameStore();
const isPhaser = computed(() => useSettingsStore().config.map.renderMode === 'phaser');

const lensOptions = [
  { label: 'Clear', value: 'clear' },
  { label: 'Dark', value: 'dark' },
  { label: 'Red', value: 'red' },
  { label: 'Yellow', value: 'yellow' },
  { label: 'Auto', value: 'auto' },
];
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

.hud-pip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: rgba(0, 255, 255, 0.1);
  color: var(--hud-cyan);
  border: 1px solid rgba(0, 255, 255, 0.3);
  clip-path: var(--clip-panel-sm);
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 2px;
  cursor: pointer;
  transition: background 0.2s, box-shadow 0.2s;
  text-shadow: 0 0 8px rgba(0, 255, 255, 0.4);
}

.hud-pip:hover {
  background: rgba(0, 255, 255, 0.2);
  box-shadow: var(--hud-glow-cyan);
}

.glasses-lens-picker {
  background: var(--hud-bg);
  clip-path: var(--clip-panel-sm);
  padding: 4px;
  border: 1px solid var(--hud-border);
}

.glasses-lens-picker :deep(.el-segmented) {
  --el-border-radius-base: 0;
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
}

.hud__event-bar {
  position: absolute;
  bottom: 16px;
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
