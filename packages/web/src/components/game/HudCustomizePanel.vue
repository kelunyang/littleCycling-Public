<template>
  <component
    :is="mode === 'modal' ? Teleport : 'div'"
    v-bind="mode === 'modal' ? { to: 'body' } : { class: 'contents' }"
  >
    <div
      :class="mode === 'modal' ? 'hud-customize-modal' : 'contents'"
      @click="mode === 'modal' && emit('close')"
    >
      <div
        class="hud-customize"
        :class="{ 'hud-customize--center': mode === 'modal' }"
        @click.stop
      >
        <div class="hud-customize__header">
          <span class="hud-customize__title">CUSTOMIZE HUD METRICS</span>
          <button class="hud-customize__close" @click="emit('close')" aria-label="Close">
            <font-awesome-icon icon="xmark" />
          </button>
        </div>

        <p class="hud-customize__hint">
          點左邊的指標把它加進 HUD，最多同時顯示 {{ HUD_METRIC_LIMIT }} 項。
          右邊可拖曳或用按鈕調整順序，由上到下就是 HUD 上的排列順序。
        </p>

        <div class="hud-transfer">
          <!-- 候選區 -->
          <section class="hud-transfer__panel">
            <header class="hud-transfer__panel-head">
              <div class="hud-transfer__panel-title">
                AVAILABLE ({{ availableMetrics.length }})
              </div>
              <div class="hud-transfer__search">
                <font-awesome-icon icon="magnifying-glass" class="hud-transfer__search-icon" />
                <input
                  v-model="query"
                  class="hud-transfer__search-input"
                  type="text"
                  placeholder="搜尋指標…"
                />
                <button
                  v-if="query"
                  class="hud-transfer__search-clear"
                  aria-label="Clear search"
                  @click="query = ''"
                >
                  <font-awesome-icon icon="xmark" />
                </button>
              </div>
            </header>

            <TransitionGroup name="hud-avail" tag="div" class="hud-transfer__body">
              <button
                v-for="m in filteredAvailable"
                :key="m.id"
                type="button"
                class="hud-card"
                @click="hudStore.addMetric(m.id)"
              >
                <font-awesome-icon :icon="m.icon" class="hud-card__icon" />
                <span class="hud-card__label">{{ m.label }}</span>
                <span class="hud-card__unit">{{ m.unit }}</span>
                <span v-if="m.category === 'debug'" class="hud-card__tag">DEBUG</span>
                <font-awesome-icon icon="chevron-right" class="hud-card__move" />
              </button>

              <p v-if="filteredAvailable.length === 0" key="empty" class="hud-transfer__empty">
                {{ availableMetrics.length === 0 ? '所有指標都已加入' : '沒有符合搜尋的指標' }}
              </p>
            </TransitionGroup>

            <p v-if="atLimit" class="hud-transfer__notice">
              <font-awesome-icon icon="circle-info" />
              已滿 {{ HUD_METRIC_LIMIT }} 項 —— 再加入會擠掉
              <strong>{{ evictedLabel }}</strong>
            </p>
          </section>

          <!-- 已選區 -->
          <section class="hud-transfer__panel">
            <header class="hud-transfer__panel-head">
              <div class="hud-transfer__panel-title">
                SHOWN ({{ selected.length }}/{{ HUD_METRIC_LIMIT }})
              </div>
              <p class="hud-transfer__panel-hint">拖曳可調整順序</p>
            </header>

            <TransitionGroup name="hud-chosen" tag="div" class="hud-transfer__body">
              <div
                v-for="(m, idx) in selectedMetrics"
                :key="m.id"
                class="hud-card hud-card--selected"
                :class="{
                  'hud-card--dragging': draggedIndex === idx,
                  'hud-card--evicted': atLimit && idx === 0,
                }"
                draggable="true"
                @dragstart="onDragStart(idx, $event)"
                @dragover.prevent
                @drop.prevent="onDrop(idx)"
                @dragend="draggedIndex = null"
              >
                <span class="hud-card__rank">{{ idx + 1 }}</span>
                <font-awesome-icon :icon="m.icon" class="hud-card__icon" />
                <span class="hud-card__label">{{ m.label }}</span>
                <span class="hud-card__unit">{{ m.unit }}</span>

                <span class="hud-card__actions">
                  <button
                    class="hud-card__btn"
                    :disabled="idx === 0"
                    aria-label="Move up"
                    @click="hudStore.moveUp(m.id)"
                  >
                    <font-awesome-icon icon="chevron-up" />
                  </button>
                  <button
                    class="hud-card__btn"
                    :disabled="idx === selectedMetrics.length - 1"
                    aria-label="Move down"
                    @click="hudStore.moveDown(m.id)"
                  >
                    <font-awesome-icon icon="chevron-down" />
                  </button>
                  <button
                    class="hud-card__btn hud-card__btn--remove"
                    aria-label="Remove"
                    @click="hudStore.removeMetric(m.id)"
                  >
                    <font-awesome-icon icon="xmark" />
                  </button>
                </span>
              </div>

              <p v-if="selectedMetrics.length === 0" key="empty" class="hud-transfer__empty">
                HUD 目前沒有指標，從左邊挑幾個吧
              </p>
            </TransitionGroup>
          </section>
        </div>

        <div class="hud-customize__footer">
          <button class="hud-customize__reset" @click="hudStore.resetToDefaults()">
            <font-awesome-icon icon="rotate-left" />
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  </component>
</template>

<script setup lang="ts">
import { computed, ref, Teleport } from 'vue';
import {
  useHudStore,
  HUD_METRIC_CATALOG,
  HUD_METRIC_LIMIT,
  type HudMetricId,
  type HudMetricInfo,
} from '@/stores/hudStore';

withDefaults(defineProps<{ mode?: 'dropdown' | 'modal' }>(), { mode: 'dropdown' });
const emit = defineEmits<{ close: [] }>();

const hudStore = useHudStore();
const query = ref('');
const draggedIndex = ref<number | null>(null);

const selected = computed<HudMetricId[]>(() => hudStore.visibleMetrics);

const selectedMetrics = computed<HudMetricInfo[]>(() =>
  selected.value
    .map((id) => HUD_METRIC_CATALOG.find((m) => m.id === id))
    .filter((m): m is HudMetricInfo => m != null),
);

const availableMetrics = computed(() =>
  HUD_METRIC_CATALOG.filter((m) => !selected.value.includes(m.id)),
);

const filteredAvailable = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return availableMetrics.value;
  return availableMetrics.value.filter(
    (m) => m.label.toLowerCase().includes(q) || m.unit.toLowerCase().includes(q),
  );
});

const atLimit = computed(() => selected.value.length >= HUD_METRIC_LIMIT);

const evictedLabel = computed(() => {
  const id = hudStore.evictionCandidate;
  return id ? (HUD_METRIC_CATALOG.find((m) => m.id === id)?.label ?? id) : '';
});

function onDragStart(index: number, event: DragEvent) {
  draggedIndex.value = index;
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function onDrop(dropIndex: number) {
  if (draggedIndex.value === null) return;
  hudStore.reorder(draggedIndex.value, dropIndex);
  draggedIndex.value = null;
}
</script>

<style scoped>
.contents {
  display: contents;
}

.hud-customize {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  width: 640px;
  max-width: calc(100vw - 32px);
  /* 面板是 dialog 語意，surface 才是跟 --hud-text-* 成對的底色；
     --hud-bg 是遊戲內 overlay 專用，在 plastic 主題下是深藍底配墨色字（不可讀）。 */
  background: var(--surface);
  border: 1.5px solid var(--hud-border-bright);
  clip-path: var(--clip-panel-sm);
  padding: 14px;
  z-index: 30;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: 0 0 18px rgba(var(--accent-rgb), 0.18);
}

.hud-customize--center {
  position: relative;
  top: auto;
  left: auto;
}

.hud-customize-modal {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
}

.hud-customize__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hud-customize__title {
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  color: var(--hud-cyan);
  letter-spacing: 2px;
  text-shadow: 0 0 6px rgba(var(--accent-rgb), 0.4);
}

.hud-customize__close {
  background: transparent;
  color: var(--hud-cyan);
  border: none;
  cursor: pointer;
  font-size: 13px;
  padding: 2px 4px;
}

.hud-customize__close:hover {
  color: var(--hud-text-bright);
}

.hud-customize__hint {
  font-family: var(--font-body);
  font-size: 11px;
  line-height: 1.5;
  color: var(--hud-text);
  opacity: 0.75;
  margin: 0;
}

/* ---- transfer ---- */

.hud-transfer {
  display: flex;
  gap: 12px;
  align-items: stretch;
}

.hud-transfer__panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1.5px solid var(--hud-border);
  background: var(--surface-light);
}

.hud-transfer__panel-head {
  padding: 8px 10px;
  border-bottom: 1.5px solid var(--hud-border);
  background: rgba(var(--accent-rgb), 0.06);
  flex-shrink: 0;
}

.hud-transfer__panel-title {
  font-family: var(--font-display);
  font-size: 9px;
  font-weight: 700;
  color: var(--hud-cyan);
  letter-spacing: 2px;
  margin-bottom: 6px;
}

.hud-transfer__panel-hint {
  font-family: var(--font-body);
  font-size: 10px;
  color: var(--hud-text);
  opacity: 0.55;
  margin: 0;
  padding: 4px 0;
}

.hud-transfer__search {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1.5px solid var(--hud-border);
  background: var(--surface);
  padding: 3px 6px;
}

.hud-transfer__search-icon {
  color: var(--hud-cyan);
  opacity: 0.6;
  font-size: 10px;
  flex-shrink: 0;
}

.hud-transfer__search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--hud-text-bright);
  font-family: var(--font-body);
  font-size: 11px;
  padding: 2px 0;
}

.hud-transfer__search-input::placeholder {
  color: var(--hud-text);
  opacity: 0.4;
}

.hud-transfer__search-clear {
  background: transparent;
  border: none;
  color: var(--hud-cyan);
  cursor: pointer;
  font-size: 10px;
  padding: 0 2px;
  flex-shrink: 0;
}

.hud-transfer__body {
  flex: 1;
  overflow-y: auto;
  max-height: 230px;
  min-height: 160px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  position: relative;
}

.hud-transfer__empty {
  margin: auto 0;
  text-align: center;
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--hud-text);
  opacity: 0.45;
}

.hud-transfer__notice {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 6px 10px;
  border-top: 1.5px solid var(--hud-border);
  font-family: var(--font-body);
  font-size: 10px;
  color: var(--hud-magenta);
  opacity: 0.9;
}

.hud-transfer__notice strong {
  color: var(--hud-text-bright);
  font-weight: 600;
}

/* ---- card ---- */

.hud-card {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 1.5px solid var(--hud-border);
  background: rgba(var(--accent-rgb), 0.05);
  color: var(--hud-text-bright);
  font-family: var(--font-body);
  text-align: left;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, transform 0.15s;
}

.hud-card:hover:not(.hud-card--selected) {
  border-color: var(--hud-cyan);
  background: rgba(var(--accent-rgb), 0.14);
  transform: translateX(2px);
}

.hud-card--selected {
  cursor: grab;
  border-color: rgba(var(--accent-rgb), 0.55);
  background: rgba(var(--accent-rgb), 0.1);
}

.hud-card--selected:active {
  cursor: grabbing;
}

.hud-card--dragging {
  opacity: 0.45;
}

/* 下一次加入時會被擠掉的那一項 */
.hud-card--evicted {
  border-style: dashed;
  border-color: var(--hud-magenta);
}

.hud-card__rank {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  color: var(--surface);
  background: var(--hud-cyan);
}

.hud-card__icon {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  color: var(--hud-cyan);
  font-size: 12px;
}

.hud-card__label {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hud-card__unit {
  flex-shrink: 0;
  font-size: 9px;
  letter-spacing: 1px;
  color: var(--hud-cyan);
  opacity: 0.6;
}

.hud-card__tag {
  flex-shrink: 0;
  font-family: var(--font-display);
  font-size: 8px;
  letter-spacing: 1px;
  padding: 1px 4px;
  border: 1px solid var(--hud-border);
  color: var(--hud-text);
  opacity: 0.6;
}

.hud-card__move {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--hud-cyan);
  opacity: 0.5;
}

.hud-card__actions {
  display: flex;
  gap: 3px;
  flex-shrink: 0;
}

.hud-card__btn {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1.5px solid var(--hud-border);
  color: var(--hud-cyan);
  font-size: 10px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, opacity 0.15s;
}

.hud-card__btn:hover:not(:disabled) {
  background: rgba(var(--accent-rgb), 0.15);
  border-color: var(--hud-cyan);
}

.hud-card__btn:disabled {
  opacity: 0.25;
  cursor: not-allowed;
}

.hud-card__btn--remove {
  color: var(--hud-magenta);
}

.hud-card__btn--remove:hover {
  background: color-mix(in srgb, var(--hud-magenta) 15%, transparent);
  border-color: var(--hud-magenta);
}

/* ---- footer ---- */

.hud-customize__footer {
  border-top: 1.5px solid var(--hud-border);
  padding-top: 10px;
  display: flex;
  justify-content: flex-end;
}

.hud-customize__reset {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  color: var(--hud-cyan);
  border: 1.5px solid var(--hud-border);
  clip-path: var(--clip-panel-sm);
  padding: 4px 10px;
  font-family: var(--font-body);
  font-size: 11px;
  letter-spacing: 1px;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
}

.hud-customize__reset:hover {
  border-color: var(--hud-cyan);
  background: rgba(var(--accent-rgb), 0.1);
}

/* ---- 過渡：候選往右飛出、已選從左飛入 ---- */

.hud-avail-move,
.hud-chosen-move {
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.hud-avail-enter-active,
.hud-chosen-enter-active {
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.hud-avail-leave-active,
.hud-chosen-leave-active {
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  position: absolute;
  width: calc(100% - 16px);
}

.hud-avail-enter-from,
.hud-avail-leave-to {
  opacity: 0;
  transform: translateX(24px);
}

.hud-chosen-enter-from,
.hud-chosen-leave-to {
  opacity: 0;
  transform: translateX(-24px);
}

/* 窄畫面：左右並排改上下堆疊 */
@media (max-width: 720px) {
  .hud-transfer {
    flex-direction: column;
  }

  .hud-transfer__body {
    max-height: 160px;
    min-height: 100px;
  }
}
</style>
