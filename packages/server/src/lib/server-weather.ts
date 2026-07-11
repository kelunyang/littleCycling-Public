/**
 * ServerWeatherSource — server-side Open-Meteo wind fetch.
 *
 * The random-event picker's wind gate (wind-coin-storm needs a live wind
 * speed ≥ threshold) must run inside the server simulation, so the base wind
 * value has to exist server-side. This fetches it for the route's
 * representative coordinate at start and refreshes every 15 min, mirroring
 * the client's useWeatherApi cadence.
 *
 * Only the wind BASE (speed + direction) lives here — it's a gameplay gate.
 * The client keeps its own useWeatherApi + useWindSimulator for renderer /
 * audio presentation (fluctuation, gusts); those are cosmetic and stay on
 * the client. A small divergence between the two is harmless for a gate.
 *
 * Failures are non-fatal: wind stays 0, so wind-coin-storm simply never
 * becomes eligible (graceful degradation).
 */

export interface ServerWind {
  /** Raw API wind speed (km/h) — feeds pickRandomEvent's wind gate. */
  baseSpeedKmh: number;
  /** Meteorological wind direction (deg, 0=N). Currently informational. */
  directionDeg: number;
}

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export class ServerWeatherSource {
  private wind: ServerWind = { baseSpeedKmh: 0, directionDeg: 0 };
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly lat: number,
    private readonly lon: number,
    private readonly debug = false,
  ) {}

  /** Current wind (safe default until the first fetch resolves). */
  get(): ServerWind {
    return { ...this.wind };
  }

  start(): void {
    if (this.timer) return;
    void this.fetchOnce();
    this.timer = setInterval(() => void this.fetchOnce(), REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async fetchOnce(): Promise<void> {
    try {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${this.lat}&longitude=${this.lon}` +
        `&current=wind_speed_10m,wind_direction_10m`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`weather API ${res.status}`);
      const data = (await res.json()) as {
        current?: { wind_speed_10m?: number; wind_direction_10m?: number };
      };
      const c = data.current ?? {};
      this.wind = {
        baseSpeedKmh: typeof c.wind_speed_10m === 'number' ? c.wind_speed_10m : 0,
        directionDeg: typeof c.wind_direction_10m === 'number' ? c.wind_direction_10m : 0,
      };
      if (this.debug) {
        console.log(`[weather] wind ${this.wind.baseSpeedKmh.toFixed(1)} km/h @ ${this.wind.directionDeg.toFixed(0)}°`);
      }
    } catch (err: any) {
      // Keep the last-known (or zero) value; wind-coin-storm just won't fire.
      if (this.debug) console.warn(`[weather] fetch failed: ${err?.message ?? err}`);
    }
  }
}
