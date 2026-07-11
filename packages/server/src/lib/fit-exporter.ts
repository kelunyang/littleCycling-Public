/**
 * FIT file exporter — generates Garmin FIT binary from ride data.
 * Uses @garmin/fitsdk Encoder for protocol-correct output.
 *
 * Output: Indoor Cycling activity (no GPS) compatible with
 * Strava, Garmin Connect, TrainingPeaks, intervals.icu.
 */

import { Encoder, Profile } from '@garmin/fitsdk';
import type { Ride, RideSample, DetectedSensor } from '@littlecycling/shared';

const { MesgNum } = Profile;

// FIT epoch: 1989-12-31 00:00:00 UTC (631065600000 ms since Unix epoch)
const FIT_EPOCH_MS = 631065600000;

/** Convert Unix epoch ms to FIT timestamp (seconds since FIT epoch). */
function toFitTimestamp(unixMs: number): number {
  return Math.floor((unixMs - FIT_EPOCH_MS) / 1000);
}

/** ANT+ device-type codes (matches FIT SDK `antplusDeviceType` enum). */
const ANTPLUS_DEVICE_TYPE: Record<string, number> = {
  HR: 120,   // heartRate
  PWR: 11,   // bikePower
  SC: 121,   // bikeSpeedCadence
  CAD: 122,  // bikeCadence
  SPD: 123,  // bikeSpeed
};

const SENSOR_LABELS: Record<string, string> = {
  HR: 'Heart Rate',
  PWR: 'Power Meter',
  SC: 'Speed/Cadence',
  CAD: 'Cadence',
  SPD: 'Speed',
};

/**
 * Build DEVICE_INFO messages — one per sensor — so Strava/Garmin Connect
 * surface the hardware list under the activity. Generic manufacturer
 * (255 = development) is used because we don't probe the actual brand
 * during ANT+ scan; the human-readable `productName` carries the label.
 */
function buildDeviceInfoMesgs(
  sensors: DetectedSensor[] | undefined,
  startTimestamp: number,
): Record<string, unknown>[] {
  if (!sensors || sensors.length === 0) return [];
  return sensors.map((s, i) => {
    const isAntplus = (s.source ?? 'ant') === 'ant';
    const antType = ANTPLUS_DEVICE_TYPE[s.profile];
    const label = s.name?.trim()
      || `${SENSOR_LABELS[s.profile] ?? s.profile} (${(s.source ?? 'ant').toUpperCase()})`;
    const mesg: Record<string, unknown> = {
      mesgNum: MesgNum.DEVICE_INFO,
      timestamp: startTimestamp,
      // deviceIndex 0 is reserved for the activity's creator; sensors
      // start at 1.
      deviceIndex: i + 1,
      manufacturer: 255, // development — actual brand isn't auto-detected
      productName: label,
      // sourceType: 1 = antplus, 3 = ble
      sourceType: isAntplus ? 1 : 3,
    };
    if (isAntplus) {
      mesg.antNetwork = 1; // antplus
      if (antType != null) mesg.antplusDeviceType = antType;
      if (s.deviceId > 0) {
        mesg.antDeviceNumber = s.deviceId;
        mesg.serialNumber = s.deviceId;
      }
    }
    return mesg;
  });
}

/**
 * Downsample raw samples (typically 4 Hz from a power meter) to a clean
 * 1 Hz stream.
 *
 * FIT timestamps are stored at 1 s resolution, so multiple sub-second
 * samples collapse onto the same record timestamp; some consumers
 * (notably Strava) then dedupe and report "too few data points". We
 * pre-bucket here to make the record stream unambiguous.
 *
 * For each whole-second bucket we keep the latest sample's values and
 * carry forward any field that is missing in that bucket (so a power
 * sample at 0.8 s still inherits HR from a 0.2 s heart-rate sample).
 */
function downsampleToOneHz(samples: RideSample[]): RideSample[] {
  if (samples.length === 0) return [];
  const buckets = new Map<number, RideSample>();
  // Carry-forward state keeps fields populated through quieter seconds.
  let lastHr: number | undefined;
  let lastPower: number | undefined;
  let lastCadence: number | undefined;
  let lastSpeed: number | undefined;
  for (const s of samples) {
    if (s.hr != null) lastHr = s.hr;
    if (s.powerW != null) lastPower = s.powerW;
    if (s.cadence != null) lastCadence = s.cadence;
    if (s.speedKmh != null) lastSpeed = s.speedKmh;
    const sec = Math.floor(s.elapsedMs / 1000);
    buckets.set(sec, {
      elapsedMs: sec * 1000,
      hr: lastHr,
      powerW: lastPower,
      cadence: lastCadence,
      speedKmh: lastSpeed,
    });
  }
  return Array.from(buckets.values()).sort((a, b) => a.elapsedMs - b.elapsedMs);
}

/**
 * Export a ride and its samples to a FIT binary buffer.
 * @returns Uint8Array containing the FIT file data.
 */
export function exportRideToFit(ride: Ride, rawSamples: RideSample[]): Uint8Array {
  const encoder = new Encoder();
  const samples = downsampleToOneHz(rawSamples);

  const startTimestamp = toFitTimestamp(ride.startedAt);
  // If the ride was never properly closed (server crash, force-quit), the
  // stored durationMs is null/0. Falling back to 0 here would emit a SESSION
  // / LAP with totalElapsedTime=0 — Strava reads that metadata and rejects
  // the upload as "too few data points" even when the record stream spans
  // minutes. Derive duration from the sample span so the file matches its
  // own records.
  const lastSampleMs = samples.length > 0 ? samples[samples.length - 1].elapsedMs : 0;
  const declaredDurationMs = ride.durationMs ?? 0;
  const durationSec = Math.max(declaredDurationMs, lastSampleMs) / 1000;

  // ── file_id ──
  encoder.onMesg(MesgNum.FILE_ID, {
    mesgNum: MesgNum.FILE_ID,
    type: 4, // activity
    manufacturer: 255, // development
    product: 0,
    serialNumber: 12345,
    timeCreated: startTimestamp,
  });

  // ── device_info (one per sensor) ──
  for (const dev of buildDeviceInfoMesgs(ride.sensors, startTimestamp)) {
    encoder.onMesg(MesgNum.DEVICE_INFO, dev);
  }

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
