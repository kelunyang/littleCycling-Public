import { computed, ref, watch, type Ref, type ComputedRef } from 'vue';
import { getSegmentAtTime, totalWorkoutDuration, type WorkoutSegment } from '@littlecycling/shared';
import { useSettingsStore } from '@/stores/settingsStore';

export interface WorkoutTrackerReturn {
  currentSegment: ComputedRef<WorkoutSegment | null>;
  currentSegmentIndex: ComputedRef<number>;
  segmentElapsedMs: ComputedRef<number>;
  segmentRemainingMs: ComputedRef<number>;
  targetWatts: ComputedRef<number>;
  isOnTarget: ComputedRef<boolean>;
  segmentChanged: Ref<boolean>;
  hasWorkout: ComputedRef<boolean>;
  totalDurationMs: ComputedRef<number>;
}

export function useWorkoutTracker(
  workoutSegments: Ref<WorkoutSegment[]>,
  elapsedMs: Ref<number>,
  currentPower: Ref<number>,
): WorkoutTrackerReturn {
  const settingsStore = useSettingsStore();
  const segmentChanged = ref(false);
  let prevSegmentIndex = -1;

  const segmentInfo = computed(() => {
    const segs = workoutSegments.value;
    if (segs.length === 0) return null;
    return getSegmentAtTime(segs, elapsedMs.value);
  });

  const hasWorkout = computed(() => workoutSegments.value.length > 0);

  const currentSegment = computed(() => segmentInfo.value?.segment ?? null);

  const currentSegmentIndex = computed(() => segmentInfo.value?.segmentIndex ?? -1);

  const segmentElapsedMs = computed(() => segmentInfo.value?.segmentElapsed ?? 0);

  const segmentRemainingMs = computed(() => segmentInfo.value?.segmentRemaining ?? 0);

  const totalDurationMs = computed(() => totalWorkoutDuration(workoutSegments.value));

  const targetWatts = computed(() => {
    const seg = currentSegment.value;
    if (!seg) return 0;
    const ftp = settingsStore.config.training.ftp;
    return Math.round((seg.targetFtpPercent / 100) * ftp);
  });

  const isOnTarget = computed(() => {
    if (!currentSegment.value) return false;
    const target = targetWatts.value;
    if (target <= 0) return false;
    const tolerance = target * 0.1;
    return Math.abs(currentPower.value - target) <= tolerance;
  });

  // Detect segment transitions
  watch(currentSegmentIndex, (idx) => {
    if (idx !== prevSegmentIndex && prevSegmentIndex !== -1) {
      segmentChanged.value = true;
      // Reset after one tick
      setTimeout(() => { segmentChanged.value = false; }, 100);
    }
    prevSegmentIndex = idx;
  });

  return {
    currentSegment,
    currentSegmentIndex,
    segmentElapsedMs,
    segmentRemainingMs,
    targetWatts,
    isOnTarget,
    segmentChanged,
    hasWorkout,
    totalDurationMs,
  };
}
