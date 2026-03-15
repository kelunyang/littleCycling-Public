import { type Ref, type ShallowRef } from 'vue';
import type { RoutePoint, HrZone } from '@littlecycling/shared';
import {
  COIN_SPAWN_AHEAD_MIN,
  COIN_SPAWN_AHEAD_MAX,
  COIN_COLLECT_THRESHOLD,
  COIN_CLEANUP_BEHIND,
  COIN_SPACING,
} from '@littlecycling/shared';
import { interpolateAlongRoute } from '@/game/route-geometry';
import type { CoinLayerInterface, CoinVisual } from '@/game/coin-interface';
import { useGameStore } from '@/stores/gameStore';

interface ActiveCoin {
  routeDistanceM: number;
  visual: CoinVisual;
}

interface CoinSpawnerDeps {
  routePoints: Ref<RoutePoint[]>;
  cumulativeDistsRef: ShallowRef<number[]>;
  distanceTraveled: Ref<number>;
  currentZone: Ref<HrZone | null>;
  comboMultiplier: Ref<number>;
  layer: ShallowRef<CoinLayerInterface | null>;
  /** Called when a coin is collected (for visual effects). */
  onCoinCollected?: () => void;
}

export function useCoinSpawner(deps: CoinSpawnerDeps) {
  const gameStore = useGameStore();

  const activeCoins: ActiveCoin[] = [];
  const occupiedSlots = new Set<string>();
  let lastLapDistance = 0;

  /**
   * Spawn a batch of coins ahead of the ball based on current HR zone.
   * Called every coinTick interval (5s).
   */
  function spawnBatch() {
    const layer = deps.layer.value;
    const pts = deps.routePoints.value;
    const cumDist = deps.cumulativeDistsRef.value;
    if (!layer || pts.length === 0 || cumDist.length === 0) return;

    const zone = deps.currentZone.value;
    if (!zone) return;

    const spacing = COIN_SPACING[zone.zone];
    if (!spacing) return; // Z1 and Z5 don't spawn

    const ballDist = deps.distanceTraveled.value;
    const totalDist = cumDist[cumDist.length - 1];
    const windowMin = ballDist + COIN_SPAWN_AHEAD_MIN;
    const windowMax = ballDist + COIN_SPAWN_AHEAD_MAX;

    // Generate coins in the spawn window
    const startSlot = Math.ceil(windowMin / spacing);
    const endSlot = Math.floor(windowMax / spacing);

    for (let slot = startSlot; slot <= endSlot; slot++) {
      const dist = slot * spacing;
      // Wrap around for lap support
      const effectiveDist = dist % totalDist;
      const slotKey = `${spacing}:${slot % Math.ceil(totalDist / spacing)}`;

      if (occupiedSlots.has(slotKey)) continue;
      occupiedSlots.add(slotKey);

      // Interpolate position on route
      const pos = interpolateAlongRoute(pts, cumDist, effectiveDist);

      const visual = layer.spawnCoin([pos.lon, pos.lat], pos.ele);
      activeCoins.push({ routeDistanceM: dist, visual });
    }
  }

  /**
   * Per-frame update: collision detection + cleanup.
   */
  function updateFrame() {
    const layer = deps.layer.value;
    if (!layer) return;

    const ballDist = deps.distanceTraveled.value;

    // Detect lap reset
    if (ballDist < lastLapDistance - 100) {
      // Ball wrapped around — clear everything
      clearAll();
    }
    lastLapDistance = ballDist;

    // Check collisions and cleanup (iterate backwards for safe removal)
    for (let i = activeCoins.length - 1; i >= 0; i--) {
      const coin = activeCoins[i];
      const diff = coin.routeDistanceM - ballDist;

      if (Math.abs(diff) < COIN_COLLECT_THRESHOLD) {
        // Collected!
        const combo = deps.comboMultiplier.value;
        gameStore.addCoins(combo);
        deps.onCoinCollected?.();
        layer.removeCoin(coin.visual);
        activeCoins.splice(i, 1);
      } else if (diff < -COIN_CLEANUP_BEHIND) {
        // Passed and missed — remove
        layer.removeCoin(coin.visual);
        activeCoins.splice(i, 1);
      }
    }
  }

  function clearAll() {
    const layer = deps.layer.value;
    if (layer) {
      layer.clearCoins();
    }
    activeCoins.length = 0;
    occupiedSlots.clear();
  }

  function dispose() {
    clearAll();
  }

  return { spawnBatch, updateFrame, clearAll, dispose };
}
