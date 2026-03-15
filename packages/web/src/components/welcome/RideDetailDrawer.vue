<template>
  <el-drawer
    :model-value="open"
    direction="rtl"
    size="640px"
    :with-header="false"
    :append-to-body="true"
    @close="emit('close')"
  >
    <div class="ride-detail__header">
      <h3>
        <font-awesome-icon icon="chart-line" />
        Ride Detail
      </h3>
      <el-button circle @click="emit('close')">
        <font-awesome-icon icon="xmark" />
      </el-button>
    </div>

    <div v-if="ride" class="ride-detail__body">
      <!-- Summary stats -->
      <div class="ride-detail__summary">
        <div class="ride-detail__stat">
          <span class="ride-detail__stat-label">Date</span>
          <span class="ride-detail__stat-value">{{ formatDate(ride.startedAt) }}</span>
        </div>
        <div class="ride-detail__stat">
          <span class="ride-detail__stat-label">Duration</span>
          <span class="ride-detail__stat-value">{{ formatDuration(ride.durationMs) }}</span>
        </div>
        <div class="ride-detail__stat">
          <span class="ride-detail__stat-label">Distance</span>
          <span class="ride-detail__stat-value">{{ (ride.distanceM / 1000).toFixed(2) }} km</span>
        </div>
        <div class="ride-detail__stat">
          <span class="ride-detail__stat-label">
            <font-awesome-icon icon="coins" style="color: #ffd700" />
            Coins
          </span>
          <span class="ride-detail__stat-value ride-detail__stat-value--gold">{{ ride.totalCoins }}</span>
        </div>
      </div>

      <div class="ride-detail__summary">
        <div class="ride-detail__stat">
          <span class="ride-detail__stat-label">Avg HR</span>
          <span class="ride-detail__stat-value" style="color: var(--hud-magenta)">
            {{ ride.avgHr ? Math.round(ride.avgHr) : '--' }} bpm
          </span>
        </div>
        <div class="ride-detail__stat">
          <span class="ride-detail__stat-label">Max HR</span>
          <span class="ride-detail__stat-value" style="color: var(--hud-magenta)">
            {{ ride.maxHr ?? '--' }} bpm
          </span>
        </div>
        <div class="ride-detail__stat">
          <span class="ride-detail__stat-label">Avg Power</span>
          <span class="ride-detail__stat-value" style="color: var(--hud-yellow)">
            {{ ride.avgPowerW ? Math.round(ride.avgPowerW) : '--' }} W
          </span>
        </div>
        <div class="ride-detail__stat">
          <span class="ride-detail__stat-label">Max Power</span>
          <span class="ride-detail__stat-value" style="color: var(--hud-yellow)">
            {{ ride.maxPowerW ? Math.round(ride.maxPowerW) : '--' }} W
          </span>
        </div>
        <div class="ride-detail__stat">
          <span class="ride-detail__stat-label">Avg Speed</span>
          <span class="ride-detail__stat-value" style="color: var(--hud-cyan)">
            {{ ride.avgSpeed ? ride.avgSpeed.toFixed(1) : '--' }} km/h
          </span>
        </div>
        <div class="ride-detail__stat">
          <span class="ride-detail__stat-label">Max Speed</span>
          <span class="ride-detail__stat-value" style="color: var(--hud-cyan)">
            {{ ride.maxSpeed ? ride.maxSpeed.toFixed(1) : '--' }} km/h
          </span>
        </div>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="ride-detail__loading">
        <font-awesome-icon icon="spinner" spin />
        Loading samples...
      </div>

      <!-- Charts -->
      <template v-else-if="samples.length > 0">
        <fieldset class="ride-detail__chart-section">
          <legend>
            <font-awesome-icon icon="chart-line" />
            Time Series
          </legend>
          <svg ref="timeSeriesRef" class="ride-detail__chart" />
        </fieldset>

        <fieldset class="ride-detail__chart-section">
          <legend>
            <font-awesome-icon icon="heart-pulse" />
            HR Zone Distribution
          </legend>
          <svg ref="zoneDistRef" class="ride-detail__chart ride-detail__chart--short" />
        </fieldset>

        <fieldset class="ride-detail__chart-section">
          <legend>
            <font-awesome-icon icon="bolt" />
            Power Distribution
          </legend>
          <svg ref="powerHistRef" class="ride-detail__chart" />
        </fieldset>
      </template>

      <div v-else class="ride-detail__no-data">
        No sample data recorded for this ride.
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import dayjs from 'dayjs';
import type { Ride, RideSample } from '@littlecycling/shared';
import { useSettingsStore } from '@/stores/settingsStore';
import { renderTimeSeriesChart, renderZoneDistribution, renderPowerHistogram } from '@/composables/useRideCharts';

const props = defineProps<{
  open: boolean;
  ride: Ride | null;
  samples: RideSample[];
  loading: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const settingsStore = useSettingsStore();

const timeSeriesRef = ref<SVGElement | null>(null);
const zoneDistRef = ref<SVGElement | null>(null);
const powerHistRef = ref<SVGElement | null>(null);

const CHART_WIDTH = 580;
const CHART_HEIGHT = 240;
const ZONE_HEIGHT = 180;

watch(() => [props.samples, props.open], async () => {
  if (!props.open || props.samples.length === 0) return;

  await nextTick();

  if (timeSeriesRef.value) {
    renderTimeSeriesChart(timeSeriesRef.value, props.samples, CHART_WIDTH, CHART_HEIGHT);
  }
  if (zoneDistRef.value) {
    const hrMax = settingsStore.config.training.hrMax;
    renderZoneDistribution(zoneDistRef.value, props.samples, hrMax, CHART_WIDTH, ZONE_HEIGHT);
  }
  if (powerHistRef.value) {
    renderPowerHistogram(powerHistRef.value, props.samples, CHART_WIDTH, CHART_HEIGHT);
  }
}, { deep: true });

function formatDate(tsEpoch: number): string {
  return dayjs(tsEpoch).format('YYYY-MM-DD HH:mm');
}

function formatDuration(ms?: number): string {
  if (!ms) return '--:--';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
</script>

<style scoped>
:deep(.el-drawer__body) {
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  background: var(--surface);
}

.ride-detail__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--hud-border-bright);
  position: relative;
  flex-shrink: 0;
}

.ride-detail__header::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 20px;
  right: 20px;
  height: 1px;
  background: linear-gradient(90deg, var(--hud-cyan), transparent);
  opacity: 0.5;
}

.ride-detail__header h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 2px;
  text-shadow: 0 0 10px rgba(0,229,255,0.3);
}

.ride-detail__header :deep(.el-button) {
  border-color: var(--hud-border);
  color: var(--hud-cyan);
  border-radius: 0;
}

.ride-detail__body {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
}

.ride-detail__summary {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  background: rgba(0,229,255,0.02);
  border: 1px solid var(--hud-border);
  clip-path: var(--clip-panel-sm);
  padding: 10px 14px;
}

.ride-detail__stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ride-detail__stat-label {
  font-family: var(--font-display);
  font-size: 9px;
  color: rgba(255,255,255,0.4);
  text-transform: uppercase;
  letter-spacing: 1px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.ride-detail__stat-value {
  font-family: var(--font-display);
  font-size: 14px;
  color: var(--hud-text-bright);
  letter-spacing: 1px;
}

.ride-detail__stat-value--gold {
  color: #ffd700;
  text-shadow: 0 0 6px rgba(255,215,0,0.4);
}

.ride-detail__loading {
  text-align: center;
  padding: 30px;
  color: var(--hud-text);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.ride-detail__no-data {
  text-align: center;
  padding: 30px;
  color: rgba(255,255,255,0.35);
  font-size: 12px;
}

.ride-detail__chart-section {
  border: 1px solid var(--hud-border);
  clip-path: var(--clip-panel-sm);
  padding: 10px 12px;
  background: rgba(0,229,255,0.02);
}

.ride-detail__chart-section legend {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 1.5px;
  padding: 0 4px;
}

.ride-detail__chart {
  width: 100%;
  height: 240px;
}

.ride-detail__chart--short {
  height: 180px;
}
</style>
