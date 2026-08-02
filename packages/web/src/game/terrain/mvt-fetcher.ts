/**
 * Fetch and decode OpenFreeMap MVT (Mapbox Vector Tiles).
 *
 * Uses @mapbox/vector-tile + pbf to decode protobuf tiles,
 * then extracts features as GeoJSON for rendering.
 *
 * Tile URL is resolved dynamically from the TileJSON endpoint
 * because OpenFreeMap rotates versioned paths on each planet data update.
 *
 * Schema: OpenMapTiles (transportation, building, water, landcover, park, etc.)
 */

import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { decodeTileInWorker } from './mvt-worker-client';

const MVT_ZOOM = 14;
const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';

/** Layers we care about from the OpenMapTiles schema. */
/**
 * Layers we decode. Kept tight on purpose: a tile also carries `housenumber`,
 * `poi`, `boundary`, `transportation_name`… which are label data with nothing to
 * draw in a 3D toy world (a survey of three routes put them at ~2/3 of all
 * features). `waterway` and `aeroway` earn their place — see
 * plan/map-elements-expansion.md.
 */
const WANTED_LAYERS = [
  'transportation', 'building', 'water', 'waterway', 'landcover', 'landuse', 'park', 'aeroway',
] as const;
export type MVTLayerName = (typeof WANTED_LAYERS)[number];

export interface MVTFeature {
  layer: MVTLayerName;
  geometry: GeoJSON.Geometry;
  properties: Record<string, any>;
}

/** Tile coordinate key for caching. */
function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/** Convert lat/lon to tile XY at a given zoom. */
function latLonToTile(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return {
    x: Math.max(0, Math.min(x, n - 1)),
    y: Math.max(0, Math.min(y, n - 1)),
  };
}

/**
 * Decode a raw MVT tile ArrayBuffer into wanted-layer GeoJSON features.
 *
 * Pure CPU work (protobuf parse + per-feature toGeoJSON) with no `this`/fetch
 * dependency, so it runs identically on the main thread (fallback) or inside the
 * decode worker (see mvt-worker.ts).
 */
export function decodeMVTTile(
  buffer: ArrayBuffer,
  x: number,
  y: number,
  zoom: number,
): MVTFeature[] {
  const tile = new VectorTile(new Pbf(buffer));
  const features: MVTFeature[] = [];

  for (const layerName of WANTED_LAYERS) {
    const layer = tile.layers[layerName];
    if (!layer) continue;

    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      try {
        const geojson = feature.toGeoJSON(x, y, zoom);
        features.push({
          layer: layerName,
          geometry: geojson.geometry,
          properties: geojson.properties || {},
        });
      } catch {
        // Skip malformed features
      }
    }
  }

  return features;
}

export class MVTFetcher {
  private cache = new Map<string, MVTFeature[]>();
  private inflight = new Map<string, Promise<MVTFeature[]>>();
  /** Tiles that returned non-OK / errored — negatively cached for the session so
   *  a chunk reload never re-hammers a 404 or an offline endpoint. */
  private failed = new Set<string>();
  /** In-flight AbortControllers per tile key, so evicting a chunk can cancel a
   *  fetch whose tile has already streamed off the far edge of the live window. */
  private controllers = new Map<string, AbortController>();
  private zoom: number;
  private tileUrlTemplate: string | null = null;

  constructor(zoom = MVT_ZOOM) {
    this.zoom = zoom;
  }

  /**
   * Fetch the TileJSON to resolve the current tile URL template.
   * Must be called once before any tile fetches.
   * OpenFreeMap rotates versioned paths (e.g. /planet/20260304_001001_pt/),
   * so we cannot hardcode the tile URL.
   */
  async initialize(): Promise<void> {
    try {
      const resp = await fetch(TILEJSON_URL);
      if (!resp.ok) {
        throw new Error(`TileJSON fetch failed: ${resp.status}`);
      }
      const tileJson = await resp.json();
      if (tileJson.tiles && tileJson.tiles.length > 0) {
        this.tileUrlTemplate = tileJson.tiles[0];
        console.log(`[MVT] Resolved tile URL: ${this.tileUrlTemplate}`);
      } else {
        throw new Error('TileJSON has no tiles array');
      }
    } catch (err) {
      console.error('[MVT] Failed to resolve tile URL from TileJSON, MVT overlays will be unavailable:', err);
    }
  }

  /** Whether tile URL was successfully resolved. */
  isAvailable(): boolean {
    return this.tileUrlTemplate !== null;
  }

  /**
   * Get all MVT features covering the given geographic bounds.
   * Returns cached results if available.
   */
  async getFeaturesForBounds(bounds: {
    south: number;
    north: number;
    west: number;
    east: number;
  }): Promise<MVTFeature[]> {
    if (!this.tileUrlTemplate) return [];

    const nw = latLonToTile(bounds.north, bounds.west, this.zoom);
    const se = latLonToTile(bounds.south, bounds.east, this.zoom);

    const minTX = Math.min(nw.x, se.x);
    const maxTX = Math.max(nw.x, se.x);
    const minTY = Math.min(nw.y, se.y);
    const maxTY = Math.max(nw.y, se.y);

    const promises: Promise<MVTFeature[]>[] = [];

    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        promises.push(this.fetchTile(tx, ty));
      }
    }

    const results = await Promise.all(promises);
    return results.flat();
  }

  /**
   * Get features of a specific layer for the given bounds.
   */
  async getLayerFeatures(
    layer: MVTLayerName,
    bounds: { south: number; north: number; west: number; east: number },
  ): Promise<MVTFeature[]> {
    const all = await this.getFeaturesForBounds(bounds);
    return all.filter((f) => f.layer === layer);
  }

  /** Fetch and decode a single MVT tile. */
  private async fetchTile(x: number, y: number): Promise<MVTFeature[]> {
    const key = tileKey(this.zoom, x, y);

    // Return from cache
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Known-bad tile: don't re-fetch this session (see `failed`).
    if (this.failed.has(key)) return [];

    // Deduplicate in-flight requests
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = this.doFetch(x, y, key);
    this.inflight.set(key, promise);

    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async doFetch(x: number, y: number, key: string): Promise<MVTFeature[]> {
    const url = this.tileUrlTemplate!
      .replace('{z}', String(this.zoom))
      .replace('{x}', String(x))
      .replace('{y}', String(y));

    const controller = new AbortController();
    this.controllers.set(key, controller);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        console.warn(`[MVT] Failed to fetch tile ${key}: ${response.status}`);
        this.failed.add(key); // negative-cache: a 404/5xx won't refetch this session
        return [];
      }

      const buffer = await response.arrayBuffer();
      // Decode off the main thread when a worker is available (the 3D terrain
      // path); fall back to a synchronous decode on worker-construction failure,
      // SSR/tests, or when already running inside a worker. NOTE: the worker path
      // TRANSFERS `buffer` (zero-copy), so it must not be touched afterwards.
      const workerDecode = decodeTileInWorker(buffer, x, y, this.zoom);
      const features = workerDecode
        ? await workerDecode
        : decodeMVTTile(buffer, x, y, this.zoom);

      this.cache.set(key, features);
      return features;
    } catch (err) {
      // An abort (chunk evicted mid-flight) is not a real failure — leave it out
      // of the negative cache so the tile can load again if it comes back in view.
      if ((err as { name?: string })?.name === 'AbortError') return [];
      console.warn(`[MVT] Error fetching/decoding tile ${key}:`, err);
      this.failed.add(key);
      return [];
    } finally {
      this.controllers.delete(key);
    }
  }

  /** Clear all cached tiles. */
  clearCache(): void {
    this.cache.clear();
    this.failed.clear();
    for (const c of this.controllers.values()) c.abort();
    this.controllers.clear();
  }

  /**
   * Bound the tile cache to a live window: drop cached tiles outside `bounds`
   * (padded by `marginTiles`) and abort any in-flight fetch that has streamed off
   * the far edge, so a long point-to-point ride doesn't hold every tile it ever
   * decoded. Called by the chunk manager as chunks unload. The negative-cache
   * (`failed`) is deliberately session-wide and NOT evicted here.
   */
  evictOutside(
    bounds: { south: number; north: number; west: number; east: number },
    marginTiles = 1,
  ): void {
    const nw = latLonToTile(bounds.north, bounds.west, this.zoom);
    const se = latLonToTile(bounds.south, bounds.east, this.zoom);
    const minTX = Math.min(nw.x, se.x) - marginTiles;
    const maxTX = Math.max(nw.x, se.x) + marginTiles;
    const minTY = Math.min(nw.y, se.y) - marginTiles;
    const maxTY = Math.max(nw.y, se.y) + marginTiles;

    const outside = (key: string): boolean => {
      const parts = key.split('/').map(Number);
      const tx = parts[1], ty = parts[2];
      return tx < minTX || tx > maxTX || ty < minTY || ty > maxTY;
    };

    for (const key of this.cache.keys()) {
      if (outside(key)) this.cache.delete(key);
    }
    // Cancel fetches whose tile is no longer anywhere near the rider.
    for (const [key, controller] of this.controllers) {
      if (outside(key)) controller.abort();
    }
  }
}
