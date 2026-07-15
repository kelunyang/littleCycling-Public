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

/** 停止踩踏多久（ms）後自動暫停遊戲（功率與踏頻皆 0 或感測 stale）。 */
export const IDLE_AUTOPAUSE_MS = 30_000;
/** 停止踩踏多久（ms）後開始跳「罵人」訊息。 */
export const IDLE_SCOLD_MS = 3_000;
/** 開始罵之後，每隔多久（ms）再撈叨一次。 */
export const IDLE_SCOLD_REPEAT_MS = 10_000;

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

// ── AI 訓練分析 ──

/**
 * user 一次最多可指定幾筆騎乘餵給 AI 分析。每筆騎乘 agent 都會另外呼叫工具
 * 查詳細數據,勾太多會拖慢分析且噴 token;AI 需要更多背景可自行用工具查詢。
 */
export const MAX_ANALYSIS_RIDES = 3;

// ── Public release / update-check ──

/** GitHub "owner/repo" slug of the public release repo, polled for updates. */
export const PUBLIC_REPO_SLUG = 'kelunyang/littleCycling-Public';

/** Default branch of the public repo (publish-public.sh pushes to main). */
export const PUBLIC_REPO_BRANCH = 'main';

/** Human-facing URL of the public repo (shown in the update prompt). */
export const PUBLIC_REPO_URL = 'https://github.com/kelunyang/littleCycling-Public';
