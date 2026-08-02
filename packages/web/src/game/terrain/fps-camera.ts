/**
 * Chase camera for the third-person diorama view — the camera sits behind and
 * above the rider's bike ornament and looks down the road ahead, the way a 3DS
 * platformer frames its character.
 *
 * A first-person mode is kept behind `mode: 'first'` (the camera IS the rider,
 * no bike drawn); third-person is the default the game ships with.
 *
 * Coordinates are scene-local metres (floating origin):
 * - x: east (+) / west (-)
 * - y: up (+) / down (-)
 * - z: south (+) / north (-)  (Three.js convention: -z is north/forward)
 */

import * as THREE from 'three';

/** Scratch vector for the chase lerp (avoids a per-frame allocation). */
const _target = new THREE.Vector3();

/**
 * 'third' — chase cam (default, the demos' 跟騎).
 * 'orbit' — free look; driven by `orbit-camera.ts`, NOT by this module.
 * 'first' — eye level, no bike drawn.
 */
export type CameraMode = 'first' | 'third' | 'orbit';

export interface FpsCameraOptions {
  /** See CameraMode. `updateFpsCamera` ignores 'orbit' — OrbitCamera owns it. */
  mode?: CameraMode;
  /**
   * In first person: camera height above ground.
   * In third person: drives BOTH the chase height and distance (see
   * `chaseHeight` / `chaseDistance`) so the existing in-game height slider
   * still zooms the diorama in and out.
   */
  heightAboveM?: number;
  /** Distance ahead of the rider to look at, in metres. */
  lookAheadM?: number;
  /** Downward pitch angle in degrees. */
  pitchDeg?: number;
}

const DEFAULT_HEIGHT = 15;
const DEFAULT_LOOK_AHEAD = 80;

/** Downward pitch angle in degrees (bird's-eye gaze). */
const DEFAULT_PITCH_DEG = 30;

/** First-person: smoothing factor (0 = no smoothing, 1 = frozen). */
const SMOOTH_FACTOR = 0.15;

// ── Third-person chase rig (the demos' "跟騎" camera) ──
//
// The demos frame a 7 m bike from 17 m back / 9.5 m up, looking 8 m ahead of it
// at head height (4 m). Our ornament is ~4.6 m, so the whole rig is scaled by
// the same 0.66 — same composition, correct for our bike.
//
// The feel comes from the asymmetry: the POSITION lags (lerped at dt × 3.2, so
// it takes ~0.4 s to catch up and swings wide through a corner), while the GAZE
// is re-aimed hard every frame. Slerping the rotation too — which is what this
// used to do — kills the swing and reads as a rigid, "on rails" camera.

const BIKE_SCALE = 0.66;

/** Metres behind the bike, along −forward. */
const CHASE_BACK = 17 * BIKE_SCALE;      // 11.2

/** Metres above the rider's ground. */
const CHASE_UP = 9.5 * BIKE_SCALE;       // 6.3

/** Metres ahead of the bike the gaze is aimed. */
const CHASE_LOOK_AHEAD = 8 * BIKE_SCALE; // 5.3

/** Gaze height above the rider's ground, at the neutral pitch. Exported: the
 *  sightline check must aim at the same point the camera actually looks at. */
export const CHASE_LOOK_HEIGHT = 4 * BIKE_SCALE; // 2.6

/** Position catch-up rate — the demos' `lerp(target, min(dt * 3.2, 1))`. */
const CHASE_FOLLOW_RATE = 3.2;

/**
 * The in-game camera-height slider (default 15) becomes a plain zoom on the rig:
 * 15 → 1.0 = the demos' framing. Clamped so the bike can't leave the frame.
 */
function chaseZoom(heightAboveM: number): number {
  return THREE.MathUtils.clamp(heightAboveM / DEFAULT_HEIGHT, 0.45, 2.2);
}

/**
 * Pitch (deg) at which the gaze sits at `CHASE_LOOK_HEIGHT` — i.e. the pitch
 * that reproduces the demos' framing exactly (their follow cam looks from
 * 17 back / 9.5 up at a point 8 ahead, 4 up, and at this pitch so do we).
 *
 * ⚠ It does NOT "match the config default", which is what this comment used to
 * claim: `DEFAULT_CONFIG.map.cameraPitch` is **12**, not 30 (`shared/src/
 * config.ts`). So the shipped default gaze sits 1.44 m ABOVE the demos' — the
 * frame's top edge reaches elevation 19.9° where the demos reach 15.1°. That
 * matters to anything reasoning about how much sky is on screen; believing this
 * comment is how the circuit sky's visible band got computed as 15.1° at first.
 */
const CHASE_NEUTRAL_PITCH = DEFAULT_PITCH_DEG;

/** Metres the gaze drops per degree of pitch above neutral. */
const CHASE_PITCH_GAIN = 0.08;

/**
 * Elevation (deg above horizontal) of the TOP EDGE of the frame, for the chase
 * camera at a given pitch/height slider setting and vertical FOV.
 *
 * Exported because it is the only honest way for a check to ask "how much sky
 * can the rider actually see?" — the alternative is transcribing the five rig
 * constants into the check, which re-confirms whatever was typed there rather
 * than what the camera does. `[sky covers the visible band]` in diorama.ts is
 * the caller; see the derivation in `circuit-terrain-style.ts`'s skyPalette.
 *
 * Positive = the frame top is above the horizon. The gaze pitches DOWN by
 * `atan((gaze − camY) / (lookAhead + back))`, and the frame top is half the
 * vertical FOV above that.
 */
export function chaseFrameTopElevationDeg(
  pitchDeg: number,
  heightAboveM: number,
  fovDeg: number,
): number {
  const zoom = chaseZoom(heightAboveM);
  const gaze = CHASE_LOOK_HEIGHT - (pitchDeg - CHASE_NEUTRAL_PITCH) * CHASE_PITCH_GAIN;
  const dy = gaze - CHASE_UP * zoom;
  const dz = CHASE_LOOK_AHEAD + CHASE_BACK * zoom;
  return (Math.atan2(dy, dz) * 180) / Math.PI + fovDeg / 2;
}

/**
 * Update a Three.js PerspectiveCamera for the cycling view.
 *
 * @param camera - The Three.js camera to update
 * @param riderPosition - Rider ground position in scene metres (y = ground level)
 * @param bearingDeg - Rider heading in degrees (0=north, 90=east, clockwise)
 * @param options - Camera positioning parameters
 * @param dt - Delta time in seconds for smoothing (0 = instant snap)
 */
export function updateFpsCamera(
  camera: THREE.PerspectiveCamera,
  riderPosition: { x: number; y: number; z: number },
  bearingDeg: number,
  options?: FpsCameraOptions,
  dt?: number,
): void {
  const mode = options?.mode ?? 'third';
  const heightAboveM = options?.heightAboveM ?? DEFAULT_HEIGHT;
  const pitchDeg = options?.pitchDeg ?? DEFAULT_PITCH_DEG;

  // Heading → forward unit vector. bearing 0 = north = -z, 90 = east = +x.
  const bearingRad = (bearingDeg * Math.PI) / 180;
  const fx = Math.sin(bearingRad);
  const fz = -Math.cos(bearingRad);

  if (mode === 'third') {
    const zoom = chaseZoom(heightAboveM);

    // Behind the bike along −forward, lifted above the ground.
    const back = CHASE_BACK * zoom;
    const camX = riderPosition.x - fx * back;
    const camY = riderPosition.y + CHASE_UP * zoom;
    const camZ = riderPosition.z - fz * back;

    if (dt && dt > 0) {
      // Position lags, gaze does not — see the note on the chase rig above.
      _target.set(camX, camY, camZ);
      camera.position.lerp(_target, Math.min(dt * CHASE_FOLLOW_RATE, 1));
    } else {
      camera.position.set(camX, camY, camZ);
    }

    // Aim just ahead of the bike; the pitch slider tilts the gaze up/down.
    const gaze = CHASE_LOOK_HEIGHT - (pitchDeg - CHASE_NEUTRAL_PITCH) * CHASE_PITCH_GAIN;
    camera.lookAt(
      riderPosition.x + fx * CHASE_LOOK_AHEAD,
      riderPosition.y + gaze,
      riderPosition.z + fz * CHASE_LOOK_AHEAD,
    );
    return;
  }

  // ── First person (kept behind `mode: 'first'`; the camera IS the rider) ──
  const lookAheadM = options?.lookAheadM ?? DEFAULT_LOOK_AHEAD;
  const camX = riderPosition.x;
  const camY = riderPosition.y + heightAboveM;
  const camZ = riderPosition.z;

  const pitchDrop = Math.tan((pitchDeg * Math.PI) / 180) * lookAheadM;
  const lookX = riderPosition.x + fx * lookAheadM;
  const lookY = camY - pitchDrop;
  const lookZ = riderPosition.z + fz * lookAheadM;

  if (dt && dt > 0) {
    const alpha = 1 - Math.pow(SMOOTH_FACTOR, dt * 60);
    _target.set(camX, camY, camZ);
    camera.position.lerp(_target, alpha);
    // Smooth look-at via quaternion slerp
    const tempCam = camera.clone();
    tempCam.position.copy(camera.position);
    tempCam.lookAt(lookX, lookY, lookZ);
    camera.quaternion.slerp(tempCam.quaternion, alpha);
  } else {
    camera.position.set(camX, camY, camZ);
    camera.lookAt(lookX, lookY, lookZ);
  }
}
