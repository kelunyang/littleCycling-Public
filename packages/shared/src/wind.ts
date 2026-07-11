/**
 * Wind state shared between weather API, simulator, renderers, and audio.
 *
 * Direction follows meteorological convention: 0° = wind from north,
 * 90° = wind from east, etc. Renderers convert to "particle flow direction"
 * by adding 180°.
 */

export interface WindSample {
  /** Smoothed instantaneous wind speed including client-side fluctuation. */
  speedKmh: number;
  /** Raw API value (no fluctuation), used for gating threshold checks. */
  baseSpeedKmh: number;
  /** Wind direction (degrees, meteorological: 0=N, 90=E). 0..360 */
  directionDeg: number;
  /** speedKmh / baseSpeedKmh — feeds visual gust amplitude. */
  gustFactor: number;
}

/** Minimum baseSpeedKmh required to make wind-coin-storm event eligible. */
export const WIND_STORM_THRESHOLD_KMH = 25;

/** wind-coin-storm event duration. */
export const WIND_STORM_DURATION_MS = 25_000;

/** Number of bonus coins spawned at the start of a wind-coin-storm event. */
export const WIND_STORM_COIN_COUNT = 14;

/** Bonus coin reward when the wind-coin-storm event succeeds. */
export const WIND_STORM_COIN_REWARD = 40;

/** Combo multiplier applied to coin pickups during the tailwind event. */
export const TAILWIND_COMBO_MULTIPLIER = 2;
