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
 * around in XZ, which fights the chase rig and makes the framing lurch) keeps the
 * chase framing and only tips the gaze down a little — see `CLAMP_MAX_TILT`. It
 * used to swing all the way into a bird's-eye, which was jarring and stole the
 * shot `camera-lift.ts` keeps for the end of an interval and the finish.
 *
 * And the rise itself has a CEILING — see `ceilingY` on `requiredLift`. Without
 * one the answer is unbounded, and on a hairpin summit it really does run to
 * hundreds of metres, straight into an opaque cloud deck.
 *
 * Pure maths, no Three.js state: the renderer feeds it ground samples AND the
 * height of whatever is overhead, and it returns a lift. It never learns that
 * clouds exist. That also makes it testable headless.
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

/** Lift at which the collision tilt reaches its ceiling. */
export const FULL_TILT_LIFT = 4;

/**
 * How far the COLLISION response is allowed to swing the gaze off the road,
 * 0..1 — and it is deliberately not 1.
 *
 * It used to be: 4 m of lift → `tilt = 1` → the camera looks straight down at
 * the bike. That reads as a cut to a bird's-eye every time you crest a hill,
 * which is jarring and, worse, it spends the one shot the game keeps for the
 * moments that earn it: `camera-lift.ts` raises the camera and swings the gaze
 * all the way onto the world at the end of an interval (`peek`) and on the
 * run-in to the finish (`finale`).
 *
 * Two different jobs, and only one of them is cinematic:
 *
 *  - **collision** — a hill is in the way. Keep chasing; rise enough to see over
 *    it and tip the gaze DOWN A LITTLE. The rider should barely notice.
 *  - **cinematic** — the ride wants your attention. Rise and look down on the
 *    world, and that is allowed to be a big move because it is rare and it means
 *    something.
 *
 * The renderer takes `Math.max(cinematicLift, clampTilt)`, so capping this side
 * alone keeps the cinematic shot at full strength.
 */
export const CLAMP_MAX_TILT = 0.3;

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
 *
 * ## Why there has to be a ceiling
 *
 * That formula divides by `t`, and `t` is small for the samples nearest the
 * bike (1/5 on the medium/high tiers, 1/3 on low). So an obstruction only two
 * metres behind the bike is multiplied by five before it becomes a lift. Two
 * metres behind the bike is normally the road, but not always: on a hairpin the
 * corridor folds over itself and the ground query answers with the TOPMOST
 * surface, i.e. the next switchback thirty metres up. The lift then comes back
 * in the hundreds of metres, and the shot is not "a bit high", it is inside the
 * cloud deck — which is opaque `MeshToonMaterial`, so the whole screen is grey.
 *
 * `ceilingY` is the highest scene Y the camera may occupy (the caller gets it
 * from `SkyAndFog.cameraCeilingSceneY(cameraY)`; `null` = nothing overhead).
 * Note this module never learns what is up there — it takes a number.
 *
 * The clamp is one-sided: when the camera is ALREADY above the ceiling (a route
 * that climbs through the deck) the answer is zero lift, never a push down —
 * pushing down is how you end up inside the hill, and the terrain clamp exists
 * precisely to avoid that.
 *
 * When the ceiling bites, the bike can be obscured by the hill for a moment.
 * That is the intended trade: 「盡量跟車」beats 「一定看得到車」, and a second of
 * hillside beats a screenful of grey.
 */
export function requiredLift(
  riderY: number,
  cameraY: number,
  lookHeight: number,
  samples: SightlineSample[],
  ceilingY: number | null = null,
): number {
  const aim = riderY + lookHeight;
  let lift = 0;

  for (const s of samples) {
    // No terrain there → assume clear air rather than inventing an obstruction.
    if (s.groundY === null || s.t <= 0) continue;
    const need = (s.groundY + CAMERA_GROUND_MARGIN - aim) / s.t - (cameraY - aim);
    if (need > lift) lift = need;
  }

  return capToCeiling(lift, cameraY, ceilingY);
}

/**
 * Trim a lift so `cameraY + lift` stays at or below `ceilingY`, never returning
 * a negative lift. Shared by `requiredLift` and the smoothed clamp, so the eased
 * value obeys the same ceiling as the target it is easing toward — a ceiling
 * that DROPS (an origin rebase, a weather update lowering the condensation
 * level) would otherwise leave the camera parked above it for the whole of the
 * slow fall.
 */
function capToCeiling(lift: number, cameraY: number, ceilingY: number | null): number {
  if (ceilingY === null) return lift;
  const headroom = ceilingY - cameraY;
  if (lift <= headroom) return lift;
  return headroom > 0 ? headroom : 0;
}

export class CameraGroundClamp {
  private lift = 0;

  /**
   * @param ceilingY  Highest scene Y the camera may occupy, or null for none —
   *                  see `requiredLift`.
   * @returns metres to add to the camera's y this frame (>= 0).
   */
  update(
    riderY: number,
    cameraY: number,
    lookHeight: number,
    samples: SightlineSample[],
    dt: number,
    ceilingY: number | null = null,
  ): number {
    const needed = requiredLift(riderY, cameraY, lookHeight, samples, ceilingY);

    const rate = needed > this.lift ? RISE_RATE : FALL_RATE;
    this.lift += (needed - this.lift) * Math.min(dt * rate, 1);
    // The eased value gets the ceiling too, not just the target: the fall rate
    // is 2/s, so a ceiling that drops under a camera already up in the air would
    // leave it inside the cloud for a second or more.
    this.lift = capToCeiling(this.lift, cameraY, ceilingY);
    if (this.lift < 0.01) this.lift = 0;

    return this.lift;
  }

  /**
   * How far the gaze has swung from "down the road" to "down at the bike",
   * 0..1. Ramped off the lift so the tilt arrives with the climb, not as a cut.
   */
  get tilt(): number {
    return Math.min(CLAMP_MAX_TILT, (this.lift / FULL_TILT_LIFT) * CLAMP_MAX_TILT);
  }

  get active(): boolean {
    return this.lift > 0;
  }

  /** Drop the lift instantly (leaving third person, teleporting, …). */
  reset(): void {
    this.lift = 0;
  }
}
