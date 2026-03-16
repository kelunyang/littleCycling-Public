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

const MVT_ZOOM = 14;
const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';

/** Layers we care about from the OpenMapTiles schema. */
const WANTED_LAYERS = ['transportation', 'building', 'water', 'landcover', 'landuse', 'park'] as const;
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

export class MVTFetcher {
  private cache = new Map<string, MVTFeature[]>();
  private inflight = new Map<string, Promise<MVTFeature[]>>();
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

    try {
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`[MVT] Failed to fetch tile ${key}: ${response.status}`);
        return [];
      }

      const buffer = await response.arrayBuffer();
      const tile = new VectorTile(new Pbf(buffer));
      const features = this.extractFeatures(tile, x, y);

      this.cache.set(key, features);
      return features;
    } catch (err) {
      console.warn(`[MVT] Error fetching/decoding tile ${key}:`, err);
      return [];
    }
  }

  /** Extract wanted layer features from a decoded VectorTile. */
  private extractFeatures(tile: VectorTile, x: number, y: number): MVTFeature[] {
    const features: MVTFeature[] = [];

    for (const layerName of WANTED_LAYERS) {
      const layer = tile.layers[layerName];
      if (!layer) continue;

      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        try {
          const geojson = feature.toGeoJSON(x, y, this.zoom);
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

  /** Clear all cached tiles. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Remove cache entries for tiles not covering the given bounds. */
  evictOutside(bounds: {
    south: number;
    north: number;
    west: number;
    east: number;
  }): void {
    const nw = latLonToTile(bounds.north, bounds.west, this.zoom);
    const se = latLonToTile(bounds.south, bounds.east, this.zoom);
    const minTX = Math.min(nw.x, se.x) - 1;
    const maxTX = Math.max(nw.x, se.x) + 1;
    const minTY = Math.min(nw.y, se.y) - 1;
    const maxTY = Math.max(nw.y, se.y) + 1;

    for (const key of this.cache.keys()) {
      const parts = key.split('/').map(Number);
      const [, tx, ty] = parts;
      if (tx < minTX || tx > maxTX || ty < minTY || ty > maxTY) {
        this.cache.delete(key);
      }
    }
  }
}
