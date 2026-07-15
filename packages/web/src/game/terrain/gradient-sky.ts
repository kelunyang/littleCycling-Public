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
 * gradient quantised into 5 steps — flat, posterised, always visible, and it
 * costs nothing. Colours come from the world style (`strategy.skyPalette`) and
 * are lerped day↔night by the caller.
 */

import * as THREE from 'three';

/**
 * Dome radius in metres. Must clear the far mountain ring (2600 m) and the
 * horizon disc (4000 m) but stay inside the camera's far plane (8000 m).
 */
const SKY_RADIUS = 5000;

/**
 * Height (m) at which the gradient reaches `topColor`. The demo used 260 on an
 * 1100 m dome; the same ratio keeps the horizon band at the same visual height
 * now that the dome is bigger.
 */
const GRADIENT_HEIGHT = SKY_RADIUS * (260 / 1100);

/** Posterisation steps — the hard colour banding is the point (hand-made look). */
const GRADIENT_STEPS = 5;

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

  constructor(scene: THREE.Scene) {
    this.material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      // The dome must never occlude anything: it is drawn first and writes no
      // depth, so terrain/mountains/horizon disc all paint over it normally.
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x8fd8ee) },
        bottomColor: { value: new THREE.Color(0xffe0ef) },
        gradientHeight: { value: GRADIENT_HEIGHT },
        steps: { value: GRADIENT_STEPS },
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
