<template>
  <div class="game-view" :data-world-style="worldStyle" :data-hud-mode="hudMode" ref="gameViewRef">
    <!-- Game content wrapper — moved between main window and PiP window -->
    <div ref="gameContentRef" class="game-content">
      <MapContainer v-show="isMapLibre" ref="mapContainerRef" />
      <canvas v-show="isThreeJs" ref="threeCanvasRef" class="three-canvas" />
      <canvas v-show="isPhaser" ref="phaserCanvasRef" class="phaser-canvas" />
      <PiPSidebar
        v-if="pip.isActive.value"
        :elapsed-ms="gameLoop.elapsedMs.value"
        :distance-traveled="ballDist"
        @stop="handleStop"
        @pause="handlePause"
      />

      <!-- Cold start: the terrain streams in over the network, and until this
           existed the rider watched a black screen. Sits above everything and
           holds the start prompt back until there is a world to ride into. -->
      <LoadingIntroOverlay
        v-if="loading.overlayVisible"
        @dismiss="loading.hide()"
      />

      <div v-if="showStartPrompt" class="start-prompt" @click="handlePause">
        <div class="start-prompt__panel">
          <font-awesome-icon icon="circle-play" class="start-prompt__icon" />
          <h2 class="start-prompt__title">READY TO RIDE</h2>
          <p class="start-prompt__hint">
            Press <kbd class="start-prompt__key">SPACE</kbd> or start pedaling
          </p>
          <p class="start-prompt__sub">or click anywhere</p>
        </div>
      </div>

      <PauseOverlay
        :visible="showPauseOverlay"
        @resume="handlePause"
        @stop="handleStop"
      />

      <CountdownOverlay :countdown="activeCountdown" />

      <!-- Debug-only live style tuning (blocks/paper strategy params) -->
      <StyleTuningPanel
        v-if="settingsStore.config.debug && isThreeJs"
        :get-strategy="getTerrainStrategy"
        :apply-post-params="applyTerrainStyleParams"
        :rebuild-terrain="rebuildTerrainMeshes"
        :world-style="worldStyle"
      />
    </div>

    <!-- Normal HUD (hidden when PiP is active) -->
    <GlassesOverlay
      v-if="!pip.isActive.value"
      :visible="(isThreeJs || isPhaser) && gameStore.isPlaying"
      :frame-color="gameStore.glassesFrameColor"
      :frame-material="gameStore.glassesFrameMaterial"
    />
    <Hud
      v-if="!pip.isActive.value"
      :route-points="routePoints"
      :ball-lat="ballPos.lat"
      :ball-lon="ballPos.lon"
      :ball-bearing="ballPos.bearing"
      :elapsed-ms="gameLoop.elapsedMs.value"
      :distance-traveled="ballDist"
      :combo="coinSystem.comboMultiplier.value"
      :red-line="coinSystem.redLine.value"
      :virtual-power="effectivePower"
      :time-series="gameLoop.timeSeries.value"
      :fps="gameLoop.fps.value"
      :fps-max="gameLoop.fpsMax.value"
      :fps-min="gameLoop.fpsMin.value"
      :hr-max="gameLoop.hrMax.value"
      :hr-min="gameLoop.hrMin.value"
      :speed-max="gameLoop.speedMax.value"
      :speed-min="gameLoop.speedMin.value"
      :cadence-max="gameLoop.cadenceMax.value"
      :cadence-min="gameLoop.cadenceMin.value"
      :power-max="gameLoop.powerMax.value"
      :power-min="gameLoop.powerMin.value"
      :workout-segments="gameStore.workoutSegments"
      :current-segment-index="workoutTracker.currentSegmentIndex.value"
      :target-watts="workoutTracker.targetWatts.value"
      :is-on-target="workoutTracker.isOnTarget.value"
      :current-segment-name="workoutTracker.currentSegment.value?.name ?? ''"
      :segment-remaining-ms="workoutTracker.segmentRemainingMs.value"
      :current-watts="effectivePower"
      :power-source="gameStateStore.powerSource"
      :current-cadence="currentCadence"
      :pip-supported="pip.isSupported.value"
      :camera-pitch="cameraControl.pitch.value"
      :camera-height="cameraControl.height.value"
      :message="gameMessages.currentMessage.value"
      :is-event-active="randomEvents.isEventActive.value"
      :active-event="randomEvents.activeEvent.value"
      :event-elapsed-ms="randomEvents.eventElapsedMs.value"
      :event-progress="randomEvents.eventProgress.value"
      :event-target-watts="randomEvents.eventTargetWatts.value"
      :event-target-cadence="randomEvents.eventTargetCadence.value"
      :is-event-on-target="randomEvents.isEventOnTarget.value"
      :event-screen-tint="randomEvents.eventScreenTint.value"
      :event-screen-tint-opacity="randomEvents.eventScreenTintOpacity.value"
      :idle-ms="gameStateStore.idleMs"
      :auto-paused="gameStateStore.autoPaused"
      @stop="handleStop"
      @pause="handlePause"
      @toggle-pip="togglePiP"
      @typewriter-done="gameMessages.onTypewriterDone"
      @continue="handleContinue"
    />

    <!-- Placeholder when game is in PiP window -->
    <div v-if="pip.isActive.value" class="pip-placeholder">
      <font-awesome-icon icon="up-right-from-square" class="pip-placeholder__icon" />
      <p class="pip-placeholder__text">GAME RUNNING IN FLOATING WINDOW</p>
      <button class="pip-placeholder__btn" @click="pip.close()">
        <font-awesome-icon icon="xmark" />
        RETURN TO MAIN WINDOW
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, shallowRef, toRef, onMounted, onUnmounted, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { useRouteStore } from '@/stores/routeStore';
import { useGameStore } from '@/stores/gameStore';
import type { MapSetupAPI } from '@/composables/useMapSetup';
import type { ThreeBallAPI } from '@/composables/useThreeBall';
import type { TerrainRendererAPI } from '@/composables/useTerrainRenderer';
import { usePhaserRenderer } from '@/composables/usePhaserRenderer';
import { useWeatherApi } from '@/composables/useWeatherApi';
import { useWindSimulator } from '@/composables/useWindSimulator';
import { HR_ZONES, buildCumulativeDistances, type RideSummaryDto } from '@littlecycling/shared';
import { useGameStateStore } from '@/stores/gameStateStore';
import { useServerCoinAdapter } from '@/composables/useServerCoinAdapter';
import { useGameLoop } from '@/composables/useGameLoop';
import { useCoinSystem } from '@/composables/useCoinSystem';
import { useWebSocket } from '@/composables/useWebSocket';
import { useCameraControl } from '@/composables/useCameraControl';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSensorStore } from '@/stores/sensorStore';
import { useLoadingStore } from '@/stores/loadingStore';
import { useWorkoutTracker } from '@/composables/useWorkoutTracker';
import { useGameMessages } from '@/composables/useGameMessages';
import { useRandomEvents } from '@/composables/useRandomEvents';
import { updateFpsCamera as updateMapLibreCamera } from '@/game/camera';
import type { CoinLayerInterface } from '@/game/coin-interface';
import { setDebugEnabled } from '@/game/debug-logger';
import { AudioManager } from '@/game/audio/audio-manager';
import { useDocumentPiP } from '@/composables/useDocumentPiP';
import { useWakeLock } from '@/composables/useWakeLock';
import { usePlanStore } from '@/stores/planStore';
import MapContainer from '@/components/game/MapContainer.vue';
import GlassesOverlay from '@/components/game/GlassesOverlay.vue';
import Hud from '@/components/game/Hud.vue';
import PiPSidebar from '@/components/game/PiPSidebar.vue';
import PauseOverlay from '@/components/game/PauseOverlay.vue';
import CountdownOverlay from '@/components/game/CountdownOverlay.vue';
import LoadingIntroOverlay from '@/components/game/LoadingIntroOverlay.vue';
import StyleTuningPanel from '@/components/game/StyleTuningPanel.vue';
import { notifyError } from '@/utils/notify';

const router = useRouter();
const routeStore = useRouteStore();
const gameStore = useGameStore();
const settingsStore = useSettingsStore();
const sensorStore = useSensorStore();
const loading = useLoadingStore();
const planStore = usePlanStore();

// Redirect if not playing
if (gameStore.state !== 'playing') {
  router.replace('/');
}

const isThreeJs = computed(() => settingsStore.config.map.renderMode === 'threejs');
const isPhaser = computed(() => settingsStore.config.map.renderMode === 'phaser');
const isMapLibre = computed(() => settingsStore.config.map.renderMode === 'maplibre');

/** HUD theme follows the same world style picked from welcome. */
const worldStyle = computed(
  () => settingsStore.config.map.worldStyle ?? 'plastic',
);

/** Top-HUD text treatment follows the render mode, not the world style:
 *  the flat Phaser 2D world gets embossed HUD text, every 3D-ish renderer
 *  (Three.js / MapLibre) gets neon glow. Drives [data-hud-mode] overrides in
 *  HudTopBar / HudCoins. */
const hudMode = computed(() => (isPhaser.value ? '2d' : '3d'));

const gameViewRef = ref<HTMLElement | null>(null);
const gameContentRef = ref<HTMLElement | null>(null);
const mapContainerRef = ref<InstanceType<typeof MapContainer> | null>(null);
const containerEl = computed(() => mapContainerRef.value?.container ?? null);
const threeCanvasRef = ref<HTMLCanvasElement | null>(null);
const phaserCanvasRef = ref<HTMLCanvasElement | null>(null);

// Document Picture-in-Picture
const pip = useDocumentPiP();

// Keep the screen awake for the whole ride — long sessions are hands-free,
// so the OS screensaver / display sleep must not trigger. Released
// automatically when the view unmounts (composable handles it).
const wakeLock = useWakeLock();

async function togglePiP() {
  if (pip.isActive.value) {
    pip.close();
  } else {
    await pip.open({ width: 800, height: 500 });
    await nextTick();
    // Move game content into PiP window
    const container = pip.pipContainer.value;
    const content = gameContentRef.value;
    if (container && content) {
      container.appendChild(content);
      // Adjust sizing for PiP window (account for sidebar width)
      content.style.width = '100%';
      content.style.height = '100%';
      const sidebarW = '140px';
      if (isThreeJs.value || isPhaser.value) {
        const canvas = isThreeJs.value ? threeCanvasRef.value : phaserCanvasRef.value;
        if (canvas) {
          canvas.style.width = `calc(100% - ${sidebarW})`;
          canvas.style.height = '100%';
        }
      } else {
        const mapEl = containerEl.value;
        if (mapEl) {
          mapEl.style.width = `calc(100% - ${sidebarW})`;
          mapEl.style.height = '100%';
        }
      }
      await nextTick();
      // Trigger resize so renderers adapt
      if (isPhaser.value) {
        // Phaser CANVAS mode: let game.scale.resize() handle internal canvas size.
        // Do NOT set canvas.width/height directly — that resets the 2D context.
        const canvas = phaserCanvasRef.value;
        if (canvas) {
          phaserRenderer.resize(canvas.clientWidth, canvas.clientHeight);
        }
      } else if (isThreeJs.value) {
        const canvas = threeCanvasRef.value;
        if (canvas) {
          canvas.width = canvas.clientWidth;
          canvas.height = canvas.clientHeight;
        }
      } else {
        mapSetup?.map.value?.resize();
      }

      // Listen for PiP window resize
      const pipWin = pip.pipWindow.value;
      if (pipWin) {
        pipWin.addEventListener('resize', handlePiPResize);
      }
    }
  }
}

function handlePiPResize() {
  if (!pip.isActive.value) return;
  if (isPhaser.value) {
    // Do NOT set canvas.width/height directly — that resets the 2D context.
    const canvas = phaserCanvasRef.value;
    if (canvas) {
      phaserRenderer.resize(canvas.clientWidth, canvas.clientHeight);
    }
  } else if (isThreeJs.value) {
    const canvas = threeCanvasRef.value;
    if (canvas) {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    }
  } else {
    mapSetup?.map.value?.resize();
  }
}

// When PiP closes, move game content back to main window
watch(
  () => pip.isActive.value,
  async (active) => {
    if (!active && gameContentRef.value && gameViewRef.value) {
      // Move content back to main window
      gameViewRef.value.prepend(gameContentRef.value);
      // Restore layout
      gameContentRef.value.style.width = '';
      gameContentRef.value.style.height = '';
      if (isThreeJs.value || isPhaser.value) {
        const canvas = isThreeJs.value ? threeCanvasRef.value : phaserCanvasRef.value;
        if (canvas) {
          canvas.style.width = '100vw';
          canvas.style.height = '100vh';
        }
      } else {
        const mapEl = containerEl.value;
        if (mapEl) {
          mapEl.style.width = '100vw';
          mapEl.style.height = '100vh';
        }
      }
      await nextTick();
      // Trigger resize
      if (isPhaser.value) {
        // Do NOT set canvas.width/height directly — that resets the 2D context.
        const canvas = phaserCanvasRef.value;
        if (canvas) {
          phaserRenderer.resize(canvas.clientWidth, canvas.clientHeight);
        }
      } else if (isThreeJs.value) {
        const canvas = threeCanvasRef.value;
        if (canvas) {
          canvas.width = canvas.clientWidth;
          canvas.height = canvas.clientHeight;
        }
      } else {
        mapSetup?.map.value?.resize();
      }
    }
  },
);

const routePoints = computed(() => routeStore.activeRoute?.points ?? []);

// Camera control: scroll wheel → pitch, arrow up/down → height
const mapConfig = settingsStore.config.map;
const cameraControl = useCameraControl(gameViewRef, isThreeJs.value ? {
  initialPitch: mapConfig.cameraPitch,
  minPitch: 1,
  maxPitch: 60,
  invertScroll: true,
  initialHeight: mapConfig.cameraHeight,
  minHeight: 1,
  maxHeight: mapConfig.cameraHeight,
} : {
  initialPitch: 78,
  minPitch: 30,
  maxPitch: 85,
  initialHeight: mapConfig.cameraHeight,
  minHeight: 1,
  maxHeight: mapConfig.cameraHeight,
});

// WebSocket sensor stream
const ws = useWebSocket();

// Lazily loaded renderer composables (dynamically imported in onMounted based on renderMode)
let mapSetup: MapSetupAPI | null = null;
let threeBall: ThreeBallAPI | null = null;
let terrainRenderer: TerrainRendererAPI | null = null;

// Phaser 2D renderer (Excitebike mode)
const phaserRenderer = usePhaserRenderer();

// ── Debug style-tuning panel bridges (Three.js world-style strategy) ──
const getTerrainStrategy = () => terrainRenderer?.getStrategy() ?? null;
const applyTerrainStyleParams = () => terrainRenderer?.applyStyleParams();
const rebuildTerrainMeshes = () => terrainRenderer?.rebuildTerrain();

// Debug mode — enable global debug logger based on config
setDebugEnabled(settingsStore.config.debug);

// Audio manager — NES synth + ambient noise
const audioManager = new AudioManager(isThreeJs.value || isPhaser.value);
audioManager.setEnabled(settingsStore.config.sound.enabled);

// Watch sound enabled toggle
watch(
  () => settingsStore.config.sound.enabled,
  (on) => audioManager.setEnabled(on),
);

// Real-time weather from Open-Meteo API
const weatherApi = useWeatherApi();

// Wind simulator (Open-Meteo base + smooth client-side fluctuation)
const windSim = useWindSimulator({
  baseSpeedKmh: weatherApi.windSpeedKmh,
  baseDirectionDeg: weatherApi.windDirectionDeg,
});
windSim.start();

// Coin layer: adapts to whichever renderer is active
const coinLayer = shallowRef<CoinLayerInterface | null>(null);

// Coin system — display-only zone/combo refs, mirrored from server frames
const coinSystem = useCoinSystem();

// ── Server-authoritative rendering ──
// The server simulation broadcasts game_state at 20Hz; gameStateStore
// interpolates it to render rate. It is the ONLY source of ball state —
// StartBar fails loudly if /api/live/start fails, so the game never runs
// without a live simulation on the other end.
const gameStateStore = useGameStateStore();

watch(
  routePoints,
  (pts) => {
    if (pts.length > 0) gameStateStore.setRoute(pts);
  },
  { immediate: true },
);

// Ball-state accessors — every consumer below (renderer closures, HUD
// bindings, workout tracker) reads these.
const ballPos = computed(() => gameStateStore.position);
const ballDist = computed(() => gameStateStore.distanceTraveled);
const ballSpeed = computed(() => gameStateStore.speedKmh);
// Server-effective watts — real PWR sensor when present, trainer-curve
// estimate otherwise. The ONLY value fed into power evaluations; ballSpeed
// (km/h) must never stand in for watts again.
const effectivePower = computed(() => gameStateStore.powerW);
// Live cadence for gauge display: speed/cadence sensor first, then a power
// meter's cadence channel. Null when neither reports.
const currentCadence = computed<number | null>(
  () => sensorStore.sc?.cadence ?? sensorStore.pwr?.cadence ?? null,
);
const ballSteer = computed(() => gameStateStore.steeringAngle);

// HR zone + combo come from the server's state machine — mirror them into
// coinSystem's refs so the HUD, renderers and game messages keep reading
// their usual source.
watch(
  () => [gameStateStore.zone, gameStateStore.combo] as const,
  ([z, c]) => {
    coinSystem.currentZone.value = z != null ? (HR_ZONES[z - 1] ?? null) : null;
    // In workout mode, suppress the Zone-5 red-line warning (overlay, ball
    // dimming, comic bubble, alarm) — structured intervals target Zone 5 on
    // purpose. Coin rules (Z5 → 0 coins) run off getCoinsForHr, unaffected.
    coinSystem.redLine.value = z === 5 && !gameStore.isWorkoutMode;
    coinSystem.comboMultiplier.value = c;
  },
);

// ── Server-authoritative coins ──
// Coins live on the server: this adapter renders its deltas (idempotent by
// coin id, self-healed by the periodic reconcile).
const serverCoins = useServerCoinAdapter({
  layer: coinLayer,
  onCollected: () => {
    // A paused server sim never collects, so ops arriving while WE are
    // paused can only be desync residue (e.g. frames buffered across a
    // pause) — drop the feedback, the adapter still removes the visual.
    if (gameStore.isPaused) return;
    if (isThreeJs.value) terrainRenderer?.triggerCoinGlow();
    else if (isPhaser.value) phaserRenderer.triggerCoinGlow();
    audioManager.coinCollect();
  },
});
gameStateStore.onCoinOps(serverCoins.apply);

// Track last frame time for dt calculation
let lastFrameTime = 0;

// Game loop
const gameLoop = useGameLoop({
  ballTick: () => {
    // No local physics — interpolate the buffered 20Hz server frames at
    // render time (~75ms behind receipt).
    gameStateStore.sample(performance.now());
  },
  updateBallVisual: () => {
    const pos = ballPos.value;

    if (isThreeJs.value) {
      terrainRenderer!.updatePosition([pos.lon, pos.lat], pos.ele);
      terrainRenderer!.setDarkened(coinSystem.redLine.value);
      terrainRenderer!.updateDistance(ballDist.value);
    } else if (isPhaser.value) {
      phaserRenderer.updatePosition([pos.lon, pos.lat], pos.ele);
      phaserRenderer.setDarkened(coinSystem.redLine.value);
      phaserRenderer.updateDistance(ballDist.value);
      phaserRenderer.updateSensorData(
        ballSpeed.value,
        sensorStore.sc?.cadence ?? 0,
      );
    } else {
      threeBall!.updatePosition([pos.lon, pos.lat], pos.ele);
      threeBall!.setDarkened(coinSystem.redLine.value);
    }

    // Update checkpoint flags (fade passed ones)
    if (isThreeJs.value) {
      terrainRenderer!.updateCheckpointFlags(ballDist.value);
    } else if (isPhaser.value) {
      phaserRenderer.updateCheckpointFlags(ballDist.value);
    }
  },
  updateCamera: () => {
    const pos = ballPos.value;

    // Combine manual yaw (arrow keys) + power-balance steering yaw
    const YAW_SCALE = 0.5;
    const totalYaw = cameraControl.yaw.value
      + ballSteer.value * YAW_SCALE;
    const effectiveBearing = pos.bearing + totalYaw;

    if (isThreeJs.value) {
      const now = performance.now();
      const dt = lastFrameTime ? (now - lastFrameTime) / 1000 : 0;
      lastFrameTime = now;
      terrainRenderer!.setCameraOptions({
        pitchDeg: cameraControl.pitch.value,
        heightAboveM: cameraControl.height.value,
        // 跟車 / 自由 — the HUD's segmented control (attaching and detaching the
        // orbit input is a no-op unless the mode actually changed).
        mode: gameStore.cameraMode,
      });
      terrainRenderer!.updateCamera(effectiveBearing, dt);
      terrainRenderer!.updatePhysiology(
        coinSystem.currentZone.value?.zone ?? null,
        ballSpeed.value,
      );
      terrainRenderer!.render(dt);
      // Update wind sound intensity based on speed (Three.js only)
      audioManager.updateWind(ballSpeed.value);
    } else if (isPhaser.value) {
      const now = performance.now();
      const dt = lastFrameTime ? (now - lastFrameTime) / 1000 : 0;
      lastFrameTime = now;
      // 跟車 / 自由 — same HUD switch as 3D (setCameraMode ignores no-op calls).
      phaserRenderer.setCameraOptions({ mode: gameStore.cameraMode });
      phaserRenderer.updateCamera(effectiveBearing, dt);
      phaserRenderer.updatePhysiology(
        coinSystem.currentZone.value?.zone ?? null,
        ballSpeed.value,
      );
      phaserRenderer.render(dt);
      // Update wind sound intensity based on speed (Phaser mode)
      audioManager.updateWind(ballSpeed.value);
    } else if (mapSetup?.map.value) {
      updateMapLibreCamera(mapSetup.map.value, { ...pos, bearing: effectiveBearing }, {
        pitch: cameraControl.pitch.value,
      });
    }
    // Pedal click rhythm (all modes)
    audioManager.updateCadence(sensorStore.sc?.cadence ?? 0);
  },
});

// Workout tracker (with optional HR for plan-based on-target)
const currentHr = computed(() => sensorStore.hr?.heartRate ?? 0);
const workoutTracker = useWorkoutTracker(
  toRef(gameStore, 'workoutSegments'),
  gameLoop.elapsedMs,
  effectivePower,  // server-effective watts (meter first, else estimated)
  currentHr,
);

// Game messages (comic bubble)
const gameMessages = useGameMessages({
  currentZone: coinSystem.currentZone,
  redLine: coinSystem.redLine,
  comboMultiplier: coinSystem.comboMultiplier,
  coins: computed(() => gameStore.coins),
  segmentChanged: workoutTracker.segmentChanged,
  currentSegment: workoutTracker.currentSegment,
  laps: computed(() => gameStore.laps),
  distanceTraveled: ballDist,
  speedKmh: ballSpeed,
  maxSpeed: computed(() => gameLoop.speedMax.value),
  maxPower: computed(() => gameLoop.powerMax.value),
  isOnTarget: workoutTracker.isOnTarget,
  weatherType: weatherApi.weatherType,
  idleMs: computed(() => gameStateStore.idleMs),
});

// Random events (freeride challenges) — presentation mapper over the
// server's game_state.event DTO.
const savedWeatherType = ref<string | null>(null);
const randomEvents = useRandomEvents({
  serverEvent: computed(() => gameStateStore.event),
  pushMessage: gameMessages.pushMessage,
  setWeather: (config) => {
    // Save current weather before overriding
    savedWeatherType.value = gameStore.weatherOverride ?? weatherApi.weatherType.value;
    gameStore.weatherOverride = config.type;
  },
  setDarkened: (dark) => {
    if (isThreeJs.value) terrainRenderer?.setDarkened(dark);
    else if (isPhaser.value) phaserRenderer.setDarkened(dark);
  },
  restoreWeather: () => {
    // Restore to previous weather (or null to use API weather)
    gameStore.weatherOverride = savedWeatherType.value === weatherApi.weatherType.value
      ? null
      : savedWeatherType.value;
    savedWeatherType.value = null;
  },
});

// Sync isRandomEvent flag with gameStore
watch(
  () => randomEvents.isEventActive.value,
  (active) => { gameStore.isRandomEvent = active; },
);

// Push live wind state to whichever renderer is active + ambient audio.
watch(
  () => windSim.wind.value,
  (w) => {
    if (isThreeJs.value) {
      terrainRenderer?.setWind(w.speedKmh, w.directionDeg, w.gustFactor);
    } else if (isPhaser.value) {
      phaserRenderer.setWind(w.speedKmh, w.directionDeg, w.gustFactor);
    }
    audioManager.updateAmbientWind(w.speedKmh);
  },
  { immediate: true },
);

// Lightning random tick — driven by gameLoop time, gated by weather/code.
const lightningTick = { lastCheckMs: 0, nextEarliestMs: 0 };
function tryLightning(elapsedMs: number) {
  if (elapsedMs - lightningTick.lastCheckMs < 1000) return;
  lightningTick.lastCheckMs = elapsedMs;
  if (elapsedMs < lightningTick.nextEarliestMs) return;

  const type = gameStore.weatherOverride ?? weatherApi.weatherType.value;
  if (type !== 'rainy') return;

  const code = weatherApi.weatherCode.value;
  const isThunderCode = code >= 95 && code <= 99;
  const perSecChance = isThunderCode ? 0.04 : 0.006;
  if (Math.random() >= perSecChance) return;

  const distance = Math.random();
  const intensity = 0.6 + (1 - distance) * 0.8;

  if (isThreeJs.value) terrainRenderer?.triggerLightning(intensity);
  else if (isPhaser.value) phaserRenderer.triggerLightning(intensity);

  // Light reaches the eye instantly; thunder lags 0.3..2s.
  const thunderDelayMs = 300 + distance * 1700;
  setTimeout(() => audioManager.playThunder(distance), thunderDelayMs);

  lightningTick.nextEarliestMs = elapsedMs + 3000 + Math.random() * 9000;
}
watch(() => gameLoop.elapsedMs.value, tryLightning);

// ── Audio event watchers ──

// Workout segment change
watch(
  () => workoutTracker.segmentChanged.value,
  (changed) => {
    if (!changed) return;
    audioManager.segmentChange();
    // An interval just ended — pull the camera up for a look at the world.
    if (isThreeJs.value) terrainRenderer?.triggerCameraLift('peek');
    else if (isPhaser.value) phaserRenderer.triggerCameraLift('peek');
  },
);

// Run-in to the finish: rise and stay up, so the summary opens on a view of the
// world rather than the back of a bike. Free rides (no target) never end, so
// they never get a finale.
const FINALE_LEAD_MS = 10_000;
let finaleFired = false;
watch(
  () => gameLoop.elapsedMs.value,
  (elapsedMs) => {
    if (finaleFired || (!isThreeJs.value && !isPhaser.value)) return;
    if (gameStore.state !== 'playing' || gameStore.targetDurationMs <= 0) return;
    if (gameStore.targetDurationMs - elapsedMs > FINALE_LEAD_MS) return;
    finaleFired = true;
    if (isThreeJs.value) terrainRenderer?.triggerCameraLift('finale');
    else phaserRenderer.triggerCameraLift('finale');
  },
);

// Zone 5 redline alert
watch(
  () => coinSystem.redLine.value,
  (on) => audioManager.zoneAlert(on),
);

// Combo level change
watch(
  () => coinSystem.comboMultiplier.value,
  (level, prev) => {
    if (level > (prev ?? 0)) {
      audioManager.comboUp(level);
    }
  },
);

// Lap complete
watch(
  () => gameStore.laps,
  (newLaps, oldLaps) => {
    if (newLaps > oldLaps) {
      audioManager.lapComplete();
    }
  },
);

const hasStarted = ref(false);
// Two prompts fighting for the same screen reads as a bug, so READY TO RIDE
// waits for the loading overlay to be dismissed.
const showStartPrompt = computed(
  () => gameLoop.isRunning.value && gameStore.isPaused && !hasStarted.value
    && !loading.overlayVisible,
);
const showPauseOverlay = computed(
  () => gameLoop.isRunning.value && gameStore.isPaused && hasStarted.value && !pip.isActive.value,
);

// Centered 1-minute countdown: fires in the final 60s before the current
// workout segment ends AND before the total training time runs out. Both share
// one overlay — when they coincide (a profile workout's last segment ends
// exactly at time-up) the ride-end deadline wins the label. Whole-second value
// so the big number ticks 60 → 1.
const COUNTDOWN_WINDOW_MS = 60_000;
const activeCountdown = computed<{ kind: 'segment' | 'finish'; seconds: number } | null>(() => {
  // Never over the start prompt or a pause; only during live play.
  if (gameStore.state !== 'playing' || gameStore.isPaused || !hasStarted.value) return null;
  // Stopped-pedalling countdown owns the screen — don't stack a second big timer.
  if (gameStateStore.idleMs > 0 || gameStateStore.autoPaused) return null;
  const totalRemaining = gameStore.targetDurationMs - gameLoop.elapsedMs.value;
  const segRemaining = workoutTracker.hasWorkout.value
    ? workoutTracker.segmentRemainingMs.value
    : Number.POSITIVE_INFINITY;
  const totalIn = totalRemaining > 0 && totalRemaining <= COUNTDOWN_WINDOW_MS;
  const segIn = segRemaining > 0 && segRemaining <= COUNTDOWN_WINDOW_MS;
  if (!totalIn && !segIn) return null;
  // Ride-end takes priority when it's the sooner (or equal) deadline.
  if (totalIn && totalRemaining <= segRemaining) {
    return { kind: 'finish', seconds: Math.ceil(totalRemaining / 1000) };
  }
  return { kind: 'segment', seconds: Math.ceil(segRemaining / 1000) };
});

watch(
  () => gameStore.isPaused,
  (paused) => {
    if (paused) return;
    // First unpause = the rider sets off. Build the 2D world in around them
    // now: any earlier and the animation plays behind the loading overlay /
    // start prompt, where nobody sees it.
    if (!hasStarted.value && isPhaser.value) phaserRenderer.playIntro();
    hasStarted.value = true;
  },
);

// Deferred recording: the server recording (ride row, jsonl, clock, sim) only
// starts once the user passes the start prompt — the first unpause. StartBar
// stashed the /api/live/start body in gameStore.pendingStart; we fire it here.
let beginInFlight = false;

function revertToPrompt(detail: string) {
  // Start failed after entering the game. Surface it and put the view back at
  // the start prompt so the user can retry (re-pedal / Space) or exit. Keep
  // pendingStart so the retry still has the config body.
  notifyError(`Cannot start ride: ${detail}`);
  hasStarted.value = false;
  if (!gameStore.isPaused) gameStore.togglePause();
}

async function beginRide() {
  if (gameStore.currentRideId !== null || beginInFlight) return;
  const body = gameStore.pendingStart;
  if (!body) return;
  beginInFlight = true; // set synchronously (before await) so a rapid re-toggle can't double-start
  try {
    const res = await fetch('/api/live/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const b = await res.json();
        if (b?.error) detail = String(b.error);
      } catch { /* response wasn't JSON */ }
      revertToPrompt(detail);
      return;
    }
    const data = await res.json();
    gameStore.currentRideId = data.rideId;
    gameStore.pendingStart = null; // clear only on success
    // The sim is born paused with auto-start armed: the pedal path self-starts
    // on the tick's first-signal rule, but a Space/click start has no power
    // signal and would sit frozen forever — so drive resume ourselves. Skip it
    // if the user re-paused during the round-trip.
    if (!gameStore.isPaused) {
      fetch('/api/live/resume', { method: 'POST' }).catch(() => { /* recoverable: Space re-sends */ });
    }
  } catch {
    revertToPrompt('server unreachable');
  } finally {
    beginInFlight = false; // failure resets only the flag — pendingStart stays for retry
  }
}

// First unpause (start prompt passed) and no ride yet → begin recording now.
watch(
  () => gameStore.isPaused,
  (paused) => {
    if (!paused && gameStore.currentRideId === null && gameStore.state === 'playing') {
      void beginRide();
    }
  },
);

// Mirror pause state to the server-side game simulation — the sim's paused
// flag is what actually freezes physics/coins/events. `immediate` matters:
// the initial pause (startGame's start prompt) happens BEFORE this view
// mounts, so without it the server never hears it — and an unheard pause
// leaves the sim's auto-start armed, letting an already-streaming sensor
// (--replay/--mock/spinning trainer) ride the ball away while the camera
// is still frozen at the start line. The first POST also disables the
// sim's auto-start (clientControlled); from then on the sim starts only
// via our resume. Fire-and-forget: a lost resume is recoverable — Space
// re-sends it.
watch(
  () => gameStore.isPaused,
  (paused) => {
    if (gameStore.currentRideId === null || gameStore.state !== 'playing') return;
    fetch(paused ? '/api/live/pause' : '/api/live/resume', { method: 'POST' })
      .catch(() => { /* shadow-mode: non-fatal */ });
  },
  { immediate: true },
);

// Auto-start the game on the first real pedal stroke (power > 0 or cadence > 0).
// Mirrors the Space-key path: only fires while waiting at the start prompt.
// showStartPrompt is part of the watch source: the prompt appears only after
// terrain load finishes, and a rider (or --replay/--mock stream) that was
// already pedaling by then holds a steady signal that would never re-trigger
// a signal-only watch — the game would sit at the prompt forever now that
// the server no longer auto-starts on its own.
watch(
  [
    () => {
      const power = sensorStore.pwr?.power ?? 0;
      const scCadence = sensorStore.sc?.cadence ?? 0;
      const pwrCadence = sensorStore.pwr?.cadence ?? 0;
      return Math.max(power, scCadence, pwrCadence);
    },
    showStartPrompt,
  ],
  ([signal, prompt]) => {
    if (signal > 0 && prompt) {
      gameStore.togglePause();
    }
  },
);

function handlePause() {
  if (gameStore.state !== 'playing') return;
  gameStore.togglePause();
}

function handleSpacebar(e: KeyboardEvent) {
  if (e.code !== 'Space' && e.key !== ' ') return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return;
  }
  e.preventDefault();
  handlePause();
}

// Guard so the manual-stop path and the natural time-up watcher don't
// both fire the stop endpoint / plan-completion logic.
let stopFinalised = false;

async function finaliseRide() {
  if (stopFinalised) return;
  stopFinalised = true;
  if (gameStore.currentRideId !== null) {
    try {
      // The server simulation owns every ride stat (coins, laps, averages,
      // zone sustain) — a bare stop persists them and returns the summary,
      // which GameSummary displays end-to-end.
      const res = await fetch('/api/live/stop', { method: 'POST' });
      // fetch() doesn't throw on 4xx/5xx — without this check the user
      // sees "ride ended" even when the backend rejected the stop and
      // the ride is left orphaned in the DB (no ended_at, no summary).
      if (res.ok) {
        try {
          const body = await res.json();
          if (body?.summary) gameStore.rideSummary = body.summary as RideSummaryDto;
        } catch { /* summary display falls back to the live mirrors */ }
      } else {
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.error) detail = String(body.error);
        } catch { /* response wasn't JSON */ }
        console.warn('[ride] stop endpoint rejected:', detail, 'rideId=', gameStore.currentRideId);
        notifyError(`Failed to save ride: ${detail}. The ride will be auto-recovered next time the server starts.`);
      }
    } catch (err) {
      console.warn('[ride] stop endpoint network error:', err);
      notifyError('Failed to save ride: network error. The ride will be auto-recovered next time the server starts.');
    }
  }
  for (const entry of planStore.todaySessions) {
    if (entry.session.type === 'training' && !planStore.isCompleted(entry.plan.id, entry.day)) {
      planStore.recordCompletion(
        entry.plan.id,
        entry.day,
        gameStore.currentRideId ?? undefined,
      );
    }
  }
}

async function handleStop() {
  // Close PiP first so game summary shows in main window
  if (pip.isActive.value) {
    pip.close();
    await nextTick();
  }

  gameLoop.stop();
  await finaliseRide();

  gameMessages.pushMessage('game-end');
  audioManager.gameEnd();

  gameStore.endGame();
}

// CONTINUE from the summary: ride on into a fresh recording. finaliseRide()
// already stopped the previous ride (currentRideId still points at it), so we
// clear that id, rebuild the /api/live/start body (same shape StartBar uses),
// and drop back to state 'playing' — which closes the summary and re-shows the
// start prompt. The first unpause then runs beginRide() for a new ride row.
// gameLoop.start() re-zeros elapsedMs/timeSeries; finaleFired is reset by the
// 'playing' branch of the state watch below.
function handleContinue() {
  stopFinalised = false;
  hasStarted.value = false;
  gameStore.currentRideId = null;
  gameStore.rideSummary = null;

  const route = routeStore.activeRoute;
  gameStore.pendingStart = {
    routeId: route?.id,
    routeName: route?.name,
    game: route
      ? {
          ftp: settingsStore.config.training.ftp,
          hrMax: settingsStore.config.training.hrMax,
          trainerModel: settingsStore.config.sensor.trainerModel,
          freeRoam: gameStore.freeRoam,
          targetDurationMs: settingsStore.config.training.defaultDuration,
          randomEventsEnabled: gameStore.randomEventsEnabled,
          selectedWorkoutId: gameStore.selectedWorkoutId,
        }
      : undefined,
  };

  gameStore.startGame(settingsStore.config.training.defaultDuration);
  gameLoop.start();
}

// Watch game state — the natural time-up path inside useGameLoop only
// flips gameStore.state to 'ended', so we need to drive the server stop
// and plan-completion bookkeeping from here for that case to land in DB.
watch(
  () => gameStore.state,
  async (state) => {
    if (state === 'playing') {
      finaleFired = false; // a new ride gets its own finale
      return;
    }
    if (state === 'ended') {
      gameLoop.stop();
      await finaliseRide();
    }
  },
);

/**
 * Ceiling on how long the loading overlay may hold the rider. A hung tile
 * server must not be able to lock someone out of their own ride — past this,
 * the button unlocks and says so. The terrain keeps streaming in behind it.
 */
const LOADING_TIMEOUT_MS = 20_000;

/** Preload the message pool without blocking the game loop; push the opening
 *  lines once they're actually available. Failure is cosmetic — ride on. */
async function preloadMessages(pushOpeningLines: () => void) {
  loading.beginStage('messages');
  try {
    await gameMessages.preload();
    loading.completeStage('messages');
    pushOpeningLines();
  } catch {
    loading.failStage('messages', '旅程訊息載入失敗，本次騎乘不會有旁白');
  }
}

/** The last stage: a frame has actually been painted, so there is something
 *  behind the overlay worth showing. */
function markFirstFrame() {
  loading.beginStage('firstFrame');
  requestAnimationFrame(() => loading.completeStage('firstFrame'));
}

onMounted(async () => {
  window.addEventListener('keydown', handleSpacebar);

  // Up before anything awaits, so the black canvas is covered from frame one.
  loading.reset(settingsStore.config.map.renderMode);

  const unlockTimer = setTimeout(() => {
    if (!loading.unlocked) {
      loading.unlock('載入時間過長，部分場景仍在背景載入');
    }
  }, LOADING_TIMEOUT_MS);

  const stopUnlockWatch = watch(
    () => loading.allDone,
    (done) => {
      if (!done) return;
      clearTimeout(unlockTimer);
      loading.unlock();
      stopUnlockWatch();
    },
    { immediate: true },
  );
  onUnmounted(() => clearTimeout(unlockTimer));

  void wakeLock.request();

  // Connect sensor stream. There is no client-side fallback: the game state
  // comes from the server simulation, so without a server there is nothing
  // to render (dev without hardware: `npm run server -- --mock`).
  ws.connect();

  await nextTick();

  const pts = routePoints.value;
  const initialCenter: [number, number] | undefined =
    pts.length > 0 ? [pts[0].lon, pts[0].lat] : undefined;

  if (isThreeJs.value) {
    // ── Three.js mode ──
    const canvas = threeCanvasRef.value;
    if (!canvas || pts.length === 0) {
      // Nothing will ever load — don't leave the rider staring at a locked
      // button waiting for stages that will never run.
      loading.unlock('沒有可用的路線資料');
      return;
    }

    // Dynamically import Three.js terrain renderer
    const { useTerrainRenderer } = await import('@/composables/useTerrainRenderer');
    terrainRenderer = useTerrainRenderer();

    // Size canvas to viewport
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;

    const mapConfig = settingsStore.config.map;
    await terrainRenderer.init({
      canvas,
      points: pts,
      cameraOptions: {
        heightAboveM: mapConfig.cameraHeight,
        lookAheadM: mapConfig.cameraLookAhead,
        pitchDeg: mapConfig.cameraPitch,
      },
      corridorHalfWidth: mapConfig.viewRange,
      dayNightEnabled: mapConfig.dayNightEnabled,
      // World style: 'plastic' → blocks, 'cuphead' → corrugated paper.
      worldStyle: mapConfig.worldStyle,
    });

    // Set coin layer to terrain renderer
    coinLayer.value = {
      spawnCoin: terrainRenderer.spawnCoin,
      removeCoin: terrainRenderer.removeCoin,
      clearCoins: terrainRenderer.clearCoins,
    };

    // Spawn workout checkpoint flags (Three.js mode only)
    if (gameStore.workoutSegments.length > 1) {
      terrainRenderer.spawnCheckpointFlags(gameStore.workoutSegments, pts);
    }

    // Start real-time weather polling using route start coordinates
    weatherApi.startPolling(pts[0].lat, pts[0].lon);
    // Weather: use override from gameStore if set, otherwise use API
    watch(
      [() => weatherApi.weatherType.value, () => gameStore.weatherOverride],
      ([apiType, override]) => {
        const type = (override ?? apiType) as typeof apiType;
        terrainRenderer!.setWeather({ type, sunElevation: 45, sunAzimuth: 180 });
      },
      { immediate: true },
    );

    // Billboard clouds toggle
    watch(
      () => gameStore.cloudsEnabled,
      (enabled) => terrainRenderer!.setCloudsEnabled(enabled),
      { immediate: true },
    );

    // Glasses lens mode
    watch(
      () => gameStore.glassesLens,
      (lens) => terrainRenderer!.setGlassesLens(lens),
      { immediate: true },
    );

    // World style: switch the whole Three.js pipeline (blocks ⇄ paper) live.
    // Skip immediate — init() already applied the initial style.
    watch(
      () => settingsStore.config.map.worldStyle,
      (style) => { void terrainRenderer!.setWorldStyle(style); },
    );

    // Snap camera immediately (dt = 0 for instant). gameStateStore.setRoute
    // already placed the ball at route distance 0.
    const startPos = gameStateStore.position;
    terrainRenderer.updatePosition([startPos.lon, startPos.lat], startPos.ele);
    terrainRenderer.updateCamera(startPos.bearing, 0);
    terrainRenderer.render(0);

    // Rain sound driven by weather (Three.js mode only)
    watch(
      [() => weatherApi.weatherType.value, () => gameStore.weatherOverride],
      ([apiType, override]) => {
        const type = override ?? apiType;
        audioManager.setRain(type === 'rainy' || type === 'snowy');
      },
      { immediate: true },
    );

    // Messages come from the backend (and may go out to an LLM), so they used
    // to hold the game loop hostage on a cold start. Kick it off and let the
    // loop run; the greeting lands when it lands.
    void preloadMessages(() => {
      if (terrainRenderer!.mvtFailed.value) {
        gameMessages.pushMessage('mvt-failed');
      }
      gameMessages.pushMessage('terrain-ready');
      gameMessages.pushMessage('game-start');
    });

    gameLoop.start();
    audioManager.gameStart();
    markFirstFrame();
  } else if (isPhaser.value) {
    // ── Phaser 2D Excitebike mode ──
    const canvas = phaserCanvasRef.value;
    if (!canvas || pts.length === 0) {
      loading.unlock('沒有可用的路線資料');
      return;
    }

    // Size canvas to viewport
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;

    await phaserRenderer.init({ canvas, points: pts });

    // Set coin layer to Phaser renderer
    coinLayer.value = {
      spawnCoin: phaserRenderer.spawnCoin,
      removeCoin: phaserRenderer.removeCoin,
      clearCoins: phaserRenderer.clearCoins,
    };

    // Start real-time weather polling
    weatherApi.startPolling(pts[0].lat, pts[0].lon);
    watch(
      [() => weatherApi.weatherType.value, () => gameStore.weatherOverride],
      ([apiType, override]) => {
        const type = (override ?? apiType) as typeof apiType;
        phaserRenderer.setWeather({ type, sunElevation: 45 });
      },
      { immediate: true },
    );

    // Clouds toggle
    watch(
      () => gameStore.cloudsEnabled,
      (enabled) => phaserRenderer.setCloudsEnabled(enabled),
      { immediate: true },
    );

    // Glasses lens mode (Phaser uses the same store value as Three.js)
    watch(
      () => gameStore.glassesLens,
      (lens) => phaserRenderer.setGlassesLens(lens),
      { immediate: true },
    );

    // Rain sound
    watch(
      [() => weatherApi.weatherType.value, () => gameStore.weatherOverride],
      ([apiType, override]) => {
        const type = override ?? apiType;
        audioManager.setRain(type === 'rainy' || type === 'snowy');
      },
      { immediate: true },
    );

    // Snap initial position
    const startPos = gameStateStore.position;
    phaserRenderer.updatePosition([startPos.lon, startPos.lat], startPos.ele);
    phaserRenderer.updateDistance(0);
    phaserRenderer.render(0);

    // Draw workout segment flags if applicable
    if (gameStore.workoutSegments.length > 1) {
      const totalMs = workoutTracker.totalDurationMs.value;
      const cumDists = buildCumulativeDistances(pts);
      const totalDist = cumDists.length > 0 ? cumDists[cumDists.length - 1] : 0;
      if (totalMs > 0 && totalDist > 0) {
        let cumTime = 0;
        const flags = gameStore.workoutSegments.map((seg: any) => {
          const distM = (cumTime / totalMs) * totalDist;
          cumTime += seg.durationMs;
          return { name: seg.name, color: seg.color, cumulativeDistM: distM };
        });
        phaserRenderer.drawWorkoutSegmentFlags(flags);
      }
    }

    // Watch workout segment changes for zone color filter
    watch(
      () => workoutTracker.currentSegment.value,
      (seg) => {
        const color = seg?.color ?? null;
        phaserRenderer.setWorkoutZoneColor(color);
      },
    );

    // Watch for async MVT failure (fire-and-forget in Phaser)
    watch(
      () => phaserRenderer.mvtFailed.value,
      (failed) => { if (failed) gameMessages.pushMessage('mvt-failed'); },
    );

    void preloadMessages(() => {
      gameMessages.pushMessage('terrain-ready');
      gameMessages.pushMessage('game-start');
    });

    gameLoop.start();
    audioManager.gameStart();
    markFirstFrame();
  } else {
    // ── MapLibre mode (legacy) ──
    // Dynamically import MapLibre composables
    const [{ useMapSetup: createMapSetup }, { useThreeBall: createThreeBall }] = await Promise.all([
      import('@/composables/useMapSetup'),
      import('@/composables/useThreeBall'),
    ]);
    mapSetup = createMapSetup(containerEl);
    threeBall = createThreeBall(
      mapSetup.map,
      mapSetup.mapReady,
      () => mapSetup!.adapter.value?.mercatorFromLngLat,
    );

    await mapSetup.init({
      center: initialCenter,
      style: settingsStore.config.map.basemapStyle,
      renderMode: 'maplibre',
    });

    watch(
      () => mapSetup!.mapReady.value,
      (ready) => {
        if (!ready) return;
        const pts = routePoints.value;
        if (pts.length > 0) {
          mapSetup!.addRouteLayer(pts);

          // Set coin layer to ThreeBallLayer
          coinLayer.value = threeBall!.layer.value;

          const startPos = gameStateStore.position;
          if (mapSetup!.map.value) {
            updateMapLibreCamera(mapSetup!.map.value, startPos, {
              pitch: cameraControl.pitch.value,
            });
          }

          setTimeout(() => {
            void preloadMessages(() => {
              gameMessages.pushMessage('terrain-ready');
              gameMessages.pushMessage('game-start');
            });
            gameLoop.start();
            audioManager.gameStart();
            markFirstFrame();
          }, 500);
        }
      },
      { immediate: true },
    );
  }
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleSpacebar);

  // Belt-and-braces: if the user navigated away (closed tab, browser back,
  // window close) without going through handleStop / time-up, the backend
  // is still in 'recording' state with the ride open. Fire a fire-and-
  // forget stop using sendBeacon so it survives the unload. Falls back to
  // fetch with keepalive when sendBeacon is unavailable.
  if (!stopFinalised && gameStore.currentRideId !== null) {
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/live/stop');
      } else {
        // keepalive lets the request continue after the page unloads.
        fetch('/api/live/stop', { method: 'POST', keepalive: true }).catch(() => {});
      }
    } catch { /* best-effort — orphan recovery will catch it on next boot */ }
  }

  // Close PiP and move content back before disposing
  if (pip.isActive.value && gameContentRef.value && gameViewRef.value) {
    gameViewRef.value.prepend(gameContentRef.value);
  }
  pip.close();

  gameLoop.stop();
  serverCoins.clear();
  windSim.stop();
  gameStateStore.reset();
  ws.disconnect();
  weatherApi.stopPolling();
  terrainRenderer?.dispose();
  phaserRenderer.dispose();
  mapSetup?.dispose();
  audioManager.dispose();
});
</script>

<style scoped>
.game-view {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

.game-content {
  position: relative;
  width: 100%;
  height: 100%;
}

.three-canvas,
.phaser-canvas {
  width: 100vw;
  height: 100vh;
  display: block;
}

.pip-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  background: #050810;
}

.pip-placeholder__icon {
  font-size: 48px;
  color: var(--hud-cyan);
  opacity: 0.4;
}

.pip-placeholder__text {
  font-family: var(--font-display);
  font-size: 16px;
  color: var(--hud-cyan);
  letter-spacing: 4px;
  opacity: 0.6;
}

.pip-placeholder__btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background: rgba(0, 255, 255, 0.1);
  color: var(--hud-cyan);
  border: 1.5px solid rgba(0, 255, 255, 0.3);
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 2px;
  cursor: pointer;
  transition: background 0.2s;
}

.pip-placeholder__btn:hover {
  background: rgba(0, 255, 255, 0.2);
}

.start-prompt {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(5, 8, 16, 0.55);
  backdrop-filter: blur(4px);
  cursor: pointer;
  z-index: 50;
  animation: start-prompt-fade 0.3s ease-out;
}

@keyframes start-prompt-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.start-prompt__panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 32px 56px;
  background: rgba(5, 8, 16, 0.85);
  border: 1.5px solid var(--hud-cyan);
  clip-path: var(--clip-panel-lg);
  box-shadow: 0 0 24px rgba(0, 229, 255, 0.4), 0 0 60px rgba(0, 229, 255, 0.15);
  animation: neon-pulse-border 2s ease-in-out infinite;
}

.start-prompt__icon {
  font-size: 56px;
  color: var(--hud-cyan);
  filter: drop-shadow(0 0 12px rgba(0, 229, 255, 0.7));
}

.start-prompt__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 800;
  color: var(--hud-cyan);
  letter-spacing: 6px;
  text-shadow: 0 0 16px rgba(0, 229, 255, 0.6);
}

.start-prompt__hint {
  margin: 0;
  font-family: var(--font-display);
  font-size: 13px;
  color: var(--hud-text-bright);
  letter-spacing: 2px;
  text-transform: uppercase;
}

.start-prompt__key {
  display: inline-block;
  padding: 4px 12px;
  margin: 0 4px;
  background: rgba(0, 229, 255, 0.18);
  border: 1.5px solid var(--hud-cyan);
  border-radius: 4px;
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  color: var(--hud-cyan);
  text-shadow: 0 0 6px rgba(0, 229, 255, 0.6);
  box-shadow: 0 2px 0 rgba(0, 229, 255, 0.4), inset 0 -2px 0 rgba(0, 229, 255, 0.2);
}

.start-prompt__sub {
  margin: 0;
  font-family: var(--font-display);
  font-size: 10px;
  color: rgba(224, 240, 255, 0.5);
  letter-spacing: 1.5px;
  text-transform: uppercase;
}
</style>

<style>
/* ── HUD theme overrides (non-scoped so they cascade into all HUD children) ── */

/* Plastic + cuphead: drop the cyberpunk neon-pulse animation. Tokens already
   flatten clip-paths and switch fonts via App.vue. */
.game-view[data-world-style="plastic"] .hud-bottom-right,
.game-view[data-world-style="cuphead"] .hud-bottom-right {
  animation: none !important;
}

/* Plastic: chunky toy-like panels everywhere. The top HUD (metrics + coins)
   opts out — it's now a borderless neon/emboss overlay (see HudTopBar/HudCoins). */
.game-view[data-world-style="plastic"] .hud-bottom-left,
.game-view[data-world-style="plastic"] .hud-bottom-right,
.game-view[data-world-style="plastic"] .hud-event-bar,
.game-view[data-world-style="plastic"] .pause-overlay__panel,
.game-view[data-world-style="plastic"] .game-summary__panel,
.game-view[data-world-style="plastic"] .pip-sidebar,
.game-view[data-world-style="plastic"] .minimap {
  border-radius: 18px !important;
  border: 2px solid var(--pl-ink) !important;
  box-shadow: 0 4px 0 var(--pl-ink), 0 8px 14px rgba(var(--pl-pink-rgb), 0.25) !important;
  background: linear-gradient(180deg, rgba(var(--pl-paper-hi-rgb), 0.92) 0%, rgba(var(--pl-paper-rgb), 0.92) 100%) !important;
  text-shadow: none !important;
}

/* Bottom-left inner bars (time + lap) default to var(--hud-bg), which in
   plastic is a dark navy — reads as a dirty grey slab on the candy card.
   Go transparent so the panel's paper gradient (same tone the elevation
   canvas paints) shows through; keep only a soft pink hairline. */
.game-view[data-world-style="plastic"] .hud-bottom-left .hud-progress,
.game-view[data-world-style="plastic"] .hud-bottom-left .hud-lap {
  background: transparent !important;
  border: 1.5px solid rgba(var(--pl-pink-rgb), 0.25) !important;
  border-radius: 12px !important;
}

.game-view[data-world-style="plastic"] .hud-top-bar :is(.metric-value, .stat-value, .time-value),
.game-view[data-world-style="plastic"] .hud-bottom-left .stat-value,
.game-view[data-world-style="plastic"] .hud-bottom-right .stat-value,
.game-view[data-world-style="plastic"] .hud-coins .coin-count {
  color: var(--pl-ink) !important;
  text-shadow: 1px 1px 0 var(--pl-yellow) !important;
}

.game-view[data-world-style="plastic"] .hud-top-bar .metric-label,
.game-view[data-world-style="plastic"] .hud-bottom-left .stat-label,
.game-view[data-world-style="plastic"] .hud-bottom-right .stat-label {
  color: var(--pl-pink) !important;
  text-shadow: none !important;
}

.game-view[data-world-style="plastic"] .pause-overlay,
.game-view[data-world-style="plastic"] .game-summary {
  background: rgba(40, 18, 70, 0.6) !important;
}

.game-view[data-world-style="plastic"] .pause-overlay__title,
.game-view[data-world-style="plastic"] .game-summary__title {
  color: var(--pl-pink) !important;
  text-shadow: 3px 3px 0 var(--pl-ink), 5px 5px 0 var(--pl-cyan) !important;
  letter-spacing: 1px !important;
}

/* Cuphead: paper-card panels with thick ink borders. Top HUD opts out (see above). */
.game-view[data-world-style="cuphead"] .hud-bottom-left,
.game-view[data-world-style="cuphead"] .hud-bottom-right,
.game-view[data-world-style="cuphead"] .hud-event-bar,
.game-view[data-world-style="cuphead"] .pause-overlay__panel,
.game-view[data-world-style="cuphead"] .game-summary__panel,
.game-view[data-world-style="cuphead"] .pip-sidebar,
.game-view[data-world-style="cuphead"] .minimap {
  border-radius: 0 !important;
  border: 3px solid var(--ck-ink) !important;
  box-shadow: 3px 3px 0 var(--ck-ink) !important;
  background:
    repeating-linear-gradient(0deg, rgba(var(--ck-ink-rgb), 0.025) 0 2px, transparent 2px 4px),
    rgba(var(--ck-paper-rgb), 0.94) !important;
  color: var(--ck-ink) !important;
  text-shadow: none !important;
}

/* Minimap opts out of the parchment panel skin in every themed world — it stays
   a clean black tile (border from .minimap-container) so the route never washes
   out against paper and stretching never shows a seam. */
.game-view[data-world-style="plastic"] .minimap,
.game-view[data-world-style="cuphead"] .minimap {
  background: transparent !important;
  box-shadow: none !important;
  border: none !important;
  border-radius: 0 !important;
}

.game-view[data-world-style="cuphead"] .hud-top-bar :is(.metric-value, .stat-value, .time-value),
.game-view[data-world-style="cuphead"] .hud-bottom-left .stat-value,
.game-view[data-world-style="cuphead"] .hud-bottom-right .stat-value,
.game-view[data-world-style="cuphead"] .hud-coins .coin-count {
  color: var(--ck-ink) !important;
  text-shadow: none !important;
}

.game-view[data-world-style="cuphead"] .hud-top-bar .metric-label,
.game-view[data-world-style="cuphead"] .hud-bottom-left .stat-label,
.game-view[data-world-style="cuphead"] .hud-bottom-right .stat-label {
  color: var(--ck-rust) !important;
  text-shadow: none !important;
  letter-spacing: 0.5px !important;
}

.game-view[data-world-style="cuphead"] .pause-overlay,
.game-view[data-world-style="cuphead"] .game-summary {
  background: rgba(40, 30, 18, 0.55) !important;
}

.game-view[data-world-style="cuphead"] .pause-overlay__title,
.game-view[data-world-style="cuphead"] .game-summary__title {
  color: var(--ck-rust) !important;
  text-shadow: 3px 3px 0 var(--ck-ink), 6px 6px 0 var(--ck-gold) !important;
  letter-spacing: 1px !important;
  text-transform: none !important;
  font-weight: 700 !important;
}

/* Soften scanline / glitch effects on the start-prompt for both new themes */
.game-view[data-world-style="plastic"] .start-prompt,
.game-view[data-world-style="cuphead"] .start-prompt {
  background: rgba(0, 0, 0, 0.55) !important;
}

.game-view[data-world-style="plastic"] .start-prompt__panel {
  border: 3px solid var(--pl-ink) !important;
  border-radius: 22px !important;
  background: linear-gradient(180deg, var(--pl-paper-hi) 0%, var(--pl-paper) 100%) !important;
  box-shadow: 0 6px 0 var(--pl-ink), 0 16px 30px rgba(var(--pl-pink-rgb), 0.35) !important;
}

.game-view[data-world-style="plastic"] .start-prompt__title {
  color: var(--pl-pink) !important;
  text-shadow: 2px 2px 0 var(--pl-ink), 4px 4px 0 var(--pl-cyan) !important;
}

.game-view[data-world-style="cuphead"] .start-prompt__panel {
  border: 4px double var(--ck-ink) !important;
  border-radius: 0 !important;
  background:
    repeating-linear-gradient(0deg, rgba(var(--ck-ink-rgb), 0.03) 0 2px, transparent 2px 4px),
    var(--ck-paper) !important;
  box-shadow: 4px 4px 0 var(--ck-ink) !important;
}

.game-view[data-world-style="cuphead"] .start-prompt__title {
  color: var(--ck-rust) !important;
  text-shadow: 3px 3px 0 var(--ck-ink), 5px 5px 0 var(--ck-gold) !important;
  letter-spacing: 1px !important;
  text-transform: none !important;
}
</style>
