import { ref, computed } from 'vue';
import type { TimeSeriesSample } from './useGameLoop';

export type PinnableMetric = 'hr' | 'speed' | 'cadence' | 'power';

export interface PinConfig {
  key: PinnableMetric;
  label: string;
  unit: string;
  color: string;
}

export const METRIC_CONFIGS: Record<PinnableMetric, Omit<PinConfig, 'key'>> = {
  hr: { label: 'HR', unit: 'bpm', color: '#ff4444' },
  speed: { label: 'Speed', unit: 'km/h', color: '#44aaff' },
  cadence: { label: 'Cadence', unit: 'rpm', color: '#44ff88' },
  power: { label: 'Power', unit: 'W', color: '#ffaa44' },
};

/**
 * Manages which metrics are pinned for the live chart overlay.
 * Maximum 2 pinned metrics (one per Y-axis).
 */
export function useChartPin() {
  const pinned = ref<PinnableMetric[]>([]);

  const pinnedConfigs = computed<PinConfig[]>(() =>
    pinned.value.map((key) => ({ key, ...METRIC_CONFIGS[key] })),
  );

  function togglePin(metric: PinnableMetric) {
    const idx = pinned.value.indexOf(metric);
    if (idx >= 0) {
      // Unpin
      pinned.value = pinned.value.filter((m) => m !== metric);
    } else if (pinned.value.length < 2) {
      // Pin (max 2)
      pinned.value = [...pinned.value, metric];
    } else {
      // Replace oldest pin
      pinned.value = [pinned.value[1], metric];
    }
  }

  function isPinned(metric: PinnableMetric): boolean {
    return pinned.value.includes(metric);
  }

  return { pinned, pinnedConfigs, togglePin, isPinned };
}
