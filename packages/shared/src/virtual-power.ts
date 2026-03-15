/**
 * Virtual power estimation from wheel speed.
 * Used when no power meter is available.
 *
 * Priority:
 *   1. Real power meter (PWR profile) → use directly
 *   2. No power meter → wheel speed + trainer curve → estimated watts
 */

import { POWER_CURVES, interpolatePower, type PowerCurve } from './power-curves.js';

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
