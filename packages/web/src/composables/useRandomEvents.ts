/**
 * Random events — passive presentation mapper (P7).
 *
 * The event state machine lives entirely in the server simulation
 * (GameSimulation.tickEvents); this composable reflects the `game_state.event`
 * DTO into HUD-friendly reactive outputs and fires the presentation side
 * effects (weather override, darken, comic-bubble messages) once per state
 * edge. Static presentation (name/tint/weather/duration/rewards) is looked
 * up client-side from RANDOM_EVENTS_MAP by the DTO's id — only dynamic state
 * crosses the network.
 */

import { ref, computed, watch, onUnmounted, type Ref, type ComputedRef } from 'vue';
import {
  type RandomEventDef,
  type GameEventDto,
  buildEventSegment,
  RANDOM_EVENTS_MAP,
  type WorkoutSegment,
} from '@littlecycling/shared';

// ── Dependencies interface ──

export interface RandomEventsDeps {
  /** Server-authoritative event DTO from the latest game_state frame. */
  serverEvent: Ref<GameEventDto | null>;
  pushMessage: (typeId: string, values?: Record<string, string | number>) => void;
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
  const activeEvent = ref<RandomEventDef | null>(null);
  const eventElapsedMs = ref(0);

  // Mirrors of the dynamic fields the server owns.
  const serverActive = ref(false);
  const serverOnTarget = ref(false);
  const serverTargetWatts = ref(0);

  // ── Computed outputs ──

  const isEventActive = computed(() => serverActive.value);

  const eventProgress = computed(() => {
    if (!activeEvent.value) return 0;
    return Math.min(1, eventElapsedMs.value / activeEvent.value.durationMs);
  });

  const eventTargetWatts = computed(() => serverTargetWatts.value);

  const eventTargetCadence = computed<number | null>(() => {
    return activeEvent.value?.targetCadence ?? null;
  });

  const isEventOnTarget = computed(() => serverOnTarget.value);

  const eventSegment = computed<WorkoutSegment | null>(() => {
    if (!activeEvent.value) return null;
    return buildEventSegment(activeEvent.value);
  });

  const eventScreenTint = computed<string | null>(() => {
    if (!serverActive.value || !activeEvent.value) return null;
    return activeEvent.value.visual.screenTint ?? null;
  });

  const eventScreenTintOpacity = computed(() => {
    if (!serverActive.value || !activeEvent.value) return 0;
    return activeEvent.value.visual.screenTintOpacity ?? 0;
  });

  // ── Passive mapper ──
  //
  // The DTO arrives ~20Hz while active/result; `lastState` dedupes so each
  // side-effect edge (start effects, end effects) fires exactly once.

  let lastState: 'idle' | 'active' | 'result' = 'idle';

  function applyStartEffects(ev: RandomEventDef) {
    if (ev.visual.weatherOverride && deps.setWeather) {
      deps.setWeather({ type: ev.visual.weatherOverride });
    }
    if (ev.visual.darken && deps.setDarkened) {
      deps.setDarkened(true);
    }
    const values: Record<string, string | number> = {
      watts: serverTargetWatts.value,
      seconds: Math.round(ev.durationMs / 1000),
    };
    if (ev.targetCadence != null) values.cadence = ev.targetCadence;
    deps.pushMessage(`event-${ev.id}-start`, values);
  }

  function applyEndEffects(ev: RandomEventDef, success: boolean) {
    if (ev.visual.weatherOverride && deps.restoreWeather) {
      deps.restoreWeather();
    }
    if (ev.visual.darken && deps.setDarkened) {
      deps.setDarkened(false);
    }
    if (success) {
      deps.pushMessage(`event-${ev.id}-success`, { coins: ev.coinReward });
    } else {
      deps.pushMessage(`event-${ev.id}-fail`);
    }
  }

  const stopWatch = watch(
    () => deps.serverEvent.value,
    (dto) => {
      if (dto && dto.state === 'active') {
        const ev = RANDOM_EVENTS_MAP[dto.id] ?? null;
        activeEvent.value = ev;
        eventElapsedMs.value = dto.elapsedMs;
        serverActive.value = true;
        serverOnTarget.value = dto.onTarget;
        serverTargetWatts.value = dto.targetWatts;
        if (lastState !== 'active' && ev) applyStartEffects(ev);
        lastState = 'active';
      } else if (dto && dto.state === 'result') {
        const ev = RANDOM_EVENTS_MAP[dto.id] ?? null;
        activeEvent.value = ev; // keep for the result message display
        eventElapsedMs.value = dto.elapsedMs;
        serverActive.value = false;
        serverOnTarget.value = false;
        if (lastState !== 'result' && ev) applyEndEffects(ev, dto.success === true);
        lastState = 'result';
      } else {
        // idle / cooldown (DTO absent)
        activeEvent.value = null;
        eventElapsedMs.value = 0;
        serverActive.value = false;
        serverOnTarget.value = false;
        lastState = 'idle';
      }
    },
  );

  onUnmounted(() => {
    stopWatch();
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
