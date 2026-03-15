#!/usr/bin/env node
/**
 * BLE Heart Rate Test Script
 *
 * Usage (run on Windows, NOT in WSL):
 *   npx tsx src/ble-hr-test.ts
 *   npx tsx src/ble-hr-test.ts --debug
 *
 * This script will:
 *   1. Wait for BLE adapter
 *   2. Scan for heart rate devices (watches, HR straps)
 *   3. Connect to the first one found
 *   4. Print heart rate data for 60 seconds
 *   5. Disconnect and exit
 *
 * Press Ctrl+C to stop early.
 */

import { BleConnection, type BleHrDevice, type BleHrData } from './lib/ble-connection.js';

const args = process.argv.slice(2);
const debug = args.includes('--debug');

async function main() {
  console.log('=== BLE Heart Rate Test ===\n');

  const ble = new BleConnection({ scanTimeout: 30000, debug });

  // 1. Wait for adapter
  console.log('Waiting for Bluetooth adapter...');
  try {
    await ble.waitForAdapter();
    console.log('Bluetooth adapter ready.\n');
  } catch (err: any) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }

  // 2. Scan for HR devices
  console.log('Scanning for BLE heart rate devices...');
  console.log('(Make sure your watch/HR strap is nearby and broadcasting)\n');

  let selectedDevice: BleHrDevice | undefined;

  const scanPromise = ble.scan((device) => {
    console.log(`  Found: ${device.name} (id: ${device.id})`);
    if (!selectedDevice) {
      selectedDevice = device;
      // Stop scan once we find the first HR device
      ble.stopScan();
    }
  });

  await scanPromise;

  if (!selectedDevice) {
    console.error('\nNo BLE heart rate devices found.');
    console.error('Tips:');
    console.error('  - Make sure Bluetooth is enabled');
    console.error('  - Bring your watch/strap closer');
    console.error('  - Check that the device is broadcasting HR (e.g., workout mode on watch)');
    process.exit(1);
  }

  console.log(`\nConnecting to: ${selectedDevice.name}...`);

  // 3. Connect and subscribe
  let dataCount = 0;
  const startTime = Date.now();

  try {
    await ble.connect(
      selectedDevice,
      (data: BleHrData) => {
        dataCount++;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        let line = `  [${elapsed}s] HR: ${data.heartRate} bpm`;
        if (data.contactDetected !== undefined) {
          line += ` | contact: ${data.contactDetected ? 'yes' : 'no'}`;
        }
        if (data.rrIntervals && data.rrIntervals.length > 0) {
          line += ` | RR: ${data.rrIntervals.join(', ')} ms`;
        }
        console.log(line);
      },
      () => {
        console.log('\nDevice disconnected.');
        process.exit(0);
      }
    );
  } catch (err: any) {
    console.error(`\nConnection failed: ${err.message}`);
    process.exit(1);
  }

  console.log('Connected! Receiving heart rate data...\n');

  // 4. Run for 60 seconds then stop
  const DURATION_SEC = 60;
  console.log(`(Will auto-stop after ${DURATION_SEC} seconds. Press Ctrl+C to stop early.)\n`);

  const cleanup = async () => {
    console.log(`\nStopping... Received ${dataCount} data points.`);
    await ble.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);

  setTimeout(async () => {
    await cleanup();
  }, DURATION_SEC * 1000);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
