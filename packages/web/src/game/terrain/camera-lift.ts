/**
 * Cinematic camera lift — the camera pulls up and looks down on the world at the
 * moments that deserve it: the end of each workout interval, and the run-in to
 * the finish.
 *
 * Deliberately NOT the full replay flyover that was designed and shelved (see
 * `plan/2026-summer-world-life.md`, F6). That one had to fight the end-of-ride
 * state machine — `state = 'ended'` opens the summary dialog and writes the ride
 * to the database immediately, so a cinematic could not get a word in edgeways.
 * This lifts the camera BEFORE the ride ends and never touches that machinery.
 *
 * Pure state + curve, no Three.js: the renderer asks for a 0..1 weight and blends
 * the chase rig toward the high shot itself. Testable headless.
 */

/**
 * 'peek'   — an interval just ended: rise, hold, settle back. Five seconds.
 * 'finale' — the finish is close: rise and STAY up, so the summary opens on a
 *            view of the world rather than the back of a bike.
 */
export type LiftKind = 'peek' | 'finale';

export const PEEK_RISE = 1.2;
export const PEEK_HOLD = 2.6;
export const PEEK_FALL = 1.2;
export const PEEK_DURATION = PEEK_RISE + PEEK_HOLD + PEEK_FALL; // 5.0 s

export const FINALE_RISE = 2.0;

/** How far above and behind the rider the lifted camera sits, in metres. */
export const LIFT_UP = 45;
export const LIFT_BACK = 25;

const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** Blend weight (0 = chase camera, 1 = fully lifted) at `t` seconds in. */
export function liftWeight(kind: LiftKind, t: number): number {
  if (t <= 0) return 0;

  if (kind === 'finale') {
    return t >= FINALE_RISE ? 1 : easeInOut(t / FINALE_RISE);
  }

  if (t < PEEK_RISE) return easeInOut(t / PEEK_RISE);
  if (t < PEEK_RISE + PEEK_HOLD) return 1;
  if (t < PEEK_DURATION) return easeInOut(1 - (t - PEEK_RISE - PEEK_HOLD) / PEEK_FALL);
  return 0;
}

export class CameraLift {
  private kindNow: LiftKind | null = null;
  private t = 0;

  /**
   * Start a lift. A finale overrides a peek in progress (the ride is ending —
   * that outranks an interval boundary); a peek during a peek is ignored rather
   * than restarting the rise.
   */
  trigger(kind: LiftKind): void {
    if (kind === 'peek' && this.kindNow !== null) return;
    if (kind === 'finale' && this.kindNow === 'finale') return;
    this.kindNow = kind;
    this.t = 0;
  }

  /** Abandon the lift (the rider took the camera into free look). */
  cancel(): void {
    this.kindNow = null;
    this.t = 0;
  }

  /** Advance and return this frame's blend weight (0 when nothing is running). */
  update(dt: number): number {
    if (this.kindNow === null) return 0;

    this.t += dt;

    if (this.kindNow === 'peek' && this.t >= PEEK_DURATION) {
      this.cancel();
      return 0;
    }

    return liftWeight(this.kindNow, this.t);
  }

  get active(): boolean {
    return this.kindNow !== null;
  }

  get kind(): LiftKind | null {
    return this.kindNow;
  }
}
