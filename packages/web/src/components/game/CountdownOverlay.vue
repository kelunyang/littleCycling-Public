<template>
  <Transition name="countdown-fade">
    <div v-if="countdown" class="countdown" :data-kind="countdown.kind" :data-urgent="countdown.seconds <= 10">
      <div class="countdown__label">
        <font-awesome-icon :icon="countdown.kind === 'finish' ? 'flag-checkered' : 'flag'" />
        <span>{{ countdown.kind === 'finish' ? 'FINISH IN' : 'NEXT PHASE IN' }}</span>
      </div>
      <!-- :key re-triggers the pop animation on every whole-second change -->
      <div :key="countdown.seconds" class="countdown__number">{{ countdown.seconds }}</div>
      <div class="countdown__unit">SEC</div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
defineProps<{
  countdown: { kind: 'segment' | 'finish'; seconds: number } | null;
}>();
</script>

<style scoped>
.countdown {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  /* Non-blocking: the rider still needs to see the road and pedal. No backdrop,
     no pointer capture — just big glowing text floating dead center. */
  pointer-events: none;
  z-index: 40;
  /* Subtle vignette so the number reads over a bright sky/terrain. */
  background: radial-gradient(ellipse at center, rgba(5, 8, 16, 0.35) 0%, rgba(5, 8, 16, 0) 55%);
}

.countdown__label {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 8px;
  padding-left: 8px; /* balance the letter-spacing on the last glyph */
  color: var(--hud-cyan);
  text-shadow: 0 0 16px rgba(var(--accent-rgb), 0.7);
}

.countdown__number {
  font-family: var(--font-display);
  font-size: clamp(120px, 26vw, 340px);
  font-weight: 900;
  line-height: 0.9;
  color: var(--hud-text-bright);
  text-shadow:
    0 0 24px rgba(var(--accent-rgb), 0.85),
    0 0 60px rgba(var(--accent-rgb), 0.55);
  animation: countdown-pop 0.9s cubic-bezier(0.2, 0.9, 0.25, 1);
}

.countdown__unit {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 12px;
  padding-left: 12px;
  color: var(--hud-text);
  opacity: 0.7;
}

/* Finish countdown burns magenta/gold instead of cyan. */
.countdown[data-kind='finish'] .countdown__label {
  color: var(--hud-magenta);
  text-shadow: 0 0 16px rgba(255, 45, 107, 0.7);
}

.countdown[data-kind='finish'] .countdown__number {
  color: #ffd700;
  text-shadow:
    0 0 24px rgba(255, 215, 0, 0.85),
    0 0 60px rgba(255, 45, 107, 0.5);
}

/* Final 10 seconds — everything goes red-hot and pulses harder. */
.countdown[data-urgent='true'] .countdown__number {
  color: #ff2d6b;
  text-shadow:
    0 0 28px rgba(255, 45, 107, 0.95),
    0 0 72px rgba(255, 45, 107, 0.6);
  animation:
    countdown-pop 0.9s cubic-bezier(0.2, 0.9, 0.25, 1),
    countdown-urgent 1s ease-in-out infinite;
}

.countdown[data-urgent='true'] .countdown__label {
  color: #ff2d6b;
  text-shadow: 0 0 16px rgba(255, 45, 107, 0.8);
}

@keyframes countdown-pop {
  0% { transform: scale(2.1); opacity: 0; }
  30% { transform: scale(1); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}

@keyframes countdown-urgent {
  0%, 100% { filter: brightness(1); }
  50% { filter: brightness(1.5); }
}

.countdown-fade-enter-active,
.countdown-fade-leave-active {
  transition: opacity 0.4s ease;
}
.countdown-fade-enter-from,
.countdown-fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .countdown__number { animation: none !important; }
}
</style>
