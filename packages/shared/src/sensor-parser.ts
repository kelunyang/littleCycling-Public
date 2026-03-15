/**
 * Sensor data parsers — extract meaningful values from raw ANT+/BLE sensor data.
 * Centralizes sensor data interpretation so both server and web use the same logic.
 */

import type { HrData, ScData, PwrData, SensorSource } from './types.js';

/**
 * Parse heart rate from raw sensor data.
 */
export function parseHrData(raw: Record<string, unknown>): HrData {
  return {
    heartRate: (raw.ComputedHeartRate as number) ?? 0,
    source: (raw.source as SensorSource) ?? 'ant',
  };
}

/**
 * Parse speed/cadence from raw SC sensor data.
 */
export function parseScData(raw: Record<string, unknown>): ScData {
  const speedMs = (raw.CalculatedSpeed as number) ?? 0;
  return {
    speed: speedMs * 3.6, // m/s → km/h
    cadence: (raw.CalculatedCadence as number) ?? 0,
    distance: (raw.CalculatedDistance as number) ?? 0,
    source: (raw.source as SensorSource) ?? 'ant',
  };
}

/**
 * Parse power meter data (single or dual-sided).
 */
export function parsePwrData(raw: Record<string, unknown>): PwrData {
  const result: PwrData = {
    power: (raw.InstantaneousPower as number) ?? (raw.Power as number) ?? 0,
    source: (raw.source as SensorSource) ?? 'ant',
  };

  // Dual-sided power meter fields
  if (raw.LeftPower != null) result.leftPower = raw.LeftPower as number;
  if (raw.RightPower != null) result.rightPower = raw.RightPower as number;
  if (raw.LeftBalance != null) result.balance = raw.LeftBalance as number;
  if (raw.Cadence != null) result.cadence = raw.Cadence as number;

  return result;
}

/**
 * Check if power data has dual-sided (left/right) information.
 */
export function isDualSidedPower(data: PwrData): boolean {
  return data.leftPower != null && data.rightPower != null;
}

/**
 * Calculate steering angle from dual-sided power balance.
 * @returns Angle in degrees: negative = left, positive = right, 0 = straight
 */
export function calcSteeringAngle(data: PwrData, maxAngle: number = 30): number {
  if (!isDualSidedPower(data)) return 0;

  const total = (data.leftPower ?? 0) + (data.rightPower ?? 0);
  if (total === 0) return 0;

  // Balance: 0.5 = even, >0.5 = left dominant, <0.5 = right dominant
  const leftRatio = (data.leftPower ?? 0) / total;
  const deviation = leftRatio - 0.5; // -0.5 to +0.5

  // Map to steering: left power > right → turn left (negative angle)
  return -(deviation * 2) * maxAngle;
}
