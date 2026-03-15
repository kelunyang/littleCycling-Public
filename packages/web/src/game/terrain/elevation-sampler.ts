/**
 * Elevation data pipeline: fetch and decode AWS Terrarium / Mapbox DEM tiles.
 *
 * Tile encoding:
 * - Terrarium: elevation = R*256 + G + B/256 - 32768
 * - Mapbox:    elevation = (R*256*256 + G*256 + B) * 0.1 - 10000
 *
 * Provides point queries and grid extraction for terrain chunk building.
 */

import { debugLog, isDebugEnabled } from '@/game/debug-logger';

export type DemEncoding = 'terrarium' | 'mapbox';

const TILE_SIZE = 256;

/** Decoded elevation tile: 256×256 float array of elevation in meters. */
interface DecodedTile {
  z: number;
  x: number;
  y: number;
  elevations: Float32Array; // TILE_SIZE × TILE_SIZE
}

/** Options for the elevation sampler. */
export interface ElevationSamplerOptions {
  encoding?: DemEncoding;
  zoom?: number;
  /** Custom tile URL template. Must contain {z}, {x}, {y} placeholders. */
  tileUrl?: string;
}

const DEFAULT_TERRARIUM_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/**
 * Fetches, decodes, and caches DEM tiles.
 * All elevations are in meters above sea level.
 */
export class ElevationSampler {
  private readonly encoding: DemEncoding;
  private readonly zoom: number;
  private readonly tileUrl: string;
  private readonly cache = new Map<string, DecodedTile>();
  private readonly pending = new Map<string, Promise<DecodedTile>>();

  constructor(options?: ElevationSamplerOptions) {
    this.encoding = options?.encoding ?? 'terrarium';
    this.zoom = options?.zoom ?? 14;
    this.tileUrl = options?.tileUrl ?? DEFAULT_TERRARIUM_URL;
  }

  /** Get elevation at a single lat/lon point. */
  async getElevation(lat: number, lon: number): Promise<number> {
    const { tileX, tileY, pixelX, pixelY } = this.latLonToTilePixel(lat, lon);
    const tile = await this.getTile(tileX, tileY);
    return this.sampleTile(tile, pixelX, pixelY);
  }

  /**
   * Get a grid of elevations over a geographic bounding box.
   * Returns a row-major Float32Array of size rows × cols.
   */
  async getElevationGrid(
    bounds: { south: number; north: number; west: number; east: number },
    rows: number,
    cols: number,
  ): Promise<Float32Array> {
    const grid = new Float32Array(rows * cols);
    const latStep = (bounds.north - bounds.south) / (rows - 1);
    const lonStep = (bounds.east - bounds.west) / (cols - 1);

    // Collect unique tiles needed
    const tileRequests = new Map<string, { tileX: number; tileY: number }>();
    for (let r = 0; r < rows; r++) {
      const lat = bounds.north - r * latStep; // top to bottom
      for (let c = 0; c < cols; c++) {
        const lon = bounds.west + c * lonStep;
        const { tileX, tileY } = this.latLonToTilePixel(lat, lon);
        const key = tileKey(this.zoom, tileX, tileY);
        if (!tileRequests.has(key)) {
          tileRequests.set(key, { tileX, tileY });
        }
      }
    }

    // Fetch all needed tiles in parallel
    const tileEntries = [...tileRequests.entries()];
    await Promise.all(
      tileEntries.map(([, { tileX, tileY }]) => this.getTile(tileX, tileY)),
    );

    // Sample the grid
    for (let r = 0; r < rows; r++) {
      const lat = bounds.north - r * latStep;
      for (let c = 0; c < cols; c++) {
        const lon = bounds.west + c * lonStep;
        const { tileX, tileY, pixelX, pixelY } = this.latLonToTilePixel(lat, lon);
        const tile = this.cache.get(tileKey(this.zoom, tileX, tileY))!;
        grid[r * cols + c] = this.sampleTile(tile, pixelX, pixelY);
      }
    }

    return grid;
  }

  /** Prefetch tiles covering a geographic extent. */
  async prefetchBounds(bounds: {
    south: number;
    north: number;
    west: number;
    east: number;
  }): Promise<void> {
    const nw = this.latLonToTilePixel(bounds.north, bounds.west);
    const se = this.latLonToTilePixel(bounds.south, bounds.east);

    const minTX = Math.min(nw.tileX, se.tileX);
    const maxTX = Math.max(nw.tileX, se.tileX);
    const minTY = Math.min(nw.tileY, se.tileY);
    const maxTY = Math.max(nw.tileY, se.tileY);

    const fetches: Promise<DecodedTile>[] = [];
    for (let tx = minTX; tx <= maxTX; tx++) {
      for (let ty = minTY; ty <= maxTY; ty++) {
        fetches.push(this.getTile(tx, ty));
      }
    }
    await Promise.all(fetches);
  }

  /** Number of cached tiles. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** Clear tile cache. */
  clearCache(): void {
    this.cache.clear();
    this.pending.clear();
  }

  // ── Internal ──

  private async getTile(tileX: number, tileY: number): Promise<DecodedTile> {
    const key = tileKey(this.zoom, tileX, tileY);

    const cached = this.cache.get(key);
    if (cached) return cached;

    const inflight = this.pending.get(key);
    if (inflight) return inflight;

    const promise = this.fetchAndDecode(tileX, tileY);
    this.pending.set(key, promise);

    try {
      const tile = await promise;
      this.cache.set(key, tile);
      return tile;
    } finally {
      this.pending.delete(key);
    }
  }

  private async fetchAndDecode(tileX: number, tileY: number): Promise<DecodedTile> {
    const url = this.tileUrl
      .replace('{z}', String(this.zoom))
      .replace('{x}', String(tileX))
      .replace('{y}', String(tileY));

    const pixels = await fetchTilePixels(url);
    const elevations = new Float32Array(TILE_SIZE * TILE_SIZE);

    const decode =
      this.encoding === 'terrarium' ? decodeTerrarium : decodeMapbox;

    for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
      const r = pixels[i * 4];
      const g = pixels[i * 4 + 1];
      const b = pixels[i * 4 + 2];
      elevations[i] = decode(r, g, b);
    }

    if (isDebugEnabled()) {
      let minEle = Infinity, maxEle = -Infinity;
      for (let i = 0; i < elevations.length; i++) {
        if (elevations[i] < minEle) minEle = elevations[i];
        if (elevations[i] > maxEle) maxEle = elevations[i];
      }
      debugLog('elevation', `DEM tile ${this.zoom}/${tileX}/${tileY} decoded`, {
        encoding: this.encoding,
        minEle: Math.round(minEle),
        maxEle: Math.round(maxEle),
      });
    }

    return { z: this.zoom, x: tileX, y: tileY, elevations };
  }

  /** Convert lat/lon to tile coordinates + pixel position within tile. */
  private latLonToTilePixel(
    lat: number,
    lon: number,
  ): { tileX: number; tileY: number; pixelX: number; pixelY: number } {
    const n = 2 ** this.zoom;
    const xFloat = ((lon + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const yFloat = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;

    const tileX = Math.floor(xFloat);
    const tileY = Math.floor(yFloat);
    const pixelX = Math.floor((xFloat - tileX) * TILE_SIZE);
    const pixelY = Math.floor((yFloat - tileY) * TILE_SIZE);

    return {
      tileX: Math.max(0, Math.min(tileX, n - 1)),
      tileY: Math.max(0, Math.min(tileY, n - 1)),
      pixelX: Math.max(0, Math.min(pixelX, TILE_SIZE - 1)),
      pixelY: Math.max(0, Math.min(pixelY, TILE_SIZE - 1)),
    };
  }

  /** Bilinear sample from tile at fractional pixel coordinates. */
  private sampleTile(tile: DecodedTile, px: number, py: number): number {
    return tile.elevations[py * TILE_SIZE + px];
  }
}

// ── Tile decoding helpers ──

function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

function decodeMapbox(r: number, g: number, b: number): number {
  return (r * 256 * 256 + g * 256 + b) * 0.1 - 10000;
}

function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

/**
 * Fetch a PNG tile and return its RGBA pixel data.
 * Uses <img> + <canvas> to avoid CORS issues with direct fetch.
 */
function fetchTilePixels(url: string): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = TILE_SIZE;
      canvas.height = TILE_SIZE;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, TILE_SIZE, TILE_SIZE);
      const imageData = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
      resolve(imageData.data);
    };

    img.onerror = () => reject(new Error(`Failed to load DEM tile: ${url}`));
    img.src = url;
  });
}
