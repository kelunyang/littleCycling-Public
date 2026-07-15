/**
 * Free-look orbit camera — the demos' 「自由」 view.
 *
 * The camera swings around the bike on a sphere: drag to rotate, wheel to zoom.
 * It always looks AT the rider, so the bike stays the subject however you turn
 * the world — this is for admiring the diorama, not for riding it.
 *
 * The chase camera lives in `fps-camera.ts`; this owns only the orbit state and
 * the pointer input, so the input listeners can be attached and torn down with
 * the mode rather than running all the time.
 */

import * as THREE from 'three';

/** Demo values scaled by 0.66 — our bike is 4.6 m to the demos' 7 m. */
const DEFAULT_RADIUS = 130;
const MIN_RADIUS = 33;
const MAX_RADIUS = 300;

/** Vertical angle limits (radians from +y). Never quite overhead, never below ground. */
const MIN_PHI = 0.15;
const MAX_PHI = 1.35;

/** Height above the rider's ground that the camera aims at (demo: 4 m × 0.66). */
const LOOK_HEIGHT = 2.6;

const DRAG_SPEED = 0.005;
const PITCH_SPEED = 0.004;
const ZOOM_SPEED = 0.25;

export class OrbitCamera {
  private readonly canvas: HTMLCanvasElement;

  private theta = 0.6;
  private phi = 0.95;
  private radius = DEFAULT_RADIUS;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private attached = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  /** Start listening for drag/wheel. Idempotent. */
  attach(): void {
    if (this.attached) return;
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    // Not passive: we preventDefault so the wheel zooms the world, not the page.
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.attached = true;
  }

  /** Stop listening (leaving free-look) and drop any drag in progress. */
  detach(): void {
    if (!this.attached) return;
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.dragging = false;
    this.attached = false;
  }

  /** Put the camera on its sphere around the rider and aim it at the bike. */
  update(camera: THREE.PerspectiveCamera, riderPosition: THREE.Vector3): void {
    const sinPhi = Math.sin(this.phi);
    camera.position.set(
      riderPosition.x + Math.cos(this.theta) * sinPhi * this.radius,
      riderPosition.y + Math.cos(this.phi) * this.radius,
      riderPosition.z + Math.sin(this.theta) * sinPhi * this.radius,
    );
    camera.lookAt(riderPosition.x, riderPosition.y + LOOK_HEIGHT, riderPosition.z);
  }

  dispose(): void {
    this.detach();
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.canvas.setPointerCapture(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    this.theta -= (e.clientX - this.lastX) * DRAG_SPEED;
    this.phi = THREE.MathUtils.clamp(
      this.phi - (e.clientY - this.lastY) * PITCH_SPEED,
      MIN_PHI,
      MAX_PHI,
    );
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private readonly onPointerUp = (): void => {
    this.dragging = false;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.radius = THREE.MathUtils.clamp(
      this.radius + e.deltaY * ZOOM_SPEED,
      MIN_RADIUS,
      MAX_RADIUS,
    );
  };
}
