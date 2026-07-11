/**
 * ReplaySensorSource — feeds a recorded JSONL ride through the SAME
 * `handleAntData` path real ANT+ frames take, so the server-authoritative
 * game simulation runs on real captured data instead of live hardware or the
 * synthetic `--mock` stream.
 *
 * Enabled via the server `--replay <file>` flag. This differs from the
 * `/ws/replay` endpoint (`ReplaySession`): that streams raw `sensor` frames
 * straight to one client and bypasses the simulation, so the post
 * server-authoritative migration it no longer moves the game. This source
 * instead drives `LiveSession` itself — the sim computes `game_state`, coins,
 * zones, virtual speed and SQLite samples exactly as it would for a live ride,
 * only the sensor bytes come from a recording.
 *
 * Frames are paced by each record's `elapsed` field (ms since session start),
 * matching `ReplaySession`, so timing reproduces the original ride.
 */

import { readJsonl } from './data-reader.js';
import type { DetectedSensor } from '@littlecycling/shared';

export interface ReplaySensorOptions {
  /** Path to the JSONL recording to replay. */
  filePath: string;
  /**
   * Sink for recorded frames — wire to `LiveSession.handleAntData`. `data` is
   * the exact raw ANT+ frame that was captured, so every downstream consumer
   * is exercised identically to the original ride.
   */
  onFrame: (profile: string, deviceId: number, data: Record<string, unknown>) => void;
  /** Playback multiplier (default 1.0). */
  speed?: number;
  /** Restart from the top after the recording ends (default false). */
  loop?: boolean;
}

/** Bounds the fallback scan for a header-less file so `readSensors` stays cheap. */
const FALLBACK_SCAN_LIMIT = 500;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    // Remove the abort listener on normal resolution too — a full ride calls
    // delay() once per frame (thousands of times), and a listener that only
    // detaches on abort would leak on every non-aborted tick.
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class ReplaySensorSource {
  private readonly filePath: string;
  private readonly onFrame: ReplaySensorOptions['onFrame'];
  private readonly speed: number;
  private readonly loop: boolean;
  private abort = new AbortController();
  private running = false;

  constructor(opts: ReplaySensorOptions) {
    this.filePath = opts.filePath;
    this.onFrame = opts.onFrame;
    this.speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
    this.loop = opts.loop ?? false;
  }

  /**
   * Read the recording's advertised sensor list from its `session_start`
   * header so the scan phase surfaces exactly the sensors the ride used.
   * Falls back to the distinct profile+deviceId pairs seen in the first data
   * frames if the file has no header.
   */
  async readSensors(): Promise<DetectedSensor[]> {
    const seen = new Map<string, DetectedSensor>();
    let scanned = 0;
    for await (const record of readJsonl(this.filePath)) {
      if (record.type === 'session_start' && record.sensors?.length) {
        return record.sensors.map((s) => ({ ...s, source: s.source ?? 'ant' }));
      }
      if (record.type === 'data') {
        const key = `${record.profile}:${record.deviceId}`;
        if (!seen.has(key)) {
          seen.set(key, { profile: record.profile, deviceId: record.deviceId, source: 'ant' });
        }
        if (++scanned >= FALLBACK_SCAN_LIMIT) break;
      }
    }
    return [...seen.values()];
  }

  /** Begin streaming recorded frames. Idempotent; safe to call once. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.run()
      .catch((err) => {
        // AbortError is the expected outcome of stop().
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.error('[replay-sensor] error:', err);
        }
      })
      .finally(() => {
        this.running = false;
      });
  }

  private async run(): Promise<void> {
    do {
      let prevElapsed = 0;
      for await (const record of readJsonl(this.filePath)) {
        if (this.abort.signal.aborted) return;
        if (record.type !== 'data') continue;

        // Pace by elapsed difference — identical to ReplaySession.
        const gap = record.elapsed - prevElapsed;
        if (gap > 0) await delay(gap / this.speed, this.abort.signal);
        prevElapsed = record.elapsed;

        this.onFrame(record.profile, record.deviceId, record.data);
      }
    } while (this.loop && !this.abort.signal.aborted);

    if (!this.loop) {
      console.log('[replay-sensor] recording finished (no --replay-loop; sim will idle)');
    }
  }

  /** Stop streaming. Idempotent. */
  stop(): void {
    this.abort.abort();
  }
}
