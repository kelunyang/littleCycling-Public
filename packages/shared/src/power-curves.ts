/**
 * Trainer power curves: wheel speed (km/h) → power (watts).
 * Uses linear interpolation between table points.
 */

export interface PowerCurve {
  name: string;
  speeds: number[];  // km/h
  powers: number[];  // watts
}

/** Generic fluid trainer — community-verified default */
export const GENERIC_FLUID: PowerCurve = {
  name: 'Generic Fluid Trainer',
  speeds: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60],
  powers: [0, 25, 50, 85, 110, 160, 220, 300, 410, 550, 700, 890, 1100],
};

/** Generic magnetic trainer (medium resistance) */
export const GENERIC_MAGNETIC: PowerCurve = {
  name: 'Generic Magnetic Trainer',
  speeds: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60],
  powers: [0, 30, 60, 90, 125, 160, 200, 230, 280, 325, 375, 430, 490],
};

/** All available trainer power curves, keyed by model ID */
export const POWER_CURVES: Record<string, PowerCurve> = {
  'generic-fluid': GENERIC_FLUID,
  'generic-magnetic': GENERIC_MAGNETIC,
};

/**
 * Linear interpolation on a power curve.
 * @param curve - The trainer power curve
 * @param speedKmh - Wheel speed in km/h
 * @returns Estimated power in watts
 */
export function interpolatePower(curve: PowerCurve, speedKmh: number): number {
  if (speedKmh <= 0) return 0;

  const { speeds, powers } = curve;
  const maxIdx = speeds.length - 1;

  if (speedKmh >= speeds[maxIdx]) return powers[maxIdx];

  for (let i = 1; i <= maxIdx; i++) {
    if (speedKmh <= speeds[i]) {
      const ratio = (speedKmh - speeds[i - 1]) / (speeds[i] - speeds[i - 1]);
      return powers[i - 1] + ratio * (powers[i] - powers[i - 1]);
    }
  }

  return 0;
}
