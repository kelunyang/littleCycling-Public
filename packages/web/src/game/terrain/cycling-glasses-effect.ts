/**
 * Post-processing effect simulating cycling glasses view.
 *
 * Effects:
 * - 5 lens modes: clear, dark, red, yellow, auto (weather-dependent)
 * - Lens tint with configurable contrast
 * - Vignette (darkened edges)
 * - Subtle barrel distortion (lens curvature)
 * - Coin collection gold glow (triggered on pickup, fades out)
 * - Lens marks overlay (rain/snow/dust/coin/leaf scratches)
 * - Tunnel vision (radial blur at edges under high HR/speed)
 * - **Selective bloom** (neon glow on route line + arrows via BLOOM_LAYER)
 *
 * Uses Three.js EffectComposer + custom ShaderPass + UnrealBloomPass.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { GameRenderer } from './game-renderer';
import type { WeatherType } from './sky-and-fog';
import { TunnelVisionPass, computeTunnelIntensity } from './tunnel-vision-pass';
import { LensMarksManager } from './lens-marks-manager';
import { BLOOM_LAYER } from './route-line-mesh';
import type { GlassesLens } from '@/stores/gameStore';
import type { ZoneType } from './zone-detector';

// ── Zone ambient modifiers ──

interface ZoneModifier {
  tintMul: [number, number, number];
  brightnessMul: number;
  contrastAdd: number;
}

/**
 * Zones tint, they do NOT dim. These used to darken the whole frame — tunnel
 * ×0.45, forest ×0.80 — which made sense in first person (you were *inside* the
 * tunnel) but not in the diorama, where you look down at a toy world that has no
 * tunnel geometry: the picture just went black for no visible reason. Worse, a
 * post-pass multiplier is a back door around the "never darker than the demos'
 * night" floor in `day-night-lighting.ts`. Brightness lives in the palette now;
 * all this may do is tint.
 */
export const ZONE_MODIFIERS: Record<ZoneType, ZoneModifier> = {
  open:   { tintMul: [1, 1, 1],          brightnessMul: 1.0, contrastAdd: 0 },
  urban:  { tintMul: [1, 0.99, 0.97],    brightnessMul: 1.0, contrastAdd: 0 },
  forest: { tintMul: [0.94, 1, 0.94],    brightnessMul: 1.0, contrastAdd: 0 },
  tunnel: { tintMul: [1, 1, 1],          brightnessMul: 1.0, contrastAdd: 0 },
};

/** Zone transition speed (per second). ~500ms to complete. */
const ZONE_TRANSITION_SPEED = 2.0;

// ── Bloom composite shader ──
// Additively blends the bloom texture onto the main render.

const BloomCompositeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tBloom: { value: null as THREE.Texture | null },
    uBloomStrength: { value: 1.0 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tBloom;
    uniform float uBloomStrength;
    varying vec2 vUv;

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec4 bloom = texture2D(tBloom, vUv);
      gl_FragColor = base + bloom * uBloomStrength;
    }
  `,
};

/** Cycling glasses lens shader. */
const CyclingGlassesShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** Lens tint color (RGB, 0-1). */
    uTint: { value: new THREE.Vector3(1.0, 0.95, 0.7) },
    /** Tint strength (0 = no tint, 1 = full tint). */
    uTintStrength: { value: 0.3 },
    /** Contrast multiplier (1.0 = no change). */
    uContrast: { value: 1.08 },
    /** Vignette intensity (0 = none, 1 = heavy). */
    uVignetteIntensity: { value: 0.15 },
    /** Vignette smoothness. */
    uVignetteSmoothness: { value: 0.3 },
    /** Barrel distortion amount. */
    uDistortion: { value: 0.05 },
    /** Coin glow intensity (0 = off, 1 = full). */
    uCoinGlow: { value: 0.0 },
    /** Coin glow color (gold). */
    uCoinGlowColor: { value: new THREE.Vector3(1.0, 0.84, 0.0) },
    /** Lens marks overlay texture. */
    uMarksTexture: { value: null as THREE.Texture | null },
    /** Marks intensity (0 = off, 1 = full). */
    uMarksIntensity: { value: 1.0 },
    /** Zone brightness multiplier (1.0 = normal, <1 = darker). */
    uZoneBrightness: { value: 1.0 },
    /** Zone tint color multiplier (RGB, 0-1). */
    uZoneTint: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uTint;
    uniform float uTintStrength;
    uniform float uContrast;
    uniform float uVignetteIntensity;
    uniform float uVignetteSmoothness;
    uniform float uDistortion;
    uniform float uCoinGlow;
    uniform vec3 uCoinGlowColor;
    uniform sampler2D uMarksTexture;
    uniform float uMarksIntensity;
    uniform float uZoneBrightness;
    uniform vec3 uZoneTint;

    varying vec2 vUv;

    void main() {
      // Barrel distortion
      vec2 centered = vUv - 0.5;
      float r2 = dot(centered, centered);
      vec2 distorted = vUv + centered * r2 * uDistortion;

      // Clamp to prevent sampling outside texture
      distorted = clamp(distorted, 0.0, 1.0);

      vec4 color = texture2D(tDiffuse, distorted);

      // Lens tint
      color.rgb = mix(color.rgb, color.rgb * uTint, uTintStrength);

      // Contrast enhancement
      color.rgb = (color.rgb - 0.5) * uContrast + 0.5;

      // Lens marks overlay (rain drops, scratches, etc.)
      if (uMarksIntensity > 0.0) {
        vec4 marks = texture2D(uMarksTexture, vUv);
        if (marks.a > 0.01) {
          // Refraction effect — shift sampling based on mark color
          vec2 refractionOffset = (marks.rg - 0.5) * 0.02 * marks.a;
          vec4 refracted = texture2D(tDiffuse, clamp(distorted + refractionOffset, 0.0, 1.0));
          color.rgb = mix(color.rgb, refracted.rgb, marks.a * 0.3 * uMarksIntensity);
          // Mark color overlay
          color.rgb = mix(color.rgb, marks.rgb, marks.a * 0.4 * uMarksIntensity);
        }
      }

      // Vignette — subtle edge darkening only
      float dist = length(centered) * 2.0;
      float vignette = 1.0 - uVignetteIntensity * pow(dist, 3.0);
      color.rgb *= clamp(vignette, 0.3, 1.0);

      // Zone ambient — brightness and tint from environment type
      color.rgb *= uZoneBrightness;
      color.rgb *= uZoneTint;

      // Coin collection glow — additive gold at edges
      if (uCoinGlow > 0.0) {
        float glowMask = smoothstep(0.3, 1.2, dist);
        color.rgb += uCoinGlowColor * glowMask * uCoinGlow;
      }

      gl_FragColor = color;
    }
  `,
};

/** Lens preset parameters. */
interface LensPreset {
  tint: [number, number, number];
  tintStrength: number;
  distortion: number;
  vignetteIntensity: number;
  contrast: number;
}

const LENS_PRESETS: Record<Exclude<GlassesLens, 'auto'>, LensPreset> = {
  clear: {
    tint: [1.0, 1.0, 1.0],
    tintStrength: 0,
    distortion: 0.02,
    vignetteIntensity: 0.05,
    contrast: 1.0,
  },
  dark: {
    tint: [0.4, 0.4, 0.45],
    tintStrength: 0.5,
    distortion: 0.05,
    vignetteIntensity: 0.2,
    contrast: 1.12,
  },
  red: {
    tint: [1.0, 0.3, 0.2],
    tintStrength: 0.35,
    distortion: 0.05,
    vignetteIntensity: 0.18,
    contrast: 1.15,
  },
  yellow: {
    tint: [1.0, 0.92, 0.3],
    tintStrength: 0.4,
    distortion: 0.05,
    vignetteIntensity: 0.15,
    contrast: 1.10,
  },
};

/** Auto mode: weather → lens mapping. */
const WEATHER_TO_LENS: Record<WeatherType, Exclude<GlassesLens, 'auto'>> = {
  sunny: 'dark',
  cloudy: 'red',
  rainy: 'yellow',
  snowy: 'yellow',
};

/** Coin glow fade speed (intensity per second). ~0.33s full fade. */
const COIN_GLOW_FADE_SPEED = 3.0;

/** Bloom composite strength when bloom is active (neon route line). */
const BLOOM_COMPOSITE_STRENGTH = 0.5;

/** Bloom chain renders at this fraction of canvas size (it's a blur — half res is invisible). */
const BLOOM_RESOLUTION_SCALE = 0.5;

export class CyclingGlassesEffect {
  // Main composer: RenderPass → BloomComposite → Glasses → Tunnel → (style) → Output
  private composer: EffectComposer;
  private glassesPass: ShaderPass;
  private tunnelPass: TunnelVisionPass;
  private bloomCompositePass: ShaderPass;
  /**
   * Final pass: tone mapping (ACES, renderer's exposure) + linear→sRGB. Since
   * r152 the WebGLRenderer applies NEITHER when drawing into a render target,
   * so without this the composer chain reaches the screen linear and
   * un-tone-mapped — shadows crush to black and the night palette reads as
   * pitch black instead of the demos' violet.
   */
  private outputPass: OutputPass;
  /**
   * World-style post pass (paper-craft etc.), owned by the TerrainStyleStrategy
   * and injected via setStylePass(). Decoupled from the glasses effect so the
   * style survives with glasses off. Appended as the final composer pass.
   */
  private stylePass: ShaderPass | null = null;

  // Bloom composer: renders only BLOOM_LAYER objects → UnrealBloomPass
  private bloomComposer: EffectComposer;
  private bloomPass: UnrealBloomPass;

  // References for layer toggling during render
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private savedBackground: THREE.Color | THREE.Texture | null = null;
  private blackBackground = new THREE.Color(0x000000);

  private coinGlowIntensity = 0;
  private currentLens: GlassesLens = 'auto';
  private currentWeather: WeatherType = 'sunny';
  private simplified = false;

  // Lens transition state (D — smooth lens switching)
  private targetPreset: LensPreset | null = null;
  private currentValues: LensPreset = { tint: [1, 1, 1], tintStrength: 0, distortion: 0.02, vignetteIntensity: 0.05, contrast: 1.0 };
  private transitionT = 1; // 1 = done
  private static readonly TRANSITION_SPEED = 3.3; // ~300ms to complete

  // Zone transition state (smooth brightness/tint changes per environment)
  private currentZone: ZoneType = 'open';
  private currentZoneMod: ZoneModifier = { ...ZONE_MODIFIERS.open, tintMul: [...ZONE_MODIFIERS.open.tintMul] };
  private targetZoneMod: ZoneModifier | null = null;
  private zoneTransitionT = 1; // 1 = done

  readonly marksManager: LensMarksManager;

  constructor(gameRenderer: GameRenderer) {
    const { renderer, scene, camera } = gameRenderer;
    this.scene = scene;
    this.camera = camera;

    // ── Bloom composer (selective — renders only bloom-layer objects) ──
    this.bloomComposer = new EffectComposer(renderer);
    this.bloomComposer.renderToScreen = false;

    const bloomRenderPass = new RenderPass(scene, camera);
    bloomRenderPass.clearColor = new THREE.Color(0x000000);
    bloomRenderPass.clearAlpha = 0;
    this.bloomComposer.addPass(bloomRenderPass);

    // UnrealBloomPass: resolution, strength, radius, threshold.
    // The whole bloom chain runs at half resolution — bloom is a blur, so the
    // composite (linear-filtered upsample) is visually identical while the
    // second scene render + mip pyramid shade 1/4 of the pixels.
    const bloomResolution = new THREE.Vector2(
      Math.max(1, Math.floor(renderer.domElement.clientWidth * BLOOM_RESOLUTION_SCALE)),
      Math.max(1, Math.floor(renderer.domElement.clientHeight * BLOOM_RESOLUTION_SCALE)),
    );
    this.bloomPass = new UnrealBloomPass(bloomResolution, 0.6, 0.3, 0.2);
    this.bloomComposer.addPass(this.bloomPass);
    this.bloomComposer.setSize(bloomResolution.x, bloomResolution.y);

    // ── Main composer ──
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));

    // Bloom composite — blends bloom texture onto main render
    this.bloomCompositePass = new ShaderPass(BloomCompositeShader);
    this.bloomCompositePass.uniforms['uBloomStrength'].value = BLOOM_COMPOSITE_STRENGTH;
    this.composer.addPass(this.bloomCompositePass);

    // Glasses pass
    this.glassesPass = new ShaderPass(CyclingGlassesShader);
    this.composer.addPass(this.glassesPass);

    // Tunnel vision pass
    this.tunnelPass = new TunnelVisionPass();
    this.composer.addPass(this.tunnelPass);

    // NOTE: the world-style post pass (paper-craft) is inserted before the
    // output pass via setStylePass() — it belongs to the strategy, not the
    // glasses effect.

    // Tone mapping + sRGB — must stay the LAST pass.
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    // Lens marks
    this.marksManager = new LensMarksManager();
    this.glassesPass.uniforms['uMarksTexture'].value = this.marksManager.texture;

    // Default to auto/sunny — apply immediately (no transition)
    const initialPreset = LENS_PRESETS[WEATHER_TO_LENS['sunny']];
    this.applyPresetImmediate(initialPreset);
    this.currentValues = { ...initialPreset, tint: [...initialPreset.tint] };
  }

  /**
   * Enable/disable the selective bloom chain. Setting strength to 0 makes
   * render() skip the entire second scene render + UnrealBloom blur chain — a
   * large saving in styles with no bloom-layer objects (paper/crayon route
   * line). The neon (plastic) route line needs it on.
   */
  setBloomEnabled(enabled: boolean): void {
    this.bloomCompositePass.uniforms['uBloomStrength'].value =
      enabled ? BLOOM_COMPOSITE_STRENGTH : 0;
    // Fully skip the composite pass when off — otherwise it still costs a
    // full-screen blit + render-target swap just to add zero.
    this.bloomCompositePass.enabled = enabled;
  }

  /**
   * Low-quality simplification: keeps lens tint/contrast/vignette (the visual
   * identity) but drops barrel distortion and the lens-marks overlay, cutting
   * the glasses shader to a single texture fetch per pixel.
   */
  setSimplified(simplified: boolean): void {
    if (this.simplified === simplified) return;
    this.simplified = simplified;
    const u = this.glassesPass.uniforms;
    if (simplified) {
      u['uDistortion'].value = 0;
      u['uMarksIntensity'].value = 0;
    } else {
      u['uMarksIntensity'].value = 1.0;
      this.resolveAndApply(); // transition distortion back to the lens preset
    }
  }

  /** Set the lens mode. */
  setLens(lens: GlassesLens): void {
    this.currentLens = lens;
    this.resolveAndApply();
  }

  /** Set the current weather (affects auto mode). */
  setWeather(weather: WeatherType): void {
    this.currentWeather = weather;
    if (this.currentLens === 'auto') {
      this.resolveAndApply();
    }
  }

  /** Update tunnel vision based on HR zone and speed. */
  updatePhysiology(hrZone: number | null, speedKmh: number): void {
    const intensity = computeTunnelIntensity(hrZone, speedKmh);
    this.tunnelPass.setIntensity(intensity);
  }

  /** Set the current environment zone (starts smooth transition). */
  setZone(zone: ZoneType): void {
    if (zone === this.currentZone) return;
    this.currentZone = zone;
    this.targetZoneMod = { ...ZONE_MODIFIERS[zone], tintMul: [...ZONE_MODIFIERS[zone].tintMul] };
    this.zoneTransitionT = 0;
  }

  /** Trigger gold glow on coin collection. */
  triggerCoinGlow(): void {
    this.coinGlowIntensity = 1.0;
    this.marksManager.addMark('coin');
  }

  /** Per-frame update — fades coin glow, lerps lens transition, updates marks. Call before render(). */
  update(dt: number): void {
    if (this.coinGlowIntensity > 0) {
      this.coinGlowIntensity = Math.max(0, this.coinGlowIntensity - dt * COIN_GLOW_FADE_SPEED);
      this.glassesPass.uniforms['uCoinGlow'].value = this.coinGlowIntensity;
    }

    // Lens transition lerp
    if (this.targetPreset && this.transitionT < 1) {
      this.transitionT = Math.min(1, this.transitionT + dt * CyclingGlassesEffect.TRANSITION_SPEED);
      const t = this.transitionT;
      const p = this.targetPreset;
      const c = this.currentValues;
      const u = this.glassesPass.uniforms;

      u['uTint'].value.set(
        c.tint[0] + (p.tint[0] - c.tint[0]) * t,
        c.tint[1] + (p.tint[1] - c.tint[1]) * t,
        c.tint[2] + (p.tint[2] - c.tint[2]) * t,
      );
      u['uTintStrength'].value = c.tintStrength + (p.tintStrength - c.tintStrength) * t;
      u['uDistortion'].value = c.distortion + (p.distortion - c.distortion) * t;
      u['uVignetteIntensity'].value = c.vignetteIntensity + (p.vignetteIntensity - c.vignetteIntensity) * t;
      u['uContrast'].value = c.contrast + (p.contrast - c.contrast) * t;

      if (this.transitionT >= 1) {
        this.currentValues = { ...p, tint: [...p.tint] };
        this.targetPreset = null;
      }
    }

    // Zone transition lerp (brightness + tint)
    if (this.targetZoneMod && this.zoneTransitionT < 1) {
      this.zoneTransitionT = Math.min(1, this.zoneTransitionT + dt * ZONE_TRANSITION_SPEED);
      const t = this.zoneTransitionT;
      const from = this.currentZoneMod;
      const to = this.targetZoneMod;
      const u = this.glassesPass.uniforms;

      const brightness = from.brightnessMul + (to.brightnessMul - from.brightnessMul) * t;
      u['uZoneBrightness'].value = brightness;
      u['uZoneTint'].value.set(
        from.tintMul[0] + (to.tintMul[0] - from.tintMul[0]) * t,
        from.tintMul[1] + (to.tintMul[1] - from.tintMul[1]) * t,
        from.tintMul[2] + (to.tintMul[2] - from.tintMul[2]) * t,
      );

      // Also apply contrast add on top of current lens contrast
      const contrastAdd = from.contrastAdd + (to.contrastAdd - from.contrastAdd) * t;
      u['uContrast'].value = this.currentValues.contrast + contrastAdd;

      if (this.zoneTransitionT >= 1) {
        this.currentZoneMod = { ...to, tintMul: [...to.tintMul] };
        this.targetZoneMod = null;
      }
    }

    // Simplified mode: lens transitions above may have re-written distortion —
    // pin the cheap-path uniforms back to zero.
    if (this.simplified) {
      this.glassesPass.uniforms['uDistortion'].value = 0;
      this.glassesPass.uniforms['uMarksIntensity'].value = 0;
    }

    this.marksManager.update(dt);
  }

  /** Render the scene with selective bloom + post-processing. */
  render(): void {
    if (this.bloomCompositePass.enabled) {
      // ── Pass 1: Bloom (only bloom-layer objects) ──
      this.savedBackground = this.scene.background as THREE.Color | THREE.Texture | null;
      this.scene.background = this.blackBackground;
      this.camera.layers.set(BLOOM_LAYER);

      this.bloomComposer.render();

      // Restore scene state
      this.scene.background = this.savedBackground;
      this.camera.layers.enableAll();

      // Feed bloom texture into composite pass
      this.bloomCompositePass.uniforms['tBloom'].value =
        this.bloomComposer.renderTarget2.texture;
    }

    // ── Pass 2: Main render (all layers) + composite bloom ──
    this.composer.render();
  }

  /** Handle canvas resize. */
  resize(width: number, height: number): void {
    this.composer.setSize(width, height);
    const bw = Math.max(1, Math.floor(width * BLOOM_RESOLUTION_SCALE));
    const bh = Math.max(1, Math.floor(height * BLOOM_RESOLUTION_SCALE));
    this.bloomComposer.setSize(bw, bh);
    this.bloomPass.resolution.set(bw, bh);
    const res = this.stylePass?.uniforms['uResolution'];
    if (res) res.value.set(width, height);
  }

  /**
   * Install (or replace/clear) the strategy's world-style post pass, just
   * before the output pass. Pass null to remove it (e.g. switching to plastic).
   */
  setStylePass(pass: ShaderPass | null): void {
    if (this.stylePass) {
      this.composer.removePass(this.stylePass);
      this.stylePass = null;
    }
    if (pass) {
      this.composer.insertPass(pass, this.composer.passes.indexOf(this.outputPass));
      this.stylePass = pass;
    }
  }

  dispose(): void {
    this.marksManager.dispose();
    this.bloomComposer.dispose();
    this.composer.dispose();
    this.outputPass.dispose();
  }

  private resolveAndApply(): void {
    const lens = this.currentLens === 'auto'
      ? WEATHER_TO_LENS[this.currentWeather]
      : this.currentLens;
    this.applyPreset(LENS_PRESETS[lens]);
  }

  /** Start a smooth transition to a new lens preset (~300ms). */
  private applyPreset(preset: LensPreset): void {
    // Snapshot current uniform values as transition start
    const u = this.glassesPass.uniforms;
    this.currentValues = {
      tint: [u['uTint'].value.x, u['uTint'].value.y, u['uTint'].value.z],
      tintStrength: u['uTintStrength'].value,
      distortion: u['uDistortion'].value,
      vignetteIntensity: u['uVignetteIntensity'].value,
      contrast: u['uContrast'].value,
    };
    this.targetPreset = preset;
    this.transitionT = 0;
  }

  /** Apply a preset instantly (no transition — used for initialization). */
  private applyPresetImmediate(preset: LensPreset): void {
    const u = this.glassesPass.uniforms;
    u['uTint'].value.set(...preset.tint);
    u['uTintStrength'].value = preset.tintStrength;
    u['uDistortion'].value = preset.distortion;
    u['uVignetteIntensity'].value = preset.vignetteIntensity;
    u['uContrast'].value = preset.contrast;
  }
}
