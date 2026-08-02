import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Ride } from '@littlecycling/shared';
import { notifyWarn } from '@/utils/notify';

/**
 * Ghost-rider selection (P8). Holds the historical ride chosen to race against
 * as a translucent ghost in the world. The live numeric comparison HUD is gone
 * — the ghost itself is the visualisation — so this store only tracks which
 * ride is selected; GameSummary still reads it for post-ride avg deltas.
 */
export const useGhostStore = defineStore('ghost', () => {
  const ghostRideId = ref<number | null>(null);
  const ghostRide = ref<Ride | null>(null);

  const enabled = computed(() => ghostRideId.value !== null);

  async function selectRide(rideId: number) {
    ghostRideId.value = rideId;

    // Fetch ride details (summary used for GameSummary avg deltas).
    try {
      const res = await fetch(`/api/rides/${rideId}`);
      if (res.ok) {
        ghostRide.value = await res.json();
      }
    } catch {
      notifyWarn('Failed to load ghost ride');
    }
  }

  function clear() {
    ghostRideId.value = null;
    ghostRide.value = null;
  }

  return {
    ghostRideId,
    ghostRide,
    enabled,
    selectRide,
    clear,
  };
});
