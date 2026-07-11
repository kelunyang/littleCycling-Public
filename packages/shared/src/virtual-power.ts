/**
 * Virtual power estimation from wheel speed.
 * Used when no power meter is available.
 *
 * Priority:
 *   1. Real power meter (PWR profile) → use directly
 *   2. No power meter → wheel speed + trainer curve → estimated watts
 *
 * Inverse helpers (power → speed/cadence) are also exported for the
 * power-only case where no speed or cadence sensor is connected.
 */

import { POWER_CURVES, interpolatePower, type PowerCurve } from './power-curves.js';

/**
 * Tuning factor used to convert watts to a virtual wheel speed.
 * `speedKmh = sqrt(watts) * SPEED_FROM_POWER_FACTOR`.
 * Kept in sync with the in-game ball-engine factor so the recorded
 * FIT speed matches what the rider sees in the HUD.
 */
export const SPEED_FROM_POWER_FACTOR = 1.5;

/**
 * Estimate virtual wheel speed (km/h) from instantaneous power.
 * Returns 0 when not pedalling.
 */
export function estimateVirtualSpeedFromPower(powerW: number): number {
  if (!Number.isFinite(powerW) || powerW <= 0) return 0;
  return Math.sqrt(powerW) * SPEED_FROM_POWER_FACTOR;
}

/**
 * Estimate a plausible cadence (RPM) from instantaneous power.
 * Smooth curve through a realistic 60–100 RPM range; returns 0 when
 * power is zero so the rider is not shown as "spinning while coasting".
 */
export function estimateVirtualCadenceFromPower(powerW: number): number {
  if (!Number.isFinite(powerW) || powerW <= 0) return 0;
  return Math.min(100, 60 + Math.sqrt(powerW) * 2.2);
}

export interface VirtualPowerOptions {
  /** Trainer model ID (key in POWER_CURVES). Default: 'generic-fluid' */
  trainerModel?: string;
  /** Custom power curve (overrides trainerModel) */
  customCurve?: PowerCurve;
}

export class VirtualPowerEstimator {
  private curve: PowerCurve;

  constructor(options: VirtualPowerOptions = {}) {
    if (options.customCurve) {
      this.curve = options.customCurve;
    } else {
      const model = options.trainerModel ?? 'generic-fluid';
      this.curve = POWER_CURVES[model] ?? POWER_CURVES['generic-fluid'];
    }
  }

  /**
   * Estimate power from wheel speed.
   * @param speedKmh - Wheel speed in km/h
   * @returns Estimated power in watts
   */
  estimate(speedKmh: number): number {
    return interpolatePower(this.curve, speedKmh);
  }

  getCurveName(): string {
    return this.curve.name;
  }
}
