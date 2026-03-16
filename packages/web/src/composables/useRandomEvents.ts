/**
 * Random event engine for freeride mode.
 *
 * State machine: idle → active → result → cooldown → idle
 *
 * Picks random events, tracks on-target performance during the challenge,
 * awards coins on success, and pushes messages via the game message system.
 */

import { ref, computed, watch, onUnmounted, type Ref, type ComputedRef } from 'vue';
import {
  type RandomEventDef,
  pickRandomEvent,
  buildEventSegment,
  type WorkoutSegment,
} from '@littlecycling/shared';

// ── Constants ──

const INITIAL_DELAY_MS = 180_000;        // first event after 3 minutes
const COOLDOWN_MIN_MS = 90_000;          // min gap between events
const COOLDOWN_MAX_MS = 180_000;         // max gap between events
const END_GUARD_MS = 60_000;             // don't start events within 60s of game end
const POWER_TOLERANCE = 0.10;            // ±10% for power on-target
const CADENCE_TOLERANCE = 0.15;          // ±15% for cadence on-target
const CHECK_INTERVAL_MS = 1_000;         // check eligibility every second
const RESULT_DISPLAY_MS = 3_000;         // show result message before cooldown

type EventState = 'idle' | 'active' | 'result' | 'cooldown';

// ── Dependencies interface ──

export interface RandomEventsDeps {
  elapsedMs: Ref<number>;
  currentPower: Ref<number>;
  currentCadence: Ref<number>;
  ftp: Ref<number>;
  selectedWorkoutId: Ref<string>;
  randomEventsEnabled: Ref<boolean>;
  targetDurationMs: Ref<number>;
  pushMessage: (typeId: string, values?: Record<string, string | number>) => void;
  addCoins: (amount: number) => void;
  setWeather?: (config: { type: string }) => void;
  setDarkened?: (dark: boolean) => void;
  restoreWeather?: () => void;
}

// ── Return type ──

export interface UseRandomEventsReturn {
  activeEvent: Ref<RandomEventDef | null>;
  eventElapsedMs: Ref<number>;
  eventProgress: ComputedRef<number>;
  eventTargetWatts: ComputedRef<number>;
  eventTargetCadence: ComputedRef<number | null>;
  isEventActive: ComputedRef<boolean>;
  isEventOnTarget: ComputedRef<boolean>;
  eventSegment: ComputedRef<WorkoutSegment | null>;
  eventScreenTint: ComputedRef<string | null>;
  eventScreenTintOpacity: ComputedRef<number>;
}

// ── Composable ──

export function useRandomEvents(deps: RandomEventsDeps): UseRandomEventsReturn {
  const state = ref<EventState>('idle');
  const activeEvent = ref<RandomEventDef | null>(null);
  const eventElapsedMs = ref(0);
  const timeOnTargetMs = ref(0);

  // Cooldown tracking: event ID → last-used elapsedMs
  const cooldownMap = new Map<string, number>();
  const cooldownSet = computed(() => {
    const set = new Set<string>();
    for (const [id, usedAt] of cooldownMap) {
      // Keep in cooldown for 5 minutes to avoid repeats
      if (deps.elapsedMs.value - usedAt < 300_000) set.add(id);
    }
    return set;
  });

  // Next trigger time (randomized)
  let nextTriggerMs = INITIAL_DELAY_MS;
  let eventStartMs = 0;
  let resultTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // ── Computed outputs ──

  const isEventActive = computed(() => state.value === 'active');

  const eventProgress = computed(() => {
    if (!activeEvent.value) return 0;
    return Math.min(1, eventElapsedMs.value / activeEvent.value.durationMs);
  });

  const eventTargetWatts = computed(() => {
    if (!activeEvent.value) return 0;
    return Math.round((activeEvent.value.targetFtpPercent / 100) * deps.ftp.value);
  });

  const eventTargetCadence = computed<number | null>(() => {
    return activeEvent.value?.targetCadence ?? null;
  });

  const isEventOnTarget = computed(() => {
    if (!activeEvent.value) return false;
    const ev = activeEvent.value;

    // If event has cadence target, check cadence
    if (ev.targetCadence != null) {
      const target = ev.targetCadence;
      return Math.abs(deps.currentCadence.value - target) <= target * CADENCE_TOLERANCE;
    }

    // Otherwise check power
    const target = eventTargetWatts.value;
    if (target <= 0) return false;
    return Math.abs(deps.currentPower.value - target) <= target * POWER_TOLERANCE;
  });

  const eventSegment = computed<WorkoutSegment | null>(() => {
    if (!activeEvent.value) return null;
    return buildEventSegment(activeEvent.value);
  });

  const eventScreenTint = computed<string | null>(() => {
    if (state.value !== 'active' || !activeEvent.value) return null;
    return activeEvent.value.visual.screenTint ?? null;
  });

  const eventScreenTintOpacity = computed(() => {
    if (state.value !== 'active' || !activeEvent.value) return 0;
    return activeEvent.value.visual.screenTintOpacity ?? 0;
  });

  // ── State machine logic ──

  function startEvent(event: RandomEventDef) {
    activeEvent.value = event;
    state.value = 'active';
    eventElapsedMs.value = 0;
    timeOnTargetMs.value = 0;
    eventStartMs = deps.elapsedMs.value;

    // Apply visual effects
    if (event.visual.weatherOverride && deps.setWeather) {
      deps.setWeather({ type: event.visual.weatherOverride });
    }
    if (event.visual.darken && deps.setDarkened) {
      deps.setDarkened(true);
    }

    // Push start message
    const targetWatts = Math.round((event.targetFtpPercent / 100) * deps.ftp.value);
    const seconds = Math.round(event.durationMs / 1000);
    const values: Record<string, string | number> = { watts: targetWatts, seconds };
    if (event.targetCadence != null) {
      values.cadence = event.targetCadence;
    }
    deps.pushMessage(`event-${event.id}-start`, values);
  }

  function endEvent() {
    const ev = activeEvent.value;
    if (!ev) return;

    // Restore visual effects
    if (ev.visual.weatherOverride && deps.restoreWeather) {
      deps.restoreWeather();
    }
    if (ev.visual.darken && deps.setDarkened) {
      deps.setDarkened(false);
    }

    // Evaluate success
    const ratio = timeOnTargetMs.value / ev.durationMs;
    const success = ratio >= ev.successThreshold;

    state.value = 'result';

    if (success) {
      deps.addCoins(ev.coinReward);
      deps.pushMessage(`event-${ev.id}-success`, { coins: ev.coinReward });
    } else {
      deps.pushMessage(`event-${ev.id}-fail`);
    }

    // Record cooldown
    cooldownMap.set(ev.id, deps.elapsedMs.value);

    // Transition to cooldown after result display
    resultTimeoutId = setTimeout(() => {
      resultTimeoutId = null;
      activeEvent.value = null;
      state.value = 'cooldown';
      // Schedule next event
      nextTriggerMs = deps.elapsedMs.value + randomBetween(COOLDOWN_MIN_MS, COOLDOWN_MAX_MS);
    }, RESULT_DISPLAY_MS);
  }

  // ── Main tick watcher ──

  let lastCheckMs = 0;

  const stopWatch = watch(deps.elapsedMs, (elapsed) => {
    // Only run in freeride mode with random events enabled
    if (deps.selectedWorkoutId.value !== 'none') return;
    if (!deps.randomEventsEnabled.value) return;

    if (state.value === 'active') {
      // Update event elapsed time
      eventElapsedMs.value = elapsed - eventStartMs;

      // Accumulate on-target time (approximate 1s ticks)
      const dt = elapsed - lastCheckMs;
      if (isEventOnTarget.value && dt > 0) {
        timeOnTargetMs.value += Math.min(dt, 2000); // cap to avoid jumps
      }
      lastCheckMs = elapsed;

      // Check if event duration exceeded
      if (eventElapsedMs.value >= activeEvent.value!.durationMs) {
        endEvent();
      }
      return;
    }

    // Throttle idle/cooldown checks to ~1s
    if (elapsed - lastCheckMs < CHECK_INTERVAL_MS) return;
    lastCheckMs = elapsed;

    if (state.value === 'idle' || state.value === 'cooldown') {
      // Check if it's time to trigger
      if (elapsed < nextTriggerMs) return;

      // Don't trigger near game end
      const remaining = deps.targetDurationMs.value - elapsed;
      if (remaining < END_GUARD_MS) return;

      // Pick an event
      const event = pickRandomEvent(elapsed, cooldownSet.value);
      if (!event) return;

      // Don't start if event would extend past game end
      if (remaining < event.durationMs + END_GUARD_MS) return;

      startEvent(event);
    }
  });

  // ── Cleanup ──

  onUnmounted(() => {
    stopWatch();
    if (resultTimeoutId != null) {
      clearTimeout(resultTimeoutId);
      resultTimeoutId = null;
    }
  });

  return {
    activeEvent,
    eventElapsedMs,
    eventProgress,
    eventTargetWatts,
    eventTargetCadence,
    isEventActive,
    isEventOnTarget,
    eventSegment,
    eventScreenTint,
    eventScreenTintOpacity,
  };
}

// ── Utilities ──

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
