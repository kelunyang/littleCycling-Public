/**
 * LiveSession — sensor connection + recording core.
 * Extracted from recorder.ts to be reused by both server.ts and recorder CLI.
 *
 * Lifecycle:
 *   idle → startScan() → scanning → ready → startRecording() → recording → stopRecording() → ready
 *   Any state → shutdown() → stopped
 */

import { EventEmitter } from 'node:events';
import { AntConnection } from './ant-connection.js';
import { SensorManager } from './sensor-manager.js';
import { BleConnection, type BleHrDevice, type BleHrData } from './ble-connection.js';
import { RideDatabase, type EndRideSummary } from './database.js';
import { WsRelay } from './ws-relay.js';
import type { DetectedSensor, WsSensorMessage, WsSessionStartMessage, WsSessionEndMessage, WsStatusMessage, LiveSessionState } from '@littlecycling/shared';

export interface LiveSessionOptions {
  relay: WsRelay;
  db: RideDatabase;
  /** Skip BLE heart rate scanning (default: false) */
  noBleHr?: boolean;
  /** Sensor scan timeout in ms (default: 30000) */
  scanTimeout?: number;
  /** Enable debug logging */
  debug?: boolean;
}

export interface LiveSensorSnapshot {
  hr?: number;
  speed?: number;    // km/h
  cadence?: number;  // rpm
  power?: number;    // watts
}

export interface RideSummary extends EndRideSummary {
  rideId: number;
  sampleCount: number;
}

/**
 * Events:
 *   'state'   (state: LiveSessionState)
 *   'data'    (snapshot: LiveSensorSnapshot) — every incoming sensor data point
 *   'detect'  (sensor: DetectedSensor)
 */
export class LiveSession extends EventEmitter {
  private _state: LiveSessionState = 'idle';
  private relay: WsRelay;
  private db: RideDatabase;
  private noBleHr: boolean;
  private scanTimeout: number;
  private debug: boolean;

  // ANT+
  private antConnection: AntConnection | null = null;
  private sensorMgr: SensorManager | null = null;
  private channel: any = null;

  // BLE
  private ble: BleConnection | null = null;
  private bleDevice: BleHrDevice | undefined;

  // Detected sensors
  private _detectedSensors: DetectedSensor[] = [];

  // Recording state
  private _rideId: number | null = null;
  private recordingStartTime: number = 0;
  private sampleCount: number = 0;

  // Live snapshot for console display
  private _snapshot: LiveSensorSnapshot = {};

  // Accumulation for summary stats
  private hrSum = 0;
  private hrCount = 0;
  private hrMax = 0;
  private powerSum = 0;
  private powerCount = 0;
  private powerMax = 0;
  private cadenceSum = 0;
  private cadenceCount = 0;
  private speedSum = 0;
  private speedCount = 0;
  private speedMax = 0;
  private distanceM = 0;
  private lastSpeedTimeMs = 0;

  constructor(options: LiveSessionOptions) {
    super();
    this.relay = options.relay;
    this.db = options.db;
    this.noBleHr = options.noBleHr ?? false;
    this.scanTimeout = options.scanTimeout ?? 30000;
    this.debug = options.debug ?? false;
  }

  get state(): LiveSessionState {
    return this._state;
  }

  get detectedSensors(): DetectedSensor[] {
    return [...this._detectedSensors];
  }

  get rideId(): number | null {
    return this._rideId;
  }

  get snapshot(): LiveSensorSnapshot {
    return { ...this._snapshot };
  }

  private setState(s: LiveSessionState): void {
    this._state = s;
    this.emit('state', s);
    // Broadcast status to all WS clients on every state change
    this.relay.broadcast(this.getStatusMessage());
  }

  /** Build a WsStatusMessage reflecting current session state. */
  getStatusMessage(): WsStatusMessage {
    return {
      type: 'status',
      state: this._state,
      sensors: this._detectedSensors,
      rideId: this._rideId,
    };
  }

  // ── Scan ──

  async startScan(): Promise<DetectedSensor[]> {
    if (this._state !== 'idle' && this._state !== 'ready') {
      throw new Error(`Cannot scan in state: ${this._state}`);
    }

    this.setState('scanning');
    this._detectedSensors = [];

    // ANT+ stick
    this.antConnection = new AntConnection({ startupTimeout: 5000, debug: this.debug });

    try {
      const stickInfo = await this.antConnection.open();
      if (this.debug) {
        console.log(`[live] ANT+ stick #${stickInfo.deviceNumber}, channels: ${stickInfo.maxChannels}`);
      }

      this.channel = this.antConnection.getChannel();
      this.sensorMgr = new SensorManager(this.channel, {
        scanTimeout: this.scanTimeout,
        onDetect: (sensor) => {
          this._detectedSensors.push({ ...sensor, source: 'ant' });
          this.emit('detect', { ...sensor, source: 'ant' });
        },
        onData: () => {},
        debug: this.debug,
      });

      // Start scanning in background — resolves when finishScanPhase() is called
      const scanPromise = this.sensorMgr.startScanning();

      // Wait for scan timeout, then finish scan phase
      await new Promise<void>((resolve) => setTimeout(resolve, this.scanTimeout));
      this.sensorMgr.finishScanPhase();
      await scanPromise;

    } catch (err: any) {
      if (!this.noBleHr) {
        console.log(`[live] ANT+ unavailable: ${err.message}`);
        console.log('[live] Continuing with BLE HR only');
        this.antConnection = null;
        this.channel = null;
        this.sensorMgr = null;
      } else {
        throw err;
      }
    }

    // BLE HR
    if (!this.noBleHr) {
      this.ble = new BleConnection({ scanTimeout: this.scanTimeout, debug: this.debug });

      try {
        await this.ble.waitForAdapter();
        await this.ble.scan((device) => {
          if (!this.bleDevice) {
            this.bleDevice = device;
            this.ble!.stopScan();
          }
        });
      } catch (err: any) {
        console.log(`[live] BLE unavailable: ${err.message}`);
        this.ble = null;
      }

      if (this.bleDevice) {
        this._detectedSensors.push({
          profile: 'HR',
          deviceId: 0,
          source: 'ble',
          name: this.bleDevice.name,
        });
        this.emit('detect', {
          profile: 'HR',
          deviceId: 0,
          source: 'ble',
          name: this.bleDevice.name,
        });
      }
    }

    // Hook up data events for broadcasting (always, even before recording)
    this.hookDataEvents();

    // Connect BLE HR
    if (this.ble && this.bleDevice) {
      try {
        await this.ble.connect(
          this.bleDevice,
          (data: BleHrData) => this.handleBleHrData(data),
          () => console.log('[live] BLE HR disconnected'),
        );
      } catch (err: any) {
        console.log(`[live] BLE HR connect failed: ${err.message}`);
      }
    }

    this.setState('ready');

    // Broadcast session_start so frontend knows sensors are connected
    const sessionStartMsg: WsSessionStartMessage = {
      type: 'session_start',
      tsEpoch: Date.now(),
      sensors: this._detectedSensors,
    };
    this.relay.broadcast(sessionStartMsg);

    return this._detectedSensors;
  }

  // ── Recording ──

  async startRecording(opts: { routeId?: string; routeName?: string } = {}): Promise<number> {
    if (this._state !== 'ready') {
      throw new Error(`Cannot start recording in state: ${this._state}`);
    }

    const now = Date.now();
    this._rideId = this.db.createRide({
      startedAt: now,
      routeId: opts.routeId,
      routeName: opts.routeName,
    });
    this.recordingStartTime = now;
    this.lastSpeedTimeMs = now;
    this.sampleCount = 0;
    this.resetStats();

    this.setState('recording');
    return this._rideId;
  }

  async stopRecording(): Promise<RideSummary> {
    if (this._state !== 'recording' || this._rideId === null) {
      throw new Error(`Cannot stop recording in state: ${this._state}`);
    }

    const now = Date.now();
    const durationMs = now - this.recordingStartTime;

    const summary: EndRideSummary = {
      endedAt: now,
      durationMs,
      distanceM: Math.round(this.distanceM),
      avgPowerW: this.powerCount > 0 ? this.powerSum / this.powerCount : undefined,
      avgHr: this.hrCount > 0 ? this.hrSum / this.hrCount : undefined,
      avgCadence: this.cadenceCount > 0 ? this.cadenceSum / this.cadenceCount : undefined,
      avgSpeed: this.speedCount > 0 ? this.speedSum / this.speedCount : undefined,
      maxHr: this.hrMax > 0 ? this.hrMax : undefined,
      maxPowerW: this.powerMax > 0 ? this.powerMax : undefined,
      maxSpeed: this.speedMax > 0 ? this.speedMax : undefined,
    };

    this.db.endRide(this._rideId, summary);

    const result: RideSummary = {
      ...summary,
      rideId: this._rideId,
      sampleCount: this.sampleCount,
    };

    this._rideId = null;
    this.setState('ready');

    return result;
  }

  // ── Shutdown ──

  async shutdown(): Promise<void> {
    if (this._state === 'recording' && this._rideId !== null) {
      await this.stopRecording();
    }

    // Broadcast session_end
    const sessionEndMsg: WsSessionEndMessage = {
      type: 'session_end',
      tsEpoch: Date.now(),
      elapsed: this.recordingStartTime > 0 ? Date.now() - this.recordingStartTime : 0,
      totalRecords: this.sampleCount,
    };
    this.relay.broadcast(sessionEndMsg);

    if (this.sensorMgr) {
      this.sensorMgr.stopScanning();
      this.sensorMgr = null;
    }
    if (this.ble) {
      await this.ble.disconnect();
      this.ble = null;
    }
    if (this.antConnection) {
      await this.antConnection.close();
      this.antConnection = null;
    }

    this.setState('stopped');
  }

  // ── Internal data handling ──

  private hookDataEvents(): void {
    // ANT+ data
    if (this.channel) {
      this.channel.on('data', (profile: string, deviceId: number, data: any) => {
        this.handleAntData(profile, deviceId, data);
      });
    }
  }

  private handleAntData(profile: string, deviceId: number, data: any): void {
    const now = Date.now();
    const elapsedMs = this.recordingStartTime > 0 ? now - this.recordingStartTime : 0;

    // Broadcast via WebSocket
    const msg: WsSensorMessage = {
      type: 'sensor',
      tsEpoch: now,
      elapsed: elapsedMs,
      profile,
      deviceId,
      data: { ...data, source: 'ant' },
    };
    this.relay.broadcast(msg);

    // Update snapshot + write sample
    if (profile === 'HR' && data.ComputedHeartRate != null) {
      this._snapshot.hr = data.ComputedHeartRate;
      this.accumHr(data.ComputedHeartRate);
    }
    if ((profile === 'SC' || profile === 'SPD' || profile === 'CAD')) {
      if (data.CalculatedSpeed != null) {
        const speedKmh = data.CalculatedSpeed * 3.6;
        this._snapshot.speed = speedKmh;
        this.accumSpeed(speedKmh);
      }
      if (data.CalculatedCadence != null) {
        this._snapshot.cadence = data.CalculatedCadence;
        this.accumCadence(data.CalculatedCadence);
      }
    }
    if (profile === 'PWR' && data.Power != null) {
      this._snapshot.power = data.Power;
      this.accumPower(data.Power);
    }

    this.emit('data', this._snapshot);

    // Write to SQLite if recording
    if (this._state === 'recording' && this._rideId !== null) {
      this.db.insertSample(this._rideId, {
        elapsedMs,
        hr: this._snapshot.hr,
        powerW: this._snapshot.power,
        cadence: this._snapshot.cadence,
        speedKmh: this._snapshot.speed,
      });
      this.sampleCount++;
    }
  }

  private handleBleHrData(data: BleHrData): void {
    const now = Date.now();
    const elapsedMs = this.recordingStartTime > 0 ? now - this.recordingStartTime : 0;

    // Normalize BLE HR data for WS broadcast
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

    const msg: WsSensorMessage = {
      type: 'sensor',
      tsEpoch: now,
      elapsed: elapsedMs,
      profile: 'HR',
      deviceId: 0,
      data: normalized,
    };
    this.relay.broadcast(msg);

    // Update snapshot
    this._snapshot.hr = data.heartRate;
    this.accumHr(data.heartRate);
    this.emit('data', this._snapshot);

    // Write to SQLite if recording
    if (this._state === 'recording' && this._rideId !== null) {
      this.db.insertSample(this._rideId, {
        elapsedMs,
        hr: data.heartRate,
        powerW: this._snapshot.power,
        cadence: this._snapshot.cadence,
        speedKmh: this._snapshot.speed,
      });
      this.sampleCount++;
    }
  }

  // ── Stats accumulation ──

  private resetStats(): void {
    this.hrSum = 0;
    this.hrCount = 0;
    this.hrMax = 0;
    this.powerSum = 0;
    this.powerCount = 0;
    this.powerMax = 0;
    this.cadenceSum = 0;
    this.cadenceCount = 0;
    this.speedSum = 0;
    this.speedCount = 0;
    this.speedMax = 0;
    this.distanceM = 0;
    this.lastSpeedTimeMs = 0;
  }

  private accumHr(hr: number): void {
    if (this._state !== 'recording') return;
    this.hrSum += hr;
    this.hrCount++;
    if (hr > this.hrMax) this.hrMax = hr;
  }

  private accumSpeed(speed: number): void {
    if (this._state !== 'recording') return;
    this.speedSum += speed;
    this.speedCount++;
    if (speed > this.speedMax) this.speedMax = speed;

    // Integrate distance: speed (km/h) * deltaTime (hours) * 1000 (m)
    const now = Date.now();
    if (this.lastSpeedTimeMs > 0) {
      const deltaHours = (now - this.lastSpeedTimeMs) / 3_600_000;
      this.distanceM += speed * deltaHours * 1000;
    }
    this.lastSpeedTimeMs = now;
  }

  private accumCadence(cadence: number): void {
    if (this._state !== 'recording') return;
    this.cadenceSum += cadence;
    this.cadenceCount++;
  }

  private accumPower(power: number): void {
    if (this._state !== 'recording') return;
    this.powerSum += power;
    this.powerCount++;
    if (power > this.powerMax) this.powerMax = power;
  }
}
