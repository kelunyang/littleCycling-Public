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

export interface WsStatusMessage {
  type: 'status';
  state: LiveSessionState;
  sensors: DetectedSensor[];
  rideId: number | null;
}

export type WsMessage = WsSensorMessage | WsSessionStartMessage | WsSessionEndMessage | WsStatusMessage;

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

// ── Route catalog (EuroVelo stages) ──

export interface CatalogStage {
  stage: number;        // stage number (1-based)
  name: string;         // e.g. "From Basel to Karlsruhe"
  distanceKm: number;
  elevGainM: number;
  gpxId: number;        // EuroVelo GPX download ID for /route/get-gpx/{gpxId}
}

export interface CatalogRace {
  id: string;           // e.g. "ev15"
  name: string;         // e.g. "EuroVelo 15 — Rhine Cycle Route"
  year?: number;        // optional (EuroVelo routes are not year-based)
  stages: CatalogStage[];
}

export interface RouteCatalog {
  updatedAt: number;    // tsEpoch ms — when this catalog was last updated
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
  routeId?: string;
  routeName?: string;
  notes?: string;
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
