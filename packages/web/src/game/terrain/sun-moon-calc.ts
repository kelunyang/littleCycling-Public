/**
 * Simplified astronomical calculations for sun and moon positions.
 *
 * Given a date/time and geographic coordinates, computes elevation and azimuth
 * angles for both the sun and moon. Accuracy is sufficient for realistic
 * game lighting — not intended for navigation or scientific use.
 *
 * Local time is approximated from longitude (UTC offset ≈ longitude / 15).
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export interface CelestialState {
  /** Sun elevation in degrees (negative = below horizon). */
  sunElevation: number;
  /** Sun azimuth in degrees (0 = north, clockwise). */
  sunAzimuth: number;
  /** Moon elevation in degrees. */
  moonElevation: number;
  /** Moon azimuth in degrees. */
  moonAzimuth: number;
  /** Moon phase 0–1 (0 = new moon, 0.5 = full moon). */
  moonPhase: number;
  /** True when sunElevation > 0. */
  isDaytime: boolean;
  /**
   * Smooth factor 0.0 (deep night) → 1.0 (noon).
   * Transitions through twilight zones for gradual lighting changes.
   */
  dayFactor: number;
}

/** Day-of-year (1-based). */
function dayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  return Math.floor(diff / 86_400_000);
}

/**
 * Compute approximate solar hour at a given longitude.
 * Uses longitude-based UTC offset (no timezone database needed).
 */
function solarHour(date: Date, longitude: number): number {
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  // Longitude-based offset: each 15° = 1 hour
  const offset = longitude / 15;
  return ((utcHours + offset) % 24 + 24) % 24;
}

/**
 * Solar declination angle (degrees) for a given day of year.
 * Simplified formula: δ = 23.45 × sin(360/365 × (284 + doy))
 */
function solarDeclination(doy: number): number {
  return 23.45 * Math.sin(DEG * (360 / 365) * (284 + doy));
}

/**
 * Compute sun elevation and azimuth.
 */
function sunPosition(
  latitude: number,
  longitude: number,
  date: Date,
): { elevation: number; azimuth: number } {
  const doy = dayOfYear(date);
  const hour = solarHour(date, longitude);

  const decl = solarDeclination(doy) * DEG; // radians
  const lat = latitude * DEG;

  // Hour angle: 15° per hour from solar noon
  const hourAngle = (hour - 12) * 15 * DEG;

  // Elevation
  const sinElev =
    Math.sin(lat) * Math.sin(decl) +
    Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinElev))) * RAD;

  // Azimuth
  const cosAz =
    (Math.sin(decl) - Math.sin(lat) * sinElev) /
    (Math.cos(lat) * Math.cos(elevation * DEG));
  let azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz))) * RAD;
  // Afternoon → azimuth > 180
  if (hourAngle > 0) azimuth = 360 - azimuth;

  return { elevation, azimuth };
}

/**
 * Simplified moon phase calculation.
 * Returns 0–1 (0 = new moon, 0.5 = full moon, 1 = next new moon).
 * Uses the synodic month (~29.53 days) with a known new-moon epoch.
 */
function moonPhase(date: Date): number {
  // Known new moon: 2000-01-06 18:14 UTC
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
  const synodicMonth = 29.53058770576;
  const daysSince = (date.getTime() - knownNewMoon) / 86_400_000;
  const phase = ((daysSince % synodicMonth) + synodicMonth) % synodicMonth;
  return phase / synodicMonth;
}

/**
 * Simplified moon position.
 *
 * The moon's position is approximated as roughly opposite the sun
 * with an offset based on the current moon phase. At full moon (phase ≈ 0.5)
 * the moon is directly opposite the sun; at new moon (phase ≈ 0) they overlap.
 */
function moonPosition(
  sunElev: number,
  sunAz: number,
  phase: number,
): { elevation: number; azimuth: number } {
  // Phase offset: 0 at new moon (near sun), 180° at full moon (opposite sun)
  const phaseOffset = phase * 360;

  // Moon azimuth: sun azimuth + phase-based offset
  const azimuth = ((sunAz + phaseOffset) % 360 + 360) % 360;

  // Moon elevation: roughly mirrors sun but shifted.
  // At full moon when sun is down, moon is high. Simple approximation:
  // moonElev ≈ -sunElev × (0.3 + 0.7 × |phase - 0.5| / 0.5 inverted)
  // Simplify: when phase near 0.5, moon is roughly -sun; otherwise attenuated
  const fullness = 1 - 2 * Math.abs(phase - 0.5); // 0 at new/full→1 at quarters... no
  // Actually: fullness = how close to full moon. 1.0 = full moon, 0.0 = new moon
  const fullMoonFactor = 1 - 2 * Math.abs(phase - 0.5); // 0→1→0 peaks at 0.5
  const elevation = -sunElev * (0.3 + 0.7 * fullMoonFactor);

  // Clamp
  return {
    elevation: Math.max(-90, Math.min(90, elevation)),
    azimuth,
  };
}

/**
 * Compute dayFactor: smooth 0–1 value for lighting interpolation.
 *
 * - Deep night (elev < -12°): 0.0
 * - Civil twilight (-12° to 0°): 0.0 → 0.3
 * - Golden hour (0° to 10°): 0.3 → 0.6
 * - Full day (10° to 60°): 0.6 → 1.0
 * - Above 60°: 1.0
 */
function computeDayFactor(sunElevation: number): number {
  if (sunElevation <= -12) return 0.0;
  if (sunElevation <= 0) {
    // Twilight: -12 → 0 maps to 0.0 → 0.3
    const t = (sunElevation + 12) / 12;
    return smoothstep(t) * 0.3;
  }
  if (sunElevation <= 10) {
    // Golden hour: 0 → 10 maps to 0.3 → 0.6
    const t = sunElevation / 10;
    return 0.3 + smoothstep(t) * 0.3;
  }
  if (sunElevation <= 60) {
    // Day: 10 → 60 maps to 0.6 → 1.0
    const t = (sunElevation - 10) / 50;
    return 0.6 + smoothstep(t) * 0.4;
  }
  return 1.0;
}

/** Hermite smoothstep for natural transitions. */
function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/**
 * Compute the full celestial state for a given location and time.
 */
export function getCelestialState(
  latitude: number,
  longitude: number,
  date: Date = new Date(),
): CelestialState {
  const sun = sunPosition(latitude, longitude, date);
  const phase = moonPhase(date);
  const moon = moonPosition(sun.elevation, sun.azimuth, phase);

  return {
    sunElevation: sun.elevation,
    sunAzimuth: sun.azimuth,
    moonElevation: moon.elevation,
    moonAzimuth: moon.azimuth,
    moonPhase: phase,
    isDaytime: sun.elevation > 0,
    dayFactor: computeDayFactor(sun.elevation),
  };
}
