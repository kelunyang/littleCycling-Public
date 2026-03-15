import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { SavedRoute } from '@littlecycling/shared';
import { notifyError } from '@/utils/notify';

export const useRouteStore = defineStore('route', () => {
  /** All saved routes (summaries from server, without points) */
  const savedRoutes = ref<SavedRoute[]>([]);

  /** Currently selected route (with full points, fetched on select) */
  const activeRoute = ref<SavedRoute | null>(null);

  const hasRoute = computed(() => activeRoute.value !== null);

  /** Fetch all saved routes from server. */
  async function fetchRoutes() {
    try {
      const res = await fetch('/api/routes');
      if (!res.ok) return;
      const data = await res.json();
      savedRoutes.value = data.routes;
    } catch {
      notifyError('Failed to load routes');
    }
  }

  /** Upload a GPX/TCX/FIT file to the server, then refresh list. */
  async function importRoute(fileName: string, content: string | ArrayBuffer): Promise<SavedRoute> {
    try {
      const isFit = fileName.toLowerCase().endsWith('.fit');
      const blob = isFit
        ? new Blob([content], { type: 'application/octet-stream' })
        : new Blob([content], { type: 'application/xml' });
      const formData = new FormData();
      formData.append('file', blob, fileName);
      const res = await fetch('/api/routes', { method: 'POST', body: formData });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to import route');
      }
      const route = await res.json() as SavedRoute;
      await fetchRoutes();
      return route;
    } catch (err: any) {
      notifyError(err.message || 'Failed to import route');
      throw err;
    }
  }

  /** Select a route — fetches full points from server. */
  async function selectRoute(id: string) {
    try {
      const res = await fetch(`/api/routes/${id}`);
      if (res.ok) {
        activeRoute.value = await res.json() as SavedRoute;
      }
    } catch {
      notifyError('Failed to load route details');
    }
  }

  /** Delete a route via server API. */
  async function removeRoute(id: string) {
    try {
      const res = await fetch(`/api/routes/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Server error');
      savedRoutes.value = savedRoutes.value.filter((r) => r.id !== id);
      if (activeRoute.value?.id === id) {
        activeRoute.value = null;
      }
    } catch {
      notifyError('Failed to delete route');
    }
  }

  function setSavedRoutes(routes: SavedRoute[]) {
    savedRoutes.value = routes;
  }

  function reset() {
    activeRoute.value = null;
  }

  return {
    savedRoutes, activeRoute, hasRoute,
    fetchRoutes, importRoute, selectRoute, removeRoute, setSavedRoutes, reset,
  };
});
