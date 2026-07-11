/**
 * MockSensorSource — synthetic sensor stream for hardware-free development.
 *
 * Replaces the retired frontend `useMockSensor.ts`. It emits ANT+-shaped
 * frames into the SAME `handleAntData` path real sensors use, so every
 * downstream consumer is exercised identically: the `_snapshot` the game
 * simulation reads, the `WsSensorMessage` broadcast to the HUD, the SQLite
 * sample writes, and the FIT-distance accumulator.
 *
 * Enabled via the server `--mock` flag. Emits a heart-rate strap and a
 * single-sided power meter (the common trainer setup) — power drives the
 * sim, HR drives zones/combo/coins, and virtual speed/cadence are derived
 * server-side exactly as for a real power-only rig.
 */

import type { DetectedSensor } from '@littlecycling/shared';

/** Stable, arbitrary device ids for the two synthetic sensors. */
export const MOCK_HR_DEVICE_ID = 60001;
export const MOCK_PWR_DEVICE_ID = 60002;

/** Sensors the mock advertises during scan (shown in the frontend list). */
export const MOCK_SENSORS: DetectedSensor[] = [
  { profile: 'HR', deviceId: MOCK_HR_DEVICE_ID, source: 'ant', name: 'Mock HR' },
  { profile: 'PWR', deviceId: MOCK_PWR_DEVICE_ID, source: 'ant', name: 'Mock Power' },
];

export interface MockSensorOptions {
  /**
   * Sink for synthetic frames — wire to `LiveSession.handleAntData`. `data`
   * is shaped like a parsed ANT+ frame (ComputedHeartRate, InstantaneousPower…).
   */
  onFrame: (profile: string, deviceId: number, data: Record<string, unknown>) => void;
  /** Frame interval in ms (default 1000, matching the old 1Hz mock). */
  intervalMs?: number;
}

export class MockSensorSource {
  private readonly onFrame: MockSensorOptions['onFrame'];
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  // Random-walk state (seeded to a realistic steady tempo effort).
  private hr = 130;      // bpm
  private power = 160;   // watts
  private cadence = 85;  // rpm

  constructor(opts: MockSensorOptions) {
    this.onFrame = opts.onFrame;
    this.intervalMs = opts.intervalMs ?? 1000;
  }

  start(): void {
    if (this.timer) return;
    this.tick(); // emit immediately so values appear without a 1s delay
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    // Heart rate: gentle random walk, biased slightly upward (0.48) like the
    // old frontend mock, clamped to a plausible training band.
    this.hr += (Math.random() - 0.48) * 4;
    this.hr = clamp(this.hr, 90, 180);

    // Power: oscillate around tempo, clamped to a sane trainer range.
    this.power += (Math.random() - 0.5) * 20;
    this.power = clamp(this.power, 80, 320);

    // Cadence: oscillate around 85 rpm.
    this.cadence += (Math.random() - 0.5) * 5;
    this.cadence = clamp(this.cadence, 60, 110);

    this.onFrame('HR', MOCK_HR_DEVICE_ID, {
      ComputedHeartRate: Math.round(this.hr),
      source: 'ant',
    });
    this.onFrame('PWR', MOCK_PWR_DEVICE_ID, {
      InstantaneousPower: Math.round(this.power),
      Cadence: Math.round(this.cadence),
      source: 'ant',
    });
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
