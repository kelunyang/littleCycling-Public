/**
 * Client wrapper for the MVT Web Worker.
 *
 * Shared by both Phaser 2D and Three.js renderers.
 * Spawns a one-shot worker, posts route data, and resolves
 * with the projected features when the worker responds.
 */

import type { RoutePoint } from '@littlecycling/shared';
import type { ProjectedFeature } from './mvt-projection';
import type { MVTFeature } from './mvt-fetcher';
import { computeRouteBounds } from './mvt-projection';

export function fetchFeaturesInWorker(
  points: RoutePoint[],
  cumulativeDists: number[],
): Promise<ProjectedFeature[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./mvt-worker.ts', import.meta.url),
      { type: 'module' },
    );
    const bounds = computeRouteBounds(points);
    // Strip Vue reactivity — Proxy objects are not structured-cloneable
    const plainPoints = points.map(p => ({ lat: p.lat, lon: p.lon, ele: p.ele }));
    worker.postMessage({ points: plainPoints, cumulativeDists: [...cumulativeDists], bounds });
    worker.onmessage = (e) => {
      if (e.data.ok) resolve(e.data.features);
      else reject(new Error(e.data.error));
      worker.terminate();
    };
    worker.onerror = (e) => {
      reject(e);
      worker.terminate();
    };
  });
}

// ── Persistent decode worker (3D terrain path) ──────────────────────────────
// Unlike the one-shot Phaser worker above, this is a single long-lived worker
// that decodes raw MVT tile buffers off the main thread and multiplexes many
// tiles by request id. MVTFetcher (packages/web/.../mvt-fetcher.ts) uses it for
// its 3D decode; it falls back to a synchronous main-thread decode when this
// returns null (no Worker support, SSR/tests, or already inside a worker).

interface DecodeResolvers {
  resolve: (features: MVTFeature[]) => void;
  reject: (err: Error) => void;
}

let decodeWorker: Worker | null = null;
/** Once true, stop trying to spawn the worker — construction failed or it died,
 *  so every future decode takes the synchronous fallback. */
let decodeWorkerBroken = false;
let decodeSeq = 0;
const decodePending = new Map<number, DecodeResolvers>();

/** Lazily construct (once) the shared decode worker, or return null if one can't
 *  exist here: no Worker constructor (SSR/tests), or no `document` — which also
 *  means we're already inside a worker, so we must NOT nest another one. */
function ensureDecodeWorker(): Worker | null {
  if (decodeWorker) return decodeWorker;
  if (decodeWorkerBroken) return null;
  if (typeof Worker === 'undefined' || typeof document === 'undefined') {
    decodeWorkerBroken = true;
    return null;
  }
  try {
    const w = new Worker(
      new URL('./mvt-worker.ts', import.meta.url),
      { type: 'module' },
    );
    w.onmessage = (e) => {
      const d = e.data;
      if (!d || d.type !== 'decode') return; // ignore any non-decode reply
      const pending = decodePending.get(d.id);
      if (!pending) return;
      decodePending.delete(d.id);
      if (d.ok) pending.resolve(d.features as MVTFeature[]);
      else pending.reject(new Error(d.error || 'MVT decode failed'));
    };
    w.onerror = () => {
      // Fatal worker error: fail everything in flight and disable the worker so
      // subsequent decodes take the synchronous fallback.
      decodeWorkerBroken = true;
      decodeWorker = null;
      for (const p of decodePending.values()) p.reject(new Error('MVT decode worker error'));
      decodePending.clear();
    };
    decodeWorker = w;
    return w;
  } catch {
    decodeWorkerBroken = true;
    return null;
  }
}

/**
 * Decode a raw MVT tile buffer in the shared worker, resolving with the decoded
 * GeoJSON features. Returns null when no worker is available, signalling the
 * caller to decode synchronously on the main thread.
 *
 * `buffer` is TRANSFERRED (zero-copy) to the worker, so the caller must not use
 * it after this call.
 */
export function decodeTileInWorker(
  buffer: ArrayBuffer,
  x: number,
  y: number,
  zoom: number,
): Promise<MVTFeature[]> | null {
  const w = ensureDecodeWorker();
  if (!w) return null;
  const id = ++decodeSeq;
  return new Promise<MVTFeature[]>((resolve, reject) => {
    decodePending.set(id, { resolve, reject });
    w.postMessage({ type: 'decode', id, buffer, x, y, zoom }, [buffer]);
  });
}
