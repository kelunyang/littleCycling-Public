/**
 * Phaser PostFX pipeline simulating tunnel vision under high exertion.
 *
 * Mirrors packages/web/src/game/terrain/tunnel-vision-pass.ts:
 * center stays clear, edges get progressively radial-blurred and darker.
 *
 * uTunnelIntensity = 0 → passthrough (cheap).
 */

import Phaser from 'phaser';

export const TUNNEL_VISION_PIPELINE_KEY = 'TunnelVisionPipeline';

const FRAG_SHADER = `
precision mediump float;

uniform sampler2D uMainSampler;
uniform float uTunnelIntensity;

varying vec2 outTexCoord;

void main() {
  vec2 uv = outTexCoord;

  if (uTunnelIntensity < 0.001) {
    gl_FragColor = texture2D(uMainSampler, uv);
    return;
  }

  vec2 center = uv - 0.5;
  float dist = length(center);
  float blurAmount = smoothstep(0.15, 0.7, dist) * uTunnelIntensity;
  vec2 dir = normalize(center) * blurAmount * 0.04;

  vec4 color = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    float t = float(i) / 7.0 - 0.5;
    vec2 offset = dir * t;
    color += texture2D(uMainSampler, clamp(uv + offset, 0.0, 1.0));
  }
  color /= 8.0;

  float darken = 1.0 - smoothstep(0.3, 0.9, dist) * uTunnelIntensity * 0.4;
  color.rgb *= darken;

  gl_FragColor = color;
}
`;

export class TunnelVisionPipeline extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
  private intensity = 0;

  constructor(game: Phaser.Game) {
    super({
      game,
      name: TUNNEL_VISION_PIPELINE_KEY,
      fragShader: FRAG_SHADER,
    });
  }

  onBoot(): void {
    this.set1f('uTunnelIntensity', 0);
  }

  setIntensity(value: number): void {
    this.intensity = Math.max(0, Math.min(1, value));
  }

  onPreRender(): void {
    this.set1f('uTunnelIntensity', this.intensity);
  }
}

/**
 * Compute tunnel vision intensity from HR zone and speed.
 * Mirrors computeTunnelIntensity in tunnel-vision-pass.ts.
 */
export function computeTunnelIntensity(hrZone: number | null, speedKmh: number): number {
  let intensity = 0;
  if (hrZone === 4) intensity += 0.2;
  else if (hrZone === 5) intensity += 0.6;
  if (speedKmh > 30) intensity += Math.min((speedKmh - 30) / 50, 1.0) * 0.4;
  return Math.min(intensity, 1.0);
}
