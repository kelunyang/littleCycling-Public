/**
 * Recording API — list available JSONL recording files.
 */

import type { FastifyInstance } from 'fastify';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export default async function recordingApi(fastify: FastifyInstance, opts: { dataDir: string }): Promise<void> {
  const { dataDir } = opts;

  /** List JSONL recordings sorted by modification time (newest first). */
  fastify.get('/api/recordings', async () => {
    let files: string[];
    try {
      files = readdirSync(dataDir).filter(f => f.endsWith('.jsonl'));
    } catch {
      files = [];
    }

    const recordings = files.map(name => {
      const fullPath = join(dataDir, name);
      const stat = statSync(fullPath);
      return {
        name,
        path: fullPath,
        sizeBytes: stat.size,
        modifiedAt: stat.mtimeMs,
      };
    }).sort((a, b) => b.modifiedAt - a.modifiedAt);

    return { recordings };
  });
}
