import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { RouteCatalog } from '@littlecycling/shared';
import { useRouteStore } from './routeStore';

export const useCatalogStore = defineStore('catalog', () => {
  const catalog = ref<RouteCatalog | null>(null);
  const downloadedStageIds = ref<Set<string>>(new Set());
  const downloading = ref<Set<string>>(new Set());
  const loading = ref(false);
  const error = ref<string | null>(null);

  const hasData = computed(() => catalog.value !== null);

  /** Fetch catalog + downloaded status from server. */
  async function fetchCatalog() {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch('/api/catalog');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      catalog.value = data.catalog as RouteCatalog;
      downloadedStageIds.value = new Set(data.downloadedStageIds as string[]);
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  /** Download a stage GPX via server, then refresh route list. */
  async function downloadStage(raceId: string, stage: number) {
    const key = `${raceId}-s${stage}`;
    if (downloading.value.has(key)) return; // already in progress

    downloading.value.add(key);
    try {
      const res = await fetch('/api/catalog/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raceId, stage }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as Record<string, string>).error || `HTTP ${res.status}`);
      }

      // Mark as downloaded
      downloadedStageIds.value.add(key);

      // Refresh the route list so the new route appears in "My Routes"
      const routeStore = useRouteStore();
      await routeStore.fetchRoutes();
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      downloading.value.delete(key);
    }
  }

  function isDownloaded(raceId: string, stage: number): boolean {
    return downloadedStageIds.value.has(`${raceId}-s${stage}`);
  }

  function isDownloading(raceId: string, stage: number): boolean {
    return downloading.value.has(`${raceId}-s${stage}`);
  }

  return {
    catalog, downloadedStageIds, downloading, loading, error, hasData,
    fetchCatalog, downloadStage, isDownloaded, isDownloading,
  };
});
