<template>
  <div class="game-view" ref="gameViewRef">
    <!-- Game content wrapper — moved between main window and PiP window -->
    <div ref="gameContentRef" class="game-content">
      <MapContainer v-show="isMapLibre" ref="mapContainerRef" />
      <canvas v-show="isThreeJs" ref="threeCanvasRef" class="three-canvas" />
      <canvas v-show="isPhaser" ref="phaserCanvasRef" class="phaser-canvas" />
      <PiPSidebar
        v-if="pip.isActive.value"
        :elapsed-ms="gameLoop.elapsedMs.value"
        :distance-traveled="ballEngine.distanceTraveled.value"
        @stop="handleStop"
      />
    </div>

    <!-- Normal HUD (hidden when PiP is active) -->
    <GlassesOverlay
      v-if="!pip.isActive.value"
      :visible="isThreeJs && gameStore.isPlaying"
      :frame-color="gameStore.glassesFrameColor"
      :frame-material="gameStore.glassesFrameMaterial"
    />
    <Hud
      v-if="!pip.isActive.value"
      :route-points="routePoints"
      :ball-lat="ballEngine.currentPosition.value.lat"
      :ball-lon="ballEngine.currentPosition.value.lon"
      :ball-bearing="ballEngine.currentPosition.value.bearing"
      :elapsed-ms="gameLoop.elapsedMs.value"
      :distance-traveled="ballEngine.distanceTraveled.value"
      :combo="coinSystem.comboMultiplier.value"
      :red-line="coinSystem.redLine.value"
      :virtual-power="ballEngine.speedKmh.value"
      :comparison="comparisonMetrics"
      :stats="gameLoop.stats.value"
      :time-series="gameLoop.timeSeries.value"
      :fps="gameLoop.fps.value"
      :workout-segments="gameStore.workoutSegments"
      :current-segment-index="workoutTracker.currentSegmentIndex.value"
      :target-watts="workoutTracker.targetWatts.value"
      :is-on-target="workoutTracker.isOnTarget.value"
      :current-segment-name="workoutTracker.currentSegment.value?.name ?? ''"
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
      @stop="handleStop"
      @toggle-pip="togglePiP"
      @typewriter-done="gameMessages.onTypewriterDone"
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
import { useBallEngine } from '@/composables/useBallEngine';
import { useGameLoop } from '@/composables/useGameLoop';
import { useCoinSystem } from '@/composables/useCoinSystem';
import { useWebSocket } from '@/composables/useWebSocket';
import { useMockSensor } from '@/composables/useMockSensor';
import { useCoinSpawner } from '@/composables/useCoinSpawner';
import { useCameraControl } from '@/composables/useCameraControl';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSensorStore } from '@/stores/sensorStore';
import { useComparison } from '@/composables/useComparison';
import { useWorkoutTracker } from '@/composables/useWorkoutTracker';
import { useGameMessages } from '@/composables/useGameMessages';
import { useRandomEvents } from '@/composables/useRandomEvents';
import { updateFpsCamera as updateMapLibreCamera } from '@/game/camera';
import type { CoinLayerInterface } from '@/game/coin-interface';
import { setDebugEnabled } from '@/game/debug-logger';
import { AudioManager } from '@/game/audio/audio-manager';
import { useDocumentPiP } from '@/composables/useDocumentPiP';
import { usePlanStore } from '@/stores/planStore';
import MapContainer from '@/components/game/MapContainer.vue';
import GlassesOverlay from '@/components/game/GlassesOverlay.vue';
import Hud from '@/components/game/Hud.vue';
import PiPSidebar from '@/components/game/PiPSidebar.vue';

const router = useRouter();
const routeStore = useRouteStore();
const gameStore = useGameStore();
const settingsStore = useSettingsStore();
const sensorStore = useSensorStore();
const planStore = usePlanStore();

// Redirect if not playing
if (gameStore.state !== 'playing') {
  router.replace('/');
}

const isThreeJs = computed(() => settingsStore.config.map.renderMode === 'threejs');
const isPhaser = computed(() => settingsStore.config.map.renderMode === 'phaser');
const isMapLibre = computed(() => settingsStore.config.map.renderMode === 'maplibre');

const gameViewRef = ref<HTMLElement | null>(null);
const gameContentRef = ref<HTMLElement | null>(null);
const mapContainerRef = ref<InstanceType<typeof MapContainer> | null>(null);
const containerEl = computed(() => mapContainerRef.value?.container ?? null);
const threeCanvasRef = ref<HTMLCanvasElement | null>(null);
const phaserCanvasRef = ref<HTMLCanvasElement | null>(null);

// Document Picture-in-Picture
const pip = useDocumentPiP();

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

// WebSocket or mock sensor
const ws = useWebSocket();
const mock = useMockSensor();

// Lazily loaded renderer composables (dynamically imported in onMounted based on renderMode)
let mapSetup: MapSetupAPI | null = null;
let threeBall: ThreeBallAPI | null = null;
let terrainRenderer: TerrainRendererAPI | null = null;

// Phaser 2D renderer (Excitebike mode)
const phaserRenderer = usePhaserRenderer();

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

// Coin layer: adapts to whichever renderer is active
const coinLayer = shallowRef<CoinLayerInterface | null>(null);

// Ball engine
const ballEngine = useBallEngine(routePoints);

// Coin system
const coinSystem = useCoinSystem();

// Coin spawner (3D coins on route)
const coinSpawner = useCoinSpawner({
  routePoints,
  cumulativeDistsRef: ballEngine.cumulativeDistsRef,
  distanceTraveled: ballEngine.distanceTraveled,
  currentZone: coinSystem.currentZone,
  comboMultiplier: coinSystem.comboMultiplier,
  layer: coinLayer,
  onCoinCollected: () => {
    if (isThreeJs.value) terrainRenderer?.triggerCoinGlow();
    audioManager.coinCollect();
  },
});

// Track last frame time for dt calculation
let lastFrameTime = 0;

// Game loop
const gameLoop = useGameLoop({
  ballTick: (dt) => ballEngine.tick(dt),
  updateBallVisual: () => {
    const pos = ballEngine.currentPosition.value;

    if (isThreeJs.value) {
      terrainRenderer!.updatePosition([pos.lon, pos.lat], pos.ele);
      terrainRenderer!.setDarkened(coinSystem.redLine.value);
      terrainRenderer!.updateDistance(ballEngine.distanceTraveled.value);
    } else if (isPhaser.value) {
      phaserRenderer.updatePosition([pos.lon, pos.lat], pos.ele);
      phaserRenderer.setDarkened(coinSystem.redLine.value);
      phaserRenderer.updateDistance(ballEngine.distanceTraveled.value);
      phaserRenderer.updateSensorData(
        ballEngine.speedKmh.value,
        sensorStore.sc?.cadence ?? 0,
      );
    } else {
      threeBall!.updatePosition([pos.lon, pos.lat], pos.ele);
      threeBall!.setDarkened(coinSystem.redLine.value);
    }

    coinSpawner.updateFrame();
    // Update checkpoint flags (fade passed ones)
    if (isThreeJs.value) {
      terrainRenderer!.updateCheckpointFlags(ballEngine.distanceTraveled.value);
    }
  },
  updateCamera: () => {
    const pos = ballEngine.currentPosition.value;

    // Combine manual yaw (arrow keys) + power-balance steering yaw
    const YAW_SCALE = 0.5;
    const totalYaw = cameraControl.yaw.value
      + ballEngine.steeringAngle.value * YAW_SCALE;
    const effectiveBearing = pos.bearing + totalYaw;

    if (isThreeJs.value) {
      const now = performance.now();
      const dt = lastFrameTime ? (now - lastFrameTime) / 1000 : 0;
      lastFrameTime = now;
      terrainRenderer!.setCameraOptions({
        pitchDeg: cameraControl.pitch.value,
        heightAboveM: cameraControl.height.value,
      });
      terrainRenderer!.updateCamera(effectiveBearing, dt);
      terrainRenderer!.updatePhysiology(
        coinSystem.currentZone.value?.zone ?? null,
        ballEngine.speedKmh.value,
      );
      terrainRenderer!.render(dt);
      // Update wind sound intensity based on speed (Three.js only)
      audioManager.updateWind(ballEngine.speedKmh.value);
    } else if (isPhaser.value) {
      const now = performance.now();
      const dt = lastFrameTime ? (now - lastFrameTime) / 1000 : 0;
      lastFrameTime = now;
      phaserRenderer.updateCamera(effectiveBearing, dt);
      phaserRenderer.render(dt);
      // Update wind sound intensity based on speed (Phaser mode)
      audioManager.updateWind(ballEngine.speedKmh.value);
    } else if (mapSetup?.map.value) {
      updateMapLibreCamera(mapSetup.map.value, { ...pos, bearing: effectiveBearing }, {
        pitch: cameraControl.pitch.value,
      });
    }
    // Pedal click rhythm (all modes)
    audioManager.updateCadence(sensorStore.sc?.cadence ?? 0);
  },
  coinTick: () => {
    coinSystem.tick();
    coinSpawner.spawnBatch();
  },
});

// Comparison mode
const { metrics: comparisonMetrics } = useComparison(gameLoop.elapsedMs);

// Workout tracker (with optional HR for plan-based on-target)
const currentHr = computed(() => sensorStore.hr?.heartRate ?? 0);
const workoutTracker = useWorkoutTracker(
  toRef(gameStore, 'workoutSegments'),
  gameLoop.elapsedMs,
  ballEngine.speedKmh,  // virtual power as proxy for actual power
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
  distanceTraveled: ballEngine.distanceTraveled,
  speedKmh: ballEngine.speedKmh,
  maxSpeed: computed(() => gameLoop.stats.value.maxSpeed),
  maxPower: computed(() => gameLoop.stats.value.maxPower),
  isOnTarget: workoutTracker.isOnTarget,
  weatherType: weatherApi.weatherType,
});

// Random events (freeride challenges)
const savedWeatherType = ref<string | null>(null);
const randomEvents = useRandomEvents({
  elapsedMs: gameLoop.elapsedMs,
  currentPower: ballEngine.speedKmh,  // virtual power as proxy
  currentCadence: computed(() => sensorStore.sc?.cadence ?? 0),
  ftp: computed(() => settingsStore.config.training.ftp),
  selectedWorkoutId: toRef(gameStore, 'selectedWorkoutId'),
  randomEventsEnabled: toRef(gameStore, 'randomEventsEnabled'),
  targetDurationMs: toRef(gameStore, 'targetDurationMs'),
  pushMessage: gameMessages.pushMessage,
  addCoins: (amount) => gameStore.addCoins(amount),
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

// ── Audio event watchers ──

// Workout segment change
watch(
  () => workoutTracker.segmentChanged.value,
  (changed) => {
    if (changed) audioManager.segmentChange();
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

async function handleStop() {
  // Close PiP first so game summary shows in main window
  if (pip.isActive.value) {
    pip.close();
    await nextTick();
  }

  gameLoop.stop();

  // Stop recording on server
  if (gameStore.currentRideId !== null) {
    try {
      await fetch('/api/live/stop', { method: 'POST' });
    } catch {
      // Ignore errors
    }
  }

  gameMessages.pushMessage('game-end');
  audioManager.gameEnd();

  // Record plan completion for all active plans with today's training
  for (const entry of planStore.todaySessions) {
    if (entry.session.type === 'training' && !planStore.isCompleted(entry.plan.id, entry.day)) {
      planStore.recordCompletion(
        entry.plan.id,
        entry.day,
        gameStore.currentRideId ?? undefined,
      );
    }
  }

  gameStore.endGame();
}

// Watch game state
watch(
  () => gameStore.state,
  (state) => {
    if (state === 'ended') {
      gameLoop.stop();
    }
  },
);

onMounted(async () => {
  // Connect sensor
  ws.connect();
  if (import.meta.env.DEV) {
    setTimeout(() => {
      if (ws.status.value !== 'connected') {
        ws.disconnect();
        mock.start();
      }
    }, 3000);
  }

  await nextTick();

  const pts = routePoints.value;
  const initialCenter: [number, number] | undefined =
    pts.length > 0 ? [pts[0].lon, pts[0].lat] : undefined;

  if (isThreeJs.value) {
    // ── Three.js mode ──
    const canvas = threeCanvasRef.value;
    if (!canvas || pts.length === 0) return;

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
    });

    // Set coin layer to terrain renderer
    coinLayer.value = {
      spawnCoin: terrainRenderer.spawnCoin,
      removeCoin: terrainRenderer.removeCoin,
      clearCoins: terrainRenderer.clearCoins,
    };

    ballEngine.initialize();

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

    // Snap camera immediately (dt = 0 for instant)
    const startPos = ballEngine.currentPosition.value;
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

    await gameMessages.preload();
    if (terrainRenderer!.mvtFailed.value) {
      gameMessages.pushMessage('mvt-failed');
    }
    gameMessages.pushMessage('terrain-ready');
    gameLoop.start();
    audioManager.gameStart();
    gameMessages.pushMessage('game-start');
  } else if (isPhaser.value) {
    // ── Phaser 2D Excitebike mode ──
    const canvas = phaserCanvasRef.value;
    if (!canvas || pts.length === 0) return;

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

    ballEngine.initialize();

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
    const startPos = ballEngine.currentPosition.value;
    phaserRenderer.updatePosition([startPos.lon, startPos.lat], startPos.ele);
    phaserRenderer.updateDistance(0);
    phaserRenderer.render(0);

    // Draw workout segment flags if applicable
    if (gameStore.workoutSegments.length > 1) {
      const totalMs = workoutTracker.totalDurationMs.value;
      const cumDists = ballEngine.cumulativeDistsRef.value;
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

    await gameMessages.preload();
    gameMessages.pushMessage('terrain-ready');
    gameLoop.start();
    audioManager.gameStart();
    gameMessages.pushMessage('game-start');
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
          ballEngine.initialize();

          // Set coin layer to ThreeBallLayer
          coinLayer.value = threeBall!.layer.value;

          const startPos = ballEngine.currentPosition.value;
          if (mapSetup!.map.value) {
            updateMapLibreCamera(mapSetup!.map.value, startPos, {
              pitch: cameraControl.pitch.value,
            });
          }

          setTimeout(async () => {
            await gameMessages.preload();
            gameMessages.pushMessage('terrain-ready');
            gameLoop.start();
            audioManager.gameStart();
            gameMessages.pushMessage('game-start');
          }, 500);
        }
      },
      { immediate: true },
    );
  }
});

onUnmounted(() => {
  // Close PiP and move content back before disposing
  if (pip.isActive.value && gameContentRef.value && gameViewRef.value) {
    gameViewRef.value.prepend(gameContentRef.value);
  }
  pip.close();

  gameLoop.stop();
  coinSpawner.dispose();
  mock.stop();
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
  border: 1px solid rgba(0, 255, 255, 0.3);
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
</style>
