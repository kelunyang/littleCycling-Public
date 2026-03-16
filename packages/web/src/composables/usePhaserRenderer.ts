/**
 * Vue composable bridging the Phaser 2D renderer.
 *
 * Mirrors the API surface of useTerrainRenderer so GameView.vue
 * can swap renderers with minimal branching.
 *
 * Lifecycle:
 * 1. init() → dynamic import Phaser → create game + scene
 * 2. init() → build elevation profile + fetch MVT features (in Worker)
 * 3. Each frame → write bridge → Phaser scene.update() reads it
 * 4. dispose() → destroy Phaser game
 */

import { ref, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import type { RoutePoint } from '@littlecycling/shared';
import { buildCumulativeDistances } from '@/game/route-geometry';
import type { CoinVisual } from '@/game/coin-interface';
import type { PhaserGameInstance } from '@/game/phaser/phaser-game';
import type { PhaserWeatherSystem, WeatherType } from '@/game/phaser/phaser-weather';
import type { TerrainChunkManager2D } from '@/game/phaser/terrain-builder';
import type { PhaserCoinLayer } from '@/game/phaser/phaser-coin-layer';
import type { PhaserStyleStrategy } from '@/game/phaser/phaser-style-strategy';
import type { CyclistSpriteUpdateFn } from '@/game/phaser/cyclist-sprite';
import { useSettingsStore } from '@/stores/settingsStore';

/** Matches PX_PER_METER in phaser2d-scene.ts — inlined to avoid pulling in the full scene module. */
const PX_PER_METER = 3;
import { notifySuccess } from '@/utils/notify';

export interface PhaserRendererInitOptions {
  canvas: HTMLCanvasElement;
  points: RoutePoint[];
}

export function usePhaserRenderer() {
  const isReady = ref(false);
  const mvtFailed = ref(false);

  let gameInstance: PhaserGameInstance | null = null;
  let weatherSystem: PhaserWeatherSystem | null = null;
  let chunkManager: TerrainChunkManager2D | null = null;
  let coinLayer: PhaserCoinLayer | null = null;
  let cyclistSprite: Phaser.GameObjects.Sprite | null = null;
  let styleStrategy: PhaserStyleStrategy | null = null;
  let updateCyclistSpriteFn: CyclistSpriteUpdateFn | null = null;

  let routePoints: RoutePoint[] = [];
  let cumulativeDists: number[] = [];

  async function init(opts: PhaserRendererInitOptions): Promise<void> {
    routePoints = opts.points;
    cumulativeDists = buildCumulativeDistances(routePoints);

    // Create style strategy based on user setting
    const settingsStore = useSettingsStore();
    const phaserStyle = settingsStore.config.map.phaserStyle ?? 'plastic';
    const { createStyleStrategy } = await import('@/game/phaser/phaser-style-strategy');
    styleStrategy = await createStyleStrategy(phaserStyle);

    // Dynamic imports for code splitting
    const [
      { createPhaserGame },
      { buildElevationProfile, fetchAndProjectFeatures, TerrainChunkManager2D: ChunkMgr },
      { PhaserWeatherSystem: WeatherSys },
      { createCyclistSprite, updateCyclistSprite },
      { PhaserCoinLayer: CoinLayerClass },
    ] = await Promise.all([
      import('@/game/phaser/phaser-game'),
      import('@/game/phaser/terrain-builder'),
      import('@/game/phaser/phaser-weather'),
      import('@/game/phaser/cyclist-sprite'),
      import('@/game/phaser/phaser-coin-layer'),
    ]);

    updateCyclistSpriteFn = updateCyclistSprite;

    // Create Phaser game and wait for scene.create() to finish
    gameInstance = await createPhaserGame(opts.canvas, styleStrategy);
    const scene = gameInstance.scene;
    await scene.ready;

    // Build elevation profile
    const elevationProfile = buildElevationProfile(routePoints, cumulativeDists);
    scene.setElevationProfile(elevationProfile);

    // Weather system
    weatherSystem = new WeatherSys(scene, styleStrategy);

    // Cyclist sprite
    cyclistSprite = createCyclistSprite(scene, styleStrategy);

    // Coin layer
    coinLayer = new CoinLayerClass(
      scene,
      routePoints,
      cumulativeDists,
      (distM: number) => scene.getTerrainY(distM),
      styleStrategy,
    );

    // Fetch MVT features in Web Worker (non-blocking)
    const loadingMsg = ElMessage({
      type: 'info',
      message: '正在載入地形特徵...',
      duration: 0,
      grouping: true,
    });

    fetchAndProjectFeatures(routePoints, cumulativeDists).then((features) => {
      loadingMsg.close();
      chunkManager = new ChunkMgr(scene, elevationProfile, features, styleStrategy!);
      // Load initial chunks around start
      chunkManager.update(0);
      notifySuccess('地形特徵載入完成');
    }).catch((err) => {
      loadingMsg.close();
      console.warn('[Phaser] MVT feature fetch failed, terrain will render without features:', err);
      mvtFailed.value = true;
    });

    isReady.value = true;
  }

  /**
   * Update cyclist position. Called from updateBallVisual in game loop.
   */
  function updatePosition(lngLat: [number, number], elevation: number): void {
    if (!gameInstance) return;
    const bridge = gameInstance.bridge;
    bridge.elevationM = elevation;
    // Distance is updated separately via updateDistance
  }

  /**
   * Update distance traveled (drives camera scrolling + terrain chunks).
   */
  function updateDistance(distanceM: number): void {
    if (!gameInstance) return;
    gameInstance.bridge.distanceM = distanceM;

    // Update terrain chunks
    chunkManager?.update(distanceM);

    // Pass water feature positions to scene for shimmer animation
    if (chunkManager) {
      gameInstance.scene.setWaterFeatures(chunkManager.getWaterFeatures());
    }
  }

  /**
   * Update camera. Called from updateCamera in game loop.
   */
  function updateCamera(bearing: number, dt: number): void {
    if (!gameInstance) return;
    gameInstance.bridge.bearing = bearing;
  }

  /**
   * Render one frame. Called from game loop after updateCamera.
   */
  function render(dt: number): void {
    if (!gameInstance) return;

    const bridge = gameInstance.bridge;
    const scene = gameInstance.scene;

    // Update weather visuals
    weatherSystem?.update();

    // Update cyclist sprite
    if (cyclistSprite) {
      const distM = bridge.distanceM;
      const worldX = distM * PX_PER_METER;
      const worldY = scene.getTerrainY(distM);
      const slopeDeg = scene.getTerrainSlope(distM);

      // Convert slope degrees to percent for pose selection
      const slopePercent = Math.tan(slopeDeg * Math.PI / 180) * 100;

      updateCyclistSpriteFn!(cyclistSprite, {
        worldX,
        worldY,
        slopeDeg,
        cadenceRpm: bridge.cadenceRpm,
        isDarkened: bridge.isDarkened,
        slopePercent,
        speedKmh: bridge.speedKmh,
      }, styleStrategy ?? undefined);
    }

    // Update coin animations
    coinLayer?.updateFrame();

    // Tick Phaser (scene.update + render)
    gameInstance.tick(dt * 1000);
  }

  function setDarkened(dark: boolean): void {
    if (gameInstance) {
      gameInstance.bridge.isDarkened = dark;
    }
  }

  function setWeather(opts: { type: WeatherType; sunElevation: number; sunAzimuth?: number }): void {
    if (gameInstance) {
      gameInstance.bridge.weather = opts.type;
      gameInstance.bridge.sunElevation = opts.sunElevation;
    }
    weatherSystem?.setState({
      type: opts.type,
      sunElevation: opts.sunElevation,
    });
  }

  function setCloudsEnabled(enabled: boolean): void {
    weatherSystem?.setCloudsEnabled(enabled);
  }

  /**
   * Update sensor data on the bridge (speed, cadence).
   */
  function updateSensorData(speedKmh: number, cadenceRpm: number): void {
    if (!gameInstance) return;
    gameInstance.bridge.speedKmh = speedKmh;
    gameInstance.bridge.cadenceRpm = cadenceRpm;
  }

  /**
   * Handle resize — notify Phaser and weather/scene subsystems.
   */
  function resize(w: number, h: number): void {
    if (!gameInstance) return;
    gameInstance.game.scale.resize(w, h);
    gameInstance.scene.onResize(w, h);
    weatherSystem?.onResize(w, h);
  }

  // ── Coin management (delegated to PhaserCoinLayer) ──

  function spawnCoin(lngLat: [number, number], altitude: number): CoinVisual {
    if (!coinLayer) {
      // Return dummy if not ready
      return { mesh: null, lngLat, altitude };
    }
    return coinLayer.spawnCoin(lngLat, altitude);
  }

  function removeCoin(coin: CoinVisual): void {
    coinLayer?.removeCoin(coin);
  }

  function clearCoins(): void {
    coinLayer?.clearCoins();
  }

  // ── No-ops for Three.js-specific features ──

  function triggerCoinGlow(): void {
    // No glasses effect in 2D mode
  }

  function setGlassesLens(_lens: string): void {
    // No glasses in 2D mode
  }

  function updatePhysiology(_zone: number | null, _speed: number): void {
    // No glasses physiology in 2D mode
  }

  function addLensMark(_pos: { x: number; y: number }): void {
    // No glasses in 2D mode
  }

  function setCameraOptions(_opts: Record<string, any>): void {
    // 2D mode uses fixed camera tracking
  }

  function spawnCheckpointFlags(): void {
    // TODO: could add 2D flags in future
  }

  function updateCheckpointFlags(_dist: number): void {
    // No-op for now
  }

  /**
   * Set workout zone color filter overlay.
   * Pass hex color string (e.g. "#ff6d00") or null to clear.
   */
  function setWorkoutZoneColor(hexColor: string | null): void {
    if (!gameInstance) return;
    if (hexColor === null) {
      gameInstance.scene.setZoneColor(null);
    } else {
      const color = parseInt(hexColor.replace('#', ''), 16);
      gameInstance.scene.setZoneColor(color, 0.10);
    }
  }

  /**
   * Draw workout segment flags on the terrain.
   */
  function drawWorkoutSegmentFlags(
    segments: { name: string; color: string; cumulativeDistM: number }[],
  ): void {
    if (!gameInstance) return;
    const flags = segments.map((s) => ({
      distM: s.cumulativeDistM,
      color: parseInt(s.color.replace('#', ''), 16),
      label: s.name.slice(0, 8),
    }));
    gameInstance.scene.drawWorkoutFlags(flags);
  }

  function dispose(): void {
    coinLayer?.dispose();
    weatherSystem?.dispose();
    chunkManager?.dispose();
    cyclistSprite?.destroy();
    gameInstance?.destroy();

    coinLayer = null;
    weatherSystem = null;
    chunkManager = null;
    cyclistSprite = null;
    styleStrategy = null;
    gameInstance = null;
    isReady.value = false;
  }

  onUnmounted(dispose);

  return {
    isReady,
    init,
    updatePosition,
    updateDistance,
    updateCamera,
    render,
    resize,
    setDarkened,
    setWeather,
    setCloudsEnabled,
    triggerCoinGlow,
    setGlassesLens,
    updatePhysiology,
    addLensMark,
    setCameraOptions,
    updateSensorData,
    spawnCoin,
    removeCoin,
    clearCoins,
    spawnCheckpointFlags,
    updateCheckpointFlags,
    setWorkoutZoneColor,
    drawWorkoutSegmentFlags,
    mvtFailed,
    dispose,
  };
}
