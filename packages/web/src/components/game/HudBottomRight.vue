<template>
  <div class="hud-bottom-right">
    <Minimap
      :route-points="routePoints"
      :ball-lat="ballLat"
      :ball-lon="ballLon"
      :bearing="ballBearing"
    />
    <button class="hud-stop" @click="emit('stop')">
      <font-awesome-icon icon="stop" />
      END
    </button>
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
}>();

const emit = defineEmits<{ stop: [] }>();
</script>

<style scoped>
.hud-bottom-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  pointer-events: auto;
}

.hud-stop {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  background: rgba(255, 45, 107, 0.15);
  color: var(--hud-magenta);
  border: 1px solid rgba(255, 45, 107, 0.4);
  clip-path: var(--clip-panel-sm);
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 2px;
  cursor: pointer;
  transition: background 0.2s, box-shadow 0.2s;
  text-shadow: 0 0 8px rgba(255, 45, 107, 0.5);
}

.hud-stop:hover {
  background: rgba(255, 45, 107, 0.25);
  box-shadow: var(--hud-glow-magenta);
}
</style>
