/**
 * Debug JSONL writer — appends debug log entries from the web client
 * to a timestamped JSONL file in the data directory.
 *
 * One file per server session: data/debug-{ISO timestamp}.jsonl
 * Lazily created on first write (no file if debug is never used).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DebugLogEntry } from '@littlecycling/shared';

export class DebugWriter {
  private readonly dataDir: string;
  private stream: fs.WriteStream | null = null;
  private filePath: string | null = null;
  private entryCount = 0;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /** Append one or more debug entries. Creates the file lazily. */
  write(entries: DebugLogEntry[]): void {
    if (entries.length === 0) return;

    if (!this.stream) {
      this.open();
    }

    for (const entry of entries) {
      this.stream!.write(JSON.stringify(entry) + '\n');
      this.entryCount++;
    }
  }

  /** Get the current log file path (null if nothing written yet). */
  getFilePath(): string | null {
    return this.filePath;
  }

  /** Get total entries written. */
  getEntryCount(): number {
    return this.entryCount;
  }

  /** Close the file stream. */
  close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }

  private open(): void {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this.filePath = path.join(this.dataDir, `debug-${ts}.jsonl`);

    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    this.stream = fs.createWriteStream(this.filePath, {
      flags: 'a',
      encoding: 'utf8',
    });
  }
}
