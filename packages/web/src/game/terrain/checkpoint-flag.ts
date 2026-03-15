/**
 * 3D checkpoint flags placed along the route at workout segment boundaries.
 *
 * Each flag = cylinder pole + flat rectangular flag mesh.
 * Flag color matches the next segment's color.
 * Flags fade out when the rider passes them.
 */

import * as THREE from 'three';
import type { RoutePoint, WorkoutSegment } from '@littlecycling/shared';
import { totalWorkoutDuration } from '@littlecycling/shared';

const POLE_RADIUS = 0.15;
const POLE_HEIGHT = 12;
const FLAG_WIDTH = 4;
const FLAG_HEIGHT = 2.5;
const POLE_COLOR = 0x888888;

interface CheckpointFlag {
  group: THREE.Group;
  segmentIndex: number;  // segment that starts after this flag
  distanceM: number;     // cumulative route distance where this flag sits
  passed: boolean;
}

export class CheckpointFlagManager {
  private scene: THREE.Scene;
  private flags: CheckpointFlag[] = [];
  private originLon = 0;
  private originLat = 0;
  private cosLat = 1;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
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
        // Fade out
        flag.group.traverse((child) => {
          if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) {
            child.material.transparent = true;
            child.material.opacity = 0.2;
          }
        });
      }
    }
  }

  dispose(): void {
    for (const flag of this.flags) {
      this.scene.remove(flag.group);
      flag.group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (child.material instanceof THREE.Material) {
            child.material.dispose();
          }
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
    const group = new THREE.Group();

    // Convert lngLat to local meters
    const dLon = pt.lon - this.originLon;
    const dLat = pt.lat - this.originLat;
    const x = dLon * 111320 * this.cosLat;
    const z = -dLat * 111320;

    // Ground height from raycast or fallback to 0
    const groundY = raycastGround?.(x, z) ?? 0;

    // Pole
    const poleGeo = new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS, POLE_HEIGHT, 6);
    const poleMat = new THREE.MeshStandardMaterial({
      color: POLE_COLOR,
      metalness: 0.6,
      roughness: 0.4,
    });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = POLE_HEIGHT / 2;
    group.add(pole);

    // Flag rectangle
    const flagGeo = new THREE.PlaneGeometry(FLAG_WIDTH, FLAG_HEIGHT);
    const flagMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      side: THREE.DoubleSide,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.3,
    });
    const flagMesh = new THREE.Mesh(flagGeo, flagMat);
    flagMesh.position.set(FLAG_WIDTH / 2, POLE_HEIGHT - FLAG_HEIGHT / 2 - 0.5, 0);
    group.add(flagMesh);

    group.position.set(x, groundY, z);

    return { group, segmentIndex, distanceM: distM, passed: false };
  }
}
