/**
 * NES-style chiptune synthesizer using Web Audio API.
 *
 * All sounds are generated from OscillatorNode (square / triangle waves),
 * mimicking the NES APU's 2 pulse + 1 triangle channels.
 * No audio files needed — pure synthesis.
 */

// NES-style note frequencies (Hz)
const NOTE = {
  A2: 110.00,
  C4: 261.63,
  E4: 329.63,
  G4: 392.00,
  C5: 523.25,
  E5: 659.25,
  G5: 783.99,
  C6: 1046.50,
  E6: 1318.51,
  G6: 1567.98,
} as const;

/** Master volume for NES synth (0-1). Keep low to avoid clipping. */
const MASTER_VOLUME = 0.15;

export class NesSynth {
  private ctx: AudioContext;
  private dest: AudioNode;
  private zoneAlertOsc: OscillatorNode | null = null;
  private zoneAlertGain: GainNode | null = null;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.dest = destination;
  }

  /** Play a short tone with envelope. */
  private playTone(
    freq: number,
    type: OscillatorType,
    startTime: number,
    duration: number,
    volume = MASTER_VOLUME,
  ): void {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, startTime);
    // Fast attack
    gain.gain.linearRampToValueAtTime(volume, startTime + 0.005);
    // Hold then release
    gain.gain.setValueAtTime(volume, startTime + duration - 0.02);
    gain.gain.linearRampToValueAtTime(0, startTime + duration);

    osc.connect(gain);
    gain.connect(this.dest);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.01);
  }

  /** Classic coin collect — two-note ascending chirp (C6 → E6). */
  coinCollect(): void {
    const t = this.ctx.currentTime;
    this.playTone(NOTE.C6, 'square', t, 0.08);
    this.playTone(NOTE.E6, 'square', t + 0.08, 0.12);
  }

  /** Combo up — pitch rises with combo level (1-5). */
  comboUp(level: number): void {
    const pitches = [NOTE.C5, NOTE.G5, NOTE.C6, NOTE.E6, NOTE.G6];
    const idx = Math.min(level - 1, pitches.length - 1);
    const t = this.ctx.currentTime;
    this.playTone(pitches[idx], 'square', t, 0.1, MASTER_VOLUME * 0.8);
  }

  /**
   * Zone 5 redline alert — low-frequency pulsing square wave.
   * Starts when entering Zone 5, stops when leaving.
   */
  zoneAlert(on: boolean): void {
    if (on && !this.zoneAlertOsc) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();

      // Main tone: low A2 square wave
      osc.type = 'square';
      osc.frequency.value = NOTE.A2;

      // LFO for pulsing effect (4 Hz throb)
      lfo.type = 'sine';
      lfo.frequency.value = 4;
      lfoGain.gain.value = MASTER_VOLUME * 0.5;

      // Route: lfo → lfoGain → gain.gain (AM modulation)
      lfo.connect(lfoGain);
      lfoGain.connect(gain.gain);
      gain.gain.value = MASTER_VOLUME * 0.5;

      osc.connect(gain);
      gain.connect(this.dest);

      osc.start();
      lfo.start();

      this.zoneAlertOsc = osc;
      this.zoneAlertGain = gain;
      // Store LFO references on the oscillator for cleanup
      (osc as any)._lfo = lfo;
      (osc as any)._lfoGain = lfoGain;
    } else if (!on && this.zoneAlertOsc) {
      // Fade out
      const gain = this.zoneAlertGain!;
      const t = this.ctx.currentTime;
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + 0.1);

      const osc = this.zoneAlertOsc;
      const lfo = (osc as any)._lfo as OscillatorNode;
      setTimeout(() => {
        osc.stop();
        osc.disconnect();
        lfo.stop();
        lfo.disconnect();
        (osc as any)._lfoGain?.disconnect();
        gain.disconnect();
      }, 150);

      this.zoneAlertOsc = null;
      this.zoneAlertGain = null;
    }
  }

  /** Lap complete — ascending triangle wave arpeggio (C5 → E5 → G5). */
  lapComplete(): void {
    const t = this.ctx.currentTime;
    this.playTone(NOTE.C5, 'triangle', t, 0.15);
    this.playTone(NOTE.E5, 'triangle', t + 0.15, 0.15);
    this.playTone(NOTE.G5, 'triangle', t + 0.30, 0.25);
  }

  /** Pedal click — short percussive triangle wave tick, cadence-driven. */
  pedalClick(startTime?: number): void {
    const t = startTime ?? this.ctx.currentTime;
    this.playTone(800, 'triangle', t, 0.02, 0.08);
  }

  /**
   * Game start — cleat clip-in sound.
   * Metallic snap: white noise burst (bandpass ~3kHz) + high-freq resonance.
   */
  gameStart(): void {
    const t = this.ctx.currentTime;
    // Metallic noise burst — bandpassed white noise
    this.playNoiseBurst(t, 0.015, 3000, 0.12);
    // High-frequency resonance click
    this.playTone(2500, 'sine', t + 0.005, 0.02, 0.10);
    // Subtle metallic ring
    this.playTone(4200, 'sine', t + 0.008, 0.035, 0.04);
  }

  /** Segment change — two-note triangle wave notification (G5 → C6). */
  segmentChange(): void {
    const t = this.ctx.currentTime;
    this.playTone(NOTE.G5, 'triangle', t, 0.1, MASTER_VOLUME * 0.9);
    this.playTone(NOTE.C6, 'triangle', t + 0.12, 0.15, MASTER_VOLUME * 0.9);
  }

  /**
   * Game end — cleat clip-out sound.
   * Double click: spring release snap then pedal separation.
   */
  gameEnd(): void {
    const t = this.ctx.currentTime;
    // First click — spring release
    this.playTone(1500, 'sine', t, 0.008, 0.10);
    this.playNoiseBurst(t, 0.010, 2500, 0.08);
    // Gap then second click — pedal separation
    this.playTone(800, 'sine', t + 0.038, 0.015, 0.09);
    this.playNoiseBurst(t + 0.038, 0.012, 1800, 0.07);
  }

  /** Generate a short bandpassed white noise burst (metallic click). */
  private playNoiseBurst(
    startTime: number,
    duration: number,
    filterFreq: number,
    volume: number,
  ): void {
    // Create white noise buffer
    const sampleRate = this.ctx.sampleRate;
    const bufferSize = Math.ceil(sampleRate * (duration + 0.01));
    const buffer = this.ctx.createBuffer(1, bufferSize, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter for metallic tone
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = filterFreq;
    filter.Q.value = 8;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(volume, startTime + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.dest);
    source.start(startTime);
    source.stop(startTime + duration + 0.01);
  }

  /** Stop any ongoing sounds and clean up. */
  dispose(): void {
    this.zoneAlert(false);
  }
}
