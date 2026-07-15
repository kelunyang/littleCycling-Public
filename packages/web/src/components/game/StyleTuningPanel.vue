<!--
  Debug-only live tuning panel for the Three.js world-style strategy.

  Shown when config.debug is on (see GameView). Lets the user drag sliders to
  find the "good-looking but not laggy" sweet spot for the blocks/paper look on
  Windows, then hard-code the values back into defaultStyleParams().

  Post-process params update live; geometry params trigger a (debounced) terrain
  rebuild. Font Awesome icons only (no emoji), per project convention.
-->
<template>
  <div class="style-tuning" :class="{ 'style-tuning--collapsed': collapsed }">
    <div class="style-tuning__header" @click="collapsed = !collapsed">
      <font-awesome-icon icon="sliders" />
      <span class="style-tuning__title">風格調參 · {{ styleLabel }}</span>
      <font-awesome-icon :icon="collapsed ? 'chevron-up' : 'chevron-down'" class="style-tuning__chevron" />
    </div>

    <div v-show="!collapsed" class="style-tuning__body">
      <template v-if="values">
        <div class="style-tuning__group">切換 · 即時</div>
        <label v-for="t in toggleFields" :key="t.key" class="style-tuning__row style-tuning__row--toggle">
          <span>{{ t.label }}</span>
          <input type="checkbox" :checked="!!values[t.key]" @change="onToggle(t, $event)" />
        </label>

        <div class="style-tuning__group">後處理 · 即時</div>
        <label v-for="f in postFields" :key="f.key" class="style-tuning__row">
          <span>{{ f.label }}</span>
          <input
            type="range" :min="f.min" :max="f.max" :step="f.step"
            :value="Number(values[f.key])"
            @input="onPost(f, $event)"
          />
          <em>{{ Number(values[f.key]).toFixed(2) }}</em>
        </label>

        <div class="style-tuning__group">幾何 · 重建</div>
        <label v-for="f in geomFields" :key="f.key" class="style-tuning__row">
          <span>{{ f.label }}</span>
          <input
            type="range" :min="f.min" :max="f.max" :step="f.step"
            :value="Number(values[f.key])"
            @input="onGeom(f, $event)"
          />
          <em>{{ Number(values[f.key]) }}</em>
        </label>

        <label class="style-tuning__row style-tuning__row--color">
          <span>墨線顏色</span>
          <input type="color" :value="hexColor" @input="onInkColor($event)" />
        </label>
      </template>
      <p v-else class="style-tuning__empty">等待地形渲染器初始化…</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import type { StyleParams, TerrainStyleStrategy } from '@/game/terrain/terrain-style-strategy';

const props = defineProps<{
  /** Returns the live strategy (params are mutated in place). */
  getStrategy: () => TerrainStyleStrategy | null;
  /** Re-apply post-pass uniforms after a live post param change. */
  applyPostParams: () => void;
  /** Rebuild terrain/overlays after a geometry param change. */
  rebuildTerrain: () => void;
  /** Current world style — re-syncs the panel when it changes. */
  worldStyle: string;
}>();

type NumField = { key: keyof StyleParams; label: string; min: number; max: number; step: number };
type ToggleField = { key: keyof StyleParams; label: string };

const toggleFields: ToggleField[] = [
  { key: 'quantEnabled', label: '高程量化(階梯)' },
  { key: 'inkEnabled', label: '墨線描邊' },
];

const postFields: NumField[] = [
  { key: 'paperPosterize', label: '色階化', min: 0, max: 1, step: 0.01 },
  { key: 'paperDesaturate', label: '降飽和', min: 0, max: 1, step: 0.01 },
  { key: 'paperFiber', label: '紙纖維', min: 0, max: 1, step: 0.01 },
  { key: 'paperStrength', label: '紙效果強度', min: 0, max: 1, step: 0.01 },
];

const geomFields: NumField[] = [
  { key: 'layerHeight', label: '層高 (m)', min: 1, max: 40, step: 1 },
  { key: 'gridSize', label: '格子大小 (m)', min: 4, max: 64, step: 1 },
  { key: 'heightJitter', label: '積木高低差 (m)', min: 0, max: 4, step: 0.1 },
  { key: 'corrugationStrength', label: '瓦楞強度', min: 0, max: 3, step: 0.05 },
  { key: 'inkThickness', label: '墨線粗細 (m)', min: 0, max: 2, step: 0.05 },
];

const collapsed = ref(false);
/** Local mirror of the strategy's params so the sliders stay reactive. */
const values = ref<StyleParams | null>(null);

const styleLabel = computed(() => (props.worldStyle === 'cuphead' ? '瓦楞紙' : '積木'));
const hexColor = computed(() =>
  values.value ? '#' + (values.value.inkColor & 0xffffff).toString(16).padStart(6, '0') : '#000000',
);

function sync(): void {
  const s = props.getStrategy();
  values.value = s ? { ...s.params } : null;
}

// Re-sync when the style switches (new strategy → new params object).
watch(() => props.worldStyle, sync, { immediate: true });
// Poll briefly until the renderer exists (init is async).
const pollId = window.setInterval(() => {
  if (!values.value) sync();
  else window.clearInterval(pollId);
}, 400);
onBeforeUnmount(() => window.clearInterval(pollId));

function write<K extends keyof StyleParams>(key: K, val: StyleParams[K]): void {
  const s = props.getStrategy();
  if (!s || !values.value) return;
  (s.params[key] as StyleParams[K]) = val;
  values.value = { ...s.params };
}

function onToggle(t: ToggleField, e: Event): void {
  const checked = (e.target as HTMLInputElement).checked;
  write(t.key, checked as StyleParams[typeof t.key]);
  // Toggles may affect both geometry and post; rebuild + reapply to be safe.
  props.applyPostParams();
  scheduleRebuild();
}

function onPost(f: NumField, e: Event): void {
  write(f.key, Number((e.target as HTMLInputElement).value) as StyleParams[typeof f.key]);
  props.applyPostParams();
}

function onGeom(f: NumField, e: Event): void {
  write(f.key, Number((e.target as HTMLInputElement).value) as StyleParams[typeof f.key]);
  scheduleRebuild();
}

function onInkColor(e: Event): void {
  const hex = (e.target as HTMLInputElement).value.replace('#', '');
  write('inkColor', parseInt(hex, 16) as StyleParams['inkColor']);
  scheduleRebuild();
}

// Debounce terrain rebuilds — dragging a slider fires many events.
let rebuildTimer = 0;
function scheduleRebuild(): void {
  window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => props.rebuildTerrain(), 350);
}
onBeforeUnmount(() => window.clearTimeout(rebuildTimer));
</script>

<style scoped>
.style-tuning {
  position: absolute;
  top: 96px;
  left: 12px;
  z-index: 40;
  width: 240px;
  font-family: system-ui, sans-serif;
  color: #eee;
  background: rgba(18, 18, 22, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(3px);
  user-select: none;
}
.style-tuning__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}
.style-tuning__title { flex: 1; }
.style-tuning__chevron { opacity: 0.7; }
.style-tuning__body {
  max-height: 60vh;
  overflow-y: auto;
  padding: 4px 10px 10px;
}
.style-tuning__group {
  margin: 10px 0 4px;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #9aa;
}
.style-tuning__row {
  display: grid;
  grid-template-columns: 1fr 90px 34px;
  align-items: center;
  gap: 6px;
  margin: 5px 0;
  font-size: 12px;
}
.style-tuning__row input[type='range'] { width: 100%; }
.style-tuning__row em { font-style: normal; text-align: right; color: #cde; font-variant-numeric: tabular-nums; }
.style-tuning__row--toggle { grid-template-columns: 1fr auto; }
.style-tuning__row--color { grid-template-columns: 1fr auto; }
.style-tuning__empty { font-size: 12px; color: #9aa; margin: 8px 0; }
</style>
