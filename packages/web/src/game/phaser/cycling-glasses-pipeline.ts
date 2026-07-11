/**
 * Phaser PostFX pipeline simulating cycling glasses view.
 *
 * Mirrors packages/web/src/game/terrain/cycling-glasses-effect.ts:
 * - Lens tint (clear / dark / red / yellow + auto-by-weather)
 * - Contrast adjustment
 * - Vignette (edge darkening)
 * - Subtle barrel distortion
 * - Coin collection gold glow (additive, fades out)
 * - Lens marks overlay (rain/snow/dust/coin/leaf marks via uMarksTexture)
 * - Zone ambient (urban/forest/tunnel brightness + tint)
 *
 * Tunnel vision (radial blur on edges) is in tunnel-vision-pipeline.ts.
 * Selective bloom on route/markers is applied as Phaser.FX.Bloom on a
 * dedicated routeLayer.
 */

import Phaser from 'phaser';

export type GlassesLens = 'clear' | 'dark' | 'red' | 'yellow' | 'auto';
export type WeatherType = 'sunny' | 'cloudy' | 'rainy' | 'snowy';
export type ZoneType = 'open' | 'urban' | 'forest' | 'tunnel';

interface LensPreset {
  tint: [number, number, number];
  tintStrength: number;
  distortion: number;
  vignetteIntensity: number;
  contrast: number;
}

const LENS_PRESETS: Record<Exclude<GlassesLens, 'auto'>, LensPreset> = {
  clear:  { tint: [1.0, 1.0, 1.0], tintStrength: 0,    distortion: 0.02, vignetteIntensity: 0.05, contrast: 1.00 },
  dark:   { tint: [0.4, 0.4, 0.45], tintStrength: 0.5,  distortion: 0.05, vignetteIntensity: 0.20, contrast: 1.12 },
  red:    { tint: [1.0, 0.3, 0.2],  tintStrength: 0.35, distortion: 0.05, vignetteIntensity: 0.18, contrast: 1.15 },
  yellow: { tint: [1.0, 0.92, 0.3], tintStrength: 0.4,  distortion: 0.05, vignetteIntensity: 0.15, contrast: 1.10 },
};

const WEATHER_TO_LENS: Record<WeatherType, Exclude<GlassesLens, 'auto'>> = {
  sunny: 'dark',
  cloudy: 'red',
  rainy: 'yellow',
  snowy: 'yellow',
};

interface ZoneModifier {
  tintMul: [number, number, number];
  brightnessMul: number;
  contrastAdd: number;
}

const ZONE_MODIFIERS: Record<ZoneType, ZoneModifier> = {
  open:   { tintMul: [1, 1, 1],         brightnessMul: 1.00, contrastAdd: 0    },
  urban:  { tintMul: [1, 0.98, 0.95],   brightnessMul: 1.05, contrastAdd: 0.02 },
  forest: { tintMul: [0.85, 1, 0.85],   brightnessMul: 0.80, contrastAdd: -0.03 },
  tunnel: { tintMul: [0.7, 0.7, 0.75],  brightnessMul: 0.45, contrastAdd: 0.05 },
};

const COIN_GLOW_FADE_SPEED = 3.0;
const LENS_TRANSITION_SPEED = 3.3;
const ZONE_TRANSITION_SPEED = 2.0;

export const CYCLING_GLASSES_PIPELINE_KEY = 'CyclingGlassesPipeline';

const FRAG_SHADER = `
precision mediump float;

uniform sampler2D uMainSampler;
uniform sampler2D uMarksTexture;

uniform vec3  uTint;
uniform float uTintStrength;
uniform float uContrast;
uniform float uVignetteIntensity;
uniform float uDistortion;
uniform float uCoinGlow;
uniform vec3  uCoinGlowColor;
uniform float uMarksIntensity;
uniform float uZoneBrightness;
uniform vec3  uZoneTint;

varying vec2 outTexCoord;

void main() {
  vec2 uv = outTexCoord;

  vec2 centered = uv - 0.5;
  float r2 = dot(centered, centered);
  vec2 distorted = uv + centered * r2 * uDistortion;
  distorted = clamp(distorted, 0.0, 1.0);

  vec4 color = texture2D(uMainSampler, distorted);

  color.rgb = mix(color.rgb, color.rgb * uTint, uTintStrength);
  color.rgb = (color.rgb - 0.5) * uContrast + 0.5;

  if (uMarksIntensity > 0.0) {
    vec4 marks = texture2D(uMarksTexture, uv);
    if (marks.a > 0.01) {
      vec2 refractionOffset = (marks.rg - 0.5) * 0.02 * marks.a;
      vec4 refracted = texture2D(uMainSampler, clamp(distorted + refractionOffset, 0.0, 1.0));
      color.rgb = mix(color.rgb, refracted.rgb, marks.a * 0.3 * uMarksIntensity);
      color.rgb = mix(color.rgb, marks.rgb, marks.a * 0.4 * uMarksIntensity);
    }
  }

  float dist = length(centered) * 2.0;
  float vignette = 1.0 - uVignetteIntensity * pow(dist, 3.0);
  color.rgb *= clamp(vignette, 0.3, 1.0);

  color.rgb *= uZoneBrightness;
  color.rgb *= uZoneTint;

  if (uCoinGlow > 0.0) {
    float glowMask = smoothstep(0.3, 1.2, dist);
    color.rgb += uCoinGlowColor * glowMask * uCoinGlow;
  }

  gl_FragColor = color;
}
`;

interface PipelineState {
  tint: [number, number, number];
  tintStrength: number;
  distortion: number;
  vignetteIntensity: number;
  contrast: number;
}

export class CyclingGlassesPipeline extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
  private currentLens: GlassesLens = 'auto';
  private currentWeather: WeatherType = 'sunny';

  private currentValues: PipelineState;
  private targetPreset: LensPreset | null = null;
  private transitionT = 1;

  private currentZone: ZoneType = 'open';
  private currentZoneMod: ZoneModifier = { ...ZONE_MODIFIERS.open, tintMul: [...ZONE_MODIFIERS.open.tintMul] as [number, number, number] };
  private targetZoneMod: ZoneModifier | null = null;
  private zoneTransitionT = 1;

  private coinGlowIntensity = 0;

  /** Lazy lookup so we don't cache a glTexture that hasn't been allocated yet. */
  private marksTextureGetter: (() => WebGLTexture | Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper | null) | null = null;

  constructor(game: Phaser.Game) {
    super({
      game,
      name: CYCLING_GLASSES_PIPELINE_KEY,
      fragShader: FRAG_SHADER,
    });

    const initial = LENS_PRESETS[WEATHER_TO_LENS.sunny];
    this.currentValues = {
      tint: [...initial.tint] as [number, number, number],
      tintStrength: initial.tintStrength,
      distortion: initial.distortion,
      vignetteIntensity: initial.vignetteIntensity,
      contrast: initial.contrast,
    };
  }

  onBoot(): void {
    // Defaults — applied each frame anyway in onPreRender, but seeding makes the
    // first frame coherent.
    this.set3f('uTint', this.currentValues.tint[0], this.currentValues.tint[1], this.currentValues.tint[2]);
    this.set1f('uTintStrength', this.currentValues.tintStrength);
    this.set1f('uContrast', this.currentValues.contrast);
    this.set1f('uVignetteIntensity', this.currentValues.vignetteIntensity);
    this.set1f('uDistortion', this.currentValues.distortion);
    this.set1f('uCoinGlow', 0);
    this.set3f('uCoinGlowColor', 1.0, 0.84, 0.0);
    this.set1f('uMarksIntensity', 1.0);
    this.set1f('uZoneBrightness', 1.0);
    this.set3f('uZoneTint', 1.0, 1.0, 1.0);
  }

  /**
   * Provide a getter for the lens-marks WebGLTexture. Looked up each frame so
   * we tolerate the texture being allocated lazily by the renderer on first use.
   */
  setMarksTextureSource(
    getter: () => WebGLTexture | Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper | null,
  ): void {
    this.marksTextureGetter = getter;
  }

  /** Set lens mode. */
  setLens(lens: GlassesLens): void {
    this.currentLens = lens;
    this.applyLensTransition();
  }

  /** Set current weather (affects auto mode). */
  setWeather(weather: WeatherType): void {
    this.currentWeather = weather;
    if (this.currentLens === 'auto') {
      this.applyLensTransition();
    }
  }

  /** Trigger gold glow on coin pickup. */
  triggerCoinGlow(): void {
    this.coinGlowIntensity = 1.0;
  }

  /** Set environment zone (smooth transition). */
  setZone(zone: ZoneType): void {
    if (zone === this.currentZone) return;
    this.currentZone = zone;
    const mod = ZONE_MODIFIERS[zone];
    this.targetZoneMod = {
      tintMul: [...mod.tintMul] as [number, number, number],
      brightnessMul: mod.brightnessMul,
      contrastAdd: mod.contrastAdd,
    };
    this.zoneTransitionT = 0;
  }

  /** Per-frame update — call from scene.update (dt in seconds). */
  tick(dt: number): void {
    if (this.coinGlowIntensity > 0) {
      this.coinGlowIntensity = Math.max(0, this.coinGlowIntensity - dt * COIN_GLOW_FADE_SPEED);
    }

    if (this.targetPreset && this.transitionT < 1) {
      this.transitionT = Math.min(1, this.transitionT + dt * LENS_TRANSITION_SPEED);
      const t = this.transitionT;
      const c = this.currentValues;
      const p = this.targetPreset;
      // Lerp values directly into currentValues — onPreRender uploads them.
      const newTint: [number, number, number] = [
        c.tint[0] + (p.tint[0] - c.tint[0]) * t,
        c.tint[1] + (p.tint[1] - c.tint[1]) * t,
        c.tint[2] + (p.tint[2] - c.tint[2]) * t,
      ];
      const newTintStrength = c.tintStrength + (p.tintStrength - c.tintStrength) * t;
      const newDistortion = c.distortion + (p.distortion - c.distortion) * t;
      const newVignette = c.vignetteIntensity + (p.vignetteIntensity - c.vignetteIntensity) * t;
      const newContrast = c.contrast + (p.contrast - c.contrast) * t;

      if (this.transitionT >= 1) {
        this.currentValues = {
          tint: [...p.tint] as [number, number, number],
          tintStrength: p.tintStrength,
          distortion: p.distortion,
          vignetteIntensity: p.vignetteIntensity,
          contrast: p.contrast,
        };
        this.targetPreset = null;
      } else {
        this.currentValues = {
          tint: newTint,
          tintStrength: newTintStrength,
          distortion: newDistortion,
          vignetteIntensity: newVignette,
          contrast: newContrast,
        };
      }
    }

    if (this.targetZoneMod && this.zoneTransitionT < 1) {
      this.zoneTransitionT = Math.min(1, this.zoneTransitionT + dt * ZONE_TRANSITION_SPEED);
      const t = this.zoneTransitionT;
      const from = this.currentZoneMod;
      const to = this.targetZoneMod;
      const newMod: ZoneModifier = {
        tintMul: [
          from.tintMul[0] + (to.tintMul[0] - from.tintMul[0]) * t,
          from.tintMul[1] + (to.tintMul[1] - from.tintMul[1]) * t,
          from.tintMul[2] + (to.tintMul[2] - from.tintMul[2]) * t,
        ],
        brightnessMul: from.brightnessMul + (to.brightnessMul - from.brightnessMul) * t,
        contrastAdd: from.contrastAdd + (to.contrastAdd - from.contrastAdd) * t,
      };
      if (this.zoneTransitionT >= 1) {
        this.currentZoneMod = {
          tintMul: [...to.tintMul] as [number, number, number],
          brightnessMul: to.brightnessMul,
          contrastAdd: to.contrastAdd,
        };
        this.targetZoneMod = null;
      } else {
        this.currentZoneMod = newMod;
      }
    }
  }

  onPreRender(): void {
    const v = this.currentValues;
    const z = this.currentZoneMod;

    this.set3f('uTint', v.tint[0], v.tint[1], v.tint[2]);
    this.set1f('uTintStrength', v.tintStrength);
    this.set1f('uContrast', v.contrast + z.contrastAdd);
    this.set1f('uVignetteIntensity', v.vignetteIntensity);
    this.set1f('uDistortion', v.distortion);
    this.set1f('uCoinGlow', this.coinGlowIntensity);
    this.set1f('uZoneBrightness', z.brightnessMul);
    this.set3f('uZoneTint', z.tintMul[0], z.tintMul[1], z.tintMul[2]);
    const marksTex = this.marksTextureGetter?.() ?? null;
    this.set1f('uMarksIntensity', marksTex ? 1.0 : 0.0);
  }

  onDraw(renderTarget: Phaser.Renderer.WebGL.RenderTarget): void {
    const marksTex = this.marksTextureGetter?.() ?? null;
    if (marksTex) {
      // Bind the lens-marks texture to texture unit 1 so the shader sees it.
      this.bindTexture(marksTex as any, 1);
      this.set1i('uMarksTexture', 1);
    }
    this.bindAndDraw(renderTarget);
  }

  private applyLensTransition(): void {
    const lens = this.currentLens === 'auto'
      ? WEATHER_TO_LENS[this.currentWeather]
      : this.currentLens;
    const preset = LENS_PRESETS[lens];
    // Snapshot current values as transition origin (already in this.currentValues).
    this.targetPreset = preset;
    this.transitionT = 0;
  }
}
