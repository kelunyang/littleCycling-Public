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
  WsMessage,
  LiveSessionState,
  RoutePoint,
  SavedRoute,
  CatalogStage,
  CatalogRace,
  RouteCatalog,
  GameState,
  HrZone,
  Ride,
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
  DEFAULT_HR_MAX,
  DEFAULT_FTP,
  DEFAULT_DEV_PROXY_PORT,
  COIN_SPAWN_AHEAD_MIN,
  COIN_SPAWN_AHEAD_MAX,
  COIN_COLLECT_THRESHOLD,
  COIN_CLEANUP_BEHIND,
  COIN_SPACING,
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
export { VirtualPowerEstimator } from './virtual-power.js';

// HR zones
export {
  HR_ZONES,
  getHrZone,
  getCoinsForHr,
  isRedLine,
} from './hr-zones.js';

// Config
export type { AppConfig, LlmProvider } from './config.js';
export { DEFAULT_CONFIG } from './config.js';

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
} from './workouts.js';
export {
  ZONE_COLORS,
  WORKOUT_PROFILES,
  WORKOUT_PROFILES_MAP,
  buildWorkoutSegments,
  getSegmentAtTime,
  totalWorkoutDuration,
  workoutGrade,
} from './workouts.js';

// Game message types
export type { GameMessageType } from './game-message-types.js';
export { GAME_MESSAGE_TYPES, fillTemplate } from './game-message-types.js';

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

// Random events
export type { RandomEventDef, RandomEventVisual } from './random-events.js';
export {
  RANDOM_EVENTS,
  RANDOM_EVENTS_MAP,
  pickRandomEvent,
  buildEventSegment,
} from './random-events.js';

// Sensor parser
export {
  parseHrData,
  parseScData,
  parsePwrData,
  isDualSidedPower,
  calcSteeringAngle,
} from './sensor-parser.js';
