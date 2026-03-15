/**
 * FIT file exporter — generates Garmin FIT binary from ride data.
 * Uses @garmin/fitsdk Encoder for protocol-correct output.
 *
 * Output: Indoor Cycling activity (no GPS) compatible with
 * Strava, Garmin Connect, TrainingPeaks, intervals.icu.
 */

import { Encoder, Profile } from '@garmin/fitsdk';
import type { Ride, RideSample } from '@littlecycling/shared';

const { MesgNum } = Profile;

// FIT epoch: 1989-12-31 00:00:00 UTC (631065600000 ms since Unix epoch)
const FIT_EPOCH_MS = 631065600000;

/** Convert Unix epoch ms to FIT timestamp (seconds since FIT epoch). */
function toFitTimestamp(unixMs: number): number {
  return Math.floor((unixMs - FIT_EPOCH_MS) / 1000);
}

/**
 * Export a ride and its samples to a FIT binary buffer.
 * @returns Uint8Array containing the FIT file data.
 */
export function exportRideToFit(ride: Ride, samples: RideSample[]): Uint8Array {
  const encoder = new Encoder();

  const startTimestamp = toFitTimestamp(ride.startedAt);
  const durationSec = ride.durationMs ? ride.durationMs / 1000 : 0;

  // ── file_id ──
  encoder.onMesg(MesgNum.FILE_ID, {
    mesgNum: MesgNum.FILE_ID,
    type: 4, // activity
    manufacturer: 255, // development
    product: 0,
    serialNumber: 12345,
    timeCreated: startTimestamp,
  });

  // ── event (timer start) ──
  encoder.onMesg(MesgNum.EVENT, {
    mesgNum: MesgNum.EVENT,
    timestamp: startTimestamp,
    event: 0, // timer
    eventType: 0, // start
  });

  // ── record messages (one per sample) ──
  let totalDistance = 0; // meters
  let lastSpeedMps = 0;
  let lastElapsedMs = 0;

  for (const sample of samples) {
    const recordTimestamp = startTimestamp + Math.floor(sample.elapsedMs / 1000);

    // Accumulate distance from speed
    if (sample.speedKmh != null) {
      lastSpeedMps = sample.speedKmh / 3.6;
    }
    const dtSec = (sample.elapsedMs - lastElapsedMs) / 1000;
    if (dtSec > 0) {
      totalDistance += lastSpeedMps * dtSec;
    }
    lastElapsedMs = sample.elapsedMs;

    const record: Record<string, unknown> = {
      mesgNum: MesgNum.RECORD,
      timestamp: recordTimestamp,
    };

    if (sample.hr != null) {
      record.heartRate = sample.hr;
    }
    if (sample.powerW != null) {
      record.power = Math.round(sample.powerW);
    }
    if (sample.cadence != null) {
      record.cadence = Math.round(sample.cadence);
    }
    if (sample.speedKmh != null) {
      // FIT speed is in m/s * 1000 (mm/s), stored as uint16
      record.speed = sample.speedKmh / 3.6;
    }
    record.distance = totalDistance;

    encoder.onMesg(MesgNum.RECORD, record);
  }

  // ── event (timer stop) ──
  const endTimestamp = startTimestamp + Math.floor(durationSec);
  encoder.onMesg(MesgNum.EVENT, {
    mesgNum: MesgNum.EVENT,
    timestamp: endTimestamp,
    event: 0, // timer
    eventType: 4, // stop_all
  });

  // ── lap ──
  encoder.onMesg(MesgNum.LAP, {
    mesgNum: MesgNum.LAP,
    timestamp: endTimestamp,
    startTime: startTimestamp,
    totalElapsedTime: durationSec,
    totalTimerTime: durationSec,
    totalDistance: totalDistance,
    ...(ride.avgHr != null && { avgHeartRate: Math.round(ride.avgHr) }),
    ...(ride.maxHr != null && { maxHeartRate: ride.maxHr }),
    ...(ride.avgPowerW != null && { avgPower: Math.round(ride.avgPowerW) }),
    ...(ride.maxPowerW != null && { maxPower: Math.round(ride.maxPowerW) }),
    ...(ride.avgCadence != null && { avgCadence: Math.round(ride.avgCadence) }),
    ...(ride.avgSpeed != null && { avgSpeed: ride.avgSpeed / 3.6 }),
    ...(ride.maxSpeed != null && { maxSpeed: ride.maxSpeed / 3.6 }),
  });

  // ── session ──
  encoder.onMesg(MesgNum.SESSION, {
    mesgNum: MesgNum.SESSION,
    timestamp: endTimestamp,
    startTime: startTimestamp,
    totalElapsedTime: durationSec,
    totalTimerTime: durationSec,
    totalDistance: totalDistance,
    sport: 2, // cycling
    subSport: 6, // indoor_cycling
    firstLapIndex: 0,
    numLaps: 1,
    ...(ride.avgHr != null && { avgHeartRate: Math.round(ride.avgHr) }),
    ...(ride.maxHr != null && { maxHeartRate: ride.maxHr }),
    ...(ride.avgPowerW != null && { avgPower: Math.round(ride.avgPowerW) }),
    ...(ride.maxPowerW != null && { maxPower: Math.round(ride.maxPowerW) }),
    ...(ride.avgCadence != null && { avgCadence: Math.round(ride.avgCadence) }),
    ...(ride.avgSpeed != null && { avgSpeed: ride.avgSpeed / 3.6 }),
    ...(ride.maxSpeed != null && { maxSpeed: ride.maxSpeed / 3.6 }),
  });

  // ── activity ──
  encoder.onMesg(MesgNum.ACTIVITY, {
    mesgNum: MesgNum.ACTIVITY,
    timestamp: endTimestamp,
    totalTimerTime: durationSec,
    numSessions: 1,
    type: 0, // manual
    event: 26, // activity
    eventType: 1, // stop
  });

  return encoder.close();
}
