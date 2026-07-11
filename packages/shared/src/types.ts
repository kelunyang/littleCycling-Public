/**
 * Shared type definitions for littleCycling.
 * Used by both server (recorder/replay) and web (game frontend).
 */

// ── Sensor profiles ──

export type SensorProfile = 'HR' | 'SC' | 'SPD' | 'CAD' | 'PWR';

export type SensorSource = 'ant' | 'ble';

export interface DetectedSensor {
  profile: SensorProfile | string;
  deviceId: number;
  source?: SensorSource;
  name?: string;
}

// ── Sensor data (parsed, ready for consumption) ──

export interface HrData {
  heartRate: number;
  source: SensorSource;
}

export interface ScData {
  speed: number;        // km/h
  cadence: number;      // rpm
  distance: number;     // meters (cumulative delta)
  source: SensorSource;
}

export interface PwrData {
  power: number;        // watts (instantaneous)
  leftPower?: number;   // watts (left pedal, if dual-sided)
  rightPower?: number;  // watts (right pedal, if dual-sided)
  balance?: number;     // 0-100 (left %)
  cadence?: number;     // rpm (some power meters report cadence)
  source: SensorSource;
}

export type SensorData = HrData | ScData | PwrData;

// ── JSONL record types ──

export interface SessionStartRecord {
  type: 'session_start';
  ts: string;
  tsEpoch: number;
  stickInfo: { maxChannels: number };
  sensors: DetectedSensor[];
}

export interface DataRecord {
  type: 'data';
  ts: string;
  tsEpoch: number;
  elapsed: number;
  profile: string;
  deviceId: number;
  data: Record<string, unknown>;
}

export interface SessionEndRecord {
  type: 'session_end';
  ts: string;
  tsEpoch: number;
  elapsed: number;
  totalRecords: number;
}

export type RecordLine = SessionStartRecord | DataRecord | SessionEndRecord;

// ── Live session state ──

export type LiveSessionState = 'idle' | 'scanning' | 'ready' | 'recording' | 'stopped';

// ── WebSocket message types ──

export interface WsSensorMessage {
  type: 'sensor';
  tsEpoch: number;
  elapsed: number;
  profile: string;
  deviceId: number;
  data: Record<string, unknown>;
}

export interface WsSessionStartMessage {
  type: 'session_start';
  tsEpoch: number;
  sensors: DetectedSensor[];
}

export interface WsSessionEndMessage {
  type: 'session_end';
  tsEpoch: number;
  elapsed: number;
  totalRecords: number;
}

/**
 * Host hardware capability snapshot — does this machine have a working
 * ANT+ stick / Bluetooth adapter? Determined at startScan() time.
 *
 * 'unknown'      = not probed yet (or skipped, e.g. noBleHr)
 * 'available'    = adapter opened / powered on
 * 'unavailable'  = open/init failed; check accompanying message
 */
export interface HostCapabilities {
  ant: 'unknown' | 'available' | 'unavailable';
  ble: 'unknown' | 'available' | 'unavailable';
  antMessage?: string;
  bleMessage?: string;
}

export interface WsStatusMessage {
  type: 'status';
  state: LiveSessionState;
  sensors: DetectedSensor[];
  rideId: number | null;
  capabilities: HostCapabilities;
}

// ── Game state (server-authoritative simulation) ──

/**
 * A coin placed in the world by the server simulation. `routeDistanceM` is
 * the collision axis (distance along the route); lat/lon/ele are derived by
 * the server via interpolateAlongRoute so clients render without re-deriving.
 */
export interface CoinDto {
  /** Stable numeric id (monotonic per recording). Delta ops are idempotent per id. */
  id: number;
  routeDistanceM: number;
  lat: number;
  lon: number;
  ele: number;
}

/**
 * Dynamic state of an in-flight random event. Static presentation (tint,
 * weather, darken, name) is looked up client-side from RANDOM_EVENTS_MAP by
 * `id` — only what changes frame-to-frame crosses the wire.
 */
export interface GameEventDto {
  id: string;
  state: 'active' | 'result';
  elapsedMs: number;     // time since event start
  durationMs: number;
  onTarget: boolean;
  targetWatts: number;
  /** Present only in 'result' state. */
  success?: boolean;
}

/**
 * Authoritative game state broadcast by the server simulation at ~20Hz.
 *
 * Interpolation contract (load-bearing — see plan/2026-summer.md):
 * - Clients MUST interpolate in monotonic `cumulativeDistance` space and
 *   derive position via interpolateAlongRoute(dist % totalDist). Never lerp
 *   `distanceTraveled` (wraps to 0 each lap → teleport) or raw lat/lon.
 * - `elapsed` is wall-clock ms since recordingStartTime — the same clock as
 *   WsSensorMessage.elapsed and the ride's saved durationMs (方案甲: pause
 *   does not stop it).
 * - `coins` ops are deltas keyed by CoinDto.id and must be applied
 *   idempotently; `reconcile`, when present, is the full authoritative coin
 *   set and replaces client state (sent periodically and on reconnect).
 */
export interface WsGameStateMessage {
  type: 'game_state';
  tsEpoch: number;
  elapsed: number;
  /** Physics frozen (start prompt or manual pause). Clock keeps running. */
  paused: boolean;
  /** targetDurationMs reached — simulation frozen, awaiting /api/live/stop. */
  ended: boolean;
  position: { lat: number; lon: number; ele: number; bearing: number };
  /** Monotonic meters since game start. THE interpolation axis. */
  cumulativeDistance: number;
  /** Wrapped per-lap distance (display only, derived from cumulativeDistance). */
  distanceTraveled: number;
  laps: number;
  speedKmh: number;
  /** Effective watts driving the sim — real power meter reading when present,
   *  otherwise the trainer-curve estimate from wheel speed (staleness-adjusted
   *  to 0). THE canonical power signal for ALL client-side evaluation
   *  (workout on-target, HUD power display, time-series charts). Clients must
   *  never substitute speedKmh for power. */
  powerW: number;
  /** Provenance of powerW — 'meter' when a real PWR sensor is the source,
   *  'estimated' when derived from wheel speed via the trainer power curve.
   *  Lets the UI label estimated power so riders know what the on-target
   *  judgement is based on. */
  powerSource: 'meter' | 'estimated';
  steeringAngle: number;
  /** HR zone number 1–5, null when no HR signal. redLine ≡ zone === 5. */
  zone: number | null;
  /** Coin combo multiplier (1–5). */
  combo: number;
  /** Player's authoritative coin total (self-healing scalar — not derivable from deltas). */
  coinsTotal: number;
  coins?: {
    spawned: CoinDto[];
    collected: { id: number; combo: number }[];
    removed: number[];
    reconcile?: CoinDto[];
  };
  event?: GameEventDto;
}

export type WsMessage = WsSensorMessage | WsSessionStartMessage | WsSessionEndMessage | WsStatusMessage | WsGameStateMessage;

// ── GPX route ──

export interface RoutePoint {
  lat: number;
  lon: number;
  ele: number;       // elevation in meters
  tsEpoch?: number;  // optional timestamp
}

// ── Saved route ──

export interface SavedRoute {
  id: string;           // unique identifier (e.g. slugified filename + timestamp)
  name: string;         // display name (user-editable)
  fileName: string;     // original uploaded filename
  points: RoutePoint[];
  distanceM: number;    // total distance in meters
  elevGainM: number;    // total elevation gain in meters
  createdAt: number;    // tsEpoch when imported
}

// ── EuroVelo catalog ──

export type EuroVeloStageStatus =
  | 'CERTIFIED'
  | 'DEVELOPED_SIGNED'
  | 'DEVELOPED_UNSIGNED'
  | 'PARTIALLY_DEVELOPED_SIGNED'
  | 'PARTIALLY_DEVELOPED_UNSIGNED'
  | 'UNDEVELOPED'
  | 'OTHER';

export interface CatalogStage {
  stage: number;        // 1..N within a route
  name: string;         // e.g. "Nordkapp – Honningsvåg"
  status: EuroVeloStageStatus;
  distanceKm: number;   // rounded to 0.1 km
  elevGainM: number;    // rounded to 1 m
}

export interface CatalogRace {
  id: string;           // e.g. "ev1"
  evNum: number;        // e.g. 1
  name: string;         // e.g. "EuroVelo 1 — Atlantic Coast Route"
  stages: CatalogStage[];           // empty until route is fetched on demand
  fetchedAt: number | null;         // tsEpoch when stages were last fetched
}

export interface RouteCatalog {
  updatedAt: number;
  attribution: string;  // ODbL attribution text shown in UI
  races: CatalogRace[];
}


// ── Ride history (SQLite) ──

export interface Ride {
  id: number;
  startedAt: number;       // tsEpoch ms
  endedAt?: number;
  durationMs?: number;
  distanceM: number;
  avgPowerW?: number;
  avgHr?: number;
  avgCadence?: number;
  avgSpeed?: number;
  maxHr?: number;
  maxPowerW?: number;
  maxSpeed?: number;
  totalCoins: number;
  totalLaps: number;
  /** % of hr>0 time in Z2/Z3 (0-100). Present on server-sim rides (P7+). */
  zoneSustainPct?: number;
  routeId?: string;
  routeName?: string;
  notes?: string;
  /** Sensors that were active when recording started (for FIT device_info). */
  sensors?: DetectedSensor[];
}

/**
 * `/api/live/stop` response payload — the server-authoritative ride summary
 * (P7). Every stat here is produced by the server (GameSimulation
 * accumulators for game rides; sensor-frame accumulators for recording-only
 * sessions) — the client displays it verbatim.
 */
export interface RideSummaryDto {
  rideId: number;
  sampleCount: number;
  endedAt: number;
  durationMs: number;
  /** FIT/sensor distance integral (m) — the export truth. */
  distanceM: number;
  /** Sim game distance (m) — what the player rode on screen. */
  gameDistanceM?: number;
  avgPowerW?: number;
  avgHr?: number;
  avgCadence?: number;
  avgSpeed?: number;
  maxHr?: number;
  maxPowerW?: number;
  maxSpeed?: number;
  totalCoins?: number;
  totalLaps?: number;
  /** % of hr>0 time in Z2/Z3 (0-100). */
  zoneSustainPct?: number;
}

export interface RideSample {
  elapsedMs: number;
  hr?: number;
  powerW?: number;
  cadence?: number;
  speedKmh?: number;
}

export interface ComparisonSample {
  elapsedMs: number;
  hr?: number;
  speed?: number;
  cadence?: number;
  power?: number;
}

export interface ComparisonMetrics {
  hr?: number;
  speed?: number;
  cadence?: number;
  power?: number;
}

// ── Calendar ──

export interface RideDayCount {
  date: string;   // 'YYYY-MM-DD'
  count: number;
}

// ── Debug log ──

export type DebugCategory = 'mvt' | 'chunk' | 'weather' | 'elevation' | 'terrain' | 'general';

export interface DebugLogEntry {
  ts: number;          // tsEpoch ms
  category: DebugCategory;
  message: string;
  data?: Record<string, unknown>;
}

// ── Game state ──

export type GameState = 'welcome' | 'playing' | 'ended';

// ── HR zones ──

export interface HrZone {
  zone: number;       // 1-5
  name: string;
  minPct: number;     // % of HRmax
  maxPct: number;
  coinsPerTick: number;
}
