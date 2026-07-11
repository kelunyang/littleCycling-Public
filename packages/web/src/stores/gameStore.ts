import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { GameState, WorkoutSegment, PlanSegment, RideSummaryDto } from '@littlecycling/shared';
import { WORKOUT_PROFILES_MAP, buildWorkoutSegments, planSegmentsToWorkoutSegments } from '@littlecycling/shared';
import { useGameStateStore } from './gameStateStore';

/**
 * Body for POST /api/live/start, stashed by StartBar and consumed by GameView's
 * beginRide(). Recording is deferred until the start prompt is passed, so the
 * config built on the welcome screen has to survive the navigation to /game.
 */
export interface PendingStart {
  routeId?: string;
  routeName?: string;
  game?: {
    ftp: number;
    hrMax: number;
    trainerModel: string;
    freeRoam: boolean;
    targetDurationMs: number;
    randomEventsEnabled: boolean;
    selectedWorkoutId: string;
  };
}

export type GlassesLens = 'clear' | 'dark' | 'red' | 'yellow' | 'auto';
export type FrameMaterial = 'plastic' | 'metallic' | 'matte';
export type FrameColorMode = 'black' | 'white' | 'gray' | 'red' | 'yellow' | 'random';

function toHex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

function rgb(r: number, g: number, b: number): string {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function resolveFrameColor(mode: FrameColorMode): string {
  const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
  switch (mode) {
    case 'black':
      return '#000000';
    case 'white':
      return '#ffffff';
    case 'gray': {
      const v = rand(70, 190);
      return rgb(v, v, v);
    }
    case 'red':
      return rgb(rand(170, 240), rand(20, 70), rand(20, 70));
    case 'yellow':
      return rgb(rand(210, 250), rand(170, 220), rand(20, 80));
    case 'random':
      return rgb(rand(0, 255), rand(0, 255), rand(0, 255));
  }
}

export const useGameStore = defineStore('game', () => {
  const gameStateStore = useGameStateStore();

  const state = ref<GameState>('welcome');
  // Read-only mirrors of the server-authoritative simulation (P7). The only
  // way these change is a game_state frame — there is no client-side award
  // path left, so display, messages, and audio all follow the server.
  const coins = computed(() => gameStateStore.coinsTotal);
  const laps = computed(() => gameStateStore.laps);
  /** Server summary from /api/live/stop — set by finaliseRide, read by GameSummary. */
  const rideSummary = ref<RideSummaryDto | null>(null);
  const startedAt = ref(0);
  const targetDurationMs = ref(30 * 60 * 1000);
  const freeRoam = ref(false);
  const currentRideId = ref<number | null>(null);
  // Deferred-start config: StartBar stashes the /api/live/start body here and
  // GameView fires it only once the user passes the start prompt, so recording
  // (ride row, jsonl, clock) never begins while the prompt is showing.
  const pendingStart = ref<PendingStart | null>(null);
  const weatherOverride = ref<string | null>(null);
  const cloudsEnabled = ref(false);
  const glassesLens = ref<GlassesLens>('auto');
  const glassesFrameColorMode = ref<FrameColorMode>('black');
  const glassesFrameColor = ref(resolveFrameColor('black'));
  const glassesFrameMaterial = ref<FrameMaterial>('plastic');

  function setFrameColorMode(mode: FrameColorMode) {
    glassesFrameColorMode.value = mode;
    glassesFrameColor.value = resolveFrameColor(mode);
  }
  const selectedWorkoutId = ref<string>('none');
  const workoutSegments = ref<WorkoutSegment[]>([]);
  const isRandomEvent = ref(false);
  const randomEventsEnabled = ref(true);
  const isPaused = ref(false);

  const isPlaying = computed(() => state.value === 'playing');

  /** Plan segments injected from an active training plan (set before startGame). */
  const planDaySegments = ref<PlanSegment[]>([]);

  function startGame(durationMs: number) {
    state.value = 'playing';
    rideSummary.value = null;
    startedAt.value = Date.now();
    targetDurationMs.value = durationMs;
    isPaused.value = true;

    // Priority: plan segments > workout profile > free ride
    if (planDaySegments.value.length > 0) {
      workoutSegments.value = planSegmentsToWorkoutSegments(planDaySegments.value);
    } else {
      const profile = WORKOUT_PROFILES_MAP[selectedWorkoutId.value];
      if (profile) {
        workoutSegments.value = buildWorkoutSegments(profile, durationMs);
      } else {
        workoutSegments.value = [];
      }
    }
  }

  function endGame() {
    state.value = 'ended';
    isPaused.value = false;
  }

  function togglePause() {
    isPaused.value = !isPaused.value;
  }

  function reset() {
    state.value = 'welcome';
    rideSummary.value = null;
    startedAt.value = 0;
    freeRoam.value = false;
    currentRideId.value = null;
    pendingStart.value = null;
    weatherOverride.value = null;
    cloudsEnabled.value = false;
    glassesLens.value = 'auto';
    glassesFrameColorMode.value = 'black';
    glassesFrameColor.value = resolveFrameColor('black');
    glassesFrameMaterial.value = 'plastic';
    selectedWorkoutId.value = 'none';
    workoutSegments.value = [];
    planDaySegments.value = [];
    isRandomEvent.value = false;
    randomEventsEnabled.value = true;
    isPaused.value = false;
  }

  return {
    state, coins, laps, rideSummary, startedAt, targetDurationMs, freeRoam, currentRideId, pendingStart, weatherOverride, cloudsEnabled,
    glassesLens, glassesFrameColor, glassesFrameColorMode, glassesFrameMaterial,
    selectedWorkoutId, workoutSegments, planDaySegments, isRandomEvent, randomEventsEnabled,
    isPaused,
    isPlaying, startGame, endGame, togglePause, reset,
    setFrameColorMode,
  };
});
