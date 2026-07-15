<template>
  <el-drawer
    :model-value="open"
    direction="btt"
    size="100%"
    :with-header="false"
    :append-to-body="true"
    @close="emit('close')"
  >
    <div class="picker__header">
      <h3>
        <font-awesome-icon icon="list-check" />
        選擇要分析的訓練
      </h3>
      <el-button circle @click="emit('close')">
        <font-awesome-icon icon="xmark" />
      </el-button>
    </div>

    <div class="picker__body">
      <!-- 搜尋列 -->
      <div class="picker__search">
        <label class="picker__field">
          <span class="picker__field-label">日期範圍</span>
          <el-date-picker
            v-model="dateRange"
            type="daterange"
            unlink-panels
            range-separator="→"
            start-placeholder="開始"
            end-placeholder="結束"
            size="small"
            style="width: 100%"
          />
        </label>

        <label class="picker__field">
          <span class="picker__field-label">訓練模式</span>
          <el-select v-model="mode" size="small">
            <el-option label="全部" value="all" />
            <el-option label="課表訓練" value="plan" />
            <el-option label="自由騎" value="free" />
            <el-option
              v-for="profile in WORKOUT_PROFILES"
              :key="profile.id"
              :label="profile.name"
              :value="profile.id"
            />
          </el-select>
        </label>

        <label class="picker__field picker__field--switch">
          <span class="picker__field-label">隱藏 0 km / 0 W</span>
          <el-switch v-model="excludeEmpty" />
        </label>
      </div>

      <!-- 列表 -->
      <div class="picker__list">
        <div v-if="loading && rides.length === 0" class="picker__empty">
          <font-awesome-icon icon="spinner" spin />
          載入中…
        </div>
        <div v-else-if="rides.length === 0" class="picker__empty">
          沒有符合條件的訓練紀錄。
        </div>

        <div
          v-for="ride in rides"
          :key="ride.id"
          class="picker__row"
          :class="{ 'picker__row--selected': analysisStore.isSelected(ride.id) }"
          @click="onRowClick(ride)"
        >
          <el-checkbox
            :model-value="analysisStore.isSelected(ride.id)"
            :disabled="isDisabled(ride.id)"
            @click.stop
            @change="analysisStore.toggleRide(ride)"
          />
          <div class="picker__row-main">
            <div class="picker__row-top">
              <span class="picker__row-date">{{ formatDate(ride.startedAt) }}</span>
              <span class="picker__row-mode">{{ modeLabel(ride) }}</span>
            </div>
            <div class="picker__row-stats">
              <span>{{ formatDuration(ride.durationMs) }}</span>
              <span>{{ (ride.distanceM / 1000).toFixed(1) }} km</span>
              <span v-if="ride.avgPowerW">{{ Math.round(ride.avgPowerW) }} W</span>
              <span v-if="ride.avgHr">{{ Math.round(ride.avgHr) }} bpm</span>
            </div>
          </div>
        </div>

        <div v-if="atCap" class="picker__cap-hint">
          <font-awesome-icon icon="circle-info" />
          已達上限 {{ MAX_ANALYSIS_RIDES }} 筆
        </div>

        <el-button
          v-if="hasMore"
          class="picker__more"
          :loading="loading"
          @click="loadMore"
        >
          <font-awesome-icon v-if="!loading" icon="chevron-down" />
          載入更多
        </el-button>
      </div>
    </div>

    <!-- footer -->
    <div class="picker__footer">
      <span class="picker__count">
        已選 {{ analysisStore.selectedRides.length }} / {{ MAX_ANALYSIS_RIDES }}
      </span>
      <div class="picker__footer-actions">
        <el-button
          :disabled="analysisStore.selectedRides.length === 0"
          @click="analysisStore.clearRides()"
        >
          <font-awesome-icon icon="trash" style="margin-right: 6px" />
          清除全部
        </el-button>
        <el-button type="primary" @click="emit('close')">
          <font-awesome-icon icon="check" style="margin-right: 6px" />
          完成
        </el-button>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import dayjs from 'dayjs';
import type { Ride } from '@littlecycling/shared';
import { WORKOUT_PROFILES, WORKOUT_PROFILES_MAP, MAX_ANALYSIS_RIDES } from '@littlecycling/shared';
import { useAnalysisStore, RIDE_PICKER_EXCLUDE_EMPTY_KEY, readExcludeEmpty } from '@/stores/analysisStore';
import { notifyWarn } from '@/utils/notify';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const analysisStore = useAnalysisStore();

const PAGE_SIZE = 30;

// ── 搜尋條件 ──
const dateRange = ref<[Date, Date] | null>(null);
const mode = ref<string>('all');
const excludeEmpty = ref<boolean>(readExcludeEmpty());

// ── 列表狀態 ──
const rides = ref<Ride[]>([]);
const offset = ref(0);
const loading = ref(false);
const hasMore = ref(false);

const atCap = computed(() => analysisStore.selectedRides.length >= MAX_ANALYSIS_RIDES);

/** 未勾選但已達上限 → 停用 checkbox(已勾選者仍可取消)。 */
function isDisabled(id: number): boolean {
  return atCap.value && !analysisStore.isSelected(id);
}

function buildQuery(off: number): string {
  const params = new URLSearchParams();
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(off));
  if (dateRange.value) {
    // 結束日含當日整天(endOf('day'))。
    params.set('from', String(dayjs(dateRange.value[0]).startOf('day').valueOf()));
    params.set('to', String(dayjs(dateRange.value[1]).endOf('day').valueOf()));
  }
  if (mode.value && mode.value !== 'all') params.set('mode', mode.value);
  if (excludeEmpty.value) params.set('excludeEmpty', '1');
  return params.toString();
}

async function fetchPage(reset: boolean) {
  loading.value = true;
  try {
    const off = reset ? 0 : offset.value;
    const res = await fetch(`/api/rides?${buildQuery(off)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const page = (data.rides ?? []) as Ride[];
    rides.value = reset ? page : [...rides.value, ...page];
    offset.value = off + page.length;
    hasMore.value = page.length === PAGE_SIZE;
  } catch {
    notifyWarn('讀取訓練紀錄失敗');
  } finally {
    loading.value = false;
  }
}

function loadMore() {
  if (loading.value) return;
  void fetchPage(false);
}

function onRowClick(ride: Ride) {
  if (isDisabled(ride.id)) return;
  analysisStore.toggleRide(ride);
}

// 開啟時拉第一頁;篩選條件變動時重置列表。
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) void fetchPage(true);
  },
  { immediate: true },
);

watch([dateRange, mode, excludeEmpty], () => {
  if (props.open) void fetchPage(true);
});

// 開關狀態持久化到 localStorage(analysisStore.generate 讀同一把 key)。
watch(excludeEmpty, (v) => {
  localStorage.setItem(RIDE_PICKER_EXCLUDE_EMPTY_KEY, v ? 'true' : 'false');
});

// ── 顯示輔助 ──
function modeLabel(ride: Ride): string {
  if (ride.workoutId && WORKOUT_PROFILES_MAP[ride.workoutId]) {
    return WORKOUT_PROFILES_MAP[ride.workoutId].name;
  }
  if ((ride.workoutId && ride.workoutId.startsWith('plan:')) || ride.planId) {
    return '課表訓練';
  }
  return '自由騎';
}

function formatDate(tsEpoch: number): string {
  return dayjs(tsEpoch).format('YYYY-MM-DD HH:mm');
}

function formatDuration(ms?: number): string {
  if (!ms) return '--:--';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}
</script>

<style scoped>
:deep(.el-drawer) {
  background: var(--surface) !important;
}

:deep(.el-drawer__body) {
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.picker__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1.5px solid var(--hud-border-bright);
  flex-shrink: 0;
}

.picker__header h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-transform: uppercase;
  letter-spacing: 2px;
  text-shadow: 0 0 10px rgba(var(--accent-rgb), 0.3);
}

.picker__header :deep(.el-button) {
  border-color: var(--hud-border);
  color: var(--hud-cyan);
  border-radius: 0;
}

.picker__body {
  flex: 1;
  min-height: 0;
  padding: 16px 20px;
  max-width: 720px;
  margin: 0 auto;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow: hidden;
}

/* ── 搜尋列 ── */
.picker__search {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
}

.picker__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 180px;
}

.picker__field--switch {
  flex: 0 0 auto;
  min-width: 0;
}

.picker__field-label {
  font-size: 11px;
  color: var(--hud-text);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* ── 列表 ── */
.picker__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  scrollbar-width: thin;
  scrollbar-color: rgba(var(--accent-rgb), 0.3) transparent;
  padding-right: 4px;
}

.picker__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 12px;
  color: var(--hud-text-dim);
  padding: 24px 0;
  text-align: center;
}

.picker__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(var(--accent-rgb), 0.02);
  border: 1.5px solid var(--hud-border);
  clip-path: var(--clip-panel-sm);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.picker__row:hover {
  border-color: var(--hud-cyan);
  background: rgba(var(--accent-rgb), 0.05);
}

.picker__row--selected {
  border-color: var(--hud-cyan);
  background: rgba(var(--accent-rgb), 0.08);
}

.picker__row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.picker__row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.picker__row-date {
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 600;
  color: var(--hud-text-bright);
  letter-spacing: 0.5px;
}

.picker__row-mode {
  font-size: 10px;
  color: var(--hud-cyan);
  background: rgba(var(--accent-rgb), 0.1);
  border: 1.5px solid rgba(var(--accent-rgb), 0.2);
  padding: 1px 6px;
  letter-spacing: 0.5px;
  white-space: nowrap;
}

.picker__row-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 10px;
  color: var(--hud-text);
  opacity: 0.7;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.picker__cap-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 11px;
  color: var(--accent-coin);
  padding: 6px 0;
  letter-spacing: 0.5px;
}

.picker__more {
  align-self: center;
  margin-top: 4px;
  border-color: var(--hud-border);
  color: var(--hud-cyan);
}

/* ── footer ── */
.picker__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 20px;
  border-top: 1.5px solid var(--hud-border-bright);
  flex-shrink: 0;
  max-width: 720px;
  margin: 0 auto;
  width: 100%;
}

.picker__count {
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  color: var(--hud-cyan);
  letter-spacing: 1px;
}

.picker__footer-actions {
  display: flex;
  gap: 8px;
}

.picker__footer-actions :deep(.el-button) {
  font-family: var(--font-display);
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
}
</style>
