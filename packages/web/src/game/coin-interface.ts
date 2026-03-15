/**
 * Renderer-agnostic coin interfaces.
 * Extracted from three-layer.ts so that any renderer (MapLibre, Three.js, Phaser)
 * can implement coin spawning without depending on Three.js types.
 */

export interface CoinVisual {
  mesh: unknown;
  lngLat: [number, number];
  altitude: number;
}

/** Shared interface for any layer that can manage coins. */
export interface CoinLayerInterface {
  spawnCoin(lngLat: [number, number], altitude: number): CoinVisual;
  removeCoin(coin: CoinVisual): void;
  clearCoins(): void;
}
