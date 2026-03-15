<template>
  <div class="catalog-tab">
    <div v-if="catalogStore.loading" class="catalog-tab__status">
      <font-awesome-icon icon="spinner" spin /> Fetching EuroVelo route catalog...
    </div>

    <div v-else-if="catalogStore.error" class="catalog-tab__status catalog-tab__status--error">
      <font-awesome-icon icon="triangle-exclamation" />
      {{ catalogStore.error }}
    </div>

    <div v-else-if="!catalogStore.hasData" class="catalog-tab__status">
      No EuroVelo routes available.
    </div>

    <div v-else class="catalog-tab__races">
      <el-collapse v-model="expanded">
        <el-collapse-item
          v-for="race in catalogStore.catalog!.races"
          :key="race.id"
          :name="race.id"
        >
          <template #title>
            <span class="catalog-tab__race-name">{{ race.name }}</span>
            <span class="catalog-tab__race-count">{{ race.stages.length }} stages</span>
          </template>

          <div class="catalog-tab__stages">
            <div
              v-for="stage in race.stages"
              :key="stage.stage"
              class="catalog-tab__stage"
              :class="{
                'catalog-tab__stage--downloaded': catalogStore.isDownloaded(race.id, stage.stage),
                'catalog-tab__stage--selected': isSelected(race.id, stage.stage),
              }"
              @click="handleStageClick(race.id, stage)"
            >
              <span class="catalog-tab__stage-num">S{{ stage.stage }}</span>
              <span class="catalog-tab__stage-name">{{ stage.name }}</span>
              <span v-if="stage.distanceKm > 0" class="catalog-tab__stage-dist">{{ stage.distanceKm }}km</span>

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
                type="success"
                disabled
              >
                <font-awesome-icon icon="check" />
              </el-button>
              <el-button
                v-else
                size="small"
                circle
                @click.stop="catalogStore.downloadStage(race.id, stage.stage)"
              >
                <font-awesome-icon icon="download" />
              </el-button>
            </div>
          </div>
        </el-collapse-item>
      </el-collapse>

      <div class="catalog-tab__attribution">
        Route data &copy; EuroVelo (eurovelo.com), available under ODbL
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import type { CatalogStage } from '@littlecycling/shared';
import { useCatalogStore } from '@/stores/catalogStore';
import { useRouteStore } from '@/stores/routeStore';

const catalogStore = useCatalogStore();
const routeStore = useRouteStore();

const expanded = ref<string[]>([]);

function handleStageClick(raceId: string, stage: CatalogStage) {
  if (!catalogStore.isDownloaded(raceId, stage.stage)) return;

  // Find route by matching fileName pattern
  const fn = `${raceId}-stage-${stage.stage}.gpx`;
  const route = routeStore.savedRoutes.find((r) => r.fileName === fn);
  if (route) {
    routeStore.selectRoute(route.id);
  }
}

function isSelected(raceId: string, stageNum: number): boolean {
  if (!routeStore.activeRoute) return false;
  const fn = `${raceId}-stage-${stageNum}.gpx`;
  return routeStore.activeRoute.fileName === fn;
}

onMounted(() => {
  if (!catalogStore.hasData) {
    catalogStore.fetchCatalog();
  }
});

// Auto-expand first race once data arrives
watch(() => catalogStore.catalog, (cat) => {
  if (cat && cat.races.length > 0 && expanded.value.length === 0) {
    expanded.value = [cat.races[0].id];
  }
}, { immediate: true });
</script>

<style scoped>
.catalog-tab {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.catalog-tab__status {
  font-size: 11px;
  color: var(--hud-text);
  opacity: 0.6;
  padding: 12px 0;
  display: flex;
  align-items: center;
  gap: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.catalog-tab__status--error {
  color: var(--accent-danger);
  opacity: 1;
  text-shadow: 0 0 8px rgba(255,45,107,0.4);
}

.catalog-tab__races {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 300px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(0,229,255,0.3) transparent;
}

.catalog-tab__race-name {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.catalog-tab__race-count {
  margin-left: auto;
  font-size: 10px;
  font-weight: 400;
  color: var(--hud-text);
  opacity: 0.6;
  margin-right: 8px;
  letter-spacing: 0.5px;
}

:deep(.el-collapse) {
  border: none;
}

:deep(.el-collapse-item__header) {
  background: transparent;
  border-bottom: 1px solid var(--hud-border);
  color: var(--hud-text-bright);
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 1px;
  font-size: 11px;
}

:deep(.el-collapse-item__wrap) {
  background: transparent;
  border-bottom: 1px solid var(--hud-border);
}

:deep(.el-collapse-item__content) {
  padding-bottom: 8px;
}

.catalog-tab__stages {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 12px;
}

.catalog-tab__stage {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  clip-path: var(--clip-panel-sm);
  font-size: 11px;
  color: var(--hud-text);
  transition: background 0.15s, filter 0.15s;
}

.catalog-tab__stage--downloaded {
  cursor: pointer;
}

.catalog-tab__stage--downloaded:hover {
  background: rgba(0,229,255,0.04);
}

.catalog-tab__stage--selected {
  background: rgba(0,229,255,0.08);
  border: 1px solid var(--hud-cyan);
  filter: drop-shadow(0 0 6px rgba(0,229,255,0.4));
}

.catalog-tab__stage-num {
  font-family: var(--font-display);
  font-weight: 700;
  color: var(--hud-yellow);
  min-width: 28px;
  letter-spacing: 1px;
}

.catalog-tab__stage-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.catalog-tab__stage-dist {
  font-size: 10px;
  opacity: 0.6;
  white-space: nowrap;
  letter-spacing: 0.5px;
}

.catalog-tab__attribution {
  font-size: 9px;
  color: var(--hud-text);
  opacity: 0.4;
  padding: 8px 0 0;
  text-align: center;
  letter-spacing: 0.3px;
}
</style>
