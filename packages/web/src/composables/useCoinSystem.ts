import { ref } from 'vue';
import { getHrZone, isRedLine, type HrZone } from '@littlecycling/shared';
import { useSensorStore } from '@/stores/sensorStore';
import { useSettingsStore } from '@/stores/settingsStore';

const MAX_COMBO = 5;

export function useCoinSystem() {
  const sensorStore = useSensorStore();
  const settingsStore = useSettingsStore();

  const comboMultiplier = ref(1);
  const currentZone = ref<HrZone | null>(null);
  const redLine = ref(false);

  let prevZoneNum = -1;

  /**
   * Update zone + combo state. No longer awards coins directly —
   * coins are awarded via 3D collision in useCoinSpawner.
   */
  function tick() {
    const hr = sensorStore.hr?.heartRate;
    const hrMax = settingsStore.config.training.hrMax;

    if (hr == null || hr === 0) {
      currentZone.value = null;
      redLine.value = false;
      return;
    }

    const zone = getHrZone(hr, hrMax);
    currentZone.value = zone;
    redLine.value = isRedLine(hr, hrMax);

    // Z1/Z5: no coins, reset combo on zone change
    if (!zone || zone.coinsPerTick === 0) {
      if (zone && zone.zone !== prevZoneNum) {
        comboMultiplier.value = 1;
      }
      prevZoneNum = zone?.zone ?? -1;
      return;
    }

    // Combo: same zone → increase, zone change → reset
    if (zone.zone === prevZoneNum) {
      comboMultiplier.value = Math.min(comboMultiplier.value + 1, MAX_COMBO);
    } else {
      comboMultiplier.value = 1;
    }

    prevZoneNum = zone.zone;
  }

  function reset() {
    comboMultiplier.value = 1;
    currentZone.value = null;
    redLine.value = false;
    prevZoneNum = -1;
  }

  return { comboMultiplier, currentZone, redLine, tick, reset };
}
