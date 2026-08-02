/**
 * Dynamic sky, fog, and day/night system driven by real-time astronomical
 * calculations and weather type.
 *
 * Weather types: sunny, cloudy, rainy, snowy
 * Day/night: sun/moon positions computed from route lat/lon + system clock.
 * Moon sprite rendered in the night sky — or, when the world style declares
 * `buildCelestialDisc`, the style's own sun and moon discs.
 */

import * as THREE from 'three';
import type { GameRenderer } from './game-renderer';
import { getCelestialState, type CelestialState } from './sun-moon-calc';
import {
  computeDayNightLighting,
  DEFAULT_SKY_PALETTE,
  nightFactorFromElevation,
  nightKeyFloorGain,
  skyKeyFullDeg,
  skyKeyGainAt,
} from './day-night-lighting';
import { GradientSky } from './gradient-sky';
import {
  DEMO_STAR_SPRITE_PX,
  starPointSize,
  type SkyPalette,
  type StarFieldStyle,
} from './terrain-style-strategy';
import { LightningBolt } from './lightning-bolt';
import { cloudShadowUniforms, CLOUD_SHADOW_UV_SCALE, isCloudShadowDisabled } from './cloud-shadow';

/** Scratch colours for the per-frame sky update (avoids per-frame allocation). */
const _skyTop = new THREE.Color();
const _skyBottom = new THREE.Color();

export type WeatherType = 'sunny' | 'cloudy' | 'rainy' | 'snowy';

/** The style's `buildCelestialDisc`, handed over pre-bound (see setCelestialDiscBuilder). */
export type CelestialDiscBuilder = (body: 'sun' | 'moon', radius: number) => THREE.Object3D | null;

/** The style's `buildCloud`, handed over pre-bound (see setCloudBuilder). */
export type CloudBuilder = (index: number) => THREE.Object3D | null;

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

// ── GPU falling-particle material (rain / snow) ──
// Fall, wind transport, and sway all run in the vertex shader from static seed
// attributes; the CPU advances a handful of scalar uniforms per frame. The old
// path looped over every particle in JS and re-uploaded the whole position
// buffer each frame (3000 rain + 2000 snow) — a measurable per-frame CPU +
// GPU-upload cost on weak hardware. Trade-off vs the CPU version: drops keep
// their x/z column when wrapping at the ground instead of re-randomizing —
// per-drop speed jitter desyncs them enough that this is not visible.

interface FallingParticleMaterialOpts {
  map: THREE.Texture;
  color: number;
  opacity: number;
  /** Point size in logical px at scale reference (same meaning as PointsMaterial.size). */
  size: number;
  /** Wrap box edge length (meters) — must match the seed distribution. */
  area: number;
  blending?: THREE.Blending;
  /**
   * Sinusoidal horizontal sway (snow/leaves/dust). Frequencies in rad/s;
   * amplitudes in meters (= the old CPU velocity amplitude / frequency, so the
   * positional sweep matches the integrated velocity of the JS version).
   */
  sway?: { fx: number; fz: number; ax: number; az: number };
  /**
   * Ambient bob mode (dust): no fall — base y stays fixed and bobs
   * sinusoidally, clamped to [min, max]. Mutually exclusive with aSpeed fall.
   */
  bob?: { f: number; a: number; min: number; max: number };
  /** Vertical wrap length for falling particles (defaults to `area`; leaves use a low ceiling). */
  wrapY?: number;
}

function createFallingParticleMaterial(opts: FallingParticleMaterialOpts): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: opts.map },
      uColor: { value: new THREE.Color(opts.color) },
      uOpacity: { value: opts.opacity },
      uSize: { value: opts.size },
      /** 0.5 × drawing-buffer height — refreshed each frame (matches PointsMaterial sizing). */
      uScale: { value: 500 },
      /** Seconds since creation. Never wrapped: float32 precision at hour-scale
       *  values costs millimetres on the mod() below — invisible. */
      uTime: { value: 0 },
      /** Integrated wind displacement (x, z) in meters. */
      uWindOffset: { value: new THREE.Vector2(0, 0) },
      uGust: { value: 1 },
    },
    defines: {
      AREA: opts.area.toFixed(1),
      HALF_AREA: (opts.area / 2).toFixed(1),
      WRAP_Y: (opts.wrapY ?? opts.area).toFixed(1),
      ...(opts.sway
        ? {
            SWAY: '',
            SWAY_FX: opts.sway.fx.toFixed(3),
            SWAY_FZ: opts.sway.fz.toFixed(3),
            SWAY_AX: opts.sway.ax.toFixed(3),
            SWAY_AZ: opts.sway.az.toFixed(3),
          }
        : {}),
      ...(opts.bob
        ? {
            BOB: '',
            BOB_F: opts.bob.f.toFixed(3),
            BOB_A: opts.bob.a.toFixed(3),
            BOB_MIN: opts.bob.min.toFixed(2),
            BOB_MAX: opts.bob.max.toFixed(2),
          }
        : {}),
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec2 uWindOffset;
      uniform float uGust;
      uniform float uSize;
      uniform float uScale;
      #ifndef BOB
      attribute float aSpeed;
      #endif
      #if defined(SWAY) || defined(BOB)
      attribute float aPhase;
      #endif

      void main() {
        vec3 p = position;
        #ifdef BOB
        // Ambient bob: fixed base height, sinusoidal wobble, no fall
        p.y = clamp(p.y + sin(uTime * BOB_F + aPhase * 3.1) * BOB_A, BOB_MIN, BOB_MAX);
        #else
        // Fall with per-particle speed, wrapping inside [0, WRAP_Y)
        p.y = mod(p.y - aSpeed * uTime, WRAP_Y);
        #endif

        float sx = 0.0;
        float sz = 0.0;
        #ifdef SWAY
        // Positional sway equivalent to the old integrated sin/cos velocity
        // (amplitude = velocityAmplitude / frequency)
        sx = sin(uTime * SWAY_FX + aPhase) * SWAY_AX * uGust;
        sz = cos(uTime * SWAY_FZ + aPhase * 0.3) * SWAY_AZ * uGust;
        #endif
        p.x = mod(p.x + uWindOffset.x + sx + HALF_AREA, AREA) - HALF_AREA;
        p.z = mod(p.z + uWindOffset.y + sz + HALF_AREA, AREA) - HALF_AREA;

        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uSize * (uScale / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uColor;
      uniform float uOpacity;

      void main() {
        // Same y-flip as PointsMaterial's gl_PointCoord mapping
        vec4 tex = texture2D(uMap, vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y));
        gl_FragColor = vec4(uColor, uOpacity) * tex;
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: opts.blending ?? THREE.NormalBlending,
  });
}

/** Snow particle count. */
const SNOW_PARTICLE_COUNT = 2000;

/** Snow area around camera (meters). */
const SNOW_AREA = 120;

/** Snow fall speed (m/s). */
const SNOW_SPEED = 3;

/** Billboard cloud count. */
const CLOUD_COUNT = 18;

/** Cloud spread area around camera (meters). */
const CLOUD_AREA = 300;

/**
 * Vertical extent of the cloud deck (meters). Billboards scatter through it and
 * it doubles as the band inside which the "you are in cloud" fog takes over.
 * Constant on purpose: the immersion ramp feathers CLOUD_EDGE_FEATHER metres at
 * each edge, so a thickness below 2× that could never reach full immersion.
 */
const CLOUD_LAYER_THICKNESS = 200;

/**
 * Cloud-base height above the scene origin used when no dew point is available
 * (weather API down, or the field missing). Reproduces the pre-LCL behaviour —
 * the deck sat at a fixed scene Y of 200–400 — so a failed fetch degrades to the
 * old look instead of burying the clouds or losing them.
 */
const CLOUD_BASE_FALLBACK_AGL = 200;

/**
 * Half-width (m) of the smoothstep feather at each edge of the deck, i.e. the
 * transition spans 80 m of climb. Real cloud bases are ragged over roughly that
 * much, and it keeps the fog collapse gradual: descending into the deck at a
 * brisk 2 m/s vertical, the change takes ~40 s. Must stay below half
 * CLOUD_LAYER_THICKNESS or the two edge ramps overlap and full immersion is
 * never reached.
 */
const CLOUD_EDGE_FEATHER = 40;

/**
 * Clear air (m) kept between the chase camera and the deck's nominal base — the
 * gap that stops the collision lift from parking the camera inside an opaque
 * cloud. Derivation (what the three styles' `buildCloud` hangs below its slot
 * origin, plus the ±1.2 m bob) is on `cameraCeilingSceneY`, which is the only
 * thing that reads it.
 */
const CLOUD_CAMERA_CLEARANCE = 25;

/** Visibility (m) inside the deck at full immersion. */
const CLOUD_FOG_NEAR = 3;
const CLOUD_FOG_FAR = 45;

/** Colour a cloud interior converges on in full daylight. */
const CLOUD_CORE_COLOR = 0xe9edf2;

/** Cloud horizontal drift speed (m/s). */
const CLOUD_DRIFT_SPEED = 2;

/** Dust particle count (ambient, always-on). */
const DUST_PARTICLE_COUNT = 40;

/** Dust area around camera (meters). */
const DUST_AREA = 60;

/** Leaf particle count (ambient, always-on). */
const LEAF_PARTICLE_COUNT = 15;

/** Leaf area around camera (meters). */
const LEAF_AREA = 80;

/** Leaf fall speed (m/s). */
const LEAF_FALL_SPEED = 2;

/**
 * The rider-centred sky shell: the moon sprite's distance, and the shell the
 * styles' sun/moon discs hang on. The demos' `SKY_SHELL_R`.
 *
 * The GUARANTEE is what the shell is for: it sits outside the far ring and
 * inside the camera's far plane, so a celestial body is never drawn in front of
 * the horizon. 2600 (2700 with circuit's fins) < 3000 < 8000. It is also inside
 * `ACRYLIC_CASE_RADIUS` (3200), so you look at the sky THROUGH the case.
 *
 * ⚠ The demos used to say 950 — a number about THEIR scale (their far ring
 * reaches 640 m for paper, 810 m for circuit). Porting 950 here would have
 * parked the sun a kilometre and a half INSIDE the mountains, i.e. re-created
 * at our scale the exact bug the demos' shell was introduced to fix. That is no
 * longer a divergence to manage: **all three demos now declare
 * `SKY_SHELL_R = 3000`**, so this number is a literal transcription and
 * `[celestial shell]` asserts the two are equal (as well as the ordering).
 * The demos keep their own mountain rings at their own radii — the ring ports
 * as an ANGLE (`maxH / radius`, see `mountain-ring.ts`), not as metres.
 */
export const MOON_DISTANCE = 3000;

/**
 * Star dome radius — **the same shell the sun and moon hang on**.
 *
 * That identity is the demos': their star block reads `SKY_SHELL_R` rather than
 * a radius of its own, and the constant's own comment is `= 星星那顆球`. It had
 * not been ported: this was 2500, i.e. INSIDE `MOUNTAIN_FAR_RADIUS` (2600) and
 * inside circuit's fins (2700), so a star at low elevation was drawn IN FRONT
 * of the horizon — the very bug the demos' shell exists to prevent, and the one
 * `MOON_DISTANCE` above was already fixed for.
 */
const STAR_RADIUS = MOON_DISTANCE;

/**
 * The star field used until `setPalette` hands over the world's own — the role
 * `DEFAULT_SKY_PALETTE` plays for the gradient, and it lives here rather than
 * beside it because `SkyPalette.stars` is optional precisely so that
 * placeholder does not have to invent a world's worth of numbers.
 *
 * Plastic/paper's, like the placeholder gradient's 500/5 next door: two of the
 * three demos say it. Every real path calls `setPalette` before `init()`, so no
 * star is ever built from this in the game — only in a check that skips the
 * palette.
 */
const FALLBACK_STAR_FIELD: StarFieldStyle = {
  count: 260,
  size: 28.42105263157895,
  polarSpan: 0.42,
  polarMin: 0.08,
  spriteRadius: 7,
  color: '#fff8e0',
};

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
// A meteor is a streak ACROSS the star field, so it lives on the star shell —
// same reason as STAR_RADIUS. At the old 2200 m it spawned inside the far ring
// (2600) and inside circuit's fins (2700). "Lives", not "spawns": fixing the
// spawn radius alone left the FLIGHT diving back inside the ring — see the
// tangent projection in `spawnMeteor`.
const METEOR_RADIUS = STAR_RADIUS;
const METEOR_LENGTH = 260;
const METEOR_WIDTH = 9;

const UNIT_X = new THREE.Vector3(1, 0, 0);
const UNIT_Y = new THREE.Vector3(0, 1, 0);

function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Smooth 0→1 ramp between two thresholds (same curve as day-night-lighting). */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Geometric interpolation, for fog DISTANCES. Visibility is multiplicative: a
 * linear ramp from 3000 m to 45 m spends three quarters of its travel between
 * distances the eye cannot tell apart, then collapses at the very end. In log
 * space each step of `t` is the same *ratio*, which is what "the murk closes in"
 * actually looks like. Monotonic, so the transition is still continuous.
 */
function geomLerp(a: number, b: number, t: number): number {
  const from = Math.max(a, 1e-3);
  return from * Math.pow(Math.max(b, 1e-3) / from, clamp01(t));
}

/** Scratch colours for hex mixing (no per-frame allocation). */
const _mixA = new THREE.Color();
const _mixB = new THREE.Color();

/** Linearly interpolate two hex colours (in the working colour space). */
function mixHex(a: number, b: number, t: number): number {
  return _mixA.setHex(a).lerp(_mixB.setHex(b), clamp01(t)).getHex();
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
  private snowParticles: THREE.Points | null = null;
  private snowGeometry: THREE.BufferGeometry | null = null;
  /** Quality-tier particle budgets (see setParticleCounts). */
  private rainCount = RAIN_PARTICLE_COUNT;
  private snowCount = SNOW_PARTICLE_COUNT;
  private moonSprite: THREE.Sprite | null = null;

  /**
   * Style-built sun/moon discs (paper cut-out / moulded plastic). When the
   * moon disc exists it replaces the sprite outright; the sprite stays around
   * (hidden) so switching to a style without the hook falls straight back.
   * The materials are collected once at build time — opacity is rewritten
   * every update and per frame under cloud immersion, and a traverse there
   * would be per-frame garbage.
   */
  private sunDisc: THREE.Object3D | null = null;
  private sunDiscMats: THREE.Material[] = [];
  private moonDisc: THREE.Object3D | null = null;
  private moonDiscMats: THREE.Material[] = [];
  private cloudGroup: THREE.Group | null = null;
  private cloudTexture: THREE.Texture | null = null;
  private cloudsEnabled = false;

  /** The style's cloud look (`buildCloud`), or null for the billboard deck. */
  private cloudBuilder: CloudBuilder | null = null;

  /**
   * Materials of the style-built clouds, collected once at build time (same
   * reason as sunDiscMats: the immersion fade rewrites them per frame and a
   * traverse there would be per-frame garbage). They are strategy-owned
   * singletons shared by every cloud, so the deck-wide fade is one write per
   * material, not per mesh like the billboards.
   */
  private styleCloudMats: THREE.Material[] = [];

  /**
   * Last fade written to styleCloudMats. Style clouds are handed over OPAQUE
   * and only flip to transparent while the rider crosses the deck edge — this
   * remembers which side of that flip the materials are on, so the flip (and
   * its needsUpdate) happens at the crossings, not every frame.
   */
  private styleCloudFade = 1;

  /**
   * Cloud deck base as an ABSOLUTE altitude (m above sea level), from the
   * weather-derived lifted condensation level. `null` = unknown, fall back to a
   * fixed height above the scene origin (CLOUD_BASE_FALLBACK_AGL).
   */
  private cloudBaseAltitudeM: number | null = null;

  /**
   * Reads the scene's floating-origin elevation (m MSL). The scene is a
   * floating-origin world — scene Y is `altitude − originEle` — so a deck pinned
   * to an ALTITUDE has to be re-derived from the live origin, not cached as a
   * scene Y. Caching would slide the deck by the rebase delta the first time the
   * origin moves, which is exactly the bug the old fixed `CLOUD_MIN_Y` had.
   */
  private originElevation: (() => number) | null = null;

  /** 0 = outside the deck, 1 = fully inside. Drives fog, sky, billboard fade. */
  private cloudImmersion = 0;

  /**
   * Fog + sky exactly as `applyLighting` computed them, BEFORE cloud immersion.
   * `applyCloudImmersion` blends on top of these and writes the result, so
   * leaving a cloud hands back the original numbers bit for bit — the normal
   * weather/day-night fog path never learns that clouds exist.
   */
  private baseFogNear = 800;
  private baseFogFar = 3000;
  private baseFogColor = 0xe6dcd0;
  private baseSkyTop = DEFAULT_SKY_PALETTE.day.skyTop;
  private baseSkyBottom = DEFAULT_SKY_PALETTE.day.skyBottom;
  private baseBackground = DEFAULT_SKY_PALETTE.day.skyBottom;

  /** Camera height (scene metres) from the last update() — the immersion input. */
  private lastCameraY = 0;

  /** Moon sprite/disc opacity before cloud dimming (see applyCloudImmersion). */
  private moonBaseOpacity = 1;

  /** Sun disc opacity before cloud dimming — same contract as moonBaseOpacity. */
  private sunBaseOpacity = 1;

  /** Quality-tier cloud budget (see setCloudBudget) — count used when (re)building
   *  the billboard cloud layer, in place of the CLOUD_COUNT constant. */
  private cloudBudget = CLOUD_COUNT;
  private dustParticles: THREE.Points | null = null;
  private dustGeometry: THREE.BufferGeometry | null = null;
  private leafParticles: THREE.Points | null = null;
  private leafGeometry: THREE.BufferGeometry | null = null;
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

  /**
   * Hand over a live read of the scene's floating-origin elevation (m MSL).
   * A getter, not a value: the origin is resolved asynchronously after this
   * object is constructed, and may be rebased mid-ride. Everything cloud-related
   * re-reads it per frame so it can never go stale.
   */
  setOriginElevationSource(source: () => number): void {
    this.originElevation = source;
  }

  /**
   * Set the cloud deck's base as an absolute altitude (m MSL) — normally the
   * weather-derived lifted condensation level. `null` restores the fallback
   * (a fixed height above the scene origin).
   *
   * Absolute altitude is the whole point: a low route then looks up at a deck it
   * never reaches, and a mountain route climbs through the same deck and comes
   * out on top of it, without either needing to know the other exists.
   */
  setCloudLayer(baseAltitudeM: number | null): void {
    this.cloudBaseAltitudeM =
      baseAltitudeM !== null && Number.isFinite(baseAltitudeM) ? baseAltitudeM : null;
  }

  /** Enable or disable the day/night cycle. */
  setDayNightEnabled(enabled: boolean): void {
    this.dayNightEnabled = enabled;
    if (!enabled) {
      if (this.moonSprite) this.moonSprite.visible = false;
      if (this.moonDisc) this.moonDisc.visible = false;
      if (this.sunDisc) this.sunDisc.visible = false;
    }
  }

  /**
   * Adopt the world style's sun/moon discs (`buildCelestialDisc`), or null to
   * fall back to the additive moon sprite and no sun. Call alongside
   * setPalette on init and on style switch — the previous style's discs are
   * torn down here (sky-and-fog owns them, per the hook's contract) and the
   * new ones built immediately, hidden until the next lighting update places
   * them.
   */
  setCelestialDiscBuilder(builder: CelestialDiscBuilder | null): void {
    this.removeCelestialDiscs();
    if (!builder) return;
    // The style is handed the SHELL, not a radius: each world's demo declares
    // its own disc size against the demos' shared mount (see
    // `celestialDiscRadius`), and circuit's differs from the other two on
    // purpose.
    this.sunDisc = this.adoptCelestialDisc(builder('sun', MOON_DISTANCE), this.sunDiscMats);
    this.moonDisc = this.adoptCelestialDisc(builder('moon', MOON_DISTANCE), this.moonDiscMats);
  }

  /**
   * Adopt the world style's cloud look (`buildCloud`), or null to keep the
   * billboard deck. Call alongside setCelestialDiscBuilder on init and style
   * switch; a live deck is rebuilt immediately so a style swap never leaves
   * the old world's clouds up.
   */
  setCloudBuilder(builder: CloudBuilder | null): void {
    this.cloudBuilder = builder;
    if (this.cloudGroup) {
      this.removeClouds();
      this.createClouds();
    }
  }

  /** Collect the disc's materials (for opacity writes) and put it in the sky. */
  private adoptCelestialDisc(
    disc: THREE.Object3D | null,
    mats: THREE.Material[],
  ): THREE.Object3D | null {
    if (!disc) return null;
    disc.visible = false;
    disc.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mats.push(m);
    });
    this.gameRenderer.scene.add(disc);
    return disc;
  }

  /**
   * Advance whatever the styles' discs asked to have scrolled — the demo's
   *
   *     sunDisc.userData.beam.offset.x  = (… + dt * 0.35) % 1;
   *     moonDisc.userData.beam.offset.x = (… + dt * 0.22) % 1;
   *
   * with the two rates read off the discs rather than written here, because
   * they belong to the world that drew the waveform.
   *
   * `% 1` is not cosmetic: an offset that only ever grows loses float precision
   * against the repeat, and a texture that repeats horizontally does not care
   * where in [0, 1) it starts. One uniform write per disc per frame — the
   * canvas is never touched again after build, so there is no upload.
   */
  private scrollCelestialBeams(dt: number): void {
    for (const disc of [this.sunDisc, this.moonDisc]) {
      if (!disc || !disc.visible) continue;
      const beam = disc.userData.beam as THREE.Texture | undefined;
      const speed = disc.userData.beamSpeed as number | undefined;
      if (!beam || !speed) continue;
      beam.offset.x = (beam.offset.x + dt * speed) % 1;
    }
  }

  private removeCelestialDiscs(): void {
    for (const disc of [this.sunDisc, this.moonDisc]) {
      if (!disc) continue;
      this.gameRenderer.scene.remove(disc);
      disc.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          (m as THREE.MeshBasicMaterial).map?.dispose();
          m.dispose();
        }
      });
    }
    this.sunDisc = null;
    this.moonDisc = null;
    this.sunDiscMats = [];
    this.moonDiscMats = [];
  }

  /**
   * Adopt the world style's day/night palette. Call on init and on style switch;
   * the next update() picks it up.
   */
  setPalette(palette: SkyPalette): void {
    this.palette = palette;
    // The gradient's SHAPE is the palette's too — plastic's horizon band sits at
    // 260/1100 of the dome and paper's/circuit's at 500/1100, so a style switch
    // has to move it (see `SkyGradientStyle`). Null before init(): the dome is
    // built from `this.palette` down there, so it starts out already right.
    this.sky?.setGradient(palette.gradient);
    // The star field is the palette's too, and unlike the gradient it cannot be
    // re-pointed in place: the count, the band, the sprite and the point size
    // all differ per world, so a style switch has to rebuild the buffer. Null
    // before init() — `createStars` down there reads `this.palette`, so the
    // first field is already the right world's and this never runs twice on the
    // normal path (setPalette lands before init()).
    if (this.starParticles) {
      this.removeStars();
      this.createStars();
    }
    if (!this.dayNightEnabled) {
      // That path only recomputes on setWeather — refresh it against the new
      // palette now, or a style switch would leave the old style's sky up.
      this.applyLighting(this.legacyCelestial(this.lastConfig), null);
    }
  }

  /** Initialize the sky. Call once after GameRenderer is set up. */
  init(): void {
    // A flat gradient dome, not a physical atmosphere — see gradient-sky.ts.
    this.sky = new GradientSky(this.gameRenderer.scene, this.palette.gradient);

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

    this.lastCameraY = cameraPosition.y;

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
      // Immersion first: animateClouds fades the billboards by it, and the fog
      // has to track the camera's climb per frame — applyLighting only runs at
      // 4 Hz, which would step the transition instead of sliding it.
      this.applyCloudImmersion();
      this.animateClouds(dt, cameraPosition);
    }

    // The discs' own animation, if the style declared one (circuit's CRT
    // sweep). Every frame, not on the 4 Hz lighting tick — a beam that steps
    // four times a second reads as broken, not as slow.
    this.scrollCelestialBeams(dt);

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
    this.removeCelestialDiscs();
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
   * day/night-disabled path. The moon is the sun's ANTIPODE, which is the demos'
   * own arc (`skyCelestial`: `moon = -sun`) — so a caller who hands us a
   * night-time elevation gets a key light overhead rather than one underground.
   *
   * It used to copy the sun's elevation UNCHANGED and claim in this comment that
   * the moon "mirrors the sun so the key light has somewhere to sit". That was
   * only ever true because `MIN_LIGHT_ELEV = 15` hauled the whole thing back
   * above the horizon; once the clamp came out (bfe4635) a night-time
   * `sunElevation` on this path put the key light BELOW the ground, where
   * `skyKeyGainAt` is 0 and `nightKeyFloorGain` refuses to floor an off-duty
   * body — a completely unlit night. Dormant (GameView only ever passes 45 here)
   * but a trap, and negating is what makes the sentence above true.
   */
  private legacyCelestial(config: WeatherConfig): CelestialState {
    return {
      sunElevation: config.sunElevation,
      sunAzimuth: config.sunAzimuth,
      moonElevation: -config.sunElevation,
      moonAzimuth: (config.sunAzimuth + 180) % 360,
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

    // Sky dome — always visible, colours carry the hour and the weather. The
    // colours themselves are stashed rather than written: applyCloudImmersion()
    // below owns the last word on sky/fog/background so the two systems compose
    // instead of fighting over the same three setters.
    this.baseSkyTop = lighting.skyTopColor;
    this.baseSkyBottom = lighting.skyBottomColor;
    this.baseFogNear = lighting.fogNear;
    this.baseFogFar = lighting.fogFar;
    this.baseFogColor = lighting.fogColor;
    this.baseBackground = lighting.backgroundColor;
    if (this.sky && cameraPosition) this.sky.update(cameraPosition);

    const { ambientLight, directionalLight, hemisphereLight } = this.gameRenderer;

    // Key light follows sun (daytime) or moon (nighttime), at its REAL elevation.
    //
    // There used to be a `Math.max(MIN_LIGHT_ELEV = 15, elev)` here, "so surfaces
    // stay lit even when the source is at/below the horizon". That 15 had no demo
    // behind it and it lied: at sunrise the light IS at 0°, and hauling it up to
    // 15° draws sunrise as 9am. The demos answer the other way round — the low
    // angle is real, and what gets pulled down is the LIGHT, not the angle
    // (day-night-lighting.ts `skyKeyFullDeg` / `skyKeyGainAt`, SKY 區塊).
    //
    // The DIRECTION only. The light's `position` also has to carry the shadow
    // box's rider anchor now (game-renderer.ts `anchorSunShadow`), so it can no
    // longer be written from here — a fixed radius about the scene origin left
    // the shadow camera parked kilometres behind the rider.
    const elev = celestial.isDaytime ? celestial.sunElevation : celestial.moonElevation;
    const azim = celestial.isDaytime ? celestial.sunAzimuth : celestial.moonAzimuth;
    this.gameRenderer.setKeyLightDirection(elev, azim);

    // The demos' `applyDayNight`, verbatim in shape:
    //
    //     sunLight.intensity = (DAY.sunI + (NIGHT.sunI - DAY.sunI) * k) * skyKeyGain;
    //     sunLight.castShadow = skyKeyGain > 0;
    //
    // MULTIPLIED in, not substituted — the palette blend, the weather multiplier
    // and the night floor all still happen, and then the horizon takes its cut.
    // The threshold is read off the LIVE shadow block (the box, the current
    // tier's map size, this world's own `normalBias`), exactly as the demos read
    // `sunLight.shadow.*`, so circuit's 1.2 keeps giving a different angle.
    const fullDeg = skyKeyFullDeg(
      directionalLight.shadow.camera.right,
      directionalLight.shadow.mapSize.x,
      directionalLight.shadow.normalBias,
    );
    const gain = skyKeyGainAt(elev, fullDeg);

    // …and the ILLUMINATION gets a floor under it, which the SHADOW does not.
    //
    // The demos' night is lit — `?night=1` runs the moon up to +47.38° and hands
    // it `skyPalette.night.sunColor / sunIntensity` (plastic/paper 0.7, circuit
    // 0.62). Our moon is not the sun's antipode, so a waning one rides low and
    // `gain` takes a cut the demos never take, leaving hemisphere + ambient to
    // carry the whole night against a violet sky and violet fog. The floor is
    // the gain the DEMOS' key would have had at this hour; see
    // `nightKeyFloorGain`, which is 0 for the whole day so nothing above the
    // horizon moves.
    const litGain = Math.max(gain, nightKeyFloorGain(celestial.sunElevation, elev, fullDeg));

    ambientLight.intensity = lighting.ambientIntensity;
    ambientLight.color.setHex(lighting.ambientColor);
    directionalLight.intensity = lighting.directionalIntensity * litGain;
    directionalLight.color.setHex(lighting.directionalColor);
    hemisphereLight.intensity = lighting.hemisphereIntensity;
    hemisphereLight.color.setHex(lighting.hemisphereColor);
    hemisphereLight.groundColor.setHex(lighting.hemisphereGroundColor);
    // `castShadow` has a second owner (the quality tier's `setShadowLevel`), so
    // this half of the demos' pair goes through the renderer instead of being
    // written here — see `GameRenderer.setKeyLightShadowGain`.
    this.gameRenderer.setKeyLightShadowGain(gain);

    this.gameRenderer.setToneMappingExposure(lighting.toneMappingExposure);

    if (cameraPosition) {
      this.updateMoonSprite(celestial, cameraPosition);
      this.updateSunDisc(celestial, cameraPosition);
      this.updateStars(celestial, cameraPosition);
    }

    // Must come last: it dims the stars/moon the two calls above just set up.
    this.applyCloudImmersion();
  }

  // ── Cloud immersion ("you are inside the deck") ──

  /**
   * Scene Y of the deck's base, re-derived from the live floating origin.
   * Scene Y = altitude − originEle, so a deck at a fixed altitude has a scene Y
   * that changes whenever the origin is rebased.
   *
   * Public because the chase camera has to stay UNDER it (see
   * `cameraCeilingSceneY`), and it is not a number anyone can cache: the deck is
   * pinned to an altitude, so its scene Y moves with the weather AND with every
   * origin rebase.
   */
  cloudBaseSceneY(): number {
    if (this.cloudBaseAltitudeM === null) return CLOUD_BASE_FALLBACK_AGL;
    return this.cloudBaseAltitudeM - (this.originElevation?.() ?? 0);
  }

  /**
   * Highest scene Y the chase camera may be pushed to, or `null` when there is
   * no deck in the sky to hit.
   *
   * Why the camera needs a ceiling at all: `camera-collision.ts` lifts the
   * camera until its sightline to the bike clears the terrain, and that lift is
   * `(groundY + margin − aim) / t`, so a sample close to the bike (small `t`)
   * multiplies the obstruction. A hairpin summit — where the corridor folds and
   * the ground sample two metres behind the bike comes back as the road on the
   * NEXT switchback — asks for a hundred metres of lift, and up there the deck
   * is opaque `MeshToonMaterial`. The rider's report was a flat grey screen at
   * the top of a climb.
   *
   * The clearance is what the deck's SHAPE hangs below its nominal base, and it
   * is the styles that decide that (`buildCloud`), not this class:
   *
   *   · paper    instanced cotton balls, radius up to 10 m, scattered ±1.5 m  → ~11.7 m
   *   · circuit  foam slabs, half-height up to 3.0 m, scattered ±1.1 m        →  ~4.1 m
   *   · plastic  a 5 m brick centred on its slot                              →  ~2.5 m
   *
   * plus the ±1.2 m bob every style cloud rides. 25 m clears the worst of them
   * and still leaves the camera looking at cloud from below, which is the shot.
   *
   * `cameraY` is where the camera is now, and it decides whether there is a
   * ceiling at all. A deck is only overhead if you are underneath it: a ride
   * that has climbed out through the top (Hehuanshan on a low-LCL day is the
   * whole ride, not a moment of it) has nothing left up there to hit, and
   * holding the ceiling there would kill the collision lift for good.
   */
  cameraCeilingSceneY(cameraY: number): number | null {
    if (!this.cloudsEnabled || !this.cloudGroup) return null;
    const base = this.cloudBaseSceneY();
    if (cameraY > base + CLOUD_LAYER_THICKNESS) return null;
    return base - CLOUD_CAMERA_CLEARANCE;
  }

  /**
   * How deep the camera sits in the deck: 0 outside, 1 fully inside, feathered
   * at both edges so entering and leaving never pops. At exactly the cloud base
   * this is 0.5 — a cloud base is a fuzzy thing, not a plane.
   */
  private computeCloudImmersion(): number {
    if (!this.cloudsEnabled || !this.cloudGroup) return 0;
    const base = this.cloudBaseSceneY();
    const top = base + CLOUD_LAYER_THICKNESS;
    const y = this.lastCameraY;
    const entering = smoothstep(base - CLOUD_EDGE_FEATHER, base + CLOUD_EDGE_FEATHER, y);
    const leaving = smoothstep(top - CLOUD_EDGE_FEATHER, top + CLOUD_EDGE_FEATHER, y);
    return entering * (1 - leaving);
  }

  /**
   * Blend the cloud interior over whatever `applyLighting` last computed.
   *
   * THREE.Fog is linear in distance and its near plane sits at 200–800 m, so
   * anything closer than that gets zero fog — which is why flying into the old
   * cloud layer produced no weather at all. Riding inside a cloud needs the fog
   * volume hauled in to a dozen metres, and the sky dome (fog:false, it *is* the
   * background) tinted with it, or you end up in dense murk under a clear sky.
   *
   * At k = 0 every value written here is the untouched `applyLighting` output.
   */
  private applyCloudImmersion(): void {
    const k = this.computeCloudImmersion();
    this.cloudImmersion = k;

    let fogNear = this.baseFogNear;
    let fogFar = this.baseFogFar;
    let fogColor = this.baseFogColor;
    let skyTop = this.baseSkyTop;
    let skyBottom = this.baseSkyBottom;
    let background = this.baseBackground;

    if (k > 0) {
      fogNear = geomLerp(this.baseFogNear, CLOUD_FOG_NEAR, k);
      fogFar = geomLerp(this.baseFogFar, CLOUD_FOG_FAR, k);
      // A cloud interior is lit by the hour, not by a fixed swatch: midnight
      // cloud is dark grey. So take the CURRENT fog colour and pull it toward
      // white, further in daylight than at night.
      //
      // The night end is 0.10, not the ~0.35 that reads right on paper: mixHex
      // interpolates in the LINEAR working space, where a third of the way from
      // night blue to near-white already lands at mid-grey once it is encoded
      // back to sRGB. Measured — 0.35 gave a midnight interior of luma 152/255,
      // brighter than the daytime sky it was supposed to be hiding.
      const day = this._celestial?.dayFactor ?? 1;
      const core = mixHex(this.baseFogColor, CLOUD_CORE_COLOR, 0.10 + 0.75 * day);
      fogColor = mixHex(this.baseFogColor, core, k);
      skyTop = mixHex(skyTop, core, k);
      skyBottom = mixHex(skyBottom, core, k);
      background = mixHex(background, core, k);
    }

    // THREE.Fog divides by (far − near); keep them apart whatever the inputs.
    this.gameRenderer.setFog(fogNear, Math.max(fogFar, fogNear + 1), fogColor);
    this.gameRenderer.setBackground(background);
    this.sky?.setColors(_skyTop.setHex(skyTop), _skyBottom.setHex(skyBottom));

    // Stars are drawn fog:false (they are the sky, not the world's air) and the
    // moon sprite is additive on top of that, so without this they punch
    // straight through the murk. Recomputed from the
    // stored base each time rather than scaled in place — this runs every frame
    // and a repeated multiply would decay them to nothing.
    if (this.starParticles) {
      const alpha = this.currentStarAlpha * (1 - k);
      (this.starParticles.material as THREE.PointsMaterial).opacity = alpha;
      this.starParticles.visible = alpha > 0.01;
    }
    if (this.moonSprite && this.moonSprite.visible) {
      (this.moonSprite.material as THREE.SpriteMaterial).opacity = this.moonBaseOpacity * (1 - k);
    }
    // The style discs hang outside the fog too (fog: false), so without the
    // same dimming they stay crisp cut-outs in the middle of a whiteout.
    if (this.moonDisc && this.moonDisc.visible) {
      for (const m of this.moonDiscMats) m.opacity = this.moonBaseOpacity * (1 - k);
    }
    if (this.sunDisc && this.sunDisc.visible) {
      for (const m of this.sunDiscMats) m.opacity = this.sunBaseOpacity * (1 - k);
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
    // Show moon when sun is below ~5° (approaching/during night)
    const showMoon = celestial.sunElevation < 5 && celestial.moonElevation > -5;

    // Brightness based on moon phase (full moon = brightest). Stored, because
    // applyCloudImmersion dims it further and must not compound its own output.
    const fullness = 1 - 2 * Math.abs(celestial.moonPhase - 0.5);
    const opacity = 0.3 + 0.7 * fullness;

    if (this.moonDisc) {
      // The style's cut-out replaces the sprite outright — same show rule,
      // same phase-driven opacity and (relative) scale, so dawn reads the same.
      if (this.moonSprite) this.moonSprite.visible = false;
      this.moonDisc.visible = showMoon;
      if (!showMoon) return;
      this.placeCelestialDisc(this.moonDisc, celestial.moonElevation, celestial.moonAzimuth, cameraPosition);
      this.moonBaseOpacity = opacity;
      for (const m of this.moonDiscMats) m.opacity = opacity;
      this.moonDisc.scale.setScalar(0.8 + 0.2 * fullness);
      return;
    }

    if (!this.moonSprite) return;
    this.moonSprite.visible = showMoon;

    if (!showMoon) return;

    // Position moon using spherical coordinates relative to camera
    const phi = DEG * (90 - celestial.moonElevation);
    const theta = DEG * celestial.moonAzimuth;
    const pos = new THREE.Vector3().setFromSphericalCoords(MOON_DISTANCE, phi, theta);
    this.moonSprite.position.copy(cameraPosition).add(pos);

    this.moonBaseOpacity = opacity;
    (this.moonSprite.material as THREE.SpriteMaterial).opacity = opacity;

    // Scale slightly with fullness
    const scale = MOON_SCALE * (0.8 + 0.2 * fullness);
    this.moonSprite.scale.setScalar(scale);
  }

  /**
   * The sun disc — style-provided only; without a style the sun stays what it
   * always was, just a DirectionalLight. Opacity is `1 − night blend`, the
   * same k the palette lerps by, which is exactly the demos'
   * `sunDisc.material.opacity = 1 - k` — the disc fades through the same dusk
   * the sky darkens through. Stored for applyCloudImmersion, same
   * non-compounding contract as the moon.
   */
  private updateSunDisc(
    celestial: CelestialState,
    cameraPosition: THREE.Vector3,
  ): void {
    if (!this.sunDisc) return;
    // Mirror of the moon's rule: gone once it sinks well below the horizon.
    const showSun = celestial.sunElevation > -5;
    this.sunDisc.visible = showSun;
    if (!showSun) return;
    this.placeCelestialDisc(this.sunDisc, celestial.sunElevation, celestial.sunAzimuth, cameraPosition);
    this.sunBaseOpacity = 1 - nightFactorFromElevation(celestial.sunElevation);
    for (const m of this.sunDiscMats) m.opacity = this.sunBaseOpacity;
  }

  /**
   * Spherical placement relative to the camera, then face it — the demo hangs
   * its discs on a rider-following skyAnchor and `lookAt`s the rider; here the
   * anchor is the camera at the moon sprite's distance. lookAt matters beyond
   * looks: CircleGeometry fronts +Z and MeshBasicMaterial culls back faces, so
   * an unoriented disc is simply invisible.
   */
  private placeCelestialDisc(
    disc: THREE.Object3D,
    elevation: number,
    azimuth: number,
    cameraPosition: THREE.Vector3,
  ): void {
    const pos = new THREE.Vector3().setFromSphericalCoords(
      MOON_DISTANCE,
      DEG * (90 - elevation),
      DEG * azimuth,
    );
    disc.position.copy(cameraPosition).add(pos);
    disc.lookAt(cameraPosition);
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

  /**
   * The star sprite, verbatim from the demos:
   *
   *     const spr = document.createElement('canvas');
   *     spr.width = spr.height = 32;
   *     const sg = spr.getContext('2d');
   *     sg.fillStyle = '#fff2a0';
   *     sg.beginPath();
   *     sg.arc(16, 16, 7, 0, Math.PI * 2);
   *     sg.fill();
   *
   * A SOLID disc out to 7/16 of the quad's half-width, hard edge, in the
   * world's own tint — not the 8×8 radial gradient this used to draw, whose
   * alpha was 0.8 at 0.3 of the half-width, 0.2 at 0.7, and 0 at the edge.
   *
   * At the sizes a star actually covers, that shape matters more than `size`
   * does. The gradient's alpha ≥ 0.8 core was 0.3 of the half-width, i.e. a
   * 0.375 px radius on the 2.5 px quad it shipped with — sub-pixel, so what
   * reached the screen was a smear. The disc's is 0.4375 of the half-width
   * with nothing feathered away: 1.12 px radius on today's 5.12 px quad at
   * 1080. Ink on screen (mean alpha × quad area) goes 0.64 px² → 3.93 px².
   *
   * Sized off the STYLE, not a constant: circuit's disc is 6 px and its tint is
   * scope-phosphor blue, against plastic's 7 px of candy yellow.
   */
  private static createStarTexture(style: StarFieldStyle): THREE.CanvasTexture {
    const size = DEMO_STAR_SPRITE_PX;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = style.color;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, style.spriteRadius, 0, Math.PI * 2);
    ctx.fill();
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  /**
   * The demos' star block, ported whole. Everything that varies between the
   * three worlds arrives on the palette (`StarFieldStyle`); everything that is
   * word-for-word identical in all three demos is written here.
   *
   * The sampling is theirs, including the parameterisation:
   *
   *     const a = Math.random() * Math.PI * 2,
   *           ph = Math.random() * Math.PI * 0.42 + 0.08;
   *     pos[i * 3]     = Math.cos(a) * Math.sin(ph) * r;
   *     pos[i * 3 + 1] = Math.cos(ph) * r;
   *     pos[i * 3 + 2] = Math.sin(a) * Math.sin(ph) * r;
   *
   * `ph` is the POLAR angle from +Y, so the band is 90° − ph: 9.82°–85.42° for
   * plastic and paper, 10.96°–86.56° for circuit. The port had one invented
   * band (10°–85°) and one invented count (400) for all three.
   */
  private createStars(): void {
    const style = this.palette.stars ?? FALLBACK_STAR_FIELD;
    this.starGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(style.count * 3);

    for (let i = 0; i < style.count; i++) {
      const a = Math.random() * Math.PI * 2;
      const ph = Math.random() * Math.PI * style.polarSpan + style.polarMin;
      const r = STAR_RADIUS;

      positions[i * 3] = Math.cos(a) * Math.sin(ph) * r;
      positions[i * 3 + 1] = Math.cos(ph) * r; // y = up
      positions[i * 3 + 2] = Math.sin(a) * Math.sin(ph) * r;
    }

    this.starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      // `size` is WORLD METRES on the shell, not screen pixels — the demos'
      // model, and the reason `starPointSize` exists rather than a literal
      // here: move the shell and the size has to move with it or the stars
      // change size (17c0f86, which did exactly that to the demos themselves).
      size: starPointSize(style.size, STAR_RADIUS),
      sizeAttenuation: true,
      map: SkyAndFog.createStarTexture(style),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false, // stars are the sky, not the world's air — the demos' flag
      // NormalBlending, the demos'. This used to be additive, which was the
      // other half of "the tint is in the material" — additive over a violet
      // night sky washes every world's stars to the same white. The colour is
      // in the sprite now, so it has to survive to the screen.
      blending: THREE.NormalBlending,
    });

    this.starParticles = new THREE.Points(this.starGeometry, material);
    this.starParticles.visible = false;
    this.gameRenderer.scene.add(this.starParticles);
  }

  private updateStars(celestial: CelestialState, cameraPosition: THREE.Vector3): void {
    if (!this.starParticles) return;

    const sunElev = celestial.sunElevation;

    // The demos' `applyDayNight`, verbatim:
    //
    //     stars.material.opacity = k * 0.9;
    //
    // `k` is the same night factor the rest of this path already runs on, and
    // it is the demos' own: `nightFactorFromElevation` ≡ their
    // `1 − skySmoothstep(−12, 8, sunElev)`, compared bit for bit over 18 000
    // elevations by `[sky vs demo]`.
    //
    // This used to be a ramp of its own — 0 above the horizon, linear to 1 by
    // −6°. Different curve and, more to the point, a different WINDOW: the
    // demos fade stars in while the sun is still 8° UP and only reach full at
    // −12°, so the invented version drew a black sky through the whole of
    // civil twilight and then snapped the stars on. It also capped at 1.0
    // rather than 0.9 — the demos leave that last tenth so a star never quite
    // becomes an opaque dot on the dome.
    const baseOpacity = nightFactorFromElevation(sunElev) * 0.9;

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
      // Centre the star shell on the camera — ALL THREE axes, which is what
      // "stay at consistent distance" requires and what this line used to skip
      // (it copied x and z only). The demos hang stars, discs and dome on one
      // `skyAnchor` and move it with `set(bp.x, bp.y, bp.z)`; over here the
      // gradient dome (`GradientSky.update`) and the sun/moon discs already
      // copy the whole vector, and the star field was the one that did not.
      // Leaving y behind shortens the distance to the stars overhead by
      // exactly the camera's height, so a rider `h` metres above the scene
      // origin has the zenith stars at `STAR_RADIUS − h` — and the whole point
      // of pinning them at 3000 was to keep them outside MOUNTAIN_FAR_RADIUS
      // (2600) and circuit's fins (2700).
      this.starParticles.position.copy(cameraPosition);
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

    // The debug kill switch pins strength at 0; don't ease it back up.
    if (!isCloudShadowDisabled()) {
      const cur = cloudShadowUniforms.uCloudStrength.value;
      cloudShadowUniforms.uCloudStrength.value = cur + (target - cur) * Math.min(1, dt * 2);
    }

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
    // …but it travels ALONG the shell, never through it. The component of `dir`
    // that points at the rider is the line of sight, so it contributes exactly
    // ZERO apparent motion — all it does is carry the streak inboard: 0.5 R of
    // travel off a 3000 m shell reached 1500 m from the camera and 1 m of
    // horizontal distance in the worst case, i.e. straight over the rider's
    // head, and 9.8% of meteors crossed INSIDE `MOUNTAIN_FAR_RADIUS` (2600) low
    // enough to be drawn in front of the far ring (whose crest subtends 14.9°).
    // Projecting it out is invisible on screen and is the same rule the stars
    // and the sun/moon already obey — sky objects live on the sky shell.
    const radial = new THREE.Vector3(sx, sy, sz).divideScalar(r);
    dir.addScaledVector(radial, -dir.dot(radial)).normalize();
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

  /**
   * Cloud billboard texture: fluffy cloud shape (256×128).
   *
   * Deliberately NOT a CanvasTexture, and this is the whole reason the cloud
   * layer used to read as a dark smear. A 2D canvas keeps its backing store
   * PREMULTIPLIED, so `rgba(255,255,255,0)` is stored as (0,0,0,0): the colour
   * of a fully transparent texel is gone and no compositing operation can put it
   * back. Uploading that gives white texels sitting next to BLACK ones — 47.6%
   * of this particular texture is alpha 0 — and:
   *
   *  - at mip 0 that costs almost nothing. The black texels carry alpha 0, so
   *    they contribute nothing to the blend; only a half-texel bilinear fringe
   *    at alpha ~0.01 is affected. This is NOT the bug, and a fix aimed here
   *    (fill white, then `destination-in` the alpha) would not have helped:
   *    destination-in leaves alpha-0 texels at (0,0,0,0) just the same.
   *  - the damage is done by `generateMipmap`, which averages RGBA
   *    *unpremultiplied* — it mixes the black void into texels that DO have
   *    alpha. Measured on this texture, the effective (alpha-weighted) colour
   *    decays 1.00 → 0.96 → 0.86 → 0.63 → 0.52 over mips 0/4/5/6/7+. A
   *    horizontal billboard seen from inside the deck is grazing across most of
   *    the screen, so the sampler sits at exactly those coarse mips: 18 stacked
   *    planes come out at ~0.53 screen value where they should be ~1.0. The
   *    deck darkens precisely when you fly into it.
   *
   * Fix: shape the ALPHA on a canvas (radial gradients are the readable way to
   * author it), read it back, then throw the RGB away and make every texel
   * opaque white before uploading as a DataTexture. Alpha survives the round
   * trip exactly; RGB is white everywhere including alpha = 0, so no amount of
   * filtering or mip reduction can produce anything but white.
   *
   * (DataTexture defaults to flipY = false where CanvasTexture is true, i.e. the
   * blob field is mirrored vertically. Irrelevant here: the billboards are
   * horizontal planes with a random Z rotation.)
   */
  private static createCloudTexture(): THREE.DataTexture {
    const w = 256, h = 128;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

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

    // getImageData hands back UN-premultiplied bytes, so alpha is exact; the RGB
    // it reports for low-alpha texels is quantisation noise and for alpha = 0 is
    // black. Overwrite all of it.
    const rgba = ctx.getImageData(0, 0, w, h).data;
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = 255;
      rgba[i + 1] = 255;
      rgba[i + 2] = 255;
    }

    const texture = new THREE.DataTexture(new Uint8Array(rgba.buffer), w, h, THREE.RGBAFormat);
    // DataTexture defaults: Nearest filtering and generateMipmaps = false.
    // Without these the billboards alias badly at distance.
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
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
    // Turning the layer off while immersed must give the clear-air fog back
    // immediately — update() stops calling this path once cloudGroup is null.
    this.applyCloudImmersion();
  }

  /**
   * Quality-tier hook: cap the billboard cloud count. Stored and used the next
   * time the layer is built; if clouds are already up, rebuilds them now.
   */
  setCloudBudget(count: number): void {
    if (count === this.cloudBudget) return;
    this.cloudBudget = count;
    if (this.cloudGroup) {
      this.removeClouds();
      this.createClouds();
    }
  }

  /**
   * Quality-tier hook: create/remove the always-on ambient particle systems
   * (road dust, blowing leaves). Lower tiers drop them entirely. Idempotent.
   */
  setAmbientParticlesEnabled(dust: boolean, leaves: boolean): void {
    if (dust && !this.dustParticles) this.createDust();
    else if (!dust && this.dustParticles) this.removeDust();
    if (leaves && !this.leafParticles) this.createLeaves();
    else if (!leaves && this.leafParticles) this.removeLeaves();
  }

  private createClouds(): void {
    this.cloudGroup = new THREE.Group();

    for (let i = 0; i < this.cloudBudget; i++) {
      // The style's own cloud, if it declares one. Same deck slot as a
      // billboard: scattered through the layer's thickness, drifted and
      // wrapped by animateClouds. Null falls through to the billboard.
      const styled = this.cloudBuilder?.(i) ?? null;
      if (styled) {
        styled.position.set(
          (Math.random() - 0.5) * CLOUD_AREA,
          Math.random() * CLOUD_LAYER_THICKNESS,
          (Math.random() - 0.5) * CLOUD_AREA,
        );
        styled.userData.styleCloud = true;
        styled.userData.driftOffset = Math.random() * Math.PI * 2;
        // The demo's gentle vertical bob (y += sin(t·0.5 + phase)·0.6·dt —
        // integrated: ±1.2 m about the base). Absolute form so it can never
        // random-walk out of the deck.
        styled.userData.baseY = styled.position.y;
        styled.userData.bobPhase = Math.random() * 9;
        this.cloudGroup.add(styled);
        continue;
      }

      if (!this.cloudTexture) {
        this.cloudTexture = SkyAndFog.createCloudTexture();
      }
      const width = 50 + Math.random() * 100;
      const height = width * 0.4 + Math.random() * width * 0.2;
      const geometry = new THREE.PlaneGeometry(width, height);
      const baseOpacity = 0.4 + Math.random() * 0.3;
      const material = new THREE.MeshBasicMaterial({
        map: this.cloudTexture,
        transparent: true,
        opacity: baseOpacity,
        side: THREE.DoubleSide,
        depthWrite: false,
      });

      const mesh = new THREE.Mesh(geometry, material);
      // Random position within the cloud area. Y is LOCAL to the group, which
      // carries the deck's altitude — see animateClouds.
      mesh.position.set(
        (Math.random() - 0.5) * CLOUD_AREA,
        Math.random() * CLOUD_LAYER_THICKNESS,
        (Math.random() - 0.5) * CLOUD_AREA,
      );
      // Face downward (horizontal plane) with slight random rotation
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = Math.random() * Math.PI * 2;
      // Store a per-cloud drift offset for variation
      mesh.userData.driftOffset = Math.random() * Math.PI * 2;
      // Opacity is modulated per frame by the immersion fade; keep the roll.
      mesh.userData.baseOpacity = baseOpacity;

      this.cloudGroup.add(mesh);
    }

    // Collect the style clouds' (shared, deduplicated) materials for the
    // immersion fade. Billboard materials stay per-mesh — their fade multiplies
    // a per-cloud baseOpacity roll, which shared materials cannot carry.
    const mats = new Set<THREE.Material>();
    for (const child of this.cloudGroup.children) {
      if (!child.userData.styleCloud) continue;
      child.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mats.add(m);
      });
    }
    this.styleCloudMats = [...mats];
    this.styleCloudFade = 1;

    this.gameRenderer.scene.add(this.cloudGroup);
  }

  private removeClouds(): void {
    if (this.cloudGroup) {
      this.gameRenderer.scene.remove(this.cloudGroup);
      // Hand the style's shared materials back the way the hook delivered
      // them (opaque, depth-writing) — they outlive the deck, and a rebuild
      // mid-immersion must not leave them stuck translucent.
      this.applyStyleCloudFade(1);
      this.styleCloudMats = [];
      for (const child of this.cloudGroup.children) {
        if (child.userData.styleCloud) {
          // Style clouds are built from strategy-owned singletons marked
          // `userData.shared` (geometry AND material) — dispose only what is
          // not, plus every InstancedMesh's own instance buffers.
          child.traverse((o) => {
            if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            if (!mesh.geometry.userData.shared) mesh.geometry.dispose();
            for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              if (m.userData.shared) continue;
              (m as THREE.MeshBasicMaterial).map?.dispose();
              m.dispose();
            }
          });
          continue;
        }
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      this.cloudGroup = null;
    }
  }

  /**
   * Deck-wide fade for style-built clouds. Outside the transition this is a
   * single float compare; the transparent/depthWrite flip happens only when
   * the fade crosses 1 in either direction, so the clouds are genuinely
   * OPAQUE (no blend cost, correct self-occlusion) in normal flight and only
   * pay for translucency while the rider is actually crossing the deck edge.
   */
  private applyStyleCloudFade(fade: number): void {
    if (!this.styleCloudMats.length || fade === this.styleCloudFade) return;
    const wasFull = this.styleCloudFade >= 1;
    const isFull = fade >= 1;
    for (const m of this.styleCloudMats) {
      m.opacity = fade;
      if (wasFull !== isFull) {
        m.transparent = !isFull;
        m.depthWrite = isFull;
        m.needsUpdate = true;
      }
    }
    this.styleCloudFade = fade;
  }

  private animateClouds(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.cloudGroup) return;

    // Centre on the camera in XZ; Y carries the deck's ALTITUDE, re-derived from
    // the live floating origin every frame. The group's Y used to be left at 0,
    // which pinned the deck to scene height 200–400 — i.e. to whatever altitude
    // the ride happened to start at, and it slid by the delta on any rebase.
    this.cloudGroup.position.set(cameraPosition.x, this.cloudBaseSceneY(), cameraPosition.z);

    // Billboards are horizontal planes. Once the camera is genuinely inside the
    // deck they sweep through the near plane as hard-edged sheets, which reads as
    // a clipping glitch rather than as cloud — the fog is what sells the
    // interior. So fade them out over the back half of the transition: they are
    // the deck's SHAPE, seen from outside, and shape is not a thing you can see
    // from within. Still up at k ≤ 0.25, gone by k ≥ 0.75.
    const fade = 1 - smoothstep(0.25, 0.75, this.cloudImmersion);
    const visible = fade > 0.01;

    // Style clouds fade as a deck (their materials are shared singletons);
    // billboards keep their per-mesh baseOpacity × fade below.
    this.applyStyleCloudFade(fade);

    // Gentle drift + wind transport (clouds drift ~2× ground particle speed)
    const windScale = 2;
    const now = performance.now();
    for (const child of this.cloudGroup.children) {
      const mesh = child as THREE.Mesh;
      mesh.visible = visible;
      if (child.userData.styleCloud) {
        // The demo's bob, in absolute form (see createClouds).
        child.position.y =
          (child.userData.baseY as number) +
          Math.sin(now * 0.0005 + (child.userData.bobPhase as number)) * 1.2;
      } else {
        (mesh.material as THREE.MeshBasicMaterial).opacity =
          (mesh.userData.baseOpacity as number) * fade;
      }
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
    const phases = new Float32Array(DUST_PARTICLE_COUNT);

    for (let i = 0; i < DUST_PARTICLE_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * DUST_AREA;
      positions[i * 3 + 1] = 0.5 + Math.random() * 7.5; // y: 0.5–8m
      positions[i * 3 + 2] = (Math.random() - 0.5) * DUST_AREA;
      phases[i] = Math.random() * 100;
    }

    this.dustGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.dustGeometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

    const material = createFallingParticleMaterial({
      map: SkyAndFog.createDustTexture(),
      color: 0xd2be96,
      opacity: 0.5,
      size: 0.15,
      area: DUST_AREA,
      // velocity amps 0.8/0.56 at freqs 0.3/0.4 → positional amps 2.67/1.4
      sway: { fx: 0.3, fz: 0.4, ax: 2.67, az: 1.4 },
      // vertical: velocity amp 0.1 at freq 0.2 → positional amp 0.5, clamped 0.5–8m
      bob: { f: 0.2, a: 0.5, min: 0.5, max: 8 },
    });

    this.dustParticles = new THREE.Points(this.dustGeometry, material);
    this.gameRenderer.scene.add(this.dustParticles);
  }

  private removeDust(): void {
    if (this.dustParticles) {
      this.gameRenderer.scene.remove(this.dustParticles);
      this.dustGeometry?.dispose();
      const mat = this.dustParticles.material as THREE.ShaderMaterial;
      (mat.uniforms['uMap'].value as THREE.Texture | null)?.dispose();
      mat.dispose();
      this.dustParticles = null;
      this.dustGeometry = null;
    }
  }

  private animateDust(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.dustParticles) return;

    // Center around camera (x/z only — dust hovers near ground level)
    this.dustParticles.position.x = cameraPosition.x;
    this.dustParticles.position.z = cameraPosition.z;

    // Drift + bob run in the vertex shader — only advance uniforms.
    this.advanceParticleUniforms(this.dustParticles, dt, DUST_AREA);
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
    const speeds = new Float32Array(LEAF_PARTICLE_COUNT);
    const phases = new Float32Array(LEAF_PARTICLE_COUNT);

    for (let i = 0; i < LEAF_PARTICLE_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * LEAF_AREA;
      positions[i * 3 + 1] = 2 + Math.random() * 13; // y: 2–15m
      positions[i * 3 + 2] = (Math.random() - 0.5) * LEAF_AREA;
      speeds[i] = LEAF_FALL_SPEED;
      phases[i] = Math.random() * 100;
    }

    this.leafGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.leafGeometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    this.leafGeometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

    const material = createFallingParticleMaterial({
      map: SkyAndFog.createLeafTexture(),
      color: 0xffffff,
      opacity: 0.8,
      size: 0.6,
      area: LEAF_AREA,
      // velocity amps 1.2/0.72 at freqs 0.6/0.5 → positional amps 2.0/1.44
      sway: { fx: 0.6, fz: 0.5, ax: 2.0, az: 1.44 },
      // Fall wraps at 15m (the old CPU respawn ceiling), not the 80m box edge
      wrapY: 15,
    });

    this.leafParticles = new THREE.Points(this.leafGeometry, material);
    this.gameRenderer.scene.add(this.leafParticles);
  }

  private removeLeaves(): void {
    if (this.leafParticles) {
      this.gameRenderer.scene.remove(this.leafParticles);
      this.leafGeometry?.dispose();
      const mat = this.leafParticles.material as THREE.ShaderMaterial;
      (mat.uniforms['uMap'].value as THREE.Texture | null)?.dispose();
      mat.dispose();
      this.leafParticles = null;
      this.leafGeometry = null;
    }
  }

  private animateLeaves(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.leafParticles) return;

    // Center around camera (x/z only — leaves live in a low 0–15m band)
    this.leafParticles.position.x = cameraPosition.x;
    this.leafParticles.position.z = cameraPosition.z;

    // Fall + sway + drift run in the vertex shader — only advance uniforms.
    this.advanceParticleUniforms(this.leafParticles, dt, LEAF_AREA);
  }

  // ── Rain ──

  /**
   * Quality-tier hook: change rain/snow particle budgets. Recreates any
   * currently active system at the new count.
   */
  setParticleCounts(rain: number, snow: number): void {
    if (rain === this.rainCount && snow === this.snowCount) return;
    this.rainCount = rain;
    this.snowCount = snow;
    if (this.rainParticles) {
      this.removeRain();
      this.createRain();
    }
    if (this.snowParticles) {
      this.removeSnow();
      this.createSnow();
    }
  }

  private updateRain(enable: boolean): void {
    if (enable && !this.rainParticles) {
      this.createRain();
    } else if (!enable && this.rainParticles) {
      this.removeRain();
    }
  }

  private createRain(): void {
    this.rainGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(this.rainCount * 3);
    const speeds = new Float32Array(this.rainCount);

    for (let i = 0; i < this.rainCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * RAIN_AREA;
      positions[i * 3 + 1] = Math.random() * RAIN_AREA;
      positions[i * 3 + 2] = (Math.random() - 0.5) * RAIN_AREA;
      speeds[i] = RAIN_SPEED
        * (FALL_SPEED_JITTER_MIN + Math.random() * (FALL_SPEED_JITTER_MAX - FALL_SPEED_JITTER_MIN));
    }

    this.rainGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.rainGeometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));

    const material = createFallingParticleMaterial({
      map: SkyAndFog.createRainTexture(),
      color: 0xaaaacc,
      opacity: 0.6,
      size: 0.5,
      area: RAIN_AREA,
      blending: THREE.AdditiveBlending,
    });

    this.rainParticles = new THREE.Points(this.rainGeometry, material);
    this.gameRenderer.scene.add(this.rainParticles);
  }

  private removeRain(): void {
    if (this.rainParticles) {
      this.gameRenderer.scene.remove(this.rainParticles);
      this.rainGeometry?.dispose();
      const mat = this.rainParticles.material as THREE.ShaderMaterial;
      (mat.uniforms['uMap'].value as THREE.Texture | null)?.dispose();
      mat.dispose();
      this.rainParticles = null;
      this.rainGeometry = null;
    }
  }

  /**
   * Advance the shared GPU-particle uniforms (time, wind transport, gust,
   * point scale). Wind offset is wrapped into [0, area): the shader's mod()
   * is periodic in AREA, so this is identical but keeps the float32 uniform
   * from losing precision as it grows over a multi-hour ride.
   */
  private advanceParticleUniforms(points: THREE.Points, dt: number, area: number): void {
    const u = (points.material as THREE.ShaderMaterial).uniforms;
    u['uTime'].value += dt;
    const w = u['uWindOffset'].value as THREE.Vector2;
    w.x = (((w.x + this.wind.vx * dt) % area) + area) % area;
    w.y = (((w.y + this.wind.vz * dt) % area) + area) % area;
    u['uGust'].value = this.wind.gust;
    u['uScale'].value = this.gameRenderer.renderer.domElement.height * 0.5;
  }

  private animateRain(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.rainParticles) return;

    // Center rain around camera (vertically too — routes above RAIN_AREA
    // elevation would otherwise leave the whole band under the terrain)
    this.rainParticles.position.x = cameraPosition.x;
    this.rainParticles.position.y = cameraPosition.y - RAIN_AREA * 0.25;
    this.rainParticles.position.z = cameraPosition.z;

    // Fall + drift happen in the vertex shader — only advance the uniforms.
    this.advanceParticleUniforms(this.rainParticles, dt, RAIN_AREA);
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
    const positions = new Float32Array(this.snowCount * 3);
    const speeds = new Float32Array(this.snowCount);
    const phases = new Float32Array(this.snowCount);

    for (let i = 0; i < this.snowCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * SNOW_AREA;
      positions[i * 3 + 1] = Math.random() * SNOW_AREA;
      positions[i * 3 + 2] = (Math.random() - 0.5) * SNOW_AREA;
      speeds[i] = SNOW_SPEED
        * (FALL_SPEED_JITTER_MIN + Math.random() * (FALL_SPEED_JITTER_MAX - FALL_SPEED_JITTER_MIN));
      phases[i] = Math.random() * 100;
    }

    this.snowGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.snowGeometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    this.snowGeometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

    const material = createFallingParticleMaterial({
      map: SkyAndFog.createSnowTexture(),
      color: 0xffffff,
      opacity: 0.8,
      size: 0.6,
      area: SNOW_AREA,
      // velocity amps 0.6/0.4 at freqs 0.5/0.7 → positional amps 1.2/0.57
      sway: { fx: 0.5, fz: 0.7, ax: 1.2, az: 0.57 },
    });

    this.snowParticles = new THREE.Points(this.snowGeometry, material);
    this.gameRenderer.scene.add(this.snowParticles);
  }

  private removeSnow(): void {
    if (this.snowParticles) {
      this.gameRenderer.scene.remove(this.snowParticles);
      this.snowGeometry?.dispose();
      const mat = this.snowParticles.material as THREE.ShaderMaterial;
      (mat.uniforms['uMap'].value as THREE.Texture | null)?.dispose();
      mat.dispose();
      this.snowParticles = null;
      this.snowGeometry = null;
    }
  }

  private animateSnow(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.snowParticles) return;

    // Center snow around camera (vertically too, same as rain)
    this.snowParticles.position.x = cameraPosition.x;
    this.snowParticles.position.y = cameraPosition.y - SNOW_AREA * 0.25;
    this.snowParticles.position.z = cameraPosition.z;

    // Fall + sway + drift happen in the vertex shader — only advance uniforms.
    this.advanceParticleUniforms(this.snowParticles, dt, SNOW_AREA);
  }
}
