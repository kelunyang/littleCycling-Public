/**
 * Composable that fetches real-time weather from Open-Meteo (free, no API key)
 * and maps it to our game WeatherType based on cloud cover + precipitation.
 */

import { ref, onUnmounted } from 'vue';
import type { WeatherType } from '@/game/terrain/sky-and-fog';
import { debugLog, isDebugEnabled } from '@/game/debug-logger';

interface OpenMeteoCurrentWeather {
  cloud_cover: number;       // 0-100 %
  cloud_cover_low?: number;  // 0-100 %, the deck a rider can actually ride into
  precipitation: number;     // mm
  snowfall: number;          // cm
  temperature_2m: number;    // °C
  dew_point_2m?: number;     // °C
  relative_humidity_2m?: number; // 0-100 %
  weather_code: number;
  wind_speed_10m: number;    // km/h (Open-Meteo default unit)
  wind_direction_10m: number; // degrees, meteorological
}

interface OpenMeteoResponse {
  current: OpenMeteoCurrentWeather;
  /** Elevation (m MSL) of the model grid cell the values above describe.
   *  Always present in the Open-Meteo forecast response; it is the datum the
   *  temperature/dew point were reduced to, so it is the ground the lifted
   *  condensation level is measured above. */
  elevation?: number;
}

/** All possible weather types for random fallback. */
const ALL_WEATHER_TYPES: WeatherType[] = ['sunny', 'cloudy', 'rainy', 'snowy'];

/** Refresh interval: 15 minutes. */
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

// ── Cloud base (lifted condensation level) ──

/**
 * Espy's approximation: the cloud base sits roughly 125 m above the surface for
 * every 1 °C of temperature/dew-point spread. It is the rule of thumb aviation
 * has used for a century, NOT a model — it assumes a well-mixed convective
 * boundary layer with a dry lapse rate of ~9.8 °C/km against a dew-point lapse
 * of ~1.8 °C/km. Where that assumption fails it fails badly:
 *
 *  - fog / saturated air (spread → 0) puts the base ON the ground, which would
 *    park the deck inside the terrain;
 *  - a very dry desert-style spread runs the base off into the stratosphere;
 *  - it says nothing about layers ABOVE the convective one (cirrus, fronts).
 *
 * So the result is clamped to a band that is both physically plausible and
 * rideable, and the caller must treat it as scenery, not as a forecast.
 */
const ESPY_M_PER_DEG_C = 125;

/** Clamp band for the cloud base above ground (m). */
const CLOUD_BASE_MIN_AGL_M = 150;
const CLOUD_BASE_MAX_AGL_M = 4000;

/** Sanity band for the grid-cell elevation Open-Meteo reports (m MSL). */
const MIN_GROUND_ELEVATION_M = -500;
const MAX_GROUND_ELEVATION_M = 9000;

/**
 * Cloud base height above ground, from the temperature/dew-point spread.
 * Returns null when either input is missing so callers can fall back rather
 * than render a deck at a made-up height.
 */
export function cloudBaseAglFromSpread(tempC: number, dewPointC: number): number | null {
  if (!Number.isFinite(tempC) || !Number.isFinite(dewPointC)) return null;
  // Negative spread happens from rounding when the air is saturated; treat it
  // as zero rather than letting the base go below ground.
  const spread = Math.max(0, tempC - dewPointC);
  const agl = spread * ESPY_M_PER_DEG_C;
  return Math.min(CLOUD_BASE_MAX_AGL_M, Math.max(CLOUD_BASE_MIN_AGL_M, agl));
}

/**
 * Cloud base as an ABSOLUTE altitude (m MSL) = the weather grid cell's ground
 * elevation + the Espy height above it. Absolute is what the renderer needs:
 * the 3D scene is a floating-origin world, so anything expressed "above the
 * terrain" silently means "above wherever this particular ride started".
 *
 * Returns null if either the spread or the ground elevation is unusable.
 */
export function cloudBaseAltitudeMsl(
  tempC: number,
  dewPointC: number,
  groundElevationM: number,
): number | null {
  const agl = cloudBaseAglFromSpread(tempC, dewPointC);
  if (agl === null) return null;
  if (!Number.isFinite(groundElevationM)) return null;
  if (groundElevationM < MIN_GROUND_ELEVATION_M || groundElevationM > MAX_GROUND_ELEVATION_M) {
    return null;
  }
  return groundElevationM + agl;
}

/**
 * Classify Open-Meteo current weather into our game WeatherType.
 *
 * Priority: snow > rain > cloud cover threshold.
 */
function classifyWeather(current: OpenMeteoCurrentWeather): WeatherType {
  // Snow: explicit snowfall or cold precipitation
  if (current.snowfall > 0 || (current.precipitation > 0 && current.temperature_2m <= 0)) {
    return 'snowy';
  }
  // Rain: warm precipitation
  if (current.precipitation > 0 && current.temperature_2m > 0) {
    return 'rainy';
  }
  // Cloud cover threshold
  if (current.cloud_cover >= 50) {
    return 'cloudy';
  }
  return 'sunny';
}

/** Pick a random weather type (used when API fails). */
function randomWeather(): WeatherType {
  return ALL_WEATHER_TYPES[Math.floor(Math.random() * ALL_WEATHER_TYPES.length)];
}

export function useWeatherApi() {
  const weatherType = ref<WeatherType>('sunny');
  const temperature = ref<number>(20);
  const cloudCover = ref<number>(0);
  const windSpeedKmh = ref<number>(0);
  const windDirectionDeg = ref<number>(0);
  const weatherCode = ref<number>(0);
  const dewPoint = ref<number | null>(null);
  const relativeHumidity = ref<number | null>(null);
  const cloudCoverLow = ref<number | null>(null);
  /** Cloud deck base, absolute altitude in m MSL. null = unknown (fall back). */
  const cloudBaseAltitudeM = ref<number | null>(null);
  let intervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * Fetch current weather for given coordinates.
   * On failure, returns a random weather type for gameplay variety.
   */
  async function fetchWeather(lat: number, lon: number): Promise<WeatherType> {
    try {
      // dew_point_2m / relative_humidity_2m / cloud_cover_low are extra fields on
      // the SAME Open-Meteo endpoint we already call — no new data source, no new
      // licence. dew_point_2m is what drives the cloud base (see Espy above).
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=cloud_cover,cloud_cover_low,precipitation,snowfall,temperature_2m,dew_point_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Weather API ${res.status}`);

      const data: OpenMeteoResponse = await res.json();
      const c = data.current;

      temperature.value = c.temperature_2m;
      cloudCover.value = c.cloud_cover;
      windSpeedKmh.value = c.wind_speed_10m ?? 0;
      windDirectionDeg.value = c.wind_direction_10m ?? 0;
      weatherCode.value = c.weather_code ?? 0;
      dewPoint.value = Number.isFinite(c.dew_point_2m as number) ? c.dew_point_2m! : null;
      relativeHumidity.value =
        Number.isFinite(c.relative_humidity_2m as number) ? c.relative_humidity_2m! : null;
      cloudCoverLow.value =
        Number.isFinite(c.cloud_cover_low as number) ? c.cloud_cover_low! : null;
      cloudBaseAltitudeM.value = dewPoint.value === null
        ? null
        : cloudBaseAltitudeMsl(c.temperature_2m, dewPoint.value, data.elevation as number);

      const type = classifyWeather(c);
      weatherType.value = type;
      if (isDebugEnabled()) {
        debugLog('weather', `${lat.toFixed(2)},${lon.toFixed(2)}: ${type}`, {
          cloud: c.cloud_cover, cloudLow: c.cloud_cover_low, precip: c.precipitation,
          snow: c.snowfall, temp: c.temperature_2m, dewPoint: c.dew_point_2m,
          rh: c.relative_humidity_2m, code: c.weather_code,
          wind: c.wind_speed_10m, windDir: c.wind_direction_10m,
          groundEle: data.elevation, cloudBaseMsl: cloudBaseAltitudeM.value,
        });
      }
      return type;
    } catch (err) {
      // API failure → random weather for gameplay variety
      const type = randomWeather();
      weatherType.value = type;
      // No dew point → no cloud base. Null, not a guess: the renderer's fallback
      // (a fixed height above the scene origin) is the honest degradation.
      dewPoint.value = null;
      cloudBaseAltitudeM.value = null;
      if (isDebugEnabled()) {
        debugLog('weather', `API failed, using random: ${type}`, {
          error: String(err),
        });
      }
      return type;
    }
  }

  /** Start polling weather every 15 minutes. Fetches immediately on first call. */
  function startPolling(lat: number, lon: number): void {
    // Fetch immediately
    fetchWeather(lat, lon);

    // Then every 15 minutes
    intervalId = setInterval(() => {
      fetchWeather(lat, lon);
    }, REFRESH_INTERVAL_MS);
  }

  /** Stop polling. */
  function stopPolling(): void {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  onUnmounted(stopPolling);

  return {
    weatherType,
    temperature,
    cloudCover,
    windSpeedKmh,
    windDirectionDeg,
    weatherCode,
    dewPoint,
    relativeHumidity,
    cloudCoverLow,
    cloudBaseAltitudeM,
    fetchWeather,
    startPolling,
    stopPolling,
  };
}
