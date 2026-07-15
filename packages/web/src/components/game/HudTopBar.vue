<template>
  <div class="hud-top">
    <template v-for="id in hudStore.visibleMetrics" :key="id">
      <div
        v-if="id === 'hr'"
        class="hud-metric hud-metric--hr"
        :class="{ 'hud-metric--active': pinnedMetrics.includes('hr') }"
        :style="{ '--glow-color': zoneColor }"
        @click="emit('togglePin', 'hr')"
      >
        <font-awesome-icon icon="heart" class="hud-metric__icon" :style="{ color: zoneColor }" />
        <span class="hud-metric__value">{{ hr ?? '--' }}</span>
        <span class="hud-metric__unit">BPM</span>
      </div>

      <div
        v-else-if="id === 'speed'"
        class="hud-metric"
        :class="{ 'hud-metric--active': pinnedMetrics.includes('speed') }"
        @click="emit('togglePin', 'speed')"
      >
        <font-awesome-icon icon="gauge" class="hud-metric__icon" />
        <span class="hud-metric__value">{{ speed ?? '--' }}</span>
        <span class="hud-metric__unit">KM/H</span>
      </div>

      <div
        v-else-if="id === 'cadence'"
        class="hud-metric"
        :class="{ 'hud-metric--active': pinnedMetrics.includes('cadence') }"
        @click="emit('togglePin', 'cadence')"
      >
        <font-awesome-icon icon="rotate" class="hud-metric__icon" />
        <span class="hud-metric__value">{{ cadence ?? '--' }}</span>
        <span class="hud-metric__unit">RPM</span>
      </div>

      <div
        v-else-if="id === 'power'"
        class="hud-metric"
        :class="{ 'hud-metric--active': pinnedMetrics.includes('power') }"
        @click="emit('togglePin', 'power')"
      >
        <font-awesome-icon icon="bolt" class="hud-metric__icon" />
        <span class="hud-metric__value">{{ power ?? '--' }}</span>
        <span class="hud-metric__unit">W</span>
      </div>

      <div v-else-if="id === 'leftPower'" class="hud-metric">
        <font-awesome-icon icon="arrow-left" class="hud-metric__icon" />
        <span class="hud-metric__value">{{ leftPower ?? '--' }}</span>
        <span class="hud-metric__unit">W L</span>
      </div>

      <div v-else-if="id === 'rightPower'" class="hud-metric">
        <font-awesome-icon icon="arrow-right" class="hud-metric__icon" />
        <span class="hud-metric__value">{{ rightPower ?? '--' }}</span>
        <span class="hud-metric__unit">W R</span>
      </div>

      <div v-else-if="id === 'balance'" class="hud-metric">
        <font-awesome-icon icon="scale-balanced" class="hud-metric__icon" />
        <span class="hud-metric__value">{{ balance ?? '--' }}</span>
        <span class="hud-metric__unit">L/R %</span>
      </div>

      <div v-else-if="id === 'pwrCadence'" class="hud-metric">
        <font-awesome-icon icon="rotate" class="hud-metric__icon" />
        <span class="hud-metric__value">{{ pwrCadence ?? '--' }}</span>
        <span class="hud-metric__unit">PM RPM</span>
      </div>

      <div v-else-if="id === 'fps'" class="hud-metric hud-metric--debug">
        <font-awesome-icon icon="gauge" class="hud-metric__icon" />
        <span class="hud-metric__value">{{ fps }}</span>
        <span class="hud-metric__unit">FPS</span>
      </div>

      <div v-else-if="id === 'pitch'" class="hud-metric hud-metric--debug">
        <font-awesome-icon icon="arrow-trend-up" class="hud-metric__icon" />
        <span class="hud-metric__value">{{ props.cameraPitch.toFixed(1) }}</span>
        <span class="hud-metric__unit">PITCH</span>
      </div>

      <div v-else-if="id === 'cameraHeight'" class="hud-metric hud-metric--debug">
        <font-awesome-icon icon="mountain" class="hud-metric__icon" />
        <span class="hud-metric__value">{{ props.cameraHeight.toFixed(1) }}</span>
        <span class="hud-metric__unit">CAM H</span>
      </div>
    </template>

    <button
      class="hud-customize-btn"
      :class="{ 'hud-customize-btn--open': customizing }"
      @click.stop="customizing = !customizing"
      title="Customize HUD"
      aria-label="Customize HUD"
    >
      <font-awesome-icon icon="gear" />
    </button>

    <HudCustomizePanel v-if="customizing" mode="dropdown" @close="customizing = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useSensorStore } from '@/stores/sensorStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useHudStore } from '@/stores/hudStore';
import {
  getHrZone,
  estimateVirtualSpeedFromPower,
  estimateVirtualCadenceFromPower,
} from '@littlecycling/shared';
import type { PinnableMetric } from '@/composables/useChartPin';
import HudCustomizePanel from './HudCustomizePanel.vue';

const props = defineProps<{
  virtualPower?: number;
  pinnedMetrics: PinnableMetric[];
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
  cameraPitch: number;
  cameraHeight: number;
}>();

const emit = defineEmits<{
  togglePin: [metric: PinnableMetric];
}>();

const sensorStore = useSensorStore();
const settingsStore = useSettingsStore();
const hudStore = useHudStore();

const customizing = ref(false);

const hr = computed(() => sensorStore.hr?.heartRate ?? null);
const speed = computed(() => {
  if (sensorStore.sc) return sensorStore.sc.speed.toFixed(1);
  if (sensorStore.pwr) return estimateVirtualSpeedFromPower(sensorStore.pwr.power).toFixed(1);
  return null;
});
const cadence = computed(() => {
  if (sensorStore.sc) return Math.round(sensorStore.sc.cadence);
  if (sensorStore.pwr) return Math.round(estimateVirtualCadenceFromPower(sensorStore.pwr.power));
  return null;
});
const power = computed(() => {
  if (sensorStore.pwr) return Math.round(sensorStore.pwr.power);
  if (props.virtualPower != null) return Math.round(props.virtualPower);
  return null;
});
const leftPower = computed(() =>
  sensorStore.pwr?.leftPower != null ? Math.round(sensorStore.pwr.leftPower) : null,
);
const rightPower = computed(() =>
  sensorStore.pwr?.rightPower != null ? Math.round(sensorStore.pwr.rightPower) : null,
);
const balance = computed(() => {
  const b = sensorStore.pwr?.balance;
  if (b == null) return null;
  return `${Math.round(b)}/${Math.round(100 - b)}`;
});
const pwrCadence = computed(() =>
  sensorStore.pwr?.cadence != null ? Math.round(sensorStore.pwr.cadence) : null,
);

const ZONE_COLORS = ['var(--zone-1)', 'var(--zone-2)', 'var(--zone-3)', 'var(--zone-4)', 'var(--zone-5)'];

const currentZone = computed(() => {
  const heartRate = sensorStore.hr?.heartRate;
  if (!heartRate) return null;
  return getHrZone(heartRate, settingsStore.config.training.hrMax);
});

const zoneColor = computed(() => {
  if (!currentZone.value) return 'var(--hud-cyan)';
  return ZONE_COLORS[currentZone.value.zone - 1] ?? 'var(--hud-cyan)';
});

</script>

<style scoped>
.hud-top {
  display: flex;
  gap: 20px;
  pointer-events: auto;
  position: relative;
  flex-wrap: wrap;
  max-width: calc(100vw - 220px);
  align-items: center;
}

/* Borderless, background-free overlay: the top HUD reads as glowing/embossed
   text floating over the world, keeping it distinct from the boxed bottom info
   panels. Only a little vertical padding remains for the pin click target. */
.hud-metric {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 2px 4px;
  cursor: pointer;
  transition: filter 0.2s, opacity 0.2s;
  position: relative;
}

/* Pinned state: no box border — a short accent underline bar + brighter text. */
.hud-metric--active::after {
  content: '';
  position: absolute;
  left: 2px;
  right: 2px;
  bottom: 0;
  height: 2px;
  background: #00e5ff;
  box-shadow: 0 0 6px rgba(0, 229, 255, 0.8);
}

.hud-metric:hover { filter: brightness(1.15); }

/* ── 3D (default): neon glow, hardcoded cyberpunk cyan so the overlay stays
      "fluorescent" regardless of the world-style palette. ── */
.hud-metric__icon {
  font-size: 20px;
  color: #00e5ff;
  filter: drop-shadow(0 0 5px rgba(0, 229, 255, 0.8));
}

.hud-metric__value {
  font-family: var(--font-display);
  font-size: 30px;
  font-weight: 700;
  color: #eafcff;
  text-shadow: 0 0 8px rgba(0, 229, 255, 0.8), 0 0 22px rgba(0, 229, 255, 0.45);
  font-variant-numeric: tabular-nums;
  min-width: 52px;
  text-align: right;
  letter-spacing: 0.5px;
  line-height: 1;
}

.hud-metric__unit {
  font-family: var(--font-body);
  font-size: 14px;
  font-weight: 600;
  color: #00e5ff;
  opacity: 0.75;
  text-transform: uppercase;
  letter-spacing: 1px;
  text-shadow: 0 0 6px rgba(0, 229, 255, 0.5);
}

.hud-metric--debug {
  opacity: 0.5;
  cursor: default;
}

/* ── 2D (Phaser world): embossed text. Like the coins, the whole metric shares
      ONE vivid colour across icon + value + unit, so it reads clearly on the
      flat hand-drawn / plastic world. A highlight/shadow ring around each glyph
      lifts it off the background. Colour is set per world-style below. ── */
.game-view[data-hud-mode="2d"] .hud-metric__value,
.game-view[data-hud-mode="2d"] .hud-metric__unit {
  text-shadow:
    -1px -1px 0 rgba(255, 255, 255, 0.7),
    1px -1px 0 rgba(255, 255, 255, 0.4),
    -1px 1px 0 rgba(0, 0, 0, 0.3),
    1px 1px 0 rgba(0, 0, 0, 0.5),
    0 2px 3px rgba(0, 0, 0, 0.4);
}

.game-view[data-hud-mode="2d"] .hud-metric__icon {
  filter:
    drop-shadow(-1px -1px 0 rgba(255, 255, 255, 0.6))
    drop-shadow(1px 1px 1px rgba(0, 0, 0, 0.45));
}

.game-view[data-hud-mode="2d"] .hud-metric--active::after {
  box-shadow: 1px 1px 0 rgba(0, 0, 0, 0.35);
}

/* Plastic: the theme accent (hot pink) is already vivid. */
.game-view[data-world-style="plastic"][data-hud-mode="2d"] .hud-metric__value,
.game-view[data-world-style="plastic"][data-hud-mode="2d"] .hud-metric__unit,
.game-view[data-world-style="plastic"][data-hud-mode="2d"] .hud-metric__icon {
  color: var(--hud-cyan);
}
.game-view[data-world-style="plastic"][data-hud-mode="2d"] .hud-metric--active::after {
  background: var(--hud-cyan);
}

/* Cuphead: the token accent (olive) is too muted here — use a vivid ink red so
   the metrics pop as hard as the mustard-yellow coins do. */
.game-view[data-world-style="cuphead"][data-hud-mode="2d"] .hud-metric__value,
.game-view[data-world-style="cuphead"][data-hud-mode="2d"] .hud-metric__unit,
.game-view[data-world-style="cuphead"][data-hud-mode="2d"] .hud-metric__icon {
  color: #d83a2b;
}
.game-view[data-world-style="cuphead"][data-hud-mode="2d"] .hud-metric--active::after {
  background: #d83a2b;
}

/* ── Customize button ── */

.hud-customize-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  color: #00e5ff;
  border: none;
  cursor: pointer;
  font-size: 18px;
  align-self: center;
  opacity: 0.7;
  filter: drop-shadow(0 0 5px rgba(0, 229, 255, 0.7));
  transition: opacity 0.2s, transform 0.2s;
}

.hud-customize-btn:hover,
.hud-customize-btn--open {
  opacity: 1;
  transform: rotate(30deg);
}

.game-view[data-hud-mode="2d"] .hud-customize-btn {
  color: var(--hud-cyan);
  filter:
    drop-shadow(-1px -1px 0 rgba(255, 255, 255, 0.5))
    drop-shadow(1px 1px 1px rgba(0, 0, 0, 0.4));
}
</style>
