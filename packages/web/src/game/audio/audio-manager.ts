/**
 * Unified audio manager for littleCycling.
 *
 * Bridges NES chiptune synth + ambient noise generators with
 * the game's event system. Uses a shared AudioContext (created
 * lazily on first user interaction to satisfy browser autoplay policy).
 *
 * NES game sounds (coin, combo, alert, lap, start/end) play in both
 * render modes. Ambient sounds (wind, rain) only play in Three.js mode.
 */

import { NesSynth } from './nes-synth';
import { AmbientNoise } from './ambient-noise';

export class AudioManager {
  private ctx: AudioContext | null = null;
  private synth: NesSynth | null = null;
  private ambient: AmbientNoise | null = null;
  private _enabled = true;
  private _isThreeJs = false;
  private _lastClickTime = 0;
  private _cadenceRpm = 0;

  /**
   * @param isThreeJs — true if Three.js render mode (enables ambient sounds)
   */
  constructor(isThreeJs: boolean) {
    this._isThreeJs = isThreeJs;
  }

  /** Lazily initialize AudioContext (must be called from user gesture context). */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const dest = this.ctx.destination;
      this.synth = new NesSynth(this.ctx, dest);
      if (this._isThreeJs) {
        this.ambient = new AmbientNoise(this.ctx, dest);
      }
    }
    // Resume if suspended (browser autoplay policy)
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  /** Enable or disable all sounds. */
  setEnabled(on: boolean): void {
    this._enabled = on;
    if (!on) {
      // Mute ongoing sounds
      this.synth?.zoneAlert(false);
      if (this.ambient) {
        this.ambient.setWindSpeed(0);
        this.ambient.setRain(false);
      }
    }
  }

  get enabled(): boolean {
    return this._enabled;
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
    if (!this._enabled || !this._isThreeJs) return;
    this.ensureContext();
    this.ambient?.setWindSpeed(speedKmh);
  }

  setRain(on: boolean): void {
    if (!this._enabled && on) return;
    if (!this._isThreeJs) return;
    this.ensureContext();
    this.ambient?.setRain(on);
  }

  /** Clean up all audio resources. */
  dispose(): void {
    this.synth?.dispose();
    this.ambient?.dispose();
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
    this.synth = null;
    this.ambient = null;
  }
}
