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
import type { RoutePoint } from '@littlecycling/shared';
import { buildCumulativeDistances } from '@/game/route-geometry';
import type { CoinVisual } from '@/game/coin-interface';
import type { PhaserGameInstance } from '@/game/phaser/phaser-game';
import type { PhaserWeatherSystem, WeatherType } from '@/game/phaser/phaser-weather';
import type { TerrainChunkManager2D } from '@/game/phaser/terrain-builder';
import type { PhaserCoinLayer } from '@/game/phaser/phaser-coin-layer';
import type { PhaserStyleStrategy } from '@/game/phaser/phaser-style-strategy';
import type { CyclistSpriteUpdateFn } from '@/game/phaser/cyclist-sprite';
import { detectPhaserZone, type ZoneType as PhaserZoneType } from '@/game/phaser/phaser-zone-detector';
// Pure state + curve, no Three.js — shared with the 3D renderer so both modes
// lift the camera on the same cues (interval end, run-in to the finish).
import { CameraLift, type LiftKind } from '@/game/terrain/camera-lift';
import { INTRO_DURATION_S } from '@/game/phaser/phaser-style-strategy';
import { useSettingsStore } from '@/stores/settingsStore';

/** Matches PX_PER_METER in phaser2d-scene.ts — inlined to avoid pulling in the full scene module. */
const PX_PER_METER = 3;

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

  // Re-evaluate environment zone every N meters to drive glasses ambient effects.
  const ZONE_CHECK_INTERVAL_M = 25;
  let lastZoneDistM = -Infinity;
  let lastZone: PhaserZoneType = 'open';

  // Cinematic camera lift (peek at interval end / finale near the finish) —
  // rendered as a zoom pull-back in 2D.
  const cameraLift = new CameraLift();
  let lastCamDistM = 0;

  // Window-resize handling (mirrors useTerrainRenderer's ResizeObserver).
  let resizeObserver: ResizeObserver | null = null;
  let resizeSettleTimer: ReturnType<typeof setTimeout> | null = null;

  async function init(opts: PhaserRendererInitOptions): Promise<void> {
    routePoints = opts.points;
    cumulativeDists = buildCumulativeDistances(routePoints);

    // Create style strategy based on user setting
    const settingsStore = useSettingsStore();
    const worldStyle = settingsStore.config.map.worldStyle ?? 'plastic';
    const { createStyleStrategy } = await import('@/game/phaser/phaser-style-strategy');
    styleStrategy = await createStyleStrategy(worldStyle);

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

    // Bind route origin so weather can compute sun/moon position from real
    // time + lat/lon (matches useTerrainRenderer.ts behavior).
    if (routePoints.length > 0) {
      weatherSystem.setLocation(routePoints[0].lat, routePoints[0].lon);
    }

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

    // Keep the framebuffer matched to the CSS size, or a window resize leaves
    // the boot-time buffer stretched across the new size (pixelArt sampling
    // turns that into mush). The buffer resize is cheap and runs on every
    // observation so the image stays sharp WHILE dragging; the heavy part —
    // scene/weather onResize regenerate full-screen textures (film grain,
    // iris, sky) — waits until the size has settled.
    const canvasEl = opts.canvas;
    resizeObserver = new ResizeObserver(() => {
      if (!gameInstance) return;
      const w = canvasEl.clientWidth;
      const h = canvasEl.clientHeight;
      if (w <= 0 || h <= 0) return;
      gameInstance.game.scale.resize(w, h);
      if (resizeSettleTimer) clearTimeout(resizeSettleTimer);
      // Full relayout (textures, markers, chunk scenery) once the size settles.
      resizeSettleTimer = setTimeout(() => resize(w, h), 150);
    });
    resizeObserver.observe(canvasEl);

    // MVT features stream in via Web Worker (non-blocking); loading status is
    // surfaced by the progress bar in LoadingIntroOverlay, not a toast.
    fetchAndProjectFeatures(routePoints, cumulativeDists).then((features) => {
      chunkManager = new ChunkMgr(scene, elevationProfile, features, styleStrategy!);
      // Load initial chunks around start
      chunkManager.update(0);
    }).catch((err) => {
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

    // Lap wrap / seek: a large backwards jump would make the smoothed vertical
    // follow slide between the two elevations — snap instead.
    if (distanceM < lastCamDistM - 500) gameInstance.scene.snapCamera();
    lastCamDistM = distanceM;

    // Update terrain chunks
    chunkManager?.update(distanceM);

    // Pass water feature positions to scene for shimmer animation
    if (chunkManager) {
      gameInstance.scene.setWaterFeatures(chunkManager.getWaterFeatures());

      // Zone detection — re-classify periodically to feed the glasses pipeline.
      if (Math.abs(distanceM - lastZoneDistM) >= ZONE_CHECK_INTERVAL_M || lastZoneDistM < 0) {
        lastZoneDistM = distanceM;
        const nearby = chunkManager.getNearbyFeatures(distanceM);
        if (nearby.length > 0) {
          const zone = detectPhaserZone(distanceM, nearby);
          if (zone !== lastZone) {
            lastZone = zone;
            gameInstance.scene.setEnvironmentZone(zone);
          }
        }
      }
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

    // Cinematic lift → camera zoom weight (0 when idle)
    scene.setCameraLift(cameraLift.update(dt));

    // Update weather visuals
    weatherSystem?.update();

    // Entrance animation: the terrain draws/drops itself in (handled inside the
    // scene), while the backdrop and the rider fade in around it. Must run
    // AFTER weatherSystem.update(), which owns those layers' alpha otherwise.
    const introT = scene.getIntroT();
    if (introT < INTRO_DURATION_S) {
      weatherSystem?.setIntroT(introT);
      // The rider fades in immediately, unlike the demo's "cyclist arrives
      // last" beat — the intro now fires as they start pedalling, and a rider
      // who is invisible while already riding just reads as broken.
      cyclistSprite?.setAlpha(Math.min(1, introT / 0.4));
    }

    // Building night lights (F2) — fade with the day/night cycle.
    if (weatherSystem && chunkManager) {
      chunkManager.setNightFactor(1 - weatherSystem.getDayFactor());
    }

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
      // Drive lens-mark weather and auto-lens via the scene.
      gameInstance.scene.setMarksWeather(opts.type as 'sunny' | 'cloudy' | 'rainy' | 'snowy');
    }
    // sunElevation/sunAzimuth here act as fallbacks; once setLocation has
    // been called the weather system overrides them per-frame from real time.
    weatherSystem?.setState({
      type: opts.type,
      sunElevation: opts.sunElevation,
      ...(opts.sunAzimuth !== undefined ? { sunAzimuth: opts.sunAzimuth } : {}),
    });
  }

  function setWind(speedKmh: number, directionDeg: number, gust = 1): void {
    weatherSystem?.setWind({ speedKmh, directionDeg, gust });
    if (gameInstance) {
      gameInstance.scene.setWindMagnitude(Math.min(2, speedKmh / 30) * gust);
    }
  }

  function triggerLightning(intensityMul = 1): void {
    weatherSystem?.triggerLightning(intensityMul);
    gameInstance?.scene.triggerLightningFlash();
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
   * Handle resize — notify Phaser and weather/scene subsystems, and rebuild
   * the loaded chunks: their scenery bakes ground Y at load time, and the
   * ground line is a fraction of the canvas height, so a resize strands
   * trees/buildings above (or below) the freshly-laid terrain.
   */
  function resize(w: number, h: number): void {
    if (!gameInstance) return;
    gameInstance.game.scale.resize(w, h);
    gameInstance.scene.onResize(w, h);
    weatherSystem?.onResize(w, h);
    if (chunkManager) {
      chunkManager.reload();
      chunkManager.update(gameInstance.bridge.distanceM);
      gameInstance.scene.setWaterFeatures(chunkManager.getWaterFeatures());
    }
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

  // ── Cycling-glasses bridge (Phaser PostFX pipeline + lens-marks) ──

  function triggerCoinGlow(): void {
    gameInstance?.scene.triggerCoinGlow();
  }

  function setGlassesLens(lens: string): void {
    // gameStore.GlassesLens narrows to clear|dark|red|yellow|auto — pass through.
    gameInstance?.scene.setLens(lens as 'clear' | 'dark' | 'red' | 'yellow' | 'auto');
  }

  function updatePhysiology(zone: number | null, speed: number): void {
    gameInstance?.scene.updatePhysiology(zone, speed);
  }

  function addLensMark(_pos: { x: number; y: number }): void {
    // Position is screen-space in the Three.js path; here we pick a random
    // spot via the marks manager. Default to a generic dust mark.
    gameInstance?.scene.addLensMark('dust');
  }

  /** 2D camera control surface, mirroring the 3D renderer's. `mode` switches
   *  跟車 / 自由 (follow / detached pan+zoom); `zoom` sets the wheel zoom. The
   *  3D-only options (pitch, height) have no 2D meaning and are ignored. */
  function setCameraOptions(opts: Record<string, any>): void {
    if (!gameInstance) return;
    if (opts.mode === 'third' || opts.mode === 'orbit') {
      gameInstance.scene.setCameraMode(opts.mode);
    }
    if (typeof opts.zoom === 'number') {
      gameInstance.scene.setUserZoom(opts.zoom);
    }
  }

  /** Pull the camera back: 'peek' (rise-hold-settle) or 'finale' (rise & stay). */
  function triggerCameraLift(kind: LiftKind): void {
    cameraLift.trigger(kind);
  }

  /** Build the world in around the rider — Tetris blocks drop into place
   *  (plastic) or an ink pen draws and paints it (cuphead). Call this when the
   *  ride actually starts, not at load time: the loading overlay covers the
   *  canvas until then and the animation would be wasted behind it. */
  function playIntro(): void {
    gameInstance?.scene.replayIntro();
  }

  /** 2D checkpoint flags are placed by drawWorkoutSegmentFlags (GameView calls
   *  it with the segment distances it already computes), so there is nothing to
   *  spawn here — the 3D renderer's signature is kept for API parity. */
  function spawnCheckpointFlags(): void {
    // Intentionally empty — see drawWorkoutSegmentFlags.
  }

  /** Fade the flags the rider has ridden past. */
  function updateCheckpointFlags(distM: number): void {
    gameInstance?.scene.updateWorkoutFlags(distM);
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
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (resizeSettleTimer) {
      clearTimeout(resizeSettleTimer);
      resizeSettleTimer = null;
    }
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
    setWind,
    triggerLightning,
    setCloudsEnabled,
    triggerCoinGlow,
    setGlassesLens,
    updatePhysiology,
    addLensMark,
    setCameraOptions,
    triggerCameraLift,
    playIntro,
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
