import { watch, onUnmounted, shallowRef, type ShallowRef } from 'vue';
import type { GameMap, MercatorFromLngLat } from '@/game/map-adapter';
import { ThreeBallLayer } from '@/game/three-layer';

export function useThreeBall(
  map: ShallowRef<GameMap | null>,
  mapReady: { value: boolean },
  mercatorFromLngLat: () => MercatorFromLngLat | undefined,
) {
  const layer = shallowRef<ThreeBallLayer | null>(null);

  function addLayer() {
    const fn = mercatorFromLngLat();
    if (!map.value || layer.value || !fn) return;
    const l = new ThreeBallLayer(fn);
    map.value.addLayer(l);
    layer.value = l;
  }

  // Add layer once map is ready
  const stopWatch = watch(
    () => mapReady.value,
    (ready) => {
      if (ready) addLayer();
    },
    { immediate: true },
  );

  function updatePosition(lngLat: [number, number], altitude: number) {
    layer.value?.setBallPosition(lngLat, altitude);
  }

  function setDarkened(dark: boolean) {
    layer.value?.setDarkened(dark);
  }

  onUnmounted(() => {
    stopWatch();
  });

  return { layer, updatePosition, setDarkened };
}
