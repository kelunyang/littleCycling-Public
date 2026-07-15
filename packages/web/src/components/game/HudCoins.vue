<template>
  <div class="hud-coins" :class="{ 'hud-coins--pulse': isPulsing }">
    <font-awesome-icon icon="coins" class="hud-coins__icon" />
    <span class="hud-coins__count">{{ gameStore.coins }}</span>
    <span v-if="combo > 1" class="hud-coins__combo">x{{ combo }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useGameStore } from '@/stores/gameStore';

defineProps<{
  combo: number;
}>();

const gameStore = useGameStore();
const isPulsing = ref(false);

// Trigger pulse animation when coins increase
watch(
  () => gameStore.coins,
  (newVal, oldVal) => {
    if (newVal > oldVal) {
      isPulsing.value = true;
      setTimeout(() => {
        isPulsing.value = false;
      }, 300);
    }
  },
);
</script>

<style scoped>
/* Borderless overlay, matching the top metrics — glowing (3D) or embossed (2D)
   coin count floating over the world, no card. */
.hud-coins {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px;
  pointer-events: auto;
  transition: transform 0.15s ease;
}

.hud-coins--pulse {
  animation: coin-grow 0.3s ease;
}

@keyframes coin-grow {
  0% {
    transform: scale(1);
  }
  40% {
    transform: scale(1.25);
    filter: brightness(1.5);
  }
  100% {
    transform: scale(1);
  }
}

/* ── 3D: yellow neon glow ── */
.hud-coins__icon {
  color: var(--accent-coin);
  font-size: 24px;
  filter: drop-shadow(0 0 6px rgba(252, 238, 9, 0.8));
}

.hud-coins__count {
  font-family: var(--font-display);
  font-size: 30px;
  font-weight: 700;
  color: var(--accent-coin);
  text-shadow: 0 0 10px rgba(252, 238, 9, 0.7), 0 0 24px rgba(252, 238, 9, 0.35);
  font-variant-numeric: tabular-nums;
  letter-spacing: 1px;
}

.hud-coins__combo {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  color: var(--accent-coin);
  text-shadow: 0 0 8px rgba(252, 238, 9, 0.6);
  letter-spacing: 0.5px;
}

/* ── 2D: embossed coins ── */
.game-view[data-hud-mode="2d"] .hud-coins__count,
.game-view[data-hud-mode="2d"] .hud-coins__combo {
  text-shadow:
    -1px -1px 0 rgba(255, 255, 255, 0.6),
    1px -1px 0 rgba(255, 255, 255, 0.3),
    -1px 1px 0 rgba(0, 0, 0, 0.25),
    1px 1px 0 rgba(0, 0, 0, 0.45),
    0 2px 3px rgba(0, 0, 0, 0.35);
}

.game-view[data-hud-mode="2d"] .hud-coins__icon {
  filter:
    drop-shadow(-1px -1px 0 rgba(255, 255, 255, 0.5))
    drop-shadow(1px 1px 1px rgba(0, 0, 0, 0.4));
}
</style>
