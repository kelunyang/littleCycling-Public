/**
 * Procedurally generated cyclist sprite with pedaling animation.
 *
 * Pixel-art style: circle head, rectangular body, line limbs + bicycle outline.
 * 4 pose variations × 6-frame pedaling animation generated on Canvas.
 *
 * Poses:
 * - normal: default riding position
 * - standing: out of saddle, body upright, slight rock
 * - aero: tucked position for descents/high speed
 * - sprint: aggressive forward lean with rapid rock
 *
 * Animation speed is driven by cadence RPM from the sensor bridge.
 */

import Phaser from 'phaser';
import type { PhaserStyleStrategy } from './phaser-style-strategy';

const FRAME_COUNT = 6;

type CyclistPose = 'normal' | 'standing' | 'aero' | 'sprint';

interface PoseParams {
  torsoAngle: number;    // torso lean (degrees, 0=upright, positive=forward)
  hipOffsetY: number;    // hip rise above saddle (px, 0=seated)
  headTilt: number;      // head vertical offset (px, negative=tucked)
  rockAmplitude: number; // left-right sway per frame (px)
}

const POSE_PARAMS: Record<CyclistPose, PoseParams> = {
  normal:   { torsoAngle: 35, hipOffsetY: 0, headTilt: 0, rockAmplitude: 0 },
  standing: { torsoAngle: 15, hipOffsetY: 4, headTilt: 1, rockAmplitude: 1.5 },
  aero:     { torsoAngle: 55, hipOffsetY: 0, headTilt: -2, rockAmplitude: 0 },
  sprint:   { torsoAngle: 45, hipOffsetY: 2, headTilt: -1, rockAmplitude: 2.5 },
};

const ALL_POSES: CyclistPose[] = ['normal', 'standing', 'aero', 'sprint'];

function spriteKey(pose: CyclistPose) { return `__cyclist_${pose}__`; }
function animKey(pose: CyclistPose) { return `pedal_${pose}`; }

/**
 * Generate all pose spritesheets and create the animation defs.
 * Call once during scene.create().
 */
export function createCyclistSprite(scene: Phaser.Scene, strategy: PhaserStyleStrategy): Phaser.GameObjects.Sprite {
  for (const pose of ALL_POSES) {
    const key = spriteKey(pose);
    if (!scene.textures.exists(key)) {
      generateSpritesheet(scene, pose, strategy);
    }
    if (!scene.anims.exists(animKey(pose))) {
      scene.anims.create({
        key: animKey(pose),
        frames: scene.anims.generateFrameNumbers(key, { start: 0, end: FRAME_COUNT - 1 }),
        frameRate: 8,
        repeat: -1,
      });
    }
  }

  const sprite = scene.add.sprite(0, 0, spriteKey('normal'));
  sprite.setOrigin(0.5, 1);
  sprite.setDepth(500);
  sprite.play(animKey('normal'));

  // Store current pose for change detection
  (sprite as any)._currentPose = 'normal';

  return sprite;
}

/**
 * Update cyclist sprite each frame.
 */
export function updateCyclistSprite(
  sprite: Phaser.GameObjects.Sprite,
  opts: {
    worldX: number;
    worldY: number;
    slopeDeg: number;
    cadenceRpm: number;
    isDarkened: boolean;
    slopePercent?: number;
    speedKmh?: number;
  },
  strategy?: PhaserStyleStrategy,
) {
  sprite.setPosition(opts.worldX, opts.worldY);

  // Rotate based on terrain slope
  sprite.setRotation(opts.slopeDeg * (Math.PI / 180));

  // Determine pose
  const slope = opts.slopePercent ?? 0;
  const speed = opts.speedKmh ?? 0;
  const cadence = opts.cadenceRpm;
  let targetPose: CyclistPose = 'normal';

  if (opts.isDarkened && cadence > 95) {
    // Zone 5 + high cadence → sprint
    targetPose = 'sprint';
  } else if (slope > 8) {
    // Steep uphill → standing
    targetPose = 'standing';
  } else if (slope < -3 || speed > 35) {
    // Descent or high speed → aero
    targetPose = 'aero';
  }

  // Switch animation only when pose changes
  const currentPose = (sprite as any)._currentPose as CyclistPose;
  if (targetPose !== currentPose) {
    (sprite as any)._currentPose = targetPose;
    sprite.play(animKey(targetPose));
  }

  // Pedaling speed from cadence (RPM → frames/sec)
  const frameRate = Math.max(1, (cadence / 60) * FRAME_COUNT);
  if (sprite.anims.currentAnim) {
    sprite.anims.currentAnim.frameRate = frameRate;
  }

  // Zone 5 tint (style-dependent)
  if (strategy) {
    const tint = strategy.getCyclistZone5Tint(opts.isDarkened);
    if (tint !== null) {
      sprite.setTint(tint);
    } else {
      sprite.clearTint();
    }
  } else {
    // Fallback: original plastic behavior
    if (opts.isDarkened) {
      const flash = Math.sin(Date.now() * 0.01) > 0;
      sprite.setTint(flash ? 0xff3333 : 0xcc2222);
    } else {
      sprite.clearTint();
    }
  }
}

/** Generate a 6-frame spritesheet for a given pose — delegates to strategy. */
function generateSpritesheet(scene: Phaser.Scene, pose: CyclistPose, strategy: PhaserStyleStrategy) {
  const params = POSE_PARAMS[pose];
  const { w: frameW, h: frameH } = strategy.getCyclistFrameSize();
  const canvas = document.createElement('canvas');
  canvas.width = frameW * FRAME_COUNT;
  canvas.height = frameH;
  const ctx = canvas.getContext('2d')!;

  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    const ox = frame * frameW;
    strategy.generateCyclistFrame(ctx, ox, frame, pose, params);
  }

  const key = spriteKey(pose);
  const canvasTex = scene.textures.addCanvas(key + '_src', canvas);
  scene.textures.addSpriteSheet(
    key,
    canvasTex!.getSourceImage() as HTMLImageElement,
    { frameWidth: frameW, frameHeight: frameH },
  );
}
