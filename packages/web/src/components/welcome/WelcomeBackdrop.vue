<template>
  <canvas ref="canvasRef" class="welcome-backdrop" />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, toRef } from 'vue';
import { useWelcomeBackdrop } from '@/composables/useWelcomeBackdrop';
import { useGameStore } from '@/stores/gameStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { WeatherType } from '@/game/phaser/phaser-weather';

const props = withDefaults(
  defineProps<{ styleVariant?: 'plastic' | 'cuphead' | 'circuit' }>(),
  { styleVariant: 'cuphead' },
);

const gameStore = useGameStore();

/** Welcome weather follows the StartChecklist weather selector. `null` = Auto,
 *  which the composable resolves to its fallback (sunny). Anything else maps
 *  directly to a WeatherType. */
const weatherType = computed<WeatherType | null>(() => {
  const v = gameStore.weatherOverride;
  if (v === 'sunny' || v === 'cloudy' || v === 'rainy' || v === 'snowy') return v;
  return null;
});

const canvasRef = ref<HTMLCanvasElement | null>(null);
const settingsStore = useSettingsStore();
const { init } = useWelcomeBackdrop(
  toRef(props, 'styleVariant'),
  weatherType,
  // 世界選項要跟著進預覽:騎士是**看著這張圖**在翻開關的。
  () => settingsStore.config.map.worldOptions,
);

onMounted(async () => {
  if (!canvasRef.value) return;
  await init(canvasRef.value);
});
</script>

<style scoped>
.welcome-backdrop {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
  z-index: 0;
}
</style>
