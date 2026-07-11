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
import { getCelestialState } from '@/game/terrain/sun-moon-calc';
import { PreethamSky } from './preetham-sky';

/** Query the host scene for its ground baseline fraction. Phaser2DScene
 *  exposes this so Welcome can lower the sky/ground boundary; if the scene
 *  is a vanilla Phaser.Scene (shouldn't happen in production), fall back to
 *  the module-level default. */
function getBaseline(scene: Phaser.Scene): number {
  const s = scene as Phaser.Scene & { getGroundBaselineFraction?: () => number };
  return s.getGroundBaselineFraction?.() ?? GROUND_BASELINE_Y;
}

export type WeatherType = 'sunny' | 'cloudy' | 'rainy' | 'snowy';

export interface PhaserWeatherState {
  type: WeatherType;
  sunElevation: number;  // degrees
  sunAzimuth: number;    // degrees, 0=N clockwise (used by Preetham + zone-aware moon)
  moonPhase: number;     // 0-1
  moonElevation: number; // degrees
  moonAzimuth: number;   // degrees
  dayFactor: number;     // 0=deep night, 1=noon (smooth twilight transitions)
}

export interface PhaserWindState {
  speedKmh: number;
  directionDeg: number;  // meteorological (0=N, where wind comes from)
  gust: number;          // amplitude factor (0.5..2)
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
    sunAzimuth: 180,    // due south (sensible default for fixed-sky welcome mode)
    moonPhase: 0,
    moonElevation: -10, // below horizon by default
    moonAzimuth: 0,
    dayFactor: 1,
  };

  /** When set, weather drives sun/moon position from real time. */
  private latitude: number | null = null;
  private longitude: number | null = null;

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
  /** Brightest ~30 stars get a per-frame twinkle on a separate Graphics layer. */
  private twinkleStars: Star[] = [];
  private starTwinkleGfx: Phaser.GameObjects.Graphics | null = null;

  // Rain/snow particles
  private rainEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private snowEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;

  // Ambient particles (always-on, weather-independent — match Three.js sky-and-fog)
  private dustEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private leafEmitter: Phaser.GameObjects.Particles.ParticleEmitter | null = null;

  // Wind state (drives cloud drift offset + rain/snow speedX)
  private windState: PhaserWindState = { speedKmh: 0, directionDeg: 0, gust: 1 };

  // Lightning graphics layer (additive, sky-area only)
  private lightningGfx: Phaser.GameObjects.Graphics | null = null;

  // Preetham analytic sky — only visible on sunny weather (mirrors Three.js).
  private preethamSky: PreethamSky | null = null;

  // Cloud positions (world X drift) — baseW/baseH preserved for scale breathing
  private clouds: { x: number; y: number; baseW: number; baseH: number; speed: number; phase: number }[] = [];
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
    const skyH = h * getBaseline(this.scene);

    // Create layers from back to front
    this.skyGfx = scene.add.graphics();
    this.skyGfx.setScrollFactor(0);
    this.skyGfx.setDepth(-100);

    // Preetham analytic sky overlay — sized to sky region, depth -99 (above
    // skyGfx so it covers the gradient when sunny). Hidden by default; shown
    // only when weather is sunny and sun is above twilight threshold.
    this.preethamSky = new PreethamSky(scene, w, skyH);

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

    // Twinkle layer — top 30 brightest stars get per-frame sin alpha; baked
    // texture stays as steady backdrop for the other 370. Three.js's stars
    // never twinkle (they fade together via PointsMaterial.opacity), so this
    // is a Phaser-only flourish.
    this.twinkleStars = [...this.stars]
      .sort((a, b) => b.brightness - a.brightness)
      .slice(0, 30);
    this.starTwinkleGfx = scene.add.graphics();
    this.starTwinkleGfx.setScrollFactor(0);
    this.starTwinkleGfx.setDepth(-98);

    // Generate clouds
    for (let i = 0; i < 8; i++) {
      this.clouds.push({
        x: Math.random() * 1200,
        y: 20 + Math.random() * 100,
        baseW: 60 + Math.random() * 120,
        baseH: 15 + Math.random() * 25,
        speed: 0.1 + Math.random() * 0.3,
        phase: Math.random() * Math.PI * 2,
      });
    }

    this.initParticles();

    // Lightning graphics layer — full-canvas, additive, hidden by default
    this.lightningGfx = scene.add.graphics();
    this.lightningGfx.setScrollFactor(0);
    this.lightningGfx.setDepth(950);
    this.lightningGfx.setBlendMode(Phaser.BlendModes.ADD);
    this.lightningGfx.setAlpha(0);
  }

  /** Draw a zigzag bolt with three-pass gradient stroke and tween fade out. */
  triggerLightning(intensityMul = 1): void {
    if (!this.lightningGfx) return;
    this.drawBolt(intensityMul);
    this.lightningGfx.setAlpha(Math.min(1, 0.95 * intensityMul));
    this.scene.tweens.add({
      targets: this.lightningGfx,
      alpha: 0,
      duration: 220,
    });
    // 70% chance: second strike at a different position
    if (Math.random() < 0.7) {
      this.scene.time.delayedCall(80 + Math.random() * 60, () => {
        if (!this.lightningGfx) return;
        this.drawBolt(intensityMul * 0.7);
        this.lightningGfx.setAlpha(Math.min(1, 0.7 * intensityMul));
        this.scene.tweens.add({
          targets: this.lightningGfx,
          alpha: 0,
          duration: 180,
        });
      });
    }
  }

  /** Render a single bolt + 70% chance side branch onto lightningGfx. */
  private drawBolt(intensityMul: number): void {
    if (!this.lightningGfx) return;
    const w = this.scene.game.canvas.width;
    const skyH = this.scene.game.canvas.height * getBaseline(this.scene);
    const startX = w * (0.2 + Math.random() * 0.6);

    const pts = generateZigzag(
      { x: startX, y: 10 },
      w * 0.15,
      skyH * 0.7,
      11 + Math.floor(Math.random() * 3),
    );

    this.lightningGfx.clear();
    // Outer glow → mid → core (additive blend amplifies brightness)
    this.lightningGfx.lineStyle(24, 0xb4c8ff, 0.18 * intensityMul);
    this.strokePoly(pts);
    this.lightningGfx.lineStyle(14, 0xc8d8ff, 0.28 * intensityMul);
    this.strokePoly(pts);
    this.lightningGfx.lineStyle(8, 0xdce6ff, 0.5 * intensityMul);
    this.strokePoly(pts);
    this.lightningGfx.lineStyle(2, 0xffffff, 1.0);
    this.strokePoly(pts);

    if (Math.random() < 0.7) {
      const branchAt = pts[Math.floor(pts.length * 0.35)];
      const branchPts = generateZigzag(
        branchAt,
        w * 0.08,
        skyH * 0.25,
        4 + Math.floor(Math.random() * 3),
      );
      this.lightningGfx.lineStyle(10, 0xb4c8ff, 0.18 * intensityMul);
      this.strokePoly(branchPts);
      this.lightningGfx.lineStyle(4, 0xdce6ff, 0.4 * intensityMul);
      this.strokePoly(branchPts);
      this.lightningGfx.lineStyle(1, 0xffffff, 0.9);
      this.strokePoly(branchPts);
    }
  }

  private strokePoly(pts: { x: number; y: number }[]): void {
    if (!this.lightningGfx || pts.length < 2) return;
    this.lightningGfx.beginPath();
    this.lightningGfx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      this.lightningGfx.lineTo(pts[i].x, pts[i].y);
    }
    this.lightningGfx.strokePath();
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
      this.updateWindEmitters();
    }
  }

  /**
   * Enable real-time sun/moon position. Once set, update() pulls celestial
   * state from getCelestialState(lat, lon) every frame, overriding any
   * sunElevation/sunAzimuth supplied via setState.
   *
   * Welcome mode skips this (uses hardcoded sunElevation = 45) so the demo
   * lighting doesn't depend on user clock.
   */
  setLocation(latitude: number, longitude: number) {
    this.latitude = latitude;
    this.longitude = longitude;
  }

  /** Update wind state. Drives cloud drift offset and rain/snow emitter speedX. */
  setWind(state: Partial<PhaserWindState>) {
    Object.assign(this.windState, state);
    this.updateWindEmitters();
  }

  setCloudsEnabled(enabled: boolean) {
    this.cloudsEnabled = enabled;
  }

  update() {
    // Drive sun/moon from real time + location when available. This must run
    // before any sky/star/moon redraw so they all see the same celestial state.
    if (this.latitude !== null && this.longitude !== null) {
      const c = getCelestialState(this.latitude, this.longitude);
      this.state.sunElevation = c.sunElevation;
      this.state.sunAzimuth = c.sunAzimuth;
      this.state.moonPhase = c.moonPhase;
      this.state.moonElevation = c.moonElevation;
      this.state.moonAzimuth = c.moonAzimuth;
      this.state.dayFactor = c.dayFactor;
    }

    const w = this.scene.game.canvas.width;
    const h = this.scene.game.canvas.height;
    const skyH = h * getBaseline(this.scene);

    this.updateSky(w, skyH);
    this.updatePreethamSky();
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

  /**
   * Toggle Preetham shader visibility and push current sun position. Mirrors
   * Three.js sky-and-fog.ts:302-305: only sunny weather + sun above civil
   * twilight (-6°). Other weathers fall back to skyGfx gradient.
   */
  private updatePreethamSky() {
    if (!this.preethamSky) return;
    const showPreetham = this.state.type === 'sunny' && this.state.sunElevation > -6;
    this.preethamSky.setVisible(showPreetham);
    if (showPreetham) {
      this.preethamSky.setSun(this.state.sunElevation, this.state.sunAzimuth);
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

  /** Update star visibility via alpha + per-frame twinkle on the brightest stars. */
  private updateStars() {
    if (!this.starImage) return;

    const sunElev = this.state.sunElevation;
    if (sunElev > 6) {
      this.starImage.setAlpha(0);
      this.starTwinkleGfx?.clear();
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

    if (!this.starTwinkleGfx || starAlpha < 0.05) {
      this.starTwinkleGfx?.clear();
      return;
    }
    const w = this.scene.game.canvas.width;
    const skyH = this.scene.game.canvas.height * getBaseline(this.scene);
    const t = performance.now() * 0.001;
    this.starTwinkleGfx.clear();
    for (let i = 0; i < this.twinkleStars.length; i++) {
      const s = this.twinkleStars[i];
      const phase = i * 0.7;
      // Each star has a distinct frequency so twinkles don't synchronize.
      const twinkle = 0.5 + 0.5 * Math.sin(t * (1 + i * 0.13) + phase);
      const a = s.brightness * twinkle * starAlpha;
      this.starTwinkleGfx.fillStyle(0xffffff, a);
      this.starTwinkleGfx.fillCircle(s.x * w, s.y * skyH, s.size * 1.3);
    }
  }

  private drawMoon(w: number, skyH: number) {
    this.moonGfx.clear();

    const sunElev = this.state.sunElevation;
    const moonElev = this.state.moonElevation;
    const moonAz = this.state.moonAzimuth;

    // Match Three.js sky-and-fog.ts:391 — moon visible when sun is going
    // down and moon is above horizon.
    const showMoon = sunElev < 5 && moonElev > -5;
    if (!showMoon) return;

    const moonPhase = this.state.moonPhase;

    // Position from celestial state, assuming a south-facing view (E→S→W
    // arc maps to left→center→right). Off-arc azimuths get parked off-screen.
    const wrappedAz = ((moonAz % 360) + 360) % 360;
    let moonX: number;
    if (wrappedAz < 90) {
      moonX = -w * 0.1;
    } else if (wrappedAz > 270) {
      moonX = w * 1.1;
    } else {
      moonX = w * ((wrappedAz - 90) / 180);
    }
    // Clamp elevation to [0, 60] for screen mapping; higher than 60° is rare
    // and keeping the moon below the very top edge looks better than pinning it.
    const elevForY = Math.max(0, Math.min(60, moonElev));
    const moonY = skyH * (1 - elevForY / 60 * 0.7);

    // Brightness from phase fullness (matches Three.js sky-and-fog.ts:403-405)
    const fullness = 1 - 2 * Math.abs(moonPhase - 0.5);
    const baseAlpha = sunElev < 0 ? 1 : Math.max(0, 1 - sunElev / 5);
    const alpha = baseAlpha * (0.3 + 0.7 * fullness);

    const moonR = 15 * (0.8 + 0.2 * fullness);
    const seed = 42;

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

    const t = performance.now() * 0.001;
    // Screen-X component of wind (positive = blow right, negative = blow left).
    // Direction is meteorological (where wind comes from), so flip 180° to get flow.
    const dirRad = (this.windState.directionDeg + 180) * Math.PI / 180;
    const windPxPerFrame = (this.windState.speedKmh / 3.6) * 0.3 * Math.sin(dirRad);
    for (let i = 0; i < this.clouds.length; i++) {
      const cloud = this.clouds[i];
      const scale = 1 + Math.sin(t * 0.4 + cloud.phase) * 0.07;
      const dispW = cloud.baseW * scale;
      const dispH = cloud.baseH * scale;
      cloud.x += cloud.speed + windPxPerFrame;
      if (cloud.x > w + dispW) cloud.x = -dispW;
      if (cloud.x < -dispW) cloud.x = w + dispW;

      this.cloudGfx.fillStyle(this.strategy.palette.cloud, cloudAlpha);
      this.strategy.drawCloud(this.cloudGfx, cloud.x, cloud.y, dispW, dispH, i);
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
    const dustKey = '__dust_particle__';
    const leafKey = '__leaf_particle__';

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

    // Dust: 16×16 warm radial gradient (matches Three.js sky-and-fog.ts:702-720)
    if (!this.scene.textures.exists(dustKey)) {
      const dustCanvas = document.createElement('canvas');
      dustCanvas.width = 16;
      dustCanvas.height = 16;
      const dCtx = dustCanvas.getContext('2d')!;
      const grad = dCtx.createRadialGradient(8, 8, 0, 8, 8, 8);
      grad.addColorStop(0, 'rgba(210,190,150,0.7)');
      grad.addColorStop(0.5, 'rgba(210,190,150,0.3)');
      grad.addColorStop(1, 'rgba(210,190,150,0)');
      dCtx.fillStyle = grad;
      dCtx.fillRect(0, 0, 16, 16);
      this.scene.textures.addCanvas(dustKey, dustCanvas);
    }

    // Leaf: 32×32 ellipse with center vein (matches Three.js sky-and-fog.ts:799-829)
    if (!this.scene.textures.exists(leafKey)) {
      const leafCanvas = document.createElement('canvas');
      leafCanvas.width = 32;
      leafCanvas.height = 32;
      const lCtx = leafCanvas.getContext('2d')!;
      const grad = lCtx.createRadialGradient(16, 16, 0, 16, 16, 16);
      grad.addColorStop(0, 'rgba(120,160,60,0.9)');
      grad.addColorStop(0.6, 'rgba(140,130,50,0.7)');
      grad.addColorStop(1, 'rgba(100,80,30,0)');
      lCtx.fillStyle = grad;
      lCtx.beginPath();
      lCtx.ellipse(16, 16, 14, 9, 0, 0, Math.PI * 2);
      lCtx.fill();
      lCtx.strokeStyle = 'rgba(80,100,40,0.5)';
      lCtx.lineWidth = 1;
      lCtx.beginPath();
      lCtx.moveTo(4, 16);
      lCtx.lineTo(28, 16);
      lCtx.stroke();
      this.scene.textures.addCanvas(leafKey, leafCanvas);
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

    // Dust — sparse warm motes drifting near the rider, weather-independent.
    // Three.js spawns ~40 in a 60×60m volume; here we cap throughput at one
    // every ~250ms so the on-screen population stays similarly sparse.
    const w = Number(this.scene.game.config.width);
    const skyH = Number(this.scene.game.config.height) * getBaseline(this.scene);
    this.dustEmitter = this.scene.add.particles(0, 0, dustKey, {
      x: { min: 0, max: w },
      y: { min: skyH * 0.5, max: skyH * 0.95 },
      speedY: { min: -8, max: 8 },
      speedX: { min: -6, max: 6 },
      lifespan: 5000,
      frequency: 250,
      quantity: 1,
      alpha: { start: 0, end: 0.5, ease: 'Sine.InOut' },
      scale: { min: 0.6, max: 1.2 },
    });
    this.dustEmitter.setScrollFactor(0);
    this.dustEmitter.setDepth(-94);

    // Leaves — slow falling, gently rotating, weather-independent.
    // Three.js spawns ~15 in an 80m volume; here ~600ms cadence with 8s
    // lifespan keeps ~13 on screen at any time.
    this.leafEmitter = this.scene.add.particles(0, 0, leafKey, {
      x: { min: 0, max: w },
      y: -20,
      speedY: { min: 30, max: 70 },
      speedX: { min: -25, max: 25 },
      lifespan: 8000,
      frequency: 600,
      quantity: 1,
      rotate: { start: 0, end: 360 },
      alpha: { start: 0.85, end: 0.4 },
      scale: { min: 0.5, max: 0.9 },
    });
    this.leafEmitter.setScrollFactor(0);
    this.leafEmitter.setDepth(-94);

    this.updateWindEmitters();
  }

  /**
   * Update rain/snow emitter horizontal velocity from wind state.
   * Direct assignment of `speedX` with `as any` is the same pattern used
   * in phaser2d-scene.ts:272 for the speed-driven wind emitter.
   */
  private updateWindEmitters() {
    const dirRad = (this.windState.directionDeg + 180) * Math.PI / 180;
    const xComp = Math.sin(dirRad);
    const wxPx = xComp * (this.windState.speedKmh / 3.6) * 60; // ~60 px/s per m/s

    if (this.rainEmitter) {
      // Rain naturally falls at a slight backwards angle (legacy: -30..-10);
      // wind shifts the whole range.
      this.rainEmitter.speedX = { min: wxPx - 50, max: wxPx - 10 } as any;
    }
    if (this.snowEmitter) {
      this.snowEmitter.speedX = { min: wxPx - 30, max: wxPx + 30 } as any;
    }
    // Dust drifts gently — wind compressed (×0.4) since dust is short-range
    // particles near the rider, not falling from clouds.
    if (this.dustEmitter) {
      const wd = wxPx * 0.4 * this.windState.gust;
      this.dustEmitter.speedX = { min: wd - 6, max: wd + 6 } as any;
    }
    // Leaves catch wind strongly (×0.8) — wider scatter than dust.
    if (this.leafEmitter) {
      const wl = wxPx * 0.8 * this.windState.gust;
      this.leafEmitter.speedX = { min: wl - 25, max: wl + 25 } as any;
    }
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

  /**
   * Hot-swap the visual strategy. Sky / parallax / clouds / moon all redraw
   * each frame from the strategy palette + delegated draw methods, so we
   * just swap the reference and reset the dirty flags so the gated layers
   * (sky gradient + parallax mountains) repaint on the next update().
   */
  setStrategy(newStrategy: PhaserStyleStrategy) {
    this.strategy = newStrategy;
    this.lastSunElev = NaN;
    this.lastWeatherType = '';
    this.lastParallaxSunElev = NaN;
    this.lastParallaxWeather = '';
  }

  /** Handle resize — recreate star texture and reset dirty flags. */
  onResize(w: number, h: number) {
    const skyH = h * getBaseline(this.scene);

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

    // Resize Preetham shader quad
    this.preethamSky?.onResize(w, skyH);
  }

  dispose() {
    this.skyGfx.destroy();
    this.starImage?.destroy();
    this.starTwinkleGfx?.destroy();
    this.moonGfx.destroy();
    this.cloudGfx.destroy();
    this.fogGfx.destroy();
    this.farMountainGfx.destroy();
    this.nearHillGfx.destroy();
    this.rainEmitter?.destroy();
    this.snowEmitter?.destroy();
    this.dustEmitter?.destroy();
    this.leafEmitter?.destroy();
    this.lightningGfx?.destroy();
    this.preethamSky?.destroy();
  }
}

/** Linearly interpolate between two 0xRRGGBB colors. */
/** Build a downward-flowing zigzag from `start`, `segments` long, with X jitter. */
function generateZigzag(
  start: { x: number; y: number },
  jitterX: number,
  totalHeight: number,
  segments: number,
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [{ x: start.x, y: start.y }];
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    pts.push({
      x: start.x + (Math.random() - 0.5) * 2 * jitterX,
      y: start.y + totalHeight * t,
    });
  }
  return pts;
}

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
