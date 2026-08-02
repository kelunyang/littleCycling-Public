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

/** Consecutive failures before a DEM tile is treated as a permanent hole and no
 *  longer retried this session (count-based — no Date.now, per project rules). */
const FAIL_PERMANENT = 3;

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
  /** Tiles whose fetch/decode failed → consecutive-failure count. A tile is only
   *  treated as a permanent hole (and stops being retried this session) once it
   *  has failed FAIL_PERMANENT times in a row; below that a later request
   *  re-attempts it, so a transient network blip self-heals. Reset on success.
   *  Sync sampling of a missing tile falls back to GPX, as before. */
  private readonly failed = new Map<string, number>();

  constructor(options?: ElevationSamplerOptions) {
    this.encoding = options?.encoding ?? 'terrarium';
    this.zoom = options?.zoom ?? 14;
    this.tileUrl = options?.tileUrl ?? DEFAULT_TERRARIUM_URL;
  }

  /**
   * Optional bare-earth correction applied to every sample. Terrarium DEM is a
   * SURFACE model in dense cities — it bakes building heights into the ground
   * (30-50m phantom towers in Taipei). The chunk manager installs a hook that
   * clamps samples inside known building footprints down to street level.
   */
  correction: ((lat: number, lon: number, ele: number) => number) | null = null;

  /** Get elevation at a single lat/lon point. */
  async getElevation(lat: number, lon: number): Promise<number> {
    const { tileX, tileY, pixelX, pixelY } = this.latLonToTilePixel(lat, lon);
    const tile = await this.getTile(tileX, tileY);
    const ele = this.sampleTile(tile, pixelX, pixelY);
    return this.correction ? this.correction(lat, lon, ele) : ele;
  }

  /**
   * Synchronous elevation lookup — returns the value if the covering tile is
   * already cached, else null (no fetch triggered). Lets a hot loop sample
   * thousands of points without awaiting a microtask per point: prefetch the
   * region once with prefetchBounds(), then sample synchronously.
   */
  getElevationSync(lat: number, lon: number): number | null {
    const { tileX, tileY, pixelX, pixelY } = this.latLonToTilePixel(lat, lon);
    const tile = this.cache.get(tileKey(this.zoom, tileX, tileY));
    if (!tile) return null;
    const ele = this.sampleTile(tile, pixelX, pixelY);
    return this.correction ? this.correction(lat, lon, ele) : ele;
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

    // Per-tile fault tolerant: one failed/absent tile must not reject the whole
    // prefetch (it would abort a chunk build over a single DEM hole). The build
    // proceeds with whatever tiles resolved; the hole is covered by
    // getElevationSync's null → GPX fallback.
    const fetches: Promise<DecodedTile | null>[] = [];
    for (let tx = minTX; tx <= maxTX; tx++) {
      for (let ty = minTY; ty <= maxTY; ty++) {
        fetches.push(this.getTile(tx, ty).catch(() => null));
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
    this.failed.clear();
  }

  /**
   * Bound the tile cache to a live window: drop decoded tiles outside `bounds`
   * (padded by `marginTiles`), so a long ride doesn't retain every DEM tile it
   * ever sampled. Heights are already baked into each chunk's height grid at
   * build time, so evicting the source tile afterwards is safe. The negative
   * cache (`failed`) is session-wide and NOT evicted here.
   */
  evictOutside(
    bounds: { south: number; north: number; west: number; east: number },
    marginTiles = 1,
  ): void {
    const nw = this.latLonToTilePixel(bounds.north, bounds.west);
    const se = this.latLonToTilePixel(bounds.south, bounds.east);
    const minTX = Math.min(nw.tileX, se.tileX) - marginTiles;
    const maxTX = Math.max(nw.tileX, se.tileX) + marginTiles;
    const minTY = Math.min(nw.tileY, se.tileY) - marginTiles;
    const maxTY = Math.max(nw.tileY, se.tileY) + marginTiles;

    for (const key of this.cache.keys()) {
      const parts = key.split('/').map(Number);
      const tx = parts[1], ty = parts[2];
      if (tx < minTX || tx > maxTX || ty < minTY || ty > maxTY) {
        this.cache.delete(key);
      }
    }
  }

  // ── Internal ──

  private async getTile(tileX: number, tileY: number): Promise<DecodedTile> {
    const key = tileKey(this.zoom, tileX, tileY);

    const cached = this.cache.get(key);
    if (cached) return cached;

    // Permanent hole: only stop refetching once it has failed FAIL_PERMANENT times
    // in a row (below that a re-attempt is allowed, so a transient blip heals).
    // Throwing keeps the same contract a live fetch failure had — callers catch it.
    if ((this.failed.get(key) ?? 0) >= FAIL_PERMANENT) {
      throw new Error(`DEM tile ${key} failed ${FAIL_PERMANENT}× — treated as a permanent hole`);
    }

    const inflight = this.pending.get(key);
    if (inflight) return inflight;

    const promise = this.fetchAndDecode(tileX, tileY);
    this.pending.set(key, promise);

    try {
      const tile = await promise;
      this.cache.set(key, tile);
      this.failed.delete(key); // recovered — clear the consecutive-failure count
      return tile;
    } catch (err) {
      // Bump the consecutive-failure count; at FAIL_PERMANENT it becomes a hole.
      this.failed.set(key, (this.failed.get(key) ?? 0) + 1);
      throw err;
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

    // Decode, then REPAIR — the source data has bad pixels and this used to have
    // no guard at all, so they went straight into the height grid.
    //
    // Measured: terrarium `14/8427/5337` (east end of the Afsluitdijk) has 119
    // of its 65536 pixels decoding to **−16964 m**, scattered across a few scan
    // lines in 48 distinct RGB triples, while the other 65417 sit in −2…3 m.
    // That is noise in the SOURCE, not a decode error — the formula above is
    // byte-for-byte the demos'.
    //
    // The repair is the demos' (`GEO_ELE_MIN/MAX` + `geoFetchDem`, SKY/GEO block,
    // byte-identical in all three): out of band → hole; fill from the previous
    // good value ON THE SAME ROW; a row that starts bad takes the whole tile's
    // median. Row-wise and not bilinear because a dropout is a scan-line
    // artefact — repairing along the scan line puts the patch where the damage is.
    const good: number[] = [];
    let bad = 0;
    for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
      const r = pixels[i * 4];
      const g = pixels[i * 4 + 1];
      const b = pixels[i * 4 + 2];
      const e = decode(r, g, b);
      elevations[i] = e;
      if (e >= ELE_SANE_MIN && e <= ELE_SANE_MAX) good.push(e);
      else bad++;
    }
    if (bad > 0) {
      good.sort((p, q) => p - q);
      const median = good.length ? good[good.length >> 1] : 0;
      for (let row = 0; row < TILE_SIZE; row++) {
        let last = median;
        for (let col = 0; col < TILE_SIZE; col++) {
          const k = row * TILE_SIZE + col;
          if (elevations[k] >= ELE_SANE_MIN && elevations[k] <= ELE_SANE_MAX) last = elevations[k];
          else elevations[k] = last;
        }
      }
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

/**
 * The band a real land-surface sample can fall in, metres — the demos'
 * `GEO_ELE_MIN` / `GEO_ELE_MAX`, transplanted.
 *
 * −500 clears the Dead Sea shore (−430) with room to spare; 9000 clears Everest
 * (8849). Anything outside is a dropout in the source tile, not terrain.
 */
export const ELE_SANE_MIN = -500;
export const ELE_SANE_MAX = 9000;

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
