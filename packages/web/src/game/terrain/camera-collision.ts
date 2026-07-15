/**
 * Keeps the chase camera's view of the bike clear of the terrain.
 *
 * The camera sits 11 m behind the bike. On a climb that is 11 m of hillside; on
 * a DESCENT the hill you just came over rises between the camera and the bike.
 * Either way the shot is ruined, and the two cases are not the same test:
 *
 *  - "is the terrain above the camera?" only catches the first. Going downhill
 *    the crest behind you can be well below the camera and still stand squarely
 *    in front of it, so that test never fires and the bike disappears behind a
 *    wall of cardboard.
 *  - what actually matters is whether anything pokes through the SIGHTLINE — the
 *    straight line from the camera to the bike. That covers both.
 *
 * So we sample the ground along that line and work out how far the camera has to
 * rise for the whole line to clear it. Lifting (rather than pushing the camera
 * around in XZ, which fights the chase rig and makes the framing lurch) turns the
 * shot into a bird's-eye for as long as the obstruction lasts, then settles back.
 *
 * Pure maths, no Three.js state: the renderer feeds it ground samples, it returns
 * a lift. That also makes it testable headless.
 */

/** Metres the sightline keeps above the terrain it passes over. */
export const CAMERA_GROUND_MARGIN = 2.5;

/**
 * Rise fast (the bike is already hidden — fix it now), fall slowly (the ground
 * under a moving camera flickers between the terrain's steps, and matching it
 * frame for frame would make the shot bob). Per second.
 */
const RISE_RATE = 12;
const FALL_RATE = 2;

/** Above this much lift, the gaze is fully pointed down at the bike. */
export const FULL_TILT_LIFT = 4;

/** How many points along the sightline are probed (excluding the bike itself). */
export const SIGHTLINE_SAMPLES = 5;

/** One ground reading along the sightline. */
export interface SightlineSample {
  /** 0 = at the bike, 1 = at the camera. */
  t: number;
  /** Terrain height there, or null if that chunk has not streamed in. */
  groundY: number | null;
}

/**
 * How far the camera must rise for the sightline to clear the terrain.
 *
 * The sightline runs from the bike (at `riderY + lookHeight`) to the camera (at
 * `cameraY + lift`). At a sample `t` its height is
 *
 *     h(t) = aim + t · (cameraY + lift − aim)        where aim = riderY + lookHeight
 *
 * and we need `h(t) ≥ groundY + margin`, so
 *
 *     lift ≥ (groundY + margin − aim) / t − (cameraY − aim)
 *
 * Take the worst sample. `t = 1` reduces to the old "camera is underground"
 * check, so this strictly subsumes it.
 */
export function requiredLift(
  riderY: number,
  cameraY: number,
  lookHeight: number,
  samples: SightlineSample[],
): number {
  const aim = riderY + lookHeight;
  let lift = 0;

  for (const s of samples) {
    // No terrain there → assume clear air rather than inventing an obstruction.
    if (s.groundY === null || s.t <= 0) continue;
    const need = (s.groundY + CAMERA_GROUND_MARGIN - aim) / s.t - (cameraY - aim);
    if (need > lift) lift = need;
  }

  return lift;
}

export class CameraGroundClamp {
  private lift = 0;

  /**
   * @returns metres to add to the camera's y this frame (>= 0).
   */
  update(
    riderY: number,
    cameraY: number,
    lookHeight: number,
    samples: SightlineSample[],
    dt: number,
  ): number {
    const needed = requiredLift(riderY, cameraY, lookHeight, samples);

    const rate = needed > this.lift ? RISE_RATE : FALL_RATE;
    this.lift += (needed - this.lift) * Math.min(dt * rate, 1);
    if (this.lift < 0.01) this.lift = 0;

    return this.lift;
  }

  /**
   * How far the gaze has swung from "down the road" to "down at the bike",
   * 0..1. Ramped off the lift so the tilt arrives with the climb, not as a cut.
   */
  get tilt(): number {
    return Math.min(1, this.lift / FULL_TILT_LIFT);
  }

  get active(): boolean {
    return this.lift > 0;
  }

  /** Drop the lift instantly (leaving third person, teleporting, …). */
  reset(): void {
    this.lift = 0;
  }
}
