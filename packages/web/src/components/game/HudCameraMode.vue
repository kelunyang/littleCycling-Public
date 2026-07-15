<template>
  <el-segmented
    v-model="mode"
    :options="OPTIONS"
    class="hud-camera-mode"
    size="small"
  >
    <template #default="{ item }">
      <span class="hud-camera-mode__item">
        <font-awesome-icon :icon="item.icon" />
        <span class="hud-camera-mode__label">{{ item.label }}</span>
      </span>
    </template>
  </el-segmented>
</template>

<script setup lang="ts">
/**
 * Camera view switch — the demos' 視角 button, as a segmented control.
 *
 * Lives at bottom-centre, and only when that slot is free: a workout or random
 * event owns the same spot, and those are what the rider is supposed to be
 * looking at (see Hud.vue).
 */
import { computed } from 'vue';
import { useGameStore } from '@/stores/gameStore';

const OPTIONS = [
  { label: '跟車', value: 'third', icon: 'bicycle' },
  { label: '自由', value: 'orbit', icon: 'rotate' },
] as const;

const gameStore = useGameStore();

const mode = computed({
  get: () => gameStore.cameraMode,
  set: (v: 'third' | 'orbit') => {
    gameStore.cameraMode = v;
  },
});
</script>

<style scoped>
.hud-camera-mode {
  /* The HUD is pointer-events: none; this is one of the few things you click. */
  pointer-events: auto;
  background: rgba(var(--hud-bg-rgb, 5, 8, 16), 0.55);
  border: 1.5px solid var(--hud-cyan);
  border-radius: 999px;
  padding: 2px;
  backdrop-filter: blur(4px);
}

.hud-camera-mode__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  letter-spacing: 0.05em;
}

.hud-camera-mode__label {
  line-height: 1;
}

/* Element Plus paints its own greys; hand the segmented control over to the
   HUD's palette so it reads as part of the game, not the settings drawer. */
.hud-camera-mode :deep(.el-segmented__item) {
  color: var(--hud-text-dim, #7a8a99);
  border-radius: 999px;
}

.hud-camera-mode :deep(.el-segmented__item.is-selected) {
  color: var(--hud-bg, #050810);
}

.hud-camera-mode :deep(.el-segmented__item-selected) {
  background: var(--hud-cyan);
  border-radius: 999px;
}
</style>
