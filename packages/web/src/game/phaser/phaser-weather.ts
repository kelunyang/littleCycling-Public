/**
 * Phaser 2D weather, day/night, and starfield renderer.
 *
 * Reuses data from useWeatherApi and sun-moon-calc.ts,
 * providing a visual Phaser layer with:
 * - Sky gradient (day/twilight/night)
 * - Stars (pre-rendered texture, alpha-controlled)
 * - Moon (phase-aware)
 * - Rain/snow particle emitters
 * - Clouds (horizontal drift)
 * - Fog overlay
 */

import Phaser from 'phaser';
import { GROUND_BASELINE_Y } from './phaser2d-scene';
import type { PhaserStyleStrategy } from './phaser-style-strategy';

export type WeatherType = 'sunny' | 'cloudy' | 'rainy' | 'snowy';

export interface PhaserWeatherState {
  type: WeatherType;
  sunElevation: number;  // degrees
  moonPhase: number;     // 0-1
}

/** Star positions — generated once, drawn to texture. */
interface Star {
  x: number; // 0-1 fraction of width
  y: number; // 0-1 fraction of sky height
  size: number;
  brightness: number; // 0-1
}

const STAR_TEXTURE_KEY = '__phaser_starfield__';

export class PhaserWeatherSystem {
  private scene: Phaser.Scene;
  private strategy: PhaserStyleStrategy;
  private state: PhaserWeatherState = {
    type: 'sunny',
    sunElevation: 45,
    moonPhase: 0,
  };

  // Graphics layers
  private skyGfx: Phaser.GameObjects.Graphics;
  private cloudGfx: Phaser.GameObjects.Graphics;
  private fogGfx: Phaser.GameObjects.Graphics;
  private moonGfx: Phaser.GameObjects.Graphics;
  private farMountainGfx: Phaser.GameObjects.Graphics;
  private nearHillGfx: Phaser.GameObjects.Graphics;

  // Stars as pre-rendered image (not Graphics)
  private starImage: Phaser.GameObjects.Image | null = null;
  private stars: Star[] = [];

  // Rain/snow particles
  private rainEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private snowEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;

  // Cloud positions (world X drift)
  private clouds: { x: number; y: number; w: number; h: number; speed: number }[] = [];
  private cloudsEnabled = true;

  // Dirty flags — skip redraws when values haven't changed
  private lastSunElev = NaN;
  private lastWeatherType = '';
  private lastParallaxSunElev = NaN;
  private lastParallaxWeather = '';

  /** Random seed for mountain shapes — fixed per session so parallax redraws are stable. */
  private mountainSeed = Math.floor(Math.random() * 100000);

  constructor(scene: Phaser.Scene, strategy: PhaserStyleStrategy) {
    this.scene = scene;
    this.strategy = strategy;

    const w = Number(scene.game.config.width);
    const h = Number(scene.game.config.height);
    const skyH = h * GROUND_BASELINE_Y;

    // Create layers from back to front
    this.skyGfx = scene.add.graphics();
    this.skyGfx.setScrollFactor(0);
    this.skyGfx.setDepth(-100);

    this.cloudGfx = scene.add.graphics();
    this.cloudGfx.setScrollFactor(0);
    this.cloudGfx.setDepth(-97);

    this.moonGfx = scene.add.graphics();
    this.moonGfx.setScrollFactor(0);
    this.moonGfx.setDepth(-98);

    this.fogGfx = scene.add.graphics();
    this.fogGfx.setScrollFactor(0);
    this.fogGfx.setDepth(900);

    // Parallax background layers
    this.farMountainGfx = scene.add.graphics();
    this.farMountainGfx.setScrollFactor(0.1, 0);
    this.farMountainGfx.setDepth(-90);

    this.nearHillGfx = scene.add.graphics();
    this.nearHillGfx.setScrollFactor(0.3, 0);
    this.nearHillGfx.setDepth(-80);

    this.drawParallax(w, skyH);

    // Generate star data
    for (let i = 0; i < 400; i++) {
      this.stars.push({
        x: Math.random(),
        y: Math.random() * 0.7,
        size: 0.5 + Math.random() * 1.5,
        brightness: 0.3 + Math.random() * 0.7,
      });
    }

    // Pre-render stars to a canvas texture (drawn ONCE, alpha-controlled at runtime)
    this.createStarTexture(w, skyH);

    // Generate clouds
    for (let i = 0; i < 8; i++) {
      this.clouds.push({
        x: Math.random() * 1200,
        y: 20 + Math.random() * 100,
        w: 60 + Math.random() * 120,
        h: 15 + Math.random() * 25,
        speed: 0.1 + Math.random() * 0.3,
      });
    }

    this.initParticles();
  }

  /** Pre-render 400 stars to a static canvas texture. */
  private createStarTexture(w: number, skyH: number) {
    if (this.scene.textures.exists(STAR_TEXTURE_KEY)) {
      this.scene.textures.remove(STAR_TEXTURE_KEY);
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = Math.ceil(skyH);
    const ctx = canvas.getContext('2d')!;

    // Use strategy's star drawing for consistent look — but stars are
    // pre-rendered to canvas (not Phaser Graphics), so we draw directly via 2D context.
    for (const star of this.stars) {
      const sx = star.x * w;
      const sy = star.y * skyH;
      const alpha = star.brightness;
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.beginPath();
      ctx.arc(sx, sy, star.size, 0, Math.PI * 2);
      ctx.fill();
    }

    this.scene.textures.addCanvas(STAR_TEXTURE_KEY, canvas);
    this.starImage = this.scene.add.image(w / 2, Math.ceil(skyH) / 2, STAR_TEXTURE_KEY);
    this.starImage.setScrollFactor(0);
    this.starImage.setDepth(-99);
    this.starImage.setAlpha(0); // start hidden
  }

  setState(state: Partial<PhaserWeatherState>) {
    const prevType = this.state.type;
    Object.assign(this.state, state);
    if (state.type && state.type !== prevType) {
      this.updateParticles();
    }
  }

  setCloudsEnabled(enabled: boolean) {
    this.cloudsEnabled = enabled;
  }

  update() {
    const w = this.scene.game.canvas.width;
    const h = this.scene.game.canvas.height;
    const skyH = h * GROUND_BASELINE_Y;

    this.updateSky(w, skyH);
    this.updateStars();
    this.drawMoon(w, skyH);
    this.drawClouds(w, skyH);
    this.drawFog(w, h);

    // Parallax — only redraw when sky colors change
    if (this.state.sunElevation !== this.lastParallaxSunElev
        || this.state.type !== this.lastParallaxWeather) {
      this.lastParallaxSunElev = this.state.sunElevation;
      this.lastParallaxWeather = this.state.type;
      this.drawParallax(w, skyH);
    }
  }

  /** Only redraw sky gradient when sun elevation or weather type changes. */
  private updateSky(w: number, skyH: number) {
    if (this.state.sunElevation === this.lastSunElev
        && this.state.type === this.lastWeatherType) return;
    this.lastSunElev = this.state.sunElevation;
    this.lastWeatherType = this.state.type;

    this.skyGfx.clear();
    const { top: topColor, bottom: bottomColor } = this.strategy.getSkyColors(
      this.state.sunElevation,
      this.state.type,
    );

    const bands = 20;
    for (let i = 0; i < bands; i++) {
      const t = i / bands;
      const color = lerpColor(topColor, bottomColor, t);
      const y = t * skyH;
      this.skyGfx.fillStyle(color, 1);
      this.skyGfx.fillRect(0, y, w, skyH / bands + 1);
    }
  }

  /** Update star visibility via alpha — no per-frame Graphics redraw. */
  private updateStars() {
    if (!this.starImage) return;

    const sunElev = this.state.sunElevation;
    if (sunElev > 6) {
      this.starImage.setAlpha(0);
      return;
    }

    let starAlpha = 1;
    if (sunElev > -6) {
      starAlpha = Math.max(0, (-sunElev) / 6);
    }

    const weatherOcclusion: Record<string, number> = {
      sunny: 1,
      cloudy: 0.15,
      rainy: 0.05,
      snowy: 0.1,
    };
    starAlpha *= weatherOcclusion[this.state.type] ?? 1;

    this.starImage.setAlpha(starAlpha);
  }

  private drawMoon(w: number, skyH: number) {
    this.moonGfx.clear();

    const sunElev = this.state.sunElevation;
    if (sunElev > 10) return;

    const moonPhase = this.state.moonPhase;
    const alpha = sunElev < 0 ? 1 : Math.max(0, 1 - sunElev / 10);

    const moonX = w * 0.7;
    const moonY = skyH * 0.2;
    const moonR = 15;
    const seed = 42; // fixed seed for moon

    // Set alpha before delegating to strategy
    this.moonGfx.setAlpha(alpha);
    this.strategy.drawMoon(this.moonGfx, moonX, moonY, moonR, moonPhase, seed);

    // Draw phase shadow (sky-colored) on top
    if (moonPhase < 0.45 || moonPhase > 0.55) {
      const shadowOffset = (moonPhase < 0.5 ? 1 : -1) * moonR * 0.8;
      this.moonGfx.fillStyle(sunElev < -6 ? 0x050510 : 0x1a73e8, 1);
      this.moonGfx.fillCircle(moonX + shadowOffset, moonY, moonR * 0.9);
    }
    this.moonGfx.setAlpha(1);
  }

  private drawClouds(w: number, _skyH: number) {
    this.cloudGfx.clear();

    if (!this.cloudsEnabled) return;
    if (this.state.type === 'sunny') return;

    const cloudAlpha = this.state.type === 'cloudy' ? 0.5 :
      this.state.type === 'rainy' ? 0.7 :
        this.state.type === 'snowy' ? 0.6 : 0.3;

    for (let i = 0; i < this.clouds.length; i++) {
      const cloud = this.clouds[i];
      cloud.x += cloud.speed;
      if (cloud.x > w + cloud.w) cloud.x = -cloud.w;

      this.cloudGfx.fillStyle(this.strategy.palette.cloud, cloudAlpha);
      this.strategy.drawCloud(this.cloudGfx, cloud.x, cloud.y, cloud.w, cloud.h, i);
    }
  }

  /** Draw parallax mountain/hill layers. Redrawn when sky color changes. */
  private drawParallax(w: number, skyH: number) {
    // Determine base color from sun elevation
    const sunElev = this.state.sunElevation;
    let baseColor: number;
    if (sunElev > 10) {
      baseColor = this.strategy.palette.mountainFar;
    } else if (sunElev > 0) {
      baseColor = lerpColor(0x2a1f4e, this.strategy.palette.mountainFar, sunElev / 10);
    } else if (sunElev > -12) {
      baseColor = lerpColor(0x0a0a15, 0x2a1f4e, (sunElev + 12) / 12);
    } else {
      baseColor = 0x0a0a15;
    }

    // Weather darkening
    const weatherDim: Record<string, number> = { sunny: 1, cloudy: 0.7, rainy: 0.5, snowy: 0.6 };
    const dim = weatherDim[this.state.type] ?? 1;
    if (dim < 1) baseColor = lerpColor(baseColor, 0x000000, 1 - dim);

    // Far mountain layer — delegate point generation + rendering to strategy
    const farW = w / 0.1;
    this.farMountainGfx.clear();
    const farColor = lerpColor(baseColor, 0x000000, 0.2);
    const farBaseY = skyH * 0.85;
    const farPoints = this.strategy.generateMountainPoints(farBaseY, skyH, farW, 'far', this.mountainSeed);
    this.strategy.drawMountainSilhouette(this.farMountainGfx, farPoints, farColor, skyH, 0);

    // Near hill layer — delegate point generation + rendering to strategy
    const nearW = w / 0.3;
    this.nearHillGfx.clear();
    const nearColor = lerpColor(baseColor, 0x000000, 0.05);
    const nearBaseY = skyH * 0.92;
    const nearPoints = this.strategy.generateMountainPoints(nearBaseY, skyH, nearW, 'near', this.mountainSeed + 999);
    this.strategy.drawMountainSilhouette(this.nearHillGfx, nearPoints, nearColor, skyH, 1);
  }

  private drawFog(w: number, h: number) {
    this.fogGfx.clear();

    const sunElev = this.state.sunElevation;
    let fogAlpha = 0;

    if (sunElev < 0) fogAlpha = Math.min(0.15, (-sunElev) / 90 * 0.15);
    if (this.state.type === 'rainy') fogAlpha = Math.max(fogAlpha, 0.1);
    if (this.state.type === 'snowy') fogAlpha = Math.max(fogAlpha, 0.12);

    if (fogAlpha < 0.01) return;

    this.fogGfx.fillStyle(this.strategy.palette.fogColor, fogAlpha);
    this.fogGfx.fillRect(0, 0, w, h);
  }

  private initParticles() {
    const rainKey = '__rain_particle__';
    const snowKey = '__snow_particle__';

    if (!this.scene.textures.exists(rainKey)) {
      const rainCanvas = document.createElement('canvas');
      rainCanvas.width = 2;
      rainCanvas.height = 8;
      const rCtx = rainCanvas.getContext('2d')!;
      rCtx.fillStyle = 'rgba(180,200,255,0.6)';
      rCtx.fillRect(0, 0, 2, 8);
      this.scene.textures.addCanvas(rainKey, rainCanvas);
    }

    if (!this.scene.textures.exists(snowKey)) {
      const snowCanvas = document.createElement('canvas');
      snowCanvas.width = 4;
      snowCanvas.height = 4;
      const sCtx = snowCanvas.getContext('2d')!;
      sCtx.fillStyle = 'rgba(255,255,255,0.8)';
      sCtx.beginPath();
      sCtx.arc(2, 2, 2, 0, Math.PI * 2);
      sCtx.fill();
      this.scene.textures.addCanvas(snowKey, snowCanvas);
    }

    this.rainEmitter = this.scene.add.particles(0, 0, rainKey, {
      x: { min: 0, max: Number(this.scene.game.config.width) },
      y: -10,
      speedY: { min: 400, max: 600 },
      speedX: { min: -30, max: -10 },
      lifespan: 1500,
      frequency: 15,
      quantity: 3,
      alpha: { start: 0.6, end: 0 },
      active: false,
    });
    this.rainEmitter.setScrollFactor(0);
    this.rainEmitter.setDepth(-96);

    this.snowEmitter = this.scene.add.particles(0, 0, snowKey, {
      x: { min: 0, max: Number(this.scene.game.config.width) },
      y: -10,
      speedY: { min: 50, max: 120 },
      speedX: { min: -20, max: 20 },
      lifespan: 4000,
      frequency: 60,
      quantity: 2,
      alpha: { start: 0.8, end: 0.2 },
      scale: { min: 0.5, max: 1.5 },
      active: false,
    });
    this.snowEmitter.setScrollFactor(0);
    this.snowEmitter.setDepth(-96);
  }

  private updateParticles() {
    if (this.rainEmitter) {
      this.rainEmitter.active = this.state.type === 'rainy';
      if (this.state.type !== 'rainy') this.rainEmitter.killAll();
    }
    if (this.snowEmitter) {
      this.snowEmitter.active = this.state.type === 'snowy';
      if (this.state.type !== 'snowy') this.snowEmitter.killAll();
    }
  }

  /** Handle resize — recreate star texture and reset dirty flags. */
  onResize(w: number, h: number) {
    const skyH = h * GROUND_BASELINE_Y;

    // Recreate star texture at new size
    this.starImage?.destroy();
    this.starImage = null;
    this.createStarTexture(w, skyH);

    // Reset dirty flags to force sky redraw
    this.lastSunElev = NaN;
    this.lastWeatherType = '';
    this.lastParallaxSunElev = NaN;
    this.lastParallaxWeather = '';

    // Redraw parallax at new size
    this.drawParallax(w, skyH);
  }

  dispose() {
    this.skyGfx.destroy();
    this.starImage?.destroy();
    this.moonGfx.destroy();
    this.cloudGfx.destroy();
    this.fogGfx.destroy();
    this.farMountainGfx.destroy();
    this.nearHillGfx.destroy();
    this.rainEmitter?.destroy();
    this.snowEmitter?.destroy();
  }
}

/** Linearly interpolate between two 0xRRGGBB colors. */
export function lerpColor(c1: number, c2: number, t: number): number {
  const r1 = (c1 >> 16) & 0xff;
  const g1 = (c1 >> 8) & 0xff;
  const b1 = c1 & 0xff;
  const r2 = (c2 >> 16) & 0xff;
  const g2 = (c2 >> 8) & 0xff;
  const b2 = c2 & 0xff;
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return (r << 16) | (g << 8) | b;
}
