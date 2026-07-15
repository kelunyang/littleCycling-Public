/**
 * Maps CelestialState + weather + world style → concrete Three.js lighting.
 *
 * The old version blended between hard-coded "realistic" colour constants and
 * pushed `toneMappingExposure` down to 0.6–0.9 to stop the Preetham sky dome
 * from blowing out. With the sky replaced by a flat gradient dome (see
 * `gradient-sky.ts`), that crutch is gone: **exposure is constant** and the mood
 * comes entirely from the style's own day/night palette + fog.
 *
 * Both ends of the blend are the demos' hand-tuned values (`strategy.skyPalette`),
 * so the darkest this world can ever get is the demos' night — never a black
 * hole. Weather adds haze and flattens the key light; it must not add darkness.
 */

import * as THREE from 'three';
import type { CelestialState } from './sun-moon-calc';
import type { WeatherType } from './sky-and-fog';
import type { SkyMood, SkyPalette } from './terrain-style-strategy';
import { CHUNK_LENGTH, CHUNKS_AHEAD } from './terrain-chunk-manager';

/** Maximum fog far distance — terrain edges must always be hidden. */
const MAX_FOG_FAR = CHUNK_LENGTH * CHUNKS_AHEAD; // 6000m

/**
 * Constant tone-mapping exposure (ACES), the demos' value. Never modulated: the
 * scene is lit by its palette, not by the camera's shutter. Dropping this was
 * the single biggest reason the world went muddy at dusk and in overcast.
 */
export const TONE_MAPPING_EXPOSURE = 1.05;

/**
 * Fallback palette, used only until `SkyAndFog.setPalette()` receives the world
 * style's own (the strategy loads async). Neutral daylight — not either style.
 */
export const DEFAULT_SKY_PALETTE: SkyPalette = {
  day: {
    skyTop: 0x8fd8ee, skyBottom: 0xf0e6e0, fog: 0xe6dcd0,
    sunColor: 0xfff4e0, sunIntensity: 2.0,
    hemiSky: 0xd8f0f8, hemiGround: 0x88a070, hemiIntensity: 0.9,
    ambientColor: 0xfff4ec, ambientIntensity: 0.35,
  },
  night: {
    skyTop: 0x1c1a44, skyBottom: 0x423560, fog: 0x2f2a50,
    sunColor: 0x9fb0e8, sunIntensity: 0.7,
    hemiSky: 0x323868, hemiGround: 0x33372c, hemiIntensity: 0.5,
    ambientColor: 0xfff4ec, ambientIntensity: 0.18,
  },
};

/** Lighting parameters computed from time of day + weather. */
export interface DayNightLightingParams {
  ambientIntensity: number;
  ambientColor: number;
  directionalIntensity: number;
  directionalColor: number;
  hemisphereIntensity: number;
  hemisphereColor: number;
  hemisphereGroundColor: number;
  /** Gradient dome, top and horizon. */
  skyTopColor: number;
  skyBottomColor: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  backgroundColor: number;
  toneMappingExposure: number;
}

// ── Twilight warmth ──

/**
 * Dawn/dusk tint. The day↔night blend alone goes straight from blue to blue; a
 * pass of warm orange around the horizon crossing gives back the golden hour
 * without darkening anything.
 */
const TWILIGHT_SUN = 0xff9a4a;
const TWILIGHT_SKY_BOTTOM = 0xffb27a;
const TWILIGHT_FOG = 0xe8b090;

// ── Weather ──

interface WeatherMultipliers {
  /** Fill light — overcast SCATTERS light, so this goes UP, not down. */
  ambientMul: number;
  /** Key light — clouds soften the sun; the scene flattens, it does not darken. */
  directionalMul: number;
  hemisphereMul: number;
  fogNearMul: number;
  fogFarMul: number;
  /** Grey the sky/fog is pulled toward, and how far (0 = none). */
  overcastColor: number;
  overcastMix: number;
}

const WEATHER: Record<WeatherType, WeatherMultipliers> = {
  sunny: {
    ambientMul: 1.0,
    directionalMul: 1.0,
    hemisphereMul: 1.0,
    fogNearMul: 1.0,
    fogFarMul: 1.0,
    overcastColor: 0x000000,
    overcastMix: 0,
  },
  cloudy: {
    // Flat, hazy, and BRIGHT — an overcast noon is not a dim noon.
    ambientMul: 1.3,
    directionalMul: 0.5,
    hemisphereMul: 1.25,
    fogNearMul: 0.4,
    fogFarMul: 0.45,
    overcastColor: 0xc4c8cc,
    overcastMix: 0.5,
  },
  rainy: {
    ambientMul: 1.1,
    directionalMul: 0.35,
    hemisphereMul: 0.9,
    fogNearMul: 0.25,
    fogFarMul: 0.3,
    overcastColor: 0xa8acb4,
    overcastMix: 0.6,
  },
  snowy: {
    ambientMul: 1.2,
    directionalMul: 0.42,
    hemisphereMul: 1.05,
    fogNearMul: 0.35,
    fogFarMul: 0.35,
    overcastColor: 0xd0d0d4,
    overcastMix: 0.7,
  },
};

/**
 * Hard floors, as a fraction of the style's NIGHT mood. No combination of hour
 * and weather may go below these — "the darkest night is the demo's night" is a
 * product requirement, so it is enforced at the exit rather than trusted to the
 * arithmetic. A stormy 3am lands here.
 */
const FLOOR = {
  ambient: 1.0,      // never dimmer than the night palette's fill
  directional: 0.35,
  hemisphere: 0.6,
};

// ── Helpers ──

const _a = new THREE.Color();
const _b = new THREE.Color();

/** Linearly interpolate two hex colours. t ∈ [0,1]. */
function mixHex(a: number, b: number, t: number): number {
  return _a.setHex(a).lerp(_b.setHex(b), Math.max(0, Math.min(1, t))).getHex();
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/** Smooth 0→1 ramp between two thresholds. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * How much of the NIGHT mood is mixed in, from the sun's elevation.
 * 1 = deep night (sun below −12°), 0 = day (sun above +8°).
 */
export function nightFactorFromElevation(sunElevation: number): number {
  return 1 - smoothstep(-12, 8, sunElevation);
}

/** How "golden" the hour is — peaks as the sun crosses the horizon. */
function twilightFactor(sunElevation: number): number {
  if (sunElevation < -10 || sunElevation > 14) return 0;
  // Peak at ~2°, tapering either side.
  return sunElevation <= 2
    ? smoothstep(-10, 2, sunElevation)
    : 1 - smoothstep(2, 14, sunElevation);
}

/** Blend the two ends of a style's palette into one mood. */
function blendMood(day: SkyMood, night: SkyMood, k: number): SkyMood {
  return {
    skyTop: mixHex(day.skyTop, night.skyTop, k),
    skyBottom: mixHex(day.skyBottom, night.skyBottom, k),
    fog: mixHex(day.fog, night.fog, k),
    sunColor: mixHex(day.sunColor, night.sunColor, k),
    sunIntensity: lerp(day.sunIntensity, night.sunIntensity, k),
    hemiSky: mixHex(day.hemiSky, night.hemiSky, k),
    hemiGround: mixHex(day.hemiGround, night.hemiGround, k),
    hemiIntensity: lerp(day.hemiIntensity, night.hemiIntensity, k),
    ambientColor: mixHex(day.ambientColor, night.ambientColor, k),
    ambientIntensity: lerp(day.ambientIntensity, night.ambientIntensity, k),
  };
}

/**
 * Compute final lighting from celestial state, weather, and the world style's
 * palette.
 */
export function computeDayNightLighting(
  celestial: CelestialState,
  weather: WeatherType,
  palette: SkyPalette,
): DayNightLightingParams {
  const { sunElevation } = celestial;
  const w = WEATHER[weather];

  const night = nightFactorFromElevation(sunElevation);
  const mood = blendMood(palette.day, palette.night, night);

  // Golden hour: warm the key light, the horizon band, and the fog — colour
  // only, no intensity change.
  const golden = twilightFactor(sunElevation);
  if (golden > 0) {
    mood.sunColor = mixHex(mood.sunColor, TWILIGHT_SUN, golden * 0.8);
    mood.skyBottom = mixHex(mood.skyBottom, TWILIGHT_SKY_BOTTOM, golden * 0.65);
    mood.fog = mixHex(mood.fog, TWILIGHT_FOG, golden * 0.5);
  }

  // Weather: haze the sky/fog toward grey, flatten the key light, lift the fill.
  let skyTop = mood.skyTop;
  let skyBottom = mood.skyBottom;
  let fogColor = mood.fog;
  if (w.overcastMix > 0) {
    // Grey the overcast toward the current mood's own darkness so a cloudy night
    // stays a NIGHT (deep blue-grey), not a bright grey day with the lights off.
    const grey = mixHex(w.overcastColor, mood.skyTop, night * 0.75);
    skyTop = mixHex(skyTop, grey, w.overcastMix);
    skyBottom = mixHex(skyBottom, grey, w.overcastMix * 0.85);
    fogColor = mixHex(fogColor, grey, w.overcastMix);
  }

  // Fog distances: base spans lerped day→night, then hauled in by weather.
  const baseFogNear = lerp(800, 600, night);
  const baseFogFar = lerp(3000, 2600, night);
  const fogFar = Math.min(baseFogFar * w.fogFarMul, MAX_FOG_FAR);
  const fogNear = Math.min(baseFogNear * w.fogNearMul, fogFar * 0.3);

  // Floors — the demos' night is the darkest this world gets, whatever the sky
  // is doing. Applied AFTER the weather multipliers, which is the whole point.
  const n = palette.night;
  const ambientIntensity = Math.max(
    mood.ambientIntensity * w.ambientMul,
    n.ambientIntensity * FLOOR.ambient,
  );
  const directionalIntensity = Math.max(
    mood.sunIntensity * w.directionalMul,
    n.sunIntensity * FLOOR.directional,
  );
  const hemisphereIntensity = Math.max(
    mood.hemiIntensity * w.hemisphereMul,
    n.hemiIntensity * FLOOR.hemisphere,
  );

  return {
    ambientIntensity,
    ambientColor: mood.ambientColor,
    directionalIntensity,
    directionalColor: mood.sunColor,
    hemisphereIntensity,
    hemisphereColor: mood.hemiSky,
    hemisphereGroundColor: mood.hemiGround,
    skyTopColor: skyTop,
    skyBottomColor: skyBottom,
    fogColor,
    fogNear,
    fogFar,
    // The dome covers the whole view, so this only shows through if the dome is
    // ever culled — keep it on the horizon colour so it can't flash black.
    backgroundColor: skyBottom,
    toneMappingExposure: TONE_MAPPING_EXPOSURE,
  };
}
