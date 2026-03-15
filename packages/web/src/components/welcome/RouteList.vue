<template>
  <div class="route-list">
    <el-tabs v-model="activeTab">
      <el-tab-pane name="my">
        <template #label>
          <font-awesome-icon icon="route" style="margin-right: 6px;" />
          My Routes
        </template>
        <div class="route-list__content">
          <div v-if="routeStore.savedRoutes.length === 0" class="route-list__empty">
            No routes yet. Upload a GPX, TCX, or FIT file to get started.
          </div>

          <div v-else class="route-list__items">
            <RouteCard
              v-for="route in routeStore.savedRoutes"
              :key="route.id"
              :route="route"
              :selected="routeStore.activeRoute?.id === route.id"
              @select="routeStore.selectRoute(route.id)"
              @remove="routeStore.removeRoute(route.id)"
            />
          </div>

          <FileDropZone @file-loaded="handleFileLoaded" />
        </div>
      </el-tab-pane>

      <el-tab-pane name="catalog">
        <template #label>
          <font-awesome-icon icon="bicycle" style="margin-right: 6px;" />
          EuroVelo
        </template>
        <div class="route-list__content">
          <CatalogTab />
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouteStore } from '@/stores/routeStore';
import RouteCard from './RouteCard.vue';
import FileDropZone from './FileDropZone.vue';
import CatalogTab from './CatalogTab.vue';

const routeStore = useRouteStore();
const activeTab = ref<'my' | 'catalog'>('my');

async function handleFileLoaded(fileName: string, content: string | ArrayBuffer) {
  try {
    const route = await routeStore.importRoute(fileName, content);
    await routeStore.selectRoute(route.id);
  } catch (err) {
    alert(err instanceof Error ? err.message : 'Failed to import route');
  }
}
</script>

<style scoped>
.route-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.route-list :deep(.el-tabs__active-bar) {
  background-color: var(--hud-cyan);
  box-shadow: 0 0 8px rgba(0,229,255,0.6);
  height: 2px;
}

.route-list :deep(.el-tabs__nav-wrap::after) {
  background: linear-gradient(90deg, var(--hud-cyan), transparent);
  opacity: 0.3;
  height: 1px;
}

.route-list :deep(.el-tabs__item) {
  font-family: var(--font-display);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--hud-text);
}

.route-list :deep(.el-tabs__item.is-active) {
  color: var(--hud-cyan);
  text-shadow: 0 0 8px rgba(0,229,255,0.4);
}

.route-list__content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.route-list__empty {
  font-size: 11px;
  color: var(--hud-text);
  opacity: 0.6;
  padding: 12px 0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.route-list__items {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 300px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(0,229,255,0.3) transparent;
}

.route-list__items::-webkit-scrollbar {
  width: 4px;
}

.route-list__items::-webkit-scrollbar-thumb {
  background: rgba(0,229,255,0.3);
}
</style>
