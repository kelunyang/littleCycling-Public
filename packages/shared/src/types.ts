import type { WorkoutSegment } from './workouts.js';
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
  /** 停止踩踏已持續毫秒數（功率與踏頻皆 0 或感測 stale）。0／缺省＝正在踩或已暫停。
   *  前端據此顯示「罵人」bubble 與自動暫停倒數 prompt。 */
  idleMs?: number;
  /** 由「停踩 30 秒」觸發的自動暫停（相對於手動 Space 暫停）。前端據此顯示
   *  「踩踏即可繼續」提示；重新踩踏時伺服器會自動恢復（見 game-simulation tick）。 */
  autoPaused?: boolean;
  coins?: {
    spawned: CoinDto[];
    collected: { id: number; combo: number }[];
    removed: number[];
    reconcile?: CoinDto[];
  };
  event?: GameEventDto;
  /** 幽靈車（P8）— 只在本場開啟幽靈模式時出現。幽靈沿自己錄下的
   *  distance-vs-time 曲線推進,時間軸對齊本場的 gameTimeMs(active-play,
   *  暫停凍結),所以玩家暫停時幽靈也停,對比公平。 */
  ghost?: {
    /** 幽靈當下的單調累積距離(m)— 前端用它經 interpolateAlongRoute 定位。 */
    distanceM: number;
    /** 由 distanceM 推導的圈數(與玩家同一 totalDist)。 */
    laps: number;
    /** 時間差(ms):幽靈「首次到達玩家目前距離」的時刻 − 玩家目前 gameTimeMs。
     *  正值 = 玩家領先(比幽靈更早到達這裡),負值 = 落後。 */
    gapMs: number;
    /** 幽靈已騎完它錄下的全程(停在終點距離,不消失)。 */
    finished: boolean;
  };
  /** 終點飛船要飄在哪裡。「終點」不等於路線終點——限時模式(FTP 30 分)是
   *  時間到就結束,真正的結束點是「用目前均速再騎完剩餘時間」的預估位置。
   *  由 server 算(CLAUDE.md:邏輯在後端),2D/3D 共用同一個值。 */
  finishTarget?: {
    /** 預估結束時的單調累積距離(m)— 與 cumulativeDistance 同軸。 */
    cumulativeM: number;
    /** cumulativeM − cumulativeDistance(m,>=0)。 */
    remainingM: number;
    /** 剩餘時間(ms,wall-clock — 結束判定的同一個鐘);freeRoam 時為 null
     *  (自由騎看板只顯示公里,不倒數;位置照樣預估)。 */
    remainingMs: number | null;
    /** true = 由剩餘時間×均速推估(會隨配速漂移);false = 路線實體終點
     *  (只在無時間目標時 — 正式流程 API 保證有時限,恆為 true)。 */
    predicted: boolean;
  };
}

// ── 幽靈車 trace(P8)──

/** 幽靈 distance-vs-time 曲線上的一點。tMs = 該次騎乘自身的 elapsed(ms)。 */
export interface GhostTracePoint {
  tMs: number;
  distM: number;
}

/**
 * 幽靈騎乘的完整 trace + 名牌資訊,開賽時一次性下發(~1 Hz,一小時 ≈ 3600 點)。
 * `source`:'recorded' = 由 ride_samples.distance_m 而來(sim 權威距離);
 * 'reintegrated' = 舊騎乘無距離欄,後端用同套物理從 power/speed 樣本重新積分。
 */
export interface GhostTraceDto {
  rideId: number;
  /** 該次騎乘開始時間(epoch ms)— 幽靈名牌顯示日期用。 */
  startedAt: number;
  source: 'recorded' | 'reintegrated';
  points: GhostTracePoint[];
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
  attribution: string;   // ODbL attribution text shown in UI
  licenseName: string;   // e.g. 'ODbL v1.0'
  licenseUrl: string;    // ODbL license text URL
  licenseDocUrl: string; // EuroVelo's "License and Disclaimer" document
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
  /** 騎後主觀備註（與 rpe 一起由 PATCH /api/rides/:id/feedback 寫入）。 */
  notes?: string;
  /** 騎後自覺強度 RPE 1-5（1=很輕鬆 5=力竭；Strava「你的感受」概念）。 */
  rpe?: number;
  /** Sensors that were active when recording started (for FIT device_info). */
  sensors?: DetectedSensor[];
  /**
   * 訓練模式（ride 開始時記錄）：workout profile id（如 'ftp_test'）、
   * `plan:<planId>:<day>`（課表訓練）；自由騎為 undefined。舊紀錄（加欄位前）
   * 一律 undefined，課表訓練可由 planId/planDay（plan_completions join）推斷。
   */
  workoutId?: string;
  /**
   * 開賽當下**決定並記錄**的訓練階段(prescribed segments)。
   *
   * 不能事後由 workoutId + durationMs 重建:profile 是百分比制的,展開結果取決
   * 於開賽選項(repeat-to-fill)與**目標**時長,而不是騎士實際騎了多久。事後重建
   * 會拿一份從未發生過的課表去評分。舊紀錄(加欄位前)為 undefined,分析端
   * 仍退回重建。
   */
  workoutSegments?: WorkoutSegment[];
  /** 由 plan_completions 反推的課表連結（僅列表 API 填入）。 */
  planId?: string;
  planDay?: number;
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
