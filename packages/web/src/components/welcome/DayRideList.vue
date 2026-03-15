<template>
  <div class="day-rides">
    <div class="day-rides__header">
      <el-button size="small" @click="emit('back')">
        <font-awesome-icon icon="arrow-left" />
      </el-button>
      <span class="day-rides__date">{{ formattedDate }}</span>
    </div>

    <div v-if="rides.length === 0" class="day-rides__empty">
      <font-awesome-icon icon="bicycle" style="opacity: 0.3; font-size: 24px" />
      <span>No rides on this day</span>
    </div>

    <div v-else class="day-rides__list">
      <div
        v-for="ride in rides"
        :key="ride.id"
        class="day-rides__card"
        @click="emit('select-ride', ride)"
      >
        <div class="day-rides__card-top">
          <span class="day-rides__time">
            <font-awesome-icon icon="clock" />
            {{ formatTime(ride.startedAt) }}
          </span>
          <span class="day-rides__duration">{{ formatDuration(ride.durationMs) }}</span>
        </div>

        <div class="day-rides__card-stats">
          <span v-if="ride.avgHr" class="day-rides__stat">
            <font-awesome-icon icon="heart-pulse" style="color: var(--hud-magenta)" />
            {{ Math.round(ride.avgHr) }} bpm
          </span>
          <span v-if="ride.avgPowerW" class="day-rides__stat">
            <font-awesome-icon icon="bolt" style="color: var(--hud-yellow)" />
            {{ Math.round(ride.avgPowerW) }} W
          </span>
          <span v-if="ride.avgSpeed" class="day-rides__stat">
            <font-awesome-icon icon="gauge-high" style="color: var(--hud-cyan)" />
            {{ ride.avgSpeed.toFixed(1) }} km/h
          </span>
          <span v-if="ride.totalCoins" class="day-rides__stat">
            <font-awesome-icon icon="coins" style="color: #ffd700" />
            {{ ride.totalCoins }}
          </span>
        </div>

        <div v-if="ride.routeName" class="day-rides__route">
          <font-awesome-icon icon="route" />
          {{ ride.routeName }}
        </div>

        <div class="day-rides__card-actions">
          <el-button size="small" @click.stop="exportFit(ride.id)" title="Export FIT">
            <font-awesome-icon icon="file-export" />
          </el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import dayjs from 'dayjs';
import type { Ride } from '@littlecycling/shared';

const props = defineProps<{
  date: string;
  rides: Ride[];
}>();

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'select-ride', ride: Ride): void;
}>();

const formattedDate = computed(() =>
  dayjs(props.date).format('MMMM D, YYYY')
);

function formatTime(tsEpoch: number): string {
  return dayjs(tsEpoch).format('HH:mm');
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

function exportFit(rideId: number) {
  window.open(`/api/rides/${rideId}/export.fit`, '_blank');
}
</script>

<style scoped>
.day-rides {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.day-rides__header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--hud-border);
}

.day-rides__header :deep(.el-button) {
  border-color: var(--hud-border);
  color: var(--hud-cyan);
}

.day-rides__date {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 1.5px;
}

.day-rides__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 30px 0;
  color: var(--hud-text);
  font-size: 12px;
  opacity: 0.6;
}

.day-rides__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  max-height: 100%;
}

.day-rides__card {
  background: rgba(0,229,255,0.03);
  border: 1px solid var(--hud-border);
  clip-path: var(--clip-panel-sm);
  padding: 10px 14px;
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.day-rides__card:hover {
  background: rgba(0,229,255,0.08);
  border-color: var(--hud-border-bright);
  filter: drop-shadow(0 0 4px rgba(0,229,255,0.3));
}

.day-rides__card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.day-rides__time {
  font-family: var(--font-display);
  font-size: 13px;
  color: var(--hud-text-bright);
  display: flex;
  align-items: center;
  gap: 5px;
}

.day-rides__duration {
  font-family: var(--font-display);
  font-size: 12px;
  color: var(--hud-text);
  letter-spacing: 1px;
}

.day-rides__card-stats {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.day-rides__stat {
  font-size: 11px;
  color: var(--hud-text);
  display: flex;
  align-items: center;
  gap: 4px;
}

.day-rides__route {
  font-size: 10px;
  color: rgba(255,255,255,0.35);
  display: flex;
  align-items: center;
  gap: 5px;
}

.day-rides__card-actions {
  display: flex;
  justify-content: flex-end;
}

.day-rides__card-actions :deep(.el-button) {
  border-color: var(--hud-border);
  color: var(--hud-text);
  font-size: 11px;
}
</style>
