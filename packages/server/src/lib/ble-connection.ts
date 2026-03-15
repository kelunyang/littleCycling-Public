/**
 * BLE (Bluetooth Low Energy) heart rate connection manager.
 * Uses @stoprocent/noble to scan for and connect to BLE heart rate devices.
 *
 * BLE Heart Rate Profile:
 *   Service UUID:        0x180D
 *   Characteristic UUID: 0x2A37 (Heart Rate Measurement, notify)
 */

import noble from '@stoprocent/noble';

const HR_SERVICE_UUID = '180d';
const HR_MEASUREMENT_UUID = '2a37';

export interface BleHrDevice {
  id: string;
  name: string;
  peripheral: any; // noble Peripheral
}

export interface BleHrData {
  heartRate: number;
  /** Contact sensor detected (not all devices report this) */
  contactDetected?: boolean;
  /** R-R interval in ms (if available) */
  rrIntervals?: number[];
}

export interface BleConnectionOptions {
  /** Scan timeout in ms (default: 30000) */
  scanTimeout?: number;
  /** Enable debug logging */
  debug?: boolean;
}

export class BleConnection {
  private debug: boolean;
  private scanTimeout: number;
  private connectedPeripheral: any | null = null;
  private hrCharacteristic: any | null = null;

  constructor(options: BleConnectionOptions = {}) {
    this.debug = options.debug ?? false;
    this.scanTimeout = options.scanTimeout ?? 30000;
  }

  /**
   * Wait for the BLE adapter to be ready.
   */
  async waitForAdapter(): Promise<void> {
    try {
      await noble.waitForPoweredOn(30000);
    } catch {
      throw new Error(
        'Bluetooth adapter not ready.\n' +
        'Make sure Bluetooth is enabled on your PC.'
      );
    }
  }

  /**
   * Scan for BLE heart rate devices.
   * Returns discovered devices via the onDiscover callback.
   * Scanning stops when stopScan() is called or timeout is reached.
   */
  async scan(onDiscover: (device: BleHrDevice) => void): Promise<void> {
    const seen = new Set<string>();

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        noble.stopScanning();
        resolve();
      }, this.scanTimeout);

      noble.on('discover', (peripheral: any) => {
        // Filter: only devices advertising the Heart Rate service
        const serviceUuids: string[] = peripheral.advertisement?.serviceUuids ?? [];
        if (!serviceUuids.includes(HR_SERVICE_UUID)) return;

        if (seen.has(peripheral.id)) return;
        seen.add(peripheral.id);

        const name = peripheral.advertisement?.localName || peripheral.id;
        if (this.debug) {
          console.log(`  [ble-debug] Discovered HR device: ${name} (id: ${peripheral.id})`);
        }

        onDiscover({ id: peripheral.id, name, peripheral });
      });

      // Store resolve so stopScan() can call it
      this._scanResolve = () => {
        clearTimeout(timeout);
        resolve();
      };

      // Start scanning for heart rate service
      noble.startScanningAsync([HR_SERVICE_UUID], false)
        .catch((err: Error) => {
          clearTimeout(timeout);
          reject(new Error(`BLE scan failed: ${err.message}`));
        });
    });
  }

  private _scanResolve: (() => void) | null = null;

  /**
   * Stop an ongoing scan.
   */
  stopScan(): void {
    noble.stopScanning();
    if (this._scanResolve) {
      this._scanResolve();
      this._scanResolve = null;
    }
  }

  /**
   * Connect to a BLE heart rate device and subscribe to HR notifications.
   * Calls onData for each heart rate update.
   */
  async connect(
    device: BleHrDevice,
    onData: (data: BleHrData) => void,
    onDisconnect?: () => void
  ): Promise<void> {
    const peripheral = device.peripheral;

    // Ensure scanning is stopped before connecting.
    // Use sync stopScanning() — stopScanningAsync() hangs if scanning is already stopped.
    noble.stopScanning();

    if (this.debug) {
      console.log(`  [ble-debug] Connecting to ${device.name}...`);
    }

    await peripheral.connectAsync();
    this.connectedPeripheral = peripheral;

    if (this.debug) {
      console.log(`  [ble-debug] Connected. Discovering HR service...`);
    }

    const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [HR_SERVICE_UUID],
      [HR_MEASUREMENT_UUID]
    );

    if (!characteristics || characteristics.length === 0) {
      throw new Error(`No Heart Rate Measurement characteristic found on ${device.name}`);
    }

    const hrChar = characteristics[0];
    this.hrCharacteristic = hrChar;

    hrChar.on('data', (buffer: Buffer) => {
      const parsed = parseHeartRateMeasurement(buffer);
      onData(parsed);
    });

    if (onDisconnect) {
      peripheral.once('disconnect', onDisconnect);
    }

    await hrChar.subscribeAsync();

    if (this.debug) {
      console.log(`  [ble-debug] Subscribed to HR notifications from ${device.name}`);
    }
  }

  /**
   * Disconnect from the current device. Idempotent.
   */
  async disconnect(): Promise<void> {
    if (this.hrCharacteristic) {
      try {
        await this.hrCharacteristic.unsubscribeAsync();
      } catch {
        // ignore
      }
      this.hrCharacteristic = null;
    }

    if (this.connectedPeripheral) {
      try {
        await this.connectedPeripheral.disconnectAsync();
      } catch {
        // ignore
      }
      this.connectedPeripheral = null;
    }
  }
}

/**
 * Parse the BLE Heart Rate Measurement characteristic value.
 * See: https://www.bluetooth.com/specifications/gatt/characteristics/
 *
 * Byte 0: Flags
 *   bit 0: 0 = HR is uint8, 1 = HR is uint16
 *   bit 1-2: Sensor contact status
 *   bit 3: Energy Expended present
 *   bit 4: RR-Interval present
 * Byte 1 (or 1-2): Heart rate value
 * Remaining: optional Energy Expended + RR-Intervals
 */
function parseHeartRateMeasurement(buffer: Buffer): BleHrData {
  const flags = buffer[0];
  const is16bit = !!(flags & 0x01);
  const contactSupported = !!(flags & 0x04);
  const contactDetected = contactSupported ? !!(flags & 0x02) : undefined;
  const hasEnergyExpended = !!(flags & 0x08);
  const hasRrInterval = !!(flags & 0x10);

  let offset = 1;
  let heartRate: number;

  if (is16bit) {
    heartRate = buffer.readUInt16LE(offset);
    offset += 2;
  } else {
    heartRate = buffer[offset];
    offset += 1;
  }

  // Skip Energy Expended if present
  if (hasEnergyExpended) {
    offset += 2;
  }

  // Parse RR-Intervals (in 1/1024 second units -> convert to ms)
  const rrIntervals: number[] = [];
  if (hasRrInterval) {
    while (offset + 1 < buffer.length) {
      const rrRaw = buffer.readUInt16LE(offset);
      rrIntervals.push(Math.round((rrRaw / 1024) * 1000));
      offset += 2;
    }
  }

  return {
    heartRate,
    contactDetected,
    rrIntervals: rrIntervals.length > 0 ? rrIntervals : undefined,
  };
}
