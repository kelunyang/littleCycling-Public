import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { GameState, WorkoutSegment } from '@littlecycling/shared';
import { WORKOUT_PROFILES_MAP, buildWorkoutSegments } from '@littlecycling/shared';

export type GlassesLens = 'clear' | 'dark' | 'red' | 'yellow' | 'auto';
export type FrameMaterial = 'plastic' | 'metallic' | 'matte';

export const useGameStore = defineStore('game', () => {
  const state = ref<GameState>('welcome');
  const coins = ref(0);
  const laps = ref(0);
  const startedAt = ref(0);
  const targetDurationMs = ref(30 * 60 * 1000);
  const freeRoam = ref(false);
  const currentRideId = ref<number | null>(null);
  const weatherOverride = ref<string | null>(null);
  const cloudsEnabled = ref(false);
  const glassesLens = ref<GlassesLens>('auto');
  const glassesFrameColor = ref('#1a1a1a');
  const glassesFrameMaterial = ref<FrameMaterial>('plastic');
  const selectedWorkoutId = ref<string>('none');
  const workoutSegments = ref<WorkoutSegment[]>([]);

  const isPlaying = computed(() => state.value === 'playing');

  function startGame(durationMs: number) {
    state.value = 'playing';
    coins.value = 0;
    laps.value = 0;
    startedAt.value = Date.now();
    targetDurationMs.value = durationMs;

    // Build workout segments if a workout is selected
    const profile = WORKOUT_PROFILES_MAP[selectedWorkoutId.value];
    if (profile) {
      workoutSegments.value = buildWorkoutSegments(profile, durationMs);
    } else {
      workoutSegments.value = [];
    }
  }

  function endGame() {
    state.value = 'ended';
  }

  function addCoins(amount: number) {
    coins.value += amount;
  }

  function addLap() {
    laps.value++;
  }

  function reset() {
    state.value = 'welcome';
    coins.value = 0;
    laps.value = 0;
    startedAt.value = 0;
    freeRoam.value = false;
    currentRideId.value = null;
    weatherOverride.value = null;
    cloudsEnabled.value = false;
    glassesLens.value = 'auto';
    glassesFrameColor.value = '#1a1a1a';
    glassesFrameMaterial.value = 'plastic';
    selectedWorkoutId.value = 'none';
    workoutSegments.value = [];
  }

  return {
    state, coins, laps, startedAt, targetDurationMs, freeRoam, currentRideId, weatherOverride, cloudsEnabled,
    glassesLens, glassesFrameColor, glassesFrameMaterial,
    selectedWorkoutId, workoutSegments,
    isPlaying, startGame, endGame, addCoins, addLap, reset,
  };
});
