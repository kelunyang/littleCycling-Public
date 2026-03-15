/**
 * Ambient noise generators — wind and rain.
 *
 * Wind: white noise → bandpass filter → gain, frequency and volume
 * scale with cycling speed (0-60+ km/h).
 *
 * Rain: white noise → highpass filter → gain, with random
 * short sine "drip" oscillators for raindrop texture.
 *
 * Only used in Three.js render mode (not MapLibre).
 */

/** Duration of the noise buffer in seconds. */
const NOISE_BUFFER_SECONDS = 2;

/** Wind volume range. */
const WIND_MAX_GAIN = 0.12;

/** Rain base volume. */
const RAIN_GAIN = 0.08;

/** Raindrop drip interval range (ms). */
const DRIP_MIN_MS = 80;
const DRIP_MAX_MS = 400;

export class AmbientNoise {
  private ctx: AudioContext;
  private dest: AudioNode;

  // Wind chain: noiseSource → bandpass → windGain → dest
  private windSource: AudioBufferSourceNode | null = null;
  private windFilter: BiquadFilterNode;
  private windGain: GainNode;
  private noiseBuffer: AudioBuffer;

  // Rain chain: rainSource → highpass → rainGain → dest
  private rainSource: AudioBufferSourceNode | null = null;
  private rainFilter: BiquadFilterNode;
  private rainGain: GainNode;
  private rainActive = false;
  private dripTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.dest = destination;

    // Pre-generate white noise buffer
    this.noiseBuffer = this.createNoiseBuffer();

    // Wind filter + gain (always connected, source starts/stops)
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 400;
    this.windFilter.Q.value = 0.5;

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.dest);

    // Rain filter + gain
    this.rainFilter = ctx.createBiquadFilter();
    this.rainFilter.type = 'highpass';
    this.rainFilter.frequency.value = 4000;
    this.rainFilter.Q.value = 0.3;

    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    this.rainFilter.connect(this.rainGain);
    this.rainGain.connect(this.dest);
  }

  /** Generate a white noise AudioBuffer. */
  private createNoiseBuffer(): AudioBuffer {
    const sampleRate = this.ctx.sampleRate;
    const length = sampleRate * NOISE_BUFFER_SECONDS;
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  /** Create a looping noise source from the shared buffer. */
  private createNoiseSource(): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    return src;
  }

  /**
   * Update wind intensity based on cycling speed.
   * Maps 0-60 km/h → filter freq 200-2000 Hz, gain 0 → WIND_MAX_GAIN.
   */
  setWindSpeed(kmh: number): void {
    // Start wind source lazily
    if (!this.windSource) {
      this.windSource = this.createNoiseSource();
      this.windSource.connect(this.windFilter);
      this.windSource.start();
    }

    const t = this.ctx.currentTime;
    const ratio = Math.min(Math.max(kmh / 60, 0), 1);

    // Below 2 km/h: silence (coasting / stopped)
    const targetGain = kmh < 2 ? 0 : ratio * WIND_MAX_GAIN;
    const targetFreq = 200 + ratio * 1800; // 200-2000 Hz

    this.windGain.gain.setTargetAtTime(targetGain, t, 0.3);
    this.windFilter.frequency.setTargetAtTime(targetFreq, t, 0.3);
  }

  /** Enable/disable rain ambient sound with fade. */
  setRain(on: boolean): void {
    const t = this.ctx.currentTime;

    if (on && !this.rainActive) {
      this.rainActive = true;
      this.rainSource = this.createNoiseSource();
      this.rainSource.connect(this.rainFilter);
      this.rainSource.start();
      // Fade in
      this.rainGain.gain.setValueAtTime(0, t);
      this.rainGain.gain.linearRampToValueAtTime(RAIN_GAIN, t + 1.5);
      // Start random drips
      this.scheduleDrip();
    } else if (!on && this.rainActive) {
      this.rainActive = false;
      // Fade out
      this.rainGain.gain.setTargetAtTime(0, t, 0.5);
      // Stop source after fade
      const src = this.rainSource;
      if (src) {
        setTimeout(() => {
          src.stop();
          src.disconnect();
        }, 2000);
        this.rainSource = null;
      }
      // Stop drips
      if (this.dripTimer !== null) {
        clearTimeout(this.dripTimer);
        this.dripTimer = null;
      }
    }
  }

  /** Schedule random raindrop "drip" sounds. */
  private scheduleDrip(): void {
    if (!this.rainActive) return;

    const delay = DRIP_MIN_MS + Math.random() * (DRIP_MAX_MS - DRIP_MIN_MS);
    this.dripTimer = setTimeout(() => {
      this.playDrip();
      this.scheduleDrip();
    }, delay);
  }

  /** Play a single raindrop — short high-frequency sine blip. */
  private playDrip(): void {
    const t = this.ctx.currentTime;
    const freq = 2000 + Math.random() * 4000; // 2-6 kHz
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.03, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

    osc.connect(gain);
    gain.connect(this.dest);
    osc.start(t);
    osc.stop(t + 0.05);
  }

  /** Stop all ambient sounds and release resources. */
  dispose(): void {
    if (this.windSource) {
      this.windSource.stop();
      this.windSource.disconnect();
      this.windSource = null;
    }
    this.windFilter.disconnect();
    this.windGain.disconnect();

    this.setRain(false);
    if (this.rainSource) {
      this.rainSource.stop();
      this.rainSource.disconnect();
      this.rainSource = null;
    }
    this.rainFilter.disconnect();
    this.rainGain.disconnect();

    if (this.dripTimer !== null) {
      clearTimeout(this.dripTimer);
      this.dripTimer = null;
    }
  }
}
