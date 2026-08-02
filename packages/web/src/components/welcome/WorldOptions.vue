<!--
  Per-world options — GENERIC renderer.

  This component knows nothing about blocks, cardboard, ink or corrugation. It
  reads whatever the picked world declares in WORLD_OPTIONS (shared/
  world-options.ts), filters it by the current render mode, and draws each entry
  by its `kind`. Adding a fourth world means adding a row to that table; not a
  line here changes.

  Values are persisted SPARSELY (only what differs from the declared default) —
  see world-options.ts for why, and ConfigStore.save in the server for how the
  patch avoids being deep-merged back into non-sparseness.

  Font Awesome icons only, colours from theme tokens only (project convention).
-->
<template>
  <div v-if="options.length > 0" class="world-options">
    <div class="world-options__head">
      <label>
        <font-awesome-icon icon="sliders" />
        {{ styleLabel }} 專屬選項
      </label>
      <button
        v-if="hasOverrides"
        type="button"
        class="world-options__reset"
        @click="resetAll"
      >
        <font-awesome-icon icon="rotate-left" />
        回到預設
      </button>
    </div>

    <div v-for="opt in options" :key="opt.key" class="world-options__row">
      <div class="world-options__meta">
        <span class="world-options__label">{{ opt.label }}</span>
        <span v-if="opt.hint" class="world-options__hint">
          <font-awesome-icon icon="circle-info" />
          {{ opt.hint }}
        </span>
      </div>

      <div class="world-options__control">
        <!-- toggle -->
        <el-switch
          v-if="opt.kind === 'toggle'"
          :model-value="boolValue(opt)"
          @change="commit(opt, $event as boolean)"
        />

        <!-- range: drag freely, persist once on release (one PATCH per edit) -->
        <template v-else-if="opt.kind === 'range'">
          <el-slider
            class="world-options__slider"
            :model-value="numValue(opt)"
            :min="opt.min"
            :max="opt.max"
            :step="opt.step"
            :show-tooltip="false"
            size="small"
            @input="onDrag(opt, $event as number)"
            @change="commit(opt, $event as number)"
          />
          <em class="world-options__readout">
            {{ formatNumber(opt, numValue(opt)) }}<i v-if="opt.unit">{{ opt.unit }}</i>
          </em>
        </template>

        <!-- enum -->
        <el-select
          v-else
          class="world-options__select"
          :model-value="stringValue(opt)"
          size="small"
          @change="commit(opt, $event as string)"
        >
          <el-option
            v-for="choice in opt.choices"
            :key="choice.value"
            :label="choice.label"
            :value="choice.value"
          />
        </el-select>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  worldOptionsFor,
  resolveWorldOptions,
  withWorldOption,
  clearWorldOptions,
  hasWorldOptionOverrides,
  type WorldOption,
  type WorldOptionValue,
  type WorldStyle,
} from '@littlecycling/shared';
import { useSettingsStore } from '@/stores/settingsStore';

const settingsStore = useSettingsStore();

/** Same default as App.vue / MarkdownView — the three must not disagree. */
const worldStyle = computed<WorldStyle>(
  () => settingsStore.config.map.worldStyle ?? 'plastic',
);

/**
 * Only the options the CURRENT renderer can honour. A control the active
 * renderer ignores is the same broken promise as one with no code behind it.
 * Both are computed, so picking a different world (or render mode) swaps the
 * whole list without this component doing anything.
 */
const options = computed(() =>
  worldOptionsFor(worldStyle.value, settingsStore.config.map.renderMode),
);

/** Declared defaults with the rider's sparse overrides laid on top. */
const values = computed(() =>
  resolveWorldOptions(worldStyle.value, settingsStore.config.map.worldOptions),
);

const hasOverrides = computed(() =>
  hasWorldOptionOverrides(settingsStore.config.map.worldOptions, worldStyle.value),
);

// Exhaustive record, not a two-way ternary — a fourth world must fail to
// compile here rather than silently borrow another world's name.
const STYLE_LABELS: Record<WorldStyle, string> = {
  plastic: '積木',
  cuphead: '手繪紙',
  circuit: '電路板',
};
const styleLabel = computed(() => STYLE_LABELS[worldStyle.value]);

/**
 * Live slider positions during a drag, keyed by option. The persisted value only
 * moves on release; without this mirror the handle would snap back to the stored
 * value on every frame of the drag.
 */
const dragging = ref<Record<string, number>>({});

function boolValue(opt: WorldOption): boolean {
  return values.value[opt.key] === true;
}

function numValue(opt: WorldOption): number {
  const live = dragging.value[opt.key];
  if (live !== undefined) return live;
  const v = values.value[opt.key];
  return typeof v === 'number' ? v : 0;
}

function stringValue(opt: WorldOption): string {
  const v = values.value[opt.key];
  return typeof v === 'string' ? v : '';
}

/** Decimals implied by the step, so a 0.05 knob doesn't read as "0.55000000001". */
function formatNumber(opt: WorldOption, value: number): string {
  if (opt.kind !== 'range') return String(value);
  const s = String(opt.step);
  const dot = s.indexOf('.');
  return value.toFixed(dot < 0 ? 0 : s.length - dot - 1);
}

function onDrag(opt: WorldOption, value: number): void {
  dragging.value = { ...dragging.value, [opt.key]: value };
}

/**
 * Persist one edit. `withWorldOption` rebuilds the whole sparse map (and snaps
 * the value onto its declared grid first, so a slider's float dust can never be
 * mistaken for "the rider changed this"), then updateMap PATCHes it.
 */
function commit(opt: WorldOption, value: WorldOptionValue): void {
  const next = { ...dragging.value };
  delete next[opt.key];
  dragging.value = next;
  settingsStore.updateMap({
    worldOptions: withWorldOption(
      settingsStore.config.map.worldOptions,
      worldStyle.value,
      opt.key,
      value,
    ),
  });
}

function resetAll(): void {
  dragging.value = {};
  settingsStore.updateMap({
    worldOptions: clearWorldOptions(settingsStore.config.map.worldOptions, worldStyle.value),
  });
}
</script>

<style scoped>
/* No --hud-bg here on purpose: it is a dark blue in every theme, and on
   plastic's pink paper card that reads as dirty grey. A hairline rule in the
   border token separates the block in all three themes. */
.world-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 14px;
  border-top: 1.5px solid var(--hud-border);
}

.world-options__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

/* Matches the drawer's other section labels (checklist__frame-material label). */
.world-options__head label {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  font-family: var(--font-display);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--hud-cyan);
  opacity: 0.8;
}

.world-options__reset {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--hud-text);
  background: rgba(var(--accent-rgb), 0.08);
  border: 1px solid var(--hud-border);
  border-radius: var(--card-radius-sm);
  cursor: pointer;
}

.world-options__reset:hover {
  color: var(--hud-text-bright);
  background: var(--accent-hover);
}

.world-options__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.world-options__meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.world-options__label {
  font-size: 13px;
  color: var(--hud-text-bright);
}

.world-options__hint {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--hud-text-dim);
}

.world-options__control {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
}

.world-options__slider {
  width: 140px;
}

.world-options__select {
  width: 140px;
}

.world-options__readout {
  min-width: 46px;
  font-style: normal;
  font-size: 12px;
  text-align: right;
  color: var(--hud-text);
  font-variant-numeric: tabular-nums;
}

.world-options__readout i {
  font-style: normal;
  opacity: 0.6;
  margin-left: 1px;
}

/* Element Plus slider: chalk's defaults are its own blue, not the world's. */
.world-options__slider :deep(.el-slider__runway) {
  background-color: rgba(var(--accent-rgb), 0.15);
}

.world-options__slider :deep(.el-slider__bar) {
  background-color: var(--hud-cyan);
}

.world-options__slider :deep(.el-slider__button) {
  border-color: var(--hud-cyan);
  background-color: var(--surface-light);
}

@media (max-width: 520px) {
  .world-options__row {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  .world-options__control {
    justify-content: flex-end;
  }
}
</style>
