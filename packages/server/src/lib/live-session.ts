/**
 * LiveSession — sensor connection + recording core.
 * Extracted from recorder.ts to be reused by both server.ts and recorder CLI.
 *
 * Lifecycle:
 *   idle → startScan() → scanning → ready → startRecording() → recording → stopRecording() → ready
 *   Any state → shutdown() → stopped
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import { AntConnection } from './ant-connection.js';
import { SensorManager } from './sensor-manager.js';
import { BleConnection, type BleHrDevice, type BleHrData } from './ble-connection.js';
import { RideDatabase, type EndRideSummary } from './database.js';
import { WsRelay } from './ws-relay.js';
import { DataWriter } from './data-writer.js';
import { GameSimulation, type GameSimConfig } from './game-simulation.js';
import { ServerWeatherSource } from './server-weather.js';
import { MockSensorSource, MOCK_SENSORS } from './mock-sensor.js';
import { ReplaySensorSource } from './replay-sensor.js';
import type { ConfigStore } from './config-store.js';
import type { DetectedSensor, RoutePoint, WsSensorMessage, WsSessionStartMessage, WsSessionEndMessage, WsStatusMessage, LiveSessionState, HostCapabilities } from '@littlecycling/shared';
import {
  estimateVirtualSpeedFromPower,
  estimateVirtualCadenceFromPower,
} from '@littlecycling/shared';

export interface LiveSessionOptions {
  relay: WsRelay;
  db: RideDatabase;
  /** Skip BLE heart rate scanning (default: false) */
  noBleHr?: boolean;
  /** Sensor scan timeout in ms (default: 30000) */
  scanTimeout?: number;
  /** Enable debug logging */
  debug?: boolean;
  /**
   * Data directory root. Required for raw-frame JSONL persistence
   * (files land under `<dataDir>/sessions/`). If omitted, raw-frame
   * persistence is disabled regardless of the config flag.
   */
  dataDir?: string;
  /**
   * Config source consulted at startRecording-time so toggling
   * `recording.persistRawFrames` doesn't require a server restart.
   */
  configStore?: ConfigStore;
  /**
   * Dev mode: skip real ANT+/BLE probing and stream synthetic sensor data
   * (server `--mock` flag). Lets the game simulation run without hardware.
   */
  mock?: boolean;
  /**
   * Test/replay mode: skip real ANT+/BLE probing and drive the simulation
   * from a recorded JSONL ride (server `--replay <file>` flag). Frames flow
   * through the same `handleAntData` path as live sensors, so the game runs
   * on real captured data. Takes precedence over `mock` when both are set.
   */
  replayFile?: string;
  /** Replay playback multiplier (default 1.0). */
  replaySpeed?: number;
  /** Loop the replay recording when it ends (default false). */
  replayLoop?: boolean;
}

export interface LiveSensorSnapshot {
  hr?: number;
  speed?: number;    // km/h
  cadence?: number;  // rpm
  power?: number;    // watts
  /** Dual-sided power meter fields — feed free-roam steering in the sim. */
  leftPower?: number;
  rightPower?: number;
}

export interface RideSummary extends EndRideSummary {
  rideId: number;
  sampleCount: number;
  /** Sim game distance (m) — what the player rode on screen. Reported next
   *  to `distanceM` (the FIT/sensor integral), never merged with it. */
  gameDistanceM?: number;
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
  private mock: boolean;
  private mockSource: MockSensorSource | null = null;
  private replayFile: string | undefined;
  private replaySpeed: number;
  private replayLoop: boolean;
  private replaySource: ReplaySensorSource | null = null;

  // ANT+
  private antConnection: AntConnection | null = null;
  private sensorMgr: SensorManager | null = null;
  private channel: any = null;

  // BLE
  private ble: BleConnection | null = null;
  private bleDevice: BleHrDevice | undefined;

  // Detected sensors
  private _detectedSensors: DetectedSensor[] = [];

  // Host hardware capabilities (probed during startScan)
  private _capabilities: HostCapabilities = { ant: 'unknown', ble: 'unknown' };

  // Recording state
  private _rideId: number | null = null;
  private recordingStartTime: number = 0;
  private sampleCount: number = 0;

  // Live snapshot for console display + game simulation input
  private _snapshot: LiveSensorSnapshot = {};
  // Epoch ms of the last received sensor frame (sim staleness detection)
  private lastDataAt = 0;

  // Server-authoritative game simulation (composition: one per recording,
  // present only when the recording was started with game options)
  private gameSim: GameSimulation | null = null;
  // Server-side wind fetch feeding the sim's random-event wind gate
  private weatherSource: ServerWeatherSource | null = null;

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

  // Raw-frame JSONL writer (created per recording when persistRawFrames is on)
  private rawWriter: DataWriter | null = null;
  private dataDir: string | undefined;
  private configStore: ConfigStore | undefined;

  constructor(options: LiveSessionOptions) {
    super();
    this.relay = options.relay;
    this.db = options.db;
    this.noBleHr = options.noBleHr ?? false;
    this.scanTimeout = options.scanTimeout ?? 30000;
    this.debug = options.debug ?? false;
    this.dataDir = options.dataDir;
    this.configStore = options.configStore;
    this.mock = options.mock ?? false;
    this.replayFile = options.replayFile;
    this.replaySpeed = options.replaySpeed ?? 1;
    this.replayLoop = options.replayLoop ?? false;
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

  get capabilities(): HostCapabilities {
    return { ...this._capabilities };
  }

  /**
   * Update a single capability and broadcast the new status so listening
   * clients can show probe results in real time (rather than only after
   * scanning completes).
   */
  private setCapability(
    kind: 'ant' | 'ble',
    state: 'available' | 'unavailable',
    message?: string,
  ): void {
    this._capabilities[kind] = state;
    if (kind === 'ant') {
      this._capabilities.antMessage = message;
    } else {
      this._capabilities.bleMessage = message;
    }
    this.relay.broadcast(this.getStatusMessage());
  }

  /** Build a WsStatusMessage reflecting current session state. */
  getStatusMessage(): WsStatusMessage {
    return {
      type: 'status',
      state: this._state,
      sensors: this._detectedSensors,
      rideId: this._rideId,
      capabilities: { ...this._capabilities },
    };
  }

  // ── Scan ──

  async startScan(): Promise<DetectedSensor[]> {
    if (this._state !== 'idle' && this._state !== 'ready') {
      throw new Error(`Cannot scan in state: ${this._state}`);
    }

    this.setState('scanning');
    this._detectedSensors = [];

    // Replay mode: skip all hardware probing, advertise the recording's own
    // sensors, and start streaming the captured frames immediately (same
    // scan-time streaming as real sensors, so the welcome screen shows live
    // values before recording begins). Checked before mock so `--replay`
    // wins if both flags are somehow set.
    if (this.replayFile) {
      this._capabilities = { ant: 'available', ble: 'available' };
      this._detectedSensors = await this.startReplaySource();
      this.setState('ready');
      const sessionStartMsg: WsSessionStartMessage = {
        type: 'session_start',
        tsEpoch: Date.now(),
        sensors: this._detectedSensors,
      };
      this.relay.broadcast(sessionStartMsg);
      console.log(`[live] replay sensor source active (--replay ${this.replayFile})`);
      return this._detectedSensors;
    }

    // Mock mode: skip all hardware probing, advertise synthetic sensors, and
    // start streaming immediately (real sensors also stream from scan-time,
    // so the welcome screen shows live values before recording begins).
    if (this.mock) {
      this._capabilities = { ant: 'available', ble: 'available' };
      this._detectedSensors = MOCK_SENSORS.map((s) => ({ ...s }));
      this.startMockSource();
      this.setState('ready');
      const sessionStartMsg: WsSessionStartMessage = {
        type: 'session_start',
        tsEpoch: Date.now(),
        sensors: this._detectedSensors,
      };
      this.relay.broadcast(sessionStartMsg);
      console.log('[live] mock sensor source active (--mock)');
      return this._detectedSensors;
    }

    // ANT+ stick
    this.antConnection = new AntConnection({ startupTimeout: 5000, debug: this.debug });

    try {
      const stickInfo = await this.antConnection.open();
      this.setCapability('ant', 'available');
      if (this.debug) {
        console.log(`[live] ANT+ stick #${stickInfo.deviceNumber}, channels: ${stickInfo.maxChannels}`);
      }

      this.channel = this.antConnection.getChannel();
      this.sensorMgr = new SensorManager(this.channel, {
        scanTimeout: this.scanTimeout,
        onDetect: (sensor) => {
          this._detectedSensors.push({ ...sensor, source: 'ant' });
          this.emit('detect', { ...sensor, source: 'ant' });
          // Push the updated sensor list to all WS clients. Without this,
          // a sensor turned on after the initial scan window completes
          // never appears in the frontend's `sensorStore.sensors` — its
          // data still streams (so live values flow), but the sensor
          // *list* stays empty and the welcome view shows "Connect a
          // sensor to continue".
          this.relay.broadcast(this.getStatusMessage());
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
      this.setCapability('ant', 'unavailable', err?.message ?? String(err));
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
        this.setCapability('ble', 'available');
        await this.ble.scan((device) => {
          if (!this.bleDevice) {
            this.bleDevice = device;
            this.ble!.stopScan();
          }
        });
      } catch (err: any) {
        this.setCapability('ble', 'unavailable', err?.message ?? String(err));
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
        this.relay.broadcast(this.getStatusMessage());
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

  async startRecording(opts: {
    routeId?: string;
    routeName?: string;
    /**
     * Game simulation inputs. When present, a GameSimulation runs for the
     * lifetime of this recording and broadcasts `game_state` at 20Hz.
     * Absent for recording-only sessions (recorder CLI, no active route).
     */
    game?: { routePoints: RoutePoint[]; config: GameSimConfig };
  } = {}): Promise<number> {
    // Self-heal: a previous ride was never stopped (tab closed and the
    // sendBeacon stop was lost, client crashed, stop endpoint failed…).
    // Finalize the orphaned ride with whatever stats it accumulated instead
    // of blocking every future ride until a server restart.
    if (this._state === 'recording') {
      console.warn(
        `[live] start requested while ride ${this._rideId} is still recording — auto-stopping the orphaned ride`,
      );
      try {
        await this.stopRecording();
      } catch (err: any) {
        // stopRecording failed mid-way (e.g. DB write) — force the session
        // back to a clean 'ready' so the new ride can still start.
        console.warn(`[live] auto-stop failed: ${err?.message ?? err} — forcing state to ready`);
        this.gameSim?.stop();
        this.gameSim = null;
        this.weatherSource?.stop();
        this.weatherSource = null;
        await this.closeRawWriter();
        this._rideId = null;
        this.setState('ready');
      }
    }

    if (this._state !== 'ready') {
      throw new Error(`Cannot start recording in state: ${this._state}`);
    }

    const now = Date.now();
    this._rideId = this.db.createRide({
      startedAt: now,
      routeId: opts.routeId,
      routeName: opts.routeName,
      // Snapshot of which sensors were active at start; used by the FIT
      // exporter to emit DEVICE_INFO messages.
      sensors: [...this._detectedSensors],
    });
    this.recordingStartTime = now;
    this.lastSpeedTimeMs = now;
    this.sampleCount = 0;
    this.resetStats();

    // Open raw-frame JSONL writer if enabled. One file per ride lets us
    // replay/repair a session later without depending on whatever cooked
    // values made it into the SQLite samples table.
    this.openRawWriter(this._rideId, now);

    // Game simulation shares the recording's wall clock (single authoritative
    // clock: recordingStartTime) and reads sensors via the injected getter.
    if (opts.game) {
      // Server-side wind for the random-event wind gate — fetched for the
      // route's start coordinate. Cosmetic wind (renderer/audio) stays on
      // the client.
      const start = opts.game.routePoints[0];
      this.weatherSource = new ServerWeatherSource(start.lat, start.lon, this.debug);
      this.weatherSource.start();

      this.gameSim = new GameSimulation({
        routePoints: opts.game.routePoints,
        config: opts.game.config,
        relay: this.relay,
        getSnapshot: () => this._snapshot,
        getLastDataAt: () => this.lastDataAt,
        recordingStartTime: now,
        getWind: () => this.weatherSource!.get(),
      });
      this.gameSim.start();
    }

    this.setState('recording');
    return this._rideId;
  }

  /**
   * Pause/resume the game simulation (manual pause — Space key via REST).
   * Recording and the clock are unaffected (方案甲); only physics freeze.
   */
  setGamePaused(paused: boolean): void {
    if (!this.gameSim) {
      throw new Error('No game simulation running');
    }
    this.gameSim.setPaused(paused);
  }

  /**
   * Ask the sim to include a full coin reconcile in its next broadcast —
   * called on every WS client (re)connect so late joiners converge
   * immediately. No-op when no game is running.
   */
  requestGameReconcile(): void {
    this.gameSim?.requestReconcile();
  }

  private openRawWriter(rideId: number, startedAt: number): void {
    this.rawWriter = null;
    if (!this.dataDir) return;
    const cfg = this.configStore?.get();
    if (cfg && cfg.recording?.persistRawFrames === false) return;
    try {
      const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = path.join(this.dataDir, 'sessions', `ride-${rideId}-${stamp}.jsonl`);
      const writer = new DataWriter(file);
      writer.open();
      writer.writeSessionStart(
        { maxChannels: 0 },
        this._detectedSensors.map((s) => ({ profile: s.profile, deviceId: s.deviceId })),
      );
      this.rawWriter = writer;
      if (this.debug) {
        console.log(`[live] raw-frame log: ${file}`);
      }
    } catch (err: any) {
      // Persistence failure must not block recording.
      console.warn(`[live] failed to open raw-frame log: ${err?.message ?? err}`);
      this.rawWriter = null;
    }
  }

  private async closeRawWriter(): Promise<void> {
    if (!this.rawWriter) return;
    const writer = this.rawWriter;
    this.rawWriter = null;
    try {
      await writer.close();
    } catch (err: any) {
      console.warn(`[live] failed to close raw-frame log: ${err?.message ?? err}`);
    }
  }

  /**
   * Ends the recording and persists the ride summary.
   *
   * Summary authority (P7): when a game simulation ran, ITS accumulators are
   * the source of truth for every game-visible stat — coins, laps,
   * zoneSustain, and the dt-weighted avg/max HR/power/cadence/speed. The
   * per-sensor-frame accumulators below remain only as the fallback for
   * recording-only sessions (recorder CLI, no game), where no sim exists.
   *
   * Clock/authority consistency (plan risk #3) — three integrators, one
   * anchor:
   *  - `durationMs` / sim `elapsed` / WsSensorMessage `elapsed` all measure
   *    `Date.now() - recordingStartTime` (方案甲: pause never stops it).
   *  - FIT `distanceM` stays the sensor-speed integral on that same wall
   *    clock (accumSpeed) — the export truth, never mixed with game distance.
   *  - `gameDistanceM` is the sim's monotonic cumulativeDistance — the game
   *    truth (laps = floor(gameDistance / lapLength) by construction).
   *
   * @param finalStats Legacy client-supplied totals — used ONLY when no game
   *   simulation ran; ignored otherwise (server-authoritative).
   */
  async stopRecording(finalStats?: { totalCoins?: number; totalLaps?: number }): Promise<RideSummary> {
    if (this._state !== 'recording' || this._rideId === null) {
      throw new Error(`Cannot stop recording in state: ${this._state}`);
    }

    // Halt the game simulation first so no game_state frame is emitted after
    // the summary's endedAt timestamp; read its summary before dropping it.
    const gameSummary = this.gameSim?.summary;
    if (this.gameSim) {
      this.gameSim.stop();
      this.gameSim = null;
    }
    if (this.weatherSource) {
      this.weatherSource.stop();
      this.weatherSource = null;
    }

    const now = Date.now();
    const durationMs = now - this.recordingStartTime;

    const summary: EndRideSummary = gameSummary
      ? {
          endedAt: now,
          durationMs,
          distanceM: Math.round(this.distanceM),
          avgPowerW: gameSummary.avgPowerW,
          avgHr: gameSummary.avgHr,
          avgCadence: gameSummary.avgCadence,
          avgSpeed: gameSummary.avgSpeed,
          maxHr: gameSummary.maxHr,
          maxPowerW: gameSummary.maxPowerW,
          maxSpeed: gameSummary.maxSpeed,
          totalCoins: gameSummary.totalCoins,
          totalLaps: gameSummary.totalLaps,
          zoneSustainPct: gameSummary.zoneSustainPct,
        }
      : {
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
          totalCoins: finalStats?.totalCoins,
          totalLaps: finalStats?.totalLaps,
        };

    this.db.endRide(this._rideId, summary);

    const result: RideSummary = {
      ...summary,
      rideId: this._rideId,
      sampleCount: this.sampleCount,
      gameDistanceM: gameSummary ? Math.round(gameSummary.gameDistanceM) : undefined,
    };

    // Flush + close the raw-frame JSONL before clearing the ride id so
    // the file is durable on disk even if the process crashes immediately
    // after the user ends the ride.
    await this.closeRawWriter();

    this._rideId = null;
    this.setState('ready');

    return result;
  }

  // ── Rescan ──

  /**
   * Tear down the current scan/connections and start a fresh scan. Needed
   * because the BLE scan stops at the first device found and never
   * resumes — without rescan, an HR strap powered on after the boot-time
   * scan window is invisible. ANT+ keeps detecting indefinitely, but a
   * rescan also clears any stale detections so the resulting list is
   * accurate.
   *
   * Refuses while a recording is in flight so we don't leak the rideId
   * or interrupt sample collection.
   */
  async rescan(): Promise<DetectedSensor[]> {
    if (this._state === 'recording') {
      throw new Error('Cannot rescan while recording');
    }
    if (this._state === 'scanning') {
      throw new Error('Already scanning');
    }

    if (this.sensorMgr) {
      this.sensorMgr.stopScanning();
      this.sensorMgr = null;
    }
    if (this.ble) {
      try { await this.ble.disconnect(); } catch { /* ignore */ }
      this.ble = null;
    }
    this.bleDevice = undefined;
    if (this.antConnection) {
      try { await this.antConnection.close(); } catch { /* ignore */ }
      this.antConnection = null;
    }
    this.channel = null;

    this._detectedSensors = [];
    this._capabilities = { ant: 'unknown', ble: 'unknown' };
    // setState('idle') broadcasts the cleared sensor list so the UI shows
    // "scanning…" with an empty list while the rescan runs.
    this.setState('idle');

    return this.startScan();
  }

  // ── Shutdown ──

  async shutdown(): Promise<void> {
    if (this._state === 'recording' && this._rideId !== null) {
      await this.stopRecording();
    }

    // Belt-and-braces in case stopRecording was skipped (e.g. crash path).
    await this.closeRawWriter();

    if (this.mockSource) {
      this.mockSource.stop();
      this.mockSource = null;
    }
    if (this.replaySource) {
      this.replaySource.stop();
      this.replaySource = null;
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

  /** True if a real wheel-speed sensor (SC or SPD) was detected during scan. */
  private hasSpeedSensor(): boolean {
    return this._detectedSensors.some(
      (s) => s.profile === 'SC' || s.profile === 'SPD',
    );
  }

  /** True if a real cadence sensor (SC or CAD) was detected during scan. */
  private hasCadenceSensor(): boolean {
    return this._detectedSensors.some(
      (s) => s.profile === 'SC' || s.profile === 'CAD',
    );
  }

  // ── Internal data handling ──

  /**
   * Start the synthetic sensor stream, routing frames through the same
   * `handleAntData` path real ANT+ frames take. Idempotent.
   */
  private startMockSource(): void {
    if (this.mockSource) return;
    this.mockSource = new MockSensorSource({
      onFrame: (profile, deviceId, data) => this.handleAntData(profile, deviceId, data),
    });
    this.mockSource.start();
  }

  /**
   * Start replaying a recorded ride, routing frames through the same
   * `handleAntData` path real ANT+ frames take. Reads the recording's
   * advertised sensor list first (for the scan phase) and returns it.
   * Idempotent — a second call returns the already-detected sensors.
   */
  private async startReplaySource(): Promise<DetectedSensor[]> {
    if (this.replaySource) return this._detectedSensors;
    const source = new ReplaySensorSource({
      filePath: this.replayFile!,
      speed: this.replaySpeed,
      loop: this.replayLoop,
      onFrame: (profile, deviceId, data) => this.handleAntData(profile, deviceId, data),
    });
    const sensors = await source.readSensors();
    this.replaySource = source;
    source.start();
    return sensors;
  }

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
    this.lastDataAt = now;
    const elapsedMs = this.recordingStartTime > 0 ? now - this.recordingStartTime : 0;

    // Persist the raw frame *before* any field-specific cooking so the
    // JSONL contains exactly what the sensor sent (every field, not just
    // the four we extract into snapshots). This is the audit/replay log.
    if (this.rawWriter && this._state === 'recording') {
      try {
        this.rawWriter.writeData(profile, deviceId, data as Record<string, unknown>);
      } catch (err: any) {
        console.warn(`[live] raw-frame write failed: ${err?.message ?? err}`);
      }
    }

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
    if (profile === 'PWR') {
      // Different power meters populate different fields depending on the
      // ANT+ message page they emit (0x10 power-only fills `Power`; torque
      // pages 0x11/0x12 fill `CalculatedPower`; some libs surface
      // `InstantaneousPower`). Match `parsePwrData`'s priority so the
      // server doesn't silently record 0 watts when the meter is actually
      // sending data through one of the alternative fields.
      const rawPower = data.InstantaneousPower ?? data.CalculatedPower ?? data.Power;
      const watts = typeof rawPower === 'number' && Number.isFinite(rawPower)
        ? rawPower
        : null;
      if (watts != null) {
        this._snapshot.power = watts;
        this.accumPower(watts);

        // Dual-sided power fields for free-roam steering (same field
        // priority as parsePwrData so client and sim agree).
        const left = (data.LeftPower ?? data.LeftPedalPower) as number | undefined;
        const right = (data.RightPower ?? data.RightPedalPower) as number | undefined;
        if (left != null && Number.isFinite(left)) this._snapshot.leftPower = left;
        if (right != null && Number.isFinite(right)) this._snapshot.rightPower = right;

        // Some power meters report cadence directly; prefer real cadence
        // over virtual whenever it's present.
        const pmCadence = (data.Cadence ?? data.CalculatedCadence) as number | undefined;
        if (pmCadence != null && Number.isFinite(pmCadence)) {
          this._snapshot.cadence = pmCadence;
          this.accumCadence(pmCadence);
        }

        // When no real wheel-speed sensor is connected, derive a virtual
        // wheel speed from power so the rider sees a reading in the HUD,
        // SQLite samples are populated, and the FIT export accumulates
        // distance (Strava treats a zero-distance FIT as empty).
        if (!this.hasSpeedSensor()) {
          const virtSpeed = estimateVirtualSpeedFromPower(watts);
          this._snapshot.speed = virtSpeed;
          this.accumSpeed(virtSpeed);
          // Annotate the broadcast so the client can label the value as
          // virtual rather than measured.
          (msg.data as Record<string, unknown>).VirtualSpeed = virtSpeed;
        }

        // Same idea for cadence when neither a cadence sensor nor a
        // cadence-reporting power meter is available.
        if (this._snapshot.cadence == null && !this.hasCadenceSensor()) {
          const virtCadence = estimateVirtualCadenceFromPower(watts);
          this._snapshot.cadence = virtCadence;
          this.accumCadence(virtCadence);
          (msg.data as Record<string, unknown>).VirtualCadence = virtCadence;
        }
      }
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
    this.lastDataAt = now;
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

    // Persist normalized BLE HR frame to the raw-frame log alongside ANT+
    // frames so replay tooling sees one unified stream per ride.
    if (this.rawWriter && this._state === 'recording') {
      try {
        this.rawWriter.writeData('HR', 0, normalized);
      } catch (err: any) {
        console.warn(`[live] raw-frame write failed: ${err?.message ?? err}`);
      }
    }

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
