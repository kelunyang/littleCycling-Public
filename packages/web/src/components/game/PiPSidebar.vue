<template>
  <div class="pip-sidebar">
    <div class="pip-sidebar__metric pip-sidebar__metric--hr" :style="{ borderColor: zoneColor }">
      <font-awesome-icon icon="heart" class="pip-sidebar__icon" :style="{ color: zoneColor }" />
      <span class="pip-sidebar__value">{{ hr ?? '--' }}</span>
      <span class="pip-sidebar__unit">BPM</span>
      <span v-if="currentZone" class="pip-sidebar__zone" :style="{ color: zoneColor }">
        Z{{ currentZone.zone }}
      </span>
    </div>

    <div class="pip-sidebar__metric">
      <font-awesome-icon icon="gauge" class="pip-sidebar__icon" />
      <span class="pip-sidebar__value">{{ speed ?? '--' }}</span>
      <span class="pip-sidebar__unit">KM/H</span>
    </div>

    <div class="pip-sidebar__metric">
      <font-awesome-icon icon="bolt" class="pip-sidebar__icon" />
      <span class="pip-sidebar__value">{{ power ?? '--' }}</span>
      <span class="pip-sidebar__unit">W</span>
    </div>

    <div class="pip-sidebar__metric">
      <font-awesome-icon icon="rotate" class="pip-sidebar__icon" />
      <span class="pip-sidebar__value">{{ cadence ?? '--' }}</span>
      <span class="pip-sidebar__unit">RPM</span>
    </div>

    <div class="pip-sidebar__metric">
      <font-awesome-icon icon="flag" class="pip-sidebar__icon" />
      <span class="pip-sidebar__value">{{ gameStore.laps + 1 }}</span>
      <span class="pip-sidebar__unit">LAP</span>
    </div>

    <div class="pip-sidebar__divider" />

    <div class="pip-sidebar__progress">
      <span class="pip-sidebar__time">{{ formatDuration(elapsedMs) }}</span>
      <span class="pip-sidebar__time-sep">/</span>
      <span class="pip-sidebar__time">{{ formatDuration(gameStore.targetDurationMs) }}</span>
      <div class="pip-sidebar__bar">
        <div class="pip-sidebar__bar-fill" :style="{ width: progressPct + '%' }" />
      </div>
    </div>

    <button class="pip-sidebar__stop" @click="emit('stop')">
      <font-awesome-icon icon="stop" />
      STOP
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { getHrZone } from '@littlecycling/shared';
import { useGameStore } from '@/stores/gameStore';
import { useSensorStore } from '@/stores/sensorStore';
import { useSettingsStore } from '@/stores/settingsStore';

const props = defineProps<{
  elapsedMs: number;
  distanceTraveled: number;
}>();

const emit = defineEmits<{ stop: [] }>();

const gameStore = useGameStore();
const sensorStore = useSensorStore();
const settingsStore = useSettingsStore();

const ZONE_COLORS = ['var(--zone-1)', 'var(--zone-2)', 'var(--zone-3)', 'var(--zone-4)', 'var(--zone-5)'];

const hr = computed(() => sensorStore.hr?.heartRate ?? null);
const speed = computed(() => {
  const v = sensorStore.sc?.speed;
  return v != null ? v.toFixed(1) : null;
});
const power = computed(() => sensorStore.pwr?.power ?? null);
const cadence = computed(() => sensorStore.sc?.cadence ?? null);

const currentZone = computed(() => {
  const heartRate = hr.value;
  if (heartRate == null) return null;
  return getHrZone(heartRate, settingsStore.config.training.hrMax);
});

const zoneColor = computed(() => {
  if (!currentZone.value) return 'var(--hud-cyan)';
  return ZONE_COLORS[currentZone.value.zone - 1] ?? 'var(--hud-cyan)';
});

const progressPct = computed(() => {
  if (gameStore.targetDurationMs <= 0) return 0;
  return Math.min(100, (props.elapsedMs / gameStore.targetDurationMs) * 100);
});

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
</script>

<style scoped>
.pip-sidebar {
  position: absolute;
  top: 0;
  right: 0;
  width: 140px;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 8px 10px;
  background: rgba(5, 8, 16, 0.85);
  border-left: 1px solid var(--hud-border);
  pointer-events: auto;
  box-sizing: border-box;
}

.pip-sidebar__metric {
  display: flex;
  align-items: baseline;
  gap: 4px;
  padding: 2px 0;
}

.pip-sidebar__metric--hr {
  border-left: 3px solid var(--hud-cyan);
  padding-left: 6px;
}

.pip-sidebar__icon {
  color: var(--hud-cyan);
  font-size: 10px;
  width: 14px;
  flex-shrink: 0;
}

.pip-sidebar__value {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  color: var(--hud-text);
  text-shadow: 0 0 6px rgba(0, 255, 255, 0.3);
  line-height: 1;
}

.pip-sidebar__unit {
  font-family: var(--font-display);
  font-size: 9px;
  color: rgba(224, 240, 255, 0.5);
  letter-spacing: 1px;
}

.pip-sidebar__zone {
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  margin-left: auto;
}

.pip-sidebar__divider {
  height: 1px;
  background: var(--hud-border);
  margin: 4px 0;
}

.pip-sidebar__progress {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
}

.pip-sidebar__time {
  font-family: var(--font-display);
  font-size: 12px;
  color: var(--hud-cyan);
}

.pip-sidebar__time-sep {
  font-size: 10px;
  color: rgba(224, 240, 255, 0.4);
  margin: 0 1px;
}

.pip-sidebar__bar {
  width: 100%;
  height: 4px;
  background: rgba(0, 255, 255, 0.1);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 2px;
}

.pip-sidebar__bar-fill {
  height: 100%;
  background: var(--hud-cyan);
  box-shadow: 0 0 6px var(--hud-cyan);
  transition: width 0.3s ease;
}

.pip-sidebar__stop {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  margin-top: 4px;
  background: rgba(255, 45, 107, 0.15);
  color: var(--hud-magenta);
  border: 1px solid rgba(255, 45, 107, 0.4);
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 2px;
  cursor: pointer;
  transition: background 0.2s;
  text-shadow: 0 0 8px rgba(255, 45, 107, 0.5);
}

.pip-sidebar__stop:hover {
  background: rgba(255, 45, 107, 0.25);
}
</style>
