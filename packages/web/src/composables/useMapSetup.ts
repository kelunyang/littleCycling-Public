import { shallowRef, ref, onUnmounted, type Ref } from 'vue';
import type { RoutePoint } from '@littlecycling/shared';
import { routeToGeoJSON, routeBounds } from '@/game/route-geometry';
import {
  createMapAdapter,
  type GameMap,
  type MapAdapter,
} from '@/game/map-adapter';
import { resolveStyleUrl } from '@/game/map-styles';

const TERRAIN_URL_TERRARIUM =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const TERRAIN_EXAGGERATION = 1.5;

export type RenderMode = 'maplibre' | 'threejs';

export interface MapInitOptions {
  center?: [number, number];
  style?: string;
  /** Render mode: 'maplibre' (default, legacy) or 'threejs' (standalone renderer). */
  renderMode?: RenderMode;
}

export function useMapSetup(containerRef: Ref<HTMLElement | null>) {
  const map = shallowRef<GameMap | null>(null);
  const adapter = shallowRef<MapAdapter | null>(null);
  const mapReady = ref(false);
  const renderMode = ref<RenderMode>('maplibre');

  async function init(options?: MapInitOptions) {
    if (!containerRef.value || map.value) return;

    renderMode.value = options?.renderMode ?? 'maplibre';

    // In threejs mode, MapLibre is optional (background data source only).
    // Skip full map initialization — the standalone renderer handles display.
    if (renderMode.value === 'threejs') {
      mapReady.value = true;
      return;
    }

    const styleName = options?.style ?? 'liberty';
    const styleUrl = resolveStyleUrl(styleName);

    const result = await createMapAdapter({
      container: containerRef.value,
      style: styleUrl,
      center: options?.center ?? [0, 0],
      zoom: 18.5,
      pitch: 78,
      bearing: 0,
      antialias: true,
      terrainExaggeration: TERRAIN_EXAGGERATION,
    });

    const m = result.map;

    m.on('load', () => {
      // 3D terrain — Terrarium DEM tiles
      m.addSource('terrain-source', {
        type: 'raster-dem',
        tiles: [TERRAIN_URL_TERRARIUM],
        tileSize: 256,
        encoding: 'terrarium',
      });
      m.setTerrain({ source: 'terrain-source', exaggeration: TERRAIN_EXAGGERATION });

      // Sky + fog for immersion
      m.setSky?.({
        'sky-color': '#87CEEB',
        'sky-horizon-blend': 0.3,
        'horizon-color': '#ffffff',
        'horizon-fog-blend': 0.5,
        'fog-color': '#dce6f0',
        'fog-ground-blend': 0.1,
        'atmosphere-blend': 0.5,
      });

      mapReady.value = true;
    });

    map.value = m;
    adapter.value = result;
  }

  function addRouteLayer(points: RoutePoint[]) {
    const m = map.value;
    if (!m || points.length === 0) return;

    if (m.getSource('route-source')) {
      const src = m.getSource('route-source') as any;
      src.setData(routeToGeoJSON(points) as any);
      return;
    }

    m.addSource('route-source', {
      type: 'geojson',
      data: routeToGeoJSON(points) as any,
    });

    m.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route-source',
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
      },
      paint: {
        'line-color': '#ffd700',
        'line-width': 32,
        'line-opacity': 0.85,
      },
    });
  }

  function fitToRoute(points: RoutePoint[]) {
    const m = map.value;
    if (!m || points.length === 0) return;

    const bounds = routeBounds(points);
    m.fitBounds(bounds, {
      padding: 60,
      pitch: 60,
      duration: 1000,
    });
  }

  function dispose() {
    if (map.value) {
      map.value.remove();
      map.value = null;
      adapter.value = null;
      mapReady.value = false;
    }
  }

  onUnmounted(dispose);

  return { map, adapter, mapReady, renderMode, init, addRouteLayer, fitToRoute, dispose };
}

export type MapSetupAPI = ReturnType<typeof useMapSetup>;

/**
 * Standalone check: can we reach the map tile servers?
 */
export async function checkMapTilesReachable(): Promise<boolean> {
  try {
    await fetch('https://tiles.openfreemap.org/styles/liberty', { method: 'HEAD', mode: 'no-cors' });
    return true;
  } catch {
    return false;
  }
}
