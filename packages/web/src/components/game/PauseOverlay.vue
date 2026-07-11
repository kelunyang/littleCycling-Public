<template>
  <div v-if="visible" class="pause-overlay" @click.self="emit('resume')">
    <div class="pause-overlay__panel">
      <font-awesome-icon icon="pause" class="pause-overlay__icon" />
      <h2 class="pause-overlay__title">PAUSED</h2>
      <p class="pause-overlay__hint">
        Press <kbd class="pause-overlay__key">SPACE</kbd> to resume
      </p>

      <div class="pause-overlay__actions">
        <button class="pause-overlay__btn pause-overlay__btn--primary" @click="emit('resume')">
          <font-awesome-icon icon="play" />
          RESUME
        </button>
        <button class="pause-overlay__btn pause-overlay__btn--ghost" @click="customizing = true">
          <font-awesome-icon icon="gear" />
          HUD
        </button>
        <button class="pause-overlay__btn pause-overlay__btn--danger" @click="emit('stop')">
          <font-awesome-icon icon="stop" />
          END
        </button>
      </div>
    </div>

    <HudCustomizePanel
      v-if="customizing"
      mode="modal"
      @close="customizing = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import HudCustomizePanel from './HudCustomizePanel.vue';

defineProps<{ visible: boolean }>();
const emit = defineEmits<{ resume: []; stop: [] }>();

const customizing = ref(false);
</script>

<style scoped>
.pause-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
  z-index: 25;
  pointer-events: auto;
  animation: pause-overlay-fade 0.2s ease-out;
}

@keyframes pause-overlay-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.pause-overlay__panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 28px 36px;
  background: var(--hud-bg);
  border: 1.5px solid var(--hud-border-bright);
  clip-path: var(--clip-panel-sm);
  box-shadow: 0 0 24px rgba(var(--accent-rgb), 0.22);
  min-width: 320px;
}

.pause-overlay__icon {
  font-size: 36px;
  color: #ffd700;
  filter: drop-shadow(0 0 12px rgba(255, 215, 0, 0.6));
}

.pause-overlay__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 6px;
  color: var(--hud-text-bright);
  text-shadow: 0 0 12px rgba(var(--accent-rgb), 0.5);
}

.pause-overlay__hint {
  margin: 0;
  font-family: var(--font-body);
  font-size: 12px;
  color: var(--hud-text);
  opacity: 0.75;
  letter-spacing: 1px;
}

.pause-overlay__key {
  display: inline-block;
  padding: 1px 6px;
  border: 1.5px solid var(--hud-border-bright);
  border-radius: 3px;
  font-family: var(--font-display);
  font-size: 11px;
  color: var(--hud-cyan);
  background: rgba(var(--accent-rgb), 0.08);
  margin: 0 2px;
}

.pause-overlay__actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.pause-overlay__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 2px;
  cursor: pointer;
  clip-path: var(--clip-panel-sm);
  transition: background 0.15s, box-shadow 0.15s, border-color 0.15s;
}

.pause-overlay__btn--primary {
  background: rgba(var(--accent-rgb), 0.15);
  color: var(--hud-cyan);
  border: 1.5px solid rgba(var(--accent-rgb), 0.45);
  text-shadow: 0 0 6px rgba(var(--accent-rgb), 0.5);
}

.pause-overlay__btn--primary:hover {
  background: rgba(var(--accent-rgb), 0.25);
  box-shadow: var(--hud-glow-cyan);
}

.pause-overlay__btn--ghost {
  background: transparent;
  color: var(--hud-text-bright);
  border: 1.5px solid var(--hud-border);
}

.pause-overlay__btn--ghost:hover {
  border-color: var(--hud-cyan);
  background: rgba(var(--accent-rgb), 0.08);
}

.pause-overlay__btn--danger {
  background: rgba(255, 45, 107, 0.15);
  color: var(--hud-magenta);
  border: 1.5px solid rgba(255, 45, 107, 0.45);
  text-shadow: 0 0 6px rgba(255, 45, 107, 0.5);
}

.pause-overlay__btn--danger:hover {
  background: rgba(255, 45, 107, 0.25);
  box-shadow: var(--hud-glow-magenta);
}
</style>
