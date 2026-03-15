/**
 * ANT+ sensor scanning and data forwarding.
 * Uses a single channel with multiple attached sensor profiles
 * and await startScanner() — the correct incyclist-ant-plus API pattern.
 */

import { HeartRateSensor, SpeedCadenceSensor, SpeedSensor, CadenceSensor } from 'incyclist-ant-plus';
import type { HeartRateSensorState, SpeedCadenceSensorState, SpeedSensorState, CadenceSensorState } from 'incyclist-ant-plus';

export type SensorProfile = 'HR' | 'SC' | 'SPD' | 'CAD';

export interface DetectedSensor {
  profile: string;
  deviceId: number;
}

export interface SensorDataEvent {
  profile: string;
  deviceId: number;
  data: HeartRateSensorState | SpeedCadenceSensorState | SpeedSensorState | CadenceSensorState;
}

export interface SensorManagerOptions {
  /** Called when a sensor is detected during scanning */
  onDetect?: (sensor: DetectedSensor) => void;
  /** Called on each incoming data event */
  onData?: (event: SensorDataEvent) => void;
  /** Wheel circumference in meters (default: 2.105 for 700x25c) */
  wheelCircumference?: number;
  /** Enable debug logging */
  debug?: boolean;
}

export class SensorManager {
  private channel: any;
  private onDetect: (sensor: DetectedSensor) => void;
  private onData: (event: SensorDataEvent) => void;
  private wheelCircumference: number;
  private debug: boolean;
  private detectedSensors: DetectedSensor[] = [];
  private scanResolve: (() => void) | null = null;

  constructor(channel: any, options: SensorManagerOptions = {}) {
    this.channel = channel;
    this.onDetect = options.onDetect ?? (() => {});
    this.onData = options.onData ?? (() => {});
    this.wheelCircumference = options.wheelCircumference ?? 2.105;
    this.debug = options.debug ?? false;
  }

  /**
   * Attach sensor profiles and start scanning.
   * This MUST be awaited — scanning runs until stopScanning() is called.
   * Detected sensors are reported via the onDetect callback.
   */
  async startScanning(): Promise<void> {
    // Attach all sensor profiles to a single channel (correct API usage)
    this.channel.attach(new HeartRateSensor());

    const sc = new SpeedCadenceSensor();
    sc.setWheelCircumference(this.wheelCircumference);
    this.channel.attach(sc);

    const spd = new SpeedSensor();
    spd.setWheelCircumference(this.wheelCircumference);
    this.channel.attach(spd);

    this.channel.attach(new CadenceSensor());

    if (this.debug) {
      console.log(`      [debug] Attached 4 sensor profiles to channel ${this.channel.channelNo}`);
    }

    // Listen for sensor detection — channel emits 'detected' (not 'detect')
    this.channel.on('detected', (profile: string, deviceId: number) => {
      // Deduplicate
      if (this.detectedSensors.some((s) => s.profile === profile && s.deviceId === deviceId)) {
        return;
      }
      if (this.debug) {
        console.log(`      [debug] DETECT: profile=${profile}, deviceId=${deviceId}`);
      }
      const sensor: DetectedSensor = { profile, deviceId };
      this.detectedSensors.push(sensor);
      this.onDetect(sensor);
    });

    // Listen for sensor data
    this.channel.on('data', (profile: string, deviceId: number, data: any) => {
      this.onData({ profile, deviceId, data });
    });

    if (this.debug) {
      console.log(`      [debug] Starting scanner (await)...`);
    }

    // channel.startScanner() resolves immediately once the scanner channel is open.
    // We create our own blocking promise that resolves when stopScanning() is called.
    const started = await this.channel.startScanner();
    if (!started) {
      throw new Error('Failed to start ANT+ scanner channel.');
    }

    if (this.debug) {
      console.log(`      [debug] Scanner channel open, waiting for stopScanning()...`);
    }

    // Block until stopScanning() is called
    await new Promise<void>((resolve) => {
      this.scanResolve = resolve;
    });

    if (this.debug) {
      console.log(`      [debug] Scanner finished, detected ${this.detectedSensors.length} sensor(s)`);
    }
  }

  /**
   * Finish the scan phase without closing the scanner channel.
   * The scanner keeps running so data events continue to flow.
   * Call this when the user confirms sensor selection (Enter key).
   */
  finishScanPhase(): void {
    if (this.scanResolve) {
      this.scanResolve();
      this.scanResolve = null;
    }
  }

  /**
   * Fully stop the scanner and close the channel. Call during shutdown only.
   */
  stopScanning(): void {
    this.finishScanPhase();
    try {
      this.channel.stopScanner();
    } catch {
      // Ignore if already stopped
    }
  }

  /**
   * Get the channel used for scanning (for hooking data events after scan).
   */
  getChannel(): any {
    return this.channel;
  }

  getDetectedSensors(): DetectedSensor[] {
    return [...this.detectedSensors];
  }
}
