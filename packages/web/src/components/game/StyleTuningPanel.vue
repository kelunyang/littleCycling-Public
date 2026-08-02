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

        <div class="style-tuning__group">診斷 · 即時</div>
        <!-- Freeze first, then point: chasing a 1-pixel artefact with a moving
             camera is hopeless. Pausing the GAME is not enough — the camera
             keeps easing toward its target after the rider stops. -->
        <!-- The layer switches can only reach the SCENE. Post passes draw
             full-screen afterwards; if an artefact survives every layer being
             off, this is the switch that says whether it is geometry at all. -->
        <label class="style-tuning__row style-tuning__row--toggle">
          <span>停用後處理(原始畫面)</span>
          <input type="checkbox" :checked="bypassPostOn" @change="onBypassPost($event)" />
        </label>
        <label class="style-tuning__row style-tuning__row--toggle">
          <span>強制白天(上午 10 點)</span>
          <input type="checkbox" :checked="forceDay" @change="onForceDay($event)" />
        </label>
        <label class="style-tuning__row style-tuning__row--toggle">
          <span>凍結鏡頭</span>
          <input type="checkbox" :checked="freezeOn" @change="onFreeze($event)" />
        </label>
        <!-- Point at a thing, read what it is. -->
        <label class="style-tuning__row style-tuning__row--toggle">
          <span>滑鼠指向查詢物件</span>
          <input type="checkbox" :checked="inspectorOn" @change="onInspector($event)" />
        </label>
        <!-- Bisect for "black lines coming out of the hillside": walls are the
             only vertical terrain faces, and the only ones a boundary skirt can
             drive hundreds of metres down. Off + lines gone = it is them. -->
        <label class="style-tuning__row style-tuning__row--toggle">
          <span>顯示地形側牆/裙邊</span>
          <input type="checkbox" :checked="wallsOn" @change="onWalls($event)" />
        </label>
        <label class="style-tuning__row style-tuning__row--toggle">
          <span>啟用雲影</span>
          <input type="checkbox" :checked="cloudOn" @change="onCloud($event)" />
        </label>
        <label class="style-tuning__row style-tuning__row--toggle">
          <span>顯示遠山剪影環</span>
          <input type="checkbox" :checked="ringOn" @change="onRing($event)" />
        </label>
        <!-- Repaint every mesh with its own colour + log the legend. Screenshot
             it and the mystery object names itself. -->
        <label class="style-tuning__row style-tuning__row--toggle">
          <span>物件識別上色(ID Pass)</span>
          <input type="checkbox" :checked="idPassOn" @change="onIdPass($event)" />
        </label>

        <div class="style-tuning__group style-tuning__group--action">
          <span>渲染圖層 ({{ layers.length }})</span>
          <span>
            <button type="button" class="style-tuning__reset" @click="onLayersHideAll">全關</button>
            <button type="button" class="style-tuning__reset" @click="onLayersReset">全開</button>
          </span>
        </div>
        <label
          v-for="l in layers"
          :key="l.key"
          class="style-tuning__row style-tuning__row--toggle"
          :class="{ 'is-unnamed': l.key.startsWith('<unnamed') }"
        >
          <span
            class="style-tuning__solo"
            title="點名稱 = 只顯示這一層"
            @click.prevent="onLayerSolo(l.key)"
          >{{ l.key }} <em class="style-tuning__count">×{{ l.count }}</em></span>
          <input type="checkbox" :checked="!l.hidden" @change="onLayer(l.key, $event)" />
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
import {
  getTerrainWallsVisible,
  setTerrainWallsVisible,
} from '@/game/terrain/quantized-terrain';
import {
  getMountainRingVisible,
  setMountainRingVisible,
} from '@/game/terrain/mountain-ring';
import { enableIdPass, disableIdPass, isIdPassActive } from '@/game/terrain/debug-id-pass';
import { getCloudShadowEnabled, setCloudShadowEnabled } from '@/game/terrain/cloud-shadow';
import {
  scanSceneLayers,
  setSceneLayerHidden,
  applySceneLayerVisibility,
  resetSceneLayers,
  hideAllSceneLayers,
  soloSceneLayer,
  type SceneLayer,
} from '@/game/terrain/debug-layers';
import {
  setDebugTimeOverride,
  getDebugTimeOverride,
  debugDaylightDate,
} from '@/game/terrain/sun-moon-calc';

const props = defineProps<{
  /** Returns the live strategy (params are mutated in place). */
  getStrategy: () => TerrainStyleStrategy | null;
  /** Returns the live scene — for the debug object-ID pass. */
  getScene: () => import('three').Scene | null;
  /** Turn the hover inspector on/off. */
  setInspector: (on: boolean) => void;
  /** Hold the camera still so the cursor can catch small artefacts. */
  setFreezeCamera: (on: boolean) => void;
  /** Draw the raw scene straight to the canvas, skipping every post pass. */
  setBypassPost: (on: boolean) => void;
  /** Re-apply post-pass uniforms after a live post param change. */
  applyPostParams: () => void;
  /** Rebuild terrain/overlays after a geometry param change. */
  rebuildTerrain: () => void;
  /** Current world style — re-syncs the panel when it changes. */
  worldStyle: string;
}>();

type NumField = { key: keyof StyleParams; label: string; min: number; max: number; step: number };
type ToggleField = { key: keyof StyleParams; label: string };

const wallsOn = ref(getTerrainWallsVisible());
function onWalls(ev: Event): void {
  wallsOn.value = (ev.target as HTMLInputElement).checked;
  setTerrainWallsVisible(wallsOn.value);
}

const bypassPostOn = ref(false);
function onBypassPost(ev: Event): void {
  bypassPostOn.value = (ev.target as HTMLInputElement).checked;
  props.setBypassPost(bypassPostOn.value);
}

const freezeOn = ref(false);
function onFreeze(ev: Event): void {
  freezeOn.value = (ev.target as HTMLInputElement).checked;
  props.setFreezeCamera(freezeOn.value);
}

const inspectorOn = ref(false);
function onInspector(ev: Event): void {
  inspectorOn.value = (ev.target as HTMLInputElement).checked;
  props.setInspector(inspectorOn.value);
}

// ── Force daylight ──
const forceDay = ref(getDebugTimeOverride() !== null);
function onForceDay(ev: Event): void {
  forceDay.value = (ev.target as HTMLInputElement).checked;
  setDebugTimeOverride(forceDay.value ? debugDaylightDate() : null);
}

// ── Render-layer bisect ──
// The list is derived from the live scene, so anything the renderers add shows
// up here without this component knowing it exists — including meshes nobody
// remembered to name.
const layers = ref<SceneLayer[]>([]);
let layerTimer: number | null = null;

function refreshLayers(): void {
  const scene = props.getScene();
  if (!scene) return;
  // Re-apply first: chunks stream in continuously, and a mesh built after a
  // switch was flipped has never seen it.
  applySceneLayerVisibility(scene);
  layers.value = scanSceneLayers(scene);
}

function onLayer(key: string, ev: Event): void {
  // Checkbox is "visible", the store is "hidden".
  setSceneLayerHidden(key, !(ev.target as HTMLInputElement).checked);
  refreshLayers();
}

function onLayersHideAll(): void {
  const scene = props.getScene();
  if (scene) hideAllSceneLayers(scene);
  refreshLayers();
}

/** Click the NAME to solo that layer. */
function onLayerSolo(key: string): void {
  const scene = props.getScene();
  if (scene) soloSceneLayer(scene, key);
  refreshLayers();
}

function onLayersReset(): void {
  const scene = props.getScene();
  if (scene) resetSceneLayers(scene);
  refreshLayers();
}

const cloudOn = ref(getCloudShadowEnabled());
function onCloud(ev: Event): void {
  cloudOn.value = (ev.target as HTMLInputElement).checked;
  setCloudShadowEnabled(cloudOn.value);
}

const idPassOn = ref(isIdPassActive());
function onIdPass(ev: Event): void {
  idPassOn.value = (ev.target as HTMLInputElement).checked;
  const scene = props.getScene();
  if (!scene) return;
  if (idPassOn.value) enableIdPass(scene);
  else disableIdPass();
}

const ringOn = ref(getMountainRingVisible());
function onRing(ev: Event): void {
  ringOn.value = (ev.target as HTMLInputElement).checked;
  setMountainRingVisible(ringOn.value);
}

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
  // step 0.1,不是 1 —— 三個世界的出貨值是 demo 的階高(plastic 4 / paper **3.2** /
  // circuit 6,見 terrain-style-strategy 的 defaultStyleParams)。step: 1 的話,滑桿
  // 一動瓦楞紙就再也回不到 3.2,而 layerHeight 同時是量化階**與豎邊貼圖的縱向重複**
  // (quantized-terrain 的 vTop = 絕對海拔 / layerHeight),所以回不去等於整個豎邊的
  // 紋理比例也回不去。
  { key: 'layerHeight', label: '層高 (m)', min: 1, max: 40, step: 0.1 },
  { key: 'gridSize', label: '格子大小 (m)', min: 4, max: 64, step: 1 },
  { key: 'heightJitter', label: '積木高低差 (m)', min: 0, max: 4, step: 0.1 },
  { key: 'corrugationStrength', label: '瓦楞強度', min: 0, max: 3, step: 0.05 },
  { key: 'inkThickness', label: '墨線粗細 (m)', min: 0, max: 2, step: 0.05 },
];

const collapsed = ref(false);

// Poll the scene only while the panel is open. Declared here, after
// `collapsed` — an `immediate` watch that reads a ref declared further down the
// file throws on the temporal dead zone, and vue-tsc does not catch it.
watch(() => collapsed.value, (isCollapsed) => {
  if (layerTimer !== null) { window.clearInterval(layerTimer); layerTimer = null; }
  if (isCollapsed) return;
  refreshLayers();
  // 2 Hz while the panel is open — enough to catch streaming chunks, cheap
  // enough not to matter. Stops the moment the panel closes.
  layerTimer = window.setInterval(refreshLayers, 500);
}, { immediate: true });

onBeforeUnmount(() => {
  if (layerTimer !== null) window.clearInterval(layerTimer);
});

/** Local mirror of the strategy's params so the sliders stay reactive. */
const values = ref<StyleParams | null>(null);

// props.worldStyle is a plain string (it rides through GameView), so no
// compile-time exhaustiveness is available here — the lookup with an explicit
// fallback at least keeps a new world from being silently titled 積木.
const STYLE_LABELS: Record<string, string> = {
  plastic: '積木',
  cuphead: '瓦楞紙',
  circuit: '電路板',
};
const styleLabel = computed(() => STYLE_LABELS[props.worldStyle] ?? props.worldStyle);
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

.style-tuning__group--action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.style-tuning__reset {
  padding: 0.05rem 0.4rem;
  font: inherit;
  font-size: 0.68rem;
  color: inherit;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 0.2rem;
  cursor: pointer;
}

.style-tuning__solo {
  cursor: pointer;
  text-decoration: underline dotted transparent;

  &:hover {
    text-decoration-color: currentColor;
  }
}

.style-tuning__count {
  opacity: 0.5;
  font-style: normal;
}

/* An unnamed mesh is the likeliest thing to be the one nobody is looking for. */
.is-unnamed span {
  color: #ffd400;
  font-weight: 700;
}
</style>
