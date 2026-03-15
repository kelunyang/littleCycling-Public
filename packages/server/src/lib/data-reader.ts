/**
 * JSONL async generator — reads recording files line by line.
 * Foundation for replay and recording analysis.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { RecordLine } from '@littlecycling/shared';

/**
 * Async generator that yields parsed RecordLine objects from a JSONL file.
 */
export async function* readJsonl(filePath: string): AsyncGenerator<RecordLine> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed) as RecordLine;
  }
}
