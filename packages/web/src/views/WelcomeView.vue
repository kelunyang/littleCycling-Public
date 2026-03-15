<template>
  <div class="welcome">
    <div class="welcome__card">
      <header class="welcome__header">
        <h1 class="welcome__title">
          <font-awesome-icon icon="bicycle" />
          littleCycling
        </h1>
      </header>

      <div class="welcome__body">
        <div class="welcome__left">
          <RouteList />
        </div>
        <div class="welcome__right">
          <StartChecklist />
        </div>
      </div>

      <div v-if="routeStore.activeRoute" class="welcome__preview-row">
        <WorkoutElevationPreview
          :route-points="routeStore.activeRoute.points"
          :workout-segments="workoutPreviewSegments"
          :total-duration-ms="settingsStore.config.training.defaultDuration"
          style="flex: 1; min-width: 0"
        />
        <RoutePreviewMap :route-points="routeStore.activeRoute.points" />
      </div>

      <footer class="welcome__footer">
        <span>Kelunyang@2026 by claude with <font-awesome-icon icon="heart" class="welcome__heart" /></span>
        <a href="https://github.com/kelunyang/littleCycling" target="_blank" rel="noopener noreferrer" class="welcome__github-link">
          <font-awesome-icon :icon="['fab', 'github']" />
          GitHub
        </a>
      </footer>

      <div class="welcome__top-btns">
        <el-button class="welcome__top-btn" circle @click="calendar.open()">
          <font-awesome-icon icon="calendar-days" />
        </el-button>
        <el-button class="welcome__top-btn" circle @click="settingsOpen = true">
          <font-awesome-icon icon="gear" />
        </el-button>
      </div>
    </div>

    <SettingsPanel :open="settingsOpen" @close="settingsOpen = false" />
    <TrainingCalendar :open="calendar.isOpen.value" @close="calendar.close()" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { buildWorkoutSegments, WORKOUT_PROFILES_MAP } from '@littlecycling/shared';
import RouteList from '@/components/welcome/RouteList.vue';
import StartChecklist from '@/components/welcome/StartChecklist.vue';
import SettingsPanel from '@/components/welcome/SettingsPanel.vue';
import TrainingCalendar from '@/components/welcome/TrainingCalendar.vue';
import WorkoutElevationPreview from '@/components/welcome/WorkoutElevationPreview.vue';
import RoutePreviewMap from '@/components/welcome/RoutePreviewMap.vue';
import { useRouteStore } from '@/stores/routeStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useGameStore } from '@/stores/gameStore';
import { useWebSocket } from '@/composables/useWebSocket';
import { useCalendar } from '@/composables/useCalendar';

const routeStore = useRouteStore();
const settingsStore = useSettingsStore();
const gameStore = useGameStore();
const ws = useWebSocket();
const settingsOpen = ref(false);
const calendar = useCalendar();

const workoutPreviewSegments = computed(() => {
  const profile = WORKOUT_PROFILES_MAP[gameStore.selectedWorkoutId];
  if (!profile) return [];
  return buildWorkoutSegments(profile, settingsStore.config.training.defaultDuration);
});

onMounted(() => {
  routeStore.fetchRoutes();
  settingsStore.fetchConfig();
  ws.connect();
});
</script>

<style scoped>
.welcome {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: stretch;
  justify-content: center;
  background: radial-gradient(ellipse at center, #1a1a3e 0%, #0a0a1a 70%);
  position: relative;
  padding: 24px;
  box-sizing: border-box;
}

/* Background grid */
.welcome::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    repeating-linear-gradient(0deg, transparent, transparent 39px, rgba(0,229,255,0.03) 39px, rgba(0,229,255,0.03) 40px),
    repeating-linear-gradient(90deg, transparent, transparent 39px, rgba(0,229,255,0.03) 39px, rgba(0,229,255,0.03) 40px);
  pointer-events: none;
}

.welcome__card {
  position: relative;
  width: 100%;
  max-width: 960px;
  background: var(--surface);
  border: 1px solid var(--hud-border-bright);
  clip-path: var(--clip-panel-lg);
  padding: 24px 28px;
  filter: drop-shadow(0 0 8px rgba(0,229,255,0.4)) drop-shadow(0 0 30px rgba(0,229,255,0.15));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Scanline overlay */
.welcome__card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0,229,255,0.015) 2px,
    rgba(0,229,255,0.015) 4px
  );
  pointer-events: none;
  z-index: 1;
  animation: scanline-drift 8s linear infinite;
}

/* Top accent neon line */
.welcome__card::after {
  content: '';
  position: absolute;
  top: 0;
  left: 20px;
  right: 20px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--hud-cyan), transparent);
  opacity: 0.6;
}

.welcome__header {
  text-align: center;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--hud-border);
  flex-shrink: 0;
}

.welcome__title {
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 800;
  color: var(--hud-cyan);
  text-shadow: 0 0 20px rgba(0,229,255,0.5);
  text-transform: uppercase;
  letter-spacing: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  animation: glitch-flicker 4s ease-in-out infinite;
}

.welcome__body {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  flex: 1;
  min-height: 0;
}

.welcome__left,
.welcome__right {
  overflow-y: auto;
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: rgba(0,229,255,0.2) transparent;
}

.welcome__top-btns {
  position: absolute;
  top: 16px;
  right: 16px;
  display: flex;
  gap: 6px;
}

.welcome__top-btn {
  font-size: 18px;
  color: var(--hud-cyan);
  border-color: var(--hud-border);
  background: rgba(0,229,255,0.05);
}

.welcome__footer {
  text-align: center;
  margin-top: 12px;
  padding-top: 8px;
  flex-shrink: 0;
  border-top: 1px solid var(--hud-border);
  font-family: var(--font-display);
  font-size: 11px;
  color: rgba(0, 229, 255, 0.4);
  letter-spacing: 2px;
  text-transform: uppercase;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.welcome__github-link {
  color: rgba(0, 229, 255, 0.4);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: color 0.2s, filter 0.2s;
}

.welcome__github-link:hover {
  color: var(--hud-cyan);
  filter: drop-shadow(0 0 4px rgba(0, 229, 255, 0.5));
}

.welcome__heart {
  color: var(--hud-magenta, #ff0066);
}

.welcome__preview-row {
  display: flex;
  gap: 8px;
  align-items: stretch;
  flex-shrink: 0;
}

.welcome__top-btn:hover {
  border-color: var(--hud-cyan);
  filter: drop-shadow(0 0 6px rgba(0,229,255,0.5));
}
</style>
