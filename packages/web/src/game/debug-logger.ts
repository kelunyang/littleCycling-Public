/**
 * Debug logger — sends structured debug entries to the server
 * for display in the Ink UI and persistence to JSONL.
 *
 * Usage:
 *   import { debugLog, setDebugEnabled } from '@/game/debug-logger';
 *   setDebugEnabled(true);
 *   debugLog('mvt', 'Tile 14/8529/5765 loaded', { features: 42, kb: 12.3 });
 *
 * Entries are batched and POSTed to /api/debug every 500ms to avoid flooding.
 */

import type { DebugCategory, DebugLogEntry } from '@littlecycling/shared';

let enabled = false;
let buffer: DebugLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const FLUSH_INTERVAL = 500; // ms

/** Enable or disable debug logging globally. */
export function setDebugEnabled(value: boolean): void {
  enabled = value;
  if (!value) {
    // Flush remaining entries and stop
    flush();
  }
}

/** Returns whether debug logging is currently enabled. */
export function isDebugEnabled(): boolean {
  return enabled;
}

/** Log a debug entry. No-op if debug is disabled. */
export function debugLog(
  category: DebugCategory,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!enabled) return;

  buffer.push({
    ts: Date.now(),
    category,
    message,
    data,
  });

  // Schedule flush if not already pending
  if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_INTERVAL);
  }
}

/** Send buffered entries to the server. */
function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  if (buffer.length === 0) return;

  const entries = buffer;
  buffer = [];

  // Fire-and-forget POST
  fetch('/api/debug', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
  }).catch(() => {
    // Silently drop on failure — debug logging should never break the game
  });
}
