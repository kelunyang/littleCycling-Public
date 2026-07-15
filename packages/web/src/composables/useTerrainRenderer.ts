/**
 * Composable that replaces useThreeBall + useCameraControl + useMapSetup's
 * rendering pipeline with a standalone Three.js renderer.
 *
 * Provides the same API surface so GameView.vue integration is minimal.
 * Manages: GameRenderer, FPS camera, terrain chunks, route line,
 * sky/weather, cycling glasses effect, ball mesh, and coins.
 */

import { ref, onUnmounted } from 'vue';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { RoutePoint } from '@littlecycling/shared';
import { buildCumulativeDistances } from '@/game/route-geometry';
import { useLoadingStore } from '@/stores/loadingStore';
import { CoinPool } from '@/game/coin-pool';
import type { CoinVisual } from '@/game/coin-interface';
import { debugLog, isDebugEnabled } from '@/game/debug-logger';

/** CoinVisual with typed mesh for Three.js standalone renderer. */
interface TerrainCoinVisual extends CoinVisual {
  mesh: THREE.Mesh;
  /** Cached scene-space ground height (coin position is static; the floating
   *  origin never shifts mid-ride, so one raycast result stays valid). */
  groundY?: number;
}

/**
 * Coin hover height above the ground, in metres. Third-person coins float at
 * bike-rider height so they read as collectibles on the road — not at the old
 * first-person eye height, which left them hanging above the world.
 */
const COIN_HOVER_HEIGHT = 3.5;

// Terrain modules
import { GameRenderer } from '@/game/terrain/game-renderer';
import { updateFpsCamera, CHASE_LOOK_HEIGHT, type FpsCameraOptions } from '@/game/terrain/fps-camera';
import { ElevationSampler } from '@/game/terrain/elevation-sampler';
import { TerrainChunkManager } from '@/game/terrain/terrain-chunk-manager';
import { BikeOrnament } from '@/game/terrain/bike-ornament';
import { OrbitCamera } from '@/game/terrain/orbit-camera';
import {
  CameraGroundClamp,
  SIGHTLINE_SAMPLES,
  type SightlineSample,
} from '@/game/terrain/camera-collision';
import { CameraLift, LIFT_UP, LIFT_BACK, type LiftKind } from '@/game/terrain/camera-lift';
import { MountainRing } from '@/game/terrain/mountain-ring';
import { StreetLampManager } from '@/game/terrain/street-lamp';
import {
  createRouteLine,
  updateRouteLineOrigin,
  projectRouteLineOntoTerrain,
  disposeRouteLine,
} from '@/game/terrain/route-line-mesh';
import { SkyAndFog, type WeatherConfig } from '@/game/terrain/sky-and-fog';
import { setWindowLightOpacity } from '@/game/terrain/building-lights';
import { CyclingGlassesEffect } from '@/game/terrain/cycling-glasses-effect';
import type { GlassesLens } from '@/stores/gameStore';
import type { MarkType } from '@/game/terrain/lens-marks-manager';
import { MVTFetcher } from '@/game/terrain/mvt-fetcher';
import { detectZone, type ZoneType } from '@/game/terrain/zone-detector';
import { CheckpointFlagManager } from '@/game/terrain/checkpoint-flag';
import {
  createTerrainStyleStrategy,
  terrainStyleFromWorldStyle,
  type TerrainStyleStrategy,
  type WorldStyle,
} from '@/game/terrain/terrain-style-strategy';


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
  /** World visual style — 'plastic' (blocks) or 'cuphead' (paper). Default: plastic. */
  worldStyle?: WorldStyle;
}

export function useTerrainRenderer() {
  const isReady = ref(false);
  const loading = useLoadingStore();
  /**
   * Resolves when the first batch of chunks is in the scene — i.e. when there
   * is actually a world to look at. init() returning is *not* that moment: it
   * kicks the preload off and returns immediately. This is what the loading
   * overlay waits on before it lets the rider through.
   */
  let terrainReady: Promise<void> = Promise.resolve();
  /** Preloaded chunk indices already counted towards the loading bar. */
  const loadedChunks = new Set<number>();

  // Core systems
  let gameRenderer: GameRenderer | null = null;
  let chunkManager: TerrainChunkManager | null = null;
  let skyAndFog: SkyAndFog | null = null;
  let glassesEffect: CyclingGlassesEffect | null = null;
  let sampler: ElevationSampler | null = null;
  let mvtFetcher: MVTFetcher | null = null;
  const mvtFailed = ref(false);

  // World-style strategy + its post pass (paper-craft) and, when glasses are
  // disabled, a standalone composer that still applies the style pass.
  let strategy: TerrainStyleStrategy | null = null;
  let stylePass: ShaderPass | null = null;
  let postComposer: EffectComposer | null = null;
  let currentWorldStyle: WorldStyle = 'plastic';

  // Scene objects
  let routeLine: THREE.Group | null = null;
  /** Route points kept for route-line rebuilds on style switches. */
  let routePointsRef: RoutePoint[] = [];
  let coinPool: CoinPool | null = null;
  let checkpointFlags: CheckpointFlagManager | null = null;

  // Third-person diorama: the rider's bike, the horizon, the roadside lamps.
  let bike: BikeOrnament | null = null;
  let orbitCamera: OrbitCamera | null = null;
  /** Keeps the chase camera above the terrain; lifts it into a bird's-eye when a
   *  hill gets between it and the bike. */
  const groundClamp = new CameraGroundClamp();
  /** Cinematic rise at interval ends / the run-in to the finish. */
  const cameraLift = new CameraLift();
  const _liftPos = new THREE.Vector3();
  /** Reused ground probes along the camera→bike sightline (no per-frame alloc). */
  const _sightline: SightlineSample[] = [];
  const _gaze = new THREE.Vector3();
  let mountainRing: MountainRing | null = null;
  let streetLamps: StreetLampManager | null = null;
  /** Args of the last spawnCheckpointFlags call — replayed on a style switch. */
  let lastCheckpointSpawn: {
    segments: import('@littlecycling/shared').WorkoutSegment[];
    points: RoutePoint[];
  } | null = null;

  // Virtual rider position (used for camera, replaces visible ball)
  const riderPosition = new THREE.Vector3();

  // State
  const coins: TerrainCoinVisual[] = [];
  let elapsedTime = 0;
  let originLat = 0;
  let originLon = 0;
  let originEle = 0;
  let currentBallLngLat: [number, number] = [0, 0];
  let currentBallAltitude = 0;
  let lastDt = 0;
  let cameraOptions: FpsCameraOptions = {};

  // DEM ground height at ball position (async-fetched, used to snap ball to terrain)
  let demGroundEle = 0;
  let demQueryPending = false;

  // Zone detection state
  let lastZone: ZoneType = 'open';
  let lastZoneDistance = -1;
  const ZONE_CHECK_INTERVAL_M = 50; // re-check zone every 50m

  // Route progress — drives the bike's wheel spin and the street-lamp pool.
  let riderDistanceM = 0;
  let prevRiderDistanceM = 0;
  let smoothedSpeedMps = 0;

  // Last valid raycast ground height — used as fallback to avoid camera clipping through terrain
  let lastValidGroundY = 0;

  // Player lights
  let headlight: THREE.SpotLight | null = null;
  let headlightTarget: THREE.Object3D | null = null;
  let groundFill: THREE.SpotLight | null = null;
  let groundFillTarget: THREE.Object3D | null = null;
  let ambientGlow: THREE.PointLight | null = null;
  let lastBearing = 0;

  /**
   * Initialize the terrain renderer.
   * Call once when the canvas and route data are ready.
   */
  async function init(options: TerrainRendererOptions): Promise<void> {
    const { canvas, points, weather, enableGlasses = true, worldStyle = 'plastic' } = options;
    if (options.cameraOptions) {
      cameraOptions = options.cameraOptions;
    }

    // Game renderer (standalone WebGL)
    gameRenderer = new GameRenderer({ canvas });

    // World-style strategy (materials + colours + geometry + post pass).
    currentWorldStyle = worldStyle;
    loading.beginStage('style');
    strategy = await createTerrainStyleStrategy(terrainStyleFromWorldStyle(worldStyle));
    loading.completeStage('style');

    // Sky + day/night
    skyAndFog = new SkyAndFog(gameRenderer);
    skyAndFog.setDayNightEnabled(options.dayNightEnabled !== false);
    // The sky gradient and every light come from the world style's palette.
    skyAndFog.setPalette(strategy.skyPalette);
    skyAndFog.init();
    if (weather) {
      skyAndFog.setWeather(weather);
    }

    // Post-processing
    if (enableGlasses) {
      glassesEffect = new CyclingGlassesEffect(gameRenderer);
      if (weather) glassesEffect.setWeather(weather.type);
      // Nothing sits on the bloom layer any more — the route line is a flat mark
      // on the road in both worlds (the demos use no bloom), so the whole bloom
      // chain would render an empty pass. Off in both styles.
      glassesEffect.setBloomEnabled(false);
    }

    // World-style post pass (paper-craft) — decoupled from the glasses effect so
    // the style persists even with glasses off.
    installStylePass();

    // Coin pool — coins take the world style's look (push-pin / brick tile).
    coinPool = new CoinPool(gameRenderer.scene, () => strategy!.buildCoinMesh());

    // Elevation sampler (needed early for origin query)
    sampler = new ElevationSampler();

    // Set origin to route start — use DEM elevation for consistency with terrain
    if (points.length > 0) {
      originLat = points[0].lat;
      originLon = points[0].lon;
      // Try to get DEM elevation for origin; fall back to GPX
      loading.beginStage('origin');
      try {
        originEle = await sampler.getElevation(points[0].lat, points[0].lon);
        loading.completeStage('origin');
      } catch {
        originEle = points[0].ele;
        // Non-fatal: the GPX elevation is a fine origin, the ride just starts
        // from a slightly different datum than the DEM terrain.
        loading.failStage('origin', '無法取得起點高程，改用路線檔的高度');
      }
      demGroundEle = originEle;

      // Set route location for astronomical day/night calculation
      skyAndFog?.setLocation(originLat, originLon);
    } else {
      // No route, no origin to fetch — the stage is vacuously done. Left pending
      // it would hold the progress bar below 100 forever.
      loading.completeStage('origin');
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

    // Distant mountain silhouette + the horizon disc the diorama sits on. The
    // disc replaces the old 10 km "safety plane": it follows the rider and
    // renders behind everything, so there is no void beyond the corridor and no
    // plate cutting through deep valleys.
    mountainRing = new MountainRing(
      gameRenderer.scene,
      strategy,
      Math.floor(Math.random() * 0x7fffffff),
      options.corridorHalfWidth,
    );

    // The rider's bike — the third-person view's whole reason to exist.
    bike = new BikeOrnament(gameRenderer.scene, strategy);

    // Free-look camera — built now, but it only listens for drag/wheel while the
    // rider actually switches to it (see setCameraOptions).
    orbitCamera = new OrbitCamera(canvas);
    if (cameraOptions.mode === 'orbit') orbitCamera.attach();
    bike.setVisible((options.cameraOptions?.mode ?? 'third') === 'third');

    // MVT fetcher for road/building/water overlays
    // Must initialize first to resolve the current tile URL from TileJSON
    mvtFetcher = new MVTFetcher();
    loading.beginStage('tilejson');
    await mvtFetcher.initialize();
    // Check if tile URL was resolved — if not, MVT overlays are unavailable
    if (!mvtFetcher.isAvailable()) {
      mvtFailed.value = true;
      loading.failStage('tilejson', '圖資服務連線失敗，將以簡化場景進行');
    } else {
      loading.completeStage('tilejson');
    }

    // Route line (immediate — route-first UX). A mark drawn on the road, in the
    // world style's hand: highlighter swipe (paper) / neon tape (plastic).
    routePointsRef = points;
    routeLine = createRouteLine(
      points,
      originLat,
      originLon,
      originEle,
      { width: canvas.clientWidth, height: canvas.clientHeight },
      { style: strategy.routeLine },
    );
    gameRenderer.scene.add(routeLine);
    chunkManager = new TerrainChunkManager({
      scene: gameRenderer.scene,
      points,
      sampler,
      mvtFetcher,
      corridorHalfWidth: options.corridorHalfWidth,
      strategy,
      onChunkLoaded: (chunkIndex: number) => {
        // Loading progress counts the preloaded chunks only (the ones the
        // overlay is waiting on), and counts each once: this fires twice per
        // chunk — on entering the scene, then again when its drop-in lands.
        const preloadCount = chunkManager?.preloadCount ?? 0;
        if (chunkIndex < preloadCount && !loadedChunks.has(chunkIndex)) {
          loadedChunks.add(chunkIndex);
          loading.setStageProgress('chunks', loadedChunks.size, preloadCount);
        }

        // Project the route line onto newly loaded terrain so it follows the
        // surface — but ONLY the point range this chunk covers. Raycasting is
        // O(triangles); projecting the whole route on every chunk load was the
        // main streaming hitch. Points outside the range keep their prior Y.
        if (routeLine && chunkManager) {
          const range = chunkManager.getChunkPointRange(chunkIndex) ?? undefined;
          projectRouteLineOntoTerrain(
            routeLine,
            (x, z) => chunkManager!.raycastGroundHeight(x, z),
            undefined,
            range,
          );
        }
      },
    });
    chunkManager.setOrigin(originLat, originLon, originEle);

    // Roadside lamps — a recycled pool that slides along the route with the
    // rider, so long routes cost no more than short ones.
    if (points.length > 1) {
      streetLamps = new StreetLampManager(
        gameRenderer.scene,
        strategy,
        points,
        buildCumulativeDistances(points),
        originLat,
        originLon,
      );
    }

    // Start preloading chunks. Still non-blocking for init() — but the promise
    // is kept rather than dropped, so the loading overlay can wait on the real
    // "there is a world now" moment instead of guessing.
    loading.beginStage('chunks');
    loading.setStageProgress('chunks', 0, chunkManager.preloadCount);
    terrainReady = chunkManager.preload().then(
      () => {
        loading.completeStage('chunks');
      },
      () => {
        // Terrain preload failure is non-fatal — ball runs on route line
        loading.failStage('chunks', '地形載入失敗，將沿路線飛行');
      },
    );

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      if (!gameRenderer) return;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      gameRenderer.resize(w, h);
      glassesEffect?.resize(w, h);
      if (postComposer) {
        postComposer.setSize(w, h);
        const res = stylePass?.uniforms['uResolution'];
        if (res) res.value.set(w, h);
      }
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
      // Rider lights ride at bike height, not camera height (third person).
      const lightHeight = 2.5;
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
    for (const coin of coins) {
      const dLon = coin.lngLat[0] - originLon;
      const dLat = coin.lngLat[1] - originLat;
      const cx = dLon * 111320 * cosLat;
      const cz = -dLat * 111320;

      // Ground height is static per coin — raycast (O(triangles)) only until we
      // get a hit, then cache. Falls back to rider ground until its chunk loads.
      if (coin.groundY === undefined) {
        const hit = chunkManager?.raycastGroundHeight(cx, cz);
        if (hit !== null && hit !== undefined) coin.groundY = hit;
      }
      const cy = coin.groundY ?? riderPosition.y;
      const bob = Math.sin(elapsedTime * 3 + cx) * 0.45;
      coin.mesh.position.set(cx, cy + COIN_HOVER_HEIGHT + bob, cz);
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

    // Free look: the user drives the camera, not the route. It outranks the
    // cinematic lift — the rider can always take the camera back.
    if (cameraOptions.mode === 'orbit') {
      if (cameraLift.kind === 'peek') cameraLift.cancel();
      groundClamp.reset();
      orbitCamera?.update(gameRenderer.camera, riderPosition);
      return;
    }

    const camera = gameRenderer.camera;

    updateFpsCamera(camera, riderPosition, bearing, cameraOptions, dt);

    if (cameraOptions.mode !== 'third') return;

    // Heading → forward, so the lift can sit behind the bike and the gaze can be
    // blended between "down the road" and "down at the bike".
    const bearingRad = (bearing * Math.PI) / 180;
    const fx = Math.sin(bearingRad);
    const fz = -Math.cos(bearingRad);

    // ── Cinematic lift (interval ended / finish line coming) ──
    const lift = cameraLift.update(dt);
    if (lift > 0) {
      _liftPos.set(
        riderPosition.x - fx * LIFT_BACK,
        riderPosition.y + LIFT_UP,
        riderPosition.z - fz * LIFT_BACK,
      );
      camera.position.lerp(_liftPos, lift);
      // On the way down the chase rig's own lerp (dt × 3.2) reels the camera
      // back in, so there is no separate descent animation to write.
    }

    // ── Keep the bike in sight. Probe the ground ALONG the sightline, not just
    //    under the camera: going downhill the crest you just came over stands
    //    between camera and bike while sitting well below the camera, so a
    //    "is the camera underground" test never fires and the bike vanishes.
    //    Skipped while the lift already has us in the air. ──
    let clampTilt = 0;
    if (lift < 0.5 && chunkManager) {
      _sightline.length = 0;
      for (let i = 1; i <= SIGHTLINE_SAMPLES; i++) {
        const t = i / SIGHTLINE_SAMPLES; // 0 = bike, 1 = camera
        _sightline.push({
          t,
          groundY: chunkManager.raycastGroundHeight(
            riderPosition.x + (camera.position.x - riderPosition.x) * t,
            riderPosition.z + (camera.position.z - riderPosition.z) * t,
          ),
        });
      }

      camera.position.y += groundClamp.update(
        riderPosition.y,
        camera.position.y,
        CHASE_LOOK_HEIGHT,
        _sightline,
        dt,
      );
      clampTilt = groundClamp.tilt;
    } else {
      groundClamp.reset();
    }

    // Both effects want the gaze to swing from the road ahead onto the bike; take
    // whichever is stronger and aim there, blended so it never cuts.
    const aim = Math.max(lift, clampTilt);
    if (aim > 0) {
      const gazeAhead = cameraOptions.lookAheadM ?? 5.3;
      _gaze.set(
        riderPosition.x + fx * gazeAhead * (1 - aim),
        riderPosition.y + CHASE_LOOK_HEIGHT,
        riderPosition.z + fz * gazeAhead * (1 - aim),
      );
      camera.lookAt(_gaze);
    }
  }

  /**
   * Per-frame render. Call at end of game loop frame.
   */
  function render(dt: number): void {
    if (!gameRenderer) return;

    // Advance chunk entrance animations (F1).
    chunkManager?.updateEntrances(dt);

    // Update sky/rain particles + day/night
    skyAndFog?.update(dt, gameRenderer.camera.position);

    // Ground speed from route progress — drives the bike's wheels. Smoothed so
    // the 20 Hz server frames don't make the wheels stutter.
    if (dt > 0) {
      const instant = (riderDistanceM - prevRiderDistanceM) / dt;
      prevRiderDistanceM = riderDistanceM;
      smoothedSpeedMps += (instant - smoothedSpeedMps) * Math.min(dt * 6, 1);
    }

    // The bike, the horizon, and the lamps all track the rider.
    bike?.update(riderPosition, lastBearing, smoothedSpeedMps, dt);
    mountainRing?.update(riderPosition);
    const nightFactor = 1 - (skyAndFog?.celestial?.dayFactor ?? 1);
    // In a tunnel the lamps go dense and stay lit — that IS the tunnel (we draw
    // no bore). Zone comes from updateDistance()'s 50 m re-check.
    streetLamps?.update(
      riderDistanceM,
      nightFactor,
      (x, z) => chunkManager?.raycastGroundHeight(x, z),
      lastZone === 'tunnel',
    );

    // Building window lights (F2) — fade in through dusk (smoothstep 0.25→0.6).
    const lit = Math.max(0, Math.min(1, (nightFactor - 0.25) / 0.35));
    setWindowLightOpacity(lit * lit * (3 - 2 * lit) * 0.9);

    // The route line is a static mark on the road (highlighter / neon tape) —
    // nothing to animate. elapsedTime still drives the coin bob.
    elapsedTime += dt;

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
    } else if (postComposer) {
      // Glasses off but a world-style post pass is active — apply it standalone.
      postComposer.render();
    } else {
      gameRenderer.render();
    }
  }

  /**
   * Update terrain chunk loading based on distance traveled.
   * Also performs zone detection for glasses ambient effects.
   */
  function updateDistance(distanceM: number): void {
    riderDistanceM = distanceM;
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

  /** Update wind state (drives particle/cloud drift). */
  function setWind(speedKmh: number, directionDeg: number, gust = 1): void {
    skyAndFog?.setWind(speedKmh, directionDeg, gust);
  }

  /** Trigger a lightning flash (skybox bolt + ~70% follow-up strike). */
  function triggerLightning(intensityMul = 1): void {
    skyAndFog?.triggerLightning(intensityMul);
  }

  /**
   * (Re)build the strategy's world-style post pass and install it — into the
   * glasses composer when enabled, else a standalone composer. Idempotent:
   * tears down any previous pass/composer first.
   */
  function installStylePass(): void {
    if (!gameRenderer || !strategy) return;
    const w = gameRenderer.renderer.domElement.clientWidth;
    const h = gameRenderer.renderer.domElement.clientHeight;

    glassesEffect?.setStylePass(null);
    if (postComposer) { postComposer.dispose(); postComposer = null; }
    disposeStylePass();

    stylePass = strategy.createPostPass(w, h);
    if (!stylePass) return;

    if (glassesEffect) {
      glassesEffect.setStylePass(stylePass);
    } else {
      postComposer = new EffectComposer(gameRenderer.renderer);
      postComposer.addPass(new RenderPass(gameRenderer.scene, gameRenderer.camera));
      postComposer.addPass(stylePass);
    }
  }

  /** Dispose the active style post pass and its procedural texture. */
  function disposeStylePass(): void {
    if (!stylePass) return;
    const paper = stylePass.uniforms?.['uPaper']?.value as THREE.Texture | undefined;
    paper?.dispose();
    (stylePass as unknown as { dispose?: () => void }).dispose?.();
    stylePass = null;
  }

  /**
   * Switch the world visual style at runtime — swaps the strategy, its post
   * pass, the ground-plane material, and rebuilds all terrain/overlay meshes.
   */
  async function setWorldStyle(worldStyle: WorldStyle): Promise<void> {
    if (!chunkManager || !gameRenderer || worldStyle === currentWorldStyle) return;
    currentWorldStyle = worldStyle;
    const oldStrategy = strategy;
    strategy = await createTerrainStyleStrategy(terrainStyleFromWorldStyle(worldStyle));

    installStylePass();
    chunkManager.setStrategy(strategy);
    skyAndFog?.setPalette(strategy.skyPalette);

    // Diorama props are style-owned meshes — rebuild each one.
    bike?.setStrategy(strategy);
    mountainRing?.setStrategy(strategy);
    streetLamps?.setStrategy(strategy);
    rebuildCoinMeshes();
    if (checkpointFlags && lastCheckpointSpawn) {
      checkpointFlags.setStrategy(strategy);
      spawnCheckpointFlags(lastCheckpointSpawn.segments, lastCheckpointSpawn.points);
    }

    // The route mark is style-owned (highlighter ⇄ neon tape) — rebuild it.
    if (routeLine && routePointsRef.length > 0) {
      gameRenderer.scene.remove(routeLine);
      disposeRouteLine(routeLine);
      const canvasEl = gameRenderer.renderer.domElement;
      routeLine = createRouteLine(
        routePointsRef,
        originLat,
        originLon,
        originEle,
        { width: canvasEl.clientWidth, height: canvasEl.clientHeight },
        { style: strategy.routeLine },
      );
      gameRenderer.scene.add(routeLine);
      // Snap onto whatever terrain is loaded; onChunkLoaded re-projects as the
      // rebuilt chunks stream in.
      projectRouteLineOntoTerrain(
        routeLine,
        (x, z) => chunkManager!.raycastGroundHeight(x, z),
      );
    }

    oldStrategy?.dispose();
  }

  /** Push live post-pass params (debug panel post sliders) into the pass. */
  function applyStyleParams(): void {
    if (strategy && stylePass) strategy.applyPostParams(stylePass);
  }

  /** Rebuild terrain/overlays with the current strategy (geometry param change). */
  function rebuildTerrain(): void {
    chunkManager?.rebuild();
  }

  /** Expose the active strategy for the debug panel. */
  function getStrategy(): TerrainStyleStrategy | null {
    return strategy;
  }

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

  /**
   * Swap every coin's mesh to the new style. Coins in flight keep their
   * identity (the game owns their lngLat) — only the visual is replaced.
   */
  function rebuildCoinMeshes(): void {
    if (!gameRenderer || !strategy) return;
    const oldPool = coinPool;
    coinPool = new CoinPool(gameRenderer.scene, () => strategy!.buildCoinMesh());
    for (const coin of coins) {
      coin.mesh = coinPool.acquire();
    }
    oldPool?.dispose();
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
    if (!gameRenderer || !strategy || segments.length < 2 || points.length < 2) return;

    lastCheckpointSpawn = { segments, points };

    if (!checkpointFlags) {
      checkpointFlags = new CheckpointFlagManager(gameRenderer.scene, strategy);
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
    bike?.dispose();
    bike = null;
    orbitCamera?.dispose();
    orbitCamera = null;
    mountainRing?.dispose();
    mountainRing = null;
    streetLamps?.dispose();
    streetLamps = null;
    lastCheckpointSpawn = null;
    disposeStylePass();
    postComposer?.dispose();
    postComposer = null;
    strategy?.dispose();
    strategy = null;

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

    clearCoins();
    coinPool?.dispose();
    coinPool = null;
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
    if (opts.mode !== undefined && opts.mode !== cameraOptions.mode) {
      cameraOptions.mode = opts.mode;
      // In first person the rider IS the camera — the bike would fill the view.
      // Free look is all about looking at the bike, so it keeps it.
      bike?.setVisible(opts.mode !== 'first');
      // Only listen for drag/wheel while free look is actually on, so an
      // ordinary ride can't have its scroll eaten by a camera nobody is using.
      if (opts.mode === 'orbit') orbitCamera?.attach();
      else orbitCamera?.detach();
    }
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
    /** Awaits the first batch of terrain chunks — the loading overlay's cue.
     *  Never rejects: a failed preload resolves, degraded (see failStage). */
    whenTerrainReady: () => terrainReady,
    init,
    updatePosition,
    updateCamera,
    /** Rise for a look at the world: 'peek' at an interval end, 'finale' on the
     *  run-in to the finish. Ignored in free look (the rider owns the camera). */
    triggerCameraLift: (kind: LiftKind) => cameraLift.trigger(kind),
    setCameraOptions,
    updateDistance,
    render,
    setDarkened,
    setWeather,
    setWind,
    triggerLightning,
    setCloudsEnabled,
    triggerCoinGlow,
    setGlassesLens,
    setWorldStyle,
    applyStyleParams,
    rebuildTerrain,
    getStrategy,
    updatePhysiology,
    addLensMark,
    spawnCoin,
    removeCoin,
    clearCoins,
    spawnCheckpointFlags,
    updateCheckpointFlags,
    mvtFailed,
    dispose,
  };
}

export type TerrainRendererAPI = ReturnType<typeof useTerrainRenderer>;
