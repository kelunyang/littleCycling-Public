/**
 * Procedural lightning bolt for Three.js — billboard sprite that draws a
 * zigzag polyline with three layered passes (outer glow, mid, core) onto
 * a canvas texture, then fades over ~250ms.
 *
 * No global ambient/directional light changes — the day/night system
 * resets light intensity each frame, and we want the bolt to look like
 * a localised flash rather than a screen-wide flicker.
 */

import * as THREE from 'three';

interface Pt { x: number; y: number }

const CANVAS_SIZE = 512;
/** World-space sprite scale — large enough to read in skybox. */
const SPRITE_SCALE = 200;
/** Fade-out duration in seconds. */
const FADE_DURATION_SEC = 0.25;
/** Forward distance from camera to spawn the sprite. */
const FORWARD_DISTANCE = 80;
/** Vertical offset above camera (places bolt high in sky). */
const VERTICAL_OFFSET = 30;

export class LightningBolt {
  private sprite: THREE.Sprite;
  private texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private fadeRemaining = 0;
  private peakOpacity = 0;

  constructor(scene: THREE.Scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_SIZE;
    this.canvas.height = CANVAS_SIZE;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;

    const mat = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.scale.set(SPRITE_SCALE, SPRITE_SCALE, 1);
    this.sprite.renderOrder = 999;
    scene.add(this.sprite);
  }

  /** Trigger a flash. Caller schedules the second strike via setTimeout. */
  trigger(intensityMul = 1): void {
    this.drawBolt(intensityMul);
    this.texture.needsUpdate = true;
    this.peakOpacity = Math.min(1, 0.95 * intensityMul);
    (this.sprite.material as THREE.SpriteMaterial).opacity = this.peakOpacity;
    this.fadeRemaining = FADE_DURATION_SEC;
  }

  /** Per-frame update — fade alpha, reposition in front of camera. */
  update(dt: number, cameraPos: THREE.Vector3, cameraQuat: THREE.Quaternion): void {
    const mat = this.sprite.material as THREE.SpriteMaterial;
    if (this.fadeRemaining > 0) {
      this.fadeRemaining -= dt;
      const t = Math.max(0, this.fadeRemaining / FADE_DURATION_SEC);
      mat.opacity = this.peakOpacity * t;
      if (this.fadeRemaining <= 0) mat.opacity = 0;
    }

    if (mat.opacity > 0) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraQuat);
      this.sprite.position
        .copy(cameraPos)
        .addScaledVector(fwd, FORWARD_DISTANCE);
      this.sprite.position.y += VERTICAL_OFFSET;
    }
  }

  dispose(): void {
    this.sprite.parent?.remove(this.sprite);
    this.texture.dispose();
    (this.sprite.material as THREE.Material).dispose();
  }

  // ── Bolt rendering ──

  private drawBolt(intensityMul: number): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    const startX = CANVAS_SIZE * (0.35 + Math.random() * 0.3);
    const pts = generateZigzag(
      { x: startX, y: 30 },
      CANVAS_SIZE * 0.18,
      CANVAS_SIZE * 0.7,
      12 + Math.floor(Math.random() * 3),
    );

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Outer glow (additive)
    ctx.globalCompositeOperation = 'lighter';
    strokePoly(ctx, pts, 24, `rgba(180,200,255,${0.18 * intensityMul})`);
    strokePoly(ctx, pts, 14, `rgba(200,220,255,${0.28 * intensityMul})`);
    // Mid + core (over)
    ctx.globalCompositeOperation = 'source-over';
    strokePoly(ctx, pts, 8, `rgba(220,230,255,${0.5 * intensityMul})`);
    strokePoly(ctx, pts, 2, `rgba(255,255,255,1.0)`);

    // 70% chance: side branch
    if (Math.random() < 0.7) {
      const branchAt = pts[Math.floor(pts.length * 0.35)];
      const branchPts = generateZigzag(
        branchAt,
        CANVAS_SIZE * 0.10,
        CANVAS_SIZE * 0.25,
        4 + Math.floor(Math.random() * 3),
      );
      ctx.globalCompositeOperation = 'lighter';
      strokePoly(ctx, branchPts, 10, `rgba(180,200,255,${0.18 * intensityMul})`);
      ctx.globalCompositeOperation = 'source-over';
      strokePoly(ctx, branchPts, 4, `rgba(220,230,255,${0.4 * intensityMul})`);
      strokePoly(ctx, branchPts, 1, `rgba(255,255,255,0.9)`);
    }
  }
}

function generateZigzag(
  start: Pt,
  jitterX: number,
  totalHeight: number,
  segments: number,
): Pt[] {
  const pts: Pt[] = [{ x: start.x, y: start.y }];
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    pts.push({
      x: start.x + (Math.random() - 0.5) * 2 * jitterX,
      y: start.y + totalHeight * t,
    });
  }
  return pts;
}

function strokePoly(
  ctx: CanvasRenderingContext2D,
  pts: Pt[],
  lineWidth: number,
  strokeStyle: string,
): void {
  if (pts.length < 2) return;
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = strokeStyle;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}
