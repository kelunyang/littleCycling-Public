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
import { resolveWorldOptions, type RoutePoint } from '@littlecycling/shared';
import { buildCumulativeDistances } from '@/game/route-geometry';
import type { CoinVisual } from '@/game/coin-interface';
import type { PhaserGameInstance } from '@/game/phaser/phaser-game';
import type { PhaserWeatherSystem, WeatherType } from '@/game/phaser/phaser-weather';
import type { TerrainChunkManager2D } from '@/game/phaser/terrain-builder';
import type { PhaserCoinLayer } from '@/game/phaser/phaser-coin-layer';
import type { PhaserStyleStrategy } from '@/game/phaser/phaser-style-strategy';
import type { SignVocabulary } from '@/game/terrain/sign-spec';
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
  /** Shop shelf or training shelf for this ride's shop signs — the 2D twin of
   *  `TerrainRendererInitOptions.signVocabulary`. Fixed for the ride, so it is
   *  an init option with no setter (see `SignVocabulary`); absent = 'shop'. */
  signVocabulary?: SignVocabulary;
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
  let createCyclistSpriteFn: typeof import('@/game/phaser/cyclist-sprite')['createCyclistSprite'] | null = null;

  // ── Ghost rider (P8 幽靈車) — 半透明的第二個 cyclist sprite + 兩張名牌 ──
  let ghostSprite: Phaser.GameObjects.Sprite | null = null;
  let ghostLabel: Phaser.GameObjects.Text | null = null;
  let playerLabel: Phaser.GameObjects.Text | null = null;
  /** 幽靈本圈 wrapped 距離(m);null = 本幀無資料(隱藏不銷毀)。 */
  let ghostDistM: number | null = null;
  /** 輪動畫用速度 — 由距離差分推導,罰站時腿自然停。 */
  let ghostPrevDistM: number | null = null;
  let ghostSpeedKmh = 0;
  const GHOST_ALPHA = 0.45;
  const LABEL_OFFSET_PX = 74;

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
    // The rider-facing world options reach the 2D strategy here, so a
    // `modes: ['phaser']` switch (cuphead 上色) is applied before the factory
    // runs — the style never has to know a toggle exists.
    styleStrategy = await createStyleStrategy(
      worldStyle,
      resolveWorldOptions(worldStyle, settingsStore.config.map.worldOptions),
    );

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
    createCyclistSpriteFn = createCyclistSprite;

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
      // The ride's sign vocabulary lands on the CHUNK MANAGER, not on the
      // strategy: the strategy is rebuilt from scratch whenever the world is
      // swapped, the manager is not (see `renderBuilding`'s `vocabulary`).
      chunkManager = new ChunkMgr(
        scene, elevationProfile, features, styleStrategy!, opts.signVocabulary ?? 'shop');
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

    // Nightfall, from one source to both halves of it: the additive lights
    // layer fades IN (chunk manager) while the world itself dims DOWN (glasses
    // pipeline). Splitting the value would let the windows light up before the
    // street got dark, which is the one way this can look broken.
    if (weatherSystem) {
      const nightFactor = 1 - weatherSystem.getDayFactor();
      chunkManager?.setNightFactor(nightFactor);
      scene.setNightFactor(nightFactor);
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

      // 玩家名牌(幽靈模式限定)跟位 — 先定位再顯示,避免初建時在原點閃一幀。
      if (playerLabel) {
        playerLabel.setPosition(worldX, worldY - LABEL_OFFSET_PX);
        playerLabel.setVisible(true);
      }
    }

    // ── Ghost rider (P8) ──
    if (ghostSprite) {
      if (ghostDistM === null) {
        ghostSprite.setVisible(false);
        ghostLabel?.setVisible(false);
      } else {
        const gX = ghostDistM * PX_PER_METER;
        const gY = scene.getTerrainY(ghostDistM);
        const gSlopeDeg = scene.getTerrainSlope(ghostDistM);
        // 速度由差分推導(20Hz 內插後仍平滑);罰站 → 0 → 腿停。
        if (dt > 0 && ghostPrevDistM !== null) {
          const inst = Math.max(0, ((ghostDistM - ghostPrevDistM) / dt) * 3.6);
          // 圈界 wrap(距離倒退一整圈)時不要算出巨大負差 → clamp 已保 0。
          ghostSpeedKmh += (inst - ghostSpeedKmh) * Math.min(1, dt * 5);
        }
        ghostPrevDistM = ghostDistM;

        updateCyclistSpriteFn!(ghostSprite, {
          worldX: gX,
          worldY: gY,
          slopeDeg: gSlopeDeg,
          // 幽靈沒有踏頻資料 — 移動中就給一個看起來合理的迴轉讓腿動起來。
          cadenceRpm: ghostSpeedKmh > 1 ? 80 : 0,
          isDarkened: bridge.isDarkened,
          slopePercent: Math.tan(gSlopeDeg * Math.PI / 180) * 100,
          speedKmh: ghostSpeedKmh,
        }, styleStrategy ?? undefined);
        ghostSprite.setVisible(true);
        ghostSprite.setAlpha(GHOST_ALPHA);
        if (ghostLabel) {
          ghostLabel.setPosition(gX, gY - LABEL_OFFSET_PX);
          ghostLabel.setVisible(true);
        }
      }
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

  /**
   * Feed the finish-line aircraft's hanging banner its live readout (fed ~1 Hz
   * from the game loop). `remainingMs` is null in freeRoam / when there is no
   * target duration → the banner shows km only. No-op until the scene exists.
   */
  function updateFinishBanner(remainingKm: number, remainingMs: number | null): void {
    gameInstance?.scene.setFinishBannerInfo(remainingKm, remainingMs);
  }

  /** 預估終點在玩家前方多少公尺(server finishTarget.remainingM)。 */
  function updateFinishTarget(leadM: number): void {
    gameInstance?.scene.setFinishTarget(leadM);
  }

  /**
   * 幽靈車模式開關(P8)。`label` = 幽靈名牌(如「幽靈 · 7/12」);null 關閉並
   * 銷毀幽靈 sprite 與兩張名牌。啟用時玩家頭上同步掛「你」(防搞混)。
   */
  function setGhostInfo(label: string | null): void {
    if (label === null) {
      ghostSprite?.destroy();
      ghostLabel?.destroy();
      playerLabel?.destroy();
      ghostSprite = null;
      ghostLabel = null;
      playerLabel = null;
      ghostDistM = null;
      ghostPrevDistM = null;
      ghostSpeedKmh = 0;
      return;
    }
    if (!gameInstance || !styleStrategy || !updateCyclistSpriteFn || !createCyclistSpriteFn) return;
    const scene = gameInstance.scene;
    if (!ghostSprite) {
      // 與玩家同一套建構管線(動畫/pose 狀態齊全),再半透明 + 略低 depth —
      // 幽靈永遠畫在玩家後面。
      ghostSprite = createCyclistSpriteFn(scene, styleStrategy);
      ghostSprite.setDepth(499);
      ghostSprite.setAlpha(GHOST_ALPHA);
      ghostSprite.setVisible(false);
    }
    const makeLabel = (text: string, ghost: boolean): Phaser.GameObjects.Text => {
      const t = scene.add.text(0, 0, text, {
        fontSize: '10px',
        color: ghost ? '#cdbfff' : '#ffffff',
        fontFamily: styleStrategy!.getMarkerFont(),
        fontStyle: 'bold',
        backgroundColor: ghost ? 'rgba(30,24,52,0.55)' : 'rgba(10,14,26,0.7)',
        padding: { x: 6, y: 2 },
      });
      t.setOrigin(0.5, 1);
      t.setDepth(502);
      if (ghost) t.setAlpha(0.85);
      return t;
    };
    if (!ghostLabel) ghostLabel = makeLabel(label, true);
    if (!playerLabel) playerLabel = makeLabel('你', false);
    // 兩張名牌都先藏 — render 迴圈定位後才顯示(防原點閃幀)。
    ghostLabel.setVisible(false);
    playerLabel.setVisible(false);
  }

  /** 每幀餵幽靈的本圈 wrapped 距離(m);null = 資料空窗,隱藏不銷毀。 */
  function updateGhost(distM: number | null): void {
    ghostDistM = distM;
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
    setGhostInfo(null); // 幽靈 sprite + 兩張名牌
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
    updateFinishBanner,
    updateFinishTarget,
    setGhostInfo,
    updateGhost,
    mvtFailed,
    dispose,
  };
}
