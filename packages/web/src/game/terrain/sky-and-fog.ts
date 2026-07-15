/**
 * Dynamic sky, fog, and day/night system driven by real-time astronomical
 * calculations and weather type.
 *
 * Weather types: sunny, cloudy, rainy, snowy
 * Day/night: sun/moon positions computed from route lat/lon + system clock.
 * Moon sprite rendered in the night sky.
 */

import * as THREE from 'three';
import type { GameRenderer } from './game-renderer';
import { getCelestialState, type CelestialState } from './sun-moon-calc';
import { computeDayNightLighting, DEFAULT_SKY_PALETTE } from './day-night-lighting';
import { GradientSky } from './gradient-sky';
import type { SkyPalette } from './terrain-style-strategy';
import { LightningBolt } from './lightning-bolt';
import { cloudShadowUniforms, CLOUD_SHADOW_UV_SCALE } from './cloud-shadow';

/** Scratch colours for the per-frame sky update (avoids per-frame allocation). */
const _skyTop = new THREE.Color();
const _skyBottom = new THREE.Color();

export type WeatherType = 'sunny' | 'cloudy' | 'rainy' | 'snowy';

export interface WeatherConfig {
  type: WeatherType;
  /** Sun elevation angle in degrees (0 = horizon, 90 = overhead). */
  sunElevation: number;
  /** Sun azimuth in degrees (0 = north, clockwise). */
  sunAzimuth: number;
}

/** Rain particle count. */
const RAIN_PARTICLE_COUNT = 3000;

/** Rain drop area around camera (meters). */
const RAIN_AREA = 100;

/** Rain drop fall speed (m/s). */
const RAIN_SPEED = 25;

/** Per-drop fall-speed jitter range (multiplier on RAIN_SPEED / SNOW_SPEED). */
const FALL_SPEED_JITTER_MIN = 0.75;
const FALL_SPEED_JITTER_MAX = 1.25;

/**
 * Max integration step (seconds) for particle animation. A tab switch or
 * frame hitch produces a huge dt; without clamping, every drop overshoots
 * the ground in one frame and gets reset to the same top Y — after which
 * all drops fall in perfect sync as one flat sheet.
 */
const MAX_PARTICLE_DT = 0.1;

/** Snow particle count. */
const SNOW_PARTICLE_COUNT = 2000;

/** Snow area around camera (meters). */
const SNOW_AREA = 120;

/** Snow fall speed (m/s). */
const SNOW_SPEED = 3;

/** Snow horizontal drift speed (m/s). */
const SNOW_DRIFT_SPEED = 1.5;

/** Billboard cloud count. */
const CLOUD_COUNT = 18;

/** Cloud spread area around camera (meters). */
const CLOUD_AREA = 300;

/** Cloud altitude range (meters above terrain). */
const CLOUD_MIN_Y = 200;
const CLOUD_MAX_Y = 400;

/** Cloud horizontal drift speed (m/s). */
const CLOUD_DRIFT_SPEED = 2;

/** Dust particle count (ambient, always-on). */
const DUST_PARTICLE_COUNT = 40;

/** Dust area around camera (meters). */
const DUST_AREA = 60;

/** Dust drift speed (m/s). */
const DUST_DRIFT_SPEED = 0.8;

/** Leaf particle count (ambient, always-on). */
const LEAF_PARTICLE_COUNT = 15;

/** Leaf area around camera (meters). */
const LEAF_AREA = 80;

/** Leaf fall speed (m/s). */
const LEAF_FALL_SPEED = 2;

/** Leaf horizontal drift speed (m/s). */
const LEAF_DRIFT_SPEED = 1.2;

/** Star count on the sky dome. */
const STAR_COUNT = 400;

/** Star dome radius (meters) — must be inside camera far plane but beyond fog. */
const STAR_RADIUS = 2500;

/** Moon sprite distance from camera. */
const MOON_DISTANCE = 3000;

/** Moon sprite scale. */
const MOON_SCALE = 100;

const DEG = Math.PI / 180;

// ── Rainbow (rain→sun celebration, F4) ──
/** Inner radius + band width of the arc, and its distance from the camera (m). */
const RAINBOW_INNER_R = 900;
const RAINBOW_BAND_W = 150;
const RAINBOW_DISTANCE = 1900;
/** Fade-in / hold / fade-out seconds and peak opacity. */
const RAINBOW_FADE_IN = 5;
const RAINBOW_HOLD = 70;
const RAINBOW_FADE_OUT = 15;
const RAINBOW_MAX_OPACITY = 0.5;

// ── Meteor (deep-night streak, F5) ──
/** Star-alpha above which it's "deep night" enough for meteors. */
const METEOR_STAR_ALPHA_MIN = 0.8;
/** Random gap between meteors (seconds). */
const METEOR_MIN_GAP = 60;
const METEOR_MAX_GAP = 240;
/** Meteor streak lifetime (seconds) + geometry (m). */
const METEOR_LIFE_MIN = 0.6;
const METEOR_LIFE_MAX = 1.0;
const METEOR_RADIUS = 2200; // just inside STAR_RADIUS (2500)
const METEOR_LENGTH = 260;
const METEOR_WIDTH = 9;

const UNIT_X = new THREE.Vector3(1, 0, 0);
const UNIT_Y = new THREE.Vector3(0, 1, 0);

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// ── Procedural texture singletons (shared for the app's lifetime; NOT disposed
//    with individual meshes — see removeRainbow/removeMeteor) ──
let _rainbowTex: THREE.CanvasTexture | null = null;
function rainbowTexture(): THREE.CanvasTexture {
  if (_rainbowTex) return _rainbowTex;
  const w = 4, h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  // v across the band (0 = inner/violet, 1 = outer/red), soft alpha at both edges.
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0.00, 'rgba(140,0,200,0)');
  grad.addColorStop(0.12, 'rgba(140,0,200,0.5)');
  grad.addColorStop(0.28, 'rgba(60,60,230,0.55)');
  grad.addColorStop(0.44, 'rgba(0,180,120,0.55)');
  grad.addColorStop(0.60, 'rgba(240,230,0,0.6)');
  grad.addColorStop(0.76, 'rgba(255,140,0,0.6)');
  grad.addColorStop(0.90, 'rgba(230,30,30,0.55)');
  grad.addColorStop(1.00, 'rgba(230,30,30,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  _rainbowTex = new THREE.CanvasTexture(canvas);
  _rainbowTex.needsUpdate = true;
  return _rainbowTex;
}

let _meteorTex: THREE.CanvasTexture | null = null;
function meteorTexture(): THREE.CanvasTexture {
  if (_meteorTex) return _meteorTex;
  const w = 64, h = 16;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  // Tail: brightening gradient toward the head (right end).
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.7, 'rgba(210,230,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0.9)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, h * 0.4, w, h * 0.2);
  // Head glow (radial) at the right end.
  const rg = ctx.createRadialGradient(w - 6, h / 2, 0, w - 6, h / 2, 8);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(w - 16, 0, 16, h);
  _meteorTex = new THREE.CanvasTexture(canvas);
  _meteorTex.needsUpdate = true;
  return _meteorTex;
}

/** Half-arc ribbon in local XY (X right, Y up, bulging over +Y). UV: u along the
 *  arc, v across the band (0 inner → 1 outer). */
function buildRainbowGeometry(): THREE.BufferGeometry {
  const N = 48;
  const ri = RAINBOW_INNER_R;
  const ro = RAINBOW_INNER_R + RAINBOW_BAND_W;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= N; i++) {
    const th = Math.PI * (i / N);
    const c = Math.cos(th), s = Math.sin(th);
    pos.push(c * ri, s * ri, 0); uv.push(i / N, 0);
    pos.push(c * ro, s * ro, 0); uv.push(i / N, 1);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export class SkyAndFog {
  private readonly gameRenderer: GameRenderer;
  private sky: GradientSky | null = null;
  /** Day/night end points — replaced by the world style's on init/style switch. */
  private palette: SkyPalette = DEFAULT_SKY_PALETTE;
  private rainParticles: THREE.Points | null = null;
  private rainGeometry: THREE.BufferGeometry | null = null;
  private rainSpeeds: Float32Array | null = null;
  private snowParticles: THREE.Points | null = null;
  private snowGeometry: THREE.BufferGeometry | null = null;
  private snowSpeeds: Float32Array | null = null;
  private snowTime = 0;
  private moonSprite: THREE.Sprite | null = null;
  private cloudGroup: THREE.Group | null = null;
  private cloudTexture: THREE.Texture | null = null;
  private cloudsEnabled = false;
  private dustParticles: THREE.Points | null = null;
  private dustGeometry: THREE.BufferGeometry | null = null;
  private dustTime = 0;
  private leafParticles: THREE.Points | null = null;
  private leafGeometry: THREE.BufferGeometry | null = null;
  private leafTime = 0;
  private starParticles: THREE.Points | null = null;
  private starGeometry: THREE.BufferGeometry | null = null;
  private currentWeather: WeatherType = 'sunny';

  /** Last weather config seen — the sun position the day/night-off path uses. */
  private lastConfig: WeatherConfig = { type: 'sunny', sunElevation: 45, sunAzimuth: 180 };

  /** Latest computed star opacity (0..1) — drives the meteor's night gate. */
  private currentStarAlpha = 0;

  // Rainbow (F4) — spawned on a rain→sun transition, self-fading.
  private rainbowMesh: THREE.Mesh | null = null;
  private rainbowMat: THREE.MeshBasicMaterial | null = null;
  private rainbowActive = false;
  private rainbowAge = 0;

  // Meteor (F5) — one reused streak mesh, fired at random deep-night intervals.
  private meteorMesh: THREE.Mesh | null = null;
  private meteorMat: THREE.MeshBasicMaterial | null = null;
  private meteorActive = false;
  private meteorAge = 0;
  private meteorLife = METEOR_LIFE_MIN;
  private meteorNextIn = -1; // -1 = unscheduled (schedule on first night frame)
  private readonly meteorVel = new THREE.Vector3();

  /** Route location for astronomical calculations. */
  private latitude = 25.0; // default: ~Taipei
  private longitude = 121.5;

  /** Whether day/night system is enabled. */
  private dayNightEnabled = true;

  /** Seconds since the last day/night recompute. The sun/moon move ~0.25°/min,
   *  so recomputing 60×/s is wasted work — throttle to 4 Hz. Starts at Infinity
   *  so the first frame always runs. */
  private dayNightTimer = Infinity;
  private static readonly DAY_NIGHT_INTERVAL = 0.25;

  /** Latest celestial state (exposed for external consumers like player lights). */
  private _celestial: CelestialState | null = null;

  /**
   * Wind vector in scene-space metres/sec, with a gust amplitude factor.
   * Direction follows particle flow (= meteorological wind dir + 180°).
   */
  private wind = { vx: 0, vz: 0, gust: 1 };

  /** Lightning bolt sprite (created in init). */
  private lightning: LightningBolt | null = null;

  constructor(gameRenderer: GameRenderer) {
    this.gameRenderer = gameRenderer;
  }

  /**
   * Update wind state (used by particles + cloud drift).
   * @param speedKmh meteorological wind speed
   * @param directionDeg meteorological direction (0=N, where wind comes from)
   * @param gust amplitude multiplier for visual swaying (1 = neutral)
   */
  setWind(speedKmh: number, directionDeg: number, gust = 1): void {
    // Particles flow opposite to "wind from" direction.
    const speedMs = (speedKmh / 3.6) * 0.6; // 0.6 visual compression
    const rad = (directionDeg + 180) * DEG;
    this.wind.vx = Math.sin(rad) * speedMs;
    this.wind.vz = -Math.cos(rad) * speedMs;
    this.wind.gust = Math.max(0.5, Math.min(2, gust));
  }

  /** Get current celestial state (null if day/night is disabled). */
  get celestial(): CelestialState | null {
    return this._celestial;
  }

  /** Set the geographic location of the route for sun/moon calculation. */
  setLocation(latitude: number, longitude: number): void {
    this.latitude = latitude;
    this.longitude = longitude;
  }

  /** Enable or disable the day/night cycle. */
  setDayNightEnabled(enabled: boolean): void {
    this.dayNightEnabled = enabled;
    if (!enabled && this.moonSprite) {
      this.moonSprite.visible = false;
    }
  }

  /**
   * Adopt the world style's day/night palette. Call on init and on style switch;
   * the next update() picks it up.
   */
  setPalette(palette: SkyPalette): void {
    this.palette = palette;
    if (!this.dayNightEnabled) {
      // That path only recomputes on setWeather — refresh it against the new
      // palette now, or a style switch would leave the old style's sky up.
      this.applyLighting(this.legacyCelestial(this.lastConfig), null);
    }
  }

  /** Initialize the sky. Call once after GameRenderer is set up. */
  init(): void {
    // A flat gradient dome, not a physical atmosphere — see gradient-sky.ts.
    this.sky = new GradientSky(this.gameRenderer.scene);

    // Moon sprite — always created, visibility toggled
    this.createMoonSprite();

    // Default to sunny daytime
    this.setWeather({ type: 'sunny', sunElevation: 45, sunAzimuth: 180 });

    // Stars — created once, visibility toggled by day/night
    this.createStars();

    // Ambient particles (always-on, any weather)
    this.createDust();
    this.createLeaves();

    // Lightning bolt (always created; opacity-driven visibility)
    this.lightning = new LightningBolt(this.gameRenderer.scene);
  }

  /** Trigger a lightning flash + 70% chance follow-up strike. */
  triggerLightning(intensityMul = 1): void {
    if (!this.lightning) return;
    this.lightning.trigger(intensityMul);
    if (Math.random() < 0.7) {
      const delay = 80 + Math.random() * 60;
      setTimeout(() => {
        this.lightning?.trigger(intensityMul * 0.7);
      }, delay);
    }
  }

  /** Update weather type. The day/night system overrides sun position. */
  setWeather(config: WeatherConfig): void {
    const prevWeather = this.currentWeather;
    this.currentWeather = config.type;
    this.lastConfig = config;

    // Rain → sun in daylight: reward the rider with a rainbow (F4).
    if (prevWeather === 'rainy' && config.type === 'sunny'
        && (this._celestial?.sunElevation ?? 45) > 5) {
      this.spawnRainbow();
    }

    // The gradient dome is ALWAYS visible — it just greys over in overcast. (The
    // old Preetham dome had to be hidden for non-sunny weather because it blew
    // out to white at the horizon, which left the scene with a flat background.)

    if (!this.dayNightEnabled) {
      // Day/night off: light from the sun position the caller handed us, through
      // the same palette pipeline, so "no day/night" == the demo's daylight.
      this.applyLighting(this.legacyCelestial(config), null);
    }
    // When day/night is enabled, update() handles everything per-frame.

    this.updateRain(config.type === 'rainy');
    this.updateSnow(config.type === 'snowy');
  }

  /**
   * Per-frame update. Call from game loop.
   * Animates rain, updates sun/moon positions, and adjusts lighting.
   */
  update(dt: number, cameraPosition: THREE.Vector3): void {
    // GameView passes raw frame dt (unclamped) — cap it so a tab switch or
    // hitch doesn't teleport every particle past its wrap boundary at once.
    dt = Math.min(dt, MAX_PARTICLE_DT);

    // The dome is centred on the rider EVERY frame — the lighting recompute below
    // is throttled to 4 Hz, and a dome that only re-centres 4×/s visibly lags.
    this.sky?.update(cameraPosition);

    if (this.dayNightEnabled) {
      this.dayNightTimer += dt;
      if (this.dayNightTimer >= SkyAndFog.DAY_NIGHT_INTERVAL) {
        this.dayNightTimer = 0;
        this.updateDayNight(cameraPosition);
      }
    }

    if (this.currentWeather === 'rainy' && this.rainGeometry) {
      this.animateRain(dt, cameraPosition);
    }

    if (this.currentWeather === 'snowy' && this.snowGeometry) {
      this.animateSnow(dt, cameraPosition);
    }

    if (this.cloudsEnabled && this.cloudGroup) {
      this.animateClouds(dt, cameraPosition);
    }

    // Ambient particles (always active)
    if (this.dustGeometry) this.animateDust(dt, cameraPosition);
    if (this.leafGeometry) this.animateLeaves(dt, cameraPosition);

    // Rainbow (F4) + meteor (F5) — cheap no-ops when inactive.
    if (this.rainbowActive) this.updateRainbow(dt, cameraPosition);
    this.updateMeteor(dt, cameraPosition);

    // Cloud shadows (F3) — drift + strength into the shared terrain uniforms.
    this.updateCloudShadow(dt);

    // Lightning fade + reposition
    this.lightning?.update(dt, cameraPosition, this.gameRenderer.camera.quaternion);
  }

  dispose(): void {
    if (this.sky) {
      this.sky.dispose();
      this.sky = null;
    }
    this.disposeMoonSprite();
    this.removeRain();
    this.removeSnow();
    this.removeClouds();
    if (this.cloudTexture) {
      this.cloudTexture.dispose();
      this.cloudTexture = null;
    }
    this.removeDust();
    this.removeLeaves();
    this.removeStars();
    this.removeRainbow();
    this.removeMeteor();
    this.lightning?.dispose();
    this.lightning = null;
  }

  // ── Day/Night core ──

  private updateDayNight(cameraPosition: THREE.Vector3): void {
    const celestial = getCelestialState(this.latitude, this.longitude);
    this._celestial = celestial;
    this.applyLighting(celestial, cameraPosition);
  }

  /**
   * Synthesise a celestial state from a caller-supplied sun position, for the
   * day/night-disabled path. Moon mirrors the sun so the key light has somewhere
   * to sit if the caller hands us a night-time elevation.
   */
  private legacyCelestial(config: WeatherConfig): CelestialState {
    return {
      sunElevation: config.sunElevation,
      sunAzimuth: config.sunAzimuth,
      moonElevation: config.sunElevation,
      moonAzimuth: config.sunAzimuth,
      moonPhase: 0.5,
      isDaytime: config.sunElevation > 0,
      dayFactor: config.sunElevation > 0 ? 1 : 0,
    };
  }

  /**
   * The single lighting path: celestial state + weather + the style's palette →
   * sky gradient, fog, the three lights, exposure. Used by both the day/night
   * cycle and the day/night-disabled path, so they can never drift apart.
   */
  private applyLighting(
    celestial: CelestialState,
    cameraPosition: THREE.Vector3 | null,
  ): void {
    const lighting = computeDayNightLighting(celestial, this.currentWeather, this.palette);

    // Sky dome — always visible, colours carry the hour and the weather.
    if (this.sky) {
      this.sky.setColors(
        _skyTop.setHex(lighting.skyTopColor),
        _skyBottom.setHex(lighting.skyBottomColor),
      );
      if (cameraPosition) this.sky.update(cameraPosition);
    }

    const { ambientLight, directionalLight, hemisphereLight } = this.gameRenderer;
    ambientLight.intensity = lighting.ambientIntensity;
    ambientLight.color.setHex(lighting.ambientColor);
    directionalLight.intensity = lighting.directionalIntensity;
    directionalLight.color.setHex(lighting.directionalColor);
    hemisphereLight.intensity = lighting.hemisphereIntensity;
    hemisphereLight.color.setHex(lighting.hemisphereColor);
    hemisphereLight.groundColor.setHex(lighting.hemisphereGroundColor);

    // Key light follows sun (daytime) or moon (nighttime). Clamp its elevation
    // so surfaces stay lit even when the source is at/below the horizon.
    const MIN_LIGHT_ELEV = 15;
    const elev = celestial.isDaytime ? celestial.sunElevation : celestial.moonElevation;
    const azim = celestial.isDaytime ? celestial.sunAzimuth : celestial.moonAzimuth;
    directionalLight.position.setFromSphericalCoords(
      200,
      DEG * (90 - Math.max(MIN_LIGHT_ELEV, elev)),
      DEG * azim,
    );

    this.gameRenderer.setFog(lighting.fogNear, lighting.fogFar, lighting.fogColor);
    this.gameRenderer.setBackground(lighting.backgroundColor);
    this.gameRenderer.setToneMappingExposure(lighting.toneMappingExposure);

    if (cameraPosition) {
      this.updateMoonSprite(celestial, cameraPosition);
      this.updateStars(celestial, cameraPosition);
    }
  }

  // ── Moon sprite ──

  private createMoonSprite(): void {
    // Procedural moon texture: white circle with soft edge
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // Radial gradient: bright center → transparent edge
    const gradient = ctx.createRadialGradient(
      size / 2, size / 2, 0,
      size / 2, size / 2, size / 2,
    );
    gradient.addColorStop(0, 'rgba(255, 253, 240, 1.0)');
    gradient.addColorStop(0.6, 'rgba(255, 253, 240, 0.9)');
    gradient.addColorStop(0.85, 'rgba(230, 230, 210, 0.3)');
    gradient.addColorStop(1, 'rgba(200, 200, 180, 0.0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.moonSprite = new THREE.Sprite(material);
    this.moonSprite.scale.setScalar(MOON_SCALE);
    this.moonSprite.visible = false;
    this.gameRenderer.scene.add(this.moonSprite);
  }

  private updateMoonSprite(
    celestial: CelestialState,
    cameraPosition: THREE.Vector3,
  ): void {
    if (!this.moonSprite) return;

    // Show moon when sun is below ~5° (approaching/during night)
    const showMoon = celestial.sunElevation < 5 && celestial.moonElevation > -5;
    this.moonSprite.visible = showMoon;

    if (!showMoon) return;

    // Position moon using spherical coordinates relative to camera
    const phi = DEG * (90 - celestial.moonElevation);
    const theta = DEG * celestial.moonAzimuth;
    const pos = new THREE.Vector3().setFromSphericalCoords(MOON_DISTANCE, phi, theta);
    this.moonSprite.position.copy(cameraPosition).add(pos);

    // Brightness based on moon phase (full moon = brightest)
    const fullness = 1 - 2 * Math.abs(celestial.moonPhase - 0.5);
    const opacity = 0.3 + 0.7 * fullness;
    (this.moonSprite.material as THREE.SpriteMaterial).opacity = opacity;

    // Scale slightly with fullness
    const scale = MOON_SCALE * (0.8 + 0.2 * fullness);
    this.moonSprite.scale.setScalar(scale);
  }

  private disposeMoonSprite(): void {
    if (this.moonSprite) {
      this.gameRenderer.scene.remove(this.moonSprite);
      const mat = this.moonSprite.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
      this.moonSprite = null;
    }
  }

  // ── Stars ──

  /** Star texture: tiny radial glow (8×8). */
  private static createStarTexture(): THREE.CanvasTexture {
    const size = 8;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(
      size / 2, size / 2, 0,
      size / 2, size / 2, size / 2,
    );
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
    gradient.addColorStop(0.3, 'rgba(255, 255, 255, 0.8)');
    gradient.addColorStop(0.7, 'rgba(200, 210, 255, 0.2)');
    gradient.addColorStop(1, 'rgba(200, 210, 255, 0.0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private createStars(): void {
    this.starGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(STAR_COUNT * 3);

    for (let i = 0; i < STAR_COUNT; i++) {
      // Random position on upper hemisphere shell
      const elevation = (10 + Math.random() * 75) * DEG; // 10°–85° above horizon
      const azimuth = Math.random() * Math.PI * 2;
      const r = STAR_RADIUS;

      positions[i * 3] = r * Math.cos(elevation) * Math.sin(azimuth);
      positions[i * 3 + 1] = r * Math.sin(elevation); // y = up
      positions[i * 3 + 2] = r * Math.cos(elevation) * Math.cos(azimuth);
    }

    this.starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 2.5,
      sizeAttenuation: false, // size in screen pixels — visible at any distance
      map: SkyAndFog.createStarTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false, // stars are beyond fog distance, don't fade them
      blending: THREE.AdditiveBlending,
    });

    this.starParticles = new THREE.Points(this.starGeometry, material);
    this.starParticles.visible = false;
    this.gameRenderer.scene.add(this.starParticles);
  }

  private updateStars(celestial: CelestialState, cameraPosition: THREE.Vector3): void {
    if (!this.starParticles) return;

    const sunElev = celestial.sunElevation;

    // Compute base opacity from sun elevation:
    //   > 0°  → 0 (hidden)
    //   0° to -6° → fade in 0→1
    //   < -6° → 1 (full)
    let baseOpacity: number;
    if (sunElev > 0) {
      baseOpacity = 0;
    } else if (sunElev > -6) {
      baseOpacity = -sunElev / 6; // 0 at 0°, 1 at -6°
    } else {
      baseOpacity = 1;
    }

    // Weather dimming: clouds/rain/snow reduce star visibility
    let weatherMul = 1;
    switch (this.currentWeather) {
      case 'cloudy': weatherMul = 0.15; break;
      case 'rainy':  weatherMul = 0.05; break;
      case 'snowy':  weatherMul = 0.1;  break;
    }

    const finalOpacity = baseOpacity * weatherMul;
    this.currentStarAlpha = finalOpacity; // meteor night gate reads this
    this.starParticles.visible = finalOpacity > 0.01;

    if (this.starParticles.visible) {
      (this.starParticles.material as THREE.PointsMaterial).opacity = finalOpacity;
      // Center star dome on camera so stars stay at consistent distance
      this.starParticles.position.x = cameraPosition.x;
      this.starParticles.position.z = cameraPosition.z;
    }
  }

  // ── Cloud shadows (F3) ──

  /** Advance the shared cloud-shadow uniforms: drift with wind, strength by
   *  weather × daylight. Updates two shared uniforms → all terrain chunks. */
  private updateCloudShadow(dt: number): void {
    const day = this._celestial?.dayFactor ?? 1;
    let target = 0;
    if (this.currentWeather === 'sunny') target = 0.10;
    else if (this.currentWeather === 'cloudy') target = 0.18;
    target *= day; // fade out at night

    const cur = cloudShadowUniforms.uCloudStrength.value;
    cloudShadowUniforms.uCloudStrength.value = cur + (target - cur) * Math.min(1, dt * 2);

    // Drift = gentle base breeze + wind, converted metres → UV.
    const BASE_VX = 1.2, BASE_VZ = 0.5;
    const off = cloudShadowUniforms.uCloudOffset.value;
    off.x += (BASE_VX + this.wind.vx) * dt * CLOUD_SHADOW_UV_SCALE;
    off.y += (BASE_VZ + this.wind.vz) * dt * CLOUD_SHADOW_UV_SCALE;
  }

  // ── Rainbow (F4) ──

  /** Spawn (or restart) the rainbow arc. Cheap geometry, self-fading. */
  private spawnRainbow(): void {
    if (this.rainbowActive) { this.rainbowAge = 0; return; }
    const geo = buildRainbowGeometry();
    const mat = new THREE.MeshBasicMaterial({
      map: rainbowTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -40; // in the sky, behind foreground scenery
    this.gameRenderer.scene.add(mesh);
    this.rainbowMesh = mesh;
    this.rainbowMat = mat;
    this.rainbowActive = true;
    this.rainbowAge = 0;
  }

  private updateRainbow(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.rainbowMesh || !this.rainbowMat) return;
    this.rainbowAge += dt;

    const total = RAINBOW_FADE_IN + RAINBOW_HOLD + RAINBOW_FADE_OUT;
    let k: number;
    if (this.rainbowAge < RAINBOW_FADE_IN) {
      k = this.rainbowAge / RAINBOW_FADE_IN;
    } else if (this.rainbowAge < RAINBOW_FADE_IN + RAINBOW_HOLD) {
      k = 1;
    } else if (this.rainbowAge < total) {
      k = 1 - (this.rainbowAge - RAINBOW_FADE_IN - RAINBOW_HOLD) / RAINBOW_FADE_OUT;
    } else {
      this.removeRainbow();
      return;
    }
    this.rainbowMat.opacity = k * RAINBOW_MAX_OPACITY;

    // Sit opposite the sun, standing upright, facing the camera.
    const az = ((this._celestial?.sunAzimuth ?? 180) + 180) * DEG;
    const cx = cameraPosition.x + Math.sin(az) * RAINBOW_DISTANCE;
    const cz = cameraPosition.z + Math.cos(az) * RAINBOW_DISTANCE;
    this.rainbowMesh.position.set(cx, cameraPosition.y, cz);

    const toCam = new THREE.Vector3(cameraPosition.x - cx, 0, cameraPosition.z - cz).normalize();
    const right = new THREE.Vector3().crossVectors(UNIT_Y, toCam).normalize();
    const basis = new THREE.Matrix4().makeBasis(right, UNIT_Y, toCam);
    this.rainbowMesh.quaternion.setFromRotationMatrix(basis);
  }

  private removeRainbow(): void {
    if (this.rainbowMesh) {
      this.gameRenderer.scene.remove(this.rainbowMesh);
      this.rainbowMesh.geometry.dispose();
      this.rainbowMat?.dispose(); // NB: shared rainbowTexture() singleton is NOT disposed
      this.rainbowMesh = null;
      this.rainbowMat = null;
    }
    this.rainbowActive = false;
  }

  // ── Meteor (F5) ──

  private ensureMeteor(): void {
    if (this.meteorMesh) return;
    const geo = new THREE.PlaneGeometry(METEOR_LENGTH, METEOR_WIDTH);
    const mat = new THREE.MeshBasicMaterial({
      map: meteorTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 5;
    this.gameRenderer.scene.add(mesh);
    this.meteorMesh = mesh;
    this.meteorMat = mat;
  }

  private updateMeteor(dt: number, cameraPosition: THREE.Vector3): void {
    const isNight = this.currentStarAlpha >= METEOR_STAR_ALPHA_MIN;

    if (this.meteorActive && this.meteorMesh && this.meteorMat) {
      this.meteorAge += dt;
      const t = this.meteorAge / this.meteorLife;
      if (t >= 1 || !isNight) {
        this.meteorMesh.visible = false;
        this.meteorActive = false;
        this.meteorNextIn = randRange(METEOR_MIN_GAP, METEOR_MAX_GAP);
        return;
      }
      this.meteorMesh.position.addScaledVector(this.meteorVel, dt);
      this.meteorMat.opacity = Math.sin(t * Math.PI); // 0 → 1 → 0
      return;
    }

    if (!isNight) return;
    if (this.meteorNextIn < 0) { // first night frame — schedule, don't fire yet
      this.meteorNextIn = randRange(METEOR_MIN_GAP, METEOR_MAX_GAP);
      return;
    }
    this.meteorNextIn -= dt;
    if (this.meteorNextIn <= 0) this.spawnMeteor(cameraPosition);
  }

  private spawnMeteor(cameraPosition: THREE.Vector3): void {
    this.ensureMeteor();
    if (!this.meteorMesh || !this.meteorMat) return;

    // Random start high on the dome shell, relative to the camera.
    const az = Math.random() * Math.PI * 2;
    const elev = (35 + Math.random() * 40) * DEG;
    const r = METEOR_RADIUS;
    const sx = r * Math.cos(elev) * Math.sin(az);
    const sy = r * Math.sin(elev);
    const sz = r * Math.cos(elev) * Math.cos(az);
    this.meteorMesh.position.set(cameraPosition.x + sx, cameraPosition.y + sy, cameraPosition.z + sz);

    // Mostly-downward direction; head (local +X) leads.
    const dir = new THREE.Vector3(
      (Math.random() - 0.5) * 0.8,
      -(0.5 + Math.random() * 0.5),
      (Math.random() - 0.5) * 0.8,
    ).normalize();
    this.meteorLife = randRange(METEOR_LIFE_MIN, METEOR_LIFE_MAX);
    this.meteorVel.copy(dir).multiplyScalar((r * 0.5) / this.meteorLife); // travel ~0.5R over life
    this.meteorMesh.quaternion.setFromUnitVectors(UNIT_X, dir);

    this.meteorMat.opacity = 0;
    this.meteorMesh.visible = true;
    this.meteorActive = true;
    this.meteorAge = 0;
  }

  private removeMeteor(): void {
    if (this.meteorMesh) {
      this.gameRenderer.scene.remove(this.meteorMesh);
      this.meteorMesh.geometry.dispose();
      this.meteorMat?.dispose(); // shared meteorTexture() singleton NOT disposed
      this.meteorMesh = null;
      this.meteorMat = null;
    }
    this.meteorActive = false;
  }

  private removeStars(): void {
    if (this.starParticles) {
      this.gameRenderer.scene.remove(this.starParticles);
      this.starGeometry?.dispose();
      const mat = this.starParticles.material as THREE.PointsMaterial;
      mat.map?.dispose();
      mat.dispose();
      this.starParticles = null;
      this.starGeometry = null;
    }
  }

  // ── Procedural textures (Canvas API, no image files) ──

  /** Raindrop texture: elongated ellipse (16×64). */
  private static createRainTexture(): THREE.CanvasTexture {
    const w = 16, h = 64;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(w / 2, 0, w / 2, h);
    gradient.addColorStop(0, 'rgba(180, 200, 255, 0)');
    gradient.addColorStop(0.3, 'rgba(180, 200, 255, 0.6)');
    gradient.addColorStop(0.7, 'rgba(200, 220, 255, 0.9)');
    gradient.addColorStop(1, 'rgba(220, 235, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2 - 1, h / 2 - 1, 0, 0, Math.PI * 2);
    ctx.fill();
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  /** Snowflake texture: soft radial glow (32×32). */
  private static createSnowTexture(): THREE.CanvasTexture {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(
      size / 2, size / 2, 0,
      size / 2, size / 2, size / 2,
    );
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
    gradient.addColorStop(0.4, 'rgba(255, 255, 255, 0.8)');
    gradient.addColorStop(0.7, 'rgba(240, 245, 255, 0.3)');
    gradient.addColorStop(1, 'rgba(220, 230, 255, 0.0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  /** Cloud billboard texture: fluffy cloud shape (256×128). */
  private static createCloudTexture(): THREE.CanvasTexture {
    const w = 256, h = 128;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;

    // Draw overlapping ellipses to simulate a fluffy cloud shape
    ctx.globalCompositeOperation = 'source-over';
    const blobs = [
      { x: 0.5, y: 0.55, rx: 0.35, ry: 0.35 },
      { x: 0.3, y: 0.6, rx: 0.25, ry: 0.28 },
      { x: 0.7, y: 0.6, rx: 0.25, ry: 0.28 },
      { x: 0.2, y: 0.65, rx: 0.18, ry: 0.2 },
      { x: 0.8, y: 0.65, rx: 0.18, ry: 0.2 },
      { x: 0.4, y: 0.45, rx: 0.22, ry: 0.25 },
      { x: 0.6, y: 0.45, rx: 0.22, ry: 0.25 },
    ];

    for (const blob of blobs) {
      const cx = blob.x * w;
      const cy = blob.y * h;
      const rx = blob.rx * w;
      const ry = blob.ry * h;
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
      gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.5)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  // ── Billboard clouds ──

  /** Enable or disable billboard cloud layer. */
  setCloudsEnabled(enabled: boolean): void {
    this.cloudsEnabled = enabled;
    if (enabled && !this.cloudGroup) {
      this.createClouds();
    } else if (!enabled && this.cloudGroup) {
      this.removeClouds();
    }
  }

  private createClouds(): void {
    if (!this.cloudTexture) {
      this.cloudTexture = SkyAndFog.createCloudTexture();
    }

    this.cloudGroup = new THREE.Group();

    for (let i = 0; i < CLOUD_COUNT; i++) {
      const width = 50 + Math.random() * 100;
      const height = width * 0.4 + Math.random() * width * 0.2;
      const geometry = new THREE.PlaneGeometry(width, height);
      const material = new THREE.MeshBasicMaterial({
        map: this.cloudTexture,
        transparent: true,
        opacity: 0.4 + Math.random() * 0.3,
        side: THREE.DoubleSide,
        depthWrite: false,
      });

      const mesh = new THREE.Mesh(geometry, material);
      // Random position within cloud area
      mesh.position.set(
        (Math.random() - 0.5) * CLOUD_AREA,
        CLOUD_MIN_Y + Math.random() * (CLOUD_MAX_Y - CLOUD_MIN_Y),
        (Math.random() - 0.5) * CLOUD_AREA,
      );
      // Face downward (horizontal plane) with slight random rotation
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = Math.random() * Math.PI * 2;
      // Store a per-cloud drift offset for variation
      mesh.userData.driftOffset = Math.random() * Math.PI * 2;

      this.cloudGroup.add(mesh);
    }

    this.gameRenderer.scene.add(this.cloudGroup);
  }

  private removeClouds(): void {
    if (this.cloudGroup) {
      this.gameRenderer.scene.remove(this.cloudGroup);
      for (const child of this.cloudGroup.children) {
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      this.cloudGroup = null;
    }
  }

  private animateClouds(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.cloudGroup) return;

    // Keep cloud group centered on camera XZ
    this.cloudGroup.position.x = cameraPosition.x;
    this.cloudGroup.position.z = cameraPosition.z;

    // Gentle drift + wind transport (clouds drift ~2× ground particle speed)
    const windScale = 2;
    const now = performance.now();
    for (const child of this.cloudGroup.children) {
      const mesh = child as THREE.Mesh;
      const offset = mesh.userData.driftOffset as number;
      mesh.position.x += (Math.sin(offset + now * 0.0003) * CLOUD_DRIFT_SPEED       + this.wind.vx * windScale) * dt;
      mesh.position.z += (Math.cos(offset + now * 0.0002) * CLOUD_DRIFT_SPEED * 0.5 + this.wind.vz * windScale) * dt;

      // Wrap around if drifted too far from center
      const halfArea = CLOUD_AREA / 2;
      if (mesh.position.x > halfArea) mesh.position.x -= CLOUD_AREA;
      if (mesh.position.x < -halfArea) mesh.position.x += CLOUD_AREA;
      if (mesh.position.z > halfArea) mesh.position.z -= CLOUD_AREA;
      if (mesh.position.z < -halfArea) mesh.position.z += CLOUD_AREA;
    }
  }

  // ── Dust (ambient) ──

  /** Dust texture: small warm-toned radial dot (16×16). */
  private static createDustTexture(): THREE.CanvasTexture {
    const size = 16;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(
      size / 2, size / 2, 0,
      size / 2, size / 2, size / 2,
    );
    gradient.addColorStop(0, 'rgba(210, 190, 150, 0.7)');
    gradient.addColorStop(0.5, 'rgba(210, 190, 150, 0.3)');
    gradient.addColorStop(1, 'rgba(210, 190, 150, 0.0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private createDust(): void {
    this.dustGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(DUST_PARTICLE_COUNT * 3);

    for (let i = 0; i < DUST_PARTICLE_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * DUST_AREA;
      positions[i * 3 + 1] = 0.5 + Math.random() * 7.5; // y: 0.5–8m
      positions[i * 3 + 2] = (Math.random() - 0.5) * DUST_AREA;
    }

    this.dustGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3),
    );

    const material = new THREE.PointsMaterial({
      color: 0xd2be96,
      size: 0.15,
      map: SkyAndFog.createDustTexture(),
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });

    this.dustParticles = new THREE.Points(this.dustGeometry, material);
    this.gameRenderer.scene.add(this.dustParticles);
  }

  private removeDust(): void {
    if (this.dustParticles) {
      this.gameRenderer.scene.remove(this.dustParticles);
      this.dustGeometry?.dispose();
      (this.dustParticles.material as THREE.Material).dispose();
      this.dustParticles = null;
      this.dustGeometry = null;
    }
  }

  private animateDust(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.dustGeometry) return;

    this.dustTime += dt;

    // Center around camera
    if (this.dustParticles) {
      this.dustParticles.position.x = cameraPosition.x;
      this.dustParticles.position.z = cameraPosition.z;
    }

    const positions = this.dustGeometry.attributes.position as THREE.BufferAttribute;
    const arr = positions.array as Float32Array;

    for (let i = 0; i < DUST_PARTICLE_COUNT; i++) {
      const idx = i * 3;
      // Gentle horizontal drift (no vertical fall) + wind transport
      arr[idx]     += (Math.sin(this.dustTime * 0.3 + i * 1.7) * DUST_DRIFT_SPEED       * this.wind.gust + this.wind.vx) * dt;
      arr[idx + 2] += (Math.cos(this.dustTime * 0.4 + i * 2.3) * DUST_DRIFT_SPEED * 0.7 * this.wind.gust + this.wind.vz) * dt;
      // Slight vertical bob
      arr[idx + 1] += Math.sin(this.dustTime * 0.2 + i * 3.1) * 0.1 * dt;

      // Wrap around
      const half = DUST_AREA / 2;
      if (arr[idx] > half) arr[idx] -= DUST_AREA;
      if (arr[idx] < -half) arr[idx] += DUST_AREA;
      if (arr[idx + 2] > half) arr[idx + 2] -= DUST_AREA;
      if (arr[idx + 2] < -half) arr[idx + 2] += DUST_AREA;
      // Keep y in range
      if (arr[idx + 1] < 0.5) arr[idx + 1] = 0.5;
      if (arr[idx + 1] > 8) arr[idx + 1] = 8;
    }

    positions.needsUpdate = true;
  }

  // ── Leaves (ambient) ──

  /** Leaf texture: simple oval leaf shape (32×32). */
  private static createLeafTexture(): THREE.CanvasTexture {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // Leaf body — ellipse with green-brown gradient
    const cx = size / 2, cy = size / 2;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
    gradient.addColorStop(0, 'rgba(120, 160, 60, 0.9)');
    gradient.addColorStop(0.6, 'rgba(140, 130, 50, 0.7)');
    gradient.addColorStop(1, 'rgba(100, 80, 30, 0.0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(cx, cy, size / 2 - 2, size / 3 - 1, 0, 0, Math.PI * 2);
    ctx.fill();

    // Leaf vein — center line
    ctx.strokeStyle = 'rgba(80, 100, 40, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(4, cy);
    ctx.lineTo(size - 4, cy);
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private createLeaves(): void {
    this.leafGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(LEAF_PARTICLE_COUNT * 3);

    for (let i = 0; i < LEAF_PARTICLE_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * LEAF_AREA;
      positions[i * 3 + 1] = 2 + Math.random() * 13; // y: 2–15m
      positions[i * 3 + 2] = (Math.random() - 0.5) * LEAF_AREA;
    }

    this.leafGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3),
    );

    const material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.6,
      map: SkyAndFog.createLeafTexture(),
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });

    this.leafParticles = new THREE.Points(this.leafGeometry, material);
    this.gameRenderer.scene.add(this.leafParticles);
  }

  private removeLeaves(): void {
    if (this.leafParticles) {
      this.gameRenderer.scene.remove(this.leafParticles);
      this.leafGeometry?.dispose();
      (this.leafParticles.material as THREE.Material).dispose();
      this.leafParticles = null;
      this.leafGeometry = null;
    }
  }

  private animateLeaves(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.leafGeometry) return;

    this.leafTime += dt;

    // Center around camera
    if (this.leafParticles) {
      this.leafParticles.position.x = cameraPosition.x;
      this.leafParticles.position.z = cameraPosition.z;
    }

    const positions = this.leafGeometry.attributes.position as THREE.BufferAttribute;
    const arr = positions.array as Float32Array;

    for (let i = 0; i < LEAF_PARTICLE_COUNT; i++) {
      const idx = i * 3;
      // Slow fall
      arr[idx + 1] -= LEAF_FALL_SPEED * dt;
      // Swaying horizontal drift + wind transport (gust amplifies sway)
      arr[idx]     += (Math.sin(this.leafTime * 0.6 + i * 2.1) * LEAF_DRIFT_SPEED       * this.wind.gust + this.wind.vx) * dt;
      arr[idx + 2] += (Math.cos(this.leafTime * 0.5 + i * 1.7) * LEAF_DRIFT_SPEED * 0.6 * this.wind.gust + this.wind.vz) * dt;

      // Reset to top when below ground
      if (arr[idx + 1] < 0) {
        arr[idx] = (Math.random() - 0.5) * LEAF_AREA;
        arr[idx + 1] = 10 + Math.random() * 5;
        arr[idx + 2] = (Math.random() - 0.5) * LEAF_AREA;
      }

      // Wrap around horizontally
      const half = LEAF_AREA / 2;
      if (arr[idx] > half) arr[idx] -= LEAF_AREA;
      if (arr[idx] < -half) arr[idx] += LEAF_AREA;
      if (arr[idx + 2] > half) arr[idx + 2] -= LEAF_AREA;
      if (arr[idx + 2] < -half) arr[idx + 2] += LEAF_AREA;
    }

    positions.needsUpdate = true;
  }

  // ── Rain ──

  private updateRain(enable: boolean): void {
    if (enable && !this.rainParticles) {
      this.createRain();
    } else if (!enable && this.rainParticles) {
      this.removeRain();
    }
  }

  private createRain(): void {
    this.rainGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(RAIN_PARTICLE_COUNT * 3);
    this.rainSpeeds = new Float32Array(RAIN_PARTICLE_COUNT);

    for (let i = 0; i < RAIN_PARTICLE_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * RAIN_AREA;
      positions[i * 3 + 1] = Math.random() * RAIN_AREA;
      positions[i * 3 + 2] = (Math.random() - 0.5) * RAIN_AREA;
      this.rainSpeeds[i] = RAIN_SPEED
        * (FALL_SPEED_JITTER_MIN + Math.random() * (FALL_SPEED_JITTER_MAX - FALL_SPEED_JITTER_MIN));
    }

    this.rainGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3),
    );

    const material = new THREE.PointsMaterial({
      color: 0xaaaacc,
      size: 0.5,
      map: SkyAndFog.createRainTexture(),
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.rainParticles = new THREE.Points(this.rainGeometry, material);
    this.gameRenderer.scene.add(this.rainParticles);
  }

  private removeRain(): void {
    if (this.rainParticles) {
      this.gameRenderer.scene.remove(this.rainParticles);
      this.rainGeometry?.dispose();
      (this.rainParticles.material as THREE.Material).dispose();
      this.rainParticles = null;
      this.rainGeometry = null;
      this.rainSpeeds = null;
    }
  }

  private animateRain(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.rainGeometry) return;

    // Center rain around camera (vertically too — routes above RAIN_AREA
    // elevation would otherwise leave the whole band under the terrain)
    if (this.rainParticles) {
      this.rainParticles.position.x = cameraPosition.x;
      this.rainParticles.position.y = cameraPosition.y - RAIN_AREA * 0.25;
      this.rainParticles.position.z = cameraPosition.z;
    }

    const positions = this.rainGeometry.attributes.position as THREE.BufferAttribute;
    const arr = positions.array as Float32Array;

    const half = RAIN_AREA / 2;
    for (let i = 0; i < RAIN_PARTICLE_COUNT; i++) {
      const idx = i * 3;
      arr[idx + 1] -= (this.rainSpeeds?.[i] ?? RAIN_SPEED) * dt; // fall down
      arr[idx]     += this.wind.vx * dt;
      arr[idx + 2] += this.wind.vz * dt;

      if (arr[idx + 1] < 0) {
        // Wrap by modulo (keeps each drop's random phase — snapping every
        // drop to the exact top would sync them into one falling sheet)
        arr[idx + 1] = (arr[idx + 1] % RAIN_AREA) + RAIN_AREA;
        arr[idx]     = (Math.random() - 0.5) * RAIN_AREA;
        arr[idx + 2] = (Math.random() - 0.5) * RAIN_AREA;
      }
      // Wrap horizontally for wind-driven drift
      if (arr[idx]     >  half) arr[idx]     -= RAIN_AREA;
      if (arr[idx]     < -half) arr[idx]     += RAIN_AREA;
      if (arr[idx + 2] >  half) arr[idx + 2] -= RAIN_AREA;
      if (arr[idx + 2] < -half) arr[idx + 2] += RAIN_AREA;
    }

    positions.needsUpdate = true;
  }

  // ── Snow ──

  private updateSnow(enable: boolean): void {
    if (enable && !this.snowParticles) {
      this.createSnow();
    } else if (!enable && this.snowParticles) {
      this.removeSnow();
    }
  }

  private createSnow(): void {
    this.snowGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(SNOW_PARTICLE_COUNT * 3);
    this.snowSpeeds = new Float32Array(SNOW_PARTICLE_COUNT);

    for (let i = 0; i < SNOW_PARTICLE_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * SNOW_AREA;
      positions[i * 3 + 1] = Math.random() * SNOW_AREA;
      positions[i * 3 + 2] = (Math.random() - 0.5) * SNOW_AREA;
      this.snowSpeeds[i] = SNOW_SPEED
        * (FALL_SPEED_JITTER_MIN + Math.random() * (FALL_SPEED_JITTER_MAX - FALL_SPEED_JITTER_MIN));
    }

    this.snowGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3),
    );

    const material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.6,
      map: SkyAndFog.createSnowTexture(),
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });

    this.snowParticles = new THREE.Points(this.snowGeometry, material);
    this.gameRenderer.scene.add(this.snowParticles);
  }

  private removeSnow(): void {
    if (this.snowParticles) {
      this.gameRenderer.scene.remove(this.snowParticles);
      this.snowGeometry?.dispose();
      (this.snowParticles.material as THREE.Material).dispose();
      this.snowParticles = null;
      this.snowGeometry = null;
      this.snowSpeeds = null;
    }
  }

  private animateSnow(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.snowGeometry) return;

    this.snowTime += dt;

    // Center snow around camera (vertically too, same as rain)
    if (this.snowParticles) {
      this.snowParticles.position.x = cameraPosition.x;
      this.snowParticles.position.y = cameraPosition.y - SNOW_AREA * 0.25;
      this.snowParticles.position.z = cameraPosition.z;
    }

    const positions = this.snowGeometry.attributes.position as THREE.BufferAttribute;
    const arr = positions.array as Float32Array;

    const halfS = SNOW_AREA / 2;
    for (let i = 0; i < SNOW_PARTICLE_COUNT; i++) {
      const idx = i * 3;
      // Slow fall
      arr[idx + 1] -= (this.snowSpeeds?.[i] ?? SNOW_SPEED) * dt;
      // Horizontal drift = small sin sway + wind transport
      arr[idx]     += (Math.sin(this.snowTime * 0.5 + i)         * 0.6 * this.wind.gust + this.wind.vx) * dt;
      arr[idx + 2] += (Math.cos(this.snowTime * 0.7 + i * 0.3)   * 0.4 * this.wind.gust + this.wind.vz) * dt;

      // Wrap to top when below ground (modulo keeps random phase — see rain)
      if (arr[idx + 1] < 0) {
        arr[idx] = (Math.random() - 0.5) * SNOW_AREA;
        arr[idx + 1] = (arr[idx + 1] % SNOW_AREA) + SNOW_AREA;
        arr[idx + 2] = (Math.random() - 0.5) * SNOW_AREA;
      }
      // Wrap on wind transport
      if (arr[idx]     >  halfS) arr[idx]     -= SNOW_AREA;
      if (arr[idx]     < -halfS) arr[idx]     += SNOW_AREA;
      if (arr[idx + 2] >  halfS) arr[idx + 2] -= SNOW_AREA;
      if (arr[idx + 2] < -halfS) arr[idx + 2] += SNOW_AREA;
    }

    positions.needsUpdate = true;
  }
}
