<template>
  <Teleport v-if="mode === 'modal'" to="body">
    <div class="hud-customize-modal" @click="emit('close')">
      <div class="hud-customize hud-customize--center" @click.stop>
        <div class="hud-customize__header">
          <span class="hud-customize__title">CUSTOMIZE HUD METRICS</span>
          <button class="hud-customize__close" @click="emit('close')" aria-label="Close">
            <font-awesome-icon icon="xmark" />
          </button>
        </div>

        <p class="hud-customize__hint">
          Pick up to {{ HUD_METRIC_LIMIT }} metrics — order on the right defines display order.
        </p>

        <el-transfer
          v-model="selected"
          :data="transferData"
          :titles="['Available', `Shown (${selected.length}/${HUD_METRIC_LIMIT})`]"
          :button-texts="['Remove', 'Add']"
          target-order="push"
          filterable
          class="hud-customize__transfer"
        />

        <div class="hud-customize__order">
          <div class="hud-customize__order-label">DISPLAY ORDER</div>
          <ol v-if="selected.length > 0" class="hud-customize__order-list">
            <li
              v-for="(id, idx) in selected"
              :key="id"
              class="hud-customize__order-row"
            >
              <font-awesome-icon :icon="metricById(id)?.icon ?? 'gear'" class="hud-customize__order-icon" />
              <span class="hud-customize__order-name">{{ metricById(id)?.label ?? id }}</span>
              <span class="hud-customize__order-unit">{{ metricById(id)?.unit ?? '' }}</span>
              <button
                class="hud-customize__order-btn"
                :disabled="idx === 0"
                @click="hudStore.moveUp(id)"
                aria-label="Move up"
              >
                <font-awesome-icon icon="chevron-up" />
              </button>
              <button
                class="hud-customize__order-btn"
                :disabled="idx === selected.length - 1"
                @click="hudStore.moveDown(id)"
                aria-label="Move down"
              >
                <font-awesome-icon icon="chevron-down" />
              </button>
            </li>
          </ol>
          <p v-else class="hud-customize__order-empty">No metrics selected.</p>
        </div>

        <div class="hud-customize__footer">
          <button class="hud-customize__reset" @click="hudStore.resetToDefaults()">
            <font-awesome-icon icon="rotate-left" />
            Reset to defaults
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <div v-else class="hud-customize" @click.stop>
    <div class="hud-customize__header">
      <span class="hud-customize__title">CUSTOMIZE HUD METRICS</span>
      <button class="hud-customize__close" @click="emit('close')" aria-label="Close">
        <font-awesome-icon icon="xmark" />
      </button>
    </div>

    <p class="hud-customize__hint">
      Pick up to {{ HUD_METRIC_LIMIT }} metrics — order on the right defines display order.
    </p>

    <el-transfer
      v-model="selected"
      :data="transferData"
      :titles="['Available', `Shown (${selected.length}/${HUD_METRIC_LIMIT})`]"
      :button-texts="['Remove', 'Add']"
      target-order="push"
      filterable
      class="hud-customize__transfer"
    />

    <div class="hud-customize__order">
      <div class="hud-customize__order-label">DISPLAY ORDER</div>
      <ol v-if="selected.length > 0" class="hud-customize__order-list">
        <li
          v-for="(id, idx) in selected"
          :key="id"
          class="hud-customize__order-row"
        >
          <font-awesome-icon :icon="metricById(id)?.icon ?? 'gear'" class="hud-customize__order-icon" />
          <span class="hud-customize__order-name">{{ metricById(id)?.label ?? id }}</span>
          <span class="hud-customize__order-unit">{{ metricById(id)?.unit ?? '' }}</span>
          <button
            class="hud-customize__order-btn"
            :disabled="idx === 0"
            @click="hudStore.moveUp(id)"
            aria-label="Move up"
          >
            <font-awesome-icon icon="chevron-up" />
          </button>
          <button
            class="hud-customize__order-btn"
            :disabled="idx === selected.length - 1"
            @click="hudStore.moveDown(id)"
            aria-label="Move down"
          >
            <font-awesome-icon icon="chevron-down" />
          </button>
        </li>
      </ol>
      <p v-else class="hud-customize__order-empty">No metrics selected.</p>
    </div>

    <div class="hud-customize__footer">
      <button class="hud-customize__reset" @click="hudStore.resetToDefaults()">
        <font-awesome-icon icon="rotate-left" />
        Reset to defaults
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import {
  useHudStore,
  HUD_METRIC_CATALOG,
  HUD_METRIC_LIMIT,
  type HudMetricId,
} from '@/stores/hudStore';

withDefaults(
  defineProps<{ mode?: 'dropdown' | 'modal' }>(),
  { mode: 'dropdown' },
);
const emit = defineEmits<{ close: [] }>();
const hudStore = useHudStore();

const selected = computed<HudMetricId[]>({
  get: () => hudStore.visibleMetrics,
  set: (next) => hudStore.setVisibleMetrics(next),
});

const transferData = computed(() =>
  HUD_METRIC_CATALOG.map((m) => ({
    key: m.id,
    label: `${m.label} · ${m.unit}`,
    disabled:
      !hudStore.visibleMetrics.includes(m.id) &&
      hudStore.visibleMetrics.length >= HUD_METRIC_LIMIT,
  })),
);

function metricById(id: HudMetricId) {
  return HUD_METRIC_CATALOG.find((m) => m.id === id);
}
</script>

<style scoped>
.hud-customize {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  width: 540px;
  max-width: calc(100vw - 32px);
  background: var(--hud-bg);
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
  color: var(--hud-text);
  opacity: 0.75;
  margin: 0;
}

.hud-customize__transfer {
  --el-transfer-panel-width: 220px;
}

.hud-customize__transfer :deep(.el-transfer-panel) {
  background: rgba(0, 0, 0, 0.35);
  border-color: var(--hud-border);
}

.hud-customize__order {
  border-top: 1.5px solid var(--hud-border);
  padding-top: 10px;
}

.hud-customize__order-label {
  font-family: var(--font-display);
  font-size: 9px;
  font-weight: 700;
  color: var(--hud-cyan);
  opacity: 0.7;
  letter-spacing: 2px;
  margin-bottom: 6px;
}

.hud-customize__order-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hud-customize__order-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: rgba(var(--accent-rgb), 0.05);
  border: 1.5px solid var(--hud-border);
  border-radius: 2px;
}

.hud-customize__order-icon {
  color: var(--hud-cyan);
  font-size: 12px;
  width: 14px;
  text-align: center;
}

.hud-customize__order-name {
  flex: 1;
  font-family: var(--font-body);
  font-size: 12px;
  color: var(--hud-text-bright);
}

.hud-customize__order-unit {
  font-family: var(--font-body);
  font-size: 9px;
  color: var(--hud-cyan);
  opacity: 0.6;
  letter-spacing: 1px;
}

.hud-customize__order-btn {
  background: transparent;
  color: var(--hud-cyan);
  border: 1.5px solid var(--hud-border);
  width: 22px;
  height: 22px;
  cursor: pointer;
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, border-color 0.15s, opacity 0.15s;
}

.hud-customize__order-btn:hover:not(:disabled) {
  background: rgba(var(--accent-rgb), 0.12);
  border-color: var(--hud-cyan);
}

.hud-customize__order-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.hud-customize__order-empty {
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--hud-text);
  opacity: 0.55;
  margin: 0;
}

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
</style>
