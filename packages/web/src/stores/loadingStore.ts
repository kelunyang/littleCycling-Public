import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

/**
 * Startup progress for the 3D game view.
 *
 * The terrain load is a network-bound cold start (DEM tiles, TileJSON, MVT
 * tiles) and it used to happen behind a black screen. This store is the shared
 * board the pieces of that startup write to — init() in useTerrainRenderer, the
 * chunk manager's per-chunk callback, GameView's message preload — so a single
 * overlay can show one honest progress bar.
 *
 * It does not make the load faster. It makes it legible.
 */

export type StageId = 'style' | 'origin' | 'tilejson' | 'chunks' | 'messages' | 'firstFrame';
export type StageStatus = 'pending' | 'loading' | 'done' | 'failed';

export interface Stage {
  label: string;
  /** Share of the total bar, in points. All weights sum to 100. */
  weight: number;
  status: StageStatus;
  /** Only 'chunks' reports a fraction; the rest are all-or-nothing. */
  current?: number;
  total?: number;
}

/** Terrain (3D) startup. Chunks dominate because they *are* the wait. */
function threeStages(): Record<StageId, Stage> {
  return {
    style: { label: '準備世界樣式', weight: 5, status: 'pending' },
    origin: { label: '定位起點高程', weight: 5, status: 'pending' },
    tilejson: { label: '連線圖資服務', weight: 10, status: 'pending' },
    chunks: { label: '建構地形', weight: 60, status: 'pending', current: 0, total: 0 },
    messages: { label: '載入旅程訊息', weight: 10, status: 'pending' },
    firstFrame: { label: '首幀渲染', weight: 10, status: 'pending' },
  };
}

/**
 * Phaser / MapLibre have no terrain streaming, so most stages never fire. Give
 * their weight to the two that do, or the bar would stall at 20% forever.
 */
function flatStages(): Record<StageId, Stage> {
  const s = threeStages();
  s.style.weight = 0;
  s.origin.weight = 0;
  s.tilejson.weight = 0;
  s.chunks.weight = 0;
  s.messages.weight = 50;
  s.firstFrame.weight = 50;
  return s;
}

export const useLoadingStore = defineStore('loading', () => {
  const stages = ref<Record<StageId, Stage>>(threeStages());
  const overlayVisible = ref(false);
  /** Whether the "start riding" button is clickable. */
  const unlocked = ref(false);
  /** Set when a stage failed or we timed out — the ride still starts, degraded. */
  const degradedReason = ref<string | null>(null);

  /** Stages that carry weight — the ones a mode actually runs. */
  const activeStages = computed(() =>
    (Object.entries(stages.value) as [StageId, Stage][]).filter(([, s]) => s.weight > 0),
  );

  /** Stages worth NAMING to the rider. 'messages' and 'firstFrame' still carry
   *  weight (they gate the start button), but listing them is noise: the rider
   *  is waiting for a world, not for our narration to arrive. */
  const HIDDEN_STAGES: StageId[] = ['messages', 'firstFrame'];
  const visibleStages = computed(() =>
    activeStages.value.filter(([id]) => !HIDDEN_STAGES.includes(id)),
  );

  const percent = computed(() => {
    let earned = 0;
    for (const [, s] of activeStages.value) {
      // A failed stage counts as finished: it will never progress, and leaving
      // its weight unearned would peg the bar below 100 forever.
      if (s.status === 'done' || s.status === 'failed') {
        earned += s.weight;
      } else if (s.total) {
        earned += s.weight * Math.min(1, (s.current ?? 0) / s.total);
      }
    }
    return Math.min(100, Math.round(earned));
  });

  const allDone = computed(() =>
    activeStages.value.every(([, s]) => s.status === 'done' || s.status === 'failed'),
  );

  function reset(renderMode: string) {
    stages.value = renderMode === 'threejs' ? threeStages() : flatStages();
    overlayVisible.value = true;
    unlocked.value = false;
    degradedReason.value = null;
  }

  function beginStage(id: StageId) {
    stages.value[id].status = 'loading';
  }

  function completeStage(id: StageId) {
    const s = stages.value[id];
    s.status = 'done';
    if (s.total) s.current = s.total;
  }

  function failStage(id: StageId, reason: string) {
    stages.value[id].status = 'failed';
    degradedReason.value = reason;
  }

  function setStageProgress(id: StageId, current: number, total: number) {
    const s = stages.value[id];
    s.status = current >= total && total > 0 ? 'done' : 'loading';
    s.current = current;
    s.total = total;
  }

  function unlock(reason?: string) {
    unlocked.value = true;
    if (reason) degradedReason.value = reason;
  }

  function hide() {
    overlayVisible.value = false;
  }

  return {
    stages, overlayVisible, unlocked, degradedReason,
    percent, allDone, activeStages, visibleStages,
    reset, beginStage, completeStage, failStage, setStageProgress, unlock, hide,
  };
});
