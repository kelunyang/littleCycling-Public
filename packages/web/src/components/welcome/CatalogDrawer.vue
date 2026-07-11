<template>
  <el-drawer
    :model-value="open"
    direction="btt"
    size="100%"
    :with-header="false"
    :append-to-body="true"
    @close="emit('close')"
  >
    <div class="catalog__header">
      <h3>
        <font-awesome-icon icon="route" />
        EuroVelo Catalog
      </h3>
      <el-button circle @click="emit('close')">
        <font-awesome-icon icon="xmark" />
      </el-button>
    </div>

    <div class="catalog__body">
      <p class="catalog__intro">
        <font-awesome-icon icon="circle-info" />
        Browse the 17 official EuroVelo long-distance cycle routes. Click a route
        to load its stages, then download any stage to your local route library.
      </p>

      <div v-if="catalogStore.loading && !catalogStore.hasData" class="catalog__status">
        <font-awesome-icon icon="spinner" spin />
        Loading catalog...
      </div>

      <div v-else-if="catalogStore.error && !catalogStore.hasData" class="catalog__status catalog__status--error">
        <font-awesome-icon icon="triangle-exclamation" />
        {{ catalogStore.error }}
      </div>

      <el-collapse
        v-else-if="catalogStore.catalog"
        v-model="expanded"
        class="catalog__races"
        @change="handleExpand"
      >
        <el-collapse-item
          v-for="race in catalogStore.catalog.races"
          :key="race.id"
          :name="race.id"
        >
          <template #title>
            <span class="catalog__race-name">
              {{ race.name }}
              <span
                class="catalog__race-count"
                :title="race.fetchedAt
                  ? `${downloadedCount(race)} of ${race.stages.length} stages saved locally`
                  : 'Not loaded yet — expand to fetch'"
              >
                <template v-if="race.fetchedAt">
                  ({{ downloadedCount(race) }}/{{ race.stages.length }})
                </template>
                <template v-else>
                  (not loaded)
                </template>
              </span>
            </span>
          </template>

          <div v-if="catalogStore.isFetching(race.id)" class="catalog__status">
            <font-awesome-icon icon="spinner" spin />
            Fetching GPX from eurovelo.com...
          </div>

          <div v-else-if="race.stages.length === 0" class="catalog__status">
            No stage data yet — expanding will trigger a fetch.
          </div>

          <div v-else class="catalog__stages">
            <div
              v-for="stage in race.stages"
              :key="stage.stage"
              class="catalog__stage"
              :class="{
                'catalog__stage--downloaded': catalogStore.isDownloaded(race.id, stage.stage),
              }"
            >
              <span class="catalog__stage-num">S{{ String(stage.stage).padStart(2, '0') }}</span>
              <span class="catalog__stage-name">{{ stage.name }}</span>
              <span
                class="catalog__stage-status"
                :class="`catalog__stage-status--${stage.status.toLowerCase()}`"
                :title="stage.status"
              >
                {{ shortStatus(stage.status) }}
              </span>
              <span v-if="stage.distanceKm > 0" class="catalog__stage-dist">
                {{ stage.distanceKm.toFixed(1) }} km
              </span>
              <span v-if="stage.elevGainM > 0" class="catalog__stage-elev">
                ↑ {{ stage.elevGainM }} m
              </span>

              <el-button
                v-if="catalogStore.isDownloading(race.id, stage.stage)"
                size="small"
                circle
                disabled
              >
                <font-awesome-icon icon="spinner" spin />
              </el-button>
              <el-button
                v-else-if="catalogStore.isDownloaded(race.id, stage.stage)"
                size="small"
                circle
                disabled
                class="catalog__stage-saved-btn"
                title="Already saved in your routes"
              >
                <font-awesome-icon icon="check" />
              </el-button>
              <el-button
                v-else
                size="small"
                circle
                title="Download to local routes"
                @click="catalogStore.downloadStage(race.id, stage.stage)"
              >
                <font-awesome-icon icon="download" />
              </el-button>
            </div>
          </div>
        </el-collapse-item>
      </el-collapse>

      <p class="catalog__attribution">
        {{ catalogStore.catalog?.attribution ?? 'Route data © EuroVelo (eurovelo.com), licensed under ODbL' }}
      </p>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type { CatalogRace, EuroVeloStageStatus } from '@littlecycling/shared';
import { useCatalogStore } from '@/stores/catalogStore';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const catalogStore = useCatalogStore();
const expanded = ref<string[]>([]);

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen && !catalogStore.hasData) {
      catalogStore.fetchCatalog();
    }
  },
  { immediate: true },
);

function handleExpand(active: string | string[]) {
  const ids = Array.isArray(active) ? active : [active];
  for (const id of ids) {
    const race = catalogStore.catalog?.races.find((r) => r.id === id);
    if (race && !race.fetchedAt && !catalogStore.isFetching(id)) {
      catalogStore.fetchRouteStages(id);
    }
  }
}

function downloadedCount(race: CatalogRace): number {
  let n = 0;
  for (const s of race.stages) {
    if (catalogStore.isDownloaded(race.id, s.stage)) n++;
  }
  return n;
}

function shortStatus(s: EuroVeloStageStatus): string {
  switch (s) {
    case 'CERTIFIED': return 'CERT';
    case 'DEVELOPED_SIGNED': return 'OK+';
    case 'DEVELOPED_UNSIGNED': return 'OK';
    case 'PARTIALLY_DEVELOPED_SIGNED': return 'PART+';
    case 'PARTIALLY_DEVELOPED_UNSIGNED': return 'PART';
    case 'UNDEVELOPED': return 'TBD';
    default: return '—';
  }
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
  overflow-y: auto;
}

.catalog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1.5px solid var(--hud-border-bright);
  position: relative;
}

.catalog__header::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 20px;
  right: 20px;
  height: 1px;
  background: linear-gradient(90deg, var(--hud-cyan), transparent);
  opacity: 0.5;
}

.catalog__header h3 {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  color: var(--hud-cyan);
  letter-spacing: 1px;
}

.catalog__header :deep(.el-button) {
  border-color: var(--hud-border);
  color: var(--hud-cyan);
  border-radius: 0;
}

.catalog__body {
  padding: 16px 20px 24px;
  max-width: 960px;
  margin: 0 auto;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.catalog__intro {
  font-family: var(--font-body);
  font-size: 14px;
  color: var(--hud-text);
  opacity: 0.85;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 6px;
  line-height: 1.5;
}

.catalog__status {
  font-family: var(--font-display);
  font-size: 14px;
  color: var(--hud-text);
  opacity: 0.75;
  padding: 12px 0;
  display: flex;
  align-items: center;
  gap: 8px;
  letter-spacing: 0.5px;
}

.catalog__status--error {
  color: var(--accent-danger);
  opacity: 1;
}

.catalog__races {
  display: flex;
  flex-direction: column;
}

.catalog__race-name {
  flex: 1;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 16px;
  letter-spacing: 0.5px;
  color: var(--hud-text-bright);
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
}

.catalog__race-count {
  font-family: var(--font-body);
  font-size: 14px;
  font-weight: 600;
  color: var(--hud-cyan);
  letter-spacing: 0;
}

:deep(.el-collapse) {
  border: none;
}

:deep(.el-collapse-item__header) {
  background: transparent;
  border-bottom: 1.5px solid var(--hud-border);
  color: var(--hud-text-bright);
  font-family: var(--font-display);
  letter-spacing: 0.5px;
  font-size: 16px;
  padding: 4px 6px;
  height: auto;
  min-height: 44px;
}

:deep(.el-collapse-item__arrow) {
  color: var(--hud-cyan);
  font-size: 14px;
}

:deep(.el-collapse-item__wrap) {
  background: transparent;
  border-bottom: 1.5px solid var(--hud-border);
}

:deep(.el-collapse-item__content) {
  padding-bottom: 8px;
}

.catalog__stages {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 6px 8px;
}

.catalog__stage {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  font-family: var(--font-body);
  font-size: 14px;
  color: var(--hud-text);
  border: 1.5px solid transparent;
  border-radius: var(--card-radius-sm);
  transition: background 0.15s, border-color 0.15s;
}

.catalog__stage:hover {
  background: var(--accent-tint);
  border-color: var(--hud-border);
}

.catalog__stage--downloaded {
  background: rgba(102,187,106,0.10);
  border-color: rgba(102,187,106,0.4);
}

.catalog__stage--downloaded .catalog__stage-name {
  color: #2e7d32;
}

.catalog__stage-saved-btn:is(.is-disabled, [disabled]) {
  color: #2e7d32 !important;
  border-color: rgba(46, 125, 50, 0.6) !important;
  background: rgba(102, 187, 106, 0.16) !important;
  opacity: 1 !important;
  cursor: default !important;
}

.catalog__stage-num {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 14px;
  color: var(--hud-text-bright);
  background: var(--accent-tint);
  border: 1.5px solid var(--hud-border);
  border-radius: var(--card-radius-sm);
  padding: 2px 8px;
  min-width: 46px;
  text-align: center;
  letter-spacing: 0.5px;
}

.catalog__stage-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  color: var(--hud-text-bright);
}

.catalog__stage-status {
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 3px 8px;
  border: 1.5px solid currentColor;
  border-radius: var(--card-radius-sm);
  min-width: 44px;
  text-align: center;
}

.catalog__stage-status--certified,
.catalog__stage-status--developed_signed,
.catalog__stage-status--developed_unsigned {
  color: #66bb6a;
}

.catalog__stage-status--partially_developed_signed,
.catalog__stage-status--partially_developed_unsigned {
  color: var(--hud-yellow);
}

.catalog__stage-status--undeveloped {
  color: var(--accent-danger);
  opacity: 0.8;
}

.catalog__stage-status--other {
  color: var(--hud-text);
  opacity: 0.5;
}

.catalog__stage-dist,
.catalog__stage-elev {
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--hud-text);
  opacity: 0.85;
  white-space: nowrap;
  letter-spacing: 0.3px;
  min-width: 64px;
  text-align: right;
}

.catalog__attribution {
  font-family: var(--font-body);
  font-size: 12px;
  color: var(--hud-text-dim);
  text-align: center;
  letter-spacing: 0.3px;
  padding-top: 12px;
  margin: 0;
}
</style>
