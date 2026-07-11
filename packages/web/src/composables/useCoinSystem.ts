import { ref } from 'vue';
import type { HrZone } from '@littlecycling/shared';

/**
 * Display-only holder for the HR-zone/combo state (P7). The zone + combo
 * state machine runs in the server simulation (GameSimulation.zoneComboTick);
 * GameView mirrors each game_state frame into these refs, and the HUD,
 * renderers, and game messages read them exactly as before.
 */
export function useCoinSystem() {
  const comboMultiplier = ref(1);
  const currentZone = ref<HrZone | null>(null);
  const redLine = ref(false);

  function reset() {
    comboMultiplier.value = 1;
    currentZone.value = null;
    redLine.value = false;
  }

  return { comboMultiplier, currentZone, redLine, reset };
}
