/**
 * Vue composable that drives the Phaser-based welcome backdrop.
 *
 * Reuses the same Phaser2DScene the GameView uses (so visual changes to
 * the in-game render — terrain look, cyclist sprite, mountain parallax —
 * automatically propagate to the welcome screen). Boots the scene in
 * 'welcome' mode, which skips the cycling-glasses / tunnel-vision PostFX
 * pipelines and the route km-marker pass.
 *
 * Drives a constant-velocity virtual ride through a synthetic 100 km
 * elevation profile so the world scrolls indefinitely without any sensor
 * data, GPS, or MVT feature dependency.
 *
 * styleVariant changes hot-swap the visual style without rebuilding the
 * Phaser game (no black flash). The scene + weather + cyclist textures
 * each expose a setStrategy / rebuildTextures hook that we call in turn.
 */

import { onBeforeUnmount, toValue, watch, type MaybeRefOrGetter } from 'vue';
import type Phaser from 'phaser';
import { createPhaserGame, type PhaserGameInstance } from '@/game/phaser/phaser-game';
import {
  createStyleStrategy,
  type PhaserStyle,
  type PhaserStyleStrategy,
} from '@/game/phaser/phaser-style-strategy';
import { PhaserWeatherSystem, type WeatherType } from '@/game/phaser/phaser-weather';
import {
  createCyclistSprite,
  updateCyclistSprite,
  rebuildCyclistTextures,
} from '@/game/phaser/cyclist-sprite';
import { PX_PER_METER } from '@/game/phaser/phaser2d-scene';
import {
  TerrainChunkManager2D,
  type ProjectedFeature,
} from '@/game/phaser/terrain-builder';

/** Each demo profile loops every 5 km so the welcome ride visually
 *  repeats every ~12 min @ 25 km/h. The profile array still spans 100 km
 *  (= 20 periods) so a hypothetical four-hour idle never runs off the end,
 *  and we never need to reset distanceM mid-frame (which would jump the
 *  camera). All preset frequencies are integer multiples of 1/PERIOD so
 *  they share PERIOD as their common period. */
const SYNTHETIC_PERIOD_M = 5_000;
const SYNTHETIC_PROFILE_LENGTH_M = 100_000;
const SYNTHETIC_PROFILE_STEP_M = 20;

/** Sun & moon follow the local clock — see init() where we derive a synthetic
 *  lon from the browser's timezone offset so solar noon lines up with the
 *  user's wall-clock noon. Weather follows the StartChecklist override; when
 *  Auto (null) is selected, fall back to sunny since the welcome screen has
 *  no GPS to feed a real weather lookup. */
const WELCOME_WEATHER_FALLBACK: WeatherType = 'sunny';

/** Push the ground/sky boundary down to the bottom 10 % of the canvas, so the
 *  visible green ground band ends up roughly 10–20 % of the screen height (the
 *  rest is sky + parallax mountains + clouds). The exact percentage within
 *  that range depends on the randomly-chosen elevation preset. */
const WELCOME_GROUND_BASELINE = 0.90;

/** Constant scroll speed for the demo cyclist. ~25 km/h ≈ 6.94 m/s feels
 *  like an easy cruise. Cadence chosen so the pedal animation looks lively. */
const WELCOME_SPEED_KMH = 25;
const WELCOME_CADENCE_RPM = 80;
const WELCOME_SPEED_MPS = WELCOME_SPEED_KMH / 3.6;

const TWO_PI = Math.PI * 2;

/** A demo terrain shape. Must be strictly periodic with SYNTHETIC_PERIOD_M
 *  so the profile loops cleanly when distanceM grows past one period. */
type WelcomePreset = (d: number) => number;

const PRESETS: WelcomePreset[] = [
  // rolling — gentle slopes, low frequency dominated
  (d) => {
    const t = d / SYNTHETIC_PERIOD_M;
    return 60
      + 35 * Math.sin(TWO_PI * t)
      + 8 * Math.sin(TWO_PI * t * 3 + 0.7);
  },
  // alpine — sharper peaks via stacked harmonics; phase offset shifts the
  // peak away from the origin so the cyclist doesn't always start atop a hill
  (d) => {
    const t = d / SYNTHETIC_PERIOD_M;
    return 90
      + 55 * Math.sin(TWO_PI * t + 1.2)
      + 22 * Math.sin(TWO_PI * t * 2 + 0.4)
      + 8 * Math.sin(TWO_PI * t * 5);
  },
  // coastal — small amplitude, lots of fine ripple, biased low so the
  // horizon stays close to the rider
  (d) => {
    const t = d / SYNTHETIC_PERIOD_M;
    return 35
      + 12 * Math.sin(TWO_PI * t)
      + 6 * Math.sin(TWO_PI * t * 4 + 1.1)
      + 3 * Math.sin(TWO_PI * t * 8);
  },
  // valley — |sin|-shaped low points connected by humps so the ride feels
  // like cresting and dipping into successive bowls
  (d) => {
    const t = d / SYNTHETIC_PERIOD_M;
    return 50
      + 40 * Math.abs(Math.sin(Math.PI * t))
      + 10 * Math.sin(TWO_PI * t * 4 + 0.3);
  },
];

function buildSyntheticProfile(): { distM: number; eleM: number }[] {
  const preset = PRESETS[Math.floor(Math.random() * PRESETS.length)];
  const profile: { distM: number; eleM: number }[] = [];
  for (let d = 0; d <= SYNTHETIC_PROFILE_LENGTH_M; d += SYNTHETIC_PROFILE_STEP_M) {
    profile.push({ distM: d, eleM: preset(d) });
  }
  // The scene's terrain shader has a vertical-exaggeration baked in (× 4) that
  // amplifies hills aggressively when elevRange < 500 m. With our naturally small
  // synthetic ranges (40–170 m) that pushes the surface above the top of the canvas,
  // hiding sky and parallax mountains. Inflate elevRange via an out-of-view
  // phantom high point so normalisedEle stays small enough to keep the surface
  // mostly near the baseline (≈ 75 % down) while still letting visible hills
  // rise ~80–200 px so the road follows curves instead of looking pancake-flat.
  // Clamp to ≥ 600 m so the scene's `elevRange > 500 ? 2 : 1` divisor stays at 2.
  const actualMin = Math.min(...profile.map((p) => p.eleM));
  const actualMax = Math.max(...profile.map((p) => p.eleM));
  const actualRange = actualMax - actualMin;
  // Multiplier 10 + clamp 600 keeps the per-preset variation in the
  // ~70–100 px band, so combined with WELCOME_GROUND_BASELINE = 0.90 the
  // visible ground band lands roughly in the 16–19 % of canvas height range.
  const phantomMax = actualMin + Math.max(actualRange * 10, 600);
  // distM = -100 sits left of the rider's starting position (≥ ~520 m in world),
  // so drawTerrain's left-cull (visLeft = scrollX − 50) skips this phantom every
  // frame and it never appears in the polygon — it only contributes to elevRange.
  return [{ distM: -100, eleM: phantomMax }, ...profile];
}

/** Sprinkle scenery along the synthetic route. Real game mode pulls features
 *  from OpenStreetMap vector tiles via the rider's GPS; Welcome has no GPS so
 *  we fabricate, but organise into ~1.5 km zone blocks (forest / rural / town
 *  / river) instead of scattering randomly. Within a block, only features
 *  appropriate to its character spawn, so trees stay out of town centres,
 *  lamps line town streets, water sits in dedicated river crossings, etc. */
const BLOCK_M = 1500;
type Zone = 'forest' | 'rural' | 'town' | 'river';

function pickZone(): Zone {
  const r = Math.random();
  if (r < 0.30) return 'forest';
  if (r < 0.70) return 'rural';
  if (r < 0.90) return 'town';
  return 'river';
}

function buildSyntheticFeatures(lengthM: number): ProjectedFeature[] {
  const features: ProjectedFeature[] = [];
  // Buildings carry props.lon/lat hashed into colour/wobble seeds, plus a
  // render_height so cuphead/plastic can pick a façade size. Trees, water,
  // grass, and lamps just need distanceM and a `type`.
  const newBuilding = (distanceM: number): ProjectedFeature => ({
    type: 'building',
    distanceM,
    offsetM: 0,
    props: {
      lon: Math.random() * 360 - 180,
      lat: Math.random() * 180 - 90,
      render_height: 8 + Math.random() * 18,
    },
  });

  let d = 0;
  let lastZone: Zone | null = null;
  while (d < lengthM) {
    const blockEnd = Math.min(d + BLOCK_M, lengthM);
    // Avoid two identical zones in a row so the route feels varied.
    let zone = pickZone();
    if (zone === lastZone) zone = pickZone();
    lastZone = zone;

    if (zone === 'forest') {
      // Dense roadside trees, plus grass patches between trunks.
      for (let td = d + 15; td < blockEnd; td += 35 + Math.random() * 30) {
        features.push({ type: 'tree', distanceM: td, offsetM: 0, props: {} });
      }
      for (let gd = d + 30; gd < blockEnd; gd += 70 + Math.random() * 60) {
        features.push({ type: 'grass', distanceM: gd, offsetM: 0, props: {} });
      }
    } else if (zone === 'rural') {
      // Sparse pastoral countryside — occasional tree, lots of grass.
      for (let td = d + 50; td < blockEnd; td += 150 + Math.random() * 200) {
        features.push({ type: 'tree', distanceM: td, offsetM: 0, props: {} });
      }
      for (let gd = d + 20; gd < blockEnd; gd += 60 + Math.random() * 100) {
        features.push({ type: 'grass', distanceM: gd, offsetM: 0, props: {} });
      }
      // A lone roadside lamp roughly once per rural block.
      if (Math.random() < 0.4) {
        features.push({
          type: 'road',
          distanceM: d + BLOCK_M * (0.3 + Math.random() * 0.4),
          offsetM: 0,
          props: {},
        });
      }
    } else if (zone === 'town') {
      // Tight building row + regular street lamps. No trees in the road corridor.
      for (let bd = d + 20; bd < blockEnd; bd += 55 + Math.random() * 40) {
        features.push(newBuilding(bd));
      }
      // Lamps every ~100 m along the road; the chunk renderer enforces 80 m
      // min spacing so denser placement here is automatically thinned.
      for (let ld = d + 40; ld < blockEnd; ld += 90 + Math.random() * 40) {
        features.push({ type: 'road', distanceM: ld, offsetM: 0, props: {} });
      }
    } else {
      // River crossing — one water body in the middle, grass + sparse trees
      // at the banks (skip features within ±70 m of the water so they don't
      // overlap the river surface).
      const waterCenter = d + BLOCK_M * (0.4 + Math.random() * 0.2);
      features.push({ type: 'water', distanceM: waterCenter, offsetM: 0, props: {} });
      for (let gd = d + 30; gd < blockEnd; gd += 60 + Math.random() * 60) {
        if (Math.abs(gd - waterCenter) < 70) continue;
        features.push({ type: 'grass', distanceM: gd, offsetM: 0, props: {} });
      }
      for (let td = d + 100; td < blockEnd - 100; td += 200 + Math.random() * 120) {
        if (Math.abs(td - waterCenter) < 100) continue;
        features.push({ type: 'tree', distanceM: td, offsetM: 0, props: {} });
      }
    }

    d = blockEnd;
  }

  return features;
}

/** Asphalt strip pinned to the terrain surface so it reads as a road. Sits at
 *  depth 10 — above the terrain fill (0) and below feature chunks (15, where
 *  trees/lamps live), so trees stand on the road shoulder instead of in mid-air. */
const ROAD_DEPTH = 10;
const ROAD_THICKNESS_PX = 10;
const ROAD_COLOR = 0x2c2c2c;
const ROAD_LINE_COLOR = 0xf2d24a;
const ROAD_SAMPLE_STEP_M = 10;

export function useWelcomeBackdrop(
  styleVariant: MaybeRefOrGetter<PhaserStyle>,
  weatherType: MaybeRefOrGetter<WeatherType | null> = () => null,
) {
  const resolveWeather = (): WeatherType =>
    toValue(weatherType) ?? WELCOME_WEATHER_FALLBACK;
  let gameInstance: PhaserGameInstance | null = null;
  let weatherSystem: PhaserWeatherSystem | null = null;
  let chunkManager: TerrainChunkManager2D | null = null;
  let cyclistSprite: Phaser.GameObjects.Sprite | null = null;
  let roadGfx: Phaser.GameObjects.Graphics | null = null;
  let strategy: PhaserStyleStrategy | null = null;
  let raf = 0;
  let lastFrameMs = 0;
  let resizeObs: ResizeObserver | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let canvasEl: HTMLCanvasElement | null = null;

  async function init(canvas: HTMLCanvasElement) {
    canvasEl = canvas;

    // Size canvas to its parent before booting Phaser
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(320, Math.floor(rect.width));
    canvas.height = Math.max(240, Math.floor(rect.height));

    strategy = await createStyleStrategy(toValue(styleVariant));
    gameInstance = await createPhaserGame(canvas, strategy, { mode: 'welcome' });
    await gameInstance.scene.ready;

    // Lower the sky/ground boundary BEFORE setElevationProfile/weather init so
    // the first terrain draw and the sky/parallax layers all see the new value.
    gameInstance.scene.setGroundBaselineFraction(WELCOME_GROUND_BASELINE);

    const profile = buildSyntheticProfile();
    gameInstance.scene.setElevationProfile(profile);

    weatherSystem = new PhaserWeatherSystem(gameInstance.scene, strategy);
    const initialWeather = resolveWeather();
    weatherSystem.setState({ type: initialWeather });
    // Drive sun/moon from the user's local clock. We don't ask for GPS — instead
    // derive a synthetic lon from the browser's timezone so the sun's apparent
    // motion lines up with wall-clock noon/sunset. Lat is fixed mid-latitude so
    // we always get a clean day/night arc regardless of where the user actually is.
    const tzOffsetMin = new Date().getTimezoneOffset();
    const syntheticLon = -tzOffsetMin / 4; // each minute of offset = 0.25° of lon
    weatherSystem.setLocation(25, syntheticLon);

    cyclistSprite = createCyclistSprite(gameInstance.scene, strategy);

    // Sprinkle scenery along the route so Welcome isn't a bare green hillside.
    // Game mode loads features from OSM vector tiles via the rider's GPS; we
    // fabricate the same `ProjectedFeature` shape so chunkManager can render
    // them with the same strategy methods (renderBuilding, renderTree, etc.).
    chunkManager = new TerrainChunkManager2D(
      gameInstance.scene,
      profile,
      buildSyntheticFeatures(SYNTHETIC_PROFILE_LENGTH_M),
      strategy,
    );

    roadGfx = gameInstance.scene.add.graphics();
    roadGfx.setDepth(ROAD_DEPTH);

    // Seed bridge defaults. sunElevation is left at the bridge default — weather
    // overwrites it every frame from getCelestialState now that setLocation is set.
    gameInstance.bridge.speedKmh = WELCOME_SPEED_KMH;
    gameInstance.bridge.cadenceRpm = WELCOME_CADENCE_RPM;
    gameInstance.bridge.weather = initialWeather;
    // Cyclist sits at 50 % of viewport width; the camera centres on it, so
    // scrollX = distanceM*PX_PER_METER − w/2. Terrain only exists for
    // distM ≥ 0, so starting at distanceM = 0 leaves the left half of the
    // screen empty and the green terrain sweeps in from the right over the
    // first few seconds. Pre-advance enough that scrollX > 0 on frame one.
    // Add a random within-period offset so each mount starts at a different
    // hill shape.
    const minOffsetM = canvas.width / (2 * PX_PER_METER) + 200;
    gameInstance.bridge.distanceM = minOffsetM + Math.random() * SYNTHETIC_PERIOD_M;

    // Wire resize observer so the scene reflows when the welcome layout shifts
    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(() => scheduleResize());
      resizeObs.observe(canvas);
    } else {
      window.addEventListener('resize', scheduleResize);
    }

    startLoop();
  }

  function scheduleResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyResize, 200);
  }

  function applyResize() {
    if (!gameInstance || !canvasEl || !weatherSystem) return;
    const rect = canvasEl.getBoundingClientRect();
    const w = Math.max(320, Math.floor(rect.width));
    const h = Math.max(240, Math.floor(rect.height));
    gameInstance.game.scale.resize(w, h);
    gameInstance.scene.onResize(w, h);
    weatherSystem.onResize(w, h);
  }

  function startLoop() {
    cancelAnimationFrame(raf);
    lastFrameMs = 0;
    const tick = (now: number) => {
      if (!gameInstance || !cyclistSprite || !strategy) return;
      const dt = lastFrameMs === 0
        ? 1 / 60
        : Math.min(0.1, (now - lastFrameMs) / 1000);
      lastFrameMs = now;

      // Advance virtual position. We run the cyclist through the entire
      // 100 km profile and stop scrolling at the end — even at 25 km/h
      // that's a four-hour session, way past any realistic welcome use.
      const next = gameInstance.bridge.distanceM + WELCOME_SPEED_MPS * dt;
      gameInstance.bridge.distanceM = Math.min(next, SYNTHETIC_PROFILE_LENGTH_M - 100);

      const distM = gameInstance.bridge.distanceM;
      const worldX = distM * PX_PER_METER;
      const worldY = gameInstance.scene.getTerrainY(distM);
      const slopeDeg = gameInstance.scene.getTerrainSlope(distM);
      const slopePercent = Math.tan(slopeDeg * Math.PI / 180) * 100;

      updateCyclistSprite(
        cyclistSprite,
        {
          worldX,
          worldY,
          slopeDeg,
          cadenceRpm: gameInstance.bridge.cadenceRpm,
          isDarkened: false,
          slopePercent,
          speedKmh: gameInstance.bridge.speedKmh,
        },
        strategy,
      );

      // Page in / out scenery chunks around the rider, and refresh the water
      // shimmer list so the scene's animated shimmer follows newly-loaded ponds.
      if (chunkManager) {
        chunkManager.update(distM);
        gameInstance.scene.setWaterFeatures(chunkManager.getWaterFeatures());
      }

      drawWelcomeRoad();

      weatherSystem?.update();
      gameInstance.tick(dt * 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  /** Paint an asphalt strip following the terrain surface within the camera
   *  viewport. Re-drawn every frame from the scene's getTerrainY so the road
   *  always tracks the (possibly hot-swapped) terrain. */
  function drawWelcomeRoad() {
    if (!roadGfx || !gameInstance) return;
    roadGfx.clear();

    const scene = gameInstance.scene;
    const cam = scene.cameras.main;
    const w = scene.game.canvas.width;
    const visLeftPx = cam.scrollX - 20;
    const visRightPx = cam.scrollX + w + 20;
    const startDist = Math.max(0, visLeftPx / PX_PER_METER);
    const endDist = Math.min(SYNTHETIC_PROFILE_LENGTH_M, visRightPx / PX_PER_METER);
    if (endDist <= startDist) return;

    const top: { x: number; y: number }[] = [];
    for (let d = startDist; d <= endDist; d += ROAD_SAMPLE_STEP_M) {
      top.push({ x: d * PX_PER_METER, y: scene.getTerrainY(d) });
    }
    if (top.length < 2) return;

    // Asphalt body — polygon that hugs the surface on top and drops down by
    // ROAD_THICKNESS_PX to form a flat slab the rider sits on.
    roadGfx.fillStyle(ROAD_COLOR, 1);
    roadGfx.beginPath();
    roadGfx.moveTo(top[0].x, top[0].y);
    for (let i = 1; i < top.length; i++) roadGfx.lineTo(top[i].x, top[i].y);
    for (let i = top.length - 1; i >= 0; i--) {
      roadGfx.lineTo(top[i].x, top[i].y + ROAD_THICKNESS_PX);
    }
    roadGfx.closePath();
    roadGfx.fillPath();

    // Center dashed line at the road's midline — every 4th sample is a 2-sample
    // dash, so dashes are short and gaps comfortable at ROAD_SAMPLE_STEP_M=10m.
    roadGfx.lineStyle(1.5, ROAD_LINE_COLOR, 0.85);
    for (let i = 0; i + 2 < top.length; i += 4) {
      const a = top[i];
      const b = top[i + 2];
      roadGfx.lineBetween(
        a.x,
        a.y + ROAD_THICKNESS_PX / 2,
        b.x,
        b.y + ROAD_THICKNESS_PX / 2,
      );
    }
  }

  watch(
    () => toValue(weatherType),
    () => {
      if (!weatherSystem || !gameInstance) return;
      const next = resolveWeather();
      weatherSystem.setState({ type: next });
      gameInstance.bridge.weather = next;
    },
  );

  watch(
    () => toValue(styleVariant),
    async (newVariant) => {
      if (!gameInstance || !weatherSystem || !cyclistSprite) return;
      const newStrategy = await createStyleStrategy(newVariant);
      strategy = newStrategy;
      gameInstance.scene.setStrategy(newStrategy);
      weatherSystem.setStrategy(newStrategy);
      rebuildCyclistTextures(gameInstance.scene, newStrategy, cyclistSprite);
      // Drop already-rendered chunks so they redraw with the new palette on
      // the next chunkManager.update() (fires on the very next rAF tick).
      chunkManager?.setStrategy(newStrategy);
    },
  );

  async function dispose() {
    cancelAnimationFrame(raf);
    if (resizeTimer) clearTimeout(resizeTimer);
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    } else {
      window.removeEventListener('resize', scheduleResize);
    }
    cyclistSprite?.destroy();
    weatherSystem?.dispose();
    chunkManager?.dispose();
    roadGfx?.destroy();
    gameInstance?.destroy();
    cyclistSprite = null;
    weatherSystem = null;
    chunkManager = null;
    roadGfx = null;
    gameInstance = null;
    strategy = null;
    canvasEl = null;
    // Yield a frame so the Phaser-released WebGL context fully drops before
    // a subsequent GameView mount tries to grab a new one.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }

  onBeforeUnmount(() => {
    void dispose();
  });

  return { init };
}
