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
        <div class="hud-metric__values">
          <span class="hud-metric__minmax hud-metric__minmax--max">MAX {{ hrMax || '--' }}</span>
          <span class="hud-metric__value">{{ hr ?? '--' }}</span>
          <span class="hud-metric__minmax hud-metric__minmax--min">MIN {{ hrMin ?? '--' }}</span>
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
        v-else-if="id === 'speed'"
        class="hud-metric"
        :class="{ 'hud-metric--active': pinnedMetrics.includes('speed') }"
        @click="emit('togglePin', 'speed')"
      >
        <font-awesome-icon icon="gauge" class="hud-metric__icon" />
        <div class="hud-metric__values">
          <span class="hud-metric__minmax hud-metric__minmax--max">MAX {{ speedMax > 0 ? speedMax.toFixed(1) : '--' }}</span>
          <span class="hud-metric__value">{{ speed ?? '--' }}</span>
          <span class="hud-metric__minmax hud-metric__minmax--min">MIN {{ speedMin != null ? speedMin.toFixed(1) : '--' }}</span>
        </div>
        <span class="hud-metric__unit">KM/H</span>
      </div>

      <div
        v-else-if="id === 'cadence'"
        class="hud-metric"
        :class="{ 'hud-metric--active': pinnedMetrics.includes('cadence') }"
        @click="emit('togglePin', 'cadence')"
      >
        <font-awesome-icon icon="rotate" class="hud-metric__icon" />
        <div class="hud-metric__values">
          <span class="hud-metric__minmax hud-metric__minmax--max">MAX {{ cadenceMax ? Math.round(cadenceMax) : '--' }}</span>
          <span class="hud-metric__value">{{ cadence ?? '--' }}</span>
          <span class="hud-metric__minmax hud-metric__minmax--min">MIN {{ cadenceMin != null ? Math.round(cadenceMin) : '--' }}</span>
        </div>
        <span class="hud-metric__unit">RPM</span>
      </div>

      <div
        v-else-if="id === 'power'"
        class="hud-metric"
        :class="{ 'hud-metric--active': pinnedMetrics.includes('power') }"
        @click="emit('togglePin', 'power')"
      >
        <font-awesome-icon icon="bolt" class="hud-metric__icon" />
        <div class="hud-metric__values">
          <span class="hud-metric__minmax hud-metric__minmax--max">MAX {{ powerMax ? Math.round(powerMax) : '--' }}</span>
          <span class="hud-metric__value">{{ power ?? '--' }}</span>
          <span class="hud-metric__minmax hud-metric__minmax--min">MIN {{ powerMin != null ? Math.round(powerMin) : '--' }}</span>
        </div>
        <span class="hud-metric__unit">W</span>
      </div>

      <div v-else-if="id === 'leftPower'" class="hud-metric">
        <font-awesome-icon icon="arrow-left" class="hud-metric__icon" />
        <div class="hud-metric__values">
          <span class="hud-metric__minmax hud-metric__minmax--max">MAX --</span>
          <span class="hud-metric__value">{{ leftPower ?? '--' }}</span>
          <span class="hud-metric__minmax hud-metric__minmax--min">MIN --</span>
        </div>
        <span class="hud-metric__unit">W L</span>
      </div>

      <div v-else-if="id === 'rightPower'" class="hud-metric">
        <font-awesome-icon icon="arrow-right" class="hud-metric__icon" />
        <div class="hud-metric__values">
          <span class="hud-metric__minmax hud-metric__minmax--max">MAX --</span>
          <span class="hud-metric__value">{{ rightPower ?? '--' }}</span>
          <span class="hud-metric__minmax hud-metric__minmax--min">MIN --</span>
        </div>
        <span class="hud-metric__unit">W R</span>
      </div>

      <div v-else-if="id === 'balance'" class="hud-metric">
        <font-awesome-icon icon="scale-balanced" class="hud-metric__icon" />
        <div class="hud-metric__values">
          <span class="hud-metric__minmax hud-metric__minmax--max">MAX --</span>
          <span class="hud-metric__value">{{ balance ?? '--' }}</span>
          <span class="hud-metric__minmax hud-metric__minmax--min">MIN --</span>
        </div>
        <span class="hud-metric__unit">L/R %</span>
      </div>

      <div v-else-if="id === 'pwrCadence'" class="hud-metric">
        <font-awesome-icon icon="rotate" class="hud-metric__icon" />
        <div class="hud-metric__values">
          <span class="hud-metric__minmax hud-metric__minmax--max">MAX --</span>
          <span class="hud-metric__value">{{ pwrCadence ?? '--' }}</span>
          <span class="hud-metric__minmax hud-metric__minmax--min">MIN --</span>
        </div>
        <span class="hud-metric__unit">PM RPM</span>
      </div>

      <div v-else-if="id === 'fps'" class="hud-metric hud-metric--debug">
        <font-awesome-icon icon="gauge" class="hud-metric__icon" />
        <div class="hud-metric__values">
          <span class="hud-metric__minmax hud-metric__minmax--max">MAX {{ fpsMax || '--' }}</span>
          <span class="hud-metric__value">{{ fps }}</span>
          <span class="hud-metric__minmax hud-metric__minmax--min">MIN {{ fpsMin ?? '--' }}</span>
        </div>
        <span class="hud-metric__unit">FPS</span>
      </div>

      <div v-else-if="id === 'pitch'" class="hud-metric hud-metric--debug">
        <font-awesome-icon icon="arrow-trend-up" class="hud-metric__icon" />
        <div class="hud-metric__values">
          <span class="hud-metric__minmax hud-metric__minmax--max">MAX --</span>
          <span class="hud-metric__value">{{ props.cameraPitch.toFixed(1) }}</span>
          <span class="hud-metric__minmax hud-metric__minmax--min">MIN --</span>
        </div>
        <span class="hud-metric__unit">PITCH</span>
      </div>

      <div v-else-if="id === 'cameraHeight'" class="hud-metric hud-metric--debug">
        <font-awesome-icon icon="mountain" class="hud-metric__icon" />
        <div class="hud-metric__values">
          <span class="hud-metric__minmax hud-metric__minmax--max">MAX --</span>
          <span class="hud-metric__value">{{ props.cameraHeight.toFixed(1) }}</span>
          <span class="hud-metric__minmax hud-metric__minmax--min">MIN --</span>
        </div>
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
  gap: 6px;
  pointer-events: auto;
  position: relative;
  flex-wrap: wrap;
  max-width: calc(100vw - 220px);
  align-items: center;
}

.hud-metric {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--hud-bg);
  clip-path: var(--clip-panel-sm);
  border: 1.5px solid var(--hud-border);
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s;
  position: relative;
}

.hud-metric::before {
  content: '';
  position: absolute;
  inset: 0;
  clip-path: var(--clip-panel-sm);
  border: 1.5px solid var(--hud-border);
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
  text-shadow: 0 0 8px rgba(var(--accent-rgb), 0.4);
  font-variant-numeric: tabular-nums;
  min-width: 36px;
  text-align: right;
  letter-spacing: 0.5px;
  line-height: 1;
}

.hud-metric__values {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.hud-metric__minmax {
  font-family: var(--font-body);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  letter-spacing: 0.5px;
  color: var(--hud-cyan);
}

.hud-metric__minmax--max { color: var(--hud-text-bright); opacity: 0.7; }
.hud-metric__minmax--min { color: var(--hud-cyan); opacity: 0.5; }

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

/* ── Customize button ── */

.hud-customize-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: var(--hud-bg);
  color: var(--hud-cyan);
  border: 1.5px solid var(--hud-border);
  clip-path: var(--clip-panel-sm);
  cursor: pointer;
  font-size: 13px;
  align-self: center;
  transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
}

.hud-customize-btn:hover,
.hud-customize-btn--open {
  border-color: var(--hud-cyan);
  box-shadow: var(--hud-glow-cyan);
  background: rgba(var(--accent-rgb), 0.12);
}
</style>
