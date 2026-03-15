<template>
  <Transition name="fade">
    <div v-if="visible" class="zone-warning">
      <font-awesome-icon icon="triangle-exclamation" class="zone-warning__icon" />
      <span class="zone-warning__text">ZONE 5 - BACK OFF</span>
      <div class="zone-warning__scanline"></div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
defineProps<{
  visible: boolean;
}>();
</script>

<style scoped>
.zone-warning {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(255, 45, 107, 0.12);
  pointer-events: none;
}

.zone-warning__icon {
  font-size: 48px;
  color: var(--hud-magenta);
  filter: drop-shadow(0 0 12px rgba(255, 45, 107, 0.8));
  animation: pulse 0.8s ease-in-out infinite alternate;
}

.zone-warning__text {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 800;
  color: var(--hud-magenta);
  text-shadow: 0 0 20px rgba(255, 45, 107, 0.7), 0 0 40px rgba(255, 45, 107, 0.3);
  letter-spacing: 4px;
  text-transform: uppercase;
}

.zone-warning__scanline {
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(255, 45, 107, 0.03) 2px,
    rgba(255, 45, 107, 0.03) 4px
  );
  pointer-events: none;
  animation: scanline-scroll 4s linear infinite;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@keyframes pulse {
  from { opacity: 0.6; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1.05); }
}

@keyframes scanline-scroll {
  from { background-position: 0 0; }
  to { background-position: 0 100px; }
}
</style>
