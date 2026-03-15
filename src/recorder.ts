#!/usr/bin/env node
/**
 * Sensor Recorder (ANT+ and/or BLE)
 *
 * Connects to ANT+ sensors and/or BLE heart rate devices,
 * and records all incoming data to a JSONL file.
 *
 * Usage:
 *   npx tsx src/recorder.ts                          # ANT+ only (default)
 *   npx tsx src/recorder.ts                          # ANT+ + BLE heart rate (default)
 *   npx tsx src/recorder.ts --no-ble-hr              # ANT+ only, skip BLE scanning
 *   npx tsx src/recorder.ts -o my-ride.jsonl         # Record to specific file
 *   npx tsx src/recorder.ts --verify-only            # Just verify connections, then exit
 *   npx tsx src/recorder.ts -t 15000                 # Set scan timeout to 15 seconds
 */

import path from 'node:path';
import { AntConnection } from './lib/ant-connection.js';
import { SensorManager } from './lib/sensor-manager.js';
import { DataWriter } from './lib/data-writer.js';
import { BleConnection, type BleHrDevice, type BleHrData } from './lib/ble-connection.js';

// ── CLI argument parsing (minimal, no extra deps) ──

const args = process.argv.slice(2);

function getArg(flag: string, shortFlag?: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag || (shortFlag && args[i] === shortFlag)) {
      return args[i + 1];
    }
  }
  return undefined;
}

function hasFlag(flag: string, shortFlag?: string): boolean {
  return args.includes(flag) || (shortFlag !== undefined && args.includes(shortFlag));
}

if (hasFlag('--help', '-h')) {
  console.log(`
Sensor Recorder - littleCycling

Usage:
  npx tsx src/recorder.ts [options]

Options:
  -o, --output <path>     Output JSONL file path (default: auto-generated in recordings/)
  -t, --timeout <ms>      Sensor scan timeout in milliseconds (default: 30000)
      --no-ble-hr         Skip BLE heart rate scanning (BLE HR is on by default)
      --verify-only       Just verify connections and sensor detection, then exit
      --debug             Enable debug logging
  -h, --help              Show this help message
`);
  process.exit(0);
}

const verifyOnly = hasFlag('--verify-only');
const debug = hasFlag('--debug');
const useBleHr = !hasFlag('--no-ble-hr');
const scanTimeout = parseInt(getArg('--timeout', '-t') ?? '30000', 10);

const defaultFilename = `recording-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jsonl`;
const outputPath = path.resolve(getArg('--output', '-o') ?? path.join('recordings', defaultFilename));

// ── Helpers ──

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Normalize BLE HR data to match ANT+ HR field names for JSONL compatibility. */
function normalizeBleHrData(data: BleHrData): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ComputedHeartRate: data.heartRate,
    source: 'ble',
  };
  if (data.contactDetected !== undefined) {
    normalized.ContactDetected = data.contactDetected;
  }
  if (data.rrIntervals && data.rrIntervals.length > 0) {
    normalized.RRInterval = data.rrIntervals;
  }
  return normalized;
}

// ── Main ──

async function main() {
  console.log('');
  console.log('  littleCycling - Sensor Recorder');
  console.log('  ================================');
  console.log('');

  let step = 1;
  const totalSteps = verifyOnly ? (useBleHr ? 3 : 2) : (useBleHr ? 5 : 4);

  // ── ANT+ stick ──
  let connection: AntConnection | null = null;
  let sensorMgr: SensorManager | null = null;
  let channel: any = null;
  let stickInfo: { maxChannels: number; deviceNumber: number } | null = null;

  console.log(`[${step}/${totalSteps}] Connecting to ANT+ stick...`);
  connection = new AntConnection({ startupTimeout: 5000, debug });

  try {
    stickInfo = await connection.open();
    console.log(`      OK - Stick #${stickInfo.deviceNumber}, max channels: ${stickInfo.maxChannels}`);
  } catch (err: any) {
    if (useBleHr) {
      console.log(`      Skipped - ${err.message}`);
      console.log('      (Continuing with BLE HR only)');
      connection = null;
    } else {
      console.error(`      FAIL - ${err.message}`);
      process.exit(1);
    }
  }
  step++;

  // ANT+ sensor scan
  const antSensors: Array<{ profile: string; deviceId: number }> = [];
  if (connection && stickInfo) {
    console.log(`[${step}/${totalSteps}] Scanning for ANT+ sensors (${scanTimeout / 1000}s timeout)...`);
    console.log('      Tip: spin your wheel or crank to wake up speed/cadence sensor');
    console.log('');

    channel = connection.getChannel();
    sensorMgr = new SensorManager(channel, {
      scanTimeout,
      onDetect: (sensor) => {
        console.log(`      Found: ${sensor.profile} (device ID: ${sensor.deviceId})`);
      },
      onData: () => {},
    });

    await sensorMgr.startScanning();
    antSensors.push(...sensorMgr.getDetectedSensors());

    console.log('');
    if (antSensors.length === 0) {
      console.log('      No ANT+ sensors detected.');
    } else {
      console.log(`      ANT+ sensors: ${antSensors.length} detected`);
    }
    step++;
  }

  // ── BLE HR ──
  let ble: BleConnection | null = null;
  let bleDevice: BleHrDevice | null = null;

  if (useBleHr) {
    console.log(`[${step}/${totalSteps}] Scanning for BLE heart rate devices...`);

    ble = new BleConnection({ scanTimeout, debug });

    try {
      await ble.waitForAdapter();
    } catch (err: any) {
      console.error(`      BLE adapter error: ${err.message}`);
      if (antSensors.length === 0 && !stickInfo) {
        console.error('      No ANT+ stick and no BLE adapter. Cannot continue.');
        process.exit(1);
      }
      console.log('      (Continuing without BLE HR)');
      ble = null;
    }

    if (ble) {
      await ble.scan((device) => {
        console.log(`      Found BLE HR: ${device.name} (id: ${device.id})`);
        if (!bleDevice) {
          bleDevice = device;
          ble!.stopScan();
        }
      });

      if (!bleDevice) {
        console.log('      No BLE HR devices found.');
        ble = null;
      }
    }
    step++;
  }

  // Check we have at least something
  if (antSensors.length === 0 && !bleDevice) {
    console.error('');
    console.error('      No sensors detected! Make sure sensors are active and in range.');
    if (connection) await connection.close();
    process.exit(1);
  }

  // ── Verify-only mode ──
  if (verifyOnly) {
    console.log('');
    console.log('[OK] Verification complete.');
    if (antSensors.length > 0) {
      console.log(`     ANT+ sensors: ${antSensors.length}`);
    }
    if (bleDevice) {
      console.log(`     BLE HR: ${bleDevice.name}`);
    }
    if (sensorMgr) sensorMgr.stopScanning();
    if (ble) await ble.disconnect();
    if (connection) await connection.close();
    process.exit(0);
  }

  // ── Connect BLE HR ──
  if (ble && bleDevice) {
    console.log(`[${step}/${totalSteps}] Connecting to BLE HR: ${bleDevice.name}...`);
    step++;
  }

  // ── Start recording ──
  console.log(`[${step}/${totalSteps}] Opening output file...`);
  console.log(`      ${outputPath}`);

  const allSensors = [
    ...antSensors.map((s) => ({ profile: s.profile, deviceId: s.deviceId })),
    ...(bleDevice ? [{ profile: 'HR', deviceId: 0, source: 'ble', name: bleDevice.name }] : []),
  ];

  const writer = new DataWriter(outputPath);
  writer.open();
  writer.writeSessionStart(
    { maxChannels: stickInfo?.maxChannels ?? 0 },
    allSensors
  );

  // Last data snapshot for live display
  let lastHR = '--';
  let lastSpeed = '--';
  let lastCadence = '--';

  // Hook ANT+ data events to writer
  if (channel) {
    channel.on('data', (profile: string, deviceId: number, data: any) => {
      const normalized = { ...data, source: 'ant' };
      // Normalize RRInterval to always be an array (ANT+ sends a single number)
      if (normalized.RRInterval != null && !Array.isArray(normalized.RRInterval)) {
        normalized.RRInterval = [normalized.RRInterval];
      }
      writer.writeData(profile, deviceId, normalized);
    });
  }

  // Connect BLE HR in background (don't block recording start)
  if (ble && bleDevice) {
    console.log(`      BLE HR connecting: ${bleDevice.name}...`);
    ble.connect(
      bleDevice,
      (data: BleHrData) => {
        writer.writeData('HR', 0, normalizeBleHrData(data));
        lastHR = `${data.heartRate} bpm`;
      },
      () => {
        console.log('\n      BLE HR device disconnected.');
      }
    ).then(() => {
      console.log(`      BLE HR connected: ${bleDevice.name}`);
    }).catch((err: any) => {
      console.error(`      BLE HR connection failed: ${err.message}`);
    });
  }

  console.log(`[${step}/${totalSteps}] Recording... Press Ctrl+C to stop.`);
  console.log('');

  const startTime = Date.now();

  // Periodic status output
  const statusInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    console.log(`      [${formatDuration(elapsed)}] records: ${writer.recordCount}`);
  }, 10000);

  if (channel) {
    channel.on('data', (profile: string, _deviceId: number, data: any) => {
      if (profile === 'HR') {
        lastHR = data.ComputedHeartRate != null ? `${data.ComputedHeartRate} bpm` : '--';
      }
      if (profile === 'SC' || profile === 'SPD' || profile === 'CAD') {
        if (data.CalculatedSpeed != null) {
          lastSpeed = `${(data.CalculatedSpeed * 3.6).toFixed(1)} km/h`;
        }
        if (data.CalculatedCadence != null) {
          lastCadence = `${data.CalculatedCadence} rpm`;
        }
      }
    });
  }

  // Live display every 2 seconds
  const displayInterval = setInterval(() => {
    process.stdout.write(
      `\r      HR: ${lastHR}  |  Speed: ${lastSpeed}  |  Cadence: ${lastCadence}  |  Records: ${writer.recordCount}    `
    );
  }, 2000);

  // Graceful shutdown
  let isShuttingDown = false;

  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    clearInterval(statusInterval);
    clearInterval(displayInterval);

    console.log('\n');
    console.log('  Shutting down...');

    if (sensorMgr) sensorMgr.stopScanning();
    if (ble) await ble.disconnect();
    await writer.close();

    const elapsed = Date.now() - startTime;
    console.log(`  Recording saved: ${outputPath}`);
    console.log(`  Duration: ${formatDuration(elapsed)}, Records: ${writer.recordCount}`);

    if (connection) await connection.close();
    console.log('  Connections closed. Goodbye!');
    console.log('');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Windows: make Ctrl+C work in cmd.exe / PowerShell
  if (process.platform === 'win32') {
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('SIGINT', () => process.emit('SIGINT'));
  }
}

main().catch((err) => {
  console.error('');
  console.error('  Unhandled error:', err.message ?? err);
  console.error('');
  process.exit(1);
});
