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

      // Map time fraction to route distance (linear approximation)
      const distM = timeFraction * totalRouteDistM;

      // Find the closest route point for this distance
      const pt = this.interpolatePoint(points, cumDists, distM);
      if (!pt) continue;

      const nextColor = segments[i + 1].color;
      const flag = this.createFlag(pt, distM, i + 1, nextColor, raycastGround);
      this.flags.push(flag);
      this.scene.add(flag.group);
    }
  }

  /**
   * Update flags based on rider distance. Fade out passed flags.
   */
  update(riderDistanceM: number): void {
    for (const flag of this.flags) {
      if (!flag.passed && riderDistanceM >= flag.distanceM) {
        flag.passed = true;
        // Fade out. Every flag part owns its material (the strategy builds them
        // fresh per checkpoint), so mutating opacity here can't leak to others.
        flag.group.traverse((child) => {
          const mat = (child as THREE.Mesh).material;
          if (mat instanceof THREE.Material) {
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
        if (mat instanceof THREE.Material) {
          // Paper's sticky-note flag bakes its own CanvasTexture per checkpoint —
          // disposing the material alone would leak it.
          (mat as THREE.MeshToonMaterial).map?.dispose();
          mat.dispose();
        }
      });
    }
    this.flags.length = 0;
  }

  private interpolatePoint(
    points: RoutePoint[],
    cumDists: number[],
    targetDist: number,
  ): { lon: number; lat: number; ele: number } | null {
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
        };
      }
    }
    // Past end, use last point
    const last = points[points.length - 1];
    return { lon: last.lon, lat: last.lat, ele: last.ele };
  }

  private createFlag(
    pt: { lon: number; lat: number; ele: number },
    distM: number,
    segmentIndex: number,
    color: string,
    raycastGround?: (x: number, z: number) => number | undefined,
  ): CheckpointFlag {
    // Convert lngLat to local meters
    const dLon = pt.lon - this.originLon;
    const dLat = pt.lat - this.originLat;
    const x = dLon * 111320 * this.cosLat;
    const z = -dLat * 111320;

    // Ground height from raycast or fallback to 0
    const groundY = raycastGround?.(x, z) ?? 0;

    const group = this.strategy.buildCheckpoint(color, segmentIndex);
    group.position.set(x, groundY, z);

    return { group, segmentIndex, distanceM: distM, passed: false };
  }
}
