/**
 * Heart rate zone calculation and coin reward rules.
 * "Heart rate speed trap" — rewards maintaining target zone, not max effort.
 */

import type { HrZone } from './types.js';

/** Standard 5-zone heart rate model */
export const HR_ZONES: HrZone[] = [
  { zone: 1, name: 'Recovery',   minPct: 50, maxPct: 60, coinsPerTick: 0 },
  { zone: 2, name: 'Fat Burn',   minPct: 60, maxPct: 70, coinsPerTick: 1 },
  { zone: 3, name: 'Aerobic',    minPct: 70, maxPct: 80, coinsPerTick: 2 },
  { zone: 4, name: 'Threshold',  minPct: 80, maxPct: 90, coinsPerTick: 3 },
  { zone: 5, name: 'Red Line',   minPct: 90, maxPct: 100, coinsPerTick: 0 },
];

/**
 * Determine which HR zone a given heart rate falls into.
 * @param heartRate - Current heart rate (bpm)
 * @param hrMax - Maximum heart rate (bpm)
 * @returns The matching HrZone, or null if below zone 1
 */
export function getHrZone(heartRate: number, hrMax: number): HrZone | null {
  if (hrMax <= 0 || heartRate <= 0) return null;

  const pct = (heartRate / hrMax) * 100;

  for (const zone of HR_ZONES) {
    if (pct >= zone.minPct && pct < zone.maxPct) {
      return zone;
    }
  }

  // At or above 100% HRmax — still zone 5
  if (pct >= 100) return HR_ZONES[4];

  return null;
}

/**
 * Get coins awarded for current heart rate.
 * Zone 5 (red line) awards 0 coins as a safety mechanism.
 */
export function getCoinsForHr(heartRate: number, hrMax: number): number {
  const zone = getHrZone(heartRate, hrMax);
  return zone?.coinsPerTick ?? 0;
}

/**
 * Check if heart rate is in the danger zone (zone 5).
 */
export function isRedLine(heartRate: number, hrMax: number): boolean {
  const zone = getHrZone(heartRate, hrMax);
  return zone?.zone === 5;
}
