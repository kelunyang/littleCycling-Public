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
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { RoutePoint, WorldOptionsConfig, WorldOptionValue } from '@littlecycling/shared';
import { resolveWorldOptions } from '@littlecycling/shared';
import { buildCumulativeDistances } from '@/game/route-geometry';
import { useLoadingStore } from '@/stores/loadingStore';
import { CoinPool } from '@/game/coin-pool';
import type { CoinVisual } from '@/game/coin-interface';
import { debugLog, isDebugEnabled } from '@/game/debug-logger';
import { anySceneLayerHidden, applySceneLayerVisibility } from '@/game/terrain/debug-layers';
import { phaseRenderStart, phaseRenderEnd, takeFramePhases } from '@/composables/useFramePhases';

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

/** Beyond this ground-plane distance from the rider a coin is a speck: hide it and
 *  skip the bob/spin + ground raycast (mirrors the legacy three-layer cull). */
const COIN_CULL_DIST_M = 400;
const COIN_CULL_DIST_SQ = COIN_CULL_DIST_M * COIN_CULL_DIST_M;

// Terrain modules
import { GameRenderer } from '@/game/terrain/game-renderer';
import { updateFpsCamera, CHASE_LOOK_HEIGHT, type FpsCameraOptions } from '@/game/terrain/fps-camera';
import { ElevationSampler } from '@/game/terrain/elevation-sampler';
import { TerrainChunkManager } from '@/game/terrain/terrain-chunk-manager';
import { BikeOrnament } from '@/game/terrain/bike-ornament';
import { OrbitCamera } from '@/game/terrain/orbit-camera';
import {
  climbOntoTread as climbTread,
  noseProbePoint,
} from '@/game/terrain/climb-onto-tread';
import {
  CameraGroundClamp,
  type SightlineSample,
} from '@/game/terrain/camera-collision';
import {
  QUALITY_PRESETS,
  guessInitialTier,
  type QualityTier,
  type QualityParams,
} from '@/game/quality/graphics-quality';
import { CameraLift, LIFT_UP, LIFT_BACK, type LiftKind } from '@/game/terrain/camera-lift';
import { MountainRing } from '@/game/terrain/mountain-ring';
import { AcrylicCase } from '@/game/terrain/acrylic-case';
import { isSceneBloomPass } from '@/game/terrain/scene-bloom-pass';
import { StreetLampManager } from '@/game/terrain/street-lamp';
import {
  createRouteLine,
  updateRouteLineOrigin,
  projectRouteLineOntoTerrain,
  setRouteLineWindow,
  disposeRouteLine,
} from '@/game/terrain/route-line-mesh';
import { SkyAndFog, type WeatherConfig } from '@/game/terrain/sky-and-fog';
import { setNightLitFactor } from '@/game/terrain/building-lights';
import { GpuTimer } from '@/game/terrain/gpu-timer';
import { CyclingGlassesEffect } from '@/game/terrain/cycling-glasses-effect';
import type { GlassesLens } from '@/stores/gameStore';
import type { MarkType } from '@/game/terrain/lens-marks-manager';
import { MVTFetcher } from '@/game/terrain/mvt-fetcher';
import { detectZone, type ZoneType } from '@/game/terrain/zone-detector';
import { CheckpointFlagManager } from '@/game/terrain/checkpoint-flag';
import { setMaxBuildingsPerChunk } from '@/game/terrain/building-renderer';
import type { SignVocabulary } from '@/game/terrain/sign-spec';
import { FinishAirshipManager } from '@/game/terrain/finish-airship';
import { GhostRider, createNameplate, disposeNameplate, NAMEPLATE_HEIGHT } from '@/game/terrain/ghost-rider';
import {
  createTerrainStyleStrategy,
  terrainStyleFromWorldStyle,
  type RiderSignals,
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
  /** Route distance (m) the ride starts at (welcome-screen start window). */
  startDistanceM?: number;
  /** Enable real-time day/night cycle based on route location (default: true). */
  dayNightEnabled?: boolean;
  /** World visual style — 'plastic' (blocks) or 'cuphead' (paper). Default: plastic. */
  worldStyle?: WorldStyle;
  /**
   * The rider's per-world option values (config.map.worldOptions) — sparse, so
   * anything absent falls back to the world's declared default. Kept for the
   * lifetime of the renderer and re-applied on a world-style switch, since a
   * switch builds a brand-new strategy with brand-new default params.
   */
  worldOptions?: WorldOptionsConfig;
  /** User's graphics-quality setting (config.map.graphicsQuality). 'auto' hands
   *  the tier to the runtime governor; a fixed tier pins it. Default 'auto'. */
  graphicsQuality?: 'auto' | 'low' | 'medium' | 'high';
  /** Last tier the governor settled on (config.map.resolvedQualityTier) — the
   *  warm-start seed for 'auto'. Ignored when graphicsQuality is a fixed tier. */
  resolvedQualityTier?: QualityTier;
  /**
   * Which shelf this ride's shop signs draw their words from: `'shop'` for a
   * free ride, `'training'` when the ride has prescribed segments.
   *
   * Passed straight to `TerrainChunkManager` and from there to every chunk's
   * building pass. Not a world option and not a quality knob — a fact about the
   * RIDE, which is why it is neither on `strategy.params` nor in the tier
   * preset. Default `'shop'`.
   */
  signVocabulary?: SignVocabulary;
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
  /** Rider's sparse per-world option values — see TerrainRendererOptions. */
  let currentWorldOptions: WorldOptionsConfig | undefined;

  // Scene objects
  let routeLine: THREE.Group | null = null;
  /** Route points kept for route-line rebuilds on style switches. */
  let routePointsRef: RoutePoint[] = [];
  let coinPool: CoinPool | null = null;
  let checkpointFlags: CheckpointFlagManager | null = null;
  /** Route distance the ride starts at (welcome start window) — from init(). */
  let rideStartDistanceM = 0;
  /** Last chunk the guide-line draw window was computed for. */
  let lastRouteWindowChunk = -1;
  /** Themed aircraft hovering over the route's finish, carrying the "remaining
   *  km · min" banner. Punches through weather fog (fog:false) as a finish beacon. */
  let finishAirship: FinishAirshipManager | null = null;

  // ── Ghost rider (P8 幽靈車) ──
  /** 半透明的過去自己 + 名牌;setGhostInfo(label) 啟用,updateGhost 每幀定位。 */
  let ghostRider: GhostRider | null = null;
  /** 玩家名牌 — 只在幽靈模式啟動時出現(防搞混,開發者指定)。 */
  let playerNameplate: THREE.Sprite | null = null;
  const ghostPositionVec = new THREE.Vector3();

  /**
   * The rider's live signals, as last pushed by the game loop.
   *
   * Held rather than pulled, for the same reason `lastZone` / `lastBearing` are:
   * this file must not reach into a Pinia store (it renders, it does not read
   * game state), and the values are step signals from the server that change at
   * 1–20 Hz while the frame runs at 60. `null` all round until the first push,
   * which is also the honest state of a rig with no sensors on it.
   */
  let riderSignals: RiderSignals = { cadenceRpm: null, powerW: null, powerSource: null };

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
  /** The acrylic display case over the whole diorama (DEVPLAN「壓克力罩天空」).
   *  Rider switch × quality tier; see `acrylic-case.ts`. */
  let acrylicCase: AcrylicCase | null = null;
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
  // Perf probe: accumulate frame times and dump renderer.info once a second so
  // we can tell "load is slow" (chunk build timing) from "runtime stutters"
  // (draw calls / triangles / fps). Only active when debug logging is on.
  let _perfAccumMs = 0;
  let _perfFrames = 0;
  /** Every frame's wall time inside the current 1-second window.
   *
   *  The average alone is the wrong statistic for the machine we actually ship
   *  to. An N100 does not run slow — it runs fine and then drops one 120 ms
   *  frame when a chunk lands, and a mean over 60 frames buries that entirely
   *  (one 120 ms frame among 59 good ones moves the mean by 1.4 ms). What the
   *  rider feels is the tail, so record the tail: p50/p95/max plus a straight
   *  count of frames over 50 ms. A second with avg 16 and max 130 is a
   *  completely different bug from one with avg 30 and max 34. */
  let _perfSamples: number[] = [];
  /** Geometry-pipeline revision marker — logged at init so a debug jsonl
   *  proves which build produced it. Bump on pipeline-visible changes. */
  const PIPELINE_REV = '2026-07-26-n-phaser-roads';
  /** One-shot scene inventory dump ~20s into the ride (debug only). */
  let _inventoryDumped = false;
  let _inventoryAccumMs = 0;
  /** Debug click-to-identify: raycast whatever the user clicks and log its
   *  name — ends "what is that thing in the sky" arguments in one click. */
  let _clickIdentify: ((ev: MouseEvent) => void) | null = null;
  let _hoverIdentify: ((ev: PointerEvent) => void) | null = null;
  let _hoverPending = false;
  let probeAt: (clientX: number, clientY: number) => ProbeHit[] = () => [];

  /** One thing the probe ray passed through, described in plain terms. */
  interface ProbeHit {
    name: string;
    mat?: string;
    colour?: string;
    dist: number;
    point: [number, number, number];
    /** >0 = floating above the terrain under it. null = no terrain there. */
    aboveGround: number | null;
    /** True = we are looking at the UNDERSIDE of this face. */
    backface?: boolean;
  }

  /** Debug: hold the camera still so the cursor can catch small artefacts. */
  const freezeCamera = ref(false);

  /** Debug: skip the whole post-processing chain and draw the scene directly. */
  const bypassPost = ref(false);

  /**
   * Hover highlight — the single TRIANGLE under the cursor, drawn bright and
   * on top of everything.
   *
   * Lighting up the whole hit object would just flood the screen with hillside:
   * the terrain, roads and buildings are each ONE merged mesh per chunk, so
   * "it's chunk3/road" does not say WHICH bit of chunk3/road. Highlighting the
   * face the ray actually crossed does — if the mystery black line lights up,
   * it is that triangle, and nothing is left to interpret.
   */
  let _hlMesh: THREE.Mesh | null = null;
  let _hlRaw: THREE.Intersection | null = null;

  /** Hover inspector — point at a thing and it tells you what it is. */
  const inspectorOn = ref(false);
  const inspectorHits = ref<ProbeHit[]>([]);
  const inspectorPos = ref({ x: 0, y: 0 });
  let _clickCanvas: HTMLCanvasElement | null = null;
  /** Main-thread ms spent inside render() this second — the CPU side of the
   *  frame. avgFrameMs far above avgJsMs ⇒ the GPU (or compositor) is the wall. */
  let _perfJsAccumMs = 0;
  /** Real GPU time. Null until the renderer exists; see gpu-timer.ts. */
  let _gpuTimer: GpuTimer | null = null;
  /**
   * End of the previous frame's `render()`. The gap from here to the next
   * `render()` is everything the perf probe used to be BLIND to: the rest of the
   * game loop, Vue's re-render of the HUD, GC, other tasks — and the wait for
   * vsync / the GPU.
   *
   * That blind spot mattered: a 36-minute N100 log showed 64 ms frames of which
   * only 7 ms were inside `render()`, and nothing in the record could say where
   * the other 57 ms went. Frame time there had ZERO correlation with triangles
   * (r = −0.02), so it was neither our geometry nor our submission — but the
   * probe could not tell "the GPU is busy" from "something else on the main
   * thread is". Splitting the frame in two is the cheapest way to find out.
   */
  let _perfLastFrameEnd = 0;
  let _perfOutsideAccumMs = 0;
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
  /** False until the first successful ground probe (seeds layer preference). */
  let hasGroundFix = false;

  // ── Graphics-quality tier ──
  /** Active tier + its preset. Resolved at init; re-applied on governor changes.
   *  Defaults keep updateCamera's sightline params valid before init completes. */
  let currentTier: QualityTier = 'medium';
  let currentPreset: QualityParams = QUALITY_PRESETS.medium;
  /** Low tier → tint-only glasses; also gates the per-frame lens-mark spawning. */
  let glassesSimplified = false;
  /** Bloom is currently force-disabled for BOTH world styles: this flag must be
   *  flipped to true before the tier preset's bloomEnabled has any effect (it is
   *  ANDed with the preset, so today the AND is always false). */
  const styleBloomEnabled = false;
  // Sightline ground-clamp throttling (see updateCamera): recompute the raycasts
  // every `sightlineFrameInterval` frames and reuse the last lift/tilt between.
  let sightlineFrameCounter = 0;
  let lastClampLift = 0;
  let lastClampTilt = 0;

  // Player lights
  let headlight: THREE.SpotLight | null = null;
  let headlightTarget: THREE.Object3D | null = null;
  let groundFill: THREE.SpotLight | null = null;
  let groundFillTarget: THREE.Object3D | null = null;
  let ambientGlow: THREE.PointLight | null = null;
  let lastBearing = 0;

  /**
   * Resolve the tier to start at: an explicit setting wins; else the persisted
   * governor result; else a device-hint guess.
   */
  function resolveInitialTier(
    quality: TerrainRendererOptions['graphicsQuality'],
    resolved: QualityTier | undefined,
  ): QualityTier {
    if (quality && quality !== 'auto') return quality;
    if (resolved) return resolved;
    return guessInitialTier();
  }

  /**
   * Lay the rider's per-world options over a fresh strategy's default params.
   *
   * WORLD_OPTIONS keys are StyleParams field names (enforced at compile time —
   * see the assertion in terrain-style-strategy.ts), so applying is a plain
   * overlay; `resolveWorldOptions` has already filled in every default and
   * discarded anything stored under a key or type this build no longer knows.
   *
   * ORDER MATTERS: this runs BEFORE applyGeometryPreset, because the quality
   * tier ANDs its own flags onto ink/bump. A rider asking for outlines on a
   * machine that can't afford them still gets the tier's answer (perf floor
   * wins), while a rider who turned them OFF stays off either way.
   *
   * Both callers run this on a brand-new strategy, before the first chunk is
   * built, so nothing here needs a rebuild of its own.
   */
  function applyWorldOptions(strat: TerrainStyleStrategy, style: WorldStyle): void {
    const values = resolveWorldOptions(style, currentWorldOptions);
    const params = strat.params as unknown as Record<string, WorldOptionValue>;
    for (const key of Object.keys(values)) params[key] = values[key];
  }

  /**
   * Apply a tier's GEOMETRY params onto a strategy's params — takes effect on the
   * NEXT terrain build, never forces a rebuild. gridSize is multiplied in place
   * so StyleTuningPanel's debug rebuild keeps working on top of the multiplied
   * value; ink/bump toggles AND with the style default (plastic unaffected).
   * Called once per fresh strategy (init + world-style switch), so the multiply
   * never compounds.
   */
  function applyGeometryPreset(strat: TerrainStyleStrategy, p: QualityParams): void {
    strat.params.gridSize *= p.gridSizeMultiplier;
    strat.params.inkEnabled = strat.params.inkEnabled && p.paperOutlineEnabled;
    strat.params.bumpEnabled = strat.params.bumpEnabled && p.paperBumpEnabled;
    setMaxBuildingsPerChunk(p.maxBuildingsPerChunk);
  }

  /** Re-run the canvas resize path (renderer + glasses + style composer) so the
   *  post-processing targets pick up a new pixel ratio. */
  function runResize(): void {
    if (!gameRenderer) return;
    const el = gameRenderer.renderer.domElement;
    const w = el.clientWidth;
    const h = el.clientHeight;
    gameRenderer.resize(w, h);
    glassesEffect?.resize(w, h);
    if (postComposer) {
      postComposer.setSize(w, h);
      const res = stylePass?.uniforms['uResolution'];
      if (res) res.value.set(w, h);
    }
  }

  /** Glasses bloom = the style's desire ANDed with the tier (low forces it off).
   *  Nothing to do with the scene bloom — see `applySceneBloomStrength`. */
  function applyBloom(): void {
    glassesEffect?.setBloomEnabled(styleBloomEnabled && currentPreset.bloomEnabled);
  }

  /**
   * Day/night gate for the demos' SCENE bloom.
   *
   * DEVPLAN gives the toy world a weak, NIGHT-ONLY glow, so `lit` (the same
   * dusk smoothstep the building windows fade on) is the whole envelope. At
   * strength 0 the pass switches itself off and the composer skips it entirely,
   * which is why a daytime ride pays nothing at all for this being installed.
   *
   * The tier's ceiling is applied separately, in `applySceneBloomLevel`. Both
   * have to hold: rider intent ∧ tier ∧ night.
   */
  const SCENE_BLOOM_NIGHT_STRENGTH = 0.5;
  function applySceneBloomStrength(lit: number): void {
    if (isSceneBloomPass(stylePass)) {
      stylePass.setStrength(lit * SCENE_BLOOM_NIGHT_STRENGTH);
    }
  }

  /** Push the tier's scene-bloom ceiling into the live pass. `off` frees its
   *  render targets, which is the point on the machine the governor rescued. */
  function applySceneBloomLevel(): void {
    if (isSceneBloomPass(stylePass)) stylePass.setLevel(currentPreset.sceneBloom);
  }

  /**
   * Re-apply every RUNTIME-applicable tier param: pixel ratio (+resize), glasses
   * simplification, bloom, weather/ambient particles, clouds, lamp lights, and
   * far-chunk LOD. Geometry params (grid size, paper bump/outline) are NOT
   * touched here — they only bind at the next terrain build, and a mid-ride full
   * rebuild is a worse hitch than staying at the old grid (the far-chunk LOD
   * handles new chunks). Sightline sample count/cadence are read live from
   * currentPreset in updateCamera.
   */
  function applyQualityTier(tier: QualityTier): void {
    currentTier = tier;
    currentPreset = QUALITY_PRESETS[tier];
    const p = currentPreset;

    gameRenderer?.setPixelRatio(p.pixelRatio);
    runResize();

    glassesSimplified = !p.glassesFullFx;
    glassesEffect?.setSimplified(glassesSimplified);
    applyBloom();

    // The two heavy full-screen effects. THE TIER WINS: the rider's per-world
    // switches are intent, and these two lines are where the fps governor gets
    // to overrule them mid-ride. Neither rebuilds anything — the case flips
    // `visible`, the bloom pass flips `enabled` and frees its targets — so the
    // governor can act the moment it decides, without a hitch of its own.
    acrylicCase?.setLevel(p.acrylicCase);
    applySceneBloomLevel();
    // Same deal, and it rebuilds nothing either: the map is freed and three
    // re-allocates it at the new size on the next frame.
    gameRenderer?.setShadowLevel(p.sunShadow);

    skyAndFog?.setParticleCounts(p.rainParticleCount, p.snowParticleCount);
    skyAndFog?.setAmbientParticlesEnabled(p.dustEnabled, p.leavesEnabled);
    skyAndFog?.setCloudBudget(p.cloudCount);

    streetLamps?.setLightBudget(p.maxLiveLampLights);

    chunkManager?.setLodEnabled(p.farChunkLod);
    // Like the other geometry knobs, only chunks built from here on obey the
    // new budget — resident chunks keep their extrusions.
    setMaxBuildingsPerChunk(p.maxBuildingsPerChunk);
  }

  /**
   * Initialize the terrain renderer.
   * Call once when the canvas and route data are ready.
   */
  async function init(options: TerrainRendererOptions): Promise<void> {
    const { canvas, points, weather, enableGlasses = true, worldStyle = 'plastic' } = options;
    if (options.cameraOptions) {
      cameraOptions = options.cameraOptions;
    }

    // Resolve the graphics-quality tier up front — geometry params (grid size,
    // paper bump/outline) and the far-chunk-LOD flag must be settled before the
    // first terrain build.
    currentTier = resolveInitialTier(options.graphicsQuality, options.resolvedQualityTier);
    currentPreset = QUALITY_PRESETS[currentTier];

    rideStartDistanceM = options.startDistanceM ?? 0;

    // Game renderer (standalone WebGL)
    gameRenderer = new GameRenderer({ canvas });
    _gpuTimer = new GpuTimer(gameRenderer.renderer);

    // Debug click-to-identify (debug mode only): click any pixel → raycast →
    // the hit objects' NAMES land in the debug log. Diagnostic tool for the
    // "mystery lines in the sky" class of report.
    _clickCanvas = canvas;

    const ensureHighlight = (): THREE.Mesh | null => {
      if (_hlMesh || !gameRenderer) return _hlMesh;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff2fd0,
        side: THREE.DoubleSide,
        // Draw THROUGH everything: half the point is finding geometry that is
        // buried inside the hillside.
        depthTest: false,
        // Fully opaque — a translucent magenta over a black line reads as dark
        // magenta, which is exactly the ambiguity we are trying to remove.
        transparent: false,
        fog: false,
      });
      _hlMesh = new THREE.Mesh(geo, mat);
      _hlMesh.name = 'debug/hoverHighlight';
      _hlMesh.renderOrder = 99999;
      _hlMesh.frustumCulled = false;
      // Never let the probe hit its own highlight.
      _hlMesh.raycast = () => {};
      gameRenderer.scene.add(_hlMesh);
      return _hlMesh;
    };

    /** Copy the hit face's three world-space corners into the highlight. */
    const showHighlight = (hit: THREE.Intersection | null): void => {
      const mesh = ensureHighlight();
      if (!mesh) return;
      const face = hit?.face;
      const src = hit?.object as THREE.Mesh | undefined;
      const pos = src?.geometry?.getAttribute?.('position');
      if (!hit || !face || !pos) {
        mesh.visible = false;
        return;
      }
      const out = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const corners = [face.a, face.b, face.c];
      const world: THREE.Vector3[] = [];
      for (let i = 0; i < 3; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(pos as THREE.BufferAttribute, corners[i]);
        // Instanced meshes need their instance transform too; matrixWorld alone
        // would put the highlight on the prototype, not the instance.
        const inst = src as unknown as THREE.InstancedMesh;
        if (inst.isInstancedMesh && hit.instanceId !== undefined) {
          const m = new THREE.Matrix4();
          inst.getMatrixAt(hit.instanceId, m);
          v.applyMatrix4(m);
        }
        v.applyMatrix4(src!.matrixWorld);
        world.push(v);
      }

      // GROW it. The whole problem is that the thing being hunted is a sliver
      // one pixel wide — highlighting it exactly just swaps a one-pixel black
      // line for a one-pixel magenta one, which is no easier to see. Push each
      // corner away from the centroid by an absolute margin so a hair-thin
      // triangle becomes a patch you cannot miss, scaled with distance so it
      // stays visible at the far end of the valley too.
      const centroid = new THREE.Vector3()
        .add(world[0]).add(world[1]).add(world[2]).multiplyScalar(1 / 3);
      const margin = Math.max(1.2, hit.distance * 0.012);
      const dir = new THREE.Vector3();
      for (let i = 0; i < 3; i++) {
        dir.subVectors(world[i], centroid);
        const len = dir.length();
        // Degenerate corner (zero-area sliver): shove it out in ANY direction
        // rather than leaving it collapsed on the centroid.
        if (len < 1e-6) dir.set(i === 0 ? margin : 0, i === 1 ? margin : 0, i === 2 ? margin : 0);
        else dir.multiplyScalar((len + margin) / len);
        out.setXYZ(i, centroid.x + dir.x, centroid.y + dir.y, centroid.z + dir.z);
      }
      out.needsUpdate = true;
      mesh.geometry.computeBoundingSphere();
      mesh.visible = true;
    };

    // Hover inspector: point at a thing, read what it is. Same probe as the
    // click identify below, but continuous — sweeping the cursor along a
    // mystery line and watching the name change is by far the fastest way to
    // find out what it is.
    _hoverIdentify = (ev: PointerEvent) => {
      if (!inspectorOn.value || !gameRenderer) {
        if (_hlMesh) _hlMesh.visible = false;
        return;
      }
      inspectorPos.value = { x: ev.clientX, y: ev.clientY };
      // One probe per frame at most — a pointermove burst must not raycast the
      // whole scene a dozen times between paints.
      if (_hoverPending) return;
      _hoverPending = true;
      requestAnimationFrame(() => {
        _hoverPending = false;
        if (!gameRenderer) return;
        inspectorHits.value = probeAt(ev.clientX, ev.clientY);
        showHighlight(_hlRaw);
      });
    };
    window.addEventListener('pointermove', _hoverIdentify, true);

    /**
     * Raycast the scene at a screen point and describe everything the ray
     * passes through. Shared by the click identify and the hover inspector so
     * the two can never disagree about what is under the cursor.
     */
    probeAt = (clientX: number, clientY: number): ProbeHit[] => {
      if (!gameRenderer) return [];
      // NDC from the canvas rect — the listener sits on window (capture phase)
      // because the glasses-frame overlay swallows events aimed at the canvas.
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      // A stray black line is often one pixel wide, and an exact ray through
      // the click point misses it more often than not. Fan the probe over a
      // 3x3 grid of +/-3px so a sliver is actually hittable, then merge.
      const ray = new THREE.Raycaster();
      const px = (3 / rect.width) * 2;
      const py = (3 / rect.height) * 2;
      const seen = new Set<string>();
      const hits: THREE.Intersection[] = [];
      for (const dx of [-px, 0, px]) {
        for (const dy of [-py, 0, py]) {
          ray.setFromCamera(new THREE.Vector2(ndc.x + dx, ndc.y + dy), gameRenderer.camera);
          for (const h of ray.intersectObjects(gameRenderer.scene.children, true)) {
            const key = `${h.object.uuid}:${Math.round(h.distance)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            hits.push(h);
          }
        }
      }
      hits.sort((a, b) => a.distance - b.distance);
      _hlRaw = hits[0] ?? null;

      // The question every one of these reports comes down to is "is this thing
      // ABOVE the ground, and if so by how much" — so answer it here rather
      // than making someone cross-reference coordinates by hand afterwards.
      const described: ProbeHit[] = hits.slice(0, 10).map((h) => {
        const mat = (h.object as THREE.Mesh).material as THREE.Material | undefined;
        const colour = (mat as THREE.MeshBasicMaterial | undefined)?.color;
        const ground = chunkManager?.raycastGroundHeight(h.point.x, h.point.z) ?? null;
        return {
          name: h.object.name || `<unnamed ${h.object.type}>`,
          mat: mat?.type,
          // Is it actually black, or is it a dark thing we only think is black?
          colour: colour ? `#${colour.getHexString()}` : undefined,
          dist: Math.round(h.distance),
          point: [Math.round(h.point.x), Math.round(h.point.y), Math.round(h.point.z)] as [number, number, number],
          // >0 means it floats above the terrain surface under it.
          aboveGround: ground === null ? null : +(h.point.y - ground).toFixed(2),
          // A back face means we are seeing the UNDERSIDE of something.
          backface: h.face ? h.face.normal.dot(ray.ray.direction) > 0 : undefined,
        };
      });

      return described;
    };

    _clickIdentify = (ev: MouseEvent) => {
      if (!isDebugEnabled() || !gameRenderer) return;
      const described = probeAt(ev.clientX, ev.clientY);
      debugLog('terrain', 'click/identify', { hits: described });
      // Mirror to console so it's visible immediately during a live session.
      console.log('[click/identify]', described.map((h) =>
        `${h.name}${h.colour ? ` ${h.colour}` : ''} @${h.dist}m y=${h.point[1]}` +
        `${h.aboveGround === null ? '' : ` above-ground=${h.aboveGround}m`}${h.backface ? ' BACKFACE' : ''}`,
      ).join('\n  ') || 'no hit');
    };
    window.addEventListener('pointerdown', _clickIdentify, true);
    // The render loop resets info manually (autoReset would zero the counters
    // after every composer pass and blind the perf probe).
    gameRenderer.renderer.info.autoReset = false;

    // World-style strategy (materials + colours + geometry + post pass).
    currentWorldStyle = worldStyle;
    currentWorldOptions = options.worldOptions;
    loading.beginStage('style');
    strategy = await createTerrainStyleStrategy(terrainStyleFromWorldStyle(worldStyle));
    // Rider's per-world choices first, then the tier clamp on top (see
    // applyWorldOptions). Both bind at build time — before the first chunk.
    applyWorldOptions(strategy, worldStyle);
    applyGeometryPreset(strategy, currentPreset);
    // 陰影的法線偏移是**光源**的屬性,而三個 demo 在這一格上不一致(電子 1.2、
    // 另外兩個 1.5)。光比 strategy 早建,所以在這裡補推一次。
    gameRenderer?.setSunShadowNormalBias(strategy.shadowNormalBias);
    loading.completeStage('style');

    // Sky + day/night
    skyAndFog = new SkyAndFog(gameRenderer);
    skyAndFog.setDayNightEnabled(options.dayNightEnabled !== false);
    // A live read, not a value: originEle is resolved a few statements below
    // (async DEM query) and would be 0 if we passed it now. Reading the binding
    // per frame also means any future origin rebase reaches the cloud deck for
    // free — the deck is pinned to an ALTITUDE, so scene Y must track the origin.
    skyAndFog.setOriginElevationSource(() => originEle);
    // The sky gradient and every light come from the world style's palette.
    skyAndFog.setPalette(strategy.skyPalette);
    // So do the sun/moon discs (falls back to the sprite moon when absent).
    skyAndFog.setCelestialDiscBuilder(strategy.buildCelestialDisc?.bind(strategy) ?? null);
    // And the clouds' look (falls back to the billboard deck when absent).
    skyAndFog.setCloudBuilder(strategy.buildCloud?.bind(strategy) ?? null);
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

    // The acrylic case standing on that desk. Built AFTER applyWorldOptions has
    // written the rider's switch onto `strategy.params`, because that is where
    // it reads its own intent from; the tier level is handed in separately so
    // the ceiling is visible at the call site.
    acrylicCase = new AcrylicCase(gameRenderer.scene, strategy, currentPreset.acrylicCase);
    if (weather) acrylicCase.setRaining(weather.type === 'rainy');

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
      { style: strategy.routeLine, body: strategy.buildRouteBody?.bind(strategy) },
    );
    gameRenderer.scene.add(routeLine);
    chunkManager = new TerrainChunkManager({
      scene: gameRenderer.scene,
      points,
      sampler,
      mvtFetcher,
      corridorHalfWidth: options.corridorHalfWidth,
      startDistanceM: options.startDistanceM,
      strategy,
      farChunkLod: currentPreset.farChunkLod,
      // 訓練騎乘的店面招牌改喊激勵詞。綁在 chunk manager 上而不是 strategy 上:
      // 換世界會換掉整個 strategy(連 params 一起),chunk manager 不會。
      signVocabulary: options.signVocabulary ?? 'shop',
      onChunkLoaded: (chunkIndex: number) => {
        // Loading progress counts the preloaded chunks only (the ones the
        // overlay is waiting on), and counts each once: this fires twice per
        // chunk — on entering the scene, then again when its drop-in lands.
        // Preload centres on the start chunk (start window), so membership is
        // a set test, not an index-range test.
        if (chunkManager?.isPreloadChunk(chunkIndex) && !loadedChunks.has(chunkIndex)) {
          loadedChunks.add(chunkIndex);
          loading.setStageProgress('chunks', loadedChunks.size, chunkManager.preloadCount);
        }

        // Project the route line onto newly loaded terrain so it follows the
        // surface — but ONLY the point range this chunk covers. Raycasting is
        // O(triangles); projecting the whole route on every chunk load was the
        // main streaming hitch. Points outside the range keep their prior Y.
        if (routeLine && chunkManager) {
          const range = chunkManager.getChunkPointRange(chunkIndex) ?? undefined;
          projectRouteLineOntoTerrain(
            routeLine,
            (x, z, gpsY) => chunkManager!.raycastGroundHeight(x, z, gpsY),
            undefined,
            range,
          );
        }
      },
      onChunkFailed: (chunkIndex: number) => {
        // A background preload chunk failed. Count it toward the 'chunks' stage
        // (loaded OR failed = accounted) so the bar reaches 100% / 載入完成 shows
        // even with a hole — the same slot onChunkLoaded would have filled.
        if (chunkManager?.isPreloadChunk(chunkIndex) && !loadedChunks.has(chunkIndex)) {
          loadedChunks.add(chunkIndex);
          loading.setStageProgress('chunks', loadedChunks.size, chunkManager.preloadCount);
        }
      },
    });
    chunkManager.setOrigin(originLat, originLon, originEle);

    // Roadside lamps — a recycled pool that slides along the route with the
    // rider, so long routes cost no more than short ones.
    if (points.length > 1) {
      const routeCumDists = buildCumulativeDistances(points);
      streetLamps = new StreetLampManager(
        gameRenderer.scene,
        strategy,
        points,
        routeCumDists,
        originLat,
        originLon,
      );

      // Finish airship — floats over the *predicted* end of the ride (server's
      // finishTarget), clamped to a max lead ahead of the rider. Position is fed
      // per frame by updateFinishTarget(); it stays hidden until the first one.
      finishAirship = new FinishAirshipManager(gameRenderer.scene, strategy);
      finishAirship.spawn(points, routeCumDists, originLon, originLat, originEle);
    }

    // Start preloading chunks. Still non-blocking for init() — but the promise
    // is kept rather than dropped, so the loading overlay can wait on the real
    // "there is a world now" moment instead of guessing.
    loading.beginStage('chunks');
    loading.setStageProgress('chunks', 0, chunkManager.preloadCount);
    // preload() now resolves as soon as the current + next chunk are in the scene
    // (the gate the loading overlay waits on); the remaining preload chunks keep
    // building in the background and drive the 'chunks' stage to 100% via the
    // onChunkLoaded callback above — so we deliberately DON'T completeStage here
    // (that would jump the bar to full at 2/N and then setStageProgress would
    // regress it as the rest land).
    terrainReady = chunkManager.preload().then(
      () => {
        // Gate reached — there is a world to look at. Bar keeps filling behind it.
      },
      () => {
        // Terrain preload failure is non-fatal — ball runs on route line
        loading.failStage('chunks', '地形載入失敗，將沿路線飛行');
      },
    );

    // Handle resize
    const resizeObserver = new ResizeObserver(() => runResize());
    resizeObserver.observe(canvas);

    // Apply the resolved tier's runtime params now that every system exists
    // (pixel ratio + resize, glasses, bloom, particles, clouds, lamps, LOD). The
    // geometry params were already baked into the strategy above.
    applyQualityTier(currentTier);

    if (isDebugEnabled()) {
      debugLog('terrain', 'Terrain renderer initialized', {
        points: points.length,
        origin: { lat: originLat, lon: originLon, ele: originEle },
        corridorHalfWidth: options.corridorHalfWidth,
        dayNight: options.dayNightEnabled !== false,
        // Bump when render-pipeline geometry changes — proves which code a
        // debug log actually ran (stale-HMR sessions burned a whole afternoon).
        pipelineRev: PIPELINE_REV,
      });
    }

    isReady.value = true;
  }

  /**
   * 「撞到裙邊就爬上踏面」的決策與常數住在 `climb-onto-tread.ts`(那裡有量到的
   * 數字與它治不到什麼)。這裡只剩下這一層外殼做它做得到的事:問地面。
   */
  function climbOntoTread(x: number, z: number, axleY: number, preferY: number): number {
    if (!chunkManager || !strategy?.params.quantEnabled) return axleY;
    const nose = noseProbePoint(x, z, lastBearing);
    return climbTread(
      axleY,
      chunkManager.raycastGroundHeight(nose.x, nose.z, preferY),
      strategy.params.layerHeight,
    );
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

    // Raycast against terrain mesh for precise ground height. The preferred
    // height disambiguates stacked switchback layers (stay on the deck you're
    // on); before the first ground hit, the GPS altitude seeds it so a
    // start-window launch onto a climb picks the right layer immediately.
    // Falls back to last valid raycast height or async DEM query.
    const preferY = hasGroundFix ? lastValidGroundY : altitude - originEle;
    const surfaceY = chunkManager?.raycastGroundHeight(x, z, preferY) ?? null;
    if (surfaceY !== null) {
      // `lastValidGroundY` stays the AXLE's ground, not the climbed height —
      // it is next frame's `preferY`, i.e. the answer to "which stacked layer
      // is the rider on", and biasing it upward every time the bike crests a
      // step would walk it off the deck it is actually riding.
      lastValidGroundY = surfaceY;
      hasGroundFix = true;
      riderPosition.set(x, climbOntoTread(x, z, surfaceY, preferY), z);
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

      // Far coins: hide and skip the bob/spin + ground raycast (specks at range).
      const ddx = cx - riderPosition.x;
      const ddz = cz - riderPosition.z;
      if (ddx * ddx + ddz * ddz > COIN_CULL_DIST_SQ) {
        if (coin.mesh.visible) coin.mesh.visible = false;
        continue;
      }
      if (!coin.mesh.visible) coin.mesh.visible = true;

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

    // Debug freeze: hold the camera exactly where it is while the world keeps
    // rendering. Pointing the mouse at a 1-pixel artefact is hopeless while the
    // view is moving, and pausing the GAME does not help because the camera
    // keeps easing toward its target afterwards.
    if (freezeCamera.value) return;

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
      // Sample count + cadence come from the quality tier: recompute the sightline
      // raycasts (the costly part) only every `sightlineFrameInterval` frames and
      // reuse the last lift/tilt on the skipped ones. The lift is an absolute
      // offset re-applied on top of the freshly-set base camera Y each frame, so
      // re-adding the cached value between recomputes is correct.
      const samples = currentPreset.sightlineSamples;
      if (++sightlineFrameCounter >= currentPreset.sightlineFrameInterval) {
        sightlineFrameCounter = 0;
        _sightline.length = 0;
        for (let i = 1; i <= samples; i++) {
          const t = i / samples; // 0 = bike, 1 = camera
          _sightline.push({
            t,
            groundY: chunkManager.raycastGroundHeight(
              riderPosition.x + (camera.position.x - riderPosition.x) * t,
              riderPosition.z + (camera.position.z - riderPosition.z) * t,
            ),
          });
        }
        lastClampLift = groundClamp.update(
          riderPosition.y,
          camera.position.y,
          CHASE_LOOK_HEIGHT,
          _sightline,
          dt,
          // The clouds are the ceiling. Handed over as a plain number so the
          // collision maths stays Three-free and headless-testable; null while
          // the deck is off (nothing up there to hit). Re-read every recompute
          // — the deck is pinned to an ALTITUDE, so its scene Y moves with the
          // weather and with every floating-origin rebase.
          skyAndFog?.cameraCeilingSceneY(camera.position.y) ?? null,
        );
        lastClampTilt = groundClamp.tilt;
      }
      camera.position.y += lastClampLift;
      clampTilt = lastClampTilt;
    } else {
      groundClamp.reset();
      lastClampLift = 0;
      lastClampTilt = 0;
      // Force a recompute on the first clamped frame after the airborne branch,
      // regardless of the tier's frame interval — otherwise the first frame back
      // on the ground would reuse the stale (zeroed) lift/tilt for up to N frames.
      sightlineFrameCounter = Number.MAX_SAFE_INTEGER;
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
    const _renderT0 = performance.now();
    // 同一個 _renderT0 —— avgOutsideMs 的邊界與拆帳的邊界必須是同一刀,
    // 否則兩組數字對不起來。
    phaseRenderStart(_renderT0);
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

    // The bike, the horizon, and the lamps all track the rider. The cranks turn
    // at the MEASURED cadence when there is one — see `BikeOrnament.update`.
    bike?.update(riderPosition, lastBearing, smoothedSpeedMps, dt, riderSignals.cadenceRpm);

    // 玩家名牌(幽靈模式限定)— 跟著騎士,不掛在車體上(root 不外露)。
    if (playerNameplate?.visible) {
      playerNameplate.position.set(
        riderPosition.x,
        riderPosition.y + NAMEPLATE_HEIGHT,
        riderPosition.z,
      );
    }
    mountainRing?.update(riderPosition);
    // The case rides with the rider exactly like the ring and the sky do — it
    // is a fixed object the world moves under, not scenery that scrolls past.
    acrylicCase?.update(riderPosition, dt);
    // And so does the sun's shadow box — 「燈光(跟著騎手,不然騎出陰影相機範圍)」.
    // After skyAndFog.update() above, which is what sets the light's direction.
    gameRenderer.updateShadowAnchor(riderPosition);
    const nightFactor = 1 - (skyAndFog?.celestial?.dayFactor ?? 1);
    // In a tunnel the lamps go dense and stay lit — that IS the tunnel (we draw
    // no bore). Zone comes from updateDistance()'s 50 m re-check.
    streetLamps?.update(
      riderDistanceM,
      nightFactor,
      (x, z) => chunkManager?.raycastGroundHeight(x, z),
      lastZone === 'tunnel',
    );

    // Night lights — fade in through dusk (smoothstep 0.25→0.6). ONE write
    // drives every world's night: the eraser's plastic film, a capacitor's
    // crimp groove, the abacus's lit bead colour, the DIP's pin-root windows,
    // and the toy tower's slab-face light film all ride this. A style registers
    // its materials once at construction and never touches the frame loop.
    const lit = Math.max(0, Math.min(1, (nightFactor - 0.25) / 0.35));
    setNightLitFactor(lit);
    // The case cools and thins after dark (never thickens — it would smother
    // the lamps under it), and the scene bloom exists only at night.
    acrylicCase?.setNight(nightFactor);
    applySceneBloomStrength(lit);

    // The rider's legs, handed to whichever world asked for them. AFTER the night
    // write above, on purpose: a world may combine the two (circuit's spark level
    // is `wattGain × (0.34 + 0.5 × k)`) and must see THIS frame's k, not the
    // previous one's. Worlds that do not declare the hook are not called at all.
    strategy?.updateRiderSignals?.(riderSignals, dt);

    // The route line is a static mark on the road (highlighter / neon tape) —
    // nothing to animate. elapsedTime still drives the coin bob.
    elapsedTime += dt;

    // Finish airship — bob + distance-compensated scale + theme animation.
    finishAirship?.update(dt, elapsedTime, gameRenderer.camera.position);

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

    // Probabilistic lens mark spawning based on weather. Skipped entirely on the
    // simplified (low-tier) glasses, which drop the lens-marks overlay anyway.
    if (glassesEffect && !glassesSimplified) {
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

    // Debug layer bisect: re-assert the hidden set EVERY FRAME while anything
    // is hidden. A 2 Hz poll from the panel loses to a 60 fps loop — chunk LOD,
    // the entrance animation and the streaming builder all write `visible`, so
    // a switch flipped between polls appeared not to work at all. Costs one
    // traverse of a few hundred objects, and only while a switch is actually
    // held down.
    if (anySceneLayerHidden()) applySceneLayerVisibility(gameRenderer.scene);

    // Update post-processing effects (coin glow fade etc.)
    glassesEffect?.update(dt);

    // Render. info.autoReset is off (each composer pass would otherwise reset
    // the counters, leaving only the final fullscreen quad — 1 call/1 triangle
    // in the perf probe); reset manually so the probe sees the WHOLE frame.
    gameRenderer.renderer.info.reset();
    // Wrap the WHOLE frame, composer passes included — the post chain is the
    // part everyone has been guessing about. Cheap when unsupported (one null
    // check) and it never blocks: results are polled, never waited on.
    _gpuTimer?.begin();
    if (bypassPost.value) {
      // Debug bypass: straight to the canvas, no composer, no passes. The
      // render-layer switches can only reach things that are IN the scene —
      // the glasses lens, the tunnel vignette, bloom and the paper pass all
      // draw full-screen AFTER it and are invisible to them. If an artefact
      // survives every layer being switched off, this is what tells you
      // whether it is drawn by the scene at all.
      gameRenderer.render();
    } else if (glassesEffect) {
      glassesEffect.render();
    } else if (postComposer) {
      // Glasses off but a world-style post pass is active — apply it standalone.
      postComposer.render();
    } else {
      gameRenderer.render();
    }
    _gpuTimer?.end();

    // One-shot scene inventory (debug only), ~20s in: every renderable's class,
    // bbox and height range — the definitive "which object is that thing in the
    // sky" answer, straight from the LIVE scene graph.
    if (isDebugEnabled() && !_inventoryDumped && dt > 0) {
      _inventoryAccumMs += dt * 1000;
      if (_inventoryAccumMs >= 20000) {
        _inventoryDumped = true;
        const rows: Record<string, unknown>[] = [];
        gameRenderer.scene.traverse((obj) => {
          const anyObj = obj as THREE.Mesh & { isInstancedMesh?: boolean; count?: number };
          if (!(anyObj as { isMesh?: boolean }).isMesh && !(anyObj as { isPoints?: boolean; isLine?: boolean }).isPoints && !(anyObj as { isLine?: boolean }).isLine) return;
          if (rows.length >= 500) return;
          const g = anyObj.geometry as THREE.BufferGeometry | undefined;
          if (!g?.getAttribute) return;
          if (!g.boundingBox) g.computeBoundingBox();
          const bb = g.boundingBox;
          if (!bb) return;
          const mat = anyObj.material as THREE.Material | THREE.Material[] | undefined;
          const matName = Array.isArray(mat) ? mat.map((m) => m.type).join('+') : mat?.type;
          rows.push({
            t: anyObj.type,
            n: anyObj.name || undefined,
            inst: anyObj.isInstancedMesh ? anyObj.count : undefined,
            vis: anyObj.visible && (anyObj.parent?.visible ?? true),
            mat: matName,
            verts: g.getAttribute('position')?.count ?? 0,
            // world offset + local bbox (chunks position at 0 — bbox ≈ world)
            pos: [Math.round(anyObj.position.x), Math.round(anyObj.position.y), Math.round(anyObj.position.z)],
            bb: [
              Math.round(bb.min.x), Math.round(bb.min.y), Math.round(bb.min.z),
              Math.round(bb.max.x), Math.round(bb.max.y), Math.round(bb.max.z),
            ],
          });
        });
        debugLog('terrain', 'scene/inventory', { objects: rows });
      }
    }

    // Perf probe (debug only): once a second, report fps + GPU submission cost.
    // High draw calls / triangles here = runtime bottleneck (fix with instancing
    // / geometry merging), NOT the chunk-build cost the loading bar covers.
    if (isDebugEnabled() && dt > 0) {
      _perfAccumMs += dt * 1000;
      _perfFrames++;
      _perfSamples.push(dt * 1000);
      _perfJsAccumMs += performance.now() - _renderT0;
      if (_perfLastFrameEnd > 0) _perfOutsideAccumMs += _renderT0 - _perfLastFrameEnd;
      if (_perfAccumMs >= 1000) {
        const info = gameRenderer.renderer.info.render;
        const mem = gameRenderer.renderer.info.memory;
        // Chrome-only heap probe — undefined elsewhere, logged as null
        const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        // `avgOutsideMs` 的拆帳(useFramePhases)。取出來要重設累加器,所以
        // 一定要在這裡取一次、只取一次。
        const phases = takeFramePhases();
        const outsidePerFrame = _perfOutsideAccumMs / _perfFrames;
        debugLog('terrain', 'perf/frame', {
          fps: Math.round((_perfFrames * 1000) / _perfAccumMs),
          drawCalls: info.calls,
          triangles: info.triangles,
          avgFrameMs: +(_perfAccumMs / _perfFrames).toFixed(1),
          avgJsMs: +(_perfJsAccumMs / _perfFrames).toFixed(1),
          // Everything that is NOT our render(): other main-thread work plus the
          // wait for vsync / the GPU. `avgJsMs` alone cannot tell a GPU-bound
          // frame from a main-thread-bound one; these two together can.
          avgOutsideMs: +(_perfOutsideAccumMs / _perfFrames).toFixed(1),
          // REAL GPU time, not inferred from the residual above. `avgOutsideMs`
          // also contains the Vue HUD, the SVG minimap, two more rAF loops and
          // GC — reading it as "the GPU" is what produced the fill-rate claim
          // that `plan/render-mechanism-comparison.md` disproved.
          // `gpuStatus` distinguishes "0 ms" from "nobody measured": null with
          // `unsupported` means the browser withheld the extension.
          ..._gpuTimer?.takeTimings() ?? { gpuStatus: 'unsupported' as const },
          // 上面那條殘差的拆帳。**先看 `pausedFrames`**:暫停中走的是
          // `useGameLoop` 的 15 fps 節流(`PAUSED_FRAME_MS`),frame time 會被
          // 量化成 4~5 個 vsync(66.7 / 83.3 ms),整段殘差是設計好的等待,
          // 不是工作 —— 沒有這個欄位的舊 log 把那些秒數讀成了效能崩潰。
          // 接著比 `avgPaintMs`(Vue flush + style/layout/paint,HUD 有沒有罪)
          // 與 `avgIdleMs`(vsync / compositor / GPU 回壓,主執行緒是不是閒的)。
          ...phases,
          // 五個桶加起來與 `avgOutsideMs` 的差額。不是 0 就代表還有沒量到的
          // 東西 —— 這個欄位存在的意義就是不讓殘差再變成一個沒人負責的黑箱。
          phaseUnaccountedMs: phases.avgPhaseSumMs === null
            ? null
            : +(outsidePerFrame - phases.avgPhaseSumMs).toFixed(2),
          // Sorted once per second over ~60 numbers — free, and it is the only
          // part of this record that can tell a hitch from a slowdown.
          ...(() => {
            const s2 = _perfSamples.slice().sort((a, b) => a - b);
            const at = (q: number) => +(s2[Math.min(s2.length - 1, Math.floor(q * s2.length))] ?? 0).toFixed(1);
            return {
              p50FrameMs: at(0.5),
              p95FrameMs: at(0.95),
              maxFrameMs: +(s2[s2.length - 1] ?? 0).toFixed(1),
              longFrames: s2.filter((v) => v > 50).length,
            };
          })(),
          tier: currentTier,
          // cuphead 的 paper pass 在 low tier 也不會關(一定回一個 pass),
          // plastic 會 —— 差一道滿版。少了這個欄位就沒辦法比對兩份 log。
          worldStyle: currentWorldStyle,
          pixelRatio: gameRenderer.renderer.getPixelRatio(),
          // Real framebuffer size — the fill-rate denominator (a 4K canvas is
          // 4× the pixels of 1080p at the same pixelRatio).
          canvas: `${gameRenderer.renderer.domElement.width}x${gameRenderer.renderer.domElement.height}`,
          geometries: mem.geometries,
          textures: mem.textures,
          jsHeapMB: heap ? Math.round(heap.usedJSHeapSize / 1048576) : null,
        });
        _perfAccumMs = 0;
        _perfFrames = 0;
        _perfJsAccumMs = 0;
        _perfOutsideAccumMs = 0;
        _perfSamples = [];
      }
      _perfLastFrameEnd = performance.now();
    }

    // 拆帳的收邊。放在 perf 區塊之後,所以 avgJsMs 與 avgPreMs/avgPostMs 的
    // 分界線跟 _renderT0 / _perfLastFrameEnd 是同一組。
    phaseRenderEnd();
  }

  /**
   * Update terrain chunk loading based on distance traveled.
   * Also performs zone detection for glasses ambient effects.
   */
  function updateDistance(distanceM: number): void {
    riderDistanceM = distanceM;
    if (!chunkManager) return;
    chunkManager.update(distanceM);

    // Guide line: draw only the near window (current chunk ±1). The full-route
    // ribbon's distant segments snake along far ridges as permanent dark lines
    // in the sky — same rule as the far-chunk overlay hiding.
    const curChunk = chunkManager.getCurrentChunkIndex();
    if (routeLine && curChunk !== lastRouteWindowChunk) {
      lastRouteWindowChunk = curChunk;
      let startIdx = Number.POSITIVE_INFINITY;
      let endIdx = -1;
      for (let c = curChunk - 1; c <= curChunk + 1; c++) {
        const r = chunkManager.getChunkPointRange(c);
        if (!r) continue;
        if (r.startIdx < startIdx) startIdx = r.startIdx;
        if (r.endIdx > endIdx) endIdx = r.endIdx;
      }
      setRouteLineWindow(routeLine, endIdx >= 0 ? { startIdx, endIdx } : null);
    }

    // Zone detection — re-check every ZONE_CHECK_INTERVAL_M meters
    if (Math.abs(distanceM - lastZoneDistance) >= ZONE_CHECK_INTERVAL_M || lastZoneDistance < 0) {
      lastZoneDistance = distanceM;
      const chunkIndex = chunkManager.getCurrentChunkIndex();
      const zoneFeatures = chunkManager.getChunkZoneFeatures(chunkIndex);
      if (zoneFeatures) {
        const zone = detectZone(currentBallLngLat[1], currentBallLngLat[0], zoneFeatures);
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
    // Rain beads the OUTSIDE of the case and pulls its tint colder. The world's
    // own rain inside is untouched — seeing both at once is what says there is
    // a case there at all.
    acrylicCase?.setRaining(config.type === 'rainy');
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
    // A freshly built scene bloom does not know the tier's ceiling yet. Seed it
    // here, before the pass can ever render at the wrong level. Strength needs
    // no seeding — the pass starts disabled and the render loop's
    // `applySceneBloomStrength` sets it on the first frame.
    applySceneBloomLevel();

    if (glassesEffect) {
      glassesEffect.setStylePass(stylePass);
    } else {
      postComposer = new EffectComposer(gameRenderer.renderer);
      postComposer.addPass(new RenderPass(gameRenderer.scene, gameRenderer.camera));
      postComposer.addPass(stylePass);
      // Tone mapping + sRGB — rendering into composer targets applies neither
      // (r152+), so without this the style pass reaches the screen linear and
      // the night palette crushes to black. Same fix as the glasses composer.
      postComposer.addPass(new OutputPass());
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
    // Fresh strategy → fresh default params. Re-lay the rider's options for the
    // world being switched TO (they are per-world, so this is a different set),
    // then re-bake the geometry-tier params (grid multiplier / ink / bump).
    applyWorldOptions(strategy, worldStyle);
    applyGeometryPreset(strategy, currentPreset);
    // 騎乘中換世界,偏移要跟著換 —— 它是個純 uniform,不重編譯任何材質。
    gameRenderer.setSunShadowNormalBias(strategy.shadowNormalBias);

    installStylePass();
    chunkManager.setStrategy(strategy);
    skyAndFog?.setPalette(strategy.skyPalette);
    skyAndFog?.setCelestialDiscBuilder(strategy.buildCelestialDisc?.bind(strategy) ?? null);
    skyAndFog?.setCloudBuilder(strategy.buildCloud?.bind(strategy) ?? null);

    // Diorama props are style-owned meshes — rebuild each one.
    bike?.setStrategy(strategy);
    mountainRing?.setStrategy(strategy);
    // Rebuilds from the new world's case data AND re-reads the rider's switch,
    // which is per-world: turning the case off in the toy world must not turn it
    // off in the corrugated one.
    acrylicCase?.setStrategy(strategy);
    streetLamps?.setStrategy(strategy);
    finishAirship?.setStrategy(strategy);
    ghostRider?.setStrategy(strategy);
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
        { style: strategy.routeLine, body: strategy.buildRouteBody?.bind(strategy) },
      );
      gameRenderer.scene.add(routeLine);
      // Snap onto whatever terrain is loaded; onChunkLoaded re-projects as the
      // rebuilt chunks stream in.
      projectRouteLineOntoTerrain(
        routeLine,
        (x, z, gpsY) => chunkManager!.raycastGroundHeight(x, z, gpsY),
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

  /**
   * Hand over the rider's live signals — cadence, watts, and whether the watts
   * were measured. Pure relay: stored as given and fanned out in `render()`, to
   * the bike's cranks and to the world style's `updateRiderSignals`. Nothing here
   * derives, smooths or thresholds anything (CLAUDE.md「前端只負責 render」).
   */
  function setRiderSignals(signals: RiderSignals): void {
    riderSignals = signals;
  }

  /** Add a mark to the lens (rain, snow, dust, coin, leaf). */
  function addLensMark(type: MarkType): void {
    glassesEffect?.marksManager.addMark(type);
  }

  /** Enable or disable billboard clouds. */
  function setCloudsEnabled(enabled: boolean): void {
    skyAndFog?.setCloudsEnabled(enabled);
  }

  /**
   * Set the cloud deck's base altitude (m MSL, from the weather-derived lifted
   * condensation level). null = unknown → the renderer's fixed-height fallback.
   */
  function setCloudLayer(baseAltitudeM: number | null): void {
    skyAndFog?.setCloudLayer(baseAltitudeM);
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
      rideStartDistanceM,
    );
  }

  /**
   * Update checkpoint flags based on rider distance (fade passed flags).
   */
  function updateCheckpointFlags(riderDistanceM: number): void {
    checkpointFlags?.update(riderDistanceM);
  }

  /**
   * Feed the finish airship's banner with the live remaining distance/time.
   * Called ~1 Hz by the caller (GameView). `remainingMs === null` (freeRoam / no
   * target duration) shows km only.
   */
  function updateFinishBanner(remainingKm: number, remainingMs: number | null): void {
    finishAirship?.setBannerInfo(remainingKm, remainingMs);
  }

  /**
   * Feed the airship's predicted-finish position (per frame — `dt` drives its
   * positional smoothing). Both distances are on the monotonic cumulative axis.
   */
  function updateFinishTarget(targetCum: number, playerCum: number, dt: number): void {
    finishAirship?.setTarget(targetCum, playerCum, dt);
  }

  /**
   * 幽靈車模式開關(P8)。`label` 是幽靈名牌文字(如「幽靈 · 7/12」);
   * null 關閉並清掉幽靈與兩張名牌。啟用時玩家頭上同步出現「你」名牌
   * (防搞混,開發者指定)。
   */
  function setGhostInfo(label: string | null): void {
    if (label === null) {
      ghostRider?.dispose();
      ghostRider = null;
      if (playerNameplate) {
        gameRenderer?.scene.remove(playerNameplate);
        disposeNameplate(playerNameplate);
        playerNameplate = null;
      }
      return;
    }
    if (!gameRenderer || !strategy) return;
    if (!ghostRider) {
      ghostRider = new GhostRider(gameRenderer.scene, strategy, label);
    }
    if (!playerNameplate) {
      playerNameplate = createNameplate('你', false);
      playerNameplate.visible = false; // 首幀 updateGhost 才顯示
      gameRenderer.scene.add(playerNameplate);
    }
  }

  /**
   * 每幀餵幽靈位置(來自 gameStateStore 的內插 ghostPosition/ghostDistanceM)。
   * `g === null`(封包空窗/幽靈未啟用)時隱藏但不銷毀。地面高度與玩家同一
   * 套:raycast 命中用地形,否則退 DEM 高程。
   */
  function updateGhost(
    g: { lat: number; lon: number; ele: number; bearing: number; distM: number } | null,
    dt: number,
  ): void {
    if (!ghostRider) return;
    if (g === null) {
      ghostRider.setVisible(false);
      if (playerNameplate) playerNameplate.visible = false;
      return;
    }
    const cosLat = Math.cos((originLat * Math.PI) / 180);
    const x = (g.lon - originLon) * 111320 * cosLat;
    const z = -(g.lat - originLat) * 111320;
    const groundY = chunkManager?.raycastGroundHeight(x, z);
    const y = groundY ?? (g.ele - originEle);
    ghostPositionVec.set(x, y, z);
    ghostRider.update(ghostPositionVec, g.bearing, g.distM, dt);
    ghostRider.setVisible(true);
    if (playerNameplate) playerNameplate.visible = true;
  }

  /** Clean up all resources. */
  function dispose(): void {
    if (_hoverIdentify) {
      window.removeEventListener('pointermove', _hoverIdentify, true);
      _hoverIdentify = null;
    }
    if (_hlMesh) {
      _hlMesh.removeFromParent();
      _hlMesh.geometry.dispose();
      (_hlMesh.material as THREE.Material).dispose();
      _hlMesh = null;
    }
    _hlRaw = null;
    if (_clickIdentify) {
      window.removeEventListener('pointerdown', _clickIdentify, true);
      _clickCanvas = null;
      _clickIdentify = null;
    }
    chunkManager?.dispose();
    skyAndFog?.dispose();
    glassesEffect?.dispose();
    bike?.dispose();
    bike = null;
    orbitCamera?.dispose();
    orbitCamera = null;
    mountainRing?.dispose();
    mountainRing = null;
    acrylicCase?.dispose();
    acrylicCase = null;
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
    finishAirship?.dispose();
    finishAirship = null;
    setGhostInfo(null); // 幽靈 + 兩張名牌
    gameRenderer?.dispose();
    _gpuTimer?.dispose();
    _gpuTimer = null;
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
    /** Debug: the live scene, for the object-ID pass (see debug-id-pass.ts). */
    getScene: () => gameRenderer?.scene ?? null,
    /** Debug: freeze the camera in place (the world keeps rendering). */
    freezeCamera,
    /** Debug: bypass post-processing entirely (raw scene → canvas). */
    bypassPost,
    /** Debug hover inspector — point at a thing, read what it is. The face
     *  under the cursor is highlighted in the 3D view while this is on. */
    inspectorOn,
    inspectorHits,
    inspectorPos,
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
    setCloudLayer,
    triggerCoinGlow,
    setGlassesLens,
    setWorldStyle,
    applyStyleParams,
    rebuildTerrain,
    getStrategy,
    updatePhysiology,
    setRiderSignals,
    addLensMark,
    spawnCoin,
    removeCoin,
    clearCoins,
    spawnCheckpointFlags,
    updateCheckpointFlags,
    updateFinishBanner,
    updateFinishTarget,
    setGhostInfo,
    updateGhost,
    /** Re-apply a graphics-quality tier at runtime (governor tier change). Only
     *  runtime params rebind; geometry params wait for the next chunk build. */
    applyQualityTier,
    /** The tier currently applied — the governor's initial seed. */
    getTier: () => currentTier,
    mvtFailed,
    dispose,
  };
}

export type TerrainRendererAPI = ReturnType<typeof useTerrainRenderer>;
