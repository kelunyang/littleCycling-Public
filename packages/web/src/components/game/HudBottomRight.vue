<template>
  <div class="hud-bottom-right">
    <Minimap
      :route-points="routePoints"
      :ball-lat="ballLat"
      :ball-lon="ballLon"
      :bearing="ballBearing"
    />
    <div class="hud-bottom-right__buttons">
      <button
        class="hud-pause"
        :class="{ 'hud-pause--paused': isPaused }"
        @click="emit('pause')"
      >
        <font-awesome-icon :icon="isPaused ? 'play' : 'pause'" />
        {{ isPaused ? 'RESUME' : 'PAUSE' }}
      </button>
      <button class="hud-stop" @click="emit('stop')">
        <font-awesome-icon icon="stop" />
        END
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { RoutePoint } from '@littlecycling/shared';
import Minimap from './Minimap.vue';

defineProps<{
  routePoints: RoutePoint[];
  ballLat: number;
  ballLon: number;
  ballBearing: number;
  isPaused: boolean;
}>();

const emit = defineEmits<{ stop: []; pause: [] }>();
</script>

<style scoped>
.hud-bottom-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  pointer-events: auto;
}

.hud-bottom-right__buttons {
  display: flex;
  gap: 6px;
}

.hud-stop,
.hud-pause {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  clip-path: var(--clip-panel-sm);
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 2px;
  cursor: pointer;
  transition: background 0.2s, box-shadow 0.2s;
}

.hud-stop {
  background: rgba(255, 45, 107, 0.15);
  color: var(--hud-magenta);
  border: 1.5px solid rgba(255, 45, 107, 0.4);
  text-shadow: 0 0 8px rgba(255, 45, 107, 0.5);
}

.hud-stop:hover {
  background: rgba(255, 45, 107, 0.25);
  box-shadow: var(--hud-glow-magenta);
}

.hud-pause {
  background: rgba(var(--accent-rgb), 0.12);
  color: var(--hud-cyan);
  border: 1.5px solid rgba(var(--accent-rgb), 0.4);
  text-shadow: 0 0 8px rgba(var(--accent-rgb), 0.5);
}

.hud-pause:hover {
  background: rgba(var(--accent-rgb), 0.22);
  box-shadow: var(--hud-glow-cyan);
}

.hud-pause--paused {
  background: rgba(255, 215, 0, 0.18);
  color: #ffd700;
  border-color: rgba(255, 215, 0, 0.55);
  text-shadow: 0 0 8px rgba(255, 215, 0, 0.55);
  animation: neon-pulse-border 1.6s ease-in-out infinite;
}

.hud-pause--paused:hover {
  background: rgba(255, 215, 0, 0.28);
}
</style>
