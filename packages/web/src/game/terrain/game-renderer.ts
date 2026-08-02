/**
 * Standalone Three.js renderer — replaces MapLibre's rendering pipeline.
 *
 * Creates its own WebGLRenderer, Scene, and PerspectiveCamera with no pitch
 * limits, enabling true FPS perspective for the cycling game.
 */

import * as THREE from 'three';
import { CHUNK_LENGTH, CHUNKS_AHEAD } from './terrain-chunk-manager';
import type { ShadowLevel } from '../quality/graphics-quality';
import {
  TONE_MAPPING_EXPOSURE,
  SHADOW_MAP_SIZE,
  SHADOW_HALF_EXTENT,
  SHADOW_NEAR,
  SHADOW_FAR,
  SHADOW_BIAS,
  SHADOW_NORMAL_BIAS,
  SHADOW_LIGHT_DISTANCE,
} from './day-night-lighting';

export interface GameRendererOptions {
  canvas: HTMLCanvasElement;
  /** Field of view in degrees. */
  fov?: number;
  /** Enable antialiasing. */
  antialias?: boolean;
}

/** Default field of view — the demos' 55° chase lens. */
export const DEFAULT_FOV = 55;

/**
 * Camera near/far planes, in metres — exported because the demos carry the same
 * three numbers and `check:3d` asserts all three are equal (`[celestial shell]`).
 * The reasoning for `near = 2` is at the constructor's call site.
 */
export const CAMERA_NEAR = 2;
export const CAMERA_FAR = CHUNK_LENGTH * (CHUNKS_AHEAD + 1); // 8000 m

/** Shadow-map side, in texels, per tier level. 0 = no map at all. */
export const SHADOW_MAP_SIZE_BY_LEVEL: Record<ShadowLevel, number> = {
  off: 0,
  half: SHADOW_MAP_SIZE / 2,
  full: SHADOW_MAP_SIZE,
};

/** Degrees → radians, for the key light's spherical placement. */
const DEG = Math.PI / 180;

/**
 * Give the key light the demos' shadow camera.
 *
 * The demos' block, in the demos' order (`plastic:375-384`, `paper:899-908`,
 * `circuit:706-715`) — everything except `near`/`far`, which are re-derived
 * because gameview's sun moves and the demos' does not. See
 * `SHADOW_VERTICAL_REACH`.
 *
 * Exported as a free function, not folded into the constructor, so the headless
 * check can hand it a bare `DirectionalLight` and read the frustum back. A rule
 * that only exists inside a class you cannot build without WebGL is a rule
 * nothing checks.
 */
export function configureSunShadow(light: THREE.DirectionalLight): void {
  light.castShadow = true;
  const s = light.shadow;
  s.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  s.camera.left = -SHADOW_HALF_EXTENT;
  s.camera.right = SHADOW_HALF_EXTENT;
  s.camera.top = SHADOW_HALF_EXTENT;
  s.camera.bottom = -SHADOW_HALF_EXTENT;
  s.camera.near = SHADOW_NEAR;
  s.camera.far = SHADOW_FAR;
  s.bias = SHADOW_BIAS;
  s.normalBias = SHADOW_NORMAL_BIAS;
  s.camera.updateProjectionMatrix();
}

/**
 * Push a tier's shadow ceiling onto the renderer + key light.
 *
 * Duck-typed on the renderer so the check can pass a stub — the same shape
 * `demo-probe.mjs` already uses. Resizing frees the old depth target and lets
 * three allocate the new one on the next frame; nothing recompiles, because the
 * FILTER never moves (see `ShadowLevel`).
 */
export function applySunShadowLevel(
  renderer: { shadowMap: { enabled: boolean; type: THREE.ShadowMapType } },
  light: THREE.DirectionalLight,
  level: ShadowLevel,
): void {
  const size = SHADOW_MAP_SIZE_BY_LEVEL[level];
  renderer.shadowMap.enabled = size > 0;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  light.castShadow = size > 0;
  if (size === 0) return;
  if (light.shadow.mapSize.width !== size) {
    // three allocates `shadow.map` lazily and never resizes it in place.
    light.shadow.map?.dispose();
    light.shadow.map = null;
    light.shadow.mapSize.set(size, size);
  }
}

/**
 * Park the key light and its target so the shadow box rides with the rider.
 *
 * > ── 燈光(跟著騎手,不然騎出陰影相機範圍)──   `paper-town-demo.html:897`
 *
 * The demos do exactly this every frame:
 *
 *     sunLight.position.set(bp.x + 150, 190, bp.z + 90);
 *     sunTarget.position.set(bp.x, 0, bp.z);
 *
 * — a fixed offset, because their sun never moves. Ours does, so the offset is
 * `direction × SHADOW_LIGHT_DISTANCE` instead; the shape is the demos'.
 *
 * FLOATING ORIGIN: `rider` is the rider's LIVE scene position, re-read every
 * frame, and nothing here is remembered between frames. A rebase
 * (`TerrainChunkManager.updateOrigin`) shifts the rider and every caster by the
 * same delta, so the box shifts with them and the shadows do not move relative to
 * anything. This is the reason not to anchor on `originEle` or on a cached scene
 * coordinate — the terrain-banding port was bitten by exactly that
 * (`quantized-terrain.ts`).
 *
 * (`updateOrigin` has no caller today — the origin is resolved once from the
 * route's first point. Written for it anyway: the method exists, and "the shadows
 * jump the first time anyone wires it up" is not a bug worth waiting for.)
 */
export function anchorSunShadow(
  light: THREE.DirectionalLight,
  target: THREE.Object3D,
  rider: THREE.Vector3,
  direction: THREE.Vector3,
): void {
  target.position.copy(rider);
  light.position.copy(rider).addScaledVector(direction, SHADOW_LIGHT_DISTANCE);
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  // Lights (exposed for weather system to adjust)
  readonly ambientLight: THREE.AmbientLight;
  readonly directionalLight: THREE.DirectionalLight;
  readonly hemisphereLight: THREE.HemisphereLight;

  /** The key light's aim point — the demos' `sunTarget`, and the shadow box's
   *  centre. Must be IN the scene: three reads `light.target.matrixWorld`, and a
   *  detached target silently leaves it at the world origin. */
  readonly sunTarget: THREE.Object3D;

  /** Unit vector from the rider TOWARD the key light. Owned here rather than
   *  written into `directionalLight.position` by the caller, because the position
   *  now carries the rider anchor as well and the two cannot share one field. */
  private readonly keyLightDir = new THREE.Vector3(0, 1, 0);

  /** The two owners of `directionalLight.castShadow`: the quality tier's ceiling
   *  and the sky's horizon gain. See `syncKeyLightCastShadow`. */
  private shadowLevel: ShadowLevel = 'full';
  private keyLightGain = 1;

  private fog: THREE.Fog;
  private disposed = false;

  constructor(options: GameRendererOptions) {
    // 55°, the demos' lens. The old 75° was a first-person wide angle: it pushes
    // the world away and exaggerates perspective, which is what kept the chase
    // camera looking like the old bird's-eye view no matter where we put it.
    // antialias defaults OFF: the scene is drawn into EffectComposer render
    // targets (no MSAA there); canvas MSAA would only smooth the final
    // full-screen quad — pure cost on an iGPU with zero visual benefit.
    const { canvas, fov = DEFAULT_FOV, antialias = false } = options;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias,
      alpha: false,
      // Browsers default to 'default', which lets the driver pick — and on some
      // machines that means the power-saving path even when nothing else is
      // competing for the GPU. The N100 has no second GPU to switch to, so this
      // is a hint about clock/power state rather than device selection. Free to
      // set; do not attribute later frame-time changes to it without measuring.
      powerPreference: 'high-performance',
    });
    // Cap at 1.5 rather than 2: post-processing runs several full-screen passes
    // (bloom chain + glasses + tunnel + optional paper), so fill rate dominates.
    // 1.5 cuts ~44% of shaded pixels vs 2.0 with little perceptible quality loss.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Constant — the day/night system no longer modulates exposure (see
    // day-night-lighting.ts). Matches the demos.
    this.renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb); // sky blue default

    // Fog
    this.fog = new THREE.Fog(0xdce6f0, 500, 2000);
    this.scene.fog = this.fog;

    // Camera — no pitch limit, far plane beyond fog to prevent pop-in
    // near = 2, not 0.5. Depth-buffer precision is inversely proportional to
    // the near plane, and 0.5 spent almost the whole 24-bit range on the first
    // few metres: at 1 km it resolved ~12 cm, at 2 km ~48 cm — coarser than the
    // entire stack of ground overlays (landuse 0.02–0.10 m, road 0.30 m, route
    // 0.45 m), so on a distant hillside the terrain and everything laid on it
    // interleaved per-pixel. Raising it to 2 divides the error by four and
    // costs nothing. Safe: the chase camera sits ~13 m from the rider and
    // free-look orbit clamps to 33 m, so nothing ever comes near 2 m.
    // (`far` is NOT the lever — precision is dominated by near.)
    // The three demos now declare the same 55 / 2 / 8000, and `[celestial
    // shell]` executes their camera line and asserts all three match.
    this.camera = new THREE.PerspectiveCamera(
      fov,
      canvas.clientWidth / canvas.clientHeight,
      CAMERA_NEAR,
      CAMERA_FAR,
    );

    // Lights
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    this.scene.add(this.ambientLight);

    this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this.directionalLight.position.set(100, 200, 100);
    this.scene.add(this.directionalLight);
    this.sunTarget = new THREE.Object3D();
    this.scene.add(this.sunTarget);
    this.directionalLight.target = this.sunTarget;

    this.hemisphereLight = new THREE.HemisphereLight(0x87ceeb, 0x556633, 0.7);
    this.scene.add(this.hemisphereLight);

    // Shadows. The frustum is fixed for the life of the renderer; only the map
    // size moves, with the tier (`setShadowLevel`). Starts at the demos' size —
    // `applyQualityTier` overwrites it before the first frame.
    configureSunShadow(this.directionalLight);
    applySunShadowLevel(this.renderer, this.directionalLight, 'full');
  }

  /**
   * Aim the key light, in horizon coordinates (the real sun's, or the moon's).
   *
   * Replaces the caller writing `directionalLight.position` directly: the
   * position now has to carry the rider anchor too, so direction and anchor are
   * set through separate doors. The spherical conversion is the one
   * `sky-and-fog.ts` used to do inline, unchanged.
   */
  setKeyLightDirection(elevationDeg: number, azimuthDeg: number): void {
    this.keyLightDir.setFromSphericalCoords(1, DEG * (90 - elevationDeg), DEG * azimuthDeg);
    // Re-park at the anchor we already have. `sunTarget.position` IS the anchor,
    // so this both reads and writes it — a no-op on the target, and the point is
    // the light: without it the sun would keep yesterday's direction baked into
    // its position until the next frame's `updateShadowAnchor`.
    anchorSunShadow(
      this.directionalLight, this.sunTarget, this.sunTarget.position, this.keyLightDir,
    );
  }

  /**
   * Move the shadow box onto the rider. Call once per frame, alongside the other
   * things that ride with the rider (`mountainRing.update`, `acrylicCase.update`).
   */
  updateShadowAnchor(rider: THREE.Vector3): void {
    anchorSunShadow(this.directionalLight, this.sunTarget, rider, this.keyLightDir);
  }

  /** Push the quality tier's shadow ceiling onto the renderer + key light. */
  setShadowLevel(level: ShadowLevel): void {
    this.shadowLevel = level;
    applySunShadowLevel(this.renderer, this.directionalLight, level);
    this.syncKeyLightCastShadow();
  }

  /**
   * The sky's horizon gain (`SkyAndFog`, `skyKeyGainAt`): 0 at and below the
   * horizon, full above this world's own threshold.
   *
   * The demos write both halves side by side —
   *
   *     sunLight.intensity = (…) * skyKeyGain;
   *     sunLight.castShadow = skyKeyGain > 0;
   *
   * — because their `castShadow` has exactly one owner. Ours has two: the
   * quality tier turns the shadow map off entirely (`setShadowLevel`), and
   * writing `castShadow = gain > 0` from the sky would switch it back on behind
   * the tier's back — a shader recompile for every material, on a machine that
   * had just asked for fewer of them. So the gain comes in through here and the
   * light casts only when BOTH say yes.
   */
  setKeyLightShadowGain(gain: number): void {
    this.keyLightGain = gain;
    this.syncKeyLightCastShadow();
  }

  private syncKeyLightCastShadow(): void {
    this.directionalLight.castShadow =
      SHADOW_MAP_SIZE_BY_LEVEL[this.shadowLevel] > 0 && this.keyLightGain > 0;
  }

  /**
   * The world's own normal offset (`TerrainStyleStrategy.shadowNormalBias`).
   *
   * Separate from `configureSunShadow` because the light is built before any
   * strategy exists, and because `setWorldStyle` swaps worlds mid-ride — the
   * bias has to follow. Unlike the shadow-map FILTER, `normalBias` is a plain
   * uniform: changing it recompiles nothing.
   */
  setSunShadowNormalBias(metres: number | undefined): void {
    this.directionalLight.shadow.normalBias = metres ?? SHADOW_NORMAL_BIAS;
  }

  /** Call once per frame to render. */
  render(): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  /** Handle canvas resize. */
  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  /**
   * Set the device pixel ratio cap (quality tiers: 1.0 / 1.25 / 1.5).
   * Callers owning an EffectComposer must re-run their resize path afterwards
   * so composer targets pick up the new ratio.
   */
  setPixelRatio(ratio: number): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, ratio));
  }

  /** Update fog distances (used by weather system). */
  setFog(near: number, far: number, color?: number): void {
    this.fog.near = near;
    this.fog.far = far;
    if (color !== undefined) {
      this.fog.color.setHex(color);
    }
  }

  /** Update scene background color. */
  setBackground(color: number): void {
    (this.scene.background as THREE.Color).setHex(color);
  }

  /** Update tone mapping exposure (used by day/night system). */
  setToneMappingExposure(value: number): void {
    this.renderer.toneMappingExposure = value;
  }

  /** Clean up all resources. */
  dispose(): void {
    this.disposed = true;
    // The shadow depth target is 4–16 MB and three does not free it with the
    // renderer.
    this.directionalLight.shadow.dispose();
    this.renderer.dispose();
  }
}
