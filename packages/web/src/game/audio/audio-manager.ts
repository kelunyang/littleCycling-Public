/**
 * Unified audio manager for littleCycling.
 *
 * Bridges NES chiptune synth + ambient noise generators + generative BGM with
 * the game's event system. Uses a shared AudioContext (created lazily on first
 * user interaction to satisfy browser autoplay policy).
 *
 * NES game sounds (coin, combo, alert, lap, start/end) play in both render
 * modes. Ambient sounds (wind, rain) are gated by `setAmbientEnabled`, which
 * GameView drives from the render mode.
 *
 * There is exactly ONE instance per app session (`getAudioManager()`), shared
 * by WelcomeView and GameView. That is what lets the theme song carry across
 * the route transition without a gap: a per-view instance would have to close
 * its AudioContext on unmount, cutting the music off mid-bar.
 */

import { NesSynth } from './nes-synth';
import { AmbientNoise } from './ambient-noise';
import { GenerativeBgm, type WorldStyle } from './generative-bgm';

export class AudioManager {
  private ctx: AudioContext | null = null;
  private synth: NesSynth | null = null;
  private ambient: AmbientNoise | null = null;
  private bgm: GenerativeBgm | null = null;
  private _enabled = true;
  private _ambientEnabled = false;
  private _lastClickTime = 0;
  private _cadenceRpm = 0;

  // BGM is requested before the AudioContext may legally exist (autoplay
  // policy), so the request is remembered and applied on first play.
  private _bgmEnabled = true;
  private _bgmWanted = false;
  private _bgmStyle: WorldStyle = 'plastic';
  private _bgmSeed = 1;

  /** Lazily initialize AudioContext (must be called from user gesture context). */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const dest = this.ctx.destination;
      this.synth = new NesSynth(this.ctx, dest);
      this.bgm = new GenerativeBgm(this.ctx, dest);
      if (this._ambientEnabled) {
        this.ambient = new AmbientNoise(this.ctx, dest);
      }
    }
    // Resume if suspended (browser autoplay policy)
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  /**
   * Enable wind/rain ambience (Three.js and Phaser modes). GameView calls this
   * on mount; the context may already exist by then because the BGM started
   * back on the welcome screen, so the generators are created on demand rather
   * than only alongside the context.
   */
  setAmbientEnabled(on: boolean): void {
    this._ambientEnabled = on;
    if (!on) {
      this.ambient?.setWindSpeed(0);
      this.ambient?.setAmbientWind(0);
      this.ambient?.setRain(false);
      return;
    }
    if (this.ctx && !this.ambient) {
      this.ambient = new AmbientNoise(this.ctx, this.ctx.destination);
    }
  }

  /** Enable or disable all sounds. */
  setEnabled(on: boolean): void {
    this._enabled = on;
    if (!on) {
      // Mute ongoing sounds
      this.synth?.zoneAlert(false);
      this.bgm?.stop();
      if (this.ambient) {
        this.ambient.setWindSpeed(0);
        this.ambient.setRain(false);
      }
    } else {
      this.syncBgm();
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  // ── Generative background music ──

  /**
   * Ask for a theme song. Safe to call before any user gesture — playback
   * starts once the AudioContext exists and both sound switches are on.
   *
   * @param style — world style; picks the musical idiom
   * @param seed  — route-derived seed; the same route always gets the same tune
   */
  startBgm(style: WorldStyle, seed: number): void {
    // Only restart when the tune actually changes. Calling this again with the
    // same style+seed is what happens when a ride starts on a theme the welcome
    // screen was already playing — leaving it alone is what makes the handover
    // seamless instead of snapping back to bar 1.
    const changed = style !== this._bgmStyle || seed !== this._bgmSeed;
    this._bgmWanted = true;
    this._bgmStyle = style;
    this._bgmSeed = seed;
    if (changed && this.bgm?.playing) {
      this.bgm.start(style, seed);
      return;
    }
    this.syncBgm();
  }

  stopBgm(): void {
    this._bgmWanted = false;
    this.bgm?.stop();
  }

  setBgmEnabled(on: boolean): void {
    this._bgmEnabled = on;
    this.syncBgm();
  }

  /** Switch idiom without restarting the ride (world style changed mid-game). */
  setWorldStyle(style: WorldStyle): void {
    if (style === this._bgmStyle) return;
    this._bgmStyle = style;
    if (this.bgm?.playing) {
      this.bgm.start(this._bgmStyle, this._bgmSeed);
    }
  }

  /** Reconcile actual playback with the requested + enabled state. */
  private syncBgm(): void {
    const shouldPlay = this._bgmWanted && this._bgmEnabled && this._enabled;
    if (!shouldPlay) {
      this.bgm?.stop();
      return;
    }
    this.ensureContext();
    if (this.bgm && !this.bgm.playing) {
      this.bgm.start(this._bgmStyle, this._bgmSeed);
    }
  }

  // ── NES game sounds (both modes) ──

  coinCollect(): void {
    if (!this._enabled) return;
    this.ensureContext();
    this.synth?.coinCollect();
  }

  comboUp(level: number): void {
    if (!this._enabled) return;
    this.ensureContext();
    this.synth?.comboUp(level);
  }

  zoneAlert(on: boolean): void {
    if (!this._enabled && on) return; // don't start if disabled
    this.ensureContext();
    this.synth?.zoneAlert(on);
  }

  lapComplete(): void {
    if (!this._enabled) return;
    this.ensureContext();
    this.synth?.lapComplete();
  }

  segmentChange(): void {
    if (!this._enabled) return;
    this.ensureContext();
    this.synth?.segmentChange();
  }

  gameStart(): void {
    if (!this._enabled) return;
    this.ensureContext();
    this.synth?.gameStart();
  }

  gameEnd(): void {
    if (!this._enabled) return;
    this.ensureContext();
    this.synth?.gameEnd();
  }

  /** Update cadence and play pedal click sounds at the appropriate rhythm. */
  updateCadence(rpm: number): void {
    if (!this._enabled) return;
    this._cadenceRpm = rpm;
    // Cadence drives the BGM tempo — pedal faster, the theme speeds up.
    this.bgm?.setCadence(rpm);
    if (rpm <= 0) return;

    this.ensureContext();
    const now = this.ctx!.currentTime;
    const interval = 60 / rpm; // seconds per pedal stroke
    if (now - this._lastClickTime >= interval) {
      this.synth?.pedalClick(now);
      this._lastClickTime = now;
    }
  }

  // ── Ambient sounds (Three.js mode only) ──

  updateWind(speedKmh: number): void {
    if (!this._enabled || !this._ambientEnabled) return;
    this.ensureContext();
    this.ambient?.setWindSpeed(speedKmh);
  }

  /** Environmental (weather-driven) wind, separate from speed-driven swoosh. */
  updateAmbientWind(speedKmh: number): void {
    if (!this._enabled || !this._ambientEnabled) return;
    this.ensureContext();
    this.ambient?.setAmbientWind(speedKmh);
  }

  setRain(on: boolean): void {
    if (!this._enabled && on) return;
    if (!this._ambientEnabled) return;
    this.ensureContext();
    this.ambient?.setRain(on);
  }

  /** One-shot thunder rumble. distance 0..1 (0 = close/loud, 1 = far). */
  playThunder(distance: number): void {
    if (!this._enabled || !this._ambientEnabled) return;
    this.ensureContext();
    this.ambient?.playThunder(distance);
  }

  /**
   * Stop everything a ride owns — redline alert, wind, rain — while leaving the
   * BGM running. GameView calls this on unmount instead of `dispose()`, which
   * would close the AudioContext that the welcome screen still shares.
   */
  stopGameSounds(): void {
    this.synth?.zoneAlert(false);
    this.setAmbientEnabled(false);
    this._cadenceRpm = 0;
  }

  /**
   * Tear down the whole audio stack. Only meaningful at app teardown — views
   * must use `stopGameSounds()`, since the manager is shared.
   */
  dispose(): void {
    this.synth?.dispose();
    this.ambient?.dispose();
    this.bgm?.dispose();
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
    this.synth = null;
    this.ambient = null;
    this.bgm = null;
  }
}

/**
 * The one AudioManager for the app session. Shared rather than per-view so the
 * theme song survives the welcome → game navigation; see the class docblock.
 */
let shared: AudioManager | null = null;

export function getAudioManager(): AudioManager {
  if (!shared) shared = new AudioManager();
  return shared;
}
