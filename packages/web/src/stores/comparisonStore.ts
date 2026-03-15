import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Ride, ComparisonSample, ComparisonMetrics } from '@littlecycling/shared';
import { notifyWarn } from '@/utils/notify';

export const useComparisonStore = defineStore('comparison', () => {
  const compareRideId = ref<number | null>(null);
  const compareRide = ref<Ride | null>(null);
  const metrics = ref<ComparisonMetrics>({});

  const enabled = computed(() => compareRideId.value !== null);

  // Internal buffer: pre-fetched window of ComparisonSample[]
  const buffer = ref<ComparisonSample[]>([]);
  const bufferFrom = ref(0);
  const bufferTo = ref(0);
  let fetching = false;
  let fetchWindowNotified = false;

  async function selectRide(rideId: number) {
    compareRideId.value = rideId;
    metrics.value = {};
    buffer.value = [];
    bufferFrom.value = 0;
    bufferTo.value = 0;

    // Fetch ride details
    try {
      const res = await fetch(`/api/rides/${rideId}`);
      if (res.ok) {
        compareRide.value = await res.json();
      }
    } catch {
      notifyWarn('Failed to load comparison ride');
    }

    fetchWindowNotified = false;
    // Pre-fetch first 120s window
    await fetchWindow(0, 120000);
  }

  async function fetchWindow(fromMs: number, toMs: number) {
    if (fetching || compareRideId.value === null) return;
    fetching = true;

    try {
      const res = await fetch(
        `/api/rides/${compareRideId.value}/comparison?from=${fromMs}&to=${toMs}`
      );
      if (res.ok) {
        const data = await res.json();
        buffer.value = data.samples;
        bufferFrom.value = fromMs;
        bufferTo.value = toMs;
      }
    } catch {
      if (!fetchWindowNotified) {
        notifyWarn('Failed to fetch comparison data');
        fetchWindowNotified = true;
      }
    } finally {
      fetching = false;
    }
  }

  function updateAtElapsed(elapsedMs: number) {
    if (!enabled.value || buffer.value.length === 0) {
      metrics.value = {};
      return;
    }

    // Binary search for closest sample
    const samples = buffer.value;
    let lo = 0;
    let hi = samples.length - 1;

    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].elapsedMs < elapsedMs) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    // Pick closest of lo and lo-1
    const idx = lo > 0 && Math.abs(samples[lo - 1].elapsedMs - elapsedMs) < Math.abs(samples[lo].elapsedMs - elapsedMs)
      ? lo - 1
      : lo;

    const s = samples[idx];
    metrics.value = {
      hr: s.hr,
      speed: s.speed,
      cadence: s.cadence,
      power: s.power,
    };

    // Pre-fetch next window if approaching buffer end (within 30s)
    if (elapsedMs > bufferTo.value - 30000 && !fetching) {
      const nextFrom = bufferTo.value;
      const nextTo = nextFrom + 120000;
      fetchWindow(nextFrom, nextTo);
    }
  }

  function clear() {
    compareRideId.value = null;
    compareRide.value = null;
    metrics.value = {};
    buffer.value = [];
    bufferFrom.value = 0;
    bufferTo.value = 0;
  }

  return {
    compareRideId,
    compareRide,
    metrics,
    enabled,
    selectRide,
    fetchWindow,
    updateAtElapsed,
    clear,
  };
});
