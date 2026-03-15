/**
 * Tunnel vision post-processing pass.
 *
 * Simulates peripheral vision loss under high exertion:
 * center stays clear, edges get progressively radial-blurred.
 * Driven by HR zone + speed.
 *
 * When uTunnelIntensity = 0, the pass is a no-op (passthrough).
 */

import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const TunnelVisionShader = {
  uniforms: {
    tDiffuse: { value: null },
    /** 0 = off (passthrough), 1 = maximum tunnel vision. */
    uTunnelIntensity: { value: 0.0 },
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
    uniform float uTunnelIntensity;

    varying vec2 vUv;

    void main() {
      if (uTunnelIntensity < 0.001) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      vec2 center = vUv - 0.5;
      float dist = length(center);

      // Blur starts at center 15%, fully blurred at 70% radius
      float blurAmount = smoothstep(0.15, 0.7, dist) * uTunnelIntensity;

      // 8-sample radial blur along the vector from center
      vec2 dir = normalize(center) * blurAmount * 0.04;
      vec4 color = vec4(0.0);
      for (int i = 0; i < 8; i++) {
        float t = float(i) / 7.0 - 0.5; // -0.5 to 0.5
        vec2 offset = dir * t;
        color += texture2D(tDiffuse, clamp(vUv + offset, 0.0, 1.0));
      }
      color /= 8.0;

      // Edge darkening for enhanced tunnel feel
      float darken = 1.0 - smoothstep(0.3, 0.9, dist) * uTunnelIntensity * 0.4;
      color.rgb *= darken;

      gl_FragColor = color;
    }
  `,
};

export class TunnelVisionPass extends ShaderPass {
  constructor() {
    super(TunnelVisionShader);
  }

  setIntensity(value: number): void {
    this.uniforms['uTunnelIntensity'].value = Math.max(0, Math.min(1, value));
  }
}

/**
 * Compute tunnel vision intensity from HR zone and speed.
 * @param hrZone - Current HR zone (1-5) or null
 * @param speedKmh - Current speed in km/h
 */
export function computeTunnelIntensity(hrZone: number | null, speedKmh: number): number {
  let intensity = 0;
  if (hrZone === 4) intensity += 0.2;
  else if (hrZone === 5) intensity += 0.6;
  if (speedKmh > 30) intensity += Math.min((speedKmh - 30) / 50, 1.0) * 0.4;
  return Math.min(intensity, 1.0);
}
