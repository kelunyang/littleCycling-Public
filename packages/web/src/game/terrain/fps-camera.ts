/**
 * FPS camera controller: positions the camera at the rider's eye level,
 * looking ahead along the route direction.
 *
 * True first-person cycling perspective — no visible ball, no pitch limit.
 * Replaces the MapLibre-based camera.ts that was limited to 85° pitch.
 */

import * as THREE from 'three';

export interface FpsCameraOptions {
  /** Camera height above ground in meters (cyclist eye height). */
  heightAboveM?: number;
  /** Distance ahead of the rider to look at, in meters. */
  lookAheadM?: number;
  /** Downward pitch angle in degrees. */
  pitchDeg?: number;
}

const DEFAULT_HEIGHT = 15;
const DEFAULT_LOOK_AHEAD = 80;

/** Downward pitch angle in degrees (bird's-eye gaze). */
const DEFAULT_PITCH_DEG = 30;

/** Smoothing factor for camera position (0 = no smoothing, 1 = frozen). */
const SMOOTH_FACTOR = 0.15;

/**
 * Update a Three.js PerspectiveCamera for true first-person cycling view.
 *
 * Camera is placed at the rider's eye level, looking ahead along the bearing.
 * No ball is visible — the rider *is* the camera.
 *
 * Coordinates are in scene-local meters (floating origin system):
 * - x: east (+) / west (-)
 * - y: up (+) / down (-)
 * - z: south (+) / north (-) (Three.js convention: -z is forward/north)
 *
 * @param camera - The Three.js camera to update
 * @param riderPosition - Rider ground position in scene meters {x, y, z} (y = ground level)
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
  const heightAboveM = options?.heightAboveM ?? DEFAULT_HEIGHT;
  const lookAheadM = options?.lookAheadM ?? DEFAULT_LOOK_AHEAD;
  const pitchDeg = options?.pitchDeg ?? DEFAULT_PITCH_DEG;

  // Convert bearing to Three.js angle
  // bearingDeg: 0=north=(-z), 90=east=(+x)
  const bearingRad = (bearingDeg * Math.PI) / 180;

  // Camera at rider's eye level
  const camX = riderPosition.x;
  const camY = riderPosition.y + heightAboveM;
  const camZ = riderPosition.z;

  // Look-at target: ahead along bearing, pitched down
  const pitchDrop = Math.tan((pitchDeg * Math.PI) / 180) * lookAheadM;
  const lookX = riderPosition.x + Math.sin(bearingRad) * lookAheadM;
  const lookY = camY - pitchDrop;
  const lookZ = riderPosition.z - Math.cos(bearingRad) * lookAheadM;

  if (dt && dt > 0) {
    // Smooth interpolation
    const alpha = 1 - Math.pow(SMOOTH_FACTOR, dt * 60);
    camera.position.lerp(new THREE.Vector3(camX, camY, camZ), alpha);
    // Smooth look-at via quaternion slerp
    const tempCam = camera.clone();
    tempCam.position.copy(camera.position);
    tempCam.lookAt(lookX, lookY, lookZ);
    camera.quaternion.slerp(tempCam.quaternion, alpha);
  } else {
    // Instant snap (first frame or teleport)
    camera.position.set(camX, camY, camZ);
    camera.lookAt(lookX, lookY, lookZ);
  }
}
