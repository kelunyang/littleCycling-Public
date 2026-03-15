/**
 * Debug API — receives debug log entries from the web client,
 * prints them to stdout (shown in dev-runner Ink UI),
 * and persists them to a JSONL file.
 */

import type { FastifyInstance } from 'fastify';
import type { DebugLogEntry } from '@littlecycling/shared';
import type { DebugWriter } from '../lib/debug-writer.js';

/** Category → color for console display. */
const CATEGORY_COLORS: Record<string, string> = {
  mvt: '\x1b[36m',       // cyan
  chunk: '\x1b[33m',     // yellow
  weather: '\x1b[32m',   // green
  elevation: '\x1b[35m', // magenta
  terrain: '\x1b[34m',   // blue
  general: '\x1b[37m',   // white
};
const RESET = '\x1b[0m';

function formatEntry(entry: DebugLogEntry): string {
  const color = CATEGORY_COLORS[entry.category] ?? CATEGORY_COLORS.general;
  const ts = new Date(entry.ts).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const dataStr = entry.data ? ' ' + JSON.stringify(entry.data) : '';
  return `${color}[debug:${entry.category}]${RESET} ${ts} ${entry.message}${dataStr}`;
}

export default async function debugApi(
  fastify: FastifyInstance,
  opts: { debugWriter: DebugWriter },
): Promise<void> {
  const { debugWriter } = opts;

  /** Receive debug log entries from the web client. */
  fastify.post<{ Body: { entries: DebugLogEntry[] } }>('/api/debug', async (req, reply) => {
    const { entries } = req.body ?? {};

    if (!Array.isArray(entries) || entries.length === 0) {
      return reply.status(400).send({ error: 'Missing entries array' });
    }

    // Print to stdout (dev-runner captures this and shows in Ink UI)
    for (const entry of entries) {
      console.log(formatEntry(entry));
    }

    // Persist to JSONL
    debugWriter.write(entries);

    return { ok: true, count: entries.length };
  });
}
