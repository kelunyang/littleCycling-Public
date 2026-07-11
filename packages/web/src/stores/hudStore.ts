import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';

export type HudMetricId =
  | 'hr'
  | 'speed'
  | 'cadence'
  | 'power'
  | 'leftPower'
  | 'rightPower'
  | 'balance'
  | 'pwrCadence'
  | 'fps'
  | 'pitch'
  | 'cameraHeight';

export interface HudMetricInfo {
  id: HudMetricId;
  label: string;
  unit: string;
  icon: string;
  category: 'sensor' | 'debug';
  defaultVisible: boolean;
}

export const HUD_METRIC_CATALOG: readonly HudMetricInfo[] = [
  { id: 'hr',          label: 'Heart Rate',      unit: 'BPM',   icon: 'heart',           category: 'sensor', defaultVisible: true  },
  { id: 'speed',       label: 'Speed',           unit: 'KM/H',  icon: 'gauge',           category: 'sensor', defaultVisible: false },
  { id: 'cadence',     label: 'Cadence',         unit: 'RPM',   icon: 'rotate',          category: 'sensor', defaultVisible: true  },
  { id: 'power',       label: 'Power',           unit: 'W',     icon: 'bolt',            category: 'sensor', defaultVisible: true  },
  { id: 'leftPower',   label: 'Left Power',      unit: 'W',     icon: 'arrow-left',      category: 'sensor', defaultVisible: false },
  { id: 'rightPower',  label: 'Right Power',     unit: 'W',     icon: 'arrow-right',     category: 'sensor', defaultVisible: false },
  { id: 'balance',     label: 'L/R Balance',     unit: '%',     icon: 'scale-balanced',  category: 'sensor', defaultVisible: false },
  { id: 'pwrCadence',  label: 'PM Cadence',      unit: 'RPM',   icon: 'rotate',          category: 'sensor', defaultVisible: false },
  { id: 'fps',         label: 'FPS',             unit: 'FPS',   icon: 'gauge',           category: 'debug',  defaultVisible: false },
  { id: 'pitch',       label: 'Camera Pitch',    unit: 'PITCH', icon: 'arrow-trend-up',  category: 'debug',  defaultVisible: false },
  { id: 'cameraHeight',label: 'Camera Height',   unit: 'CAM H', icon: 'mountain',        category: 'debug',  defaultVisible: false },
] as const;

export const HUD_METRIC_LIMIT = 3;

const STORAGE_KEY = 'hud.visibleMetrics.v1';
const VALID_IDS = new Set<HudMetricId>(HUD_METRIC_CATALOG.map((m) => m.id));

function loadFromStorage(): HudMetricId[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultVisibleIds();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultVisibleIds();
    const filtered = parsed.filter((id): id is HudMetricId => typeof id === 'string' && VALID_IDS.has(id as HudMetricId));
    return filtered.slice(0, HUD_METRIC_LIMIT);
  } catch {
    return defaultVisibleIds();
  }
}

function defaultVisibleIds(): HudMetricId[] {
  return HUD_METRIC_CATALOG.filter((m) => m.defaultVisible).map((m) => m.id).slice(0, HUD_METRIC_LIMIT);
}

export const useHudStore = defineStore('hud', () => {
  const visibleMetrics = ref<HudMetricId[]>(loadFromStorage());

  const visibleSet = computed(() => new Set(visibleMetrics.value));

  function isVisible(id: HudMetricId): boolean {
    return visibleSet.value.has(id);
  }

  function setVisibleMetrics(ids: HudMetricId[]) {
    const seen = new Set<HudMetricId>();
    const cleaned: HudMetricId[] = [];
    for (const id of ids) {
      if (VALID_IDS.has(id) && !seen.has(id)) {
        cleaned.push(id);
        seen.add(id);
      }
      if (cleaned.length >= HUD_METRIC_LIMIT) break;
    }
    visibleMetrics.value = cleaned;
  }

  function moveUp(id: HudMetricId) {
    const idx = visibleMetrics.value.indexOf(id);
    if (idx <= 0) return;
    const next = [...visibleMetrics.value];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    visibleMetrics.value = next;
  }

  function moveDown(id: HudMetricId) {
    const idx = visibleMetrics.value.indexOf(id);
    if (idx < 0 || idx >= visibleMetrics.value.length - 1) return;
    const next = [...visibleMetrics.value];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    visibleMetrics.value = next;
  }

  function resetToDefaults() {
    visibleMetrics.value = defaultVisibleIds();
  }

  watch(
    visibleMetrics,
    (next) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // localStorage may be unavailable (private mode, quota) — fail silently.
      }
    },
    { deep: true },
  );

  return {
    visibleMetrics,
    isVisible,
    setVisibleMetrics,
    moveUp,
    moveDown,
    resetToDefaults,
  };
});
