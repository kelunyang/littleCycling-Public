/**
 * Phaser 2D implementation of CoinLayerInterface.
 *
 * Spawns coins as gold circle sprites floating above the terrain,
 * with bobbing animation and spin effect via scale oscillation.
 * Uses an object pool to avoid GC pressure.
 */

import Phaser from 'phaser';
import type { CoinVisual, CoinLayerInterface } from '@/game/coin-interface';
import type { RoutePoint } from '@littlecycling/shared';
import { PX_PER_METER } from './phaser2d-scene';
import type { PhaserStyleStrategy } from './phaser-style-strategy';

const COIN_TEXTURE_KEY = '__phaser_coin__';
const COIN_HOVER_PX = 4; // just above terrain surface
const POOL_INITIAL = 30;

/** CoinVisual with Phaser sprite for the 2D renderer. */
interface PhaserCoinVisual extends CoinVisual {
  mesh: Phaser.GameObjects.Sprite;
}

/**
 * Create the coin texture programmatically — delegates to strategy.
 */
function ensureCoinTexture(scene: Phaser.Scene, strategy: PhaserStyleStrategy) {
  if (scene.textures.exists(COIN_TEXTURE_KEY)) return;

  const coinSize = strategy.getCoinSize();
  const canvas = document.createElement('canvas');
  canvas.width = coinSize * 2;
  canvas.height = coinSize * 2;
  const ctx = canvas.getContext('2d')!;

  strategy.drawCoinTexture(ctx, coinSize, coinSize, coinSize, 0);

  scene.textures.addCanvas(COIN_TEXTURE_KEY, canvas);
}

export class PhaserCoinLayer implements CoinLayerInterface {
  private scene: Phaser.Scene;
  private coins: PhaserCoinVisual[] = [];
  private pool: Phaser.GameObjects.Sprite[] = [];
  private routePoints: RoutePoint[];
  private cumulativeDists: number[];
  private getTerrainY: (distM: number) => number;
  private frameCount = 0;

  constructor(
    scene: Phaser.Scene,
    routePoints: RoutePoint[],
    cumulativeDists: number[],
    getTerrainY: (distM: number) => number,
    strategy: PhaserStyleStrategy,
  ) {
    this.scene = scene;
    this.routePoints = routePoints;
    this.cumulativeDists = cumulativeDists;
    this.getTerrainY = getTerrainY;

    ensureCoinTexture(scene, strategy);

    // Pre-populate pool
    for (let i = 0; i < POOL_INITIAL; i++) {
      const sprite = scene.add.sprite(0, 0, COIN_TEXTURE_KEY);
      sprite.setVisible(false);
      sprite.setActive(false);
      sprite.setDepth(400);
      this.pool.push(sprite);
    }
  }

  spawnCoin(lngLat: [number, number], altitude: number): CoinVisual {
    // Find route distance for this lngLat
    const distM = this.lngLatToRouteDist(lngLat);
    const worldX = distM * PX_PER_METER;
    const terrainY = this.getTerrainY(distM);

    const sprite = this.acquire();
    sprite.setPosition(worldX, terrainY - COIN_HOVER_PX);
    sprite.setVisible(true);
    sprite.setActive(true);

    const coin: PhaserCoinVisual = {
      mesh: sprite,
      lngLat,
      altitude,
    };
    this.coins.push(coin);
    return coin;
  }

  removeCoin(coin: CoinVisual): void {
    const idx = this.coins.indexOf(coin as PhaserCoinVisual);
    if (idx >= 0) {
      const pCoin = this.coins[idx];
      // Collection animation: scale up + fade out
      this.scene.tweens.add({
        targets: pCoin.mesh,
        scaleX: 2,
        scaleY: 2,
        alpha: 0,
        duration: 300,
        ease: 'Power2',
        onComplete: () => {
          this.release(pCoin.mesh);
        },
      });
      this.coins.splice(idx, 1);
    }
  }

  clearCoins(): void {
    for (const coin of this.coins) {
      this.release(coin.mesh);
    }
    this.coins.length = 0;
  }

  /** Update coin bobbing animation. Call each frame. */
  updateFrame() {
    this.frameCount++;
    for (const coin of this.coins) {
      const baseX = coin.mesh.x;
      const distM = baseX / PX_PER_METER;
      const terrainY = this.getTerrainY(distM);
      const bob = Math.sin(this.frameCount * 0.06 + baseX * 0.01) * 3;
      coin.mesh.setY(terrainY - COIN_HOVER_PX + bob);

      // Simulate spinning by oscillating X scale
      const spin = Math.cos(this.frameCount * 0.08 + baseX * 0.02);
      coin.mesh.setScale(Math.abs(spin) * 0.5 + 0.5, 1);
    }
  }

  /** Find nearest route distance for a [lon, lat] pair. */
  private lngLatToRouteDist(lngLat: [number, number]): number {
    const [lon, lat] = lngLat;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    let bestDist = Infinity;
    let bestRouteDist = 0;

    for (let i = 0; i < this.routePoints.length; i++) {
      const dx = (lon - this.routePoints[i].lon) * 111320 * cosLat;
      const dy = (lat - this.routePoints[i].lat) * 111320;
      const d = dx * dx + dy * dy; // squared distance is fine for comparison
      if (d < bestDist) {
        bestDist = d;
        bestRouteDist = this.cumulativeDists[i];
      }
    }

    return bestRouteDist;
  }

  private acquire(): Phaser.GameObjects.Sprite {
    const sprite = this.pool.pop();
    if (sprite) {
      sprite.setAlpha(1);
      sprite.setScale(1);
      return sprite;
    }
    // Pool exhausted — create new
    const newSprite = this.scene.add.sprite(0, 0, COIN_TEXTURE_KEY);
    newSprite.setDepth(400);
    return newSprite;
  }

  private release(sprite: Phaser.GameObjects.Sprite) {
    sprite.setVisible(false);
    sprite.setActive(false);
    sprite.setAlpha(1);
    sprite.setScale(1);
    this.pool.push(sprite);
  }

  dispose() {
    this.clearCoins();
    for (const s of this.pool) s.destroy();
    this.pool.length = 0;
  }
}
