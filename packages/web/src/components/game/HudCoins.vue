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
.hud-coins {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--hud-bg);
  clip-path: var(--clip-panel-sm);
  border: 1px solid rgba(252, 238, 9, 0.25);
  pointer-events: auto;
  transition: transform 0.15s ease;
}

.hud-coins--pulse {
  animation: coin-grow 0.3s ease;
  box-shadow: var(--hud-glow-yellow);
}

@keyframes coin-grow {
  0% {
    transform: scale(1);
  }
  40% {
    transform: scale(1.25);
  }
  100% {
    transform: scale(1);
  }
}

.hud-coins__icon {
  color: var(--accent-coin);
  font-size: 16px;
  filter: drop-shadow(0 0 4px rgba(252, 238, 9, 0.6));
}

.hud-coins__count {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  color: var(--accent-coin);
  text-shadow: 0 0 10px rgba(252, 238, 9, 0.5);
  font-variant-numeric: tabular-nums;
  letter-spacing: 1px;
}

.hud-coins__combo {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  color: var(--accent-coin);
  background: rgba(252, 238, 9, 0.12);
  padding: 2px 8px;
  clip-path: var(--clip-panel-sm);
  text-shadow: 0 0 6px rgba(252, 238, 9, 0.4);
  letter-spacing: 0.5px;
}
</style>
