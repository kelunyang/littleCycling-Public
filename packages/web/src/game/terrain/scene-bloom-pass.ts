/**
 * The demos' hand-rolled SCENE bloom, ported into gameview's composer.
 *
 * ── Which bloom this is ─────────────────────────────────────────────────────
 *
 * NOT `QualityParams.bloomEnabled`. That flag gates the CYCLING-GLASSES bloom in
 * `cycling-glasses-effect.ts`: a second render of the scene with the camera
 * masked to `BLOOM_LAYER`, blurred through `UnrealBloomPass` and composited back
 * — a selective glow for objects that opt in. This is the other thing: a
 * whole-scene threshold bloom, where anything bright enough spills, which is
 * what the six demos do (`plan/circuit-town-demo.html`, `buildPost`).
 *
 * They coexist. Nothing here touches the glasses chain.
 *
 * ── What changed on the way across ──────────────────────────────────────────
 *
 * The demos' composite pass ends with exposure → ACES → sRGB, hand-written,
 * because their three bundle carries no post-processing addons at all and
 * therefore no `OutputPass`. Render targets in three r152+ get neither tone
 * mapping nor sRGB encoding, and the documented consequence of skipping that
 * work is a night that renders **black**.
 *
 * gameview's chain already ends in a real `OutputPass` (glasses composer, and
 * the standalone composer in `useTerrainRenderer`), and this pass is inserted
 * BEFORE it. So the composite here must NOT tone map and must NOT encode — it
 * takes linear HDR in and hands linear HDR on, and `OutputPass` does its job
 * exactly once. Doing it here as well would double-encode: a washed-out,
 * grey-black picture, which looks enough like "bloom is too strong" to send
 * somebody tuning the wrong number for a day.
 *
 * ── Shape of the chain ──────────────────────────────────────────────────────
 *
 *   readBuffer ─▶ bright pass (½ res) ─▶ blur H,V (½ res, `full` only)
 *                                     └▶ blur H,V (¼ res)
 *   readBuffer + blurs ─▶ additive composite ─▶ writeBuffer
 *
 * Two levels, not `UnrealBloomPass`'s five mips: the target machine is an N100,
 * and on the demo the step from the cheap chain to the full one cost exactly one
 * vsync (+16.6 ms) with `jsMs` unmoved — pure GPU, and it scales with PIXELS.
 * `cheap` drops the half-res blur pair, which is the near-end detail of a glow
 * that is by definition blurry.
 *
 * ── Why it disables itself ──────────────────────────────────────────────────
 *
 * DEVPLAN gives the toy world a *very weak, night-only* bloom, so the strength
 * is zero for most of a daytime ride. At zero the pass sets `enabled = false`
 * and `EffectComposer` skips it whole — no render targets bound, no full-screen
 * quads, no buffer swap. Daylight costs one comparison.
 */

import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { SceneBloomLevel } from '@/game/quality/graphics-quality';

/**
 * How much of the chain runs.
 *
 *  · `off`   — the pass never renders (low tier, or the rider's switch off).
 *  · `cheap` — bright pass + one quarter-res blur pair. The demos' default.
 *  · `full`  — plus the half-res blur pair, for the near end of the glow.
 *
 * Re-exported from `graphics-quality.ts` rather than declared again — the tier
 * table and this module must mean the same three words, and two structurally
 * identical unions type-check happily while drifting apart.
 */
export type { SceneBloomLevel };

/** Below this the glow is not visible and the pass switches itself off. */
const STRENGTH_EPSILON = 0.002;

const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Bright pass. The threshold is on LUMINANCE (0.2126R + 0.7152G + 0.0722B), not
 * on any channel — a demo pitfall worth restating, because pure red scores 0.21
 * and no amount of "make the tail light redder" will ever make it bloom.
 */
const BRIGHT_FRAGMENT = /* glsl */ `
  uniform sampler2D tSrc;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tSrc, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + uKnee, l), 1.0);
  }
`;

/** 5-tap linear-sampled gaussian (9 taps' worth). `uDir` picks the axis. */
const BLUR_FRAGMENT = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uDir;
  varying vec2 vUv;
  void main() {
    vec3 s = texture2D(tSrc, vUv).rgb * 0.227027;
    s += (texture2D(tSrc, vUv + uDir * 1.3846).rgb + texture2D(tSrc, vUv - uDir * 1.3846).rgb) * 0.316216;
    s += (texture2D(tSrc, vUv + uDir * 3.2308).rgb + texture2D(tSrc, vUv - uDir * 3.2308).rgb) * 0.070270;
    gl_FragColor = vec4(s, 1.0);
  }
`;

/**
 * Additive composite. LINEAR IN, LINEAR OUT — `OutputPass` owns tone mapping and
 * sRGB, and doing either here would apply it twice. See the header.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tBloomA;
  uniform sampler2D tBloomB;
  uniform float uStrength;
  uniform float uMixA;
  varying vec2 vUv;
  void main() {
    vec4 base = texture2D(tDiffuse, vUv);
    vec3 glow = texture2D(tBloomA, vUv).rgb * uMixA
              + texture2D(tBloomB, vUv).rgb * (1.0 - uMixA);
    gl_FragColor = vec4(base.rgb + glow * uStrength, base.a);
  }
`;

/** Half-resolution weight when both levels run (the demos' 0.62 / 0.38 split). */
const MIX_A_FULL = 0.62;

interface BloomTargets {
  bright: THREE.WebGLRenderTarget;
  b1: THREE.WebGLRenderTarget;
  b2: THREE.WebGLRenderTarget;
  /** Half-res blur pair — allocated only at `full`. */
  a1: THREE.WebGLRenderTarget | null;
  a2: THREE.WebGLRenderTarget | null;
}

/**
 * A `ShaderPass` whose `render()` runs the bright/blur chain into its own render
 * targets first and then lets `ShaderPass` do the composite.
 *
 * Subclassing rather than hand-rolling a `Pass` keeps `renderToScreen`, the
 * composer's ping-pong, `clear` handling and `dispose()` exactly as every other
 * pass in the chain has them — and it satisfies `createPostPass(): ShaderPass`,
 * which is the one injection point a strategy gets into the glasses composer.
 */
export class SceneBloomPass extends ShaderPass {
  private level: SceneBloomLevel;
  private strength = 0;
  private targets: BloomTargets | null = null;
  /** DEVICE pixels — `EffectComposer.setSize` already multiplies by the ratio. */
  private width: number;
  private height: number;

  private readonly brightMat: THREE.ShaderMaterial;
  private readonly blurMat: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor(width: number, height: number, opts?: {
    level?: SceneBloomLevel;
    threshold?: number;
    knee?: number;
  }) {
    super({
      name: 'SceneBloomComposite',
      uniforms: {
        tDiffuse: { value: null },
        tBloomA: { value: null },
        tBloomB: { value: null },
        uStrength: { value: 0 },
        uMixA: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
    });

    this.width = Math.max(2, Math.round(width));
    this.height = Math.max(2, Math.round(height));
    this.level = opts?.level ?? 'cheap';

    this.brightMat = new THREE.ShaderMaterial({
      name: 'SceneBloomBright',
      uniforms: {
        tSrc: { value: null },
        uThreshold: { value: opts?.threshold ?? 0.85 },
        uKnee: { value: opts?.knee ?? 0.35 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: BRIGHT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      name: 'SceneBloomBlur',
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: BLUR_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.brightMat);

    // Nothing to bloom until somebody says how much. Starting enabled would
    // add a black full-screen quad to the very first frame.
    this.enabled = false;
  }

  /**
   * The tier's ceiling (and the fps governor's lever). `off` stops the pass
   * dead and frees its render targets, which is the point on the machine that
   * needed the governor in the first place.
   */
  setLevel(level: SceneBloomLevel): void {
    if (this.level === level) return;
    this.level = level;
    this.disposeTargets();
    this.refreshEnabled();
  }

  /** Glow strength, driven by the day/night blend. 0 switches the pass off. */
  setStrength(strength: number): void {
    this.strength = Math.max(0, strength);
    this.uniforms['uStrength'].value = this.strength;
    this.refreshEnabled();
  }

  /** Luminance above which a pixel starts to spill, and the soft knee width. */
  setThreshold(threshold: number, knee: number): void {
    this.brightMat.uniforms['uThreshold'].value = threshold;
    this.brightMat.uniforms['uKnee'].value = knee;
  }

  /** What the pass would draw right now (tier ∧ strength) — the checks read it. */
  getEffectiveLevel(): SceneBloomLevel {
    return this.enabled ? this.level : 'off';
  }

  setSize(width: number, height: number): void {
    const w = Math.max(2, Math.round(width));
    const h = Math.max(2, Math.round(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    // Rebuilt lazily on the next enabled frame, so a resize while the pass is
    // off costs nothing.
    this.disposeTargets();
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    const rt = this.ensureTargets();

    // Bright pass, at half resolution — the blur is about to destroy anything
    // finer than that anyway.
    this.brightMat.uniforms['tSrc'].value = readBuffer.texture;
    this.blit(renderer, this.brightMat, rt.bright);

    let coarseSource = rt.bright;
    if (this.level === 'full' && rt.a1 && rt.a2) {
      this.blur(renderer, rt.bright.texture, rt.a1, 1 / rt.bright.width, 0);
      this.blur(renderer, rt.a1.texture, rt.a2, 0, 1 / rt.bright.height);
      coarseSource = rt.a2;
      this.uniforms['tBloomA'].value = rt.a2.texture;
      this.uniforms['uMixA'].value = MIX_A_FULL;
    } else {
      // One sampler still has to point at a real texture; weight zero means it
      // contributes nothing.
      this.uniforms['tBloomA'].value = rt.b2.texture;
      this.uniforms['uMixA'].value = 0;
    }

    // Quarter-res level: downsample and blur in the same two passes.
    this.blur(renderer, coarseSource.texture, rt.b1, 1 / rt.b1.width, 0);
    this.blur(renderer, rt.b1.texture, rt.b2, 0, 1 / rt.b1.height);
    this.uniforms['tBloomB'].value = rt.b2.texture;

    // ShaderPass binds `tDiffuse` from readBuffer and writes the composite to
    // writeBuffer (or the screen, if the composer made this the last pass).
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }

  dispose(): void {
    this.disposeTargets();
    this.brightMat.dispose();
    this.blurMat.dispose();
    // NOT `this.quad.dispose()`. Every `FullScreenQuad` in three shares ONE
    // module-level geometry, so disposing it here would yank the buffer out from
    // under the glasses, tunnel and output passes as well. `super.dispose()`
    // already does it once (for its own quad), which is one time too many
    // already — a second call buys nothing and doubles the re-upload.
    super.dispose();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private refreshEnabled(): void {
    const on = this.level !== 'off' && this.strength > STRENGTH_EPSILON;
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) this.disposeTargets();
  }

  private blur(
    renderer: THREE.WebGLRenderer,
    source: THREE.Texture,
    target: THREE.WebGLRenderTarget,
    dx: number,
    dy: number,
  ): void {
    this.blurMat.uniforms['tSrc'].value = source;
    (this.blurMat.uniforms['uDir'].value as THREE.Vector2).set(dx, dy);
    this.blit(renderer, this.blurMat, target);
  }

  /** One full-screen pass. No clear: the quad covers every texel of the target. */
  private blit(
    renderer: THREE.WebGLRenderer,
    material: THREE.Material,
    target: THREE.WebGLRenderTarget,
  ): void {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  private ensureTargets(): BloomTargets {
    if (this.targets) return this.targets;
    // HalfFloat, because the threshold has to happen in LINEAR HDR. An 8-bit
    // target clamps at 1.0, which makes a lamp filament and a white sign the
    // same value and leaves the bright pass nothing to tell apart.
    const base: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    };
    const at = (div: number): THREE.WebGLRenderTarget => new THREE.WebGLRenderTarget(
      Math.max(2, Math.round(this.width / div)),
      Math.max(2, Math.round(this.height / div)),
      base,
    );
    const full = this.level === 'full';
    this.targets = {
      bright: at(2),
      b1: at(4),
      b2: at(4),
      a1: full ? at(2) : null,
      a2: full ? at(2) : null,
    };
    return this.targets;
  }

  private disposeTargets(): void {
    if (!this.targets) return;
    for (const rt of Object.values(this.targets)) rt?.dispose();
    this.targets = null;
  }
}

/** Is this the scene bloom, as opposed to a style's own screen-space pass? */
export function isSceneBloomPass(pass: unknown): pass is SceneBloomPass {
  return pass instanceof SceneBloomPass;
}
