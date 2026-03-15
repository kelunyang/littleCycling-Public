<template>
  <div class="hud-top">
    <div
      class="hud-metric hud-metric--hr"
      :class="{ 'hud-metric--active': pinnedMetrics.includes('hr') }"
      :style="{ '--glow-color': zoneColor }"
      @click="emit('togglePin', 'hr')"
    >
      <font-awesome-icon icon="heart" class="hud-metric__icon" :style="{ color: zoneColor }" />
      <div class="hud-metric__values">
        <span class="hud-metric__value">{{ hr ?? '--' }}</span>
        <span v-if="comparison?.hr != null" class="hud-metric__compare">
          <font-awesome-icon :icon="(hr ?? 0) >= comparison.hr ? 'caret-up' : 'caret-down'" />
          {{ comparison.hr }}
        </span>
      </div>
      <span class="hud-metric__unit">BPM</span>
      <div v-if="hr != null" class="hud-zone-bar">
        <font-awesome-icon
          v-for="z in 5"
          :key="z"
          icon="heart-pulse"
          class="hud-zone-bar__icon"
          :class="{ 'hud-zone-bar__icon--active': currentZone?.zone === z }"
          :style="{ color: ZONE_COLORS[z - 1] }"
        />
        <span v-if="currentZone" class="hud-zone-bar__label">
          Z{{ currentZone.zone }} {{ currentZone.name.toUpperCase() }}
        </span>
      </div>
    </div>

    <div
      class="hud-metric"
      :class="{ 'hud-metric--active': pinnedMetrics.includes('speed') }"
      @click="emit('togglePin', 'speed')"
    >
      <font-awesome-icon icon="gauge" class="hud-metric__icon" />
      <div class="hud-metric__values">
        <span class="hud-metric__value">{{ speed ?? '--' }}</span>
        <span v-if="comparison?.speed != null" class="hud-metric__compare">
          <font-awesome-icon :icon="parseFloat(speed ?? '0') >= comparison.speed ? 'caret-up' : 'caret-down'" />
          {{ comparison.speed.toFixed(1) }}
        </span>
      </div>
      <span class="hud-metric__unit">KM/H</span>
    </div>

    <div
      class="hud-metric"
      :class="{ 'hud-metric--active': pinnedMetrics.includes('cadence') }"
      @click="emit('togglePin', 'cadence')"
    >
      <font-awesome-icon icon="rotate" class="hud-metric__icon" />
      <div class="hud-metric__values">
        <span class="hud-metric__value">{{ cadence ?? '--' }}</span>
        <span v-if="comparison?.cadence != null" class="hud-metric__compare">
          <font-awesome-icon :icon="(cadence ?? 0) >= comparison.cadence ? 'caret-up' : 'caret-down'" />
          {{ Math.round(comparison.cadence) }}
        </span>
      </div>
      <span class="hud-metric__unit">RPM</span>
    </div>

    <div
      class="hud-metric"
      :class="{ 'hud-metric--active': pinnedMetrics.includes('power') }"
      @click="emit('togglePin', 'power')"
    >
      <font-awesome-icon icon="bolt" class="hud-metric__icon" />
      <div class="hud-metric__values">
        <span class="hud-metric__value">{{ power ?? '--' }}</span>
        <span v-if="comparison?.power != null" class="hud-metric__compare">
          <font-awesome-icon :icon="(power ?? 0) >= comparison.power ? 'caret-up' : 'caret-down'" />
          {{ Math.round(comparison.power) }}
        </span>
      </div>
      <span class="hud-metric__unit">W</span>
    </div>

    <div v-if="settingsStore.config.debug" class="hud-metric hud-metric--debug">
      <font-awesome-icon icon="gauge" class="hud-metric__icon" />
      <div class="hud-metric__values">
        <span class="hud-metric__value">{{ fps }}</span>
      </div>
      <span class="hud-metric__unit">FPS</span>
    </div>

    <div v-if="settingsStore.config.debug" class="hud-metric hud-metric--debug">
      <font-awesome-icon icon="arrow-trend-up" class="hud-metric__icon" />
      <div class="hud-metric__values">
        <span class="hud-metric__value">{{ props.cameraPitch.toFixed(1) }}</span>
      </div>
      <span class="hud-metric__unit">PITCH</span>
    </div>

    <div v-if="settingsStore.config.debug" class="hud-metric hud-metric--debug">
      <font-awesome-icon icon="mountain" class="hud-metric__icon" />
      <div class="hud-metric__values">
        <span class="hud-metric__value">{{ props.cameraHeight.toFixed(1) }}</span>
      </div>
      <span class="hud-metric__unit">CAM H</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSensorStore } from '@/stores/sensorStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { getHrZone } from '@littlecycling/shared';
import type { ComparisonMetrics } from '@littlecycling/shared';
import type { PinnableMetric } from '@/composables/useChartPin';

const props = defineProps<{
  virtualPower?: number;
  pinnedMetrics: PinnableMetric[];
  comparison?: ComparisonMetrics;
  fps: number;
  cameraPitch: number;
  cameraHeight: number;
}>();

const emit = defineEmits<{
  togglePin: [metric: PinnableMetric];
}>();

const sensorStore = useSensorStore();
const settingsStore = useSettingsStore();

const hr = computed(() => sensorStore.hr?.heartRate ?? null);
const speed = computed(() =>
  sensorStore.sc ? sensorStore.sc.speed.toFixed(1) : null
);
const cadence = computed(() =>
  sensorStore.sc ? Math.round(sensorStore.sc.cadence) : null
);
const power = computed(() => {
  if (sensorStore.pwr) return Math.round(sensorStore.pwr.power);
  if (props.virtualPower != null) return Math.round(props.virtualPower);
  return null;
});

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
  gap: 6px;
  pointer-events: auto;
}

.hud-metric {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--hud-bg);
  clip-path: var(--clip-panel-sm);
  border: 1px solid var(--hud-border);
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;
  position: relative;
}

.hud-metric::before {
  content: '';
  position: absolute;
  inset: 0;
  clip-path: var(--clip-panel-sm);
  border: 1px solid var(--hud-border);
  pointer-events: none;
}

.hud-metric:hover {
  border-color: var(--hud-border-bright);
}

.hud-metric--active {
  border-color: var(--hud-cyan);
  box-shadow: var(--hud-glow-cyan);
}

.hud-metric__icon {
  font-size: 12px;
  color: var(--hud-cyan);
  filter: drop-shadow(0 0 3px currentColor);
}

.hud-metric__value {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  color: var(--hud-text-bright);
  text-shadow: 0 0 8px rgba(0, 229, 255, 0.4);
  font-variant-numeric: tabular-nums;
  min-width: 36px;
  text-align: right;
  letter-spacing: 0.5px;
}

.hud-metric__values {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.hud-metric__compare {
  font-family: var(--font-body);
  font-size: 10px;
  color: var(--hud-cyan);
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
  display: flex;
  align-items: center;
  gap: 2px;
  line-height: 1;
}

.hud-metric__unit {
  font-family: var(--font-body);
  font-size: 10px;
  font-weight: 500;
  color: var(--hud-cyan);
  opacity: 0.6;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.hud-metric--debug {
  opacity: 0.5;
  cursor: default;
}

/* ── HR Zone indicator bar ── */

.hud-metric--hr {
  flex-wrap: wrap;
}

.hud-zone-bar {
  display: flex;
  align-items: center;
  gap: 3px;
  width: 100%;
  margin-top: 2px;
}

.hud-zone-bar__icon {
  font-size: 8px;
  opacity: 0.2;
  transition: opacity 0.3s, filter 0.3s;
}

.hud-zone-bar__icon--active {
  opacity: 1;
  filter: drop-shadow(0 0 4px currentColor);
}

.hud-zone-bar__label {
  font-family: var(--font-display);
  font-size: 8px;
  font-weight: 600;
  color: var(--hud-text);
  opacity: 0.6;
  letter-spacing: 0.5px;
  margin-left: 2px;
}
</style>
