/**
 * useServerCoinAdapter — thin visual layer for server-authoritative coins.
 *
 * Applies `game_state.coins` deltas to the active CoinLayerInterface, keyed
 * by the server's stable coin ids. All game logic (spawning, collision,
 * combo award) lives in the server simulation; this only manages visuals
 * and collection feedback (glow/audio via onCollected).
 *
 * Idempotency contract (risk #2 in plan/2026-summer.md):
 * - `spawned` for an id we already show → ignored.
 * - `collected`/`removed` for an id we don't have → ignored.
 * - `reconcile` is the full authoritative set: prune ids the server no
 *   longer has, spawn ids we're missing. Any drift from lost packets or a
 *   not-yet-mounted layer converges within one reconcile (~2s, immediate on
 *   reconnect).
 */

import type { ShallowRef } from 'vue';
import type { CoinDto, WsGameStateMessage } from '@littlecycling/shared';
import type { CoinLayerInterface, CoinVisual } from '@/game/coin-interface';

type CoinOps = NonNullable<WsGameStateMessage['coins']>;

interface ServerCoinAdapterDeps {
  layer: ShallowRef<CoinLayerInterface | null>;
  /** Collection feedback: coin glow + audio. */
  onCollected?: () => void;
}

export function useServerCoinAdapter(deps: ServerCoinAdapterDeps) {
  const visuals = new Map<number, CoinVisual>();

  function spawn(dto: CoinDto): void {
    const layer = deps.layer.value;
    if (!layer || visuals.has(dto.id)) return;
    visuals.set(dto.id, layer.spawnCoin([dto.lon, dto.lat], dto.ele));
  }

  function remove(id: number): void {
    const visual = visuals.get(id);
    if (!visual) return;
    visuals.delete(id);
    deps.layer.value?.removeCoin(visual);
  }

  /** Apply one message's coin ops. Order: collected (feedback) → removed → spawned → reconcile. */
  function apply(ops: CoinOps): void {
    for (const c of ops.collected) {
      if (visuals.has(c.id)) {
        remove(c.id);
        deps.onCollected?.();
      }
    }
    for (const id of ops.removed) {
      remove(id);
    }
    for (const dto of ops.spawned) {
      spawn(dto);
    }

    if (ops.reconcile) {
      const serverIds = new Set(ops.reconcile.map((c) => c.id));
      for (const id of [...visuals.keys()]) {
        if (!serverIds.has(id)) remove(id);
      }
      for (const dto of ops.reconcile) {
        spawn(dto);
      }
    }
  }

  /** Remove all adapter-owned visuals (unmount / mode switch). */
  function clear(): void {
    for (const id of [...visuals.keys()]) {
      remove(id);
    }
  }

  return { apply, clear };
}
