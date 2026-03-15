import { watch, type Ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useComparisonStore } from '@/stores/comparisonStore';

/**
 * Watches elapsedMs and updates comparison metrics from the buffer.
 * Pre-fetches the next window when approaching the buffer end.
 */
export function useComparison(elapsedMs: Ref<number>) {
  const comparisonStore = useComparisonStore();
  const { metrics, enabled } = storeToRefs(comparisonStore);

  watch(elapsedMs, (ms) => {
    if (!enabled.value) return;
    comparisonStore.updateAtElapsed(ms);
  });

  return { metrics, enabled };
}
