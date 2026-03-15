/**
 * Dynamic sky, fog, and day/night system driven by real-time astronomical
 * calculations and weather type.
 *
 * Weather types: sunny, cloudy, rainy, snowy
 * Day/night: sun/moon positions computed from route lat/lon + system clock.
 * Moon sprite rendered in the night sky.
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import type { GameRenderer } from './game-renderer';
import { getCelestialState, type CelestialState } from './sun-moon-calc';
import { computeDayNightLighting } from './day-night-lighting';

export type WeatherType = 'sunny' | 'cloudy' | 'rainy' | 'snowy';

export interface WeatherConfig {
  type: WeatherType;
  /** Sun elevation angle in degrees (0 = horizon, 90 = overhead). */
  sunElevation: number;
  /** Sun azimuth in degrees (0 = north, clockwise). */
  sunAzimuth: number;
}

/** Rain particle count. */
const RAIN_PARTICLE_COUNT = 3000;

/** Rain drop area around camera (meters). */
const RAIN_AREA = 100;

/** Rain drop fall speed (m/s). */
const RAIN_SPEED = 25;

/** Snow particle count. */
const SNOW_PARTICLE_COUNT = 2000;

/** Snow area around camera (meters). */
const SNOW_AREA = 120;

/** Snow fall speed (m/s). */
const SNOW_SPEED = 3;

/** Snow horizontal drift speed (m/s). */
const SNOW_DRIFT_SPEED = 1.5;

/** Billboard cloud count. */
const CLOUD_COUNT = 18;

/** Cloud spread area around camera (meters). */
const CLOUD_AREA = 300;

/** Cloud altitude range (meters above terrain). */
const CLOUD_MIN_Y = 200;
const CLOUD_MAX_Y = 400;

/** Cloud horizontal drift speed (m/s). */
const CLOUD_DRIFT_SPEED = 2;

/** Dust particle count (ambient, always-on). */
const DUST_PARTICLE_COUNT = 40;

/** Dust area around camera (meters). */
const DUST_AREA = 60;

/** Dust drift speed (m/s). */
const DUST_DRIFT_SPEED = 0.8;

/** Leaf particle count (ambient, always-on). */
const LEAF_PARTICLE_COUNT = 15;

/** Leaf area around camera (meters). */
const LEAF_AREA = 80;

/** Leaf fall speed (m/s). */
const LEAF_FALL_SPEED = 2;

/** Leaf horizontal drift speed (m/s). */
const LEAF_DRIFT_SPEED = 1.2;

/** Star count on the sky dome. */
const STAR_COUNT = 400;

/** Star dome radius (meters) — must be inside camera far plane but beyond fog. */
const STAR_RADIUS = 2500;

/** Moon sprite distance from camera. */
const MOON_DISTANCE = 3000;

/** Moon sprite scale. */
const MOON_SCALE = 100;

const DEG = Math.PI / 180;

export class SkyAndFog {
  private readonly gameRenderer: GameRenderer;
  private sky: Sky | null = null;
  private rainParticles: THREE.Points | null = null;
  private rainGeometry: THREE.BufferGeometry | null = null;
  private snowParticles: THREE.Points | null = null;
  private snowGeometry: THREE.BufferGeometry | null = null;
  private snowTime = 0;
  private moonSprite: THREE.Sprite | null = null;
  private cloudGroup: THREE.Group | null = null;
  private cloudTexture: THREE.Texture | null = null;
  private cloudsEnabled = false;
  private dustParticles: THREE.Points | null = null;
  private dustGeometry: THREE.BufferGeometry | null = null;
  private dustTime = 0;
  private leafParticles: THREE.Points | null = null;
  private leafGeometry: THREE.BufferGeometry | null = null;
  private leafTime = 0;
  private starParticles: THREE.Points | null = null;
  private starGeometry: THREE.BufferGeometry | null = null;
  private currentWeather: WeatherType = 'sunny';

  /** Route location for astronomical calculations. */
  private latitude = 25.0; // default: ~Taipei
  private longitude = 121.5;

  /** Whether day/night system is enabled. */
  private dayNightEnabled = true;

  /** Latest celestial state (exposed for external consumers like player lights). */
  private _celestial: CelestialState | null = null;

  constructor(gameRenderer: GameRenderer) {
    this.gameRenderer = gameRenderer;
  }

  /** Get current celestial state (null if day/night is disabled). */
  get celestial(): CelestialState | null {
    return this._celestial;
  }

  /** Set the geographic location of the route for sun/moon calculation. */
  setLocation(latitude: number, longitude: number): void {
    this.latitude = latitude;
    this.longitude = longitude;
  }

  /** Enable or disable the day/night cycle. */
  setDayNightEnabled(enabled: boolean): void {
    this.dayNightEnabled = enabled;
    if (!enabled && this.moonSprite) {
      this.moonSprite.visible = false;
    }
  }

  /** Initialize the sky. Call once after GameRenderer is set up. */
  init(): void {
    this.sky = new Sky();
    this.sky.scale.setScalar(4500);
    this.gameRenderer.scene.add(this.sky);

    // Moon sprite — always created, visibility toggled
    this.createMoonSprite();

    // Default to sunny daytime
    this.setWeather({ type: 'sunny', sunElevation: 45, sunAzimuth: 180 });

    // Stars — created once, visibility toggled by day/night
    this.createStars();

    // Ambient particles (always-on, any weather)
    this.createDust();
    this.createLeaves();
  }

  /** Update weather type. The day/night system overrides sun position. */
  setWeather(config: WeatherConfig): void {
    this.currentWeather = config.type;

    // Hide sky for non-sunny weather — Preetham shader outputs extreme HDR
    // values at the horizon causing blown-out white. Only sunny uses the
    // sky dome; cloudy/rainy/snowy use flat scene.background instead.
    if (this.sky) {
      this.sky.visible = config.type === 'sunny';
    }

    if (!this.dayNightEnabled) {
      // Legacy behavior: use provided sun position directly
      this.updateSky(config);
      this.updateLightingLegacy(config);
      this.updateFogLegacy(config);
    }
    // When day/night is enabled, update() handles everything per-frame.

    this.updateRain(config.type === 'rainy');
    this.updateSnow(config.type === 'snowy');
  }

  /**
   * Per-frame update. Call from game loop.
   * Animates rain, updates sun/moon positions, and adjusts lighting.
   */
  update(dt: number, cameraPosition: THREE.Vector3): void {
    if (this.dayNightEnabled) {
      this.updateDayNight(cameraPosition);
    }

    if (this.currentWeather === 'rainy' && this.rainGeometry) {
      this.animateRain(dt, cameraPosition);
    }

    if (this.currentWeather === 'snowy' && this.snowGeometry) {
      this.animateSnow(dt, cameraPosition);
    }

    if (this.cloudsEnabled && this.cloudGroup) {
      this.animateClouds(dt, cameraPosition);
    }

    // Ambient particles (always active)
    if (this.dustGeometry) this.animateDust(dt, cameraPosition);
    if (this.leafGeometry) this.animateLeaves(dt, cameraPosition);
  }

  dispose(): void {
    if (this.sky) {
      this.gameRenderer.scene.remove(this.sky);
      this.sky.geometry.dispose();
      (this.sky.material as THREE.Material).dispose();
      this.sky = null;
    }
    this.disposeMoonSprite();
    this.removeRain();
    this.removeSnow();
    this.removeClouds();
    if (this.cloudTexture) {
      this.cloudTexture.dispose();
      this.cloudTexture = null;
    }
    this.removeDust();
    this.removeLeaves();
    this.removeStars();
  }

  // ── Day/Night core ──

  private updateDayNight(cameraPosition: THREE.Vector3): void {
    const celestial = getCelestialState(this.latitude, this.longitude);
    this._celestial = celestial;

    // Update sky shader sun position
    this.updateSky({
      type: this.currentWeather,
      sunElevation: celestial.sunElevation,
      sunAzimuth: celestial.sunAzimuth,
    });

    // Hide sky shader when:
    // 1. Sun below civil twilight (-6°) — Preetham renders black
    // 2. Non-sunny weather — Preetham outputs extreme HDR at horizon.
    //    Only sunny uses the sky dome; others use flat scene.background.
    const SKY_HIDE_THRESHOLD = -6;
    if (this.sky) {
      this.sky.visible = celestial.sunElevation > SKY_HIDE_THRESHOLD
        && this.currentWeather === 'sunny';
    }

    // Compute lighting from celestial state + weather
    const lighting = computeDayNightLighting(celestial, this.currentWeather);

    // Apply lighting
    const { ambientLight, directionalLight, hemisphereLight } = this.gameRenderer;
    ambientLight.intensity = lighting.ambientIntensity;
    ambientLight.color.setHex(lighting.ambientColor);
    directionalLight.intensity = lighting.directionalIntensity;
    directionalLight.color.setHex(lighting.directionalColor);
    hemisphereLight.intensity = lighting.hemisphereIntensity;
    hemisphereLight.color.setHex(lighting.hemisphereColor);
    hemisphereLight.groundColor.setHex(lighting.hemisphereGroundColor);

    // Directional light position follows sun (daytime) or moon (nighttime).
    // Clamp minimum elevation to 15° so light always illuminates terrain surfaces
    // even at sunrise/sunset. The sky shader still uses the real sun position.
    const MIN_LIGHT_ELEV = 15;
    if (celestial.isDaytime) {
      const clampedElev = Math.max(MIN_LIGHT_ELEV, celestial.sunElevation);
      const phi = DEG * (90 - clampedElev);
      const theta = DEG * celestial.sunAzimuth;
      directionalLight.position.setFromSphericalCoords(200, phi, theta);
    } else {
      const moonElev = Math.max(MIN_LIGHT_ELEV, celestial.moonElevation);
      const phi = DEG * (90 - moonElev);
      const theta = DEG * celestial.moonAzimuth;
      directionalLight.position.setFromSphericalCoords(200, phi, theta);
    }

    // Fog and background
    this.gameRenderer.setFog(lighting.fogNear, lighting.fogFar, lighting.fogColor);
    this.gameRenderer.setBackground(lighting.backgroundColor);
    this.gameRenderer.setToneMappingExposure(lighting.toneMappingExposure);

    // Moon sprite
    this.updateMoonSprite(celestial, cameraPosition);

    // Stars — fade in during twilight, full at night
    this.updateStars(celestial, cameraPosition);
  }

  // ── Moon sprite ──

  private createMoonSprite(): void {
    // Procedural moon texture: white circle with soft edge
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // Radial gradient: bright center → transparent edge
    const gradient = ctx.createRadialGradient(
      size / 2, size / 2, 0,
      size / 2, size / 2, size / 2,
    );
    gradient.addColorStop(0, 'rgba(255, 253, 240, 1.0)');
    gradient.addColorStop(0.6, 'rgba(255, 253, 240, 0.9)');
    gradient.addColorStop(0.85, 'rgba(230, 230, 210, 0.3)');
    gradient.addColorStop(1, 'rgba(200, 200, 180, 0.0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.moonSprite = new THREE.Sprite(material);
    this.moonSprite.scale.setScalar(MOON_SCALE);
    this.moonSprite.visible = false;
    this.gameRenderer.scene.add(this.moonSprite);
  }

  private updateMoonSprite(
    celestial: CelestialState,
    cameraPosition: THREE.Vector3,
  ): void {
    if (!this.moonSprite) return;

    // Show moon when sun is below ~5° (approaching/during night)
    const showMoon = celestial.sunElevation < 5 && celestial.moonElevation > -5;
    this.moonSprite.visible = showMoon;

    if (!showMoon) return;

    // Position moon using spherical coordinates relative to camera
    const phi = DEG * (90 - celestial.moonElevation);
    const theta = DEG * celestial.moonAzimuth;
    const pos = new THREE.Vector3().setFromSphericalCoords(MOON_DISTANCE, phi, theta);
    this.moonSprite.position.copy(cameraPosition).add(pos);

    // Brightness based on moon phase (full moon = brightest)
    const fullness = 1 - 2 * Math.abs(celestial.moonPhase - 0.5);
    const opacity = 0.3 + 0.7 * fullness;
    (this.moonSprite.material as THREE.SpriteMaterial).opacity = opacity;

    // Scale slightly with fullness
    const scale = MOON_SCALE * (0.8 + 0.2 * fullness);
    this.moonSprite.scale.setScalar(scale);
  }

  private disposeMoonSprite(): void {
    if (this.moonSprite) {
      this.gameRenderer.scene.remove(this.moonSprite);
      const mat = this.moonSprite.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
      this.moonSprite = null;
    }
  }

  // ── Stars ──

  /** Star texture: tiny radial glow (8×8). */
  private static createStarTexture(): THREE.CanvasTexture {
    const size = 8;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(
      size / 2, size / 2, 0,
      size / 2, size / 2, size / 2,
    );
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
    gradient.addColorStop(0.3, 'rgba(255, 255, 255, 0.8)');
    gradient.addColorStop(0.7, 'rgba(200, 210, 255, 0.2)');
    gradient.addColorStop(1, 'rgba(200, 210, 255, 0.0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private createStars(): void {
    this.starGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(STAR_COUNT * 3);

    for (let i = 0; i < STAR_COUNT; i++) {
      // Random position on upper hemisphere shell
      const elevation = (10 + Math.random() * 75) * DEG; // 10°–85° above horizon
      const azimuth = Math.random() * Math.PI * 2;
      const r = STAR_RADIUS;

      positions[i * 3] = r * Math.cos(elevation) * Math.sin(azimuth);
      positions[i * 3 + 1] = r * Math.sin(elevation); // y = up
      positions[i * 3 + 2] = r * Math.cos(elevation) * Math.cos(azimuth);
    }

    this.starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 2.5,
      sizeAttenuation: false, // size in screen pixels — visible at any distance
      map: SkyAndFog.createStarTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false, // stars are beyond fog distance, don't fade them
      blending: THREE.AdditiveBlending,
    });

    this.starParticles = new THREE.Points(this.starGeometry, material);
    this.starParticles.visible = false;
    this.gameRenderer.scene.add(this.starParticles);
  }

  private updateStars(celestial: CelestialState, cameraPosition: THREE.Vector3): void {
    if (!this.starParticles) return;

    const sunElev = celestial.sunElevation;

    // Compute base opacity from sun elevation:
    //   > 0°  → 0 (hidden)
    //   0° to -6° → fade in 0→1
    //   < -6° → 1 (full)
    let baseOpacity: number;
    if (sunElev > 0) {
      baseOpacity = 0;
    } else if (sunElev > -6) {
      baseOpacity = -sunElev / 6; // 0 at 0°, 1 at -6°
    } else {
      baseOpacity = 1;
    }

    // Weather dimming: clouds/rain/snow reduce star visibility
    let weatherMul = 1;
    switch (this.currentWeather) {
      case 'cloudy': weatherMul = 0.15; break;
      case 'rainy':  weatherMul = 0.05; break;
      case 'snowy':  weatherMul = 0.1;  break;
    }

    const finalOpacity = baseOpacity * weatherMul;
    this.starParticles.visible = finalOpacity > 0.01;

    if (this.starParticles.visible) {
      (this.starParticles.material as THREE.PointsMaterial).opacity = finalOpacity;
      // Center star dome on camera so stars stay at consistent distance
      this.starParticles.position.x = cameraPosition.x;
      this.starParticles.position.z = cameraPosition.z;
    }
  }

  private removeStars(): void {
    if (this.starParticles) {
      this.gameRenderer.scene.remove(this.starParticles);
      this.starGeometry?.dispose();
      const mat = this.starParticles.material as THREE.PointsMaterial;
      mat.map?.dispose();
      mat.dispose();
      this.starParticles = null;
      this.starGeometry = null;
    }
  }

  // ── Procedural textures (Canvas API, no image files) ──

  /** Raindrop texture: elongated ellipse (16×64). */
  private static createRainTexture(): THREE.CanvasTexture {
    const w = 16, h = 64;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(w / 2, 0, w / 2, h);
    gradient.addColorStop(0, 'rgba(180, 200, 255, 0)');
    gradient.addColorStop(0.3, 'rgba(180, 200, 255, 0.6)');
    gradient.addColorStop(0.7, 'rgba(200, 220, 255, 0.9)');
    gradient.addColorStop(1, 'rgba(220, 235, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w / 2 - 1, h / 2 - 1, 0, 0, Math.PI * 2);
    ctx.fill();
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  /** Snowflake texture: soft radial glow (32×32). */
  private static createSnowTexture(): THREE.CanvasTexture {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(
      size / 2, size / 2, 0,
      size / 2, size / 2, size / 2,
    );
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
    gradient.addColorStop(0.4, 'rgba(255, 255, 255, 0.8)');
    gradient.addColorStop(0.7, 'rgba(240, 245, 255, 0.3)');
    gradient.addColorStop(1, 'rgba(220, 230, 255, 0.0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  /** Cloud billboard texture: fluffy cloud shape (256×128). */
  private static createCloudTexture(): THREE.CanvasTexture {
    const w = 256, h = 128;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;

    // Draw overlapping ellipses to simulate a fluffy cloud shape
    ctx.globalCompositeOperation = 'source-over';
    const blobs = [
      { x: 0.5, y: 0.55, rx: 0.35, ry: 0.35 },
      { x: 0.3, y: 0.6, rx: 0.25, ry: 0.28 },
      { x: 0.7, y: 0.6, rx: 0.25, ry: 0.28 },
      { x: 0.2, y: 0.65, rx: 0.18, ry: 0.2 },
      { x: 0.8, y: 0.65, rx: 0.18, ry: 0.2 },
      { x: 0.4, y: 0.45, rx: 0.22, ry: 0.25 },
      { x: 0.6, y: 0.45, rx: 0.22, ry: 0.25 },
    ];

    for (const blob of blobs) {
      const cx = blob.x * w;
      const cy = blob.y * h;
      const rx = blob.rx * w;
      const ry = blob.ry * h;
      const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
      gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.5)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  // ── Billboard clouds ──

  /** Enable or disable billboard cloud layer. */
  setCloudsEnabled(enabled: boolean): void {
    this.cloudsEnabled = enabled;
    if (enabled && !this.cloudGroup) {
      this.createClouds();
    } else if (!enabled && this.cloudGroup) {
      this.removeClouds();
    }
  }

  private createClouds(): void {
    if (!this.cloudTexture) {
      this.cloudTexture = SkyAndFog.createCloudTexture();
    }

    this.cloudGroup = new THREE.Group();

    for (let i = 0; i < CLOUD_COUNT; i++) {
      const width = 50 + Math.random() * 100;
      const height = width * 0.4 + Math.random() * width * 0.2;
      const geometry = new THREE.PlaneGeometry(width, height);
      const material = new THREE.MeshBasicMaterial({
        map: this.cloudTexture,
        transparent: true,
        opacity: 0.4 + Math.random() * 0.3,
        side: THREE.DoubleSide,
        depthWrite: false,
      });

      const mesh = new THREE.Mesh(geometry, material);
      // Random position within cloud area
      mesh.position.set(
        (Math.random() - 0.5) * CLOUD_AREA,
        CLOUD_MIN_Y + Math.random() * (CLOUD_MAX_Y - CLOUD_MIN_Y),
        (Math.random() - 0.5) * CLOUD_AREA,
      );
      // Face downward (horizontal plane) with slight random rotation
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = Math.random() * Math.PI * 2;
      // Store a per-cloud drift offset for variation
      mesh.userData.driftOffset = Math.random() * Math.PI * 2;

      this.cloudGroup.add(mesh);
    }

    this.gameRenderer.scene.add(this.cloudGroup);
  }

  private removeClouds(): void {
    if (this.cloudGroup) {
      this.gameRenderer.scene.remove(this.cloudGroup);
      for (const child of this.cloudGroup.children) {
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      this.cloudGroup = null;
    }
  }

  private animateClouds(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.cloudGroup) return;

    // Keep cloud group centered on camera XZ
    this.cloudGroup.position.x = cameraPosition.x;
    this.cloudGroup.position.z = cameraPosition.z;

    // Gentle drift for each cloud
    for (const child of this.cloudGroup.children) {
      const mesh = child as THREE.Mesh;
      const offset = mesh.userData.driftOffset as number;
      mesh.position.x += Math.sin(offset + performance.now() * 0.0003) * CLOUD_DRIFT_SPEED * dt;
      mesh.position.z += Math.cos(offset + performance.now() * 0.0002) * CLOUD_DRIFT_SPEED * 0.5 * dt;

      // Wrap around if drifted too far from center
      const halfArea = CLOUD_AREA / 2;
      if (mesh.position.x > halfArea) mesh.position.x -= CLOUD_AREA;
      if (mesh.position.x < -halfArea) mesh.position.x += CLOUD_AREA;
      if (mesh.position.z > halfArea) mesh.position.z -= CLOUD_AREA;
      if (mesh.position.z < -halfArea) mesh.position.z += CLOUD_AREA;
    }
  }

  // ── Dust (ambient) ──

  /** Dust texture: small warm-toned radial dot (16×16). */
  private static createDustTexture(): THREE.CanvasTexture {
    const size = 16;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(
      size / 2, size / 2, 0,
      size / 2, size / 2, size / 2,
    );
    gradient.addColorStop(0, 'rgba(210, 190, 150, 0.7)');
    gradient.addColorStop(0.5, 'rgba(210, 190, 150, 0.3)');
    gradient.addColorStop(1, 'rgba(210, 190, 150, 0.0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private createDust(): void {
    this.dustGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(DUST_PARTICLE_COUNT * 3);

    for (let i = 0; i < DUST_PARTICLE_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * DUST_AREA;
      positions[i * 3 + 1] = 0.5 + Math.random() * 7.5; // y: 0.5–8m
      positions[i * 3 + 2] = (Math.random() - 0.5) * DUST_AREA;
    }

    this.dustGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3),
    );

    const material = new THREE.PointsMaterial({
      color: 0xd2be96,
      size: 0.15,
      map: SkyAndFog.createDustTexture(),
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });

    this.dustParticles = new THREE.Points(this.dustGeometry, material);
    this.gameRenderer.scene.add(this.dustParticles);
  }

  private removeDust(): void {
    if (this.dustParticles) {
      this.gameRenderer.scene.remove(this.dustParticles);
      this.dustGeometry?.dispose();
      (this.dustParticles.material as THREE.Material).dispose();
      this.dustParticles = null;
      this.dustGeometry = null;
    }
  }

  private animateDust(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.dustGeometry) return;

    this.dustTime += dt;

    // Center around camera
    if (this.dustParticles) {
      this.dustParticles.position.x = cameraPosition.x;
      this.dustParticles.position.z = cameraPosition.z;
    }

    const positions = this.dustGeometry.attributes.position as THREE.BufferAttribute;
    const arr = positions.array as Float32Array;

    for (let i = 0; i < DUST_PARTICLE_COUNT; i++) {
      const idx = i * 3;
      // Gentle horizontal drift (no vertical fall)
      arr[idx] += Math.sin(this.dustTime * 0.3 + i * 1.7) * DUST_DRIFT_SPEED * dt;
      arr[idx + 2] += Math.cos(this.dustTime * 0.4 + i * 2.3) * DUST_DRIFT_SPEED * 0.7 * dt;
      // Slight vertical bob
      arr[idx + 1] += Math.sin(this.dustTime * 0.2 + i * 3.1) * 0.1 * dt;

      // Wrap around
      const half = DUST_AREA / 2;
      if (arr[idx] > half) arr[idx] -= DUST_AREA;
      if (arr[idx] < -half) arr[idx] += DUST_AREA;
      if (arr[idx + 2] > half) arr[idx + 2] -= DUST_AREA;
      if (arr[idx + 2] < -half) arr[idx + 2] += DUST_AREA;
      // Keep y in range
      if (arr[idx + 1] < 0.5) arr[idx + 1] = 0.5;
      if (arr[idx + 1] > 8) arr[idx + 1] = 8;
    }

    positions.needsUpdate = true;
  }

  // ── Leaves (ambient) ──

  /** Leaf texture: simple oval leaf shape (32×32). */
  private static createLeafTexture(): THREE.CanvasTexture {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // Leaf body — ellipse with green-brown gradient
    const cx = size / 2, cy = size / 2;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
    gradient.addColorStop(0, 'rgba(120, 160, 60, 0.9)');
    gradient.addColorStop(0.6, 'rgba(140, 130, 50, 0.7)');
    gradient.addColorStop(1, 'rgba(100, 80, 30, 0.0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(cx, cy, size / 2 - 2, size / 3 - 1, 0, 0, Math.PI * 2);
    ctx.fill();

    // Leaf vein — center line
    ctx.strokeStyle = 'rgba(80, 100, 40, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(4, cy);
    ctx.lineTo(size - 4, cy);
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private createLeaves(): void {
    this.leafGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(LEAF_PARTICLE_COUNT * 3);

    for (let i = 0; i < LEAF_PARTICLE_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * LEAF_AREA;
      positions[i * 3 + 1] = 2 + Math.random() * 13; // y: 2–15m
      positions[i * 3 + 2] = (Math.random() - 0.5) * LEAF_AREA;
    }

    this.leafGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3),
    );

    const material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.6,
      map: SkyAndFog.createLeafTexture(),
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });

    this.leafParticles = new THREE.Points(this.leafGeometry, material);
    this.gameRenderer.scene.add(this.leafParticles);
  }

  private removeLeaves(): void {
    if (this.leafParticles) {
      this.gameRenderer.scene.remove(this.leafParticles);
      this.leafGeometry?.dispose();
      (this.leafParticles.material as THREE.Material).dispose();
      this.leafParticles = null;
      this.leafGeometry = null;
    }
  }

  private animateLeaves(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.leafGeometry) return;

    this.leafTime += dt;

    // Center around camera
    if (this.leafParticles) {
      this.leafParticles.position.x = cameraPosition.x;
      this.leafParticles.position.z = cameraPosition.z;
    }

    const positions = this.leafGeometry.attributes.position as THREE.BufferAttribute;
    const arr = positions.array as Float32Array;

    for (let i = 0; i < LEAF_PARTICLE_COUNT; i++) {
      const idx = i * 3;
      // Slow fall
      arr[idx + 1] -= LEAF_FALL_SPEED * dt;
      // Swaying horizontal drift
      arr[idx] += Math.sin(this.leafTime * 0.6 + i * 2.1) * LEAF_DRIFT_SPEED * dt;
      arr[idx + 2] += Math.cos(this.leafTime * 0.5 + i * 1.7) * LEAF_DRIFT_SPEED * 0.6 * dt;

      // Reset to top when below ground
      if (arr[idx + 1] < 0) {
        arr[idx] = (Math.random() - 0.5) * LEAF_AREA;
        arr[idx + 1] = 10 + Math.random() * 5;
        arr[idx + 2] = (Math.random() - 0.5) * LEAF_AREA;
      }

      // Wrap around horizontally
      const half = LEAF_AREA / 2;
      if (arr[idx] > half) arr[idx] -= LEAF_AREA;
      if (arr[idx] < -half) arr[idx] += LEAF_AREA;
      if (arr[idx + 2] > half) arr[idx + 2] -= LEAF_AREA;
      if (arr[idx + 2] < -half) arr[idx + 2] += LEAF_AREA;
    }

    positions.needsUpdate = true;
  }

  // ── Sky shader ──

  private updateSky(config: WeatherConfig): void {
    if (!this.sky) return;

    const uniforms = this.sky.material.uniforms;

    switch (config.type) {
      case 'sunny':
        uniforms['turbidity'].value = 2;
        uniforms['rayleigh'].value = 1;
        uniforms['mieCoefficient'].value = 0.003;
        uniforms['mieDirectionalG'].value = 0.8;
        break;
      case 'cloudy':
        uniforms['turbidity'].value = 20;
        uniforms['rayleigh'].value = 0.3;
        uniforms['mieCoefficient'].value = 0.08;
        uniforms['mieDirectionalG'].value = 0.1;
        break;
      case 'rainy':
        uniforms['turbidity'].value = 15;
        uniforms['rayleigh'].value = 0.5;
        uniforms['mieCoefficient'].value = 0.05;
        uniforms['mieDirectionalG'].value = 0.1;
        break;
      case 'snowy':
        uniforms['turbidity'].value = 10;
        uniforms['rayleigh'].value = 0.3;
        uniforms['mieCoefficient'].value = 0.06;
        uniforms['mieDirectionalG'].value = 0.1;
        break;
    }

    // Sun position from elevation + azimuth
    const phi = DEG * (90 - config.sunElevation);
    const theta = DEG * config.sunAzimuth;
    const sunPosition = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    uniforms['sunPosition'].value.copy(sunPosition);
  }

  // ── Legacy lighting (used when day/night is disabled) ──

  private updateLightingLegacy(config: WeatherConfig): void {
    const { ambientLight, directionalLight, hemisphereLight } = this.gameRenderer;

    switch (config.type) {
      case 'sunny':
        ambientLight.intensity = 0.5;
        ambientLight.color.setHex(0xffffff);
        directionalLight.intensity = 0.9;
        directionalLight.color.setHex(0xfff4e0);
        hemisphereLight.intensity = 0.4;
        hemisphereLight.color.setHex(0x87ceeb);
        hemisphereLight.groundColor.setHex(0x556633);
        break;
      case 'cloudy':
        ambientLight.intensity = 0.6;
        ambientLight.color.setHex(0xcccccc);
        directionalLight.intensity = 0.3;
        directionalLight.color.setHex(0xdddddd);
        hemisphereLight.intensity = 0.5;
        hemisphereLight.color.setHex(0xaaaaaa);
        hemisphereLight.groundColor.setHex(0x444433);
        break;
      case 'rainy':
        ambientLight.intensity = 0.4;
        ambientLight.color.setHex(0x999999);
        directionalLight.intensity = 0.15;
        directionalLight.color.setHex(0xaaaaaa);
        hemisphereLight.intensity = 0.3;
        hemisphereLight.color.setHex(0x888888);
        hemisphereLight.groundColor.setHex(0x333322);
        break;
      case 'snowy':
        ambientLight.intensity = 0.55;
        ambientLight.color.setHex(0xddddee);
        directionalLight.intensity = 0.25;
        directionalLight.color.setHex(0xccccdd);
        hemisphereLight.intensity = 0.4;
        hemisphereLight.color.setHex(0xbbbbcc);
        hemisphereLight.groundColor.setHex(0x444444);
        break;
    }

    // Sun direction
    const phi = DEG * (90 - config.sunElevation);
    const theta = DEG * config.sunAzimuth;
    directionalLight.position.setFromSphericalCoords(200, phi, theta);
  }

  private updateFogLegacy(config: WeatherConfig): void {
    switch (config.type) {
      case 'sunny':
        this.gameRenderer.setFog(800, 3000, 0xdce6f0);
        this.gameRenderer.setBackground(0x87ceeb);
        break;
      case 'cloudy':
        this.gameRenderer.setFog(400, 1800, 0xbbbbbb);
        this.gameRenderer.setBackground(0xaaaaaa);
        break;
      case 'rainy':
        this.gameRenderer.setFog(150, 800, 0x888888);
        this.gameRenderer.setBackground(0x777777);
        break;
      case 'snowy':
        this.gameRenderer.setFog(200, 900, 0xcccccc);
        this.gameRenderer.setBackground(0xbbbbbb);
        break;
    }
  }

  // ── Rain ──

  private updateRain(enable: boolean): void {
    if (enable && !this.rainParticles) {
      this.createRain();
    } else if (!enable && this.rainParticles) {
      this.removeRain();
    }
  }

  private createRain(): void {
    this.rainGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(RAIN_PARTICLE_COUNT * 3);

    for (let i = 0; i < RAIN_PARTICLE_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * RAIN_AREA;
      positions[i * 3 + 1] = Math.random() * RAIN_AREA;
      positions[i * 3 + 2] = (Math.random() - 0.5) * RAIN_AREA;
    }

    this.rainGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3),
    );

    const material = new THREE.PointsMaterial({
      color: 0xaaaacc,
      size: 0.5,
      map: SkyAndFog.createRainTexture(),
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.rainParticles = new THREE.Points(this.rainGeometry, material);
    this.gameRenderer.scene.add(this.rainParticles);
  }

  private removeRain(): void {
    if (this.rainParticles) {
      this.gameRenderer.scene.remove(this.rainParticles);
      this.rainGeometry?.dispose();
      (this.rainParticles.material as THREE.Material).dispose();
      this.rainParticles = null;
      this.rainGeometry = null;
    }
  }

  private animateRain(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.rainGeometry) return;

    // Center rain around camera
    if (this.rainParticles) {
      this.rainParticles.position.x = cameraPosition.x;
      this.rainParticles.position.z = cameraPosition.z;
    }

    const positions = this.rainGeometry.attributes.position as THREE.BufferAttribute;
    const arr = positions.array as Float32Array;

    for (let i = 0; i < RAIN_PARTICLE_COUNT; i++) {
      arr[i * 3 + 1] -= RAIN_SPEED * dt; // fall down
      if (arr[i * 3 + 1] < 0) {
        arr[i * 3 + 1] = RAIN_AREA; // reset to top
        arr[i * 3] = (Math.random() - 0.5) * RAIN_AREA;
        arr[i * 3 + 2] = (Math.random() - 0.5) * RAIN_AREA;
      }
    }

    positions.needsUpdate = true;
  }

  // ── Snow ──

  private updateSnow(enable: boolean): void {
    if (enable && !this.snowParticles) {
      this.createSnow();
    } else if (!enable && this.snowParticles) {
      this.removeSnow();
    }
  }

  private createSnow(): void {
    this.snowGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(SNOW_PARTICLE_COUNT * 3);

    for (let i = 0; i < SNOW_PARTICLE_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * SNOW_AREA;
      positions[i * 3 + 1] = Math.random() * SNOW_AREA;
      positions[i * 3 + 2] = (Math.random() - 0.5) * SNOW_AREA;
    }

    this.snowGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3),
    );

    const material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.6,
      map: SkyAndFog.createSnowTexture(),
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });

    this.snowParticles = new THREE.Points(this.snowGeometry, material);
    this.gameRenderer.scene.add(this.snowParticles);
  }

  private removeSnow(): void {
    if (this.snowParticles) {
      this.gameRenderer.scene.remove(this.snowParticles);
      this.snowGeometry?.dispose();
      (this.snowParticles.material as THREE.Material).dispose();
      this.snowParticles = null;
      this.snowGeometry = null;
    }
  }

  private animateSnow(dt: number, cameraPosition: THREE.Vector3): void {
    if (!this.snowGeometry) return;

    this.snowTime += dt;

    // Center snow around camera
    if (this.snowParticles) {
      this.snowParticles.position.x = cameraPosition.x;
      this.snowParticles.position.z = cameraPosition.z;
    }

    const positions = this.snowGeometry.attributes.position as THREE.BufferAttribute;
    const arr = positions.array as Float32Array;

    for (let i = 0; i < SNOW_PARTICLE_COUNT; i++) {
      const idx = i * 3;
      // Slow fall
      arr[idx + 1] -= SNOW_SPEED * dt;
      // Horizontal drift (sin/cos for gentle swaying)
      arr[idx] += Math.sin(this.snowTime * 0.5 + i) * SNOW_DRIFT_SPEED * dt;
      arr[idx + 2] += Math.cos(this.snowTime * 0.7 + i * 0.3) * SNOW_DRIFT_SPEED * 0.5 * dt;

      // Reset to top when below ground
      if (arr[idx + 1] < 0) {
        arr[idx] = (Math.random() - 0.5) * SNOW_AREA;
        arr[idx + 1] = SNOW_AREA;
        arr[idx + 2] = (Math.random() - 0.5) * SNOW_AREA;
      }
    }

    positions.needsUpdate = true;
  }
}
