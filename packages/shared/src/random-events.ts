/**
 * Random event definitions for freeride mode.
 *
 * Each event triggers a short training challenge (15-60s) with
 * power/cadence targets. Events are selected randomly during
 * freeride (no structured workout selected).
 */

import type { WorkoutSegment } from './workouts.js';

// ── Types ──

/** Visual effect applied during an event */
export interface RandomEventVisual {
  weatherOverride?: 'rainy' | 'snowy' | 'cloudy';
  darken?: boolean;
  screenTint?: string;           // hex color for CSS overlay
  screenTintOpacity?: number;    // 0-1
}

/** Single random event definition */
export interface RandomEventDef {
  id: string;
  name: string;                  // display name (Chinese)
  icon: string;                  // Font Awesome icon name
  color: string;                 // CSS color for HUD elements
  durationMs: number;            // challenge duration (fixed, ms)
  targetFtpPercent: number;      // target power as % of FTP
  targetCadence?: number;        // optional cadence target (rpm)
  weight: number;                // selection weight (higher = more likely)
  minElapsedMs: number;          // earliest trigger time (ms from game start)
  coinReward: number;            // bonus coins on success
  successThreshold: number;      // on-target time ratio required (0-1)
  visual: RandomEventVisual;
}

// ── Event catalog ──

export const RANDOM_EVENTS: RandomEventDef[] = [
  {
    id: 'headwind',
    name: '逆風來襲',
    icon: 'wind',
    color: '#a0c4ff',
    durationMs: 45_000,
    targetFtpPercent: 110,
    weight: 10,
    minElapsedMs: 180_000,
    coinReward: 30,
    successThreshold: 0.6,
    visual: { screenTint: '#a0c4ff', screenTintOpacity: 0.12 },
  },
  {
    id: 'flat-tire',
    name: '爆胎危機',
    icon: 'circle-xmark',
    color: '#ff6b6b',
    durationMs: 40_000,
    targetFtpPercent: 60,
    targetCadence: 90,
    weight: 8,
    minElapsedMs: 180_000,
    coinReward: 20,
    successThreshold: 0.6,
    visual: { screenTint: '#ff6b6b', screenTintOpacity: 0.10 },
  },
  {
    id: 'heavy-rain',
    name: '傾盆大雨',
    icon: 'cloud-showers-heavy',
    color: '#4a6fa5',
    durationMs: 60_000,
    targetFtpPercent: 85,
    weight: 10,
    minElapsedMs: 180_000,
    coinReward: 25,
    successThreshold: 0.6,
    visual: { weatherOverride: 'rainy', screenTint: '#4a6fa5', screenTintOpacity: 0.15 },
  },
  {
    id: 'treasure-chest',
    name: '路邊寶箱',
    icon: 'gem',
    color: '#ffd700',
    durationMs: 20_000,
    targetFtpPercent: 130,
    weight: 6,
    minElapsedMs: 240_000,
    coinReward: 50,
    successThreshold: 0.5,
    visual: { screenTint: '#ffd700', screenTintOpacity: 0.10 },
  },
  {
    id: 'police-chase',
    name: '警車追擊',
    icon: 'car-side',
    color: '#ff4444',
    durationMs: 30_000,
    targetFtpPercent: 120,
    targetCadence: 95,
    weight: 7,
    minElapsedMs: 240_000,
    coinReward: 35,
    successThreshold: 0.6,
    visual: { screenTint: '#ff4444', screenTintOpacity: 0.12 },
  },
  {
    id: 'uphill-surprise',
    name: '驚喜陡坡',
    icon: 'mountain',
    color: '#ff8c00',
    durationMs: 50_000,
    targetFtpPercent: 105,
    targetCadence: 70,
    weight: 9,
    minElapsedMs: 180_000,
    coinReward: 30,
    successThreshold: 0.6,
    visual: { screenTint: '#ff8c00', screenTintOpacity: 0.10 },
  },
  {
    id: 'tailwind',
    name: '順風加持',
    icon: 'feather',
    color: '#90ee90',
    durationMs: 45_000,
    targetFtpPercent: 70,
    targetCadence: 100,
    weight: 8,
    minElapsedMs: 180_000,
    coinReward: 15,
    successThreshold: 0.6,
    visual: { screenTint: '#90ee90', screenTintOpacity: 0.08 },
  },
  {
    id: 'night-tunnel',
    name: '暗黑隧道',
    icon: 'moon',
    color: '#1a1a2e',
    durationMs: 35_000,
    targetFtpPercent: 90,
    weight: 8,
    minElapsedMs: 180_000,
    coinReward: 25,
    successThreshold: 0.6,
    visual: { darken: true, screenTint: '#1a1a2e', screenTintOpacity: 0.25 },
  },
  {
    id: 'construction',
    name: '施工區間',
    icon: 'triangle-exclamation',
    color: '#ff8c00',
    durationMs: 40_000,
    targetFtpPercent: 95,
    weight: 8,
    minElapsedMs: 180_000,
    coinReward: 30,
    successThreshold: 0.6,
    visual: { screenTint: '#ff8c00', screenTintOpacity: 0.12 },
  },
  {
    id: 'rest-stop',
    name: '補給站',
    icon: 'mug-hot',
    color: '#00e676',
    durationMs: 30_000,
    targetFtpPercent: 50,
    weight: 6,
    minElapsedMs: 300_000,
    coinReward: 10,
    successThreshold: 0.6,
    visual: { screenTint: '#00e676', screenTintOpacity: 0.08 },
  },
];

/** Lookup map by event ID */
export const RANDOM_EVENTS_MAP: Record<string, RandomEventDef> =
  Object.fromEntries(RANDOM_EVENTS.map((e) => [e.id, e]));

// ── Helper functions ──

/**
 * Pick a random event using weighted selection.
 * Filters by minElapsedMs and cooldown set.
 * Returns null if no event is eligible.
 */
export function pickRandomEvent(
  elapsedMs: number,
  cooldownSet: Set<string>,
): RandomEventDef | null {
  const eligible = RANDOM_EVENTS.filter(
    (e) => elapsedMs >= e.minElapsedMs && !cooldownSet.has(e.id),
  );
  if (eligible.length === 0) return null;

  const totalWeight = eligible.reduce((sum, e) => sum + e.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const e of eligible) {
    roll -= e.weight;
    if (roll <= 0) return e;
  }
  return eligible[eligible.length - 1];
}

/**
 * Convert a random event into a WorkoutSegment for HUD display.
 */
export function buildEventSegment(event: RandomEventDef): WorkoutSegment {
  return {
    name: event.name,
    durationMs: event.durationMs,
    targetFtpPercent: event.targetFtpPercent,
    targetCadence: event.targetCadence,
    color: event.color,
  };
}
