/**
 * 3D checkpoint flags placed along the route at workout segment boundaries.
 *
 * The look comes from the world-style strategy (cuphead → map pin + sticky
 * note; plastic → brick flag pole); the flag colour is the next segment's.
 * Flags fade out when the rider passes them.
 */

import * as THREE from 'three';
import type { RoutePoint, WorkoutSegment } from '@littlecycling/shared';
import { totalWorkoutDuration } from '@littlecycling/shared';
import type { TerrainStyleStrategy } from './terrain-style-strategy';
import { segmentSignLabel } from './sign-spec';

/** Opacity a flag fades to once the rider is past it. */
const PASSED_OPACITY = 0.2;

interface CheckpointFlag {
  group: THREE.Group;
  segmentIndex: number;  // segment that starts after this flag
  distanceM: number;     // cumulative route distance where this flag sits
  passed: boolean;
}

export class CheckpointFlagManager {
  private scene: THREE.Scene;
  private strategy: TerrainStyleStrategy;
  private flags: CheckpointFlag[] = [];
  private originLon = 0;
  private originLat = 0;
  private cosLat = 1;

  constructor(scene: THREE.Scene, strategy: TerrainStyleStrategy) {
    this.scene = scene;
    this.strategy = strategy;
  }

  /** Swap the style — the caller re-spawns the flags afterwards. */
  setStrategy(strategy: TerrainStyleStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Spawn checkpoint flags at segment boundaries along the route.
   *
   * @param segments  Expanded workout segments (with durationMs)
   * @param points    Route points array
   * @param cumDists  Cumulative distances array (same length as points)
   * @param totalRouteDistM  Total route distance in meters
   * @param originLon  Origin longitude for local coords
   * @param originLat  Origin latitude for local coords
   * @param raycastGround  Optional function to snap flag to terrain height
   */
  spawn(
    segments: WorkoutSegment[],
    points: RoutePoint[],
    cumDists: number[],
    totalRouteDistM: number,
    originLon: number,
    originLat: number,
    raycastGround?: (x: number, z: number) => number | undefined,
    startOffsetM = 0,
  ): void {
    this.dispose();
    if (segments.length < 2 || points.length < 2) return;

    this.originLon = originLon;
    this.originLat = originLat;
    this.cosLat = Math.cos((originLat * Math.PI) / 180);

    const workoutTotalMs = totalWorkoutDuration(segments);

    // Place a flag at each segment boundary (not at 0 or end)
    let cumulativeMs = 0;
    for (let i = 0; i < segments.length - 1; i++) {
      cumulativeMs += segments[i].durationMs;
      const timeFraction = cumulativeMs / workoutTotalMs;

      // Map time fraction to RIDDEN distance (linear approximation). The flag
      // stores ridden metres (compare axis = the rider's cumulative distance),
      // while its 3D position maps through the start window into route space.
      const riddenM = timeFraction * totalRouteDistM;
      const routeM = (startOffsetM + riddenM) % totalRouteDistM;

      // Find the closest route point for this distance
      const pt = this.interpolatePoint(points, cumDists, routeM);
      if (!pt) continue;

      const nextColor = segments[i + 1].color;
      // The flag marks the START of the next segment, so it carries the next
      // segment's name — not the one the rider is finishing.
      const label = segmentSignLabel(segments[i + 1].name, i + 2);
      const flag = this.createFlag(pt, riddenM, i + 1, nextColor, label, raycastGround);
      this.flags.push(flag);
      this.scene.add(flag.group);
    }
  }

  /**
   * Update flags based on rider distance. Fade out passed flags.
   * `riderDistanceM` is RIDDEN (monotonic cumulative) metres — same axis the
   * flags store, so lap wrap and the start window need no special cases.
   */
  update(riderDistanceM: number): void {
    for (const flag of this.flags) {
      if (!flag.passed && riderDistanceM >= flag.distanceM) {
        flag.passed = true;
        // Fade out. Flag parts own their materials (the strategy builds them
        // fresh per checkpoint), so mutating opacity here can't leak to others
        // — EXCEPT for anything tagged `userData.shared`, which is a
        // strategy-owned singleton that every other prop in the world is also
        // using. Fading one passed checkpoint must not fade every shop sign on
        // the route.
        flag.group.traverse((child) => {
          const mat = (child as THREE.Mesh).material;
          if (mat instanceof THREE.Material && !mat.userData.shared) {
            mat.transparent = true;
            mat.opacity = PASSED_OPACITY;
          }
        });
      }
    }
  }

  dispose(): void {
    for (const flag of this.flags) {
      this.scene.remove(flag.group);
      flag.group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.geometry.dispose();
        const mat = child.material;
        if (mat instanceof THREE.Material && !mat.userData.shared) {
          // Paper's sticky-note flag bakes its own CanvasTexture per checkpoint —
          // disposing the material alone would leak it.
          (mat as THREE.MeshToonMaterial).map?.dispose();
          mat.dispose();
        }
      });
    }
    this.flags.length = 0;
  }

  /**
   * The point at `targetDist`, plus the ROUTE TANGENT there.
   *
   * The tangent is why this returns more than a position: all three demos place
   * a checkpoint with `cp.rotation.y = Math.atan2(p.tx, p.tz)` — the marker
   * turns to face along the route, so the plate/flag/cap that hangs off the
   * post is aimed at the rider instead of at a fixed world direction. Without
   * it the toy world's octagonal sign showed the rider its edge, which is the
   * failure the plastic demo writes down at length.
   */
  private interpolatePoint(
    points: RoutePoint[],
    cumDists: number[],
    targetDist: number,
  ): { lon: number; lat: number; ele: number; dLon: number; dLat: number } | null {
    if (points.length === 0) return null;

    for (let i = 1; i < cumDists.length; i++) {
      if (cumDists[i] >= targetDist) {
        const prevDist = cumDists[i - 1];
        const segLen = cumDists[i] - prevDist;
        const t = segLen > 0 ? (targetDist - prevDist) / segLen : 0;
        return {
          lon: points[i - 1].lon + (points[i].lon - points[i - 1].lon) * t,
          lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * t,
          ele: points[i - 1].ele + (points[i].ele - points[i - 1].ele) * t,
          dLon: points[i].lon - points[i - 1].lon,
          dLat: points[i].lat - points[i - 1].lat,
        };
      }
    }
    // Past end, use last point
    const n = points.length;
    const last = points[n - 1];
    return {
      lon: last.lon,
      lat: last.lat,
      ele: last.ele,
      dLon: last.lon - points[n - 2].lon,
      dLat: last.lat - points[n - 2].lat,
    };
  }

  private createFlag(
    pt: { lon: number; lat: number; ele: number; dLon: number; dLat: number },
    distM: number,
    segmentIndex: number,
    color: string,
    label: string,
    raycastGround?: (x: number, z: number) => number | undefined,
  ): CheckpointFlag {
    // Convert lngLat to local meters
    const dLon = pt.lon - this.originLon;
    const dLat = pt.lat - this.originLat;
    const x = dLon * 111320 * this.cosLat;
    const z = -dLat * 111320;

    // Ground height from raycast or fallback to 0
    const groundY = raycastGround?.(x, z) ?? 0;

    const group = this.strategy.buildCheckpoint(color, segmentIndex, label);
    group.position.set(x, groundY, z);
    // The demos' own placement: `cp.rotation.y = Math.atan2(p.tx, p.tz)`, which
    // maps the checkpoint's local +Z onto the direction of travel. Every world's
    // `buildCheckpoint` is drawn in that frame (plastic turns its plate 180° to
    // meet the rider coming from −Z; paper hangs its tape off +X; circuit lays
    // its 9 m header across it), so a world-aligned group aims all three at
    // whatever direction the map happens to run.
    const tx = pt.dLon * 111320 * this.cosLat;
    const tz = -pt.dLat * 111320;
    if (tx !== 0 || tz !== 0) group.rotation.y = Math.atan2(tx, tz);

    return { group, segmentIndex, distanceM: distM, passed: false };
  }
}
