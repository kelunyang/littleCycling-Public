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

const ZONE_MODIFIERS: Record<ZoneType, ZoneModifier> = {
  open:   { tintMul: [1, 1, 1],       brightnessMul: 1.0,  contrastAdd: 0 },
  urban:  { tintMul: [1, 0.98, 0.95], brightnessMul: 1.05, contrastAdd: 0.02 },
  forest: { tintMul: [0.85, 1, 0.85], brightnessMul: 0.80, contrastAdd: -0.03 },
  tunnel: { tintMul: [0.7, 0.7, 0.75], brightnessMul: 0.45, contrastAdd: 0.05 },
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

export class CyclingGlassesEffect {
  // Main composer: RenderPass → BloomComposite → Glasses → Tunnel
  private composer: EffectComposer;
  private glassesPass: ShaderPass;
  private tunnelPass: TunnelVisionPass;
  private bloomCompositePass: ShaderPass;

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

    // UnrealBloomPass: resolution, strength, radius, threshold
    const bloomResolution = new THREE.Vector2(
      renderer.domElement.clientWidth,
      renderer.domElement.clientHeight,
    );
    this.bloomPass = new UnrealBloomPass(bloomResolution, 0.6, 0.3, 0.2);
    this.bloomComposer.addPass(this.bloomPass);

    // ── Main composer ──
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));

    // Bloom composite — blends bloom texture onto main render
    this.bloomCompositePass = new ShaderPass(BloomCompositeShader);
    this.bloomCompositePass.uniforms['uBloomStrength'].value = 0.5;
    this.composer.addPass(this.bloomCompositePass);

    // Glasses pass
    this.glassesPass = new ShaderPass(CyclingGlassesShader);
    this.composer.addPass(this.glassesPass);

    // Tunnel vision pass
    this.tunnelPass = new TunnelVisionPass();
    this.composer.addPass(this.tunnelPass);

    // Lens marks
    this.marksManager = new LensMarksManager();
    this.glassesPass.uniforms['uMarksTexture'].value = this.marksManager.texture;

    // Default to auto/sunny — apply immediately (no transition)
    const initialPreset = LENS_PRESETS[WEATHER_TO_LENS['sunny']];
    this.applyPresetImmediate(initialPreset);
    this.currentValues = { ...initialPreset, tint: [...initialPreset.tint] };
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

    this.marksManager.update(dt);
  }

  /** Render the scene with selective bloom + post-processing. */
  render(): void {
    const bloomStrength = this.bloomCompositePass.uniforms['uBloomStrength'].value as number;

    if (bloomStrength > 0.01) {
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
    this.bloomComposer.setSize(width, height);
    this.bloomPass.resolution.set(width, height);
  }

  dispose(): void {
    this.marksManager.dispose();
    this.bloomComposer.dispose();
    this.composer.dispose();
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
