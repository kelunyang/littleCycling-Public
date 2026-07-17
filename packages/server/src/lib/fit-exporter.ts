/**
 * FIT file exporter — generates Garmin FIT binary from ride data.
 * Uses @markw65/fit-file-writer (MIT) for protocol-correct output; it keeps
 * the dependency tree fully open-source and free of Garmin's proprietary
 * SDK terms.
 *
 * Output: Indoor Cycling activity (no GPS) compatible with
 * Strava, Garmin Connect, TrainingPeaks, intervals.icu.
 */

import { FitWriter } from '@markw65/fit-file-writer';
import type { Ride, RideSample, DetectedSensor } from '@littlecycling/shared';

// FIT epoch: 1989-12-31 00:00:00 UTC (631065600000 ms since Unix epoch)
const FIT_EPOCH_MS = 631065600000;

/**
 * Pre-quantise a scaled float so the writer's truncation behaves like rounding.
 *
 * FitWriter#writeFieldValue computes `(v + offset) * scale` and emits it via
 * `this.long(x & 0xFFFFFFFF)` / `this.word(x & 0xFFFF)`. The bitwise AND
 * coerces through ToInt32, i.e. it TRUNCATES, whereas @garmin/fitsdk (the
 * previous encoder) rounded. Left alone, every scaled float field would land
 * up to 1 LSB low — speed 0.001 m/s, distance 0.01 m — against the old
 * exporter's output. FitWriter exposes no rounding option, so we compensate
 * on the caller's side: pick the value whose scaled form sits at
 * `target + 0.5`, making the writer's truncation yield exactly
 * `Math.round(v * scale)`.
 *
 * If markw65 ever switches to rounding, this becomes a +0.5 LSB round-up, i.e.
 * every scaled field reads 1 LSB HIGH instead of matching. Harmless at these
 * scales (1 mm/s, 1 cm) but the workaround should then be deleted, not kept.
 */
const q = (v: number, scale: number): number => (Math.round(v * scale) + 0.5) / scale;

/**
 * Convert Unix epoch ms to FIT timestamp (seconds since FIT epoch).
 *
 * Deliberately not FitWriter#time(): that rounds (`Math.round(+t/1000 - …)`)
 * while this exporter has always floored. We compute FIT seconds here and hand
 * writeMessage the raw number so timestamps stay bit-identical to prior files.
 */
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
 * Shape of the DEVICE_INFO messages we emit. Spelled out locally because the
 * writer's `FitMessageInputs` map isn't re-exported from the package entry;
 * every member here is checked against it at the writeMessage() call anyway
 * (its `Exact<>` constraint rejects unknown or mistyped fields).
 */
type DeviceInfoMesg = {
  timestamp: number;
  device_index: number;
  manufacturer: 'development';
  product_name: string;
  source_type: 'antplus' | 'bluetooth_low_energy';
  ant_network?: 'antplus';
  device_type?: number;
  ant_device_number?: number;
  serial_number?: number;
};

/**
 * Build DEVICE_INFO messages — one per sensor — so Strava/Garmin Connect
 * surface the hardware list under the activity. Generic manufacturer
 * (development) is used because we don't probe the actual brand
 * during ANT+ scan; the human-readable `product_name` carries the label.
 */
function buildDeviceInfoMesgs(
  sensors: DetectedSensor[] | undefined,
  startTimestamp: number,
): DeviceInfoMesg[] {
  if (!sensors || sensors.length === 0) return [];
  return sensors.map((s, i) => {
    const isAntplus = (s.source ?? 'ant') === 'ant';
    const antType = ANTPLUS_DEVICE_TYPE[s.profile];
    const label = s.name?.trim()
      || `${SENSOR_LABELS[s.profile] ?? s.profile} (${(s.source ?? 'ant').toUpperCase()})`;
    const mesg: DeviceInfoMesg = {
      timestamp: startTimestamp,
      // device_index 0 is reserved for the activity's creator; sensors
      // start at 1.
      device_index: i + 1,
      manufacturer: 'development', // actual brand isn't auto-detected
      product_name: label,
      source_type: isAntplus ? 'antplus' : 'bluetooth_low_energy',
    };
    if (isAntplus) {
      mesg.ant_network = 'antplus';
      // `antplus_device_type` doesn't exist as a writable field name here: in
      // the FIT profile it is a *subfield* of device_type (num 1), selected by
      // source_type=antplus, and writeMessage() resolves names against the base
      // field map only (unknown names throw "Invalid field"). We write the base
      // field `device_type` with the same numeric code — decoders read it back
      // with the intended meaning (bike_power / heart_rate / …).
      //
      // Note this is a fix, not a regression: the old @garmin/fitsdk encoder
      // silently DROPPED `antplusDeviceType`, so files it produced carried no
      // device_type at all.
      if (antType != null) mesg.device_type = antType;
      if (s.deviceId > 0) {
        mesg.ant_device_number = s.deviceId;
        mesg.serial_number = s.deviceId;
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
  const fw = new FitWriter();
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

  // Enum fields take their profile names rather than raw codes — the writer's
  // types demand names, and both encode to the same byte.
  //
  // `lastUse` (4th arg) lets the writer retire a local message definition slot
  // once we're done with that message type.

  // ── file_id ──
  fw.writeMessage(
    'file_id',
    {
      type: 'activity',
      manufacturer: 'development',
      product: 0,
      serial_number: 12345,
      time_created: startTimestamp,
    },
    null,
    true,
  );

  // ── device_info (one per sensor) ──
  const devMesgs = buildDeviceInfoMesgs(ride.sensors, startTimestamp);
  devMesgs.forEach((dev, i) => {
    fw.writeMessage('device_info', dev, null, i === devMesgs.length - 1);
  });

  // ── event (timer start) ──
  fw.writeMessage(
    'event',
    { timestamp: startTimestamp, event: 'timer', event_type: 'start' },
    null,
    false,
  );

  // ── record messages (one per sample) ──
  let totalDistance = 0; // meters
  let lastSpeedMps = 0;
  let lastElapsedMs = 0;

  samples.forEach((sample, i) => {
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

    const record: {
      timestamp: number;
      heart_rate?: number;
      power?: number;
      cadence?: number;
      speed?: number;
      distance?: number;
    } = { timestamp: recordTimestamp };

    if (sample.hr != null) {
      record.heart_rate = sample.hr;
    }
    if (sample.powerW != null) {
      record.power = Math.round(sample.powerW);
    }
    if (sample.cadence != null) {
      record.cadence = Math.round(sample.cadence);
    }
    if (sample.speedKmh != null) {
      // FIT speed is in m/s * 1000 (mm/s), stored as uint16
      record.speed = q(sample.speedKmh / 3.6, 1000);
    }
    record.distance = q(totalDistance, 100);

    fw.writeMessage('record', record, null, i === samples.length - 1);
  });

  // ── event (timer stop) ──
  const endTimestamp = startTimestamp + Math.floor(durationSec);
  fw.writeMessage(
    'event',
    { timestamp: endTimestamp, event: 'timer', event_type: 'stop_all' },
    null,
    true,
  );

  // ── lap ──
  fw.writeMessage(
    'lap',
    {
      timestamp: endTimestamp,
      start_time: startTimestamp,
      total_elapsed_time: q(durationSec, 1000),
      total_timer_time: q(durationSec, 1000),
      total_distance: q(totalDistance, 100),
      ...(ride.avgHr != null && { avg_heart_rate: Math.round(ride.avgHr) }),
      ...(ride.maxHr != null && { max_heart_rate: ride.maxHr }),
      ...(ride.avgPowerW != null && { avg_power: Math.round(ride.avgPowerW) }),
      ...(ride.maxPowerW != null && { max_power: Math.round(ride.maxPowerW) }),
      ...(ride.avgCadence != null && { avg_cadence: Math.round(ride.avgCadence) }),
      ...(ride.avgSpeed != null && { avg_speed: q(ride.avgSpeed / 3.6, 1000) }),
      ...(ride.maxSpeed != null && { max_speed: q(ride.maxSpeed / 3.6, 1000) }),
    },
    null,
    true,
  );

  // ── session ──
  fw.writeMessage(
    'session',
    {
      timestamp: endTimestamp,
      start_time: startTimestamp,
      total_elapsed_time: q(durationSec, 1000),
      total_timer_time: q(durationSec, 1000),
      total_distance: q(totalDistance, 100),
      sport: 'cycling',
      sub_sport: 'indoor_cycling',
      first_lap_index: 0,
      num_laps: 1,
      ...(ride.avgHr != null && { avg_heart_rate: Math.round(ride.avgHr) }),
      ...(ride.maxHr != null && { max_heart_rate: ride.maxHr }),
      ...(ride.avgPowerW != null && { avg_power: Math.round(ride.avgPowerW) }),
      ...(ride.maxPowerW != null && { max_power: Math.round(ride.maxPowerW) }),
      ...(ride.avgCadence != null && { avg_cadence: Math.round(ride.avgCadence) }),
      ...(ride.avgSpeed != null && { avg_speed: q(ride.avgSpeed / 3.6, 1000) }),
      ...(ride.maxSpeed != null && { max_speed: q(ride.maxSpeed / 3.6, 1000) }),
    },
    null,
    true,
  );

  // ── activity ──
  fw.writeMessage(
    'activity',
    {
      timestamp: endTimestamp,
      total_timer_time: q(durationSec, 1000),
      num_sessions: 1,
      type: 'manual',
      event: 'activity',
      event_type: 'stop',
    },
    null,
    true,
  );

  // finish() hands back a DataView over its internal buffer; the callers
  // (ride-api's download route) want bytes.
  const dv = fw.finish();
  return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
}
