/**
 * Composable that replaces useThreeBall + useCameraControl + useMapSetup's
 * rendering pipeline with a standalone Three.js renderer.
 *
 * Provides the same API surface so GameView.vue integration is minimal.
 * Manages: GameRenderer, FPS camera, terrain chunks, route line,
 * sky/weather, cycling glasses effect, ball mesh, and coins.
 */

import { ref, shallowRef, onUnmounted, type Ref, type ShallowRef } from 'vue';
import * as THREE from 'three';
import type { RoutePoint } from '@littlecycling/shared';
import { buildCumulativeDistances } from '@/game/route-geometry';
import { CoinPool } from '@/game/coin-pool';
import type { CoinVisual } from '@/game/coin-interface';
import { debugLog, isDebugEnabled } from '@/game/debug-logger';

/** CoinVisual with typed mesh for Three.js standalone renderer. */
interface TerrainCoinVisual extends CoinVisual {
  mesh: THREE.Mesh;
}

/** Default coin hover height above ground in meters (match rider camera height). */
const DEFAULT_COIN_HOVER_HEIGHT = 15;

// Terrain modules
import { GameRenderer } from '@/game/terrain/game-renderer';
import { updateFpsCamera, type FpsCameraOptions } from '@/game/terrain/fps-camera';
import { ElevationSampler } from '@/game/terrain/elevation-sampler';
import { TerrainChunkManager } from '@/game/terrain/terrain-chunk-manager';
import {
  createRouteLine,
  animateRouteLine,
  updateRouteLineOrigin,
  projectRouteLineOntoTerrain,
  disposeRouteLine,
} from '@/game/terrain/route-line-mesh';
import { SkyAndFog, type WeatherConfig } from '@/game/terrain/sky-and-fog';
import { CyclingGlassesEffect } from '@/game/terrain/cycling-glasses-effect';
import type { GlassesLens } from '@/stores/gameStore';
import type { MarkType } from '@/game/terrain/lens-marks-manager';
import { MVTFetcher } from '@/game/terrain/mvt-fetcher';
import { createTerrainToonMaterial } from '@/game/terrain/cartoon-materials';
import { detectZone, type ZoneType } from '@/game/terrain/zone-detector';
import { CheckpointFlagManager } from '@/game/terrain/checkpoint-flag';


export interface TerrainRendererOptions {
  /** Canvas element for Three.js rendering. */
  canvas: HTMLCanvasElement;
  /** Route points for terrain/route rendering. */
  points: RoutePoint[];
  /** Initial weather config. */
  weather?: WeatherConfig;
  /** FPS camera options. */
  cameraOptions?: FpsCameraOptions;
  /** Enable post-processing glasses effect. */
  enableGlasses?: boolean;
  /** Corridor half-width in meters (from config). */
  corridorHalfWidth?: number;
  /** Enable real-time day/night cycle based on route location (default: true). */
  dayNightEnabled?: boolean;
}

export function useTerrainRenderer() {
  const isReady = ref(false);

  // Core systems
  let gameRenderer: GameRenderer | null = null;
  let chunkManager: TerrainChunkManager | null = null;
  let skyAndFog: SkyAndFog | null = null;
  let glassesEffect: CyclingGlassesEffect | null = null;
  let sampler: ElevationSampler | null = null;
  let mvtFetcher: MVTFetcher | null = null;

  // Scene objects
  let routeLine: THREE.Group | null = null;
  let coinPool: CoinPool | null = null;
  let checkpointFlags: CheckpointFlagManager | null = null;

  // Virtual rider position (used for camera, replaces visible ball)
  const riderPosition = new THREE.Vector3();

  // State
  const coins: TerrainCoinVisual[] = [];
  let frameCount = 0;
  let elapsedTime = 0;
  let originLat = 0;
  let originLon = 0;
  let originEle = 0;
  let currentBallLngLat: [number, number] = [0, 0];
  let currentBallAltitude = 0;
  let lastDt = 0;
  let cameraOptions: FpsCameraOptions = {};
  let coinHoverHeight = DEFAULT_COIN_HOVER_HEIGHT;

  // DEM ground height at ball position (async-fetched, used to snap ball to terrain)
  let demGroundEle = 0;
  let demQueryPending = false;

  // Zone detection state
  let lastZone: ZoneType = 'open';
  let lastZoneDistance = -1;
  const ZONE_CHECK_INTERVAL_M = 50; // re-check zone every 50m

  // Last valid raycast ground height — used as fallback to avoid camera clipping through terrain
  let lastValidGroundY = 0;

  // Player lights
  let headlight: THREE.SpotLight | null = null;
  let headlightTarget: THREE.Object3D | null = null;
  let groundFill: THREE.SpotLight | null = null;
  let groundFillTarget: THREE.Object3D | null = null;
  let ambientGlow: THREE.PointLight | null = null;
  let groundPlaneMesh: THREE.Mesh | null = null;
  let lastBearing = 0;

  /**
   * Initialize the terrain renderer.
   * Call once when the canvas and route data are ready.
   */
  async function init(options: TerrainRendererOptions): Promise<void> {
    const { canvas, points, weather, enableGlasses = true } = options;
    if (options.cameraOptions) {
      cameraOptions = options.cameraOptions;
      if (cameraOptions.heightAboveM) coinHoverHeight = cameraOptions.heightAboveM;
    }

    // Game renderer (standalone WebGL)
    gameRenderer = new GameRenderer({ canvas });

    // Sky + day/night
    skyAndFog = new SkyAndFog(gameRenderer);
    skyAndFog.setDayNightEnabled(options.dayNightEnabled !== false);
    skyAndFog.init();
    if (weather) {
      skyAndFog.setWeather(weather);
    }

    // Post-processing
    if (enableGlasses) {
      glassesEffect = new CyclingGlassesEffect(gameRenderer);
      if (weather) glassesEffect.setWeather(weather.type);
    }

    // Coin pool
    coinPool = new CoinPool(gameRenderer.scene);

    // Elevation sampler (needed early for origin query)
    sampler = new ElevationSampler();

    // Set origin to route start — use DEM elevation for consistency with terrain
    if (points.length > 0) {
      originLat = points[0].lat;
      originLon = points[0].lon;
      // Try to get DEM elevation for origin; fall back to GPX
      try {
        originEle = await sampler.getElevation(points[0].lat, points[0].lon);
      } catch {
        originEle = points[0].ele;
      }
      demGroundEle = originEle;

      // Set route location for astronomical day/night calculation
      skyAndFog?.setLocation(originLat, originLon);
    }

    // Player lights — SpotLight (headlight) + PointLight (ambient glow)
    headlightTarget = new THREE.Object3D();
    gameRenderer.scene.add(headlightTarget);

    headlight = new THREE.SpotLight(0xffffee, 0.5, 120, 0.8, 0.5, 1.2);
    headlight.target = headlightTarget;
    gameRenderer.scene.add(headlight);

    // Ground fill — wider, shorter-range light illuminating road directly ahead
    groundFillTarget = new THREE.Object3D();
    gameRenderer.scene.add(groundFillTarget);
    groundFill = new THREE.SpotLight(0xfff8e0, 0.3, 60, 1.0, 0.6, 1.5);
    groundFill.target = groundFillTarget;
    gameRenderer.scene.add(groundFill);

    ambientGlow = new THREE.PointLight(0xffeedd, 0.15, 50, 1.2);
    gameRenderer.scene.add(ambientGlow);

    // Ground safety plane — prevents black void below terrain
    {
      const geo = new THREE.PlaneGeometry(10000, 10000);
      geo.rotateX(-Math.PI / 2);
      const colors = new Float32Array(geo.attributes.position.count * 3);
      const bR = 0x39 / 255 * 0.7, bG = 0xe7 / 255 * 0.7, bB = 0x5f / 255 * 0.7;
      for (let i = 0; i < colors.length; i += 3) {
        colors[i] = bR;
        colors[i + 1] = bG;
        colors[i + 2] = bB;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      groundPlaneMesh = new THREE.Mesh(geo, createTerrainToonMaterial());
      groundPlaneMesh.position.y = -2;
      gameRenderer.scene.add(groundPlaneMesh);
    }

    // MVT fetcher for road/building/water overlays
    // Must initialize first to resolve the current tile URL from TileJSON
    mvtFetcher = new MVTFetcher();
    await mvtFetcher.initialize();

    // Route line (immediate — route-first UX)
    // Uses a height offset of 1m above origin to float above terrain
    routeLine = createRouteLine(
      points,
      originLat,
      originLon,
      originEle,
      { width: canvas.clientWidth, height: canvas.clientHeight },
    );
    gameRenderer.scene.add(routeLine);
    chunkManager = new TerrainChunkManager({
      scene: gameRenderer.scene,
      points,
      sampler,
      mvtFetcher,
      corridorHalfWidth: options.corridorHalfWidth,
      onChunkLoaded: () => {
        // Project route line onto newly loaded terrain so it follows the surface
        if (routeLine && chunkManager) {
          projectRouteLineOntoTerrain(
            routeLine,
            (x, z) => chunkManager!.raycastGroundHeight(x, z),
          );
        }
      },
    });
    chunkManager.setOrigin(originLat, originLon, originEle);

    // Start preloading chunks (non-blocking)
    chunkManager.preload().catch(() => {
      // Terrain preload failure is non-fatal — ball runs on route line
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      if (!gameRenderer) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      gameRenderer.resize(w, h);
      glassesEffect?.resize(w, h);
    });
    resizeObserver.observe(canvas);

    if (isDebugEnabled()) {
      debugLog('terrain', 'Terrain renderer initialized', {
        points: points.length,
        origin: { lat: originLat, lon: originLon, ele: originEle },
        corridorHalfWidth: options.corridorHalfWidth,
        dayNight: options.dayNightEnabled !== false,
      });
    }

    isReady.value = true;
  }

  /**
   * Update rider position (invisible — true FPS). Call from updateBallVisual.
   * Same signature as threeBall.updatePosition.
   */
  function updatePosition(lngLat: [number, number], altitude: number): void {
    if (!gameRenderer) return;

    currentBallLngLat = lngLat;
    currentBallAltitude = altitude;

    const cosLat = Math.cos((originLat * Math.PI) / 180);
    const x = (lngLat[0] - originLon) * 111320 * cosLat;
    const z = -(lngLat[1] - originLat) * 111320;

    // Raycast against terrain mesh for precise ground height.
    // Falls back to last valid raycast height or async DEM query.
    const groundY = chunkManager?.raycastGroundHeight(x, z);
    if (groundY !== null && groundY !== undefined) {
      lastValidGroundY = groundY;
      riderPosition.set(x, groundY, z);
    } else {
      // Fallback: use last valid raycast OR DEM (whichever is higher, to avoid clipping)
      if (!demQueryPending && sampler) {
        demQueryPending = true;
        sampler.getElevation(lngLat[1], lngLat[0]).then((ele) => {
          demGroundEle = ele;
          demQueryPending = false;
        }).catch(() => {
          demQueryPending = false;
        });
      }
      const demY = demGroundEle - originEle;
      const safeY = Math.max(lastValidGroundY, demY);
      riderPosition.set(x, safeY, z);
    }

    // Update player lights to follow rider
    if (headlight && headlightTarget && ambientGlow) {
      const lightHeight = (cameraOptions.heightAboveM ?? DEFAULT_COIN_HOVER_HEIGHT) - 1;
      headlight.position.set(riderPosition.x, riderPosition.y + lightHeight, riderPosition.z);
      ambientGlow.position.set(riderPosition.x, riderPosition.y + lightHeight, riderPosition.z);

      // Point headlight at ground 25m ahead (~29° downward angle)
      const bearingRad = lastBearing * (Math.PI / 180);
      const HEADLIGHT_GROUND_DISTANCE = 25;
      headlightTarget.position.set(
        riderPosition.x + Math.sin(bearingRad) * HEADLIGHT_GROUND_DISTANCE,
        riderPosition.y, // ground level
        riderPosition.z - Math.cos(bearingRad) * HEADLIGHT_GROUND_DISTANCE,
      );

      // Ground fill — illuminates road 10m ahead
      if (groundFill && groundFillTarget) {
        groundFill.position.set(riderPosition.x, riderPosition.y + lightHeight, riderPosition.z);
        groundFillTarget.position.set(
          riderPosition.x + Math.sin(bearingRad) * 10,
          riderPosition.y, // ground level
          riderPosition.z - Math.cos(bearingRad) * 10,
        );
      }
    }

    // Update coin positions — float above the route line
    frameCount++;
    for (const coin of coins) {
      const dLon = coin.lngLat[0] - originLon;
      const dLat = coin.lngLat[1] - originLat;
      const cx = dLon * 111320 * cosLat;
      const cz = -dLat * 111320;

      // Raycast for coin ground height, fallback to rider ground
      const coinGroundY = chunkManager?.raycastGroundHeight(cx, cz);
      const cy = coinGroundY ?? riderPosition.y;
      const bob = Math.sin(frameCount * 0.05 + cx) * 0.15;
      coin.mesh.position.set(cx, cy + coinHoverHeight + bob, cz);
      coin.mesh.rotation.y += 0.05;
    }
  }

  /**
   * Update camera. Call from updateCamera in game loop.
   * @param bearing - Ball heading in degrees
   * @param dt - Delta time in seconds
   */
  function updateCamera(bearing: number, dt: number): void {
    if (!gameRenderer) return;
    lastDt = dt;
    lastBearing = bearing;

    updateFpsCamera(
      gameRenderer.camera,
      riderPosition,
      bearing,
      cameraOptions,
      dt,
    );
  }

  /**
   * Per-frame render. Call at end of game loop frame.
   */
  function render(dt: number): void {
    if (!gameRenderer) return;

    // Update sky/rain particles + day/night
    skyAndFog?.update(dt, gameRenderer.camera.position);

    // Animate runway lights on route line
    elapsedTime += dt;
    if (routeLine) animateRouteLine(routeLine, elapsedTime);

    // Adjust player light intensity: bright at night, subtle during day
    const celestial = skyAndFog?.celestial;
    if (celestial && headlight && ambientGlow) {
      const nightFactor = 1 - celestial.dayFactor; // 0 = day, 1 = night
      headlight.intensity = 0.3 + nightFactor * 0.7; // 0.3 → 1.0 (accent only)
      ambientGlow.intensity = 0.1 + nightFactor * 0.3; // 0.1 → 0.4
      if (groundFill) {
        groundFill.intensity = 0.15 + nightFactor * 0.35; // 0.15 → 0.5
      }
    }

    // Update terrain chunks based on ball distance along route
    // (chunkManager.update is called separately via updateDistance)

    // Probabilistic lens mark spawning based on weather
    if (glassesEffect) {
      markAccumulator += dt;
      const spawnRate = getMarkSpawnRate(currentWeatherType);
      while (markAccumulator >= spawnRate.interval && spawnRate.interval > 0) {
        markAccumulator -= spawnRate.interval;
        if (Math.random() < spawnRate.chance) {
          glassesEffect.marksManager.addMark(spawnRate.type);
        }
      }
      // Ambient marks — zone-dependent:
      // Leaf marks only in green zones (forest / open which includes parks/grass)
      // Dust marks only in non-green zones (urban / tunnel)
      if (lastZone === 'forest') {
        // Dense foliage — more leaves, no dust
        if (Math.random() < dt * 0.25) {
          glassesEffect.marksManager.addMark('leaf');
        }
      } else if (lastZone === 'open') {
        // Open areas (includes parks/grass) — occasional leaves, light dust
        if (Math.random() < dt * 0.08) {
          glassesEffect.marksManager.addMark('leaf');
        }
        if (Math.random() < dt * 0.15) {
          glassesEffect.marksManager.addMark('dust');
        }
      } else {
        // Urban / tunnel — dust only
        if (Math.random() < dt * 0.3) {
          glassesEffect.marksManager.addMark('dust');
        }
      }
    }

    // Update post-processing effects (coin glow fade etc.)
    glassesEffect?.update(dt);

    // Render
    if (glassesEffect) {
      glassesEffect.render();
    } else {
      gameRenderer.render();
    }
  }

  /**
   * Update terrain chunk loading based on distance traveled.
   * Also performs zone detection for glasses ambient effects.
   */
  function updateDistance(distanceM: number): void {
    if (!chunkManager) return;
    chunkManager.update(distanceM);

    // Zone detection — re-check every ZONE_CHECK_INTERVAL_M meters
    if (Math.abs(distanceM - lastZoneDistance) >= ZONE_CHECK_INTERVAL_M || lastZoneDistance < 0) {
      lastZoneDistance = distanceM;
      const chunkIndex = chunkManager.getCurrentChunkIndex();
      const features = chunkManager.getChunkFeatures(chunkIndex);
      if (features && features.length > 0) {
        const zone = detectZone(currentBallLngLat[1], currentBallLngLat[0], features);
        if (zone !== lastZone) {
          lastZone = zone;
          glassesEffect?.setZone(zone);
          if (isDebugEnabled()) {
            debugLog('terrain', `Zone changed: ${zone}`);
          }
        }
      }
    }
  }

  /** Set darkened state (Zone 5 warning). No-op in true FPS mode (no visible ball). */
  function setDarkened(_dark: boolean): void {
    // No visible ball to darken in FPS mode.
    // Future: could tint the screen red via post-processing.
  }

  // Weather-based lens mark spawning
  let currentWeatherType: import('@/game/terrain/sky-and-fog').WeatherType = 'sunny';
  let markAccumulator = 0;

  /** Update weather. */
  function setWeather(config: WeatherConfig): void {
    skyAndFog?.setWeather(config);
    glassesEffect?.setWeather(config.type);
    currentWeatherType = config.type;
  }

  /** Set glasses lens mode. */
  function setGlassesLens(lens: GlassesLens): void {
    glassesEffect?.setLens(lens);
  }

  /** Update physiology-driven effects (tunnel vision). */
  function updatePhysiology(hrZone: number | null, speedKmh: number): void {
    glassesEffect?.updatePhysiology(hrZone, speedKmh);
  }

  /** Add a mark to the lens (rain, snow, dust, coin, leaf). */
  function addLensMark(type: MarkType): void {
    glassesEffect?.marksManager.addMark(type);
  }

  /** Enable or disable billboard clouds. */
  function setCloudsEnabled(enabled: boolean): void {
    skyAndFog?.setCloudsEnabled(enabled);
  }

  /** Trigger gold glow effect on coin collection. */
  function triggerCoinGlow(): void {
    glassesEffect?.triggerCoinGlow();
  }

  // ── Coin management (same API as ThreeBallLayer) ──

  function spawnCoin(lngLat: [number, number], altitude: number): CoinVisual {
    const mesh = coinPool!.acquire();
    const coin: TerrainCoinVisual = { mesh, lngLat, altitude };
    coins.push(coin);
    return coin;
  }

  function removeCoin(coin: CoinVisual): void {
    const idx = coins.indexOf(coin as TerrainCoinVisual);
    if (idx >= 0) {
      coins.splice(idx, 1);
      coinPool?.release((coin as TerrainCoinVisual).mesh);
    }
  }

  function clearCoins(): void {
    for (const coin of coins) {
      coinPool?.release(coin.mesh);
    }
    coins.length = 0;
  }

  /**
   * Spawn 3D checkpoint flags at workout segment boundaries.
   */
  function spawnCheckpointFlags(
    segments: import('@littlecycling/shared').WorkoutSegment[],
    points: RoutePoint[],
  ): void {
    if (!gameRenderer || segments.length < 2 || points.length < 2) return;

    if (!checkpointFlags) {
      checkpointFlags = new CheckpointFlagManager(gameRenderer.scene);
    }

    const cumDists = buildCumulativeDistances(points);
    const totalRouteDist = cumDists[cumDists.length - 1];

    checkpointFlags.spawn(
      segments,
      points,
      cumDists,
      totalRouteDist,
      originLon,
      originLat,
      (x, z) => chunkManager?.raycastGroundHeight(x, z) ?? undefined,
    );
  }

  /**
   * Update checkpoint flags based on rider distance (fade passed flags).
   */
  function updateCheckpointFlags(riderDistanceM: number): void {
    checkpointFlags?.update(riderDistanceM);
  }

  /** Clean up all resources. */
  function dispose(): void {
    chunkManager?.dispose();
    skyAndFog?.dispose();
    glassesEffect?.dispose();

    if (routeLine) {
      disposeRouteLine(routeLine);
      routeLine = null;
    }

    // Player lights
    if (headlight) {
      gameRenderer?.scene.remove(headlight);
      headlight.dispose();
      headlight = null;
    }
    if (headlightTarget) {
      gameRenderer?.scene.remove(headlightTarget);
      headlightTarget = null;
    }
    if (groundFill) {
      gameRenderer?.scene.remove(groundFill);
      groundFill.dispose();
      groundFill = null;
    }
    if (groundFillTarget) {
      gameRenderer?.scene.remove(groundFillTarget);
      groundFillTarget = null;
    }
    if (ambientGlow) {
      gameRenderer?.scene.remove(ambientGlow);
      ambientGlow.dispose();
      ambientGlow = null;
    }
    if (groundPlaneMesh) {
      gameRenderer?.scene.remove(groundPlaneMesh);
      groundPlaneMesh.geometry.dispose();
      (groundPlaneMesh.material as THREE.Material).dispose();
      groundPlaneMesh = null;
    }

    clearCoins();
    checkpointFlags?.dispose();
    checkpointFlags = null;
    gameRenderer?.dispose();
    gameRenderer = null;
    isReady.value = false;
  }

  function setCameraOptions(opts: Partial<FpsCameraOptions>): void {
    if (opts.heightAboveM !== undefined) cameraOptions.heightAboveM = opts.heightAboveM;
    if (opts.pitchDeg !== undefined) cameraOptions.pitchDeg = opts.pitchDeg;
    if (opts.lookAheadM !== undefined) cameraOptions.lookAheadM = opts.lookAheadM;
  }

  function getMarkSpawnRate(weather: import('@/game/terrain/sky-and-fog').WeatherType) {
    switch (weather) {
      case 'rainy':
        return { type: 'rain' as const, interval: 0.3, chance: 0.8 }; // ~2-3/sec
      case 'snowy':
        return { type: 'snow' as const, interval: 0.6, chance: 0.7 }; // ~1-2/sec
      default:
        return { type: 'dust' as const, interval: 0, chance: 0 }; // handled by ambient
    }
  }

  onUnmounted(dispose);

  return {
    isReady,
    init,
    updatePosition,
    updateCamera,
    setCameraOptions,
    updateDistance,
    render,
    setDarkened,
    setWeather,
    setCloudsEnabled,
    triggerCoinGlow,
    setGlassesLens,
    updatePhysiology,
    addLensMark,
    spawnCoin,
    removeCoin,
    clearCoins,
    spawnCheckpointFlags,
    updateCheckpointFlags,
    dispose,
  };
}

export type TerrainRendererAPI = ReturnType<typeof useTerrainRenderer>;
