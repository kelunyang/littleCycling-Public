/**
 * Composable that fetches real-time weather from Open-Meteo (free, no API key)
 * and maps it to our game WeatherType based on cloud cover + precipitation.
 */

import { ref, onUnmounted } from 'vue';
import type { WeatherType } from '@/game/terrain/sky-and-fog';
import { debugLog, isDebugEnabled } from '@/game/debug-logger';

interface OpenMeteoCurrentWeather {
  cloud_cover: number;       // 0-100 %
  precipitation: number;     // mm
  snowfall: number;          // cm
  temperature_2m: number;    // °C
  weather_code: number;
}

interface OpenMeteoResponse {
  current: OpenMeteoCurrentWeather;
}

/** All possible weather types for random fallback. */
const ALL_WEATHER_TYPES: WeatherType[] = ['sunny', 'cloudy', 'rainy', 'snowy'];

/** Refresh interval: 15 minutes. */
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

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
  let intervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * Fetch current weather for given coordinates.
   * On failure, returns a random weather type for gameplay variety.
   */
  async function fetchWeather(lat: number, lon: number): Promise<WeatherType> {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=cloud_cover,precipitation,snowfall,temperature_2m,weather_code`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Weather API ${res.status}`);

      const data: OpenMeteoResponse = await res.json();
      const c = data.current;

      temperature.value = c.temperature_2m;
      cloudCover.value = c.cloud_cover;

      const type = classifyWeather(c);
      weatherType.value = type;
      if (isDebugEnabled()) {
        debugLog('weather', `${lat.toFixed(2)},${lon.toFixed(2)}: ${type}`, {
          cloud: c.cloud_cover, precip: c.precipitation,
          snow: c.snowfall, temp: c.temperature_2m, code: c.weather_code,
        });
      }
      return type;
    } catch (err) {
      // API failure → random weather for gameplay variety
      const type = randomWeather();
      weatherType.value = type;
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
    fetchWeather,
    startPolling,
    stopPolling,
  };
}
