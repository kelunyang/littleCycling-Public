/**
 * FTP-based structured workout definitions.
 *
 * Each workout profile defines segments with percentage-based durations
 * that scale to the user's chosen total training time.
 */

// ── Types ──

/** Single workout segment */
export interface WorkoutSegment {
  name: string;              // "Warm Up", "Interval 1", "Recovery"
  durationMs: number;        // segment duration in ms
  targetFtpPercent: number;  // target power as % of FTP (100 = FTP)
  targetCadence?: number;    // optional cadence target (rpm)
  color: string;             // progress bar color (HEX)
  hrMin?: number;            // optional HR target floor (bpm) — used by training plans
  hrMax?: number;            // optional HR target ceiling (bpm) — used by training plans
}

/** Internal segment template (percentage-based duration) */
interface SegmentTemplate {
  name: string;
  durationPct: number;       // fraction of total duration (0-1)
  targetFtpPercent: number;
  targetCadence?: number;
  color: string;
}

/** Workout profile definition */
export interface WorkoutProfile {
  id: string;
  name: string;
  description: string;
  templates: SegmentTemplate[];
}

/** Result of querying current segment at a given time */
export interface SegmentInfo {
  segment: WorkoutSegment;
  segmentIndex: number;
  segmentElapsed: number;    // ms elapsed within this segment
  segmentRemaining: number;  // ms remaining in this segment
}

/** Per-segment training result */
export interface SegmentResult {
  segment: WorkoutSegment;
  avgPower: number;          // actual average power during this segment
  targetPower: number;       // target watts
  timeOnTargetMs: number;    // time within ±10% of target
  totalTimeMs: number;       // segment duration
}

// ── Zone colors (Cyberpunk style) ──

export const ZONE_COLORS = {
  warmup:     '#4a90d9',  // cold blue
  recovery:   '#00e676',  // neon green
  endurance:  '#66bb6a',  // steady green
  sweetSpot:  '#ffab00',  // amber yellow
  threshold:  '#ff6d00',  // neon orange
  vo2max:     '#ff1744',  // alarm red
  sprint:     '#d500f9',  // neon purple
} as const;

// ── Built-in workout profiles ──

export const WORKOUT_PROFILES: WorkoutProfile[] = [
  {
    id: 'sweet-spot',
    name: 'Sweet Spot',
    description: 'Sustained efforts at 88-94% FTP to build aerobic fitness',
    templates: [
      { name: 'Warm Up',     durationPct: 0.15, targetFtpPercent: 55,  color: ZONE_COLORS.warmup },
      { name: 'SST Block 1', durationPct: 0.25, targetFtpPercent: 90,  color: ZONE_COLORS.sweetSpot },
      { name: 'Recovery',    durationPct: 0.08, targetFtpPercent: 50,  color: ZONE_COLORS.recovery },
      { name: 'SST Block 2', durationPct: 0.25, targetFtpPercent: 92,  color: ZONE_COLORS.sweetSpot },
      { name: 'Recovery',    durationPct: 0.08, targetFtpPercent: 50,  color: ZONE_COLORS.recovery },
      { name: 'SST Block 3', durationPct: 0.10, targetFtpPercent: 94,  color: ZONE_COLORS.sweetSpot },
      { name: 'Cool Down',   durationPct: 0.09, targetFtpPercent: 45,  color: ZONE_COLORS.warmup },
    ],
  },
  {
    id: 'vo2max',
    name: 'VO2max Intervals',
    description: '5 × 3min at 120% FTP with equal rest — maximal aerobic capacity',
    templates: [
      { name: 'Warm Up',     durationPct: 0.15, targetFtpPercent: 55, color: ZONE_COLORS.warmup },
      { name: 'Interval 1',  durationPct: 0.10, targetFtpPercent: 120, color: ZONE_COLORS.vo2max },
      { name: 'Recovery',    durationPct: 0.10, targetFtpPercent: 45, color: ZONE_COLORS.recovery },
      { name: 'Interval 2',  durationPct: 0.10, targetFtpPercent: 120, color: ZONE_COLORS.vo2max },
      { name: 'Recovery',    durationPct: 0.10, targetFtpPercent: 45, color: ZONE_COLORS.recovery },
      { name: 'Interval 3',  durationPct: 0.10, targetFtpPercent: 120, color: ZONE_COLORS.vo2max },
      { name: 'Recovery',    durationPct: 0.10, targetFtpPercent: 45, color: ZONE_COLORS.recovery },
      { name: 'Interval 4',  durationPct: 0.10, targetFtpPercent: 120, color: ZONE_COLORS.vo2max },
      { name: 'Cool Down',   durationPct: 0.05, targetFtpPercent: 40, color: ZONE_COLORS.warmup },
    ],
  },
  {
    id: 'endurance',
    name: 'Endurance',
    description: 'Long steady ride at 65-75% FTP — aerobic base building',
    templates: [
      { name: 'Warm Up',     durationPct: 0.10, targetFtpPercent: 55, color: ZONE_COLORS.warmup },
      { name: 'Endurance',   durationPct: 0.80, targetFtpPercent: 70, color: ZONE_COLORS.endurance, targetCadence: 85 },
      { name: 'Cool Down',   durationPct: 0.10, targetFtpPercent: 45, color: ZONE_COLORS.warmup },
    ],
  },
  {
    id: 'ftp-test',
    name: 'FTP Test (20min)',
    description: '20-minute all-out effort to estimate FTP (result × 0.95)',
    templates: [
      { name: 'Warm Up',     durationPct: 0.20, targetFtpPercent: 55, color: ZONE_COLORS.warmup },
      { name: 'Openers',     durationPct: 0.10, targetFtpPercent: 85, color: ZONE_COLORS.threshold },
      { name: 'Recovery',    durationPct: 0.05, targetFtpPercent: 45, color: ZONE_COLORS.recovery },
      { name: 'FTP Test',    durationPct: 0.45, targetFtpPercent: 100, color: ZONE_COLORS.threshold },
      { name: 'Cool Down',   durationPct: 0.20, targetFtpPercent: 40, color: ZONE_COLORS.warmup },
    ],
  },
  {
    id: 'tabata',
    name: 'Tabata',
    description: '8 × 20s at 170% FTP / 10s rest — extreme anaerobic',
    templates: [
      { name: 'Warm Up',     durationPct: 0.20, targetFtpPercent: 55, color: ZONE_COLORS.warmup },
      { name: 'Sprint 1',    durationPct: 0.04, targetFtpPercent: 170, color: ZONE_COLORS.sprint },
      { name: 'Rest',        durationPct: 0.02, targetFtpPercent: 30, color: ZONE_COLORS.recovery },
      { name: 'Sprint 2',    durationPct: 0.04, targetFtpPercent: 170, color: ZONE_COLORS.sprint },
      { name: 'Rest',        durationPct: 0.02, targetFtpPercent: 30, color: ZONE_COLORS.recovery },
      { name: 'Sprint 3',    durationPct: 0.04, targetFtpPercent: 170, color: ZONE_COLORS.sprint },
      { name: 'Rest',        durationPct: 0.02, targetFtpPercent: 30, color: ZONE_COLORS.recovery },
      { name: 'Sprint 4',    durationPct: 0.04, targetFtpPercent: 170, color: ZONE_COLORS.sprint },
      { name: 'Rest',        durationPct: 0.02, targetFtpPercent: 30, color: ZONE_COLORS.recovery },
      { name: 'Sprint 5',    durationPct: 0.04, targetFtpPercent: 170, color: ZONE_COLORS.sprint },
      { name: 'Rest',        durationPct: 0.02, targetFtpPercent: 30, color: ZONE_COLORS.recovery },
      { name: 'Sprint 6',    durationPct: 0.04, targetFtpPercent: 170, color: ZONE_COLORS.sprint },
      { name: 'Rest',        durationPct: 0.02, targetFtpPercent: 30, color: ZONE_COLORS.recovery },
      { name: 'Sprint 7',    durationPct: 0.04, targetFtpPercent: 170, color: ZONE_COLORS.sprint },
      { name: 'Rest',        durationPct: 0.02, targetFtpPercent: 30, color: ZONE_COLORS.recovery },
      { name: 'Sprint 8',    durationPct: 0.04, targetFtpPercent: 170, color: ZONE_COLORS.sprint },
      { name: 'Cool Down',   durationPct: 0.34, targetFtpPercent: 40, color: ZONE_COLORS.warmup },
    ],
  },
];

/** Lookup map by profile ID */
export const WORKOUT_PROFILES_MAP: Record<string, WorkoutProfile> =
  Object.fromEntries(WORKOUT_PROFILES.map((p) => [p.id, p]));

// ── Helper functions ──

/**
 * Build concrete workout segments from a profile, scaled to a total duration.
 */
export function buildWorkoutSegments(
  profile: WorkoutProfile,
  totalDurationMs: number,
): WorkoutSegment[] {
  return profile.templates.map((t) => ({
    name: t.name,
    durationMs: Math.round(t.durationPct * totalDurationMs),
    targetFtpPercent: t.targetFtpPercent,
    targetCadence: t.targetCadence,
    color: t.color,
  }));
}

/**
 * Find which segment the rider is currently in, given elapsed time.
 * Returns null if elapsed exceeds total workout duration.
 */
export function getSegmentAtTime(
  segments: WorkoutSegment[],
  elapsedMs: number,
): SegmentInfo | null {
  let accumulated = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (elapsedMs < accumulated + seg.durationMs) {
      return {
        segment: seg,
        segmentIndex: i,
        segmentElapsed: elapsedMs - accumulated,
        segmentRemaining: accumulated + seg.durationMs - elapsedMs,
      };
    }
    accumulated += seg.durationMs;
  }
  // Past the end — return last segment as completed
  if (segments.length > 0) {
    const last = segments[segments.length - 1];
    return {
      segment: last,
      segmentIndex: segments.length - 1,
      segmentElapsed: last.durationMs,
      segmentRemaining: 0,
    };
  }
  return null;
}

/**
 * Total duration of all segments combined.
 */
export function totalWorkoutDuration(segments: WorkoutSegment[]): number {
  return segments.reduce((sum, s) => sum + s.durationMs, 0);
}

// ── Segment themes (narrative skin for structured training) ──
//
// Structured-workout segments are presented in the HUD as themed "events"
// (逆風來襲, 警車追擊 …) — same visual language as freeride random events —
// instead of dry sport-science labels, so the rider instantly reads the
// intent: how hard, and why. Purely presentational: theming never changes
// targets, grading, or the on-target evaluation.

/** Narrative theme attached to a workout segment for HUD presentation. */
export interface SegmentTheme {
  id: string;
  /** Story name shown big in the HUD (Chinese). */
  name: string;
  /** Font Awesome icon name. */
  icon: string;
  /** Accent color for HUD elements. */
  color: string;
  /** Full-screen tint overlay (hex) while the segment is active. */
  screenTint: string;
  /** Tint opacity 0-1 (kept subtle — this runs for minutes, not seconds). */
  screenTintOpacity: number;
  /** One-line flavor instruction (Chinese). */
  hint: string;
}

const SEGMENT_THEMES = {
  warmup: {
    id: 'warmup',
    name: '晨間出發',
    icon: 'sun',
    color: ZONE_COLORS.warmup,
    screenTint: '#4a90d9',
    screenTintOpacity: 0.05,
    hint: '輕鬆轉動雙腿，喚醒身體',
  },
  recovery: {
    id: 'recovery',
    name: '補給站',
    icon: 'mug-hot',
    color: ZONE_COLORS.recovery,
    screenTint: '#00e676',
    screenTintOpacity: 0.05,
    hint: '放輕鬆，補水喘口氣',
  },
  cruise: {
    id: 'cruise',
    name: '順風巡航',
    icon: 'feather',
    color: ZONE_COLORS.endurance,
    screenTint: '#66bb6a',
    screenTintOpacity: 0.05,
    hint: '穩定節奏，維持巡航',
  },
  headwind: {
    id: 'headwind',
    name: '逆風來襲',
    icon: 'wind',
    color: ZONE_COLORS.sweetSpot,
    screenTint: '#ffab00',
    screenTintOpacity: 0.08,
    hint: '頂住風壓，穩穩輸出',
  },
  climb: {
    id: 'climb',
    name: '長坡爬升',
    icon: 'mountain',
    color: ZONE_COLORS.threshold,
    screenTint: '#ff6d00',
    screenTintOpacity: 0.08,
    hint: '咬住坡度，別掉檔',
  },
  chase: {
    id: 'chase',
    name: '警車追擊',
    icon: 'car-side',
    color: ZONE_COLORS.vo2max,
    screenTint: '#ff1744',
    screenTintOpacity: 0.10,
    hint: '全力踩！別被追上',
  },
  sprint: {
    id: 'sprint',
    name: '終點衝刺',
    icon: 'person-running',
    color: ZONE_COLORS.sprint,
    screenTint: '#d500f9',
    screenTintOpacity: 0.10,
    hint: '掏空自己，衝線！',
  },
  cooldown: {
    id: 'cooldown',
    name: '夕陽返家',
    icon: 'cloud-sun',
    color: ZONE_COLORS.warmup,
    screenTint: '#4a90d9',
    screenTintOpacity: 0.05,
    hint: '緩和收操，慢慢回家',
  },
} as const satisfies Record<string, SegmentTheme>;

/**
 * Map a workout segment to its narrative theme.
 *
 * Name keywords win (Warm Up / Cool Down / Recovery / Rest carry intent that
 * intensity alone can't distinguish — a 55% warm-up and a 55% recovery feel
 * different); otherwise classify by target intensity (%FTP).
 */
export function getSegmentTheme(segment: WorkoutSegment): SegmentTheme {
  const name = segment.name.toLowerCase();
  if (/warm/.test(name)) return SEGMENT_THEMES.warmup;
  if (/cool/.test(name)) return SEGMENT_THEMES.cooldown;
  if (/recovery|rest/.test(name)) return SEGMENT_THEMES.recovery;

  const pct = segment.targetFtpPercent;
  if (pct <= 55) return SEGMENT_THEMES.recovery;
  if (pct <= 79) return SEGMENT_THEMES.cruise;
  if (pct <= 94) return SEGMENT_THEMES.headwind;
  if (pct <= 109) return SEGMENT_THEMES.climb;
  if (pct <= 139) return SEGMENT_THEMES.chase;
  return SEGMENT_THEMES.sprint;
}

/**
 * Compute overall workout grade based on time-on-target percentage.
 */
export function workoutGrade(timeOnTargetPct: number): string {
  if (timeOnTargetPct >= 90) return 'A';
  if (timeOnTargetPct >= 75) return 'B';
  if (timeOnTargetPct >= 60) return 'C';
  return 'D';
}
