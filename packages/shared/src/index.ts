/**
 * @littlecycling/shared — barrel export
 */

// Types
export type {
  SensorProfile,
  SensorSource,
  DetectedSensor,
  HrData,
  ScData,
  PwrData,
  SessionStartRecord,
  DataRecord,
  SessionEndRecord,
  RecordLine,
  WsSensorMessage,
  WsSessionStartMessage,
  WsSessionEndMessage,
  WsStatusMessage,
  CoinDto,
  GameEventDto,
  WsGameStateMessage,
  WsMessage,
  LiveSessionState,
  HostCapabilities,
  RoutePoint,
  SavedRoute,
  EuroVeloStageStatus,
  CatalogStage,
  CatalogRace,
  RouteCatalog,
  GameState,
  HrZone,
  Ride,
  RideSummaryDto,
  RideSample,
  ComparisonSample,
  ComparisonMetrics,
  RideDayCount,
  DebugCategory,
  DebugLogEntry,
} from './types.js';

// Constants
export {
  DEFAULT_WHEEL_CIRCUMFERENCE,
  WHEEL_CIRCUMFERENCES,
  DEFAULT_WS_PORT,
  DEFAULT_REPLAY_PORT,
  DEFAULT_SCAN_TIMEOUT,
  DEFAULT_TRAINING_DURATION,
  COIN_TICK_INTERVAL,
  IDLE_AUTOPAUSE_MS,
  IDLE_SCOLD_MS,
  IDLE_SCOLD_REPEAT_MS,
  DEFAULT_HR_MAX,
  DEFAULT_FTP,
  DEFAULT_DEV_PROXY_PORT,
  COIN_SPAWN_AHEAD_MIN,
  COIN_SPAWN_AHEAD_MAX,
  COIN_COLLECT_THRESHOLD,
  COIN_CLEANUP_BEHIND,
  COIN_SPACING,
  MAX_ANALYSIS_RIDES,
  PUBLIC_REPO_SLUG,
  PUBLIC_REPO_BRANCH,
  PUBLIC_REPO_URL,
} from './constants.js';

// Power curves
export type { PowerCurve } from './power-curves.js';
export {
  GENERIC_FLUID,
  GENERIC_MAGNETIC,
  POWER_CURVES,
  interpolatePower,
} from './power-curves.js';

// Virtual power
export {
  VirtualPowerEstimator,
  SPEED_FROM_POWER_FACTOR,
  estimateVirtualSpeedFromPower,
  estimateVirtualCadenceFromPower,
} from './virtual-power.js';

// HR zones
export {
  HR_ZONES,
  getHrZone,
  getCoinsForHr,
  isRedLine,
  hrMaxFromAge,
} from './hr-zones.js';

// Config
export type { AppConfig, LlmProvider, UpdateStatus } from './config.js';
export { DEFAULT_CONFIG } from './config.js';

// Data-source attribution (map / terrain / weather)
export type { DataSourceAttribution, AttributionLink } from './attributions.js';
export { DATA_ATTRIBUTIONS } from './attributions.js';

// Route geometry
export type { InterpolatedPosition } from './route-geometry.js';
export {
  buildCumulativeDistances,
  interpolateAlongRoute,
  totalRouteDistance,
  computeSmoothedBearing,
} from './route-geometry.js';

// GPX parser
export {
  parseGpx,
  parseTcx,
  parseRouteFile,
  calcRouteDistance,
  calcElevationGain,
} from './gpx-parser.js';

// Workouts
export type {
  WorkoutSegment,
  WorkoutProfile,
  SegmentInfo,
  SegmentResult,
  SegmentTheme,
} from './workouts.js';
export {
  ZONE_COLORS,
  WORKOUT_PROFILES,
  WORKOUT_PROFILES_MAP,
  buildWorkoutSegments,
  getSegmentAtTime,
  getSegmentTheme,
  totalWorkoutDuration,
  workoutGrade,
} from './workouts.js';

// Ride metrics（進階功率/心率分析純函式）
export type {
  Resampled1Hz,
  ZoneBucket,
  ZoneDistribution,
  PowerZoneBucket,
  PowerMetrics,
  BestEffort,
  HrDriftResult,
  ComplianceSegmentResult,
  WorkoutComplianceResult,
} from './ride-metrics.js';
export {
  resampleTo1Hz,
  zoneDistribution,
  powerMetrics,
  bestEfforts,
  hrDrift,
  workoutCompliance,
} from './ride-metrics.js';

// Game message types
export type { GameMessageType } from './game-message-types.js';
export { GAME_MESSAGE_TYPES, fillTemplate } from './game-message-types.js';

// Agentic tool-use loop 進度事件（前後端共用）
export type { AgentEvent, AgentEventPhase } from './agent-events.js';

// Training plans
export type {
  SegmentType,
  PlanSegment,
  PlanSession,
  PlanWeek,
  TrainingPlanInput,
  TrainingPlan,
  TrainingPlanSummary,
  ActivePlanState,
  PlanDayCompletion,
} from './training-plan.js';
export {
  SEGMENT_TYPE_COLORS,
  getCurrentPlanDay,
  getSessionByDay,
  planSegmentsToWorkoutSegments,
  createPlanFromInput,
  validatePlanInput,
} from './training-plan.js';

// Analysis reports（LLM 訓練分析,markdown）
export type {
  AnalysisFocus,
  AnalysisReport,
  AnalysisReportSummary,
} from './analysis.js';

// Random events
export type { RandomEventDef, RandomEventVisual, PickContext } from './random-events.js';
export {
  RANDOM_EVENTS,
  RANDOM_EVENTS_MAP,
  pickRandomEvent,
  buildEventSegment,
} from './random-events.js';

// Wind
export type { WindSample } from './wind.js';
export {
  WIND_STORM_THRESHOLD_KMH,
  WIND_STORM_DURATION_MS,
  WIND_STORM_COIN_COUNT,
  WIND_STORM_COIN_REWARD,
  TAILWIND_COMBO_MULTIPLIER,
} from './wind.js';

// Sensor parser
export {
  parseHrData,
  parseScData,
  parsePwrData,
  isDualSidedPower,
  calcSteeringAngle,
} from './sensor-parser.js';
