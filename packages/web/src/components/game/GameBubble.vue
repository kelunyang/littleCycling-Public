<template>
  <Transition name="bubble" @after-leave="onAfterLeave">
    <div
      v-if="message"
      :key="message.id"
      class="game-bubble"
      :style="{ '--bubble-color': message.color }"
    >
      <div class="game-bubble__content">
        <font-awesome-icon :icon="message.icon" class="game-bubble__icon" />
        <span class="game-bubble__text">{{ displayedText }}<span v-if="typing" class="game-bubble__cursor">_</span></span>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue';
import type { GameMessage } from '@/composables/useGameMessages';

const props = defineProps<{
  message: GameMessage | null;
}>();

const emit = defineEmits<{
  typewriterDone: [durationMs: number];
}>();

const displayedText = ref('');
const typing = ref(false);

let typeTimer: ReturnType<typeof setInterval> | null = null;

function clearTypeTimer(): void {
  if (typeTimer !== null) {
    clearInterval(typeTimer);
    typeTimer = null;
  }
}

watch(
  () => props.message,
  (msg) => {
    clearTypeTimer();
    if (!msg) {
      displayedText.value = '';
      typing.value = false;
      return;
    }

    // Start typewriter effect
    const fullText = msg.text;
    let charIndex = 0;
    displayedText.value = '';
    typing.value = true;

    typeTimer = setInterval(() => {
      charIndex++;
      displayedText.value = fullText.slice(0, charIndex);

      if (charIndex >= fullText.length) {
        clearTypeTimer();
        typing.value = false;
        // Notify parent that typewriter is done → start dismiss timer
        emit('typewriterDone', msg.durationMs);
      }
    }, 50);
  },
  { immediate: true },
);

function onAfterLeave(): void {
  displayedText.value = '';
  typing.value = false;
}

onUnmounted(() => {
  clearTypeTimer();
});
</script>

<style scoped>
.game-bubble {
  position: absolute;
  top: 76px;
  left: 50%;
  z-index: 11;
  pointer-events: none;
}

.game-bubble__content {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  background: var(--hud-bg);
  border: 1.5px solid var(--bubble-color);
  border-radius: 12px;
  box-shadow: 0 0 12px color-mix(in srgb, var(--bubble-color) 40%, transparent),
              inset 0 0 8px color-mix(in srgb, var(--bubble-color) 10%, transparent);
  transform: translateX(-50%);
  white-space: nowrap;
}

.game-bubble__icon {
  font-size: 18px;
  color: var(--bubble-color);
  filter: drop-shadow(0 0 6px var(--bubble-color));
  flex-shrink: 0;
}

.game-bubble__text {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 1px;
  color: var(--bubble-color);
  text-shadow: 0 0 8px color-mix(in srgb, var(--bubble-color) 50%, transparent);
}

.game-bubble__cursor {
  animation: blink-cursor 0.6s step-end infinite;
  opacity: 0.7;
}

@keyframes blink-cursor {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 0; }
}

/* ── Pop-in / pop-out transitions ── */

.bubble-enter-active {
  animation: bubble-pop-in 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}

.bubble-leave-active {
  animation: bubble-pop-out 0.25s ease-in forwards;
}

@keyframes bubble-pop-in {
  0% {
    opacity: 0;
    transform: translateX(-50%) scale(0.3);
  }
  70% {
    transform: translateX(-50%) scale(1.08);
  }
  100% {
    opacity: 1;
    transform: translateX(-50%) scale(1);
  }
}

@keyframes bubble-pop-out {
  0% {
    opacity: 1;
    transform: translateX(-50%) scale(1);
  }
  100% {
    opacity: 0;
    transform: translateX(-50%) scale(0.5) translateY(-10px);
  }
}
</style>
