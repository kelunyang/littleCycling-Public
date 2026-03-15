<template>
  <div class="ride-history">
    <el-collapse v-model="expandedArr">
      <el-collapse-item name="history">
        <template #title>
          <font-awesome-icon icon="clock-rotate-left" style="margin-right: 8px" />
          Ride History
        </template>

        <div class="ride-history__list">
          <div v-if="rides.length === 0" class="ride-history__empty">
            No rides recorded yet.
          </div>

          <div
            v-for="ride in rides"
            :key="ride.id"
            class="ride-history__item"
          >
            <div class="ride-history__info">
              <span class="ride-history__date">{{ formatDate(ride.startedAt) }}</span>
              <span class="ride-history__stats">
                {{ formatDuration(ride.durationMs) }}
                <template v-if="ride.avgHr"> | {{ Math.round(ride.avgHr) }} bpm</template>
                <template v-if="ride.avgPowerW"> | {{ Math.round(ride.avgPowerW) }} W</template>
                <template v-if="ride.avgSpeed"> | {{ ride.avgSpeed.toFixed(1) }} km/h</template>
              </span>
            </div>
            <div class="ride-history__actions">
              <el-button
                size="small"
                title="Export FIT"
                @click="exportFit(ride.id)"
              >
                <font-awesome-icon icon="file-export" />
              </el-button>
              <el-button
                size="small"
                :type="comparisonStore.compareRideId === ride.id ? 'primary' : 'default'"
                :title="comparisonStore.compareRideId === ride.id ? 'Remove comparison' : 'Compare'"
                @click="toggleCompare(ride.id)"
              >
                <font-awesome-icon icon="code-compare" />
              </el-button>
            </div>
          </div>
        </div>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import dayjs from 'dayjs';
import type { Ride } from '@littlecycling/shared';
import { useComparisonStore } from '@/stores/comparisonStore';
import { notifyWarn } from '@/utils/notify';

const comparisonStore = useComparisonStore();
const rides = ref<Ride[]>([]);
const expandedArr = ref<string[]>([]);

async function fetchRides() {
  try {
    const res = await fetch('/api/rides?limit=10');
    if (res.ok) {
      const data = await res.json();
      rides.value = data.rides;
      // Auto-expand if there are rides
      if (data.rides.length > 0) expandedArr.value = ['history'];
    }
  } catch {
    notifyWarn('Failed to load ride history');
  }
}

function exportFit(rideId: number) {
  window.open(`/api/rides/${rideId}/export.fit`, '_blank');
}

function toggleCompare(rideId: number) {
  if (comparisonStore.compareRideId === rideId) {
    comparisonStore.clear();
  } else {
    comparisonStore.selectRide(rideId);
  }
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

onMounted(fetchRides);
</script>

<style scoped>
.ride-history {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

:deep(.el-collapse) {
  border: none;
}

:deep(.el-collapse-item__header) {
  background: transparent;
  border-bottom: 1px solid var(--hud-border);
  color: var(--hud-cyan);
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
}

:deep(.el-collapse-item__wrap) {
  background: transparent;
  border-bottom: none;
}

:deep(.el-collapse-item__content) {
  padding-bottom: 4px;
}

.ride-history__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 200px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(0,229,255,0.3) transparent;
}

.ride-history__empty {
  font-size: 11px;
  color: var(--hud-text);
  opacity: 0.6;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.ride-history__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  background: rgba(0,229,255,0.02);
  border: 1px solid var(--hud-border);
  clip-path: var(--clip-panel-sm);
  font-size: 11px;
}

.ride-history__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ride-history__date {
  color: var(--hud-text-bright);
  font-family: var(--font-display);
  font-weight: 600;
  letter-spacing: 0.5px;
  font-size: 11px;
}

.ride-history__stats {
  color: var(--hud-text);
  opacity: 0.7;
  font-size: 10px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.ride-history__actions {
  display: flex;
  gap: 4px;
}

.ride-history__actions :deep(.el-button) {
  border-color: var(--hud-border);
  border-radius: 0;
}

.ride-history__actions :deep(.el-button--primary) {
  filter: drop-shadow(0 0 6px rgba(0,229,255,0.5));
  border-color: var(--hud-cyan);
}
</style>
