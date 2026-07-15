<template>
  <div class="hud-bottom-right">
    <!-- Glasses lens picker: colour swatches only, glasses icon on the right. -->
    <div class="hud-bottom-right__lens">
      <el-segmented
        v-model="gameStore.glassesLens"
        :options="lensOptions"
        size="small"
        class="lens-segmented"
      >
        <template #default="{ item }">
          <span
            class="lens-swatch"
            :class="`lens-swatch--${item.value}`"
            :title="item.label"
          />
        </template>
      </el-segmented>
      <font-awesome-icon icon="glasses" class="lens-glasses-icon" title="鏡片顏色" />
    </div>

    <Minimap
      :route-points="routePoints"
      :ball-lat="ballLat"
      :ball-lon="ballLon"
      :bearing="ballBearing"
    />
    <div class="hud-bottom-right__buttons">
      <button
        class="hud-pause"
        :class="{
          'hud-pause--paused': pauseState === 'paused',
          'hud-pause--autopaused': pauseState === 'autopaused',
          'hud-pause--counting': pauseState === 'counting',
        }"
        @click="emit('pause')"
      >
        <!-- Idle auto-pause fill: grows toward 30s while stopped, sits full
             (and pulses) once the sim has auto-paused. -->
        <span
          v-if="pauseState === 'counting' || pauseState === 'autopaused'"
          class="hud-pause__fill"
          :style="{ width: pauseState === 'autopaused' ? '100%' : `${idleProgress}%` }"
        />
        <span class="hud-pause__label">
          <font-awesome-icon :icon="pauseIcon" />
          {{ pauseLabel }}
        </span>
      </button>
      <button class="hud-stop" @click="emit('stop')">
        <font-awesome-icon icon="stop" />
        END
      </button>
      <button
        v-if="pipSupported"
        class="hud-pip-icon"
        title="縮小視窗變成一個小格子(PIP mode)"
        @click="emit('pip')"
      >
        <font-awesome-icon icon="window-restore" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { IDLE_AUTOPAUSE_MS, type RoutePoint } from '@littlecycling/shared';
import { useGameStore } from '@/stores/gameStore';
import Minimap from './Minimap.vue';

const props = defineProps<{
  routePoints: RoutePoint[];
  ballLat: number;
  ballLon: number;
  ballBearing: number;
  isPaused: boolean;
  /** ms the rider has been not-pedalling (0 when pedalling or manually paused). */
  idleMs: number;
  /** Sim auto-paused after 30s of no pedalling (distinct from manual pause). */
  autoPaused: boolean;
  /** Whether Document Picture-in-Picture is available (shows the PIP button). */
  pipSupported: boolean;
}>();

const emit = defineEmits<{ stop: []; pause: []; pip: [] }>();

const gameStore = useGameStore();

// Lens picker options — labels drive the swatch tooltips; the swatch colour is
// keyed off `value` in CSS (see .lens-swatch--*).
const lensOptions = [
  { label: 'Clear', value: 'clear' },
  { label: 'Dark', value: 'dark' },
  { label: 'Red', value: 'red' },
  { label: 'Yellow', value: 'yellow' },
  { label: 'Auto', value: 'auto' },
];

// Four mutually-exclusive looks for the one button. Manual pause wins (it also
// raises the PauseOverlay); then the auto-pause states derived from idle time.
const pauseState = computed<'paused' | 'autopaused' | 'counting' | 'normal'>(() => {
  if (props.isPaused) return 'paused';
  if (props.autoPaused) return 'autopaused';
  if (props.idleMs > 0) return 'counting';
  return 'normal';
});

const idleProgress = computed(() =>
  Math.min(100, (props.idleMs / IDLE_AUTOPAUSE_MS) * 100),
);

const remainSec = computed(() =>
  Math.ceil(Math.max(0, IDLE_AUTOPAUSE_MS - props.idleMs) / 1000),
);

const pauseIcon = computed(() => {
  switch (pauseState.value) {
    case 'paused': return 'play';
    case 'autopaused': return 'play';
    case 'counting': return 'couch';
    default: return 'pause';
  }
});

const pauseLabel = computed(() => {
  switch (pauseState.value) {
    case 'paused': return 'RESUME';
    case 'autopaused': return '踩踏繼續';
    case 'counting': return `${remainSec.value}s`;
    default: return 'PAUSE';
  }
});
</script>

<style scoped>
.hud-bottom-right {
  /* Fixed block width so the lens picker, minimap and button row always line
     up — the pause button no longer grows/shrinks the column as its label
     changes, and there's room for the END + PIP buttons beside it. */
  width: 210px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  pointer-events: auto;
}

/* Stretch the minimap to the block width (aspect ratio preserved via the
   SVG's xMidYMid meet — extra width just letterboxes on the dark backdrop). */
.hud-bottom-right :deep(.minimap-container) {
  width: 100%;
}

/* ── Glasses lens picker: colour swatches + glasses icon on the right ── */
.hud-bottom-right__lens {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
}

.lens-segmented {
  flex: 1;
  --el-border-radius-base: 0;
  /* Strip Element Plus' track fill/border so only the swatches read as the
     control — no boxed frame around them. */
  background: transparent !important;
  border: none !important;
  box-shadow: none !important;
  padding: 0 !important;
}

.lens-segmented :deep(.el-segmented__item) {
  padding: 0 4px;
}

/* Element Plus elevates the selected item with a box-shadow — drop it. */
.lens-segmented :deep(.el-segmented__item-selected) {
  box-shadow: none;
}

.lens-glasses-icon {
  flex-shrink: 0;
  color: var(--hud-cyan);
  font-size: 14px;
  filter: drop-shadow(0 0 4px rgba(0, 255, 255, 0.4));
}

/* Swatch = the lens colour itself (see cycling-glasses-effect LENS_PRESETS). */
.lens-swatch {
  display: block;
  width: 18px;
  height: 12px;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.25);
}
.lens-swatch--clear { background: rgba(255, 255, 255, 0.85); }
.lens-swatch--dark { background: #5a5a66; }
.lens-swatch--red { background: #ff4d33; }
.lens-swatch--yellow { background: #ffe94d; }
/* Auto follows the weather — blend the tinted lenses to signal "it varies". */
.lens-swatch--auto {
  background: linear-gradient(135deg, #5a5a66 0%, #ff4d33 50%, #ffe94d 100%);
}

.hud-bottom-right__buttons {
  display: flex;
  gap: 6px;
}

.hud-stop,
.hud-pause,
.hud-pip-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 10px;
  clip-path: var(--clip-panel-sm);
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 2px;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.2s, box-shadow 0.2s;
}

/* PIP: icon-only shortcut sitting beside END. */
.hud-pip-icon {
  flex-shrink: 0;
  font-size: 13px;
  background: rgba(0, 255, 255, 0.1);
  color: var(--hud-cyan);
  border: 1.5px solid rgba(0, 255, 255, 0.3);
  text-shadow: 0 0 8px rgba(0, 255, 255, 0.4);
}

.hud-pip-icon:hover {
  background: rgba(0, 255, 255, 0.2);
  box-shadow: var(--hud-glow-cyan);
}

/* Pause takes the leftover width; its size stays constant across every state
   (PAUSE / countdown / auto-paused / RESUME). END keeps its natural width. */
.hud-pause {
  flex: 1;
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
  position: relative;
  overflow: hidden;
  background: rgba(var(--accent-rgb), 0.12);
  color: var(--hud-cyan);
  border: 1.5px solid rgba(var(--accent-rgb), 0.4);
  text-shadow: 0 0 8px rgba(var(--accent-rgb), 0.5);
}

.hud-pause:hover {
  background: rgba(var(--accent-rgb), 0.22);
  box-shadow: var(--hud-glow-cyan);
}

/* Content sits above the countdown fill. */
.hud-pause__label {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Idle countdown fill — grows left→right toward the 30s auto-pause. */
.hud-pause__fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: rgba(255, 45, 107, 0.35);
  box-shadow: 0 0 8px rgba(255, 45, 107, 0.4);
  transition: width 0.3s linear;
  z-index: 0;
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

/* Stopped-pedalling: magenta-tinted, filling toward auto-pause. */
.hud-pause--counting {
  background: rgba(255, 45, 107, 0.12);
  color: var(--hud-magenta);
  border-color: rgba(255, 45, 107, 0.45);
  text-shadow: 0 0 8px rgba(255, 45, 107, 0.5);
}

.hud-pause--counting:hover {
  background: rgba(255, 45, 107, 0.2);
  box-shadow: var(--hud-glow-magenta);
}

/* Auto-paused: full magenta fill that pulses to invite a pedal stroke. */
.hud-pause--autopaused {
  background: rgba(255, 45, 107, 0.18);
  color: var(--hud-text-bright);
  border-color: rgba(255, 45, 107, 0.6);
  text-shadow: 0 0 8px rgba(255, 45, 107, 0.6);
}

.hud-pause--autopaused .hud-pause__fill {
  animation: hud-pause-pulse 1.2s ease-in-out infinite;
}

.hud-pause--autopaused:hover {
  background: rgba(255, 45, 107, 0.28);
}

@keyframes hud-pause-pulse {
  0%, 100% { filter: brightness(1); }
  50% { filter: brightness(1.7); }
}

@media (prefers-reduced-motion: reduce) {
  .hud-pause--autopaused .hud-pause__fill { animation: none; }
}
</style>
