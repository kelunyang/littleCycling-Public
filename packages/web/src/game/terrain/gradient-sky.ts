/**
 * Gradient sky dome — the demos' sky, scaled up to our world.
 *
 * Replaces three's Preetham `Sky`. Preetham is a physical atmosphere model: it
 * renders BLACK below civil twilight and blows out to extreme HDR at the horizon
 * in hazy weather, which is why the old pipeline had to hide it at night / in
 * overcast and hold `toneMappingExposure` down at 0.6–0.9. Both are wrong for a
 * paper/plastic diorama, and the low exposure is what made the whole scene dark.
 *
 * This is the demo's dome instead: a BackSide sphere with a two-colour vertical
 * gradient quantised into a few hard steps — flat, posterised, always visible,
 * and it costs nothing. Everything about it comes from the world style
 * (`strategy.skyPalette`): the two colours, lerped day↔night by the caller, and
 * the gradient's SHAPE (`skyPalette.gradient`), which is per-world because the
 * three demos disagree — see `SkyGradientStyle`.
 */

import * as THREE from 'three';

import { skyGradientHeight } from './terrain-style-strategy';
import type { SkyGradientStyle } from './terrain-style-strategy';

/**
 * Dome radius in metres. Must clear the far mountain ring (2600 m) and the
 * horizon disc (4000 m) but stay inside the camera's far plane (8000 m).
 */
const SKY_RADIUS = 5000;

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldY;
  void main() {
    vWorldY = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vWorldY;
  uniform vec3 topColor;
  uniform vec3 bottomColor;
  uniform float gradientHeight;
  uniform float steps;
  void main() {
    float h = clamp(vWorldY.y / gradientHeight, 0.0, 1.0);
    h = floor(h * steps) / steps;
    gl_FragColor = vec4(mix(bottomColor, topColor, h), 1.0);
  }
`;

export class GradientSky {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, gradient: SkyGradientStyle) {
    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      // The dome must never occlude anything: it is drawn first and writes no
      // depth, so terrain/mountains/horizon disc all paint over it normally.
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x8fd8ee) },
        bottomColor: { value: new THREE.Color(0xffe0ef) },
        gradientHeight: { value: skyGradientHeight(gradient.demoHeight, SKY_RADIUS) },
        steps: { value: gradient.steps },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
    });

    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_RADIUS, 24, 12),
      this.material,
    );
    this.mesh.name = 'gradientSky';
    this.mesh.renderOrder = -100;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /**
   * Re-shape the gradient for a world style — two uniform writes, no rebuild.
   * Called on every `setPalette`, so switching worlds mid-ride moves the horizon
   * band to the new world's demo height (and its step count) immediately.
   */
  setGradient(gradient: SkyGradientStyle): void {
    this.material.uniforms.gradientHeight.value =
      skyGradientHeight(gradient.demoHeight, SKY_RADIUS);
    this.material.uniforms.steps.value = gradient.steps;
  }

  /** Set the gradient's two colours (already blended for time of day/weather). */
  setColors(top: THREE.Color, bottom: THREE.Color): void {
    this.material.uniforms.topColor.value.copy(top);
    this.material.uniforms.bottomColor.value.copy(bottom);
  }

  /** Keep the dome centred on the rider so it never gets left behind. */
  update(cameraPosition: THREE.Vector3): void {
    this.mesh.position.copy(cameraPosition);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
