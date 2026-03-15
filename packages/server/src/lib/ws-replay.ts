/**
 * Per-client JSONL replay session.
 * Reads a recording file and sends WsMessages at the original pace.
 */

import type { WebSocket } from 'ws';
import type { WsMessage, WsSensorMessage, WsSessionStartMessage, WsSessionEndMessage } from '@littlecycling/shared';
import { readJsonl } from './data-reader.js';

export interface ReplayOptions {
  filePath: string;
  speed?: number;   // playback multiplier, default 1.0
  loop?: boolean;   // restart after session_end, default false
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

export class ReplaySession {
  private abort = new AbortController();
  private running = false;

  constructor(
    private ws: WebSocket,
    private options: ReplayOptions,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const speed = this.options.speed ?? 1;

    try {
      do {
        let prevElapsed = 0;

        for await (const record of readJsonl(this.options.filePath)) {
          if (this.abort.signal.aborted) return;

          let msg: WsMessage;

          if (record.type === 'session_start') {
            const startMsg: WsSessionStartMessage = {
              type: 'session_start',
              tsEpoch: record.tsEpoch,
              sensors: record.sensors,
            };
            msg = startMsg;
            prevElapsed = 0;
          } else if (record.type === 'data') {
            // Pace by elapsed difference
            const gap = record.elapsed - prevElapsed;
            if (gap > 0) {
              await delay(gap / speed, this.abort.signal);
            }
            prevElapsed = record.elapsed;

            const sensorMsg: WsSensorMessage = {
              type: 'sensor',
              tsEpoch: record.tsEpoch,
              elapsed: record.elapsed,
              profile: record.profile,
              deviceId: record.deviceId,
              data: record.data,
            };
            msg = sensorMsg;
          } else if (record.type === 'session_end') {
            const endMsg: WsSessionEndMessage = {
              type: 'session_end',
              tsEpoch: record.tsEpoch,
              elapsed: record.elapsed,
              totalRecords: record.totalRecords,
            };
            msg = endMsg;
          } else {
            continue;
          }

          if (this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(msg));
          } else {
            return;
          }
        }
      } while (this.options.loop && !this.abort.signal.aborted);
    } catch (err) {
      // AbortError is expected on stop()
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        throw err;
      }
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    this.abort.abort();
  }
}
