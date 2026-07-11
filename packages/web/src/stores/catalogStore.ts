import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { RouteCatalog, SavedRoute } from '@littlecycling/shared';
import { useRouteStore } from './routeStore';
import { notifyError, notifySuccess, notifyWarn } from '@/utils/notify';

type DownloadResponse = SavedRoute & { created: boolean };

export const useCatalogStore = defineStore('catalog', () => {
  const catalog = ref<RouteCatalog | null>(null);
  const downloadedStageIds = ref<Set<string>>(new Set());
  const fetchingRoutes = ref<Set<string>>(new Set());
  const downloading = ref<Set<string>>(new Set());
  const loading = ref(false);
  const error = ref<string | null>(null);

  const hasData = computed(() => catalog.value !== null);

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
      notifyError(`Catalog: ${(err as Error).message}`);
    } finally {
      loading.value = false;
    }
  }

  /** Fetch (or revalidate) a single route's stage list. */
  async function fetchRouteStages(routeId: string) {
    if (fetchingRoutes.value.has(routeId)) return;
    fetchingRoutes.value.add(routeId);
    try {
      const res = await fetch(`/api/catalog/route/${routeId}/fetch`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as Record<string, string>).error || `HTTP ${res.status}`);
      }
      const updated = await res.json();
      if (catalog.value) {
        const idx = catalog.value.races.findIndex((r) => r.id === routeId);
        if (idx >= 0) catalog.value.races[idx] = updated;
      }
    } catch (err) {
      notifyError(`Failed to load EuroVelo stages: ${(err as Error).message}`);
    } finally {
      fetchingRoutes.value.delete(routeId);
    }
  }

  async function downloadStage(routeId: string, stage: number) {
    const key = `${routeId}-s${stage}`;
    if (downloading.value.has(key)) return;
    downloading.value.add(key);
    try {
      const res = await fetch('/api/catalog/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routeId, stage }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as Record<string, string>).error || `HTTP ${res.status}`);
      }
      const saved = (await res.json()) as DownloadResponse;
      downloadedStageIds.value.add(key);

      const routeStore = useRouteStore();
      const existingIdx = routeStore.savedRoutes.findIndex((r) => r.id === saved.id);
      if (existingIdx === -1) {
        routeStore.savedRoutes.unshift(saved);
      }
      await routeStore.fetchRoutes();

      if (saved.created) {
        notifySuccess(`Saved: ${saved.name}`);
      } else {
        notifyWarn(`Already in your routes: ${saved.name}`);
      }
    } catch (err) {
      notifyError(`Stage download failed: ${(err as Error).message}`);
    } finally {
      downloading.value.delete(key);
    }
  }

  function isDownloaded(routeId: string, stage: number): boolean {
    return downloadedStageIds.value.has(`${routeId}-s${stage}`);
  }

  function isDownloading(routeId: string, stage: number): boolean {
    return downloading.value.has(`${routeId}-s${stage}`);
  }

  function isFetching(routeId: string): boolean {
    return fetchingRoutes.value.has(routeId);
  }

  return {
    catalog,
    downloadedStageIds,
    downloading,
    fetchingRoutes,
    loading,
    error,
    hasData,
    fetchCatalog,
    fetchRouteStages,
    downloadStage,
    isDownloaded,
    isDownloading,
    isFetching,
  };
});
