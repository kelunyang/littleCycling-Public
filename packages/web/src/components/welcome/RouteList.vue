<template>
  <div class="route-list">
    <input
      ref="fileInput"
      type="file"
      accept=".gpx,.tcx,.fit"
      class="route-list__file-input"
      @change="handleFileInput"
    />

    <div class="route-list__body">
      <div
        class="route-list__panel"
        :class="{ 'route-list__panel--dragging': isDragging }"
        @dragover.prevent="isDragging = true"
        @dragleave.prevent="isDragging = false"
        @drop.prevent="handleDrop"
      >
        <div v-if="routeStore.savedRoutes.length === 0" class="route-list__empty">
          <div class="route-list__empty-icons">
            <font-awesome-icon icon="upload" />
            <span class="route-list__empty-sep">/</span>
            <font-awesome-icon icon="route" />
          </div>
          <span class="route-list__empty-title">No routes yet</span>
          <span class="route-list__empty-hint">
            Use the
            <font-awesome-icon icon="upload" />
            button above to upload a GPX / TCX / FIT file,
            or
            <font-awesome-icon icon="route" />
            to browse the EuroVelo catalog. You can also drop a file here.
          </span>
        </div>
        <div v-else class="route-list__items">
          <RouteCard
            v-for="route in routeStore.savedRoutes"
            :key="route.id"
            :route="route"
            :selected="routeStore.activeRoute?.id === route.id"
            @select="handleSelect(route.id)"
            @remove="routeStore.removeRoute(route.id)"
          />
        </div>
      </div>

      <div class="route-list__preview">
        <RoutePreviewMap
          v-if="routeStore.activeRoute"
          :route-points="routeStore.activeRoute.points"
        />
        <div v-else class="route-list__preview-empty">
          <font-awesome-icon icon="map" />
          <span>Select a route to preview</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouteStore } from '@/stores/routeStore';
import RouteCard from './RouteCard.vue';
import RoutePreviewMap from './RoutePreviewMap.vue';

const emit = defineEmits<{
  (e: 'selected', routeId: string): void;
}>();

const routeStore = useRouteStore();
const isDragging = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

async function handleSelect(routeId: string) {
  await routeStore.selectRoute(routeId);
  emit('selected', routeId);
}

function openFilePicker() {
  fileInput.value?.click();
}

function handleDrop(e: DragEvent) {
  isDragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) readFile(file);
}

function handleFileInput(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) readFile(file);
  input.value = '';
}

function readFile(file: File) {
  const isFit = file.name.toLowerCase().endsWith('.fit');
  const reader = new FileReader();
  reader.onload = async () => {
    if (reader.result == null) return;
    try {
      const route = await routeStore.importRoute(file.name, reader.result);
      await routeStore.selectRoute(route.id);
      emit('selected', route.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to import route');
    }
  };
  if (isFit) {
    reader.readAsArrayBuffer(file);
  } else {
    reader.readAsText(file);
  }
}

defineExpose({ openFilePicker });
</script>

<style scoped>
.route-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.route-list__file-input {
  display: none;
}

.route-list__body {
  display: flex;
  gap: 12px;
  align-items: stretch;
}

.route-list__panel {
  flex: 1;
  min-width: 0;
  border: 1.5px solid transparent;
  transition: border-color 0.15s, background 0.15s;
}

.route-list__panel--dragging {
  border-color: var(--hud-cyan);
  background: rgba(var(--accent-rgb), 0.06);
}

.route-list__items {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 300px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(var(--accent-rgb), 0.3) transparent;
}

.route-list__items::-webkit-scrollbar {
  width: 4px;
}

.route-list__items::-webkit-scrollbar-thumb {
  background: rgba(var(--accent-rgb), 0.3);
}

.route-list__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px 16px;
  color: var(--hud-text);
  text-align: center;
}

.route-list__empty-icons {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  color: var(--hud-cyan);
  opacity: 0.7;
  margin-bottom: 4px;
}

.route-list__empty-sep {
  font-size: 14px;
  opacity: 0.4;
}

.route-list__empty-title {
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: var(--hud-text-bright);
  opacity: 0.85;
}

.route-list__empty-hint {
  font-size: 11px;
  line-height: 1.6;
  opacity: 0.6;
  max-width: 320px;
}

.route-list__empty-hint :deep(.svg-inline--fa) {
  font-size: 11px;
  color: var(--hud-cyan);
  opacity: 0.9;
  margin: 0 2px;
  vertical-align: -1px;
}

.route-list__preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
}

.route-list__preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 180px;
  height: 120px;
  border: 1px dashed var(--hud-border);
  font-family: var(--font-display);
  font-size: 9px;
  color: var(--hud-text);
  opacity: 0.4;
  text-transform: uppercase;
  letter-spacing: 1px;
  text-align: center;
}

.route-list__preview-empty :deep(.svg-inline--fa) {
  font-size: 18px;
}
</style>
