import type { GameMap } from './map-adapter';

export interface CameraTarget {
  lat: number;
  lon: number;
  bearing: number;
}

/**
 * Update FPS camera to follow the ball from behind.
 * Uses jumpTo for smooth 60fps updates without animation queuing.
 */
export function updateFpsCamera(
  map: GameMap,
  position: CameraTarget,
  options: { pitch: number; zoom?: number },
) {
  const { pitch, zoom = 18.5 } = options;

  // Camera behind ball (25m back) but looking ahead (40m forward from ball)
  // so the ball appears in the lower ~1/3 of the screen, like FPS view.
  const behindM = 25;
  const lookAheadM = 40;

  const bearingRad = (position.bearing * Math.PI) / 180;
  const cosLat = Math.cos((position.lat * Math.PI) / 180);

  // Camera position: behind the ball
  const camLat = position.lat + (-behindM * Math.cos(bearingRad)) / 111320;
  const camLon = position.lon + (-behindM * Math.sin(bearingRad)) / (111320 * cosLat);

  // Look-at target: ahead of the ball — map center is between camera and look-at
  // With high pitch, setting center ahead of camera pushes the ball down on screen
  const centerLat = position.lat + (lookAheadM * Math.cos(bearingRad)) / 111320;
  const centerLon = position.lon + (lookAheadM * Math.sin(bearingRad)) / (111320 * cosLat);

  map.jumpTo({
    center: [centerLon, centerLat],
    bearing: position.bearing,
    pitch,
    zoom,
  });
}
