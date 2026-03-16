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

/**
 * Compute overall workout grade based on time-on-target percentage.
 */
export function workoutGrade(timeOnTargetPct: number): string {
  if (timeOnTargetPct >= 90) return 'A';
  if (timeOnTargetPct >= 75) return 'B';
  if (timeOnTargetPct >= 60) return 'C';
  return 'D';
}
