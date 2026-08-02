/**
 * The rider's bike — a desk-ornament bike seen from behind in the third-person
 * diorama view. This module owns the BEHAVIOUR (placement, yaw, corner lean,
 * wheel + crank spin); the LOOK comes from the active style strategy via
 * `buildBikeOrnament()` (cuphead → paperclip bike, plastic → toy brick bike).
 *
 * Local axes of the parts a strategy hands back (matching the demos):
 *  - forward = +x, up = +y, axle = z. Wheels spin about their local z.
 *  - `lean` is the child that takes the roll on corners (rotation.x).
 *
 * Zero external assets — everything procedural.
 */

import * as THREE from 'three';
import type { BikeOrnamentParts, TerrainStyleStrategy } from './terrain-style-strategy';

/**
 * Scale applied to the strategy's bike parts. The demos are drawn at a chunky
 * "toy on a desk" scale (~7 m long) which reads as absurd next to real MVT
 * buildings, so shrink to a slightly-oversized-but-plausible ~3 m bike: big
 * enough to read from the chase camera, small enough to belong on the road.
 */
const BIKE_SCALE = 0.45;

/** Wheel radius in the strategy's local units (both styles use 2.1). */
const WHEEL_RADIUS = 2.1;

/**
 * Crank turns this much slower than the wheels — the FALLBACK gear ratio, used
 * only when nothing is measuring cadence (see `update`).
 *
 * It is a fallback and not the rule because a fixed ratio off the wheel makes
 * the pedals a second speedometer: shift to the big ring, let the cadence halve
 * at the same road speed, and the legs on screen do not change at all. Cadence
 * is a signal the rig usually reports; when it does, the crank turns at that
 * rate and this constant is not consulted.
 */
const CRANK_RATIO = 0.4;

/** Lean smoothing + limit — same feel as the demos. */
const LEAN_GAIN = -0.5;
const LEAN_SMOOTH = 5;
const LEAN_LIMIT = 0.3;

/** Lift the bike a hair off the ground so it never z-fights the road. */
const GROUND_CLEARANCE = 0.12;

export class BikeOrnament {
  private readonly scene: THREE.Scene;
  private parts: BikeOrnamentParts | null = null;
  private prevYaw = 0;
  private lean = 0;
  private hasYaw = false;

  constructor(scene: THREE.Scene, strategy: TerrainStyleStrategy) {
    this.scene = scene;
    this.build(strategy);
  }

  /** Rebuild with a different style (world-style switch). */
  setStrategy(strategy: TerrainStyleStrategy): void {
    this.disposeParts();
    this.build(strategy);
    this.hasYaw = false;
    this.lean = 0;
  }

  private build(strategy: TerrainStyleStrategy): void {
    const parts = strategy.buildBikeOrnament();
    parts.root.scale.setScalar(BIKE_SCALE);
    this.scene.add(parts.root);
    this.parts = parts;
  }

  /**
   * Place + animate the bike.
   *
   * @param position  Rider ground position in scene metres (y = ground level).
   * @param bearingDeg  Heading (0 = north, 90 = east, clockwise).
   * @param speedMps  Ground speed, drives wheel spin (and the crank's fallback).
   * @param dt  Frame time in seconds.
   * @param cadenceRpm  Measured crank cadence in rpm, or `null` when nothing
   *   reports it (`RiderSignals.cadenceRpm`, relayed unchanged). **`0` and
   *   `null` are different answers and must look different:** 0 rpm is a rider
   *   freewheeling and the cranks stand still while the wheels keep turning;
   *   `null` is "no cadence sensor", where standing the cranks still would be a
   *   lie about a rider who is pedalling, so it falls back to
   *   `wheel × CRANK_RATIO` — the behaviour every ride had before this argument
   *   existed. Defaulted so a caller with no cadence to give keeps it.
   */
  update(
    position: THREE.Vector3,
    bearingDeg: number,
    speedMps: number,
    dt: number,
    cadenceRpm: number | null = null,
  ): void {
    const parts = this.parts;
    if (!parts) return;

    parts.root.position.set(
      position.x,
      position.y + GROUND_CLEARANCE * BIKE_SCALE,
      position.z,
    );

    // Bearing → yaw. The bike's local forward is +x, and a +y rotation of θ
    // sends +x to (cos θ, −sin θ) in (x, z); the heading direction is
    // (sin b, −cos b), so θ = π/2 − b.
    const bearingRad = (bearingDeg * Math.PI) / 180;
    const yaw = Math.PI / 2 - bearingRad;
    parts.root.rotation.y = yaw;

    if (!this.hasYaw) {
      this.prevYaw = yaw;
      this.hasYaw = true;
    }

    // Lean into the corner: roll follows the rate of change of yaw.
    let dYaw = yaw - this.prevYaw;
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    this.prevYaw = yaw;

    if (dt > 0) {
      const target = (dYaw / Math.max(dt, 0.001)) * LEAN_GAIN;
      this.lean += (target - this.lean) * Math.min(dt * LEAN_SMOOTH, 1);
      parts.lean.rotation.x = THREE.MathUtils.clamp(this.lean, -LEAN_LIMIT, LEAN_LIMIT);

      // Wheels roll with distance travelled — that one IS geometry (the tyre is
      // on the road), so it stays derived from ground speed.
      const spin = (speedMps * dt) / WHEEL_RADIUS;
      for (const wheel of parts.wheels) wheel.rotation.z -= spin;
      // The crank is NOT: it turns at whatever the rider's legs turn it at.
      // rpm → rad/s is `rpm / 60 × 2π`; no gear ratio, because cadence already
      // IS the crank's own rate.
      if (parts.crank) {
        parts.crank.rotation.z -= cadenceRpm === null
          ? spin * CRANK_RATIO
          : (cadenceRpm / 60) * Math.PI * 2 * dt;
      }
    }
  }

  /** Show/hide (e.g. if a first-person camera mode is selected). */
  setVisible(visible: boolean): void {
    if (this.parts) this.parts.root.visible = visible;
  }

  /** Root object — the ghost rider (P8) reads it to apply translucency after
   *  each build; null before the first build / after dispose. */
  get root(): THREE.Object3D | null {
    return this.parts?.root ?? null;
  }

  private disposeParts(): void {
    if (!this.parts) return;
    this.scene.remove(this.parts.root);
    this.parts.dispose();
    this.parts = null;
  }

  dispose(): void {
    this.disposeParts();
  }
}

/**
 * Collect every geometry + material under a group so a style's
 * `BikeOrnamentParts.dispose()` can free them without bookkeeping. Shared
 * singletons must be tagged `userData.shared` to be skipped.
 *
 * ⚠ **`userData.shared` now means the same thing on a GEOMETRY as it always did
 * on a material**, and it had to: the street lamps hand every lamp in the pool
 * the same barrel/bubble/lens geometry (one shape per world, ~10-20 lamps), so
 * the first lamp recycled used to free the buffer the other nineteen were still
 * drawing from. The flag was already spelled this way on geometry elsewhere
 * (`circuit-terrain-style.ts`'s `luUnit` / `luHarvest`) — this is the same
 * contract reaching the one sweep that did not honour it.
 * CUSTOM_WORLD_INSTRUCTIONS §6「共用的 geometry / material 絕對不可以在 chunk
 * 回收時 dispose」.
 */
export function disposeGroup(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.geometry?.userData?.shared) mesh.geometry?.dispose?.();
    const mat = mesh.material;
    if (Array.isArray(mat)) {
      for (const m of mat) if (m && !m.userData?.shared) materials.add(m);
    } else if (mat instanceof THREE.Material && !mat.userData?.shared) {
      materials.add(mat);
    }
  });
  for (const m of materials) m.dispose();
}
