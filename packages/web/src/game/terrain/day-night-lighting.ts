/**
 * Maps CelestialState → concrete Three.js lighting parameters.
 *
 * Produces base intensity/color values that the weather system
 * multiplies against its own weather-specific factors.
 */

import type { CelestialState } from './sun-moon-calc';
import type { WeatherType } from './sky-and-fog';
import { CHUNK_LENGTH, CHUNKS_AHEAD } from './terrain-chunk-manager';

/** Maximum fog far distance — terrain edges must always be hidden. */
const MAX_FOG_FAR = CHUNK_LENGTH * CHUNKS_AHEAD; // 6000m

/** Lighting parameters computed from time of day + weather. */
export interface DayNightLightingParams {
  ambientIntensity: number;
  ambientColor: number;
  directionalIntensity: number;
  directionalColor: number;
  hemisphereIntensity: number;
  hemisphereColor: number;
  hemisphereGroundColor: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  backgroundColor: number;
  toneMappingExposure: number;
}

// ── Color constants ──

const COLORS = {
  // Deep night — cartoon: high-value cool-blue, vertex colors stay readable
  nightAmbient: 0xb0c0d8,       // light steel blue — preserves vertex color hues
  nightDirectional: 0xc8d4e8,   // pale moonlight, near-white with blue tint
  nightHemiSky: 0xa0b8d0,       // soft sky blue
  nightHemiGround: 0x607060,    // gray-green (terrain underside stays visible)
  nightFog: 0x8090a8,           // blue-gray fog (bright, not black)
  nightBackground: 0x607888,    // blue-gray, close to fog color (no black void)

  // Twilight (dawn/dusk) — smooth warm-cool transition
  twilightAmbient: 0xc0a8c8,    // lavender
  twilightDirectional: 0xee8844, // orange glow
  twilightHemiSky: 0xb098d0,    // soft purple
  twilightHemiGround: 0x665544, // warm earth
  twilightFog: 0x9088a0,        // muted lavender
  twilightBackground: 0x443366, // purple sky

  // Golden hour
  goldenAmbient: 0xffddaa,
  goldenDirectional: 0xffaa55, // warm orange
  goldenHemiSky: 0xffccaa,
  goldenHemiGround: 0x554422,
  goldenFog: 0xeeddcc,
  goldenBackground: 0xeebb88,

  // Daytime (weather provides final tint)
  dayAmbient: 0xffffff,
  dayDirectional: 0xfff4e0,
  dayHemiSky: 0x87ceeb,
  dayHemiGround: 0x556633,
  dayFog: 0xdce6f0,
  dayBackground: 0x87ceeb,
} as const;

// ── Weather multipliers ──

interface WeatherMultipliers {
  ambientMul: number;
  directionalMul: number;
  hemisphereMul: number;
  fogNearMul: number;
  fogFarMul: number;
}

const WEATHER_MULTIPLIERS: Record<WeatherType, WeatherMultipliers> = {
  sunny: {
    ambientMul: 1.0,
    directionalMul: 1.0,
    hemisphereMul: 1.0,
    fogNearMul: 1.0,
    fogFarMul: 1.0,
  },
  cloudy: {
    ambientMul: 1.1,
    directionalMul: 0.2,
    hemisphereMul: 1.2,
    fogNearMul: 0.4,
    fogFarMul: 0.45,
  },
  rainy: {
    ambientMul: 0.8,
    directionalMul: 0.18,
    hemisphereMul: 0.7,
    fogNearMul: 0.25,
    fogFarMul: 0.3,
  },
  snowy: {
    ambientMul: 0.9,
    directionalMul: 0.25,
    hemisphereMul: 0.85,
    fogNearMul: 0.35,
    fogFarMul: 0.35,
  },
};

// ── Helpers ──

/** Linearly interpolate two hex colors. t ∈ [0,1]. */
function lerpColor(a: number, b: number, t: number): number {
  const ct = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * ct);
  const g = Math.round(ag + (bg - ag) * ct);
  const blue = Math.round(ab + (bb - ab) * ct);
  return (r << 16) | (g << 8) | blue;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

/**
 * Compute final lighting parameters from celestial state and weather.
 */
export function computeDayNightLighting(
  celestial: CelestialState,
  weather: WeatherType,
): DayNightLightingParams {
  const { sunElevation, dayFactor } = celestial;
  const wm = WEATHER_MULTIPLIERS[weather];

  // Determine which color palette to blend from/to and the blend factor.
  // We use sunElevation for finer control than dayFactor alone.

  let ambientColor: number;
  let directionalColor: number;
  let hemiSkyColor: number;
  let hemiGroundColor: number;
  let fogColor: number;
  let bgColor: number;
  let baseAmbient: number;
  let baseDirectional: number;
  let baseHemisphere: number;
  let baseFogNear: number;
  let baseFogFar: number;
  let exposure: number;

  if (sunElevation <= -12) {
    // ── Deep night — cartoon: cool-blue tint, ~85-90% of daytime brightness ──
    ambientColor = COLORS.nightAmbient;
    directionalColor = COLORS.nightDirectional;
    hemiSkyColor = COLORS.nightHemiSky;
    hemiGroundColor = COLORS.nightHemiGround;
    fogColor = COLORS.nightFog;
    bgColor = COLORS.nightBackground;
    baseAmbient = 0.85;
    baseDirectional = 0.5;
    baseHemisphere = 0.7;
    baseFogNear = 600;
    baseFogFar = 2600;
    exposure = 0.8;
  } else if (sunElevation <= 0) {
    // ── Twilight (dawn/dusk) ──
    const t = (sunElevation + 12) / 12; // 0 at -12°, 1 at 0°
    ambientColor = lerpColor(COLORS.nightAmbient, COLORS.twilightAmbient, t);
    directionalColor = lerpColor(COLORS.nightDirectional, COLORS.twilightDirectional, t);
    hemiSkyColor = lerpColor(COLORS.nightHemiSky, COLORS.twilightHemiSky, t);
    hemiGroundColor = lerpColor(COLORS.nightHemiGround, COLORS.twilightHemiGround, t);
    fogColor = lerpColor(COLORS.nightFog, COLORS.twilightFog, t);
    bgColor = lerpColor(COLORS.nightBackground, COLORS.twilightBackground, t);
    baseAmbient = lerp(0.85, 0.75, t);
    baseDirectional = lerp(0.5, 0.65, t);
    baseHemisphere = lerp(0.7, 0.6, t);
    baseFogNear = lerp(600, 650, t);
    baseFogFar = lerp(2600, 2700, t);
    exposure = 0.9;
  } else if (sunElevation <= 10) {
    // ── Golden hour ──
    const t = sunElevation / 10; // 0 at 0°, 1 at 10°
    ambientColor = lerpColor(COLORS.twilightAmbient, COLORS.goldenAmbient, t);
    directionalColor = lerpColor(COLORS.twilightDirectional, COLORS.goldenDirectional, t);
    hemiSkyColor = lerpColor(COLORS.twilightHemiSky, COLORS.goldenHemiSky, t);
    hemiGroundColor = lerpColor(COLORS.twilightHemiGround, COLORS.goldenHemiGround, t);
    fogColor = lerpColor(COLORS.twilightFog, COLORS.goldenFog, t);
    bgColor = lerpColor(COLORS.twilightBackground, COLORS.goldenBackground, t);
    baseAmbient = lerp(0.65, 0.6, t);
    baseDirectional = lerp(0.6, 0.8, t);
    baseHemisphere = lerp(0.6, 0.55, t);
    baseFogNear = lerp(650, 700, t);
    baseFogFar = lerp(2700, 2800, t);
    exposure = 0.7;
  } else {
    // ── Full daytime ──
    // Exposure kept low (0.6) to prevent Preetham sky from blowing out.
    const t = Math.min((sunElevation - 10) / 50, 1); // 10° → 60°+ maps to 0→1
    ambientColor = lerpColor(COLORS.goldenAmbient, COLORS.dayAmbient, t);
    directionalColor = lerpColor(COLORS.goldenDirectional, COLORS.dayDirectional, t);
    hemiSkyColor = lerpColor(COLORS.goldenHemiSky, COLORS.dayHemiSky, t);
    hemiGroundColor = lerpColor(COLORS.goldenHemiGround, COLORS.dayHemiGround, t);
    fogColor = lerpColor(COLORS.goldenFog, COLORS.dayFog, t);
    bgColor = lerpColor(COLORS.goldenBackground, COLORS.dayBackground, t);
    baseAmbient = lerp(0.55, 0.5, t);
    baseDirectional = lerp(0.8, 0.9, t);
    baseHemisphere = lerp(0.5, 0.45, t);
    baseFogNear = lerp(700, 800, t);
    baseFogFar = lerp(2800, 3000, t);
    exposure = 0.6;
  }

  // Apply weather multipliers, clamp fog to render distance
  const finalFogFar = Math.min(baseFogFar * wm.fogFarMul, MAX_FOG_FAR);
  const finalFogNear = Math.min(baseFogNear * wm.fogNearMul, finalFogFar * 0.3);

  // Reduce exposure for overcast weather (sky shader is hidden, prevents residual blow-out)
  const exposureMultiplier =
    weather === 'snowy' ? 0.85
    : weather === 'rainy' ? 0.9
    : weather === 'cloudy' ? 0.9
    : 1.0;

  // Overcast weather: push fog + background toward flat gray so the scene
  // looks properly overcast when the Preetham sky shader is hidden.
  if (weather === 'snowy') {
    const overcastGray = 0xc8c8cc; // light overcast gray
    fogColor = lerpColor(fogColor, overcastGray, 0.7);
    bgColor = lerpColor(bgColor, overcastGray, 0.7);
  } else if (weather === 'rainy') {
    const rainGray = 0x909098; // darker overcast gray
    fogColor = lerpColor(fogColor, rainGray, 0.6);
    bgColor = lerpColor(bgColor, rainGray, 0.6);
  } else if (weather === 'cloudy') {
    const cloudyGray = 0xb8bcc0; // light gray overcast
    fogColor = lerpColor(fogColor, cloudyGray, 0.5);
    bgColor = lerpColor(bgColor, cloudyGray, 0.5);
  }

  return {
    ambientIntensity: baseAmbient * wm.ambientMul,
    ambientColor,
    directionalIntensity: baseDirectional * wm.directionalMul,
    directionalColor,
    hemisphereIntensity: baseHemisphere * wm.hemisphereMul,
    hemisphereColor: hemiSkyColor,
    hemisphereGroundColor: hemiGroundColor,
    fogColor,
    fogNear: finalFogNear,
    fogFar: finalFogFar,
    backgroundColor: bgColor,
    toneMappingExposure: exposure * exposureMultiplier,
  };
}
