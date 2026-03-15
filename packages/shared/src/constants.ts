/**
 * Shared constants for littleCycling.
 */

/** Default wheel circumference in meters (700x25c) */
export const DEFAULT_WHEEL_CIRCUMFERENCE = 2.105;

/** Common wheel circumferences by tire size (meters) */
export const WHEEL_CIRCUMFERENCES: Record<string, number> = {
  '700x23c': 2.096,
  '700x25c': 2.105,
  '700x28c': 2.136,
  '700x32c': 2.155,
  '700x35c': 2.168,
  '26x1.5': 2.026,
  '26x2.0': 2.055,
  '27.5x2.0': 2.089,
  '29x2.0': 2.288,
};

/** Default WebSocket server port */
export const DEFAULT_WS_PORT = 8765;

/** Default Replay WebSocket port (avoids collision with dev server) */
export const DEFAULT_REPLAY_PORT = 8766;

/** Default dev proxy port (bridges Vite to either live or replay WS upstream) */
export const DEFAULT_DEV_PROXY_PORT = 8770;

/** Default sensor scan timeout (ms) */
export const DEFAULT_SCAN_TIMEOUT = 30000;

/** Default training duration (ms) — 30 minutes */
export const DEFAULT_TRAINING_DURATION = 30 * 60 * 1000;

/** Coin award interval (ms) — award coins every N seconds while in target zone */
export const COIN_TICK_INTERVAL = 5000;

/** Default HRmax */
export const DEFAULT_HR_MAX = 190;

/** Default FTP (watts) */
export const DEFAULT_FTP = 200;

// ── 3D Coin spawning constants ──

/** Minimum distance ahead of ball to spawn coins (meters) */
export const COIN_SPAWN_AHEAD_MIN = 20;

/** Maximum distance ahead of ball to spawn coins (meters) */
export const COIN_SPAWN_AHEAD_MAX = 200;

/** Distance threshold for collecting a coin (meters) */
export const COIN_COLLECT_THRESHOLD = 5;

/** Distance behind ball to remove uncollected coins (meters) */
export const COIN_CLEANUP_BEHIND = 10;

/** Coin spacing by HR zone (meters between coins) */
export const COIN_SPACING: Record<number, number> = {
  2: 100,
  3: 50,
  4: 30,
};
