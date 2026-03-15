/**
 * Standalone Three.js renderer — replaces MapLibre's rendering pipeline.
 *
 * Creates its own WebGLRenderer, Scene, and PerspectiveCamera with no pitch
 * limits, enabling true FPS perspective for the cycling game.
 */

import * as THREE from 'three';
import { CHUNK_LENGTH, CHUNKS_AHEAD } from './terrain-chunk-manager';

export interface GameRendererOptions {
  canvas: HTMLCanvasElement;
  /** Field of view in degrees. */
  fov?: number;
  /** Enable antialiasing. */
  antialias?: boolean;
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  // Lights (exposed for weather system to adjust)
  readonly ambientLight: THREE.AmbientLight;
  readonly directionalLight: THREE.DirectionalLight;
  readonly hemisphereLight: THREE.HemisphereLight;

  private fog: THREE.Fog;
  private disposed = false;

  constructor(options: GameRendererOptions) {
    const { canvas, fov = 75, antialias = true } = options;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb); // sky blue default

    // Fog
    this.fog = new THREE.Fog(0xdce6f0, 500, 2000);
    this.scene.fog = this.fog;

    // Camera — no pitch limit, far plane beyond fog to prevent pop-in
    this.camera = new THREE.PerspectiveCamera(
      fov,
      canvas.clientWidth / canvas.clientHeight,
      0.5,
      CHUNK_LENGTH * (CHUNKS_AHEAD + 1), // 8000m
    );

    // Lights
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    this.scene.add(this.ambientLight);

    this.directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this.directionalLight.position.set(100, 200, 100);
    this.scene.add(this.directionalLight);

    this.hemisphereLight = new THREE.HemisphereLight(0x87ceeb, 0x556633, 0.7);
    this.scene.add(this.hemisphereLight);
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
    this.renderer.dispose();
  }
}
