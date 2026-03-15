/**
 * JSONL file writer for ANT+ recording sessions.
 * Each line is a self-contained JSON object: session_start, data, or session_end.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface SessionStartRecord {
  type: 'session_start';
  ts: string;
  tsEpoch: number;
  stickInfo: { maxChannels: number };
  sensors: Array<{ profile: string; deviceId: number }>;
}

export interface DataRecord {
  type: 'data';
  ts: string;
  tsEpoch: number;
  elapsed: number;
  profile: string;
  deviceId: number;
  data: Record<string, unknown>;
}

export interface SessionEndRecord {
  type: 'session_end';
  ts: string;
  tsEpoch: number;
  elapsed: number;
  totalRecords: number;
}

export type RecordLine = SessionStartRecord | DataRecord | SessionEndRecord;

export class DataWriter {
  private stream: fs.WriteStream | null = null;
  private sessionStartTime = 0;
  public recordCount = 0;
  public filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Open the output file for writing. Creates parent directories if needed. */
  open(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.stream = fs.createWriteStream(this.filePath, {
      flags: 'w',
      encoding: 'utf8',
    });

    this.sessionStartTime = Date.now();
  }

  /** Write the session_start record. */
  writeSessionStart(
    stickInfo: { maxChannels: number },
    sensors: Array<{ profile: string; deviceId: number }>
  ): void {
    const now = Date.now();
    this.writeLine({
      type: 'session_start',
      ts: new Date(now).toISOString(),
      tsEpoch: now,
      stickInfo,
      sensors,
    });
  }

  /** Write a sensor data record. */
  writeData(profile: string, deviceId: number, data: Record<string, unknown>): void {
    const now = Date.now();
    this.writeLine({
      type: 'data',
      ts: new Date(now).toISOString(),
      tsEpoch: now,
      elapsed: now - this.sessionStartTime,
      profile,
      deviceId,
      data,
    });
    this.recordCount++;
  }

  /** Write session_end record, flush, and close the file. */
  async close(): Promise<void> {
    if (!this.stream) return;

    const now = Date.now();
    this.writeLine({
      type: 'session_end',
      ts: new Date(now).toISOString(),
      tsEpoch: now,
      elapsed: now - this.sessionStartTime,
      totalRecords: this.recordCount,
    });

    return new Promise<void>((resolve, reject) => {
      this.stream!.end(() => {
        this.stream = null;
        resolve();
      });
      this.stream!.on('error', reject);
    });
  }

  private writeLine(record: RecordLine): void {
    if (!this.stream) {
      throw new Error('DataWriter not opened. Call open() first.');
    }
    this.stream.write(JSON.stringify(record) + '\n');
  }
}
